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
 *   · `fresh`      —— 标记在、哈希一致        → 这份就是当前源码构建的
 *   · `stale`      —— 标记在、哈希不一致      → **源码改过没重新构建**（要修的是构建）
 *   · `unstamped`  —— 标记不在                → **无法自证来源**（要修的是产物，不是源码）
 *   · `uncheckable`—— 缺"重算哈希的输入/实现" → **判不了**（0.2.5 补：发布包里没有
 *                    `config-ui/src`，只有 `dist`，重算出来会是**空串的哈希** ⇒ 那时报
 *                    `stale` 是**假红**，而假红会训练人忽略红色）
 *
 * ★ 为什么必须分开：`stale` 与 `unstamped` 的处理方式完全不同。混起来报一句
 *   "界面不同步"，使用者会去重新构建，而 `unstamped` 那种情况下重新构建**也修不好**
 *   （产物根本不是本项目构建出来的，例如别人手工拷来的）。这类含糊的报错
 *   正是本项目一直在避免的东西。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { PKG_ROOT } from './local.mjs'

const require = createRequire(import.meta.url)
// ★ 与构建侧**同一个** CJS 模块（哈希逻辑只有一份）。
//
// ★★ 0.2.5 修：这个 require 原来是**模块顶层**的，于是 `scripts/ui-build-stamp.cjs`
//    一旦不在包里，`src/index.mjs` 一 import 就抛 —— **整个桥接启动即死**。
//    而发布包从来只拷 `src/`、不拷 `scripts/`（见 assemble-release 的清单）⇒ 实测：
//    `_release/InteractBot-0.2.0` 起每一份包里的桥接都**起不来**，
//    且 `respawnBridge` 用的是 `stdio:'ignore'`，连 `logs/bridge.log` 都不会生成 ——
//    用户只看到"桌面窗口一直等"，没有任何线索（真机实测：90 秒超时）。
//
//    ⇒ 缺了它就**降级成"无法判断"（unstamped）**，并**说清缺的是哪个文件**。
//    这是本仓库既有的纪律：**观测手段不许把主流程弄挂**
//    （同 `memory-stats`：统计文件坏掉也不许抛）。判据本身没有变松 —— 变的是
//    "缺助手"从"崩"变成"如实说：我判断不了，因为缺这份实现"。
const stampModule = (() => {
  try {
    return require(join(PKG_ROOT, 'scripts', 'ui-build-stamp.cjs'))
  } catch (error) {
    return { __loadError: error?.message ?? String(error) }
  }
})()

/** 默认的开发路径产物目录（桥接伺服的就是它）。 */
export function defaultUiDist() {
  return join(PKG_ROOT, 'config-ui', 'dist')
}

/**
 * 检查一份 dist 是不是当前源码构建的。
 *
 * @param {{distDir?: string}} [opts]
 * @returns {{
 *   status: 'fresh'|'stale'|'unstamped'|'missing'|'uncheckable',
 *   distDir: string,
 *   stamp?: object,
 *   expectedHash: string,
 *   why: string,
 *   advice: string
 * }}
 */
export function checkUiFreshness({ distDir = defaultUiDist() } = {}) {
  // ★ 缺"算哈希的那份实现"时**不崩**，而是如实报"判不了"（理由见文件顶部 0.2.5 那段）
  if (stampModule.__loadError) {
    return {
      status: 'uncheckable',
      distDir,
      expectedHash: '',
      why:
        `算不出源码哈希：${stampModule.__loadError}` +
        '（校验侧与构建侧共用的那份实现在 scripts/ui-build-stamp.cjs）',
      advice:
        '这个包里**没有** `scripts/ui-build-stamp.cjs` —— 界面产物无法自证来源。' +
        '发布包应当带上它（见 `scripts/assemble-release.mjs` 的拷贝清单）；' +
        '源码树里出现这句，说明那个文件被删了或路径口径变了。',
    }
  }
  // ★★ 发布包里**没有** `config-ui/src`（只发 dist）⇒ 重算哈希的输入是空的、
  //    算出来会是"空串的哈希"（`e3b0c442…`），于是永远报 `stale` —— 那是**假红**。
  //    这里如实分开：判不了就说判不了，并说清"这是发布包的正常形态"。
  if (!existsSync(join(PKG_ROOT, 'config-ui', 'src'))) {
    return {
      status: 'uncheckable',
      distDir,
      expectedHash: '',
      why: '这个包里没有 config-ui/src（发布包只发 dist），没法重算源码哈希',
      advice:
        '要判断"UI 与源码是否同步"请在**源码树**里跑 `node src/index.mjs --ui`（或 `setup.mjs --release`）——' +
        '发布包本身只有成品，这一层判不了。',
    }
  }
  const expectedHash = stampModule.computeUiSourceHash()

  if (!existsSync(join(distDir, 'index.html'))) {
    return {
      status: 'missing',
      distDir,
      expectedHash,
      why: `产物不存在：${join(distDir, 'index.html')}`,
      advice: '在 config-ui 里跑一次 npm run build（界面的源码改动必须重新构建才会生效）',
    }
  }

  const r = stampModule.readBuildStamp(distDir)
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
        `（构建于 ${r.stamp?.builtAt ?? '?'}）`,
      advice: '源码改过但没重新构建 —— 在 config-ui 里跑一次 npm run build，然后重新组装发布包',
    }
  }

  return {
    status: 'fresh',
    distDir,
    stamp: r.stamp,
    expectedHash,
    why: `与当前源码一致（构建于 ${r.stamp?.builtAt ?? '?'}）`,
    advice: '',
  }
}

/**
 * 给状态起个"给人看"的标题。**不要**把 stale 与 unstamped 说成同一句话。
 */
export function uiFreshnessTitle(status) {
  switch (status) {
    case 'fresh':
      return '✅ 界面产物与当前源码同步'
    case 'stale':
      return '❌ 界面产物**落后于**当前源码（源码改了没重新构建）'
    case 'unstamped':
      return '⚠️ 界面产物**无法自证来源**（没有构建标记）'
    case 'uncheckable':
      return '· 界面新鲜度**判不了**（缺重算哈希的输入/实现 —— 发布包属于这种）'
    case 'missing':
      return '❌ 界面产物不存在'
    default:
      return `· 未知状态：${status}`
  }
}
