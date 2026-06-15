import type { InputMessage, OutputMessage } from './types';

/**
 * Transforma uma mensagem do formato de ENTRADA (PascalCase) para o de SAÍDA
 * (snake_case). Mapeia um subconjunto dos campos e renomeia `LastUpdatedAt`
 * para `updated_at`. Os demais campos de entrada (Status, UnitIds, Has*, etc.)
 * são intencionalmente descartados.
 *
 * Função PURA (sem I/O) — fácil de testar.
 */
export function translate(input: InputMessage): OutputMessage {
  return {
    id: input.Id,
    created_at: input.CreatedAt,
    email: input.Email,
    first_name: input.FirstName,
    last_name: input.LastName,
    updated_at: input.LastUpdatedAt,
    phone_number: input.PhoneNumber,
  };
}
