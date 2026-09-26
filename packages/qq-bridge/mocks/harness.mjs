#!/usr/bin/env node
/**
 * 测试环境探针：本环境允不允许启动带管道的子进程？
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════════════════════
 * 有几套测试要起真实子进程（假 DSH、假协议端、MCP 服务器、进程登记夹具）。
 * 受限沙箱（以及某些企业策略）会以 `EPERM` 拒绝 `child_process.spawn` 的管道 stdio，
 * 于是那些套件**硬失败** —— 而它们失败的原因与被测代码毫无关系。
 *
 * 那种红是危险的：它训练人忽略红色。所以规则是：
 *   **跑不了就说"跑不了"，并明确标注"这不算通过"** —— 绝不伪装成"通过"，
 *   也绝不伪装成"代码坏了"。
 *
 * 用法（各套件里）：
 *
 *   import { canSpawn, sectionIf, printSkipSummary } from './harness.mjs'
 *   const spawnOk = await canSpawn()
 *   sectionIf(spawnOk, '① 与子进程有关的用例', () => { ... })
 *   ...
 *   printSkipSummary()   // 末尾打印"跳过了几节 + 这不是完整通过"
 *
 * 设计上刻意做成**一次探针、全程复用**：探针本身要 spawn 一次，
 * 每个用例都探一次既慢又吵。
 */

import { spawn } from 'node:child_process'

/** 探针结果缓存。 */
let cached = null

/**
 * 本环境能不能启动带管道的子进程。
 *
 * 注意 `spawn` 的失败是**异步 emit `error`**（不是抛异常），而且被拒绝时
 * 它还会 emit `spawn`，只是 `pid` 是 undefined —— 所以两个事件都听，
 * 并用"有没有 pid"判定到底起没起来。
 *
 * @returns {Promise<boolean>}
 */
export function canSpawn() {
  if (cached !== null) return Promise.resolve(cached)
  cached = new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, ['-e', ''], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      return resolve(false)
    }
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* 已经没了 */
      }
      cached = Promise.resolve(ok)
      resolve(ok)
    }
    child.once('error', () => done(false))
    child.once('spawn', () => done(Boolean(child.pid)))
    setTimeout(() => done(Boolean(child.pid)), 2000)
  })
  return cached
}

/** 已跳过的小节标题（供末尾汇总）。 */
const skipped = []

/**
 * 有条件地跑一节。
 *
 * @param {boolean} canRun 为 false 时跳过
 * @param {string} title 小节标题
 * @param {() => any} fn 小节内容
 */
export async function sectionIf(canRun, title, fn) {
  if (!canRun) {
    skipped.push(title)
    console.log(`\n── ${title} ──`)
    console.log('  ⏭️  跳过：本环境不允许启动带管道的子进程（EPERM），这与被测代码无关')
    return
  }
  await fn()
}

/**
 * 末尾汇总。**这不是"全部通过"的打印** —— 有跳过时明确说明。
 *
 * @param {number} failures
 * @param {string} okMessage 全绿时的祝贺语
 */
export function printSkipSummary(failures, okMessage) {
  console.log('')
  if (failures > 0) {
    console.log(`⚠️ ${failures} 项失败`)
    return
  }
  if (skipped.length > 0) {
    console.log(`⚠️ 通过了，但有 ${skipped.length} 个小节**未运行**（环境限制）：`)
    for (const s of skipped) console.log(`     · ${s}`)
    console.log('   这**不算**完整通过 —— 请在能启动子进程的环境（正常 Windows 会话）里重跑。')
    return
  }
  console.log(okMessage)
}
