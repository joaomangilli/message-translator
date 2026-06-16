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

Stack: **TypeScript 5.x + AWS CDK v2**, runtime **Node.js 22**, região padrão `us-east-1`.
Arquitetura das Lambdas configurável: **`arm64`** (Graviton) por padrão em qa/prod, **`x86_64`** no
deploy local/CI (LocalStack roda em amd64). Os recursos são **namespaceados por ambiente** (sufixo
`-qa` / `-prod` / `-local`) para coexistirem na mesma conta sem colidir.

## Estrutura

```
bin/app.ts                  entrypoint CDK
lib/translator-stack.ts     toda a infra (API GW, SQS x2 + DLQs, DynamoDB, Lambdas, IAM)
src/handlers/authorizer.ts  Lambda Authorizer (valida x-webhook-token)
src/handlers/translator.ts  consome ingest-queue, salva raw, transforma, envia
src/transform/              ⭐ módulo plugável: mapeamento + schema zod de entrada
src/lib/{ddb,sqs}.ts        helpers de I/O (honram AWS_ENDPOINT_URL p/ LocalStack)
src/lib/secrets.ts          lê o JWT secret do Secrets Manager (cache por container)
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

### Validação de entrada (zod)

Antes de transformar, o handler valida o payload com o schema **`InputMessageSchema`**
(`src/transform/types.ts`, fonte única de verdade — o tipo `InputMessage` é derivado por
`z.infer`). A validação exige os campos obrigatórios como **strings não-vazias** e checa o tipo
dos opcionais; campos extras desconhecidos são **mantidos** (`z.looseObject`). Um payload
malformado é **rejeitado antes da transformação** e vai para a DLQ via `reportBatchItemFailures`
(sem ser entregue na `output-queue`).

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
`Authorization: Bearer <token>`, com assinatura HS256.

```
Authorization: Bearer <jwt-assinado-com-HS256>
```

O secret **não** é mais env var em texto plano: o authorizer o lê em **runtime do AWS Secrets
Manager** (`src/lib/secrets.ts`, com cache por container), referenciado **por nome** via a env var
`JWT_SECRET_NAME` (default por ambiente: `message-translator/<env>/jwt-secret`). O CDK apenas
**referencia** o secret existente (`Secret.fromSecretNameV2`) e concede `grantRead` ao authorizer —
**não cria** o secret. Se o secret não puder ser resolvido, o authorizer nega (fail-closed).

> O secret precisa **já existir** no Secrets Manager da conta/região (ex. `message-translator/qa/jwt-secret`),
> ou aponte outro nome via `JWT_SECRET_NAME`. No LocalStack community o authorizer é pulado
> (`DISABLE_AUTHORIZER=true`), pois `AWS::ApiGateway::Authorizer` é recurso Pro.

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
    webhook + verificação de DynamoDB e output-queue, incluindo o caso de payload malformado
    rejeitado). Mesmo smoke test roda local com `npm run smoke:local` (com o LocalStack no ar).
- **`.github/workflows/deploy.yml`** — **deploy SOMENTE manual**: não roda mais em push na `main`.
  Use **Run workflow** (`workflow_dispatch`) e escolha o **ambiente** no dropdown (`qa` ou `prod`).
  O ambiente escolhido vira o GitHub Environment do job, é passado ao CDK via `ENVIRONMENT`
  (namespaceia os recursos) e o `cdk deploy` roda na AWS via **OIDC** (sem chaves de longa duração).

### Configuração necessária para o deploy

O deploy roda no **GitHub Environment** escolhido — crie os Environments **`qa`** e **`prod`**
(Settings → Environments), cada um com:

| Tipo | Nome | Descrição |
| ---- | ---- | --------- |
| Secret | `AWS_DEPLOY_ROLE_ARN` | ARN da role IAM que o GitHub assume via OIDC (trust no provider `token.actions.githubusercontent.com`). |
| Variable | `AWS_REGION` | Região (default `us-east-1` se ausente). |
| Variable | `JWT_SECRET_NAME` | (Opcional) Nome do secret no Secrets Manager; se ausente, usa `message-translator/<env>/jwt-secret`. |

A conta precisa estar `cdk bootstrap`-ada, a role deve poder assumir as roles de deploy do CDK, e o
secret HS256 do authorizer deve **já existir** no Secrets Manager por ambiente. Como `qa` e `prod`
ficam na **mesma conta**, os recursos são suffixados por ambiente. Em `prod` você pode exigir
aprovação manual via *required reviewers* do Environment.

> Sem o Environment/`AWS_DEPLOY_ROLE_ARN` configurado, o step de credenciais OIDC falha com
> *"Could not load credentials from any providers"* — o `role-to-assume` chega vazio.

## Próximos passos (opcionais)

- Dedupe garantido *antes* da entrega (claim `pending` → envia → `delivered`) se quiser evitar o
  at-least-once na `output-queue`.
- `removalPolicy: RETAIN` para a tabela em `prod` (hoje é `DESTROY`, pensado para dev).
- Atualizar as actions para Node.js 24 (o runner avisa que Node.js 20 será removido).
