# Runs the People Data Labs bake-off against the DEV database copy.
# Usage: right-click this file > Run with PowerShell
#    or: in PowerShell, from anywhere:  & "C:\Users\merug\OneDrive\Desktop\work\HCRHUB-Candidate-Intelligence\Run-Bakeoff.ps1"
Set-Location -Path $PSScriptRoot
$env:DATABASE_PATH = ".\data\hcrhub-dev.sqlite"

Write-Host "`n=== Step 1: dry run (nothing is sent, nothing is spent) ===`n" -ForegroundColor Cyan
node scripts/run-provider-bakeoff.mjs --provider=pdl
if ($LASTEXITCODE -ne 0) { Write-Host "Dry run failed; stopping." -ForegroundColor Red; Read-Host "Press Enter to close"; exit 1 }

$answer = Read-Host "`nRun the LIVE lookups now? Uses up to 100 PDL credits (type yes to continue)"
if ($answer -ne "yes") { Write-Host "Cancelled. Nothing was spent."; Read-Host "Press Enter to close"; exit 0 }

Write-Host "`n=== Step 2: live run ===`n" -ForegroundColor Cyan
node scripts/run-provider-bakeoff.mjs --provider=pdl --live --max-credits=100
Read-Host "`nDone. Press Enter to close"
