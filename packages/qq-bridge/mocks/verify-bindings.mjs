/**
 * **UUID ↔ QQ 绑定**（0.3.2 P3）—— `src/servers/bindings.mjs` / `tellraw.mjs` / `game-chat.mjs`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套守的是什么（全都是"错了不会报错"的那种）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **流程的形状**（2026-10-04 使用者重新定的口径，与第一版**不同**）：
 *      码在**游戏里**生成并与那个 UUID 挂在一起 → 群里提交 → **当场绑定**。
 *      ∴ 断言必须钉住"游戏内那条请求认得出来"、"码与 UUID 绑着"、
 *      "提交即绑定（不再有'资格'那一步、也不再有'下次发言才落实'）"；
 *   ② **一次性 + 5 分钟 TTL** —— 码要经过群聊（§5.6 承认的代价）；
 *   ③ **码绝不进审计**（审计不含秘密，同 `memory-audit.mjs`），UUID 只留前 8 位；
 *   ④ **改绑两边都清 + 各自留痕**（同一 QQ 只能绑一个 UUID、同一 UUID 只能绑一个 QQ）；
 *   ⑤ **消费码与写映射必须是同一次写盘** —— 分两次写会在中间崩掉时留下一张
 *      还能再用的码（⇒ 可能被第二个人提交并改绑）；
 *   ⑥ **`tellraw` 的名字必须严格校验** —— 它是**选择器**：名字里塞进 `@` 会让
 *      "只给本人"变成 `@a` 全服广播；
 *   ⑦ **`/mc bind` 是保留字**：形状不对（`/mc bind abc`）也必须命中，
 *      否则会掉进管理员控制台那条路，把 `bind abc` 当服务端命令发出去。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BIND_AUDIT_REL,
  BINDINGS_REL,
  CODE_TTL_MS,
  appendAudit,
  bindByCode,
  bindUuid,
  codeInfoForUuid,
  countCodes,
  issueCodeFor,
  listBindings,
  lookupByName,
  lookupByQq,
  lookupByUuid,
  newCode,
  parseGameBindRequest,
  parseMcBindCommand,
  readAudit,
  readStore,
  resetForTest,
  shortUuid,
  unbind,
  unbindByName,
  writeStore,
} from '../src/servers/bindings.mjs'
import {
  BOT_NAME,
  CHAT_CHUNK_CHARS,
  botLine,
  buildPublicChat,
  buildTellraw,
  chunkForChat,
  oneLine,
  PLAYER_NAME_RE,
} from '../src/servers/tellraw.mjs'
import { decideGameChat, unboundReminder } from '../src/servers/game-chat.mjs'

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

console.log('\n=== ① 游戏内那句请求（`\\mc bind`）与群里那两条指令的形状 ===')
{
  // ── 游戏内：**反斜杠**（使用者真机实测出来的形状，见 `parseGameBindRequest`）──
  eq(parseGameBindRequest('\\mc bind'), { hit: true }, '★★ `\\mc bind` ⇒ 认得（**实测可用的形状**）')
  eq(parseGameBindRequest('  \\MC   Bind  '), { hit: true }, '★ 大小写与多余空白都能容忍')
  eq(parseGameBindRequest('mc bind'), { hit: true }, '★ 不带前缀也认（**兜底**：玩家忘了打反斜杠不会卡住）')
  eq(parseGameBindRequest('/mc bind'), { hit: true }, '★ 带斜杠也留着（装了服务端插件之后就能用）')
  eq(parseGameBindRequest('//mc bind'), { hit: true }, '★ 两个斜杠同理（实测它在游戏里进不来，但认它零代价）')
  eq(parseGameBindRequest('\\mc bind 123456'), { hit: false }, '★★ 多带了码 ⇒ 不认（那是另一回事）')
  eq(parseGameBindRequest('bind'), { hit: false }, '★★ 光一个 bind 不认（英文聊天里会误伤）')
  eq(parseGameBindRequest('我要 mc bind 一下'), { hit: false }, '★★ 句中提到 ⇒ 不认')
  eq(parseGameBindRequest(''), { hit: false }, '空 ⇒ 不认')
  eq(parseGameBindRequest(null), { hit: false }, 'null ⇒ 不认（永不抛）')

  // ── 群里：`\mc bind ...` / `\mc unbind ...`（斜杠那几个形状也收）──
  eq(parseMcBindCommand('\\mc bind 123456'), { hit: true, kind: 'redeem', code: '123456' }, '★★ 提交码 ⇒ redeem')
  eq(parseMcBindCommand('\\MC BIND 000000'), { hit: true, kind: 'redeem', code: '000000' }, '★ 大小写不敏感（前导零不丢）')
  eq(parseMcBindCommand('/mc bind 123456'), { hit: true, kind: 'redeem', code: '123456' }, '★ 老的单斜杠形状仍然收')
  eq(parseMcBindCommand('//mc bind 123456'), { hit: true, kind: 'redeem', code: '123456' }, '★ 双斜杠也收')
  eq(parseMcBindCommand('\\mc bind'), { hit: true, kind: 'bind-help' }, '★ 没带码 ⇒ 指路（**不在这里发码**）')
  // ★★★ 坏码也必须命中：否则 `\mc bind abc` 会掉进管理员控制台那条路
  eq(parseMcBindCommand('\\mc bind abc'), { hit: true, kind: 'bad-code' }, '★★★ 坏码 ⇒ 命中（不许掉进控制台那条路）')
  eq(parseMcBindCommand('/mc bind 12345'), { hit: true, kind: 'bad-code' }, '★★ 5 位 ⇒ bad-code')
  eq(parseMcBindCommand('\\mc unbind YoCerin'), { hit: true, kind: 'unbind', target: 'YoCerin' }, '★ 解绑（管理员）')
  eq(parseMcBindCommand('\\mc unbind'), { hit: true, kind: 'unbind-help' }, '★ 解绑没给目标 ⇒ 用法')
  eq(parseMcBindCommand('\\mc unbind 100000001'), { hit: true, kind: 'unbind', target: '100000001' }, '★ 解绑也认 QQ 号')
  // ★ 别的 `mc <子命令>`**不属于这条通道**（它们要走管理员控制台那条路）
  eq(parseMcBindCommand('\\mc list'), { hit: false }, '★★ `\\mc list` 不归绑定通道（那是控制台指令）')
  eq(parseMcBindCommand('/mc list'), { hit: false }, '★★ `/mc list` 同理')
  eq(parseMcBindCommand('\\mc'), { hit: false }, '★ 裸 `\\mc` 不归这里')
  // ★★ 完全不带前缀 ⇒ 一律不认（否则普通聊天里聊到 bind 就被吞）
  eq(parseMcBindCommand('mc bind 123456'), { hit: false }, '★★★ 不带前缀的 `mc bind 123456` ⇒ **不认**（避免误伤闲聊）')
  eq(parseMcBindCommand('我要绑定'), { hit: false }, '★★ 句子里含"绑定" ⇒ 不命中')
  eq(parseMcBindCommand(''), { hit: false }, '空 ⇒ 不命中')
}

console.log('\n=== ② 取码：**在游戏里生成**、与那个 UUID 挂在一起、同一个 UUID 只有一张 ===')
{
  const ws = mkWs()
  const t0 = 1_700_000_000_000
  const r1 = issueCodeFor({ workspace: ws, uuid: UUID_A, name: 'YoCerin', serverId: 'forge1', now: t0, code: '111111' })
  ok(r1.ok, '取码成功')
  eq(r1.code, '111111', '码就是给的那个（测试注入）')
  eq(r1.until - t0, CODE_TTL_MS, '★★ TTL = 5 分钟（设计文档 §13.1 拍板）')
  ok(CODE_TTL_MS <= 5 * 60 * 1000, '★★ 且不长于 5 分钟（码要经过群聊）', `${CODE_TTL_MS}ms`)

  // ★★ 关键：码**记着那个 UUID**（这是这一版流程的核心）
  const { store } = readStore(ws)
  eq(store.codes['111111'].uuid, UUID_A, '★★★ 码上挂的是那个 UUID（提交时才能确定映射）')
  eq(store.codes['111111'].name, 'YoCerin', '★ 也记了名字（通知与留痕要用）')
  eq(store.codes['111111'].serverId, 'forge1', '★ 也记了是哪台服（绑定成功要回到那台服通知他）')

  const r2 = issueCodeFor({ workspace: ws, uuid: UUID_A, name: 'YoCerin', serverId: 'forge1', now: t0 + 1000, code: '222222' })
  eq(r2.code, '222222', '同一个玩家再要一次 ⇒ 换新的')
  eq(countCodes(ws, t0 + 2000), 1, '★★ 同一个 UUID **只保留一张**有效码（否则"哪张是我的"只能靠猜）')
  eq(codeInfoForUuid(ws, UUID_A, t0 + 2000)?.code, '222222', '★ 查"他手上那张"拿得到（**只在内部用**）')

  // 不同玩家各自的码互不影响
  issueCodeFor({ workspace: ws, uuid: UUID_B, name: 'Steve', serverId: 'forge1', now: t0 + 3000, code: '333333' })
  eq(countCodes(ws, t0 + 4000), 2, '★ 两个人各自的码都在')

  eq(issueCodeFor({ workspace: ws, uuid: '', name: 'x' }).ok, false, '★ 没有 UUID ⇒ 拒绝取码（发出去也没处挂）')

  const gen = newCode()
  ok(/^[0-9]{6}$/.test(gen), '★ 随机生成的码是 6 位数字', gen)
  const set = new Set()
  for (let i = 0; i < 40; i += 1) set.add(newCode())
  ok(set.size >= 30, '★ 40 次生成至少 30 个不同（不是常数 / 不是可预测序列）', `不同 ${set.size} 个`)
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ③ 提交码：**当场绑定**、一次性、消费与写映射是同一次写盘 ===')
{
  const ws = mkWs()
  const t0 = 1_700_000_000_000
  issueCodeFor({ workspace: ws, uuid: UUID_A, name: 'YoCerin', serverId: 'forge1', now: t0, code: '654321' })

  const bad = bindByCode({ workspace: ws, qqId: QQ_A, code: '000000', now: t0 + 1000 })
  eq(bad.ok, false, '★ 码不对 ⇒ 失败')
  eq(bad.why, 'unknown', '★★ 失败理由**只有一种**（不泄露"这个码存在过"）')
  eq(lookupByUuid(ws, UUID_A), null, '★ 失败时**什么都没写**')

  const good = bindByCode({ workspace: ws, qqId: QQ_A, code: '654321', chatKey: 'group:1', now: t0 + 1000 })
  ok(good.ok, '★★ 码对 ⇒ 当场绑定（不再有"资格"那一步）')
  eq(good.uuid, UUID_A, '★ 回带 UUID（通知与留痕要用）')
  eq(good.name, 'YoCerin', '★ 回带游戏名')
  eq(good.serverId, 'forge1', '★★ 回带"哪台服"（绑定成功要回到那台服给他 tellraw）')
  eq(lookupByUuid(ws, UUID_A)?.qqId, QQ_A, '★★★ 映射**当场**就写死了')
  eq(countCodes(ws, t0 + 2000), 0, '★★ 码被**消费掉**了（同一次写盘 —— 分两次会留下一个危险的窗口）')

  const again = bindByCode({ workspace: ws, qqId: QQ_B, code: '654321', now: t0 + 2000 })
  eq(again.ok, false, '★★★ **一次性**：同一张码不能再被用（哪怕是另一个人）')
  eq(lookupByQq(ws, QQ_B), null, '★ 第二个人什么都没拿到')

  // 过期
  const ws2 = mkWs()
  issueCodeFor({ workspace: ws2, uuid: UUID_A, name: 'YoCerin', serverId: 'forge1', now: t0, code: '999999' })
  const late = bindByCode({ workspace: ws2, qqId: QQ_A, code: '999999', now: t0 + CODE_TTL_MS + 1 })
  eq(late.ok, false, '★★ 过期 ⇒ 不能用')
  const { store: s2 } = readStore(ws2)
  eq(Object.keys(s2.codes).length, 0, '★ 过期的那张**顺手清掉**（不留死记录）')
  eq(countCodes(ws2, t0 + CODE_TTL_MS + 1), 0, '★ 计数也如实（不留"还有一张"的假象）')

  eq(bindByCode({ workspace: ws, qqId: '', code: '654321' }).ok, false, '★ 没有发送者 ⇒ 拒绝')
  eq(bindByCode({ workspace: ws, qqId: QQ_A, code: 'abc' }).ok, false, '★ 码形状不对 ⇒ 拒绝')
  rmSync(ws, { recursive: true, force: true })
  rmSync(ws2, { recursive: true, force: true })
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

  const r2 = bindUuid({ workspace: ws, uuid: UUID_A, name: 'YoCerin', qqId: QQ_B, chatKey: 'group:1', now: t0 + 1000 })
  ok(r2.ok, '改绑成功（同一个 UUID 换一个 QQ）')
  eq(r2.replaced?.qqId, QQ_A, '★★ 如实回报"覆盖了原来那个 QQ"')
  eq(lookupByQq(ws, QQ_A), null, '★★★ 旧 QQ 那条**被清掉**（同一 UUID 只能绑一个 QQ）')
  eq(lookupByQq(ws, QQ_B)?.uuid, UUID_A, '新 QQ 那条在')

  const r3 = bindUuid({ workspace: ws, uuid: UUID_B, name: 'Steve', qqId: QQ_B, chatKey: 'group:1', now: t0 + 2000 })
  ok(r3.ok, '再改绑成功（同一个 QQ 换一个 UUID）')
  eq(r3.stolenFrom?.uuid, UUID_A, '★★ 如实回报"这个 QQ 原来绑的是哪个 UUID"')
  eq(lookupByUuid(ws, UUID_A), null, '★★★ 旧 UUID 那条**被清掉**（同一 QQ 只能绑一个 UUID）')
  eq(listBindings(ws).length, 1, '★ 表里仍然只有一条（没有留下幽灵）')

  const audits = readAudit(ws, 0)
  ok(audits.length >= 3, '★ 每次绑定/改绑都留了一行', `${audits.length} 行`)
  ok(
    audits.every((a) => String(a.uuid8 ?? '').length <= 8),
    '★★ 留痕里 UUID 只有**前 8 位**（够核对，又不是一份可直接用的对照表）',
  )
  ok(audits.some((a) => a.action === 'rebound-away'), '★★ 被顶替的那条也有**独立一行**（"他什么时候被顶替的"要查得到）')
  const rawAudit = readFileSync(join(ws, BIND_AUDIT_REL), 'utf8')
  ok(!rawAudit.includes('654321'), '★★★ 审计里**没有**绑定码（哪怕它被用过）')
  // ★ 判据写成"由 UUID_A 推出来的前 8 位"，**不写死那个字面量** ——
  //   否则脱敏把夹具里的真机 UUID 换成占位值之后，这条会假红（真的发生过：
  //   换成一个全 0 的占位 UUID 之后 `'bbf13b2f'` 这个期望值就再也对不上了）。
  ok(shortUuid(UUID_A) === UUID_A.slice(0, 8), '★ shortUuid 取前 8 位', shortUuid(UUID_A))
  ok(!rawAudit.includes(UUID_A), '★★ 审计里没有完整 UUID')

  const u = unbind({ workspace: ws, uuid: UUID_B, by: 'admin:1', now: t0 + 3000 })
  ok(u.ok, '解绑成功')
  eq(lookupByUuid(ws, UUID_B), null, '★ UUID 方向清掉')
  eq(lookupByQq(ws, QQ_B), null, '★ QQ 方向也清掉')
  eq(unbind({ workspace: ws, uuid: UUID_B }).ok, false, '★ 再解绑一次 ⇒ 如实说"没有这条"')
  eq(unbindByName({ workspace: ws, name: 'nobody' }).ok, false, '★ 按不存在的名字解绑 ⇒ 失败但永不抛')
  rmSync(ws, { recursive: true, force: true })
}

console.log('\n=== ⑤ 坏表 / 缺参数 ⇒ 不猜、永不抛（半截表比没有表危险）===')
{
  const ws = mkWs()
  writeFileSync(join(ws, BINDINGS_REL), '{坏 json', 'utf8')
  const r = readStore(ws)
  eq(r.broken, true, '★ 坏表能被**看出来**（不是静默当空）')
  eq(lookupByUuid(ws, UUID_A), null, '★ 读坏表 ⇒ null（不抛）')
  eq(countCodes(ws), 0, '★ 坏表 ⇒ 没有码（不猜）')
  eq(bindUuid({ workspace: ws, uuid: '', qqId: QQ_A }).ok, false, '★ 没 UUID ⇒ 拒绝')
  eq(bindUuid({ workspace: ws, uuid: UUID_A, qqId: '' }).ok, false, '★ 没 QQ ⇒ 拒绝')
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
  eq(good.command, 'tellraw YoCerin {"text":"<小鲸鱼> 绑好了"}', '★★ 命令形状正确，且**自动带上 `<小鲸鱼> ` 前缀**')
  const tricky = buildTellraw({ player: 'YoCerin', text: '他说"你好"\\ 走了' })
  ok(tricky.ok, '★ 含引号/反斜杠的正文也能构造')
  const payload = tricky.command.slice('tellraw YoCerin '.length)
  let parsed = null
  try {
    parsed = JSON.parse(payload)
  } catch (error) {
    parsed = `解析失败：${error.message}`
  }
  eq(parsed?.text, '<小鲸鱼> 他说"你好"\\ 走了', '★★ JSON 转义正确（round-trip 逐字相同，前缀也在里面）')
  eq(buildTellraw({ player: 'YoCerin', text: '换\n行' }).text, '<小鲸鱼> 换 行', '★★ 换行被压成空格（否则会被当成下一条命令）')
  ok(!/[\r\n]/.test(buildTellraw({ player: 'YoCerin', text: 'a\r\nb' }).command), '★ 命令里绝不出现换行')
  eq(buildTellraw({ player: 'YoCerin', text: '   ' }).ok, false, '★ 空正文 ⇒ 拒绝（不发一条空 tellraw）')
  eq(buildTellraw({ player: 'YoCerin', text: 'x', color: 'yellow' }).command, 'tellraw YoCerin {"text":"<小鲸鱼> x","color":"yellow"}', '★ 颜色走白名单')
  eq(buildTellraw({ player: 'YoCerin', text: 'x', color: '@a' }).command, 'tellraw YoCerin {"text":"<小鲸鱼> x"}', '★★ 颜色不是字母 ⇒ **丢掉它**（绝不放进去）')
  // ★★ 前缀**幂等**：调用方自己写了前缀也不会变成两个（否则就是 `<小鲸鱼> <小鲸鱼> …`）
  eq(botLine('<小鲸鱼> 已经带前缀了'), '<小鲸鱼> 已经带前缀了', '★★ `botLine` 幂等（不会加两遍前缀）')
  eq(botLine('没带前缀'), '<小鲸鱼> 没带前缀', '★ 没带的才加')

  // ── 公屏那条：`tellraw @a`（**不是 `say`**）—— 使用者要求"像正常玩家、不要高亮" ──
  const pub = buildPublicChat({ text: '你好' })
  eq(pub.ok, true, '★ 公屏发言能构造')
  eq(
    pub.command,
    'tellraw @a {"text":"<小鲸鱼> 你好"}',
    '★★★ 公屏是 `tellraw @a` 且**带 `<小鲸鱼>` 前缀**（`say` 会渲染成 `[Server] …` 且带配色，不像玩家）',
  )
  ok(!/"color"/.test(pub.command), '★★★ **不带颜色** ⇒ 默认白色（使用者要求"不要高亮"）')
  eq(JSON.parse(pub.command.slice('tellraw @a '.length)).text, '<小鲸鱼> 你好', '★ JSON 里就是那一行')
  eq(buildPublicChat({ text: '  ' }).ok, false, '★ 空 ⇒ 拒绝')
  ok(!/[\r\n]/.test(buildPublicChat({ text: 'a\r\nb' }).command), '★ 命令里绝不出现换行')
  ok(!/§/.test(buildPublicChat({ text: '§c红' }).command), '★★★ 正文里的 `§` 被**剥掉**（它是原版格式码：留着模型就能自己上色/变乱码，正好违反"不要高亮"）')
  eq(buildPublicChat({ text: '§c红' }).text, '<小鲸鱼> 红', '★ 剥掉之后剩下的是普通文字（不是变成空）')
  eq(buildTellraw({ player: 'YoCerin', text: '§k乱' }).text, '<小鲸鱼> 乱', '★ 私密那条走同一个 `oneLine`，一样剥掉')

  eq(oneLine('a\u0007b'), 'ab', '★ 控制字符被去掉')
  eq(chunkForChat('一'.repeat(CHAT_CHUNK_CHARS + 1)).length, 2, `★ 超过 ${CHAT_CHUNK_CHARS} 字 ⇒ 切两片`)
  ok(
    chunkForChat('x'.repeat(CHAT_CHUNK_CHARS * 2 + 5)).every((c) => c.length <= CHAT_CHUNK_CHARS),
    '★ 每一片都不超过上限',
  )
  eq(chunkForChat('   ').length, 0, '★ 空白 ⇒ 零片（不发）')
}

console.log('\n=== ⑦ 游戏内发言该做什么 + 进服提醒的措辞（纯判定，不猜）===')
{
  eq(decideGameChat({ uuid: UUID_A, bound: { qqId: QQ_A } }).action, 'turn', '★ 已绑定 ⇒ 交给唤醒判定与模型')
  eq(decideGameChat({ uuid: null, bound: null }).action, 'ignore', '★★★ 未绑定的人说话 ⇒ **什么都不做**')
  ok(
    !('text' in decideGameChat({ uuid: null, bound: null })),
    '★★★ 而且**不带任何要回他的话**（使用者：「不能确定每次玩家都在跟小鲸鱼说话」）',
  )
  // ★ UUID 还没解析出来时**不能**当"已绑定"（哪怕表里有一条）
  eq(
    decideGameChat({ uuid: null, bound: { qqId: QQ_A } }).action,
    'ignore',
    '★★ 拿不到 UUID ⇒ 不算已绑定（宁可沉默，也不冒名）',
  )

  // ── 进服提醒的措辞（它是**唯一**会主动发的那条）────────────────────────
  const r = unboundReminder('YoCerin')
  ok(/YoCerin/.test(r), '★ 点他的名字')
  ok(/\\mc bind/.test(r), '★★ 给的是新流程（游戏里输入 \\mc bind）')
  ok(/反斜杠/.test(r), '★★★ 而且明说"反斜杠"（玩家一定会按习惯打斜杠，而斜杠进不来）')
  ok(/群里/.test(r), '★★ 说清了"码要发到群里"')
  // ★★★ 使用者 2026-10-04 的第二处修正：**群里不用 @ 它**。第一版教程写的是
  //   「@小鲸鱼 /mc bind 码」，而实际接线在 `decideTrigger` **之前**就跑绑定了 ⇒
  //   @ 一直是不必要的。措辞错了会让人以为不 @ 就没反应，故钉死"不出现 @"。
  ok(!/@小鲸鱼/.test(r), '★★★ **不出现 `@小鲸鱼`**（群里直接发就行；教人 @ 会让人以为不 @ 没反应）')
  ok(/不用 ?@ ?我/.test(r), '★★★ 反而要**明说不必 @**（这条通道跑在唤醒判定之前，@ 一直是多余的）')
  ok(!/\/mc/.test(r), '★★ 通篇不出现 `/mc`（正斜杠是错的形状，回退一处就红）')
  ok(!/^你好/.test(r), '★★★ **不再用打招呼开头**（它不是"在回你那句话"，而是进服时的一次性提示）')
  ok(/还没绑定/.test(r), '★ 说清现状：还没绑定')
  ok(!/UUID|绑定表|runtime/.test(r), '★ 不写任何内部术语')
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
