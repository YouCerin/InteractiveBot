/**
 * UI 构建溯源：计算 `config-ui` 源码树的内容哈希，并读写 dist 旁的 `ui-build.json`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（一次真实的脱钩）
 * ══════════════════════════════════════════════════════════════════════════
 * 控制台界面分两条路出货：
 *   · 开发路径 `config-ui/dist`（本次起也入库）
 *   · 发布路径 `_release/<包>/config-ui/dist`（`RELEASE.md` §5 用 robocopy 拷过去）
 *
 * 以前**没有任何东西**能判断"发布包里那份 dist 是不是当前源码构建的"：
 * `check-release-package.mjs` 只验"`dist/index.html` 在不在"，存在即通过。
 * 实测后果：发布包里的桥接源码与 UI 都比工作区旧了约 5 小时，而全量测试
 * **1100 项全绿** —— 因为没有任何断言看那个目录。于是"用户拿到的 UI"和
 * "我这边验证过的 UI"可以静默地不是同一份。
 *
 * 现在：构建时把源码树的内容哈希写进产物旁的 `ui-build.json`；
 * 发布验收时重算一次哈希比对；`node src/index.mjs --ui` 也能直接回答
 * "你手上这份 dist 与当前源码同不同步"。
 *
 * ── 三条硬约束 ─────────────────────────────────────────────────────────
 *   ① **逻辑只有一份**（本文件）。构建侧与校验侧都调它 —— 各写一套必然分叉，
 *      而分叉的表现是"校验说同步、其实是错的"。
 *   ② **跨平台稳定**：换行统一成 `\n` 再算。否则同一份源码在 CRLF 环境下会算出
 *      不同的哈希，表现是"明明没改却报不同步" —— 那种红会训练人忽略它。
 *   ③ **不猜**：只按**排序后的路径 + 内容**算，不掺时间戳与机器信息；
 *      读不到标记就明说读不到，**绝不返回一个"看起来同步"的默认值**。
 *
 * ⚠️ 为什么是 `.cjs` 而不是 `.mjs`：`vite.config.ts` 被 Vite 打包成 CJS，
 *    里面只能 `require` 一个 CJS 模块；而 `.mjs` 里 `require` 是未定义的
 *    （踩过：`ReferenceError: require is not defined in ES module scope`）。
 *    桥接侧（ESM）用 `createRequire` 或直接 import 同名 `.cjs` 都行。
 */

const { createHash } = require('node:crypto')
const { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } = require('node:fs')
const { join, relative, resolve, sep } = require('node:path')

/** 包根（`packages/qq-bridge`）—— 本文件在 `scripts/` 下。 */
const PKG_ROOT = resolve(__dirname, '..')
/** UI 工程根。 */
const UI_ROOT = join(PKG_ROOT, 'config-ui')

/** 参与哈希的源码子目录（相对 UI 根）。 */
const HASH_DIRS = ['src']
/** 参与哈希的单文件（相对 UI 根）。构建与类型配置变了也会影响产物。 */
const HASH_FILES = [
  'package.json',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'index.html',
  'tailwind.config.js',
  'tailwind.config.ts',
  'postcss.config.js',
]

/** 统一换行，保证跨平台哈希一致（理由见文件头约束②）。 */
function normalize(text) {
  return String(text).replace(/\r\n/g, '\n')
}

/** 递归收集文件（相对 UI 根的 POSIX 风格路径）。跳过软链与产物目录。 */
function collectFiles(root, sub, out = []) {
  const abs = join(root, sub)
  if (!existsSync(abs)) return out
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const full = join(abs, entry.name)
    const rel = relative(root, full).split(sep).join('/')
    try {
      if (lstatSync(full).isSymbolicLink()) continue // 软链会让哈希依赖机器上的目标
    } catch {
      continue
    }
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      collectFiles(root, rel, out)
    } else if (entry.isFile()) {
      out.push(rel)
    }
  }
  return out
}

/**
 * 算出 UI 源码树的内容哈希（sha256 十六进制）。
 * @param {string} [uiRoot] 默认 `packages/qq-bridge/config-ui`
 */
function computeUiSourceHash(uiRoot = UI_ROOT) {
  const files = []
  for (const d of HASH_DIRS) collectFiles(uiRoot, d, files)
  for (const f of HASH_FILES) if (existsSync(join(uiRoot, f))) files.push(f)

  const hash = createHash('sha256')
  // 排序是关键：目录遍历顺序在不同文件系统上不保证一致
  for (const rel of [...new Set(files)].sort()) {
    hash.update(rel)
    hash.update('\0')
    hash.update(normalize(readFileSync(join(uiRoot, rel), 'utf8')))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** 写上标记（构建产物旁边）。返回绝对路径。 */
function writeBuildStamp(distDir, stamp) {
  const p = join(distDir, 'ui-build.json')
  writeFileSync(p, `${JSON.stringify(stamp, null, 2)}\n`, 'utf8')
  return p
}

/**
 * 读一个 dist 里的标记。
 * @returns {{ok: true, stamp: object} | {ok: false, why: string}}
 */
function readBuildStamp(distDir) {
  const p = join(distDir, 'ui-build.json')
  if (!existsSync(p)) {
    return { ok: false, why: `${p} 不存在（这份 dist 是加标记之前构建的，或从没构建过）` }
  }
  try {
    return { ok: true, stamp: JSON.parse(readFileSync(p, 'utf8')) }
  } catch (error) {
    return { ok: false, why: `标记文件不是合法 JSON：${error && error.message ? error.message : error}` }
  }
}

module.exports = {
  PKG_ROOT,
  UI_ROOT,
  computeUiSourceHash,
  writeBuildStamp,
  readBuildStamp,
}
