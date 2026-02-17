-- ═══════════════════════════════════════════════════════════════════════════════
-- SENTIX PRO - MULTI-WALLET PORTFOLIO SCHEMA
-- Migration: v2.3 → v2.4 (Multi-Exchange/Wallet Support)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 1. CREATE WALLETS/EXCHANGES TABLE ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,

  -- Wallet/Exchange identification
  name TEXT NOT NULL,                    -- e.g., "Binance Main", "Bybit Futures", "MercadoPago"
  type TEXT NOT NULL,                    -- 'exchange', 'wallet', 'other'
  provider TEXT NOT NULL,                -- e.g., "binance", "bybit", "mercadopago", "metamask", "ledger"

  -- Display settings
  color TEXT DEFAULT '#6366f1',          -- UI color code for visual distinction
  icon TEXT,                             -- Optional icon identifier
  is_active BOOLEAN DEFAULT true,        -- Soft delete / archive wallets

  -- Metadata
  notes TEXT,                            -- User notes about this wallet
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Constraints
  CONSTRAINT valid_type CHECK (type IN ('exchange', 'wallet', 'cold_storage', 'defi', 'other')),
  CONSTRAINT unique_user_wallet_name UNIQUE (user_id, name)
);

-- Index for fast user queries
CREATE INDEX idx_wallets_user_id ON wallets(user_id);
CREATE INDEX idx_wallets_user_active ON wallets(user_id, is_active);

-- ─── 2. MODIFY PORTFOLIOS TABLE TO INCLUDE WALLET_ID ──────────────────────────

-- Drop existing portfolios table (backup first if needed)
DROP TABLE IF EXISTS portfolios_backup;
CREATE TABLE portfolios_backup AS SELECT * FROM portfolios;

-- Recreate portfolios with wallet support
DROP TABLE IF EXISTS portfolios;
CREATE TABLE portfolios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,

  -- Position details
  asset TEXT NOT NULL,                   -- CoinGecko ID: 'bitcoin', 'ethereum', etc.
  amount NUMERIC(20, 8) NOT NULL CHECK (amount > 0),
  buy_price NUMERIC(20, 8) NOT NULL CHECK (buy_price > 0),
  purchase_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Optional metadata
  notes TEXT,
  transaction_id TEXT,                   -- External transaction reference
  tags TEXT[],                           -- e.g., ['long-term', 'dca', 'swing-trade']

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Prevent duplicate positions (user can have same asset in different wallets)
  CONSTRAINT unique_position UNIQUE (user_id, wallet_id, asset, purchase_date)
);

-- Indexes for performance
CREATE INDEX idx_portfolios_user_id ON portfolios(user_id);
CREATE INDEX idx_portfolios_wallet_id ON portfolios(wallet_id);
CREATE INDEX idx_portfolios_user_wallet ON portfolios(user_id, wallet_id);
CREATE INDEX idx_portfolios_asset ON portfolios(asset);

-- ─── 3. CREATE WALLET_SNAPSHOTS FOR HISTORICAL P&L TRACKING ───────────────────

CREATE TABLE IF NOT EXISTS wallet_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,

  -- Snapshot metrics (at a point in time)
  snapshot_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_value NUMERIC(20, 2) NOT NULL,
  total_invested NUMERIC(20, 2) NOT NULL,
  total_pnl NUMERIC(20, 2) NOT NULL,
  total_pnl_percent NUMERIC(10, 4) NOT NULL,

  -- Position count at snapshot
  position_count INTEGER NOT NULL,

  -- Top performers (JSON array of {asset, pnl, pnl_percent})
  top_gainers JSONB,
  top_losers JSONB,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_snapshots_wallet_date ON wallet_snapshots(wallet_id, snapshot_date DESC);
CREATE INDEX idx_snapshots_user_date ON wallet_snapshots(user_id, snapshot_date DESC);

-- ─── 4. CREATE VIEW FOR CONSOLIDATED PORTFOLIO ────────────────────────────────

CREATE OR REPLACE VIEW portfolio_consolidated AS
SELECT
  p.user_id,
  p.asset,
  SUM(p.amount) as total_amount,
  -- Weighted average buy price
  SUM(p.amount * p.buy_price) / NULLIF(SUM(p.amount), 0) as avg_buy_price,
  -- Min/max purchase dates
  MIN(p.purchase_date) as first_purchase,
  MAX(p.purchase_date) as last_purchase,
  -- Total invested
  SUM(p.amount * p.buy_price) as total_invested,
  -- Wallet count
  COUNT(DISTINCT p.wallet_id) as wallet_count,
  -- Wallets containing this asset
  ARRAY_AGG(DISTINCT w.name ORDER BY w.name) as wallets,
  -- Aggregated metadata
  COUNT(*) as position_count
FROM portfolios p
JOIN wallets w ON p.wallet_id = w.id
WHERE w.is_active = true
GROUP BY p.user_id, p.asset;

-- ─── 5. CREATE VIEW FOR WALLET SUMMARY ────────────────────────────────────────

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
  SUM(p.amount * p.buy_price) as total_invested,
  ARRAY_AGG(DISTINCT p.asset ORDER BY p.asset) as assets
FROM wallets w
LEFT JOIN portfolios p ON w.id = p.wallet_id
WHERE w.is_active = true
GROUP BY w.id, w.user_id, w.name, w.type, w.provider, w.color;

-- ─── 6. MIGRATION FUNCTION: MOVE OLD DATA TO DEFAULT WALLET ───────────────────

-- Create default wallet for existing users with portfolio data
DO $$
DECLARE
  r RECORD;
  default_wallet_id UUID;
BEGIN
  -- For each user with existing portfolio data
  FOR r IN
    SELECT DISTINCT user_id
    FROM portfolios_backup
    WHERE user_id IS NOT NULL
  LOOP
    -- Create a default "Main Wallet" for this user
    INSERT INTO wallets (user_id, name, type, provider, color, notes)
    VALUES (
      r.user_id,
      'Main Wallet',
      'wallet',
      'imported',
      '#6366f1',
      'Auto-created from legacy portfolio data'
    )
    RETURNING id INTO default_wallet_id;

    -- Migrate old portfolio entries to this default wallet
    INSERT INTO portfolios (user_id, wallet_id, asset, amount, buy_price, purchase_date, notes, created_at)
    SELECT
      user_id,
      default_wallet_id,
      asset,
      amount,
      buy_price,
      purchase_date,
      notes,
      created_at
    FROM portfolios_backup
    WHERE user_id = r.user_id;

    RAISE NOTICE 'Migrated portfolio for user: %', r.user_id;
  END LOOP;
END $$;

-- ─── 7. FUNCTIONS FOR P&L CALCULATIONS ────────────────────────────────────────

-- Function to calculate wallet P&L (call from backend with current prices)
CREATE OR REPLACE FUNCTION calculate_wallet_pnl(
  p_wallet_id UUID,
  p_market_prices JSONB  -- {'bitcoin': 45000, 'ethereum': 2500, ...}
)
RETURNS TABLE (
  asset TEXT,
  amount NUMERIC,
  buy_price NUMERIC,
  current_price NUMERIC,
  current_value NUMERIC,
  invested NUMERIC,
  pnl NUMERIC,
  pnl_percent NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.asset,
    p.amount,
    p.buy_price,
    (p_market_prices->>p.asset)::NUMERIC as current_price,
    p.amount * (p_market_prices->>p.asset)::NUMERIC as current_value,
    p.amount * p.buy_price as invested,
    (p.amount * (p_market_prices->>p.asset)::NUMERIC) - (p.amount * p.buy_price) as pnl,
    CASE
      WHEN p.amount * p.buy_price > 0
      THEN (((p.amount * (p_market_prices->>p.asset)::NUMERIC) - (p.amount * p.buy_price)) / (p.amount * p.buy_price)) * 100
      ELSE 0
    END as pnl_percent
  FROM portfolios p
  WHERE p.wallet_id = p_wallet_id
    AND (p_market_prices ? p.asset); -- Only include assets with prices
END;
$$ LANGUAGE plpgsql;

-- ─── 8. TRIGGER TO UPDATE TIMESTAMPS ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wallets_updated_at
  BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER portfolios_updated_at
  BEFORE UPDATE ON portfolios
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── 9. GRANT PERMISSIONS (adjust for your Supabase setup) ────────────────────

-- Enable RLS (Row Level Security)
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_snapshots ENABLE ROW LEVEL SECURITY;

-- RLS Policies (users can only see their own data)
CREATE POLICY "Users can view own wallets"
  ON wallets FOR SELECT
  USING (auth.uid()::TEXT = user_id);

CREATE POLICY "Users can insert own wallets"
  ON wallets FOR INSERT
  WITH CHECK (auth.uid()::TEXT = user_id);

CREATE POLICY "Users can update own wallets"
  ON wallets FOR UPDATE
  USING (auth.uid()::TEXT = user_id);

CREATE POLICY "Users can delete own wallets"
  ON wallets FOR DELETE
  USING (auth.uid()::TEXT = user_id);

CREATE POLICY "Users can view own portfolio"
  ON portfolios FOR SELECT
  USING (auth.uid()::TEXT = user_id);

CREATE POLICY "Users can insert own portfolio"
  ON portfolios FOR INSERT
  WITH CHECK (auth.uid()::TEXT = user_id);

CREATE POLICY "Users can update own portfolio"
  ON portfolios FOR UPDATE
  USING (auth.uid()::TEXT = user_id);

CREATE POLICY "Users can delete own portfolio"
  ON portfolios FOR DELETE
  USING (auth.uid()::TEXT = user_id);

CREATE POLICY "Users can view own snapshots"
  ON wallet_snapshots FOR SELECT
  USING (auth.uid()::TEXT = user_id);

CREATE POLICY "Users can insert own snapshots"
  ON wallet_snapshots FOR INSERT
  WITH CHECK (auth.uid()::TEXT = user_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION COMPLETE
--
-- New Tables:
--   - wallets: Store exchange/wallet configurations
--   - portfolios: Updated with wallet_id foreign key
--   - wallet_snapshots: Historical P&L tracking
--
-- New Views:
--   - portfolio_consolidated: Aggregated positions across wallets
--   - wallet_summary: Wallet-level statistics
--
-- New Functions:
--   - calculate_wallet_pnl: Real-time P&L with current prices
--
-- Next Steps:
--   1. Run this migration in Supabase SQL Editor
--   2. Verify data migration from portfolios_backup
--   3. Update backend API (portfolioManager.js, server.js)
--   4. Update frontend to support wallet selection
-- ═══════════════════════════════════════════════════════════════════════════════
