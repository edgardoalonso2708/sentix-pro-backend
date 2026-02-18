// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL GENERATION ENGINE - Extracted for testability
// v3.0: Updated to match new professional scoring system
// ═══════════════════════════════════════════════════════════════════════════════

const { calculateRSI, calculateMACD } = require('./indicators');

function generateMockHistory(currentPrice, days) {
  const prices = [];
  let price = currentPrice * 0.9;

  for (let i = 0; i < days; i++) {
    const change = (Math.random() - 0.48) * 0.03;
    price = price * (1 + change);
    prices.push(price);
  }

  prices.push(currentPrice);
  return prices;
}

function computeSignalFromData(coinId, data, macro, historicalPrices) {
  const rsi = calculateRSI(historicalPrices);
  const macd = calculateMACD(historicalPrices);

  // v3: Use bidirectional score (-100 to +100)
  let rawScore = 0;
  let confidence = 0;
  const signalReasons = [];

  // RSI Analysis (with context)
  if (rsi < 25) {
    rawScore += 15;
    confidence += 15;
    signalReasons.push(`RSI oversold (${rsi.toFixed(0)})`);
  } else if (rsi < 40) {
    rawScore += 5;
    confidence += 8;
    signalReasons.push(`RSI leaning bullish (${rsi.toFixed(0)})`);
  } else if (rsi > 75) {
    rawScore -= 15;
    confidence += 15;
    signalReasons.push(`RSI overbought (${rsi.toFixed(0)})`);
  } else if (rsi > 60) {
    rawScore -= 5;
    confidence += 8;
    signalReasons.push(`RSI leaning bearish (${rsi.toFixed(0)})`);
  } else {
    confidence += 3;
    signalReasons.push(`RSI neutral (${rsi.toFixed(0)})`);
  }

  // MACD Analysis
  if (macd.histogram > 0) {
    rawScore += 12;
    confidence += 10;
    signalReasons.push('MACD bullish');
  } else {
    rawScore -= 12;
    confidence += 10;
    signalReasons.push('MACD bearish');
  }

  // 24h change (minor weight)
  if (data.change24h > 5) {
    rawScore += 5;
    confidence += 5;
    signalReasons.push('Strong 24h momentum');
  } else if (data.change24h < -5) {
    rawScore -= 5;
    confidence += 5;
    signalReasons.push('Weak 24h momentum');
  }

  // Fear & Greed (minor modifier)
  if (macro.fearGreed < 15 && rawScore > 0) {
    rawScore += 3;
    confidence += 3;
    signalReasons.push('Extreme fear = contrarian');
  } else if (macro.fearGreed > 85 && rawScore < 0) {
    rawScore -= 3;
    confidence += 3;
    signalReasons.push('Extreme greed = caution');
  }

  // Convert to display score (0-100)
  const score = Math.max(0, Math.min(100, Math.round((rawScore + 100) / 2)));
  confidence = Math.max(0, Math.min(85, confidence));

  // Determine action with higher thresholds
  let action = 'HOLD';
  if (rawScore >= 20) action = 'BUY';
  else if (rawScore <= -20) action = 'SELL';

  return {
    asset: coinId.toUpperCase(),
    action,
    score,
    rawScore,
    confidence,
    price: data.price,
    change24h: data.change24h,
    reasons: signalReasons.join(' · '),
    timestamp: Date.now(),
  };
}

function generateSignals(marketCache) {
  const signals = [];

  for (const [coinId, data] of Object.entries(marketCache.crypto || {})) {
    const historicalPrices = generateMockHistory(data.price, 30);
    const signal = computeSignalFromData(coinId, data, marketCache.macro || {}, historicalPrices);

    // Only include signals with meaningful confidence
    if (signal.action !== 'HOLD' && signal.confidence >= 30) {
      signals.push(signal);
    } else if (signal.action === 'HOLD' && signal.confidence >= 50) {
      signals.push(signal);
    }
  }

  return signals.sort((a, b) => b.confidence - a.confidence);
}

function filterCriticalSignals(signals) {
  return signals.filter(s =>
    (s.action === 'BUY' && s.confidence >= 60 && s.rawScore >= 35) ||
    (s.action === 'SELL' && s.confidence >= 60 && s.rawScore <= -35)
  );
}

module.exports = {
  generateMockHistory,
  computeSignalFromData,
  generateSignals,
  filterCriticalSignals,
};
