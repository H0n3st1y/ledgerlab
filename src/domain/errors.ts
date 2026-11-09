export const ERROR_CODES = {
  VALIDATION_ERROR: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  CARD_DECLINED: 402,
  PAYMENT_NOT_FOUND: 404,
  NOT_FOUND: 404,
  INVALID_STATE_TRANSITION: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  CAPTURE_EXCEEDS_AUTHORIZED_AMOUNT: 422,
  REFUND_EXCEEDS_CAPTURED_AMOUNT: 422,
  INVALID_AMOUNT: 422,
  LOCK_TIMEOUT: 503,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class DomainError extends Error {
  readonly httpStatus: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
    this.httpStatus = ERROR_CODES[code];
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };
