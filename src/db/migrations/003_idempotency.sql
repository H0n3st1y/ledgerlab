-- Idempotency records live in the same database, and are written in the same
-- transaction, as the mutation they protect. The primary key is the
-- concurrency control: a second request with the same key blocks on the
-- uncommitted index entry until the first transaction commits or rolls back.

CREATE TABLE idempotency_keys (
  key            text        NOT NULL,
  -- "POST /payments/:id/capture". Reusing a key on another endpoint is a conflict.
  operation      text        NOT NULL,
  -- sha256 of the canonical JSON of {operation, path params, body}.
  request_hash   text        NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  -- PROCESSING: claimed by an open transaction. Only ever visible to that
  --   transaction; a deferred trigger below refuses to commit it.
  -- SUCCEEDED:  the mutation committed; the response is replayed on retry.
  -- FAILED:     a deterministic business rejection (e.g. refund too large),
  --   also replayed verbatim. Unexpected errors roll back the whole
  --   transaction, including this row, so the key can be retried.
  status         text        NOT NULL CHECK (status IN ('PROCESSING', 'SUCCEEDED', 'FAILED')),
  response_code  integer     CHECK (response_code BETWEEN 200 AND 599),
  response_body  jsonb,
  payment_id     uuid        REFERENCES payments (id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Single-tenant sandbox, so keys are global. A multi-tenant system would
  -- scope this as PRIMARY KEY (account_id, key).
  PRIMARY KEY (key),
  CHECK (length(key) BETWEEN 1 AND 255),
  CHECK ((status = 'PROCESSING') = (response_code IS NULL)),
  CHECK ((status = 'PROCESSING') = (response_body IS NULL))
);

CREATE FUNCTION idempotency_assert_completed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM idempotency_keys WHERE key = NEW.key AND status = 'PROCESSING') THEN
    RAISE EXCEPTION 'idempotency key % would commit in PROCESSING state', NEW.key
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER idempotency_keys_completed_at_commit
  AFTER INSERT ON idempotency_keys
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION idempotency_assert_completed();

CREATE INDEX idempotency_keys_created_at_idx ON idempotency_keys (created_at);
