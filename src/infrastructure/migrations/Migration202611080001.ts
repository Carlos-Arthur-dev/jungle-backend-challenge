import { Migration } from '@mikro-orm/migrations';

export class Migration202611080001 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id uuid PRIMARY KEY, player_id uuid NOT NULL, currency varchar(3) NOT NULL,
        balance numeric(20,2) NOT NULL CHECK (balance >= 0),
        version integer NOT NULL CHECK (version >= 1),
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
        UNIQUE (player_id, currency), UNIQUE (id, currency), CHECK (currency ~ '^[A-Z]{3}$')
      );
      CREATE TABLE wager_transactions (
        id uuid PRIMARY KEY, provider_id text NOT NULL, external_transaction_id text NOT NULL,
        idempotency_key text NOT NULL UNIQUE, payload_hash text NOT NULL,
        wallet_id uuid NOT NULL, player_id uuid NOT NULL, round_id text NOT NULL, game_id text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(20,2) NOT NULL CHECK (amount >= 0), currency varchar(3) NOT NULL,
        status text NOT NULL CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        reference_external_transaction_id text, reference_transaction_id uuid REFERENCES wager_transactions(id),
        failure_code text, result jsonb, created_at timestamptz NOT NULL, processed_at timestamptz,
        attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz,
        UNIQUE(provider_id, external_transaction_id),
        FOREIGN KEY(wallet_id,currency) REFERENCES wallets(id,currency),
        CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL)
      );
      CREATE UNIQUE INDEX one_reversal_per_kind ON wager_transactions(reference_transaction_id,kind)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK');
      CREATE INDEX pending_references ON wager_transactions(next_attempt_at) WHERE status = 'PENDING_REFERENCE';
      CREATE TABLE wallet_ledger (
        id uuid PRIMARY KEY, wallet_id uuid NOT NULL, transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
        direction text NOT NULL CHECK(direction IN ('DEBIT','CREDIT')),
        amount numeric(20,2) NOT NULL CHECK(amount > 0), currency varchar(3) NOT NULL,
        balance_before numeric(20,2) NOT NULL CHECK(balance_before >= 0),
        balance_after numeric(20,2) NOT NULL CHECK(balance_after >= 0),
        created_at timestamptz NOT NULL, UNIQUE(wallet_id,transaction_id),
        FOREIGN KEY(wallet_id,currency) REFERENCES wallets(id,currency),
        CHECK(balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
      );
      CREATE INDEX ledger_pagination ON wallet_ledger(wallet_id,created_at,id);
      CREATE FUNCTION immutable_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'LEDGER_IS_IMMUTABLE'; END $$;
      CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger
        FOR EACH ROW EXECUTE FUNCTION immutable_ledger();
      CREATE FUNCTION terminal_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
        RAISE EXCEPTION 'TRANSACTION_IS_TERMINAL'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER transaction_terminal BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION terminal_transaction();
      CREATE TABLE inbox (
        consumer_name text NOT NULL, message_id text NOT NULL, payload_hash text NOT NULL,
        received_at timestamptz NOT NULL, processed_at timestamptz,
        PRIMARY KEY(consumer_name,message_id)
      );
      CREATE TABLE outbox (
        id uuid PRIMARY KEY, aggregate_id uuid NOT NULL, event_type text NOT NULL, payload jsonb NOT NULL,
        occurred_at timestamptz NOT NULL, attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
      );
      CREATE INDEX pending_outbox ON outbox(next_attempt_at,occurred_at) WHERE published_at IS NULL;
    `);
  }
  async down(): Promise<void> {
    this.addSql(`DROP TABLE outbox, inbox, wallet_ledger, wager_transactions, wallets;
      DROP FUNCTION immutable_ledger(); DROP FUNCTION terminal_transaction();`);
  }
}
