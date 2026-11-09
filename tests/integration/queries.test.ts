import {afterAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {connectDatabase} from '../../src/infrastructure/database';
import {WageringService} from '../../src/application/wagering-service';
import {QueryService} from '../../src/application/query-service';
const orm=await connectDatabase(),service=new WageringService(orm),queries=new QueryService(orm);
afterAll(async()=>{await orm.close();});
test('consulta por identidade interna/externa e paginação sem duplicações',async()=>{
  const playerId=randomUUID(),wallet=await service.openWallet(playerId,{amount:'100.00',currency:'BRL'});
  const externalTransactionId=randomUUID();
  const result=await service.submit({providerId:'queries',externalTransactionId,playerId,walletId:wallet.id,
    roundId:'round',gameId:'game',kind:'BET',money:{amount:'10.00',currency:'BRL'}},randomUUID());
  expect((await queries.transaction(result.transactionId)).status).toBe('PROCESSED');
  expect((await queries.providerTransaction('queries',externalTransactionId)).id).toBe(result.transactionId);
  const first=await queries.ledger(wallet.id,undefined,'1');
  expect(first.items).toHaveLength(1);expect(first.nextCursor).not.toBeNull();
  const second=await queries.ledger(wallet.id,first.nextCursor!,'1');
  expect(second.items).toHaveLength(1);expect(second.nextCursor).toBeNull();
  expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
  await expect(queries.ledger(randomUUID(),first.nextCursor!)).rejects.toThrow('INVALID_CURSOR');
  await expect(queries.ledger(wallet.id,'invalid')).rejects.toThrow('INVALID_CURSOR');
  await expect(queries.ledger(wallet.id,undefined,'1000')).rejects.toThrow('INVALID_LIMIT');
});
test('reconciliação retorna diferença e não corrige divergência silenciosamente',async()=>{
  const wallet=await service.openWallet(randomUUID(),{amount:'100.00',currency:'BRL'});
  expect((await queries.reconcile(wallet.id)).consistent).toBe(true);
  await orm.em.fork().execute('update wallets set balance=99 where id=?',[wallet.id]);
  try{
    const result=await queries.reconcile(wallet.id);
    expect(result.consistent).toBe(false);expect(result.difference.amount).toBe('-1.00');
    expect(result.calculatedBalance.amount).toBe('100.00');expect(result.checkedEntries).toBe(1);
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('99.00');
  }finally{await orm.em.fork().execute('update wallets set balance=100 where id=?',[wallet.id]);}
});
