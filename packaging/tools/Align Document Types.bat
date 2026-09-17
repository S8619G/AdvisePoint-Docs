@echo off
setlocal

rem AdvisePoint Docs -- Align Document Types
rem
rem One-time cleanup for a library created before v1.1.4:
rem   * Title Cases every document type label
rem   * merges User Manual into User Guide, Bulletin into Technical Bulletin
rem   * merges the retired API Reference and KB Article into Miscellaneous
rem   * removes filename-code mappings that point at a type that no longer exists
rem
rem Runs as a DRY RUN by default and writes nothing. Read the report, then run
rem it again with --apply to commit. A timestamped backup copy of the database
rem is written before any change is made.
rem
rem To point at a database somewhere else, either pass --db "<path>" or set
rem RAG_DB_PATH before running.

cd /d "%~dp0.."

set "NODE_EXE=%CD%\node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

rem ---------------- Locate the database ----------------
rem These must match "Start AdvisePoint Docs.bat", which is what actually
rem creates the file. The shipped name is advisepoint.db.
if not defined LOCALAPPDATA set "LOCALAPPDATA=%APPDATA%"
set "DATA_DIR=%LOCALAPPDATA%\AdvisePoint Docs"

rem Did the caller already specify a database? If so, leave it to the script.
set "USER_DB="
for %%a in (%*) do (
  if /I "%%~a"=="--db" set "USER_DB=1"
)

if defined USER_DB goto :run

set "DB=%RAG_DB_PATH%"
if not defined DB set "DB=%DATA_DIR%\advisepoint.db"

if not exist "%DB%" (
  rem Fall back to the older development name, just in case.
  if exist "%DATA_DIR%\rag.db" set "DB=%DATA_DIR%\rag.db"
)

if not exist "%DB%" (
  echo.
  echo Could not find the AdvisePoint Docs database.
  echo.
  echo Looked for:
  echo    %DATA_DIR%\advisepoint.db
  echo    %DATA_DIR%\rag.db
  echo.
  if exist "%DATA_DIR%" (
    echo Files present in %DATA_DIR%:
    dir /b "%DATA_DIR%\*.db" 2>nul
    if errorlevel 1 echo    ^(no .db files^)
  ) else (
    echo That folder does not exist yet. Start AdvisePoint Docs once
    echo so the library is created, then run this again.
  )
  echo.
  echo If your library lives elsewhere, run:
  echo    "Align Document Types.bat" --db "D:\path\to\advisepoint.db"
  echo.
  pause
  exit /b 2
)

set "DB_ARG=--db "%DB%""
echo.
echo Database: %DB%

:run
echo.
echo IMPORTANT: close AdvisePoint Docs before continuing.
echo.
pause

"%NODE_EXE%" "%~dp0align-doc-types.cjs" %DB_ARG% %*

echo.
echo If the report above looks right, commit it with:
echo    "Align Document Types.bat" --apply
echo.
pause
