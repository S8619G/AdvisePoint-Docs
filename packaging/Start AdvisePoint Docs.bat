@echo off
REM ===================================================================
REM  AdvisePoint Docs
REM  Starts the local server and opens the browser.
REM
REM  Preferred launch: double-click the "AdvisePoint Docs" shortcut,
REM  which runs launcher\run-hidden.vbs and hides this window entirely.
REM  Double-clicking this .bat directly also works - it auto-bounces
REM  through the VBS wrapper so nothing visible appears either way.
REM ===================================================================

REM v1.0.9.23 launcher rewrite: eliminate PowerShell from the runtime
REM launch path. Prior versions ran the server under a PowerShell
REM Tee-Object pipeline for log capture, and opened the browser via a
REM detached PowerShell running Start-Sleep + Start-Process. On
REM Windows 11 (26200 build) the Tee-Object PowerShell would end up
REM with a taskbar-eligible window handle post-update, showing an
REM invisible-but-clickable tile that crashed the app when closed.
REM
REM New design:
REM   * node writes its stdout+stderr directly to server.log via cmd's
REM     `>>` redirection. No PowerShell wrapper, no pipeline, no
REM     taskbar-eligible parent process.
REM   * server opens the browser itself once it's actually listening
REM     (APD_OPEN_BROWSER=1). No timing race, no second PowerShell.
REM   * server.log rotation (previous session -> server.log.1) happens
REM     here at launch, matching the old Tee-Object behavior.
REM
REM The Unblock-File call below is still PowerShell but it is one-shot
REM (guarded by .unblocked sentinel), foreground, hidden window, and
REM exits before anything else runs -- so it cannot linger on the
REM taskbar. The crash-surface AppActivate is also PowerShell but only
REM fires on non-zero exit outside an update, i.e. a real crash.

REM --- Self-relaunch hidden or minimized (only when run directly, not via VBS) ---
REM The VBS wrapper starts us fully hidden and sets APD_HIDDEN=1, in which case
REM we skip both self-relaunch branches.
REM
REM v0.9.18: when the user double-clicks Start AdvisePoint Docs.bat directly,
REM previous versions relaunched *minimized* - a minimized cmd still shows a
REM taskbar icon labeled "AdvisePoint Docs" which surprised users who expected
REM nothing visible. Now, if launcher\run-hidden.vbs exists next to us, we
REM prefer to bounce the launch through it so the console is truly hidden.
REM If the VBS is missing (e.g. hand-copied .bat), we fall back to minimized.
if not defined APD_HIDDEN if not defined APD_MIN (
    if exist "%~dp0launcher\run-hidden.vbs" (
        REM Bounce through the VBS wrapper for a fully hidden launch
        wscript.exe "%~dp0launcher\run-hidden.vbs"
        exit /b
    )
    REM VBS not present - fall back to relaunching minimized
    set APD_MIN=1
    start "AdvisePoint Docs" /min cmd /c ""%~f0""
    exit /b
)

setlocal
cd /d "%~dp0"

REM ---------------- v0.9.29: One-shot Mark-of-the-Web unblock ----------------
REM When users download the .zip and extract it, every file inherits the
REM "downloaded from the internet" tag (Zone.Identifier ADS). Windows then
REM raises a SmartScreen warning when the .bat runs and again when it spawns
REM node.exe - two dialogs per launch. Strip the tag from the app folder on
REM first run so subsequent launches are silent. A sentinel file marks that
REM we've already done this. Deleting the app folder cleanly resets it.
REM No admin rights required - PowerShell Unblock-File just removes the ADS
REM from files under the current user's write access.
if not exist "%~dp0.unblocked" (
    powershell -NoProfile -WindowStyle Hidden -Command ^
        "try { Get-ChildItem -LiteralPath '%~dp0' -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue } catch {}"
    REM Drop the sentinel even if a few files couldn't be unblocked - we don't
    REM want to keep re-running on every launch just because a locked file
    REM slipped through.
    echo v0.9.29 unblock complete > "%~dp0.unblocked"
)

REM Free any stale process listening on port 5000 (best-effort)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5000" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)

REM ---------------- Storage paths ----------------
REM Keep the SQLite DB and rendered page images together under LOCALAPPDATA
REM so uninstalling by deleting this folder never leaves user data behind.
if not defined LOCALAPPDATA set "LOCALAPPDATA=%APPDATA%"
set "RAG_DB_PATH=%LOCALAPPDATA%\AdvisePoint Docs\advisepoint.db"
set "RAG_PAGES_DIR=%LOCALAPPDATA%\AdvisePoint Docs\pages"
set "RAG_SEED_DB=%~dp0seed.db"

REM ---------------- Log file ----------------
set "APD_LOG_DIR=%LOCALAPPDATA%\AdvisePoint Docs"
if not exist "%APD_LOG_DIR%" mkdir "%APD_LOG_DIR%" >nul 2>&1
set "APD_LOG=%APD_LOG_DIR%\server.log"

REM v1.0.9.23: rotate previous session's log out of the way so this
REM session starts fresh. Matches the effective behavior of the old
REM PowerShell Tee-Object pipeline (which truncated on each launch)
REM while giving support a copy of the previous run. Best-effort: if a
REM stale PowerShell.exe from a pre-1.0.9.23 install still holds the
REM handle, the rename fails silently and we append to the existing log.
if exist "%APD_LOG%" (
    if exist "%APD_LOG_DIR%\server.log.1" del /q "%APD_LOG_DIR%\server.log.1" >nul 2>&1
    move /y "%APD_LOG%" "%APD_LOG_DIR%\server.log.1" >nul 2>&1
)

REM ---------------- Launch server ----------------
REM v1.0.9.23: node runs directly under cmd, writing stdout+stderr straight
REM to server.log via `>>`. No PowerShell wrapper. --max-old-space-size=4096
REM gives node a 4 GB heap so large uploads (100+ MB manuals held in RAM
REM during extract+chunk+embed) do not OOM.
REM
REM Framing lines emitted by cmd itself so support can see when the process
REM started and stopped without parsing node output.
REM
REM APD_OPEN_BROWSER=1 tells the server to launch the default browser once
REM it's actually listening (see server/index.ts). That replaces the old
REM detached PowerShell Start-Sleep + Start-Process one-liner.
set APD_OPEN_BROWSER=1
echo [launcher] %DATE% %TIME% node-start log=%APD_LOG% >> "%APD_LOG%"
"%~dp0node\node.exe" --max-old-space-size=4096 "%~dp0dist\index.cjs" >> "%APD_LOG%" 2>&1
set "APD_EXIT=%ERRORLEVEL%"
echo [launcher] %DATE% %TIME% node-exit exit_code=%APD_EXIT% >> "%APD_LOG%"

REM ---------------- Crash surface ----------------
REM If the server crashed (non-zero exit) we need to make the failure visible.
REM The behavior depends on how we were launched:
REM   * From the hidden VBS wrapper: this whole process is invisible, so
REM     we spawn a NEW visible cmd window that shows the error + log path.
REM   * From a minimized cmd (double-clicked .bat): restore + pause here.
REM Clean shutdowns (exit code 0) close silently either way.
REM
REM v1.0.8.3: suppress the crash surface when the in-app updater is the one
REM taking us down. The updater drops ".updating" in %LOCALAPPDATA%\AdvisePoint
REM Docs\ before requesting /shutdown and removes it after relaunch succeeds.
REM When that sentinel is present, a non-zero exit is expected (node's
REM SIGTERM handler in server/index.ts calls process.exit(0), but any code
REM path that races the shutdown can still exit non-zero) and MUST NOT pop
REM the "AdvisePoint Docs - crashed" window on the user. If the sentinel is
REM stale (older than 1 day), fall through to the normal crash surface so
REM real crashes during an abandoned update attempt are still visible.
set "APD_UPDATE_SENTINEL=%LOCALAPPDATA%\AdvisePoint Docs\.updating"
set "APD_SUPPRESS_CRASH="
if not "%APD_EXIT%"=="0" if exist "%APD_UPDATE_SENTINEL%" (
    forfiles /p "%LOCALAPPDATA%\AdvisePoint Docs" /m ".updating" /d -1 >nul 2>&1
    if errorlevel 1 set "APD_SUPPRESS_CRASH=1"
)
if not "%APD_EXIT%"=="0" if not defined APD_SUPPRESS_CRASH (
    if defined APD_HIDDEN (
        start "AdvisePoint Docs - crashed" cmd /k "echo. & echo ===================================================================== & echo  AdvisePoint Docs exited with error code %APD_EXIT%. & echo  Full log: %APD_LOG% & echo ===================================================================== & echo."
    ) else (
        powershell -NoProfile -Command "$w = New-Object -ComObject WScript.Shell; $w.AppActivate('AdvisePoint Docs')" >nul 2>&1
        echo.
        echo =====================================================================
        echo  AdvisePoint Docs exited with error code %APD_EXIT%.
        echo  Full log: %APD_LOG%
        echo =====================================================================
        echo.
        pause
    )
)

endlocal
