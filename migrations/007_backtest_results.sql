-- ============================================================================
-- Migration 007: Backtest Results
-- Stores backtest configurations and results for historical signal validation
-- ============================================================================

CREATE TABLE IF NOT EXISTS backtest_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,

  -- Configuration used
  asset TEXT NOT NULL,
  days INTEGER NOT NULL,
  step_interval TEXT NOT NULL DEFAULT '4h',
  initial_capital NUMERIC(20, 2) NOT NULL DEFAULT 10000.00,
  risk_per_trade NUMERIC(5, 4) NOT NULL DEFAULT 0.02,
  max_open_positions INTEGER NOT NULL DEFAULT 3,
  min_confluence INTEGER NOT NULL DEFAULT 2,
  min_rr_ratio NUMERIC(5, 2) NOT NULL DEFAULT 1.50,
  allowed_strength TEXT[] NOT NULL DEFAULT ARRAY['STRONG BUY', 'STRONG SELL'],

  -- Summary results
  total_trades INTEGER,
  win_count INTEGER,
  loss_count INTEGER,
  win_rate NUMERIC(5, 2),
  total_pnl NUMERIC(20, 2),
  total_pnl_percent NUMERIC(10, 4),
  max_drawdown NUMERIC(20, 2),
  max_drawdown_percent NUMERIC(10, 4),
  profit_factor NUMERIC(10, 4),
  sharpe_ratio NUMERIC(10, 4),
  avg_holding_hours NUMERIC(10, 2),

  -- Detailed data (JSONB for flexibility)
  trades JSONB,                -- Array of individual trade details
  equity_curve JSONB,          -- Array of { timestamp, equity } points
  metrics JSONB,               -- Full metrics object

  -- Status tracking
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  progress INTEGER DEFAULT 0,  -- 0-100 percentage
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_backtest_user ON backtest_results(user_id);
CREATE INDEX IF NOT EXISTS idx_backtest_asset ON backtest_results(asset);
CREATE INDEX IF NOT EXISTS idx_backtest_created ON backtest_results(created_at DESC);

-- ─── RLS (disabled for service key access) ───────────────────────────────────
ALTER TABLE backtest_results DISABLE ROW LEVEL SECURITY;
