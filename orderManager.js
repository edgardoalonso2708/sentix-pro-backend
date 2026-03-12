// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — Order Manager
// Manages the order lifecycle: PENDING → VALIDATED → SUBMITTED → FILLED
// Orders are first-class entities that go through risk validation before
// becoming trades via the execution adapter.
// ═══════════════════════════════════════════════════════════════════════════════

const { v4: uuidv4 } = require('uuid');
const { logger } = require('./logger');
const {
  evaluateSignalForTrade,
  calculatePositionSize,
  checkSafetyLimits,
  checkDuplicateTrade,
  checkPortfolioLimits,
  getOrCreateConfig,
  DEFAULT_CONFIG
} = require('./paperTrading');
const { buildSizingOptions } = require('./kellySizing');

// ─── ORDER STATUS CONSTANTS ─────────────────────────────────────────────────

const ORDER_STATUS = Object.freeze({
  PENDING:      'PENDING',
  VALIDATED:    'VALIDATED',
  SUBMITTED:    'SUBMITTED',
  PARTIAL_FILL: 'PARTIAL_FILL',
  FILLED:       'FILLED',
  CANCELLED:    'CANCELLED',
  REJECTED:     'REJECTED',
  EXPIRED:      'EXPIRED'
});

const ORDER_TYPE = Object.freeze({
  MARKET:     'MARKET',
  LIMIT:      'LIMIT',
  STOP_LIMIT: 'STOP_LIMIT'
});

const ORDER_SOURCE = Object.freeze({
  SIGNAL:  'signal',
  MANUAL:  'manual',
  BRACKET: 'bracket',
  SYSTEM:  'system'
});

const EVENT_TYPE = Object.freeze({
  ORDER_CREATED:      'ORDER_CREATED',
  ORDER_VALIDATED:    'ORDER_VALIDATED',
  ORDER_REJECTED:     'ORDER_REJECTED',
  ORDER_SUBMITTED:    'ORDER_SUBMITTED',
  ORDER_PARTIAL_FILL: 'ORDER_PARTIAL_FILL',
  ORDER_FILLED:       'ORDER_FILLED',
  ORDER_CANCELLED:    'ORDER_CANCELLED',
  ORDER_EXPIRED:      'ORDER_EXPIRED',
  TRADE_OPENED:       'TRADE_OPENED',
  TRADE_PARTIAL_CLOSE:'TRADE_PARTIAL_CLOSE',
  TRADE_CLOSED:       'TRADE_CLOSED',
  RISK_CHECK_PASS:    'RISK_CHECK_PASS',
  RISK_CHECK_FAIL:    'RISK_CHECK_FAIL',
  KILL_SWITCH:        'KILL_SWITCH'
});

// ─── HELPERS ────────────────────────────────────────────────────────────────

/**
 * Log an event to the execution_log table.
 */
async function logExecution(supabase, orderId, eventType, details = {}, tradeId = null) {
  try {
    await supabase.from('execution_log').insert({
      order_id: orderId,
      trade_id: tradeId,
      event_type: eventType,
      details
    });
  } catch (err) {
    logger.warn('Failed to log execution event', { orderId, eventType, error: err.message });
  }
}

/**
 * Generate a unique client order ID for idempotency.
 */
function generateClientOrderId(source, asset) {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${source}-${asset.toLowerCase().replace(/[^a-z0-9]/g, '')}-${ts}-${rnd}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CREATE ORDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a new order in PENDING status.
 *
 * @param {object} supabase
 * @param {string} userId
 * @param {object} orderSpec - Order specification
 * @param {string} orderSpec.asset - Asset identifier (e.g., 'bitcoin')
 * @param {string} orderSpec.side - 'BUY' or 'SELL'
 * @param {string} orderSpec.orderType - 'MARKET', 'LIMIT', or 'STOP_LIMIT'
 * @param {number} orderSpec.quantity - Amount in asset units
 * @param {number} [orderSpec.price] - Limit price (required for LIMIT, STOP_LIMIT)
 * @param {number} [orderSpec.stopPrice] - Trigger price (required for STOP_LIMIT)
 * @param {number} [orderSpec.stopLoss] - Stop loss price
 * @param {number} [orderSpec.takeProfit1] - Take profit 1 price
 * @param {number} [orderSpec.takeProfit2] - Take profit 2 price
 * @param {number} [orderSpec.trailingStopPct] - Trailing stop percentage
 * @param {number} [orderSpec.trailingActivation] - Trailing activation price
 * @param {number} [orderSpec.positionSizeUsd] - Position size in USD
 * @param {number} [orderSpec.riskAmount] - Amount risked
 * @param {string} [orderSpec.source='manual'] - Order source
 * @param {object} [orderSpec.signalSnapshot] - Signal data snapshot
 * @param {string} [orderSpec.signalId] - Signal reference ID
 * @param {string} [orderSpec.timeInForce='GTC'] - Time in force
 * @param {string} [orderSpec.expireAt] - Expiration time for GTD orders
 * @param {string} [orderSpec.clientOrderId] - Custom idempotency key
 * @param {string} [orderSpec.assetClass='crypto'] - Asset class
 * @param {string} [orderSpec.executionAdapter='paper'] - Execution adapter
 * @returns {Promise<{order: object|null, error: object|null}>}
 */
async function createOrder(supabase, userId, orderSpec) {
  try {
    // Validate required fields
    if (!orderSpec.asset || !orderSpec.side || !orderSpec.orderType) {
      return { order: null, error: { message: 'Missing required fields: asset, side, orderType' } };
    }

    if (!['BUY', 'SELL'].includes(orderSpec.side)) {
      return { order: null, error: { message: `Invalid side: ${orderSpec.side}` } };
    }

    if (!['MARKET', 'LIMIT', 'STOP_LIMIT'].includes(orderSpec.orderType)) {
      return { order: null, error: { message: `Invalid orderType: ${orderSpec.orderType}` } };
    }

    if (orderSpec.orderType === 'LIMIT' && !orderSpec.price) {
      return { order: null, error: { message: 'LIMIT orders require a price' } };
    }

    if (orderSpec.orderType === 'STOP_LIMIT' && (!orderSpec.price || !orderSpec.stopPrice)) {
      return { order: null, error: { message: 'STOP_LIMIT orders require price and stopPrice' } };
    }

    if (!orderSpec.quantity || orderSpec.quantity <= 0) {
      return { order: null, error: { message: 'Quantity must be positive' } };
    }

    const clientOrderId = orderSpec.clientOrderId || generateClientOrderId(
      orderSpec.source || 'manual',
      orderSpec.asset
    );

    const orderData = {
      user_id: userId,
      client_order_id: clientOrderId,
      parent_order_id: orderSpec.parentOrderId || null,
      asset: orderSpec.asset,
      asset_class: orderSpec.assetClass || 'crypto',
      side: orderSpec.side,
      order_type: orderSpec.orderType,
      quantity: orderSpec.quantity,
      price: orderSpec.price || null,
      stop_price: orderSpec.stopPrice || null,
      time_in_force: orderSpec.timeInForce || 'GTC',
      expire_at: orderSpec.expireAt || null,
      stop_loss: orderSpec.stopLoss || null,
      take_profit_1: orderSpec.takeProfit1 || null,
      take_profit_2: orderSpec.takeProfit2 || null,
      trailing_stop_pct: orderSpec.trailingStopPct || null,
      trailing_activation: orderSpec.trailingActivation || null,
      position_size_usd: orderSpec.positionSizeUsd || null,
      risk_amount: orderSpec.riskAmount || null,
      status: ORDER_STATUS.PENDING,
      source: orderSpec.source || ORDER_SOURCE.MANUAL,
      signal_id: orderSpec.signalId || null,
      signal_snapshot: orderSpec.signalSnapshot || null,
      execution_adapter: orderSpec.executionAdapter || 'paper'
    };

    const { data, error } = await supabase
      .from('orders')
      .insert(orderData)
      .select()
      .single();

    if (error) {
      // Check for duplicate client_order_id
      if (error.code === '23505' && error.message?.includes('client_order_id')) {
        return { order: null, error: { message: 'Duplicate order: client_order_id already exists', code: 'DUPLICATE' } };
      }
      return { order: null, error };
    }

    await logExecution(supabase, data.id, EVENT_TYPE.ORDER_CREATED, {
      source: orderData.source,
      orderType: orderData.order_type,
      side: orderData.side,
      asset: orderData.asset,
      quantity: orderData.quantity,
      price: orderData.price
    });

    logger.info('Order created', {
      orderId: data.id,
      asset: orderData.asset,
      side: orderData.side,
      type: orderData.order_type,
      source: orderData.source
    });

    return { order: data, error: null };
  } catch (err) {
    logger.error('createOrder exception', { error: err.message });
    return { order: null, error: err };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VALIDATE ORDER (pre-trade risk checks)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run pre-trade risk validation on an order.
 * Transitions: PENDING → VALIDATED or PENDING → REJECTED.
 *
 * @param {object} supabase
 * @param {string} userId
 * @param {object} order - The order record from DB
 * @param {object} [config] - Trading config (auto-fetched if null)
 * @returns {Promise<{valid: boolean, reason: string, order: object, checks: Array}>}
 */
async function validateOrder(supabase, userId, order, config = null) {
  const checks = [];

  try {
    // Ensure order is in PENDING status
    if (order.status !== ORDER_STATUS.PENDING) {
      return {
        valid: false,
        reason: `Order not in PENDING status (current: ${order.status})`,
        order,
        checks
      };
    }

    // Fetch config if not provided
    if (!config) {
      const { config: fetched } = await getOrCreateConfig(supabase, userId);
      config = fetched;
    }

    if (!config) {
      return { valid: false, reason: 'Could not load trading config', order, checks };
    }

    if (!config.is_enabled) {
      checks.push({ name: 'trading_enabled', passed: false, detail: 'Paper trading disabled' });
      await rejectOrder(supabase, order.id, 'Paper trading disabled');
      await logExecution(supabase, order.id, EVENT_TYPE.RISK_CHECK_FAIL, { checks });
      return { valid: false, reason: 'Paper trading disabled', order, checks };
    }

    // ── CHECK 1: Safety limits (daily loss, position count, cooldown) ──
    const { safe, reason: safetyReason } = await checkSafetyLimits(supabase, userId, config);
    checks.push({ name: 'safety_limits', passed: safe, detail: safetyReason });
    if (!safe) {
      await rejectOrder(supabase, order.id, safetyReason);
      await logExecution(supabase, order.id, EVENT_TYPE.RISK_CHECK_FAIL, { checks });
      return { valid: false, reason: safetyReason, order, checks };
    }

    // ── CHECK 2: Duplicate trade ──
    const isDuplicate = await checkDuplicateTrade(supabase, userId, order.asset);
    checks.push({ name: 'duplicate_trade', passed: !isDuplicate, detail: isDuplicate ? 'Already has open trade on this asset' : 'No duplicate' });
    if (isDuplicate) {
      const reason = `Already has open trade on ${order.asset}`;
      await rejectOrder(supabase, order.id, reason);
      await logExecution(supabase, order.id, EVENT_TYPE.RISK_CHECK_FAIL, { checks });
      return { valid: false, reason, order, checks };
    }

    // ── CHECK 3: Portfolio limits (correlation, sector, same-direction) ──
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
    if (!portfolioCheck.allowed) {
      await rejectOrder(supabase, order.id, portfolioCheck.reason);
      await logExecution(supabase, order.id, EVENT_TYPE.RISK_CHECK_FAIL, { checks });
      return { valid: false, reason: portfolioCheck.reason, order, checks };
    }

    // ── CHECK 4: Position size limits (min $50, max % of capital) ──
    const MIN_POSITION_USD = 50;
    if (order.position_size_usd) {
      // Minimum check
      if (order.position_size_usd < MIN_POSITION_USD) {
        const reason = `Position size $${order.position_size_usd} below minimum $${MIN_POSITION_USD}`;
        checks.push({ name: 'position_size_min', passed: false, detail: reason });
        await rejectOrder(supabase, order.id, reason);
        await logExecution(supabase, order.id, EVENT_TYPE.RISK_CHECK_FAIL, { checks });
        return { valid: false, reason, order, checks };
      }

      // Maximum check
      const maxPct = config.max_position_percent || DEFAULT_CONFIG.max_position_percent;
      const maxPosition = config.current_capital * maxPct;
      const sizeOk = order.position_size_usd <= maxPosition;
      checks.push({
        name: 'position_size',
        passed: sizeOk,
        detail: sizeOk
          ? `$${order.position_size_usd} within limit $${maxPosition.toFixed(2)}`
          : `$${order.position_size_usd} exceeds max $${maxPosition.toFixed(2)} (${(maxPct * 100)}% of capital)`
      });
      if (!sizeOk) {
        const reason = `Position size $${order.position_size_usd} exceeds max $${maxPosition.toFixed(2)}`;
        await rejectOrder(supabase, order.id, reason);
        await logExecution(supabase, order.id, EVENT_TYPE.RISK_CHECK_FAIL, { checks });
        return { valid: false, reason, order, checks };
      }
    }

    // ── All checks passed → VALIDATED ──
    const { error: updateError } = await supabase
      .from('orders')
      .update({ status: ORDER_STATUS.VALIDATED, validated_at: new Date().toISOString() })
      .eq('id', order.id);

    if (updateError) {
      return { valid: false, reason: `Failed to update order: ${updateError.message}`, order, checks };
    }

    order.status = ORDER_STATUS.VALIDATED;
    order.validated_at = new Date().toISOString();

    await logExecution(supabase, order.id, EVENT_TYPE.RISK_CHECK_PASS, { checks });
    await logExecution(supabase, order.id, EVENT_TYPE.ORDER_VALIDATED, {});

    logger.info('Order validated', { orderId: order.id, asset: order.asset, checks: checks.length });

    return { valid: true, reason: 'All checks passed', order, checks };
  } catch (err) {
    logger.error('validateOrder exception', { orderId: order.id, error: err.message });
    return { valid: false, reason: `Validation error: ${err.message}`, order, checks };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUBMIT ORDER (send to execution adapter)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Submit a validated order to the execution adapter for fill.
 * Transitions: VALIDATED → SUBMITTED → FILLED (or back to PENDING on failure).
 *
 * @param {object} supabase
 * @param {string} userId
 * @param {object} order - The validated order record
 * @param {object} executionAdapter - ExecutionAdapter instance
 * @param {object} [marketData] - Current market data
 * @returns {Promise<{filledOrder: object|null, trade: object|null, error: object|null}>}
 */
async function submitOrder(supabase, userId, order, executionAdapter, marketData = null, config = null) {
  try {
    if (order.status !== ORDER_STATUS.VALIDATED) {
      return { filledOrder: null, trade: null, error: { message: `Order not VALIDATED (current: ${order.status})` } };
    }

    // Mark as SUBMITTED
    await supabase
      .from('orders')
      .update({ status: ORDER_STATUS.SUBMITTED, submitted_at: new Date().toISOString() })
      .eq('id', order.id);

    order.status = ORDER_STATUS.SUBMITTED;
    await logExecution(supabase, order.id, EVENT_TYPE.ORDER_SUBMITTED, {});

    // Execute via adapter
    let fillResult;
    try {
      fillResult = await executionAdapter.placeOrder(order, marketData, config);
    } catch (adapterErr) {
      // Rollback: SUBMITTED → VALIDATED so order can be retried
      logger.error('Adapter execution failed, rolling back to VALIDATED', { orderId: order.id, error: adapterErr.message });
      await supabase.from('orders')
        .update({ status: ORDER_STATUS.VALIDATED, submitted_at: null })
        .eq('id', order.id);
      return { filledOrder: null, trade: null, error: { message: `Execution failed: ${adapterErr.message}` } };
    }

    if (!fillResult.filled) {
      // Order not immediately filled (e.g., LIMIT order not at price)
      // Keep in SUBMITTED status for future checking
      logger.info('Order submitted but not filled', { orderId: order.id, reason: fillResult.reason });
      return { filledOrder: order, trade: null, error: null };
    }

    // ── Order filled ──
    const now = new Date().toISOString();
    const { error: fillError } = await supabase
      .from('orders')
      .update({
        status: ORDER_STATUS.FILLED,
        filled_quantity: fillResult.fillQuantity || order.quantity,
        avg_fill_price: fillResult.fillPrice,
        filled_at: now
      })
      .eq('id', order.id);

    if (fillError) {
      logger.error('Failed to update filled order', { orderId: order.id, error: fillError.message });
    }

    order.status = ORDER_STATUS.FILLED;
    order.avg_fill_price = fillResult.fillPrice;
    order.filled_quantity = fillResult.fillQuantity || order.quantity;
    order.filled_at = now;

    await logExecution(supabase, order.id, EVENT_TYPE.ORDER_FILLED, {
      fillPrice: fillResult.fillPrice,
      fillQuantity: fillResult.fillQuantity,
      slippage: fillResult.slippage
    });

    // Log trade opened if a trade was created
    if (fillResult.trade) {
      await logExecution(supabase, order.id, EVENT_TYPE.TRADE_OPENED, {
        tradeId: fillResult.trade.id,
        direction: fillResult.trade.direction,
        entryPrice: fillResult.trade.entry_price
      }, fillResult.trade.id);
    }

    logger.info('Order filled', {
      orderId: order.id,
      asset: order.asset,
      fillPrice: fillResult.fillPrice,
      tradeId: fillResult.trade?.id
    });

    return { filledOrder: order, trade: fillResult.trade || null, error: null };
  } catch (err) {
    logger.error('submitOrder exception', { orderId: order.id, error: err.message });
    return { filledOrder: null, trade: null, error: err };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CANCEL ORDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Cancel a PENDING or VALIDATED order.
 *
 * @param {object} supabase
 * @param {string} userId
 * @param {string} orderId
 * @returns {Promise<{order: object|null, error: object|null}>}
 */
async function cancelOrder(supabase, userId, orderId) {
  try {
    // Fetch current order
    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !order) {
      return { order: null, error: { message: 'Order not found' } };
    }

    const cancellable = [ORDER_STATUS.PENDING, ORDER_STATUS.VALIDATED, ORDER_STATUS.SUBMITTED];
    if (!cancellable.includes(order.status)) {
      return { order: null, error: { message: `Cannot cancel order in ${order.status} status` } };
    }

    const { error: updateError } = await supabase
      .from('orders')
      .update({ status: ORDER_STATUS.CANCELLED, cancelled_at: new Date().toISOString() })
      .eq('id', orderId);

    if (updateError) {
      return { order: null, error: updateError };
    }

    order.status = ORDER_STATUS.CANCELLED;
    await logExecution(supabase, orderId, EVENT_TYPE.ORDER_CANCELLED, { previousStatus: order.status });

    logger.info('Order cancelled', { orderId, asset: order.asset });
    return { order, error: null };
  } catch (err) {
    logger.error('cancelOrder exception', { orderId, error: err.message });
    return { order: null, error: err };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Query orders with optional filters.
 *
 * @param {object} supabase
 * @param {string} userId
 * @param {object} [filters]
 * @param {string} [filters.status]
 * @param {string} [filters.asset]
 * @param {number} [filters.limit=50]
 * @param {number} [filters.offset=0]
 * @returns {Promise<{orders: Array, total: number, error: object|null}>}
 */
async function getOrders(supabase, userId, filters = {}) {
  try {
    let query = supabase
      .from('orders')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (filters.status) {
      query = query.eq('status', filters.status);
    }
    if (filters.asset) {
      query = query.eq('asset', filters.asset);
    }

    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data, count, error } = await query;

    if (error) {
      return { orders: [], total: 0, error };
    }

    return { orders: data || [], total: count || 0, error: null };
  } catch (err) {
    logger.error('getOrders exception', { error: err.message });
    return { orders: [], total: 0, error: err };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET SINGLE ORDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get a single order by ID.
 */
async function getOrder(supabase, userId, orderId) {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (error) {
      return { order: null, error };
    }
    return { order: data, error: null };
  } catch (err) {
    return { order: null, error: err };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPIRE ORDERS (GTD past expiration)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Expire GTD orders that have passed their expire_at time.
 * Called periodically from worker.
 */
async function expireOrders(supabase) {
  try {
    const now = new Date().toISOString();

    // Find orders with GTD time_in_force that have expired
    const { data: expired, error: fetchError } = await supabase
      .from('orders')
      .select('id, user_id, asset')
      .eq('time_in_force', 'GTD')
      .in('status', [ORDER_STATUS.PENDING, ORDER_STATUS.VALIDATED, ORDER_STATUS.SUBMITTED])
      .lt('expire_at', now);

    if (fetchError || !expired || expired.length === 0) {
      return { expired: 0 };
    }

    const expiredIds = expired.map(o => o.id);

    const { error: updateError } = await supabase
      .from('orders')
      .update({ status: ORDER_STATUS.EXPIRED })
      .in('id', expiredIds);

    if (updateError) {
      logger.warn('Failed to expire orders', { error: updateError.message });
      return { expired: 0 };
    }

    // Log each expiration
    for (const order of expired) {
      await logExecution(supabase, order.id, EVENT_TYPE.ORDER_EXPIRED, {
        asset: order.asset
      });
    }

    logger.info('Expired GTD orders', { count: expired.length });
    return { expired: expired.length };
  } catch (err) {
    logger.error('expireOrders exception', { error: err.message });
    return { expired: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REJECT ORDER (internal helper)
// ═══════════════════════════════════════════════════════════════════════════════

async function rejectOrder(supabase, orderId, reason) {
  const { error } = await supabase
    .from('orders')
    .update({
      status: ORDER_STATUS.REJECTED,
      reject_reason: reason
    })
    .eq('id', orderId);

  if (error) {
    logger.error('rejectOrder DB error', { orderId, reason, error: error.message });
    throw new Error(`Failed to reject order ${orderId}: ${error.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS SIGNALS → ORDERS (replaces evaluateAndExecute for new flow)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Process an array of signals through the order pipeline.
 * For each eligible signal: create order → validate → submit (if autoExecute).
 *
 * @param {object} supabase
 * @param {string} userId
 * @param {Array} signals - Array of signal objects from signal engine
 * @param {object} marketData - Current market data
 * @param {object} executionAdapter - ExecutionAdapter instance
 * @param {object} [options]
 * @param {boolean} [options.autoExecute=true] - Auto-submit validated orders
 * @returns {Promise<{created: Array, rejected: Array, executed: Array, skipped: Array}>}
 */
async function processSignals(supabase, userId, signals, marketData, executionAdapter, options = {}) {
  const result = { created: [], rejected: [], executed: [], skipped: [] };
  const autoExecute = options.autoExecute !== false;

  try {
    const { config, error: configError } = await getOrCreateConfig(supabase, userId);
    if (configError || !config) {
      logger.warn('processSignals: could not get config', { error: configError?.message });
      return result;
    }

    if (!config.is_enabled) {
      return result;
    }

    // Cache completed trades for Kelly sizing (shared across signals)
    let completedTrades = null;

    for (const signal of signals) {
      // Skip non-crypto assets
      if (signal.assetClass === 'metal' ||
          (signal.asset && (signal.asset.includes('GOLD') || signal.asset.includes('SILVER') ||
           signal.asset.includes('XAU') || signal.asset.includes('XAG')))) {
        result.skipped.push({ asset: signal.asset, reason: 'Non-crypto asset (reference only)' });
        continue;
      }

      // Evaluate signal eligibility
      const { eligible, reason } = evaluateSignalForTrade(signal, config);
      if (!eligible) {
        result.skipped.push({ asset: signal.asset, reason });
        continue;
      }

      // Calculate position size with Kelly + volatility targeting
      let sizingOptions = null;
      try {
        if (!completedTrades) {
          const { data: closedTrades } = await supabase.from('paper_trades')
            .select('pnl_usd').eq('user_id', userId).eq('status', 'closed')
            .order('exit_at', { ascending: false }).limit(100);
          completedTrades = (closedTrades || []).map(t => ({ pnl: parseFloat(t.pnl_usd) || 0 }));
        }

        const atrPercent = signal.indicators?.atrPercent
          || signal.tradeLevels?.atrPercent
          || (signal.tradeLevels?.atrValue && signal.tradeLevels.entry
            ? (signal.tradeLevels.atrValue / signal.tradeLevels.entry) * 100
            : null);

        const regime = marketData?._regime || 'normal';
        const regimeKellyFraction = { volatile: 0.25, trending_up: 0.5, trending_down: 0.35, ranging: 0.4, normal: 0.5 };

        const kellyConfig = {
          kelly: {
            enabled: true,
            fraction: regimeKellyFraction[regime] || 0.5,
            minTrades: 15,
            lookbackTrades: 100,
            minRiskPerTrade: 0.005,
            maxRiskPerTrade: 0.04
          },
          volatilityTargeting: {
            enabled: !!atrPercent,
            targetATRPercent: 2.0,
            minScale: 0.3,
            maxScale: 1.5
          }
        };

        sizingOptions = buildSizingOptions(completedTrades, atrPercent, kellyConfig);
      } catch (sizingErr) {
        logger.debug('Kelly sizing failed, using fixed risk', { error: sizingErr.message });
      }

      const positionSize = calculatePositionSize(config, signal, sizingOptions);
      if (positionSize.positionSizeUsd <= 0 || positionSize.skipped) {
        result.skipped.push({ asset: signal.asset, reason: positionSize.reason || 'Position size too small' });
        continue;
      }

      // Create order from signal
      const { order, error: createError } = await createOrder(supabase, userId, {
        asset: signal.asset,
        assetClass: signal.assetClass || 'crypto',
        side: signal.action === 'BUY' ? 'BUY' : 'SELL',
        orderType: ORDER_TYPE.MARKET,
        quantity: positionSize.quantity,
        stopLoss: signal.tradeLevels.stopLoss,
        takeProfit1: signal.tradeLevels.takeProfit1,
        takeProfit2: signal.tradeLevels.takeProfit2 || null,
        trailingActivation: signal.tradeLevels.trailingActivation || null,
        positionSizeUsd: positionSize.positionSizeUsd,
        riskAmount: positionSize.riskAmount,
        source: ORDER_SOURCE.SIGNAL,
        signalId: signal.signalId || null,
        signalSnapshot: {
          score: signal.score,
          rawScore: signal.rawScore,
          confidence: signal.confidence,
          strengthLabel: signal.strengthLabel,
          reasons: signal.reasons,
          tradeLevels: signal.tradeLevels,
          indicators: signal.indicators
        },
        executionAdapter: executionAdapter.name
      });

      if (createError || !order) {
        result.skipped.push({ asset: signal.asset, reason: `Create order failed: ${createError?.message}` });
        continue;
      }

      result.created.push(order);

      // Validate order (risk checks)
      const { valid, reason: valReason } = await validateOrder(supabase, userId, order, config);
      if (!valid) {
        result.rejected.push({ order, reason: valReason });
        continue;
      }

      // Submit if auto-execute enabled
      if (autoExecute) {
        const { filledOrder, trade, error: submitError } = await submitOrder(
          supabase, userId, order, executionAdapter, marketData, config
        );

        if (submitError) {
          result.rejected.push({ order, reason: `Submit failed: ${submitError.message}` });
        } else if (trade) {
          result.executed.push({ order: filledOrder, trade });
          // Refresh config (capital changed)
          const { config: refreshed } = await getOrCreateConfig(supabase, userId);
          if (refreshed) Object.assign(config, refreshed);
        } else {
          // Submitted but not filled (LIMIT order at price not reached)
          result.created.push(order);
        }
      }
    }

    return result;
  } catch (err) {
    logger.error('processSignals exception', { error: err.message });
    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET EXECUTION LOG
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get execution audit trail.
 */
async function getExecutionLog(supabase, userId, filters = {}) {
  try {
    // Join through orders to filter by user_id
    let query = supabase
      .from('execution_log')
      .select('*, orders!inner(user_id, asset, side, order_type)')
      .eq('orders.user_id', userId)
      .order('created_at', { ascending: false });

    if (filters.orderId) {
      query = query.eq('order_id', filters.orderId);
    }
    if (filters.eventType) {
      query = query.eq('event_type', filters.eventType);
    }

    const limit = filters.limit || 50;
    const offset = filters.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;

    if (error) {
      return { logs: [], error };
    }

    return { logs: data || [], error: null };
  } catch (err) {
    logger.error('getExecutionLog exception', { error: err.message });
    return { logs: [], error: err };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Constants
  ORDER_STATUS,
  ORDER_TYPE,
  ORDER_SOURCE,
  EVENT_TYPE,

  // Order lifecycle
  createOrder,
  validateOrder,
  submitOrder,
  cancelOrder,
  getOrders,
  getOrder,
  expireOrders,

  // Signal → Order pipeline
  processSignals,

  // Audit
  getExecutionLog,
  logExecution,

  // Helpers (for testing)
  generateClientOrderId,
  _rejectOrder: rejectOrder
};
