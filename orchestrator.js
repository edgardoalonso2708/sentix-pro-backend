// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — ORCHESTRATOR
// Process manager that forks and coordinates worker processes.
// Entry point for production: `node orchestrator.js`
// ═══════════════════════════════════════════════════════════════════════════════

require('dotenv').config();

const { fork } = require('child_process');
const path = require('path');
const { MSG } = require('./shared/ipc');

// ─── CONFIGURATION ────────────────────────────────────────────────────────
const MAX_RESTARTS = 10;
const RESTART_WINDOW = 60000;   // Reset restart counter after 60s of stability
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;
const SHUTDOWN_TIMEOUT = 8000;

// ─── WORKER DEFINITIONS ──────────────────────────────────────────────────
const WORKERS = {
  api: {
    script: path.join(__dirname, 'api.js'),
    process: null,
    restarts: 0,
    lastRestart: 0,
    lastHeartbeat: Date.now(),
    label: 'API Server'
  },
  market: {
    script: path.join(__dirname, 'workers', 'market.js'),
    process: null,
    restarts: 0,
    lastRestart: 0,
    lastHeartbeat: Date.now(),
    label: 'Market Worker'
  },
  alerts: {
    script: path.join(__dirname, 'workers', 'alerts.js'),
    process: null,
    restarts: 0,
    lastRestart: 0,
    lastHeartbeat: Date.now(),
    label: 'Alerts Worker'
  }
};

let shuttingDown = false;

// Simple logger (avoid importing full logger to keep orchestrator lightweight)
function log(level, msg, data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: `[orchestrator] ${msg}`,
    ...(Object.keys(data).length > 0 ? { data } : {})
  };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

function spawnWorker(name) {
  const config = WORKERS[name];

  const child = fork(config.script, [], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env, WORKER_NAME: name }
  });

  child.on('message', (msg) => handleWorkerMessage(name, msg));

  child.on('exit', (code, signal) => {
    log('warn', `${config.label} exited`, { name, code, signal, pid: config.process?.pid });
    config.process = null;

    if (shuttingDown) return;

    // Reset restart counter if worker was stable for RESTART_WINDOW
    if (Date.now() - config.lastRestart > RESTART_WINDOW) {
      config.restarts = 0;
    }

    if (config.restarts < MAX_RESTARTS) {
      config.restarts++;
      const delay = Math.min(1000 * Math.pow(2, config.restarts - 1), 30000);
      log('info', `Restarting ${config.label} in ${delay}ms`, {
        name,
        attempt: config.restarts,
        maxRestarts: MAX_RESTARTS
      });
      setTimeout(() => {
        if (!shuttingDown) {
          config.lastRestart = Date.now();
          spawnWorker(name);
        }
      }, delay);
    } else {
      log('error', `${config.label} exceeded max restarts, NOT restarting`, {
        name,
        restarts: config.restarts
      });
    }
  });

  child.on('error', (err) => {
    log('error', `${config.label} process error`, { name, error: err.message });
  });

  config.process = child;
  log('info', `${config.label} started`, { name, pid: child.pid });
}

// ═══════════════════════════════════════════════════════════════════════════════
// IPC MESSAGE ROUTING
// ═══════════════════════════════════════════════════════════════════════════════

function handleWorkerMessage(fromWorker, msg) {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case MSG.MARKET_UPDATE:
      // Fan out: market data goes to both API (for SSE) and alerts (for signal gen)
      sendTo('api', msg);
      sendTo('alerts', msg);
      break;

    case MSG.SIGNALS_UPDATE:
      // Forward to API for SSE broadcast
      sendTo('api', msg);
      break;

    case MSG.PAPER_TRADE:
      // Forward to API for SSE broadcast + Telegram notifications
      sendTo('api', msg);
      break;

    case MSG.HEARTBEAT_PONG:
      if (WORKERS[fromWorker]) {
        WORKERS[fromWorker].lastHeartbeat = Date.now();
      }
      break;

    case MSG.METRICS_UPDATE:
      // Forward worker metrics to API for aggregation
      sendTo('api', { ...msg, worker: fromWorker });
      break;

    default:
      // Unknown message type — log and ignore
      break;
  }
}

function sendTo(workerName, msg) {
  const worker = WORKERS[workerName];
  if (worker && worker.process && worker.process.connected) {
    try {
      worker.process.send(msg);
    } catch (_) {
      // Worker may have disconnected — safe to ignore
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEALTH MONITORING
// ═══════════════════════════════════════════════════════════════════════════════

const heartbeatTimer = setInterval(() => {
  if (shuttingDown) return;

  for (const [name, config] of Object.entries(WORKERS)) {
    // Send ping
    if (config.process && config.process.connected) {
      try {
        config.process.send({ type: MSG.HEARTBEAT_PING, ts: Date.now() });
      } catch (_) {}
    }

    // Check for timeout (only warn, don't kill — the worker might be busy)
    const timeSinceHeartbeat = Date.now() - config.lastHeartbeat;
    if (config.process && timeSinceHeartbeat > HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT) {
      log('warn', `${config.label} heartbeat timeout`, {
        name,
        lastHeartbeatMs: timeSinceHeartbeat
      });
    }
  }
}, HEARTBEAT_INTERVAL);

// ═══════════════════════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════════

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log('info', `${signal} received, shutting down all workers`);

  clearInterval(heartbeatTimer);

  // Send shutdown message to all workers
  for (const [name, config] of Object.entries(WORKERS)) {
    if (config.process && config.process.connected) {
      try {
        config.process.send({ type: MSG.SHUTDOWN });
      } catch (_) {}
    }
  }

  // Force kill after timeout
  setTimeout(() => {
    for (const [name, config] of Object.entries(WORKERS)) {
      if (config.process) {
        log('warn', `Force killing ${config.label}`, { name });
        try { config.process.kill('SIGKILL'); } catch (_) {}
      }
    }
    log('info', 'Orchestrator shutdown complete');
    process.exit(0);
  }, SHUTDOWN_TIMEOUT);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log('error', 'Unhandled rejection', { reason: reason?.message || String(reason) });
});

process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception', { error: err.message, stack: err.stack });
  shutdown('UNCAUGHT_EXCEPTION');
});

// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════════

log('info', 'SENTIX PRO Orchestrator starting', {
  workers: Object.keys(WORKERS),
  nodeVersion: process.version,
  pid: process.pid
});

// Spawn all workers
for (const name of Object.keys(WORKERS)) {
  spawnWorker(name);
}

log('info', 'All workers spawned');
