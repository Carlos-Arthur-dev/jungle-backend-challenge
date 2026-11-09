import { connectDatabase } from '../../src/infrastructure/database';
import { WageringService, type WagerInput } from '../../src/application/wagering-service';
import { WagerConsumer,OutboxPublisher } from '../../src/infrastructure/workers';
const config = JSON.parse(process.argv[2]!) as {input:WagerInput;key:string;startAt:number;requests?:string;dlq?:string;events?:string;graceful?:boolean};
let finishDrain:()=>void=()=>{};
const drainSignal=new Promise<void>(resolve=>{finishDrain=resolve;});
if(config.graceful)process.once('SIGTERM',()=>finishDrain());
const orm=await connectDatabase();
try {
  if(config.events){
    await Bun.sleep(Math.max(0,config.startAt-Date.now()));
    const publisher=new OutboxPublisher(orm,config.events);let published=0;
    while(published<500 && await publisher.publishOne())published++;
    console.log(JSON.stringify({checkpoint:'PUBLISHED',pid:process.pid,published}));
  }else if (config.requests && config.dlq) {
    await new WagerConsumer(orm,config.requests,config.dlq,async receipt=>{
      console.log(JSON.stringify({checkpoint:'COMMITTED_BEFORE_ACK',receipt,pid:process.pid}));
      if(config.graceful)await drainSignal;else await new Promise<void>(()=>{});
    }).pollOnce();
  } else {
    await Bun.sleep(Math.max(0,config.startAt-Date.now()));
    const result=await new WageringService(orm).submit(config.input,config.key);
    console.log(JSON.stringify({checkpoint:'RESULT',pid:process.pid,result}));
  }
}finally{await orm.close();}
