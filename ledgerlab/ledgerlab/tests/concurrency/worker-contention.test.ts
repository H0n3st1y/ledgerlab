import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../helpers/harness.js";
import { expectInvariantsHold, waitFor } from "../helpers/db.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ poolMax: 30, worker: { batchSize: 5, pollIntervalMs: 10 } });
  await h.registerConsumer();
});
afterAll(async () => h.close());

describe("worker contention", () => {
  it("4 workers racing over the same queue deliver every event exactly once", async () => {
    // Build the backlog first, then release the workers on it all at once.
    const payments = await Promise.all(Array.from({ length: 40 }, () => h.api.capturedPayment(1_000)));
    const { rows } = await h.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_deliveries");
    const total = rows[0]!.n;
    expect(total).toBe(payments.length * 3);

    const workers = ["w1", "w2", "w3", "w4"].map((id) => h.worker(id));
    await Promise.all(workers.map((w) => w.start()));
    await waitFor(
      async () => {
        const r = await h.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_deliveries WHERE status = 'DELIVERED'");
        return r.rows[0]!.n === total;
      },
      { timeoutMs: 20_000 },
    );
    await Promise.all(workers.map((w) => w.stop()));

    // Exactly one attempt per delivery: no row was claimed twice.
    const attempts = await h.pool.query<{ delivery_id: string; n: number }>(
      "SELECT delivery_id, count(*)::int AS n FROM webhook_delivery_attempts GROUP BY delivery_id HAVING count(*) <> 1",
    );
    expect(attempts.rows).toEqual([]);

    // The consumer saw each event once; no duplicates despite 4 concurrent claimers.
    const received = h.consumer.log.filter((l) => l.outcome !== "injected_failure");
    expect(received).toHaveLength(total);
    expect(new Set(received.map((l) => l.webhookId)).size).toBe(total);
    expect(received.filter((l) => l.outcome === "duplicate")).toHaveLength(0);

    // Work was actually shared.
    const byWorker = await h.pool.query<{ worker_id: string; n: number }>(
      "SELECT worker_id, count(*)::int AS n FROM webhook_delivery_attempts GROUP BY worker_id",
    );
    expect(byWorker.rows.length).toBeGreaterThanOrEqual(2);
    await expectInvariantsHold(h.pool);
  });

  it("concurrent claim() calls return disjoint sets of deliveries", async () => {
    await Promise.all(Array.from({ length: 30 }, () => h.api.createPayment(500)));
    const workers = Array.from({ length: 6 }, (_, i) => h.worker(`claimer-${i}`));
    const claims = await Promise.all(workers.map((w) => w.claim(10)));
    const ids = claims.flat().map((j) => j.deliveryId);
    expect(ids.length).toBe(30);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
