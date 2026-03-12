// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO - Audit Logger
// Logs critical actions to audit_log table for security and compliance.
// Fire-and-forget — never blocks the calling request.
// ═══════════════════════════════════════════════════════════════════════════════

const { logger } = require('./logger');

/**
 * Log an action to the audit_log table.
 * Fire-and-forget: errors are logged but never thrown.
 *
 * @param {object} supabase - Supabase client
 * @param {object} params
 * @param {string} params.userId - User UUID (nullable for failed logins)
 * @param {string} params.email - User email (nullable)
 * @param {string} params.action - Action type: login, login_failed, trade_opened, trade_closed,
 *                                  config_change, kill_switch, invite_sent, invite_claimed,
 *                                  role_change, user_deactivated
 * @param {string} [params.resource] - Resource affected (e.g., 'paper_trading', 'orders', 'config')
 * @param {object} [params.details] - Action-specific metadata
 * @param {string} [params.ip] - Client IP address
 * @param {string} [params.userAgent] - Client User-Agent header
 */
async function logAudit(supabase, { userId = null, email = null, action, resource = null, details = {}, ip = null, userAgent = null }) {
  try {
    const { error } = await supabase.from('audit_log').insert({
      user_id: userId,
      email,
      action,
      resource,
      details,
      ip_address: ip,
      user_agent: userAgent
    });

    if (error) {
      logger.warn('Audit log insert failed', { action, error: error.message });
    }
  } catch (err) {
    // Fire-and-forget — never throw
    logger.warn('Audit log error', { action, error: err.message });
  }
}

/**
 * Extract client IP from Express request (handles proxies).
 */
function getClientIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null;
}

/**
 * Create audit context from Express request.
 * Convenience helper to extract ip + userAgent from req.
 */
function auditContext(req) {
  return {
    ip: getClientIp(req),
    userAgent: req.headers['user-agent'] || null
  };
}

module.exports = { logAudit, getClientIp, auditContext };
