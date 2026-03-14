-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration 022: Missing Indexes for Performance
-- Adds indexes on frequently queried columns that lacked dedicated indexes.
-- All CREATE INDEX IF NOT EXISTS — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════════

-- paper_trades: filtered by (user_id, status) for open-position queries
CREATE INDEX IF NOT EXISTS idx_paper_trades_user_status
  ON paper_trades (user_id, status);

-- paper_trades: sorted by entry_at for trade history pagination
CREATE INDEX IF NOT EXISTS idx_paper_trades_entry_at
  ON paper_trades (entry_at DESC);

-- orders: filtered by (user_id, status) for active-order queries
CREATE INDEX IF NOT EXISTS idx_orders_user_status
  ON orders (user_id, status);

-- orders: sorted by created_at for order history
CREATE INDEX IF NOT EXISTS idx_orders_created_at
  ON orders (created_at DESC);

-- orders: lookup by asset + status (e.g. duplicate-trade check in riskEngine)
CREATE INDEX IF NOT EXISTS idx_orders_asset_status
  ON orders (asset, status);

-- signals: sorted by generated_at for latest-signal queries
CREATE INDEX IF NOT EXISTS idx_signals_generated_at
  ON signals (generated_at DESC);

-- execution_log: lookup by order_id (FK join from orders)
CREATE INDEX IF NOT EXISTS idx_execution_log_order_id
  ON execution_log (order_id);

-- execution_log: filtered by event_type + time for audit queries
CREATE INDEX IF NOT EXISTS idx_execution_log_event_type_time
  ON execution_log (event_type, created_at DESC);

-- audit_log: filtered by user_id for per-user audit trail
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id
  ON audit_log (user_id);

-- audit_log: sorted by created_at for chronological queries
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
  ON audit_log (created_at DESC);

-- signal_outcomes: lookup by asset + time for accuracy calculations
CREATE INDEX IF NOT EXISTS idx_signal_outcomes_asset_time
  ON signal_outcomes (asset, signal_generated_at DESC);
