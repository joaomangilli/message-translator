#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { TranslatorStack } from '../lib/translator-stack';

const app = new cdk.App();

// Ambiente de deploy. `local` é o default para dev/LocalStack/`cdk synth` (rodam
// sem ENVIRONMENT). O CD só passa `qa` ou `prod` (restrito pelo dropdown do workflow).
const environment = process.env.ENVIRONMENT ?? 'local';
const VALID_ENVIRONMENTS = ['qa', 'prod', 'local'];
if (!VALID_ENVIRONMENTS.includes(environment)) {
  throw new Error(`ENVIRONMENT inválido: "${environment}". Use: qa, prod.`);
}

new TranslatorStack(app, `MessageTranslator-${environment}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  environment,
  // Arquitetura das Lambdas. Default arm64 (Graviton, prod). LocalStack/CI roda em
  // x86_64; emular arm64 estoura o startup, então o deploy local define x86_64.
  lambdaArchitecture: process.env.LAMBDA_ARCHITECTURE === 'x86_64' ? 'x86_64' : 'arm64',
  // Nome do secret (Secrets Manager) cujo valor é o secret HS256 do Bearer JWT.
  // O secret deve existir na conta/região; só é referenciado aqui, não criado.
  // `||` (não `??`) para que JWT_SECRET_NAME vazio do GitHub caia no default.
  jwtSecretName:
    process.env.JWT_SECRET_NAME || `message-translator/${environment}/jwt-secret`,
  // LocalStack community não suporta AWS::ApiGateway::Authorizer; o script
  // local:deploy define DISABLE_AUTHORIZER=true para pular a vinculação.
  attachAuthorizer: process.env.DISABLE_AUTHORIZER !== 'true',
});

app.synth();
