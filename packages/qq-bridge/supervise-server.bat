@echo off
rem ============================================================================
rem  InteractiveBot - server supervisor helper  (0.3.2 P4)
rem
rem  Why this file exists: `--supervise start` launches the Minecraft server as
rem  a DETACHED child of the node process running it. Some environments reap a
rem  command's whole process tree when that command ends -- a coding-agent
rem  sandbox does exactly that (measured: the server reached "Starting
rem  Minecraft server on *:25565" and was then killed with NO shutdown line in
rem  its log). In YOUR OWN terminal the detached child survives, which is the
rem  case this file is for.
rem
rem  So: run this from a normal terminal (or double-click it). Do NOT expect a
rem  server started from inside an agent/sandbox session to stay up.
rem
rem  NOTE: this file must stay **pure ASCII**, same reason as start.bat --
rem  cmd parses .bat with the system codepage (GBK on Chinese Windows) and
rem  UTF-8 comments can swallow line breaks.
rem
rem  Usage:  supervise-server.bat start | stop | status
rem          supervise-server.bat start --id forge1 --wait 300
rem ============================================================================

setlocal
cd /d "%~dp0"

set "NODE=%~dp0vendor\node\node.exe"
if not exist "%NODE%" set "NODE=node"

if "%~1"=="" (
  echo.
  echo   Usage: supervise-server.bat start ^| stop ^| status
  echo          supervise-server.bat start --id ^<server^> --wait ^<seconds^>
  echo.
  echo   start   - launch it and WAIT until the port is really open
  echo   stop    - ask it to shut down gracefully over RCON
  echo   status  - is it running, and did WE start it?
  echo.
  pause
  exit /b 2
)

"%NODE%" "%~dp0src\index.mjs" --supervise %*

echo.
echo   --- done (exit code %ERRORLEVEL%) ---
pause
