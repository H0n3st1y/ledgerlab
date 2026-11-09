-- Append-only double-entry ledger.
--
-- ledger_accounts      chart of accounts, one row per (code, currency)
-- ledger_transactions  one journal entry per financial state change
-- ledger_entries       the debit/credit lines of a journal entry
--
-- Guarantees enforced here rather than in TypeScript:
--   * an entry is a debit XOR a credit, strictly positive
--   * entry currency = account currency = transaction currency (composite FKs)
--   * every transaction has >= 2 entries and SUM(debits) = SUM(credits),
--     checked at COMMIT by deferred constraint triggers
--   * nothing is ever updated or deleted
--   * at most one ledger transaction per payment version

CREATE TYPE ledger_normal_balance AS ENUM ('DEBIT', 'CREDIT');

CREATE TABLE ledger_accounts (
  id              serial PRIMARY KEY,
  code            text                  NOT NULL,
  currency        char(3)               NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  name            text                  NOT NULL,
  normal_balance  ledger_normal_balance NOT NULL,
  -- Memo accounts track authorization holds; they are not real money.
  is_memo         boolean               NOT NULL DEFAULT false,
  created_at      timestamptz           NOT NULL DEFAULT now(),
  UNIQUE (code, currency),
  UNIQUE (id, currency)
);

CREATE TYPE ledger_transaction_kind AS ENUM (
  'AUTHORIZATION_HOLD',
  'CAPTURE',
  'AUTHORIZATION_RELEASE',
  'REFUND'
);

CREATE TABLE ledger_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             ledger_transaction_kind NOT NULL,
  currency         char(3)     NOT NULL,
  payment_id       uuid        NOT NULL REFERENCES payments (id),
  payment_version  integer     NOT NULL CHECK (payment_version >= 1),
  refund_id        uuid        REFERENCES refunds (id),
  description      text        NOT NULL,
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, currency),
  -- One ledger transaction per payment state change. A retried or duplicated
  -- mutation that slipped past every other guard would still fail here.
  UNIQUE (payment_id, payment_version),
  CHECK ((kind = 'REFUND') = (refund_id IS NOT NULL))
);

CREATE UNIQUE INDEX ledger_transactions_refund_id_key ON ledger_transactions (refund_id) WHERE refund_id IS NOT NULL;

CREATE TABLE ledger_entries (
  id              bigserial PRIMARY KEY,
  transaction_id  uuid        NOT NULL,
  account_id      integer     NOT NULL,
  currency        char(3)     NOT NULL,
  debit_amount    bigint,
  credit_amount   bigint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (transaction_id, currency) REFERENCES ledger_transactions (id, currency),
  FOREIGN KEY (account_id, currency)     REFERENCES ledger_accounts (id, currency),
  CONSTRAINT ledger_entries_debit_xor_credit CHECK ((debit_amount IS NULL) <> (credit_amount IS NULL)),
  CONSTRAINT ledger_entries_positive         CHECK (COALESCE(debit_amount, credit_amount) > 0)
);

CREATE INDEX ledger_entries_transaction_id_idx ON ledger_entries (transaction_id);
CREATE INDEX ledger_entries_account_id_idx     ON ledger_entries (account_id);
CREATE INDEX ledger_transactions_payment_id_idx ON ledger_transactions (payment_id);

-- Balance check, run at COMMIT (DEFERRABLE INITIALLY DEFERRED) so a
-- transaction can insert its lines one at a time.
CREATE FUNCTION ledger_assert_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  txn_id uuid;
  n_entries integer;
  total_debits numeric;
  total_credits numeric;
BEGIN
  -- (PL/pgSQL resolves NEW.<field> eagerly, so branch with IF, not CASE.)
  IF TG_TABLE_NAME = 'ledger_transactions' THEN
    txn_id := NEW.id;
  ELSE
    txn_id := NEW.transaction_id;
  END IF;

  SELECT count(*), COALESCE(sum(debit_amount), 0), COALESCE(sum(credit_amount), 0)
    INTO n_entries, total_debits, total_credits
    FROM ledger_entries
   WHERE transaction_id = txn_id;

  IF n_entries < 2 THEN
    RAISE EXCEPTION 'ledger transaction % has % entries; at least 2 required', txn_id, n_entries
      USING ERRCODE = 'check_violation';
  END IF;
  IF total_debits <> total_credits THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced: debits % <> credits %', txn_id, total_debits, total_credits
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_transactions_balanced
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();

-- Immutability. Corrections are new, reversing transactions; history is never edited.
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_transactions_no_truncate
  BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER refunds_append_only
  BEFORE UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Chart of accounts. See docs/architecture.md#ledger for the reasoning.
INSERT INTO ledger_accounts (code, currency, name, normal_balance, is_memo)
SELECT a.code, c.currency, a.name, a.normal_balance::ledger_normal_balance, a.is_memo
FROM (VALUES
  ('customer_authorization_holds', 'Authorization holds on cardholder funds (memo)', 'DEBIT',  true),
  ('authorization_hold_offset',    'Offset for authorization holds (memo)',          'CREDIT', true),
  ('processor_clearing',           'Funds collected from the card network, pending settlement', 'DEBIT', false),
  ('merchant_payable',             'Amounts owed to the merchant',                    'CREDIT', false),
  ('refund_clearing',              'Refunds owed to cardholders, pending payout',     'CREDIT', false)
) AS a(code, name, normal_balance, is_memo)
CROSS JOIN (VALUES ('USD'), ('EUR'), ('GBP')) AS c(currency);
