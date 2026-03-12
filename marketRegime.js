// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - ADVANCED MARKET REGIME DETECTOR
// State machine with smooth transitions, confidence scoring, reversal detection,
// and regime-specific signal multipliers.
// ═══════════════════════════════════════════════════════════════════════════════

const { logger } = require('./logger');

// ─── REGIME DEFINITIONS ──────────────────────────────────────────────────────

const REGIMES = {
  TRENDING_UP:   'trending_up',
  TRENDING_DOWN: 'trending_down',
  RANGING:       'ranging',
  VOLATILE:      'volatile',
  REVERSAL_TOP:  'reversal_top',   // Potential top reversal
  REVERSAL_BOT:  'reversal_bottom', // Potential bottom reversal
  UNKNOWN:       'unknown'
};

// Signal multipliers: how much to trust signals in each regime
const REGIME_MULTIPLIERS = {
  [REGIMES.TRENDING_UP]:   { buy: 1.15, sell: 0.70, confidence: 1.10 },
  [REGIMES.TRENDING_DOWN]: { buy: 0.70, sell: 1.15, confidence: 1.10 },
  [REGIMES.RANGING]:       { buy: 0.85, sell: 0.85, confidence: 0.90 },
  [REGIMES.VOLATILE]:      { buy: 0.60, sell: 0.60, confidence: 0.75 },
  [REGIMES.REVERSAL_TOP]:  { buy: 0.40, sell: 1.30, confidence: 1.05 },
  [REGIMES.REVERSAL_BOT]:  { buy: 1.30, sell: 0.40, confidence: 1.05 },
  [REGIMES.UNKNOWN]:       { buy: 0.80, sell: 0.80, confidence: 0.80 },
};

// Minimum candles required for regime detection
const MIN_CANDLES = 50;

// ─── REGIME STATE MACHINE ────────────────────────────────────────────────────
// Persists per-asset state across cycles for smooth transitions

const regimeStates = new Map(); // asset → RegimeState

class RegimeState {
  constructor() {
    this.current = REGIMES.UNKNOWN;
    this.previous = REGIMES.UNKNOWN;
    this.confidence = 0;         // 0-100
    this.timeInRegime = 0;       // How many cycles in current regime
    this.transitionedAt = Date.now();
    this.probabilities = {       // EMA-smoothed regime probabilities
      [REGIMES.TRENDING_UP]: 0,
      [REGIMES.TRENDING_DOWN]: 0,
      [REGIMES.RANGING]: 0,
      [REGIMES.VOLATILE]: 0,
      [REGIMES.REVERSAL_TOP]: 0,
      [REGIMES.REVERSAL_BOT]: 0,
    };
    this.history = [];           // Last 20 regime snapshots
  }
}

// ─── REGIME CLASSIFICATION ───────────────────────────────────────────────────

/**
 * Calculate raw regime probabilities from candle data
 * @param {Array} candles - OHLCV candles sorted ascending
 * @returns {Object} Raw probabilities for each regime
 */
function calculateRegimeProbabilities(candles) {
  if (candles.length < MIN_CANDLES) {
    return null;
  }

  const recent = candles.slice(-50);
  const longer = candles.slice(-Math.min(candles.length, 120));

  // ── Returns analysis ──
  const returns = [];
  for (let i = 1; i < recent.length; i++) {
    returns.push((recent[i].close - recent[i - 1].close) / recent[i - 1].close);
  }
  const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  const volatility = Math.sqrt(
    returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / returns.length
  );

  // ── Trend strength (directional consistency) ──
  const posReturns = returns.filter(r => r > 0).length;
  const negReturns = returns.filter(r => r < 0).length;
  const directionalBias = (posReturns - negReturns) / returns.length; // -1 to 1

  // ── ADX-like trend strength (using directional movement) ──
  let plusDM = 0, minusDM = 0, tr = 0;
  for (let i = 1; i < recent.length; i++) {
    const upMove = recent[i].high - recent[i - 1].high;
    const downMove = recent[i - 1].low - recent[i].low;
    plusDM += (upMove > downMove && upMove > 0) ? upMove : 0;
    minusDM += (downMove > upMove && downMove > 0) ? downMove : 0;
    tr += Math.max(
      recent[i].high - recent[i].low,
      Math.abs(recent[i].high - recent[i - 1].close),
      Math.abs(recent[i].low - recent[i - 1].close)
    );
  }
  const plusDI = tr > 0 ? plusDM / tr : 0;
  const minusDI = tr > 0 ? minusDM / tr : 0;
  const diSum = plusDI + minusDI;
  const dx = diSum > 0 ? Math.abs(plusDI - minusDI) / diSum : 0;
  // ADX proxy: 0-1 range, higher = more trending
  const adxProxy = dx;

  // ── Price position relative to range (for reversal detection) ──
  const lookbackHigh = Math.max(...longer.map(c => c.high));
  const lookbackLow = Math.min(...longer.map(c => c.low));
  const range = lookbackHigh - lookbackLow;
  const currentPrice = recent[recent.length - 1].close;
  const pricePosition = range > 0 ? (currentPrice - lookbackLow) / range : 0.5; // 0=low, 1=high

  // ── RSI proxy (momentum exhaustion) ──
  const gains = returns.filter(r => r > 0);
  const losses = returns.filter(r => r < 0);
  const avgGain = gains.length > 0 ? gains.reduce((s, r) => s + r, 0) / gains.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, r) => s + r, 0) / losses.length) : 0.001;
  const rs = avgGain / avgLoss;
  const rsiProxy = 100 - (100 / (1 + rs));

  // ── Volume analysis ──
  const recentVols = recent.slice(-10).map(c => c.volume);
  const olderVols = recent.slice(-30, -10).map(c => c.volume);
  const avgRecentVol = recentVols.reduce((s, v) => s + v, 0) / recentVols.length;
  const avgOlderVol = olderVols.length > 0 ? olderVols.reduce((s, v) => s + v, 0) / olderVols.length : avgRecentVol;
  const volumeSpike = avgOlderVol > 0 ? avgRecentVol / avgOlderVol : 1;

  // ── Calculate raw probabilities ──
  const probs = {};

  // Trending Up: positive drift + directional consistency + moderate-high ADX
  probs[REGIMES.TRENDING_UP] = Math.max(0,
    (avgReturn > 0 ? avgReturn * 500 : 0) +
    (directionalBias > 0.1 ? directionalBias * 0.4 : 0) +
    (adxProxy > 0.3 ? adxProxy * 0.3 : 0)
  );

  // Trending Down: negative drift + directional consistency
  probs[REGIMES.TRENDING_DOWN] = Math.max(0,
    (avgReturn < 0 ? Math.abs(avgReturn) * 500 : 0) +
    (directionalBias < -0.1 ? Math.abs(directionalBias) * 0.4 : 0) +
    (adxProxy > 0.3 ? adxProxy * 0.3 : 0)
  );

  // Ranging: low ADX + low volatility + price oscillating mid-range
  const midRangeProximity = 1 - Math.abs(pricePosition - 0.5) * 2; // 1 at 50%, 0 at extremes
  probs[REGIMES.RANGING] = Math.max(0,
    (adxProxy < 0.3 ? (0.3 - adxProxy) * 1.5 : 0) +
    (volatility < 0.02 ? (0.02 - volatility) * 20 : 0) +
    midRangeProximity * 0.15
  );

  // Volatile: high volatility + volume spike
  probs[REGIMES.VOLATILE] = Math.max(0,
    (volatility > 0.025 ? (volatility - 0.025) * 15 : 0) +
    (volumeSpike > 1.5 ? (volumeSpike - 1.5) * 0.2 : 0)
  );

  // Reversal Top: price near high + RSI overbought + volatility increasing
  probs[REGIMES.REVERSAL_TOP] = Math.max(0,
    (pricePosition > 0.85 ? (pricePosition - 0.85) * 3 : 0) +
    (rsiProxy > 70 ? (rsiProxy - 70) * 0.015 : 0) +
    (volatility > 0.02 && volumeSpike > 1.3 ? 0.15 : 0)
  );

  // Reversal Bottom: price near low + RSI oversold + volatility increasing
  probs[REGIMES.REVERSAL_BOT] = Math.max(0,
    (pricePosition < 0.15 ? (0.15 - pricePosition) * 3 : 0) +
    (rsiProxy < 30 ? (30 - rsiProxy) * 0.015 : 0) +
    (volatility > 0.02 && volumeSpike > 1.3 ? 0.15 : 0)
  );

  // Normalize to sum = 1
  const total = Object.values(probs).reduce((s, v) => s + v, 0);
  if (total > 0) {
    for (const key of Object.keys(probs)) {
      probs[key] = probs[key] / total;
    }
  } else {
    probs[REGIMES.RANGING] = 1.0;
  }

  return {
    probabilities: probs,
    metrics: {
      avgReturn: Math.round(avgReturn * 100000) / 100000,
      volatility: Math.round(volatility * 100000) / 100000,
      adxProxy: Math.round(adxProxy * 1000) / 1000,
      directionalBias: Math.round(directionalBias * 1000) / 1000,
      pricePosition: Math.round(pricePosition * 1000) / 1000,
      rsiProxy: Math.round(rsiProxy * 10) / 10,
      volumeSpike: Math.round(volumeSpike * 100) / 100
    }
  };
}

// ─── SMOOTH TRANSITION (EMA) ─────────────────────────────────────────────────

const EMA_ALPHA = 0.3; // Smoothing factor: 0.3 = responsive, 0.1 = very smooth
const MIN_TRANSITION_CONFIDENCE = 0.35; // Need 35%+ probability to transition

/**
 * Update regime state with smooth EMA transitions
 * @param {string} asset - Asset ID
 * @param {Array} candles - OHLCV candles sorted ascending
 * @returns {Object} Current regime state with all metadata
 */
function updateRegime(asset, candles) {
  // Get or create state
  if (!regimeStates.has(asset)) {
    regimeStates.set(asset, new RegimeState());
  }
  const state = regimeStates.get(asset);

  // Calculate raw probabilities
  const result = calculateRegimeProbabilities(candles);
  if (!result) {
    return {
      regime: REGIMES.UNKNOWN,
      confidence: 0,
      multipliers: REGIME_MULTIPLIERS[REGIMES.UNKNOWN],
      timeInRegime: 0,
      probabilities: state.probabilities,
      transition: null,
      metrics: null
    };
  }

  const { probabilities: rawProbs, metrics } = result;

  // Smooth probabilities with EMA
  for (const regime of Object.keys(rawProbs)) {
    const prev = state.probabilities[regime] || 0;
    state.probabilities[regime] = prev + EMA_ALPHA * (rawProbs[regime] - prev);
  }

  // Find dominant regime
  let maxProb = 0;
  let dominantRegime = REGIMES.RANGING;
  for (const [regime, prob] of Object.entries(state.probabilities)) {
    if (prob > maxProb) {
      maxProb = prob;
      dominantRegime = regime;
    }
  }

  // Calculate confidence (0-100)
  // Higher when dominant regime is clearly ahead of second-best
  const sortedProbs = Object.values(state.probabilities).sort((a, b) => b - a);
  const separation = sortedProbs.length >= 2 ? sortedProbs[0] - sortedProbs[1] : sortedProbs[0];
  const rawConfidence = Math.min(100, Math.round(
    (maxProb * 60) + (separation * 200) + (state.timeInRegime > 3 ? 10 : 0)
  ));

  // Check for regime transition
  let transition = null;
  if (dominantRegime !== state.current && maxProb >= MIN_TRANSITION_CONFIDENCE) {
    // Require 2+ consecutive dominant readings for transition (anti-noise)
    if (state._pendingRegime === dominantRegime) {
      state._pendingCount = (state._pendingCount || 0) + 1;
    } else {
      state._pendingRegime = dominantRegime;
      state._pendingCount = 1;
    }

    if (state._pendingCount >= 2) {
      // Transition!
      transition = {
        from: state.current,
        to: dominantRegime,
        confidence: rawConfidence,
        timeInPrevious: state.timeInRegime,
        reason: `${state.current} → ${dominantRegime} (${Math.round(maxProb * 100)}% prob)`
      };

      state.previous = state.current;
      state.current = dominantRegime;
      state.timeInRegime = 0;
      state.transitionedAt = Date.now();
      state._pendingRegime = null;
      state._pendingCount = 0;

      logger.info('Market regime transition', {
        asset, from: transition.from, to: transition.to,
        confidence: rawConfidence, prob: Math.round(maxProb * 100)
      });
    }
  } else {
    state._pendingRegime = null;
    state._pendingCount = 0;
    state.timeInRegime++;
  }

  state.confidence = rawConfidence;

  // Record history (keep last 20)
  state.history.push({
    regime: state.current,
    confidence: rawConfidence,
    timestamp: Date.now(),
    probabilities: { ...state.probabilities }
  });
  if (state.history.length > 20) state.history.shift();

  const output = {
    regime: state.current,
    previous: state.previous,
    confidence: rawConfidence,
    multipliers: REGIME_MULTIPLIERS[state.current] || REGIME_MULTIPLIERS[REGIMES.UNKNOWN],
    timeInRegime: state.timeInRegime,
    transitionedAt: state.transitionedAt,
    probabilities: { ...state.probabilities },
    transition,
    metrics,
    isReversal: state.current === REGIMES.REVERSAL_TOP || state.current === REGIMES.REVERSAL_BOT,
    isVolatile: state.current === REGIMES.VOLATILE,
    isTrending: state.current === REGIMES.TRENDING_UP || state.current === REGIMES.TRENDING_DOWN,
  };

  return output;
}

/**
 * Get current regime without updating (read-only)
 * @param {string} asset - Asset ID
 * @returns {Object|null} Current regime state or null if not tracked
 */
function getRegime(asset) {
  const state = regimeStates.get(asset);
  if (!state) return null;

  return {
    regime: state.current,
    previous: state.previous,
    confidence: state.confidence,
    multipliers: REGIME_MULTIPLIERS[state.current] || REGIME_MULTIPLIERS[REGIMES.UNKNOWN],
    timeInRegime: state.timeInRegime,
    transitionedAt: state.transitionedAt,
    probabilities: { ...state.probabilities },
    isReversal: state.current === REGIMES.REVERSAL_TOP || state.current === REGIMES.REVERSAL_BOT,
    isVolatile: state.current === REGIMES.VOLATILE,
    isTrending: state.current === REGIMES.TRENDING_UP || state.current === REGIMES.TRENDING_DOWN,
  };
}

/**
 * Get regime summary for all tracked assets
 * @returns {Object} Map of asset → regime summary
 */
function getAllRegimes() {
  const summary = {};
  for (const [asset, state] of regimeStates) {
    summary[asset] = {
      regime: state.current,
      confidence: state.confidence,
      timeInRegime: state.timeInRegime,
      previous: state.previous
    };
  }
  return summary;
}

/**
 * Apply regime multiplier to a signal score
 * @param {number} rawScore - Signal raw score
 * @param {string} action - 'BUY' or 'SELL'
 * @param {Object} regimeData - From updateRegime()
 * @returns {{ adjustedScore: number, confidenceAdj: number, regimeInfo: string }}
 */
function applyRegimeMultiplier(rawScore, action, regimeData) {
  if (!regimeData || !regimeData.multipliers) {
    return { adjustedScore: rawScore, confidenceAdj: 0, regimeInfo: 'no_regime_data' };
  }

  const mult = regimeData.multipliers;
  const direction = rawScore >= 0 ? 'buy' : 'sell';
  const scoreMult = mult[direction] || 1.0;
  const confAdj = Math.round((mult.confidence - 1.0) * 100); // e.g., 1.10 → +10

  // Scale multiplier by regime confidence (weak regime = less adjustment)
  const confFactor = Math.max(0.3, regimeData.confidence / 100);
  const effectiveMult = 1 + (scoreMult - 1) * confFactor;

  const adjustedScore = Math.round(rawScore * effectiveMult);

  return {
    adjustedScore,
    confidenceAdj: Math.round(confAdj * confFactor),
    regimeInfo: `${regimeData.regime} (${regimeData.confidence}% conf, ×${effectiveMult.toFixed(2)})`,
    regime: regimeData.regime,
    regimeConfidence: regimeData.confidence
  };
}

/**
 * Reset regime state (for testing)
 */
function resetRegimeStates() {
  regimeStates.clear();
}

module.exports = {
  REGIMES,
  REGIME_MULTIPLIERS,
  calculateRegimeProbabilities,
  updateRegime,
  getRegime,
  getAllRegimes,
  applyRegimeMultiplier,
  resetRegimeStates
};
