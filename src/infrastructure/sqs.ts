import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
export const sqs = new SQSClient({
  endpoint: process.env.SQS_ENDPOINT ?? 'http://127.0.0.1:4566', region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test', secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test' },
});
export async function ensureQueues() {
  async function create(name: string) {
    const result = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' } }));
    if (!result.QueueUrl) throw new Error('QUEUE_URL_MISSING');
    return result.QueueUrl;
  }
  const dlq = await create('wager-transactions-dlq.fifo');
  const requests = await create('wager-transactions.fifo');
  const events = await create('wager-events.fifo');
  const arn = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }));
  await sqs.send(new SetQueueAttributesCommand({ QueueUrl: requests, Attributes: {
    VisibilityTimeout: '60', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn.Attributes?.QueueArn, maxReceiveCount: '5' }),
  } }));
  return { requests, events, dlq };
}
