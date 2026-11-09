import 'reflect-metadata';
import { Body, Controller, Get, Headers, Inject, Module, Param, Post, Res, Query, HttpException, ConsoleLogger,HttpCode } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ListQueuesCommand } from '@aws-sdk/client-sqs';
import { sqs } from './infrastructure/sqs';
import { QueryService } from './application/query-service';
import { requestContext, count, log, metricText,processingMetricText } from './infrastructure/telemetry';
import { NestFactory } from '@nestjs/core';
import { ApplicationError, WageringService } from './application/wagering-service';
import type {MikroORM} from '@mikro-orm/postgresql';
import {walletBody,wagerBody,text,uuid,scalarQuery,transactionView} from './application/http-contracts';

@Controller()
class ApiController {
  constructor(@Inject(WageringService) private readonly service: WageringService,
    @Inject(QueryService) private readonly queries: QueryService,@Inject('DATABASE') private readonly orm:MikroORM) {}
  @Get('health/live') live() { return { status: 'ok' }; }
  @Get('health/ready') async ready() {
    await Promise.all([this.orm.em.fork().execute('select 1'),sqs.send(new ListQueuesCommand({MaxResults:1}))]);
    return {status:'ok'};
  }
  @Get('metrics') async metrics(@Res({passthrough:true}) response:{type(value:string):void}) {
    response.type('text/plain; version=0.0.4');
    return `${await this.queries.metrics()}\n${metricText()}\n${processingMetricText()}\n`;
  }
  @Get('wagering/transactions/:id') async transaction(@Param('id') id:string) { return transactionView(await this.queries.transaction(uuid(id))); }
  @Get('providers/:providerId/wagering/transactions/:externalId') async providerTransaction(@Param('providerId') provider:string,@Param('externalId') external:string) { return transactionView(await this.queries.providerTransaction(text(provider),text(external))); }
  @Get('wallets/:id/ledger') ledger(@Param('id') id:string,@Query('cursor') cursor?:unknown,@Query('limit') limit?:unknown) { return this.queries.ledger(uuid(id),scalarQuery(cursor,'INVALID_CURSOR'),scalarQuery(limit,'INVALID_LIMIT')); }
  @Post('wallets/:id/reconciliation') @HttpCode(200) reconcile(@Param('id') id:string) { return this.queries.reconcile(uuid(id)); }
  @Post('wallets') open(@Body() body: unknown) {
    const input=walletBody(body);return this.service.openWallet(input.playerId,input.initialBalance);
  }
  @Get('wallets/:id') wallet(@Param('id') id: string) { return this.service.getWallet(uuid(id)); }
  @Post('wagering/transactions') async submit(@Body() input: unknown, @Headers('idempotency-key') key: unknown,
    @Res({ passthrough: true }) response: { status(code: number): void }) {
    const result = await this.service.submit(wagerBody(input),text(key,'INVALID_IDEMPOTENCY_KEY'));
    response.status(result.status==='FAILED'?500:result.status === 'REJECTED' ? 422 : result.status === 'PENDING_REFERENCE' ? 202 : 200);
    return result;
  }
}
export async function createApp(orm:MikroORM){
@Module({ controllers: [ApiController], providers: [{provide:'DATABASE',useValue:orm},{ provide: WageringService, useValue: new WageringService(orm) },{provide:QueryService,useValue:new QueryService(orm)}] })
class AppModule {}
const app = await NestFactory.create(AppModule,{logger:new ConsoleLogger({json:true})});
app.use((request:{headers:Record<string,string|undefined>;method:string;path:string},response:{setHeader(name:string,value:string):void;on(event:string,callback:()=>void):void;statusCode:number},next:()=>void)=>{
  const supplied=request.headers['x-correlation-id'];
  const correlationId=supplied && /^[a-zA-Z0-9_-]{1,128}$/.test(supplied) ? supplied : randomUUID();
  response.setHeader('X-Correlation-Id',correlationId);
  const start=performance.now();
  requestContext.run({correlationId},()=>{
    response.on('finish',()=>{count('jungle_http_requests_total');count('jungle_http_duration_seconds_sum',(performance.now()-start)/1000);
      log('http_completed',{correlationId,method:request.method,status:response.statusCode});}); next();
  });
});
app.useGlobalFilters({ catch(error: unknown, host) {
  const err = error as { message?: string; code?: string };
  const status = error instanceof HttpException ? error.getStatus() : error instanceof ApplicationError ? error.httpStatus
    : 503;
  host.switchToHttp().getResponse().status(status).json({ code: error instanceof ApplicationError ? error.code : status === 400 ? 'INVALID_PAYLOAD' : status < 500 ? 'HTTP_ERROR' : 'INFRASTRUCTURE_UNAVAILABLE' });
} });
return app;
}
