-- VietQR order tracking
-- order_id = namespace:tier  (one order per namespace+tier, TTL 10 min)
CREATE TABLE IF NOT EXISTS vietqr_orders (
  order_id    TEXT PRIMARY KEY,
  namespace   TEXT NOT NULL,
  tier        INTEGER NOT NULL,
  amount_vnd  INTEGER NOT NULL,
  credits     INTEGER NOT NULL,
  qr_link     TEXT,
  paid        INTEGER DEFAULT 0,
  txn_id      TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  paid_at     TEXT
);
