import type { Pool } from "../../src/db/pool.js";
import { checkInvariants } from "../../src/ledger/invariants.js";
import { expect } from "vitest";

export async function count(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params);
  return rows[0]!.n;
}

export async function ledgerTxnCount(pool: Pool, paymentId: string, kind?: string): Promise<number> {
  return count(pool, "SELECT 1 FROM ledger_transactions WHERE payment_id = $1 AND ($2::text IS NULL OR kind::text = $2)", [paymentId, kind ?? null]);
}

export async function expectInvariantsHold(pool: Pool): Promise<void> {
  const report = await checkInvariants(pool);
  expect(report.violations, JSON.stringify(report.violations, null, 2)).toEqual([]);
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 25));
  }
}
