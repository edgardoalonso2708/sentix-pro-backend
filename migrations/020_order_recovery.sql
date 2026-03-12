-- Migration 020: Order Recovery + Advisory Locks
-- Adds retry tracking, recovery index, and atomic state transition function

-- ─── Order Recovery Columns ──────────────────────────────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ;

-- Partial index for fast recovery queries
CREATE INDEX IF NOT EXISTS idx_orders_submitted_recovery
  ON orders(status, submitted_at) WHERE status = 'SUBMITTED';

-- ─── Atomic Order State Transition (Advisory Lock) ───────────────────────────
-- Uses pg_advisory_xact_lock (transaction-scoped) which works with Supabase PgBouncer.
-- Validates current status before transitioning, preventing race conditions.

CREATE OR REPLACE FUNCTION transition_order_status(
  p_order_id UUID,
  p_from_status TEXT,
  p_to_status TEXT,
  p_extra JSONB DEFAULT '{}'::JSONB
) RETURNS JSONB AS $$
DECLARE
  v_lock_key BIGINT;
  v_order RECORD;
BEGIN
  -- Generate lock key from order UUID (first 16 hex chars as bigint)
  v_lock_key := ('x' || left(replace(p_order_id::text, '-', ''), 16))::bit(64)::bigint;

  -- Acquire transaction-scoped advisory lock (auto-released at tx end)
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Read current state with row lock
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'reason', 'Order not found');
  END IF;

  IF v_order.status != p_from_status THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', format('Expected status %s but found %s', p_from_status, v_order.status),
      'current_status', v_order.status
    );
  END IF;

  -- Apply transition with optional extra fields
  UPDATE orders
  SET status = p_to_status,
      updated_at = NOW(),
      validated_at    = CASE WHEN p_to_status = 'VALIDATED'  THEN NOW() ELSE validated_at END,
      submitted_at    = CASE WHEN p_to_status = 'SUBMITTED'  THEN NOW() ELSE submitted_at END,
      filled_at       = CASE WHEN p_to_status = 'FILLED'     THEN NOW() ELSE filled_at END,
      cancelled_at    = CASE WHEN p_to_status = 'CANCELLED'  THEN NOW() ELSE cancelled_at END,
      avg_fill_price  = CASE WHEN p_extra ? 'avg_fill_price'  THEN (p_extra->>'avg_fill_price')::NUMERIC  ELSE avg_fill_price END,
      filled_quantity = CASE WHEN p_extra ? 'filled_quantity'  THEN (p_extra->>'filled_quantity')::NUMERIC ELSE filled_quantity END,
      exchange_order_id = CASE WHEN p_extra ? 'exchange_order_id' THEN p_extra->>'exchange_order_id'      ELSE exchange_order_id END,
      reject_reason   = CASE WHEN p_extra ? 'reject_reason'    THEN p_extra->>'reject_reason'             ELSE reject_reason END,
      retry_count     = CASE WHEN p_extra ? 'retry_count'      THEN (p_extra->>'retry_count')::INTEGER    ELSE retry_count END,
      last_retry_at   = CASE WHEN p_extra ? 'last_retry_at'    THEN (p_extra->>'last_retry_at')::TIMESTAMPTZ ELSE last_retry_at END
  WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true, 'from', p_from_status, 'to', p_to_status);
END;
$$ LANGUAGE plpgsql;
