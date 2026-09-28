-- TC-27: which areas accept which kinds of credit.
--
-- THE SAME RULE FROM THE OTHER END, AND BOTH ENDS ARE WORTH HAVING. `scope` on a grant says
-- where that grant may be spent, and its failure mode is a grant issued too WIDE - somebody
-- mints an unscoped promotional batch and it can suddenly pay a marketplace author. This
-- table says which kinds an AREA accepts at all, whoever granted them and however they were
-- scoped, and its failure mode is an area added without declaring itself. Those two mistakes
-- are independent, which is exactly why a mis-scoped grant still cannot settle a third
-- party's invoice.
--
-- huy, 2026-09-28: "the promotional credit type ... is useful in Ageri where we give out some
-- free credits for new users to try with LLM calls, but cannot be used in the marketplace or
-- our shared host ... we scope that ... which areas we accept the promotional credit type."
--
-- WHY THE LEDGER OWNS THIS AND NOT THE CALLER. A service that declares its own acceptance is
-- no protection: a buggy or compromised caller would simply say yes. And unlike PRICES, which
-- belong to the seller because "10 credits a day" is product knowledge, this is the ledger's
-- own business - it is about the financial nature of the money. The journal already asserts
-- that promotional credits are never withdrawable and never payout eligible; "and they cannot
-- settle an obligation to a third party" is the same axis.
--
-- DENY BY DEFAULT, for the reason the billing gate was inverted in S1: an area that has not
-- declared itself refuses promotional credits, so FORGETTING PRODUCES A REFUSAL RATHER THAN
-- AN OPENING. Purchased and earned are unaffected by an absent row, because those are the
-- customer's own money and ours to owe - it is the gift that needs permission.
--
-- NOW IS THE CHEAP MOMENT. The live journal holds exactly one entry and it is `purchased`.
-- There are no promotional credits anywhere yet, so switching to deny-by-default breaks
-- nothing. Once Ageri hands out trial credits this becomes a migration with live money in it.

CREATE TABLE IF NOT EXISTS area_policy (
  service   TEXT NOT NULL,
  resource  TEXT NOT NULL,
  -- The kinds this area accepts, comma separated. PRESENT means exactly these; ABSENT means
  -- the default (purchased and earned). Stored as one row rather than a row per kind so that
  -- a partial declaration cannot silently deny a kind somebody forgot to list.
  kinds     TEXT NOT NULL,
  note      TEXT,
  PRIMARY KEY (service, resource)
);

-- WHERE A GIFT MAY BE SPENT. Both of these cost us our own infrastructure and nothing else,
-- which is the test: a promotional credit may buy OUR resources, never a third party's
-- labour.
INSERT OR IGNORE INTO area_policy (service, resource, kinds, note) VALUES
  ('ageri', 'llm', 'purchased,promotional,earned',
   'Trial credits for new users to try LLM calls - the cost is ours'),
  ('terminal-connect', 'namespace', 'purchased,promotional,earned',
   'Gift codes buy namespace time - we hold a DNS record and route it');

-- THE REFUSALS ARE WRITTEN DOWN EVEN THOUGH THE DEFAULT ALREADY REFUSES, because "the
-- marketplace does not accept promotional credits" is a decision somebody should be able to
-- FIND, and a row carrying its reason is easier to find than the absence of one.
INSERT OR IGNORE INTO area_policy (service, resource, kinds, note) VALUES
  ('ageri', 'marketplace', 'purchased,earned',
   'An author is paid real money - a gift here is our marketing budget settling their invoice'),
  ('terminal-connect', 'marketplace', 'purchased,earned',
   'An author is paid real money - a gift here is our marketing budget settling their invoice'),
  ('terminal-connect', 'host', 'purchased,earned',
   'The shared host is metered compute with a real marginal cost per hour');
