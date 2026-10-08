import { describe, expect, it } from "vitest";
import { backoffDelayMs } from "../../src/webhooks/backoff.js";

describe("exponential backoff", () => {
  const opts = { baseMs: 1000, maxMs: 60_000 };

  it("doubles the ceiling each attempt, within [ceiling/2, ceiling]", () => {
    expect(backoffDelayMs(1, { ...opts, random: () => 0 })).toBe(500);
    expect(backoffDelayMs(1, { ...opts, random: () => 1 })).toBe(1000);
    expect(backoffDelayMs(2, { ...opts, random: () => 1 })).toBe(2000);
    expect(backoffDelayMs(4, { ...opts, random: () => 1 })).toBe(8000);
    expect(backoffDelayMs(4, { ...opts, random: () => 0 })).toBe(4000);
  });

  it("caps at maxMs and never overflows for large attempt numbers", () => {
    expect(backoffDelayMs(20, { ...opts, random: () => 1 })).toBe(60_000);
    expect(backoffDelayMs(10_000, { ...opts, random: () => 1 })).toBe(60_000);
  });

  it("rejects attempt numbers below 1", () => {
    expect(() => backoffDelayMs(0, opts)).toThrow();
  });
});
