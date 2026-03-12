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
  const { data, error } = await supabase.rpc('transition_order_status', {
    p_order_id: orderId,
    p_from_status: fromStatus,
    p_to_status: toStatus,
    p_extra: extra
  });

  if (error) {
    logger.error('Advisory lock RPC failed', { orderId, fromStatus, toStatus, error: error.message });
    // Fallback: attempt direct update (degraded mode without lock)
    const { error: fallbackErr } = await supabase
      .from('orders')
      .update({ status: toStatus, updated_at: new Date().toISOString(), ...flattenExtra(extra) })
      .eq('id', orderId)
      .eq('status', fromStatus);

    if (fallbackErr) {
      return { success: false, reason: `Lock RPC and fallback both failed: ${fallbackErr.message}` };
    }
    return { success: true, reason: 'Fallback (no advisory lock)' };
  }

  return data || { success: false, reason: 'No data returned from RPC' };
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
