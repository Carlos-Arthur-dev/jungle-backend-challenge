import {afterAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {connectDatabase} from '../../src/infrastructure/database';
import {WageringService,type WagerInput} from '../../src/application/wagering-service';
import {QueryService} from '../../src/application/query-service';
const orm=await connectDatabase(),service=new WageringService(orm),queries=new QueryService(orm);
afterAll(async()=>{await orm.close();});
async function setup(){
  const playerId=randomUUID(),wallet=await service.openWallet(playerId,{amount:'100.00',currency:'BRL'});
  const input:WagerInput={providerId:'reversals',externalTransactionId:randomUUID(),playerId,walletId:wallet.id,
    roundId:'round',gameId:'game',kind:'BET',money:{amount:'10.00',currency:'BRL'}};
  const send=(changes:Partial<WagerInput>={})=>service.submit({...input,externalTransactionId:randomUUID(),...changes},randomUUID());
  return {input,wallet,send};
}
test('REFUND duplicado por referência não duplica crédito; ROLLBACK de REFUND debita',async()=>{
  const {input,wallet,send}=await setup();await send({externalTransactionId:input.externalTransactionId});
  const refundId=randomUUID();
  expect((await send({kind:'REFUND',externalTransactionId:refundId,referenceExternalTransactionId:input.externalTransactionId})).status).toBe('PROCESSED');
  expect((await send({kind:'REFUND',referenceExternalTransactionId:input.externalTransactionId})).failureCode).toBe('ALREADY_REVERSED');
  expect((await send({kind:'ROLLBACK',referenceExternalTransactionId:refundId})).status).toBe('PROCESSED');
  expect((await service.getWallet(wallet.id)).balance.amount).toBe('90.00');
  expect((await queries.reconcile(wallet.id)).consistent).toBe(true);
});
test('ROLLBACK de WIN sem saldo rejeita com código distinto e sem ledger',async()=>{
  const {wallet,send}=await setup(),win=randomUUID();
  await send({kind:'WIN',externalTransactionId:win});
  await send({money:{amount:'110.00',currency:'BRL'}});
  const rejected=await send({kind:'ROLLBACK',referenceExternalTransactionId:win});
  expect(rejected.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
  const ledger=await orm.em.fork().execute('select id from wallet_ledger where transaction_id=?',[rejected.transactionId]);
  expect(ledger).toHaveLength(0);expect((await queries.reconcile(wallet.id)).consistent).toBe(true);
});
test('reversões validam valor, espécie, rodada e moeda; LOSS preserva versão',async()=>{
  const {input,wallet,send}=await setup();await send({externalTransactionId:input.externalTransactionId});
  expect((await send({kind:'REFUND',referenceExternalTransactionId:input.externalTransactionId,money:{amount:'9.00',currency:'BRL'}})).failureCode).toBe('REVERSAL_AMOUNT_MISMATCH');
  expect((await send({kind:'REFUND',referenceExternalTransactionId:input.externalTransactionId,roundId:'other'})).failureCode).toBe('REFERENCE_MISMATCH');
  expect((await send({money:{amount:'1.00',currency:'USD'}})).failureCode).toBe('CURRENCY_MISMATCH');
  const before=await service.getWallet(wallet.id),loss=await send({kind:'LOSS',money:{amount:'0.00',currency:'BRL'}});
  expect(loss.status).toBe('PROCESSED');expect((await service.getWallet(wallet.id)).version).toBe(before.version);
  expect((await queries.reconcile(wallet.id)).consistent).toBe(true);
});
test('ROLLBACK antes da referência recupera e referência expirada rejeita',async()=>{
  const {input,wallet,send}=await setup();
  const pending=await send({kind:'ROLLBACK',referenceExternalTransactionId:input.externalTransactionId});
  await send({externalTransactionId:input.externalTransactionId});
  await orm.em.fork().execute('update wager_transactions set next_attempt_at=now() where id=?',[pending.transactionId]);
  await service.retryReferences();
  expect((await queries.transaction(pending.transactionId)).status).toBe('PROCESSED');
  const expired=await send({kind:'REFUND',referenceExternalTransactionId:randomUUID()});
  await orm.em.fork().execute('update wager_transactions set attempts=10,next_attempt_at=now() where id=?',[expired.transactionId]);
  await service.retryReferences();
  expect((await queries.transaction(expired.transactionId)).failure_code).toBe('REFERENCE_NOT_FOUND');
  expect((await service.getWallet(wallet.id)).balance.amount).toBe('100.00');expect((await queries.reconcile(wallet.id)).consistent).toBe(true);
});
