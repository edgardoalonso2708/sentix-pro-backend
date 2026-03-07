// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - Paper Trading Tests
// Unit tests for pure functions + integration tests
// ═══════════════════════════════════════════════════════════════════════════════

const {
  evaluateSignalForTrade,
  calculatePositionSize,
  checkPriceAgainstLevels,
  resolveCurrentPrice,
  DEFAULT_CONFIG
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
