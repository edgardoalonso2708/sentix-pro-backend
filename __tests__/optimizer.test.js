const {
  generateParamValues,
  startOptimizationJob,
  getJobStatus,
  getAllJobs,
  cleanupJobs,
  splitCandlesByTimestamp,
  computeValidationSplit,
  computeOverfitMetrics,
  computeRollingWindows,
  splitCandlesForWindow,
  computeParameterStability,
  aggregateRollingResults,
  PARAM_RANGES
} = require('../optimizer');
const { DEFAULT_STRATEGY_CONFIG } = require('../strategyConfig');

// ═══════════════════════════════════════════════════════════════════════════════
// generateParamValues Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('generateParamValues', () => {
  test('generates correct integer values', () => {
    const values = generateParamValues({ min: 20, max: 40, step: 5 });
    expect(values).toEqual([20, 25, 30, 35, 40]);
  });

  test('generates correct float values', () => {
    const values = generateParamValues({ min: 1.0, max: 1.4, step: 0.1 });
    expect(values).toHaveLength(5);
    expect(values[0]).toBeCloseTo(1.0);
    expect(values[1]).toBeCloseTo(1.1);
    expect(values[2]).toBeCloseTo(1.2);
    expect(values[3]).toBeCloseTo(1.3);
    expect(values[4]).toBeCloseTo(1.4);
  });

  test('generates single value when min === max', () => {
    const values = generateParamValues({ min: 5, max: 5, step: 1 });
    expect(values).toEqual([5]);
  });

  test('generates two values for small range', () => {
    const values = generateParamValues({ min: 10, max: 15, step: 5 });
    expect(values).toEqual([10, 15]);
  });

  test('handles small float steps correctly (avoids precision issues)', () => {
    const values = generateParamValues({ min: 0.01, max: 0.05, step: 0.01 });
    expect(values).toHaveLength(5);
    expect(values[0]).toBeCloseTo(0.01);
    expect(values[4]).toBeCloseTo(0.05);
    // Check no precision artifacts like 0.030000000000000004
    values.forEach(v => {
      const decimals = v.toString().split('.')[1];
      if (decimals) {
        expect(decimals.length).toBeLessThanOrEqual(3);
      }
    });
  });

  test('values are in ascending order', () => {
    const values = generateParamValues({ min: 0.5, max: 0.9, step: 0.1 });
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  test('all PARAM_RANGES produce valid value arrays', () => {
    for (const [name, range] of Object.entries(PARAM_RANGES)) {
      const values = generateParamValues(range);
      expect(values.length).toBeGreaterThanOrEqual(2);
      expect(values[0]).toBeCloseTo(range.min);
      // last value should be <= max (with float tolerance)
      expect(values[values.length - 1]).toBeLessThanOrEqual(range.max + range.step / 10);
      // values should include the default
      const defaultVal = DEFAULT_STRATEGY_CONFIG[name];
      const hasDefault = values.some(v => Math.abs(v - defaultVal) < range.step / 2);
      // This is important: the default value should be testable
      expect(hasDefault).toBe(true);
    }
  });

  test('generates correct count for adxStrongThreshold range', () => {
    const range = PARAM_RANGES.adxStrongThreshold; // min:20, max:40, step:5
    const values = generateParamValues(range);
    expect(values).toEqual([20, 25, 30, 35, 40]);
  });

  test('generates correct count for confidenceCap range', () => {
    const range = PARAM_RANGES.confidenceCap; // min:70, max:95, step:5
    const values = generateParamValues(range);
    expect(values).toEqual([70, 75, 80, 85, 90, 95]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Job Management Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Job Management', () => {
  // Note: startOptimizationJob triggers async backtest runs that require
  // Binance API access. We test job creation/tracking without running full optimizations.

  test('startOptimizationJob returns a job ID string', () => {
    // This will fail on the async backtest, but job creation is synchronous
    const jobId = startOptimizationJob({
      asset: 'bitcoin',
      days: 1,
      paramName: 'buyThreshold'
    });
    expect(typeof jobId).toBe('string');
    expect(jobId).toMatch(/^opt-\d+-[a-z0-9]+$/);
  });

  test('getJobStatus returns job after creation', () => {
    const jobId = startOptimizationJob({
      asset: 'bitcoin',
      days: 1,
      paramName: 'rsiOversold'
    });
    const status = getJobStatus(jobId);
    expect(status).not.toBeNull();
    expect(status.jobId).toBe(jobId);
    expect(status.paramName).toBe('rsiOversold');
    expect(status.asset).toBe('bitcoin');
    expect(status.days).toBe(1);
    expect(status.startedAt).toBeTruthy();
    expect(['queued', 'fetching', 'testing', 'error']).toContain(status.status);
  });

  test('getJobStatus returns null for unknown job ID', () => {
    expect(getJobStatus('nonexistent-job-id')).toBeNull();
  });

  test('getAllJobs returns array sorted by startedAt descending', () => {
    // Create a couple of jobs
    startOptimizationJob({ asset: 'bitcoin', days: 1, paramName: 'buyThreshold' });
    startOptimizationJob({ asset: 'bitcoin', days: 1, paramName: 'sellThreshold' });

    const jobs = getAllJobs();
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs.length).toBeGreaterThanOrEqual(2);

    // Check sorted descending by startedAt
    for (let i = 1; i < jobs.length; i++) {
      expect(new Date(jobs[i - 1].startedAt).getTime())
        .toBeGreaterThanOrEqual(new Date(jobs[i].startedAt).getTime());
    }
  });

  test('each job has expected structure', () => {
    const jobId = startOptimizationJob({
      asset: 'ethereum',
      days: 7,
      paramName: 'adxStrongThreshold'
    });
    const job = getJobStatus(jobId);
    expect(job).toMatchObject({
      jobId: expect.any(String),
      status: expect.any(String),
      message: expect.any(String),
      current: expect.any(Number),
      total: expect.any(Number),
      paramName: 'adxStrongThreshold',
      asset: 'ethereum',
      days: 7,
      startedAt: expect.any(String),
      result: null
    });
  });

  test('cleanupJobs keeps at most 20 completed/error jobs', () => {
    // Create many jobs (they will fail async but get tracked)
    for (let i = 0; i < 25; i++) {
      startOptimizationJob({
        asset: 'bitcoin',
        days: 1,
        paramName: 'buyThreshold'
      });
    }

    // Wait a bit for some to error out, then manually mark some as completed
    const allJobs = getAllJobs();
    let markedCount = 0;
    for (const job of allJobs) {
      if (markedCount < 25) {
        job.status = 'completed';
        markedCount++;
      }
    }

    cleanupJobs();

    const afterCleanup = getAllJobs();
    const completedOrError = afterCleanup.filter(
      j => j.status === 'completed' || j.status === 'error'
    );
    expect(completedOrError.length).toBeLessThanOrEqual(20);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PARAM_RANGES Export Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('PARAM_RANGES export from optimizer', () => {
  test('matches strategyConfig PARAM_RANGES', () => {
    const { PARAM_RANGES: configRanges } = require('../strategyConfig');
    expect(PARAM_RANGES).toBe(configRanges);
  });

  test('all range keys are valid parameter names', () => {
    for (const key of Object.keys(PARAM_RANGES)) {
      expect(DEFAULT_STRATEGY_CONFIG).toHaveProperty(key);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Walk-Forward Validation: splitCandlesByTimestamp Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('splitCandlesByTimestamp', () => {
  const HOUR_MS = 3600000;
  const BASE_TS = 1700000000000;

  const makeCandles = (count, intervalMs, startTs = BASE_TS) =>
    Array.from({ length: count }, (_, i) => ({
      timestamp: startTs + i * intervalMs,
      open: 100, high: 101, low: 99, close: 100, volume: 1000
    }));

  test('splits candles correctly at given timestamp', () => {
    const candles = {
      '1h': makeCandles(100, HOUR_MS),
      '4h': makeCandles(25, HOUR_MS * 4),
      '15m': makeCandles(400, HOUR_MS / 4)
    };
    const splitTs = BASE_TS + 70 * HOUR_MS; // ~70% through 1h candles

    const { train, test, splitInfo } = splitCandlesByTimestamp(candles, splitTs);

    // Train should contain candles up to and including splitTs
    expect(train['1h'].length).toBe(71); // indices 0..70 inclusive
    expect(train['1h'].every(c => c.timestamp <= splitTs)).toBe(true);
    expect(train['1h'][train['1h'].length - 1].timestamp).toBe(splitTs);

    // Test should contain ALL candles (for warm-up)
    expect(test['1h'].length).toBe(100);
    expect(test['1h']).toBe(candles['1h']); // same reference

    // 4h timeframe should also be split
    expect(train['4h'].length).toBeGreaterThan(0);
    expect(train['4h'].every(c => c.timestamp <= splitTs)).toBe(true);

    // splitInfo should have accurate counts
    expect(splitInfo['1h'].total).toBe(100);
    expect(splitInfo['1h'].trainCount).toBe(71);
    expect(splitInfo['4h'].total).toBe(25);
  });

  test('handles splitTs before first candle — train is empty', () => {
    const candles = {
      '1h': makeCandles(10, HOUR_MS),
      '4h': makeCandles(3, HOUR_MS * 4),
      '15m': makeCandles(40, HOUR_MS / 4)
    };
    const { train, splitInfo } = splitCandlesByTimestamp(candles, BASE_TS - 1);

    expect(train['1h'].length).toBe(0);
    expect(train['4h'].length).toBe(0);
    expect(train['15m'].length).toBe(0);
    expect(splitInfo['1h'].trainCount).toBe(0);
  });

  test('handles splitTs after last candle — all candles in train', () => {
    const candles = {
      '1h': makeCandles(10, HOUR_MS),
      '4h': makeCandles(3, HOUR_MS * 4),
      '15m': makeCandles(40, HOUR_MS / 4)
    };
    const lastTs = BASE_TS + 9 * HOUR_MS;
    const { train, splitInfo } = splitCandlesByTimestamp(candles, lastTs + 999999);

    expect(train['1h'].length).toBe(10);
    expect(train['4h'].length).toBe(3);
    expect(splitInfo['1h'].trainCount).toBe(10);
  });

  test('handles empty timeframe arrays gracefully', () => {
    const candles = { '1h': [], '4h': [], '15m': [] };
    const { train, test, splitInfo } = splitCandlesByTimestamp(candles, BASE_TS);

    expect(train['1h'].length).toBe(0);
    expect(test['1h'].length).toBe(0);
    expect(splitInfo['1h'].total).toBe(0);
    expect(splitInfo['1h'].trainCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Walk-Forward Validation: computeValidationSplit Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeValidationSplit', () => {
  test('disables validation for days < 30', () => {
    const result = computeValidationSplit(20);
    expect(result.validationEnabled).toBe(false);
    expect(result.trainDays).toBe(20);
    expect(result.testDays).toBe(0);
    expect(result.reason).toBeDefined();
  });

  test('enables validation for days >= 30 with 70/30 split', () => {
    const result = computeValidationSplit(60);
    expect(result.validationEnabled).toBe(true);
    expect(result.trainDays).toBe(42); // round(60 * 0.7)
    expect(result.testDays).toBe(18);  // 60 - 42
    expect(result.splitTimestamp).toBeDefined();
    expect(result.trainRatio).toBe(0.7);
  });

  test('splitTimestamp is approximately testDays before now', () => {
    const now = Date.now();
    const result = computeValidationSplit(90);
    const expectedSplit = now - (result.testDays * 24 * 60 * 60 * 1000);
    // Allow 2s tolerance for test execution time
    expect(Math.abs(result.splitTimestamp - expectedSplit)).toBeLessThan(2000);
  });

  test('respects custom trainRatio', () => {
    const result = computeValidationSplit(100, 0.8);
    expect(result.trainDays).toBe(80);
    expect(result.testDays).toBe(20);
    expect(result.trainRatio).toBe(0.8);
  });

  test('disables validation if train period too short', () => {
    // trainRatio 0.5, 30 days → 15 train days (< 20 minimum)
    const result = computeValidationSplit(30, 0.5);
    expect(result.validationEnabled).toBe(false);
    expect(result.reason).toContain('corto');
  });

  test('edge case: exactly 30 days with default ratio', () => {
    const result = computeValidationSplit(30);
    expect(result.validationEnabled).toBe(true);
    expect(result.trainDays).toBe(21); // round(30 * 0.7)
    expect(result.testDays).toBe(9);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Walk-Forward Validation: computeOverfitMetrics Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeOverfitMetrics', () => {
  test('returns warning for high degradation', () => {
    const results = [
      { value: 1, inSample: { sharpe: 2.0 }, outOfSample: { sharpe: 0.5 } },
      { value: 2, inSample: { sharpe: 1.5 }, outOfSample: { sharpe: 0.3 } },
      { value: 3, inSample: { sharpe: 1.8 }, outOfSample: { sharpe: 0.4 } }
    ];
    const metrics = computeOverfitMetrics(results);
    expect(metrics.overfitWarning).toBe(true);
    expect(metrics.avgDegradation).toBeGreaterThan(0.5);
    expect(['high', 'moderate']).toContain(metrics.overfitSeverity);
  });

  test('returns no warning when OOS matches IS', () => {
    const results = [
      { value: 1, inSample: { sharpe: 1.5 }, outOfSample: { sharpe: 1.4 } },
      { value: 2, inSample: { sharpe: 1.0 }, outOfSample: { sharpe: 0.95 } },
      { value: 3, inSample: { sharpe: 0.8 }, outOfSample: { sharpe: 0.75 } }
    ];
    const metrics = computeOverfitMetrics(results);
    expect(metrics.overfitWarning).toBe(false);
    expect(metrics.avgDegradation).toBeLessThan(0.2);
    expect(metrics.overfitSeverity).toBe('low');
  });

  test('rank correlation is positive when rankings align', () => {
    const results = [
      { value: 1, inSample: { sharpe: 3.0 }, outOfSample: { sharpe: 2.8 } },
      { value: 2, inSample: { sharpe: 2.0 }, outOfSample: { sharpe: 1.9 } },
      { value: 3, inSample: { sharpe: 1.0 }, outOfSample: { sharpe: 0.9 } }
    ];
    const metrics = computeOverfitMetrics(results);
    expect(metrics.rankCorrelation).toBeGreaterThan(0.8);
  });

  test('handles empty results gracefully', () => {
    const metrics = computeOverfitMetrics([]);
    expect(metrics.avgDegradation).toBeNull();
    expect(metrics.rankCorrelation).toBeNull();
    expect(metrics.overfitWarning).toBe(false);
  });

  test('ignores results with -999 sharpe (errored backtests)', () => {
    const results = [
      { value: 1, inSample: { sharpe: -999 }, outOfSample: { sharpe: 0.5 } },
      { value: 2, inSample: { sharpe: 1.5 }, outOfSample: { sharpe: 1.3 } }
    ];
    const metrics = computeOverfitMetrics(results);
    // Should only use value=2 (value=1 has IS sharpe < 0)
    expect(metrics.avgDegradation).toBeDefined();
    expect(metrics.avgDegradation).not.toBeNull();
  });

  test('handles zero/negative IS sharpe without NaN', () => {
    const results = [
      { value: 1, inSample: { sharpe: 0 }, outOfSample: { sharpe: 0.5 } },
      { value: 2, inSample: { sharpe: -0.5 }, outOfSample: { sharpe: -0.3 } }
    ];
    const metrics = computeOverfitMetrics(results);
    // Both have IS sharpe <= 0, so valid array is empty
    expect(metrics.avgDegradation).toBeNull();
    expect(isNaN(metrics.avgDegradation)).toBe(false);
  });

  test('ignores results with OOS error', () => {
    const results = [
      { value: 1, inSample: { sharpe: 2.0 }, outOfSample: { sharpe: 1.5 } },
      { value: 2, inSample: { sharpe: 1.5 }, outOfSample: { sharpe: -999, error: 'failed' } }
    ];
    const metrics = computeOverfitMetrics(results);
    // Should only use value=1
    expect(metrics.avgDegradation).toBeDefined();
    expect(metrics.rankCorrelation).toBeDefined();
  });

  test('rank correlation is negative when rankings are inverted', () => {
    const results = [
      { value: 1, inSample: { sharpe: 3.0 }, outOfSample: { sharpe: 0.5 } },
      { value: 2, inSample: { sharpe: 2.0 }, outOfSample: { sharpe: 1.5 } },
      { value: 3, inSample: { sharpe: 1.0 }, outOfSample: { sharpe: 2.5 } }
    ];
    const metrics = computeOverfitMetrics(results);
    expect(metrics.rankCorrelation).toBeLessThan(0);
    expect(metrics.overfitWarning).toBe(true); // low rank correlation
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rolling Walk-Forward: computeRollingWindows Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeRollingWindows', () => {
  test('returns rolling=false for days < 60', () => {
    const result = computeRollingWindows(50);
    expect(result.rolling).toBe(false);
    expect(result.reason).toBeDefined();
  });

  test('returns rolling=true for days >= 60 with multiple windows', () => {
    const result = computeRollingWindows(90);
    expect(result.rolling).toBe(true);
    expect(result.windows.length).toBeGreaterThanOrEqual(2);
    expect(result.numFolds).toBeGreaterThanOrEqual(2);
    expect(result.trainDays).toBeGreaterThanOrEqual(30);
    expect(result.testDaysPerFold).toBeGreaterThanOrEqual(7);
  });

  test('windows have non-overlapping test periods', () => {
    const result = computeRollingWindows(120);
    expect(result.rolling).toBe(true);

    for (let i = 1; i < result.windows.length; i++) {
      const prev = result.windows[i - 1];
      const curr = result.windows[i];
      // Test periods should not overlap: prev test end <= curr test start (= curr trainEnd)
      expect(prev.testEndTs).toBeLessThanOrEqual(curr.trainEndTs);
    }
  });

  test('all windows cover valid time ranges', () => {
    const result = computeRollingWindows(90);
    expect(result.rolling).toBe(true);

    for (const w of result.windows) {
      expect(w.trainStartTs).toBeLessThan(w.trainEndTs);
      expect(w.trainEndTs).toBeLessThan(w.testEndTs);
      expect(w.trainDays).toBeGreaterThanOrEqual(30);
      expect(w.testDays).toBeGreaterThanOrEqual(7);
      expect(w.fold).toBeGreaterThanOrEqual(1);
      expect(w.trainLabel).toBeDefined();
      expect(w.testLabel).toBeDefined();
    }
  });

  test('total days covered = trainDays + numFolds × testDaysPerFold', () => {
    const result = computeRollingWindows(90);
    expect(result.rolling).toBe(true);
    const totalCovered = result.trainDays + result.numFolds * result.testDaysPerFold;
    expect(totalCovered).toBe(90);
  });

  test('reduces folds when not enough days for requested folds', () => {
    // With 60 days and 3 folds, train might be too short → should reduce
    const result = computeRollingWindows(60, { numFolds: 5 });
    if (result.rolling) {
      expect(result.numFolds).toBeLessThan(5);
      expect(result.trainDays).toBeGreaterThanOrEqual(30);
    }
  });

  test('handles large day counts with 3 folds', () => {
    const result = computeRollingWindows(365);
    expect(result.rolling).toBe(true);
    expect(result.numFolds).toBe(3);
    expect(result.trainDays).toBeGreaterThan(200);
    expect(result.testDaysPerFold).toBeLessThanOrEqual(30);
  });

  test('windows slide forward by stepDays', () => {
    const result = computeRollingWindows(120);
    expect(result.rolling).toBe(true);

    const DAY_MS = 24 * 60 * 60 * 1000;
    const stepMs = result.stepDays * DAY_MS;

    for (let i = 1; i < result.windows.length; i++) {
      const prevStart = result.windows[i - 1].trainStartTs;
      const currStart = result.windows[i].trainStartTs;
      expect(currStart - prevStart).toBeCloseTo(stepMs, -3); // within 1s tolerance
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rolling Walk-Forward: splitCandlesForWindow Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('splitCandlesForWindow', () => {
  const HOUR_MS = 3600000;
  const DAY_MS = 86400000;
  const BASE_TS = 1700000000000;

  const makeCandles = (count, intervalMs, startTs = BASE_TS) =>
    Array.from({ length: count }, (_, i) => ({
      timestamp: startTs + i * intervalMs,
      open: 100, high: 101, low: 99, close: 100, volume: 1000
    }));

  test('splits candles correctly for a window', () => {
    const candles = {
      '1h': makeCandles(200, HOUR_MS),
      '4h': makeCandles(50, HOUR_MS * 4),
      '15m': makeCandles(800, HOUR_MS / 4)
    };

    const window = {
      trainStartTs: BASE_TS + 10 * HOUR_MS,
      trainEndTs: BASE_TS + 100 * HOUR_MS,
      testEndTs: BASE_TS + 130 * HOUR_MS
    };

    const { train, test, splitInfo } = splitCandlesForWindow(candles, window);

    // Train candles should be within [trainStart, trainEnd]
    expect(train['1h'].length).toBeGreaterThan(0);
    expect(train['1h'].every(c => c.timestamp >= window.trainStartTs && c.timestamp <= window.trainEndTs)).toBe(true);

    // Test candles should include warm-up (before trainEnd) + test period
    expect(test['1h'].length).toBeGreaterThan(train['1h'].length);
    expect(test['1h'].every(c => c.timestamp <= window.testEndTs)).toBe(true);

    // Split info should have counts
    expect(splitInfo['1h'].trainCount).toBe(train['1h'].length);
    expect(splitInfo['1h'].testCount).toBe(test['1h'].length);
  });

  test('handles empty candle arrays', () => {
    const candles = { '1h': [], '4h': [], '15m': [] };
    const window = { trainStartTs: BASE_TS, trainEndTs: BASE_TS + DAY_MS, testEndTs: BASE_TS + 2 * DAY_MS };

    const { train, test } = splitCandlesForWindow(candles, window);
    expect(train['1h'].length).toBe(0);
    expect(test['1h'].length).toBe(0);
  });

  test('train and test sets are different arrays', () => {
    const candles = { '1h': makeCandles(100, HOUR_MS), '4h': [], '15m': [] };
    const window = {
      trainStartTs: BASE_TS,
      trainEndTs: BASE_TS + 50 * HOUR_MS,
      testEndTs: BASE_TS + 70 * HOUR_MS
    };

    const { train, test } = splitCandlesForWindow(candles, window);
    expect(train['1h']).not.toBe(test['1h']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rolling Walk-Forward: computeParameterStability Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeParameterStability', () => {
  test('perfectly stable parameter (same best in all windows)', () => {
    const windowResults = [
      { fold: 1, bestValue: 30 },
      { fold: 2, bestValue: 30 },
      { fold: 3, bestValue: 30 }
    ];
    const result = computeParameterStability(windowResults);
    expect(result.stdDev).toBe(0);
    expect(result.cv).toBe(0);
    expect(result.stabilityScore).toBe(1.0);
    expect(result.consistent).toBe(true);
    expect(result.mean).toBe(30);
  });

  test('moderately stable parameter', () => {
    const windowResults = [
      { fold: 1, bestValue: 28 },
      { fold: 2, bestValue: 30 },
      { fold: 3, bestValue: 32 }
    ];
    const result = computeParameterStability(windowResults);
    expect(result.mean).toBe(30);
    expect(result.stdDev).toBeGreaterThan(0);
    expect(result.cv).toBeGreaterThan(0);
    expect(result.cv).toBeLessThan(0.25); // moderately stable
    expect(result.consistent).toBe(true);
  });

  test('unstable parameter (wildly different across windows)', () => {
    const windowResults = [
      { fold: 1, bestValue: 10 },
      { fold: 2, bestValue: 40 },
      { fold: 3, bestValue: 5 }
    ];
    const result = computeParameterStability(windowResults);
    expect(result.cv).toBeGreaterThan(0.25);
    expect(result.consistent).toBe(false);
    expect(result.stabilityScore).toBeLessThan(0.8);
  });

  test('handles single window gracefully', () => {
    const windowResults = [{ fold: 1, bestValue: 25 }];
    const result = computeParameterStability(windowResults);
    expect(result.mean).toBe(25);
    expect(result.stdDev).toBe(0);
    expect(result.stabilityScore).toBe(1.0);
  });

  test('handles null bestValue windows', () => {
    const windowResults = [
      { fold: 1, bestValue: 30 },
      { fold: 2, bestValue: null },
      { fold: 3, bestValue: 32 }
    ];
    const result = computeParameterStability(windowResults);
    expect(result.bestValues).toHaveLength(2); // null filtered out
    expect(result.mean).toBeCloseTo(31);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Rolling Walk-Forward: aggregateRollingResults Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('aggregateRollingResults', () => {
  test('ranks by composite score (avg Sharpe penalized by variance)', () => {
    const allWindowResults = [
      {
        fold: 1,
        paramResults: [
          { value: 1, oosMetrics: { sharpe: 2.0, totalTrades: 20, totalPnlPercent: 10, winRate: 60 } },
          { value: 2, oosMetrics: { sharpe: 1.5, totalTrades: 20, totalPnlPercent: 8, winRate: 55 } }
        ]
      },
      {
        fold: 2,
        paramResults: [
          { value: 1, oosMetrics: { sharpe: 0.5, totalTrades: 15, totalPnlPercent: 2, winRate: 50 } },
          { value: 2, oosMetrics: { sharpe: 1.3, totalTrades: 15, totalPnlPercent: 7, winRate: 53 } }
        ]
      }
    ];

    const result = aggregateRollingResults(allWindowResults);
    expect(result.length).toBe(2);

    // Value 2 is more consistent (1.5, 1.3) vs value 1 (2.0, 0.5)
    // Value 2 should rank higher due to lower variance penalty
    const val2 = result.find(r => r.value === 2);
    const val1 = result.find(r => r.value === 1);
    expect(val2.compositeScore).toBeGreaterThan(val1.compositeScore);
  });

  test('marks insufficient when trades below minimum', () => {
    const allWindowResults = [
      {
        fold: 1,
        paramResults: [
          { value: 1, oosMetrics: { sharpe: 2.0, totalTrades: 3, totalPnlPercent: 10, winRate: 60 } }
        ]
      }
    ];

    const result = aggregateRollingResults(allWindowResults);
    expect(result[0].insufficient).toBe(true);
    expect(result[0].avgOosSharpe).toBe(-999);
  });

  test('handles errored OOS metrics', () => {
    const allWindowResults = [
      {
        fold: 1,
        paramResults: [
          { value: 1, oosMetrics: { sharpe: 1.5, totalTrades: 20, totalPnlPercent: 5, winRate: 55 } },
          { value: 2, oosMetrics: { error: 'failed', sharpe: -999 } }
        ]
      },
      {
        fold: 2,
        paramResults: [
          { value: 1, oosMetrics: { sharpe: 1.2, totalTrades: 15, totalPnlPercent: 4, winRate: 52 } },
          { value: 2, oosMetrics: { sharpe: 1.0, totalTrades: 15, totalPnlPercent: 3, winRate: 50 } }
        ]
      }
    ];

    const result = aggregateRollingResults(allWindowResults);
    const val1 = result.find(r => r.value === 1);
    const val2 = result.find(r => r.value === 2);

    // Value 1 has 2 valid folds, value 2 has only 1
    expect(val1.validFolds).toBe(2);
    expect(val2.validFolds).toBe(1);
  });

  test('calculates sharpeStd correctly', () => {
    const allWindowResults = [
      {
        fold: 1,
        paramResults: [
          { value: 1, oosMetrics: { sharpe: 2.0, totalTrades: 20, totalPnlPercent: 10, winRate: 60 } }
        ]
      },
      {
        fold: 2,
        paramResults: [
          { value: 1, oosMetrics: { sharpe: 2.0, totalTrades: 20, totalPnlPercent: 10, winRate: 60 } }
        ]
      }
    ];

    const result = aggregateRollingResults(allWindowResults);
    // Identical Sharpe across folds → stdDev = 0
    expect(result[0].sharpeStd).toBe(0);
  });
});
