// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - Backtesting Module
// Validates signal engine against historical data from Binance
// ═══════════════════════════════════════════════════════════════════════════════

const { logger } = require('./logger');
const axios = require('axios');
const { fetchKlines, SYMBOL_MAP, FUTURES_SYMBOL_MAP } = require('./binanceAPI');
const { generateMultiTimeframeSignal } = require('./technicalAnalysis');
const { evaluateSignalForTrade, calculatePositionSize, DEFAULT_CONFIG } = require('./paperTrading');
const { SLIPPAGE, COMMISSION, TOTAL_COST } = require('./constants');
const { runMonteCarloSimulation } = require('./monteCarloSim');
const { runStatisticalTests } = require('./statisticalTests');

// ─── CONSTANTS ──────────────────────────────────────────────────────────────

const INTERVAL_MS = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000
};

// Minimum candles needed for indicator calculation
const MIN_LOOKBACK = {
  '15m': 288,  // 3 days of 15m
  '1h': 200,   // ~8 days of 1h
  '4h': 100    // ~17 days of 4h
};

// Macro data cache (avoids re-fetch during optimizer grid iterations)
let _btcDomCache = { data: [], expiry: 0 };
let _dxyCache = { data: [], expiry: 0 };
const MACRO_CACHE_TTL = 10 * 60 * 1000; // 10 min

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORICAL DATA FETCHING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch historical candles from Binance with pagination
 * @param {string} asset - CoinGecko ID (e.g., 'bitcoin')
 * @param {string} interval - Candle interval ('15m', '1h', '4h')
 * @param {number} days - Number of days of history
 * @returns {Promise<Array>} Array of candle objects
 */
async function fetchHistoricalCandles(asset, interval, days) {
  const symbol = SYMBOL_MAP[asset];
  if (!symbol) {
    throw new Error(`No Binance symbol mapping for asset: ${asset}`);
  }

  const intervalMs = INTERVAL_MS[interval];
  if (!intervalMs) {
    throw new Error(`Invalid interval: ${interval}`);
  }

  const now = Date.now();
  const startTime = now - (days * 24 * 60 * 60 * 1000);
  const totalCandles = Math.ceil((now - startTime) / intervalMs);
  const batchSize = 1000; // Binance max per request

  let allCandles = [];
  let currentStart = startTime;

  logger.info('Fetching historical candles', {
    asset, symbol, interval, days,
    totalCandles, batches: Math.ceil(totalCandles / batchSize)
  });

  let retryCount = 0;
  const MAX_RETRIES = 3;

  while (currentStart < now) {
    try {
      const candles = await fetchKlines(symbol, interval, batchSize, currentStart, now);

      if (!candles || candles.length === 0) break;

      allCandles = allCandles.concat(candles);
      retryCount = 0; // Reset on success

      // Move start to after the last candle
      const lastTimestamp = candles[candles.length - 1].timestamp;
      currentStart = lastTimestamp + intervalMs;

      // Rate limit protection
      if (currentStart < now) {
        await new Promise(r => setTimeout(r, 700));
      }
    } catch (err) {
      const msg = err.message || '';
      const status = err.response?.status;

      if (msg.includes('Rate limited') || status === 429) {
        logger.warn('Rate limited during historical fetch, waiting 10s');
        await new Promise(r => setTimeout(r, 10000));
        continue; // Retry same batch
      }

      // Geo-block (451) or all endpoints unavailable — retry with backoff
      if (status === 451 || status === 403 || msg.includes('unavailable') || msg.includes('451')) {
        retryCount++;
        if (retryCount <= MAX_RETRIES) {
          const waitMs = retryCount * 5000;
          logger.warn(`Binance fetch failed (${status || msg}), retry ${retryCount}/${MAX_RETRIES} in ${waitMs / 1000}s`);
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        logger.error('Binance fetch failed after max retries', { asset, interval, retryCount });
      }

      throw err;
    }
  }

  // Remove duplicates (overlapping batches)
  const seen = new Set();
  allCandles = allCandles.filter(c => {
    if (seen.has(c.timestamp)) return false;
    seen.add(c.timestamp);
    return true;
  });

  // Sort by timestamp
  allCandles.sort((a, b) => a.timestamp - b.timestamp);

  if (allCandles.length > 0) {
    logger.info('Historical candles fetched', {
      asset, interval, candles: allCandles.length,
      from: new Date(allCandles[0].timestamp).toISOString(),
      to: new Date(allCandles[allCandles.length - 1].timestamp).toISOString()
    });
  } else {
    logger.warn('No historical candles returned', { asset, interval });
  }

  return allCandles;
}

/**
 * Fetch all three timeframes needed for multi-TF signals
 */
async function fetchAllTimeframes(asset, days) {
  // Add extra lookback for indicators
  const extraDays = 20; // Extra days for indicator warm-up
  const totalDays = days + extraDays;

  logger.info('Fetching all timeframes', { asset, days: totalDays });

  // Fetch sequentially to respect rate limits
  const candles4h = await fetchHistoricalCandles(asset, '4h', totalDays);
  await new Promise(r => setTimeout(r, 1000));
  const candles1h = await fetchHistoricalCandles(asset, '1h', totalDays);
  await new Promise(r => setTimeout(r, 1000));
  const candles15m = await fetchHistoricalCandles(asset, '15m', totalDays);

  return { '4h': candles4h, '1h': candles1h, '15m': candles15m };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORICAL CONTEXT DATA (Fear & Greed, Funding Rates)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch historical Fear & Greed Index from Alternative.me
 * @param {number} days - Number of days of history
 * @returns {Promise<Array>} Array of { timestamp, value } sorted ascending
 */
async function fetchHistoricalFearGreed(days) {
  try {
    const limit = Math.min(days + 10, 1000); // API max ~1000
    const res = await axios.get(`https://api.alternative.me/fng/?limit=${limit}&date_format=world`, {
      timeout: 15000
    });

    if (!res.data?.data || !Array.isArray(res.data.data)) {
      logger.warn('Fear & Greed API returned unexpected format');
      return [];
    }

    // API returns newest first; each entry: { value: "25", timestamp: "1234567890" }
    const points = res.data.data
      .map(d => ({
        timestamp: parseInt(d.timestamp) * 1000, // Convert to ms
        value: parseInt(d.value)
      }))
      .filter(d => !isNaN(d.timestamp) && !isNaN(d.value))
      .sort((a, b) => a.timestamp - b.timestamp);

    logger.info('Historical Fear & Greed fetched', {
      points: points.length,
      from: points.length > 0 ? new Date(points[0].timestamp).toISOString().slice(0, 10) : 'N/A',
      to: points.length > 0 ? new Date(points[points.length - 1].timestamp).toISOString().slice(0, 10) : 'N/A'
    });

    return points;
  } catch (err) {
    logger.warn('Failed to fetch historical Fear & Greed', { error: err.message });
    return [];
  }
}

/**
 * Fetch historical funding rates from Binance Futures
 * @param {string} asset - CoinGecko ID (e.g., 'bitcoin')
 * @param {number} startMs - Start timestamp in ms
 * @param {number} endMs - End timestamp in ms
 * @returns {Promise<Array>} Array of { timestamp, fundingRate } sorted ascending
 */
async function fetchHistoricalFundingRate(asset, startMs, endMs) {
  const futuresSymbol = FUTURES_SYMBOL_MAP[asset];
  if (!futuresSymbol) {
    logger.debug('No futures symbol for asset, skipping funding rate', { asset });
    return [];
  }

  try {
    const allRates = [];
    let currentStart = startMs;
    const batchSize = 1000;

    // Paginate through funding rate history (8h intervals)
    while (currentStart < endMs) {
      const res = await axios.get('https://fapi.binance.com/fapi/v1/fundingRate', {
        params: {
          symbol: futuresSymbol,
          startTime: currentStart,
          endTime: endMs,
          limit: batchSize
        },
        timeout: 15000
      });

      if (!Array.isArray(res.data) || res.data.length === 0) break;

      for (const r of res.data) {
        allRates.push({
          timestamp: r.fundingTime,
          fundingRate: parseFloat(r.fundingRate)
        });
      }

      // Move past last result
      currentStart = res.data[res.data.length - 1].fundingTime + 1;

      // Rate limit courtesy
      if (res.data.length === batchSize) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    allRates.sort((a, b) => a.timestamp - b.timestamp);

    logger.info('Historical funding rates fetched', {
      asset, futuresSymbol, points: allRates.length,
      from: allRates.length > 0 ? new Date(allRates[0].timestamp).toISOString().slice(0, 10) : 'N/A',
      to: allRates.length > 0 ? new Date(allRates[allRates.length - 1].timestamp).toISOString().slice(0, 10) : 'N/A'
    });

    return allRates;
  } catch (err) {
    logger.warn('Failed to fetch historical funding rates', { asset, error: err.message });
    return [];
  }
}

/**
 * Fetch historical BTC dominance using "Anchor + Drift" model.
 * Gets current BTC dominance from CoinGecko /global, then uses historical
 * BTC market cap to estimate past dominance with dampened drift.
 * @param {number} days - Number of days of history
 * @returns {Promise<Array>} Array of { timestamp, btcDom, btcMcap } sorted ascending
 */
async function fetchHistoricalBtcDominance(days) {
  // Check cache first
  if (_btcDomCache.data.length > 0 && Date.now() < _btcDomCache.expiry) {
    logger.debug('Using cached BTC dominance data', { points: _btcDomCache.data.length });
    return _btcDomCache.data;
  }

  try {
    // Step 1: Get current BTC dominance
    const globalRes = await axios.get('https://api.coingecko.com/api/v3/global', { timeout: 15000 });
    const currentDom = globalRes.data?.data?.market_cap_percentage?.btc;
    if (!currentDom || typeof currentDom !== 'number') {
      logger.warn('CoinGecko /global returned no BTC dominance');
      return [];
    }

    // Rate limit courtesy before next CoinGecko call
    await new Promise(r => setTimeout(r, 1500));

    // Step 2: Get historical BTC market cap
    const mcapRes = await axios.get('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart', {
      params: { vs_currency: 'usd', days: Math.min(days, 365) },
      timeout: 15000
    });

    const mcaps = mcapRes.data?.market_caps;
    if (!Array.isArray(mcaps) || mcaps.length < 2) {
      logger.warn('CoinGecko market_chart returned insufficient data');
      return [];
    }

    // Step 3: Anchor + Drift — estimate historical dominance
    // currentMcap is the latest market cap point
    const currentMcap = mcaps[mcaps.length - 1][1];
    const DAMPENING = 0.3; // Total market moves in same direction as BTC

    const points = mcaps.map(([ts, mcap]) => {
      const mcapRatio = mcap / currentMcap;
      // btcDom drifts proportionally (dampened) to how much BTC mcap changed
      let btcDom = currentDom * (1 + DAMPENING * (mcapRatio - 1));
      btcDom = Math.max(30, Math.min(75, btcDom)); // Clamp to realistic range
      return {
        timestamp: ts,
        btcDom: parseFloat(btcDom.toFixed(2)),
        btcMcap: mcap
      };
    }).sort((a, b) => a.timestamp - b.timestamp);

    logger.info('Historical BTC dominance estimated (Anchor+Drift)', {
      points: points.length,
      currentDom: currentDom.toFixed(2),
      from: new Date(points[0].timestamp).toISOString().slice(0, 10),
      to: new Date(points[points.length - 1].timestamp).toISOString().slice(0, 10)
    });

    // Cache for optimizer
    _btcDomCache = { data: points, expiry: Date.now() + MACRO_CACHE_TTL };
    return points;
  } catch (err) {
    logger.warn('Failed to fetch historical BTC dominance', { error: err.message });
    return [];
  }
}

/**
 * Fetch historical DXY proxy using EUR/USD from Frankfurter API (ECB data).
 * Uses same formula as live: dxy = (1 / eurUsd) * 120
 * @param {number} days - Number of days of history
 * @returns {Promise<Array>} Array of { timestamp, dxy, dxyTrend, dxyChange } sorted ascending
 */
async function fetchHistoricalDXY(days) {
  // Check cache first
  if (_dxyCache.data.length > 0 && Date.now() < _dxyCache.expiry) {
    logger.debug('Using cached DXY data', { points: _dxyCache.data.length });
    return _dxyCache.data;
  }

  try {
    const endDate = new Date();
    const startDate = new Date(Date.now() - (days * 24 * 60 * 60 * 1000));
    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    const res = await axios.get(`https://api.frankfurter.app/${startStr}..${endStr}`, {
      params: { from: 'USD', to: 'EUR' },
      timeout: 15000
    });

    const rates = res.data?.rates;
    if (!rates || typeof rates !== 'object') {
      logger.warn('Frankfurter API returned no rates');
      return [];
    }

    // Convert daily EUR/USD rates to DXY proxy points
    const entries = Object.entries(rates).sort(([a], [b]) => a.localeCompare(b));
    const points = [];

    for (let i = 0; i < entries.length; i++) {
      const [dateStr, rateObj] = entries[i];
      const eurRate = rateObj.EUR;
      if (!eurRate || eurRate <= 0) continue;

      // Same formula as server.js: dxy = (1 / eurUsd) * 120
      // eurRate here is EUR per 1 USD, so dxy = eurRate * 120
      const dxy = parseFloat((eurRate * 120).toFixed(2));
      const ts = new Date(dateStr + 'T12:00:00Z').getTime(); // Noon UTC

      // Compute trend vs previous day
      let dxyTrend = 'stable';
      let dxyChange = 0;
      if (i > 0) {
        const prevEur = entries[i - 1][1].EUR;
        if (prevEur && prevEur > 0) {
          const prevDxy = prevEur * 120;
          dxyChange = parseFloat(((dxy - prevDxy) / prevDxy * 100).toFixed(3));
          if (dxyChange > 0.05) dxyTrend = 'rising';
          else if (dxyChange < -0.05) dxyTrend = 'falling';
        }
      }

      points.push({ timestamp: ts, dxy, dxyTrend, dxyChange });
    }

    logger.info('Historical DXY proxy fetched (EUR/USD via Frankfurter)', {
      points: points.length,
      from: points.length > 0 ? new Date(points[0].timestamp).toISOString().slice(0, 10) : 'N/A',
      to: points.length > 0 ? new Date(points[points.length - 1].timestamp).toISOString().slice(0, 10) : 'N/A'
    });

    // Cache for optimizer
    _dxyCache = { data: points, expiry: Date.now() + MACRO_CACHE_TTL };
    return points;
  } catch (err) {
    logger.warn('Failed to fetch historical DXY', { error: err.message });
    return [];
  }
}

/**
 * Lookup the closest historical value by timestamp (binary search)
 * @param {Array} sortedData - Sorted array with .timestamp property
 * @param {number} targetTs - Target timestamp in ms
 * @returns {Object|null} Closest entry or null
 */
function lookupByTimestamp(sortedData, targetTs) {
  if (!sortedData || sortedData.length === 0) return null;

  let lo = 0, hi = sortedData.length - 1;

  // If target is before all data, use first point
  if (targetTs <= sortedData[0].timestamp) return sortedData[0];
  // If target is after all data, use last point
  if (targetTs >= sortedData[hi].timestamp) return sortedData[hi];

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (sortedData[mid].timestamp === targetTs) return sortedData[mid];
    if (sortedData[mid].timestamp < targetTs) lo = mid + 1;
    else hi = mid - 1;
  }

  // Return the closest of lo and hi
  if (lo >= sortedData.length) return sortedData[hi];
  if (hi < 0) return sortedData[lo];
  return Math.abs(sortedData[lo].timestamp - targetTs) < Math.abs(sortedData[hi].timestamp - targetTs)
    ? sortedData[lo] : sortedData[hi];
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE SIMULATION (Pure - no DB)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simulate a trade through subsequent candles using high/low for realism
 * @param {Object} trade - Trade object with entry, SL, TP levels
 * @param {Array} candles - 1h candles for tick-by-tick simulation
 * @param {number} startIndex - Index in candles where trade was opened
 * @returns {Object} Trade result
 */
function simulateTradeExecution(trade, candles, startIndex) {
  const isLong = trade.direction === 'LONG';
  const entryPrice = trade.entryPrice;
  const stopLoss = trade.stopLoss;
  const tp1 = trade.takeProfit1;
  const tp2 = trade.takeProfit2;
  const trailingActivation = trade.trailingActivation;
  const trailingDistance = Math.abs(entryPrice - trade.trailingStop);

  let status = 'open'; // open → partial → closed
  let trailingActive = false;
  let trailingStopCurrent = trade.trailingStop;
  let peakPrice = entryPrice;
  let quantity = trade.quantity;
  let remainingQty = quantity;
  let partialPnl = 0;
  let partialClosePrice = null;
  let partialCloseIndex = null;
  let maxFavorable = 0;
  let maxAdverse = 0;

  for (let i = startIndex + 1; i < candles.length; i++) {
    const candle = candles[i];
    const high = candle.high;
    const low = candle.low;

    if (isLong) {
      // Update peak for trailing
      if (high > peakPrice) peakPrice = high;

      // Update max favorable/adverse
      const bestCase = (high - entryPrice) * remainingQty;
      const worstCase = (low - entryPrice) * remainingQty;
      maxFavorable = Math.max(maxFavorable, bestCase + partialPnl);
      maxAdverse = Math.min(maxAdverse, worstCase);

      // CONSERVATIVE: Check SL first (if same candle hits both, SL wins)
      // Gap-through: if low < stopLoss, price gapped through → worse fill
      if (low <= stopLoss) {
        const gapFill = low < stopLoss ? (stopLoss + low) / 2 : stopLoss; // Model gap slippage
        const exitPrice = gapFill * (1 - TOTAL_COST); // Slippage + commission on exit
        const pnl = ((exitPrice - entryPrice) * remainingQty) + partialPnl;
        return {
          exitIndex: i,
          exitTimestamp: candle.timestamp,
          exitPrice,
          exitReason: 'stop_loss',
          pnl: Math.round(pnl * 100) / 100,
          pnlPercent: Math.round((pnl / trade.positionSizeUsd) * 10000) / 100,
          maxFavorable: Math.round(maxFavorable * 100) / 100,
          maxAdverse: Math.round(maxAdverse * 100) / 100,
          holdingBars: i - startIndex,
          partialClosePrice,
          partialCloseIndex
        };
      }

      // Check trailing stop (if active)
      if (trailingActive && low <= trailingStopCurrent) {
        const exitPrice = trailingStopCurrent * (1 - TOTAL_COST);
        const pnl = ((exitPrice - entryPrice) * remainingQty) + partialPnl;
        return {
          exitIndex: i, exitTimestamp: candle.timestamp, exitPrice,
          exitReason: 'trailing_stop',
          pnl: Math.round(pnl * 100) / 100,
          pnlPercent: Math.round((pnl / trade.positionSizeUsd) * 10000) / 100,
          maxFavorable: Math.round(maxFavorable * 100) / 100,
          maxAdverse: Math.round(maxAdverse * 100) / 100,
          holdingBars: i - startIndex, partialClosePrice, partialCloseIndex
        };
      }

      // Check TP1 (partial close - 50%)
      if (status === 'open' && high >= tp1) {
        const closePrice = tp1 * (1 - TOTAL_COST);
        const closeQty = quantity / 2;
        partialPnl = (closePrice - entryPrice) * closeQty;
        remainingQty = quantity - closeQty;
        status = 'partial';
        partialClosePrice = closePrice;
        partialCloseIndex = i;
      }

      // Check TP2 (full close of remaining)
      if (status === 'partial' && tp2 && high >= tp2) {
        const exitPrice = tp2 * (1 - TOTAL_COST);
        const pnl = ((exitPrice - entryPrice) * remainingQty) + partialPnl;
        return {
          exitIndex: i, exitTimestamp: candle.timestamp, exitPrice,
          exitReason: 'take_profit_2',
          pnl: Math.round(pnl * 100) / 100,
          pnlPercent: Math.round((pnl / trade.positionSizeUsd) * 10000) / 100,
          maxFavorable: Math.round(maxFavorable * 100) / 100,
          maxAdverse: Math.round(maxAdverse * 100) / 100,
          holdingBars: i - startIndex, partialClosePrice, partialCloseIndex
        };
      }

      // Activate trailing
      if (!trailingActive && trailingActivation && high >= trailingActivation) {
        trailingActive = true;
        trailingStopCurrent = peakPrice - trailingDistance;
      }

      // Update trailing stop as peak moves up
      if (trailingActive) {
        const newTrailingStop = peakPrice - trailingDistance;
        if (newTrailingStop > trailingStopCurrent) {
          trailingStopCurrent = newTrailingStop;
        }
      }

    } else {
      // SHORT - everything inverted
      if (low < peakPrice) peakPrice = low;

      const bestCase = (entryPrice - low) * remainingQty;
      const worstCase = (entryPrice - high) * remainingQty;
      maxFavorable = Math.max(maxFavorable, bestCase + partialPnl);
      maxAdverse = Math.min(maxAdverse, worstCase);

      // SL (price goes UP) — gap-through modeling
      if (high >= stopLoss) {
        const gapFill = high > stopLoss ? (stopLoss + high) / 2 : stopLoss;
        const exitPrice = gapFill * (1 + TOTAL_COST);
        const pnl = ((entryPrice - exitPrice) * remainingQty) + partialPnl;
        return {
          exitIndex: i, exitTimestamp: candle.timestamp, exitPrice,
          exitReason: 'stop_loss',
          pnl: Math.round(pnl * 100) / 100,
          pnlPercent: Math.round((pnl / trade.positionSizeUsd) * 10000) / 100,
          maxFavorable: Math.round(maxFavorable * 100) / 100,
          maxAdverse: Math.round(maxAdverse * 100) / 100,
          holdingBars: i - startIndex, partialClosePrice, partialCloseIndex
        };
      }

      // Trailing stop (price goes UP)
      if (trailingActive && high >= trailingStopCurrent) {
        const exitPrice = trailingStopCurrent * (1 + TOTAL_COST);
        const pnl = ((entryPrice - exitPrice) * remainingQty) + partialPnl;
        return {
          exitIndex: i, exitTimestamp: candle.timestamp, exitPrice,
          exitReason: 'trailing_stop',
          pnl: Math.round(pnl * 100) / 100,
          pnlPercent: Math.round((pnl / trade.positionSizeUsd) * 10000) / 100,
          maxFavorable: Math.round(maxFavorable * 100) / 100,
          maxAdverse: Math.round(maxAdverse * 100) / 100,
          holdingBars: i - startIndex, partialClosePrice, partialCloseIndex
        };
      }

      // TP1 (price goes DOWN)
      if (status === 'open' && low <= tp1) {
        const closePrice = tp1 * (1 + TOTAL_COST);
        const closeQty = quantity / 2;
        partialPnl = (entryPrice - closePrice) * closeQty;
        remainingQty = quantity - closeQty;
        status = 'partial';
        partialClosePrice = closePrice;
        partialCloseIndex = i;
      }

      // TP2 (price goes DOWN)
      if (status === 'partial' && tp2 && low <= tp2) {
        const exitPrice = tp2 * (1 + TOTAL_COST);
        const pnl = ((entryPrice - exitPrice) * remainingQty) + partialPnl;
        return {
          exitIndex: i, exitTimestamp: candle.timestamp, exitPrice,
          exitReason: 'take_profit_2',
          pnl: Math.round(pnl * 100) / 100,
          pnlPercent: Math.round((pnl / trade.positionSizeUsd) * 10000) / 100,
          maxFavorable: Math.round(maxFavorable * 100) / 100,
          maxAdverse: Math.round(maxAdverse * 100) / 100,
          holdingBars: i - startIndex, partialClosePrice, partialCloseIndex
        };
      }

      // Activate trailing (price goes DOWN)
      if (!trailingActive && trailingActivation && low <= trailingActivation) {
        trailingActive = true;
        trailingStopCurrent = peakPrice + trailingDistance;
      }

      // Update trailing stop as peak moves down
      if (trailingActive) {
        const newTrailingStop = peakPrice + trailingDistance;
        if (newTrailingStop < trailingStopCurrent) {
          trailingStopCurrent = newTrailingStop;
        }
      }
    }
  }

  // Trade still open at end of backtest — close at last price
  const lastCandle = candles[candles.length - 1];
  const exitPrice = lastCandle.close;
  let pnl;
  if (isLong) {
    pnl = ((exitPrice - entryPrice) * remainingQty) + partialPnl;
  } else {
    pnl = ((entryPrice - exitPrice) * remainingQty) + partialPnl;
  }

  return {
    exitIndex: candles.length - 1,
    exitTimestamp: lastCandle.timestamp,
    exitPrice,
    exitReason: 'end_of_data',
    pnl: Math.round(pnl * 100) / 100,
    pnlPercent: Math.round((pnl / trade.positionSizeUsd) * 10000) / 100,
    maxFavorable: Math.round(maxFavorable * 100) / 100,
    maxAdverse: Math.round(maxAdverse * 100) / 100,
    holdingBars: candles.length - 1 - startIndex,
    partialClosePrice, partialCloseIndex
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKTEST METRICS
// ═══════════════════════════════════════════════════════════════════════════════

function calculateBacktestMetrics(completedTrades, equityCurve, initialCapital, days) {
  if (!completedTrades || completedTrades.length === 0) {
    return {
      totalTrades: 0, winCount: 0, lossCount: 0, winRate: 0,
      totalPnl: 0, totalPnlPercent: 0,
      avgProfit: 0, avgLoss: 0,
      bestTrade: null, worstTrade: null,
      maxDrawdown: 0, maxDrawdownPercent: 0,
      profitFactor: 0, sharpeRatio: 0,
      avgHoldingBars: 0, tradesPerMonth: 0,
      maxConsecutiveWins: 0, maxConsecutiveLosses: 0
    };
  }

  const wins = completedTrades.filter(t => t.pnl > 0);
  const losses = completedTrades.filter(t => t.pnl <= 0);
  const totalPnl = completedTrades.reduce((sum, t) => sum + t.pnl, 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));

  // Max drawdown from equity curve
  let peak = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = peak - point.equity;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownPercent = ddPct;
    }
  }

  // Sharpe ratio — computed from daily equity returns (not per-trade)
  // Uses sample std dev (N-1), annualized with 365 (crypto trades 24/7), risk-free rate ~4.5%
  let sharpeRatio = 0;
  if (equityCurve.length >= 3) {
    // Build daily equity snapshots from the equity curve
    const dayMs = 24 * 60 * 60 * 1000;
    const dailyEquity = [];
    let lastDay = -1;
    for (const point of equityCurve) {
      const dayNum = Math.floor(point.timestamp / dayMs);
      if (dayNum !== lastDay) {
        dailyEquity.push(point.equity);
        lastDay = dayNum;
      } else {
        dailyEquity[dailyEquity.length - 1] = point.equity; // keep last value of the day
      }
    }

    if (dailyEquity.length >= 2) {
      const dailyReturns = [];
      for (let i = 1; i < dailyEquity.length; i++) {
        if (dailyEquity[i - 1] > 0) {
          dailyReturns.push((dailyEquity[i] - dailyEquity[i - 1]) / dailyEquity[i - 1]);
        }
      }

      if (dailyReturns.length >= 2) {
        const riskFreeDaily = Math.pow(1.045, 1 / 365) - 1; // ~4.5% annual risk-free rate
        const excessReturns = dailyReturns.map(r => r - riskFreeDaily);
        const avgExcess = excessReturns.reduce((s, r) => s + r, 0) / excessReturns.length;
        // Sample standard deviation (N-1)
        const variance = excessReturns.reduce((s, r) => s + Math.pow(r - avgExcess, 2), 0) / (excessReturns.length - 1);
        const stdDev = Math.sqrt(variance);
        sharpeRatio = stdDev > 0 ? (avgExcess / stdDev) * Math.sqrt(365) : 0;
      }
    }
  }

  // Sortino ratio — like Sharpe but only penalizes downside deviation
  let sortinoRatio = 0;
  if (equityCurve.length >= 3) {
    const dayMs = 24 * 60 * 60 * 1000;
    const dailyEquity = [];
    let lastDay = -1;
    for (const point of equityCurve) {
      const dayNum = Math.floor(point.timestamp / dayMs);
      if (dayNum !== lastDay) { dailyEquity.push(point.equity); lastDay = dayNum; }
      else { dailyEquity[dailyEquity.length - 1] = point.equity; }
    }
    if (dailyEquity.length >= 2) {
      const dailyReturns = [];
      for (let i = 1; i < dailyEquity.length; i++) {
        if (dailyEquity[i - 1] > 0) dailyReturns.push((dailyEquity[i] - dailyEquity[i - 1]) / dailyEquity[i - 1]);
      }
      if (dailyReturns.length >= 2) {
        const riskFreeDaily = Math.pow(1.045, 1 / 365) - 1;
        const excessReturns = dailyReturns.map(r => r - riskFreeDaily);
        const avgExcess = excessReturns.reduce((s, r) => s + r, 0) / excessReturns.length;
        // Downside deviation: only negative excess returns
        const downsideSquares = excessReturns.filter(r => r < 0).map(r => r * r);
        const downsideVariance = downsideSquares.length > 0
          ? downsideSquares.reduce((s, v) => s + v, 0) / downsideSquares.length
          : 0;
        const downsideDev = Math.sqrt(downsideVariance);
        sortinoRatio = downsideDev > 0 ? (avgExcess / downsideDev) * Math.sqrt(365) : 0;
      }
    }
  }

  // Calmar ratio — annualized return / max drawdown
  const annualizedReturn = days > 0 ? ((totalPnl / initialCapital) * (365 / days)) * 100 : 0;
  const calmarRatio = maxDrawdownPercent > 0 ? annualizedReturn / maxDrawdownPercent : 0;

  // Expectancy = (avgWin * winRate) - (avgLoss * lossRate)
  const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLossAmt = losses.length > 0 ? grossLoss / losses.length : 0;
  const winRate = completedTrades.length > 0 ? wins.length / completedTrades.length : 0;
  const lossRate = 1 - winRate;
  const expectancy = (avgWin * winRate) - (avgLossAmt * lossRate);

  // Statistical significance warning
  const statisticallySignificant = completedTrades.length >= 30;

  // Consecutive wins/losses
  let maxConsWins = 0, maxConsLosses = 0, curWins = 0, curLosses = 0;
  for (const t of completedTrades) {
    if (t.pnl > 0) { curWins++; curLosses = 0; maxConsWins = Math.max(maxConsWins, curWins); }
    else { curLosses++; curWins = 0; maxConsLosses = Math.max(maxConsLosses, curLosses); }
  }

  // Best/worst
  const sorted = [...completedTrades].sort((a, b) => b.pnl - a.pnl);

  return {
    totalTrades: completedTrades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: Math.round(winRate * 100),
    totalPnl: Math.round(totalPnl * 100) / 100,
    totalPnlPercent: Math.round((totalPnl / initialCapital) * 10000) / 100,
    avgProfit: wins.length > 0 ? Math.round((grossProfit / wins.length) * 100) / 100 : 0,
    avgLoss: losses.length > 0 ? Math.round((grossLoss / losses.length) * 100) / 100 : 0,
    bestTrade: sorted[0] ? { asset: sorted[0].asset, pnl: sorted[0].pnl, direction: sorted[0].direction, exitReason: sorted[0].exitReason } : null,
    worstTrade: sorted[sorted.length - 1] ? { asset: sorted[sorted.length - 1].asset, pnl: sorted[sorted.length - 1].pnl, direction: sorted[sorted.length - 1].direction, exitReason: sorted[sorted.length - 1].exitReason } : null,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    maxDrawdownPercent: Math.round(maxDrawdownPercent * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : grossProfit > 0 ? Infinity : 0,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    sortinoRatio: Math.round(sortinoRatio * 100) / 100,
    calmarRatio: Math.round(calmarRatio * 100) / 100,
    expectancy: Math.round(expectancy * 100) / 100,
    statisticallySignificant,
    avgHoldingBars: Math.round(completedTrades.reduce((s, t) => s + t.holdingBars, 0) / completedTrades.length),
    tradesPerMonth: Math.round((completedTrades.length / days) * 30 * 10) / 10,
    maxConsecutiveWins: maxConsWins,
    maxConsecutiveLosses: maxConsLosses
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN BACKTEST RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run a full backtest against historical data
 * @param {Object} options - Backtest configuration
 * @param {Function} onProgress - Optional progress callback
 * @returns {Object} Complete backtest results
 */
async function runBacktest(options, onProgress = null) {
  const {
    asset = 'bitcoin',
    days = 90,
    stepInterval = '4h',
    capital = 10000,
    riskPerTrade = 0.02,
    maxOpenPositions = 3,
    minConfluence = 2,
    minRR = 1.5,
    allowedStrength = ['STRONG BUY', 'STRONG SELL'],
    cooldownBars = 6,
    fearGreed = 50,
    derivativesData = null,
    macroData = null,
    strategyConfig = null,
    preloadedCandles = null  // For optimizer: skip re-fetching
  } = options;

  const startTime = Date.now();

  logger.info('Starting backtest', { asset, days, stepInterval, capital });

  // ─── 1. Fetch historical data (or use preloaded for optimizer) ───────
  let allCandles;
  if (preloadedCandles) {
    allCandles = preloadedCandles;
    logger.info('Using preloaded candles for backtest', { asset });
  } else {
    if (onProgress) onProgress({ phase: 'fetching', message: 'Descargando datos históricos...' });
    allCandles = await fetchAllTimeframes(asset, days);
  }

  const candles1h = allCandles['1h'];
  const candles4h = allCandles['4h'];
  const candles15m = allCandles['15m'];

  if (!candles1h || candles1h.length < 200) {
    throw new Error(`Insufficient 1h candle data: ${candles1h?.length || 0} (need 200+)`);
  }

  logger.info('Historical data loaded', {
    '1h': candles1h.length,
    '4h': candles4h.length,
    '15m': candles15m.length
  });

  // ─── 1b. Fetch historical context data (F&G, Funding, BTC Dom, DXY) ──
  if (onProgress) onProgress({ phase: 'fetching', message: 'Descargando datos de contexto (F&G, funding, BTC dom, DXY)...' });

  // Phase 1: Parallel fetch (different APIs, no rate-limit conflict)
  const [historicalFG, historicalFunding, historicalDXY] = await Promise.allSettled([
    fetchHistoricalFearGreed(days + 10),
    fetchHistoricalFundingRate(asset, Date.now() - ((days + 10) * 24 * 60 * 60 * 1000), Date.now()),
    fetchHistoricalDXY(days + 10)  // Frankfurter API (not CoinGecko)
  ]);

  // Phase 2: CoinGecko sequential (rate limit protection — shares limit with candle fetches)
  const btcDomData = await fetchHistoricalBtcDominance(days + 10);

  const fgData = historicalFG.status === 'fulfilled' ? historicalFG.value : [];
  const fundingData = historicalFunding.status === 'fulfilled' ? historicalFunding.value : [];
  const dxyData = historicalDXY.status === 'fulfilled' ? historicalDXY.value : [];

  const hasFearGreed = fgData.length > 0;
  const hasFunding = fundingData.length > 0;
  const hasBtcDom = btcDomData.length > 0;
  const hasDXY = dxyData.length > 0;

  logger.info('Historical context data loaded', {
    fearGreedPoints: fgData.length,
    fundingRatePoints: fundingData.length,
    btcDomPoints: btcDomData.length,
    dxyPoints: dxyData.length,
    factorsAvailable: `${10 + (hasFearGreed ? 1 : 0) + (hasFunding ? 1 : 0) + (hasBtcDom ? 1 : 0) + (hasDXY ? 1 : 0)}/14`
  });

  // ─── 2. Determine backtest window ────────────────────────────────────
  const stepMs = INTERVAL_MS[stepInterval] || INTERVAL_MS['4h'];
  const backtestStartTime = Date.now() - (days * 24 * 60 * 60 * 1000);

  // Find first 1h candle index that's within our backtest window
  // (skip the warm-up period needed for indicators)
  const warmupEndTime = backtestStartTime;
  const firstStepIndex = candles1h.findIndex(c => c.timestamp >= warmupEndTime);

  if (firstStepIndex < MIN_LOOKBACK['1h']) {
    throw new Error('Not enough warm-up candles for indicators');
  }

  // Build step points (every stepInterval from backtest start to now)
  const stepPoints = [];
  for (let i = firstStepIndex; i < candles1h.length; i++) {
    const candle = candles1h[i];
    if (stepPoints.length === 0 || candle.timestamp - stepPoints[stepPoints.length - 1].timestamp >= stepMs) {
      stepPoints.push({ index: i, timestamp: candle.timestamp, price: candle.close });
    }
  }

  logger.info('Backtest steps calculated', { totalSteps: stepPoints.length, firstStep: firstStepIndex });

  // ─── 3. Config for evaluateSignalForTrade ────────────────────────────
  const config = {
    ...DEFAULT_CONFIG,
    is_enabled: true,
    current_capital: capital,
    initial_capital: capital,
    risk_per_trade: riskPerTrade,
    max_open_positions: maxOpenPositions,
    min_confluence: minConfluence,
    min_rr_ratio: minRR,
    allowed_strength: allowedStrength
  };

  // ─── 4. Walk through history ─────────────────────────────────────────
  const completedTrades = [];
  const equityCurve = [{ timestamp: stepPoints[0]?.timestamp || backtestStartTime, equity: capital }];
  let currentCapital = capital;
  let openTrades = [];
  let lastTradeBar = -cooldownBars; // Allow immediate first trade
  let totalSteps = stepPoints.length;

  // Running index pointers for 4h/15m (O(1) per step instead of O(N) .filter())
  let last4hIndex = 0;
  let last15mIndex = 0;

  if (onProgress) onProgress({ phase: 'running', message: `Analizando ${totalSteps} puntos...`, total: totalSteps, current: 0 });

  for (let stepIdx = 0; stepIdx < stepPoints.length; stepIdx++) {
    const step = stepPoints[stepIdx];
    const currentPrice = step.price;

    // Progress update every 10%
    if (onProgress && stepIdx % Math.max(1, Math.floor(totalSteps / 10)) === 0) {
      onProgress({ phase: 'running', message: `Paso ${stepIdx}/${totalSteps}`, total: totalSteps, current: stepIdx });
    }

    // ── Check open trades against current candle ──────────────────
    const tradesToRemove = [];
    for (let t = 0; t < openTrades.length; t++) {
      const trade = openTrades[t];
      // Simulate through all 1h candles from last check to current step
      const result = simulateTradeExecution(
        trade,
        candles1h,
        trade.lastCheckedIndex || trade.startIndex
      );

      // If trade would exit before or at current step
      if (result.exitIndex <= step.index) {
        const closedTrade = {
          ...trade,
          ...result,
          entryTimestamp: candles1h[trade.startIndex].timestamp
        };
        completedTrades.push(closedTrade);
        currentCapital += result.pnl;
        tradesToRemove.push(t);
      } else {
        // Still open, update last checked
        trade.lastCheckedIndex = step.index;
      }
    }

    // Remove closed trades (reverse order to preserve indices)
    for (let i = tradesToRemove.length - 1; i >= 0; i--) {
      openTrades.splice(tradesToRemove[i], 1);
    }

    // ── Record equity + update open trade MFE/MAE ────────────────
    let unrealizedPnl = 0;
    for (const trade of openTrades) {
      let tradePnl;
      if (trade.direction === 'LONG') {
        tradePnl = (currentPrice - trade.entryPrice) * trade.remainingQty;
        unrealizedPnl += tradePnl;
      } else {
        tradePnl = (trade.entryPrice - currentPrice) * trade.remainingQty;
        unrealizedPnl += tradePnl;
      }
      // Track MFE/MAE for force-close scenario
      trade.maxFavorable = Math.max(trade.maxFavorable || 0, Math.max(0, tradePnl));
      trade.maxAdverse = Math.min(trade.maxAdverse || 0, Math.min(0, tradePnl));
    }
    equityCurve.push({ timestamp: step.timestamp, equity: Math.round((currentCapital + unrealizedPnl) * 100) / 100 });

    // ── Generate signal at this step ──────────────────────────────
    // Build candle windows for each timeframe (using running pointers for O(1))
    const window1h = candles1h.slice(Math.max(0, step.index - MIN_LOOKBACK['1h']), step.index + 1);

    // Advance 4h pointer to current step timestamp
    while (last4hIndex < candles4h.length - 1 && candles4h[last4hIndex + 1].timestamp <= step.timestamp) {
      last4hIndex++;
    }
    const window4h = candles4h.slice(Math.max(0, last4hIndex - MIN_LOOKBACK['4h'] + 1), last4hIndex + 1);

    // Advance 15m pointer to current step timestamp
    while (last15mIndex < candles15m.length - 1 && candles15m[last15mIndex + 1].timestamp <= step.timestamp) {
      last15mIndex++;
    }
    const window15m = candles15m.slice(Math.max(0, last15mIndex - MIN_LOOKBACK['15m'] + 1), last15mIndex + 1);

    if (window1h.length < 50 || window4h.length < 30 || window15m.length < 50) {
      continue; // Not enough data yet
    }

    // Calculate change24h from candles
    const price24hAgo = candles1h.find(c => c.timestamp <= step.timestamp - (24 * 60 * 60 * 1000))?.close || currentPrice;
    const change24h = ((currentPrice - price24hAgo) / price24hAgo) * 100;

    // Volume from last candle
    const vol = candles1h[step.index]?.volume || 0;

    // ── Lookup historical context for this timestamp ──────────────
    const stepFearGreed = hasFearGreed
      ? lookupByTimestamp(fgData, step.timestamp).value
      : fearGreed; // Fall back to static param (default 50)

    const stepDerivatives = hasFunding
      ? {
          fundingRatePercent: lookupByTimestamp(fundingData, step.timestamp).fundingRate * 100,
          longShortRatio: derivativesData?.longShortRatio || null // Not available historically
        }
      : derivativesData;

    // ── Lookup historical macro data (BTC dominance, DXY) ──────────
    const stepBtcDom = hasBtcDom ? lookupByTimestamp(btcDomData, step.timestamp) : null;
    const stepDxy = hasDXY ? lookupByTimestamp(dxyData, step.timestamp) : null;

    let stepMacro = null;
    if (stepBtcDom || stepDxy) {
      // Derive btcChange24h from BTC market cap history for non-BTC assets
      let btcChange24h = 0;
      if (asset === 'bitcoin') {
        btcChange24h = change24h;
      } else if (stepBtcDom) {
        const prevBtc = lookupByTimestamp(btcDomData, step.timestamp - 24 * 3600000);
        if (prevBtc?.btcMcap > 0 && stepBtcDom.btcMcap > 0) {
          btcChange24h = ((stepBtcDom.btcMcap - prevBtc.btcMcap) / prevBtc.btcMcap) * 100;
        }
      }
      stepMacro = {
        btcDom: stepBtcDom?.btcDom || 0,
        btcChange24h: parseFloat(btcChange24h.toFixed(2)),
        dxy: stepDxy?.dxy || 100,
        dxyTrend: stepDxy?.dxyTrend || 'neutral',
        dxyChange: stepDxy?.dxyChange || 0
      };
    } else if (macroData) {
      stepMacro = macroData;
    }

    try {
      const signal = await generateMultiTimeframeSignal(
        asset, currentPrice, change24h, vol, stepFearGreed,
        stepDerivatives, stepMacro,
        { '4h': window4h, '1h': window1h, '15m': window15m },
        strategyConfig
      );

      // ── Evaluate for trade ──────────────────────────────────────
      const tempConfig = { ...config, current_capital: currentCapital };
      const { eligible, reason } = evaluateSignalForTrade(signal, tempConfig);

      if (!eligible) continue;

      // Safety checks (simplified for backtest — no DB)
      if (openTrades.length >= maxOpenPositions) continue;
      if (stepIdx - lastTradeBar < cooldownBars) continue;
      if (openTrades.some(t => t.asset === asset)) continue;

      // Daily loss check
      const dailyLossLimit = capital * config.max_daily_loss_percent;
      const dailyPnl = completedTrades
        .filter(t => t.exitTimestamp && t.exitTimestamp > step.timestamp - (24 * 60 * 60 * 1000))
        .reduce((s, t) => s + t.pnl, 0);
      if (dailyPnl <= -dailyLossLimit) continue;

      // Calculate position size
      const posSize = calculatePositionSize(tempConfig, signal);
      if (posSize.positionSizeUsd <= 0) continue;

      // Apply slippage to entry
      const slippedEntry = signal.action === 'BUY'
        ? signal.tradeLevels.entry * (1 + TOTAL_COST)
        : signal.tradeLevels.entry * (1 - TOTAL_COST);

      // Open trade
      const newTrade = {
        asset: signal.asset,
        direction: signal.action === 'BUY' ? 'LONG' : 'SHORT',
        entryPrice: slippedEntry,
        stopLoss: signal.tradeLevels.stopLoss,
        takeProfit1: signal.tradeLevels.takeProfit1,
        takeProfit2: signal.tradeLevels.takeProfit2,
        trailingStop: signal.tradeLevels.trailingStop,
        trailingActivation: signal.tradeLevels.trailingActivation,
        quantity: posSize.quantity,
        remainingQty: posSize.quantity,
        positionSizeUsd: posSize.positionSizeUsd,
        riskAmount: posSize.riskAmount,
        startIndex: step.index,
        lastCheckedIndex: step.index,
        strengthLabel: signal.strengthLabel,
        confidence: signal.confidence,
        score: signal.score,
        rawScore: signal.rawScore,
        confluence: signal.timeframes?.confluence || 'unknown',
        maxFavorable: 0,
        maxAdverse: 0
      };

      openTrades.push(newTrade);
      lastTradeBar = stepIdx;

    } catch (signalErr) {
      // Signal generation can fail for edge cases — skip silently
      logger.debug('Signal generation failed in backtest', { step: stepIdx, error: signalErr.message });
    }
  }

  // ─── 5. Force-close remaining open trades at last price ──────────────
  for (const trade of openTrades) {
    const lastCandle = candles1h[candles1h.length - 1];
    const exitPrice = lastCandle.close;
    let pnl;
    if (trade.direction === 'LONG') {
      pnl = (exitPrice - trade.entryPrice) * trade.remainingQty;
    } else {
      pnl = (trade.entryPrice - exitPrice) * trade.remainingQty;
    }
    completedTrades.push({
      ...trade,
      exitIndex: candles1h.length - 1,
      exitTimestamp: lastCandle.timestamp,
      exitPrice,
      exitReason: 'end_of_data',
      pnl: Math.round(pnl * 100) / 100,
      pnlPercent: Math.round((pnl / trade.positionSizeUsd) * 10000) / 100,
      holdingBars: candles1h.length - 1 - trade.startIndex,
      maxFavorable: Math.round((trade.maxFavorable || 0) * 100) / 100,
      maxAdverse: Math.round((trade.maxAdverse || 0) * 100) / 100,
      entryTimestamp: candles1h[trade.startIndex].timestamp
    });
    currentCapital += pnl;
  }

  // Final equity point
  equityCurve.push({
    timestamp: candles1h[candles1h.length - 1]?.timestamp || Date.now(),
    equity: Math.round(currentCapital * 100) / 100
  });

  // ─── 6. Calculate metrics ────────────────────────────────────────────
  const metrics = calculateBacktestMetrics(completedTrades, equityCurve, capital, days);

  // Monte Carlo bootstrap resampling (1000 paths)
  const monteCarlo = runMonteCarloSimulation(completedTrades, capital, {
    simulations: 1000,
    seed: 42
  });

  // Statistical significance tests (p-values, confidence intervals)
  const significance = runStatisticalTests(completedTrades, monteCarlo);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  logger.info('Backtest completed', {
    asset, days, duration: duration + 's',
    trades: metrics.totalTrades,
    winRate: metrics.winRate + '%',
    pnl: '$' + metrics.totalPnl,
    profitFactor: metrics.profitFactor
  });

  if (onProgress) onProgress({ phase: 'completed', message: 'Backtest completado' });

  // Clean trade objects for storage (remove internal tracking fields)
  const cleanTrades = completedTrades.map(t => ({
    asset: t.asset,
    direction: t.direction,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    entryTimestamp: t.entryTimestamp,
    exitTimestamp: t.exitTimestamp,
    exitReason: t.exitReason,
    pnl: t.pnl,
    pnlPercent: t.pnlPercent,
    positionSizeUsd: t.positionSizeUsd,
    holdingBars: t.holdingBars,
    strengthLabel: t.strengthLabel,
    confidence: t.confidence,
    score: t.score,
    confluence: t.confluence,
    maxFavorable: t.maxFavorable,
    maxAdverse: t.maxAdverse
  }));

  return {
    config: { asset, days, stepInterval, capital, riskPerTrade, maxOpenPositions, minConfluence, minRR, allowedStrength, cooldownBars, strategyConfig },
    metrics,
    monteCarlo,
    significance,
    trades: cleanTrades,
    equityCurve,
    duration: parseFloat(duration),
    candlesAnalyzed: { '1h': candles1h.length, '4h': candles4h.length, '15m': candles15m.length },
    historicalContext: {
      fearGreedPoints: fgData.length,
      fundingRatePoints: fundingData.length,
      btcDomPoints: btcDomData.length,
      dxyPoints: dxyData.length,
      factorsUsed: 10 + (hasFearGreed ? 1 : 0) + (hasFunding ? 1 : 0) + (hasBtcDom ? 1 : 0) + (hasDXY ? 1 : 0),
      factorsTotal: 14
    },
    note: (() => {
      const missing = [
        ...(hasFearGreed ? [] : ['Fear & Greed']),
        ...(hasFunding ? [] : ['Funding Rate']),
        ...(hasBtcDom ? [] : ['BTC dominance']),
        ...(hasDXY ? [] : ['DXY']),
        'Order Book'  // Always missing — no historical data exists
      ];
      const factorCount = 10 + (hasFearGreed ? 1 : 0) + (hasFunding ? 1 : 0) + (hasBtcDom ? 1 : 0) + (hasDXY ? 1 : 0);
      return `Backtest basado en ${factorCount}/14 factores (${missing.join(', ')} no disponibles históricamente)`;
    })()
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  fetchHistoricalCandles,
  fetchAllTimeframes,
  fetchHistoricalFearGreed,
  fetchHistoricalFundingRate,
  fetchHistoricalBtcDominance,
  fetchHistoricalDXY,
  lookupByTimestamp,
  runBacktest,
  simulateTradeExecution,
  calculateBacktestMetrics,
  SLIPPAGE,
  COMMISSION,
  TOTAL_COST,
  INTERVAL_MS,
  // Test helper — reset module-level caches
  _resetMacroCache() {
    _btcDomCache = { data: [], expiry: 0 };
    _dxyCache = { data: [], expiry: 0 };
  }
};
