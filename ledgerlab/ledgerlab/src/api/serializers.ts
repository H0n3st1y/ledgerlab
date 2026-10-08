// Public JSON shapes. snake_case, amounts in minor units, ISO timestamps.
import type { Payment } from "../domain/payment.js";
import type { LedgerTransaction } from "../ledger/ledger-repository.js";
import type { RefundRecord } from "../payments/payment-repository.js";

export function paymentJson(p: Payment) {
  return {
    id: p.id,
    object: "payment" as const,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    authorized_amount: p.authorizedAmount,
    captured_amount: p.capturedAmount,
    refunded_amount: p.refundedAmount,
    version: p.version,
    payment_method: p.paymentMethod,
    description: p.description,
    failure_code: p.failureCode,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}
export type PaymentJson = ReturnType<typeof paymentJson>;

export function refundJson(r: RefundRecord) {
  return {
    id: r.id,
    object: "refund" as const,
    payment_id: r.paymentId,
    amount: r.amount,
    currency: r.currency,
    reason: r.reason,
    payment_version: r.paymentVersion,
    created_at: r.createdAt.toISOString(),
  };
}

export function ledgerTransactionJson(t: LedgerTransaction) {
  return {
    id: t.id,
    object: "ledger_transaction" as const,
    kind: t.kind,
    currency: t.currency,
    payment_id: t.paymentId,
    payment_version: t.paymentVersion,
    refund_id: t.refundId,
    description: t.description,
    created_at: t.createdAt.toISOString(),
    entries: t.entries.map((e) => ({
      id: e.id,
      account: e.account,
      currency: e.currency,
      debit: e.debit,
      credit: e.credit,
    })),
  };
}
