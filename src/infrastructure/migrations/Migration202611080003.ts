import {Migration} from '@mikro-orm/migrations';
export class Migration202611080003 extends Migration{
  async up():Promise<void>{this.addSql(`
    ALTER TABLE wager_transactions ADD CONSTRAINT transaction_financial_identity UNIQUE(id,wallet_id,amount,currency);
    ALTER TABLE wallet_ledger ADD CONSTRAINT ledger_matches_transaction
      FOREIGN KEY(transaction_id,wallet_id,amount,currency) REFERENCES wager_transactions(id,wallet_id,amount,currency);
    CREATE FUNCTION enforce_transaction_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE tx_id uuid; tx wager_transactions%ROWTYPE; entries integer; entry_direction text; expected_direction text;
    BEGIN
      IF TG_TABLE_NAME='wallet_ledger' THEN tx_id:=NEW.transaction_id; ELSE tx_id:=NEW.id; END IF;
      SELECT * INTO tx FROM wager_transactions WHERE id=tx_id;
      IF NOT FOUND THEN RETURN NULL; END IF;
      SELECT count(*),min(direction) INTO entries,entry_direction FROM wallet_ledger WHERE transaction_id=tx_id;
      IF tx.status='PROCESSED' AND tx.kind<>'LOSS' THEN
        IF entries<>1 THEN RAISE EXCEPTION 'PROCESSED_TRANSACTION_REQUIRES_LEDGER'; END IF;
        expected_direction:=CASE WHEN tx.kind='BET' THEN 'DEBIT' ELSE 'CREDIT' END;
        IF tx.kind='ROLLBACK' THEN
          SELECT CASE WHEN direction='CREDIT' THEN 'DEBIT' ELSE 'CREDIT' END INTO expected_direction
            FROM wallet_ledger WHERE transaction_id=tx.reference_transaction_id;
        END IF;
        IF expected_direction IS NULL OR entry_direction<>expected_direction THEN RAISE EXCEPTION 'INVALID_LEDGER_DIRECTION'; END IF;
      ELSIF entries<>0 THEN RAISE EXCEPTION 'TRANSACTION_CANNOT_HAVE_LEDGER'; END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER transaction_ledger_consistent AFTER INSERT OR UPDATE ON wager_transactions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_transaction_ledger();
    CREATE CONSTRAINT TRIGGER ledger_transaction_consistent AFTER INSERT ON wallet_ledger
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_transaction_ledger();
    CREATE FUNCTION protect_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.processed_at IS NOT NULL OR NEW.consumer_name<>OLD.consumer_name OR NEW.message_id<>OLD.message_id
        OR NEW.payload_hash<>OLD.payload_hash OR NEW.received_at<>OLD.received_at THEN
        RAISE EXCEPTION 'INBOX_IS_IMMUTABLE'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER inbox_transition BEFORE UPDATE ON inbox FOR EACH ROW EXECUTE FUNCTION protect_inbox();
  `);}
  async down():Promise<void>{this.addSql(`
    DROP TRIGGER inbox_transition ON inbox; DROP FUNCTION protect_inbox();
    DROP TRIGGER ledger_transaction_consistent ON wallet_ledger;
    DROP TRIGGER transaction_ledger_consistent ON wager_transactions; DROP FUNCTION enforce_transaction_ledger();
    ALTER TABLE wallet_ledger DROP CONSTRAINT ledger_matches_transaction;
    ALTER TABLE wager_transactions DROP CONSTRAINT transaction_financial_identity;
  `);}
}
