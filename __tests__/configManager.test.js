// ═══════════════════════════════════════════════════════════════════════════════
// Tests — configManager.js
// ═══════════════════════════════════════════════════════════════════════════════

const {
  initConfigManager,
  getConfig,
  getConfigSync,
  setConfig,
  invalidateCache,
  getAllConfigs,
  _cache,
  _TTL_MS
} = require('../configManager');

// ─── Mock Supabase ────────────────────────────────────────────────────────────

function createMockSupabase(rows = [], opts = {}) {
  const mockUpsert = jest.fn().mockResolvedValue({ error: opts.upsertError || null });

  // Supabase-like chain: every method returns a thenable chain object.
  // `select()` without terminal resolves as { data, error }.
  // `.single()` and `.order()` are terminal resolvers.
  function makeChain() {
    const chain = {
      select: jest.fn().mockImplementation(() => chain),
      eq: jest.fn().mockImplementation(() => chain),
      single: jest.fn().mockImplementation(() =>
        opts.singleError
          ? Promise.resolve({ data: null, error: opts.singleError })
          : Promise.resolve({ data: opts.singleData || null, error: null })
      ),
      order: jest.fn().mockImplementation(() =>
        Promise.resolve({ data: rows, error: opts.listError || null })
      ),
      upsert: mockUpsert,
      // Make the chain itself thenable (for `await supabase.from().select()`)
      then: (resolve, reject) => {
        return Promise.resolve({
          data: opts.listError ? null : rows,
          error: opts.listError || null
        }).then(resolve, reject);
      }
    };
    return chain;
  }

  return {
    from: jest.fn().mockImplementation(() => makeChain()),
    _mocks: { mockUpsert }
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  _cache.clear();
});

// ═══════════════════════════════════════════════════════════════════════════════
// initConfigManager
// ═══════════════════════════════════════════════════════════════════════════════

describe('initConfigManager', () => {
  test('preloads all keys into cache', async () => {
    const rows = [
      { key: 'test_key', value: { foo: 'bar' } },
      { key: 'another_key', value: { x: 1 } }
    ];
    const sb = createMockSupabase(rows);
    await initConfigManager(sb);

    expect(_cache.has('test_key')).toBe(true);
    expect(_cache.get('test_key').value).toEqual({ foo: 'bar' });
    expect(_cache.has('another_key')).toBe(true);
  });

  test('handles missing table gracefully', async () => {
    const sb = createMockSupabase([], { listError: { code: '42P01', message: 'table not found' } });
    // Should not throw
    await initConfigManager(sb);
    expect(_cache.size).toBe(0);
  });

  test('handles DB error gracefully', async () => {
    const sb = createMockSupabase([], { listError: { code: 'PGRST', message: 'connection error' } });
    await initConfigManager(sb);
    expect(_cache.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getConfig (async)
// ═══════════════════════════════════════════════════════════════════════════════

describe('getConfig', () => {
  test('returns cached value if TTL is fresh', async () => {
    _cache.set('my_key', { value: { a: 1 }, fetchedAt: Date.now() });
    const result = await getConfig('my_key', { a: 0 });
    expect(result).toEqual({ a: 1 });
  });

  test('returns defaultValue when not cached and no supabase', async () => {
    // Init with null supabase
    const { initConfigManager: init } = require('../configManager');
    // Just clear cache and test default
    _cache.clear();
    const result = await getConfig('nonexistent', { fallback: true });
    expect(result).toEqual({ fallback: true });
  });

  test('returns stale cache when DB fetch fails', async () => {
    // Put a stale entry
    _cache.set('stale_key', { value: { old: true }, fetchedAt: Date.now() - _TTL_MS - 1000 });

    const sb = createMockSupabase([], { singleError: { code: 'ERR', message: 'fail' } });
    await initConfigManager(sb);

    const result = await getConfig('stale_key', { default: true });
    expect(result).toEqual({ old: true });
  });

  test('fetches from DB when cache is stale', async () => {
    // Stale cache
    _cache.set('refresh_key', { value: { old: true }, fetchedAt: Date.now() - _TTL_MS - 1000 });

    const sb = createMockSupabase([], { singleData: { value: { fresh: true } } });
    await initConfigManager(sb);

    const result = await getConfig('refresh_key', { default: true });
    expect(result).toEqual({ fresh: true });
    expect(_cache.get('refresh_key').value).toEqual({ fresh: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getConfigSync
// ═══════════════════════════════════════════════════════════════════════════════

describe('getConfigSync', () => {
  test('returns cached value', () => {
    _cache.set('sync_key', { value: { sync: true }, fetchedAt: Date.now() });
    expect(getConfigSync('sync_key')).toEqual({ sync: true });
  });

  test('returns default when not cached', () => {
    expect(getConfigSync('missing', { def: 1 })).toEqual({ def: 1 });
  });

  test('returns stale cache (no TTL check for sync)', () => {
    _cache.set('old_sync', { value: { stale: true }, fetchedAt: 0 });
    expect(getConfigSync('old_sync')).toEqual({ stale: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// setConfig
// ═══════════════════════════════════════════════════════════════════════════════

describe('setConfig', () => {
  test('updates cache immediately', async () => {
    const sb = createMockSupabase([]);
    await initConfigManager(sb);

    await setConfig('new_key', { updated: true }, 'test desc');
    expect(_cache.get('new_key').value).toEqual({ updated: true });
  });

  test('handles DB error gracefully', async () => {
    const sb = createMockSupabase([], { upsertError: { message: 'upsert fail' } });
    await initConfigManager(sb);

    const { error } = await setConfig('err_key', { x: 1 });
    expect(error).toBeTruthy();
    // Cache still updated
    expect(_cache.get('err_key').value).toEqual({ x: 1 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// invalidateCache
// ═══════════════════════════════════════════════════════════════════════════════

describe('invalidateCache', () => {
  test('removes specific key', () => {
    _cache.set('a', { value: 1, fetchedAt: Date.now() });
    _cache.set('b', { value: 2, fetchedAt: Date.now() });
    invalidateCache('a');
    expect(_cache.has('a')).toBe(false);
    expect(_cache.has('b')).toBe(true);
  });

  test('clears all when no key specified', () => {
    _cache.set('a', { value: 1, fetchedAt: Date.now() });
    _cache.set('b', { value: 2, fetchedAt: Date.now() });
    invalidateCache();
    expect(_cache.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getAllConfigs
// ═══════════════════════════════════════════════════════════════════════════════

describe('getAllConfigs', () => {
  test('returns all configs from DB', async () => {
    const rows = [
      { key: 'k1', value: { a: 1 }, description: 'desc1', updated_at: '2026-01-01' },
      { key: 'k2', value: { b: 2 }, description: 'desc2', updated_at: '2026-01-02' }
    ];
    const sb = createMockSupabase(rows);
    await initConfigManager(sb);

    const { configs, error } = await getAllConfigs();
    expect(error).toBeNull();
    expect(configs).toHaveLength(2);
  });
});
