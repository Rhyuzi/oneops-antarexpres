# Live integration test: Account Management & lifecycle (mock SMTP)
# Runs against a COPY database (oneops_acct_live) — never production.
# Server must run with EMAIL_TRANSPORT=mock DB_NAME=oneops_acct_live.

$ErrorActionPreference = 'Stop'
$base = 'http://localhost:3001'
$pass = 0; $fail = 0

function Test($name, $cond) {
  if ($cond) { $script:pass++; Write-Host "  ok  $name" -ForegroundColor Green }
  else { $script:fail++; Write-Host "FAIL  $name" -ForegroundColor Red }
}

function Login($username) {
  $resp = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -ContentType 'application/json' `
    -Body (@{ username = $username; password = 'admin123' } | ConvertTo-Json) -SessionVariable s
  $resp | Add-Member -NotePropertyName session -NotePropertyValue $s
  return $resp
}

function Post($uri, $body, $session) {
  try {
    return @{ ok = $true; data = (Invoke-RestMethod -Uri "$base$uri" -Method Post -ContentType 'application/json' -WebSession $session -Body ($body | ConvertTo-Json -Depth 5) -TimeoutSec 10) }
  } catch {
    $code = 0
    try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
    return @{ ok = $false; code = $code }
  }
}

$super = Login 'superadmin'
Test "superadmin login" ($super.user.roles -contains 'super_admin')

# hr has NO account_management permissions
$hr = Login 'hr'
Test "hr login (no account perms)" ($hr.ok)

Write-Host "`n== account list authorization =="
try {
  $list = Invoke-RestMethod -Uri "$base/api/accounts?page=1" -WebSession $super.session -TimeoutSec 10
  Test "superadmin lists accounts" ($list.ok -and $list.accounts.Count -ge 6)
} catch { Test "superadmin lists accounts" $false }

try {
  Invoke-RestMethod -Uri "$base/api/accounts?page=1" -WebSession $hr.session -TimeoutSec 10 | Out-Null
  Test "hr denied account list (403)" $false
} catch {
  Test "hr denied account list (403)" ($_.Exception.Response.StatusCode.value__ -eq 403)
}

Write-Host "`n== create account (superadmin) =="
$unique = Get-Random -Maximum 99999
$r = Post '/api/accounts' @{
  full_name = 'Test Invitee'
  email     = "invitee$unique@example.com"
  username  = "invitee$unique"
  roles     = @('finance')
} $super.session
Test "account created" ($r.ok -eq $true -and $r.data.account.id -gt 0)
Test "created status = pending_activation" ($r.data.account.status -eq 'pending_activation')
Test "invitation reported sent (mock)" ($r.data.invitationSent -eq $true)
$inviteeId = $r.data.account.id

Write-Host "`n== duplicate prevention =="
$r2 = Post '/api/accounts' @{
  full_name = 'Dup'
  email     = "invitee$unique@example.com"
  username  = "othername$unique"
  roles     = @('finance')
} $super.session
Test "duplicate email rejected (409)" ($r2.ok -eq $false -and $r2.code -eq 409)

$r3 = Post '/api/accounts' @{
  full_name = 'Dup'
  email     = "other$unique@example.com"
  username  = "invitee$unique"
  roles     = @('finance')
} $super.session
Test "duplicate username rejected (409)" ($r3.ok -eq $false -and $r3.code -eq 409)

Write-Host "`n== unauthorized creation & role escalation =="
$r4 = Post '/api/accounts' @{
  full_name = 'Sneaky'; email = "sneaky$unique@example.com"; username = "sneaky$unique"; roles = @('hr')
} $hr.session
Test "hr denied account creation (403)" ($r4.ok -eq $false -and $r4.code -eq 403)

# superadmin tries creating an account with super_admin role for later checks — should be ALLOWED for superadmin
$rSuperAcct = Post '/api/accounts' @{
  full_name = 'Second Super'
  email     = "secondsuper$unique@example.com"
  username  = "secondsuper$unique"
  roles     = @('super_admin')
} $super.session
Test "superadmin CAN create super_admin account" ($rSuperAcct.ok -eq $true)

Write-Host "`n== pending account cannot log in =="
try {
  Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -ContentType 'application/json' `
    -Body (@{ username = "invitee$unique"; password = 'Whatever1!x' } | ConvertTo-Json) -TimeoutSec 10 | Out-Null
  Test "pending login denied (403)" $false
} catch {
  Test "pending login denied (403)" ($_.Exception.Response.StatusCode.value__ -eq 403)
}

Write-Host "`n== invitation token flow (via DB — raw token never exposed by API) =="
# Get the raw token from the mock outbox? No — outbox is in-process. Extract from DB is impossible (hashed).
# Instead: we cannot recover the raw token externally by design. So test activation via a token we issue
# through the resend endpoint... same problem. => Verify via the reset flow using a known token:
# Use the test hook: create token directly in DB with known raw value.
$raw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 43 | ForEach-Object { [char]$_ })
# base64url-ish token
$tokenKnown = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("known-$raw-12345678901234567890")).TrimEnd('=').Replace('+','-').Replace('/','_')
$hash = -join (1..1 | ForEach-Object { }) # placeholder
# Compute SHA256 of token
$sha = [System.Security.Cryptography.SHA256]::Create()
$hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($tokenKnown))
$hashHex = -join ($hashBytes | ForEach-Object { $_.ToString('x2') })

& C:\xampp\mysql\bin\mysql.exe -h 127.0.0.1 -P 3306 -u root --skip-password oneops_acct_live -e `
  "INSERT INTO user_auth_tokens (user_id, token_hash, token_type, expires_at) VALUES ($inviteeId, '$hashHex', 'invitation', DATE_ADD(NOW(), INTERVAL 1 HOUR));"

# Activation with a weak password → 400
$rWeak = Post '/api/auth/activate-account' @{ token = $tokenKnown; password = 'weak'; confirmPassword = 'weak' } $null
Test "weak password rejected (400)" ($rWeak.ok -eq $false -and $rWeak.code -eq 400)

# Proper activation
$rAct = Post '/api/auth/activate-account' @{ token = $tokenKnown; password = 'Activat3!Pass'; confirmPassword = 'Activat3!Pass' } $null
Test "account activated" ($rAct.ok -eq $true)

# Token reuse → rejected
$rReuse = Post '/api/auth/activate-account' @{ token = $tokenKnown; password = 'Activat3!Pass'; confirmPassword = 'Activat3!Pass' } $null
Test "activation token single-use (reuse rejected)" ($rReuse.ok -eq $false)

# Activated user can log in
try {
  $inv = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -ContentType 'application/json' `
    -Body (@{ username = "invitee$unique"; password = 'Activat3!Pass' } | ConvertTo-Json) -SessionVariable invS -TimeoutSec 10
  Test "activated user can log in" ($inv.ok -eq $true)
} catch { Test "activated user can log in" $false }

Write-Host "`n== password reset flow =="
# Insert known reset token
$rawReset = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("reset-$raw-09876543210987654321")).TrimEnd('=').Replace('+','-').Replace('/','_')
$hashResetBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($rawReset))
$hashResetHex = -join ($hashResetBytes | ForEach-Object { $_.ToString('x2') })
& C:\xampp\mysql\bin\mysql.exe -h 127.0.0.1 -P 3306 -u root --skip-password oneops_acct_live -e `
  "INSERT INTO user_auth_tokens (user_id, token_hash, token_type, expires_at) VALUES ($inviteeId, '$hashResetHex', 'password_reset', DATE_ADD(NOW(), INTERVAL 30 MINUTE));"

# Old session invalidation check: log in first to get a session, then reset, then old session should die
try {
  $inv2 = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -ContentType 'application/json' `
    -Body (@{ username = "invitee$unique"; password = 'Activat3!Pass' } | ConvertTo-Json) -SessionVariable invS2 -TimeoutSec 10
} catch {}

$rReset = Post '/api/auth/reset-password' @{ token = $rawReset; password = 'BrandNew2!Pass'; confirmPassword = 'BrandNew2!Pass' } $null
Test "password reset succeeds" ($rReset.ok -eq $true)

# Old session now invalid (token_valid_after set)
try {
  $me = Invoke-RestMethod -Uri "$base/api/auth/me" -WebSession $invS2 -TimeoutSec 10
  Test "old session revoked after reset" ($null -eq $me.user)
} catch { Test "old session revoked after reset" $false }

# Old password no longer works; new one does
try {
  Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -ContentType 'application/json' `
    -Body (@{ username = "invitee$unique"; password = 'Activat3!Pass' } | ConvertTo-Json) -TimeoutSec 10 | Out-Null
  Test "old password rejected" $false
} catch { Test "old password rejected" $true }

try {
  $inv3 = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -ContentType 'application/json' `
    -Body (@{ username = "invitee$unique"; password = 'BrandNew2!Pass' } | ConvertTo-Json) -TimeoutSec 10
  Test "new password works" ($inv3.ok -eq $true)
} catch { Test "new password works" $false }

Write-Host "`n== forgot password (rate limit + generic response) =="
$rF1 = Post '/api/auth/forgot-password' @{ email = "invitee$unique@example.com" } $null
Test "forgot-password generic ok" ($rF1.ok -eq $true)
$rF2 = Post '/api/auth/forgot-password' @{ email = "doesnotexist@example.com" } $null
Test "unknown email → same generic response" ($rF2.ok -eq $true -and $rF2.data.message -eq $rF1.data.message)
# Rate limit: 5 per 15 min per IP — hammer 6 times
$limited = $false
for ($i = 0; $i -lt 6; $i++) {
  $rx = Post '/api/auth/forgot-password' @{ email = "a$i@example.com" } $null
  if ($rx.ok -eq $false -and $rx.code -eq 429) { $limited = $true }
}
Test "rate limiting kicks in (429)" $limited

Write-Host "`n== SMTP admin endpoints =="
try {
  $smtpStatus = Invoke-RestMethod -Uri "$base/api/admin/email/status" -WebSession $super.session -TimeoutSec 10
  Test "smtp status endpoint" ($smtpStatus.ok -eq $true)
  Test "smtp status has no credential fields" ($null -eq ($smtpStatus.status.PSObject.Properties | Where-Object { $_.Name -match 'password|secret' }))
} catch { Test "smtp status endpoint" $false }

$rVerify = Post '/api/admin/email/verify' @{} $super.session
Test "smtp verify works (mock)" ($rVerify.ok -eq $true)

$rTestMail = Post '/api/admin/email/test' @{ to = 'recipient@example.com' } $super.session
Test "test email sends via mock" ($rTestMail.ok -eq $true)

$rBadMail = Post '/api/admin/email/test' @{ to = 'not-an-email' } $super.session
Test "test email validates recipient (400)" ($rBadMail.ok -eq $false -and $rBadMail.code -eq 400)

# hr cannot touch smtp admin
$rHrSmtp = Post '/api/admin/email/verify' @{} $hr.session
Test "hr denied smtp admin (403)" ($rHrSmtp.ok -eq $false -and $rHrSmtp.code -eq 403)

Write-Host "`n== last super admin protection =="
$superUserId = $super.user.id
try {
  Invoke-RestMethod -Uri "$base/api/accounts/$superUserId/roles" -Method Patch -ContentType 'application/json' `
    -WebSession $super.session -Body (@{ roles = @('finance') } | ConvertTo-Json) -TimeoutSec 10 | Out-Null
  Test "self role change blocked" $false
} catch {
  Test "self role change blocked" ($_.Exception.Response.StatusCode.value__ -eq 403)
}

Write-Host "`n== cleanup test accounts =="
try {
  Invoke-RestMethod -Uri "$base/api/accounts/$inviteeId" -Method Delete -WebSession $super.session -TimeoutSec 10 | Out-Null
  Test "delete invitee account" $true
} catch { Test "delete invitee account" $false }

Write-Host "`n$pass passed, $fail failed`n"
if ($fail -gt 0) { exit 1 }
