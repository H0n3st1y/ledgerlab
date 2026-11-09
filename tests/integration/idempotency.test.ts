import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../helpers/harness.js";
import { count, expectInvariantsHold, ledgerTxnCount } from "../helpers/db.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

describe("idempotency keys", () => {
  it("returns the original response for an identical retry, without a second mutation", async () => {
    const p = await h.api.authorizedPayment(5_000);
    const first = await h.api.post(`/payments/${p.id}/capture`, {}, { key: "cap-1" });
    const second = await h.api.post(`/payments/${p.id}/capture`, {}, { key: "cap-1" });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await ledgerTxnCount(h.pool, p.id, "CAPTURE")).toBe(1);
  });

  it("the replayed response is the response *as of the first execution*, not current state", async () => {
    const p = await h.api.capturedPayment(5_000);
    const r1 = await h.api.post(`/payments/${p.id}/refunds`, { amount: 1_000 }, { key: "refund-a" });
    await h.api.post(`/payments/${p.id}/refunds`, { amount: 1_000 }, { key: "refund-b" });
    const replay = await h.api.post(`/payments/${p.id}/refunds`, { amount: 1_000 }, { key: "refund-a" });
    expect(replay.body).toEqual(r1.body);
    expect(replay.body.payment.refunded_amount).toBe(1_000);
    expect((await h.api.get(`/payments/${p.id}`)).body.refunded_amount).toBe(2_000);
  });

  it("rejects the same key with a different body (409) and does not execute it", async () => {
    const p = await h.api.capturedPayment(5_000);
    await h.api.post(`/payments/${p.id}/refunds`, { amount: 100 }, { key: "refund-x" });
    const conflict = await h.api.post(`/payments/${p.id}/refunds`, { amount: 200 }, { key: "refund-x" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect((await h.api.get(`/payments/${p.id}`)).body.refunded_amount).toBe(100);
  });

  it("rejects the same key on a different payment or endpoint", async () => {
    const a = await h.api.capturedPayment(5_000);
    const b = await h.api.capturedPayment(5_000);
    await h.api.post(`/payments/${a.id}/refunds`, { amount: 100 }, { key: "shared-key" });
    expect((await h.api.post(`/payments/${b.id}/refunds`, { amount: 100 }, { key: "shared-key" })).status).toBe(409);
    expect((await h.api.post(`/payments/${a.id}/cancel`, {}, { key: "shared-key" })).status).toBe(409);
  });

  it("stores deterministic business rejections and replays them, even after state changes", async () => {
    const p = await h.api.authorizedPayment(5_000);
    const early = await h.api.post(`/payments/${p.id}/refunds`, { amount: 100 }, { key: "too-early" });
    expect(early.status).toBe(409);
    await h.api.post(`/payments/${p.id}/capture`);
    // The payment is now refundable, but this key already has a final answer.
    const retry = await h.api.post(`/payments/${p.id}/refunds`, { amount: 100 }, { key: "too-early" });
    expect(retry.status).toBe(409);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect((await h.api.get(`/payments/${p.id}`)).body.refunded_amount).toBe(0);
  });

  it("does not store request validation failures; the key stays usable", async () => {
    const bad = await h.api.post("/payments", { amount: 1.5, currency: "USD" }, { key: "fix-and-retry" });
    expect(bad.status).toBe(400);
    const good = await h.api.post("/payments", { amount: 150, currency: "USD" }, { key: "fix-and-retry" });
    expect(good.status).toBe(201);
  });

  it("a rolled-back transaction leaves no payment change, ledger, event, or key behind", async () => {
    const p = await h.api.authorizedPayment(5_000);
    const before = {
      ledger: await ledgerTxnCount(h.pool, p.id),
      events: await count(h.pool, "SELECT 1 FROM webhook_events WHERE payment_id = $1", [p.id]),
    };
    h.ctx.failures.arm("payment.before_commit", { match: { paymentId: p.id } });
    const failed = await h.api.post(`/payments/${p.id}/capture`, {}, { key: "rollback-key" });
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe("INJECTED_FAILURE");

    expect((await h.api.get(`/payments/${p.id}`)).body).toMatchObject({ status: "AUTHORIZED", version: 2 });
    expect(await ledgerTxnCount(h.pool, p.id)).toBe(before.ledger);
    expect(await count(h.pool, "SELECT 1 FROM webhook_events WHERE payment_id = $1", [p.id])).toBe(before.events);
    expect(await count(h.pool, "SELECT 1 FROM idempotency_keys WHERE key = 'rollback-key'")).toBe(0);

    // The same key now executes for real.
    const retried = await h.api.post(`/payments/${p.id}/capture`, {}, { key: "rollback-key" });
    expect(retried.status).toBe(200);
    expect(retried.headers.get("idempotent-replayed")).toBeNull();
    expect(await ledgerTxnCount(h.pool, p.id, "CAPTURE")).toBe(1);
    await expectInvariantsHold(h.pool);
  });

  it("keys never commit in PROCESSING state", async () => {
    expect(await count(h.pool, "SELECT 1 FROM idempotency_keys WHERE status = 'PROCESSING'")).toBe(0);
  });
});
