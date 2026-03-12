-- ═══════════════════════════════════════════════════════════════════════════════
-- 014: Regime & Confluence Outcome Tracking
-- Adds regime column to signal_outcomes and explicit regime/confluence fields
-- to paper_trades for cross-dimensional performance analysis.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add market regime at signal generation time
ALTER TABLE signal_outcomes ADD COLUMN IF NOT EXISTS regime TEXT;

-- Add explicit regime + confluence level to paper trades
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS entry_regime TEXT;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS entry_confluence_level TEXT;

-- Composite index for regime × confluence queries (signal accuracy)
CREATE INDEX IF NOT EXISTS idx_signal_outcomes_regime_confluence
  ON signal_outcomes (regime, confluence, signal_generated_at DESC);

-- Index for paper trade regime analysis
CREATE INDEX IF NOT EXISTS idx_paper_trades_regime
  ON paper_trades (entry_regime, status);
