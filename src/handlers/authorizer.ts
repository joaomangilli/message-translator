import { jwtVerify, type JWTPayload } from 'jose';
import type {
  APIGatewayRequestAuthorizerEvent,
  APIGatewayAuthorizerResult,
} from 'aws-lambda';
import { getJwtSecret } from '../lib/secrets';

/**
 * Extrai o token de um header `Authorization: Bearer <token>`.
 * Exportada para testes.
 */
export function extractBearer(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match?.[1];
}

/**
 * Verifica a assinatura do JWT (HS256) usando o secret. Retorna o payload se
 * válido, ou null se o token for inválido/expirado/malformado. Exportada para testes.
 */
export async function verifyToken(
  token: string,
  secret: string,
): Promise<JWTPayload | null> {
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    return payload;
  } catch {
    return null;
  }
}

function policy(
  effect: 'Allow' | 'Deny',
  principalId: string,
  methodArn: string,
): APIGatewayAuthorizerResult {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: methodArn,
        },
      ],
    },
  };
}

/**
 * Lambda Authorizer (REQUEST). Valida um Bearer JWT no header `Authorization`.
 * O secret (HS256) vem do AWS Secrets Manager (nome em `JWT_SECRET_NAME`).
 */
export const handler = async (
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> => {
  const headers = event.headers ?? {};
  const authHeader = headers['Authorization'] ?? headers['authorization'];

  const token = extractBearer(authHeader);

  // Fail-closed: se o secret não puder ser resolvido, nega em vez de estourar.
  let secret: string;
  try {
    secret = await getJwtSecret();
  } catch {
    return policy('Deny', 'unauthorized', event.methodArn);
  }

  const payload = token ? await verifyToken(token, secret) : null;

  if (!payload) {
    return policy('Deny', 'unauthorized', event.methodArn);
  }
  return policy('Allow', String(payload.sub ?? 'webhook-caller'), event.methodArn);
};
