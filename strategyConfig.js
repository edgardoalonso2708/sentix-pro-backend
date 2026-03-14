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
  srClusterThreshold: 0.008, // 0.8% — levels within this distance are clustered
  srSwingLookback: 5,        // Bars on each side to qualify as swing high/low
  srMaxLevels: 3,            // Max S/R levels per side (S1/S2/S3, R1/R2/R3)
  srZoneStrengthBonus: 3,    // Max extra confidence for heavily-tested zones
  momentumScore: 5,         // 24h momentum (reduced)
  fearGreedScore: 3,        // Fear & Greed extreme contribution
  derivativesScore: 15,     // Extreme funding rate score
  btcDomScore: 10,          // BTC dominance regime score
  dxyScore: 10,             // DXY macro score
  orderBookScore: 12,       // Order book imbalance score

  // ─── Ichimoku Cloud ──────────────────────────────────────────
  ichimokuTenkanPeriod: 9,
  ichimokuKijunPeriod: 26,
  ichimokuSenkouBPeriod: 52,
  ichimokuDisplacement: 26,
  ichimokuScore: 10,

  // ─── VWAP ─────────────────────────────────────────────────────
  vwapSessionLength: 24,
  vwapScore: 8,
  vwapBandStdDev: 2,

  // ─── Fibonacci Retracement ────────────────────────────────────
  fibSwingLookback: 50,
  fibScore: 6,
  fibGoldenRatioBonus: 2,

  // ─── OBV (On-Balance Volume) ──────────────────────────────────
  obvScore: 5,              // OBV trend confirmation score
  obvLookback: 20,          // Lookback period for OBV calculation

  // ─── Market Structure ─────────────────────────────────────────
  marketStructureLookback: 60,
  marketStructureScore: 12,
  marketStructureMinSwings: 4,

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
  // ─── 4H Governor (graduated, regime-aware) ───────────────────
  governorMultMild: 0.80,        // Mult when 4H disagrees mildly (rawScore barely past ±15)
  governorMultStrong: 0.55,      // Mult when 4H disagrees strongly (rawScore ±40+)
  governorStrongThreshold: 40,   // 4H |rawScore| at which governor reaches full strong penalty
  governorRangingDampen: 0.50,   // In ranging, reduce governor penalty (0=no governor, 1=full)

  // ─── Dynamic TF Weights (ADX-based) ──────────────────────────────
  dynamicTFWeightsEnabled: 1,       // 1 = enabled, 0 = use static weights
  tfTrending4hWeight: 0.55,         // 4h weight when ADX is strong (trending)
  tfTrending1hWeight: 0.30,         // 1h weight when trending
  tfTrending15mWeight: 0.15,        // 15m weight when trending
  tfRanging4hWeight: 0.25,          // 4h weight when ADX is low (ranging)
  tfRanging1hWeight: 0.35,          // 1h weight when ranging
  tfRanging15mWeight: 0.40,         // 15m weight when ranging

  // ─── Position Sizing ────────────────────────────────────────────
  riskPerTrade: 0.01,       // 1% of capital per trade (conservative for crypto)
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

// Freeze to prevent accidental mutation by any module
Object.freeze(DEFAULT_STRATEGY_CONFIG);

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
  governorMultMild: {
    min: 0.60, max: 0.95, step: 0.05,
    label: 'Governor Mult (Mild)',
    description: 'Score multiplier when 4H mildly disagrees with merged signal'
  },
  governorMultStrong: {
    min: 0.40, max: 0.75, step: 0.05,
    label: 'Governor Mult (Strong)',
    description: 'Score multiplier when 4H strongly disagrees with merged signal'
  },
  governorStrongThreshold: {
    min: 25, max: 55, step: 5,
    label: 'Governor Strong Threshold',
    description: '4H |rawScore| at which governor reaches full strong penalty'
  },
  governorRangingDampen: {
    min: 0.25, max: 1.00, step: 0.25,
    label: 'Governor Ranging Dampen',
    description: 'How much governor penalty applies in ranging markets (0=none, 1=full)'
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
  srClusterThreshold: {
    min: 0.005, max: 0.015, step: 0.005,
    label: 'S/R Cluster Threshold',
    description: 'Percentage distance to cluster nearby S/R levels'
  },
  srSwingLookback: {
    min: 3, max: 8, step: 1,
    label: 'S/R Swing Lookback',
    description: 'Bars on each side for swing high/low detection'
  },
  ichimokuScore: {
    min: 5, max: 15, step: 5,
    label: 'Ichimoku Weight',
    description: 'Score contribution from Ichimoku Cloud position'
  },
  vwapScore: {
    min: 4, max: 12, step: 4,
    label: 'VWAP Weight',
    description: 'Score contribution from VWAP position'
  },
  fibScore: {
    min: 3, max: 9, step: 3,
    label: 'Fibonacci Weight',
    description: 'Score contribution from Fibonacci retracement levels'
  },
  marketStructureScore: {
    min: 6, max: 18, step: 6,
    label: 'Market Structure Weight',
    description: 'Score contribution from HH/HL/LH/LL pattern detection'
  },
  dynamicTFWeightsEnabled: {
    min: 0, max: 1, step: 1,
    label: 'Dynamic TF Weights',
    description: 'Enable (1) or disable (0) ADX-based dynamic timeframe weights'
  },
  tfTrending4hWeight: {
    min: 0.40, max: 0.65, step: 0.05,
    label: '4h Weight (Trending)',
    description: '4h timeframe weight when market is strongly trending (high ADX)'
  },
  tfRanging15mWeight: {
    min: 0.25, max: 0.50, step: 0.05,
    label: '15m Weight (Ranging)',
    description: '15m timeframe weight when market is ranging (low ADX)'
  },
};

/**
 * Schedule & TTL configuration — operational parameters (not signal scoring).
 * Controls trading hours filtering and signal freshness/decay.
 */
const SCHEDULE_CONFIG = {
  // ─── Trading Hours (local timezone) ──────────────────────────────
  tradingHoursEnabled: false,        // false = 24/7 (default), true = filter active
  tradingHoursStart: 8,              // Start hour (0-23) in local time
  tradingHoursEnd: 22,               // End hour (0-23) in local time
  tradingDays: [1, 2, 3, 4, 5],     // Days of week (0=Sun, 1=Mon, ..., 6=Sat)
  timezone: 'America/Mexico_City',   // IANA timezone for hour calculation
  offHoursConfidenceReduction: 15,   // Reduce confidence by this when off-hours

  // ─── Signal TTL / Decay ──────────────────────────────────────────
  signalTTLMinutes: 15,              // Minutes until signal considered expired
  signalFreshMinutes: 5,             // Minutes signal is considered "fresh"
  signalAgingMinutes: 10,            // Minutes until signal transitions to "stale"
};

Object.freeze(SCHEDULE_CONFIG);

/**
 * Merge user config with defaults (user values override defaults)
 */
function mergeConfig(userConfig = {}) {
  const config = userConfig || {};
  // Warn about unknown keys (likely typos)
  for (const key of Object.keys(config)) {
    if (!(key in DEFAULT_STRATEGY_CONFIG)) {
      console.warn(`[strategyConfig] Unknown config key: "${key}" — possible typo`);
    }
  }
  return { ...DEFAULT_STRATEGY_CONFIG, ...config };
}

module.exports = {
  DEFAULT_STRATEGY_CONFIG,
  PARAM_RANGES,
  SCHEDULE_CONFIG,
  mergeConfig
};
