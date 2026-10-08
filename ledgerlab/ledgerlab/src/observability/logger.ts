import pino, { type Logger } from "pino";

export type { Logger };

// Secrets that must never reach logs. Signing secrets, signatures and any
// auth header are redacted wherever they appear in a logged object.
const REDACT = [
  "secret",
  "*.secret",
  "*.*.secret",
  "req.headers.authorization",
  'req.headers["webhook-signature"]',
  "headers.authorization",
  'headers["webhook-signature"]',
];

export function createLogger(level: string, base: Record<string, unknown> = {}): Logger {
  return pino({
    level,
    base: { service: "ledgerlab", ...base },
    redact: { paths: REDACT, censor: "[redacted]" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
