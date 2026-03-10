// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - SHARED CONSTANTS
// Single source of truth for values used across multiple modules
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Execution Cost Model ────────────────────────────────────────────────────
// Used by backtester.js and paperTrading.js for realistic trade simulation
const SLIPPAGE = 0.001;     // 0.1% spread/slippage per trade
const COMMISSION = 0.001;   // 0.1% exchange fee per side (Binance default)
const TOTAL_COST = SLIPPAGE + COMMISSION; // 0.2% combined per-side cost

module.exports = Object.freeze({
  SLIPPAGE,
  COMMISSION,
  TOTAL_COST,
});
