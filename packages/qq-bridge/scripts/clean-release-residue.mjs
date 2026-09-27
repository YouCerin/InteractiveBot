/**
 * 清理 `_release/` 里的**残留目录**，只留下唯一那份当前发布包。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么会有"残留"（0.2.4 的事故复盘，写在这里而不是只写在文档里）
 * ══════════════════════════════════════════════════════════════════════════
 * 0.2.4 收尾时 `_release/` 下同时存在 **5 个** 0.2.4 目录（合计 928 MB），
 * 而它们**不是环境造成的**，是我几个选择叠出来的：
 *
 *   ① `assemble-release.mjs --force` 是"先删旧目录、再建新的"。Windows 上有进程/扫描器
 *      占着里面的 `default_app.asar` 时 `rmSync` 抛 EPERM —— **而已经删掉的那一半不会回来**。
 *      第一份 `InteractBot-0.2.4-win-x64` 就是这样被削成 134 个文件（正常 209，
 *      `app\` 整个没了）⇒ 它成了一"半份"，但目录还在，看起来仍像一份发布包。
 *   ② 删不掉就不能用同名重建（脚本拒绝覆盖），于是我为**绕开删除失败**造了个新名字 `-b`。
 *   ③ 后续几次组装失败又各留下一个空壳（`-r2` / `-r3`；只剩一个删不掉的文件）。
 *   ④ 又一次改名 → `-r4`（当前交付物）。
 *
 * ★★ 真正的教训（两条，都不是"环境不好"）：
 *   · **不要用"换个名字"来绕开"删不掉"** —— 那会把一次失败变成一串目录，
 *     而使用者**无从判断哪一份能跑**（这比"这次没组装成功"更坏）；
 *   · **失败要停在原地**：删不掉就报错退出，不要留下半份。这条**已经在 0.2.4 里修了**
 *     （`assemble-release.mjs` 现在先改名到 `.deleting-<时间戳>`、确认删得掉再删），
 *     所以这个脚本是在给**修复之前**留下的残局收尾。
 *
 * 用法：
 *   node scripts/clean-release-residue.mjs                 # 只报告，不删
 *   node scripts/clean-release-residue.mjs --apply         # 真删
 *   node scripts/clean-release-residue.mjs --keep <目录名> # 指定保留哪一个（默认自动挑最完整的）
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')
const RELEASE = join(REPO_ROOT, '_release')

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const keepArg = args.includes('--keep') ? args[args.indexOf('--keep') + 1] : null

/** 数一个目录里的文件数与字节数（顺带证明它读得动 = 没被锁死）。 */
function measure (dir) {
  let files = 0
  let bytes = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        files += 1
        try {
          bytes += statSync(p).size
        } catch {
          /* 读不到就当 0：锁住的文件不该让整个盘点失败 */
        }
      }
    }
  }
  try {
    walk(dir)
  } catch {
    return { files: -1, mb: 0, readable: false }
  }
  return { files, mb: bytes / 1024 / 1024, readable: true }
}

/**
 * "像不像一份能用的发布包"：exe + 启动器都在才算。
 */
function looksUsable (dir) {
  return existsSync(join(dir, 'app', 'InteractBot.exe')) && existsSync(join(dir, '桌面端bot启动.bat'))
}

/**
 * 候选的"新旧"判据：`app\InteractBot.exe` 的修改时间。
 * 为什么需要它：`-b` 与 `-r4` 都是 209 个文件，按**文件数**排序会平手，而平手时
 * 挑谁纯看排序稳定性 —— 第一版就这样挑中了 `-b`（启动器**旧版**）并准备删掉 `-r4`（新版）。
 * 内容对错不能靠运气 ⇒ 平手时比时间戳。
 */
function exeMtime (dir) {
  try {
    return statSync(join(dir, 'app', 'InteractBot.exe')).mtimeMs
  } catch {
    return 0
  }
}

if (!existsSync(RELEASE)) {
  console.log(`没有 ${relative(REPO_ROOT, RELEASE)}（没什么可清理的）`)
  process.exit(0)
}

const entries = readdirSync(RELEASE, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => {
    const full = join(RELEASE, e.name)
    const m = measure(full)
    return { name: e.name, full, ...m, usable: looksUsable(full) }
  })
  .sort((a, b) => b.files - a.files)

// ★★ 只动**当前版本**的衍生目录（`InteractBot-<version>-win-x64` 及其变体）。
//
// 为什么必须这么限定（第一版就写错了）：脚本原本打算删掉"所有不完整的目录"，
// 于是把 `InteractBot-0.1.0-win-x64` 与 `0.2.0` 也列进了清理名单 ——
// 而**老版本是要留着对照的**（这是本仓库的既定规则，`assemble-release.mjs` 里
// 还有一条"不许覆盖已存在版本目录"的门禁）。**清理"残留"绝不能顺手删掉历史版本。**
const pkgVersion = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version
const VERSION_PREFIX = `InteractBot-${pkgVersion}-win-x64`
const isCurrentVersionFamily = (name) => name.startsWith(VERSION_PREFIX)
const others = entries.filter((e) => !isCurrentVersionFamily(e.name))
const family = entries.filter((e) => isCurrentVersionFamily(e.name))

console.log(`\n_release/ 下共 ${entries.length} 个目录（当前版本 ${pkgVersion} 的衍生目录 ${family.length} 个）：\n`)
for (const e of entries) {
  const tag = !isCurrentVersionFamily(e.name)
    ? '📦 老版本（保留，不动）'
    : e.usable
      ? '✅ 可用'
      : '❌ 不完整/残留'
  console.log(
    `  ${e.name.padEnd(34)} ${String(e.files).padStart(5)} 文件 ${e.mb.toFixed(1).padStart(7)} MB  ${tag}`,
  )
}

// 保留谁（顺序很重要，第一版这里也错过一次：它按"字母序第一个可用的"挑，于是
// 挑中了 `-b`（旧启动器）而准备删掉 `-r4`（新启动器）—— 内容对但那是运气）：
//   ① 显式 `--keep <目录名>`；
//   ② **标准名且可用**（`InteractBot-<版本>-win-x64`）—— 真正该留下的那一个；
//   ③ 任何可用的（并明确提示"该把标准名腾出来给它"）；
//   ④ 兜底：家族里文件最多的那个（再平手比 exe 的时间戳）。
const exact = family.find((e) => e.name === VERSION_PREFIX && e.usable)
const anyUsable = family
  .filter((e) => e.usable)
  .sort((a, b) => b.files - a.files || exeMtime(b.full) - exeMtime(a.full))
const keep = keepArg
  ? entries.find((e) => e.name === keepArg)
  : exact ?? anyUsable[0] ?? family[0]

if (!keep) {
  console.log(`\n没有找到当前版本（${pkgVersion}）的目录 —— 没什么可清理的`)
  process.exit(0)
}

const drops = family.filter((e) => e.name !== keep.name)
console.log('')
console.log(`保留：${keep.name}（${keep.files} 文件 / ${keep.mb.toFixed(1)} MB${keep.usable ? '，可用' : '，⚠️ 但它也不完整'}）`)
for (const d of drops) console.log(`清理：${d.name}（${d.files} 文件 / ${d.mb.toFixed(1)} MB）`)
if (others.length) {
  console.log('')
  console.log(`📦 老版本一律不动（${others.map((o) => o.name).join('、')}）—— 它们是对照用的`)
}

// 保留了非标准名（比如 `-b` / `-r4`）时，**必须说清怎么归位** ——
// 否则 `_release/` 里最后留下的那一份名字是错的，下一个人还会再猜一次该用哪个。
if (keep.name !== VERSION_PREFIX) {
  const stale = family.find((e) => e.name === VERSION_PREFIX)
  console.log('')
  console.log(`⚠️ 保留的不是标准名（标准名是 ${VERSION_PREFIX}）。`)
  if (stale) {
    console.log(
      `   因为标准名那个目录现在**不完整**（${stale.files} 个文件）${stale.files > 0 ? '、而且大概删不掉（有进程占着 app\\ 里的文件）' : ''}。`,
    )
    console.log('   归位办法（重启后）：')
    console.log(`     1) 先确认标准名那份能删：Remove-Item -Recurse -Force _release\\${VERSION_PREFIX}`)
    console.log(`     2) 再把保留的这份改名：  Rename-Item _release\\${keep.name} ${VERSION_PREFIX}`)
  } else {
    console.log(`   建议把它改名成标准名：Rename-Item _release\\${keep.name} ${VERSION_PREFIX}`)
  }
}

const freedMb = drops.reduce((a, d) => a + d.mb, 0)
console.log('')
console.log(`将释放约 ${freedMb.toFixed(0)} MB`)

if (!APPLY) {
  console.log('')
  console.log('（这是**只报告**。要真删：node scripts/clean-release-residue.mjs --apply）')
  process.exit(0)
}

// ── 真删 ─────────────────────────────────────────────────────────────────────
console.log('')
let failed = 0
for (const d of drops) {
  try {
    rmSync(d.full, { recursive: true, force: true })
    console.log(`  ✅ 已删 ${d.name}`)
  } catch (error) {
    failed += 1
    console.log(
      `  ❌ 删不掉 ${d.name}（${error?.code ?? error?.message}）—— 有进程/扫描器占着里面的文件。\n` +
        '     ⇒ 重启一次再跑这个脚本，或者手工删。它不是本项目的问题（electron 产物常被 Defender/索引器占住）。',
    )
  }
}

// 给"删不掉的残留"放一张指路条：使用者看到一堆目录时，唯一需要知道的是"用哪一份"
if (failed > 0) {
  const note = [
    '================================================================',
    `  这个目录是**残留**（删不掉，多因有进程占着 app\\ 里的文件）`,
    '================================================================',
    '',
    `请用这一份：  ${keep.name}\\`,
    keep.usable ? '  （它含 app\\InteractBot.exe 与 桌面端bot启动.bat，是完整可用的那份）' : '  （⚠️ 请先人工确认它完整）',
    '',
    '清理办法：重启一次之后运行',
    '    node packages\\qq-bridge\\scripts\\clean-release-residue.mjs --apply',
    '或者手工删掉本目录。',
    '',
  ].join('\n')
  for (const d of drops) {
    if (!existsSync(d.full)) continue
    try {
      writeFileSync(join(d.full, '【残留-请用上面那一份】.txt'), note, 'utf8')
    } catch {
      /* 写不进去就算了：这只是给人看的 */
    }
  }
  console.log('')
  console.log(`（有 ${failed} 个删不掉 —— 已在里面放了一句话，说明该用哪一份）`)
}

console.log('')
console.log(failed === 0 ? '🎉 清理完成' : `⚠️ 有 ${failed} 个删不掉（重启后再试）`)
process.exit(failed === 0 ? 0 : 1)
