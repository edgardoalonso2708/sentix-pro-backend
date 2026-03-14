// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - SCHEDULE UTILITIES
// Trading hours filter + Signal TTL / freshness / decay
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if the current time is within configured trading hours.
 * Returns { active, hour, day, reason } — pure function (uses Date or provided `now`).
 *
 * @param {object} config - SCHEDULE_CONFIG or compatible object
 * @param {Date} [now] - Override current time for testing
 * @returns {{ active: boolean, hour: number|undefined, day: number|undefined, reason: string|null }}
 */
function isWithinTradingHours(config = {}, now = new Date()) {
  if (!config.tradingHoursEnabled) {
    return { active: true, reason: null };
  }

  const tz = config.timezone || 'America/Mexico_City';

  // Get local hour and weekday using Intl.DateTimeFormat
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
    weekday: 'short'
  }).formatToParts(now);

  const hourPart = parts.find(p => p.type === 'hour');
  const dayPart = parts.find(p => p.type === 'weekday');

  // Intl returns '24' for midnight in hour12:false → normalize to 0
  let hour = parseInt(hourPart.value, 10);
  if (hour === 24) hour = 0;

  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = dayMap[dayPart.value];

  // Check day
  const tradingDays = config.tradingDays || [1, 2, 3, 4, 5];
  const dayActive = tradingDays.includes(day);

  // Check hour — supports overnight ranges (e.g., start=22, end=6)
  const start = config.tradingHoursStart ?? 8;
  const end = config.tradingHoursEnd ?? 22;
  let hourActive;
  if (start <= end) {
    hourActive = (hour >= start && hour < end);
  } else {
    // Overnight: e.g., 22-6 means active from 22:00 to 05:59
    hourActive = (hour >= start || hour < end);
  }

  const active = dayActive && hourActive;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let reason = null;
  if (!active) {
    reason = !dayActive
      ? `Off-day (${dayNames[day]})`
      : `Off-hours (${hour}:00, active ${start}-${end})`;
  }

  return { active, hour, day, reason };
}

/**
 * Enrich a signal object with TTL/freshness metadata.
 * Returns a new object (does not mutate the original).
 *
 * @param {object} signal - Signal with `timestamp` field (ISO 8601)
 * @param {object} config - SCHEDULE_CONFIG or compatible object
 * @param {number} [nowMs] - Override current time in ms for testing
 * @returns {object} Signal with added: signalAge, freshness, expiresAt, ttlMinutes
 */
function enrichSignalWithTTL(signal, config = {}, nowMs = Date.now()) {
  if (!signal || !signal.timestamp) {
    return {
      ...signal,
      signalAge: 0,
      freshness: 'unknown',
      expiresAt: null,
      ttlMinutes: config.signalTTLMinutes || 15
    };
  }

  const ttlMs = (config.signalTTLMinutes || 15) * 60 * 1000;
  const freshMs = (config.signalFreshMinutes || 5) * 60 * 1000;
  const agingMs = (config.signalAgingMinutes || 10) * 60 * 1000;

  const generatedAt = new Date(signal.timestamp).getTime();
  const ageMs = nowMs - generatedAt;
  const ageMinutes = ageMs / 60000;

  let freshness = 'fresh';
  if (ageMs >= ttlMs) freshness = 'expired';
  else if (ageMs >= agingMs) freshness = 'stale';
  else if (ageMs >= freshMs) freshness = 'aging';

  // Confidence decay: -5% per minute after signal is no longer "fresh"
  let confidenceDecay = 0;
  if (ageMs > freshMs && ageMs < ttlMs) {
    const minutesPastFresh = (ageMs - freshMs) / 60000;
    confidenceDecay = Math.round(minutesPastFresh * 5);
  } else if (ageMs >= ttlMs) {
    confidenceDecay = 100; // expired — zero out confidence
  }

  const originalConfidence = signal.confidence || 0;
  const decayedConfidence = Math.max(0, originalConfidence - confidenceDecay);

  return {
    ...signal,
    signalAge: Math.round(ageMinutes),
    freshness,
    confidence: decayedConfidence,
    originalConfidence,
    confidenceDecay,
    expiresAt: new Date(generatedAt + ttlMs).toISOString(),
    ttlMinutes: config.signalTTLMinutes || 15
  };
}

module.exports = {
  isWithinTradingHours,
  enrichSignalWithTTL
};
