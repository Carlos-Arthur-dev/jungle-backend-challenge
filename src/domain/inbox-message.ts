export interface InboxState {
  readonly messageId:string; readonly consumerName:string; readonly payloadHash:string;
  readonly receivedAt:Date; readonly processedAt?:Date;
}
export class InboxMessage {
  private state:InboxState;
  private constructor(state:InboxState){this.state={...state,receivedAt:new Date(state.receivedAt),...(state.processedAt?{processedAt:new Date(state.processedAt)}:{})};}
  static receive(state:Omit<InboxState,'processedAt'>){
    if(!state.messageId.trim()||!state.consumerName.trim()||!state.payloadHash)throw new Error('INVALID_INBOX');
    return new InboxMessage(state);
  }
  static rehydrate(state:InboxState){return new InboxMessage(state);}
  get messageId(){return this.state.messageId;}
  get consumerName(){return this.state.consumerName;}
  get payloadHash(){return this.state.payloadHash;}
  get receivedAt(){return new Date(this.state.receivedAt);}
  get processedAt(){return this.state.processedAt?new Date(this.state.processedAt):undefined;}
  isProcessed(){return this.state.processedAt!==undefined;}
  markProcessed(at:Date){if(this.isProcessed())throw new Error('INBOX_ALREADY_PROCESSED');this.state={...this.state,processedAt:new Date(at)};}
}
