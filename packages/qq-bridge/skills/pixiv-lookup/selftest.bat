@echo off
rem pixiv-lookup self-test (ASCII-only: cmd parses .bat as GBK on Chinese Windows)
rem NOTE: this .bat filename is intentionally ASCII. The Chinese-named launcher
rem (run-selftest-cn.bat) is a thin wrapper for people who want the Chinese name.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0selftest.ps1"
echo.
pause
