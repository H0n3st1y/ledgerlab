import type { Pool } from "../db/pool.js";
import type { Tx } from "../db/transaction.js";
import { DomainError } from "../domain/errors.js";
import type { Currency } from "../domain/money.js";
import { applyCommand, type PaymentCommand } from "../domain/payment-state-machine.js";
import type { FailureInjector} from "../failures/injector.js";
import { InjectedFailure } from "../failures/injector.js";
import { executeIdempotent, type IdempotencyRequest, type IdempotentResponse } from "../idempotency/idempotency.js";
import { postLedgerTransaction } from "../ledger/ledger-repository.js";
import type { Logger } from "../observability/logger.js";
import type { Metrics } from "../observability/metrics.js";
import { paymentJson, refundJson } from "../api/serializers.js";
import { recordPaymentEvent } from "../webhooks/outbox.js";
import { authorizeWithCardNetwork } from "./card-network.js";
import { insertPayment, insertRefund, lockPayment, updatePaymentState, type RefundRecord } from "./payment-repository.js";

export type PaymentDeps = {
  pool: Pool;
  failures: FailureInjector;
  log: Logger;
  metrics: Metrics;
  webhookMaxAttempts: number;
};

/** What the HTTP layer asks for. The card-network decision is filled in under the row lock. */
export type PaymentRequest =
  | { type: "authorize" }
  | { type: "capture"; amount?: number }
  | { type: "refund"; amount: number; reason?: string | null }
  | { type: "cancel" };

export type CreatePaymentInput = {
  amount: number;
  currency: Currency;
  paymentMethod: string;
  description?: string | null;
};

/**
 * POST /payments. One transaction: idempotency key, payment row (version 1),
 * payment.created outbox event. No ledger transaction: nothing financial has
 * happened yet.
 */
export async function createPayment(
  deps: PaymentDeps,
  input: CreatePaymentInput,
  idem: IdempotencyRequest | null,
): Promise<IdempotentResponse> {
  let committed: { paymentId: string; eventId: string } | null = null;
  const response = await executeIdempotent(
    deps.pool,
    idem,
    async (tx) => {
      const payment = await insertPayment(tx, {
        amount: input.amount,
        currency: input.currency,
        paymentMethod: input.paymentMethod,
        description: input.description ?? null,
      });
      const body = paymentJson(payment);
      const event = await recordPaymentEvent(tx, { type: "payment.created", payment: body, maxAttempts: deps.webhookMaxAttempts });
      committed = { paymentId: payment.id, eventId: event.eventId };
      return { statusCode: 201, body, paymentId: payment.id };
    },
    { beforeCommit: beforeCommitHook(deps, { operation: "create" }) },
  );
  afterCommit(deps, response, idem, committed && { ...(committed as { paymentId: string; eventId: string }), type: "create" });
  return response;
}

/**
 * authorize / capture / refund / cancel. The transaction boundary, in order:
 *
 *   1. claim idempotency key            (blocks duplicate keys)
 *   2. SELECT payment FOR UPDATE        (serializes all mutations of this payment)
 *   3. state machine decides            (pure; may reject)
 *   4. UPDATE payment, version + 1
 *   5. INSERT refund row                (refunds only)
 *   6. INSERT ledger transaction        (balanced; checked again at COMMIT)
 *   7. INSERT outbox event + deliveries
 *   8. store idempotent response
 *   COMMIT
 *
 * See docs/transactions.md for why each step is inside the boundary.
 */
export async function executePaymentCommand(
  deps: PaymentDeps,
  paymentId: string,
  request: PaymentRequest,
  idem: IdempotencyRequest | null,
): Promise<IdempotentResponse> {
  let committed: { paymentId: string; eventId: string; ledgerTransactionId: string | null; type: string } | null = null;
  let rejection: DomainError | null = null;

  const response = await executeIdempotent(
    deps.pool,
    idem,
    async (tx: Tx) => {
      const payment = await lockPayment(tx, paymentId);
      if (!payment) throw new DomainError("PAYMENT_NOT_FOUND", `No payment with id ${paymentId}.`);

      const command: PaymentCommand =
        request.type === "authorize" ? { type: "authorize", decision: authorizeWithCardNetwork(payment.paymentMethod) } : request;
      const result = applyCommand(payment, command);
      if (!result.ok) {
        rejection = result.error;
        throw result.error;
      }
      const t = result.transition;

      const updated = await updatePaymentState(tx, payment.id, payment.version, t.next);

      let refund: RefundRecord | null = null;
      if (request.type === "refund") {
        refund = await insertRefund(tx, {
          paymentId: payment.id,
          amount: request.amount,
          currency: payment.currency,
          reason: request.reason ?? null,
          paymentVersion: updated.version,
        });
      }

      const ledgerTransactionId = t.ledger
        ? await postLedgerTransaction(tx, {
            intent: t.ledger,
            currency: payment.currency,
            paymentId: payment.id,
            paymentVersion: updated.version,
            refundId: refund?.id ?? null,
            metadata: idem ? { idempotency_key: idem.key } : {},
          })
        : null;

      const body = paymentJson(updated);
      const event = await recordPaymentEvent(tx, { type: t.eventType, payment: body, maxAttempts: deps.webhookMaxAttempts });
      committed = { paymentId: payment.id, eventId: event.eventId, ledgerTransactionId, type: request.type };

      deps.log.debug(
        { paymentId: payment.id, from: t.from, to: updated.status, version: updated.version, ledgerTransactionId, eventId: event.eventId },
        "payment transition staged",
      );

      if (updated.status === "FAILED") {
        // The decline is a committed state change (payment.failed is emitted),
        // reported to the caller as a 402.
        const declined = new DomainError("CARD_DECLINED", "The card was declined.", {
          decline_code: updated.failureCode,
          payment: body,
        });
        return { statusCode: 402, body: declined.toBody(), outcome: "FAILED", paymentId: payment.id };
      }
      if (refund) {
        return { statusCode: 201, body: { ...refundJson(refund), payment: body }, paymentId: payment.id };
      }
      return { statusCode: 200, body, paymentId: payment.id };
    },
    { beforeCommit: beforeCommitHook(deps, { paymentId, operation: request.type }) },
  );

  if (rejection && !response.replayed) {
    deps.metrics.inc("ledgerlab_payment_rejections_total", { command: request.type, code: (rejection as DomainError).code });
    if (!idem) throw rejection;
  }
  afterCommit(deps, response, idem, committed);
  return response;
}

function beforeCommitHook(deps: PaymentDeps, ctx: { paymentId?: string; operation: string }) {
  return async () => {
    if (deps.failures.take("payment.before_commit", ctx)) {
      deps.log.warn({ ...ctx }, "failure injection: rolling back payment transaction before commit");
      throw new InjectedFailure("payment.before_commit");
    }
  };
}

function afterCommit(
  deps: PaymentDeps,
  response: IdempotentResponse,
  idem: IdempotencyRequest | null,
  committed: { paymentId: string; eventId: string; ledgerTransactionId?: string | null; type: string } | null,
): void {
  if (response.replayed) {
    deps.metrics.inc("ledgerlab_idempotent_replays_total", { operation: idem?.operation ?? "unknown" });
    deps.log.info({ idempotencyKey: idem?.key, operation: idem?.operation }, "idempotent replay: returning stored response");
    return;
  }
  if (committed) {
    deps.metrics.inc("ledgerlab_payment_transitions_total", { command: committed.type });
    deps.log.info(
      {
        paymentId: committed.paymentId,
        eventId: committed.eventId,
        transactionId: committed.ledgerTransactionId ?? undefined,
        idempotencyKey: idem?.key,
        command: committed.type,
        status: response.statusCode,
      },
      "payment command committed",
    );
  }
}
