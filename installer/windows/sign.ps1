<#
.SYNOPSIS
  Authenticode-signs files (SHA-256, RFC 3161 timestamp) and verifies each signature.

.DESCRIPTION
  The certificate comes from the environment, one of:
    SIGN_PFX_BASE64 + SIGN_PFX_PASSWORD  a code-signing certificate exported as .pfx (base64),
                                         e.g. GitHub secrets WINDOWS_SIGN_PFX_BASE64 / _PASSWORD;
    SIGN_CERT_THUMBPRINT                 a certificate in Cert:\CurrentUser\My (or LocalMachine\My),
                                         e.g. a hardware token or a cloud HSM exposed to Windows.
  Without either: prints that the build is unsigned and returns $false (nothing changes).

  -Bundle: the files are WiX Burn bundles (setup.exe). Their engine is signed first
  (detached, signed, reattached), then the bundle itself, as Burn requires.

.OUTPUTS
  $true when the files were signed and every signature verified.
#>
param(
  [Parameter(Mandatory)] [string[]] $Files,
  [switch] $Bundle,
  [string] $TimestampUrl = 'http://timestamp.digicert.com',
  [string] $Description = 'ghost Worker'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $env:SIGN_PFX_BASE64 -and -not $env:SIGN_CERT_THUMBPRINT) {
  Write-Host 'code signing: no certificate configured (SIGN_PFX_BASE64 or SIGN_CERT_THUMBPRINT); files stay unsigned'
  return $false
}

function Find-SignTool {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $found = Get-ChildItem $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object FullName -match '\\x64\\' | Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $found) { throw 'signtool.exe not found (Windows SDK)' }
  $found.FullName
}
$signtool = Find-SignTool

$pfx = $null
try {
  if ($env:SIGN_PFX_BASE64) {
    $pfx = Join-Path ([System.IO.Path]::GetTempPath()) ("sign-" + [guid]::NewGuid().ToString('N') + '.pfx')
    [System.IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:SIGN_PFX_BASE64))
    $cert = @('/f', $pfx, '/p', $env:SIGN_PFX_PASSWORD)
  } else {
    $cert = @('/sha1', $env:SIGN_CERT_THUMBPRINT)
  }

  function Sign-One([string] $file) {
    # Timestamp servers have bad minutes: retry before failing the build.
    for ($i = 1; $i -le 3; $i++) {
      & $signtool sign /fd SHA256 /td SHA256 /tr $TimestampUrl /d $Description @cert $file | Out-Host
      if ($LASTEXITCODE -eq 0) { break }
      if ($i -eq 3) { throw "signing $file failed" }
      Start-Sleep -Seconds (5 * $i)
    }
    & $signtool verify /pa /tw $file | Out-Host
    if ($LASTEXITCODE) { throw "signature of $file does not verify" }
    $s = Get-AuthenticodeSignature $file
    if ($s.Status -ne 'Valid') { throw "signature of ${file}: $($s.Status) $($s.StatusMessage)" }
    Write-Host "  signed  $(Split-Path -Leaf $file)  ($($s.SignerCertificate.Subject))"
  }

  foreach ($f in $Files) {
    $f = (Resolve-Path $f).Path
    if ($Bundle) {
      # Burn: the engine inside the bundle is what runs first; sign it, put it back, sign the whole.
      $engine = Join-Path ([System.IO.Path]::GetTempPath()) ("engine-" + [guid]::NewGuid().ToString('N') + '.exe')
      wix burn detach $f -engine $engine | Out-Host
      if ($LASTEXITCODE) { throw "wix burn detach $f failed" }
      Sign-One $engine
      wix burn reattach $f -engine $engine -o $f | Out-Host
      if ($LASTEXITCODE) { throw "wix burn reattach $f failed" }
      Remove-Item $engine -Force
    }
    Sign-One $f
  }
  return $true
} finally {
  if ($pfx -and (Test-Path $pfx)) { Remove-Item $pfx -Force }
}
