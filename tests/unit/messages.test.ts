import {expect,test} from 'bun:test';
import {InboxMessage} from '../../src/domain/inbox-message';
import {OutboxMessage} from '../../src/domain/outbox-message';
import {WagerTransactionProcessed} from '../../src/domain/integration-event';
test('inbox controla transição e protege datas',()=>{
  const at=new Date(),message=InboxMessage.receive({messageId:'m',consumerName:'c',payloadHash:'h',receivedAt:at});
  expect(message.isProcessed()).toBe(false);message.markProcessed(at);expect(message.isProcessed()).toBe(true);
  expect(()=>message.markProcessed(at)).toThrow('INBOX_ALREADY_PROCESSED');
  const restored=InboxMessage.rehydrate({messageId:'m',consumerName:'c',payloadHash:'h',receivedAt:at,processedAt:at});
  expect(restored.isProcessed()).toBe(true);restored.processedAt!.setFullYear(2000);expect(restored.processedAt!.getFullYear()).toBe(at.getFullYear());
});
test('outbox retenta com backoff, preserva payload e bloqueia transição após publicação',()=>{
  const message=OutboxMessage.enqueue(WagerTransactionProcessed.from('wallet',{transactionId:'tx',nested:{value:1}}));
  const at=new Date();expect(message.isDue(at)).toBe(true);message.scheduleRetry(at);
  expect(message.attempts).toBe(1);expect(message.nextAttemptAt!.getTime()-at.getTime()).toBe(2000);expect(message.isDue(at)).toBe(false);
  (message.payload.data as {nested:{value:number}}).nested.value=2;
  expect((message.payload.data as {nested:{value:number}}).nested.value).toBe(1);
  message.markPublished(at);expect(message.isPending()).toBe(false);expect(()=>message.scheduleRetry(at)).toThrow('OUTBOX_ALREADY_PUBLISHED');
});
test('evento copia os dados de entrada e não expõe referência mutável no envelope',()=>{
  const data={transactionId:'tx',nested:{amount:'1.00'}};
  const event=WagerTransactionProcessed.from('wallet',data,{correlationId:'correlation',causationId:'cause'});
  data.nested.amount='2.00';
  (event.toJSON().data.nested as {amount:string}).amount='3.00';
  expect((event.toJSON().data.nested as {amount:string}).amount).toBe('1.00');
  expect(event.toJSON().correlationId).toBe('correlation');expect(event.toJSON().causationId).toBe('cause');
});
