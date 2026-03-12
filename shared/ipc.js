// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — IPC Message Protocol
// Defines message types and helpers for inter-process communication
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * IPC message type constants.
 * All messages between orchestrator and workers use this protocol.
 */
const MSG = {
  // Market worker → Orchestrator → API + Alerts
  MARKET_UPDATE: 'market_update',

  // Alerts worker → Orchestrator → API
  SIGNALS_UPDATE: 'signals_update',

  // Market/Alerts worker → Orchestrator → API (for SSE + Telegram broadcast)
  PAPER_TRADE: 'paper_trade',

  // Orchestrator → All workers (health check)
  HEARTBEAT_PING: 'heartbeat_ping',

  // All workers → Orchestrator (health response)
  HEARTBEAT_PONG: 'heartbeat_pong',

  // Workers → Orchestrator → API (APM metrics snapshot)
  METRICS_UPDATE: 'metrics_update',

  // Orchestrator → All workers (graceful shutdown)
  SHUTDOWN: 'shutdown',

  // Order manager → Orchestrator → API (SSE broadcast)
  ORDER_UPDATE: 'order_update',

  // Risk engine → Orchestrator → All workers + API
  KILL_SWITCH: 'kill_switch',
};

/**
 * Send a typed message to the parent process (orchestrator).
 * Silently no-ops if process.send is not available (standalone mode / tests).
 *
 * @param {string} type - One of MSG.* constants
 * @param {*} [data=null] - Payload to send
 */
function sendToParent(type, data = null) {
  if (process.send) {
    try {
      process.send({ type, data, ts: Date.now() });
    } catch (_) {
      // Parent may have disconnected — safe to ignore
    }
  }
}

/**
 * Install a standard IPC listener for heartbeat + shutdown on a worker process.
 * Call this once in each worker's init.
 *
 * @param {function} [onShutdown] - Optional custom shutdown handler
 * @param {function} [onMessage] - Optional handler for other message types
 */
function installWorkerIPC(onShutdown, onMessage) {
  if (!process.send) return; // Not a forked child — skip

  process.on('message', (msg) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case MSG.HEARTBEAT_PING:
        sendToParent(MSG.HEARTBEAT_PONG);
        break;
      case MSG.SHUTDOWN:
        if (onShutdown) onShutdown();
        else process.exit(0);
        break;
      default:
        if (onMessage) onMessage(msg);
        break;
    }
  });
}

module.exports = { MSG, sendToParent, installWorkerIPC };
