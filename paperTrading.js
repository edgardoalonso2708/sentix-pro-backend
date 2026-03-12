// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - Paper Trading Module
// Simulated trading system that auto-executes based on signal engine output
// ═══════════════════════════════════════════════════════════════════════════════

const { logger } = require('./logger');
const { SLIPPAGE, COMMISSION, getAssetCost, estimateFillFromOrderBook, getTimeOfDayMultiplier } = require('./constants');
const { buildSizingOptions } = require('./kellySizing');

// ─── EXECUTION SIMULATION ───────────────────────────────────────────────────

function applySlippage(price, isBuy, asset = null, orderBook = null, tradeSizeUsd = 0) {
  // Order book execution: use real depth when available
  if (orderBook && orderBook.bestBid && tradeSizeUsd > 0) {
    const side = isBuy ? 'BUY' : 'SELL';
    const estimate = estimateFillFromOrderBook(orderBook, side, tradeSizeUsd, price);
    // Add commission on top of order-book fill
    return isBuy ? estimate.fillPrice * (1 + COMMISSION) : estimate.fillPrice * (1 - COMMISSION);
  }

  // Fallback: per-asset slippage × time-of-day liquidity multiplier
  const baseCost = asset ? getAssetCost(asset) : (SLIPPAGE + COMMISSION);
  const todMult = getTimeOfDayMultiplier();
  const cost = baseCost * todMult;
  return isBuy ? price * (1 + cost) : price * (1 - cost);
}

// ─── DEFAULT CONFIGURATION ──────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  initial_capital: 10000,
  current_capital: 10000,
  risk_per_trade: 0.01,          // 1% — conservative for crypto volatility
  max_open_positions: 3,
  max_daily_loss_percent: 0.05,  // 5%
  cooldown_minutes: 30,
  min_confluence: 3,             // require 3+ aligned factors (was 2)
  min_rr_ratio: 1.5,
  allowed_strength: ['STRONG BUY', 'STRONG SELL'],
  is_enabled: true,
  daily_pnl: 0,
  daily_pnl_reset_at: new Date().toISOString(),
  last_trade_at: null,
  max_position_percent: 0.30,       // Max 30% of capital per position
  partial_close_ratio: 0.5,         // Close 50% at TP1
  max_holding_hours: 168,           // 7 days max holding period (0 = disabled)
  move_sl_to_breakeven_after_tp1: true,  // Move SL to entry after TP1 hit
  // Portfolio correlation limits
  max_portfolio_correlation: 0.70,  // Block new trade if avg correlation with open positions > 70%
  max_sector_exposure_pct: 0.80,    // Max 80% of capital in same sector (crypto/metals)
  max_same_direction_crypto: 3,     // Max same-direction crypto positions
};

// ─── CONFIG VALIDATION RANGES ────────────────────────────────────────────────
const CONFIG_VALIDATION = {
  risk_per_trade:        { min: 0.001, max: 0.10, type: 'number' },
  max_open_positions:    { min: 1,     max: 10,   type: 'integer' },
  max_daily_loss_percent:{ min: 0.01,  max: 0.20, type: 'number' },
  cooldown_minutes:      { min: 5,     max: 1440, type: 'integer' },
  min_confluence:        { min: 2,     max: 5,    type: 'integer' },
  min_rr_ratio:          { min: 0.5,   max: 5.0,  type: 'number' },
  initial_capital:       { min: 100,   max: 10000000, type: 'number' },
  max_position_percent:  { min: 0.05,  max: 0.50, type: 'number' },
  partial_close_ratio:   { min: 0.25,  max: 0.75, type: 'number' },
  max_holding_hours:     { min: 0,     max: 720,  type: 'integer' },  // 0 = disabled, max 30 days
  max_portfolio_correlation: { min: 0.3, max: 1.0, type: 'number' },
  max_sector_exposure_pct:   { min: 0.3, max: 1.0, type: 'number' },
  max_same_direction_crypto: { min: 1,   max: 10,  type: 'integer' },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ATOMIC CAPITAL UPDATE (prevents race conditions on concurrent trade closes)
// ═══════════════════════════════════════════════════════════════════════════════

const capitalUpdateQueue = new Map();

async function updateCapitalAtomic(supabase, userId, delta) {
  const prev = capitalUpdateQueue.get(userId) || Promise.resolve();
  const next = prev.then(async () => {
    const { data: configData } = await supabase
      .from('paper_config')
      .select('current_capital, daily_pnl')
      .eq('user_id', userId)
      .single();

    if (configData) {
      await supabase
        .from('paper_config')
        .update({
          current_capital: parseFloat(configData.current_capital) + delta,
          daily_pnl: parseFloat(configData.daily_pnl) + delta
        })
        .eq('user_id', userId);
    }
  }).catch(err => {
    logger.error('Atomic capital update failed', { userId, delta, error: err.message });
  }).finally(() => {
    // Clean up queue entry once the chain resolves (prevents memory leak)
    if (capitalUpdateQueue.get(userId) === next) {
      capitalUpdateQueue.delete(userId);
    }
  });
  capitalUpdateQueue.set(userId, next);
  return next;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRICE RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════════

function resolveCurrentPrice(asset, marketData) {
  if (!asset || !marketData) return null;
  const lower = asset.toLowerCase();

  // Metals
  if (lower.includes('gold') || lower.includes('xau') || lower.includes('paxg')) {
    return marketData?.metals?.gold?.price || null;
  }
  if (lower.includes('silver') || lower.includes('xag')) {
    return marketData?.metals?.silver?.price || null;
  }

  // Crypto - try direct match then search
  if (marketData?.crypto?.[lower]?.price) {
    return marketData.crypto[lower].price;
  }

  // Try common mappings
  const assetMap = {
    'btc': 'bitcoin', 'eth': 'ethereum', 'bnb': 'binancecoin',
    'sol': 'solana', 'ada': 'cardano', 'xrp': 'ripple',
    'dot': 'polkadot', 'doge': 'dogecoin', 'avax': 'avalanche-2',
    'link': 'chainlink', 'matic': 'matic-network', 'uni': 'uniswap',
    'atom': 'cosmos', 'ltc': 'litecoin'
  };
  const mapped = assetMap[lower];
  if (mapped && marketData?.crypto?.[mapped]?.price) {
    return marketData.crypto[mapped].price;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

async function getOrCreateConfig(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from('paper_config')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code === 'PGRST116') {
      // Not found - create with defaults
      const { data: newConfig, error: insertError } = await supabase
        .from('paper_config')
        .insert({ user_id: userId, ...DEFAULT_CONFIG })
        .select()
        .single();

      if (insertError) {
        logger.error('Failed to create paper config', { error: insertError.message });
        return { config: null, error: insertError };
      }
      logger.info('Paper config created with defaults', { userId });
      return { config: newConfig, error: null };
    }

    if (error) {
      logger.error('Failed to fetch paper config', { error: error.message });
      return { config: null, error };
    }

    return { config: data, error: null };
  } catch (err) {
    logger.error('getOrCreateConfig exception', { error: err.message });
    return { config: null, error: err };
  }
}

async function updateConfig(supabase, userId, updates) {
  try {
    const allowedFields = [
      'initial_capital', 'risk_per_trade', 'max_open_positions',
      'max_daily_loss_percent', 'cooldown_minutes', 'min_confluence',
      'min_rr_ratio', 'allowed_strength', 'is_enabled',
      'max_position_percent', 'partial_close_ratio', 'max_holding_hours',
      'move_sl_to_breakeven_after_tp1',
      'daily_pnl', 'daily_pnl_reset_at'
    ];

    const filtered = {};
    const validationErrors = [];

    for (const key of allowedFields) {
      if (updates[key] !== undefined) {
        // Range validation for numeric fields
        const rules = CONFIG_VALIDATION[key];
        if (rules) {
          const val = Number(updates[key]);
          if (isNaN(val)) {
            validationErrors.push(`${key}: must be a number`);
            continue;
          }
          if (rules.type === 'integer' && !Number.isInteger(val)) {
            validationErrors.push(`${key}: must be an integer`);
            continue;
          }
          if (val < rules.min || val > rules.max) {
            validationErrors.push(`${key}: must be between ${rules.min} and ${rules.max}`);
            continue;
          }
        }
        filtered[key] = updates[key];
      }
    }

    if (validationErrors.length > 0) {
      return { config: null, error: `Validation failed: ${validationErrors.join('; ')}` };
    }

    if (Object.keys(filtered).length === 0) {
      return { config: null, error: 'No valid fields to update' };
    }

    const { data, error } = await supabase
      .from('paper_config')
      .update(filtered)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      logger.error('Failed to update paper config', { error: error.message });
      return { config: null, error };
    }

    logger.info('Paper config updated', { userId, fields: Object.keys(filtered) });
    return { config: data, error: null };
  } catch (err) {
    logger.error('updateConfig exception', { error: err.message });
    return { config: null, error: err };
  }
}

async function resetPaperAccount(supabase, userId) {
  try {
    // Cancel all open trades (don't mark as closed with 0 PnL — that corrupts analytics)
    const { data: openTrades } = await supabase
      .from('paper_trades')
      .select('id')
      .eq('user_id', userId)
      .in('status', ['open', 'partial']);

    const closedCount = openTrades?.length || 0;

    if (closedCount > 0) {
      await supabase
        .from('paper_trades')
        .update({
          status: 'cancelled',
          exit_reason: 'account_reset',
          exit_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .in('status', ['open', 'partial']);
    }

    // Get initial capital and reset
    const { data: config } = await supabase
      .from('paper_config')
      .select('initial_capital')
      .eq('user_id', userId)
      .single();

    const initialCapital = config?.initial_capital || DEFAULT_CONFIG.initial_capital;

    const { data: resetConfig, error } = await supabase
      .from('paper_config')
      .update({
        current_capital: initialCapital,
        daily_pnl: 0,
        daily_pnl_reset_at: new Date().toISOString(),
        last_trade_at: null
      })
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      return { config: null, closedCount: 0, error };
    }

    logger.info('Paper account reset', { userId, closedCount, capital: initialCapital });
    return { config: resetConfig, closedCount, error: null };
  } catch (err) {
    logger.error('resetPaperAccount exception', { error: err.message });
    return { config: null, closedCount: 0, error: err };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PURE EVALUATION FUNCTIONS (no DB)
// ═══════════════════════════════════════════════════════════════════════════════

function evaluateSignalForTrade(signal, config) {
  if (!config.is_enabled) {
    return { eligible: false, reason: 'Paper trading disabled' };
  }

  if (!signal || !signal.action || signal.action === 'HOLD') {
    return { eligible: false, reason: 'Signal is HOLD or missing' };
  }

  if (!config.allowed_strength.includes(signal.strengthLabel)) {
    return { eligible: false, reason: `Strength ${signal.strengthLabel} not in allowed list` };
  }

  if (!signal.tradeLevels || !signal.tradeLevels.entry || !signal.tradeLevels.stopLoss || !signal.tradeLevels.takeProfit1) {
    return { eligible: false, reason: 'Missing trade levels' };
  }

  if (signal.tradeLevels.entry <= 0 || signal.tradeLevels.stopLoss <= 0 || signal.tradeLevels.takeProfit1 <= 0) {
    return { eligible: false, reason: 'Invalid trade level values' };
  }

  // Check R:R ratio
  if (signal.tradeLevels.riskRewardRatio < config.min_rr_ratio) {
    return { eligible: false, reason: `R:R ${signal.tradeLevels.riskRewardRatio.toFixed(2)} below minimum ${config.min_rr_ratio}` };
  }

  // Check confluence
  if (signal.timeframes) {
    const tfEntries = Object.entries(signal.timeframes)
      .filter(([k, v]) => typeof v === 'object' && v.trend);
    const bullish = tfEntries.filter(([, v]) => v.trend === 'bullish').length;
    const bearish = tfEntries.filter(([, v]) => v.trend === 'bearish').length;
    const confluenceCount = Math.max(bullish, bearish);

    if (confluenceCount < config.min_confluence) {
      return { eligible: false, reason: `Confluence ${confluenceCount} below minimum ${config.min_confluence}` };
    }
  }

  return { eligible: true, reason: 'All criteria met' };
}

function calculatePositionSize(config, signal, sizingOptions = null) {
  const entryPrice = signal.tradeLevels.entry;
  const stopLoss = signal.tradeLevels.stopLoss;
  const riskPerUnit = Math.abs(entryPrice - stopLoss);

  if (riskPerUnit <= 0) {
    return { positionSizeUsd: 0, quantity: 0, riskAmount: 0 };
  }

  // Kelly Criterion: replace fixed risk_per_trade with data-driven fraction
  let effectiveRiskPerTrade = config.risk_per_trade;
  let kellyApplied = false;
  if (sizingOptions?.kellyResult?.applied && sizingOptions.kellyResult.kellyFraction != null) {
    effectiveRiskPerTrade = sizingOptions.kellyResult.kellyFraction;
    kellyApplied = true;
  }

  const riskAmount = config.current_capital * effectiveRiskPerTrade;
  let quantity = riskAmount / riskPerUnit;
  let positionSizeUsd = quantity * entryPrice;

  // Volatility targeting: scale position size by inverse volatility ratio
  let volApplied = false;
  let volScale = 1.0;
  if (sizingOptions?.volResult?.applied) {
    volScale = sizingOptions.volResult.volScale;
    positionSizeUsd *= volScale;
    quantity = positionSizeUsd / entryPrice;
    volApplied = true;
  }

  // Cap at configurable % of capital (default 30%)
  const maxPositionPct = config.max_position_percent || DEFAULT_CONFIG.max_position_percent;
  const maxPosition = config.current_capital * maxPositionPct;
  if (positionSizeUsd > maxPosition) {
    positionSizeUsd = maxPosition;
    quantity = positionSizeUsd / entryPrice;
  }

  return {
    positionSizeUsd: Math.round(positionSizeUsd * 100) / 100,
    quantity: quantity,
    riskAmount: Math.round(riskAmount * 100) / 100,
    // Sizing metadata (only when sizing options provided)
    ...(sizingOptions ? {
      sizing: {
        kellyApplied,
        kellyFraction: sizingOptions.kellyResult?.kellyFraction || null,
        volApplied,
        volScale: volApplied ? Math.round(volScale * 10000) / 10000 : null,
        effectiveRiskPerTrade: Math.round(effectiveRiskPerTrade * 10000) / 10000
      }
    } : {})
  };
}

function checkPriceAgainstLevels(trade, currentPrice) {
  const direction = trade.direction;
  const isLong = direction === 'LONG';
  const result = {
    action: 'none',
    newTrailingStop: null,
    peakPrice: parseFloat(trade.peak_price) || (isLong ? parseFloat(trade.entry_price) : parseFloat(trade.entry_price))
  };

  const entryPrice = parseFloat(trade.entry_price);
  const stopLoss = parseFloat(trade.stop_loss);
  const tp1 = parseFloat(trade.take_profit_1);
  const tp2 = trade.take_profit_2 ? parseFloat(trade.take_profit_2) : null;
  const trailingCurrent = trade.trailing_stop_current ? parseFloat(trade.trailing_stop_current) : null;
  const trailingActivation = trade.trailing_activation ? parseFloat(trade.trailing_activation) : null;
  const trailingInitial = trade.trailing_stop_initial ? parseFloat(trade.trailing_stop_initial) : null;
  const trailingActive = trade.trailing_active;

  if (isLong) {
    // Save previous peak BEFORE updating — needed for trailing stop check
    const previousPeak = result.peakPrice;

    // Update peak price
    if (currentPrice > result.peakPrice) {
      result.peakPrice = currentPrice;
    }

    // Check stop loss
    if (currentPrice <= stopLoss) {
      result.action = 'stop_loss';
      return result;
    }

    // Check trailing stop (if active)
    if (trailingActive && trailingCurrent && currentPrice <= trailingCurrent) {
      result.action = 'trailing_stop';
      return result;
    }

    // Check take profit based on status
    if (trade.status === 'open' && currentPrice >= tp1) {
      result.action = 'take_profit_1';
      return result;
    }

    if (trade.status === 'partial' && tp2 && currentPrice >= tp2) {
      result.action = 'take_profit_2';
      return result;
    }

    // Activate trailing if not active and price passed activation level
    if (!trailingActive && trailingActivation && currentPrice >= trailingActivation) {
      result.action = 'activate_trailing';
      return result;
    }

    // Update trailing stop if active and price made new high
    // FIX: compare against previousPeak (before this tick's update)
    if (trailingActive && trailingInitial && currentPrice > previousPeak) {
      const trailingDistance = Math.abs(entryPrice - trailingInitial);
      result.newTrailingStop = currentPrice - trailingDistance;
    }

  } else {
    // SHORT - everything inverted
    // Save previous peak BEFORE updating
    const previousPeak = result.peakPrice;

    // Update peak (for short, peak is lowest price)
    if (currentPrice < result.peakPrice || result.peakPrice >= entryPrice) {
      result.peakPrice = Math.min(result.peakPrice, currentPrice);
    }

    // Check stop loss (price going UP)
    if (currentPrice >= stopLoss) {
      result.action = 'stop_loss';
      return result;
    }

    // Check trailing stop (price going UP)
    if (trailingActive && trailingCurrent && currentPrice >= trailingCurrent) {
      result.action = 'trailing_stop';
      return result;
    }

    // Check take profit (price going DOWN)
    if (trade.status === 'open' && currentPrice <= tp1) {
      result.action = 'take_profit_1';
      return result;
    }

    if (trade.status === 'partial' && tp2 && currentPrice <= tp2) {
      result.action = 'take_profit_2';
      return result;
    }

    // Activate trailing
    if (!trailingActive && trailingActivation && currentPrice <= trailingActivation) {
      result.action = 'activate_trailing';
      return result;
    }

    // Update trailing stop for short (price made new low)
    // FIX: compare against previousPeak (before this tick's update)
    if (trailingActive && trailingInitial && currentPrice < previousPeak) {
      const trailingDistance = Math.abs(trailingInitial - entryPrice);
      result.newTrailingStop = currentPrice + trailingDistance;
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAFETY CHECKS
// ═══════════════════════════════════════════════════════════════════════════════

async function checkSafetyLimits(supabase, userId, config) {
  try {
    // Reset daily P&L if new day (UTC-based for deterministic resets)
    const resetAt = new Date(config.daily_pnl_reset_at);
    const now = new Date();
    if (resetAt.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10)) {
      await supabase
        .from('paper_config')
        .update({ daily_pnl: 0, daily_pnl_reset_at: now.toISOString() })
        .eq('user_id', userId);
      config.daily_pnl = 0;
    }

    // Check max daily loss
    const maxDailyLoss = config.initial_capital * config.max_daily_loss_percent;
    if (config.daily_pnl <= -maxDailyLoss) {
      return { safe: false, reason: `Daily loss limit reached: $${Math.abs(config.daily_pnl).toFixed(2)} / $${maxDailyLoss.toFixed(2)}` };
    }

    // Check open positions count
    const { count } = await supabase
      .from('paper_trades')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .in('status', ['open', 'partial']);

    if (count >= config.max_open_positions) {
      return { safe: false, reason: `Max open positions reached: ${count}/${config.max_open_positions}` };
    }

    // Check cooldown
    if (config.last_trade_at) {
      const lastTrade = new Date(config.last_trade_at);
      const cooldownMs = config.cooldown_minutes * 60 * 1000;
      const elapsed = now.getTime() - lastTrade.getTime();
      if (elapsed < cooldownMs) {
        const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
        return { safe: false, reason: `Cooldown active: ${remaining} minutes remaining` };
      }
    }

    return { safe: true, reason: 'All safety checks passed' };
  } catch (err) {
    logger.error('checkSafetyLimits exception', { error: err.message });
    return { safe: false, reason: `Safety check error: ${err.message}` };
  }
}

async function checkDuplicateTrade(supabase, userId, asset) {
  try {
    const { count } = await supabase
      .from('paper_trades')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('asset', asset)
      .in('status', ['open', 'partial']);

    return count > 0;
  } catch (err) {
    logger.error('checkDuplicateTrade exception', { error: err.message });
    return true; // Err on the side of caution
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

async function openTrade(supabase, userId, signal, positionSize) {
  try {
    const direction = signal.action === 'BUY' ? 'LONG' : 'SHORT';

    // Count confluence
    let confluenceCount = 0;
    if (signal.timeframes) {
      const tfEntries = Object.entries(signal.timeframes)
        .filter(([k, v]) => typeof v === 'object' && v.trend);
      const bullish = tfEntries.filter(([, v]) => v.trend === 'bullish').length;
      const bearish = tfEntries.filter(([, v]) => v.trend === 'bearish').length;
      confluenceCount = Math.max(bullish, bearish);
    }

    // Apply slippage + commission to entry (simulates real execution)
    const isBuy = direction === 'LONG';
    const slippedEntry = applySlippage(signal.tradeLevels.entry, isBuy, signal.asset);

    const tradeData = {
      user_id: userId,
      asset: signal.asset,
      asset_class: signal.assetClass || 'crypto',
      direction,
      entry_price: Math.round(slippedEntry * 100) / 100,
      entry_signal_strength: signal.strengthLabel,
      entry_confidence: signal.confidence,
      entry_raw_score: signal.rawScore,
      entry_confluence: confluenceCount,
      entry_reasons: signal.reasons,
      entry_at: new Date().toISOString(),
      position_size_usd: positionSize.positionSizeUsd,
      quantity: positionSize.quantity,
      risk_amount: positionSize.riskAmount,
      stop_loss: signal.tradeLevels.stopLoss,
      take_profit_1: signal.tradeLevels.takeProfit1,
      take_profit_2: signal.tradeLevels.takeProfit2 || null,
      trailing_stop_initial: signal.tradeLevels.trailingStop || null,
      trailing_stop_current: signal.tradeLevels.trailingStop || null,
      trailing_activation: signal.tradeLevels.trailingActivation || null,
      trailing_active: false,
      remaining_quantity: positionSize.quantity,
      peak_price: signal.tradeLevels.entry,
      max_favorable: 0,
      max_adverse: 0,
      signal_snapshot: {
        score: signal.score,
        rawScore: signal.rawScore,
        confidence: signal.confidence,
        strengthLabel: signal.strengthLabel,
        macroContext: signal.macroContext || null,
        derivatives: signal.derivatives || null
      }
    };

    const { data: trade, error } = await supabase
      .from('paper_trades')
      .insert(tradeData)
      .select()
      .single();

    if (error) {
      logger.error('Failed to open paper trade', { error: error.message, asset: signal.asset });
      return { trade: null, error };
    }

    // Update last_trade_at
    await supabase
      .from('paper_config')
      .update({ last_trade_at: new Date().toISOString() })
      .eq('user_id', userId);

    logger.info('Paper trade opened', {
      asset: signal.asset,
      direction,
      entry: signal.tradeLevels.entry,
      size: positionSize.positionSizeUsd,
      strength: signal.strengthLabel
    });

    return { trade, error: null };
  } catch (err) {
    logger.error('openTrade exception', { error: err.message });
    return { trade: null, error: err };
  }
}

async function executePartialClose(supabase, trade, closePrice, partialRatio = 0.5) {
  try {
    const entryPrice = parseFloat(trade.entry_price);
    const totalQuantity = parseFloat(trade.quantity);
    const closeQuantity = totalQuantity * partialRatio;
    const remainingQuantity = totalQuantity - closeQuantity;

    let pnl;
    if (trade.direction === 'LONG') {
      pnl = (closePrice - entryPrice) * closeQuantity;
    } else {
      pnl = (entryPrice - closePrice) * closeQuantity;
    }
    pnl = Math.round(pnl * 100) / 100;

    const { data, error } = await supabase
      .from('paper_trades')
      .update({
        status: 'partial',
        partial_close_price: closePrice,
        partial_close_quantity: closeQuantity,
        partial_close_pnl: pnl,
        partial_close_at: new Date().toISOString(),
        remaining_quantity: remainingQuantity
      })
      .eq('id', trade.id)
      .select()
      .single();

    if (error) {
      logger.error('Failed partial close', { error: error.message, tradeId: trade.id });
      return { updatedTrade: null, pnl: 0, error };
    }

    // Update capital atomically (serialized to prevent race conditions)
    await updateCapitalAtomic(supabase, trade.user_id, pnl);

    logger.info('Paper trade partial close', {
      asset: trade.asset,
      closePrice,
      pnl,
      remaining: remainingQuantity
    });

    return { updatedTrade: data, pnl, error: null };
  } catch (err) {
    logger.error('executePartialClose exception', { error: err.message });
    return { updatedTrade: null, pnl: 0, error: err };
  }
}

async function executeFullClose(supabase, trade, closePrice, exitReason) {
  try {
    const entryPrice = parseFloat(trade.entry_price);
    const remainingQty = parseFloat(trade.remaining_quantity || trade.quantity);
    const partialPnl = parseFloat(trade.partial_close_pnl || 0);

    let finalPnl;
    if (trade.direction === 'LONG') {
      finalPnl = (closePrice - entryPrice) * remainingQty;
    } else {
      finalPnl = (entryPrice - closePrice) * remainingQty;
    }

    const totalPnl = Math.round((finalPnl + partialPnl) * 100) / 100;
    const totalInvested = parseFloat(trade.position_size_usd);
    const pnlPercent = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

    const { data, error } = await supabase
      .from('paper_trades')
      .update({
        status: 'closed',
        exit_price: closePrice,
        exit_reason: exitReason,
        exit_at: new Date().toISOString(),
        realized_pnl: totalPnl,
        realized_pnl_percent: Math.round(pnlPercent * 100) / 100
      })
      .eq('id', trade.id)
      .select()
      .single();

    if (error) {
      logger.error('Failed full close', { error: error.message, tradeId: trade.id });
      return { closedTrade: null, pnl: 0, error };
    }

    // Update capital atomically (serialized to prevent race conditions)
    // Only the remaining portion P&L (partial close already accounted for)
    await updateCapitalAtomic(supabase, trade.user_id, finalPnl);

    logger.info('Paper trade closed', {
      asset: trade.asset,
      exitReason,
      closePrice,
      totalPnl,
      pnlPercent: pnlPercent.toFixed(2) + '%'
    });

    return { closedTrade: data, pnl: totalPnl, error: null };
  } catch (err) {
    logger.error('executeFullClose exception', { error: err.message });
    return { closedTrade: null, pnl: 0, error: err };
  }
}

async function updateTrailingStop(supabase, tradeId, newTrailingStop, peakPrice) {
  try {
    await supabase
      .from('paper_trades')
      .update({
        trailing_stop_current: newTrailingStop,
        peak_price: peakPrice,
        trailing_active: true
      })
      .eq('id', tradeId);
  } catch (err) {
    logger.error('updateTrailingStop exception', { error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION MONITORING
// ═══════════════════════════════════════════════════════════════════════════════

async function monitorOpenPositions(supabase, userId, marketData, config = null) {
  const result = { checked: 0, closedTrades: [], partialCloses: [] };

  try {
    // Fetch config if not provided (needed for partial ratio, holding time, breakeven)
    if (!config) {
      const { config: fetchedConfig } = await getOrCreateConfig(supabase, userId);
      config = fetchedConfig || DEFAULT_CONFIG;
    }

    const { data: trades, error } = await supabase
      .from('paper_trades')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['open', 'partial']);

    if (error || !trades || trades.length === 0) {
      return result;
    }

    for (const trade of trades) {
      result.checked++;
      const currentPrice = resolveCurrentPrice(trade.asset, marketData);

      if (!currentPrice) {
        logger.debug('No price found for paper trade', { asset: trade.asset });
        continue;
      }

      // ── Check max holding time ──────────────────────────────────────
      const maxHoldingHours = config.max_holding_hours || DEFAULT_CONFIG.max_holding_hours;
      if (maxHoldingHours > 0 && trade.entry_at) {
        const holdingMs = Date.now() - new Date(trade.entry_at).getTime();
        if (holdingMs > maxHoldingHours * 3600 * 1000) {
          const isExitBuy = trade.direction === 'SHORT';
          const slippedClosePrice = applySlippage(currentPrice, isExitBuy, trade.asset);
          const closeResult = await executeFullClose(supabase, trade, slippedClosePrice, 'time_expiry');
          if (closeResult.closedTrade) {
            result.closedTrades.push(closeResult.closedTrade);
            logger.info('Trade closed by time expiry', {
              asset: trade.asset, holdingHours: Math.round(holdingMs / 3600000)
            });
          }
          continue; // Skip further checks for this trade
        }
      }

      // Update max favorable / adverse
      const entryPrice = parseFloat(trade.entry_price);
      const qty = parseFloat(trade.remaining_quantity || trade.quantity);
      let unrealizedPnl;
      if (trade.direction === 'LONG') {
        unrealizedPnl = (currentPrice - entryPrice) * qty;
      } else {
        unrealizedPnl = (entryPrice - currentPrice) * qty;
      }

      const currentFavorable = Math.max(0, unrealizedPnl);
      const currentAdverse = Math.min(0, unrealizedPnl);
      const maxFavorable = Math.max(parseFloat(trade.max_favorable || 0), currentFavorable);
      const maxAdverse = Math.min(parseFloat(trade.max_adverse || 0), currentAdverse);

      // Check price against levels
      const check = checkPriceAgainstLevels(trade, currentPrice);

      // Apply slippage + commission on exit (LONG closes are sells, SHORT closes are buys)
      const isExitBuy = trade.direction === 'SHORT'; // SHORT exit = buy back
      const slippedClosePrice = applySlippage(currentPrice, isExitBuy, trade.asset);

      switch (check.action) {
        case 'stop_loss': {
          const closeResult = await executeFullClose(supabase, trade, slippedClosePrice, 'stop_loss');
          if (closeResult.closedTrade) {
            result.closedTrades.push(closeResult.closedTrade);
          }
          break;
        }

        case 'take_profit_1': {
          const partialRatio = config.partial_close_ratio || DEFAULT_CONFIG.partial_close_ratio;
          const partialResult = await executePartialClose(supabase, trade, slippedClosePrice, partialRatio);
          if (partialResult.updatedTrade) {
            result.partialCloses.push(partialResult.updatedTrade);

            // Move stop-loss to break-even after TP1 (professional trade management)
            if (config.move_sl_to_breakeven_after_tp1 !== false) {
              const breakEvenPrice = entryPrice;
              await supabase
                .from('paper_trades')
                .update({ stop_loss: breakEvenPrice })
                .eq('id', trade.id);
              logger.info('Stop-loss moved to break-even after TP1', {
                asset: trade.asset, breakEvenPrice
              });
            }
          }
          break;
        }

        case 'take_profit_2': {
          const closeResult = await executeFullClose(supabase, trade, slippedClosePrice, 'take_profit_2');
          if (closeResult.closedTrade) {
            result.closedTrades.push(closeResult.closedTrade);
          }
          break;
        }

        case 'trailing_stop': {
          const closeResult = await executeFullClose(supabase, trade, slippedClosePrice, 'trailing_stop');
          if (closeResult.closedTrade) {
            result.closedTrades.push(closeResult.closedTrade);
          }
          break;
        }

        case 'activate_trailing': {
          await updateTrailingStop(supabase, trade.id,
            parseFloat(trade.trailing_stop_current || trade.trailing_stop_initial),
            check.peakPrice
          );
          logger.info('Trailing stop activated', { asset: trade.asset, price: currentPrice });
          break;
        }

        default: {
          // Update peak price and trailing if needed
          const updates = { max_favorable: maxFavorable, max_adverse: maxAdverse };
          if (check.peakPrice) updates.peak_price = check.peakPrice;
          if (check.newTrailingStop) {
            updates.trailing_stop_current = check.newTrailingStop;
            logger.debug('Trailing stop updated', {
              asset: trade.asset,
              newStop: check.newTrailingStop,
              peak: check.peakPrice
            });
          }
          await supabase
            .from('paper_trades')
            .update(updates)
            .eq('id', trade.id);
          break;
        }
      }
    }

    return result;
  } catch (err) {
    logger.error('monitorOpenPositions exception', { error: err.message });
    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════════

async function getPerformanceMetrics(supabase, userId) {
  try {
    const { data: trades, error } = await supabase
      .from('paper_trades')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'closed')
      .order('exit_at', { ascending: true });

    if (error) {
      return { metrics: null, error };
    }

    if (!trades || trades.length === 0) {
      return {
        metrics: {
          totalTrades: 0, winCount: 0, lossCount: 0, winRate: 0,
          totalPnl: 0, avgProfit: 0, avgLoss: 0,
          bestTrade: null, worstTrade: null,
          maxDrawdown: 0, profitFactor: 0,
          avgHoldingTimeHours: 0, currentStreak: 0, streakType: 'none'
        },
        error: null
      };
    }

    const wins = trades.filter(t => parseFloat(t.realized_pnl) > 0);
    const losses = trades.filter(t => parseFloat(t.realized_pnl) <= 0);
    const totalPnl = trades.reduce((sum, t) => sum + parseFloat(t.realized_pnl || 0), 0);
    const grossProfit = wins.reduce((sum, t) => sum + parseFloat(t.realized_pnl), 0);
    const grossLoss = Math.abs(losses.reduce((sum, t) => sum + parseFloat(t.realized_pnl || 0), 0));

    // Max drawdown (from equity curve)
    let peak = 0;
    let maxDrawdown = 0;
    let runningPnl = 0;
    for (const trade of trades) {
      runningPnl += parseFloat(trade.realized_pnl || 0);
      if (runningPnl > peak) peak = runningPnl;
      const drawdown = peak - runningPnl;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    // Average holding time
    let totalHoldingMs = 0;
    let holdingCount = 0;
    for (const trade of trades) {
      if (trade.entry_at && trade.exit_at) {
        totalHoldingMs += new Date(trade.exit_at).getTime() - new Date(trade.entry_at).getTime();
        holdingCount++;
      }
    }

    // Current streak
    let streak = 0;
    let streakType = 'none';
    for (let i = trades.length - 1; i >= 0; i--) {
      const pnl = parseFloat(trades[i].realized_pnl || 0);
      const isWin = pnl > 0;
      if (streak === 0) {
        streakType = isWin ? 'win' : 'loss';
        streak = 1;
      } else if ((isWin && streakType === 'win') || (!isWin && streakType === 'loss')) {
        streak++;
      } else {
        break;
      }
    }

    // Best and worst trades
    const sorted = [...trades].sort((a, b) => parseFloat(b.realized_pnl) - parseFloat(a.realized_pnl));
    const bestTrade = sorted[0] ? {
      asset: sorted[0].asset,
      pnl: parseFloat(sorted[0].realized_pnl),
      pnlPercent: parseFloat(sorted[0].realized_pnl_percent),
      direction: sorted[0].direction
    } : null;
    const worstTrade = sorted[sorted.length - 1] ? {
      asset: sorted[sorted.length - 1].asset,
      pnl: parseFloat(sorted[sorted.length - 1].realized_pnl),
      pnlPercent: parseFloat(sorted[sorted.length - 1].realized_pnl_percent),
      direction: sorted[sorted.length - 1].direction
    } : null;

    return {
      metrics: {
        totalTrades: trades.length,
        winCount: wins.length,
        lossCount: losses.length,
        winRate: trades.length > 0 ? Math.round((wins.length / trades.length) * 100) : 0,
        totalPnl: Math.round(totalPnl * 100) / 100,
        avgProfit: wins.length > 0 ? Math.round((grossProfit / wins.length) * 100) / 100 : 0,
        avgLoss: losses.length > 0 ? Math.round((grossLoss / losses.length) * 100) / 100 : 0,
        bestTrade,
        worstTrade,
        maxDrawdown: Math.round(maxDrawdown * 100) / 100,
        profitFactor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : grossProfit > 0 ? Infinity : 0,
        avgHoldingTimeHours: holdingCount > 0 ? Math.round((totalHoldingMs / holdingCount / 3600000) * 10) / 10 : 0,
        currentStreak: streak,
        streakType
      },
      error: null
    };
  } catch (err) {
    logger.error('getPerformanceMetrics exception', { error: err.message });
    return { metrics: null, error: err };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADVANCED PERFORMANCE ANALYTICS
// Breakdowns by asset, hour, day of week, exit reason, direction, P&L distribution
// ═══════════════════════════════════════════════════════════════════════════════

async function getAdvancedPerformance(supabase, userId, days = 90) {
  try {
    let query = supabase
      .from('paper_trades')
      .select('asset, direction, entry_at, exit_at, realized_pnl, realized_pnl_percent, exit_reason, entry_signal_strength')
      .eq('user_id', userId)
      .eq('status', 'closed')
      .order('exit_at', { ascending: false });

    if (days > 0) {
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      query = query.gte('exit_at', since);
    }

    const { data, error } = await query;
    if (error) {
      if (error.code === '42P01') return { data: null, error: null };
      return { data: null, error };
    }
    if (!data || data.length < 1) {
      return { data: { total: 0 }, error: null };
    }

    // --- Single-pass aggregation ---
    const assetMap = {};
    const hourMap = {};      // 0-23
    const dowMap = {};       // 0-6 (Sun=0)
    const reasonMap = {};
    const dirMap = { LONG: { trades: 0, wins: 0, totalPnl: 0 }, SHORT: { trades: 0, wins: 0, totalPnl: 0 } };
    const monthMap = {};
    const pnlBuckets = {};   // keyed by bucket label

    const DOW_LABELS = ['Dom', 'Lun', 'Mar', 'Mie', 'Jue', 'Vie', 'Sab'];

    for (const t of data) {
      const pnl = parseFloat(t.realized_pnl || 0);
      const pnlPct = parseFloat(t.realized_pnl_percent || 0);
      const isWin = pnl > 0;
      const entryDate = new Date(t.entry_at);
      const exitDate = t.exit_at ? new Date(t.exit_at) : null;
      const holdMs = exitDate ? (exitDate - entryDate) : 0;
      const holdHours = holdMs / 3600000;

      // By Asset
      const asset = t.asset || 'Unknown';
      if (!assetMap[asset]) assetMap[asset] = { asset, trades: 0, wins: 0, losses: 0, totalPnl: 0, sumHoldHours: 0 };
      assetMap[asset].trades++;
      if (isWin) assetMap[asset].wins++; else assetMap[asset].losses++;
      assetMap[asset].totalPnl += pnl;
      assetMap[asset].sumHoldHours += holdHours;

      // By Hour (entry hour UTC)
      const hour = entryDate.getUTCHours();
      if (!hourMap[hour]) hourMap[hour] = { hour, trades: 0, wins: 0, totalPnl: 0 };
      hourMap[hour].trades++;
      if (isWin) hourMap[hour].wins++;
      hourMap[hour].totalPnl += pnl;

      // By Day of Week (entry)
      const dow = entryDate.getUTCDay();
      if (!dowMap[dow]) dowMap[dow] = { day: dow, label: DOW_LABELS[dow], trades: 0, wins: 0, totalPnl: 0 };
      dowMap[dow].trades++;
      if (isWin) dowMap[dow].wins++;
      dowMap[dow].totalPnl += pnl;

      // By Exit Reason
      const reason = t.exit_reason || 'unknown';
      if (!reasonMap[reason]) reasonMap[reason] = { reason, count: 0, wins: 0, sumPnl: 0, sumPnlPct: 0 };
      reasonMap[reason].count++;
      if (isWin) reasonMap[reason].wins++;
      reasonMap[reason].sumPnl += pnl;
      reasonMap[reason].sumPnlPct += pnlPct;

      // By Direction
      const dir = t.direction || 'LONG';
      if (dirMap[dir]) {
        dirMap[dir].trades++;
        if (isWin) dirMap[dir].wins++;
        dirMap[dir].totalPnl += pnl;
      }

      // By Month
      const month = (t.exit_at || t.entry_at).substring(0, 7);
      if (!monthMap[month]) monthMap[month] = { month, trades: 0, wins: 0, totalPnl: 0 };
      monthMap[month].trades++;
      if (isWin) monthMap[month].wins++;
      monthMap[month].totalPnl += pnl;

      // P&L Distribution (1% buckets from <-10% to >+10%)
      let bucketIdx;
      if (pnlPct <= -10) bucketIdx = -11;
      else if (pnlPct >= 10) bucketIdx = 10;
      else bucketIdx = Math.floor(pnlPct);
      const bucketLabel = bucketIdx <= -11 ? '<-10%' : bucketIdx >= 10 ? '>+10%' : `${bucketIdx}% to ${bucketIdx + 1}%`;
      if (!pnlBuckets[bucketIdx]) pnlBuckets[bucketIdx] = { bucket: bucketLabel, idx: bucketIdx, count: 0 };
      pnlBuckets[bucketIdx].count++;
    }

    // Format outputs
    const round2 = v => Math.round(v * 100) / 100;
    const wr = (wins, total) => total > 0 ? Math.round((wins / total) * 10000) / 100 : 0;

    const byAsset = Object.values(assetMap)
      .map(a => ({ ...a, winRate: wr(a.wins, a.trades), totalPnl: round2(a.totalPnl), avgPnl: round2(a.totalPnl / a.trades), avgHoldHours: round2(a.sumHoldHours / a.trades) }))
      .sort((a, b) => b.totalPnl - a.totalPnl);

    // Fill all 24 hours
    const byHour = Array.from({ length: 24 }, (_, h) => {
      const d = hourMap[h] || { hour: h, trades: 0, wins: 0, totalPnl: 0 };
      return { ...d, winRate: wr(d.wins, d.trades), totalPnl: round2(d.totalPnl) };
    });

    // Fill all 7 days
    const byDayOfWeek = Array.from({ length: 7 }, (_, i) => {
      const d = dowMap[i] || { day: i, label: DOW_LABELS[i], trades: 0, wins: 0, totalPnl: 0 };
      return { ...d, winRate: wr(d.wins, d.trades), totalPnl: round2(d.totalPnl) };
    });

    const byExitReason = Object.values(reasonMap)
      .map(r => ({ reason: r.reason, count: r.count, winRate: wr(r.wins, r.count), avgPnl: round2(r.sumPnl / r.count), avgPnlPct: round2(r.sumPnlPct / r.count) }))
      .sort((a, b) => b.count - a.count);

    const byDirection = {};
    for (const [dir, d] of Object.entries(dirMap)) {
      byDirection[dir] = { trades: d.trades, wins: d.wins, winRate: wr(d.wins, d.trades), totalPnl: round2(d.totalPnl) };
    }

    const pnlDistribution = Object.values(pnlBuckets).sort((a, b) => a.idx - b.idx).map(({ bucket, count }) => ({ bucket, count }));

    const tradesByMonth = Object.values(monthMap)
      .map(m => ({ ...m, winRate: wr(m.wins, m.trades), totalPnl: round2(m.totalPnl) }))
      .sort((a, b) => a.month.localeCompare(b.month));

    return {
      data: {
        total: data.length,
        byAsset,
        byHour,
        byDayOfWeek,
        byExitReason,
        byDirection,
        pnlDistribution,
        tradesByMonth
      },
      error: null
    };
  } catch (err) {
    logger.error('getAdvancedPerformance exception', { error: err.message });
    return { data: null, error: err };
  }
}

async function getTradeHistory(supabase, userId, options = {}) {
  try {
    const { status, asset, limit = 50, offset = 0 } = options;

    let query = supabase
      .from('paper_trades')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq('status', status);
    if (asset) query = query.eq('asset', asset);

    const { data, count, error } = await query;

    if (error) {
      return { trades: [], total: 0, error };
    }

    return { trades: data || [], total: count || 0, error: null };
  } catch (err) {
    logger.error('getTradeHistory exception', { error: err.message });
    return { trades: [], total: 0, error: err };
  }
}

async function getOpenPositions(supabase, userId, marketData = null) {
  try {
    const { data: trades, error } = await supabase
      .from('paper_trades')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['open', 'partial'])
      .order('entry_at', { ascending: false });

    if (error) {
      return { positions: [], error };
    }

    // Calculate unrealized P&L if market data provided
    const positions = (trades || []).map(trade => {
      const currentPrice = marketData ? resolveCurrentPrice(trade.asset, marketData) : null;
      const entryPrice = parseFloat(trade.entry_price);
      const qty = parseFloat(trade.remaining_quantity || trade.quantity);

      let unrealizedPnl = 0;
      let unrealizedPnlPercent = 0;

      if (currentPrice) {
        if (trade.direction === 'LONG') {
          unrealizedPnl = (currentPrice - entryPrice) * qty;
        } else {
          unrealizedPnl = (entryPrice - currentPrice) * qty;
        }
        const invested = parseFloat(trade.position_size_usd);
        unrealizedPnlPercent = invested > 0 ? (unrealizedPnl / invested) * 100 : 0;
      }

      return {
        ...trade,
        currentPrice: currentPrice || null,
        unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
        unrealizedPnlPercent: Math.round(unrealizedPnlPercent * 100) / 100
      };
    });

    return { positions, error: null };
  } catch (err) {
    logger.error('getOpenPositions exception', { error: err.message });
    return { positions: [], error: err };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REAL-TIME EQUITY CURVE
// Records periodic snapshots of capital + unrealized PnL
// ═══════════════════════════════════════════════════════════════════════════════

// Throttle: record at most once every 5 minutes per user
const lastSnapshotTime = new Map();
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;

async function recordEquitySnapshot(supabase, userId, config, marketData) {
  try {
    const now = Date.now();
    const lastTime = lastSnapshotTime.get(userId) || 0;
    if (now - lastTime < SNAPSHOT_INTERVAL_MS) return;

    const capital = parseFloat(config.current_capital || 0);

    // Calculate total unrealized PnL from open positions
    const { positions } = await getOpenPositions(supabase, userId, marketData);
    const unrealized = positions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
    const equity = Math.round((capital + unrealized) * 100) / 100;

    await supabase
      .from('paper_equity_snapshots')
      .insert({
        user_id: userId,
        capital: Math.round(capital * 100) / 100,
        unrealized: Math.round(unrealized * 100) / 100,
        equity,
        open_count: positions.length
      });

    lastSnapshotTime.set(userId, now);
    logger.debug('Equity snapshot recorded', { userId, equity, openPositions: positions.length });
  } catch (err) {
    // Non-critical — don't break the monitoring cycle
    logger.debug('Equity snapshot failed', { error: err.message });
  }
}

async function getEquityCurve(supabase, userId, days = 7) {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('paper_equity_snapshots')
      .select('timestamp, capital, unrealized, equity, open_count')
      .eq('user_id', userId)
      .gte('timestamp', since)
      .order('timestamp', { ascending: true });

    if (error) {
      logger.error('getEquityCurve error', { error: error.message });
      return { curve: [], error };
    }

    // Downsample if too many points (keep ~500 max for chart performance)
    const MAX_POINTS = 500;
    let curve = data || [];
    if (curve.length > MAX_POINTS) {
      const step = Math.ceil(curve.length / MAX_POINTS);
      curve = curve.filter((_, i) => i % step === 0 || i === curve.length - 1);
    }

    return { curve, error: null };
  } catch (err) {
    logger.error('getEquityCurve exception', { error: err.message });
    return { curve: [], error: err };
  }
}

async function cleanupOldSnapshots(supabase, userId, keepDays = 7) {
  try {
    const cutoff = new Date(Date.now() - keepDays * 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from('paper_equity_snapshots')
      .delete()
      .eq('user_id', userId)
      .lt('timestamp', cutoff);
  } catch (err) {
    logger.debug('Snapshot cleanup failed', { error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION CORRELATION ANALYSIS
// Pearson correlation between open position price returns
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate log returns from OHLCV candles
 * @param {Array} candles - [{close, ...}]
 * @returns {number[]} log returns
 */
function calculateLogReturns(candles) {
  if (!candles || candles.length < 2) return [];
  const returns = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const curr = candles[i].close;
    if (prev > 0 && curr > 0) {
      returns.push(Math.log(curr / prev));
    }
  }
  return returns;
}

/**
 * Calculate Pearson correlation coefficient between two arrays
 * @param {number[]} arrA
 * @param {number[]} arrB
 * @returns {number} correlation [-1, 1], or 0 if insufficient data
 */
function calculatePearsonCorrelation(arrA, arrB) {
  if (!arrA || !arrB || arrA.length < 5 || arrB.length < 5) return 0;
  const n = Math.min(arrA.length, arrB.length);
  const a = arrA.slice(0, n);
  const b = arrB.slice(0, n);

  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;

  let sumAB = 0, sumA2 = 0, sumB2 = 0;
  for (let i = 0; i < n; i++) {
    const dA = a[i] - meanA;
    const dB = b[i] - meanB;
    sumAB += dA * dB;
    sumA2 += dA * dA;
    sumB2 += dB * dB;
  }

  const denom = Math.sqrt(sumA2 * sumB2);
  if (denom === 0) return 0;
  return Math.max(-1, Math.min(1, sumAB / denom));
}

/**
 * Analyze correlations between open positions using historical price returns
 * @param {Function} fetchCandles - (coinId, interval, limit) → candles[] (injectable for testing)
 * @param {Array} positions - open positions with .asset field
 * @returns {Object} correlation analysis
 */
async function getPositionCorrelations(fetchCandles, positions) {
  const empty = {
    pairs: [],
    riskLevel: 'none',
    avgCorrelation: 0,
    maxCorrelation: 0,
    effectiveDiversification: 1,
    warnings: [],
    assetCount: positions ? positions.length : 0
  };

  if (!positions || positions.length <= 1) return empty;

  // Get unique assets
  const uniqueAssets = [...new Set(positions.map(p => p.asset))];
  if (uniqueAssets.length <= 1) {
    // All positions in same asset → perfect correlation
    return {
      pairs: [{ assetA: uniqueAssets[0], assetB: uniqueAssets[0], correlation: 1.0, level: 'high' }],
      riskLevel: 'high',
      avgCorrelation: 1.0,
      maxCorrelation: 1.0,
      effectiveDiversification: 0,
      warnings: [`All ${positions.length} positions are in ${uniqueAssets[0]} — no diversification`],
      assetCount: positions.length
    };
  }

  // Fetch 7 days of 1h candles for each unique asset
  const candleMap = {};
  for (const asset of uniqueAssets) {
    try {
      const candles = await fetchCandles(asset, '1h', 168);
      if (candles && candles.length >= 10) {
        candleMap[asset] = candles;
      }
    } catch (err) {
      // Skip asset if fetch fails
      logger.warn('Correlation: failed to fetch candles', { asset, error: err.message });
    }
  }

  // Need at least 2 assets with data
  const assetsWithData = Object.keys(candleMap);
  if (assetsWithData.length < 2) return empty;

  // Calculate log returns for each asset
  const returnsMap = {};
  for (const asset of assetsWithData) {
    returnsMap[asset] = calculateLogReturns(candleMap[asset]);
  }

  // Calculate pairwise correlations
  const pairs = [];
  for (let i = 0; i < assetsWithData.length; i++) {
    for (let j = i + 1; j < assetsWithData.length; j++) {
      const assetA = assetsWithData[i];
      const assetB = assetsWithData[j];
      const corr = calculatePearsonCorrelation(returnsMap[assetA], returnsMap[assetB]);
      const absCorr = Math.abs(corr);

      let level = 'low';
      if (absCorr >= 0.75) level = 'high';
      else if (absCorr >= 0.5) level = 'medium';

      pairs.push({
        assetA,
        assetB,
        correlation: +corr.toFixed(4),
        level
      });
    }
  }

  // Aggregate metrics
  const absCorrelations = pairs.map(p => Math.abs(p.correlation));
  const avgCorrelation = absCorrelations.length > 0
    ? +(absCorrelations.reduce((s, v) => s + v, 0) / absCorrelations.length).toFixed(4)
    : 0;
  const maxCorrelation = absCorrelations.length > 0
    ? +Math.max(...absCorrelations).toFixed(4)
    : 0;

  let riskLevel = 'low';
  if (avgCorrelation >= 0.75) riskLevel = 'high';
  else if (avgCorrelation >= 0.5) riskLevel = 'medium';

  const effectiveDiversification = +(1 - avgCorrelation).toFixed(4);

  // Generate warnings
  const warnings = [];
  for (const pair of pairs) {
    if (Math.abs(pair.correlation) >= 0.7) {
      warnings.push(
        `${pair.assetA} ↔ ${pair.assetB}: correlation ${pair.correlation} — ${pair.correlation > 0 ? 'move together' : 'move opposite'}`
      );
    }
  }

  return {
    pairs,
    riskLevel,
    avgCorrelation,
    maxCorrelation,
    effectiveDiversification,
    warnings,
    assetCount: positions.length
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORCHESTRATION (called from server.js)
// ═══════════════════════════════════════════════════════════════════════════════

async function evaluateAndExecute(supabase, userId, signals, marketData) {
  const result = { newTrades: [], skipped: [] };

  try {
    const { config, error: configError } = await getOrCreateConfig(supabase, userId);
    if (configError || !config) {
      logger.warn('Paper trading: could not get config', { error: configError?.message });
      return result;
    }

    if (!config.is_enabled) {
      return result;
    }

    // Check safety limits once (shared across all signals)
    const { safe, reason: safetyReason } = await checkSafetyLimits(supabase, userId, config);
    if (!safe) {
      logger.debug('Paper trading: safety limit', { reason: safetyReason });
      return result;
    }

    for (const signal of signals) {
      // Skip non-crypto assets (metals are reference-only, not tradeable)
      if (signal.assetClass === 'metal' ||
          (signal.asset && (signal.asset.includes('GOLD') || signal.asset.includes('SILVER') ||
           signal.asset.includes('XAU') || signal.asset.includes('XAG')))) {
        result.skipped.push({ asset: signal.asset, reason: 'Non-crypto asset (reference only)' });
        continue;
      }

      // Evaluate signal eligibility
      const { eligible, reason } = evaluateSignalForTrade(signal, config);
      if (!eligible) {
        result.skipped.push({ asset: signal.asset, reason });
        continue;
      }

      // Check for duplicate asset
      const isDuplicate = await checkDuplicateTrade(supabase, userId, signal.asset);
      if (isDuplicate) {
        result.skipped.push({ asset: signal.asset, reason: 'Already has open trade' });
        continue;
      }

      // Re-check safety (position count may have changed)
      const { safe: stillSafe, reason: newSafetyReason } = await checkSafetyLimits(supabase, userId, config);
      if (!stillSafe) {
        result.skipped.push({ asset: signal.asset, reason: newSafetyReason });
        break; // No point checking more signals
      }

      // ─── PORTFOLIO CORRELATION & EXPOSURE LIMITS ─────────────────────────
      try {
        const { data: openPositions } = await supabase.from('paper_trades')
          .select('asset, direction, position_size_usd, entry_price')
          .eq('user_id', userId).in('status', ['open', 'partial']);

        if (openPositions && openPositions.length >= 1) {
          const newAsset = signal.asset.toLowerCase();
          const sigDir = signal.action === 'BUY' ? 'long' : 'short';
          const maxCorr = config.max_portfolio_correlation || DEFAULT_CONFIG.max_portfolio_correlation;
          const maxSectorPct = config.max_sector_exposure_pct || DEFAULT_CONFIG.max_sector_exposure_pct;
          const maxSameDirCrypto = config.max_same_direction_crypto || DEFAULT_CONFIG.max_same_direction_crypto;

          const CRYPTO_ASSETS = ['bitcoin', 'ethereum', 'solana', 'cardano', 'ripple', 'polkadot',
            'avalanche-2', 'dogecoin', 'binancecoin', 'chainlink', 'matic-network', 'tron',
            'shiba-inu', 'litecoin', 'uniswap', 'near', 'aptos', 'arbitrum', 'optimism', 'sui'];
          const METAL_ASSETS = ['gold', 'silver', 'xau', 'xag', 'pax-gold', 'platinum'];

          const classifyAsset = (a) => {
            const lower = a.toLowerCase();
            if (METAL_ASSETS.some(m => lower.includes(m))) return 'metal';
            if (CRYPTO_ASSETS.some(c => lower.includes(c))) return 'crypto';
            return 'other';
          };

          const newAssetClass = classifyAsset(newAsset);

          // ── CHECK 1: Same-direction crypto limit ──
          const sameDirCrypto = openPositions.filter(p =>
            p.direction === sigDir && classifyAsset(p.asset) === 'crypto'
          );
          if (newAssetClass === 'crypto' && sameDirCrypto.length >= maxSameDirCrypto) {
            result.skipped.push({
              asset: signal.asset,
              reason: `Same-direction limit: ${sameDirCrypto.length}/${maxSameDirCrypto} ${sigDir.toUpperCase()} crypto positions open`
            });
            continue;
          }

          // ── CHECK 2: Sector exposure % ──
          const totalExposure = openPositions.reduce((s, p) => s + parseFloat(p.position_size_usd || 0), 0);
          const sectorExposure = openPositions
            .filter(p => classifyAsset(p.asset) === newAssetClass)
            .reduce((s, p) => s + parseFloat(p.position_size_usd || 0), 0);
          const capital = config.current_capital || DEFAULT_CONFIG.current_capital;
          const sectorPct = (sectorExposure + (capital * (config.risk_per_trade || 0.01) * 10)) / capital;

          if (sectorPct > maxSectorPct) {
            result.skipped.push({
              asset: signal.asset,
              reason: `Sector exposure: ${newAssetClass} at ${(sectorExposure / capital * 100).toFixed(0)}% of capital (limit ${(maxSectorPct * 100).toFixed(0)}%)`
            });
            continue;
          }

          // ── CHECK 3: Portfolio correlation (use precomputed or known correlations) ──
          // Use empirical crypto correlation matrix (faster than live calculation)
          const KNOWN_CORRELATIONS = {
            'bitcoin-ethereum': 0.87, 'bitcoin-solana': 0.82, 'bitcoin-cardano': 0.78,
            'bitcoin-ripple': 0.72, 'bitcoin-polkadot': 0.80, 'bitcoin-avalanche-2': 0.83,
            'bitcoin-dogecoin': 0.68, 'bitcoin-binancecoin': 0.85, 'bitcoin-chainlink': 0.79,
            'ethereum-solana': 0.84, 'ethereum-cardano': 0.80, 'ethereum-ripple': 0.70,
            'ethereum-avalanche-2': 0.86, 'ethereum-binancecoin': 0.82, 'ethereum-chainlink': 0.83,
            'solana-avalanche-2': 0.80, 'solana-cardano': 0.76, 'cardano-ripple': 0.74,
          };

          const getCorrelation = (a, b) => {
            const key1 = `${a}-${b}`;
            const key2 = `${b}-${a}`;
            if (KNOWN_CORRELATIONS[key1] !== undefined) return KNOWN_CORRELATIONS[key1];
            if (KNOWN_CORRELATIONS[key2] !== undefined) return KNOWN_CORRELATIONS[key2];
            // Same sector default: crypto-crypto 0.65, metal-metal 0.70, cross-sector 0.15
            const classA = classifyAsset(a);
            const classB = classifyAsset(b);
            if (classA === classB && classA === 'crypto') return 0.65;
            if (classA === classB && classA === 'metal') return 0.70;
            return 0.15; // cross-sector = low correlation
          };

          // Weighted average correlation of new asset vs all open same-direction positions
          const sameDirPositions = openPositions.filter(p => p.direction === sigDir);
          if (sameDirPositions.length >= 2) {
            let corrWeightSum = 0;
            let weightSum = 0;
            for (const pos of sameDirPositions) {
              const posSize = parseFloat(pos.position_size_usd || 0);
              const corr = getCorrelation(newAsset, pos.asset.toLowerCase());
              corrWeightSum += corr * posSize;
              weightSum += posSize;
            }
            const weightedCorr = weightSum > 0 ? corrWeightSum / weightSum : 0;

            if (weightedCorr > maxCorr) {
              result.skipped.push({
                asset: signal.asset,
                reason: `Portfolio correlation ${(weightedCorr * 100).toFixed(0)}% exceeds limit ${(maxCorr * 100).toFixed(0)}% (${sameDirPositions.length} same-dir positions)`
              });
              continue;
            }
          }
        }
      } catch (corrErr) {
        logger.debug('Portfolio correlation check failed, proceeding', { error: corrErr.message });
      }

      // Calculate position size with Kelly Criterion + Volatility Targeting
      let sizingOptions = null;
      try {
        // Fetch completed trades for Kelly stats (cached per evaluation cycle)
        if (!result._completedTrades) {
          const { data: closedTrades } = await supabase.from('paper_trades')
            .select('pnl_usd').eq('user_id', userId).eq('status', 'closed')
            .order('exit_at', { ascending: false }).limit(100);
          result._completedTrades = (closedTrades || []).map(t => ({ pnl: parseFloat(t.pnl_usd) || 0 }));
        }

        // Extract ATR% from signal indicators (if available)
        const atrPercent = signal.indicators?.atrPercent
          || signal.tradeLevels?.atrPercent
          || (signal.tradeLevels?.atrValue && signal.tradeLevels.entry
            ? (signal.tradeLevels.atrValue / signal.tradeLevels.entry) * 100
            : null);

        // Determine market regime for dynamic Kelly adjustment
        const regime = marketData?._regime || 'normal';
        const regimeKellyFraction = { volatile: 0.25, trending_up: 0.5, trending_down: 0.35, ranging: 0.4, normal: 0.5 };

        const kellyConfig = {
          kelly: {
            enabled: true,
            fraction: regimeKellyFraction[regime] || 0.5,  // Half-Kelly default, conservative in volatile
            minTrades: 15,
            lookbackTrades: 100,
            minRiskPerTrade: 0.005,
            maxRiskPerTrade: 0.04   // 4% cap (conservative for crypto)
          },
          volatilityTargeting: {
            enabled: !!atrPercent,
            targetATRPercent: 2.0,
            minScale: 0.3,
            maxScale: 1.5
          }
        };

        sizingOptions = buildSizingOptions(result._completedTrades, atrPercent, kellyConfig);

        if (sizingOptions.kellyResult?.applied) {
          logger.debug('Kelly sizing applied', {
            asset: signal.asset,
            kelly: sizingOptions.kellyResult.kellyFraction,
            regime,
            volScale: sizingOptions.volResult?.volScale || 1.0
          });
        }
      } catch (sizingErr) {
        logger.debug('Kelly sizing failed, using fixed risk', { error: sizingErr.message });
      }

      const positionSize = calculatePositionSize(config, signal, sizingOptions);
      if (positionSize.positionSizeUsd <= 0) {
        result.skipped.push({ asset: signal.asset, reason: 'Position size too small' });
        continue;
      }

      // Open the trade
      const { trade, error: tradeError } = await openTrade(supabase, userId, signal, positionSize);
      if (trade) {
        result.newTrades.push(trade);
        // Refresh config for next iteration (capital changed)
        const { config: refreshed } = await getOrCreateConfig(supabase, userId);
        if (refreshed) Object.assign(config, refreshed);
      } else {
        result.skipped.push({ asset: signal.asset, reason: `Open failed: ${tradeError?.message}` });
      }
    }

    return result;
  } catch (err) {
    logger.error('evaluateAndExecute exception', { error: err.message });
    return result;
  }
}

async function monitorAndManage(supabase, userId, marketData) {
  try {
    const { config } = await getOrCreateConfig(supabase, userId);
    if (!config || !config.is_enabled) {
      return { checked: 0, closedTrades: [], partialCloses: [] };
    }

    // Reset daily P&L if new day (same logic as checkSafetyLimits)
    const resetAt = new Date(config.daily_pnl_reset_at);
    const now = new Date();
    if (resetAt.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10)) {
      await supabase
        .from('paper_config')
        .update({ daily_pnl: 0, daily_pnl_reset_at: now.toISOString() })
        .eq('user_id', userId);
      config.daily_pnl = 0;
    }

    // Check max daily loss - emergency close all if breached
    const maxDailyLoss = config.initial_capital * config.max_daily_loss_percent;
    if (parseFloat(config.daily_pnl) <= -maxDailyLoss) {
      logger.warn('Paper trading: MAX DAILY LOSS REACHED - closing all positions', {
        dailyPnl: config.daily_pnl,
        limit: -maxDailyLoss
      });

      const { data: openTrades } = await supabase
        .from('paper_trades')
        .select('*')
        .eq('user_id', userId)
        .in('status', ['open', 'partial']);

      const closedTrades = [];
      if (openTrades) {
        for (const trade of openTrades) {
          const price = resolveCurrentPrice(trade.asset, marketData);
          if (price) {
            // Apply slippage to emergency closes (liquidations have WORSE slippage)
            const isExitBuy = trade.direction === 'SHORT';
            const slippedPrice = applySlippage(price, isExitBuy, trade.asset);
            const { closedTrade } = await executeFullClose(supabase, trade, slippedPrice, 'max_daily_loss');
            if (closedTrade) closedTrades.push(closedTrade);
          }
        }
      }

      // Disable for the day
      await supabase
        .from('paper_config')
        .update({ is_enabled: false })
        .eq('user_id', userId);

      return { checked: openTrades?.length || 0, closedTrades, partialCloses: [] };
    }

    // Record equity snapshot (throttled, non-blocking)
    recordEquitySnapshot(supabase, userId, config, marketData).catch(() => {});

    return await monitorOpenPositions(supabase, userId, marketData);
  } catch (err) {
    logger.error('monitorAndManage exception', { error: err.message });
    return { checked: 0, closedTrades: [], partialCloses: [] };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Constants
  DEFAULT_CONFIG,
  CONFIG_VALIDATION,

  // Config
  getOrCreateConfig,
  updateConfig,
  resetPaperAccount,

  // Evaluation (pure)
  evaluateSignalForTrade,
  calculatePositionSize,
  checkPriceAgainstLevels,
  resolveCurrentPrice,

  // Safety
  checkSafetyLimits,
  checkDuplicateTrade,

  // Execution
  openTrade,
  executePartialClose,
  executeFullClose,
  updateTrailingStop,

  // Monitoring
  monitorOpenPositions,

  // Analytics
  getPerformanceMetrics,
  getAdvancedPerformance,
  getTradeHistory,
  getOpenPositions,

  // Equity Curve
  recordEquitySnapshot,
  getEquityCurve,
  cleanupOldSnapshots,

  // Correlation
  calculateLogReturns,
  calculatePearsonCorrelation,
  getPositionCorrelations,

  // Orchestration
  evaluateAndExecute,
  monitorAndManage
};
