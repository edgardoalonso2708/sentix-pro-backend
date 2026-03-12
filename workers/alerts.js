// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — ALERT PROCESSING WORKER
// Generates signals, processes alerts (email + Telegram), evaluates paper trades.
// Runs signal generation every 5 minutes. Communicates with orchestrator via IPC.
// ═══════════════════════════════════════════════════════════════════════════════

require('dotenv').config();

const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const { SilentTelegramBot, setupTelegramCommands, setupAutoTuneCommands } = require('../telegramBot');
const { generateSignalWithRealData, generateMultiTimeframeSignal } = require('../technicalAnalysis');
const { fetchDerivativesData, fetchOrderBookDepth } = require('../binanceAPI');
const { evaluateAndExecute, getPositionHeatMap } = require('../paperTrading');
const { processSignals, expireOrders } = require('../orderManager');
const { createAdapter } = require('../execution');
const { logger } = require('../logger');
const { classifyAxiosError, Provider } = require('../errors');
const { isWithinTradingHours } = require('../scheduleUtils');
const { SCHEDULE_CONFIG } = require('../strategyConfig');
const { MSG, sendToParent, installWorkerIPC } = require('../shared/ipc');
const { LRUCache } = require('../shared/lruCache');
const { metrics } = require('../shared/metrics');
const { wrapWithCircuitBreaker, setAlertCallback, getAllBreakerStatus } = require('../circuitBreaker');
const { initConfigManager } = require('../configManager');
const { recordSignalOutcome, checkPendingOutcomes } = require('../signalAccuracy');
const {
  runAutoTune, getActiveConfig, isAutoTuneRunning, getApprovalMode,
  getAutoTuneHistory, approveProposal, getPendingProposals,
  cleanupExpiredProposals, checkPostApplyPerformance,
} = require('../autoTuner');
const { computeFeatures } = require('../featureStore');
const { getAllRegimes, getRegime } = require('../marketRegime');

// ─── SUPABASE CLIENT ──────────────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY);

// ─── EXECUTION ADAPTER ──────────────────────────────────────────────────
let _executionAdapter = null; // Initialized in startup block

// ─── RESEND EMAIL CLIENT ──────────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'edgardoalonso2708@gmail.com';
let resend = null;
if (RESEND_API_KEY && RESEND_API_KEY.startsWith('re_') && RESEND_API_KEY.length > 10) {
  resend = new Resend(RESEND_API_KEY);
  logger.info('Alerts worker: Resend email client initialized');
}

// ─── TELEGRAM BOT ─────────────────────────────────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const bot = new SilentTelegramBot(TELEGRAM_BOT_TOKEN);

// ─── CACHED STATE (local to this worker) ──────────────────────────────────
let cachedMarketData = null;   // Received via IPC from market worker
let cachedSignals = [];
let isProcessingAlerts = false;

// ─── PRICE FRESHNESS TRACKING ────────────────────────────────────────────
const { getConfigSync } = require('../configManager');
let lastMarketDataReceived = 0;  // timestamp (ms)
let stalePriceAlertSent = false;

// Defaults (overridable via system_config 'alert_thresholds')
const ALERT_DEFAULTS = {
  staleWarnMs: 5 * 60 * 1000,       // 5 min → warn
  stalePauseMs: 30 * 60 * 1000,     // 30 min → pause signals
  anomalyCooldownMs: 30 * 60 * 1000 // 30 min cooldown per anomaly
};

function getAlertThresholds() {
  return getConfigSync('alert_thresholds', ALERT_DEFAULTS);
}

function checkPriceFreshness() {
  if (!lastMarketDataReceived) return { fresh: false, staleMs: Infinity, level: 'no_data' };
  const staleMs = Date.now() - lastMarketDataReceived;
  const thresholds = getAlertThresholds();

  if (staleMs > thresholds.stalePauseMs) {
    return { fresh: false, staleMs, level: 'critical' };
  }
  if (staleMs > thresholds.staleWarnMs) {
    return { fresh: true, staleMs, level: 'warning' };
  }
  return { fresh: true, staleMs, level: 'ok' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

async function generateSignals() {
  const allSignals = [];

  if (!cachedMarketData || !cachedMarketData.crypto || Object.keys(cachedMarketData.crypto).length === 0) {
    logger.warn('No crypto data available for signal generation');
    return allSignals;
  }

  // Load active strategy config (auto-tuned or default)
  let activeStrategyConfig = null;
  try {
    const { config, source } = await getActiveConfig(supabase);
    if (source === 'saved') {
      activeStrategyConfig = config;
      logger.debug('Using auto-tuned strategy config');
    }
  } catch (_) {
    // Fall back to defaults (null = use DEFAULT_STRATEGY_CONFIG)
  }

  const fearGreed = cachedMarketData.macro?.fearGreed || 50;

  const macroData = {
    btcDom: parseFloat(cachedMarketData.macro?.btcDom) || 0,
    btcChange24h: cachedMarketData.crypto?.bitcoin?.change24h || 0,
    dxy: cachedMarketData.macro?.dxy || 100,
    dxyTrend: cachedMarketData.macro?.dxyTrend || 'neutral',
    dxyChange: cachedMarketData.macro?.dxyChange || 0
  };

  // ─── CRYPTO SIGNALS ─────────────────────────────────────────────────
  const assets = Object.entries(cachedMarketData.crypto);
  logger.info('Generating signals', { assets: assets.length, fearGreed, btcDom: macroData.btcDom, dxy: macroData.dxy });

  for (const [assetId, data] of assets) {
    try {
      if (!data.price || data.price <= 0) {
        logger.warn('Skipping asset: invalid price', { asset: assetId, price: data.price });
        continue;
      }

      let derivativesData = null;
      let orderBookData = null;
      try {
        [derivativesData, orderBookData] = await Promise.all([
          wrapWithCircuitBreaker(Provider.BINANCE, () => fetchDerivativesData(assetId), null),
          wrapWithCircuitBreaker(Provider.BINANCE, () => fetchOrderBookDepth(assetId), null)
        ]);
      } catch (e) {
        logger.debug('Derivatives/OrderBook unavailable', { asset: assetId });
      }

      const signal = await generateMultiTimeframeSignal(
        assetId, data.price, data.change24h, data.volume24h,
        fearGreed, derivativesData, macroData, null, activeStrategyConfig, orderBookData
      );

      signal.assetClass = 'crypto';
      allSignals.push(signal);

      await new Promise(resolve => setTimeout(resolve, 1500));
    } catch (error) {
      logger.error('Signal generation failed', { asset: assetId, error: error.message });
    }
  }

  // ─── GOLD SIGNAL ─────────────────────────────────────────────────────
  if (cachedMarketData.metals?.gold) {
    try {
      const gold = cachedMarketData.metals.gold;
      if (gold.price > 0) {
        const goldSignal = await generateSignalWithRealData(
          'pax-gold', gold.price, gold.change24h || 0,
          gold.volume24h || 0, fearGreed, '1h', null
        );
        goldSignal.asset = 'GOLD (XAU)';
        goldSignal.assetClass = 'metal';
        allSignals.push(goldSignal);

        await new Promise(resolve => setTimeout(resolve, 1500));

        // ─── SILVER SIGNAL (gold-correlated with silver-specific adjustments) ───
        if (cachedMarketData.metals?.silver) {
          const silver = cachedMarketData.metals.silver;
          if (silver.price > 0) {
            const silverSignal = { ...goldSignal };
            silverSignal.asset = 'SILVER (XAG)';
            silverSignal.price = silver.price;
            silverSignal.assetClass = 'metal';
            silverSignal.derivatives = null;
            silverSignal.dataSource = 'Gold-correlated (PAXG OHLCV + silver price)';

            // Use silver's own price movement to weight the signal
            const silverChange = silver.change24h || 0;
            const goldChange = gold.change24h || 0;
            silverSignal.change24h = silverChange;

            // Check if silver and gold are moving in the same direction
            const sameDirection = (silverChange >= 0 && goldChange >= 0) || (silverChange < 0 && goldChange < 0);
            const silverMoreVolatile = Math.abs(silverChange) > Math.abs(goldChange);

            // Score: use gold's technical score but adjust based on silver's own momentum
            let adjustedScore = goldSignal.rawScore;
            if (sameDirection && silverMoreVolatile) {
              // Silver confirms gold direction with more strength → modest boost
              adjustedScore = Math.round(adjustedScore * 1.08);
            } else if (!sameDirection) {
              // Silver diverging from gold → reduce confidence significantly
              adjustedScore = Math.round(adjustedScore * 0.6);
            }
            silverSignal.rawScore = Math.max(-100, Math.min(100, adjustedScore));
            silverSignal.score = Math.round(Math.max(0, Math.min(100, (silverSignal.rawScore + 100) / 2)));

            // Confidence: always lower than gold (derived signal = less certain)
            const correlationPenalty = sameDirection ? 8 : 20;
            silverSignal.confidence = Math.max(0, goldSignal.confidence - correlationPenalty);

            // Reasons: be transparent about derivation
            silverSignal.reasons = goldSignal.reasons +
              ` \u2022 Silver derived from gold (corr ~0.85)` +
              (sameDirection ? ' \u2022 Silver confirms gold direction' : ' \u2022 ⚠ Silver diverging from gold') +
              (silverMoreVolatile ? ' \u2022 Silver showing higher volatility' : '');

            // Trade levels: scale by silver/gold price ratio
            if (goldSignal.tradeLevels) {
              const ratio = silver.price / gold.price;
              silverSignal.tradeLevels = {
                ...goldSignal.tradeLevels,
                entry: parseFloat((goldSignal.tradeLevels.entry * ratio).toFixed(4)),
                stopLoss: parseFloat((goldSignal.tradeLevels.stopLoss * ratio).toFixed(4)),
                takeProfit1: parseFloat((goldSignal.tradeLevels.takeProfit1 * ratio).toFixed(4)),
                takeProfit2: parseFloat((goldSignal.tradeLevels.takeProfit2 * ratio).toFixed(4)),
                support: parseFloat((goldSignal.tradeLevels.support * ratio).toFixed(4)),
                resistance: parseFloat((goldSignal.tradeLevels.resistance * ratio).toFixed(4)),
                pivot: parseFloat((goldSignal.tradeLevels.pivot * ratio).toFixed(4)),
                atrValue: parseFloat((goldSignal.tradeLevels.atrValue * ratio).toFixed(4))
              };
            }

            // Action thresholds (same as standard signals)
            if (silverSignal.rawScore >= 25) silverSignal.action = 'BUY';
            else if (silverSignal.rawScore >= 15 && silverSignal.confidence >= 35) silverSignal.action = 'BUY';
            else if (silverSignal.rawScore <= -25) silverSignal.action = 'SELL';
            else if (silverSignal.rawScore <= -15 && silverSignal.confidence >= 35) silverSignal.action = 'SELL';
            else silverSignal.action = 'HOLD';

            if (silverSignal.action === 'BUY') {
              silverSignal.strengthLabel = silverSignal.rawScore >= 50 && silverSignal.confidence >= 55 ? 'STRONG BUY' :
                silverSignal.rawScore >= 35 ? 'BUY' : 'WEAK BUY';
            } else if (silverSignal.action === 'SELL') {
              silverSignal.strengthLabel = silverSignal.rawScore <= -50 && silverSignal.confidence >= 55 ? 'STRONG SELL' :
                silverSignal.rawScore <= -35 ? 'SELL' : 'WEAK SELL';
            } else {
              silverSignal.strengthLabel = 'HOLD';
            }

            allSignals.push(silverSignal);
          }
        }
      }
    } catch (error) {
      logger.error('Gold/Silver signal generation failed', { error: error.message });
    }
  }

  // Mark off-hours signals
  const tradingHours = isWithinTradingHours(SCHEDULE_CONFIG);
  if (!tradingHours.active) {
    const reduction = SCHEDULE_CONFIG.offHoursConfidenceReduction || 15;
    allSignals.forEach(s => {
      s.offHours = true;
      s.offHoursReason = tradingHours.reason;
      s.confidence = Math.max(0, s.confidence - reduction);
    });
    logger.info('Off-hours signals marked', { reason: tradingHours.reason, reduction });
  }

  cachedSignals = allSignals.sort((a, b) => {
    const actionPriority = { BUY: 2, SELL: 2, HOLD: 0 };
    const priorityDiff = (actionPriority[b.action] || 0) - (actionPriority[a.action] || 0);
    if (priorityDiff !== 0) return priorityDiff;
    return b.confidence - a.confidence;
  });

  const actionable = cachedSignals.filter(s => s.action !== 'HOLD').length;
  logger.info('Signals generated', { total: cachedSignals.length, actionable });

  await persistSignals(cachedSignals);

  // Record signal outcomes for accuracy tracking (non-blocking)
  // Include current market regime for regime × confluence analysis (#10)
  const currentRegime = getRegime('bitcoin')?.regime || cachedMarketData?._regime || 'unknown';
  for (const s of cachedSignals) {
    if (s.action === 'HOLD') continue;
    recordSignalOutcome(supabase, s, currentRegime).catch(() => {});
  }

  // Send signals to orchestrator → api.js (for SSE broadcast)
  sendToParent(MSG.SIGNALS_UPDATE, cachedSignals);

  return cachedSignals;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

async function persistSignals(signals) {
  try {
    const { error } = await supabase
      .from('signals')
      .upsert(
        signals.map(s => ({
          asset: s.asset,
          action: s.action,
          strength_label: s.strengthLabel || s.action,
          score: s.score,
          raw_score: s.rawScore || 0,
          confidence: s.confidence,
          price: s.price,
          change_24h: s.change24h || 0,
          reasons: s.reasons,
          indicators: s.indicators || {},
          trade_levels: s.tradeLevels || null,
          derivatives: s.derivatives || null,
          timeframes: s.timeframes || null,
          macro_context: s.macroContext || null,
          data_source: s.dataSource || 'unknown',
          interval_tf: s.interval || 'multi',
          asset_class: s.assetClass || 'crypto',
          generated_at: s.timestamp || new Date().toISOString()
        })),
        { onConflict: 'asset' }
      );

    if (error) {
      if (error.code === '42P01') {
        logger.debug('Signals table not yet created - signals stored in memory only');
      } else {
        logger.warn('Signal persistence failed', { error: error.message });
      }
    } else {
      logger.debug('Signals persisted to database', { count: signals.length });
    }
  } catch (error) {
    logger.debug('Signal persistence unavailable', { error: error.message });
  }
}

async function loadPersistedSignals() {
  try {
    const { data, error } = await supabase
      .from('signals')
      .select('*')
      .order('confidence', { ascending: false });

    if (error) {
      logger.debug('Could not load persisted signals', { error: error.message });
      return [];
    }

    return (data || []).map(s => ({
      asset: s.asset,
      action: s.action,
      strengthLabel: s.strength_label,
      score: s.score,
      rawScore: s.raw_score,
      confidence: s.confidence,
      price: s.price,
      change24h: s.change_24h,
      reasons: s.reasons,
      indicators: s.indicators,
      tradeLevels: s.trade_levels || null,
      derivatives: s.derivatives || null,
      timeframes: s.timeframes || null,
      macroContext: s.macro_context || null,
      dataSource: s.data_source,
      interval: s.interval_tf,
      assetClass: s.asset_class,
      timestamp: s.generated_at
    }));
  } catch (error) {
    logger.debug('Signal load unavailable', { error: error.message });
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL ALERT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

async function sendEmailAlert(to, subject, htmlBody) {
  if (!resend) {
    return { success: false, error: 'Email not configured (RESEND_API_KEY missing)' };
  }

  let recipients;
  if (Array.isArray(to)) {
    recipients = to.map(e => e.trim()).filter(Boolean);
  } else if (typeof to === 'string' && to.includes(',')) {
    recipients = to.split(',').map(e => e.trim()).filter(Boolean);
  } else {
    recipients = [to].filter(Boolean);
  }

  if (recipients.length === 0) {
    return { success: false, error: 'No valid email recipients' };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: 'SENTIX PRO <onboarding@resend.dev>',
      to: recipients,
      subject,
      html: htmlBody
    });

    if (error) {
      logger.error('Email send error', { provider: Provider.RESEND, error: error.message });
      return { success: false, error: error.message || 'Email send failed' };
    }

    logger.info('Email sent', { to: recipients, id: data?.id });
    return { success: true, id: data?.id };
  } catch (error) {
    logger.error('Email exception', { provider: Provider.RESEND, error: error.message });
    return { success: false, error: error.message };
  }
}

function buildSignalEmailHTML(signal) {
  const actionColor = signal.action === 'BUY' ? '#22c55e' : signal.action === 'SELL' ? '#ef4444' : '#6b7280';
  const actionEmoji = signal.action === 'BUY' ? '🟢' : signal.action === 'SELL' ? '🔴' : '⚪';
  const priceFormatted = Number(signal.price).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const timeFormatted = new Date().toLocaleString('es-ES', { timeZone: 'America/Mexico_City' });

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; border-radius: 12px; overflow: hidden;">
      <div style="background: linear-gradient(135deg, #1e293b, #334155); padding: 24px; text-align: center;">
        <h1 style="margin: 0; font-size: 24px; color: #f8fafc;">\u{1F4CA} SENTIX PRO</h1>
        <p style="margin: 4px 0 0; color: #94a3b8; font-size: 14px;">Alerta de Trading</p>
      </div>
      <div style="padding: 24px;">
        <div style="background: #1e293b; border-radius: 8px; padding: 20px; margin-bottom: 16px; border-left: 4px solid ${actionColor};">
          <h2 style="margin: 0 0 8px; font-size: 28px; color: ${actionColor};">
            ${actionEmoji} ${signal.action}
          </h2>
          <p style="margin: 0; font-size: 20px; color: #f8fafc; font-weight: bold;">${signal.asset}</p>
          <p style="margin: 8px 0 0; font-size: 18px; color: #94a3b8;">${priceFormatted}</p>
        </div>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; border-bottom: 1px solid #334155;">Score</td>
            <td style="padding: 8px 0; text-align: right; color: #f8fafc; font-weight: bold; border-bottom: 1px solid #334155;">${signal.score}/100</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #94a3b8; border-bottom: 1px solid #334155;">Confianza</td>
            <td style="padding: 8px 0; text-align: right; color: #f8fafc; font-weight: bold; border-bottom: 1px solid #334155;">${signal.confidence}%</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #94a3b8;">Cambio 24h</td>
            <td style="padding: 8px 0; text-align: right; color: ${signal.change24h >= 0 ? '#22c55e' : '#ef4444'}; font-weight: bold;">
              ${signal.change24h >= 0 ? '+' : ''}${Number(signal.change24h).toFixed(2)}%
            </td>
          </tr>
        </table>
        <div style="background: #1e293b; border-radius: 8px; padding: 16px;">
          <p style="margin: 0 0 8px; color: #94a3b8; font-size: 12px; text-transform: uppercase;">An\u00e1lisis</p>
          <p style="margin: 0; color: #e2e8f0; font-size: 14px; line-height: 1.5;">${signal.reasons}</p>
        </div>
      </div>
      <div style="padding: 16px 24px; background: #1e293b; text-align: center; border-top: 1px solid #334155;">
        <p style="margin: 0; color: #64748b; font-size: 12px;">${timeFormatted} \u00b7 SENTIX PRO v2.1</p>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALERT DEDUPLICATION
// ═══════════════════════════════════════════════════════════════════════════════

const recentAlertKeys = new LRUCache({ maxSize: 500, ttl: 30 * 60 * 1000, name: 'alertDedup' });

function isAlertDuplicate(key) {
  return recentAlertKeys.has(key);
}

function markAlertSent(key) {
  recentAlertKeys.set(key, true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ALERT PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════

async function processAlerts() {
  const _cycleStart = Date.now();
  try {
    // ─── PRICE FRESHNESS CHECK ─────────────────────────────────────────
    const freshness = checkPriceFreshness();
    if (freshness.level === 'critical') {
      const staleMin = Math.round(freshness.staleMs / 60000);
      logger.error(`⚠️ STALE DATA: No market update for ${staleMin}min — PAUSING signal generation`);
      metrics.counter('alerts.stale_data_paused');
      if (!stalePriceAlertSent && bot.isActive()) {
        bot.broadcastMessage(`⚠️ *STALE DATA ALERT*\nNo market data received for *${staleMin} minutes*.\nSignal generation is *PAUSED* until fresh data arrives.`).catch(() => {});
        stalePriceAlertSent = true;
      }
      return; // Skip entire cycle — trading on stale data is dangerous
    }
    if (freshness.level === 'warning') {
      const staleMin = Math.round(freshness.staleMs / 60000);
      logger.warn(`Price data is ${staleMin}min old — signals may be unreliable`);
      metrics.counter('alerts.stale_data_warning');
    }

    logger.info('Processing alerts');
    metrics.counter('alerts.cycles');

    const signals = await generateSignals();
    let savedCount = 0;
    let telegramCount = 0;
    let emailCount = 0;

    // Load per-user alert filters
    let alertFilters = null;
    try {
      const { data, error } = await supabase
        .from('alert_filters')
        .select('*')
        .eq('enabled', true);
      if (!error && data) alertFilters = data;
    } catch (e) {
      logger.debug('alert_filters table not available, using defaults');
    }

    const DEFAULT_FILTER = {
      assets: [],
      actions: ['BUY', 'SELL', 'STRONG BUY', 'STRONG SELL'],
      min_confidence: 45,
      min_score: 25,
      telegram_enabled: true,
      email_enabled: true,
      cooldown_minutes: 20
    };

    const filter = (alertFilters && alertFilters.length > 0) ? alertFilters[0] : DEFAULT_FILTER;

    for (const signal of signals) {
      if (filter.assets && filter.assets.length > 0) {
        if (!filter.assets.includes(signal.asset)) continue;
      }

      const signalActions = [signal.action, signal.strengthLabel].filter(Boolean);
      const matchesAction = filter.actions.some(a => signalActions.includes(a));
      if (!matchesAction) continue;

      if (signal.confidence < (filter.min_confidence || 0)) continue;
      if (Math.abs(signal.rawScore || 0) < (filter.min_score || 0)) continue;

      const alertKey = `${signal.asset}-${signal.action}`;
      if (isAlertDuplicate(alertKey)) continue;

      // Save to alerts table
      try {
        const { error } = await supabase
          .from('alerts')
          .insert({
            asset: signal.asset,
            action: signal.action,
            score: signal.score,
            confidence: signal.confidence,
            reasons: signal.reasons,
            price: signal.price
          });

        if (error) {
          if (error.code === '42P01') {
            logger.debug('Alerts table not yet created - skipping DB save');
          } else {
            logger.warn('Alert save failed', { error: error.message });
          }
        } else {
          savedCount++;
        }
      } catch (dbError) {
        logger.warn('Alert DB save error', { error: dbError.message });
      }

      // Send via Telegram
      if (filter.telegram_enabled !== false && bot.isActive()) {
        const result = await bot.broadcastAlert(signal);
        if (result.sent > 0) {
          telegramCount += result.sent;
          logger.info('Telegram alert sent', {
            asset: signal.asset, action: signal.action,
            confidence: signal.confidence, sent: result.sent, total: result.total
          });
        }
      }

      // Send via email
      if (filter.email_enabled !== false && resend) {
        const emailRecipients = (filter.alert_emails && filter.alert_emails.trim())
          ? filter.alert_emails
          : ALERT_EMAIL;
        const emailResult = await sendEmailAlert(
          emailRecipients,
          `${signal.action === 'BUY' ? '🟢' : '🔴'} SENTIX PRO: ${signal.action} ${signal.asset} (${signal.confidence}%)`,
          buildSignalEmailHTML(signal)
        );
        if (emailResult.success) emailCount++;
      }

      markAlertSent(alertKey);
    }

    metrics.counter('alerts.signals', signals.length);
    metrics.counter('alerts.telegram', telegramCount);
    metrics.counter('alerts.email', emailCount);
    metrics.histogram('alerts.cycle.duration', Date.now() - _cycleStart);

    logger.info('Alerts processed', {
      totalSignals: signals.length,
      saved: savedCount,
      telegram: telegramCount,
      email: emailCount
    });

    // ─── PAPER TRADING EVALUATION ─────────────────────────────────────────
    // Attach advanced market regime for Kelly sizing + signal quality
    try {
      const btcRegime = getRegime('bitcoin');
      if (btcRegime) {
        cachedMarketData._regime = btcRegime.regime;
        cachedMarketData._regimeData = btcRegime;
        cachedMarketData._allRegimes = getAllRegimes();
      } else {
        // Fallback to simple regime from BTC 24h change
        const btcData = cachedMarketData?.crypto?.bitcoin;
        if (btcData?.change24h !== undefined) {
          const absChange = Math.abs(btcData.change24h);
          if (absChange > 8) cachedMarketData._regime = 'volatile';
          else if (btcData.change24h > 2) cachedMarketData._regime = 'trending_up';
          else if (btcData.change24h < -2) cachedMarketData._regime = 'trending_down';
          else cachedMarketData._regime = 'ranging';
        }
      }
    } catch (_) {}

    try {
      if (_executionAdapter) {
        // New order-based flow: Signal → Order → Validate → Execute
        const orderResult = await processSignals(supabase, 'default-user', signals, cachedMarketData, _executionAdapter, { autoExecute: true });
        if (orderResult.executed && orderResult.executed.length > 0) {
          const trades = orderResult.executed.map(e => e.trade).filter(Boolean);
          logger.info('Orders executed', {
            count: orderResult.executed.length,
            assets: trades.map(t => t.asset)
          });
          if (trades.length > 0) {
            sendToParent(MSG.PAPER_TRADE, { action: 'opened', trades });
          }
          // Broadcast order updates
          orderResult.executed.forEach(e => {
            if (e.order) sendToParent(MSG.ORDER_UPDATE, { order: e.order });
          });
        }
        if (orderResult.rejected && orderResult.rejected.length > 0) {
          logger.debug('Orders rejected by risk checks', {
            count: orderResult.rejected.length,
            reasons: orderResult.rejected.map(r => r.reason).slice(0, 3)
          });
        }
      } else {
        // Legacy fallback: direct paper trading
        const ptResult = await evaluateAndExecute(supabase, 'default-user', signals, cachedMarketData);
        if (ptResult.newTrades.length > 0) {
          logger.info('Paper trades opened (legacy)', {
            count: ptResult.newTrades.length,
            assets: ptResult.newTrades.map(t => t.asset)
          });
          sendToParent(MSG.PAPER_TRADE, { action: 'opened', trades: ptResult.newTrades });
        }
      }
    } catch (ptError) {
      logger.warn('Paper trading evaluation failed', { error: ptError.message });
    }

    // ─── POSITION ANOMALY DETECTION ──────────────────────────────────────
    // Check open positions for risk indicators and send Telegram alerts
    try {
      await checkPositionAnomalies(supabase, cachedMarketData);
    } catch (anomalyErr) {
      logger.debug('Position anomaly check failed', { error: anomalyErr.message });
    }

    // ─── CHECK PENDING SIGNAL OUTCOMES (accuracy tracking) ─────────────
    try {
      await checkPendingOutcomes(supabase, async (asset) => {
        if (!cachedMarketData) return null;
        // Try crypto first, then metals
        const crypto = cachedMarketData.crypto?.[asset.toLowerCase()];
        if (crypto?.price) return crypto.price;
        const metal = cachedMarketData.metals?.[asset.toLowerCase()];
        if (metal?.price) return metal.price;
        return null;
      });
    } catch (accErr) {
      logger.debug('Signal accuracy check failed', { error: accErr.message });
    }

  } catch (error) {
    logger.error('Alert processing failed', { error: error.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POSITION ANOMALY DETECTION
// Checks open positions for risk indicators and sends Telegram alerts
// ═══════════════════════════════════════════════════════════════════════════════

// Throttle anomaly alerts: cooldown per anomaly type (configurable)
const anomalyAlertCache = new LRUCache(100);

/**
 * Check all open positions for anomalies and send Telegram alerts for critical ones.
 * Runs every alert cycle (~5 min) but throttles per-anomaly to avoid spam.
 */
async function checkPositionAnomalies(supabase, marketData) {
  if (!bot.isActive() || !marketData) return;

  const heatMap = await getPositionHeatMap(supabase, 'default-user', marketData);
  if (!heatMap.anomalies || heatMap.anomalies.length === 0) return;

  const now = Date.now();
  const highSeverity = heatMap.anomalies.filter(a => a.severity === 'high');

  if (highSeverity.length === 0) return;

  // Build Telegram message for critical anomalies (deduplicated by cooldown)
  const newAlerts = [];
  for (const anomaly of highSeverity) {
    const cacheKey = `${anomaly.type}:${anomaly.asset}`;
    const lastSent = anomalyAlertCache.get(cacheKey);
    if (lastSent && (now - lastSent) < getAlertThresholds().anomalyCooldownMs) continue;

    newAlerts.push(anomaly);
    anomalyAlertCache.set(cacheKey, now);
  }

  if (newAlerts.length === 0) return;

  // Compose message
  const lines = [
    '🔥 *POSITION ANOMALY ALERT*',
    `${newAlerts.length} critical issue${newAlerts.length > 1 ? 's' : ''} detected:`,
    ''
  ];

  for (const a of newAlerts) {
    lines.push(`• ${a.message}`);
  }

  // Add summary
  const { summary } = heatMap;
  lines.push('');
  lines.push(`📊 Heat map: 🟢${summary.cool} 🟡${summary.warm} 🔴${summary.hot} | Total P&L: $${summary.totalUnrealizedPnl}`);

  try {
    await bot.broadcastMessage(lines.join('\n'));
    logger.info('Position anomaly alerts sent', {
      count: newAlerts.length,
      types: newAlerts.map(a => a.type)
    });
    metrics.counter('alerts.anomalies', newAlerts.length);
  } catch (err) {
    logger.warn('Failed to send anomaly alerts', { error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM SUBSCRIBER PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

async function loadTelegramSubscribers() {
  if (!bot.isActive()) return;
  try {
    const { data, error } = await supabase
      .from('telegram_subscribers')
      .select('chat_id');
    if (error) {
      if (error.code === '42P01') {
        logger.debug('telegram_subscribers table not yet created');
      } else {
        logger.warn('Could not load Telegram subscribers', { error: error.message });
      }
      return;
    }
    for (const row of data || []) {
      bot.subscribe(row.chat_id);
    }
    logger.info('Telegram subscribers loaded', { count: (data || []).length });
  } catch (error) {
    logger.debug('Telegram subscriber load unavailable', { error: error.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKER LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

let cronTask = null;

function gracefulShutdown() {
  logger.info('Alerts worker shutting down');
  if (cronTask) {
    try { cronTask.stop(); } catch (_) {}
  }
  bot.stop();
  setTimeout(() => process.exit(0), 500);
}

// Install IPC handlers (heartbeat + shutdown + market_update from orchestrator)
installWorkerIPC(gracefulShutdown, (msg) => {
  if (msg.type === MSG.MARKET_UPDATE) {
    cachedMarketData = msg.data;
    lastMarketDataReceived = Date.now();
    stalePriceAlertSent = false; // reset on fresh data
  }
});

// Cron: process alerts every 5 minutes
cronTask = cron.schedule('*/5 * * * *', async () => {
  if (isProcessingAlerts) {
    logger.debug('Skipping processAlerts — previous cycle still running');
    return;
  }
  isProcessingAlerts = true;
  try {
    await processAlerts();
  } finally {
    isProcessingAlerts = false;
  }
});

// Cron: auto-parameter tuning daily at 3:00 AM (now with Telegram approval)
cron.schedule('0 3 * * *', async () => {
  if (isAutoTuneRunning()) {
    logger.debug('Skipping auto-tune — already running');
    return;
  }
  logger.info('Starting scheduled auto-tune');
  try {
    const result = await runAutoTune(supabase, { trigger: 'scheduled', bot });
    if (result.error) {
      logger.warn('Scheduled auto-tune failed', { error: result.error });
    } else if (result.skipped) {
      logger.info('Scheduled auto-tune skipped', { reason: result.reason });
    } else if (result.status === 'pending_approval') {
      logger.info('Scheduled auto-tune pending Telegram approval', { runId: result.runId });
    } else {
      const applied = result.paramsApplied ? Object.keys(result.paramsApplied).length : 0;
      logger.info('Scheduled auto-tune completed', {
        applied,
        aiDecision: result.aiReview?.decision || 'N/A',
        regime: result.marketRegime,
      });
      // Notify via Telegram (auto mode only — telegram mode sends its own proposal)
      if (bot.isActive() && applied > 0 && result.approvalMode === 'auto') {
        const paramList = Object.entries(result.paramsApplied)
          .map(([k, v]) => `  • ${k}: ${v}`)
          .join('\n');
        bot.broadcastAlert({
          asset: '🤖 AUTO-TUNE',
          action: 'UPDATE',
          strengthLabel: `${applied} params`,
          confidence: 100,
          price: 0,
          reasons: `Auto-tune completed (${result.marketRegime} regime).\n${applied} params updated:\n${paramList}${result.aiReview ? `\nAI: ${result.aiReview.decision}` : ''}`,
        }).catch(() => {});
      }
    }
  } catch (err) {
    logger.error('Scheduled auto-tune error', { error: err.message });
  }
});

// Cron: cleanup expired proposals + post-apply monitoring every 6h
cron.schedule('0 */6 * * *', async () => {
  try {
    await cleanupExpiredProposals(supabase, bot);
    await checkPostApplyPerformance(supabase, bot);
  } catch (err) {
    logger.debug('Post-apply/cleanup check error', { error: err.message });
  }
});

// Cron: expire GTD orders every minute
cron.schedule('* * * * *', async () => {
  try {
    const { expired } = await expireOrders(supabase);
    if (expired > 0) {
      logger.info('Expired GTD orders', { count: expired });
    }
  } catch (err) {
    logger.error('expireOrders cron error', { error: err.message });
  }
});

// Send metrics to API via IPC every 60s
const _metricsTimer = setInterval(() => {
  sendToParent(MSG.METRICS_UPDATE, metrics.snapshot());
}, 60000);
_metricsTimer.unref();

// Initial startup
(async () => {
  logger.info('Alerts worker started', { pid: process.pid });

  // Initialize config manager (loads system_config from Supabase)
  await initConfigManager(supabase).catch(() => {});

  // Initialize execution adapter for order-based trading
  try {
    _executionAdapter = createAdapter('paper', { supabase });
    logger.info('Paper execution adapter initialized');
  } catch (adapterErr) {
    logger.warn('Failed to init execution adapter, falling back to legacy', { error: adapterErr.message });
  }

  // Register circuit breaker alert callback → Telegram notifications
  setAlertCallback(async (provider, info) => {
    if (!bot.isActive()) return;
    const msg = `⚡ *CIRCUIT BREAKER* — ${provider}\n` +
      `State: ${info.state} (${info.failureCount} failures)\n` +
      `Calls paused for ${Math.round(info.resetTimeoutMs / 1000)}s.\n` +
      `Total trips: ${info.totalTrips}`;
    await bot.broadcastMessage(msg).catch(() => {});
  });

  // Load persisted signals so we have data immediately
  const persisted = await loadPersistedSignals();
  if (persisted.length > 0) {
    cachedSignals = persisted;
    logger.info('Loaded persisted signals', { count: persisted.length });
    sendToParent(MSG.SIGNALS_UPDATE, cachedSignals);
  }

  // Load Telegram subscribers
  await loadTelegramSubscribers();

  // Setup Telegram auto-tune callback handlers (inline keyboard buttons)
  bot.onCallbackQuery('at_', async (query) => {
    const parts = query.data.split('_'); // at_apply_runId | at_blend_runId | at_reject_runId | at_run
    const action = parts[1];

    if (action === 'run') {
      // Manual trigger from Telegram
      if (isAutoTuneRunning()) {
        await bot.sendMessage(query.message.chat.id, '⏳ Auto-tune ya está ejecutándose.');
        return;
      }
      await bot.sendMessage(query.message.chat.id, '🔄 Iniciando auto-tune manual...');
      runAutoTune(supabase, { trigger: 'manual', bot }).catch(err => {
        logger.error('Manual auto-tune from Telegram failed', { error: err.message });
      });
      return;
    }

    // Approval action: apply/blend/reject
    const runId = parts.slice(2).join('_'); // Handle UUIDs with underscores
    if (!runId) return;

    const result = await approveProposal(supabase, runId, action, 'telegram', bot);
    if (!result.success) {
      await bot.sendMessage(query.message.chat.id, `⚠️ ${result.message}`);
    }
    // editMessage is called inside approveProposal
  });

  // Setup /autotune command
  setupAutoTuneCommands(bot, async () => {
    const { config, source } = await getActiveConfig(supabase);
    const { history } = await getAutoTuneHistory(supabase, 1);
    let marketRegime = 'unknown';
    try {
      const features = await computeFeatures('bitcoin', '4h');
      marketRegime = features?.marketRegime || 'unknown';
    } catch (_) {}

    return {
      configSource: source,
      marketRegime,
      approvalMode: getApprovalMode(),
      lastRun: history[0] || null,
      pendingCount: getPendingProposals().length,
    };
  });

  logger.info('Alerts worker ready');
})();

// Error handlers
process.on('unhandledRejection', (reason) => {
  logger.error('Alerts worker unhandled rejection', { reason: reason?.message || String(reason) });
});

process.on('uncaughtException', (err) => {
  logger.error('Alerts worker uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});
