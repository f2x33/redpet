<#
  _post-move-repair.ps1 -- one-off cleanup after moving the plugin folder. Safe to delete afterwards.

  WHY THIS EXISTS
    The plugin folder was moved from a path inside the AI workspace to a standalone
    repository location. Windows' Move-Item walked into the NTFS junctions that the
    package's node_modules used for dependency resolution, which destroyed them
    (one became an empty real directory, two disappeared) and may have left broken
    reparse points behind at the old path.

    On top of that, three tool scripts had been written to the OLD path AFTER the
    move, so they must be rescued before the old folder is deleted.

  WHAT IT DOES, IN ORDER
    1. rescue *.mjs / *.ps1 from <Old>\tools into <New>\tools (never overwrites)
    2. delete <Old> safely -- unlinks junctions instead of descending into them
    3. call fix-node-modules.ps1 for <New> (recreates the three junctions)
    4. run node tools\selftest.mjs in <New>

  WHY THIS FILE IS PURE ASCII
    Windows PowerShell 5.1 reads .ps1 files as the system ANSI code page unless they
    carry a UTF-8 BOM; a non-ASCII literal then gets mangled into bytes that can
    include { } | " and break parsing. All messages are English and both paths come
    in as parameters (command lines are UTF-16 and safe).

  USAGE
    powershell -ExecutionPolicy Bypass -File "<this file>" -Old "<old dir>" -New "<new dir>"
#>

param(
  [Parameter(Mandatory = $true)][string]$Old,
  [Parameter(Mandatory = $true)][string]$New
)

$ErrorActionPreference = 'Stop'

Write-Host "== dsh-redpet :: post-move repair ==" -ForegroundColor Cyan
Write-Host "old: $Old"
Write-Host "new: $New`n"

# ---- guard rails ------------------------------------------------------------
if (-not (Test-Path (Join-Path $New 'package.json'))) {
  Write-Host "No package.json under -New. Check the path. Aborted." -ForegroundColor Red
  exit 1
}
if ($Old -eq $New -or $New.StartsWith($Old, [System.StringComparison]::OrdinalIgnoreCase)) {
  Write-Host "-New is the same as, or inside, -Old. Aborted." -ForegroundColor Red
  exit 1
}

# delete a tree without ever descending into a junction / symlink
function Remove-TreeSafely([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  foreach ($child in Get-ChildItem -LiteralPath $Path -Force) {
    $isLink = ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    if ($isLink) {
      Write-Host "    unlink: $($child.Name)" -ForegroundColor Yellow
      & cmd /c rmdir "$($child.FullName)" | Out-Null
    } elseif ($child.PSIsContainer) {
      Remove-TreeSafely $child.FullName
    } else {
      Remove-Item -LiteralPath $child.FullName -Force
    }
  }
  Remove-Item -LiteralPath $Path -Force
}

if (Test-Path -LiteralPath $Old) {
  # ---- 1. rescue tool scripts ----------------------------------------------
  Write-Host "[1/4] rescuing tool scripts from the old path ..."
  $oldTools = Join-Path $Old 'tools'
  if (Test-Path -LiteralPath $oldTools) {
    $newTools = Join-Path $New 'tools'
    New-Item -ItemType Directory -Path $newTools -Force | Out-Null
    foreach ($f in Get-ChildItem -LiteralPath $oldTools -File) {
      $dest = Join-Path $newTools $f.Name
      if (Test-Path -LiteralPath $dest) {
        Write-Host "    already present, skipped: $($f.Name)" -ForegroundColor DarkGray
      } else {
        Copy-Item -LiteralPath $f.FullName -Destination $dest
        Write-Host "    rescued: $($f.Name)" -ForegroundColor Green
      }
    }
  } else {
    Write-Host "    no tools folder at the old path, skipped" -ForegroundColor DarkGray
  }

  # ---- 2. delete the old folder -------------------------------------------
  Write-Host "`n[2/4] deleting the old folder ..."
  Remove-TreeSafely $Old
  if (Test-Path -LiteralPath $Old) {
    Write-Host "    could not delete it (something is holding it). Close DSH and retry." -ForegroundColor Red
    exit 1
  }
  Write-Host "    deleted: $Old" -ForegroundColor Green
} else {
  Write-Host "[1/4] old path does not exist, skipped" -ForegroundColor DarkGray
  Write-Host "[2/4] old path does not exist, skipped" -ForegroundColor DarkGray
}

# ---- 3. recreate the junctions ---------------------------------------------
Write-Host "`n[3/4] recreating node_modules junctions ..."
$fix = Join-Path $New 'tools\fix-node-modules.ps1'
if (-not (Test-Path -LiteralPath $fix)) {
  Write-Host "    missing $fix -- cannot continue." -ForegroundColor Red
  exit 1
}
& $fix -Pkg $New
$fixCode = $LASTEXITCODE

# ---- 4. self test -----------------------------------------------------------
Write-Host "`n[4/4] config + asset self test ..."
Push-Location $New
try {
  node tools\selftest.mjs
  $selfCode = $LASTEXITCODE
} finally {
  Pop-Location
}

Write-Host ""
if ($fixCode -eq 0 -and $selfCode -eq 0) {
  Write-Host "All good. Next: refresh the DSH page (Ctrl+F5) to see the red team pet." -ForegroundColor Green
} else {
  Write-Host "Something still fails - send me the FAIL / hard-failure lines above." -ForegroundColor Red
}
