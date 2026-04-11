/**
 * paddle.ts — Paddle webhook HMAC verification + event dispatch.
 *
 * Signature format (Paddle-Signature header):
 *   ts=<unix_timestamp>;h1=<hex_hmac>
 * Verification:
 *   HMAC-SHA256(secret, `${ts}:${rawBody}`)
 *
 * Uses Web Crypto API (available in all CF Workers runtimes).
 */

import { BillingStore } from "./store";

// ---------------------------------------------------------------------------
// Price → credits mapping
// ---------------------------------------------------------------------------

export const PRICE_CREDITS: Record<string, number> = {
  // Sandbox — one-time top-ups
  "pri_01kny6pv7stafaphtvxmfjpdyn": 500,
  "pri_01kny8d1fprev73ym1vekeef47": 1100,
  "pri_01kny8efztkrdvcj2k87eqbn4g": 2400,
  "pri_01kny8fazn1qq6ffqeh7b3gatj": 6500,
  // Sandbox — monthly subscriptions
  "pri_01kny9fsz6etk82eb4da8hsrtg": 500,
  "pri_01kny9greyj0pp8af6se1cv34g": 1100,
  "pri_01kny9jhwbjbgym8gtfn71cxab": 2400,
  "pri_01kny9kpkmytaxg9mx8arfdp6a": 6500,
};

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

async function verifySignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  if (!secret) return true; // dev/test — skip verification

  try {
    const parts = Object.fromEntries(
      signatureHeader.split(";").map((p) => {
        const idx = p.indexOf("=");
        return [p.slice(0, idx), p.slice(idx + 1)];
      }),
    );
    const ts = parts["ts"] ?? "";
    const h1 = parts["h1"] ?? "";
    if (!ts || !h1) return false;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${ts}:${rawBody}`),
    );
    const expected = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Constant-time comparison
    if (expected.length !== h1.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ h1.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function onTransactionCompleted(payload: Record<string, unknown>, store: BillingStore): Promise<void> {
  const data = (payload["data"] ?? {}) as Record<string, unknown>;
  const transactionId = (data["id"] as string) ?? "";
  if (!transactionId) return;

  // namespace is passed in custom_data when creating the checkout session
  const customData = (data["custom_data"] ?? {}) as Record<string, string>;
  const namespace = customData["namespace"] ?? "owner";

  const items = (data["items"] as unknown[]) ?? [];
  for (const item of items) {
    const price = ((item as Record<string, unknown>)["price"] ?? {}) as Record<string, unknown>;
    const priceId = (price["id"] as string) ?? "";
    const credits = PRICE_CREDITS[priceId] ?? 0;
    if (credits) {
      await store.addCredits(namespace, credits, transactionId, priceId);
      return;
    }
  }

  console.warn("paddle: transaction.completed — no recognised price_id", transactionId);
}

async function onSubscriptionActivated(payload: Record<string, unknown>, store: BillingStore): Promise<void> {
  const data = (payload["data"] ?? {}) as Record<string, unknown>;
  const subscriptionId = (data["id"] as string) ?? "";
  const customData = (data["custom_data"] ?? {}) as Record<string, string>;
  const namespace = customData["namespace"] ?? "owner";

  const items = (data["items"] as unknown[]) ?? [];
  let priceId = "";
  for (const item of items) {
    const pid = (((item as Record<string, unknown>)["price"] ?? {}) as Record<string, unknown>)["id"] as string ?? "";
    if (PRICE_CREDITS[pid]) { priceId = pid; break; }
  }

  await store.setAutoReload(namespace, true, priceId, subscriptionId);
}

async function onSubscriptionCancelled(payload: Record<string, unknown>, store: BillingStore): Promise<void> {
  const data = (payload["data"] ?? {}) as Record<string, unknown>;
  const subscriptionId = (data["id"] as string) ?? "";
  const customData = (data["custom_data"] ?? {}) as Record<string, string>;
  const namespace = customData["namespace"] ?? "owner";

  await store.setAutoReload(namespace, false, "", subscriptionId);
}

async function onSubscriptionUpdated(payload: Record<string, unknown>, store: BillingStore): Promise<void> {
  const data = (payload["data"] ?? {}) as Record<string, unknown>;
  const subscriptionId = (data["id"] as string) ?? "";
  const customData = (data["custom_data"] ?? {}) as Record<string, string>;
  const namespace = customData["namespace"] ?? "owner";

  const items = (data["items"] as unknown[]) ?? [];
  let priceId = "";
  for (const item of items) {
    const pid = (((item as Record<string, unknown>)["price"] ?? {}) as Record<string, unknown>)["id"] as string ?? "";
    if (PRICE_CREDITS[pid]) { priceId = pid; break; }
  }

  if (priceId) {
    await store.setAutoReload(namespace, true, priceId, subscriptionId);
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handlePaddleWebhook(
  request: Request,
  store: BillingStore,
  secret: string,
): Promise<Response> {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("Paddle-Signature") ?? "";

  const valid = await verifySignature(rawBody, signatureHeader, secret);
  if (!valid) {
    console.warn("paddle: signature verification failed");
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const eventType = (payload["event_type"] as string) ?? "";
  console.log("paddle: event_type =", eventType);

  try {
    switch (eventType) {
      case "transaction.completed":
        await onTransactionCompleted(payload, store);
        break;
      case "subscription.activated":
        await onSubscriptionActivated(payload, store);
        break;
      case "subscription.cancelled":
        await onSubscriptionCancelled(payload, store);
        break;
      case "subscription.updated":
        await onSubscriptionUpdated(payload, store);
        break;
      default:
        console.log("paddle: unhandled event_type =", eventType);
    }
  } catch (err) {
    console.error("paddle: error handling event", eventType, err);
    return new Response("Internal error", { status: 500 });
  }

  return new Response("OK", { status: 200 });
}
