import { connectDatabase } from './infrastructure/database';
import { ensureQueues, sqs } from './infrastructure/sqs';
import { OutboxPublisher, WagerConsumer } from './infrastructure/workers';
import { WageringService } from './application/wagering-service';
import {QueryService} from './application/query-service';
import {metricText,processingMetricText} from './infrastructure/telemetry';
const orm = await connectDatabase();
const queues = await ensureQueues();
const publisher = new OutboxPublisher(orm,queues.events);
const consumer = new WagerConsumer(orm,queues.requests,queues.dlq);
const service = new WageringService(orm);
const queries=new QueryService(orm);
const metricsServer=Bun.serve({port:Number(process.env.WORKER_METRICS_PORT??3001),hostname:process.env.HOST??'127.0.0.1',
  async fetch(request){if(new URL(request.url).pathname!=='/metrics')return new Response('Not found',{status:404});
    try{return new Response(`${await queries.metrics()}\n${metricText()}\n${processingMetricText()}\n`,{headers:{'Content-Type':'text/plain; version=0.0.4'}});}catch{return new Response('Unavailable',{status:503});}}
});
let stopping = false;
for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,() => { stopping = true; });
async function loop(task: () => Promise<unknown>, pause: number) {
  while (!stopping) {
    try { await task(); } catch (error) {
      console.error(JSON.stringify({ level: 'error',event: 'worker_failure',code: error instanceof Error ? error.name : 'UNKNOWN' }));
      if(error instanceof Error && ['QueueDoesNotExist','AWS.SimpleQueueService.NonExistentQueue'].includes(error.name)){
        // LocalStack without persistence loses queues on restart. Recreate the known
        // topology idempotently; confirmed SQL outbox records remain available.
        try{await ensureQueues();}catch{console.error(JSON.stringify({level:'warn',event:'queue_topology_retry'}));}
      }
    }
    if (!stopping) await Bun.sleep(pause);
  }
}
try {
  await Promise.all([loop(() => consumer.pollOnce(),100),loop(() => publisher.publishOne(),100),loop(() => service.retryReferences(),1000)]);
} finally { await metricsServer.stop();sqs.destroy(); await orm.close(); }
