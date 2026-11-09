import { z } from "zod";
import { MAX_AMOUNT, SUPPORTED_CURRENCIES } from "../domain/money.js";
import { PAYMENT_STATUSES } from "../domain/payment.js";
import { PAYMENT_EVENT_TYPES } from "../domain/payment-state-machine.js";

// Amounts are integers in minor units. 10.25 is rejected, not rounded.
export const MinorAmount = z
  .number()
  .int("amount must be an integer number of minor units (e.g. 1025 for $10.25)")
  .positive()
  .max(MAX_AMOUNT)
  .describe("Amount in minor units, e.g. 1025 = $10.25");

export const Uuid = z.uuid();
export const IdParams = z.object({ id: Uuid });

export const IdempotencyHeaders = z.looseObject({
  "idempotency-key": z.string().min(1).max(255).optional().describe("Client-generated unique key; retries reuse it"),
});

export const CreatePaymentBody = z.strictObject({
  amount: MinorAmount,
  currency: z.enum(SUPPORTED_CURRENCIES),
  payment_method: z
    .string()
    .min(1)
    .max(64)
    .default("pm_card_visa")
    .describe("Test payment method: pm_card_visa, pm_card_mastercard, pm_card_declined, pm_card_insufficient_funds"),
  description: z.string().max(500).nullish(),
});

export const EmptyBody = z.strictObject({}).nullish();
export const CaptureBody = z.strictObject({ amount: MinorAmount.optional().describe("Defaults to the authorized amount") }).nullish();
export const RefundBody = z.strictObject({ amount: MinorAmount, reason: z.string().max(500).nullish() });

export const Payment = z.object({
  id: Uuid,
  object: z.literal("payment"),
  amount: z.number().int(),
  currency: z.string(),
  status: z.enum(PAYMENT_STATUSES),
  authorized_amount: z.number().int(),
  captured_amount: z.number().int(),
  refunded_amount: z.number().int(),
  version: z.number().int().describe("Monotonic; increments on every state change. Use it to order webhook events."),
  payment_method: z.string(),
  description: z.string().nullable(),
  failure_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const Refund = z.object({
  id: Uuid,
  object: z.literal("refund"),
  payment_id: Uuid,
  amount: z.number().int(),
  currency: z.string(),
  reason: z.string().nullable(),
  payment_version: z.number().int(),
  created_at: z.string(),
});

export const ErrorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
});

export const LedgerTransaction = z.object({
  id: Uuid,
  object: z.literal("ledger_transaction"),
  kind: z.string(),
  currency: z.string(),
  payment_id: Uuid,
  payment_version: z.number().int(),
  refund_id: Uuid.nullable(),
  description: z.string(),
  created_at: z.string(),
  entries: z.array(
    z.object({
      id: z.number().int(),
      account: z.string(),
      currency: z.string(),
      debit: z.number().int().nullable(),
      credit: z.number().int().nullable(),
    }),
  ),
});

export const CreateEndpointBody = z.strictObject({
  url: z.url({ protocol: /^https?$/ }),
  enabled_events: z.array(z.enum(PAYMENT_EVENT_TYPES as [string, ...string[]])).default([]).describe("Empty = all events"),
  description: z.string().max(500).nullish(),
});

export const ReplayBody = z.strictObject({ endpoint_id: Uuid.optional() }).nullish();

export const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });
