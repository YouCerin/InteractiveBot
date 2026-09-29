@echo off
rem ============================================================================
rem  Sticker labelling tool launcher (manual semantic annotation).
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
echo   Starting the sticker labelling tool (standalone, not part of the console).
echo   Close this window to stop it.
echo.

"%NODE%" "%~dp0server.mjs" --open
pause
