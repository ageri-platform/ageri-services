// TC-27 S2a: a scope with three widths, and a third kind of credit.
//
// WHAT THIS SLICE IS FOR. Both changes are cheap while the journal holds one row and
// unpleasant afterwards, which is the entire argument for doing them before any surface.
//
// The scope half closes a hole that only appears once the marketplace exists: `eligible()`
// spends promotional credits FIRST, which is right when a free credit costs us some
// Cloudflare traffic and wrong when it costs us a third party's invoice. Scoping a grant to
// a whole service could not express the difference, because namespaces, seats, licences and
// the marketplace all live inside terminal-connect.
//
// The `earned` half is about a deadline rather than a feature: SQLite cannot alter a CHECK
// constraint, so admitting a third kind later means rebuilding the journal.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BillingStore, scopeMatches } from "../store";

const store = new BillingStore(env.DB);
let seq = 0;
const who = () => `s${Date.now().toString(36)}${seq++}`;

const total = (rows: { credits: number }[]) => rows.reduce((n, r) => n + r.credits, 0);

/** An account holding one grant, scoped however the caller asks. */
async function granted(scope: string | null, credits = 900, kind: "purchased" | "promotional" = "promotional") {
  const account = await store.accountFor("terminal-connect", who());
  await store.grant({ accountId: account, credits, kind, scope, reason: "gift_code", idemKey: who() });
  return account;
}

describe("scopeMatches: one column, three widths", () => {
  // The unit test exists because the three behaviours are a RULE, and a rule read off six
  // spend outcomes is harder to check than a rule read off its own table.
  it("lets an unscoped bucket pay for anything", () => {
    expect(scopeMatches(null, "terminal-connect", "namespace")).toBe(true);
    expect(scopeMatches(null, "ageri", null)).toBe(true);
  });

  it("keeps a service-scoped bucket inside its service", () => {
    expect(scopeMatches("terminal-connect", "terminal-connect", "marketplace")).toBe(true);
    expect(scopeMatches("terminal-connect", "terminal-connect", null)).toBe(true);
    expect(scopeMatches("terminal-connect", "ageri", null)).toBe(false);
  });

  // THE CASE THE SLICE WAS BUILT FOR.
  it("lets a resource-scoped bucket pay for that resource and nothing else", () => {
    const s = "terminal-connect:namespace";
    expect(scopeMatches(s, "terminal-connect", "namespace")).toBe(true);
    expect(scopeMatches(s, "terminal-connect", "marketplace")).toBe(false);
    expect(scopeMatches(s, "terminal-connect", "seats")).toBe(false);
    expect(scopeMatches(s, "ageri", "namespace")).toBe(false);
  });

  // ABSENCE IS MEANINGFUL, and this is the assertion that says so. A caller that does not
  // declare a purpose gets the NARROWEST access, not the widest - so a grant added later
  // cannot be reached by a caller written before it existed.
  it("hides a resource-scoped bucket from a spend that declares no purpose", () => {
    expect(scopeMatches("terminal-connect:namespace", "terminal-connect")).toBe(false);
    expect(scopeMatches("terminal-connect:namespace", "terminal-connect", null)).toBe(false);
    expect(scopeMatches("terminal-connect:namespace", "terminal-connect", "")).toBe(false);
  });

  // A colon in the service name must not accidentally satisfy a resource scope.
  it("does not let a service called x:y impersonate a resource scope", () => {
    expect(scopeMatches("terminal-connect:namespace", "terminal-connect:namespace", null)).toBe(true);
    expect(scopeMatches("terminal-connect:namespace", "terminal", "connect:namespace")).toBe(false);
  });
});

describe("a grant that may only buy one thing", () => {
  it("pays for the resource it was scoped to", async () => {
    const account = await granted("terminal-connect:namespace");
    const out = await store.spend({
      accountId: account, service: "terminal-connect", resource: "namespace",
      amount: 300, reason: "namespace_block", ref: "30d", idemKey: who() });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.spent).toEqual([{ kind: "promotional", credits: 300 }]);
    expect(total(await store.balances(account))).toBe(600);
  });

  // THE WHOLE POINT. A gift code's promotional credits must not settle an MCP author's
  // invoice: that is our marketing budget paying a third party in real money.
  it("refuses to pay a marketplace author out of a namespace gift", async () => {
    const account = await granted("terminal-connect:namespace");
    const out = await store.spend({
      accountId: account, service: "terminal-connect", resource: "marketplace",
      amount: 300, reason: "tool_purchase", idemKey: who() });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out).toMatchObject({ error: "insufficient", balance: 0 });
    // And it took nothing on the way past.
    expect(total(await store.balances(account))).toBe(900);
  });

  it("is invisible to a caller that did not say what it was buying", async () => {
    const account = await granted("terminal-connect:namespace");
    const out = await store.spend({
      accountId: account, service: "terminal-connect",
      amount: 1, reason: "unspecified", idemKey: who() });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.balance).toBe(0);
  });

  // THE AREA HAS THE LAST WORD, WHICH IS THE POINT OF HAVING BOTH RULES. This grant is scoped
  // to the whole of terminal-connect, so `scopeMatches` is perfectly happy with a marketplace
  // purchase - and it is still refused, because the marketplace does not accept promotional
  // money at all. A grant issued too wide cannot settle an author's invoice.
  it("refuses a service-wide GIFT in an area that takes no gifts", async () => {
    const account = await granted("terminal-connect");
    const out = await store.spend({
      accountId: account, service: "terminal-connect", resource: "marketplace",
      amount: 300, reason: "tool_purchase", idemKey: who() });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out).toMatchObject({ error: "insufficient", balance: 0 });
  });

  it("...but the same grant buys in an area that does", async () => {
    const account = await granted("terminal-connect");
    const out = await store.spend({
      accountId: account, service: "terminal-connect", resource: "namespace",
      amount: 300, reason: "namespace_block", idemKey: who() });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.spent).toEqual([{ kind: "promotional", credits: 300 }]);
  });

  // PURCHASED MONEY NEEDS NOBODY'S PERMISSION. The default denies only the gift, so an area
  // nobody has declared still takes the customer's own money - otherwise deny-by-default
  // would have broken every existing charge rather than only the ones it means to.
  it("lets purchased credits buy in an area with no policy at all", async () => {
    const account = await granted("terminal-connect:widgets", 500, "purchased");
    const out = await store.spend({
      accountId: account, service: "terminal-connect", resource: "widgets",
      amount: 500, reason: "widget", idemKey: who() });
    expect(out.ok).toBe(true);
  });
});

describe("the order a charge draws in", () => {
  // NARROWEST FIRST, so the credits that can be spent on the least are not the ones left
  // behind. Three buckets of the SAME kind, which is also the case that proves the
  // idempotency key has to include scope rather than only kind.
  it("spends resource-scoped, then service-scoped, then unscoped", async () => {
    const account = await store.accountFor("terminal-connect", who());
    for (const [scope, credits] of [
      ["terminal-connect:namespace", 100], ["terminal-connect", 100], [null, 100],
    ] as [string | null, number][]) {
      await store.grant({ accountId: account, credits, kind: "promotional", scope,
                          reason: "gift_code", idemKey: who() });
    }
    const out = await store.spend({
      accountId: account, service: "terminal-connect", resource: "namespace",
      amount: 250, reason: "namespace_block", idemKey: who() });
    expect(out.ok).toBe(true);
    const left = await store.balances(account);
    // 100 from the narrowest, 100 from the service bucket, 50 from the unscoped one.
    expect(left.find((b) => b.scope === "terminal-connect:namespace")).toBeUndefined();
    expect(left.find((b) => b.scope === "terminal-connect")).toBeUndefined();
    expect(left.find((b) => b.scope === null)?.credits).toBe(50);
  });

  // LEAST VALUABLE TO THE HOLDER FIRST. `earned` is the only kind that can leave as cash,
  // so it must be the last thing a charge touches. Nothing writes `earned` yet, which is
  // exactly why this is worth asserting now: the day the marketplace does, the ordering is
  // already right instead of being discovered by an author whose balance went first.
  it("takes promotional, then purchased, then earned", async () => {
    const account = await store.accountFor("terminal-connect", who());
    for (const kind of ["earned", "purchased", "promotional"] as const) {
      await store.grant({ accountId: account, credits: 100, kind, reason: "seed", idemKey: who() });
    }
    const out = await store.spend({
      accountId: account, service: "terminal-connect", resource: "namespace", amount: 250,
      reason: "namespace_block", idemKey: who() });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.spent).toEqual([
        { kind: "promotional", credits: 100 },
        { kind: "purchased", credits: 100 },
        { kind: "earned", credits: 50 },
      ]);
    }
    const left = await store.balances(account);
    expect(left).toEqual([{ kind: "earned", scope: null, credits: 50 }]);
  });
});

describe("the journal admits exactly three kinds", () => {
  // THE MIGRATION IS THE SUBJECT HERE, not the TypeScript. If 0004 did not run, or ran and
  // lost the CHECK, this is what notices.
  it("accepts an earned entry", async () => {
    const account = await store.accountFor("terminal-connect", who());
    await expect(
      env.DB.prepare(`INSERT INTO entry (account_id, delta, kind, reason) VALUES (?, ?, ?, ?)`)
        .bind(account, 100, "earned", "tool_sale").run(),
    ).resolves.toBeTruthy();
  });

  it("still refuses a fourth", async () => {
    const account = await store.accountFor("terminal-connect", who());
    for (const kind of ["imaginary", "EARNED", "", "earned "]) {
      await expect(
        env.DB.prepare(`INSERT INTO entry (account_id, delta, kind, reason) VALUES (?, ?, ?, ?)`)
          .bind(account, 10, kind, "x").run(),
      ).rejects.toThrow();
    }
  });

  // THE REBUILD MUST NOT HAVE LOST ANYTHING. 0004 copies every row into a new table and
  // renames it, so the things that could silently go missing are the indexes, the
  // AUTOINCREMENT and the default on created_at. The index matters most: without entry_idem
  // a retried charge would double, and nothing else in the suite would notice.
  it("kept entry_idem, its NULL fold, and its partial WHERE", async () => {
    const row = await env.DB
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'entry_idem'`)
      .first<{ sql: string }>();
    expect(row?.sql).toContain("UNIQUE");
    expect(row?.sql).toContain("COALESCE(scope, '')");
    expect(row?.sql).toContain("WHERE idem_key IS NOT NULL");
  });

  it("kept AUTOINCREMENT and the created_at default", async () => {
    const t = await env.DB
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entry'`)
      .first<{ sql: string }>();
    expect(t?.sql).toContain("AUTOINCREMENT");
    expect(t?.sql).toContain("datetime('now')");
    const account = await store.accountFor("terminal-connect", who());
    const done = await env.DB
      .prepare(`INSERT INTO entry (account_id, delta, kind, reason) VALUES (?, ?, ?, ?)`)
      .bind(account, 1, "purchased", "stamp").run();
    expect(done.meta.last_row_id).toBeGreaterThan(0);
    const back = await env.DB.prepare(`SELECT created_at FROM entry WHERE id = ?`)
      .bind(done.meta.last_row_id).first<{ created_at: string }>();
    expect(back?.created_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });
});
