# Transaction boundaries

This document says exactly where each database transaction starts and ends,
what is inside it, which rows it locks, and why. It is the document to read
before changing anything in `src/payments`, `src/idempotency`, `src/ledger`
or `src/workers`.

All transactions go through one helper, `withTransaction` in
[`src/db/transaction.ts`](../src/db/transaction.ts). It does `BEGIN`, sets
`lock_timeout` (10s) and `statement_timeout` (15s) with `SET LOCAL`, runs the
callback on a single pooled connection, and `COMMIT`s. Any exception rolls
back. No code path ever holds two pooled connections at once, which rules out
pool-exhaustion deadlocks (a request holding connection A while waiting for
connection B).

## Isolation level

Everything runs at Postgres' default, **READ COMMITTED**, plus explicit row
locks. Two properties of READ COMMITTED that the design leans on:

1. Each *statement* sees a fresh snapshot. So after a statement waits on a
   lock, the next statement sees whatever the lock holder committed.
2. `SELECT ... FOR UPDATE` that waits on a row re-reads the **latest committed
   version** of that row when the lock is granted, not the version from the
   start of the statement.

Why not SERIALIZABLE? It would also be correct, but it reports conflicts by
aborting with `40001 serialization_failure`, so every write path would need a
retry loop, and under contention (20 concurrent captures of one payment) most
attempts would abort and retry. With explicit locks the conflicting requests
simply queue and each gets a deterministic answer. The tradeoff is that we
must get the locking right ourselves; the database will not catch a forgotten
lock for us. Two backstops exist for exactly that case (see "Defence in
depth" below).

## Payment commands: authorize, capture, refund, cancel

Code: `executePaymentCommand` in
[`src/payments/payment-service.ts`](../src/payments/payment-service.ts) and
`executeIdempotent` in
[`src/idempotency/idempotency.ts`](../src/idempotency/idempotency.ts).

```
BEGIN                                                    -- READ COMMITTED
  INSERT INTO idempotency_keys (key, ..., 'PROCESSING')  -- (1) claim the key
    ON CONFLICT (key) DO NOTHING
  SAVEPOINT handler
  SELECT * FROM payments WHERE id = $1 FOR UPDATE        -- (2) lock the payment
  -- (3) pure state machine decides: next state, event type, ledger intent
  UPDATE payments SET ..., version = version + 1         -- (4)
   WHERE id = $1 AND version = $expected
  INSERT INTO refunds ...                                -- (5) refunds only
  INSERT INTO ledger_transactions ...                    -- (6) journal header
  INSERT INTO ledger_entries ... (2 or 4 lines)          --     journal lines
  INSERT INTO webhook_events ...                         -- (7) outbox event
  INSERT INTO webhook_deliveries SELECT ... endpoints    --     one per endpoint
  SELECT pg_notify('webhook_deliveries', ...)            --     wake workers on commit
  UPDATE idempotency_keys SET status, response_code,     -- (8) store the response
         response_body
COMMIT                                                   -- (9) deferred checks run here
```

What must be atomic, and why each piece is inside:

| Step | If it were outside the transaction... |
|---|---|
| (1) idempotency key | A crash between "mutation committed" and "key recorded" would let a retry execute the mutation a second time. |
| (4) payment update | It is the mutation. |
| (5) refund row | A refund without a payment change (or vice versa) breaks `SUM(refunds) = refunded_amount`. |
| (6) ledger | A committed payment change with no journal entry is exactly the "money moved but the books don't show it" bug the ledger exists to prevent. |
| (7) outbox event | Event-before-commit can announce a change that rolls back. Event-after-commit can be lost if the process dies in between. Only same-transaction gives "event exists if and only if the change committed". |
| (8) response | Same reason as (1): the stored response must describe the committed state. |

What is deliberately **outside**: the HTTP webhook call. It is an external
side effect that cannot be rolled back, so it happens later, from the outbox,
in the worker.

### Locks taken

| Lock | Held by | Blocks |
|---|---|---|
| Unique-index entry for `idempotency_keys.key` (uncommitted insert) | Until COMMIT/ROLLBACK | Only a concurrent request with the **same key**. It waits inside its `INSERT ... ON CONFLICT` and then sees the outcome. |
| Row lock (`FOR UPDATE`) on `payments.id` | Until COMMIT/ROLLBACK | Only concurrent commands on the **same payment**. Payments do not contend with each other. |
| `FOR KEY SHARE` on referenced rows (`ledger_accounts`, `webhook_endpoints`, `payments` via FKs) | Until COMMIT | Nothing in practice: KEY SHARE only conflicts with deletes or key changes, which never happen. |

There are no mutable balance rows (balances are derived from the journal),
so there are no hot rows shared across payments.

### Deadlock freedom

Every payment transaction acquires at most one idempotency key and at most one
payment row, always in that order (key, then payment). Webhook workers lock
only `webhook_deliveries` rows, which payment transactions never lock (they
only insert new ones). With a single global order and at most one lock of each
kind, a wait-for cycle cannot form. A deadlock would surface as a
`40P01 deadlock_detected` error and a 500, which the concurrency suite would
catch.

### Where the races are, and what stops them

**Two refunds on the same payment (the $70 + $70 on $100 case).** Both
transactions reach `SELECT ... FOR UPDATE`. One gets the lock; the other
waits. The first commits `refunded_amount = 7000`. The second is then granted
the lock and, because of READ COMMITTED rule 2 above, reads
`refunded_amount = 7000`, so the state machine sees only $30 refundable and
rejects with `REFUND_EXCEEDS_CAPTURED_AMOUNT`. No arithmetic is ever done on a
stale read.

**Twenty captures at once.** Same mechanism: the first wins, the other 19
read `status = CAPTURED` after waiting and get `INVALID_STATE_TRANSITION`.

**Fifty requests with the same Idempotency-Key.** The first `INSERT` creates
an uncommitted index entry. The other 49 block on that entry inside their own
`INSERT ... ON CONFLICT DO NOTHING`. When the first commits, each waiter's
insert becomes a no-op, and its next statement (`SELECT ... FROM
idempotency_keys`) sees the committed row and returns the stored response. If
the first had rolled back instead, exactly one waiter's insert would succeed
and it would execute. Either way: one execution.

**Client timeout after commit.** The transaction commits, then the response
is lost. The retry carries the same key, finds the committed `SUCCEEDED` row,
and replays the stored body. See `tests/concurrency` "Demo A".

### Defence in depth

The row lock is the mechanism. Two independent backstops catch a future
change that forgets it:

1. `UPDATE payments ... WHERE id = $1 AND version = $expected`. Without the
   lock, the loser of a race updates zero rows and the transaction aborts.
2. The `payments_guard_update` trigger refuses any update where
   `NEW.version <> OLD.version + 1`, any illegal status edge, and any amount
   that decreases.

This was tested by deleting the protections one at a time and re-running the
three-way refund race:

| Configuration | Result |
|---|---|
| Lock + version check + trigger | 2 succeed, 1 clean `422 REFUND_EXCEEDS_CAPTURED_AMOUNT` |
| No `FOR UPDATE` | 2 succeed, 1 `500` (version check fails the loser) |
| No `FOR UPDATE`, no version check | 2 succeed, 1 `500` (trigger: "version must increase by exactly 1") |

Money is never double-refunded in any configuration, but only the locked
version gives the client a correct, actionable error. That is the reason the
lock is the primary mechanism and not an optimization.

### Business rejections vs. failures

The state machine runs after `SAVEPOINT handler`. If it rejects (refund too
large, illegal transition, payment not found), the code rolls back to the
savepoint, stores the 4xx response on the idempotency key, and commits. A
retry with that key gets the same 4xx even if the payment has since changed
state. That makes the key's meaning stable: "this request already has a final
answer".

Anything else (a bug, a lock timeout, an injected failure, a lost connection)
rolls back the **whole** transaction, including the key. Nothing is recorded,
so the client can retry the same key and it will execute.

Request validation (bad JSON, float amounts, unknown fields) happens before the
transaction starts and is never recorded.

## Creating a payment

```
BEGIN
  INSERT idempotency_keys (PROCESSING) ON CONFLICT DO NOTHING
  INSERT payments (status CREATED, version 1)
  INSERT webhook_events (payment.created, version 1) + deliveries
  UPDATE idempotency_keys SET response
COMMIT
```

No ledger transaction: creating a payment moves no money and places no hold.
No row lock is needed because the row is new; the key is the only point of
contention.

## Ledger writes

`postLedgerTransaction` in
[`src/ledger/ledger-repository.ts`](../src/ledger/ledger-repository.ts) never
opens its own transaction. It is always called with the caller's open
transaction, which is how "payment change and journal entry commit together"
is enforced structurally rather than by convention.

Balance is checked three times:

1. In TypeScript before inserting (`isBalanced`).
2. By `INSERT ... SELECT` returning exactly as many rows as journal lines
   (catches a missing account for the currency).
3. By two `DEFERRABLE INITIALLY DEFERRED` constraint triggers that run at
   COMMIT and reject any ledger transaction with fewer than two entries or
   with `SUM(debit) <> SUM(credit)`. Deferred, so lines can be inserted one at
   a time inside the transaction; checked once all of them are in.

`UNIQUE (payment_id, payment_version)` on `ledger_transactions` means a state
change can have at most one journal entry, no matter what the application
does.

## Webhook event creation

Covered above: same transaction as the payment change, step (7). Fan-out to
endpoints happens in the same statement batch, so an endpoint registered
before the commit gets exactly one original delivery
(`UNIQUE (event_id, endpoint_id) WHERE origin = 'EVENT'`). `pg_notify` is
transactional in Postgres: the notification is delivered only if the
transaction commits.

## Webhook worker transactions

Code: [`src/workers/webhook-worker.ts`](../src/workers/webhook-worker.ts).
Three steps per attempt, and the HTTP call is never inside a transaction.

**Claim** (one short transaction):

```
BEGIN
  SELECT id, status, attempt_count, ... FROM webhook_deliveries
   WHERE (status = 'PENDING' AND next_attempt_at <= now())
      OR (status = 'DELIVERING' AND locked_until < now())     -- expired lease
   ORDER BY next_attempt_at LIMIT $batch
   FOR UPDATE SKIP LOCKED
  -- for each expired lease: INSERT attempt (LEASE_EXPIRED); FAILED if out of attempts
  UPDATE webhook_deliveries
     SET status = 'DELIVERING', attempt_count = attempt_count + 1,
         locked_by = $worker, locked_until = now() + lease
   WHERE id = ANY($claimed)
COMMIT
```

`SKIP LOCKED` makes concurrent claimers take disjoint rows instead of queueing
behind each other. The lease (`locked_by`, `locked_until`) is what keeps the
claim after this short transaction commits.

**Send**: sign and POST, with an HTTP timeout shorter than the lease
(enforced at startup).

**Complete** (one short transaction):

```
BEGIN
  UPDATE webhook_deliveries SET status = DELIVERED | PENDING (+backoff) | FAILED, ...
   WHERE id = $1 AND status = 'DELIVERING'
     AND locked_by = $worker AND attempt_count = $n          -- fencing
  INSERT webhook_delivery_attempts (...)                      -- only if the UPDATE matched
COMMIT
```

`attempt_count` is a fencing token. If this worker stalled past its lease and
another worker reclaimed the row, `attempt_count` has moved on, the `UPDATE`
matches nothing, and the stale worker's result is discarded instead of
overwriting the new owner's. Tested in "fencing: a worker whose lease expired
mid-send cannot overwrite the new owner's result".

Lease times come from the database clock (`now()`) both when set and when
compared, so worker clock skew does not matter.

## Replay

```
BEGIN
  [optional idempotency key, same as above]
  SELECT event
  INSERT webhook_deliveries (origin = 'REPLAY', replay_of = previous delivery)
COMMIT
```

Only inserts. The event and every earlier delivery and attempt row are left
exactly as they were (`webhook_events` and `webhook_delivery_attempts` have
append-only triggers).

## What the system guarantees

- A payment change, its refund row, its journal entry, its outbox event and
  its idempotent response commit together or not at all.
- At most one execution per Idempotency-Key, including under concurrency and
  after a client timeout.
- `amount >= authorized >= captured >= refunded >= 0` at every commit,
  enforced by the database.
- Every ledger transaction is balanced and has at least two lines, enforced at
  COMMIT by the database.
- Ledger, events, refunds and attempt logs are never updated or deleted.
- Every committed state change produces exactly one event, and each event
  carries a per-payment monotonic `payment_version`.
- Webhooks are delivered **at least once** per (event, endpoint) unless
  `max_attempts` is exhausted, after which the delivery is `FAILED` and can be
  replayed.

## What the system does not guarantee

- **Exactly-once webhook delivery.** A worker can crash after the consumer
  received the request and before it recorded success. The event is then sent
  again. Consumers must dedupe on `webhook-id`.
- **Delivery order.** Retries and concurrent workers reorder events. Consumers
  order by `payment_version`.
- **Event timestamps that match commit order.** `created_at` is the
  transaction's start time (`now()`). A transaction that began earlier but
  waited for the payment lock commits later with an *earlier* timestamp, so
  `payment.refunded` can carry a `created_at` before the `payment.captured` it
  follows. `payment_version` is the only reliable ordering key.
- **Atomicity with a real card network.** Authorization calls a simulated,
  in-process network. A real one is an external side effect before our commit
  and needs the multi-phase idempotency design described in
  [architecture.md](architecture.md#idempotency).
- **Idempotency key expiry.** Keys are kept forever. A production system would
  expire them (Stripe uses 24h) with a periodic delete on `created_at`, which
  the `idempotency_keys_created_at_idx` index exists for.
- **Durability beyond one Postgres primary.** No replicas, no cross-region
  failover. A failover to an asynchronous replica can lose the last committed
  transactions, and idempotency keys with them.
