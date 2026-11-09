import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { FAILURE_POINTS, type FailurePoint } from "../../failures/injector.js";
import type { WebhookWorker } from "../../workers/webhook-worker.js";

const ArmBody = z.strictObject({
  point: z.enum(Object.keys(FAILURE_POINTS) as [FailurePoint, ...FailurePoint[]]),
  times: z.number().int().min(1).max(1000).default(1),
  delay_ms: z.number().int().min(0).max(120_000).optional(),
  match: z
    .strictObject({ event_type: z.string().optional(), payment_id: z.uuid().optional(), operation: z.string().optional() })
    .optional(),
});

/** Failure injection controls. Only registered when ENABLE_DEV_TOOLS=true. */
export function devRoutes(ctx: AppContext, worker: WebhookWorker | null): FastifyPluginAsyncZod {
  return async (app) => {
    app.get("/dev/failures", { schema: { tags: ["dev"], summary: "Failure points, armed rules, recent firings" } }, async () => ({
      points: FAILURE_POINTS,
      armed: ctx.failures.list(),
      recently_fired: ctx.failures.fired.slice(-50).reverse(),
    }));

    app.post("/dev/failures", { schema: { tags: ["dev"], summary: "Arm a failure point", body: ArmBody } }, async (req, reply) => {
      const b = req.body;
      const rule = ctx.failures.arm(b.point, {
        times: b.times,
        delayMs: b.delay_ms,
        match: b.match && { eventType: b.match.event_type, paymentId: b.match.payment_id, operation: b.match.operation },
      });
      req.log.warn({ rule }, "failure point armed");
      return reply.code(201).send(rule);
    });

    app.delete("/dev/failures", { schema: { tags: ["dev"], summary: "Disarm all failure points" } }, async () => {
      ctx.failures.clear();
      return { cleared: true };
    });

    app.post("/dev/worker/run-once", { schema: { tags: ["dev"], summary: "Run one worker pass now (claims due deliveries)" } }, async (_req, reply) => {
      if (!worker) return reply.code(409).send({ error: { code: "NO_WORKER", message: "No in-process worker (RUN_WORKER=false)." } });
      try {
        return { claimed: await worker.runOnce(), worker_id: worker.workerId };
      } catch (err) {
        return { claimed: 0, crashed: true, error: (err as Error).message };
      }
    });
  };
}
