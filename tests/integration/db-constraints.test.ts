// The database refuses bad data on its own, even when the application is
// bypassed. Every test here talks SQL directly.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "../../src/db/transaction.js";
import { PAYMENT_STATUSES } from "../../src/domain/payment.js";
import { STATUS_GRAPH } from "../../src/domain/payment-state-machine.js";
import { startHarness, type Harness } from "../helpers/harness.js";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => h.close());

const sqlFails = (sql: string, params: unknown[] = []) => expect(h.pool.query(sql, params)).rejects.toThrow();

async function insertPayment(fields: Record<string, unknown> = {}) {
  const f = { amount: 1000, currency: "USD", payment_method: "pm_card_visa", ...fields };
  const cols = Object.keys(f);
  const { rows } = await h.pool.query<{ id: string }>(
    `INSERT INTO payments (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
    Object.values(f),
  );
  return rows[0]!.id;
}

describe("payments table constraints", () => {
  it("rejects non-positive amounts, bad currencies and negative balances", async () => {
    await sqlFails("INSERT INTO payments (amount, currency, payment_method) VALUES (0, 'USD', 'x')");
    await sqlFails("INSERT INTO payments (amount, currency, payment_method) VALUES (-1, 'USD', 'x')");
    await sqlFails("INSERT INTO payments (amount, currency, payment_method) VALUES (1, 'usd', 'x')");
    await sqlFails("INSERT INTO payments (amount, currency, payment_method, refunded_amount) VALUES (1, 'USD', 'x', -1)");
  });

  it("enforces amount >= authorized >= captured >= refunded", async () => {
    await sqlFails("INSERT INTO payments (amount, currency, payment_method, status, authorized_amount) VALUES (100, 'USD', 'x', 'AUTHORIZED', 101)");
    await sqlFails(
      "INSERT INTO payments (amount, currency, payment_method, status, authorized_amount, captured_amount) VALUES (100, 'USD', 'x', 'CAPTURED', 50, 60)",
    );
    await sqlFails(
      "INSERT INTO payments (amount, currency, payment_method, status, authorized_amount, captured_amount, refunded_amount) VALUES (100, 'USD', 'x', 'PARTIALLY_REFUNDED', 100, 50, 60)",
    );
  });

  it("ties each status to consistent amounts", async () => {
    await sqlFails("INSERT INTO payments (amount, currency, payment_method, status) VALUES (100, 'USD', 'x', 'CAPTURED')");
    await sqlFails(
      "INSERT INTO payments (amount, currency, payment_method, status, authorized_amount, captured_amount, refunded_amount) VALUES (100,'USD','x','REFUNDED',100,100,50)",
    );
  });

  it("refuses version skips, illegal transitions, shrinking amounts and deletes", async () => {
    const id = await insertPayment();
    await sqlFails("UPDATE payments SET version = version + 2, status = 'CANCELED' WHERE id = $1", [id]);
    await sqlFails("UPDATE payments SET version = version + 1, status = 'REFUNDED' WHERE id = $1", [id]);
    await sqlFails("UPDATE payments SET amount = 5 , version = version + 1 WHERE id = $1", [id]);
    await sqlFails("DELETE FROM payments WHERE id = $1", [id]);
  });

  it("the SQL transition guard agrees with the TypeScript STATUS_GRAPH for every status pair", async () => {
    for (const from of PAYMENT_STATUSES) {
      for (const to of PAYMENT_STATUSES) {
        const allowedInTs = STATUS_GRAPH[from].includes(to);
        let triggerSaidIllegal = false;
        await withTransaction(h.pool, async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO payments (amount, currency, payment_method) VALUES (100, 'USD', 'x') RETURNING id`,
          );
          const id = rows[0]!.id;
          // Bypass the guard to place the row in `from`, then test the edge with the guard on.
          await tx.query("ALTER TABLE payments DISABLE TRIGGER payments_guard_update");
          await tx.query("ALTER TABLE payments DROP CONSTRAINT payments_status_amounts");
          await tx.query("ALTER TABLE payments DROP CONSTRAINT payments_failure_code_only_when_failed");
          await tx.query("UPDATE payments SET status = $2 WHERE id = $1", [id, from]);
          await tx.query("ALTER TABLE payments ENABLE TRIGGER payments_guard_update");
          await tx.query("SAVEPOINT edge");
          try {
            await tx.query("UPDATE payments SET status = $2, version = version + 1 WHERE id = $1", [id, to]);
          } catch (err) {
            triggerSaidIllegal = /illegal transition/.test((err as Error).message);
            await tx.query("ROLLBACK TO SAVEPOINT edge");
          }
          throw new Error("rollback"); // undo the DDL and test row
        }).catch((e: Error) => {
          if (e.message !== "rollback") throw e;
        });
        expect(triggerSaidIllegal, `${from} -> ${to}`).toBe(!allowedInTs);
      }
    }
  });
});

describe("ledger constraints", () => {
  async function newTxn(tx: { query: typeof h.pool.query }, paymentId: string, version: number) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO ledger_transactions (kind, currency, payment_id, payment_version, description)
       VALUES ('AUTHORIZATION_HOLD', 'USD', $1, $2, 'test') RETURNING id`,
      [paymentId, version],
    );
    return rows[0]!.id;
  }
  const account = async (code: string) =>
    (await h.pool.query<{ id: number }>("SELECT id FROM ledger_accounts WHERE code = $1 AND currency = 'USD'", [code])).rows[0]!.id;

  it("an unbalanced transaction cannot commit (deferred check at COMMIT)", async () => {
    const pid = await insertPayment();
    const holds = await account("customer_authorization_holds");
    const offset = await account("authorization_hold_offset");
    await expect(
      withTransaction(h.pool, async (tx) => {
        const t = await newTxn(tx, pid, 1);
        await tx.query("INSERT INTO ledger_entries (transaction_id, account_id, currency, debit_amount) VALUES ($1, $2, 'USD', 100)", [t, holds]);
        await tx.query("INSERT INTO ledger_entries (transaction_id, account_id, currency, credit_amount) VALUES ($1, $2, 'USD', 99)", [t, offset]);
      }),
    ).rejects.toThrow(/unbalanced/);
  });

  it("a transaction with fewer than two entries cannot commit", async () => {
    const pid = await insertPayment();
    await expect(withTransaction(h.pool, async (tx) => void (await newTxn(tx, pid, 1)))).rejects.toThrow(/at least 2/);
  });

  it("an entry must be a debit XOR a credit, strictly positive, in the account's currency", async () => {
    const pid = await insertPayment();
    const holds = await account("customer_authorization_holds");
    for (const [debit, credit, currency] of [
      [100, 100, "USD"],
      [null, null, "USD"],
      [0, null, "USD"],
      [-5, null, "USD"],
      [100, null, "EUR"],
    ] as const) {
      await expect(
        withTransaction(h.pool, async (tx) => {
          const t = await newTxn(tx, pid, 1);
          await tx.query(
            "INSERT INTO ledger_entries (transaction_id, account_id, currency, debit_amount, credit_amount) VALUES ($1, $2, $3, $4, $5)",
            [t, holds, currency, debit, credit],
          );
        }),
      ).rejects.toThrow();
    }
  });

  it("ledger rows are append-only: UPDATE, DELETE and TRUNCATE are refused", async () => {
    const p = await h.api.authorizedPayment(100);
    const { rows } = await h.pool.query<{ id: string }>("SELECT id FROM ledger_transactions WHERE payment_id = $1", [p.id]);
    const txnId = rows[0]!.id;
    await sqlFails("UPDATE ledger_entries SET debit_amount = 1 WHERE transaction_id = $1", [txnId]);
    await sqlFails("DELETE FROM ledger_entries WHERE transaction_id = $1", [txnId]);
    await sqlFails("UPDATE ledger_transactions SET description = 'x' WHERE id = $1", [txnId]);
    await sqlFails("DELETE FROM ledger_transactions WHERE id = $1", [txnId]);
    await sqlFails("TRUNCATE ledger_entries CASCADE");
  });

  it("at most one ledger transaction per payment version", async () => {
    const p = await h.api.authorizedPayment(100);
    await expect(
      withTransaction(h.pool, async (tx) => {
        await newTxn(tx, p.id, 2);
      }),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe("outbox and idempotency constraints", () => {
  it("webhook events are immutable and unique per payment version", async () => {
    const p = await h.api.createPayment(100);
    await sqlFails("UPDATE webhook_events SET type = 'payment.refunded' WHERE payment_id = $1", [p.id]);
    await sqlFails("DELETE FROM webhook_events WHERE payment_id = $1", [p.id]);
    await sqlFails("INSERT INTO webhook_events (type, payment_id, payment_version, payload) VALUES ('payment.created', $1, 1, '{}')", [p.id]);
  });

  it("an idempotency key cannot commit while PROCESSING", async () => {
    await expect(
      withTransaction(h.pool, async (tx) => {
        await tx.query("INSERT INTO idempotency_keys (key, operation, request_hash, status) VALUES ('k', 'op', $1, 'PROCESSING')", ["a".repeat(64)]);
      }),
    ).rejects.toThrow(/PROCESSING/);
  });
});
