-- ═══════════════════════════════════════════════════════════════════════════════
-- 016: Risk Engine Enhancements
-- Adds drawdown circuit breaker, kill switch config, auto-execute toggle,
-- and execution mode to paper_config for the new risk engine.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Max portfolio drawdown from equity peak before halting new trades
ALTER TABLE paper_config ADD COLUMN IF NOT EXISTS max_drawdown_pct NUMERIC(5,4) DEFAULT 0.15;

-- Whether kill switch should also close all open positions
ALTER TABLE paper_config ADD COLUMN IF NOT EXISTS kill_switch_close_positions BOOLEAN DEFAULT false;

-- Auto-execute validated orders (true) or require manual approval (false)
ALTER TABLE paper_config ADD COLUMN IF NOT EXISTS auto_execute BOOLEAN DEFAULT true;

-- Execution mode: paper (simulated) or live (real exchange — future)
ALTER TABLE paper_config ADD COLUMN IF NOT EXISTS execution_mode TEXT DEFAULT 'paper'
  CHECK (execution_mode IN ('paper', 'live'));
