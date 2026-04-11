/**
 * ageri-llm-gateway Worker
 *
 * Routes:
 *   POST /infer   — Validate agk_... subkey, check credits, call CF Workers AI, deduct
 *
 * Privacy: this Worker is open source. It logs model + token counts only.
 * No message content is stored anywhere.
 */

export interface Env {
  AI: Ai;
  DB: D1Database;
}

// Credits deducted per 1000 tokens by model
const TOKEN_RATES: Record<string, number> = {
  "@cf/meta/llama-3.1-8b-instruct":   0.01,   // 1 credit per 100k tokens
  "@cf/meta/llama-3.1-70b-instruct":  0.1,    // 1 credit per 10k tokens
  "@cf/mistral/mistral-7b-instruct":  0.01,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 1. Validate subkey
    const auth = request.headers.get("Authorization") ?? "";
    const keyId = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!keyId) return new Response("Unauthorized", { status: 401 });

    // TODO: validate keyId against DB, get user_id

    // 2. Check minimum balance (≥ 1 credit)
    // TODO: query DB for credits

    // 3. Parse request
    const body = await request.json() as { model: string; messages: unknown[] };
    const model = body.model ?? "@cf/meta/llama-3.1-70b-instruct";

    // 4. Call CF Workers AI — user never has access to this binding
    // TODO: implement streaming + token counting

    // 5. Deduct credits based on actual token usage
    // TODO: post-deduct from DB, log to usage_log

    return new Response("Not implemented", { status: 501 });
  },
};
