// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - STRATEGY OPTIMIZER
// Grid search engine that tests parameter variations against historical data
// Uses the backtester to evaluate each config and ranks by Sharpe ratio
// Walk-forward validation: single split (30-59d) or rolling windows (60d+)
// Rolling WF: sliding train/test windows + parameter stability scoring
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
// Single split (legacy 70/30) and rolling multi-window walk-forward

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

// ─── Rolling Walk-Forward Windows ────────────────────────────────────────────

/**
 * Compute rolling walk-forward windows for multi-period validation.
 *
 * Uses a rolling (sliding) approach where each fold has a fixed-size
 * training window and test window that slide forward through time:
 *
 *  |---train1---|--test1--|
 *       |---train2---|--test2--|
 *            |---train3---|--test3--|
 *
 * This tests parameter stability across different market regimes.
 *
 * @param {number} days - Total historical days
 * @param {Object} [options]
 * @param {number} [options.numFolds=3] - Desired number of test folds
 * @param {number} [options.minTrainDays=30] - Minimum training period
 * @param {number} [options.minTestDays=7] - Minimum test period per fold
 * @returns {{ rolling: boolean, windows?: Array, numFolds?, trainDays?, testDaysPerFold?, reason? }}
 */
function computeRollingWindows(days, options = {}) {
  const {
    numFolds: requestedFolds = 3,
    minTrainDays = 30,
    minTestDays = 7
  } = options;

  const MIN_DAYS_FOR_ROLLING = 60;

  if (days < MIN_DAYS_FOR_ROLLING) {
    return {
      rolling: false,
      reason: `Rolling walk-forward requiere >= ${MIN_DAYS_FOR_ROLLING} días (tienes ${days})`
    };
  }

  // Calculate test period per fold: ~15% of total, bounded
  let testDaysPerFold = Math.max(minTestDays, Math.floor(days * 0.15));
  testDaysPerFold = Math.min(testDaysPerFold, 30); // Cap at 30 days per fold

  // Determine how many folds we can fit
  // Total = trainDays + numFolds * stepSize, where stepSize = testDaysPerFold
  // trainDays = days - numFolds * testDaysPerFold (for non-overlapping test zones)
  let numFolds = requestedFolds;
  let trainDays = days - numFolds * testDaysPerFold;

  // Reduce folds if training period too short
  while (trainDays < minTrainDays && numFolds > 1) {
    numFolds--;
    trainDays = days - numFolds * testDaysPerFold;
  }

  if (trainDays < minTrainDays || numFolds < 2) {
    return {
      rolling: false,
      reason: `No se pueden crear suficientes ventanas rolling: trainDays=${trainDays}, folds=${numFolds}`
    };
  }

  // Generate rolling windows
  // Window i: train slides forward by testDaysPerFold each time
  // Train: [i * step, i * step + trainDays]
  // Test:  [i * step + trainDays, i * step + trainDays + testDaysPerFold]
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const startTs = now - days * DAY_MS;
  const stepDays = testDaysPerFold; // Each window slides by one test period

  const windows = [];
  for (let i = 0; i < numFolds; i++) {
    const trainStartTs = startTs + i * stepDays * DAY_MS;
    const trainEndTs = trainStartTs + trainDays * DAY_MS;
    const testEndTs = trainEndTs + testDaysPerFold * DAY_MS;

    windows.push({
      fold: i + 1,
      trainStartTs,
      trainEndTs,       // Also = testStartTs
      testEndTs,
      trainDays,
      testDays: testDaysPerFold,
      trainLabel: `Day ${i * stepDays + 1}–${i * stepDays + trainDays}`,
      testLabel: `Day ${i * stepDays + trainDays + 1}–${i * stepDays + trainDays + testDaysPerFold}`
    });
  }

  return {
    rolling: true,
    windows,
    numFolds,
    trainDays,
    testDaysPerFold,
    stepDays,
    totalDays: days
  };
}

/**
 * Split candles for a specific rolling window (train and test periods).
 *
 * @param {Object} candles - { '1h': [], '4h': [], '15m': [] }
 * @param {Object} window - Single window from computeRollingWindows
 * @returns {{ train: Object, test: Object, splitInfo: Object }}
 */
function splitCandlesForWindow(candles, window) {
  const train = {};
  const test = {};
  const splitInfo = {};

  for (const tf of ['1h', '4h', '15m']) {
    const arr = candles[tf] || [];

    // Train: candles within [trainStartTs, trainEndTs]
    const trainCandles = arr.filter(
      c => c.timestamp >= window.trainStartTs && c.timestamp <= window.trainEndTs
    );

    // Test: ALL candles up to testEndTs (warm-up + test period)
    // Candles before trainEndTs serve as indicator warm-up for the test period
    const testCandles = arr.filter(c => c.timestamp <= window.testEndTs);

    train[tf] = trainCandles;
    test[tf] = testCandles;
    splitInfo[tf] = {
      total: arr.length,
      trainCount: trainCandles.length,
      testCount: testCandles.length
    };
  }

  return { train, test, splitInfo };
}

/**
 * Compute parameter stability score across rolling windows.
 * Low stdDev = parameter is stable across different market conditions = good.
 *
 * @param {Array<Object>} windowResults - Array of { fold, bestValue, bestSharpe, ... }
 * @returns {Object} { mean, stdDev, cv, stabilityScore, bestValues, consistent }
 */
function computeParameterStability(windowResults) {
  const bestValues = windowResults
    .filter(w => w.bestValue !== null && w.bestValue !== undefined)
    .map(w => w.bestValue);

  if (bestValues.length < 2) {
    return {
      mean: bestValues[0] || null,
      stdDev: 0,
      cv: 0,
      stabilityScore: 1.0,
      bestValues,
      consistent: true,
      detail: 'Insuficientes ventanas para análisis de estabilidad'
    };
  }

  const mean = bestValues.reduce((s, v) => s + v, 0) / bestValues.length;
  const variance = bestValues.reduce((s, v) => s + (v - mean) ** 2, 0) / bestValues.length;
  const stdDev = Math.sqrt(variance);
  const cv = mean !== 0 ? stdDev / Math.abs(mean) : 0; // Coefficient of variation

  // Stability score: 1.0 = perfectly stable, 0.0 = wildly unstable
  // cv < 0.1 → very stable, cv > 0.5 → unstable
  const stabilityScore = Math.max(0, Math.min(1, 1 - cv * 2));

  return {
    mean: Math.round(mean * 1000) / 1000,
    stdDev: Math.round(stdDev * 1000) / 1000,
    cv: Math.round(cv * 1000) / 1000,
    stabilityScore: Math.round(stabilityScore * 100) / 100,
    bestValues,
    consistent: cv < 0.25,
    detail: cv < 0.1
      ? 'Parámetro muy estable — alta confianza en generalización'
      : cv < 0.25
        ? 'Parámetro moderadamente estable — confianza aceptable'
        : cv < 0.5
          ? 'Parámetro inestable — los resultados podrían no generalizar'
          : 'Parámetro muy inestable — alta probabilidad de sobreajuste'
  };
}

/**
 * Aggregate OOS results across rolling windows to find the best param value.
 * Uses average OOS Sharpe across all folds where the param was tested.
 *
 * @param {Array<Object>} allWindowResults - Array of { fold, paramResults: [{ value, oosMetrics }] }
 * @param {number} minTrades - Minimum trades per fold to count
 * @returns {Array<Object>} Sorted by avgOosSharpe descending
 */
function aggregateRollingResults(allWindowResults, minTrades = 5) {
  // Collect all unique param values
  const valueMap = new Map(); // value → { sharpes: [], totalTrades: [], pnls: [] }

  for (const wr of allWindowResults) {
    for (const pr of wr.paramResults) {
      if (!valueMap.has(pr.value)) {
        valueMap.set(pr.value, { sharpes: [], trades: [], pnls: [], winRates: [] });
      }
      const entry = valueMap.get(pr.value);
      if (pr.oosMetrics && !pr.oosMetrics.error) {
        entry.sharpes.push(pr.oosMetrics.sharpe);
        entry.trades.push(pr.oosMetrics.totalTrades);
        entry.pnls.push(pr.oosMetrics.totalPnlPercent);
        entry.winRates.push(pr.oosMetrics.winRate);
      }
    }
  }

  const aggregated = [];
  for (const [value, data] of valueMap) {
    const validFolds = data.sharpes.length;
    const avgTrades = validFolds > 0
      ? data.trades.reduce((s, t) => s + t, 0) / validFolds
      : 0;

    if (validFolds === 0 || avgTrades < minTrades) {
      aggregated.push({
        value,
        avgOosSharpe: -999,
        avgOosPnlPct: 0,
        avgWinRate: 0,
        validFolds: 0,
        totalFolds: allWindowResults.length,
        insufficient: true
      });
      continue;
    }

    const avgSharpe = data.sharpes.reduce((s, v) => s + v, 0) / validFolds;
    const avgPnl = data.pnls.reduce((s, v) => s + v, 0) / validFolds;
    const avgWinRate = data.winRates.reduce((s, v) => s + v, 0) / validFolds;

    // Sharpe consistency: penalize high variance across folds
    const sharpeMean = avgSharpe;
    const sharpeVar = data.sharpes.reduce((s, v) => s + (v - sharpeMean) ** 2, 0) / validFolds;
    const sharpeStd = Math.sqrt(sharpeVar);

    aggregated.push({
      value,
      avgOosSharpe: Math.round(avgSharpe * 100) / 100,
      avgOosPnlPct: Math.round(avgPnl * 100) / 100,
      avgWinRate: Math.round(avgWinRate * 10) / 10,
      sharpeStd: Math.round(sharpeStd * 100) / 100,
      validFolds,
      totalFolds: allWindowResults.length,
      insufficient: false,
      // Composite score: avg Sharpe penalized by inconsistency
      compositeScore: Math.round((avgSharpe - 0.5 * sharpeStd) * 100) / 100
    });
  }

  // Sort by composite score (Sharpe penalized by variance)
  aggregated.sort((a, b) => b.compositeScore - a.compositeScore);

  return aggregated;
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
 * Validation modes (automatic based on days):
 *   - days < 30:  No validation — full-period optimization (backward compatible)
 *   - 30 ≤ days < 60: Single 70/30 train/test split
 *   - days ≥ 60:  Rolling walk-forward with multiple sliding windows
 *     + parameter stability scoring across windows
 *     + composite ranking (avg OOS Sharpe penalized by variance)
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
  const baseStrategyConfig = mergeConfig(baseConfig);

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

  // ─── 2. Decide validation mode ────────────────────────────────────────
  const rollingConfig = computeRollingWindows(days);
  const split = rollingConfig.rolling ? null : computeValidationSplit(days);
  const useRolling = rollingConfig.rolling;
  const useSingleSplit = !useRolling && split && split.validationEnabled;

  // ─── Route to rolling walk-forward or single-split ────────────────────
  if (useRolling) {
    return await _runRollingOptimization({
      asset, days, paramName, paramRange, testValues, baseStrategyConfig,
      capital, preloadedCandles, rollingConfig, jobId, onProgress, startTime
    });
  }

  // ─── Single-split or no-validation path (existing logic) ──────────────
  let trainCandles, testCandlesFull;

  if (useSingleSplit) {
    const splitResult = splitCandlesByTimestamp(preloadedCandles, split.splitTimestamp);
    trainCandles = splitResult.train;
    testCandlesFull = splitResult.test;

    logger.info('Walk-forward validation enabled (single split)', {
      trainDays: split.trainDays,
      testDays: split.testDays,
      splitDate: new Date(split.splitTimestamp).toISOString(),
      trainCandles1h: trainCandles['1h'].length,
      testCandles1h: testCandlesFull['1h'].length
    });
  }

  // ─── 3. Grid search: In-Sample (train or full period) ────────────────
  let results = [];
  const totalSteps = useSingleSplit ? testValues.length * 2 : testValues.length;
  let stepsDone = 0;

  for (let i = 0; i < testValues.length; i++) {
    const value = testValues[i];
    const testConfig = { ...baseStrategyConfig, [paramName]: value };

    const phaseLabel = useSingleSplit ? 'IS' : '';
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
      const candlesForIS = useSingleSplit ? trainCandles : preloadedCandles;

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
  if (useSingleSplit) {
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
    if (useSingleSplit && r.outOfSample && !r.outOfSample.error) {
      return r.outOfSample.sharpe;
    }
    return r.sharpe; // IS sharpe (backward compat)
  };

  const getTradeCount = (r) => {
    if (useSingleSplit && r.outOfSample && !r.outOfSample.error) {
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
  if (useSingleSplit) {
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

    // Walk-forward validation metadata
    validation: useSingleSplit ? {
      enabled: true,
      mode: 'single_split',
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
      reason: split ? split.reason : 'No validation needed'
    }
  };

  logger.info('Optimization completed', {
    paramName, duration: duration + 's',
    bestValue: bestResult?.value,
    bestIsSharpe: bestResult?.sharpe,
    bestOosSharpe: bestResult?.outOfSample?.sharpe ?? 'N/A',
    validationEnabled: useSingleSplit,
    overfitWarning: overfitMetrics?.overfitWarning ?? false
  });

  if (onProgress) onProgress({ phase: 'completed', message: 'Optimización completada' });

  return optimizationResult;
}

// ─── Rolling Walk-Forward Optimization ──────────────────────────────────────

/**
 * Internal: Run optimization with rolling walk-forward windows.
 * For each window, grid-search all param values on train, validate on test.
 * Aggregate across windows to find the most robust param value.
 *
 * @private
 */
async function _runRollingOptimization({
  asset, days, paramName, paramRange, testValues, baseStrategyConfig,
  capital, preloadedCandles, rollingConfig, jobId, onProgress, startTime
}) {
  const { windows, numFolds, trainDays, testDaysPerFold } = rollingConfig;

  logger.info('Rolling walk-forward optimization started', {
    paramName, numFolds, trainDays, testDaysPerFold,
    windows: windows.map(w => w.testLabel)
  });

  // Total steps: (IS grid + OOS grid) × numFolds
  const totalSteps = testValues.length * 2 * numFolds;
  let stepsDone = 0;
  const allWindowResults = [];
  const defaultValue = DEFAULT_STRATEGY_CONFIG[paramName];

  // Process each rolling window
  for (const window of windows) {
    const foldLabel = `Fold ${window.fold}/${numFolds}`;
    const { train: trainCandles, test: testCandles } = splitCandlesForWindow(preloadedCandles, window);

    logger.info(`Rolling WF: ${foldLabel}`, {
      train: window.trainLabel,
      test: window.testLabel,
      trainCandles1h: trainCandles['1h'].length,
      testCandles1h: testCandles['1h'].length
    });

    const foldResults = [];

    // ─── IS grid search for this window ───────────────────────────────
    for (let i = 0; i < testValues.length; i++) {
      const value = testValues[i];
      const testConfig = { ...baseStrategyConfig, [paramName]: value };

      const progress = {
        phase: 'testing',
        message: `${foldLabel} IS: ${paramRange.label}=${value} (${i + 1}/${testValues.length})`,
        current: ++stepsDone,
        total: totalSteps,
        paramName,
        currentValue: value,
        fold: window.fold,
        numFolds
      };

      if (jobId && activeJobs.has(jobId)) Object.assign(activeJobs.get(jobId), progress);
      if (onProgress) onProgress(progress);

      let isMetrics;
      try {
        const backtestResult = await runBacktest({
          asset,
          days: window.trainDays,
          capital,
          strategyConfig: testConfig,
          preloadedCandles: trainCandles,
          stepInterval: '4h',
          riskPerTrade: testConfig.riskPerTrade || 0.02,
          maxOpenPositions: testConfig.maxOpenPositions || 3,
          cooldownBars: 6,
          fearGreed: 50
        });
        isMetrics = extractMetrics(backtestResult);
      } catch (err) {
        logger.warn(`Rolling WF ${foldLabel} IS failed`, { value, error: err.message });
        isMetrics = errorMetrics(err.message);
      }

      foldResults.push({ value, isMetrics, oosMetrics: null });
    }

    // ─── OOS validation for this window ───────────────────────────────
    for (let i = 0; i < testValues.length; i++) {
      const value = testValues[i];
      const testConfig = { ...baseStrategyConfig, [paramName]: value };

      const progress = {
        phase: 'validating',
        message: `${foldLabel} OOS: ${paramRange.label}=${value} (${i + 1}/${testValues.length})`,
        current: ++stepsDone,
        total: totalSteps,
        paramName,
        currentValue: value,
        fold: window.fold,
        numFolds
      };

      if (jobId && activeJobs.has(jobId)) Object.assign(activeJobs.get(jobId), progress);
      if (onProgress) onProgress(progress);

      try {
        const oosResult = await runBacktest({
          asset,
          days: window.testDays,
          capital,
          strategyConfig: testConfig,
          preloadedCandles: testCandles,
          stepInterval: '4h',
          riskPerTrade: testConfig.riskPerTrade || 0.02,
          maxOpenPositions: testConfig.maxOpenPositions || 3,
          cooldownBars: 6,
          fearGreed: 50
        });
        foldResults[i].oosMetrics = extractMetrics(oosResult);
      } catch (err) {
        logger.warn(`Rolling WF ${foldLabel} OOS failed`, { value, error: err.message });
        foldResults[i].oosMetrics = errorMetrics(err.message);
      }
    }

    // Find best value for this fold (by OOS Sharpe)
    const validFoldResults = foldResults.filter(
      r => r.oosMetrics && !r.oosMetrics.error && r.oosMetrics.totalTrades >= 5
    );
    const bestInFold = validFoldResults.length > 0
      ? validFoldResults.reduce((best, r) => r.oosMetrics.sharpe > best.oosMetrics.sharpe ? r : best)
      : null;

    allWindowResults.push({
      fold: window.fold,
      trainLabel: window.trainLabel,
      testLabel: window.testLabel,
      bestValue: bestInFold?.value ?? null,
      bestSharpe: bestInFold?.oosMetrics?.sharpe ?? null,
      paramResults: foldResults
    });

    logger.info(`Rolling WF ${foldLabel} completed`, {
      bestValue: bestInFold?.value ?? 'none',
      bestOosSharpe: bestInFold?.oosMetrics?.sharpe ?? 'N/A'
    });
  }

  // ─── Aggregate across all windows ───────────────────────────────────
  const aggregated = aggregateRollingResults(allWindowResults);
  const stability = computeParameterStability(allWindowResults);

  // Build per-value IS/OOS from first fold for backward compat
  const firstFold = allWindowResults[0];
  const results = testValues.map((value, i) => {
    const fr = firstFold.paramResults[i];
    const agg = aggregated.find(a => a.value === value);
    const isM = fr.isMetrics || errorMetrics('no data');
    return {
      value,
      // Backward compat flat fields (IS from first fold)
      sharpe: isM.sharpe,
      sortino: isM.sortino,
      calmar: isM.calmar,
      expectancy: isM.expectancy,
      profitFactor: isM.profitFactor,
      winRate: isM.winRate,
      totalTrades: isM.totalTrades,
      totalPnl: isM.totalPnl,
      totalPnlPercent: isM.totalPnlPercent,
      maxDrawdownPercent: isM.maxDrawdownPercent,
      avgHoldingBars: isM.avgHoldingBars,
      maxConsecutiveLosses: isM.maxConsecutiveLosses,
      statisticallySignificant: isM.statisticallySignificant,
      ...(isM.error ? { error: isM.error } : {}),
      inSample: isM,
      outOfSample: fr.oosMetrics,
      // Rolling-specific
      rolling: agg || null
    };
  });

  // Best = highest composite score across all rolling windows
  const bestAgg = aggregated.find(a => !a.insufficient);
  const bestValue = bestAgg?.value ?? results[0]?.value;
  const bestResult = results.find(r => r.value === bestValue);
  const defaultResult = results.find(r => r.value === defaultValue);

  // Overfit metrics from first fold's IS/OOS pairs
  const overfitMetrics = computeOverfitMetrics(
    firstFold.paramResults.map(pr => ({
      value: pr.value,
      inSample: pr.isMetrics,
      outOfSample: pr.oosMetrics
    }))
  );

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  const optimizationResult = {
    asset,
    days,
    paramName,
    paramLabel: paramRange.label,
    paramDescription: paramRange.description,
    defaultValue,
    bestValue,
    bestSharpe: bestResult?.sharpe ?? null,
    defaultSharpe: defaultResult?.sharpe ?? null,
    improvement: (defaultResult && bestResult)
      ? Math.round((bestResult.sharpe - defaultResult.sharpe) * 100) / 100
      : null,
    results,
    baseConfig: baseStrategyConfig,
    duration: parseFloat(duration),
    completedAt: new Date().toISOString(),

    // Rolling walk-forward validation metadata
    validation: {
      enabled: true,
      mode: 'rolling',
      numFolds,
      trainDays,
      testDaysPerFold,
      rankedBy: 'Composite Score (avg OOS Sharpe − 0.5 × σ)',
      bestCompositeScore: bestAgg?.compositeScore ?? null,
      bestAvgOosSharpe: bestAgg?.avgOosSharpe ?? null,
      defaultCompositeScore: aggregated.find(a => a.value === defaultValue)?.compositeScore ?? null,

      // Parameter stability across windows
      parameterStability: stability,

      // Per-window summaries
      windowSummaries: allWindowResults.map(wr => ({
        fold: wr.fold,
        trainLabel: wr.trainLabel,
        testLabel: wr.testLabel,
        bestValue: wr.bestValue,
        bestOosSharpe: wr.bestSharpe
      })),

      // Aggregated rankings (all param values ranked by composite)
      aggregatedRanking: aggregated.slice(0, 10), // Top 10

      // Overfitting diagnostics (from first fold)
      ...overfitMetrics
    }
  };

  logger.info('Rolling walk-forward optimization completed', {
    paramName,
    duration: duration + 's',
    numFolds,
    bestValue,
    bestComposite: bestAgg?.compositeScore ?? 'N/A',
    stabilityScore: stability.stabilityScore,
    consistent: stability.consistent,
    overfitWarning: overfitMetrics.overfitWarning
  });

  if (onProgress) onProgress({ phase: 'completed', message: 'Optimización rolling completada' });

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
  // Rolling walk-forward (exported for testing)
  computeRollingWindows,
  splitCandlesForWindow,
  computeParameterStability,
  aggregateRollingResults,
  PARAM_RANGES
};
