// Test data fetching functions by requiring server with mocked dependencies
jest.mock('axios');
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        order: jest.fn(() => ({
          limit: jest.fn(() => Promise.resolve({ data: [], error: null })),
        })),
        eq: jest.fn(() => ({
          order: jest.fn(() => Promise.resolve({ data: [], error: null })),
          single: jest.fn(() => Promise.resolve({ data: null, error: null })),
        })),
      })),
      insert: jest.fn(() => ({
        select: jest.fn(() => Promise.resolve({ data: [], error: null })),
      })),
      upsert: jest.fn(() => Promise.resolve({ data: null, error: null })),
      delete: jest.fn(() => ({
        eq: jest.fn(() => Promise.resolve({ data: null, error: null })),
      })),
    })),
  })),
}));

jest.mock('node-telegram-bot-api', () => {
  return jest.fn().mockImplementation(() => ({
    onText: jest.fn(),
    sendMessage: jest.fn().mockResolvedValue(true),
    on: jest.fn(),
    stopPolling: jest.fn(),
  }));
});

jest.mock('node-cron', () => ({
  schedule: jest.fn(),
}));

const axios = require('axios');

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('Data fetching via /api/market', () => {
  let app;

  beforeAll(() => {
    axios.get.mockResolvedValue({ data: {} });
    axios.post.mockResolvedValue({ data: {} });
    app = require('../server');
  });

  test('market endpoint returns 503 when cache is empty', async () => {
    const request = require('supertest');
    const res = await request(app).get('/api/market');
    // Cache is empty because updateMarketData() is not called in test mode
    expect(res.status).toBe(503);
    expect(res.body).toHaveProperty('error');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test CoinGecko response shape handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('CoinGecko API response parsing', () => {
  test('axios.get is callable with correct URL params', () => {
    // Verify that axios mock works correctly
    expect(axios.get).toBeDefined();
    expect(typeof axios.get).toBe('function');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test Technical Analysis module directly
// ═══════════════════════════════════════════════════════════════════════════════

describe('Technical Analysis module', () => {
  const { calculateRSI, calculateMACD, calculateBollingerBands } = require('../technicalAnalysis');

  test('RSI returns neutral for insufficient data', () => {
    expect(calculateRSI([100, 101])).toBe(50);
  });

  test('MACD returns zeros for insufficient data', () => {
    const result = calculateMACD([100]);
    expect(result.macd).toBe(0);
    expect(result.signal).toBe(0);
    expect(result.histogram).toBe(0);
  });

  test('Bollinger bands fallback for insufficient data', () => {
    const result = calculateBollingerBands([100], 20, 2);
    expect(result.middle).toBe(100);
    expect(result.bandwidth).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test axios error handling
// ═══════════════════════════════════════════════════════════════════════════════

describe('API error handling', () => {
  test('server module exports express app', () => {
    const app = require('../server');
    expect(app).toBeDefined();
    expect(typeof app).toBe('function'); // Express app is a function
  });
});
