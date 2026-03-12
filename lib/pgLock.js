// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — PostgreSQL Advisory Lock Wrapper
// Uses the transition_order_status() DB function for atomic state transitions.
// Compatible with Supabase PgBouncer (transaction-scoped locks).
// ═══════════════════════════════════════════════════════════════════════════════

const { logger } = require('../logger');

/**
 * Atomically transition an order's status using advisory lock + FOR UPDATE.
 * Validates that the order is in the expected state before transitioning.
 *
 * @param {object} supabase - Supabase client
 * @param {string} orderId - Order UUID
 * @param {string} fromStatus - Expected current status
 * @param {string} toStatus - Target status
 * @param {object} [extra={}] - Additional fields to update (avg_fill_price, filled_quantity, etc.)
 * @returns {Promise<{success: boolean, reason?: string, current_status?: string}>}
 */
async function transitionOrderStatus(supabase, orderId, fromStatus, toStatus, extra = {}) {
  try {
    const { data, error } = await supabase.rpc('transition_order_status', {
      p_order_id: orderId,
      p_from_status: fromStatus,
      p_to_status: toStatus,
      p_extra: extra
    });

    if (!error && data && data.success !== undefined) {
      return data;
    }

    if (error) {
      logger.warn('Advisory lock RPC unavailable, using fallback', { orderId, fromStatus, toStatus, error: error.message });
    }
  } catch (rpcErr) {
    logger.warn('Advisory lock RPC threw, using fallback', { orderId, fromStatus, toStatus, error: rpcErr.message });
  }

  // Fallback: direct update (degraded mode without advisory lock)
  // Only update safe columns — skip retry_count/last_retry_at if migration not run
  return directTransition(supabase, orderId, fromStatus, toStatus, extra);
}

/**
 * Direct update fallback — works even without migration 020.
 * Filters .eq('status', fromStatus) to prevent race conditions at the app level.
 */
async function directTransition(supabase, orderId, fromStatus, toStatus, extra = {}) {
  const updatePayload = { status: toStatus, updated_at: new Date().toISOString() };

  // Add timestamp columns based on target status
  if (toStatus === 'VALIDATED') updatePayload.validated_at = new Date().toISOString();
  if (toStatus === 'SUBMITTED') updatePayload.submitted_at = new Date().toISOString();
  if (toStatus === 'FILLED') updatePayload.filled_at = new Date().toISOString();
  if (toStatus === 'CANCELLED') updatePayload.cancelled_at = new Date().toISOString();

  // Flatten known extra fields (skip retry_count/last_retry_at — may not exist)
  if (extra.avg_fill_price) updatePayload.avg_fill_price = extra.avg_fill_price;
  if (extra.filled_quantity) updatePayload.filled_quantity = extra.filled_quantity;
  if (extra.exchange_order_id) updatePayload.exchange_order_id = extra.exchange_order_id;
  if (extra.reject_reason) updatePayload.reject_reason = extra.reject_reason;

  const { data, error } = await supabase
    .from('orders')
    .update(updatePayload)
    .eq('id', orderId)
    .eq('status', fromStatus)
    .select('id')
    .single();

  if (error) {
    // Could be "no rows returned" (status mismatch) or actual DB error
    if (error.code === 'PGRST116') {
      // No rows matched — status already changed (race condition)
      return { success: false, reason: `Status mismatch: expected ${fromStatus}` };
    }
    logger.error('Direct transition fallback failed', { orderId, fromStatus, toStatus, error: error.message });
    return { success: false, reason: `Fallback update failed: ${error.message}` };
  }

  return { success: true, from: fromStatus, to: toStatus, reason: 'Fallback (no advisory lock)' };
}

/**
 * Flatten JSONB extra fields to direct column values for fallback update.
 */
function flattenExtra(extra) {
  const flat = {};
  if (extra.avg_fill_price) flat.avg_fill_price = extra.avg_fill_price;
  if (extra.filled_quantity) flat.filled_quantity = extra.filled_quantity;
  if (extra.exchange_order_id) flat.exchange_order_id = extra.exchange_order_id;
  if (extra.reject_reason) flat.reject_reason = extra.reject_reason;
  if (extra.retry_count !== undefined) flat.retry_count = extra.retry_count;
  if (extra.last_retry_at) flat.last_retry_at = extra.last_retry_at;
  return flat;
}

module.exports = { transitionOrderStatus };
