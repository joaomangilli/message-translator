import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';

// AWS_ENDPOINT_URL é respeitado para apontar ao LocalStack quando presente.
const endpoint = process.env.AWS_ENDPOINT_URL || undefined;

const client = new SecretsManagerClient({ endpoint });

// Cache do secret na vida do container do Lambda: invocações "warm" reaproveitam
// o valor e não chamam o Secrets Manager de novo. Memoizamos a promise para que
// chamadas concorrentes na mesma invocação compartilhem um único GetSecretValue.
let cached: Promise<string> | undefined;

async function fetchJwtSecret(): Promise<string> {
  const secretName = process.env.JWT_SECRET_NAME;
  if (!secretName) {
    throw new Error('JWT_SECRET_NAME não definido');
  }

  const { SecretString } = await client.send(
    new GetSecretValueCommand({ SecretId: secretName }),
  );
  if (!SecretString) {
    throw new Error(`Secret "${secretName}" não tem SecretString`);
  }
  return SecretString;
}

/**
 * Retorna o secret HS256 (string pura) do AWS Secrets Manager, buscando o nome
 * em `JWT_SECRET_NAME`. O valor é cacheado por container; se o fetch falhar, o
 * cache é limpo para que a próxima invocação tente de novo.
 */
export function getJwtSecret(): Promise<string> {
  if (!cached) {
    cached = fetchJwtSecret().catch((err) => {
      cached = undefined;
      throw err;
    });
  }
  return cached;
}
