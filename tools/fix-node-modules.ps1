<#
  fix-node-modules.ps1 -- recreate the local dependency-resolution links for dsh-redteam-pet.

  WHY THIS EXISTS
    The plugin package lives OUTSIDE the DSH profile directory (for example
    D:\...\dsh-redteam-pet). Node resolves bare imports by walking up from the
    importing file, so lib/index.js can never reach the profile's node_modules,
    and the plugin dies at import time with "failed to import".

    Fix: give the package its own node_modules containing three directory links
    (NTFS junctions) that point back at the profile's node_modules.

  WHY THIS FILE IS PURE ASCII
    Windows PowerShell 5.1 reads .ps1 files as the system ANSI code page unless
    they carry a UTF-8 BOM. A non-ASCII literal inside such a file gets mangled
    into bytes that may include { } | " and break parsing. So: every message here
    is English, and every path is either derived from the environment or passed
    on the command line (command lines are UTF-16 and safe).

  USAGE
    powershell -ExecutionPolicy Bypass -File "<this file>" -Pkg "<package dir>"
#>

param(
  [string]$Pkg
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Pkg)) { $Pkg = Split-Path -Parent $PSScriptRoot }

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$nm = Join-Path $Pkg 'node_modules'

# name -> real location inside the profile
# NOTE: @deepseek-ai sits at profiles\node_modules (shared), the other two at profiles\web\node_modules
$links = [ordered]@{
  '@deepseek-ai'       = Join-Path $dshHome 'profiles\node_modules\@deepseek-ai'
  '@electron'          = Join-Path $dshHome 'profiles\web\node_modules\@electron'
  '@electron-internal' = Join-Path $dshHome 'profiles\web\node_modules\@electron-internal'
}

Write-Host "== dsh-redteam-pet :: fix node_modules ==" -ForegroundColor Cyan
Write-Host "package : $Pkg"
Write-Host "dsh home: $dshHome`n"

if (-not (Test-Path (Join-Path $Pkg 'package.json'))) {
  Write-Host "No package.json in that folder - wrong -Pkg. Aborted." -ForegroundColor Red
  exit 1
}

foreach ($k in $links.Keys) {
  if (-not (Test-Path $links[$k])) {
    Write-Host "Missing dependency source: $($links[$k])" -ForegroundColor Red
    Write-Host "DSH should provide it. Make sure DSH and dsh-pet are installed, then retry." -ForegroundColor Red
    exit 1
  }
}
Write-Host "dependency sources: 3/3 present" -ForegroundColor Green

# ---- clean the old node_modules without ever recursing through a link --------
if (Test-Path $nm) {
  Write-Host "`ncleaning old node_modules ..."
  $nmItem = Get-Item -LiteralPath $nm -Force
  if ($nmItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    Write-Host "  node_modules itself is a link -> removing the link only" -ForegroundColor Yellow
    & cmd /c rmdir "$nm"
  } else {
    foreach ($child in Get-ChildItem -LiteralPath $nm -Force) {
      $isLink = ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
      if ($isLink) {
        # cmd's rmdir removes a junction without descending into its target.
        # PowerShell's Remove-Item -Recurse is known to delete THROUGH a junction - never use it here.
        Write-Host "  unlink: $($child.Name)" -ForegroundColor Yellow
        & cmd /c rmdir "$($child.FullName)"
      } else {
        Write-Host "  remove leftover dir: $($child.Name)" -ForegroundColor Yellow
        Remove-Item -LiteralPath $child.FullName -Recurse -Force
      }
    }
    Remove-Item -LiteralPath $nm -Recurse -Force
  }
}

# ---- create the junctions ---------------------------------------------------
Write-Host "`ncreating junctions ..."
New-Item -ItemType Directory -Path $nm -Force | Out-Null
foreach ($k in $links.Keys) {
  $dest = Join-Path $nm $k
  New-Item -ItemType Junction -Path $dest -Target $links[$k] | Out-Null
  $t = (Get-Item -LiteralPath $dest -Force).Target
  Write-Host ("  {0,-20} -> {1}" -f $k, $t) -ForegroundColor Green
}

# ---- verify: can node actually resolve them from the package? --------------
Write-Host "`nverifying module resolution ..."
$probe = @"
const need = ['@deepseek-ai/dsh-home-paths','@deepseek-ai/dsh-credentials','@deepseek-ai/dsh-llm','@electron/get','@electron-internal/extract-zip'];
let bad = 0;
for (const m of need) {
  try { await import(m); console.log('  OK   ' + m); }
  catch (e) { bad++; console.log('  FAIL ' + m + ' -> ' + e.code); }
}
console.log(bad === 0 ? 'resolution OK' : (bad + ' module(s) failed'));
process.exit(bad === 0 ? 0 : 1);
"@
Push-Location $Pkg
try {
  $probe | node --input-type=module -
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}

Write-Host ""
if ($code -eq 0) {
  Write-Host "Done. Next: refresh the DSH page (Ctrl+F5) to see the red team pet." -ForegroundColor Green
} else {
  Write-Host "Some modules still fail - send me the FAIL lines above." -ForegroundColor Red
}
exit $code
