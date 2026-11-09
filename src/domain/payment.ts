import type { Currency } from "./money.js";

export const PAYMENT_STATUSES = [
  "CREATED",
  "AUTHORIZED",
  "CAPTURED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "CANCELED",
  "FAILED",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export type Payment = {
  id: string;
  amount: number;
  currency: Currency;
  status: PaymentStatus;
  authorizedAmount: number;
  capturedAmount: number;
  refundedAmount: number;
  version: number;
  paymentMethod: string;
  description: string | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The part of a payment the state machine reads and writes. */
export type PaymentState = Pick<
  Payment,
  "amount" | "status" | "authorizedAmount" | "capturedAmount" | "refundedAmount" | "version" | "failureCode"
>;
