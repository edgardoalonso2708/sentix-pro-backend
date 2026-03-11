const { LRUCache } = require('../shared/lruCache');

describe('LRUCache', () => {
  describe('constructor', () => {
    it('creates with default options', () => {
      const cache = new LRUCache();
      expect(cache.size).toBe(0);
      const s = cache.stats();
      expect(s.maxSize).toBe(100);
      expect(s.ttl).toBe(0);
      expect(s.name).toBe('cache');
    });

    it('accepts custom options', () => {
      const cache = new LRUCache({ maxSize: 5, ttl: 1000, name: 'test' });
      const s = cache.stats();
      expect(s.maxSize).toBe(5);
      expect(s.ttl).toBe(1000);
      expect(s.name).toBe('test');
    });
  });

  describe('get / set', () => {
    it('stores and retrieves values', () => {
      const cache = new LRUCache({ maxSize: 10 });
      cache.set('a', 1);
      cache.set('b', { x: 2 });
      expect(cache.get('a')).toBe(1);
      expect(cache.get('b')).toEqual({ x: 2 });
    });

    it('returns undefined for missing keys', () => {
      const cache = new LRUCache();
      expect(cache.get('missing')).toBeUndefined();
    });

    it('overwrites existing keys', () => {
      const cache = new LRUCache({ maxSize: 10 });
      cache.set('a', 1);
      cache.set('a', 2);
      expect(cache.get('a')).toBe(2);
      expect(cache.size).toBe(1);
    });
  });

  describe('LRU eviction', () => {
    it('evicts least recently used when full', () => {
      const cache = new LRUCache({ maxSize: 3 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      // Cache full: [a, b, c]
      cache.set('d', 4);
      // 'a' was LRU, should be evicted
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);
      expect(cache.get('d')).toBe(4);
      expect(cache.size).toBe(3);
    });

    it('get() promotes entry to MRU', () => {
      const cache = new LRUCache({ maxSize: 3 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      // Access 'a' — promotes it to MRU
      cache.get('a');
      // Now order is [b, c, a], so 'b' is LRU
      cache.set('d', 4);
      expect(cache.get('a')).toBe(1); // promoted, still here
      expect(cache.get('b')).toBeUndefined(); // evicted
      expect(cache.get('d')).toBe(4);
    });

    it('set() on existing key promotes to MRU', () => {
      const cache = new LRUCache({ maxSize: 3 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      // Update 'a' — promotes to MRU
      cache.set('a', 10);
      cache.set('d', 4);
      // 'b' should be evicted (was LRU after 'a' was promoted)
      expect(cache.get('a')).toBe(10);
      expect(cache.get('b')).toBeUndefined();
    });

    it('tracks eviction count', () => {
      const cache = new LRUCache({ maxSize: 2 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3); // evicts 'a'
      cache.set('d', 4); // evicts 'b'
      expect(cache.stats().evictions).toBe(2);
    });
  });

  describe('TTL expiration', () => {
    it('returns undefined for expired entries', () => {
      const cache = new LRUCache({ maxSize: 10, ttl: 50 });
      cache.set('a', 1);
      // Manually expire by manipulating internal state
      const entry = cache._map.get('a');
      entry.createdAt = Date.now() - 100;
      expect(cache.get('a')).toBeUndefined();
    });

    it('returns value for non-expired entries', () => {
      const cache = new LRUCache({ maxSize: 10, ttl: 60000 });
      cache.set('a', 1);
      expect(cache.get('a')).toBe(1);
    });

    it('has() returns false for expired entries', () => {
      const cache = new LRUCache({ maxSize: 10, ttl: 50 });
      cache.set('a', 1);
      const entry = cache._map.get('a');
      entry.createdAt = Date.now() - 100;
      expect(cache.has('a')).toBe(false);
    });

    it('no TTL means entries never expire', () => {
      const cache = new LRUCache({ maxSize: 10, ttl: 0 });
      cache.set('a', 1);
      const entry = cache._map.get('a');
      entry.createdAt = Date.now() - 999999999;
      expect(cache.get('a')).toBe(1);
    });

    it('expired entries are cleaned up on access', () => {
      const cache = new LRUCache({ maxSize: 10, ttl: 50 });
      cache.set('a', 1);
      const entry = cache._map.get('a');
      entry.createdAt = Date.now() - 100;
      cache.get('a'); // triggers cleanup
      expect(cache._map.has('a')).toBe(false);
    });
  });

  describe('has()', () => {
    it('returns true for existing non-expired keys', () => {
      const cache = new LRUCache({ maxSize: 10 });
      cache.set('a', 1);
      expect(cache.has('a')).toBe(true);
    });

    it('returns false for missing keys', () => {
      const cache = new LRUCache({ maxSize: 10 });
      expect(cache.has('missing')).toBe(false);
    });

    it('does NOT promote entry to MRU', () => {
      const cache = new LRUCache({ maxSize: 3 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      // has() should NOT promote 'a'
      cache.has('a');
      cache.set('d', 4);
      // 'a' was still LRU and should be evicted
      expect(cache.has('a')).toBe(false);
    });
  });

  describe('delete()', () => {
    it('removes an entry', () => {
      const cache = new LRUCache({ maxSize: 10 });
      cache.set('a', 1);
      cache.delete('a');
      expect(cache.get('a')).toBeUndefined();
      expect(cache.size).toBe(0);
    });

    it('returns true when key existed', () => {
      const cache = new LRUCache({ maxSize: 10 });
      cache.set('a', 1);
      expect(cache.delete('a')).toBe(true);
    });

    it('returns false when key did not exist', () => {
      const cache = new LRUCache({ maxSize: 10 });
      expect(cache.delete('missing')).toBe(false);
    });
  });

  describe('clear()', () => {
    it('removes all entries and resets stats', () => {
      const cache = new LRUCache({ maxSize: 10 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.get('a'); // hit
      cache.get('miss'); // miss
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.stats().hits).toBe(0);
      expect(cache.stats().misses).toBe(0);
    });
  });

  describe('stats()', () => {
    it('tracks hits and misses', () => {
      const cache = new LRUCache({ maxSize: 10, name: 'test' });
      cache.set('a', 1);
      cache.get('a');       // hit
      cache.get('a');       // hit
      cache.get('missing'); // miss
      const s = cache.stats();
      expect(s.hits).toBe(2);
      expect(s.misses).toBe(1);
      expect(s.hitRate).toBeCloseTo(0.667, 2);
      expect(s.name).toBe('test');
    });

    it('hitRate is 0 when no accesses', () => {
      const cache = new LRUCache();
      expect(cache.stats().hitRate).toBe(0);
    });
  });

  describe('entries()', () => {
    it('returns non-expired entries', () => {
      const cache = new LRUCache({ maxSize: 10, ttl: 60000 });
      cache.set('a', 1);
      cache.set('b', 2);
      const entries = cache.entries();
      expect(entries).toEqual([['a', 1], ['b', 2]]);
    });

    it('filters out expired entries', () => {
      const cache = new LRUCache({ maxSize: 10, ttl: 50 });
      cache.set('a', 1);
      cache.set('b', 2);
      // Expire 'a'
      cache._map.get('a').createdAt = Date.now() - 100;
      const entries = cache.entries();
      expect(entries).toEqual([['b', 2]]);
    });
  });

  describe('edge cases', () => {
    it('maxSize = 1', () => {
      const cache = new LRUCache({ maxSize: 1 });
      cache.set('a', 1);
      cache.set('b', 2);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe(2);
      expect(cache.size).toBe(1);
    });

    it('handles falsy values correctly', () => {
      const cache = new LRUCache({ maxSize: 10 });
      cache.set('zero', 0);
      cache.set('empty', '');
      cache.set('null', null);
      cache.set('false', false);
      expect(cache.get('zero')).toBe(0);
      expect(cache.get('empty')).toBe('');
      expect(cache.get('null')).toBe(null);
      expect(cache.get('false')).toBe(false);
    });
  });
});
