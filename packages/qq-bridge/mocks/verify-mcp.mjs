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
import { canSpawn } from './harness.mjs'
// ★ 直接 import 被测模块拿**黑名单**（它是纯数据导出，且这个文件只在被当脚本拉起时
//   才启动主循环 —— 见 mcp-qq-server.mjs 末尾的 import.meta 判断，所以 import 是安全的）。
//   为什么要它：`qq_api` 走的是**白名单**，压根到不了黑名单；但黑名单是**第二道网**
//   （具名工具日后被改成危险动作时靠它兜住），所以这两层都要有断言盯着。
import { BLOCKED_ACTIONS } from '../mcp/mcp-qq-server.mjs'

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

/**
 * ★ 环境门槛必须在**任何 spawn 之前**。本文件的 spawn 与协议逻辑原本是顶层代码，
 *   所以这里要放在它们前面（顶层 await 在 ESM 里是允许的）。
 *
 * 为什么值得为它调整文件结构：受限环境（禁止带管道的 spawn）里这套会硬失败，
 * 而失败原因与被测代码无关 —— 那种红会训练人忽略红色，比缺一次回归更糟。
 * 明确跳过并说明"这不算通过"，才是诚实且不误导的做法。
 */
if (!(await canSpawn())) {
  console.log('\n⏭️  跳过 verify-mcp：本环境不允许启动带管道的子进程（EPERM）。')
  console.log('   这不是"通过" —— 请在正常 Windows 会话里重跑：node mocks/verify-mcp.mjs\n')
  process.exit(0)
}

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
  // ★ H14：新增的四个（动作名都是**真机探针**验过的，见 mocks/probe-onebot-actions.mjs）
  for (const want of ['qq_emoji_like', 'qq_typing', 'qq_forward_msg', 'qq_forward_log', 'qq_at_all_remain']) {
    check(`包含 H14 新增工具 ${want}`, names.includes(want))
  }
  check('★★ 每个工具的**描述里都带着**权限提示（写入/只读分开）+ 如实提示',
    tools.every((t) => {
      const d = t.description ?? ''
      const perm = d.includes('只有管理员可以让我做') !== d.includes('只读动作，普通用户也可以用')
      return perm && d.includes('没做成')
    }), tools.filter((t) => !(t.description ?? '').includes('没做成')).map((t) => t.name).join(',') || '（都带了）')
  check('★ 每个工具都有 description（模型靠它决定用不用）',
    tools.every((t) => typeof t.description === 'string' && t.description.length > 10))
  check('★ 每个工具都有 inputSchema（否则模型不知道怎么传参）',
    tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'))
  check('qq_api 的说明里给了动作示例（模型据此探索能力面）',
    /get_group_list/.test(tools.find((t) => t.name === 'qq_api')?.description ?? ''))

  // ══════════════════════════════════════════════════════════════════════
  section('★ 安全：危险动作必须被拦下')
  // ══════════════════════════════════════════════════════════════════════
  // ★★ 措辞纪律（2026-09-30 修）：这个服务器有**两道闸**，回绝的话术**不一样**：
  //     ① `qq_api`（万能口）走**只读白名单**（fail-closed）→ "这个动作不在允许清单里：X。…"
  //     ② 具名工具命中**黑名单** → "我这边把这个动作禁用了：X（…）。我不会自己绕过这条限制。"
  //   这两句里只有 ② 带"禁用"二字。这里的断言原来只认"禁用"，于是白名单上线（0.2.2）之后
  //   本套件 7 项全红 —— 而它一直**静默跳过**（受限沙箱不能起子进程），所以谁也没发现。
  //   现在两句都认，并且**分别**盯住两道闸（下面每条动作额外断言它仍在黑名单里）。
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
    check(
      `拦截 ${action}`,
      res.result?.isError === true && /不在允许清单|禁用了/.test(text),
      text.split('\n')[0],
    )
    check(
      `★ ${action} 同时在黑名单里（第二道网，具名工具靠它兜底）`,
      Object.prototype.hasOwnProperty.call(BLOCKED_ACTIONS, action),
      BLOCKED_ACTIONS[action] ?? '⚠️ 不在黑名单',
    )
  }
  check('★ 拦截提示说明理由（不是一句冷冰冰的失败）',
    /只读|投递链|禁用了/.test(textOf(await callTool('qq_api', { action: 'set_group_kick', params: {} }))))
  check('★ 拦截提示给的是**安全替代**（回复 / qq_send_image），不是绕过办法',
    /qq_send_image/.test(textOf(await callTool('qq_api', { action: 'delete_friend', params: {} }))))

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

/**
 * ★ 环境门槛：本套件整节都依赖"起一个 MCP 服务器子进程"，受限环境里跑不了。
 *   （真正的门槛在上面、spawn 之前；这里这段是给"结构上容易误读"留的说明。）
 */
main().catch((error) => {
  console.error('测试脚本自身崩了：', error)
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
