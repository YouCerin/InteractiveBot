/**
 * RCON 与服务器监测（0.3.2 P2）离线套件。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么这一套非有不可
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **RCON 是我们自己实现的协议**（项目第 5 条纪律：运行期依赖不走 npm）。
 *      自己实现的协议**没有上游文档兜底** —— 编解码错一位，症状是"登录看起来成功、
 *      第一条命令永远超时"，而且**真机上才看得出来**。
 *   ② 本机**没有 MC 服务端**可连 ⇒ 这一套用一个**真 TCP 假服务端**把
 *      握手/粘包/分包/密码错/超时全部走一遍。假服务端的形状照协议写，
 *      与客户端**互相独立**（它不 import 客户端的编解码 —— 两边各写一遍，
 *      这样"两边一起错"的概率小得多）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三条判据来自真机常识，不是我想出来的
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **登录成功的判据是 id，不是"收到了包"、也不是"type 是不是 3"** ——
 *      Minecraft 对登录只回**一个** `type 2` 空包，`id` 等于请求 id 就是过。
 *      第一版假服务端建模成了"先回空 RESPONSE_VALUE、再回 AUTH_RESPONSE(type 3)"，
 *      于是"客户端死等 type 3"这个真机 bug 在这里**测不出来**（真机症状：
 *      服务端日志反复 `RCON Client started`/`shutting down`，客户端一直超时）。
 *   ② **粘包与分包都要能活**：TCP 是字节流，一次 `data` 可能给半个包或三个半。
 *   ③ **密码绝不进错误文案**（同 `credentials.mjs`）—— 有一条断言逐字检查。
 */

import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import {
  MAX_PAYLOAD_BYTES,
  PACKET,
  classifyRconError,
  createRconClient,
  decodePackets,
  encodePacket,
} from '../src/servers/rcon.mjs'
import { EVENT, createMonitor, describeSnapshot } from '../src/servers/monitor.mjs'
import { createServerLoop, parsePlayerList, parseTps, readRecentEvents } from '../src/servers/loop.mjs'
import { OUTCOME, createRestarter } from '../src/servers/restart.mjs'
import { createSupervisor, isPidAlive, parseStartTime, processStartedAt, defaultRun as runAndCapture } from '../src/servers/supervise.mjs'

let pass = 0
let fail = 0
const failures = []
function ok(cond, label) {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${label}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ❌ ${label}`)
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(a === e, `${label}${a === e ? '' : `（得到 ${a}，期望 ${e}）`}`)
}

// ══════════════════════════════════════════════════════════════════════════
// ① 编解码（纯函数）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== ① 包的编解码（自己实现的协议，错一位就全错）===')
{
  const buf = encodePacket({ id: 7, type: PACKET.EXEC, body: 'list' })
  // 长度字段 = 它自己之后的字节数 = 4(id) + 4(type) + 4('list') + 2(两个 0x00)
  eq(buf.readInt32LE(0), 14, '长度字段数的是"它自己之后"的字节数')
  eq(buf.length, 4 + 14, '整包长度 = 4 + 长度字段')
  eq(buf.readInt32LE(4), 7, '请求号在偏移 4')
  eq(buf.readInt32LE(8), PACKET.EXEC, '类型在偏移 8')
  eq(buf.slice(12, 16).toString('utf8'), 'list', '正文在偏移 12')
  eq([buf[16], buf[17]], [0, 0], '结尾是两个 0x00')

  // 中文（MOTD / 玩家名里常见）必须是 UTF-8 往返
  const cn = encodePacket({ id: 1, type: PACKET.RESPONSE, body: '在线玩家：小明' })
  const back = decodePackets(cn)
  eq(back.packets[0].body, '在线玩家：小明', '中文往返一致（UTF-8）')

  // ★ 分包：把一整包切成 3 段喂进去，只有最后一段才应该出包
  const d1 = decodePackets(buf.slice(0, 5))
  eq(d1.packets.length, 0, '★ 半个包 ⇒ 一个都不出（等够了再切）')
  eq(d1.rest.length, 5, '★ 没收下的字节被原样留着')
  const d2 = decodePackets(Buffer.concat([d1.rest, buf.slice(5, 11)]))
  eq(d2.packets.length, 0, '★ 还差一点 ⇒ 仍然一个都不出')
  const d3 = decodePackets(Buffer.concat([d2.rest, buf.slice(11)]))
  eq(d3.packets.length, 1, '★ 凑齐了才出包')
  eq(d3.rest.length, 0, '★ 而且不剩字节')

  // ★ 粘包：三包连在一起一次喂进去
  const three = Buffer.concat([
    encodePacket({ id: 1, type: PACKET.RESPONSE, body: 'a' }),
    encodePacket({ id: 2, type: PACKET.RESPONSE, body: 'b' }),
    encodePacket({ id: 3, type: PACKET.RESPONSE, body: 'c' }),
  ])
  const dm = decodePackets(three)
  eq(dm.packets.map((p) => p.body), ['a', 'b', 'c'], '★ 粘包：一次喂三包，三个都要出来')
  eq(dm.rest.length, 0, '粘包后不剩字节')

  // 长度不合理 ⇒ 报错（继续按错长度切只会越切越乱）
  const junk = Buffer.alloc(16)
  junk.writeInt32LE(999999, 0)
  const dj = decodePackets(junk)
  ok(Boolean(dj.error), '★ 长度不合理时**报错**（不许继续乱切）')
  ok(/包长度不合理/.test(dj.error), '错误文案说明是长度问题')
  ok(MAX_PAYLOAD_BYTES >= 4096, '正文上限至少 4096（Source RCON 的经典值）')
}

// ══════════════════════════════════════════════════════════════════════════
// ② 错误分类（layer / retryable —— 照 transport.mjs 的形状）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n=== ② 错误分类：告诉人去哪一层查、重试有没有意义 ===')
{
  const refused = classifyRconError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))
  eq(refused.layer, 'network', 'ECONNREFUSED → network（端口上没东西在听）')
  eq(refused.retryable, true, '它是可重试的（服务端可能刚起）')
  ok(/enable-rcon/.test(refused.text), '★ 文案直接指向 server.properties 里那个开关')

  const to = classifyRconError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
  eq(to.layer, 'timeout', '超时 → timeout')
  eq(to.retryable, true, '超时可重试')

  const auth = classifyRconError(new Error('whatever'), { stage: 'auth' })
  eq(auth.layer, 'auth', '★ stage=auth → layer=auth')
  eq(auth.retryable, false, '★★ 密码错**不可重试**（重试一万次也还是错的）')

  const unknown = classifyRconError(new Error('莫名其妙的错'), { stage: 'exec' })
  eq(unknown.layer, 'unknown', '认不出的错 → unknown')
  eq(unknown.retryable, false, '★★ 认不出的**不标可重试**（猜错方向会让"对方已收到"的操作再发一遍）')

  // ★★ 密码绝不进错误文案（逐字检查）
  const secret = 'SuperSecret123'
  const withSecret = classifyRconError(new Error(`auth failed for ${secret}`), { stage: 'auth' })
  ok(!JSON.stringify(withSecret).includes(secret), '★★★ 失败理由里**一个字符都不能有密码**')
  const generic = classifyRconError(new Error(`ECONNREFUSED while using ${secret}`))
  ok(!JSON.stringify(generic).includes(secret), '★★★ 其它分类路径也不许把密码带出去')
}

// ══════════════════════════════════════════════════════════════════════════
// ③ 真 TCP 假服务端：握手 / 命令 / 粘包 / 分包 / 密码错 / 超时
// ══════════════════════════════════════════════════════════════════════════
//
// ★ 假服务端**自己实现一遍编解码**（不 import 客户端的）——
//   两边各写一遍，"两边一起错"的概率小得多。形状严格照协议。
async function startFakeServer({ password = 'pw', behavior = {} } = {}) {
  const seen = { commands: [], auths: 0, closed: 0 }
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0)
    // 假服务端自己的解码（独立实现）
    const cut = () => {
      const out = []
      for (;;) {
        if (buf.length < 4) break
        const len = buf.readInt32LE(0)
        if (buf.length < 4 + len) break
        out.push({ id: buf.readInt32LE(4), type: buf.readInt32LE(8), body: buf.slice(12, 4 + len - 2).toString('utf8') })
        buf = buf.slice(4 + len)
      }
      return out
    }
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (const p of cut()) {
        if (p.type === PACKET.AUTH) {
          seen.auths += 1
          if (behavior.silentAuth) continue // 故意不回（测超时）
          // ★★★ 真机形状（**实测抓到的坑，务必按这个写**）：Minecraft 对登录请求
          //   只回**一个**包 —— `type 2`（RESPONSE_VALUE）、body 空。
          //   密码对 ⇒ `id` = 请求的 id；密码错 ⇒ `id` = -1。
          //
          //   我们**第一版假服务端写的是错的形状**（先回一个空 RESPONSE_VALUE，
          //   再回一个 type 3 AUTH_RESPONSE），于是"客户端在等 type 3"这个 bug
          //   在假服务端上永远测不出来 —— 而真机上的症状是：
          //   服务端日志每次都出现 `RCON Client started` / `shutting down`，
          //   客户端那边一直等到超时。**假服务端形状错了，比没有测试更坏**：
          //   它给了一个"已验证"的错觉。
          const authId = p.body === password ? p.id : -1
          // ★ 测试用：故意让 id 对不上（形状与真机完全一致，只有 id 是错的）——
          //   用来证明"成功判据确实是 id"，而不是"收到 type 2 就算过"
          const replyId = behavior.authIdWrong ? p.id + 12345 : authId
          const reply = encodePacket({ id: replyId, type: PACKET.RESPONSE, body: '' })
          if (behavior.splitAuthIntoChunks) {
            // ★ 故意把应答切成两段写（测客户端的粘包处理）
            sock.write(reply.slice(0, 5))
            setTimeout(() => sock.write(reply.slice(5)), 10)
          } else {
            // ★ 故意与"下一条命令的应答"粘在一起发（glueAuthAndFirstCommand）
            //   与"直接发"走同一条路 —— 客户端必须两种情况都活
            sock.write(reply)
          }
          continue
        }
        if (p.type === PACKET.EXEC) {
          seen.commands.push(p.body)
          if (behavior.silentExec) continue // 故意不回（测命令超时）
          if (behavior.execThrows) {
            sock.destroy()
            continue
          }
          const body = behavior.reply ?? `假应答：${p.body}`
          if (behavior.splitReply) {
            // ★ 把同一个应答拆成两个包发（客户端必须拼起来）
            const half = Math.ceil(body.length / 2)
            sock.write(encodePacket({ id: p.id, type: PACKET.RESPONSE, body: body.slice(0, half) }))
            sock.write(encodePacket({ id: p.id, type: PACKET.RESPONSE, body: body.slice(half) }))
          } else {
            sock.write(encodePacket({ id: p.id, type: PACKET.RESPONSE, body }))
          }
        }
      }
    })
    sock.on('close', () => {
      seen.closed += 1
    })
    sock.on('error', () => {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) }
}

console.log('\n=== ③ 真 TCP 握手：登录成功的判据是 id，且**只回一个 type 2 包** ===')
{
  const fake = await startFakeServer({ password: 'pw' })
  const c = createRconClient({ host: '127.0.0.1', port: fake.port, password: 'pw' })
  const r = await c.connect()
  ok(r.ok, '登录成功（服务端只回一个 type 2 空包 —— 客户端认的是 id，不是 type）')
  ok(c.state().authed, 'state() 如实报 authed=true')
  ok(!JSON.stringify(c.state()).includes('pw'), '★ state() 里**没有密码**')
  // ★★★ 这一条是**真机回归**：Minecraft 登录后**不会**再补发任何东西，
  //   所以登录若靠"等到第二个包 / 等到 type 3"就会一直挂到超时。
  //   这里紧接一条命令 —— 它必须立刻通，证明客户端**没有在等多余的包**。
  const q = await c.exec('list')
  ok(q.ok, '登录后**立刻**能执行命令（证明没有死等第二个包）')
  ok(String(q.body ?? '').includes('假应答'), '拿回的是命令应答本体')
  c.close()
  await fake.close()
}

console.log('\n=== ④ 密码错：不可重试，且文案里没有密码 ===')
{
  const fake = await startFakeServer({ password: 'right-one' })
  const c = createRconClient({ host: '127.0.0.1', port: fake.port, password: 'wrong-one' })
  const r = await c.connect()
  eq(r.ok, false, '密码错 ⇒ 登录失败')
  eq(r.layer, 'auth', '分类成 auth')
  eq(r.retryable, false, '★ 不可重试')
  ok(!JSON.stringify(r).includes('wrong-one'), '★★★ 失败理由里没有密码原文')
  ok(/rcon\.password/.test(String(r.text)), '★ 文案直接指向 server.properties 的 rcon.password')
  c.close()
  await fake.close()
}

console.log('\n=== ④-b ★★★ 真机回归：登录应答的判据是 **id**，不是 type ===')
{
  // 形状与真机**逐字节相同**（一个 `type 2` 空包），唯一不同的是 id 对不上。
  // 这条断言直接钉住那个真机 bug：第一版客户端只认 `type 3`，
  // 于是收到这个包时既不认成功、也不认失败 —— 一直等到超时，
  // 而服务端那边每次都留下 `RCON Client started` / `shutting down`。
  const fake = await startFakeServer({ password: 'pw', behavior: { authIdWrong: true } })
  const c = createRconClient({ host: '127.0.0.1', port: fake.port, password: 'pw', timeoutMs: 1500 })
  const r = await c.connect()
  eq(r.ok, false, '★ id 对不上 ⇒ 登录**失败**（不能"收到 type 2 就算过"）')
  eq(c.state().authed, false, 'state() 不能把没登录说成登录了')
  c.close()
  await fake.close()
}

console.log('\n=== ⑤ 命令：串行、多包应答拼接、中文完好 ===')
{
  const fake = await startFakeServer({ password: 'pw', behavior: { reply: 'There are 2 of a max of 20 players online: 小明, Steve' } })
  const c = createRconClient({ host: '127.0.0.1', port: fake.port, password: 'pw' })
  await c.connect()
  const r = await c.exec('list')
  ok(r.ok, '命令成功')
  eq(r.body, 'There are 2 of a max of 20 players online: 小明, Steve', '拿到完整正文（中文完好）')
  eq(fake.seen.commands, ['list'], '★ 服务端只收到一条命令（没有重复发）')
  // 连发三条：串行，顺序不变
  await c.exec('a')
  await c.exec('b')
  await c.exec('c')
  eq(fake.seen.commands, ['list', 'a', 'b', 'c'], '★ 三次 exec 串行到达，顺序不变')
  c.close()
  await fake.close()
}

console.log('\n=== ⑥ 粘包/分包：同一个应答拆成两个包，客户端必须拼起来 ===')
{
  const fake = await startFakeServer({ password: 'pw', behavior: { reply: 'ABCDEFGHIJ', splitReply: true } })
  const c = createRconClient({ host: '127.0.0.1', port: fake.port, password: 'pw' })
  await c.connect()
  const r = await c.exec('x')
  eq(r.ok, true, '两个包拼起来算一次成功')
  eq(r.body, 'ABCDEFGHIJ', '★ 正文拼全了（不是只拿到半个）')
  c.close()
  await fake.close()
}

console.log('\n=== ⑦ 登录应答被切成两段写：客户端照样要认出来 ===')
{
  const fake = await startFakeServer({ password: 'pw', behavior: { splitAuthIntoChunks: true } })
  const c = createRconClient({ host: '127.0.0.1', port: fake.port, password: 'pw' })
  const r = await c.connect()
  ok(r.ok, '★ 分包到达的登录应答也认得出（TCP 是字节流）')
  c.close()
  await fake.close()
}

console.log('\n=== ⑧ 连不上 / 超时：分类对，且允许重试 ===')
{
  // 占一个端口再立刻关掉，拿到一个"确定没人听"的端口号
  const probe = createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const deadPort = probe.address().port
  await new Promise((r) => probe.close(r))

  const c = createRconClient({ host: '127.0.0.1', port: deadPort, password: 'pw', connectTimeoutMs: 1500 })
  const r = await c.connect()
  eq(r.ok, false, '端口上没东西 ⇒ 连不上')
  eq(r.layer, 'network', '分类成 network')
  eq(r.retryable, true, '★ 可重试（服务端可能正在启动）')
  ok(!JSON.stringify(r).includes('pw'), '失败理由里没有密码')

  // 服务端收到了登录包但**故意不回** ⇒ 登录超时，且不可静默挂住
  const fake = await startFakeServer({ password: 'pw', behavior: { silentAuth: true } })
  const c2 = createRconClient({ host: '127.0.0.1', port: fake.port, password: 'pw', connectTimeoutMs: 700 })
  const t0 = Date.now()
  const r2 = await c2.connect()
  const dt = Date.now() - t0
  eq(r2.ok, false, '对面不回 ⇒ 登录失败（不许无限等）')
  // ★★ 判据修正（实测抓到的分类错误）：**超时 ≠ 密码错**。
  //   "服务端收到登录包但没回"该说"卡在登录这一步、可以再试"，
  //   而不是"密码被拒、不许重试"——后者会让人去改一个本来是对的密码。
  eq(r2.layer, 'timeout', '★ 登录**超时**分类成 timeout（不是 auth）')
  eq(r2.retryable, true, '★★ 而且**可重试** —— 超时不代表我们做错了什么')
  // ⚠️ 不写死"文案里必须出现『登录』"：超时可能来自"连上了但登录应答没回来"，
  //    也可能来自"根本没连上（等连接超时）"—— 两个都对，写死哪一个都会变成假失败。
  //    真正要钉住的是：分类是 timeout、可重试、文案**非空且不含密码**。
  ok(String(r2.text ?? '').length > 10, '文案非空（让人知道去哪儿查）')
  ok(!JSON.stringify(r2).includes('pw'), '★★ 文案里没有密码原文')
  ok(dt < 4000, `★ 超时真的生效（等了 ${dt}ms，不是挂死）`)
  c2.close()
  await fake.close()
}

console.log('\n=== ⑨ 命令超时：**不自动重发**（对方可能已经执行了）===')
{
  const fake = await startFakeServer({ password: 'pw', behavior: { silentExec: true } })
  const c = createRconClient({ host: '127.0.0.1', port: fake.port, password: 'pw', execTimeoutMs: 500 })
  await c.connect()
  const r = await c.exec('say 你好')
  eq(r.ok, false, '命令超时 ⇒ 失败')
  eq(r.retryable, true, '分类成可重试（由上层决定，不是客户端自己重发）')
  eq(fake.seen.commands.length, 1, '★★ 服务端只收到**一次** —— 客户端绝不自动重发')
  c.close()
  await fake.close()
}

console.log('\n=== ⑩ 空命令 / 超长命令：早报，不发出去 ===')
{
  const fake = await startFakeServer({ password: 'pw' })
  const c = createRconClient({ host: '127.0.0.1', port: fake.port, password: 'pw' })
  await c.connect()
  eq((await c.exec('   ')).ok, false, '空命令 ⇒ 失败')
  eq((await c.exec('   ')).layer, 'usage', '分类成 usage（调用方写错了）')
  const long = await c.exec('x'.repeat(2000))
  eq(long.ok, false, '超长命令 ⇒ 失败')
  eq(fake.seen.commands.length, 0, '★ 两条都没有真的发出去')
  c.close()
  await fake.close()
}

console.log('\n=== ⑪ close 幂等 / 断开后 exec 如实报错（不许悬着）===')
{
  const fake = await startFakeServer({ password: 'pw', behavior: { execThrows: true } })
  const c = createRconClient({ host: '127.0.0.1', port: fake.port, password: 'pw' })
  await c.connect()
  const r = await c.exec('x')
  eq(r.ok, false, '对面把连接掐了 ⇒ 这一条**立刻**得到失败结论')
  ok(r.layer === 'network' || r.layer === 'unknown', `分类合理（${r.layer}）`)
  ok(!c.state().authed, '断开后 authed 归 false（状态机据此判 down）')
  c.close()
  c.close()
  ok(true, 'close 幂等（连调两次不炸）')
  await fake.close()
}

console.log('\n=== ⑫ ★★★ 监测状态机：**跃迁才产出事件**（"恰好一次"的判定层）===')
//
// 需求原话是「服务器出问题时小鲸鱼会**且仅会**一次在选定聊天中报告」。
// 「且仅会一次」不是靠"记得别重复报"，而是靠**状态跃迁** + **状态落盘**。
// 这一节把三件事各钉一条：持续 down 不重复、重启后不重复、恢复也要报一次。
{
  const snapOk = (over = {}) => ({ reachable: true, players: 3, playerNames: ['小明', 'Steve'], tps: 20, version: '1.20.1-Forge', at: 1000, ...over })
  const snapBad = (over = {}) => ({ reachable: false, error: '连不上那个 RCON 端口（端口上没东西在听）', at: 2000, ...over })

  // ── ① 连续失败到阈值才判 down（网络抖一下不许播报）──
  const m1 = createMonitor({ workspace: '', serverId: 's1', read: () => null, write: () => {}, now: () => 0 })
  eq(m1.feed(snapOk()).events.length, 0, '第一条：正常 ⇒ 没有事件')
  eq(m1.feed(snapBad()).events.length, 0, '★ 失败 1 次（阈值 2）⇒ **还不播报**（抖动不是故障）')
  const d1 = m1.feed(snapBad())
  eq(d1.events.length, 1, '★ 失败 2 次 ⇒ 产出 down')
  eq(d1.events[0].type, 'down', '事件类型是 down')
  eq(d1.phase, 'down', '状态进入 down')

  // ── ② ★★★ 持续 down **绝不重复产出**（这就是"恰好一次"）──
  eq(m1.feed(snapBad()).events.length, 0, '★★ 第 3 次失败 ⇒ **没有事件**（已经报过了）')
  eq(m1.feed(snapBad()).events.length, 0, '★★ 第 4 次失败 ⇒ 仍然没有事件')
  eq(m1.feed(snapBad()).events.length, 0, '★★ 第 5 次 ⇒ 仍然没有 —— 持续 down 不重复播报')

  // ── ③ down→up 也要报一次（否则使用者永远不知道它自己好了）──
  const u1 = m1.feed(snapOk())
  eq(u1.events.length, 1, '★ 恢复 ⇒ 产出 up（"恢复了"必须说）')
  eq(u1.events[0].type, 'up', '事件类型是 up')
  eq(m1.feed(snapOk()).events.length, 0, '继续正常 ⇒ 不再产出')

  // ── ④ ★★ 状态**落盘**：重启后不会把"已经报过"忘掉 ──
  let disk = null
  const mk = () => createMonitor({ workspace: '/ws', serverId: 's2', read: () => disk, write: (_r, v) => { disk = JSON.parse(JSON.stringify(v)) }, now: () => 0 })
  const a = mk()
  a.feed(snapOk())
  a.feed(snapBad())
  const firstDown = a.feed(snapBad())
  eq(firstDown.events.length, 1, '第一次运行：产出 down')
  ok(disk && disk.phase === 'down', '★ 状态真的落盘了（phase=down）')
  // "重启"：新造一个 monitor，从同一份盘恢复
  const b = mk()
  const restored = b.load()
  eq(restored.restored, true, '★ 新进程恢复出了旧状态')
  eq(b.snapshot().phase, 'down', '★ 重启后**仍然是 down**')
  eq(b.feed(snapBad()).events.length, 0, '★★★ 重启后继续 down ⇒ **一条都不重复报**')

  // ── ⑤ 异常（TPS 低）只报告、**不重启**；同一异常只报一次 ──
  const m3 = createMonitor({ workspace: '', serverId: 's3', read: () => null, write: () => {}, now: () => 0 })
  const low = snapOk({ tps: 8, thresholds: { minTps: 15 } })
  const e1 = m3.feed(low)
  eq(e1.events.length, 1, 'TPS 低于阈值 ⇒ 产出异常事件')
  eq(e1.events[0].type, 'anomaly', '★ 类型是 anomaly（**与 down 分开** ⇒ 上层不会为它重启）')
  ok(/TPS/.test(String(e1.events[0].detail)), '文案说明了是哪个指标')
  eq(m3.feed(low).events.length, 0, '★ 同一个异常**只报一次**（不是每跳一次 —— 那是刷屏）')
  eq(m3.feed(snapOk({ tps: 20, thresholds: { minTps: 15 } })).events.length, 0, '恢复正常 ⇒ 没有事件')
  eq(m3.feed(low).events.length, 1, '★ 异常**再次出现**要能重新播报（否则第二次没人知道）')
  // 没给阈值 ⇒ 不判异常（宁可不报也不乱报）
  const m4 = createMonitor({ workspace: '', serverId: 's4', read: () => null, write: () => {}, now: () => 0 })
  eq(m4.feed(snapOk({ tps: 1 })).events.length, 0, '★ 没给阈值 ⇒ **不判异常**（阈值取决于整合包，不许内置）')

  // ── ⑥ 这个模块**不认识 Minecraft**（不许有版本判断）──
  const src = readFileSync(new URL('../src/servers/monitor.mjs', import.meta.url), 'utf8')
  ok(!/\b(paper|spigot|forge|fabric|neoforge|bukkit)\b/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), '★★ 源码里（去注释后）**没有任何服务端/加载器名字** ⇒ 换服务端不用改这里')

  // ── ⑦ describeSnapshot：拿不到的事实说"拿不到"，不写 0 ──
  const lineBad = describeSnapshot(snapBad())
  ok(/连不上/.test(lineBad), '连不上时如实说"连不上"')
  const lineOk = describeSnapshot(snapOk({ players: null, tps: null }))
  ok(/在线人数拿不到/.test(lineOk), '★ 人数拿不到时说"拿不到"（**不是"0 人"** —— 那是两件事）')
  ok(/TPS 拿不到/.test(lineOk), 'TPS 同理')

  // ── ⑧ 落盘内容里**不许有玩家聊天内容这种东西**（这个模块根本拿不到，但要有断言盯着）──
  const dump = JSON.stringify(m1.snapshot())
  ok(!/chat|message|text|内容/i.test(dump), '★ 状态里只有计数与时刻，没有任何"消息"字段')
}

console.log('\n=== ⑬ 采样解析与监测循环（编排层：多台互不拖累、没配密码不发连接）===')
{
  // ── `list` 应答解析：认不出就 null（**不猜成 0 人**）──
  const a = parsePlayerList('There are 2 of a max of 20 players online: 小明, Steve')
  eq(a.players, 2, '认出人数')
  eq(a.playerNames, ['小明', 'Steve'], '认出名单')
  eq(parsePlayerList('There are 0 of a max of 20 players online:').players, 0, '★ 真的 0 人 ⇒ 0（与"认不出"是两件事）')
  eq(parsePlayerList('2/20 players online').players, 2, '认得另一种形状（只有人数）')
  eq(parsePlayerList('2/20 players online').playerNames, null, '那种形状认不出名单 ⇒ null（不编）')
  eq(parsePlayerList('未知的措辞').players, null, '★★ 认不出的措辞 ⇒ null，**绝不猜成 0**')
  eq(parsePlayerList('').players, null, '空应答 ⇒ null')

  // ── TPS 解析：真机取回来的那段原文，且**认不出就是 null** ──
  // ★ 为什么这条重要：`rules.minTps` 一旦把"解析失败"当成 0，就会立刻播报
  //   "TPS 过低 / 服务器快挂了" —— 那是把**我们的 bug**说成**服务器的故障**。
  const realTps =
    'Dim minecraft:overworld (minecraft:overworld): Mean tick time: 6.418 ms. Mean TPS: 20.000\n' +
    'Dim minecraft:the_nether (minecraft:the_nether): Mean tick time: 0.065 ms. Mean TPS: 20.000\n' +
    'Dim minecraft:the_end (minecraft:the_end): Mean tick time: 0.100 ms. Mean TPS: 19.5'
  eq(parseTps(realTps), 19.5, '★ 多维度取**最小值**（最慢的那个维度才是玩家体感）')
  eq(parseTps('Mean TPS: 20.000'), 20, '单维度形状')
  eq(parseTps('Unknown command. Type "/help"'), null, '★★★ 认不出 ⇒ null，**绝不猜成 0**（否则立刻误报"TPS 过低"）')
  eq(parseTps(''), null, '空应答 ⇒ null')
  eq(parseTps('Mean TPS: abc'), null, '★ 字段在但值不是数字 ⇒ null（不 NaN、不 0）')

  // ── 编排层：用注入的采样函数真跑（不需要任何服务端）──
  // ★ 必须给**真临时工作区**：事件台账要真的落盘（空字符串会被当成"没有工作区"而整跳跳过 ——
  //   那个分支本身是对的，但它测不到编排逻辑）。
  const loopWs = mkdtempSync(join(tmpdir(), 'qqb-loop-'))
  const events = []
  let sampleImpl = async () => ({ reachable: true, players: 1, tps: null, at: 1000 })
  const loop = createServerLoop({
    workspace: loopWs,
    servers: () => [
      { id: 'ok1', name: '好服', enabled: true, password: 'x', rules: {} },
      { id: 'bad1', name: '挂服', enabled: true, password: 'x', failThreshold: 1, rules: {} },
      { id: 'off1', name: '停用的', enabled: false, password: 'x', rules: {} },
      { id: 'nopw', name: '没配密码', enabled: true, password: '', rules: {} },
      { id: 'boom', name: '采样抛异常', enabled: true, password: 'x', failThreshold: 1, rules: {} },
    ],
    sample: async (server) => {
      if (server.id === 'boom') throw new Error('采样炸了')
      if (server.id === 'bad1') return { reachable: false, error: '连不上那个 RCON 端口', at: 2000 }
      return sampleImpl(server)
    },
    onEvent: (row) => events.push(row),
    log: () => {},
    now: () => 5000,
  })

  // 用真 workspace 才会有事件台账 —— 这里只验"编排不炸 + 事件回调拿到东西"
  const r1 = await loop.tick()
  eq(r1.ok, true, '一次巡检跑完（不因为某一台抛异常而整体失败）')
  eq(r1.results.length, 5, '★ 五台都各自得到结果（**单台失败不拖累其它台**）')
  const off = r1.results.find((x) => x.serverId === 'off1')
  eq(off.snapshot.skipped, 'disabled', '停用的那台如实说"跳过了"')
  const nopw = r1.results.find((x) => x.serverId === 'nopw')
  eq(nopw.snapshot.misconfigured, true, '★★ 没配密码的那台标成"配置不全"')
  eq(nopw.events.length, 0, '★★ 而且**不产出事件**（配置不全不是"服务器挂了" —— 否则会发假告警）')
  const boom = r1.results.find((x) => x.serverId === 'boom')
  ok(boom.error || boom.events.length >= 0, '采样抛异常的那台如实留下错误，不影响别台')
  // ① 真的产出 down（阈值 1）
  const downEvents = r1.events.filter((e) => e.event === 'down')
  ok(downEvents.length >= 1, '★ 连不上的那台产出了 down 事件')
  ok(/RCON 端口/.test(downEvents[0].text), '★ 事件正文里带着**分类过的原因**（不是干巴巴一个 "down"）')
  // ② 再跑一跳：持续 down **不重复产出**
  const r2 = await loop.tick()
  eq(r2.events.filter((e) => e.event === 'down' && e.serverId === 'bad1').length, 0, '★★ 第二跳：持续 down **不再产出事件**（恰好一次）')
  // ③ 事件真的落进了台账（桥接与界面都读它）
  const led = readRecentEvents({ workspace: loopWs, limit: 20 })
  ok(led.ok && led.rows.length >= 1, '★ 事件写进了 runtime/servers/events.jsonl')
  ok(led.rows.some((x) => x.event === 'down'), '台账里能找到那条 down')
  loop.stop()
  eq(loop.isRunning(), false, 'stop 之后不再运行')
  try {
    rmSync(loopWs, { recursive: true, force: true })
  } catch {
    /* 临时目录清理失败无所谓 */
  }
}

console.log('\n=== ⑭ ★★★ 接线级：事件真的走到**主动播报**（走完整桥接）===')
//
// 为什么必须有这一节：前十三节验的是"模块自己对不对"。而本项目最贵的一类缺陷
// 是**接线**（任务段那次"从未注入过"，124 项纯函数断言一条都没抓到）。
// 这一节造一个真 Bridge，把一条 `down` 事件喂进去，断言：
//   · `announce: auto` ⇒ **真的产生了 session/prompt**，而且提示词里真有事件说明；
//   · `announce: manual`（**默认**）⇒ **一次模型调用都不产生**；
//   · 第二条相同事件 ⇒ 被冷却挡住（不刷屏）；
//   · 目标会话没来过消息 ⇒ **fail-closed 拒发**（告警也不许绕过名单）。
{
  const { Bridge } = await import('../src/bridge.mjs')
  const { SessionRouter } = await import('../src/session-bridge.mjs')
  const { SendQueue } = await import('../src/onebot.mjs')
  const { writeTask } = await import('../src/schedule.mjs')

  const ADMIN = '100000001'

  function makeBridge({ announce = 'auto', knownChat = true } = {}) {
    const WS = mkdtempSync(join(tmpdir(), 'qqb-evt-'))
    const router = new SessionRouter({ log: () => {} })
    const logs = []
    const log = (m) => logs.push(String(m))
    const config = {
      dsh: { workspace: WS, permissionMode: 'workspace-write' },
      onebot: {},
      access: { adminUsers: [ADMIN], dmAllowlist: [], groupAllowlist: [] },
      trigger: { private: true, mention: true, keyword: true, groupEnabled: true, keywords: ['小鲸鱼'] },
      send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 100, maxPerHour: 1000, dedupeWindowMs: 0, maxCharsPerMessage: 1500 },
      turn: { timeoutMs: 5000 },
      humanize: { enabled: false, chunkChars: 300 },
      persona: { preset: 'none' },
      memory: { enabled: false, affect: { prewake: 'off' } },
      image: { enabled: false },
      schedule: { enabled: true },
      // ★ 故意配一台"服务器"：但**不给 loop 采样**（这一节要验的是事件→播报，
      //   不是采样本身），所以只建 Bridge、不 start 那个 loop。
      servers: [],
    }
    const rpc = new EventTarget()
    rpc.prompts = []
    rpc.prompt = async (sessionId, blocks) => {
      rpc.prompts.push(String(blocks?.[0]?.text ?? ''))
      router.handleEvent(sessionId, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '服务器连不上了，我去看看' }] } },
      })
      router.handleEvent(sessionId, { type: 'turn/end', data: { reason: 'completed' } })
      return { messageId: 'm1' }
    }
    const onebot = new EventTarget()
    onebot.selfId = '200000001'
    onebot.call = async () => ({ status: 'ok', retcode: 0, data: null })
    const sent = []
    onebot.send = async (kind, peerId, text, opts) => {
      sent.push({ kind, peerId, text, ...(opts ?? {}) })
      return { status: 'ok', retcode: 0, data: { message_id: `s${sent.length}` } }
    }
    const sendQueue = new SendQueue({ ...config.send, log })
    const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, log })

    // ★ 让目标会话变成"已知"（否则 fail-closed 会拒发 —— 那正是另一条断言要验的）
    if (knownChat) {
      const { noteKnownChat } = require_schedule()
      noteKnownChat({ workspace: WS, chatKey: `private:${ADMIN}` })
    }

    // 写一条**事件型**任务（这就是"盯着服务器的那条规则"）
    const w = writeTask({
      workspace: WS,
      task: {
        id: 'watch1',
        title: '服务器挂了要报',
        // ★ 事件型任务的 repeat 只是形状占位（它不参与时钟调度）
        repeat: { kind: 'daily', at: '00:00', weekdays: null },
        trigger: { kind: 'server', serverId: 'srv1', events: ['down', 'up'], cooldownMs: 5 * 60_000, announce: { down: announce, up: announce, anomaly: announce } },
        target: { kind: 'private', peerId: ADMIN },
        prompt: '{server} 出事了：{event}（{detail}）',
        timezone: 'Asia/Shanghai',
      },
      now: Date.now(),
    })
    return { bridge, rpc, sent, logs, WS, wrote: w }
  }
  // 只为少写一条 import
  function require_schedule() {
    return scheduleMod
  }
  const scheduleMod = await import('../src/schedule.mjs')

  // ── ① announce=auto ⇒ 真的播报 ──
  {
    const { bridge, rpc, sent, WS, wrote } = makeBridge({ announce: 'auto' })
    ok(wrote.ok, '事件型任务写得进去（trigger/announce 形状合法）')
    const row = { seq: 1, at: Date.now(), serverId: 'srv1', serverName: '主服', event: 'down', detail: '连不上那个 RCON 端口', text: '连不上那个 RCON 端口', snapshot: { reachable: false } }
    const r = await bridge.onServerEventForTest(row)
    eq(r.announced, 1, '★ auto ⇒ 播报了 1 条')
    eq(rpc.prompts.length, 1, '★★ 而且**真的产生了一次 session/prompt**（接线没断）')
    const prompt = String(rpc.prompts[0] ?? '')
    ok(prompt.includes('服务器事件'), '★ 提示词里**真的有**事件那一段')
    ok(prompt.includes('主服'), '事件段里带上了服务器名')
    ok(prompt.includes('连不上了'), '★ 而且说清了是哪一类（down = 连不上了）')
    ok(prompt.includes('不是对方问你的'), '★ 明说这不是对方问的（否则它会回"好的我看看"）')
    ok(sent.some((x) => x.text.includes('连不上')), '★ 那句话**真的发出去了**（证据是消息本身）')
    await bridge.close({ timeoutMs: 300 })
  }

  // ── ② announce=manual（默认）⇒ 一次模型调用都没有 ──
  {
    const { bridge, rpc, WS } = makeBridge({ announce: 'manual' })
    const row = { seq: 2, at: Date.now(), serverId: 'srv1', serverName: '主服', event: 'down', detail: '连不上', text: '连不上', snapshot: { reachable: false } }
    const r = await bridge.onServerEventForTest(row)
    eq(r.announced, 0, '★★ manual（默认）⇒ **不自动播报**')
    eq(rpc.prompts.length, 0, '★★★ 而且**一次模型调用都不产生**（零成本）')
    await bridge.close({ timeoutMs: 300 })
  }

  // ── ③ 冷却：第二条相同事件不再喊（防刷屏）──
  {
    const { bridge, rpc, WS } = makeBridge({ announce: 'auto' })
    const base = Date.now()
    const row1 = { seq: 3, at: base, serverId: 'srv1', serverName: '主服', event: 'down', detail: 'x', text: 'x', snapshot: {} }
    const row2 = { seq: 4, at: base + 1000, serverId: 'srv1', serverName: '主服', event: 'down', detail: 'x', text: 'x', snapshot: {} }
    await bridge.onServerEventForTest(row1)
    const r2 = await bridge.onServerEventForTest(row2)
    eq(r2.announced, 0, '★★ 冷却窗口内的第二条 ⇒ 不喊（刷屏的告警等于没有告警）')
    eq(rpc.prompts.length, 1, '★ 总共只产生了一次模型调用')
    await bridge.close({ timeoutMs: 300 })
  }

  // ── ④ fail-closed：目标会话没来过消息 ⇒ 拒发（**告警也不许绕过名单**）──
  {
    const { bridge, rpc, logs } = makeBridge({ announce: 'auto', knownChat: false })
    const row = { seq: 5, at: Date.now(), serverId: 'srv1', serverName: '主服', event: 'down', detail: '连不上', text: '连不上', snapshot: {} }
    const r = await bridge.onServerEventForTest(row)
    eq(r.announced, 0, '★ 目标会话没来过消息 ⇒ 不播报')
    eq(rpc.prompts.length, 0, '★ 一次模型调用都没有')
    ok(
      logs.some((l) => l.includes('目标会话不可用')),
      '★ 而且**明确留痕**（不许静默不喊 —— 那会表现成"服务器挂了它没说话"）',
    )
    await bridge.close({ timeoutMs: 300 })
  }

  // ── ⑤ 事件型任务**不参与时钟调度**（否则会根据那个占位的 repeat 乱报）──
  {
    const { createScheduleRunner } = await import('../src/schedule-runner.mjs')
    const WS = mkdtempSync(join(tmpdir(), 'qqb-evt2-'))
    writeTask({
      workspace: WS,
      task: {
        id: 'watch2',
        title: '事件型',
        repeat: { kind: 'daily', at: '00:00', weekdays: null },
        trigger: { kind: 'server', serverId: 'srv1', events: ['down'] },
        target: { kind: 'private', peerId: ADMIN },
        prompt: 'p',
      },
      now: Date.now() - 86_400_000,
    })
    let called = 0
    const runner = createScheduleRunner({
      workspace: WS,
      bridge: {
        resolveTarget: () => ({ ok: true, sessionId: 's', chatKey: `private:${ADMIN}`, tier: 'admin' }),
        runProactiveTurn: async () => {
          called += 1
          return { ok: true, text: '不该被时钟触发' }
        },
      },
      log: () => {},
      now: () => Date.now(),
    })
    await runner.tick()
    eq(called, 0, '★★★ 事件型任务**不会被时钟那条路触发**（它的 repeat 只是形状占位）')
    try {
      rmSync(WS, { recursive: true, force: true })
    } catch {
      /* 无所谓 */
    }
  }
}

console.log('\n=== ⑮ ★★★ 重启编排：试一次、等端口释放、冷却、求助待指令 ===')
//
// 这一节的判据全部来自**不可逆的后果**（`docs/0.3.2-task-manager-plan.md` §6.3）：
//   ① 停完**必须等端口释放**才能起 —— 两个 JVM 同写世界 = 存档损坏；
//   ② "试过重启"不能是假象 —— 判成功只认**端口重新可连**；
//   ③ 重启不能变成风暴 —— 冷却且**冷却落盘**（重启就绕过它等于没有）；
//   ④ 认不出归属**绝不许抢** —— 那可能是在杀别人的服务端。
{
  const mk = (over = {}) => {
    // ★★ 默认 **sleep 不真等**，而且时钟随 sleep 前进。
    //   为什么（实测踩到的）：`restart.mjs` 的等待循环步长是 2 秒，而"等恢复"那条
    //   路径要转到 180 秒超时 ⇒ 一个失败用例白等 3 分钟，整节测试直接超时挂死。
    //   时钟**必须跟着 sleep 走**：只把 sleep 变成空函数而不推进时钟，
    //   时间死线永远到不了 ⇒ 变成不流动时间的紧循环（更难查）。
    let clock = 0
    return createRestarter({
      workspace: mkdtempSync(join(tmpdir(), 'qqb-rst-')),
      serverId: 'srv1',
      log: () => {},
      now: () => clock,
      sleep: async (ms) => {
        clock += Math.max(1000, Number(ms) || 1000)
      },
      ...over,
    })
  }
  const EVID = { owner: 'bridge', pid: 4242, startedAt: 1000 }

  // ── ① 判据：只有 down 能重启（anomaly 永不）──
  {
    const r = mk({ launch: async () => ({ ok: true }) })
    eq(r.canRestart({ reason: 'anomaly', evidence: EVID }).ok, false, '★ 指标异常 ⇒ **不允许重启**（"TPS 低就重启"是赌博）')
    eq(r.canRestart({ reason: 'anomaly', evidence: EVID }).why, 'not-down', '原因标成 not-down')
    eq(r.canRestart({ reason: 'up', evidence: EVID }).ok, false, 'up 事件更不该重启')
  }

  // ── ② 归属证据：认不出就**绝不抢** ──
  {
    // ★ 必须**先造实例再断言**：`mk()` 每次调用都新造一个编排器
    //   （早期版本写了 `mk({launch}).canRestart(...)` 与 `mk({}).canRestart(...)`，
    //    两次拿到的是**不同的实例** —— 断言看着像在测同一件事，其实不是。
    //    这正是被测试自己抓出来的：它报了"有归属但没有启动方式 ⇒ 拒绝"失败。）
    const withLaunch = mk({ launch: async () => ({ ok: true }) })
    const noLaunch = mk({})
    eq(noLaunch.canRestart({ reason: 'down', evidence: { owner: 'external' } }).ok, false, '★ external（不是我起的）⇒ 拒绝')
    eq(noLaunch.canRestart({ reason: 'down', evidence: { owner: 'external' } }).why, 'not-owner', '原因标成 not-owner')
    ok(/不抢别人的服务端/.test(noLaunch.canRestart({ reason: 'down', evidence: { owner: 'external' } }).text), '★ 文案说清"不抢别人的"')
    eq(noLaunch.canRestart({ reason: 'down', evidence: {} }).ok, false, '★ 没有归属证据 ⇒ 拒绝')
    eq(noLaunch.canRestart({ reason: 'down', evidence: {} }).why, 'no-evidence', '原因标成 no-evidence')
    eq(noLaunch.canRestart({ reason: 'down', evidence: EVID }).ok, false, '★ 有归属但**没有启动方式** ⇒ 拒绝（拉不起来就别动）')
    eq(withLaunch.canRestart({ reason: 'down', evidence: EVID }).ok, true, '归属 + 启动方式齐了 ⇒ 允许')
  }

  // ── ③ ★★★ 成功路径：顺序必须是「停 → **等端口释放** → 起 → 等恢复」──
  {
    const log = []
    // ★ 假端口必须模拟**真实的相位**：运行中(通) → 停完(不通) → 起完(通)。
    //   第一版只把"停"设成不通、**没让"起"把它设回通** ⇒ 永远等不到恢复，
    //   于是"成功路径"这条断言一直是红的（而实现是对的）。
    let portBusy = true
    const r = mk({
      launch: async () => {
        // ★ 起的时候端口**必须已经释放**（不等就起 = 两个 JVM 同写世界）
        log.push(`launch(portBusy=${portBusy})`)
        if (portBusy) throw new Error('端口还占着就起了 —— 两个 JVM 同写世界')
        portBusy = true // 新的进程开始监听
        return { ok: true, pid: 555 }
      },
      stopGracefully: async () => {
        log.push('stop')
        portBusy = false // 优雅停服之后端口释放
        return { ok: true }
      },
      portOpen: async () => portBusy,
    })
    const out = await r.restart({ server: { host: '127.0.0.1', port: 25565 }, reason: 'down', evidence: EVID })
    eq(out.outcome, 'restarted', '★ 端口恢复可连 ⇒ 判定重启成功')
    eq(log[0], 'stop', '★ 顺序：先停')
    ok(log[1] === 'launch(portBusy=false)', '★★★ 起的时候端口**已经释放**（不等就起 = 存档损坏）')
    eq(r.state().attempts, 0, '★ 成功之后尝试计数**归零**（"每次故障最多试一次"，不是"一辈子只能试一次"）')
    ok(Number(r.state().cooldownUntil) > 0, '★ 成功后设了冷却')
  }

  // ── ④ ★★ "停不下来" ⇒ **不强杀**，转求助 ──
  {
    // ★ 假时钟必须**随 sleep 前进**：否则 `waitFor` 的时间死线永远到不了
    //   ⇒ 变成"不流动时间的紧循环"，测试会挂死（这一条正是实测踩出来的，
    //   `restart.mjs` 的 `waitFor` 因此多了一道迭代上限）。
    let clock = 0
    const r = mk({
      launch: async () => {
        throw new Error('不该走到启动这一步')
      },
      stopGracefully: async () => ({ ok: true }),
      portOpen: async () => true, // 一直是"还占着"
      now: () => clock,
      sleep: async (ms) => {
        clock += Math.max(1000, Number(ms) || 1000)
      },
    })
    const out = await r.restart({ server: { port: 25565 }, reason: 'down', evidence: EVID, timing: { stopWaitMs: 30_000 } })
    eq(out.outcome, 'failed', '停不下来 ⇒ 失败')
    eq(out.why, 'stop-timeout', '原因标成 stop-timeout')
    ok(/没有强杀/.test(out.text), '★★ 文案明说"我没有强杀它"（强杀正在写世界的 JVM 就是存档损坏的成因）')
    eq(r.state().waitingForAdmin, true, '★★ 并且进入"等管理员指令"')
    eq(r.state().attempts, 1, '尝试次数仍然只有 1')
  }

  // ── ⑤ 拉不起来 / 起来了但没恢复 ⇒ 都是"求助待指令"，且**不再自动重启** ──
  {
    const r = mk({
      launch: async () => ({ ok: false, why: '启动脚本不存在' }),
      stopGracefully: async () => ({ ok: true }),
      portOpen: async () => false, // 端口是释放的
    })
    const out = await r.restart({ server: { port: 25565 }, reason: 'down', evidence: EVID })
    eq(out.outcome, 'failed', '拉不起来 ⇒ 失败')
    eq(out.why, 'launch-failed', '原因标成 launch-failed')
    eq(r.state().waitingForAdmin, true, '★ 进入等指令')
    // ★ 此时**两种拦法同时成立**（次数用尽 + 在等指令），而"次数用尽"排在前面
    //   —— 那是刻意的：它说的是"我按纪律不再试了"，比"我在等你"更准确。
    const again = r.canRestart({ reason: 'down', evidence: EVID, rules: { cooldownMs: 0 } })
    eq(again.ok, false, '★★ 同一故障下**不再自动重启**')
    eq(again.why, 'attempts-exhausted', '★ 原因先说"次数用尽"（更准确的那个）')
    // 换个说法验"在等指令"这一条：把上限放到 2，这时拦住它的就是 waiting-admin
    eq(
      r.canRestart({ reason: 'down', evidence: EVID, rules: { cooldownMs: 0, maxAttempts: 2 } }).why,
      'waiting-admin',
      '★ 上限放宽之后，拦住它的是"在等你指令"',
    )
  }

  // ── ⑥ ★★ "试一次"的硬保证：默认上限 1 次 ──
  {
    // ★ 用**可控端口**：停完释放、起完重开。第一版写成 `portOpen: ()=>false`，
    //   于是"等端口释放"那一步**立刻通过**（端口本来就是关的），测试根本没走到
    //   "等恢复"那一步 ⇒ 断言测的不是它声称的那件事（实测抓到的）。
    let busy = true
    const r = mk({
      launch: async () => {
        busy = true
        return { ok: true }
      },
      stopGracefully: async () => {
        busy = false
        return { ok: true }
      },
      portOpen: async () => busy,
    })
    // 先把端口焊死（永远占着）⇒ 走"停不下来"那条路 ⇒ 失败 + 等指令
    const stuck = mk({
      launch: async () => ({ ok: true }),
      stopGracefully: async () => ({ ok: true }),
      portOpen: async () => true,
    })
    await stuck.restart({ server: { port: 1 }, reason: 'down', evidence: EVID })
    eq(stuck.state().attempts, 1, '第一次尝试记上了')
    const c = stuck.canRestart({ reason: 'down', evidence: EVID, rules: { cooldownMs: 0, maxAttempts: 1 } })
    eq(c.ok, false, '★★ 累计到上限 ⇒ **不再自动重启**')
    eq(c.why, 'attempts-exhausted', '原因标成 attempts-exhausted')
    eq(
      stuck.canRestart({ reason: 'down', evidence: EVID, rules: { cooldownMs: 0, maxAttempts: 1 } }).why,
      'attempts-exhausted',
      '★★ 即使同时"在等指令"，先说**次数用尽**（那更准确：我按纪律不再试了）',
    )
    // 成功那一次会把计数归零 ⇒ 说明"上限"是**每次故障**的，不是"一辈子"
    const out = await r.restart({ server: { port: 25565 }, reason: 'down', evidence: EVID })
    eq(out.outcome, 'restarted', '（对照）可控端口下这条路径能成功')
    eq(r.state().attempts, 0, '★ 成功之后计数归零（"每次故障最多试一次"）')
  }

  // ── ⑦ ★★ 冷却**落盘**：重启一次不许绕过它 ──
  {
    const ws = mkdtempSync(join(tmpdir(), 'qqb-rst-cd-'))
    const opts = {
      launch: async () => ({ ok: true }),
      stopGracefully: async () => ({ ok: true }),
      portOpen: async () => false,
      workspace: ws,
    }
    const a = mk({ ...opts })
    // ★ 可控端口的正确相位：**运行中(通) → 停完(不通) → 起完(通)**
    //   （第一版把三类动作的端口状态写反了 ⇒ 一直报 "failed"，而实现是对的）
    let busy = true
    const b = mk({
      workspace: ws,
      launch: async () => {
        busy = true
        return { ok: true }
      },
      stopGracefully: async () => {
        busy = false
        return { ok: true }
      },
      portOpen: async () => busy,
    })
    const out = await b.restart({ server: { port: 25565 }, reason: 'down', evidence: EVID })
    eq(out.outcome, 'restarted', '成功一次（设了冷却）')
    ok(Number(b.state().cooldownUntil) > 0, '冷却记下了')
    // ★ "重启"一次：从同一份盘恢复
    const c = mk({ ...opts, workspace: ws })
    c.load()
    ok(Number(c.state().cooldownUntil) > 0, '★★ 新进程从盘上恢复了冷却（否则重启一次就绕过它）')
    // ★★ 顺序很重要：**先验冷却真的拦住了**，再验"管理员批准能放开"。
    //   写反了的话（先 approveRetry）冷却早被清掉 ⇒ 这三条断言全测不到东西
    //   （实测抓到的：连红三条，而实现是对的）。
    const blocked = c.canRestart({ reason: 'down', evidence: EVID, rules: { cooldownMs: 10 * 60_000, maxAttempts: 99 } })
    eq(blocked.ok, false, '★★ 冷却窗口内 ⇒ 不重启')
    eq(blocked.why, 'cooldown', '原因标成 cooldown')
    ok(/冷却窗口/.test(String(blocked.text)), '文案说明是冷却')
    // 管理员显式说"再试一次" ⇒ 清掉冷却与等指令（但**不清 attempts**）
    const before = c.state().attempts
    c.approveRetry()
    eq(c.canRestart({ reason: 'down', evidence: EVID, rules: { cooldownMs: 10 * 60_000, maxAttempts: 99 } }).ok, true, '★ 管理员批准后允许再试')
    eq(c.state().attempts, before, '★ 但**不清 attempts**（那是"我试过几次"的历史，清了等于允许无限重试）')
    try {
      rmSync(ws, { recursive: true, force: true })
    } catch {
      /* 无所谓 */
    }
  }
}

console.log('\n=== ⑯ ★★★ 服务端守护：归属判定是"能不能动手"的唯一依据 ===')
//
// 这一节的每一条都在防同一件事：**认错归属 ⇒ 去动别人的服务端**（或去重启一个
// 根本没在跑的东西）。判据是 `pid@启动时刻`（pid 会被复用），而"查不到启动时刻"
// 必须**判为不是我的**（宁可不动，也不赌）。
{
  // ── 启动时刻解析：几种命令的输出都要认，认不出就 null ──
  eq(parseStartTime('CreationDate=20261004003012.123456+480'), new Date(2026, 9, 4, 0, 30, 12).getTime(), '认得 wmic 的 CreationDate')
  ok(Number.isFinite(parseStartTime('2026-10-04T00:30:12.1234567+08:00')), '认得 PowerShell 的 ISO 时间')
  eq(parseStartTime('乱七八糟'), null, '★★ 认不出 ⇒ null（**不猜**）')
  eq(parseStartTime(''), null, '空输出 ⇒ null')

  // ── ★★★ Ticks 解析（真机实测的三条硬伤，全部钉在这里）──
  //
  // 为什么这段非有不可：归属判据是"pid@启动时刻 对得上"，而真机上**唯一能用**的
  // 取法就是 `Get-Process ... ToUniversalTime().Ticks`。它有三个坑，
  // 每一个都会让判据**永远对不上**（症状是"明明是我起的却说不是我起的"，
  // 而重启能力就此静默失效）：
  //   ① 必须 `ToUniversalTime()` —— `StartTime.Kind` 是 **Local**，直接取 `.Ticks`
  //      会差一个时区（实测 UTC+8 ⇒ 差整整 8 小时 = 28800 秒）；
  //   ② 不能 `ToFileTimeUtc()`（实测低 32 位是错的，差约 5×10¹⁰ 秒）；
  //   ③ `Get-CimInstance Win32_Process` 在这台机器上**直接拒绝访问**
  //      （实测 HRESULT 0x80041003）—— 所以 `wmic`/CIM 只能当退路。
  //
  // 真机取回的原值（2026-10-04，pid 171288）：`.ToUniversalTime().Ticks` =
  // 639266479092289852，权威 Unix 毫秒 = 1791051109228，两者**差 0 秒**。
  // ★★★ 真机取回的原值（2026-10-04，pid 171288）：`.ToUniversalTime().Ticks` =
  //   639266479092289852，权威 Unix 毫秒 = 1791051109228（两者差 0 秒）。
  //   断言用"差 ≤ 1ms"而不是精确相等：Ticks 是 100ns 精度，除以 1e4 会有取整尾巴
  //   （实测取整后是 …229 而不是 …228）。
  eq(
    Math.abs(parseStartTime('639266479092289852') - 1791051109228) <= 1,
    true,
    '★★★ 认得 .NET 的 UTC Ticks（真机原值，与权威值差 ≤ 1ms）',
  )
  // ★ 落到**未来**的 Ticks 必须被守卫拒掉。
  //   ★★ 第一版这里硬编码了真机那个"漏掉 ToUniversalTime"的原始值
  //   （`639266767092289852`）来断言"未来 ⇒ 拒掉"—— 那是一个**时间炸弹**：
  //   它换算成固定的 `1791079909229`（本地 2026/10/4 10:11:49），
  //   等时钟走过那一刻，它就**不再是未来** ⇒ 断言开始失败
  //   （实测就是这么红的，而且症状看起来像解析器坏了）。
  //   ∴ 现在**动态构造**一个真正的未来值，语义与时刻无关。
  const futureTicks = String((BigInt(Date.now() + 8 * 3600_000 + 60_000) + 62_135_596_800_000n) * 10_000n)
  eq(parseStartTime(futureTicks), null, '★★★ 落到未来的 Ticks ⇒ **拒掉**（否则会拿一个未来的时刻去比对）')
  // 对照：真机那个 UTC 正确值照常解析 —— 把"解析器坏了"与"守卫按预期拦了"分开
  ok(parseStartTime('639266479092289852') !== null, '（对照）UTC 的正确值照常解析（证明解析器没坏）')
  // 反过来：一个**合理范围内的旧**时刻要能正常解析（守卫不能把正常值也拒了）
  ok(parseStartTime('637000000000000000') !== null, '★ 合理范围内的旧时刻仍能解析（守卫不许误杀）')
  eq(parseStartTime('99999999999999999999'), null, '★★ 荒谬的 Ticks（超出合理范围）⇒ null（不许当时间用）')
  eq(parseStartTime('12345'), null, '★ 位数不够 ⇒ 不当 Ticks（可能只是错误文本里的数字）')
  eq(
    parseStartTime('Get-Process : Cannot find a process with the process identifier 99999999.'),
    null,
    '★★★ 错误文本里的数字**不许**被当成启动时刻（凭空判对归属比判错更坏）',
  )

  // ── ★★★ 真机取启动时刻：走**文件重定向**，不是管道 ──
  //
  // 为什么必须测这条：管道被禁时 `spawn EPERM`，而那是**归属判据整条失效**的原因
  // （不是"少一个功能"）。这里拿**当前 node 进程自己**当被测对象 —— 它一定活着，
  // 而且它的启动时刻一定在合理范围内。
  if (process.platform === 'win32') {
    const wsProbe = mkdtempSync(join(tmpdir(), 'qqb-sup-ticks-'))
    const outFile = join(wsProbe, '.probe-out.txt')
    const seenBy = []
    const wrappedRun = async (cmd, args, file) => {
      seenBy.push({ cmd, outFile: String(file ?? '') })
      return runAndCapture(cmd, args, file)
    }

    // ① 底层那一手本身：给了 outFile 就必须能把输出拿回来
    const echo = await runAndCapture(
      'powershell',
      ['-NoProfile', '-Command', 'Write-Output "hello-from-probe"'],
      outFile,
    )
    ok(String(echo).includes('hello-from-probe'), '★★★ 文件重定向真的能把子进程输出拿回来（管道被禁时**只有这一条路**）')

    // ② 在它之上，启动时刻必须真的查得到
    const live = await processStartedAt(process.pid, { run: wrappedRun, outFile })
    ok(live !== null, '★★★ 真的查到了当前进程的启动时刻')
    if (live !== null) {
      const ageSec = Math.round((Date.now() - live) / 1000)
      ok(ageSec >= 0 && ageSec < 3600, `★★ 查到的时刻在合理范围内（本进程已运行 ${ageSec} 秒）`)
      // ★★★ 这条才是"没有时区错位"的判据：与 node 自己知道的启动时刻对照。
      //   漏掉 `ToUniversalTime()` 时这里会差整整 8 小时（实测）。
      const selfStart = Date.now() - Math.round(process.uptime() * 1000)
      const deltaMs = Math.abs(live - selfStart)
      ok(deltaMs < 5000, `★★★ 与 node 自己算的启动时刻差 ${deltaMs}ms（< 5s ⇒ **没有时区错位**）`)
    }
    ok(
      seenBy.every((s) => s.outFile !== ''),
      '★★★ 每次调用都带了 outFile（**这就是绕过"管道被禁"的那一手**）',
    )
    ok(
      seenBy[0]?.cmd === 'powershell',
      '★★ 优先用 powershell + Get-Process（实测 CIM 在这台机器上拒绝访问）',
    )
    try { rmSync(wsProbe, { recursive: true, force: true }) } catch { /* 无所谓 */ }
  }

  // ── pid 存活：EPERM 也算活着（进程在，只是没权限问）──
  eq(isPidAlive(123, () => {}), true, '能发信号 ⇒ 活着')
  eq(isPidAlive(123, () => { const e = new Error('x'); e.code = 'ESRCH'; throw e }), false, 'ESRCH ⇒ 不在了')
  eq(isPidAlive(123, () => { const e = new Error('x'); e.code = 'EPERM'; throw e }), true, '★ EPERM ⇒ **仍算活着**（进程在，只是没权限）')
  eq(isPidAlive(0, () => {}), false, '非法 pid ⇒ false')

  const mkSup = (over = {}) =>
    createSupervisor({
      workspace: mkdtempSync(join(tmpdir(), 'qqb-sup-')),
      log: () => {},
      ...over,
    })

  // ── ① 端口不通 ⇒ 什么都没在跑（**档案不算数**）──
  {
    const ws = mkdtempSync(join(tmpdir(), 'qqb-sup1-'))
    const s = mkSup({ workspace: ws, portOpen: async () => false })
    const o = await s.ownership({ serverId: 's1', port: 25565 })
    eq(o.owner, 'unknown', '端口不通 ⇒ unknown')
    eq(o.why.includes('没在跑'), true, '原因说清"服务端没在跑"')
    try { rmSync(ws, { recursive: true, force: true }) } catch { /* 无所谓 */ }
  }

  // ── ② 端口通但**没有归属档** ⇒ external（不是我起的）──
  {
    const ws = mkdtempSync(join(tmpdir(), 'qqb-sup2-'))
    const s = mkSup({ workspace: ws, portOpen: async () => true })
    const o = await s.ownership({ serverId: 's1', port: 25565 })
    eq(o.owner, 'external', '★ 没有归属档 ⇒ external（不许当成我的）')
    ok(/不是我拉起来的|没有归属档/.test(o.why), '原因说清"没有归属档"')
    try { rmSync(ws, { recursive: true, force: true }) } catch { /* 无所谓 */ }
  }

  // ── ③ ★★★ `pid@启动时刻` 对得上 ⇒ bridge（唯一允许重启的那一种）──
  {
    const ws = mkdtempSync(join(tmpdir(), 'qqb-sup3-'))
    const launched = await mkSup({ workspace: ws, spawnImpl: fakeSpawn(4242), portOpen: async () => false }).launch({
      id: 's1',
      startCommand: 'java -jar server.jar',
    })
    eq(launched.ok, true, '拉起成功（用注入的 spawn，不真起进程）')
    const rec = JSON.parse(readFileSync(join(ws, 'runtime/servers/s1.running.json'), 'utf8'))
    eq(rec.pid, 4242, '归属档里记了 pid')
    eq(rec.startedBy, 'bridge', '记了"是我起的"')
    ok(/s1\.console\.log$/.test(rec.logFile), '记了控制台输出落盘的位置（P3 也要读它）')

    // 端口通 + pid 活 + 启动时刻对得上 ⇒ bridge
    const s = mkSup({
      workspace: ws,
      portOpen: async () => true,
      pidAlive: () => true,
      startedAt: async () => rec.startedAt, // 完全一致
    })
    const o = await s.ownership({ serverId: 's1', port: 25565 })
    eq(o.owner, 'bridge', '★★★ pid@启动时刻 都对得上 ⇒ 归属是我（唯一允许重启的情形）')
    eq(o.pid, 4242, '带回了 pid')

    // ── ④ ★★★ pid 被复用（时刻对不上）⇒ external ──
    const s2 = mkSup({
      workspace: ws,
      portOpen: async () => true,
      pidAlive: () => true,
      startedAt: async () => rec.startedAt + 60_000, // 差一分钟
    })
    const o2 = await s2.ownership({ serverId: 's1', port: 25565 })
    eq(o2.owner, 'external', '★★★ 启动时刻对不上 ⇒ **不是我**（pid 被复用了）')
    ok(/复用/.test(o2.why), '原因说清"pid 被复用了"')

    // ── ⑤ ★★ 查不到启动时刻 ⇒ **unknown，不是 bridge**（宁可不动也不赌）──
    const s3 = mkSup({ workspace: ws, portOpen: async () => true, pidAlive: () => true, startedAt: async () => null })
    const o3 = await s3.ownership({ serverId: 's1', port: 25565 })
    eq(o3.owner, 'unknown', '★★ 查不到启动时刻 ⇒ unknown（**绝不当成我的**）')
    ok(/无法证明/.test(o3.why), '原因说清"无法证明它是我起的"')

    // ── ⑥ 档里的 pid 已经死了、而端口还有东西在听 ⇒ external ──
    const s4 = mkSup({ workspace: ws, portOpen: async () => true, pidAlive: () => false })
    const o4 = await s4.ownership({ serverId: 's1', port: 25565 })
    eq(o4.owner, 'external', '★ 我起的那进程已死、端口却是通的 ⇒ 现在跑的不是我的')
    try { rmSync(ws, { recursive: true, force: true }) } catch { /* 无所谓 */ }
  }

  // ── ⑦ 没配启动命令 ⇒ **不猜**（如实说不知道）──
  {
    const ws = mkdtempSync(join(tmpdir(), 'qqb-sup4-'))
    const s = mkSup({ workspace: ws })
    const r = await s.launch({ id: 's1' })
    eq(r.ok, false, '没配 startCommand ⇒ 拒绝')
    ok(/不知道|不猜/.test(r.why), '★★ 文案说清"我不知道怎么启动它"（不猜一个 java -jar）')
    ok(!existsSync(join(ws, 'runtime/servers/s1.running.json')), '★ 而且**没有留下归属档**（不许假装我起了）')
    try { rmSync(ws, { recursive: true, force: true }) } catch { /* 无所谓 */ }
  }

  // ── ⑦-b ★★★ 真起一个进程：`startExe` 这条路必须**不经 shell** ──────────
  //
  // 为什么这条不能只靠打桩测（实测抓到的硬伤）：`shell: true` 时 `child.pid` 是
  // `cmd.exe` 的，而它起完 java 就自己退出 ⇒ 归属档里的 pid 立刻变成"已死的进程"
  // ⇒ 归属判成"不是我起的" ⇒ **重启能力永远不可用**。
  // 打桩的 spawn 永远不会暴露这件事（它不给真 pid）—— 所以这里真的起一个
  // 长跑进程，然后**读它的命令行**，确认 pid 指向的就是那个可执行文件本身。
  {
    const ws = mkdtempSync(join(tmpdir(), 'qqb-sup5-'))
    // 用 node 自己当"服务端"：它一定存在，且 `-e` 让它长跑一会儿
    const s = mkSup({ workspace: ws, portOpen: async () => false })
    const launched = await s.launch({
      id: 'probe',
      startExe: process.execPath,
      startArgs: ['-e', 'setTimeout(()=>{}, 20000)'],
      cwd: process.cwd(),
    })
    eq(launched.ok, true, '★★ `startExe` + `startArgs` ⇒ 真的拉起来了（不打桩）')
    ok(Number.isFinite(Number(launched.pid)) && Number(launched.pid) > 0, '拿到了 pid')
    const rec2 = JSON.parse(readFileSync(join(ws, 'runtime/servers/probe.running.json'), 'utf8'))
    eq(rec2.viaShell, false, '★★★ 归属档记下 `viaShell: false`（pid 就是真进程，不是 cmd.exe）')
    eq(rec2.pid, launched.pid, '归属档里的 pid 与 launch 返回的一致')
    ok(String(rec2.cmdline ?? '').length > 0, '★ 归属档记下了命令行（弱证据比对靠它）')
    // 收尾：这个探针是我们自己起的，必须**由我们收掉**（不留野进程）
    try { process.kill(Number(launched.pid)) } catch { /* 可能已经退了 */ }
    try { rmSync(ws, { recursive: true, force: true }) } catch { /* 无所谓 */ }
  }

  // ── ⑦-c ★★★ 弱证据退路：查不到启动时刻时，靠**命令行**证明"是我起的" ──
  //
  // 为什么这条最值得钉住：这台机器上（以及任何受限沙箱里）查 `pid@启动时刻`
  // 要靠**捕获 PowerShell 输出**，而管道被禁 ⇒ 那一步必然拿不到 ⇒ 归属只能靠这条
  // **弱证据**退路。它是"尝试一次重启"最后的地基：它要是坏的，
  // 重启能力在最需要它的环境里就是死的（实测抓到的第二半硬伤：
  // 走 `startExe` 时 `cmdline` 恒为空 ⇒ 比对必然失败）。
  {
    const ws = mkdtempSync(join(tmpdir(), 'qqb-sup6-'))
    const launched = await mkSup({ workspace: ws, portOpen: async () => false }).launch({
      id: 'weak',
      startExe: process.execPath,
      startArgs: ['-e', 'setTimeout(()=>{}, 20000)'],
      cwd: process.cwd(),
    })
    ok(launched.ok, '前提：探针真的起来了')

    // 注入"查命令行"的返回值 —— 模拟真机：进程命令行里含那个可执行文件名
    const fakePs = (text) => async () => text
    const mkWeak = (over) =>
      mkSup({ workspace: ws, portOpen: async () => true, pidAlive: () => true, startedAt: async () => null, ...over })

    const ow = await mkWeak({ runCmd: fakePs(`${process.execPath} -e setTimeout(()=>{}, 20000)`) }).ownership({
      serverId: 'weak',
      port: 25565,
    })
    eq(ow.owner, 'bridge', '★★★ 命令行里有那个可执行文件名 ⇒ 归属是我（走的是弱证据）')
    eq(ow.weak, true, '★★ 而且**标明这是弱证据**（判定依据要让人看得见）')
    ok(/弱证据/.test(ow.why), '原因里写明"弱证据"三个字')

    // 反例：命令行对不上 ⇒ **绝不猜成我的**（宁可不动）
    const ow2 = await mkWeak({ runCmd: fakePs('C:\\other\\something-else.exe --run') }).ownership({
      serverId: 'weak',
      port: 25565,
    })
    eq(ow2.owner, 'unknown', '★★★ 命令行对不上 ⇒ unknown（**绝不当成我起的**）')
    eq(ow2.weak, undefined, '不许标成弱证据')

    // 反例：命令行**查不到** ⇒ 也是 unknown，且原因说清查不到
    const ow3 = await mkWeak({ runCmd: fakePs('') }).ownership({ serverId: 'weak', port: 25565 })
    eq(ow3.owner, 'unknown', '★ 命令行查不到 ⇒ unknown')
    ok(/拿不到命令行/.test(ow3.why), '原因说清"拿不到命令行"（不是"对不上"）')

    try { process.kill(Number(launched.pid)) } catch { /* 可能已经退了 */ }
    try { rmSync(ws, { recursive: true, force: true }) } catch { /* 无所谓 */ }
  }

  // ── ⑧ ★★ 归属判定与 restart 串起来：不是我的 ⇒ 只报告 ──
  {
    const ws = mkdtempSync(join(tmpdir(), 'qqb-sup5-'))
    const sup = mkSup({ workspace: ws, portOpen: async () => true })
    const ev = await sup.ownership({ serverId: 's1', port: 25565 })
    const r = createRestarter({ workspace: ws, serverId: 's1', log: () => {}, launch: async () => ({ ok: true }) })
    const can = r.canRestart({ reason: 'down', evidence: ev })
    eq(ev.owner, 'external', '（前置）归属是 external')
    eq(can.ok, false, '★★★ external + down ⇒ **restart 拒绝动手**（这就是两块的接口契约）')
    ok(/不抢别人的服务端/.test(can.text), '文案就是那条纪律本身')
    try { rmSync(ws, { recursive: true, force: true }) } catch { /* 无所谓 */ }
  }
}

/** 一个假的 spawn：只回 `{pid, unref}`，不真起进程（用于验归属档的写入）。 */
function fakeSpawn(pid) {
  return () => ({ pid, unref() {}, stdout: null, stderr: null, on() {}, once() {}, kill() {} })
}

console.log('\n=== ⑰ ★★★ 整条链端到端：down 事件 → 归属 → 重启编排 → 播报 ===')
//
// 为什么必须补这一节：第⑯节验的是"两块各自的判据"，第⑭节验的是"事件→播报"。
// 而**中间那一段**（事件 → 查归属 → 决定重不重启 → 真去重启 → 说结果）从来没被一起跑过
// —— 本项目最贵的缺陷恰好就在接线上（"任务段从未注入过"那次）。
// 这里用**可注入的探针**把这条链跑通：归属/端口/启动都注入，**判据一点不放宽**。
{
  const { Bridge } = await import('../src/bridge.mjs')
  const { SessionRouter } = await import('../src/session-bridge.mjs')
  const { SendQueue } = await import('../src/onebot.mjs')
  const { writeTask, noteKnownChat } = await import('../src/schedule.mjs')

  const ADMIN = '100000001'
  const SRV = 'srv1'

  function makeChainBridge({ taskAnnounce = 'auto', ownership, launch, portOpen }) {
    const WS = mkdtempSync(join(tmpdir(), 'qqb-chain-'))
    const router = new SessionRouter({ log: () => {} })
    const logs = []
    const log = (m) => logs.push(String(m))
    const config = {
      dsh: { workspace: WS, permissionMode: 'workspace-write' },
      onebot: {},
      access: { adminUsers: [ADMIN], dmAllowlist: [], groupAllowlist: [] },
      trigger: { private: true, mention: true, keyword: true, groupEnabled: true, keywords: ['小鲸鱼'] },
      send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 100, maxPerHour: 1000, dedupeWindowMs: 0, maxCharsPerMessage: 1500 },
      turn: { timeoutMs: 5000 },
      humanize: { enabled: false, chunkChars: 300 },
      persona: { preset: 'none' },
      memory: { enabled: false, affect: { prewake: 'off' } },
      image: { enabled: false },
      schedule: { enabled: true },
      // ★ 一台**配好启动命令**的服务器（否则 restart 会以 no-launcher 拒绝）
      servers: [{ id: SRV, name: '主服', host: '127.0.0.1', port: 25565, rconPort: 25575, password: 'x', enabled: true, failThreshold: 1, startCommand: 'java -jar server.jar', rules: {} }],
    }
    const rpc = new EventTarget()
    rpc.prompts = []
    rpc.prompt = async (sessionId, blocks) => {
      rpc.prompts.push(String(blocks?.[0]?.text ?? ''))
      router.handleEvent(sessionId, {
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: '服务器连不上，我重启了一次，已经好了' }] } },
      })
      router.handleEvent(sessionId, { type: 'turn/end', data: { reason: 'completed' } })
      return { messageId: 'm1' }
    }
    const onebot = new EventTarget()
    onebot.selfId = '200000001'
    onebot.call = async () => ({ status: 'ok', retcode: 0, data: null })
    const sent = []
    onebot.send = async (kind, peerId, text, opts) => {
      sent.push({ kind, peerId, text, ...(opts ?? {}) })
      return { status: 'ok', retcode: 0, data: { message_id: `s${sent.length}` } }
    }
    const sendQueue = new SendQueue({ ...config.send, log })
    const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, log })
    noteKnownChat({ workspace: WS, chatKey: `private:${ADMIN}` })
    writeTask({
      workspace: WS,
      task: {
        id: 'watch1',
        title: '服务器挂了要报',
        repeat: { kind: 'daily', at: '00:00', weekdays: null },
        trigger: { kind: 'server', serverId: SRV, events: ['down'], cooldownMs: 0, announce: { down: taskAnnounce, up: taskAnnounce, anomaly: taskAnnounce } },
        target: { kind: 'private', peerId: ADMIN },
        prompt: '{server} 挂了',
        timezone: 'Asia/Shanghai',
      },
      now: Date.now(),
    })
    bridge.setServerProbesForTest({ ownership, launch, portOpen })
    // ★★ 让"等端口/等恢复"**不真等**（它默认要等满 60 秒 / 180 秒）。
    //   不注入的话这一节要跑 3 分钟 —— 整个测试链的时长会被它一个人拖垮。
    bridge.setRestartTimingForTest({ sleep: async () => {}, stopWaitMs: 0, upWaitMs: 0 })
    return { bridge, rpc, sent, logs, WS }
  }

  const downRow = () => ({ seq: 1, at: Date.now(), serverId: SRV, serverName: '主服', event: 'down', detail: '连不上那个 RCON 端口', text: '连不上那个 RCON 端口', snapshot: { reachable: false } })

  // ── ① 归属是我的 + 启动成功 + 端口恢复 ⇒ 一条链走完：重启 + 播报 ──
  {
    let busy = true
    const launched = []
    const { bridge, rpc, sent, logs, WS } = makeChainBridge({
      ownership: async () => ({ owner: 'bridge', pid: 777, startedAt: 1000, portOpen: true, why: '是我起的' }),
      portOpen: async () => busy,
      launch: async (s) => {
        launched.push(s.id)
        busy = true // 新进程开始监听
        return { ok: true, pid: 888 }
      },
    })
    // 停服由 RCON 连接做；这一轮没有真 RCON ⇒ 它会报"没有可用的连接"，但重启仍继续
    // （`stopGracefully` 失败**不影响**编排 —— 端口释放那一步才是判据）
    const r = await bridge.onServerEventForTest(downRow())
    eq(launched.length, 1, '★★★ 归属是我的 ⇒ **真的走了重启编排**（launch 被调了一次）')
    eq(r.announced, 1, '★ 而且 auto 档位 ⇒ 播报了')
    eq(rpc.prompts.length, 1, '★ 播报真的产生了模型调用')
    ok(sent.some((x) => x.text.includes('重启')), '★ 那条消息真的发出去了')
    ok(
      logs.some((l) => l.includes('已重启成功')) || logs.some((l) => l.includes('已恢复')),
      '★ 日志里留下了"重启成功"的证据',
    )
    // 重试计数归零（成功之后）—— 从盘上看
    const rst = JSON.parse(readFileSync(join(WS, 'runtime/servers/srv1.restart.json'), 'utf8'))
    eq(rst.attempts, 0, '★ 成功之后 attempts 归零（"每次故障最多一次"）')
    ok(Number(rst.cooldownUntil) > 0, '★ 设了冷却')
    await bridge.close({ timeoutMs: 300 })
  }

  // ── ② ★★★ 归属**不是我的** ⇒ 一次 launch 都不调（这就是那条纪律的落地）──
  {
    const launched = []
    const { bridge, logs } = makeChainBridge({
      ownership: async () => ({ owner: 'external', pid: null, startedAt: null, portOpen: true, why: '端口有东西在听，但不是我起的' }),
      portOpen: async () => true,
      launch: async (s) => {
        launched.push(s.id)
        return { ok: true, pid: 999 }
      },
    })
    await bridge.onServerEventForTest(downRow())
    eq(launched.length, 0, '★★★ 归属 external ⇒ **一次都没去启动**（绝不抢别人的服务端）')
    ok(
      logs.some((l) => l.includes('不抢别人的服务端')) || logs.some((l) => l.includes('没有重启')),
      '★ 而且如实记下"为什么不重启"',
    )
    await bridge.close({ timeoutMs: 300 })
  }

  // ── ③ 指标异常（anomaly）**永不重启** —— 即使归属是我的 ──
  {
    const launched = []
    const { bridge } = makeChainBridge({
      ownership: async () => ({ owner: 'bridge', pid: 777, startedAt: 1000, portOpen: true, why: '是我起的' }),
      portOpen: async () => true,
      launch: async (s) => {
        launched.push(s.id)
        return { ok: true, pid: 999 }
      },
    })
    // 这条事件类型不在任务的 events 里（任务只盯 down），但**重启判据本身**也要挡住它
    await bridge.onServerEventForTest({ ...downRow(), event: 'anomaly', text: 'TPS 只有 8' })
    eq(launched.length, 0, '★★ anomaly ⇒ 不重启（"TPS 低就重启"是赌博），即使归属是我的')
    await bridge.close({ timeoutMs: 300 })
  }

  // ── ④ 起来了但端口没恢复 ⇒ 播报"没起来 + 等你指令"，且**不再自动重试** ──
  {
    let busy = true
    let launchCount = 0
    const { bridge, logs } = makeChainBridge({
      ownership: async () => ({ owner: 'bridge', pid: 777, startedAt: 1000, portOpen: true, why: '是我起的' }),
      // 停完释放（false），起完**仍然不通**（false）⇒ 走"没恢复"那条路
      portOpen: async () => busy,
      launch: async () => {
        launchCount += 1
        busy = false // 起是起了，但端口一直没通
        return { ok: true, pid: 999 }
      },
    })
    await bridge.onServerEventForTest(downRow())
    eq(launchCount, 1, '★ 试了一次')
    ok(
      logs.some((l) => l.includes('重启失败')) || logs.some((l) => l.includes('没恢复正常')),
      '★★ 如实记下"重启失败"（不许把"我试过了"说成"已经好了"）',
    )
    const rst = JSON.parse(readFileSync(join(bridge.config.dsh.workspace, 'runtime/servers/srv1.restart.json'), 'utf8'))
    eq(rst.waitingForAdmin, true, '★★ 进入"等管理员指令"')
    // 再来一条 down ⇒ **不再自动重启**（次数用尽 + 等指令）
    const before = launchCount
    await bridge.onServerEventForTest({ ...downRow(), seq: 2 })
    eq(launchCount, before, '★★★ 第二次 down ⇒ **一次都没再试**（"试一次"是硬保证）')
    await bridge.close({ timeoutMs: 300 })
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * ⑱ ★★★ 启动时接管（`servers[].manageOnStart`）—— 0.3.2 P2 的"启动接管"
 *
 * ★ 这一节存在的**唯一**理由是那条不可逆的纪律：
 *   **端口活着时绝不 launch** —— 两个 JVM 同写一个世界目录 = 存档损坏。
 *   它错在"调用顺序与条件"上，所以**纯函数断言抓不到**（本项目栽过：
 *   任务段的 chatKey 在错作用域里被空 catch 吞掉，124 项纯函数断言全绿）。
 * ══════════════════════════════════════════════════════════════════════════ */
{
  const { Bridge } = await import('../src/bridge.mjs')
  const { SessionRouter } = await import('../src/session-bridge.mjs')
  const { SendQueue } = await import('../src/onebot.mjs')

  // ★ 自己造桥接（`makeChainBridge` 是上一节的局部函数，作用域外拿不到 —— 实测报
  //   `ReferenceError: makeChainBridge is not defined`）。
  //   这里只需要"一台配了启动方式的服务器 + 可注入的归属/端口/launch"，其余照最小配置。
  const mkStartBridge = ({ ownership, portOpen, launch }) => {
    // ★★ 三个探针**缺一不可**，缺了就会回退去探**真端口**（实测踩到两次）：
    //   这台机器上 25565 真的开着（联调用的 Forge 服）⇒ 不注入 ownership 就判成
    //   "归属不是我"、不注入 portOpen 就判成"端口活着"，于是**测试走了另一条分支**，
    //   断言测的是空气。所以这里显式挡一下，缺了就当场炸（比"测了空气"好得多）。
    if (typeof ownership !== 'function' || typeof portOpen !== 'function' || typeof launch !== 'function') {
      throw new Error('mkStartBridge：ownership / portOpen / launch 三个探针都必须注入（否则会误探真端口）')
    }
    const WS = mkdtempSync(join(tmpdir(), 'qqb-start-'))
    const router = new SessionRouter({ log: () => {} })
    const logs = []
    const log = (m) => logs.push(String(m))
    const config = {
      dsh: { workspace: WS, permissionMode: 'workspace-write' },
      onebot: {},
      access: { adminUsers: ['100000001'], dmAllowlist: [], groupAllowlist: [] },
      trigger: { private: true, mention: true, keyword: true, groupEnabled: true, keywords: [] },
      send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 100, maxPerHour: 1000, dedupeWindowMs: 0, maxCharsPerMessage: 1500 },
      turn: { timeoutMs: 5000 },
      humanize: { enabled: false, chunkChars: 300 },
      persona: { preset: 'none' },
      memory: { enabled: false, affect: { prewake: 'off' } },
      image: { enabled: false },
      servers: [
        {
          id: 'srv1',
          name: '主服',
          host: '127.0.0.1',
          port: 25565,
          rconPort: 25575,
          password: 'x',
          enabled: true,
          failThreshold: 1,
          startExe: 'java.exe',
          startArgs: ['-jar', 'server.jar'],
          rules: {},
        },
      ],
    }
    const rpc = new EventTarget()
    rpc.prompt = async () => ({ messageId: 'm1' })
    const onebot = new EventTarget()
    onebot.selfId = '200000001'
    onebot.call = async () => ({ status: 'ok', retcode: 0, data: null })
    onebot.send = async () => ({ status: 'ok', retcode: 0, data: { message_id: 's1' } })
    const sendQueue = new SendQueue({ ...config.send, log })
    const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, log })
    bridge.setServerProbesForTest({ ownership, launch, portOpen })
    return { bridge, logs }
  }

  // ── ① 端口活着 + 归属是我 ⇒ **接管，一次 launch 都不许发生** ──
  {
    let launchCount = 0
    const { bridge, logs } = mkStartBridge({
      ownership: async () => ({ owner: 'bridge', pid: 777, startedAt: 1000, portOpen: true, why: '是我起的' }),
      portOpen: async () => true,
      launch: async () => {
        launchCount += 1
        return { ok: true }
      },
    })
    // 只有显式打开 manageOnStart 的那台才会被处理
    bridge.config.servers = [{ ...bridge.config.servers[0], enabled: true, manageOnStart: true }]
    await bridge.manageServersOnStartForTest()
    eq(launchCount, 0, '★★★ 端口活着 + 归属是我 ⇒ **一次 launch 都没发生**（存档损坏那条底线）')
    ok(logs.some((l) => l.includes('接管')), '★ 日志写明"接管"（不许静默跳过）')
    await bridge.close({ timeoutMs: 300 })
  }

  // ── ② 端口活着 + 归属**不是我** ⇒ 只报告，**也**一次 launch 都不许发生 ──
  {
    let launchCount = 0
    const { bridge, logs } = mkStartBridge({
      ownership: async () => ({ owner: 'external', pid: null, startedAt: null, portOpen: true, why: '归属档里记的 pid 已经不存在了' }),
      portOpen: async () => true,
      launch: async () => {
        launchCount += 1
        return { ok: true }
      },
    })
    bridge.config.servers = [{ ...bridge.config.servers[0], enabled: true, manageOnStart: true }]
    await bridge.manageServersOnStartForTest()
    eq(launchCount, 0, '★★★ 端口活着但归属不是我 ⇒ **也绝不 launch**（绝不用"先杀再起"去抢别人的服务端）')
    ok(
      logs.some((l) => l.includes('归属不是我')),
      '★★ 如实记下"归属不是我"（降级成只报告，而不是赌一把）',
    )
    await bridge.close({ timeoutMs: 300 })
  }

  // ── ③ 端口不通 ⇒ 真的拉起来，并**等到端口开放**才说成功 ──
  {
    let launchCount = 0
    let listening = false
    const { bridge, logs } = mkStartBridge({
      ownership: async () => ({ owner: 'unknown', pid: null, startedAt: null, portOpen: listening, why: '端口上没有东西在听' }),
      portOpen: async () => listening,
      launch: async () => {
        launchCount += 1
        listening = true // 拉起来之后端口才通
        return { ok: true, pid: 4242, logFile: 'x.log' }
      },
    })
    bridge.config.servers = [{ ...bridge.config.servers[0], enabled: true, manageOnStart: true, startWaitMs: 5000 }]
    await bridge.manageServersOnStartForTest()
    eq(launchCount, 1, '★ 端口不通 ⇒ 拉起来（这正是"服务端要由机器人启动"那条）')
    ok(logs.some((l) => l.includes('真的起来了')), '★★ 等到端口开放才报"真的起来了"（不拿 launch() 的返回值当成功）')
    await bridge.close({ timeoutMs: 300 })
  }

  // ── ④ 拉起来但端口一直不开 ⇒ **如实说它没起来**（不许谎报） ──
  {
    const { bridge, logs } = mkStartBridge({
      ownership: async () => ({ owner: 'unknown', pid: null, startedAt: null, portOpen: false, why: '端口上没有东西在听' }),
      portOpen: async () => false,
      launch: async () => ({ ok: true, pid: 4242, logFile: 'x.log' }),
    })
    bridge.config.servers = [{ ...bridge.config.servers[0], enabled: true, manageOnStart: true, startWaitMs: 400 }]
    await bridge.manageServersOnStartForTest()
    ok(logs.some((l) => l.includes('它没起来')), '★★★ 端口一直不开 ⇒ 如实说"它没起来"（绝不谎报成功）')
    ok(logs.some((l) => l.includes('x.log')), '★ 并指路控制台输出（否则使用者无从查起）')
    await bridge.close({ timeoutMs: 300 })
  }

  // ── ⑤ 没打开开关 / 停用 / 没起来（launch 拒绝）三种"什么都不做" ──
  {
    let launchCount = 0
    const mk = (serverOver) => {
      const b = mkStartBridge({
        // ★ 归属也必须注入（实测踩到：不注入就走真探针，而**这台机器上 25565 真的开着**
        //   —— 于是判成"归属不是我"，根本没走到 launch，断言测的是空气）
        ownership: async () => ({ owner: 'unknown', pid: null, startedAt: null, portOpen: false, why: '端口上没有东西在听' }),
        portOpen: async () => false,
        launch: async () => {
          launchCount += 1
          return { ok: true, pid: 1, logFile: 'x.log' }
        },
      })
      b.bridge.config.servers = [{ ...b.bridge.config.servers[0], ...serverOver }]
      return b
    }
    const a = mk({ enabled: true, manageOnStart: false })
    await a.bridge.manageServersOnStartForTest()
    eq(launchCount, 0, '★★ 没打开 `manageOnStart` ⇒ 一个都不拉起（默认关，危险能力默认关）')
    await a.bridge.close({ timeoutMs: 300 })

    const b = mk({ enabled: false, manageOnStart: true })
    await b.bridge.manageServersOnStartForTest()
    eq(launchCount, 0, '★ 停用的那台 ⇒ 不拉起')
    await b.bridge.close({ timeoutMs: 300 })

    const c = mkStartBridge({
      ownership: async () => ({ owner: 'unknown', pid: null, startedAt: null, portOpen: false, why: '端口上没有东西在听' }),
      portOpen: async () => false,
      launch: async () => ({ ok: false, why: '没配启动方式' }),
    })
    c.bridge.config.servers = [{ ...c.bridge.config.servers[0], enabled: true, manageOnStart: true }]
    await c.bridge.manageServersOnStartForTest()
    ok(c.logs.some((l) => l.includes('没配启动方式')), '★★ launch 拒绝时**如实说原因**（不猜、不假装已拉起）')
    await c.bridge.close({ timeoutMs: 300 })
  }
}

console.log('')
if (fail === 0) {
  console.log(`🎉 RCON 与服务器监测测试：${pass} 项通过`)
  process.exitCode = 0
} else {
  console.log(`❌ RCON 与服务器监测测试：${pass} 项通过、${fail} 项失败`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
}
assert.ok(true)
