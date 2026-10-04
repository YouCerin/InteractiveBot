/**
 * **UUID ↔ QQ 绑定**（0.3.2 P3）—— `src/servers/bindings.mjs` / `tellraw.mjs` / `game-chat.mjs`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套守的是什么（全都是"错了不会报错"的那种）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **归属只能绑给发送者本人** —— 绑给"消息里写的那个人"就等于谁看见码谁就能冒名；
 *   ② **码是一次性 + 5 分钟 TTL** —— 它是发在**群里**的（设计文档 §5.6 承认的代价），
 *      所以"能重复用"或"能用一小时"都会把那个代价放大一个数量级；
 *   ③ **码绝不进审计**（审计不含秘密，同 `memory-audit.mjs`）—— UUID 也只留前 8 位；
 *   ④ **改绑必须两边都清 + 留痕** —— 同一 QQ 只能绑一个 UUID、同一 UUID 只能绑一个 QQ，
 *      而"他什么时候被顶替的"事后必须查得到；
 *   ⑤ **`tellraw` 的名字必须严格校验** —— 它是**选择器**：名字里塞进 `@` 会让
 *      "只给本人"变成"全服广播"（`@a` / `@e[tag=x]` 都是合法选择器）；
 *   ⑥ **多份待绑定资格同时存在时绝不猜** —— 猜错 = 把别人的身份算到你头上。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BIND_AUDIT_REL,
  BINDINGS_REL,
  CODE_TTL_MS,
  QUALIFY_TTL_MS,
  appendAudit,
  bindUuid,
  issueCode,
  listBindings,
  lookupByName,
  lookupByQq,
  lookupByUuid,
  newCode,
  parseBindCommand,
  pendingQualifications,
  readAudit,
  readStore,
  redeemCode,
  resetForTest,
  shortUuid,
  unbind,
  unbindByName,
  writeStore,
} from '../src/servers/bindings.mjs'
import { SAY_CHUNK_CHARS, buildSay, buildTellraw, chunkForSay, oneLine, PLAYER_NAME_RE } from '../src/servers/tellraw.mjs'
import { decideGameChat } from '../src/servers/game-chat.mjs'

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

const mkWs = () => {
  const ws = mkdtempSync(join(tmpdir(), 'qqb-bind-'))
  mkdirSync(join(ws, 'runtime'), { recursive: true })
  return ws
}
const UUID_A = '00000000-0000-4000-8000-000000000001'
const UUID_B = '11111111-2222-3333-4444-555555555555'
const QQ_A = '100000001'
const QQ_B = '100000002'

console.log('\n=== ① 本地指令的形状：带前缀才命中，带别的字**不命中** ===')
{
  eq(parseBindCommand('/绑定'), { hit: true, kind: 'issue' }, '★ `/绑定` ⇒ 取码')
  eq(parseBindCommand('/bind'), { hit: true, kind: 'issue' }, '★ `/bind` 是别名')
  eq(parseBindCommand('/BIND'), { hit: true, kind: 'issue' }, '★ 别名大小写不敏感')
  eq(parseBindCommand('  /绑定  '), { hit: true, kind: 'issue' }, '★ 前后空白不影响')
  eq(parseBindCommand('/绑定 123456'), { hit: true, kind: 'redeem', code: '123456' }, '★ `/绑定 <6位>` ⇒ 提交码')
  eq(parseBindCommand('/bind 000000'), { hit: true, kind: 'redeem', code: '000000' }, '★ 别名也能提交（前导零不丢）')

  // ★★★ 「带别的字不命中」：命中即"这一轮一次模型调用都不产生"，
  //    判宽了会把普通闲聊吞掉（表现成"机器人不理我"），判窄只是回到普通聊天。
  eq(parseBindCommand('/绑定 你好'), { hit: false }, '★★ `/绑定 你好` 不命中')
  eq(parseBindCommand('/绑定 12345'), { hit: false }, '★★ 5 位不算码（不命中 ⇒ 回到普通聊天）')
  eq(parseBindCommand('/绑定 1234567'), { hit: false }, '★★ 7 位不算码')
  eq(parseBindCommand('/绑定 123456 额外'), { hit: false }, '★★ 后面还带字 ⇒ 不命中')
  eq(parseBindCommand('/绑定abc'), { hit: false }, '★★ 前缀后**紧跟字母** ⇒ 不命中（那是别的东西）')
  eq(parseBindCommand('绑定'), { hit: false }, '★★ 没有前缀 ⇒ 不命中')
  eq(parseBindCommand('我要绑定'), { hit: false }, '★★ 句子里含有"绑定" ⇒ 不命中')
  eq(parseBindCommand(''), { hit: false }, '空文本 ⇒ 不命中')
  eq(parseBindCommand(null), { hit: false }, 'null ⇒ 不命中（永不抛）')

  eq(parseBindCommand('/解绑 小明'), { hit: true, kind: 'unbind', target: '小明' }, '★ `/解绑 <目标>` ⇒ 解绑')
  eq(parseBindCommand('/解绑 100000001'), { hit: true, kind: 'unbind', target: '100000001' }, '★ 解绑也认 QQ 号')
  eq(parseBindCommand('/解绑'), { hit: false }, '★ `/解绑` 后面没东西 ⇒ 不命中（不猜解谁的）')
}

console.log('\n=== ② 取码：6 位数字、一次性、TTL 5 分钟、同一个 QQ 只留一张 ===')
{
  const ws = mkWs()
  const t0 = 1_700_000_000_000
  const r1 = issueCode({ workspace: ws, qqId: QQ_A, chatKey: `group:700000001`, now: t0, code: '111111' })
  ok(r1.ok, '取码成功')
  eq(r1.code, '111111', '码就是给的那个（测试注入）')
  eq(r1.until - t0, CODE_TTL_MS, '★★ TTL = 5 分钟（设计文档 §13.1 拍板）')
  ok(CODE_TTL_MS <= 5 * 60 * 1000, '★★ 且不长于 5 分钟（码是发在群里的）', `${CODE_TTL_MS}ms`)

  const r2 = issueCode({ workspace: ws, qqId: QQ_A, chatKey: `group:700000001`, now: t0 + 1000, code: '222222' })
  eq(r2.code, '222222', '同一个 QQ 再取一次 ⇒ 覆盖')
  const { store } = readStore(ws)
  eq(Object.keys(store.codes).length, 1, '★★ 同一个 QQ 只留**一张**有效码（否则"哪张是我的"只能靠猜）')
  eq(store.codes[QQ_A].code, '222222', '留下的是新的那张')

  // 码的形状（不注入时随机生成）
  const gen = newCode()
  ok(/^[0-9]{6}$/.test(gen), '★ 随机生成的码是 6 位数字', gen)
  const set = new Set()
  for (let i = 0; i < 40; i += 1) set.add(newCode())
  ok(set.size >= 30, '★ 40 次生成至少 30 个不同（不是常数 / 不是可预测序列）', `不同 ${set.size} 个`)
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ③ 提交码：成立的是「资格」，不是「映射」；一次性；过期即废 ===')
{
  const ws = mkWs()
  const t0 = 1_700_000_000_000
  issueCode({ workspace: ws, qqId: QQ_A, chatKey: 'group:1', now: t0, code: '654321' })

  const bad = redeemCode({ workspace: ws, qqId: QQ_A, code: '000000', now: t0 + 1000 })
  eq(bad.ok, false, '★ 码不对 ⇒ 失败')
  eq(bad.why, 'unknown', '★★ 失败理由**只有一种**（不泄露"这个码存在过"）')

  const good = redeemCode({ workspace: ws, qqId: QQ_A, code: '654321', now: t0 + 1000 })
  ok(good.ok, '★ 码对 ⇒ 资格生效')
  const pend = pendingQualifications(ws, t0 + 2000)
  eq(pend.length, 1, '★ 有了一份待绑定资格')
  eq(pend[0].qqId, QQ_A, '★ 资格属于**提交的人**')
  ok(pend[0].until - (t0 + 1000) === QUALIFY_TTL_MS, '资格有效期 = 默认值')

  const again = redeemCode({ workspace: ws, qqId: QQ_B, code: '654321', now: t0 + 2000 })
  eq(again.ok, false, '★★★ **一次性**：同一张码不能再被用（哪怕是另一个人）')

  // 过期
  const ws2 = mkWs()
  issueCode({ workspace: ws2, qqId: QQ_A, chatKey: 'group:1', now: t0, code: '999999' })
  const late = redeemCode({ workspace: ws2, qqId: QQ_A, code: '999999', now: t0 + CODE_TTL_MS + 1 })
  eq(late.ok, false, '★★ 过期 ⇒ 不能用')
  const { store: s2 } = readStore(ws2)
  eq(Object.keys(s2.codes).length, 0, '★ 过期的那张**顺手清掉**（不留死记录）')

  // 资格过期后不该出现在待绑定里
  const ws3 = mkWs()
  issueCode({ workspace: ws3, qqId: QQ_A, chatKey: 'group:1', now: t0, code: '121212' })
  redeemCode({ workspace: ws3, qqId: QQ_A, code: '121212', now: t0 })
  eq(pendingQualifications(ws3, t0 + QUALIFY_TTL_MS + 1).length, 0, '★★ 资格也会过期（不会永远等着）')
  rmSync(ws, { recursive: true, force: true })
  rmSync(ws2, { recursive: true, force: true })
  rmSync(ws3, { recursive: true, force: true })
}

console.log('\n=== ④ 绑定成立：两个方向都写、改绑两边都清、并且**留痕不含码** ===')
{
  const ws = mkWs()
  const t0 = 1_700_000_000_000
  const r = bindUuid({ workspace: ws, uuid: UUID_A, name: 'YoCerin', qqId: QQ_A, chatKey: 'group:1', now: t0 })
  ok(r.ok, '绑定成功')
  eq(lookupByUuid(ws, UUID_A)?.qqId, QQ_A, '★ UUID → QQ 方向写上了')
  eq(lookupByQq(ws, QQ_A)?.uuid, UUID_A, '★ QQ → UUID 方向也写上了')
  eq(lookupByName(ws, 'YoCerin')?.uuid, UUID_A, '★ 按游戏名也找得到（跨重启认得出老玩家）')
  eq(listBindings(ws).length, 1, '列表里有一条')

  // 改绑：同一个 UUID 换一个 QQ
  const r2 = bindUuid({ workspace: ws, uuid: UUID_A, name: 'YoCerin', qqId: QQ_B, chatKey: 'group:1', now: t0 + 1000 })
  ok(r2.ok, '改绑成功')
  eq(r2.replaced?.qqId, QQ_A, '★★ 如实回报"覆盖了原来那个 QQ"')
  eq(lookupByQq(ws, QQ_A), null, '★★★ 旧 QQ 那条**被清掉**（同一 UUID 只能绑一个 QQ）')
  eq(lookupByQq(ws, QQ_B)?.uuid, UUID_A, '新 QQ 那条在')

  // 改绑：同一个 QQ 换一个 UUID
  const r3 = bindUuid({ workspace: ws, uuid: UUID_B, name: 'Steve', qqId: QQ_B, chatKey: 'group:1', now: t0 + 2000 })
  ok(r3.ok, '再改绑成功')
  eq(r3.stolenFrom?.uuid, UUID_A, '★★ 如实回报"这个 QQ 原来绑的是哪个 UUID"')
  eq(lookupByUuid(ws, UUID_A), null, '★★★ 旧 UUID 那条**被清掉**（同一 QQ 只能绑一个 UUID）')
  eq(listBindings(ws).length, 1, '★ 表里仍然只有一条（没有留下幽灵）')

  // 留痕
  const audits = readAudit(ws, 0)
  ok(audits.length >= 3, '★ 每次绑定/改绑都留了一行', `${audits.length} 行`)
  ok(
    audits.every((a) => String(a.uuid8 ?? '').length <= 8),
    '★★ 留痕里 UUID 只有**前 8 位**（够核对，又不是一份可直接用的对照表）',
  )
  ok(audits.some((a) => a.action === 'rebound-away'), '★★ 被顶替的那条也有**独立一行**（"他什么时候被顶替的"要查得到）')
  const rawAudit = readFileSync(join(ws, BIND_AUDIT_REL), 'utf8')
  // ★★★ 码绝不进审计（同 memory-audit 的纪律：审计不含秘密）
  const codeUsed = '654321'
  ok(!rawAudit.includes(codeUsed), '★★★ 审计里**没有**绑定码（哪怕它被用过）')
  ok(shortUuid(UUID_A) === 'bbf13b2f', '★ shortUuid 取前 8 位', shortUuid(UUID_A))
  ok(!rawAudit.includes(UUID_A) || rawAudit.includes('bbf13b2f'), '★★ 审计里没有完整 UUID')

  // 解绑
  const u = unbind({ workspace: ws, uuid: UUID_B, by: 'admin:1', now: t0 + 3000 })
  ok(u.ok, '解绑成功')
  eq(lookupByUuid(ws, UUID_B), null, '★ UUID 方向清掉')
  eq(lookupByQq(ws, QQ_B), null, '★ QQ 方向也清掉')
  eq(unbind({ workspace: ws, uuid: UUID_B }).ok, false, '★ 再解绑一次 ⇒ 如实说"没有这条"')
  const u2 = unbindByName({ workspace: ws, name: 'nobody' })
  eq(u2.ok, false, '★ 按不存在的名字解绑 ⇒ 失败但永不抛')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑤ 坏表 / 缺参数 ⇒ 不猜、永不抛（半截表比没有表危险）===')
{
  const ws = mkWs()
  writeFileSync(join(ws, BINDINGS_REL), '{坏 json', 'utf8')
  const r = readStore(ws)
  eq(r.broken, true, '★ 坏表能被**看出来**（不是静默当空）')
  eq(lookupByUuid(ws, UUID_A), null, '★ 读坏表 ⇒ null（不抛）')
  eq(pendingQualifications(ws).length, 0, '★ 坏表 ⇒ 没有资格（不猜）')
  eq(bindUuid({ workspace: ws, uuid: '', qqId: QQ_A }).ok, false, '★ 没 UUID ⇒ 拒绝')
  eq(bindUuid({ workspace: ws, uuid: UUID_A, qqId: '' }).ok, false, '★ 没 QQ ⇒ 拒绝')
  eq(issueCode({ workspace: ws, qqId: '' }).ok, false, '★ 没发起人 ⇒ 拒绝取码')
  eq(redeemCode({ workspace: ws, qqId: QQ_A, code: 'abc' }).ok, false, '★ 码形状不对 ⇒ 拒绝')
  eq(writeStore('', {}).ok, false, '★ 没有 workspace ⇒ 写失败但不抛')
  eq(lookupByUuid('', UUID_A), null, '★ 没有 workspace ⇒ null')
  // 部分坏：某一节不是对象时，其它节仍要能用（"一处坏 = 全部失联"是最坏的形状）
  writeFileSync(join(ws, BINDINGS_REL), JSON.stringify({ byUuid: 'xxx', byQq: { [QQ_A]: { uuid: UUID_A } } }), 'utf8')
  eq(lookupByQq(ws, QQ_A)?.uuid, UUID_A, '★★ 只有一段坏时，**其它段照常可用**')
  resetForTest(ws)
  ok(!existsSync(join(ws, BINDINGS_REL)), '★ resetForTest 清掉了表')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑥ `tellraw` 的选择器注入：名字不合法**拒绝发送** ===')
{
  eq(PLAYER_NAME_RE.test('YoCerin'), true, '★ 正常玩家名通过')
  eq(PLAYER_NAME_RE.test('小明'), false, '★ 中文名不通过（Minecraft 账号名只允许 [A-Za-z0-9_]）')
  eq(PLAYER_NAME_RE.test('@a'), false, '★★★ `@a` 被拒 —— 否则"只给本人"变成**全服广播**')
  eq(PLAYER_NAME_RE.test('@e[tag=x]'), false, '★★★ 选择器语法被拒')
  eq(PLAYER_NAME_RE.test('a b'), false, '★ 带空格被拒（那是两个 token）')
  eq(PLAYER_NAME_RE.test('a'.repeat(17)), false, '★ 超过 16 字符被拒')
  eq(PLAYER_NAME_RE.test(''), false, '★ 空名被拒')

  const r = buildTellraw({ player: '@a', text: '你好' })
  eq(r.ok, false, '★★★ 不合法 ⇒ 整条**拒绝构造**（不是"尽力拼一个"）')
  ok(/不合法/.test(r.why), '拒绝理由说清是名字不合法')

  const good = buildTellraw({ player: 'YoCerin', text: '绑好了' })
  eq(good.ok, true, '★ 合法名 ⇒ 构造成功')
  eq(good.command, 'tellraw YoCerin {"text":"绑好了"}', '★ 命令形状正确')
  // ★ JSON 由 JSON.stringify 生成：引号与反斜杠必须被转义（自己拼引号就会破防）
  const tricky = buildTellraw({ player: 'YoCerin', text: '他说"你好"\\ 走了' })
  ok(tricky.ok, '★ 含引号/反斜杠的正文也能构造')
  const payload = tricky.command.slice('tellraw YoCerin '.length)
  let parsed = null
  try {
    parsed = JSON.parse(payload)
  } catch (error) {
    parsed = `解析失败：${error.message}`
  }
  eq(parsed?.text, '他说"你好"\\ 走了', '★★ JSON 转义正确（round-trip 逐字相同）')
  eq(buildTellraw({ player: 'YoCerin', text: '换\n行' }).text, '换 行', '★★ 换行被压成空格（否则会被当成下一条命令）')
  ok(!/[\r\n]/.test(buildTellraw({ player: 'YoCerin', text: 'a\r\nb' }).command), '★ 命令里绝不出现换行')
  eq(buildTellraw({ player: 'YoCerin', text: '   ' }).ok, false, '★ 空正文 ⇒ 拒绝（不发一条空 tellraw）')
  eq(buildTellraw({ player: 'YoCerin', text: 'x', color: 'yellow' }).command, 'tellraw YoCerin {"text":"x","color":"yellow"}', '★ 颜色走白名单')
  eq(buildTellraw({ player: 'YoCerin', text: 'x', color: '@a' }).command, 'tellraw YoCerin {"text":"x"}', '★★ 颜色不是字母 ⇒ **丢掉它**（绝不放进去）')

  eq(buildSay({ text: '你好' }).command, 'say 你好', '★ say 形状正确')
  eq(buildSay({ text: '  ' }).ok, false, '★ 空 say ⇒ 拒绝')
  eq(oneLine('a\u0007b'), 'ab', '★ 控制字符被去掉')
  eq(chunkForSay('一'.repeat(SAY_CHUNK_CHARS + 1)).length, 2, `★ 超过 ${SAY_CHUNK_CHARS} 字 ⇒ 切两片`)
  ok(
    chunkForSay('x'.repeat(SAY_CHUNK_CHARS * 2 + 5)).every((c) => c.length <= SAY_CHUNK_CHARS),
    '★ 每一片都不超过上限',
  )
  eq(chunkForSay('   ').length, 0, '★ 空白 ⇒ 零片（不发）')
}

console.log('\n=== ⑦ 游戏内发言该做什么：纯判定（不猜）===')
{
  eq(
    decideGameChat({ name: 'A', uuid: UUID_A, bound: { qqId: QQ_A } }).action,
    'turn',
    '★ 已绑定 ⇒ 交给唤醒判定与模型',
  )
  eq(
    decideGameChat({ name: 'A', uuid: UUID_A, bound: null, pending: [{ qqId: QQ_A }] }).action,
    'bind',
    '★ 未绑定 + **正好一份**资格 ⇒ 当场写死映射',
  )
  eq(
    decideGameChat({ name: 'A', uuid: UUID_A, bound: null, pending: [{ qqId: QQ_A }] }).qqId,
    QQ_A,
    '★ 绑的是那份资格对应的 QQ',
  )
  const ask = decideGameChat({ name: 'A', uuid: UUID_A, bound: null, pending: [{ qqId: QQ_A }, { qqId: QQ_B }] })
  eq(ask.action, 'ask', '★★★ 有 **≥2 份**资格 ⇒ **绝不猜**（猜错 = 把别人的身份算到你头上）')
  ok(/2 个/.test(ask.text), '★ 如实说清有几份')
  eq(decideGameChat({ name: 'A', uuid: null, bound: null, pending: [] }).action, 'remind', '★ 未绑定没资格 ⇒ 提示一次')
  eq(
    decideGameChat({ name: 'A', uuid: null, bound: null, pending: [], reminded: true }).action,
    'ignore',
    '★★ 已经提示过 ⇒ 什么都不做（刷屏的提示等于没有提示）',
  )
  // ★ UUID 还没解析出来时**不能**当"已绑定"（哪怕表里有一条）
  eq(
    decideGameChat({ name: 'A', uuid: null, bound: { qqId: QQ_A }, pending: [] }).action,
    'remind',
    '★★ 拿不到 UUID ⇒ 不算已绑定（宁可提示一次，也不冒名）',
  )
  ok(/\/绑定/.test(decideGameChat({ name: 'A' }).text), '★ 提示里给出了**怎么绑**（不是干巴巴一句"未绑定"）')
}

console.log('\n=== ⑧ appendAudit 自身：缺 workspace 不抛；非数字时间不写成 NaN ===')
{
  eq(appendAudit('', { action: 'bind' }).ok, false, '★ 没有 workspace ⇒ 失败但不抛')
  const ws = mkWs()
  appendAudit(ws, { action: 'bind', at: 'x', uuid: UUID_A, qqId: QQ_A })
  const rows = readAudit(ws, 0)
  ok(Number.isFinite(rows[0].at), '★★ 坏时间被换成数字（绝不写 NaN 进台账）', String(rows[0].at))
  eq(readAudit(join(ws, 'nope'), 0), [], '★ 没有那份文件 ⇒ 空数组，不抛')
  rmSync(ws, { recursive: true, force: true })
}

console.log('')
if (fail === 0) {
  console.log(`🎉 绑定与游戏通道测试：${pass} 项通过`)
  process.exitCode = 0
} else {
  console.log(`❌ 绑定与游戏通道测试：${pass} 项通过、${fail} 项失败`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
}
