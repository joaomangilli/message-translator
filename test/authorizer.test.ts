import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { extractBearer, verifyToken } from '../src/handlers/authorizer';

const SECRET = 'test-secret';

async function makeJwt(secret: string, expiresIn = '1h'): Promise<string> {
  return new SignJWT({ sub: 'caller-123' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
}

describe('extractBearer', () => {
  it('extrai o token de "Bearer <token>"', () => {
    expect(extractBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('retorna undefined sem header ou sem esquema Bearer', () => {
    expect(extractBearer(undefined)).toBeUndefined();
    expect(extractBearer('abc.def.ghi')).toBeUndefined();
  });
});

describe('verifyToken', () => {
  it('aceita um JWT válido e retorna o payload', async () => {
    const token = await makeJwt(SECRET);
    const payload = await verifyToken(token, SECRET);
    expect(payload?.sub).toBe('caller-123');
  });

  it('rejeita JWT assinado com outro secret', async () => {
    const token = await makeJwt('outro-secret');
    expect(await verifyToken(token, SECRET)).toBeNull();
  });

  it('rejeita JWT expirado', async () => {
    const token = await makeJwt(SECRET, '-1h');
    expect(await verifyToken(token, SECRET)).toBeNull();
  });

  it('rejeita token malformado', async () => {
    expect(await verifyToken('nao-e-jwt', SECRET)).toBeNull();
  });
});
