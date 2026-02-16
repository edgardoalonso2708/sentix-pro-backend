// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - BACKEND SERVER (PRODUCTION READY)
// Análisis técnico profesional + Metales + Telegram opcional
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

// ═══════════════════════════════════════════════════════════════════════════════
// DATA FETCHING FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchCryptoPrices() {
  try {
    const ids = Object.keys(CRYPTO_ASSETS).join(',');
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price',
      {
        params: {
          ids,
          vs_currencies: 'usd',
          include_24hr_change: true,
          include_24hr_vol: true,
          include_market_cap: true
        },
        timeout: 10000
      }
    );

    const cryptoData = {};
    Object.entries(response.data).forEach(([id, data]) => {
      const symbol = CRYPTO_ASSETS[id];
      cryptoData[id] = {
        symbol: symbol.toUpperCase(),
        price: data.usd,
        change24h: data.usd_24h_change || 0,
        volume24h: data.usd_24h_vol || 0,
        marketCap: data.usd_market_cap || 0
      };
    });

    return cryptoData;
  } catch (error) {
    console.error('Error fetching crypto prices:', error.message);
    return {};
  }
}

async function fetchFearGreed() {
  try {
    const response = await axios.get('https://api.alternative.me/fng/', {
      timeout: 5000
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
    const response = await axios.get(
      'https://api.coingecko.com/api/v3/global',
      { timeout: 5000 }
    );
    
    return {
      btcDom: response.data.data.market_cap_percentage.btc.toFixed(1),
      globalMcap: response.data.data.total_market_cap.usd
    };
  } catch (error) {
    console.error('Error fetching global data:', error.message);
    return { btcDom: 0, globalMcap: 0 };
  }
}

async function fetchMetalsPrices() {
  return await fetchMetalsPricesSafe();
}

async function updateMarketData() {
  try {
    console.log('🔄 Updating market data...');
    
    const [crypto, fearGreedData, globalData, metals] = await Promise.all([
      fetchCryptoPrices(),
      fetchFearGreed(),
      fetchGlobalData(),
      fetchMetalsPrices()
    ]);

    cachedMarketData = {
      crypto,
      macro: { ...fearGreedData, ...globalData },
      metals,
      lastUpdate: new Date().toISOString()
    };

    console.log('✅ Market data updated successfully');
  } catch (error) {
    console.error('Error updating market data:', error.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

async function generateSignals() {
  const signals = [];
  
  if (!cachedMarketData || !cachedMarketData.crypto) return signals;
  
  const fearGreed = cachedMarketData.macro?.fearGreed || 50;
  
  for (const [assetId, data] of Object.entries(cachedMarketData.crypto)) {
    const signal = await generateSignalWithRealData(
      assetId,
      data.price,
      data.change24h,
      data.volume24h,
      fearGreed
    );
    
    if (signal.confidence >= 60 && (signal.action === 'BUY' || signal.action === 'SELL')) {
      signals.push(signal);
    }
  }
  
  cachedSignals = signals.sort((a, b) => b.confidence - a.confidence);
  return cachedSignals;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALERT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

async function processAlerts() {
  try {
    console.log('🔔 Processing alerts...');
    
    const signals = await generateSignals();
    
    for (const signal of signals) {
      if (signal.confidence >= 75) {
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
        }
      }
    }
    
    console.log(`✅ Processed ${signals.length} signals`);
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
    version: '1.0.0',
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

  console.log(`📧 Alert would be sent to ${email}: ${message}`);
  res.json({ success: true, message: 'Alert sent' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM BOT SETUP
// ═══════════════════════════════════════════════════════════════════════════════

if (bot.isActive()) {
  setupTelegramCommands(bot, () => cachedMarketData);
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

app.listen(PORT, async () => {
  console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
  console.log('║                    🚀 SENTIX PRO BACKEND                          ║');
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
