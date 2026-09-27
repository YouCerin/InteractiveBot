@echo off
rem ============================================================================
rem  Build the desktop app (.exe) FROM THIS SOURCE TREE.
rem
rem  What it produces:
rem    .build-desktop\pack-<timestamp>\win-unpacked\  -- the portable desktop app
rem    .build-desktop\latest.json                     -- which build is the newest
rem  Then scripts/assemble-release.mjs flattens that into _release\<pkg>\app\.
rem
rem  Why this file exists: the build used to require knowing three commands in
rem  the right order (npm install --ignore-scripts, fetch-electron.mjs,
rem  assemble-desktop.mjs) and that NOBODY HAD WRITTEN DOWN anywhere. Now it is
rem  a double-click.
rem
rem  THIS FILE MUST STAY PURE ASCII. cmd parses .bat with the system codepage
rem  (GBK on Chinese Windows) while the file is UTF-8; Chinese bytes here are
rem  known to swallow line breaks and split if-blocks mid-token.
rem  Also: never write a bare ">" in these comments -- it is a REDIRECTION to
rem  cmd and "foo -> bar" truncates bar to zero bytes (that really happened).
rem ============================================================================

setlocal
cd /d "%~dp0"

set "NODE=%~dp0vendor\node\node.exe"
if not exist "%NODE%" set "NODE=node"

rem ---- 1) toolchain (one-time; ~72 MB + the electron runtime) ----------------
if not exist "%~dp0desktop\node_modules\electron\dist\electron.exe" goto :needToolchain

rem ---- 2) build -------------------------------------------------------------
echo Building the desktop app from source...
echo.
"%NODE%" "%~dp0scripts\assemble-desktop.mjs"
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" goto :failed

echo.
echo Done. The build is in .build-desktop\
echo   Want a ready-to-share package? Run: node scripts\assemble-release.mjs
echo   Want to look at the window first? Double-click the "open desktop UI" .bat
echo.
pause
endlocal & exit /b 0

:needToolchain
echo.
echo [!] The electron toolchain is missing (desktop\node_modules\electron\dist\electron.exe).
echo.
echo     ONE-TIME setup, two commands:
echo.
echo         cd desktop
echo         npm install --ignore-scripts
echo         node ..\scripts\fetch-electron.mjs
echo.
echo     Why --ignore-scripts: electron-winstaller's postinstall fails in this
echo     environment and npm then ROLLS BACK the whole node_modules.
echo     Why fetch-electron separately: the electron package's own postinstall
echo     downloads from github.com, which this machine cannot reach.
echo.
pause
endlocal & exit /b 1

:failed
echo.
echo [!] Build failed (exit %CODE%) -- see the output above.
echo     Common causes: no electron runtime yet (see the message above),
echo     or electron-builder's patch no longer applies (it says so explicitly).
echo.
pause
endlocal & exit /b %CODE%
