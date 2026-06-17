import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

// AWS_ENDPOINT_URL é respeitado para apontar ao LocalStack quando presente.
const endpoint = process.env.AWS_ENDPOINT_URL || undefined;

const client = new DynamoDBClient({ endpoint });
const doc = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

/** Estado do registro: `pending` = reservado, ainda não entregue; `delivered` = entregue. */
export type MessageStatus = 'pending' | 'delivered';

export interface RawMessageItem {
  /** Chave de idempotência — vem do campo `EventUuid` da mensagem. */
  eventUuid: string;
  receivedAt: string;
  raw: unknown;
  ttl?: number;
}

/**
 * Resultado do claim:
 *  - `claimed`   — registro novo, reservado como `pending`; siga para a entrega.
 *  - `duplicate` — já existe e está `delivered`; é duplicata real, ignore.
 *  - `recover`   — já existe mas está `pending` (tentativa anterior interrompida);
 *                  reataque a entrega.
 */
export type ClaimOutcome = { outcome: 'claimed' | 'duplicate' | 'recover' };

/**
 * Reserva o `eventUuid` como gate de idempotência: PutItem condicional
 * (`attribute_not_exists(eventUuid)`) gravando `status: 'pending'`.
 *
 * Em conflito de condição, usa `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'`
 * para ler o item já existente direto da exceção — sem GetItem extra — e decide
 * entre `duplicate` (já `delivered`) e `recover` (`pending`). O `Item` da exceção
 * NÃO é desserializado pelo DocumentClient: vem em formato bruto (`{ S: ... }`).
 *
 * @throws qualquer erro do DynamoDB que NÃO seja conflito de condição.
 */
export async function claimRawMessage(
  tableName: string,
  item: RawMessageItem,
): Promise<ClaimOutcome> {
  try {
    await doc.send(
      new PutCommand({
        TableName: tableName,
        Item: { ...item, status: 'pending' satisfies MessageStatus },
        ConditionExpression: 'attribute_not_exists(eventUuid)',
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      }),
    );
    return { outcome: 'claimed' };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // O item existente vem desserializado em `err.Item`. Só é `duplicate` se
      // já estiver `delivered`; qualquer outro estado (pending, ou ausência
      // defensiva) é tratado como `recover` para nunca descartar sem entregar.
      const status = err.Item?.status?.S;
      return { outcome: status === 'delivered' ? 'duplicate' : 'recover' };
    }
    throw err;
  }
}

/**
 * Marca o registro como `delivered` após a entrega confirmada na output-queue.
 * `status` é palavra reservada no DynamoDB, por isso o alias `#s`.
 */
export async function markDelivered(tableName: string, eventUuid: string): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { eventUuid },
      UpdateExpression: 'SET #s = :d',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':d': 'delivered' satisfies MessageStatus },
    }),
  );
}
