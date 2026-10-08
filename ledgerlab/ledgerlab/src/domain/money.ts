// Money is always an integer number of minor units (cents). No floats, ever.
// JS numbers are exact for integers up to 2^53 - 1 (~$90 trillion in cents),
// and the int8 parser in src/db/pool.ts refuses anything larger.

export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/** Largest single payment we accept: $1,000,000.00. Keeps sums far from 2^53. */
export const MAX_AMOUNT = 100_000_000;

export function isValidAmount(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= MAX_AMOUNT;
}

/** For logs and the dashboard only. Never parse this back. */
export function formatMinor(amount: number, currency: string): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")} ${currency}`;
}
