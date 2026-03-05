// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - METALS PRICE FETCHER v2.0
// Real gold prices via PAXG (tokenized gold) + silver from gold/silver ratio
// PAXG = 1 troy oz of gold, trades on major exchanges with real price discovery
// ═══════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const { logger } = require('./logger');

const apiClient = axios.create({
  timeout: 10000,
  headers: {
    'User-Agent': 'SentixPro/3.0 (Trading Analytics)',
    'Accept': 'application/json'
  }
});

// Cache to avoid excessive API calls
let metalsCache = null;
let metalsCacheTs = 0;
const METALS_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

/**
 * Fetch real gold price via PAXG (Pax Gold) from CoinGecko
 * PAXG is backed 1:1 by physical gold - its price = gold spot price
 * Includes REAL 24h change, volume, and market cap
 */
async function fetchGoldFromPAXG() {
  const response = await apiClient.get(
    'https://api.coingecko.com/api/v3/simple/price',
    {
      params: {
        ids: 'pax-gold',
        vs_currencies: 'usd',
        include_24hr_change: true,
        include_24hr_vol: true,
        include_market_cap: true
      },
      timeout: 8000
    }
  );

  const paxg = response.data?.['pax-gold'];
  if (!paxg || !paxg.usd) {
    throw new Error('PAXG data not available');
  }

  return {
    price: paxg.usd,
    change24h: paxg.usd_24h_change || 0,
    volume24h: paxg.usd_24h_vol || 0,
    marketCap: paxg.usd_market_cap || 0
  };
}

/**
 * Fallback: try CoinCap for PAXG price
 */
async function fetchGoldFromCoinCap() {
  const response = await apiClient.get(
    'https://api.coincap.io/v2/assets/pax-gold',
    { timeout: 8000 }
  );

  const data = response.data?.data;
  if (!data || !data.priceUsd) {
    throw new Error('CoinCap PAXG data not available');
  }

  return {
    price: parseFloat(data.priceUsd),
    change24h: parseFloat(data.changePercent24Hr) || 0,
    volume24h: parseFloat(data.volumeUsd24Hr) || 0,
    marketCap: parseFloat(data.marketCapUsd) || 0
  };
}

/**
 * Fetch metals prices with full fallback chain
 * Gold: PAXG CoinGecko → PAXG CoinCap → cached → static fallback
 * Silver: Derived from gold using gold/silver ratio
 */
async function fetchMetalsPrices() {
  // Check cache first
  if (metalsCache && (Date.now() - metalsCacheTs) < METALS_CACHE_TTL) {
    return metalsCache;
  }

  let goldData = null;

  // Try CoinGecko PAXG first
  try {
    goldData = await fetchGoldFromPAXG();
    logger.debug('Gold price from PAXG (CoinGecko)', { price: goldData.price, change: goldData.change24h });
  } catch (error) {
    logger.warn('CoinGecko PAXG failed, trying CoinCap', { error: error.message });
  }

  // Fallback: CoinCap
  if (!goldData) {
    try {
      goldData = await fetchGoldFromCoinCap();
      logger.debug('Gold price from PAXG (CoinCap)', { price: goldData.price });
    } catch (error) {
      logger.warn('CoinCap PAXG failed', { error: error.message });
    }
  }

  // Fallback: use cached data if available
  if (!goldData && metalsCache) {
    logger.warn('Using cached metals prices');
    return metalsCache;
  }

  // Last resort: static fallback
  if (!goldData) {
    goldData = { price: 2650, change24h: 0, volume24h: 0, marketCap: 0 };
    logger.warn('Using static gold fallback price');
  }

  // Silver: derive from gold/silver ratio
  // Historical ratio typically 75-85, currently around 80-85
  const GOLD_SILVER_RATIO = 82;
  const silverPrice = goldData.price / GOLD_SILVER_RATIO;
  // Silver is more volatile than gold - amplify the change slightly
  const silverChange = goldData.change24h * 1.25;

  const result = {
    gold: {
      price: Math.round(goldData.price * 100) / 100,
      change24h: Math.round(goldData.change24h * 100) / 100,
      volume24h: goldData.volume24h,
      symbol: 'XAU',
      source: goldData.volume24h > 0 ? 'PAXG' : 'fallback'
    },
    silver: {
      price: Math.round(silverPrice * 100) / 100,
      change24h: Math.round(silverChange * 100) / 100,
      volume24h: 0, // No direct silver volume data
      symbol: 'XAG',
      source: 'gold-ratio'
    }
  };

  // Update cache
  metalsCache = result;
  metalsCacheTs = Date.now();

  return result;
}

/**
 * Safe wrapper with comprehensive error handling
 */
async function fetchMetalsPricesSafe() {
  try {
    return await fetchMetalsPrices();
  } catch (error) {
    logger.warn('Metals fetch completely failed', { error: error.message });

    // Return cached or static fallback
    if (metalsCache) return metalsCache;

    return {
      gold: { price: 2650, change24h: 0, volume24h: 0, symbol: 'XAU', source: 'static' },
      silver: { price: 32.30, change24h: 0, volume24h: 0, symbol: 'XAG', source: 'static' }
    };
  }
}

module.exports = {
  fetchMetalsPricesSafe
};
