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
          order: jest.fn(() => Promise.resolve({ data: [], error: null })),
          single: jest.fn(() => Promise.resolve({ data: { user_id: 'test', portfolio: [] }, error: null })),
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
    expect(res.body).toHaveProperty('status', 'SENTIX PRO Backend Online');
    expect(res.body).toHaveProperty('version', '2.1.0');
    expect(res.body).toHaveProperty('lastUpdate');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Market Data Route
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/market', () => {
  test('returns 503 when cache is empty', async () => {
    const res = await request(app).get('/api/market');
    expect(res.status).toBe(503);
    expect(res.body).toHaveProperty('error');
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
// Send Alert Route
// ═══════════════════════════════════════════════════════════════════════════════

describe('POST /api/send-alert', () => {
  test('sends alert and returns success', async () => {
    const res = await request(app)
      .post('/api/send-alert')
      .send({ email: 'test@example.com', message: 'Test alert' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
  });

  test('returns 400 when email missing', async () => {
    const res = await request(app)
      .post('/api/send-alert')
      .send({ message: 'Test alert' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when message missing', async () => {
    const res = await request(app)
      .post('/api/send-alert')
      .send({ email: 'test@example.com' });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Portfolio Routes
// ═══════════════════════════════════════════════════════════════════════════════

describe('GET /api/portfolio/:userId', () => {
  test('returns portfolio for valid user', async () => {
    const res = await request(app).get('/api/portfolio/default-user');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('userId');
  });

  test('returns 400 for invalid user ID', async () => {
    const res = await request(app).get('/api/portfolio/a');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/portfolio/template', () => {
  test('returns CSV template', async () => {
    const res = await request(app).get('/api/portfolio/template');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
  });
});
