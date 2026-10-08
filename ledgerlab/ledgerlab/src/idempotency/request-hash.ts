import { createHash } from "node:crypto";

/** JSON with object keys sorted recursively, so {a,b} and {b,a} hash the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * The fingerprint a key is bound to: which operation, on which resource, with
 * which body. Headers are deliberately excluded (request ids, user agents and
 * timestamps differ between honest retries).
 */
export function requestHash(operation: string, params: Record<string, unknown>, body: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ operation, params, body: body ?? {} }))
    .digest("hex");
}
