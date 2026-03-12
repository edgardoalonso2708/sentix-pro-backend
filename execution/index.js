// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — Execution Adapter Registry
// Factory for creating execution adapters by type.
// Currently supports: 'paper' (simulated).
// Future: 'bybit' (real exchange execution).
// ═══════════════════════════════════════════════════════════════════════════════

const { ExecutionAdapter } = require('./ExecutionAdapter');
const { PaperExecutionAdapter } = require('./PaperExecutionAdapter');

/**
 * Create an execution adapter by type.
 *
 * @param {string} type - Adapter type ('paper', 'bybit' in future)
 * @param {object} dependencies - Dependencies required by the adapter
 * @param {object} dependencies.supabase - Supabase client (required for 'paper')
 * @returns {ExecutionAdapter}
 */
function createAdapter(type, dependencies = {}) {
  switch (type) {
    case 'paper':
      if (!dependencies.supabase) {
        throw new Error('PaperExecutionAdapter requires supabase dependency');
      }
      return new PaperExecutionAdapter(dependencies.supabase);

    // Future exchange adapters:
    // case 'bybit':
    //   return new BybitExecutionAdapter(dependencies.apiKey, dependencies.apiSecret, ...);

    default:
      throw new Error(`Unknown execution adapter type: ${type}. Available: paper`);
  }
}

/**
 * List available adapter types.
 * @returns {string[]}
 */
function getAvailableAdapters() {
  return ['paper'];
}

module.exports = {
  createAdapter,
  getAvailableAdapters,
  ExecutionAdapter,
  PaperExecutionAdapter
};
