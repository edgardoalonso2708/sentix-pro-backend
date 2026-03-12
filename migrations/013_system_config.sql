-- ═══════════════════════════════════════════════════════════════════════════════
-- 013: System Configuration Table
-- Centralizes hardcoded values (slippage, thresholds, etc.) into a key-value store.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS system_config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- ─── Seed default values ─────────────────────────────────────────────────────

INSERT INTO system_config (key, value, description) VALUES
  ('slippage_by_asset', '{
    "bitcoin": 0.0005, "ethereum": 0.0008,
    "binancecoin": 0.0010, "solana": 0.0012, "ripple": 0.0012,
    "cardano": 0.0015, "dogecoin": 0.0015, "matic-network": 0.0015,
    "chainlink": 0.0015, "avalanche-2": 0.0018, "polkadot": 0.0018,
    "litecoin": 0.0012, "tron": 0.0015,
    "uniswap": 0.0020, "near": 0.0020,
    "aptos": 0.0025, "arbitrum": 0.0025, "optimism": 0.0025, "sui": 0.0025,
    "pax-gold": 0.0020, "gold": 0.0020, "silver": 0.0025,
    "_default": 0.0020, "_commission": 0.0010
  }'::jsonb, 'Per-asset slippage + commission rates for trade execution simulation'),

  ('hour_liquidity_mult', '{
    "0": 1.30, "1": 1.40, "2": 1.50, "3": 1.50, "4": 1.40,
    "5": 1.20, "6": 1.10, "7": 1.00, "8": 0.90, "9": 0.85,
    "10": 0.80, "11": 0.80, "12": 0.85, "13": 0.75, "14": 0.75,
    "15": 0.80, "16": 0.85, "17": 0.90, "18": 0.95, "19": 1.00,
    "20": 1.05, "21": 1.10, "22": 1.15, "23": 1.25
  }'::jsonb, 'Time-of-day liquidity multiplier for slippage (UTC hours)'),

  ('heat_thresholds', '{
    "slProximityPct": 2.0,
    "winnerGiveBackPct": 50,
    "holdingTimeWarnPct": 70,
    "drawdownFromPeakPct": 30,
    "largeUnrealizedLossPct": -5.0
  }'::jsonb, 'Position heat map anomaly detection thresholds'),

  ('alert_thresholds', '{
    "staleWarnMs": 300000,
    "stalePauseMs": 1800000,
    "anomalyCooldownMs": 1800000
  }'::jsonb, 'Alert system thresholds (price freshness, anomaly cooldowns)'),

  ('circuit_breaker', '{
    "failureThreshold": 3,
    "resetTimeoutMs": 60000,
    "windowMs": 30000
  }'::jsonb, 'Circuit breaker settings per provider (failures, reset timeout, window)')

ON CONFLICT (key) DO NOTHING;
