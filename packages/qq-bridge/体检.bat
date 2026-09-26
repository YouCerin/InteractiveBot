@echo off
rem Connectivity doctor (talks to SnowLuma, costs nothing)  (body intentionally pure ASCII -- see the note in start.bat)
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0start.bat" --doctor