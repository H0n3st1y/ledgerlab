// Tiny in-process counters exposed in Prometheus text format at GET /metrics.
// Enough to watch a demo (replays, retries, lease expiries) without pulling in
// a metrics stack. Per-process: the API and a standalone worker report separately.

type Labels = Record<string, string>;

export class Metrics {
  private counters = new Map<string, { help: string; values: Map<string, number> }>();

  inc(name: string, labels: Labels = {}, by = 1): void {
    const c = this.counters.get(name) ?? { help: HELP[name] ?? name, values: new Map() };
    const key = labelKey(labels);
    c.values.set(key, (c.values.get(key) ?? 0) + by);
    this.counters.set(name, c);
  }

  get(name: string, labels: Labels = {}): number {
    return this.counters.get(name)?.values.get(labelKey(labels)) ?? 0;
  }

  render(): string {
    const out: string[] = [];
    for (const [name, c] of [...this.counters.entries()].sort()) {
      out.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
      for (const [k, v] of c.values) out.push(`${name}${k} ${v}`);
    }
    return out.join("\n") + "\n";
  }
}

function labelKey(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? `{${entries.map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, "_")}"`).join(",")}}` : "";
}

const HELP: Record<string, string> = {
  ledgerlab_payment_transitions_total: "Committed payment state transitions",
  ledgerlab_payment_rejections_total: "Payment commands rejected by the state machine or amount rules",
  ledgerlab_idempotent_replays_total: "Requests answered from a stored idempotent response",
  ledgerlab_webhook_attempts_total: "Webhook HTTP attempts by outcome",
  ledgerlab_webhook_lease_expired_total: "Deliveries reclaimed after a worker lease expired",
  ledgerlab_webhook_lost_lease_total: "Attempts whose result was discarded because the lease was lost",
};
