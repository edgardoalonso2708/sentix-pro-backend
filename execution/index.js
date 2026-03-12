// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — Execution Adapter Registry
// Factory for creating execution adapters by type.
// Supports: 'paper' (simulated), 'bybit' (real exchange — Spot).
// ═══════════════════════════════════════════════════════════════════════════════

const { ExecutionAdapter } = require('./ExecutionAdapter');
const { PaperExecutionAdapter } = require('./PaperExecutionAdapter');
const { BybitExecutionAdapter } = require('./BybitExecutionAdapter');

/**
 * Create an execution adapter by type.
 *
 * @param {string} type - Adapter type ('paper', 'bybit')
 * @param {object} dependencies - Dependencies required by the adapter
 * @param {object} dependencies.supabase - Supabase client (required for 'paper')
 * @param {string} [dependencies.apiKey] - Bybit API key (required for 'bybit')
 * @param {string} [dependencies.apiSecret] - Bybit API secret (required for 'bybit')
 * @param {boolean} [dependencies.testnet=true] - Use Bybit testnet (default true)
 * @returns {ExecutionAdapter}
 */
function createAdapter(type, dependencies = {}) {
  switch (type) {
    case 'paper':
      if (!dependencies.supabase) {
        throw new Error('PaperExecutionAdapter requires supabase dependency');
      }
      return new PaperExecutionAdapter(dependencies.supabase);

    case 'bybit':
      if (!dependencies.apiKey || !dependencies.apiSecret) {
        throw new Error('BybitExecutionAdapter requires apiKey and apiSecret');
      }
      return new BybitExecutionAdapter(
        dependencies.apiKey,
        dependencies.apiSecret,
        dependencies.testnet !== false, // default to testnet for safety
        dependencies.supabase || null
      );

    default:
      throw new Error(`Unknown execution adapter type: ${type}. Available: ${getAvailableAdapters().join(', ')}`);
  }
}

/**
 * List available adapter types.
 * @returns {string[]}
 */
function getAvailableAdapters() {
  return ['paper', 'bybit'];
}

module.exports = {
  createAdapter,
  getAvailableAdapters,
  ExecutionAdapter,
  PaperExecutionAdapter,
  BybitExecutionAdapter
};
