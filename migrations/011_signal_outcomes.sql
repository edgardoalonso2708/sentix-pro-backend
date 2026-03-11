-- =============================================================================
-- Signal Accuracy Tracking: Append-only signal outcomes table
-- Records each BUY/SELL signal and tracks price movement at 1h, 4h, 24h
-- Run this in Supabase SQL Editor
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.signal_outcomes (
  id                    BIGSERIAL PRIMARY KEY,
  asset                 TEXT NOT NULL,
  action                TEXT NOT NULL,            -- 'BUY' or 'SELL'
  strength_label        TEXT NOT NULL,            -- 'STRONG BUY', 'BUY', 'SELL', 'STRONG SELL'
  raw_score             INTEGER NOT NULL DEFAULT 0,
  confidence            INTEGER NOT NULL DEFAULT 0,
  confluence            TEXT,                     -- 'strong'/'moderate'/'weak'/'conflicting'
  price_at_signal       NUMERIC(18, 8) NOT NULL,  -- price when signal was generated

  -- Filled in later by checker
  price_1h              NUMERIC(18, 8),
  price_4h              NUMERIC(18, 8),
  price_24h             NUMERIC(18, 8),

  direction_correct_1h  BOOLEAN,
  direction_correct_4h  BOOLEAN,
  direction_correct_24h BOOLEAN,

  change_pct_1h         NUMERIC(8, 4),            -- % change at 1h
  change_pct_4h         NUMERIC(8, 4),
  change_pct_24h        NUMERIC(8, 4),

  signal_generated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for efficient time-range queries
CREATE INDEX IF NOT EXISTS idx_signal_outcomes_asset_time
  ON public.signal_outcomes (asset, signal_generated_at DESC);

-- Partial indexes for the checker: find rows where price_Xh is still NULL
CREATE INDEX IF NOT EXISTS idx_signal_outcomes_pending_1h
  ON public.signal_outcomes (signal_generated_at)
  WHERE price_1h IS NULL;

CREATE INDEX IF NOT EXISTS idx_signal_outcomes_pending_4h
  ON public.signal_outcomes (signal_generated_at)
  WHERE price_4h IS NULL;

CREATE INDEX IF NOT EXISTS idx_signal_outcomes_pending_24h
  ON public.signal_outcomes (signal_generated_at)
  WHERE price_24h IS NULL;

-- Enable RLS (consistent with other tables)
ALTER TABLE public.signal_outcomes ENABLE ROW LEVEL SECURITY;

-- Policy: service_role has full access (backend uses service_role key)
CREATE POLICY "service_role_full_access" ON public.signal_outcomes
  FOR ALL USING (true) WITH CHECK (true);
