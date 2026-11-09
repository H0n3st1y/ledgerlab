// Standalone webhook worker. Run several of these to see SKIP LOCKED at work:
//   npm run worker & npm run worker & npm run worker
import "./load-env.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { FailureInjector } from "./failures/injector.js";
import { createLogger } from "./observability/logger.js";
import { Metrics } from "./observability/metrics.js";
import { WebhookWorker } from "./workers/webhook-worker.js";

const config = loadConfig();
const log = createLogger(config.logLevel, { process: "worker" });
const pool = createPool(config.databaseUrl, 5);
const worker = new WebhookWorker({ pool, log, metrics: new Metrics(), failures: new FailureInjector(false), config: config.worker });
await worker.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    // Finish in-flight attempts, then exit. Anything we hold a lease on but
    // never finished is reclaimed by another worker after the lease expires.
    await worker.stop();
    await pool.end();
    process.exit(0);
  });
}
