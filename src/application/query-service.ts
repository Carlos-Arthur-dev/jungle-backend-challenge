import type { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../domain/money';
import { ApplicationError } from './wagering-service';
import { count, log } from '../infrastructure/telemetry';
interface Entry { id:string; wallet_id:string; transaction_id:string; direction:string; amount:string; currency:string; balance_before:string; balance_after:string; created_at:Date }
export class QueryService {
  constructor(private readonly orm: MikroORM) {}
  async transaction(id: string) {
    const rows = await this.orm.em.fork().execute('select * from wager_transactions where id=?',[id]);
    if (!rows[0]) throw new ApplicationError('TRANSACTION_NOT_FOUND',404);
    return rows[0];
  }
  async providerTransaction(provider: string, external: string) {
    const rows = await this.orm.em.fork().execute<{id:string}[]>('select id from wager_transactions where provider_id=? and external_transaction_id=?',[provider,external]);
    if (!rows[0]) throw new ApplicationError('TRANSACTION_NOT_FOUND',404);
    return this.transaction(rows[0].id);
  }
  async ledger(walletId:string, cursor?:string, limitText='50') {
    if (!/^\d+$/.test(limitText) || Number(limitText)<1 || Number(limitText)>100) throw new ApplicationError('INVALID_LIMIT',400);
    const limit=Number(limitText);
    let position: {at:string;id:string;walletId:string}|undefined;
    if (cursor!==undefined) {
      try {
        if(cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(cursor))throw new Error();
        position=JSON.parse(Buffer.from(cursor,'base64url').toString());
        if (!position || position.walletId!==walletId || typeof position.at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(position.at)
          ||!Number.isFinite(Date.parse(position.at))||new Date(position.at).toISOString().slice(0,19)!==position.at.slice(0,19)
          ||typeof position.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(position.id)) throw new Error();
      } catch { throw new ApplicationError('INVALID_CURSOR',400); }
    }
    const exists=await this.orm.em.fork().execute('select id from wallets where id=?',[walletId]);
    if (!exists.length) throw new ApplicationError('WALLET_NOT_FOUND',404);
    const rows=await this.orm.em.fork().execute<Entry[]>(`select *,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at from wallet_ledger where wallet_id=?
      ${position ? 'and (created_at,id) > (?::timestamptz,?::uuid)' : ''} order by created_at,id limit ?`,
      position ? [walletId,position.at,position.id,limit+1] : [walletId,limit+1]);
    const items=rows.slice(0,limit), last=items.at(-1) as (Entry & {cursor_at:string})|undefined;
    return { items:items.map(row=>({id:row.id,transactionId:row.transaction_id,direction:row.direction,
      money:{amount:row.amount,currency:row.currency},balanceBefore:{amount:row.balance_before,currency:row.currency},
      balanceAfter:{amount:row.balance_after,currency:row.currency},createdAt:row.created_at})),
      nextCursor:rows.length>limit && last ? Buffer.from(JSON.stringify({at:last.cursor_at,id:last.id,walletId})).toString('base64url') : null };
  }
  async reconcile(walletId:string) {
    return this.orm.em.fork().transactional(async em=>{
      // Same lock as financial writers: balance and ledger are observed consistently.
      const wallets=await em.execute<{balance:string;currency:string}[]>('select balance,currency from wallets where id=? for update',[walletId]);
      const row=wallets[0]; if (!row) throw new ApplicationError('WALLET_NOT_FOUND',404);
      const totals=await em.execute<{total:string;entries:number}[]>(`select coalesce(sum(case direction when 'CREDIT' then amount else -amount end),0)::numeric(20,2)::text total,count(*)::int entries from wallet_ledger where wallet_id=?`,[walletId]);
      const total=totals[0]!;
      // Reconstruction may be negative if persisted data was corrupted; avoid rejecting that diagnostic value.
      const calculated=total.total.startsWith('-') ? Money.from({amount:total.total.slice(1),currency:row.currency}).negate() : Money.from({amount:total.total,currency:row.currency});
      const stored=Money.from({amount:row.balance,currency:row.currency}), difference=stored.subtract(calculated);
      const consistent=difference.isZero();
      if (!consistent) { count('jungle_reconciliation_divergences_total'); log('reconciliation_divergence',{walletId}); }
      return {walletId,storedBalance:stored.toJSON(),calculatedBalance:calculated.toJSON(),difference:difference.toJSON(),consistent,checkedEntries:total.entries};
    });
  }
  async metrics() {
    const rows=await this.orm.em.fork().execute<{status:string;total:string}[]>('select status,count(*)::text total from wager_transactions group by status');
    const lag=await this.orm.em.fork().execute<{lag:string}[]>("select coalesce(extract(epoch from now()-min(occurred_at)),0)::text lag from outbox where published_at is null");
    return rows.map(row=>`jungle_transactions{status="${row.status}"} ${row.total}`).join('\n')+`\njungle_outbox_lag_seconds ${lag[0]?.lag ?? 0}`;
  }
}
