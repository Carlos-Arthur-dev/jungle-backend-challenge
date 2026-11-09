# Revisão final do código — etapa 1

Escopo: regras de domínio, persistência, concorrência, inbox/outbox e eventos, confrontados com o README oficial do desafio. Contratos HTTP completos e instalação a partir do pacote final são etapas separadas.

## Achados corrigidos

1. **Ledger não estava vinculado à identidade financeira completa da transação.** Migration 003 adiciona FK composta por transactionId, walletId, amount e currency. Triggers diferíveis verificam o estado final no commit: operação financeira processada exige exatamente um lançamento com direção correta; LOSS e estados sem aplicação não admitem lançamento. A verificação diferida permite gravar ledger antes de marcar PROCESSED na mesma transação.
2. **Replay da inbox alterava processedAt.** O fluxo agora reidrata InboxMessage, só executa a transição quando necessário e preserva o timestamp original. Trigger impede modificar inbox já processada ou sua identidade/hash.
3. **Workers de referência não rechecavam o backoff sob lock.** Agora revalidam prazo e estado após bloquear a transação. O limite de tentativas/TTL é aplicado antes de aceitar referência que chegou tarde. O domínio tem transição resumeReference explícita e usa rehydrate no retry.
4. **Eventos mantinham referências mutáveis dos dados.** A construção e a serialização agora copiam o payload. Correlação/causação são construídas no envelope da classe, sem alteração posterior de seu JSON. OPENING persiste resultado original e publica seus eventos com valores monetários serializados.
5. **Exclusão de transação sem ledger não era bloqueada no schema.** Migration 004 impede exclusão de qualquer transação auditável. O trigger anterior já impedia alterações de estados terminais.
6. **Erro SQL após envio da outbox era tratado como falha de envio.** O publicador agora trata envio e marcação SQL separadamente. Uma falha na marcação reverte a transação e preserva o evento para nova publicação com mesmo eventId.
7. **API tinha dois mecanismos de shutdown concorrentes.** O encerramento agora usa um único caminho, com proteção contra execução dupla e fechamento de app, ORM e cliente SQS.

## Evidências

- Testes de regressão em `tests/integration/review.test.ts` e `tests/unit/messages.test.ts`.
- Migration 003/004 aplicadas com sucesso no banco local.
- Suíte completa após as correções principais: 55 aprovados, um caso SIGTERM exclusivo de Linux ignorado no Windows.
- SIGTERM já foi executado separadamente em Docker/Linux. Após o último ajuste do publisher, os seis testes de review.test.ts passaram, incluindo falha SQL após envio confirmado; o TypeScript foi checado novamente.
- Checagem estrita do TypeScript aprovada.

## Limites da conclusão

As constraints reforçam consistência entre transação e lançamento; não implementam reconstrução integral do saldo a cada commit. Essa reconstrução permanece no endpoint de reconciliação, evitando varrer todo o histórico em cada aposta. A aplicação atualiza saldo e ledger sob lock da wallet na mesma transação. Acesso administrativo direto pode criar divergência no saldo materializado, que a reconciliação detecta.

Não há garantia de exactly-once no transporte. O efeito financeiro é idempotente no PostgreSQL; eventos podem ser repetidos e consumidores externos precisam deduplicar eventId persistentemente. A revisão não substitui teste de carga ou auditoria independente.

## Etapa 2 — contratos HTTP

- Validadores de borda rejeitam corpos não objeto, campos extras, dinheiro numérico/escala inválida, IDs inválidos, referências obrigatórias ausentes e OPENING externo. Parâmetros repetidos de paginação, cursor vazio e datas/UUIDs inválidos no cursor são rejeitados como 400 antes da consulta.
- GETs de transação serializam camelCase, sem nomes de colunas SQL, hash ou idempotency key. Consultas interna e externa retornam o mesmo contrato.
- Reconciliação retorna 200 explicitamente. FAILED terminal retorna 500 com resultado auditado, distinto de 503 transitório. Rejeições de negócio usam 422; ausência de referência usa 202; conflitos usam 409.
- Overflow de crédito agora é rejeição persistida BALANCE_LIMIT_EXCEEDED, sem ledger ou alteração de saldo, em vez de erro de infraestrutura.
- A API foi extraída para createApp para testes de integração HTTP reais em porta temporária. O entrypoint continua responsável por listen e encerramento.
- Oito testes HTTP/consulta passaram na execução conjunta, cobrindo 89 asserções. A documentação externa está em API.md.
