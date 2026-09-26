/**
 * 依赖引导模块。
 *
 * ── 它解决的怪问题 ─────────────────────────────────────────────────────
 * 我们的依赖（`ws`）被放在 `vendor/node_modules/` 里，而不是标准的
 * `node_modules/`。为什么这么放？因为你要求"整个包换地方也能用"，
 * 而把依赖收进 `vendor/` 有一个明显好处：**包内自带什么，一眼就能看见**，
 * 而且不会被 npm 的清理、软链、缓存策略搅乱。
 *
 * 但 Node 默认**不会**去 vendor 里找。所以这个模块做一件事：
 * 用带自定义解析逻辑的 `createRequire`，把 `ws` 指到 vendor。
 *
 * ── 为什么要写在单独文件、而且用同步 API ────────────────────────────────
 * 其他模块是 `import WebSocket from 'ws'` 这样静态导入的，静态导入在模块
 * 顶层求值，**比任何 await 都早**。所以引导必须在被它们导入之前就完成，
 * 这也是为什么 index.mjs 第一行就 import 本模块 —— 导入顺序就是执行顺序。
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { DIRS } from './local.mjs'

/**
 * 加载一个被收进 vendor 的 CommonJS 依赖。
 * @param {string} name 包名，例如 'ws'
 */
export function vendorRequire(name) {
  const anchor = join(DIRS.vendor, '__vendor_anchor__.cjs')
  const require = createRequire(anchor)
  return require(name)
}

/** vendor 里的依赖是否已就位。 */
export function hasVendored(name) {
  if (name === 'ws') return existsSync(join(DIRS.vendorNodeModules, 'ws', 'index.js'))
  return existsSync(join(DIRS.vendorNodeModules, name))
}

/**
 * 给出一个明确的错误信息（而不是让 Node 抛它自己那套难懂的解析失败）。
 * 这类"环境没准备好"的问题，报错必须直接告诉用户该执行什么命令。
 */
export function assertVendored(name) {
  if (hasVendored(name)) return
  throw new Error(
    `缺少依赖「${name}」。请先在 packages/qq-bridge 目录下执行：\n` +
      `    node setup.mjs\n` +
      `它会把所需依赖复制到 vendor/ 里（只复制纯 JS 包，不需要联网、不需要编译）。`,
  )
}
