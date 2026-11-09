// Development-only failure injection. Code paths that matter for reliability
// call `failures.take(point, ctx)` at the exact spot where a real failure
// would hurt; tests, the /dev API and the dashboard arm those points.
//
// Consumer-side failures (500s, slow responses, timeouts) are configured on
// the sandbox consumer instead (src/consumer), because that is where they
// happen in reality.

export const FAILURE_POINTS = {
  "payment.before_commit":
    "Throw inside the payment transaction after every write (payment, ledger, outbox, idempotency) but before COMMIT.",
  "api.after_commit":
    "Commit the transaction, then destroy the HTTP connection without responding. The client sees a timeout/reset.",
  "worker.after_claim": "Worker crashes right after claiming a delivery, before any HTTP request is sent.",
  "worker.after_send": "Worker crashes after the consumer accepted the webhook, before recording the result.",
  "worker.duplicate_send": "Worker sends the same webhook to the consumer twice.",
  "worker.delay_send": "Worker sleeps delayMs before sending (simulates a slow network path).",
} as const;

export type FailurePoint = keyof typeof FAILURE_POINTS;

export type FailureMatch = {
  eventType?: string;
  paymentId?: string;
  operation?: string;
};

export type FailureRule = {
  id: number;
  point: FailurePoint;
  /** How many more times this rule fires. */
  remaining: number;
  match?: FailureMatch;
  delayMs?: number;
};

export type FailureContext = FailureMatch;

/** Thrown to emulate a process dying at a precise point. Nothing after it runs. */
export class SimulatedCrash extends Error {
  constructor(point: FailurePoint) {
    super(`simulated crash at ${point}`);
    this.name = "SimulatedCrash";
  }
}

export class InjectedFailure extends Error {
  constructor(point: FailurePoint) {
    super(`injected failure at ${point}`);
    this.name = "InjectedFailure";
  }
}

export class FailureInjector {
  private rules: FailureRule[] = [];
  private nextId = 1;
  readonly fired: { point: FailurePoint; at: Date; ctx: FailureContext }[] = [];

  constructor(readonly enabled: boolean) {}

  arm(point: FailurePoint, opts: { times?: number; match?: FailureMatch; delayMs?: number } = {}): FailureRule {
    if (!this.enabled) throw new Error("failure injection is disabled");
    if (!(point in FAILURE_POINTS)) throw new Error(`unknown failure point ${point}`);
    const rule: FailureRule = { id: this.nextId++, point, remaining: opts.times ?? 1, match: opts.match, delayMs: opts.delayMs };
    this.rules.push(rule);
    return rule;
  }

  /** Returns and consumes a matching armed rule, or null. Cheap no-op when disabled. */
  take(point: FailurePoint, ctx: FailureContext = {}): FailureRule | null {
    if (!this.enabled || this.rules.length === 0) return null;
    const rule = this.rules.find((r) => r.point === point && r.remaining > 0 && matches(r.match, ctx));
    if (!rule) return null;
    rule.remaining -= 1;
    if (rule.remaining === 0) this.rules = this.rules.filter((r) => r !== rule);
    this.fired.push({ point, at: new Date(), ctx });
    if (this.fired.length > 200) this.fired.shift();
    return rule;
  }

  list(): FailureRule[] {
    return this.rules.map((r) => ({ ...r }));
  }

  clear(): void {
    this.rules = [];
  }
}

function matches(m: FailureMatch | undefined, ctx: FailureContext): boolean {
  if (!m) return true;
  return (
    (m.eventType === undefined || m.eventType === ctx.eventType) &&
    (m.paymentId === undefined || m.paymentId === ctx.paymentId) &&
    (m.operation === undefined || m.operation === ctx.operation)
  );
}
