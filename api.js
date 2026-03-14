// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - API SERVER
// Express HTTP server + SSE + all REST routes.
// Receives market data and signals from worker processes via IPC.
// ═══════════════════════════════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const { MSG } = require('./shared/ipc');
const { LRUCache } = require('./shared/lruCache');
const { metrics } = require('./shared/metrics');
const { runBacktestInThread, runOptimizeInThread, getStats: getComputeStats, terminateAll: terminateComputeWorkers } = require('./workers/compute');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { SilentTelegramBot, setupTelegramCommands } = require('./telegramBot');
const {
  upload,
  parsePortfolioCSV,
  createWallet,
  getWallets,
  updateWallet,
  deleteWallet,
  savePortfolioToWallet,
  getWalletPortfolio,
  getAllPortfolios,
  getConsolidatedPortfolio,
  calculateWalletPnL,
  calculatePnLByWallet,
  calculateConsolidatedPnL,
  WALLET_PROVIDERS,
  WALLET_TYPES
} = require('./portfolioManager');
const {
  validateEnvironment,
  createRateLimiter,
  sanitizeInput,
  isValidUserId
} = require('./security');
const { Resend } = require('resend');
const { logger } = require('./logger');
const { classifyAxiosError, Provider } = require('./errors');
const { getFeatures, getFeaturesForAssets, getCacheStats } = require('./featureStore');
const { getAllRegimes, getRegime } = require('./marketRegime');
const {
  getOrCreateConfig,
  updateConfig,
  resetPaperAccount,
  getPerformanceMetrics,
  getAdvancedPerformance,
  getTradeHistory,
  getOpenPositions,
  getPositionHeatMap,
  executeFullClose,
  resolveCurrentPrice,
  getPositionCorrelations,
  getEquityCurve,
  cleanupOldSnapshots
} = require('./paperTrading');
const { runBacktest } = require('./backtester');
const { startOptimizationJob, getJobStatus, getAllJobs, PARAM_RANGES } = require('./optimizer');
const {
  runAutoTune, getAutoTuneHistory, getActiveConfig, saveActiveConfig, isAutoTuneRunning,
  getApprovalMode, approveProposal, getPendingProposals, PRIORITY_PARAMS,
} = require('./autoTuner');
const { DEFAULT_STRATEGY_CONFIG, SCHEDULE_CONFIG } = require('./strategyConfig');
const { enrichSignalWithTTL } = require('./scheduleUtils');
const { getAccuracyMetrics, getOutcomesByRegimeConfluence } = require('./signalAccuracy');
const { initConfigManager, getConfig, setConfig, getAllConfigs } = require('./configManager');
const { getAllBreakerStatus, getBreaker } = require('./circuitBreaker');
const {
  createOrder, validateOrder, submitOrder, cancelOrder,
  getOrders, getOrder, getExecutionLog, expireOrders,
  ORDER_STATUS
} = require('./orderManager');
const {
  activateKillSwitch, deactivateKillSwitch, getKillSwitchStatus,
  getRiskDashboard
} = require('./riskEngine');
const { requireAuth, optionalAuth } = require('./authMiddleware');
const { requireRole, getProfile, invalidateProfileCache } = require('./roleMiddleware');
const { logAudit, auditContext } = require('./auditLogger');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy when behind Railway/Vercel reverse proxy
app.set('trust proxy', 1);

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:3001',
].filter(Boolean);

// Vercel preview/production domains (*.vercel.app)
const VERCEL_ORIGIN_RE = /^https:\/\/[\w-]+\.vercel\.app$/;

// Security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, etc.)
app.use(helmet({
  contentSecurityPolicy: false,   // Disabled — frontend is served from a different origin
  crossOriginEmbedderPolicy: false // Allow cross-origin API requests
}));

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, server-to-server, curl)
    if (!origin) return callback(null, true);
    // Allow exact matches (FRONTEND_URL, localhost)
    if (allowedOrigins.some(o => origin.startsWith(o))) return callback(null, true);
    // Allow any Vercel deployment (preview URLs, production)
    if (VERCEL_ORIGIN_RE.test(origin)) return callback(null, true);
    // Production: reject unknown origins
    if (process.env.NODE_ENV === 'production') {
      logger.warn('CORS: rejected unknown origin', { origin });
      callback(new Error('CORS not allowed'), false);
    } else {
      // Development: allow all origins with a warning
      logger.warn('CORS: unknown origin (allowed in dev)', { origin });
      callback(null, true);
    }
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));

// Rate limiting — MUST be registered BEFORE route definitions
app.use('/api/', createRateLimiter(60000, 100));

// Request metrics + logging middleware (skip SSE stream to avoid noise)
app.use((req, res, next) => {
  if (req.path === '/api/stream') return next();
  const start = Date.now();
  req.id = crypto.randomUUID().slice(0, 8);
  res.on('finish', () => {
    const duration = Date.now() - start;
    const route = req.route?.path || req.path;
    metrics.counter('http.requests');
    metrics.histogram('http.latency', duration);
    if (res.statusCode >= 400) metrics.counter('http.errors');
    if (res.statusCode >= 500) metrics.counter('http.errors.5xx');
    if (duration > 1000 || res.statusCode >= 400) {
      logger.info('HTTP request', { reqId: req.id, method: req.method, path: req.path, status: res.statusCode, durationMs: duration });
    }
  });
  next();
});

// ─── AUTHENTICATION ───────────────────────────────────────────────────────
// Apply auth to protected route groups (user-specific data)
// Public routes: /api/health, /api/market, /api/signals, /api/stream, /api/config
app.use('/api/paper', requireAuth);
app.use('/api/wallets', requireAuth);
app.use('/api/portfolio', requireAuth);
app.use('/api/orders', requireAuth);
app.use('/api/risk', requireAuth);
app.use('/api/execution-log', requireAuth);
app.use('/api/alert-filters', requireAuth);
app.use('/api/backtest', requireAuth);
app.use('/api/optimize', requireAuth);
app.use('/api/autotune', requireAuth);

// SSE stream uses optional auth (token via query param)
app.use('/api/stream', optionalAuth);

// ─── CONFIGURATION ─────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'edgardoalonso2708@gmail.com';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Initialize config manager (preloads system_config table into memory)
initConfigManager(supabase).catch(err =>
  logger.warn('Config manager preload failed, using defaults', { error: err.message })
);

// ─── DATABASE INITIALIZATION ──────────────────────────────────────────────
// Ensure wallets and portfolios tables exist with correct schema
async function initializeDatabase() {
  try {
    // Test if wallets table exists by querying it
    const { error: walletsError } = await supabase.from('wallets').select('id').limit(1);

    if (walletsError) {
      logger.warn('Wallets table check failed, attempting to create', { error: walletsError.message, code: walletsError.code });

      // Try to create tables via RPC or direct SQL
      const { error: createError } = await supabase.rpc('exec_sql', {
        sql: `
          CREATE TABLE IF NOT EXISTS wallets (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT NOT NULL DEFAULT 'exchange',
            provider TEXT NOT NULL DEFAULT 'other',
            color TEXT DEFAULT '#6366f1',
            icon TEXT,
            is_active BOOLEAN DEFAULT true,
            notes TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW(),
            CONSTRAINT valid_type CHECK (type IN ('exchange', 'wallet', 'cold_storage', 'defi', 'other')),
            CONSTRAINT unique_user_wallet_name UNIQUE (user_id, name)
          );
          CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);
          CREATE INDEX IF NOT EXISTS idx_wallets_user_active ON wallets(user_id, is_active);

          CREATE TABLE IF NOT EXISTS portfolios (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id TEXT NOT NULL,
            wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
            asset TEXT NOT NULL,
            amount NUMERIC(20, 8) NOT NULL CHECK (amount > 0),
            buy_price NUMERIC(20, 8) NOT NULL CHECK (buy_price > 0),
            purchase_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            notes TEXT,
            transaction_id TEXT,
            tags TEXT[],
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_portfolios_user_id ON portfolios(user_id);
          CREATE INDEX IF NOT EXISTS idx_portfolios_wallet_id ON portfolios(wallet_id);
          CREATE INDEX IF NOT EXISTS idx_portfolios_user_wallet ON portfolios(user_id, wallet_id);

        `
      });

      if (createError) {
        logger.warn('Auto-create tables via RPC failed (may need manual SQL execution)', { error: createError.message });
      } else {
        logger.info('Database tables created successfully');
      }
    } else {
      logger.info('Database tables verified OK');
    }
  } catch (err) {
    logger.warn('Database initialization check failed', { error: err.message });
  }
}

// Run DB init on startup
initializeDatabase();

// Initialize Resend email client (optional)
let resend = null;
if (RESEND_API_KEY && RESEND_API_KEY.startsWith('re_') && RESEND_API_KEY.length > 10) {
  resend = new Resend(RESEND_API_KEY);
  logger.info('Resend email client initialized');
} else {
  logger.info('Email alerts not configured (set RESEND_API_KEY)');
}

// Initialize Telegram Bot (silent mode, optional)
const bot = new SilentTelegramBot(TELEGRAM_BOT_TOKEN);

// ─── CACHED DATA (populated via IPC from worker processes) ────────────────
let cachedMarketData = null;
let cachedSignals = [];
let workerMetrics = {}; // Merged metrics from market/alerts workers

// ─── SSE (Server-Sent Events) CLIENTS ──────────────────────────────────────
const sseClients = new Set();
const MAX_SSE_CLIENTS = 100;

// ─── SERVER REFERENCE (for graceful shutdown) ────────────────────────────────
let httpServer = null;

// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL HELPER (for test alerts — production alerts sent by alerts worker)
// ═══════════════════════════════════════════════════════════════════════════════

async function sendEmailAlert(to, subject, htmlBody) {
  if (!resend) {
    return { success: false, error: 'Email not configured (RESEND_API_KEY missing)' };
  }
  let recipients;
  if (Array.isArray(to)) {
    recipients = to.map(e => e.trim()).filter(Boolean);
  } else if (typeof to === 'string' && to.includes(',')) {
    recipients = to.split(',').map(e => e.trim()).filter(Boolean);
  } else {
    recipients = [to].filter(Boolean);
  }
  if (recipients.length === 0) {
    return { success: false, error: 'No valid email recipients' };
  }
  try {
    const { data, error } = await resend.emails.send({
      from: 'SENTIX PRO <onboarding@resend.dev>',
      to: recipients,
      subject,
      html: htmlBody
    });
    if (error) {
      logger.error('Email send error', { provider: Provider.RESEND, error: error.message });
      return { success: false, error: error.message || 'Email send failed' };
    }
    logger.info('Email sent', { to: recipients, id: data?.id });
    return { success: true, id: data?.id };
  } catch (error) {
    logger.error('Email exception', { provider: Provider.RESEND, error: error.message });
    return { success: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    status: 'SENTIX PRO Backend Online',
    version: '2.4.0-phase2',  // Phase 2: Multi-Wallet Portfolio + Phase 1
    lastUpdate: cachedMarketData?.lastUpdate || null,
    signalsCount: cachedSignals.length,
    services: {
      telegram: bot.isActive() ? `active (${bot.getSubscribers().length} subscribers)` : 'not configured',
      email: resend ? 'active' : 'not configured',
      database: SUPABASE_URL ? `connected (${process.env.SUPABASE_SERVICE_ROLE_KEY ? 'service_role' : 'anon'} key)` : 'not configured',
      sse: `active (${sseClients.size} clients)`,  // Phase 1: SSE status
      binance: 'active (real OHLCV)',  // Phase 1: Binance data
      featureStore: 'active'  // Phase 1: Feature computation
    }
  });
});

// Deep health check — probes actual service connectivity
app.get('/api/health', async (req, res) => {
  const checks = {};
  let healthy = true;

  // 1. Supabase connectivity
  try {
    const start = Date.now();
    const { error } = await Promise.race([
      supabase.from('paper_config').select('user_id').limit(1),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
    checks.database = { status: error ? 'degraded' : 'ok', latencyMs: Date.now() - start };
    if (error) healthy = false;
  } catch (err) {
    checks.database = { status: 'down', error: err.message };
    healthy = false;
  }

  // 2. Market data freshness
  const lastUpdate = cachedMarketData?.lastUpdate;
  const staleThresholdMs = 5 * 60 * 1000; // 5 minutes
  if (lastUpdate) {
    const ageMs = Date.now() - new Date(lastUpdate).getTime();
    checks.marketData = { status: ageMs < staleThresholdMs ? 'ok' : 'stale', ageSeconds: Math.round(ageMs / 1000) };
    if (ageMs >= staleThresholdMs) healthy = false;
  } else {
    checks.marketData = { status: 'unavailable' };
    healthy = false;
  }

  // 3. SSE clients
  checks.sse = { clients: sseClients.size, maxClients: MAX_SSE_CLIENTS };

  // 4. Services
  checks.telegram = bot.isActive() ? 'active' : 'disabled';
  checks.email = resend ? 'active' : 'disabled';

  // 5. Cache stats
  checks.caches = {
    backtests: backtestStore.stats(),
    features: getCacheStats()
  };

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    uptime: Math.round(process.uptime()),
    checks
  });
});

// ─── Metrics endpoint (APM) ─────────────────────────────────────────────────
app.get('/api/metrics', (req, res) => {
  const snap = metrics.snapshot();
  snap.caches = {
    backtests: backtestStore.stats(),
    features: getCacheStats()
  };
  snap.workers = workerMetrics;
  res.json(snap);
});

app.get('/api/market', (req, res) => {
  if (!cachedMarketData) {
    return res.status(503).json({ error: 'Market data not yet available' });
  }
  res.json(cachedMarketData);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM CONFIGURATION ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// List all config keys
app.get('/api/config', async (req, res) => {
  try {
    const { configs, error } = await getAllConfigs();
    if (error) return res.status(500).json({ error: error.message || 'Failed to list configs' });
    res.json({ configs });
  } catch (error) {
    logger.error('Config list failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get single config value
app.get('/api/config/:key', async (req, res) => {
  try {
    const key = sanitizeInput(req.params.key);
    const value = await getConfig(key);
    if (value === null) return res.status(404).json({ error: 'Config key not found' });
    res.json({ key, value });
  } catch (error) {
    logger.error('Config get failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update config value
app.put('/api/config/:key', async (req, res) => {
  try {
    const key = sanitizeInput(req.params.key);
    const { value, description } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'Missing value in body' });
    const { error } = await setConfig(key, value, description || null);
    if (error) return res.status(500).json({ error: error.message || 'Failed to set config' });
    res.json({ key, value, updated: true });
  } catch (error) {
    logger.error('Config set failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CIRCUIT BREAKER HEALTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/health/circuit-breakers', (req, res) => {
  res.json({ breakers: getAllBreakerStatus() });
});

app.post('/api/health/circuit-breakers/:provider/reset', (req, res) => {
  try {
    const provider = sanitizeInput(req.params.provider);
    const breaker = getBreaker(provider);
    breaker.reset();
    res.json({ provider, state: breaker.getStatus().state, reset: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MARKET REGIME ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/regime', (req, res) => {
  const all = getAllRegimes();
  const btc = getRegime('bitcoin');
  res.json({
    primary: btc || { regime: cachedMarketData?._regime || 'unknown', confidence: 0 },
    assets: all,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/regime/:asset', (req, res) => {
  const asset = sanitizeInput(req.params.asset);
  const regime = getRegime(asset);
  if (!regime) return res.status(404).json({ error: 'No regime data for asset' });
  res.json(regime);
});

app.get('/api/signals', async (req, res) => {
  let signals = cachedSignals;

  // Fallback: load from database if in-memory is empty (e.g. workers haven't sent data yet)
  if (signals.length === 0) {
    try {
      const { data, error } = await supabase.from('signals').select('*').order('confidence', { ascending: false });
      if (!error && data && data.length > 0) {
        const persisted = data.map(s => ({
          asset: s.asset, action: s.action, strengthLabel: s.strength_label,
          score: s.score, rawScore: s.raw_score, confidence: s.confidence,
          price: s.price, change24h: s.change_24h, reasons: s.reasons,
          indicators: s.indicators, tradeLevels: s.trade_levels || null,
          derivatives: s.derivatives || null, timeframes: s.timeframes || null,
          macroContext: s.macro_context || null, dataSource: s.data_source,
          interval: s.interval_tf, assetClass: s.asset_class, timestamp: s.generated_at
        }));
        cachedSignals = persisted;
        signals = persisted;
      }
    } catch (err) {
      logger.debug('Signal fallback load failed', { error: err.message });
    }
  }

  // Enrich with TTL/freshness metadata on every request
  const enriched = signals.map(s => enrichSignalWithTTL(s, SCHEDULE_CONFIG));
  res.json(enriched);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL ACCURACY
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/signals/accuracy', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 90);
    const asset = req.query.asset ? sanitizeInput(req.query.asset) : null;
    const result = await getAccuracyMetrics(supabase, { days, asset });
    if (result.error) {
      return res.status(500).json({ error: result.error });
    }
    res.json(result);
  } catch (err) {
    logger.warn('Signal accuracy endpoint failed', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch accuracy metrics' });
  }
});

// Regime × Confluence outcome matrix
app.get('/api/signals/accuracy/regime-confluence', async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 60, 1), 365);
    const asset = req.query.asset ? sanitizeInput(req.query.asset) : null;
    const result = await getOutcomesByRegimeConfluence(supabase, { days, asset });
    if (result.error) {
      return res.status(500).json({ error: result.error });
    }
    res.json(result);
  } catch (err) {
    logger.warn('Regime-confluence accuracy endpoint failed', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch regime-confluence data' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SSE (SERVER-SENT EVENTS) - Real-time Market Updates (Phase 1)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/stream', (req, res) => {
  // Reject if too many SSE clients
  if (sseClients.size >= MAX_SSE_CLIENTS) {
    return res.status(503).json({ error: 'Too many SSE clients connected' });
  }

  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Send initial connection message
  res.write('data: {"type":"connected","timestamp":"' + new Date().toISOString() + '"}\n\n');

  // Add client to set
  const clientId = Date.now() + Math.random();
  const client = { id: clientId, res };
  sseClients.add(client);

  logger.info('SSE client connected', { clientId, totalClients: sseClients.size });

  // Send current market data immediately
  if (cachedMarketData) {
    res.write(`data: ${JSON.stringify({
      type: 'market',
      data: cachedMarketData,
      timestamp: new Date().toISOString()
    })}\n\n`);
  }

  // Send current signals immediately
  if (cachedSignals.length > 0) {
    res.write(`data: ${JSON.stringify({
      type: 'signals',
      data: cachedSignals,
      timestamp: new Date().toISOString()
    })}\n\n`);
  }

  // Keep-alive ping every 30 seconds
  const keepAliveInterval = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 30000);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(keepAliveInterval);
    sseClients.delete(client);
    logger.info('SSE client disconnected', { clientId, totalClients: sseClients.size });
  });
});

// Helper function to broadcast to all SSE clients
function broadcastSSE(eventType, data) {
  if (sseClients.size === 0) return;

  const message = `data: ${JSON.stringify({
    type: eventType,
    data,
    timestamp: new Date().toISOString()
  })}\n\n`;

  let sent = 0;
  let failed = 0;

  for (const client of sseClients) {
    try {
      client.res.write(message);
      sent++;
    } catch (error) {
      failed++;
      sseClients.delete(client);
    }
  }

  metrics.counter('sse.broadcasts');
  metrics.counter(`sse.broadcasts.${eventType}`);
  if (sent > 0 || failed > 0) {
    logger.debug('SSE broadcast', { eventType, sent, failed, remaining: sseClients.size });
  }
}

// ─── PAPER TRADE TELEGRAM NOTIFICATIONS ─────────────────────────────────────
async function broadcastPaperTradeNotification(trade, action) {
  if (!bot.isActive()) return;

  const emoji = action === 'open'
    ? (trade.direction === 'LONG' ? '📈' : '📉')
    : action === 'partial' ? '🎯'
    : parseFloat(trade.realized_pnl) >= 0 ? '✅' : '❌';

  let message;
  if (action === 'open') {
    message =
      `${emoji} *PAPER TRADE ABIERTO*\n\n` +
      `*${trade.asset}* - ${trade.direction}\n` +
      `Entrada: $${Number(trade.entry_price).toLocaleString()}\n` +
      `Stop Loss: $${Number(trade.stop_loss).toLocaleString()}\n` +
      `TP1: $${Number(trade.take_profit_1).toLocaleString()}\n` +
      `Tamaño: $${Number(trade.position_size_usd).toFixed(2)}\n` +
      `Riesgo: $${Number(trade.risk_amount).toFixed(2)}\n\n` +
      `⏰ ${new Date().toLocaleString('es-ES')}`;
  } else if (action === 'partial') {
    message =
      `${emoji} *PAPER TRADE - TP1 ALCANZADO*\n\n` +
      `*${trade.asset}*\n` +
      `Cierre parcial (50%) a $${Number(trade.partial_close_price).toLocaleString()}\n` +
      `P&L parcial: $${Number(trade.partial_close_pnl).toFixed(2)}\n\n` +
      `⏰ ${new Date().toLocaleString('es-ES')}`;
  } else {
    message =
      `${emoji} *PAPER TRADE CERRADO*\n\n` +
      `*${trade.asset}* - ${trade.exit_reason}\n` +
      `Entrada: $${Number(trade.entry_price).toLocaleString()}\n` +
      `Salida: $${Number(trade.exit_price).toLocaleString()}\n` +
      `P&L: $${Number(trade.realized_pnl).toFixed(2)} (${Number(trade.realized_pnl_percent).toFixed(2)}%)\n\n` +
      `⏰ ${new Date().toLocaleString('es-ES')}`;
  }

  for (const chatId of bot.getSubscribers()) {
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  }
}

// New endpoint: Get features for an asset
app.get('/api/features/:assetId', async (req, res) => {
  try {
    const assetId = req.params.assetId;
    const interval = req.query.interval || '1h';

    const features = await getFeatures(assetId, interval);

    if (!features) {
      return res.status(404).json({ error: 'Features not available for asset' });
    }

    res.json(features);
  } catch (error) {
    logger.error('Features fetch failed', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch features' });
  }
});

// New endpoint: Get features for multiple assets
app.post('/api/features/batch', async (req, res) => {
  try {
    const { assetIds, interval = '1h' } = req.body;

    if (!assetIds || !Array.isArray(assetIds)) {
      return res.status(400).json({ error: 'assetIds array required' });
    }

    const featuresMap = await getFeaturesForAssets(assetIds, interval);
    res.json(featuresMap);
  } catch (error) {
    logger.error('Batch features fetch failed', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch features' });
  }
});

app.get('/api/alerts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('alerts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    logger.error('Failed to fetch alerts', { provider: Provider.SUPABASE, error: error.message });
    res.json([]);
  }
});

app.post('/api/send-alert', async (req, res) => {
  const { email, message } = req.body;

  if (!email || !message) {
    return res.status(400).json({ error: 'Email and message required' });
  }

  const results = { email: null, telegram: null };

  // Send test alert via Email
  const emailResult = await sendEmailAlert(
    email,
    '🧪 SENTIX PRO - Test Alert',
    `
    <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; border-radius: 12px; overflow: hidden;">
      <div style="background: linear-gradient(135deg, #1e293b, #334155); padding: 24px; text-align: center;">
        <h1 style="margin: 0; font-size: 24px; color: #f8fafc;">🧪 Test Alert</h1>
        <p style="margin: 4px 0 0; color: #94a3b8; font-size: 14px;">SENTIX PRO</p>
      </div>
      <div style="padding: 24px;">
        <p style="color: #e2e8f0; font-size: 16px; line-height: 1.6;">${message}</p>
        <p style="color: #64748b; font-size: 13px; margin-top: 16px;">Si recibes este email, tus alertas están configuradas correctamente. Recibirás notificaciones automáticas cuando se detecten señales BUY/SELL con alta confianza.</p>
      </div>
      <div style="padding: 16px 24px; background: #1e293b; text-align: center;">
        <p style="margin: 0; color: #64748b; font-size: 12px;">SENTIX PRO v2.1 · ${new Date().toLocaleString('es-ES')}</p>
      </div>
    </div>
    `
  );
  results.email = emailResult.success ? 'sent' : emailResult.error;

  // Send test alert via Telegram to all subscribers
  if (bot.isActive()) {
    const subscribers = bot.getSubscribers();
    if (subscribers.length > 0) {
      for (const chatId of subscribers) {
        const result = await bot.sendMessage(
          chatId,
          `🧪 *Test Alert*\n\n${message}\n\n📧 Email: ${email}`,
          { parse_mode: 'Markdown' }
        );
        if (result.success) results.telegram = 'sent';
      }
    } else {
      results.telegram = 'no subscribers - send /start to the bot first';
    }
  } else {
    results.telegram = 'bot not configured (set TELEGRAM_BOT_TOKEN)';
  }

  logger.info('Test alert sent', { email: results.email, telegram: results.telegram });

  res.json({
    success: true,
    message: 'Test alert processed',
    delivery: results
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ALERT FILTER ENDPOINTS
// Per-user customizable alert preferences
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/alert-filters/:userId - Get user's alert filter preferences
app.get('/api/alert-filters/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const { data, error } = await supabase
      .from('alert_filters')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code === 'PGRST116') {
      // No row found - return defaults
      return res.json({
        user_id: userId,
        assets: [],
        actions: ['BUY', 'SELL', 'STRONG BUY', 'STRONG SELL'],
        min_confidence: 50,
        min_score: 25,
        telegram_enabled: true,
        email_enabled: true,
        alert_emails: '',
        quiet_start: null,
        quiet_end: null,
        cooldown_minutes: 20,
        enabled: true
      });
    }

    if (error) throw error;
    res.json(data);
  } catch (error) {
    logger.error('Failed to fetch alert filters', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch alert filters' });
  }
});

// PUT /api/alert-filters/:userId - Create or update alert filter preferences
app.put('/api/alert-filters/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const {
      assets, actions, min_confidence, min_score,
      telegram_enabled, email_enabled, alert_emails,
      quiet_start, quiet_end, cooldown_minutes, enabled
    } = req.body;

    // Validate
    if (min_confidence !== undefined && (min_confidence < 0 || min_confidence > 100)) {
      return res.status(400).json({ error: 'min_confidence must be 0-100' });
    }
    if (min_score !== undefined && (min_score < 0 || min_score > 100)) {
      return res.status(400).json({ error: 'min_score must be 0-100' });
    }
    if (cooldown_minutes !== undefined && (cooldown_minutes < 1 || cooldown_minutes > 1440)) {
      return res.status(400).json({ error: 'cooldown_minutes must be 1-1440' });
    }

    const payload = {
      user_id: userId,
      updated_at: new Date().toISOString()
    };

    // Only include fields that were sent
    if (assets !== undefined) payload.assets = assets;
    if (actions !== undefined) payload.actions = actions;
    if (min_confidence !== undefined) payload.min_confidence = min_confidence;
    if (min_score !== undefined) payload.min_score = min_score;
    if (telegram_enabled !== undefined) payload.telegram_enabled = telegram_enabled;
    if (email_enabled !== undefined) payload.email_enabled = email_enabled;
    if (quiet_start !== undefined) payload.quiet_start = quiet_start;
    if (quiet_end !== undefined) payload.quiet_end = quiet_end;
    if (cooldown_minutes !== undefined) payload.cooldown_minutes = cooldown_minutes;
    if (enabled !== undefined) payload.enabled = enabled;
    if (alert_emails !== undefined) payload.alert_emails = alert_emails;

    const { data, error } = await supabase
      .from('alert_filters')
      .upsert(payload, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) throw error;
    logger.info('Alert filters updated', { userId });
    res.json(data);
  } catch (error) {
    logger.error('Failed to update alert filters', { error: error.message });
    res.status(500).json({ error: 'Failed to update alert filters' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WALLET CRUD ENDPOINTS (Phase 2)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/wallets/:userId - Get all wallets for a user
app.get('/api/wallets/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);

    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const includeInactive = req.query.includeInactive === 'true';
    const wallets = await getWallets(supabase, userId, includeInactive);

    // Enhance with position counts using wallet_summary view
    const { data: summaries, error } = await supabase
      .from('wallet_summary')
      .select('*')
      .eq('user_id', userId);

    if (!error && summaries) {
      const summaryMap = {};
      for (const s of summaries) {
        summaryMap[s.wallet_id] = s;
      }

      wallets.forEach(w => {
        const summary = summaryMap[w.id];
        if (summary) {
          w.position_count = summary.position_count || 0;
          w.unique_assets = summary.unique_assets || 0;
          w.total_invested = summary.total_invested || 0;
        }
      });
    }

    res.json({ wallets });

  } catch (error) {
    logger.error('Failed to fetch wallets', {
      error: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint
    });

    // Handle missing table or RLS
    if (error.code === '42P01' || (error.message && error.message.includes('does not exist'))) {
      return res.json({ wallets: [], hint: 'Table does not exist. Run migration SQL.' });
    }
    if (error.code === '42501' || (error.message && error.message.includes('row-level security'))) {
      return res.json({ wallets: [], hint: 'RLS blocking access. Disable RLS on wallets table.' });
    }

    res.status(500).json({ error: 'Failed to fetch wallets', details: error.message });
  }
});

// POST /api/wallets - Create a new wallet
app.post('/api/wallets', async (req, res) => {
  try {
    const { userId, name, type, provider, color, icon, notes } = req.body;

    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Wallet name is required' });
    }

    if (!type || !WALLET_TYPES.includes(type)) {
      return res.status(400).json({
        error: `Invalid wallet type. Must be one of: ${WALLET_TYPES.join(', ')}`
      });
    }

    const wallet = await createWallet(supabase, userId, {
      name,
      type,
      provider: provider || 'other',
      color: color || '#6366f1',
      icon,
      notes
    });

    res.json({
      success: true,
      wallet
    });

  } catch (error) {
    logger.error('Failed to create wallet', {
      error: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint
    });

    // Handle duplicate name error
    if (error.message && error.message.includes('unique_user_wallet_name')) {
      return res.status(409).json({
        error: 'A wallet with this name already exists'
      });
    }

    // Handle RLS errors
    if (error.code === '42501' || (error.message && error.message.includes('row-level security'))) {
      return res.status(500).json({
        error: 'Database permission error. RLS may need to be disabled for the wallets table.',
        hint: 'Run in Supabase SQL Editor: ALTER TABLE wallets DISABLE ROW LEVEL SECURITY;'
      });
    }

    // Handle missing table
    if (error.code === '42P01' || (error.message && error.message.includes('does not exist'))) {
      return res.status(500).json({
        error: 'Wallets table does not exist. Run the migration SQL in Supabase SQL Editor.',
        hint: 'See migrations/001_multi_wallet_schema.sql'
      });
    }

    res.status(500).json({
      error: 'Failed to create wallet',
      details: error.message
    });
  }
});

// PATCH /api/wallets/:walletId - Update wallet details
app.patch('/api/wallets/:walletId', async (req, res) => {
  try {
    const walletId = req.params.walletId;
    const { userId, ...updates } = req.body;

    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Remove undefined fields
    Object.keys(updates).forEach(key => {
      if (updates[key] === undefined) delete updates[key];
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const wallet = await updateWallet(supabase, walletId, userId, updates);

    res.json({
      success: true,
      wallet
    });

  } catch (error) {
    logger.error('Failed to update wallet', { error: error.message });
    res.status(500).json({ error: 'Failed to update wallet' });
  }
});

// DELETE /api/wallets/:walletId - Soft-delete a wallet
app.delete('/api/wallets/:walletId', async (req, res) => {
  try {
    const walletId = req.params.walletId;
    const { userId } = req.body;

    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const wallet = await deleteWallet(supabase, walletId, userId);

    res.json({
      success: true,
      message: 'Wallet archived successfully',
      wallet
    });

  } catch (error) {
    logger.error('Failed to delete wallet', { error: error.message });
    res.status(500).json({ error: 'Failed to delete wallet' });
  }
});

// GET /api/wallets/:userId/summary - High-level wallet summary with P&L
app.get('/api/wallets/:userId/summary', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);

    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Get all wallets
    const wallets = await getWallets(supabase, userId);

    // Get all positions
    const allPositions = await getAllPortfolios(supabase, userId);

    // Calculate P&L by wallet
    const walletPnLs = calculatePnLByWallet(allPositions, cachedMarketData);

    // Calculate consolidated
    const consolidated = calculateConsolidatedPnL(allPositions, cachedMarketData);

    // Build summary
    const walletsWithPnL = wallets.map(w => {
      const pnl = walletPnLs.find(wp => wp.walletId === w.id);
      return {
        id: w.id,
        name: w.name,
        type: w.type,
        provider: w.provider,
        color: w.color,
        value: pnl?.totalValue || 0,
        invested: pnl?.totalInvested || 0,
        pnl: pnl?.totalPnL || 0,
        pnlPercent: pnl?.totalPnLPercent || 0,
        positionCount: pnl?.positionCount || 0
      };
    });

    res.json({
      userId,
      wallets: walletsWithPnL,
      consolidated: {
        totalValue: consolidated.totalValue,
        totalInvested: consolidated.totalInvested,
        totalPnL: consolidated.totalPnL,
        totalPnLPercent: consolidated.totalPnLPercent,
        walletCount: consolidated.walletCount,
        positionCount: consolidated.positionCount
      }
    });

  } catch (error) {
    logger.error('Wallet summary fetch failed', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch wallet summary' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO ROUTES (Phase 2: Multi-Wallet Support)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/portfolio/template', (req, res) => {
  const csvContent = `Asset,Amount,Buy Price,Purchase Date,Notes,Transaction ID
bitcoin,0.5,42000,2024-01-15,Initial purchase,tx_123abc
ethereum,5.0,2500,2024-01-20,DCA entry,tx_456def
solana,100,85,2024-02-01,Swing trade,tx_789ghi
cardano,5000,0.45,2024-02-10,Long term hold,`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=portfolio-template.csv');
  res.send(csvContent);
});

// POST /api/portfolio/save - Save positions to a wallet via JSON
app.post('/api/portfolio/save', async (req, res) => {
  try {
    const { userId, walletId, positions } = req.body;

    if (!isValidUserId(sanitizeInput(userId || ''))) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    if (!walletId) {
      return res.status(400).json({ error: 'Wallet ID is required' });
    }

    if (!positions || !Array.isArray(positions) || positions.length === 0) {
      return res.status(400).json({ error: 'Positions array is required' });
    }

    const result = await savePortfolioToWallet(supabase, userId, walletId, positions);

    res.json({
      success: true,
      message: `Saved ${result.count} positions to wallet`,
      positions: result.count,
      walletId
    });

  } catch (error) {
    logger.error('Portfolio save failed', { error: error.message });

    if (error.message.includes('Wallet not found')) {
      return res.status(404).json({ error: 'Wallet not found or access denied' });
    }

    res.status(500).json({ error: 'Failed to save portfolio', message: error.message });
  }
});

// POST /api/portfolio/upload - Upload CSV file to a wallet
app.post('/api/portfolio/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const userId = sanitizeInput(req.body.userId || 'default-user');
    const walletId = req.body.walletId;

    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    if (!walletId) {
      return res.status(400).json({ error: 'Wallet ID is required' });
    }

    // Parse CSV
    const positions = await parsePortfolioCSV(req.file.path);

    // Save to wallet
    const result = await savePortfolioToWallet(supabase, userId, walletId, positions);

    res.json({
      success: true,
      message: `Successfully uploaded ${result.count} positions to wallet`,
      positions: result.count,
      walletId
    });

  } catch (error) {
    logger.error('Portfolio upload failed', { error: error.message, type: error.type });

    if (error.type === 'validation') {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.errors
      });
    }

    if (error.message.includes('Wallet not found')) {
      return res.status(404).json({
        error: 'Wallet not found or access denied'
      });
    }

    res.status(500).json({
      error: 'Failed to upload portfolio',
      message: error.message
    });
  }
});

app.get('/api/portfolio/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);

    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const allPositions = await getAllPortfolios(supabase, userId);

    // Calculate P&L by wallet
    const walletPnLs = calculatePnLByWallet(allPositions, cachedMarketData);

    // Calculate consolidated P&L
    const consolidatedPnL = calculateConsolidatedPnL(allPositions, cachedMarketData);

    res.json({
      userId,
      byWallet: walletPnLs,
      consolidated: consolidatedPnL,
      totalPositions: allPositions.length
    });

  } catch (error) {
    logger.error('Portfolio fetch failed', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch portfolio' });
  }
});

// GET /api/portfolio/:userId/wallet/:walletId - Get specific wallet portfolio
app.get('/api/portfolio/:userId/wallet/:walletId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    const walletId = req.params.walletId;

    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const positions = await getWalletPortfolio(supabase, userId, walletId);
    const walletPnL = calculateWalletPnL(positions, cachedMarketData);

    res.json({
      userId,
      walletId,
      wallet: walletPnL
    });

  } catch (error) {
    logger.error('Wallet portfolio fetch failed', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch wallet portfolio' });
  }
});

// GET /api/portfolio/:userId/consolidated - Get consolidated portfolio view
app.get('/api/portfolio/:userId/consolidated', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);

    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const consolidated = await getConsolidatedPortfolio(supabase, userId);

    // Enrich with current prices and P&L
    const enriched = consolidated.map(pos => {
      const currentPrice = cachedMarketData?.crypto?.[pos.asset]?.price || 0;
      const currentValue = pos.total_amount * currentPrice;
      const invested = pos.total_invested;
      const pnl = currentValue - invested;
      const pnlPercent = invested > 0 ? (pnl / invested) * 100 : 0;

      return {
        ...pos,
        current_price: currentPrice,
        current_value: currentValue,
        pnl,
        pnl_percent: pnlPercent
      };
    });

    // Calculate totals
    const totalValue = enriched.reduce((sum, p) => sum + p.current_value, 0);
    const totalInvested = enriched.reduce((sum, p) => sum + p.total_invested, 0);
    const totalPnL = totalValue - totalInvested;
    const totalPnLPercent = totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0;

    res.json({
      userId,
      positions: enriched,
      summary: {
        totalValue,
        totalInvested,
        totalPnL,
        totalPnLPercent,
        positionCount: enriched.length
      }
    });

  } catch (error) {
    logger.error('Consolidated portfolio fetch failed', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch consolidated portfolio' });
  }
});

app.delete('/api/portfolio/:userId/:positionId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    const positionId = req.params.positionId; // UUID, no parseInt needed

    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const { error } = await supabase
      .from('portfolios')
      .delete()
      .eq('id', positionId)
      .eq('user_id', userId);

    if (error) throw error;

    res.json({ success: true, message: 'Position deleted' });

  } catch (error) {
    logger.error('Portfolio delete failed', { error: error.message });
    res.status(500).json({ error: 'Failed to delete position' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAPER TRADING API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// Get paper trading config
app.get('/api/paper/config/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const { config, error } = await getOrCreateConfig(supabase, userId);
    if (error) return res.status(500).json({ error: error.message || 'Failed to get config' });
    res.json({ config });
  } catch (error) {
    logger.error('Paper config fetch failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update paper trading config
app.post('/api/paper/config/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const { config, error } = await updateConfig(supabase, userId, req.body);
    if (error) return res.status(400).json({ error: error.message || error });

    await logAudit(supabase, {
      userId: req.userId, action: 'config_change',
      resource: 'paper_config', details: { changes: req.body },
      ...auditContext(req)
    });

    res.json({ config });
  } catch (error) {
    logger.error('Paper config update failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reset paper trading account
app.post('/api/paper/reset/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const { config, closedCount, error } = await resetPaperAccount(supabase, userId);
    if (error) return res.status(500).json({ error: error.message || 'Reset failed' });
    res.json({ config, closedCount, message: `Account reset. ${closedCount} trades closed.` });
  } catch (error) {
    logger.error('Paper reset failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get open paper positions with unrealized P&L
app.get('/api/paper/positions/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const { positions, error } = await getOpenPositions(supabase, userId, cachedMarketData);
    if (error) return res.status(500).json({ error: error.message || 'Failed to get positions' });
    res.json({ positions });
  } catch (error) {
    logger.error('Paper positions fetch failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get paper trade history
app.get('/api/paper/history/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const options = {
      status: req.query.status || undefined,
      asset: req.query.asset || undefined,
      limit: Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200),
      offset: Math.max(parseInt(req.query.offset) || 0, 0)
    };
    const { trades, total, error } = await getTradeHistory(supabase, userId, options);
    if (error) return res.status(500).json({ error: error.message || 'Failed to get history' });
    res.json({ trades, total });
  } catch (error) {
    logger.error('Paper history fetch failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get performance metrics
app.get('/api/paper/performance/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const { metrics, error } = await getPerformanceMetrics(supabase, userId);
    if (error) return res.status(500).json({ error: error.message || 'Failed to get metrics' });
    res.json({ metrics });
  } catch (error) {
    logger.error('Paper performance fetch failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Advanced performance analytics (breakdowns by asset, hour, day, exit reason, etc.)
app.get('/api/paper/performance-advanced/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const days = Math.min(Math.max(parseInt(req.query.days) || 90, 0), 365);
    const { data, error } = await getAdvancedPerformance(supabase, userId, days);
    if (error) return res.status(500).json({ error: error.message || 'Failed to get advanced metrics' });
    res.json(data);
  } catch (error) {
    logger.error('Advanced performance fetch failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Position correlation analysis
app.get('/api/paper/correlation/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const { positions, error: posError } = await getOpenPositions(supabase, userId, cachedMarketData);
    if (posError) return res.status(500).json({ error: posError.message || 'Failed to get positions' });
    const correlation = await getPositionCorrelations(fetchOHLCVCandles, positions);
    res.json({ correlation });
  } catch (error) {
    logger.error('Paper correlation fetch failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Position heat map + anomaly detection
app.get('/api/paper/heatmap/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const heatMap = await getPositionHeatMap(supabase, userId, cachedMarketData);
    res.json(heatMap);
  } catch (error) {
    logger.error('Position heat map fetch failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Manually close a paper trade
app.post('/api/paper/close/:tradeId', async (req, res) => {
  try {
    const tradeId = req.params.tradeId;

    // Fetch trade
    const { data: trade, error: fetchError } = await supabase
      .from('paper_trades')
      .select('*')
      .eq('id', tradeId)
      .in('status', ['open', 'partial'])
      .single();

    if (fetchError || !trade) {
      return res.status(404).json({ error: 'Trade not found or already closed' });
    }

    // Get current price
    const currentPrice = resolveCurrentPrice(trade.asset, cachedMarketData);
    if (!currentPrice) {
      return res.status(400).json({ error: 'Cannot resolve current price for ' + trade.asset });
    }

    const { closedTrade, pnl, error } = await executeFullClose(supabase, trade, currentPrice, 'manual');
    if (error) return res.status(500).json({ error: error.message || 'Close failed' });

    // Notify
    await broadcastPaperTradeNotification(closedTrade, 'close');
    broadcastSSE('paper_trade', { action: 'closed', trades: [closedTrade] });

    await logAudit(supabase, {
      userId: req.userId, action: 'trade_closed',
      resource: 'paper_trades', details: { tradeId: closedTrade.id, asset: closedTrade.asset, pnl },
      ...auditContext(req)
    });

    res.json({ trade: closedTrade, pnl });
  } catch (error) {
    logger.error('Paper manual close failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete closed paper trades by asset name
app.delete('/api/paper/trades/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const { asset } = req.query;
    if (!asset) return res.status(400).json({ error: 'asset query parameter required' });

    const { data, error } = await supabase
      .from('paper_trades')
      .delete()
      .eq('user_id', userId)
      .eq('status', 'closed')
      .ilike('asset', `%${asset}%`);

    if (error) return res.status(500).json({ error: error.message });

    // Count deleted (Supabase may not return count on delete without .select())
    logger.info('Paper trades deleted by asset', { userId, asset, deleted: data?.length || 'unknown' });
    res.json({ success: true, asset, message: `Closed trades for "${asset}" deleted` });
  } catch (error) {
    logger.error('Paper trade delete by asset failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Real-time equity curve for paper trading
app.get('/api/paper/equity/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const days = Math.min(parseInt(req.query.days) || 7, 30);
    const { curve, error } = await getEquityCurve(supabase, userId, days);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ curve });
  } catch (error) {
    logger.error('Equity curve fetch failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cleanup old equity snapshots (called periodically or manually)
app.delete('/api/paper/equity/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    const keepDays = parseInt(req.query.keepDays) || 7;
    await cleanupOldSnapshots(supabase, userId, keepDays);
    res.json({ success: true, message: `Snapshots older than ${keepDays} days cleaned up` });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER MANAGEMENT API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Create a manual order ──────────────────────────────────────────────────
app.post('/api/orders/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const orderSpec = req.body;
    if (!orderSpec || !orderSpec.asset || !orderSpec.side || !orderSpec.orderType) {
      return res.status(400).json({ error: 'Missing required fields: asset, side, orderType' });
    }

    const { order, error } = await createOrder(supabase, userId, orderSpec);
    if (error) return res.status(400).json({ error: error.message || error });
    res.json({ success: true, order });
  } catch (err) {
    logger.error('POST /api/orders error', { error: err.message });
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// ─── List orders ────────────────────────────────────────────────────────────
app.get('/api/orders/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const filters = {
      status: req.query.status || null,
      asset: req.query.asset || null,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    };

    const { orders, total, error } = await getOrders(supabase, userId, filters);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ orders, total });
  } catch (err) {
    logger.error('GET /api/orders error', { error: err.message });
    res.status(500).json({ error: 'Failed to get orders' });
  }
});

// ─── Get single order ───────────────────────────────────────────────────────
app.get('/api/orders/:userId/:orderId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    const orderId = req.params.orderId;
    if (!isValidUserId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const { order, error } = await getOrder(supabase, userId, orderId);
    if (error) return res.status(404).json({ error: 'Order not found' });
    res.json({ order });
  } catch (err) {
    logger.error('GET /api/orders/:id error', { error: err.message });
    res.status(500).json({ error: 'Failed to get order' });
  }
});

// ─── Cancel order ───────────────────────────────────────────────────────────
app.post('/api/orders/:userId/:orderId/cancel', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    const orderId = req.params.orderId;
    if (!isValidUserId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const { order, error } = await cancelOrder(supabase, userId, orderId);
    if (error) return res.status(400).json({ error: error.message || error });
    res.json({ success: true, order });
  } catch (err) {
    logger.error('POST /api/orders/cancel error', { error: err.message });
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

// ─── Submit (approve) validated order ───────────────────────────────────────
app.post('/api/orders/:userId/:orderId/submit', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    const orderId = req.params.orderId;
    if (!isValidUserId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    // Fetch the order
    const { order, error: fetchError } = await getOrder(supabase, userId, orderId);
    if (fetchError || !order) return res.status(404).json({ error: 'Order not found' });

    if (order.status !== ORDER_STATUS.VALIDATED) {
      return res.status(400).json({ error: `Order must be VALIDATED to submit (current: ${order.status})` });
    }

    // For now, use paper adapter placeholder — will be replaced in Tier 2
    // The adapter will be resolved from the order's execution_adapter field
    const { createAdapter } = require('./execution');
    const adapter = createAdapter(order.execution_adapter || 'paper', { supabase });

    // Fetch user config for ATR-level adjustments
    const { getOrCreateConfig } = require('./paperTrading');
    const { config: userConfig } = await getOrCreateConfig(supabase, userId);

    const { filledOrder, trade, error: submitError } = await submitOrder(
      supabase, userId, order, adapter, cachedMarketData, userConfig
    );

    if (submitError) return res.status(400).json({ error: submitError.message || submitError });
    res.json({ success: true, order: filledOrder, trade });
  } catch (err) {
    logger.error('POST /api/orders/submit error', { error: err.message });
    res.status(500).json({ error: 'Failed to submit order' });
  }
});

// ─── Execution audit log ────────────────────────────────────────────────────
app.get('/api/execution-log/:userId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const filters = {
      orderId: req.query.orderId || null,
      eventType: req.query.eventType || null,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
    };

    const { logs, error } = await getExecutionLog(supabase, userId, filters);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ logs });
  } catch (err) {
    logger.error('GET /api/execution-log error', { error: err.message });
    res.status(500).json({ error: 'Failed to get execution log' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RISK ENGINE API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Risk dashboard ─────────────────────────────────────────────────────────
app.get('/api/risk/:userId/dashboard', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const dashboard = await getRiskDashboard(supabase, userId, cachedMarketData);
    if (dashboard.error) return res.status(500).json({ error: dashboard.error });
    res.json(dashboard);
  } catch (err) {
    logger.error('GET /api/risk/dashboard error', { error: err.message });
    res.status(500).json({ error: 'Failed to get risk dashboard' });
  }
});

// ─── Kill switch — activate ─────────────────────────────────────────────────
app.post('/api/risk/:userId/kill-switch', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const reason = req.body?.reason || 'Manual activation';
    const result = await activateKillSwitch(supabase, userId, reason);

    if (!result.success) {
      return res.status(500).json({ error: 'Failed to activate kill switch' });
    }

    // Broadcast via SSE
    broadcastSSE('kill_switch', { active: true, reason, ...result });

    // Audit log
    await logAudit(supabase, {
      userId: req.userId, action: 'kill_switch',
      resource: 'risk', details: { active: true, reason, ...result },
      ...auditContext(req)
    });

    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('POST /api/risk/kill-switch error', { error: err.message });
    res.status(500).json({ error: 'Failed to activate kill switch' });
  }
});

// ─── Kill switch — deactivate ───────────────────────────────────────────────
app.delete('/api/risk/:userId/kill-switch', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const result = await deactivateKillSwitch(supabase, userId);
    if (!result.success) {
      return res.status(500).json({ error: result.error || 'Failed to deactivate kill switch' });
    }

    broadcastSSE('kill_switch', { active: false });

    res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /api/risk/kill-switch error', { error: err.message });
    res.status(500).json({ error: 'Failed to deactivate kill switch' });
  }
});

// ─── Kill switch — status ───────────────────────────────────────────────────
app.get('/api/risk/:userId/kill-switch', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    if (!isValidUserId(userId)) return res.status(400).json({ error: 'Invalid user ID' });

    const status = await getKillSwitchStatus(supabase, userId);
    res.json(status);
  } catch (err) {
    logger.error('GET /api/risk/kill-switch error', { error: err.message });
    res.status(500).json({ error: 'Failed to get kill switch status' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BACKTEST API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// In-memory backtest store — LRU eviction, max 50 entries
const backtestStore = new LRUCache({ maxSize: 50, name: 'backtests' });

// Concurrent job tracking
let activeBacktestJobs = 0;
const MAX_CONCURRENT_BACKTESTS = 5;
let activeOptimizeJobs = 0;
const MAX_CONCURRENT_OPTIMIZATIONS = 3;

// ─── Launch a backtest ───────────────────────────────────────────────────────
app.post('/api/backtest/run', async (req, res) => {
  try {
    // Reject if too many concurrent backtests
    if (activeBacktestJobs >= MAX_CONCURRENT_BACKTESTS) {
      return res.status(429).json({ error: `Too many concurrent backtests (${activeBacktestJobs}/${MAX_CONCURRENT_BACKTESTS}). Try again later.` });
    }

    const {
      asset = 'bitcoin',
      days = 90,
      capital = 10000,
      riskPerTrade = 0.02,
      maxOpenPositions = 3,
      minConfluence = 2,
      minRR = 1.5,
      stepInterval = '4h',
      allowedStrength = ['STRONG BUY', 'STRONG SELL'],
      cooldownBars = 6,
      userId = 'default-user',
      kellySizing = null,
      strategyConfig = null
    } = req.body;

    // Validate inputs
    if (days < 7 || days > 365) return res.status(400).json({ error: 'days must be between 7 and 365' });
    if (capital < 100 || capital > 10000000) return res.status(400).json({ error: 'capital must be between 100 and 10,000,000' });
    if (!['1h', '4h'].includes(stepInterval)) return res.status(400).json({ error: 'stepInterval must be 1h or 4h' });
    if (typeof riskPerTrade !== 'number' || riskPerTrade < 0.001 || riskPerTrade > 0.10) return res.status(400).json({ error: 'riskPerTrade must be between 0.001 and 0.10' });
    if (!Number.isInteger(maxOpenPositions) || maxOpenPositions < 1 || maxOpenPositions > 10) return res.status(400).json({ error: 'maxOpenPositions must be between 1 and 10' });
    if (!Array.isArray(allowedStrength)) return res.status(400).json({ error: 'allowedStrength must be an array' });

    // Validate Kelly Criterion / Volatility Targeting config
    if (kellySizing != null) {
      if (typeof kellySizing !== 'object') return res.status(400).json({ error: 'kellySizing must be an object or null' });
      if (kellySizing.kelly) {
        if (kellySizing.kelly.fraction !== undefined && (kellySizing.kelly.fraction < 0.1 || kellySizing.kelly.fraction > 1.0))
          return res.status(400).json({ error: 'kellySizing.kelly.fraction must be between 0.1 and 1.0' });
        if (kellySizing.kelly.minTrades !== undefined && (kellySizing.kelly.minTrades < 5 || kellySizing.kelly.minTrades > 200))
          return res.status(400).json({ error: 'kellySizing.kelly.minTrades must be between 5 and 200' });
      }
      if (kellySizing.volatilityTargeting) {
        if (kellySizing.volatilityTargeting.targetATRPercent !== undefined &&
            (kellySizing.volatilityTargeting.targetATRPercent < 0.5 || kellySizing.volatilityTargeting.targetATRPercent > 10))
          return res.status(400).json({ error: 'kellySizing.volatilityTargeting.targetATRPercent must be between 0.5 and 10' });
      }
    }

    // Try to create record in Supabase first
    let recordId = null;
    let useDB = false;

    try {
      const { data: record, error: insertError } = await supabase
        .from('backtest_results')
        .insert({
          user_id: userId,
          asset, days, step_interval: stepInterval, initial_capital: capital,
          risk_per_trade: riskPerTrade, max_open_positions: maxOpenPositions,
          min_confluence: minConfluence, min_rr_ratio: minRR,
          allowed_strength: allowedStrength, status: 'running', progress: 0
        })
        .select()
        .single();

      if (!insertError && record) {
        recordId = record.id;
        useDB = true;
      }
    } catch (dbErr) {
      logger.warn('Supabase unavailable, running backtest in memory mode', { error: dbErr.message });
    }

    // Generate a local ID if DB unavailable
    if (!recordId) {
      recordId = `local-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    }

    // Store initial state in memory
    backtestStore.set(recordId, {
      id: recordId, user_id: userId, asset, days, step_interval: stepInterval,
      initial_capital: capital, status: 'running', progress: 0,
      created_at: new Date().toISOString()
    });

    // Return immediately
    res.json({ id: recordId, status: 'running' });

    // Execute backtest asynchronously (with 5min timeout)
    const BACKTEST_TIMEOUT_MS = 5 * 60 * 1000;
    activeBacktestJobs++;
    logger.info(`Backtest job started: ${recordId}`, { asset, days, stepInterval, activeBacktestJobs });
    (async () => {
      try {
        let lastProgressUpdate = 0;
        const backtestPromise = runBacktest({
          asset, days, stepInterval, capital, riskPerTrade,
          maxOpenPositions, minConfluence, minRR, allowedStrength,
          cooldownBars, fearGreed: 50, derivativesData: null, macroData: null,
          kellySizing, strategyConfig
        }, async (progress) => {
          // Update progress in memory
          const entry = backtestStore.get(recordId);
          if (entry && typeof progress === 'object' && progress.total > 0 && progress.current != null) {
            entry.progress = Math.round((progress.current / progress.total) * 100);
          } else if (entry && typeof progress === 'number') {
            entry.progress = progress;
          }

          // Log progress every 20%
          const pVal = entry?.progress;
          if (typeof pVal === 'number' && pVal - lastProgressUpdate >= 20) {
            lastProgressUpdate = pVal;
            logger.info(`Backtest progress: ${recordId}`, { progress: pVal, asset });
          }

          // Also try DB if available (only for numeric progress, throttle to every 20%)
          if (useDB && typeof pVal === 'number' && !isNaN(pVal) && pVal % 20 === 0) {
            try {
              const { error: progErr } = await supabase.from('backtest_results').update({ progress: pVal }).eq('id', recordId);
              if (progErr) logger.warn(`Backtest progress DB update failed [${progErr.code}]: ${progErr.message}`);
            } catch (_) { /* ignore */ }
          }
        });

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Backtest timed out after ${BACKTEST_TIMEOUT_MS / 60000} minutes`)), BACKTEST_TIMEOUT_MS)
        );

        const result = await Promise.race([backtestPromise, timeoutPromise]);

        // Build completed result
        const metrics = result.metrics || result;

        // Strip internal MC arrays before sending to client/DB
        const mcForClient = result.monteCarlo ? { ...result.monteCarlo } : null;
        if (mcForClient) {
          delete mcForClient._rawSharpes;
          delete mcForClient._rawReturns;
          delete mcForClient._rawProfitFactors;
        }

        const completed = {
          id: recordId, user_id: userId, asset, days, step_interval: stepInterval,
          initial_capital: capital, status: 'completed', progress: 100,
          total_trades: metrics.totalTrades, win_count: metrics.winCount,
          loss_count: metrics.lossCount, win_rate: metrics.winRate,
          total_pnl: metrics.totalPnl, total_pnl_percent: metrics.totalPnlPercent,
          max_drawdown: metrics.maxDrawdown, max_drawdown_percent: metrics.maxDrawdownPercent,
          profit_factor: metrics.profitFactor, sharpe_ratio: metrics.sharpeRatio,
          avg_holding_hours: metrics.avgHoldingBars, trades: result.trades,
          equity_curve: result.equityCurve, metrics: metrics,
          monte_carlo: mcForClient,
          significance: result.significance || null,
          kelly_sizing: result.kellySizing || null,
          completed_at: new Date().toISOString(), created_at: backtestStore.get(recordId)?.created_at
        };

        // Save to memory
        backtestStore.set(recordId, completed);

        // Try to save to DB
        if (useDB) {
          try {
            const { error: updateErr } = await supabase.from('backtest_results').update({
              status: 'completed', progress: 100,
              total_trades: metrics.totalTrades, win_count: metrics.winCount,
              loss_count: metrics.lossCount, win_rate: metrics.winRate,
              total_pnl: metrics.totalPnl, total_pnl_percent: metrics.totalPnlPercent,
              max_drawdown: metrics.maxDrawdown, max_drawdown_percent: metrics.maxDrawdownPercent,
              profit_factor: metrics.profitFactor, sharpe_ratio: metrics.sharpeRatio,
              avg_holding_hours: metrics.avgHoldingBars, trades: result.trades,
              equity_curve: result.equityCurve, metrics: metrics,
              monte_carlo: mcForClient,
              significance: result.significance || null,
              kelly_sizing: result.kellySizing || null,
              completed_at: new Date().toISOString()
            }).eq('id', recordId);
            if (updateErr) logger.error(`Backtest DB update FAILED [${updateErr.code}]: ${updateErr.message} | hint: ${updateErr.hint || 'none'} | details: ${updateErr.details || 'none'}`);
            else logger.info('Backtest saved to DB', { recordId });
          } catch (dbErr) { logger.error(`Backtest DB update exception: ${dbErr.message}`); }
        }

        logger.info(`Backtest completed: ${recordId}`, {
          asset, days, trades: metrics.totalTrades, pnl: metrics.totalPnl
        });

        broadcastSSE('backtest_complete', { id: recordId, asset, status: 'completed' });

      } catch (err) {
        const errMsg = err.message || String(err);
        logger.error(`Backtest failed: ${recordId}`, { error: errMsg, stack: err.stack?.slice(0, 500) });
        backtestStore.set(recordId, {
          ...backtestStore.get(recordId), status: 'failed',
          error_message: errMsg, completed_at: new Date().toISOString()
        });
        if (useDB) {
          try {
            const { error: failErr } = await supabase.from('backtest_results').update({
              status: 'failed', error_message: errMsg.slice(0, 500),
              completed_at: new Date().toISOString()
            }).eq('id', recordId);
            if (failErr) logger.error('Backtest failure DB update failed', { recordId, error: failErr.message });
          } catch (_) { /* ignore */ }
        }
        broadcastSSE('backtest_complete', { id: recordId, asset, status: 'failed', error: errMsg });
      } finally {
        activeBacktestJobs = Math.max(0, activeBacktestJobs - 1);
        logger.info(`Backtest job ended: ${recordId}`, { activeBacktestJobs });
      }
    })();

  } catch (error) {
    logger.error('Backtest launch failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Get backtest results by ID ──────────────────────────────────────────────
app.get('/api/backtest/results/:id', async (req, res) => {
  try {
    // Check in-memory store first
    const memResult = backtestStore.get(req.params.id);
    if (memResult) return res.json(memResult);

    // Try Supabase
    try {
      const { data, error } = await supabase
        .from('backtest_results')
        .select('*')
        .eq('id', req.params.id)
        .single();

      if (!error && data) return res.json(data);
    } catch (_) { /* DB unavailable */ }

    return res.status(404).json({ error: 'Backtest not found' });
  } catch (error) {
    logger.error('Backtest results fetch failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Get backtest history for user ───────────────────────────────────────────
app.get('/api/backtest/history/:userId', async (req, res) => {
  try {
    let results = [];

    // Try Supabase first
    try {
      const { data, error } = await supabase
        .from('backtest_results')
        .select('id, asset, days, step_interval, initial_capital, status, progress, total_trades, win_rate, total_pnl, total_pnl_percent, max_drawdown_percent, profit_factor, sharpe_ratio, error_message, started_at, completed_at, created_at')
        .eq('user_id', req.params.userId)
        .order('created_at', { ascending: false })
        .limit(20);

      if (!error && data) results = data;
    } catch (_) { /* DB unavailable */ }

    // Merge in-memory results
    const memResults = Array.from(backtestStore.values())
      .filter(r => r.user_id === req.params.userId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Add memory results that aren't already in DB results
    const dbIds = new Set(results.map(r => r.id));
    for (const mr of memResults) {
      if (!dbIds.has(mr.id)) {
        results.unshift({
          id: mr.id, asset: mr.asset, days: mr.days, step_interval: mr.step_interval,
          initial_capital: mr.initial_capital, status: mr.status, progress: mr.progress,
          total_trades: mr.total_trades, win_rate: mr.win_rate, total_pnl: mr.total_pnl,
          total_pnl_percent: mr.total_pnl_percent, max_drawdown_percent: mr.max_drawdown_percent,
          profit_factor: mr.profit_factor, sharpe_ratio: mr.sharpe_ratio,
          error_message: mr.error_message, completed_at: mr.completed_at, created_at: mr.created_at
        });
      }
    }

    // Mark stale 'running' records as failed (older than 10 min)
    const STALE_MS = 10 * 60 * 1000;
    const now = Date.now();
    results = results.map(r => {
      if (r.status === 'running' && r.created_at && (now - new Date(r.created_at).getTime()) > STALE_MS) {
        // Also try to update DB in background
        if (supabase) {
          supabase.from('backtest_results').update({ status: 'failed', error_message: 'Timed out' }).eq('id', r.id).then(() => {});
        }
        return { ...r, status: 'failed', error_message: 'Timed out' };
      }
      return r;
    });

    res.json(results.slice(0, 20));
  } catch (error) {
    logger.error('Backtest history failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Delete backtests ─────────────────────────────────────────────────────────
// Support both DELETE and POST (some proxies strip body from DELETE requests)
const handleBacktestDelete = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }

    let dbDeleted = 0;
    let memDeleted = 0;

    // Delete from Supabase
    try {
      const { error, count } = await supabase
        .from('backtest_results')
        .delete({ count: 'exact' })
        .in('id', ids);
      if (error) {
        logger.warn('Supabase delete error', { error: error.message, ids });
      } else {
        dbDeleted = count || ids.length;
      }
    } catch (e) {
      logger.warn('Supabase delete failed', { error: e.message });
    }

    // Delete from memory
    for (const id of ids) {
      if (backtestStore.delete(id)) memDeleted++;
    }

    const totalDeleted = Math.max(dbDeleted, memDeleted);
    logger.info('Backtests deleted', { dbDeleted, memDeleted, ids });

    if (totalDeleted === 0) {
      return res.status(404).json({ error: 'No backtests found to delete', ids });
    }
    res.json({ deleted: totalDeleted, ids });
  } catch (error) {
    logger.error('Backtest delete failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
};
app.delete('/api/backtest', handleBacktestDelete);
app.post('/api/backtest/delete', handleBacktestDelete);

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-PARAMETER TUNING ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/autotune/history — Get auto-tune run history
 */
app.get('/api/autotune/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const { history, error } = await getAutoTuneHistory(supabase, limit);
    if (error) return res.status(500).json({ error: error.message || 'Failed to fetch history' });
    res.json({ history });
  } catch (err) {
    logger.error('Auto-tune history fetch failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/autotune/config — Get active strategy config
 */
app.get('/api/autotune/config', async (req, res) => {
  try {
    const { config, source } = await getActiveConfig(supabase);
    const pending = getPendingProposals();
    res.json({
      config,
      source,
      priorityParams: PRIORITY_PARAMS,
      isRunning: isAutoTuneRunning(),
      approvalMode: getApprovalMode(),
      pendingCount: pending.length,
    });
  } catch (err) {
    logger.error('Active config fetch failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/autotune/run — Trigger a manual auto-tune run
 */
app.post('/api/autotune/run', async (req, res) => {
  try {
    if (isAutoTuneRunning()) {
      return res.status(409).json({ error: 'Auto-tune is already running' });
    }

    const asset = sanitizeInput(req.body.asset || 'bitcoin');

    // Start async (don't await — it takes minutes)
    res.json({ status: 'started', message: 'Auto-tune started, check /api/autotune/history for results' });

    // Run in background
    runAutoTune(supabase, { trigger: 'manual', asset }).catch(err => {
      logger.error('Manual auto-tune failed', { error: err.message });
    });
  } catch (err) {
    logger.error('Auto-tune trigger failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/autotune/reset — Reset to default strategy config
 */
app.post('/api/autotune/reset', async (req, res) => {
  try {
    // Deactivate all saved configs
    await supabase
      .from('saved_strategy_configs')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('is_active', true);

    res.json({ status: 'reset', message: 'Strategy config reset to defaults' });
  } catch (err) {
    logger.error('Config reset failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/autotune/pending — Get pending proposals awaiting approval
 */
app.get('/api/autotune/pending', (req, res) => {
  try {
    const pending = getPendingProposals();
    res.json({ pending, approvalMode: getApprovalMode() });
  } catch (err) {
    logger.error('Pending proposals fetch failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/autotune/approve — Approve or reject a pending proposal
 */
app.post('/api/autotune/approve', async (req, res) => {
  try {
    const { runId, decision } = req.body;
    if (!runId || !['apply', 'blend', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'Invalid request. Need runId and decision (apply|blend|reject).' });
    }

    const result = await approveProposal(supabase, runId, decision, 'api');
    if (!result.success) {
      return res.status(404).json({ error: result.message });
    }

    res.json(result);
  } catch (err) {
    logger.error('Approval failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/autotune/apply-param — Apply a single optimized parameter to the active strategy config
 */
app.post('/api/autotune/apply-param', async (req, res) => {
  try {
    const { paramName, value, source = 'optimizer' } = req.body;

    if (!paramName || value === undefined) {
      return res.status(400).json({ error: 'paramName and value are required' });
    }

    const range = PARAM_RANGES[paramName];
    if (!range) {
      return res.status(400).json({ error: `Unknown parameter: ${paramName}` });
    }
    if (value < range.min || value > range.max) {
      return res.status(400).json({ error: `Value ${value} out of range [${range.min}, ${range.max}]` });
    }

    const { config: currentConfig } = await getActiveConfig(supabase);
    const updatedConfig = { ...currentConfig, [paramName]: value };

    const saved = await saveActiveConfig(
      supabase, updatedConfig,
      `${source}-${paramName}-${value}`,
      `Applied ${range.label} = ${value} from ${source}`,
      null
    );

    if (!saved) {
      return res.status(500).json({ error: 'Failed to save config' });
    }

    logger.info('Strategy param applied', { paramName, value, source });
    res.json({ status: 'applied', paramName, value, label: range.label });
  } catch (err) {
    logger.error('Apply param failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// STRATEGY OPTIMIZATION ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/optimize/params — List available parameters for optimization
 */
app.get('/api/optimize/params', (req, res) => {
  const params = Object.entries(PARAM_RANGES).map(([key, range]) => ({
    key,
    label: range.label,
    description: range.description,
    min: range.min,
    max: range.max,
    step: range.step,
    defaultValue: DEFAULT_STRATEGY_CONFIG[key],
    testValues: Math.floor((range.max - range.min) / range.step) + 1
  }));
  res.json({ params, totalParams: params.length });
});

/**
 * POST /api/optimize/run — Start an optimization job (async)
 * Body: { asset, days, paramName, baseConfig?, capital? }
 */
app.post('/api/optimize/run', (req, res) => {
  try {
    // Reject if too many concurrent optimizations
    if (activeOptimizeJobs >= MAX_CONCURRENT_OPTIMIZATIONS) {
      return res.status(429).json({ error: `Too many concurrent optimizations (${activeOptimizeJobs}/${MAX_CONCURRENT_OPTIMIZATIONS}). Try again later.` });
    }
    activeOptimizeJobs++;

    const { asset, days, paramName, baseConfig, capital } = req.body;

    if (!paramName || !PARAM_RANGES[paramName]) {
      return res.status(400).json({
        error: `Invalid parameter: ${paramName}`,
        available: Object.keys(PARAM_RANGES)
      });
    }

    if (!asset) {
      return res.status(400).json({ error: 'asset is required' });
    }

    const validDays = Math.min(Math.max(days || 30, 7), 180);

    const jobId = startOptimizationJob({
      asset,
      days: validDays,
      paramName,
      baseConfig: baseConfig || {},
      capital: capital || 10000
    }, () => {
      activeOptimizeJobs = Math.max(0, activeOptimizeJobs - 1);
    });

    logger.info('Optimization job started', { jobId, asset, paramName, days: validDays });

    res.json({
      jobId,
      message: 'Optimization started',
      paramName,
      paramLabel: PARAM_RANGES[paramName].label,
      asset,
      days: validDays
    });
  } catch (error) {
    logger.error('Failed to start optimization', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/optimize/status/:jobId — Get optimization job progress
 */
app.get('/api/optimize/status/:jobId', (req, res) => {
  const job = getJobStatus(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
});

/**
 * GET /api/optimize/history — List all optimization jobs
 */
app.get('/api/optimize/history', (req, res) => {
  const jobs = getAllJobs();
  // Return summary (without full results to keep response small)
  const summary = jobs.map(j => ({
    jobId: j.jobId,
    status: j.status,
    paramName: j.paramName,
    asset: j.asset,
    days: j.days,
    message: j.message,
    startedAt: j.startedAt,
    bestValue: j.result?.bestValue ?? null,
    bestSharpe: j.result?.bestSharpe ?? null,
    improvement: j.result?.improvement ?? null,
    duration: j.result?.duration ?? null,
    // Walk-forward validation summary
    validationEnabled: j.result?.validation?.enabled ?? false,
    bestOosSharpe: j.result?.validation?.bestOosSharpe ?? null,
    overfitWarning: j.result?.validation?.overfitWarning ?? false
  }));
  res.json(summary);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM BOT SETUP
// ═══════════════════════════════════════════════════════════════════════════════

if (bot.isActive()) {
  // Custom command setup that persists subscribers to Supabase
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    bot.subscribe(chatId);
    await saveTelegramSubscriber(chatId);
    await bot.sendMessage(
      chatId,
      '🚀 *SENTIX Pro Bot Activado*\n\n' +
      '✅ Suscrito a alertas automáticas\n' +
      '📊 Recibirás señales de crypto, oro y plata\n\n' +
      'Comandos:\n' +
      '/señales - Señales activas\n' +
      '/precio [ASSET] - Precio actual\n' +
      '/mercado - Resumen del mercado\n' +
      '/stop - Detener alertas',
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/\/stop/, async (msg) => {
    const chatId = msg.chat.id;
    bot.unsubscribe(chatId);
    await removeTelegramSubscriber(chatId);
    await bot.sendMessage(chatId, '🔕 Alertas desactivadas.\nEnvía /start para reactivarlas.', { parse_mode: 'Markdown' });
  });

  bot.onText(/\/se[ñn]ales/, async (msg) => {
    const chatId = msg.chat.id;
    const signals = cachedSignals || [];

    if (!signals || signals.length === 0) {
      await bot.sendMessage(chatId, '📊 Generando señales... intenta de nuevo en 1 minuto.');
      return;
    }

    let message = '🎯 *Señales Activas*\n\n';
    // Show top 8 signals (including metals)
    signals.slice(0, 8).forEach(s => {
      const emoji = s.action === 'BUY' ? '🟢' : s.action === 'SELL' ? '🔴' : '⚪';
      message += `${emoji} *${s.asset}* - ${s.strengthLabel || s.action}\n`;
      message += `   Score: ${s.score} | Conf: ${s.confidence}%\n`;
      message += `   $${Number(s.price).toLocaleString()}\n\n`;
    });

    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/precio (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const asset = match[1].toLowerCase();
    const marketData = cachedMarketData;

    if (marketData?.crypto?.[asset]) {
      const data = marketData.crypto[asset];
      await bot.sendMessage(chatId,
        `💎 *${asset.toUpperCase()}*\nPrecio: $${data.price.toLocaleString()}\n24h: ${data.change24h >= 0 ? '+' : ''}${data.change24h.toFixed(2)}%`,
        { parse_mode: 'Markdown' }
      );
    } else if (asset.includes('gold') || asset.includes('oro')) {
      const gold = marketData?.metals?.gold;
      if (gold) {
        await bot.sendMessage(chatId, `🥇 *ORO (XAU)*\nPrecio: $${gold.price.toLocaleString()}\n24h: ${(gold.change24h || 0).toFixed(2)}%`, { parse_mode: 'Markdown' });
      }
    } else if (asset.includes('silver') || asset.includes('plata')) {
      const silver = marketData?.metals?.silver;
      if (silver) {
        await bot.sendMessage(chatId, `🥈 *PLATA (XAG)*\nPrecio: $${silver.price.toLocaleString()}\n24h: ${(silver.change24h || 0).toFixed(2)}%`, { parse_mode: 'Markdown' });
      }
    } else {
      await bot.sendMessage(chatId, '❌ Asset no encontrado. Usa: bitcoin, ethereum, solana, oro, plata, etc.');
    }
  });

  bot.onText(/\/mercado/, async (msg) => {
    const chatId = msg.chat.id;
    const marketData = cachedMarketData;

    if (marketData?.macro) {
      let message = `📊 *Resumen del Mercado*\n\n` +
        `Fear & Greed: ${marketData.macro.fearGreed}/100 (${marketData.macro.fearLabel})\n` +
        `BTC Dom: ${marketData.macro.btcDom}%\n` +
        `DXY: ${marketData.macro.dxy || '—'} (${marketData.macro.dxyTrend || 'N/A'})\n` +
        `Market Cap: $${(marketData.macro.globalMcap / 1e12).toFixed(2)}T\n`;

      if (marketData.metals?.gold) {
        message += `\n🥇 Oro: $${marketData.metals.gold.price.toLocaleString()}\n`;
        message += `🥈 Plata: $${marketData.metals.silver?.price?.toLocaleString() || 'N/A'}`;
      }

      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, '⏳ Datos cargando...');
    }
  });

  logger.info('Telegram commands registered (with persistence)');
}

// ═══════════════════════════════════════════════════════════════════════════════
// IPC MESSAGE HANDLING (receive data from worker processes)
// ═══════════════════════════════════════════════════════════════════════════════

if (process.send && process.env.WORKER_NAME) {
  process.on('message', (msg) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case MSG.MARKET_UPDATE:
        cachedMarketData = msg.data;
        broadcastSSE('market', cachedMarketData);
        break;
      case MSG.SIGNALS_UPDATE:
        cachedSignals = msg.data;
        broadcastSSE('signals', cachedSignals);
        break;
      case MSG.PAPER_TRADE:
        broadcastSSE('paper_trade', msg.data);
        // Broadcast Telegram notifications for paper trades
        if (msg.data && msg.data.trades) {
          for (const trade of msg.data.trades) {
            broadcastPaperTradeNotification(trade, msg.data.action).catch(() => {});
          }
        }
        break;
      case MSG.HEARTBEAT_PING:
        process.send({ type: MSG.HEARTBEAT_PONG, ts: Date.now() });
        break;
      case MSG.METRICS_UPDATE:
        if (msg.worker && msg.data) {
          workerMetrics[msg.worker] = msg.data;
        }
        break;
      case MSG.SHUTDOWN:
        gracefulShutdown('IPC_SHUTDOWN');
        break;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROCESS METRICS COLLECTION (every 30s)
// ═══════════════════════════════════════════════════════════════════════════════

const _metricsTimer = setInterval(() => {
  const mem = process.memoryUsage();
  metrics.gauge('process.memory.rss', mem.rss);
  metrics.gauge('process.memory.heapUsed', mem.heapUsed);
  metrics.gauge('process.memory.heapTotal', mem.heapTotal);
  metrics.gauge('process.memory.external', mem.external);
  metrics.gauge('process.uptime', Math.round(process.uptime()));
  metrics.gauge('sse.clients', sseClients.size);
}, 30000);
_metricsTimer.unref();

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

// Validate environment on startup
validateEnvironment();

// NOTE: Rate limiting is applied early (after express.json(), before routes)

// Export app for testing, only listen when run directly or as orchestrator worker
// Note: process.send is also truthy in Jest workers, so we check WORKER_NAME instead
if (require.main === module || process.env.WORKER_NAME) {
  httpServer = app.listen(PORT, async () => {
    logger.info('SENTIX PRO API Server started', {
      port: PORT,
      env: process.env.NODE_ENV || 'development',
      telegram: bot.isActive() ? 'active' : 'disabled',
      email: resend ? 'active' : 'disabled',
      mode: process.send ? 'worker' : 'standalone',
      features: ['sse', 'worker-threads-compute']
    });

    // Load persisted signals so /api/signals returns data before workers send updates
    try {
      const { data, error } = await supabase
        .from('signals')
        .select('*')
        .order('confidence', { ascending: false });
      if (!error && data && data.length > 0) {
        cachedSignals = data.map(s => ({
          asset: s.asset, action: s.action, strengthLabel: s.strength_label,
          score: s.score, rawScore: s.raw_score, confidence: s.confidence,
          price: s.price, change24h: s.change_24h, reasons: s.reasons,
          indicators: s.indicators, tradeLevels: s.trade_levels || null,
          derivatives: s.derivatives || null, timeframes: s.timeframes || null,
          macroContext: s.macro_context || null, dataSource: s.data_source,
          interval: s.interval_tf, assetClass: s.asset_class, timestamp: s.generated_at
        }));
        logger.info('Loaded persisted signals', { count: cachedSignals.length });
      }
    } catch (err) {
      logger.debug('Could not load persisted signals', { error: err.message });
    }

    // Start Telegram custom polling for bot commands
    if (bot.isActive() && bot.startCustomPolling) {
      bot.startCustomPolling();
    }

    logger.info('API server ready — market data and signals provided by worker processes');
  });
}

/**
 * Save a Telegram subscriber chat ID to Supabase
 */
async function saveTelegramSubscriber(chatId) {
  try {
    await supabase
      .from('telegram_subscribers')
      .upsert({ chat_id: chatId, subscribed_at: new Date().toISOString() }, { onConflict: 'chat_id' });
  } catch (error) {
    logger.debug('Could not persist Telegram subscriber', { error: error.message });
  }
}

/**
 * Remove a Telegram subscriber from Supabase
 */
async function removeTelegramSubscriber(chatId) {
  try {
    await supabase
      .from('telegram_subscribers')
      .delete()
      .eq('chat_id', chatId);
  } catch (error) {
    logger.debug('Could not remove Telegram subscriber', { error: error.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH & ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Get current user profile ─────────────────────────────────────────────────
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const profile = await getProfile(req.userId);
    if (!profile) {
      // Auto-admin: first user
      const { count } = await supabase
        .from('user_profiles')
        .select('id', { count: 'exact', head: true });

      if (count === 0) {
        const email = req.user?.email || 'admin@sentixpro.com';
        const { data: newProfile, error: insertErr } = await supabase
          .from('user_profiles')
          .insert({
            id: req.userId,
            email,
            role: 'admin',
            display_name: 'Admin',
            is_active: true
          })
          .select()
          .single();

        if (!insertErr && newProfile) {
          await logAudit(supabase, {
            userId: req.userId, email, action: 'auto_admin',
            resource: 'user_profiles', details: { reason: 'first_user' },
            ...auditContext(req)
          });
          return res.json({ profile: newProfile });
        }
      }

      return res.status(404).json({ error: 'Profile not found' });
    }

    // Update last_login_at
    await supabase.from('user_profiles')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', req.userId);

    res.json({ profile });
  } catch (err) {
    logger.error('GET /api/auth/me error', { error: err.message });
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// ─── Validate invitation token (public) ───────────────────────────────────────
app.post('/api/auth/accept-invite', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const { data: profile, error } = await supabase
      .from('user_profiles')
      .select('email, role, invitation_expires_at, is_active')
      .eq('invitation_token', token)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: 'Invalid invitation token' });
    }

    if (profile.is_active) {
      return res.status(400).json({ error: 'Invitation already claimed' });
    }

    if (new Date(profile.invitation_expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invitation expired' });
    }

    res.json({ email: profile.email, role: profile.role });
  } catch (err) {
    logger.error('POST /api/auth/accept-invite error', { error: err.message });
    res.status(500).json({ error: 'Failed to validate invitation' });
  }
});

// ─── Claim invitation after signup ────────────────────────────────────────────
app.post('/api/auth/claim-invite', requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const { data: profile, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('invitation_token', token)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: 'Invalid invitation token' });
    }

    if (profile.is_active) {
      return res.status(400).json({ error: 'Invitation already claimed' });
    }

    if (new Date(profile.invitation_expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invitation expired' });
    }

    // Link Supabase auth user to the profile
    const { data: updated, error: updateErr } = await supabase
      .from('user_profiles')
      .update({
        id: req.userId,
        is_active: true,
        invitation_token: null,
        invitation_expires_at: null,
        updated_at: new Date().toISOString()
      })
      .eq('invitation_token', token)
      .select()
      .single();

    if (updateErr) {
      return res.status(500).json({ error: 'Failed to claim invitation' });
    }

    await logAudit(supabase, {
      userId: req.userId, email: updated.email, action: 'invite_claimed',
      resource: 'user_profiles', details: { role: updated.role },
      ...auditContext(req)
    });

    invalidateProfileCache(req.userId);
    res.json({ profile: updated });
  } catch (err) {
    logger.error('POST /api/auth/claim-invite error', { error: err.message });
    res.status(500).json({ error: 'Failed to claim invitation' });
  }
});

// ─── Admin: List all users ────────────────────────────────────────────────────
app.get('/api/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ users: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// ─── Admin: Update user (role, active status) ────────────────────────────────
app.patch('/api/admin/users/:targetUserId', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { targetUserId } = req.params;
    const { role, is_active, display_name } = req.body;

    // Prevent admin from demoting themselves
    if (targetUserId === req.userId && role && role !== 'admin') {
      return res.status(400).json({ error: 'Cannot change your own admin role' });
    }

    const updates = { updated_at: new Date().toISOString() };
    if (role && ['admin', 'trader', 'viewer'].includes(role)) updates.role = role;
    if (typeof is_active === 'boolean') updates.is_active = is_active;
    if (display_name) updates.display_name = display_name;

    const { data, error } = await supabase
      .from('user_profiles')
      .update(updates)
      .eq('id', targetUserId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await logAudit(supabase, {
      userId: req.userId, email: req.userProfile?.email, action: 'role_change',
      resource: 'user_profiles',
      details: { targetUserId, changes: updates },
      ...auditContext(req)
    });

    invalidateProfileCache(targetUserId);
    res.json({ user: data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// ─── Admin: Send invitation ──────────────────────────────────────────────────
app.post('/api/admin/invite', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { email, role = 'trader', display_name } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    if (!['trader', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'Role must be trader or viewer' });
    }

    // Check if email already exists
    const { data: existing } = await supabase
      .from('user_profiles')
      .select('id, is_active')
      .eq('email', email)
      .single();

    if (existing?.is_active) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }

    // Generate invitation token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(); // 72 hours

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const inviteLink = `${frontendUrl}/auth?invite=${token}`;

    if (existing && !existing.is_active) {
      // Re-invite existing inactive user
      await supabase.from('user_profiles')
        .update({
          role,
          invitation_token: token,
          invitation_expires_at: expiresAt,
          invited_by: req.userId,
          display_name: display_name || null,
          updated_at: new Date().toISOString()
        })
        .eq('email', email);
    } else {
      // Create new profile placeholder
      const { error: insertErr } = await supabase
        .from('user_profiles')
        .insert({
          id: crypto.randomUUID(), // placeholder UUID, will be replaced on claim
          email,
          role,
          display_name: display_name || null,
          invited_by: req.userId,
          invitation_token: token,
          invitation_expires_at: expiresAt,
          is_active: false
        });

      if (insertErr) {
        return res.status(500).json({ error: 'Failed to create invitation: ' + insertErr.message });
      }
    }

    // Send invitation email via Resend
    let emailSent = false;
    if (RESEND_API_KEY && RESEND_API_KEY !== 're_123456789') {
      try {
        const resend = new Resend(RESEND_API_KEY);
        await resend.emails.send({
          from: 'Sentix Pro <noreply@sentixpro.com>',
          to: email,
          subject: 'Invitación a Sentix Pro',
          html: `
            <div style="font-family: system-ui; max-width: 500px; margin: 0 auto; background: #0a0a0a; color: #fff; padding: 32px; border-radius: 12px;">
              <h2 style="color: #6366f1;">Sentix Pro</h2>
              <p>Has sido invitado a unirte a Sentix Pro como <strong>${role}</strong>.</p>
              <a href="${inviteLink}" style="display: inline-block; background: #6366f1; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; margin: 16px 0;">
                Aceptar Invitación
              </a>
              <p style="color: #888; font-size: 12px;">Este enlace expira en 72 horas.</p>
            </div>
          `
        });
        emailSent = true;
      } catch (emailErr) {
        logger.warn('Failed to send invitation email', { error: emailErr.message });
      }
    }

    await logAudit(supabase, {
      userId: req.userId, email: req.userProfile?.email, action: 'invite_sent',
      resource: 'user_profiles',
      details: { invitedEmail: email, role, emailSent },
      ...auditContext(req)
    });

    res.json({ success: true, inviteLink, emailSent });
  } catch (err) {
    logger.error('POST /api/admin/invite error', { error: err.message });
    res.status(500).json({ error: 'Failed to send invitation' });
  }
});

// ─── Admin: Query audit log ──────────────────────────────────────────────────
app.get('/api/admin/audit', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const { action, user_id, days = 7, limit = 100, offset = 0 } = req.query;

    let query = supabase
      .from('audit_log')
      .select('*')
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (action) query = query.eq('action', action);
    if (user_id) query = query.eq('user_id', user_id);

    const sinceDate = new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000).toISOString();
    query = query.gte('created_at', sinceDate);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    res.json({ logs: data, total: data.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to query audit log' });
  }
});

// ─── Admin middleware for admin routes ─────────────────────────────────────────
app.use('/api/admin', requireAuth, requireRole('admin'));

module.exports = app;

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  logger.info(`${signal} received, shutting down API server`);

  // 1. Terminate compute worker threads
  terminateComputeWorkers();

  // 2. Close SSE clients
  for (const client of sseClients) {
    try {
      client.res.write('data: {"type":"shutdown"}\n\n');
      client.res.end();
    } catch (_) {}
  }
  sseClients.clear();

  // 3. Stop Telegram bot
  bot.stop();

  // 4. Close HTTP server (stop accepting new connections, drain in-flight)
  if (httpServer) {
    httpServer.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => {
      logger.warn('Forced shutdown after timeout');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── UNHANDLED ERROR HANDLERS ────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: reason?.message || String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — shutting down', { error: err.message, stack: err.stack });
  process.exit(1);
});
