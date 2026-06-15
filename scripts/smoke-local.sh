#!/usr/bin/env bash
# Smoke test e2e contra o LocalStack: deploy + POST no webhook + verificação de
# DynamoDB e da output-queue. Assume o LocalStack já no ar (npm run local:up).
set -euo pipefail

export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
unset AWS_PROFILE || true

ENDPOINT=http://localhost:4566

echo "==> Aguardando LocalStack ficar healthy..."
for i in $(seq 1 60); do
  if curl -s "$ENDPOINT/_localstack/health" 2>/dev/null | grep -q '"sqs": "available"'; then
    echo "    pronto (tentativa $i)"
    break
  fi
  sleep 2
done

echo "==> Bootstrap + deploy (sem authorizer; LocalStack community não suporta)"
npx cdklocal bootstrap
DISABLE_AUTHORIZER=true npx cdklocal deploy --require-approval never --outputs-file cdk-outputs.json

WEBHOOK_URL=$(node -e "console.log(require('./cdk-outputs.json').MessageTranslatorStack.WebhookUrl)")
OUTPUT_QUEUE_URL=$(node -e "console.log(require('./cdk-outputs.json').MessageTranslatorStack.OutputQueueUrl)")
echo "    WebhookUrl=$WEBHOOK_URL"

PAYLOAD='{"EventUuid":"smoke-001","Id":"cd4355a5-5c85-11ec-b98f-02adc9d8d6b4","CreatedAt":"2021-04-28T15:00:00Z","Email":"lavinia@example.org","FirstName":"Sebastian","LastName":"Wolf","LastUpdatedAt":"2021-12-14T04:38:16Z","PhoneNumber":"(555) 555-5555","Status":"applied","HasDogs":true}'

echo "==> POST no webhook"
code=$(curl -sk -o /dev/null -w "%{http_code}" -X POST "$WEBHOOK_URL" -H "Content-Type: application/json" -d "$PAYLOAD")
echo "    HTTP $code"
[ "$code" = "200" ] || { echo "FALHA: esperava 200, veio $code"; exit 1; }

echo "==> Aguardando o Lambda processar..."
sleep 8

echo "==> Verificando DynamoDB (raw persistido)"
count=$(awslocal dynamodb scan --table-name RawMessages --select COUNT --query Count --output text)
echo "    itens em RawMessages: $count"
[ "$count" -ge 1 ] || { echo "FALHA: RawMessages vazio"; exit 1; }

echo "==> Verificando output-queue (mensagem traduzida)"
body=$(awslocal sqs receive-message --queue-url "$OUTPUT_QUEUE_URL" --query 'Messages[0].Body' --output text)
echo "    body: $body"
echo "$body" | grep -q '"first_name":"Sebastian"' || { echo "FALHA: snake_case ausente"; exit 1; }
echo "$body" | grep -q '"Status"' && { echo "FALHA: campo descartado vazou"; exit 1; } || true

echo "✅ Smoke e2e OK"
