// ═══════════════════════════════════════════════════════════════════════════════
// Tests — orderManager.js (order lifecycle, validation, signal processing)
// ═══════════════════════════════════════════════════════════════════════════════

const {
  createOrder,
  validateOrder,
  submitOrder,
  cancelOrder,
  getOrders,
  getOrder,
  expireOrders,
  processSignals,
  getExecutionLog,
  generateClientOrderId,
  ORDER_STATUS,
  ORDER_TYPE,
  ORDER_SOURCE,
  EVENT_TYPE
} = require('../orderManager');

// ─── Mock dependencies ──────────────────────────────────────────────────────

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

jest.mock('../kellySizing', () => ({
  buildSizingOptions: jest.fn().mockReturnValue({
    kellyResult: { applied: false },
    volResult: { applied: false }
  })
}));

// Mock paperTrading — define mocks inside factory to avoid hoisting issues
jest.mock('../paperTrading', () => {
  const defaultConfig = {
    is_enabled: true,
    risk_per_trade: 0.01,
    current_capital: 10000,
    initial_capital: 10000,
    max_open_positions: 3,
    max_daily_loss_percent: 0.05,
    cooldown_minutes: 30,
    min_confluence: 3,
    min_rr_ratio: 1.5,
    max_position_percent: 0.30,
    max_portfolio_correlation: 0.70,
    max_sector_exposure_pct: 0.80,
    max_same_direction_crypto: 3,
    allowed_strength: ['STRONG BUY', 'STRONG SELL'],
    last_trade_at: null,
    daily_pnl: 0,
    daily_pnl_reset_at: new Date().toISOString()
  };

  return {
    evaluateSignalForTrade: jest.fn().mockReturnValue({ eligible: true, reason: 'All criteria met' }),
    calculatePositionSize: jest.fn().mockReturnValue({
      positionSizeUsd: 500,
      quantity: 0.01,
      riskAmount: 100
    }),
    checkSafetyLimits: jest.fn().mockResolvedValue({ safe: true, reason: 'OK' }),
    checkDuplicateTrade: jest.fn().mockResolvedValue(false),
    checkPortfolioLimits: jest.fn().mockResolvedValue({ allowed: true, reason: 'OK' }),
    getOrCreateConfig: jest.fn().mockResolvedValue({ config: { ...defaultConfig }, error: null }),
    DEFAULT_CONFIG: {
      max_position_percent: 0.30,
      current_capital: 10000,
      risk_per_trade: 0.01,
      max_portfolio_correlation: 0.70,
      max_sector_exposure_pct: 0.80,
      max_same_direction_crypto: 3
    }
  };
});

// Get references to the mocked functions for per-test control
const {
  checkSafetyLimits: mockCheckSafetyLimits,
  checkDuplicateTrade: mockCheckDuplicateTrade,
  checkPortfolioLimits: mockCheckPortfolioLimits,
  getOrCreateConfig: mockGetOrCreateConfig
} = require('../paperTrading');

// ─── Mock Supabase ──────────────────────────────────────────────────────────

function createMockSupabase(opts = {}) {
  const insertedData = [];
  const updatedData = [];

  function makeChain(resolveData = null, resolveError = null) {
    let _insertedRecord = null;
    let _countMode = false;

    const chain = {
      select: jest.fn().mockImplementation((...args) => {
        if (args[1] && args[1].count === 'exact') {
          _countMode = true;
        }
        return chain;
      }),
      single: jest.fn().mockImplementation(() => {
        const data = _insertedRecord || (Array.isArray(resolveData) ? resolveData[0] : resolveData);
        return Promise.resolve({ data, error: resolveError });
      }),
      eq: jest.fn().mockImplementation(() => chain),
      in: jest.fn().mockImplementation(() => chain),
      lt: jest.fn().mockImplementation(() => chain),
      order: jest.fn().mockImplementation(() => chain),
      range: jest.fn().mockImplementation(() => chain),
      limit: jest.fn().mockImplementation(() => chain),
      insert: jest.fn().mockImplementation((data) => {
        const record = { id: 'order-' + Math.random().toString(36).slice(2, 8), ...data };
        insertedData.push(record);
        _insertedRecord = record;
        return chain;
      }),
      update: jest.fn().mockImplementation((data) => {
        updatedData.push(data);
        return chain;
      }),
      then: (resolve, reject) => {
        if (_countMode) {
          return Promise.resolve({ count: opts.count || 0, error: resolveError }).then(resolve, reject);
        }
        const data = _insertedRecord || resolveData;
        return Promise.resolve({ data, count: opts.count, error: resolveError }).then(resolve, reject);
      }
    };
    return chain;
  }

  const sb = {
    from: jest.fn().mockImplementation((table) => {
      if (table === 'orders' && opts.ordersData !== undefined) {
        return makeChain(opts.ordersData, opts.ordersError);
      }
      if (table === 'execution_log') {
        return makeChain(opts.logsData || [], opts.logsError);
      }
      if (table === 'paper_trades') {
        return makeChain(opts.tradesData || [], opts.tradesError);
      }
      return makeChain(opts.defaultData || null, opts.defaultError);
    }),
    _insertedData: insertedData,
    _updatedData: updatedData
  };

  return sb;
}

// ═══════════════════════════════════════════════════════════════════════════════
// generateClientOrderId
// ═══════════════════════════════════════════════════════════════════════════════

describe('generateClientOrderId', () => {
  test('generates unique IDs', () => {
    const id1 = generateClientOrderId('signal', 'Bitcoin');
    const id2 = generateClientOrderId('signal', 'Bitcoin');
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^signal-bitcoin-/);
  });

  test('sanitizes asset names', () => {
    const id = generateClientOrderId('manual', 'Avalanche-2');
    expect(id).toMatch(/^manual-avalanche2-/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createOrder
// ═══════════════════════════════════════════════════════════════════════════════

describe('createOrder', () => {
  test('creates MARKET order with required fields', async () => {
    const sb = createMockSupabase();
    const { order, error } = await createOrder(sb, 'user1', {
      asset: 'bitcoin',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 0.01,
      positionSizeUsd: 500,
      riskAmount: 100,
      stopLoss: 48000,
      takeProfit1: 55000
    });

    expect(error).toBeNull();
    expect(order).toBeDefined();
    expect(sb.from).toHaveBeenCalledWith('orders');
    expect(sb._insertedData.length).toBeGreaterThanOrEqual(1);
    const inserted = sb._insertedData[0];
    expect(inserted.asset).toBe('bitcoin');
    expect(inserted.side).toBe('BUY');
    expect(inserted.order_type).toBe('MARKET');
    expect(inserted.status).toBe('PENDING');
    expect(inserted.source).toBe('manual');
  });

  test('creates LIMIT order with price', async () => {
    const sb = createMockSupabase();
    const { order, error } = await createOrder(sb, 'user1', {
      asset: 'ethereum',
      side: 'SELL',
      orderType: 'LIMIT',
      quantity: 1.5,
      price: 3500
    });

    expect(error).toBeNull();
    const inserted = sb._insertedData[0];
    expect(inserted.order_type).toBe('LIMIT');
    expect(inserted.price).toBe(3500);
  });

  test('rejects LIMIT without price', async () => {
    const sb = createMockSupabase();
    const { order, error } = await createOrder(sb, 'user1', {
      asset: 'bitcoin',
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: 0.01
    });

    expect(order).toBeNull();
    expect(error.message).toContain('LIMIT orders require a price');
  });

  test('rejects STOP_LIMIT without stopPrice', async () => {
    const sb = createMockSupabase();
    const { order, error } = await createOrder(sb, 'user1', {
      asset: 'bitcoin',
      side: 'BUY',
      orderType: 'STOP_LIMIT',
      quantity: 0.01,
      price: 50000
    });

    expect(order).toBeNull();
    expect(error.message).toContain('STOP_LIMIT');
  });

  test('rejects missing required fields', async () => {
    const sb = createMockSupabase();
    const { order, error } = await createOrder(sb, 'user1', {
      asset: 'bitcoin'
    });

    expect(order).toBeNull();
    expect(error.message).toContain('Missing required fields');
  });

  test('rejects invalid side', async () => {
    const sb = createMockSupabase();
    const { order, error } = await createOrder(sb, 'user1', {
      asset: 'bitcoin',
      side: 'LONG',
      orderType: 'MARKET',
      quantity: 0.01
    });

    expect(order).toBeNull();
    expect(error.message).toContain('Invalid side');
  });

  test('rejects zero quantity', async () => {
    const sb = createMockSupabase();
    const { order, error } = await createOrder(sb, 'user1', {
      asset: 'bitcoin',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 0
    });

    expect(order).toBeNull();
    expect(error.message).toContain('Quantity must be positive');
  });

  test('uses custom clientOrderId for idempotency', async () => {
    const sb = createMockSupabase();
    const { order } = await createOrder(sb, 'user1', {
      asset: 'bitcoin',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 0.01,
      clientOrderId: 'my-custom-id-123'
    });

    const inserted = sb._insertedData[0];
    expect(inserted.client_order_id).toBe('my-custom-id-123');
  });

  test('creates signal-sourced order with snapshot', async () => {
    const sb = createMockSupabase();
    const { order } = await createOrder(sb, 'user1', {
      asset: 'bitcoin',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 0.01,
      source: 'signal',
      signalSnapshot: { score: 80, confidence: 75 }
    });

    const inserted = sb._insertedData[0];
    expect(inserted.source).toBe('signal');
    expect(inserted.signal_snapshot).toEqual({ score: 80, confidence: 75 });
  });

  test('logs ORDER_CREATED event', async () => {
    const sb = createMockSupabase();
    await createOrder(sb, 'user1', {
      asset: 'bitcoin',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 0.01
    });

    // execution_log insert should have been called
    const execLogCalls = sb.from.mock.calls.filter(c => c[0] === 'execution_log');
    expect(execLogCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// validateOrder
// ═══════════════════════════════════════════════════════════════════════════════

describe('validateOrder', () => {
  const pendingOrder = {
    id: 'order-1',
    status: 'PENDING',
    asset: 'bitcoin',
    asset_class: 'crypto',
    side: 'BUY',
    order_type: 'MARKET',
    quantity: 0.01,
    position_size_usd: 500
  };

  const config = {
    is_enabled: true,
    risk_per_trade: 0.01,
    current_capital: 10000,
    max_position_percent: 0.30,
    max_open_positions: 3,
    max_daily_loss_percent: 0.05,
    cooldown_minutes: 30,
    max_portfolio_correlation: 0.70,
    max_sector_exposure_pct: 0.80,
    max_same_direction_crypto: 3,
    initial_capital: 10000,
    daily_pnl: 0,
    daily_pnl_reset_at: new Date().toISOString(),
    last_trade_at: null,
    allowed_strength: ['STRONG BUY', 'STRONG SELL']
  };

  beforeEach(() => {
    mockCheckSafetyLimits.mockResolvedValue({ safe: true, reason: 'OK' });
    mockCheckDuplicateTrade.mockResolvedValue(false);
    mockCheckPortfolioLimits.mockResolvedValue({ allowed: true, reason: 'OK' });
  });

  test('validates order with all checks passing', async () => {
    const sb = createMockSupabase();
    const { valid, reason, checks } = await validateOrder(sb, 'user1', { ...pendingOrder }, config);

    expect(valid).toBe(true);
    expect(reason).toBe('All checks passed');
    expect(checks.length).toBe(4);
    expect(checks.every(c => c.passed)).toBe(true);
  });

  test('rejects non-PENDING order', async () => {
    const sb = createMockSupabase();
    const { valid } = await validateOrder(sb, 'user1', { ...pendingOrder, status: 'FILLED' }, config);
    expect(valid).toBe(false);
  });

  test('rejects when trading disabled', async () => {
    const sb = createMockSupabase();
    const { valid, checks } = await validateOrder(
      sb, 'user1', { ...pendingOrder },
      { ...config, is_enabled: false }
    );
    expect(valid).toBe(false);
    expect(checks.some(c => c.name === 'trading_enabled' && !c.passed)).toBe(true);
  });

  test('rejects when safety limits fail', async () => {
    mockCheckSafetyLimits.mockResolvedValue({ safe: false, reason: 'Daily loss limit reached' });
    const sb = createMockSupabase();
    const { valid, checks } = await validateOrder(sb, 'user1', { ...pendingOrder }, config);

    expect(valid).toBe(false);
    expect(checks.some(c => c.name === 'safety_limits' && !c.passed)).toBe(true);
  });

  test('rejects duplicate trade', async () => {
    mockCheckDuplicateTrade.mockResolvedValue(true);
    const sb = createMockSupabase();
    const { valid, checks } = await validateOrder(sb, 'user1', { ...pendingOrder }, config);

    expect(valid).toBe(false);
    expect(checks.some(c => c.name === 'duplicate_trade' && !c.passed)).toBe(true);
  });

  test('rejects when portfolio limits exceeded', async () => {
    mockCheckPortfolioLimits.mockResolvedValue({ allowed: false, reason: 'Correlation too high' });
    const sb = createMockSupabase();
    const { valid, checks } = await validateOrder(sb, 'user1', { ...pendingOrder }, config);

    expect(valid).toBe(false);
    expect(checks.some(c => c.name === 'portfolio_limits' && !c.passed)).toBe(true);
  });

  test('rejects oversized position', async () => {
    const sb = createMockSupabase();
    const { valid, checks } = await validateOrder(
      sb, 'user1',
      { ...pendingOrder, position_size_usd: 5000 }, // 50% of 10K capital, limit is 30%
      config
    );

    expect(valid).toBe(false);
    expect(checks.some(c => c.name === 'position_size' && !c.passed)).toBe(true);
  });

  test('updates order to REJECTED status on failure', async () => {
    mockCheckSafetyLimits.mockResolvedValue({ safe: false, reason: 'Max positions reached' });
    const sb = createMockSupabase();
    await validateOrder(sb, 'user1', { ...pendingOrder }, config);

    // Should have called update with REJECTED status
    const updateCalls = sb.from.mock.calls.filter(c => c[0] === 'orders');
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// cancelOrder
// ═══════════════════════════════════════════════════════════════════════════════

describe('cancelOrder', () => {
  test('cancels PENDING order', async () => {
    const sb = createMockSupabase({
      ordersData: {
        id: 'order-1',
        user_id: 'user1',
        status: 'PENDING',
        asset: 'bitcoin'
      }
    });

    const { order, error } = await cancelOrder(sb, 'user1', 'order-1');
    expect(error).toBeNull();
    expect(order).toBeDefined();
  });

  test('cancels VALIDATED order', async () => {
    const sb = createMockSupabase({
      ordersData: {
        id: 'order-1',
        user_id: 'user1',
        status: 'VALIDATED',
        asset: 'bitcoin'
      }
    });

    const { order, error } = await cancelOrder(sb, 'user1', 'order-1');
    expect(error).toBeNull();
  });

  test('rejects cancelling FILLED order', async () => {
    const sb = createMockSupabase({
      ordersData: {
        id: 'order-1',
        user_id: 'user1',
        status: 'FILLED',
        asset: 'bitcoin'
      }
    });

    const { order, error } = await cancelOrder(sb, 'user1', 'order-1');
    expect(order).toBeNull();
    expect(error.message).toContain('Cannot cancel');
  });

  test('returns error for non-existent order', async () => {
    const sb = createMockSupabase({
      ordersData: null,
      ordersError: { message: 'not found' }
    });

    const { order, error } = await cancelOrder(sb, 'user1', 'nonexistent');
    expect(order).toBeNull();
    expect(error).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// submitOrder
// ═══════════════════════════════════════════════════════════════════════════════

describe('submitOrder', () => {
  const validatedOrder = {
    id: 'order-1',
    status: 'VALIDATED',
    asset: 'bitcoin',
    side: 'BUY',
    order_type: 'MARKET',
    quantity: 0.01,
    position_size_usd: 500
  };

  const mockAdapter = {
    name: 'paper',
    placeOrder: jest.fn().mockResolvedValue({
      filled: true,
      fillPrice: 50100,
      fillQuantity: 0.01,
      slippage: 0.001,
      trade: { id: 'trade-1', direction: 'LONG', entry_price: 50100 }
    })
  };

  test('submits validated order and gets fill', async () => {
    const sb = createMockSupabase();
    const { filledOrder, trade, error } = await submitOrder(
      sb, 'user1', { ...validatedOrder }, mockAdapter
    );

    expect(error).toBeNull();
    expect(filledOrder).toBeDefined();
    expect(filledOrder.status).toBe('FILLED');
    expect(trade).toBeDefined();
    expect(trade.id).toBe('trade-1');
    expect(mockAdapter.placeOrder).toHaveBeenCalledTimes(1);
  });

  test('handles unfilled LIMIT order', async () => {
    const unfilledAdapter = {
      name: 'paper',
      placeOrder: jest.fn().mockResolvedValue({
        filled: false,
        reason: 'Price not reached'
      })
    };

    const sb = createMockSupabase();
    const { filledOrder, trade, error } = await submitOrder(
      sb, 'user1', { ...validatedOrder }, unfilledAdapter
    );

    expect(error).toBeNull();
    expect(trade).toBeNull();
    // Order stays in SUBMITTED status
  });

  test('rejects non-VALIDATED order', async () => {
    const sb = createMockSupabase();
    const { error } = await submitOrder(
      sb, 'user1', { ...validatedOrder, status: 'PENDING' }, mockAdapter
    );

    expect(error).toBeDefined();
    expect(error.message).toContain('not VALIDATED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// expireOrders
// ═══════════════════════════════════════════════════════════════════════════════

describe('expireOrders', () => {
  test('expires GTD orders past their time', async () => {
    const pastOrders = [
      { id: 'order-1', user_id: 'user1', asset: 'bitcoin' },
      { id: 'order-2', user_id: 'user1', asset: 'ethereum' }
    ];

    const sb = createMockSupabase({ ordersData: pastOrders });
    const { expired } = await expireOrders(sb);

    // Should have queried and updated
    expect(sb.from).toHaveBeenCalledWith('orders');
  });

  test('returns 0 when no orders to expire', async () => {
    const sb = createMockSupabase({ ordersData: [] });
    const { expired } = await expireOrders(sb);
    expect(expired).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// processSignals
// ═══════════════════════════════════════════════════════════════════════════════

describe('processSignals', () => {
  const mockSignal = {
    asset: 'Bitcoin',
    action: 'BUY',
    strengthLabel: 'STRONG BUY',
    rawScore: 75,
    score: 80,
    confidence: 70,
    price: 50000,
    assetClass: 'crypto',
    reasons: 'Multi-timeframe confluence',
    tradeLevels: {
      entry: 50000,
      stopLoss: 48000,
      takeProfit1: 55000,
      takeProfit2: 60000,
      riskRewardRatio: 2.5,
      trailingActivation: 57000
    },
    timeframes: {
      '1h': { trend: 'bullish' },
      '4h': { trend: 'bullish' },
      '15m': { trend: 'bullish' },
      confluence: 'strong'
    },
    indicators: {}
  };

  const mockAdapter = {
    name: 'paper',
    placeOrder: jest.fn().mockResolvedValue({
      filled: true,
      fillPrice: 50100,
      fillQuantity: 0.01,
      trade: { id: 'trade-1', direction: 'LONG', entry_price: 50100 }
    })
  };

  const marketData = { _regime: 'trending_up' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckSafetyLimits.mockResolvedValue({ safe: true, reason: 'OK' });
    mockCheckDuplicateTrade.mockResolvedValue(false);
    mockCheckPortfolioLimits.mockResolvedValue({ allowed: true, reason: 'OK' });
    mockGetOrCreateConfig.mockResolvedValue({
      config: {
        is_enabled: true,
        risk_per_trade: 0.01,
        current_capital: 10000,
        initial_capital: 10000,
        max_open_positions: 3,
        max_daily_loss_percent: 0.05,
        cooldown_minutes: 30,
        min_confluence: 3,
        min_rr_ratio: 1.5,
        max_position_percent: 0.30,
        max_portfolio_correlation: 0.70,
        max_sector_exposure_pct: 0.80,
        max_same_direction_crypto: 3,
        allowed_strength: ['STRONG BUY', 'STRONG SELL'],
        last_trade_at: null,
        daily_pnl: 0,
        daily_pnl_reset_at: new Date().toISOString()
      },
      error: null
    });
  });

  test('processes signal through full pipeline', async () => {
    const sb = createMockSupabase({ tradesData: [] });
    const result = await processSignals(sb, 'user1', [mockSignal], marketData, mockAdapter);

    expect(result.created.length).toBeGreaterThanOrEqual(1);
    expect(result.skipped.length).toBe(0);
  });

  test('skips non-crypto assets', async () => {
    const sb = createMockSupabase({ tradesData: [] });
    const metalSignal = { ...mockSignal, asset: 'GOLD', assetClass: 'metal' };
    const result = await processSignals(sb, 'user1', [metalSignal], marketData, mockAdapter);

    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].reason).toContain('Non-crypto');
  });

  test('returns empty when trading disabled', async () => {
    mockGetOrCreateConfig.mockResolvedValue({
      config: { is_enabled: false },
      error: null
    });

    const sb = createMockSupabase({ tradesData: [] });
    const result = await processSignals(sb, 'user1', [mockSignal], marketData, mockAdapter);

    expect(result.created.length).toBe(0);
    expect(result.executed.length).toBe(0);
  });

  test('skips ineligible signals', async () => {
    const { evaluateSignalForTrade } = require('../paperTrading');
    evaluateSignalForTrade.mockReturnValueOnce({ eligible: false, reason: 'R:R too low' });

    const sb = createMockSupabase({ tradesData: [] });
    const result = await processSignals(sb, 'user1', [mockSignal], marketData, mockAdapter);

    expect(result.skipped.length).toBe(1);
    expect(result.skipped[0].reason).toContain('R:R too low');
  });

  test('handles multiple signals', async () => {
    const sb = createMockSupabase({ tradesData: [] });
    const signals = [
      { ...mockSignal, asset: 'Bitcoin' },
      { ...mockSignal, asset: 'Ethereum' }
    ];

    const result = await processSignals(sb, 'user1', signals, marketData, mockAdapter);
    expect(result.created.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getOrders
// ═══════════════════════════════════════════════════════════════════════════════

describe('getOrders', () => {
  test('returns orders list', async () => {
    const mockOrders = [
      { id: 'order-1', asset: 'bitcoin', status: 'FILLED' },
      { id: 'order-2', asset: 'ethereum', status: 'PENDING' }
    ];
    const sb = createMockSupabase({ ordersData: mockOrders, count: 2 });
    const { orders, total, error } = await getOrders(sb, 'user1');

    expect(error).toBeNull();
    expect(sb.from).toHaveBeenCalledWith('orders');
  });

  test('applies status filter', async () => {
    const sb = createMockSupabase({ ordersData: [] });
    await getOrders(sb, 'user1', { status: 'PENDING' });

    expect(sb.from).toHaveBeenCalledWith('orders');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

describe('Constants', () => {
  test('ORDER_STATUS has all expected values', () => {
    expect(ORDER_STATUS.PENDING).toBe('PENDING');
    expect(ORDER_STATUS.VALIDATED).toBe('VALIDATED');
    expect(ORDER_STATUS.SUBMITTED).toBe('SUBMITTED');
    expect(ORDER_STATUS.FILLED).toBe('FILLED');
    expect(ORDER_STATUS.CANCELLED).toBe('CANCELLED');
    expect(ORDER_STATUS.REJECTED).toBe('REJECTED');
    expect(ORDER_STATUS.EXPIRED).toBe('EXPIRED');
  });

  test('ORDER_TYPE has all expected values', () => {
    expect(ORDER_TYPE.MARKET).toBe('MARKET');
    expect(ORDER_TYPE.LIMIT).toBe('LIMIT');
    expect(ORDER_TYPE.STOP_LIMIT).toBe('STOP_LIMIT');
  });

  test('EVENT_TYPE has all expected values', () => {
    expect(EVENT_TYPE.ORDER_CREATED).toBe('ORDER_CREATED');
    expect(EVENT_TYPE.KILL_SWITCH).toBe('KILL_SWITCH');
  });
});
