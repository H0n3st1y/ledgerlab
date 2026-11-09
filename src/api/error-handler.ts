import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { DomainError } from "../domain/errors.js";
import { InjectedFailure } from "../failures/injector.js";

type PgError = Error & { code?: string };

/** Maps every error to the structured `{ error: { code, message } }` shape. */
export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof DomainError) {
    return reply.code(err.httpStatus).send(err.toBody());
  }
  if (hasZodFastifySchemaValidationErrors(err)) {
    return reply.code(400).send({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed.",
        details: {
          issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
        },
      },
    });
  }
  const fe = err as FastifyError;
  if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
    return reply.code(fe.statusCode).send({ error: { code: fe.code ?? "BAD_REQUEST", message: fe.message } });
  }
  if (err instanceof InjectedFailure) {
    req.log.warn({ err }, "request failed by injected failure; transaction rolled back");
    return reply.code(500).send({ error: { code: "INJECTED_FAILURE", message: `${err.message}; the transaction was rolled back` } });
  }
  const pg = err as PgError;
  if (pg.code === "55P03") {
    // lock_timeout: another transaction held the payment row too long. Nothing
    // committed, the idempotency key was released, so the client may retry.
    return reply
      .code(503)
      .header("retry-after", "1")
      .send({ error: { code: "LOCK_TIMEOUT", message: "The payment is busy; retry with the same Idempotency-Key." } });
  }
  req.log.error({ err }, "unhandled error");
  return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Internal server error." } });
}
