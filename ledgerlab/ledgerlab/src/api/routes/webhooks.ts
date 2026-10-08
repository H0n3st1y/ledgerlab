import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { DomainError } from "../../domain/errors.js";
import { executeIdempotent } from "../../idempotency/idempotency.js";
import { generateWebhookSecret } from "../../webhooks/signing.js";
import {
  createReplayDeliveries,
  getDelivery,
  getEndpoint,
  getEvent,
  insertEndpoint,
  listAttempts,
  listDeliveries,
  listEndpoints,
  listEvents,
  setEndpointEnabled,
  type DeliveryAttempt,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEvent,
} from "../../webhooks/webhook-repository.js";
import { idempotencyFor } from "../idempotency-header.js";
import { sendIdempotent } from "../reply.js";
import * as S from "../schemas.js";

export function eventJson(e: WebhookEvent) {
  return {
    id: e.id,
    object: "event" as const,
    type: e.type,
    payment_id: e.paymentId,
    payment_version: e.paymentVersion,
    created_at: e.createdAt.toISOString(),
    data: e.payload,
  };
}

export function endpointJson(e: WebhookEndpoint, opts: { includeSecret?: boolean } = {}) {
  return {
    id: e.id,
    object: "webhook_endpoint" as const,
    url: e.url,
    enabled_events: e.enabledEvents,
    enabled: e.enabled,
    description: e.description,
    created_at: e.createdAt.toISOString(),
    // Only returned once, at creation. Never logged.
    ...(opts.includeSecret ? { secret: e.secret } : {}),
  };
}

export function deliveryJson(d: WebhookDelivery, attempts?: DeliveryAttempt[]) {
  return {
    id: d.id,
    object: "webhook_delivery" as const,
    event_id: d.eventId,
    endpoint_id: d.endpointId,
    status: d.status,
    origin: d.origin,
    replay_of: d.replayOf,
    attempt_count: d.attemptCount,
    max_attempts: d.maxAttempts,
    next_attempt_at: d.nextAttemptAt.toISOString(),
    locked_by: d.lockedBy,
    locked_until: d.lockedUntil?.toISOString() ?? null,
    last_status_code: d.lastStatusCode,
    last_error: d.lastError,
    delivered_at: d.deliveredAt?.toISOString() ?? null,
    created_at: d.createdAt.toISOString(),
    updated_at: d.updatedAt.toISOString(),
    ...(attempts
      ? {
          attempts: attempts.map((a) => ({
            attempt_number: a.attemptNumber,
            worker_id: a.workerId,
            outcome: a.outcome,
            http_status: a.httpStatus,
            error: a.error,
            response_excerpt: a.responseExcerpt,
            duration_ms: a.durationMs,
            started_at: a.startedAt?.toISOString() ?? null,
            finished_at: a.finishedAt.toISOString(),
          })),
        }
      : {}),
  };
}

const DeliveryQuery = S.ListQuery.extend({
  event_id: S.Uuid.optional(),
  endpoint_id: S.Uuid.optional(),
  payment_id: S.Uuid.optional(),
  status: z.enum(["PENDING", "DELIVERING", "DELIVERED", "FAILED"]).optional(),
});

export function webhookRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      "/webhook-endpoints",
      { schema: { tags: ["webhooks"], summary: "Register a webhook endpoint. The signing secret is returned only here.", body: S.CreateEndpointBody } },
      async (req, reply) => {
        const endpoint = await insertEndpoint(ctx.pool, {
          url: req.body.url,
          secret: generateWebhookSecret(),
          enabledEvents: req.body.enabled_events,
          description: req.body.description ?? null,
        });
        req.log.info({ endpointId: endpoint.id, url: endpoint.url }, "webhook endpoint created");
        return reply.code(201).send(endpointJson(endpoint, { includeSecret: true }));
      },
    );

    app.get("/webhook-endpoints", { schema: { tags: ["webhooks"], summary: "List webhook endpoints" } }, async () => ({
      data: (await listEndpoints(ctx.pool)).map((e) => endpointJson(e)),
    }));

    app.post(
      "/webhook-endpoints/:id/:action",
      {
        schema: {
          tags: ["webhooks"],
          summary: "Enable or disable an endpoint",
          params: z.object({ id: S.Uuid, action: z.enum(["enable", "disable"]) }),
        },
      },
      async (req) => {
        const e = await setEndpointEnabled(ctx.pool, req.params.id, req.params.action === "enable");
        if (!e) throw new DomainError("NOT_FOUND", "No such webhook endpoint.");
        return endpointJson(e);
      },
    );

    app.get(
      "/webhook-events",
      {
        schema: {
          tags: ["webhooks"],
          summary: "List outbox events (newest first)",
          querystring: S.ListQuery.extend({ payment_id: S.Uuid.optional(), type: z.string().optional() }),
        },
      },
      async (req) => ({
        data: (await listEvents(ctx.pool, { paymentId: req.query.payment_id, type: req.query.type, limit: req.query.limit })).map(eventJson),
      }),
    );

    app.get(
      "/webhook-events/:id",
      { schema: { tags: ["webhooks"], summary: "Get an event with all its deliveries and attempts", params: S.IdParams } },
      async (req) => {
        const event = await getEvent(ctx.pool, req.params.id);
        if (!event) throw new DomainError("NOT_FOUND", "No such event.");
        const deliveries = await listDeliveries(ctx.pool, { eventId: event.id, limit: 500 });
        const attempts = await listAttempts(ctx.pool, deliveries.map((d) => d.id));
        return {
          ...eventJson(event),
          deliveries: deliveries.map((d) => deliveryJson(d, attempts.filter((a) => a.deliveryId === d.id))),
        };
      },
    );

    app.post(
      "/webhook-events/:id/replay",
      {
        schema: {
          tags: ["webhooks"],
          summary: "Replay an event: creates NEW delivery rows; the event and earlier attempts are never modified. Idempotency-Key optional.",
          params: S.IdParams,
          headers: S.IdempotencyHeaders,
          body: S.ReplayBody,
        },
      },
      async (req, reply) => {
        const idem = idempotencyFor(req, { required: false, params: req.params, body: req.body });
        const endpointId = req.body?.endpoint_id;
        const res = await executeIdempotent(ctx.pool, idem, async (tx) => {
          const event = await getEvent(tx, req.params.id);
          if (!event) throw new DomainError("NOT_FOUND", "No such event.");
          if (endpointId) {
            const ep = await getEndpoint(tx, endpointId);
            if (!ep || !ep.enabled) throw new DomainError("NOT_FOUND", "No such enabled webhook endpoint.");
          }
          const created = await createReplayDeliveries(tx, { eventId: event.id, endpointId, maxAttempts: ctx.config.worker.maxAttempts });
          if (created.length === 0) {
            throw new DomainError("NOT_FOUND", "No enabled endpoint has received this event; pass endpoint_id to target one.");
          }
          req.log.info({ eventId: event.id, deliveryIds: created.map((d) => d.id) }, "webhook replay scheduled");
          return { statusCode: 202, body: { event_id: event.id, deliveries: created.map((d) => deliveryJson(d)) } };
        });
        return sendIdempotent(ctx, req, reply, res, { operation: "replay" });
      },
    );

    app.get(
      "/webhook-deliveries",
      { schema: { tags: ["webhooks"], summary: "Delivery log, filterable", querystring: DeliveryQuery } },
      async (req) => {
        const deliveries = await listDeliveries(ctx.pool, {
          eventId: req.query.event_id,
          endpointId: req.query.endpoint_id,
          paymentId: req.query.payment_id,
          status: req.query.status,
          limit: req.query.limit,
        });
        const attempts = await listAttempts(ctx.pool, deliveries.map((d) => d.id));
        return { data: deliveries.map((d) => deliveryJson(d, attempts.filter((a) => a.deliveryId === d.id))) };
      },
    );

    app.get(
      "/webhook-deliveries/:id",
      { schema: { tags: ["webhooks"], summary: "A delivery with its full attempt history", params: S.IdParams } },
      async (req) => {
        const d = await getDelivery(ctx.pool, req.params.id);
        if (!d) throw new DomainError("NOT_FOUND", "No such delivery.");
        return deliveryJson(d, await listAttempts(ctx.pool, [d.id]));
      },
    );
  };
}
