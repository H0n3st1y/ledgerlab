// A reference webhook consumer, written the way we would want a merchant to
// write theirs. It is also the test double for consumer-side failures.
//
// What it demonstrates:
//   1. Verify the signature over the RAW body before trusting anything.
//   2. Deduplicate on webhook-id (= event id). At-least-once delivery means
//      the same event can arrive many times (retries, worker crash after send,
//      manual replay). Processing must be idempotent.
//   3. Order by payment_version, not by arrival. Each event carries a full
//      payment snapshot; apply it only if its version is newer than what we
//      have. An older version arriving late is acknowledged (2xx, so it stops
//      being retried) and ignored.
//
// In a real consumer the dedupe set and the per-payment version live in the
// consumer's own database, updated in one transaction:
//   INSERT INTO processed_events (event_id) ... ON CONFLICT DO NOTHING;
//   UPDATE local_payments SET ... WHERE id = $1 AND version < $2;

import { verify } from "../webhooks/signing.js";

export type ReceivedOutcome = "processed" | "duplicate" | "stale" | "bad_signature" | "injected_failure";

export type ReceivedLog = {
  at: string;
  webhookId: string | null;
  type: string | null;
  paymentId: string | null;
  paymentVersion: number | null;
  attempt: number | null;
  outcome: ReceivedOutcome;
  responseStatus: number;
};

export type ConsumerFailureConfig = {
  /** Respond with `failStatus` to the next N requests. */
  failNext: number;
  failStatus: number;
  /** Respond with failStatus to the first N deliveries of this event type (per event id). */
  failEventType: string | null;
  failEventTypeTimes: number;
  /** Sleep before responding (simulate a slow consumer / timeouts). */
  delayMs: number;
};

export class SandboxConsumer {
  secret: string | null = null;
  readonly processed = new Set<string>();
  readonly payments = new Map<string, { status: string; version: number; refunded_amount: number; captured_amount: number }>();
  readonly log: ReceivedLog[] = [];
  failures: ConsumerFailureConfig = { failNext: 0, failStatus: 500, failEventType: null, failEventTypeTimes: 0, delayMs: 0 };
  private failedByEvent = new Map<string, number>();

  configure(patch: Partial<ConsumerFailureConfig>): ConsumerFailureConfig {
    this.failures = { ...this.failures, ...patch };
    return this.failures;
  }

  reset(): void {
    this.processed.clear();
    this.payments.clear();
    this.log.length = 0;
    this.failedByEvent.clear();
    this.failures = { failNext: 0, failStatus: 500, failEventType: null, failEventTypeTimes: 0, delayMs: 0 };
  }

  async handle(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<{ status: number; body: unknown }> {
    if (this.failures.delayMs > 0) await new Promise((r) => setTimeout(r, this.failures.delayMs));

    if (!this.secret) return this.record(null, null, "bad_signature", 500, { error: "consumer has no secret configured" });
    const v = verify(this.secret, headers, rawBody);
    if (!v.ok) return this.record(null, null, "bad_signature", 400, { error: v.reason });

    const event = JSON.parse(rawBody) as {
      id: string;
      type: string;
      payment_id: string;
      payment_version: number;
      data: { object: { status: string; version: number; refunded_amount: number; captured_amount: number } };
      delivery: { attempt: number };
    };

    // Injected failures happen *after* verification, before any processing,
    // like a consumer whose database is down.
    if (this.failures.failNext > 0) {
      this.failures.failNext -= 1;
      return this.record(event, null, "injected_failure", this.failures.failStatus, { error: "injected" });
    }
    if (this.failures.failEventType === event.type) {
      const n = this.failedByEvent.get(event.id) ?? 0;
      if (n < this.failures.failEventTypeTimes) {
        this.failedByEvent.set(event.id, n + 1);
        return this.record(event, null, "injected_failure", this.failures.failStatus, { error: "injected" });
      }
    }

    // (2) dedupe
    if (this.processed.has(event.id)) return this.record(event, null, "duplicate", 200, { received: true, duplicate: true });
    this.processed.add(event.id);

    // (3) version-ordered apply
    const current = this.payments.get(event.payment_id);
    if (current && current.version >= event.payment_version) {
      return this.record(event, null, "stale", 200, { received: true, stale: true, current_version: current.version });
    }
    const obj = event.data.object;
    this.payments.set(event.payment_id, {
      status: obj.status,
      version: event.payment_version,
      refunded_amount: obj.refunded_amount,
      captured_amount: obj.captured_amount,
    });
    return this.record(event, null, "processed", 200, { received: true });
  }

  private record(
    event: { id: string; type: string; payment_id: string; payment_version: number; delivery?: { attempt: number } } | null,
    webhookId: string | null,
    outcome: ReceivedOutcome,
    status: number,
    body: unknown,
  ) {
    this.log.push({
      at: new Date().toISOString(),
      webhookId: event?.id ?? webhookId,
      type: event?.type ?? null,
      paymentId: event?.payment_id ?? null,
      paymentVersion: event?.payment_version ?? null,
      attempt: event?.delivery?.attempt ?? null,
      outcome,
      responseStatus: status,
    });
    if (this.log.length > 1000) this.log.shift();
    return { status, body };
  }

  snapshot() {
    return {
      failures: this.failures,
      processed_events: this.processed.size,
      payments: Object.fromEntries(this.payments),
      log: [...this.log].reverse().slice(0, 200),
    };
  }
}
