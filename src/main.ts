import {createApp} from './app';
import {connectDatabase} from './infrastructure/database';
import {sqs} from './infrastructure/sqs';
const orm=await connectDatabase(),app=await createApp(orm);
await app.listen(Number(process.env.PORT??3000),process.env.HOST??'127.0.0.1');
let closing=false;
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,async()=>{
  if(closing)return;closing=true;await app.close();await orm.close();sqs.destroy();
});
