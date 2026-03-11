// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — BACKWARD COMPATIBILITY SHIM
// Tests and legacy code do `require('./server')` — this re-exports the API app.
// For production, use: node orchestrator.js
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = require('./api');
