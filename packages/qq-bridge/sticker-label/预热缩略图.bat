@echo off
rem ============================================================================
rem  Sticker thumbnail warmer -- double-click this to preload the thumbnail cache.
rem
rem  Why it exists: thumbnails are not files on disk -- the server builds each one
rem  on demand by decoding a GIF and compositing its frames. A cold cache means
rem  the first look at a label can take a few seconds, which is hard to tell apart
rem  from "it is broken". Warming the whole library takes ~36s once; after that
rem  every label opens instantly (cache holds up to 600 entries).
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
echo   Warming the thumbnail cache (needs the labelling tool to be running).
echo.
"%NODE%" "%~dp0doctor.mjs" --warm
echo.
pause
