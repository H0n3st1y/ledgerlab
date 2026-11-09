// npm run demo
//
// Runs the seven "definition of done" demonstrations end to end against a
// throwaway Postgres database, with a real HTTP server, the real webhook
// worker and the reference consumer. Prints what happened and checks the
// expected outcome of each. Exit code 1 if any check fails.

import "../src/load-env.js";
import { SimulatedCrash } from "../src/failures/injector.js";
import { checkInvariants } from "../src/ledger/invariants.js";
import { startHarness, type Harness } from "../tests/helpers/harness.js";

const c = { dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", bold: "\x1b[1m", reset: "\x1b[0m" };
let failures = 0;
const say = (s: string) => console.log(`  ${c.dim}→${c.reset} ${s}`);
const check = (ok: boolean, s: string) => {
  if (!ok) failures++;
  console.log(`  ${ok ? `${c.green}✓` : `${c.red}✗`}${c.reset} ${s}`);
};
const title = (s: string) => console.log(`\n${c.bold}${s}${c.reset}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usd = (n: number) => `$${(n / 100).toFixed(2)}`;

async function n(h: Harness, sql: string, params: unknown[] = []) {
  return (await h.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params)).rows[0]!.n;
}

async function deliveries(h: Harness, paymentId: string, type?: string) {
  const { rows } = await h.pool.query(
    `SELECT d.id, d.status, d.origin, e.type, e.id AS event_id FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id
      WHERE e.payment_id = $1 AND ($2::text IS NULL OR e.type = $2) ORDER BY d.created_at`,
    [paymentId, type ?? null],
  );
  return rows as { id: string; status: string; origin: string; type: string; event_id: string }[];
}

async function pump(h: Harness, worker: ReturnType<Harness["worker"]>, until: () => Promise<boolean>, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!(await until())) {
    if (Date.now() > end) throw new Error("timed out waiting for the worker");
    await worker.runOnce().catch((e) => {
      if (!(e instanceof SimulatedCrash)) throw e;
    });
    await sleep(30);
  }
}

/** Delivers any backlog from earlier demos so each webhook demo starts from an empty queue. */
async function drainBacklog(h: Harness) {
  const w = h.worker("drain");
  await pump(h, w, async () => (await n(h, "SELECT 1 FROM webhook_deliveries WHERE status IN ('PENDING', 'DELIVERING')")) === 0, 30_000);
}

async function demoA(h: Harness) {
  title("Demo A: safe retry after a client timeout");
  const p = await h.api.authorizedPayment(10_000);
  const key = `demo-a-${p.id}`;
  h.ctx.failures.arm("api.after_commit", { match: { paymentId: p.id } });
  say(`POST /payments/${p.id.slice(0, 8)}…/capture  Idempotency-Key: ${key.slice(0, 18)}…`);
  say("server commits the capture, then the connection drops before the response");
  const first = await h.api.post(`/payments/${p.id}/capture`, {}, { key }).then(
    (r) => `HTTP ${r.status}`,
    (e: Error) => `${e.name}: ${e.message}`,
  );
  say(`client sees: ${first}  (outcome unknown, so it retries)`);
  const retry = await h.api.post(`/payments/${p.id}/capture`, {}, { key });
  say(`retry: HTTP ${retry.status}, idempotent-replayed: ${retry.headers.get("idempotent-replayed")}, status ${retry.body.status}`);
  const captures = await n(h, "SELECT 1 FROM ledger_transactions WHERE payment_id = $1 AND kind = 'CAPTURE'", [p.id]);
  check(retry.status === 200 && retry.body.status === "CAPTURED", "retry returns the original 200 response");
  check(captures === 1, `exactly one capture ledger transaction (found ${captures})`);
}

async function demoB(h: Harness) {
  title("Demo B: three $40 refunds race against a $100 capture");
  const p = await h.api.capturedPayment(10_000);
  const results = await Promise.all([4_000, 4_000, 4_000].map((amount) => h.api.post(`/payments/${p.id}/refunds`, { amount })));
  for (const r of results) say(`refund $40 → HTTP ${r.status}${r.status === 201 ? "" : ` ${r.body.error.code}`}`);
  const final = (await h.api.get(`/payments/${p.id}`)).body;
  check(final.refunded_amount <= 10_000, `refunded ${usd(final.refunded_amount)} of ${usd(final.captured_amount)} (never more than $100)`);
  check(results.filter((r) => r.status === 201).length === 2, "exactly two refunds succeeded; the third was rejected under the row lock");
}

async function demoC(h: Harness) {
  title("Demo C: randomized payments, captures and refunds keep the ledger balanced");
  const ops: Promise<unknown>[] = [];
  for (let i = 0; i < 40; i++) {
    ops.push(
      (async () => {
        const amount = 500 + Math.floor(Math.random() * 20_000);
        const p = await h.api.capturedPayment(amount);
        await Promise.all(
          Array.from({ length: 4 }, () => h.api.post(`/payments/${p.id}/refunds`, { amount: 1 + Math.floor(Math.random() * amount * 0.4) })),
        );
      })(),
    );
  }
  await Promise.all(ops);
  const { rows } = await h.pool.query<{ d: number; c: number }>(
    "SELECT COALESCE(sum(debit_amount),0) AS d, COALESCE(sum(credit_amount),0) AS c FROM ledger_entries",
  );
  say(`40 payments, 160 concurrent refunds; total debits ${usd(rows[0]!.d)}, total credits ${usd(rows[0]!.c)}`);
  const report = await checkInvariants(h.pool);
  check(rows[0]!.d === rows[0]!.c, "total debits == total credits");
  check(report.ok, `all ${report.checked.length} invariant checks pass${report.ok ? "" : `: ${report.violations.map((v) => v.invariant).join(", ")}`}`);
}

async function demoD(h: Harness) {
  title("Demo D: a webhook worker crashes mid-job; the event is retried, not lost");
  const p = await h.api.createPayment(1_000);
  h.ctx.failures.arm("worker.after_claim", { match: { paymentId: p.id } });
  const crashy = h.worker("worker-A");
  await crashy.runOnce().catch((e: Error) => say(`worker-A: ${e.message} (its lease on the delivery is left behind)`));
  say(`delivery status: ${(await deliveries(h, p.id))[0]!.status}; waiting for the ${h.ctx.config.worker.leaseMs}ms lease to expire…`);
  await sleep(h.ctx.config.worker.leaseMs + 100);
  const rescuer = h.worker("worker-B");
  await pump(h, rescuer, async () => (await deliveries(h, p.id))[0]!.status === "DELIVERED");
  const { rows } = await h.pool.query(
    "SELECT attempt_number, outcome, worker_id FROM webhook_delivery_attempts WHERE delivery_id = $1 ORDER BY attempt_number",
    [(await deliveries(h, p.id))[0]!.id],
  );
  for (const a of rows) say(`attempt ${a.attempt_number}: ${a.outcome} (${a.worker_id})`);
  check(rows.at(-1)?.outcome === "SUCCEEDED", "worker-B reclaimed the expired lease and delivered the event");
}

async function demoE(h: Harness) {
  title("Demo E: replay a webhook that failed permanently");
  const p = await h.api.createPayment(1_000);
  h.consumer.configure({ failNext: 1_000, failStatus: 500 });
  const w = h.worker("worker-E");
  await pump(h, w, async () => (await deliveries(h, p.id))[0]!.status === "FAILED");
  const [failed] = await deliveries(h, p.id);
  const before = await h.pool.query("SELECT * FROM webhook_delivery_attempts WHERE delivery_id = $1 ORDER BY attempt_number", [failed!.id]);
  say(`original delivery FAILED after ${before.rowCount} attempts (consumer returned 500)`);
  h.consumer.configure({ failNext: 0 });
  const replay = await h.api.post(`/webhook-events/${failed!.event_id}/replay`, {});
  say(`POST /webhook-events/…/replay → HTTP ${replay.status}, new delivery ${replay.body.deliveries[0].id.slice(0, 8)}… (origin REPLAY)`);
  await pump(h, w, async () => (await deliveries(h, p.id)).some((d) => d.origin === "REPLAY" && d.status === "DELIVERED"));
  const after = await h.pool.query("SELECT * FROM webhook_delivery_attempts WHERE delivery_id = $1 ORDER BY attempt_number", [failed!.id]);
  const all = await deliveries(h, p.id);
  check(JSON.stringify(after.rows) === JSON.stringify(before.rows), "original delivery's attempt history is unchanged");
  check(all.length === 2 && all[0]!.status === "FAILED" && all[1]!.status === "DELIVERED", "a second delivery row records the successful replay");
}

async function demoF(h: Harness) {
  title("Demo F: the same webhook reaches the consumer twice");
  const p = await h.api.createPayment(1_000);
  h.ctx.failures.arm("worker.after_send", { match: { paymentId: p.id } });
  const w = h.worker("worker-F");
  await w.runOnce().catch((e: Error) => say(`worker: consumer accepted the webhook, then ${e.message}`));
  await sleep(h.ctx.config.worker.leaseMs + 100);
  await pump(h, h.worker("worker-F2"), async () => (await deliveries(h, p.id))[0]!.status === "DELIVERED");
  const log = h.consumer.log.filter((l) => l.paymentId === p.id);
  for (const l of log) say(`consumer received webhook-id ${l.webhookId?.slice(0, 8)}…, attempt ${l.attempt}: ${l.outcome}`);
  check(log.length === 2 && log[1]!.outcome === "duplicate", "second copy recognized by webhook-id and not reprocessed");
}

async function demoG(h: Harness) {
  title("Demo G: refund notification arrives before the capture notification");
  const w = h.worker("worker-G", { backoffBaseMs: 1_500, backoffMaxMs: 1_500 });
  const p = await h.api.authorizedPayment(10_000);
  await pump(h, w, async () => (await deliveries(h, p.id)).every((d) => d.status === "DELIVERED"));
  h.consumer.configure({ failEventType: "payment.captured", failEventTypeTimes: 1 });
  await h.api.post(`/payments/${p.id}/capture`);
  await w.runOnce();
  say("payment.captured (v3) delivery fails once and is scheduled for retry");
  await h.api.post(`/payments/${p.id}/refunds`, { amount: 10_000 });
  await pump(h, w, async () => (await deliveries(h, p.id, "payment.refunded"))[0]?.status === "DELIVERED");
  await pump(h, w, async () => (await deliveries(h, p.id, "payment.captured"))[0]?.status === "DELIVERED");
  const log = h.consumer.log.filter((l) => l.paymentId === p.id).slice(-3);
  for (const l of log) say(`consumer got ${l.type} v${l.paymentVersion}: ${l.outcome}`);
  const state = h.consumer.payments.get(p.id);
  check(log.at(-1)?.outcome === "stale", "late payment.captured (v3) recognized as stale because v4 was already applied");
  check(state?.status === "REFUNDED" && state.version === 4, `consumer's view stays REFUNDED v4 (got ${state?.status} v${state?.version})`);
}

const h = await startHarness({ worker: { maxAttempts: 3, backoffBaseMs: 30, backoffMaxMs: 100, httpTimeoutMs: 800, leaseMs: 1_200 } });
try {
  await h.registerConsumer();
  console.log(`${c.bold}LedgerLab demos${c.reset} ${c.dim}(throwaway database, server at ${h.baseUrl})${c.reset}`);
  for (const demo of [demoA, demoB, demoC, demoD, demoE, demoF, demoG]) {
    h.ctx.failures.clear();
    h.consumer.reset();
    await drainBacklog(h);
    h.consumer.reset();
    await demo(h);
  }
  const report = await checkInvariants(h.pool);
  title("Final invariant check");
  check(report.ok, `${report.checked.length} invariants hold across everything above`);
} finally {
  await h.close();
}
console.log(failures === 0 ? `\n${c.green}All demos passed.${c.reset}` : `\n${c.red}${failures} check(s) failed.${c.reset}`);
process.exit(failures === 0 ? 0 : 1);
