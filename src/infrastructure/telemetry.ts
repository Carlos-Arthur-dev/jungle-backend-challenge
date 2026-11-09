import { AsyncLocalStorage } from 'node:async_hooks';
export const requestContext = new AsyncLocalStorage<{correlationId: string;causationId?:string}>();
const counters = new Map<string,number>(['jungle_duplicates_total','jungle_retries_total','jungle_dlq_total',
  'jungle_lock_conflicts_total','jungle_outbox_retries_total','jungle_reconciliation_divergences_total',
  'jungle_http_requests_total','jungle_http_duration_seconds_sum'].map(name=>[name,0]));
export function count(name: string, amount = 1) { counters.set(name,(counters.get(name) ?? 0)+amount); }
export function log(event: string, fields: Record<string,unknown> = {}) {
  console.log(JSON.stringify({ level:'info',event,correlationId:requestContext.getStore()?.correlationId,...fields }));
}
export function metricText() { return [...counters].map(([name,value]) => `${name} ${value}`).join('\n'); }
const buckets=[0.005,0.01,0.025,0.05,0.1,0.25,0.5,1,2.5,5,10];
const observations=buckets.map(()=>0);let durationSum=0,durationCount=0;
export function observeProcessing(seconds:number){durationCount++;durationSum+=seconds;buckets.forEach((bound,index)=>{if(seconds<=bound)observations[index]=(observations[index]??0)+1;});}
export function processingMetricText(){return buckets.map((bound,index)=>`jungle_processing_seconds_bucket{le="${bound}"} ${observations[index]}`).join('\n')+
  `\njungle_processing_seconds_bucket{le="+Inf"} ${durationCount}\njungle_processing_seconds_count ${durationCount}\njungle_processing_seconds_sum ${durationSum}`;}
