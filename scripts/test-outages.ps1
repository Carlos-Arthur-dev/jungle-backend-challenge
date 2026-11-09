$ErrorActionPreference = 'Stop'
# Fixed isolated project and ports: never stops the normal jungle-wagering project.
$env:API_PORT = '3100'
$env:WORKER_METRICS_PORT = '3101'
$env:POSTGRES_PORT = '55432'
$env:LOCALSTACK_PORT = '14566'
$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$dockerExecutable = if ($dockerCommand) { $dockerCommand.Source } else { "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin\docker.exe" }
function Compose {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & $dockerExecutable compose -p jungle-clean-check @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Compose failed: $Arguments" }
}
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Http([string]$Path, [string]$Method = 'GET', [object]$Body = $null, [string]$Key = '') {
  $parameters = @{ Uri = "http://127.0.0.1:3100$Path"; Method = $Method; SkipHttpErrorCheck = $true; TimeoutSec = 40 }
  if ($null -ne $Body) { $parameters.ContentType = 'application/json'; $parameters.Body = $Body | ConvertTo-Json -Depth 8 }
  if ($Key) { $parameters.Headers = @{ 'Idempotency-Key' = $Key } }
  return Invoke-WebRequest @parameters
}
function AwaitReady {
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { if ((Http '/health/ready').StatusCode -eq 200) { return } } catch {}
    Start-Sleep -Seconds 1
  }
  throw 'Readiness did not recover'
}
function Pending([string]$WalletId) {
  $result = & $dockerExecutable compose -p jungle-clean-check exec -T postgres psql -U jungle -d jungle -Atc "select count(*) from outbox where aggregate_id='$WalletId' and published_at is null"
  if ($LASTEXITCODE -ne 0) { throw 'Outbox query failed' }
  return [int]$result
}
$report = [ordered]@{ checkedAt = [DateTime]::UtcNow.ToString('o'); project = 'jungle-clean-check' }
try {
  Compose @('up', '-d', '--build', '--wait')
  $playerId = [guid]::NewGuid().ToString()
  $wallet = (Http '/wallets' 'POST' @{ playerId = $playerId; initialBalance = @{ amount = '100.00'; currency = 'BRL' } }).Content | ConvertFrom-Json
  $key = [guid]::NewGuid().ToString()
  $request = @{ providerId = 'outage-test'; externalTransactionId = $key; playerId = $playerId; walletId = $wallet.id; roundId = 'r'; gameId = 'g'; kind = 'BET'; money = @{ amount = '25.00'; currency = 'BRL' } }

  Compose @('stop', 'postgres')
  Assert ((Http '/health/live').StatusCode -eq 200) 'Liveness failed during PostgreSQL outage'
  Assert ((Http '/health/ready').StatusCode -eq 503) 'Readiness must fail during PostgreSQL outage'
  Assert ((Http '/wagering/transactions' 'POST' $request $key).StatusCode -eq 503) 'Request must fail transiently while database is unavailable'
  Compose @('start', 'postgres')
  AwaitReady
  $processed = (Http '/wagering/transactions' 'POST' $request $key).Content | ConvertFrom-Json
  Assert ($processed.status -eq 'PROCESSED' -and $processed.balance.amount -eq '75.00') 'Database recovery did not process exactly once'
  $conflict = $request.Clone()
  $conflict.money = @{ amount = '1.00'; currency = 'BRL' }
  Assert ((Http '/wagering/transactions' 'POST' $conflict $key).StatusCode -eq 409) 'Divergent replay must return conflict'
  Assert ((Http '/wagering/transactions' 'POST' $request).StatusCode -eq 400) 'Missing idempotency key must be invalid'
  $rejected = $request.Clone()
  $rejected.externalTransactionId = [guid]::NewGuid().ToString()
  $rejected.money = @{ amount = '1000.00'; currency = 'BRL' }
  Assert ((Http '/wagering/transactions' 'POST' $rejected $rejected.externalTransactionId).StatusCode -eq 422) 'Insufficient funds must be a business rejection'
  $pending = $request.Clone()
  $pending.externalTransactionId = [guid]::NewGuid().ToString()
  $pending.kind = 'REFUND'
  $pending.referenceExternalTransactionId = [guid]::NewGuid().ToString()
  Assert ((Http '/wagering/transactions' 'POST' $pending $pending.externalTransactionId).StatusCode -eq 202) 'Missing reference must be pending'
  $report.httpContracts = 'passed'
  $report.postgresRecovery = 'passed'

  Compose @('stop', 'localstack')
  Assert ((Http '/health/live').StatusCode -eq 200) 'Liveness failed during SQS outage'
  Assert ((Http '/health/ready').StatusCode -eq 503) 'Readiness must fail during SQS outage'
  $sqsKey = [guid]::NewGuid().ToString()
  $request.externalTransactionId = $sqsKey
  $processed = (Http '/wagering/transactions' 'POST' $request $sqsKey).Content | ConvertFrom-Json
  Assert ($processed.status -eq 'PROCESSED' -and $processed.balance.amount -eq '50.00') 'SQL processing must continue with transactional outbox while SQS is unavailable'
  Assert ((Pending $wallet.id) -gt 0) 'Outbox did not retain events during SQS outage'
  Compose @('start', 'localstack')
  AwaitReady
  for ($attempt = 0; $attempt -lt 30 -and (Pending $wallet.id) -gt 0; $attempt++) { Start-Sleep -Seconds 1 }
  Assert ((Pending $wallet.id) -eq 0) 'Outbox did not publish after SQS recovery'
  $report.sqsRecovery = 'passed'
  $replay = (Http '/wagering/transactions' 'POST' $request $sqsKey).Content | ConvertFrom-Json
  Assert ($replay.idempotentReplay -eq $true -and $replay.balance.amount -eq '50.00') 'Replay changed the result'
  $reconciliation = (Http "/wallets/$($wallet.id)/reconciliation" 'POST').Content | ConvertFrom-Json
  Assert ($reconciliation.consistent -eq $true -and $reconciliation.storedBalance.amount -eq '50.00') 'Final reconciliation failed'
  $report.reconciliation = $reconciliation
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath 'outage-evidence.json'
  Write-Output 'OUTAGE_TESTS_PASSED'
} finally {
  # Restore availability even when an assertion fails; preserve the isolated data for diagnosis.
  Compose @('start', 'postgres', 'localstack')
}
