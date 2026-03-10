// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - STRATEGY OPTIMIZER
// Grid search engine that tests parameter variations against historical data
// Uses the backtester to evaluate each config and ranks by Sharpe ratio
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

/**
 * Run a single-parameter grid search optimization.
 *
 * Pre-fetches candles ONCE, then runs backtest for each param value
 * with preloaded candles (no redundant API calls).
 *
 * @param {Object} options
 * @param {string} options.asset - CoinGecko asset ID (e.g., 'bitcoin')
 * @param {number} options.days - Historical days to backtest
 * @param {string} options.paramName - Key from PARAM_RANGES to optimize
 * @param {Object} [options.baseConfig] - Base strategy config (overrides defaults)
 * @param {number} [options.capital] - Starting capital (default 10000)
 * @param {string} [options.jobId] - Job ID for progress tracking
 * @param {Function} [options.onProgress] - Progress callback
 * @returns {Promise<Object>} Optimization results sorted by Sharpe ratio
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

  // ─── 2. Run backtest for each parameter value ─────────────────────────
  const results = [];
  const baseStrategyConfig = mergeConfig(baseConfig);

  for (let i = 0; i < testValues.length; i++) {
    const value = testValues[i];
    const testConfig = { ...baseStrategyConfig, [paramName]: value };

    const progress = {
      phase: 'testing',
      message: `Probando ${paramRange.label}: ${value} (${i + 1}/${testValues.length})`,
      current: i + 1,
      total: testValues.length,
      paramName,
      currentValue: value
    };

    if (jobId && activeJobs.has(jobId)) {
      Object.assign(activeJobs.get(jobId), progress);
    }

    if (onProgress) onProgress(progress);

    try {
      const backtestResult = await runBacktest({
        asset,
        days,
        capital,
        strategyConfig: testConfig,
        preloadedCandles,
        // Use default backtest params
        stepInterval: '4h',
        riskPerTrade: testConfig.riskPerTrade || 0.02,
        maxOpenPositions: testConfig.maxOpenPositions || 3,
        cooldownBars: 6,
        fearGreed: 50
      });

      results.push({
        value,
        sharpe: backtestResult.metrics.sharpeRatio,
        sortino: backtestResult.metrics.sortinoRatio || 0,
        calmar: backtestResult.metrics.calmarRatio || 0,
        expectancy: backtestResult.metrics.expectancy || 0,
        profitFactor: backtestResult.metrics.profitFactor,
        winRate: backtestResult.metrics.winRate,
        totalTrades: backtestResult.metrics.totalTrades,
        totalPnl: backtestResult.metrics.totalPnl,
        totalPnlPercent: backtestResult.metrics.totalPnlPercent,
        maxDrawdownPercent: backtestResult.metrics.maxDrawdownPercent,
        avgHoldingBars: backtestResult.metrics.avgHoldingBars,
        maxConsecutiveLosses: backtestResult.metrics.maxConsecutiveLosses,
        statisticallySignificant: backtestResult.metrics.statisticallySignificant
      });

      logger.info('Optimization step completed', {
        paramName, value,
        sharpe: backtestResult.metrics.sharpeRatio,
        pf: backtestResult.metrics.profitFactor,
        winRate: backtestResult.metrics.winRate + '%',
        trades: backtestResult.metrics.totalTrades
      });

    } catch (err) {
      logger.warn('Optimization step failed', { paramName, value, error: err.message });
      results.push({
        value,
        sharpe: -999,
        profitFactor: 0,
        winRate: 0,
        totalTrades: 0,
        totalPnl: 0,
        totalPnlPercent: 0,
        maxDrawdownPercent: 0,
        avgHoldingBars: 0,
        maxConsecutiveLosses: 0,
        error: err.message
      });
    }
  }

  // ─── 3. Filter low trade counts, sort by Sharpe ratio (descending) ────
  const MIN_TRADES_FOR_RANKING = 10;
  const validResults = results.filter(r => r.totalTrades >= MIN_TRADES_FOR_RANKING && !r.error);
  const invalidResults = results.filter(r => r.totalTrades < MIN_TRADES_FOR_RANKING || r.error);

  // Sort valid results by Sharpe (descending), then append low-trade results at bottom
  validResults.sort((a, b) => b.sharpe - a.sharpe);
  invalidResults.sort((a, b) => b.sharpe - a.sharpe);
  results = [...validResults, ...invalidResults];

  const bestResult = validResults.length > 0 ? validResults[0] : results[0];
  const defaultValue = DEFAULT_STRATEGY_CONFIG[paramName];
  const defaultResult = results.find(r => r.value === defaultValue);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  const optimizationResult = {
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
    completedAt: new Date().toISOString()
  };

  logger.info('Optimization completed', {
    paramName, duration: duration + 's',
    bestValue: bestResult?.value,
    bestSharpe: bestResult?.sharpe,
    defaultValue,
    defaultSharpe: defaultResult?.sharpe
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
  PARAM_RANGES
};
