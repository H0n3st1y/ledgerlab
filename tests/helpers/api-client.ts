import { randomUUID } from "node:crypto";

export type ApiResponse<T = any> = { status: number; body: T; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Minimal HTTP client over real sockets, so concurrency and timeouts are real. */
export class ApiClient {
  constructor(readonly baseUrl: string) {}

  async request<T = any>( // eslint-disable-line @typescript-eslint/no-explicit-any
    method: string,
    path: string,
    body?: unknown,
    opts: { key?: string | null; timeoutMs?: number } = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (opts.key) headers["idempotency-key"] = opts.key;
    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON (metrics) */
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  get<T = any>(path: string) { // eslint-disable-line @typescript-eslint/no-explicit-any
    return this.request<T>("GET", path);
  }

  /** POST with an Idempotency-Key. A fresh key is generated unless one is given (or null for none). */
  post<T = any>(path: string, body?: unknown, opts: { key?: string | null; timeoutMs?: number } = {}) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const key = opts.key === undefined ? randomUUID() : opts.key;
    return this.request<T>("POST", path, body, { ...opts, key });
  }

  async createPayment(amount = 10_000, extra: Record<string, unknown> = {}) {
    const res = await this.post("/payments", { amount, currency: "USD", ...extra });
    if (res.status !== 201) throw new Error(`create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; version: number; status: string };
  }

  async authorizedPayment(amount = 10_000) {
    const p = await this.createPayment(amount);
    const res = await this.post(`/payments/${p.id}/authorize`);
    if (res.status !== 200) throw new Error(`authorize failed: ${JSON.stringify(res.body)}`);
    return res.body as { id: string; status: string };
  }

  async capturedPayment(amount = 10_000) {
    const p = await this.authorizedPayment(amount);
    const res = await this.post(`/payments/${p.id}/capture`);
    if (res.status !== 200) throw new Error(`capture failed: ${JSON.stringify(res.body)}`);
    return res.body as { id: string; status: string; captured_amount: number };
  }
}
