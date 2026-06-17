import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { claimRawMessage, markDelivered } from '../lib/ddb';
import { sendMessage } from '../lib/sqs';
import { translate } from '../transform';
import { InputMessageSchema } from '../transform/types';

const TABLE_NAME = process.env.TABLE_NAME ?? '';
const OUTPUT_QUEUE_URL = process.env.OUTPUT_QUEUE_URL ?? '';

/**
 * Consome a ingest-queue. O DynamoDB é o gate de idempotência real (grava ANTES
 * de entregar). Para cada mensagem:
 *   1. CLAIM no DynamoDB — PutItem condicional por `EventUuid`, gravando `pending`.
 *        - `claimed`   → registro novo, segue para a entrega;
 *        - `duplicate` → já está `delivered`: ignora (não entrega, não reporta falha);
 *        - `recover`   → já está `pending` (tentativa anterior interrompida): reataca.
 *      Erro real do DynamoDB → reporta falha (retry → DLQ).
 *   2. ENVIA o traduzido para a output-queue. Se falhar, reporta falha e o registro
 *      fica `pending`: o redrive recupera e reataca. Sem `delete` compensatório.
 *   3. Marca `delivered`. Se falhar, apenas loga (a entrega já ocorreu) — o registro
 *      segue `pending`, o que no máximo permite um reenvio futuro idempotente.
 *
 * Semântica resultante: dedup real na entrega (duplicata não é reenviada) e sem
 * perda silenciosa — o pior caso é uma mensagem recuperável na ingest-dlq.
 * Usa `reportBatchItemFailures`: só parse/claim/envio com erro voltam à fila / DLQ.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const batchItemFailures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      // Valida o payload ANTES de transformar: schema malformado (campo obrigatório
      // faltando, tipo errado, string vazia) é rejeitado e cai na DLQ via o catch.
      const parsed: unknown = JSON.parse(record.body);
      const result = InputMessageSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(`payload inválido: ${result.error.message}`);
      }
      const raw = result.data;

      // `EventUuid` é garantido não-vazio pelo schema (chave de idempotência).
      const eventUuid = raw.EventUuid;

      // 1. Gate de idempotência: reserva o EventUuid como `pending`.
      const { outcome } = await claimRawMessage(TABLE_NAME, {
        eventUuid,
        receivedAt: new Date().toISOString(),
        raw,
      });
      if (outcome === 'duplicate') {
        console.log('EventUuid já entregue (duplicada), ignorando', eventUuid);
        continue;
      }
      if (outcome === 'recover') {
        console.log('EventUuid pendente, reatacando entrega', eventUuid);
      }

      // 2. Entrega. Se falhar, o registro fica `pending` e o redrive reataca.
      const translated = translate(raw);
      await sendMessage(OUTPUT_QUEUE_URL, JSON.stringify(translated));

      // 3. Confirma a entrega. Best-effort: já entregamos, então um erro aqui não
      //    reporta falha (evita reenvio de algo já entregue).
      try {
        await markDelivered(TABLE_NAME, eventUuid);
      } catch (markErr) {
        console.error('Falha ao marcar delivered (mensagem já entregue)', eventUuid, markErr);
      }
    } catch (err) {
      console.error('Falha ao processar mensagem', record.messageId, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
