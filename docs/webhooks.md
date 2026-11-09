# Webhooks

## Registering an endpoint

```http
POST /webhook-endpoints
{ "url": "https://example.com/hooks/ledgerlab", "enabled_events": ["payment.captured", "payment.refunded"] }
```

`enabled_events: []` (the default) subscribes to everything. The response
contains `secret` (`whsec_...`). It is shown once and never returned again.

Event types: `payment.created`, `payment.authorized`, `payment.failed`,
`payment.captured`, `payment.partially_refunded`, `payment.refunded`,
`payment.canceled`.

## What a delivery looks like

```http
POST /hooks/ledgerlab
content-type: application/json
user-agent: LedgerLab-Webhooks/1.0
webhook-id: 6f1c0b8e-6a1e-4a57-8f0e-0b6c3d0f3a11
webhook-timestamp: 1791414000
webhook-signature: v1,<base64 HMAC-SHA256>
webhook-attempt: 2

{
  "id": "6f1c0b8e-6a1e-4a57-8f0e-0b6c3d0f3a11",
  "type": "payment.refunded",
  "created_at": "2026-10-07T21:40:00.123Z",
  "payment_id": "0b9a...",
  "payment_version": 4,
  "data": { "object": { "id": "0b9a...", "status": "REFUNDED", "version": 4, "captured_amount": 10000, "refunded_amount": 10000, "...": "..." } },
  "delivery": { "id": "c3d1...", "attempt": 2 }
}
```

- `id` / `webhook-id`: the **event** id. Identical across retries, worker
  crash redeliveries and manual replays. This is the dedupe key.
- `payment_version`: monotonic per payment. This is the ordering key.
- `data.object`: a full snapshot of the payment *at that version*.
- `delivery.attempt` / `webhook-attempt`: informational. Do not dedupe on it.
- `created_at`: informational. **Do not order by it.** It is the start time of
  the database transaction, and a transaction that started earlier can commit
  later (see [transactions.md](transactions.md#what-the-system-does-not-guarantee)).

## Verifying the signature

The scheme is [Standard Webhooks](https://www.standardwebhooks.com):

```
signed_content = webhook_id + "." + webhook_timestamp + "." + raw_request_body
expected       = base64( HMAC_SHA256( base64decode(secret without "whsec_"), signed_content ) )
header         = "v1," + expected        (several space-separated during secret rotation)
```

Steps for a consumer:

1. Read the **raw** body bytes. Do not parse and re-serialize JSON first;
   whitespace or key order changes break the MAC.
2. Reject if any of the three headers is missing.
3. Reject if `|now - webhook_timestamp| > 300` seconds. This stops an attacker
   from replaying a captured request later.
4. Compute `expected` and compare with each `v1,` entry using a constant-time
   comparison.
5. Only then parse the JSON.

Reference implementation: `verify()` in
[`src/webhooks/signing.ts`](../src/webhooks/signing.ts). In Node:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyLedgerLab(secret: string, headers: Record<string, string>, rawBody: string): boolean {
  const id = headers["webhook-id"], ts = headers["webhook-timestamp"], sig = headers["webhook-signature"];
  if (!id || !ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
  return sig.split(" ").some((part) => {
    const [version, value] = part.split(",", 2);
    const given = Buffer.from(value ?? "", "base64");
    return version === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

## Delivery semantics

- **At least once.** The same event can arrive more than once: after a retry
  whose first attempt actually succeeded but timed out on our side, after a
  worker crashed between sending and recording, or after a manual replay.
- **No ordering guarantee.** A failed `payment.captured` waits for its retry
  while a later `payment.refunded` is delivered immediately.
- **Retries.** Any non-2xx status, timeout (`WEBHOOK_HTTP_TIMEOUT_MS`,
  default 5s) or connection error is retried with exponential backoff:
  `ceiling = min(max, base * 2^(attempt-1))`, delay uniformly random in
  `[ceiling/2, ceiling]`. Defaults: base 1s, max 5m, 8 attempts. Jitter
  prevents every delivery to a recovering consumer from retrying in the same
  instant. Redirects are not followed.
- **After the last attempt** the delivery is `FAILED`. Nothing is retried
  automatically after that.

## Handling duplicates and out-of-order events (consumer side)

The reference consumer is
[`src/consumer/consumer.ts`](../src/consumer/consumer.ts). The rules:

1. **Verify first**, as above. Return 400 on failure.
2. **Dedupe on `webhook-id`.** If you have already processed this event id,
   return 2xx and do nothing. Return 2xx, not 4xx: an error makes us retry
   something you already have.
3. **Apply only newer versions.** Keep `last_version` per payment. If the
   event's `payment_version` is `<= last_version`, it is stale: return 2xx and
   ignore it. Otherwise apply the snapshot and store the new version.
4. **Do steps 2 and 3 atomically** in your own database, e.g.:

   ```sql
   BEGIN;
   INSERT INTO processed_webhooks (event_id) VALUES ($1) ON CONFLICT DO NOTHING;  -- 0 rows: duplicate, stop
   UPDATE local_payments SET status = $3, refunded_amount = $4, version = $2
    WHERE id = $5 AND version < $2;                                              -- 0 rows: stale
   COMMIT;
   ```

5. **Respond quickly.** If processing takes longer than a few seconds, enqueue
   it and return 2xx; otherwise our timeout fires and you get the event again.

Because each event carries the full snapshot, applying only the newest one is
enough to reach the correct final state. If you need every intermediate
transition (e.g. to send one email per partial refund), process events in
`payment_version` order and fetch missing versions from
`GET /payments/:id/events` when you see a gap.

Demos F (duplicate) and G (refund before capture) in `npm run demo` show both
rules working.

## Replay and delivery logs

- `POST /webhook-events/:id/replay` (optional body `{ "endpoint_id": "..." }`,
  optional `Idempotency-Key`) creates a **new** delivery row with
  `origin = 'REPLAY'` and `replay_of` pointing at the previous delivery. The
  event, earlier deliveries and their attempt history are not modified; the
  tables are append-only at the database level.
- `GET /webhook-events/:id` returns the event with every delivery and every
  attempt.
- `GET /webhook-deliveries?status=FAILED&payment_id=...` is the delivery log.
  Each attempt records worker id, outcome (`SUCCEEDED`, `FAILED`,
  `LEASE_EXPIRED`), HTTP status, error text, the first 512 bytes of the
  response, duration and timestamps.

## Worker operation

- `npm run dev` runs a worker inside the API process (`RUN_WORKER=true`).
- `npm run worker` runs a standalone worker. Run several; `FOR UPDATE SKIP
  LOCKED` gives each a disjoint batch.
- A worker that dies holding a lease delays that delivery by at most
  `WEBHOOK_LEASE_MS` (default 30s); another worker then reclaims it and logs
  the lost attempt as `LEASE_EXPIRED`.
- `SIGTERM` stops claiming, finishes in-flight attempts, then exits.
