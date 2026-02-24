-- ═══════════════════════════════════════════════════════════════════════════════
-- SENTIX PRO - DISABLE RLS FOR BACKEND ACCESS
-- Migration: Fix 500 errors caused by Row Level Security blocking backend ops
-- Run this in Supabase SQL Editor: https://supabase.com > SQL Editor > New Query
-- ═══════════════════════════════════════════════════════════════════════════════

-- The backend uses a service key without auth session,
-- so RLS policies that check auth.uid() will block all operations.
-- Security is handled at the API level (userId validation in Express routes).

-- Disable RLS on all tables
ALTER TABLE IF EXISTS wallets DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS portfolios DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS wallet_snapshots DISABLE ROW LEVEL SECURITY;

-- Drop restrictive RLS policies (they block backend access)
DROP POLICY IF EXISTS "Users can view own wallets" ON wallets;
DROP POLICY IF EXISTS "Users can insert own wallets" ON wallets;
DROP POLICY IF EXISTS "Users can update own wallets" ON wallets;
DROP POLICY IF EXISTS "Users can delete own wallets" ON wallets;

DROP POLICY IF EXISTS "Users can view own portfolio" ON portfolios;
DROP POLICY IF EXISTS "Users can insert own portfolio" ON portfolios;
DROP POLICY IF EXISTS "Users can update own portfolio" ON portfolios;
DROP POLICY IF EXISTS "Users can delete own portfolio" ON portfolios;

DROP POLICY IF EXISTS "Users can view own snapshots" ON wallet_snapshots;
DROP POLICY IF EXISTS "Users can insert own snapshots" ON wallet_snapshots;

-- Verify tables exist (create if missing)
CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'exchange',
  provider TEXT NOT NULL DEFAULT 'other',
  color TEXT DEFAULT '#6366f1',
  icon TEXT,
  is_active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT valid_type CHECK (type IN ('exchange', 'wallet', 'cold_storage', 'defi', 'other')),
  CONSTRAINT unique_user_wallet_name UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS portfolios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  asset TEXT NOT NULL,
  amount NUMERIC(20, 8) NOT NULL CHECK (amount > 0),
  buy_price NUMERIC(20, 8) NOT NULL CHECK (buy_price > 0),
  purchase_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT,
  transaction_id TEXT,
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes if missing
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_user_active ON wallets(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_portfolios_user_id ON portfolios(user_id);
CREATE INDEX IF NOT EXISTS idx_portfolios_wallet_id ON portfolios(wallet_id);
CREATE INDEX IF NOT EXISTS idx_portfolios_user_wallet ON portfolios(user_id, wallet_id);

-- Create/update views
CREATE OR REPLACE VIEW wallet_summary AS
SELECT
  w.id as wallet_id,
  w.user_id,
  w.name as wallet_name,
  w.type,
  w.provider,
  w.color,
  COUNT(p.id) as position_count,
  COUNT(DISTINCT p.asset) as unique_assets,
  COALESCE(SUM(p.amount * p.buy_price), 0) as total_invested,
  ARRAY_AGG(DISTINCT p.asset ORDER BY p.asset) FILTER (WHERE p.asset IS NOT NULL) as assets
FROM wallets w
LEFT JOIN portfolios p ON w.id = p.wallet_id
WHERE w.is_active = true
GROUP BY w.id, w.user_id, w.name, w.type, w.provider, w.color;

-- Done! The backend can now access wallets and portfolios without RLS issues.
