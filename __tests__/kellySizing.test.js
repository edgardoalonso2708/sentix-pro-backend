const {
  KELLY_DEFAULTS,
  VOL_DEFAULTS,
  computeKellyFraction,
  computeVolatilityScale,
  buildSizingOptions
} = require('../kellySizing');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate N trades with given win rate and avg P&L amounts */
function generateTrades(count, winRate, avgWin = 100, avgLoss = -50) {
  const trades = [];
  const winCount = Math.round(count * winRate);
  for (let i = 0; i < count; i++) {
    trades.push({ pnl: i < winCount ? avgWin : avgLoss });
  }
  return trades;
}

// ═══════════════════════════════════════════════════════════════════════════════
// computeKellyFraction
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeKellyFraction', () => {
  test('returns applied:true when using defaults (enabled by default)', () => {
    const trades = generateTrades(50, 0.6);
    const result = computeKellyFraction(trades); // no config → defaults (enabled)
    expect(result.applied).toBe(true);
    expect(result.reason).toBe('computed');
  });

  test('returns applied:false when explicitly disabled', () => {
    const trades = generateTrades(50, 0.6);
    const result = computeKellyFraction(trades, { enabled: false });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('kelly_disabled');
  });

  test('returns applied:false with no trades', () => {
    const result = computeKellyFraction([], { enabled: true });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('no_trades');
  });

  test('returns applied:false with null trades', () => {
    const result = computeKellyFraction(null, { enabled: true });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('no_trades');
  });

  test('returns applied:false with insufficient trades', () => {
    const trades = generateTrades(10, 0.6);
    const result = computeKellyFraction(trades, { enabled: true, minTrades: 20 });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('insufficient_trades');
    expect(result.tradeCount).toBe(10);
    expect(result.minTrades).toBe(20);
  });

  test('computes correct Kelly for 60% WR, R=2.0 (quarter-Kelly)', () => {
    // 60% wins at $100, 40% losses at $50 → R = 100/50 = 2.0
    // rawKelly = 0.6 - 0.4/2.0 = 0.6 - 0.2 = 0.4
    // quarterKelly = 0.4 * 0.25 = 0.10 (10%)
    // Clamped to maxRiskPerTrade = 0.02 → 2%
    const trades = generateTrades(100, 0.6, 100, -50);
    const result = computeKellyFraction(trades, { enabled: true });
    expect(result.applied).toBe(true);
    expect(result.reason).toBe('computed');
    expect(result.rawKelly).toBeCloseTo(0.4, 2);
    expect(result.winRate).toBeCloseTo(0.6, 2);
    expect(result.payoffRatio).toBeCloseTo(2.0, 1);
    // quarterKelly = 0.10, but capped at maxRiskPerTrade 0.02
    expect(result.kellyFraction).toBe(0.02);
  });

  test('computes correct Kelly for moderate edge with custom fraction', () => {
    // Use exact counts: 28 wins at $150, 22 losses at -$100 from 50 trades
    // winRate = 28/50 = 0.56, R = 150/100 = 1.5
    // rawKelly = 0.56 - 0.44/1.5 ≈ 0.2667
    // quarterKelly = 0.2667 * 0.25 ≈ 0.0667 → capped to 0.02 (new default max)
    const trades = generateTrades(50, 0.56, 150, -100);
    const result = computeKellyFraction(trades, { enabled: true, fraction: 0.25 });
    expect(result.applied).toBe(true);
    expect(result.rawKelly).toBeGreaterThan(0.2);
    expect(result.kellyFraction).toBe(0.02); // capped at maxRiskPerTrade
  });

  test('computes Kelly within bounds for small edge', () => {
    // 52% WR, R=1.0 → rawKelly = 0.52 - 0.48/1.0 = 0.04
    // quarterKelly = 0.04 * 0.25 = 0.01
    const trades = generateTrades(50, 0.52, 100, -100);
    const result = computeKellyFraction(trades, { enabled: true });
    expect(result.applied).toBe(true);
    expect(result.rawKelly).toBeCloseTo(0.04, 2);
    expect(result.kellyFraction).toBeCloseTo(0.01, 3);
  });

  test('negative edge returns minRiskPerTrade', () => {
    // 40% WR, R=1.0 → rawKelly = 0.4 - 0.6/1.0 = -0.2
    const trades = generateTrades(50, 0.4, 100, -100);
    const result = computeKellyFraction(trades, { enabled: true });
    expect(result.applied).toBe(true);
    expect(result.reason).toBe('negative_edge');
    expect(result.rawKelly).toBeLessThan(0);
    expect(result.kellyFraction).toBe(KELLY_DEFAULTS.minRiskPerTrade);
  });

  test('50% WR with R=1.0 → zero edge → negative_edge', () => {
    // rawKelly = 0.5 - 0.5/1.0 = 0.0
    const trades = generateTrades(50, 0.5, 100, -100);
    const result = computeKellyFraction(trades, { enabled: true });
    expect(result.applied).toBe(true);
    expect(result.reason).toBe('negative_edge');
    expect(result.rawKelly).toBeLessThanOrEqual(0);
  });

  test('all wins (avgLoss=0) returns maxRiskPerTrade', () => {
    const trades = Array.from({ length: 30 }, () => ({ pnl: 100 }));
    const result = computeKellyFraction(trades, { enabled: true });
    expect(result.applied).toBe(true);
    expect(result.reason).toBe('all_wins');
    expect(result.kellyFraction).toBe(KELLY_DEFAULTS.maxRiskPerTrade);
    expect(result.payoffRatio).toBe(Infinity);
  });

  test('respects lookback window', () => {
    // 150 trades: first 50 are losers, last 100 are 70% winners
    const oldTrades = generateTrades(50, 0.0, 100, -100);  // all losses
    const recentTrades = generateTrades(100, 0.7, 100, -50); // 70% WR
    const allTrades = [...oldTrades, ...recentTrades];

    const result = computeKellyFraction(allTrades, { enabled: true, lookbackTrades: 100 });
    expect(result.applied).toBe(true);
    expect(result.tradeCount).toBe(100);
    // Should use recent 100 trades: 70% WR
    expect(result.winRate).toBeCloseTo(0.7, 2);
  });

  test('trades with pnl=0 treated as losses', () => {
    const trades = [
      ...Array.from({ length: 15 }, () => ({ pnl: 100 })),
      ...Array.from({ length: 5 }, () => ({ pnl: 0 })),
      ...Array.from({ length: 10 }, () => ({ pnl: -50 }))
    ];
    const result = computeKellyFraction(trades, { enabled: true, minTrades: 20 });
    expect(result.applied).toBe(true);
    // 15 wins out of 30 = 50% WR (0-pnl trades count as losses)
    expect(result.winRate).toBeCloseTo(0.5, 2);
  });

  test('kellyFraction is clamped to [minRisk, maxRisk]', () => {
    // Very high edge → should be capped
    const trades = generateTrades(50, 0.8, 300, -50);
    const result = computeKellyFraction(trades, {
      enabled: true,
      fraction: 1.0,  // full Kelly
      maxRiskPerTrade: 0.05
    });
    expect(result.applied).toBe(true);
    expect(result.kellyFraction).toBeLessThanOrEqual(0.05);
  });

  test('returns all expected fields for computed result', () => {
    const trades = generateTrades(50, 0.6, 100, -50);
    const result = computeKellyFraction(trades, { enabled: true });
    expect(result).toHaveProperty('applied');
    expect(result).toHaveProperty('reason');
    expect(result).toHaveProperty('kellyFraction');
    expect(result).toHaveProperty('rawKelly');
    expect(result).toHaveProperty('winRate');
    expect(result).toHaveProperty('avgWin');
    expect(result).toHaveProperty('avgLoss');
    expect(result).toHaveProperty('payoffRatio');
    expect(result).toHaveProperty('tradeCount');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// computeVolatilityScale
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeVolatilityScale', () => {
  test('returns applied:false when disabled (default)', () => {
    const result = computeVolatilityScale(3.0);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('vol_targeting_disabled');
    expect(result.volScale).toBe(1.0);
  });

  test('returns applied:false when explicitly disabled', () => {
    const result = computeVolatilityScale(3.0, { enabled: false });
    expect(result.applied).toBe(false);
    expect(result.volScale).toBe(1.0);
  });

  test('scale=1.0 when current ATR equals target', () => {
    const result = computeVolatilityScale(2.0, { enabled: true, targetATRPercent: 2.0 });
    expect(result.applied).toBe(true);
    expect(result.volScale).toBe(1.0);
  });

  test('scales down in high volatility (ATR > target)', () => {
    // target 2%, current 4% → scale = 2/4 = 0.5
    const result = computeVolatilityScale(4.0, { enabled: true, targetATRPercent: 2.0 });
    expect(result.applied).toBe(true);
    expect(result.volScale).toBeCloseTo(0.5, 4);
  });

  test('scales up in low volatility (ATR < target)', () => {
    // target 2%, current 1% → scale = 2/1 = 2.0
    const result = computeVolatilityScale(1.0, { enabled: true, targetATRPercent: 2.0 });
    expect(result.applied).toBe(true);
    expect(result.volScale).toBeCloseTo(2.0, 4);
  });

  test('clamps at minScale for extremely high volatility', () => {
    // target 2%, current 20% → raw = 0.1, clamped to 0.25
    const result = computeVolatilityScale(20.0, { enabled: true, targetATRPercent: 2.0, minScale: 0.25 });
    expect(result.applied).toBe(true);
    expect(result.volScale).toBe(0.25);
  });

  test('clamps at maxScale for extremely low volatility', () => {
    // target 2%, current 0.5% → raw = 4.0, clamped to 2.0
    const result = computeVolatilityScale(0.5, { enabled: true, targetATRPercent: 2.0, maxScale: 2.0 });
    expect(result.applied).toBe(true);
    expect(result.volScale).toBe(2.0);
  });

  test('parses string input correctly', () => {
    const result = computeVolatilityScale("3.45", { enabled: true, targetATRPercent: 2.0 });
    expect(result.applied).toBe(true);
    expect(result.currentATR).toBe(3.45);
    expect(result.volScale).toBeCloseTo(2.0 / 3.45, 3);
  });

  test('returns applied:false for ATR=0', () => {
    const result = computeVolatilityScale(0, { enabled: true });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('invalid_atr');
    expect(result.volScale).toBe(1.0);
  });

  test('returns applied:false for negative ATR', () => {
    const result = computeVolatilityScale(-1.5, { enabled: true });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('invalid_atr');
  });

  test('returns applied:false for NaN ATR', () => {
    const result = computeVolatilityScale("not-a-number", { enabled: true });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('invalid_atr');
  });

  test('returns all expected fields for computed result', () => {
    const result = computeVolatilityScale(3.0, { enabled: true, targetATRPercent: 2.0 });
    expect(result).toHaveProperty('applied', true);
    expect(result).toHaveProperty('reason', 'computed');
    expect(result).toHaveProperty('volScale');
    expect(result).toHaveProperty('currentATR');
    expect(result).toHaveProperty('targetATR');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildSizingOptions
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildSizingOptions', () => {
  test('composes Kelly + Vol correctly when both enabled', () => {
    const trades = generateTrades(50, 0.6, 100, -50);
    const result = buildSizingOptions(trades, 3.0, {
      kelly: { enabled: true },
      volatilityTargeting: { enabled: true, targetATRPercent: 2.0 }
    });
    expect(result.kellyResult.applied).toBe(true);
    expect(result.volResult.applied).toBe(true);
    expect(result.kellyResult.kellyFraction).toBeGreaterThan(0);
    expect(result.volResult.volScale).toBeCloseTo(2.0 / 3.0, 3);
  });

  test('both disabled returns both applied:false', () => {
    const trades = generateTrades(50, 0.6, 100, -50);
    const result = buildSizingOptions(trades, 3.0, {
      kelly: { enabled: false },
      volatilityTargeting: { enabled: false }
    });
    expect(result.kellyResult.applied).toBe(false);
    expect(result.volResult.applied).toBe(false);
  });

  test('Kelly only (no vol config)', () => {
    const trades = generateTrades(50, 0.6, 100, -50);
    const result = buildSizingOptions(trades, 3.0, {
      kelly: { enabled: true }
    });
    expect(result.kellyResult.applied).toBe(true);
    expect(result.volResult.applied).toBe(false);
  });

  test('Vol only (kelly explicitly disabled)', () => {
    const trades = generateTrades(50, 0.6, 100, -50);
    const result = buildSizingOptions(trades, 3.0, {
      kelly: { enabled: false },
      volatilityTargeting: { enabled: true, targetATRPercent: 2.0 }
    });
    expect(result.kellyResult.applied).toBe(false);
    expect(result.volResult.applied).toBe(true);
  });
});
