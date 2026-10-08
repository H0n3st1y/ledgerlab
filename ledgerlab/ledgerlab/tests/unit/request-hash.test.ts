import { describe, expect, it } from "vitest";
import { canonicalJson, requestHash } from "../../src/idempotency/request-hash.js";

describe("idempotency request hash", () => {
  it("is independent of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(requestHash("POST /payments", {}, { amount: 1, currency: "USD" })).toBe(
      requestHash("POST /payments", {}, { currency: "USD", amount: 1 }),
    );
  });

  it("differs by operation, path params and body", () => {
    const base = requestHash("POST /payments/:id/refunds", { id: "a" }, { amount: 100 });
    expect(requestHash("POST /payments/:id/capture", { id: "a" }, { amount: 100 })).not.toBe(base);
    expect(requestHash("POST /payments/:id/refunds", { id: "b" }, { amount: 100 })).not.toBe(base);
    expect(requestHash("POST /payments/:id/refunds", { id: "a" }, { amount: 101 })).not.toBe(base);
  });

  it("treats a missing body and an empty object the same", () => {
    expect(requestHash("op", {}, undefined)).toBe(requestHash("op", {}, {}));
  });
});
