@echo off
rem ============================================================================
rem  Chat-log review tool launcher (manual scoring of past bot replies).
rem
rem  NOTE: this file must stay **pure ASCII** -- cmd parses .bat with the system
rem  codepage (GBK on Chinese Windows), and UTF-8 Chinese text can swallow line
rem  breaks and corrupt parsing (learned the hard way, see start.bat).
rem ============================================================================

setlocal
cd /d "%~dp0.."

set "NODE=%~dp0..\vendor\node\node.exe"
if not exist "%NODE%" (
  echo [!] vendor\node\node.exe not found, falling back to system node.
  set "NODE=node"
)

echo.
echo   Starting the chat-log review tool (standalone, not part of the console).
echo   It reads the local corpus read-only and writes review data only.
echo   If another copy is already running on this port, it will be asked to
echo   exit first and this one takes over (no need to close it by hand).
echo   Close this window to stop it.
echo.

"%NODE%" "%~dp0server.mjs" --open
pause
