// ═══════════════════════════════════════════════════════════════════════════════
// Tests — riskEngine.js (pre-trade validation, drawdown breaker, kill switch)
// ═══════════════════════════════════════════════════════════════════════════════

const {
  validatePreTrade,
  checkDrawdownCircuitBreaker,
  activateKillSwitch,
  deactivateKillSwitch,
  getKillSwitchStatus,
  getRiskDashboard
} = require('../riskEngine');

// ─── Mock dependencies ──────────────────────────────────────────────────────

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }
}));

jest.mock('../paperTrading', () => ({
  checkSafetyLimits: jest.fn().mockResolvedValue({ safe: true, reason: 'OK' }),
  checkDuplicateTrade: jest.fn().mockResolvedValue(false),
  checkPortfolioLimits: jest.fn().mockResolvedValue({ allowed: true, reason: 'OK' }),
  getOrCreateConfig: jest.fn().mockResolvedValue({
    config: {
      is_enabled: true,
      current_capital: 10000,
      initial_capital: 10000,
      max_daily_loss_percent: 0.05,
      daily_pnl: 0,
      max_position_percent: 0.30,
      max_open_positions: 3,
      risk_per_trade: 0.01,
      max_drawdown_pct: 0.15,
      kill_switch_close_positions: false,
      auto_execute: true,
      execution_mode: 'paper',
      daily_pnl_reset_at: new Date().toISOString(),
      last_trade_at: null,
      cooldown_minutes: 30,
      max_portfolio_correlation: 0.70,
      max_sector_exposure_pct: 0.80,
      max_same_direction_crypto: 3,
      allowed_strength: ['STRONG BUY', 'STRONG SELL']
    },
    error: null
  }),
  getPositionHeatMap: jest.fn().mockResolvedValue({ positions: [], summary: { cool: 0, warm: 0, hot: 0 } }),
  getOpenPositions: jest.fn().mockResolvedValue({ positions: [] }),
  executeFullClose: jest.fn().mockResolvedValue({ trade: {}, error: null }),
  resolveCurrentPrice: jest.fn().mockReturnValue(50000),
  DEFAULT_CONFIG: { max_position_percent: 0.30, current_capital: 10000 }
}));

jest.mock('../orderManager', () => ({
  cancelOrder: jest.fn().mockResolvedValue({ order: {}, error: null }),
  getOrders: jest.fn().mockResolvedValue({ orders: [], total: 0 }),
  logExecution: jest.fn().mockResolvedValue(undefined),
  EVENT_TYPE: {
    KILL_SWITCH: 'KILL_SWITCH',
    RISK_CHECK_PASS: 'RISK_CHECK_PASS',
    RISK_CHECK_FAIL: 'RISK_CHECK_FAIL'
  },
  ORDER_STATUS: {
    PENDING: 'PENDING',
    VALIDATED: 'VALIDATED',
    SUBMITTED: 'SUBMITTED',
    CANCELLED: 'CANCELLED'
  }
}));

const {
  checkSafetyLimits: mockSafety,
  checkDuplicateTrade: mockDuplicate,
  checkPortfolioLimits: mockPortfolio,
  getOrCreateConfig: mockGetConfig
} = require('../paperTrading');
const { cancelOrder: mockCancel, getOrders: mockGetOrders } = require('../orderManager');

// ─── Mock Supabase ──────────────────────────────────────────────────────────

function createMockSb(opts = {}) {
  function makeChain(data = null, error = null) {
    const chain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      range: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data, error }),
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      then: (resolve) => Promise.resolve({ data, error }).then(resolve)
    };
    return chain;
  }

  return {
    from: jest.fn().mockImplementation((table) => {
      if (table === 'paper_equity_snapshots') {
        return makeChain(opts.equityData || null, opts.equityError);
      }
      if (table === 'paper_config') {
        return makeChain(null, null);
      }
      if (table === 'paper_trades') {
        return makeChain(opts.tradesData || [], null);
      }
      if (table === 'orders') {
        return makeChain(opts.ordersData || { id: 'sys-order' }, null);
      }
      if (table === 'execution_log') {
        return makeChain(null, null);
      }
      return makeChain(null, null);
    })
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// checkDrawdownCircuitBreaker
// ═══════════════════════════════════════════════════════════════════════════════

describe('checkDrawdownCircuitBreaker', () => {
  const config = {
    max_drawdown_pct: 0.15,
    current_capital: 8000,
    initial_capital: 10000
  };

  test('triggers when drawdown exceeds threshold', async () => {
    const sb = createMockSb({ equityData: { equity: 12000 } }); // Peak was 12K, now 8K = 33%
    const result = await checkDrawdownCircuitBreaker(sb, 'user1', config);

    expect(result.triggered).toBe(true);
    expect(result.currentDrawdown).toBeCloseTo(0.333, 2);
    expect(result.peakEquity).toBe(12000);
    expect(result.currentEquity).toBe(8000);
  });

  test('does not trigger when drawdown within threshold', async () => {
    const sb = createMockSb({ equityData: { equity: 9000 } }); // Peak 10K (max of 9K and initial 10K), now 8K = 20%... wait
    const configOk = { ...config, max_drawdown_pct: 0.25 }; // 25% threshold
    const result = await checkDrawdownCircuitBreaker(sb, 'user1', configOk);

    // Peak = max(9000, 10000) = 10000, current = 8000, drawdown = 20%
    expect(result.triggered).toBe(false);
    expect(result.currentDrawdown).toBeCloseTo(0.2, 2);
  });

  test('returns 0 drawdown when no equity history', async () => {
    const sb = createMockSb({ equityData: null });
    const configFlat = { ...config, current_capital: 10000 };
    const result = await checkDrawdownCircuitBreaker(sb, 'user1', configFlat);

    expect(result.triggered).toBe(false);
    expect(result.currentDrawdown).toBe(0);
  });

  test('uses initial_capital as floor for peak', async () => {
    const sb = createMockSb({ equityData: { equity: 5000 } }); // Snapshot peak below initial
    const result = await checkDrawdownCircuitBreaker(sb, 'user1', config);

    // Peak = max(5000, 10000) = 10000, current = 8000, drawdown = 20%
    expect(result.peakEquity).toBe(10000);
    expect(result.triggered).toBe(true); // 20% > 15%
  });

  test('handles DB error gracefully', async () => {
    const sb = createMockSb({ equityError: { message: 'connection failed' } });
    const result = await checkDrawdownCircuitBreaker(sb, 'user1', config);

    expect(result.triggered).toBe(false); // Fail-open
    expect(result.currentDrawdown).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// validatePreTrade
// ═══════════════════════════════════════════════════════════════════════════════

describe('validatePreTrade', () => {
  const order = {
    id: 'order-1',
    asset: 'bitcoin',
    asset_class: 'crypto',
    side: 'BUY',
    position_size_usd: 500
  };

  const config = {
    is_enabled: true,
    current_capital: 10000,
    initial_capital: 10000,
    max_position_percent: 0.30,
    max_drawdown_pct: 0.15,
    max_daily_loss_percent: 0.05,
    daily_pnl: 0,
    daily_pnl_reset_at: new Date().toISOString(),
    last_trade_at: null,
    cooldown_minutes: 30,
    max_open_positions: 3,
    max_portfolio_correlation: 0.70,
    max_sector_exposure_pct: 0.80,
    max_same_direction_crypto: 3,
    allowed_strength: ['STRONG BUY', 'STRONG SELL']
  };

  beforeEach(() => {
    mockSafety.mockResolvedValue({ safe: true, reason: 'OK' });
    mockDuplicate.mockResolvedValue(false);
    mockPortfolio.mockResolvedValue({ allowed: true, reason: 'OK' });
  });

  test('approves order when all checks pass', async () => {
    const sb = createMockSb({ equityData: null });
    const { approved, checks } = await validatePreTrade(sb, 'user1', order, config);

    expect(approved).toBe(true);
    expect(checks.length).toBe(6); // enabled, safety, duplicate, portfolio, size, drawdown
    expect(checks.every(c => c.passed)).toBe(true);
  });

  test('rejects when trading disabled', async () => {
    const sb = createMockSb();
    const { approved, checks } = await validatePreTrade(sb, 'user1', order, { ...config, is_enabled: false });

    expect(approved).toBe(false);
    expect(checks[0].name).toBe('trading_enabled');
    expect(checks[0].passed).toBe(false);
  });

  test('rejects when safety limits fail', async () => {
    mockSafety.mockResolvedValue({ safe: false, reason: 'Daily loss limit' });
    const sb = createMockSb({ equityData: null });
    const { approved, checks } = await validatePreTrade(sb, 'user1', order, config);

    expect(approved).toBe(false);
    expect(checks.find(c => c.name === 'safety_limits').passed).toBe(false);
  });

  test('rejects when duplicate trade', async () => {
    mockDuplicate.mockResolvedValue(true);
    const sb = createMockSb({ equityData: null });
    const { approved } = await validatePreTrade(sb, 'user1', order, config);

    expect(approved).toBe(false);
  });

  test('rejects when portfolio limits exceeded', async () => {
    mockPortfolio.mockResolvedValue({ allowed: false, reason: 'Correlation too high' });
    const sb = createMockSb({ equityData: null });
    const { approved } = await validatePreTrade(sb, 'user1', order, config);

    expect(approved).toBe(false);
  });

  test('rejects oversized position', async () => {
    const sb = createMockSb({ equityData: null });
    const bigOrder = { ...order, position_size_usd: 5000 }; // 50% > 30% limit
    const { approved, checks } = await validatePreTrade(sb, 'user1', bigOrder, config);

    expect(approved).toBe(false);
    expect(checks.find(c => c.name === 'position_size').passed).toBe(false);
  });

  test('rejects when drawdown breaker triggered', async () => {
    const sb = createMockSb({ equityData: { equity: 15000 } }); // Peak 15K, current 10K = 33%
    const { approved, checks } = await validatePreTrade(sb, 'user1', order, config);

    expect(approved).toBe(false);
    expect(checks.find(c => c.name === 'drawdown_breaker').passed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Kill Switch
// ═══════════════════════════════════════════════════════════════════════════════

describe('activateKillSwitch', () => {
  beforeEach(() => {
    mockCancel.mockResolvedValue({ order: {}, error: null });
    mockGetOrders.mockResolvedValue({ orders: [], total: 0 });
    mockGetConfig.mockResolvedValue({
      config: { kill_switch_close_positions: false, is_enabled: true },
      error: null
    });
  });

  test('disables trading', async () => {
    const sb = createMockSb();
    const result = await activateKillSwitch(sb, 'user1', 'Emergency');

    expect(result.success).toBe(true);
    // Should have called update on paper_config
    const configCalls = sb.from.mock.calls.filter(c => c[0] === 'paper_config');
    expect(configCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('cancels pending orders', async () => {
    mockGetOrders.mockResolvedValue({
      orders: [
        { id: 'o1', status: 'PENDING' },
        { id: 'o2', status: 'VALIDATED' },
        { id: 'o3', status: 'FILLED' } // Should not be cancelled
      ],
      total: 3
    });

    const sb = createMockSb();
    const result = await activateKillSwitch(sb, 'user1', 'Test');

    expect(result.cancelledOrders).toBe(2);
    expect(mockCancel).toHaveBeenCalledTimes(2);
  });

  test('calls notification function', async () => {
    const notifyFn = jest.fn().mockResolvedValue(undefined);
    const sb = createMockSb();
    await activateKillSwitch(sb, 'user1', 'Emergency', { notifyFn });

    expect(notifyFn).toHaveBeenCalledTimes(1);
    expect(notifyFn.mock.calls[0][0]).toContain('KILL SWITCH');
  });

  test('handles notification failure gracefully', async () => {
    const notifyFn = jest.fn().mockRejectedValue(new Error('Telegram down'));
    const sb = createMockSb();
    const result = await activateKillSwitch(sb, 'user1', 'Test', { notifyFn });

    expect(result.success).toBe(true); // Should still succeed
  });
});

describe('deactivateKillSwitch', () => {
  test('re-enables trading', async () => {
    const sb = createMockSb();
    const result = await deactivateKillSwitch(sb, 'user1');

    expect(result.success).toBe(true);
    const configCalls = sb.from.mock.calls.filter(c => c[0] === 'paper_config');
    expect(configCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('getKillSwitchStatus', () => {
  test('returns status from config', async () => {
    mockGetConfig.mockResolvedValue({
      config: {
        is_enabled: false, // Trading disabled = kill switch active
        kill_switch_close_positions: true,
        auto_execute: false,
        execution_mode: 'paper'
      },
      error: null
    });

    const sb = createMockSb();
    const status = await getKillSwitchStatus(sb, 'user1');

    expect(status.active).toBe(true);
    expect(status.closePositionsOnActivation).toBe(true);
    expect(status.autoExecute).toBe(false);
    expect(status.executionMode).toBe('paper');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getRiskDashboard
// ═══════════════════════════════════════════════════════════════════════════════

describe('getRiskDashboard', () => {
  test('returns aggregated risk data', async () => {
    mockGetConfig.mockResolvedValue({
      config: {
        is_enabled: true,
        current_capital: 9500,
        initial_capital: 10000,
        max_daily_loss_percent: 0.05,
        daily_pnl: -200,
        max_drawdown_pct: 0.15,
        max_open_positions: 3,
        risk_per_trade: 0.01,
        max_position_percent: 0.30,
        kill_switch_close_positions: false,
        auto_execute: true,
        execution_mode: 'paper',
        daily_pnl_reset_at: new Date().toISOString(),
        last_trade_at: null,
        cooldown_minutes: 30,
        max_portfolio_correlation: 0.70,
        max_sector_exposure_pct: 0.80,
        max_same_direction_crypto: 3,
        allowed_strength: ['STRONG BUY', 'STRONG SELL']
      },
      error: null
    });

    const sb = createMockSb({ equityData: null });
    const dashboard = await getRiskDashboard(sb, 'user1');

    expect(dashboard.currentCapital).toBe(9500);
    expect(dashboard.initialCapital).toBe(10000);
    expect(dashboard.capitalChange).toBe(-500);
    expect(dashboard.dailyPnl.amount).toBe(-200);
    expect(dashboard.drawdown).toBeDefined();
    expect(dashboard.killSwitch).toBeDefined();
    expect(dashboard.executionMode).toBe('paper');
    expect(dashboard.maxOpenPositions).toBe(3);
  });
});
