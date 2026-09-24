<#
.SYNOPSIS
  Installs the MSI silently on this (disposable) Windows machine, checks every change
  it is supposed to make, uninstalls it and checks that nothing is left.
  Run elevated. Used by CI (.github/workflows/installer.yml).
#>
param([Parameter(Mandatory)] [string] $Msi)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$failures = [System.Collections.Generic.List[string]]::new()
function Check([bool] $ok, [string] $what) {
  if ($ok) { Write-Host "  ok   $what" } else { Write-Host "  FAIL $what" -ForegroundColor Red; $failures.Add($what) }
}
function WaitFor([scriptblock] $cond, [int] $seconds = 60) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) { if (& $cond) { return $true }; Start-Sleep -Milliseconds 500 }
  return $false
}

$prog = Join-Path $env:ProgramFiles 'ghost'
$data = Join-Path $env:ProgramData 'ghost'
$menu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\ghost'
$desktopLnk = Join-Path $env:PUBLIC 'Desktop\ghost.lnk'
$ruleName = 'ghost Worker: sandbox sem rede'
$token = 'ghe_ci_not_a_real_token_' + [guid]::NewGuid().ToString('N')
$logs = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force $logs | Out-Null

# ---------------------------------------------------------------- install
Write-Host '== install'
$p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @(
  '/i', "`"$Msi`"", '/qn', '/l*v', "`"$logs\install.log`"",
  'SERVER_URL=https://ghost.invalid', "ENROLLMENT_TOKEN=$token", 'DESKTOP_SHORTCUT=1', 'AUTOSTART_APP=1', 'FIREWALL_RULE=1')
Check ($p.ExitCode -eq 0) "msiexec /i exit code 0 (got $($p.ExitCode))"

# Files
foreach ($f in 'ghost-agent.exe', 'ghost-sandbox.exe', 'ghost.exe', 'COMO-FUNCIONA.txt') {
  Check (Test-Path (Join-Path $prog $f)) "installed $f"
}

# Service: own virtual account, automatic (delayed), restarts on failure, running.
$svc = Get-CimInstance Win32_Service -Filter "Name='GhostWorker'"
Check ($null -ne $svc) 'service GhostWorker registered'
if ($svc) {
  Check ($svc.StartName -eq 'NT SERVICE\GhostWorker') "service account is NT SERVICE\GhostWorker (got $($svc.StartName))"
  Check ($svc.StartMode -eq 'Auto') "service starts automatically (got $($svc.StartMode))"
  Check ($svc.DisplayName -eq 'ghost Worker') 'service display name'
  Check ($svc.Description -match 'Iniciar') 'service description explains it'
  Check ($svc.PathName -match 'ghost-agent\.exe"? service$') "service command line (got $($svc.PathName))"
}
Check (WaitFor { (Get-Service GhostWorker -ErrorAction SilentlyContinue).Status -eq 'Running' }) 'service running'
Check ((& sc.exe qfailure GhostWorker | Out-String) -match 'RESTART') 'service restarts after a crash'

# Data folder: protected ACL, only SYSTEM, Administrators and the service.
Check (Test-Path $data) 'data folder created'
$acl = Get-Acl $data
Check $acl.AreAccessRulesProtected 'data folder ACL does not inherit'
$ids = @($acl.Access | ForEach-Object { $_.IdentityReference.Value })
Check (@($ids | Where-Object { $_ -notin @('NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators', 'NT SERVICE\GhostWorker') }).Count -eq 0) "data folder: only SYSTEM, Administrators, the service (got $($ids -join ', '))"
Check ('NT SERVICE\GhostWorker' -in $ids) 'service can write its data folder'

# Configuration written by the installer.
$cfg = Join-Path $data 'agent.toml'
Check (Test-Path $cfg) 'agent.toml written'
if (Test-Path $cfg) {
  $raw = Get-Content -Raw $cfg
  Check ($raw -match 'url = "https://ghost.invalid"') 'agent.toml has the chosen server'
  Check ($raw -match 'max_gpu_percent = 0') 'GPU not shared by default'
}

# The connection code: used once by the service and deleted; never in the install log.
Check (WaitFor { -not (Test-Path (Join-Path $data 'enroll.ini')) }) 'connection code file consumed and deleted by the service'
$leaks = @(Select-String -Path "$logs\install.log" -Pattern $token -SimpleMatch)
Check ($leaks.Count -eq 0) 'connection code not written to the installer log'
$leaks | Select-Object -First 5 | ForEach-Object { Write-Host "       leak at line $($_.LineNumber): $($_.Line.Replace($token, '<CODE>'))" }

# The service is up, not connected (the code was fake), and says so over IPC.
$agent = Join-Path $prog 'ghost-agent.exe'
# The fake code is tried against an unreachable server first; the answer must still come.
$st = ''
$answered = WaitFor { $script:st = & $agent status 2>&1 | Out-String; $script:st -match 'NOT_ENROLLED' } 60
Check $answered "agent answers over IPC and reports NOT_ENROLLED (got: $($st.Trim()))"
Check (WaitFor { Test-Path (Join-Path $data 'logs') }) 'service writes its logs'
if (-not $answered) {
  Get-ChildItem (Join-Path $data 'logs') -File -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "       --- $($_.Name)"; Get-Content $_.FullName -Tail 40 | ForEach-Object { Write-Host "       $_" }
  }
}

# Firewall: no inbound rule, one outbound block for the sandbox.
$rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
Check ($null -ne $rule) 'firewall rule created'
if ($rule) {
  Check ($rule.Direction -eq 'Outbound' -and $rule.Action -eq 'Block' -and $rule.Enabled -eq 'True') 'firewall rule blocks outbound traffic'
  $app = ($rule | Get-NetFirewallApplicationFilter).Program
  Check ($app -like '*ghost-sandbox.exe') "firewall rule targets ghost-sandbox.exe (got $app)"
}
Check (@(Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'ghost*' -and $_.Direction -eq 'Inbound' }).Count -eq 0) 'no inbound firewall rule (no port opened)'

# Shortcuts and autostart.
foreach ($l in 'ghost.lnk', 'Como o ghost funciona.lnk', 'Desinstalar ghost.lnk') { Check (Test-Path (Join-Path $menu $l)) "Start menu: $l" }
Check (Test-Path $desktopLnk) 'desktop shortcut'
$run = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -Name ghost -ErrorAction SilentlyContinue).ghost
Check ($run -match 'ghost\.exe" --background') "app starts with Windows in the tray (got $run)"

# ---------------------------------------------------------------- uninstall
Write-Host '== uninstall'
$p = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @('/x', "`"$Msi`"", '/qn', '/l*v', "`"$logs\uninstall.log`"")
Check ($p.ExitCode -eq 0) "msiexec /x exit code 0 (got $($p.ExitCode))"
Check ((Select-String -Path "$logs\uninstall.log" -Pattern 'not connected: nothing to tell the server|left the platform' -Quiet)) 'uninstaller ran the agent cleanup'

Check ($null -eq (Get-Service GhostWorker -ErrorAction SilentlyContinue)) 'service removed'
Check (-not (Test-Path $prog)) 'program folder removed'
Check (-not (Test-Path $data)) 'data folder (config, credentials, logs) removed'
Check ($null -eq (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) 'firewall rule removed'
Check (-not (Test-Path $menu)) 'Start menu folder removed'
Check (-not (Test-Path $desktopLnk)) 'desktop shortcut removed'
Check ($null -eq (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -Name ghost -ErrorAction SilentlyContinue)) 'autostart removed'
Check (-not (Test-Path 'HKLM:\SOFTWARE\ghost')) 'registry key removed'

if ($failures.Count) {
  Write-Host "`n$($failures.Count) check(s) failed:" -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
Write-Host "`nall checks passed"
# Native commands above (e.g. `status` answering NOT_ENROLLED) leave $LASTEXITCODE set.
exit 0
