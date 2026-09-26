# pixiv-lookup self-test runner (Windows)
#
# ============================================================================
# KEEP THIS FILE PURE ASCII. NO Chinese characters, not even in comments.
# Windows PowerShell 5.1 reads .ps1 as ANSI/GBK unless a UTF-8 BOM is present,
# so any non-ASCII byte becomes mojibake and breaks the parser with misleading
# errors like "The string is missing the terminator" or "Unexpected token '}'".
# This bit us three times while writing this file. Same lesson as the QQ Agent
# launcher's launch.ps1.
# ============================================================================
#
# Three real traps this script works around (all observed, not theoretical):
#
#  1) QQ Agent is an ESM project ("type":"module" in its package.json), but a
#     skill directory has no package.json of its own, so running index.js
#     directly makes Node treat it as CommonJS and fail with
#     "Cannot use import statement outside a module".
#     -> Stage a copy in a writable temp dir with a minimal {"type":"module"}.
#
#  2) The Windows profile path can contain an apostrophe (C:\Users\mu'geng\...).
#     Such a path passed as a command-line argument to electron.exe gets
#     truncated by native argument quoting, and Node reports
#     "Cannot find module 'C:\Users\mu'".
#     -> Only stage into a directory whose path has no quote character.
#
#  3) PowerShell's Set-Location does NOT change a native child process's working
#     directory, so a launcher that used process.cwd() looked in the wrong place
#     (ERR_MODULE_NOT_FOUND .../test/run-tests.mjs).
#     -> The staged launcher resolves paths from import.meta.url instead.
#
# The script is READ-ONLY with respect to the skill directory.

$ErrorActionPreference = 'Stop'

$skillDir = $PSScriptRoot
$qqAgent = Split-Path -Parent (Split-Path -Parent $skillDir)   # <QQ Agent>\skills\<id> -> <QQ Agent>
$electron = Join-Path $qqAgent 'node_modules\electron\dist\electron.exe'

if (-not (Test-Path -LiteralPath $electron)) {
  Write-Host '[ERROR] Could not find Electron next to this skill.' -ForegroundColor Red
  Write-Host "  looked for : $electron" -ForegroundColor Red
  Write-Host "  skill dir  : $skillDir" -ForegroundColor Yellow
  Write-Host '  Fix: run this from inside <QQ Agent>\skills\pixiv-lookup\.' -ForegroundColor Yellow
  exit 1
}

# Pick a staging parent that (a) is writable and (b) has no quote in its path.
$stageParent = $null
foreach ($cand in @($env:TEMP, $qqAgent, $skillDir)) {
  if (-not $cand) { continue }
  if ($cand -match "'") { continue }
  try {
    $probe = Join-Path $cand ('.pixivwrite-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
    New-Item -ItemType Directory -Path $probe -Force | Out-Null
    Set-Content -Path (Join-Path $probe 'probe.txt') -Value 'ok' -Encoding ascii
    Remove-Item $probe -Recurse -Force -ErrorAction SilentlyContinue
    $stageParent = $cand
    break
  } catch {
    # try the next candidate
  }
}
if (-not $stageParent) {
  Write-Host '[ERROR] No writable temp location found (tried %TEMP%, the QQ Agent folder,' -ForegroundColor Red
  Write-Host '        and the skill folder).' -ForegroundColor Red
  exit 1
}

$stage = Join-Path $stageParent ('.pixiv-lookup-selftest-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
Write-Host "temp dir : $stage"
Write-Host "electron : $electron"
if ($env:PIXIV_SELFTEST_DEBUG) {
  Write-Host "stageParent = $stageParent"
  Write-Host "TEMP = $env:TEMP"
  Write-Host "PSScriptRoot = $PSScriptRoot"
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null

Copy-Item (Join-Path $skillDir 'index.js') $stage -Force
Copy-Item (Join-Path $skillDir 'skill.json') $stage -Force
Copy-Item (Join-Path $skillDir 'test') (Join-Path $stage 'test') -Recurse -Force
Set-Content -Path (Join-Path $stage 'package.json') -Value '{ "type": "module" }' -Encoding utf8

# Tiny launcher written INTO the staging dir. Paths come from import.meta.url
# (see trap 3) and it writes result.json, which is the authoritative pass/fail
# signal: $LASTEXITCODE came back EMPTY in one environment even for a successful
# run, so an empty exit code must not be read as success. A file that only
# appears when the runner reached the end cannot lie.
$launcher = @'
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "result.json");
try {
  const t = await import(pathToFileURL(path.join(here, "test", "run-tests.mjs")).href);
  const r = await t.runTests(path.join(here, "index.js"));
  fs.writeFileSync(out, JSON.stringify({ finished: true, passed: r.passed, failed: r.failed, failures: r.failures }), "utf8");
  process.exit(r.failed ? 1 : 0);
} catch (e) {
  fs.writeFileSync(out, JSON.stringify({ finished: false, error: String((e && e.message) || e) }), "utf8");
  console.error(e);
  process.exit(1);
}
'@
Set-Content -Path (Join-Path $stage 'run.mjs') -Value $launcher -Encoding utf8

# Verify the staging actually landed. Without this, a partially-created stage
# produces a confusing "Cannot find module ...run.mjs" from Node instead of a
# clear message about which directory could not be written.
$needed = @('index.js', 'skill.json', 'package.json', 'run.mjs', 'test\run-tests.mjs')
foreach ($need in $needed) {
  if (-not (Test-Path -LiteralPath (Join-Path $stage $need))) {
    Write-Host "[ERROR] Failed to stage the self-test into: $stage" -ForegroundColor Red
    Write-Host "        missing: $need" -ForegroundColor Red
    Write-Host '        The folder is not writable. Run this from an account that can' -ForegroundColor Yellow
    Write-Host '        write to %TEMP%, or copy the plugin somewhere writable first.' -ForegroundColor Yellow
    Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
  }
}

# No output redirection on purpose: Electron/Chromium prints lines like
# "registration_protocol_win.cc ... CreateFile: access denied (0x5)" to stderr
# in some environments, and with `*>&1` PowerShell turns that into a terminating
# NativeCommandError before the runner ever executes.
$resultFile = Join-Path $stage 'result.json'
$exit = $null
# Debug aid: PIXIV_SELFTEST_DEBUG=1 lists everything in the stage right before
# Electron starts, and keeps the stage around afterwards for inspection.
if ($env:PIXIV_SELFTEST_DEBUG) {
  Write-Host '--- stage listing (debug) ---'
  Get-ChildItem $stage -Recurse -File | ForEach-Object {
    Write-Host ("    {0}  {1} bytes" -f $_.FullName.Substring($stage.Length + 1), $_.Length)
  }
  Write-Host '-----------------------------'
}
try {
  # ELECTRON_RUN_AS_NODE makes electron.exe behave as a plain Node runtime, so
  # this works on a machine with no Node.js installed.
  $env:ELECTRON_RUN_AS_NODE = '1'
  # Absolute path is safe here: the staging parent has no quote in its path.
  & $electron (Join-Path $stage 'run.mjs')
  $exit = $LASTEXITCODE
} catch {
  Write-Host "[ERROR] self-test runner failed to start: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}

$code = 1
# Wait briefly for result.json: Electron's process may report exit slightly
# before the child's file write becomes visible to this process (observed - the
# runner had genuinely finished with all checks passed while an immediate Test-Path
# still said "missing"). A short poll removes that race without hiding a real
# failure: if the runner never finishes, the file never appears.
$deadline = (Get-Date).AddSeconds(15)
while (-not (Test-Path -LiteralPath $resultFile) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 300
}
if (-not (Test-Path -LiteralPath $resultFile)) {
  Write-Host ''
  Write-Host '[FAIL] the self-test did not complete (nothing was written to result.json).' -ForegroundColor Red
  Write-Host '       Node could not run the staged runner - see the errors above.' -ForegroundColor Yellow
} else {
  $result = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
  if ($result.finished -eq $true) {
    Write-Host ''
    Write-Host ("     passed: {0}   failed: {1}" -f $result.passed, $result.failed)
    if ([int]$result.failed -eq 0) { $code = 0 } else { $code = 1 }
  } else {
    Write-Host ''
    Write-Host "[FAIL] the self-test crashed: $($result.error)" -ForegroundColor Red
  }
  # Cross-check the child's exit code. If the two disagree, report failure:
  # better to over-report a failure than to claim success wrongly.
  if ($exit -ne $null -and [int]$exit -ne $code) {
    Write-Host ("     note: exit code {0} disagrees with result.json; treating as failure." -f $exit) -ForegroundColor Yellow
    $code = 1
  }
}

if ($env:PIXIV_SELFTEST_DEBUG) {
  Write-Host "kept stage for inspection: $stage"
} else {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}

if ($code -eq 0) {
  Write-Host ''
  Write-Host '[PASS] all self-test checks passed.' -ForegroundColor Green
} else {
  Write-Host ''
  Write-Host '[FAIL] some self-test checks failed - see output above.' -ForegroundColor Red
}
exit $code
