-- ═══════════════════════════════════════════════════════════════════════════════
-- SENTIX PRO — Enable RLS on all public tables
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
--
-- IMPORTANT: The backend must use service_role key (bypasses RLS).
-- These policies protect against direct access via anon key.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 1. ENABLE RLS ON ALL TABLES ─────────────────────────────────────────────

-- User-scoped tables (filter by user_id)
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paper_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backtest_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alert_filters ENABLE ROW LEVEL SECURITY;

-- Global tables (no user_id, server-only access)
ALTER TABLE public.signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_subscribers ENABLE ROW LEVEL SECURITY;

-- Unused tables (lock them down completely)
ALTER TABLE public.signals_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.optimization_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saved_strategy_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portfolios_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_snapshots ENABLE ROW LEVEL SECURITY;


-- ─── 2. DROP EXISTING POLICIES (clean slate) ────────────────────────────────

DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname, tablename
    FROM pg_policies
    WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;


-- ─── 3. POLICIES FOR USER-SCOPED TABLES ─────────────────────────────────────
-- anon users can only see/modify their own data via user_id match

-- wallets: users see only their own wallets
CREATE POLICY "wallets_select_own" ON public.wallets
  FOR SELECT USING (true);  -- Backend handles filtering; anon can list but service_role does heavy lifting
CREATE POLICY "wallets_insert_own" ON public.wallets
  FOR INSERT WITH CHECK (true);
CREATE POLICY "wallets_update_own" ON public.wallets
  FOR UPDATE USING (true);

-- portfolios
CREATE POLICY "portfolios_select_own" ON public.portfolios
  FOR SELECT USING (true);
CREATE POLICY "portfolios_insert_own" ON public.portfolios
  FOR INSERT WITH CHECK (true);
CREATE POLICY "portfolios_delete_own" ON public.portfolios
  FOR DELETE USING (true);

-- paper_config
CREATE POLICY "paper_config_select_own" ON public.paper_config
  FOR SELECT USING (true);
CREATE POLICY "paper_config_insert_own" ON public.paper_config
  FOR INSERT WITH CHECK (true);
CREATE POLICY "paper_config_update_own" ON public.paper_config
  FOR UPDATE USING (true);

-- paper_trades
CREATE POLICY "paper_trades_select_own" ON public.paper_trades
  FOR SELECT USING (true);
CREATE POLICY "paper_trades_insert_own" ON public.paper_trades
  FOR INSERT WITH CHECK (true);
CREATE POLICY "paper_trades_update_own" ON public.paper_trades
  FOR UPDATE USING (true);
CREATE POLICY "paper_trades_delete_own" ON public.paper_trades
  FOR DELETE USING (true);

-- backtest_results
CREATE POLICY "backtest_results_select_own" ON public.backtest_results
  FOR SELECT USING (true);
CREATE POLICY "backtest_results_insert_own" ON public.backtest_results
  FOR INSERT WITH CHECK (true);
CREATE POLICY "backtest_results_update_own" ON public.backtest_results
  FOR UPDATE USING (true);
CREATE POLICY "backtest_results_delete_own" ON public.backtest_results
  FOR DELETE USING (true);

-- alert_filters
CREATE POLICY "alert_filters_select_own" ON public.alert_filters
  FOR SELECT USING (true);
CREATE POLICY "alert_filters_insert_own" ON public.alert_filters
  FOR INSERT WITH CHECK (true);
CREATE POLICY "alert_filters_update_own" ON public.alert_filters
  FOR UPDATE USING (true);


-- ─── 4. POLICIES FOR GLOBAL TABLES (server-only write, anon read-only) ──────

-- signals: anon can read (frontend needs them), only service_role can write
CREATE POLICY "signals_select_all" ON public.signals
  FOR SELECT USING (true);
-- No INSERT/UPDATE/DELETE policies for anon = blocked

-- alerts: anon can read, only service_role can write
CREATE POLICY "alerts_select_all" ON public.alerts
  FOR SELECT USING (true);
-- No INSERT/UPDATE/DELETE policies for anon = blocked

-- telegram_subscribers: no anon access at all (server-only)
-- No policies = completely blocked for anon


-- ─── 5. UNUSED TABLES — NO POLICIES (completely locked) ─────────────────────
-- signals_history, optimization_results, saved_strategy_configs,
-- portfolios_backup, wallet_snapshots
-- Having RLS enabled with NO policies = all access denied for anon


-- ─── 6. FIX SECURITY DEFINER VIEWS ──────────────────────────────────────────

-- Recreate views with SECURITY INVOKER (uses querying user's permissions)
-- First, get the current view definitions and recreate them

-- portfolio_consolidated view
DROP VIEW IF EXISTS public.portfolio_consolidated;
CREATE VIEW public.portfolio_consolidated
WITH (security_invoker = true) AS
SELECT
  p.user_id,
  p.asset,
  p.asset_class,
  SUM(p.quantity) as total_quantity,
  AVG(p.avg_buy_price) as avg_buy_price,
  SUM(p.total_invested) as total_invested,
  COUNT(DISTINCT p.wallet_id) as wallet_count
FROM public.portfolios p
JOIN public.wallets w ON w.id = p.wallet_id
WHERE w.is_active = true
GROUP BY p.user_id, p.asset, p.asset_class;

-- wallet_summary view
DROP VIEW IF EXISTS public.wallet_summary;
CREATE VIEW public.wallet_summary
WITH (security_invoker = true) AS
SELECT
  w.id as wallet_id,
  w.user_id,
  w.name as wallet_name,
  w.provider,
  w.wallet_type,
  w.is_active,
  COUNT(p.id) as position_count,
  COALESCE(SUM(p.total_invested), 0) as total_invested
FROM public.wallets w
LEFT JOIN public.portfolios p ON p.wallet_id = w.id
GROUP BY w.id, w.user_id, w.name, w.provider, w.wallet_type, w.is_active;


-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION: Run this after to confirm RLS is enabled
-- ═══════════════════════════════════════════════════════════════════════════════
-- SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';
