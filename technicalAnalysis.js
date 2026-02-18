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

// CoinCap ID mapping for fallback
const COINCAP_HISTORY_IDS = {
  bitcoin: 'bitcoin', ethereum: 'ethereum', binancecoin: 'binance-coin',
  solana: 'solana', cardano: 'cardano', ripple: 'xrp',
  polkadot: 'polkadot', dogecoin: 'dogecoin', 'avalanche-2': 'avalanche',
  chainlink: 'chainlink'
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
    historicalCache.set(cacheKey, { data: result, ts: Date.now() });
  } else if (cached) {
    logger.warn('Using stale historical cache', { coinId });
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
      historicalCache.set(cacheKey, { data: candles, ts: Date.now() });
      return candles;
    }
  } catch (error) {
    logger.warn('Binance OHLCV failed, trying fallback', { coinId, error: error.message });
  }

  try {
    const dailyData = await fetchHistoricalData(coinId, limit);
    candles = dailyData.map(d => ({
      timestamp: d.timestamp,
      open: d.price,
      high: d.price * 1.005,
      low: d.price * 0.995,
      close: d.price,
      volume: d.volume
    }));

    if (candles.length > 0) {
      historicalCache.set(cacheKey, { data: candles, ts: Date.now() });
      return candles;
    }
  } catch (fallbackError) {
    logger.error('All OHLCV sources failed', { coinId, error: fallbackError.message });
  }

  if (cached) {
    logger.warn('Using stale OHLCV cache', { coinId, age: Date.now() - cached.ts });
    return cached.data;
  }

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
// SIGNAL GENERATION ENGINE v3.0
// Strategy: Multi-factor weighted scoring with trend context
//
// KEY CHANGES FROM v2:
// 1. Confidence starts at 0 (not 50) - must be EARNED
// 2. Score is bidirectional: positive = bullish, negative = bearish (not 0-100)
// 3. Trend context determines how indicators are weighted
// 4. Divergences add powerful contrarian signals
// 5. ADX determines if we should even be trading (avoid ranging markets)
// 6. Volume MUST confirm for high-confidence signals
// 7. Fear & Greed is only a minor modifier, not a major signal
// ═══════════════════════════════════════════════════════════════════════════════

async function generateSignalWithRealData(asset, currentPrice, change24h, volume, fearGreed, interval = '1h') {
  try {
    // Fetch candles - 168 for 1h (7 days), more for lower timeframes
    const candleLimit = interval === '1h' ? 200 : (interval.includes('m') ? 288 : 100);
    const ohlcvData = await fetchOHLCVCandles(asset, interval, candleLimit);

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
    const rsi = calculateRSI(prices, 14);
    const rsiSeries = calculateRSISeries(prices, 14);
    const macd = calculateMACD(prices, 12, 26, 9);
    const bollinger = calculateBollingerBands(prices, 20, 2);
    const adx = calculateADX(ohlcvData, 14);
    const emaTrend = detectEMATrend(prices);
    const divergence = detectRSIDivergence(prices, rsiSeries, 20);
    const volumeProfile = analyzeVolumeProfile(ohlcvData, 14);
    const bbSqueeze = detectBBSqueeze(prices, 20);
    const atr = calculateATR(ohlcvData, 14);
    const atrPercent = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;

    // Support/Resistance from actual H/L
    const recentCandles = ohlcvData.slice(-30);
    const high = Math.max(...recentCandles.map(d => d.high));
    const low = Math.min(...recentCandles.map(d => d.low));
    const close = prices[prices.length - 1];
    const pivot = (high + low + close) / 3;
    const supportResistance = {
      support: (2 * pivot) - high,
      resistance: (2 * pivot) - low,
      pivot
    };

    // ─── SCORING ENGINE v3 ──────────────────────────────────────────
    // Score: -100 (extreme sell) to +100 (extreme buy). 0 = neutral
    // This prevents the systematic buy bias of the old 50-based system
    let score = 0;
    let confidence = 0; // Starts at ZERO - must be earned
    const signals = [];

    // ─── 1. TREND CONTEXT (Most important - determines trading bias) ───
    // Weight: up to ±25 score, up to 20 confidence
    if (emaTrend.trend === 'strong_up') {
      score += 20;
      confidence += 15;
      signals.push(`Strong uptrend (EMA 9>21>50)`);
    } else if (emaTrend.trend === 'strong_down') {
      score -= 20;
      confidence += 15;
      signals.push(`Strong downtrend (EMA 9<21<50)`);
    } else if (emaTrend.trend === 'up') {
      score += 10;
      confidence += 8;
      signals.push('Moderate uptrend');
    } else if (emaTrend.trend === 'down') {
      score -= 10;
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
    if (adx.adx >= 30) {
      confidence += 10;
      adxMultiplier = 1.2; // Strong trend = amplify directional signals
      signals.push(`ADX strong trend (${adx.adx})`);
    } else if (adx.adx >= 20) {
      confidence += 5;
      adxMultiplier = 1.0;
    } else {
      adxMultiplier = 0.6; // Weak trend = reduce all directional signals
      signals.push(`ADX weak trend (${adx.adx}) - caution`);
    }

    // ─── 3. RSI ANALYSIS (with trend context) ───────────────────────
    // In uptrend: RSI 40-50 is "bullish pullback", not neutral
    // In downtrend: RSI 50-60 is "bearish rally", not neutral
    // Weight: up to ±20 score, up to 12 confidence
    if (rsi < 20) {
      score += 18 * adxMultiplier;
      confidence += 12;
      signals.push(`RSI extremely oversold (${rsi.toFixed(1)})`);
    } else if (rsi < 30) {
      score += 12 * adxMultiplier;
      confidence += 10;
      signals.push(`RSI oversold (${rsi.toFixed(1)})`);
    } else if (rsi < 40) {
      // Only bullish if in uptrend context
      if (emaTrend.trend.includes('up')) {
        score += 8 * adxMultiplier;
        confidence += 6;
        signals.push(`RSI bullish pullback in uptrend (${rsi.toFixed(1)})`);
      } else {
        score += 3;
        confidence += 3;
        signals.push(`RSI leaning bullish (${rsi.toFixed(1)})`);
      }
    } else if (rsi > 80) {
      score -= 18 * adxMultiplier;
      confidence += 12;
      signals.push(`RSI extremely overbought (${rsi.toFixed(1)})`);
    } else if (rsi > 70) {
      score -= 12 * adxMultiplier;
      confidence += 10;
      signals.push(`RSI overbought (${rsi.toFixed(1)})`);
    } else if (rsi > 60) {
      if (emaTrend.trend.includes('down')) {
        score -= 8 * adxMultiplier;
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
      const macdScore = macd.histogramTrend === 'growing' ? 15 : 8;
      score += macdScore * adxMultiplier;
      confidence += macd.histogramTrend === 'growing' ? 10 : 6;
      signals.push(macd.histogramTrend === 'growing'
        ? 'MACD bullish crossover (accelerating)'
        : 'MACD bullish (decelerating)');
    } else if (macd.histogram < 0 && macd.macd < macd.signal) {
      const macdScore = macd.histogramTrend === 'shrinking' ? -8 : -15;
      score += macdScore * adxMultiplier;
      confidence += macd.histogramTrend === 'growing' ? 6 : 10;
      signals.push(macd.histogramTrend === 'growing'
        ? 'MACD bearish (weakening)'
        : 'MACD bearish crossover (accelerating)');
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
      score += Math.min(20, 10 + divergence.strength);
      confidence += 12;
      signals.push(`Bullish RSI divergence detected (strength: ${divergence.strength.toFixed(1)})`);
    } else if (divergence.type === 'bearish') {
      score -= Math.min(20, 10 + divergence.strength);
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
      score += 10;
      confidence += 7;
      signals.push('Price below lower Bollinger Band');
    } else if (bollinger.percentB >= 1) {
      score -= 10;
      confidence += 7;
      signals.push('Price above upper Bollinger Band');
    } else if (bollinger.percentB < 0.2) {
      score += 5;
      confidence += 4;
      signals.push('Price near lower Bollinger Band');
    } else if (bollinger.percentB > 0.8) {
      score -= 5;
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

    // ─── 8. SUPPORT/RESISTANCE ──────────────────────────────────────
    // Weight: up to ±8 score, up to 5 confidence
    const distToSupport = (currentPrice - supportResistance.support) / currentPrice;
    const distToResistance = (supportResistance.resistance - currentPrice) / currentPrice;

    if (distToSupport < 0.02 && distToSupport > -0.01) {
      score += 8;
      confidence += 5;
      signals.push('At support level');
    } else if (distToResistance < 0.02 && distToResistance > -0.01) {
      score -= 8;
      confidence += 5;
      signals.push('At resistance level');
    }

    // ─── 9. MOMENTUM (24h change - minor weight) ───────────────────
    // Weight: up to ±8 score (reduced from ±10 - momentum is a lagging signal)
    if (change24h > 10) {
      // Very strong up momentum - but could be overbought
      score += 5;
      confidence += 3;
      signals.push(`Strong 24h momentum (+${change24h.toFixed(1)}%)`);
    } else if (change24h > 5) {
      score += 4;
      confidence += 2;
    } else if (change24h < -10) {
      score -= 5;
      confidence += 3;
      signals.push(`Strong 24h selling (${change24h.toFixed(1)}%)`);
    } else if (change24h < -5) {
      score -= 4;
      confidence += 2;
    }

    // ─── 10. FEAR & GREED (Minor contrarian modifier only) ──────────
    // CRITICAL FIX: This was heavily biasing ALL signals before.
    // Now it's a minor modifier (+/- 3 score max) that only matters at extremes
    // Weight: up to ±3 score, up to 3 confidence
    if (fearGreed < 10) {
      score += 3;
      confidence += 3;
      signals.push(`Extreme fear index (${fearGreed}) - contrarian`);
    } else if (fearGreed < 25) {
      score += 1;
      confidence += 1;
    } else if (fearGreed > 90) {
      score -= 3;
      confidence += 3;
      signals.push(`Extreme greed index (${fearGreed}) - caution`);
    } else if (fearGreed > 75) {
      score -= 1;
      confidence += 1;
    }

    // ─── SIGNAL AGREEMENT ANALYSIS ──────────────────────────────────
    // Count how many factors agree vs disagree
    const bullishFactors = [
      emaTrend.trend.includes('up'),
      rsi < 45,
      macd.histogram > 0,
      divergence.type === 'bullish',
      bollinger.percentB < 0.3,
      volumeProfile.profile === 'confirming_up' || volumeProfile.buyPressure > 55
    ].filter(Boolean).length;

    const bearishFactors = [
      emaTrend.trend.includes('down'),
      rsi > 55,
      macd.histogram < 0,
      divergence.type === 'bearish',
      bollinger.percentB > 0.7,
      volumeProfile.profile === 'confirming_down' || volumeProfile.buyPressure < 45
    ].filter(Boolean).length;

    // Conflicting signals reduce confidence
    if (bullishFactors >= 2 && bearishFactors >= 2) {
      confidence -= 10;
      signals.push('Mixed signals - conflicting indicators');
    } else if (bullishFactors >= 4 || bearishFactors >= 4) {
      confidence += 10;
      signals.push(bullishFactors >= 4 ? 'Strong multi-factor bullish alignment' : 'Strong multi-factor bearish alignment');
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
    if (score >= 25) action = 'BUY';
    else if (score >= 15 && confidence >= 40) action = 'BUY'; // Lower score OK with high confidence
    else if (score <= -25) action = 'SELL';
    else if (score <= -15 && confidence >= 40) action = 'SELL';

    // Cap confidence at 85% (never claim near-certainty in crypto)
    confidence = Math.max(0, Math.min(85, Math.round(confidence)));

    // ─── SIGNAL STRENGTH LABEL ──────────────────────────────────────
    let strengthLabel = '';
    if (action === 'BUY') {
      if (score >= 50 && confidence >= 60) strengthLabel = 'STRONG BUY';
      else if (score >= 35 && confidence >= 45) strengthLabel = 'BUY';
      else strengthLabel = 'WEAK BUY';
    } else if (action === 'SELL') {
      if (score <= -50 && confidence >= 60) strengthLabel = 'STRONG SELL';
      else if (score <= -35 && confidence >= 45) strengthLabel = 'SELL';
      else strengthLabel = 'WEAK SELL';
    } else {
      strengthLabel = 'HOLD';
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
        atrPercent: atrPercent.toFixed(2)
      },
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
  calculateADX,
  detectEMATrend,
  detectRSIDivergence,
  calculateATR,
  analyzeVolumeProfile,
  detectBBSqueeze,
  generateSignalWithRealData
};
