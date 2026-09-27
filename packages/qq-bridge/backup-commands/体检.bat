@echo off
rem Connectivity doctor (talks to SnowLuma, sends no messages, calls no model).
rem
rem MOVED in 0.2.4: this used to sit in the package root, next to the launchers.
rem It now lives in a subfolder because the console UI has the same button
rem (status bar -> "doctor" -> /api/doctor). See the readme in this folder.
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
call "%~dp0..\start.bat" --doctor
endlocal & exit /b %ERRORLEVEL%
