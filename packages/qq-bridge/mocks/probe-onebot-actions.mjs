#!/usr/bin/env node
/**
 * OneBot 动作探针（**真机**、只读）：某个动作名这台协议端到底支不支持。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════════════════════
 * `mcp-qq-server.mjs` 里的每个具名工具（`qq_poke` / `qq_emoji_like` / …）都对应一个
 * **真实的 OneBot 动作名**，而动作名各协议端不一样（go-cqhttp / NapCat / SnowLuma /
 * Lagrange 各有取舍）。**猜错动作名的后果是"工具在模型那里存在、一调就失败"** ——
 * 而那看起来像"机器人坏了"，不是"这个动作不支持"。
 *
 * `qq_api` 那条万能通道虽然能兜底，但代价是模型得**先知道**动作名。所以本探针回答
 * 一个很具体的问题：**这台机器现在支持哪些动作**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 纪律：**绝不产生副作用**
 * ══════════════════════════════════════════════════════════════════════════
 * 只调**查询类**动作；对"会发消息/会改状态"的动作**只发空参**（必然被拒，不会生效）。
 * 判读要点：**"参数错误"与"不支持"必须分开** —— 前者恰恰说明动作存在。
 * 所以内置一组负对照（一个一定不存在的动作名），用来对照措辞。
 *
 * 用法：
 *   node mocks/probe-onebot-actions.mjs                  # 探内置候选
 *   node mocks/probe-onebot-actions.mjs get_status x y   # 只探指定的几个
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverOnebotConfig } from '../src/token-discovery.mjs'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const CANDIDATES = [
  // ①② 对照组：现有工具已经在用这两个，用来确认"探针本身是对的"
  'get_status',
  'get_version_info',
  // ③~⑦ H14 想加的具名工具对应的动作名（**都还没写进 MCP**，先探）
  'set_msg_emoji_like',
  'set_input_status',
  'forward_friend_single_msg',
  'forward_group_single_msg',
  'send_forward_msg',
  'get_forward_msg',
  // ⑧ 负对照：这个名字一定不存在
  '__definitely_not_an_action__',
]

/** 读端点与 token：复用 `src/token-discovery.mjs`（那一套保守读法已经有 53 项测试盯着）。 */
function resolveEndpoint() {
  const cfgPath = join(PKG_ROOT, 'config.json')
  if (!existsSync(cfgPath)) throw new Error(`找不到 ${cfgPath}`)
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  const httpUrl = String(cfg.onebot?.httpUrl ?? '')
  if (!httpUrl) throw new Error('config.json 里没有 onebot.httpUrl')
  const selfId = String(cfg.onebot?.selfId ?? '').trim()
  const known = { httpToken: cfg.onebot?.accessToken, wsToken: cfg.onebot?.wsToken }
  // ★ 安装目录按 config 的 `snowluma.installDir` 解析（**相对包根**），再退回几个常规位置。
  //   ⚠️ 这里踩过一次：探针第一版写死 `join(PKG_ROOT, 'snowluma')`，而配置里是 `../../snowluma`
  //      —— 于是 token 一个都没取到，所有动作全是 401，看起来像"协议端不支持"。
  //      **"取不到凭据"和"动作不存在"必须能从输出里分开**，所以下面把来源打出来。
  const declared = String(cfg.snowluma?.installDir ?? '').trim()
  const candidates = [
    declared ? join(PKG_ROOT, declared) : null,
    join(PKG_ROOT, 'vendor', 'snowluma'),
    join(PKG_ROOT, '..', '..', 'snowluma'),
  ].filter(Boolean)
  for (const dir of candidates) {
    const found = discoverOnebotConfig({ installDir: dir, selfId, knownTokens: known })
    if (found.ok) return { httpUrl, token: found.httpToken ?? '', selfId, picked: `${found.picked} @ ${dir}` }
  }
  return { httpUrl, token: '', selfId, picked: `none（试过：${candidates.join(' / ')}）` }
}

async function probe(base, token, action) {
  const res = await fetch(`${base}${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: '{}',
    signal: AbortSignal.timeout(8000),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 就按文本处理 */
  }
  return { http: res.status, json, text }
}

function verdictOf({ http, json, text }) {
  const blob = `${json?.message ?? ''} ${json?.wording ?? ''} ${text ?? ''}`
  // ① 明确"不支持这个 API"（各端措辞不同，这里把见过的几种都算上）
  if (/不支持的?\s*API|unsupported|unknown action|not support|没有这个接口|无法识别的动作/i.test(blob)) {
    return { verdict: '❌ 不支持', why: blob.trim().slice(0, 60) }
  }
  // ② 参数错误 → **动作存在**（这是本探针最关键的一条判读）
  if (/参数|param|missing|required|invalid|缺少|不能为空/i.test(blob)) {
    return { verdict: '✅ 存在（要参数）', why: blob.trim().slice(0, 60) }
  }
  if (json?.status === 'ok' || json?.retcode === 0) return { verdict: '✅ 支持', why: '' }
  if (http === 404) return { verdict: '❌ 不支持（HTTP 404）', why: blob.trim().slice(0, 60) }
  return { verdict: '⚠️ 需人工判读', why: `http=${http} retcode=${json?.retcode ?? '?'} ${blob.trim().slice(0, 60)}` }
}

async function main() {
  const { httpUrl, token, selfId, picked } = resolveEndpoint()
  const base = httpUrl.endsWith('/') ? httpUrl : `${httpUrl}/`
  console.log(`端点：${base}`)
  console.log(`账号：${selfId || '(未配置)'}  token：${token ? '已取到' : '⚠️ 没取到'}  来源：${picked}`)
  console.log('')
  const args = process.argv.slice(2)
  const list = args.length ? args : CANDIDATES
  for (const action of list) {
    let out
    try {
      out = await probe(base, token, action)
    } catch (error) {
      console.log(`${action.padEnd(30)} ⚠️ 请求失败：${error?.message ?? error}`)
      continue
    }
    const v = verdictOf(out)
    console.log(`${action.padEnd(30)} ${v.verdict.padEnd(14)} ${v.why}`)
  }
  console.log('')
  console.log('判读纪律：**"参数错误"说明动作存在**（我们故意只发空参，不产生副作用）。')
  console.log('         负对照 `__definitely_not_an_action__` 的措辞是"不支持"的基准。')
}

main().catch((error) => {
  console.error('探针自身失败：', error?.message ?? error)
  process.exit(1)
})
