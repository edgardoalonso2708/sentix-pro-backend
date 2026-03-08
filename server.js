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
const { generateSignalWithRealData, generateMultiTimeframeSignal } = require('./technicalAnalysis');
const { fetchDerivativesData } = require('./binanceAPI');
const {
  upload,
  parsePortfolioCSV,
  // Wallet management
  createWallet,
  getWallets,
  updateWallet,
  deleteWallet,
  // Portfolio management
  savePortfolioToWallet,
  getWalletPortfolio,
  getAllPortfolios,
  getConsolidatedPortfolio,
  // P&L calculations
  calculateWalletPnL,
  calculatePnLByWallet,
  calculateConsolidatedPnL,
  // Constants
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
const { getFeatures, getFeaturesForAssets } = require('./featureStore');
const {
  getOrCreateConfig,
  updateConfig,
  resetPaperAccount,
  evaluateAndExecute,
  monitorAndManage,
  getPerformanceMetrics,
  getTradeHistory,
  getOpenPositions,
  executeFullClose,
  resolveCurrentPrice
} = require('./paperTrading');
const { runBacktest } = require('./backtester');

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

          ALTER TABLE IF EXISTS wallets DISABLE ROW LEVEL SECURITY;
          ALTER TABLE IF EXISTS portfolios DISABLE ROW LEVEL SECURITY;
        `
      });

      if (createError) {
        logger.warn('Auto-create tables via RPC failed (may need manual SQL execution)', { error: createError.message });
        // This is expected if exec_sql RPC doesn't exist - tables need manual creation
      } else {
        logger.info('Database tables created successfully');
      }
    } else {
      logger.info('Database tables verified OK');

      // Ensure RLS is disabled (in case migration enabled it)
      // This only works with service_role key
      await supabase.rpc('exec_sql', {
        sql: `
          ALTER TABLE IF EXISTS wallets DISABLE ROW LEVEL SECURITY;
          ALTER TABLE IF EXISTS portfolios DISABLE ROW LEVEL SECURITY;
        `
      }).catch(() => {
        // Silently ignore - RPC may not exist
      });
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

// ─── CACHED DATA ───────────────────────────────────────────────────────────
let cachedMarketData = null;
let cachedSignals = [];
let lastSuccessfulCrypto = {}; // Preserve last known good crypto data

// ─── SSE (Server-Sent Events) CLIENTS ──────────────────────────────────────
const sseClients = new Set();

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

// DXY (Dollar Index) proxy via EUR/USD exchange rate
// EUR is 57.6% of DXY basket, so inverse EUR/USD ≈ DXY direction
let cachedDxy = { dxy: 100, dxyTrend: 'neutral', dxyChange: 0 };
let lastDxyFetch = 0;
const DXY_CACHE_TTL = 15 * 60 * 1000; // 15 minutes (DXY moves slowly)

async function fetchDXY() {
  // Use cache if fresh
  if (Date.now() - lastDxyFetch < DXY_CACHE_TTL && cachedDxy.dxy !== 100) {
    return cachedDxy;
  }

  try {
    // Free forex API - EUR/USD rate (no key needed)
    const response = await apiClient.get(
      'https://open.er-api.com/v6/latest/USD',
      { timeout: 8000 }
    );

    if (response.data && response.data.rates && response.data.rates.EUR) {
      const eurUsd = 1 / response.data.rates.EUR; // EUR/USD rate
      // DXY proxy: EUR is 57.6% of DXY, approximate index
      // DXY ≈ 50.14348 * (1/EUR) ^ 0.576 * (1/JPY) ^ 0.136 * ...
      // Simplified: use EUR/USD inverse scaled to DXY range (~90-115)
      const dxy = (1 / eurUsd) * 120; // Approximate scaling

      // Determine trend from previous value
      let dxyTrend = 'stable';
      const dxyChange = cachedDxy.dxy > 0 && cachedDxy.dxy !== 100
        ? ((dxy - cachedDxy.dxy) / cachedDxy.dxy) * 100
        : 0;
      if (dxyChange > 0.1) dxyTrend = 'rising';
      else if (dxyChange < -0.1) dxyTrend = 'falling';

      cachedDxy = { dxy: parseFloat(dxy.toFixed(2)), dxyTrend, dxyChange: parseFloat(dxyChange.toFixed(3)) };
      lastDxyFetch = Date.now();
      logger.info('DXY fetched', { dxy: cachedDxy.dxy, trend: dxyTrend });
      return cachedDxy;
    }
  } catch (error) {
    logger.debug('DXY fetch failed, using cached/default', { error: error.message });
  }

  return cachedDxy;
}

async function updateMarketData() {
  try {
    logger.info('Updating market data');

    // Stagger CoinGecko calls to avoid rate limiting
    // Fetch crypto first (may need retries)
    const crypto = await fetchCryptoPrices();

    // Then fetch the rest in parallel (different APIs)
    const [fearGreedData, globalData, metals, dxyData] = await Promise.all([
      fetchFearGreed(),
      fetchGlobalData(),
      fetchMetalsPrices(),
      fetchDXY()
    ]);

    const cryptoCount = Object.keys(crypto).length;

    // Only update if we got meaningful data, or merge with existing
    if (cryptoCount > 0 || !cachedMarketData) {
      cachedMarketData = {
        crypto: cryptoCount > 0 ? crypto : (cachedMarketData?.crypto || {}),
        macro: { ...fearGreedData, ...globalData, ...dxyData },
        metals,
        lastUpdate: new Date().toISOString()
      };
      logger.info('Market data updated', { cryptoAssets: cryptoCount });

      // Broadcast to SSE clients (Phase 1)
      broadcastSSE('market', cachedMarketData);

      // ─── PAPER TRADING POSITION MONITORING ────────────────────────────
      try {
        const ptMonitor = await monitorAndManage(supabase, 'default-user', cachedMarketData);
        if (ptMonitor.closedTrades && ptMonitor.closedTrades.length > 0) {
          for (const closedTrade of ptMonitor.closedTrades) {
            await broadcastPaperTradeNotification(closedTrade, 'close');
          }
          broadcastSSE('paper_trade', { action: 'closed', trades: ptMonitor.closedTrades });
        }
        if (ptMonitor.partialCloses && ptMonitor.partialCloses.length > 0) {
          for (const partial of ptMonitor.partialCloses) {
            await broadcastPaperTradeNotification(partial, 'partial');
          }
          broadcastSSE('paper_trade', { action: 'partial', trades: ptMonitor.partialCloses });
        }
      } catch (ptError) {
        logger.debug('Paper trading monitor cycle', { error: ptError.message });
      }

    } else {
      // Update only non-crypto data, keep existing crypto
      cachedMarketData = {
        ...cachedMarketData,
        macro: { ...fearGreedData, ...globalData, ...dxyData },
        metals,
        lastUpdate: new Date().toISOString()
      };
      logger.warn('Market data partially updated (crypto unchanged, using cache)');

      // Still broadcast partial update
      broadcastSSE('market', cachedMarketData);
    }
  } catch (error) {
    logger.error('Market data update failed', { error: error.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

async function generateSignals() {
  const allSignals = [];

  if (!cachedMarketData || !cachedMarketData.crypto || Object.keys(cachedMarketData.crypto).length === 0) {
    logger.warn('No crypto data available for signal generation');
    return allSignals;
  }

  const fearGreed = cachedMarketData.macro?.fearGreed || 50;

  // Build macro context for signal engine (BTC dominance + DXY)
  const macroData = {
    btcDom: parseFloat(cachedMarketData.macro?.btcDom) || 0,
    btcChange24h: cachedMarketData.crypto?.bitcoin?.change24h || 0,
    dxy: cachedMarketData.macro?.dxy || 100,
    dxyTrend: cachedMarketData.macro?.dxyTrend || 'neutral',
    dxyChange: cachedMarketData.macro?.dxyChange || 0
  };

  // ─── CRYPTO SIGNALS ─────────────────────────────────────────────────
  const assets = Object.entries(cachedMarketData.crypto);
  logger.info('Generating signals', { assets: assets.length, fearGreed, btcDom: macroData.btcDom, dxy: macroData.dxy });

  for (const [assetId, data] of assets) {
    try {
      if (!data.price || data.price <= 0) {
        logger.warn('Skipping asset: invalid price', { asset: assetId, price: data.price });
        continue;
      }

      // Fetch derivatives data (funding rate, OI, L/S ratio)
      let derivativesData = null;
      try {
        derivativesData = await fetchDerivativesData(assetId);
      } catch (e) {
        logger.debug('Derivatives unavailable', { asset: assetId });
      }

      // Multi-timeframe analysis (4H + 1H + 15M confluence) + macro context
      const signal = await generateMultiTimeframeSignal(
        assetId,
        data.price,
        data.change24h,
        data.volume24h,
        fearGreed,
        derivativesData,
        macroData
      );

      signal.assetClass = 'crypto';
      allSignals.push(signal);

      // Delay between assets (OHLCV calls are parallel per asset, this is inter-asset)
      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (error) {
      logger.error('Signal generation failed', { asset: assetId, error: error.message });
    }
  }

  // ─── GOLD SIGNAL (via PAXG - single timeframe, no futures) ─────────────
  if (cachedMarketData.metals?.gold) {
    try {
      const gold = cachedMarketData.metals.gold;
      if (gold.price > 0) {
        const goldSignal = await generateSignalWithRealData(
          'pax-gold',
          gold.price,
          gold.change24h || 0,
          gold.volume24h || 0,
          fearGreed,
          '1h',
          null  // No derivatives for PAXG
        );
        goldSignal.asset = 'GOLD (XAU)';
        goldSignal.assetClass = 'metal';
        allSignals.push(goldSignal);

        await new Promise(resolve => setTimeout(resolve, 1500));

        // ─── SILVER SIGNAL (derived from gold) ─────────────────────
        if (cachedMarketData.metals?.silver) {
          const silver = cachedMarketData.metals.silver;
          if (silver.price > 0) {
            const silverSignal = { ...goldSignal };
            silverSignal.asset = 'SILVER (XAG)';
            silverSignal.price = silver.price;
            silverSignal.change24h = silver.change24h || (gold.change24h ? gold.change24h * 1.3 : 0);
            const amplifiedScore = Math.round(goldSignal.rawScore * 1.15);
            silverSignal.rawScore = Math.max(-100, Math.min(100, amplifiedScore));
            silverSignal.score = Math.round(Math.max(0, Math.min(100, (silverSignal.rawScore + 100) / 2)));
            silverSignal.confidence = Math.max(0, goldSignal.confidence - 5);
            silverSignal.reasons = goldSignal.reasons + ' \u2022 Derived from gold correlation (silver/gold ~0.85)';
            silverSignal.dataSource = 'Gold correlation (PAXG OHLCV)';
            silverSignal.assetClass = 'metal';
            silverSignal.derivatives = null;
            // Recalculate trade levels for silver price
            if (goldSignal.tradeLevels) {
              const ratio = silver.price / gold.price;
              silverSignal.tradeLevels = {
                ...goldSignal.tradeLevels,
                entry: parseFloat((goldSignal.tradeLevels.entry * ratio).toFixed(4)),
                stopLoss: parseFloat((goldSignal.tradeLevels.stopLoss * ratio).toFixed(4)),
                takeProfit1: parseFloat((goldSignal.tradeLevels.takeProfit1 * ratio).toFixed(4)),
                takeProfit2: parseFloat((goldSignal.tradeLevels.takeProfit2 * ratio).toFixed(4)),
                support: parseFloat((goldSignal.tradeLevels.support * ratio).toFixed(4)),
                resistance: parseFloat((goldSignal.tradeLevels.resistance * ratio).toFixed(4)),
                pivot: parseFloat((goldSignal.tradeLevels.pivot * ratio).toFixed(4)),
                atrValue: parseFloat((goldSignal.tradeLevels.atrValue * ratio).toFixed(4))
              };
            }

            if (silverSignal.rawScore >= 25) silverSignal.action = 'BUY';
            else if (silverSignal.rawScore >= 15 && silverSignal.confidence >= 35) silverSignal.action = 'BUY';
            else if (silverSignal.rawScore <= -25) silverSignal.action = 'SELL';
            else if (silverSignal.rawScore <= -15 && silverSignal.confidence >= 35) silverSignal.action = 'SELL';
            else silverSignal.action = 'HOLD';

            if (silverSignal.action === 'BUY') {
              silverSignal.strengthLabel = silverSignal.rawScore >= 50 && silverSignal.confidence >= 55 ? 'STRONG BUY' :
                silverSignal.rawScore >= 35 ? 'BUY' : 'WEAK BUY';
            } else if (silverSignal.action === 'SELL') {
              silverSignal.strengthLabel = silverSignal.rawScore <= -50 && silverSignal.confidence >= 55 ? 'STRONG SELL' :
                silverSignal.rawScore <= -35 ? 'SELL' : 'WEAK SELL';
            } else {
              silverSignal.strengthLabel = 'HOLD';
            }

            allSignals.push(silverSignal);
          }
        }
      }
    } catch (error) {
      logger.error('Gold/Silver signal generation failed', { error: error.message });
    }
  }

  // Sort by confidence (highest first), then by action priority (BUY/SELL before HOLD)
  cachedSignals = allSignals.sort((a, b) => {
    const actionPriority = { BUY: 2, SELL: 2, HOLD: 0 };
    const priorityDiff = (actionPriority[b.action] || 0) - (actionPriority[a.action] || 0);
    if (priorityDiff !== 0) return priorityDiff;
    return b.confidence - a.confidence;
  });

  const actionable = cachedSignals.filter(s => s.action !== 'HOLD').length;
  logger.info('Signals generated', { total: cachedSignals.length, actionable });

  // Persist signals to Supabase for durability across restarts
  await persistSignals(cachedSignals);

  // Broadcast to SSE clients
  if (cachedSignals.length > 0) {
    broadcastSSE('signals', cachedSignals);
  }

  return cachedSignals;
}

/**
 * Persist signals to Supabase so they survive server restarts
 */
async function persistSignals(signals) {
  try {
    // Upsert all signals (replace previous batch)
    const { error } = await supabase
      .from('signals')
      .upsert(
        signals.map(s => ({
          asset: s.asset,
          action: s.action,
          strength_label: s.strengthLabel || s.action,
          score: s.score,
          raw_score: s.rawScore || 0,
          confidence: s.confidence,
          price: s.price,
          change_24h: s.change24h || 0,
          reasons: s.reasons,
          indicators: s.indicators || {},
          trade_levels: s.tradeLevels || null,
          derivatives: s.derivatives || null,
          timeframes: s.timeframes || null,
          macro_context: s.macroContext || null,
          data_source: s.dataSource || 'unknown',
          interval_tf: s.interval || 'multi',
          asset_class: s.assetClass || 'crypto',
          generated_at: s.timestamp || new Date().toISOString()
        })),
        { onConflict: 'asset' }
      );

    if (error) {
      // Table may not exist yet - log but don't fail
      if (error.code === '42P01') {
        logger.debug('Signals table not yet created - signals stored in memory only');
      } else {
        logger.warn('Signal persistence failed', { error: error.message });
      }
    } else {
      logger.debug('Signals persisted to database', { count: signals.length });
    }
  } catch (error) {
    logger.debug('Signal persistence unavailable', { error: error.message });
  }
}

/**
 * Load persisted signals from Supabase (used on startup)
 */
async function loadPersistedSignals() {
  try {
    const { data, error } = await supabase
      .from('signals')
      .select('*')
      .order('confidence', { ascending: false });

    if (error) {
      logger.debug('Could not load persisted signals', { error: error.message });
      return [];
    }

    return (data || []).map(s => ({
      asset: s.asset,
      action: s.action,
      strengthLabel: s.strength_label,
      score: s.score,
      rawScore: s.raw_score,
      confidence: s.confidence,
      price: s.price,
      change24h: s.change_24h,
      reasons: s.reasons,
      indicators: s.indicators,
      tradeLevels: s.trade_levels || null,
      derivatives: s.derivatives || null,
      timeframes: s.timeframes || null,
      macroContext: s.macro_context || null,
      dataSource: s.data_source,
      interval: s.interval_tf,
      assetClass: s.asset_class,
      timestamp: s.generated_at
    }));
  } catch (error) {
    logger.debug('Signal load unavailable', { error: error.message });
    return [];
  }
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

    // Alert thresholds: BUY/SELL with confidence >= 55, or STRONG signals >= 45
    const ALERT_MIN_CONFIDENCE = 55;
    const STRONG_SIGNAL_CONFIDENCE = 45;

    for (const signal of signals) {
      const isActionable = signal.action === 'BUY' || signal.action === 'SELL';
      const isHighConfidence = signal.confidence >= ALERT_MIN_CONFIDENCE;
      const isStrongSignal = signal.confidence >= STRONG_SIGNAL_CONFIDENCE &&
        (signal.strengthLabel?.includes('STRONG') || Math.abs(signal.rawScore || 0) >= 40);

      if (isActionable && (isHighConfidence || isStrongSignal)) {
        // Deduplicate: only alert once per asset+action per cycle
        const alertKey = `${signal.asset}-${signal.action}`;
        if (recentAlertKeys.has(alertKey)) continue;

        // Save to database (alerts table)
        try {
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
            if (error.code === '42P01') {
              logger.debug('Alerts table not yet created - skipping DB save');
            } else {
              logger.warn('Alert save failed', { error: error.message });
            }
          } else {
            savedCount++;
          }
        } catch (dbError) {
          logger.warn('Alert DB save error', { error: dbError.message });
        }

        // Send via Telegram to all subscribers
        if (bot.isActive()) {
          const result = await bot.broadcastAlert(signal);
          if (result.sent > 0) {
            telegramCount += result.sent;
            logger.info('Telegram alert sent', {
              asset: signal.asset,
              action: signal.action,
              confidence: signal.confidence,
              sent: result.sent,
              total: result.total
            });
          }
        }

        // Send via email
        if (resend) {
          const emailResult = await sendEmailAlert(
            ALERT_EMAIL,
            `${signal.action === 'BUY' ? '🟢' : '🔴'} SENTIX PRO: ${signal.action} ${signal.asset} (${signal.confidence}%)`,
            buildSignalEmailHTML(signal)
          );
          if (emailResult.success) emailCount++;
        }

        // Mark as recently sent (clear after 20 minutes for faster re-alerting)
        recentAlertKeys.add(alertKey);
        setTimeout(() => recentAlertKeys.delete(alertKey), 20 * 60 * 1000);
      }
    }

    logger.info('Alerts processed', {
      totalSignals: signals.length,
      saved: savedCount,
      telegram: telegramCount,
      email: emailCount
    });

    // ─── PAPER TRADING EVALUATION ─────────────────────────────────────────
    try {
      const ptResult = await evaluateAndExecute(supabase, 'default-user', signals, cachedMarketData);
      if (ptResult.newTrades.length > 0) {
        logger.info('Paper trades opened', {
          count: ptResult.newTrades.length,
          assets: ptResult.newTrades.map(t => t.asset)
        });
        for (const trade of ptResult.newTrades) {
          await broadcastPaperTradeNotification(trade, 'open');
        }
        broadcastSSE('paper_trade', { action: 'opened', trades: ptResult.newTrades });
      }
    } catch (ptError) {
      logger.warn('Paper trading evaluation failed', { error: ptError.message });
    }

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
    version: '2.4.0-phase2',  // Phase 2: Multi-Wallet Portfolio + Phase 1
    lastUpdate: cachedMarketData?.lastUpdate || null,
    signalsCount: cachedSignals.length,
    services: {
      telegram: bot.isActive() ? `active (${bot.getSubscribers().length} subscribers)` : 'not configured',
      email: resend ? 'active' : 'not configured',
      database: SUPABASE_URL ? 'connected' : 'not configured',
      sse: `active (${sseClients.size} clients)`,  // Phase 1: SSE status
      binance: 'active (real OHLCV)',  // Phase 1: Binance data
      featureStore: 'active'  // Phase 1: Feature computation
    }
  });
});

app.get('/api/market', (req, res) => {
  if (!cachedMarketData) {
    return res.status(503).json({ error: 'Market data not yet available' });
  }
  res.json(cachedMarketData);
});

app.get('/api/signals', async (req, res) => {
  // Return in-memory signals if available
  if (cachedSignals.length > 0) {
    return res.json(cachedSignals);
  }

  // Fallback: load from database if in-memory is empty (e.g. after restart)
  const persisted = await loadPersistedSignals();
  if (persisted.length > 0) {
    cachedSignals = persisted;
    return res.json(persisted);
  }

  // No signals available yet
  res.json([]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// SSE (SERVER-SENT EVENTS) - Real-time Market Updates (Phase 1)
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/api/stream', (req, res) => {
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
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0
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

    res.json({ trade: closedTrade, pnl });
  } catch (error) {
    logger.error('Paper manual close failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BACKTEST API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Launch a backtest ───────────────────────────────────────────────────────
app.post('/api/backtest/run', async (req, res) => {
  try {
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
      userId = 'default-user'
    } = req.body;

    // Validate inputs
    if (days < 7 || days > 365) return res.status(400).json({ error: 'days must be between 7 and 365' });
    if (capital < 100) return res.status(400).json({ error: 'capital must be at least 100' });
    if (!['1h', '4h'].includes(stepInterval)) return res.status(400).json({ error: 'stepInterval must be 1h or 4h' });

    // Create backtest record with status='running'
    const { data: record, error: insertError } = await supabase
      .from('backtest_results')
      .insert({
        user_id: userId,
        asset,
        days,
        step_interval: stepInterval,
        initial_capital: capital,
        risk_per_trade: riskPerTrade,
        max_open_positions: maxOpenPositions,
        min_confluence: minConfluence,
        min_rr_ratio: minRR,
        allowed_strength: allowedStrength,
        status: 'running',
        progress: 0
      })
      .select()
      .single();

    if (insertError) {
      logger.error('Failed to create backtest record', { error: insertError.message });
      return res.status(500).json({ error: 'Failed to create backtest record' });
    }

    // Return immediately, run backtest in background
    res.json({ id: record.id, status: 'running' });

    // Execute backtest asynchronously
    (async () => {
      try {
        const result = await runBacktest({
          asset,
          days,
          interval: stepInterval,
          capital,
          riskPerTrade,
          maxOpenPositions,
          minConfluence,
          minRR,
          allowedStrength,
          cooldownBars,
          fearGreed: 50,
          derivativesData: null,
          macroData: null
        }, async (progress) => {
          // Update progress in DB
          await supabase
            .from('backtest_results')
            .update({ progress })
            .eq('id', record.id);
        });

        // Save completed results
        await supabase
          .from('backtest_results')
          .update({
            status: 'completed',
            progress: 100,
            total_trades: result.totalTrades,
            win_count: result.winCount,
            loss_count: result.lossCount,
            win_rate: result.winRate,
            total_pnl: result.totalPnl,
            total_pnl_percent: result.totalPnlPercent,
            max_drawdown: result.maxDrawdown,
            max_drawdown_percent: result.maxDrawdownPercent,
            profit_factor: result.profitFactor,
            sharpe_ratio: result.sharpeRatio,
            avg_holding_hours: result.avgHoldingHours,
            trades: result.trades,
            equity_curve: result.equityCurve,
            metrics: result,
            completed_at: new Date().toISOString()
          })
          .eq('id', record.id);

        logger.info(`Backtest completed: ${record.id}`, {
          asset, days, trades: result.totalTrades, pnl: result.totalPnl
        });

        // Broadcast via SSE
        broadcastSSE('backtest_complete', { id: record.id, asset, status: 'completed' });

      } catch (err) {
        logger.error(`Backtest failed: ${record.id}`, { error: err.message });
        await supabase
          .from('backtest_results')
          .update({
            status: 'failed',
            error_message: err.message,
            completed_at: new Date().toISOString()
          })
          .eq('id', record.id);
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
    const { data, error } = await supabase
      .from('backtest_results')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Backtest not found' });

    res.json(data);
  } catch (error) {
    logger.error('Backtest results fetch failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Get backtest history for user ───────────────────────────────────────────
app.get('/api/backtest/history/:userId', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('backtest_results')
      .select('id, asset, days, step_interval, initial_capital, status, progress, total_trades, win_rate, total_pnl, total_pnl_percent, max_drawdown_percent, profit_factor, sharpe_ratio, error_message, started_at, completed_at, created_at')
      .eq('user_id', req.params.userId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      logger.error('Backtest history fetch failed', { error: error.message });
      return res.status(500).json({ error: 'Failed to fetch history' });
    }

    res.json(data || []);
  } catch (error) {
    logger.error('Backtest history failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
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
    logger.info('SENTIX PRO Backend v3.0 started', {
      port: PORT,
      env: process.env.NODE_ENV || 'development',
      telegram: bot.isActive() ? 'active' : 'disabled',
      email: resend ? 'active' : 'disabled',
      features: ['binance-ohlcv', 'gold-silver-signals', 'signal-persistence', 'sse']
    });

    // Load persisted signals immediately (so /api/signals returns data right away)
    const persisted = await loadPersistedSignals();
    if (persisted.length > 0) {
      cachedSignals = persisted;
      logger.info('Loaded persisted signals', { count: persisted.length });
    }

    // Load Telegram subscribers from database
    await loadTelegramSubscribers();

    // Fetch fresh market data and generate new signals
    await updateMarketData();
    await generateSignals();

    logger.info('Initial data loaded - signals active for crypto + gold + silver');
  });
}

/**
 * Load Telegram subscriber chat IDs from Supabase (persist across restarts)
 */
async function loadTelegramSubscribers() {
  if (!bot.isActive()) return;

  try {
    const { data, error } = await supabase
      .from('telegram_subscribers')
      .select('chat_id');

    if (error) {
      if (error.code === '42P01') {
        logger.debug('telegram_subscribers table not yet created');
      } else {
        logger.warn('Could not load Telegram subscribers', { error: error.message });
      }
      return;
    }

    for (const row of data || []) {
      bot.subscribe(row.chat_id);
    }

    logger.info('Telegram subscribers loaded', { count: (data || []).length });
  } catch (error) {
    logger.debug('Telegram subscriber load unavailable', { error: error.message });
  }
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
