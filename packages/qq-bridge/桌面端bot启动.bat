@echo off
rem ============================================================================
rem  Desktop bot launcher  (Chinese-named entry: double-click this one)
rem
rem  What it does: starts the desktop app (app\InteractBot.exe) -- a REAL window
rem  with a tray icon, no browser involved. The app itself then starts the bridge
rem  (and SnowLuma when needed); closing the window only hides it to the tray, so
rem  the bot keeps running.
rem
rem  How it differs from the all-purpose launcher (the other Chinese-named .bat):
rem    that one also dispatches --check / --doctor / --foreground / --no-browser /
rem    --no-snowluma to start.bat, and falls back to the browser console when the
rem    desktop app is missing. This file has ONE job: open the desktop window.
rem    It still verifies the exe exists first, because silently doing nothing is
rem    the one failure mode this project refuses (you would just see a flash).
rem
rem  THIS FILE MUST STAY PURE ASCII. cmd parses .bat with the system codepage
rem  (GBK on Chinese Windows) while the file is UTF-8; Chinese bytes here are
rem  known to swallow line breaks and split the if-block mid-token, producing a
rem    dozen "is not recognized as an internal or external command" lines while
rem    the real command never runs. mocks/verify-text-encoding.mjs enforces this.
rem
rem  Also: never write a bare ">" in these comments. It is a REDIRECTION to cmd,
rem  so a comment like "  foo.lnk -> bar.bat" makes cmd try to run "foo.lnk" and
rem  TRUNCATE bar.bat to zero bytes. That really happened (0.2.4): it emptied this
rem  very file and the all-purpose launcher. (Found by a test, not by luck.)
rem ============================================================================

setlocal
cd /d "%~dp0"

if not exist "%~dp0app\InteractBot.exe" goto :missing

rem Tell the app where the package root is. The electron runtime sits in app\,
rem so the app cannot tell "app\" from "the package root" by looking at its own
rem folder -- and with asar:false Electron's app.isPackaged is FALSE, so that
rem cannot be used either. This launcher knows the answer (it lives in the root).
set "INTERACTBOT_PKG_ROOT=%~dp0"
rem %~dp0 ends with a backslash; drop it so logs and path comparisons agree.
if "%INTERACTBOT_PKG_ROOT:~-1%"=="\" set "INTERACTBOT_PKG_ROOT=%INTERACTBOT_PKG_ROOT:~0,-1%"

echo Starting InteractBot desktop console...
start "" "%~dp0app\InteractBot.exe"
endlocal & exit /b 0

:missing
echo.
echo [!] app\InteractBot.exe not found -- this package has no desktop app.
echo.
echo     Use start.bat instead: it starts the bridge in the background
echo     and opens the console in your browser.
echo.
pause
endlocal & exit /b 1
