import type { Tx } from "../db/transaction.js";
import type { PaymentEventType } from "../domain/payment-state-machine.js";
import type { PaymentJson } from "../api/serializers.js";

/**
 * Transactional outbox write. Called inside the payment transaction, so the
 * event (and one PENDING delivery per subscribed endpoint) commits if and only
 * if the payment change commits. No HTTP happens here; the webhook worker
 * picks deliveries up after commit.
 */
export async function recordPaymentEvent(
  tx: Tx,
  input: { type: PaymentEventType; payment: PaymentJson; maxAttempts: number },
): Promise<{ eventId: string; deliveries: number }> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO webhook_events (type, payment_id, payment_version, payload)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.type, input.payment.id, input.payment.version, JSON.stringify({ object: input.payment })],
  );
  const eventId = rows[0]!.id;

  // Fan-out to endpoints is part of the same transaction: an endpoint that
  // exists at commit time gets exactly one original delivery for this event.
  const fanout = await tx.query(
    `INSERT INTO webhook_deliveries (event_id, endpoint_id, max_attempts)
     SELECT $1, id, $2 FROM webhook_endpoints
      WHERE enabled AND (cardinality(enabled_events) = 0 OR $3 = ANY (enabled_events))`,
    [eventId, input.maxAttempts, input.type],
  );
  if ((fanout.rowCount ?? 0) > 0) {
    // Delivered by Postgres only on COMMIT, so workers never wake for a rolled-back event.
    await tx.query("SELECT pg_notify('webhook_deliveries', $1)", [eventId]);
  }
  return { eventId, deliveries: fanout.rowCount ?? 0 };
}
