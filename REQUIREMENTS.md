# Acompanhamento do enunciado

Fonte: https://github.com/junglegaming/backend-challenge (README consultado em 08/11/2026).

Este documento registra a cobertura e os limites da solução. A validação final em cópia limpa está em VALIDATION.md; a apresentação e o envio são responsabilidade do candidato.

| Área | Implementado e testado | Pendências |
| --- | --- | --- |
| Stack | Bun, TypeScript strict, NestJS, PostgreSQL, MikroORM, SQS LocalStack; Compose completo validado com banco vazio | Cópia limpa aprovada |
| Dinheiro | Decimal exato, escala fixa, imutabilidade, moedas incompatíveis, limites | Nenhuma conhecida no escopo atual |
| Wallet/ledger | FK financeira composta e triggers diferíveis verificam vínculo, quantidade e direção do ledger; reconciliação | Cópia limpa aprovada |
| Operações | Reversões, moeda/rodada/valor, LOSS sem versão e overflow de saldo auditável | Cópia limpa aprovada |
| Idempotência | Unicidade SQL, hash canônico, conflito, 50 repetições, saldo original | Nenhuma conhecida no cenário coberto |
| Referências | Fora de ordem, backoff, limite/TTL, concorrência, expiração e ROLLBACK fora de ordem testados | Nenhuma conhecida no cenário coberto |
| Inbox | Transições reidratadas; replay preserva processedAt; schema protege estado processado | Nenhuma conhecida no cenário coberto |
| Outbox | Envelope copiado, eventos de abertura, correlação/causação, SKIP LOCKED e recuperação após falha SQL de marcação | Cópia limpa aprovada |
| SQS | Ack após commit, DLQ, retry, FAILED, SIGTERM Linux e indisponibilidade total PostgreSQL/SQS testados | Cópia limpa aprovada |
| API | Contratos camelCase documentados em API.md; matriz HTTP real cobre entradas, erros, replay, consultas, paginação, reconciliação e FAILED | Cópia limpa aprovada |
| Concorrência | Três processos, wallets distintas, queda antes do ack e dois publishers em processos separados | Cópia limpa aprovada |
| Reinício | Script test-outages.ps1 reproduz quedas e recuperação com evidência de reconciliação | Exercício separado aprovado |
| Observabilidade | JSON, correlação, métricas API/worker, histograma financeiro, readiness | Scrape por instância; dashboard externo opcional |
| Autenticação | Omitida conforme README; ProviderIdentityPort e desenho OIDC documentados | Nenhuma no escopo escolhido |
| Documentação | README, ARCHITECTURE, API, REVIEW, VALIDATION e DEMO | Revisão e preparação do candidato |

## Falha corrigida com evidência

O primeiro teste de três processos revelou deadlock por upgrade de locks de FK: a inserção da transação acontecia antes do FOR UPDATE da wallet. A ordem agora é wallet antes de inserir ou bloquear a transação, inclusive em retries. O cenário passou após a correção. O banco reverteu a operação afetada, sem saldo negativo ou débito duplicado.
