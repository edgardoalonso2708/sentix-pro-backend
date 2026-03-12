// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - SHARED CONSTANTS
// Single source of truth for values used across multiple modules
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Execution Cost Model ────────────────────────────────────────────────────
// Used by backtester.js and paperTrading.js for realistic trade simulation
const SLIPPAGE = 0.001;     // 0.1% spread/slippage per trade (legacy default)
const COMMISSION = 0.001;   // 0.1% exchange fee per side (Binance default)
const TOTAL_COST = SLIPPAGE + COMMISSION; // 0.2% combined per-side cost

// ─── Per-Asset Slippage Model ────────────────────────────────────────────────
// Realistic slippage varies by liquidity: BTC is deep, altcoins are thin
const ASSET_SLIPPAGE = {
  // Tier 1: Ultra-liquid (tight spreads, deep books)
  bitcoin:      0.0005,   // 0.05%
  ethereum:     0.0008,   // 0.08%
  // Tier 2: High-liquid (moderate spreads)
  binancecoin:  0.0010,   // 0.10%
  solana:       0.0012,   // 0.12%
  ripple:       0.0012,   // 0.12%
  // Tier 3: Mid-liquid
  cardano:      0.0015,   // 0.15%
  dogecoin:     0.0015,   // 0.15%
  'matic-network': 0.0015,
  chainlink:    0.0015,
  'avalanche-2': 0.0018,  // 0.18%
  polkadot:     0.0018,
  litecoin:     0.0012,
  tron:         0.0015,
  // Tier 4: Lower-liquid (wider spreads)
  uniswap:      0.0020,   // 0.20%
  near:         0.0020,
  aptos:        0.0025,   // 0.25%
  arbitrum:     0.0025,
  optimism:     0.0025,
  sui:          0.0025,
  // Metals (OTC — wider spreads)
  'pax-gold':   0.0020,   // 0.20%
  gold:         0.0020,
  silver:       0.0025,
};

const DEFAULT_SLIPPAGE = 0.0020; // 0.20% for unknown assets

/**
 * Get total execution cost (slippage + commission) for an asset
 * @param {string} asset - Asset ID (e.g., 'bitcoin', 'solana')
 * @returns {number} Total cost per side (e.g., 0.0015 for BTC = 0.05% slip + 0.10% comm)
 */
function getAssetCost(asset) {
  const lower = (asset || '').toLowerCase();
  const slip = ASSET_SLIPPAGE[lower] !== undefined ? ASSET_SLIPPAGE[lower] : DEFAULT_SLIPPAGE;
  return slip + COMMISSION;
}

// ─── Gap Risk Model ──────────────────────────────────────────────────────────
// Probability of price gapping through a stop-loss level per trade
// In crypto (24/7 markets), true gaps are rare but flash crashes happen
const GAP_RISK = {
  probability: 0.02,       // 2% chance per trade of gap-through SL
  minOvershoot: 0.005,     // 0.5% minimum overshoot when gap occurs
  maxOvershoot: 0.03,      // 3.0% maximum overshoot (flash crash severity)
  // Seeded PRNG for deterministic backtest results
  // Use trade index + entry price as seed for reproducibility
};

/**
 * Calculate gap overshoot amount (deterministic per trade)
 * Uses a simple hash of trade params for reproducible randomness
 * @param {number} stopLoss - Stop-loss price
 * @param {number} seed - Deterministic seed (e.g., candle index)
 * @returns {{ gapped: boolean, overshootPct: number }}
 */
function simulateGapRisk(stopLoss, seed) {
  // Deterministic pseudo-random based on seed
  const hash = Math.abs(Math.sin(seed * 2654435761) * 10000);
  const rand = hash - Math.floor(hash); // 0-1

  if (rand > GAP_RISK.probability) {
    return { gapped: false, overshootPct: 0 };
  }

  // Gap occurred — determine severity (uniform between min and max overshoot)
  const severityHash = Math.abs(Math.sin((seed + 1) * 1597334677) * 10000);
  const severityRand = severityHash - Math.floor(severityHash);
  const overshootPct = GAP_RISK.minOvershoot + severityRand * (GAP_RISK.maxOvershoot - GAP_RISK.minOvershoot);

  return { gapped: true, overshootPct };
}

// ─── Stop-Loss Overshoot Model ───────────────────────────────────────────────
// Even without gaps, market orders to close at SL rarely fill exactly at SL price
// Model realistic SL fill as: SL ± volatilityFactor * ATR
const SL_OVERSHOOT = {
  baseOvershootPct: 0.001,   // 0.1% baseline overshoot on SL fills
  volatilityMultiplier: 0.15, // Scale overshoot by 15% of recent candle range
};

// ─── Order Book Execution Model ──────────────────────────────────────────────
// Estimate realistic fill price based on order book depth

/**
 * Estimate fill price from order book for a given trade size
 * @param {Object} orderBook - From fetchOrderBookDepth() (needs bestBid, bestAsk, spreadPercent)
 * @param {string} side - 'BUY' or 'SELL'
 * @param {number} tradeSizeUsd - Trade size in USD
 * @param {number} currentPrice - Current mid price
 * @returns {{ fillPrice: number, slippageEstimate: number, source: string }}
 */
function estimateFillFromOrderBook(orderBook, side, tradeSizeUsd, currentPrice) {
  if (!orderBook || !orderBook.bestBid || !orderBook.bestAsk) {
    return { fillPrice: currentPrice, slippageEstimate: 0, source: 'no_book' };
  }

  const midPrice = (orderBook.bestBid + orderBook.bestAsk) / 2;
  const spreadPct = orderBook.spreadPercent / 100; // Convert to decimal

  // Base fill: cross the spread (BUY at ask, SELL at bid)
  let baseFill = side === 'BUY' ? orderBook.bestAsk : orderBook.bestBid;

  // Depth impact: larger trades move price further
  // Estimate using imbalance as proxy for depth (full L2 book not available)
  const depthFactor = side === 'BUY'
    ? (orderBook.askTotal > 0 ? tradeSizeUsd / (orderBook.askTotal * midPrice) : 0.01)
    : (orderBook.bidTotal > 0 ? tradeSizeUsd / (orderBook.bidTotal * midPrice) : 0.01);

  // Market impact: sqrt model (empirical) — impact grows with sqrt of order size relative to depth
  const impactPct = Math.min(0.005, Math.sqrt(Math.max(0, depthFactor)) * 0.01); // Cap at 0.5%

  // Apply impact
  const fillPrice = side === 'BUY'
    ? baseFill * (1 + impactPct)
    : baseFill * (1 - impactPct);

  const slippageEstimate = Math.abs(fillPrice - midPrice) / midPrice;

  return {
    fillPrice: Math.round(fillPrice * 100) / 100,
    slippageEstimate: Math.round(slippageEstimate * 10000) / 10000,
    source: 'order_book',
    spreadPct: Math.round(spreadPct * 10000) / 10000,
    depthFactor: Math.round(depthFactor * 10000) / 10000,
    impactPct: Math.round(impactPct * 10000) / 10000
  };
}

// ─── Time-of-Day Slippage Multiplier ─────────────────────────────────────────
// Crypto is 24/7 but liquidity varies by hour (UTC)
const HOUR_LIQUIDITY_MULT = {
  // Asia session (low liquidity for Western pairs)
  0: 1.3, 1: 1.4, 2: 1.5, 3: 1.5, 4: 1.4, 5: 1.3,
  // Europe open → peak liquidity
  6: 1.1, 7: 1.0, 8: 0.9, 9: 0.85, 10: 0.85, 11: 0.9,
  // US overlap → best liquidity
  12: 0.8, 13: 0.75, 14: 0.75, 15: 0.8, 16: 0.85,
  // US afternoon
  17: 0.9, 18: 0.95, 19: 1.0, 20: 1.05,
  // Evening wind-down
  21: 1.1, 22: 1.2, 23: 1.25
};

/**
 * Get time-of-day slippage multiplier
 * @returns {number} Multiplier (< 1.0 = good liquidity, > 1.0 = thin)
 */
function getTimeOfDayMultiplier() {
  const hourUTC = new Date().getUTCHours();
  return HOUR_LIQUIDITY_MULT[hourUTC] || 1.0;
}

module.exports = Object.freeze({
  SLIPPAGE,
  COMMISSION,
  TOTAL_COST,
  ASSET_SLIPPAGE,
  DEFAULT_SLIPPAGE,
  getAssetCost,
  GAP_RISK,
  simulateGapRisk,
  SL_OVERSHOOT,
  estimateFillFromOrderBook,
  HOUR_LIQUIDITY_MULT,
  getTimeOfDayMultiplier,
});
