import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { AppContext } from "../../context.js";

export function healthRoutes(ctx: AppContext): FastifyPluginAsyncZod {
  return async (app) => {
    // Liveness: the process is up. Deliberately does not touch the database,
    // so a DB outage does not get healthy processes restarted in a loop.
    app.get("/health", { schema: { tags: ["ops"] } }, async () => ({ status: "ok" }));

    // Readiness: can serve traffic (DB reachable and migrated).
    app.get("/ready", { schema: { tags: ["ops"] } }, async (_req, reply) => {
      try {
        const { rows } = await ctx.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM schema_migrations");
        return { status: "ready", migrations: rows[0]?.n ?? 0 };
      } catch (err) {
        return reply.code(503).send({ status: "not_ready", error: (err as Error).message });
      }
    });

    app.get("/metrics", { schema: { tags: ["ops"] } }, async (_req, reply) =>
      reply.type("text/plain; version=0.0.4").send(ctx.metrics.render()),
    );
  };
}
