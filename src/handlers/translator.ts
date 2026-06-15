import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { saveRawMessageIfNew } from '../lib/ddb';
import { sendMessage } from '../lib/sqs';
import { translate } from '../transform';
import type { InputMessage } from '../transform/types';

const TABLE_NAME = process.env.TABLE_NAME ?? '';
const OUTPUT_QUEUE_URL = process.env.OUTPUT_QUEUE_URL ?? '';

/**
 * Consome a ingest-queue. Para cada mensagem (ordem invertida = entrega primeiro,
 * para não perder mensagem):
 *   1. transforma o formato e ENVIA para a output-queue;
 *   2. grava o RAW no DynamoDB (PutItem condicional por `EventUuid`) — best-effort,
 *      apenas auditoria: duplicada/erro de gravação viram log e NÃO forçam reenvio
 *      de algo já entregue.
 *
 * Semântica resultante: at-least-once na output-queue (o consumidor deve ser
 * idempotente por `EventUuid`). Usa `reportBatchItemFailures`: só falha de
 * parse/envio (ou ausência de `EventUuid`) volta para a fila / DLQ.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const raw = JSON.parse(record.body) as InputMessage;

      const eventUuid = raw.EventUuid;
      if (!eventUuid) {
        // Sem chave de idempotência não dá para auditar/deduplicar; manda para a DLQ.
        throw new Error('mensagem sem EventUuid');
      }

      // 1. Entrega primeiro. Se falhar, nada foi gravado: a retentativa reenvia.
      const translated = translate(raw);
      await sendMessage(OUTPUT_QUEUE_URL, JSON.stringify(translated));

      // 2. Auditoria best-effort. Já entregamos; não falhamos o record por causa
      //    da gravação (evita reenvio de algo já entregue).
      try {
        const saved = await saveRawMessageIfNew(TABLE_NAME, {
          eventUuid,
          receivedAt: new Date().toISOString(),
          raw,
        });
        if (!saved) {
          console.log('EventUuid já registrado (reenvio/duplicada)', eventUuid);
        }
      } catch (auditErr) {
        console.error('Falha ao gravar auditoria (mensagem já entregue)', eventUuid, auditErr);
      }
    } catch (err) {
      console.error('Falha ao processar mensagem', record.messageId, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
