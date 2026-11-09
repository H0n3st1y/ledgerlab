// System-wide invariant checks, expressed as SQL that returns violating rows.
// Used by the property tests, the concurrency tests, the demo script and
// GET /ledger/invariants. Every query should return zero rows, always.

import type { Pool } from "../db/pool.js";
import type { Tx } from "../db/transaction.js";

export type InvariantViolation = { invariant: string; rows: Record<string, unknown>[] };
export type InvariantReport = { ok: boolean; checked: string[]; violations: InvariantViolation[] };

const CHECKS: Record<string, string> = {
  // SUM(debits) = SUM(credits) and >= 2 lines, per ledger transaction.
  ledger_transactions_balanced: `
    SELECT t.id, count(e.id) AS entries, COALESCE(sum(e.debit_amount),0) AS debits, COALESCE(sum(e.credit_amount),0) AS credits
      FROM ledger_transactions t LEFT JOIN ledger_entries e ON e.transaction_id = t.id
     GROUP BY t.id
    HAVING count(e.id) < 2 OR COALESCE(sum(e.debit_amount),0) <> COALESCE(sum(e.credit_amount),0)`,

  // Memo (authorization) lines and real-money lines each balance on their own.
  ledger_memo_and_money_balanced_separately: `
    SELECT t.id, a.is_memo, COALESCE(sum(e.debit_amount),0) AS debits, COALESCE(sum(e.credit_amount),0) AS credits
      FROM ledger_transactions t
      JOIN ledger_entries e ON e.transaction_id = t.id
      JOIN ledger_accounts a ON a.id = e.account_id
     GROUP BY t.id, a.is_memo
    HAVING COALESCE(sum(e.debit_amount),0) <> COALESCE(sum(e.credit_amount),0)`,

  // Whole-ledger trial balance per currency.
  ledger_trial_balance: `
    SELECT currency, sum(COALESCE(debit_amount,0)) AS debits, sum(COALESCE(credit_amount,0)) AS credits
      FROM ledger_entries GROUP BY currency
    HAVING sum(COALESCE(debit_amount,0)) <> sum(COALESCE(credit_amount,0))`,

  // amount >= authorized >= captured >= refunded >= 0
  payment_amount_ordering: `
    SELECT id, amount, authorized_amount, captured_amount, refunded_amount FROM payments
     WHERE NOT (amount > 0 AND amount >= authorized_amount AND authorized_amount >= captured_amount
                AND captured_amount >= refunded_amount AND refunded_amount >= 0)`,

  // The payment row agrees with the journal (reconciliation).
  payment_reconciles_with_ledger: `
    WITH by_payment AS (
      SELECT t.payment_id,
             COALESCE(sum(e.debit_amount)  FILTER (WHERE a.code = 'processor_clearing'), 0) AS captured,
             COALESCE(sum(e.credit_amount) FILTER (WHERE a.code = 'refund_clearing'), 0) AS refunded,
             COALESCE(sum(e.debit_amount)  FILTER (WHERE a.code = 'customer_authorization_holds'), 0)
           - COALESCE(sum(e.credit_amount) FILTER (WHERE a.code = 'customer_authorization_holds'), 0) AS open_hold
        FROM ledger_transactions t
        JOIN ledger_entries e ON e.transaction_id = t.id
        JOIN ledger_accounts a ON a.id = e.account_id
       GROUP BY t.payment_id
    )
    SELECT p.id, p.status, p.authorized_amount, p.captured_amount, p.refunded_amount,
           COALESCE(b.captured,0) AS ledger_captured, COALESCE(b.refunded,0) AS ledger_refunded, COALESCE(b.open_hold,0) AS ledger_open_hold
      FROM payments p LEFT JOIN by_payment b ON b.payment_id = p.id
     WHERE p.captured_amount <> COALESCE(b.captured,0)
        OR p.refunded_amount <> COALESCE(b.refunded,0)
        OR COALESCE(b.open_hold,0) <> CASE WHEN p.status = 'AUTHORIZED' THEN p.authorized_amount ELSE 0 END`,

  // Refund rows add up to the payment's refunded_amount.
  refunds_sum_to_refunded_amount: `
    SELECT p.id, p.refunded_amount, COALESCE(sum(r.amount),0) AS refunds_total
      FROM payments p LEFT JOIN refunds r ON r.payment_id = p.id
     GROUP BY p.id HAVING p.refunded_amount <> COALESCE(sum(r.amount),0)`,

  // Every committed version 1..N of a payment has exactly one outbox event.
  every_state_change_has_one_event: `
    SELECT p.id, p.version, count(e.id) AS events, count(DISTINCT e.payment_version) AS distinct_versions,
           min(e.payment_version) AS min_v, max(e.payment_version) AS max_v
      FROM payments p LEFT JOIN webhook_events e ON e.payment_id = p.id
     GROUP BY p.id
    HAVING count(e.id) <> p.version OR min(e.payment_version) <> 1 OR max(e.payment_version) <> p.version`,

  // Financial events have exactly one ledger transaction at the same version,
  // and every ledger transaction belongs to a financial event.
  financial_events_match_ledger_transactions: `
    SELECT e.id AS event_id, e.type, e.payment_id, e.payment_version, t.id AS ledger_transaction_id, t.kind
      FROM webhook_events e
      FULL JOIN ledger_transactions t ON t.payment_id = e.payment_id AND t.payment_version = e.payment_version
     WHERE (e.type IN ('payment.authorized','payment.captured','payment.partially_refunded','payment.refunded') AND t.id IS NULL)
        OR (t.id IS NOT NULL AND e.id IS NULL)
        OR (t.kind = 'AUTHORIZATION_HOLD'    AND e.type <> 'payment.authorized')
        OR (t.kind = 'CAPTURE'               AND e.type <> 'payment.captured')
        OR (t.kind = 'REFUND'                AND e.type NOT IN ('payment.partially_refunded','payment.refunded'))
        OR (t.kind = 'AUTHORIZATION_RELEASE' AND e.type <> 'payment.canceled')
        OR (e.type IN ('payment.created','payment.failed') AND t.id IS NOT NULL)`,

  // A canceled authorization must have released its hold.
  canceled_authorizations_released: `
    SELECT p.id FROM payments p
     WHERE p.status = 'CANCELED' AND p.authorized_amount > 0
       AND NOT EXISTS (SELECT 1 FROM ledger_transactions t WHERE t.payment_id = p.id AND t.kind = 'AUTHORIZATION_RELEASE')`,

  // No idempotency record ever commits half-done.
  idempotency_keys_completed: `SELECT key, operation FROM idempotency_keys WHERE status = 'PROCESSING'`,

  // Deliveries never exceed their attempt budget, and attempt logs are contiguous.
  delivery_attempts_consistent: `
    SELECT d.id, d.attempt_count, d.max_attempts, count(a.id) AS logged, max(a.attempt_number) AS max_logged
      FROM webhook_deliveries d LEFT JOIN webhook_delivery_attempts a ON a.delivery_id = d.id
     GROUP BY d.id
    HAVING d.attempt_count > d.max_attempts
        OR count(a.id) > d.attempt_count
        OR (d.status IN ('DELIVERED','FAILED') AND count(a.id) <> d.attempt_count)`,
};

export const INVARIANT_NAMES = Object.keys(CHECKS);

export async function checkInvariants(db: Pool | Tx): Promise<InvariantReport> {
  const violations: InvariantViolation[] = [];
  for (const [invariant, sql] of Object.entries(CHECKS)) {
    const { rows } = await db.query(sql);
    if (rows.length > 0) violations.push({ invariant, rows: rows.slice(0, 20) });
  }
  return { ok: violations.length === 0, checked: INVARIANT_NAMES, violations };
}
