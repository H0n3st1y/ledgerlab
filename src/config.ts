import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().default("postgres://postgres:postgres@localhost:5432/ledgerlab"),
  DB_POOL_MAX: z.coerce.number().int().positive().default(20),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  RUN_WORKER: bool.default(true),
  WORKER_ID: z.string().optional(),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(8),
  WEBHOOK_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1000),
  WEBHOOK_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(300_000),
  WEBHOOK_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  WEBHOOK_LEASE_MS: z.coerce.number().int().positive().default(30_000),
  ENABLE_DEV_TOOLS: bool.default(false),
});

export type Config = {
  env: "development" | "test" | "production";
  databaseUrl: string;
  dbPoolMax: number;
  port: number;
  host: string;
  logLevel: string;
  runWorker: boolean;
  worker: WorkerConfig;
  enableDevTools: boolean;
};

export type WorkerConfig = {
  workerId?: string;
  pollIntervalMs: number;
  batchSize: number;
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  httpTimeoutMs: number;
  leaseMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = EnvSchema.parse(env);
  if (e.NODE_ENV === "production" && e.ENABLE_DEV_TOOLS) {
    throw new Error("ENABLE_DEV_TOOLS must not be set in production");
  }
  return {
    env: e.NODE_ENV,
    databaseUrl: e.DATABASE_URL,
    dbPoolMax: e.DB_POOL_MAX,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    runWorker: e.RUN_WORKER,
    enableDevTools: e.ENABLE_DEV_TOOLS,
    worker: {
      workerId: e.WORKER_ID,
      pollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
      batchSize: e.WORKER_BATCH_SIZE,
      maxAttempts: e.WEBHOOK_MAX_ATTEMPTS,
      backoffBaseMs: e.WEBHOOK_BACKOFF_BASE_MS,
      backoffMaxMs: e.WEBHOOK_BACKOFF_MAX_MS,
      httpTimeoutMs: e.WEBHOOK_HTTP_TIMEOUT_MS,
      leaseMs: e.WEBHOOK_LEASE_MS,
    },
  };
}
