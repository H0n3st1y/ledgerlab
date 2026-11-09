import type { Tx } from "../db/transaction.js";
import type { Pool } from "../db/pool.js";
import type { Currency } from "../domain/money.js";
import type { Payment, PaymentState, PaymentStatus } from "../domain/payment.js";

type PaymentRow = {
  id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  authorized_amount: number;
  captured_amount: number;
  refunded_amount: number;
  version: number;
  payment_method: string;
  description: string | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
};

export function rowToPayment(r: PaymentRow): Payment {
  return {
    id: r.id,
    amount: r.amount,
    currency: r.currency as Currency,
    status: r.status,
    authorizedAmount: r.authorized_amount,
    capturedAmount: r.captured_amount,
    refundedAmount: r.refunded_amount,
    version: r.version,
    paymentMethod: r.payment_method,
    description: r.description,
    failureCode: r.failure_code,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function insertPayment(
  tx: Tx,
  p: { amount: number; currency: Currency; paymentMethod: string; description: string | null },
): Promise<Payment> {
  const { rows } = await tx.query<PaymentRow>(
    `INSERT INTO payments (amount, currency, payment_method, description)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [p.amount, p.currency, p.paymentMethod, p.description],
  );
  return rowToPayment(rows[0]!);
}

/**
 * Loads a payment and takes a row-level exclusive lock on it until the
 * transaction ends. Every mutation of an existing payment goes through here,
 * which serializes concurrent captures/refunds of the same payment while
 * leaving other payments unaffected.
 */
export async function lockPayment(tx: Tx, id: string): Promise<Payment | null> {
  const { rows } = await tx.query<PaymentRow>("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [id]);
  return rows[0] ? rowToPayment(rows[0]) : null;
}

export async function getPayment(db: Pool | Tx, id: string): Promise<Payment | null> {
  const { rows } = await db.query<PaymentRow>("SELECT * FROM payments WHERE id = $1", [id]);
  return rows[0] ? rowToPayment(rows[0]) : null;
}

export async function listPayments(db: Pool, limit = 50): Promise<Payment[]> {
  const { rows } = await db.query<PaymentRow>("SELECT * FROM payments ORDER BY created_at DESC, id LIMIT $1", [limit]);
  return rows.map(rowToPayment);
}

/**
 * Writes the next state. The `version = expected` predicate is redundant
 * while we hold the row lock, and that is the point: if a future code path
 * forgets the lock, this turns a lost update into a loud failure.
 */
export async function updatePaymentState(tx: Tx, id: string, expectedVersion: number, next: PaymentState): Promise<Payment> {
  const { rows } = await tx.query<PaymentRow>(
    `UPDATE payments
        SET status = $3, authorized_amount = $4, captured_amount = $5, refunded_amount = $6,
            version = $7, failure_code = $8
      WHERE id = $1 AND version = $2
      RETURNING *`,
    [id, expectedVersion, next.status, next.authorizedAmount, next.capturedAmount, next.refundedAmount, next.version, next.failureCode],
  );
  if (!rows[0]) throw new Error(`optimistic check failed for payment ${id} at version ${expectedVersion}`);
  return rowToPayment(rows[0]);
}

export async function insertRefund(
  tx: Tx,
  r: { paymentId: string; amount: number; currency: Currency; reason: string | null; paymentVersion: number },
): Promise<RefundRecord> {
  const { rows } = await tx.query<RefundRow>(
    `INSERT INTO refunds (payment_id, amount, currency, reason, payment_version)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [r.paymentId, r.amount, r.currency, r.reason, r.paymentVersion],
  );
  return rowToRefund(rows[0]!);
}

export async function listRefunds(db: Pool | Tx, paymentId: string): Promise<RefundRecord[]> {
  const { rows } = await db.query<RefundRow>("SELECT * FROM refunds WHERE payment_id = $1 ORDER BY payment_version", [paymentId]);
  return rows.map(rowToRefund);
}

type RefundRow = {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  reason: string | null;
  payment_version: number;
  created_at: Date;
};

export type RefundRecord = {
  id: string;
  paymentId: string;
  amount: number;
  currency: Currency;
  reason: string | null;
  paymentVersion: number;
  createdAt: Date;
};

function rowToRefund(r: RefundRow): RefundRecord {
  return {
    id: r.id,
    paymentId: r.payment_id,
    amount: r.amount,
    currency: r.currency as Currency,
    reason: r.reason,
    paymentVersion: r.payment_version,
    createdAt: r.created_at,
  };
}
