import type { Pool } from "../db/pool.js";
import type { Tx } from "../db/transaction.js";

export type WebhookEndpoint = {
  id: string;
  url: string;
  secret: string;
  enabledEvents: string[];
  enabled: boolean;
  description: string | null;
  createdAt: Date;
};

export type WebhookEvent = {
  id: string;
  type: string;
  paymentId: string;
  paymentVersion: number;
  payload: { object: Record<string, unknown> };
  createdAt: Date;
};

export type WebhookDelivery = {
  id: string;
  eventId: string;
  endpointId: string;
  status: "PENDING" | "DELIVERING" | "DELIVERED" | "FAILED";
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lockedBy: string | null;
  lockedUntil: Date | null;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: Date | null;
  origin: "EVENT" | "REPLAY";
  replayOf: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DeliveryAttempt = {
  id: number;
  deliveryId: string;
  attemptNumber: number;
  workerId: string;
  outcome: "SUCCEEDED" | "FAILED" | "LEASE_EXPIRED";
  httpStatus: number | null;
  error: string | null;
  responseExcerpt: string | null;
  durationMs: number | null;
  startedAt: Date | null;
  finishedAt: Date;
};

type Db = Pool | Tx;

/* eslint-disable @typescript-eslint/no-explicit-any */
const endpointFrom = (r: any): WebhookEndpoint => ({
  id: r.id,
  url: r.url,
  secret: r.secret,
  enabledEvents: r.enabled_events,
  enabled: r.enabled,
  description: r.description,
  createdAt: r.created_at,
});
const eventFrom = (r: any): WebhookEvent => ({
  id: r.id,
  type: r.type,
  paymentId: r.payment_id,
  paymentVersion: r.payment_version,
  payload: r.payload,
  createdAt: r.created_at,
});
export const deliveryFrom = (r: any): WebhookDelivery => ({
  id: r.id,
  eventId: r.event_id,
  endpointId: r.endpoint_id,
  status: r.status,
  attemptCount: r.attempt_count,
  maxAttempts: r.max_attempts,
  nextAttemptAt: r.next_attempt_at,
  lockedBy: r.locked_by,
  lockedUntil: r.locked_until,
  lastStatusCode: r.last_status_code,
  lastError: r.last_error,
  deliveredAt: r.delivered_at,
  origin: r.origin,
  replayOf: r.replay_of,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const attemptFrom = (r: any): DeliveryAttempt => ({
  id: r.id,
  deliveryId: r.delivery_id,
  attemptNumber: r.attempt_number,
  workerId: r.worker_id,
  outcome: r.outcome,
  httpStatus: r.http_status,
  error: r.error,
  responseExcerpt: r.response_excerpt,
  durationMs: r.duration_ms,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function insertEndpoint(
  db: Db,
  e: { url: string; secret: string; enabledEvents: string[]; description: string | null },
): Promise<WebhookEndpoint> {
  const { rows } = await db.query(
    `INSERT INTO webhook_endpoints (url, secret, enabled_events, description) VALUES ($1, $2, $3, $4) RETURNING *`,
    [e.url, e.secret, e.enabledEvents, e.description],
  );
  return endpointFrom(rows[0]);
}

export async function listEndpoints(db: Db): Promise<WebhookEndpoint[]> {
  const { rows } = await db.query("SELECT * FROM webhook_endpoints ORDER BY created_at");
  return rows.map(endpointFrom);
}

export async function getEndpoint(db: Db, id: string): Promise<WebhookEndpoint | null> {
  const { rows } = await db.query("SELECT * FROM webhook_endpoints WHERE id = $1", [id]);
  return rows[0] ? endpointFrom(rows[0]) : null;
}

export async function setEndpointEnabled(db: Db, id: string, enabled: boolean): Promise<WebhookEndpoint | null> {
  const { rows } = await db.query("UPDATE webhook_endpoints SET enabled = $2 WHERE id = $1 RETURNING *", [id, enabled]);
  return rows[0] ? endpointFrom(rows[0]) : null;
}

export async function listEvents(db: Db, f: { paymentId?: string; type?: string; limit: number }): Promise<WebhookEvent[]> {
  const { rows } = await db.query(
    `SELECT * FROM webhook_events
      WHERE ($1::uuid IS NULL OR payment_id = $1) AND ($2::text IS NULL OR type = $2)
      -- For one payment, version order is the meaningful order (created_at can
      -- invert under lock contention; see docs/transactions.md).
      ORDER BY CASE WHEN $1::uuid IS NOT NULL THEN payment_version END DESC NULLS LAST, created_at DESC
      LIMIT $3`,
    [f.paymentId ?? null, f.type ?? null, f.limit],
  );
  return rows.map(eventFrom);
}

export async function getEvent(db: Db, id: string): Promise<WebhookEvent | null> {
  const { rows } = await db.query("SELECT * FROM webhook_events WHERE id = $1", [id]);
  return rows[0] ? eventFrom(rows[0]) : null;
}

export async function listDeliveries(
  db: Db,
  f: { eventId?: string; endpointId?: string; status?: string; paymentId?: string; limit: number },
): Promise<WebhookDelivery[]> {
  const { rows } = await db.query(
    `SELECT d.* FROM webhook_deliveries d JOIN webhook_events e ON e.id = d.event_id
      WHERE ($1::uuid IS NULL OR d.event_id = $1)
        AND ($2::uuid IS NULL OR d.endpoint_id = $2)
        AND ($3::webhook_delivery_status IS NULL OR d.status = $3)
        AND ($4::uuid IS NULL OR e.payment_id = $4)
      ORDER BY d.created_at DESC LIMIT $5`,
    [f.eventId ?? null, f.endpointId ?? null, f.status ?? null, f.paymentId ?? null, f.limit],
  );
  return rows.map(deliveryFrom);
}

export async function getDelivery(db: Db, id: string): Promise<WebhookDelivery | null> {
  const { rows } = await db.query("SELECT * FROM webhook_deliveries WHERE id = $1", [id]);
  return rows[0] ? deliveryFrom(rows[0]) : null;
}

export async function listAttempts(db: Db, deliveryIds: string[]): Promise<DeliveryAttempt[]> {
  if (deliveryIds.length === 0) return [];
  const { rows } = await db.query(
    "SELECT * FROM webhook_delivery_attempts WHERE delivery_id = ANY($1::uuid[]) ORDER BY delivery_id, attempt_number",
    [deliveryIds],
  );
  return rows.map(attemptFrom);
}

/**
 * Manual replay: a NEW delivery row per target endpoint, linked to the most
 * recent earlier delivery via replay_of. The event row, earlier deliveries
 * and their attempt history are untouched.
 */
export async function createReplayDeliveries(
  tx: Tx,
  input: { eventId: string; endpointId?: string; maxAttempts: number },
): Promise<WebhookDelivery[]> {
  const { rows } = await tx.query(
    `WITH targets AS (
       SELECT ep.id AS endpoint_id,
              (SELECT d.id FROM webhook_deliveries d
                WHERE d.event_id = $1 AND d.endpoint_id = ep.id
                ORDER BY d.created_at DESC LIMIT 1) AS previous_id
         FROM webhook_endpoints ep
        WHERE ep.enabled
          AND ($2::uuid IS NULL OR ep.id = $2)
          AND ($2::uuid IS NOT NULL
               OR EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.event_id = $1 AND d.endpoint_id = ep.id))
     )
     INSERT INTO webhook_deliveries (event_id, endpoint_id, max_attempts, origin, replay_of)
     SELECT $1, endpoint_id, $3, 'REPLAY', previous_id FROM targets
     RETURNING *`,
    [input.eventId, input.endpointId ?? null, input.maxAttempts],
  );
  if (rows.length > 0) await tx.query("SELECT pg_notify('webhook_deliveries', $1)", [input.eventId]);
  return rows.map(deliveryFrom);
}
