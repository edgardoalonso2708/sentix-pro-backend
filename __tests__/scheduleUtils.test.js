const { isWithinTradingHours, enrichSignalWithTTL } = require('../scheduleUtils');

// ═══════════════════════════════════════════════════════════════════════════════
// isWithinTradingHours Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('isWithinTradingHours', () => {
  const baseConfig = {
    tradingHoursEnabled: true,
    tradingHoursStart: 8,
    tradingHoursEnd: 22,
    tradingDays: [1, 2, 3, 4, 5], // Mon-Fri
    timezone: 'UTC'
  };

  test('returns active when trading hours disabled', () => {
    const result = isWithinTradingHours({ tradingHoursEnabled: false });
    expect(result.active).toBe(true);
    expect(result.reason).toBeNull();
  });

  test('returns active when no config provided', () => {
    const result = isWithinTradingHours();
    expect(result.active).toBe(true);
  });

  test('active during trading hours on a weekday', () => {
    // Wednesday 14:00 UTC
    const wed2pm = new Date('2026-03-11T14:00:00Z'); // Wed
    const result = isWithinTradingHours(baseConfig, wed2pm);
    expect(result.active).toBe(true);
    expect(result.hour).toBe(14);
    expect(result.day).toBe(3); // Wednesday
    expect(result.reason).toBeNull();
  });

  test('inactive outside trading hours', () => {
    // Wednesday 05:00 UTC (before 8am)
    const wed5am = new Date('2026-03-11T05:00:00Z');
    const result = isWithinTradingHours(baseConfig, wed5am);
    expect(result.active).toBe(false);
    expect(result.reason).toContain('Off-hours');
  });

  test('inactive after trading hours', () => {
    // Wednesday 23:00 UTC (after 10pm)
    const wed11pm = new Date('2026-03-11T23:00:00Z');
    const result = isWithinTradingHours(baseConfig, wed11pm);
    expect(result.active).toBe(false);
    expect(result.reason).toContain('Off-hours');
  });

  test('inactive on weekend (Sunday)', () => {
    // Sunday 14:00 UTC
    const sun2pm = new Date('2026-03-08T14:00:00Z'); // Sunday
    const result = isWithinTradingHours(baseConfig, sun2pm);
    expect(result.active).toBe(false);
    expect(result.reason).toContain('Off-day');
    expect(result.reason).toContain('Sun');
  });

  test('inactive on weekend (Saturday)', () => {
    // Saturday 14:00 UTC
    const sat2pm = new Date('2026-03-07T14:00:00Z'); // Saturday
    const result = isWithinTradingHours(baseConfig, sat2pm);
    expect(result.active).toBe(false);
    expect(result.reason).toContain('Off-day');
  });

  test('handles overnight range (start=22, end=6)', () => {
    const overnightConfig = { ...baseConfig, tradingHoursStart: 22, tradingHoursEnd: 6 };

    // Wednesday 23:00 UTC — should be active (23 >= 22)
    const wed11pm = new Date('2026-03-11T23:00:00Z');
    expect(isWithinTradingHours(overnightConfig, wed11pm).active).toBe(true);

    // Wednesday 03:00 UTC — should be active (3 < 6)
    const wed3am = new Date('2026-03-11T03:00:00Z');
    expect(isWithinTradingHours(overnightConfig, wed3am).active).toBe(true);

    // Wednesday 14:00 UTC — should be inactive (not in 22-6)
    const wed2pm = new Date('2026-03-11T14:00:00Z');
    expect(isWithinTradingHours(overnightConfig, wed2pm).active).toBe(false);
  });

  test('boundary: exact start hour is active', () => {
    // Wednesday 08:00 UTC
    const wed8am = new Date('2026-03-11T08:00:00Z');
    const result = isWithinTradingHours(baseConfig, wed8am);
    expect(result.active).toBe(true);
  });

  test('boundary: exact end hour is inactive', () => {
    // Wednesday 22:00 UTC
    const wed10pm = new Date('2026-03-11T22:00:00Z');
    const result = isWithinTradingHours(baseConfig, wed10pm);
    expect(result.active).toBe(false);
  });

  test('supports all 7 days in tradingDays', () => {
    const allDays = { ...baseConfig, tradingDays: [0, 1, 2, 3, 4, 5, 6] };
    const sun2pm = new Date('2026-03-08T14:00:00Z'); // Sunday
    expect(isWithinTradingHours(allDays, sun2pm).active).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// enrichSignalWithTTL Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('enrichSignalWithTTL', () => {
  const config = {
    signalTTLMinutes: 15,
    signalFreshMinutes: 5,
    signalAgingMinutes: 10
  };

  const makeSignal = (minutesAgo) => {
    const ts = new Date(Date.now() - minutesAgo * 60 * 1000);
    return { asset: 'BTC', action: 'BUY', timestamp: ts.toISOString() };
  };

  test('fresh signal (< 5 min old)', () => {
    const now = Date.now();
    const signal = { asset: 'BTC', timestamp: new Date(now - 2 * 60000).toISOString() };
    const enriched = enrichSignalWithTTL(signal, config, now);
    expect(enriched.freshness).toBe('fresh');
    expect(enriched.signalAge).toBe(2);
    expect(enriched.ttlMinutes).toBe(15);
    expect(enriched.expiresAt).toBeTruthy();
  });

  test('aging signal (5-10 min old)', () => {
    const now = Date.now();
    const signal = { asset: 'BTC', timestamp: new Date(now - 7 * 60000).toISOString() };
    const enriched = enrichSignalWithTTL(signal, config, now);
    expect(enriched.freshness).toBe('aging');
    expect(enriched.signalAge).toBe(7);
  });

  test('stale signal (10-15 min old)', () => {
    const now = Date.now();
    const signal = { asset: 'BTC', timestamp: new Date(now - 12 * 60000).toISOString() };
    const enriched = enrichSignalWithTTL(signal, config, now);
    expect(enriched.freshness).toBe('stale');
    expect(enriched.signalAge).toBe(12);
  });

  test('expired signal (>= 15 min old)', () => {
    const now = Date.now();
    const signal = { asset: 'BTC', timestamp: new Date(now - 20 * 60000).toISOString() };
    const enriched = enrichSignalWithTTL(signal, config, now);
    expect(enriched.freshness).toBe('expired');
    expect(enriched.signalAge).toBe(20);
  });

  test('expiresAt is timestamp + TTL', () => {
    const now = Date.now();
    const ts = new Date(now - 3 * 60000);
    const signal = { asset: 'BTC', timestamp: ts.toISOString() };
    const enriched = enrichSignalWithTTL(signal, config, now);
    const expectedExpiry = new Date(ts.getTime() + 15 * 60000).toISOString();
    expect(enriched.expiresAt).toBe(expectedExpiry);
  });

  test('preserves original signal fields', () => {
    const now = Date.now();
    const signal = { asset: 'ETH', action: 'SELL', confidence: 65, timestamp: new Date(now).toISOString() };
    const enriched = enrichSignalWithTTL(signal, config, now);
    expect(enriched.asset).toBe('ETH');
    expect(enriched.action).toBe('SELL');
    expect(enriched.confidence).toBe(65);
  });

  test('handles missing timestamp gracefully', () => {
    const enriched = enrichSignalWithTTL({ asset: 'BTC' }, config);
    expect(enriched.freshness).toBe('unknown');
    expect(enriched.signalAge).toBe(0);
    expect(enriched.expiresAt).toBeNull();
  });

  test('handles null signal gracefully', () => {
    const enriched = enrichSignalWithTTL(null, config);
    expect(enriched.freshness).toBe('unknown');
  });

  test('uses default config values when config empty', () => {
    const now = Date.now();
    const signal = { asset: 'BTC', timestamp: new Date(now - 2 * 60000).toISOString() };
    const enriched = enrichSignalWithTTL(signal, {}, now);
    expect(enriched.freshness).toBe('fresh');
    expect(enriched.ttlMinutes).toBe(15); // default
  });

  test('boundary: exactly at fresh threshold', () => {
    const now = Date.now();
    const signal = { asset: 'BTC', timestamp: new Date(now - 5 * 60000).toISOString() };
    const enriched = enrichSignalWithTTL(signal, config, now);
    expect(enriched.freshness).toBe('aging'); // 5 min = aging threshold
  });

  test('boundary: exactly at TTL threshold', () => {
    const now = Date.now();
    const signal = { asset: 'BTC', timestamp: new Date(now - 15 * 60000).toISOString() };
    const enriched = enrichSignalWithTTL(signal, config, now);
    expect(enriched.freshness).toBe('expired'); // 15 min = expired
  });
});
