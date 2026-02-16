const { calculatePortfolioValue, calculatePortfolioPnL } = require('../lib/portfolio');

// ═══════════════════════════════════════════════════════════════════════════════
// calculatePortfolioValue Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('calculatePortfolioValue', () => {
  const makeMarketData = (prices = {}) => ({
    crypto: Object.fromEntries(
      Object.entries(prices).map(([asset, price]) => [asset, { price }])
    ),
  });

  test('returns 0 for null market data', () => {
    expect(calculatePortfolioValue([], null)).toBe(0);
  });

  test('returns 0 for undefined market data', () => {
    expect(calculatePortfolioValue([], undefined)).toBe(0);
  });

  test('returns 0 for market data without crypto', () => {
    expect(calculatePortfolioValue([], { metals: {} })).toBe(0);
  });

  test('returns 0 for empty portfolio', () => {
    const marketData = makeMarketData({ bitcoin: 65000 });
    expect(calculatePortfolioValue([], marketData)).toBe(0);
  });

  test('calculates value for single position', () => {
    const portfolio = [{ asset: 'bitcoin', amount: 2, buyPrice: 50000 }];
    const marketData = makeMarketData({ bitcoin: 65000 });
    expect(calculatePortfolioValue(portfolio, marketData)).toBe(130000);
  });

  test('calculates value for multiple positions', () => {
    const portfolio = [
      { asset: 'bitcoin', amount: 1, buyPrice: 50000 },
      { asset: 'ethereum', amount: 10, buyPrice: 2000 },
    ];
    const marketData = makeMarketData({ bitcoin: 65000, ethereum: 3500 });
    expect(calculatePortfolioValue(portfolio, marketData)).toBe(65000 + 35000);
  });

  test('uses 0 for assets not found in market data', () => {
    const portfolio = [{ asset: 'dogecoin', amount: 1000, buyPrice: 0.1 }];
    const marketData = makeMarketData({ bitcoin: 65000 });
    expect(calculatePortfolioValue(portfolio, marketData)).toBe(0);
  });

  test('handles fractional amounts', () => {
    const portfolio = [{ asset: 'bitcoin', amount: 0.5, buyPrice: 60000 }];
    const marketData = makeMarketData({ bitcoin: 70000 });
    expect(calculatePortfolioValue(portfolio, marketData)).toBe(35000);
  });

  test('handles very small amounts', () => {
    const portfolio = [{ asset: 'bitcoin', amount: 0.00001, buyPrice: 60000 }];
    const marketData = makeMarketData({ bitcoin: 65000 });
    expect(calculatePortfolioValue(portfolio, marketData)).toBeCloseTo(0.65, 5);
  });

  test('handles mixed found and not-found assets', () => {
    const portfolio = [
      { asset: 'bitcoin', amount: 1, buyPrice: 50000 },
      { asset: 'unknowncoin', amount: 100, buyPrice: 1 },
    ];
    const marketData = makeMarketData({ bitcoin: 65000 });
    expect(calculatePortfolioValue(portfolio, marketData)).toBe(65000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// calculatePortfolioPnL Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('calculatePortfolioPnL', () => {
  const makeMarketData = (prices = {}) => ({
    crypto: Object.fromEntries(
      Object.entries(prices).map(([asset, price]) => [asset, { price }])
    ),
  });

  test('returns zeros for null market data', () => {
    const result = calculatePortfolioPnL([], null);
    expect(result).toEqual({ pnl: 0, percentage: 0 });
  });

  test('returns zeros for undefined market data', () => {
    const result = calculatePortfolioPnL([], undefined);
    expect(result).toEqual({ pnl: 0, percentage: 0 });
  });

  test('returns zeros for market data without crypto', () => {
    const result = calculatePortfolioPnL([], { metals: {} });
    expect(result).toEqual({ pnl: 0, percentage: 0 });
  });

  test('returns zeros for empty portfolio', () => {
    const marketData = makeMarketData({ bitcoin: 65000 });
    const result = calculatePortfolioPnL([], marketData);
    expect(result).toEqual({ pnl: 0, percentage: 0 });
  });

  test('calculates profit correctly', () => {
    const portfolio = [{ asset: 'bitcoin', amount: 1, buyPrice: 50000 }];
    const marketData = makeMarketData({ bitcoin: 65000 });
    const result = calculatePortfolioPnL(portfolio, marketData);
    expect(result.pnl).toBe(15000);
    expect(result.percentage).toBe(30); // 15000/50000 * 100
  });

  test('calculates loss correctly', () => {
    const portfolio = [{ asset: 'bitcoin', amount: 1, buyPrice: 70000 }];
    const marketData = makeMarketData({ bitcoin: 60000 });
    const result = calculatePortfolioPnL(portfolio, marketData);
    expect(result.pnl).toBe(-10000);
    expect(result.percentage).toBeCloseTo(-14.2857, 2);
  });

  test('break-even returns zero PnL and percentage', () => {
    const portfolio = [{ asset: 'bitcoin', amount: 2, buyPrice: 50000 }];
    const marketData = makeMarketData({ bitcoin: 50000 });
    const result = calculatePortfolioPnL(portfolio, marketData);
    expect(result.pnl).toBe(0);
    expect(result.percentage).toBe(0);
  });

  test('calculates PnL across multiple positions', () => {
    const portfolio = [
      { asset: 'bitcoin', amount: 1, buyPrice: 50000 },    // invested 50k, now 65k → +15k
      { asset: 'ethereum', amount: 10, buyPrice: 3000 },    // invested 30k, now 35k → +5k
    ];
    const marketData = makeMarketData({ bitcoin: 65000, ethereum: 3500 });
    const result = calculatePortfolioPnL(portfolio, marketData);
    expect(result.pnl).toBe(20000); // 15000 + 5000
    expect(result.percentage).toBeCloseTo(25, 2); // 20000/80000 * 100
  });

  test('handles asset not in market data (current price = 0)', () => {
    const portfolio = [{ asset: 'unknowncoin', amount: 100, buyPrice: 10 }];
    const marketData = makeMarketData({ bitcoin: 65000 });
    const result = calculatePortfolioPnL(portfolio, marketData);
    expect(result.pnl).toBe(-1000); // invested 1000, now 0
    expect(result.percentage).toBe(-100);
  });

  test('returns 0 percentage when totalInvested is 0', () => {
    const portfolio = [{ asset: 'bitcoin', amount: 1, buyPrice: 0 }];
    const marketData = makeMarketData({ bitcoin: 65000 });
    const result = calculatePortfolioPnL(portfolio, marketData);
    expect(result.pnl).toBe(65000);
    expect(result.percentage).toBe(0); // Division guard: totalInvested > 0
  });

  test('handles fractional amounts in PnL', () => {
    const portfolio = [{ asset: 'bitcoin', amount: 0.5, buyPrice: 60000 }];
    const marketData = makeMarketData({ bitcoin: 70000 });
    const result = calculatePortfolioPnL(portfolio, marketData);
    expect(result.pnl).toBe(5000); // (0.5*70000) - (0.5*60000) = 35000-30000
    expect(result.percentage).toBeCloseTo(16.667, 1);
  });

  test('mixed profit and loss positions', () => {
    const portfolio = [
      { asset: 'bitcoin', amount: 1, buyPrice: 50000 },    // profit: +15k
      { asset: 'ethereum', amount: 10, buyPrice: 4000 },    // loss: -5k
    ];
    const marketData = makeMarketData({ bitcoin: 65000, ethereum: 3500 });
    const result = calculatePortfolioPnL(portfolio, marketData);
    expect(result.pnl).toBe(10000); // 15000 - 5000
    // totalInvested = 50000 + 40000 = 90000
    expect(result.percentage).toBeCloseTo(11.11, 1);
  });
});
