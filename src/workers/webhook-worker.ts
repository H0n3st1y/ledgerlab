// Webhook delivery worker.
//
// Lifecycle of one delivery row:
//
//   PENDING ──claim──▶ DELIVERING ──2xx──▶ DELIVERED
//      ▲                  │  │
//      └──non-2xx/error───┘  └──non-2xx/error, attempts exhausted──▶ FAILED
//      ▲                  │
//      └─lease expired────┘  (worker died; next claim records LEASE_EXPIRED)
//
// Three short transactions per attempt, none of them open during HTTP:
//   1. claim:    SELECT ... FOR UPDATE SKIP LOCKED, set lease, attempt_count += 1
//   2. (no txn)  sign + POST to the endpoint
//   3. complete: fenced UPDATE (only if we still own attempt N) + attempt log row
//
// Delivery is at-least-once. A crash between 2 and 3 means the consumer got
// the event but we never recorded it, so it is sent again after the lease
// expires. Consumers dedupe on the webhook-id header (= event id).

import { randomUUID } from "node:crypto";
import pg from "pg";
import type { WorkerConfig } from "../config.js";
import type { Pool } from "../db/pool.js";
import { withTransaction } from "../db/transaction.js";
import type { FailureInjector} from "../failures/injector.js";
import { SimulatedCrash } from "../failures/injector.js";
import type { Logger } from "../observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import { backoffDelayMs, isSuccessStatus } from "../webhooks/backoff.js";
import { signedHeaders } from "../webhooks/signing.js";

export type ClaimedJob = {
  deliveryId: string;
  attempt: number;
  maxAttempts: number;
  eventId: string;
  eventType: string;
  paymentId: string;
  paymentVersion: number;
  eventCreatedAt: Date;
  payload: unknown;
  endpointId: string;
  url: string;
  secret: string;
};

type AttemptResult = {
  ok: boolean;
  httpStatus: number | null;
  error: string | null;
  responseExcerpt: string | null;
  startedAt: Date;
  durationMs: number;
};

export type WorkerDeps = {
  pool: Pool;
  log: Logger;
  metrics: Metrics;
  failures: FailureInjector;
  config: WorkerConfig;
  fetch?: typeof fetch;
  random?: () => number;
};

export class WebhookWorker {
  workerId: string;
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private listener: pg.Client | null = null;
  private readonly log: Logger;

  constructor(private readonly deps: WorkerDeps, workerId?: string) {
    if (deps.config.leaseMs <= deps.config.httpTimeoutMs) {
      // Otherwise a slow-but-alive worker would routinely lose its lease mid-request.
      throw new Error("WEBHOOK_LEASE_MS must be greater than WEBHOOK_HTTP_TIMEOUT_MS");
    }
    this.workerId = workerId ?? deps.config.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.log = deps.log.child({ workerId: this.workerId });
  }

  /**
   * Claims up to `batchSize` due deliveries and attempts each once.
   * Returns how many were claimed. Rejects with SimulatedCrash if a crash
   * failure point fired; the crashed job's lease is left to expire, exactly
   * as if the process had died.
   */
  async runOnce(): Promise<number> {
    const jobs = await this.claim(this.deps.config.batchSize);
    if (jobs.length === 0) return 0;
    const results = await Promise.allSettled(jobs.map((job) => this.process(job)));
    const crash = results.find((r) => r.status === "rejected" && r.reason instanceof SimulatedCrash);
    if (crash && crash.status === "rejected") throw crash.reason;
    for (const r of results) {
      if (r.status === "rejected") this.log.error({ err: r.reason }, "unexpected error processing delivery");
    }
    return jobs.length;
  }

  /** Drains everything currently due (used by tests and the dashboard's "run worker once"). */
  async drain(maxRounds = 100): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const n = await this.runOnce();
      if (n === 0) break;
      total += n;
    }
    return total;
  }

  async claim(limit: number): Promise<ClaimedJob[]> {
    const { leaseMs } = this.deps.config;
    return withTransaction(this.deps.pool, async (tx) => {
      // SKIP LOCKED: concurrent workers each get a disjoint set of rows
      // instead of queueing behind one another's row locks.
      const { rows: due } = await tx.query<{
        id: string;
        status: "PENDING" | "DELIVERING";
        attempt_count: number;
        max_attempts: number;
        locked_by: string | null;
      }>(
        `SELECT id, status, attempt_count, max_attempts, locked_by
           FROM webhook_deliveries
          WHERE (status = 'PENDING' AND next_attempt_at <= now())
             OR (status = 'DELIVERING' AND locked_until < now())
          ORDER BY next_attempt_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      if (due.length === 0) return [];

      const claimable: string[] = [];
      for (const d of due) {
        if (d.status === "DELIVERING") {
          // The previous owner never finished attempt N: record that, then
          // either retry or give up, like any other failed attempt.
          await tx.query(
            `INSERT INTO webhook_delivery_attempts (delivery_id, attempt_number, worker_id, outcome, error)
             VALUES ($1, $2, $3, 'LEASE_EXPIRED', $4)`,
            [d.id, d.attempt_count, d.locked_by, `lease expired; reclaimed by ${this.workerId}`],
          );
          this.deps.metrics.inc("ledgerlab_webhook_lease_expired_total");
          this.log.warn({ deliveryId: d.id, attempt: d.attempt_count, previousWorker: d.locked_by }, "reclaiming delivery with expired lease");
          if (d.attempt_count >= d.max_attempts) {
            await tx.query(
              `UPDATE webhook_deliveries
                  SET status = 'FAILED', locked_by = NULL, locked_until = NULL,
                      last_error = 'lease expired on final attempt', updated_at = now()
                WHERE id = $1`,
              [d.id],
            );
            continue;
          }
        }
        claimable.push(d.id);
      }
      if (claimable.length === 0) return [];

      await tx.query(
        `UPDATE webhook_deliveries
            SET status = 'DELIVERING', attempt_count = attempt_count + 1, locked_by = $2,
                locked_until = now() + make_interval(secs => $3::double precision / 1000), updated_at = now()
          WHERE id = ANY($1::uuid[])`,
        [claimable, this.workerId, leaseMs],
      );
      const { rows } = await tx.query(
        `SELECT d.id AS delivery_id, d.attempt_count, d.max_attempts,
                e.id AS event_id, e.type, e.payment_id, e.payment_version, e.created_at, e.payload,
                ep.id AS endpoint_id, ep.url, ep.secret
           FROM webhook_deliveries d
           JOIN webhook_events e ON e.id = d.event_id
           JOIN webhook_endpoints ep ON ep.id = d.endpoint_id
          WHERE d.id = ANY($1::uuid[])
          ORDER BY e.created_at, e.payment_version`,
        [claimable],
      );
      return rows.map((r) => ({
        deliveryId: r.delivery_id,
        attempt: r.attempt_count,
        maxAttempts: r.max_attempts,
        eventId: r.event_id,
        eventType: r.type,
        paymentId: r.payment_id,
        paymentVersion: r.payment_version,
        eventCreatedAt: r.created_at,
        payload: r.payload,
        endpointId: r.endpoint_id,
        url: r.url,
        secret: r.secret,
      }));
    });
  }

  /** Builds the exact bytes we send. Signature covers these bytes, so build once. */
  static body(job: ClaimedJob): string {
    return JSON.stringify({
      id: job.eventId,
      type: job.eventType,
      created_at: job.eventCreatedAt.toISOString(),
      payment_id: job.paymentId,
      payment_version: job.paymentVersion,
      data: job.payload,
      delivery: { id: job.deliveryId, attempt: job.attempt },
    });
  }

  private async process(job: ClaimedJob): Promise<void> {
    const log = this.log.child({ deliveryId: job.deliveryId, eventId: job.eventId, paymentId: job.paymentId, attempt: job.attempt });
    const ctx = { eventType: job.eventType, paymentId: job.paymentId };
    const { failures } = this.deps;

    if (failures.take("worker.after_claim", ctx)) {
      log.warn("failure injection: worker crashing after claim");
      throw new SimulatedCrash("worker.after_claim");
    }
    const delay = failures.take("worker.delay_send", ctx);
    if (delay) await sleep(delay.delayMs ?? 1000);

    let result = await this.send(job);
    if (failures.take("worker.duplicate_send", ctx)) {
      log.warn("failure injection: sending duplicate webhook");
      result = await this.send(job);
    }
    if (failures.take("worker.after_send", ctx)) {
      log.warn({ httpStatus: result.httpStatus }, "failure injection: worker crashing after send, before ack");
      throw new SimulatedCrash("worker.after_send");
    }
    await this.complete(job, result, log);
  }

  private async send(job: ClaimedJob): Promise<AttemptResult> {
    const body = WebhookWorker.body(job);
    const startedAt = new Date();
    const doFetch = this.deps.fetch ?? fetch;
    try {
      const res = await doFetch(job.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "LedgerLab-Webhooks/1.0",
          "webhook-attempt": String(job.attempt),
          ...signedHeaders(job.secret, job.eventId, body),
        },
        body,
        signal: AbortSignal.timeout(this.deps.config.httpTimeoutMs),
        redirect: "manual",
      });
      const text = await res.text().catch(() => "");
      return {
        ok: isSuccessStatus(res.status),
        httpStatus: res.status,
        error: isSuccessStatus(res.status) ? null : `HTTP ${res.status}`,
        responseExcerpt: text.slice(0, 512) || null,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
      };
    } catch (err) {
      const e = err as Error;
      const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
      return {
        ok: false,
        httpStatus: null,
        error: timedOut ? `timeout after ${this.deps.config.httpTimeoutMs}ms` : `${e.name}: ${e.message}${causeOf(e)}`,
        responseExcerpt: null,
        startedAt,
        durationMs: Date.now() - startedAt.getTime(),
      };
    }
  }

  private async complete(job: ClaimedJob, r: AttemptResult, log: Logger): Promise<void> {
    const exhausted = !r.ok && job.attempt >= job.maxAttempts;
    const retryInMs = r.ok || exhausted ? null : backoffDelayMs(job.attempt, {
      baseMs: this.deps.config.backoffBaseMs,
      maxMs: this.deps.config.backoffMaxMs,
      random: this.deps.random,
    });
    const status = r.ok ? "DELIVERED" : exhausted ? "FAILED" : "PENDING";

    const owned = await withTransaction(this.deps.pool, async (tx) => {
      // Fencing: only the worker holding attempt N may record attempt N. If our
      // lease expired and someone reclaimed the row, attempt_count moved on and
      // this matches nothing.
      const upd = await tx.query(
        `UPDATE webhook_deliveries
            SET status = $4::webhook_delivery_status,
                locked_by = NULL, locked_until = NULL,
                last_status_code = $5, last_error = $6,
                delivered_at = CASE WHEN $4::webhook_delivery_status = 'DELIVERED' THEN now() ELSE NULL END,
                next_attempt_at = CASE WHEN $7::bigint IS NULL THEN next_attempt_at
                                       ELSE now() + make_interval(secs => $7::double precision / 1000) END,
                updated_at = now()
          WHERE id = $1 AND status = 'DELIVERING' AND locked_by = $2 AND attempt_count = $3`,
        [job.deliveryId, this.workerId, job.attempt, status, r.httpStatus, r.error, retryInMs],
      );
      if (upd.rowCount === 0) return false;
      await tx.query(
        `INSERT INTO webhook_delivery_attempts
           (delivery_id, attempt_number, worker_id, outcome, http_status, error, response_excerpt, duration_ms, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [job.deliveryId, job.attempt, this.workerId, r.ok ? "SUCCEEDED" : "FAILED", r.httpStatus, r.error, r.responseExcerpt, r.durationMs, r.startedAt],
      );
      return true;
    });

    if (!owned) {
      this.deps.metrics.inc("ledgerlab_webhook_lost_lease_total");
      log.warn({ httpStatus: r.httpStatus }, "lost lease before recording result; another worker owns this delivery now");
      return;
    }
    this.deps.metrics.inc("ledgerlab_webhook_attempts_total", { outcome: r.ok ? "succeeded" : exhausted ? "exhausted" : "retry" });
    if (r.ok) log.info({ httpStatus: r.httpStatus, durationMs: r.durationMs }, "webhook delivered");
    else if (exhausted) log.error({ httpStatus: r.httpStatus, error: r.error }, "webhook delivery failed permanently");
    else log.warn({ httpStatus: r.httpStatus, error: r.error, retryInMs }, "webhook attempt failed; will retry");
  }

  /** Background loop. Wakes on NOTIFY from the outbox, or every poll interval. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.listen();
    this.loop = this.runLoop();
    this.log.info("webhook worker started");
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    await this.listener?.end().catch(() => {});
    this.listener = null;
    this.log.info("webhook worker stopped");
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        claimed = await this.runOnce();
      } catch (err) {
        if (err instanceof SimulatedCrash) {
          // A real process would be dead now; its lease stays behind. Emulate a
          // supervisor restarting it under a fresh identity.
          const old = this.workerId;
          this.workerId = `worker-${randomUUID().slice(0, 8)}`;
          this.log.warn({ crashedWorker: old, newWorker: this.workerId }, "simulated crash; worker restarted");
          await sleep(200);
          continue;
        }
        this.log.error({ err }, "worker iteration failed");
        await sleep(this.deps.config.pollIntervalMs);
        continue;
      }
      if (claimed === 0 && this.running) await this.idle();
    }
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, this.deps.config.pollIntervalMs);
      this.wake = done;
    });
  }

  private async listen(): Promise<void> {
    try {
      const client = new pg.Client({ connectionString: (this.deps.pool as unknown as { options: { connectionString: string } }).options.connectionString });
      await client.connect();
      client.on("notification", () => this.wake?.());
      client.on("error", (err) => this.log.warn({ err }, "LISTEN connection error; falling back to polling"));
      await client.query("LISTEN webhook_deliveries");
      this.listener = client;
    } catch (err) {
      this.log.warn({ err }, "could not LISTEN; polling only");
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function causeOf(e: Error): string {
  const c = (e as { cause?: { code?: string; message?: string } }).cause;
  return c ? ` (${c.code ?? c.message ?? "unknown cause"})` : "";
}
