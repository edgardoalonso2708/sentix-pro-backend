-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration 017: Add user-configurable strategy parameters to paper_config
-- Makes ATR multipliers, portfolio limits, and trade management params editable
-- ═══════════════════════════════════════════════════════════════════════════════

-- Trade level ATR multipliers (were hardcoded in strategyConfig.js)
ALTER TABLE paper_config ADD COLUMN IF NOT EXISTS atr_stop_mult NUMERIC(5,2) DEFAULT 2.5;
ALTER TABLE paper_config ADD COLUMN IF NOT EXISTS atr_tp2_mult NUMERIC(5,2) DEFAULT 2.0;
ALTER TABLE paper_config ADD COLUMN IF NOT EXISTS atr_trailing_mult NUMERIC(5,2) DEFAULT 2.5;
ALTER TABLE paper_config ADD COLUMN IF NOT EXISTS atr_trailing_activation NUMERIC(5,2) DEFAULT 2.0;

-- Portfolio limits (were in DEFAULT_CONFIG but not editable)
-- max_portfolio_correlation, max_sector_exposure_pct, max_same_direction_crypto
-- already exist as columns from initial setup, no ALTER needed

-- Update defaults for existing users: widen allowed_strength, fix sector exposure
UPDATE paper_config SET
  allowed_strength = '["BUY","STRONG BUY","SELL","STRONG SELL"]'::jsonb
WHERE allowed_strength = '["STRONG BUY","STRONG SELL"]'::jsonb;

UPDATE paper_config SET max_sector_exposure_pct = 0.60
WHERE max_sector_exposure_pct = 0.80;
