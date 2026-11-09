# Decisões de arquitetura

## Estado atual

Domínio monetário, carteira, ledger e transações; API NestJS inicial; PostgreSQL via MikroORM 6.6; migrations versionadas; Compose de PostgreSQL e LocalStack. Workers de SQS, outbox e referências implementados.

## Transação e concorrência implementadas

Cada chamada usa um EntityManager isolado com `fork().transactional()`. O mapeamento da carteira usa EntitySchema; o caminho financeiro usa SQL parametrizado via EntityManager para explicitar reserva de idempotência, `ON CONFLICT` e `FOR UPDATE`. Não há Identity Map compartilhado entre requisições. Numeric monetário é recebido como string e reidratado como Money.

A reserva de transação usa constraints únicas para key e identidade do provedor; chamadas concorrentes aguardam o commit da vencedora. A mesma key com hash divergente ou outra key para a mesma identidade externa resulta em conflito. O hash SHA-256 usa objeto reconstruído com campos de negócio ordenados explicitamente, incluindo money normalizado; header e transporte ficam fora. A resposta é gravada em JSONB para preservar o saldo original no replay.

A carteira é bloqueada por linha antes de qualquer movimentação. Saldo, versão, ledger, resultado e eventos de outbox são gravados na mesma transação. Reversões usam índice único parcial por referência e espécie, além da validação de domínio. O ledger impede UPDATE/DELETE via trigger e verifica a aritmética no schema. A abertura positiva gera OPENING e ledger na mesma transação, mantendo versão 1.

HTTP: 200 para resultado processado/replay, 201 para criação, 202 para referência pendente, 400 para contrato inválido, 404 para carteira ausente, 409 para conflito, 422 para rejeição de negócio e 503 para falha não classificada de infraestrutura.

FAILED terminal usa 500 com failureCode persistido; reconciliação é 200. A borda HTTP valida DTOs explicitamente antes do caso de uso, sem depender de coerção do ORM ou de regex em mensagens de erro internas. Transações consultadas têm serialização camelCase própria. API.md detalha o contrato. O limite monetário de saldo é regra de negócio: créditos que excedem numeric(20,2) geram REJECTED/BALANCE_LIMIT_EXCEEDED.

## Limitações atuais (trabalho pendente)

- InboxMessage e OutboxMessage modelam os estados; a inbox usa SQL para deduplicação e marcação atômica. A classe OutboxMessage controla publicação e backoff no publisher.
- Eventos têm subclasses concretas, correlação HTTP propagada quando disponível e causationId da mensagem ou transação. Retries agendados usam transactionId como fallback.
- Falhas permanentes de envelope são auditadas pela DLQ. Operações válidas afetadas por SQLSTATE permanente conhecido podem ser persistidas como FAILED sem efeito financeiro, em transação separada após rollback.
- Consultas, paginação, reconciliação, readiness, histograma financeiro e endpoint de métricas do worker implementados. Agregação entre instâncias depende de scraping externo.
- ProviderIdentityPort é o ponto de extensão para IdP OIDC; API local continua sem autenticação conforme decisão de escopo.
- Três processos reais, morte de worker após commit/antes do ack, restart completo isolado e publishers em processos separados comprovados.

## Execução em containers

Dockerfile usa Bun 1.4.4, lockfile congelado e usuário sem privilégios. Compose executa migrations após health do PostgreSQL, e só então inicia API/worker. HOST=0.0.0.0 é usado dentro do container, com porta exposta somente em 127.0.0.1 no host. LocalStack usa endpoint strategy dynamic para URLs de fila acessíveis tanto pelo host como pela rede Docker.

Validação de instalação limpa usou projeto isolado jungle-clean-check, volume novo e portas alternativas. Criou-se carteira de 100.00 e aposta de 25.00 com publisher parado; após reinício dos quatro serviços, replay retornou 75.00, reconciliação mostrou diferença 0.00 e não sobraram eventos pendentes dessa wallet. Falha de startup do worker enquanto SQS reiniciava motivou política restart unless-stopped; não depende de intervenção para tentar iniciar novamente.
- O rollback da migration 002 restaura a FK composta como NOT VALID para preservar rejeições auditáveis já existentes com moeda divergente; a FK volta a validar novas escritas sem apagar histórico.

## Carteira e ledger

Cada crédito ou débito exige valor estritamente positivo e retorna um lançamento que contém os saldos anterior e posterior. A carteira só muda depois que a factory do lançamento valida a aritmética. Rejeições preservam saldo e versão. Datas são copiadas nas entradas e nas consultas para impedir mutação indireta. A abertura inicia na versão 1 e persiste OPENING e ledger quando o saldo inicial é positivo.

Essas garantias de domínio são complementadas por transação SQL, locks e constraints. Há testes com conexões concorrentes reais, três processos separados e morte forçada de worker.

## Dinheiro

`Money` usa decimal.js com precisão isolada de 40 dígitos. Contratos exigem string não negativa com exatamente duas casas; valores com escala diferente são rejeitados, nunca arredondados silenciosamente. Resultados internos podem ser negativos para representar diferenças de reconciliação.

O limite de magnitude é `999999999999999999.99`, compatível com a futura coluna PostgreSQL `numeric(20,2)`. A soma de dois valores suportados é exata antes da checagem de overflow. Moedas são códigos de três letras maiúsculas; a validação de moedas habilitadas será feita no contrato da aplicação. O domínio permite comparar os comportamentos de moedas distintas sem depender de NestJS ou ORM.

## Diretrizes de arquitetura

- NestJS e MikroORM; domínio independente de decorators de infraestrutura.
- Transações SQL e locks por wallet; nenhuma trava global.
- Unicidade de idempotência e identidade do provedor garantida no PostgreSQL.
- Ledger imutável e saldo não negativo protegidos pelo schema.
- Inbox, transação financeira, ledger e outbox confirmados atomicamente.
- API HTTP e consumidor SQS reutilizam o mesmo caso de uso.
- Publicação da outbox após commit; consumidores toleram publicação repetida.
- Autenticação inicialmente omitida, com porta explícita para integração futura com IdP OIDC.

## Mensageria implementada

Inbox usa chave composta consumerName/messageId; seu hash inclui a key de idempotência e o hash financeiro. Reserva e marcação da inbox acontecem dentro da mesma transação financeira. Conflitos causam rollback completo. O consumidor apaga a mensagem somente depois que submit retorna do commit. Erros permanentes vão à DLQ; transitórios usam visibilidade exponencial, limitada a 300 segundos e cinco recebimentos. Há redrive policy e transferência explícita send-before-delete para erros permanentes.

A revisão acrescentou reidratação da InboxMessage e transição markProcessed somente na primeira conclusão, preservando processedAt em replays. Trigger bloqueia alterações do estado processado e da identidade/hash. Retries de referências rechecavam apenas status; agora também revalidam nextAttemptAt sob lock e aplicam limite/TTL antes de processar referência tardia. Transição PENDING_REFERENCE → PENDING é explícita via resumeReference.

Migration 003 adiciona FK composta entre ledger e identidade financeira da transação e triggers diferíveis: ao confirmar, operações PROCESSED com efeito financeiro exigem um lançamento com direção correta; outros estados e LOSS não admitem lançamento. A consistência é avaliada no fim da transação para permitir gravação do ledger antes da transição terminal. Migration 004 bloqueia exclusão de transações. Esses checks não substituem lock e atualização atômica do saldo materializado.

Outbox usa FOR UPDATE SKIP LOCKED por registro. O lock permanece durante a publicação para excluir publishers concorrentes; a chamada externa aumenta a duração dessa transação, um trade-off de simplicidade. Uma morte após envio e antes do commit pode repetir o evento, com eventId estável; deduplicação FIFO só otimiza isso. Consumidores de eventos devem manter deduplicação persistente. Falhas de envio incrementam tentativas e backoff até uma hora, sem descartar eventos confirmados.

Referências pendentes usam backoff exponencial de 2 segundos até uma hora. Após dez tentativas ou 24 horas, a operação é rejeitada com REFERENCE_NOT_FOUND. Dez tentativas limitam o custo operacional; o TTL adicional protege registros antigos. Workers concorrentes revalidam o status sob lock de transação antes de aplicar o efeito.

Testes incluem LocalStack real, inbox/redelivery, publicação concorrente, estorno fora de ordem, DLQ e falha injetada de outbox para demonstrar rollback de saldo, ledger, inbox e transação. O teste de crash mata um processo após checkpoint de commit e antes do ack, devolve a visibilidade e usa outra instância para processar a reentrega. Ainda falta retry transitório por indisponibilidade de broker.

## Ordem de locks e teste com processos

O lock da wallet é adquirido antes da inserção da transação e de qualquer lock da transação pendente. A ordem anterior (inserção com FK, depois FOR UPDATE) gerou deadlock por upgrade de KEY SHARE em um teste com três processos; PostgreSQL abortou uma operação sem corromper saldo. Após corrigir a ordem, o teste passou. A inbox, quando presente, é bloqueada antes da wallet. Não há aquisição de locks de outras wallets no processamento de referências.

Os testes lançam três executáveis Bun independentes com uma barreira temporal comum e verificam PIDs distintos. Também abrem nova conexão após encerramento dos processos e verificam replay persistido e reconciliação. O callback opcional afterCommit do consumidor é um ponto de observação injetado pelo teste; a execução normal não configura esse callback.

No Windows/OneDrive, uma execução completa excedeu o limite antigo de 15 segundos na inicialização dos processos. Os testes de processos agora têm prazo de 60 segundos e filhos com limite de vida de 45 segundos; as asserções financeiras permanecem idênticas. Isso é tolerância ao ambiente de testes, não SLA da aplicação nem resultado de teste de carga.

## Consultas e observabilidade

Ledger usa keyset pagination ascendente por (created_at,id). Cursor base64url inclui walletId, data em precisão de microssegundos e ID; não depende de offset e não pode ser reutilizado em outra carteira. Base64 é opacidade de contrato, não assinatura criptográfica. Novas entradas podem aparecer em páginas futuras; não se promete snapshot histórico entre requisições.

Reconciliação obtém o mesmo lock por wallet que os escritores financeiros e soma créditos menos débitos em numeric exato no PostgreSQL. Divergências retornam diferença assinada, incrementam contador e geram log sem valores financeiros. Nenhuma correção automática é feita.

Readiness consulta banco e SQS; liveness permanece independente. Logs da API são JSON, com contexto de correlação via AsyncLocalStorage. O log transaction_prepared acontece dentro da transação e não é prova de commit. Métricas de status e lag vêm do banco; duplicatas, retries, DLQ, conflitos e duração HTTP são contadores por processo, reiniciados ao reiniciar. Worker expõe métricas em porta 3001; agregação exige scraping por instância. O histograma financeiro mede chamadas, incluindo replay e falhas, sem conter valores monetários.

O teste de falha da outbox usa uma URL de fila inexistente no LocalStack, sem substituir o SDK por mock. Confirma que o envio falho preserva o registro não publicado e incrementa backoff; dois processos independentes publicam depois. Isso comprova retry por erro real de transporte, mas não substitui um exercício de indisponibilidade total do PostgreSQL/SQS.

O exercício adicional scripts/test-outages.ps1 foi executado no Compose isolado. PostgreSQL foi parado: live continuou 200, ready e submissão retornaram 503; após recuperação a mesma key processou uma única vez. LocalStack foi parado: o HTTP financeiro continuou confirmando SQL e retendo outbox, enquanto ready retornou 503. Após restauração, os eventos pendentes foram publicados; saldo e ledger finais foram 50.00 com diferença 0.00. As evidências estão em outage-evidence.json.

O primeiro exercício revelou perda das filas no restart do LocalStack sem persistência. O loop do worker agora reprovisiona a topologia conhecida ao receber QueueDoesNotExist. O exercício passou após a correção. Isso não recupera mensagens já confirmadas pelo broker que o emulador perdeu; recriar topologia recupera o fluxo e a outbox SQL ainda pendente. Em AWS a topologia seria provisionada por infraestrutura e as políticas de durabilidade do serviço se aplicariam.

O rollback/reaplicação da migration 002 foi executado no banco isolado após criar uma rejeição por moeda divergente. A FK composta NOT VALID foi restaurada e removida novamente com sucesso, preservando o histórico. Os códigos HTTP 200, 409, 400, 422 e 202 foram conferidos na API em containers; o script de indisponibilidade comprovou 503 durante queda do banco.

## Falhas permanentes e shutdown

O consumidor classifica SQLSTATE 42501, 0A000, 42P01 e 42703 como permanentes (permissão, recurso não suportado ou schema incompatível). Após rollback financeiro tenta registrar a operação válida como FAILED/INFRASTRUCTURE_FAILURE, inbox processada e evento WagerTransactionFailed. Uma operação já terminal preserva seu resultado. Se não conseguir gravar a auditoria, não confirma nem transfere a mensagem nessa tentativa; ela permanece sujeita à política de redrive. Erros de serialização/deadlock/conexão continuam transitórios e nunca são convertidos em FAILED apenas por atingir tentativas; nesse caso a DLQ é o registro operacional.

Testes injetam falhas SQLSTATE reais via triggers restritos à wallet de teste. A falha permanente deixa saldo intacto e sem ledger; a temporária causa rollback, retry com visibilidade e processamento posterior único. Logs de erro usam código estável, não a mensagem do driver (que pode conter SQL e valores).

O teste Linux usa SIGTERM real durante checkpoint após commit/antes do ack. O consumidor aguarda a liberação, confirma a mensagem e encerra normalmente; saldo e ledger permanecem consistentes. Esse teste cobre drain do consumidor em processo de teste; a recuperação por encerramento forçado é coberta separadamente pelo teste de crash.

## Desenho futuro de identidade

Um adaptador de ProviderIdentityPort validaria JWT emitido por IdP externo (Keycloak/Zitadel), usando JWKS, issuer, audience e expiração. Um guard exigiria que o providerId do payload correspondesse ao claim confiável; criação de carteira e crédito inicial exigiriam scope administrativo separado. Health permaneceria aberto. O canal SQS é interno confiável conforme o enunciado, mantendo validações de provider/player/wallet no domínio. Não há tabela de senhas nem autenticação artesanal nesta entrega local.
