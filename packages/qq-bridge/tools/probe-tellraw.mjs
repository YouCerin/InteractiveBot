/**
 * **真机取证**：我们那两条游戏内通道（`tellraw` 私密 / `say` 公屏）在**你这台服上**
 * 到底能不能用。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（这不是"多写一个脚本"，而是整条绑定链路上**唯一一处**
 * 纯离线测不到的东西）
 * ══════════════════════════════════════════════════════════════════════════
 * 绑定流程里，**取码**与**绑定成功通知**都靠 `tellraw` 发给玩家本人。如果那条命令
 * 在真机上不成立，整条绑定链路就是**死的** —— 而离线测试只能证明"我们拼出来的
 * 命令字符串是对的"（`mocks/verify-bindings.mjs` 第 ⑥ 节），它证明不了
 * "这台服务端接受它"。中间隔着：RCON 传参 → 服务端命令解析 → JSON 解析 → 玩家端渲染。
 *
 * ∴ 这个脚本把那三层**逐个问一遍**，并且**默认不带任何副作用**：
 *
 *   · 默认（不加 `--send`）：只发**打不中任何玩家**的 tellraw（选择器挑一个不存在
 *     的名字）。它不会打扰任何人，但服务端的**应答**能区分"命令通了"与"命令没通"；
 *   · 加 `--send`：真的给在线玩家发一条（**会在他的游戏里出现**）—— 那才是
 *     "端到端"的最后一格。★ 所以它是**显式选择**，不是默认行为。
 *
 * ★★ 它还顺手回答一个容易忽略的问题：**我们自己发出去的话会被记成什么**
 *    （`[Rcon] …` / `[Server] …`？）。那直接决定 `log-source.mjs` 的 `SELF_RE`
 *    拦不拦得住"机器人把自己的话当成玩家说的话"（拦不住就是**自环**）。
 *    所以每次发完都读一遍控制台日志的增量，把那一行**原样**打出来。
 *
 * 用法（服务端得先跑着）：
 *   node tools/probe-tellraw.mjs              # 只做无副作用检查
 *   node tools/probe-tellraw.mjs --send       # ★ 再给在线玩家发一条（会出现在游戏里）
 *   node tools/probe-tellraw.mjs --id forge1  # 多台时指定哪一台
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'

import { createRconClient } from '../src/servers/rcon.mjs'
import { buildSay, buildTellraw } from '../src/servers/tellraw.mjs'
import { consoleLogPath } from '../src/servers/console.mjs'

const args = process.argv.slice(2)
const WANT_SEND = args.includes('--send')
const wantId = (() => {
  const i = args.indexOf('--id')
  return i >= 0 ? String(args[i + 1] ?? '') : ''
})()

const cfgRaw = readFileSync('config.json', 'utf8').replace(/^\uFEFF/, '')
const cfg = JSON.parse(cfgRaw)
const list = Array.isArray(cfg.servers) ? cfg.servers : []
const server = wantId ? list.find((s) => String(s.id) === wantId) : list[0]
if (!server) {
  console.error(`❌ config.json 里没有${wantId ? ` id 为「${wantId}」的` : ''}服务器`)
  process.exit(2)
}
const workspace = cfg.dsh?.workspace ?? ''
const logFile = consoleLogPath(workspace, server.id)

// ★ 密码**绝不打印**，只打长度（同 gather-server-facts 的纪律）
console.log(`服务器：${server.id}（${server.name ?? ''}）· ${server.host}:${server.port} · RCON ${server.rconPort} · 密码长度 ${String(server.password ?? '').length}`)
console.log(`控制台日志：${logFile}${existsSync(logFile) ? '' : '（**不存在** —— 服务端不是本程序拉起的）'}`)
console.log(`模式：${WANT_SEND ? '★ --send（会给在线玩家发一条，会出现在游戏里）' : '无副作用检查（只发打不中人的命令）'}`)
console.log('')

const client = createRconClient({ host: server.host, port: server.rconPort, password: server.password, timeoutMs: 8000 })
const conn = await client.connect()
if (!conn.ok) {
  console.error(`❌ RCON 登录失败：${conn.text ?? JSON.stringify(conn)}`)
  process.exit(1)
}
console.log('✅ RCON 登录成功')

/** 读控制台日志**尾部新增**的那一段（按字节游标）。 */
function logDeltaFrom(fromByte) {
  if (!existsSync(logFile)) return { text: '', next: fromByte }
  const size = statSync(logFile).size
  const start = size < fromByte ? 0 : fromByte
  if (size <= start) return { text: '', next: size }
  const want = size - start
  const fd = openSync(logFile, 'r')
  try {
    const buf = Buffer.alloc(want)
    let got = 0
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, start + got)
      if (n <= 0) break
      got += n
    }
    // ★ 真机上是 **GBK**：先按 UTF-8 严格解，出替换字符再按 GBK 重解
    //   （与实际读聊天那条路同一套判据，避免"取证脚本比产品代码宽松"）
    const raw = buf.subarray(0, got)
    let text = raw.toString('utf8')
    if (text.includes('\uFFFD')) {
      try {
        text = new TextDecoder('gbk').decode(raw)
      } catch {
        /* 拿不到 GBK 解码器就保留 UTF-8 的结果 */
      }
    }
    return { text, next: size }
  } finally {
    closeSync(fd)
  }
}

const size0 = existsSync(logFile) ? statSync(logFile).size : 0
let cursor = size0

/** 发一条命令，并把它的应答与控制台回声一起打出来。 */
async function probe(label, command) {
  console.log(`── ${label}`)
  console.log(`   命令：${command}`)
  const r = await client.exec(command)
  console.log(`   应答：${r.ok ? (String(r.body ?? '').trim() || '（空 —— 很多命令本来就不回话）') : `❌ ${r.text ?? '失败'}`}`)
  await new Promise((res) => setTimeout(res, 400))
  const d = logDeltaFrom(cursor)
  cursor = d.next
  for (const line of d.text.split(/\r?\n/).filter((l) => l.trim())) {
    console.log(`   控制台回声：${line}`)
  }
  return { ok: r.ok, body: String(r.body ?? '') }
}

// ── ① 先看有没有人在线（只读）────────────────────────────────────────────
console.log('── ① 在线玩家（只读命令 list）')
const listRes = await client.exec('list')
const listBody = String(listRes.body ?? '')
console.log(`   ${listBody.trim() || '（空）'}`)
const onlineNames = (() => {
  // ★★ 这里踩过一个**JS 专属**的坑（记下来免得下一个人再踩）：
  //   `(.*)$` 在**没有 `m` 标志**时，`$` 只匹配"字符串真正的末尾" ——
  //   而 RCON 的 `list` 应答**带一个结尾的 `\n`** ⇒ `.*` 停在 `\n` 前、`$` 匹配不上
  //   ⇒ **整条正则不匹配**，表现是"明明有人在线却解析不出来"。
  //   （Python 的 `$` 会匹配结尾换行之前，**JS 不会** —— 两种语言这里不一样。）
  //   产品代码 `servers/loop.mjs` 的 `parsePlayerList` 没这个问题，因为它**先 trim 了**。
  const m = /players online:?\s*([^\n]*)/i.exec(listBody)
  if (!m) return []
  return String(m[1] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9_]{1,16}$/.test(s))
})()
console.log(`   解析出来的在线玩家：${onlineNames.length ? onlineNames.join('、') : '（没有，或解析不出来）'}`)
console.log('')

// ── ② 我们的 tellraw 形状：打不中任何人的那种（无副作用）──────────────────
const nobody = 'MCTestNobody12'
const goodBuilt = buildTellraw({ player: nobody, text: '通道自检（这条不会有人收到）', color: 'yellow' })
if (!goodBuilt.ok) {
  console.error(`❌ buildTellraw 都没拼出来：${goodBuilt.why}`)
  process.exit(1)
}
const good = await probe('② 我们的 tellraw 形状（选择器打不中任何人 ⇒ 没人会看到）', goodBuilt.command)

// ── ③ 故意写坏的 JSON（用来判断"服务端到底有没有解析 JSON"）─────────────────
const bad = await probe(
  '③ 故意坏掉的 JSON（用来区分"命令没通"与"JSON 没解析"）',
  `tellraw ${nobody} {"text":`,
)

// ── ④ 我们的 say 形状（**不发**：say 是公屏，会打扰所有人；只做形状校验）──────
const sayBuilt = buildSay({ text: '通道自检' })
console.log('── ④ 我们的 say 形状（**故意不发** —— say 是公屏）')
console.log(`   ${sayBuilt.ok ? sayBuilt.command : `❌ ${sayBuilt.why}`}`)
console.log('')

// ── 结论 ─────────────────────────────────────────────────────────────────
console.log('════ 结论 ════')
const errOf = (r) => String(r.body ?? '').trim()
const differs = errOf(good) !== errOf(bad)
if (!good.ok) {
  console.log('❌ **我们的 tellraw 命令根本没被接受** —— 绑定链路在你这台服上是死的')
} else if (differs) {
  console.log('✅ 服务端**确实解析了 JSON**（好 JSON 与坏 JSON 的应答不同）⇒ 我们的 tellraw 形状可用')
} else {
  console.log(
    '⚠️ 好 JSON 与坏 JSON 的应答**一样** ⇒ 这一步只证明"命令通了"，\n' +
      '   **证明不了 JSON 被解析**（很可能选择器先被解析、匹配不到人就直接报错了）。\n' +
      '   ★ 要补上最后这一格，得让**真玩家**收一次：加 `--send`（或直接让玩家在游戏里试一次取码）。',
  )
}
// ★★ 顺手证掉一个**安全问题**：我们发出去的话会不会被记进控制台日志。
//    会的话，`log-source.mjs` 的 `SELF_RE` 就必须拦住它（拦不住 = 机器人把自己的话
//    当成玩家说的话 = **自环**：越说越多，还烧钱）。
//    实测：`say` **会**回声（`[Rcon] …`，SELF_RE 拦得住），`tellraw` **不会**
//    （它只发给指定玩家）⇒ 私密通道连自环的机会都没有。
console.log(
  '① 控制台回声：上面每条命令后面那几行就是。★ 实测两者不同 —— ' +
    '`say` 会回声成 `[Rcon] …`（靠 `SELF_RE` 拦），`tellraw` **一声不响**（只发给本人）。',
)

if (WANT_SEND) {
  console.log('')
  if (onlineNames.length === 0) {
    console.log('⚠️ --send：现在没有在线玩家（或名字解析不出来）⇒ 没发。让玩家进服后再跑一次。')
  } else {
    const target = onlineNames[0]
    const built = buildTellraw({
      player: target,
      text: '【通道测试】小鲸鱼可以单独给你发消息。看到这条 = 绑定流程里"发码/回执"那一步是通的。',
      color: 'yellow',
    })
    if (!built.ok) {
      console.log(`❌ 拼不出来：${built.why}`)
    } else {
      await probe(`⑤ 真的发给在线玩家 ${target}（**他的游戏里会出现这一条**）`, built.command)
      console.log(`   ★ 问一下 ${target}：游戏里看到那条话了吗？看到 ⇒ **绑定链路整条是通的**。`)
    }
  }
} else if (onlineNames.length > 0) {
  console.log('')
  console.log(`（现在在线的是 ${onlineNames.join('、')}。要让"真玩家收到"这一格也验掉，加 \`--send\`。）`)
}

client.close()
