const { formatPrice, formatLargeNumber } = require('../lib/formatting');

// ═══════════════════════════════════════════════════════════════════════════════
// formatPrice Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatPrice', () => {
  test('returns $0 for falsy values', () => {
    expect(formatPrice(0)).toBe('$0');
    expect(formatPrice(null)).toBe('$0');
    expect(formatPrice(undefined)).toBe('$0');
    expect(formatPrice('')).toBe('$0');
    expect(formatPrice(false)).toBe('$0');
  });

  test('formats prices >= 1000 as integers (no fractional cents)', () => {
    const result = formatPrice(65432);
    // toLocaleString with maximumFractionDigits:0 — output varies by locale
    // e.g. "$65,432" (en-US) or "$65.432" (es-ES) — both are valid
    expect(result).toMatch(/^\$/);
    // Should represent 65432 without fractional digits
    expect(result.replace(/[$.,\s]/g, '')).toBe('65432');
  });

  test('formats prices >= 1 with 2 decimal places', () => {
    expect(formatPrice(5.67)).toBe('$5.67');
    expect(formatPrice(999.99)).toBe('$999.99');
    expect(formatPrice(1)).toBe('$1.00');
  });

  test('formats prices < 1 with 4 decimal places', () => {
    expect(formatPrice(0.5678)).toBe('$0.5678');
    expect(formatPrice(0.0001)).toBe('$0.0001');
    expect(formatPrice(0.9999)).toBe('$0.9999');
  });

  test('handles exact boundary at 1000', () => {
    const result = formatPrice(1000);
    expect(result).toMatch(/^\$/);
    expect(result.replace(/[$.,\s]/g, '')).toBe('1000');
  });

  test('handles very large prices', () => {
    const result = formatPrice(100000);
    expect(result).toMatch(/^\$/);
    expect(result.replace(/[$.,\s]/g, '')).toBe('100000');
  });

  test('handles very small prices', () => {
    expect(formatPrice(0.00001)).toBe('$0.0000');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatLargeNumber Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatLargeNumber', () => {
  test('returns $0 for falsy values', () => {
    expect(formatLargeNumber(0)).toBe('$0');
    expect(formatLargeNumber(null)).toBe('$0');
    expect(formatLargeNumber(undefined)).toBe('$0');
    expect(formatLargeNumber('')).toBe('$0');
    expect(formatLargeNumber(false)).toBe('$0');
  });

  test('formats trillions', () => {
    expect(formatLargeNumber(1e12)).toBe('$1.00T');
    expect(formatLargeNumber(2.48e12)).toBe('$2.48T');
    expect(formatLargeNumber(1.5e12)).toBe('$1.50T');
  });

  test('formats billions', () => {
    expect(formatLargeNumber(1e9)).toBe('$1.00B');
    expect(formatLargeNumber(5.5e9)).toBe('$5.50B');
    expect(formatLargeNumber(999e9)).toBe('$999.00B');
  });

  test('formats millions', () => {
    expect(formatLargeNumber(1e6)).toBe('$1.00M');
    expect(formatLargeNumber(42.5e6)).toBe('$42.50M');
    expect(formatLargeNumber(999.99e6)).toBe('$999.99M');
  });

  test('formats numbers below 1 million with 2 decimals', () => {
    expect(formatLargeNumber(1000)).toBe('$1000.00');
    expect(formatLargeNumber(42.5)).toBe('$42.50');
    expect(formatLargeNumber(0.5)).toBe('$0.50');
  });

  test('handles boundary at exactly 1 trillion', () => {
    expect(formatLargeNumber(1e12)).toBe('$1.00T');
  });

  test('handles boundary at exactly 1 billion', () => {
    expect(formatLargeNumber(1e9)).toBe('$1.00B');
  });

  test('handles boundary at exactly 1 million', () => {
    expect(formatLargeNumber(1e6)).toBe('$1.00M');
  });

  test('handles negative numbers', () => {
    // Negative numbers are below all thresholds, so formatted with .toFixed(2)
    expect(formatLargeNumber(-500)).toBe('$-500.00');
  });
});
