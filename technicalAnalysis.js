// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - TECHNICAL ANALYSIS ENGINE v3.0 (PROFESSIONAL)
// Multi-timeframe strategy with trend detection, divergences, and smart scoring
// Phase 0: Hardened with structured logging and error taxonomy
// Phase 1: Real OHLCV candles from Binance for precision
// Phase 3: Complete signal engine rewrite - professional strategy
// ═══════════════════════════════════════════════════════════════════════════════

const axios = require('axios');
const { logger } = require('./logger');
const { classifyAxiosError, Provider } = require('./errors');
const { fetchOHLCVForAsset } = require('./binanceAPI');

// Reusable HTTP client with proper headers and timeout
const apiClient = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'SentixPro/3.0 (Trading Dashboard)',
    'Accept': 'application/json'
  }
});

// In-memory cache for historical data (avoids repeated API calls)
const historicalCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_ENTRIES = 100;

// LRU eviction: remove oldest entries when cache exceeds MAX_CACHE_ENTRIES
function cacheSet(key, value) {
  historicalCache.set(key, value);
  if (historicalCache.size > MAX_CACHE_ENTRIES) {
    // Map iterates in insertion order; delete oldest entries
    const keysToDelete = [];
    for (const [k] of historicalCache) {
      keysToDelete.push(k);
      if (historicalCache.size - keysToDelete.length <= MAX_CACHE_ENTRIES) break;
    }
    for (const k of keysToDelete) historicalCache.delete(k);
  }
}

// CoinCap ID mapping for fallback
const COINCAP_HISTORY_IDS = {
  bitcoin: 'bitcoin', ethereum: 'ethereum', binancecoin: 'binance-coin',
  solana: 'solana', cardano: 'cardano', ripple: 'xrp',
  polkadot: 'polkadot', dogecoin: 'dogecoin', 'avalanche-2': 'avalanche',
  chainlink: 'chainlink', 'pax-gold': 'pax-gold'
};

// ═══════════════════════════════════════════════════════════════════════════════
// DATA FETCHING
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchHistoricalData(coinId, days = 30) {
  const cacheKey = `${coinId}-${days}`;
  const cached = historicalCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
    return cached.data;
  }

  let result = [];

  try {
    const response = await apiClient.get(
      `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart`,
      {
        params: { vs_currency: 'usd', days, interval: 'daily' },
        timeout: 12000
      }
    );

    const prices = response.data.prices || [];
    const volumes = response.data.total_volumes || [];

    result = prices.map((priceData, i) => ({
      timestamp: priceData[0],
      price: priceData[1],
      volume: volumes[i] ? volumes[i][1] : 0
    }));
  } catch (error) {
    logger.providerError(classifyAxiosError(error, Provider.COINGECKO, `market_chart/${coinId}`));
  }

  if (result.length === 0) {
    try {
      const coincapId = COINCAP_HISTORY_IDS[coinId] || coinId;
      const end = Date.now();
      const start = end - (days * 24 * 60 * 60 * 1000);
      const interval = days <= 7 ? 'h1' : 'd1';

      const response = await apiClient.get(
        `https://api.coincap.io/v2/assets/${coincapId}/history`,
        { params: { interval, start, end }, timeout: 10000 }
      );

      result = (response.data.data || []).map(d => ({
        timestamp: d.time,
        price: parseFloat(d.priceUsd) || 0,
        volume: 0
      }));

      if (result.length > 0) {
        logger.info('CoinCap historical fallback OK', { coinId, dataPoints: result.length });
      }
    } catch (fallbackError) {
      logger.providerError(classifyAxiosError(fallbackError, Provider.COINCAP, `history/${coinId}`));
    }
  }

  if (result.length > 0) {
    cacheSet(cacheKey, { data: result, ts: Date.now() });
  } else if (cached) {
    const staleMins = Math.round((Date.now() - cached.ts) / 60000);
    logger.warn('Using stale historical cache', { coinId, staleMinutes: staleMins });
    return cached.data;
  }

  return result;
}

async function fetchOHLCVCandles(coinId, interval = '1h', limit = 100) {
  const cacheKey = `ohlcv-${coinId}-${interval}-${limit}`;
  const cached = historicalCache.get(cacheKey);

  const cacheTTL = interval.includes('m') ? 60 * 1000 : (interval === '1h' ? 5 * 60 * 1000 : CACHE_TTL);

  if (cached && (Date.now() - cached.ts) < cacheTTL) {
    return cached.data;
  }

  let candles = [];

  try {
    candles = await fetchOHLCVForAsset(coinId, interval, limit);
    if (candles.length > 0) {
      cacheSet(cacheKey, { data: candles, ts: Date.now() });
      return candles;
    }
  } catch (error) {
    logger.warn('Binance OHLCV failed', { coinId, error: error.message });
  }

  // FIX: Prefer stale cache (real OHLCV data) over fabricated data.
  // Stale cache has real high/low/volume from Binance — far better than synthetic candles.
  if (cached) {
    const staleMins = Math.round((Date.now() - cached.ts) / 60000);
    const MAX_STALE_MINUTES = 30;
    if (staleMins <= MAX_STALE_MINUTES) {
      logger.warn('Using stale OHLCV cache (real data)', { coinId, staleMinutes: staleMins });
      return cached.data;
    }
    // Even beyond max stale, real data is better than fabricated
    logger.warn('Using very stale OHLCV cache (real data preferred over synthetic)', { coinId, staleMinutes: staleMins });
    return cached.data;
  }

  // No cache available — log error and return empty.
  // Returning empty is safer than fabricating fake OHLCV data, which produces
  // misleading ATR, ADX, Bollinger, and S/R calculations.
  logger.error('No OHLCV data available (no cache, Binance down)', { coinId, interval });
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE INDICATORS
// ═══════════════════════════════════════════════════════════════════════════════

function calculateSMA(data, period) {
  if (data.length < period) return [];
  const sma = [];
  for (let i = period - 1; i < data.length; i++) {
    const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    sma.push(sum / period);
  }
  return sma;
}

function calculateEMA(data, period) {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const ema = [];
  const firstSMA = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  ema.push(firstSMA);
  for (let i = period; i < data.length; i++) {
    ema.push(data[i] * k + ema[ema.length - 1] * (1 - k));
  }
  return ema;
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;

  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? Math.abs(c) : 0);

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Calculate RSI series (returns array of RSI values for divergence detection)
 */
function calculateRSISeries(prices, period = 14) {
  if (prices.length < period + 1) return [];

  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? Math.abs(c) : 0);

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const rsiSeries = [];
  if (avgLoss === 0) {
    rsiSeries.push(100);
  } else {
    rsiSeries.push(100 - (100 / (1 + avgGain / avgLoss)));
  }

  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    if (avgLoss === 0) {
      rsiSeries.push(100);
    } else {
      rsiSeries.push(100 - (100 / (1 + avgGain / avgLoss)));
    }
  }

  return rsiSeries;
}

function calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (prices.length < slowPeriod) {
    return { macd: 0, signal: 0, histogram: 0, histogramSeries: [] };
  }

  const fastEMA = calculateEMA(prices, fastPeriod);
  const slowEMA = calculateEMA(prices, slowPeriod);

  const macdLine = [];
  const offset = slowPeriod - fastPeriod;
  for (let i = 0; i < slowEMA.length; i++) {
    macdLine.push(fastEMA[i + offset] - slowEMA[i]);
  }

  const signalLine = calculateEMA(macdLine, signalPeriod);

  // Build histogram series for divergence detection
  const histogramSeries = [];
  const sigOffset = macdLine.length - signalLine.length;
  for (let i = 0; i < signalLine.length; i++) {
    histogramSeries.push(macdLine[i + sigOffset] - signalLine[i]);
  }

  const currentMACD = macdLine[macdLine.length - 1] || 0;
  const currentSignal = signalLine[signalLine.length - 1] || 0;

  return {
    macd: currentMACD,
    signal: currentSignal,
    histogram: currentMACD - currentSignal,
    histogramSeries,
    // Detect if histogram is growing or shrinking (momentum direction)
    histogramTrend: histogramSeries.length >= 3
      ? (histogramSeries[histogramSeries.length - 1] > histogramSeries[histogramSeries.length - 3] ? 'growing' : 'shrinking')
      : 'neutral'
  };
}

function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  if (prices.length < period) {
    const price = prices[prices.length - 1] || 0;
    return { upper: price, middle: price, lower: price, bandwidth: 0, percentB: 0.5 };
  }

  const sma = calculateSMA(prices, period);
  const currentSMA = sma[sma.length - 1];

  const recentPrices = prices.slice(-period);
  const variance = recentPrices.reduce((sum, price) => {
    return sum + Math.pow(price - currentSMA, 2);
  }, 0) / period;

  const standardDeviation = Math.sqrt(variance);
  const upper = currentSMA + (stdDev * standardDeviation);
  const lower = currentSMA - (stdDev * standardDeviation);
  const bandwidth = ((upper - lower) / currentSMA) * 100;
  const currentPrice = prices[prices.length - 1];
  const percentB = (upper - lower) > 0 ? (currentPrice - lower) / (upper - lower) : 0.5;

  return { upper, middle: currentSMA, lower, bandwidth, percentB };
}

function calculateSupportResistance(historicalData) {
  if (historicalData.length < 3) {
    const price = historicalData[historicalData.length - 1]?.price || historicalData[historicalData.length - 1]?.close || 0;
    return { support: price * 0.95, resistance: price * 1.05 };
  }

  const prices = historicalData.map(d => d.price || d.close);
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const close = prices[prices.length - 1];

  const pivot = (high + low + close) / 3;

  return {
    support: (2 * pivot) - high,
    resistance: (2 * pivot) - low,
    pivot
  };
}

/**
 * Find multi-level support and resistance zones from OHLCV candles.
 * Uses swing high/low detection + classic pivot extensions + level clustering.
 *
 * @param {Array} candles - OHLCV candles array with { high, low, close, timestamp }
 * @param {number} currentPrice - Current market price
 * @param {Object} cfg - Strategy config
 * @returns {Object} { supports[], resistances[], pivot, nearestSupport, nearestResistance }
 */
function findMultiLevelSR(candles, currentPrice, cfg = {}) {
  const clusterThreshold = cfg.srClusterThreshold || 0.008;
  const swingLookback = cfg.srSwingLookback || 5;
  const maxLevels = cfg.srMaxLevels || 3;

  // Fallback for insufficient data
  if (!candles || candles.length < swingLookback * 2 + 1) {
    const high = candles && candles.length > 0 ? Math.max(...candles.map(d => d.high)) : currentPrice * 1.05;
    const low = candles && candles.length > 0 ? Math.min(...candles.map(d => d.low)) : currentPrice * 0.95;
    const close = candles && candles.length > 0 ? candles[candles.length - 1].close : currentPrice;
    const pivot = (high + low + close) / 3;
    const s1 = (2 * pivot) - high;
    const r1 = (2 * pivot) - low;
    return {
      supports: [{ price: s1, strength: 1, touches: 1, distancePercent: currentPrice > 0 ? ((currentPrice - s1) / currentPrice) * 100 : 0 }],
      resistances: [{ price: r1, strength: 1, touches: 1, distancePercent: currentPrice > 0 ? ((r1 - currentPrice) / currentPrice) * 100 : 0 }],
      pivot,
      nearestSupport: s1,
      nearestResistance: r1
    };
  }

  // ── Phase A: Detect swing highs and swing lows ──
  const swingHighs = [];
  const swingLows = [];
  for (let i = swingLookback; i < candles.length - swingLookback; i++) {
    let isSwingHigh = true;
    let isSwingLow = true;
    for (let j = 1; j <= swingLookback; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
        isSwingHigh = false;
      }
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) {
        isSwingLow = false;
      }
    }
    if (isSwingHigh) swingHighs.push(candles[i].high);
    if (isSwingLow) swingLows.push(candles[i].low);
  }

  // ── Phase B: Classic pivot levels as additional candidates ──
  const recentCandles = candles.slice(-30);
  const high = Math.max(...recentCandles.map(d => d.high));
  const low = Math.min(...recentCandles.map(d => d.low));
  const close = candles[candles.length - 1].close;
  const pivot = (high + low + close) / 3;
  const range = high - low;

  const pivotR1 = (2 * pivot) - low;
  const pivotR2 = pivot + range;
  const pivotR3 = high + 2 * (pivot - low);
  const pivotS1 = (2 * pivot) - high;
  const pivotS2 = pivot - range;
  const pivotS3 = low - 2 * (high - pivot);

  // ── Phase C: Combine candidates and filter by side ──
  const allResistanceCandidates = [...swingHighs, pivotR1, pivotR2, pivotR3]
    .filter(p => p > currentPrice && isFinite(p));
  const allSupportCandidates = [...swingLows, pivotS1, pivotS2, pivotS3]
    .filter(p => p < currentPrice && p > 0 && isFinite(p));

  // ── Phase D: Cluster nearby levels ──
  function clusterLevels(candidates) {
    if (candidates.length === 0) return [];
    const sorted = [...candidates].sort((a, b) => a - b);
    const clusters = [];
    let currentCluster = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const clusterAvg = currentCluster.reduce((s, v) => s + v, 0) / currentCluster.length;
      if (Math.abs(sorted[i] - clusterAvg) / clusterAvg < clusterThreshold) {
        currentCluster.push(sorted[i]);
      } else {
        clusters.push(currentCluster);
        currentCluster = [sorted[i]];
      }
    }
    clusters.push(currentCluster);

    return clusters.map(cluster => {
      const avgPrice = cluster.reduce((s, v) => s + v, 0) / cluster.length;
      const touches = cluster.length;
      const strength = Math.min(5, touches);
      return { price: parseFloat(avgPrice.toFixed(8)), strength, touches };
    });
  }

  // ── Phase E: Sort by distance, take maxLevels ──
  const supports = clusterLevels(allSupportCandidates)
    .sort((a, b) => b.price - a.price) // closest to current price first
    .slice(0, maxLevels)
    .map(level => ({
      ...level,
      distancePercent: parseFloat(((currentPrice - level.price) / currentPrice * 100).toFixed(2))
    }));

  const resistances = clusterLevels(allResistanceCandidates)
    .sort((a, b) => a.price - b.price) // closest to current price first
    .slice(0, maxLevels)
    .map(level => ({
      ...level,
      distancePercent: parseFloat(((level.price - currentPrice) / currentPrice * 100).toFixed(2))
    }));

  return {
    supports,
    resistances,
    pivot,
    nearestSupport: supports[0]?.price || pivotS1,
    nearestResistance: resistances[0]?.price || pivotR1
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADVANCED INDICATORS (NEW)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate ADX (Average Directional Index) - trend strength indicator
 * ADX > 25 = strong trend, < 20 = weak/no trend
 * +DI > -DI = uptrend, -DI > +DI = downtrend
 */
function calculateADX(candles, period = 14) {
  if (candles.length < period + 2) return { adx: 0, plusDI: 0, minusDI: 0, trend: 'none' };

  const trueRanges = [];
  const plusDMs = [];
  const minusDMs = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;
    const prevClose = candles[i - 1].close;

    // True Range
    trueRanges.push(Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    ));

    // Directional Movement
    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  if (trueRanges.length < period) return { adx: 0, plusDI: 0, minusDI: 0, trend: 'none' };

  // Smoothed averages using Wilder's method
  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let smoothPlusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let smoothMinusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const dxValues = [];

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
    smoothPlusDM = (smoothPlusDM * (period - 1) + plusDMs[i]) / period;
    smoothMinusDM = (smoothMinusDM * (period - 1) + minusDMs[i]) / period;

    const plusDI = atr > 0 ? (smoothPlusDM / atr) * 100 : 0;
    const minusDI = atr > 0 ? (smoothMinusDM / atr) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;
    dxValues.push({ dx, plusDI, minusDI });
  }

  if (dxValues.length < period) return { adx: 0, plusDI: 0, minusDI: 0, trend: 'none' };

  // ADX = smoothed DX
  let adx = dxValues.slice(0, period).reduce((a, b) => a + b.dx, 0) / period;
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i].dx) / period;
  }

  const last = dxValues[dxValues.length - 1];

  let trend = 'ranging';
  if (adx >= 25) {
    trend = last.plusDI > last.minusDI ? 'strong_up' : 'strong_down';
  } else if (adx >= 20) {
    trend = last.plusDI > last.minusDI ? 'weak_up' : 'weak_down';
  }

  return {
    adx: Math.round(adx * 10) / 10,
    plusDI: Math.round(last.plusDI * 10) / 10,
    minusDI: Math.round(last.minusDI * 10) / 10,
    trend
  };
}

/**
 * Detect EMA crossover trend
 * Uses EMA 9/21/50 alignment for trend confirmation
 */
function detectEMATrend(prices) {
  if (prices.length < 50) return { trend: 'unknown', strength: 0 };

  const ema9 = calculateEMA(prices, 9);
  const ema21 = calculateEMA(prices, 21);
  const ema50 = calculateEMA(prices, 50);

  // Align arrays to the same length
  const len = Math.min(ema9.length, ema21.length, ema50.length);
  const e9 = ema9[ema9.length - 1];
  const e21 = ema21[ema21.length - 1];
  const e50 = ema50[ema50.length - 1];
  const currentPrice = prices[prices.length - 1];

  // Perfect alignment check
  if (currentPrice > e9 && e9 > e21 && e21 > e50) {
    // All aligned bullish
    const separation = ((e9 - e50) / e50) * 100;
    return { trend: 'strong_up', strength: Math.min(separation * 10, 100), ema9: e9, ema21: e21, ema50: e50 };
  }
  if (currentPrice < e9 && e9 < e21 && e21 < e50) {
    // All aligned bearish
    const separation = ((e50 - e9) / e50) * 100;
    return { trend: 'strong_down', strength: Math.min(separation * 10, 100), ema9: e9, ema21: e21, ema50: e50 };
  }
  if (currentPrice > e21 && e9 > e21) {
    return { trend: 'up', strength: 50, ema9: e9, ema21: e21, ema50: e50 };
  }
  if (currentPrice < e21 && e9 < e21) {
    return { trend: 'down', strength: 50, ema9: e9, ema21: e21, ema50: e50 };
  }

  return { trend: 'sideways', strength: 20, ema9: e9, ema21: e21, ema50: e50 };
}

/**
 * Detect RSI divergence (price vs RSI direction mismatch)
 * Bullish divergence: price makes lower low but RSI makes higher low
 * Bearish divergence: price makes higher high but RSI makes lower high
 */
function detectRSIDivergence(prices, rsiSeries, lookback = 20) {
  if (prices.length < lookback + 14 || rsiSeries.length < lookback) return { type: 'none' };

  // Align price and RSI arrays
  const priceWindow = prices.slice(-lookback);
  const rsiWindow = rsiSeries.slice(-lookback);

  // Find local lows/highs in price
  const priceLows = [];
  const priceHighs = [];
  for (let i = 2; i < priceWindow.length - 2; i++) {
    if (priceWindow[i] < priceWindow[i - 1] && priceWindow[i] < priceWindow[i - 2] &&
        priceWindow[i] < priceWindow[i + 1] && priceWindow[i] < priceWindow[i + 2]) {
      priceLows.push({ idx: i, price: priceWindow[i], rsi: rsiWindow[i] });
    }
    if (priceWindow[i] > priceWindow[i - 1] && priceWindow[i] > priceWindow[i - 2] &&
        priceWindow[i] > priceWindow[i + 1] && priceWindow[i] > priceWindow[i + 2]) {
      priceHighs.push({ idx: i, price: priceWindow[i], rsi: rsiWindow[i] });
    }
  }

  // Check for bullish divergence (price lower low, RSI higher low)
  if (priceLows.length >= 2) {
    const prev = priceLows[priceLows.length - 2];
    const curr = priceLows[priceLows.length - 1];
    if (curr.price < prev.price && curr.rsi > prev.rsi) {
      return { type: 'bullish', strength: Math.abs(curr.rsi - prev.rsi) };
    }
  }

  // Check for bearish divergence (price higher high, RSI lower high)
  if (priceHighs.length >= 2) {
    const prev = priceHighs[priceHighs.length - 2];
    const curr = priceHighs[priceHighs.length - 1];
    if (curr.price > prev.price && curr.rsi < prev.rsi) {
      return { type: 'bearish', strength: Math.abs(prev.rsi - curr.rsi) };
    }
  }

  return { type: 'none' };
}

/**
 * Calculate ATR for volatility-adjusted scoring
 */
function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;

  const recent = candles.slice(-period - 1);
  const trueRanges = [];

  for (let i = 1; i < recent.length; i++) {
    trueRanges.push(Math.max(
      recent[i].high - recent[i].low,
      Math.abs(recent[i].high - recent[i - 1].close),
      Math.abs(recent[i].low - recent[i - 1].close)
    ));
  }

  return trueRanges.reduce((sum, tr) => sum + tr, 0) / trueRanges.length;
}

/**
 * Volume profile analysis - is volume confirming the move?
 * Returns: 'confirming_up', 'confirming_down', 'diverging', 'neutral'
 */
function analyzeVolumeProfile(candles, lookback = 14) {
  if (candles.length < lookback + 1) return { profile: 'neutral', ratio: 1 };

  const recent = candles.slice(-lookback);
  const older = candles.slice(-lookback * 2, -lookback);

  if (older.length === 0) return { profile: 'neutral', ratio: 1 };

  const recentAvgVol = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  const olderAvgVol = older.reduce((s, c) => s + c.volume, 0) / older.length;

  const volRatio = olderAvgVol > 0 ? recentAvgVol / olderAvgVol : 1;

  // Price direction
  const priceChange = (recent[recent.length - 1].close - recent[0].close) / recent[0].close;

  // Up candle vs down candle volume
  let upVol = 0, downVol = 0, upCount = 0, downCount = 0;
  for (const c of recent) {
    if (c.close >= c.open) {
      upVol += c.volume;
      upCount++;
    } else {
      downVol += c.volume;
      downCount++;
    }
  }

  const buyPressure = (upVol + downVol) > 0 ? upVol / (upVol + downVol) : 0.5;

  let profile = 'neutral';
  if (priceChange > 0 && buyPressure > 0.55 && volRatio > 1.1) {
    profile = 'confirming_up';
  } else if (priceChange < 0 && buyPressure < 0.45 && volRatio > 1.1) {
    profile = 'confirming_down';
  } else if (priceChange > 0 && buyPressure < 0.45) {
    profile = 'diverging'; // Price up but selling volume dominates
  } else if (priceChange < 0 && buyPressure > 0.55) {
    profile = 'diverging'; // Price down but buying volume dominates
  }

  return { profile, ratio: volRatio, buyPressure: Math.round(buyPressure * 100) };
}

/**
 * Detect Bollinger Band squeeze (low volatility → imminent breakout)
 */
function detectBBSqueeze(prices, period = 20) {
  if (prices.length < period + 20) return { squeeze: false, direction: 'none' };

  // Calculate bandwidth over time
  const bandwidths = [];
  for (let i = period; i <= prices.length; i++) {
    const slice = prices.slice(i - period, i);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, p) => sum + Math.pow(p - sma, 2), 0) / period;
    const std = Math.sqrt(variance);
    bandwidths.push(((sma + 2 * std) - (sma - 2 * std)) / sma * 100);
  }

  if (bandwidths.length < 10) return { squeeze: false, direction: 'none' };

  const currentBW = bandwidths[bandwidths.length - 1];
  const avgBW = bandwidths.slice(-20).reduce((a, b) => a + b, 0) / Math.min(bandwidths.length, 20);

  // Squeeze = bandwidth significantly below average
  const squeeze = currentBW < avgBW * 0.7;

  // Direction hint from price momentum
  const recentPrices = prices.slice(-5);
  const direction = recentPrices[recentPrices.length - 1] > recentPrices[0] ? 'up' : 'down';

  return { squeeze, direction, bandwidth: currentBW, avgBandwidth: avgBW };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ICHIMOKU CLOUD
// Tenkan-sen, Kijun-sen, Senkou Span A/B, Cloud position
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate Ichimoku Cloud components and generate signal
 * @param {Array} candles - OHLCV data [{high, low, close, ...}]
 * @param {Object} cfg - Strategy config with ichimoku* keys
 * @returns {Object} Ichimoku analysis
 */
function calculateIchimoku(candles, cfg = {}) {
  const tenkanPeriod = cfg.ichimokuTenkanPeriod || 9;
  const kijunPeriod = cfg.ichimokuKijunPeriod || 26;
  const senkouBPeriod = cfg.ichimokuSenkouBPeriod || 52;

  const insufficient = {
    tenkan: 0, kijun: 0, senkouA: 0, senkouB: 0,
    cloudTop: 0, cloudBottom: 0,
    priceVsCloud: 'unknown', tkCross: 'none',
    cloudColor: 'neutral', signal: 'insufficient_data'
  };

  if (!candles || candles.length < senkouBPeriod + 1) return insufficient;

  // Midpoint helper: (highest high + lowest low) / 2 over period
  const midpoint = (data, end, period) => {
    const slice = data.slice(Math.max(0, end - period), end);
    if (slice.length === 0) return 0;
    let hi = -Infinity, lo = Infinity;
    for (const c of slice) {
      if (c.high > hi) hi = c.high;
      if (c.low < lo) lo = c.low;
    }
    return (hi + lo) / 2;
  };

  const len = candles.length;
  const tenkan = midpoint(candles, len, tenkanPeriod);
  const kijun = midpoint(candles, len, kijunPeriod);

  // Previous values for TK cross detection
  const prevTenkan = midpoint(candles, len - 1, tenkanPeriod);
  const prevKijun = midpoint(candles, len - 1, kijunPeriod);

  // Senkou A = (tenkan + kijun) / 2 projected 26 bars ahead (use current for scoring)
  const senkouA = (tenkan + kijun) / 2;

  // Senkou B = midpoint of senkouBPeriod, projected 26 bars ahead
  const senkouB = midpoint(candles, len, senkouBPeriod);

  const cloudTop = Math.max(senkouA, senkouB);
  const cloudBottom = Math.min(senkouA, senkouB);

  const currentPrice = candles[len - 1].close;

  // Price vs Cloud
  let priceVsCloud = 'inside';
  if (currentPrice > cloudTop) priceVsCloud = 'above';
  else if (currentPrice < cloudBottom) priceVsCloud = 'below';

  // TK Cross: Tenkan crosses above/below Kijun
  let tkCross = 'none';
  if (prevTenkan <= prevKijun && tenkan > kijun) tkCross = 'bullish';
  else if (prevTenkan >= prevKijun && tenkan < kijun) tkCross = 'bearish';

  // Cloud color: bullish if senkouA > senkouB
  let cloudColor = 'neutral';
  if (senkouA > senkouB) cloudColor = 'bullish';
  else if (senkouA < senkouB) cloudColor = 'bearish';

  // Overall signal
  let signal = 'neutral';
  if (priceVsCloud === 'above') signal = 'bullish';
  else if (priceVsCloud === 'below') signal = 'bearish';

  return {
    tenkan: +tenkan.toFixed(2),
    kijun: +kijun.toFixed(2),
    senkouA: +senkouA.toFixed(2),
    senkouB: +senkouB.toFixed(2),
    cloudTop: +cloudTop.toFixed(2),
    cloudBottom: +cloudBottom.toFixed(2),
    priceVsCloud,
    tkCross,
    cloudColor,
    signal
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// VWAP (Volume-Weighted Average Price)
// Session VWAP with standard deviation bands
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate VWAP and standard deviation bands
 * @param {Array} candles - OHLCV data [{high, low, close, volume, ...}]
 * @param {number} sessionLength - Number of candles for VWAP session
 * @returns {Object} VWAP analysis
 */
function calculateVWAP(candles, sessionLength = 24) {
  const insufficient = {
    vwap: 0, upperBand1: 0, lowerBand1: 0, upperBand2: 0, lowerBand2: 0,
    priceVsVwap: 'unknown', distancePercent: 0, signal: 'insufficient_data'
  };

  if (!candles || candles.length < 5) return insufficient;

  const session = candles.slice(-Math.min(sessionLength, candles.length));

  let cumTPV = 0; // cumulative TP * Volume
  let cumVol = 0; // cumulative Volume

  const tpArray = [];

  for (const c of session) {
    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 0;
    cumTPV += tp * vol;
    cumVol += vol;
    tpArray.push(tp);
  }

  // Fallback if zero volume
  if (cumVol === 0) {
    const avgTP = tpArray.reduce((a, b) => a + b, 0) / tpArray.length;
    return { ...insufficient, vwap: +avgTP.toFixed(2), signal: 'insufficient_data' };
  }

  const vwap = cumTPV / cumVol;

  // Standard deviation of TP from VWAP, weighted by volume
  let cumWeightedVar = 0;
  let cumVolForVar = 0;
  for (const c of session) {
    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 0;
    cumWeightedVar += vol * Math.pow(tp - vwap, 2);
    cumVolForVar += vol;
  }

  const stdDev = cumVolForVar > 0 ? Math.sqrt(cumWeightedVar / cumVolForVar) : 0;

  const upperBand1 = vwap + stdDev;
  const lowerBand1 = vwap - stdDev;
  const upperBand2 = vwap + 2 * stdDev;
  const lowerBand2 = vwap - 2 * stdDev;

  const currentPrice = candles[candles.length - 1].close;
  const distancePercent = vwap > 0 ? ((currentPrice - vwap) / vwap) * 100 : 0;

  // Price position vs VWAP
  let priceVsVwap = 'at_vwap';
  if (currentPrice > upperBand2) priceVsVwap = 'above_2sigma';
  else if (currentPrice > upperBand1) priceVsVwap = 'above';
  else if (currentPrice < lowerBand2) priceVsVwap = 'below_2sigma';
  else if (currentPrice < lowerBand1) priceVsVwap = 'below';

  // Signal
  let signal = 'neutral';
  if (priceVsVwap === 'above_2sigma') signal = 'overbought';
  else if (priceVsVwap === 'above') signal = 'bullish';
  else if (priceVsVwap === 'below') signal = 'bearish';
  else if (priceVsVwap === 'below_2sigma') signal = 'oversold';

  return {
    vwap: +vwap.toFixed(2),
    upperBand1: +upperBand1.toFixed(2),
    lowerBand1: +lowerBand1.toFixed(2),
    upperBand2: +upperBand2.toFixed(2),
    lowerBand2: +lowerBand2.toFixed(2),
    priceVsVwap,
    distancePercent: +distancePercent.toFixed(2),
    signal
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIBONACCI RETRACEMENT
// Swing high/low detection + 7 Fibonacci levels
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate Fibonacci retracement levels from recent swing high/low
 * @param {Array} candles - OHLCV data [{high, low, close, ...}]
 * @param {number} lookback - Number of candles to find swing high/low
 * @param {number} currentPrice - Current market price
 * @returns {Object} Fibonacci analysis
 */
function calculateFibonacciRetracement(candles, lookback = 50, currentPrice = 0) {
  const insufficient = {
    swingHigh: 0, swingLow: 0, levels: [],
    trendDirection: 'unknown', nearestLevel: null, nearestRatio: 0,
    distanceToNearest: Infinity, goldenRatio: false,
    signal: 'insufficient_data'
  };

  if (!candles || candles.length < 10) return insufficient;

  const slice = candles.slice(-Math.min(lookback, candles.length));
  if (currentPrice <= 0) currentPrice = slice[slice.length - 1].close;

  // Find swing high and swing low with their indices
  let swingHigh = -Infinity, swingLow = Infinity;
  let swingHighIdx = 0, swingLowIdx = 0;
  for (let i = 0; i < slice.length; i++) {
    if (slice[i].high > swingHigh) { swingHigh = slice[i].high; swingHighIdx = i; }
    if (slice[i].low < swingLow) { swingLow = slice[i].low; swingLowIdx = i; }
  }

  const range = swingHigh - swingLow;
  if (range <= 0) return insufficient;

  // Trend direction: if high came after low → uptrend, else downtrend
  let trendDirection = 'unknown';
  if (swingHighIdx > swingLowIdx) trendDirection = 'uptrend';
  else if (swingLowIdx > swingHighIdx) trendDirection = 'downtrend';

  // 7 standard Fibonacci levels
  const ratios = [
    { ratio: 0, label: '0%' },
    { ratio: 0.236, label: '23.6%' },
    { ratio: 0.382, label: '38.2%' },
    { ratio: 0.5, label: '50%' },
    { ratio: 0.618, label: '61.8%' },
    { ratio: 0.786, label: '78.6%' },
    { ratio: 1, label: '100%' }
  ];

  // In uptrend: levels go from high down; in downtrend: levels go from low up
  const levels = ratios.map(r => ({
    ratio: r.ratio,
    price: +(swingHigh - r.ratio * range).toFixed(2),
    label: r.label
  }));

  // Find nearest level to current price
  let nearestLevel = null;
  let nearestRatio = 0;
  let distanceToNearest = Infinity;
  for (const level of levels) {
    const dist = Math.abs(currentPrice - level.price);
    if (dist < distanceToNearest) {
      distanceToNearest = dist;
      nearestLevel = level;
      nearestRatio = level.ratio;
    }
  }

  const distancePercent = currentPrice > 0 ? (distanceToNearest / currentPrice) * 100 : Infinity;
  const goldenRatio = nearestRatio === 0.618 || nearestRatio === 0.382;

  // Signal: price near key retracement in uptrend = bullish dip buy
  let signal = 'neutral';
  if (distancePercent < 2) {
    if (trendDirection === 'uptrend' && (nearestRatio === 0.382 || nearestRatio === 0.5 || nearestRatio === 0.618)) {
      signal = 'bullish_retracement';
    } else if (trendDirection === 'downtrend' && (nearestRatio === 0.382 || nearestRatio === 0.5 || nearestRatio === 0.618)) {
      signal = 'bearish_retracement';
    }
  }

  return {
    swingHigh, swingLow, levels,
    trendDirection,
    nearestLevel,
    nearestRatio,
    distanceToNearest: +distancePercent.toFixed(2),
    goldenRatio,
    signal
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARKET STRUCTURE ANALYSIS
// HH/HL (bullish) vs LH/LL (bearish), BOS, CHoCH
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Analyze market structure: swing points, HH/HL/LH/LL patterns, BOS, CHoCH
 * @param {Array} candles - OHLCV data [{high, low, close, ...}]
 * @param {Object} cfg - Strategy config with marketStructure* keys
 * @returns {Object} Market structure analysis
 */
function analyzeMarketStructure(candles, cfg = {}) {
  const lookback = cfg.marketStructureLookback || 60;
  const minSwings = cfg.marketStructureMinSwings || 4;

  const insufficient = {
    structure: 'unknown', swingPoints: [], pattern: 'unknown',
    breakOfStructure: { detected: false, direction: null, price: null },
    changeOfCharacter: { detected: false, direction: null, price: null },
    signal: 'insufficient_data'
  };

  if (!candles || candles.length < 20) return insufficient;

  const slice = candles.slice(-Math.min(lookback, candles.length));

  // Detect swing highs and lows (3-bar pivot: higher/lower than neighbors)
  const swingPoints = [];
  for (let i = 1; i < slice.length - 1; i++) {
    if (slice[i].high > slice[i - 1].high && slice[i].high > slice[i + 1].high) {
      swingPoints.push({ type: 'high', price: slice[i].high, index: i });
    }
    if (slice[i].low < slice[i - 1].low && slice[i].low < slice[i + 1].low) {
      swingPoints.push({ type: 'low', price: slice[i].low, index: i });
    }
  }

  if (swingPoints.length < minSwings) return { ...insufficient, swingPoints };

  // Separate swing highs and lows in order
  const swingHighs = swingPoints.filter(p => p.type === 'high');
  const swingLows = swingPoints.filter(p => p.type === 'low');

  if (swingHighs.length < 2 || swingLows.length < 2) return { ...insufficient, swingPoints };

  // Classify recent swing relationships
  const lastHighs = swingHighs.slice(-3);
  const lastLows = swingLows.slice(-3);

  let hhCount = 0, llCount = 0, lhCount = 0, hlCount = 0;

  for (let i = 1; i < lastHighs.length; i++) {
    if (lastHighs[i].price > lastHighs[i - 1].price) hhCount++;
    else lhCount++;
  }
  for (let i = 1; i < lastLows.length; i++) {
    if (lastLows[i].price > lastLows[i - 1].price) hlCount++;
    else llCount++;
  }

  // Pattern classification
  let pattern = 'mixed';
  let structure = 'ranging';

  if (hhCount > 0 && hlCount > 0 && lhCount === 0 && llCount === 0) {
    pattern = 'HH_HL';
    structure = 'bullish';
  } else if (lhCount > 0 && llCount > 0 && hhCount === 0 && hlCount === 0) {
    pattern = 'LH_LL';
    structure = 'bearish';
  } else if (hhCount > lhCount && hlCount > llCount) {
    pattern = 'HH_HL';
    structure = 'bullish';
  } else if (lhCount > hhCount && llCount > hlCount) {
    pattern = 'LH_LL';
    structure = 'bearish';
  }

  // Break of Structure (BOS): price breaks the last swing high/low in trend direction
  const currentPrice = slice[slice.length - 1].close;
  const lastSwingHigh = swingHighs[swingHighs.length - 1];
  const lastSwingLow = swingLows[swingLows.length - 1];

  let breakOfStructure = { detected: false, direction: null, price: null };
  if (structure === 'bullish' && currentPrice > lastSwingHigh.price) {
    breakOfStructure = { detected: true, direction: 'bullish', price: lastSwingHigh.price };
  } else if (structure === 'bearish' && currentPrice < lastSwingLow.price) {
    breakOfStructure = { detected: true, direction: 'bearish', price: lastSwingLow.price };
  }

  // Change of Character (CHoCH): price breaks against the trend
  let changeOfCharacter = { detected: false, direction: null, price: null };
  if (structure === 'bullish' && currentPrice < lastSwingLow.price) {
    changeOfCharacter = { detected: true, direction: 'bearish', price: lastSwingLow.price };
  } else if (structure === 'bearish' && currentPrice > lastSwingHigh.price) {
    changeOfCharacter = { detected: true, direction: 'bullish', price: lastSwingHigh.price };
  }

  // Signal
  let signal = 'neutral';
  if (changeOfCharacter.detected) {
    signal = changeOfCharacter.direction === 'bullish' ? 'bullish_reversal' : 'bearish_reversal';
  } else if (breakOfStructure.detected) {
    signal = breakOfStructure.direction;
  } else if (structure === 'bullish') {
    signal = 'bullish';
  } else if (structure === 'bearish') {
    signal = 'bearish';
  }

  return {
    structure,
    swingPoints,
    pattern,
    breakOfStructure,
    changeOfCharacter,
    signal
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE LEVEL CALCULATOR
// Entry, Stop-Loss, Take-Profit, and Risk/Reward Ratio
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate trade entry, stop-loss, and take-profit levels using S/R + ATR
 * @param {string} action - 'BUY', 'SELL', or 'HOLD'
 * @param {number} currentPrice - Current market price
 * @param {number} support - Calculated support level
 * @param {number} resistance - Calculated resistance level
 * @param {number} pivot - Pivot point
 * @param {number} atr - Average True Range value
 * @returns {Object|null} tradeLevels object or null if HOLD
 */
function calculateTradeLevels(action, currentPrice, support, resistance, pivot, atr, tradeConfig = {}) {
  if (action === 'HOLD' || atr <= 0 || currentPrice <= 0) return null;

  // Trade level config with defaults matching original hardcoded values
  const slMult = tradeConfig.atrStopMult || 1.5;
  const tp2Mult = tradeConfig.atrTP2Mult || 2.0;
  const trailMult = tradeConfig.atrTrailingMult || 2.5;
  const trailActivation = tradeConfig.atrTrailingActivation || 1.0;
  const minRR = tradeConfig.minRiskReward || 1.5;
  const srLevels = tradeConfig.srLevels || null;

  let entry, stopLoss, takeProfit1, takeProfit2;

  if (action === 'BUY') {
    entry = currentPrice;
    // If price is near support, use support + small offset as entry
    if (Math.abs(currentPrice - support) / currentPrice < 0.02) {
      entry = support + (atr * 0.25);
    }
    if (srLevels && srLevels.resistances.length > 0) {
      takeProfit1 = srLevels.resistances[0]?.price || resistance;
      takeProfit2 = srLevels.resistances[1]?.price || (takeProfit1 + (atr * tp2Mult));
      stopLoss = (srLevels.supports[0]?.price || support) - (atr * slMult);
    } else {
      stopLoss = support - (atr * slMult);
      takeProfit1 = resistance;
      takeProfit2 = resistance + (atr * tp2Mult);
    }
  } else { // SELL
    entry = currentPrice;
    if (Math.abs(currentPrice - resistance) / currentPrice < 0.02) {
      entry = resistance - (atr * 0.25);
    }
    if (srLevels && srLevels.supports.length > 0) {
      takeProfit1 = srLevels.supports[0]?.price || support;
      takeProfit2 = srLevels.supports[1]?.price || (takeProfit1 - (atr * tp2Mult));
      stopLoss = (srLevels.resistances[0]?.price || resistance) + (atr * slMult);
    } else {
      stopLoss = resistance + (atr * slMult);
      takeProfit1 = support;
      takeProfit2 = support - (atr * tp2Mult);
    }
  }

  // Ensure stop-loss is positive
  stopLoss = Math.max(0.01, stopLoss);

  // ── Geometry validation ──────────────────────────────────────────────
  // For BUY: TP1 must be above entry, SL must be below entry
  // For SELL: TP1 must be below entry, SL must be above entry
  // If violated (price already past S/R), fall back to ATR-based targets
  if (action === 'BUY') {
    if (takeProfit1 <= entry) {
      takeProfit1 = entry + (atr * 2.0);  // ATR-based fallback
      takeProfit2 = entry + (atr * (2.0 + tp2Mult));
    }
    if (stopLoss >= entry) {
      stopLoss = entry - (atr * slMult);
    }
  } else {
    if (takeProfit1 >= entry) {
      takeProfit1 = entry - (atr * 2.0);  // ATR-based fallback
      takeProfit2 = entry - (atr * (2.0 + tp2Mult));
    }
    if (stopLoss <= entry) {
      stopLoss = entry + (atr * slMult);
    }
  }
  stopLoss = Math.max(0.01, stopLoss);
  takeProfit1 = Math.max(0.01, takeProfit1);
  takeProfit2 = Math.max(0.01, takeProfit2);

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit1 - entry);
  const riskRewardRatio = risk > 0 ? reward / risk : 0;

  const stopLossPercent = ((stopLoss - entry) / entry) * 100;
  const tp1Percent = ((takeProfit1 - entry) / entry) * 100;
  const tp2Percent = ((takeProfit2 - entry) / entry) * 100;

  // Trailing stop: wider than static SL to allow volatility, tightens as trade moves in profit
  let trailingStop, trailingActivationPrice;
  if (action === 'BUY') {
    trailingStop = entry - (atr * trailMult);
    trailingActivationPrice = entry + (atr * trailActivation);
  } else {
    trailingStop = entry + (atr * trailMult);
    trailingActivationPrice = entry - (atr * trailActivation);
  }
  trailingStop = Math.max(0.01, trailingStop);
  trailingActivationPrice = Math.max(0.01, trailingActivationPrice);

  const trailingStopPercent = ((trailingStop - entry) / entry) * 100;
  const trailingActivationPercent = ((trailingActivationPrice - entry) / entry) * 100;

  // Use appropriate decimal precision based on price magnitude
  const decimals = currentPrice > 100 ? 2 : currentPrice > 1 ? 4 : 6;
  const round = (v) => parseFloat(v.toFixed(decimals));

  return {
    entry: round(entry),
    stopLoss: round(stopLoss),
    stopLossPercent: Math.round(stopLossPercent * 100) / 100,
    takeProfit1: round(takeProfit1),
    takeProfit1Percent: Math.round(tp1Percent * 100) / 100,
    takeProfit2: round(takeProfit2),
    takeProfit2Percent: Math.round(tp2Percent * 100) / 100,
    trailingStop: round(trailingStop),
    trailingStopPercent: Math.round(trailingStopPercent * 100) / 100,
    trailingActivation: round(trailingActivationPrice),
    trailingActivationPercent: Math.round(trailingActivationPercent * 100) / 100,
    trailingStepATR: round(atr), // Each step = 1 ATR
    riskRewardRatio: Math.round(riskRewardRatio * 100) / 100,
    riskRewardOk: riskRewardRatio >= minRR,
    atrValue: round(atr),
    support: round(support),
    resistance: round(resistance),
    pivot: round(pivot)
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DERIVATIVES SCORING
// Funding Rate + Open Interest + Long/Short Ratio analysis
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Score derivatives data for signal modification
 * @param {Object|null} derivatives - From fetchDerivativesData()
 * @param {number} currentScore - Current raw score from technical analysis
 * @param {number} priceChange - Recent price change %
 * @returns {Object} { scoreModifier, confidenceModifier, signals[], sentiment }
 */
function scoreDerivatives(derivatives, currentScore, priceChange) {
  if (!derivatives) return { scoreModifier: 0, confidenceModifier: 0, signals: [], sentiment: 'unavailable' };

  let scoreModifier = 0;
  let confidenceModifier = 0;
  const signals = [];
  let sentiment = 'neutral';

  const fr = derivatives.fundingRatePercent || 0;
  const lsr = derivatives.longShortRatio || 1;

  // --- Funding Rate Analysis ---
  // Extreme positive = over-leveraged longs → contrarian bearish
  // Extreme negative = over-leveraged shorts → contrarian bullish
  if (fr > 0.1) {
    scoreModifier -= 15;
    confidenceModifier += 5;
    sentiment = 'over_leveraged_long';
    signals.push(`Extreme funding (+${fr.toFixed(3)}%) - crowded longs, reversal risk`);
  } else if (fr > 0.05) {
    scoreModifier -= 7;
    confidenceModifier += 3;
    sentiment = 'over_leveraged_long';
    signals.push(`High funding (+${fr.toFixed(3)}%) - longs paying shorts`);
  } else if (fr < -0.1) {
    scoreModifier += 15;
    confidenceModifier += 5;
    sentiment = 'over_leveraged_short';
    signals.push(`Extreme neg. funding (${fr.toFixed(3)}%) - crowded shorts, squeeze risk`);
  } else if (fr < -0.05) {
    scoreModifier += 7;
    confidenceModifier += 3;
    sentiment = 'over_leveraged_short';
    signals.push(`Neg. funding (${fr.toFixed(3)}%) - shorts paying longs`);
  }

  // --- Long/Short Ratio ---
  if (lsr > 2.0) {
    scoreModifier -= 5;
    signals.push(`L/S ratio crowded long (${lsr.toFixed(2)})`);
  } else if (lsr < 0.5) {
    scoreModifier += 5;
    signals.push(`L/S ratio lean short (${lsr.toFixed(2)})`);
  }

  // --- OI + Price Direction (trend health) ---
  if (priceChange > 2 && derivatives.openInterest > 0) {
    confidenceModifier += 5;
    signals.push('Rising price + OI confirms trend');
  } else if (priceChange < -2 && derivatives.openInterest > 0) {
    confidenceModifier -= 3;
    signals.push('Falling price with high OI - liquidation risk');
  }

  // Default sentiment from L/S ratio if not set by funding
  if (sentiment === 'neutral') {
    if (lsr > 1.5) sentiment = 'over_leveraged_long';
    else if (lsr < 0.67) sentiment = 'over_leveraged_short';
  }

  return { scoreModifier, confidenceModifier, signals, sentiment };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MACRO CONTEXT SCORING
// BTC Dominance correlation + DXY regime for macro-aware signals
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Score BTC dominance impact on altcoins.
 * Rising BTC dominance + BTC price drop = alts bleed harder.
 * Falling BTC dominance = alt season, bullish for alts.
 * @param {number} btcDom - Current BTC dominance % (e.g. 55.3)
 * @param {number} btcChange24h - BTC 24h price change %
 * @param {string} assetId - CoinGecko asset ID
 * @param {number} assetChange24h - This asset's 24h change %
 */
function scoreBtcDominance(btcDom, btcChange24h, assetId, assetChange24h) {
  // BTC itself is unaffected by its own dominance metric
  if (assetId === 'bitcoin' || !btcDom || btcDom <= 0) {
    return { scoreModifier: 0, confidenceModifier: 0, signals: [], regime: 'neutral' };
  }

  let scoreModifier = 0;
  let confidenceModifier = 0;
  const signals = [];
  let regime = 'neutral';

  // BTC dominance rising (>50%) + BTC price dropping = capital fleeing alts → bearish alts
  if (btcDom > 55 && btcChange24h < -2) {
    scoreModifier = -10;
    confidenceModifier = 3;
    regime = 'btc_season';
    signals.push(`BTC dominance ${btcDom}% + BTC falling - alt blood bath risk`);
  } else if (btcDom > 55 && btcChange24h > 2) {
    // BTC dominance high + BTC pumping = money flowing to BTC not alts
    scoreModifier = -5;
    regime = 'btc_season';
    signals.push(`BTC dominance ${btcDom}% + BTC rising - capital in BTC`);
  } else if (btcDom < 45 && btcChange24h > 0) {
    // Low BTC dominance + BTC stable/up = alt season
    scoreModifier = 8;
    confidenceModifier = 3;
    regime = 'alt_season';
    signals.push(`BTC dominance low ${btcDom}% - alt season active`);
  } else if (btcDom < 50 && assetChange24h > btcChange24h + 3) {
    // Alt outperforming BTC significantly = money rotating into alts
    scoreModifier = 5;
    regime = 'alt_season';
    signals.push('Alt outperforming BTC - rotation signal');
  } else if (btcDom > 52 && assetChange24h < btcChange24h - 3) {
    // Alt underperforming BTC significantly = money leaving alts
    scoreModifier = -5;
    regime = 'btc_season';
    signals.push('Alt underperforming BTC - capital exiting alts');
  }

  return { scoreModifier, confidenceModifier, signals, regime };
}

/**
 * Score DXY (Dollar Index) macro regime impact on crypto.
 * Strong dollar = bearish crypto, weak dollar = bullish crypto.
 * @param {number} dxy - DXY index value (typically 90-115)
 * @param {string} dxyTrend - 'rising', 'falling', or 'stable'
 * @param {number} dxyChange - DXY % change (optional)
 */
function scoreDxyMacro(dxy, dxyTrend, dxyChange) {
  if (!dxy || dxy <= 0) {
    return { scoreModifier: 0, confidenceModifier: 0, signals: [], regime: 'neutral' };
  }

  let scoreModifier = 0;
  let confidenceModifier = 0;
  const signals = [];
  let regime = 'neutral';

  if (dxy > 105 && dxyTrend === 'rising') {
    scoreModifier = -8;
    confidenceModifier = -3;
    regime = 'risk_off';
    signals.push(`DXY strong ${dxy.toFixed(1)} & rising - risk-off for crypto`);
  } else if (dxy > 103 && dxyTrend === 'rising') {
    scoreModifier = -4;
    regime = 'risk_off';
    signals.push(`DXY elevated ${dxy.toFixed(1)} & rising - mild headwind`);
  } else if (dxy < 98 && dxyTrend === 'falling') {
    scoreModifier = 10;
    confidenceModifier = 3;
    regime = 'risk_on';
    signals.push(`DXY weak ${dxy.toFixed(1)} & falling - risk-on for crypto`);
  } else if (dxy < 100 && dxyTrend === 'falling') {
    scoreModifier = 6;
    regime = 'risk_on';
    signals.push(`DXY below 100 ${dxy.toFixed(1)} & falling - bullish macro`);
  } else if (dxy > 103) {
    scoreModifier = -2;
    signals.push(`DXY elevated ${dxy.toFixed(1)} - watchful`);
  }

  return { scoreModifier, confidenceModifier, signals, regime };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDER BOOK DEPTH SCORING (Factor #14)
// Analyzes bid/ask imbalance, walls, and spread for directional bias
// Weight: up to ±12 score, up to 4 confidence
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Score order book depth data for directional signal.
 * Uses imbalance ratio (bid vol / ask vol), wall analysis, and spread.
 *
 * @param {Object|null} orderBook - From fetchOrderBookDepth()
 * @param {Object} cfg - Strategy config (needs orderBookScore weight)
 * @returns {{ scoreModifier: number, confidenceModifier: number, signals: string[], pressure: string }}
 */
function scoreOrderBook(orderBook, cfg = {}) {
  if (!orderBook) return { scoreModifier: 0, confidenceModifier: 0, signals: [], pressure: 'unavailable' };

  const weight = cfg.orderBookScore || 12;
  let scoreModifier = 0;
  let confidenceModifier = 0;
  const signals = [];
  let pressure = 'neutral';

  const { imbalanceRatio, wallImbalance, spreadPercent } = orderBook;

  // ─── Imbalance Ratio Analysis ───
  // > 1.5 = strong buy support (bids outweigh asks significantly)
  // < 0.67 = strong sell pressure (asks outweigh bids)
  if (imbalanceRatio >= 2.0) {
    scoreModifier += weight;
    confidenceModifier += 4;
    pressure = 'strong_buy_support';
    signals.push(`Order book heavy bid side (${imbalanceRatio.toFixed(2)}x) - strong buy support`);
  } else if (imbalanceRatio >= 1.5) {
    scoreModifier += Math.round(weight * 0.6);
    confidenceModifier += 2;
    pressure = 'buy_support';
    signals.push(`Order book bid-leaning (${imbalanceRatio.toFixed(2)}x)`);
  } else if (imbalanceRatio <= 0.5) {
    scoreModifier -= weight;
    confidenceModifier += 4;
    pressure = 'strong_sell_pressure';
    signals.push(`Order book heavy ask side (${imbalanceRatio.toFixed(2)}x) - strong sell pressure`);
  } else if (imbalanceRatio <= 0.67) {
    scoreModifier -= Math.round(weight * 0.6);
    confidenceModifier += 2;
    pressure = 'sell_pressure';
    signals.push(`Order book ask-leaning (${imbalanceRatio.toFixed(2)}x)`);
  }

  // ─── Wall Analysis ───
  // Large bid wall = support; large ask wall = resistance
  if (wallImbalance >= 3.0) {
    scoreModifier += Math.round(weight * 0.3);
    signals.push(`Bid wall ${wallImbalance.toFixed(1)}x larger than ask wall`);
  } else if (wallImbalance <= 0.33) {
    scoreModifier -= Math.round(weight * 0.3);
    signals.push(`Ask wall ${(1 / wallImbalance).toFixed(1)}x larger than bid wall`);
  }

  // ─── Spread Analysis ───
  // Wide spread = low liquidity → reduce confidence
  // Tight spread = high liquidity → slight confidence boost
  if (spreadPercent > 0.1) {
    confidenceModifier -= 2;
    signals.push(`Wide spread (${spreadPercent.toFixed(2)}%) - low liquidity`);
  } else if (spreadPercent < 0.02) {
    confidenceModifier += 1;
  }

  // Default pressure label
  if (pressure === 'neutral') {
    if (imbalanceRatio > 1.1) pressure = 'slight_buy';
    else if (imbalanceRatio < 0.9) pressure = 'slight_sell';
    else pressure = 'balanced';
  }

  return { scoreModifier, confidenceModifier, signals, pressure };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL GENERATION ENGINE v4.5
// Strategy: Multi-factor weighted scoring with trend context
// + Trade levels (SL/TP/R:R) + Derivatives + Macro context + Multi-timeframe
// ═══════════════════════════════════════════════════════════════════════════════

async function generateSignalWithRealData(asset, currentPrice, change24h, volume, fearGreed, interval = '1h', derivativesData = null, macroData = null, preloadedCandles = null, strategyConfig = null, orderBookData = null) {
  // Merge strategy config with defaults
  const { mergeConfig } = require('./strategyConfig');
  const cfg = mergeConfig(strategyConfig);

  try {
    // Fetch candles - 168 for 1h (7 days), more for lower timeframes
    // If preloadedCandles provided (backtesting), use those instead of fetching
    const candleLimit = interval === '1h' ? 200 : (interval.includes('m') ? 288 : 100);
    const ohlcvData = preloadedCandles || await fetchOHLCVCandles(asset, interval, candleLimit);

    if (ohlcvData.length < 50) {
      return {
        asset: asset.toUpperCase(),
        action: 'HOLD',
        score: 50,
        confidence: 15,
        price: currentPrice,
        change24h,
        reasons: 'Insufficient data for reliable analysis',
        timestamp: new Date().toISOString(),
        dataSource: 'insufficient',
        interval
      };
    }

    const prices = ohlcvData.map(d => d.close);

    // ─── CALCULATE ALL INDICATORS ──────────────────────────────────
    const rsi = calculateRSI(prices, cfg.rsiPeriod);
    const rsiSeries = calculateRSISeries(prices, cfg.rsiPeriod);
    const macd = calculateMACD(prices, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
    const bollinger = calculateBollingerBands(prices, cfg.bbPeriod, cfg.bbStdDev);
    const adx = calculateADX(ohlcvData, cfg.adxPeriod);
    const emaTrend = detectEMATrend(prices);
    const divergence = detectRSIDivergence(prices, rsiSeries, cfg.divergenceLookback);
    const volumeProfile = analyzeVolumeProfile(ohlcvData, cfg.volumeLookback);
    const bbSqueeze = detectBBSqueeze(prices, cfg.bbPeriod);
    const atr = calculateATR(ohlcvData, cfg.atrPeriod);
    const atrPercent = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;

    // Multi-level Support/Resistance from swing highs/lows + pivot extensions
    const srLevels = findMultiLevelSR(ohlcvData, currentPrice, cfg);
    // Backward-compat alias for existing code that reads supportResistance.support/resistance/pivot
    const supportResistance = {
      support: srLevels.nearestSupport,
      resistance: srLevels.nearestResistance,
      pivot: srLevels.pivot
    };

    // Advanced indicators
    const ichimoku = calculateIchimoku(ohlcvData, cfg);
    const vwap = calculateVWAP(ohlcvData, cfg.vwapSessionLength);
    const fibonacci = calculateFibonacciRetracement(ohlcvData, cfg.fibSwingLookback, currentPrice);
    const marketStructure = analyzeMarketStructure(ohlcvData, cfg);

    // ─── SCORING ENGINE v3 ──────────────────────────────────────────
    // Score: -100 (extreme sell) to +100 (extreme buy). 0 = neutral
    // This prevents the systematic buy bias of the old 50-based system
    let score = 0;
    let confidence = 0; // Starts at ZERO - must be earned
    const signals = [];

    // ─── 1. TREND CONTEXT (Most important - determines trading bias) ───
    // Weight: up to ±25 score, up to 20 confidence
    if (emaTrend.trend === 'strong_up') {
      score += cfg.trendScoreStrong;
      confidence += 15;
      signals.push(`Strong uptrend (EMA 9>21>50)`);
    } else if (emaTrend.trend === 'strong_down') {
      score -= cfg.trendScoreStrong;
      confidence += 15;
      signals.push(`Strong downtrend (EMA 9<21<50)`);
    } else if (emaTrend.trend === 'up') {
      score += cfg.trendScoreModerate;
      confidence += 8;
      signals.push('Moderate uptrend');
    } else if (emaTrend.trend === 'down') {
      score -= cfg.trendScoreModerate;
      confidence += 8;
      signals.push('Moderate downtrend');
    } else {
      signals.push('No clear trend (sideways)');
      confidence += 3;
    }

    // ─── 2. ADX - TREND STRENGTH FILTER ─────────────────────────────
    // If ADX < 20, market is ranging → reduce confidence in all signals
    // Weight: modifier only
    let adxMultiplier = 1.0;
    if (adx.adx >= cfg.adxStrongThreshold) {
      confidence += 10;
      adxMultiplier = cfg.adxStrongMultiplier;
      signals.push(`ADX strong trend (${adx.adx})`);
    } else if (adx.adx >= cfg.adxModerateThreshold) {
      confidence += 5;
      adxMultiplier = 1.0;
    } else {
      adxMultiplier = cfg.adxWeakMultiplier;
      signals.push(`ADX weak trend (${adx.adx}) - caution`);
    }

    // ─── 3. RSI ANALYSIS (with trend context) ───────────────────────
    // In uptrend: RSI 40-50 is "bullish pullback", not neutral
    // In downtrend: RSI 50-60 is "bearish rally", not neutral
    // Weight: up to ±20 score, up to 12 confidence
    if (rsi < cfg.rsiExtremeOversold) {
      score += cfg.rsiExtremeScore * adxMultiplier;
      confidence += 12;
      signals.push(`RSI extremely oversold (${rsi.toFixed(1)})`);
    } else if (rsi < cfg.rsiOversold) {
      score += cfg.rsiStrongScore * adxMultiplier;
      confidence += 10;
      signals.push(`RSI oversold (${rsi.toFixed(1)})`);
    } else if (rsi < cfg.rsiPullbackZone) {
      // Only bullish if in uptrend context
      if (emaTrend.trend.includes('up')) {
        score += cfg.rsiPullbackScore * adxMultiplier;
        confidence += 6;
        signals.push(`RSI bullish pullback in uptrend (${rsi.toFixed(1)})`);
      } else {
        score += 3;
        confidence += 3;
        signals.push(`RSI leaning bullish (${rsi.toFixed(1)})`);
      }
    } else if (rsi > cfg.rsiExtremeOverbought) {
      score -= cfg.rsiExtremeScore * adxMultiplier;
      confidence += 12;
      signals.push(`RSI extremely overbought (${rsi.toFixed(1)})`);
    } else if (rsi > cfg.rsiOverbought) {
      score -= cfg.rsiStrongScore * adxMultiplier;
      confidence += 10;
      signals.push(`RSI overbought (${rsi.toFixed(1)})`);
    } else if (rsi > cfg.rsiPullbackZoneHigh) {
      if (emaTrend.trend.includes('down')) {
        score -= cfg.rsiPullbackScore * adxMultiplier;
        confidence += 6;
        signals.push(`RSI bearish rally in downtrend (${rsi.toFixed(1)})`);
      } else {
        score -= 3;
        confidence += 3;
        signals.push(`RSI leaning bearish (${rsi.toFixed(1)})`);
      }
    } else {
      signals.push(`RSI neutral (${rsi.toFixed(1)})`);
      confidence += 2;
    }

    // ─── 4. MACD ANALYSIS (with histogram momentum) ─────────────────
    // Weight: up to ±15 score, up to 10 confidence
    if (macd.histogram > 0 && macd.macd > macd.signal) {
      const macdScore = macd.histogramTrend === 'growing' ? cfg.macdStrongScore : cfg.macdWeakScore;
      score += macdScore * adxMultiplier;
      confidence += macd.histogramTrend === 'growing' ? 10 : 6;
      signals.push(macd.histogramTrend === 'growing'
        ? 'MACD bullish crossover (accelerating)'
        : 'MACD bullish (decelerating)');
    } else if (macd.histogram < 0 && macd.macd < macd.signal) {
      // FIX: 'shrinking' = histogram becoming more negative = bearish ACCELERATING = strong score
      //      'growing'   = histogram becoming less negative  = bearish WEAKENING   = weak score
      const macdScore = macd.histogramTrend === 'shrinking' ? -cfg.macdStrongScore : -cfg.macdWeakScore;
      score += macdScore * adxMultiplier;
      confidence += macd.histogramTrend === 'shrinking' ? 10 : 6;
      signals.push(macd.histogramTrend === 'shrinking'
        ? 'MACD bearish crossover (accelerating)'
        : 'MACD bearish (weakening)');
    } else if (macd.histogram > 0) {
      score += 4;
      confidence += 3;
    } else if (macd.histogram < 0) {
      score -= 4;
      confidence += 3;
    }

    // ─── 5. DIVERGENCE DETECTION (Powerful reversal signal) ──────────
    // Weight: up to ±20 score, up to 15 confidence
    if (divergence.type === 'bullish') {
      score += Math.min(cfg.divergenceMaxScore, cfg.divergenceBaseScore + divergence.strength);
      confidence += 12;
      signals.push(`Bullish RSI divergence detected (strength: ${divergence.strength.toFixed(1)})`);
    } else if (divergence.type === 'bearish') {
      score -= Math.min(cfg.divergenceMaxScore, cfg.divergenceBaseScore + divergence.strength);
      confidence += 12;
      signals.push(`Bearish RSI divergence detected (strength: ${divergence.strength.toFixed(1)})`);
    }

    // ─── 6. BOLLINGER BANDS (with squeeze detection) ────────────────
    // Weight: up to ±12 score, up to 8 confidence
    if (bbSqueeze.squeeze) {
      confidence += 5;
      if (bbSqueeze.direction === 'up') {
        score += 8;
        signals.push('BB squeeze → breakout likely upward');
      } else {
        score -= 8;
        signals.push('BB squeeze → breakout likely downward');
      }
    } else if (bollinger.percentB <= 0) {
      score += cfg.bbOuterScore;
      confidence += 7;
      signals.push('Price below lower Bollinger Band');
    } else if (bollinger.percentB >= 1) {
      score -= cfg.bbOuterScore;
      confidence += 7;
      signals.push('Price above upper Bollinger Band');
    } else if (bollinger.percentB < 0.2) {
      score += cfg.bbNearScore;
      confidence += 4;
      signals.push('Price near lower Bollinger Band');
    } else if (bollinger.percentB > 0.8) {
      score -= cfg.bbNearScore;
      confidence += 4;
      signals.push('Price near upper Bollinger Band');
    }

    // ─── 7. VOLUME CONFIRMATION (Critical for signal quality) ───────
    // Volume MUST confirm for high-confidence signals
    // Weight: modifier to confidence
    if (volumeProfile.profile === 'confirming_up' && score > 0) {
      confidence += 10;
      signals.push(`Volume confirms buying (${volumeProfile.buyPressure}% buy pressure)`);
    } else if (volumeProfile.profile === 'confirming_down' && score < 0) {
      confidence += 10;
      signals.push(`Volume confirms selling (${100 - volumeProfile.buyPressure}% sell pressure)`);
    } else if (volumeProfile.profile === 'diverging') {
      confidence -= 8; // REDUCE confidence when volume disagrees
      signals.push(`Volume diverges from price - weak signal`);
    }

    if (volumeProfile.ratio > 2.0) {
      confidence += 5;
      signals.push('Unusually high volume');
    } else if (volumeProfile.ratio < 0.5) {
      confidence -= 5;
      signals.push('Low volume - weak conviction');
    }

    // ─── 8. SUPPORT/RESISTANCE (Multi-Level) ──────────────────────
    // Weight: up to ±8 score, up to 8 confidence (5 base + 3 strength bonus)
    // Gradual scoring: closer to level = stronger signal
    const nearestSup = srLevels.supports[0];
    const nearestRes = srLevels.resistances[0];
    let srScoreContrib = 0;
    let srConfContrib = 0;

    if (nearestSup && nearestSup.distancePercent < 3.0) {
      const proximity = Math.max(0, 1 - (nearestSup.distancePercent / 3.0));
      srScoreContrib += Math.round(cfg.srScore * proximity);
      srConfContrib += Math.round(5 * proximity);
      if (nearestSup.strength >= 3) {
        srConfContrib += Math.min(cfg.srZoneStrengthBonus || 3, nearestSup.strength - 2);
        signals.push(`Strong support S1 (${nearestSup.touches} tests)`);
      } else if (proximity > 0.5) {
        signals.push('Near support level');
      }
    }

    if (nearestRes && nearestRes.distancePercent < 3.0) {
      const proximity = Math.max(0, 1 - (nearestRes.distancePercent / 3.0));
      srScoreContrib -= Math.round(cfg.srScore * proximity);
      srConfContrib += Math.round(5 * proximity);
      if (nearestRes.strength >= 3) {
        srConfContrib += Math.min(cfg.srZoneStrengthBonus || 3, nearestRes.strength - 2);
        signals.push(`Strong resistance R1 (${nearestRes.touches} tests)`);
      } else if (proximity > 0.5) {
        signals.push('Near resistance level');
      }
    }

    score += srScoreContrib;
    confidence += srConfContrib;

    // ─── 9. MOMENTUM (24h change - minor weight) ───────────────────
    // Weight: up to ±8 score (reduced from ±10 - momentum is a lagging signal)
    if (change24h > 10) {
      // Very strong up momentum - but could be overbought
      score += cfg.momentumScore;
      confidence += 3;
      signals.push(`Strong 24h momentum (+${change24h.toFixed(1)}%)`);
    } else if (change24h > 5) {
      score += Math.round(cfg.momentumScore * 0.8);
      confidence += 2;
    } else if (change24h < -10) {
      score -= cfg.momentumScore;
      confidence += 3;
      signals.push(`Strong 24h selling (${change24h.toFixed(1)}%)`);
    } else if (change24h < -5) {
      score -= Math.round(cfg.momentumScore * 0.8);
      confidence += 2;
    }

    // ─── 10. FEAR & GREED (Minor contrarian modifier only) ──────────
    // CRITICAL FIX: This was heavily biasing ALL signals before.
    // Now it's a minor modifier (+/- 3 score max) that only matters at extremes
    // Weight: up to ±3 score, up to 3 confidence
    if (fearGreed < 10) {
      score += cfg.fearGreedScore;
      confidence += 3;
      signals.push(`Extreme fear index (${fearGreed}) - contrarian`);
    } else if (fearGreed < 25) {
      score += 1;
      confidence += 1;
    } else if (fearGreed > 90) {
      score -= cfg.fearGreedScore;
      confidence += 3;
      signals.push(`Extreme greed index (${fearGreed}) - caution`);
    } else if (fearGreed > 75) {
      score -= 1;
      confidence += 1;
    }

    // ─── 11. DERIVATIVES SENTIMENT (Funding Rate + OI) ──────────────
    // Weight: up to ±15 score, up to 5 confidence
    const derivativesScoring = scoreDerivatives(derivativesData, score, change24h);
    score += derivativesScoring.scoreModifier;
    confidence += derivativesScoring.confidenceModifier;
    signals.push(...derivativesScoring.signals);

    // ─── 12. BTC DOMINANCE CORRELATION ────────────────────────────────
    // Weight: up to ±10 score, up to 3 confidence
    let btcDomScoring = { scoreModifier: 0, confidenceModifier: 0, signals: [], regime: 'neutral' };
    if (macroData) {
      btcDomScoring = scoreBtcDominance(macroData.btcDom, macroData.btcChange24h, asset, change24h);
      score += btcDomScoring.scoreModifier;
      confidence += btcDomScoring.confidenceModifier;
      signals.push(...btcDomScoring.signals);
    }

    // ─── 13. DXY MACRO REGIME ─────────────────────────────────────────
    // Weight: up to ±10 score, up to 3 confidence
    let dxyScoring = { scoreModifier: 0, confidenceModifier: 0, signals: [], regime: 'neutral' };
    if (macroData) {
      dxyScoring = scoreDxyMacro(macroData.dxy, macroData.dxyTrend, macroData.dxyChange);
      score += dxyScoring.scoreModifier;
      confidence += dxyScoring.confidenceModifier;
      signals.push(...dxyScoring.signals);
    }

    // ─── 14. ORDER BOOK DEPTH ─────────────────────────────────────────
    // Weight: up to ±12 score, up to 4 confidence
    let orderBookScoring = { scoreModifier: 0, confidenceModifier: 0, signals: [], pressure: 'unavailable' };
    if (orderBookData) {
      orderBookScoring = scoreOrderBook(orderBookData, cfg);
      score += orderBookScoring.scoreModifier;
      confidence += orderBookScoring.confidenceModifier;
      signals.push(...orderBookScoring.signals);
    }

    // ─── 15. ICHIMOKU CLOUD ────────────────────────────────────────────
    // Weight: up to ±10 score, up to 6 confidence
    if (ichimoku.signal !== 'insufficient_data') {
      const iScore = cfg.ichimokuScore || 10;
      if (ichimoku.priceVsCloud === 'above') {
        score += iScore;
        confidence += 4;
        signals.push('Ichimoku: price above cloud (bullish)');
      } else if (ichimoku.priceVsCloud === 'below') {
        score -= iScore;
        confidence += 4;
        signals.push('Ichimoku: price below cloud (bearish)');
      } else if (ichimoku.priceVsCloud === 'inside') {
        confidence -= 3;
        signals.push('Ichimoku: price inside cloud (indecision)');
      }
      // TK cross bonus
      if (ichimoku.tkCross === 'bullish') { score += 4; confidence += 2; }
      else if (ichimoku.tkCross === 'bearish') { score -= 4; confidence += 2; }
      // Cloud color confirms
      if (ichimoku.cloudColor === ichimoku.signal) confidence += 2;
    }

    // ─── 16. VWAP ───────────────────────────────────────────────────────
    // Weight: up to ±8 score, up to 3 confidence
    if (vwap.signal !== 'insufficient_data') {
      const vScore = cfg.vwapScore || 8;
      if (vwap.priceVsVwap === 'above_2sigma') {
        score -= vScore * 0.8;
        confidence += 3;
        signals.push('VWAP: overbought (>2σ above)');
      } else if (vwap.priceVsVwap === 'above') {
        const gradual = Math.min(1, Math.abs(vwap.distancePercent) / 3);
        score += vScore * gradual;
        confidence += 2;
        signals.push('VWAP: price above VWAP (bullish)');
      } else if (vwap.priceVsVwap === 'below') {
        const gradual = Math.min(1, Math.abs(vwap.distancePercent) / 3);
        score -= vScore * gradual;
        confidence += 2;
        signals.push('VWAP: price below VWAP (bearish)');
      } else if (vwap.priceVsVwap === 'below_2sigma') {
        score += vScore * 0.8;
        confidence += 3;
        signals.push('VWAP: oversold (<2σ below)');
      }
    }

    // ─── 17. FIBONACCI RETRACEMENT ──────────────────────────────────────
    // Weight: up to ±6 score, up to 4 confidence
    if (fibonacci.signal !== 'insufficient_data') {
      const fScore = cfg.fibScore || 6;
      if (fibonacci.signal === 'bullish_retracement') {
        score += fScore;
        confidence += 3;
        signals.push(`Fib: bullish retracement at ${fibonacci.nearestLevel?.label || '?'}`);
      } else if (fibonacci.signal === 'bearish_retracement') {
        score -= fScore;
        confidence += 3;
        signals.push(`Fib: bearish retracement at ${fibonacci.nearestLevel?.label || '?'}`);
      }
      // Golden ratio bonus
      if (fibonacci.goldenRatio && fibonacci.distanceToNearest < 2) {
        confidence += cfg.fibGoldenRatioBonus || 2;
      }
    }

    // ─── 18. MARKET STRUCTURE ───────────────────────────────────────────
    // Weight: up to ±12 score, up to 8 confidence
    if (marketStructure.signal !== 'insufficient_data') {
      const msScore = cfg.marketStructureScore || 12;
      if (marketStructure.signal === 'bullish' && marketStructure.breakOfStructure.detected) {
        score += msScore;
        confidence += 8;
        signals.push('Market Structure: bullish BOS (break of structure)');
      } else if (marketStructure.signal === 'bearish' && marketStructure.breakOfStructure.detected) {
        score -= msScore;
        confidence += 8;
        signals.push('Market Structure: bearish BOS (break of structure)');
      } else if (marketStructure.signal === 'bullish_reversal') {
        score += msScore * 0.4;
        confidence += 6;
        signals.push('Market Structure: bullish CHoCH (change of character)');
      } else if (marketStructure.signal === 'bearish_reversal') {
        score -= msScore * 0.4;
        confidence += 6;
        signals.push('Market Structure: bearish CHoCH (change of character)');
      } else if (marketStructure.signal === 'bullish') {
        score += msScore * 0.6;
        confidence += 5;
        signals.push('Market Structure: HH/HL (bullish)');
      } else if (marketStructure.signal === 'bearish') {
        score -= msScore * 0.6;
        confidence += 5;
        signals.push('Market Structure: LH/LL (bearish)');
      } else if (marketStructure.structure === 'ranging') {
        confidence -= 3;
      }
    }

    // ─── SIGNAL AGREEMENT ANALYSIS ──────────────────────────────────
    // Count how many factors agree vs disagree
    const bullishFactors = [
      emaTrend.trend.includes('up'),
      rsi < 45,
      macd.histogram > 0,
      divergence.type === 'bullish',
      bollinger.percentB < 0.3,
      volumeProfile.profile === 'confirming_up' || volumeProfile.buyPressure > 55,
      ichimoku.signal === 'bullish',
      vwap.signal === 'bullish' || vwap.signal === 'oversold',
      marketStructure.signal === 'bullish' || marketStructure.signal === 'bullish_reversal'
    ].filter(Boolean).length;

    const bearishFactors = [
      emaTrend.trend.includes('down'),
      rsi > 55,
      macd.histogram < 0,
      divergence.type === 'bearish',
      bollinger.percentB > 0.7,
      volumeProfile.profile === 'confirming_down' || volumeProfile.buyPressure < 45,
      ichimoku.signal === 'bearish',
      vwap.signal === 'bearish' || vwap.signal === 'overbought',
      marketStructure.signal === 'bearish' || marketStructure.signal === 'bearish_reversal'
    ].filter(Boolean).length;

    // Conflicting signals reduce confidence
    if (bullishFactors >= 3 && bearishFactors >= 3) {
      confidence -= cfg.conflictPenalty;
      signals.push('Mixed signals - conflicting indicators');
    } else if (bullishFactors >= 5 || bearishFactors >= 5) {
      confidence += cfg.multiFactorBonus;
      signals.push(bullishFactors >= 5 ? 'Strong multi-factor bullish alignment' : 'Strong multi-factor bearish alignment');
    }

    // ─── DETERMINE ACTION ───────────────────────────────────────────
    // Convert from -100/+100 scale back to 0-100 for display
    // -100 → 0, 0 → 50, +100 → 100
    const displayScore = Math.round(Math.max(0, Math.min(100, (score + 100) / 2)));

    // Action thresholds on the RAW score (-100 to +100)
    // BUY: score >= 20 (was effectively ~12 before)
    // SELL: score <= -20
    // This means the system needs REAL conviction, not just slight tilts
    let action = 'HOLD';
    if (score >= cfg.buyThreshold) action = 'BUY';
    else if (score >= cfg.buyWeakThreshold && confidence >= cfg.weakConfidenceMin) action = 'BUY';
    else if (score <= cfg.sellThreshold) action = 'SELL';
    else if (score <= cfg.sellWeakThreshold && confidence >= cfg.weakConfidenceMin) action = 'SELL';

    // Cap confidence (never claim near-certainty in crypto)
    confidence = Math.max(0, Math.min(cfg.confidenceCap, Math.round(confidence)));

    // ─── SIGNAL STRENGTH LABEL ──────────────────────────────────────
    let strengthLabel = '';
    if (action === 'BUY') {
      if (score >= cfg.strongBuyMinScore && confidence >= cfg.strongBuyMinConf) strengthLabel = 'STRONG BUY';
      else if (score >= cfg.buyMinScore && confidence >= cfg.buyMinConf) strengthLabel = 'BUY';
      else strengthLabel = 'WEAK BUY';
    } else if (action === 'SELL') {
      if (score <= -cfg.strongBuyMinScore && confidence >= cfg.strongBuyMinConf) strengthLabel = 'STRONG SELL';
      else if (score <= -cfg.buyMinScore && confidence >= cfg.buyMinConf) strengthLabel = 'SELL';
      else strengthLabel = 'WEAK SELL';
    } else {
      strengthLabel = 'HOLD';
    }

    // ─── TRADE LEVELS ─────────────────────────────────────────────
    const tradeLevels = calculateTradeLevels(
      action, currentPrice,
      supportResistance.support, supportResistance.resistance,
      supportResistance.pivot, atr,
      { atrStopMult: cfg.atrStopMult, atrTP2Mult: cfg.atrTP2Mult,
        atrTrailingMult: cfg.atrTrailingMult, atrTrailingActivation: cfg.atrTrailingActivation,
        minRiskReward: cfg.minRiskReward, srLevels }
    );

    if (tradeLevels && !tradeLevels.riskRewardOk) {
      signals.push(`Poor R:R (${tradeLevels.riskRewardRatio}:1) - consider waiting`);
    } else if (tradeLevels && tradeLevels.riskRewardRatio >= 2.5) {
      signals.push(`Excellent R:R (${tradeLevels.riskRewardRatio}:1)`);
    }

    return {
      asset: asset.toUpperCase(),
      action,
      strengthLabel,
      score: displayScore,
      rawScore: Math.round(score),
      confidence,
      price: currentPrice,
      change24h,
      reasons: signals.join(' • '),
      indicators: {
        rsi: rsi.toFixed(1),
        macd: macd.histogram.toFixed(6),
        macdTrend: macd.histogramTrend,
        bollinger: {
          position: bollinger.percentB > 1 ? 'above' : bollinger.percentB < 0 ? 'below' : 'within',
          percentB: (bollinger.percentB * 100).toFixed(1)
        },
        adx: adx.adx,
        adxTrend: adx.trend,
        emaTrend: emaTrend.trend,
        divergence: divergence.type,
        volumeProfile: volumeProfile.profile,
        buyPressure: volumeProfile.buyPressure,
        bbSqueeze: bbSqueeze.squeeze,
        atrPercent: atrPercent.toFixed(2),
        ichimoku: ichimoku.signal !== 'insufficient_data' ? ichimoku : null,
        vwap: vwap.signal !== 'insufficient_data' ? vwap : null,
        fibonacci: fibonacci.signal !== 'insufficient_data' ? fibonacci : null,
        marketStructure: marketStructure.signal !== 'insufficient_data' ? marketStructure : null
      },
      tradeLevels,
      supportResistanceLevels: srLevels,
      derivatives: derivativesData ? {
        fundingRate: derivativesData.fundingRate,
        fundingRatePercent: derivativesData.fundingRatePercent,
        fundingRateAnnualized: derivativesData.fundingRateAnnualized,
        openInterest: derivativesData.openInterest,
        longShortRatio: derivativesData.longShortRatio,
        sentiment: derivativesScoring.sentiment
      } : null,
      macroContext: macroData ? {
        btcDominance: macroData.btcDom,
        btcDomRegime: btcDomScoring.regime,
        dxy: macroData.dxy,
        dxyRegime: dxyScoring.regime
      } : null,
      orderBook: orderBookData ? {
        imbalanceRatio: orderBookData.imbalanceRatio,
        spreadPercent: orderBookData.spreadPercent,
        bidTotal: orderBookData.bidTotal,
        askTotal: orderBookData.askTotal,
        bidWall: orderBookData.bidWall,
        askWall: orderBookData.askWall,
        pressure: orderBookScoring.pressure
      } : null,
      dataSource: 'Binance OHLCV',
      interval,
      candlesAnalyzed: ohlcvData.length,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    logger.error('Signal generation error', { asset, error: error.message });
    return {
      asset: asset.toUpperCase(),
      action: 'HOLD',
      strengthLabel: 'ERROR',
      score: 50,
      rawScore: 0,
      confidence: 0,
      price: currentPrice,
      change24h,
      reasons: 'Error in technical analysis - defaulting to HOLD',
      timestamp: new Date().toISOString()
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-TIMEFRAME CONFLUENCE ENGINE
// Analyzes 4H + 1H + 15M and merges into a single high-quality signal
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a multi-timeframe confluent signal.
 * Runs analysis on 4h, 1h, and 15m candles, then merges with weighted scoring.
 * 4h = macro trend (40%), 1h = signal (40%), 15m = entry timing (20%)
 *
 * @param {string} asset - CoinGecko asset ID
 * @param {number} currentPrice
 * @param {number} change24h
 * @param {number} volume
 * @param {number} fearGreed
 * @param {Object|null} derivativesData
 * @returns {Promise<Object>} Merged signal with confluence data
 */
async function generateMultiTimeframeSignal(asset, currentPrice, change24h, volume, fearGreed, derivativesData = null, macroData = null, preloadedCandlesMap = null, strategyConfig = null, orderBookData = null) {
  // Merge strategy config with defaults for confluence parameters
  const { mergeConfig } = require('./strategyConfig');
  const cfg = mergeConfig(strategyConfig);

  // Run all three timeframes in parallel
  // Pass derivatives only to 1h (primary) to avoid triple-counting
  // Pass macroData only to 1h to avoid triple-counting macro impact
  // Pass orderBookData only to 1h to avoid triple-counting
  // If preloadedCandlesMap provided (backtesting), pass candles per timeframe
  const [signal4h, signal1h, signal15m] = await Promise.all([
    generateSignalWithRealData(asset, currentPrice, change24h, volume, fearGreed, '4h', null, null, preloadedCandlesMap?.['4h'] || null, strategyConfig, null),
    generateSignalWithRealData(asset, currentPrice, change24h, volume, fearGreed, '1h', derivativesData, macroData, preloadedCandlesMap?.['1h'] || null, strategyConfig, orderBookData),
    generateSignalWithRealData(asset, currentPrice, change24h, volume, fearGreed, '15m', null, null, preloadedCandlesMap?.['15m'] || null, strategyConfig, null)
  ]);

  // Classify each timeframe's direction
  const getTrend = (signal) => {
    if (signal.rawScore >= 15) return 'bullish';
    if (signal.rawScore <= -15) return 'bearish';
    return 'neutral';
  };

  const trends = {
    '4h': getTrend(signal4h),
    '1h': getTrend(signal1h),
    '15m': getTrend(signal15m)
  };

  const bullishCount = Object.values(trends).filter(t => t === 'bullish').length;
  const bearishCount = Object.values(trends).filter(t => t === 'bearish').length;

  // Determine confluence level
  let confluence;
  if (bullishCount === 3 || bearishCount === 3) confluence = 'strong';
  else if (bullishCount === 2 || bearishCount === 2) confluence = 'moderate';
  else if (bullishCount >= 1 && bearishCount >= 1) confluence = 'conflicting';
  else confluence = 'weak';

  // Weighted merge: configurable timeframe weights
  let mergedRawScore = (signal4h.rawScore * cfg.tf4hWeight) +
                       (signal1h.rawScore * cfg.tf1hWeight) +
                       (signal15m.rawScore * cfg.tf15mWeight);

  // Confluence adjustments
  let confidenceBonus = 0;
  const confluenceReasons = [];

  if (confluence === 'strong') {
    mergedRawScore *= cfg.strongConfluenceMult;
    confidenceBonus = 15;
    confluenceReasons.push('STRONG confluence - all timeframes aligned');
  } else if (confluence === 'moderate') {
    confidenceBonus = cfg.moderateConfluenceBonus;
    confluenceReasons.push('Moderate confluence - 2/3 timeframes agree');
  } else if (confluence === 'conflicting') {
    mergedRawScore *= cfg.conflictingMult;
    confidenceBonus = -10;
    confluenceReasons.push('CONFLICTING timeframes - reduced conviction');
  } else {
    confluenceReasons.push('Weak confluence - no clear direction');
  }

  // 4h is the "governor" - don't fight the macro trend
  if (trends['4h'] === 'bearish' && mergedRawScore > 0) {
    mergedRawScore *= cfg.governorMult;
    confidenceBonus -= 5;
    confluenceReasons.push('4H bearish governs - dampened bullish signal');
  } else if (trends['4h'] === 'bullish' && mergedRawScore < 0) {
    mergedRawScore *= cfg.governorMult;
    confidenceBonus -= 5;
    confluenceReasons.push('4H bullish governs - dampened bearish signal');
  }

  mergedRawScore = Math.max(-100, Math.min(100, Math.round(mergedRawScore)));

  let mergedConfidence = (signal4h.confidence * cfg.tf4hWeight) +
                         (signal1h.confidence * cfg.tf1hWeight) +
                         (signal15m.confidence * cfg.tf15mWeight) +
                         confidenceBonus;
  mergedConfidence = Math.max(0, Math.min(cfg.confidenceCap, Math.round(mergedConfidence)));

  const displayScore = Math.round(Math.max(0, Math.min(100, (mergedRawScore + 100) / 2)));

  // Determine action
  let action = 'HOLD';
  if (mergedRawScore >= cfg.buyThreshold) action = 'BUY';
  else if (mergedRawScore >= cfg.buyWeakThreshold && mergedConfidence >= cfg.weakConfidenceMin) action = 'BUY';
  else if (mergedRawScore <= cfg.sellThreshold) action = 'SELL';
  else if (mergedRawScore <= cfg.sellWeakThreshold && mergedConfidence >= cfg.weakConfidenceMin) action = 'SELL';

  // Strength label
  let strengthLabel = 'HOLD';
  if (action === 'BUY') {
    if (mergedRawScore >= cfg.strongBuyMinScore && mergedConfidence >= cfg.strongBuyMinConf) strengthLabel = 'STRONG BUY';
    else if (mergedRawScore >= cfg.buyMinScore && mergedConfidence >= cfg.buyMinConf) strengthLabel = 'BUY';
    else strengthLabel = 'WEAK BUY';
  } else if (action === 'SELL') {
    if (mergedRawScore <= -cfg.strongBuyMinScore && mergedConfidence >= cfg.strongBuyMinConf) strengthLabel = 'STRONG SELL';
    else if (mergedRawScore <= -cfg.buyMinScore && mergedConfidence >= cfg.buyMinConf) strengthLabel = 'SELL';
    else strengthLabel = 'WEAK SELL';
  }

  // Merge reasons: 1h reasons + confluence context + timeframe divergences
  const allReasons = [];
  // Primary analysis from 1h
  allReasons.push(...signal1h.reasons.split(' \u2022 '));
  // Confluence info
  allReasons.push(...confluenceReasons);
  // Timeframe-specific notes
  if (trends['4h'] !== trends['1h']) {
    allReasons.push(`4H trend: ${trends['4h']}`);
  }
  if (trends['15m'] !== trends['1h']) {
    allReasons.push(`15M trend: ${trends['15m']}`);
  }

  // Recalculate trade levels with merged action
  const tradeLevels = signal1h.tradeLevels
    ? calculateTradeLevels(
        action, currentPrice,
        signal1h.tradeLevels.support,
        signal1h.tradeLevels.resistance,
        signal1h.tradeLevels.pivot,
        signal1h.tradeLevels.atrValue,
        { atrStopMult: cfg.atrStopMult, atrTP2Mult: cfg.atrTP2Mult,
          atrTrailingMult: cfg.atrTrailingMult, atrTrailingActivation: cfg.atrTrailingActivation,
          minRiskReward: cfg.minRiskReward,
          srLevels: signal1h.supportResistanceLevels || null }
      )
    : null;

  return {
    asset: asset.toUpperCase(),
    action,
    strengthLabel,
    score: displayScore,
    rawScore: mergedRawScore,
    confidence: mergedConfidence,
    price: currentPrice,
    change24h,
    reasons: allReasons.join(' \u2022 '),
    indicators: signal1h.indicators,
    tradeLevels,
    supportResistanceLevels: signal1h.supportResistanceLevels || null,
    derivatives: signal1h.derivatives || null,
    macroContext: signal1h.macroContext || null,
    orderBook: signal1h.orderBook || null,
    dataSource: 'Binance OHLCV (Multi-TF)',
    interval: 'multi',
    candlesAnalyzed: (signal4h.candlesAnalyzed || 0) + (signal1h.candlesAnalyzed || 0) + (signal15m.candlesAnalyzed || 0),
    timestamp: new Date().toISOString(),

    // Multi-timeframe confluence data
    timeframes: {
      '4h': {
        trend: trends['4h'],
        score: signal4h.rawScore,
        confidence: signal4h.confidence,
        action: signal4h.action
      },
      '1h': {
        trend: trends['1h'],
        score: signal1h.rawScore,
        confidence: signal1h.confidence,
        action: signal1h.action
      },
      '15m': {
        trend: trends['15m'],
        score: signal15m.rawScore,
        confidence: signal15m.confidence,
        action: signal15m.action
      },
      confluence
    }
  };
}

module.exports = {
  fetchHistoricalData,
  fetchOHLCVCandles,
  calculateSMA,
  calculateEMA,
  calculateRSI,
  calculateRSISeries,
  calculateMACD,
  calculateBollingerBands,
  calculateSupportResistance,
  findMultiLevelSR,
  calculateADX,
  detectEMATrend,
  detectRSIDivergence,
  calculateATR,
  analyzeVolumeProfile,
  detectBBSqueeze,
  calculateIchimoku,
  calculateVWAP,
  calculateFibonacciRetracement,
  analyzeMarketStructure,
  calculateTradeLevels,
  scoreDerivatives,
  scoreBtcDominance,
  scoreDxyMacro,
  scoreOrderBook,
  generateSignalWithRealData,
  generateMultiTimeframeSignal
};
