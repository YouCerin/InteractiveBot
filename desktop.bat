@echo off
rem ============================================================================
rem  InteractBot - open the DESKTOP WINDOW from source (developer entry).
rem
rem  Double-click this file. It runs the Electron shell in
rem  packages\qq-bridge\desktop\ ; data lands in the source-side package root
rem  (packages\qq-bridge), and it connects to the bridge already running on
rem  127.0.0.1:3410 -- or starts one if none is running.
rem
rem  Why this file exists: `npm run desktop` needs a terminal, a cd, and a
rem  working npm. A double-click skips all three (and it uses the Node runtime
rem  bundled in packages\qq-bridge\vendor\node, so no PATH setup is needed).
rem
rem  It does NOT package anything: for the .exe use `npm run desktop:pack`.
rem
rem  WARNING: keep this FILE pure ASCII, comments included. cmd parses .bat
rem  using the system codepage (GBK on Chinese Windows); UTF-8 Chinese in a
rem  comment is known to swallow line breaks and split the script mid-token.
rem  WARNING 2: never put a bare greater-than sign in a rem line -- cmd parses
rem  redirection BEFORE rem, so such a line overwrites or truncates a file.
rem  (mocks/verify-text-encoding.mjs enforces both rules.)
rem ============================================================================

setlocal
cd /d "%~dp0"

set "NODE=%~dp0packages\qq-bridge\vendor\node\node.exe"
if not exist "%NODE%" (
  echo [!] Bundled Node not found -- falling back to the system "node".
  echo     To restore it: cd packages\qq-bridge ^&^& node setup.mjs
  set "NODE=node"
)

"%NODE%" "%~dp0packages\qq-bridge\scripts\run-desktop.mjs"
set "CODE=%ERRORLEVEL%"

if not "%CODE%"=="0" (
  echo.
  echo [!] The desktop window exited with code %CODE% -- see the message above.
  echo     Most common cause: the Electron toolchain is not installed yet.
  echo     Run these two once, then double-click this file again:
  echo         cd packages\qq-bridge\desktop ^&^& npm install --ignore-scripts
  echo         cd packages\qq-bridge ^&^& npm run desktop:fetch
  echo.
  pause
)

endlocal & exit /b %CODE%
