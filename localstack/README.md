# Rodando localmente com LocalStack

Pré-requisitos: Docker, Node 20+, e o CLI `awslocal` (`pip install awscli-local`).
O `cdklocal` já está nas devDependencies do projeto.

## 1. Subir o LocalStack

```bash
npm run local:up
```

## 2. Bootstrap + deploy

```bash
npm run local:bootstrap
npm run local:deploy
```

Anote os outputs `WebhookUrl` e `OutputQueueUrl` impressos no fim do deploy.

> No LocalStack, a URL do API Gateway tem o formato:
> `http://localhost:4566/restapis/<api-id>/prod/_user_request_/webhook`

## 3. Testar o webhook

Gere um JWT de teste assinado com o secret de dev (`local-dev-secret`, HS256):

```bash
node -e '
const { SignJWT } = require("jose");
new SignJWT({ sub: "tester" })
  .setProtectedHeader({ alg: "HS256" })
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode("local-dev-secret"))
  .then(t => console.log(t));
'
```

Guarde em `JWT=<token>`. Sem token / token inválido → **403** (authorizer nega):

```bash
curl -i -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer invalido" \
  -d '{"EventUuid":"evt-0001","Id":"1","CreatedAt":"2021-04-28T15:00:00Z","Email":"a@b.org","FirstName":"Seb","LastName":"Wolf","LastUpdatedAt":"2021-12-14T04:38:16Z","PhoneNumber":"(555) 555-5555"}'
```

Bearer JWT válido → **200** e mensagem enfileirada:

```bash
curl -i -X POST "$WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{"EventUuid":"evt-0001","Id":"1","CreatedAt":"2021-04-28T15:00:00Z","Email":"a@b.org","FirstName":"Seb","LastName":"Wolf","LastUpdatedAt":"2021-12-14T04:38:16Z","PhoneNumber":"(555) 555-5555"}'
```

## 4. Verificar o resultado

Mensagem RAW persistida:

```bash
awslocal dynamodb scan --table-name RawMessages
```

Mensagem traduzida na fila de saída:

```bash
awslocal sqs receive-message --queue-url "$OUTPUT_QUEUE_URL"
```

## Derrubar

```bash
npm run local:destroy   # remove a stack
npm run local:down      # para o container
```
