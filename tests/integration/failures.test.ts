import {afterAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {CreateQueueCommand,DeleteQueueCommand,SendMessageCommand,GetQueueAttributesCommand} from '@aws-sdk/client-sqs';
import {connectDatabase} from '../../src/infrastructure/database';
import {sqs} from '../../src/infrastructure/sqs';
import {WagerConsumer} from '../../src/infrastructure/workers';
import {WageringService} from '../../src/application/wagering-service';
import {QueryService} from '../../src/application/query-service';
const orm=await connectDatabase(),service=new WageringService(orm),queries=new QueryService(orm);
afterAll(async()=>{await orm.close();});
for(const [state,expected] of [['0A000','FAILED'],['40001','PROCESSED']] as const){
  test(`falha SQL ${state}: ${expected==='FAILED'?'audita FAILED sem movimentar saldo':'retenta após recuperação sem duplicar débito'}`,async()=>{
    const suffix=randomUUID().replaceAll('-',''),name=`fail_${suffix}`;
    const playerId=randomUUID(),wallet=await service.openWallet(playerId,{amount:'100.00',currency:'BRL'});
    const requests=(await sqs.send(new CreateQueueCommand({QueueName:`failure-${suffix}.fifo`,Attributes:{FifoQueue:'true'}}))).QueueUrl!;
    const dlq=(await sqs.send(new CreateQueueCommand({QueueName:`failure-dlq-${suffix}.fifo`,Attributes:{FifoQueue:'true'}}))).QueueUrl!;
    const key=randomUUID();
    await orm.em.fork().execute(`create function ${name}() returns trigger language plpgsql as $$ begin
      if NEW.id='${wallet.id}'::uuid then raise exception 'TEST_INFRASTRUCTURE' using errcode='${state}';end if;return NEW;end $$`);
    await orm.em.fork().execute(`create trigger ${name} before update on wallets for each row execute function ${name}()`);
    let triggerExists=true;
    try{
      await sqs.send(new SendMessageCommand({QueueUrl:requests,MessageGroupId:wallet.id,MessageDeduplicationId:key,
        MessageBody:JSON.stringify({messageId:key,type:'WagerTransactionRequested',data:{providerId:'failure-test',externalTransactionId:key,
          playerId,walletId:wallet.id,roundId:'r',gameId:'g',kind:'BET',money:{amount:'10.00',currency:'BRL'},idempotencyKey:key}})}));
      const consumer=new WagerConsumer(orm,requests,dlq);expect(await consumer.pollOnce()).toBe(1);
      expect((await service.getWallet(wallet.id)).balance.amount).toBe('100.00');
      if(state==='40001'){
        const unfinished=await orm.em.fork().execute('select id from wager_transactions where idempotency_key=?',[key]);expect(unfinished).toHaveLength(0);
        await orm.em.fork().execute(`drop trigger ${name} on wallets;drop function ${name}()`);triggerExists=false;
        await Bun.sleep(2200);expect(await consumer.pollOnce()).toBe(1);
        expect((await service.getWallet(wallet.id)).balance.amount).toBe('90.00');
      }else{
        const attrs=await sqs.send(new GetQueueAttributesCommand({QueueUrl:dlq,AttributeNames:['ApproximateNumberOfMessages']}));
        expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe('1');
      }
      const rows=await orm.em.fork().execute<{id:string;status:string;failure_code:string|null}[]>('select id,status,failure_code from wager_transactions where idempotency_key=?',[key]);
      expect(rows[0]!.status).toBe(expected);
      if(state==='0A000'){
        expect(rows[0]!.failure_code).toBe('INFRASTRUCTURE_FAILURE');
        const ledger=await orm.em.fork().execute('select id from wallet_ledger where transaction_id=?',[rows[0]!.id]);expect(ledger).toHaveLength(0);
      }
      expect((await queries.reconcile(wallet.id)).consistent).toBe(true);
    }finally{
      if(triggerExists)await orm.em.fork().execute(`drop trigger ${name} on wallets;drop function ${name}()`);
      await sqs.send(new DeleteQueueCommand({QueueUrl:requests}));await sqs.send(new DeleteQueueCommand({QueueUrl:dlq}));
    }
  },15000);
}
