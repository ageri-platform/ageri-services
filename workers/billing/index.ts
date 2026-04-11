/**
 * ageri-billing Worker
 *
 * Routes:
 *   POST /webhook/paddle     — Paddle event receiver (HMAC verified)
 *   POST /auth/token         — Issue agk_... subkey from refresh_token
 *   POST /auth/rotate        — Rotate expiring subkey
 *   GET  /api/credits        — Balance + auto_reload info for namespace
 *   GET  /api/usage          — Per-call usage log
 */

export interface Env {
  DB: D1Database;
  PADDLE_WEBHOOK_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook/paddle") {
      // TODO: implement Paddle webhook handler (port from billing.py)
      return new Response("OK", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/auth/token") {
      // TODO: validate refresh_token, issue agk_... subkey
      return new Response("Not implemented", { status: 501 });
    }

    if (request.method === "POST" && url.pathname === "/auth/rotate") {
      // TODO: invalidate old key, issue new agk_...
      return new Response("Not implemented", { status: 501 });
    }

    if (request.method === "GET" && url.pathname === "/api/credits") {
      // TODO: return balance + auto_reload for authenticated namespace
      return new Response("Not implemented", { status: 501 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
