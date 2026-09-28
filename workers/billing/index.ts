/**
 * ageri-billing Worker
 *
 * Routes:
 *   POST /webhook/paddle                — Paddle event receiver (HMAC verified)
 *   GET  /api/credits                   — Balance + auto_reload info (?namespace=huy)
 *   GET  /api/usage                     — Transaction history (?namespace=huy)
 *
 *   GET  /api/payment/get_qr_link/:ns   — Create/return VietQR order (?tier=5|10|20|50)
 *   GET  /api/payment/check_complete/:ns — Poll for VietQR payment (?tier=5|10|20|50)
 *   POST /api/token_generate            — VietQR fetches callback auth token here
 *   POST /bank/api/transaction-sync     — VietQR pushes confirmed transactions here
 *   POST /api/test/simulate_payment     — Dev: trigger a simulated VietQR payment
 *
 * Auth stubs (implemented when LLM gateway is built):
 *   POST /auth/token         — Issue agk_... subkey from refresh_token
 *   POST /auth/rotate        — Rotate expiring subkey
 */

import { BillingStore, scopeMatches } from "./store";
import { handlePaddleWebhook } from "./paddle";
import {
  TIERS, encodeNamespace, decodeNamespace,
  signJwt, verifyJwt, generateQR, simulatePayment,
  type VietQRConfig,
} from "./vietqr";

export interface Env {
  DB: D1Database;
  PADDLE_WEBHOOK_SECRET: string;
  // Server-to-server secret for the routes that read or act on an account.
  // Ageri already SENDS this (chat.py `_billing_headers`, BILLING_SERVER_SECRET);
  // until now nothing verified it. Unset means every guarded route is refused.
  BILLING_SERVER_SECRET: string;
  // Never set in production. Gates the VietQR payment simulator.
  ALLOW_TEST_PAYMENTS: string;
  // VietQR — set via: wrangler secret put <NAME>
  VIETQR_BASE_URL: string;           // https://api.vietqr.org  (or https://dev.vietqr.org)
  VIETQR_USERNAME: string;
  VIETQR_PASSWORD: string;           // base64-encoded
  VIETQR_BANK_CODE: string;          // e.g. "MB"
  VIETQR_BANK_ACCOUNT: string;       // receiving account number (a secret, never a literal)
  VIETQR_BANK_NAME: string;          // account holder name
  VIETQR_CALLBACK_USERNAME: string;  // credentials VietQR uses to call our token endpoint
  VIETQR_CALLBACK_PASSWORD: string;
  VIETQR_JWT_SECRET: string;         // min 32 chars
}

// ── Order TTL: 10 minutes ─────────────────────────────────────────────────────

const ORDER_TTL_MS = 10 * 60 * 1000;

function isExpired(createdAt: string): boolean {
  return Date.now() - new Date(createdAt + "Z").getTime() > ORDER_TTL_MS;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * WHO IS ALLOWED TO ASK ABOUT AN ACCOUNT.
 *
 * A namespace is a short, guessable string, so a route that takes one from the query
 * string and answers is a route that hands every customer's balance, auto-reload state,
 * subscription id and transaction history to anyone who can guess a username. These
 * routes are only ever called SERVER TO SERVER: the browser talks to Ageri, and Ageri
 * talks to this worker. Nothing here is meant to be reachable from a page.
 *
 * The calling half already existed and nothing checked it. `ageri/web/routes/chat.py`
 * builds `Authorization: Bearer $BILLING_SERVER_SECRET` in `_billing_headers()`, and
 * this worker read the header for the two VietQR callbacks and for nothing else.
 *
 * FAIL CLOSED. With no secret configured this returns false rather than true, so a
 * deploy that forgets to set it breaks loudly instead of staying quietly open.
 */
async function sameSecret(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  // Compared as digests: equal length whatever the inputs, so neither the secret's
  // length nor its first differing byte is observable in the timing.
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function serverToServer(request: Request, env: Env): Promise<boolean> {
  const got = request.headers.get("Authorization") || "";
  if (!got.startsWith("Bearer ")) return false;
  return sameSecret(got.slice(7), env.BILLING_SERVER_SECRET || "");
}

/** A JSON body, or null when there is not one. Callers decide what a missing body means. */
async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

function vietqrCfg(env: Env): VietQRConfig {
  return {
    baseUrl: env.VIETQR_BASE_URL || "https://dev.vietqr.org",
    username: env.VIETQR_USERNAME,
    password: env.VIETQR_PASSWORD,
    bankCode: env.VIETQR_BANK_CODE,
    bankAccount: env.VIETQR_BANK_ACCOUNT,
    bankName: env.VIETQR_BANK_NAME,
  };
}

// ── Router ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const store = new BillingStore(env.DB);

    // ── The gate, and it is DENY BY DEFAULT ───────────────────────────────────
    //
    // The first version of this fix listed the four routes to protect. That is the
    // shape that produced the hole it was fixing: a route added later is open until
    // somebody remembers to add it to the list, and nobody ever does. So the list
    // is inverted. Everything needs the server-to-server secret EXCEPT the paths
    // named here, each of which carries its own proof and is called by somebody who
    // cannot hold our secret:
    //
    //   /webhook/paddle            Paddle,  HMAC-verified inside
    //   /api/token_generate        VietQR,  Basic against VIETQR_CALLBACK_*
    //   /bank/api/transaction-sync VietQR,  Bearer JWT signed with VIETQR_JWT_SECRET
    //   /auth/token, /auth/rotate  501 stubs, reachable so they can say so
    //
    // Adding a route now means it is guarded whether or not anyone thought about
    // it, and exposing one is a deliberate edit to this list with a reason beside
    // it. An unknown path answers 401 rather than 404, which is the right way round:
    // a mistake becomes a refusal, never an opening.
    const PUBLIC_PATHS = new Set([
      "/webhook/paddle",
      "/api/token_generate",
      "/bank/api/transaction-sync",
      "/auth/token",
      "/auth/rotate",
    ]);
    if (!PUBLIC_PATHS.has(url.pathname) && !(await serverToServer(request, env))) {
      return json({ error: "unauthorized" }, 401);
    }

    // ── Paddle ───────────────────────────────────────────────────────────────

    if (request.method === "POST" && url.pathname === "/webhook/paddle") {
      return handlePaddleWebhook(request, store, env.PADDLE_WEBHOOK_SECRET);
    }

    if (request.method === "GET" && url.pathname === "/api/credits") {
      const namespace = url.searchParams.get("namespace");
      if (!namespace) return json({ error: "namespace required" }, 400);
      return json(await store.getBillingInfo(namespace));
    }

    if (request.method === "GET" && url.pathname === "/api/usage") {
      const namespace = url.searchParams.get("namespace");
      if (!namespace) return json({ error: "namespace required" }, 400);
      return json(await store.getTransactionHistory(namespace));
    }

    // ── The ledger (TC-27 S2) ─────────────────────────────────────────────────
    //
    // Guarded by the deny-by-default gate above without being named there, which is the
    // whole point of inverting that list: a route added later is protected whether or not
    // anyone remembered it. A spend route left open by an allow-list would have been far
    // worse than the read hole that prompted the inversion.

    // POST /v1/spend  {service, identity, amount, reason, resource?, ref?, idem_key}
    //
    // `resource` is optional and its ABSENCE IS MEANINGFUL: a spend that does not say what
    // it is buying cannot reach a bucket scoped `service:resource`. That is the safe
    // default - a narrow grant stays invisible until a caller declares a purpose - so this
    // stays optional rather than becoming required, and old callers keep working with the
    // narrowest possible access instead of the widest.
    if (request.method === "POST" && url.pathname === "/v1/spend") {
      const b = await readJson<{
        service?: string; identity?: string; amount?: number;
        reason?: string; resource?: string; ref?: string; idem_key?: string;
      }>(request);
      const service = String(b?.service ?? "").trim();
      const identity = String(b?.identity ?? "").trim();
      const reason = String(b?.reason ?? "").trim();
      const idem = String(b?.idem_key ?? "").trim();
      const resource = String(b?.resource ?? "").trim() || null;
      if (!service || !identity || !reason || !idem) {
        return json({ error: "service, identity, reason and idem_key are required" }, 400);
      }
      const account = await store.accountFor(service, identity);
      const out = await store.spend({
        accountId: account, service, amount: Number(b?.amount),
        reason, resource, ref: b?.ref ?? null, idemKey: idem,
      });
      if (!out.ok) {
        // 402 for "you cannot afford it", 400 for "that is not an amount". A caller
        // retrying the first is sensible; retrying the second is a bug.
        return json({ error: out.error, balance: out.balance },
                    out.error === "insufficient" ? 402 : 400);
      }
      return json({ ok: true, account, spent: out.spent, replayed: out.replayed,
                    balances: await store.balances(account) });
    }

    // ── Linking: one holder, one balance, several doors (TC-27 S1b) ───────────
    //
    // BOTH ROUTES SIT BEHIND THE DENY-BY-DEFAULT GATE without being named in it, which is
    // exactly why that list was inverted: a route added later is protected by forgetting
    // rather than exposed by it. Neither is reachable by a browser - a SERVICE calls them
    // on behalf of somebody it has already authenticated, and the identity in the body is
    // that service's own, which it knows and the user cannot choose.

    // POST /v1/link/start  {service, identity}  -> a code to carry to the other service
    if (request.method === "POST" && url.pathname === "/v1/link/start") {
      const b = await readJson<{ service?: string; identity?: string; ttl?: number }>(request);
      const service = String(b?.service ?? "").trim();
      const identity = String(b?.identity ?? "").trim();
      if (!service || !identity) return json({ error: "service and identity are required" }, 400);
      const account = await store.accountFor(service, identity);
      // A ceiling on the TTL, not a free choice: this is a bearer credential for somebody's
      // money, and a caller asking for a week should not get one.
      const ttl = Math.min(Math.max(Number(b?.ttl) || 900, 60), 3600);
      const { code, expiresAt } = await store.mintLinkCode(account, service, ttl);
      // THE CODE IS RETURNED ONCE AND NEVER STORED IN THE CLEAR. There is deliberately no
      // route that reads it back - a "show me my code again" endpoint would turn a leaked
      // session into a leaked wallet.
      return json({ ok: true, code, expires_at: expiresAt, account });
    }

    // POST /v1/link/redeem  {code, service, identity}
    if (request.method === "POST" && url.pathname === "/v1/link/redeem") {
      const b = await readJson<{ code?: string; service?: string; identity?: string }>(request);
      const code = String(b?.code ?? "").trim().toUpperCase();
      const service = String(b?.service ?? "").trim();
      const identity = String(b?.identity ?? "").trim();
      if (!code || !service || !identity) {
        return json({ error: "code, service and identity are required" }, 400);
      }
      const out = await store.redeemLinkCode(code, service, identity);
      if (!out.ok) {
        // 410 for a code that WAS real and is now spent or stale, 404 for one that never
        // existed. A person who mistyped and a person whose code lapsed need different
        // advice, and collapsing both into 400 would deny them it.
        const status = out.error === "no_such_code" ? 404 : 410;
        return json({ error: out.error }, status);
      }
      return json({ ok: true, account: out.account, merged: out.merged,
                    balances: await store.balances(out.account),
                    links: await store.linksOf(out.account) });
    }

    // GET /v1/links?service=&identity=  - the doors into this account, never a code
    if (request.method === "GET" && url.pathname === "/v1/links") {
      const service = (url.searchParams.get("service") ?? "").trim();
      const identity = (url.searchParams.get("identity") ?? "").trim();
      if (!service || !identity) return json({ error: "service and identity are required" }, 400);
      const account = await store.accountFor(service, identity);
      return json({ account, links: await store.linksOf(account) });
    }

    // GET /v1/balance?service=&identity=&resource=  - per bucket, from the journal
    if (request.method === "GET" && url.pathname === "/v1/balance") {
      const service = (url.searchParams.get("service") ?? "").trim();
      const identity = (url.searchParams.get("identity") ?? "").trim();
      const resource = (url.searchParams.get("resource") ?? "").trim() || null;
      if (!service || !identity) return json({ error: "service and identity are required" }, 400);
      const account = await store.accountFor(service, identity);
      const buckets = await store.balances(account);
      return json({
        account, buckets,
        // WHAT THIS CALLER COULD ACTUALLY SPEND, answered with `scopeMatches` - the same
        // function `spend()` enforces, imported rather than reimplemented. A second copy of
        // the rule would drift, and the failure would be a balance screen promising credits
        // that the charge then refuses.
        spendable: buckets
          .filter((x) => scopeMatches(x.scope, service, resource))
          .reduce((n, x) => n + x.credits, 0),
      });
    }

    // ── VietQR: get QR link ───────────────────────────────────────────────────
    // GET /api/payment/get_qr_link/:namespace?tier=5

    const qrMatch = url.pathname.match(/^\/api\/payment\/get_qr_link\/([^/]+)$/);
    if (request.method === "GET" && qrMatch) {
      const namespace = decodeURIComponent(qrMatch[1]);
      const tierParam = Number(url.searchParams.get("tier"));
      const tier = TIERS[tierParam];
      if (!tier) return json({ error: "invalid tier (valid: 5, 10, 20, 50)" }, 400);

      const orderId = `${namespace}:${tierParam}`;

      // Return existing unexpired unpaid order if present
      const existing = await store.getVietQROrder(orderId);
      if (existing && !existing.paid && !isExpired(existing.created_at) && existing.qr_link) {
        return json({ qr_link: existing.qr_link });
      }

      // Create new order
      await store.createVietQROrder(orderId, namespace, tierParam, tier.amountVnd, tier.credits);

      try {
        const cfg = vietqrCfg(env);
        const { qrLink } = await generateQR(cfg, orderId, tier.amountVnd);
        await store.setVietQRQrLink(orderId, qrLink);
        return json({ qr_link: qrLink });
      } catch (err) {
        return json({ error: String(err) }, 502);
      }
    }

    // ── VietQR: poll for payment completion ────────────────────────────────────
    // GET /api/payment/check_complete/:namespace?tier=5

    const checkMatch = url.pathname.match(/^\/api\/payment\/check_complete\/([^/]+)$/);
    if (request.method === "GET" && checkMatch) {
      const namespace = decodeURIComponent(checkMatch[1]);
      const tierParam = Number(url.searchParams.get("tier"));
      if (!TIERS[tierParam]) return json({ error: "invalid tier" }, 400);

      const orderId = `${namespace}:${tierParam}`;
      const order = await store.getVietQROrder(orderId);
      if (!order) return json({ paid: false });
      if (isExpired(order.created_at) && !order.paid) return json({ paid: false, expired: true });
      return json({ paid: !!order.paid });
    }

    // ── VietQR: token endpoint (VietQR calls this before each callback) ────────
    // POST /api/token_generate

    if (request.method === "POST" && url.pathname === "/api/token_generate") {
      const auth = request.headers.get("Authorization") || "";
      if (!auth.startsWith("Basic ")) return json({ error: "unauthorized" }, 401);

      const decoded = atob(auth.slice(6));
      const [user, pass] = decoded.split(":", 2);
      if (user !== env.VIETQR_CALLBACK_USERNAME || pass !== env.VIETQR_CALLBACK_PASSWORD) {
        return json({ error: "invalid credentials" }, 401);
      }

      const token = await signJwt(user, env.VIETQR_JWT_SECRET, 300);
      return json({ access_token: token, token_type: "Bearer", expires_in: "300" });
    }

    // ── VietQR: transaction callback (VietQR pushes confirmed payments here) ───
    // POST /bank/api/transaction-sync

    if (request.method === "POST" && url.pathname === "/bank/api/transaction-sync") {
      const auth = request.headers.get("Authorization") || "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

      if (!await verifyJwt(token, env.VIETQR_JWT_SECRET)) {
        return json({ error: true, errorReason: "INVALID_TOKEN", toastMessage: "Invalid token", object: null }, 401);
      }

      let body: {
        transactionid?: string; orderId?: string; amount?: number; bankaccount?: string;
      };
      try {
        body = await request.json();
      } catch {
        return json({ error: true, errorReason: "INVALID_BODY", toastMessage: "Bad request", object: null }, 400);
      }

      const encodedOrderId = body.orderId || "";
      if (!encodedOrderId) {
        return json({ error: true, errorReason: "MISSING_ORDER_ID", toastMessage: "Missing orderId", object: null }, 400);
      }

      let orderId: string;
      try {
        orderId = decodeNamespace(encodedOrderId);
      } catch {
        return json({ error: true, errorReason: "INVALID_ORDER_ID", toastMessage: "Invalid orderId", object: null }, 400);
      }

      const txnId = body.transactionid || crypto.randomUUID();
      const result = await store.markVietQRPaid(orderId, txnId);

      if (!result) {
        // Already paid or not found — still return success (idempotent)
        return json({
          error: false, errorReason: null,
          toastMessage: "Already processed",
          object: { reftransactionid: `${encodedOrderId}-OK` },
        });
      }

      return json({
        error: false, errorReason: null,
        toastMessage: "Transaction processed successfully",
        object: { reftransactionid: `${encodedOrderId}-OK` },
      });
    }

    // ── Dev: simulate payment ─────────────────────────────────────────────────
    // POST /api/test/simulate_payment  { namespace, tier }

    if (request.method === "POST" && url.pathname === "/api/test/simulate_payment") {
      // THIS ROUTE MINTS CREDITS, and it was deployed to production unauthenticated.
      // It asks VietQR to fire a transaction callback for any namespace at any tier's
      // amount; that callback lands on /bank/api/transaction-sync, which trusts it
      // because it arrives from VietQR with a valid token. So the whole chain was
      // reachable by anyone who could POST a JSON body.
      //
      // 404 RATHER THAN 403: a route that exists only in development should not
      // announce itself in production. The secret is already required by the
      // deny-by-default gate above, so this is the second of the two locks.
      if (env.ALLOW_TEST_PAYMENTS !== "yes") {
        return new Response("not found", { status: 404 });
      }
      let body: { namespace?: string; tier?: number };
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid body" }, 400);
      }

      const { namespace, tier: tierParam } = body;
      if (!namespace || !tierParam) return json({ error: "namespace and tier required" }, 400);
      const tier = TIERS[tierParam];
      if (!tier) return json({ error: "invalid tier" }, 400);

      const orderId = `${namespace}:${tierParam}`;
      const encodedOrderId = encodeNamespace(orderId);

      try {
        await simulatePayment(vietqrCfg(env), encodedOrderId, tier.amountVnd);
        return json({ ok: true, order_id: orderId, encoded: encodedOrderId });
      } catch (err) {
        return json({ error: String(err) }, 502);
      }
    }

    // ── Auth stubs ────────────────────────────────────────────────────────────

    if (request.method === "POST" && url.pathname === "/auth/token") {
      return json({ error: "not implemented" }, 501);
    }

    if (request.method === "POST" && url.pathname === "/auth/rotate") {
      return json({ error: "not implemented" }, 501);
    }

    return new Response("Not Found", { status: 404 });
  },
};
