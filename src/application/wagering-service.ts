import { createHash, randomUUID } from 'node:crypto';
import type { MikroORM, EntityManager } from '@mikro-orm/postgresql';
import { Money, type MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { WagerTransaction, type WagerKind, type WagerState } from '../domain/wager-transaction';
import type { WalletRow } from '../infrastructure/database';
import { count, log, observeProcessing, requestContext } from '../infrastructure/telemetry';
import { InboxMessage } from '../domain/inbox-message';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionFailed, WagerTransactionPendingReference, WalletBalanceChanged } from '../domain/integration-event';

export class ApplicationError extends Error {
  constructor(public readonly code: string, public readonly httpStatus: number) { super(code); }
}
export interface WagerInput {
  providerId: string; externalTransactionId: string; playerId: string; walletId: string;
  roundId: string; gameId: string; kind: WagerKind; money: MoneyProps;
  referenceExternalTransactionId?: string;
}
interface TxRow {
  id: string; payload_hash: string; status: WagerState['status']; result: WagerResult;
  provider_id: string; external_transaction_id: string; wallet_id: string; player_id: string;
  round_id: string; game_id: string; kind: WagerKind; amount: string; currency: string;
  idempotency_key: string; created_at: Date;
}
export interface WagerResult {
  transactionId: string; status: WagerState['status']; balance: MoneyProps;
  failureCode?: string; idempotentReplay: boolean;
}
export interface MessageContext { messageId: string; consumerName: string }
export class WageringService {
  constructor(private readonly orm: MikroORM) {}
  async openWallet(playerId: string, props: MoneyProps) {
    this.uuid(playerId);
    this.validateMoney(props);
    const money = Money.from(props), id = randomUUID(), at = new Date();
    const wallet=Wallet.open({id,playerId,initialBalance:money,at});
    try {
      return await this.orm.em.fork().transactional(async em => {
        await em.execute('insert into wallets values (?, ?, ?, ?, 1, ?, ?)', [id, playerId, money.currency, money.toString(), at, at]);
        if (money.isPositive()) {
          const transactionId = randomUUID();
          await em.execute(`insert into wager_transactions
            (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,created_at,processed_at,result)
            values (?,'internal',?,?,?, ?,?,'opening','opening','OPENING',?,?,'PROCESSED',?,?,?::jsonb)`,
            [transactionId, transactionId, transactionId, 'internal', id, playerId, money.toString(), money.currency, at, at,
              JSON.stringify({transactionId,status:'PROCESSED',balance:money.toJSON(),idempotentReplay:false})]);
          await em.execute(`insert into wallet_ledger values (?,?,?,'CREDIT',?,?,0,?,?)`,
            [randomUUID(), id, transactionId, money.toString(), money.currency, money.toString(), at]);
          await this.event(em,id,'WagerTransactionProcessed',{transactionId,status:'PROCESSED',kind:'OPENING'});
          await this.event(em,id,'WalletBalanceChanged',{transactionId,walletId:id,direction:'CREDIT',money:money.toJSON(),balanceBefore:Money.zero(money.currency).toJSON(),balanceAfter:money.toJSON(),walletVersion:1});
        }
        return { id, playerId, balance: wallet.balance.toJSON(), version: wallet.version };
      });
    } catch (error) { if ((error as { code?: string }).code === '23505') throw new ApplicationError('WALLET_ALREADY_EXISTS', 409); throw error; }
  }
  async getWallet(id: string) {
    this.uuid(id);
    const row = await this.orm.em.fork().findOne<WalletRow>('WalletRecord', { id });
    if (!row) throw new ApplicationError('WALLET_NOT_FOUND', 404);
    return { id: row.id, playerId: row.playerId, balance: { amount: row.balance, currency: row.currency }, version: row.version };
  }
  async submit(input: WagerInput, key: string, message?: MessageContext, retryId?: string): Promise<WagerResult> {
    const started=performance.now();
    try{return await this.executeSubmit(input,key,message,retryId);}
    catch(error){if(['40P01','55P03','40001'].includes((error as {code?:string}).code??''))count('jungle_lock_conflicts_total');throw error;}
    finally{observeProcessing((performance.now()-started)/1000);}
  }
  async recordPermanentFailure(input:WagerInput,key:string,message:MessageContext):Promise<WagerResult>{
    return this.executeSubmit(input,key,message,undefined,true);
  }
  private async executeSubmit(input: WagerInput, key: string, message?: MessageContext, retryId?: string, permanentFailure=false): Promise<WagerResult> {
    if (!input || typeof input !== 'object') throw new ApplicationError('INVALID_PAYLOAD', 400);
    if (!key?.trim() || key.length > 256) throw new ApplicationError('INVALID_IDEMPOTENCY_KEY', 400);
    for (const field of ['providerId','externalTransactionId','playerId','walletId','roundId','gameId'] as const) {
      if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 256) throw new ApplicationError('INVALID_PAYLOAD', 400);
    }
    this.uuid(input.walletId); this.uuid(input.playerId); this.validateMoney(input.money);
    if (input.referenceExternalTransactionId !== undefined && (typeof input.referenceExternalTransactionId !== 'string' || !input.referenceExternalTransactionId.trim())) throw new ApplicationError('INVALID_REFERENCE',400);
    const money = Money.from(input.money);
    const canonical = { externalTransactionId: input.externalTransactionId, gameId: input.gameId,
      kind: input.kind, money: money.toJSON(), playerId: input.playerId, providerId: input.providerId,
      referenceExternalTransactionId: input.referenceExternalTransactionId ?? null, roundId: input.roundId, walletId: input.walletId };
    const hash = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
    const id = retryId ?? randomUUID(), at = new Date();
    let tx = WagerTransaction.create({ ...input, money, id, idempotencyKey: key, payloadHash: hash, createdAt: at });
    return this.orm.em.fork().transactional(async em => {
      let referenceExpired=false;
      let inboxMessage:InboxMessage|undefined;
      const finishInbox=async()=>{
        if(!inboxMessage||inboxMessage.isProcessed())return;
        inboxMessage.markProcessed(at);
        await em.execute('update inbox set processed_at=? where consumer_name=? and message_id=?',[inboxMessage.processedAt,inboxMessage.consumerName,inboxMessage.messageId]);
      };
      if (message) {
        const inboxHash = createHash('sha256').update(`${key}:${hash}`).digest('hex');
        const received=InboxMessage.receive({...message,payloadHash:inboxHash,receivedAt:at});
        await em.execute(`insert into inbox(consumer_name,message_id,payload_hash,received_at)
          values (?,?,?,?) on conflict do nothing`,[received.consumerName,received.messageId,received.payloadHash,received.receivedAt]);
        const inbox = await em.execute<{ payload_hash: string;received_at:Date;processed_at:Date|null }[]>('select payload_hash,received_at,processed_at from inbox where consumer_name=? and message_id=? for update',[message.consumerName,message.messageId]);
        if (inbox[0]?.payload_hash !== inboxHash) throw new ApplicationError('INBOX_PAYLOAD_CONFLICT',409);
        inboxMessage=InboxMessage.rehydrate({...message,payloadHash:inbox[0].payload_hash,receivedAt:inbox[0].received_at,
          ...(inbox[0].processed_at?{processedAt:inbox[0].processed_at}:{})});
      }
      // Lock wallet before inserting its FK-dependent transaction. Otherwise concurrent
      // FK KEY SHARE locks can deadlock while both transactions upgrade to FOR UPDATE.
      // All paths, including pending-reference retries, acquire wallet then transaction.
      const exists = await em.execute('select id from wallets where id = ? for update', [input.walletId]);
      if (!exists.length) throw new ApplicationError('WALLET_NOT_FOUND',404);
      const inserted = await em.execute<TxRow[]>(`insert into wager_transactions
        (id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,reference_external_transaction_id,created_at)
        values (?,?,?,?,?,?,?,?,?,?,?,?,'PENDING',?,?) on conflict do nothing returning *`,
        [id,input.providerId,input.externalTransactionId,key,hash,input.walletId,input.playerId,input.roundId,input.gameId,input.kind,money.toString(),money.currency,input.referenceExternalTransactionId ?? null,at]);
      if (!inserted.length) {
        const existing = await em.execute<TxRow[]>('select * from wager_transactions where idempotency_key = ? or (provider_id = ? and external_transaction_id = ?)', [key,input.providerId,input.externalTransactionId]);
        const old = existing[0];
        if (!old || existing.length !== 1 || old.idempotency_key !== key || old.payload_hash !== hash) throw new ApplicationError('IDEMPOTENCY_CONFLICT', 409);
        if (retryId) {
          const locked = await em.execute<(TxRow & {next_attempt_at:Date;attempts:number})[]>('select * from wager_transactions where id=? for update',[retryId]);
          if (locked[0]?.status !== 'PENDING_REFERENCE') return { ...old.result, idempotentReplay: true };
          if(new Date(locked[0].next_attempt_at)>at)return {...old.result,idempotentReplay:true};
          referenceExpired=locked[0].attempts>=10||at.getTime()-new Date(locked[0].created_at).getTime()>=86400000;
          tx=WagerTransaction.rehydrate({...input,money,id,idempotencyKey:key,payloadHash:hash,createdAt:locked[0].created_at,status:'PENDING_REFERENCE'});
          tx.resumeReference();
        } else {
          count('jungle_duplicates_total');
          await finishInbox();
          return { ...old.result, idempotentReplay: true };
        }
      }
      const rows = await em.execute<{ id: string; player_id: string; currency: string; balance: string; version: number; created_at: Date; updated_at: Date }[]>('select * from wallets where id = ? for update', [input.walletId]);
      const row = rows[0];
      if (!row) throw new ApplicationError('WALLET_NOT_FOUND', 404);
      const wallet = Wallet.rehydrate({ id: row.id, playerId: row.player_id, currency: row.currency,
        balance: Money.from({ amount: row.balance, currency: row.currency }), version: row.version, createdAt: row.created_at, updatedAt: row.updated_at });
      let reference: WagerTransaction | undefined;
      if(permanentFailure)tx.fail('INFRASTRUCTURE_FAILURE');
      else if(referenceExpired)tx.reject('REFERENCE_NOT_FOUND');
      else if (input.playerId !== wallet.playerId) tx.reject('PLAYER_MISMATCH');
      else if (money.currency !== wallet.currency) tx.reject('CURRENCY_MISMATCH');
      else if (input.referenceExternalTransactionId) {
        const refs = await em.execute<TxRow[]>('select * from wager_transactions where provider_id = ? and external_transaction_id = ?', [input.providerId,input.referenceExternalTransactionId]);
        const ref = refs[0];
        if (!ref) tx.markPendingReference();
        else {
          reference = WagerTransaction.rehydrate({ id: ref.id, providerId: ref.provider_id, externalTransactionId: ref.external_transaction_id,
            walletId: ref.wallet_id, playerId: ref.player_id, roundId: ref.round_id, gameId: ref.game_id, kind: ref.kind,
            money: Money.from({ amount: ref.amount, currency: ref.currency }), idempotencyKey: ref.idempotency_key,
            payloadHash: ref.payload_hash, createdAt: ref.created_at, status: ref.status });
          const failure = tx.validateReference(reference);
          if (failure) tx.reject(failure);
          else if (reference.status !== 'PROCESSED') tx.markPendingReference();
          else if (tx.requiresReference()) {
            const reversed = await em.execute('select id from wager_transactions where reference_transaction_id = ? and kind = ? and status = ?', [reference.id,tx.kind,'PROCESSED']);
            if (reversed.length) tx.reject('ALREADY_REVERSED');
          }
        }
      }
      if (tx.status === 'PENDING') {
        if (tx.affectsBalance()) {
          const direction = tx.ledgerDirectionFor(reference);
          if (direction === 'DEBIT' && wallet.balance.isLessThan(money)) tx.reject(tx.kind === 'BET' ? 'INSUFFICIENT_FUNDS' : 'REVERSAL_INSUFFICIENT_FUNDS');
          else if(direction==='CREDIT'&&this.exceedsBalanceLimit(wallet.balance,money))tx.reject('BALANCE_LIMIT_EXCEEDED');
          else {
            const movement = { entryId: randomUUID(), transactionId: id, money, at };
            const entry = direction === 'DEBIT' ? wallet.debit(movement) : wallet.credit(movement);
            await em.execute('insert into wallet_ledger values (?,?,?,?,?,?,?,?,?)', [entry.id,wallet.id,id,direction,money.toString(),money.currency,entry.balanceBefore.toString(),entry.balanceAfter.toString(),at]);
            await em.execute('update wallets set balance = ?, version = ?, updated_at = ? where id = ?', [wallet.balance.toString(),wallet.version,at,wallet.id]);
            await this.event(em,wallet.id,'WalletBalanceChanged',{ transactionId: id,walletId:wallet.id,direction,money:money.toJSON(), balanceBefore: entry.balanceBefore.toJSON(),balanceAfter: entry.balanceAfter.toJSON(),walletVersion: wallet.version });
          }
        }
        if (!tx.isTerminal()) tx.markProcessed(reference?.id,at);
      }
      const result = { transactionId: id, status: tx.status, balance: wallet.balance.toJSON(), ...(tx.failureCode ? { failureCode: tx.failureCode } : {}), idempotentReplay: false };
      await em.execute('update wager_transactions set status = ?, failure_code = ?, reference_transaction_id = ?, processed_at = ?, result = ?::jsonb where id = ?',
        [tx.status,tx.failureCode ?? null,reference?.id ?? null,tx.processedAt ?? null,JSON.stringify(result),id]);
      if (tx.status === 'PENDING_REFERENCE') await em.execute(`update wager_transactions set attempts=attempts+1,
        next_attempt_at=now() + (least(3600,power(2,attempts+1)) * interval '1 second') where id=?`,[id]);
      await finishInbox();
      await this.event(em,wallet.id,tx.status === 'PROCESSED' ? 'WagerTransactionProcessed' : tx.status === 'REJECTED' ? 'WagerTransactionRejected' : tx.status==='FAILED'?'WagerTransactionFailed':'WagerTransactionPendingReference',result);
      log('transaction_prepared',{transactionId:id,walletId:wallet.id,providerId:input.providerId,messageId:message?.messageId,status:tx.status});
      return result;
    });
  }
  async retryReferences(limit = 20): Promise<number> {
    const rows = await this.orm.em.fork().execute<(TxRow & { reference_external_transaction_id: string })[]>(
      "select * from wager_transactions where status='PENDING_REFERENCE' and next_attempt_at<=now() order by next_attempt_at limit ?",[limit]);
    for (const row of rows) {
      await this.submit({ providerId: row.provider_id,externalTransactionId: row.external_transaction_id,
        playerId: row.player_id,walletId: row.wallet_id,roundId: row.round_id,gameId: row.game_id,kind: row.kind,
        money: { amount: row.amount,currency: row.currency },referenceExternalTransactionId: row.reference_external_transaction_id },row.idempotency_key,undefined,row.id);
    }
    return rows.length;
  }
  private async event(em: EntityManager, aggregateId: string, eventType: string, data: Record<string,unknown>) {
    const types = { WagerTransactionProcessed,WagerTransactionRejected,WagerTransactionFailed,WagerTransactionPendingReference,WalletBalanceChanged };
    const type = types[eventType as keyof typeof types];
    const original = OutboxMessage.enqueue(type.from(aggregateId,data,requestContext.getStore()??{})).payload;
    await em.execute('insert into outbox (id,aggregate_id,event_type,payload,occurred_at) values (?,?,?,?::jsonb,?)', [original.eventId,aggregateId,original.eventType,JSON.stringify(original),original.occurredAt]);
  }
  private uuid(value: string): void {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new ApplicationError('INVALID_UUID',400);
  }
  private exceedsBalanceLimit(balance:Money,money:Money):boolean{
    try{balance.add(money);return false;}catch(error){if(error instanceof Error&&error.message==='MONEY_OUT_OF_RANGE')return true;throw error;}
  }
  private validateMoney(value: MoneyProps): void {
    if (!value || typeof value !== 'object') throw new ApplicationError('INVALID_MONEY',400);
  }
}
