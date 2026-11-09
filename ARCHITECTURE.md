# Arquitetura — Distributed Wagering Processor

## Objetivo e prioridades

O serviço processa operações financeiras de apostas recebidas por HTTP e SQS, preservando saldo, histórico e idempotência com múltiplas instâncias. Assume entrega at-least-once, mensagens duplicadas ou fora de ordem, concorrência sobre a mesma carteira e interrupções de processo ou infraestrutura.

As prioridades são correção financeira, recuperação após falhas e decisões verificáveis. PostgreSQL é a autoridade das garantias financeiras; deduplicação e ordenação do SQS FIFO são otimizações. Não se promete exactly-once de transporte.

## Componentes e responsabilidades

```text
HTTP / NestJS ------+
                    +--> WageringService --> PostgreSQL
Consumidor SQS -----+      |                  wallets / transações
                           |                  ledger / inbox / outbox
                           |
                           +--> domínio: Money, Wallet e WagerTransaction

Worker de referências --> mesmo WageringService
Publisher da outbox ---> SQS de eventos
QueryService ----------> consultas, ledger e reconciliação
```

- `src/domain`: regras financeiras, factories e transições explícitas, sem decorators do NestJS ou ORM.
- `src/application`: processamento compartilhado, validação dos contratos HTTP, identidade futura e consultas.
- `src/infrastructure`: mapeamento ORM, migrations, SQS, publicadores, consumidores e telemetria.
- `src/app.ts`: configuração HTTP e criação da aplicação para execução e testes.
- `src/main.ts` e `src/worker.ts`: inicialização e encerramento dos processos.

A camada de aplicação usa diretamente o EntityManager e SQL parametrizado. É uma escolha de simplicidade para explicitar as operações financeiras e seus locks; não é uma implementação de arquitetura hexagonal com um repositório abstrato para cada tabela.

## Stack e uso do ORM

A solução usa Bun 1.4.4, TypeScript estrito, NestJS, PostgreSQL, MikroORM 6.6, AWS SDK SQS e LocalStack. O Compose constrói API e worker, espera as dependências e aplica migrations antes de iniciar a aplicação.

MikroORM foi escolhido por oferecer transações e EntityManagers isolados. Cada operação usa `orm.em.fork().transactional(...)`; não existe Identity Map compartilhado entre requisições. A carteira tem mapeamento `EntitySchema`. O caminho financeiro usa SQL parametrizado pelo EntityManager para tornar explícitos `ON CONFLICT`, locks e gravações atômicas.

Essa estratégia mantém o controle transacional do ORM e permite constraints e triggers específicas do PostgreSQL. Em contrapartida, exige manter migrations, SQL e reidratação sincronizados, em vez de depender apenas da Unit of Work para todas as escritas.

## Representação monetária

`Money` é um value object imutável, com construtor privado e factories. Usa uma instância isolada de decimal.js com precisão de 40 dígitos. Valores monetários não passam por `number`, `float` ou `double`.

- Entrada e saída usam strings decimais com exatamente duas casas.
- Valores negativos, notação científica, NaN, Infinity e escala inválida são rejeitados nos contratos de entrada.
- Não há arredondamento silencioso de entradas com mais de duas casas.
- Operações entre moedas diferentes geram erro de domínio.
- Diferenças internas podem ser negativas, por exemplo na reconciliação.
- A magnitude máxima é `999999999999999999.99`, compatível com `numeric(20,2)`.

Valor e moeda são persistidos separadamente. O driver devolve o valor numeric como string, e a aplicação o reidrata como Money. Créditos que ultrapassariam o limite do saldo são rejeitados com `BALANCE_LIMIT_EXCEEDED`, sem movimento financeiro.

O modelo suporta moedas diferentes, mas valida o código por formato de três letras maiúsculas; não consulta um catálogo completo ISO-4217 nem realiza conversão cambial. Exemplos e demonstração usam BRL.

## Carteira, ledger e invariantes no banco

`Wallet` encapsula saldo e versão. Créditos e débitos exigem valores positivos e produzem um `WalletLedgerEntry` com saldos anterior e posterior. A factory do lançamento valida sua aritmética antes de atualizar o agregado. Rejeições e LOSS não alteram saldo ou versão.

A abertura começa na versão 1. Saldo inicial positivo cria uma transação interna OPENING, seu lançamento CREDIT e eventos na mesma transação SQL. Saldo inicial zero não cria movimentação. A versão incrementa somente quando o saldo muda.

As principais garantias de schema são:

| Garantia | Mecanismo |
| --- | --- |
| Uma wallet por player e moeda | UNIQUE(player_id, currency) |
| Saldo nunca negativo | CHECK(balance >= 0) |
| Identidade externa e idempotência únicas | UNIQUE(provider_id, external_transaction_id) e UNIQUE(idempotency_key) |
| No máximo um lançamento por transação/wallet | UNIQUE(wallet_id, transaction_id) |
| Ledger corresponde à identidade financeira da transação | FK composta por transaction_id, wallet_id, amount e currency |
| Aritmética e saldos do lançamento válidos | CHECK de direção, valor positivo, não-negatividade e balance_before ± amount = balance_after |
| Ledger não pode ser atualizado ou excluído | Trigger de imutabilidade |
| Estado terminal não pode ser alterado | Trigger de transação terminal |
| Transações auditáveis não podem ser excluídas | Trigger de bloqueio de DELETE |
| Uma reversão de cada espécie por referência | Índice único parcial para REFUND/ROLLBACK PROCESSED |

Triggers diferíveis verificam o estado final no commit: transação PROCESSED com efeito financeiro exige um lançamento na direção correta; LOSS e estados sem aplicação não admitem lançamento. A verificação diferida permite inserir o ledger antes de marcar a transação como PROCESSED dentro da mesma transação SQL.

O banco não reconstrói todo o saldo histórico a cada commit. A aplicação atualiza saldo e ledger atomicamente, sob lock da wallet; a reconstrução integral fica na reconciliação. Acesso administrativo direto ainda pode criar divergência no saldo materializado, detectável pela reconciliação.

## Transação SQL e controle de concorrência

A unidade de concorrência é a wallet. O processamento segue esta ordem:

1. Validar o comando e calcular seu hash de negócio.
2. Quando a entrada é SQS, reservar e bloquear a inbox.
3. Bloquear a wallet com `SELECT ... FOR UPDATE`.
4. Reservar a identidade da transação com `INSERT ... ON CONFLICT DO NOTHING` ou reconhecer um replay.
5. Resolver referências e aplicar as regras de domínio.
6. Gravar saldo, versão, ledger, resultado, inbox e eventos da outbox.
7. Confirmar o commit; somente depois responder à entrada ou confirmar a mensagem SQS.

A ordem de locks é inbox, quando presente, depois wallet e transação. O lock da wallet precede a inserção da transação para evitar upgrade concorrente de locks adquiridos pela FK. Referências são consultadas sem bloquear outras wallets; uma referência em outra wallet é rejeitada.

A estratégia pessimista simplifica a disputa pelo saldo e funciona entre processos e instâncias. Wallets diferentes podem progredir em paralelo. O custo é serializar uma wallet muito disputada, inclusive seus replays; não há lock global nem meta de throughput assumida.

O cenário de 100.00 BRL com duas apostas de 80.00 resulta em uma operação processada, uma rejeitada, saldo 20.00 e um débito no ledger. Erros transitórios, incluindo deadlock/serialização, fazem rollback e permitem retry com a mesma key.

## Idempotência e replay

No HTTP, `Idempotency-Key` é obrigatória e é a fonte da verdade. No SQS, a key vem de `data.idempotencyKey`. Há garantias únicas no banco tanto para a key quanto para a identidade externa do provedor.

`payloadHash` usa SHA-256 de um JSON reconstruído com campos de negócio em ordem fixa: externalTransactionId, gameId, kind, money, playerId, providerId, referenceExternalTransactionId, roundId e walletId. Money é normalizado como amount/currency; referência ausente vira null. Header de idempotência e metadados de transporte não entram no hash financeiro.

- Mesma key e payload equivalente: replay do resultado persistido.
- Mesma key e payload diferente: conflito, sem efeito financeiro.
- Mesma identidade externa com outra key: conflito.
- O resultado é persistido em JSONB, incluindo o saldo observado naquele momento.

Assim, um replay não devolve por engano o saldo atual de outra operação posterior. A proteção permanece após reinício e não depende de cache em memória ou da janela de deduplicação FIFO.

## Operações, referências e estados

| Operação | Efeito |
| --- | --- |
| BET | Débito; rejeita saldo insuficiente |
| WIN | Crédito |
| LOSS | Registra resultado sem movimentar saldo |
| REFUND | Crédito que reverte uma BET processada |
| ROLLBACK | Movimento inverso de BET, WIN ou REFUND processado |

REFUND e ROLLBACK exigem referência externa e valor integral igual ao da operação referenciada. A referência é resolvida por providerId/externalTransactionId e deve corresponder ao mesmo provider, player, wallet, moeda e rodada. Uma referência pode ser revertida no máximo uma vez por espécie de reversão, conforme a regra do enunciado. Não há reversão parcial.

Reversão que debitaria saldo insuficiente gera `REVERSAL_INSUFFICIENT_FUNDS`, distinto de `INSUFFICIENT_FUNDS` da aposta. Rejeições permanecem auditáveis e não geram ledger.

Transições válidas:

- PENDING → PROCESSED, REJECTED, FAILED ou PENDING_REFERENCE.
- PENDING_REFERENCE → PENDING pelo reprocessamento explícito, ou REJECTED/FAILED.
- PROCESSED, REJECTED e FAILED são terminais e não aceitam novas transições.

O worker agendado reidrata a transação, revalida status e nextAttemptAt sob lock e executa o mesmo caso de uso. Referências ausentes usam backoff exponencial, iniciado em 2 segundos e limitado a uma hora. Ao atingir dez tentativas registradas ou 24 horas, o próximo processamento elegível rejeita com `REFERENCE_NOT_FOUND`, mesmo se a referência chegar depois do limite. O limite de tentativas restringe custo operacional; o TTL adicional protege registros antigos.

`API.md` documenta os failureCodes e seus contratos HTTP.

## Inbox e consumidor SQS

HTTP e SQS compartilham `WageringService`. A inbox usa chave composta `(consumerName, messageId)`. Seu hash combina a key de idempotência com o hash financeiro, detectando reutilização do messageId com comando diferente.

`InboxMessage` encapsula o estado recebido/processado. A reserva, a conclusão e as gravações financeiras participam da mesma transação SQL. Replay preserva o processedAt original; o schema impede alterar a identidade, o hash ou uma inbox já processada.

O consumidor confirma a mensagem com DeleteMessage somente após o commit. Durante processamento, renova a visibilidade a cada 20 segundos para um período de 60 segundos. Se morrer antes do ack, a reentrega encontra a inbox/transação persistida e não repete o efeito financeiro.

Erros de negócio são resultados terminais com ack. Erros de contrato/envelope vão à DLQ. Erros transitórios usam visibilidade exponencial limitada a 300 segundos, com até cinco recebimentos. A fila também tem redrive policy. A transferência explícita para DLQ envia antes de apagar a mensagem original: pode duplicar registros na DLQ em uma interrupção, mas não descarta a mensagem antes do envio.

Filas locais:

- `wager-transactions.fifo`: comandos financeiros.
- `wager-transactions-dlq.fifo`: mensagens que exigem análise/reprocessamento operacional.
- `wager-events.fifo`: eventos de integração, separados dos comandos para evitar realimentação.

## Outbox e eventos de integração

`OutboxMessage` registra um evento na mesma transação do resultado financeiro. Publicação ao SQS acontece exclusivamente depois do commit dessa transação.

O publisher seleciona registros com `FOR UPDATE SKIP LOCKED`, permitindo publishers concorrentes. Mantém o lock por registro durante o envio e marca a publicação em seguida. Esse desenho é simples, mas mantém uma transação SQL aberta durante a chamada externa; uma implementação com lease seria uma alternativa para maior escala.

Falhas de envio incrementam tentativas e backoff exponencial até uma hora, sem descartar eventos. Falha SQL depois de um envio confirmado faz rollback da marcação e preserva o registro para recuperação. Uma queda nesse intervalo pode repetir a publicação com o mesmo eventId: consumidores de eventos precisam deduplicá-lo persistentemente. FIFO não é a garantia final.

Os eventos herdam de `IntegrationEvent`, com subclasses concretas para Processed, Rejected, PendingReference, Failed e WalletBalanceChanged. O envelope contém eventId, eventType, version, aggregateId, correlationId, causationId, occurredAt e data. Dados monetários usam MoneyProps, nunca instâncias de Money. Entrada e serialização copiam os dados para evitar mutação por referências externas.

Correlação HTTP é propagada quando disponível. Na entrada SQS, messageId identifica correlação e causação. Fora desse contexto, transactionId é o fallback. WalletBalanceChanged só é emitido quando há mudança de saldo; LOSS ainda produz WagerTransactionProcessed.

## Falhas permanentes e encerramento

SQLSTATE 42501, 0A000, 42P01 e 42703 são classificados como permanentes: permissão, recurso não suportado ou schema incompatível. Após rollback financeiro, o consumidor tenta registrar a operação válida como FAILED/INFRASTRUCTURE_FAILURE em uma transação separada, com inbox e evento WagerTransactionFailed, sem movimentar saldo.

Uma operação já terminal preserva seu resultado. Se não for possível gravar a auditoria, a tentativa não confirma nem transfere a mensagem, que permanece sujeita ao redrive. Erros de conexão, deadlock e serialização continuam transitórios; esgotar tentativas não os transforma automaticamente em FAILED. A DLQ preserva a evidência operacional nesse caso.

SIGTERM/SIGINT interrompem novas iterações do worker e aguardam o trabalho em andamento. O Compose oferece 90 segundos de grace period ao worker. Em encerramento forçado, a recuperação depende da visibilidade SQS e da idempotência persistente. A API fecha o servidor, ORM e cliente SQS por um único caminho de shutdown.

## Consultas, reconciliação e observabilidade

O ledger usa paginação keyset ascendente por `(created_at, id)`. O cursor base64url inclui walletId, timestamp com microssegundos e ID. É opaco por contrato, mas não assinado. Novas entradas podem aparecer em páginas posteriores; não se promete um snapshot entre requisições.

Reconciliação obtém o mesmo lock por wallet que os escritores e soma créditos menos débitos em numeric exato no PostgreSQL. Compara saldo reconstruído e armazenado, retorna diferença assinada, registra divergências em log/métrica e não corrige valores automaticamente.

- `/health/live` verifica processo vivo, independentemente das dependências.
- `/health/ready` consulta PostgreSQL e SQS.
- API e worker expõem métricas em texto Prometheus, nas portas locais 3000 e 3001.
- Status e lag da outbox são consultados no banco. Duplicatas, retries, DLQ, conflitos e latências são métricas por processo, reiniciadas com ele; agregação depende de scrape por instância.
- O histograma financeiro inclui chamadas, replays e falhas, sem valores monetários.
- Logs JSON usam identificadores de correlação, mensagem, transação, wallet e provedor quando aplicáveis. Não registram payloads financeiros completos ou SQL do driver. `transaction_prepared` ocorre antes do commit e não é comprovação de confirmação.

## Autenticação e escopo de identidade

Autenticação foi omitida conforme a opção explícita do enunciado, priorizando correção financeira e recuperação. A API local não está autenticada. `ProviderIdentityPort` é o ponto de extensão para integrar um IdP externo.

Um adaptador futuro validaria JWT por JWKS, issuer, audience e expiração. Um guard compararia o providerId do payload com o claim confiável. Criação de carteira e crédito inicial exigiriam scope administrativo separado. Health permaneceria aberto. A fila é canal interno confiável conforme o desafio, mantendo as validações de identidade de domínio. Não há tabela própria de senhas.

## Containers, migrations e recuperação local

Dockerfile fixa Bun 1.4.4, instala dependências com lockfile congelado e executa com usuário sem privilégios. As portas do Compose são publicadas apenas em 127.0.0.1. O serviço de testes usa uma imagem de validação com fontes e testes, sem depender de Bun instalado no host.

As quatro migrations têm up/down. A migration 002 permite auditar rejeições com moeda divergente; seu rollback restaura a FK composta como NOT VALID, preservando o histórico existente e verificando novas escritas. As migrations 003/004 reforçam ledger, inbox e preservação das transações.

API, worker e infraestrutura usam restart unless-stopped. LocalStack usa endpoint strategy dynamic para funcionar entre host e containers. Como as filas do emulador não têm volume persistente, o worker recria a topologia conhecida após QueueDoesNotExist. Isso recupera o fluxo e a outbox SQL pendente, mas não restaura mensagens já confirmadas que o emulador perdeu ao reiniciar. Em ambiente AWS, a topologia deve ser provisionada por infraestrutura e valem as garantias de durabilidade do serviço.

## Validação e limitações

A validação final em cópia limpa, sem `.git`, ferramentas locais ou dependências instaladas do host, aprovou TypeScript estrito e 63 testes em Linux, sem testes ignorados. As quatro migrations foram aplicadas, revertidas em ordem inversa e reaplicadas em um banco vazio.

Os cenários incluem 50 submissões paralelas da mesma aposta, três processos independentes, wallets concorrentes, reversões, dois publishers separados, rollback atômico, queda após commit/antes do ack, SIGTERM real e falha SQL após envio do evento. O exercício isolado de indisponibilidade total comprovou 503 durante queda do PostgreSQL e retenção/publicação da outbox durante queda/recuperação do SQS, com reconciliação consistente.

Há limites deliberados: autenticação não implementada, ausência de conversão cambial e catálogo completo de moedas, ledger simples em vez de partidas dobradas, ausência de benchmark de carga e de dashboard/collector centralizado. O lock pessimista limita paralelismo de uma wallet muito disputada; a publicação mantém lock durante I/O. Não há afirmação de RPS, SLA ou prontidão de produção baseada nesses testes.

Para reproduzir a execução e os testes, consulte [README.md](README.md). Os contratos estão em [API.md](API.md), os resultados finais em [VALIDATION.md](VALIDATION.md) e o roteiro de apresentação em [DEMO.md](DEMO.md).
