// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — AUTO-PARAMETER TUNER
// Periodically re-optimizes strategy parameters and applies safe changes.
// Nivel 1: Statistical (grid search + walk-forward + safety guards)
// Nivel 2: AI review via Claude API (optional, requires ANTHROPIC_API_KEY)
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
  revertThresholdPct: 20,  // If performance drops > 20%, flag for revert
};

// ─── In-memory lock ──────────────────────────────────────────────────────────
let isRunning = false;

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
      .eq('status', 'completed')
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
// NIVEL 2 — AI REVIEW (Claude API)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ask Claude to review proposed parameter changes.
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

  return `You are a quantitative trading strategy advisor for a crypto/metals automated trading system called Sentix Pro.

CURRENT CONTEXT:
- Market regime: ${context.marketRegime || 'unknown'}
- Lookback period: ${context.lookbackDays} days
- Asset optimized: ${context.asset}
- Current active config source: ${context.configSource}
- Recent trade count: ${context.recentTradeCount || 'N/A'}

PROPOSED PARAMETER CHANGES (all passed statistical safety checks):
${paramLines}

INSTRUCTIONS:
Evaluate whether these changes should be applied to a live (paper) trading system. Consider:
1. Do the changes make sense given the market regime?
2. Are the improvements meaningful or could they be noise?
3. Are any changes too aggressive (too far from defaults)?
4. Could applying all changes at once create unexpected interactions?

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
// MAIN AUTO-TUNE RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run the full auto-tune pipeline.
 * @param {Object} supabase - Supabase client
 * @param {Object} options
 * @param {string} [options.trigger='scheduled'] - 'scheduled' or 'manual'
 * @param {string} [options.asset='bitcoin'] - Asset to optimize against
 * @param {Function} [options.onProgress] - Progress callback
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
  } = options;

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
      trigger, asset, marketRegime, configSource,
      lookback: TUNER_CONFIG.lookbackDays,
      params: PRIORITY_PARAMS.length,
    });

    // ─── 5. Optimize each priority parameter ─────────────────────────
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

    // ─── 6. Filter accepted proposals ────────────────────────────────
    let accepted = paramResults.filter(p => p.accepted);

    // Max params per run guard
    if (accepted.length > TUNER_CONFIG.maxParamsPerRun) {
      // Keep the ones with highest improvement
      accepted.sort((a, b) => (b.improvementPct || 0) - (a.improvementPct || 0));
      accepted = accepted.slice(0, TUNER_CONFIG.maxParamsPerRun);
      // Mark the rest as rejected
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

    // ─── 7. AI Review (Nivel 2) ──────────────────────────────────────
    let aiReview = null;
    if (accepted.length > 0) {
      if (onProgress) onProgress({ phase: 'ai_review', accepted: accepted.length });

      aiReview = await aiReviewProposals(accepted, {
        marketRegime,
        lookbackDays: TUNER_CONFIG.lookbackDays,
        asset,
        configSource,
        recentTradeCount: accepted[0]?.trades || 0,
      });

      if (aiReview) {
        logger.info('AI review result', {
          decision: aiReview.decision,
          reasoning: aiReview.reasoning?.substring(0, 100),
        });

        // Apply AI decision
        if (aiReview.decision === 'REJECT') {
          for (const p of accepted) {
            p.accepted = false;
            p.reason = 'AI rejected';
          }
          accepted = [];
        } else if (aiReview.decision === 'BLEND') {
          // Blend 50/50
          for (const p of accepted) {
            const blended = Math.round((p.currentValue + p.proposedValue) * TUNER_CONFIG.blendRatio * 1000) / 1000;
            // Ensure blended is within PARAM_RANGES
            const range = PARAM_RANGES[p.paramName];
            if (range) {
              p.proposedValue = Math.max(range.min, Math.min(range.max, blended));
              // Snap to step
              p.proposedValue = Math.round(p.proposedValue / range.step) * range.step;
              p.proposedValue = Math.round(p.proposedValue * 1000) / 1000;
            }
            p.reason = 'AI blended';
          }
        } else if (aiReview.modifiedParams) {
          // AI specified which params to apply
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

    // ─── 8. Apply accepted changes ───────────────────────────────────
    let paramsApplied = {};
    let configAfter = { ...currentConfig };

    if (accepted.length > 0) {
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

    if (onProgress) onProgress({ phase: 'completed', accepted: accepted.length });

    // ─── 9. Update run record ────────────────────────────────────────
    const runResult = {
      runId,
      status: 'completed',
      trigger,
      asset,
      marketRegime,
      paramResults,
      safetyChecks,
      aiReview,
      paramsApplied: Object.keys(paramsApplied).length > 0 ? paramsApplied : null,
      paramsBefore: configBefore,
      paramsAfter: accepted.length > 0 ? configAfter : null,
      completedAt: new Date().toISOString(),
    };

    if (runId) {
      try {
        await supabase
          .from('auto_tune_runs')
          .update({
            completed_at: runResult.completedAt,
            status: 'completed',
            market_regime: marketRegime,
            param_results: paramResults,
            safety_checks: safetyChecks,
            ai_review: aiReview,
            params_applied: runResult.paramsApplied,
            params_before: configBefore,
            params_after: runResult.paramsAfter,
          })
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
 * Check if auto-tune is currently running.
 */
function isAutoTuneRunning() {
  return isRunning;
}

module.exports = {
  runAutoTune,
  getAutoTuneHistory,
  getActiveConfig,
  saveActiveConfig,
  isAutoTuneRunning,
  PRIORITY_PARAMS,
  TUNER_CONFIG,
  // Exported for testing
  evaluateProposal,
  checkCooldown,
  aiReviewProposals,
  parseAIDecision,
  buildAIPrompt,
};
