# message-translator

Serviço que recebe webhooks, **transforma o formato** de cada mensagem (de um formato de entrada
para outro de saída — não é tradução de idioma) e enfileira o resultado para outro serviço consumir.
A mensagem original (raw) é persistida no DynamoDB antes da transformação.

## Arquitetura

```
Webhook ──▶ API Gateway (REST) ──▶ [Lambda Authorizer valida token de header]
                  │
                  ▼ (integração direta com SQS, sem Lambda no ingest)
            SQS: ingest-queue ──▶ Lambda (translator)
                  │ (DLQ)              │
                                       ├─▶ DynamoDB (RawMessages: salva raw)
                                       ├─▶ transforma formato (src/transform)
                                       └─▶ SQS: output-queue ──▶ (outro serviço consome)
                                                 │ (DLQ)
```

Stack: **TypeScript 5.x + AWS CDK v2**, runtime **Node.js 22 (ARM64)**, região padrão `us-east-1`.

## Estrutura

```
bin/app.ts                  entrypoint CDK
lib/translator-stack.ts     toda a infra (API GW, SQS x2 + DLQs, DynamoDB, Lambdas, IAM)
src/handlers/authorizer.ts  Lambda Authorizer (valida x-webhook-token)
src/handlers/translator.ts  consome ingest-queue, salva raw, transforma, envia
src/transform/              ⭐ módulo plugável: implemente o mapeamento real aqui
src/lib/{ddb,sqs}.ts        helpers de I/O (honram AWS_ENDPOINT_URL p/ LocalStack)
test/                       testes unitários (vitest)
localstack/                 docker-compose + guia de execução local
```

## Transformação de formato

`src/transform/index.ts` mapeia a entrada (PascalCase) para a saída (snake_case), repassando um
subconjunto dos campos:

| Entrada         | Saída          |
| --------------- | -------------- |
| `Id`            | `id`           |
| `CreatedAt`     | `created_at`   |
| `Email`         | `email`        |
| `FirstName`     | `first_name`   |
| `LastName`      | `last_name`    |
| `LastUpdatedAt` | `updated_at`   |
| `PhoneNumber`   | `phone_number` |

Campos como `EventUuid`, `Status`, `UnitIds`, `RentalApplicationId` e `Has*` são descartados. Para
mudar o mapeamento, edite apenas `src/transform/{index,types}.ts` — a infra não muda.

## Entrega e idempotência

Ordem: **entrega primeiro, grava depois** (sem perda de mensagem). O handler:

1. transforma e **envia** para a `output-queue`; se isso falhar, nada foi gravado e a retentativa
   do SQS reenvia;
2. grava o RAW em `RawMessages` com **PutItem condicional** (`attribute_not_exists(eventUuid)`,
   sem `GetItem`) — apenas **auditoria best-effort**: `EventUuid` repetido ou erro de gravação
   viram log e **não** forçam reenvio de algo já entregue.

A mensagem traz um `EventUuid` único, usado como **partition key** da tabela.

> **Semântica: at-least-once.** Como entregamos antes de gravar, a `output-queue` pode receber o
> mesmo `EventUuid` mais de uma vez (no raro intervalo em que o envio teve sucesso mas o record foi
> reprocessado). **O serviço consumidor deve ser idempotente por `EventUuid`.** Se você precisar de
> dedupe garantido *antes* da entrega sem perder mensagens, dá para usar um campo de status de
> entrega no item (claim `pending` → envia → marca `delivered`) — me avise.

## Autenticação

O webhook é validado por um **Lambda Authorizer** que verifica um **Bearer JWT** no header
`Authorization: Bearer <token>`. A assinatura é validada com HS256 usando o secret da env var
`JWT_SECRET`.

```
Authorization: Bearer <jwt-assinado-com-HS256>
```

O secret vem de `JWT_SECRET` (em dev/LocalStack o default é `local-dev-secret`). Em produção,
defina `JWT_SECRET` no ambiente do Lambda — de preferência via **SSM Parameter Store / Secrets
Manager** em vez de texto plano no CDK.

## Comandos

```bash
npm install
npm run build      # type-check (tsc --noEmit)
npm test           # testes unitários (vitest)
npm run synth      # cdk synth

# Local (LocalStack) — ver localstack/README.md
npm run local:up
npm run local:bootstrap
npm run local:deploy
```

## CI/CD (GitHub Actions)

- **`.github/workflows/ci.yml`** (push/PR para `main`):
  - `build-test`: `npm ci` → type-check → testes → `cdk synth`;
  - `e2e-localstack`: sobe o LocalStack e roda `scripts/smoke-local.sh` (deploy + POST no
    webhook + verificação de DynamoDB e output-queue). Mesmo smoke test roda local com
    `npm run smoke:local` (com o LocalStack no ar).
- **`.github/workflows/deploy.yml`** (push para `main` + `workflow_dispatch`): `cdk deploy` na
  AWS via **OIDC** (sem chaves de longa duração).

### Configuração necessária para o deploy

No repositório/ambiente `production` do GitHub:

| Tipo | Nome | Descrição |
| ---- | ---- | --------- |
| Secret | `AWS_DEPLOY_ROLE_ARN` | ARN da role IAM que o GitHub assume via OIDC (trust no provider `token.actions.githubusercontent.com`). |
| Secret | `JWT_SECRET` | Secret HS256 usado pelo authorizer em produção. |
| Variable | `AWS_REGION` | Região (default `us-east-1` se ausente). |

A conta precisa estar `cdk bootstrap`-ada e a role deve ter permissão para assumir as roles de
deploy do CDK.

## Próximos passos (opcionais)

- Mover `JWT_SECRET` para SSM/Secrets Manager em vez de env var em texto plano.
- Adicionar validação de schema na entrada (ex.: zod) se quiser rejeitar payloads malformados
  antes de transformar.
