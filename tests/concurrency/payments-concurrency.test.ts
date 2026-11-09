// Real concurrency: every request below is in flight at the same time, over
// its own socket and its own pooled Postgres connection. Nothing is mocked.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../helpers/harness.js";
import { count, expectInvariantsHold, ledgerTxnCount } from "../helpers/db.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ poolMax: 40 });
});
afterAll(async () => h.close());

const statuses = (rs: { status: number }[]) =>
  rs.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});

describe("concurrency", () => {
  it("20 concurrent captures (distinct keys) of one payment: exactly one wins", async () => {
    const p = await h.api.authorizedPayment(10_000);
    const results = await Promise.all(Array.from({ length: 20 }, () => h.api.post(`/payments/${p.id}/capture`)));

    expect(statuses(results)).toEqual({ 200: 1, 409: 19 });
    for (const r of results.filter((r) => r.status === 409)) expect(r.body.error.code).toBe("INVALID_STATE_TRANSITION");
    expect((await h.api.get(`/payments/${p.id}`)).body).toMatchObject({ status: "CAPTURED", captured_amount: 10_000, version: 3 });
    expect(await ledgerTxnCount(h.pool, p.id, "CAPTURE")).toBe(1);
    expect(await count(h.pool, "SELECT 1 FROM webhook_events WHERE payment_id = $1 AND type = 'payment.captured'", [p.id])).toBe(1);
  });

  it("20 concurrent captures with the SAME key: one execution, 20 identical 200s", async () => {
    const p = await h.api.authorizedPayment(10_000);
    const results = await Promise.all(Array.from({ length: 20 }, () => h.api.post(`/payments/${p.id}/capture`, {}, { key: `same-capture-${p.id}` })));
    expect(statuses(results)).toEqual({ 200: 20 });
    for (const r of results) expect(r.body).toEqual(results[0]!.body);
    expect(results.filter((r) => r.headers.get("idempotent-replayed") === null)).toHaveLength(1);
    expect(await ledgerTxnCount(h.pool, p.id, "CAPTURE")).toBe(1);
  });

  it("50 concurrent creates with the same Idempotency-Key create exactly one payment", async () => {
    const key = "create-50";
    const before = await count(h.pool, "SELECT 1 FROM payments");
    const results = await Promise.all(Array.from({ length: 50 }, () => h.api.post("/payments", { amount: 4_200, currency: "USD" }, { key })));
    expect(statuses(results)).toEqual({ 201: 50 });
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    expect(await count(h.pool, "SELECT 1 FROM payments")).toBe(before + 1);
    expect(await count(h.pool, "SELECT 1 FROM webhook_events WHERE payment_id = $1", [[...ids][0]])).toBe(1);
  });

  it("50 concurrent same-key refunds: one refund, one ledger transaction", async () => {
    const p = await h.api.capturedPayment(10_000);
    const results = await Promise.all(Array.from({ length: 50 }, () => h.api.post(`/payments/${p.id}/refunds`, { amount: 2_500 }, { key: `rf-${p.id}` })));
    expect(statuses(results)).toEqual({ 201: 50 });
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect((await h.api.get(`/payments/${p.id}`)).body.refunded_amount).toBe(2_500);
    expect(await ledgerTxnCount(h.pool, p.id, "REFUND")).toBe(1);
  });

  it("Demo B: refunds of $40, $40, $40 racing on a $100 capture never exceed $100", async () => {
    for (let round = 0; round < 10; round++) {
      const p = await h.api.capturedPayment(10_000);
      const results = await Promise.all([4_000, 4_000, 4_000].map((amount) => h.api.post(`/payments/${p.id}/refunds`, { amount })));
      expect(statuses(results)).toEqual({ 201: 2, 422: 1 });
      expect(results.find((r) => r.status === 422)!.body.error.code).toBe("REFUND_EXCEEDS_CAPTURED_AMOUNT");
      const after = (await h.api.get(`/payments/${p.id}`)).body;
      expect(after).toMatchObject({ refunded_amount: 8_000, status: "PARTIALLY_REFUNDED", version: 5 });
      expect(await ledgerTxnCount(h.pool, p.id, "REFUND")).toBe(2);
    }
  });

  it("two $70 refunds on $100: exactly one succeeds", async () => {
    const p = await h.api.capturedPayment(10_000);
    const results = await Promise.all([7_000, 7_000].map((amount) => h.api.post(`/payments/${p.id}/refunds`, { amount })));
    expect(statuses(results)).toEqual({ 201: 1, 422: 1 });
    expect((await h.api.get(`/payments/${p.id}`)).body.refunded_amount).toBe(7_000);
  });

  it("30 random-sized concurrent refunds: total refunded <= captured, and equals the sum of successes", async () => {
    const p = await h.api.capturedPayment(10_000);
    const amounts = Array.from({ length: 30 }, (_, i) => 100 + ((i * 7919) % 1_900));
    const results = await Promise.all(amounts.map((amount) => h.api.post(`/payments/${p.id}/refunds`, { amount })));
    const succeeded = results.filter((r) => r.status === 201).reduce((s, r) => s + r.body.amount, 0);
    const after = (await h.api.get(`/payments/${p.id}`)).body;
    expect(after.refunded_amount).toBe(succeeded);
    expect(after.refunded_amount).toBeLessThanOrEqual(10_000);
    expect(results.every((r) => r.status === 201 || r.status === 422 || r.status === 409)).toBe(true);
  });

  it("capture racing cancel: exactly one of them wins", async () => {
    for (let i = 0; i < 10; i++) {
      const p = await h.api.authorizedPayment(1_000);
      const [cap, cancel] = await Promise.all([h.api.post(`/payments/${p.id}/capture`), h.api.post(`/payments/${p.id}/cancel`)]);
      expect([cap.status, cancel.status].sort()).toEqual([200, 409]);
      const final = (await h.api.get(`/payments/${p.id}`)).body;
      expect(final.status).toBe(cap.status === 200 ? "CAPTURED" : "CANCELED");
    }
  });

  it("mutations on different payments do not block each other", async () => {
    const payments = await Promise.all(Array.from({ length: 20 }, () => h.api.authorizedPayment(1_000)));
    const results = await Promise.all(payments.map((p) => h.api.post(`/payments/${p.id}/capture`)));
    expect(statuses(results)).toEqual({ 200: 20 });
  });

  it("all invariants hold after the concurrent onslaught", async () => {
    await expectInvariantsHold(h.pool);
  });
});

describe("Demo A: client times out after the server committed, then retries", () => {
  it("captures exactly once and returns the original response on retry", async () => {
    const p = await h.api.authorizedPayment(10_000);
    const key = `timeout-capture-${p.id}`;

    // The server commits the capture, then drops the connection.
    h.ctx.failures.arm("api.after_commit", { match: { paymentId: p.id } });
    await expect(h.api.post(`/payments/${p.id}/capture`, {}, { key, timeoutMs: 2_000 })).rejects.toThrow();

    // From the client's point of view the outcome is unknown. Safe move: retry with the same key.
    const retry = await h.api.post(`/payments/${p.id}/capture`, {}, { key });
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(retry.body).toMatchObject({ status: "CAPTURED", captured_amount: 10_000, version: 3 });

    expect(await ledgerTxnCount(h.pool, p.id, "CAPTURE")).toBe(1);
    expect(await count(h.pool, "SELECT 1 FROM webhook_events WHERE payment_id = $1 AND type = 'payment.captured'", [p.id])).toBe(1);
  });

  it("concurrent retries while the first attempt is still in flight also capture once", async () => {
    const p = await h.api.authorizedPayment(10_000);
    const key = `timeout-race-${p.id}`;
    h.ctx.failures.arm("api.after_commit", { match: { paymentId: p.id } });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => h.api.post(`/payments/${p.id}/capture`, {}, { key })));
    const ok = results.filter((r) => r.status === "fulfilled" && r.value.status === 200);
    expect(ok.length).toBe(9); // one connection was dropped by the injected failure
    expect(await ledgerTxnCount(h.pool, p.id, "CAPTURE")).toBe(1);
  });
});
