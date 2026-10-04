#!/usr/bin/env node
/**
 * `server.properties` 那一层的测试（0.3.2 收尾）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套存在的理由
 * ══════════════════════════════════════════════════════════════════════════
 * 使用者问：「开服时显示 enable-rcon=false，能否在桥接的编辑栏直接修改」——
 * 于是有了"从界面改服务端的 `server.properties`"这条路。它**写的是别人的配置文件**，
 * 所以这里盯的不是"功能能不能用"，而是**它会不会改坏东西**：
 *
 *   ① **只碰三行**：`enable-rcon` / `rcon.port` / `rcon.password`。
 *      其余行（注释、顺序、空行、我们看不懂的键）必须**逐字不动** —— 有断言逐行比。
 *   ② **写不出错值**：端口越界 / 空密码 / 密码带换行 / `enableRcon` 不是布尔 ⇒ 一律拒绝，
 *      而且**原文一个字都不变**（不是"改了一半再报错"）。
 *   ③ **幂等**：值本来就对 ⇒ `changed` 为空（别制造无意义的 diff）。
 *   ④ **找文件不猜**：只认归属档的 `cwd` 与 `servers[].cwd`；都没有 ⇒ 如实说"不知道目录"，
 *      **不去盘上乱找**（找错文件 = 改了别的服务器的配置，比改不了严重得多）。
 *   ⑤ 只读那一侧**永不回密码**（连长度都不回）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EULA_URL,
  describeServerSettings,
  patchEula,
  patchServerSettings,
  readEula,
  readServerSettings,
  resolvePropertiesPath,
} from '../src/servers/properties.mjs'

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
const section = (t) => console.log(`\n=== ${t} ===`)

/** 一份**带注释、带别的键**的样例（真机上被服务端重写过的那份已经没有注释了）。 */
const SAMPLE = [
  '#Minecraft server properties',
  '#Fri Oct 04 17:48:13 CST 2026',
  'enable-rcon=false',
  'rcon.port=25575',
  'rcon.password=',
  'level-name=world',
  'motd=A Minecraft Server',
  'max-players=20',
  '',
].join('\n')

section('① 读：三项的当前状态（看不懂就说看不懂，**不猜**）')
{
  const s = readServerSettings(SAMPLE)
  ok(s.enableRcon === false, '★ `enable-rcon=false` 读成 `false`')
  ok(s.rconPort === 25575, '★ 端口读出来了', String(s.rconPort))
  ok(s.passwordSet === false && s.passwordLength === 0, '★★ 空密码 ⇒ `passwordSet:false`（不是"配了一个空密码"）')

  const withPw = readServerSettings('rcon.password=abc123\n')
  ok(withPw.passwordSet === true && withPw.passwordLength === 6, '★ 有密码 ⇒ `passwordSet:true`，长度也对')

  ok(readServerSettings('level-name=world\n').enableRcon === null, '★★ 文件里**没这一项** ⇒ `null`（**不猜成 false**）')
  ok(readServerSettings('enable-rcon=maybe\n').enableRcon === null, '★★ 值看不懂 ⇒ `null`（同上：不猜）')
  ok(readServerSettings('enable-rcon=TRUE\n').enableRcon === true, '★ 大小写不敏感')
  ok(readServerSettings('rcon.port=99999\n').rconPort === null, '★★ 越界端口 ⇒ `null`（不返回一个会被服务端拒绝的值）')
  ok(readServerSettings('#enable-rcon=true\n').enableRcon === null, '★★ **注释掉的那一行不算**（否则会误报"已经开了"）')
  ok(readServerSettings('rcon.password = spaced \n').passwordSet === true, '★ `key = value` 两侧有空格也认')
}

section('② 写：**只改那三行**，其余逐字保留')
{
  const r = patchServerSettings(SAMPLE, { enableRcon: true, rconPort: 25576, password: 'pw-123456' })
  ok(r.ok === true, '★ 改成功')
  ok(r.changed.length === 3, '★ 报了 3 项改动', r.changed.join('、'))

  const before = SAMPLE.split('\n')
  const after = r.text.split('\n')
  ok(after.includes('#Minecraft server properties'), '★★★ 注释**还在**（第一行）')
  ok(after.includes('#Fri Oct 04 17:48:13 CST 2026'), '★★★ 第二条注释还在')
  ok(after.includes('level-name=world') && after.includes('max-players=20'), '★★★ 别的键**逐字没动**')
  ok(after.includes('enable-rcon=true') && after.includes('rcon.port=25576') && after.includes('rcon.password=pw-123456'), '★★ 三行都改了')
  ok(after.length === before.length, '★★ **没有增删行**（长度也没变）', `${before.length} → ${after.length}`)
  ok(r.text.endsWith('\n'), '★ 结尾那个换行保留')

  const only = patchServerSettings(SAMPLE, { enableRcon: true })
  ok(only.changed.length === 1 && only.text.includes('rcon.port=25575') && only.text.includes('rcon.password='), '★★ 只要求改一项 ⇒ **只改那一项**（别的两行原样）')
}

section('③ 幂等：值本来就对 ⇒ 不制造无意义的 diff')
{
  const once = patchServerSettings(SAMPLE, { enableRcon: true, rconPort: 25576, password: 'pw' })
  const twice = patchServerSettings(once.text, { enableRcon: true, rconPort: 25576, password: 'pw' })
  ok(twice.ok === true && twice.changed.length === 0, '★★★ 第二次 `changed` 为空', JSON.stringify(twice.changed))
  ok(twice.text === once.text, '★★★ 而且**文本一个字都没变**')
}

section('④ 拒绝坏输入：一律拒绝，且**原文一个字不变**')
{
  const cases = [
    [{ rconPort: 0 }, '端口 0'],
    [{ rconPort: 70000 }, '端口 70000'],
    [{ rconPort: 'abc' }, '端口不是数字'],
    [{ password: '' }, '空密码（服务端会拒绝开 RCON）'],
    [{ password: 'a\nb' }, '密码里有换行'],
    [{ enableRcon: 'true' }, '`enableRcon` 不是布尔（字符串 "true" 不算）'],
    [{}, '什么都没要求改'],
  ]
  for (const [patch, label] of cases) {
    const r = patchServerSettings(SAMPLE, patch)
    ok(r.ok === false && r.text === SAMPLE, `★★ ${label} ⇒ 拒绝，且原文未变`, r.why ?? '')
  }
}

section('⑤ 文件里缺键 ⇒ 追加在末尾；CRLF 不被打乱')
{
  const minimal = 'level-name=world\n'
  const r = patchServerSettings(minimal, { enableRcon: true, rconPort: 25575, password: 'pw' })
  ok(r.ok === true && r.changed.some((c) => c.includes('新增')), '★ 缺的三项被追加', r.changed.join('、'))
  ok(r.text.startsWith('level-name=world\n'), '★★ 原有那行仍在最前')
  ok(r.text.includes('enable-rcon=true') && r.text.includes('rcon.port=25575') && r.text.includes('rcon.password=pw'), '★ 三项都写进去了')

  const crlf = 'level-name=world\r\nenable-rcon=false\r\n'
  const r2 = patchServerSettings(crlf, { enableRcon: true })
  ok(r2.text.includes('\r\n') && !/[^\r]\n/.test(r2.text), '★★★ CRLF 文件改完**仍是 CRLF**（不混入 LF）')
}

section('⑥ 人话：把"关着"点成原因')
{
  ok(/关/.test(describeServerSettings(readServerSettings('enable-rcon=false\n'))), '★ 关着时说得出来')
  ok(/这就是连不上的原因/.test(describeServerSettings(readServerSettings('enable-rcon=false\n'))), '★★ 并且指出"这就是连不上的原因"')
  ok(/空/.test(describeServerSettings(readServerSettings('enable-rcon=true\nrcon.password=\n'))), '★ 密码空着时也说出来')
  ok(/没有这一项/.test(describeServerSettings(readServerSettings('level-name=w\n'))), '★ 缺项时如实说')
  const d = describeServerSettings(readServerSettings('enable-rcon=true\nrcon.password=abcdef\n'))
  ok(!/abcdef/.test(d), '★★★ **不回密码本身**', d)
  // ⚠️ 这条原来断言的是"整句话里不出现数字 6"（拿它当"不回长度"的代理）—— 而 0.3.2 给这行加了
  //    `server-port=…（默认 25565）` 之后**它被端口里的数字碰响了**：代理判据是脆的。
  //    "不回长度"那条改在**接口层**断言（`verify-api-h13` ④-d-6：响应里既没有值、也没有长度），
  //    这里只留"不回值 + 用『已设置/空』表达"。
  ok(/已设置/.test(d) && !/abcdef|长度|位/.test(d), '★★ 只用"已设置/空"表达（长度也留给接口层去挡）')
  ok(/server-port=/.test(d), '★ 0.3.2 起这一行也报**游戏端口**（它就是"改了游戏端口不生效"的那一项）', d)
}

section('⑦ 找文件：只认归属档与 config 的 cwd，**不猜**')
{
  const ws = mkdtempSync(join(tmpdir(), 'qqb-props-'))
  const serverDir = join(ws, 'store', 'mc-main')
  mkdirSync(join(serverDir), { recursive: true })
  writeFileSync(join(serverDir, 'server.properties'), SAMPLE, 'utf8')
  mkdirSync(join(ws, 'runtime', 'servers'), { recursive: true })
  writeFileSync(
    join(ws, 'runtime', 'servers', 'srv.running.json'),
    JSON.stringify({ version: 1, serverId: 'srv', pid: 1, startedAt: 1, cwd: serverDir }),
    'utf8',
  )

  const a = resolvePropertiesPath({ workspace: ws, server: { id: 'srv' } })
  ok(a.ok === true && a.path === join(serverDir, 'server.properties'), '★★★ 从**归属档的 cwd** 找到了', a.path)
  ok(/归属档/.test(a.from), '★ 并且说明是从哪儿推出来的（"改错文件"是最坏的失败形状）', a.from)

  const b = resolvePropertiesPath({ workspace: ws, server: { id: '别的', cwd: serverDir } })
  ok(b.ok === true && b.path === join(serverDir, 'server.properties'), '★★ 归属档没有 ⇒ 退到 `servers[].cwd`')

  const c = resolvePropertiesPath({ workspace: ws, server: { id: 'srv', cwd: join(ws, '不存在') } })
  ok(c.ok === true, '★★ 归属档优先（配置里那个路径不存在也不影响）')

  const d = resolvePropertiesPath({ workspace: ws, server: { id: '无目录' } })
  ok(d.ok === false && /不猜/.test(String(d.why)), '★★★ 两个来源都没有 ⇒ **如实说不知道，不去盘上乱找**', String(d.why))

  const e = resolvePropertiesPath({ workspace: ws, server: { id: 'srv2', cwd: join(ws, '空目录') } })
  ok(e.ok === false && /都不存在/.test(String(e.why)), '★★ 目录不存在 ⇒ 说清是哪个目录', String(e.why))

  // ★ 两个**不同**的失败要说得出区别（"目录不在" vs "目录在但文件不在"）——
  //   混成一句会让使用者不知道该去建目录还是去建文件。
  const emptyDir = join(ws, '真空目录')
  mkdirSync(emptyDir, { recursive: true })
  const f = resolvePropertiesPath({ workspace: ws, server: { id: 'srv3', cwd: emptyDir } })
  ok(f.ok === false && /里没有 server\.properties/.test(String(f.why)), '★★★ 目录在、文件不在 ⇒ 另一句话（两者不能混）', String(f.why))

  rmSync(ws, { recursive: true, force: true })
}

section('⑧ 游戏端口：`server-port` 也是托管项（"改了游戏端口不生效"就是它）')
{
  const s = readServerSettings('server-port=25565\nlevel-name=world\n')
  ok(s.serverPort === 25565, '★ 读得出来', String(s.serverPort))
  ok(readServerSettings('level-name=world\n').serverPort === null, '★★ 没这一项 ⇒ `null`（**不猜成 25565**）')
  ok(readServerSettings('server-port=abc\n').serverPort === null, '★★ 值看不懂 ⇒ `null`')
  ok(readServerSettings('server-port=99999\n').serverPort === null, '★★ 越界 ⇒ `null`')
  ok(readServerSettings('#server-port=25570\n').serverPort === null, '★★ **注释掉的那一行不算**')

  const r = patchServerSettings(SAMPLE, { serverPort: 25566 })
  ok(r.ok === true && r.changed.length === 1 && r.changed[0] === 'server-port（新增）', '★ 文件里没有 ⇒ 追加', r.changed.join('、'))
  ok(r.text.includes('server-port=25566') && r.text.includes('#Minecraft server properties') && r.text.includes('level-name=world'), '★★ 追加的同时**注释与别的键原样保留**')

  const withPort = SAMPLE.replace('enable-rcon=false', 'server-port=25565\nenable-rcon=false')
  const r2 = patchServerSettings(withPort, { serverPort: 25566 })
  ok(r2.ok === true && r2.changed.join() === 'server-port', '★★ 已有 ⇒ 原地改（不是再加一行）', r2.changed.join('、'))
  ok(r2.text.split('\n').filter((l) => /^server-port=/.test(l)).length === 1, '★★★ **只有一行** `server-port`（不许重复）')
  ok(patchServerSettings(withPort, { serverPort: 0 }).ok === false, '★★ 端口 0 ⇒ 拒绝')
  ok(patchServerSettings(withPort, { serverPort: 70000 }).ok === false, '★★ 端口 70000 ⇒ 拒绝')
  ok(patchServerSettings(withPort, { serverPort: 'abc' }).ok === false, '★★ 端口不是数字 ⇒ 拒绝')
}

section('⑨ EULA：只改 `eula` 那一行（这是"同意条款"，不是普通配置）')
{
  const t1 = '#By changing the setting below to TRUE you are indicating your agreement to our EULA.\neula=false\n'
  const r1 = patchEula(t1, true)
  ok(r1.ok === true && r1.changed.join() === 'eula', '★ `false` ⇒ `true`', r1.changed.join('、'))
  ok(r1.text.includes('#By changing the setting below to TRUE') && r1.text.includes('eula=true'), '★★ 注释原样保留')
  ok(patchEula(r1.text, true).changed.length === 0, '★★ 幂等（已经是 true 就不改）')

  const noLine = '#just a comment\n'
  const r2 = patchEula(noLine, true)
  ok(r2.ok === true && r2.text.includes('eula=true') && r2.text.includes('#just a comment'), '★ 没有那一行 ⇒ 追加，注释仍在')

  const empty = patchEula('', true)
  ok(empty.ok === true && /eula=true/.test(empty.text), '★★ 文件不存在/空 ⇒ 写一份新的')
  ok(empty.text.includes(EULA_URL), '★★★ 新写的那份里**带上官方 EULA 链接**（同意条款这件事要说清）')
  ok(readEula(empty.text).agreed === true, '★★ 写完读回来是"已同意"')

  ok(readEula('eula=false\n').agreed === false, '★ 读 `false`')
  ok(readEula('#eula=true\n').agreed === null, '★★ **注释掉的不算同意**')
  ok(readEula('').agreed === null, '★★ 空文件 ⇒ `null`（= 没同意）')
  ok(readEula('EULA=TRUE\n').agreed === true, '★ 大小写不敏感')
  ok(patchEula('eula=true\n', 'yes').ok === false, '★★ `agree` 不是布尔 ⇒ 拒绝（不许把字符串当同意）')
  ok(patchEula('eula=true\n', false).text.includes('eula=false'), '★ 也能写回 false（撤销同意）')
}

console.log('')
if (fail === 0) {
  console.log(`🎉 server.properties 那一层：${pass} 项通过`)
  process.exitCode = 0
} else {
  console.log(`❌ server.properties 那一层：${pass} 项通过、${fail} 项失败`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
}
