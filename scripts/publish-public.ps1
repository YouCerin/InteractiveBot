# Publish the (sanitised) public snapshot of this repository to GitHub.
#
# WHY a script instead of "just push": this repo has TWO git repositories.
#   * the DEV repo  (this working copy)  -- real history: real QQ numbers, real
#     e-mail, and the _release artifacts in old commits. NEVER push it.
#   * the PUBLIC repo (a rewritten clone under packages/qq-bridge/cache/) --
#     same content, but _release removed from all history and every real
#     identifier replaced by a placeholder. THAT is what goes to GitHub.
# So publishing is not "git push"; it is "rebuild the sanitised snapshot, verify
# it, then push". This script does exactly that, and refuses to push if any
# check fails.
#
# KEEP THIS FILE PURE ASCII. Windows PowerShell 5.1 reads .ps1 as ANSI (GBK on
# Chinese Windows) unless the file has a UTF-8 BOM, so UTF-8 Chinese text here
# turns into mojibake and can even swallow a quote (hit for real).
#
# Usage (from anywhere):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-public.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-public.ps1 -SkipPush   # dry run: rebuild + verify only
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-public.ps1 -RepoUrl https://github.com/you/repo.git
#
# Requires (all of them live in packages/qq-bridge/cache/, which is gitignored,
# i.e. they are the maintainer's local tools -- they contain the real-number
# mapping that must never be published):
#   scrub-ids.mjs  scrub-ids-tree.mjs  scrub-ids-stdin.mjs  rewrite-history.sh
# If they are missing, this script stops and says so (that is intentional: a
# fresh clone of the public repo cannot publish, only the maintainer's copy can).

param(
  [string]$RepoUrl = 'https://github.com/YouCerin/InteractiveBot.git',
  [string]$CommitEmail = '150148477+YouCerin@users.noreply.github.com',
  [string]$CloneDir = '',
  [switch]$SkipPush,
  [switch]$KeepClone
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "FAIL: $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host ""; Write-Host "== $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }

$repoRoot = Split-Path $PSScriptRoot -Parent
$tools = Join-Path $repoRoot 'packages\qq-bridge\cache'
if (-not $CloneDir) { $CloneDir = Join-Path $tools 'InteractiveBot-public' }

Step "0/5 preconditions"
foreach ($f in 'scrub-ids.mjs','scrub-ids-tree.mjs','scrub-ids-stdin.mjs','rewrite-history.sh') {
  if (-not (Test-Path (Join-Path $tools $f))) {
    Fail "missing local tool $tools\$f -- these are the maintainer's private tools (they hold the real-number mapping). A fresh clone cannot publish."
  }
}
Ok "local tools present"
$dirty = @(git -C $repoRoot status --short)
if ($dirty.Count -ne 0) { Fail "dev repo has uncommitted changes ($($dirty.Count) entries) -- commit first, otherwise the snapshot would silently miss them" }
Ok "dev repo clean"

# The dev repo and the public clone must have the same content; that equality is
# the strongest single check that the rewrite did not touch anything it should not.
$devTree = (git -C $repoRoot rev-parse 'HEAD^{tree}').Trim()
$devHead = (git -C $repoRoot rev-parse HEAD).Trim()

Step "1/5 rebuild the sanitised clone"
if (Test-Path $CloneDir) { Remove-Item $CloneDir -Recurse -Force }
$env:GIT_LFS_SKIP_SMUDGE = '1'
git clone --local --quiet $repoRoot $CloneDir
if ($LASTEXITCODE -ne 0) { Fail "git clone failed" }
Ok "cloned to $CloneDir"

$sh = Join-Path (Split-Path (Split-Path (Get-Command git).Source)) 'bin\sh.exe'
if (-not (Test-Path $sh)) { Fail "cannot find sh.exe next to git (looked at $sh)" }
$env:GIT_COMMIT_EMAIL = $CommitEmail
& $sh (Join-Path $tools 'rewrite-history.sh') ($CloneDir -replace '\\','/') `
  ((Join-Path $tools 'scrub-ids-tree.mjs') -replace '\\','/') `
  ((Join-Path $tools 'scrub-ids-stdin.mjs') -replace '\\','/') | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "history rewrite failed (see output above)" }
Ok "history rewritten (_release removed; identifiers scrubbed)"

Step "2/5 point origin at GitHub (a fresh clone already has origin = the dev repo)"
git -C $CloneDir remote set-url origin $RepoUrl
# Stale remote-tracking refs copied from the dev repo (backup branches) would show
# up as if they existed on GitHub. Drop them.
foreach ($r in @('refs/remotes/origin/backup/0.2.4','refs/remotes/origin/backup/0.2.5')) {
  git -C $CloneDir update-ref -d $r 2>$null | Out-Null
}
$pushUrl = (git -C $CloneDir remote get-url --push origin).Trim()
if ($pushUrl -ne $RepoUrl) { Fail "origin push URL is '$pushUrl', expected '$RepoUrl'" }
Ok "origin -> $pushUrl"

Step "3/5 verify (refuse to push if any check fails)"
$tree = (git -C $CloneDir rev-parse 'HEAD^{tree}').Trim()
if ($tree -ne $devTree) { Fail "HEAD tree differs: clone $tree vs dev $devTree -- the rewrite changed content it should not have" }
Ok "HEAD tree identical to the dev repo: $tree"

$keys = @(@(& node (Join-Path $tools 'scrub-ids.mjs') --keys) | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($keys.Count -eq 0) { Fail "could not read the private identifier list from scrub-ids.mjs --keys" }
$bad = @()
foreach ($k in $keys) {
  if (@(git -C $CloneDir log --all --oneline -S $k).Count -ne 0) { $bad += "content:$k" }
}
$logText = (git -C $CloneDir log --all --format='%s%n%b') -join "`n"
$mailText = (git -C $CloneDir log --all --format='%ae%n%ce') -join "`n"
foreach ($k in $keys) {
  if ($logText -match [regex]::Escape($k)) { $bad += "commit-message:$k" }
  if ($mailText -match [regex]::Escape($k)) { $bad += "metadata:$k" }
}
if ($bad.Count -ne 0) { Fail "identifiers still present -> $($bad -join ', ')" }
Ok "identifiers: content / commit messages / commit metadata all clean ($($keys.Count) patterns checked)"

if (@(git -C $CloneDir log --all --oneline -- _release).Count -ne 0) { Fail "_release still present in history" }
if (@(git -C $CloneDir ls-files | Where-Object { $_ -match '\.lnk$' }).Count -ne 0) { Fail ".lnk files are tracked (they carry absolute paths incl. the user's home dir)" }
Ok "_release: 0 commits; tracked .lnk: 0"

# NOTE: wrap the WHOLE pipeline in @(...). Writing `@(git ...) | ForEach-Object ...`
# makes PowerShell unwrap a single-element result into a scalar, so `$authors[0]`
# becomes the first CHARACTER of the string ('1') and the check reports a mismatch
# while printing the very value it expected (hit for real on the first run).
$authors = @(@(git -C $CloneDir log --format='%ae') | ForEach-Object { $_.Trim() } | Sort-Object -Unique)
if ($authors.Count -ne 1 -or $authors[0] -ne $CommitEmail) { Fail "unexpected author email(s): $($authors -join ', ')" }
Ok "author email: $($authors[0])"

# The sanitised scanner walks the working tree; running it inside the clone is the
# cheapest end-to-end check that no file in the snapshot carries a real number.
# Use its ASCII JSON mode (this script is pure ASCII and must not match Chinese text).
Push-Location $CloneDir
$scanJson = & node (Join-Path $tools 'scrub-ids.mjs') --json | Out-String
Pop-Location
try { $scan = $scanJson | ConvertFrom-Json } catch { Fail "scanner did not return JSON: $scanJson" }
if ($scan.hits -ne 0) { Fail "working-tree scan found $($scan.hits) hit(s): $($scanJson)" }
Ok "working-tree scan: $($scan.scanned) files, 0 hits (skipped $($scan.skippedRuntime) runtime config file(s) on purpose)"

Step "4/5 push"
$cloneHead = (git -C $CloneDir rev-parse HEAD).Trim()
if ($SkipPush) {
  Ok "-SkipPush given; nothing pushed. Snapshot is at $CloneDir (HEAD $cloneHead)"
} else {
  $env:GIT_TERMINAL_PROMPT = '0'
  $env:GCM_INTERACTIVE = 'never'
  Write-Host "  dev HEAD  $devHead"
  Write-Host "  clone HEAD $cloneHead"
  git -C $CloneDir push origin main
  if ($LASTEXITCODE -ne 0) {
    Fail "push rejected. If the remote already has a DIFFERENT rewrite of this history, re-run with -Force-ish approval: git -C '$CloneDir' push --force-with-lease origin main (safe as long as nobody else works on the repo)"
  }
  Ok "pushed main"
  $remote = (git -C $CloneDir ls-remote origin refs/heads/main) -split '\s+' | Select-Object -First 1
  if ($remote.Trim() -ne $cloneHead) { Fail "remote main is $remote but local is $cloneHead -- push did not land" }
  Ok "verified remote main == $cloneHead"
  Write-Host "  tags were NOT pushed on purpose (old tags stay local; create the release tag when making a Release)"
}

Step "5/5 done"
if ($SkipPush -and -not $KeepClone) { Write-Host "  (dry run left the clone in place: $CloneDir)" }
Write-Host "  next: create the GitHub Release (tag v<version>) and attach _release\InteractiveBot-<version>-win-x64.zip" -ForegroundColor Yellow
Write-Host "  NOTE: the release asset upload has its own gotchas -- see docs/opensource notes; the 25 MB browser limit is NOT the Release limit (2 GB)." -ForegroundColor Yellow
