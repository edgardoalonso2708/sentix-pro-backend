// ═══════════════════════════════════════════════════════════════════════════════
// Tests — circuitBreaker.js
// ═══════════════════════════════════════════════════════════════════════════════

const {
  CircuitBreaker,
  STATE,
  getBreaker,
  getAllBreakerStatus,
  wrapWithCircuitBreaker,
  setAlertCallback,
  _breakers,
  _CB_DEFAULTS
} = require('../circuitBreaker');

// Mock configManager
jest.mock('../configManager', () => ({
  getConfigSync: jest.fn().mockReturnValue({
    failureThreshold: 3,
    resetTimeoutMs: 60000,
    windowMs: 30000
  })
}));

beforeEach(() => {
  _breakers.clear();
  setAlertCallback(null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// CircuitBreaker class
// ═══════════════════════════════════════════════════════════════════════════════

describe('CircuitBreaker', () => {
  test('starts in CLOSED state', () => {
    const cb = new CircuitBreaker('TestProvider');
    expect(cb.state).toBe(STATE.CLOSED);
    expect(cb.totalTrips).toBe(0);
  });

  test('CLOSED: executes function normally', async () => {
    const cb = new CircuitBreaker('TestProvider');
    const result = await cb.execute(() => Promise.resolve(42));
    expect(result).toBe(42);
    expect(cb.state).toBe(STATE.CLOSED);
  });

  test('CLOSED: throws error on failure', async () => {
    const cb = new CircuitBreaker('TestProvider');
    await expect(cb.execute(() => Promise.reject(new Error('fail')))).rejects.toThrow('fail');
    expect(cb.failures.length).toBe(1);
    expect(cb.state).toBe(STATE.CLOSED);
  });

  test('trips to OPEN after 3 failures within window', async () => {
    const cb = new CircuitBreaker('TestProvider');

    for (let i = 0; i < 3; i++) {
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }

    expect(cb.state).toBe(STATE.OPEN);
    expect(cb.totalTrips).toBe(1);
    expect(cb.openedAt).toBeTruthy();
  });

  test('OPEN: returns fallback without calling function', async () => {
    const cb = new CircuitBreaker('TestProvider');

    // Trip it
    for (let i = 0; i < 3; i++) {
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    expect(cb.state).toBe(STATE.OPEN);

    const fn = jest.fn().mockResolvedValue(99);
    const result = await cb.execute(fn, 'fallback');
    expect(result).toBe('fallback');
    expect(fn).not.toHaveBeenCalled();
  });

  test('transitions to HALF_OPEN after resetTimeout', async () => {
    const cb = new CircuitBreaker('TestProvider');

    // Trip it
    for (let i = 0; i < 3; i++) {
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }

    // Simulate timeout elapsed
    cb.openedAt = Date.now() - 70000; // 70s ago (> 60s resetTimeout)

    const fn = jest.fn().mockResolvedValue('recovered');
    const result = await cb.execute(fn, 'fallback');
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalled();
    expect(cb.state).toBe(STATE.CLOSED);
  });

  test('HALF_OPEN: failure sends back to OPEN', async () => {
    const cb = new CircuitBreaker('TestProvider');

    // Trip it
    for (let i = 0; i < 3; i++) {
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }

    // Simulate timeout elapsed
    cb.openedAt = Date.now() - 70000;

    const result = await cb.execute(() => Promise.reject(new Error('still broken')), 'fallback');
    expect(result).toBe('fallback');
    expect(cb.state).toBe(STATE.OPEN);
    expect(cb.totalTrips).toBe(2); // Tripped again
  });

  test('alert callback fires once when tripping', async () => {
    const alertFn = jest.fn().mockResolvedValue(undefined);
    setAlertCallback(alertFn);

    const cb = new CircuitBreaker('TestProvider');

    for (let i = 0; i < 3; i++) {
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }

    expect(alertFn).toHaveBeenCalledTimes(1);
    expect(alertFn).toHaveBeenCalledWith('TestProvider', expect.objectContaining({
      state: STATE.OPEN,
      provider: 'TestProvider'
    }));
  });

  test('alert callback does not fire twice for same trip', async () => {
    const alertFn = jest.fn().mockResolvedValue(undefined);
    setAlertCallback(alertFn);

    const cb = new CircuitBreaker('TestProvider');

    // Trip with 3 failures
    for (let i = 0; i < 3; i++) {
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }

    // Still OPEN, more "failures" (additional calls while open don't trigger alert again)
    // Simulate HALF_OPEN failure re-trip
    cb.openedAt = Date.now() - 70000;
    await cb.execute(() => Promise.reject(new Error('still broken')), 'fallback');

    // Second trip fires a new alert
    expect(alertFn).toHaveBeenCalledTimes(2);
  });

  test('reset() clears state to CLOSED', async () => {
    const cb = new CircuitBreaker('TestProvider');

    for (let i = 0; i < 3; i++) {
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    expect(cb.state).toBe(STATE.OPEN);

    cb.reset();
    expect(cb.state).toBe(STATE.CLOSED);
    expect(cb.failures).toHaveLength(0);
    expect(cb.openedAt).toBeNull();
  });

  test('getStatus() returns correct info', () => {
    const cb = new CircuitBreaker('TestProvider');
    const status = cb.getStatus();
    expect(status.provider).toBe('TestProvider');
    expect(status.state).toBe(STATE.CLOSED);
    expect(status.failureCount).toBe(0);
    expect(status.failureThreshold).toBe(3);
    expect(status.totalTrips).toBe(0);
  });

  test('failures outside window are pruned', async () => {
    const cb = new CircuitBreaker('TestProvider');

    // Record 2 failures in the past (outside window)
    cb.failures = [Date.now() - 40000, Date.now() - 35000];

    // Execute a success — should prune old failures
    await cb.execute(() => Promise.resolve('ok'));
    expect(cb.failures).toHaveLength(0);
  });

  test('does not trip if failures are outside window', async () => {
    const cb = new CircuitBreaker('TestProvider');

    // 2 old failures
    cb.failures = [Date.now() - 40000, Date.now() - 35000];

    // 1 new failure — total in-window is only 1
    await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    expect(cb.state).toBe(STATE.CLOSED);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Registry functions
// ═══════════════════════════════════════════════════════════════════════════════

describe('Registry', () => {
  test('getBreaker creates and returns same instance', () => {
    const b1 = getBreaker('Provider1');
    const b2 = getBreaker('Provider1');
    expect(b1).toBe(b2);
    expect(b1.provider).toBe('Provider1');
  });

  test('getAllBreakerStatus returns all registered', () => {
    getBreaker('A');
    getBreaker('B');
    getBreaker('C');
    const statuses = getAllBreakerStatus();
    expect(statuses).toHaveLength(3);
    expect(statuses.map(s => s.provider).sort()).toEqual(['A', 'B', 'C']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// wrapWithCircuitBreaker
// ═══════════════════════════════════════════════════════════════════════════════

describe('wrapWithCircuitBreaker', () => {
  test('returns function result on success', async () => {
    const result = await wrapWithCircuitBreaker('WrapTest', () => Promise.resolve(123));
    expect(result).toBe(123);
  });

  test('returns fallback on failure instead of throwing', async () => {
    const result = await wrapWithCircuitBreaker('WrapFail', () => Promise.reject(new Error('err')), 'fallback');
    expect(result).toBe('fallback');
  });

  test('returns fallback when circuit is OPEN', async () => {
    // Trip it
    for (let i = 0; i < 3; i++) {
      await wrapWithCircuitBreaker('WrapOpen', () => Promise.reject(new Error('fail')));
    }

    const fn = jest.fn().mockResolvedValue(99);
    const result = await wrapWithCircuitBreaker('WrapOpen', fn, 'cached');
    expect(result).toBe('cached');
    expect(fn).not.toHaveBeenCalled();
  });
});
