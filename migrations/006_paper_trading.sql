-- ============================================================================
-- Migration 006: Paper Trading System
-- Adds paper_config and paper_trades tables for simulated trading
-- ============================================================================

-- ─── Paper Trading Configuration ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE,

  -- Capital settings
  initial_capital NUMERIC(20, 2) NOT NULL DEFAULT 10000.00,
  current_capital NUMERIC(20, 2) NOT NULL DEFAULT 10000.00,

  -- Risk settings
  risk_per_trade NUMERIC(5, 4) NOT NULL DEFAULT 0.02,          -- 2% per trade
  max_open_positions INTEGER NOT NULL DEFAULT 3,
  max_daily_loss_percent NUMERIC(5, 4) NOT NULL DEFAULT 0.05,  -- 5% daily max loss
  cooldown_minutes INTEGER NOT NULL DEFAULT 30,

  -- Entry criteria
  min_confluence INTEGER NOT NULL DEFAULT 2,                    -- min timeframes agreeing
  min_rr_ratio NUMERIC(5, 2) NOT NULL DEFAULT 1.50,
  allowed_strength TEXT[] NOT NULL DEFAULT ARRAY['STRONG BUY', 'STRONG SELL'],

  -- State
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  daily_pnl NUMERIC(20, 2) NOT NULL DEFAULT 0.00,
  daily_pnl_reset_at TIMESTAMPTZ DEFAULT NOW(),
  last_trade_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Paper Trades ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS paper_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,

  -- Trade identification
  asset TEXT NOT NULL,
  asset_class TEXT NOT NULL DEFAULT 'crypto',
  direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),

  -- Entry details
  entry_price NUMERIC(20, 8) NOT NULL,
  entry_signal_strength TEXT NOT NULL,
  entry_confidence INTEGER NOT NULL,
  entry_raw_score INTEGER NOT NULL,
  entry_confluence INTEGER NOT NULL DEFAULT 0,
  entry_reasons TEXT,
  entry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Position sizing
  position_size_usd NUMERIC(20, 2) NOT NULL,
  quantity NUMERIC(20, 8) NOT NULL,
  risk_amount NUMERIC(20, 2) NOT NULL,

  -- Levels (from signal tradeLevels)
  stop_loss NUMERIC(20, 8) NOT NULL,
  take_profit_1 NUMERIC(20, 8) NOT NULL,
  take_profit_2 NUMERIC(20, 8),
  trailing_stop_initial NUMERIC(20, 8),
  trailing_stop_current NUMERIC(20, 8),
  trailing_activation NUMERIC(20, 8),
  trailing_active BOOLEAN DEFAULT false,

  -- Status
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial', 'closed')),

  -- Partial close tracking (TP1 hit = close 50%)
  partial_close_price NUMERIC(20, 8),
  partial_close_quantity NUMERIC(20, 8),
  partial_close_pnl NUMERIC(20, 2),
  partial_close_at TIMESTAMPTZ,
  remaining_quantity NUMERIC(20, 8),

  -- Exit details (final close)
  exit_price NUMERIC(20, 8),
  exit_reason TEXT CHECK (exit_reason IN (
    'stop_loss', 'take_profit_1', 'take_profit_2',
    'trailing_stop', 'manual', 'max_daily_loss', NULL
  )),
  exit_at TIMESTAMPTZ,

  -- P&L
  realized_pnl NUMERIC(20, 2),
  realized_pnl_percent NUMERIC(10, 4),
  peak_price NUMERIC(20, 8),
  max_favorable NUMERIC(20, 2),
  max_adverse NUMERIC(20, 2),

  -- Metadata
  signal_snapshot JSONB,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_paper_trades_user_status ON paper_trades(user_id, status);
CREATE INDEX IF NOT EXISTS idx_paper_trades_user_asset ON paper_trades(user_id, asset);
CREATE INDEX IF NOT EXISTS idx_paper_trades_entry_at ON paper_trades(entry_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_trades_exit_at ON paper_trades(exit_at DESC);

-- ─── RLS (disabled for service key access, same as existing tables) ──────────
ALTER TABLE paper_config DISABLE ROW LEVEL SECURITY;
ALTER TABLE paper_trades DISABLE ROW LEVEL SECURITY;

-- ─── Updated_at triggers ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER paper_config_updated_at
  BEFORE UPDATE ON paper_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER paper_trades_updated_at
  BEFORE UPDATE ON paper_trades
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
