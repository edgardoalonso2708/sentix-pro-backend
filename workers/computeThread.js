// ═══════════════════════════════════════════════════════════════════════════════
// SENTIX PRO — COMPUTE THREAD ENTRY
// Worker thread that runs a single backtest or optimization job.
// Receives config via workerData, reports progress and result via parentPort.
// ═══════════════════════════════════════════════════════════════════════════════

const { workerData, parentPort } = require('worker_threads');

// Required modules for compute jobs
const { runBacktest } = require('../backtester');
const { runOptimization } = require('../optimizer');

const { jobType, jobId, params } = workerData;

(async () => {
  try {
    let result;

    if (jobType === 'backtest') {
      result = await runBacktest(params);
    } else if (jobType === 'optimize') {
      result = await runOptimization(params);
    } else {
      throw new Error(`Unknown job type: ${jobType}`);
    }

    parentPort.postMessage({ type: 'complete', data: result });
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: err.message, stack: err.stack });
  }
})();
