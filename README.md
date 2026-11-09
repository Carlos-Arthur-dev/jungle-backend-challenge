# Jungle — Distributed Wagering Processor

Implementação do [desafio oficial](https://github.com/junglegaming/backend-challenge).

O acompanhamento requisito a requisito e as pendências estão em `REQUIREMENTS.md`. A suíte atual inclui três processos Bun independentes e morte forçada de um worker de teste após commit e antes do ack; esses testes encerram somente os processos que criam.

A validação em cópia limpa está em `VALIDATION.md`: construção sem cache, TypeScript aprovado e 63 testes Linux aprovados, sem testes ignorados.

## Pré-requisitos

- Docker com Compose e suporte a containers Linux.
- Bun 1.x é necessário apenas se preferir executar código/testes diretamente no host. A imagem Docker já inclui Bun 1.4.4.

## Iniciar tudo com Docker

```powershell
docker compose up -d --build --wait
```

O Compose constrói API e worker, espera PostgreSQL/LocalStack, aplica migrations em um serviço de execução única e inicia a aplicação. Não exige Bun instalado no host para executar os serviços. API em `http://127.0.0.1:3000`; readiness em `/health/ready`. API, worker e infraestrutura têm política `unless-stopped` para recuperação de falhas de inicialização e reinícios.

```powershell
docker compose logs -f api worker
docker compose stop
```

Para executar os testes pelo Bun local, pare o worker do Compose (`docker compose stop worker`) para que ele não dispute as mensagens da suíte. Mantenha PostgreSQL e LocalStack ativos. Portas alternativas podem ser definidas por `API_PORT`, `POSTGRES_PORT` e `LOCALSTACK_PORT`.

Para checar tipos e executar a suíte completa em Linux, usando apenas Docker:

```powershell
docker compose stop worker
docker compose --profile test run --rm --build tests
docker compose start worker
```

O serviço `tests` instala dependências pelo lockfile congelado, roda TypeScript e testes unitários/de integração, incluindo subprocessos e SIGTERM real. Use um banco local de desenvolvimento; a suíte cria dados sintéticos e não apaga registros existentes.

## Desenvolvimento no host (opcional)

```powershell
bun install --frozen-lockfile
bun run test
bun run typecheck
```

Há domínio monetário, carteira, ledger, transações e API NestJS com persistência PostgreSQL via MikroORM. Há consumidor SQS, publisher da outbox e worker de referências pendentes. As decisões e limitações estão em `ARCHITECTURE.md`.

## API e banco

Para executar a API no host, deixe apenas a infraestrutura no Docker. Se iniciou o Compose completo, pare seus processos de aplicação antes de usar as mesmas portas:

```powershell
docker compose stop api worker
docker compose up -d postgres localstack
bun run db:migrate
bun run start
```

A API escuta em `http://127.0.0.1:3000`. Endpoints disponíveis: `POST /wallets`, `GET /wallets/:id`, `POST /wagering/transactions` (header `Idempotency-Key` obrigatório) e `GET /health/live`. Os contratos seguem o enunciado oficial. `DATABASE_URL` e `PORT` podem ser configurados por variáveis de ambiente.

Consultas e diagnóstico:

- `GET /wagering/transactions/:transactionId`
- `GET /providers/:providerId/wagering/transactions/:externalTransactionId`
- `GET /wallets/:walletId/ledger?limit=50&cursor=...` (limite de 1 a 100; use `nextCursor` retornado)
- `POST /wallets/:walletId/reconciliation` (não altera o saldo)
- `GET /health/ready` (consulta PostgreSQL e SQS)
- `GET /metrics` (texto compatível com Prometheus)

O header opcional `X-Correlation-Id` é validado e devolvido na resposta; quando ausente, a API cria um identificador. Os logs não incluem payloads financeiros completos.

O worker expõe `http://127.0.0.1:3001/metrics`, incluindo retries, DLQ e publicação. `WORKER_METRICS_PORT` altera a porta local. No Compose, essa variável altera a porta publicada do host; o container continua usando 3001. Ao executar múltiplos workers no host, use portas diferentes. API e worker expõem histograma `jungle_processing_seconds` para as chamadas de processamento financeiro.

### Teste de SIGTERM no Linux

No Windows, o teste de SIGTERM é ignorado por diferenças na entrega de sinais. Para executá-lo no runtime Linux do Docker, com PostgreSQL e LocalStack ativos no projeto padrão:

```powershell
docker build --target validation -t jungle-validation:local .
docker run --rm --network jungle-wagering_default -e DATABASE_URL=postgresql://jungle:jungle_local@postgres:5432/jungle -e SQS_ENDPOINT=http://localstack:4566 jungle-validation:local bun test tests/integration/shutdown.test.ts
```

O teste envia uma mensagem a uma fila isolada, pausa o consumidor depois do commit, entrega SIGTERM ao processo de teste e verifica conclusão do ack, saldo e ledger. As filas criadas são removidas ao final.

### Indisponibilidade total

No PowerShell 7, execute `./scripts/test-outages.ps1`. O script usa exclusivamente o projeto `jungle-clean-check`, com portas 3100/3101/55432/14566, para parar e restaurar PostgreSQL e LocalStack. Verifica readiness/liveness, HTTP transitório, recuperação idempotente e publicação da outbox. Grava `outage-evidence.json` com reconciliação final; mantém volumes e restaura serviços mesmo após falha de asserção. O projeto padrão não é parado. Ao terminar, libere recursos com `docker compose -p jungle-clean-check stop`.

O guia `DEMO.md` contém um roteiro para apresentação e explicação das decisões.

Os achados e correções da revisão de código estão em `REVIEW.md`, incluindo as garantias adicionais de schema das migrations 003 e 004.

`API.md` documenta corpos, respostas, paginação, status HTTP e códigos de falha. Os testes HTTP iniciam uma API real em porta temporária e usam PostgreSQL/LocalStack reais.

```powershell
bun run test:integration
bun run db:rollback
```

O rollback reverte a última migration; use apenas em banco de desenvolvimento. Os testes de integração criam dados com IDs aleatórios no banco local, sem limpar dados existentes. `bun test` executa também a pasta de integração; `bun run test` executa apenas testes unitários.

## Infraestrutura local

Com Docker Desktop aberto:

```powershell
docker compose up -d --wait
docker compose ps
```

PostgreSQL está em `localhost:5432`, banco/usuário `jungle`, senha de desenvolvimento `jungle_local`. LocalStack SQS está em `http://localhost:4566`. As portas ficam vinculadas apenas à interface local. O banco usa volume persistente.

## Workers

O Compose completo inicia o worker automaticamente. No modo de desenvolvimento no host, em outro terminal após as migrations, execute `bun run worker`. Ele provisiona `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo`. A fila de eventos fica separada dos comandos para evitar realimentação. Para múltiplas instâncias no host, use portas de métricas diferentes.

Configurações opcionais: `SQS_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. Defaults são locais, com credenciais `test`/`test`. O envelope segue o enunciado, incluindo `data.idempotencyKey`. O produtor deve usar `MessageGroupId=walletId` e deduplicação estável por envio lógico.

SIGTERM/SIGINT interrompem novas iterações; a execução aguarda a mensagem em andamento. O consumidor renova a visibilidade a cada 20 segundos. Recriar o container LocalStack atual pode apagar as filas do emulador; o PostgreSQL e a outbox persistem no volume do banco.

Para parar sem apagar os dados:

```powershell
docker compose stop
```
