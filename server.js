// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - BACKEND SERVER V2.1
// Resilient Data Fetching + Signals + Alerts + Portfolio
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

const app = express();
const PORT = process.env.PORT || 3001;

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── CONFIGURATION ─────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

const apiClient = axios.create({
  headers: {
    'User-Agent': 'SentixPro/2.1 (Trading Dashboard)',
    'Accept': 'application/json'
  }
});

/**
 * Retry wrapper with exponential backoff
 */
async function fetchWithRetry(fn, retries = 3, baseDelay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isRateLimit = error.response?.status === 429;
      const isServerError = error.response?.status >= 500;

      if (attempt === retries || (!isRateLimit && !isServerError && error.response)) {
        throw error;
      }

      const delay = isRateLimit
        ? baseDelay * Math.pow(2, attempt) // Longer backoff for rate limits
        : baseDelay * attempt;

      console.log(`⏳ Retry ${attempt}/${retries} in ${delay}ms (${error.message})`);
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
      console.log(`✅ CoinGecko: ${Object.keys(cryptoData).length} assets fetched`);
      return cryptoData;
    }
  } catch (error) {
    console.warn(`⚠️ CoinGecko failed: ${error.message}`);
  }

  // Fallback: CoinCap API (no API key needed, generous limits)
  try {
    console.log('🔄 Falling back to CoinCap API...');
    const cryptoData = await fetchFromCoinCap();
    if (Object.keys(cryptoData).length > 0) {
      lastSuccessfulCrypto = cryptoData;
      console.log(`✅ CoinCap fallback: ${Object.keys(cryptoData).length} assets fetched`);
      return cryptoData;
    }
  } catch (error) {
    console.warn(`⚠️ CoinCap fallback also failed: ${error.message}`);
  }

  // Last resort: return cached data if available
  if (Object.keys(lastSuccessfulCrypto).length > 0) {
    console.log(`⚠️ Using cached crypto data (${Object.keys(lastSuccessfulCrypto).length} assets)`);
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
    console.error('Error fetching Fear & Greed:', error.message);
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
    console.error('Error fetching global data:', error.message);
    // Fallback: try CoinCap for BTC dominance
    try {
      const response = await apiClient.get('https://api.coincap.io/v2/assets/bitcoin', { timeout: 5000 });
      const btcMcap = parseFloat(response.data.data.marketCapUsd) || 0;
      // Rough estimate of total market
      const totalResponse = await apiClient.get('https://api.coincap.io/v2/assets?limit=1', { timeout: 5000 });
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
    console.log('🔄 Updating market data...');

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
      console.log(`✅ Market data updated: ${cryptoCount} crypto assets, metals OK`);
    } else {
      // Update only non-crypto data, keep existing crypto
      cachedMarketData = {
        ...cachedMarketData,
        macro: { ...fearGreedData, ...globalData },
        metals,
        lastUpdate: new Date().toISOString()
      };
      console.log(`⚠️ Market data partially updated (crypto unchanged, using cache)`);
    }
  } catch (error) {
    console.error('Error updating market data:', error.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

async function generateSignals() {
  const signals = [];

  if (!cachedMarketData || !cachedMarketData.crypto || Object.keys(cachedMarketData.crypto).length === 0) {
    console.log('⚠️ No crypto data available for signal generation');
    return signals;
  }

  const fearGreed = cachedMarketData.macro?.fearGreed || 50;
  const assets = Object.entries(cachedMarketData.crypto);
  console.log(`📊 Generating signals for ${assets.length} assets (Fear & Greed: ${fearGreed})...`);

  for (const [assetId, data] of assets) {
    try {
      if (!data.price || data.price <= 0) {
        console.warn(`⚠️ Skipping ${assetId}: invalid price (${data.price})`);
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
      console.error(`Signal generation failed for ${assetId}:`, error.message);
    }
  }

  cachedSignals = signals.sort((a, b) => b.confidence - a.confidence);
  console.log(`📊 Generated ${cachedSignals.length} actionable signals from ${assets.length} assets`);
  return cachedSignals;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALERT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

// Track recently sent alerts to avoid duplicate delivery
const recentAlertKeys = new Set();

async function processAlerts() {
  try {
    console.log('🔔 Processing alerts...');

    const signals = await generateSignals();
    let savedCount = 0;
    let sentCount = 0;

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
          console.error('Error saving alert:', error.message);
        } else {
          savedCount++;
        }

        // Send via Telegram to all subscribers
        if (bot.isActive() && (signal.action === 'BUY' || signal.action === 'SELL')) {
          const result = await bot.broadcastAlert(signal);
          if (result.sent > 0) {
            sentCount += result.sent;
            console.log(`📱 Telegram alert sent for ${signal.asset} ${signal.action} to ${result.sent}/${result.total} subscribers`);
          }
        }

        // Mark as recently sent (clear after 30 minutes)
        recentAlertKeys.add(alertKey);
        setTimeout(() => recentAlertKeys.delete(alertKey), 30 * 60 * 1000);
      }
    }

    console.log(`✅ Processed ${signals.length} signals, saved ${savedCount} alerts, sent ${sentCount} Telegram notifications`);
  } catch (error) {
    console.error('Error processing alerts:', error.message);
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
    signalsCount: cachedSignals.length
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
    console.error('Error fetching alerts:', error.message);
    res.json([]);
  }
});

app.post('/api/send-alert', async (req, res) => {
  const { email, message } = req.body;

  if (!email || !message) {
    return res.status(400).json({ error: 'Email and message required' });
  }

  const results = { email: false, telegram: false };

  // Send test alert via Telegram to all subscribers
  if (bot.isActive()) {
    const subscribers = bot.getSubscribers();
    for (const chatId of subscribers) {
      const result = await bot.sendMessage(
        chatId,
        `🧪 *Test Alert*\n\n${message}\n\n📧 Configurado para: ${email}`,
        { parse_mode: 'Markdown' }
      );
      if (result.success) results.telegram = true;
    }
  }

  // Log for monitoring
  console.log(`📧 Test alert requested by ${email}: Telegram=${results.telegram}`);

  res.json({
    success: true,
    message: 'Test alert processed',
    delivery: {
      telegram: results.telegram ? 'sent' : (bot.isActive() ? 'no subscribers - send /start to the bot first' : 'bot not configured'),
      email: 'not configured (use Telegram for alerts)'
    }
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
    console.error('Portfolio upload error:', error);
    
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
    console.error('Portfolio fetch error:', error);
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
    console.error('Portfolio delete error:', error);
    res.status(500).json({ error: 'Failed to delete position' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM BOT SETUP
// ═══════════════════════════════════════════════════════════════════════════════

if (bot.isActive()) {
  setupTelegramCommands(bot, () => cachedMarketData, () => cachedSignals);
  console.log('✅ Telegram commands registered');
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
    console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
    console.log('║                    🚀 SENTIX PRO BACKEND V2.1                     ║');
    console.log('║                      Server Started                               ║');
    console.log('╠═══════════════════════════════════════════════════════════════════╣');
    console.log(`║  Port: ${PORT}                                                     ║`);
    console.log(`║  Environment: ${process.env.NODE_ENV || 'development'}                                            ║`);
    console.log(`║  Telegram Bot: ${bot.isActive() ? 'Active ✅' : 'Disabled ⚠️ '}                                 ║`);
    console.log('╚═══════════════════════════════════════════════════════════════════╝\n');

    await updateMarketData();
    await generateSignals();

    console.log('✅ Initial market data loaded');
  });
}

module.exports = app;

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  bot.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\nSIGINT received, shutting down gracefully...');
  bot.stop();
  process.exit(0);
});
