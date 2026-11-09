import {Migration} from '@mikro-orm/migrations';
export class Migration202611080004 extends Migration{
  async up():Promise<void>{this.addSql(`
    CREATE FUNCTION prevent_transaction_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'TRANSACTION_IS_IMMUTABLE'; END $$;
    CREATE TRIGGER transaction_no_delete BEFORE DELETE ON wager_transactions FOR EACH ROW EXECUTE FUNCTION prevent_transaction_delete();
  `);}
  async down():Promise<void>{this.addSql('DROP TRIGGER transaction_no_delete ON wager_transactions; DROP FUNCTION prevent_transaction_delete();');}
}
