// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — MARKET DATA WORKER
// Fetches crypto prices, macro data, metals, DXY every 1 minute.
// Monitors paper trading positions on each update.
// Communicates with orchestrator via IPC.
// ═══════════════════════════════════════════════════════════════════════════════

require('dotenv').config();

const cron = require('node-cron');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { fetchMetalsPricesSafe } = require('../metalsAPI');
const { monitorAndManage } = require('../paperTrading');
const { logger } = require('../logger');
const { classifyAxiosError, Provider } = require('../errors');
const { MSG, sendToParent, installWorkerIPC } = require('../shared/ipc');
const { metrics } = require('../shared/metrics');
const { wrapWithCircuitBreaker } = require('../circuitBreaker');
const { initConfigManager } = require('../configManager');

// ─── SUPABASE CLIENT ──────────────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);

// Initialize config manager (non-blocking)
initConfigManager(supabase).catch(() => {});

// ─── CACHED STATE (local to this worker) ──────────────────────────────────
let cachedMarketData = null;
let lastSuccessfulCrypto = {};
let isUpdatingMarketData = false;

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

async function fetchWithRetry(fn, retries = 3, baseDelay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (rawError) {
      const providerError = classifyAxiosError(rawError, 'HTTP', rawError.config?.url);
      if (attempt === retries || !providerError.retryable) {
        throw rawError;
      }
      const exponentialDelay = providerError.type === 'RATE_LIMIT'
        ? baseDelay * Math.pow(2, attempt)
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
// DATA FETCHING FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchCryptoPrices() {
  const _t0 = Date.now();
  try {
    const cryptoData = await wrapWithCircuitBreaker(Provider.COINGECKO, () =>
      fetchWithRetry(async () => {
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
      }, 2, 3000)
    , null);

    if (cryptoData && Object.keys(cryptoData).length > 0) {
      lastSuccessfulCrypto = cryptoData;
      metrics.counter('provider.coingecko.success');
      metrics.histogram('provider.coingecko.latency', Date.now() - _t0);
      logger.info('CoinGecko fetch OK', { assets: Object.keys(cryptoData).length });
      return cryptoData;
    }
  } catch (error) {
    metrics.counter('provider.coingecko.error');
    logger.providerError(classifyAxiosError(error, Provider.COINGECKO, 'simple/price'));
  }

  try {
    logger.info('Falling back to Binance ticker API');
    const _t1 = Date.now();
    const cryptoData = await fetchFromBinanceTickers();
    if (Object.keys(cryptoData).length > 0) {
      lastSuccessfulCrypto = cryptoData;
      metrics.counter('provider.binance_ticker.success');
      metrics.histogram('provider.binance_ticker.latency', Date.now() - _t1);
      logger.info('Binance ticker fallback OK', { assets: Object.keys(cryptoData).length });
      return cryptoData;
    }
  } catch (error) {
    metrics.counter('provider.binance_ticker.error');
    logger.warn('Binance ticker fallback failed', { error: error.message });
  }

  if (Object.keys(lastSuccessfulCrypto).length > 0) {
    logger.warn('Using cached crypto data', { assets: Object.keys(lastSuccessfulCrypto).length });
    return lastSuccessfulCrypto;
  }

  return {};
}

// Binance ticker fallback — replaces dead CoinCap API
const BINANCE_TICKER_MAP = {
  bitcoin: 'BTCUSDT', ethereum: 'ETHUSDT', binancecoin: 'BNBUSDT',
  solana: 'SOLUSDT', cardano: 'ADAUSDT', ripple: 'XRPUSDT',
  polkadot: 'DOTUSDT', dogecoin: 'DOGEUSDT', 'avalanche-2': 'AVAXUSDT',
  chainlink: 'LINKUSDT'
};

async function fetchFromBinanceTickers() {
  const symbols = Object.values(BINANCE_TICKER_MAP);
  const response = await apiClient.get(
    'https://api.binance.com/api/v3/ticker/24hr',
    { params: { symbols: JSON.stringify(symbols) }, timeout: 10000 }
  );
  const result = {};
  for (const ticker of response.data || []) {
    const cgKey = Object.entries(BINANCE_TICKER_MAP).find(([, v]) => v === ticker.symbol)?.[0];
    if (cgKey && CRYPTO_ASSETS[cgKey]) {
      const price = parseFloat(ticker.lastPrice) || 0;
      const openPrice = parseFloat(ticker.openPrice) || 0;
      const change24h = openPrice > 0 ? ((price - openPrice) / openPrice) * 100 : 0;
      result[cgKey] = {
        symbol: CRYPTO_ASSETS[cgKey].toUpperCase(),
        price,
        change24h: Math.round(change24h * 100) / 100,
        volume24h: parseFloat(ticker.quoteVolume) || 0,
        marketCap: 0 // Binance doesn't provide market cap
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

// DXY proxy via EUR/USD
let cachedDxy = { dxy: 100, dxyTrend: 'neutral', dxyChange: 0 };
let lastDxyFetch = 0;
const DXY_CACHE_TTL = 15 * 60 * 1000;

async function fetchDXY() {
  if (Date.now() - lastDxyFetch < DXY_CACHE_TTL && cachedDxy.dxy !== 100) {
    return cachedDxy;
  }
  try {
    const response = await apiClient.get(
      'https://open.er-api.com/v6/latest/USD',
      { timeout: 8000 }
    );
    if (response.data && response.data.rates && response.data.rates.EUR) {
      const eurUsd = 1 / response.data.rates.EUR;
      const dxy = (1 / eurUsd) * 120;
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

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN UPDATE FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

async function updateMarketData() {
  const _cycleStart = Date.now();
  try {
    logger.info('Updating market data');
    metrics.counter('market.cycles');

    const crypto = await fetchCryptoPrices();
    const [fearGreedData, globalData, metals, dxyData] = await Promise.all([
      fetchFearGreed(),
      fetchGlobalData(),
      fetchMetalsPrices(),
      fetchDXY()
    ]);

    const cryptoCount = Object.keys(crypto).length;

    if (cryptoCount > 0 || !cachedMarketData) {
      cachedMarketData = {
        crypto: cryptoCount > 0 ? crypto : (cachedMarketData?.crypto || {}),
        macro: { ...fearGreedData, ...globalData, ...dxyData },
        metals,
        lastUpdate: new Date().toISOString()
      };
      logger.info('Market data updated', { cryptoAssets: cryptoCount });
    } else {
      cachedMarketData = {
        ...cachedMarketData,
        macro: { ...fearGreedData, ...globalData, ...dxyData },
        metals,
        lastUpdate: new Date().toISOString()
      };
      logger.warn('Market data partially updated (crypto unchanged, using cache)');
    }

    metrics.histogram('market.cycle.duration', Date.now() - _cycleStart);

    // Send market data to orchestrator → api.js (for SSE broadcast)
    sendToParent(MSG.MARKET_UPDATE, cachedMarketData);

    // Paper trading position monitoring
    try {
      const ptMonitor = await monitorAndManage(supabase, 'default-user', cachedMarketData);
      if (ptMonitor.closedTrades && ptMonitor.closedTrades.length > 0) {
        sendToParent(MSG.PAPER_TRADE, { action: 'closed', trades: ptMonitor.closedTrades });
      }
      if (ptMonitor.partialCloses && ptMonitor.partialCloses.length > 0) {
        sendToParent(MSG.PAPER_TRADE, { action: 'partial', trades: ptMonitor.partialCloses });
      }
    } catch (ptError) {
      logger.debug('Paper trading monitor cycle', { error: ptError.message });
    }

  } catch (error) {
    logger.error('Market data update failed', { error: error.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKER LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

let cronTask = null;

function gracefulShutdown() {
  logger.info('Market worker shutting down');
  if (cronTask) {
    try { cronTask.stop(); } catch (_) {}
  }
  setTimeout(() => process.exit(0), 500);
}

// Install IPC handlers (heartbeat + shutdown)
installWorkerIPC(gracefulShutdown);

// Cron: update market data every 1 minute
cronTask = cron.schedule('*/1 * * * *', async () => {
  if (isUpdatingMarketData) {
    logger.debug('Skipping updateMarketData — previous cycle still running');
    return;
  }
  isUpdatingMarketData = true;
  try {
    await updateMarketData();
  } finally {
    isUpdatingMarketData = false;
  }
});

// Send metrics to API via IPC every 60s
const _metricsTimer = setInterval(() => {
  sendToParent(MSG.METRICS_UPDATE, metrics.snapshot());
}, 60000);
_metricsTimer.unref();

// Initial fetch on startup
(async () => {
  logger.info('Market worker started', { pid: process.pid });
  try {
    await updateMarketData();
    logger.info('Market worker initial data loaded');
  } catch (err) {
    logger.error('Market worker initial fetch failed', { error: err.message });
  }
})();

// Error handlers
process.on('unhandledRejection', (reason) => {
  logger.error('Market worker unhandled rejection', { reason: reason?.message || String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('Market worker uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});
