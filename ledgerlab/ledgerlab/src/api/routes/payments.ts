import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { paymentDeps } from "../../context.js";
import { DomainError } from "../../domain/errors.js";
import { ledgerForPayment } from "../../ledger/ledger-repository.js";
import { createPayment, executePaymentCommand, type PaymentRequest } from "../../payments/payment-service.js";
import { getPayment, listPayments, listRefunds } from "../../payments/payment-repository.js";
import { listEvents } from "../../webhooks/webhook-repository.js";
import { idempotencyFor } from "../idempotency-header.js";
import { sendIdempotent } from "../reply.js";
import * as S from "../schemas.js";
import { ledgerTransactionJson, paymentJson, refundJson } from "../serializers.js";
import { eventJson } from "./webhooks.js";

const mutationResponses = {
  402: S.ErrorResponse,
  404: S.ErrorResponse,
  409: S.ErrorResponse,
  422: S.ErrorResponse,
};

export function paymentRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  const deps = paymentDeps(ctx);

  return async (app) => {
    app.post(
      "/payments",
      {
        schema: {
          tags: ["payments"],
          summary: "Create a payment (status CREATED). Requires Idempotency-Key.",
          headers: S.IdempotencyHeaders,
          body: S.CreatePaymentBody,
          response: { 201: S.Payment, 409: S.ErrorResponse },
        },
      },
      async (req, reply) => {
        const idem = idempotencyFor(req, { required: true, body: req.body });
        const res = await createPayment(
          deps,
          { amount: req.body.amount, currency: req.body.currency, paymentMethod: req.body.payment_method, description: req.body.description },
          idem,
        );
        return sendIdempotent(ctx, req, reply, res, { operation: "create" });
      },
    );

    app.get(
      "/payments",
      { schema: { tags: ["payments"], summary: "List recent payments", querystring: S.ListQuery, response: { 200: z.object({ data: z.array(S.Payment) }) } } },
      async (req) => ({ data: (await listPayments(ctx.pool, req.query.limit)).map(paymentJson) }),
    );

    app.get(
      "/payments/:id",
      { schema: { tags: ["payments"], summary: "Get a payment", params: S.IdParams, response: { 200: S.Payment, 404: S.ErrorResponse } } },
      async (req) => {
        const p = await getPayment(ctx.pool, req.params.id);
        if (!p) throw new DomainError("PAYMENT_NOT_FOUND", `No payment with id ${req.params.id}.`);
        return paymentJson(p);
      },
    );

    const command = (
      path: string,
      summary: string,
      body: z.ZodType,
      toRequest: (body: never) => PaymentRequest,
      success: Record<number, z.ZodType>,
    ) =>
      app.post(
        `/payments/:id/${path}`,
        {
          schema: {
            tags: ["payments"],
            summary,
            params: S.IdParams,
            headers: S.IdempotencyHeaders,
            body,
            response: { ...success, ...mutationResponses },
          },
        },
        async (req, reply) => {
          const idem = idempotencyFor(req, { required: true, params: req.params, body: req.body });
          const request = toRequest((req.body ?? {}) as never);
          const res = await executePaymentCommand(deps, req.params.id, request, idem);
          return sendIdempotent(ctx, req, reply, res, { operation: request.type, paymentId: req.params.id });
        },
      );

    command("authorize", "Authorize the full amount with the (simulated) card network", S.EmptyBody, () => ({ type: "authorize" }), { 200: S.Payment });
    command(
      "capture",
      "Capture an authorized payment (once; any uncaptured remainder is released)",
      S.CaptureBody,
      (b: { amount?: number }) => ({ type: "capture", amount: b.amount }),
      { 200: S.Payment },
    );
    command(
      "refunds",
      "Refund part or all of the captured amount. Concurrent refunds are serialized by a row lock.",
      S.RefundBody,
      (b: { amount: number; reason?: string | null }) => ({ type: "refund", amount: b.amount, reason: b.reason }),
      { 201: S.Refund.extend({ payment: S.Payment }) },
    );
    command("cancel", "Cancel a CREATED or AUTHORIZED payment, releasing any hold", S.EmptyBody, () => ({ type: "cancel" }), { 200: S.Payment });

    app.get(
      "/payments/:id/refunds",
      { schema: { tags: ["payments"], summary: "List refunds of a payment", params: S.IdParams, response: { 200: z.object({ data: z.array(S.Refund) }) } } },
      async (req) => ({ data: (await listRefunds(ctx.pool, req.params.id)).map(refundJson) }),
    );

    app.get(
      "/payments/:id/ledger",
      {
        schema: {
          tags: ["ledger"],
          summary: "Ledger transactions for a payment, in version order",
          params: S.IdParams,
          response: { 200: z.object({ data: z.array(S.LedgerTransaction) }), 404: S.ErrorResponse },
        },
      },
      async (req) => {
        if (!(await getPayment(ctx.pool, req.params.id))) throw new DomainError("PAYMENT_NOT_FOUND", `No payment with id ${req.params.id}.`);
        return { data: (await ledgerForPayment(ctx.pool, req.params.id)).map(ledgerTransactionJson) };
      },
    );

    app.get(
      "/payments/:id/events",
      { schema: { tags: ["webhooks"], summary: "Webhook events for a payment", params: S.IdParams } },
      async (req) => ({ data: (await listEvents(ctx.pool, { paymentId: req.params.id, limit: 500 })).map(eventJson) }),
    );
  };
}
