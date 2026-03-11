-- ═══════════════════════════════════════════════════════════════════════════════
-- Paper Trading: Real-time equity curve snapshots
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.paper_equity_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL DEFAULT 'default-user',
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT now(),
  capital     NUMERIC(14, 2) NOT NULL,           -- current_capital (cash)
  unrealized  NUMERIC(14, 2) NOT NULL DEFAULT 0, -- sum of open positions unrealized PnL
  equity      NUMERIC(14, 2) NOT NULL,           -- capital + unrealized
  open_count  SMALLINT NOT NULL DEFAULT 0        -- number of open positions
);

-- Index for efficient time-range queries
CREATE INDEX IF NOT EXISTS idx_equity_snapshots_user_time
  ON public.paper_equity_snapshots (user_id, timestamp DESC);

-- Auto-cleanup: keep only last 7 days of snapshots per user
-- (Run periodically or via Supabase cron extension)
-- DELETE FROM paper_equity_snapshots WHERE timestamp < now() - interval '7 days';

-- Enable RLS (consistent with other tables)
ALTER TABLE public.paper_equity_snapshots ENABLE ROW LEVEL SECURITY;

-- Policy: service_role has full access (backend uses service_role key)
CREATE POLICY "service_role_full_access" ON public.paper_equity_snapshots
  FOR ALL USING (true) WITH CHECK (true);
