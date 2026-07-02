<#
.SYNOPSIS
  Builds the ghost Worker installer: ghost-worker-<ver>.msi and ghost-worker-setup-<ver>.exe.

.DESCRIPTION
  Needs the .NET SDK (for the WiX Toolset .NET tool) and the built binaries:
    <BinDir>\ghost-agent.exe, <BinDir>\ghost-sandbox.exe  (agent, release, x64)
    <DesktopExe>                                           (desktop app, release)
  Downloads the WebView2 bootstrapper from Microsoft and refuses it unless its
  Authenticode signature is valid and issued to Microsoft Corporation.
#>
param(
  [Parameter(Mandatory)] [string] $Version,
  [Parameter(Mandatory)] [string] $BinDir,
  [Parameter(Mandatory)] [string] $DesktopExe,
  [string] $ServerUrl = 'https://ghost.example.com',
  [string] $OutDir = (Join-Path $PSScriptRoot 'out'),
  [string] $IconFile = (Join-Path $PSScriptRoot '..\..\desktop\src-tauri\icons\icon.ico'),
  [string] $WixVersion = '5.0.2'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$here = $PSScriptRoot
$obj = Join-Path $OutDir 'obj'
New-Item -ItemType Directory -Force $OutDir, $obj | Out-Null

# --- WiX Toolset (pinned) ------------------------------------------------------
if (-not (Get-Command wix -ErrorAction SilentlyContinue)) {
  dotnet tool install --global wix --version $WixVersion
  $env:PATH += ";$env:USERPROFILE\.dotnet\tools"
}
foreach ($ext in 'WixToolset.UI.wixext', 'WixToolset.Util.wixext', 'WixToolset.Bal.wixext') {
  wix extension add -g "$ext/$WixVersion"
  if ($LASTEXITCODE) { throw "wix extension add $ext failed" }
}
# The BAL package ships its dll under another name (WixToolset.BootstrapperApplications.wixext.dll),
# so `-ext WixToolset.Bal.wixext` cannot find it by name; pass the file.
$balDir = Join-Path $env:USERPROFILE ".wix\extensions\WixToolset.Bal.wixext\$WixVersion"
$balExt = Get-ChildItem $balDir -Recurse -Filter '*.wixext.dll' | Select-Object -First 1
if (-not $balExt) { throw "BAL extension dll not found under $balDir" }

# --- The explanation shown in the installer = the file installed with it -------
function ConvertTo-Rtf([string] $text) {
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.Append('{\rtf1\ansi\deff0{\fonttbl{\f0\fswiss Segoe UI;}}\viewkind4\uc1\pard\f0\fs17 ')
  foreach ($ch in $text.ToCharArray()) {
    $c = [int]$ch
    if ($ch -eq "`r") { continue }
    elseif ($ch -eq "`n") { [void]$sb.Append("\par`r`n") }
    elseif ($ch -eq '\' -or $ch -eq '{' -or $ch -eq '}') { [void]$sb.Append('\' + $ch) }
    elseif ($c -lt 128) { [void]$sb.Append($ch) }
    else { $n = if ($c -gt 32767) { $c - 65536 } else { $c }; [void]$sb.Append('\u' + $n + '?') }
  }
  [void]$sb.Append('}')
  $sb.ToString()
}
$readme = Join-Path $here 'COMO-FUNCIONA.txt'
$rtf = Join-Path $obj 'how-it-works.rtf'
[System.IO.File]::WriteAllText($rtf, (ConvertTo-Rtf (Get-Content -Raw -Encoding utf8 $readme)), [System.Text.Encoding]::ASCII)

# --- MSI -------------------------------------------------------------------------
$msi = Join-Path $OutDir "ghost-worker-$Version.msi"
wix build -arch x64 -culture pt-BR `
  -ext WixToolset.UI.wixext -ext WixToolset.Util.wixext `
  -loc (Join-Path $here 'strings.pt-BR.wxl') `
  -d "Version=$Version" -d "BinDir=$BinDir" -d "DesktopExe=$DesktopExe" -d "ServerUrl=$ServerUrl" `
  -d "IconFile=$IconFile" -d "ReadmeFile=$readme" -d "HowItWorksRtf=$rtf" `
  -intermediatefolder (Join-Path $obj 'msi') `
  (Join-Path $here 'Package.wxs') (Join-Path $here 'UI.wxs') -o $msi
if ($LASTEXITCODE) { throw 'MSI build failed' }

# --- WebView2 bootstrapper (Microsoft-signed only) --------------------------------
$wv2 = Join-Path $obj 'MicrosoftEdgeWebview2Setup.exe'
if (-not (Test-Path $wv2)) {
  Invoke-WebRequest -UseBasicParsing 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $wv2
}
$sig = Get-AuthenticodeSignature $wv2
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
  throw "WebView2 bootstrapper signature not trusted: $($sig.Status) $($sig.SignerCertificate.Subject)"
}

# --- Setup bundle ------------------------------------------------------------------
$setup = Join-Path $OutDir "ghost-worker-setup-$Version.exe"
wix build -arch x64 `
  -ext $balExt.FullName -ext WixToolset.Util.wixext `
  -d "Version=$Version" -d "IconFile=$IconFile" -d "MsiFile=$msi" -d "WebView2Bootstrapper=$wv2" -d "HowItWorksRtf=$rtf" `
  -intermediatefolder (Join-Path $obj 'bundle') `
  (Join-Path $here 'Bundle.wxs') -o $setup
if ($LASTEXITCODE) { throw 'bundle build failed' }

Get-Item $msi, $setup | Select-Object Name, Length | Format-Table
