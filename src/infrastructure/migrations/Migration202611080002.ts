import { Migration } from '@mikro-orm/migrations';
export class Migration202611080002 extends Migration {
  async up(): Promise<void> {
    // Rejected requests with a different currency must remain auditable.
    // The ledger retains its composite currency FK; requests keep only wallet identity.
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT wager_transactions_wallet_id_currency_fkey;
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_wallet_fk FOREIGN KEY(wallet_id) REFERENCES wallets(id);`);
  }
  async down(): Promise<void> {
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT wager_wallet_fk;
      ALTER TABLE wager_transactions ADD CONSTRAINT wager_transactions_wallet_id_currency_fkey
      FOREIGN KEY(wallet_id,currency) REFERENCES wallets(id,currency) NOT VALID;`);
  }
}
