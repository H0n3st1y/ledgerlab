import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isBalanced, journalLines } from "../../src/ledger/postings.js";
import type { LedgerIntent } from "../../src/domain/payment-state-machine.js";

const amount = fc.integer({ min: 1, max: 100_000_000 });
const intent: fc.Arbitrary<LedgerIntent> = fc.oneof(
  amount.map((a) => ({ kind: "AUTHORIZATION_HOLD" as const, amount: a })),
  fc.tuple(amount, amount).map(([a, b]) => ({ kind: "CAPTURE" as const, capturedAmount: Math.min(a, b), releasedHold: Math.max(a, b) })),
  amount.map((a) => ({ kind: "AUTHORIZATION_RELEASE" as const, amount: a })),
  amount.map((a) => ({ kind: "REFUND" as const, amount: a })),
);

describe("journal postings", () => {
  it("every intent produces a balanced journal of >= 2 strictly positive lines", () => {
    fc.assert(
      fc.property(intent, (i) => {
        const lines = journalLines(i);
        expect(isBalanced(lines)).toBe(true);
        for (const l of lines) expect((l.debit ?? l.credit)!).toBeGreaterThan(0);
      }),
    );
  });

  it("capture books money movement and hold release as two balanced pairs", () => {
    expect(journalLines({ kind: "CAPTURE", capturedAmount: 4_000, releasedHold: 10_000 })).toEqual([
      { account: "processor_clearing", debit: 4_000 },
      { account: "merchant_payable", credit: 4_000 },
      { account: "authorization_hold_offset", debit: 10_000 },
      { account: "customer_authorization_holds", credit: 10_000 },
    ]);
  });

  it("refund debits merchant payable and credits refund clearing", () => {
    expect(journalLines({ kind: "REFUND", amount: 700 })).toEqual([
      { account: "merchant_payable", debit: 700 },
      { account: "refund_clearing", credit: 700 },
    ]);
  });

  it("isBalanced rejects one-sided and single-line journals", () => {
    expect(isBalanced([{ account: "refund_clearing", credit: 5 }])).toBe(false);
    expect(isBalanced([{ account: "merchant_payable", debit: 5 }, { account: "refund_clearing", credit: 4 }])).toBe(false);
  });
});
