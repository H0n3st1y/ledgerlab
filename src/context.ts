import type { Config } from "./config.js";
import type { Pool } from "./db/pool.js";
import type { FailureInjector } from "./failures/injector.js";
import type { Logger } from "./observability/logger.js";
import type { Metrics } from "./observability/metrics.js";
import type { PaymentDeps } from "./payments/payment-service.js";

/** Everything a request handler or worker needs. Built once in main.ts (or per test). */
export type AppContext = {
  config: Config;
  pool: Pool;
  log: Logger;
  metrics: Metrics;
  failures: FailureInjector;
};

export function paymentDeps(ctx: AppContext): PaymentDeps {
  return {
    pool: ctx.pool,
    failures: ctx.failures,
    log: ctx.log,
    metrics: ctx.metrics,
    webhookMaxAttempts: ctx.config.worker.maxAttempts,
  };
}
