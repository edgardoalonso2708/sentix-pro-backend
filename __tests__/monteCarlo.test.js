const {
  mulberry32,
  computePathMetrics,
  calculatePercentile,
  buildHistogram,
  buildEquityFan,
  runMonteCarloSimulation
} = require('../monteCarloSim');

// ═══════════════════════════════════════════════════════════════════════════════
// Helper: generate N synthetic trades with known P&L
// ═══════════════════════════════════════════════════════════════════════════════
function makeTrades(pnls) {
  return pnls.map(pnl => ({ pnl, asset: 'BTC', direction: 'LONG' }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// mulberry32 (Seeded PRNG)
// ═══════════════════════════════════════════════════════════════════════════════
describe('mulberry32', () => {
  test('deterministic: same seed produces same sequence', () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(42);
    const seq1 = Array.from({ length: 10 }, () => rng1());
    const seq2 = Array.from({ length: 10 }, () => rng2());
    expect(seq1).toEqual(seq2);
  });

  test('different seeds produce different sequences', () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(99);
    const seq1 = Array.from({ length: 10 }, () => rng1());
    const seq2 = Array.from({ length: 10 }, () => rng2());
    expect(seq1).not.toEqual(seq2);
  });

  test('all values in [0, 1)', () => {
    const rng = mulberry32(123);
    for (let i = 0; i < 10000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// computePathMetrics
// ═══════════════════════════════════════════════════════════════════════════════
describe('computePathMetrics', () => {
  test('correct finalEquity for known trades', () => {
    const trades = makeTrades([100, -50, 200, -30]);
    const result = computePathMetrics(trades, 10000);
    expect(result.finalEquity).toBe(10220);
    expect(result.totalReturn).toBe(220);
  });

  test('totalReturnPct computed correctly', () => {
    const trades = makeTrades([500]); // 5% of 10000
    const result = computePathMetrics(trades, 10000);
    expect(result.totalReturnPct).toBe(5);
  });

  test('maxDrawdown calculated correctly', () => {
    // Start 10000, +500 → 10500 (peak), -800 → 9700 (DD=800), +300 → 10000
    const trades = makeTrades([500, -800, 300]);
    const result = computePathMetrics(trades, 10000);
    expect(result.maxDrawdown).toBe(800);
    // Max DD pct: 800/10500 ≈ 7.62%
    expect(result.maxDrawdownPct).toBeCloseTo(7.62, 0);
  });

  test('winRate correct with known mix', () => {
    const trades = makeTrades([100, -50, 200, -30, 150]); // 3 wins, 2 losses
    const result = computePathMetrics(trades, 10000);
    expect(result.winRate).toBe(60);
  });

  test('sharpe is finite number', () => {
    const trades = makeTrades([100, -50, 200, -30, 150, -80, 60]);
    const result = computePathMetrics(trades, 10000);
    expect(Number.isFinite(result.sharpe)).toBe(true);
  });

  test('all-win trades: 100% win rate', () => {
    const trades = makeTrades([100, 200, 50, 75, 150]);
    const result = computePathMetrics(trades, 10000);
    expect(result.winRate).toBe(100);
    expect(result.maxDrawdown).toBe(0);
  });

  test('all-loss trades: 0% win rate', () => {
    const trades = makeTrades([-100, -200, -50, -75, -150]);
    const result = computePathMetrics(trades, 10000);
    expect(result.winRate).toBe(0);
    expect(result.maxDrawdown).toBeGreaterThan(0);
  });

  test('empty trades: zero everything', () => {
    const result = computePathMetrics([], 10000);
    expect(result.finalEquity).toBe(10000);
    expect(result.totalReturn).toBe(0);
    expect(result.winRate).toBe(0);
    expect(result.maxDrawdown).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// calculatePercentile
// ═══════════════════════════════════════════════════════════════════════════════
describe('calculatePercentile', () => {
  test('empty array returns 0', () => {
    expect(calculatePercentile([], 50)).toBe(0);
  });

  test('single element returns that element', () => {
    expect(calculatePercentile([42], 50)).toBe(42);
    expect(calculatePercentile([42], 0)).toBe(42);
    expect(calculatePercentile([42], 100)).toBe(42);
  });

  test('p50 of sorted array is median', () => {
    expect(calculatePercentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  test('p0 returns first element', () => {
    expect(calculatePercentile([10, 20, 30], 0)).toBe(10);
  });

  test('p100 returns last element', () => {
    expect(calculatePercentile([10, 20, 30], 100)).toBe(30);
  });

  test('interpolates between values', () => {
    // [10, 20] at p50 → 15
    expect(calculatePercentile([10, 20], 50)).toBe(15);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildHistogram
// ═══════════════════════════════════════════════════════════════════════════════
describe('buildHistogram', () => {
  test('empty array returns empty histogram', () => {
    expect(buildHistogram([])).toEqual([]);
  });

  test('bins cover full range', () => {
    const values = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].sort((a, b) => a - b);
    const hist = buildHistogram(values, 5);
    expect(hist.length).toBe(5);
    expect(hist[0].rangeStart).toBe(0);
    expect(hist[hist.length - 1].rangeEnd).toBe(100);
  });

  test('counts sum to total values', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].sort((a, b) => a - b);
    const hist = buildHistogram(values, 5);
    const totalCount = hist.reduce((s, b) => s + b.count, 0);
    expect(totalCount).toBe(10);
  });

  test('frequencies sum to ~100%', () => {
    const values = Array.from({ length: 100 }, (_, i) => i).sort((a, b) => a - b);
    const hist = buildHistogram(values, 10);
    const totalFreq = hist.reduce((s, b) => s + b.frequency, 0);
    expect(totalFreq).toBeCloseTo(100, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildEquityFan
// ═══════════════════════════════════════════════════════════════════════════════
describe('buildEquityFan', () => {
  const trades = makeTrades([100, -50, 200, -30, 150, -80, 60, 120, -40, 90]);

  test('returns array of sample points', () => {
    const fan = buildEquityFan(trades, 10000, 50, 42);
    expect(Array.isArray(fan)).toBe(true);
    expect(fan.length).toBeGreaterThan(2);
  });

  test('first point starts at initialCapital', () => {
    const fan = buildEquityFan(trades, 10000, 50, 42);
    // First point tradeIndex should be 0 and all percentiles should be initialCapital
    expect(fan[0].tradeIndex).toBe(0);
    expect(fan[0].p50).toBe(10000);
  });

  test('p5 <= p50 <= p95 at each point', () => {
    const fan = buildEquityFan(trades, 10000, 100, 42);
    for (const point of fan) {
      expect(point.p5).toBeLessThanOrEqual(point.p50);
      expect(point.p50).toBeLessThanOrEqual(point.p95);
    }
  });

  test('last point tradeIndex equals trade count', () => {
    const fan = buildEquityFan(trades, 10000, 50, 42);
    expect(fan[fan.length - 1].tradeIndex).toBe(trades.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// runMonteCarloSimulation — Guard Clauses
// ═══════════════════════════════════════════════════════════════════════════════
describe('runMonteCarloSimulation — guard clauses', () => {
  test('null trades → skipped', () => {
    const result = runMonteCarloSimulation(null, 10000);
    expect(result.skipped).toBe(true);
    expect(result.simulations).toBe(0);
    expect(result.percentiles).toBeNull();
  });

  test('undefined trades → skipped', () => {
    const result = runMonteCarloSimulation(undefined, 10000);
    expect(result.skipped).toBe(true);
  });

  test('empty array → skipped', () => {
    const result = runMonteCarloSimulation([], 10000);
    expect(result.skipped).toBe(true);
    expect(result.tradeCount).toBe(0);
  });

  test('< 5 trades → skipped with reason', () => {
    const trades = makeTrades([100, -50, 200, -30]);
    const result = runMonteCarloSimulation(trades, 10000);
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('Insufficient trades');
    expect(result.reason).toContain('4');
  });

  test('exactly 5 trades → runs', () => {
    const trades = makeTrades([100, -50, 200, -30, 150]);
    const result = runMonteCarloSimulation(trades, 10000, { simulations: 50 });
    expect(result.skipped).toBe(false);
    expect(result.tradeCount).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// runMonteCarloSimulation — Full Simulation
// ═══════════════════════════════════════════════════════════════════════════════
describe('runMonteCarloSimulation — full', () => {
  // Generate 30 realistic trades: mix of wins and losses
  const pnls = [
    150, -80, 200, -120, 90, -60, 180, -40, 110, -95,
    70, -30, 250, -150, 60, -45, 130, -70, 85, -55,
    190, -100, 75, -35, 160, -90, 140, -65, 95, -50
  ];
  const trades = makeTrades(pnls);
  const capital = 10000;

  test('returns all expected fields', () => {
    const result = runMonteCarloSimulation(trades, capital, { simulations: 100, seed: 42 });
    expect(result).toHaveProperty('simulations', 100);
    expect(result).toHaveProperty('tradeCount', 30);
    expect(result).toHaveProperty('skipped', false);
    expect(result).toHaveProperty('percentiles');
    expect(result).toHaveProperty('riskOfRuin');
    expect(result).toHaveProperty('histogram');
    expect(result).toHaveProperty('equityFan');
    expect(result).toHaveProperty('summary');
  });

  test('deterministic: same seed → same results', () => {
    const r1 = runMonteCarloSimulation(trades, capital, { simulations: 100, seed: 42 });
    const r2 = runMonteCarloSimulation(trades, capital, { simulations: 100, seed: 42 });
    expect(r1.percentiles).toEqual(r2.percentiles);
    expect(r1.summary).toEqual(r2.summary);
    expect(r1.riskOfRuin).toEqual(r2.riskOfRuin);
  });

  test('different seed → different results', () => {
    const r1 = runMonteCarloSimulation(trades, capital, { simulations: 100, seed: 42 });
    const r2 = runMonteCarloSimulation(trades, capital, { simulations: 100, seed: 999 });
    // Very unlikely to be identical with different seeds and enough sims
    expect(r1.summary.medianReturn).not.toBe(r2.summary.medianReturn);
  });

  test('percentiles are monotonically ordered (p5 <= p50 <= p95)', () => {
    const result = runMonteCarloSimulation(trades, capital, { simulations: 500, seed: 42 });
    expect(result.percentiles.p5.returnPct).toBeLessThanOrEqual(result.percentiles.p50.returnPct);
    expect(result.percentiles.p50.returnPct).toBeLessThanOrEqual(result.percentiles.p95.returnPct);
  });

  test('riskOfRuin values are in [0, 100]', () => {
    const result = runMonteCarloSimulation(trades, capital, { simulations: 100, seed: 42 });
    Object.values(result.riskOfRuin).forEach(prob => {
      expect(prob).toBeGreaterThanOrEqual(0);
      expect(prob).toBeLessThanOrEqual(100);
    });
  });

  test('riskOfRuin: higher thresholds have lower or equal probability', () => {
    const result = runMonteCarloSimulation(trades, capital, { simulations: 500, seed: 42 });
    expect(result.riskOfRuin.dd10pct).toBeGreaterThanOrEqual(result.riskOfRuin.dd20pct);
    expect(result.riskOfRuin.dd20pct).toBeGreaterThanOrEqual(result.riskOfRuin.dd30pct);
    expect(result.riskOfRuin.dd30pct).toBeGreaterThanOrEqual(result.riskOfRuin.dd50pct);
  });

  test('histogram bin counts sum to simulation count', () => {
    const result = runMonteCarloSimulation(trades, capital, { simulations: 200, seed: 42 });
    const totalCount = result.histogram.reduce((s, b) => s + b.count, 0);
    expect(totalCount).toBe(200);
  });

  test('profitProbability is in [0, 100]', () => {
    const result = runMonteCarloSimulation(trades, capital, { simulations: 100, seed: 42 });
    expect(result.summary.profitProbability).toBeGreaterThanOrEqual(0);
    expect(result.summary.profitProbability).toBeLessThanOrEqual(100);
  });

  test('equityFan has correct structure', () => {
    const result = runMonteCarloSimulation(trades, capital, { simulations: 100, seed: 42 });
    expect(Array.isArray(result.equityFan)).toBe(true);
    expect(result.equityFan.length).toBeGreaterThan(2);
    // Check first and last points
    expect(result.equityFan[0].tradeIndex).toBe(0);
    expect(result.equityFan[result.equityFan.length - 1].tradeIndex).toBe(trades.length);
    // Check fan ordering at each point
    for (const point of result.equityFan) {
      expect(point.p5).toBeLessThanOrEqual(point.p50);
      expect(point.p50).toBeLessThanOrEqual(point.p95);
    }
  });

  test('summary fields are numbers', () => {
    const result = runMonteCarloSimulation(trades, capital, { simulations: 100, seed: 42 });
    expect(typeof result.summary.medianReturn).toBe('number');
    expect(typeof result.summary.medianDrawdown).toBe('number');
    expect(typeof result.summary.medianSharpe).toBe('number');
    expect(typeof result.summary.worstCase5).toBe('number');
    expect(typeof result.summary.bestCase95).toBe('number');
    expect(typeof result.summary.profitProbability).toBe('number');
  });

  test('percentile table has all requested levels', () => {
    const result = runMonteCarloSimulation(trades, capital, {
      simulations: 100, seed: 42,
      confidenceLevels: [5, 10, 25, 50, 75, 90, 95]
    });
    expect(result.percentiles).toHaveProperty('p5');
    expect(result.percentiles).toHaveProperty('p10');
    expect(result.percentiles).toHaveProperty('p25');
    expect(result.percentiles).toHaveProperty('p50');
    expect(result.percentiles).toHaveProperty('p75');
    expect(result.percentiles).toHaveProperty('p90');
    expect(result.percentiles).toHaveProperty('p95');
    // Each level has all metric fields
    const p50 = result.percentiles.p50;
    expect(p50).toHaveProperty('returnPct');
    expect(p50).toHaveProperty('maxDrawdownPct');
    expect(p50).toHaveProperty('sharpe');
    expect(p50).toHaveProperty('winRate');
    expect(p50).toHaveProperty('finalEquity');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Performance
// ═══════════════════════════════════════════════════════════════════════════════
describe('performance', () => {
  test('1000 sims × 100 trades completes in < 2 seconds', () => {
    const trades = makeTrades(Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? -50 : 100)));
    const start = Date.now();
    const result = runMonteCarloSimulation(trades, 10000, { simulations: 1000, seed: 42 });
    const elapsed = Date.now() - start;
    expect(result.skipped).toBe(false);
    expect(elapsed).toBeLessThan(2000);
  });
});
