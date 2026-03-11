// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - STATISTICAL SIGNIFICANCE TESTS
// Hypothesis testing and confidence intervals for backtest validation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Standard normal CDF using Abramowitz & Stegun approximation.
 * Maximum error: |epsilon| < 7.5e-8.
 *
 * @param {number} z - z-score
 * @returns {number} P(Z <= z)
 */
function standardNormalCDF(z) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Regularized incomplete beta function I_x(a, b) using continued fraction (Lentz's method).
 * Used internally for Student's t-distribution CDF.
 *
 * @param {number} x - Value in [0, 1]
 * @param {number} a - Shape parameter a > 0
 * @param {number} b - Shape parameter b > 0
 * @returns {number} I_x(a, b)
 */
function regularizedIncompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // Use symmetry relation if x > (a+1)/(a+b+2) for better convergence
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedIncompleteBeta(1 - x, b, a);
  }

  // Log-beta for normalization: ln(B(a,b))
  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);

  // Prefix: x^a * (1-x)^b / (a * B(a,b))
  const prefix = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lnBeta - Math.log(a));

  // Continued fraction using Lentz's method
  const maxIter = 200;
  const epsilon = 1e-14;
  const tiny = 1e-30;

  let f = 1 + tiny;
  let c = f;
  let d = 0;

  for (let m = 0; m <= maxIter; m++) {
    let numerator;
    if (m === 0) {
      numerator = 1; // a_0 = 1
    } else {
      const k = m;
      const m2 = Math.floor((k + 1) / 2);
      if (k % 2 === 1) {
        // Odd terms: -(a+m2)*(a+b+m2)*x / ((a+2*m2)*(a+2*m2+1))
        numerator = -(a + m2) * (a + b + m2) * x / ((a + 2 * m2) * (a + 2 * m2 + 1));
      } else {
        // Even terms: m2*(b-m2)*x / ((a+2*m2-1)*(a+2*m2))
        numerator = m2 * (b - m2) * x / ((a + 2 * m2 - 1) * (a + 2 * m2));
      }
    }

    d = 1 + numerator * d;
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;

    c = 1 + numerator / c;
    if (Math.abs(c) < tiny) c = tiny;

    const delta = c * d;
    f *= delta;

    if (Math.abs(delta - 1) < epsilon) break;
  }

  return prefix * (f - 1);
}

/**
 * Log-gamma function using Lanczos approximation (g=7, n=9).
 *
 * @param {number} z - Input value > 0
 * @returns {number} ln(Gamma(z))
 */
function lnGamma(z) {
  const g = 7;
  const coeff = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7
  ];

  if (z < 0.5) {
    // Reflection formula
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }

  z -= 1;
  let x = coeff[0];
  for (let i = 1; i < g + 2; i++) {
    x += coeff[i] / (z + i);
  }

  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Student's t-distribution CDF.
 * For df >= 30, uses normal approximation (CLT).
 * For df < 30, uses regularized incomplete beta function.
 *
 * @param {number} t - t-statistic
 * @param {number} df - degrees of freedom (n - 1)
 * @returns {number} P(T <= t)
 */
function studentTCDF(t, df) {
  if (df >= 30) return standardNormalCDF(t);

  if (df <= 0) return 0.5;

  const x = df / (df + t * t);
  const ibeta = regularizedIncompleteBeta(x, df / 2, 0.5);

  // P(T <= t) = 1 - 0.5 * I_x(df/2, 0.5) when t >= 0
  // P(T <= t) = 0.5 * I_x(df/2, 0.5) when t < 0
  return t >= 0 ? 1 - 0.5 * ibeta : 0.5 * ibeta;
}

/**
 * One-sample t-test: H0: mean(values) = mu0.
 * Tests whether the mean of trade P&Ls significantly differs from zero.
 *
 * @param {number[]} values - Sample values (e.g., trade P&Ls)
 * @param {number} [mu0=0] - Hypothesized mean under null hypothesis
 * @returns {{ tStatistic: number, pValue: number, df: number, mean: number, stdErr: number }}
 */
function tTestOneSample(values, mu0 = 0) {
  if (!values || values.length < 2) {
    return { tStatistic: 0, pValue: 1, df: 0, mean: 0, stdErr: 0 };
  }

  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1); // sample variance
  const stdDev = Math.sqrt(variance);
  const stdErr = stdDev / Math.sqrt(n);
  const df = n - 1;

  const tStatistic = stdErr > 0 ? (mean - mu0) / stdErr : 0;

  // Two-tailed p-value
  const pValue = stdErr > 0
    ? 2 * (1 - studentTCDF(Math.abs(tStatistic), df))
    : 1;

  return {
    tStatistic: Math.round(tStatistic * 1000) / 1000,
    pValue: Math.min(1, Math.max(0, Math.round(pValue * 10000) / 10000)),
    df,
    mean: Math.round(mean * 100) / 100,
    stdErr: Math.round(stdErr * 100) / 100
  };
}

/**
 * Two-sided binomial test using normal approximation with continuity correction.
 * H0: p = p0 (win rate equals hypothesized probability).
 *
 * @param {number} successes - Number of wins
 * @param {number} trials - Total number of trades
 * @param {number} [p0=0.5] - Hypothesized win probability under null
 * @returns {{ zStatistic: number, pValue: number, observedRate: number }}
 */
function binomialTest(successes, trials, p0 = 0.5) {
  if (!trials || trials < 1) {
    return { zStatistic: 0, pValue: 1, observedRate: 0 };
  }

  const pHat = successes / trials;
  const se = Math.sqrt(p0 * (1 - p0) / trials);

  // Continuity correction
  const correction = 0.5 / trials;
  const diff = Math.abs(pHat - p0);
  const correctedDiff = Math.max(0, diff - correction);

  const zStatistic = se > 0 ? (correctedDiff / se) * Math.sign(pHat - p0) : 0;

  // Two-tailed p-value
  const pValue = se > 0
    ? 2 * (1 - standardNormalCDF(Math.abs(zStatistic)))
    : 1;

  return {
    zStatistic: Math.round(zStatistic * 1000) / 1000,
    pValue: Math.min(1, Math.max(0, Math.round(pValue * 10000) / 10000)),
    observedRate: Math.round(pHat * 10000) / 100
  };
}

/**
 * Bootstrap p-value: fraction of MC distribution values <= threshold.
 * Used for Sharpe (threshold=0) and profit factor (threshold=1) significance.
 *
 * @param {number[]} distribution - Sorted array of MC path metric values
 * @param {number} [threshold=0] - H0 threshold
 * @returns {{ pValue: number, countBelow: number, total: number }}
 */
function bootstrapPValue(distribution, threshold = 0) {
  if (!distribution || distribution.length === 0) {
    return { pValue: 1, countBelow: 0, total: 0 };
  }

  const countBelow = distribution.filter(v => v <= threshold).length;
  const pValue = countBelow / distribution.length;

  return {
    pValue: Math.round(pValue * 10000) / 10000,
    countBelow,
    total: distribution.length
  };
}

/**
 * Extract labeled confidence intervals from MC percentiles.
 * Uses p2_5/p97_5 for 95% CI and p5/p95 for 90% CI.
 *
 * @param {object} percentiles - MC percentile object (from monteCarloSim)
 * @returns {{ ci90: object, ci95: object } | null}
 */
function computeConfidenceIntervals(percentiles) {
  if (!percentiles) return null;

  const metrics = ['returnPct', 'maxDrawdownPct', 'sharpe', 'winRate', 'finalEquity'];

  const ci90 = {};
  const ci95 = {};

  for (const metric of metrics) {
    ci90[metric] = {
      lower: percentiles.p5?.[metric] ?? null,
      median: percentiles.p50?.[metric] ?? null,
      upper: percentiles.p95?.[metric] ?? null
    };
    ci95[metric] = {
      lower: percentiles.p2_5?.[metric] ?? null,
      median: percentiles.p50?.[metric] ?? null,
      upper: percentiles.p97_5?.[metric] ?? null
    };
  }

  return { ci90, ci95 };
}

/**
 * Combine individual test results into an overall significance assessment.
 * Uses Bonferroni-conservative approach: max primary p-value determines level.
 *
 * @param {object} tests - Individual test p-values
 * @param {number} tradeCount - Number of trades
 * @returns {{ level: string, label: string, stars: number, confidence: number, warnings: string[] }}
 */
function assessSignificance(tests, tradeCount) {
  const { pnlPValue, winRatePValue, sharpePValue, profitFactorPValue } = tests;

  const warnings = [];

  if (tradeCount < 10) {
    warnings.push('Very low trade count (<10): results are unreliable');
  } else if (tradeCount < 30) {
    warnings.push('Low trade count (<30): results may not be reliable');
  }

  // Use max of primary p-values (Bonferroni-conservative)
  const primaryPValues = [pnlPValue, sharpePValue].filter(p => p != null && isFinite(p));

  if (primaryPValues.length === 0) {
    return {
      level: 'insufficient_data',
      label: 'DATOS INSUFICIENTES',
      stars: 0,
      confidence: 0,
      warnings: [...warnings, 'Not enough data for statistical tests']
    };
  }

  const maxPrimary = Math.max(...primaryPValues);

  let level, label, stars;

  if (maxPrimary < 0.001) {
    level = 'highly_significant';
    label = 'ALTAMENTE SIGNIFICATIVO';
    stars = 3;
  } else if (maxPrimary < 0.01) {
    level = 'significant';
    label = 'SIGNIFICATIVO';
    stars = 2;
  } else if (maxPrimary < 0.05) {
    level = 'marginally_significant';
    label = 'MARGINALMENTE SIGNIFICATIVO';
    stars = 1;
  } else {
    level = 'not_significant';
    label = 'NO SIGNIFICATIVO';
    stars = 0;
  }

  return {
    level,
    label,
    stars,
    confidence: Math.round((1 - maxPrimary) * 10000) / 100,
    warnings
  };
}

/**
 * Run all statistical significance tests on backtest results.
 *
 * @param {Array<{pnl: number}>} trades - Completed trades
 * @param {object} monteCarlo - Monte Carlo simulation results (from monteCarloSim)
 * @returns {object} Complete significance analysis
 */
function runStatisticalTests(trades, monteCarlo) {
  if (!trades || trades.length < 2) {
    return {
      pnlTest: null,
      winRateTest: null,
      sharpeTest: null,
      profitFactorTest: null,
      confidenceIntervals: null,
      assessment: {
        level: 'insufficient_data',
        label: 'DATOS INSUFICIENTES',
        stars: 0,
        confidence: 0,
        warnings: ['Need at least 2 trades for statistical analysis']
      }
    };
  }

  // 1. One-sample t-test on trade P&L (H0: mean = 0)
  const pnls = trades.map(t => t.pnl);
  const pnlTest = tTestOneSample(pnls, 0);

  // 2. Binomial test on win rate (H0: p = 0.5)
  const wins = trades.filter(t => t.pnl > 0).length;
  const winRateTest = binomialTest(wins, trades.length, 0.5);

  // 3. Bootstrap p-values from MC distributions
  let sharpeTest = null;
  let profitFactorTest = null;
  let confidenceIntervals = null;

  if (monteCarlo && !monteCarlo.skipped && monteCarlo.percentiles) {
    // Sharpe bootstrap p-value (H0: Sharpe <= 0)
    if (monteCarlo._rawSharpes) {
      sharpeTest = bootstrapPValue(monteCarlo._rawSharpes, 0);
    }

    // Profit factor bootstrap p-value (H0: PF <= 1)
    if (monteCarlo._rawProfitFactors) {
      profitFactorTest = bootstrapPValue(monteCarlo._rawProfitFactors, 1);
    }

    // Confidence intervals from MC percentiles
    confidenceIntervals = computeConfidenceIntervals(monteCarlo.percentiles);
  }

  // 4. Combined assessment
  const assessment = assessSignificance({
    pnlPValue: pnlTest.pValue,
    winRatePValue: winRateTest.pValue,
    sharpePValue: sharpeTest?.pValue ?? null,
    profitFactorPValue: profitFactorTest?.pValue ?? null
  }, trades.length);

  return {
    pnlTest,
    winRateTest,
    sharpeTest,
    profitFactorTest,
    confidenceIntervals,
    assessment
  };
}

module.exports = {
  standardNormalCDF,
  studentTCDF,
  tTestOneSample,
  binomialTest,
  bootstrapPValue,
  computeConfidenceIntervals,
  assessSignificance,
  runStatisticalTests
};
