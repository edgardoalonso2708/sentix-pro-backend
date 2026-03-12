// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — Circuit Breaker
// Per-provider circuit breaker to pause calls after repeated failures.
// States: CLOSED (normal) → OPEN (tripped) → HALF_OPEN (test) → CLOSED
// ═══════════════════════════════════════════════════════════════════════════════

const { logger } = require('./logger');
const { getConfigSync } = require('./configManager');

const CB_DEFAULTS = {
  failureThreshold: 3,     // Failures before tripping
  resetTimeoutMs: 60000,   // Time in OPEN before trying HALF_OPEN (60s)
  windowMs: 30000          // Time window to count failures (30s)
};

const STATE = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
});

// ─── Alert callback (set by consumer) ────────────────────────────────────────
let _alertCallback = null;

/**
 * Register a callback to be called when a circuit breaker opens.
 * @param {(provider: string, info: Object) => Promise<void>} fn
 */
function setAlertCallback(fn) {
  _alertCallback = fn;
}

// ─── CircuitBreaker class ────────────────────────────────────────────────────

class CircuitBreaker {
  /**
   * @param {string} provider - Provider name (e.g., 'Binance', 'CoinGecko')
   */
  constructor(provider) {
    this.provider = provider;
    this.state = STATE.CLOSED;
    this.failures = [];       // Timestamps of failures within window
    this.openedAt = null;     // When circuit was tripped
    this.lastFailureAt = null;
    this.totalTrips = 0;      // Lifetime trip count
    this._alertSentForCurrentTrip = false;
  }

  /** @returns {{ failureThreshold: number, resetTimeoutMs: number, windowMs: number }} */
  _getConfig() {
    return getConfigSync('circuit_breaker', CB_DEFAULTS);
  }

  /**
   * Execute a function through the circuit breaker.
   * @param {() => Promise<T>} fn - The function to execute
   * @param {T} [fallbackValue=null] - Value to return when circuit is OPEN
   * @returns {Promise<T>}
   * @template T
   */
  async execute(fn, fallbackValue = null) {
    const config = this._getConfig();

    switch (this.state) {
      case STATE.OPEN: {
        // Check if enough time has passed to try again
        const elapsed = Date.now() - this.openedAt;
        if (elapsed < config.resetTimeoutMs) {
          logger.debug('Circuit OPEN, returning fallback', { provider: this.provider, remainingMs: config.resetTimeoutMs - elapsed });
          return fallbackValue;
        }
        // Transition to HALF_OPEN
        this.state = STATE.HALF_OPEN;
        this._alertSentForCurrentTrip = false; // Reset so re-trip can send alert
        logger.info('Circuit HALF_OPEN, testing...', { provider: this.provider });
        // Fall through to execute test call
      }
      // eslint-disable-next-line no-fallthrough
      case STATE.HALF_OPEN: {
        try {
          const result = await fn();
          // Success — reset to CLOSED
          this.state = STATE.CLOSED;
          this.failures = [];
          this._alertSentForCurrentTrip = false;
          logger.info('Circuit CLOSED (recovered)', { provider: this.provider });
          return result;
        } catch (err) {
          // Fail — back to OPEN
          this._trip(config);
          logger.warn('Circuit HALF_OPEN failed, re-opening', { provider: this.provider, error: err.message });
          return fallbackValue;
        }
      }

      case STATE.CLOSED:
      default: {
        try {
          const result = await fn();
          // Success — prune old failures
          this._pruneFailures(config.windowMs);
          return result;
        } catch (err) {
          this._recordFailure(config);
          throw err;  // Let caller handle the error
        }
      }
    }
  }

  /**
   * Record a failure and potentially trip the breaker.
   */
  _recordFailure(config) {
    const now = Date.now();
    this.failures.push(now);
    this.lastFailureAt = now;

    // Prune failures outside the window
    this._pruneFailures(config.windowMs);

    if (this.failures.length >= config.failureThreshold) {
      this._trip(config);
    }
  }

  /**
   * Trip the circuit to OPEN state.
   */
  _trip(config) {
    this.state = STATE.OPEN;
    this.openedAt = Date.now();
    this.totalTrips++;

    logger.warn('Circuit OPEN (tripped)', {
      provider: this.provider,
      failures: this.failures.length,
      threshold: config.failureThreshold,
      resetMs: config.resetTimeoutMs,
      totalTrips: this.totalTrips
    });

    // Fire alert callback once per trip
    if (_alertCallback && !this._alertSentForCurrentTrip) {
      this._alertSentForCurrentTrip = true;
      const info = this.getStatus();
      _alertCallback(this.provider, info).catch(() => {});
    }
  }

  /**
   * Remove failures outside the time window.
   */
  _pruneFailures(windowMs) {
    const cutoff = Date.now() - windowMs;
    this.failures = this.failures.filter(ts => ts > cutoff);
  }

  /**
   * Get the current status of this circuit breaker.
   */
  getStatus() {
    const config = this._getConfig();
    return {
      provider: this.provider,
      state: this.state,
      failureCount: this.failures.length,
      failureThreshold: config.failureThreshold,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      lastFailureAt: this.lastFailureAt ? new Date(this.lastFailureAt).toISOString() : null,
      totalTrips: this.totalTrips,
      resetTimeoutMs: config.resetTimeoutMs,
    };
  }

  /**
   * Force reset to CLOSED state (admin action).
   */
  reset() {
    this.state = STATE.CLOSED;
    this.failures = [];
    this.openedAt = null;
    this._alertSentForCurrentTrip = false;
    logger.info('Circuit force-reset to CLOSED', { provider: this.provider });
  }
}

// ─── Global registry ─────────────────────────────────────────────────────────

/** @type {Map<string, CircuitBreaker>} */
const breakers = new Map();

/**
 * Get or create a circuit breaker for a provider.
 * @param {string} provider - Provider name
 * @returns {CircuitBreaker}
 */
function getBreaker(provider) {
  if (!breakers.has(provider)) {
    breakers.set(provider, new CircuitBreaker(provider));
  }
  return breakers.get(provider);
}

/**
 * Get status of all registered circuit breakers.
 * @returns {Array}
 */
function getAllBreakerStatus() {
  return [...breakers.values()].map(b => b.getStatus());
}

/**
 * Convenience: wrap a function call with a circuit breaker.
 * Catches the error from CLOSED state and returns fallback instead of throwing.
 * @param {string} provider - Provider name
 * @param {() => Promise<T>} fn - Function to execute
 * @param {T} [fallbackValue=null] - Fallback when circuit is OPEN or call fails
 * @returns {Promise<T>}
 * @template T
 */
async function wrapWithCircuitBreaker(provider, fn, fallbackValue = null) {
  const breaker = getBreaker(provider);
  try {
    return await breaker.execute(fn, fallbackValue);
  } catch (err) {
    // execute() throws in CLOSED state on failure — return fallback
    logger.debug('Circuit breaker caught error, returning fallback', {
      provider,
      error: err.message,
      state: breaker.state
    });
    return fallbackValue;
  }
}

module.exports = {
  CircuitBreaker,
  STATE,
  getBreaker,
  getAllBreakerStatus,
  wrapWithCircuitBreaker,
  setAlertCallback,
  // Exposed for testing
  _breakers: breakers,
  _CB_DEFAULTS: CB_DEFAULTS
};
