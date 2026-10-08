import { randomUUID } from "node:crypto";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { AppContext } from "./context.js";
import { errorHandler } from "./api/error-handler.js";
import { devRoutes } from "./api/routes/dev.js";
import { healthRoutes } from "./api/routes/health.js";
import { ledgerRoutes } from "./api/routes/ledger.js";
import { paymentRoutes } from "./api/routes/payments.js";
import { webhookRoutes } from "./api/routes/webhooks.js";
import { dashboardRoutes } from "./dashboard/routes.js";
import type { SandboxConsumer } from "./consumer/consumer.js";
import { consumerPlugin } from "./consumer/plugin.js";
import type { WebhookWorker } from "./workers/webhook-worker.js";

export async function buildApp(ctx: AppContext, opts: { worker?: WebhookWorker | null; consumer?: SandboxConsumer | null } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: ctx.log as FastifyBaseLogger,
    requestIdHeader: false,
    genReqId: (req) => {
      const given = req.headers["x-request-id"];
      return typeof given === "string" && /^[\w.-]{1,128}$/.test(given) ? given : randomUUID();
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);

  // POST /payments/:id/authorize is commonly sent with an empty body and a
  // JSON content type. Treat that as "no body" instead of a parse error.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = Object.assign(new Error("Body is not valid JSON"), { statusCode: 400, code: "INVALID_JSON" });
      done(err, undefined);
    }
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    const key = req.headers["idempotency-key"];
    if (key) req.log = req.log.child({ idempotencyKey: key });
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "LedgerLab API",
        version: "0.1.0",
        description:
          "Payment reliability sandbox. Amounts are integers in minor units. Mutating payment endpoints require an Idempotency-Key header.",
      },
      tags: [
        { name: "payments" },
        { name: "ledger" },
        { name: "webhooks" },
        { name: "ops" },
        { name: "dev", description: "Failure injection; only when ENABLE_DEV_TOOLS=true" },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  await app.register(healthRoutes(ctx));
  await app.register(paymentRoutes(ctx));
  await app.register(ledgerRoutes(ctx));
  await app.register(webhookRoutes(ctx));
  if (ctx.config.enableDevTools) {
    await app.register(devRoutes(ctx, opts.worker ?? null));
    await app.register(dashboardRoutes());
    // The reference consumer, mounted in-process so `npm run dev` alone can
    // demonstrate the full webhook loop (the worker POSTs back to this server).
    if (opts.consumer) await app.register(consumerPlugin(opts.consumer), { prefix: "/sandbox/consumer" });
  }
  return app;
}
