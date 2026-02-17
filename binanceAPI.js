// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - BINANCE PUBLIC API CLIENT
// High-resolution OHLCV data (1m, 5m, 15m, 1h, 4h) for real-time signals
// Phase 1: Real candles for improved technical analysis
// ═══════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const { logger } = require('./logger');
const { classifyAxiosError, Provider } = require('./errors');

// Binance Public API (no authentication required)
const BINANCE_API_BASE = 'https://api.binance.com';

// Rate limits: Weight per endpoint (public klines = 1 weight)
// Binance rate limit: 6000 weight per minute (IP-based)
// Conservative: 100 requests per minute to avoid rate limiting
const RATE_LIMIT_REQUESTS_PER_MINUTE = 100;
const RATE_LIMIT_INTERVAL_MS = 60000;

// Request tracker for rate limiting
let requestCount = 0;
let rateLimitResetTime = Date.now() + RATE_LIMIT_INTERVAL_MS;

// HTTP client with timeout
const binanceClient = axios.create({
  baseURL: BINANCE_API_BASE,
  timeout: 10000,
  headers: {
    'User-Agent': 'SentixPro/2.2 (Trading Analytics)',
    'Accept': 'application/json'
  }
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

  try {
    const params = {
      symbol: symbol.toUpperCase(),
      interval,
      limit
    };

    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;

    const response = await binanceClient.get('/api/v3/klines', { params });

    // Transform to our internal format
    const candles = response.data.map(k => ({
      timestamp: k[0],               // Open time
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
      quoteVolume: parseFloat(k[7]),
      trades: k[8],
      takerBuyBaseVolume: parseFloat(k[9]),
      takerBuyQuoteVolume: parseFloat(k[10])
    }));

    logger.debug('Binance klines fetched', {
      symbol,
      interval,
      candles: candles.length,
      timeRange: candles.length > 0
        ? `${new Date(candles[0].timestamp).toISOString()} to ${new Date(candles[candles.length - 1].timestamp).toISOString()}`
        : 'empty'
    });

    return candles;

  } catch (error) {
    const providerError = classifyAxiosError(error, Provider.BINANCE || 'Binance', `/klines/${symbol}/${interval}`);
    logger.providerError(providerError);
    throw error;
  }
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

  try {
    const response = await binanceClient.get('/api/v3/ticker/24hr', {
      params: { symbol: symbol.toUpperCase() }
    });

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
      count: data.count  // Number of trades
    };

  } catch (error) {
    const providerError = classifyAxiosError(error, Provider.BINANCE || 'Binance', `/ticker/24hr/${symbol}`);
    logger.providerError(providerError);
    throw error;
  }
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

  try {
    // Fetch all tickers in one request (no symbol param = all tickers)
    const response = await binanceClient.get('/api/v3/ticker/24hr');

    // Filter only requested symbols
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
    const providerError = classifyAxiosError(error, Provider.BINANCE || 'Binance', '/ticker/24hr');
    logger.providerError(providerError);
    throw error;
  }
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

module.exports = {
  fetchKlines,
  fetchOHLCVForAsset,
  fetch24hTicker,
  fetchMultiple24hTickers,
  getRateLimitStatus,
  SYMBOL_MAP,
  VALID_INTERVALS
};
