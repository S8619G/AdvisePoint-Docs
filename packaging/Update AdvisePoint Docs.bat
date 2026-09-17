@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0node\node.exe" (
    echo.
    echo  The bundled Node.js runtime is missing.
    echo  Re-extract AdvisePoint Docs, then try the update again.
    echo.
    pause
    exit /b 1
)

if not exist "%~dp0packaging\updater\updater.cjs" (
    echo.
    echo  The updater files are missing.
    echo  Re-extract AdvisePoint Docs, then try the update again.
    echo.
    pause
    exit /b 1
)

REM v1.0.9: forward APD_LOCAL_ZIP as --local-zip to updater.cjs. Set by the
REM in-app drop-a-zip flow (server passes it via env when spawning us). When
REM unset, updater.cjs falls back to the GitHub-fetch path as before.
if defined APD_LOCAL_ZIP (
    "%~dp0node\node.exe" "%~dp0packaging\updater\updater.cjs" --local-zip "%APD_LOCAL_ZIP%"
) else (
    "%~dp0node\node.exe" "%~dp0packaging\updater\updater.cjs"
)
set "APD_UPDATE_EXIT=%ERRORLEVEL%"

if not "%APD_UPDATE_EXIT%"=="0" (
    echo.
    echo  Update did not complete. Your existing installation was preserved.
    echo  See %%LOCALAPPDATA%%\AdvisePoint Docs\update.log for details.
    echo.
    pause
)

endlocal & exit /b %APD_UPDATE_EXIT%
