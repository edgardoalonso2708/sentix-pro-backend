const request = require('supertest');

// Mock all external dependencies before requiring the app
jest.mock('axios');
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => ({
      select: jest.fn(() => ({
        order: jest.fn(() => ({
          limit: jest.fn(() => Promise.resolve({ data: [], error: null })),
        })),
        eq: jest.fn(() => ({
          single: jest.fn(() => Promise.resolve({ data: { user_id: 'test', portfolio: [] }, error: null })),
        })),
      })),
      insert: jest.fn(() => Promise.resolve({ data: null, error: null })),
      upsert: jest.fn(() => Promise.resolve({ data: null, error: null })),
    })),
  })),
}));

jest.mock('node-telegram-bot-api', () => {
  return jest.fn().mockImplementation(() => ({
    onText: jest.fn(),
    sendMessage: jest.fn().mockResolvedValue(true),
  }));
});

jest.mock('node-cron', () => ({
  schedule: jest.fn(),
}));

const axios = require('axios');
let app;

beforeAll(() => {
  // Suppress console output during tests
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});

  // Mock axios for initial market data load
  axios.get.mockResolvedValue({ data: {} });
  axios.post.mockResolvedValue({ data: {} });

  app = require('../server');
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// Health Check Route
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /', () => {
  test('returns status and version', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'ORACLE Backend Online');
    expect(res.body).toHaveProperty('version', '1.0.0');
    expect(res.body).toHaveProperty('lastUpdate');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Market Data Route
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/market', () => {
  test('returns market cache object', async () => {
    const res = await request(app).get('/api/market');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('crypto');
    expect(res.body).toHaveProperty('metals');
    expect(res.body).toHaveProperty('lastUpdate');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Signals Route
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/signals', () => {
  test('returns an array', async () => {
    const res = await request(app).get('/api/signals');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Alerts Route
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/alerts', () => {
  test('returns an array', async () => {
    const res = await request(app).get('/api/alerts');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Portfolio Routes
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/portfolio', () => {
  test('saves portfolio and returns success', async () => {
    const res = await request(app)
      .post('/api/portfolio')
      .send({ user_id: 'test-user', portfolio: [{ asset: 'bitcoin', amount: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
  });
});

describe('GET /api/portfolio/:userId', () => {
  test('returns portfolio for user', async () => {
    const res = await request(app).get('/api/portfolio/test-user');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('user_id');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Send Alert Route
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/send-alert', () => {
  test('sends alert and returns success', async () => {
    axios.post.mockResolvedValueOnce({ data: {} });
    const res = await request(app)
      .post('/api/send-alert')
      .send({ email: 'test@example.com', message: 'Test alert' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
  });
});
