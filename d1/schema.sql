-- ageri-services D1 schema
-- Deployed to Cloudflare D1, shared across all Workers via binding

CREATE TABLE IF NOT EXISTS billing (
    user_id            TEXT PRIMARY KEY,
    namespace          TEXT NOT NULL UNIQUE,
    credits            INTEGER NOT NULL DEFAULT 0,
    auto_reload        INTEGER NOT NULL DEFAULT 0,
    auto_reload_price  TEXT,
    subscription_id    TEXT,
    updated_at         TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS billing_transactions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id               TEXT NOT NULL,
    paddle_transaction_id TEXT NOT NULL UNIQUE,
    price_id              TEXT,
    credits_granted       INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subkeys (
    key_id          TEXT PRIMARY KEY,         -- "agk_huy_abc123..."
    user_id         TEXT NOT NULL,
    refresh_token   TEXT NOT NULL UNIQUE,
    expires_at      TEXT NOT NULL,
    created_at      TEXT DEFAULT (datetime('now')),
    revoked         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_subkeys_user ON subkeys(user_id);
CREATE INDEX IF NOT EXISTS idx_subkeys_refresh ON subkeys(refresh_token);

CREATE TABLE IF NOT EXISTS usage_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          TEXT NOT NULL,
    key_id           TEXT NOT NULL,
    model            TEXT NOT NULL,
    input_tokens     INTEGER NOT NULL DEFAULT 0,
    output_tokens    INTEGER NOT NULL DEFAULT 0,
    credits_deducted INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_log(user_id, created_at);
