import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export interface TranslatorStackProps extends cdk.StackProps {
  /** Ambiente de deploy (ex. `qa`, `prod`, `local`); sufixa os nomes físicos. */
  readonly environment: string;
  /** Arquitetura das Lambdas. Default `arm64` (Graviton); `x86_64` p/ LocalStack/CI. */
  readonly lambdaArchitecture?: 'arm64' | 'x86_64';
  /**
   * Nome do secret (no AWS Secrets Manager) cujo `SecretString` é o secret HS256
   * usado pelo Lambda Authorizer para verificar o Bearer JWT. O secret deve já
   * existir; este stack apenas o referencia e concede leitura ao authorizer.
   */
  readonly jwtSecretName: string;
  /**
   * Atacha o Lambda Authorizer ao método. Default `true`. Defina `false` no
   * LocalStack community, que NÃO suporta `AWS::ApiGateway::Authorizer`
   * (recurso só de Pro). Em AWS real mantenha `true`.
   */
  readonly attachAuthorizer?: boolean;
}

export class TranslatorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TranslatorStackProps) {
    super(scope, id, props);

    // Sufixo de ambiente aplicado a todos os nomes físicos, para que qa/prod (e
    // local) coexistam na mesma conta/região sem colidir.
    const env = props.environment;

    const architecture =
      props.lambdaArchitecture === 'x86_64'
        ? lambda.Architecture.X86_64
        : lambda.Architecture.ARM_64;

    // ---------------------------------------------------------------------
    // DynamoDB: guarda a mensagem RAW (como chegou) para auditoria/reprocesso.
    // ---------------------------------------------------------------------
    // PK = eventUuid (campo `EventUuid` da mensagem) garante idempotência:
    // o handler faz PutItem condicional e ignora duplicadas.
    const rawTable = new dynamodb.Table(this, 'RawMessages', {
      tableName: `RawMessages-${env}`,
      partitionKey: { name: 'eventUuid', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // ambiente de dev; revise em prod
      timeToLiveAttribute: 'ttl',
    });

    // ---------------------------------------------------------------------
    // SQS: fila de entrada (ingest) + fila de saída (output), cada uma com DLQ.
    // ---------------------------------------------------------------------
    const ingestDlq = new sqs.Queue(this, 'IngestDlq', {
      queueName: `ingest-dlq-${env}`,
      retentionPeriod: cdk.Duration.days(14),
    });
    const ingestQueue = new sqs.Queue(this, 'IngestQueue', {
      queueName: `ingest-queue-${env}`,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: { queue: ingestDlq, maxReceiveCount: 5 },
    });

    const outputDlq = new sqs.Queue(this, 'OutputDlq', {
      queueName: `output-dlq-${env}`,
      retentionPeriod: cdk.Duration.days(14),
    });
    const outputQueue = new sqs.Queue(this, 'OutputQueue', {
      queueName: `output-queue-${env}`,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: { queue: outputDlq, maxReceiveCount: 5 },
    });

    // ---------------------------------------------------------------------
    // Lambda Authorizer: valida um Bearer JWT no header `Authorization`.
    // Pulado no LocalStack community (não suporta AWS::ApiGateway::Authorizer).
    // ---------------------------------------------------------------------
    const attachAuthorizer = props.attachAuthorizer ?? true;
    let authorizer: apigateway.RequestAuthorizer | undefined;

    if (attachAuthorizer) {
      // Secret existente: apenas referenciado (não criado) e lido em runtime.
      const jwtSecret = secretsmanager.Secret.fromSecretNameV2(
        this,
        'JwtSecret',
        props.jwtSecretName,
      );

      const authorizerFn = new nodejs.NodejsFunction(this, 'AuthorizerFn', {
        functionName: `webhook-authorizer-${env}`,
        entry: path.join(__dirname, '../src/handlers/authorizer.ts'),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture,
        timeout: cdk.Duration.seconds(10),
        environment: {
          JWT_SECRET_NAME: props.jwtSecretName,
        },
      });

      jwtSecret.grantRead(authorizerFn);

      authorizer = new apigateway.RequestAuthorizer(this, 'WebhookAuthorizer', {
        handler: authorizerFn,
        identitySources: [apigateway.IdentitySource.header('Authorization')],
        resultsCacheTtl: cdk.Duration.seconds(0),
      });
    }

    // ---------------------------------------------------------------------
    // Lambda translator: consome ingest-queue, salva raw, transforma, envia.
    // ---------------------------------------------------------------------
    const translatorFn = new nodejs.NodejsFunction(this, 'TranslatorFn', {
      functionName: `message-translator-${env}`,
      entry: path.join(__dirname, '../src/handlers/translator.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture,
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: rawTable.tableName,
        OUTPUT_QUEUE_URL: outputQueue.queueUrl,
      },
    });

    rawTable.grantWriteData(translatorFn);
    outputQueue.grantSendMessages(translatorFn);

    translatorFn.addEventSource(
      new SqsEventSource(ingestQueue, {
        batchSize: 10,
        reportBatchItemFailures: true,
      }),
    );

    // ---------------------------------------------------------------------
    // API Gateway REST: POST /webhook -> integração DIRETA com a ingest-queue.
    // ---------------------------------------------------------------------
    const apiToSqsRole = new iam.Role(this, 'ApiGatewaySqsRole', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });
    ingestQueue.grantSendMessages(apiToSqsRole);

    const api = new apigateway.RestApi(this, 'WebhookApi', {
      restApiName: `message-translator-webhook-${env}`,
      deployOptions: { stageName: env },
    });

    const sqsIntegration = new apigateway.AwsIntegration({
      service: 'sqs',
      integrationHttpMethod: 'POST',
      path: `${cdk.Aws.ACCOUNT_ID}/${ingestQueue.queueName}`,
      options: {
        credentialsRole: apiToSqsRole,
        passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
        requestParameters: {
          'integration.request.header.Content-Type': "'application/x-www-form-urlencoded'",
        },
        requestTemplates: {
          // Envia o corpo cru do webhook como MessageBody da fila.
          'application/json': 'Action=SendMessage&MessageBody=$util.urlEncode($input.body)',
        },
        integrationResponses: [
          {
            statusCode: '200',
            responseTemplates: { 'application/json': '{"status":"queued"}' },
          },
          { statusCode: '400', selectionPattern: '4\\d{2}' },
          { statusCode: '500', selectionPattern: '5\\d{2}' },
        ],
      },
    });

    const webhook = api.root.addResource('webhook');
    webhook.addMethod('POST', sqsIntegration, {
      ...(authorizer
        ? { authorizer, authorizationType: apigateway.AuthorizationType.CUSTOM }
        : {}),
      methodResponses: [{ statusCode: '200' }, { statusCode: '400' }, { statusCode: '500' }],
    });

    // ---------------------------------------------------------------------
    // Outputs.
    // ---------------------------------------------------------------------
    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: `${api.url}webhook`,
      description: 'POST aqui para enviar um webhook.',
    });
    new cdk.CfnOutput(this, 'OutputQueueUrl', {
      value: outputQueue.queueUrl,
      description: 'Fila consumida pelo serviço de destino.',
    });
    new cdk.CfnOutput(this, 'OutputQueueArn', { value: outputQueue.queueArn });
    new cdk.CfnOutput(this, 'RawTableName', { value: rawTable.tableName });
  }
}
