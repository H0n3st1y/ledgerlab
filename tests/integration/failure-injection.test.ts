import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { startHarness, type Harness } from "../helpers/harness.js";
import { ledgerTxnCount } from "../helpers/db.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

describe("failure injection over HTTP (/dev)", () => {
  it("lists failure points and arms, fires and clears rules", async () => {
    const list = await h.api.get("/dev/failures");
    expect(Object.keys(list.body.points)).toEqual(
      expect.arrayContaining(["payment.before_commit", "api.after_commit", "worker.after_claim", "worker.after_send", "worker.duplicate_send", "worker.delay_send"]),
    );

    const p = await h.api.authorizedPayment(1_000);
    const armed = await h.api.request("POST", "/dev/failures", { point: "payment.before_commit", match: { payment_id: p.id } });
    expect(armed.status).toBe(201);
    expect((await h.api.get("/dev/failures")).body.armed).toHaveLength(1);

    expect((await h.api.post(`/payments/${p.id}/capture`)).status).toBe(500);
    expect(await ledgerTxnCount(h.pool, p.id, "CAPTURE")).toBe(0);
    const after = (await h.api.get("/dev/failures")).body;
    expect(after.armed).toHaveLength(0);
    expect(after.recently_fired[0]).toMatchObject({ point: "payment.before_commit" });

    await h.api.request("POST", "/dev/failures", { point: "api.after_commit", times: 3 });
    await h.api.request("DELETE", "/dev/failures");
    expect((await h.api.get("/dev/failures")).body.armed).toEqual([]);
  });

  it("rejects unknown failure points", async () => {
    expect((await h.api.request("POST", "/dev/failures", { point: "disk.on_fire" })).status).toBe(400);
  });

  it("configures the sandbox consumer's failure modes", async () => {
    const res = await h.api.request("POST", "/sandbox/consumer/config", { failNext: 2, failStatus: 502 });
    expect(res.body).toMatchObject({ failNext: 2, failStatus: 502 });
    await h.api.request("POST", "/sandbox/consumer/reset", {});
    expect((await h.api.get("/sandbox/consumer/state")).body.failures.failNext).toBe(0);
  });

  it("dev routes do not exist when dev tools are disabled", async () => {
    const app = await buildApp({ ...h.ctx, config: { ...h.ctx.config, enableDevTools: false } });
    expect((await app.inject({ method: "GET", url: "/dev/failures" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/dashboard" })).statusCode).toBe(404);
    await app.close();
  });
});
