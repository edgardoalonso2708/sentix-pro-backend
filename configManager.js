// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — Centralized Configuration Manager
// Reads from system_config table (Supabase) with in-memory cache + TTL.
// Falls back to hardcoded defaults if DB is unavailable.
// ═══════════════════════════════════════════════════════════════════════════════

const { logger } = require('./logger');

const TTL_MS = 5 * 60 * 1000; // 5 minutes cache TTL

// In-memory cache: key → { value, fetchedAt }
const cache = new Map();

let _supabase = null;
let _initialized = false;

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the config manager with a Supabase client.
 * Preloads all config keys into memory cache.
 * @param {Object} supabase - Supabase client instance
 */
async function initConfigManager(supabase) {
  _supabase = supabase;
  _initialized = true;

  try {
    const { data, error } = await supabase
      .from('system_config')
      .select('key, value');

    if (error) {
      if (error.code === '42P01') {
        logger.debug('system_config table not yet created, using defaults');
      } else {
        logger.warn('Config preload failed', { error: error.message });
      }
      return;
    }

    if (data) {
      const now = Date.now();
      for (const row of data) {
        cache.set(row.key, { value: row.value, fetchedAt: now });
      }
      logger.info('Config manager initialized', { keys: data.length });
    }
  } catch (err) {
    logger.warn('Config manager init failed, using defaults', { error: err.message });
  }
}

// ─── Read ────────────────────────────────────────────────────────────────────

/**
 * Get a config value (async). Reads from cache if fresh, otherwise fetches from DB.
 * Falls back to defaultValue if DB is unavailable.
 * @param {string} key - Config key
 * @param {*} defaultValue - Fallback value
 * @returns {Promise<*>}
 */
async function getConfig(key, defaultValue = null) {
  // Check cache first
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.fetchedAt) < TTL_MS) {
    return cached.value;
  }

  // Try DB fetch
  if (_supabase) {
    try {
      const { data, error } = await _supabase
        .from('system_config')
        .select('value')
        .eq('key', key)
        .single();

      if (!error && data) {
        cache.set(key, { value: data.value, fetchedAt: Date.now() });
        return data.value;
      }

      // Table doesn't exist yet — don't spam logs
      if (error && error.code === '42P01') {
        return cached?.value ?? defaultValue;
      }
    } catch (_) {
      // DB unreachable — use cache or default
    }
  }

  return cached?.value ?? defaultValue;
}

/**
 * Get a config value synchronously from cache only.
 * Use this in hot paths where you can't await (e.g., backtest loops).
 * @param {string} key - Config key
 * @param {*} defaultValue - Fallback value
 * @returns {*}
 */
function getConfigSync(key, defaultValue = null) {
  const cached = cache.get(key);
  if (cached) return cached.value;
  return defaultValue;
}

// ─── Write ───────────────────────────────────────────────────────────────────

/**
 * Set a config value (upserts into DB and updates cache).
 * @param {string} key - Config key
 * @param {*} value - New value (stored as JSONB)
 * @param {string} [description] - Optional description
 * @returns {Promise<{ error: Error|null }>}
 */
async function setConfig(key, value, description = null) {
  // Update cache immediately
  cache.set(key, { value, fetchedAt: Date.now() });

  if (!_supabase) return { error: null };

  try {
    const row = { key, value, updated_at: new Date().toISOString() };
    if (description !== null) row.description = description;

    const { error } = await _supabase
      .from('system_config')
      .upsert(row, { onConflict: 'key' });

    if (error) {
      logger.warn('Config set failed', { key, error: error.message });
      return { error };
    }

    return { error: null };
  } catch (err) {
    logger.warn('Config set exception', { key, error: err.message });
    return { error: err };
  }
}

// ─── Cache management ────────────────────────────────────────────────────────

/**
 * Invalidate one or all cache entries, forcing next read to hit DB.
 * @param {string} [key] - Specific key, or null to clear all
 */
function invalidateCache(key = null) {
  if (key) {
    cache.delete(key);
  } else {
    cache.clear();
  }
}

/**
 * List all cached keys (for debugging / API).
 * @returns {string[]}
 */
function getCachedKeys() {
  return [...cache.keys()];
}

/**
 * Get all config entries (for admin API).
 * @returns {Promise<{ configs: Array, error: Error|null }>}
 */
async function getAllConfigs() {
  if (!_supabase) {
    // Return from cache
    const configs = [];
    for (const [key, entry] of cache.entries()) {
      configs.push({ key, value: entry.value });
    }
    return { configs, error: null };
  }

  try {
    const { data, error } = await _supabase
      .from('system_config')
      .select('key, value, description, updated_at')
      .order('key');

    if (error) {
      if (error.code === '42P01') return { configs: [], error: null };
      return { configs: [], error };
    }

    // Refresh cache
    const now = Date.now();
    for (const row of data) {
      cache.set(row.key, { value: row.value, fetchedAt: now });
    }

    return { configs: data, error: null };
  } catch (err) {
    return { configs: [], error: err };
  }
}

module.exports = {
  initConfigManager,
  getConfig,
  getConfigSync,
  setConfig,
  invalidateCache,
  getCachedKeys,
  getAllConfigs,
  // Exposed for testing
  _cache: cache,
  _TTL_MS: TTL_MS
};
