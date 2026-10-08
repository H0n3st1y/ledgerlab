import { describe, expect, it } from "vitest";
import { SandboxConsumer } from "../../src/consumer/consumer.js";
import { generateWebhookSecret, signedHeaders } from "../../src/webhooks/signing.js";

function event(id: string, type: string, version: number, status: string) {
  return JSON.stringify({
    id,
    type,
    payment_id: "pay_1",
    payment_version: version,
    data: { object: { status, version, captured_amount: 100, refunded_amount: status === "REFUNDED" ? 100 : 0 } },
    delivery: { attempt: 1 },
  });
}

describe("sandbox consumer (reference implementation)", () => {
  const secret = generateWebhookSecret();
  const deliver = async (c: SandboxConsumer, id: string, body: string) => c.handle(signedHeaders(secret, id, body), body);

  it("processes an event once and acknowledges duplicates without reprocessing", async () => {
    const c = new SandboxConsumer();
    c.secret = secret;
    const body = event("evt_a", "payment.captured", 3, "CAPTURED");
    expect((await deliver(c, "evt_a", body)).status).toBe(200);
    expect((await deliver(c, "evt_a", body)).status).toBe(200);
    expect(c.log.map((l) => l.outcome)).toEqual(["processed", "duplicate"]);
  });

  it("ignores an older version that arrives after a newer one", async () => {
    const c = new SandboxConsumer();
    c.secret = secret;
    await deliver(c, "evt_refund", event("evt_refund", "payment.refunded", 4, "REFUNDED"));
    await deliver(c, "evt_capture", event("evt_capture", "payment.captured", 3, "CAPTURED"));
    expect(c.payments.get("pay_1")).toMatchObject({ status: "REFUNDED", version: 4 });
    expect(c.log.map((l) => l.outcome)).toEqual(["processed", "stale"]);
  });

  it("rejects bad signatures with 400", async () => {
    const c = new SandboxConsumer();
    c.secret = secret;
    const body = event("evt_x", "payment.captured", 3, "CAPTURED");
    const res = await c.handle(signedHeaders(generateWebhookSecret(), "evt_x", body), body);
    expect(res.status).toBe(400);
  });
});
