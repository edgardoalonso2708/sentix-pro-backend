// ═══════════════════════════════════════════════════════════════════════════════
// MACRO FETCHERS UNIT TESTS
// Tests for fetchHistoricalBtcDominance and fetchHistoricalDXY
// Axios must be mocked BEFORE requiring backtester (binanceAPI uses axios.create)
// ═══════════════════════════════════════════════════════════════════════════════

// Mock axios before any require that triggers binanceAPI
jest.mock('axios', () => {
  const mockAxios = {
    get: jest.fn(),
    create: jest.fn(() => ({
      get: jest.fn(),
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() }
      }
    }))
  };
  return mockAxios;
});

const axios = require('axios');
const { fetchHistoricalBtcDominance, fetchHistoricalDXY, lookupByTimestamp, _resetMacroCache } = require('../backtester');

// ═══════════════════════════════════════════════════════════════════════════════
// fetchHistoricalBtcDominance Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('fetchHistoricalBtcDominance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetMacroCache();
  });

  test('returns array with correct structure using Anchor+Drift model', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('/global')) {
        return Promise.resolve({
          data: { data: { market_cap_percentage: { btc: 55.0 } } }
        });
      }
      if (url.includes('/market_chart')) {
        const now = Date.now();
        return Promise.resolve({
          data: {
            market_caps: [
              [now - 2 * 86400000, 800e9],
              [now - 1 * 86400000, 900e9],
              [now, 1000e9]
            ]
          }
        });
      }
      return Promise.reject(new Error('unexpected URL'));
    });

    const result = await fetchHistoricalBtcDominance(30);

    expect(result.length).toBe(3);
    expect(result[0]).toHaveProperty('timestamp');
    expect(result[0]).toHaveProperty('btcDom');
    expect(result[0]).toHaveProperty('btcMcap');

    // At 80% mcap ratio: btcDom = 55 * (1 + 0.3 * (0.8 - 1)) = 55 * 0.94 = 51.7
    expect(result[0].btcDom).toBeCloseTo(51.7, 0);
    // At 100% mcap ratio: btcDom = 55 * (1 + 0.3 * 0) = 55
    expect(result[2].btcDom).toBeCloseTo(55.0, 0);
  });

  test('btcDom is always clamped between 30 and 75', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('/global')) {
        return Promise.resolve({
          data: { data: { market_cap_percentage: { btc: 70.0 } } }
        });
      }
      if (url.includes('/market_chart')) {
        const now = Date.now();
        return Promise.resolve({
          data: {
            market_caps: [
              [now - 86400000, 500e9],   // 50% ratio
              [now, 1000e9]
            ]
          }
        });
      }
      return Promise.reject(new Error('unexpected URL'));
    });

    const result = await fetchHistoricalBtcDominance(30);
    for (const p of result) {
      expect(p.btcDom).toBeGreaterThanOrEqual(30);
      expect(p.btcDom).toBeLessThanOrEqual(75);
    }
  });

  test('returns [] when CoinGecko /global fails', async () => {
    axios.get.mockRejectedValue(new Error('Network error'));
    const result = await fetchHistoricalBtcDominance(30);
    expect(result).toEqual([]);
  });

  test('returns [] when market_caps is empty', async () => {
    axios.get.mockImplementation((url) => {
      if (url.includes('/global')) {
        return Promise.resolve({
          data: { data: { market_cap_percentage: { btc: 55.0 } } }
        });
      }
      if (url.includes('/market_chart')) {
        return Promise.resolve({ data: { market_caps: [] } });
      }
      return Promise.reject(new Error('unexpected URL'));
    });

    const result = await fetchHistoricalBtcDominance(30);
    expect(result).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// fetchHistoricalDXY Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('fetchHistoricalDXY', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetMacroCache();
  });

  test('returns array with correct structure and DXY formula', async () => {
    axios.get.mockResolvedValue({
      data: {
        rates: {
          '2025-01-01': { EUR: 0.85 },
          '2025-01-02': { EUR: 0.86 },
          '2025-01-03': { EUR: 0.84 }
        }
      }
    });

    const result = await fetchHistoricalDXY(30);

    expect(result.length).toBe(3);
    expect(result[0]).toHaveProperty('timestamp');
    expect(result[0]).toHaveProperty('dxy');
    expect(result[0]).toHaveProperty('dxyTrend');
    expect(result[0]).toHaveProperty('dxyChange');

    // DXY = eurRate * 120 (eurRate is EUR per 1 USD from Frankfurter)
    expect(result[0].dxy).toBeCloseTo(0.85 * 120, 1);
    expect(result[1].dxy).toBeCloseTo(0.86 * 120, 1);
    expect(result[2].dxy).toBeCloseTo(0.84 * 120, 1);
  });

  test('trend detection: rising/falling/stable', async () => {
    axios.get.mockResolvedValue({
      data: {
        rates: {
          '2025-01-01': { EUR: 0.85 },
          '2025-01-02': { EUR: 0.87 },
          '2025-01-03': { EUR: 0.83 }
        }
      }
    });

    const result = await fetchHistoricalDXY(30);

    expect(result[0].dxyTrend).toBe('stable');
    expect(result[0].dxyChange).toBe(0);

    // 0.87 > 0.85 → DXY rose → rising
    expect(result[1].dxyTrend).toBe('rising');
    expect(result[1].dxyChange).toBeGreaterThan(0);

    // 0.83 < 0.87 → DXY fell → falling
    expect(result[2].dxyTrend).toBe('falling');
    expect(result[2].dxyChange).toBeLessThan(0);
  });

  test('returns [] when Frankfurter API fails', async () => {
    axios.get.mockRejectedValue(new Error('Network error'));
    const result = await fetchHistoricalDXY(30);
    expect(result).toEqual([]);
  });

  test('returns [] when rates object is missing', async () => {
    axios.get.mockResolvedValue({ data: {} });
    const result = await fetchHistoricalDXY(30);
    expect(result).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// lookupByTimestamp integration with new macro data
// ═══════════════════════════════════════════════════════════════════════════════

describe('lookupByTimestamp with macro data', () => {
  test('finds closest BTC dominance point', () => {
    const btcDomData = [
      { timestamp: 1000, btcDom: 54.2, btcMcap: 900e9 },
      { timestamp: 2000, btcDom: 55.0, btcMcap: 950e9 },
      { timestamp: 3000, btcDom: 55.8, btcMcap: 1000e9 }
    ];

    const result = lookupByTimestamp(btcDomData, 2200);
    expect(result.btcDom).toBe(55.0);
    expect(result.btcMcap).toBe(950e9);
  });

  test('finds closest DXY point', () => {
    const dxyData = [
      { timestamp: 1000, dxy: 102.5, dxyTrend: 'stable', dxyChange: 0 },
      { timestamp: 2000, dxy: 103.2, dxyTrend: 'rising', dxyChange: 0.68 },
      { timestamp: 3000, dxy: 102.8, dxyTrend: 'falling', dxyChange: -0.39 }
    ];

    const result = lookupByTimestamp(dxyData, 2800);
    expect(result.dxy).toBe(102.8);
    expect(result.dxyTrend).toBe('falling');
  });
});
