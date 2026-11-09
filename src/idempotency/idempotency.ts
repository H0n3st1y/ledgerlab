import type { Pool } from "../db/pool.js";
import { withTransaction, type Tx } from "../db/transaction.js";
import { DomainError } from "../domain/errors.js";

export type IdempotencyRequest = {
  key: string;
  operation: string;
  requestHash: string;
};

export type HandlerResult = {
  statusCode: number;
  body: unknown;
  /** FAILED for responses that describe a committed-but-unsuccessful outcome (e.g. card declined). */
  outcome?: "SUCCEEDED" | "FAILED";
  paymentId?: string | null;
};

export type IdempotentResponse = {
  statusCode: number;
  body: unknown;
  /** true when this is a stored response from an earlier execution. */
  replayed: boolean;
};

type KeyRow = {
  key: string;
  operation: string;
  request_hash: string;
  status: "PROCESSING" | "SUCCEEDED" | "FAILED";
  response_code: number | null;
  response_body: unknown;
};

/**
 * Runs `handler` at most once per idempotency key, in ONE database transaction
 * together with the key record.
 *
 *   BEGIN
 *     INSERT key (PROCESSING) ON CONFLICT DO NOTHING   <- duplicates block here
 *     ... handler: lock payment, ledger, outbox ...
 *     UPDATE key SET response
 *   COMMIT
 *
 * A concurrent request with the same key blocks on the primary-key index
 * entry until the first transaction finishes. If it committed, the waiter's
 * INSERT does nothing and it reads back the stored response; if it rolled
 * back, the waiter's INSERT succeeds and it executes normally. Either way
 * exactly one execution commits.
 *
 * Domain errors thrown by the handler (refund too large, illegal transition)
 * are deterministic outcomes: the handler's partial writes are rolled back to
 * a savepoint and the error response is stored, so a retry gets the same
 * answer. Anything else (bugs, lock timeouts, crashes) rolls back the whole
 * transaction including the key, so the client can safely retry.
 */
export async function executeIdempotent(
  pool: Pool,
  request: IdempotencyRequest | null,
  handler: (tx: Tx) => Promise<HandlerResult>,
  hooks: { beforeCommit?: (tx: Tx) => Promise<void> } = {},
): Promise<IdempotentResponse> {
  return withTransaction(pool, async (tx) => {
    if (request) {
      const claimed = await tx.query(
        `INSERT INTO idempotency_keys (key, operation, request_hash, status)
         VALUES ($1, $2, $3, 'PROCESSING')
         ON CONFLICT (key) DO NOTHING`,
        [request.key, request.operation, request.requestHash],
      );
      if (claimed.rowCount === 0) {
        // READ COMMITTED: this statement gets a fresh snapshot, so it sees the
        // row committed by the transaction we just waited for.
        const { rows } = await tx.query<KeyRow>("SELECT * FROM idempotency_keys WHERE key = $1", [request.key]);
        const existing = rows[0];
        if (!existing || existing.status === "PROCESSING" || existing.response_code === null) {
          // Unreachable while the deferred trigger forbids committing PROCESSING rows.
          throw new Error(`idempotency key ${request.key} is in an inconsistent state`);
        }
        if (existing.operation !== request.operation || existing.request_hash !== request.requestHash) {
          throw new DomainError(
            "IDEMPOTENCY_KEY_REUSED",
            "This Idempotency-Key was already used with a different request. Use a new key for a new request.",
            { original_operation: existing.operation },
          );
        }
        return { statusCode: existing.response_code, body: existing.response_body, replayed: true };
      }
    }

    let result: HandlerResult;
    await tx.query("SAVEPOINT handler");
    try {
      result = await handler(tx);
    } catch (err) {
      if (!(err instanceof DomainError) || err.httpStatus >= 500 || !request) throw err;
      await tx.query("ROLLBACK TO SAVEPOINT handler");
      result = { statusCode: err.httpStatus, body: err.toBody(), outcome: "FAILED" };
    }

    if (request) {
      await tx.query(
        `UPDATE idempotency_keys
            SET status = $2, response_code = $3, response_body = $4, payment_id = $5
          WHERE key = $1`,
        [request.key, result.outcome ?? "SUCCEEDED", result.statusCode, JSON.stringify(result.body), result.paymentId ?? null],
      );
    }
    if (hooks.beforeCommit) await hooks.beforeCommit(tx);
    return { statusCode: result.statusCode, body: result.body, replayed: false };
  });
}
