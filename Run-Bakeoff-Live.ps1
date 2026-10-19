# Non-interactive: dry run, then the LIVE bake-off (up to 100 PDL credits).
# Extra arguments are passed through, e.g. --no-school --confirmed=0 --tier1=50
# Output is also saved to exports\bakeoff-last-run.log
$passArgs = $args  # captured here: inside the & { } block below, $args is empty
Set-Location -Path $PSScriptRoot
$env:DATABASE_PATH = ".\data\hcrhub-dev.sqlite"
New-Item -ItemType Directory -Force -Path exports | Out-Null
& {
  Write-Output "=== Dry run ==="
  node scripts/run-provider-bakeoff.mjs --provider=pdl @passArgs
  if ($LASTEXITCODE -ne 0) { Write-Output "Dry run failed; live run skipped."; return }
  Write-Output "`n=== Live run ==="
  node scripts/run-provider-bakeoff.mjs --provider=pdl --live --max-credits=100 @passArgs
  Write-Output "`n=== FINISHED $(Get-Date -Format s) ==="
} *>&1 | Tee-Object -FilePath exports\bakeoff-last-run.log
Read-Host "`nDone. Press Enter to close"
