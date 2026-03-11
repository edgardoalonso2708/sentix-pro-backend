// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - MONTE CARLO SIMULATION
// Bootstrap resampling for backtest robustness analysis
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mulberry32 — fast, deterministic 32-bit seeded PRNG.
 * Returns a function that produces values in [0, 1).
 *
 * @param {number} seed - Integer seed
 * @returns {() => number} Random number generator
 */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Compute metrics for a single resampled path of trades.
 *
 * @param {Array<{pnl: number}>} trades - Array of trade objects with at least `pnl`
 * @param {number} initialCapital - Starting equity
 * @returns {object} Path metrics: finalEquity, totalReturn, totalReturnPct, maxDrawdown, maxDrawdownPct, winRate, sharpe
 */
function computePathMetrics(trades, initialCapital) {
  let equity = initialCapital;
  let peak = equity;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let wins = 0;
  const returns = [];

  for (const t of trades) {
    const prevEquity = equity;
    equity += t.pnl;
    returns.push(prevEquity > 0 ? t.pnl / prevEquity : 0);
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    const ddPct = peak > 0 ? dd / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
    if (t.pnl > 0) wins++;
  }

  const totalReturn = equity - initialCapital;
  const totalReturnPct = (totalReturn / initialCapital) * 100;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;

  // Sharpe ratio (annualized — assume ~365 trades/year for crypto)
  const meanR = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
  const variance = returns.reduce((s, r) => s + (r - meanR) ** 2, 0) / (returns.length || 1);
  const stdR = Math.sqrt(variance);
  const sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(365) : 0;

  return {
    finalEquity: Math.round(equity * 100) / 100,
    totalReturn: Math.round(totalReturn * 100) / 100,
    totalReturnPct: Math.round(totalReturnPct * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    maxDrawdownPct: Math.round(maxDrawdownPct * 10000) / 100,
    winRate: Math.round(winRate * 100) / 100,
    sharpe: Math.round(sharpe * 100) / 100
  };
}

/**
 * Linear interpolation percentile on a sorted array.
 *
 * @param {number[]} sortedArr - Pre-sorted (ascending) array of numbers
 * @param {number} p - Percentile (0-100)
 * @returns {number}
 */
function calculatePercentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = (p / 100) * (sortedArr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

/**
 * Build a histogram of values into `bins` equal-width buckets.
 *
 * @param {number[]} values - Pre-sorted (ascending) array
 * @param {number} [bins=10] - Number of histogram bins
 * @returns {Array<{rangeStart, rangeEnd, count, frequency}>}
 */
function buildHistogram(values, bins = 10) {
  if (values.length === 0) return [];
  const min = values[0];
  const max = values[values.length - 1];
  const range = max - min || 1;
  const binWidth = range / bins;

  const histogram = Array.from({ length: bins }, (_, i) => ({
    rangeStart: Math.round((min + i * binWidth) * 100) / 100,
    rangeEnd: Math.round((min + (i + 1) * binWidth) * 100) / 100,
    count: 0,
    frequency: 0
  }));

  for (const v of values) {
    let idx = Math.floor((v - min) / binWidth);
    if (idx >= bins) idx = bins - 1;
    histogram[idx].count++;
  }

  histogram.forEach(b => {
    b.frequency = Math.round((b.count / values.length) * 10000) / 100;
  });

  return histogram;
}

/**
 * Build equity fan data: percentile-based equity curves sampled at ~20 points.
 * Used for rendering a "fan chart" showing the spread of possible equity paths.
 *
 * @param {Array<{pnl: number}>} trades
 * @param {number} initialCapital
 * @param {number} [simulations=500]
 * @param {number} [seed=42]
 * @param {number[]} [levels=[5,25,50,75,95]]
 * @returns {Array<{tradeIndex, p5, p25, p50, p75, p95}>}
 */
function buildEquityFan(trades, initialCapital, simulations = 500, seed = 42, levels = [5, 25, 50, 75, 95]) {
  const n = trades.length;
  const samplePoints = 20;
  const step = Math.max(1, Math.floor(n / samplePoints));
  const indices = [];
  for (let i = 0; i <= n; i += step) indices.push(Math.min(i, n));
  if (indices[indices.length - 1] !== n) indices.push(n);

  const rng = mulberry32(seed + 1000); // Different seed to avoid correlation with main sim
  const fanSims = Math.min(simulations, 500); // Cap for performance

  // Collect equity at each sample point across all sims
  const equitiesAtPoints = indices.map(() => []);

  for (let sim = 0; sim < fanSims; sim++) {
    const resampled = [];
    for (let i = 0; i < n; i++) {
      resampled.push(trades[Math.floor(rng() * n)]);
    }

    let equity = initialCapital;
    let pointIdx = 0;
    for (let i = 0; i <= n; i++) {
      if (i > 0) equity += resampled[i - 1].pnl;
      if (pointIdx < indices.length && i === indices[pointIdx]) {
        equitiesAtPoints[pointIdx].push(equity);
        pointIdx++;
      }
    }
  }

  // Compute percentiles at each sample point
  return indices.map((tradeIdx, i) => {
    const sorted = equitiesAtPoints[i].sort((a, b) => a - b);
    const point = { tradeIndex: tradeIdx };
    for (const p of levels) {
      point[`p${p}`] = Math.round(calculatePercentile(sorted, p) * 100) / 100;
    }
    return point;
  });
}

/**
 * Run Monte Carlo bootstrap resampling simulation on backtest trades.
 *
 * Resamples `trades` with replacement for `simulations` iterations,
 * computing per-path metrics and aggregating into percentile distributions.
 *
 * @param {Array<{pnl: number}>} trades - Completed backtest trades
 * @param {number} initialCapital - Starting capital
 * @param {object} [options]
 * @param {number} [options.simulations=1000] - Number of MC paths
 * @param {number} [options.seed=42] - PRNG seed for reproducibility
 * @param {number[]} [options.confidenceLevels=[5,10,25,50,75,90,95]] - Percentiles to compute
 * @returns {object} Monte Carlo results with percentiles, riskOfRuin, histogram, equityFan, summary
 */
function runMonteCarloSimulation(trades, initialCapital, options = {}) {
  const {
    simulations = 1000,
    seed = 42,
    confidenceLevels = [5, 10, 25, 50, 75, 90, 95]
  } = options;

  // Guard: need minimum trades for meaningful simulation
  if (!trades || trades.length < 5) {
    return {
      simulations: 0,
      tradeCount: trades?.length || 0,
      skipped: true,
      reason: `Insufficient trades (${trades?.length || 0}, need >= 5)`,
      percentiles: null,
      riskOfRuin: null,
      histogram: null,
      equityFan: null,
      summary: null
    };
  }

  const rng = mulberry32(seed);
  const n = trades.length;

  // Run M simulations via bootstrap resampling
  const pathResults = [];
  for (let sim = 0; sim < simulations; sim++) {
    // Resample N trades with replacement
    const resampled = [];
    for (let i = 0; i < n; i++) {
      resampled.push(trades[Math.floor(rng() * n)]);
    }
    pathResults.push(computePathMetrics(resampled, initialCapital));
  }

  // Sort metric arrays for percentile computation
  const returns = pathResults.map(p => p.totalReturnPct).sort((a, b) => a - b);
  const drawdowns = pathResults.map(p => p.maxDrawdownPct).sort((a, b) => a - b);
  const sharpes = pathResults.map(p => p.sharpe).sort((a, b) => a - b);
  const winRates = pathResults.map(p => p.winRate).sort((a, b) => a - b);
  const finalEquities = pathResults.map(p => p.finalEquity).sort((a, b) => a - b);

  // Build percentile tables
  const percentiles = {};
  for (const p of confidenceLevels) {
    percentiles[`p${p}`] = {
      returnPct: Math.round(calculatePercentile(returns, p) * 100) / 100,
      maxDrawdownPct: Math.round(calculatePercentile(drawdowns, p) * 100) / 100,
      sharpe: Math.round(calculatePercentile(sharpes, p) * 100) / 100,
      winRate: Math.round(calculatePercentile(winRates, p) * 100) / 100,
      finalEquity: Math.round(calculatePercentile(finalEquities, p) * 100) / 100
    };
  }

  // Risk of ruin: % of paths that experienced > X% drawdown
  const ruinThresholds = [10, 20, 30, 50];
  const riskOfRuin = {};
  for (const threshold of ruinThresholds) {
    const ruinCount = pathResults.filter(p => p.maxDrawdownPct >= threshold).length;
    riskOfRuin[`dd${threshold}pct`] = Math.round((ruinCount / simulations) * 10000) / 100;
  }

  // P&L histogram (10 bins)
  const histogram = buildHistogram(returns, 10);

  // Equity fan chart data
  const equityFan = buildEquityFan(trades, initialCapital, simulations, seed, [5, 25, 50, 75, 95]);

  return {
    simulations,
    tradeCount: n,
    skipped: false,
    percentiles,
    riskOfRuin,
    histogram,
    equityFan,
    summary: {
      medianReturn: percentiles.p50.returnPct,
      medianDrawdown: percentiles.p50.maxDrawdownPct,
      medianSharpe: percentiles.p50.sharpe,
      worstCase5: percentiles.p5.returnPct,
      bestCase95: percentiles.p95.returnPct,
      profitProbability: Math.round((returns.filter(r => r > 0).length / simulations) * 10000) / 100
    }
  };
}

module.exports = {
  mulberry32,
  computePathMetrics,
  calculatePercentile,
  buildHistogram,
  buildEquityFan,
  runMonteCarloSimulation
};
