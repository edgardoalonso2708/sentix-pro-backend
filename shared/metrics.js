// ═══════════════════════════════════════════════════════════════════════════════
// METRICS COLLECTOR — Lightweight APM for Sentix Pro
// Counters, histograms (with percentiles), and gauges. No external deps.
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_HISTOGRAM_SAMPLES = 1000;
const HISTOGRAM_RESET_MS = 60 * 60 * 1000; // 1 hour

class MetricsCollector {
  constructor() {
    this._counters = new Map();
    this._histograms = new Map();
    this._gauges = new Map();
    this._startedAt = Date.now();
  }

  // ─── Counters ────────────────────────────────────────────────────────────────

  /**
   * Increment a monotonic counter by 1 (or a custom amount).
   */
  counter(name, amount = 1) {
    const prev = this._counters.get(name) || 0;
    this._counters.set(name, prev + amount);
  }

  /**
   * Get current counter value.
   */
  getCounter(name) {
    return this._counters.get(name) || 0;
  }

  // ─── Histograms ──────────────────────────────────────────────────────────────

  /**
   * Record a value in a histogram (rolling window of MAX_HISTOGRAM_SAMPLES).
   */
  histogram(name, value) {
    let h = this._histograms.get(name);
    if (!h) {
      h = { values: [], resetAt: Date.now() + HISTOGRAM_RESET_MS };
      this._histograms.set(name, h);
    }
    // Rolling reset to prevent unbounded growth
    if (Date.now() > h.resetAt) {
      h.values = [];
      h.resetAt = Date.now() + HISTOGRAM_RESET_MS;
    }
    h.values.push(value);
    // Cap at max samples (keep most recent)
    if (h.values.length > MAX_HISTOGRAM_SAMPLES) {
      h.values = h.values.slice(-MAX_HISTOGRAM_SAMPLES);
    }
  }

  /**
   * Get histogram summary with percentiles.
   */
  getHistogram(name) {
    const h = this._histograms.get(name);
    if (!h || h.values.length === 0) {
      return { count: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
    }
    const sorted = [...h.values].sort((a, b) => a - b);
    const len = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      count: len,
      min: sorted[0],
      max: sorted[len - 1],
      avg: Math.round(sum / len),
      p50: sorted[Math.floor(len * 0.5)],
      p95: sorted[Math.floor(len * 0.95)],
      p99: sorted[Math.min(Math.floor(len * 0.99), len - 1)]
    };
  }

  // ─── Gauges ──────────────────────────────────────────────────────────────────

  /**
   * Set a point-in-time gauge value.
   */
  gauge(name, value) {
    this._gauges.set(name, { value, ts: Date.now() });
  }

  /**
   * Get current gauge value.
   */
  getGauge(name) {
    const g = this._gauges.get(name);
    return g ? g.value : 0;
  }

  // ─── Snapshot ────────────────────────────────────────────────────────────────

  /**
   * Export all metrics as a JSON-serializable object.
   */
  snapshot() {
    const counters = {};
    for (const [name, value] of this._counters) {
      counters[name] = value;
    }

    const histograms = {};
    for (const [name] of this._histograms) {
      histograms[name] = this.getHistogram(name);
    }

    const gauges = {};
    for (const [name, g] of this._gauges) {
      gauges[name] = g.value;
    }

    return {
      collectedAt: new Date().toISOString(),
      uptimeSeconds: Math.round((Date.now() - this._startedAt) / 1000),
      counters,
      histograms,
      gauges
    };
  }

  /**
   * Merge external metrics (from worker IPC) into this collector.
   * Prefixes all metric names with the given namespace.
   */
  merge(namespace, externalSnapshot) {
    if (!externalSnapshot) return;
    if (externalSnapshot.counters) {
      for (const [name, value] of Object.entries(externalSnapshot.counters)) {
        this._counters.set(`${namespace}.${name}`, value);
      }
    }
    if (externalSnapshot.histograms) {
      for (const [name, summary] of Object.entries(externalSnapshot.histograms)) {
        // Store pre-computed summaries from workers directly
        this._histograms.set(`${namespace}.${name}`, { values: [], _summary: summary });
      }
    }
    if (externalSnapshot.gauges) {
      for (const [name, value] of Object.entries(externalSnapshot.gauges)) {
        this._gauges.set(`${namespace}.${name}`, { value, ts: Date.now() });
      }
    }
  }

  /**
   * Override getHistogram to handle merged pre-computed summaries.
   * (Called internally by snapshot())
   */

  /**
   * Reset all metrics (for tests).
   */
  reset() {
    this._counters.clear();
    this._histograms.clear();
    this._gauges.clear();
    this._startedAt = Date.now();
  }
}

// Override getHistogram to support merged pre-computed summaries
const _origGetHistogram = MetricsCollector.prototype.getHistogram;
MetricsCollector.prototype.getHistogram = function (name) {
  const h = this._histograms.get(name);
  if (h && h._summary) return h._summary;
  return _origGetHistogram.call(this, name);
};

// Singleton instance
const metrics = new MetricsCollector();

module.exports = { metrics, MetricsCollector };
