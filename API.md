# Contratos HTTP

Base local: `http://127.0.0.1:3000`. Sem autenticação no escopo escolhido. Valores monetários sempre usam `{ "amount": "25.00", "currency": "BRL" }`; amounts numéricos, negativos ou fora de escala são inválidos. Campos desconhecidos nos corpos de criação/submissão são rejeitados. IDs de wallet/player/transação são UUIDs; IDs externos são strings não vazias de até 256 caracteres.

## Status e decisão do cliente

| HTTP | Situação | Como tratar |
| --- | --- | --- |
| 200 | Operação processada/replay, consultas, reconciliação e health | Usar o resultado |
| 201 | Wallet criada | Guardar id |
| 202 | PENDING_REFERENCE | Consultar transação; worker fará retries |
| 400 | Contrato inválido, UUID, dinheiro, cursor ou limite inválido | Corrigir requisição |
| 404 | Recurso ausente | Conferir identificador |
| 409 | Wallet duplicada ou conflito de idempotência | Resolver conflito; não tratar como replay |
| 422 | REJECTED por regra de negócio | Ler failureCode; não repetir esperando novo efeito |
| 500 | Resultado terminal FAILED já auditado | Ler failureCode; repetir a key preserva o mesmo resultado |
| 503 | Infraestrutura temporariamente indisponível ou erro interno não classificado | Retentar com backoff e a mesma key |

Erros de contrato/recurso/infraestrutura usam `{ "code": "INVALID_UUID" }`, por exemplo. Resultados financeiros (inclusive REJECTED, PENDING_REFERENCE e FAILED) usam `{ "transactionId", "status", "balance", "failureCode"?, "idempotentReplay" }`. Códigos são estáveis; mensagens do banco não são expostas. O header X-Correlation-Id é validado ou gerado e devolvido em respostas.

## Wallet

`POST /wallets`: `{ "playerId": "<uuid>", "initialBalance": { "amount": "100.00", "currency": "BRL" } }`.

Resposta 201: `{ "id": "<uuid>", "playerId": "<uuid>", "balance": { "amount": "100.00", "currency": "BRL" }, "version": 1 }`. O mesmo player/moeda retorna 409. Saldo inicial positivo gera OPENING e ledger; zero não cria movimentação.

`GET /wallets/:walletId`: mesmo formato, refletindo saldo e versão atuais.

## Submissão financeira

`POST /wagering/transactions`, com header obrigatório `Idempotency-Key`.

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-1",
  "playerId": "<uuid>",
  "walletId": "<uuid>",
  "roundId": "round-1",
  "gameId": "game-1",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

Kinds externos: BET, WIN, LOSS, REFUND, ROLLBACK. OPENING é proibido. REFUND/ROLLBACK exigem referenceExternalTransactionId. Valores devem ser positivos, exceto LOSS que permite zero e não movimenta saldo. A mesma key/payload retorna o resultado original com idempotentReplay=true; payload diferente retorna 409.

FailureCodes principais: INSUFFICIENT_FUNDS, REVERSAL_INSUFFICIENT_FUNDS, BALANCE_LIMIT_EXCEEDED, REFERENCE_NOT_FOUND, REFERENCE_REJECTED, REFERENCE_MISMATCH, INVALID_REFERENCE_KIND, REVERSAL_AMOUNT_MISMATCH, ALREADY_REVERSED, PLAYER_MISMATCH, CURRENCY_MISMATCH, INFRASTRUCTURE_FAILURE. Nenhum deles movimenta saldo em resultado REJECTED/FAILED.

## Consultas de transação

`GET /wagering/transactions/:transactionId` e `GET /providers/:providerId/wagering/transactions/:externalTransactionId` retornam o mesmo formato camelCase: transactionId, providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind, status, money, balance, createdAt, processedAt, além de referenceExternalTransactionId/failureCode quando presentes. balance representa o saldo observado ao produzir o resultado, não uma consulta atual da wallet. Datas são ISO-8601; processedAt é null quando ainda não aplicada. Hashes e chaves internas de transporte não são expostos.

## Ledger e reconciliação

`GET /wallets/:walletId/ledger?limit=50&cursor=...`: limite 1–100, resposta `{ "items": [...], "nextCursor": "..." | null }`. Cursor deve ser usado exatamente como retornado e pertence à wallet. Cada item contém id, transactionId, direction, money, balanceBefore, balanceAfter e createdAt. Parâmetros repetidos, cursor vazio ou malformado retornam 400.

`POST /wallets/:walletId/reconciliation`: resposta 200 com walletId, storedBalance, calculatedBalance, difference, consistent e checkedEntries. Divergência não altera o saldo automaticamente.

## Saúde e métricas

`GET /health/live`: 200 enquanto processo está vivo. `GET /health/ready`: 200 com PostgreSQL e SQS acessíveis; 503 em falha de dependência. `GET /metrics`: texto Prometheus. Nenhum desses endpoints exige autenticação.
