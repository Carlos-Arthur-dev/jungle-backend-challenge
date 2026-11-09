import {afterAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {connectDatabase} from '../../src/infrastructure/database';
import {WageringService,type WagerInput} from '../../src/application/wagering-service';
import {OutboxPublisher} from '../../src/infrastructure/workers';
import {ensureQueues} from '../../src/infrastructure/sqs';
const orm=await connectDatabase(),service=new WageringService(orm);
afterAll(async()=>{await orm.close();});
async function setup(){const playerId=randomUUID(),wallet=await service.openWallet(playerId,{amount:'100.00',currency:'BRL'});
  const input:WagerInput={providerId:'review',externalTransactionId:randomUUID(),playerId,walletId:wallet.id,roundId:'r',gameId:'g',kind:'BET',money:{amount:'10.00',currency:'BRL'}};return{input,wallet};}
test('schema não confirma transação financeira sem lançamento',async()=>{
  const {input}=await setup(),id=randomUUID();
  await expect(orm.em.fork().transactional(async em=>{
    await em.execute(`insert into wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,created_at)
      values (?,'review',?,?,'hash',?,?,'r','g','BET',10,'BRL','PROCESSED',now())`,[id,id,id,input.walletId,input.playerId]);
  })).rejects.toThrow('PROCESSED_TRANSACTION_REQUIRES_LEDGER');
});
test('schema rejeita ledger com valor divergente ou direção errada',async()=>{
  const {input}=await setup();
  for(const invalidAmount of [true,false]){
    const id=randomUUID();
    await expect(orm.em.fork().transactional(async em=>{
      await em.execute(`insert into wager_transactions(id,provider_id,external_transaction_id,idempotency_key,payload_hash,wallet_id,player_id,round_id,game_id,kind,amount,currency,status,created_at)
        values (?,'review',?,?,'hash',?,?,'r','g','BET',10,'BRL','PENDING',now())`,[id,id,id,input.walletId,input.playerId]);
      await em.execute(`insert into wallet_ledger values (?,?,?,'CREDIT',?,'BRL',100,?,now())`,[randomUUID(),input.walletId,id,invalidAmount?'9.00':'10.00',invalidAmount?'109.00':'110.00']);
      await em.execute("update wager_transactions set status='PROCESSED' where id=?",[id]);
    })).rejects.toThrow(invalidAmount?'ledger_matches_transaction':'INVALID_LEDGER_DIRECTION');
  }
});
test('replay preserva processedAt da inbox e schema bloqueia alteração posterior',async()=>{
  const {input}=await setup(),key=randomUUID(),ctx={messageId:randomUUID(),consumerName:'review'};
  await service.submit(input,key,ctx);
  const before=await orm.em.fork().execute<{processed_at:Date}[]>('select processed_at from inbox where message_id=?',[ctx.messageId]);
  await service.submit(input,key,ctx);
  const after=await orm.em.fork().execute<{processed_at:Date}[]>('select processed_at from inbox where message_id=?',[ctx.messageId]);
  expect(new Date(after[0]!.processed_at).getTime()).toBe(new Date(before[0]!.processed_at).getTime());
  await expect(orm.em.fork().execute('delete from wager_transactions where idempotency_key=?',[key])).rejects.toThrow('TRANSACTION_IS_IMMUTABLE');
  await expect(orm.em.fork().execute('update inbox set processed_at=now() where message_id=?',[ctx.messageId])).rejects.toThrow('INBOX_IS_IMMUTABLE');
});
test('retry respeita backoff e TTL mesmo quando referência chega tarde',async()=>{
  const {input}=await setup(),refund={...input,kind:'REFUND' as const,externalTransactionId:randomUUID(),referenceExternalTransactionId:input.externalTransactionId};
  const pending=await service.submit(refund,randomUUID());
  await orm.em.fork().execute("update wager_transactions set next_attempt_at=now()+interval '1 hour' where id=?",[pending.transactionId]);
  await service.retryReferences();
  const attempts=await orm.em.fork().execute<{attempts:number}[]>('select attempts from wager_transactions where id=?',[pending.transactionId]);expect(attempts[0]!.attempts).toBe(1);
  await service.submit(input,randomUUID());
  await orm.em.fork().execute('update wager_transactions set attempts=10,next_attempt_at=now() where id=?',[pending.transactionId]);await service.retryReferences();
  const result=await orm.em.fork().execute<{status:string;failure_code:string}[]>('select status,failure_code from wager_transactions where id=?',[pending.transactionId]);
  expect(result[0]!.status).toBe('REJECTED');expect(result[0]!.failure_code).toBe('REFERENCE_NOT_FOUND');
});
test('abertura e envelopes persistem dados estáveis e completos',async()=>{
  const {wallet}=await setup();
  const opening=await orm.em.fork().execute<{result:{balance:{amount:string}}}[]>("select result from wager_transactions where wallet_id=? and kind='OPENING'",[wallet.id]);expect(opening[0]!.result.balance.amount).toBe('100.00');
  const events=await orm.em.fork().execute<{payload:Record<string,unknown>}[]>('select payload from outbox where aggregate_id=?',[wallet.id]);
  expect(events).toHaveLength(2);for(const {payload} of events){expect(payload.version).toBe(1);expect(typeof payload.eventId).toBe('string');expect(typeof payload.causationId).toBe('string');}
});
test('envio confirmado com falha na marcação SQL mantém evento recuperável',async()=>{
  const queues=await ensureQueues(),publisher=new OutboxPublisher(orm,queues.events);
  for(let i=0;i<300&&await publisher.publishOne();i++){}
  const {wallet}=await setup(),name=`mark_${randomUUID().replaceAll('-','')}`;
  await orm.em.fork().execute(`create function ${name}() returns trigger language plpgsql as $$ begin
    if NEW.aggregate_id='${wallet.id}'::uuid and NEW.published_at is not null then raise exception 'MARK_FAILURE';end if;return NEW;end $$`);
  await orm.em.fork().execute(`create trigger ${name} before update on outbox for each row execute function ${name}()`);
  try{
    await expect(publisher.publishOne()).rejects.toThrow('MARK_FAILURE');
    const pending=await orm.em.fork().execute('select id from outbox where aggregate_id=? and published_at is null',[wallet.id]);expect(pending).toHaveLength(2);
  }finally{await orm.em.fork().execute(`drop trigger ${name} on outbox;drop function ${name}()`);}
  await publisher.publishOne();await publisher.publishOne();
  const pending=await orm.em.fork().execute('select id from outbox where aggregate_id=? and published_at is null',[wallet.id]);expect(pending).toHaveLength(0);
},60000);
