@echo off
rem ============================================================================
rem  Open the standalone desktop UI, RUNNING STRAIGHT FROM THIS SOURCE TREE.
rem
rem  No packing, no browser: it starts electron with desktop\ as the app, so you
rem  see the real window immediately after editing desktop\*.cjs. Data (config,
rem  workspace, logs) lands in THIS package root, which is what you want while
rem  developing.
rem
rem  How it relates to the other entries (names spelled in ASCII on purpose --
rem  this file must not contain non-ASCII; see the note at the bottom):
rem    this file            runs the shell from source (fast loop, dev)
rem    the packing .bat     builds the .exe from source
rem    the desktop .bat     runs the packaged .exe (release packages only)
rem
rem  THIS FILE MUST STAY PURE ASCII. cmd parses .bat with the system codepage
rem  (GBK on Chinese Windows) while the file is UTF-8, and Chinese bytes here
rem  are known to swallow line breaks and split if-blocks mid-token.
rem  Also: never write a redirection arrow in these comments -- cmd treats it
rem  as a real redirect and can TRUNCATE the named file to zero bytes (that
rem  really happened in 0.2.4; write "to" instead).
rem ============================================================================

setlocal
cd /d "%~dp0"

set "NODE=%~dp0vendor\node\node.exe"
if not exist "%NODE%" set "NODE=node"

if not exist "%~dp0desktop\node_modules\electron\dist\electron.exe" goto :needToolchain

echo Starting the desktop UI from source (close the window to end this)...
echo.
"%NODE%" "%~dp0desktop\node_modules\electron\cli.js" "%~dp0desktop"
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [!] electron exited with code %CODE%.
  echo     If the window never appeared, check logs\desktop.log
  echo     (and note: in a restricted sandbox electron itself may refuse to start).
  echo.
  pause
)
endlocal & exit /b %CODE%

:needToolchain
echo.
echo [!] The electron toolchain is missing, so the UI cannot start from source.
echo.
echo     ONE-TIME setup, two commands:
echo.
echo         cd desktop
echo         npm install --ignore-scripts
echo         node ..\scripts\fetch-electron.mjs
echo.
echo     (Alternatively: use a release package and double-click its desktop
echo      launcher .bat -- that one runs the packaged .exe and needs no
echo      toolchain here.)
echo.
pause
endlocal & exit /b 1
