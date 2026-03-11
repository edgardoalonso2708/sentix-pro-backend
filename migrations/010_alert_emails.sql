-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 010: ADD ALERT_EMAILS TO ALERT_FILTERS
-- Support multiple notification emails (comma-separated string)
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE alert_filters
  ADD COLUMN IF NOT EXISTS alert_emails TEXT DEFAULT '';
