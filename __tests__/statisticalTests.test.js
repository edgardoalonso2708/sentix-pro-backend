const {
  standardNormalCDF,
  studentTCDF,
  tTestOneSample,
  binomialTest,
  bootstrapPValue,
  computeConfidenceIntervals,
  assessSignificance,
  runStatisticalTests
} = require('../statisticalTests');

// ═══════════════════════════════════════════════════════════════════════════════
// standardNormalCDF
// ═══════════════════════════════════════════════════════════════════════════════
describe('standardNormalCDF', () => {
  test('CDF(0) ≈ 0.5', () => {
    expect(standardNormalCDF(0)).toBeCloseTo(0.5, 6);
  });

  test('CDF(1.96) ≈ 0.975', () => {
    expect(standardNormalCDF(1.96)).toBeCloseTo(0.975, 3);
  });

  test('CDF(-1.96) ≈ 0.025', () => {
    expect(standardNormalCDF(-1.96)).toBeCloseTo(0.025, 3);
  });

  test('CDF(3) ≈ 0.9987', () => {
    expect(standardNormalCDF(3)).toBeCloseTo(0.9987, 3);
  });

  test('symmetry: CDF(z) + CDF(-z) ≈ 1', () => {
    for (const z of [0.5, 1, 1.5, 2, 2.5, 3]) {
      expect(standardNormalCDF(z) + standardNormalCDF(-z)).toBeCloseTo(1, 6);
    }
  });

  test('extreme values: CDF(10) ≈ 1, CDF(-10) ≈ 0', () => {
    expect(standardNormalCDF(10)).toBeCloseTo(1, 6);
    expect(standardNormalCDF(-10)).toBeCloseTo(0, 6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// studentTCDF
// ═══════════════════════════════════════════════════════════════════════════════
describe('studentTCDF', () => {
  test('CDF(0, any df) ≈ 0.5', () => {
    expect(studentTCDF(0, 5)).toBeCloseTo(0.5, 4);
    expect(studentTCDF(0, 10)).toBeCloseTo(0.5, 4);
    expect(studentTCDF(0, 100)).toBeCloseTo(0.5, 4);
  });

  test('df >= 30 matches normal approximation', () => {
    const t = 2.0;
    const normalCDF = standardNormalCDF(t);
    const tCDF = studentTCDF(t, 50);
    expect(Math.abs(normalCDF - tCDF)).toBeLessThan(0.01);
  });

  test('df = 5 has wider tails than normal', () => {
    // For small df, p-value should be LARGER (wider tails)
    const t = 2.0;
    const normalP = 2 * (1 - standardNormalCDF(t));
    const studentP = 2 * (1 - studentTCDF(t, 5));
    expect(studentP).toBeGreaterThan(normalP);
  });

  test('CDF(-t, df) + CDF(t, df) ≈ 1 (symmetry)', () => {
    for (const df of [5, 10, 20]) {
      for (const t of [1, 2, 3]) {
        expect(studentTCDF(t, df) + studentTCDF(-t, df)).toBeCloseTo(1, 4);
      }
    }
  });

  test('known value: df=10, t=2.228 → p ≈ 0.05 (two-tailed)', () => {
    // t_{0.025, 10} ≈ 2.228
    const pValue = 2 * (1 - studentTCDF(2.228, 10));
    expect(pValue).toBeCloseTo(0.05, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// tTestOneSample
// ═══════════════════════════════════════════════════════════════════════════════
describe('tTestOneSample', () => {
  test('all zeros: t=0, p=1', () => {
    const result = tTestOneSample([0, 0, 0, 0, 0]);
    expect(result.tStatistic).toBe(0);
    expect(result.pValue).toBe(1);
    expect(result.mean).toBe(0);
  });

  test('clear positive mean: p < 0.05', () => {
    const values = [10, 12, 11, 13, 9, 14, 11, 12, 10, 13, 15, 10, 12, 11, 14];
    const result = tTestOneSample(values, 0);
    expect(result.mean).toBeGreaterThan(0);
    expect(result.tStatistic).toBeGreaterThan(0);
    expect(result.pValue).toBeLessThan(0.001);
  });

  test('balanced values around zero: p close to 1', () => {
    const values = [1, -1, 2, -2, 1, -1, 2, -2, 1, -1];
    const result = tTestOneSample(values, 0);
    expect(result.pValue).toBeGreaterThan(0.5);
  });

  test('guard: single value returns safe defaults', () => {
    const result = tTestOneSample([5]);
    expect(result.pValue).toBe(1);
    expect(result.tStatistic).toBe(0);
  });

  test('guard: empty array returns safe defaults', () => {
    const result = tTestOneSample([]);
    expect(result.pValue).toBe(1);
  });

  test('guard: null returns safe defaults', () => {
    const result = tTestOneSample(null);
    expect(result.pValue).toBe(1);
  });

  test('large sample with known mean detects significance', () => {
    // 100 values with mean ~50, std ~10 → highly significant vs mu0=0
    const values = Array.from({ length: 100 }, (_, i) => 50 + (i % 10) - 5);
    const result = tTestOneSample(values, 0);
    expect(result.pValue).toBeLessThan(0.001);
    expect(result.df).toBe(99);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// binomialTest
// ═══════════════════════════════════════════════════════════════════════════════
describe('binomialTest', () => {
  test('50/100: not significant (p ≈ 1)', () => {
    const result = binomialTest(50, 100, 0.5);
    expect(result.pValue).toBeGreaterThan(0.5);
    expect(result.observedRate).toBe(50);
  });

  test('70/100: significant (p < 0.05)', () => {
    const result = binomialTest(70, 100, 0.5);
    expect(result.pValue).toBeLessThan(0.001);
    expect(result.observedRate).toBe(70);
  });

  test('90/100: highly significant (p < 0.001)', () => {
    const result = binomialTest(90, 100, 0.5);
    expect(result.pValue).toBeLessThan(0.0001);
  });

  test('guard: 0 trials returns safe defaults', () => {
    const result = binomialTest(0, 0, 0.5);
    expect(result.pValue).toBe(1);
    expect(result.observedRate).toBe(0);
  });

  test('z-statistic sign matches direction', () => {
    const above = binomialTest(70, 100, 0.5);
    const below = binomialTest(30, 100, 0.5);
    expect(above.zStatistic).toBeGreaterThan(0);
    expect(below.zStatistic).toBeLessThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// bootstrapPValue
// ═══════════════════════════════════════════════════════════════════════════════
describe('bootstrapPValue', () => {
  test('all positive values: p = 0', () => {
    const result = bootstrapPValue([0.5, 1.0, 1.5, 2.0], 0);
    expect(result.pValue).toBe(0);
    expect(result.countBelow).toBe(0);
  });

  test('all negative values: p = 1', () => {
    const result = bootstrapPValue([-2, -1, -0.5], 0);
    expect(result.pValue).toBe(1);
    expect(result.countBelow).toBe(3);
  });

  test('mixed values: correct fraction', () => {
    // [-1, 0, 1, 2, 3] → 2 values <= 0 out of 5
    const result = bootstrapPValue([-1, 0, 1, 2, 3], 0);
    expect(result.pValue).toBe(0.4);
    expect(result.countBelow).toBe(2);
    expect(result.total).toBe(5);
  });

  test('empty distribution: p = 1', () => {
    const result = bootstrapPValue([], 0);
    expect(result.pValue).toBe(1);
    expect(result.total).toBe(0);
  });

  test('null distribution: p = 1', () => {
    const result = bootstrapPValue(null, 0);
    expect(result.pValue).toBe(1);
  });

  test('profit factor threshold=1', () => {
    // [0.5, 0.8, 1.0, 1.2, 1.5] → 3 values <= 1 out of 5
    const result = bootstrapPValue([0.5, 0.8, 1.0, 1.2, 1.5], 1);
    expect(result.pValue).toBe(0.6);
    expect(result.countBelow).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// computeConfidenceIntervals
// ═══════════════════════════════════════════════════════════════════════════════
describe('computeConfidenceIntervals', () => {
  test('extracts CI from percentiles correctly', () => {
    const percentiles = {
      p2_5: { returnPct: -5, maxDrawdownPct: 2, sharpe: -0.5, winRate: 40, finalEquity: 9500 },
      p5: { returnPct: -3, maxDrawdownPct: 3, sharpe: -0.2, winRate: 42, finalEquity: 9700 },
      p50: { returnPct: 10, maxDrawdownPct: 8, sharpe: 1.2, winRate: 55, finalEquity: 11000 },
      p95: { returnPct: 25, maxDrawdownPct: 15, sharpe: 2.5, winRate: 68, finalEquity: 12500 },
      p97_5: { returnPct: 30, maxDrawdownPct: 18, sharpe: 3.0, winRate: 72, finalEquity: 13000 }
    };

    const result = computeConfidenceIntervals(percentiles);
    expect(result).not.toBeNull();

    // 95% CI uses p2_5 and p97_5
    expect(result.ci95.returnPct.lower).toBe(-5);
    expect(result.ci95.returnPct.median).toBe(10);
    expect(result.ci95.returnPct.upper).toBe(30);

    // 90% CI uses p5 and p95
    expect(result.ci90.sharpe.lower).toBe(-0.2);
    expect(result.ci90.sharpe.median).toBe(1.2);
    expect(result.ci90.sharpe.upper).toBe(2.5);
  });

  test('null percentiles → null', () => {
    expect(computeConfidenceIntervals(null)).toBeNull();
  });

  test('missing p2_5/p97_5 → null values in ci95', () => {
    const percentiles = {
      p5: { returnPct: -3 },
      p50: { returnPct: 10 },
      p95: { returnPct: 25 }
    };
    const result = computeConfidenceIntervals(percentiles);
    expect(result.ci95.returnPct.lower).toBeNull();
    expect(result.ci95.returnPct.upper).toBeNull();
    expect(result.ci90.returnPct.lower).toBe(-3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// assessSignificance
// ═══════════════════════════════════════════════════════════════════════════════
describe('assessSignificance', () => {
  test('all p-values < 0.001 → highly significant, ★★★', () => {
    const result = assessSignificance({
      pnlPValue: 0.0001, winRatePValue: 0.0005, sharpePValue: 0.0003, profitFactorPValue: 0.0002
    }, 50);
    expect(result.level).toBe('highly_significant');
    expect(result.stars).toBe(3);
    expect(result.confidence).toBeGreaterThan(99);
  });

  test('p-values between 0.01 and 0.05 → marginally significant, ★', () => {
    const result = assessSignificance({
      pnlPValue: 0.03, winRatePValue: 0.04, sharpePValue: 0.02, profitFactorPValue: 0.01
    }, 40);
    expect(result.level).toBe('marginally_significant');
    expect(result.stars).toBe(1);
  });

  test('p-values > 0.05 → not significant, 0 stars', () => {
    const result = assessSignificance({
      pnlPValue: 0.2, winRatePValue: 0.3, sharpePValue: 0.15, profitFactorPValue: 0.1
    }, 30);
    expect(result.level).toBe('not_significant');
    expect(result.stars).toBe(0);
  });

  test('low trade count < 10 → warning', () => {
    const result = assessSignificance({
      pnlPValue: 0.001, sharpePValue: 0.001
    }, 8);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('<10')
    ]));
  });

  test('trade count between 10-30 → warning', () => {
    const result = assessSignificance({
      pnlPValue: 0.001, sharpePValue: 0.001
    }, 20);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('<30')
    ]));
  });

  test('no primary p-values → insufficient data', () => {
    const result = assessSignificance({
      pnlPValue: null, sharpePValue: null
    }, 50);
    expect(result.level).toBe('insufficient_data');
    expect(result.stars).toBe(0);
  });

  test('uses max primary p-value (Bonferroni-conservative)', () => {
    // pnlPValue=0.001 (significant) but sharpePValue=0.08 (not significant)
    // Max = 0.08 → not significant
    const result = assessSignificance({
      pnlPValue: 0.001, sharpePValue: 0.08
    }, 50);
    expect(result.level).toBe('not_significant');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// runStatisticalTests (integration)
// ═══════════════════════════════════════════════════════════════════════════════
describe('runStatisticalTests', () => {
  test('50 positive trades → significant', () => {
    const trades = Array.from({ length: 50 }, () => ({ pnl: 100 + Math.random() * 50 }));
    const result = runStatisticalTests(trades, null);
    expect(result.pnlTest.pValue).toBeLessThan(0.001);
    expect(result.winRateTest.pValue).toBeLessThan(0.001);
    expect(result.assessment.level).not.toBe('not_significant');
  });

  test('trades with mean ≈ 0 → not significant P&L', () => {
    // Alternating +100 and -100
    const trades = Array.from({ length: 50 }, (_, i) => ({ pnl: i % 2 === 0 ? 100 : -100 }));
    const result = runStatisticalTests(trades, null);
    expect(result.pnlTest.pValue).toBeGreaterThan(0.5);
    expect(result.winRateTest.observedRate).toBe(50);
  });

  test('null MC → partial results (no bootstrap tests)', () => {
    const trades = Array.from({ length: 20 }, () => ({ pnl: 50 }));
    const result = runStatisticalTests(trades, null);
    expect(result.pnlTest).not.toBeNull();
    expect(result.winRateTest).not.toBeNull();
    expect(result.sharpeTest).toBeNull();
    expect(result.profitFactorTest).toBeNull();
    expect(result.confidenceIntervals).toBeNull();
  });

  test('with MC containing _raw arrays → bootstrap tests populated', () => {
    const trades = Array.from({ length: 20 }, () => ({ pnl: 50 }));
    const mockMC = {
      skipped: false,
      percentiles: {
        p2_5: { returnPct: 5, maxDrawdownPct: 1, sharpe: 0.5, winRate: 55, finalEquity: 10500 },
        p5: { returnPct: 8, maxDrawdownPct: 2, sharpe: 0.8, winRate: 58, finalEquity: 10800 },
        p50: { returnPct: 20, maxDrawdownPct: 5, sharpe: 1.5, winRate: 65, finalEquity: 12000 },
        p95: { returnPct: 35, maxDrawdownPct: 10, sharpe: 2.5, winRate: 75, finalEquity: 13500 },
        p97_5: { returnPct: 40, maxDrawdownPct: 12, sharpe: 3.0, winRate: 78, finalEquity: 14000 }
      },
      _rawSharpes: [0.5, 0.8, 1.0, 1.2, 1.5, 2.0, 2.5],
      _rawProfitFactors: [1.2, 1.5, 1.8, 2.0, 2.5]
    };
    const result = runStatisticalTests(trades, mockMC);
    expect(result.sharpeTest).not.toBeNull();
    expect(result.sharpeTest.pValue).toBe(0);  // all sharpes > 0
    expect(result.profitFactorTest).not.toBeNull();
    expect(result.profitFactorTest.pValue).toBe(0);  // all PFs > 1
    expect(result.confidenceIntervals).not.toBeNull();
    expect(result.confidenceIntervals.ci95.returnPct.lower).toBe(5);
  });

  test('< 2 trades → insufficient data', () => {
    const result = runStatisticalTests([{ pnl: 100 }], null);
    expect(result.assessment.level).toBe('insufficient_data');
    expect(result.pnlTest).toBeNull();
    expect(result.winRateTest).toBeNull();
  });

  test('null trades → insufficient data', () => {
    const result = runStatisticalTests(null, null);
    expect(result.assessment.level).toBe('insufficient_data');
  });
});
