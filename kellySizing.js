// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - KELLY CRITERION & VOLATILITY TARGETING
// Dynamic position sizing based on historical edge and market volatility
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Default configuration for Kelly Criterion position sizing.
 */
const KELLY_DEFAULTS = {
  enabled: false,
  fraction: 0.5,              // Half-Kelly (conservative default)
  minTrades: 20,              // Minimum completed trades before Kelly kicks in
  lookbackTrades: 100,        // Use last N trades for win rate / payoff stats
  minRiskPerTrade: 0.005,     // Floor: 0.5% of capital per trade
  maxRiskPerTrade: 0.05,      // Ceiling: 5% of capital per trade
};

/**
 * Default configuration for volatility targeting.
 */
const VOL_DEFAULTS = {
  enabled: false,
  targetATRPercent: 2.0,      // Baseline volatility (ATR as % of price)
  minScale: 0.25,             // Minimum scale factor (trade at least 25% of base size)
  maxScale: 2.0,              // Maximum scale factor (trade at most 200% of base size)
};

/**
 * Compute the optimal Kelly fraction from historical trade data.
 *
 * Kelly formula (simplified): f* = p - q/R
 *   where p = win probability, q = 1-p, R = avgWin/avgLoss (payoff ratio)
 *
 * The raw Kelly is then scaled by `fraction` (e.g., 0.5 for half-Kelly)
 * and clamped to [minRiskPerTrade, maxRiskPerTrade].
 *
 * @param {Array<{pnl: number}>} completedTrades - Historical trades with at least `pnl`
 * @param {object} [kellyConfig={}] - Kelly configuration overrides
 * @returns {object} Kelly result with fraction, stats, and metadata
 */
function computeKellyFraction(completedTrades, kellyConfig = {}) {
  const config = { ...KELLY_DEFAULTS, ...kellyConfig };

  if (!config.enabled) {
    return { applied: false, reason: 'kelly_disabled', kellyFraction: null };
  }

  if (!completedTrades || completedTrades.length === 0) {
    return {
      applied: false,
      reason: 'no_trades',
      kellyFraction: null,
      tradeCount: 0
    };
  }

  // Take last N trades (lookback window)
  const trades = completedTrades.slice(-config.lookbackTrades);

  if (trades.length < config.minTrades) {
    return {
      applied: false,
      reason: 'insufficient_trades',
      kellyFraction: null,
      tradeCount: trades.length,
      minTrades: config.minTrades
    };
  }

  // Compute win/loss statistics
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  const winRate = wins.length / trades.length;
  const lossRate = 1 - winRate;

  const avgWin = wins.length > 0
    ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length
    : 0;

  const avgLoss = losses.length > 0
    ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length)
    : 0;

  // Edge case: no losses at all → use max risk (all trades are winners)
  if (avgLoss === 0) {
    return {
      applied: true,
      reason: 'all_wins',
      kellyFraction: config.maxRiskPerTrade,
      rawKelly: 1,
      winRate: Math.round(winRate * 10000) / 10000,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: 0,
      payoffRatio: Infinity,
      tradeCount: trades.length
    };
  }

  // Payoff ratio R = avgWin / avgLoss
  const payoffRatio = avgWin / avgLoss;

  // Kelly formula: f* = p - q/R = winRate - lossRate/payoffRatio
  const rawKelly = winRate - lossRate / payoffRatio;

  // Negative or zero edge → use minimum risk
  if (rawKelly <= 0) {
    return {
      applied: true,
      reason: 'negative_edge',
      kellyFraction: config.minRiskPerTrade,
      rawKelly: Math.round(rawKelly * 10000) / 10000,
      winRate: Math.round(winRate * 10000) / 10000,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      payoffRatio: Math.round(payoffRatio * 100) / 100,
      tradeCount: trades.length
    };
  }

  // Apply fractional Kelly and clamp
  const fractionalKelly = rawKelly * config.fraction;
  const kellyFraction = Math.max(
    config.minRiskPerTrade,
    Math.min(config.maxRiskPerTrade, fractionalKelly)
  );

  return {
    applied: true,
    reason: 'computed',
    kellyFraction: Math.round(kellyFraction * 10000) / 10000,
    rawKelly: Math.round(rawKelly * 10000) / 10000,
    winRate: Math.round(winRate * 10000) / 10000,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    payoffRatio: Math.round(payoffRatio * 100) / 100,
    tradeCount: trades.length
  };
}

/**
 * Compute volatility scaling factor based on current ATR vs target.
 *
 * When current ATR% > target → scale < 1 (trade smaller in high volatility)
 * When current ATR% < target → scale > 1 (trade larger in low volatility)
 *
 * @param {number|string} currentATRPercent - Current ATR as % of price
 * @param {object} [volConfig={}] - Volatility targeting configuration overrides
 * @returns {object} Volatility result with scale factor and metadata
 */
function computeVolatilityScale(currentATRPercent, volConfig = {}) {
  const config = { ...VOL_DEFAULTS, ...volConfig };

  if (!config.enabled) {
    return { applied: false, reason: 'vol_targeting_disabled', volScale: 1.0 };
  }

  // Parse string input (signal.indicators.atrPercent comes as "3.45")
  const atr = typeof currentATRPercent === 'string'
    ? parseFloat(currentATRPercent)
    : currentATRPercent;

  if (!atr || atr <= 0 || !isFinite(atr)) {
    return { applied: false, reason: 'invalid_atr', volScale: 1.0 };
  }

  // Scale inversely: calmer market → trade larger, volatile → trade smaller
  const rawScale = config.targetATRPercent / atr;
  const volScale = Math.max(
    config.minScale,
    Math.min(config.maxScale, rawScale)
  );

  return {
    applied: true,
    reason: 'computed',
    volScale: Math.round(volScale * 10000) / 10000,
    currentATR: Math.round(atr * 100) / 100,
    targetATR: config.targetATRPercent
  };
}

/**
 * Build combined sizing options for calculatePositionSize.
 * Composes Kelly fraction + volatility scale into a single options object.
 *
 * @param {Array<{pnl: number}>} completedTrades - Historical trades
 * @param {number|string} currentATRPercent - Current ATR%
 * @param {object} [config={}] - Combined config with `kelly` and `volatilityTargeting` sub-objects
 * @returns {{ kellyResult: object, volResult: object }}
 */
function buildSizingOptions(completedTrades, currentATRPercent, config = {}) {
  const kellyResult = computeKellyFraction(completedTrades, config.kelly);
  const volResult = computeVolatilityScale(currentATRPercent, config.volatilityTargeting);
  return { kellyResult, volResult };
}

module.exports = {
  KELLY_DEFAULTS,
  VOL_DEFAULTS,
  computeKellyFraction,
  computeVolatilityScale,
  buildSizingOptions
};
