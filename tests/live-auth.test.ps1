# Live integration test: Access Management authorization chain
# Runs against a COPY of the test database (oneops_am_live) - never production.
# Usage: run with server already listening on :3001 with DB_NAME=oneops_am_live

$ErrorActionPreference = 'Stop'
$base = 'http://localhost:3001'
$pass = 0; $fail = 0

function Test($name, $cond) {
  if ($cond) { $script:pass++; Write-Host "  ok  $name" -ForegroundColor Green }
  else { $script:fail++; Write-Host "FAIL  $name" -ForegroundColor Red }
}

# --- login helpers -----------------------------------------------------------
function Login($username) {
  $resp = Invoke-RestMethod -Uri "$base/api/auth/login" -Method Post -ContentType 'application/json' `
    -Body (@{ username = $username; password = 'admin123' } | ConvertTo-Json) -SessionVariable s
  $resp | Add-Member -NotePropertyName session -NotePropertyValue $s
  return $resp
}

$super = Login 'superadmin'

Write-Host "`n== reset state (make test re-runnable) =="
# Clear finance's module grants so the deny-by-default checks below start clean.
try {
  $roles0 = Invoke-RestMethod -Uri "$base/api/access-management/roles" -WebSession $super.session -TimeoutSec 8
  $fin0 = $roles0.roles | Where-Object { $_.name -eq 'finance' }
  Invoke-RestMethod -Uri "$base/api/access-management/roles/$($fin0.id)/permissions" -Method Put `
    -ContentType 'application/json' -WebSession $super.session `
    -Body '{"permissions":[]}' | Out-Null
  Test "finance permissions reset" $true
} catch { Test "finance permissions reset" $false }

# finance must log in AFTER the reset above for its session to see clean permissions
$fin   = Login 'finance'

Write-Host "`n== login & permission payloads =="
Test "superadmin login returns roles" ($super.user.roles -contains 'super_admin')
Test "superadmin gets all 16 permissions" ($super.user.permissions.Count -eq 16)
Test "finance has NO permissions yet (deny-by-default)" ($fin.user.permissions.Count -eq 0)

Write-Host "`n== module gate: storage API =="
# finance without data_warrior.view -> 403
try {
  Invoke-RestMethod -Uri "$base/api/storage/folders" -WebSession $fin.session -TimeoutSec 8 | Out-Null
  Test "finance storage access denied (403)" $false
} catch {
  Test "finance storage access denied (403)" ($_.Exception.Response.StatusCode.value__ -eq 403)
}
# superadmin -> 200
try {
  $folders = Invoke-RestMethod -Uri "$base/api/storage/folders" -WebSession $super.session -TimeoutSec 8
  Test "superadmin storage access allowed" ($folders.ok -eq $true)
} catch { Test "superadmin storage access allowed" $false }

Write-Host "`n== module gate: rechecking proxy =="
try {
  Invoke-RestMethod -Uri "$base/api/awb-detail" -Method Post -ContentType 'application/json' `
    -WebSession $fin.session -Body '{"awb_number":"123"}' -TimeoutSec 8 | Out-Null
  Test "finance recheck denied (403)" $false
} catch {
  Test "finance recheck denied (403)" ($_.Exception.Response.StatusCode.value__ -eq 403)
}

Write-Host "`n== access management: superadmin-only =="
try {
  Invoke-RestMethod -Uri "$base/api/access-management/roles" -WebSession $fin.session -TimeoutSec 8 | Out-Null
  Test "finance access-management denied (403)" $false
} catch {
  Test "finance access-management denied (403)" ($_.Exception.Response.StatusCode.value__ -eq 403)
}
try {
  $roles = Invoke-RestMethod -Uri "$base/api/access-management/roles" -WebSession $super.session -TimeoutSec 8
  Test "superadmin sees roles" ($roles.roles.Count -ge 6)
  Test "roles carry user counts" ($null -ne $roles.roles[0].user_count)
} catch { Test "superadmin sees roles" $false }

Write-Host "`n== unauthenticated access =="
try {
  Invoke-RestMethod -Uri "$base/api/storage/folders" -TimeoutSec 8 | Out-Null
  Test "anonymous -> 401" $false
} catch {
  Test "anonymous -> 401" ($_.Exception.Response.StatusCode.value__ -eq 401)
}

Write-Host "`n== grant permissions then verify enforcement flips =="
# find finance role id
$roles = Invoke-RestMethod -Uri "$base/api/access-management/roles" -WebSession $super.session -TimeoutSec 8
$financeRole = $roles.roles | Where-Object { $_.name -eq 'finance' }

# grant data_warrior.view only
Invoke-RestMethod -Uri "$base/api/access-management/roles/$($financeRole.id)/permissions" -Method Put `
  -ContentType 'application/json' -WebSession $super.session `
  -Body (@{ permissions = @('data_warrior.view') } | ConvertTo-Json) | Out-Null

# re-login finance (permissions attach per session request; re-login for clean state)
$fin2 = Login 'finance'
Test "finance now has exactly 1 permission" ($fin2.user.permissions.Count -eq 1)
Test "granted permission is data_warrior.view" ($fin2.user.permissions[0] -eq 'data_warrior.view')

# storage now passes the MODULE gate (folder perms may still restrict content, but not 403 module denial)
try {
  $f2 = Invoke-RestMethod -Uri "$base/api/storage/folders" -WebSession $fin2.session -TimeoutSec 8
  Test "finance storage module access granted (200)" ($f2.ok -eq $true)
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Test "finance storage module access granted (200)" ($code -eq 200)
}

# recheck still denied
try {
  Invoke-RestMethod -Uri "$base/api/awb-detail" -Method Post -ContentType 'application/json' `
    -WebSession $fin2.session -Body '{"awb_number":"123"}' -TimeoutSec 8 | Out-Null
  Test "finance recheck still denied without grant" $false
} catch {
  Test "finance recheck still denied without grant" ($_.Exception.Response.StatusCode.value__ -eq 403)
}

Write-Host "`n== superadmin role protections =="
# rename super_admin -> 403
$saRole = $roles.roles | Where-Object { $_.name -eq 'super_admin' }
try {
  Invoke-RestMethod -Uri "$base/api/access-management/roles/$($saRole.id)" -Method Put `
    -ContentType 'application/json' -WebSession $super.session -Body (@{ name = 'hacked' } | ConvertTo-Json) | Out-Null
  Test "super_admin rename blocked" $false
} catch {
  Test "super_admin rename blocked" ($_.Exception.Response.StatusCode.value__ -eq 403)
}
# delete super_admin -> 403
try {
  Invoke-RestMethod -Uri "$base/api/access-management/roles/$($saRole.id)" -Method Delete -WebSession $super.session -TimeoutSec 8 | Out-Null
  Test "super_admin delete blocked" $false
} catch {
  Test "super_admin delete blocked" ($_.Exception.Response.StatusCode.value__ -eq 403)
}

# last super admin demotion -> 403
$superUser = $super.user
try {
  Invoke-RestMethod -Uri "$base/api/access-management/users/$($superUser.id)/roles" -Method Put `
    -ContentType 'application/json' -WebSession $super.session -Body (@{ roles = @('finance') } | ConvertTo-Json) | Out-Null
  Test "last superadmin demotion blocked" $false
} catch {
  Test "last superadmin demotion blocked" ($_.Exception.Response.StatusCode.value__ -eq 403)
}

# delete role with users assigned -> 409
$mgmtRole = $roles.roles | Where-Object { $_.name -eq 'management' }
try {
  Invoke-RestMethod -Uri "$base/api/access-management/roles/$($mgmtRole.id)" -Method Delete -WebSession $super.session -TimeoutSec 8 | Out-Null
  Test "delete role-with-users blocked" $false
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Test "delete role-with-users blocked (409)" ($code -eq 409 -or $code -eq 403)
}

Write-Host "`n== audit trail =="
# NOTE: only COMPLETED administrative changes are audited. The rejected
# attempts above (403/409) intentionally never reach the audit write.
$logs = $null
try {
  $logs = Invoke-RestMethod -Uri "$base/api/storage/audit-logs?page=1&pageSize=50" -WebSession $super.session -TimeoutSec 8
} catch { }
$permRows = @($logs.logs | Where-Object { $_.action -eq 'role.permissions.update' })
Test "permission grant is audited" ($permRows.Count -ge 1)

# Timestamps are second-precision; ties make row order non-deterministic.
# Assert the grant row from THIS run exists (granted contains the key).
$grantFound = $false
foreach ($row in $permRows) {
  $m = $null
  if ($row.metadata -is [string]) { try { $m = $row.metadata | ConvertFrom-Json } catch { } }
  else { $m = $row.metadata }
  if ($null -ne $m -and $m.granted -contains 'data_warrior.view') { $grantFound = $true; $meta = $m; break }
}
Test "audit records granted key diff" $grantFound
Test "audit names the target role" ($null -ne $meta -and $meta.role -eq 'finance')

Write-Host "`n$pass passed, $fail failed`n"
if ($fail -gt 0) { exit 1 }
