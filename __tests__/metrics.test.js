const { MetricsCollector } = require('../shared/metrics');

describe('MetricsCollector', () => {
  let m;

  beforeEach(() => {
    m = new MetricsCollector();
  });

  describe('counters', () => {
    it('starts at 0', () => {
      expect(m.getCounter('test')).toBe(0);
    });

    it('increments by 1 by default', () => {
      m.counter('req');
      m.counter('req');
      m.counter('req');
      expect(m.getCounter('req')).toBe(3);
    });

    it('increments by custom amount', () => {
      m.counter('bytes', 1024);
      m.counter('bytes', 512);
      expect(m.getCounter('bytes')).toBe(1536);
    });

    it('tracks multiple counters independently', () => {
      m.counter('a');
      m.counter('b');
      m.counter('b');
      expect(m.getCounter('a')).toBe(1);
      expect(m.getCounter('b')).toBe(2);
    });
  });

  describe('histograms', () => {
    it('returns zeros for empty histogram', () => {
      const h = m.getHistogram('empty');
      expect(h.count).toBe(0);
      expect(h.min).toBe(0);
      expect(h.avg).toBe(0);
      expect(h.p50).toBe(0);
      expect(h.p95).toBe(0);
      expect(h.p99).toBe(0);
    });

    it('computes percentiles correctly', () => {
      // Insert 100 values: 1..100
      for (let i = 1; i <= 100; i++) m.histogram('latency', i);
      const h = m.getHistogram('latency');
      expect(h.count).toBe(100);
      expect(h.min).toBe(1);
      expect(h.max).toBe(100);
      expect(h.avg).toBe(51); // rounded avg of 1..100
      expect(h.p50).toBe(51);
      expect(h.p95).toBe(96);
      expect(h.p99).toBe(100);
    });

    it('caps at MAX_HISTOGRAM_SAMPLES (1000)', () => {
      for (let i = 0; i < 1500; i++) m.histogram('big', i);
      const h = m.getHistogram('big');
      expect(h.count).toBe(1000);
      // Should keep the most recent 1000 values (500..1499)
      expect(h.min).toBe(500);
      expect(h.max).toBe(1499);
    });

    it('single value histogram', () => {
      m.histogram('single', 42);
      const h = m.getHistogram('single');
      expect(h.count).toBe(1);
      expect(h.min).toBe(42);
      expect(h.max).toBe(42);
      expect(h.avg).toBe(42);
      expect(h.p50).toBe(42);
      expect(h.p95).toBe(42);
      expect(h.p99).toBe(42);
    });
  });

  describe('gauges', () => {
    it('returns 0 for unset gauge', () => {
      expect(m.getGauge('missing')).toBe(0);
    });

    it('stores and retrieves values', () => {
      m.gauge('memory', 85000000);
      expect(m.getGauge('memory')).toBe(85000000);
    });

    it('overwrites previous value', () => {
      m.gauge('clients', 5);
      m.gauge('clients', 8);
      expect(m.getGauge('clients')).toBe(8);
    });
  });

  describe('snapshot()', () => {
    it('returns all metrics as JSON-serializable object', () => {
      m.counter('req');
      m.histogram('latency', 10);
      m.gauge('mem', 42);

      const snap = m.snapshot();
      expect(snap.collectedAt).toBeDefined();
      expect(typeof snap.uptimeSeconds).toBe('number');
      expect(snap.counters.req).toBe(1);
      expect(snap.histograms.latency.count).toBe(1);
      expect(snap.gauges.mem).toBe(42);
    });

    it('returns empty collections when no metrics', () => {
      const snap = m.snapshot();
      expect(snap.counters).toEqual({});
      expect(snap.histograms).toEqual({});
      expect(snap.gauges).toEqual({});
    });
  });

  describe('merge()', () => {
    it('merges external snapshot with namespace prefix', () => {
      const externalSnap = {
        counters: { 'provider.coingecko.success': 10 },
        histograms: { 'cycle.duration': { count: 5, min: 100, max: 500, avg: 300, p50: 250, p95: 480, p99: 500 } },
        gauges: { uptime: 600 }
      };

      m.merge('market', externalSnap);

      const snap = m.snapshot();
      expect(snap.counters['market.provider.coingecko.success']).toBe(10);
      expect(snap.histograms['market.cycle.duration'].count).toBe(5);
      expect(snap.gauges['market.uptime']).toBe(600);
    });

    it('handles null/undefined gracefully', () => {
      expect(() => m.merge('test', null)).not.toThrow();
      expect(() => m.merge('test', undefined)).not.toThrow();
      expect(() => m.merge('test', {})).not.toThrow();
    });
  });

  describe('reset()', () => {
    it('clears all metrics', () => {
      m.counter('req');
      m.histogram('latency', 10);
      m.gauge('mem', 42);

      m.reset();

      expect(m.getCounter('req')).toBe(0);
      expect(m.getHistogram('latency').count).toBe(0);
      expect(m.getGauge('mem')).toBe(0);

      const snap = m.snapshot();
      expect(snap.counters).toEqual({});
      expect(snap.histograms).toEqual({});
      expect(snap.gauges).toEqual({});
    });
  });
});
