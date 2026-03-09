// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - STRATEGY CONFIGURATION
// Centralized config for all signal generation parameters
// Used by technicalAnalysis.js, backtester.js, and optimizer.js
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Default strategy configuration — matches all current hardcoded values exactly.
 * Changing defaults here changes the live signal engine behavior.
 */
const DEFAULT_STRATEGY_CONFIG = {
  // ─── Indicator Periods ───────────────────────────────────────────
  rsiPeriod: 14,
  emaPeriods: [9, 21, 50],
  adxPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  bbPeriod: 20,
  bbStdDev: 2,
  atrPeriod: 14,
  divergenceLookback: 20,
  volumeLookback: 14,

  // ─── Scoring Weights (max contribution per factor) ───────────────
  trendScoreStrong: 20,     // Strong up/downtrend score
  trendScoreModerate: 10,   // Moderate trend score
  rsiExtremeScore: 18,      // RSI < 20 or > 80
  rsiStrongScore: 12,       // RSI < 30 or > 70
  rsiPullbackScore: 8,      // RSI pullback in trend context
  macdStrongScore: 15,      // MACD accelerating
  macdWeakScore: 8,         // MACD decelerating
  divergenceBaseScore: 10,  // Divergence base (+ strength)
  divergenceMaxScore: 20,   // Divergence cap
  bbOuterScore: 10,         // Price at outer Bollinger band
  bbNearScore: 5,           // Price near band
  srScore: 8,               // Near support/resistance
  momentumScore: 5,         // 24h momentum (reduced)
  fearGreedScore: 3,        // Fear & Greed extreme contribution
  derivativesScore: 15,     // Extreme funding rate score
  btcDomScore: 10,          // BTC dominance regime score
  dxyScore: 10,             // DXY macro score
  orderBookScore: 12,       // Order book imbalance score

  // ─── ADX Thresholds & Multipliers ───────────────────────────────
  adxStrongThreshold: 30,   // ADX >= this = strong trend
  adxModerateThreshold: 20, // ADX >= this = moderate
  adxStrongMultiplier: 1.2, // Amplify signals in strong trend
  adxWeakMultiplier: 0.6,   // Reduce signals in weak trend

  // ─── RSI Thresholds ─────────────────────────────────────────────
  rsiExtremeOversold: 20,
  rsiOversold: 30,
  rsiPullbackZone: 40,
  rsiPullbackZoneHigh: 60,
  rsiOverbought: 70,
  rsiExtremeOverbought: 80,

  // ─── Action Thresholds ──────────────────────────────────────────
  buyThreshold: 25,          // rawScore >= this → BUY
  buyWeakThreshold: 15,      // rawScore >= this AND confidence >= 40 → BUY
  sellThreshold: -25,        // rawScore <= this → SELL
  sellWeakThreshold: -15,    // rawScore <= this AND confidence >= 40 → SELL
  weakConfidenceMin: 40,     // Min confidence for weak buy/sell

  // ─── Confidence ─────────────────────────────────────────────────
  confidenceCap: 85,         // Max confidence (never claim certainty)
  multiFactorBonus: 10,      // Bonus when 4+ factors align
  conflictPenalty: 10,       // Penalty when signals conflict

  // ─── Trade Levels (ATR-based) ───────────────────────────────────
  atrStopMult: 1.5,         // SL = support - (atrStopMult × ATR)
  atrTP2Mult: 2.0,          // TP2 = resistance + (atrTP2Mult × ATR)
  atrTrailingMult: 2.5,     // Trailing stop distance
  atrTrailingActivation: 1.0, // Trailing activates at 1× ATR profit
  minRiskReward: 1.5,       // Minimum acceptable R:R

  // ─── Multi-Timeframe Confluence ─────────────────────────────────
  tf4hWeight: 0.40,
  tf1hWeight: 0.40,
  tf15mWeight: 0.20,
  strongConfluenceMult: 1.15,  // Score multiplier when all TFs agree
  moderateConfluenceBonus: 5,  // Confidence bonus for 2/3 agreement
  conflictingMult: 0.70,       // Score multiplier when TFs conflict
  governorMult: 0.50,          // 4H disagrees with merged signal

  // ─── Position Sizing ────────────────────────────────────────────
  riskPerTrade: 0.02,       // 2% of capital per trade
  maxPositionPct: 0.30,     // Max 30% of capital in single position
  maxOpenPositions: 3,
  dailyLossLimit: 0.05,     // 5% max daily loss

  // ─── Macro Thresholds ──────────────────────────────────────────
  btcDomThreshold: 55,      // > this = BTC season (alts struggle)
  dxyStrongThreshold: 105,  // > this = risk-off
  dxyWeakThreshold: 98,     // < this = risk-on
  fundingRateExtreme: 0.001, // |rate| > this = over-leveraged (0.1%)

  // ─── Strength Labels ───────────────────────────────────────────
  strongBuyMinScore: 50,
  strongBuyMinConf: 60,
  buyMinScore: 35,
  buyMinConf: 45,
};

/**
 * Optimizable parameter ranges for grid search.
 * Each entry: { min, max, step, label, description }
 */
const PARAM_RANGES = {
  adxStrongThreshold: {
    min: 20, max: 40, step: 5,
    label: 'ADX Strong Threshold',
    description: 'ADX level to consider trend strong (amplifies signals)'
  },
  adxStrongMultiplier: {
    min: 1.0, max: 1.6, step: 0.1,
    label: 'ADX Strong Multiplier',
    description: 'Score multiplier when ADX indicates strong trend'
  },
  adxWeakMultiplier: {
    min: 0.4, max: 0.8, step: 0.1,
    label: 'ADX Weak Multiplier',
    description: 'Score multiplier when ADX indicates weak/ranging market'
  },
  rsiOversold: {
    min: 20, max: 40, step: 5,
    label: 'RSI Oversold',
    description: 'RSI level considered oversold (buy signal)'
  },
  rsiOverbought: {
    min: 60, max: 80, step: 5,
    label: 'RSI Overbought',
    description: 'RSI level considered overbought (sell signal)'
  },
  buyThreshold: {
    min: 15, max: 40, step: 5,
    label: 'Buy Score Threshold',
    description: 'Minimum raw score to trigger BUY action'
  },
  sellThreshold: {
    min: -40, max: -15, step: 5,
    label: 'Sell Score Threshold',
    description: 'Maximum raw score to trigger SELL action'
  },
  trendScoreStrong: {
    min: 10, max: 30, step: 5,
    label: 'Trend Score (Strong)',
    description: 'Score contribution for strong EMA trend alignment'
  },
  derivativesScore: {
    min: 5, max: 25, step: 5,
    label: 'Derivatives Weight',
    description: 'Score from extreme funding rates'
  },
  atrTrailingMult: {
    min: 1.5, max: 4.0, step: 0.5,
    label: 'ATR Trailing Multiplier',
    description: 'Trailing stop distance as multiple of ATR'
  },
  atrStopMult: {
    min: 1.0, max: 2.5, step: 0.5,
    label: 'ATR Stop Loss Multiplier',
    description: 'Stop loss distance as multiple of ATR'
  },
  strongConfluenceMult: {
    min: 1.0, max: 1.4, step: 0.05,
    label: 'Strong Confluence Multiplier',
    description: 'Score boost when all 3 timeframes agree'
  },
  conflictingMult: {
    min: 0.5, max: 0.9, step: 0.1,
    label: 'Conflicting TF Multiplier',
    description: 'Score reduction when timeframes disagree'
  },
  orderBookScore: {
    min: 5, max: 20, step: 5,
    label: 'Order Book Weight',
    description: 'Score contribution from order book bid/ask imbalance'
  },
  confidenceCap: {
    min: 70, max: 95, step: 5,
    label: 'Confidence Cap',
    description: 'Maximum confidence percentage allowed'
  },
  riskPerTrade: {
    min: 0.01, max: 0.05, step: 0.01,
    label: 'Risk Per Trade',
    description: 'Percentage of capital risked per trade'
  },
};

/**
 * Merge user config with defaults (user values override defaults)
 */
function mergeConfig(userConfig = {}) {
  return { ...DEFAULT_STRATEGY_CONFIG, ...userConfig };
}

module.exports = {
  DEFAULT_STRATEGY_CONFIG,
  PARAM_RANGES,
  mergeConfig
};
