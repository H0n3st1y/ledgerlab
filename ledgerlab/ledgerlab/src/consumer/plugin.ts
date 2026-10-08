import type { FastifyPluginAsync } from "fastify";
import type { SandboxConsumer } from "./consumer.js";

/**
 * Mounts a SandboxConsumer under a prefix. Registered in its own encapsulated
 * context so it can keep the raw body (signatures are over raw bytes).
 */
export function consumerPlugin(consumer: SandboxConsumer): FastifyPluginAsync {
  return async (app) => {
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

    app.post("/webhooks", { schema: { hide: true } }, async (req, reply) => {
      const res = await consumer.handle(req.headers, String(req.body ?? ""));
      return reply.code(res.status).send(res.body);
    });
    app.get("/state", { schema: { hide: true } }, async () => consumer.snapshot());
    app.post("/config", { schema: { hide: true } }, async (req) => {
      const patch = JSON.parse(String(req.body || "{}"));
      if (typeof patch.secret === "string") consumer.secret = patch.secret;
      delete patch.secret;
      return consumer.configure(patch);
    });
    app.post("/reset", { schema: { hide: true } }, async () => {
      consumer.reset();
      return { reset: true };
    });
  };
}
