import { describe, expect, it } from "vitest";
import { PAYMENT_STATUSES, type PaymentState, type PaymentStatus } from "../../src/domain/payment.js";
import { applyCommand, COMMAND_SOURCE_STATES, STATUS_GRAPH, type PaymentCommand } from "../../src/domain/payment-state-machine.js";

const created = (amount = 10_000): PaymentState => ({
  amount,
  status: "CREATED",
  authorizedAmount: 0,
  capturedAmount: 0,
  refundedAmount: 0,
  version: 1,
  failureCode: null,
});

function run(state: PaymentState, ...cmds: PaymentCommand[]): PaymentState {
  return cmds.reduce((s, c) => {
    const r = applyCommand(s, c);
    if (!r.ok) throw r.error;
    return r.transition.next;
  }, state);
}

const approve: PaymentCommand = { type: "authorize", decision: { approved: true } };

describe("payment state machine", () => {
  it("walks the happy path CREATED -> AUTHORIZED -> CAPTURED -> PARTIALLY_REFUNDED -> REFUNDED", () => {
    let s = run(created(), approve);
    expect(s).toMatchObject({ status: "AUTHORIZED", authorizedAmount: 10_000, version: 2 });
    s = run(s, { type: "capture" });
    expect(s).toMatchObject({ status: "CAPTURED", capturedAmount: 10_000, version: 3 });
    s = run(s, { type: "refund", amount: 2_500 });
    expect(s).toMatchObject({ status: "PARTIALLY_REFUNDED", refundedAmount: 2_500, version: 4 });
    s = run(s, { type: "refund", amount: 7_500 });
    expect(s).toMatchObject({ status: "REFUNDED", refundedAmount: 10_000, version: 5 });
  });

  it("a declined authorization moves to FAILED with no ledger intent", () => {
    const r = applyCommand(created(), { type: "authorize", decision: { approved: false, declineCode: "card_declined" } });
    expect(r.ok && r.transition).toMatchObject({ next: { status: "FAILED", failureCode: "card_declined" }, ledger: null, eventType: "payment.failed" });
  });

  it("rejects refunding a CREATED payment", () => {
    const r = applyCommand(created(), { type: "refund", amount: 1 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("INVALID_STATE_TRANSITION");
  });

  it("rejects authorizing a CAPTURED payment again", () => {
    const s = run(created(), approve, { type: "capture" });
    const r = applyCommand(s, approve);
    expect(!r.ok && r.error.code).toBe("INVALID_STATE_TRANSITION");
  });

  it("rejects any refund on a fully refunded payment", () => {
    const s = run(created(), approve, { type: "capture" }, { type: "refund", amount: 10_000 });
    const r = applyCommand(s, { type: "refund", amount: 1 });
    expect(!r.ok && r.error.message).toMatch(/already fully refunded/);
  });

  it("rejects capturing more than authorized", () => {
    const s = run(created(), approve);
    const r = applyCommand(s, { type: "capture", amount: 10_001 });
    expect(!r.ok && r.error.code).toBe("CAPTURE_EXCEEDS_AUTHORIZED_AMOUNT");
  });

  it("rejects refunding more than captured minus refunded", () => {
    const s = run(created(), approve, { type: "capture", amount: 6_000 }, { type: "refund", amount: 5_000 });
    const r = applyCommand(s, { type: "refund", amount: 1_001 });
    expect(!r.ok && r.error.code).toBe("REFUND_EXCEEDS_CAPTURED_AMOUNT");
    expect(!r.ok && r.error.details).toMatchObject({ refundable_amount: 1_000 });
  });

  it("partial capture releases the full authorization hold", () => {
    const s = run(created(), approve);
    const r = applyCommand(s, { type: "capture", amount: 4_000 });
    expect(r.ok && r.transition.ledger).toEqual({ kind: "CAPTURE", capturedAmount: 4_000, releasedHold: 10_000 });
  });

  it("cancel releases a hold only when one exists", () => {
    const fromCreated = applyCommand(created(), { type: "cancel" });
    expect(fromCreated.ok && fromCreated.transition.ledger).toBeNull();
    const fromAuthorized = applyCommand(run(created(), approve), { type: "cancel" });
    expect(fromAuthorized.ok && fromAuthorized.transition.ledger).toEqual({ kind: "AUTHORIZATION_RELEASE", amount: 10_000 });
  });

  it.each([0, -1, 1.5, Number.NaN, 2 ** 60])("rejects invalid refund amount %s", (amount) => {
    const s = run(created(), approve, { type: "capture" });
    const r = applyCommand(s, { type: "refund", amount });
    expect(r.ok).toBe(false);
  });

  it("never produces an edge outside STATUS_GRAPH, and always bumps version by 1", () => {
    const commands: PaymentCommand[] = [
      approve,
      { type: "authorize", decision: { approved: false, declineCode: "x" } },
      { type: "capture" },
      { type: "capture", amount: 1 },
      { type: "refund", amount: 1 },
      { type: "refund", amount: 3 },
      { type: "cancel" },
    ];
    // Small amount keeps the reachable state space small enough to enumerate fully.
    const states: PaymentState[] = [created(3)];
    const seen = new Set<string>();
    while (states.length) {
      const s = states.pop()!;
      for (const c of commands) {
        const r = applyCommand(s, c);
        if (!r.ok) {
          // Rejections from the wrong source state are always INVALID_STATE_TRANSITION.
          if (!COMMAND_SOURCE_STATES[c.type].includes(s.status)) expect(r.error.code).toBe("INVALID_STATE_TRANSITION");
          continue;
        }
        const { next } = r.transition;
        expect(STATUS_GRAPH[s.status]).toContain(next.status);
        expect(next.version).toBe(s.version + 1);
        expect(next.amount).toBeGreaterThanOrEqual(next.authorizedAmount);
        expect(next.authorizedAmount).toBeGreaterThanOrEqual(next.capturedAmount);
        expect(next.capturedAmount).toBeGreaterThanOrEqual(next.refundedAmount);
        const key = JSON.stringify(next);
        if (!seen.has(key)) {
          seen.add(key);
          states.push(next);
        }
      }
    }
    // Every status is reachable.
    const reached = new Set([...seen].map((k) => (JSON.parse(k) as PaymentState).status));
    for (const st of PAYMENT_STATUSES.filter((s) => s !== "CREATED")) expect(reached).toContain(st as PaymentStatus);
  });
});
