# Boot the OneOps server against the account-lifecycle test DB copy with
# mock SMTP, run the live suite, then kill the server. Idempotent + safe:
# only touches oneops_acct_live (a scratch copy) and port 3001.
Set-Location 'g:\Project\Pribadi\Automation'
$env:DB_NAME = 'oneops_acct_live'
$env:SESSION_SECRET = 'acct-test-secret'
$env:EMAIL_TRANSPORT = 'mock'
$env:APP_BASE_URL = 'http://localhost:5173'

# Kill any stale listener from previous runs (known Start-Job leak).
$stale = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
if ($stale) { Stop-Process -Id $stale.OwningProcess -Force -Confirm:$false -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }

$proc = Start-Process node -ArgumentList 'server/index.js' -PassThru -NoNewWindow -RedirectStandardOutput "$env:TEMP\oneops-acct-test.log" -RedirectStandardError "$env:TEMP\oneops-acct-test.err.log"
try {
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $null = Invoke-RestMethod 'http://localhost:3001/api/health' -TimeoutSec 2
      $ready = $true
      break
    } catch {}
  }
  if (-not $ready) { Write-Host "SERVER FAILED TO START"; Get-Content "$env:TEMP\oneops-acct-test.err.log" -ErrorAction SilentlyContinue | Select-Object -Last 10; exit 1 }

  & .\tests\live-accounts.test.ps1
  exit $LASTEXITCODE
} finally {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -Confirm:$false -ErrorAction SilentlyContinue }
}
