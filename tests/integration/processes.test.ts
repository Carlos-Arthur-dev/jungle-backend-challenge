import {afterAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {CreateQueueCommand,SendMessageCommand,ChangeMessageVisibilityCommand,GetQueueAttributesCommand,DeleteQueueCommand} from '@aws-sdk/client-sqs';
import {connectDatabase} from '../../src/infrastructure/database';
import {WageringService,type WagerInput,type WagerResult} from '../../src/application/wagering-service';
import {QueryService} from '../../src/application/query-service';
import {WagerConsumer,OutboxPublisher} from '../../src/infrastructure/workers';
import {sqs,ensureQueues} from '../../src/infrastructure/sqs';
const orm=await connectDatabase(),service=new WageringService(orm),queries=new QueryService(orm);
afterAll(async()=>{await orm.close();});
async function setup(){
  const playerId=randomUUID(),wallet=await service.openWallet(playerId,{amount:'100.00',currency:'BRL'});
  const input:WagerInput={providerId:'processes',externalTransactionId:randomUUID(),playerId,walletId:wallet.id,
    roundId:'r',gameId:'g',kind:'BET',money:{amount:'80.00',currency:'BRL'}};
  return {input,wallet};
}
function spawn(config:unknown){return Bun.spawn([process.execPath,'tests/fixtures/process-client.ts',JSON.stringify(config)],{stdout:'pipe',stderr:'pipe',timeout:45000});}
test('erro de envio preserva outbox e dois publishers em processos separados recuperam',async()=>{
  const queues=await ensureQueues();
  const {wallet}=await setup();
  const due=await orm.em.fork().execute<{id:string}[]>("select id from outbox where published_at is null and next_attempt_at<=now() order by occurred_at,id limit 1");
  const id=due[0]!.id;
  // Fila inexistente simula falha real do transporte, sem mock do SDK.
  await new OutboxPublisher(orm,queues.events.replace('wager-events.fifo',`missing-${randomUUID()}.fifo`)).publishOne();
  const failed=await orm.em.fork().execute<{attempts:number;published_at:Date|null}[]>('select attempts,published_at from outbox where id=?',[id]);
  expect(failed[0]!.attempts).toBeGreaterThan(0);expect(failed[0]!.published_at).toBeNull();
  await orm.em.fork().execute('update outbox set next_attempt_at=now() where id=?',[id]);
  const startAt=Date.now()+2000,children=[spawn({events:queues.events,startAt}),spawn({events:queues.events,startAt})];
  const pids=await Promise.all(children.map(async child=>{
    const output=await new Response(child.stdout).text(),err=await new Response(child.stderr).text();expect(await child.exited,err).toBe(0);
    return JSON.parse(output.trim().split('\n').find(line=>line.includes('"checkpoint":"PUBLISHED"'))!).pid;
  }));
  expect(new Set(pids).size).toBe(2);
  const pending=await orm.em.fork().execute('select id from outbox where aggregate_id=? and published_at is null',[wallet.id]);
  expect(pending).toHaveLength(0);expect((await queries.reconcile(wallet.id)).consistent).toBe(true);
},60000);
test('carteiras distintas são processadas em três processos independentes',async()=>{
  const setups=await Promise.all([setup(),setup(),setup()]),startAt=Date.now()+2000;
  const children=setups.map(({input})=>spawn({input,key:randomUUID(),startAt}));
  await Promise.all(children.map(async child=>{
    const output=await new Response(child.stdout).text(),error=await new Response(child.stderr).text();
    expect(await child.exited,error).toBe(0);expect(output).toContain('"status":"PROCESSED"');
  }));
  for(const {wallet} of setups){expect((await service.getWallet(wallet.id)).balance.amount).toBe('20.00');expect((await queries.reconcile(wallet.id)).consistent).toBe(true);}
},60000);
test('três processos disputam a mesma carteira; reinício preserva replay e ledger',async()=>{
  const {input,wallet}=await setup(),startAt=Date.now()+2500;
  const key=randomUUID();
  const configs=[{input,key,startAt},{input:{...input,externalTransactionId:randomUUID()},key:randomUUID(),startAt},{input,key,startAt}];
  const children=configs.map(spawn);
  const outputs=await Promise.all(children.map(async child=>{
    const output=await new Response(child.stdout).text(),err=await new Response(child.stderr).text();
    expect(await child.exited,err).toBe(0);
    return JSON.parse(output.trim().split('\n').find(line=>line.includes('"checkpoint":"RESULT"'))!) as {pid:number;result:WagerResult};
  }));
  expect(new Set(outputs.map(r=>r.pid)).size).toBe(3);
  expect(new Set(outputs.map(r=>r.result.transactionId)).size).toBe(2);
  expect((await service.getWallet(wallet.id)).balance.amount).toBe('20.00');
  expect(outputs.filter(r=>r.result.status==='REJECTED').length).toBeGreaterThan(0);
  const fresh=await connectDatabase();
  try{expect((await new WageringService(fresh).submit(input,key)).idempotentReplay).toBe(true);}finally{await fresh.close();}
  expect((await queries.reconcile(wallet.id)).consistent).toBe(true);
},60000);
test('worker morto após commit e antes do ack: nova instância reprocessa sem novo débito',async()=>{
  const {input,wallet}=await setup(),suffix=randomUUID();
  const requests=(await sqs.send(new CreateQueueCommand({QueueName:`crash-${suffix}.fifo`,Attributes:{FifoQueue:'true'}}))).QueueUrl!;
  const dlq=(await sqs.send(new CreateQueueCommand({QueueName:`crash-dlq-${suffix}.fifo`,Attributes:{FifoQueue:'true'}}))).QueueUrl!;
  let child:ReturnType<typeof spawn>|undefined;
  try{
    await sqs.send(new SendMessageCommand({QueueUrl:requests,MessageGroupId:wallet.id,MessageDeduplicationId:suffix,
      MessageBody:JSON.stringify({messageId:suffix,type:'WagerTransactionRequested',data:{...input,idempotencyKey:suffix}})}));
    child=spawn({input,key:suffix,startAt:0,requests,dlq});
    const reader=child.stdout.getReader(),decoder=new TextDecoder();let buffer='',receipt='';
    const checkpoint=async()=>{
      while(!receipt){const chunk=await reader.read();if(chunk.done)throw new Error('WORKER_EXITED_BEFORE_CHECKPOINT');buffer+=decoder.decode(chunk.value);
        for(const line of buffer.split('\n')){if(line.includes('"checkpoint":"COMMITTED_BEFORE_ACK"'))receipt=JSON.parse(line).receipt;}}
    };
    await Promise.race([checkpoint(),Bun.sleep(30000).then(()=>{throw new Error('CHECKPOINT_TIMEOUT');})]);
    child.kill();await child.exited;reader.releaseLock();
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('20.00');
    await sqs.send(new ChangeMessageVisibilityCommand({QueueUrl:requests,ReceiptHandle:receipt,VisibilityTimeout:0}));
    expect(await new WagerConsumer(orm,requests,dlq).pollOnce()).toBe(1);
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('20.00');
    expect((await queries.reconcile(wallet.id)).consistent).toBe(true);
    const attrs=await sqs.send(new GetQueueAttributesCommand({QueueUrl:requests,AttributeNames:['ApproximateNumberOfMessages','ApproximateNumberOfMessagesNotVisible']}));
    expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe('0');expect(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe('0');
  }finally{
    if(child && child.exitCode===null){child.kill();await child.exited;}
    await sqs.send(new DeleteQueueCommand({QueueUrl:requests}));await sqs.send(new DeleteQueueCommand({QueueUrl:dlq}));
  }
},60000);

