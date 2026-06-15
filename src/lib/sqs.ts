import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

// AWS_ENDPOINT_URL é respeitado para apontar ao LocalStack quando presente.
const endpoint = process.env.AWS_ENDPOINT_URL || undefined;

const client = new SQSClient({ endpoint });

export async function sendMessage(queueUrl: string, body: string): Promise<void> {
  await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
}
