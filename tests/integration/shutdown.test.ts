import {afterAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {CreateQueueCommand,DeleteQueueCommand,SendMessageCommand,GetQueueAttributesCommand} from '@aws-sdk/client-sqs';
import {connectDatabase} from '../../src/infrastructure/database';
import {WageringService} from '../../src/application/wagering-service';
import {QueryService} from '../../src/application/query-service';
import {sqs} from '../../src/infrastructure/sqs';
// Windows does not deliver Unix SIGTERM gracefully. Run this test in the validation image.
const linuxTest=process.platform==='win32'?test.skip:test;
linuxTest('SIGTERM com mensagem em andamento aguarda commit e conclui ack',async()=>{
  const orm=await connectDatabase(),service=new WageringService(orm),suffix=randomUUID();
  const playerId=randomUUID(),wallet=await service.openWallet(playerId,{amount:'100.00',currency:'BRL'});
  const requests=(await sqs.send(new CreateQueueCommand({QueueName:`drain-${suffix}.fifo`,Attributes:{FifoQueue:'true'}}))).QueueUrl!;
  const dlq=(await sqs.send(new CreateQueueCommand({QueueName:`drain-dlq-${suffix}.fifo`,Attributes:{FifoQueue:'true'}}))).QueueUrl!;
  let child:ReturnType<typeof Bun.spawn>|undefined;
  try{
    await sqs.send(new SendMessageCommand({QueueUrl:requests,MessageGroupId:wallet.id,MessageDeduplicationId:suffix,MessageBody:JSON.stringify({
      messageId:suffix,type:'WagerTransactionRequested',data:{providerId:'shutdown',externalTransactionId:suffix,playerId,walletId:wallet.id,
        roundId:'r',gameId:'g',kind:'BET',money:{amount:'10.00',currency:'BRL'},idempotencyKey:suffix}})}));
    const running=Bun.spawn([process.execPath,'tests/fixtures/process-client.ts',JSON.stringify({requests,dlq,graceful:true})],{stdout:'pipe',stderr:'pipe'});child=running;
    const reader=running.stdout.getReader(),decoder=new TextDecoder();let text='';
    while(!text.includes('COMMITTED_BEFORE_ACK')){const value=await reader.read();if(value.done)throw new Error('EARLY_EXIT');text+=decoder.decode(value.value);}
    running.kill('SIGTERM');
    const stderr=await new Response(running.stderr).text();expect(await running.exited,stderr).toBe(0);reader.releaseLock();
    const attrs=await sqs.send(new GetQueueAttributesCommand({QueueUrl:requests,AttributeNames:['ApproximateNumberOfMessages','ApproximateNumberOfMessagesNotVisible']}));
    expect(attrs.Attributes?.ApproximateNumberOfMessages).toBe('0');expect(attrs.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe('0');
    expect((await service.getWallet(wallet.id)).balance.amount).toBe('90.00');expect((await new QueryService(orm).reconcile(wallet.id)).consistent).toBe(true);
  }finally{
    if(child&&child.exitCode===null){child.kill();await child.exited;}
    await sqs.send(new DeleteQueueCommand({QueueUrl:requests}));await sqs.send(new DeleteQueueCommand({QueueUrl:dlq}));await orm.close();
  }
},15000);
