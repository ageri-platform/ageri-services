/**
 * vietqr.ts — VietQR API client, JWT utils, namespace cipher, tier map.
 *
 * All crypto uses the Web Crypto API (standard in Cloudflare Workers).
 * No external dependencies required.
 */

// ── Tier map ──────────────────────────────────────────────────────────────────

export interface Tier {
  amountVnd: number;
  credits: number;
  label: string;
}

export const TIERS: Record<number, Tier> = {
  5:  { amountVnd: 125_000,   credits: 500,  label: "$5" },
  10: { amountVnd: 250_000,   credits: 1100, label: "$10" },
  20: { amountVnd: 500_000,   credits: 2400, label: "$20" },
  50: { amountVnd: 1_250_000, credits: 6500, label: "$50" },
};

// ── Namespace cipher (Base64 URL — deterministic, reversible, URL-safe) ───────

export function encodeNamespace(orderId: string): string {
  return btoa(orderId).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function decodeNamespace(encoded: string): string {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4;
  return atob(pad ? padded + "=".repeat(4 - pad) : padded);
}

// ── JWT (HS256 via Web Crypto — no library needed) ────────────────────────────

function b64url(data: string): string {
  return btoa(data).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): string {
  return atob(s.replace(/-/g, "+").replace(/_/g, "/"));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signJwt(
  subject: string,
  secret: string,
  expirySeconds = 300,
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({ sub: subject, iat: now, exp: now + expirySeconds, jti: crypto.randomUUID() }),
  );
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`));
  const sigB64 = b64url(String.fromCharCode(...new Uint8Array(sig)));
  return `${header}.${payload}.${sigB64}`;
}

export async function verifyJwt(token: string, secret: string): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [header, payload, sig] = parts;
  const key = await hmacKey(secret);
  let sigBytes: Uint8Array;
  try {
    sigBytes = Uint8Array.from(b64urlDecode(sig), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  if (!valid) return false;
  try {
    const claims = JSON.parse(b64urlDecode(payload));
    return Math.floor(Date.now() / 1000) < claims.exp;
  } catch {
    return false;
  }
}

// ── VietQR API client ─────────────────────────────────────────────────────────

export interface VietQRConfig {
  baseUrl: string;
  username: string;
  password: string;   // base64-encoded
  bankCode: string;
  bankAccount: string;
  bankName: string;
}

export interface QRResult {
  qrLink: string;
  qrCode: string;
}

async function fetchVietQRToken(cfg: VietQRConfig): Promise<string> {
  const credentials = btoa(`${cfg.username}:${cfg.password}`);
  const res = await fetch(`${cfg.baseUrl}/vqr/api/token_generate`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`VietQR token fetch failed: ${res.status}`);
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

export async function generateQR(
  cfg: VietQRConfig,
  orderId: string,      // namespace:tier — used as orderId + content
  amountVnd: number,
): Promise<QRResult> {
  const encodedOrderId = encodeNamespace(orderId);
  const token = await fetchVietQRToken(cfg);

  const body = {
    bankCode: cfg.bankCode,
    bankAccount: cfg.bankAccount,
    userBankName: cfg.bankName,
    amount: amountVnd,
    content: encodedOrderId,
    qrType: 0,
    transType: "C",
    orderId: encodedOrderId,
  };

  const res = await fetch(`${cfg.baseUrl}/vqr/api/qr/generate-customer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`VietQR QR generation failed: ${res.status}`);
  const data = await res.json() as { qrLink: string; qrCode: string };
  return { qrLink: data.qrLink, qrCode: data.qrCode };
}

/** Trigger a simulated payment in the VietQR dev environment. */
export async function simulatePayment(
  cfg: VietQRConfig,
  encodedOrderId: string,
  amountVnd: number,
): Promise<void> {
  const token = await fetchVietQRToken(cfg);
  await fetch(`${cfg.baseUrl}/vqr/bank/api/test/transaction-callback`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      bankCode: cfg.bankCode,
      bankAccount: cfg.bankAccount,
      content: "Test payment",
      qrType: "0",
      userBankName: cfg.bankName,
      amount: String(amountVnd),
      transType: "C",
      orderid: encodedOrderId,  // lowercase 'i' — VietQR quirk
    }),
  });
}
