# Consistency model

LedgerLab has two consistency zones with a hard line between them: the
Postgres transaction commit.

```
           strongly consistent                 │        eventually consistent
  (inside one Postgres transaction)            │   (after commit, via the outbox)
                                               │
  payment status + amounts + version           │   webhook HTTP delivery
  refund rows                                  │   webhook retries and backoff
  ledger transactions and entries              │   manual replays
  outbox event + delivery rows                 │   the consumer's own copy of payment state
  idempotency key + stored response            │
```

## Strong consistency: correct at the moment of commit

| Data | Why it cannot be eventual | Mechanism |
|---|---|---|
| Payment balances (`authorized`, `captured`, `refunded`) | A refund decision reads them. A stale read is a double refund. | Row lock (`FOR UPDATE`) + CHECK constraints |
| Refund limits | Same. `refunded_amount <= captured_amount` must hold for every reader, always. | CHECK constraint, evaluated per row at write time |
| Ledger entries | The books must balance at every instant, not "after the reconciliation job". | Same transaction as the payment change; deferred balance triggers at COMMIT |
| State transitions | Two transitions from the same state (capture vs cancel) must not both win. | Row lock + trigger-enforced transition graph + `version = version + 1` |
| Idempotency records | A retry that arrives 1ms after commit must see the key, or it executes twice. | Same transaction; primary-key uniqueness |
| Outbox event existence | "Event exists" must mean "change committed", or consumers hear about rolled-back changes. | Same transaction |

A client that gets a `200` from a capture can immediately `GET` the payment,
its ledger, or its events and will see all of them. Reads go to the same
primary that took the write.

## Eventual consistency: correct later

| Data | Why eventual is acceptable | Bound |
|---|---|---|
| Webhook delivery | The consumer is another system on the other side of a network. We cannot make its state change atomically with ours, and we must not hold our transaction open while it responds. | Usually milliseconds (NOTIFY wake-up). Under failure, the backoff schedule: with defaults (base 1s, cap 5m, 8 attempts) roughly 1 to 3 minutes before giving up, then manual replay. |
| Webhook retries | Same. | `WEBHOOK_MAX_ATTEMPTS` |
| Consumer's view of a payment | It is derived from webhooks, so it inherits their delays, duplicates and reordering. | Converges once any event with the latest `payment_version` is processed. |

The API is always the source of truth. A consumer unsure of its state can
`GET /payments/:id` at any time.

## How a consumer converges

Webhooks are at-least-once and unordered. A consumer that follows the rules
in [webhooks.md](webhooks.md) (dedupe on `webhook-id`, apply only newer
`payment_version`) converges to the API's state regardless of duplicates,
retries, replays or reordering, as long as the newest event is eventually
delivered. Demo G shows `payment.refunded` (v4) arriving before
`payment.captured` (v3); the consumer applies v4 and ignores v3.

## Failure behaviour at the boundary

| Failure | Strong side | Eventual side |
|---|---|---|
| Process crash before COMMIT | Everything rolled back, including the idempotency key. Retry executes. | No event, no delivery. |
| Process crash after COMMIT, before HTTP response | Committed. Retry with the same key replays the stored response. | Event committed; worker delivers it. |
| Worker crash after claim | Unaffected. | Lease expires; another worker retries. Attempt logged as `LEASE_EXPIRED`. |
| Worker crash after consumer received the webhook | Unaffected. | Redelivered after lease expiry; consumer dedupes. |
| Consumer down | Unaffected; payments keep committing. | Deliveries back off and retry; `FAILED` after max attempts; replay later. |
| Postgres down | API returns 5xx; nothing commits; `/ready` reports not ready. | Workers' claims fail; they log and keep polling. Nothing is lost because nothing was dequeued. |

## What we do not attempt

- Read-your-writes across replicas (there are no replicas).
- Exactly-once delivery to consumers (impossible across a network without the
  consumer's cooperation; we provide what it needs to dedupe instead).
- Ordering across payments. Versions are per payment; there is no global
  sequence.
