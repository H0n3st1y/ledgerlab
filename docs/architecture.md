# Architecture and engineering decisions

LedgerLab is a modular monolith: one Node.js process type (API, with an
optional in-process webhook worker), one standalone worker entry point, and
one PostgreSQL database that is the source of truth for everything.

```
src/
  domain/         pure logic: money, payment state machine, error codes
  payments/       payment service (transaction orchestration), repository, card-network stub
  idempotency/    key claim + response storage, request hashing
  ledger/         journal postings, ledger repository, SQL invariant checks
  webhooks/       outbox writer, signing, backoff, delivery repository
  workers/        webhook delivery worker (claim / send / complete)
  failures/       failure-injection points
  consumer/       reference webhook consumer (dedupe + version ordering)
  api/            Fastify routes, schemas, serializers, error mapping
  observability/  pino logger with redaction, tiny Prometheus counters
  db/             pool, transaction helper, migrator, SQL migrations
  dashboard/      single-file developer dashboard
```

Dependencies point inward: `domain` imports nothing from the rest;
`payments` orchestrates `domain`, `ledger`, `webhooks` and `idempotency`;
`api` is the only place that knows about HTTP.

Each section below follows the same shape: the problem, the options, what
was chosen, and what it costs.

---

## Why one Postgres and no other infrastructure

**Problem.** Payments need atomic multi-row writes (payment, ledger, outbox,
idempotency record), durable queues, uniqueness and locking.

**Alternatives.** Redis for idempotency and locks, Kafka for events, a
separate ledger service.

**Chosen.** Postgres for all of it.

**Tradeoffs.** Every reliability property in this project comes from
committing several things in *one* transaction. The moment idempotency keys
live in Redis or events go straight to Kafka, there are two systems that can
disagree, and the project would need distributed-transaction workarounds
(sagas, reconciliation jobs) to paper over it. The cost is throughput: the
outbox table is a queue on a relational database, which is fine for thousands
of events per second but not millions. When that becomes the bottleneck, the
first step is to put a change-data-capture relay (e.g. Debezium on the WAL)
*behind* the outbox, not to remove the outbox.

---

## Money representation

**Problem.** `0.1 + 0.2 !== 0.3`.

**Chosen.** Integer minor units everywhere (`1025` = $10.25), `bigint`
columns, JSON numbers on the wire. The API rejects non-integers instead of
rounding. Only two-decimal currencies (USD, EUR, GBP) are supported, so
"minor unit" always means 1/100; zero-decimal (JPY) or three-decimal (KWD)
currencies would need a per-currency exponent table.

**Tradeoffs.** JS numbers are exact up to 2^53. The `int8` and `numeric` type
parsers in `src/db/pool.ts` throw instead of silently losing precision past
that, and a single payment is capped at $1,000,000.00 so sums stay far below
it. A system handling larger aggregates would use `bigint` in JS or decimal
strings on the wire.

---

## Payment state machine

```
CREATED ──authorize (approved)──▶ AUTHORIZED ──capture──▶ CAPTURED ──refund──▶ PARTIALLY_REFUNDED ──refund──▶ REFUNDED
   │  └──authorize (declined)──▶ FAILED          │            └──────────── refund (full) ──────────────────▲
   └──────────cancel──────────▶ CANCELED ◀──cancel┘
```

| Command | Allowed from | Result |
|---|---|---|
| authorize | CREATED | AUTHORIZED (approved) or FAILED (declined, `402 CARD_DECLINED`) |
| capture | AUTHORIZED | CAPTURED; `amount <= authorized_amount`; one capture only, remainder released |
| refund | CAPTURED, PARTIALLY_REFUNDED | PARTIALLY_REFUNDED, or REFUNDED when `refunded = captured` |
| cancel | CREATED, AUTHORIZED | CANCELED; releases the hold if there was one |

REFUNDED, CANCELED and FAILED are terminal.

**Problem.** State rules scattered across route handlers drift apart.

**Chosen.** `applyCommand(state, command)` in
`src/domain/payment-state-machine.ts` is a pure function that returns either a
rejection or `{ next state, event type, ledger intent }`. Route handlers
never set a status. The same graph is enforced again by the
`payments_guard_update` trigger, plus CHECK constraints that tie each status
to legal amounts (`CAPTURED` requires `captured_amount > 0`, `REFUNDED`
requires `refunded_amount = captured_amount`, and so on). A test walks all
49 status pairs and asserts the trigger and the TypeScript graph agree.

**Tradeoffs.** The graph exists in two languages. That is deliberate
duplication: the trigger catches application bugs and manual SQL, and the
parity test catches the two drifting apart.

**Single capture.** Like most card processors, a payment is captured once and
any uncaptured remainder is released. Multi-capture would need a captures
table and a different release rule.

---

## Idempotency

**Problem.** Clients retry. Networks drop responses after the server
committed. Two retries can arrive at the same moment.

**Alternatives.**

1. *Redis cache of responses.* Fast, but the key and the mutation are in
   different systems. A crash between "Postgres committed" and "Redis set"
   executes the retry twice. A Redis failover can drop keys.
2. *Postgres, multi-phase* (Brandur Leach's "recovery points" design at
   Stripe): insert the key and commit, do the work in later transactions,
   record progress per phase. Required when the work includes external calls
   that cannot be rolled back.
3. *Postgres, single transaction*: the key row and the mutation commit
   together.

**Chosen.** Option 3. The key is inserted as `PROCESSING` at the start of the
same transaction that performs the mutation, and its response is stored
before `COMMIT`. Concurrency control is the primary key itself: a duplicate
blocks on the uncommitted index entry and then sees the committed outcome
(details in [transactions.md](transactions.md)). A deferred trigger makes it
impossible to commit a key still in `PROCESSING`.

The key is bound to a SHA-256 of `{operation (route template), path params,
body}` with object keys sorted. Same key with a different request is
`409 IDEMPOTENCY_KEY_REUSED`. Headers are excluded because honest retries
differ in request ids and timestamps. Money-moving endpoints require the
header (`400 IDEMPOTENCY_KEY_REQUIRED`), because an un-keyed capture cannot
be retried safely and the API should not offer an unsafe default.

**Tradeoffs.** A duplicate request holds a pooled connection while it waits
for the first one, bounded by the first transaction's duration and by
`lock_timeout`. And option 3 only works because nothing inside the
transaction has external side effects. Authorization calls a *simulated*
card network in-process. With a real network, the authorize path must move
to option 2: commit `PROCESSING` + "network call started", call the network
with its own idempotency key, then commit the result, and have a recovery job
resolve keys stuck in the middle.

---

## Double-entry ledger

**Problem.** A `balance` column that is incremented in place can drift, can
lose updates, and keeps no history of why it changed.

**Alternatives.** Mutable balance columns per account; event-sourced ledger
in another store; append-only journal in Postgres.

**Chosen.** Append-only journal: `ledger_transactions` (one per payment state
change) and `ledger_entries` (the lines). Balances are computed with `SUM` on
read (`GET /ledger/balances`). Entries are never updated or deleted (row
triggers plus a TRUNCATE trigger); a correction would be a new, reversing
transaction.

Chart of accounts (one row per account per currency):

| Account | Type | Normal side | Meaning |
|---|---|---|---|
| `customer_authorization_holds` | memo | debit | Holds placed on cardholder funds |
| `authorization_hold_offset` | memo | credit | Offset for the holds |
| `processor_clearing` | asset | debit | Money collected from the card network, not yet settled |
| `merchant_payable` | liability | credit | What we owe the merchant |
| `refund_clearing` | liability | credit | Refunds owed back to cardholders, not yet paid out |

Postings:

| Event | Debit | Credit |
|---|---|---|
| Authorize $100 | holds 100 | hold offset 100 |
| Capture $80 of $100 | processor clearing 80; hold offset 100 | merchant payable 80; holds 100 |
| Cancel authorized $100 | hold offset 100 | holds 100 |
| Refund $30 | merchant payable 30 | refund clearing 30 |

**Why book authorizations at all?** An authorization moves no money, so many
ledgers skip it. Booking it in a pair of memo accounts (which balance only
against each other) keeps one rule true without exceptions: *every*
financial state change has exactly one balanced ledger transaction. It also
lets the invariant suite reconcile the payment row against the journal: open
holds in the ledger must equal `authorized_amount` for AUTHORIZED payments
and zero otherwise.

**Tradeoffs.** Reading a balance is a `SUM` over all of an account's lines,
O(history). Fine here; at scale you add periodic balance snapshots
(checkpoint rows written by a job, also append-only) and sum only lines after
the last snapshot. The memo-account choice is a modelling decision and is
documented as such; a real GL would likely keep holds off the books.

Avoiding a mutable balance column also removes a hot row. If every capture
had to `UPDATE accounts SET balance = balance + x WHERE code =
'merchant_payable'`, all captures system-wide would serialize on that one
row.

---

## Refund concurrency

**Problem.** Two refunds racing must not both pass the "refund <= captured -
refunded" check.

**Alternatives.**

1. *Atomic conditional update*: `UPDATE payments SET refunded_amount =
   refunded_amount + $a WHERE id = $id AND refunded_amount + $a <=
   captured_amount RETURNING *`. One statement, no explicit lock, correct.
2. *Optimistic concurrency*: read, compute, `UPDATE ... WHERE version = $v`,
   retry on zero rows.
3. *SERIALIZABLE isolation* with retries.
4. *Pessimistic row lock*: `SELECT ... FOR UPDATE`, then decide in
   application code.

**Chosen.** Option 4, with option 2's version predicate kept as a backstop.

**Why not option 1?** It is the best answer if the only thing that changes is
one counter. Here a refund also decides the new status
(PARTIALLY_REFUNDED vs REFUNDED), inserts a refund row, writes a journal
entry, and emits an event whose type depends on the outcome. Doing that from
a conditional update means re-implementing the state machine in SQL, or
running the update first and deriving everything else from `RETURNING`,
which works but splits the decision logic across two places. Locking the row
first keeps the whole decision in one pure, unit-tested function.

**Why not option 2 alone?** Under contention (the 20-concurrent-capture test)
most attempts fail and retry, and the client sees either latency or 500s.
With the lock they queue and each gets a correct answer.

**Tradeoffs.** Commands on the *same* payment are serialized; throughput per
payment is one transaction at a time. That matches the domain (a payment has
one state), and different payments never contend.

---

## Webhooks: direct delivery vs transactional outbox

**Problem.** "Commit the payment, then POST the webhook" has two failure
windows: crash after commit and before the POST (event lost), or POST inside
the transaction followed by a rollback (consumer told about something that
never happened, and a slow consumer holds the payment row lock).

**Alternatives.** POST inside the transaction; POST after commit; publish to
a broker after commit; transactional outbox; change-data-capture from the WAL.

**Chosen.** Transactional outbox. The event row and one `PENDING` delivery
row per subscribed endpoint are inserted in the payment transaction. A worker
delivers them afterwards. `NOTIFY` (transactional, sent only on commit) wakes
workers immediately; polling every `WORKER_POLL_INTERVAL_MS` is the fallback.

**Tradeoffs.** Delivery is asynchronous and at-least-once. The outbox table
grows and needs retention (not implemented: rows are kept for inspection).
CDC would avoid the extra writes but adds Debezium/Kafka, which this project
explicitly avoids.

---

## Worker job claiming: advisory locks vs `FOR UPDATE SKIP LOCKED`

**Alternatives.**

1. *Hold a row lock for the whole delivery* (`FOR UPDATE`, POST, update,
   commit). Crash recovery is automatic (the connection dies, the lock is
   released), but a transaction and a pooled connection stay open for the
   length of every HTTP call, including 5s timeouts.
2. *Advisory locks* (`pg_try_advisory_lock(hash(delivery_id))`). Flexible,
   but session-scoped advisory locks leak if a pooled connection is reused
   carelessly, and they do not compose with a `SELECT ... LIMIT n` claim
   query as cleanly.
3. *`FOR UPDATE SKIP LOCKED` to claim, plus a lease column.*

**Chosen.** Option 3. The claim transaction is a few milliseconds; the lease
(`locked_by`, `locked_until`) carries ownership across the HTTP call; an
expired lease makes the row claimable again, which is how a crashed worker's
job is recovered. `attempt_count` doubles as a fencing token so a worker that
stalls past its lease cannot overwrite the next owner's result.

**Tradeoffs.** Recovery waits for the lease to expire (default 30s). Lease
must exceed the HTTP timeout, which the worker checks at startup. Fencing
prevents duplicate *state writes*, not duplicate *HTTP requests*: a stalled
worker can still deliver a second copy, which is why consumers must dedupe.

---

## Delivery order

**Problem.** Retries, backoff and parallel workers deliver events out of
order.

**Alternatives.** Per-payment FIFO (never deliver version N+1 until N
succeeded), or no ordering plus enough information to reorder.

**Chosen.** No ordering guarantee. Every event carries `payment_id`,
`payment_version` and a full payment snapshot. Consumers apply an event only
if its version is newer than what they have (see
[webhooks.md](webhooks.md)).

**Tradeoffs.** Per-payment FIFO is head-of-line blocking: one consumer 500 on
`payment.captured` would hold back `payment.refunded` for up to the whole
retry schedule. Snapshot + version lets the consumer converge to the latest
state as soon as any newer event arrives. Consumers that need every
intermediate transition (not just the latest state) can fetch
`GET /payments/:id/events` and process in version order.

---

## Webhook signatures

**Chosen.** The Standard Webhooks scheme (`webhook-id`, `webhook-timestamp`,
`webhook-signature: v1,<base64 HMAC-SHA256(secret, id.timestamp.body)>`),
which Svix and others use, instead of inventing a format. The id and
timestamp are inside the MAC, consumers reject timestamps older than 5
minutes, and comparison is constant-time. Secrets are returned once at
endpoint creation and redacted from logs.

**Tradeoffs.** Secrets are stored in plaintext because the worker needs them
to sign; production would encrypt them with a KMS key. Space-separated
multiple signatures are accepted for secret rotation, but rotation itself is
not implemented.

---

## Failure injection

**Alternatives.** Network chaos proxies (toxiproxy), killing processes from
the outside, or named in-process failure points.

**Chosen.** Named points at the exact lines where a failure hurts
(`payment.before_commit`, `api.after_commit`, `worker.after_claim`,
`worker.after_send`, `worker.duplicate_send`, `worker.delay_send`), plus a
consumer that can be told to return 5xx, hang, or fail one event type.
Armed from tests, from `POST /dev/failures`, or from the dashboard. Disabled
unless `ENABLE_DEV_TOOLS=true`, and refused at startup in production.

**Tradeoffs.** In-process points are deterministic and fast enough for unit
style tests, but they simulate a crash by throwing, not by killing the
process. The worker treats `SimulatedCrash` as "nothing after this line ran"
(no ack, no lease release), which is what the database sees after a real
`kill -9`. Rules live in process memory, so arming them via the API only
affects the process that receives the request.

---

## Testing strategy

Correctness-sensitive behavior is tested against a real Postgres. Nothing
that touches transactions, locks or constraints is mocked. Every test file
creates and drops its own database, so files run in parallel.

| Suite | What it proves |
|---|---|
| `tests/unit` | State machine (exhaustive over reachable states), postings, signatures, backoff, request hashing, consumer logic |
| `tests/integration` | API lifecycle, idempotency semantics, every DB constraint and trigger (including TS/SQL graph parity), outbox atomicity, worker retry/timeout/replay/lease/fencing, failure-injection API |
| `tests/concurrency` | Racing captures, refunds, same-key storms, capture vs cancel, commit-then-timeout, 4 workers on one queue |
| `tests/property`, `tests/invariants` | fast-check model-based sequences through HTTP, and a 3,000-operation concurrent randomized workload with injected rollbacks, both followed by the SQL invariant suite |

A lesson worth recording: the first version of the property test generated
refund amounts uniformly from 1 to 12,000 and did **not** catch a deliberately
planted off-by-one (`REFUNDED` when one cent was still refundable). Random
amounts almost never land on "exactly the remainder minus one". The generator
now mixes absolute amounts with amounts relative to what is left
(`all`, `all - 1`, `all + 1`, `half`), and catches that mutation immediately.
