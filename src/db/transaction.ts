import type { Pool, PoolClient } from "./pool.js";

/** A connection that is inside an open transaction. */
export type Tx = PoolClient;

export type TxOptions = {
  /** Postgres default (READ COMMITTED) unless specified. See docs/transactions.md. */
  isolation?: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";
  /** Upper bound on waiting for a row lock. Prevents a stuck lock holder from piling up requests. */
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
};

/**
 * Runs `fn` inside BEGIN/COMMIT on a dedicated connection.
 *
 * Any throw rolls back. COMMIT itself can fail too: the deferred ledger-balance
 * trigger runs at commit time, so an unbalanced journal surfaces as an error
 * from COMMIT, after which Postgres has already rolled the transaction back.
 */
export async function withTransaction<T>(pool: Pool, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query(opts.isolation ? `BEGIN ISOLATION LEVEL ${opts.isolation}` : "BEGIN");
    await client.query(`SET LOCAL lock_timeout = ${Math.trunc(opts.lockTimeoutMs ?? 10_000)}`);
    await client.query(`SET LOCAL statement_timeout = ${Math.trunc(opts.statementTimeoutMs ?? 15_000)}`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is unusable; make sure the pool discards it.
      broken = true;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}
