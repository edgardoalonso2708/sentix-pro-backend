// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — ALERT PROCESSING WORKER
// Generates signals, processes alerts (email + Telegram), evaluates paper trades.
// Runs signal generation every 5 minutes. Communicates with orchestrator via IPC.
// ═══════════════════════════════════════════════════════════════════════════════

require('dotenv').config();

const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const { SilentTelegramBot, setupTelegramCommands } = require('../telegramBot');
const { generateSignalWithRealData, generateMultiTimeframeSignal } = require('../technicalAnalysis');
const { fetchDerivativesData, fetchOrderBookDepth } = require('../binanceAPI');
const { evaluateAndExecute } = require('../paperTrading');
const { logger } = require('../logger');
const { classifyAxiosError, Provider } = require('../errors');
const { isWithinTradingHours } = require('../scheduleUtils');
const { SCHEDULE_CONFIG } = require('../strategyConfig');
const { MSG, sendToParent, installWorkerIPC } = require('../shared/ipc');

// ─── SUPABASE CLIENT ──────────────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

async function generateSignals() {
  const allSignals = [];

  if (!cachedMarketData || !cachedMarketData.crypto || Object.keys(cachedMarketData.crypto).length === 0) {
    logger.warn('No crypto data available for signal generation');
    return allSignals;
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
          fetchDerivativesData(assetId).catch(() => null),
          fetchOrderBookDepth(assetId).catch(() => null)
        ]);
      } catch (e) {
        logger.debug('Derivatives/OrderBook unavailable', { asset: assetId });
      }

      const signal = await generateMultiTimeframeSignal(
        assetId, data.price, data.change24h, data.volume24h,
        fearGreed, derivativesData, macroData, null, null, orderBookData
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

        // ─── SILVER SIGNAL (derived from gold) ───────────────────────
        if (cachedMarketData.metals?.silver) {
          const silver = cachedMarketData.metals.silver;
          if (silver.price > 0) {
            const silverSignal = { ...goldSignal };
            silverSignal.asset = 'SILVER (XAG)';
            silverSignal.price = silver.price;
            silverSignal.change24h = silver.change24h || (gold.change24h ? gold.change24h * 1.3 : 0);
            const amplifiedScore = Math.round(goldSignal.rawScore * 1.15);
            silverSignal.rawScore = Math.max(-100, Math.min(100, amplifiedScore));
            silverSignal.score = Math.round(Math.max(0, Math.min(100, (silverSignal.rawScore + 100) / 2)));
            silverSignal.confidence = Math.max(0, goldSignal.confidence - 5);
            silverSignal.reasons = goldSignal.reasons + ' \u2022 Derived from gold correlation (silver/gold ~0.85)';
            silverSignal.dataSource = 'Gold correlation (PAXG OHLCV)';
            silverSignal.assetClass = 'metal';
            silverSignal.derivatives = null;
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

const recentAlertKeys = new Map();
const ALERT_DEDUP_TTL = 30 * 60 * 1000;
const MAX_ALERT_KEYS = 500;

function isAlertDuplicate(key) {
  const ts = recentAlertKeys.get(key);
  if (ts && (Date.now() - ts) < ALERT_DEDUP_TTL) return true;
  if (recentAlertKeys.size > MAX_ALERT_KEYS) {
    const now = Date.now();
    for (const [k, v] of recentAlertKeys) {
      if (now - v > ALERT_DEDUP_TTL) recentAlertKeys.delete(k);
    }
  }
  return false;
}

function markAlertSent(key) {
  recentAlertKeys.set(key, Date.now());
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ALERT PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════

async function processAlerts() {
  try {
    logger.info('Processing alerts');

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

    logger.info('Alerts processed', {
      totalSignals: signals.length,
      saved: savedCount,
      telegram: telegramCount,
      email: emailCount
    });

    // ─── PAPER TRADING EVALUATION ─────────────────────────────────────────
    try {
      const ptResult = await evaluateAndExecute(supabase, 'default-user', signals, cachedMarketData);
      if (ptResult.newTrades.length > 0) {
        logger.info('Paper trades opened', {
          count: ptResult.newTrades.length,
          assets: ptResult.newTrades.map(t => t.asset)
        });
        sendToParent(MSG.PAPER_TRADE, { action: 'opened', trades: ptResult.newTrades });
      }
    } catch (ptError) {
      logger.warn('Paper trading evaluation failed', { error: ptError.message });
    }

  } catch (error) {
    logger.error('Alert processing failed', { error: error.message });
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

// Initial startup
(async () => {
  logger.info('Alerts worker started', { pid: process.pid });

  // Load persisted signals so we have data immediately
  const persisted = await loadPersistedSignals();
  if (persisted.length > 0) {
    cachedSignals = persisted;
    logger.info('Loaded persisted signals', { count: persisted.length });
    sendToParent(MSG.SIGNALS_UPDATE, cachedSignals);
  }

  // Load Telegram subscribers
  await loadTelegramSubscribers();

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
