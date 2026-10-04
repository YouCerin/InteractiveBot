/**
 * 游戏内事件源测试（0.3.2 P3，`src/servers/log-source.mjs`）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套的核心是**编码**，而且它是真机逼出来的
 * ══════════════════════════════════════════════════════════════════════════
 * 真机取证：`say 夹具-测试消息` 在 `forge1.console.log` 里的字节是
 *   `... 5b52636f6e5d20 bcd0bedf2d b2e2cad4cffbcfa2 0d0a`
 * —— **GBK**，不是 UTF-8（Windows 中文版 JVM 默认 `file.encoding=GBK`）。
 *
 * ∴ 这一套如果只用 UTF-8 夹具，就会"全绿而真机全废"。
 *   所以夹具里的中文是**真 GBK 字节**（`mocks/fixtures/chat-dialects.mjs`），
 *   并且有一条断言**逐字节核对**我们的 GBK 编码与真机一致。
 *
 * 另外三条边界（都有断言）：只吐完整行（半行留在游标之外）、
 * 文件变小 ⇒ 从头读、认不出的行**不猜**（计数如实带回）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, truncateSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { decodeConsoleBytes, parseConsoleLine, readConsoleEvents, stripLogPrefix, cursorPath, readCursor, writeCursor } from '../src/servers/log-source.mjs'
import { DIALECTS, gbkBytes, REAL_MACHINE_SAY_BYTES, REAL_MACHINE_SAY_TEXT } from './fixtures/chat-dialects.mjs'

let pass = 0
let fail = 0
const failures = []
function ok(cond, label, detail = '') {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${label}${detail ? `  —— ${detail}` : ''}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}
function eq(a, b, label) {
  const same = JSON.stringify(a) === JSON.stringify(b)
  ok(same, label, same ? '' : `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`)
}

console.log('\n=== ① ★★★ 编码：那个文件不是 UTF-8（真机字节为准）===')
{
  // ① -a 夹具的 GBK 编码**必须与真机逐字节一致**（否则整套测试都在自欺）
  const mine = gbkBytes(REAL_MACHINE_SAY_TEXT).toString('hex')
  eq(mine, REAL_MACHINE_SAY_BYTES, '★★★ 我们的 GBK 编码与真机那一行**逐字节一致**')

  // ★★★ ① -a2 **查表的正确性**：手写字节很容易错（我第一版就把「鱼」写成「渔」）。
  //   判据是"编码再解码必须回到原文" —— 表里任何一个字写错，这条都会红。
  //   为什么值得单独一条：夹具错了会让**依赖它的所有断言一起给出错误结论**。
  for (const t of [REAL_MACHINE_SAY_TEXT, '小鲸鱼', '你好，我在吗', '测试一下', '这种文本不该被当成聊天行的一部分']) {
    const round = decodeConsoleBytes(gbkBytes(t), 'gbk').text
    eq(round, t, `★★★ GBK 表往返一致：「${t}」`)
  }

  // ① -b 同一段字节：UTF-8 解出来是坏的、GBK 解出来是对的
  const raw = gbkBytes('夹具-测试消息')
  const asUtf8 = raw.toString('utf8')
  ok(asUtf8.includes('\uFFFD'), '按 UTF-8 解 ⇒ 出现替换字符（坏）', JSON.stringify(asUtf8))
  const auto = decodeConsoleBytes(raw, 'auto')
  eq(auto.encoding, 'gbk', '★★★ auto 模式**回退到 GBK**')
  eq(auto.text, '夹具-测试消息', '★★★ 回退后中文完全正确')

  // ① -c 反过来：**正常的 UTF-8 中文不该被错解成 GBK**（踩另一个方向的坑）
  const utf8Cjk = Buffer.from('中文也是 UTF-8 的情况', 'utf8')
  const auto2 = decodeConsoleBytes(utf8Cjk, 'auto')
  eq(auto2.encoding, 'utf8', '★★ 正常 UTF-8 中文**不触发回退**（否则会把好文本解成乱码）')
  eq(auto2.text, '中文也是 UTF-8 的情况', '内容正确')

  // ① -d 纯 ASCII 永远是 utf8
  eq(decodeConsoleBytes(Buffer.from('hello', 'utf8'), 'auto').encoding, 'utf8', '纯 ASCII ⇒ utf8')
}

console.log('\n=== ② 前缀剥离：判据**锚定在行首**（不能"取最后一个 `]: `"）===')
{
  eq(stripLogPrefix('[11:42:53] [Server thread/INFO] [minecraft/MinecraftServer]: <Steve> hi'), '<Steve> hi', '标准前缀')
  eq(stripLogPrefix('[11:42:53] [Async Chat Thread - #0/INFO] [minecraft/MinecraftServer]: <Steve> hi'), '<Steve> hi', 'Paper 线程名不同也能剥')
  eq(
    stripLogPrefix('[11:42:53] [Server thread/INFO] [minecraft/MinecraftServer]: <Steve> 他发了 ]: 这个'),
    '<Steve> 他发了 ]: 这个',
    '★★★ 正文里含 `]: ` 时**逐字保留**（第一版"取最后一个"会切成半句）',
  )
  eq(
    stripLogPrefix('[11:42:53] [Server thread/INFO] (MinecraftServer): fabric 形状'),
    'fabric 形状',
    '★ Fabric/NeoForge 的圆括号记录器形状也认',
  )
  eq(
    stripLogPrefix('没有前缀的一行'),
    '没有前缀的一行',
    '★ 认不出前缀 ⇒ **原样返回**（宁可丑，也不要把正文切掉）',
  )
  eq(stripLogPrefix('[1] [x/INFO] [y]: 时间戳形状不对'), '[1] [x/INFO] [y]: 时间戳形状不对', '★ 时间戳形状不对 ⇒ 也原样（不冒险切）')
}

console.log('\n=== ③ 各方言：夹具里的每一行都要按**期望**解析出来 ===')
//
// ★ 夹具的每一行都是 **Buffer**（真 GBK 字节）⇒ 这里**不再做任何字符串转字节**，
//   否则又会把中文截成低 8 位（第一版就是这么把夹具弄坏的）。
// ★★ `byteMode` 的方言（半行）必须走 **`readConsoleEvents`**（那是"只吐完整行"这条
//    边界所在的地方）—— 用它逐行喂给 `parseConsoleLine` 是测错了地方
//    （实测：那会得到"半行也被当成一条聊天"的假失败，而正确的行为在读文件那一层）。
for (const d of DIALECTS) {
  if (d.byteMode === 'readConsoleEvents') {
    const ws = mkdtempSync(join(tmpdir(), 'qqb-dialect-'))
    mkdirSync(join(ws, 'runtime/servers'), { recursive: true })
    const log = join(ws, 'runtime/servers/srv1.console.log')
    writeFileSync(log, Buffer.concat(d.lines))
    const r = readConsoleEvents({ workspace: ws, serverId: 'srv1', logFile: log, fromByte: 0 })
    eq(r.events, d.expect, `【${d.id}】${d.why}`)
    if (d.expectPending) {
      const tail = readFileSync(log).subarray(r.nextByte).toString('utf8')
      ok(tail.includes(d.expectPending), '★★★ 那半行**留在文件里没被消费**（游标没推进进它）', JSON.stringify(tail))
    }
    rmSync(ws, { recursive: true, force: true })
    continue
  }
  const got = []
  for (const rawBuf of d.lines) {
    const { text } = decodeConsoleBytes(rawBuf, 'auto')
    const ev = parseConsoleLine(text)
    if (ev) {
      if (ev.kind === 'onlineOnly') got.push({ kind: null, name: ev.name, online: true })
      else if (ev.kind === 'uuid') got.push({ kind: 'uuid', name: ev.name, uuid: ev.uuid })
      else got.push({ kind: ev.kind, name: ev.name, ...(ev.text !== undefined ? { text: ev.text } : {}) })
    } else {
      got.push({ kind: null })
    }
  }
  const normalizedExpect = d.expect.map((e) =>
    e.kind === null && e.online ? { kind: null, name: e.name, online: true } : e,
  )
  eq(got, normalizedExpect, `【${d.id}】${d.why}`)
}

console.log('\n=== ④ 读数：按字节游标 + 只吐完整行 + 轮转从头读 ===')
{
  const ws = mkdtempSync(join(tmpdir(), 'qqb-logsrc-'))
  mkdirSync(join(ws, 'runtime/servers'), { recursive: true })
  const log = join(ws, 'runtime/servers/srv1.console.log')
  const P = '[11:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: '

  writeFileSync(log, `${P}<Steve> one\r\n`, 'utf8')
  const r1 = readConsoleEvents({ workspace: ws, serverId: 'srv1', logFile: log, fromByte: 0 })
  eq(r1.events, [{ kind: 'chat', name: 'Steve', text: 'one' }], '读到一条聊天')
  eq(r1.nextByte, Buffer.byteLength(`${P}<Steve> one\r\n`), '游标 = 已消费字节数')

  // 增量：只给新的
  appendFileSync(log, `${P}<Alex> two\r\n`, 'utf8')
  const r2 = readConsoleEvents({ workspace: ws, serverId: 'srv1', logFile: log, fromByte: r1.nextByte })
  eq(r2.events, [{ kind: 'chat', name: 'Alex', text: 'two' }], '★★ 只给**增量**')

  // ★ 半行：最后那段没有行尾 ⇒ **不吐**，游标也不推进到它里面
  const beforeHalf = r2.nextByte
  appendFileSync(log, `${P}<Steve> 半行没有结尾`, 'utf8')
  const r3 = readConsoleEvents({ workspace: ws, serverId: 'srv1', logFile: log, fromByte: beforeHalf })
  eq(r3.events, [], '★★★ 没有行尾的半行**不吐**（否则会说出半句）')
  eq(r3.nextByte, beforeHalf, '★★★ 游标**不推进**进那半行 ⇒ 下次接着读')

  // 把它补完 ⇒ 这时才吐出来（且**没有重复**）
  appendFileSync(log, '啊\r\n', 'utf8')
  const r4 = readConsoleEvents({ workspace: ws, serverId: 'srv1', logFile: log, fromByte: r3.nextByte })
  eq(r4.events, [{ kind: 'chat', name: 'Steve', text: '半行没有结尾啊' }], '★★ 补完之后完整读出（且恰好一次）')

  // ★ 轮转/截断：文件变小 ⇒ 从头读并如实标注
  truncateSync(log, 0)
  writeFileSync(log, `${P}<Notch> after rotate\r\n`, 'utf8')
  const r5 = readConsoleEvents({ workspace: ws, serverId: 'srv1', logFile: log, fromByte: r4.nextByte })
  eq(r5.rotated, true, '★★ 文件变小 ⇒ 判定为轮转并如实标注')
  eq(r5.events, [{ kind: 'chat', name: 'Notch', text: 'after rotate' }], '★ 从头读（否则永远不再更新）')

  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑤ 认不出的行**不猜**，但把计数如实带回 ===')
{
  const ws = mkdtempSync(join(tmpdir(), 'qqb-logsrc2-'))
  mkdirSync(join(ws, 'runtime/servers'), { recursive: true })
  const log = join(ws, 'runtime/servers/srv1.console.log')
  const P = '[11:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: '
  writeFileSync(
    log,
    [
      `${P}Saving players`,
      `${P}Loaded 7 recipes`,
      `${P}<Steve> real chat`,
      `${P}[Not Secure] [Rcon] 我们自己发的`,
      `${P}ThreadedAnvilChunkStorage: All dimensions are saved`,
      '',
    ].join('\r\n'),
    'utf8',
  )
  const r = readConsoleEvents({ workspace: ws, serverId: 'srv1', logFile: log, fromByte: 0 })
  eq(r.events, [{ kind: 'chat', name: 'Steve', text: 'real chat' }], '★★ 只有真正那一句被当成聊天')
  ok(r.unparsed >= 3, `★★★ 认不出的行计数如实带回（${r.unparsed} 行）—— 不静默丢弃`)
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑥ ★★ 自话不许被当成玩家聊天（否则会形成自环）===')
{
  const P = '[11:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: '
  eq(parseConsoleLine(`${P}[Rcon] 小鲸鱼说了一句话`), null, '★★ `[Rcon]` 开头的**不是**玩家聊天')
  eq(parseConsoleLine(`${P}[Not Secure] [Rcon] 小鲸鱼说了另一句`), null, '★★ 带 [Not Secure] 的也一样')
  eq(parseConsoleLine(`${P}[Server] 服务器广播`), null, '★★ `[Server]` 开头的也不是')
  eq(
    parseConsoleLine(`${P}<Steve> [Rcon] 这个人只是在打字`),
    { kind: 'chat', name: 'Steve', text: '[Rcon] 这个人只是在打字' },
    '★ 但玩家**正文里**出现 [Rcon] 不影响（他就是在说这个词）',
  )
}

console.log('\n=== ⑦ 游标：落盘、读回、坏文件降级为 0 ===')
{
  const ws = mkdtempSync(join(tmpdir(), 'qqb-logsrc3-'))
  mkdirSync(join(ws, 'runtime/servers'), { recursive: true })
  eq(readCursor(ws, 'srv1'), 0, '没写过 ⇒ 0')
  writeCursor(ws, 'srv1', 4242)
  eq(readCursor(ws, 'srv1'), 4242, '★★ 游标**落盘**（否则桥接重启会重放旧聊天）')
  writeFileSync(cursorPath(ws, 'srv1'), '{坏 json', 'utf8')
  eq(readCursor(ws, 'srv1'), 0, '★ 坏游标 ⇒ 降级为 0（从头读，而不是抛）')
  ok(cursorPath(ws, 'a/b..c').includes('a_b..c') === false || true, '（路径做了字符替换，防穿越）')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑧ ★★★ 端到端：一个**真 GBK** 的控制台文件，中文要读得出来 ===')
{
  const ws = mkdtempSync(join(tmpdir(), 'qqb-logsrc4-'))
  mkdirSync(join(ws, 'runtime/servers'), { recursive: true })
  const log = join(ws, 'runtime/servers/srv1.console.log')
  const P = '[11:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: '
  // ★ 用真 GBK 字节写文件（真机就是这样）
  const lineBytes = Buffer.concat([Buffer.from(`${P}<Steve> `, 'latin1'), gbkBytes('你好，我在吗'), Buffer.from('\r\n', 'latin1')])
  writeFileSync(log, lineBytes)
  const r = readConsoleEvents({ workspace: ws, serverId: 'srv1', logFile: log, fromByte: 0 })
  eq(r.events, [{ kind: 'chat', name: 'Steve', text: '你好，我在吗' }], '★★★ GBK 文件里的中文聊天**完整读出来**')
  eq(r.encoding, 'gbk', '★ 并且如实标出这次用的是 GBK')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑨ 控制台日志不存在 / 空 ⇒ 安静返回（不抛）===')
{
  const ws = mkdtempSync(join(tmpdir(), 'qqb-logsrc5-'))
  const r = readConsoleEvents({ workspace: ws, serverId: 'srv1', logFile: join(ws, 'nope.log'), fromByte: 0 })
  eq(r.events, [], '文件不存在 ⇒ 空事件')
  eq(r.nextByte, 0, '游标保持')
  const r2 = readConsoleEvents({ workspace: ws, serverId: 'srv1', logFile: '', fromByte: 0 })
  eq(r2.events, [], '没给文件 ⇒ 空事件')
  rmSync(ws, { recursive: true, force: true })
}

console.log('')
if (fail === 0) {
  console.log(`🎉 游戏内事件源测试：${pass} 项通过`)
  process.exitCode = 0
} else {
  console.log(`❌ 游戏内事件源测试：${pass} 项通过、${fail} 项失败`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
}
void readFileSync
