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
});
