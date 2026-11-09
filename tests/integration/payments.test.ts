import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../helpers/harness.js";
import { count, expectInvariantsHold, ledgerTxnCount } from "../helpers/db.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

describe("payment lifecycle over HTTP", () => {
  it("create -> authorize -> capture -> partial refund -> full refund, with ledger and events", async () => {
    const created = await h.api.createPayment(10_000, { description: "order #1" });
    expect(created).toMatchObject({ status: "CREATED", version: 1 });

    const auth = await h.api.post(`/payments/${created.id}/authorize`);
    expect(auth.status).toBe(200);
    expect(auth.body).toMatchObject({ status: "AUTHORIZED", authorized_amount: 10_000, version: 2 });

    const cap = await h.api.post(`/payments/${created.id}/capture`, { amount: 8_000 });
    expect(cap.body).toMatchObject({ status: "CAPTURED", captured_amount: 8_000, version: 3 });

    const r1 = await h.api.post(`/payments/${created.id}/refunds`, { amount: 3_000, reason: "damaged" });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ object: "refund", amount: 3_000, payment: { status: "PARTIALLY_REFUNDED", refunded_amount: 3_000 } });

    const r2 = await h.api.post(`/payments/${created.id}/refunds`, { amount: 5_000 });
    expect(r2.body.payment).toMatchObject({ status: "REFUNDED", refunded_amount: 8_000, version: 5 });

    const ledger = await h.api.get(`/payments/${created.id}/ledger`);
    expect(ledger.body.data.map((t: { kind: string }) => t.kind)).toEqual(["AUTHORIZATION_HOLD", "CAPTURE", "REFUND", "REFUND"]);
    const capture = ledger.body.data[1];
    expect(capture.entries).toEqual([
      expect.objectContaining({ account: "processor_clearing", debit: 8_000, credit: null }),
      expect.objectContaining({ account: "merchant_payable", debit: null, credit: 8_000 }),
      expect.objectContaining({ account: "authorization_hold_offset", debit: 10_000 }),
      expect.objectContaining({ account: "customer_authorization_holds", credit: 10_000 }),
    ]);
    const one = await h.api.get(`/ledger/transactions/${capture.id}`);
    expect(one.body.id).toBe(capture.id);

    const events = await h.api.get(`/payments/${created.id}/events`);
    expect(events.body.data.map((e: { type: string }) => e.type).reverse()).toEqual([
      "payment.created",
      "payment.authorized",
      "payment.captured",
      "payment.partially_refunded",
      "payment.refunded",
    ]);
    await expectInvariantsHold(h.pool);
  });

  it("a declined card returns 402, commits FAILED, emits payment.failed, and writes no ledger", async () => {
    const p = await h.api.createPayment(500, { payment_method: "pm_card_declined" });
    const key = "decline-key-1";
    const res = await h.api.post(`/payments/${p.id}/authorize`, undefined, { key });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: "CARD_DECLINED", details: { decline_code: "card_declined" } });
    expect((await h.api.get(`/payments/${p.id}`)).body).toMatchObject({ status: "FAILED", failure_code: "card_declined" });
    expect(await ledgerTxnCount(h.pool, p.id)).toBe(0);

    const retry = await h.api.post(`/payments/${p.id}/authorize`, undefined, { key });
    expect(retry.status).toBe(402);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
  });

  it("cancel releases the authorization hold", async () => {
    const p = await h.api.authorizedPayment(2_500);
    const res = await h.api.post(`/payments/${p.id}/cancel`);
    expect(res.body).toMatchObject({ status: "CANCELED", authorized_amount: 2_500 });
    expect(await ledgerTxnCount(h.pool, p.id, "AUTHORIZATION_RELEASE")).toBe(1);
    const balances = await h.api.get("/ledger/balances");
    const holds = balances.body.data.find((b: { account: string; currency: string }) => b.account === "customer_authorization_holds" && b.currency === "USD");
    expect(holds.balance).toBe(0);
  });

  it.each([
    ["refund a CREATED payment", async (id: string) => h.api.post(`/payments/${id}/refunds`, { amount: 1 }), "INVALID_STATE_TRANSITION", 409],
    ["capture a CREATED payment", async (id: string) => h.api.post(`/payments/${id}/capture`), "INVALID_STATE_TRANSITION", 409],
  ])("rejects: %s", async (_name, act, code, status) => {
    const p = await h.api.createPayment();
    const res = await act(p.id);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
  });

  it("rejects over-capture and over-refund with specific error codes, and nothing commits", async () => {
    const p = await h.api.authorizedPayment(1_000);
    const over = await h.api.post(`/payments/${p.id}/capture`, { amount: 1_001 });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("CAPTURE_EXCEEDS_AUTHORIZED_AMOUNT");

    await h.api.post(`/payments/${p.id}/capture`);
    const refund = await h.api.post(`/payments/${p.id}/refunds`, { amount: 1_001 });
    expect(refund.status).toBe(422);
    expect(refund.body).toEqual({
      error: {
        code: "REFUND_EXCEEDS_CAPTURED_AMOUNT",
        message: "Refund would exceed the captured amount.",
        details: { captured_amount: 1_000, refunded_amount: 0, refundable_amount: 1_000, requested_amount: 1_001 },
      },
    });
    expect((await h.api.get(`/payments/${p.id}`)).body).toMatchObject({ refunded_amount: 0, version: 3 });
    expect(await count(h.pool, "SELECT 1 FROM refunds WHERE payment_id = $1", [p.id])).toBe(0);
  });

  it("validates input: float amounts, unknown currency, unknown fields, bad ids", async () => {
    expect((await h.api.post("/payments", { amount: 10.25, currency: "USD" })).body.error.code).toBe("VALIDATION_ERROR");
    expect((await h.api.post("/payments", { amount: 100, currency: "XYZ" })).status).toBe(400);
    expect((await h.api.post("/payments", { amount: 100, currency: "USD", status: "CAPTURED" })).status).toBe(400);
    expect((await h.api.post("/payments", { amount: -5, currency: "USD" })).status).toBe(400);
    expect((await h.api.get("/payments/not-a-uuid")).status).toBe(400);
    const missing = await h.api.get("/payments/00000000-0000-4000-8000-000000000000");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("PAYMENT_NOT_FOUND");
  });

  it("requires an Idempotency-Key on money-moving endpoints", async () => {
    const res = await h.api.post("/payments", { amount: 100, currency: "USD" }, { key: null });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("serves health, readiness, metrics and the OpenAPI document", async () => {
    expect((await h.api.get("/health")).body).toEqual({ status: "ok" });
    expect((await h.api.get("/ready")).body).toMatchObject({ status: "ready", migrations: 4 });
    expect((await h.api.get("/metrics")).body).toContain("ledgerlab_payment_transitions_total");
    const spec = await h.api.get("/docs/json");
    expect(Object.keys(spec.body.paths)).toEqual(expect.arrayContaining(["/payments", "/payments/{id}/refunds", "/webhook-events/{id}/replay"]));
  });
});
