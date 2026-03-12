-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration 018: Order system fixes
-- 1. Partial unique index to prevent duplicate active orders per user+asset
-- 2. Index for faster order lookups during validation
-- ═══════════════════════════════════════════════════════════════════════════════

-- Prevent race condition: only one active order per user+asset+side
-- Active = not in terminal state (FILLED, CANCELLED, REJECTED, EXPIRED)
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_one_active_per_asset
  ON orders (user_id, asset, side)
  WHERE status NOT IN ('FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED');
