-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration 008: Strategy Optimization Results
-- Stores optimization run results for historical comparison
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS optimization_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset TEXT NOT NULL,
  days INTEGER NOT NULL,
  param_name TEXT NOT NULL,
  param_label TEXT,
  default_value NUMERIC,
  best_value NUMERIC,
  best_sharpe NUMERIC,
  default_sharpe NUMERIC,
  improvement NUMERIC,
  results JSONB NOT NULL,          -- Full array of {value, sharpe, pf, winRate, trades, ...}
  base_config JSONB,               -- Base strategy config used
  duration_seconds NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying history by asset and parameter
CREATE INDEX IF NOT EXISTS idx_opt_results_asset ON optimization_results(asset, param_name);
CREATE INDEX IF NOT EXISTS idx_opt_results_created ON optimization_results(created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Optional: Table for saved strategy configs (user can save "best" configs)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS saved_strategy_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  config JSONB NOT NULL,           -- Full strategy config object
  performance JSONB,               -- Summary metrics from backtest with this config
  is_active BOOLEAN DEFAULT false, -- Only one can be active at a time
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
