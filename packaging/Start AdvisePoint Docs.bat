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

REM v0.9.18 launcher fixes:
REM  - .bat now bounces through run-hidden.vbs when double-clicked directly,
REM    so users no longer see a minimized "AdvisePoint Docs" taskbar entry.
REM  - PowerShell server launch uses -WindowStyle Hidden so no console flashes.
REM  - Browser-open delay routes through hidden PowerShell Start-Sleep instead
REM    of a visible `cmd /c timeout` window.

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

REM Open the browser after a short delay so the server has time to start.
REM v0.9.18 fix: previous versions spawned a visible cmd window to run
REM `timeout /t 3`. Under the VBS hidden launcher that window still flashed
REM (or lingered) because `start cmd /c` creates its own console. Route the
REM delay through PowerShell with -WindowStyle Hidden so nothing appears.
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:5000'"

REM ---------------- Log file ----------------
set "APD_LOG_DIR=%LOCALAPPDATA%\AdvisePoint Docs"
if not exist "%APD_LOG_DIR%" mkdir "%APD_LOG_DIR%" >nul 2>&1
set "APD_LOG=%APD_LOG_DIR%\server.log"

REM Launch the server in the foreground and mirror stdout+stderr to the log.
REM PowerShell's Tee-Object gives us both console output AND a persistent log
REM without needing a third-party tool.
REM --max-old-space-size=4096 gives node a 4 GB heap so large uploads (100+ MB
REM manuals held in RAM during extract+chunk+embed) don't OOM.
REM
REM v0.9.18 fix: added -WindowStyle Hidden so PowerShell itself doesn't
REM raise a visible console window when we're launched via the VBS wrapper.
REM Under the hidden launcher this becomes a truly invisible chain:
REM   VBS (0=hidden) -> cmd .bat (hidden) -> powershell (WindowStyle Hidden) -> node
REM
REM v0.9.34: additive [launcher] framing lines. These are Write-Output calls
REM INSIDE the PowerShell pipeline so they flow through the same Tee-Object
REM that captures node's stdout+stderr, landing in server.log alongside the
REM server's own output. Everything above this block is byte-identical to the
REM v0.9.29 baseline so users who rely on the current launch behaviour don't
REM see any change; the wrapping is a strictly additive diagnostic aid.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ^
    "& { Write-Output ('[launcher] ' + (Get-Date -Format o) + ' node-start log=' + $env:APD_LOG); & '%~dp0node\node.exe' --max-old-space-size=4096 '%~dp0dist\index.cjs' 2>&1 ^| Tee-Object -FilePath '%APD_LOG%'; Write-Output ('[launcher] ' + (Get-Date -Format o) + ' node-exit exit_code=' + $LASTEXITCODE) }"
set "APD_EXIT=%ERRORLEVEL%"

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
REM When that sentinel is present, a non-zero exit is expected (PowerShell's
REM Tee-Object pipeline reports a non-zero $LASTEXITCODE when node exits mid-
REM stream during a coordinated shutdown) and MUST NOT pop the "AdvisePoint
REM Docs - crashed" window on the user. If the sentinel is stale (older than
REM 1 day), fall through to the normal crash surface so real crashes during
REM an abandoned update attempt are still visible. Windows forfiles /d only
REM supports day granularity, which is fine here: the updater cleans up the
REM sentinel in its normal path, so a stale one means the update abandoned
REM and any crash after 24h is unrelated to that abandoned attempt.
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
