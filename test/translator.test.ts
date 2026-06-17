import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

// Mocka os helpers de I/O para testar apenas a orquestração do handler.
const claimRawMessage = vi.fn();
const markDelivered = vi.fn();
const sendMessage = vi.fn();

vi.mock('../src/lib/ddb', () => ({
  claimRawMessage: (...a: unknown[]) => claimRawMessage(...a),
  markDelivered: (...a: unknown[]) => markDelivered(...a),
}));
vi.mock('../src/lib/sqs', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));

import { handler } from '../src/handlers/translator';

function event(records: { messageId: string; body: string }[]): SQSEvent {
  return {
    Records: records.map((r) => ({
      messageId: r.messageId,
      body: r.body,
      receiptHandle: 'rh',
      attributes: {} as never,
      messageAttributes: {},
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:ingest-queue',
      awsRegion: 'us-east-1',
    })),
  };
}

function inputBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    EventUuid: 'evt-0001',
    Id: 'cd4355a5-5c85-11ec-b98f-02adc9d8d6b4',
    CreatedAt: '2021-04-28T15:00:00Z',
    Email: 'lavinia@example.org',
    FirstName: 'Sebastian',
    LastName: 'Wolf',
    LastUpdatedAt: '2021-12-14T04:38:16Z',
    PhoneNumber: '(555) 555-5555',
    Status: 'applied',
    ...overrides,
  });
}

describe('translator handler', () => {
  beforeEach(() => {
    claimRawMessage.mockReset().mockResolvedValue({ outcome: 'claimed' }); // por padrão: novo
    markDelivered.mockReset().mockResolvedValue(undefined);
    sendMessage.mockReset().mockResolvedValue(undefined);
  });

  it('reserva, envia o traduzido (snake_case) e marca delivered', async () => {
    const res = await handler(event([{ messageId: '1', body: inputBody() }]));

    expect(claimRawMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(markDelivered).toHaveBeenCalledTimes(1);
    // chave de idempotência repassada ao claim e ao markDelivered
    expect((claimRawMessage.mock.calls[0][1] as { eventUuid: string }).eventUuid).toBe('evt-0001');
    expect(markDelivered.mock.calls[0][1]).toBe('evt-0001');
    expect(res.batchItemFailures).toEqual([]);

    const sentBody = JSON.parse(sendMessage.mock.calls[0][1] as string);
    expect(sentBody.id).toBe('cd4355a5-5c85-11ec-b98f-02adc9d8d6b4');
    expect(sentBody.first_name).toBe('Sebastian');
    expect(sentBody.updated_at).toBe('2021-12-14T04:38:16Z');
    expect(sentBody.Status).toBeUndefined(); // campo descartado
  });

  it('reserva antes de entregar: claim ocorre antes do send e do markDelivered', async () => {
    const order: string[] = [];
    claimRawMessage.mockImplementationOnce(async () => {
      order.push('claim');
      return { outcome: 'claimed' };
    });
    sendMessage.mockImplementationOnce(async () => {
      order.push('send');
    });
    markDelivered.mockImplementationOnce(async () => {
      order.push('markDelivered');
    });

    await handler(event([{ messageId: '1', body: inputBody() }]));
    expect(order).toEqual(['claim', 'send', 'markDelivered']);
  });

  it('duplicada (claim=duplicate): não envia e não reporta falha', async () => {
    claimRawMessage.mockResolvedValueOnce({ outcome: 'duplicate' });
    const res = await handler(event([{ messageId: '1', body: inputBody() }]));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(markDelivered).not.toHaveBeenCalled();
    expect(res.batchItemFailures).toEqual([]);
  });

  it('recuperação (claim=recover): reataca a entrega e marca delivered', async () => {
    claimRawMessage.mockResolvedValueOnce({ outcome: 'recover' });
    const res = await handler(event([{ messageId: '1', body: inputBody() }]));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(markDelivered).toHaveBeenCalledTimes(1);
    expect(res.batchItemFailures).toEqual([]);
  });

  it('erro real no claim reporta o record e não envia', async () => {
    claimRawMessage.mockRejectedValueOnce(new Error('dynamo down'));
    const res = await handler(event([{ messageId: 'x', body: inputBody() }]));

    expect(sendMessage).not.toHaveBeenCalled();
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'x' }]);
  });

  it('falha no markDelivered: entrega ocorreu, não reporta falha (best-effort)', async () => {
    markDelivered.mockRejectedValueOnce(new Error('dynamo down'));
    const res = await handler(event([{ messageId: '1', body: inputBody() }]));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(res.batchItemFailures).toEqual([]);
  });

  it('manda para a DLQ mensagem sem EventUuid (sem enviar)', async () => {
    const res = await handler(event([{ messageId: 'no-uuid', body: inputBody({ EventUuid: undefined }) }]));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'no-uuid' }]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejeita payload com campo obrigatório faltando (sem enviar)', async () => {
    const res = await handler(event([{ messageId: 'no-email', body: inputBody({ Email: undefined }) }]));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'no-email' }]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejeita payload com campo de tipo errado (sem enviar)', async () => {
    const res = await handler(event([{ messageId: 'bad-type', body: inputBody({ Email: 123 }) }]));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'bad-type' }]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejeita payload com string obrigatória vazia (sem enviar)', async () => {
    const res = await handler(event([{ messageId: 'empty', body: inputBody({ FirstName: '' }) }]));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'empty' }]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('reporta como falha apenas a mensagem com body inválido', async () => {
    const res = await handler(
      event([
        { messageId: 'ok', body: inputBody() },
        { messageId: 'bad', body: 'isto-nao-e-json' },
      ]),
    );

    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'bad' }]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('falha de envio reporta o record e não marca delivered (registro fica pending)', async () => {
    sendMessage.mockRejectedValueOnce(new Error('sqs down'));
    const res = await handler(event([{ messageId: 'x', body: inputBody() }]));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'x' }]);
    expect(claimRawMessage).toHaveBeenCalledTimes(1);
    expect(markDelivered).not.toHaveBeenCalled();
  });
});
