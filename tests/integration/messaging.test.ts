import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ReceiveMessageCommand, SendMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { connectDatabase } from '../../src/infrastructure/database';
import { WageringService, type WagerInput } from '../../src/application/wagering-service';
import { ensureQueues, sqs } from '../../src/infrastructure/sqs';
import { OutboxPublisher, WagerConsumer } from '../../src/infrastructure/workers';
const orm = await connectDatabase();
const queues = await ensureQueues();
const service = new WageringService(orm);
afterAll(async () => { await orm.close(); });
async function setup() {
  const playerId = randomUUID(), wallet = await service.openWallet(playerId,{amount:'100.00',currency:'BRL'});
  const input: WagerInput = { providerId:'messaging',externalTransactionId:randomUUID(),playerId,walletId:wallet.id,
    roundId:'round',gameId:'game',kind:'BET',money:{amount:'10.00',currency:'BRL'} };
  return { input,wallet };
}
test('inbox deduplica redelivery após commit e registra atomically outbox e ledger', async () => {
  const { input,wallet } = await setup();
  const key = randomUUID(), ctx = {consumerName:'test',messageId:randomUUID()};
  await service.submit(input,key,ctx);
  expect((await service.submit(input,key,ctx)).idempotentReplay).toBe(true);
  expect((await service.getWallet(wallet.id)).balance.amount).toBe('90.00');
  const inbox = await orm.em.fork().execute('select * from inbox where consumer_name=? and message_id=?',[ctx.consumerName,ctx.messageId]);
  expect(inbox).toHaveLength(1); expect(inbox[0]?.processed_at).not.toBeNull();
  await expect(service.submit({...input,money:{amount:'1.00',currency:'BRL'}},key,ctx)).rejects.toThrow('INBOX_PAYLOAD_CONFLICT');
});
test('REFUND antes de BET é reprocessado uma única vez por workers concorrentes', async () => {
  const { input,wallet } = await setup();
  const refund = {...input,externalTransactionId:randomUUID(),kind:'REFUND' as const,referenceExternalTransactionId:input.externalTransactionId};
  const pending = await service.submit(refund,randomUUID()); expect(pending.status).toBe('PENDING_REFERENCE');
  await service.submit(input,randomUUID());
  await orm.em.fork().execute('update wager_transactions set next_attempt_at=now() where id=?',[pending.transactionId]);
  await Promise.all([service.retryReferences(),service.retryReferences()]);
  const rows = await orm.em.fork().execute('select status from wager_transactions where id=?',[pending.transactionId]);
  expect(rows[0]?.status).toBe('PROCESSED');
  expect((await service.getWallet(wallet.id)).balance.amount).toBe('100.00');
});
test('SQS real processa envelope e confirma depois do commit', async () => {
  const { input,wallet } = await setup(), messageId = randomUUID();
  await sqs.send(new SendMessageCommand({ QueueUrl:queues.requests,MessageBody:JSON.stringify({messageId,type:'WagerTransactionRequested',occurredAt:new Date().toISOString(),data:{...input,idempotencyKey:randomUUID()}}),MessageGroupId:wallet.id,MessageDeduplicationId:messageId }));
  const consumer = new WagerConsumer(orm,queues.requests,queues.dlq);
  expect(await consumer.pollOnce()).toBe(1);
  expect((await service.getWallet(wallet.id)).balance.amount).toBe('90.00');
});
test('publishers concorrentes recuperam outbox persistente e publicam no LocalStack', async () => {
  const {input} = await setup(); await service.submit(input,randomUUID());
  const first = new OutboxPublisher(orm,queues.events),second = new OutboxPublisher(orm,queues.events);
  for (let i=0;i<300;i++) {
    const results = await Promise.all([first.publishOne(),second.publishOne()]);
    if (results.every(value => !value)) break;
  }
  const rows = await orm.em.fork().execute<{published_at: Date | null}[]>('select published_at from outbox where aggregate_id=?',[input.walletId]);
  expect(rows.length).toBeGreaterThan(0); expect(rows.every(row => row.published_at !== null)).toBe(true);
  const events = await sqs.send(new ReceiveMessageCommand({ QueueUrl:queues.events,MaxNumberOfMessages:1,WaitTimeSeconds:1 }));
  expect(events.Messages?.length).toBe(1);
});
test('payload permanente inválido chega à DLQ', async () => {
  await sqs.send(new SendMessageCommand({QueueUrl:queues.requests,MessageBody:'{"invalid":true}',MessageGroupId:randomUUID(),MessageDeduplicationId:randomUUID()}));
  await new WagerConsumer(orm,queues.requests,queues.dlq).pollOnce();
  const result = await sqs.send(new GetQueueAttributesCommand({QueueUrl:queues.dlq,AttributeNames:['ApproximateNumberOfMessages']}));
  expect(Number(result.Attributes?.ApproximateNumberOfMessages)).toBeGreaterThan(0);
});
test('falha ao gravar outbox desfaz inbox, saldo, ledger e transação', async () => {
  const { input,wallet } = await setup();
  const name = `fail_${randomUUID().replaceAll('-','')}`;
  // Trigger restrito a esta carteira: não interfere em testes de outras conexões.
  await orm.em.fork().execute(`create function ${name}() returns trigger language plpgsql as $$ begin
    if NEW.aggregate_id='${wallet.id}'::uuid then raise exception 'INJECTED_FAILURE'; end if; return NEW; end $$`);
  await orm.em.fork().execute(`create trigger ${name} before insert on outbox for each row execute function ${name}()`);
  const ctx = {consumerName:'atomicity-test',messageId:randomUUID()};
  try {
    await expect(service.submit(input,randomUUID(),ctx)).rejects.toThrow('INJECTED_FAILURE');
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('100.00');
    const tx = await orm.em.fork().execute('select id from wager_transactions where provider_id=? and external_transaction_id=?',[input.providerId,input.externalTransactionId]);
    const inbox = await orm.em.fork().execute('select * from inbox where consumer_name=? and message_id=?',[ctx.consumerName,ctx.messageId]);
    const ledger = await orm.em.fork().execute("select * from wallet_ledger where wallet_id=? and direction='DEBIT'",[wallet.id]);
    expect(tx).toHaveLength(0); expect(inbox).toHaveLength(0); expect(ledger).toHaveLength(0);
  } finally {
    await orm.em.fork().execute(`drop trigger ${name} on outbox; drop function ${name}()`);
  }
});
