-- TC-27 S2: a debit that is not a token count, and the key it has to hang off.
--
-- WHY THE ACCOUNT TABLES ARE IN THIS MIGRATION AND NOT S1'S. A journal is the one table
-- you cannot cheaply re-key afterwards: it is append-only, it is financial, and "merge
-- these two balances" has no good answer once real money has moved through both. So the
-- key comes first even though the slice is about the debit. What stays with S1 is the
-- public API shape, the rename of the `namespace` parameter, and the linking flow.
--
-- THE KEY PROBLEM THIS SOLVES. `billing` stores the same string in user_id AND namespace,
-- and that string means AGERI'S TENANT. terminal-connect namespaces live in the same
-- shape of string, so one day `huy` on one product and `huy` on the other would silently
-- share a wallet. The ledger now owns its own identifier and every service reaches it
-- through a link.

-- The holder. Owned by the ledger, referenced by nobody else's primary key.
CREATE TABLE IF NOT EXISTS credit_account (
  id          TEXT PRIMARY KEY,           -- "ca_" + 24 hex
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The doors. A LINK IS ALSO AN AUTHORIZATION: a service may only act on accounts that
-- have linked it, so one compromised service cannot reach every wallet in the system.
CREATE TABLE IF NOT EXISTS account_link (
  service              TEXT NOT NULL,     -- "ageri" | "terminal-connect" | "taplo"
  service_identity_id  TEXT NOT NULL,     -- that service's OWN id for the person
  account_id           TEXT NOT NULL REFERENCES credit_account(id),
  granted_at           TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (service, service_identity_id)
);
CREATE INDEX IF NOT EXISTS account_link_by_account ON account_link(account_id);

-- The journal. ONE append-only stream, never a table per kind: two tables make "what is
-- my balance" a union and force every debit to choose where to write.
--
-- delta is SIGNED, in credits, and a credit is one US cent (vietqr.ts TIERS: $5 = 500).
-- kind is financial, not cosmetic: `purchased` is money taken and possibly refundable,
-- `promotional` is a marketing expense that is never withdrawable and never payout
-- eligible. It is recorded, never derived.
--
-- scope is NULL for credits spendable anywhere, or a service name for a grant that must
-- not leak - the three free months on one product should not buy LLM tokens on another.
--
-- idem_key is what makes a retried charge safe. The grant side has had this since day one
-- (billing_transactions.paddle_transaction_id is UNIQUE); the debit side had no path at
-- all, and a renewal that charges twice is a support incident with a refund attached.
CREATE TABLE IF NOT EXISTS entry (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL REFERENCES credit_account(id),
  delta       INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('purchased', 'promotional')),
  scope       TEXT,
  service     TEXT,                       -- which service caused it, for attribution
  reason      TEXT NOT NULL,              -- 'namespace_year' | 'licence' | 'seats' | ...
  ref         TEXT,                       -- the thing bought, e.g. a namespace or a code
  idem_key    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ONE TRANSACTION MAY WRITE SEVERAL ENTRIES, because a 50 credit charge against 30
-- promotional and 100 purchased draws from both. So the unit of idempotency is the
-- CHARGE and the unit of record is the BUCKET it drew from.
--
-- THE BUCKET IS (kind, scope), NOT kind - found by a test, not by thinking. A charge can
-- draw from two buckets of the SAME kind: a promotional grant scoped to one service and
-- an unscoped one. Keyed on (idem_key, kind) the second leg collides with the first and
-- the whole charge is refused.
--
-- AND COALESCE IS NOT DECORATION. SQLite treats NULLs as distinct in a UNIQUE index, so
-- (idem, 'promotional', NULL) twice would BOTH be allowed - idempotency would hold for
-- scoped credits and quietly not for unscoped ones, which is most of them. Folding NULL
-- to '' in the index expression is what makes the guarantee uniform.
--
-- The partial WHERE is what lets the opening balances below keep a NULL idem_key without
-- colliding with each other.
CREATE UNIQUE INDEX IF NOT EXISTS entry_idem
  ON entry(idem_key, kind, COALESCE(scope, '')) WHERE idem_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS entry_by_account ON entry(account_id, kind, scope);

-- BACKFILL. Every existing billing row becomes an account with one Ageri link, and its
-- current balance becomes an opening entry, so the journal can account for every credit
-- the system has ever held rather than starting from today and disagreeing with the
-- column for ever. 'ca_' || the namespace is a deterministic id, so re-running this
-- migration cannot mint a second account for the same tenant.
INSERT OR IGNORE INTO credit_account (id)
  SELECT 'ca_' || namespace FROM billing;

INSERT OR IGNORE INTO account_link (service, service_identity_id, account_id)
  SELECT 'ageri', namespace, 'ca_' || namespace FROM billing;

INSERT INTO entry (account_id, delta, kind, service, reason, idem_key)
  SELECT 'ca_' || namespace, credits, 'purchased', 'ageri', 'opening_balance',
         'opening:' || namespace
  FROM billing
  WHERE credits <> 0
    AND NOT EXISTS (SELECT 1 FROM entry e WHERE e.idem_key = 'opening:' || billing.namespace);
