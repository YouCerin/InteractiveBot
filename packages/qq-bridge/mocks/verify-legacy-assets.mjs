#!/usr/bin/env node
/**
 * ★★ 旧资产守卫（0.2.5）：**被有意删掉的东西，不许自己长回来。**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（这次是真踩过，不是假想）
 * ══════════════════════════════════════════════════════════════════════════
 * 0.2.5 的目标是清理旧版本留下的无用资产：删除 `packages/dsh-qq-bot（废弃）`
 * 与 qq-bridge 包根下的四个中文名入口 + 一份小白文档
 * （启动机器人.bat / 检查配置.bat / 体检.bat / 创建带图标的快捷方式.bat / 先读我-首次使用.txt）。
 *
 * ★ 难点**不在删，而在"删完别自己长回来"**。这套代码库里躺着两条会把它带回来的路：
 *
 *   ① **回退**：`git revert` / `git checkout` 只认"被跟踪的文件"，删掉的东西会
 *      **原样回来**，而**没有任何断言会发现"这次删除被撤销了"** ——
 *      0.2.4 整条线被回退时，仓库里就是这么回到旧形态的。
 *   ② ★★ **守卫反过来逼你把它重建出来**：那几个文件同时出现在三处"要求它存在"的清单里 ——
 *        · `scripts/assemble-release.mjs` 的 `COPY_FILES`（缺一个都不组装）
 *        · `scripts/check-release-package.mjs` 的 `MUST_EXIST`（发布包验收）
 *        · `PROJECT.json` 的 `files`（`verify-manifest` 断言"清单声明的文件都存在"）
 *      于是"组装/验收变红"的**唯一显眼修法**就是把文件再造一份出来 ——
 *      一次删除会被一次"修红"悄悄撤销，而**没人会意识到自己撤销了一个决定**。
 *      （这不是推测：`QQ机器人.lnk` 这条 0.2.2 改名后就失效的旧条目，正是这么长期卡着组装的。）
 *
 * 所以本守卫做两件事：**盯文件不在**，以及**盯那些清单没有再把它们要回来**。
 * 后者才是关键 —— 清单里只要还留着名字，"重建文件"就永远是那条最省事的路。
 *
 * ── 判据（三条 + 负对照）──────────────────────────────────────────────────
 *   ① 六项旧资产**都不在磁盘上**（按仓库根相对路径逐个断言，报错里指名道姓）；
 *   ② 发布脚本的两份清单里**不再出现这些名字**（剥掉注释再扫 —— 注释里"解释为什么删"
 *      是应该的，不该被当成"要求它存在"）；
 *   ③ `PROJECT.json` 的 `files` 里**不再有它们的键**（留着键就一定会让 verify-manifest 红，
 *      于是又回到"把文件造回来"那条路）。
 *   ★★ 负对照：同一套判据喂给**确实还在**的文件与一段**故意写坏的**清单样本，
 *      必须分别判成"还在"与"要求它存在"。没有这一段，上面的"全绿"完全可能只是判据恒真
 *      （本项目对每条守卫都要求"验过牙"）。
 *
 * 用法：node mocks/verify-legacy-assets.mjs
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`✅ ${name}${detail ? `  —— ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`❌ ${name}  —— ${detail}`)
  }
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

/**
 * 0.2.5 按用户要求删除的六项（相对**仓库根**）。
 * 每条都写清"它是什么、为什么删" —— 只说路径名的话，下一个人不知道重建它意味着什么。
 */
const LEGACY = [
  {
    rel: 'packages/dsh-qq-bot（废弃）',
    why: '第一版「DSH 进程内插件」旧架构包（含自带 node_modules，约 110 MB）',
  },
  { rel: 'packages/qq-bridge/启动机器人.bat', why: '中文名启动入口（与 start.bat 重复）' },
  { rel: 'packages/qq-bridge/检查配置.bat', why: '中文名自检入口（等价于 start.bat --check）' },
  { rel: 'packages/qq-bridge/体检.bat', why: '中文名体检入口（等价于 start.bat --doctor）' },
  {
    rel: 'packages/qq-bridge/创建带图标的快捷方式.bat',
    why: '现场生成 .lnk 的脚本（.lnk 里存绝对路径，换机器必然失效）',
  },
  {
    rel: 'packages/qq-bridge/先读我-首次使用.txt',
    why: '面向非技术使用者的上手文档（内容已并入 README.md）',
  },
]

/** 只按**文件名**扫清单 —— 清单里写的就是包根相对名，不带目录前缀。 */
const LEGACY_NAMES = [
  '启动机器人.bat',
  '检查配置.bat',
  '体检.bat',
  '创建带图标的快捷方式.bat',
  '先读我-首次使用.txt',
]

/** 这个文件相对仓库根存在吗。 */
const probe = (rel) => existsSync(join(REPO_ROOT, rel))

/** 剥注释：注释里**应该**出现这些名字（解释"为什么删"），那不是"要求它存在"。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '') // 整行注释
}

/** 取出 `const <name> = [ ... ]` 的正文；取不到返回 null（**不能**当成"通过"）。 */
function arrayBody(src, constName) {
  const m = new RegExp(`const\\s+${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(src)
  return m ? m[1] : null
}

/** 清单正文里出现了哪些已删除的文件名。 */
function namesIn(text) {
  return LEGACY_NAMES.filter((n) => text.includes(n))
}

// ══════════════════════════════════════════════════════════════════════════
section('① 六项旧资产都不在磁盘上')
// ══════════════════════════════════════════════════════════════════════════
for (const { rel, why } of LEGACY) {
  const back = probe(rel)
  check(
    `已删除：${rel}`,
    !back,
    back
      ? `**又回来了** —— 它是 0.2.5 按用户要求删掉的（${why}）。` +
        '要恢复请先问用户；不要为了让某条检查变绿而把它重建出来（见本文件头部 ②）'
      : `（${why}）`,
  )
}

// ══════════════════════════════════════════════════════════════════════════
section('② 发布脚本的清单不再要求它们（否则"重建文件"是唯一显眼的修法）')
// ══════════════════════════════════════════════════════════════════════════
for (const [file, constName, what] of [
  ['scripts/assemble-release.mjs', 'COPY_FILES', '组装时要拷进包的必需件'],
  ['scripts/check-release-package.mjs', 'MUST_EXIST', '发布包验收的必需件'],
]) {
  const src = stripComments(readFileSync(join(PKG_ROOT, file), 'utf8'))
  const body = arrayBody(src, constName)
  // ★ 定位不到数组本身就是**失败**：改了变量名而没人改这里 → 这条守卫会变成
  //   "永远扫空字符串 → 永远绿"，正是本项目最怕的"看起来还在守"。
  check(`能定位到 ${file} 的 ${constName} 数组`, body !== null, body === null ? '变量改名了？请同步本守卫（否则这条检查会永远假绿）' : '')
  const found = namesIn(body ?? '')
  check(
    `${constName}（${what}）里没有已删除的文件名`,
    found.length === 0,
    found.length
      ? `${found.join('、')} —— 这几项已删除，留着名字会让"缺一个都不组装"卡在这里，` +
        '而唯一显眼的修法是把文件造回来。请从清单里去掉它们'
      : `（${(body ?? '').split('\n').filter((l) => /['"]/.test(l)).length} 项，都是现存的）`,
  )
}

// ══════════════════════════════════════════════════════════════════════════
section('③ PROJECT.json 的 files 里没有它们的键（留着键 = 逼 verify-manifest 报红）')
// ══════════════════════════════════════════════════════════════════════════
{
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(join(PKG_ROOT, 'PROJECT.json'), 'utf8'))
  } catch (error) {
    check('PROJECT.json 能解析', false, `解析失败：${error?.message ?? error}`)
  }
  if (manifest) {
    const badKeys = Object.keys(manifest.files ?? {}).filter((k) => LEGACY_NAMES.some((n) => k.includes(n)))
    check(
      '★ PROJECT.json 的 files 不再声明已删除的文件',
      badKeys.length === 0,
      badKeys.length
        ? `${badKeys.join('、')} —— 它有键就要求文件存在（verify-manifest 会报"清单声明的文件都存在"），` +
          '于是修法又变成"把文件造回来"。请删掉这些键，把来龙去脉写进邻近条目的说明里'
        : `（${Object.keys(manifest.files ?? {}).length} 个键，一个都不指向已删除的文件）`,
    )
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 负对照：这套判据真的有牙吗（不是恒真）')
// ══════════════════════════════════════════════════════════════════════════
{
  // 正向：确实还在的东西必须判成"在" —— 这一条同时挡住"清过头"
  // （把 start.bat / 桥接本体一起删掉也能让①全绿，那是另一种错）。
  const survivors = ['packages/qq-bridge/start.bat', 'packages/qq-bridge/src/index.mjs', 'packages/qq-bridge/PROJECT.json']
  check(
    `判据认得出"还在"：${survivors.length} 个必须保留的文件都还在`,
    survivors.every(probe),
    survivors.filter((s) => !probe(s)).join('、') || `（${survivors.join('、')}）`,
  )
  // 负向：已删的判成"不在"（拿一条列表里的名字实测，而不是靠上面①的结论）
  check('判据认得出"不在"：已删的 体检.bat 判成不在', !probe('packages/qq-bridge/体检.bat'))

  // 清单扫描器：故意写一段"注释里提名字 + 数组里真的要求一个已删文件"的样本。
  // 它同时验两件事：**整行注释被剥掉**（不误报）、**数组里的字符串被抓住**（不漏报）。
  const sample = stripComments(
    ['const COPY_FILES = [', '  // 0.2.5 删除了 体检.bat 与 检查配置.bat（注释里提到不算）', '  "start.bat",', '  "体检.bat",', ']'].join('\n'),
  )
  const caught = namesIn(arrayBody(sample, 'COPY_FILES') ?? '')
  check(
    '★ 写坏的清单样本：抓住了数组里那个已删文件名',
    caught.length === 1 && caught[0] === '体检.bat',
    `抓到 ${caught.length} 个：${caught.join('、') || '（一个都没抓到 —— 判据太松）'}`,
  )
  check(
    '★ 同一段样本里的**注释**没有被误报',
    !caught.includes('检查配置.bat'),
    caught.includes('检查配置.bat') ? '注释里的名字被判成了"要求存在"（判据太紧，会训练人无视红色）' : '',
  )

  // 这份清单本身也要有纪律：条目必须写清"是什么、为什么删"（同乱码豁免清单的口径）。
  check(
    '★ 六项旧资产每条都写了理由（没理由的清单等于没有清单）',
    LEGACY.length === 6 && LEGACY.every((l) => typeof l.why === 'string' && l.why.trim().length > 8),
    `（${LEGACY.length} 条）`,
  )
}

console.log('')
if (failed > 0) {
  console.log(`⚠️ ${failed} 项失败 / ${passed} 项通过`)
  console.log('   · 文件又回来了 → 那是 0.2.5 有意删掉的资产，**先问用户**要不要恢复；')
  console.log('   · 是清单/契约里还留着名字 → 把名字去掉（别把文件造回来），理由见本文件头部。')
  process.exitCode = 1
} else {
  console.log(`🎉 旧资产守卫全部通过（${passed} 项）：六项旧资产不在磁盘上，清单也没再把它们要回来`)
}
