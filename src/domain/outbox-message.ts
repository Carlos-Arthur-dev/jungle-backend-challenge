import type {IntegrationEvent} from './integration-event';
export interface OutboxState {
  readonly id:string; readonly aggregateId:string; readonly eventType:string;
  readonly payload:Readonly<Record<string,unknown>>; readonly occurredAt:Date;
  readonly attempts:number; readonly nextAttemptAt?:Date; readonly publishedAt?:Date;
}
export class OutboxMessage {
  private state:OutboxState;
  private constructor(state:OutboxState){this.state={...state,payload:structuredClone(state.payload),occurredAt:new Date(state.occurredAt),
    ...(state.nextAttemptAt?{nextAttemptAt:new Date(state.nextAttemptAt)}:{}),...(state.publishedAt?{publishedAt:new Date(state.publishedAt)}:{})};}
  static enqueue(event:IntegrationEvent){const payload=event.toJSON();return new OutboxMessage({id:payload.eventId,aggregateId:payload.aggregateId,eventType:payload.eventType,payload,occurredAt:new Date(payload.occurredAt),attempts:0});}
  static rehydrate(state:OutboxState){return new OutboxMessage(state);}
  get id(){return this.state.id;}
  get payload(){return structuredClone(this.state.payload);}
  get attempts(){return this.state.attempts;}
  get nextAttemptAt(){return this.state.nextAttemptAt?new Date(this.state.nextAttemptAt):undefined;}
  get publishedAt(){return this.state.publishedAt?new Date(this.state.publishedAt):undefined;}
  isPending(){return !this.state.publishedAt;}
  isDue(now:Date){return this.isPending()&&(!this.state.nextAttemptAt||this.state.nextAttemptAt<=now);}
  markPublished(at:Date){if(!this.isPending())throw new Error('OUTBOX_ALREADY_PUBLISHED');this.state={...this.state,publishedAt:new Date(at)};}
  scheduleRetry(now:Date){if(!this.isPending())throw new Error('OUTBOX_ALREADY_PUBLISHED');const attempts=this.attempts+1;
    this.state={...this.state,attempts,nextAttemptAt:new Date(now.getTime()+Math.min(3600,2**attempts)*1000)};}
}
