# Regression check for the "/api" mount bug: public lifecycle routes must
# not require a session, and module gates must not leak across routers.
# Runs against the scratch DB oneops_acct_live with mock SMTP only.
Set-Location 'g:\Project\Pribadi\Automation'
$env:DB_NAME = 'oneops_acct_live'
$env:SESSION_SECRET = 'acct-test-secret-0123456789'
$env:EMAIL_TRANSPORT = 'mock'
$env:APP_BASE_URL = 'http://localhost:5173'
$mysql = 'C:\xampp\mysql\bin\mysql.exe'
$base = 'http://localhost:3001'
$pass = 0; $fail = 0
function Test($name, $cond, $detail) {
  if ($cond) { $script:pass++; Write-Host "  ok  $name" }
  else { $script:fail++; Write-Host "FAIL  $name  ($detail)" }
}
function Call($method, $uri, $body, $session) {
  try {
    $p = @{ Uri = "$base$uri"; Method = $method; TimeoutSec = 10; ContentType = 'application/json' }
    if ($body) { $p.Body = ($body | ConvertTo-Json -Depth 5) }
    if ($session) { $p.WebSession = $session }
    $r = Invoke-WebRequest @p -UseBasicParsing
    return @{ code = [int]$r.StatusCode; body = $r.Content }
  } catch {
    $code = 0; $text = ''
    try { $code = [int]$_.Exception.Response.StatusCode } catch {}
    try { $text = $_.ErrorDetails.Message } catch {}
    return @{ code = $code; body = $text }
  }
}

# Grant hr ONLY account_management.view (no number_rechecking.run) in the scratch DB.
& $mysql -h 127.0.0.1 -P 3306 -u root --skip-password oneops_acct_live -e "INSERT IGNORE INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r, permissions p WHERE r.name='hr' AND p.permission_key='account_management.view';"

$stale = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue
if ($stale) { Stop-Process -Id $stale.OwningProcess -Force -Confirm:$false -ErrorAction SilentlyContinue; Start-Sleep -Seconds 1 }
$proc = Start-Process node -ArgumentList 'server/index.js' -PassThru -NoNewWindow -RedirectStandardOutput "$env:TEMP\oneops-routes.log" -RedirectStandardError "$env:TEMP\oneops-routes.err.log"
try {
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; try { $null = Invoke-RestMethod "$base/api/health" -TimeoutSec 2; $ready = $true; break } catch {} }
  if (-not $ready) { Write-Host "SERVER FAILED TO START"; Get-Content "$env:TEMP\oneops-routes.err.log" | Select-Object -Last 10; exit 1 }

  Write-Host "`n== public lifecycle routes (anonymous) =="
  $r = Call 'POST' '/api/auth/reset-password' @{ token = 'x' * 43; password = 'GoodPass1!x'; confirmPassword = 'GoodPass1!x' } $null
  Test "reset-password is NOT 401" ($r.code -ne 401) "got $($r.code) $($r.body)"
  Test "reset-password rejects bad token with 400" ($r.code -eq 400) "got $($r.code) $($r.body)"

  $r = Call 'POST' '/api/auth/forgot-password' @{ email = 'nobody@example.com' } $null
  Test "forgot-password reachable anonymously (200)" ($r.code -eq 200) "got $($r.code) $($r.body)"

  $r = Call 'POST' '/api/auth/activate-account' @{ token = 'y' * 43; password = 'GoodPass1!x'; confirmPassword = 'GoodPass1!x' } $null
  Test "activate-account reachable anonymously (400 bad token)" ($r.code -eq 400) "got $($r.code) $($r.body)"

  Write-Host "`n== recheck route still protected =="
  $r = Call 'POST' '/api/awb-detail' @{ awb_number = '123' } $null
  Test "awb-detail anonymous -> 401" ($r.code -eq 401) "got $($r.code)"

  Write-Host "`n== gate no longer leaks across routers =="
  $null = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -ContentType 'application/json' -Body '{"username":"hr","password":"admin123"}' -SessionVariable hr
  $r = Call 'GET' '/api/accounts?page=1' $null $hr
  Test "hr with only account_management.view reaches /api/accounts (200)" ($r.code -eq 200) "got $($r.code) $($r.body)"
  $r = Call 'POST' '/api/awb-detail' @{ awb_number = '123' } $hr
  Test "hr without number_rechecking.run -> awb-detail 403" ($r.code -eq 403) "got $($r.code)"

  Write-Host "`n== unknown /api path still 404 =="
  $r = Call 'GET' '/api/does-not-exist' $null $null
  Test "unknown api path -> 404" ($r.code -eq 404) "got $($r.code)"

  Write-Host "`n$pass passed, $fail failed"
  if ($fail -gt 0) { exit 1 }
} finally {
  if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -Confirm:$false -ErrorAction SilentlyContinue }
}
