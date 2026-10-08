import "./load-env.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { FailureInjector } from "./failures/injector.js";
import { createLogger } from "./observability/logger.js";
import { Metrics } from "./observability/metrics.js";
import { WebhookWorker } from "./workers/webhook-worker.js";
import { SandboxConsumer } from "./consumer/consumer.js";

const config = loadConfig();
const log = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl, config.dbPoolMax);
const ctx = { config, pool, log, metrics: new Metrics(), failures: new FailureInjector(config.enableDevTools) };

if (config.env !== "production") await migrate(pool, (m) => log.info(m));

const worker = config.runWorker ? new WebhookWorker({ ...ctx, config: config.worker }) : null;
const consumer = config.enableDevTools ? new SandboxConsumer() : null;
const app = await buildApp(ctx, { worker, consumer });
await app.listen({ port: config.port, host: config.host });
await worker?.start();
log.info({ port: config.port, worker: worker?.workerId ?? null, devTools: config.enableDevTools }, "LedgerLab listening");

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  await app.close();
  await worker?.stop();
  await pool.end();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
