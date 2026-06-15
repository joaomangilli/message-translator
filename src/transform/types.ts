// Formato de ENTRADA (como o webhook chega) — PascalCase.
export interface InputMessage {
  /** Chave de idempotência — não é repassada na saída. */
  EventUuid: string;
  Id: string;
  CreatedAt: string;
  Email: string;
  FirstName: string;
  LastName: string;
  LastUpdatedAt: string;
  PhoneNumber: string;
  // Campos que chegam mas NÃO são repassados na saída:
  RentalApplicationId?: string;
  Status?: string;
  UnitIds?: string[];
  HasDogs?: boolean;
  HasCats?: boolean;
  HasOthers?: boolean;
}

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
