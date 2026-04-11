/**
 * ageri-billing Worker
 *
 * Routes:
 *   POST /webhook/paddle     — Paddle event receiver (HMAC verified)
 *   GET  /api/credits        — Balance + auto_reload info (?namespace=huy)
 *   GET  /api/usage          — Transaction history (?namespace=huy)
 *
 * Auth stubs (implemented when LLM gateway is built):
 *   POST /auth/token         — Issue agk_... subkey from refresh_token
 *   POST /auth/rotate        — Rotate expiring subkey
 */

import { BillingStore } from "./store";
import { handlePaddleWebhook } from "./paddle";

export interface Env {
  DB: D1Database;
  PADDLE_WEBHOOK_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const store = new BillingStore(env.DB);

    // POST /webhook/paddle
    if (request.method === "POST" && url.pathname === "/webhook/paddle") {
      return handlePaddleWebhook(request, store, env.PADDLE_WEBHOOK_SECRET);
    }

    // GET /api/credits?namespace=huy
    if (request.method === "GET" && url.pathname === "/api/credits") {
      const namespace = url.searchParams.get("namespace");
      if (!namespace) {
        return json({ error: "namespace required" }, 400);
      }
      const info = await store.getBillingInfo(namespace);
      return json(info);
    }

    // GET /api/usage?namespace=huy
    if (request.method === "GET" && url.pathname === "/api/usage") {
      const namespace = url.searchParams.get("namespace");
      if (!namespace) {
        return json({ error: "namespace required" }, 400);
      }
      const history = await store.getTransactionHistory(namespace);
      return json(history);
    }

    // POST /auth/token — stub
    if (request.method === "POST" && url.pathname === "/auth/token") {
      return json({ error: "not implemented" }, 501);
    }

    // POST /auth/rotate — stub
    if (request.method === "POST" && url.pathname === "/auth/rotate") {
      return json({ error: "not implemented" }, 501);
    }

    return new Response("Not Found", { status: 404 });
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
