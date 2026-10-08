-- Payments: the mutable aggregate. Every column that matters for money has a
-- CHECK constraint so that an application bug cannot commit an impossible
-- state. The application enforces the same rules first; the database is the
-- last line of defence, not the only one.

CREATE TYPE payment_status AS ENUM (
  'CREATED',
  'AUTHORIZED',
  'CAPTURED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'CANCELED',
  'FAILED'
);

CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amount             bigint         NOT NULL,
  currency           char(3)        NOT NULL,
  status             payment_status NOT NULL DEFAULT 'CREATED',
  authorized_amount  bigint         NOT NULL DEFAULT 0,
  captured_amount    bigint         NOT NULL DEFAULT 0,
  refunded_amount    bigint         NOT NULL DEFAULT 0,
  -- Monotonic per-payment version. Bumped on every state change and copied
  -- into the matching ledger transaction and webhook event.
  version            integer        NOT NULL DEFAULT 1,
  payment_method     text           NOT NULL,
  description        text,
  failure_code       text,
  created_at         timestamptz    NOT NULL DEFAULT now(),
  updated_at         timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT payments_amount_positive        CHECK (amount > 0),
  CONSTRAINT payments_currency_iso           CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT payments_amounts_non_negative   CHECK (authorized_amount >= 0 AND captured_amount >= 0 AND refunded_amount >= 0),
  CONSTRAINT payments_authorized_le_amount   CHECK (authorized_amount <= amount),
  CONSTRAINT payments_captured_le_authorized CHECK (captured_amount <= authorized_amount),
  CONSTRAINT payments_refunded_le_captured   CHECK (refunded_amount <= captured_amount),
  CONSTRAINT payments_version_positive       CHECK (version >= 1),
  -- Each status pins down which amounts are allowed. This makes "CAPTURED with
  -- zero captured" or "REFUNDED with money still captured" unrepresentable.
  CONSTRAINT payments_status_amounts CHECK (
    CASE status
      WHEN 'CREATED'            THEN authorized_amount = 0 AND captured_amount = 0 AND refunded_amount = 0
      WHEN 'FAILED'             THEN authorized_amount = 0 AND captured_amount = 0 AND refunded_amount = 0
      WHEN 'AUTHORIZED'         THEN authorized_amount = amount AND captured_amount = 0 AND refunded_amount = 0
      WHEN 'CANCELED'           THEN captured_amount = 0 AND refunded_amount = 0
      WHEN 'CAPTURED'           THEN captured_amount > 0 AND refunded_amount = 0
      WHEN 'PARTIALLY_REFUNDED' THEN refunded_amount > 0 AND refunded_amount < captured_amount
      WHEN 'REFUNDED'           THEN captured_amount > 0 AND refunded_amount = captured_amount
    END
  ),
  CONSTRAINT payments_failure_code_only_when_failed CHECK ((status = 'FAILED') = (failure_code IS NOT NULL))
);

CREATE INDEX payments_created_at_idx ON payments (created_at DESC);

-- Defence in depth: the state machine lives in TypeScript (src/domain), but the
-- database independently refuses illegal transitions, version skips and
-- amounts that move backwards. If the two ever disagree, the write fails.
CREATE FUNCTION payments_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency
     OR NEW.created_at <> OLD.created_at OR NEW.payment_method <> OLD.payment_method THEN
    RAISE EXCEPTION 'payments: immutable column changed (payment %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'payments: version must increase by exactly 1 (payment %, % -> %)', OLD.id, OLD.version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;

  -- Amounts only ever grow. A canceled authorization keeps its authorized_amount
  -- as history; the hold release is recorded in the ledger instead.
  IF NEW.authorized_amount < OLD.authorized_amount
     OR NEW.captured_amount < OLD.captured_amount
     OR NEW.refunded_amount < OLD.refunded_amount THEN
    RAISE EXCEPTION 'payments: amounts may not decrease (payment %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  IF NOT (
       (OLD.status = 'CREATED'            AND NEW.status IN ('AUTHORIZED', 'FAILED', 'CANCELED'))
    OR (OLD.status = 'AUTHORIZED'         AND NEW.status IN ('CAPTURED', 'CANCELED'))
    OR (OLD.status = 'CAPTURED'           AND NEW.status IN ('PARTIALLY_REFUNDED', 'REFUNDED'))
    OR (OLD.status = 'PARTIALLY_REFUNDED' AND NEW.status IN ('PARTIALLY_REFUNDED', 'REFUNDED'))
  ) THEN
    RAISE EXCEPTION 'payments: illegal transition % -> % (payment %)', OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_guard_update
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_guard_update();

CREATE FUNCTION payments_forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payments are never deleted (payment %)', OLD.id USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER payments_forbid_delete
  BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_forbid_delete();

CREATE TABLE refunds (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id  uuid        NOT NULL REFERENCES payments (id),
  amount      bigint      NOT NULL CHECK (amount > 0),
  currency    char(3)     NOT NULL,
  reason      text,
  -- The payment version produced by this refund. One refund per state change.
  payment_version integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, payment_version)
);

CREATE INDEX refunds_payment_id_idx ON refunds (payment_id);
