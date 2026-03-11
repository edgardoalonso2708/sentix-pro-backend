-- ═══════════════════════════════════════════════════════════════════════════════
-- Add missing columns to backtest_results table
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.backtest_results
  ADD COLUMN IF NOT EXISTS monte_carlo jsonb,
  ADD COLUMN IF NOT EXISTS significance jsonb,
  ADD COLUMN IF NOT EXISTS kelly_sizing jsonb;
