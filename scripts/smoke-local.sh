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
# O health reporta o serviço como "available" (pronto) ou "running" (já usado);
# aceitamos ambos e toleramos espaçamento do JSON. Falha alto se não ficar pronto,
# em vez de seguir e quebrar mais adiante no bootstrap (sem STS = sem conta).
ready=0
for i in $(seq 1 90); do
  if curl -s "$ENDPOINT/_localstack/health" 2>/dev/null \
      | grep -qE '"sqs":[[:space:]]*"(available|running)"'; then
    echo "    pronto (tentativa $i)"
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" != 1 ]; then
  echo "FALHA: LocalStack não ficou pronto (sqs available/running)"
  curl -s "$ENDPOINT/_localstack/health" || true
  exit 1
fi

echo "==> Bootstrap + deploy (sem authorizer; LocalStack community não suporta)"
npx cdklocal bootstrap
DISABLE_AUTHORIZER=true npx cdklocal deploy --require-approval never --outputs-file cdk-outputs.json

# Sem ENVIRONMENT, o app usa o ambiente 'local' (stack MessageTranslator-local).
STACK=MessageTranslator-local
WEBHOOK_URL=$(node -e "console.log(require('./cdk-outputs.json')['$STACK'].WebhookUrl)")
OUTPUT_QUEUE_URL=$(node -e "console.log(require('./cdk-outputs.json')['$STACK'].OutputQueueUrl)")
TABLE_NAME=$(node -e "console.log(require('./cdk-outputs.json')['$STACK'].RawTableName)")
echo "    WebhookUrl=$WEBHOOK_URL"

PAYLOAD='{"EventUuid":"smoke-001","Id":"cd4355a5-5c85-11ec-b98f-02adc9d8d6b4","CreatedAt":"2021-04-28T15:00:00Z","Email":"lavinia@example.org","FirstName":"Sebastian","LastName":"Wolf","LastUpdatedAt":"2021-12-14T04:38:16Z","PhoneNumber":"(555) 555-5555","Status":"applied","HasDogs":true}'

echo "==> POST no webhook"
code=$(curl -sk -o /dev/null -w "%{http_code}" -X POST "$WEBHOOK_URL" -H "Content-Type: application/json" -d "$PAYLOAD")
echo "    HTTP $code"
[ "$code" = "200" ] || { echo "FALHA: esperava 200, veio $code"; exit 1; }

echo "==> Verificando DynamoDB (raw persistido) — poll p/ tolerar cold start do Lambda"
# O primeiro invoke do Lambda no LocalStack (sobretudo no CI) pode levar dezenas de
# segundos (pull da imagem de runtime). Faz polling em vez de sleep fixo.
count=0
for i in $(seq 1 30); do
  count=$(awslocal dynamodb scan --table-name "$TABLE_NAME" --select COUNT --query Count --output text 2>/dev/null || echo 0)
  [ "$count" -ge 1 ] && { echo "    itens em RawMessages: $count (tentativa $i)"; break; }
  sleep 2
done
[ "$count" -ge 1 ] || { echo "FALHA: RawMessages vazio após ~60s"; exit 1; }

echo "==> Verificando output-queue (mensagem traduzida)"
body=""
for i in $(seq 1 10); do
  body=$(awslocal sqs receive-message --queue-url "$OUTPUT_QUEUE_URL" \
    --wait-time-seconds 5 --query 'Messages[0].Body' --output text 2>/dev/null)
  [ -n "$body" ] && [ "$body" != "None" ] && break
done
echo "    body: $body"
echo "$body" | grep -q '"first_name":"Sebastian"' || { echo "FALHA: snake_case ausente"; exit 1; }
echo "$body" | grep -q '"Status"' && { echo "FALHA: campo descartado vazou"; exit 1; } || true

echo "==> Edge case: payload malformado (sem Email) deve ser rejeitado"
# Validação roda no Lambda, então o webhook ainda enfileira e responde 200; a
# mensagem é reprovada no safeParse e NUNCA é traduzida nem auditada no Dynamo.
BAD_PAYLOAD='{"EventUuid":"smoke-bad-001","Id":"bad-id-001","CreatedAt":"2021-04-28T15:00:00Z","FirstName":"Sebastian","LastName":"Wolf","LastUpdatedAt":"2021-12-14T04:38:16Z","PhoneNumber":"(555) 555-5555"}'
code=$(curl -sk -o /dev/null -w "%{http_code}" -X POST "$WEBHOOK_URL" -H "Content-Type: application/json" -d "$BAD_PAYLOAD")
echo "    HTTP $code (webhook enfileira normalmente)"
[ "$code" = "200" ] || { echo "FALHA: esperava 200 do webhook, veio $code"; exit 1; }

echo "==> Aguardando o Lambda processar (e rejeitar)..."
sleep 8

echo "==> Verificando que o malformado NÃO foi persistido no DynamoDB"
item=$(awslocal dynamodb get-item --table-name "$TABLE_NAME" \
  --key '{"eventUuid":{"S":"smoke-bad-001"}}' --query 'Item' --output text)
[ "$item" = "None" ] || { echo "FALHA: payload malformado foi auditado: $item"; exit 1; }
echo "    OK: ausente em RawMessages (rejeitado antes de transformar)"

echo "✅ Smoke e2e OK"
