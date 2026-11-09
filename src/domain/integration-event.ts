import { randomUUID } from 'node:crypto';
export interface EventContext {correlationId?:string;causationId?:string}
export abstract class IntegrationEvent {
  abstract readonly eventType: string;
  readonly version = 1;
  readonly eventId = randomUUID();
  private readonly occurredAt = new Date();
  private readonly data:Readonly<Record<string,unknown>>;
  protected constructor(readonly aggregateId: string, readonly correlationId: string, data: Readonly<Record<string,unknown>>,readonly causationId?:string) {
    this.data=structuredClone(data);
  }
  toJSON() {
    return { eventId: this.eventId,eventType: this.eventType,version: this.version,aggregateId: this.aggregateId,
      correlationId: this.correlationId,...(this.causationId?{causationId:this.causationId}:{}),occurredAt: this.occurredAt.toISOString(),data: structuredClone(this.data) };
  }
}
export class WagerTransactionProcessed extends IntegrationEvent {
  readonly eventType = 'WagerTransactionProcessed';
  static from(aggregate: string, data: Record<string,unknown>,ctx:EventContext={}) { return new WagerTransactionProcessed(aggregate,ctx.correlationId??String(data.transactionId),data,ctx.causationId??String(data.transactionId)); }
}
export class WagerTransactionRejected extends IntegrationEvent {
  readonly eventType = 'WagerTransactionRejected';
  static from(aggregate: string, data: Record<string,unknown>,ctx:EventContext={}) { return new WagerTransactionRejected(aggregate,ctx.correlationId??String(data.transactionId),data,ctx.causationId??String(data.transactionId)); }
}
export class WagerTransactionFailed extends IntegrationEvent {
  readonly eventType='WagerTransactionFailed';
  static from(aggregate:string,data:Record<string,unknown>,ctx:EventContext={}){return new WagerTransactionFailed(aggregate,ctx.correlationId??String(data.transactionId),data,ctx.causationId??String(data.transactionId));}
}
export class WagerTransactionPendingReference extends IntegrationEvent {
  readonly eventType = 'WagerTransactionPendingReference';
  static from(aggregate: string, data: Record<string,unknown>,ctx:EventContext={}) { return new WagerTransactionPendingReference(aggregate,ctx.correlationId??String(data.transactionId),data,ctx.causationId??String(data.transactionId)); }
}
export class WalletBalanceChanged extends IntegrationEvent {
  readonly eventType = 'WalletBalanceChanged';
  static from(aggregate: string, data: Record<string,unknown>,ctx:EventContext={}) { return new WalletBalanceChanged(aggregate,ctx.correlationId??String(data.transactionId),data,ctx.causationId??String(data.transactionId)); }
}
