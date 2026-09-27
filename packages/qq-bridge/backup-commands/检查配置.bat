@echo off
rem Config self-check (no network, no cost).
rem
rem MOVED in 0.2.4: this used to sit in the package root, next to the launchers.
rem It now lives in a subfolder because the console UI has the same button
rem (Overview -> "check config" -> /api/check). See the readme in this folder.
rem
rem THIS FILE MUST STAY PURE ASCII. cmd parses .bat with the system codepage
rem (GBK on Chinese Windows) while the file is UTF-8; Chinese comments here are
rem known to swallow line breaks and produce
rem   'em' is not recognized as an internal or external command
rem (this repository has now hit that trap three times -- the third time was
rem when this very file was written).
rem
rem NOTE the "..\": start.bat is in the PARENT folder. The old version called
rem "%~dp0start.bat" -- after the move that would look for
rem   ...\BakCmds\start.bat  and fail. That break would only show up when
rem someone actually NEEDS this tool (i.e. when the UI will not open).
setlocal
call "%~dp0..\start.bat" --check
endlocal & exit /b %ERRORLEVEL%
