# Failure scenarios

Every scenario here is reproducible three ways: an automated test, the
`npm run demo` script (Demos A to G), and by hand against `npm run dev` using
the `/dev/failures` API or the dashboard.

## Failure points

Armed with `POST /dev/failures` (requires `ENABLE_DEV_TOOLS=true`):

```bash
curl -X POST localhost:3000/dev/failures -H 'content-type: application/json' \
  -d '{"point":"api.after_commit","times":1,"match":{"payment_id":"<id>"}}'
curl localhost:3000/dev/failures          # points, armed rules, recent firings
curl -X DELETE localhost:3000/dev/failures
```

| Point | Where it fires | Simulates |
|---|---|---|
| `payment.before_commit` | After every write in a payment transaction, before COMMIT | Database transaction rollback, process death before commit |
| `api.after_commit` | After COMMIT, before the HTTP response; destroys the socket | Request timeout after the server committed |
| `worker.after_claim` | After the claim transaction, before HTTP | Worker crash after selecting a job |
| `worker.after_send` | After the consumer responded, before recording the result | Worker crash after delivery, before acknowledgment |
| `worker.duplicate_send` | Sends the same request twice | Duplicated webhook |
| `worker.delay_send` | Sleeps `delay_ms` before sending | Delayed webhook; with a delay longer than the lease, a stalled worker |

`match` narrows a rule to a `payment_id`, `event_type` or `operation`
(`create`, `authorize`, `capture`, `refund`, `cancel`, `replay`).

Consumer-side failures are configured on the sandbox consumer
(`POST /sandbox/consumer/config`):

| Setting | Simulates |
|---|---|
| `{"failNext": 3, "failStatus": 500}` | Consumer returning 500 |
| `{"delayMs": 7000}` | HTTP timeout (longer than `WEBHOOK_HTTP_TIMEOUT_MS`) |
| `{"failEventType": "payment.captured", "failEventTypeTimes": 1}` | One event type failing, which produces out-of-order delivery |

## Scenarios

### 1. Duplicated API request
**What happens.** A client sends the same capture twice (double click, retry
loop, proxy retry).
**Outcome.** Same Idempotency-Key: the second returns the stored response with
`idempotent-replayed: true`, no second mutation. Different keys: the second
is a new request and gets `409 INVALID_STATE_TRANSITION`.
**Evidence.** `tests/integration/idempotency.test.ts`,
`tests/concurrency/payments-concurrency.test.ts` (20 and 50 concurrent).

### 2. Request timeout after the server committed (Demo A)
**What happens.** Capture commits; the connection drops before the response.
The client does not know whether it worked.
**Outcome.** Retrying with the same key replays the original `200`. One
capture, one ledger transaction, one `payment.captured` event.
**Evidence.** "Demo A" tests in `tests/concurrency`, including ten concurrent
retries racing the original.

### 3. Database transaction rollback
**What happens.** Something fails after the payment row, refund, ledger lines
and outbox event were written but before COMMIT.
**Outcome.** None of them exist afterwards, and neither does the idempotency
key, so retrying the same key executes normally.
**Evidence.** "a rolled-back transaction leaves no payment change, ledger,
event, or key behind" in `tests/integration/idempotency.test.ts`. The
randomized workload in `tests/invariants` injects rollbacks into ~5% of
operations and then checks every invariant.

### 4. Concurrent refunds (Demo B)
**What happens.** Three $40 refunds race on a $100 capture.
**Outcome.** Two succeed, one gets `422 REFUND_EXCEEDS_CAPTURED_AMOUNT`.
Refunded total is $80. See [transactions.md](transactions.md) for why, and
for what happens when the lock is removed.

### 5. Consumer returns 500
**Outcome.** Retried with exponential backoff; each attempt is logged with its
status. Succeeds once the consumer recovers, or becomes `FAILED` after
`max_attempts`.
**Evidence.** "retries 500s with backoff and records every attempt", "gives up
after max_attempts".

### 6. HTTP timeout to the consumer
**Outcome.** The attempt is aborted at `WEBHOOK_HTTP_TIMEOUT_MS`, logged as
`timeout after Nms`, and retried. If the consumer actually processed it, the
retry is a duplicate it must dedupe.
**Evidence.** "treats a slow consumer as a timeout and retries".

### 7. Worker crash after claiming a job (Demo D)
**What happens.** The worker claimed the delivery (status `DELIVERING`, lease
set) and died.
**Outcome.** Nothing happens until the lease expires. Then any worker
reclaims it, records attempt 1 as `LEASE_EXPIRED` with the dead worker's id,
and delivers it as attempt 2.
**Evidence.** "Demo D" in `tests/integration/webhooks.test.ts`.

### 8. Worker crash after delivery, before acknowledgment (Demo F)
**What happens.** The consumer received and processed the webhook; the worker
died before marking it delivered.
**Outcome.** After the lease expires it is delivered again. The consumer sees
the same `webhook-id` and does not process it twice.
**Evidence.** "Demo F" test; consumer log shows `processed` then `duplicate`.

### 9. Stalled worker (lease expires mid-request)
**What happens.** A worker pauses (GC, slow network) longer than its lease.
Another worker reclaims and delivers. The first one wakes up and tries to
record its result.
**Outcome.** Its fenced `UPDATE ... WHERE attempt_count = $n` matches nothing;
the result is discarded and `ledgerlab_webhook_lost_lease_total` increments.
The consumer may receive two copies.
**Evidence.** "fencing: a worker whose lease expired mid-send cannot overwrite
the new owner's result".

### 10. Duplicated webhook
**Outcome.** Same as 8: deduped by `webhook-id`.
**Evidence.** "an injected duplicate send is deduplicated by the consumer".

### 11. Out-of-order webhooks (Demo G)
**What happens.** `payment.captured` (v3) fails once; the refund happens and
`payment.refunded` (v4) is delivered; then the capture retry arrives.
**Outcome.** The consumer has already applied v4, recognizes v3 as stale,
acknowledges it with 2xx and ignores it. Its view stays `REFUNDED`.
**Evidence.** "Demo G" test.

### 12. Webhook replay (Demo E)
**What happens.** A delivery exhausted its attempts while the consumer was
down. An operator replays it.
**Outcome.** A new delivery row (`origin: REPLAY`, `replay_of: <old id>`) is
created and delivered. The failed delivery and its attempts are unchanged.
**Evidence.** "Demo E" test compares the attempt rows before and after.

### 13. Worker restart with pending deliveries
**Outcome.** Pending rows are in Postgres, not in worker memory. A new worker
picks them up.
**Evidence.** "a restarted worker picks up deliveries left pending by a
stopped one".

## Subtle issues found while building this

- **`created_at` does not follow commit order.** Event timestamps come from
  `now()`, the transaction *start* time. A transaction that starts first but
  waits on the payment lock commits second with the earlier timestamp. Only
  `payment_version` orders events.
- **Fencing does not stop duplicate sends.** It stops a stale worker from
  overwriting state, but the stale worker's HTTP request still went out. This
  is why consumer dedupe is mandatory, not optional.
- **Uniform random test data misses boundaries.** The property test only
  caught a planted off-by-one after the generator started producing amounts
  relative to the remaining balance. See
  [architecture.md](architecture.md#testing-strategy).
- **Business rejections are cached by idempotency.** A refund attempted while
  the payment was still `AUTHORIZED` gets a `409`. Retrying that same key
  after capture still returns the `409`, by design: the key already has a
  final answer. Clients must use a new key for a new attempt.
- **Removing the row lock does not over-refund here, but the error is wrong.**
  The version predicate and the trigger both catch the lost update, as
  `500`s. The lock is what turns a race into a correct `422`.
