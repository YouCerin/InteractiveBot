@echo off
rem Chinese-named entry point. The body stays PURE ASCII on purpose:
rem cmd parses .bat files with the system codepage (GBK on Chinese Windows),
rem while this file is UTF-8. chcp 65001 makes the *output* readable, and the
rem actual work is delegated to start.bat -- so there is exactly one place
rem that knows how to boot the bridge.
chcp 65001 >nul
cd /d "%~dp0"
call "%~dp0start.bat" %*