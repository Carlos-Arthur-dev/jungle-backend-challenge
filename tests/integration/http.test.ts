import {beforeAll,afterAll,expect,test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import {connectDatabase} from '../../src/infrastructure/database';
import {createApp} from '../../src/app';
import {WageringService} from '../../src/application/wagering-service';
const orm=await connectDatabase();
const app=await createApp(orm);let base='';
beforeAll(async()=>{await app.listen(0,'127.0.0.1');base=await app.getUrl();});
afterAll(async()=>{await app.close();await orm.close();});
async function request(path:string,method='GET',body?:unknown,key?:string){
  const response=await fetch(`${base}${path}`,{method,headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{}),'X-Correlation-Id':'http-contract-test'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return{status:response.status,body:await response.json(),headers:response.headers};
}
async function setup(){const playerId=randomUUID();const result=await request('/wallets','POST',{playerId,initialBalance:{amount:'100.00',currency:'BRL'}});
  expect(result.status).toBe(201);const walletId=result.body.id as string;
  return{walletId,input:{providerId:'http',externalTransactionId:randomUUID(),playerId,walletId,roundId:'r',gameId:'g',kind:'BET' as const,money:{amount:'25.00',currency:'BRL'}}};}
test('API cria, processa, consulta em camelCase, pagina ledger e reconcilia',async()=>{
  const {walletId,input}=await setup(),key=randomUUID();
  const result=await request('/wagering/transactions','POST',input,key);expect(result.status).toBe(200);expect(result.body.balance).toEqual({amount:'75.00',currency:'BRL'});
  const replay=await request('/wagering/transactions','POST',input,key);expect(replay.body).toEqual({...result.body,idempotentReplay:true});
  const internal=await request(`/wagering/transactions/${result.body.transactionId}`),external=await request(`/providers/http/wagering/transactions/${input.externalTransactionId}`);
  expect(internal.status).toBe(200);expect(internal.body).toEqual(external.body);expect(internal.body.transactionId).toBe(result.body.transactionId);
  expect(internal.body.money).toEqual(input.money);expect(internal.body).not.toHaveProperty('payload_hash');expect(internal.body).not.toHaveProperty('failure_code');
  const page=await request(`/wallets/${walletId}/ledger?limit=1`);expect(page.status).toBe(200);expect(page.body.items).toHaveLength(1);expect(typeof page.body.nextCursor).toBe('string');
  const last=await request(`/wallets/${walletId}/ledger?limit=1&cursor=${page.body.nextCursor}`);expect(last.body.items).toHaveLength(1);expect(last.body.nextCursor).toBeNull();
  const reconciled=await request(`/wallets/${walletId}/reconciliation`,'POST');expect(reconciled.status).toBe(200);expect(reconciled.body.consistent).toBe(true);
  expect(result.headers.get('x-correlation-id')).toBe('http-contract-test');
  const events=await orm.em.fork().execute<{payload:{correlationId:string;causationId:string}}[]>('select payload from outbox where payload->>\'causationId\'=?',[result.body.transactionId]);
  expect(events).toHaveLength(2);expect(events.every(event=>event.payload.correlationId==='http-contract-test')).toBe(true);
});
test('API distingue conflito, rejeição, pendência e wallet duplicada',async()=>{
  const {input}=await setup(),key=randomUUID();await request('/wagering/transactions','POST',input,key);
  const conflict=await request('/wagering/transactions','POST',{...input,money:{amount:'1.00',currency:'BRL'}},key);expect(conflict.status).toBe(409);expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
  const rejected=await request('/wagering/transactions','POST',{...input,externalTransactionId:randomUUID(),money:{amount:'1000.00',currency:'BRL'}},randomUUID());expect(rejected.status).toBe(422);expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
  const pending=await request('/wagering/transactions','POST',{...input,externalTransactionId:randomUUID(),kind:'REFUND',referenceExternalTransactionId:randomUUID()},randomUUID());expect(pending.status).toBe(202);expect(pending.body.status).toBe('PENDING_REFERENCE');
  const duplicate=await request('/wallets','POST',{playerId:input.playerId,initialBalance:{amount:'0.00',currency:'BRL'}});expect(duplicate.status).toBe(409);
  const overflow=await request('/wagering/transactions','POST',{...input,externalTransactionId:randomUUID(),kind:'WIN',money:{amount:'999999999999999999.99',currency:'BRL'}},randomUUID());expect(overflow.status).toBe(422);expect(overflow.body.failureCode).toBe('BALANCE_LIMIT_EXCEEDED');
});
test('API rejeita payloads inválidos, campos extras e dinheiro numérico',async()=>{
  const {input}=await setup();
  const invalid=[null,[],{}, {...input,extra:true},{...input,kind:'OPENING'},{...input,money:{amount:25,currency:'BRL'}},{...input,money:{amount:'1.001',currency:'BRL'}},{...input,kind:'REFUND'},{...input,playerId:'invalid'}];
  for(const value of invalid){const response=await request('/wagering/transactions','POST',value,randomUUID());expect(response.status).toBe(400);expect(typeof response.body.code).toBe('string');}
  expect((await request('/wagering/transactions','POST',input)).status).toBe(400);
  const malformed=await fetch(`${base}/wallets`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{broken'});expect(malformed.status).toBe(400);
});
test('paths e cursores inválidos retornam 400; recursos ausentes retornam 404',async()=>{
  const {walletId}=await setup();
  for(const path of ['/wallets/invalid','/wagering/transactions/invalid','/wallets/invalid/ledger'])expect((await request(path)).status).toBe(400);
  expect((await request('/wallets/invalid/reconciliation','POST')).status).toBe(400);
  for(const suffix of ['limit=0','limit=101','limit=1&limit=2','cursor=','cursor=invalid'])expect((await request(`/wallets/${walletId}/ledger?${suffix}`)).status).toBe(400);
  for(const path of [`/wallets/${randomUUID()}`,`/wallets/${randomUUID()}/ledger`,`/wagering/transactions/${randomUUID()}`,'/providers/missing/wagering/transactions/missing'])expect((await request(path)).status).toBe(404);
});
test('FAILED permanece terminal em replay e HTTP diferencia de falha transitória',async()=>{
  const {input}=await setup(),key=randomUUID();
  const result=await new WageringService(orm).recordPermanentFailure(input,key,{consumerName:'http-test',messageId:randomUUID()});
  const response=await request('/wagering/transactions','POST',input,key);expect(response.status).toBe(500);expect(response.body.status).toBe('FAILED');expect(response.body.transactionId).toBe(result.transactionId);
});
test('health e métricas respondem com contratos próprios',async()=>{
  expect((await request('/health/live')).body).toEqual({status:'ok'});expect((await request('/health/ready')).status).toBe(200);
  const metrics=await fetch(`${base}/metrics`);expect(metrics.headers.get('content-type')).toContain('text/plain');expect(await metrics.text()).toContain('jungle_processing_seconds');
});
