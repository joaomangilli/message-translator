import { z } from 'zod';

// Formato de ENTRADA (como o webhook chega) — PascalCase.
// Schema é a fonte única de verdade; o tipo é derivado dele (z.infer).
// `looseObject` mantém campos extras desconhecidos (auditoria preserva o raw).
export const InputMessageSchema = z.looseObject({
  /** Chave de idempotência — não é repassada na saída. */
  EventUuid: z.string().min(1),
  Id: z.string().min(1),
  CreatedAt: z.string().min(1),
  Email: z.string().min(1),
  FirstName: z.string().min(1),
  LastName: z.string().min(1),
  LastUpdatedAt: z.string().min(1),
  PhoneNumber: z.string().min(1),
  // Campos que chegam mas NÃO são repassados na saída:
  RentalApplicationId: z.string().optional(),
  Status: z.string().optional(),
  UnitIds: z.array(z.string()).optional(),
  HasDogs: z.boolean().optional(),
  HasCats: z.boolean().optional(),
  HasOthers: z.boolean().optional(),
});

export type InputMessage = z.infer<typeof InputMessageSchema>;

// Formato de SAÍDA — snake_case, subconjunto dos campos.
export interface OutputMessage {
  id: string;
  created_at: string;
  email: string;
  first_name: string;
  last_name: string;
  updated_at: string;
  phone_number: string;
}
