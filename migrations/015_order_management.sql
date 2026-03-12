-- ═══════════════════════════════════════════════════════════════════════════════
-- 015: Order Management & Execution Audit Trail
-- Introduces orders as first-class entities separate from trades.
-- Orders go through a lifecycle (PENDING → VALIDATED → SUBMITTED → FILLED)
-- before becoming trades. Execution log provides full audit trail.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Orders table ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,

  -- Order identification
  client_order_id TEXT UNIQUE,                    -- Idempotency key
  parent_order_id UUID REFERENCES orders(id),     -- For OCO / bracket orders

  -- Instrument
  asset TEXT NOT NULL,
  asset_class TEXT NOT NULL DEFAULT 'crypto',

  -- Order specification
  side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type TEXT NOT NULL CHECK (order_type IN ('MARKET', 'LIMIT', 'STOP_LIMIT')),
  quantity NUMERIC(20, 8) NOT NULL,
  price NUMERIC(20, 8),                           -- Limit price (NULL for MARKET)
  stop_price NUMERIC(20, 8),                      -- Trigger price for STOP_LIMIT
  time_in_force TEXT NOT NULL DEFAULT 'GTC'
    CHECK (time_in_force IN ('GTC', 'IOC', 'FOK', 'GTD')),
  expire_at TIMESTAMPTZ,                          -- For GTD orders

  -- Trade levels (from signal or manual entry)
  stop_loss NUMERIC(20, 8),
  take_profit_1 NUMERIC(20, 8),
  take_profit_2 NUMERIC(20, 8),
  trailing_stop_pct NUMERIC(5, 2),
  trailing_activation NUMERIC(20, 8),

  -- Position sizing
  position_size_usd NUMERIC(20, 2),
  risk_amount NUMERIC(20, 2),

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'VALIDATED', 'SUBMITTED', 'PARTIAL_FILL',
                       'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED')),
  filled_quantity NUMERIC(20, 8) DEFAULT 0,
  avg_fill_price NUMERIC(20, 8),
  reject_reason TEXT,

  -- Source tracking
  source TEXT NOT NULL DEFAULT 'signal'
    CHECK (source IN ('signal', 'manual', 'bracket', 'system')),
  signal_id TEXT,
  signal_snapshot JSONB,

  -- Execution adapter
  execution_adapter TEXT NOT NULL DEFAULT 'paper',
  exchange_order_id TEXT,                         -- External exchange order ID (future)

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  validated_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  filled_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Execution audit log ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS execution_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  trade_id UUID REFERENCES paper_trades(id),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'ORDER_CREATED', 'ORDER_VALIDATED', 'ORDER_REJECTED',
    'ORDER_SUBMITTED', 'ORDER_PARTIAL_FILL', 'ORDER_FILLED',
    'ORDER_CANCELLED', 'ORDER_EXPIRED',
    'TRADE_OPENED', 'TRADE_PARTIAL_CLOSE', 'TRADE_CLOSED',
    'RISK_CHECK_PASS', 'RISK_CHECK_FAIL', 'KILL_SWITCH'
  )),
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─── Link orders to trades ────────────────────────────────────────────────────

ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS order_id UUID REFERENCES orders(id);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_orders_user_status ON orders(user_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_client_id ON orders(client_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_asset ON orders(asset, status);
CREATE INDEX IF NOT EXISTS idx_exec_log_order ON execution_log(order_id);
CREATE INDEX IF NOT EXISTS idx_exec_log_type ON execution_log(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_paper_trades_order ON paper_trades(order_id);
