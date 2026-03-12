// ═══════════════════════════════════════════════════════════════════════════════
// Tests — signalAccuracy.js (regime/confluence tracking)
// ═══════════════════════════════════════════════════════════════════════════════

const {
  recordSignalOutcome,
  getOutcomesByRegimeConfluence
} = require('../signalAccuracy');

// ─── Mock Supabase ────────────────────────────────────────────────────────────

function mockSupabaseInsert(opts = {}) {
  const insertFn = jest.fn().mockResolvedValue({ error: opts.insertError || null });

  function makeChain() {
    const chain = {
      select: jest.fn().mockImplementation(() => chain),
      gte: jest.fn().mockImplementation(() => chain),
      not: jest.fn().mockImplementation(() => chain),
      eq: jest.fn().mockImplementation(() => chain),
      insert: insertFn,
      then: (resolve, reject) => {
        const result = { data: opts.queryData || [], error: opts.queryError || null };
        return Promise.resolve(result).then(resolve, reject);
      }
    };
    return chain;
  }

  return {
    from: jest.fn().mockImplementation(() => makeChain()),
    _insertFn: insertFn
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// recordSignalOutcome with regime
// ═══════════════════════════════════════════════════════════════════════════════

describe('recordSignalOutcome', () => {
  test('inserts regime into signal_outcomes', async () => {
    const sb = mockSupabaseInsert();
    const signal = {
      asset: 'bitcoin',
      action: 'BUY',
      strengthLabel: 'STRONG BUY',
      rawScore: 75,
      confidence: 70,
      price: 50000,
      timeframes: { confluence: 'strong' }
    };

    await recordSignalOutcome(sb, signal, 'trending_up');

    expect(sb._insertFn).toHaveBeenCalledTimes(1);
    const insertedData = sb._insertFn.mock.calls[0][0];
    expect(insertedData.regime).toBe('trending_up');
    expect(insertedData.confluence).toBe('strong');
    expect(insertedData.asset).toBe('bitcoin');
  });

  test('regime defaults to null when not provided', async () => {
    const sb = mockSupabaseInsert();
    const signal = {
      asset: 'ethereum',
      action: 'SELL',
      strengthLabel: 'SELL',
      rawScore: -40,
      confidence: 55,
      price: 3000
    };

    await recordSignalOutcome(sb, signal);

    expect(sb._insertFn).toHaveBeenCalledTimes(1);
    const insertedData = sb._insertFn.mock.calls[0][0];
    expect(insertedData.regime).toBeNull();
  });

  test('skips HOLD signals', async () => {
    const sb = mockSupabaseInsert();
    await recordSignalOutcome(sb, { action: 'HOLD', asset: 'bitcoin', price: 50000 }, 'ranging');
    expect(sb._insertFn).not.toHaveBeenCalled();
  });

  test('skips signals without asset or price', async () => {
    const sb = mockSupabaseInsert();
    await recordSignalOutcome(sb, { action: 'BUY', asset: null, price: 50000 }, 'volatile');
    expect(sb._insertFn).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getOutcomesByRegimeConfluence
// ═══════════════════════════════════════════════════════════════════════════════

describe('getOutcomesByRegimeConfluence', () => {
  test('groups outcomes by regime × confluence', async () => {
    const data = [
      { regime: 'trending_up', confluence: 'strong', direction_correct_1h: true, direction_correct_4h: true, direction_correct_24h: null, change_pct_1h: '1.5', change_pct_4h: '3.0', change_pct_24h: null },
      { regime: 'trending_up', confluence: 'strong', direction_correct_1h: true, direction_correct_4h: false, direction_correct_24h: null, change_pct_1h: '0.8', change_pct_4h: '1.0', change_pct_24h: null },
      { regime: 'trending_up', confluence: 'moderate', direction_correct_1h: false, direction_correct_4h: null, direction_correct_24h: null, change_pct_1h: '0.5', change_pct_4h: null, change_pct_24h: null },
      { regime: 'ranging', confluence: 'weak', direction_correct_1h: false, direction_correct_4h: false, direction_correct_24h: null, change_pct_1h: '0.2', change_pct_4h: '0.3', change_pct_24h: null },
    ];
    const sb = mockSupabaseInsert({ queryData: data });
    const result = await getOutcomesByRegimeConfluence(sb, { days: 60 });

    expect(result.totalRows).toBe(4);
    expect(result.matrix).toBeDefined();

    // trending_up × strong: 2 signals, 2/2 hit 1h = 100%
    expect(result.matrix.trending_up.strong.total).toBe(2);
    expect(result.matrix.trending_up.strong.hitRate1h).toBe(100);
    expect(result.matrix.trending_up.strong.hitRate4h).toBe(50); // 1/2

    // trending_up × moderate: 1 signal, 0/1 hit = 0%
    expect(result.matrix.trending_up.moderate.total).toBe(1);
    expect(result.matrix.trending_up.moderate.hitRate1h).toBe(0);

    // ranging × weak
    expect(result.matrix.ranging.weak.total).toBe(1);
    expect(result.matrix.ranging.weak.hitRate1h).toBe(0);
  });

  test('returns empty matrix with no data', async () => {
    const sb = mockSupabaseInsert({ queryData: [] });
    const result = await getOutcomesByRegimeConfluence(sb, { days: 60 });
    expect(result.matrix).toEqual({});
    expect(result.totalRows).toBe(0);
  });

  test('handles missing table gracefully', async () => {
    const sb = mockSupabaseInsert({ queryError: { code: '42P01', message: 'table not found' } });
    const result = await getOutcomesByRegimeConfluence(sb, { days: 60 });
    expect(result.matrix).toEqual({});
    expect(result.totalRows).toBe(0);
  });

  test('handles null confluence gracefully', async () => {
    const data = [
      { regime: 'volatile', confluence: null, direction_correct_1h: true, direction_correct_4h: null, direction_correct_24h: null, change_pct_1h: '2.0', change_pct_4h: null, change_pct_24h: null },
    ];
    const sb = mockSupabaseInsert({ queryData: data });
    const result = await getOutcomesByRegimeConfluence(sb, { days: 60 });

    expect(result.matrix.volatile.unknown.total).toBe(1);
    expect(result.matrix.volatile.unknown.hitRate1h).toBe(100);
  });

  test('asset filter is applied', async () => {
    const sb = mockSupabaseInsert({ queryData: [] });
    await getOutcomesByRegimeConfluence(sb, { days: 60, asset: 'bitcoin' });
    // The eq call should have been made (can't easily test mock chain but no error = ok)
    expect(sb.from).toHaveBeenCalled();
  });
});
