-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration 023: Re-enable Row Level Security with proper policies
--
-- Strategy:
--   • Backend uses service_role key → bypasses RLS automatically
--   • Frontend/anon key (if ever used) → policies enforce user isolation
--   • This provides defense-in-depth: even if an API endpoint has a bug
--     that fails to validate userId, the database itself blocks cross-user reads.
--
-- Policy pattern:
--   SELECT/UPDATE/DELETE → USING (auth.uid()::TEXT = user_id)
--   INSERT              → WITH CHECK (auth.uid()::TEXT = user_id)
--   Service role key bypasses ALL policies (Supabase default behavior).
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── WALLETS ─────────────────────────────────────────────────────────────────
ALTER TABLE IF EXISTS wallets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wallets_select_own" ON wallets;
CREATE POLICY "wallets_select_own" ON wallets
  FOR SELECT USING (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "wallets_insert_own" ON wallets;
CREATE POLICY "wallets_insert_own" ON wallets
  FOR INSERT WITH CHECK (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "wallets_update_own" ON wallets;
CREATE POLICY "wallets_update_own" ON wallets
  FOR UPDATE USING (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "wallets_delete_own" ON wallets;
CREATE POLICY "wallets_delete_own" ON wallets
  FOR DELETE USING (auth.uid()::TEXT = user_id);

-- ─── PORTFOLIOS ──────────────────────────────────────────────────────────────
ALTER TABLE IF EXISTS portfolios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "portfolios_select_own" ON portfolios;
CREATE POLICY "portfolios_select_own" ON portfolios
  FOR SELECT USING (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "portfolios_insert_own" ON portfolios;
CREATE POLICY "portfolios_insert_own" ON portfolios
  FOR INSERT WITH CHECK (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "portfolios_update_own" ON portfolios;
CREATE POLICY "portfolios_update_own" ON portfolios
  FOR UPDATE USING (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "portfolios_delete_own" ON portfolios;
CREATE POLICY "portfolios_delete_own" ON portfolios
  FOR DELETE USING (auth.uid()::TEXT = user_id);

-- ─── WALLET SNAPSHOTS ────────────────────────────────────────────────────────
ALTER TABLE IF EXISTS wallet_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "snapshots_select_own" ON wallet_snapshots;
CREATE POLICY "snapshots_select_own" ON wallet_snapshots
  FOR SELECT USING (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "snapshots_insert_own" ON wallet_snapshots;
CREATE POLICY "snapshots_insert_own" ON wallet_snapshots
  FOR INSERT WITH CHECK (auth.uid()::TEXT = user_id);

-- ─── PAPER CONFIG ────────────────────────────────────────────────────────────
ALTER TABLE IF EXISTS paper_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "paper_config_select_own" ON paper_config;
CREATE POLICY "paper_config_select_own" ON paper_config
  FOR SELECT USING (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "paper_config_insert_own" ON paper_config;
CREATE POLICY "paper_config_insert_own" ON paper_config
  FOR INSERT WITH CHECK (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "paper_config_update_own" ON paper_config;
CREATE POLICY "paper_config_update_own" ON paper_config
  FOR UPDATE USING (auth.uid()::TEXT = user_id);

-- ─── PAPER TRADES ────────────────────────────────────────────────────────────
ALTER TABLE IF EXISTS paper_trades ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "paper_trades_select_own" ON paper_trades;
CREATE POLICY "paper_trades_select_own" ON paper_trades
  FOR SELECT USING (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "paper_trades_insert_own" ON paper_trades;
CREATE POLICY "paper_trades_insert_own" ON paper_trades
  FOR INSERT WITH CHECK (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "paper_trades_update_own" ON paper_trades;
CREATE POLICY "paper_trades_update_own" ON paper_trades
  FOR UPDATE USING (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "paper_trades_delete_own" ON paper_trades;
CREATE POLICY "paper_trades_delete_own" ON paper_trades
  FOR DELETE USING (auth.uid()::TEXT = user_id);

-- ─── PAPER EQUITY SNAPSHOTS ─────────────────────────────────────────────────
ALTER TABLE IF EXISTS paper_equity_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "equity_snapshots_select_own" ON paper_equity_snapshots;
CREATE POLICY "equity_snapshots_select_own" ON paper_equity_snapshots
  FOR SELECT USING (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "equity_snapshots_insert_own" ON paper_equity_snapshots;
CREATE POLICY "equity_snapshots_insert_own" ON paper_equity_snapshots
  FOR INSERT WITH CHECK (auth.uid()::TEXT = user_id);

-- ─── ORDERS ──────────────────────────────────────────────────────────────────
ALTER TABLE IF EXISTS orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "orders_select_own" ON orders;
CREATE POLICY "orders_select_own" ON orders
  FOR SELECT USING (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "orders_insert_own" ON orders;
CREATE POLICY "orders_insert_own" ON orders
  FOR INSERT WITH CHECK (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "orders_update_own" ON orders;
CREATE POLICY "orders_update_own" ON orders
  FOR UPDATE USING (auth.uid()::TEXT = user_id);

-- ─── BACKTEST RESULTS ────────────────────────────────────────────────────────
ALTER TABLE IF EXISTS backtest_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "backtest_select_own" ON backtest_results;
CREATE POLICY "backtest_select_own" ON backtest_results
  FOR SELECT USING (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "backtest_insert_own" ON backtest_results;
CREATE POLICY "backtest_insert_own" ON backtest_results
  FOR INSERT WITH CHECK (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "backtest_delete_own" ON backtest_results;
CREATE POLICY "backtest_delete_own" ON backtest_results
  FOR DELETE USING (auth.uid()::TEXT = user_id);

-- ─── ALERT FILTERS ──────────────────────────────────────────────────────────
ALTER TABLE IF EXISTS alert_filters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "alert_filters_select_own" ON alert_filters;
CREATE POLICY "alert_filters_select_own" ON alert_filters
  FOR SELECT USING (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "alert_filters_insert_own" ON alert_filters;
CREATE POLICY "alert_filters_insert_own" ON alert_filters
  FOR INSERT WITH CHECK (auth.uid()::TEXT = user_id);

DROP POLICY IF EXISTS "alert_filters_update_own" ON alert_filters;
CREATE POLICY "alert_filters_update_own" ON alert_filters
  FOR UPDATE USING (auth.uid()::TEXT = user_id);

-- ─── AUDIT LOG ───────────────────────────────────────────────────────────────
-- Audit log: users can read their own entries, only service_role can insert
ALTER TABLE IF EXISTS audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_log_select_own" ON audit_log;
CREATE POLICY "audit_log_select_own" ON audit_log
  FOR SELECT USING (auth.uid() = user_id);

-- ─── USER PROFILES ──────────────────────────────────────────────────────────
-- user_profiles uses id (UUID) matching auth.uid() directly (not user_id TEXT)
ALTER TABLE IF EXISTS user_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_own" ON user_profiles;
CREATE POLICY "profiles_select_own" ON user_profiles
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON user_profiles;
CREATE POLICY "profiles_update_own" ON user_profiles
  FOR UPDATE USING (auth.uid() = id);

-- ─── GLOBAL TABLES (read-only for authenticated users) ──────────────────────
-- Signals and alerts are global — any authenticated user can read them

ALTER TABLE IF EXISTS signals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "signals_select_authenticated" ON signals;
CREATE POLICY "signals_select_authenticated" ON signals
  FOR SELECT USING (auth.role() = 'authenticated');

ALTER TABLE IF EXISTS alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "alerts_select_authenticated" ON alerts;
CREATE POLICY "alerts_select_authenticated" ON alerts
  FOR SELECT USING (auth.role() = 'authenticated');

ALTER TABLE IF EXISTS signal_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "signal_outcomes_select_authenticated" ON signal_outcomes;
CREATE POLICY "signal_outcomes_select_authenticated" ON signal_outcomes
  FOR SELECT USING (auth.role() = 'authenticated');

-- ─── EXECUTION LOG ──────────────────────────────────────────────────────────
-- execution_log has no user_id — access is controlled via orders JOIN
-- Only service_role inserts; users read via API (which filters by their orders)
ALTER TABLE IF EXISTS execution_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "execution_log_select_via_order" ON execution_log;
CREATE POLICY "execution_log_select_via_order" ON execution_log
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM orders
      WHERE orders.id = execution_log.order_id
        AND orders.user_id = auth.uid()::TEXT
    )
  );
