// TC-27: which areas accept which kinds of credit.
//
// THE SAME RULE FROM THE OTHER END. `scope` on a grant guards against a grant issued too
// WIDE; `area_policy` guards against an AREA that should never see a gift at all. Those two
// mistakes are independent, so both mechanisms exist and a mis-scoped promotional grant still
// cannot settle a marketplace author's invoice.
//
// huy, 2026-09-28: promotional credits are useful in Ageri for new users to try LLM calls,
// "but cannot be used in the marketplace or our shared host".

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BillingStore } from "../store";

const store = new BillingStore(env.DB);
let seq = 0;
const who = () => `p${Date.now().toString(36)}${seq++}`;

/** An account holding one unscoped bucket of the given kind, so only the POLICY is in play. */
async function holding(kind: "purchased" | "promotional" | "earned", credits = 500) {
  const account = await store.accountFor("terminal-connect", who());
  await store.grant({ accountId: account, credits, kind, reason: "seed", idemKey: who() });
  return account;
}

const buy = (account: string, service: string, resource: string | null, amount = 100) =>
  store.spend({ accountId: account, service, resource, amount, reason: "test", idemKey: who() });

describe("an area decides which money it takes", () => {
  it("lets a gift buy LLM calls, which is what trial credits are for", async () => {
    const account = await store.accountFor("ageri", who());
    await store.grant({ accountId: account, credits: 500, kind: "promotional", reason: "trial", idemKey: who() });
    const out = await buy(account, "ageri", "llm");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.spent).toEqual([{ kind: "promotional", credits: 100 }]);
  });

  // THE CASE THE POLICY EXISTS FOR. An author is paid real money, so a gift spent here is our
  // marketing budget settling somebody else's invoice.
  it("refuses a gift in the marketplace", async () => {
    const account = await holding("promotional");
    const out = await buy(account, "terminal-connect", "marketplace");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out).toMatchObject({ error: "insufficient", balance: 0 });
  });

  it("refuses a gift on the shared host, which has a real marginal cost", async () => {
    const account = await holding("promotional");
    const out = await buy(account, "terminal-connect", "host");
    expect(out.ok).toBe(false);
  });

  // DENY BY DEFAULT: an area nobody has declared refuses a gift, so FORGETTING TO DECLARE A
  // NEW AREA PRODUCES A REFUSAL RATHER THAN AN OPENING. Same inversion as the request gate.
  it("refuses a gift in an area nobody has declared", async () => {
    const account = await holding("promotional");
    const out = await buy(account, "terminal-connect", "something_invented_later");
    expect(out.ok).toBe(false);
  });

  // ABSENCE IS MEANINGFUL, exactly as it is for scope: a caller that will not say what it is
  // buying gets the narrowest thing that could be true.
  it("refuses a gift when the spend declares no area at all", async () => {
    const account = await holding("promotional");
    const out = await buy(account, "terminal-connect", null);
    expect(out.ok).toBe(false);
  });

  // ...AND THE DEFAULT ONLY DENIES THE GIFT. Purchased is the customer's own money and earned
  // is money we owe them; neither needs an area's permission, or deny-by-default would have
  // broken every existing charge rather than only the ones it means to.
  it("takes the customer's own money anywhere, declared or not", async () => {
    for (const kind of ["purchased", "earned"] as const) {
      for (const resource of ["marketplace", "host", "never_heard_of_it", null]) {
        const account = await holding(kind);
        const out = await buy(account, "terminal-connect", resource);
        expect(out.ok, `${kind} in ${resource ?? "no area"}`).toBe(true);
      }
    }
  });
});

describe("the balance agrees with the charge", () => {
  // A BALANCE SCREEN PROMISING CREDITS THE CHARGE THEN REFUSES IS WORSE THAN NO SCREEN, so
  // `spendable` applies the policy as well as the scope - one function, used by both.
  it("does not count a gift towards an area that will not take it", async () => {
    const account = await holding("promotional", 400);
    expect(await store.spendable(account, "terminal-connect", "namespace")).toBe(400);
    expect(await store.spendable(account, "terminal-connect", "marketplace")).toBe(0);
    expect(await store.spendable(account, "terminal-connect", null)).toBe(0);
  });

  it("counts purchased credits everywhere", async () => {
    const account = await holding("purchased", 400);
    expect(await store.spendable(account, "terminal-connect", "marketplace")).toBe(400);
    expect(await store.spendable(account, "terminal-connect", null)).toBe(400);
  });

  // THE NUMBER A CALLER IS SHOWN IS EXACTLY WHAT A CHARGE OF THAT SIZE WILL ACCEPT - spending
  // the promise to the last credit must succeed, and one more must not.
  //
  // A FRESH ACCOUNT PER AREA, because the first version of this test reused one and the
  // namespace pass spent the lot, so the marketplace pass was handed a promise of 0 and
  // "spend nothing" is refused as a bad amount. It read like a policy failure and was a test
  // that had eaten its own subject.
  it("promises only what the charge will honour, to the last credit", async () => {
    for (const [resource, expected] of [["namespace", 500], ["marketplace", 200]] as const) {
      const account = await store.accountFor("terminal-connect", who());
      await store.grant({ accountId: account, credits: 300, kind: "promotional", reason: "gift", idemKey: who() });
      await store.grant({ accountId: account, credits: 200, kind: "purchased", reason: "topup", idemKey: who() });

      const promised = await store.spendable(account, "terminal-connect", resource);
      expect(promised, `${resource}`).toBe(expected);

      const over = await store.spend({
        accountId: account, service: "terminal-connect", resource,
        amount: promised + 1, reason: "one_too_many", idemKey: who() });
      expect(over.ok, `${resource}: one over the promise`).toBe(false);

      const exact = await store.spend({
        accountId: account, service: "terminal-connect", resource,
        amount: promised, reason: "exactly_the_promise", idemKey: who() });
      expect(exact.ok, `${resource}: exactly the promise`).toBe(true);
    }
  });
});

describe("the policy table itself", () => {
  it("is a row per area, and says why", async () => {
    const { results } = await env.DB
      .prepare("SELECT service, resource, kinds, note FROM area_policy ORDER BY service, resource")
      .all<{ service: string; resource: string; kinds: string; note: string }>();
    const byKey = Object.fromEntries(results.map((r) => [`${r.service}:${r.resource}`, r]));
    expect(byKey["ageri:llm"]!.kinds).toContain("promotional");
    expect(byKey["terminal-connect:namespace"]!.kinds).toContain("promotional");
    expect(byKey["terminal-connect:marketplace"]!.kinds).not.toContain("promotional");
    expect(byKey["terminal-connect:host"]!.kinds).not.toContain("promotional");
    // EVERY ROW CARRIES ITS REASON, because "the marketplace refuses gifts" is a decision
    // somebody will need to find, and a row with a note is easier to find than an absence.
    for (const r of results) expect(r.note?.length ?? 0).toBeGreaterThan(10);
  });

  // A ROW THAT SOMEHOW SAYS NOTHING MUST NOT MEAN "ACCEPTS EVERYTHING". This is the parse
  // being defensive about its own data rather than trusting it.
  it("treats an empty kinds list as the default, not as a free pass", async () => {
    await env.DB.prepare("INSERT OR REPLACE INTO area_policy (service, resource, kinds, note) VALUES (?, ?, ?, ?)")
      .bind("terminal-connect", "blankpolicy", "  ,  ", "deliberately malformed").run();
    const account = await holding("promotional");
    expect((await buy(account, "terminal-connect", "blankpolicy")).ok).toBe(false);
    const paid = await holding("purchased");
    expect((await buy(paid, "terminal-connect", "blankpolicy")).ok).toBe(true);
  });
});
