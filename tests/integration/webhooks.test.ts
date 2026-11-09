import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SimulatedCrash } from "../../src/failures/injector.js";
import { startHarness, type Harness } from "../helpers/harness.js";
import { count, expectInvariantsHold, waitFor } from "../helpers/db.js";

let h: Harness;

beforeAll(async () => {
  h = await startHarness({ worker: { maxAttempts: 4, backoffBaseMs: 20, backoffMaxMs: 100, httpTimeoutMs: 500, leaseMs: 800 } });
  await h.registerConsumer();
});
afterAll(async () => h.close());
beforeEach(async () => {
  // Start every test from an empty queue so a worker's batch only contains
  // this test's deliveries.
  h.ctx.failures.clear();
  h.consumer.reset();
  const drain = h.worker("drain");
  await waitFor(async () => {
    await drain.runOnce();
    const { rows } = await h.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM webhook_deliveries WHERE status IN ('PENDING', 'DELIVERING')",
    );
    return rows[0]!.n === 0;
  }, { timeoutMs: 10_000, intervalMs: 50 });
  h.consumer.reset();
});

type Delivery = {
  id: string;
  event_id: string;
  status: string;
  origin: string;
  replay_of: string | null;
  attempt_count: number;
  attempts: { attempt_number: number; outcome: string; http_status: number | null; error: string | null; worker_id: string }[];
};

async function deliveriesFor(paymentId: string, type?: string): Promise<Delivery[]> {
  const res = await h.api.get(`/webhook-deliveries?payment_id=${paymentId}&limit=500`);
  const events = (await h.api.get(`/payments/${paymentId}/events`)).body.data as { id: string; type: string }[];
  const ids = new Set(events.filter((e) => !type || e.type === type).map((e) => e.id));
  return (res.body.data as Delivery[]).filter((d) => ids.has(d.event_id));
}

const consumerLog = (paymentId: string) => h.consumer.log.filter((l) => l.paymentId === paymentId);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs worker passes until `done()` or timeout, sleeping between empty passes (backoff). */
async function pump(worker: ReturnType<Harness["worker"]>, done: () => Promise<boolean>, timeoutMs = 8_000) {
  await waitFor(async () => {
    await worker.runOnce().catch((e) => {
      if (!(e instanceof SimulatedCrash)) throw e;
    });
    return done();
  }, { timeoutMs, intervalMs: 30 });
}

describe("transactional outbox", () => {
  it("each committed state change writes exactly one event and one delivery per subscribed endpoint", async () => {
    const p = await h.api.capturedPayment(1_000);
    const events = (await h.api.get(`/payments/${p.id}/events`)).body.data;
    expect(events).toHaveLength(3);
    expect(events.map((e: { payment_version: number }) => e.payment_version).sort()).toEqual([1, 2, 3]);
    const deliveries = await deliveriesFor(p.id);
    expect(deliveries).toHaveLength(3);
    expect(deliveries.every((d) => d.status === "PENDING" && d.origin === "EVENT")).toBe(true);
  });

  it("respects endpoint event filters", async () => {
    const res = await h.api.post("/webhook-endpoints", { url: "http://127.0.0.1:9/never", enabled_events: ["payment.refunded"] });
    const filtered = res.body.id;
    const p = await h.api.capturedPayment(1_000);
    await h.api.post(`/payments/${p.id}/refunds`, { amount: 1_000 });
    const rows = await h.pool.query("SELECT e.type FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id WHERE d.endpoint_id = $1", [filtered]);
    expect(rows.rows.map((r) => r.type)).toEqual(["payment.refunded"]);
    await h.api.post(`/webhook-endpoints/${filtered}/disable`, {});
  });

  it("a rolled-back payment transaction leaves no event and no delivery", async () => {
    const p = await h.api.authorizedPayment(1_000);
    h.ctx.failures.arm("payment.before_commit", { match: { paymentId: p.id } });
    expect((await h.api.post(`/payments/${p.id}/capture`)).status).toBe(500);
    expect(await count(h.pool, "SELECT 1 FROM webhook_events WHERE payment_id = $1 AND type = 'payment.captured'", [p.id])).toBe(0);
  });

  it("the endpoint secret is returned once and never listed", async () => {
    const list = await h.api.get("/webhook-endpoints");
    expect(list.body.data.every((e: Record<string, unknown>) => !("secret" in e))).toBe(true);
  });
});

describe("webhook delivery worker", () => {
  it("delivers signed webhooks the consumer can verify", async () => {
    const p = await h.api.capturedPayment(1_000);
    const w = h.worker("w-basic");
    await pump(w, async () => (await deliveriesFor(p.id)).every((d) => d.status === "DELIVERED"));
    const log = consumerLog(p.id);
    expect(log.map((l) => l.outcome).every((o) => o === "processed" || o === "stale")).toBe(true);
    expect(new Set(log.map((l) => l.webhookId)).size).toBe(3);
    const d = (await deliveriesFor(p.id))[0]!;
    expect(d.attempts).toEqual([expect.objectContaining({ attempt_number: 1, outcome: "SUCCEEDED", http_status: 200, worker_id: "w-basic" })]);
  });

  it("retries 500s with backoff and records every attempt", async () => {
    const p = await h.api.createPayment(1_000);
    h.consumer.configure({ failNext: 2, failStatus: 503 });
    const w = h.worker();
    await pump(w, async () => (await deliveriesFor(p.id))[0]?.status === "DELIVERED");
    const [d] = await deliveriesFor(p.id);
    expect(d!.attempts.map((a) => [a.attempt_number, a.outcome, a.http_status])).toEqual([
      [1, "FAILED", 503],
      [2, "FAILED", 503],
      [3, "SUCCEEDED", 200],
    ]);
  });

  it("treats a slow consumer as a timeout and retries", async () => {
    const p = await h.api.createPayment(1_000);
    h.consumer.configure({ delayMs: 700 }); // > httpTimeoutMs (500)
    const w = h.worker();
    await w.runOnce();
    h.consumer.configure({ delayMs: 0 });
    await pump(w, async () => (await deliveriesFor(p.id))[0]?.status === "DELIVERED");
    const [d] = await deliveriesFor(p.id);
    expect(d!.attempts[0]).toMatchObject({ outcome: "FAILED", http_status: null, error: "timeout after 500ms" });
    expect(d!.attempts.at(-1)).toMatchObject({ outcome: "SUCCEEDED" });
  });

  it("gives up after max_attempts and marks the delivery FAILED", async () => {
    const p = await h.api.createPayment(1_000);
    h.consumer.configure({ failNext: 100 });
    const w = h.worker();
    await pump(w, async () => (await deliveriesFor(p.id))[0]?.status === "FAILED");
    const [d] = await deliveriesFor(p.id);
    expect(d!.attempt_count).toBe(4);
    expect(d!.attempts.map((a) => a.outcome)).toEqual(["FAILED", "FAILED", "FAILED", "FAILED"]);
  });

  it("Demo E: a failed webhook can be replayed; history stays immutable", async () => {
    const p = await h.api.createPayment(1_000);
    h.consumer.configure({ failNext: 100 });
    const w = h.worker();
    await pump(w, async () => (await deliveriesFor(p.id))[0]?.status === "FAILED");
    const [failed] = await deliveriesFor(p.id);
    const eventBefore = (await h.api.get(`/webhook-events/${failed!.event_id}`)).body;

    h.consumer.configure({ failNext: 0 });
    const replay = await h.api.post(`/webhook-events/${failed!.event_id}/replay`, {});
    expect(replay.status).toBe(202);
    expect(replay.body.deliveries).toEqual([expect.objectContaining({ origin: "REPLAY", replay_of: failed!.id, status: "PENDING", attempt_count: 0 })]);

    await pump(w, async () => (await deliveriesFor(p.id)).some((d) => d.origin === "REPLAY" && d.status === "DELIVERED"));
    const after = await deliveriesFor(p.id);
    const original = after.find((d) => d.id === failed!.id)!;
    expect(original.status).toBe("FAILED");
    expect(original.attempts).toEqual(failed!.attempts);

    const eventAfter = (await h.api.get(`/webhook-events/${failed!.event_id}`)).body;
    expect({ ...eventAfter, deliveries: undefined }).toEqual({ ...eventBefore, deliveries: undefined });
    expect(eventAfter.deliveries).toHaveLength(2);
    // The consumer sees the same webhook-id it would have seen originally.
    expect(consumerLog(p.id).filter((l) => l.outcome === "processed").map((l) => l.webhookId)).toEqual([failed!.event_id]);
  });

  it("replay is idempotent when an Idempotency-Key is supplied", async () => {
    const p = await h.api.createPayment(1_000);
    const [d] = await deliveriesFor(p.id);
    const a = await h.api.post(`/webhook-events/${d!.event_id}/replay`, {}, { key: `replay-${d!.id}` });
    const b = await h.api.post(`/webhook-events/${d!.event_id}/replay`, {}, { key: `replay-${d!.id}` });
    expect(b.body).toEqual(a.body);
    expect((await deliveriesFor(p.id)).filter((x) => x.origin === "REPLAY")).toHaveLength(1);
  });

  it("Demo D: a worker that crashes after claiming loses nothing; another worker retries after the lease expires", async () => {
    const p = await h.api.createPayment(1_000);
    h.ctx.failures.arm("worker.after_claim", { match: { paymentId: p.id } });
    const a = h.worker("crashy");
    await expect(a.runOnce()).rejects.toBeInstanceOf(SimulatedCrash);

    const [stuck] = await deliveriesFor(p.id);
    expect(stuck).toMatchObject({ status: "DELIVERING", attempt_count: 1 });

    const b = h.worker("rescuer");
    await b.runOnce(); // lease still valid: nothing to claim for this payment
    expect((await deliveriesFor(p.id))[0]!.status).toBe("DELIVERING");

    await sleep(900); // > leaseMs
    await pump(b, async () => (await deliveriesFor(p.id))[0]?.status === "DELIVERED");
    const [d] = await deliveriesFor(p.id);
    expect(d!.attempts.map((x) => [x.attempt_number, x.outcome, x.worker_id])).toEqual([
      [1, "LEASE_EXPIRED", "crashy"],
      [2, "SUCCEEDED", "rescuer"],
    ]);
  });

  it("Demo F: crash after the consumer accepted the webhook causes a redelivery the consumer dedupes", async () => {
    const p = await h.api.createPayment(1_000);
    h.ctx.failures.arm("worker.after_send", { match: { paymentId: p.id } });
    const a = h.worker("dies-after-send");
    await expect(a.runOnce()).rejects.toBeInstanceOf(SimulatedCrash);
    expect(consumerLog(p.id).map((l) => l.outcome)).toEqual(["processed"]);

    await sleep(900);
    await pump(h.worker(), async () => (await deliveriesFor(p.id))[0]?.status === "DELIVERED");
    expect(consumerLog(p.id).map((l) => l.outcome)).toEqual(["processed", "duplicate"]);
    expect(h.consumer.processed.size).toBe(1);
  });

  it("an injected duplicate send is deduplicated by the consumer", async () => {
    const p = await h.api.createPayment(1_000);
    h.ctx.failures.arm("worker.duplicate_send", { match: { paymentId: p.id } });
    await pump(h.worker(), async () => (await deliveriesFor(p.id))[0]?.status === "DELIVERED");
    expect(consumerLog(p.id).map((l) => l.outcome)).toEqual(["processed", "duplicate"]);
  });

  it("fencing: a worker whose lease expired mid-send cannot overwrite the new owner's result", async () => {
    const p = await h.api.createPayment(1_000);
    h.ctx.failures.arm("worker.delay_send", { match: { paymentId: p.id }, delayMs: 1_100 }); // > leaseMs
    const slow = h.worker("slow");
    const slowRun = slow.runOnce();
    await sleep(900);
    const fast = h.worker("fast");
    await pump(fast, async () => (await deliveriesFor(p.id))[0]?.status === "DELIVERED");
    await slowRun;

    const [d] = await deliveriesFor(p.id);
    expect(d!.attempts.map((x) => [x.attempt_number, x.outcome, x.worker_id])).toEqual([
      [1, "LEASE_EXPIRED", "slow"],
      [2, "SUCCEEDED", "fast"],
    ]);
    expect(h.ctx.metrics.get("ledgerlab_webhook_lost_lease_total")).toBeGreaterThanOrEqual(1);
  });

  it("Demo G: refund notification arrives before the capture notification; versions expose the stale one", async () => {
    const w = h.worker("ordered", { backoffBaseMs: 1_500, backoffMaxMs: 1_500 });
    const p = await h.api.authorizedPayment(10_000);
    await pump(w, async () => (await deliveriesFor(p.id)).every((d) => d.status === "DELIVERED"));

    h.consumer.configure({ failEventType: "payment.captured", failEventTypeTimes: 1 });
    await h.api.post(`/payments/${p.id}/capture`);
    await w.runOnce(); // captured (v3) fails; retry scheduled >= 750ms out
    await h.api.post(`/payments/${p.id}/refunds`, { amount: 10_000 });
    await pump(w, async () => (await deliveriesFor(p.id, "payment.refunded"))[0]?.status === "DELIVERED");
    await pump(w, async () => (await deliveriesFor(p.id, "payment.captured"))[0]?.status === "DELIVERED");

    const arrivals = consumerLog(p.id).map((l) => [l.type, l.paymentVersion, l.outcome]);
    expect(arrivals.slice(-3)).toEqual([
      ["payment.captured", 3, "injected_failure"],
      ["payment.refunded", 4, "processed"],
      ["payment.captured", 3, "stale"],
    ]);
    expect(h.consumer.payments.get(p.id)).toMatchObject({ status: "REFUNDED", version: 4 });
  });

  it("a restarted worker picks up deliveries left pending by a stopped one", async () => {
    const p = await h.api.createPayment(1_000);
    const first = h.worker("first");
    await first.start();
    await first.stop();
    const second = h.worker("second");
    await second.start();
    await waitFor(async () => (await deliveriesFor(p.id))[0]?.status === "DELIVERED");
    await second.stop();
  });

  it("invariants hold, including delivery attempt bookkeeping", async () => {
    await expectInvariantsHold(h.pool);
  });
});
