@echo off
rem Config self-check (no network, no cost)  (body intentionally pure ASCII -- see the note in start.bat)
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0start.bat" --check