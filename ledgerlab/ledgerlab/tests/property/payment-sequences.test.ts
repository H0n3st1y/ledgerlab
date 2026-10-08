// Model-based property tests. fast-check generates random operation
// sequences (including retries, duplicates, invalid requests and concurrent
// bursts), runs them against the real HTTP API and Postgres, and compares the
// result with an independent, deliberately simple model. After every
// sequence the SQL invariant suite must pass.
//
// PROPERTY_RUNS scales the number of sequences (default 200).

import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkInvariants } from "../../src/ledger/invariants.js";
import { startHarness, type Harness } from "../helpers/harness.js";
import type { ApiResponse } from "../helpers/api-client.js";

const RUNS = Number(process.env.PROPERTY_RUNS ?? 200);

let h: Harness;
beforeAll(async () => {
  h = await startHarness({ poolMax: 30 });
});
afterAll(async () => h.close());

type Model = {
  status: string;
  amount: number;
  authorized: number;
  captured: number;
  refunded: number;
  version: number;
  declines: boolean;
};

// Amounts are either absolute or relative to what is left ("exactly the
// remainder", "remainder +/- 1", "half"). Relative amounts matter: uniformly
// random amounts almost never land on the boundaries where off-by-one bugs live.
type AmountSpec = number | "all" | "allMinus1" | "allPlus1" | "half";

type Op =
  | { kind: "authorize" }
  | { kind: "capture"; amount: AmountSpec | null }
  | { kind: "refund"; amount: AmountSpec }
  | { kind: "cancel" }
  | { kind: "retryLast" }
  | { kind: "duplicateConcurrent"; inner: GenOp; copies: number }
  | { kind: "concurrentRefunds"; amounts: AmountSpec[] };
type GenOp = Extract<Op, { kind: "authorize" | "capture" | "refund" | "cancel" }>;
type SimpleOp =
  | { kind: "authorize" }
  | { kind: "capture"; amount: number | null }
  | { kind: "refund"; amount: number }
  | { kind: "cancel" };

const amountArb: fc.Arbitrary<AmountSpec> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 12_000 }) },
  { weight: 2, arbitrary: fc.constantFrom("all" as const, "allMinus1" as const, "allPlus1" as const, "half" as const) },
);
const genOp: fc.Arbitrary<GenOp> = fc.oneof(
  fc.constant({ kind: "authorize" as const }),
  fc.record({ kind: fc.constant("capture" as const), amount: fc.option(amountArb, { nil: null }) }),
  fc.record({ kind: fc.constant("refund" as const), amount: amountArb }),
  fc.constant({ kind: "cancel" as const }),
);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: genOp },
  { weight: 2, arbitrary: fc.constant({ kind: "retryLast" as const }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("duplicateConcurrent" as const), inner: genOp, copies: fc.integer({ min: 2, max: 6 }) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("concurrentRefunds" as const), amounts: fc.array(amountArb, { minLength: 2, maxLength: 5 }) }) },
);

function resolveAmount(spec: AmountSpec, remaining: number): number {
  if (typeof spec === "number") return spec;
  const r = Math.max(remaining, 1);
  switch (spec) {
    case "all":
      return r;
    case "allMinus1":
      return Math.max(r - 1, 1);
    case "allPlus1":
      return r + 1;
    case "half":
      return Math.max(Math.floor(r / 2), 1);
  }
}

function resolve(m: Model, op: GenOp): SimpleOp {
  if (op.kind === "capture") return { kind: "capture", amount: op.amount === null ? null : resolveAmount(op.amount, m.authorized) };
  if (op.kind === "refund") return { kind: "refund", amount: resolveAmount(op.amount, m.captured - m.refunded) };
  return op;
}

/** The independent model: what a single, serial request should do. Returns the expected HTTP status. */
function expectSimple(m: Model, op: SimpleOp): { status: number; next: Model } {
  const bump = (patch: Partial<Model>) => ({ ...m, ...patch, version: m.version + 1 });
  switch (op.kind) {
    case "authorize":
      if (m.status !== "CREATED") return { status: 409, next: m };
      if (m.declines) return { status: 402, next: bump({ status: "FAILED" }) };
      return { status: 200, next: bump({ status: "AUTHORIZED", authorized: m.amount }) };
    case "capture": {
      if (m.status !== "AUTHORIZED") return { status: 409, next: m };
      const amt = op.amount ?? m.authorized;
      if (amt > m.authorized) return { status: 422, next: m };
      return { status: 200, next: bump({ status: "CAPTURED", captured: amt }) };
    }
    case "refund": {
      if (m.status !== "CAPTURED" && m.status !== "PARTIALLY_REFUNDED") return { status: 409, next: m };
      if (m.refunded + op.amount > m.captured) return { status: 422, next: m };
      const refunded = m.refunded + op.amount;
      return { status: 201, next: bump({ refunded, status: refunded === m.captured ? "REFUNDED" : "PARTIALLY_REFUNDED" }) };
    }
    case "cancel":
      if (m.status !== "CREATED" && m.status !== "AUTHORIZED") return { status: 409, next: m };
      return { status: 200, next: bump({ status: "CANCELED" }) };
  }
}

function request(paymentId: string, op: SimpleOp, key: string): Promise<ApiResponse> {
  switch (op.kind) {
    case "authorize":
      return h.api.post(`/payments/${paymentId}/authorize`, undefined, { key });
    case "capture":
      return h.api.post(`/payments/${paymentId}/capture`, op.amount === null ? {} : { amount: op.amount }, { key });
    case "refund":
      return h.api.post(`/payments/${paymentId}/refunds`, { amount: op.amount }, { key });
    case "cancel":
      return h.api.post(`/payments/${paymentId}/cancel`, {}, { key });
  }
}

async function serverState(paymentId: string) {
  const p = (await h.api.get(`/payments/${paymentId}`)).body;
  return { status: p.status, authorized: p.authorized_amount, captured: p.captured_amount, refunded: p.refunded_amount, version: p.version };
}

describe("randomized operation sequences against the real API", () => {
  it(`${RUNS} sequences: server matches the model and every invariant holds`, async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 100, max: 10_000 }),
        fc.boolean(),
        fc.array(opArb, { minLength: 1, maxLength: 14 }),
        async (amount, declines, ops) => {
          const created = await h.api.createPayment(amount, { payment_method: declines ? "pm_card_declined" : "pm_card_visa" });
          let model: Model = { status: "CREATED", amount, authorized: 0, captured: 0, refunded: 0, version: 1, declines };
          let last: { op: SimpleOp; key: string; res: ApiResponse; modelAfter: Model } | null = null;

          for (const op of ops) {
            if (op.kind === "retryLast") {
              if (!last) continue;
              const res = await request(created.id, last.op, last.key);
              // Same key, same request: same answer, and nothing new happens.
              expect(res.status).toBe(last.res.status);
              expect(res.body).toEqual(last.res.body);
              expect(res.headers.get("idempotent-replayed")).toBe("true");
            } else if (op.kind === "duplicateConcurrent") {
              const key = randomUUID();
              const inner = resolve(model, op.inner);
              const results = await Promise.all(Array.from({ length: op.copies }, () => request(created.id, inner, key)));
              const expected = expectSimple(model, inner);
              for (const r of results) {
                expect(r.status).toBe(expected.status);
                expect(r.body).toEqual(results[0]!.body);
              }
              model = expected.next;
              last = { op: inner, key, res: results[0]!, modelAfter: model };
            } else if (op.kind === "concurrentRefunds") {
              const remaining = model.captured - model.refunded;
              const results = await Promise.all(
                op.amounts.map((a) => request(created.id, { kind: "refund", amount: resolveAmount(a, remaining) }, randomUUID())),
              );
              const ok = results.filter((r) => r.status === 201);
              for (const r of results) expect([201, 409, 422]).toContain(r.status);
              const refundedNow = model.refunded + ok.reduce((s, r) => s + (r.body.amount as number), 0);
              expect(refundedNow).toBeLessThanOrEqual(model.captured || 0);
              if (ok.length > 0) {
                model = {
                  ...model,
                  refunded: refundedNow,
                  version: model.version + ok.length,
                  status: refundedNow === model.captured ? "REFUNDED" : "PARTIALLY_REFUNDED",
                };
              }
              last = null;
            } else {
              const key = randomUUID();
              const simple = resolve(model, op);
              const res = await request(created.id, simple, key);
              const expected = expectSimple(model, simple);
              expect(res.status, `${simple.kind} from ${model.status}: ${JSON.stringify(res.body)}`).toBe(expected.status);
              model = expected.next;
              last = { op: simple, key, res, modelAfter: model };
            }

            const s = await serverState(created.id);
            expect(s).toEqual({
              status: model.status,
              authorized: model.authorized,
              captured: model.captured,
              refunded: model.refunded,
              version: model.version,
            });
            expect(s.authorized).toBeGreaterThanOrEqual(s.captured);
            expect(s.captured).toBeGreaterThanOrEqual(s.refunded);
          }

          const report = await checkInvariants(h.pool);
          expect(report.violations).toEqual([]);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
