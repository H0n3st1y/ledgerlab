// Turns a LedgerIntent into balanced journal lines. Pure; unit tested.
//
// Chart of accounts (see docs/architecture.md#ledger):
//   customer_authorization_holds  memo, debit-normal   card holds outstanding
//   authorization_hold_offset     memo, credit-normal  offset for the holds
//   processor_clearing            asset, debit-normal  money collected from the network, not yet settled
//   merchant_payable              liability, credit    what we owe the merchant
//   refund_clearing               liability, credit    refunds owed back to cardholders
//
// Authorization moves no money, so it is booked in a pair of memo accounts.
// That keeps "every financial state change has exactly one balanced ledger
// transaction" true for authorize/cancel too, and lets us reconcile the
// payment row's amounts against the journal.

import type { LedgerIntent } from "../domain/payment-state-machine.js";

export type AccountCode =
  | "customer_authorization_holds"
  | "authorization_hold_offset"
  | "processor_clearing"
  | "merchant_payable"
  | "refund_clearing";

export type JournalLine = { account: AccountCode; debit: number; credit?: undefined } | { account: AccountCode; credit: number; debit?: undefined };

export function journalLines(intent: LedgerIntent): JournalLine[] {
  switch (intent.kind) {
    case "AUTHORIZATION_HOLD":
      return [
        { account: "customer_authorization_holds", debit: intent.amount },
        { account: "authorization_hold_offset", credit: intent.amount },
      ];
    case "CAPTURE":
      return [
        { account: "processor_clearing", debit: intent.capturedAmount },
        { account: "merchant_payable", credit: intent.capturedAmount },
        // Capture consumes the whole authorization; any uncaptured remainder is released.
        { account: "authorization_hold_offset", debit: intent.releasedHold },
        { account: "customer_authorization_holds", credit: intent.releasedHold },
      ];
    case "AUTHORIZATION_RELEASE":
      return [
        { account: "authorization_hold_offset", debit: intent.amount },
        { account: "customer_authorization_holds", credit: intent.amount },
      ];
    case "REFUND":
      return [
        { account: "merchant_payable", debit: intent.amount },
        { account: "refund_clearing", credit: intent.amount },
      ];
  }
}

export function isBalanced(lines: JournalLine[]): boolean {
  let debits = 0;
  let credits = 0;
  for (const l of lines) {
    debits += l.debit ?? 0;
    credits += l.credit ?? 0;
  }
  return lines.length >= 2 && debits === credits;
}

export const DESCRIPTIONS: Record<LedgerIntent["kind"], string> = {
  AUTHORIZATION_HOLD: "Authorization hold placed",
  CAPTURE: "Payment captured; authorization hold released",
  AUTHORIZATION_RELEASE: "Authorization canceled; hold released",
  REFUND: "Refund issued",
};
