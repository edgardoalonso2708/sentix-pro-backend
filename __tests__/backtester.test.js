// ═══════════════════════════════════════════════════════════════════════════════
// BACKTESTER UNIT TESTS
// Tests for simulateTradeExecution and calculateBacktestMetrics (pure functions)
// ═══════════════════════════════════════════════════════════════════════════════

const { simulateTradeExecution, calculateBacktestMetrics, SLIPPAGE, INTERVAL_MS } = require('../backtester');

// ─── HELPERS ────────────────────────────────────────────────────────────────

function makeCandle(timestamp, open, high, low, close, volume = 1000) {
  return { timestamp, open, high, low, close, volume };
}

function makeTrade(overrides = {}) {
  return {
    direction: 'LONG',
    entryPrice: 100000,
    stopLoss: 97000,
    takeProfit1: 104000,
    takeProfit2: 108000,
    trailingStop: 98500,
    trailingActivation: 106000,
    quantity: 0.05,
    remainingQty: 0.05,
    positionSizeUsd: 5000,
    riskAmount: 100,
    startIndex: 0,
    asset: 'bitcoin',
    ...overrides
  };
}

// Generate a series of flat candles
function flatCandles(count, price = 100000, startTs = 1700000000000) {
  return Array.from({ length: count }, (_, i) => makeCandle(
    startTs + i * 3600000,
    price, price + 10, price - 10, price
  ));
}

// ═══════════════════════════════════════════════════════════════════════════════
// simulateTradeExecution Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('simulateTradeExecution', () => {

  // ─── LONG TRADES ─────────────────────────────────────────────────────────

  describe('LONG trades', () => {

    test('hits stop loss when price drops below SL', () => {
      const trade = makeTrade({ entryPrice: 100000, stopLoss: 97000 });
      const candles = [
        makeCandle(1000, 100000, 100500, 99500, 100200), // entry candle
        makeCandle(2000, 100200, 100800, 99800, 100300), // normal
        makeCandle(3000, 100300, 100400, 96500, 96800),  // SL hit
      ];

      const result = simulateTradeExecution(trade, candles, 0);

      expect(result.exitReason).toBe('stop_loss');
      expect(result.exitIndex).toBe(2);
      expect(result.exitPrice).toBeCloseTo(97000 * (1 - SLIPPAGE), 2);
      expect(result.pnl).toBeLessThan(0);
      expect(result.holdingBars).toBe(2);
    });

    test('hits TP1 with partial close (50%)', () => {
      const trade = makeTrade({
        entryPrice: 100000, takeProfit1: 104000,
        takeProfit2: 108000, stopLoss: 97000
      });
      const candles = [
        makeCandle(1000, 100000, 100500, 99500, 100200),
        makeCandle(2000, 100200, 104500, 100100, 104000), // hits TP1
        makeCandle(3000, 104000, 104200, 103800, 104100), // normal after partial
        makeCandle(4000, 104100, 109000, 104000, 108500), // hits TP2
      ];

      const result = simulateTradeExecution(trade, candles, 0);

      expect(result.exitReason).toBe('take_profit_2');
      expect(result.exitIndex).toBe(3);
      expect(result.partialClosePrice).toBeTruthy();
      expect(result.partialCloseIndex).toBe(1);
      expect(result.pnl).toBeGreaterThan(0);
    });

    test('activates trailing stop and exits when price reverses', () => {
      const trade = makeTrade({
        entryPrice: 100000, trailingActivation: 106000,
        trailingStop: 98500, stopLoss: 97000
      });
      // trailingDistance = |100000 - 98500| = 1500
      const candles = [
        makeCandle(1000, 100000, 100500, 99500, 100200),
        makeCandle(2000, 100200, 106500, 100100, 106200), // activates trailing
        makeCandle(3000, 106200, 107000, 106100, 106800), // peak = 107000, trailingSL = 107000 - 1500 = 105500
        makeCandle(4000, 106800, 107500, 106700, 107200), // peak = 107500, trailingSL = 106000
        makeCandle(5000, 107200, 107300, 105800, 105900), // low 105800 < trailingSL ~106000 → hit
      ];

      const result = simulateTradeExecution(trade, candles, 0);

      expect(result.exitReason).toBe('trailing_stop');
      expect(result.exitIndex).toBe(4);
      expect(result.pnl).toBeGreaterThan(0);
    });

    test('closes at end of data when no exit triggered', () => {
      const trade = makeTrade({
        entryPrice: 100000, stopLoss: 90000,
        takeProfit1: 120000, takeProfit2: 130000,
        trailingActivation: 125000
      });
      const candles = [
        makeCandle(1000, 100000, 100500, 99500, 100200),
        makeCandle(2000, 100200, 101000, 99800, 100500),
        makeCandle(3000, 100500, 101200, 100100, 101000),
      ];

      const result = simulateTradeExecution(trade, candles, 0);

      expect(result.exitReason).toBe('end_of_data');
      expect(result.exitPrice).toBe(101000); // last candle close
      expect(result.holdingBars).toBe(2);
    });

    test('SL wins when both SL and TP1 triggered in same candle (conservative)', () => {
      const trade = makeTrade({
        entryPrice: 100000, stopLoss: 97000, takeProfit1: 104000
      });
      const candles = [
        makeCandle(1000, 100000, 100500, 99500, 100200),
        makeCandle(2000, 100200, 104500, 96000, 100000), // both SL and TP1 in range
      ];

      const result = simulateTradeExecution(trade, candles, 0);

      // SL is checked first (conservative approach)
      expect(result.exitReason).toBe('stop_loss');
      expect(result.pnl).toBeLessThan(0);
    });

    test('calculates slippage correctly on exit', () => {
      const trade = makeTrade({ entryPrice: 100000, stopLoss: 97000 });
      const candles = [
        makeCandle(1000, 100000, 100500, 99500, 100200),
        makeCandle(2000, 100200, 100300, 96500, 96800),
      ];

      const result = simulateTradeExecution(trade, candles, 0);

      // LONG SL exit: price * (1 - SLIPPAGE) = 97000 * 0.999
      expect(result.exitPrice).toBeCloseTo(97000 * 0.999, 2);
    });
  });

  // ─── SHORT TRADES ────────────────────────────────────────────────────────

  describe('SHORT trades', () => {

    test('hits stop loss when price rises above SL', () => {
      const trade = makeTrade({
        direction: 'SHORT',
        entryPrice: 100000, stopLoss: 103000,
        takeProfit1: 96000, takeProfit2: 92000,
        trailingStop: 101500, trailingActivation: 94000
      });
      const candles = [
        makeCandle(1000, 100000, 100500, 99500, 99800),
        makeCandle(2000, 99800, 103500, 99700, 103200), // SL hit (high >= 103000)
      ];

      const result = simulateTradeExecution(trade, candles, 0);

      expect(result.exitReason).toBe('stop_loss');
      expect(result.exitPrice).toBeCloseTo(103000 * (1 + SLIPPAGE), 2);
      expect(result.pnl).toBeLessThan(0);
    });

    test('hits TP1 and TP2 for short trade', () => {
      const trade = makeTrade({
        direction: 'SHORT',
        entryPrice: 100000, stopLoss: 103000,
        takeProfit1: 96000, takeProfit2: 92000,
        trailingStop: 101500, trailingActivation: 94000
      });
      const candles = [
        makeCandle(1000, 100000, 100200, 99800, 99900),
        makeCandle(2000, 99900, 100100, 95500, 95800), // TP1 hit (low <= 96000)
        makeCandle(3000, 95800, 96200, 95000, 95100),
        makeCandle(4000, 95100, 95300, 91500, 91800), // TP2 hit (low <= 92000)
      ];

      const result = simulateTradeExecution(trade, candles, 0);

      expect(result.exitReason).toBe('take_profit_2');
      expect(result.partialClosePrice).toBeTruthy();
      expect(result.pnl).toBeGreaterThan(0);
    });

    test('trailing stop activates and triggers for short', () => {
      const trade = makeTrade({
        direction: 'SHORT',
        entryPrice: 100000, stopLoss: 103000,
        takeProfit1: 96000, takeProfit2: 92000,
        trailingStop: 101500, trailingActivation: 94000
      });
      // trailingDistance = |100000 - 101500| = 1500 (for short, trailing is above)
      const candles = [
        makeCandle(1000, 100000, 100200, 99800, 99900),
        makeCandle(2000, 99900, 100100, 95800, 95900), // TP1 hit
        makeCandle(3000, 95900, 96200, 93500, 93800),   // getting close to trailing activation
        makeCandle(4000, 93800, 94100, 93000, 93200),   // trailing activates (low <=94000), peak = 93000, trailingSL = 93000 + 1500 = 94500
        makeCandle(5000, 93200, 95000, 93000, 94800),   // high 95000 >= 94500 → trailing hit
      ];

      const result = simulateTradeExecution(trade, candles, 0);

      expect(result.exitReason).toBe('trailing_stop');
      expect(result.pnl).toBeGreaterThan(0);
    });
  });

  // ─── EDGE CASES ──────────────────────────────────────────────────────────

  describe('Edge cases', () => {

    test('handles trade with startIndex in middle of candles', () => {
      const trade = makeTrade({ entryPrice: 100000, stopLoss: 97000 });
      const candles = [
        makeCandle(1000, 99000, 99500, 98500, 99200), // before trade
        makeCandle(2000, 99200, 99800, 99000, 99500), // before trade
        makeCandle(3000, 100000, 100500, 99500, 100200), // entry candle (startIndex=2)
        makeCandle(4000, 100200, 100800, 96000, 96500), // SL hit
      ];

      const result = simulateTradeExecution(trade, candles, 2);

      expect(result.exitReason).toBe('stop_loss');
      expect(result.exitIndex).toBe(3);
      expect(result.holdingBars).toBe(1);
    });

    test('returns correct holdingBars count', () => {
      const trade = makeTrade({
        entryPrice: 100000, stopLoss: 90000,
        takeProfit1: 120000, takeProfit2: 130000
      });
      const candles = flatCandles(10);

      const result = simulateTradeExecution(trade, candles, 0);

      expect(result.exitReason).toBe('end_of_data');
      expect(result.holdingBars).toBe(9); // 10 candles, entry at 0, last at 9
    });

    test('tracks max favorable and max adverse excursion', () => {
      const trade = makeTrade({ entryPrice: 100000, stopLoss: 90000 });
      const candles = [
        makeCandle(1000, 100000, 100500, 99500, 100200),
        makeCandle(2000, 100200, 102000, 100100, 101800), // favorable
        makeCandle(3000, 101800, 101900, 98000, 98500),   // adverse
        makeCandle(4000, 98500, 99000, 97500, 98800),
      ];

      const result = simulateTradeExecution(trade, candles, 0);

      expect(result.maxFavorable).toBeGreaterThan(0);
      expect(result.maxAdverse).toBeLessThan(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// calculateBacktestMetrics Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('calculateBacktestMetrics', () => {

  test('returns zeros for empty trades', () => {
    const result = calculateBacktestMetrics([], [], 10000, 90);

    expect(result.totalTrades).toBe(0);
    expect(result.winCount).toBe(0);
    expect(result.lossCount).toBe(0);
    expect(result.winRate).toBe(0);
    expect(result.totalPnl).toBe(0);
    expect(result.maxDrawdown).toBe(0);
    expect(result.profitFactor).toBe(0);
  });

  test('returns zeros for null trades', () => {
    const result = calculateBacktestMetrics(null, [], 10000, 90);

    expect(result.totalTrades).toBe(0);
  });

  test('calculates win rate correctly', () => {
    const trades = [
      { pnl: 100, pnlPercent: 2, holdingBars: 5, asset: 'bitcoin', direction: 'LONG', exitReason: 'take_profit_1' },
      { pnl: 150, pnlPercent: 3, holdingBars: 8, asset: 'bitcoin', direction: 'LONG', exitReason: 'take_profit_2' },
      { pnl: -80, pnlPercent: -1.6, holdingBars: 3, asset: 'bitcoin', direction: 'SHORT', exitReason: 'stop_loss' },
      { pnl: 200, pnlPercent: 4, holdingBars: 12, asset: 'bitcoin', direction: 'SHORT', exitReason: 'trailing_stop' },
    ];
    const equity = [
      { equity: 10000, timestamp: 1000 },
      { equity: 10100, timestamp: 2000 },
      { equity: 10250, timestamp: 3000 },
      { equity: 10170, timestamp: 4000 },
      { equity: 10370, timestamp: 5000 },
    ];

    const result = calculateBacktestMetrics(trades, equity, 10000, 90);

    expect(result.totalTrades).toBe(4);
    expect(result.winCount).toBe(3);
    expect(result.lossCount).toBe(1);
    expect(result.winRate).toBe(75);
    expect(result.totalPnl).toBe(370);
    expect(result.totalPnlPercent).toBe(3.7);
  });

  test('calculates profit factor correctly', () => {
    const trades = [
      { pnl: 200, pnlPercent: 4, holdingBars: 5, asset: 'bitcoin', direction: 'LONG', exitReason: 'tp1' },
      { pnl: -100, pnlPercent: -2, holdingBars: 3, asset: 'bitcoin', direction: 'SHORT', exitReason: 'sl' },
      { pnl: 300, pnlPercent: 6, holdingBars: 7, asset: 'bitcoin', direction: 'LONG', exitReason: 'tp2' },
    ];
    const equity = [{ equity: 10000, timestamp: 1000 }, { equity: 10400, timestamp: 5000 }];

    const result = calculateBacktestMetrics(trades, equity, 10000, 30);

    // grossProfit = 500, grossLoss = 100
    expect(result.profitFactor).toBe(5);
  });

  test('calculates max drawdown from equity curve', () => {
    const trades = [
      { pnl: 500, pnlPercent: 5, holdingBars: 5, asset: 'bitcoin', direction: 'LONG', exitReason: 'tp1' },
      { pnl: -800, pnlPercent: -8, holdingBars: 3, asset: 'bitcoin', direction: 'SHORT', exitReason: 'sl' },
      { pnl: 200, pnlPercent: 2, holdingBars: 4, asset: 'bitcoin', direction: 'LONG', exitReason: 'tp1' },
    ];
    const equity = [
      { equity: 10000, timestamp: 1000 },
      { equity: 10500, timestamp: 2000 }, // peak
      { equity: 9700, timestamp: 3000 },  // drawdown = 800, 7.62%
      { equity: 9900, timestamp: 4000 },
    ];

    const result = calculateBacktestMetrics(trades, equity, 10000, 30);

    expect(result.maxDrawdown).toBe(800);
    expect(result.maxDrawdownPercent).toBeCloseTo(7.62, 1);
  });

  test('calculates consecutive wins and losses', () => {
    const trades = [
      { pnl: 100, pnlPercent: 1, holdingBars: 5, asset: 'bitcoin', direction: 'LONG', exitReason: 'tp1' },
      { pnl: 200, pnlPercent: 2, holdingBars: 5, asset: 'bitcoin', direction: 'LONG', exitReason: 'tp2' },
      { pnl: 150, pnlPercent: 1.5, holdingBars: 5, asset: 'bitcoin', direction: 'SHORT', exitReason: 'tp1' },
      { pnl: -80, pnlPercent: -0.8, holdingBars: 3, asset: 'bitcoin', direction: 'SHORT', exitReason: 'sl' },
      { pnl: -60, pnlPercent: -0.6, holdingBars: 2, asset: 'bitcoin', direction: 'LONG', exitReason: 'sl' },
    ];
    const equity = [{ equity: 10000, timestamp: 1000 }, { equity: 10310, timestamp: 5000 }];

    const result = calculateBacktestMetrics(trades, equity, 10000, 30);

    expect(result.maxConsecutiveWins).toBe(3);
    expect(result.maxConsecutiveLosses).toBe(2);
  });

  test('calculates average profit and loss correctly', () => {
    const trades = [
      { pnl: 100, pnlPercent: 1, holdingBars: 5, asset: 'bitcoin', direction: 'LONG', exitReason: 'tp1' },
      { pnl: 300, pnlPercent: 3, holdingBars: 8, asset: 'bitcoin', direction: 'SHORT', exitReason: 'tp2' },
      { pnl: -50, pnlPercent: -0.5, holdingBars: 2, asset: 'bitcoin', direction: 'LONG', exitReason: 'sl' },
      { pnl: -150, pnlPercent: -1.5, holdingBars: 3, asset: 'bitcoin', direction: 'SHORT', exitReason: 'sl' },
    ];
    const equity = [{ equity: 10000, timestamp: 1000 }, { equity: 10200, timestamp: 5000 }];

    const result = calculateBacktestMetrics(trades, equity, 10000, 30);

    expect(result.avgProfit).toBe(200); // (100+300)/2
    expect(result.avgLoss).toBe(100);   // (50+150)/2
  });

  test('identifies best and worst trades', () => {
    const trades = [
      { pnl: 100, pnlPercent: 1, holdingBars: 5, asset: 'bitcoin', direction: 'LONG', exitReason: 'tp1' },
      { pnl: 500, pnlPercent: 5, holdingBars: 8, asset: 'bitcoin', direction: 'SHORT', exitReason: 'tp2' },
      { pnl: -200, pnlPercent: -2, holdingBars: 3, asset: 'bitcoin', direction: 'LONG', exitReason: 'sl' },
    ];
    const equity = [{ equity: 10000, timestamp: 1000 }, { equity: 10400, timestamp: 5000 }];

    const result = calculateBacktestMetrics(trades, equity, 10000, 30);

    expect(result.bestTrade.pnl).toBe(500);
    expect(result.worstTrade.pnl).toBe(-200);
  });

  test('handles all winning trades (profit factor = Infinity)', () => {
    const trades = [
      { pnl: 100, pnlPercent: 1, holdingBars: 5, asset: 'bitcoin', direction: 'LONG', exitReason: 'tp1' },
      { pnl: 200, pnlPercent: 2, holdingBars: 8, asset: 'bitcoin', direction: 'SHORT', exitReason: 'tp2' },
    ];
    const equity = [{ equity: 10000, timestamp: 1000 }, { equity: 10300, timestamp: 5000 }];

    const result = calculateBacktestMetrics(trades, equity, 10000, 30);

    expect(result.profitFactor).toBe(Infinity);
    expect(result.lossCount).toBe(0);
  });

  test('calculates trades per month', () => {
    const trades = [
      { pnl: 100, pnlPercent: 1, holdingBars: 5, asset: 'bitcoin', direction: 'LONG', exitReason: 'tp1' },
      { pnl: 200, pnlPercent: 2, holdingBars: 8, asset: 'bitcoin', direction: 'SHORT', exitReason: 'tp2' },
      { pnl: -50, pnlPercent: -0.5, holdingBars: 3, asset: 'bitcoin', direction: 'LONG', exitReason: 'sl' },
    ];
    const equity = [{ equity: 10000, timestamp: 1000 }];

    const result = calculateBacktestMetrics(trades, equity, 10000, 90);

    // 3 trades / 90 days * 30 = 1.0
    expect(result.tradesPerMonth).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Constants Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Constants', () => {
  test('SLIPPAGE is 0.1%', () => {
    expect(SLIPPAGE).toBe(0.001);
  });

  test('INTERVAL_MS has correct values', () => {
    expect(INTERVAL_MS['15m']).toBe(15 * 60 * 1000);
    expect(INTERVAL_MS['1h']).toBe(60 * 60 * 1000);
    expect(INTERVAL_MS['4h']).toBe(4 * 60 * 60 * 1000);
    expect(INTERVAL_MS['1d']).toBe(24 * 60 * 60 * 1000);
  });
});
