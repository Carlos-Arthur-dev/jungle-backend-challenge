import {ApplicationError,type WagerInput} from './wagering-service';
import {Money,type MoneyProps} from '../domain/money';
function object(value:unknown,allowed:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ApplicationError('INVALID_PAYLOAD',400);
  const record=value as Record<string,unknown>;
  if(Object.keys(record).some(key=>!allowed.includes(key)))throw new ApplicationError('UNKNOWN_FIELD',400);
  return record;
}
export function text(value:unknown,code='INVALID_PAYLOAD'):string{
  if(typeof value!=='string'||!value.trim()||value.length>256)throw new ApplicationError(code,400);return value;
}
export function uuid(value:unknown):string{
  const result=text(value,'INVALID_UUID');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result))throw new ApplicationError('INVALID_UUID',400);
  return result;
}
function money(value:unknown):MoneyProps{
  const data=object(value,['amount','currency']);
  try{return Money.from({amount:data.amount as string,currency:data.currency as string}).toJSON();}
  catch(error){throw new ApplicationError(error instanceof Error?error.message:'INVALID_MONEY',400);}
}
export function walletBody(value:unknown){const data=object(value,['playerId','initialBalance']);return{playerId:uuid(data.playerId),initialBalance:money(data.initialBalance)};}
export function wagerBody(value:unknown):WagerInput{
  const data=object(value,['providerId','externalTransactionId','playerId','walletId','roundId','gameId','kind','money','referenceExternalTransactionId']);
  if(typeof data.kind!=='string'||!['BET','WIN','LOSS','REFUND','ROLLBACK'].includes(data.kind))throw new ApplicationError('INVALID_WAGER_KIND',400);
  const kind=data.kind as WagerInput['kind'];
  const reference=data.referenceExternalTransactionId===undefined?undefined:text(data.referenceExternalTransactionId,'INVALID_REFERENCE');
  if(['REFUND','ROLLBACK'].includes(kind)&&!reference)throw new ApplicationError('REFERENCE_REQUIRED',400);
  const amount=money(data.money);
  if(kind!=='LOSS'&&amount.amount==='0.00')throw new ApplicationError('INVALID_WAGER_AMOUNT',400);
  return{providerId:text(data.providerId),externalTransactionId:text(data.externalTransactionId),playerId:uuid(data.playerId),walletId:uuid(data.walletId),
    roundId:text(data.roundId),gameId:text(data.gameId),kind,money:amount,...(reference?{referenceExternalTransactionId:reference}:{})};
}
export function scalarQuery(value:unknown,code:string):string|undefined{
  if(value===undefined)return undefined;if(typeof value!=='string')throw new ApplicationError(code,400);return value;
}
export function transactionView(row:Record<string,unknown>){
  const result=row.result as {balance?:MoneyProps}|null;
  return{transactionId:row.id,providerId:row.provider_id,externalTransactionId:row.external_transaction_id,
    walletId:row.wallet_id,playerId:row.player_id,roundId:row.round_id,gameId:row.game_id,kind:row.kind,status:row.status,
    money:{amount:row.amount,currency:row.currency},balance:result?.balance??null,
    ...(row.reference_external_transaction_id?{referenceExternalTransactionId:row.reference_external_transaction_id}:{}),
    ...(row.failure_code?{failureCode:row.failure_code}:{}),createdAt:row.created_at,processedAt:row.processed_at};
}
