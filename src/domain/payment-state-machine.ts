// The payment state machine. Pure functions only: no I/O, no clock, no DB.
// Route handlers never touch status or amounts directly; they turn a request
// into a PaymentCommand and ask this module what the next state is.
//
//   CREATED ──authorize(approved)──▶ AUTHORIZED ──capture──▶ CAPTURED ──refund──▶ PARTIALLY_REFUNDED ──refund──▶ REFUNDED
//      │  └─authorize(declined)──▶ FAILED      │                    └──────────refund (full)───────────────────▲
//      └──────cancel──▶ CANCELED ◀──cancel─────┘
//
// The same graph is enforced a second time by the payments_guard_update
// trigger in src/db/migrations/001_payments.sql.

import { DomainError } from "./errors.js";
import { isValidAmount } from "./money.js";
import type { PaymentState, PaymentStatus } from "./payment.js";

export type AuthorizationDecision = { approved: true } | { approved: false; declineCode: string };

export type PaymentCommand =
  | { type: "authorize"; decision: AuthorizationDecision }
  | { type: "capture"; amount?: number }
  | { type: "refund"; amount: number }
  | { type: "cancel" };

export type PaymentEventType =
  | "payment.created"
  | "payment.authorized"
  | "payment.failed"
  | "payment.captured"
  | "payment.partially_refunded"
  | "payment.refunded"
  | "payment.canceled";

export const PAYMENT_EVENT_TYPES: readonly PaymentEventType[] = [
  "payment.created",
  "payment.authorized",
  "payment.failed",
  "payment.captured",
  "payment.partially_refunded",
  "payment.refunded",
  "payment.canceled",
];

/** What the ledger must record for a transition. Turned into journal lines by src/ledger/postings.ts. */
export type LedgerIntent =
  | { kind: "AUTHORIZATION_HOLD"; amount: number }
  | { kind: "CAPTURE"; capturedAmount: number; releasedHold: number }
  | { kind: "AUTHORIZATION_RELEASE"; amount: number }
  | { kind: "REFUND"; amount: number };

export type Transition = {
  from: PaymentStatus;
  next: PaymentState;
  eventType: PaymentEventType;
  ledger: LedgerIntent | null;
};

export type TransitionResult = { ok: true; transition: Transition } | { ok: false; error: DomainError };

/** Which statuses each command may start from. Documented in docs/architecture.md. */
export const COMMAND_SOURCE_STATES: Record<PaymentCommand["type"], readonly PaymentStatus[]> = {
  authorize: ["CREATED"],
  capture: ["AUTHORIZED"],
  refund: ["CAPTURED", "PARTIALLY_REFUNDED"],
  cancel: ["CREATED", "AUTHORIZED"],
};

/** Every legal (from -> to) status edge. Kept in sync with the SQL trigger by a test. */
export const STATUS_GRAPH: Record<PaymentStatus, readonly PaymentStatus[]> = {
  CREATED: ["AUTHORIZED", "FAILED", "CANCELED"],
  AUTHORIZED: ["CAPTURED", "CANCELED"],
  CAPTURED: ["PARTIALLY_REFUNDED", "REFUNDED"],
  PARTIALLY_REFUNDED: ["PARTIALLY_REFUNDED", "REFUNDED"],
  REFUNDED: [],
  CANCELED: [],
  FAILED: [],
};

export function isTerminal(status: PaymentStatus): boolean {
  return STATUS_GRAPH[status].length === 0;
}

export function applyCommand(state: PaymentState, command: PaymentCommand): TransitionResult {
  if (!COMMAND_SOURCE_STATES[command.type].includes(state.status)) {
    return reject(invalidTransition(state.status, command.type));
  }
  const base = { ...state, version: state.version + 1 };

  switch (command.type) {
    case "authorize": {
      if (!command.decision.approved) {
        return accept(state.status, { ...base, status: "FAILED", failureCode: command.decision.declineCode }, "payment.failed", null);
      }
      return accept(
        state.status,
        { ...base, status: "AUTHORIZED", authorizedAmount: state.amount },
        "payment.authorized",
        { kind: "AUTHORIZATION_HOLD", amount: state.amount },
      );
    }

    case "capture": {
      const amount = command.amount ?? state.authorizedAmount;
      if (!isValidAmount(amount)) {
        return reject(new DomainError("INVALID_AMOUNT", "Capture amount must be a positive integer in minor units."));
      }
      if (amount > state.authorizedAmount) {
        return reject(
          new DomainError("CAPTURE_EXCEEDS_AUTHORIZED_AMOUNT", "Capture would exceed the authorized amount.", {
            authorized_amount: state.authorizedAmount,
            requested_amount: amount,
          }),
        );
      }
      // Single capture: whatever is not captured is released, like most card processors.
      return accept(
        state.status,
        { ...base, status: "CAPTURED", capturedAmount: amount },
        "payment.captured",
        { kind: "CAPTURE", capturedAmount: amount, releasedHold: state.authorizedAmount },
      );
    }

    case "refund": {
      if (!isValidAmount(command.amount)) {
        return reject(new DomainError("INVALID_AMOUNT", "Refund amount must be a positive integer in minor units."));
      }
      const refundable = state.capturedAmount - state.refundedAmount;
      if (command.amount > refundable) {
        return reject(
          new DomainError("REFUND_EXCEEDS_CAPTURED_AMOUNT", "Refund would exceed the captured amount.", {
            captured_amount: state.capturedAmount,
            refunded_amount: state.refundedAmount,
            refundable_amount: refundable,
            requested_amount: command.amount,
          }),
        );
      }
      const refundedAmount = state.refundedAmount + command.amount;
      const full = refundedAmount === state.capturedAmount;
      return accept(
        state.status,
        { ...base, status: full ? "REFUNDED" : "PARTIALLY_REFUNDED", refundedAmount },
        full ? "payment.refunded" : "payment.partially_refunded",
        { kind: "REFUND", amount: command.amount },
      );
    }

    case "cancel": {
      const ledger: LedgerIntent | null =
        state.status === "AUTHORIZED" ? { kind: "AUTHORIZATION_RELEASE", amount: state.authorizedAmount } : null;
      return accept(state.status, { ...base, status: "CANCELED" }, "payment.canceled", ledger);
    }
  }
}

function accept(
  from: PaymentStatus,
  next: PaymentState,
  eventType: PaymentEventType,
  ledger: LedgerIntent | null,
): TransitionResult {
  return { ok: true, transition: { from, next, eventType, ledger } };
}

function reject(error: DomainError): TransitionResult {
  return { ok: false, error };
}

function invalidTransition(status: PaymentStatus, command: PaymentCommand["type"]): DomainError {
  const reasons: Partial<Record<PaymentStatus, string>> = {
    CREATED: command === "refund" ? "it has not been captured" : command === "capture" ? "it has not been authorized" : "",
    AUTHORIZED: command === "authorize" ? "it is already authorized" : "it has not been captured",
    CAPTURED: "it has already been captured",
    PARTIALLY_REFUNDED: "it has already been captured",
    REFUNDED: command === "refund" ? "it is already fully refunded" : "it has already been captured and refunded",
    CANCELED: "it was canceled",
    FAILED: "its authorization failed",
  };
  const reason = reasons[status];
  return new DomainError(
    "INVALID_STATE_TRANSITION",
    `Cannot ${command} a payment in status ${status}${reason ? ` because ${reason}` : ""}.`,
    { status, command, allowed_from: COMMAND_SOURCE_STATES[command] },
  );
}
