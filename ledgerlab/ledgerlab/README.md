# LedgerLab: Payment Reliability Sandbox

A small payment processor built to show one thing: **financial state stays
correct when requests are duplicated, workers crash, events arrive late, two
operations race, and networks time out.**

It is not a payments product. There is no real card network and no UI worth
looking at. It is a Fastify + PostgreSQL backend where every reliability
claim is backed by a test against a real database, and where the failures
can be switched on and watched.

```
git clone <this repo> && cd ledgerlab
docker compose up -d          # Postgres 16 on :5432
npm install
npm run db:migrate
npm run demo                  # runs Demos A to G end to end and checks the outcomes
npm run dev                   # API on :3000, docs at /docs, dashboard at /dashboard
```

## What it demonstrates

| Problem | Where it is solved | Proof |
|---|---|---|
| Idempotent retries | Idempotency key and the mutation commit in **one** Postgres transaction; duplicates block on the key's primary-key index | 50 concurrent same-key requests: 1 payment, 50 identical responses |
| Double-entry accounting | Append-only journal; `SUM(debits) = SUM(credits)` checked by a deferred trigger at COMMIT | Randomized 3,000-op workload, trial balance and per-payment reconciliation |
| ACID transactions | Payment, refund, ledger, outbox event and idempotent response commit together | Injected rollback leaves no trace of any of them |
| Row locking (pessimistic) | `SELECT ... FOR UPDATE` on the payment | 3 × $40 refunds on $100: always 2 succeed, 1 gets `422` |
| Optimistic concurrency | `WHERE version = $expected` + trigger requiring `version + 1` | Kept as backstops; tested by removing the lock |
| Transactional outbox | Events and deliveries inserted in the payment transaction | A rolled-back capture produces no event |
| Webhook retries, exponential backoff | Lease-based worker, `FOR UPDATE SKIP LOCKED`, equal-jitter backoff | 500s and timeouts retried and logged per attempt |
| Replay | New delivery rows; history is append-only at the DB level | Attempt rows identical before and after replay |
| Eventual consistency | Consumers dedupe on `webhook-id`, order by `payment_version` | Refund webhook before capture webhook: consumer ends at the right state |
| Failure recovery | Expired leases are reclaimed; `attempt_count` is a fencing token | Crash after claim, crash after send, stalled worker |
| Property-based testing | fast-check sequences through the HTTP API vs an independent model | 200+ random sequences per run, all invariants checked after each |

Reading order for a reviewer: this file, then
[docs/transactions.md](docs/transactions.md),
[docs/architecture.md](docs/architecture.md),
[docs/consistency.md](docs/consistency.md),
[docs/webhooks.md](docs/webhooks.md),
[docs/failure-scenarios.md](docs/failure-scenarios.md).

## Payment lifecycle

```mermaid
stateDiagram-v2
    [*] --> CREATED: POST /payments
    CREATED --> AUTHORIZED: authorize (approved)
    CREATED --> FAILED: authorize (declined)
    CREATED --> CANCELED: cancel
    AUTHORIZED --> CAPTURED: capture (amount <= authorized)
    AUTHORIZED --> CANCELED: cancel (releases hold)
    CAPTURED --> PARTIALLY_REFUNDED: refund < remaining
    CAPTURED --> REFUNDED: refund = remaining
    PARTIALLY_REFUNDED --> PARTIALLY_REFUNDED: refund < remaining
    PARTIALLY_REFUNDED --> REFUNDED: refund = remaining
    REFUNDED --> [*]
    CANCELED --> [*]
    FAILED --> [*]
```

Every transition increments `version`, writes exactly one outbox event, and
(for authorize, capture, refund and cancel-after-authorize) exactly one
balanced ledger transaction. The graph is a pure function in
[`src/domain/payment-state-machine.ts`](src/domain/payment-state-machine.ts)
and is enforced again by a Postgres trigger; a test checks all 49 status
pairs agree.

## Capture: one transaction

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant A as API
    participant P as Postgres
    C->>A: POST /payments/:id/capture<br/>Idempotency-Key: k1
    A->>P: BEGIN
    A->>P: INSERT idempotency_keys (k1, PROCESSING)<br/>ON CONFLICT DO NOTHING
    Note over P: a duplicate k1 blocks here<br/>until this transaction ends
    A->>P: SELECT * FROM payments WHERE id = $1 FOR UPDATE
    Note over A: state machine: AUTHORIZED -> CAPTURED
    A->>P: UPDATE payments SET status, captured_amount, version + 1
    A->>P: INSERT ledger_transactions + 4 ledger_entries
    A->>P: INSERT webhook_events + webhook_deliveries
    A->>P: UPDATE idempotency_keys SET response
    A->>P: COMMIT (deferred: ledger balanced? key completed?)
    A-->>C: 200 { status: CAPTURED, version: 3 }
```

## Refund race: the row lock decides

```mermaid
sequenceDiagram
    participant R1 as Refund $70 (k1)
    participant R2 as Refund $70 (k2)
    participant P as Postgres (payment captured $100)
    R1->>P: BEGIN, claim k1
    R2->>P: BEGIN, claim k2
    R1->>P: SELECT ... FOR UPDATE
    P-->>R1: row (refunded 0)
    R2->>P: SELECT ... FOR UPDATE
    Note over R2,P: waits for R1's lock
    R1->>P: UPDATE refunded = 7000, ledger, event, COMMIT
    P-->>R2: lock granted, re-reads latest row (refunded 7000)
    Note over R2: 7000 + 7000 > 10000
    R2->>P: ROLLBACK TO SAVEPOINT, store 422 on k2, COMMIT
    Note over P: refunded_amount = 7000, never 14000
```

## Webhook outbox

```mermaid
flowchart LR
    subgraph tx["one Postgres transaction"]
      PAY[payments UPDATE] --> LED[ledger INSERT]
      LED --> EVT[webhook_events INSERT]
      EVT --> DEL[webhook_deliveries INSERT<br/>one per endpoint, PENDING]
      DEL --> IDEM[idempotency response]
    end
    IDEM -- COMMIT + NOTIFY --> W1[worker 1]
    IDEM -- COMMIT + NOTIFY --> W2[worker 2]
    W1 -- "claim: FOR UPDATE SKIP LOCKED<br/>set lease" --> Q[(webhook_deliveries)]
    W2 -- "claim: disjoint rows" --> Q
    W1 -- "signed POST (no transaction open)" --> CON[consumer]
    W1 -- "fenced UPDATE + attempt log" --> Q
```

## Worker retry flow

```mermaid
flowchart TD
    P[PENDING<br/>next_attempt_at <= now] -->|claim, attempt_count + 1, lease| D[DELIVERING]
    D -->|2xx| OK[DELIVERED]
    D -->|non-2xx / timeout / error<br/>attempts left| B[PENDING<br/>next_attempt_at = now + backoff]
    B --> P
    D -->|non-2xx, last attempt| F[FAILED]
    D -->|worker died, lease expired| X[reclaimed: attempt logged LEASE_EXPIRED]
    X -->|attempts left| D
    X -->|no attempts left| F
    F -->|POST /webhook-events/:id/replay| N[new delivery row<br/>origin REPLAY]
    N --> P
```

## Client times out after commit, retries safely

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API
    participant P as Postgres
    C->>A: capture, Idempotency-Key: k9
    A->>P: BEGIN ... COMMIT (captured, ledger, event, response stored on k9)
    A--xC: connection drops (timeout)
    Note over C: outcome unknown. Retry with the SAME key
    C->>A: capture, Idempotency-Key: k9
    A->>P: INSERT k9 ON CONFLICT DO NOTHING -> 0 rows
    A->>P: SELECT stored response for k9
    A-->>C: 200 (stored body), idempotent-replayed: true
    Note over P: still exactly one capture and one CAPTURE ledger transaction
```

## The ledger

| Event | Debit | Credit |
|---|---|---|
| Authorize $100 | customer_authorization_holds 100 | authorization_hold_offset 100 |
| Capture $80 of $100 | processor_clearing 80, authorization_hold_offset 100 | merchant_payable 80, customer_authorization_holds 100 |
| Refund $30 | merchant_payable 30 | refund_clearing 30 |
| Cancel authorized $100 | authorization_hold_offset 100 | customer_authorization_holds 100 |

Holds are memo accounts that only balance against each other. Reasoning,
alternatives and tradeoffs are in
[docs/architecture.md](docs/architecture.md#double-entry-ledger).

## API

OpenAPI UI at `GET /docs` (JSON at `/docs/json`). Amounts are integers in
minor units. Money-moving endpoints require `Idempotency-Key`.

| Method | Path | |
|---|---|---|
| POST | `/payments` | create (`amount`, `currency`, `payment_method`) |
| GET | `/payments`, `/payments/:id` | |
| POST | `/payments/:id/authorize` | `pm_card_declined` / `pm_card_insufficient_funds` decline |
| POST | `/payments/:id/capture` | optional `amount` |
| POST | `/payments/:id/refunds` | `amount`, optional `reason` |
| POST | `/payments/:id/cancel` | |
| GET | `/payments/:id/refunds`, `/payments/:id/ledger`, `/payments/:id/events` | |
| GET | `/ledger/transactions/:id`, `/ledger/balances`, `/ledger/invariants` | invariants returns 500 if any check fails |
| POST | `/webhook-endpoints`, `/webhook-endpoints/:id/enable`, `/disable` | |
| GET | `/webhook-endpoints`, `/webhook-events`, `/webhook-events/:id` | |
| POST | `/webhook-events/:id/replay` | |
| GET | `/webhook-deliveries`, `/webhook-deliveries/:id` | delivery log with attempts |
| GET | `/health`, `/ready`, `/metrics` | liveness, readiness (DB + migrations), Prometheus counters |
| * | `/dev/*`, `/sandbox/consumer/*`, `/dashboard` | only with `ENABLE_DEV_TOOLS=true` |

Errors are always:

```json
{ "error": { "code": "REFUND_EXCEEDS_CAPTURED_AMOUNT", "message": "Refund would exceed the captured amount.",
             "details": { "captured_amount": 10000, "refunded_amount": 7000, "refundable_amount": 3000, "requested_amount": 7000 } } }
```

## Try it by hand

```bash
H='content-type: application/json'
P=$(curl -s localhost:3000/payments -H "$H" -H 'idempotency-key: demo-1' -d '{"amount":10000,"currency":"USD"}' | jq -r .id)
curl -s -X POST localhost:3000/payments/$P/authorize -H 'idempotency-key: demo-2'
curl -s -X POST localhost:3000/payments/$P/capture   -H 'idempotency-key: demo-3'
# three refunds at once
for k in a b c; do curl -s localhost:3000/payments/$P/refunds -H "$H" -H "idempotency-key: r-$k" -d '{"amount":4000}' & done; wait
curl -s localhost:3000/payments/$P/ledger | jq
curl -s localhost:3000/ledger/invariants | jq .ok
```

Or open `http://localhost:3000/dashboard`: it wires the built-in sandbox
consumer as a webhook endpoint, and every step above (plus failure injection)
is a button.

![Developer dashboard after a capture and a three-way refund race](docs/dashboard.png)

## Tests

All database tests run against real Postgres; each test file creates and
drops its own database.

```
npm test                    # unit: state machine, postings, signing, backoff, hashing, consumer
npm run test:integration    # API, idempotency, DB constraints, outbox, worker, failure injection
npm run test:concurrency    # racing captures/refunds, same-key storms, commit-then-timeout, worker contention
npm run test:invariants     # fast-check model-based sequences + randomized ledger workload
npm run demo                # Demos A to G with narrated output
```

`PROPERTY_RUNS`, `RANDOM_OPS` and `SEED` scale or pin the randomized suites.
CI (`.github/workflows/ci.yml`) runs lint, typecheck, every suite, the demos
and the build against a Postgres service container.

## Configuration

See [`.env.example`](.env.example). Notable settings: `RUN_WORKER` (embed a
worker in the API process), `WEBHOOK_MAX_ATTEMPTS`,
`WEBHOOK_BACKOFF_BASE_MS`, `WEBHOOK_BACKOFF_MAX_MS`,
`WEBHOOK_HTTP_TIMEOUT_MS`, `WEBHOOK_LEASE_MS` (must exceed the HTTP timeout),
`ENABLE_DEV_TOOLS` (refused when `NODE_ENV=production`). Run extra workers
with `npm run worker`.

## Observability

Structured JSON logs (pino) carry `reqId`, `idempotencyKey`, `paymentId`,
`eventId`, `deliveryId`, `transactionId` (ledger), `workerId` and `attempt`
where relevant. Signing secrets and signature headers are redacted. Every
response has `x-request-id`. `GET /metrics` exposes counters for committed
transitions, rejections, idempotent replays, webhook attempts by outcome,
lease expiries and lost leases.

## Known limitations

Stated plainly, because a reviewer will look for them:

- The card network is simulated in-process. A real one needs multi-phase
  idempotency (see [architecture.md](docs/architecture.md#idempotency)).
- Single capture per payment; no disputes, payouts or settlement.
- Idempotency keys, events and deliveries are never pruned.
- Webhook secrets are stored unencrypted; no secret rotation endpoint.
- No authentication or multi-tenancy; idempotency keys are globally scoped.
- Metrics and failure rules are per process.
