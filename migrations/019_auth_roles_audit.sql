-- Migration 019: User Profiles (roles) + Audit Log
-- Safe to run: creates new tables, no impact on existing system

-- ─── User Profiles ─────────────────────────────────────────────────
-- Links to Supabase auth.users.id, stores role and invitation data
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY,                          -- matches Supabase auth.users.id
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',           -- 'admin', 'trader', 'viewer'
  display_name TEXT,
  invited_by UUID REFERENCES user_profiles(id),
  invitation_token TEXT UNIQUE,
  invitation_expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT valid_role CHECK (role IN ('admin', 'trader', 'viewer'))
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_email ON user_profiles(email);
CREATE INDEX IF NOT EXISTS idx_user_profiles_role ON user_profiles(role);
CREATE INDEX IF NOT EXISTS idx_user_profiles_invitation_token ON user_profiles(invitation_token);

-- Disable RLS (API-level security, same pattern as all other tables)
ALTER TABLE user_profiles DISABLE ROW LEVEL SECURITY;

-- ─── Audit Log ─────────────────────────────────────────────────────
-- Records login attempts, trades, config changes, admin actions
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  email TEXT,
  action TEXT NOT NULL,
  -- Actions: login, login_failed, trade_opened, trade_closed,
  --          config_change, kill_switch, invite_sent, invite_claimed,
  --          role_change, user_deactivated
  resource TEXT,                    -- e.g., 'paper_trading', 'orders', 'config'
  details JSONB DEFAULT '{}',       -- action-specific metadata
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);

-- Auto-cleanup: keep 90 days of audit data
-- (run manually or via cron: DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days')

ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;
