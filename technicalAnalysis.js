// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - TECHNICAL ANALYSIS ENGINE (PROFESSIONAL)
// Implementación correcta de indicadores técnicos sin look-ahead bias
// ═══════════════════════════════════════════════════════════════════════════════

const axios = require('axios');

// Reusable HTTP client with proper headers
const apiClient = axios.create({
  headers: {
    'User-Agent': 'SentixPro/2.1 (Trading Dashboard)',
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

/**
 * Fetch historical OHLCV data with retry + fallback
 * Primary: CoinGecko, Fallback: CoinCap
 * @param {string} coinId - CoinGecko coin ID (e.g., 'bitcoin')
 * @param {number} days - Number of days of history (max 365 for free tier)
 * @returns {Promise<Array>} Array of {timestamp, price, volume}
 */
async function fetchHistoricalData(coinId, days = 30) {
  // Check cache first
  const cacheKey = `${coinId}-${days}`;
  const cached = historicalCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
    return cached.data;
  }

  let result = [];

  // Primary: CoinGecko
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
    const isRateLimit = error.response?.status === 429;
    console.warn(`⚠️ CoinGecko historical ${coinId}: ${error.message}${isRateLimit ? ' (rate limited)' : ''}`);
  }

  // Fallback: CoinCap if CoinGecko failed
  if (result.length === 0) {
    try {
      const coincapId = COINCAP_HISTORY_IDS[coinId] || coinId;
      const end = Date.now();
      const start = end - (days * 24 * 60 * 60 * 1000);
      const interval = days <= 7 ? 'h1' : 'd1';

      const response = await apiClient.get(
        `https://api.coincap.io/v2/assets/${coincapId}/history`,
        {
          params: { interval, start, end },
          timeout: 10000
        }
      );

      result = (response.data.data || []).map(d => ({
        timestamp: d.time,
        price: parseFloat(d.priceUsd) || 0,
        volume: 0 // CoinCap history doesn't include volume
      }));

      if (result.length > 0) {
        console.log(`✅ CoinCap fallback for ${coinId}: ${result.length} data points`);
      }
    } catch (fallbackError) {
      console.warn(`⚠️ CoinCap fallback ${coinId}: ${fallbackError.message}`);
    }
  }

  // Cache successful results
  if (result.length > 0) {
    historicalCache.set(cacheKey, { data: result, ts: Date.now() });
  } else {
    // Return cached data if available (even if stale)
    if (cached) {
      console.log(`⚠️ Using stale cache for ${coinId} historical data`);
      return cached.data;
    }
  }

  return result;
}

/**
 * Calculate Simple Moving Average (SMA)
 * @param {Array<number>} data - Price array
 * @param {number} period - Period length
 * @returns {Array<number>} SMA values
 */
function calculateSMA(data, period) {
  if (data.length < period) return [];
  
  const sma = [];
  for (let i = period - 1; i < data.length; i++) {
    const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    sma.push(sum / period);
  }
  return sma;
}

/**
 * Calculate Exponential Moving Average (EMA)
 * @param {Array<number>} data - Price array
 * @param {number} period - Period length
 * @returns {Array<number>} EMA values
 */
function calculateEMA(data, period) {
  if (data.length < period) return [];
  
  const k = 2 / (period + 1);
  const ema = [];
  
  // First EMA is SMA
  const firstSMA = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  ema.push(firstSMA);
  
  // Calculate subsequent EMAs
  for (let i = period; i < data.length; i++) {
    const value = data[i] * k + ema[ema.length - 1] * (1 - k);
    ema.push(value);
  }
  
  return ema;
}

/**
 * Calculate RSI (Relative Strength Index) - CORRECT IMPLEMENTATION
 * @param {Array<number>} prices - Price array
 * @param {number} period - Period length (default 14)
 * @returns {number} Current RSI value (0-100)
 */
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50; // Neutral if not enough data
  
  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }
  
  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? Math.abs(c) : 0);
  
  // Calculate average gain and loss
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  
  // Smooth with Wilder's smoothing method
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }
  
  if (avgLoss === 0) return 100;
  
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  
  return rsi;
}

/**
 * Calculate MACD (Moving Average Convergence Divergence) - CORRECT IMPLEMENTATION
 * @param {Array<number>} prices - Price array
 * @param {number} fastPeriod - Fast EMA period (default 12)
 * @param {number} slowPeriod - Slow EMA period (default 26)
 * @param {number} signalPeriod - Signal line EMA period (default 9)
 * @returns {Object} {macd, signal, histogram}
 */
function calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (prices.length < slowPeriod) {
    return { macd: 0, signal: 0, histogram: 0 };
  }
  
  // Calculate fast and slow EMAs
  const fastEMA = calculateEMA(prices, fastPeriod);
  const slowEMA = calculateEMA(prices, slowPeriod);
  
  // MACD line = Fast EMA - Slow EMA
  // Align arrays (slow EMA starts later)
  const macdLine = [];
  const offset = slowPeriod - fastPeriod;
  
  for (let i = 0; i < slowEMA.length; i++) {
    macdLine.push(fastEMA[i + offset] - slowEMA[i]);
  }
  
  // Signal line = EMA of MACD line
  const signalLine = calculateEMA(macdLine, signalPeriod);
  
  // Get current values
  const currentMACD = macdLine[macdLine.length - 1] || 0;
  const currentSignal = signalLine[signalLine.length - 1] || 0;
  const histogram = currentMACD - currentSignal;
  
  return {
    macd: currentMACD,
    signal: currentSignal,
    histogram: histogram
  };
}

/**
 * Calculate Bollinger Bands - CORRECT IMPLEMENTATION
 * @param {Array<number>} prices - Price array
 * @param {number} period - Period length (default 20)
 * @param {number} stdDev - Standard deviation multiplier (default 2)
 * @returns {Object} {upper, middle, lower, bandwidth}
 */
function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  if (prices.length < period) {
    const price = prices[prices.length - 1] || 0;
    return { upper: price, middle: price, lower: price, bandwidth: 0 };
  }
  
  const sma = calculateSMA(prices, period);
  const currentSMA = sma[sma.length - 1];
  
  // Calculate standard deviation of last 'period' prices
  const recentPrices = prices.slice(-period);
  const variance = recentPrices.reduce((sum, price) => {
    return sum + Math.pow(price - currentSMA, 2);
  }, 0) / period;
  
  const standardDeviation = Math.sqrt(variance);
  
  const upper = currentSMA + (stdDev * standardDeviation);
  const lower = currentSMA - (stdDev * standardDeviation);
  const bandwidth = ((upper - lower) / currentSMA) * 100;
  
  return {
    upper,
    middle: currentSMA,
    lower,
    bandwidth
  };
}

/**
 * Calculate support and resistance levels using pivot points
 * @param {Array<Object>} historicalData - Array of {price} objects
 * @returns {Object} {support, resistance}
 */
function calculateSupportResistance(historicalData) {
  if (historicalData.length < 3) {
    const price = historicalData[historicalData.length - 1]?.price || 0;
    return { support: price * 0.95, resistance: price * 1.05 };
  }
  
  const prices = historicalData.map(d => d.price);
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const close = prices[prices.length - 1];
  
  // Pivot point
  const pivot = (high + low + close) / 3;
  
  // Support and resistance levels
  const resistance1 = (2 * pivot) - low;
  const support1 = (2 * pivot) - high;
  
  return {
    support: support1,
    resistance: resistance1,
    pivot
  };
}

/**
 * Generate trading signals based on real technical analysis
 * @param {string} asset - Asset ID
 * @param {number} currentPrice - Current price
 * @param {number} change24h - 24h change percentage
 * @param {number} volume - Current volume
 * @param {number} fearGreed - Fear & Greed index
 * @returns {Promise<Object>} Trading signal with score and confidence
 */
async function generateSignalWithRealData(asset, currentPrice, change24h, volume, fearGreed) {
  try {
    // Fetch 30 days of historical data
    const historicalData = await fetchHistoricalData(asset, 30);
    
    if (historicalData.length < 14) {
      // Not enough data, return neutral signal
      return {
        asset: asset.toUpperCase(),
        action: 'HOLD',
        score: 50,
        confidence: 30,
        price: currentPrice,
        change24h,
        reasons: 'Insufficient historical data for technical analysis',
        timestamp: new Date().toISOString()
      };
    }
    
    const prices = historicalData.map(d => d.price);
    
    // Calculate technical indicators with REAL data
    const rsi = calculateRSI(prices, 14);
    const macd = calculateMACD(prices, 12, 26, 9);
    const bollinger = calculateBollingerBands(prices, 20, 2);
    const supportResistance = calculateSupportResistance(historicalData);
    
    // Initialize scoring
    let score = 50; // Neutral base
    let signals = [];
    let confidence = 50;
    
    // ─── RSI ANALYSIS (graduated scoring) ────────────────────────────
    if (rsi < 20) {
      score += 18;
      signals.push(`RSI deeply oversold (${rsi.toFixed(1)})`);
      confidence += 12;
    } else if (rsi < 30) {
      score += 14;
      signals.push(`RSI oversold (${rsi.toFixed(1)})`);
      confidence += 10;
    } else if (rsi < 40) {
      score += 6;
      signals.push(`RSI leaning bullish (${rsi.toFixed(1)})`);
      confidence += 5;
    } else if (rsi > 80) {
      score -= 18;
      signals.push(`RSI deeply overbought (${rsi.toFixed(1)})`);
      confidence += 12;
    } else if (rsi > 70) {
      score -= 14;
      signals.push(`RSI overbought (${rsi.toFixed(1)})`);
      confidence += 10;
    } else if (rsi > 60) {
      score -= 6;
      signals.push(`RSI leaning bearish (${rsi.toFixed(1)})`);
      confidence += 5;
    } else {
      signals.push(`RSI neutral (${rsi.toFixed(1)})`);
      confidence += 3;
    }

    // ─── MACD ANALYSIS ───────────────────────────────────────────────
    if (macd.histogram > 0 && macd.macd > macd.signal) {
      score += 12;
      signals.push('MACD bullish crossover');
      confidence += 8;
    } else if (macd.histogram < 0 && macd.macd < macd.signal) {
      score -= 12;
      signals.push('MACD bearish crossover');
      confidence += 8;
    } else if (macd.histogram > 0) {
      score += 5;
      signals.push('MACD positive histogram');
      confidence += 4;
    } else if (macd.histogram < 0) {
      score -= 5;
      signals.push('MACD negative histogram');
      confidence += 4;
    }

    // ─── BOLLINGER BANDS ANALYSIS ────────────────────────────────────
    if (currentPrice <= bollinger.lower) {
      score += 10;
      signals.push('Price at lower Bollinger Band');
      confidence += 7;
    } else if (currentPrice >= bollinger.upper) {
      score -= 10;
      signals.push('Price at upper Bollinger Band');
      confidence += 7;
    } else if (bollinger.bandwidth > 0) {
      // Price position within bands (more granular)
      const bandPosition = (currentPrice - bollinger.lower) / (bollinger.upper - bollinger.lower);
      if (bandPosition < 0.3) {
        score += 5;
        signals.push('Price near lower Bollinger range');
        confidence += 3;
      } else if (bandPosition > 0.7) {
        score -= 5;
        signals.push('Price near upper Bollinger range');
        confidence += 3;
      }
    }

    // ─── SUPPORT/RESISTANCE ANALYSIS ─────────────────────────────────
    if (currentPrice <= supportResistance.support * 1.02) {
      score += 8;
      signals.push('Near support level');
      confidence += 5;
    } else if (currentPrice >= supportResistance.resistance * 0.98) {
      score -= 8;
      signals.push('Near resistance level');
      confidence += 5;
    }

    // ─── MOMENTUM ANALYSIS (graduated) ───────────────────────────────
    if (change24h > 8) {
      score += 10;
      signals.push(`Very strong upward momentum (+${change24h.toFixed(1)}%)`);
      confidence += 5;
    } else if (change24h > 3) {
      score += 6;
      signals.push(`Upward momentum (+${change24h.toFixed(1)}%)`);
      confidence += 3;
    } else if (change24h < -8) {
      score -= 10;
      signals.push(`Very strong downward momentum (${change24h.toFixed(1)}%)`);
      confidence += 5;
    } else if (change24h < -3) {
      score -= 6;
      signals.push(`Downward momentum (${change24h.toFixed(1)}%)`);
      confidence += 3;
    }

    // ─── VOLUME ANALYSIS ─────────────────────────────────────────────
    const recentVolumes = historicalData.slice(-7);
    if (recentVolumes.length >= 3) {
      const avgVolume = recentVolumes.reduce((sum, d) => sum + d.volume, 0) / recentVolumes.length;
      if (avgVolume > 0 && volume > avgVolume * 1.5) {
        score += 5;
        signals.push('High volume confirmation');
        confidence += 5;
      } else if (avgVolume > 0 && volume > avgVolume * 1.2) {
        score += 2;
        signals.push('Above-average volume');
        confidence += 2;
      }
    }

    // ─── FEAR & GREED ANALYSIS (graduated) ───────────────────────────
    if (fearGreed < 15) {
      score += 8;
      signals.push('Extreme fear (strong contrarian buy)');
      confidence += 5;
    } else if (fearGreed < 30) {
      score += 4;
      signals.push('Fear zone (contrarian buy)');
      confidence += 3;
    } else if (fearGreed > 85) {
      score -= 8;
      signals.push('Extreme greed (strong caution)');
      confidence += 5;
    } else if (fearGreed > 70) {
      score -= 4;
      signals.push('Greed zone (caution)');
      confidence += 3;
    }

    // ─── TREND CONSISTENCY BONUS ─────────────────────────────────────
    // If multiple indicators agree, boost confidence
    const bullishIndicators = signals.filter(s =>
      s.includes('oversold') || s.includes('bullish') || s.includes('support') ||
      s.includes('lower Bollinger') || s.includes('upward')
    ).length;
    const bearishIndicators = signals.filter(s =>
      s.includes('overbought') || s.includes('bearish') || s.includes('resistance') ||
      s.includes('upper Bollinger') || s.includes('downward')
    ).length;

    if (bullishIndicators >= 3) {
      confidence += 8;
      signals.push('Multiple bullish confirmations');
    } else if (bearishIndicators >= 3) {
      confidence += 8;
      signals.push('Multiple bearish confirmations');
    }

    // ─── DETERMINE ACTION ────────────────────────────────────────────
    // Adjusted thresholds: BUY >= 62, SELL <= 38 (was 70/30 - too restrictive)
    let action = 'HOLD';
    if (score >= 62) action = 'BUY';
    else if (score <= 38) action = 'SELL';

    // Cap confidence at 95%
    confidence = Math.min(confidence, 95);
    
    return {
      asset: asset.toUpperCase(),
      action,
      score: Math.round(score),
      confidence: Math.round(confidence),
      price: currentPrice,
      change24h,
      reasons: signals.join(' • '),
      indicators: {
        rsi: rsi.toFixed(1),
        macd: macd.histogram.toFixed(4),
        bollinger: {
          position: currentPrice > bollinger.upper ? 'above' : currentPrice < bollinger.lower ? 'below' : 'within'
        }
      },
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error(`Error generating signal for ${asset}:`, error.message);
    return {
      asset: asset.toUpperCase(),
      action: 'HOLD',
      score: 50,
      confidence: 20,
      price: currentPrice,
      change24h,
      reasons: 'Error in technical analysis',
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = {
  fetchHistoricalData,
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateSupportResistance,
  generateSignalWithRealData
};
