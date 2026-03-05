-- ═══════════════════════════════════════════════════════════════════════════════
-- SENTIX PRO - SIGNALS, ALERTS & TELEGRAM TABLES
-- Migration: v3.0 - Signal persistence + alert delivery + Telegram subscribers
-- Run this in Supabase SQL Editor: https://supabase.com > SQL Editor > New Query
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 1. SIGNALS TABLE (persists signals across server restarts) ──────────────

CREATE TABLE IF NOT EXISTS signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset TEXT NOT NULL UNIQUE,              -- Asset name (e.g., 'BITCOIN', 'GOLD (XAU)')
  action TEXT NOT NULL DEFAULT 'HOLD',     -- BUY, SELL, HOLD
  strength_label TEXT,                      -- STRONG BUY, BUY, WEAK BUY, etc.
  score INTEGER DEFAULT 50,                -- Display score 0-100
  raw_score INTEGER DEFAULT 0,             -- Internal score -100 to +100
  confidence INTEGER DEFAULT 0,            -- Confidence percentage 0-85
  price NUMERIC(20, 8),                    -- Current price at signal generation
  change_24h NUMERIC(10, 4) DEFAULT 0,     -- 24h change percentage
  reasons TEXT,                            -- Analysis reasons (bullet points)
  indicators JSONB DEFAULT '{}',           -- Technical indicator values
  data_source TEXT DEFAULT 'unknown',      -- Data source (Binance OHLCV, etc.)
  interval_tf TEXT DEFAULT '1h',           -- Timeframe used
  asset_class TEXT DEFAULT 'crypto',       -- crypto, metal
  generated_at TIMESTAMPTZ DEFAULT NOW(),  -- When signal was generated
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_signals_asset ON signals(asset);
CREATE INDEX IF NOT EXISTS idx_signals_action ON signals(action);
CREATE INDEX IF NOT EXISTS idx_signals_confidence ON signals(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_signals_generated ON signals(generated_at DESC);

-- ─── 2. ALERTS TABLE (historical alert log) ─────────────────────────────────

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset TEXT NOT NULL,
  action TEXT NOT NULL,
  score INTEGER,
  confidence INTEGER,
  reasons TEXT,
  price NUMERIC(20, 8),
  delivered_telegram BOOLEAN DEFAULT false,
  delivered_email BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_alerts_asset ON alerts(asset);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);

-- ─── 3. TELEGRAM SUBSCRIBERS TABLE ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS telegram_subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id BIGINT NOT NULL UNIQUE,          -- Telegram chat ID
  subscribed_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_telegram_chat_id ON telegram_subscribers(chat_id);

-- ─── 4. DISABLE RLS ON NEW TABLES (backend uses service key) ────────────────

ALTER TABLE IF EXISTS signals DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS alerts DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS telegram_subscribers DISABLE ROW LEVEL SECURITY;

-- Also ensure previous tables have RLS disabled
ALTER TABLE IF EXISTS wallets DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS portfolios DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS wallet_snapshots DISABLE ROW LEVEL SECURITY;

-- Drop any restrictive RLS policies that may exist
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

-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION COMPLETE
--
-- New Tables:
--   - signals: Persists latest signals across server restarts
--   - alerts: Historical log of all alerts sent
--   - telegram_subscribers: Persists Telegram chat IDs
--
-- All RLS disabled for backend service key access.
-- ═══════════════════════════════════════════════════════════════════════════════
