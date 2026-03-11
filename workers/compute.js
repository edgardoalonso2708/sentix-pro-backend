// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — COMPUTE WORKER POOL
// Manages worker threads for CPU-intensive backtests and optimizations.
// Imported by api.js (not a separate forked process).
// ═══════════════════════════════════════════════════════════════════════════════

const { Worker } = require('worker_threads');
const path = require('path');
const { logger } = require('../logger');

const MAX_CONCURRENT_BACKTESTS = 5;
const MAX_CONCURRENT_OPTIMIZATIONS = 3;
const activeWorkers = new Map(); // jobId -> Worker

let activeBacktestCount = 0;
let activeOptimizeCount = 0;

/**
 * Run a backtest in a dedicated worker thread.
 * Returns a promise that resolves with the result.
 *
 * @param {string} jobId - Unique job identifier
 * @param {object} params - Backtest parameters (passed to runBacktest)
 * @param {function} [onProgress] - Optional progress callback
 * @returns {Promise<object>} Backtest result
 */
function runBacktestInThread(jobId, params, onProgress) {
  if (activeBacktestCount >= MAX_CONCURRENT_BACKTESTS) {
    return Promise.reject(new Error(`Max concurrent backtests (${MAX_CONCURRENT_BACKTESTS}) reached`));
  }

  activeBacktestCount++;

  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'computeThread.js'), {
      workerData: { jobType: 'backtest', jobId, params }
    });

    activeWorkers.set(jobId, worker);

    worker.on('message', (msg) => {
      if (msg.type === 'progress' && onProgress) {
        onProgress(msg.data);
      } else if (msg.type === 'complete') {
        activeWorkers.delete(jobId);
        activeBacktestCount--;
        resolve(msg.data);
      } else if (msg.type === 'error') {
        activeWorkers.delete(jobId);
        activeBacktestCount--;
        reject(new Error(msg.error));
      }
    });

    worker.on('error', (err) => {
      activeWorkers.delete(jobId);
      activeBacktestCount--;
      reject(err);
    });

    worker.on('exit', (code) => {
      if (activeWorkers.has(jobId)) {
        activeWorkers.delete(jobId);
        activeBacktestCount--;
        if (code !== 0) {
          reject(new Error(`Backtest worker exited with code ${code}`));
        }
      }
    });
  });
}

/**
 * Run an optimization in a dedicated worker thread.
 *
 * @param {string} jobId - Unique job identifier
 * @param {object} params - Optimization parameters
 * @param {function} [onProgress] - Optional progress callback
 * @returns {Promise<object>} Optimization result
 */
function runOptimizeInThread(jobId, params, onProgress) {
  if (activeOptimizeCount >= MAX_CONCURRENT_OPTIMIZATIONS) {
    return Promise.reject(new Error(`Max concurrent optimizations (${MAX_CONCURRENT_OPTIMIZATIONS}) reached`));
  }

  activeOptimizeCount++;

  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'computeThread.js'), {
      workerData: { jobType: 'optimize', jobId, params }
    });

    activeWorkers.set(jobId, worker);

    worker.on('message', (msg) => {
      if (msg.type === 'progress' && onProgress) {
        onProgress(msg.data);
      } else if (msg.type === 'complete') {
        activeWorkers.delete(jobId);
        activeOptimizeCount--;
        resolve(msg.data);
      } else if (msg.type === 'error') {
        activeWorkers.delete(jobId);
        activeOptimizeCount--;
        reject(new Error(msg.error));
      }
    });

    worker.on('error', (err) => {
      activeWorkers.delete(jobId);
      activeOptimizeCount--;
      reject(err);
    });

    worker.on('exit', (code) => {
      if (activeWorkers.has(jobId)) {
        activeWorkers.delete(jobId);
        activeOptimizeCount--;
        if (code !== 0) {
          reject(new Error(`Optimize worker exited with code ${code}`));
        }
      }
    });
  });
}

/**
 * Get current concurrency stats.
 */
function getStats() {
  return {
    activeBacktests: activeBacktestCount,
    activeOptimizations: activeOptimizeCount,
    maxBacktests: MAX_CONCURRENT_BACKTESTS,
    maxOptimizations: MAX_CONCURRENT_OPTIMIZATIONS,
    totalActiveWorkers: activeWorkers.size
  };
}

/**
 * Terminate all active worker threads (for graceful shutdown).
 */
function terminateAll() {
  for (const [jobId, worker] of activeWorkers) {
    try {
      worker.terminate();
      logger.info('Terminated compute worker', { jobId });
    } catch (_) {}
  }
  activeWorkers.clear();
  activeBacktestCount = 0;
  activeOptimizeCount = 0;
}

module.exports = {
  runBacktestInThread,
  runOptimizeInThread,
  getStats,
  terminateAll,
  MAX_CONCURRENT_BACKTESTS,
  MAX_CONCURRENT_OPTIMIZATIONS
};
