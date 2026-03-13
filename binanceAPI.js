// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - BINANCE PUBLIC API CLIENT
// High-resolution OHLCV data (1m, 5m, 15m, 1h, 4h) for real-time signals
// Phase 1: Real candles for improved technical analysis
// ═══════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const { logger } = require('./logger');
const { classifyAxiosError, Provider } = require('./errors');

// Safe parseFloat: returns 0 (with warning) on NaN instead of propagating
function safeFloat(value, field = 'unknown') {
  const n = parseFloat(value);
  if (isNaN(n)) {
    logger.warn('parseFloat NaN encountered', { field, value: String(value).slice(0, 50) });
    return 0;
  }
  return n;
}

// Transform raw Binance kline array to internal candle format
function parseKlines(data) {
  return data.map(k => ({
    timestamp: k[0],
    open: safeFloat(k[1], 'kline.open'),
    high: safeFloat(k[2], 'kline.high'),
    low: safeFloat(k[3], 'kline.low'),
    close: safeFloat(k[4], 'kline.close'),
    volume: safeFloat(k[5], 'kline.volume'),
    closeTime: k[6],
    quoteVolume: safeFloat(k[7], 'kline.quoteVolume'),
    trades: k[8],
    takerBuyBaseVolume: safeFloat(k[9], 'kline.takerBuyBaseVolume'),
    takerBuyQuoteVolume: safeFloat(k[10], 'kline.takerBuyQuoteVolume')
  }));
}

// Binance Public API endpoints (in priority order)
// data-api.binance.vision is geo-unrestricted (primary for cloud deploys)
// api.binance.com returns 451 in US/restricted regions
const BINANCE_ENDPOINTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api.binance.us'
];

// Active endpoint (auto-detected, persists for session)
let activeBinanceBase = BINANCE_ENDPOINTS[0];

// Rate limits: Weight per endpoint (public klines = 1 weight)
// Binance rate limit: 6000 weight per minute (IP-based)
// Conservative: 100 requests per minute to avoid rate limiting
const RATE_LIMIT_REQUESTS_PER_MINUTE = 100;
const RATE_LIMIT_INTERVAL_MS = 60000;

// Request tracker for rate limiting
let requestCount = 0;
let rateLimitResetTime = Date.now() + RATE_LIMIT_INTERVAL_MS;

// HTTP client with timeout (mutable baseURL via interceptor)
const binanceClient = axios.create({
  baseURL: activeBinanceBase,
  timeout: 10000,
  headers: {
    'User-Agent': 'SentixPro/2.2 (Trading Analytics)',
    'Accept': 'application/json'
  }
});

// Keep baseURL in sync with active endpoint
binanceClient.interceptors.request.use(config => {
  config.baseURL = activeBinanceBase;
  return config;
});

// Symbol mapping: CoinGecko ID → Binance symbol
const SYMBOL_MAP = {
  bitcoin: 'BTCUSDT',
  ethereum: 'ETHUSDT',
  binancecoin: 'BNBUSDT',
  solana: 'SOLUSDT',
  cardano: 'ADAUSDT',
  ripple: 'XRPUSDT',
  polkadot: 'DOTUSDT',
  dogecoin: 'DOGEUSDT',
  'avalanche-2': 'AVAXUSDT',
  chainlink: 'LINKUSDT'
};

// Valid intervals for Binance klines API
const VALID_INTERVALS = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '2h': '2h',
  '4h': '4h',
  '6h': '6h',
  '8h': '8h',
  '12h': '12h',
  '1d': '1d',
  '3d': '3d',
  '1w': '1w',
  '1M': '1M'
};

/**
 * Check and enforce rate limiting
 * @returns {boolean} true if request is allowed, false if rate limited
 */
function checkRateLimit() {
  const now = Date.now();

  // Reset counter if interval has passed
  if (now >= rateLimitResetTime) {
    requestCount = 0;
    rateLimitResetTime = now + RATE_LIMIT_INTERVAL_MS;
  }

  // Check if we're within limit
  if (requestCount >= RATE_LIMIT_REQUESTS_PER_MINUTE) {
    const waitTime = rateLimitResetTime - now;
    logger.warn('Binance rate limit reached', {
      requestCount,
      limit: RATE_LIMIT_REQUESTS_PER_MINUTE,
      waitMs: waitTime
    });
    return false;
  }

  requestCount++;
  return true;
}

/**
 * Fetch OHLCV klines (candlestick data) from Binance
 *
 * @param {string} symbol - Binance symbol (e.g., 'BTCUSDT')
 * @param {string} interval - Timeframe (1m, 5m, 15m, 1h, 4h, 1d)
 * @param {number} [limit=100] - Number of candles to fetch (max 1000)
 * @param {number} [startTime] - Start time in milliseconds (optional)
 * @param {number} [endTime] - End time in milliseconds (optional)
 * @returns {Promise<Array>} Array of OHLCV candles
 *
 * Response format per candle:
 * [
 *   openTime,           // Open time (ms timestamp)
 *   open,               // Open price (string)
 *   high,               // High price (string)
 *   low,                // Low price (string)
 *   close,              // Close price (string)
 *   volume,             // Volume (string)
 *   closeTime,          // Close time (ms timestamp)
 *   quoteAssetVolume,   // Quote asset volume (string)
 *   numberOfTrades,     // Number of trades (integer)
 *   takerBuyBaseVolume, // Taker buy base asset volume (string)
 *   takerBuyQuoteVolume,// Taker buy quote asset volume (string)
 *   ignore              // Unused field
 * ]
 */
async function fetchKlines(symbol, interval = '1h', limit = 100, startTime = null, endTime = null) {
  // Validate interval
  if (!VALID_INTERVALS[interval]) {
    throw new Error(`Invalid interval: ${interval}. Valid: ${Object.keys(VALID_INTERVALS).join(', ')}`);
  }

  // Validate limit
  if (limit < 1 || limit > 1000) {
    throw new Error('Limit must be between 1 and 1000');
  }

  // Check rate limit
  if (!checkRateLimit()) {
    const waitTime = rateLimitResetTime - Date.now();
    throw new Error(`Rate limited. Wait ${Math.ceil(waitTime / 1000)}s`);
  }

  const params = {
    symbol: symbol.toUpperCase(),
    interval,
    limit
  };

  if (startTime) params.startTime = startTime;
  if (endTime) params.endTime = endTime;

  // Try current endpoint, fallback to alternatives on geo-block (451)
  let lastError = null;
  const endpointsToTry = [activeBinanceBase, ...BINANCE_ENDPOINTS.filter(e => e !== activeBinanceBase)];

  for (const endpoint of endpointsToTry) {
    try {
      const response = await binanceClient.get('/api/v3/klines', {
        params,
        baseURL: endpoint
      });

      // If this endpoint worked and it's not the active one, switch permanently
      if (endpoint !== activeBinanceBase) {
        logger.info(`Binance endpoint switched: ${activeBinanceBase} → ${endpoint}`);
        activeBinanceBase = endpoint;
      }

      const candles = parseKlines(response.data);

      logger.debug('Binance klines fetched', {
        symbol, interval, endpoint,
        candles: candles.length,
        timeRange: candles.length > 0
          ? `${new Date(candles[0].timestamp).toISOString()} to ${new Date(candles[candles.length - 1].timestamp).toISOString()}`
          : 'empty'
      });

      return candles;

    } catch (error) {
      const status = error.response?.status;

      // 451 = geo-blocked, 403 = forbidden — try next endpoint
      if (status === 451 || status === 403) {
        logger.warn(`Binance endpoint ${endpoint} returned ${status}, trying next...`);
        lastError = error;
        continue;
      }

      // 5xx or timeout: retry once with backoff before failing
      if (status >= 500 || error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        logger.warn(`Binance transient error on ${endpoint}: ${status || error.code}, retrying once...`);
        await new Promise(r => setTimeout(r, 2000));
        try {
          const retryResponse = await binanceClient.get('/api/v3/klines', { params, baseURL: endpoint });
          return parseKlines(retryResponse.data);
        } catch (retryErr) {
          logger.warn(`Binance retry also failed on ${endpoint}`);
          lastError = retryErr;
          continue; // Try next endpoint
        }
      }

      // Other errors: don't retry with other endpoints
      const providerError = classifyAxiosError(error, Provider.BINANCE || 'Binance', `/klines/${symbol}/${interval}`);
      logger.providerError(providerError);
      throw error;
    }
  }

  // All endpoints failed
  logger.error('All Binance endpoints failed', {
    endpoints: endpointsToTry,
    lastStatus: lastError?.response?.status
  });
  throw lastError || new Error('All Binance endpoints unavailable');
}

/**
 * Fetch OHLCV data for a CoinGecko asset ID
 * Maps CoinGecko ID to Binance symbol and fetches klines
 *
 * @param {string} coinGeckoId - CoinGecko asset ID (e.g., 'bitcoin')
 * @param {string} interval - Timeframe (1m, 5m, 1h, etc.)
 * @param {number} [limit=100] - Number of candles
 * @returns {Promise<Array>} Array of OHLCV candles
 */
async function fetchOHLCVForAsset(coinGeckoId, interval = '1h', limit = 100) {
  const symbol = SYMBOL_MAP[coinGeckoId];

  if (!symbol) {
    throw new Error(`No Binance symbol mapping for CoinGecko ID: ${coinGeckoId}`);
  }

  return await fetchKlines(symbol, interval, limit);
}

/**
 * Fetch current 24h ticker statistics for a symbol
 * Useful for volume, price change, and other 24h metrics
 *
 * @param {string} symbol - Binance symbol (e.g., 'BTCUSDT')
 * @returns {Promise<Object>} 24h ticker data
 */
async function fetch24hTicker(symbol) {
  if (!checkRateLimit()) {
    const waitTime = rateLimitResetTime - Date.now();
    throw new Error(`Rate limited. Wait ${Math.ceil(waitTime / 1000)}s`);
  }

  const endpointsToTry = [activeBinanceBase, ...BINANCE_ENDPOINTS.filter(e => e !== activeBinanceBase)];

  for (const endpoint of endpointsToTry) {
    try {
      const response = await binanceClient.get('/api/v3/ticker/24hr', {
        params: { symbol: symbol.toUpperCase() },
        baseURL: endpoint
      });
      if (endpoint !== activeBinanceBase) {
        logger.info(`Binance endpoint switched: ${activeBinanceBase} → ${endpoint}`);
        activeBinanceBase = endpoint;
      }
      const data = response.data;
      return {
        symbol: data.symbol,
        priceChange: parseFloat(data.priceChange),
        priceChangePercent: parseFloat(data.priceChangePercent),
        weightedAvgPrice: parseFloat(data.weightedAvgPrice),
        lastPrice: parseFloat(data.lastPrice),
        volume: parseFloat(data.volume),
        quoteVolume: parseFloat(data.quoteVolume),
        openTime: data.openTime,
        closeTime: data.closeTime,
        firstId: data.firstId,
        lastId: data.lastId,
        count: data.count
      };
    } catch (error) {
      if (error.response?.status === 451 || error.response?.status === 403) {
        logger.warn(`Binance endpoint ${endpoint} returned ${error.response.status}, trying next...`);
        continue;
      }
      const providerError = classifyAxiosError(error, Provider.BINANCE || 'Binance', `/ticker/24hr/${symbol}`);
      logger.providerError(providerError);
      throw error;
    }
  }
  throw new Error('All Binance endpoints unavailable');
}

/**
 * Fetch multiple 24h tickers at once (more efficient)
 *
 * @param {Array<string>} symbols - Array of Binance symbols
 * @returns {Promise<Object>} Map of symbol → ticker data
 */
async function fetchMultiple24hTickers(symbols) {
  if (!checkRateLimit()) {
    const waitTime = rateLimitResetTime - Date.now();
    throw new Error(`Rate limited. Wait ${Math.ceil(waitTime / 1000)}s`);
  }

  const endpointsToTry = [activeBinanceBase, ...BINANCE_ENDPOINTS.filter(e => e !== activeBinanceBase)];

  for (const endpoint of endpointsToTry) {
    try {
      // Request only needed symbols (avoids downloading 2000+ tickers)
      const upperSymbols = symbols.map(s => s.toUpperCase());
      const params = upperSymbols.length <= 20
        ? { symbols: JSON.stringify(upperSymbols) }
        : {}; // Fallback to full list for very large requests
      const response = await binanceClient.get('/api/v3/ticker/24hr', { baseURL: endpoint, params });

      if (endpoint !== activeBinanceBase) {
        logger.info(`Binance endpoint switched: ${activeBinanceBase} → ${endpoint}`);
        activeBinanceBase = endpoint;
      }

      const symbolSet = new Set(symbols.map(s => s.toUpperCase()));
      const tickers = {};

      for (const ticker of response.data) {
        if (symbolSet.has(ticker.symbol)) {
          tickers[ticker.symbol] = {
            symbol: ticker.symbol,
            priceChange: parseFloat(ticker.priceChange),
            priceChangePercent: parseFloat(ticker.priceChangePercent),
            lastPrice: parseFloat(ticker.lastPrice),
            volume: parseFloat(ticker.volume),
            quoteVolume: parseFloat(ticker.quoteVolume),
            count: ticker.count
          };
        }
      }

      logger.debug('Binance 24h tickers fetched', { requested: symbols.length, found: Object.keys(tickers).length });
      return tickers;

    } catch (error) {
      if (error.response?.status === 451 || error.response?.status === 403) {
        logger.warn(`Binance endpoint ${endpoint} returned ${error.response.status}, trying next...`);
        continue;
      }
      const providerError = classifyAxiosError(error, Provider.BINANCE || 'Binance', '/ticker/24hr');
      logger.providerError(providerError);
      throw error;
    }
  }
  throw new Error('All Binance endpoints unavailable');
}

/**
 * Get rate limit status
 * @returns {Object} Current rate limit info
 */
function getRateLimitStatus() {
  const now = Date.now();
  const resetIn = Math.max(0, rateLimitResetTime - now);

  return {
    requestCount,
    limit: RATE_LIMIT_REQUESTS_PER_MINUTE,
    remaining: Math.max(0, RATE_LIMIT_REQUESTS_PER_MINUTE - requestCount),
    resetInMs: resetIn,
    resetInSeconds: Math.ceil(resetIn / 1000)
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BINANCE FUTURES API (Public, no auth required)
// Funding Rate, Open Interest, Long/Short Ratio
// ═══════════════════════════════════════════════════════════════════════════════

const BINANCE_FUTURES_ENDPOINTS = [
  'https://fapi.binance.com',
  'https://fapi.binance.us'
];

let activeFuturesBase = BINANCE_FUTURES_ENDPOINTS[0];

const binanceFuturesClient = axios.create({
  baseURL: activeFuturesBase,
  timeout: 10000,
  headers: {
    'User-Agent': 'SentixPro/4.0 (Trading Analytics)',
    'Accept': 'application/json'
  }
});

binanceFuturesClient.interceptors.request.use(config => {
  config.baseURL = activeFuturesBase;
  return config;
});

const FUTURES_SYMBOL_MAP = { ...SYMBOL_MAP };

/**
 * Fetch current funding rate from Binance USDM Futures
 * @param {string} symbol - e.g. 'BTCUSDT'
 * @returns {Promise<Object>} { fundingRate, fundingTime, markPrice }
 */
async function fetchFundingRate(symbol) {
  if (!checkRateLimit()) throw new Error('Rate limited');

  for (const endpoint of [activeFuturesBase, ...BINANCE_FUTURES_ENDPOINTS.filter(e => e !== activeFuturesBase)]) {
    try {
      const response = await binanceFuturesClient.get('/fapi/v1/fundingRate', {
        params: { symbol: symbol.toUpperCase(), limit: 1 },
        baseURL: endpoint
      });
      if (endpoint !== activeFuturesBase) {
        logger.info(`Binance Futures endpoint switched: ${activeFuturesBase} → ${endpoint}`);
        activeFuturesBase = endpoint;
      }
      const data = response.data?.[0] || {};
      return {
        fundingRate: parseFloat(data.fundingRate) || 0,
        fundingTime: data.fundingTime,
        markPrice: parseFloat(data.markPrice) || 0
      };
    } catch (error) {
      if (error.response?.status === 451 || error.response?.status === 403) {
        logger.warn(`Futures endpoint ${endpoint} returned ${error.response.status}, trying next...`);
        continue;
      }
      const providerError = classifyAxiosError(error, Provider.BINANCE || 'Binance', `/fundingRate/${symbol}`);
      logger.providerError(providerError);
      throw error;
    }
  }
  throw new Error('All Binance Futures endpoints unavailable');
}

/**
 * Fetch open interest from Binance USDM Futures
 * @param {string} symbol - e.g. 'BTCUSDT'
 * @returns {Promise<Object>} { openInterest, symbol, time }
 */
async function fetchOpenInterest(symbol) {
  if (!checkRateLimit()) throw new Error('Rate limited');

  for (const endpoint of [activeFuturesBase, ...BINANCE_FUTURES_ENDPOINTS.filter(e => e !== activeFuturesBase)]) {
    try {
      const response = await binanceFuturesClient.get('/fapi/v1/openInterest', {
        params: { symbol: symbol.toUpperCase() },
        baseURL: endpoint
      });
      if (endpoint !== activeFuturesBase) {
        logger.info(`Binance Futures endpoint switched: ${activeFuturesBase} → ${endpoint}`);
        activeFuturesBase = endpoint;
      }
      return {
        openInterest: parseFloat(response.data.openInterest) || 0,
        symbol: response.data.symbol,
        time: response.data.time
      };
    } catch (error) {
      if (error.response?.status === 451 || error.response?.status === 403) {
        logger.warn(`Futures endpoint ${endpoint} returned ${error.response.status}, trying next...`);
        continue;
      }
      const providerError = classifyAxiosError(error, Provider.BINANCE || 'Binance', `/openInterest/${symbol}`);
      logger.providerError(providerError);
      throw error;
    }
  }
  throw new Error('All Binance Futures endpoints unavailable');
}

/**
 * Fetch global long/short account ratio (0 weight - free!)
 * @param {string} symbol - e.g. 'BTCUSDT'
 * @param {string} period - '5m', '15m', '30m', '1h', '2h', '4h'
 * @returns {Promise<Object>}
 */
async function fetchLongShortRatio(symbol, period = '1h') {
  try {
    const response = await binanceFuturesClient.get('/futures/data/globalLongShortAccountRatio', {
      params: { symbol: symbol.toUpperCase(), period, limit: 1 }
    });
    const data = response.data?.[0] || {};
    return {
      longShortRatio: parseFloat(data.longShortRatio) || 1,
      longAccount: parseFloat(data.longAccount) || 0.5,
      shortAccount: parseFloat(data.shortAccount) || 0.5,
      timestamp: data.timestamp
    };
  } catch (error) {
    logger.warn('Long/short ratio fetch failed', { symbol, error: error.message });
    return { longShortRatio: 1, longAccount: 0.5, shortAccount: 0.5, timestamp: null };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BYBIT V5 API — Fallback for derivatives data when Binance is geo-blocked
// No API key required for public market endpoints
// ═══════════════════════════════════════════════════════════════════════════════

const BYBIT_BASE = 'https://api.bybit.com';
let derivativesProvider = 'binance'; // 'binance' or 'bybit' — auto-switches on 451

/**
 * Fetch funding rate from Bybit V5 API
 */
async function fetchFundingRateBybit(symbol) {
  const res = await axios.get(`${BYBIT_BASE}/v5/market/funding/history`, {
    params: { category: 'linear', symbol: symbol.toUpperCase(), limit: 1 },
    timeout: 10000
  });
  const item = res.data?.result?.list?.[0];
  if (!item) throw new Error('No Bybit funding data');
  return {
    fundingRate: parseFloat(item.fundingRate) || 0,
    fundingTime: parseInt(item.fundingRateTimestamp) || Date.now(),
    markPrice: 0 // Bybit funding endpoint doesn't return mark price
  };
}

/**
 * Fetch open interest from Bybit V5 API
 */
async function fetchOpenInterestBybit(symbol) {
  const res = await axios.get(`${BYBIT_BASE}/v5/market/open-interest`, {
    params: { category: 'linear', symbol: symbol.toUpperCase(), intervalTime: '1h', limit: 1 },
    timeout: 10000
  });
  const item = res.data?.result?.list?.[0];
  if (!item) throw new Error('No Bybit OI data');
  return {
    openInterest: parseFloat(item.openInterest) || 0,
    symbol: symbol.toUpperCase(),
    time: parseInt(item.timestamp) || Date.now()
  };
}

/**
 * Fetch long/short account ratio from Bybit V5 API
 */
async function fetchLongShortRatioBybit(symbol, period = '1h') {
  const res = await axios.get(`${BYBIT_BASE}/v5/market/account-ratio`, {
    params: { category: 'linear', symbol: symbol.toUpperCase(), period, limit: 1 },
    timeout: 10000
  });
  const item = res.data?.result?.list?.[0];
  if (!item) return { longShortRatio: 1, longAccount: 0.5, shortAccount: 0.5, timestamp: null };
  const buyRatio = parseFloat(item.buyRatio) || 0.5;
  const sellRatio = parseFloat(item.sellRatio) || 0.5;
  return {
    longShortRatio: sellRatio > 0 ? Math.round((buyRatio / sellRatio) * 1000) / 1000 : 1,
    longAccount: buyRatio,
    shortAccount: sellRatio,
    timestamp: parseInt(item.timestamp) || null
  };
}

/**
 * Fetch historical funding rates from Bybit V5 (for backtester)
 */
async function fetchHistoricalFundingBybit(symbol, startMs, endMs) {
  const results = [];
  let endCursor = endMs;
  const MAX_PAGES = 20;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await axios.get(`${BYBIT_BASE}/v5/market/funding/history`, {
      params: { category: 'linear', symbol: symbol.toUpperCase(), endTime: endCursor, limit: 200 },
      timeout: 15000
    });
    const list = res.data?.result?.list || [];
    if (list.length === 0) break;

    for (const item of list) {
      const ts = parseInt(item.fundingRateTimestamp);
      if (ts < startMs) { page = MAX_PAGES; break; } // Stop pagination
      results.push({ fundingTime: ts, fundingRate: parseFloat(item.fundingRate) || 0 });
    }

    endCursor = parseInt(list[list.length - 1].fundingRateTimestamp) - 1;
    await new Promise(r => setTimeout(r, 200)); // Be nice to Bybit
  }

  return results.sort((a, b) => a.fundingTime - b.fundingTime);
}

/**
 * Fetch all derivatives data for a CoinGecko asset ID
 * Tries Binance first, auto-falls back to Bybit on geo-block (451/403)
 * @param {string} coinGeckoId - e.g. 'bitcoin'
 * @returns {Promise<Object|null>} Derivatives data or null if not available
 */
async function fetchDerivativesData(coinGeckoId) {
  const symbol = FUTURES_SYMBOL_MAP[coinGeckoId];
  if (!symbol) return null;

  // Try Binance first (unless already switched to Bybit)
  if (derivativesProvider === 'binance') {
    try {
      const [funding, oi, lsRatio] = await Promise.all([
        fetchFundingRate(symbol),
        fetchOpenInterest(symbol),
        fetchLongShortRatio(symbol)
      ]);

      const fundingRatePercent = funding.fundingRate * 100;
      const fundingRateAnnualized = fundingRatePercent * 3 * 365;

      return {
        fundingRate: funding.fundingRate,
        fundingRatePercent: Math.round(fundingRatePercent * 10000) / 10000,
        fundingRateAnnualized: Math.round(fundingRateAnnualized * 100) / 100,
        openInterest: oi.openInterest,
        longShortRatio: lsRatio.longShortRatio,
        longAccount: lsRatio.longAccount,
        shortAccount: lsRatio.shortAccount,
        markPrice: funding.markPrice,
        source: 'binance',
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      // If geo-blocked, permanently switch to Bybit for this session
      if (error.message?.includes('All Binance Futures') || error.message?.includes('451') || error.message?.includes('403')) {
        logger.warn('Binance Futures geo-blocked — switching to Bybit derivatives');
        derivativesProvider = 'bybit';
      } else {
        logger.warn('Derivatives data fetch failed (Binance)', { coinGeckoId, error: error.message });
        // Don't switch provider for transient errors, fall through to Bybit as one-time fallback
      }
    }
  }

  // Bybit fallback
  try {
    const [funding, oi, lsRatio] = await Promise.all([
      fetchFundingRateBybit(symbol),
      fetchOpenInterestBybit(symbol),
      fetchLongShortRatioBybit(symbol)
    ]);

    const fundingRatePercent = funding.fundingRate * 100;
    const fundingRateAnnualized = fundingRatePercent * 3 * 365;

    return {
      fundingRate: funding.fundingRate,
      fundingRatePercent: Math.round(fundingRatePercent * 10000) / 10000,
      fundingRateAnnualized: Math.round(fundingRateAnnualized * 100) / 100,
      openInterest: oi.openInterest,
      longShortRatio: lsRatio.longShortRatio,
      longAccount: lsRatio.longAccount,
      shortAccount: lsRatio.shortAccount,
      markPrice: funding.markPrice || 0,
      source: 'bybit',
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.warn('Derivatives data fetch failed (Bybit fallback)', { coinGeckoId, error: error.message });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER BOOK DEPTH (Spot)
// Bid/Ask walls, imbalance ratio, spread analysis
// Weight: 5 per call (limit=20), fits well within rate budget
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch order book depth for a CoinGecko asset ID.
 * Returns bids/asks with aggregated metrics: imbalance ratio, spread, walls.
 *
 * @param {string} coinGeckoId - CoinGecko asset ID (e.g. 'bitcoin')
 * @param {number} [limit=20] - Depth levels (5, 10, 20, 50, 100, 500, 1000)
 * @returns {Promise<Object|null>} Order book data or null if unavailable
 *
 * Returned object:
 * {
 *   bidTotal, askTotal,        // Summed volume on each side
 *   imbalanceRatio,            // bidTotal / askTotal (>1 = more buy support)
 *   spreadPercent,             // (bestAsk - bestBid) / midPrice * 100
 *   bestBid, bestAsk,
 *   bidWall, askWall,          // Largest single level
 *   wallImbalance,             // bidWall.qty / askWall.qty
 *   depthLevels                // Number of levels fetched
 * }
 */
async function fetchOrderBookDepth(coinGeckoId, limit = 20) {
  const symbol = SYMBOL_MAP[coinGeckoId];
  if (!symbol) return null;

  if (!checkRateLimit()) {
    logger.warn('Rate limited - skipping order book', { coinGeckoId });
    return null;
  }

  const endpointsToTry = [activeBinanceBase, ...BINANCE_ENDPOINTS.filter(e => e !== activeBinanceBase)];

  for (const endpoint of endpointsToTry) {
    try {
      const response = await binanceClient.get('/api/v3/depth', {
        params: { symbol: symbol.toUpperCase(), limit },
        baseURL: endpoint
      });

      if (endpoint !== activeBinanceBase) {
        logger.info(`Binance endpoint switched: ${activeBinanceBase} → ${endpoint}`);
        activeBinanceBase = endpoint;
      }

      const { bids, asks } = response.data;

      if (!bids || !asks || bids.length === 0 || asks.length === 0) {
        logger.warn('Empty order book', { symbol });
        return null;
      }

      // Parse price/qty arrays: [[price, qty], ...]
      const parsedBids = bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));
      const parsedAsks = asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) }));

      // Aggregated volumes
      const bidTotal = parsedBids.reduce((sum, b) => sum + b.qty, 0);
      const askTotal = parsedAsks.reduce((sum, a) => sum + a.qty, 0);
      const imbalanceRatio = askTotal > 0 ? Math.round((bidTotal / askTotal) * 1000) / 1000 : 1;

      // Spread
      const bestBid = parsedBids[0].price;
      const bestAsk = parsedAsks[0].price;
      const midPrice = (bestBid + bestAsk) / 2;
      const spreadPercent = midPrice > 0 ? Math.round(((bestAsk - bestBid) / midPrice) * 10000) / 100 : 0;

      // Walls: largest single level on each side
      const bidWall = parsedBids.reduce((max, b) => b.qty > max.qty ? b : max, parsedBids[0]);
      const askWall = parsedAsks.reduce((max, a) => a.qty > max.qty ? a : max, parsedAsks[0]);
      const wallImbalance = askWall.qty > 0 ? Math.round((bidWall.qty / askWall.qty) * 1000) / 1000 : 1;

      logger.debug('Order book fetched', {
        symbol, levels: limit, bidTotal: bidTotal.toFixed(2), askTotal: askTotal.toFixed(2),
        imbalance: imbalanceRatio, spread: spreadPercent
      });

      return {
        bidTotal: Math.round(bidTotal * 100) / 100,
        askTotal: Math.round(askTotal * 100) / 100,
        imbalanceRatio,
        spreadPercent,
        bestBid,
        bestAsk,
        bidWall: { price: bidWall.price, qty: Math.round(bidWall.qty * 100) / 100 },
        askWall: { price: askWall.price, qty: Math.round(askWall.qty * 100) / 100 },
        wallImbalance,
        depthLevels: limit,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      const status = error.response?.status;
      if (status === 451 || status === 403) {
        logger.warn(`Binance endpoint ${endpoint} returned ${status} for depth, trying next...`);
        continue;
      }
      logger.warn('Order book fetch failed', { symbol, error: error.message });
      return null;
    }
  }

  logger.warn('All Binance endpoints failed for order book', { coinGeckoId });
  return null;
}

module.exports = {
  fetchKlines,
  fetchOHLCVForAsset,
  fetch24hTicker,
  fetchMultiple24hTickers,
  getRateLimitStatus,
  fetchFundingRate,
  fetchOpenInterest,
  fetchLongShortRatio,
  fetchDerivativesData,
  fetchOrderBookDepth,
  fetchHistoricalFundingBybit,
  fetchFundingRateBybit,
  fetchOpenInterestBybit,
  fetchLongShortRatioBybit,
  SYMBOL_MAP,
  FUTURES_SYMBOL_MAP,
  VALID_INTERVALS,
  getDerivativesProvider: () => derivativesProvider
};
