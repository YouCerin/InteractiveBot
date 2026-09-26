#!/usr/bin/env node
/**
 * `local.mjs` 的路径解析测试 —— 重点是 `resolveDshHome`。
 *
 * ── 为什么这块必须测 ───────────────────────────────────────────────────
 * 它踩过一次真实的坑，而且后果很隐蔽：第一版想"从 dsh CLI 的路径反推
 * DSH_HOME"，结果算出的是 **DSH 的安装目录**（因为 DSH 是全局安装的，
 * profile 却在用户数据目录，两者没有路径关系），于是把 profile 补丁
 * **写进了程序安装目录**，在那儿凭空造出一个 `profiles/sdk/cordis.patch.yml`。
 *
 * 这种错误不会报错、不会崩，只是"配置写到了没人读的地方" ——
 * 表现成"MCP 工具根本没生效，但日志里什么都没说"。
 *
 * 所以这里用**注入的存在性判断**来测候选顺序，不依赖本机真实目录。
 *
 * 用法：node mocks/verify-local.mjs
 */

import { resolveDshHome, DIRS, PKG_ROOT } from '../src/local.mjs'
import { join, isAbsolute } from 'node:path'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
const section = (t) => console.log(`\n── ${t} ──`)

/** 造一个"只承认某些路径存在"的判断函数。 */
const existsOnly = (...paths) => {
  const set = new Set(paths.map((p) => String(p).toLowerCase()))
  return (p) => set.has(String(p).toLowerCase())
}

const CLI = 'D:\\SomeInstall\\resources\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const INSTALL_ROOT = 'D:\\SomeInstall\\resources\\app'

// 为了测试确定性，临时改写环境变量（测完还原）
const savedHome = process.env.DSH_HOME
const savedAppData = process.env.APPDATA

try {
  // ══════════════════════════════════════════════════════════════════════
  section('★ 核心：不能把 DSH 安装目录当成 DSH_HOME')
  // ══════════════════════════════════════════════════════════════════════
  {
    // 场景：安装目录存在，但它旁边**没有** harness —— 这是本机的真实情况
    delete process.env.DSH_HOME
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming'
    const r = resolveDshHome({ cliPath: CLI, exists: existsOnly(INSTALL_ROOT) })
    check('★ 安装目录存在但旁边没有 harness 时 → 返回 null（而不是误当作 DSH_HOME）',
      r === null, JSON.stringify(r))
  }

  {
    // 场景：环境变量给了正确的 DSH_HOME
    process.env.DSH_HOME = 'C:\\Users\\tester\\AppData\\Roaming\\dsh-desktop\\harness'
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming'
    const r = resolveDshHome({
      cliPath: CLI,
      exists: existsOnly(process.env.DSH_HOME, INSTALL_ROOT),
    })
    check('环境变量 DSH_HOME 优先', r?.home === process.env.DSH_HOME, r?.home)
    check('标出来源是 env:DSH_HOME', r?.source === 'env:DSH_HOME', r?.source)
  }

  {
    // 场景：没设环境变量，但桌面版默认位置存在 —— 应回退到它
    delete process.env.DSH_HOME
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming'
    const expected = join(process.env.APPDATA, 'dsh-desktop', 'harness')
    const r = resolveDshHome({ cliPath: CLI, exists: existsOnly(expected, INSTALL_ROOT) })
    check('★ 没有环境变量时回退到 %APPDATA%\\dsh-desktop\\harness',
      r?.home === expected, r?.home)
    check('标出来源是 APPDATA 那条', /APPDATA/.test(r?.source ?? ''), r?.source)
  }

  {
    // 场景：环境变量指向一个**不存在**的目录 → 不能采信，必须继续找
    process.env.DSH_HOME = 'C:\\nope\\does\\not\\exist'
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming'
    const expected = join(process.env.APPDATA, 'dsh-desktop', 'harness')
    const r = resolveDshHome({ cliPath: CLI, exists: existsOnly(expected) })
    check('★ 环境变量指向不存在的目录时不被采信，继续找下一个',
      r?.home === expected, r?.home)
  }

  {
    // 场景：只有"安装目录旁的 harness"存在（非桌面安装形态的兜底）
    delete process.env.DSH_HOME
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming'
    const adjacent = join(INSTALL_ROOT, 'harness')
    const r = resolveDshHome({ cliPath: CLI, exists: existsOnly(adjacent) })
    check('兜底候选：安装目录旁的 harness', r?.home === adjacent, r?.home)
  }

  {
    // 什么都不存在 → null（调用方会给出明确指引）
    delete process.env.DSH_HOME
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming'
    const r = resolveDshHome({ cliPath: CLI, exists: () => false })
    check('全都不存在时返回 null（调用方据此报错）', r === null, JSON.stringify(r))
  }

  {
    // 不传 cliPath 也不崩
    delete process.env.DSH_HOME
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming'
    const expected = join(process.env.APPDATA, 'dsh-desktop', 'harness')
    const r = resolveDshHome({ exists: existsOnly(expected) })
    check('不传 cliPath 也能工作', r?.home === expected, r?.home)
  }

  {
    // 探测函数抛异常时不能崩（权限问题等）
    delete process.env.DSH_HOME
    process.env.APPDATA = 'C:\\Users\\tester\\AppData\\Roaming'
    const r = resolveDshHome({
      cliPath: CLI,
      exists: () => {
        throw new Error('EPERM')
      },
    })
    check('存在性探测抛异常时不崩', r === null, JSON.stringify(r))
  }
} finally {
  // 还原环境变量，避免影响同一进程里的其他测试
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  if (savedAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = savedAppData
}

// ══════════════════════════════════════════════════════════════════════════
section('其他路径工具')
// ══════════════════════════════════════════════════════════════════════════
{
  check('PKG_ROOT 是绝对路径', isAbsolute(PKG_ROOT), PKG_ROOT)
  check('默认工作区在包内（保证包搬走它跟着走）',
    DIRS.defaultWorkspace.startsWith(PKG_ROOT), DIRS.defaultWorkspace)
  check('vendor 目录在包内', DIRS.vendorNodeModules.startsWith(PKG_ROOT))
}

console.log(`\n${failures === 0 ? '🎉 路径解析测试全部通过' : `⚠️ ${failures} 项失败`}\n`)
process.exit(failures === 0 ? 0 : 1)
