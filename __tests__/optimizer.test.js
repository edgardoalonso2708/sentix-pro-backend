const {
  generateParamValues,
  startOptimizationJob,
  getJobStatus,
  getAllJobs,
  cleanupJobs,
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
