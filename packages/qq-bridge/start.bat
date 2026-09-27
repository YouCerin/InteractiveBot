@echo off
rem ============================================================================
rem  QQ bridge launcher
rem
rem  Why this file exists: double-click to run, with **no dependency on a
rem  system-installed Node**. It prefers the bundled vendor\node\node.exe
rem  and falls back to the system "node" only if that is missing.
rem
rem  NOTE: this file must stay **pure ASCII**. cmd parses .bat files using
rem  the system codepage (GBK on Chinese Windows); UTF-8 Chinese comments
rem  can swallow line breaks and corrupt parsing (learned the hard way).
rem ============================================================================

setlocal
cd /d "%~dp0"

set "NODE=%~dp0vendor\node\node.exe"
if not exist "%NODE%" (
  echo [!] vendor\node\node.exe not found, falling back to system node.
  set "NODE=node"
)

if "%~1"=="--check" (
  "%NODE%" "%~dp0src\index.mjs" --check
  goto :end
)

if "%~1"=="--doctor" (
  "%NODE%" "%~dp0src\index.mjs" --doctor
  goto :end
)

if "%~1"=="--setup" (
  "%NODE%" "%~dp0setup.mjs"
  goto :end
)

if "%~1"=="--snowluma" (
  "%NODE%" "%~dp0src\index.mjs" --snowluma
  goto :end
)

if "%~1"=="--open-console" (
  "%NODE%" "%~dp0src\index.mjs" --open-console
  goto :end
)

rem --- SnowLuma (QQ protocol endpoint) ----------------------------------------
rem  Start it BEFORE the bridge: the bridge connects to its OneBot endpoint
rem  during startup, and a bridge that cannot connect looks "up" but replies
rem  to nobody.
rem
rem  IMPORTANT: the "where is SnowLuma installed" rule lives in
rem  src/local.mjs (findSnowluma) and is invoked here ON PURPOSE -- so there is
rem  exactly ONE copy of it. Re-implementing that search in batch is how you end
rem  up starting the WRONG installation (there really are two on this machine).
rem
rem  Skipping is safe: an already-running instance is detected and not started
rem  twice (a second one would fight over port 3000 and the QQ login session).
if /i not "%~1"=="--no-snowluma" (
  echo Starting SnowLuma...
  "%NODE%" "%~dp0src\index.mjs" --snowluma
  echo.
)

rem Open the SnowLuma web console (best effort; ignore failures silently).
rem
rem IMPORTANT: --wait-snowluma is passed ONLY on the branch that just started
rem SnowLuma. Why: the browser used to be opened immediately after the spawn, so
rem the page you got was SnowLuma MID-BOOT (not logged in / empty lists) and you
rem had to press F5 before it showed the real state. With --wait-snowluma the
rem launcher waits (up to 60s, polling once a second) for the moment OneBot really
rem answers get_login_info with a user_id -- the moment the page will come up
rem already logged in. It returns early when the token is rejected (waiting cannot
rem help that) and prints progress, so it never looks frozen.
rem Skip with: start.bat --no-browser
if /i not "%~1"=="--no-browser" (
  if /i "%~1"=="--no-snowluma" (
    "%NODE%" "%~dp0src\index.mjs" --open-console >nul 2>nul
  ) else (
    "%NODE%" "%~dp0src\index.mjs" --open-console --wait-snowluma
  )
)

rem Open the console UI in the default browser once the config API is up.
rem curl itself does the waiting: retries on connection-refused for ~2 min,
rem and only on success does the browser open. Skip with: start.bat --no-browser
rem Note: if you changed ui.apiPort in config.json, change 3410 below too.
if /i not "%~1"=="--no-browser" (
  start "" /min cmd /c "curl -s -o nul -m 2 --retry 59 --retry-delay 2 --retry-connrefused http://127.0.0.1:3410/api/status && start http://127.0.0.1:3410/"
)

echo Starting QQ bridge...
rem NOTE: %* is deliberately NOT forwarded. These scripts are launchers and the
rem only flags they take (--check/--doctor/--setup/--no-browser/--no-snowluma)
rem all return before this line -- forwarding them would be a footgun, because
rem src/index.mjs treats --snowluma / --open-console as "do that and exit",
rem which would silently skip starting the bridge.
"%NODE%" "%~dp0src\index.mjs"
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo.
  echo [!] Bridge exited with code %EXITCODE%.
)

:end
echo.
pause
endlocal
