import { describe, it, expect } from 'vitest';
import { translate } from '../src/transform';
import type { InputMessage } from '../src/transform/types';

const sample: InputMessage = {
  EventUuid: 'evt-0001',
  Id: 'cd4355a5-5c85-11ec-b98f-02adc9d8d6b4',
  CreatedAt: '2021-04-28T15:00:00Z',
  Email: 'lavinia@example.org',
  FirstName: 'Sebastian',
  LastName: 'Wolf',
  LastUpdatedAt: '2021-12-14T04:38:16Z',
  PhoneNumber: '(555) 555-5555',
  RentalApplicationId: '11aaa-22bbb-333ccc-444ddd',
  Status: 'applied',
  UnitIds: [],
  HasDogs: true,
  HasCats: false,
  HasOthers: false,
};

describe('translate', () => {
  it('mapeia PascalCase -> snake_case com os campos esperados', () => {
    expect(translate(sample)).toEqual({
      id: 'cd4355a5-5c85-11ec-b98f-02adc9d8d6b4',
      created_at: '2021-04-28T15:00:00Z',
      email: 'lavinia@example.org',
      first_name: 'Sebastian',
      last_name: 'Wolf',
      updated_at: '2021-12-14T04:38:16Z',
      phone_number: '(555) 555-5555',
    });
  });

  it('descarta campos que não fazem parte da saída', () => {
    const out = translate(sample) as unknown as Record<string, unknown>;
    for (const dropped of ['EventUuid', 'Status', 'UnitIds', 'HasDogs', 'RentalApplicationId']) {
      expect(out[dropped]).toBeUndefined();
    }
    expect(Object.keys(out)).toHaveLength(7);
  });

  it('renomeia LastUpdatedAt para updated_at', () => {
    expect(translate(sample).updated_at).toBe(sample.LastUpdatedAt);
  });
});
