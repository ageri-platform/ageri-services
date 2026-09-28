/**
 * store.ts — D1 billing store operations.
 *
 * Direct port of the Python BillingStore, adapted for Cloudflare D1.
 * All operations are async (D1 is async-only).
 * user_id == namespace for simplicity — one billing row per Ageri namespace.
 */

export interface BillingInfo {
  credits: number;
  auto_reload: boolean;
  auto_reload_price: string | null;
  subscription_id: string | null;
}

export interface TransactionRecord {
  paddle_transaction_id: string;
  price_id: string;
  credits_granted: number;
  created_at: string;
}

/** The kinds of credit the journal admits. Enforced by a CHECK, not by this type. */
export type CreditKind = "purchased" | "promotional" | "earned";

/**
 * THE ORDER A CHARGE DRAWS IN: least valuable to the holder first. `promotional` is a
 * marketing expense that is never withdrawable, `purchased` is money handed over, and
 * `earned` is money we owe an author and the only kind that can leave as cash.
 *
 * A kind not named here sorts LAST rather than throwing. A charge refusing to run because
 * the journal grew a value this array has not heard of would be the worse failure: the
 * money is still there, and the only thing at stake is which bucket goes first.
 */
const SPEND_ORDER: readonly string[] = ["promotional", "purchased", "earned"];
const spendRank = (kind: string): number => {
  const i = SPEND_ORDER.indexOf(kind);
  return i < 0 ? SPEND_ORDER.length : i;
};

/**
 * HOW WIDE A BUCKET IS, and so how late it should be spent. NULL spends anywhere (widest),
 * a bare service name spends anywhere in that service, `service:resource` spends on one
 * thing (narrowest).
 */
const scopeWidth = (scope: string | null): number =>
  scope === null ? 2 : scope.includes(":") ? 0 : 1;

/**
 * May a bucket with this `scope` pay for `resource` in `service`?
 *
 * ONE COLUMN, THREE WIDTHS. `null` matches everything. `"terminal-connect"` matches any
 * spend by that service. `"terminal-connect:namespace"` matches only a spend that DECLARED
 * it was buying a namespace - and a spend that declares nothing cannot touch it, which is
 * the point: the narrow grant is invisible until a caller says what the money is for.
 *
 * WHY THE FINE CASE EXISTS (huy, 2026-09-28: "promotional credits should be used for the
 * namespace area only"). A service name is too coarse, because seats, licences and the
 * marketplace all live inside terminal-connect as well. And the marketplace is the case
 * that matters: an MCP tool author is paid real money, so a promotional credit spent there
 * is a third party's invoice settled out of a grant we think of as marketing. The rule is
 * "promotional credits may buy OUR resources, never a third party's labour", and this
 * function is where that rule is actually said.
 *
 * Exported because `/v1/balance` must compute "what could this caller spend" with exactly
 * the same rule that `spend()` enforces. Two copies of it would be one copy too many.
 */
export function scopeMatches(
  scope: string | null,
  service: string,
  resource?: string | null,
): boolean {
  if (scope === null) return true;
  if (scope === service) return true;
  return resource ? scope === `${service}:${resource}` : false;
}

export class BillingStore {
  constructor(private db: D1Database) {}

  async getBalance(namespace: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT credits FROM billing WHERE namespace = ?")
      .bind(namespace)
      .first<{ credits: number }>();
    return row?.credits ?? 0;
  }

  /**
   * Add credits idempotently. Duplicate paddle_transaction_id is a no-op.
   * Returns new balance.
   */
  async addCredits(
    namespace: string,
    credits: number,
    transactionId: string,
    priceId: string,
  ): Promise<number> {
    // Idempotency check
    const existing = await this.db
      .prepare("SELECT id FROM billing_transactions WHERE paddle_transaction_id = ?")
      .bind(transactionId)
      .first();
    if (existing) {
      const row = await this.db
        .prepare("SELECT credits FROM billing WHERE namespace = ?")
        .bind(namespace)
        .first<{ credits: number }>();
      return row?.credits ?? 0;
    }

    // Upsert balance + log transaction atomically
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO billing (user_id, namespace, credits, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(user_id) DO UPDATE SET
             credits    = credits + excluded.credits,
             updated_at = datetime('now')`,
        )
        .bind(namespace, namespace, credits),
      this.db
        .prepare(
          `INSERT INTO billing_transactions
             (user_id, paddle_transaction_id, price_id, credits_granted)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(namespace, transactionId, priceId, credits),
    ]);

    const row = await this.db
      .prepare("SELECT credits FROM billing WHERE namespace = ?")
      .bind(namespace)
      .first<{ credits: number }>();
    return row?.credits ?? credits;
  }

  async setAutoReload(
    namespace: string,
    enabled: boolean,
    priceId: string,
    subscriptionId: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO billing (user_id, namespace, credits, auto_reload, auto_reload_price, subscription_id, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, datetime('now'))
         ON CONFLICT(user_id) DO UPDATE SET
           auto_reload       = excluded.auto_reload,
           auto_reload_price = excluded.auto_reload_price,
           subscription_id   = excluded.subscription_id,
           updated_at        = datetime('now')`,
      )
      .bind(namespace, namespace, enabled ? 1 : 0, priceId || null, subscriptionId || null)
      .run();
  }

  async getBillingInfo(namespace: string): Promise<BillingInfo> {
    const row = await this.db
      .prepare("SELECT credits, auto_reload, auto_reload_price, subscription_id FROM billing WHERE namespace = ?")
      .bind(namespace)
      .first<{
        credits: number;
        auto_reload: number;
        auto_reload_price: string | null;
        subscription_id: string | null;
      }>();

    if (!row) {
      return { credits: 0, auto_reload: false, auto_reload_price: null, subscription_id: null };
    }
    return {
      credits: row.credits,
      auto_reload: row.auto_reload === 1,
      auto_reload_price: row.auto_reload_price,
      subscription_id: row.subscription_id,
    };
  }


  // ── The ledger (TC-27 S2) ───────────────────────────────────────────────────
  //
  // A DEBIT THAT IS NOT A TOKEN COUNT. Before this there was no way out of the ledger at
  // all except the LLM gateway's per-call deduction, which was a stub, so credits had
  // been granted and never once consumed. Everything the product decided to sell - a
  // namespace year, a licence, seats - had no row shape to live in.

  /** The account a service's identity reaches, created on first sight. */
  async accountFor(service: string, identityId: string): Promise<string> {
    const found = await this.db
      .prepare("SELECT account_id FROM account_link WHERE service = ? AND service_identity_id = ?")
      .bind(service, identityId)
      .first<{ account_id: string }>();
    if (found) return found.account_id;

    // Deterministic for the Ageri road so it agrees with migration 0003's backfill, and
    // random for everyone else. A second service linking the SAME person is a deliberate
    // act (S1's linking flow), never something inferred from a matching string.
    const id = service === "ageri"
      ? "ca_" + identityId
      : "ca_" + [...crypto.getRandomValues(new Uint8Array(12))]
          .map((b) => b.toString(16).padStart(2, "0")).join("");
    await this.db.batch([
      this.db.prepare("INSERT OR IGNORE INTO credit_account (id) VALUES (?)").bind(id),
      this.db
        .prepare(`INSERT OR IGNORE INTO account_link (service, service_identity_id, account_id)
                  VALUES (?, ?, ?)`)
        .bind(service, identityId, id),
    ]);
    // Re-read: another request may have won the race, and its id is the one that counts.
    const now = await this.db
      .prepare("SELECT account_id FROM account_link WHERE service = ? AND service_identity_id = ?")
      .bind(service, identityId)
      .first<{ account_id: string }>();
    return now?.account_id ?? id;
  }

  /**
   * What this account holds, per bucket, as a GROUP BY over the journal rather than a
   * column. Credits do not expire (huy, 2026-09-27), so same kind and scope are fungible
   * and there is nothing to track per grant - which is what deleted lot tracking entirely.
   */
  async balances(accountId: string): Promise<{ kind: string; scope: string | null; credits: number }[]> {
    const { results } = await this.db
      .prepare(`SELECT kind, scope, SUM(delta) AS credits FROM entry
                WHERE account_id = ? GROUP BY kind, scope HAVING SUM(delta) <> 0`)
      .bind(accountId)
      .all<{ kind: string; scope: string | null; credits: number }>();
    return results;
  }

  /**
   * The buckets a spend may draw from, in the order it must draw them.
   *
   * SPEND THE LEAST VALUABLE CREDIT FIRST, which is what SPEND_ORDER encodes: `promotional`
   * is our marketing expense and can never be withdrawn, `purchased` is money the customer
   * handed over, and `earned` is money we OWE an author. Taking them in that order leaves
   * the credits the holder could get real value out of until last, which is the order that
   * is fair to them and cheap for us.
   *
   * A GRANT IS ONLY VISIBLE TO WHAT IT WAS SCOPED TO, and `scope` is MATCHED rather than
   * compared, so one column expresses three widths - see `scopeMatches`.
   */
  private eligible(
    rows: { kind: string; scope: string | null; credits: number }[],
    service: string,
    resource?: string | null,
  ) {
    return rows
      .filter((r) => r.credits > 0 && scopeMatches(r.scope, service, resource))
      .sort((a, b) => {
        const byKind = spendRank(a.kind) - spendRank(b.kind);
        if (byKind !== 0) return byKind;
        // Within a kind, the NARROWER bucket goes first: credits that can be spent on the
        // least are the ones that would otherwise be left behind unusable.
        return scopeWidth(a.scope) - scopeWidth(b.scope);
      });
  }

  /**
   * Spend credits. ONE TRANSACTION, POSSIBLY SEVERAL ENTRIES.
   *
   * A 50 credit charge against 30 promotional and 100 purchased draws from both, so the
   * unit of idempotency is the CHARGE and the unit of record is the entry: they share an
   * idem_key and differ by kind, which is exactly what `entry_idem` enforces. A statement
   * then reads "Namespace year, 3650 credits: 900 promotional, 2750 purchased".
   *
   * A RETRY IS A NO-OP, NOT A SECOND CHARGE. The caller gets the same answer it got the
   * first time, because a renewal that charges twice is a support incident with a refund
   * attached, and retries are normal on a network.
   */
  async spend(opts: {
    accountId: string; service: string; amount: number;
    /**
     * WHAT THE MONEY IS FOR, as an eligibility key rather than a description - `reason` is
     * the description. Omitting it is not the same as passing anything: a spend that does
     * not say what it is buying cannot reach a `service:resource` bucket at all, which is
     * what makes a narrow grant safe by default rather than safe by remembering.
     */
    resource?: string | null;
    reason: string; ref?: string | null; idemKey: string;
  }): Promise<{ ok: true; spent: { kind: string; credits: number }[]; replayed: boolean }
          | { ok: false; error: "insufficient" | "bad_amount"; balance: number }> {
    const { accountId, service, amount, reason, idemKey } = opts;
    const ref = opts.ref ?? null;
    if (!Number.isInteger(amount) || amount <= 0) {
      return { ok: false, error: "bad_amount", balance: 0 };
    }

    // ALREADY DONE? Answered from the journal, so it survives a restart, a redeploy and a
    // Durable Object reset - anything held in memory would not.
    const prior = await this.db
      .prepare("SELECT kind, delta FROM entry WHERE idem_key = ?")
      .bind(idemKey)
      .all<{ kind: string; delta: number }>();
    if (prior.results.length) {
      return {
        ok: true, replayed: true,
        spent: prior.results.map((r) => ({ kind: r.kind, credits: -r.delta })),
      };
    }

    const rows = await this.balances(accountId);
    const buckets = this.eligible(rows, service, opts.resource ?? null);
    const available = buckets.reduce((n, b) => n + b.credits, 0);
    if (available < amount) return { ok: false, error: "insufficient", balance: available };

    const spent: { kind: string; scope: string | null; credits: number }[] = [];
    let left = amount;
    for (const b of buckets) {
      if (left <= 0) break;
      const take = Math.min(left, b.credits);
      spent.push({ kind: b.kind, scope: b.scope, credits: take });
      left -= take;
    }

    // ONE BATCH. The entries and the legacy column move together or not at all.
    //
    // WHY THE COLUMN IS STILL WRITTEN. `billing.credits` is what /api/credits answers with
    // and what the llm-gateway will read, and this slice is not the place to change what
    // live callers see. Both sides move in the same batch, so they cannot drift, and a
    // later slice can assert SUM(delta) == credits before flipping the read over.
    await this.db.batch([
      ...spent.map((s) =>
        this.db
          .prepare(`INSERT INTO entry (account_id, delta, kind, scope, service, reason, ref, idem_key)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(accountId, -s.credits, s.kind, s.scope, service, reason, ref, idemKey)),
      this.db
        .prepare(`UPDATE billing SET credits = credits - ?, updated_at = datetime('now')
                  WHERE user_id IN (SELECT service_identity_id FROM account_link
                                    WHERE account_id = ? AND service = 'ageri')`)
        .bind(amount, accountId),
    ]);

    return { ok: true, replayed: false, spent: spent.map(({ kind, credits }) => ({ kind, credits })) };
  }

  /**
   * Put credits in, as a journal entry. Called beside the two existing grant paths so the
   * journal accounts for every credit the system holds rather than only for what it spends.
   * Idempotent on idemKey, the same discipline addCredits has always had on a Paddle id.
   */
  async grant(opts: {
    accountId: string; credits: number; kind: CreditKind;
    reason: string; service?: string | null;
    /** NULL spends anywhere, `service` anywhere in it, `service:resource` on one thing. */
    scope?: string | null;
    ref?: string | null; idemKey: string;
  }): Promise<boolean> {
    const done = await this.db
      .prepare(`INSERT OR IGNORE INTO entry
                  (account_id, delta, kind, scope, service, reason, ref, idem_key)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(opts.accountId, opts.credits, opts.kind, opts.scope ?? null,
            opts.service ?? null, opts.reason, opts.ref ?? null, opts.idemKey)
      .run();
    return (done.meta.changes ?? 0) > 0;
  }

  // ── VietQR orders ───────────────────────────────────────────────────────────

  async getVietQROrder(orderId: string): Promise<{
    order_id: string; namespace: string; tier: number;
    amount_vnd: number; credits: number; qr_link: string | null;
    paid: number; txn_id: string | null; created_at: string;
  } | null> {
    return this.db
      .prepare("SELECT * FROM vietqr_orders WHERE order_id = ?")
      .bind(orderId)
      .first();
  }

  async createVietQROrder(
    orderId: string, namespace: string, tier: number,
    amountVnd: number, credits: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO vietqr_orders
           (order_id, namespace, tier, amount_vnd, credits)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(orderId, namespace, tier, amountVnd, credits)
      .run();
  }

  async setVietQRQrLink(orderId: string, qrLink: string): Promise<void> {
    await this.db
      .prepare("UPDATE vietqr_orders SET qr_link = ? WHERE order_id = ?")
      .bind(qrLink, orderId)
      .run();
  }

  /** Mark an order paid and grant credits. Returns false if already paid or not found. */
  async markVietQRPaid(orderId: string, txnId: string): Promise<{ namespace: string; credits: number } | null> {
    const order = await this.getVietQROrder(orderId);
    if (!order || order.paid) return null;

    await this.db.batch([
      this.db
        .prepare(
          `UPDATE vietqr_orders SET paid = 1, txn_id = ?, paid_at = datetime('now')
           WHERE order_id = ?`,
        )
        .bind(txnId, orderId),
      // Grant credits via existing addCredits logic (reuse billing table)
      this.db
        .prepare(
          `INSERT INTO billing (user_id, namespace, credits, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(user_id) DO UPDATE SET
             credits    = credits + excluded.credits,
             updated_at = datetime('now')`,
        )
        .bind(order.namespace, order.namespace, order.credits),
      this.db
        .prepare(
          `INSERT OR IGNORE INTO billing_transactions
             (user_id, paddle_transaction_id, price_id, credits_granted)
           VALUES (?, ?, 'vietqr', ?)`,
        )
        .bind(order.namespace, `vietqr_${txnId}`, order.credits),
    ]);

    return { namespace: order.namespace, credits: order.credits };
  }

  async getTransactionHistory(namespace: string, limit = 20): Promise<TransactionRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT paddle_transaction_id, price_id, credits_granted, created_at
         FROM billing_transactions
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .bind(namespace, limit)
      .all<TransactionRecord>();
    return results;
  }
}
