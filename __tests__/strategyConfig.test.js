const {
  DEFAULT_STRATEGY_CONFIG,
  PARAM_RANGES,
  mergeConfig
} = require('../strategyConfig');

// ═══════════════════════════════════════════════════════════════════════════════
// mergeConfig Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('mergeConfig', () => {
  test('returns defaults when called with no arguments', () => {
    const cfg = mergeConfig();
    expect(cfg).toEqual(DEFAULT_STRATEGY_CONFIG);
  });

  test('returns defaults when called with empty object', () => {
    const cfg = mergeConfig({});
    expect(cfg).toEqual(DEFAULT_STRATEGY_CONFIG);
  });

  test('returns defaults when called with null', () => {
    const cfg = mergeConfig(null);
    // null spreads as empty, so should equal defaults
    expect(cfg).toEqual(DEFAULT_STRATEGY_CONFIG);
  });

  test('returns defaults when called with undefined', () => {
    const cfg = mergeConfig(undefined);
    expect(cfg).toEqual(DEFAULT_STRATEGY_CONFIG);
  });

  test('overrides a single parameter', () => {
    const cfg = mergeConfig({ rsiPeriod: 21 });
    expect(cfg.rsiPeriod).toBe(21);
    // All other values should remain default
    expect(cfg.buyThreshold).toBe(DEFAULT_STRATEGY_CONFIG.buyThreshold);
    expect(cfg.confidenceCap).toBe(DEFAULT_STRATEGY_CONFIG.confidenceCap);
  });

  test('overrides multiple parameters', () => {
    const overrides = {
      rsiOversold: 25,
      rsiOverbought: 75,
      buyThreshold: 30,
      sellThreshold: -30
    };
    const cfg = mergeConfig(overrides);
    expect(cfg.rsiOversold).toBe(25);
    expect(cfg.rsiOverbought).toBe(75);
    expect(cfg.buyThreshold).toBe(30);
    expect(cfg.sellThreshold).toBe(-30);
    // Unmodified params stay default
    expect(cfg.rsiPeriod).toBe(DEFAULT_STRATEGY_CONFIG.rsiPeriod);
  });

  test('does not mutate the original DEFAULT_STRATEGY_CONFIG', () => {
    const originalBuyThreshold = DEFAULT_STRATEGY_CONFIG.buyThreshold;
    const cfg = mergeConfig({ buyThreshold: 999 });
    expect(cfg.buyThreshold).toBe(999);
    expect(DEFAULT_STRATEGY_CONFIG.buyThreshold).toBe(originalBuyThreshold);
  });

  test('allows adding new keys not in defaults', () => {
    const cfg = mergeConfig({ customParam: 42 });
    expect(cfg.customParam).toBe(42);
    // Defaults still present
    expect(cfg.rsiPeriod).toBe(DEFAULT_STRATEGY_CONFIG.rsiPeriod);
  });

  test('returns a new object each time (no shared reference)', () => {
    const cfg1 = mergeConfig();
    const cfg2 = mergeConfig();
    expect(cfg1).not.toBe(cfg2);
    expect(cfg1).toEqual(cfg2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT_STRATEGY_CONFIG Integrity Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('DEFAULT_STRATEGY_CONFIG', () => {
  // ─── Required Keys ──────────────────────────────────────────────────
  const expectedKeys = [
    // Indicator periods
    'rsiPeriod', 'emaPeriods', 'adxPeriod', 'macdFast', 'macdSlow',
    'macdSignal', 'bbPeriod', 'bbStdDev', 'atrPeriod', 'divergenceLookback',
    'volumeLookback',
    // Scoring weights
    'trendScoreStrong', 'trendScoreModerate', 'rsiExtremeScore', 'rsiStrongScore',
    'rsiPullbackScore', 'macdStrongScore', 'macdWeakScore', 'divergenceBaseScore',
    'divergenceMaxScore', 'bbOuterScore', 'bbNearScore', 'srScore',
    'srClusterThreshold', 'srSwingLookback', 'srMaxLevels', 'srZoneStrengthBonus',
    'momentumScore', 'fearGreedScore', 'derivativesScore', 'btcDomScore', 'dxyScore',
    'orderBookScore',
    // Ichimoku
    'ichimokuTenkanPeriod', 'ichimokuKijunPeriod', 'ichimokuSenkouBPeriod',
    'ichimokuDisplacement', 'ichimokuScore',
    // VWAP
    'vwapSessionLength', 'vwapScore', 'vwapBandStdDev',
    // Fibonacci
    'fibSwingLookback', 'fibScore', 'fibGoldenRatioBonus',
    // Market Structure
    'marketStructureLookback', 'marketStructureScore', 'marketStructureMinSwings',
    // ADX thresholds
    'adxStrongThreshold', 'adxModerateThreshold', 'adxStrongMultiplier', 'adxWeakMultiplier',
    // RSI thresholds
    'rsiExtremeOversold', 'rsiOversold', 'rsiPullbackZone', 'rsiPullbackZoneHigh',
    'rsiOverbought', 'rsiExtremeOverbought',
    // Action thresholds
    'buyThreshold', 'buyWeakThreshold', 'sellThreshold', 'sellWeakThreshold',
    'weakConfidenceMin',
    // Confidence
    'confidenceCap', 'multiFactorBonus', 'conflictPenalty',
    // Trade levels
    'atrStopMult', 'atrTP2Mult', 'atrTrailingMult', 'atrTrailingActivation', 'minRiskReward',
    // Multi-timeframe
    'tf4hWeight', 'tf1hWeight', 'tf15mWeight', 'strongConfluenceMult',
    'moderateConfluenceBonus', 'conflictingMult', 'governorMult',
    // Dynamic TF weights
    'dynamicTFWeightsEnabled', 'tfTrending4hWeight', 'tfTrending1hWeight',
    'tfTrending15mWeight', 'tfRanging4hWeight', 'tfRanging1hWeight', 'tfRanging15mWeight',
    // Position sizing
    'riskPerTrade', 'maxPositionPct', 'maxOpenPositions', 'dailyLossLimit',
    // Macro thresholds
    'btcDomThreshold', 'dxyStrongThreshold', 'dxyWeakThreshold', 'fundingRateExtreme',
    // Strength labels
    'strongBuyMinScore', 'strongBuyMinConf', 'buyMinScore', 'buyMinConf'
  ];

  test.each(expectedKeys)('has key: %s', (key) => {
    expect(DEFAULT_STRATEGY_CONFIG).toHaveProperty(key);
  });

  test('all values are defined (not null or undefined)', () => {
    for (const [key, value] of Object.entries(DEFAULT_STRATEGY_CONFIG)) {
      expect(value).not.toBeNull();
      expect(value).not.toBeUndefined();
    }
  });

  // ─── Type checks ───────────────────────────────────────────────────
  test('emaPeriods is an array of numbers', () => {
    expect(Array.isArray(DEFAULT_STRATEGY_CONFIG.emaPeriods)).toBe(true);
    expect(DEFAULT_STRATEGY_CONFIG.emaPeriods.length).toBeGreaterThan(0);
    DEFAULT_STRATEGY_CONFIG.emaPeriods.forEach(p => {
      expect(typeof p).toBe('number');
      expect(p).toBeGreaterThan(0);
    });
  });

  test('all numeric config values are finite numbers', () => {
    for (const [key, value] of Object.entries(DEFAULT_STRATEGY_CONFIG)) {
      if (key === 'emaPeriods') continue; // array, tested separately
      expect(typeof value).toBe('number');
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  // ─── Value Sanity Checks ──────────────────────────────────────────
  test('RSI thresholds are ordered correctly', () => {
    const cfg = DEFAULT_STRATEGY_CONFIG;
    expect(cfg.rsiExtremeOversold).toBeLessThan(cfg.rsiOversold);
    expect(cfg.rsiOversold).toBeLessThan(cfg.rsiPullbackZone);
    expect(cfg.rsiPullbackZone).toBeLessThan(cfg.rsiPullbackZoneHigh);
    expect(cfg.rsiPullbackZoneHigh).toBeLessThan(cfg.rsiOverbought);
    expect(cfg.rsiOverbought).toBeLessThan(cfg.rsiExtremeOverbought);
  });

  test('RSI thresholds are within 0-100 range', () => {
    const rsiKeys = [
      'rsiExtremeOversold', 'rsiOversold', 'rsiPullbackZone',
      'rsiPullbackZoneHigh', 'rsiOverbought', 'rsiExtremeOverbought'
    ];
    rsiKeys.forEach(key => {
      expect(DEFAULT_STRATEGY_CONFIG[key]).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_STRATEGY_CONFIG[key]).toBeLessThanOrEqual(100);
    });
  });

  test('buy/sell thresholds have correct polarity', () => {
    expect(DEFAULT_STRATEGY_CONFIG.buyThreshold).toBeGreaterThan(0);
    expect(DEFAULT_STRATEGY_CONFIG.buyWeakThreshold).toBeGreaterThan(0);
    expect(DEFAULT_STRATEGY_CONFIG.sellThreshold).toBeLessThan(0);
    expect(DEFAULT_STRATEGY_CONFIG.sellWeakThreshold).toBeLessThan(0);
    expect(DEFAULT_STRATEGY_CONFIG.buyWeakThreshold).toBeLessThan(DEFAULT_STRATEGY_CONFIG.buyThreshold);
    expect(DEFAULT_STRATEGY_CONFIG.sellWeakThreshold).toBeGreaterThan(DEFAULT_STRATEGY_CONFIG.sellThreshold);
  });

  test('multi-TF weights sum to 1.0', () => {
    const sum = DEFAULT_STRATEGY_CONFIG.tf4hWeight +
                DEFAULT_STRATEGY_CONFIG.tf1hWeight +
                DEFAULT_STRATEGY_CONFIG.tf15mWeight;
    expect(sum).toBeCloseTo(1.0, 5);
  });

  test('multipliers are positive', () => {
    const mults = [
      'adxStrongMultiplier', 'adxWeakMultiplier', 'strongConfluenceMult',
      'conflictingMult', 'governorMult'
    ];
    mults.forEach(key => {
      expect(DEFAULT_STRATEGY_CONFIG[key]).toBeGreaterThan(0);
    });
  });

  test('risk parameters are within sensible ranges', () => {
    expect(DEFAULT_STRATEGY_CONFIG.riskPerTrade).toBeGreaterThan(0);
    expect(DEFAULT_STRATEGY_CONFIG.riskPerTrade).toBeLessThanOrEqual(0.10);
    expect(DEFAULT_STRATEGY_CONFIG.maxPositionPct).toBeGreaterThan(0);
    expect(DEFAULT_STRATEGY_CONFIG.maxPositionPct).toBeLessThanOrEqual(1.0);
    expect(DEFAULT_STRATEGY_CONFIG.dailyLossLimit).toBeGreaterThan(0);
    expect(DEFAULT_STRATEGY_CONFIG.dailyLossLimit).toBeLessThanOrEqual(0.20);
  });

  test('confidenceCap is between 50 and 100', () => {
    expect(DEFAULT_STRATEGY_CONFIG.confidenceCap).toBeGreaterThanOrEqual(50);
    expect(DEFAULT_STRATEGY_CONFIG.confidenceCap).toBeLessThanOrEqual(100);
  });

  test('MACD periods: fast < slow', () => {
    expect(DEFAULT_STRATEGY_CONFIG.macdFast).toBeLessThan(DEFAULT_STRATEGY_CONFIG.macdSlow);
  });

  test('ATR multipliers are positive', () => {
    expect(DEFAULT_STRATEGY_CONFIG.atrStopMult).toBeGreaterThan(0);
    expect(DEFAULT_STRATEGY_CONFIG.atrTP2Mult).toBeGreaterThan(0);
    expect(DEFAULT_STRATEGY_CONFIG.atrTrailingMult).toBeGreaterThan(0);
    expect(DEFAULT_STRATEGY_CONFIG.atrTrailingActivation).toBeGreaterThan(0);
    expect(DEFAULT_STRATEGY_CONFIG.minRiskReward).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PARAM_RANGES Validation Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('PARAM_RANGES', () => {
  const paramNames = Object.keys(PARAM_RANGES);

  test('has at least 10 optimizable parameters', () => {
    expect(paramNames.length).toBeGreaterThanOrEqual(10);
  });

  test.each(paramNames)('%s exists in DEFAULT_STRATEGY_CONFIG', (paramName) => {
    expect(DEFAULT_STRATEGY_CONFIG).toHaveProperty(paramName);
  });

  test.each(paramNames)('%s has required fields (min, max, step, label, description)', (paramName) => {
    const range = PARAM_RANGES[paramName];
    expect(range).toHaveProperty('min');
    expect(range).toHaveProperty('max');
    expect(range).toHaveProperty('step');
    expect(range).toHaveProperty('label');
    expect(range).toHaveProperty('description');
    expect(typeof range.min).toBe('number');
    expect(typeof range.max).toBe('number');
    expect(typeof range.step).toBe('number');
    expect(typeof range.label).toBe('string');
    expect(typeof range.description).toBe('string');
  });

  test.each(paramNames)('%s has min < max', (paramName) => {
    const range = PARAM_RANGES[paramName];
    expect(range.min).toBeLessThan(range.max);
  });

  test.each(paramNames)('%s has step > 0', (paramName) => {
    const range = PARAM_RANGES[paramName];
    expect(range.step).toBeGreaterThan(0);
  });

  test.each(paramNames)('%s step fits within range (does not exceed max-min)', (paramName) => {
    const range = PARAM_RANGES[paramName];
    expect(range.step).toBeLessThanOrEqual(range.max - range.min);
  });

  test.each(paramNames)('%s default value is within [min, max] range', (paramName) => {
    const range = PARAM_RANGES[paramName];
    const defaultVal = DEFAULT_STRATEGY_CONFIG[paramName];
    expect(defaultVal).toBeGreaterThanOrEqual(range.min);
    expect(defaultVal).toBeLessThanOrEqual(range.max);
  });

  test.each(paramNames)('%s generates a reasonable number of test values (2-50)', (paramName) => {
    const range = PARAM_RANGES[paramName];
    const count = Math.floor((range.max - range.min) / range.step) + 1;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count).toBeLessThanOrEqual(50);
  });

  test.each(paramNames)('%s label is non-empty', (paramName) => {
    expect(PARAM_RANGES[paramName].label.length).toBeGreaterThan(0);
  });

  test.each(paramNames)('%s description is non-empty', (paramName) => {
    expect(PARAM_RANGES[paramName].description.length).toBeGreaterThan(0);
  });
});
