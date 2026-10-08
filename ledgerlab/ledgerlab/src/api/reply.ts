import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../context.js";
import type { IdempotentResponse } from "../idempotency/idempotency.js";

/**
 * Sends a (possibly replayed) idempotent response. Also the hook for the
 * "server committed, client never heard back" failure: the transaction is
 * already committed when we get here, so dropping the socket reproduces a
 * client-side timeout after a successful write.
 */
export function sendIdempotent(
  ctx: AppContext,
  req: FastifyRequest,
  reply: FastifyReply,
  res: IdempotentResponse,
  failureCtx: { operation: string; paymentId?: string },
) {
  if (!res.replayed && ctx.failures.take("api.after_commit", failureCtx)) {
    req.log.warn(failureCtx, "failure injection: committed, now dropping the connection without a response");
    reply.hijack();
    reply.raw.destroy();
    return reply;
  }
  if (res.replayed) reply.header("idempotent-replayed", "true");
  return reply.code(res.statusCode).send(res.body);
}
