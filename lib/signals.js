// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL GENERATION ENGINE - Extracted for testability
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

  let score = 50;
  let confidence = 0;
  const signalReasons = [];

  // RSI Analysis
  if (rsi < 30) {
    score += 15;
    confidence += 20;
    signalReasons.push('RSI oversold');
  } else if (rsi > 70) {
    score -= 15;
    confidence += 20;
    signalReasons.push('RSI overbought');
  }

  // MACD Analysis
  if (macd.histogram > 0) {
    score += 12;
    confidence += 15;
    signalReasons.push('MACD bullish');
  } else {
    score -= 12;
    confidence += 15;
    signalReasons.push('MACD bearish');
  }

  // 24h change
  if (data.change24h > 5) {
    score += 8;
    confidence += 10;
    signalReasons.push('Strong 24h momentum');
  } else if (data.change24h < -5) {
    score -= 8;
    confidence += 10;
    signalReasons.push('Weak 24h momentum');
  }

  // Fear & Greed bonus
  if (macro.fearGreed < 25 && score > 50) {
    score += 5;
    confidence += 8;
    signalReasons.push('Extreme fear = opportunity');
  }

  score = Math.max(0, Math.min(100, score));
  confidence = Math.min(100, confidence);

  const action = score >= 65 ? 'BUY' : score >= 45 ? 'HOLD' : 'SELL';

  return {
    asset: coinId.toUpperCase(),
    action,
    score,
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

    if (signal.confidence >= 70) {
      signals.push(signal);
    }
  }

  return signals.sort((a, b) => b.confidence - a.confidence);
}

function filterCriticalSignals(signals) {
  return signals.filter(s =>
    (s.action === 'BUY' && s.confidence >= 75 && s.score >= 70) ||
    (s.action === 'SELL' && s.confidence >= 75 && s.score <= 30)
  );
}

module.exports = {
  generateMockHistory,
  computeSignalFromData,
  generateSignals,
  filterCriticalSignals,
};
