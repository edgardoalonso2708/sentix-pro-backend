// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - STRATEGY OPTIMIZER
// Grid search engine that tests parameter variations against historical data
// Uses the backtester to evaluate each config and ranks by Sharpe ratio
// Walk-forward validation (70/30 train/test) to detect overfitting
// ═══════════════════════════════════════════════════════════════════════════════

const { logger } = require('./logger');
const { fetchAllTimeframes, runBacktest } = require('./backtester');
const { DEFAULT_STRATEGY_CONFIG, PARAM_RANGES, mergeConfig } = require('./strategyConfig');

// ─── In-flight job tracking ──────────────────────────────────────────────────
const activeJobs = new Map();

/**
 * Generate all values for a parameter range
 * @param {Object} range - { min, max, step }
 * @returns {Array<number>} Array of values to test
 */
function generateParamValues(range) {
  const values = [];
  for (let v = range.min; v <= range.max + (range.step / 10); v += range.step) {
    values.push(Math.round(v * 1000) / 1000); // Avoid float precision issues
  }
  return values;
}

// ─── Walk-Forward Validation Helpers ─────────────────────────────────────────

/**
 * Split pre-loaded candle arrays into train and test sets.
 * Train = candles up to splitTimestamp (truncated → backtester stops naturally).
 * Test  = ALL candles (warm-up before T_split provides indicator lookback).
 *
 * @param {Object} candles - { '1h': [], '4h': [], '15m': [] }
 * @param {number} splitTimestamp - Unix ms timestamp for the train/test boundary
 * @returns {{ train: Object, test: Object, splitInfo: Object }}
 */
function splitCandlesByTimestamp(candles, splitTimestamp) {
  const train = {};
  const splitInfo = {};

  for (const tf of ['1h', '4h', '15m']) {
    const arr = candles[tf] || [];
    const trainCandles = arr.filter(c => c.timestamp <= splitTimestamp);
    train[tf] = trainCandles;
    splitInfo[tf] = { total: arr.length, trainCount: trainCandles.length };
  }

  // Test uses FULL candles — backtester handles window via `days` param,
  // candles before T_split serve as indicator warm-up
  return { train, test: candles, splitInfo };
}

/**
 * Compute the train/test split parameters.
 *
 * @param {number} days - Total historical days requested
 * @param {number} [trainRatio=0.7] - Fraction for training (default 70%)
 * @returns {{ validationEnabled, splitTimestamp?, trainDays, testDays, trainRatio?, reason? }}
 */
function computeValidationSplit(days, trainRatio = 0.7) {
  const MIN_DAYS_FOR_VALIDATION = 30;
  const MIN_TRAIN_DAYS = 20;

  if (days < MIN_DAYS_FOR_VALIDATION) {
    return {
      validationEnabled: false,
      trainDays: days,
      testDays: 0,
      reason: `Validación requiere >= ${MIN_DAYS_FOR_VALIDATION} días (tienes ${days})`
    };
  }

  const trainDays = Math.round(days * trainRatio);
  const testDays = days - trainDays;

  if (trainDays < MIN_TRAIN_DAYS) {
    return {
      validationEnabled: false,
      trainDays: days,
      testDays: 0,
      reason: `Train period muy corto: ${trainDays} días (mínimo ${MIN_TRAIN_DAYS})`
    };
  }

  const splitTimestamp = Date.now() - (testDays * 24 * 60 * 60 * 1000);

  return {
    validationEnabled: true,
    splitTimestamp,
    trainDays,
    testDays,
    trainRatio
  };
}

/**
 * Compute overfitting diagnostics from IS and OOS paired results.
 * - avgDegradation: mean of (1 - OOS_sharpe / IS_sharpe) across valid results
 * - rankCorrelation: Spearman rank correlation between IS and OOS rankings
 * - overfitWarning: true if degradation > 50% OR rank correlation < 0.3
 *
 * @param {Array} results - Array with .inSample and .outOfSample metrics
 * @returns {Object} { avgDegradation, rankCorrelation, overfitWarning, overfitSeverity, details }
 */
function computeOverfitMetrics(results) {
  const valid = results.filter(r =>
    r.inSample && r.inSample.sharpe > 0 &&
    r.outOfSample && !r.outOfSample.error && r.outOfSample.sharpe !== -999
  );

  if (!valid.length) {
    return {
      avgDegradation: null,
      rankCorrelation: null,
      overfitWarning: false,
      overfitSeverity: 'low',
      details: 'Sin datos pareados suficientes para análisis de overfitting'
    };
  }

  // Average degradation: 1 - (OOS / IS)
  const degradations = valid.map(r => 1 - (r.outOfSample.sharpe / r.inSample.sharpe));
  const avgDeg = degradations.reduce((s, d) => s + d, 0) / degradations.length;

  // Spearman rank correlation: do IS-best params also rank well OOS?
  const isSorted = [...valid].sort((a, b) => b.inSample.sharpe - a.inSample.sharpe);
  const oosSorted = [...valid].sort((a, b) => b.outOfSample.sharpe - a.outOfSample.sharpe);
  const isRank = new Map(isSorted.map((r, i) => [r.value, i]));
  const oosRank = new Map(oosSorted.map((r, i) => [r.value, i]));

  const n = valid.length;
  let d2Sum = 0;
  for (const r of valid) {
    const d = (isRank.get(r.value) || 0) - (oosRank.get(r.value) || 0);
    d2Sum += d * d;
  }
  const rankCorr = n > 1 ? 1 - (6 * d2Sum) / (n * (n * n - 1)) : 0;

  const warn = avgDeg > 0.5 || rankCorr < 0.3;

  return {
    avgDegradation: Math.round(avgDeg * 100) / 100,
    rankCorrelation: Math.round(rankCorr * 100) / 100,
    overfitWarning: warn,
    overfitSeverity: avgDeg > 0.7 ? 'high' : avgDeg > 0.4 ? 'moderate' : 'low',
    details: warn
      ? 'Alta degradación OOS sugiere sobreajuste — los parámetros podrían no generalizar'
      : 'Rendimiento OOS consistente con IS — baja probabilidad de sobreajuste'
  };
}

/**
 * Extract metrics from a backtest result into a flat object.
 * @param {Object} backtestResult - Result from runBacktest
 * @returns {Object} Flat metrics object
 */
function extractMetrics(backtestResult) {
  const m = backtestResult.metrics;
  return {
    sharpe: m.sharpeRatio,
    sortino: m.sortinoRatio || 0,
    calmar: m.calmarRatio || 0,
    expectancy: m.expectancy || 0,
    profitFactor: m.profitFactor,
    winRate: m.winRate,
    totalTrades: m.totalTrades,
    totalPnl: m.totalPnl,
    totalPnlPercent: m.totalPnlPercent,
    maxDrawdownPercent: m.maxDrawdownPercent,
    avgHoldingBars: m.avgHoldingBars,
    maxConsecutiveLosses: m.maxConsecutiveLosses,
    statisticallySignificant: m.statisticallySignificant
  };
}

/**
 * Create a failed-metric placeholder for errored backtest steps.
 * @param {string} errorMsg - Error message
 * @returns {Object} Metrics object with error flag
 */
function errorMetrics(errorMsg) {
  return {
    sharpe: -999, sortino: 0, calmar: 0, expectancy: 0,
    profitFactor: 0, winRate: 0, totalTrades: 0,
    totalPnl: 0, totalPnlPercent: 0, maxDrawdownPercent: 0,
    avgHoldingBars: 0, maxConsecutiveLosses: 0,
    statisticallySignificant: false,
    error: errorMsg
  };
}

// ─── Main Optimization Engine ────────────────────────────────────────────────

/**
 * Run a single-parameter grid search optimization with walk-forward validation.
 *
 * When days >= 30, splits data into 70% train / 30% test:
 *   1. Grid search on train period (in-sample)
 *   2. Validate each value on test period (out-of-sample)
 *   3. Rank by OOS Sharpe to resist overfitting
 *   4. Compute overfitting diagnostics (degradation, rank correlation)
 *
 * When days < 30, runs classic full-period optimization (backward compatible).
 *
 * @param {Object} options
 * @param {string} options.asset - CoinGecko asset ID (e.g., 'bitcoin')
 * @param {number} options.days - Historical days to backtest
 * @param {string} options.paramName - Key from PARAM_RANGES to optimize
 * @param {Object} [options.baseConfig] - Base strategy config (overrides defaults)
 * @param {number} [options.capital] - Starting capital (default 10000)
 * @param {string} [options.jobId] - Job ID for progress tracking
 * @param {Function} [options.onProgress] - Progress callback
 * @returns {Promise<Object>} Optimization results with validation metrics
 */
async function runOptimization(options) {
  const {
    asset = 'bitcoin',
    days = 30,
    paramName,
    baseConfig = {},
    capital = 10000,
    jobId = null,
    onProgress = null
  } = options;

  const startTime = Date.now();

  // Validate parameter
  const paramRange = PARAM_RANGES[paramName];
  if (!paramRange) {
    throw new Error(`Unknown parameter: ${paramName}. Available: ${Object.keys(PARAM_RANGES).join(', ')}`);
  }

  const testValues = generateParamValues(paramRange);

  logger.info('Starting optimization', {
    asset, days, paramName,
    values: testValues.length,
    range: `${paramRange.min} → ${paramRange.max} (step ${paramRange.step})`
  });

  // Update job status
  if (jobId && activeJobs.has(jobId)) {
    activeJobs.get(jobId).status = 'fetching';
    activeJobs.get(jobId).message = 'Descargando datos históricos...';
  }

  if (onProgress) onProgress({ phase: 'fetching', message: 'Descargando datos históricos...' });

  // ─── 1. Pre-fetch candles ONCE ────────────────────────────────────────
  const preloadedCandles = await fetchAllTimeframes(asset, days);

  logger.info('Candles pre-loaded for optimization', {
    '1h': preloadedCandles['1h']?.length,
    '4h': preloadedCandles['4h']?.length,
    '15m': preloadedCandles['15m']?.length
  });

  // ─── 2. Compute validation split ──────────────────────────────────────
  const split = computeValidationSplit(days);
  let trainCandles, testCandlesFull;

  if (split.validationEnabled) {
    const splitResult = splitCandlesByTimestamp(preloadedCandles, split.splitTimestamp);
    trainCandles = splitResult.train;
    testCandlesFull = splitResult.test;

    logger.info('Walk-forward validation enabled', {
      trainDays: split.trainDays,
      testDays: split.testDays,
      splitDate: new Date(split.splitTimestamp).toISOString(),
      trainCandles1h: trainCandles['1h'].length,
      testCandles1h: testCandlesFull['1h'].length
    });
  }

  // ─── 3. Grid search: In-Sample (train or full period) ────────────────
  let results = [];
  const baseStrategyConfig = mergeConfig(baseConfig);
  const totalSteps = split.validationEnabled ? testValues.length * 2 : testValues.length;
  let stepsDone = 0;

  for (let i = 0; i < testValues.length; i++) {
    const value = testValues[i];
    const testConfig = { ...baseStrategyConfig, [paramName]: value };

    const phaseLabel = split.validationEnabled ? 'IS' : '';
    const progress = {
      phase: 'testing',
      message: `Probando ${phaseLabel} ${paramRange.label}: ${value} (${i + 1}/${testValues.length})`.trim(),
      current: ++stepsDone,
      total: totalSteps,
      paramName,
      currentValue: value
    };

    if (jobId && activeJobs.has(jobId)) {
      Object.assign(activeJobs.get(jobId), progress);
    }
    if (onProgress) onProgress(progress);

    let isMetrics;
    try {
      const candlesForIS = split.validationEnabled ? trainCandles : preloadedCandles;

      const backtestResult = await runBacktest({
        asset,
        days,
        capital,
        strategyConfig: testConfig,
        preloadedCandles: candlesForIS,
        stepInterval: '4h',
        riskPerTrade: testConfig.riskPerTrade || 0.02,
        maxOpenPositions: testConfig.maxOpenPositions || 3,
        cooldownBars: 6,
        fearGreed: 50
      });

      isMetrics = extractMetrics(backtestResult);

      logger.info('IS optimization step completed', {
        paramName, value,
        sharpe: isMetrics.sharpe,
        pf: isMetrics.profitFactor,
        winRate: isMetrics.winRate + '%',
        trades: isMetrics.totalTrades
      });

    } catch (err) {
      logger.warn('IS optimization step failed', { paramName, value, error: err.message });
      isMetrics = errorMetrics(err.message);
    }

    // Build result entry — flat fields = IS metrics for backward compatibility
    results.push({
      value,
      // Backward compat flat fields (always IS)
      sharpe: isMetrics.sharpe,
      sortino: isMetrics.sortino,
      calmar: isMetrics.calmar,
      expectancy: isMetrics.expectancy,
      profitFactor: isMetrics.profitFactor,
      winRate: isMetrics.winRate,
      totalTrades: isMetrics.totalTrades,
      totalPnl: isMetrics.totalPnl,
      totalPnlPercent: isMetrics.totalPnlPercent,
      maxDrawdownPercent: isMetrics.maxDrawdownPercent,
      avgHoldingBars: isMetrics.avgHoldingBars,
      maxConsecutiveLosses: isMetrics.maxConsecutiveLosses,
      statisticallySignificant: isMetrics.statisticallySignificant,
      ...(isMetrics.error ? { error: isMetrics.error } : {}),
      // Structured fields
      inSample: isMetrics,
      outOfSample: null
    });
  }

  // ─── 4. Validation: Out-of-Sample (test period) ──────────────────────
  if (split.validationEnabled) {
    for (let i = 0; i < testValues.length; i++) {
      const value = testValues[i];
      const testConfig = { ...baseStrategyConfig, [paramName]: value };

      const progress = {
        phase: 'validating',
        message: `Validando OOS ${paramRange.label}: ${value} (${i + 1}/${testValues.length})`,
        current: ++stepsDone,
        total: totalSteps,
        paramName,
        currentValue: value
      };

      if (jobId && activeJobs.has(jobId)) {
        Object.assign(activeJobs.get(jobId), progress);
      }
      if (onProgress) onProgress(progress);

      try {
        const oosResult = await runBacktest({
          asset,
          days: split.testDays,
          capital,
          strategyConfig: testConfig,
          preloadedCandles: testCandlesFull,
          stepInterval: '4h',
          riskPerTrade: testConfig.riskPerTrade || 0.02,
          maxOpenPositions: testConfig.maxOpenPositions || 3,
          cooldownBars: 6,
          fearGreed: 50
        });

        results[i].outOfSample = extractMetrics(oosResult);

        logger.info('OOS validation step completed', {
          paramName, value,
          isSharpe: results[i].inSample.sharpe,
          oosSharpe: results[i].outOfSample.sharpe,
          trades: results[i].outOfSample.totalTrades
        });

      } catch (err) {
        logger.warn('OOS validation step failed', { paramName, value, error: err.message });
        results[i].outOfSample = errorMetrics(err.message);
      }
    }
  }

  // ─── 5. Rank results ──────────────────────────────────────────────────
  const MIN_TRADES_FOR_RANKING = 10;

  // Ranking metric: OOS Sharpe if validation, else IS Sharpe
  const getRankSharpe = (r) => {
    if (split.validationEnabled && r.outOfSample && !r.outOfSample.error) {
      return r.outOfSample.sharpe;
    }
    return r.sharpe; // IS sharpe (backward compat)
  };

  const getTradeCount = (r) => {
    if (split.validationEnabled && r.outOfSample && !r.outOfSample.error) {
      // For ranking, require minimum trades in BOTH periods
      return Math.min(r.totalTrades, r.outOfSample.totalTrades);
    }
    return r.totalTrades;
  };

  const validResults = results.filter(r => getTradeCount(r) >= MIN_TRADES_FOR_RANKING && !r.error);
  const invalidResults = results.filter(r => getTradeCount(r) < MIN_TRADES_FOR_RANKING || r.error);

  validResults.sort((a, b) => getRankSharpe(b) - getRankSharpe(a));
  invalidResults.sort((a, b) => getRankSharpe(b) - getRankSharpe(a));
  results = [...validResults, ...invalidResults];

  const bestResult = validResults.length > 0 ? validResults[0] : results[0];
  const defaultValue = DEFAULT_STRATEGY_CONFIG[paramName];
  const defaultResult = results.find(r => r.value === defaultValue);

  // ─── 6. Compute overfitting metrics ──────────────────────────────────
  let overfitMetrics = null;
  if (split.validationEnabled) {
    overfitMetrics = computeOverfitMetrics(results);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // ─── 7. Build result object (backward compatible + new fields) ───────
  const optimizationResult = {
    // Existing fields (unchanged for backward compat)
    asset,
    days,
    paramName,
    paramLabel: paramRange.label,
    paramDescription: paramRange.description,
    defaultValue,
    bestValue: bestResult?.value,
    bestSharpe: bestResult?.sharpe,
    defaultSharpe: defaultResult?.sharpe ?? null,
    improvement: defaultResult
      ? Math.round((bestResult.sharpe - defaultResult.sharpe) * 100) / 100
      : null,
    results,
    baseConfig: baseStrategyConfig,
    duration: parseFloat(duration),
    completedAt: new Date().toISOString(),

    // NEW: Walk-forward validation metadata
    validation: split.validationEnabled ? {
      enabled: true,
      trainDays: split.trainDays,
      testDays: split.testDays,
      trainRatio: split.trainRatio,
      splitDate: new Date(split.splitTimestamp).toISOString(),
      bestOosSharpe: bestResult?.outOfSample?.sharpe ?? null,
      defaultOosSharpe: defaultResult?.outOfSample?.sharpe ?? null,
      oosImprovement: (defaultResult?.outOfSample && bestResult?.outOfSample)
        ? Math.round((bestResult.outOfSample.sharpe - defaultResult.outOfSample.sharpe) * 100) / 100
        : null,
      rankedBy: 'OOS Sharpe',
      ...(overfitMetrics || {})
    } : {
      enabled: false,
      reason: split.reason
    }
  };

  logger.info('Optimization completed', {
    paramName, duration: duration + 's',
    bestValue: bestResult?.value,
    bestIsSharpe: bestResult?.sharpe,
    bestOosSharpe: bestResult?.outOfSample?.sharpe ?? 'N/A',
    validationEnabled: split.validationEnabled,
    overfitWarning: overfitMetrics?.overfitWarning ?? false
  });

  if (onProgress) onProgress({ phase: 'completed', message: 'Optimización completada' });

  return optimizationResult;
}

// ─── Job Management ──────────────────────────────────────────────────────────

/**
 * Start an optimization job (async, non-blocking).
 * Returns a job ID for progress tracking.
 */
function startOptimizationJob(options, onComplete = null) {
  const jobId = `opt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const job = {
    jobId,
    status: 'queued',
    message: 'En cola...',
    current: 0,
    total: 0,
    paramName: options.paramName,
    asset: options.asset,
    days: options.days,
    startedAt: new Date().toISOString(),
    result: null,
    error: null
  };

  activeJobs.set(jobId, job);

  // Auto-cleanup old completed/errored jobs (keep last 20)
  if (activeJobs.size > 20) {
    const sorted = [...activeJobs.entries()]
      .filter(([, j]) => j.status === 'completed' || j.status === 'error')
      .sort((a, b) => new Date(a[1].startedAt) - new Date(b[1].startedAt));
    while (sorted.length > 0 && activeJobs.size > 20) {
      activeJobs.delete(sorted.shift()[0]);
    }
  }

  // Run async (don't await)
  runOptimization({ ...options, jobId })
    .then(result => {
      if (activeJobs.has(jobId)) {
        activeJobs.get(jobId).status = 'completed';
        activeJobs.get(jobId).message = 'Optimización completada';
        activeJobs.get(jobId).result = result;
      }
      if (onComplete) onComplete(null, result);
    })
    .catch(err => {
      logger.error('Optimization job failed', { jobId, error: err.message });
      if (activeJobs.has(jobId)) {
        activeJobs.get(jobId).status = 'error';
        activeJobs.get(jobId).message = err.message;
        activeJobs.get(jobId).error = err.message;
      }
      if (onComplete) onComplete(err, null);
    });

  return jobId;
}

/**
 * Get the current status of an optimization job
 */
function getJobStatus(jobId) {
  return activeJobs.get(jobId) || null;
}

/**
 * Get all jobs (for history endpoint)
 */
function getAllJobs() {
  return [...activeJobs.values()].sort((a, b) =>
    new Date(b.startedAt) - new Date(a.startedAt)
  );
}

/**
 * Clean up old completed jobs (keep last 20)
 */
function cleanupJobs() {
  const jobs = getAllJobs();
  const completed = jobs.filter(j => j.status === 'completed' || j.status === 'error');
  if (completed.length > 20) {
    const toRemove = completed.slice(20);
    for (const job of toRemove) {
      activeJobs.delete(job.jobId);
    }
  }
}

module.exports = {
  runOptimization,
  startOptimizationJob,
  getJobStatus,
  getAllJobs,
  cleanupJobs,
  generateParamValues,
  // Walk-forward helpers (exported for testing)
  splitCandlesByTimestamp,
  computeValidationSplit,
  computeOverfitMetrics,
  PARAM_RANGES
};
