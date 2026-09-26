#!/usr/bin/env node
/**
 * 探针：真实的 `dsh --profile sdk` 能不能被桥接启动？
 *
 * ── 这个探针**不花任何模型费用**，为什么？──────────────────────────────
 * 它只做两件事：把子进程起起来、观察它的输出，然后杀掉。
 *   · 不发 session/prompt → 没有任何一轮对话，模型不会被调用
 *   · 也不发 initialize   → 连 provider 校验都不会触发
 * 进程会安静地等 stdin 输入，然后被我们终止。
 *
 * ── 它能回答什么问题 ───────────────────────────────────────────────────
 *   1. dsh CLI 能不能被找到（路径解析是否正确）
 *   2. 子进程能不能被 spawn（某些受限沙箱会以 EPERM 拒绝管道通信）
 *   3. sdk profile 能不能正常初始化（看 stderr 有没有报错）
 *   4. 它会不会在工作区里留下东西（我们期望：什么都不留）
 *
 * 用法：node mocks/verify-real-dsh.mjs
 */

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS, findDshCliWithSource, findNodeBinary, readSearchPathsFromConfig } from '../src/local.mjs'

const PROBE_WS = join(DIRS.vendor, '..', '.tmp-probe-dsh')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

rmSync(PROBE_WS, { recursive: true, force: true })
mkdirSync(PROBE_WS, { recursive: true })

console.log('\n── 1. 定位 dsh CLI ──')
// ★ 必须带上 config.json 里的 dsh.searchPaths —— 否则这台机器上 DSH 装在非标准
//   位置时会"测试说找不到、程序其实跑得起来"（同一个问题两个答案）。
const cli = findDshCliWithSource({ searchPaths: readSearchPathsFromConfig('dsh.searchPaths') })
check('找到了 dsh CLI', cli !== null, cli ? `${cli.cliPath}（来源：${cli.source}）` : '未找到')
const cliPath = cli?.cliPath ?? null
const node = findNodeBinary()
check('找到了 Node 运行时', node !== null, node ?? '未找到')
if (!cliPath) {
  console.log(
    '\n⚠️ 找不到 dsh CLI，无法继续。DSH 不随本包分发，请先安装它，' +
      '或设环境变量 DSH_DESKTOP_APP / 在 config.json 的 dsh.searchPaths 里指明安装根。\n',
  )
  process.exit(1)
}

console.log('\n── 2. 尝试启动（不花模型费用）──')
let child
const stderrLines = []
try {
  child = spawn(node, [cliPath, '--profile', 'sdk'], {
    cwd: PROBE_WS,
    env: { ...process.env, DSH_PERMISSION_MODE: 'workspace-write' },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
} catch (error) {
  check('子进程 spawn 成功', false, `${error.code ?? ''} ${error.message}`)
  console.log('\n⚠️ 这个环境不允许创建带管道的子进程（常见于受限沙箱）。')
  console.log('   这不代表桥接有问题 —— 在正常的 Windows 会话里不会有这个限制。\n')
  process.exit(1)
}

child.stderr.setEncoding('utf8')
child.stderr.on('data', (d) => {
  for (const l of String(d).split(/\r?\n/)) if (l.trim()) stderrLines.push(l.trim())
})
child.stdout.setEncoding('utf8')
let stdoutBytes = 0
child.stdout.on('data', (d) => (stdoutBytes += d.length))

let spawnError = null
child.on('error', (e) => (spawnError = e))

// 等它启动（profile 加载需要一点时间），但绝不给它写任何东西
await sleep(6000)

check('子进程没有立即报 spawn 错误', spawnError === null, spawnError ? `${spawnError.code} ${spawnError.message}` : '')
check('子进程仍存活（说明 profile 正常加载、在等 stdin）', child.exitCode === null && !child.killed)

console.log('\n── 3. stderr 输出（dsh 的日志，前 10 行）──')
for (const l of stderrLines.slice(0, 10)) console.log(`   ${l}`)
if (stderrLines.length === 0) console.log('   （空）')
const errText = stderrLines.join('\n')
check('没有出现"无法加载 profile"之类的致命错误', !/cannot|failed to load|ENOENT|unknown profile/i.test(errText),
  /cannot|failed to load|ENOENT|unknown profile/i.test(errText) ? errText.slice(0, 200) : '')

console.log('\n── 4. 工作区是否被污染 ──')
const leftovers = existsSync(PROBE_WS) ? readdirSync(PROBE_WS) : []
check('工作区保持干净（agent 只在收到 prompt 后才动手）', leftovers.length === 0,
  leftovers.length ? leftovers.join(', ') : '空')

console.log('\n── 5. 收尾 ──')
child.kill()
await sleep(800)
check('子进程已被终止', child.exitCode !== null || child.killed, `exitCode=${child.exitCode} killed=${child.killed}`)
rmSync(PROBE_WS, { recursive: true, force: true })

console.log(`\n${failures === 0 ? '🎉 真实 dsh 可被桥接启动' : `⚠️ ${failures} 项失败`}`)
console.log('（本次探针未产生任何模型调用，费用为 0）\n')
process.exit(failures === 0 ? 0 : 1)
