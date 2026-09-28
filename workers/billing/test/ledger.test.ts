// TC-27 S2: a debit that is not a token count.
//
// WHAT THIS IS FOR. Before this the ledger had no way out at all except the LLM gateway's
// per-call deduction, which is a stub - so credits had been granted and never once
// consumed, and everything the product decided to sell (a namespace year, a licence,
// seats) had no row shape to live in.
//
// Everything below runs in the Workers runtime against a real local D1 with the real
// migrations applied. The interesting guarantees - entry_idem, the CHECK on kind, the
// partial UNIQUE index - are enforced by SQLite, and a mock would enforce whatever the
// mock believed instead.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BillingStore } from "../store";

const store = new BillingStore(env.DB);
let seq = 0;
const who = () => `t${Date.now().toString(36)}${seq++}`;

/** An account holding exactly these buckets, and nothing else. */
async function withCredits(parts: { credits: number; kind: "purchased" | "promotional"; scope?: string }[]) {
  const id = who();
  const account = await store.accountFor("ageri", id);
  let n = 0;
  for (const p of parts) {
    await store.grant({
      accountId: account, credits: p.credits, kind: p.kind, scope: p.scope ?? null,
      reason: "test_topup", idemKey: `${id}:${n++}`,
    });
  }
  return { id, account };
}

const total = (rows: { credits: number }[]) => rows.reduce((n, r) => n + r.credits, 0);

describe("the key the journal hangs off", () => {
  it("gives a service's identity an account, and the same one every time", async () => {
    const id = who();
    const a = await store.accountFor("ageri", id);
    const b = await store.accountFor("ageri", id);
    expect(a).toBe(b);
    expect(a).toMatch(/^ca_/);
  });

  // THE COLLISION THIS EXISTS TO PREVENT. `billing` stored the same string in user_id and
  // namespace, and that string means AGERI'S tenant - so `huy` on terminal-connect and
  // `huy` on Ageri would have silently shared a wallet. Same string, two services, two
  // accounts: a second service linking the same PERSON is a deliberate act, never inferred
  // from a matching name.
  it("does NOT hand two services the same account just because the id looks the same", async () => {
    const id = who();
    const ageri = await store.accountFor("ageri", id);
    const tc = await store.accountFor("terminal-connect", id);
    expect(tc).not.toBe(ageri);
  });
});

describe("spending", () => {
  it("draws promotional credits before purchased ones", async () => {
    const { account } = await withCredits([
      { credits: 100, kind: "purchased" },
      { credits: 30, kind: "promotional" },
    ]);
    const out = await store.spend({
      accountId: account, service: "ageri", resource: "llm", amount: 50,
      reason: "llm_call", idemKey: who(),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // ONE CHARGE, TWO ENTRIES: 30 promotional exhausted, then 20 purchased. A statement
    // reads "50 credits: 30 promotional, 20 purchased" rather than an unexplained 50.
    expect(out.spent).toEqual([
      { kind: "promotional", credits: 30 },
      { kind: "purchased", credits: 20 },
    ]);
    const left = await store.balances(account);
    expect(total(left)).toBe(80);
    expect(left.find((b) => b.kind === "promotional")).toBeUndefined();
  });

  // A RETRY IS NORMAL ON A NETWORK, and a renewal that charges twice is a support incident
  // with a refund attached. The answer comes from the JOURNAL, so it survives a restart, a
  // redeploy and a Durable Object reset - anything held in memory would not.
  it("charges once however many times the same spend arrives", async () => {
    const { account } = await withCredits([{ credits: 100, kind: "purchased" }]);
    const idem = who();
    const first = await store.spend({
      accountId: account, service: "ageri", amount: 40, reason: "licence", idemKey: idem });
    const again = await store.spend({
      accountId: account, service: "ageri", amount: 40, reason: "licence", idemKey: idem });
    expect(first.ok && !first.replayed).toBe(true);
    expect(again.ok && again.replayed).toBe(true);
    if (again.ok) expect(again.spent).toEqual([{ kind: "purchased", credits: 40 }]);
    expect(total(await store.balances(account))).toBe(60);
  });

  it("refuses what the account cannot afford, and takes nothing", async () => {
    const { account } = await withCredits([{ credits: 10, kind: "purchased" }]);
    const out = await store.spend({
      accountId: account, service: "ageri", amount: 11, reason: "seats", idemKey: who() });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out).toMatchObject({ error: "insufficient", balance: 10 });
    expect(total(await store.balances(account))).toBe(10);
  });

  it("refuses an amount that is not one", async () => {
    const { account } = await withCredits([{ credits: 10, kind: "purchased" }]);
    for (const amount of [0, -5, 1.5, NaN]) {
      const out = await store.spend({
        accountId: account, service: "ageri", amount, reason: "x", idemKey: who() });
      expect(out.ok).toBe(false);
    }
    expect(total(await store.balances(account))).toBe(10);
  });

  // SCOPE IS WHAT STOPS A GRANT LEAKING. The three free months on one product must not buy
  // LLM tokens on another - and doing it with a scope rather than a second wallet is why
  // nobody's credits can be stranded in the wrong pocket.
  it("keeps a scoped grant away from another service", async () => {
    const id = who();
    const account = await store.accountFor("ageri", id);
    await store.grant({ accountId: account, credits: 900, kind: "promotional",
                        scope: "terminal-connect", reason: "signup_grant", idemKey: who() });

    const wrong = await store.spend({
      accountId: account, service: "ageri", resource: "llm", amount: 100, reason: "llm", idemKey: who() });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.balance).toBe(0);

    const right = await store.spend({
      accountId: account, service: "terminal-connect", resource: "namespace", amount: 100,
      reason: "namespace_year", idemKey: who() });
    expect(right.ok).toBe(true);
    if (right.ok) expect(right.spent).toEqual([{ kind: "promotional", credits: 100 }]);
  });

  // The narrower credits go first, or they are the ones left behind unusable.
  it("spends a scoped bucket before an unscoped one of the same kind", async () => {
    const id = who();
    const account = await store.accountFor("ageri", id);
    await store.grant({ accountId: account, credits: 50, kind: "promotional",
                        scope: "ageri", reason: "scoped", idemKey: who() });
    await store.grant({ accountId: account, credits: 50, kind: "promotional",
                        reason: "unscoped", idemKey: who() });
    const out = await store.spend({
      accountId: account, service: "ageri", resource: "llm", amount: 60, reason: "x", idemKey: who() });
    expect(out.ok).toBe(true);
    const left = await store.balances(account);
    // 50 scoped gone entirely, 10 taken from the unscoped one.
    expect(left.find((b) => b.scope === "ageri")).toBeUndefined();
    expect(left.find((b) => b.scope === null)?.credits).toBe(40);
  });

  // THE PRICES DECIDED 2026-09-27: 1 credit = $0.01, a namespace is 10 credits a day sold
  // in blocks, $36.50 a year, and the signup grant is 900 promotional credits. A year
  // against that grant is the transaction the whole phase exists to make possible.
  it("buys a namespace year against the signup grant", async () => {
    const id = who();
    const account = await store.accountFor("terminal-connect", id);
    await store.grant({ accountId: account, credits: 900, kind: "promotional",
                        reason: "signup_grant", idemKey: who() });
    await store.grant({ accountId: account, credits: 3000, kind: "purchased",
                        reason: "topup", idemKey: who() });
    const out = await store.spend({
      accountId: account, service: "terminal-connect", resource: "namespace", amount: 3650,
      reason: "namespace_year", ref: "huy.terminalconnect.ai", idemKey: who() });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.spent).toEqual([
        { kind: "promotional", credits: 900 },
        { kind: "purchased", credits: 2750 },
      ]);
    }
    expect(total(await store.balances(account))).toBe(250);
  });
});

describe("the journal is the balance", () => {
  it("reports each bucket separately rather than one number", async () => {
    const { account } = await withCredits([
      { credits: 100, kind: "purchased" },
      { credits: 25, kind: "promotional" },
      { credits: 40, kind: "promotional", scope: "terminal-connect" },
    ]);
    const b = await store.balances(account);
    expect(total(b)).toBe(165);
    expect(b.find((x) => x.kind === "purchased")?.credits).toBe(100);
    expect(b.find((x) => x.kind === "promotional" && x.scope === null)?.credits).toBe(25);
    expect(b.find((x) => x.scope === "terminal-connect")?.credits).toBe(40);
  });

  // A grant is idempotent the same way a Paddle transaction has always been, so a webhook
  // delivered twice cannot double somebody's balance.
  it("grants once per idempotency key", async () => {
    const id = who();
    const account = await store.accountFor("ageri", id);
    const key = who();
    expect(await store.grant({ accountId: account, credits: 500, kind: "purchased",
                               reason: "paddle", idemKey: key })).toBe(true);
    expect(await store.grant({ accountId: account, credits: 500, kind: "purchased",
                               reason: "paddle", idemKey: key })).toBe(false);
    expect(total(await store.balances(account))).toBe(500);
  });

  // SQLITE ENFORCES THE SHAPE, not the TypeScript. A kind outside the two the model knows
  // is a bug that must fail loudly rather than create a third class of money.
  it("refuses a kind that is not one of the two", async () => {
    const id = who();
    const account = await store.accountFor("ageri", id);
    await expect(
      env.DB.prepare(`INSERT INTO entry (account_id, delta, kind, reason) VALUES (?, ?, ?, ?)`)
        .bind(account, 10, "imaginary", "x").run(),
    ).rejects.toThrow();
  });
});
