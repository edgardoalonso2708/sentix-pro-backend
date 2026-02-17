// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - FEATURE STORE
// Precomputed features for fast signal generation
// Phase 1: Returns, volatility, volume metrics, market regime
// ═══════════════════════════════════════════════════════════════════════════════

const { logger } = require('./logger');
const { fetchOHLCVCandles } = require('./technicalAnalysis');

/**
 * Feature store cache
 * Structure: Map<assetId, { features, timestamp }>
 */
const featureCache = new Map();
const FEATURE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Calculate returns over different periods
 * @param {Array} candles - OHLCV candles (newest first)
 * @param {number} periods - Number of periods to look back
 * @returns {number} Return percentage
 */
function calculateReturn(candles, periods = 1) {
  if (candles.length < periods + 1) return 0;

  const latest = candles[candles.length - 1].close;
  const previous = candles[candles.length - 1 - periods].close;

  return ((latest - previous) / previous) * 100;
}

/**
 * Calculate realized volatility (standard deviation of returns)
 * @param {Array} candles - OHLCV candles
 * @param {number} window - Rolling window size
 * @returns {number} Volatility percentage
 */
function calculateRealizedVolatility(candles, window = 24) {
  if (candles.length < window + 1) return 0;

  const recent = candles.slice(-window - 1);
  const returns = [];

  for (let i = 1; i < recent.length; i++) {
    const ret = ((recent[i].close - recent[i - 1].close) / recent[i - 1].close) * 100;
    returns.push(ret);
  }

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;

  return Math.sqrt(variance);
}

/**
 * Calculate volume z-score (how unusual is current volume)
 * @param {Array} candles - OHLCV candles
 * @param {number} window - Rolling window size
 * @returns {number} Z-score
 */
function calculateVolumeZScore(candles, window = 24) {
  if (candles.length < window + 1) return 0;

  const recent = candles.slice(-window - 1);
  const volumes = recent.map(c => c.volume);

  const mean = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
  const stdDev = Math.sqrt(
    volumes.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / volumes.length
  );

  if (stdDev === 0) return 0;

  const currentVolume = candles[candles.length - 1].volume;
  return (currentVolume - mean) / stdDev;
}

/**
 * Determine market regime based on price action and volatility
 * @param {Array} candles - OHLCV candles
 * @returns {string} Regime: 'trending_up', 'trending_down', 'ranging', 'volatile'
 */
function determineMarketRegime(candles) {
  if (candles.length < 50) return 'unknown';

  const recent = candles.slice(-50);

  // Calculate directional movement
  const returns = [];
  for (let i = 1; i < recent.length; i++) {
    returns.push((recent[i].close - recent[i - 1].close) / recent[i - 1].close);
  }

  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const volatility = Math.sqrt(
    returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
  );

  // Regime classification
  if (volatility > 0.03) return 'volatile';  // >3% daily volatility
  if (avgReturn > 0.001) return 'trending_up';  // Positive drift
  if (avgReturn < -0.001) return 'trending_down';  // Negative drift
  return 'ranging';  // Low volatility, no clear trend
}

/**
 * Calculate Average True Range (ATR) - volatility measure
 * @param {Array} candles - OHLCV candles
 * @param {number} period - ATR period (default 14)
 * @returns {number} ATR value
 */
function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;

  const recent = candles.slice(-period - 1);
  const trueRanges = [];

  for (let i = 1; i < recent.length; i++) {
    const high = recent[i].high;
    const low = recent[i].low;
    const prevClose = recent[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    trueRanges.push(tr);
  }

  return trueRanges.reduce((sum, tr) => sum + tr, 0) / trueRanges.length;
}

/**
 * Calculate price momentum (rate of change)
 * @param {Array} candles - OHLCV candles
 * @param {number} period - Period to look back
 * @returns {number} Momentum percentage
 */
function calculateMomentum(candles, period = 14) {
  if (candles.length < period + 1) return 0;

  const current = candles[candles.length - 1].close;
  const previous = candles[candles.length - 1 - period].close;

  return ((current - previous) / previous) * 100;
}

/**
 * Calculate volume-weighted average price (VWAP) for recent period
 * @param {Array} candles - OHLCV candles
 * @param {number} period - Period to calculate (default 24)
 * @returns {number} VWAP value
 */
function calculateVWAP(candles, period = 24) {
  if (candles.length < period) return 0;

  const recent = candles.slice(-period);
  let volumeSum = 0;
  let vwapSum = 0;

  for (const candle of recent) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    vwapSum += typical * candle.volume;
    volumeSum += candle.volume;
  }

  return volumeSum > 0 ? vwapSum / volumeSum : 0;
}

/**
 * Compute all features for an asset
 * @param {string} assetId - CoinGecko asset ID
 * @param {string} interval - Candle interval (default '1h')
 * @param {number} limit - Number of candles to fetch
 * @returns {Promise<Object>} Feature object
 */
async function computeFeatures(assetId, interval = '1h', limit = 200) {
  try {
    // Fetch OHLCV candles
    const candles = await fetchOHLCVCandles(assetId, interval, limit);

    if (candles.length < 50) {
      logger.warn('Insufficient candles for feature computation', { assetId, candles: candles.length });
      return null;
    }

    // Current values
    const latest = candles[candles.length - 1];
    const currentPrice = latest.close;

    // Compute features
    const features = {
      // Price & basic info
      price: currentPrice,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      volume: latest.volume,
      timestamp: latest.timestamp,

      // Returns (multiple timeframes)
      return1h: calculateReturn(candles, 1),
      return4h: calculateReturn(candles, 4),
      return24h: calculateReturn(candles, 24),
      return7d: calculateReturn(candles, 168),  // 7 days if 1h candles

      // Volatility metrics
      volatility24h: calculateRealizedVolatility(candles, 24),
      volatility7d: calculateRealizedVolatility(candles, 168),
      atr: calculateATR(candles, 14),

      // Volume metrics
      volumeZScore: calculateVolumeZScore(candles, 24),
      avgVolume24h: candles.slice(-24).reduce((sum, c) => sum + c.volume, 0) / 24,
      volumeRatio: latest.volume / (candles.slice(-24).reduce((sum, c) => sum + c.volume, 0) / 24),

      // Price metrics
      vwap24h: calculateVWAP(candles, 24),
      momentum14: calculateMomentum(candles, 14),

      // Market regime
      marketRegime: determineMarketRegime(candles),

      // Metadata
      interval,
      candlesUsed: candles.length,
      computedAt: new Date().toISOString()
    };

    logger.debug('Features computed', {
      assetId,
      price: features.price,
      return24h: features.return24h.toFixed(2),
      volatility: features.volatility24h.toFixed(2),
      regime: features.marketRegime
    });

    return features;

  } catch (error) {
    logger.error('Feature computation failed', { assetId, error: error.message });
    return null;
  }
}

/**
 * Get features for an asset (with caching)
 * @param {string} assetId - CoinGecko asset ID
 * @param {string} interval - Candle interval
 * @param {boolean} forceRefresh - Force recompute even if cached
 * @returns {Promise<Object>} Features object
 */
async function getFeatures(assetId, interval = '1h', forceRefresh = false) {
  const cacheKey = `${assetId}-${interval}`;
  const cached = featureCache.get(cacheKey);

  // Return cached if fresh
  if (!forceRefresh && cached && (Date.now() - cached.timestamp) < FEATURE_TTL) {
    return cached.features;
  }

  // Compute fresh features
  const features = await computeFeatures(assetId, interval);

  if (features) {
    featureCache.set(cacheKey, {
      features,
      timestamp: Date.now()
    });
  }

  return features;
}

/**
 * Get features for multiple assets in parallel
 * @param {Array<string>} assetIds - Array of CoinGecko asset IDs
 * @param {string} interval - Candle interval
 * @returns {Promise<Object>} Map of assetId → features
 */
async function getFeaturesForAssets(assetIds, interval = '1h') {
  const promises = assetIds.map(id =>
    getFeatures(id, interval).catch(err => {
      logger.error('Feature fetch failed for asset', { assetId: id, error: err.message });
      return null;
    })
  );

  const results = await Promise.all(promises);

  const featureMap = {};
  assetIds.forEach((id, i) => {
    if (results[i]) {
      featureMap[id] = results[i];
    }
  });

  return featureMap;
}

/**
 * Clear feature cache (useful for forced refresh)
 */
function clearCache() {
  const size = featureCache.size;
  featureCache.clear();
  logger.info('Feature cache cleared', { entriesCleared: size });
}

/**
 * Get cache statistics
 * @returns {Object} Cache stats
 */
function getCacheStats() {
  const entries = [];
  const now = Date.now();

  for (const [key, value] of featureCache.entries()) {
    entries.push({
      key,
      age: now - value.timestamp,
      fresh: (now - value.timestamp) < FEATURE_TTL
    });
  }

  return {
    size: featureCache.size,
    ttl: FEATURE_TTL,
    entries: entries.length,
    fresh: entries.filter(e => e.fresh).length,
    stale: entries.filter(e => !e.fresh).length
  };
}

module.exports = {
  computeFeatures,
  getFeatures,
  getFeaturesForAssets,
  clearCache,
  getCacheStats,

  // Individual feature calculators (for testing/custom use)
  calculateReturn,
  calculateRealizedVolatility,
  calculateVolumeZScore,
  calculateATR,
  calculateMomentum,
  calculateVWAP,
  determineMarketRegime
};
