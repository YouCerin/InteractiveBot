#!/usr/bin/env node
/**
 * QQ 工具 MCP 服务器的协议测试。
 *
 * ── 测什么 ─────────────────────────────────────────────────────────────
 * 这个服务器是**手写的 MCP 协议实现**（因为官方 SDK 依赖太重，会破坏
 * 本项目的可搬迁性）。手写协议最容易错的地方就是帧格式与握手，
 * 所以这里真的把它当子进程拉起来、走 stdio 对话。
 *
 * 同时验证**安全策略**：危险动作（踢人/禁言/删好友…）必须被拦下，
 * 而且拦截提示不能让人以为"可以绕过"。
 *
 * 不需要真 QQ、不花钱：故意把 OneBot 端点指向一个不存在的地址 ——
 * 这样"放行的动作"会走网络并失败，正好用来验证错误路径。
 *
 * 用法：node mocks/verify-mcp.mjs
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createInterface } from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const SERVER = join(PKG_ROOT, 'mcp', 'mcp-qq-server.mjs')
const CACHE = join(PKG_ROOT, '.tmp-verify-mcp')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
const section = (t) => console.log(`\n── ${t} ──`)

rmSync(CACHE, { recursive: true, force: true })
mkdirSync(CACHE, { recursive: true })

// 故意指向一个不存在的端口：放行的动作会在网络层失败，
// 正好用来验证"错误被正确报出来"，而不是真的去动 QQ。
const CONFIG = join(CACHE, 'mcp-qq.config.json')
writeFileSync(
  CONFIG,
  JSON.stringify({ httpUrl: 'http://127.0.0.1:9', httpToken: '', timeoutMs: 1500 }, null, 2),
)

const child = spawn(process.execPath, [SERVER, '--config', CONFIG], {
  stdio: ['pipe', 'pipe', 'pipe'],
})
const stderrLines = []
child.stderr.setEncoding('utf8')
child.stderr.on('data', (d) => {
  for (const l of String(d).split(/\r?\n/)) if (l.trim()) stderrLines.push(l.trim())
})

const pending = new Map()
let nextId = 0
const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
rl.on('line', (line) => {
  const t = line.trim()
  if (!t) return
  let msg
  try {
    msg = JSON.parse(t)
  } catch {
    console.log(`   （stdout 出现非 JSON：${t.slice(0, 120)}）`)
    return
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    p(msg)
  }
})

function rpc(method, params, timeoutMs = 8000) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`RPC ${method} 超时`))
    }, timeoutMs)
    pending.set(id, (m) => {
      clearTimeout(timer)
      resolve(m)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

const callTool = (name, args) => rpc('tools/call', { name, arguments: args })
const textOf = (r) => r?.result?.content?.map((c) => c.text ?? '').join('\n') ?? ''

async function main() {
  console.log('\n═══ QQ 工具 MCP 服务器 · 协议与安全测试 ═══')

  // ══════════════════════════════════════════════════════════════════════
  section('握手（MCP 客户端第一件事就是 initialize）')
  // ══════════════════════════════════════════════════════════════════════
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'verify', version: '1' },
  })
  check('initialize 有应答', Boolean(init.result), JSON.stringify(init).slice(0, 120))
  check('返回 protocolVersion', typeof init.result?.protocolVersion === 'string', init.result?.protocolVersion)
  check('声明了 tools 能力', Boolean(init.result?.capabilities?.tools))
  check('返回 serverInfo.name', init.result?.serverInfo?.name === 'qq-bridge-qq-tools', init.result?.serverInfo?.name)
  check('协议帧走 stdout（stderr 只放日志）',
    stderrLines.some((l) => l.includes('已启动')),
    stderrLines[0] ?? '（stderr 为空）')

  // ══════════════════════════════════════════════════════════════════════
  section('工具清单')
  // ══════════════════════════════════════════════════════════════════════
  const list = await rpc('tools/list', {})
  const tools = list.result?.tools ?? []
  check('tools/list 返回数组', Array.isArray(tools) && tools.length > 0, `${tools.length} 个`)

  const names = tools.map((t) => t.name)
  for (const want of ['qq_poke', 'qq_send_sticker', 'qq_recall', 'qq_group_members', 'qq_api']) {
    check(`包含工具 ${want}`, names.includes(want))
  }
  check('★ 每个工具都有 description（模型靠它决定用不用）',
    tools.every((t) => typeof t.description === 'string' && t.description.length > 10))
  check('★ 每个工具都有 inputSchema（否则模型不知道怎么传参）',
    tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'))
  check('qq_api 的说明里给了动作示例（模型据此探索能力面）',
    /get_group_list/.test(tools.find((t) => t.name === 'qq_api')?.description ?? ''))

  // ══════════════════════════════════════════════════════════════════════
  section('★ 安全：危险动作必须被拦下')
  // ══════════════════════════════════════════════════════════════════════
  const dangerous = [
    ['set_group_kick', { group_id: 1, user_id: 2 }],
    ['set_group_ban', { group_id: 1, user_id: 2, duration: 60 }],
    ['delete_friend', { user_id: 2 }],
    ['set_group_leave', { group_id: 1 }],
    ['set_group_card', { group_id: 1, user_id: 2, card: 'x' }],
    ['set_qq_profile', { nickname: 'x' }],
  ]
  for (const [action, params] of dangerous) {
    const res = await callTool('qq_api', { action, params })
    const text = textOf(res)
    check(`拦截 ${action}`, res.result?.isError === true && /禁用/.test(text), text.split('\n')[0])
  }
  check('★ 拦截提示说明理由（不是一句冷冰冰的失败）',
    /会/.test(textOf(await callTool('qq_api', { action: 'set_group_kick', params: {} }))))
  check('★ 拦截提示不鼓励绕过',
    /不会自己绕过/.test(textOf(await callTool('qq_api', { action: 'delete_friend', params: {} }))))

  // ══════════════════════════════════════════════════════════════════════
  section('放行的动作：会真的去调 OneBot（这里故意指向不存在的端点）')
  // ══════════════════════════════════════════════════════════════════════
  const allowed = await callTool('qq_api', { action: 'get_group_list', params: {} })
  check('放行的动作没被黑名单拦（走了网络）',
    !/禁用/.test(textOf(allowed)), textOf(allowed).split('\n')[0])
  check('★ 网络失败被如实报出来（不是假装成功）',
    allowed.result?.isError === true && /失败|超时/.test(textOf(allowed)),
    textOf(allowed).split('\n')[0])

  // 具名工具也应走同一条链路
  const poke = await callTool('qq_poke', { peerId: '12345' })
  check('qq_poke 走网络（未被误拦）', !/禁用/.test(textOf(poke)), textOf(poke).split('\n')[0])

  // ══════════════════════════════════════════════════════════════════════
  section('健壮性')
  // ══════════════════════════════════════════════════════════════════════
  const unknown = await callTool('qq_不存在', {})
  check('未知工具 → 明确报错而不是崩',
    unknown.result?.isError === true && /没有这个工具/.test(textOf(unknown)), textOf(unknown))

  const noAction = await callTool('qq_api', {})
  check('qq_api 缺 action 参数不崩', Boolean(noAction.result))

  const ping = await rpc('ping', {})
  check('ping 有应答（MCP 里是可选探活）', ping.result !== undefined)

  const bad = await rpc('不存在的method', {})
  check('未知方法 → JSON-RPC 错误码 -32601', bad.error?.code === -32601, JSON.stringify(bad.error))

  // ══════════════════════════════════════════════════════════════════════
  section('收尾')
  // ══════════════════════════════════════════════════════════════════════
  child.stdin.end()
  await new Promise((r) => setTimeout(r, 400))
  check('stdin 关闭后进程退出', child.exitCode !== null || child.killed, `exitCode=${child.exitCode}`)
  rmSync(CACHE, { recursive: true, force: true })

  console.log(`\n${failures === 0 ? '🎉 MCP 服务器测试全部通过' : `⚠️ ${failures} 项失败`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('测试脚本自身崩了：', error)
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
