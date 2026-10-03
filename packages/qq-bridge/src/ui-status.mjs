/**
 * UI 新鲜度：**判断"我手上这份界面是不是当前源码构建的"**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（一次真实的脱钩）
 * ══════════════════════════════════════════════════════════════════════════
 * 界面分两条路出货：开发路径 `config-ui/dist`（已入库）与发布路径
 * `_release/<包>/config-ui/dist`（`RELEASE.md` §5 用 robocopy 拷）。而
 * "发布包那份 dist 是不是当前源码构建的"**以前没有任何东西能判断** ——
 * 验收脚本只验 `dist/index.html` 在不在，存在即通过。
 *
 * 实测后果：发布包里的桥接源码与 UI 都比工作区旧了约 5 小时，**1100 项测试全绿**，
 * 因为没有一条断言会去看那个目录。于是"用户拿到的 UI"与"我这边验证过的 UI"
 * 可以静默地不是同一份。
 *
 * 现在判定方式很朴素：构建时把源码树的内容哈希写进 `dist/ui-build.json`，
 * 这里重算一次比对。**哈希算法只有一份**（`scripts/ui-build-stamp.cjs`），
 * 免得校验侧与构建侧各写一套、迟早分叉。
 *
 * ── 四种结果必须分开，不能混成"绿/红" ──────────────────────────────────
 *   · `fresh`    —— 标记在、哈希一致        → 这份就是当前源码构建的
 *   · `stale`    —— 标记在、哈希不一致      → **源码改过没重新构建**（要修的是构建）
 *   · `unstamped`—— 标记不在（或标记模块读不到）→ **无法判断**（要修的是产物）
 *   · `packaged` —— **没有界面源码**（发布包常态）→ **本机无法核对**，不是故障
 *
 * ★ 为什么必须分开：`stale` 与 `unstamped` 的处理方式完全不同。混起来报一句
 *   "界面不同步"，使用者会去重新构建，而 `unstamped` 那种情况下重新构建**也修不好**
 *   （产物根本不是本项目构建出来的，例如别人手工拷来的）。这类含糊的报错
 *   正是本项目一直在避免的东西。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ `packaged` 是怎么来的（2026-10-03 实机验证踩到）
 * ══════════════════════════════════════════════════════════════════════════
 * 发布包**按设计不含 `config-ui/src`**（`RELEASE.md` §2：只拷 `config-ui/dist`），
 * 而本模块原来在**顶层**硬 `require` 那个标记模块 ⇒ 在用户机器上 `ui-status.mjs`
 * 直接**加载失败**：
 *
 *   ❌ 界面检查失败：Cannot find module 'C:\InteractiveBot\scripts\ui-build-stamp.cjs'
 *   Require stack: - C:\InteractiveBot\src\ui-status.mjs
 *
 * 更糟的是它会被上层兜成 `unstamped`，而界面对 `unstamped` 打的是
 * 「你看到的是旧界面」——**在发布包里那是一句假话**（界面一点都不旧，只是没源码可比）。
 *
 * 两个修法都试过、只有一个对：
 *   · ❌ 把 `scripts/ui-build-stamp.cjs` 也打进包 —— 它算哈希的输入是 `config-ui/src`，
 *     包里没有那些源码 ⇒ 算出空哈希 ⇒ 变成 `stale`（"源码改了没重新构建"），**误导更强**；
 *   · ✅ **认出发布包这个形态**：没有界面源码 ⇒ `packaged`，如实说"本机无法核对"。
 *     发布包与源码同源这件事，由**组装时的门禁**保证（`setup.mjs --release` 的 ①-b
 *     与 `check-release-package.mjs` 的"包里能自己跑通 --ui"）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { PKG_ROOT } from './local.mjs'

const require = createRequire(import.meta.url)

/**
 * 惰性加载"哈希逻辑只有一份"的那个 CJS 模块（`scripts/ui-build-stamp.cjs`）。
 *
 * ⚠️ **不能写成顶层 `require`**：发布包里没有 `scripts/`，顶层 require 会让本模块
 *    在用户机器上**直接加载失败**（2026-10-03 实机踩到，详见文件头）。这里改成
 *    用完再取，并把失败如实说出来 —— 由调用方决定"这是发布包常态"还是"检出缺文件"。
 */
function loadStampTool(pkgRoot = PKG_ROOT) {
  try {
    return { ok: true, tool: require(join(pkgRoot, 'scripts', 'ui-build-stamp.cjs')) }
  } catch (error) {
    return {
      ok: false,
      why:
        `读不到界面构建标记模块（${join(pkgRoot, 'scripts', 'ui-build-stamp.cjs')}）：` +
        `${error?.message ?? error}`,
    }
  }
}

/**
 * **只为显示**读一下 dist 旁的 `ui-build.json`（构建时间 / 版本）。
 *
 * 判定逻辑仍在唯一那份 `scripts/ui-build-stamp.cjs` 里 —— 这里刻意**不**复刻它的
 * 错误处理，读不到就返回 null，绝不用它下结论。
 */
function readStampForDisplay(distDir) {
  try {
    return JSON.parse(readFileSync(join(distDir, 'ui-build.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** 默认的开发路径产物目录（桥接伺服的就是它）。 */
export function defaultUiDist() {
  return join(PKG_ROOT, 'config-ui', 'dist')
}

/**
 * 检查一份 dist 是不是当前源码构建的。
 *
 * @param {{distDir?: string, pkgRoot?: string}} [opts]
 *   `pkgRoot` 只给测试用（指到一个模拟的包根，验证"发布包形态"这条分支）。
 * @returns {{
 *   status: 'fresh'|'stale'|'unstamped'|'packaged'|'missing',
 *   distDir: string,
 *   stamp?: object,
 *   expectedHash: string,
 *   why: string,
 *   advice: string
 * }}
 */
export function checkUiFreshness({ distDir = defaultUiDist(), pkgRoot = PKG_ROOT } = {}) {
  // ① **没有界面源码** ⇒ 这是一个发布包（包里只带产物）。本机无法核对 —— 不是故障。
  //    必须先判这一条：否则会掉进"标记模块读不到"⇒ unstamped ⇒ 界面喊"旧界面"的假话。
  const uiSrcDir = join(pkgRoot, 'config-ui', 'src')
  if (!existsSync(uiSrcDir)) {
    return {
      status: 'packaged',
      distDir,
      stamp: readStampForDisplay(distDir),
      expectedHash: '',
      why:
        `这个安装里**没有界面源码**（${uiSrcDir} 不存在）—— ` +
        `发布包按设计只带界面产物（config-ui/dist），不带源码，所以"这份产物是不是当前源码构建的"在本机无法核对。`,
      advice:
        '**这不是故障、也不影响回话**：包里的产物已经过组装门禁（组装时会拿源码哈希核对一次）。' +
        '想自己核，就看 config-ui/dist/ui-build.json 里记的 sourceHash 与 builtAt；' +
        '要真正重算哈希，得到源码仓库里跑 node src/index.mjs --ui。',
    }
  }

  // ② 有源码、但标记模块读不到 ⇒ 检出缺文件（真的有问题）。
  const loaded = loadStampTool(pkgRoot)
  if (!loaded.ok) {
    return {
      status: 'unstamped',
      distDir,
      expectedHash: '',
      why: loaded.why,
      advice:
        '`scripts/ui-build-stamp.cjs` 应当与 src 同在仓库里 —— 你的检出缺了它（或改名了）。' +
        '从仓库重新取一份即可；**不要**靠重新构建来修。',
    }
  }
  const { computeUiSourceHash, readBuildStamp } = loaded.tool
  const expectedHash = computeUiSourceHash()

  if (!existsSync(join(distDir, 'index.html'))) {
    return {
      status: 'missing',
      distDir,
      expectedHash,
      why: `产物不存在：${join(distDir, 'index.html')}`,
      advice: '在 config-ui 里跑一次 npm run build（界面的源码改动必须重新构建才会生效）',
    }
  }

  const r = readBuildStamp(distDir)
  if (!r.ok) {
    return {
      status: 'unstamped',
      distDir,
      expectedHash,
      why: r.why,
      advice:
        '**这份产物无法自证来源**，重新构建也没用（它不是本项目构建出来的，或构建时标记没写成功）。' +
        '请删掉该 dist 后重新构建，或确认它确实来自本项目。',
    }
  }

  const got = String(r.stamp?.sourceHash ?? '')
  if (got !== expectedHash) {
    return {
      status: 'stale',
      distDir,
      stamp: r.stamp,
      expectedHash,
      why:
        `产物记录的源码哈希是 ${got.slice(0, 12)}…，当前源码算出来是 ${expectedHash.slice(0, 12)}…` +
        `（构建于 ${fmtBuiltAt(r.stamp?.builtAt)}）`,
      advice: '源码改过但没重新构建 —— 在 config-ui 里跑一次 npm run build，然后重新组装发布包',
    }
  }

  return {
    status: 'fresh',
    distDir,
    stamp: r.stamp,
    expectedHash,
    why: `与当前源码一致（构建于 ${fmtBuiltAt(r.stamp?.builtAt)}）`,
    advice: '',
  }
}

/**
 * 把 `builtAt` 渲染成**给人看**的本地时间。
 *
 * ★★ 为什么需要它（用户报的真实问题）：`ui-build.json` 里存的是 **UTC ISO 串**
 *   （`2026-10-03T18:36:04.186Z`），而上面那两句把它**原样**拼进「（构建于 …）」——
 *   于是 UTC+8 的使用者读到的是 `18:36`，比他自己那次构建（本地 `02:36`）
 *   看起来**晚了 8 小时**，像一条过期/未来的时间戳。
 *   实测那次构建：UTC `18:36:04.186Z` ↔ 本地 `2026/10/4 02:36:04`，
 *   与 `ui-build.json` 的文件修改时间**逐秒吻合** —— 所以**存的值没错，错的是显示**。
 *
 * ★ 保留 `stamp.builtAt` 字段本身不动（那是给机器比对的原始值，改动会破坏可比性）；
 *   只在**文案**这一层转成本地时间，并**显式标出时区**，免得跨时区调试时又对不上。
 * ★ 解析不出来时**原样返回**（宁可显示一个丑但真实的值，也不要编一个"现在"）。
 */
export function fmtBuiltAt(builtAt) {
  const raw = String(builtAt ?? '').trim()
  if (!raw) return '?'
  const t = Date.parse(raw)
  if (!Number.isFinite(t)) return raw
  const d = new Date(t)
  const pad = (n) => String(n).padStart(2, '0')
  const local =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  // ★ 时区偏移按**这个时刻**算（跨夏令时的那一天，今天算出来的偏移可能不同）
  const offMin = -d.getTimezoneOffset()
  const sign = offMin >= 0 ? '+' : '-'
  const off = `UTC${sign}${pad(Math.floor(Math.abs(offMin) / 60))}:${pad(Math.abs(offMin) % 60)}`
  // 本地时间与 UTC 不是一回事时，把 UTC 也带上（跨时区排查必须两端都能对上）
  return offMin === 0 ? `${local}（UTC）` : `${local}（${off}）`
}

/**
 * 给状态起个"给人看"的标题。**不要**把 stale 与 unstamped 说成同一句话，
 * 更不要把 `packaged`（发布包常态）说成"旧界面"。
 */
export function uiFreshnessTitle(status) {
  switch (status) {
    case 'fresh':
      return '✅ 界面产物与当前源码同步'
    case 'stale':
      return '❌ 界面产物**落后于**当前源码（源码改了没重新构建）'
    case 'unstamped':
      return '⚠️ 界面产物**无法自证来源**（没有构建标记）'
    case 'packaged':
      return '· 这是发布包：界面新鲜度在本机无法核对（包里只带产物，不带源码）'
    case 'missing':
      return '❌ 界面产物不存在'
    default:
      return `· 未知状态：${status}`
  }
}

/**
 * 这个状态是不是"界面可能不是你现在该看到的那份"（界面要打告警）。
 *
 * ★ `packaged` **不算**：发布包里说"你看到的是旧界面"是假话，那正是这次要修的 bug。
 * ★ 未知状态**算**（保守）：只有在版本对不上时才会出现，值得让人看一眼 ——
 *   但它的标题会说"状态未知"，不会冒充"旧界面"。
 * ⚠️ 界面侧（`config-ui/src/lib/api.ts` 的 `isUiAlarm`）是同一套判据的第二份实现：
 *    那边是浏览器包，import 不到这里。改判据时**两处一起改**。
 */
export function isUiFreshnessAlarm(status) {
  return status !== 'fresh' && status !== 'packaged'
}
