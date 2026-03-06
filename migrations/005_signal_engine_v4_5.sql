-- ═══════════════════════════════════════════════════════════════════════════════
-- SENTIX PRO - SIGNAL ENGINE v4.5 UPGRADE
-- Migration: v4.5 - BTC Dominance, DXY Macro Regime, Trailing Stop
-- Run this in Supabase SQL Editor: https://supabase.com > SQL Editor > New Query
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 1. ADD MACRO CONTEXT COLUMN TO SIGNALS TABLE ─────────────────────────────

-- Macro context: btcDominance, btcDomRegime, dxy, dxyRegime
ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS macro_context JSONB DEFAULT NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION COMPLETE
--
-- New column on signals table:
--   - macro_context (JSONB): BTC dominance regime + DXY macro regime
--
-- Trailing stop fields are stored inside the existing trade_levels JSONB column
-- (trailingStop, trailingStopPercent, trailingActivation, trailingActivationPercent)
--
-- Existing columns from migration 004 remain unchanged:
--   - trade_levels (JSONB) - now includes trailing stop fields
--   - derivatives (JSONB) - unchanged
--   - timeframes (JSONB) - unchanged
-- ═══════════════════════════════════════════════════════════════════════════════
