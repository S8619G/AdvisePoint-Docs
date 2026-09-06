# =====================================================================
#  AdvisePoint Docs - First-run shortcut installer
#  Creates "AdvisePoint Docs.lnk" in the app folder pointing at the
#  hidden VBS launcher with the AdvisePoint Docs icon. Idempotent - safe to
#  run multiple times.
# =====================================================================
$ErrorActionPreference = 'SilentlyContinue'

# Resolve paths relative to this script's location
$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$appDir     = Split-Path -Parent $scriptDir
$shortcut   = Join-Path $appDir 'AdvisePoint Docs.lnk'
$targetVbs  = Join-Path $scriptDir 'run-hidden.vbs'
$iconFile   = Join-Path $scriptDir 'AdvisePointDocs.ico'

$shell = New-Object -ComObject WScript.Shell
$link  = $shell.CreateShortcut($shortcut)
$link.TargetPath       = "$env:WINDIR\System32\wscript.exe"
$link.Arguments        = "`"$targetVbs`""
$link.WorkingDirectory = $appDir
$link.IconLocation     = "$iconFile,0"
$link.Description      = "AdvisePoint Docs"
$link.WindowStyle      = 7   # minimized (irrelevant since wscript is windowless)
$link.Save()

Write-Host "Created: $shortcut"
