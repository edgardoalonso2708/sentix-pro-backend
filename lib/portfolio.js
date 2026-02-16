// ═══════════════════════════════════════════════════════════════════════════════
// PORTFOLIO CALCULATIONS - Extracted from frontend for testability
// ═══════════════════════════════════════════════════════════════════════════════

function calculatePortfolioValue(portfolio, marketData) {
  if (!marketData || !marketData.crypto) return 0;

  return portfolio.reduce((total, position) => {
    const currentPrice = marketData.crypto[position.asset]?.price || 0;
    return total + (position.amount * currentPrice);
  }, 0);
}

function calculatePortfolioPnL(portfolio, marketData) {
  if (!marketData || !marketData.crypto) return { pnl: 0, percentage: 0 };

  let totalInvested = 0;
  let totalCurrent = 0;

  portfolio.forEach(position => {
    const currentPrice = marketData.crypto[position.asset]?.price || 0;
    totalInvested += position.amount * position.buyPrice;
    totalCurrent += position.amount * currentPrice;
  });

  const pnl = totalCurrent - totalInvested;
  const percentage = totalInvested > 0 ? (pnl / totalInvested) * 100 : 0;

  return { pnl, percentage };
}

module.exports = { calculatePortfolioValue, calculatePortfolioPnL };
