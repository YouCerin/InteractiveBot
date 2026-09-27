/**
 * 记忆**注入面**诊断（真机、只读）：这个工作区里，**哪些记忆行会被注入给模型**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════════════════════
 * "文件里有" 与 "模型看得到" 是两件事，而这个差别**只在一处代码里**
 * （`memoryLinesFromRaw` + `readMemoryForPrompt` 的过滤/排序/上限）。
 * 于是很容易出现：你明明看到记忆文件里写着某条，模型却像不知道 —— 而且**不会报错**。
 * 这个工具把"到底哪些行进得去、哪些不进、为什么"摊开给人看。
 *
 * ★ 规则**不在这里重写**：直接调 `memoryLinesFromRaw` / `nonInjectableReason`
 *   （"测试/工具里二次实现规则"在这个项目里已经付过两次学费）。
 *
 * 用法：
 *   node mocks/probe-memory-injection.mjs                      # 全部记忆文件
 *   node mocks/probe-memory-injection.mjs private:100000001   # 只看某个会话的注入面
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  INJECT_LIMIT_HINT,
  memoryLinesFromRaw,
  nonInjectableReason,
  readMemoryForPrompt,
} from '../src/memory-store.mjs'
import { isSuperseded } from '../src/memory-supersede.mjs'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function workspaceOf() {
  const cfg = JSON.parse(readFileSync(join(PKG_ROOT, 'config.json'), 'utf8'))
  const ws = String(cfg.dsh?.workspace ?? '')
  if (!ws) throw new Error('config.json 里没有 dsh.workspace')
  return ws
}

function memoryFiles(root) {
  const out = []
  if (existsSync(join(root, 'MEMORY.md'))) out.push('MEMORY.md')
  const dir = join(root, 'memory')
  if (existsSync(dir)) for (const n of readdirSync(dir).sort()) if (n.endsWith('.md')) out.push(`memory/${n}`)
  return out
}

const workspace = workspaceOf()
const only = process.argv[2] ?? null

console.log(`工作区：${workspace}`)
console.log('')

if (only) {
  const [kind, peerId] = String(only).split(':')
  if (kind !== 'private' && kind !== 'group') {
    console.error('会话写法：private:<QQ号> 或 group:<群号>')
    process.exit(2)
  }
  const r = readMemoryForPrompt({ workspace, kind, peerId, log: (m) => console.log(`  ${m}`) })
  console.log(`会话 ${only} 的注入面（${r.files.length} 个文件）：`)
  for (const b of r.blocks) {
    console.log(`  〔${b.label}〕${b.rel}：注入 ${b.shown}/${b.entries} 条${b.more > 0 ? `（另有 ${b.more} 条未展开）` : ''}`)
  }
  console.log('')
  console.log('注入正文：')
  console.log(r.text || '（空 —— 这个会话没有任何记忆会被注入）')
  process.exit(0)
}

let totalLive = 0
for (const rel of memoryFiles(workspace)) {
  const raw = readFileSync(join(workspace, rel), 'utf8').split('\n')
  const injectable = memoryLinesFromRaw(raw)
  const dashOnly = raw.filter((l) => l.trim().startsWith('- ')).length
  const superseded = injectable.filter((t) => isSuperseded(t)).length
  const live = injectable.filter((t) => !isSuperseded(t))
  totalLive += live.length

  const reasons = new Map()
  for (const l of raw) {
    const why = nonInjectableReason(l)
    if (!why) continue
    if (!reasons.has(why)) reasons.set(why, [])
    reasons.get(why).push(String(l).trim().slice(0, 40))
  }

  console.log(`── ${rel}`)
  console.log(
    `   总行 ${raw.length}｜短横线条目 ${dashOnly}｜**会注入的行 ${live.length}**` +
      `（已被更正不注入 ${superseded} 条）｜超上限 ${Math.max(0, live.length - INJECT_LIMIT_HINT)}`,
  )
  for (const [why, samples] of reasons) {
    console.log(`   · 跳过 ${samples.length} 行：${why}${samples[0] ? ` —— 例如「${samples[0]}」` : ''}`)
  }
}
console.log('')
console.log(`合计：${totalLive} 行会被注入（按会话还会再按作用域过滤：群/私聊各看各的）。`)
console.log(
  `规则：**除空行、纯分隔线、以 \`#\` 开头的排版/说明行外，所有非空行都注入**；` +
    `上限 ${INJECT_LIMIT_HINT} 行/文件（超出的只报"另有 N 条未展开"）。`,
)
console.log('想让它被记住就别用 `#` 开头 —— `#` 行按排版处理。')
