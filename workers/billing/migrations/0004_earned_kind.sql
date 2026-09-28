-- TC-27 S2a: a third kind of credit, admitted now because SQLite will not admit it later.
--
-- WHY THIS IS A WHOLE TABLE REBUILD FOR ONE WORD. `kind` carries
-- CHECK (kind IN ('purchased', 'promotional')), and SQLite has no ALTER TABLE ... DROP
-- CONSTRAINT: changing a CHECK means creating a new table, copying every row, dropping the
-- old one and renaming. On an append-only financial journal that is the operation you least
-- want to perform. Today the journal holds ONE row, from migration 0003's backfill. In a
-- year it will hold every credit that has ever moved. So the cost of this migration only
-- ever goes up, and the decision behind it only ever gets harder to reverse.
--
-- WHAT `earned` IS FOR, AND WHY IT IS NOT ONE OF THE OTHER TWO. The marketplace pays MCP
-- tool authors in credits (TC-2). An author's balance is neither `purchased` - nobody handed
-- us money for it - nor `promotional`, which is our marketing expense and is explicitly
-- never withdrawable and never payout eligible. It is money WE OWE, and conflating it with
-- either of the others would either overstate revenue or understate a liability.
--
-- NOTHING WRITES IT YET, deliberately. This migration buys the option while it is nearly
-- free. The spend ordering in store.ts is taught about it in the same slice, so that the day
-- the first `earned` row appears it is already sorted correctly rather than silently last.
--
-- `entry` is referenced by no other table (credit_account and account_link reference nothing
-- here, and the direction is entry -> credit_account), so dropping it breaks no foreign key
-- and no PRAGMA juggling is needed. AUTOINCREMENT survives: ids are copied explicitly, which
-- carries sqlite_sequence forward, and RENAME moves its row with the table.

CREATE TABLE entry_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL REFERENCES credit_account(id),
  delta       INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('purchased', 'promotional', 'earned')),
  scope       TEXT,
  service     TEXT,
  reason      TEXT NOT NULL,
  ref         TEXT,
  idem_key    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every column named explicitly, in order, including id and created_at: a journal copied
-- with SELECT * would silently reorder if the two definitions ever drifted, and copying
-- created_at is what stops the rebuild from restamping history as today.
INSERT INTO entry_new (id, account_id, delta, kind, scope, service, reason, ref, idem_key, created_at)
  SELECT id, account_id, delta, kind, scope, service, reason, ref, idem_key, created_at
  FROM entry;

DROP TABLE entry;
ALTER TABLE entry_new RENAME TO entry;

-- The indexes went with the old table, so they are rebuilt here rather than left implied.
-- Both definitions are copied verbatim from 0003, and entry_idem's COALESCE(scope, '') is
-- load-bearing rather than decorative: SQLite treats NULLs as distinct in a UNIQUE index, so
-- without the fold two (idem, 'promotional', NULL) entries would BOTH be allowed and
-- idempotency would hold for scoped credits and quietly not for unscoped ones.
CREATE UNIQUE INDEX IF NOT EXISTS entry_idem
  ON entry(idem_key, kind, COALESCE(scope, '')) WHERE idem_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS entry_by_account ON entry(account_id, kind, scope);
