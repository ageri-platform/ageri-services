// TC-27 S1b: the linking flow. One holder, one balance, several doors.
//
// THE STATE THIS FIXES, measured on the live ledger 2026-09-28: `accountFor` mints a separate
// account per (service, identity), so `ageri`/`huy` held 1100 credits while
// `terminal-connect`/`id_ksp...` was a different, empty account - and a namespace renewal
// answered `balance: 0` with the money sitting in the same database.
//
// The rule with teeth is in redeemLinkCode: THE JOURNAL IS NEVER REWRITTEN. A merge writes new
// entries per bucket rather than re-keying `entry.account_id`, because re-keying an
// append-only financial table is the thing migration 0003 exists to never need again.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BillingStore } from "../store";

const store = new BillingStore(env.DB);
let seq = 0;
const who = () => `l${Date.now().toString(36)}${seq++}`;
const total = (rows: { credits: number }[]) => rows.reduce((n, r) => n + r.credits, 0);

async function withCredits(service: string, parts: { credits: number; kind?: "purchased" | "promotional"; scope?: string | null }[]) {
  const id = who();
  const account = await store.accountFor(service, id);
  let n = 0;
  for (const p of parts) {
    await store.grant({
      accountId: account, credits: p.credits, kind: p.kind ?? "purchased",
      scope: p.scope ?? null, reason: "seed", idemKey: `${id}:${n++}`,
    });
  }
  return { id, account };
}

describe("a link code", () => {
  it("is returned once and stored only as a digest", async () => {
    const { account } = await withCredits("ageri", [{ credits: 100 }]);
    const { code } = await store.mintLinkCode(account, "ageri");
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);   // no I, O, 0 or 1: it gets read aloud
    const row = await env.DB.prepare("SELECT code_hash FROM link_code WHERE account_id = ?")
      .bind(account).first<{ code_hash: string }>();
    // THE PLAINTEXT IS NOWHERE. A leaked backup of this table must not be a pile of working
    // codes, because whoever holds one can reach somebody's money.
    expect(row!.code_hash).not.toBe(code);
    expect(row!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    const anywhere = await env.DB.prepare("SELECT COUNT(*) AS n FROM link_code WHERE code_hash = ?")
      .bind(code).first<{ n: number }>();
    expect(anywhere!.n).toBe(0);
  });

  it("is single use", async () => {
    const { account } = await withCredits("ageri", [{ credits: 100 }]);
    const { code } = await store.mintLinkCode(account, "ageri");
    expect((await store.redeemLinkCode(code, "terminal-connect", who())).ok).toBe(true);
    const again = await store.redeemLinkCode(code, "taplo", who());
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe("already_used");
  });

  it("expires", async () => {
    const { account } = await withCredits("ageri", [{ credits: 100 }]);
    const { code } = await store.mintLinkCode(account, "ageri");
    await env.DB.prepare("UPDATE link_code SET expires_at = ? WHERE account_id = ?")
      .bind(Math.floor(Date.now() / 1000) - 1, account).run();
    const out = await store.redeemLinkCode(code, "terminal-connect", who());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("expired");
  });

  // A MISTYPED CODE AND A STALE ONE NEED DIFFERENT ADVICE, so they are different answers.
  it("tells a wrong code apart from a spent one", async () => {
    const out = await store.redeemLinkCode("ZZZZZZZZZZ", "terminal-connect", who());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("no_such_code");
  });
});

describe("linking two services", () => {
  // THE CASE huy IS IN, and the easy one: the joining identity has no money, so the link
  // simply repoints and nothing has to move.
  it("gives the second service a door onto the first account", async () => {
    const { account: ageri } = await withCredits("ageri", [{ credits: 1100 }]);
    const tcId = who();
    const before = await store.accountFor("terminal-connect", tcId);
    expect(before).not.toBe(ageri);                       // two islands, which is the bug
    expect(total(await store.balances(before))).toBe(0);

    const { code } = await store.mintLinkCode(ageri, "ageri");
    const out = await store.redeemLinkCode(code, "terminal-connect", tcId);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.merged).toEqual([]);           // nothing to carry over

    // ONE POOL, REACHED FROM EITHER SIDE. This is the whole point of the phase.
    expect(await store.accountFor("terminal-connect", tcId)).toBe(ageri);
    expect(total(await store.balances(ageri))).toBe(1100);
  });

  it("lets the newly linked service spend the credits it could not reach before", async () => {
    const { account: ageri } = await withCredits("ageri", [{ credits: 3000 }]);
    const tcId = who();
    const refused = await store.spend({
      accountId: await store.accountFor("terminal-connect", tcId), service: "terminal-connect",
      resource: "namespace", amount: 3000, reason: "namespace_block", idemKey: who() });
    expect(refused.ok).toBe(false);                        // the 402 huy actually saw

    const { code } = await store.mintLinkCode(ageri, "ageri");
    await store.redeemLinkCode(code, "terminal-connect", tcId);

    const bought = await store.spend({
      accountId: await store.accountFor("terminal-connect", tcId), service: "terminal-connect",
      resource: "namespace", amount: 3000, reason: "namespace_block", idemKey: who() });
    expect(bought.ok).toBe(true);
    if (bought.ok) expect(bought.spent).toEqual([{ kind: "purchased", credits: 3000 }]);
  });

  it("records both doors, and never a code", async () => {
    const { account: ageri, id: ageriId } = await withCredits("ageri", [{ credits: 10 }]);
    const tcId = who();
    await store.accountFor("terminal-connect", tcId);
    const { code } = await store.mintLinkCode(ageri, "ageri");
    await store.redeemLinkCode(code, "terminal-connect", tcId);

    const links = await store.linksOf(ageri);
    expect(links.map((l) => l.service).sort()).toEqual(["ageri", "terminal-connect"]);
    expect(links.find((l) => l.service === "ageri")!.service_identity_id).toBe(ageriId);
    expect(JSON.stringify(links)).not.toContain(code);
  });

  // A SERVICE REACHES AN ACCOUNT THROUGH EXACTLY ONE IDENTITY, or "which one is you" has no
  // answer at spend time. A second identity of the SAME service is not refused outright - it
  // is simply moved, which is what a person who made two accounts by mistake actually wants.
  it("is a no-op when the same identity redeems into the account it already has", async () => {
    const { account, id } = await withCredits("ageri", [{ credits: 500 }]);
    const { code } = await store.mintLinkCode(account, "ageri");
    const out = await store.redeemLinkCode(code, "ageri", id);
    expect(out.ok).toBe(true);
    if (out.ok) { expect(out.account).toBe(account); expect(out.merged).toEqual([]); }
    expect(total(await store.balances(account))).toBe(500);
    expect(await store.linksOf(account)).toHaveLength(1);
  });
});

describe("merging two balances", () => {
  // THE RULE WITH TEETH. Money moves as NEW ENTRIES, never by re-keying existing ones.
  it("carries the balance over per bucket, preserving kind and scope", async () => {
    const { account: target } = await withCredits("ageri", [{ credits: 1000 }]);
    const tcId = who();
    const source = await store.accountFor("terminal-connect", tcId);
    await store.grant({ accountId: source, credits: 300, kind: "purchased", reason: "topup", idemKey: who() });
    await store.grant({ accountId: source, credits: 200, kind: "promotional",
                        scope: "terminal-connect:namespace", reason: "gift_code", idemKey: who() });

    const { code } = await store.mintLinkCode(target, "ageri");
    const out = await store.redeemLinkCode(code, "terminal-connect", tcId);
    expect(out.ok).toBe(true);

    const after = await store.balances(target);
    expect(total(after)).toBe(1500);
    expect(after.find((b) => b.kind === "purchased")!.credits).toBe(1300);
    // THE GIFT IS STILL RING-FENCED. A merge that quietly widened a namespace-only grant
    // into spendable-anywhere credits would be a refund of a restriction nobody granted.
    const gift = after.find((b) => b.scope === "terminal-connect:namespace")!;
    expect(gift).toMatchObject({ kind: "promotional", credits: 200 });
    // And the source is empty rather than merely ignored.
    expect(total(await store.balances(source))).toBe(0);
  });

  it("leaves both histories readable, rather than moving the old rows", async () => {
    const { account: target } = await withCredits("ageri", [{ credits: 100 }]);
    const tcId = who();
    const source = await store.accountFor("terminal-connect", tcId);
    await store.grant({ accountId: source, credits: 250, reason: "topup", kind: "purchased", idemKey: who() });
    const originals = await env.DB.prepare("SELECT id FROM entry WHERE account_id = ?")
      .bind(source).all<{ id: number }>();

    const { code } = await store.mintLinkCode(target, "ageri");
    await store.redeemLinkCode(code, "terminal-connect", tcId);

    // THE ORIGINAL ROWS ARE UNTOUCHED - still on the source account, still saying what they
    // said. An UPDATE of entry.account_id would have made them vanish from this query.
    for (const o of originals.results) {
      const still = await env.DB.prepare("SELECT account_id FROM entry WHERE id = ?")
        .bind(o.id).first<{ account_id: string }>();
      expect(still!.account_id).toBe(source);
    }
    const legs = await env.DB
      .prepare("SELECT reason, account_id, delta FROM entry WHERE reason IN ('merge_out','merge_in') AND (account_id = ? OR account_id = ?) ORDER BY reason")
      .bind(source, target).all<{ reason: string; account_id: string; delta: number }>();
    expect(legs.results).toEqual([
      { reason: "merge_in", account_id: target, delta: 250 },
      { reason: "merge_out", account_id: source, delta: -250 },
    ]);
  });

  // A RETRY AFTER A DROPPED RESPONSE MUST NOT MOVE THE MONEY TWICE. The code is spent, so the
  // second attempt is refused outright - but the per-bucket idem keys are the belt to that
  // brace, and they are what `entry_idem` enforces in SQLite rather than in TypeScript.
  it("cannot double a merge, even replaying the legs directly", async () => {
    const { account: target } = await withCredits("ageri", [{ credits: 100 }]);
    const tcId = who();
    const source = await store.accountFor("terminal-connect", tcId);
    await store.grant({ accountId: source, credits: 400, reason: "topup", kind: "purchased", idemKey: who() });

    const { code } = await store.mintLinkCode(target, "ageri");
    await store.redeemLinkCode(code, "terminal-connect", tcId);
    expect(total(await store.balances(target))).toBe(500);

    const key = await env.DB.prepare("SELECT idem_key FROM entry WHERE reason = 'merge_in' AND account_id = ?")
      .bind(target).first<{ idem_key: string }>();
    await expect(
      env.DB.prepare(`INSERT INTO entry (account_id, delta, kind, scope, reason, idem_key)
                      VALUES (?, ?, 'purchased', NULL, 'merge_in', ?)`)
        .bind(target, 400, key!.idem_key).run(),
    ).rejects.toThrow();
    expect(total(await store.balances(target))).toBe(500);
  });

  it("moves nothing when the joining account is empty", async () => {
    const { account: target } = await withCredits("ageri", [{ credits: 700 }]);
    const tcId = who();
    await store.accountFor("terminal-connect", tcId);
    const { code } = await store.mintLinkCode(target, "ageri");
    await store.redeemLinkCode(code, "terminal-connect", tcId);
    const legs = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM entry WHERE reason IN ('merge_out','merge_in') AND account_id = ?")
      .bind(target).first<{ n: number }>();
    expect(legs!.n).toBe(0);
    expect(total(await store.balances(target))).toBe(700);
  });
});
