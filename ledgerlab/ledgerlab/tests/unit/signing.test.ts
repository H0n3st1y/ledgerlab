import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { generateWebhookSecret, sign, signedHeaders, verify } from "../../src/webhooks/signing.js";

describe("webhook signing", () => {
  const secret = "whsec_" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
  const now = new Date("2026-01-01T00:00:00Z");
  const body = JSON.stringify({ id: "evt_1", type: "payment.captured" });

  it("matches an independently computed HMAC-SHA256 over id.timestamp.body", () => {
    const ts = Math.floor(now.getTime() / 1000);
    const expected = createHmac("sha256", Buffer.from("0123456789abcdef0123456789abcdef"))
      .update(`evt_1.${ts}.${body}`)
      .digest("base64");
    expect(sign(secret, "evt_1", ts, body)).toBe(`v1,${expected}`);
  });

  it("verifies its own signatures", () => {
    const h = signedHeaders(secret, "evt_1", body, now);
    expect(verify(secret, h, body, { now })).toEqual({ ok: true });
  });

  it("rejects a modified body, a different id, or the wrong secret", () => {
    const h = signedHeaders(secret, "evt_1", body, now);
    expect(verify(secret, h, body.replace("captured", "refunded"), { now }).ok).toBe(false);
    expect(verify(secret, { ...h, "webhook-id": "evt_2" }, body, { now }).ok).toBe(false);
    expect(verify(generateWebhookSecret(), h, body, { now }).ok).toBe(false);
  });

  it("rejects timestamps outside the tolerance window (replay protection)", () => {
    const h = signedHeaders(secret, "evt_1", body, now);
    const later = new Date(now.getTime() + 6 * 60_000);
    expect(verify(secret, h, body, { now: later })).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
  });

  it("accepts any matching signature in a space-separated list (secret rotation)", () => {
    const h = signedHeaders(secret, "evt_1", body, now);
    const rotated = { ...h, "webhook-signature": `v1,AAAA ${h["webhook-signature"]}` };
    expect(verify(secret, rotated, body, { now }).ok).toBe(true);
  });

  it("reports missing headers", () => {
    expect(verify(secret, {}, body)).toEqual({ ok: false, reason: "missing_headers" });
  });
});
