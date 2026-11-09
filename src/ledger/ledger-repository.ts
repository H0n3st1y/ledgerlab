import type { Pool } from "../db/pool.js";
import type { Tx } from "../db/transaction.js";
import type { LedgerIntent } from "../domain/payment-state-machine.js";
import { DESCRIPTIONS, isBalanced, journalLines } from "./postings.js";

export type LedgerEntry = {
  id: number;
  transactionId: string;
  account: string;
  currency: string;
  debit: number | null;
  credit: number | null;
  createdAt: Date;
};

export type LedgerTransaction = {
  id: string;
  kind: LedgerIntent["kind"];
  currency: string;
  paymentId: string;
  paymentVersion: number;
  refundId: string | null;
  description: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  entries: LedgerEntry[];
};

/**
 * Appends one balanced journal entry. Must be called inside the same
 * transaction as the payment update it describes; the caller owns BEGIN/COMMIT.
 * Balance is checked here and again by a deferred trigger at COMMIT.
 */
export async function postLedgerTransaction(
  tx: Tx,
  input: {
    intent: LedgerIntent;
    currency: string;
    paymentId: string;
    paymentVersion: number;
    refundId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<string> {
  const lines = journalLines(input.intent);
  if (!isBalanced(lines)) throw new Error(`refusing to post unbalanced journal for ${input.intent.kind}`);

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO ledger_transactions (kind, currency, payment_id, payment_version, refund_id, description, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.intent.kind,
      input.currency,
      input.paymentId,
      input.paymentVersion,
      input.refundId ?? null,
      DESCRIPTIONS[input.intent.kind],
      input.metadata ?? {},
    ],
  );
  const txnId = rows[0]!.id;

  // One multi-row INSERT; account ids are resolved by (code, currency) in SQL so
  // an unknown account or currency mismatch fails on the FK, not silently.
  const inserted = await tx.query(
    `INSERT INTO ledger_entries (transaction_id, account_id, currency, debit_amount, credit_amount)
     SELECT $1, a.id, $2, l.debit, l.credit
       FROM unnest($3::text[], $4::bigint[], $5::bigint[]) WITH ORDINALITY AS l(code, debit, credit, ord)
       JOIN ledger_accounts a ON a.code = l.code AND a.currency = $2
      ORDER BY l.ord`,
    [txnId, input.currency, lines.map((l) => l.account), lines.map((l) => l.debit ?? null), lines.map((l) => l.credit ?? null)],
  );
  if (inserted.rowCount !== lines.length) {
    throw new Error(`ledger account missing for currency ${input.currency}`);
  }
  return txnId;
}

type TxnRow = {
  id: string;
  kind: LedgerIntent["kind"];
  currency: string;
  payment_id: string;
  payment_version: number;
  refund_id: string | null;
  description: string;
  metadata: Record<string, unknown>;
  created_at: Date;
};
type EntryRow = {
  id: number;
  transaction_id: string;
  code: string;
  currency: string;
  debit_amount: number | null;
  credit_amount: number | null;
  created_at: Date;
};

async function hydrate(db: Pool | Tx, txns: TxnRow[]): Promise<LedgerTransaction[]> {
  if (txns.length === 0) return [];
  const { rows } = await db.query<EntryRow>(
    `SELECT e.id, e.transaction_id, a.code, e.currency, e.debit_amount, e.credit_amount, e.created_at
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE e.transaction_id = ANY($1::uuid[])
      ORDER BY e.id`,
    [txns.map((t) => t.id)],
  );
  return txns.map((t) => ({
    id: t.id,
    kind: t.kind,
    currency: t.currency,
    paymentId: t.payment_id,
    paymentVersion: t.payment_version,
    refundId: t.refund_id,
    description: t.description,
    metadata: t.metadata,
    createdAt: t.created_at,
    entries: rows
      .filter((e) => e.transaction_id === t.id)
      .map((e) => ({
        id: e.id,
        transactionId: e.transaction_id,
        account: e.code,
        currency: e.currency,
        debit: e.debit_amount,
        credit: e.credit_amount,
        createdAt: e.created_at,
      })),
  }));
}

export async function ledgerForPayment(db: Pool | Tx, paymentId: string): Promise<LedgerTransaction[]> {
  const { rows } = await db.query<TxnRow>(
    "SELECT * FROM ledger_transactions WHERE payment_id = $1 ORDER BY payment_version",
    [paymentId],
  );
  return hydrate(db, rows);
}

export async function getLedgerTransaction(db: Pool | Tx, id: string): Promise<LedgerTransaction | null> {
  const { rows } = await db.query<TxnRow>("SELECT * FROM ledger_transactions WHERE id = $1", [id]);
  return (await hydrate(db, rows))[0] ?? null;
}

export type AccountBalance = {
  code: string;
  currency: string;
  name: string;
  normalBalance: "DEBIT" | "CREDIT";
  isMemo: boolean;
  debits: number;
  credits: number;
  /** Signed by the account's normal side: positive means "has a normal balance". */
  balance: number;
};

/** Balances are derived from the journal on read. There is no mutable balance column to drift. */
export async function accountBalances(db: Pool | Tx): Promise<AccountBalance[]> {
  const { rows } = await db.query<{
    code: string;
    currency: string;
    name: string;
    normal_balance: "DEBIT" | "CREDIT";
    is_memo: boolean;
    debits: number;
    credits: number;
  }>(
    `SELECT a.code, a.currency, a.name, a.normal_balance, a.is_memo,
            COALESCE(sum(e.debit_amount), 0) AS debits,
            COALESCE(sum(e.credit_amount), 0) AS credits
       FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
      GROUP BY a.id
      ORDER BY a.currency, a.id`,
  );
  return rows.map((r) => ({
    code: r.code,
    currency: r.currency,
    name: r.name,
    normalBalance: r.normal_balance,
    isMemo: r.is_memo,
    debits: r.debits,
    credits: r.credits,
    balance: r.normal_balance === "DEBIT" ? r.debits - r.credits : r.credits - r.debits,
  }));
}
