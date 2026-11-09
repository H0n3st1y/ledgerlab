import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { loadConfig, type WorkerConfig } from "../../src/config.js";
import { SandboxConsumer } from "../../src/consumer/consumer.js";
import type { AppContext } from "../../src/context.js";
import { migrate } from "../../src/db/migrate.js";
import { createPool, type Pool } from "../../src/db/pool.js";
import { FailureInjector } from "../../src/failures/injector.js";
import { createLogger } from "../../src/observability/logger.js";
import { Metrics } from "../../src/observability/metrics.js";
import { WebhookWorker } from "../../src/workers/webhook-worker.js";
import { ApiClient } from "./api-client.js";

export type Harness = {
  ctx: AppContext;
  pool: Pool;
  app: FastifyInstance;
  baseUrl: string;
  api: ApiClient;
  consumer: SandboxConsumer;
  worker: (id?: string, overrides?: Partial<WorkerConfig>) => WebhookWorker;
  /** Registers the in-process sandbox consumer as a webhook endpoint. */
  registerConsumer: (enabledEvents?: string[]) => Promise<{ id: string; secret: string }>;
  close: () => Promise<void>;
};

/**
 * Fresh schema, real Postgres, real HTTP server on an ephemeral port.
 * Nothing about transactions or locking is mocked.
 */
export async function startHarness(opts: { worker?: Partial<WorkerConfig>; poolMax?: number } = {}): Promise<Harness> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    ENABLE_DEV_TOOLS: "true",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
  });
  config.worker = {
    ...config.worker,
    pollIntervalMs: 20,
    batchSize: 10,
    maxAttempts: 5,
    backoffBaseMs: 20,
    backoffMaxMs: 200,
    httpTimeoutMs: 1000,
    leaseMs: 1500,
    ...opts.worker,
  };
  // Each test file gets its own throwaway database, so files can run in
  // parallel without stepping on each other's rows or workers.
  const admin = createPool(config.databaseUrl, 1);
  const dbName = `ledgerlab_test_${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const url = new URL(config.databaseUrl);
  url.pathname = `/${dbName}`;
  config.databaseUrl = url.toString();
  // Idle-client errors are expected when the throwaway database is force-dropped.
  const pool = createPool(config.databaseUrl, opts.poolMax ?? 20, () => {});
  await migrate(pool);

  const ctx: AppContext = {
    config,
    pool,
    log: createLogger(config.logLevel),
    metrics: new Metrics(),
    failures: new FailureInjector(true),
  };
  const consumer = new SandboxConsumer();
  const app = await buildApp(ctx, { consumer });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const workers: WebhookWorker[] = [];

  return {
    ctx,
    pool,
    app,
    baseUrl,
    consumer,
    api: new ApiClient(baseUrl),
    worker: (id, overrides) => {
      const w = new WebhookWorker({ ...ctx, config: { ...ctx.config.worker, ...overrides } }, id);
      workers.push(w);
      return w;
    },
    registerConsumer: async (enabledEvents = []) => {
      const res = await new ApiClient(baseUrl).post("/webhook-endpoints", {
        url: `${baseUrl}/sandbox/consumer/webhooks`,
        enabled_events: enabledEvents,
      });
      if (res.status !== 201) throw new Error(`endpoint creation failed: ${JSON.stringify(res.body)}`);
      const body = res.body as { id: string; secret: string };
      consumer.secret = body.secret;
      return body;
    },
    close: async () => {
      for (const w of workers) await w.stop();
      await app.close();
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    },
  };
}
