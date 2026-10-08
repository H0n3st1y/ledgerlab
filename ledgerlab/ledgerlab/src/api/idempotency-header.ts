import type { FastifyRequest } from "fastify";
import { DomainError } from "../domain/errors.js";
import type { IdempotencyRequest } from "../idempotency/idempotency.js";
import { requestHash } from "../idempotency/request-hash.js";

/**
 * Reads the Idempotency-Key header and binds it to this exact request
 * (operation + path params + body). `operation` uses the route template, not
 * the concrete URL, so the hash is what distinguishes payment A from payment B.
 */
export function idempotencyFor(
  req: FastifyRequest,
  opts: { required: boolean; params?: Record<string, unknown>; body?: unknown },
): IdempotencyRequest | null {
  const raw = req.headers["idempotency-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key) {
    if (opts.required) {
      throw new DomainError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "This endpoint moves money and requires an Idempotency-Key header. Generate a unique key per logical operation and reuse it on retries.",
      );
    }
    return null;
  }
  if (key.length > 255) throw new DomainError("VALIDATION_ERROR", "Idempotency-Key must be at most 255 characters.");
  const operation = `${req.method} ${req.routeOptions.url}`;
  return { key, operation, requestHash: requestHash(operation, opts.params ?? {}, opts.body ?? {}) };
}
