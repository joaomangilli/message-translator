import { describe, it, expect } from 'vitest';
import { InputMessageSchema } from '../src/transform/types';

function valid(overrides: Record<string, unknown> = {}) {
  return {
    EventUuid: 'evt-0001',
    Id: 'cd4355a5-5c85-11ec-b98f-02adc9d8d6b4',
    CreatedAt: '2021-04-28T15:00:00Z',
    Email: 'lavinia@example.org',
    FirstName: 'Sebastian',
    LastName: 'Wolf',
    LastUpdatedAt: '2021-12-14T04:38:16Z',
    PhoneNumber: '(555) 555-5555',
    ...overrides,
  };
}

describe('InputMessageSchema', () => {
  it('aceita um payload válido', () => {
    expect(InputMessageSchema.safeParse(valid()).success).toBe(true);
  });

  it('mantém campos extras desconhecidos (passthrough)', () => {
    const res = InputMessageSchema.safeParse(valid({ Status: 'applied', QualquerCoisa: 42 }));
    expect(res.success).toBe(true);
    expect(res.success && (res.data as Record<string, unknown>).QualquerCoisa).toBe(42);
  });

  it('rejeita campo obrigatório faltando', () => {
    const { Email: _omit, ...semEmail } = valid();
    expect(InputMessageSchema.safeParse(semEmail).success).toBe(false);
  });

  it('rejeita tipo errado em campo obrigatório', () => {
    expect(InputMessageSchema.safeParse(valid({ Email: 123 })).success).toBe(false);
  });

  it('rejeita string obrigatória vazia', () => {
    expect(InputMessageSchema.safeParse(valid({ FirstName: '' })).success).toBe(false);
  });

  it('rejeita tipo errado em campo opcional quando presente', () => {
    expect(InputMessageSchema.safeParse(valid({ UnitIds: 'nao-e-array' })).success).toBe(false);
  });
});
