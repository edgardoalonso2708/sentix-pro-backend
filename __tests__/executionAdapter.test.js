// ═══════════════════════════════════════════════════════════════════════════════
// Tests — Execution Adapter (PaperExecutionAdapter + registry)
// ═══════════════════════════════════════════════════════════════════════════════

const { createAdapter, getAvailableAdapters, ExecutionAdapter } = require('../execution');
const { PaperExecutionAdapter } = require('../execution/PaperExecutionAdapter');

// ─── Mock dependencies ──────────────────────────────────────────────────────

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

jest.mock('../paperTrading', () => ({
  openTrade: jest.fn().mockResolvedValue({
    trade: {
      id: 'trade-1',
      direction: 'LONG',
      entry_price: 50050,
      asset: 'bitcoin'
    },
    error: null
  }),
  applySlippage: jest.fn().mockImplementation((price, isBuy) => {
    // Simulate ~0.1% slippage
    return isBuy ? price * 1.001 : price * 0.999;
  }),
  resolveCurrentPrice: jest.fn().mockReturnValue(50000),
  getOrCreateConfig: jest.fn().mockResolvedValue({
    config: { current_capital: 10000, initial_capital: 10000 },
    error: null
  }),
  getOpenPositions: jest.fn().mockResolvedValue({ positions: [] }),
  DEFAULT_CONFIG: {}
}));

const { openTrade, resolveCurrentPrice, applySlippage } = require('../paperTrading');

function createMockSupabase() {
  const chain = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: null, error: null }),
  };
  return {
    from: jest.fn().mockReturnValue(chain)
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ExecutionAdapter (abstract)
// ═══════════════════════════════════════════════════════════════════════════════

describe('ExecutionAdapter (abstract)', () => {
  test('cannot be instantiated directly', () => {
    expect(() => new ExecutionAdapter('test')).toThrow('abstract');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Registry
// ═══════════════════════════════════════════════════════════════════════════════

describe('Adapter Registry', () => {
  test('createAdapter creates paper adapter', () => {
    const sb = createMockSupabase();
    const adapter = createAdapter('paper', { supabase: sb });
    expect(adapter).toBeInstanceOf(PaperExecutionAdapter);
    expect(adapter.name).toBe('paper');
  });

  test('createAdapter throws for unknown type', () => {
    expect(() => createAdapter('unknown')).toThrow('Unknown execution adapter type');
  });

  test('createAdapter throws if supabase missing for paper', () => {
    expect(() => createAdapter('paper', {})).toThrow('requires supabase');
  });

  test('getAvailableAdapters returns list', () => {
    const adapters = getAvailableAdapters();
    expect(adapters).toContain('paper');
    expect(adapters).toContain('bybit');
    expect(adapters.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PaperExecutionAdapter
// ═══════════════════════════════════════════════════════════════════════════════

describe('PaperExecutionAdapter', () => {
  let adapter;
  let sb;

  beforeEach(() => {
    jest.clearAllMocks();
    sb = createMockSupabase();
    adapter = new PaperExecutionAdapter(sb);
    resolveCurrentPrice.mockReturnValue(50000);
  });

  // ─── MARKET orders ──────────────────────────────────────────────────────

  describe('placeOrder — MARKET', () => {
    const marketOrder = {
      id: 'order-1',
      user_id: 'user1',
      asset: 'bitcoin',
      asset_class: 'crypto',
      side: 'BUY',
      order_type: 'MARKET',
      quantity: 0.01,
      position_size_usd: 500,
      risk_amount: 100,
      stop_loss: '48000',
      take_profit_1: '55000',
      take_profit_2: '60000',
      trailing_activation: null,
      price: null,
      stop_price: null,
      signal_snapshot: {
        strengthLabel: 'STRONG BUY',
        confidence: 75,
        rawScore: 80,
        score: 85,
        reasons: 'Test signal'
      }
    };

    test('fills MARKET BUY immediately with slippage', async () => {
      const result = await adapter.placeOrder(marketOrder, { _regime: 'trending_up' });

      expect(result.filled).toBe(true);
      expect(result.fillPrice).toBeDefined();
      expect(result.fillQuantity).toBe(0.01);
      expect(result.slippage).toBeGreaterThan(0);
      expect(result.trade).toBeDefined();
      expect(result.trade.id).toBe('trade-1');

      // Verify openTrade was called with correct params
      expect(openTrade).toHaveBeenCalledTimes(1);
      const [, userId, signal, posSize, mktData, orderId] = openTrade.mock.calls[0];
      expect(userId).toBe('user1');
      expect(signal.action).toBe('BUY');
      expect(signal.asset).toBe('bitcoin');
      expect(posSize.quantity).toBe(0.01);
      expect(orderId).toBe('order-1'); // Order ID linked to trade
    });

    test('fills MARKET SELL immediately', async () => {
      const sellOrder = { ...marketOrder, side: 'SELL' };
      const result = await adapter.placeOrder(sellOrder);

      expect(result.filled).toBe(true);
      expect(openTrade).toHaveBeenCalledTimes(1);
      const signal = openTrade.mock.calls[0][2];
      expect(signal.action).toBe('SELL');
    });

    test('fails when price unavailable', async () => {
      resolveCurrentPrice.mockReturnValue(null);
      const result = await adapter.placeOrder(marketOrder);

      expect(result.filled).toBe(false);
      expect(result.reason).toContain('Cannot resolve');
    });

    test('fails when openTrade returns error', async () => {
      openTrade.mockResolvedValueOnce({
        trade: null,
        error: { message: 'Insufficient capital' }
      });

      const result = await adapter.placeOrder(marketOrder);
      expect(result.filled).toBe(false);
      expect(result.reason).toContain('openTrade failed');
    });
  });

  // ─── LIMIT orders ──────────────────────────────────────────────────────

  describe('placeOrder — LIMIT', () => {
    test('fills BUY LIMIT when price at or below limit', async () => {
      resolveCurrentPrice.mockReturnValue(49000); // Below limit
      const order = {
        id: 'order-2',
        user_id: 'user1',
        asset: 'bitcoin',
        asset_class: 'crypto',
        side: 'BUY',
        order_type: 'LIMIT',
        quantity: 0.01,
        price: '50000',
        stop_price: null,
        position_size_usd: 490,
        risk_amount: 100,
        stop_loss: '47000',
        take_profit_1: '55000',
        take_profit_2: null,
        trailing_activation: null,
        signal_snapshot: {}
      };

      const result = await adapter.placeOrder(order);
      expect(result.filled).toBe(true);
    });

    test('does NOT fill BUY LIMIT when price above limit', async () => {
      resolveCurrentPrice.mockReturnValue(51000); // Above limit
      const order = {
        id: 'order-2',
        user_id: 'user1',
        asset: 'bitcoin',
        asset_class: 'crypto',
        side: 'BUY',
        order_type: 'LIMIT',
        quantity: 0.01,
        price: '50000',
        stop_price: null,
        position_size_usd: 510,
        risk_amount: 100,
        stop_loss: '47000',
        take_profit_1: '55000',
        take_profit_2: null,
        trailing_activation: null,
        signal_snapshot: {}
      };

      const result = await adapter.placeOrder(order);
      expect(result.filled).toBe(false);
      expect(result.reason).toContain('LIMIT not reached');
    });

    test('fills SELL LIMIT when price at or above limit', async () => {
      resolveCurrentPrice.mockReturnValue(51000);
      const order = {
        id: 'order-3',
        user_id: 'user1',
        asset: 'bitcoin',
        asset_class: 'crypto',
        side: 'SELL',
        order_type: 'LIMIT',
        quantity: 0.01,
        price: '50000',
        stop_price: null,
        position_size_usd: 510,
        risk_amount: 100,
        stop_loss: '53000',
        take_profit_1: '45000',
        take_profit_2: null,
        trailing_activation: null,
        signal_snapshot: {}
      };

      const result = await adapter.placeOrder(order);
      expect(result.filled).toBe(true);
    });
  });

  // ─── STOP_LIMIT orders ─────────────────────────────────────────────────

  describe('placeOrder — STOP_LIMIT', () => {
    const stopLimitBuy = {
      id: 'order-4',
      user_id: 'user1',
      asset: 'bitcoin',
      asset_class: 'crypto',
      side: 'BUY',
      order_type: 'STOP_LIMIT',
      quantity: 0.01,
      price: '52000',      // limit
      stop_price: '51000',  // trigger
      position_size_usd: 520,
      risk_amount: 100,
      stop_loss: '49000',
      take_profit_1: '57000',
      take_profit_2: null,
      trailing_activation: null,
      signal_snapshot: {}
    };

    test('does NOT fill when stop not triggered', async () => {
      resolveCurrentPrice.mockReturnValue(49000); // Below stop
      const result = await adapter.placeOrder(stopLimitBuy);
      expect(result.filled).toBe(false);
      expect(result.reason).toContain('STOP not triggered');
    });

    test('fills when stop triggered AND limit satisfied', async () => {
      resolveCurrentPrice.mockReturnValue(51500); // Above stop, below limit
      const result = await adapter.placeOrder(stopLimitBuy);
      expect(result.filled).toBe(true);
    });

    test('does NOT fill when stop triggered but limit exceeded', async () => {
      resolveCurrentPrice.mockReturnValue(53000); // Above both stop and limit
      const result = await adapter.placeOrder(stopLimitBuy);
      expect(result.filled).toBe(false);
      expect(result.reason).toContain('LIMIT not met');
    });
  });

  // ─── Other methods ─────────────────────────────────────────────────────

  describe('cancelOrder', () => {
    test('always returns cancelled (paper no-op)', async () => {
      const result = await adapter.cancelOrder('any-id');
      expect(result.cancelled).toBe(true);
    });
  });

  describe('getBalance', () => {
    test('returns capital from paper config', async () => {
      const balance = await adapter.getBalance('user1');
      expect(balance.available).toBe(10000);
      expect(balance.total).toBe(10000);
    });
  });

  describe('healthCheck', () => {
    test('returns healthy', async () => {
      const health = await adapter.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.adapter).toBe('paper');
    });
  });
});
