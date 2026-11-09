import { describe, expect, it } from "vitest";
import { FailureInjector } from "../../src/failures/injector.js";

describe("failure injector", () => {
  it("fires a rule the configured number of times, then disarms", () => {
    const f = new FailureInjector(true);
    f.arm("worker.after_claim", { times: 2 });
    expect(f.take("worker.after_claim")).not.toBeNull();
    expect(f.take("worker.after_claim")).not.toBeNull();
    expect(f.take("worker.after_claim")).toBeNull();
  });

  it("only fires when the match filter matches", () => {
    const f = new FailureInjector(true);
    f.arm("worker.delay_send", { match: { eventType: "payment.captured" }, delayMs: 10 });
    expect(f.take("worker.delay_send", { eventType: "payment.refunded" })).toBeNull();
    expect(f.take("worker.delay_send", { eventType: "payment.captured" })?.delayMs).toBe(10);
  });

  it("is inert and refuses to arm when disabled", () => {
    const f = new FailureInjector(false);
    expect(() => f.arm("api.after_commit")).toThrow();
    expect(f.take("api.after_commit")).toBeNull();
  });
});
