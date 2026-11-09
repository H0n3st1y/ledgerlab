/**
 * Exponential backoff with "equal jitter" (AWS Architecture Blog,
 * "Exponential Backoff And Jitter", 2015):
 *
 *   ceiling = min(maxMs, baseMs * 2^(attempt - 1))
 *   delay   = ceiling / 2 + random(0, ceiling / 2)
 *
 * Half the ceiling is a floor so retries never collapse to ~0ms ("full
 * jitter" allows that); the other half is randomized so many deliveries failing together (consumer outage)
 * do not retry in lockstep and stampede the consumer when it recovers.
 *
 * `attempt` is the attempt that just failed (1-based).
 */
export function backoffDelayMs(
  attempt: number,
  opts: { baseMs: number; maxMs: number; random?: () => number },
): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`attempt must be >= 1, got ${attempt}`);
  const exp = Math.min(attempt - 1, 30); // avoid 2^large overflowing to Infinity
  const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** exp);
  const r = (opts.random ?? Math.random)();
  return Math.round(ceiling / 2 + r * (ceiling / 2));
}

/** HTTP statuses we treat as success. Everything else is retried until max_attempts. */
export function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}
