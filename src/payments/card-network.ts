import type { AuthorizationDecision } from "../domain/payment-state-machine.js";

// A stand-in for the card network. Deterministic by payment method so tests
// and demos can pick an outcome. A real network call would be the one step
// in this system that is an external side effect *before* our commit; see
// "Idempotency and external calls" in docs/architecture.md.
export const TEST_PAYMENT_METHODS: Record<string, AuthorizationDecision> = {
  pm_card_visa: { approved: true },
  pm_card_mastercard: { approved: true },
  pm_card_declined: { approved: false, declineCode: "card_declined" },
  pm_card_insufficient_funds: { approved: false, declineCode: "insufficient_funds" },
};

export function authorizeWithCardNetwork(paymentMethod: string): AuthorizationDecision {
  return TEST_PAYMENT_METHODS[paymentMethod] ?? { approved: false, declineCode: "unknown_payment_method" };
}
