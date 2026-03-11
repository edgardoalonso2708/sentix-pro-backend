// =============================================================================
// SENTIX PRO — Signal Accuracy Tracking
// Records signal predictions and checks actual price movement at 1h, 4h, 24h
// to measure directional accuracy by strength, confidence, and confluence.
// =============================================================================

const { LRUCache } = require('./shared/lruCache');
const { logger } = require('./logger');

// Deduplication: prevent recording the same signal twice within 30 min
const recentSignals = new LRUCache({
  maxSize: 200,
  ttl: 30 * 60 * 1000, // 30 min
  name: 'signal-dedup'
});

// Time windows to check (column suffix → milliseconds)
const TIME_WINDOWS = [
  { suffix: '1h',  ms: 60 * 60 * 1000 },
  { suffix: '4h',  ms: 4 * 60 * 60 * 1000 },
  { suffix: '24h', ms: 24 * 60 * 60 * 1000 }
];

const BATCH_LIMIT = 50;

// =============================================================================
// RECORD — insert a new signal outcome row (BUY/SELL only)
// =============================================================================

async function recordSignalOutcome(supabase, signal) {
  try {
    if (!signal || signal.action === 'HOLD') return;
    if (!signal.asset || !signal.price) return;

    const dedupKey = `${signal.asset}:${signal.action}`;
    if (recentSignals.has(dedupKey)) return;

    const confluence = signal.timeframes?.confluence || null;

    const { error } = await supabase.from('signal_outcomes').insert({
      asset: signal.asset,
      action: signal.action,
      strength_label: signal.strengthLabel || signal.action,
      raw_score: signal.rawScore || 0,
      confidence: signal.confidence || 0,
      confluence,
      price_at_signal: signal.price,
      signal_generated_at: signal.timestamp || new Date().toISOString()
    });

    if (error) {
      if (error.code === '42P01') {
        logger.debug('signal_outcomes table not yet created');
      } else {
        logger.warn('Signal outcome insert failed', { error: error.message });
      }
      return;
    }

    recentSignals.set(dedupKey, true);
    logger.debug('Signal outcome recorded', { asset: signal.asset, action: signal.action });
  } catch (err) {
    logger.debug('Signal outcome recording failed', { error: err.message });
  }
}

// =============================================================================
// CHECK — fill in price_Xh for pending outcomes
// =============================================================================

async function checkPendingOutcomes(supabase, getCurrentPrice) {
  try {
    for (const { suffix, ms } of TIME_WINDOWS) {
      const cutoff = new Date(Date.now() - ms).toISOString();
      const priceCol = `price_${suffix}`;
      const correctCol = `direction_correct_${suffix}`;
      const changeCol = `change_pct_${suffix}`;

      // Find rows where this window hasn't been filled yet and enough time has passed
      const { data: pending, error } = await supabase
        .from('signal_outcomes')
        .select('id, asset, action, price_at_signal')
        .is(priceCol, null)
        .lte('signal_generated_at', cutoff)
        .order('signal_generated_at', { ascending: true })
        .limit(BATCH_LIMIT);

      if (error) {
        if (error.code === '42P01') return; // table doesn't exist yet
        logger.debug(`Pending outcomes query failed (${suffix})`, { error: error.message });
        continue;
      }

      if (!pending || pending.length === 0) continue;

      // Group by asset to minimize price lookups
      const byAsset = {};
      for (const row of pending) {
        if (!byAsset[row.asset]) byAsset[row.asset] = [];
        byAsset[row.asset].push(row);
      }

      for (const [asset, rows] of Object.entries(byAsset)) {
        let currentPrice;
        try {
          currentPrice = await getCurrentPrice(asset);
        } catch {
          logger.debug(`Could not get price for ${asset}`);
          continue;
        }

        if (!currentPrice || currentPrice <= 0) continue;

        for (const row of rows) {
          const entryPrice = parseFloat(row.price_at_signal);
          if (!entryPrice || entryPrice <= 0) continue;

          const changePct = ((currentPrice - entryPrice) / entryPrice) * 100;
          const isBuy = row.action === 'BUY' || row.action === 'STRONG BUY';
          const directionCorrect = isBuy ? changePct > 0 : changePct < 0;

          const { error: updateError } = await supabase
            .from('signal_outcomes')
            .update({
              [priceCol]: currentPrice,
              [correctCol]: directionCorrect,
              [changeCol]: Math.round(changePct * 10000) / 10000
            })
            .eq('id', row.id);

          if (updateError) {
            logger.debug(`Outcome update failed (${suffix})`, { id: row.id, error: updateError.message });
          }
        }
      }

      const filled = pending.length;
      if (filled > 0) {
        logger.debug(`Checked ${suffix} outcomes`, { filled });
      }
    }
  } catch (err) {
    logger.debug('checkPendingOutcomes failed', { error: err.message });
  }
}

// =============================================================================
// METRICS — aggregate accuracy stats for the API
// =============================================================================

async function getAccuracyMetrics(supabase, { days = 30, asset = null } = {}) {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    let query = supabase
      .from('signal_outcomes')
      .select('*')
      .gte('signal_generated_at', since)
      .not('price_1h', 'is', null) // at least 1h has been checked
      .order('signal_generated_at', { ascending: false });

    if (asset) {
      query = query.eq('asset', asset);
    }

    const { data, error } = await query;

    if (error) {
      if (error.code === '42P01') return { overall: null, message: 'Table not created yet' };
      throw error;
    }

    if (!data || data.length === 0) {
      return {
        overall: { total: 0, hitRate1h: null, hitRate4h: null, hitRate24h: null },
        byStrength: {},
        byConfidenceTier: {},
        byConfluence: {},
        byAsset: {},
        trend: []
      };
    }

    // --- Overall ---
    const overall = computeHitRates(data);

    // --- By strength_label ---
    const byStrength = {};
    for (const row of data) {
      const key = row.strength_label || 'UNKNOWN';
      if (!byStrength[key]) byStrength[key] = [];
      byStrength[key].push(row);
    }
    for (const key of Object.keys(byStrength)) {
      byStrength[key] = computeHitRates(byStrength[key]);
    }

    // --- By confidence tier ---
    const tiers = { 'low (0-30)': [], 'mid (30-60)': [], 'high (60-85)': [], 'very high (85+)': [] };
    for (const row of data) {
      const c = row.confidence || 0;
      if (c < 30) tiers['low (0-30)'].push(row);
      else if (c < 60) tiers['mid (30-60)'].push(row);
      else if (c < 85) tiers['high (60-85)'].push(row);
      else tiers['very high (85+)'].push(row);
    }
    const byConfidenceTier = {};
    for (const [tier, rows] of Object.entries(tiers)) {
      if (rows.length > 0) byConfidenceTier[tier] = computeHitRates(rows);
    }

    // --- By confluence ---
    const byConfluence = {};
    for (const row of data) {
      const key = row.confluence || 'unknown';
      if (!byConfluence[key]) byConfluence[key] = [];
      byConfluence[key].push(row);
    }
    for (const key of Object.keys(byConfluence)) {
      byConfluence[key] = computeHitRates(byConfluence[key]);
    }

    // --- By asset ---
    const byAsset = {};
    for (const row of data) {
      if (!byAsset[row.asset]) byAsset[row.asset] = [];
      byAsset[row.asset].push(row);
    }
    for (const key of Object.keys(byAsset)) {
      byAsset[key] = computeHitRates(byAsset[key]);
    }

    // --- Daily trend ---
    const dailyBuckets = {};
    for (const row of data) {
      const day = row.signal_generated_at.substring(0, 10); // YYYY-MM-DD
      if (!dailyBuckets[day]) dailyBuckets[day] = [];
      dailyBuckets[day].push(row);
    }
    const trend = Object.entries(dailyBuckets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, rows]) => {
        const rates = computeHitRates(rows);
        return { date, ...rates };
      });

    return { overall, byStrength, byConfidenceTier, byConfluence, byAsset, trend };
  } catch (err) {
    logger.warn('getAccuracyMetrics failed', { error: err.message });
    return { error: err.message };
  }
}

// --- Helper: compute hit rates from a set of outcome rows ---
function computeHitRates(rows) {
  const total = rows.length;
  let correct1h = 0, total1h = 0;
  let correct4h = 0, total4h = 0;
  let correct24h = 0, total24h = 0;
  let sumChange1h = 0, sumChange4h = 0, sumChange24h = 0;

  for (const r of rows) {
    if (r.direction_correct_1h !== null && r.direction_correct_1h !== undefined) {
      total1h++;
      if (r.direction_correct_1h) correct1h++;
      sumChange1h += Math.abs(parseFloat(r.change_pct_1h) || 0);
    }
    if (r.direction_correct_4h !== null && r.direction_correct_4h !== undefined) {
      total4h++;
      if (r.direction_correct_4h) correct4h++;
      sumChange4h += Math.abs(parseFloat(r.change_pct_4h) || 0);
    }
    if (r.direction_correct_24h !== null && r.direction_correct_24h !== undefined) {
      total24h++;
      if (r.direction_correct_24h) correct24h++;
      sumChange24h += Math.abs(parseFloat(r.change_pct_24h) || 0);
    }
  }

  return {
    total,
    hitRate1h: total1h > 0 ? Math.round((correct1h / total1h) * 10000) / 100 : null,
    hitRate4h: total4h > 0 ? Math.round((correct4h / total4h) * 10000) / 100 : null,
    hitRate24h: total24h > 0 ? Math.round((correct24h / total24h) * 10000) / 100 : null,
    avgChange1h: total1h > 0 ? Math.round((sumChange1h / total1h) * 100) / 100 : null,
    avgChange4h: total4h > 0 ? Math.round((sumChange4h / total4h) * 100) / 100 : null,
    avgChange24h: total24h > 0 ? Math.round((sumChange24h / total24h) * 100) / 100 : null
  };
}

module.exports = {
  recordSignalOutcome,
  checkPendingOutcomes,
  getAccuracyMetrics
};
