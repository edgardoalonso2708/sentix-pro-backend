-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration 012: Auto-Parameter Tuning History
-- Tracks automated optimization runs, safety checks, AI reviews, and applied changes
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS auto_tune_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running',     -- running / completed / failed
  trigger         TEXT NOT NULL DEFAULT 'scheduled',   -- scheduled / manual

  -- Optimization context
  asset           TEXT NOT NULL DEFAULT 'bitcoin',
  lookback_days   INTEGER NOT NULL DEFAULT 60,
  market_regime   TEXT,                                -- trending_up / trending_down / ranging / volatile

  -- Results per parameter
  -- [{paramName, currentValue, proposedValue, currentSharpe, proposedSharpe, improvementPct, accepted, reason}]
  param_results   JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Safety checks summary
  -- {minTrades, overfitCheck, degradationCheck, maxChangeGuard, cooldownOk, regimeStable}
  safety_checks   JSONB,

  -- AI review (Nivel 2 — only when ANTHROPIC_API_KEY configured)
  -- {decision: APPLY|BLEND|REJECT, reasoning, model, inputTokens, outputTokens}
  ai_review       JSONB,

  -- Applied parameter changes
  params_applied  JSONB,                               -- {paramName: newValue, ...}
  params_before   JSONB,                               -- full config snapshot before
  params_after    JSONB,                               -- full config snapshot after

  -- Performance delta (populated by next run for comparison)
  performance_before JSONB,
  performance_after  JSONB,

  -- Error info (if status = 'failed')
  error_message   TEXT
);

-- Query patterns: recent runs, status filter
CREATE INDEX IF NOT EXISTS idx_auto_tune_started
  ON auto_tune_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_auto_tune_status
  ON auto_tune_runs (status, started_at DESC);

-- RLS
ALTER TABLE auto_tune_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access" ON auto_tune_runs
  FOR ALL USING (true) WITH CHECK (true);
