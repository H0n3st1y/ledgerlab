import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyPluginAsync } from "fastify";

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** Serves the single-file developer dashboard at /dashboard (dev tools only). */
export function dashboardRoutes(): FastifyPluginAsync {
  return async (app) => {
    app.get("/", { schema: { hide: true } }, async (_req, reply) => reply.redirect("/dashboard"));
    app.get("/favicon.ico", { schema: { hide: true } }, async (_req, reply) => reply.code(204).send());
    app.get("/dashboard", { schema: { hide: true } }, async (_req, reply) => {
      const html = await readFile(path.join(DIR, "dashboard.html"), "utf8");
      return reply.type("text/html; charset=utf-8").send(html);
    });
  };
}
