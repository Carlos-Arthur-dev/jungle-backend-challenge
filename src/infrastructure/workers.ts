import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, type Message } from '@aws-sdk/client-sqs';
import { ApplicationError, WageringService, type WagerInput } from '../application/wagering-service';
import { sqs } from './sqs';
import { count,requestContext } from './telemetry';
import {OutboxMessage} from '../domain/outbox-message';

export class OutboxPublisher {
  constructor(private readonly orm: MikroORM, private readonly queueUrl: string) {}
  async publishOne(): Promise<boolean> {
    return this.orm.em.fork().transactional(async em => {
      const rows = await em.execute<{ id: string; aggregate_id: string; event_type:string; payload: Record<string,unknown>; attempts: number;occurred_at:Date;next_attempt_at:Date }[]>(
        `select * from outbox where published_at is null and next_attempt_at<=now()
         order by occurred_at,id for update skip locked limit 1`);
      const row = rows[0]; if (!row) return false;
      const message=OutboxMessage.rehydrate({id:row.id,aggregateId:row.aggregate_id,eventType:row.event_type,payload:row.payload,attempts:row.attempts,occurredAt:row.occurred_at,nextAttemptAt:row.next_attempt_at});
      try {
        // Lock remains held during send. A crash after send can repeat delivery with the same eventId.
        await sqs.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(row.payload),
          MessageGroupId: row.aggregate_id, MessageDeduplicationId: row.id }));
      } catch {
        count('jungle_outbox_retries_total');
        message.scheduleRetry(new Date());
        await em.execute('update outbox set attempts=?,next_attempt_at=? where id=?',[message.attempts,message.nextAttemptAt,row.id]);
        return true;
      }
      // A database failure here rolls back the publication marker. It must not be
      // misclassified as a send failure or transition an already-published object.
      message.markPublished(new Date());
      await em.execute('update outbox set published_at=?,attempts=attempts+1 where id=?',[message.publishedAt,row.id]);
      return true;
    });
  }
}

export class WagerConsumer {
  private readonly service: WageringService;
  constructor(orm: MikroORM, private readonly requests: string, private readonly dlq: string,
    private readonly afterCommit?: (receipt: string) => Promise<void>) { this.service = new WageringService(orm); }
  async pollOnce(waitSeconds = 2): Promise<number> {
    const result = await sqs.send(new ReceiveMessageCommand({ QueueUrl: this.requests, MaxNumberOfMessages: 1,
      WaitTimeSeconds: waitSeconds, VisibilityTimeout: 60, MessageSystemAttributeNames: ['ApproximateReceiveCount'] }));
    for (const message of result.Messages ?? []) await this.handle(message);
    return result.Messages?.length ?? 0;
  }
  private async handle(message: Message): Promise<void> {
    if (!message.ReceiptHandle) return;
    const receipt = message.ReceiptHandle;
    let envelope: { messageId: string; type: string; data: WagerInput & { idempotencyKey: string } }|undefined;
    const heartbeat = setInterval(() => {
      void sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.requests, ReceiptHandle: receipt, VisibilityTimeout: 60 })).catch(() => {});
    },20000);
    try {
      try { envelope = JSON.parse(message.Body ?? ''); } catch { throw new ApplicationError('INVALID_ENVELOPE',400); }
      if (!envelope || envelope.type !== 'WagerTransactionRequested' || typeof envelope.messageId !== 'string' || !envelope.messageId.trim() || !envelope.data) throw new ApplicationError('INVALID_ENVELOPE',400);
      const valid=envelope;
      await requestContext.run({correlationId:valid.messageId,causationId:valid.messageId},()=>this.service.submit(valid.data,valid.data.idempotencyKey,{ consumerName: 'wager-consumer',messageId: valid.messageId }));
      // SQL transaction has committed before this delete (ack).
      await this.afterCommit?.(receipt);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: this.requests,ReceiptHandle: receipt }));
    } catch (error) {
      const code = error instanceof Error ? error.message : 'UNKNOWN';
      const infrastructurePermanent=['42501','0A000','42P01','42703'].includes((error as {code?:string}).code??'');
      const permanent = infrastructurePermanent || (error instanceof ApplicationError && error.httpStatus < 500) || /^(INVALID_|REFERENCE_REQUIRED|MONEY_OUT_OF_RANGE)/.test(code);
      const attempts = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
      if (permanent || attempts >= 5) {
        if(infrastructurePermanent && envelope){
          // Audit in a separate SQL transaction after the financial transaction rolled back.
          // If audit persistence fails, do not delete or transfer the original message.
          await this.service.recordPermanentFailure(envelope.data,envelope.data.idempotencyKey,{consumerName:'wager-consumer',messageId:envelope.messageId});
        }
        count('jungle_dlq_total');
        // Send first, then ack: an interrupted transfer may duplicate DLQ records, never lose one.
        await sqs.send(new SendMessageCommand({ QueueUrl: this.dlq,MessageBody: message.Body ?? '{}',
          MessageGroupId: 'invalid',MessageDeduplicationId: message.MessageId ?? randomUUID() }));
        await sqs.send(new DeleteMessageCommand({ QueueUrl: this.requests,ReceiptHandle: receipt }));
      } else {
        count('jungle_retries_total');
        await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: this.requests, ReceiptHandle: receipt,VisibilityTimeout: Math.min(300,2 ** attempts) }));
      }
      console.error(JSON.stringify({ level: 'warn',event: permanent ? 'message_dlq' : 'message_retry',messageId: message.MessageId,
        code:error instanceof ApplicationError?error.code:(error as {code?:string}).code??'PROCESSING_FAILURE' }));
    } finally { clearInterval(heartbeat); }
  }
}
