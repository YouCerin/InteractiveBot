@echo off
rem ============================================================================
rem  Forwarder: electron-builder asks for "npm"; this shim answers with an empty
rem  dependency tree (the desktop shell has ZERO runtime dependencies).
rem
rem  WHY this file exists (full explanation in npm-stub.mjs, read that first):
rem  this machine's sandbox forbids capturing another program's output over a
rem  pipe, and electron-builder's dependency collector always pipes the package
rem  manager it spawns -> "spawn EPERM" -> the whole build fails. The shim makes
rem  that collector return an empty tree so it falls back to its pure file
rem  traversal path (which finds nothing to copy, correctly).
rem
rem  IMPORTANT: this file MUST stay PURE ASCII. cmd parses .cmd using the system
rem  codepage (GBK on Chinese Windows); UTF-8 Chinese comments here are known to
rem  swallow line breaks and produce "not recognized as an internal or external
rem  command" errors (this repository learned that the hard way, twice).
rem ============================================================================

setlocal
set "STUB=%~dp0npm-stub.mjs"

set "NODE=%~dp0..\..\vendor\node\node.exe"
if exist "%NODE%" (
  "%NODE%" "%STUB%" %*
  endlocal & exit /b %ERRORLEVEL%
)

node "%STUB%" %*
endlocal & exit /b %ERRORLEVEL%
