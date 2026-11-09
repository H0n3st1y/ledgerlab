// Webhook signatures, following the Standard Webhooks scheme
// (https://www.standardwebhooks.com):
//
//   signed_content = `${webhook_id}.${webhook_timestamp}.${raw_body}`
//   signature      = base64(HMAC-SHA256(secret_bytes, signed_content))
//   header         = "v1,<signature>"   (space-separated list when rotating secrets)
//
// The id and timestamp are inside the MAC, so an attacker can neither replay
// an old body under a fresh timestamp nor move a signature to another event.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SECRET_PREFIX = "whsec_";
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString("base64");
}

function secretBytes(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) throw new Error("webhook secret must start with whsec_");
  return Buffer.from(secret.slice(SECRET_PREFIX.length), "base64");
}

export function sign(secret: string, id: string, timestampSeconds: number, body: string): string {
  const mac = createHmac("sha256", secretBytes(secret)).update(`${id}.${timestampSeconds}.${body}`).digest("base64");
  return `v1,${mac}`;
}

export type SignedHeaders = {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
};

export function signedHeaders(secret: string, id: string, body: string, now: Date = new Date()): SignedHeaders {
  const ts = Math.floor(now.getTime() / 1000);
  return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": sign(secret, id, ts, body) };
}

export type VerifyResult = { ok: true } | { ok: false; reason: "missing_headers" | "timestamp_out_of_tolerance" | "bad_signature" };

/**
 * Consumer-side verification. Must run against the *raw* request body bytes:
 * re-serializing parsed JSON changes whitespace/key order and breaks the MAC.
 */
export function verify(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  opts: { now?: Date; toleranceSeconds?: number } = {},
): VerifyResult {
  const id = one(headers["webhook-id"]);
  const ts = one(headers["webhook-timestamp"]);
  const sigHeader = one(headers["webhook-signature"]);
  if (!id || !ts || !sigHeader) return { ok: false, reason: "missing_headers" };

  const timestamp = Number(ts);
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > tolerance) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }

  const expected = Buffer.from(sign(secret, id, timestamp, rawBody).slice(3), "base64");
  for (const candidate of sigHeader.split(" ")) {
    const [version, value] = candidate.split(",", 2);
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value, "base64");
    // Constant-time compare; lengths must match first or timingSafeEqual throws.
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "bad_signature" };
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
