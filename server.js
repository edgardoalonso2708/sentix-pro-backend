// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - BACKEND SERVER V2.2
// Resilient Data Fetching + Signals + Alerts + Portfolio
// Phase 0: Hardened errors, structured logging, jitter backoff
// ═══════════════════════════════════════════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { SilentTelegramBot, setupTelegramCommands } = require('./telegramBot');
const { fetchMetalsPricesSafe } = require('./metalsAPI');
const { generateSignalWithRealData } = require('./technicalAnalysis');
const {
  upload,
  parsePortfolioCSV,
  savePortfolio,
  getPortfolio,
  calculatePortfolioMetrics
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

const app = express();
const PORT = process.env.PORT || 3001;

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── CONFIGURATION ─────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'edgardoalonso2708@gmail.com';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

// ─── CACHED DATA ───────────────────────────────────────────────────────────
let cachedMarketData = null;
let cachedSignals = [];
let lastSuccessfulCrypto = {}; // Preserve last known good crypto data

// ─── CRYPTO ASSETS TO TRACK ───────────────────────────────────────────────
const CRYPTO_ASSETS = {
  bitcoin: 'btc',
  ethereum: 'eth',
  'binancecoin': 'bnb',
  solana: 'sol',
  cardano: 'ada',
  ripple: 'xrp',
  polkadot: 'dot',
  dogecoin: 'doge',
  'avalanche-2': 'avax',
  chainlink: 'link'
};

// CoinCap ID mapping (fallback API)
const COINCAP_IDS = {
  bitcoin: 'bitcoin',
  ethereum: 'ethereum',
  binancecoin: 'binance-coin',
  solana: 'solana',
  cardano: 'cardano',
  ripple: 'xrp',
  polkadot: 'polkadot',
  dogecoin: 'dogecoin',
  'avalanche-2': 'avalanche',
  chainlink: 'chainlink'
};

// ═══════════════════════════════════════════════════════════════════════════════
// RESILIENT HTTP CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_TIMEOUT_MS = 15000;

const apiClient = axios.create({
  timeout: DEFAULT_TIMEOUT_MS,
  headers: {
    'User-Agent': 'SentixPro/2.2 (Trading Dashboard)',
    'Accept': 'application/json'
  }
});

/**
 * Retry wrapper with exponential backoff + jitter
 * Jitter prevents thundering herd when multiple instances retry simultaneously
 */
async function fetchWithRetry(fn, retries = 3, baseDelay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (rawError) {
      const providerError = classifyAxiosError(rawError, 'HTTP', rawError.config?.url);

      // Don't retry non-retryable errors
      if (attempt === retries || !providerError.retryable) {
        throw rawError;
      }

      // Exponential backoff with jitter: delay * (0.5 + random 0-0.5)
      const exponentialDelay = providerError.type === 'RATE_LIMIT'
        ? baseDelay * Math.pow(2, attempt)  // Longer backoff for rate limits
        : baseDelay * attempt;

      const jitter = exponentialDelay * (0.5 + Math.random() * 0.5);
      const delay = Math.round(jitter);

      logger.info(`Retry ${attempt}/${retries} in ${delay}ms`, {
        error: providerError.type,
        endpoint: providerError.endpoint
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATA FETCHING FUNCTIONS (with fallbacks)
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchCryptoPrices() {
  // Primary: CoinGecko
  try {
    const cryptoData = await fetchWithRetry(async () => {
      const ids = Object.keys(CRYPTO_ASSETS).join(',');
      const response = await apiClient.get(
        'https://api.coingecko.com/api/v3/simple/price',
        {
          params: {
            ids,
            vs_currencies: 'usd',
            include_24hr_change: true,
            include_24hr_vol: true,
            include_market_cap: true
          },
          timeout: 15000
        }
      );

      const result = {};
      Object.entries(response.data).forEach(([id, data]) => {
        const symbol = CRYPTO_ASSETS[id];
        if (symbol) {
          result[id] = {
            symbol: symbol.toUpperCase(),
            price: data.usd,
            change24h: data.usd_24h_change || 0,
            volume24h: data.usd_24h_vol || 0,
            marketCap: data.usd_market_cap || 0
          };
        }
      });
      return result;
    }, 2, 3000);

    if (Object.keys(cryptoData).length > 0) {
      lastSuccessfulCrypto = cryptoData;
      logger.info('CoinGecko fetch OK', { assets: Object.keys(cryptoData).length });
      return cryptoData;
    }
  } catch (error) {
    logger.providerError(classifyAxiosError(error, Provider.COINGECKO, 'simple/price'));
  }

  // Fallback: CoinCap API (no API key needed, generous limits)
  try {
    logger.info('Falling back to CoinCap API');
    const cryptoData = await fetchFromCoinCap();
    if (Object.keys(cryptoData).length > 0) {
      lastSuccessfulCrypto = cryptoData;
      logger.info('CoinCap fallback OK', { assets: Object.keys(cryptoData).length });
      return cryptoData;
    }
  } catch (error) {
    logger.providerError(classifyAxiosError(error, Provider.COINCAP, 'assets'));
  }

  // Last resort: return cached data if available
  if (Object.keys(lastSuccessfulCrypto).length > 0) {
    logger.warn('Using cached crypto data', { assets: Object.keys(lastSuccessfulCrypto).length });
    return lastSuccessfulCrypto;
  }

  return {};
}

async function fetchFromCoinCap() {
  const ids = Object.values(COINCAP_IDS).join(',');
  const response = await apiClient.get(
    `https://api.coincap.io/v2/assets`,
    {
      params: { ids, limit: 15 },
      timeout: 10000
    }
  );

  const result = {};
  for (const asset of response.data.data || []) {
    // Find the CoinGecko key for this CoinCap asset
    const cgKey = Object.entries(COINCAP_IDS).find(([, v]) => v === asset.id)?.[0];
    if (cgKey && CRYPTO_ASSETS[cgKey]) {
      result[cgKey] = {
        symbol: CRYPTO_ASSETS[cgKey].toUpperCase(),
        price: parseFloat(asset.priceUsd) || 0,
        change24h: parseFloat(asset.changePercent24Hr) || 0,
        volume24h: parseFloat(asset.volumeUsd24Hr) || 0,
        marketCap: parseFloat(asset.marketCapUsd) || 0
      };
    }
  }
  return result;
}

async function fetchFearGreed() {
  try {
    const response = await apiClient.get('https://api.alternative.me/fng/', {
      timeout: 8000
    });
    const value = parseInt(response.data.data[0].value);

    let label = 'Neutral';
    if (value < 25) label = 'Extreme Fear';
    else if (value < 45) label = 'Fear';
    else if (value < 55) label = 'Neutral';
    else if (value < 75) label = 'Greed';
    else label = 'Extreme Greed';

    return { fearGreed: value, fearLabel: label };
  } catch (error) {
    logger.providerError(classifyAxiosError(error, Provider.ALTERNATIVE_ME, 'fng'));
    return { fearGreed: 50, fearLabel: 'Neutral' };
  }
}

async function fetchGlobalData() {
  try {
    const response = await fetchWithRetry(async () => {
      return await apiClient.get(
        'https://api.coingecko.com/api/v3/global',
        { timeout: 10000 }
      );
    }, 2, 2000);

    return {
      btcDom: response.data.data.market_cap_percentage.btc.toFixed(1),
      globalMcap: response.data.data.total_market_cap.usd
    };
  } catch (error) {
    logger.providerError(classifyAxiosError(error, Provider.COINGECKO, 'global'));
    // Fallback: try CoinCap for BTC dominance
    try {
      const response = await apiClient.get('https://api.coincap.io/v2/assets/bitcoin', { timeout: 5000 });
      const btcMcap = parseFloat(response.data.data.marketCapUsd) || 0;
      return {
        btcDom: btcMcap > 0 ? '~55' : '0',
        globalMcap: 0
      };
    } catch {
      return { btcDom: 0, globalMcap: 0 };
    }
  }
}

async function fetchMetalsPrices() {
  return await fetchMetalsPricesSafe();
}

async function updateMarketData() {
  try {
    logger.info('Updating market data');

    // Stagger CoinGecko calls to avoid rate limiting
    // Fetch crypto first (may need retries)
    const crypto = await fetchCryptoPrices();

    // Then fetch the rest in parallel (different APIs)
    const [fearGreedData, globalData, metals] = await Promise.all([
      fetchFearGreed(),
      fetchGlobalData(),
      fetchMetalsPrices()
    ]);

    const cryptoCount = Object.keys(crypto).length;

    // Only update if we got meaningful data, or merge with existing
    if (cryptoCount > 0 || !cachedMarketData) {
      cachedMarketData = {
        crypto: cryptoCount > 0 ? crypto : (cachedMarketData?.crypto || {}),
        macro: { ...fearGreedData, ...globalData },
        metals,
        lastUpdate: new Date().toISOString()
      };
      logger.info('Market data updated', { cryptoAssets: cryptoCount });
    } else {
      // Update only non-crypto data, keep existing crypto
      cachedMarketData = {
        ...cachedMarketData,
        macro: { ...fearGreedData, ...globalData },
        metals,
        lastUpdate: new Date().toISOString()
      };
      logger.warn('Market data partially updated (crypto unchanged, using cache)');
    }
  } catch (error) {
    logger.error('Market data update failed', { error: error.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

async function generateSignals() {
  const signals = [];

  if (!cachedMarketData || !cachedMarketData.crypto || Object.keys(cachedMarketData.crypto).length === 0) {
    logger.warn('No crypto data available for signal generation');
    return signals;
  }

  const fearGreed = cachedMarketData.macro?.fearGreed || 50;
  const assets = Object.entries(cachedMarketData.crypto);
  logger.info('Generating signals', { assets: assets.length, fearGreed });

  for (const [assetId, data] of assets) {
    try {
      if (!data.price || data.price <= 0) {
        logger.warn('Skipping asset: invalid price', { asset: assetId, price: data.price });
        continue;
      }

      const signal = await generateSignalWithRealData(
        assetId,
        data.price,
        data.change24h,
        data.volume24h,
        fearGreed
      );

      // Include BUY/SELL with confidence >= 55, HOLD with confidence >= 70
      if (signal.confidence >= 55 && (signal.action === 'BUY' || signal.action === 'SELL')) {
        signals.push(signal);
      } else if (signal.confidence >= 70 && signal.action === 'HOLD') {
        signals.push(signal);
      }

      // Delay between API calls - 2s to be safe with CoinGecko free tier
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      logger.error('Signal generation failed', { asset: assetId, error: error.message });
    }
  }

  cachedSignals = signals.sort((a, b) => b.confidence - a.confidence);
  logger.info('Signals generated', { actionable: cachedSignals.length, total: assets.length });
  return cachedSignals;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL ALERT SYSTEM (Resend)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send an email alert via Resend
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} htmlBody - HTML email body
 * @returns {Object} { success, id?, error? }
 */
async function sendEmailAlert(to, subject, htmlBody) {
  if (!resend) {
    return { success: false, error: 'Email not configured (RESEND_API_KEY missing)' };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: 'SENTIX PRO <onboarding@resend.dev>',
      to: [to],
      subject,
      html: htmlBody
    });

    if (error) {
      logger.error('Email send error', { provider: Provider.RESEND, error: error.message });
      return { success: false, error: error.message || 'Email send failed' };
    }

    logger.info('Email sent', { to, id: data?.id });
    return { success: true, id: data?.id };
  } catch (error) {
    logger.error('Email exception', { provider: Provider.RESEND, error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * Build HTML email for a trading signal alert
 */
function buildSignalEmailHTML(signal) {
  const actionColor = signal.action === 'BUY' ? '#22c55e' : signal.action === 'SELL' ? '#ef4444' : '#6b7280';
  const actionEmoji = signal.action === 'BUY' ? '🟢' : signal.action === 'SELL' ? '🔴' : '⚪';
  const priceFormatted = Number(signal.price).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const timeFormatted = new Date().toLocaleString('es-ES', { timeZone: 'America/Mexico_City' });

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; border-radius: 12px; overflow: hidden;">
      <div style="background: linear-gradient(135deg, #1e293b, #334155); padding: 24px; text-align: center;">
        <h1 style="margin: 0; font-size: 24px; color: #f8fafc;">📊 SENTIX PRO</h1>
        <p style="margin: 4px 0 0; color: #94a3b8; font-size: 14px;">Alerta de Trading</p>
      </div>
      <div style="padding: 24px;">
        <div style="background: #1e293b; border-radius: 8px; padding: 20px; margin-bottom: 16px; border-left: 4px solid ${actionColor};">
          <h2 style="margin: 0 0 8px; font-size: 28px; color: ${actionColor};">
            ${actionEmoji} ${signal.action}
          </h2>
          <p style="margin: 0; font-size: 20px; color: #f8fafc; font-weight: bold;">${signal.asset}</p>
          <p style="margin: 8px 0 0; font-size: 18px; color: #94a3b8;">${priceFormatted}</p>
        </div>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; border-bottom: 1px solid #334155;">Score</td>
            <td style="padding: 8px 0; text-align: right; color: #f8fafc; font-weight: bold; border-bottom: 1px solid #334155;">${signal.score}/100</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; border-bottom: 1px solid #334155;">Confianza</td>
            <td style="padding: 8px 0; text-align: right; color: #f8fafc; font-weight: bold; border-bottom: 1px solid #334155;">${signal.confidence}%</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #94a3b8;">Cambio 24h</td>
            <td style="padding: 8px 0; text-align: right; color: ${signal.change24h >= 0 ? '#22c55e' : '#ef4444'}; font-weight: bold;">
              ${signal.change24h >= 0 ? '+' : ''}${Number(signal.change24h).toFixed(2)}%
            </td>
          </tr>
        </table>
        <div style="background: #1e293b; border-radius: 8px; padding: 16px;">
          <p style="margin: 0 0 8px; color: #94a3b8; font-size: 12px; text-transform: uppercase;">Análisis</p>
          <p style="margin: 0; color: #e2e8f0; font-size: 14px; line-height: 1.5;">${signal.reasons}</p>
        </div>
      </div>
      <div style="padding: 16px 24px; background: #1e293b; text-align: center; border-top: 1px solid #334155;">
        <p style="margin: 0; color: #64748b; font-size: 12px;">${timeFormatted} · SENTIX PRO v2.1</p>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALERT PROCESSING SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

// Track recently sent alerts to avoid duplicate delivery
const recentAlertKeys = new Set();

async function processAlerts() {
  try {
    logger.info('Processing alerts');

    const signals = await generateSignals();
    let savedCount = 0;
    let telegramCount = 0;
    let emailCount = 0;

    for (const signal of signals) {
      if (signal.confidence >= 70) {
        // Deduplicate: only alert once per asset+action per cycle
        const alertKey = `${signal.asset}-${signal.action}`;
        if (recentAlertKeys.has(alertKey)) continue;

        // Save to database
        const { error } = await supabase
          .from('alerts')
          .insert({
            asset: signal.asset,
            action: signal.action,
            score: signal.score,
            confidence: signal.confidence,
            reasons: signal.reasons,
            price: signal.price
          });

        if (error) {
          logger.error('Alert save failed', { provider: Provider.SUPABASE, error: error.message });
        } else {
          savedCount++;
        }

        // Send via Telegram to all subscribers
        if (bot.isActive() && (signal.action === 'BUY' || signal.action === 'SELL')) {
          const result = await bot.broadcastAlert(signal);
          if (result.sent > 0) {
            telegramCount += result.sent;
            logger.info('Telegram alert sent', {
              asset: signal.asset,
              action: signal.action,
              sent: result.sent,
              total: result.total
            });
          }
        }

        // Send via email for high-confidence BUY/SELL signals
        if (resend && (signal.action === 'BUY' || signal.action === 'SELL')) {
          const emailResult = await sendEmailAlert(
            ALERT_EMAIL,
            `${signal.action === 'BUY' ? '🟢' : '🔴'} SENTIX PRO: ${signal.action} ${signal.asset} (${signal.confidence}%)`,
            buildSignalEmailHTML(signal)
          );
          if (emailResult.success) emailCount++;
        }

        // Mark as recently sent (clear after 30 minutes)
        recentAlertKeys.add(alertKey);
        setTimeout(() => recentAlertKeys.delete(alertKey), 30 * 60 * 1000);
      }
    }

    logger.info('Alerts processed', {
      signals: signals.length,
      saved: savedCount,
      telegram: telegramCount,
      email: emailCount
    });
  } catch (error) {
    logger.error('Alert processing failed', { error: error.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({
    status: 'SENTIX PRO Backend Online',
    version: '2.1.0',
    lastUpdate: cachedMarketData?.lastUpdate || null,
    signalsCount: cachedSignals.length,
    services: {
      telegram: bot.isActive() ? `active (${bot.getSubscribers().length} subscribers)` : 'not configured',
      email: resend ? 'active' : 'not configured',
      database: SUPABASE_URL ? 'connected' : 'not configured'
    }
  });
});

app.get('/api/market', (req, res) => {
  if (!cachedMarketData) {
    return res.status(503).json({ error: 'Market data not yet available' });
  }
  res.json(cachedMarketData);
});

app.get('/api/signals', (req, res) => {
  res.json(cachedSignals);
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
// PORTFOLIO ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/portfolio/template', (req, res) => {
  const csvContent = `Asset,Amount,Buy Price,Purchase Date,Notes
bitcoin,0.5,42000,2024-01-15,Initial purchase
ethereum,5.0,2500,2024-01-20,DCA entry
solana,100,85,2024-02-01,Swing trade
cardano,5000,0.45,2024-02-10,Long term hold`;
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=portfolio-template.csv');
  res.send(csvContent);
});

app.post('/api/portfolio/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const userId = sanitizeInput(req.body.userId || 'default-user');
    
    if (!isValidUserId(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }
    
    const positions = await parsePortfolioCSV(req.file.path);
    const result = await savePortfolio(supabase, userId, positions);
    
    res.json({
      success: true,
      message: `Successfully uploaded ${result.count} positions`,
      positions: positions.length
    });
    
  } catch (error) {
    logger.error('Portfolio upload failed', { error: error.message, type: error.type });

    if (error.type === 'validation') {
      return res.status(400).json({
        error: 'Validation failed',
        details: error.errors
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
    
    const positions = await getPortfolio(supabase, userId);
    const metrics = calculatePortfolioMetrics(positions, cachedMarketData);
    
    res.json({
      userId,
      positions: metrics.positions,
      summary: {
        totalValue: metrics.totalValue,
        totalInvested: metrics.totalInvested,
        totalPnL: metrics.totalPnL,
        totalPnLPercent: metrics.totalPnLPercent
      }
    });
    
  } catch (error) {
    logger.error('Portfolio fetch failed', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch portfolio' });
  }
});

app.delete('/api/portfolio/:userId/:positionId', async (req, res) => {
  try {
    const userId = sanitizeInput(req.params.userId);
    const positionId = parseInt(req.params.positionId);
    
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
// TELEGRAM BOT SETUP
// ═══════════════════════════════════════════════════════════════════════════════

if (bot.isActive()) {
  setupTelegramCommands(bot, () => cachedMarketData, () => cachedSignals);
  logger.info('Telegram commands registered');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRON JOBS
// ═══════════════════════════════════════════════════════════════════════════════

cron.schedule('*/1 * * * *', async () => {
  await updateMarketData();
});

cron.schedule('*/5 * * * *', async () => {
  await processAlerts();
});

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

// Validate environment on startup
validateEnvironment();

// Apply rate limiting to API routes
app.use('/api/', createRateLimiter(60000, 100));

// Export app for testing, only listen when run directly
if (require.main === module) {
  app.listen(PORT, async () => {
    logger.info('SENTIX PRO Backend v2.2 started', {
      port: PORT,
      env: process.env.NODE_ENV || 'development',
      telegram: bot.isActive() ? 'active' : 'disabled',
      email: resend ? 'active' : 'disabled'
    });

    await updateMarketData();
    await generateSignals();

    logger.info('Initial market data loaded');
  });
}

module.exports = app;

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  bot.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  bot.stop();
  process.exit(0);
});
