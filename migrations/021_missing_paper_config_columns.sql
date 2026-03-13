-- ═══════════════════════════════════════════════════════════════════════════════
-- 021: Add missing paper_config columns
-- These columns exist in DEFAULT_CONFIG (paperTrading.js) but were never
-- added to the database schema via migrations.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Max percentage of capital per position (25% default)
ALTER TABLE paper_config ADD COLUMN IF NOT EXISTS max_position_percent NUMERIC(5,4) DEFAULT 0.25;

-- Partial close ratio at TP1 (50% default)
ALTER TABLE paper_config ADD COLUMN IF NOT EXISTS partial_close_ratio NUMERIC(5,4) DEFAULT 0.50;

-- Max holding period in hours (168 = 7 days, 0 = disabled)
ALTER TABLE paper_config ADD COLUMN IF NOT EXISTS max_holding_hours INTEGER DEFAULT 168;

-- Move SL to breakeven after TP1 hit
ALTER TABLE paper_config ADD COLUMN IF NOT EXISTS move_sl_to_breakeven_after_tp1 BOOLEAN DEFAULT true;
