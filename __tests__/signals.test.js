const {
  generateMockHistory,
  computeSignalFromData,
  generateSignals,
  filterCriticalSignals,
} = require('../lib/signals');

// ═══════════════════════════════════════════════════════════════════════════════
// generateMockHistory Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('generateMockHistory', () => {
  test('returns array with days+1 elements (days + current price)', () => {
    const history = generateMockHistory(50000, 30);
    expect(history).toHaveLength(31);
  });

  test('last element is the current price', () => {
    const currentPrice = 67123.45;
    const history = generateMockHistory(currentPrice, 30);
    expect(history[history.length - 1]).toBe(currentPrice);
  });

  test('first simulated price starts near 90% of current price', () => {
    const currentPrice = 100;
    const history = generateMockHistory(currentPrice, 30);
    expect(history[0]).toBeGreaterThan(currentPrice * 0.8);
    expect(history[0]).toBeLessThan(currentPrice * 1.1);
  });

  test('all prices are positive numbers', () => {
    const history = generateMockHistory(50000, 100);
    history.forEach(price => {
      expect(price).toBeGreaterThan(0);
      expect(Number.isFinite(price)).toBe(true);
    });
  });

  test('works with very small prices', () => {
    const history = generateMockHistory(0.001, 30);
    expect(history).toHaveLength(31);
    expect(history[history.length - 1]).toBe(0.001);
  });

  test('works with very large prices', () => {
    const history = generateMockHistory(1e6, 30);
    expect(history).toHaveLength(31);
    expect(history[history.length - 1]).toBe(1e6);
  });

  test('handles 0 days', () => {
    const history = generateMockHistory(100, 0);
    expect(history).toHaveLength(1);
    expect(history[0]).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// computeSignalFromData Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeSignalFromData', () => {
  const makeBullishPrices = () => {
    return Array.from({ length: 31 }, (_, i) => 1000 + i * 50);
  };

  const makeBearishPrices = () => {
    return Array.from({ length: 31 }, (_, i) => 2000 - i * 50);
  };

  const makeNeutralPrices = () => {
    return Array.from({ length: 31 }, () => 100);
  };

  const defaultData = {
    price: 50000,
    change24h: 2.5,
    volume24h: 1e9,
    marketCap: 1e12,
  };

  const defaultMacro = { fearGreed: 50, fearLabel: 'Neutral' };

  test('returns correct shape with all required fields', () => {
    const signal = computeSignalFromData('bitcoin', defaultData, defaultMacro, makeNeutralPrices());
    expect(signal).toHaveProperty('asset');
    expect(signal).toHaveProperty('action');
    expect(signal).toHaveProperty('score');
    expect(signal).toHaveProperty('rawScore');
    expect(signal).toHaveProperty('confidence');
    expect(signal).toHaveProperty('price');
    expect(signal).toHaveProperty('change24h');
    expect(signal).toHaveProperty('reasons');
    expect(signal).toHaveProperty('timestamp');
  });

  test('asset name is uppercased', () => {
    const signal = computeSignalFromData('bitcoin', defaultData, defaultMacro, makeNeutralPrices());
    expect(signal.asset).toBe('BITCOIN');
  });

  test('price and change24h come from data input', () => {
    const signal = computeSignalFromData('bitcoin', defaultData, defaultMacro, makeNeutralPrices());
    expect(signal.price).toBe(50000);
    expect(signal.change24h).toBe(2.5);
  });

  test('score is 0-100 display range', () => {
    const signal = computeSignalFromData('bitcoin', defaultData, defaultMacro, makeBullishPrices());
    expect(signal.score).toBeGreaterThanOrEqual(0);
    expect(signal.score).toBeLessThanOrEqual(100);
  });

  test('rawScore is bidirectional (-100 to +100 range)', () => {
    const signal = computeSignalFromData('bitcoin', defaultData, defaultMacro, makeBullishPrices());
    expect(signal.rawScore).toBeGreaterThanOrEqual(-100);
    expect(signal.rawScore).toBeLessThanOrEqual(100);
  });

  test('SELL signal when bearish indicators with strong negative momentum', () => {
    const bearishData = { ...defaultData, change24h: -8 };
    const signal = computeSignalFromData('bitcoin', bearishData, defaultMacro, makeBearishPrices());
    expect(['HOLD', 'SELL', 'BUY']).toContain(signal.action);
  });

  test('confidence is capped at 85', () => {
    const data = { ...defaultData, change24h: 10 };
    const macro = { fearGreed: 10 };
    const signal = computeSignalFromData('bitcoin', data, macro, makeBullishPrices());
    expect(signal.confidence).toBeLessThanOrEqual(85);
  });

  test('RSI oversold adds to score', () => {
    const oversoldPrices = makeBearishPrices();
    const signal = computeSignalFromData('bitcoin', defaultData, defaultMacro, oversoldPrices);
    expect(signal.reasons).toContain('RSI oversold');
  });

  test('RSI overbought subtracts from score', () => {
    const overboughtPrices = makeBullishPrices();
    const signal = computeSignalFromData('bitcoin', defaultData, defaultMacro, overboughtPrices);
    expect(signal.reasons).toContain('RSI overbought');
  });

  test('MACD is reported in reasons', () => {
    const signal = computeSignalFromData('bitcoin', defaultData, defaultMacro, makeBullishPrices());
    expect(signal.reasons).toContain('MACD');
  });

  test('strong 24h momentum adds to score', () => {
    const strongData = { ...defaultData, change24h: 8 };
    const signal = computeSignalFromData('bitcoin', strongData, defaultMacro, makeNeutralPrices());
    expect(signal.reasons).toContain('Strong 24h momentum');
  });

  test('weak 24h momentum subtracts from score', () => {
    const weakData = { ...defaultData, change24h: -8 };
    const signal = computeSignalFromData('bitcoin', weakData, defaultMacro, makeNeutralPrices());
    expect(signal.reasons).toContain('Weak 24h momentum');
  });

  test('action is one of BUY, SELL, HOLD', () => {
    const signal = computeSignalFromData('test', defaultData, defaultMacro, makeNeutralPrices());
    expect(['BUY', 'HOLD', 'SELL']).toContain(signal.action);
  });

  test('timestamp is a recent number', () => {
    const before = Date.now();
    const signal = computeSignalFromData('bitcoin', defaultData, defaultMacro, makeNeutralPrices());
    const after = Date.now();
    expect(signal.timestamp).toBeGreaterThanOrEqual(before);
    expect(signal.timestamp).toBeLessThanOrEqual(after);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// generateSignals Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('generateSignals', () => {
  test('returns empty array for empty market cache', () => {
    const signals = generateSignals({ crypto: {}, macro: {} });
    expect(signals).toEqual([]);
  });

  test('returns array of signals for valid market data', () => {
    const marketCache = {
      crypto: {
        bitcoin: { price: 65000, change24h: 3.5, volume24h: 1e10, marketCap: 1.2e12 },
        ethereum: { price: 3500, change24h: -2.1, volume24h: 5e9, marketCap: 4e11 },
      },
      macro: { fearGreed: 45, fearLabel: 'Fear' },
    };

    const signals = generateSignals(marketCache);
    expect(Array.isArray(signals)).toBe(true);
    signals.forEach(s => {
      expect(s).toHaveProperty('asset');
      expect(s).toHaveProperty('action');
      expect(s).toHaveProperty('score');
      expect(s).toHaveProperty('confidence');
    });
  });

  test('signals are sorted by confidence descending', () => {
    const marketCache = {
      crypto: {
        bitcoin: { price: 65000, change24h: 8, volume24h: 1e10, marketCap: 1.2e12 },
        ethereum: { price: 3500, change24h: -8, volume24h: 5e9, marketCap: 4e11 },
        solana: { price: 150, change24h: 12, volume24h: 1e9, marketCap: 5e10 },
      },
      macro: { fearGreed: 15, fearLabel: 'Extreme Fear' },
    };

    const signals = generateSignals(marketCache);
    for (let i = 1; i < signals.length; i++) {
      expect(signals[i - 1].confidence).toBeGreaterThanOrEqual(signals[i].confidence);
    }
  });

  test('handles missing macro data gracefully', () => {
    const marketCache = {
      crypto: {
        bitcoin: { price: 65000, change24h: 3.5, volume24h: 1e10, marketCap: 1.2e12 },
      },
      macro: {},
    };

    expect(() => generateSignals(marketCache)).not.toThrow();
  });

  test('handles missing crypto data', () => {
    const marketCache = { crypto: undefined, macro: {} };
    const signals = generateSignals(marketCache);
    expect(signals).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// filterCriticalSignals Tests (v3: uses rawScore instead of score)
// ═══════════════════════════════════════════════════════════════════════════════

describe('filterCriticalSignals', () => {
  test('returns empty array for empty input', () => {
    expect(filterCriticalSignals([])).toEqual([]);
  });

  test('keeps BUY signals with confidence >= 60 and rawScore >= 35', () => {
    const signals = [
      { action: 'BUY', confidence: 65, rawScore: 40, asset: 'BTC' },
      { action: 'BUY', confidence: 60, rawScore: 35, asset: 'ETH' },
    ];
    const critical = filterCriticalSignals(signals);
    expect(critical).toHaveLength(2);
  });

  test('keeps SELL signals with confidence >= 60 and rawScore <= -35', () => {
    const signals = [
      { action: 'SELL', confidence: 65, rawScore: -40, asset: 'XRP' },
      { action: 'SELL', confidence: 60, rawScore: -35, asset: 'ADA' },
    ];
    const critical = filterCriticalSignals(signals);
    expect(critical).toHaveLength(2);
  });

  test('filters out BUY signals with rawScore < 35', () => {
    const signals = [
      { action: 'BUY', confidence: 70, rawScore: 30, asset: 'BTC' },
    ];
    expect(filterCriticalSignals(signals)).toHaveLength(0);
  });

  test('filters out BUY signals with confidence < 60', () => {
    const signals = [
      { action: 'BUY', confidence: 55, rawScore: 50, asset: 'BTC' },
    ];
    expect(filterCriticalSignals(signals)).toHaveLength(0);
  });

  test('filters out SELL signals with rawScore > -35', () => {
    const signals = [
      { action: 'SELL', confidence: 70, rawScore: -30, asset: 'XRP' },
    ];
    expect(filterCriticalSignals(signals)).toHaveLength(0);
  });

  test('filters out SELL signals with confidence < 60', () => {
    const signals = [
      { action: 'SELL', confidence: 55, rawScore: -40, asset: 'XRP' },
    ];
    expect(filterCriticalSignals(signals)).toHaveLength(0);
  });

  test('always filters out HOLD signals', () => {
    const signals = [
      { action: 'HOLD', confidence: 90, rawScore: 0, asset: 'DOT' },
      { action: 'HOLD', confidence: 100, rawScore: -50, asset: 'SOL' },
    ];
    expect(filterCriticalSignals(signals)).toHaveLength(0);
  });

  test('mixed signals are filtered correctly', () => {
    const signals = [
      { action: 'BUY', confidence: 65, rawScore: 40, asset: 'BTC' },   // critical
      { action: 'BUY', confidence: 50, rawScore: 50, asset: 'ETH' },   // not critical (conf < 60)
      { action: 'SELL', confidence: 70, rawScore: -45, asset: 'XRP' },  // critical
      { action: 'SELL', confidence: 65, rawScore: -20, asset: 'ADA' },  // not critical (rawScore > -35)
      { action: 'HOLD', confidence: 90, rawScore: 0, asset: 'DOT' },   // never critical
    ];
    const critical = filterCriticalSignals(signals);
    expect(critical).toHaveLength(2);
    expect(critical[0].asset).toBe('BTC');
    expect(critical[1].asset).toBe('XRP');
  });

  test('boundary: BUY with exactly 60 confidence and 35 rawScore passes', () => {
    const signals = [{ action: 'BUY', confidence: 60, rawScore: 35, asset: 'TEST' }];
    expect(filterCriticalSignals(signals)).toHaveLength(1);
  });

  test('boundary: SELL with exactly 60 confidence and -35 rawScore passes', () => {
    const signals = [{ action: 'SELL', confidence: 60, rawScore: -35, asset: 'TEST' }];
    expect(filterCriticalSignals(signals)).toHaveLength(1);
  });
});
