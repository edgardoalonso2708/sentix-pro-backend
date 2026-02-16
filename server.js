// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - BACKEND SERVER
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



// ─── MIDDLEWARE ────────────────────────────────────────────────────────────────
// app.use(cors());
app.use(cors({
  origin: 'https://sentix-pro-frontend.vercel.app', // Tu URL de Vercel
  credentials: true
}));
app.use(express.json());



// DEBUG: Ver si las variables se cargaron
console.log('🔍 DEBUG - Variables de entorno:');
console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
console.log('PORT:', process.env.PORT);
console.log('---');


// ═══════════════════════════════════════════════════════════════════════════════
// Sentix PRO - BACKEND SERVER
// Node.js + Express + Supabase + Real-time APIs + Telegram Bot
// ═══════════════════════════════════════════════════════════════════════════════




// ─── ENVIRONMENT VARIABLES ─────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'YOUR_SUPABASE_ANON_KEY';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN';
const RESEND_API_KEY = process.env.RESEND_API_KEY || 'YOUR_RESEND_API_KEY';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'YOUR_ANTHROPIC_API_KEY';


// ─── DATABASE INIT ─────────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── TELEGRAM BOT INIT ─────────────────────────────────────────────────────────
//const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const bot = new SilentTelegramBot(TELEGRAM_BOT_TOKEN);
let subscribedUsers = new Set(); // En producción, esto va a Supabase

// ─── MARKET DATA CACHE ─────────────────────────────────────────────────────────
let marketCache = {
  crypto: {},
  metals: {},
  macro: {},
  lastUpdate: null,
};

// ═══════════════════════════════════════════════════════════════════════════════
// DATA FETCHING FUNCTIONS - APIs GRATUITAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch crypto prices from CoinGecko (GRATIS - 50 calls/min)
 */
async function fetchCryptoPrices() {
  try {
    const coinIds = [
      'bitcoin', 'ethereum', 'solana', 'binancecoin', 'ripple',
      'cardano', 'avalanche-2', 'polkadot', 'chainlink', 'litecoin'
    ];

    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: coinIds.join(','),
        vs_currencies: 'usd',
        include_24hr_change: 'true',
        include_24hr_vol: 'true',
        include_market_cap: 'true',
      }
    });

    const data = response.data;
    const cryptoData = {};

    for (const [id, values] of Object.entries(data)) {
      cryptoData[id] = {
        price: values.usd,
        change24h: values.usd_24h_change || 0,
        volume24h: values.usd_24h_vol || 0,
        marketCap: values.usd_market_cap || 0,
        timestamp: Date.now(),
      };
    }

    return cryptoData;
  } catch (error) {
    console.error('Error fetching crypto prices:', error.message);
    return null;
  }
}

/**
 * Fetch detailed crypto data from CoinCap (GRATIS - Unlimited)
 */
async function fetchCryptoDetails() {
  try {
    const response = await axios.get('https://api.coincap.io/v2/assets', {
      params: { limit: 10 }
    });

    const details = {};
    response.data.data.forEach(asset => {
      const id = asset.id.toLowerCase();
      details[id] = {
        supply: parseFloat(asset.supply),
        maxSupply: parseFloat(asset.maxSupply) || null,
        volumeUsd24Hr: parseFloat(asset.volumeUsd24Hr),
        changePercent24Hr: parseFloat(asset.changePercent24Hr),
      };
    });

    return details;
  } catch (error) {
    console.error('Error fetching crypto details:', error.message);
    return null;
  }
}

/**
 * Fetch Gold & Silver prices from Alpha Vantage (GRATIS - 500 calls/day)
 */
//async function fetchMetalsPrices() {

async function fetchMetalsPrices() {
return await fetchMetalsPricesSafe();
}

/**
 * Fetch Fear & Greed Index (GRATIS)
 */
async function fetchFearGreedIndex() {
  try {
    const response = await axios.get('https://api.alternative.me/fng/');
    const data = response.data.data[0];
    
    return {
      value: parseInt(data.value),
      classification: data.value_classification,
      timestamp: Date.now(),
    };
  } catch (error) {
    console.error('Error fetching Fear & Greed:', error.message);
    return { value: 18, classification: 'Extreme Fear', timestamp: Date.now() };
  }
}

/**
 * Fetch BTC Dominance from CoinGecko
 */
async function fetchBtcDominance() {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/global');
    return {
      btcDom: response.data.data.market_cap_percentage.btc.toFixed(1),
      totalMarketCap: response.data.data.total_market_cap.usd,
    };
  } catch (error) {
    console.error('Error fetching BTC dominance:', error.message);
    return { btcDom: 56.2, totalMarketCap: 2.48e12 };
  }
}

/**
 * Update all market data
 */
async function updateMarketData() {
  console.log('🔄 Updating market data...');

  try {
    const [crypto, metals, fearGreed, btcDom] = await Promise.all([
      fetchCryptoPrices(),
      fetchMetalsPrices(),
      fetchFearGreedIndex(),
      fetchBtcDominance(),
    ]);

    marketCache = {
      crypto: crypto || marketCache.crypto,
      metals: metals || marketCache.metals,
      macro: {
        fearGreed: fearGreed.value,
        fearLabel: fearGreed.classification,
        btcDom: btcDom.btcDom,
        globalMcap: btcDom.totalMarketCap,
        lastUpdate: Date.now(),
      },
      lastUpdate: Date.now(),
    };

    console.log('✅ Market data updated successfully');
    return marketCache;
  } catch (error) {
    console.error('❌ Error updating market data:', error.message);
    return marketCache;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS - imported from lib/indicators.js
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL GENERATION ENGINE
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
    
    // Only include high-confidence signals
    if (signal.confidence >= 60 && (signal.action === 'BUY' || signal.action === 'SELL')) {
      signals.push(signal);
    }
  }
  
  return signals.sort((a, b) => b.confidence - a.confidence);
}


  for (const [coinId, data] of Object.entries(marketCache.crypto)) {
    const historicalPrices = generateMockHistory(data.price, 30);
    const signal = computeSignalFromData(coinId, data, marketCache.macro || {}, historicalPrices);

    if (signal.confidence >= 70) {
      signals.push(signal);
    }
  }

  return signals.sort((a, b) => b.confidence - a.confidence);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALERT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send Email via Resend (3000/month GRATIS)
 */
async function sendEmailAlert(to, subject, body) {
  try {
    await axios.post('https://api.resend.com/emails', {
      from: 'ORACLE Trading <alerts@oracle-trading.com>',
      to: [to],
      subject,
      html: `
        <div style="font-family: monospace; background: #0a0a0a; color: #f9fafb; padding: 20px; border-radius: 10px;">
          <h2 style="color: #a855f7;">🚨 ORACLE TRADING ALERT</h2>
          <div style="background: #1a1a1a; padding: 15px; border-radius: 8px; margin: 15px 0;">
            ${body}
          </div>
          <p style="color: #6b7280; font-size: 12px; margin-top: 20px;">
            This is an automated alert from ORACLE Trading System<br>
            ${new Date().toLocaleString()}
          </p>
        </div>
      `,
    }, {
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      }
    });
    
    console.log(`✅ Email sent to ${to}`);
  } catch (error) {
    console.error('❌ Error sending email:', error.message);
  }
}

/**
 * Send Telegram Alert (100% GRATIS, ilimitado)
 */

async function sendTelegramAlert(chatId, message) {
  return await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

/**
 * Process and send alerts
 */
async function processAlerts() {
  console.log('🔔 Processing alerts...');
  
  const signals = await generateSignals();
  const criticalSignals = filterCriticalSignals(signals);
  
  if (criticalSignals.length === 0) {
    console.log('No critical signals detected');
    return;
  }
  
  for (const signal of criticalSignals) {
    const alertMessage = `
🚨 <b>${signal.action} SIGNAL DETECTED</b>

Asset: <b>${signal.asset}</b>
Price: $${signal.price.toLocaleString()}
24h Change: ${signal.change24h >= 0 ? '+' : ''}${signal.change24h.toFixed(2)}%

Score: ${signal.score}/100
Confidence: ${signal.confidence}%

Reasons: ${signal.reasons}

${signal.action === 'BUY' ? '🟢 COMPRA RECOMENDADA' : '🔴 VENTA RECOMENDADA'}
    `.trim();
    
    // Send to Telegram
    await sendTelegramAlert(alertMessage);
    
    // Send to Email
    await sendEmailAlert(
      'edgardolonso2708@gmail.com',
      `🚨 ${signal.action} ALERT: ${signal.asset}`,
      alertMessage.replace(/\n/g, '<br>')
    );
    
    // Save to database
    await supabase.from('alerts').insert({
      asset: signal.asset,
      action: signal.action,
      score: signal.score,
      confidence: signal.confidence,
      price: signal.price,
      reasons: signal.reasons,
      created_at: new Date().toISOString(),
    });
  }
  
  console.log(`✅ Processed ${criticalSignals.length} critical alerts`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM BOT COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

// Setup Telegram commands if bot is active
if (bot.isActive()) {
  setupTelegramCommands(bot, () => cachedMarketData);
  console.log('✅ Telegram commands registered');
}

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({ 
    status: 'ORACLE Backend Online',
    version: '1.0.0',
    lastUpdate: marketCache.lastUpdate ? new Date(marketCache.lastUpdate).toISOString() : null,
  });
});

// Get current market data
app.get('/api/market', (req, res) => {
  res.json(marketCache);
});

// Get signals
app.get('/api/signals', async (req, res) => {
  try {
    const signals = await generateSignals();
    res.json(signals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get alert history
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
    res.status(500).json({ error: error.message });
  }
});

// Save portfolio
app.post('/api/portfolio', async (req, res) => {
  try {
    const { user_id, portfolio } = req.body;
    
    const { data, error } = await supabase
      .from('portfolios')
      .upsert({ user_id, portfolio, updated_at: new Date().toISOString() });
    
    if (error) throw error;
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get portfolio
app.get('/api/portfolio/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const { data, error } = await supabase
      .from('portfolios')
      .select('*')
      .eq('user_id', userId)
      .single();
    
    if (error) throw error;
    res.json(data || {});
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Manual alert trigger
app.post('/api/send-alert', async (req, res) => {
  try {
    const { email, message } = req.body;
    await sendEmailAlert(email, 'ORACLE Test Alert', message);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CRON JOBS - Automated Tasks
// ═══════════════════════════════════════════════════════════════════════════════

// Update market data every 1 minute
cron.schedule('*/1 * * * *', async () => {
  await updateMarketData();
});

// Check for alerts every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  await processAlerts();
});

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER START
// ═══════════════════════════════════════════════════════════════════════════════

// Only start the server when run directly (not when required by tests)
if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                    🚀 ORACLE PRO BACKEND                          ║
║                      Server Started                               ║
╠═══════════════════════════════════════════════════════════════════╣
║  Port: ${PORT}
║  Environment: ${process.env.NODE_ENV || 'development'}
║  Telegram Bot: ${TELEGRAM_BOT_TOKEN ? 'Active ✅' : 'Inactive ❌'}
║  Database: ${SUPABASE_URL ? 'Connected ✅' : 'Not configured ❌'}
╚═══════════════════════════════════════════════════════════════════╝
    `);

    // Initial data load
    await updateMarketData();
    console.log('✅ Initial market data loaded');
  });
}

module.exports = app;
