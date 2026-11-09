# Roteiro de demonstração

## Preparação

Execute `docker compose up -d --build --wait`. Confirme `/health/live` e `/health/ready` em http://127.0.0.1:3000. Logs: `docker compose logs -f api worker`.

## Explique o fluxo

1. Crie uma wallet com 100.00 BRL via POST /wallets. Mostre versão 1 e o lançamento OPENING no ledger.
2. Envie BET de 25.00 com Idempotency-Key. Mostre saldo 75.00, versão 2 e lançamento DEBIT.
3. Repita exatamente o mesmo request/key. Mostre idempotentReplay=true e ausência de novo lançamento.
4. Altere o valor mantendo a key. Mostre 409 de conflito, sem alteração financeira.
5. Envie REFUND referenciando externalTransactionId da BET. Mostre crédito de 25.00 e saldo 100.00.
6. Envie outro REFUND com identidade diferente para a mesma BET. Mostre rejeição ALREADY_REVERSED.
7. Execute POST /wallets/:id/reconciliation. Explique como o saldo é reconstruído pelo ledger.

## Demonstre concorrência e recuperação

Pare o worker do Compose antes de testes que usam filas compartilhadas. Execute `bun run test:integration` para concorrência com três processos, 50 repetições, reversões, inbox/outbox e queda após commit/antes do ack. O teste SIGTERM requer Linux; veja README.

O script PowerShell 7 `scripts/test-outages.ps1` usa o projeto isolado jungle-clean-check com portas alternativas e registra evidências, sem parar o projeto padrão. Ele usa dados sintéticos e mantém os volumes ao final.

## Decisões para explicar na entrevista

- Dinheiro usa decimal exato; contratos e PostgreSQL preservam strings com duas casas.
- Lock por wallet serializa apenas a carteira disputada. O banco garante unicidade e não-negatividade.
- Idempotência não depende de memória, FIFO ou número de instâncias.
- Inbox, saldo, ledger, resultado e outbox são confirmados juntos. Ack ocorre depois do commit.
- Outbox publica após commit. Um crash após envio pode repetir evento; consumidores precisam deduplicar eventId persistentemente.
- Reconciliação detecta, sinaliza e não corrige divergência automaticamente.
- Autenticação foi omitida conforme opção do enunciado para priorizar correção financeira. ProviderIdentityPort permite integração futura com IdP.

## Limites que devem ser apresentados

Consulte REQUIREMENTS.md e ARCHITECTURE.md para o estado atualizado. Não afirme exactly-once de transporte: a garantia é de efeito financeiro idempotente no PostgreSQL. Métricas são por processo e precisam de scrape em cada instância. Não há benchmark de carga nem meta de RPS comprovada.
