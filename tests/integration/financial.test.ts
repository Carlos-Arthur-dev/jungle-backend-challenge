import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { connectDatabase } from '../../src/infrastructure/database';
import { WageringService, type WagerInput } from '../../src/application/wagering-service';
const orm = await connectDatabase();
const service = new WageringService(orm);
beforeAll(async () => { await orm.migrator.up(); });
afterAll(async () => { await orm.close(); });
const money = (amount: string) => ({ amount, currency: 'BRL' });
function wager(walletId: string, playerId: string, externalTransactionId = randomUUID()): WagerInput {
  return { providerId: 'integration', walletId, playerId, externalTransactionId, roundId: 'round', gameId: 'game', kind: 'BET', money: money('80.00') };
}
test('duas apostas concorrentes: um débito, uma rejeição e reconciliação exata', async () => {
  const playerId = randomUUID();
  const wallet = await service.openWallet(playerId,money('100.00'));
  const results = await Promise.all([service.submit(wager(wallet.id,playerId),randomUUID()),service.submit(wager(wallet.id,playerId),randomUUID())]);
  expect(results.filter(r => r.status === 'PROCESSED')).toHaveLength(1);
  expect(results.filter(r => r.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(1);
  expect((await service.getWallet(wallet.id)).balance.amount).toBe('20.00');
  const rows = await orm.em.fork().execute<{ calculated: string; debits: number }[]>(`select sum(case direction when 'CREDIT' then amount else -amount end)::text calculated, count(*) filter(where direction='DEBIT')::int debits from wallet_ledger where wallet_id=?`, [wallet.id]);
  expect(rows[0]?.calculated).toBe('20.00'); expect(rows[0]?.debits).toBe(1);
});
test('50 envios paralelos persistem um único efeito e replay guarda saldo original', async () => {
  const playerId = randomUUID(), wallet = await service.openWallet(playerId,money('100.00'));
  const input = wager(wallet.id,playerId), key = randomUUID();
  const results = await Promise.all(Array.from({ length: 50 }, () => service.submit(input,key)));
  expect(new Set(results.map(r => r.transactionId)).size).toBe(1);
  expect(results.filter(r => !r.idempotentReplay)).toHaveLength(1);
  expect((await service.getWallet(wallet.id)).balance.amount).toBe('20.00');
  await service.submit({ ...wager(wallet.id,playerId), kind: 'WIN', money: money('10.00') },randomUUID());
  expect((await service.submit(input,key)).balance.amount).toBe('20.00');
  await expect(service.submit({ ...input, money: money('1.00') },key)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
});
test('schema bloqueia alteração do ledger e saldo negativo', async () => {
  const playerId = randomUUID(), wallet = await service.openWallet(playerId,money('100.00'));
  await expect(orm.em.fork().execute('update wallet_ledger set amount=amount where wallet_id=?',[wallet.id])).rejects.toThrow('LEDGER_IS_IMMUTABLE');
  await expect(orm.em.fork().execute('update wallets set balance=-1 where id=?',[wallet.id])).rejects.toThrow();
});
