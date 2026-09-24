-- Internal virtual credits. NOT money: no purchase, no payout, no exchange.
--
-- Double-entry, append-only ledger. A wallet's balance is never stored: it is
-- SUM(credit_entries.amount) for that wallet. Every transaction's entries sum to
-- zero, so credits only move between wallets; new credits come from the
-- 'issuance' system wallet (the only one allowed to go negative).
--
-- Amounts are integer millicredits (1 credit = 1000).

CREATE TABLE credit_wallets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('user', 'worker', 'system')),
  user_id         uuid UNIQUE REFERENCES users(id),
  worker_id       uuid UNIQUE REFERENCES workers(id),
  system_name     text UNIQUE CHECK (system_name IN ('issuance', 'escrow', 'consumption')),
  allow_negative  boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'user') = (user_id IS NOT NULL)),
  CHECK ((kind = 'worker') = (worker_id IS NOT NULL)),
  CHECK ((kind = 'system') = (system_name IS NOT NULL)),
  CHECK (NOT allow_negative OR system_name = 'issuance')
);

-- seq: total order of the ledger. hash chains every transaction to the previous one
-- (tamper evidence; GET /v1/credits/ledger/verify recomputes it).
CREATE TABLE credit_transactions (
  seq              bigserial PRIMARY KEY,
  id               uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('grant', 'earning', 'hold', 'settlement', 'withdrawal')),
  -- One business event = one transaction, ever: retries and races cannot double-post.
  idempotency_key  text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  -- References are plain ids (no FK): the ledger outlives what it describes.
  job_id           uuid,
  assignment_id    uuid,
  worker_id        uuid,
  actor_type       text NOT NULL CHECK (actor_type IN ('user', 'worker', 'system')),
  actor_id         uuid,
  memo             text NOT NULL,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL,
  prev_hash        text NOT NULL,
  hash             text NOT NULL UNIQUE
);

CREATE INDEX credit_transactions_job_idx ON credit_transactions (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX credit_transactions_worker_idx ON credit_transactions (worker_id, seq) WHERE worker_id IS NOT NULL;

CREATE TABLE credit_entries (
  id              bigserial PRIMARY KEY,
  transaction_id  uuid NOT NULL REFERENCES credit_transactions(id),
  wallet_id       uuid NOT NULL REFERENCES credit_wallets(id),
  amount          bigint NOT NULL CHECK (amount <> 0),
  UNIQUE (transaction_id, wallet_id)
);

CREATE INDEX credit_entries_wallet_idx ON credit_entries (wallet_id, id);

INSERT INTO credit_wallets (kind, system_name, allow_negative) VALUES
  ('system', 'issuance', true),
  ('system', 'escrow', false),
  ('system', 'consumption', false);

-- Immutability: no UPDATE / DELETE, whoever connects. -----------------------------

CREATE FUNCTION credit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credit ledger is append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER credit_wallets_immutable BEFORE UPDATE OR DELETE ON credit_wallets
  FOR EACH ROW EXECUTE FUNCTION credit_append_only();
CREATE TRIGGER credit_transactions_immutable BEFORE UPDATE OR DELETE ON credit_transactions
  FOR EACH ROW EXECUTE FUNCTION credit_append_only();
CREATE TRIGGER credit_entries_immutable BEFORE UPDATE OR DELETE ON credit_entries
  FOR EACH ROW EXECUTE FUNCTION credit_append_only();

-- Serialization: one ledger writer at a time (held until commit), even for raw SQL.
-- The service takes the same lock before reading balances.
CREATE FUNCTION credit_serialize() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(7291001);
  RETURN NEW;
END $$;

CREATE TRIGGER credit_transactions_serialize BEFORE INSERT ON credit_transactions
  FOR EACH ROW EXECUTE FUNCTION credit_serialize();

-- Invariants checked at COMMIT (deferred): the transaction balances and no wallet
-- except issuance ends up negative. Backstop for the service-level checks.
CREATE FUNCTION credit_check_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tx_sum bigint;
  tx_n int;
  bal bigint;
  neg boolean;
BEGIN
  SELECT COALESCE(sum(amount), 0), count(*) INTO tx_sum, tx_n
    FROM credit_entries WHERE transaction_id = NEW.transaction_id;
  IF tx_sum <> 0 OR tx_n < 2 THEN
    RAISE EXCEPTION 'unbalanced credit transaction % (sum %, % entries)', NEW.transaction_id, tx_sum, tx_n
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT allow_negative INTO neg FROM credit_wallets WHERE id = NEW.wallet_id;
  IF NOT neg THEN
    SELECT COALESCE(sum(amount), 0) INTO bal FROM credit_entries WHERE wallet_id = NEW.wallet_id;
    IF bal < 0 THEN
      RAISE EXCEPTION 'credit wallet % would be negative (%)', NEW.wallet_id, bal
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER credit_entries_invariants AFTER INSERT ON credit_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION credit_check_entry();

-- TRUNCATE skips row triggers: refuse it too, unless the session opts in explicitly
-- (test resets only: SET LOCAL ghost.allow_ledger_truncate = 'on').
CREATE FUNCTION credit_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('ghost.allow_ledger_truncate', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'credit ledger is append-only: TRUNCATE on % is not allowed', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER credit_wallets_no_truncate BEFORE TRUNCATE ON credit_wallets
  FOR EACH STATEMENT EXECUTE FUNCTION credit_no_truncate();
CREATE TRIGGER credit_transactions_no_truncate BEFORE TRUNCATE ON credit_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION credit_no_truncate();
CREATE TRIGGER credit_entries_no_truncate BEFORE TRUNCATE ON credit_entries
  FOR EACH STATEMENT EXECUTE FUNCTION credit_no_truncate();
