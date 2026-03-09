-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 009: CUSTOM ALERT FILTERS
-- Per-user alert preferences: assets, actions, min confidence, delivery channels
-- ═══════════════════════════════════════════════════════════════════════════════

-- Alert filter preferences per user
CREATE TABLE IF NOT EXISTS alert_filters (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,

  -- Asset filters: which assets to receive alerts for (empty = all)
  assets TEXT[] DEFAULT '{}',

  -- Action filters: which signal actions trigger alerts
  -- e.g. ['BUY', 'SELL', 'STRONG BUY', 'STRONG SELL']
  actions TEXT[] DEFAULT ARRAY['BUY', 'SELL', 'STRONG BUY', 'STRONG SELL'],

  -- Minimum confidence threshold (0-100)
  min_confidence INTEGER DEFAULT 50,

  -- Minimum absolute score to trigger alert
  min_score INTEGER DEFAULT 25,

  -- Delivery channels
  telegram_enabled BOOLEAN DEFAULT true,
  email_enabled BOOLEAN DEFAULT true,

  -- Quiet hours (UTC)
  quiet_start TIME DEFAULT NULL,
  quiet_end TIME DEFAULT NULL,

  -- Cooldown: minimum minutes between alerts for same asset
  cooldown_minutes INTEGER DEFAULT 20,

  -- Master switch
  enabled BOOLEAN DEFAULT true,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_alert_filters_user_id ON alert_filters(user_id);

-- Disable RLS (consistent with rest of project)
ALTER TABLE alert_filters DISABLE ROW LEVEL SECURITY;
