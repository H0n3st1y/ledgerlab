import pg from "pg";

// bigint (int8) columns hold money in minor units. Parse them as JS numbers
// but refuse anything outside the safe-integer range instead of silently
// losing precision.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`int8 value ${value} exceeds Number.MAX_SAFE_INTEGER`);
  return n;
});
// SUM(bigint) returns numeric; same treatment.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`numeric value ${value} is not a safe integer`);
  return n;
});

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(
  connectionString: string,
  max = 20,
  onIdleError: (err: Error) => void = (err) => console.error("idle postgres client error", err),
): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, application_name: "ledgerlab" });
  // An idle client erroring (e.g. Postgres restarted) must not crash the process.
  pool.on("error", onIdleError);
  return pool;
}
