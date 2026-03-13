// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — Risk Engine
// Consolidated pre-trade validation, drawdown circuit breaker, kill switch,
// and risk dashboard. Sits between orderManager and execution adapter.
// ═══════════════════════════════════════════════════════════════════════════════

const { logger } = require('./logger');
const {
  checkSafetyLimits,
  checkDuplicateTrade,
  checkPortfolioLimits,
  getOrCreateConfig,
  getPositionHeatMap,
  getOpenPositions,
  DEFAULT_CONFIG
} = require('./paperTrading');
const { cancelOrder, getOrders, logExecution, EVENT_TYPE, ORDER_STATUS } = require('./orderManager');

// ═══════════════════════════════════════════════════════════════════════════════
// PRE-TRADE VALIDATION (consolidated risk checks)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run all pre-trade risk checks on an order.
 * Called by orderManager.validateOrder() instead of individual checks.
 *
 * @param {object} supabase
 * @param {string} userId
 * @param {object} order - Order record
 * @param {object} config - Paper trading config
 * @param {object} [marketData] - Current market data (for drawdown check)
 * @returns {Promise<{approved: boolean, checks: Array<{name: string, passed: boolean, detail: string}>}>}
 */
async function validatePreTrade(supabase, userId, order, config, marketData = null) {
  const checks = [];

  try {
    // ── CHECK 1: Trading enabled ──
    if (!config.is_enabled) {
      checks.push({ name: 'trading_enabled', passed: false, detail: 'Trading is disabled' });
      return { approved: false, checks };
    }
    checks.push({ name: 'trading_enabled', passed: true, detail: 'Trading enabled' });

    // ── CHECK 2: Safety limits (daily loss, position count, cooldown) ──
    const { safe, reason: safetyReason } = await checkSafetyLimits(supabase, userId, config);
    checks.push({ name: 'safety_limits', passed: safe, detail: safetyReason });
    if (!safe) return { approved: false, checks };

    // ── CHECK 3: Duplicate trade ──
    const isDuplicate = await checkDuplicateTrade(supabase, userId, order.asset);
    checks.push({
      name: 'duplicate_trade',
      passed: !isDuplicate,
      detail: isDuplicate ? `Already has open trade on ${order.asset}` : 'No duplicate'
    });
    if (isDuplicate) return { approved: false, checks };

    // ── CHECK 4: Portfolio limits (correlation, sector, same-direction) ──
    const portfolioCheck = await checkPortfolioLimits(supabase, userId, {
      asset: order.asset,
      action: order.side,
      assetClass: order.asset_class
    }, config);
    checks.push({
      name: 'portfolio_limits',
      passed: portfolioCheck.allowed,
      detail: portfolioCheck.reason
    });
    if (!portfolioCheck.allowed) return { approved: false, checks };

    // ── CHECK 5: Position size limit ──
    if (order.position_size_usd) {
      const maxPct = config.max_position_percent || DEFAULT_CONFIG.max_position_percent;
      const maxPosition = config.current_capital * maxPct;
      const sizeOk = parseFloat(order.position_size_usd) <= maxPosition;
      checks.push({
        name: 'position_size',
        passed: sizeOk,
        detail: sizeOk
          ? `$${order.position_size_usd} within limit $${maxPosition.toFixed(2)}`
          : `$${order.position_size_usd} exceeds max $${maxPosition.toFixed(2)}`
      });
      if (!sizeOk) return { approved: false, checks };
    } else {
      checks.push({ name: 'position_size', passed: true, detail: 'No size to check' });
    }

    // ── CHECK 6: Drawdown circuit breaker ──
    const drawdownCheck = await checkDrawdownCircuitBreaker(supabase, userId, config);
    checks.push({
      name: 'drawdown_breaker',
      passed: !drawdownCheck.triggered,
      detail: drawdownCheck.triggered
        ? `Drawdown ${(drawdownCheck.currentDrawdown * 100).toFixed(1)}% exceeds limit ${(drawdownCheck.threshold * 100).toFixed(1)}%`
        : `Drawdown ${(drawdownCheck.currentDrawdown * 100).toFixed(1)}% within limit ${(drawdownCheck.threshold * 100).toFixed(1)}%`
    });
    if (drawdownCheck.triggered) return { approved: false, checks };

    return { approved: true, checks };
  } catch (err) {
    logger.error('validatePreTrade exception', { error: err.message });
    checks.push({ name: 'error', passed: false, detail: `Validation error: ${err.message}` });
    return { approved: false, checks };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DRAWDOWN CIRCUIT BREAKER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if portfolio drawdown from equity peak exceeds max_drawdown_pct.
 * Uses paper_equity_snapshots to find peak equity.
 *
 * @param {object} supabase
 * @param {string} userId
 * @param {object} config - Must have max_drawdown_pct
 * @returns {Promise<{triggered: boolean, currentDrawdown: number, threshold: number, peakEquity: number, currentEquity: number}>}
 */
async function checkDrawdownCircuitBreaker(supabase, userId, config) {
  const threshold = config.max_drawdown_pct || 0.15; // Default 15%

  try {
    // Find peak equity from snapshots
    const { data: peakRow } = await supabase.from('paper_equity_snapshots')
      .select('equity')
      .eq('user_id', userId)
      .order('equity', { ascending: false })
      .limit(1)
      .single();

    if (!peakRow) {
      // No equity history → use initial capital as peak
      return {
        triggered: false,
        currentDrawdown: 0,
        threshold,
        peakEquity: config.initial_capital || config.current_capital,
        currentEquity: config.current_capital
      };
    }

    const peakEquity = Math.max(
      parseFloat(peakRow.equity),
      config.initial_capital || 0
    );
    const currentEquity = config.current_capital;
    const currentDrawdown = peakEquity > 0
      ? (peakEquity - currentEquity) / peakEquity
      : 0;

    return {
      triggered: currentDrawdown > threshold,
      currentDrawdown: Math.max(0, currentDrawdown),
      threshold,
      peakEquity,
      currentEquity
    };
  } catch (err) {
    logger.debug('Drawdown check failed, not triggering', { error: err.message });
    return {
      triggered: false,
      currentDrawdown: 0,
      threshold,
      peakEquity: config.current_capital,
      currentEquity: config.current_capital
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// KILL SWITCH
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Activate emergency kill switch:
 * 1. Disable trading (is_enabled = false)
 * 2. Cancel all pending/validated orders
 * 3. Optionally close all open positions
 * 4. Log to execution_log
 *
 * @param {object} supabase
 * @param {string} userId
 * @param {string} reason - Why the kill switch was activated
 * @param {object} [options]
 * @param {Function} [options.notifyFn] - Notification callback (Telegram, email)
 * @returns {Promise<{success: boolean, cancelledOrders: number, closedPositions: number}>}
 */
async function activateKillSwitch(supabase, userId, reason, options = {}) {
  try {
    // 1. Disable trading for ALL users (global kill switch)
    const { error: configError } = await supabase.from('paper_config')
      .update({ is_enabled: false })
      .neq('is_enabled', false); // Only update those that are currently enabled

    if (configError) {
      logger.error('Kill switch: failed to disable trading', { error: configError.message });
      return { success: false, cancelledOrders: 0, closedPositions: 0 };
    }

    // 2. Cancel all pending/validated orders for ALL users
    let cancelledOrders = 0;
    const { data: allCancellable } = await supabase.from('orders')
      .select('id, user_id')
      .in('status', [ORDER_STATUS.PENDING, ORDER_STATUS.VALIDATED, ORDER_STATUS.SUBMITTED])
      .limit(500);

    for (const order of (allCancellable || [])) {
      const { error } = await cancelOrder(supabase, order.user_id, order.id);
      if (!error) cancelledOrders++;
    }

    // 3. Optionally close all open positions for ALL users
    let closedPositions = 0;
    const { config } = await getOrCreateConfig(supabase, userId);
    if (config?.kill_switch_close_positions) {
      const { executeFullClose, resolveCurrentPrice } = require('./paperTrading');
      const { data: openTrades } = await supabase.from('paper_trades')
        .select('*')
        .in('status', ['open', 'partial']);

      for (const trade of (openTrades || [])) {
        try {
          // Resolve current market price; fall back to entry_price only if unavailable
          let closePrice;
          try {
            closePrice = resolveCurrentPrice(trade.asset);
          } catch (_) { /* ignore */ }
          if (!closePrice || closePrice <= 0) {
            closePrice = parseFloat(trade.entry_price);
            logger.warn('Kill switch: using entry_price as fallback', { tradeId: trade.id, asset: trade.asset });
          }
          await executeFullClose(supabase, trade, closePrice, 'kill_switch');
          closedPositions++;
        } catch (closeErr) {
          logger.warn('Kill switch: failed to close trade', { tradeId: trade.id, error: closeErr.message });
        }
      }
    }

    // 4. Log kill switch event
    // Create a system order placeholder for the log entry
    const { data: sysOrder } = await supabase.from('orders').insert({
      user_id: userId,
      asset: 'SYSTEM',
      asset_class: 'system',
      side: 'BUY',
      order_type: 'MARKET',
      quantity: 0,
      status: ORDER_STATUS.CANCELLED,
      source: 'system',
      client_order_id: `killswitch-${Date.now()}`
    }).select().single();

    if (sysOrder) {
      await logExecution(supabase, sysOrder.id, EVENT_TYPE.KILL_SWITCH, {
        reason,
        cancelledOrders,
        closedPositions,
        activatedAt: new Date().toISOString()
      });
    }

    // 5. Notify
    if (options.notifyFn) {
      try {
        await options.notifyFn(`🚨 KILL SWITCH ACTIVATED\nReason: ${reason}\nOrders cancelled: ${cancelledOrders}\nPositions closed: ${closedPositions}`);
      } catch (notifyErr) {
        logger.warn('Kill switch notification failed', { error: notifyErr.message });
      }
    }

    logger.warn('GLOBAL kill switch activated', { activatedBy: userId, reason, cancelledOrders, closedPositions });
    return { success: true, cancelledOrders, closedPositions };
  } catch (err) {
    logger.error('activateKillSwitch exception', { error: err.message });
    return { success: false, cancelledOrders: 0, closedPositions: 0 };
  }
}

/**
 * Deactivate kill switch — re-enable trading for ALL users.
 */
async function deactivateKillSwitch(supabase, userId) {
  try {
    const { error } = await supabase.from('paper_config')
      .update({ is_enabled: true })
      .neq('is_enabled', true); // Only update those currently disabled

    if (error) {
      return { success: false, error: error.message };
    }

    logger.info('GLOBAL kill switch deactivated', { reactivatedBy: userId });
    return { success: true };
  } catch (err) {
    logger.error('deactivateKillSwitch exception', { error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Get kill switch status from config.
 */
async function getKillSwitchStatus(supabase, userId) {
  try {
    const { config } = await getOrCreateConfig(supabase, userId);
    return {
      active: config ? !config.is_enabled : false,
      closePositionsOnActivation: config?.kill_switch_close_positions || false,
      autoExecute: config?.auto_execute !== false,
      executionMode: config?.execution_mode || 'paper'
    };
  } catch (err) {
    return { active: false, closePositionsOnActivation: false, autoExecute: true, executionMode: 'paper' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RISK DASHBOARD
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get aggregated risk dashboard data.
 *
 * @param {object} supabase
 * @param {string} userId
 * @param {object} [marketData] - Current market data
 * @returns {Promise<object>}
 */
async function getRiskDashboard(supabase, userId, marketData = null) {
  try {
    const { config } = await getOrCreateConfig(supabase, userId);
    if (!config) return { error: 'Config not found' };

    // Fetch in parallel
    const [
      drawdownCheck,
      killSwitchStatus,
      heatMapResult,
      ordersResult
    ] = await Promise.all([
      checkDrawdownCircuitBreaker(supabase, userId, config),
      getKillSwitchStatus(supabase, userId),
      getPositionHeatMap(supabase, userId, marketData, config).catch(() => ({ positions: [], summary: {} })),
      getOrders(supabase, userId, { limit: 10 }).catch(() => ({ orders: [], total: 0 }))
    ]);

    // Daily P&L info
    const maxDailyLoss = config.initial_capital * config.max_daily_loss_percent;
    const dailyPnlPct = config.initial_capital > 0
      ? (config.daily_pnl / config.initial_capital * 100)
      : 0;

    return {
      // Capital
      currentCapital: config.current_capital,
      initialCapital: config.initial_capital,
      capitalChange: config.current_capital - config.initial_capital,
      capitalChangePct: config.initial_capital > 0
        ? ((config.current_capital - config.initial_capital) / config.initial_capital * 100)
        : 0,

      // Drawdown
      drawdown: {
        current: drawdownCheck.currentDrawdown,
        threshold: drawdownCheck.threshold,
        triggered: drawdownCheck.triggered,
        peakEquity: drawdownCheck.peakEquity
      },

      // Daily P&L
      dailyPnl: {
        amount: config.daily_pnl,
        percent: dailyPnlPct,
        limit: maxDailyLoss,
        limitPct: config.max_daily_loss_percent * 100,
        usagePct: maxDailyLoss > 0 ? (Math.abs(config.daily_pnl) / maxDailyLoss * 100) : 0
      },

      // Kill switch
      killSwitch: killSwitchStatus,

      // Heat map summary
      heatMap: heatMapResult.summary || {},

      // Open orders
      pendingOrders: (ordersResult.orders || []).filter(o =>
        [ORDER_STATUS.PENDING, ORDER_STATUS.VALIDATED, ORDER_STATUS.SUBMITTED].includes(o.status)
      ).length,

      // Config
      maxOpenPositions: config.max_open_positions,
      riskPerTrade: config.risk_per_trade,
      maxPositionPercent: config.max_position_percent,
      executionMode: config.execution_mode || 'paper',
      autoExecute: config.auto_execute !== false
    };
  } catch (err) {
    logger.error('getRiskDashboard exception', { error: err.message });
    return { error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Pre-trade validation
  validatePreTrade,

  // Drawdown
  checkDrawdownCircuitBreaker,

  // Kill switch
  activateKillSwitch,
  deactivateKillSwitch,
  getKillSwitchStatus,

  // Dashboard
  getRiskDashboard
};
