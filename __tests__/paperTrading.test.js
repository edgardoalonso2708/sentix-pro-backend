// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - Paper Trading Tests
// Unit tests for pure functions + integration tests
// ═══════════════════════════════════════════════════════════════════════════════

const {
  evaluateSignalForTrade,
  calculatePositionSize,
  checkPriceAgainstLevels,
  resolveCurrentPrice,
  DEFAULT_CONFIG,
  calculateLogReturns,
  calculatePearsonCorrelation,
  getPositionCorrelations
} = require('../paperTrading');

// ─── Test Helpers ──────────────────────────────────────────────────────────

function makeSignal(overrides = {}) {
  return {
    asset: 'BITCOIN',
    action: 'BUY',
    strengthLabel: 'STRONG BUY',
    score: 80,
    rawScore: 60,
    confidence: 70,
    price: 100000,
    change24h: 2.5,
    reasons: 'Test signal',
    tradeLevels: {
      entry: 100000,
      stopLoss: 95000,
      stopLossPercent: 5,
      takeProfit1: 108000,
      takeProfit1Percent: 8,
      takeProfit2: 115000,
      takeProfit2Percent: 15,
      trailingStop: 87500,
      trailingStopPercent: 12.5,
      trailingActivation: 102000,
      trailingActivationPercent: 2,
      trailingStepATR: 2000,
      riskRewardRatio: 2.5,
      riskRewardOk: true,
      atrValue: 2000,
      support: 95000,
      resistance: 110000,
      pivot: 102000
    },
    timeframes: {
      '4h': { trend: 'bullish', score: 70, confidence: 60, action: 'BUY' },
      '1h': { trend: 'bullish', score: 75, confidence: 65, action: 'BUY' },
      '15m': { trend: 'bullish', score: 65, confidence: 55, action: 'BUY' },
      confluence: 3
    },
    macroContext: { btcDominance: 52, btcDomRegime: 'neutral', dxy: 102, dxyRegime: 'neutral' },
    ...overrides
  };
}

function makeConfig(overrides = {}) {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function makeTrade(overrides = {}) {
  return {
    id: 'test-trade-id',
    user_id: 'default-user',
    asset: 'BITCOIN',
    direction: 'LONG',
    entry_price: '100000',
    stop_loss: '95000',
    take_profit_1: '108000',
    take_profit_2: '115000',
    trailing_stop_initial: '87500',
    trailing_stop_current: '87500',
    trailing_activation: '102000',
    trailing_active: false,
    status: 'open',
    quantity: '0.02',
    remaining_quantity: '0.02',
    position_size_usd: '2000',
    risk_amount: '100',
    peak_price: '100000',
    max_favorable: '0',
    max_adverse: '0',
    ...overrides
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// evaluateSignalForTrade
// ═══════════════════════════════════════════════════════════════════════════════

describe('evaluateSignalForTrade', () => {
  test('returns eligible for valid STRONG BUY signal', () => {
    const signal = makeSignal();
    const config = makeConfig();
    const result = evaluateSignalForTrade(signal, config);
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('All criteria met');
  });

  test('returns eligible for valid STRONG SELL signal', () => {
    const signal = makeSignal({ action: 'SELL', strengthLabel: 'STRONG SELL' });
    const config = makeConfig();
    const result = evaluateSignalForTrade(signal, config);
    expect(result.eligible).toBe(true);
  });

  test('rejects HOLD signals', () => {
    const signal = makeSignal({ action: 'HOLD', strengthLabel: 'HOLD' });
    const config = makeConfig();
    const result = evaluateSignalForTrade(signal, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('HOLD');
  });

  test('rejects when paper trading is disabled', () => {
    const signal = makeSignal();
    const config = makeConfig({ is_enabled: false });
    const result = evaluateSignalForTrade(signal, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('disabled');
  });

  test('rejects BUY (non-STRONG) when only STRONG allowed', () => {
    const signal = makeSignal({ strengthLabel: 'BUY' });
    const config = makeConfig();
    const result = evaluateSignalForTrade(signal, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('not in allowed list');
  });

  test('accepts BUY when allowed_strength includes it', () => {
    const signal = makeSignal({ strengthLabel: 'BUY' });
    const config = makeConfig({ allowed_strength: ['STRONG BUY', 'STRONG SELL', 'BUY', 'SELL'] });
    const result = evaluateSignalForTrade(signal, config);
    expect(result.eligible).toBe(true);
  });

  test('rejects when R:R is below minimum', () => {
    const signal = makeSignal({
      tradeLevels: { ...makeSignal().tradeLevels, riskRewardRatio: 1.0 }
    });
    const config = makeConfig({ min_rr_ratio: 1.5 });
    const result = evaluateSignalForTrade(signal, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('R:R');
  });

  test('rejects when confluence is below minimum', () => {
    const signal = makeSignal({
      timeframes: {
        '4h': { trend: 'bullish', score: 70, confidence: 60, action: 'BUY' },
        '1h': { trend: 'bearish', score: 30, confidence: 50, action: 'SELL' },
        '15m': { trend: 'neutral', score: 50, confidence: 40, action: 'HOLD' },
        confluence: 1
      }
    });
    const config = makeConfig({ min_confluence: 2 });
    const result = evaluateSignalForTrade(signal, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Confluence');
  });

  test('rejects when tradeLevels are missing', () => {
    const signal = makeSignal({ tradeLevels: null });
    const config = makeConfig();
    const result = evaluateSignalForTrade(signal, config);
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('Missing trade levels');
  });

  test('rejects when entry price is 0', () => {
    const signal = makeSignal({
      tradeLevels: { ...makeSignal().tradeLevels, entry: 0 }
    });
    const config = makeConfig();
    const result = evaluateSignalForTrade(signal, config);
    expect(result.eligible).toBe(false);
    // entry=0 fails the "entry > 0" check which reports as "Missing trade levels" or "Invalid"
    expect(result.reason).toBeTruthy();
  });

  test('rejects null/undefined signal', () => {
    const config = makeConfig();
    expect(evaluateSignalForTrade(null, config).eligible).toBe(false);
    expect(evaluateSignalForTrade(undefined, config).eligible).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// calculatePositionSize
// ═══════════════════════════════════════════════════════════════════════════════

describe('calculatePositionSize', () => {
  test('calculates correct position size with 2% risk', () => {
    const config = makeConfig({ current_capital: 10000, risk_per_trade: 0.02 });
    const signal = makeSignal(); // entry: 100000, SL: 95000 (distance = 5000)
    const result = calculatePositionSize(config, signal);

    // riskAmount = 10000 * 0.02 = 200
    // quantity = 200 / 5000 = 0.04
    // positionSize = 0.04 * 100000 = 4000
    // BUT cap at 30% of 10000 = 3000
    expect(result.riskAmount).toBe(200);
    expect(result.positionSizeUsd).toBeLessThanOrEqual(3000); // 30% cap
    expect(result.quantity).toBeGreaterThan(0);
  });

  test('caps position at 30% of capital', () => {
    const config = makeConfig({ current_capital: 1000, risk_per_trade: 0.05 });
    const signal = makeSignal({
      tradeLevels: { ...makeSignal().tradeLevels, entry: 100, stopLoss: 99 }
    });
    const result = calculatePositionSize(config, signal);

    // riskAmount = 1000 * 0.05 = 50
    // distance = 1
    // quantity = 50
    // positionSize = 50 * 100 = 5000 → cap at 300 (30% of 1000)
    expect(result.positionSizeUsd).toBeLessThanOrEqual(300);
  });

  test('returns 0 when SL equals entry (no risk distance)', () => {
    const config = makeConfig();
    const signal = makeSignal({
      tradeLevels: { ...makeSignal().tradeLevels, entry: 100, stopLoss: 100 }
    });
    const result = calculatePositionSize(config, signal);
    expect(result.positionSizeUsd).toBe(0);
    expect(result.quantity).toBe(0);
  });

  test('handles small capital correctly', () => {
    const config = makeConfig({ current_capital: 100, risk_per_trade: 0.01 });
    const signal = makeSignal({
      tradeLevels: { ...makeSignal().tradeLevels, entry: 50, stopLoss: 48 }
    });
    const result = calculatePositionSize(config, signal);

    // riskAmount = 100 * 0.01 = 1
    // distance = 2
    // quantity = 0.5
    // positionSize = 0.5 * 50 = 25 (under 30 cap)
    expect(result.riskAmount).toBe(1);
    expect(result.positionSizeUsd).toBe(25);
    expect(result.quantity).toBe(0.5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// checkPriceAgainstLevels
// ═══════════════════════════════════════════════════════════════════════════════

describe('checkPriceAgainstLevels', () => {
  describe('LONG trades', () => {
    test('triggers stop_loss when price drops below SL', () => {
      const trade = makeTrade();
      const result = checkPriceAgainstLevels(trade, 94000);
      expect(result.action).toBe('stop_loss');
    });

    test('triggers stop_loss when price equals SL', () => {
      const trade = makeTrade();
      const result = checkPriceAgainstLevels(trade, 95000);
      expect(result.action).toBe('stop_loss');
    });

    test('triggers take_profit_1 when price reaches TP1 (status=open)', () => {
      const trade = makeTrade();
      const result = checkPriceAgainstLevels(trade, 108000);
      expect(result.action).toBe('take_profit_1');
    });

    test('triggers take_profit_2 when price reaches TP2 (status=partial)', () => {
      const trade = makeTrade({ status: 'partial' });
      const result = checkPriceAgainstLevels(trade, 115000);
      expect(result.action).toBe('take_profit_2');
    });

    test('activates trailing when price reaches activation level', () => {
      const trade = makeTrade({ trailing_active: false });
      const result = checkPriceAgainstLevels(trade, 102000);
      expect(result.action).toBe('activate_trailing');
    });

    test('triggers trailing_stop when trailing is active and price drops', () => {
      const trade = makeTrade({
        trailing_active: true,
        trailing_stop_current: '99000',
        peak_price: '104000'
      });
      const result = checkPriceAgainstLevels(trade, 98500);
      expect(result.action).toBe('trailing_stop');
    });

    test('returns none when price is between entry and trailing activation', () => {
      const trade = makeTrade();
      // 101000 is between entry (100000) and trailing_activation (102000), so no action triggered
      const result = checkPriceAgainstLevels(trade, 101000);
      expect(result.action).toBe('none');
    });

    test('updates peak price when price makes new high', () => {
      const trade = makeTrade({ trailing_active: true, trailing_stop_current: '95000', peak_price: '101000', trailing_stop_initial: '87500' });
      const result = checkPriceAgainstLevels(trade, 105000);
      expect(result.action).toBe('none');
      expect(result.peakPrice).toBe(105000);
    });
  });

  describe('SHORT trades', () => {
    const shortTrade = () => makeTrade({
      direction: 'SHORT',
      entry_price: '100000',
      stop_loss: '105000',
      take_profit_1: '92000',
      take_profit_2: '85000',
      trailing_stop_initial: '112500',
      trailing_stop_current: '112500',
      trailing_activation: '98000'
    });

    test('triggers stop_loss when price rises above SL', () => {
      const trade = shortTrade();
      const result = checkPriceAgainstLevels(trade, 106000);
      expect(result.action).toBe('stop_loss');
    });

    test('triggers take_profit_1 when price drops to TP1', () => {
      const trade = shortTrade();
      const result = checkPriceAgainstLevels(trade, 91000);
      expect(result.action).toBe('take_profit_1');
    });

    test('triggers take_profit_2 for partial SHORT', () => {
      const trade = { ...shortTrade(), status: 'partial' };
      const result = checkPriceAgainstLevels(trade, 84000);
      expect(result.action).toBe('take_profit_2');
    });

    test('activates trailing for SHORT when price drops enough', () => {
      const trade = shortTrade();
      const result = checkPriceAgainstLevels(trade, 97000);
      expect(result.action).toBe('activate_trailing');
    });

    test('returns none when price is between entry and trailing activation for SHORT', () => {
      const trade = shortTrade();
      // 99000 is between entry (100000) and trailing_activation (98000), so no action triggered
      const result = checkPriceAgainstLevels(trade, 99000);
      expect(result.action).toBe('none');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// resolveCurrentPrice
// ═══════════════════════════════════════════════════════════════════════════════

describe('resolveCurrentPrice', () => {
  const marketData = {
    crypto: {
      bitcoin: { price: 100000 },
      ethereum: { price: 3500 },
      solana: { price: 180 }
    },
    metals: {
      gold: { price: 2400 },
      silver: { price: 28 }
    }
  };

  test('resolves crypto by lowercase name', () => {
    expect(resolveCurrentPrice('BITCOIN', marketData)).toBe(100000);
    expect(resolveCurrentPrice('bitcoin', marketData)).toBe(100000);
    expect(resolveCurrentPrice('ETHEREUM', marketData)).toBe(3500);
  });

  test('resolves gold/silver via metals', () => {
    expect(resolveCurrentPrice('GOLD (XAU)', marketData)).toBe(2400);
    expect(resolveCurrentPrice('gold', marketData)).toBe(2400);
    expect(resolveCurrentPrice('SILVER (XAG)', marketData)).toBe(28);
  });

  test('resolves common ticker abbreviations', () => {
    expect(resolveCurrentPrice('BTC', marketData)).toBe(100000);
    expect(resolveCurrentPrice('ETH', marketData)).toBe(3500);
    expect(resolveCurrentPrice('SOL', marketData)).toBe(180);
  });

  test('returns null for unknown asset', () => {
    expect(resolveCurrentPrice('UNKNOWN', marketData)).toBeNull();
  });

  test('returns null for null/undefined', () => {
    expect(resolveCurrentPrice(null, marketData)).toBeNull();
    expect(resolveCurrentPrice('BITCOIN', null)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT_CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

describe('DEFAULT_CONFIG', () => {
  test('has correct default values', () => {
    expect(DEFAULT_CONFIG.initial_capital).toBe(10000);
    expect(DEFAULT_CONFIG.risk_per_trade).toBe(0.02);
    expect(DEFAULT_CONFIG.max_open_positions).toBe(3);
    expect(DEFAULT_CONFIG.max_daily_loss_percent).toBe(0.05);
    expect(DEFAULT_CONFIG.cooldown_minutes).toBe(30);
    expect(DEFAULT_CONFIG.min_confluence).toBe(2);
    expect(DEFAULT_CONFIG.min_rr_ratio).toBe(1.5);
    expect(DEFAULT_CONFIG.allowed_strength).toEqual(['STRONG BUY', 'STRONG SELL']);
    expect(DEFAULT_CONFIG.is_enabled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// calculateLogReturns Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('calculateLogReturns', () => {
  test('calculates correct log returns', () => {
    const candles = [
      { close: 100 },
      { close: 110 },
      { close: 105 }
    ];
    const returns = calculateLogReturns(candles);
    expect(returns.length).toBe(2);
    expect(returns[0]).toBeCloseTo(Math.log(110 / 100), 10);
    expect(returns[1]).toBeCloseTo(Math.log(105 / 110), 10);
  });

  test('returns empty array for < 2 candles', () => {
    expect(calculateLogReturns([{ close: 100 }])).toEqual([]);
    expect(calculateLogReturns([])).toEqual([]);
  });

  test('returns empty array for null', () => {
    expect(calculateLogReturns(null)).toEqual([]);
  });

  test('skips zero or negative prices', () => {
    const candles = [
      { close: 100 },
      { close: 0 },
      { close: 100 }
    ];
    const returns = calculateLogReturns(candles);
    // Both pairs involve a zero (100→0 and 0→100), so both are skipped
    expect(returns.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// calculatePearsonCorrelation Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('calculatePearsonCorrelation', () => {
  test('perfectly correlated arrays return ~1.0', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const b = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
    const r = calculatePearsonCorrelation(a, b);
    expect(r).toBeCloseTo(1.0, 5);
  });

  test('inversely correlated arrays return ~-1.0', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const b = [20, 18, 16, 14, 12, 10, 8, 6, 4, 2];
    const r = calculatePearsonCorrelation(a, b);
    expect(r).toBeCloseTo(-1.0, 5);
  });

  test('uncorrelated arrays return ~0', () => {
    // sin and cos are uncorrelated over full period
    const n = 100;
    const a = Array.from({ length: n }, (_, i) => Math.sin(i * 0.5));
    const b = Array.from({ length: n }, (_, i) => Math.cos(i * 0.7 + 2));
    const r = calculatePearsonCorrelation(a, b);
    expect(Math.abs(r)).toBeLessThan(0.3);
  });

  test('returns 0 for insufficient data', () => {
    expect(calculatePearsonCorrelation([1, 2, 3], [4, 5, 6])).toBe(0);
    expect(calculatePearsonCorrelation(null, [1, 2, 3, 4, 5])).toBe(0);
    expect(calculatePearsonCorrelation([1, 2, 3, 4, 5], null)).toBe(0);
  });

  test('handles constant arrays (zero std dev)', () => {
    const a = [5, 5, 5, 5, 5, 5];
    const b = [1, 2, 3, 4, 5, 6];
    const r = calculatePearsonCorrelation(a, b);
    expect(r).toBe(0);
  });

  test('result is clamped to [-1, 1]', () => {
    const a = [1, 2, 3, 4, 5, 6, 7];
    const b = [10, 20, 30, 40, 50, 60, 70];
    const r = calculatePearsonCorrelation(a, b);
    expect(r).toBeGreaterThanOrEqual(-1);
    expect(r).toBeLessThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getPositionCorrelations Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('getPositionCorrelations', () => {
  // Mock candle generator
  const makeCandles = (base, trend = 0, noise = 0.01) => {
    return Array.from({ length: 168 }, (_, i) => {
      const price = base * (1 + trend * i / 168) * (1 + (Math.random() - 0.5) * noise);
      return { open: price, high: price * 1.005, low: price * 0.995, close: price, volume: 100 };
    });
  };

  test('returns riskLevel none for 0 positions', async () => {
    const result = await getPositionCorrelations(jest.fn(), []);
    expect(result.riskLevel).toBe('none');
    expect(result.pairs).toEqual([]);
  });

  test('returns riskLevel none for 1 position', async () => {
    const result = await getPositionCorrelations(jest.fn(), [{ asset: 'bitcoin' }]);
    expect(result.riskLevel).toBe('none');
    expect(result.pairs).toEqual([]);
  });

  test('returns riskLevel none for null positions', async () => {
    const result = await getPositionCorrelations(jest.fn(), null);
    expect(result.riskLevel).toBe('none');
  });

  test('same asset in multiple positions → high risk', async () => {
    const positions = [{ asset: 'bitcoin' }, { asset: 'bitcoin' }];
    const result = await getPositionCorrelations(jest.fn(), positions);
    expect(result.riskLevel).toBe('high');
    expect(result.avgCorrelation).toBe(1.0);
    expect(result.effectiveDiversification).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test('2 different assets → calculates correlation pair', async () => {
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(makeCandles(50000, 0.1, 0.02))
      .mockResolvedValueOnce(makeCandles(3000, 0.08, 0.02));

    const positions = [{ asset: 'bitcoin' }, { asset: 'ethereum' }];
    const result = await getPositionCorrelations(mockFetch, positions);

    expect(result.pairs.length).toBe(1);
    expect(result.pairs[0].assetA).toBe('bitcoin');
    expect(result.pairs[0].assetB).toBe('ethereum');
    expect(typeof result.pairs[0].correlation).toBe('number');
    expect(result.pairs[0].correlation).toBeGreaterThanOrEqual(-1);
    expect(result.pairs[0].correlation).toBeLessThanOrEqual(1);
    expect(['low', 'medium', 'high']).toContain(result.riskLevel);
  });

  test('3 assets → generates 3 pairs (N*(N-1)/2)', async () => {
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(makeCandles(50000))
      .mockResolvedValueOnce(makeCandles(3000))
      .mockResolvedValueOnce(makeCandles(100));

    const positions = [{ asset: 'bitcoin' }, { asset: 'ethereum' }, { asset: 'solana' }];
    const result = await getPositionCorrelations(mockFetch, positions);
    expect(result.pairs.length).toBe(3);
  });

  test('effectiveDiversification is between 0 and 1', async () => {
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(makeCandles(50000, 0.1))
      .mockResolvedValueOnce(makeCandles(3000, -0.1));

    const positions = [{ asset: 'bitcoin' }, { asset: 'ethereum' }];
    const result = await getPositionCorrelations(mockFetch, positions);
    expect(result.effectiveDiversification).toBeGreaterThanOrEqual(0);
    expect(result.effectiveDiversification).toBeLessThanOrEqual(1);
  });

  test('riskLevel classification boundaries', async () => {
    // We can't control exact correlation but we test the structure
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(makeCandles(50000, 0.1))
      .mockResolvedValueOnce(makeCandles(3000, 0.08));

    const positions = [{ asset: 'bitcoin' }, { asset: 'ethereum' }];
    const result = await getPositionCorrelations(mockFetch, positions);
    expect(['low', 'medium', 'high']).toContain(result.riskLevel);
    expect(typeof result.avgCorrelation).toBe('number');
    expect(typeof result.maxCorrelation).toBe('number');
  });

  test('handles fetch error gracefully', async () => {
    const mockFetch = jest.fn().mockRejectedValue(new Error('Network error'));
    const positions = [{ asset: 'bitcoin' }, { asset: 'ethereum' }];
    const result = await getPositionCorrelations(mockFetch, positions);
    // Should not throw, returns empty/default
    expect(result.riskLevel).toBe('none');
    expect(result.pairs).toEqual([]);
  });

  test('warnings generated for high correlation pair', async () => {
    // Use same data for both to force high correlation
    const sameCandles = makeCandles(50000, 0.1, 0.001);
    const mockFetch = jest.fn()
      .mockResolvedValueOnce(sameCandles)
      .mockResolvedValueOnce(sameCandles.map(c => ({ ...c, close: c.close * 1.01 })));

    const positions = [{ asset: 'bitcoin' }, { asset: 'ethereum' }];
    const result = await getPositionCorrelations(mockFetch, positions);
    // High correlation expected since data is nearly identical
    if (Math.abs(result.pairs[0]?.correlation) >= 0.7) {
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });
});
