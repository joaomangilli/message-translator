import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

// AWS_ENDPOINT_URL é respeitado para apontar ao LocalStack quando presente.
const endpoint = process.env.AWS_ENDPOINT_URL || undefined;

const client = new DynamoDBClient({ endpoint });
const doc = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

export interface RawMessageItem {
  /** Chave de idempotência — vem do campo `EventUuid` da mensagem. */
  eventUuid: string;
  receivedAt: string;
  raw: unknown;
  ttl?: number;
}

/**
 * Tenta salvar a mensagem raw de forma idempotente, com PutItem condicional
 * (`attribute_not_exists(eventUuid)`) — sem GetItem prévio.
 *
 * @returns `true` se salvou (novo), `false` se já existia (duplicada).
 * @throws  qualquer erro do DynamoDB que NÃO seja conflito de condição.
 */
export async function saveRawMessageIfNew(
  tableName: string,
  item: RawMessageItem,
): Promise<boolean> {
  try {
    await doc.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(eventUuid)',
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return false; // duplicada
    }
    throw err;
  }
}
