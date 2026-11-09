$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$candidateName = 'candidate-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
$candidate = Join-Path $projectRoot ".delivery/$candidateName"
New-Item -ItemType Directory -Path $candidate | Out-Null
$files = @('package.json','bun.lock','tsconfig.json','Dockerfile','compose.yaml','.dockerignore','.gitignore',
  'README.md','ARCHITECTURE.md','API.md','DEMO.md','REVIEW.md','REQUIREMENTS.md','VALIDATION.md')
foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $candidate }
foreach ($directory in @('src','tests','scripts')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $directory) -Destination $candidate -Recurse
}
$manifest = Get-ChildItem -LiteralPath $candidate -File -Recurse | ForEach-Object {
  [pscustomobject]@{path=[IO.Path]::GetRelativePath($candidate,$_.FullName).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $candidate 'MANIFEST.json')
Write-Output $candidate
