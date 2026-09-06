@echo off
REM ===================================================================
REM  AdvisePoint Docs - One-time setup
REM
REM  Run this ONCE after extracting the zip. It does two things:
REM
REM    1. Removes Windows' "downloaded from the internet" flag
REM       (Mark-of-the-Web / Zone.Identifier ADS) from every file in
REM       this folder. That is what triggers the two SmartScreen
REM       "Windows protected your PC" popups on first launch of
REM       the .bat launcher and the .vbs hidden-window wrapper.
REM       Clearing MOTW once here silences both permanently.
REM
REM    2. Creates a "AdvisePoint Docs" shortcut in this folder with
REM       the proper AdvisePoint Docs icon that launches the app with NO
REM       command window. The shortcut itself is created FRESH (not
REM       from the zip) so it carries no MOTW of its own.
REM
REM  After this runs you can double-click the new shortcut icon
REM  from now on and forget this .bat exists.
REM ===================================================================

cd /d "%~dp0"

echo.
echo  Step 1/3: Removing Windows "downloaded file" flag from bundled files...
echo            (this is what causes SmartScreen popups on first launch)
echo.

REM Belt-and-suspenders MOTW removal. We use THREE approaches because
REM Unblock-File alone has been observed to miss files on some Windows
REM builds when called with -LiteralPath on a trailing-backslash path:
REM
REM   (a) Unblock-File on every file via -Path (wildcard-friendly)
REM   (b) Remove-Item on every Zone.Identifier ADS directly - this is
REM       what Unblock-File does under the hood, but calling it
REM       explicitly bypasses any path-parsing weirdness
REM   (c) The critical launcher files get an extra targeted pass so
REM       even if the recursive sweep skipped them, they end up clean
REM
REM All operations use -ErrorAction SilentlyContinue so a locked file
REM (antivirus scanning node.exe at that moment) doesn't abort setup.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$root = (Get-Location).Path; Write-Host ('  Scanning ' + $root); try { Get-ChildItem -Path $root -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ($_.FullName + ':Zone.Identifier') -ErrorAction SilentlyContinue }; Write-Host '  Recursive sweep complete.' } catch { Write-Host ('  Sweep warning (non-fatal): ' + $_.Exception.Message) }"

REM Targeted second pass on the two files SmartScreen actually inspects.
REM If Windows Defender is holding one of these open during the sweep
REM above, this second attempt (a moment later) usually succeeds.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$root = (Get-Location).Path; $targets = @('Start AdvisePoint Docs.bat', 'launcher\run-hidden.vbs', 'Setup Icon (run once).bat'); foreach ($t in $targets) { $p = Join-Path $root $t; if (Test-Path -LiteralPath $p) { Unblock-File -LiteralPath $p -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ($p + ':Zone.Identifier') -ErrorAction SilentlyContinue; Write-Host ('  Cleared: ' + $t) } }"

echo.
echo  Step 2/3: Creating desktop shortcut with AdvisePoint Docs icon...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "launcher\create-shortcut.ps1"

echo.
echo  Step 3/3: Clearing "downloaded file" flag on the new shortcut...
echo.

REM The .lnk PowerShell just created can inherit MOTW from this .bat's
REM process context on some Windows builds. Strip it explicitly.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$lnk = Join-Path (Get-Location).Path 'AdvisePoint Docs.lnk'; if (Test-Path -LiteralPath $lnk) { Unblock-File -LiteralPath $lnk -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ($lnk + ':Zone.Identifier') -ErrorAction SilentlyContinue; Write-Host '  Shortcut cleared.' }"

if exist "AdvisePoint Docs.lnk" (
    echo.
    echo  Done. Look for "AdvisePoint Docs" with the AdvisePoint Docs icon
    echo  in this folder - double-click it to run the app.
    echo.
    echo  You can drag that shortcut to your Desktop or pin it to your
    echo  Taskbar for one-click access.
    echo.
    echo  If SmartScreen still prompts on first launch of the shortcut,
    echo  click "More info" then "Run anyway" ONCE. Windows caches that
    echo  approval and will not prompt again for this folder's files.
    echo.
) else (
    echo.
    echo  Shortcut creation failed. You can still run the app by
    echo  double-clicking "Start AdvisePoint Docs.bat".
    echo.
)

pause
