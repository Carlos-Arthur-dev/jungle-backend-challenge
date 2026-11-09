# Validação de entrega em cópia limpa

Executada em 08/11/2026, usando Docker Desktop com containers Linux e Bun 1.4.4 na imagem.

## Isolamento

- Cópia feita por lista explícita de fontes, testes, scripts, lockfile e documentação.
- Sem `.git`, `.env`, `.tools` ou `node_modules` do computador de desenvolvimento.
- Projeto Compose separado: `jungle-delivery-check`, com volume PostgreSQL novo.
- Portas externas alternativas: API 3200, métricas do worker 3201, PostgreSQL 55433 e LocalStack 14567.
- Build sem cache, instalação via `bun install --frozen-lockfile`.

## Resultados

- API, worker, PostgreSQL, LocalStack e serviço de migrations iniciados a partir da cópia.
- As quatro migrations foram aplicadas, revertidas em ordem inversa e reaplicadas em um banco adicional vazio, com sucesso.
- TypeScript estrito: aprovado dentro do container de validação.
- **63 testes aprovados, zero falhas e zero ignorados**, em 13 arquivos; 307 asserções, 21,15 segundos de execução do test runner (sem contar build/startup).
- A suíte Linux incluiu SIGTERM real, três processos concorrentes, dois publishers separados, morte após commit/antes do ack, HTTP real, reversões, inbox/outbox e falhas SQL.
- Verificação externa: live/ready OK e métricas do worker HTTP 200.
- Carteira externa de 100.00 BRL e aposta de 25.00 BRL: saldo 75.00 e reconciliação consistente.

## Reproduzir

No projeto padrão, com Docker aberto:

```powershell
docker compose up -d --build --wait
docker compose stop worker
docker compose --profile test run --rm --build tests
docker compose start worker
```

Para reproduzir build sem cache, use `docker compose --profile test build --no-cache` antes do startup. A suíte cria dados sintéticos no banco configurado; use ambiente de desenvolvimento.

O teste de indisponibilidade total foi executado separadamente pelo script `scripts/test-outages.ps1`: recuperação PostgreSQL e SQS aprovada, reconciliação final com diferença 0.00. Não é benchmark de carga nem auditoria de produção.

## Integridade dos arquivos

O pacote contém `MANIFEST.json` com SHA-256 de cada arquivo (exceto do próprio manifesto). Compare os hashes para verificar integridade. O ZIP não inclui histórico Git nem dependências instaladas. A instalação requer acesso à internet para baixar as imagens e pacotes na primeira construção.
