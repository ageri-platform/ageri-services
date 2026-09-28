-- TC-27 S1b: the linking flow. One holder, one balance, several doors.
--
-- WHAT WAS MISSING. `accountFor(service, identity)` mints a SEPARATE account per (service,
-- identity) pair, which is correct on first sight of a stranger and wrong for ever after:
-- the live ledger holds `ageri`/`huy` -> ca_huy with 1100 credits and
-- `terminal-connect`/`id_ksp...` -> a different, empty account. That is why a namespace
-- renewal answered `balance: 0` while the money sat in the same database. Two islands is an
-- unfinished state, not the design.
--
-- WHY A CODE AND NOT A MATCHING EMAIL OR NAME. Ageri knows the person as `huy` and accounts
-- knows them as `id_ksp23i3fe...`. Each service owns its own identity system deliberately, so
-- a matching string is a COINCIDENCE, not evidence - and ledger.test.ts already asserts that
-- two services presenting the same id get two different accounts. Linking therefore has to be
-- an act by somebody who can prove they hold both identities, which is the same shape device
-- enrolment already uses in this product: a short code shown in one place, redeemed in
-- another.

-- A LINK CODE IS A BEARER CREDENTIAL FOR SOMEBODY'S MONEY. Whoever redeems it gains a door
-- into the source account, so it is short-lived, single-use, and stored as a HASH - a leaked
-- backup of this table must not be a pile of working codes. Same discipline as
-- machines.key_hash and sessions.id_hash elsewhere in the product.
CREATE TABLE IF NOT EXISTS link_code (
  code_hash   TEXT PRIMARY KEY,           -- sha256(code), never the code itself
  account_id  TEXT NOT NULL REFERENCES credit_account(id),
  -- Who asked, recorded so a confirmation screen can say "link into your Ageri credits"
  -- rather than naming an opaque ca_ id at the moment somebody decides about their money.
  issued_by   TEXT NOT NULL,              -- the service that minted it
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  -- SPENT, NOT DELETED. A redeemed code is kept so a second attempt can be told "already
  -- used" rather than "no such code": those are different facts, and the difference is what
  -- somebody debugging a failed link needs. The sweep below clears them later.
  redeemed_at INTEGER,
  redeemed_by TEXT                        -- the service that redeemed it
);

CREATE INDEX IF NOT EXISTS link_code_by_account ON link_code(account_id);
CREATE INDEX IF NOT EXISTS link_code_expiry ON link_code(expires_at);
