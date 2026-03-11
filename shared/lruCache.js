// ═══════════════════════════════════════════════════════════════════════════════
// LRU CACHE — Least Recently Used cache with optional TTL
// Uses native Map (maintains insertion order) for O(1) LRU eviction
// ═══════════════════════════════════════════════════════════════════════════════

class LRUCache {
  /**
   * @param {Object} opts
   * @param {number} opts.maxSize  - Max entries before eviction (default 100)
   * @param {number} opts.ttl     - TTL in ms, 0 = no expiry (default 0)
   * @param {string} opts.name    - Cache name for stats/debugging
   */
  constructor({ maxSize = 100, ttl = 0, name = 'cache' } = {}) {
    this._map = new Map();
    this._maxSize = maxSize;
    this._ttl = ttl;
    this._name = name;
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  /**
   * Get a value. Moves entry to MRU position. Returns undefined if missing or expired.
   */
  get(key) {
    const entry = this._map.get(key);
    if (!entry) {
      this._misses++;
      return undefined;
    }
    if (this._isExpired(entry)) {
      this._map.delete(key);
      this._misses++;
      return undefined;
    }
    // Move to MRU: delete + re-set puts it at end of Map iteration order
    this._map.delete(key);
    this._map.set(key, entry);
    this._hits++;
    return entry.value;
  }

  /**
   * Set a value. Evicts LRU entry if at capacity.
   */
  set(key, value) {
    // If key exists, delete first so re-set moves it to MRU
    if (this._map.has(key)) {
      this._map.delete(key);
    }
    // Evict LRU (first entry in Map) if at capacity
    if (this._map.size >= this._maxSize) {
      const lruKey = this._map.keys().next().value;
      this._map.delete(lruKey);
      this._evictions++;
    }
    this._map.set(key, { value, createdAt: Date.now() });
  }

  /**
   * Check if key exists and is not expired. Does NOT promote to MRU.
   */
  has(key) {
    const entry = this._map.get(key);
    if (!entry) return false;
    if (this._isExpired(entry)) {
      this._map.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Delete a specific key.
   */
  delete(key) {
    return this._map.delete(key);
  }

  /**
   * Clear all entries and reset stats.
   */
  clear() {
    this._map.clear();
    this._hits = 0;
    this._misses = 0;
    this._evictions = 0;
  }

  get size() {
    return this._map.size;
  }

  /**
   * Return cache statistics.
   */
  stats() {
    return {
      name: this._name,
      size: this._map.size,
      maxSize: this._maxSize,
      ttl: this._ttl,
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      hitRate: (this._hits + this._misses) > 0
        ? +(this._hits / (this._hits + this._misses)).toFixed(3)
        : 0
    };
  }

  /**
   * Iterate over all non-expired entries (for debugging/stats).
   */
  entries() {
    const result = [];
    for (const [key, entry] of this._map.entries()) {
      if (!this._isExpired(entry)) {
        result.push([key, entry.value]);
      }
    }
    return result;
  }

  /** @private */
  _isExpired(entry) {
    return this._ttl > 0 && (Date.now() - entry.createdAt) >= this._ttl;
  }
}

module.exports = { LRUCache };
