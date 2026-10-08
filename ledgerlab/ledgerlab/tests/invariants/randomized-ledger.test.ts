// Demo C: a randomized workload (thousands of operations across many
// payments, interleaved concurrently, with injected rollbacks and duplicate
// retries) must leave the ledger balanced and reconciled.
//
// Runs at the service layer (no HTTP) so it can push volume quickly; the
// HTTP path is covered by tests/property.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { paymentDeps } from "../../src/context.js";
import { InjectedFailure } from "../../src/failures/injector.js";
import { requestHash } from "../../src/idempotency/request-hash.js";
import { checkInvariants } from "../../src/ledger/invariants.js";
import { accountBalances } from "../../src/ledger/ledger-repository.js";
import { createPayment, executePaymentCommand, type PaymentRequest } from "../../src/payments/payment-service.js";
import { startHarness, type Harness } from "../helpers/harness.js";

const OPS = Number(process.env.RANDOM_OPS ?? 3_000);
const PAYMENTS = 300;

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ poolMax: 30 });
});
afterAll(async () => h.close());

describe("Demo C: randomized workload keeps the books balanced", () => {
  it(`${OPS} random operations over ${PAYMENTS} payments, 16 at a time`, async () => {
    const deps = paymentDeps(h.ctx);
    const seed = Number(process.env.SEED ?? 1 + Math.floor(Math.random() * 2 ** 30));
    let state = seed;
    const rand = () => {
      // xorshift32: deterministic per seed, printed on failure.
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 2 ** 32;
    };
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

    const ids: string[] = [];
    // Last status we saw per payment. Racy on purpose; it only steers the
    // generator toward mostly-valid operations so the workload is not 90% rejections.
    const seen = new Map<string, string>();
    for (let i = 0; i < PAYMENTS; i++) {
      const amount = 100 + Math.floor(rand() * 20_000);
      const res = await createPayment(
        deps,
        { amount, currency: pick(["USD", "EUR", "GBP"] as const), paymentMethod: rand() < 0.1 ? "pm_card_declined" : "pm_card_visa" },
        { key: randomUUID(), operation: "POST /payments", requestHash: requestHash("POST /payments", {}, { amount, i }) },
      );
      ids.push((res.body as { id: string }).id);
      seen.set(ids.at(-1)!, "CREATED");
    }

    const stats = { ok: 0, rejected: 0, rolledBack: 0, replayed: 0 };
    const usedKeys: { key: string; paymentId: string; req: PaymentRequest }[] = [];

    const one = async () => {
      const paymentId = pick(ids);
      const key = randomUUID();
      const r = rand();
      if (r < 0.1 && usedKeys.length > 0) {
        // Retry an earlier request verbatim (same key) - must never mutate again.
        const prev = pick(usedKeys);
        await run(prev.paymentId, prev.req, prev.key);
        return;
      }
      const anyOp = (): PaymentRequest =>
        pick<PaymentRequest>([
          { type: "authorize" },
          { type: "capture", amount: 1 + Math.floor(rand() * 20_000) },
          { type: "refund", amount: 1 + Math.floor(rand() * 8_000) },
          { type: "cancel" },
        ]);
      const likely = (): PaymentRequest => {
        switch (seen.get(paymentId)) {
          case "CREATED":
            return rand() < 0.95 ? { type: "authorize" } : { type: "cancel" };
          case "AUTHORIZED":
            return rand() < 0.9 ? { type: "capture", amount: rand() < 0.7 ? undefined : 1 + Math.floor(rand() * 20_000) } : { type: "cancel" };
          default:
            return { type: "refund", amount: 1 + Math.floor(rand() * 3_000) };
        }
      };
      const req = r < 0.3 ? anyOp() : likely();
      if (rand() < 0.05) h.ctx.failures.arm("payment.before_commit", { match: { paymentId } });
      usedKeys.push({ key, paymentId, req });
      await run(paymentId, req, key);
    };

    const run = async (paymentId: string, req: PaymentRequest, key: string) => {
      const operation = `POST /payments/:id/${req.type}`;
      try {
        const res = await executePaymentCommand(deps, paymentId, req, {
          key,
          operation,
          requestHash: requestHash(operation, { id: paymentId }, req),
        });
        if (res.replayed) stats.replayed++;
        else if (res.statusCode < 300) stats.ok++;
        else stats.rejected++;
        const body = res.body as { status?: string; payment?: { status: string } };
        const status = body.payment?.status ?? body.status;
        if (status) seen.set(paymentId, status);
      } catch (err) {
        if (err instanceof InjectedFailure) stats.rolledBack++;
        else throw err;
      }
    };

    const CONCURRENCY = 16;
    let remaining = OPS;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (remaining-- > 0) await one();
      }),
    );
    h.ctx.failures.clear();

    const report = await checkInvariants(h.pool);
    expect(report.violations, `seed=${seed} ${JSON.stringify(report.violations).slice(0, 2000)}`).toEqual([]);

    // Account balances tie out to the payment rows, per currency.
    const balances = await accountBalances(h.pool);
    const totals = await h.pool.query<{ currency: string; captured: number; refunded: number; holds: number }>(
      `SELECT currency, COALESCE(sum(captured_amount),0) AS captured, COALESCE(sum(refunded_amount),0) AS refunded,
              COALESCE(sum(authorized_amount) FILTER (WHERE status = 'AUTHORIZED'),0) AS holds
         FROM payments GROUP BY currency`,
    );
    for (const t of totals.rows) {
      const bal = (code: string) => balances.find((b) => b.code === code && b.currency === t.currency)!.balance;
      expect(bal("processor_clearing")).toBe(t.captured);
      expect(bal("refund_clearing")).toBe(t.refunded);
      expect(bal("merchant_payable")).toBe(t.captured - t.refunded);
      expect(bal("customer_authorization_holds")).toBe(t.holds);
    }
    const debits = balances.reduce((s, b) => s + b.debits, 0);
    const credits = balances.reduce((s, b) => s + b.credits, 0);
    expect(debits).toBe(credits);
    expect(stats.ok).toBeGreaterThan(OPS / 4);
    expect(stats.rolledBack).toBeGreaterThan(0);
    console.error(`[demo C] seed=${seed} ${JSON.stringify(stats)} total debits=${debits} credits=${credits}`);
  });
});
