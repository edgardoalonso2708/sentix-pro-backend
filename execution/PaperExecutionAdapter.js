// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — Paper Execution Adapter
// Simulated execution engine that wraps the existing paperTrading.js module.
// MARKET orders fill immediately with slippage simulation.
// LIMIT/STOP_LIMIT orders check price conditions before filling.
// ═══════════════════════════════════════════════════════════════════════════════

const { ExecutionAdapter } = require('./ExecutionAdapter');
const {
  openTrade,
  applySlippage,
  resolveCurrentPrice,
  getOrCreateConfig,
  getOpenPositions
} = require('../paperTrading');
const { logger } = require('../logger');

class PaperExecutionAdapter extends ExecutionAdapter {
  /**
   * @param {object} supabase - Supabase client instance
   */
  constructor(supabase) {
    super('paper');
    this.supabase = supabase;
  }

  /**
   * Place an order in the paper trading system.
   * Converts the order into a paper trade via openTrade().
   */
  async placeOrder(order, marketData = null) {
    try {
      // Resolve current price for the asset
      const currentPrice = resolveCurrentPrice(order.asset, marketData);

      if (!currentPrice || currentPrice <= 0) {
        return {
          filled: false,
          reason: `Cannot resolve current price for ${order.asset}`
        };
      }

      // ── MARKET ORDER: fill immediately ──
      if (order.order_type === 'MARKET') {
        return await this._fillOrder(order, currentPrice, marketData);
      }

      // ── LIMIT ORDER: check if price satisfies limit ──
      if (order.order_type === 'LIMIT') {
        const limitPrice = parseFloat(order.price);

        if (order.side === 'BUY' && currentPrice <= limitPrice) {
          // Buy at or below limit → fill
          return await this._fillOrder(order, currentPrice, marketData);
        }
        if (order.side === 'SELL' && currentPrice >= limitPrice) {
          // Sell at or above limit → fill
          return await this._fillOrder(order, currentPrice, marketData);
        }

        return {
          filled: false,
          reason: `LIMIT not reached: current ${currentPrice} vs limit ${limitPrice} (${order.side})`
        };
      }

      // ── STOP_LIMIT ORDER: check trigger, then limit ──
      if (order.order_type === 'STOP_LIMIT') {
        const stopPrice = parseFloat(order.stop_price);
        const limitPrice = parseFloat(order.price);

        // Check if stop triggered
        const stopTriggered =
          (order.side === 'BUY' && currentPrice >= stopPrice) ||
          (order.side === 'SELL' && currentPrice <= stopPrice);

        if (!stopTriggered) {
          return {
            filled: false,
            reason: `STOP not triggered: current ${currentPrice} vs stop ${stopPrice} (${order.side})`
          };
        }

        // Stop triggered — now check limit
        const limitSatisfied =
          (order.side === 'BUY' && currentPrice <= limitPrice) ||
          (order.side === 'SELL' && currentPrice >= limitPrice);

        if (!limitSatisfied) {
          return {
            filled: false,
            reason: `STOP triggered but LIMIT not met: current ${currentPrice} vs limit ${limitPrice}`
          };
        }

        return await this._fillOrder(order, currentPrice, marketData);
      }

      return { filled: false, reason: `Unknown order type: ${order.order_type}` };
    } catch (err) {
      logger.error('PaperExecutionAdapter.placeOrder error', { error: err.message, orderId: order.id });
      return { filled: false, reason: `Execution error: ${err.message}` };
    }
  }

  /**
   * Fill an order: apply slippage, create trade via openTrade().
   * @private
   */
  async _fillOrder(order, currentPrice, marketData) {
    const isBuy = order.side === 'BUY';
    const fillPrice = applySlippage(currentPrice, isBuy, order.asset);
    const slippage = Math.abs(fillPrice - currentPrice) / currentPrice;

    // Build a signal-like object for openTrade (compatibility layer)
    const signalCompat = {
      asset: order.asset,
      assetClass: order.asset_class || 'crypto',
      action: order.side === 'BUY' ? 'BUY' : 'SELL',
      strengthLabel: order.signal_snapshot?.strengthLabel || (order.side === 'BUY' ? 'STRONG BUY' : 'STRONG SELL'),
      confidence: order.signal_snapshot?.confidence || 50,
      rawScore: order.signal_snapshot?.rawScore || 0,
      score: order.signal_snapshot?.score || 0,
      reasons: order.signal_snapshot?.reasons || 'Order execution',
      tradeLevels: {
        entry: currentPrice, // Will be slipped inside openTrade
        stopLoss: order.stop_loss ? parseFloat(order.stop_loss) : null,
        takeProfit1: order.take_profit_1 ? parseFloat(order.take_profit_1) : null,
        takeProfit2: order.take_profit_2 ? parseFloat(order.take_profit_2) : null,
        trailingStop: null,
        trailingActivation: order.trailing_activation ? parseFloat(order.trailing_activation) : null
      },
      timeframes: order.signal_snapshot?.timeframes || {},
      indicators: order.signal_snapshot?.indicators || {},
      macroContext: order.signal_snapshot?.macroContext || null,
      derivatives: order.signal_snapshot?.derivatives || null
    };

    const positionSize = {
      positionSizeUsd: parseFloat(order.position_size_usd) || 0,
      quantity: parseFloat(order.quantity),
      riskAmount: parseFloat(order.risk_amount) || 0
    };

    const { trade, error } = await openTrade(
      this.supabase,
      order.user_id,
      signalCompat,
      positionSize,
      marketData,
      order.id // Pass order_id to link trade → order
    );

    if (error) {
      return {
        filled: false,
        reason: `openTrade failed: ${error.message || JSON.stringify(error)}`
      };
    }

    return {
      filled: true,
      fillPrice: trade.entry_price || fillPrice,
      fillQuantity: parseFloat(order.quantity),
      slippage,
      trade
    };
  }

  /**
   * Cancel order — no-op in paper trading (orders aren't on an exchange).
   */
  async cancelOrder(exchangeOrderId) {
    return { cancelled: true };
  }

  /**
   * Get open position for an asset.
   */
  async getPosition(userId, asset) {
    try {
      const { data } = await this.supabase.from('paper_trades')
        .select('*')
        .eq('user_id', userId)
        .eq('asset', asset)
        .in('status', ['open', 'partial'])
        .single();

      return { position: data || null };
    } catch (err) {
      return { position: null };
    }
  }

  /**
   * Get account balance from paper_config.
   */
  async getBalance(userId) {
    try {
      const { config } = await getOrCreateConfig(this.supabase, userId);
      if (!config) return { available: 0, total: 0 };

      return {
        available: config.current_capital,
        total: config.initial_capital
      };
    } catch (err) {
      return { available: 0, total: 0 };
    }
  }

  /**
   * Health check — paper adapter is always healthy.
   */
  async healthCheck() {
    return {
      healthy: true,
      adapter: 'paper',
      details: { mode: 'simulated' }
    };
  }
}

module.exports = { PaperExecutionAdapter };
