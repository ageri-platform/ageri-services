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
