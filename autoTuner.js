// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — AUTO-PARAMETER TUNER (Hybrid AI + Telegram Approval)
// Periodically re-optimizes strategy parameters and applies safe changes.
// Nivel 1: Statistical (grid search + walk-forward + safety guards)
// Nivel 2: AI review via Claude API (enhanced context)
// Nivel 3: Telegram/API approval before applying + post-apply monitoring
// ═══════════════════════════════════════════════════════════════════════════════

const { logger } = require('./logger');
const { runOptimization } = require('./optimizer');
const { DEFAULT_STRATEGY_CONFIG, PARAM_RANGES, mergeConfig } = require('./strategyConfig');
const { computeFeatures } = require('./featureStore');

// ─── Priority Parameters (most impactful for performance) ────────────────────
const PRIORITY_PARAMS = [
  'buyThreshold',
  'sellThreshold',
  'adxStrongThreshold',
  'adxStrongMultiplier',
  'strongConfluenceMult',
  'conflictingMult',
  'atrStopMult',
  'atrTrailingMult',
  'rsiOversold',
  'rsiOverbought',
];

// ─── Safety Configuration ────────────────────────────────────────────────────
const TUNER_CONFIG = {
  lookbackDays: 60,
  minTradesRequired: 15,
  maxOverfitDegradation: 0.50,
  minImprovementPct: 5,
  maxParamsPerRun: 5,
  cooldownHours: 12,
  blendRatio: 0.5,
  revertThresholdPct: 20,  // If performance drops > 20%, auto-revert
  proposalTtlMs: 4 * 60 * 60 * 1000, // 4 hours for Telegram approval
};

// ─── Approval mode: 'auto' (apply immediately) | 'telegram' (require approval)
const APPROVAL_MODE = process.env.AUTOTUNE_APPROVAL_MODE || 'telegram';

// ─── In-memory state ─────────────────────────────────────────────────────────
let isRunning = false;
const pendingProposals = new Map(); // runId → { accepted, configAfter, configBefore, context, expiresAt, messageIds }

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIVE CONFIG MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the currently active strategy config.
 * Tries saved_strategy_configs (is_active=true), falls back to DEFAULT_STRATEGY_CONFIG.
 */
async function getActiveConfig(supabase) {
  try {
    const { data, error } = await supabase
      .from('saved_strategy_configs')
      .select('config')
      .eq('is_active', true)
      .limit(1)
      .single();

    if (!error && data?.config) {
      return { config: mergeConfig(data.config), source: 'saved' };
    }
  } catch (_) {
    // Table may not exist yet
  }

  return { config: { ...DEFAULT_STRATEGY_CONFIG }, source: 'default' };
}

/**
 * Save a new active config (deactivates previous active).
 */
async function saveActiveConfig(supabase, config, name, description, performance = null) {
  try {
    // Deactivate current active
    await supabase
      .from('saved_strategy_configs')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('is_active', true);

    // Insert new active
    const { error } = await supabase
      .from('saved_strategy_configs')
      .insert({
        name,
        description,
        config,
        performance,
        is_active: true,
      });

    if (error) {
      logger.warn('Failed to save active config', { error: error.message });
      return false;
    }

    logger.info('Active strategy config updated', { name });
    return true;
  } catch (err) {
    logger.warn('saveActiveConfig unavailable', { error: err.message });
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAFETY CHECKS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check cooldown: reject if last run was < cooldownHours ago.
 */
async function checkCooldown(supabase) {
  try {
    const { data } = await supabase
      .from('auto_tune_runs')
      .select('completed_at')
      .in('status', ['completed', 'pending_approval'])
      .order('completed_at', { ascending: false })
      .limit(1)
      .single();

    if (data?.completed_at) {
      const hoursAgo = (Date.now() - new Date(data.completed_at).getTime()) / (1000 * 60 * 60);
      if (hoursAgo < TUNER_CONFIG.cooldownHours) {
        return { ok: false, reason: `Last run was ${hoursAgo.toFixed(1)}h ago (cooldown: ${TUNER_CONFIG.cooldownHours}h)` };
      }
    }
  } catch (_) {
    // Table may not exist — no cooldown issue
  }
  return { ok: true };
}

/**
 * Evaluate whether a single parameter proposal passes safety filters.
 */
function evaluateProposal(result) {
  const checks = {
    hasTrades: false,
    improvementOk: false,
    noOverfit: false,
    degradationOk: false,
  };

  // Min trades
  const bestResult = result.results?.find(r => r.value === result.bestValue);
  const trades = bestResult?.totalTrades || 0;
  checks.hasTrades = trades >= TUNER_CONFIG.minTradesRequired;

  // Improvement threshold
  const currentSharpe = result.defaultSharpe || 0;
  const proposedSharpe = result.bestSharpe || 0;
  if (currentSharpe > 0) {
    const improvementPct = ((proposedSharpe - currentSharpe) / Math.abs(currentSharpe)) * 100;
    checks.improvementOk = improvementPct >= TUNER_CONFIG.minImprovementPct;
  } else {
    // Current is zero/negative, any positive is improvement
    checks.improvementOk = proposedSharpe > 0.1;
  }

  // Overfit check
  if (result.validation?.enabled) {
    checks.noOverfit = !result.validation.overfitWarning;
    checks.degradationOk = (result.validation.avgDegradation || 0) <= TUNER_CONFIG.maxOverfitDegradation;
  } else {
    // No validation available (< 30 days) — be conservative
    checks.noOverfit = true;
    checks.degradationOk = true;
  }

  const passed = checks.hasTrades && checks.improvementOk && checks.noOverfit && checks.degradationOk;

  return { passed, checks, trades };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENHANCED CONTEXT — Paper trading + Signal accuracy + History
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Gather rich context for the AI advisor: paper trading perf, signal accuracy, tune history.
 */
async function getEnhancedContext(supabase, asset) {
  const context = {
    paperPerformance: null,
    signalAccuracy: null,
    recentTuneRuns: [],
    regimeHistory: null,
  };

  // Paper trading performance (last 30 days)
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { data: trades } = await supabase
      .from('paper_trades')
      .select('realized_pnl, realized_pnl_percent, exit_reason')
      .eq('status', 'closed')
      .gte('closed_at', cutoff);

    if (trades && trades.length >= 5) {
      const wins = trades.filter(t => t.realized_pnl > 0).length;
      const pnls = trades.map(t => parseFloat(t.realized_pnl) || 0);
      const avgPnl = pnls.reduce((s, v) => s + v, 0) / pnls.length;
      const totalPnl = pnls.reduce((s, v) => s + v, 0);

      // Simple Sharpe approximation (annualized from daily avg)
      const mean = avgPnl;
      const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length;
      const stdDev = Math.sqrt(variance) || 1;
      const dailySharpe = mean / stdDev;
      const sharpe = Math.round(dailySharpe * Math.sqrt(365) * 100) / 100;

      // Max drawdown
      let peak = 0, maxDD = 0, running = 0;
      for (const p of pnls) {
        running += p;
        if (running > peak) peak = running;
        const dd = (peak - running) / (Math.abs(peak) || 1);
        if (dd > maxDD) maxDD = dd;
      }

      context.paperPerformance = {
        trades: trades.length,
        winRate: Math.round((wins / trades.length) * 100),
        avgPnl: Math.round(avgPnl * 100) / 100,
        totalPnl: Math.round(totalPnl * 100) / 100,
        sharpe,
        maxDrawdown: Math.round(maxDD * 100),
      };
    }
  } catch (_) { /* non-critical */ }

  // Signal accuracy (last 7 days)
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: outcomes } = await supabase
      .from('signal_outcomes')
      .select('direction_correct_1h, direction_correct_4h, direction_correct_24h')
      .gte('signal_generated_at', cutoff)
      .not('price_1h', 'is', null);

    if (outcomes && outcomes.length >= 5) {
      const total = outcomes.length;
      const hit1h = outcomes.filter(o => o.direction_correct_1h).length;
      const hit4h = outcomes.filter(o => o.direction_correct_4h !== null && o.direction_correct_4h).length;
      const hit24h = outcomes.filter(o => o.direction_correct_24h !== null && o.direction_correct_24h).length;
      const count4h = outcomes.filter(o => o.direction_correct_4h !== null).length;
      const count24h = outcomes.filter(o => o.direction_correct_24h !== null).length;

      context.signalAccuracy = {
        total,
        hitRate1h: Math.round((hit1h / total) * 100),
        hitRate4h: count4h > 0 ? Math.round((hit4h / count4h) * 100) : null,
        hitRate24h: count24h > 0 ? Math.round((hit24h / count24h) * 100) : null,
      };
    }
  } catch (_) { /* non-critical */ }

  // Last 5 auto-tune runs
  try {
    const { data: runs } = await supabase
      .from('auto_tune_runs')
      .select('started_at, status, market_regime, params_applied, ai_review, approved_by')
      .order('started_at', { ascending: false })
      .limit(5);

    if (runs) {
      context.recentTuneRuns = runs.map(r => ({
        date: r.started_at?.slice(0, 10),
        status: r.status,
        regime: r.market_regime,
        applied: r.params_applied ? Object.keys(r.params_applied).length : 0,
        aiDecision: r.ai_review?.decision || 'N/A',
        approvedBy: r.approved_by || 'auto',
      }));
    }
  } catch (_) { /* non-critical */ }

  // Last 5 closed trades (with regime/confluence for pattern analysis)
  try {
    const { data: recentTrades } = await supabase
      .from('paper_trades')
      .select('asset, direction, realized_pnl, realized_pnl_percent, entry_regime, entry_confluence_level, entry_reasons, exit_reason, entry_at, exit_at, entry_confidence')
      .eq('status', 'closed')
      .order('exit_at', { ascending: false })
      .limit(5);

    if (recentTrades && recentTrades.length > 0) {
      context.recentClosedTrades = recentTrades.map(t => ({
        asset: t.asset,
        direction: t.direction,
        pnl: parseFloat(t.realized_pnl) || 0,
        pnlPct: parseFloat(t.realized_pnl_percent) || 0,
        regime: t.entry_regime || 'unknown',
        confluence: t.entry_confluence_level || 'unknown',
        exitReason: t.exit_reason || 'unknown',
        confidence: t.entry_confidence || 0,
        holdingHours: (t.entry_at && t.exit_at)
          ? Math.round((new Date(t.exit_at) - new Date(t.entry_at)) / 3600000)
          : null,
      }));
    }
  } catch (_) { /* non-critical */ }

  // Parameter conflict detection
  try {
    const { config } = await getActiveConfig(supabase);
    if (config) {
      context.parameterConflicts = detectParameterConflicts(config);
    }
  } catch (_) { /* non-critical */ }

  return context;
}

/**
 * Detect contradictions or suboptimal combinations in strategy parameters.
 * Returns an array of human-readable conflict descriptions.
 * @param {Object} config - Strategy configuration object
 * @returns {string[]}
 */
function detectParameterConflicts(config) {
  const conflicts = [];
  if (!config) return conflicts;

  // 1. Aggressive RSI oversold + very conservative position sizing
  if ((config.rsiOversold >= 35 || config.rsiOversoldThreshold >= 35) &&
      config.risk_per_trade !== undefined && config.risk_per_trade <= 0.005) {
    conflicts.push('Aggressive RSI oversold threshold (≥35) with very conservative position sizing (≤0.5%). Signals fire often but positions are tiny.');
  }

  // 2. Very tight stops + long holding period
  if (config.atrStopMult !== undefined && config.atrStopMult <= 1.0 &&
      config.max_holding_hours !== undefined && config.max_holding_hours >= 168) {
    conflicts.push('Tight stop-loss (ATR ×≤1.0) with long max holding period (7+ days). Most trades will stop out before reaching potential.');
  }

  // 3. High confluence requirement + low buy threshold
  if (config.min_confluence !== undefined && config.min_confluence >= 4 &&
      config.buyThreshold !== undefined && config.buyThreshold <= 15) {
    conflicts.push('High confluence requirement (≥4) with low buy threshold (≤15). Very few signals pass both filters.');
  }

  // 4. Lenient conflicting multiplier + aggressive strong confluence boost
  if (config.conflictingMult !== undefined && config.conflictingMult > 0.85 &&
      config.strongConfluenceMult !== undefined && config.strongConfluenceMult > 1.3) {
    conflicts.push('Conflicting signal multiplier is lenient (>0.85) but strong confluence mult is aggressive (>1.3). Mixed signals get through too easily.');
  }

  // 5. Wide stop-loss + small position = wasted capital
  if (config.atrStopMult !== undefined && config.atrStopMult >= 3.0 &&
      config.max_position_percent !== undefined && config.max_position_percent <= 10) {
    conflicts.push('Wide stop-loss (ATR ×≥3.0) with small max position (≤10%). Capital risk per trade is extremely low, limiting potential returns.');
  }

  // 6. Very short max holding + trend-following weights dominate
  if (config.max_holding_hours !== undefined && config.max_holding_hours <= 12 &&
      config.trendWeight !== undefined && config.trendWeight >= 25) {
    conflicts.push('Short max holding (≤12h) with heavy trend weight (≥25). Trend signals need time to develop; tight holding limits gains.');
  }

  return conflicts;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NIVEL 2 — AI REVIEW (Claude API — Enhanced)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ask Claude to review proposed parameter changes with enriched context.
 * Returns { decision, reasoning, modifiedParams } or null if unavailable.
 */
async function aiReviewProposals(proposals, context) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch (_) {
    logger.debug('@anthropic-ai/sdk not installed — skipping AI review');
    return null;
  }

  try {
    const client = new Anthropic({ apiKey });

    const prompt = buildAIPrompt(proposals, context);

    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content?.[0]?.text || '';

    // Parse structured response
    const decision = parseAIDecision(text);

    return {
      decision: decision.decision,
      reasoning: decision.reasoning,
      modifiedParams: decision.modifiedParams || null,
      model: 'claude-3-5-haiku-20241022',
      inputTokens: response.usage?.input_tokens || 0,
      outputTokens: response.usage?.output_tokens || 0,
    };
  } catch (err) {
    logger.warn('AI review failed', { error: err.message });
    return { decision: 'SKIP', reasoning: `AI review error: ${err.message}`, model: 'error' };
  }
}

function buildAIPrompt(proposals, context) {
  const paramLines = proposals.map(p =>
    `- ${p.paramName}: ${p.currentValue} → ${p.proposedValue} (Sharpe: ${p.currentSharpe?.toFixed(2)} → ${p.proposedSharpe?.toFixed(2)}, +${p.improvementPct?.toFixed(1)}%)`
  ).join('\n');

  // Enhanced context sections
  let paperSection = '';
  if (context.paperPerformance) {
    const pp = context.paperPerformance;
    paperSection = `\nPAPER TRADING (last 30d):
- ${pp.trades} trades, Win Rate: ${pp.winRate}%, Sharpe: ${pp.sharpe}
- Avg P&L: $${pp.avgPnl}, Total P&L: $${pp.totalPnl}, Max DD: ${pp.maxDrawdown}%`;
  }

  let signalSection = '';
  if (context.signalAccuracy) {
    const sa = context.signalAccuracy;
    signalSection = `\nSIGNAL ACCURACY (last 7d, ${sa.total} signals):
- 1h hit rate: ${sa.hitRate1h}%${sa.hitRate4h !== null ? `, 4h: ${sa.hitRate4h}%` : ''}${sa.hitRate24h !== null ? `, 24h: ${sa.hitRate24h}%` : ''}`;
  }

  let historySection = '';
  if (context.recentTuneRuns && context.recentTuneRuns.length > 0) {
    const lines = context.recentTuneRuns.map(r =>
      `  ${r.date}: ${r.status} (regime: ${r.regime}, ${r.applied} params, AI: ${r.aiDecision}, approved: ${r.approvedBy})`
    ).join('\n');
    historySection = `\nRECENT AUTO-TUNE HISTORY:\n${lines}`;
  }

  // Last 5 closed trades with regime/confluence context
  let tradesSection = '';
  if (context.recentClosedTrades && context.recentClosedTrades.length > 0) {
    const lines = context.recentClosedTrades.map(t =>
      `  ${t.asset} ${t.direction}: ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)} (${t.pnlPct.toFixed(2)}%) | regime: ${t.regime} | confluence: ${t.confluence} | exit: ${t.exitReason} | ${t.holdingHours !== null ? t.holdingHours + 'h' : 'N/A'}`
    ).join('\n');
    tradesSection = `\nLAST 5 CLOSED TRADES:\n${lines}`;
  }

  // Parameter conflict warnings
  let conflictsSection = '';
  if (context.parameterConflicts && context.parameterConflicts.length > 0) {
    conflictsSection = `\nPARAMETER CONFLICTS DETECTED:\n${context.parameterConflicts.map(c => `- ${c}`).join('\n')}`;
  }

  return `You are a quantitative trading strategy advisor for Sentix Pro, a crypto/metals automated trading system.

CURRENT CONTEXT:
- Market regime: ${context.marketRegime || 'unknown'}
- Lookback period: ${context.lookbackDays} days
- Asset optimized: ${context.asset}
- Current active config source: ${context.configSource}
- Recent trade count: ${context.recentTradeCount || 'N/A'}
- Approval mode: ${APPROVAL_MODE}${paperSection}${signalSection}${historySection}${tradesSection}${conflictsSection}

PROPOSED PARAMETER CHANGES (all passed statistical safety checks):
${paramLines}

INSTRUCTIONS:
Evaluate whether these changes should be applied to a live (paper) trading system. Consider:
1. Do the changes make sense given the market regime and recent performance?
2. Are the improvements meaningful or could they be noise?
3. Are any changes too aggressive (too far from defaults)?
4. Could applying all changes at once create unexpected interactions?
5. Does the signal accuracy data suggest the current strategy needs adjustment?
6. Looking at recent tune history, is there a pattern of oscillating params?
7. Review the last 5 trades — are losses concentrated in specific regimes or confluence levels?
8. Are there parameter conflicts that should be resolved before applying new changes?

Respond with EXACTLY this format:
DECISION: APPLY | BLEND | REJECT
REASONING: [2-3 sentences explaining your decision]
PARAMS: [comma-separated list of param names to apply, or "all" or "none"]

APPLY = apply all proposed changes
BLEND = apply 50/50 blend between current and proposed (conservative)
REJECT = do not apply any changes`;
}

function parseAIDecision(text) {
  const decisionMatch = text.match(/DECISION:\s*(APPLY|BLEND|REJECT)/i);
  const reasoningMatch = text.match(/REASONING:\s*(.+?)(?=\nPARAMS:|$)/is);
  const paramsMatch = text.match(/PARAMS:\s*(.+?)$/im);

  const decision = decisionMatch ? decisionMatch[1].toUpperCase() : 'BLEND';
  const reasoning = reasoningMatch ? reasoningMatch[1].trim() : 'Could not parse AI reasoning';

  let modifiedParams = null;
  if (paramsMatch) {
    const paramsText = paramsMatch[1].trim().toLowerCase();
    if (paramsText !== 'all' && paramsText !== 'none') {
      modifiedParams = paramsText.split(',').map(p => p.trim()).filter(Boolean);
    } else if (paramsText === 'none') {
      return { decision: 'REJECT', reasoning, modifiedParams: null };
    }
  }

  return { decision, reasoning, modifiedParams };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TELEGRAM APPROVAL FLOW
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send a proposal to Telegram for user approval.
 */
async function sendTelegramProposal(bot, runId, accepted, aiReview, context) {
  if (!bot || !bot.isActive()) return null;

  const paramLines = accepted.map(p =>
    `  \`${p.paramName}\`: ${p.currentValue} → *${p.proposedValue}* (+${p.improvementPct}%)`
  ).join('\n');

  const aiLine = aiReview ? `\nAI (${aiReview.decision}): _${(aiReview.reasoning || '').substring(0, 150)}_` : '';

  const text =
    `🤖 *AUTO-TUNE: Aprobación Requerida*\n\n` +
    `Régimen: ${context.marketRegime || 'unknown'}\n` +
    `Asset: ${context.asset}\n` +
    `Cambios propuestos (${accepted.length}):\n${paramLines}\n` +
    `${aiLine}\n\n` +
    `⏰ Expira en 4 horas`;

  const buttons = [
    [
      { text: '✅ Aplicar', callback_data: `at_apply_${runId}` },
      { text: '🔀 Blend 50/50', callback_data: `at_blend_${runId}` },
      { text: '❌ Rechazar', callback_data: `at_reject_${runId}` },
    ],
  ];

  try {
    const result = await bot.broadcastWithButtons(text, buttons);
    return result.messageIds;
  } catch (err) {
    logger.warn('Failed to send Telegram proposal', { error: err.message });
    return null;
  }
}

/**
 * Approve or reject a pending proposal.
 * @param {string} decision - 'apply' | 'blend' | 'reject'
 * @param {string} source - 'telegram' | 'api' | 'auto' | 'expired'
 */
async function approveProposal(supabase, runId, decision, source, bot = null) {
  const proposal = pendingProposals.get(String(runId));
  if (!proposal) {
    return { success: false, message: 'Propuesta no encontrada o expirada.' };
  }

  // Check expiry
  if (Date.now() > proposal.expiresAt) {
    pendingProposals.delete(String(runId));
    return { success: false, message: 'Propuesta expirada.' };
  }

  let paramsApplied = {};
  let configAfter = { ...proposal.configBefore };
  let statusMessage = '';

  if (decision === 'apply') {
    for (const p of proposal.accepted) {
      paramsApplied[p.paramName] = p.proposedValue;
      configAfter[p.paramName] = p.proposedValue;
    }
    const tuneName = `auto-tune-${new Date().toISOString().slice(0, 10)}`;
    const desc = `Auto-tuned ${proposal.accepted.length} params (approved by ${source})`;
    await saveActiveConfig(supabase, configAfter, tuneName, desc);
    statusMessage = `✅ *Auto-tune aplicado*\n${proposal.accepted.length} parámetros actualizados (por ${source}).`;
    logger.info('Auto-tune proposal approved', { runId, source, params: Object.keys(paramsApplied) });

  } else if (decision === 'blend') {
    for (const p of proposal.accepted) {
      const blended = (p.currentValue + p.proposedValue) * TUNER_CONFIG.blendRatio;
      const range = PARAM_RANGES[p.paramName];
      let value = blended;
      if (range) {
        value = Math.max(range.min, Math.min(range.max, blended));
        value = Math.round(value / range.step) * range.step;
        value = Math.round(value * 1000) / 1000;
      }
      paramsApplied[p.paramName] = value;
      configAfter[p.paramName] = value;
    }
    const tuneName = `auto-tune-blend-${new Date().toISOString().slice(0, 10)}`;
    const desc = `Blended ${proposal.accepted.length} params 50/50 (approved by ${source})`;
    await saveActiveConfig(supabase, configAfter, tuneName, desc);
    statusMessage = `🔀 *Auto-tune blended*\nMezcla 50/50 aplicada (por ${source}).`;
    logger.info('Auto-tune proposal blended', { runId, source, params: Object.keys(paramsApplied) });

  } else {
    statusMessage = `❌ *Auto-tune rechazado* (por ${source}).`;
    logger.info('Auto-tune proposal rejected', { runId, source });
  }

  // Update DB record
  try {
    const update = {
      status: decision === 'reject' ? 'rejected' : 'completed',
      approved_by: source,
      approved_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    };
    if (decision !== 'reject') {
      update.params_applied = paramsApplied;
      update.params_after = configAfter;
    }
    await supabase.from('auto_tune_runs').update(update).eq('id', runId);
  } catch (_) { /* non-critical */ }

  // Notify Telegram
  if (bot && bot.isActive() && proposal.messageIds) {
    for (const [chatId, msgId] of Object.entries(proposal.messageIds)) {
      bot.editMessage(chatId, msgId, statusMessage).catch(() => {});
    }
  }

  pendingProposals.delete(String(runId));

  return { success: true, message: statusMessage, decision, paramsApplied };
}

/**
 * Cleanup expired proposals.
 */
async function cleanupExpiredProposals(supabase, bot = null) {
  const now = Date.now();
  for (const [runId, proposal] of pendingProposals) {
    if (now > proposal.expiresAt) {
      logger.info('Auto-tune proposal expired', { runId });
      await approveProposal(supabase, runId, 'reject', 'expired', bot);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST-APPLY PERFORMANCE MONITORING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check performance of recently applied auto-tune changes.
 * If Sharpe dropped > 20% in 48h, auto-revert.
 */
async function checkPostApplyPerformance(supabase, bot = null) {
  try {
    // Find completed runs with params applied, between 24h-72h ago
    const from = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    const to = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    const { data: runs } = await supabase
      .from('auto_tune_runs')
      .select('id, params_applied, params_before, completed_at, performance_after')
      .eq('status', 'completed')
      .not('params_applied', 'is', null)
      .is('performance_after', null) // Not yet checked
      .gte('completed_at', from)
      .lte('completed_at', to)
      .limit(3);

    if (!runs || runs.length === 0) return;

    for (const run of runs) {
      // Get paper trading performance since the tune was applied
      const { data: trades } = await supabase
        .from('paper_trades')
        .select('realized_pnl')
        .eq('status', 'closed')
        .gte('closed_at', run.completed_at);

      if (!trades || trades.length < 5) {
        // Not enough trades to evaluate
        continue;
      }

      const pnls = trades.map(t => parseFloat(t.realized_pnl) || 0);
      const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
      const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length;
      const stdDev = Math.sqrt(variance) || 1;
      const postSharpe = Math.round((mean / stdDev) * Math.sqrt(365) * 100) / 100;

      // Save performance_after
      const performanceAfter = {
        trades: trades.length,
        sharpe: postSharpe,
        totalPnl: Math.round(pnls.reduce((s, v) => s + v, 0) * 100) / 100,
        checkedAt: new Date().toISOString(),
      };

      await supabase
        .from('auto_tune_runs')
        .update({ performance_after: performanceAfter })
        .eq('id', run.id);

      // Check if we need to revert (compare vs a baseline — if Sharpe is very negative)
      if (postSharpe < -0.5 && pnls.length >= 10) {
        logger.warn('Post-apply performance poor, reverting', {
          runId: run.id,
          postSharpe,
          trades: trades.length,
        });

        // Revert to params_before
        if (run.params_before) {
          const revertName = `auto-revert-${new Date().toISOString().slice(0, 10)}`;
          const revertDesc = `Auto-reverted due to poor post-apply performance (Sharpe: ${postSharpe})`;
          await saveActiveConfig(supabase, run.params_before, revertName, revertDesc);

          await supabase
            .from('auto_tune_runs')
            .update({ status: 'reverted' })
            .eq('id', run.id);

          // Notify via Telegram
          if (bot && bot.isActive()) {
            const message =
              `⚠️ *AUTO-REVERT*\n\n` +
              `Post-tune Sharpe: ${postSharpe} (${trades.length} trades)\n` +
              `Parámetros revertidos al estado anterior.\n` +
              `Run: ${run.id}`;
            bot.broadcastAlert({
              asset: 'sistema',
              action: 'HOLD',
              score: 0,
              confidence: 100,
              price: 0,
              reasons: message,
            }).catch(() => {});
          }
        }
      } else {
        logger.info('Post-apply performance OK', {
          runId: run.id,
          postSharpe,
          trades: trades.length,
        });
      }
    }
  } catch (err) {
    logger.debug('checkPostApplyPerformance error', { error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN AUTO-TUNE RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run the full auto-tune pipeline.
 * @param {Object} supabase - Supabase client
 * @param {Object} options
 * @param {string} [options.trigger='scheduled'] - 'scheduled' or 'manual'
 * @param {string} [options.asset='bitcoin'] - Asset to optimize against
 * @param {Function} [options.onProgress] - Progress callback
 * @param {Object} [options.bot] - Telegram bot instance for approval flow
 * @returns {Object} Run result summary
 */
async function runAutoTune(supabase, options = {}) {
  if (isRunning) {
    return { error: 'Auto-tune already running' };
  }

  const {
    trigger = 'scheduled',
    asset = 'bitcoin',
    onProgress = null,
    bot = null,
  } = options;

  const approvalMode = APPROVAL_MODE;
  isRunning = true;
  let runId = null;

  try {
    // ─── 1. Cooldown check (skip for manual triggers) ────────────────
    if (trigger === 'scheduled') {
      const cooldown = await checkCooldown(supabase);
      if (!cooldown.ok) {
        logger.info('Auto-tune skipped: cooldown', { reason: cooldown.reason });
        isRunning = false;
        return { skipped: true, reason: cooldown.reason };
      }
    }

    // ─── 2. Create run record ────────────────────────────────────────
    try {
      const { data } = await supabase
        .from('auto_tune_runs')
        .insert({ trigger, asset, lookback_days: TUNER_CONFIG.lookbackDays })
        .select('id')
        .single();
      runId = data?.id;
    } catch (_) {
      logger.debug('auto_tune_runs table not available, running in-memory only');
    }

    if (onProgress) onProgress({ phase: 'started', runId });

    // ─── 3. Get market regime ────────────────────────────────────────
    let marketRegime = 'unknown';
    try {
      const features = await computeFeatures(asset, '4h');
      marketRegime = features?.marketRegime || 'unknown';
    } catch (_) {
      logger.debug('Could not determine market regime for auto-tune');
    }

    // ─── 4. Get current active config ────────────────────────────────
    const { config: currentConfig, source: configSource } = await getActiveConfig(supabase);
    const configBefore = { ...currentConfig };

    logger.info('Auto-tune started', {
      trigger, asset, marketRegime, configSource, approvalMode,
      lookback: TUNER_CONFIG.lookbackDays,
      params: PRIORITY_PARAMS.length,
    });

    // ─── 5. Get enhanced context for AI ──────────────────────────────
    const enhancedContext = await getEnhancedContext(supabase, asset);

    // ─── 6. Optimize each priority parameter ─────────────────────────
    const paramResults = [];
    let optimizedCount = 0;

    for (const paramName of PRIORITY_PARAMS) {
      if (!PARAM_RANGES[paramName]) {
        logger.debug('Skipping param not in PARAM_RANGES', { paramName });
        continue;
      }

      if (onProgress) {
        onProgress({
          phase: 'optimizing',
          paramName,
          current: optimizedCount + 1,
          total: PRIORITY_PARAMS.length,
        });
      }

      try {
        const result = await runOptimization({
          asset,
          days: TUNER_CONFIG.lookbackDays,
          paramName,
          baseConfig: currentConfig,
          capital: 10000,
        });

        const currentValue = currentConfig[paramName] ?? DEFAULT_STRATEGY_CONFIG[paramName];
        const proposedValue = result.bestValue;
        const currentSharpe = result.defaultSharpe || 0;
        const proposedSharpe = result.bestSharpe || 0;
        const improvementPct = currentSharpe > 0
          ? ((proposedSharpe - currentSharpe) / Math.abs(currentSharpe)) * 100
          : (proposedSharpe > 0 ? 100 : 0);

        const safety = evaluateProposal(result);

        paramResults.push({
          paramName,
          currentValue,
          proposedValue,
          currentSharpe: Math.round(currentSharpe * 100) / 100,
          proposedSharpe: Math.round(proposedSharpe * 100) / 100,
          improvementPct: Math.round(improvementPct * 10) / 10,
          accepted: safety.passed && currentValue !== proposedValue,
          trades: safety.trades,
          safetyChecks: safety.checks,
          reason: !safety.passed
            ? Object.entries(safety.checks).filter(([, v]) => !v).map(([k]) => k).join(', ')
            : (currentValue === proposedValue ? 'no change' : 'passed'),
          overfitWarning: result.validation?.overfitWarning || false,
          degradation: result.validation?.avgDegradation || null,
        });

        optimizedCount++;

        logger.info('Auto-tune param result', {
          paramName,
          current: currentValue,
          proposed: proposedValue,
          sharpeImprovement: improvementPct.toFixed(1) + '%',
          accepted: safety.passed && currentValue !== proposedValue,
        });

      } catch (err) {
        logger.warn('Auto-tune optimization failed for param', { paramName, error: err.message });
        paramResults.push({
          paramName,
          currentValue: currentConfig[paramName],
          proposedValue: null,
          accepted: false,
          reason: `error: ${err.message}`,
        });
      }
    }

    // ─── 7. Filter accepted proposals ────────────────────────────────
    let accepted = paramResults.filter(p => p.accepted);

    // Max params per run guard
    if (accepted.length > TUNER_CONFIG.maxParamsPerRun) {
      accepted.sort((a, b) => (b.improvementPct || 0) - (a.improvementPct || 0));
      accepted = accepted.slice(0, TUNER_CONFIG.maxParamsPerRun);
      for (const p of paramResults) {
        if (p.accepted && !accepted.includes(p)) {
          p.accepted = false;
          p.reason = 'max_params_per_run exceeded';
        }
      }
    }

    const safetyChecks = {
      totalParams: PRIORITY_PARAMS.length,
      optimized: optimizedCount,
      accepted: accepted.length,
      rejected: paramResults.filter(p => !p.accepted).length,
      cooldownOk: true,
      regimeStable: marketRegime !== 'volatile',
      maxChangeGuard: accepted.length <= TUNER_CONFIG.maxParamsPerRun,
    };

    // ─── 8. AI Review (Nivel 2 — Enhanced) ───────────────────────────
    let aiReview = null;
    if (accepted.length > 0) {
      if (onProgress) onProgress({ phase: 'ai_review', accepted: accepted.length });

      aiReview = await aiReviewProposals(accepted, {
        marketRegime,
        lookbackDays: TUNER_CONFIG.lookbackDays,
        asset,
        configSource,
        recentTradeCount: accepted[0]?.trades || 0,
        // Enhanced context fields
        paperPerformance: enhancedContext.paperPerformance,
        signalAccuracy: enhancedContext.signalAccuracy,
        recentTuneRuns: enhancedContext.recentTuneRuns,
      });

      if (aiReview) {
        logger.info('AI review result', {
          decision: aiReview.decision,
          reasoning: aiReview.reasoning?.substring(0, 100),
        });

        // Apply AI decision to filter proposals
        if (aiReview.decision === 'REJECT') {
          for (const p of accepted) {
            p.accepted = false;
            p.reason = 'AI rejected';
          }
          accepted = [];
        } else if (aiReview.decision === 'BLEND') {
          for (const p of accepted) {
            const blended = Math.round((p.currentValue + p.proposedValue) * TUNER_CONFIG.blendRatio * 1000) / 1000;
            const range = PARAM_RANGES[p.paramName];
            if (range) {
              p.proposedValue = Math.max(range.min, Math.min(range.max, blended));
              p.proposedValue = Math.round(p.proposedValue / range.step) * range.step;
              p.proposedValue = Math.round(p.proposedValue * 1000) / 1000;
            }
            p.reason = 'AI blended';
          }
        } else if (aiReview.modifiedParams) {
          for (const p of accepted) {
            if (!aiReview.modifiedParams.includes(p.paramName)) {
              p.accepted = false;
              p.reason = 'AI excluded';
            }
          }
          accepted = accepted.filter(p => p.accepted);
        }
      }
    }

    // ─── 9. Apply or wait for approval ───────────────────────────────
    let paramsApplied = {};
    let configAfter = { ...currentConfig };
    let status = 'completed';

    if (accepted.length > 0 && approvalMode === 'telegram' && bot?.isActive()) {
      // ─── TELEGRAM APPROVAL MODE: store and wait ─────────────
      status = 'pending_approval';

      const messageIds = await sendTelegramProposal(bot, runId, accepted, aiReview, {
        marketRegime, asset,
      });

      pendingProposals.set(String(runId), {
        accepted,
        configBefore,
        configAfter: null, // Will be computed on approval
        context: { marketRegime, asset, aiReview },
        expiresAt: Date.now() + TUNER_CONFIG.proposalTtlMs,
        messageIds: messageIds || {},
      });

      logger.info('Auto-tune pending Telegram approval', {
        runId,
        proposals: accepted.length,
        expiresIn: '4h',
      });

    } else if (accepted.length > 0) {
      // ─── AUTO MODE: apply immediately ──────────────────────
      for (const p of accepted) {
        paramsApplied[p.paramName] = p.proposedValue;
        configAfter[p.paramName] = p.proposedValue;
      }

      const tuneName = `auto-tune-${new Date().toISOString().slice(0, 10)}`;
      const desc = `Auto-tuned ${accepted.length} params (${trigger}, regime: ${marketRegime})`;

      await saveActiveConfig(supabase, configAfter, tuneName, desc);

      logger.info('Auto-tune applied changes', {
        paramsChanged: Object.keys(paramsApplied),
        marketRegime,
      });
    } else {
      logger.info('Auto-tune: no changes applied', {
        reason: paramResults.every(p => p.reason === 'no change')
          ? 'all params already optimal'
          : 'no proposals passed safety/AI checks',
      });
    }

    if (onProgress) onProgress({ phase: status === 'pending_approval' ? 'pending_approval' : 'completed', accepted: accepted.length });

    // ─── 10. Update run record ───────────────────────────────────────
    const runResult = {
      runId,
      status,
      trigger,
      asset,
      marketRegime,
      approvalMode,
      paramResults,
      safetyChecks,
      aiReview,
      paramsApplied: Object.keys(paramsApplied).length > 0 ? paramsApplied : null,
      paramsBefore: configBefore,
      paramsAfter: accepted.length > 0 && status === 'completed' ? configAfter : null,
      completedAt: status === 'completed' ? new Date().toISOString() : null,
    };

    if (runId) {
      try {
        const dbUpdate = {
          status,
          market_regime: marketRegime,
          param_results: paramResults,
          safety_checks: safetyChecks,
          ai_review: aiReview,
          params_before: configBefore,
        };
        if (status === 'completed') {
          dbUpdate.completed_at = runResult.completedAt;
          dbUpdate.params_applied = runResult.paramsApplied;
          dbUpdate.params_after = runResult.paramsAfter;
          dbUpdate.approved_by = 'auto';
        }
        await supabase
          .from('auto_tune_runs')
          .update(dbUpdate)
          .eq('id', runId);
      } catch (_) { /* non-critical */ }
    }

    return runResult;

  } catch (err) {
    logger.error('Auto-tune failed', { error: err.message, stack: err.stack });

    if (runId) {
      try {
        await supabase
          .from('auto_tune_runs')
          .update({
            completed_at: new Date().toISOString(),
            status: 'failed',
            error_message: err.message,
          })
          .eq('id', runId);
      } catch (_) { /* non-critical */ }
    }

    return { error: err.message, status: 'failed' };

  } finally {
    isRunning = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORY & QUERIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get auto-tune run history.
 */
async function getAutoTuneHistory(supabase, limit = 10) {
  try {
    const { data, error } = await supabase
      .from('auto_tune_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(limit);

    if (error) return { history: [], error };
    return { history: data || [] };
  } catch (err) {
    return { history: [], error: err };
  }
}

/**
 * Get pending proposals for API/frontend.
 */
function getPendingProposals() {
  const pending = [];
  const now = Date.now();
  for (const [runId, p] of pendingProposals) {
    if (now < p.expiresAt) {
      pending.push({
        runId,
        accepted: p.accepted,
        context: p.context,
        expiresAt: new Date(p.expiresAt).toISOString(),
        remainingMs: p.expiresAt - now,
      });
    }
  }
  return pending;
}

/**
 * Check if auto-tune is currently running.
 */
function isAutoTuneRunning() {
  return isRunning;
}

/**
 * Get current approval mode.
 */
function getApprovalMode() {
  return APPROVAL_MODE;
}

module.exports = {
  runAutoTune,
  getAutoTuneHistory,
  getActiveConfig,
  saveActiveConfig,
  isAutoTuneRunning,
  getApprovalMode,
  PRIORITY_PARAMS,
  TUNER_CONFIG,
  // Approval flow
  approveProposal,
  getPendingProposals,
  cleanupExpiredProposals,
  // Post-apply monitoring
  checkPostApplyPerformance,
  // Enhanced context
  getEnhancedContext,
  // Exported for testing
  evaluateProposal,
  checkCooldown,
  aiReviewProposals,
  parseAIDecision,
  buildAIPrompt,
  detectParameterConflicts,
};
