-- Transactional outbox + webhook delivery state.
--
-- webhook_events       immutable domain events, written in the payment transaction
-- webhook_endpoints    where to send them
-- webhook_deliveries   one row per (event, endpoint, replay); the worker's job queue
-- webhook_delivery_attempts  append-only log of every HTTP attempt

CREATE TABLE webhook_endpoints (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url             text        NOT NULL CHECK (url ~ '^https?://'),
  -- Signing secret ("whsec_..."). Stored in plaintext because the worker
  -- needs it to compute HMACs; production would encrypt it with a KMS key.
  secret          text        NOT NULL CHECK (secret LIKE 'whsec_%'),
  -- Empty array means "all event types".
  enabled_events  text[]      NOT NULL DEFAULT '{}',
  enabled         boolean     NOT NULL DEFAULT true,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text        NOT NULL CHECK (type ~ '^payment\.[a-z_]+$'),
  payment_id       uuid        NOT NULL REFERENCES payments (id),
  -- Consumers order events by (payment_id, payment_version), never by arrival time.
  payment_version  integer     NOT NULL CHECK (payment_version >= 1),
  payload          jsonb       NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, payment_version)
);

CREATE INDEX webhook_events_created_at_idx ON webhook_events (created_at DESC);

CREATE TRIGGER webhook_events_append_only
  BEFORE UPDATE OR DELETE ON webhook_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TYPE webhook_delivery_status AS ENUM ('PENDING', 'DELIVERING', 'DELIVERED', 'FAILED');

CREATE TABLE webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid        NOT NULL REFERENCES webhook_events (id),
  endpoint_id      uuid        NOT NULL REFERENCES webhook_endpoints (id),
  status           webhook_delivery_status NOT NULL DEFAULT 'PENDING',
  -- Number of attempts started so far. Doubles as the fencing token: a worker
  -- may only complete attempt N if attempt_count is still N.
  attempt_count    integer     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts     integer     NOT NULL CHECK (max_attempts >= 1),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  -- Lease held by the worker currently delivering. Expired leases are reclaimable.
  locked_by        text,
  locked_until     timestamptz,
  last_status_code integer,
  last_error       text,
  delivered_at     timestamptz,
  -- EVENT: created by the outbox write. REPLAY: created by a manual replay.
  origin           text        NOT NULL DEFAULT 'EVENT' CHECK (origin IN ('EVENT', 'REPLAY')),
  -- For replays, the most recent earlier delivery of this event to this endpoint (if any).
  replay_of        uuid        REFERENCES webhook_deliveries (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (attempt_count <= max_attempts),
  CHECK ((status = 'DELIVERING') = (locked_by IS NOT NULL AND locked_until IS NOT NULL)),
  CHECK ((status = 'DELIVERED') = (delivered_at IS NOT NULL)),
  CHECK (origin = 'REPLAY' OR replay_of IS NULL)
);

-- The worker's claim query scans exactly these two partial indexes.
CREATE INDEX webhook_deliveries_pending_idx    ON webhook_deliveries (next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX webhook_deliveries_delivering_idx ON webhook_deliveries (locked_until)    WHERE status = 'DELIVERING';
CREATE INDEX webhook_deliveries_event_id_idx   ON webhook_deliveries (event_id);
-- One original delivery per (event, endpoint); replays are extra rows.
CREATE UNIQUE INDEX webhook_deliveries_original_key ON webhook_deliveries (event_id, endpoint_id) WHERE origin = 'EVENT';

CREATE TYPE webhook_attempt_outcome AS ENUM ('SUCCEEDED', 'FAILED', 'LEASE_EXPIRED');

CREATE TABLE webhook_delivery_attempts (
  id              bigserial PRIMARY KEY,
  delivery_id     uuid        NOT NULL REFERENCES webhook_deliveries (id),
  attempt_number  integer     NOT NULL CHECK (attempt_number >= 1),
  worker_id       text        NOT NULL,
  outcome         webhook_attempt_outcome NOT NULL,
  http_status     integer,
  error           text,
  response_excerpt text,
  duration_ms     integer,
  started_at      timestamptz,
  finished_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, attempt_number)
);

CREATE TRIGGER webhook_delivery_attempts_append_only
  BEFORE UPDATE OR DELETE ON webhook_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
