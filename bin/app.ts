#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { TranslatorStack } from '../lib/translator-stack';

const app = new cdk.App();

new TranslatorStack(app, 'MessageTranslatorStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  // Secret (HS256) usado para verificar o Bearer JWT. Vem da env var JWT_SECRET.
  // Default só para dev/LocalStack; em produção defina JWT_SECRET no ambiente.
  jwtSecret: process.env.JWT_SECRET ?? 'local-dev-secret',
  // LocalStack community não suporta AWS::ApiGateway::Authorizer; o script
  // local:deploy define DISABLE_AUTHORIZER=true para pular a vinculação.
  attachAuthorizer: process.env.DISABLE_AUTHORIZER !== 'true',
});

app.synth();
