/**
 * 服务器**控制台**（手动输指令）测试 —— 0.3.2 收尾。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套存在的理由（三条，每条都是真机/实测教训）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **RCON 的应答常常是空的**（真机实测：`list` / `forge tps` 有回显，而
 *      `time set day` 这类不回话，结果只进日志）。∴ "命令成功"**不能**用
 *      "有回显"来判，且界面必须如实标注"输出不保证只属于这一条命令" ——
 *      把假终端做成看起来精确的样子才是危险的。
 *   ② **按字节偏移读日志**：文件可能在写一半、也可能被轮转/截断。按行读会把
 *      半行截断；截断后偏移若指向不存在的位置，表现是"控制台永远不再更新"。
 *   ③ **密码绝不出现在任何返回文本里**（同 `rcon.mjs` 的纪律，有断言逐字检查）。
 *
 * ★ 全程不连真服务端：RCON 客户端是**注入的桩**，日志是**真临时文件**
 *   （这一层的正确性恰恰在文件读写上，所以不用假 fs）。
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, appendFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readLogDelta, runConsoleCommand, consoleLogPath, DEFAULT_SETTLE_MS } from '../src/servers/console.mjs'
import { SUPERVISE_DIR } from '../src/servers/supervise.mjs'

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
  ok(a === b, label, a === b ? '' : `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`)
}

const mkTmp = () => {
  const base = mkdtempSync(join(tmpdir(), 'qqb-console-'))
  // ★ 目录要自己建：`consoleLogPath` 只**拼路径**，建目录是 `supervise.launch()` 的事
  //   （真机上那份日志一定已经存在；这里是在造测试现场）。
  mkdirSync(join(base, SUPERVISE_DIR), { recursive: true })
  return base
}

console.log('\n=== ① 日志增量读取：按字节、能扛写一半、能扛截断 ===')
{
  const ws = mkTmp()
  const id = 'srv1'
  const file = consoleLogPath(ws, id)

  eq(consoleLogPath(ws, id), join(ws, SUPERVISE_DIR, `${id}.console.log`), '★ 路径与 supervise 的命名规则一致')
  eq(consoleLogPath(ws, 'a/b\\c'), join(ws, SUPERVISE_DIR, 'a_b_c.console.log'), '★ id 里的路径字符被替换（防穿越）')

  // 文件不存在 ⇒ 空 + 偏移 0（**不抛**）
  const none = readLogDelta(file, 0)
  eq(none.text, '', '文件不存在 ⇒ 空文本')
  eq(none.nextByte, 0, '文件不存在 ⇒ 偏移 0')

  writeFileSync(file, '第一行\n', 'utf8')
  const a = readLogDelta(file, 0)
  eq(a.text, '第一行\n', '从头读到全文')
  eq(a.nextByte, statSync(file).size, '偏移 = 文件大小（下次接着读）')

  // 增量：只读新增
  appendFileSync(file, '第二行\n', 'utf8')
  const b = readLogDelta(file, a.nextByte)
  eq(b.text, '第二行\n', '★ 只读**增量**（不重复给旧内容）')
  const again = readLogDelta(file, b.nextByte)
  eq(again.text, '', '没有新内容 ⇒ 空')

  // 写一半（不含结尾换行）也要能读出来
  appendFileSync(file, '写到一半', 'utf8')
  const c = readLogDelta(file, b.nextByte)
  ok(c.text.includes('写到一半'), '★★ 没有结尾换行的一半行也能读出来（按字节读，不按行）')

  // 截断（轮转/重开）⇒ 从头读并**如实标注** rotated
  truncateSync(file, 0)
  writeFileSync(file, '新的一份\n', 'utf8')
  const d = readLogDelta(file, c.nextByte)
  eq(d.rotated, true, '★★★ 文件变小 ⇒ 判定为**轮转/截断**并如实标注')
  eq(d.text, '新的一份\n', '★ 截断时从头读（否则控制台会永远不再更新）')

  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ② 跑命令：应答为空**不算失败**，密码绝不出现在返回里 ===')
{
  const ws = mkTmp()
  const file = consoleLogPath(ws, 'srv1')
  writeFileSync(file, '既有内容\n', 'utf8')

  const SECRET = 'rcon-pw-xyz'
  const seen = { commands: [], closed: 0 }
  const fakeClient = {
    connect: async () => ({ ok: true }),
    exec: async (cmd) => {
      seen.commands.push(cmd)
      // ★ 真机形状：命令生效了，但 RCON **不回话**（结果只进日志）
      appendFileSync(file, '[Server thread/INFO]: 时间设为白天\n', 'utf8')
      return { ok: true, body: '' }
    },
    close: () => {
      seen.closed += 1
    },
  }
  const r = await runConsoleCommand({
    server: { id: 'srv1', host: '127.0.0.1', rconPort: 25575, password: SECRET },
    command: 'time set day',
    workspace: ws,
    clientFor: () => fakeClient,
    sleep: async () => {}, // 不真等
  })
  eq(r.ok, true, '★★ 命令已送达 ⇒ 成功（**即使 RCON 应答是空的**）')
  eq(r.reply, '', '如实体现在"应答是空的"这一点上')
  ok(r.output.includes('时间设为白天'), '★ 输出 = 控制台日志的**新增片段**')
  ok(!r.output.includes('既有内容'), '★ 增量里**没有**旧内容')
  eq(seen.commands.length, 1, '命令只发了一次')
  eq(seen.closed, 1, '用完就关连接（不留半开的 RCON）')
  ok(typeof r.caveat === 'string' && r.caveat.includes('不保证'), '★★★ 带回那句"输出不保证只属于这一条命令"的如实提醒')
  ok(!JSON.stringify(r).includes(SECRET), '★★★ 返回文本里**一个字符都不能有密码**')

  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ③ 失败路径：都要如实说，且不许把密码带出去 ===')
{
  const ws = mkTmp()
  const SECRET = 'rcon-pw-abc'
  const base = { id: 'srv1', host: '127.0.0.1', rconPort: 25575, password: SECRET }

  // 空命令
  const e1 = await runConsoleCommand({ server: base, command: '   ', workspace: ws, clientFor: () => ({}), sleep: async () => {} })
  eq(e1.ok, false, '空命令 ⇒ 拒绝')
  ok(/空/.test(e1.why), '原因说清"命令是空的"')

  // 没配密码 ⇒ 不发连接
  let connected = 0
  const e2 = await runConsoleCommand({
    server: { ...base, password: '' },
    command: 'list',
    workspace: ws,
    clientFor: () => ({
      connect: async () => {
        connected += 1
        return { ok: true }
      },
      exec: async () => ({ ok: true, body: '' }),
      close: () => {},
    }),
    sleep: async () => {},
  })
  eq(e2.ok, false, '★★ 没配密码 ⇒ 拒绝')
  eq(connected, 0, '★★★ 而且**一次连接都没发起**（猜默认密码没有意义）')
  ok(/password|密码/.test(e2.why), '原因指向 password')

  // 连不上
  const e3 = await runConsoleCommand({
    server: base,
    command: 'list',
    workspace: ws,
    clientFor: () => ({ connect: async () => ({ ok: false, layer: 'network', text: '连不上那个 RCON 端口' }), exec: async () => ({ ok: true }), close: () => {} }),
    sleep: async () => {},
  })
  eq(e3.ok, false, '连不上 ⇒ 失败')
  eq(e3.layer, 'network', '★ 带回错误层（界面据此说"去查哪个开关"）')

  // 命令发失败
  const e4 = await runConsoleCommand({
    server: base,
    command: 'op someone',
    workspace: ws,
    clientFor: () => ({ connect: async () => ({ ok: true }), exec: async () => ({ ok: false, layer: 'timeout', text: '命令超时' }), close: () => {} }),
    sleep: async () => {},
  })
  eq(e4.ok, false, '命令没发出去 ⇒ 失败（不许说成成功）')
  eq(e4.layer, 'timeout', '带回错误层')
  ok(!JSON.stringify(e4).includes(SECRET), '★★★ 失败路径里也没有密码')

  // 抛异常也要兜住
  const e5 = await runConsoleCommand({
    server: base,
    command: 'list',
    workspace: ws,
    clientFor: () => ({
      connect: async () => {
        throw new Error('连接炸了')
      },
      exec: async () => ({ ok: true }),
      close: () => {},
    }),
    sleep: async () => {},
  })
  eq(e5.ok, false, '★★ 客户端抛异常 ⇒ 如实失败（**永不抛**，增强路径纪律）')

  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ④ 默认等待值是个明面上的常量（界面/测试能引用同一份） ===')
{
  ok(Number.isFinite(DEFAULT_SETTLE_MS) && DEFAULT_SETTLE_MS > 0, 'DEFAULT_SETTLE_MS 是正数', `${DEFAULT_SETTLE_MS}ms`)
}

console.log('')
if (fail === 0) {
  console.log(`🎉 服务器控制台测试：${pass} 项通过`)
  process.exitCode = 0
} else {
  console.log(`❌ 服务器控制台测试：${pass} 项通过、${fail} 项失败`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
}
