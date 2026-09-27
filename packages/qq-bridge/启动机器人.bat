@echo off
rem ============================================================================
rem  Chinese-named entry point (the one users double-click).
rem
rem  Body stays PURE ASCII on purpose: cmd parses .bat files with the system
rem  codepage (GBK on Chinese Windows) while this file is UTF-8, and UTF-8
rem  Chinese comments are known to swallow line breaks here.
rem
rem  0.2.4: the real launcher is now the desktop app (app\InteractBot.exe).
rem  It opens a REAL WINDOW (no browser), starts the bridge (and SnowLuma when
rem  needed), and keeps the bot online when the window is closed (it goes to the
rem  tray). This file only dispatches:
rem
rem    app\InteractBot.exe exists  -> start it (it owns the whole boot order)
rem    it does not exist           -> fall back to start.bat (old behaviour:
rem                                   background bridge + console in a browser)
rem
rem  The fallback is deliberate: a package built without the desktop shell must
rem  still work -- it just must not pretend to be the new thing.
rem ============================================================================

setlocal
cd /d "%~dp0"

if exist "%~dp0app\InteractBot.exe" goto :desktop

echo [!] app\InteractBot.exe not found -- falling back to the old launcher (browser console).
echo     If this package was meant to include the desktop app, it is incomplete.
echo.
call "%~dp0start.bat" %*
endlocal & exit /b %ERRORLEVEL%

:desktop
rem Options that only start.bat knows how to handle are handed over: silently
rem ignoring a flag the user typed is exactly the "said but did not do" failure
rem this project avoids. Plain double-click (no arguments) goes to the app.
if "%~1"=="" goto :launch
if /i "%~1"=="--check"       goto :delegate
if /i "%~1"=="--doctor"      goto :delegate
if /i "%~1"=="--setup"       goto :delegate
if /i "%~1"=="--foreground"  goto :delegate
if /i "%~1"=="--no-browser"  goto :delegate
if /i "%~1"=="--no-snowluma" goto :delegate
echo [!] Unknown option: %1 -- handing it to start.bat.
echo.
goto :delegate

:launch
start "" "%~dp0app\InteractBot.exe"
endlocal & exit /b 0

:delegate
call "%~dp0start.bat" %*
endlocal & exit /b %ERRORLEVEL%
