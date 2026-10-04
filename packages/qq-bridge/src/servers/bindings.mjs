/**
 * UUID ↔ QQ 绑定表（0.3.2 P3）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这张表（不是"多存一份数据"，而是"少一处猜"）
 * ══════════════════════════════════════════════════════════════════════════
 * QQ 侧的身份是 QQ 号，游戏侧只有 UUID。没有这张表，一句 `/say 我是小明`
 * **无法归属到人** —— 权限判定与记忆写入都会落空（先例：`roster.decide()` 的
 * fail-closed —— 名单为空 = 谁都不能用）。
 *
 * ── 存在哪、为什么存在这 ────────────────────────────────────────────────
 * 存**桥接侧**（`workspace-qq/runtime/bindings.json`），**不进游戏、不进发布包**：
 *   · 它是 QQ 侧的事实（谁是谁），而桥接是唯一知道 QQ 号的进程；
 *   · 它是**敏感数据**（UUID ↔ QQ 号），所以落在受保护目录 `workspace-qq/` 下
 *     （`check-release-package.mjs` 的 FORBIDDEN 覆盖它，另有一条**指名**断言）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 「码 = 资格」而不是「码 = 归属」（这是本设计里最容易理解错的一件事）
 * ══════════════════════════════════════════════════════════════════════════
 * 群里发 `/绑定 <码>` 成立时，我们**并不知道这个人游戏里是哪个 UUID** ——
 * 我们只知道"这个 QQ 想绑定"。真正把两边连起来的是**下一次游戏内发言**：
 * 一个**未绑定的 UUID** 说话，而 QQ 侧正好有**一份刚绑定过的资格** ⇒ 此时才写死。
 *
 * ∴ **抢到码 ≠ 抢到身份**：抢码的人还必须"那个 UUID 在游戏里说话"才会生效，
 *   而那一步是**对方自己**触发的，受害者在游戏里会**立刻**收到只给他本人的
 *   `tellraw` 确认（`bridge.mjs` 的 `#gameBind`）。**抢绑藏不住**，这是兜底。
 *
 * ⚠️ 仍**不是**密码学意义上的证明：如果攻击者既看见码、又能操作那个 UUID
 * （例如共用账号），这条机制挡不住。**如实记在这里**，不假装它是强认证。
 *
 * ⚠️ 资格是**全局**的（不区分是哪台服务器）：同一个人在两台服上绑同一个 QQ 是
 * 正常需求，而"资格"描述的是"这个 QQ 刚刚证明过自己"这件事。
 *
 * ── 多份资格同时存在时怎么办（计划里没写，这里定死）────────────────────────
 * 若此刻有 **N ≥ 2** 份待绑定资格，我们就**无法知道**说话的那个 UUID 属于谁
 * ⇒ **绝不猜**：不写盘，改为给那个玩家一条 `tellraw`（"现在有多个待确认的绑定"）。
 * 这比"随便挑一个"安全得多（挑错的后果是**把别人的身份算到你头上**）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomInt } from 'node:crypto'

/** 绑定表（工作区相对）。★ 属于使用者数据，永不进包。 */
export const BINDINGS_REL = 'runtime/bindings.json'
/** 绑定变更留痕（工作区相对）。**只记 UUID 前 8 位与 QQ 号，绝不记码**。 */
export const BIND_AUDIT_REL = 'runtime/bindings-audit.jsonl'

/** 绑定码有效期（设计文档 §13.1 拍板：5 分钟）。★ 码是发在群里的，TTL 越短越好。 */
export const CODE_TTL_MS = 5 * 60 * 1000
/** 「资格」有效期：扫码之后到"在游戏里说上话"之间的窗口。 */
export const QUALIFY_TTL_MS = 10 * 60 * 1000

/** 码的形状：6 位数字、大小写无所谓（`/^\d{6}$/`）。 */
export const CODE_RE = /^[0-9]{6}$/
/** 本地指令前缀（**必须带前缀**才命中 —— 误伤概率天然极低）。 */
export const BIND_COMMAND = '/绑定'
export const BIND_ALIAS = '/bind'
export const UNBIND_COMMAND = '/解绑'

/** 审计里只留 UUID 的前几位（够核对，又不构成一份可直接用的对照表）。 */
export function shortUuid(uuid) {
  const s = String(uuid ?? '').replace(/[^0-9a-fA-F]/g, '')
  return s.slice(0, 8) || ''
}

/** 把 `serverId` 之类的东西归一成能进键的样子（与 log-source 同一条纪律）。 */
function key(v) {
  return String(v ?? '').trim()
}

function bindingsPath(workspace) {
  const ws = String(workspace ?? '').trim()
  return ws ? join(ws, BINDINGS_REL) : ''
}

function auditPath(workspace) {
  const ws = String(workspace ?? '').trim()
  return ws ? join(ws, BIND_AUDIT_REL) : ''
}

function emptyStore() {
  return { version: 1, byUuid: {}, byQq: {}, codes: {}, pending: {} }
}

/** 读盘（**永不抛**：读不出来就当空的，并且让调用方能从 `broken` 看出来）。 */
export function readStore(workspace) {
  const p = bindingsPath(workspace)
  if (!p) return { store: emptyStore(), broken: false, why: '缺少 workspace' }
  try {
    if (!existsSync(p)) return { store: emptyStore(), broken: false, why: '' }
    let text = readFileSync(p, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const v = JSON.parse(text)
    if (!v || typeof v !== 'object') return { store: emptyStore(), broken: true, why: '不是对象' }
    // ★ 逐段兜底：坏一段不该让整张表读不出来（"一处坏 = 全部失联"是最坏的形状）
    return {
      store: {
        version: 1,
        byUuid: v.byUuid && typeof v.byUuid === 'object' ? v.byUuid : {},
        byQq: v.byQq && typeof v.byQq === 'object' ? v.byQq : {},
        codes: v.codes && typeof v.codes === 'object' ? v.codes : {},
        pending: v.pending && typeof v.pending === 'object' ? v.pending : {},
      },
      broken: false,
      why: '',
    }
  } catch (error) {
    return { store: emptyStore(), broken: true, why: String(error?.message ?? error) }
  }
}

/**
 * 写盘（**原子**：先写临时文件再改名）。
 *
 * ★ 为什么必须原子：这张表是"谁是管理员"的间接依据（绑定 → QQ → 权限），
 *   写到一半崩掉会留下一个**半截的**表 —— 而那比"没有表"危险（半截表里有
 *   一部分人莫名其妙地失联）。
 * ★ 用 `renameSync` 而不是删了重建：本项目禁 `rmSync` 单个文件（见 AGENT.md）。
 */
export function writeStore(workspace, store) {
  const p = bindingsPath(workspace)
  if (!p) return { ok: false, why: '缺少 workspace' }
  try {
    mkdirSync(dirname(p), { recursive: true })
    const tmp = `${p}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    renameSync(tmp, p)
    return { ok: true }
  } catch (error) {
    return { ok: false, why: String(error?.message ?? error) }
  }
}

/**
 * 记一行**变更留痕**。
 *
 * ★★★ 只记 `uuid8`，**绝不记码**（与 `memory-audit.mjs` 同一条纪律：审计不含秘密）。
 *   码是"资格"，它一旦进了日志就等于把资格公开了 —— 日志比群聊更容易被翻。
 */
export function appendAudit(workspace, row) {
  const p = auditPath(workspace)
  if (!p) return { ok: false, why: '缺少 workspace' }
  try {
    mkdirSync(dirname(p), { recursive: true })
    const safe = {
      at: Number(row?.at) || Date.now(),
      action: String(row?.action ?? ''),
      uuid8: row?.uuid ? shortUuid(row.uuid) : '',
      qqId: String(row?.qqId ?? ''),
      name: String(row?.name ?? ''),
      chatKey: String(row?.chatKey ?? ''),
      by: String(row?.by ?? ''),
      note: row?.note ? String(row.note) : undefined,
    }
    writeFileSync(p, `${JSON.stringify(safe)}\n`, { encoding: 'utf8', flag: 'a' })
    return { ok: true }
  } catch (error) {
    return { ok: false, why: String(error?.message ?? error) }
  }
}

/** 读最近若干条留痕（只读；给巡检与排障用）。 */
export function readAudit(workspace, limit = 20) {
  const p = auditPath(workspace)
  if (!p || !existsSync(p)) return []
  try {
    const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim())
    const rows = []
    for (const line of lines) {
      try {
        const v = JSON.parse(line)
        if (v && typeof v === 'object') rows.push(v)
      } catch {
        /* 坏行跳过 */
      }
    }
    const n = Number(limit)
    return Number.isFinite(n) && n > 0 ? rows.slice(-n) : rows
  } catch {
    return []
  }
}

// ── 本地指令的形状（纯函数，零模型调用）────────────────────────────────────

/**
 * 识别本地绑定指令。
 *
 * 认的形状（**带前缀 + 只认下面这几种**，其余一律 `hit:false` ⇒ 照常走普通聊天）：
 *   `/绑定`            → 取码
 *   `/bind`            → 取码（别名）
 *   `/绑定 123456`     → 提交码
 *   `/解绑 <玩家名或QQ号>` → 管理员解绑
 *
 * ★★★ 为什么"带别的字就不命中"是**刻意的**：命中即 `return`，这一轮**一次模型
 *   调用都不产生**。判得太宽会让普通闲聊被吞掉（变成"机器人不理我"），
 *   而判得太窄只是回到普通聊天 —— 失败方向不对称，所以往窄了判。
 *
 * @returns {{hit:false} | {hit:true, kind:'issue'} | {hit:true, kind:'redeem', code:string}
 *           | {hit:true, kind:'unbind', target:string}}
 */
export function parseBindCommand(text) {
  const raw = String(text ?? '').trim()
  if (!raw.startsWith('/')) return { hit: false }
  // 前缀只认这两种（`/bind` 大小写不敏感；中文没有大小写问题）
  let rest = null
  for (const p of [BIND_COMMAND, BIND_ALIAS]) {
    if (raw.length >= p.length && raw.slice(0, p.length).toLowerCase() === p.toLowerCase()) {
      rest = raw.slice(p.length)
      break
    }
  }
  if (rest === null) {
    // `/解绑 <目标>`
    const u = UNBIND_COMMAND
    if (raw.length > u.length && raw.slice(0, u.length) === u) {
      const target = raw.slice(u.length).trim()
      return target ? { hit: true, kind: 'unbind', target } : { hit: false }
    }
    return { hit: false }
  }
  // 前缀后面必须紧跟"空白或结束" —— `/绑定abc` 不命中（那是别的东西）
  if (rest !== '' && !/^\s/.test(rest)) return { hit: false }
  const arg = rest.trim()
  if (!arg) return { hit: true, kind: 'issue' }
  if (CODE_RE.test(arg)) return { hit: true, kind: 'redeem', code: arg }
  // 带了别的字（`/绑定 你好`、`/绑定 12345`、`/绑定 123456 额外`）⇒ 不命中
  return { hit: false }
}

// ── 取码 / 提交码 ─────────────────────────────────────────────────────────

/** 生成一个 6 位数字码（用 CSPRNG；不用 Math.random —— 那是可预测的）。 */
export function newCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/**
 * 取码（群里发 `/绑定`）。
 *
 * ★ **同一个 QQ 只保留一个有效码**：重复取码就是覆盖旧的（否则码越攒越多，
 *   而"哪一个才是我的"只能靠猜）。
 * ★ 返回的 `code` **只用于回给发起人**，调用方**绝不能把它写进日志**。
 */
export function issueCode({ workspace, qqId = '', chatKey = '', now = Date.now(), ttlMs = CODE_TTL_MS, code = null } = {}) {
  const id = key(qqId)
  if (!id) return { ok: false, why: '没有发起人（senderId）' }
  const { store } = readStore(workspace)
  const value = code && CODE_RE.test(String(code)) ? String(code) : newCode()
  store.codes[id] = { code: value, at: now, until: now + Math.max(1, Number(ttlMs) || CODE_TTL_MS), chatKey: String(chatKey ?? '') }
  const w = writeStore(workspace, store)
  if (!w.ok) return { ok: false, why: w.why }
  return { ok: true, code: value, until: store.codes[id].until }
}

/**
 * 提交码（群里发 `/绑定 <码>`）。
 *
 * ★ 成立时写入的是**一份资格**（`pending[qqId]`），**不是**一条 UUID 映射 ——
 *   原因见文件头「码 = 资格」。
 * ★ 一次性：用掉就删（成功与失败都删？**不** —— 只有成功才删；失败若是"码不对"
 *   就什么都不动，若是"码过期"则顺手清掉那条死记录）。
 */
export function redeemCode({ workspace, qqId = '', code = '', chatKey = '', now = Date.now(), qualifyMs = QUALIFY_TTL_MS } = {}) {
  const id = key(qqId)
  const c = String(code ?? '').trim()
  if (!id) return { ok: false, why: 'no-sender' }
  if (!CODE_RE.test(c)) return { ok: false, why: 'bad-shape' }
  const { store } = readStore(workspace)
  // 先清过期（否则"过期"与"存在但过期"会分叉成两种行为）
  const before = (Object.keys(store.codes ?? {}).length << 16) + Object.keys(store.pending ?? {}).length
  pruneExpired(store, now)
  const after = (Object.keys(store.codes ?? {}).length << 16) + Object.keys(store.pending ?? {}).length
  // ★ 清掉了东西就**写回**：不写回的话过期记录会永远躺在盘上（读的时候虽然不认它，
  //   但"文件里有一堆早就没用的码"本身是另一种脏 —— 而它们正是"能用吗"的误判来源）。
  if (after !== before) writeStore(workspace, store)
  // ★ 失败理由**只有一种**（`unknown`）：码不存在 / 已过期 / 已被用过，对使用者
  //   是**同一件事**（"这个码现在不能用"）。分成三种话术只会泄露"这个码存在过"
  //   —— 而那是给抢码的人送情报。
  const hit = Object.entries(store.codes).find(([, v]) => v && String(v.code) === c)
  if (!hit) return { ok: false, why: 'unknown' }
  const [ownerId] = hit
  // ★ 一次性：无论谁提交，这条码立刻作废（防止两个人先后用同一个码）
  delete store.codes[ownerId]
  store.pending[id] = { at: now, until: now + Math.max(1, Number(qualifyMs) || QUALIFY_TTL_MS), chatKey: String(chatKey ?? ''), codeOwner: ownerId }
  const w = writeStore(workspace, store)
  if (!w.ok) return { ok: false, why: `write-failed:${w.why}` }
  appendAudit(workspace, { at: now, action: 'qualify', qqId: id, chatKey, by: 'group-command' })
  return { ok: true, until: store.pending[id].until }
}

/** 清掉过期的码与资格（就地改 `store`）。 */
export function pruneExpired(store, now = Date.now()) {
  if (!store) return store
  for (const [k, v] of Object.entries(store.codes ?? {})) {
    if (!v || !Number.isFinite(Number(v.until)) || Number(v.until) <= now) delete store.codes[k]
  }
  for (const [k, v] of Object.entries(store.pending ?? {})) {
    if (!v || !Number.isFinite(Number(v.until)) || Number(v.until) <= now) delete store.pending[k]
  }
  return store
}

/** 只读：当前有效的待绑定资格（已清过期）。 */
export function pendingQualifications(workspace, now = Date.now()) {
  const { store } = readStore(workspace)
  pruneExpired(store, now)
  return Object.entries(store.pending ?? {})
    .map(([qqId, v]) => ({ qqId, at: Number(v?.at) || 0, until: Number(v?.until) || 0, chatKey: String(v?.chatKey ?? '') }))
    .sort((a, b) => a.at - b.at)
}

/** 只读：某个 UUID 绑到了谁。 */
export function lookupByUuid(workspace, uuid) {
  const u = key(uuid).toLowerCase()
  if (!u) return null
  const { store } = readStore(workspace)
  const row = store.byUuid[u]
  return row ? { uuid: u, qqId: String(row.qqId ?? ''), name: String(row.name ?? ''), at: Number(row.at) || 0 } : null
}

/** 只读：某个 QQ 绑到了哪个 UUID。 */
export function lookupByQq(workspace, qqId) {
  const id = key(qqId)
  if (!id) return null
  const { store } = readStore(workspace)
  const row = store.byQq[id]
  return row ? { qqId: id, uuid: String(row.uuid ?? ''), name: String(row.name ?? ''), at: Number(row.at) || 0 } : null
}

/** 只读：按游戏名找 UUID（表里记着名字，免去"必须先登录一次"）。 */
export function lookupByName(workspace, name) {
  const n = key(name)
  if (!n) return null
  const { store } = readStore(workspace)
  for (const [uuid, row] of Object.entries(store.byUuid ?? {})) {
    if (row && String(row.name) === n) {
      return { uuid, qqId: String(row.qqId ?? ''), name: n, at: Number(row.at) || 0 }
    }
  }
  return null
}

/** 全部绑定（只读；给巡检与界面用）。 */
export function listBindings(workspace) {
  const { store } = readStore(workspace)
  return Object.entries(store.byUuid ?? {}).map(([uuid, row]) => ({
    uuid,
    uuid8: shortUuid(uuid),
    qqId: String(row?.qqId ?? ''),
    name: String(row?.name ?? ''),
    at: Number(row?.at) || 0,
  }))
}

// ── 写死映射（把 UUID 与 QQ 真的连起来的那一步）────────────────────────────

/**
 * 建立 UUID ↔ QQ 的映射（改绑即覆盖，**旧关系留痕**）。
 *
 * ★★★ 三条不变量（都是"错了不会报错"的那种，所以必须写死在函数里）：
 *   ① **同一 UUID 只能绑一个 QQ**、**同一 QQ 只能绑一个 UUID** ⇒ 两边的旧记录
 *      都要**显式清掉并留痕**（不是删掉就完事 —— "他什么时候被顶替的"事后
 *      要查得到，见设计文档 §5.5）；
 *   ② 写盘用**原子写**（半截表比没有表危险）；
 *   ③ 留痕**不含码**、UUID 只留前 8 位。
 *
 * @returns {{ok:boolean, why?:string, replaced?:object|null, stolenFrom?:object|null}}
 */
export function bindUuid({
  workspace,
  uuid = '',
  name = '',
  qqId = '',
  chatKey = '',
  by = 'game-speech',
  now = Date.now(),
  consumeQualification = true,
} = {}) {
  const u = key(uuid).toLowerCase()
  const id = key(qqId)
  if (!u) return { ok: false, why: 'no-uuid' }
  if (!id) return { ok: false, why: 'no-qq' }
  const { store } = readStore(workspace)
  pruneExpired(store, now)
  if (consumeQualification) delete store.pending[id]

  // 旧的"这个 UUID 属于谁"
  const prevForUuid = store.byUuid[u] ? { ...store.byUuid[u] } : null
  // 旧的"这个 QQ 绑的是哪个 UUID"
  const prevForQq = store.byQq[id] ? { ...store.byQq[id] } : null
  let replaced = null
  let stolenFrom = null

  if (prevForUuid && String(prevForUuid.qqId ?? '') !== id) {
    replaced = { uuid: u, qqId: String(prevForUuid.qqId ?? ''), name: String(prevForUuid.name ?? '') }
    delete store.byQq[replaced.qqId]
    appendAudit(workspace, { at: now, action: 'rebound-away', uuid: u, qqId: replaced.qqId, name: replaced.name, chatKey, by, note: '这个 UUID 改绑到别的 QQ' })
  }
  if (prevForQq && String(prevForQq.uuid ?? '') !== u) {
    stolenFrom = { uuid: String(prevForQq.uuid ?? ''), name: String(prevForQq.name ?? ''), qqId: id }
    delete store.byUuid[stolenFrom.uuid]
    appendAudit(workspace, { at: now, action: 'rebound-away', uuid: stolenFrom.uuid, qqId: id, name: stolenFrom.name, chatKey, by, note: '这个 QQ 改绑到别的 UUID' })
  }

  store.byUuid[u] = { qqId: id, name: String(name ?? ''), at: now, via: String(by ?? '') }
  store.byQq[id] = { uuid: u, name: String(name ?? ''), at: now, via: String(by ?? '') }
  const w = writeStore(workspace, store)
  if (!w.ok) return { ok: false, why: w.why }
  appendAudit(workspace, {
    at: now,
    action: prevForUuid || prevForQq ? 'rebind' : 'bind',
    uuid: u,
    qqId: id,
    name,
    chatKey,
    by,
  })
  return { ok: true, replaced, stolenFrom }
}

/** 管理员解绑（按 UUID 或按 QQ 号；**两边都清并留痕**）。 */
export function unbind({ workspace, uuid = '', qqId = '', by = '', now = Date.now() } = {}) {
  const u = key(uuid).toLowerCase()
  let id = key(qqId)
  const { store } = readStore(workspace)
  if (!u && !id) return { ok: false, why: 'no-target' }
  if (!u && id) {
    const row = store.byQq[id]
    if (!row) return { ok: false, why: 'not-found' }
    return unbind({ workspace, uuid: String(row.uuid ?? ''), by, now })
  }
  const row = store.byUuid[u]
  if (!row) return { ok: false, why: 'not-found' }
  if (!id) id = String(row.qqId ?? '')
  delete store.byUuid[u]
  if (store.byQq[id] && String(store.byQq[id].uuid ?? '') === u) delete store.byQq[id]
  const w = writeStore(workspace, store)
  if (!w.ok) return { ok: false, why: w.why }
  appendAudit(workspace, { at: now, action: 'unbind', uuid: u, qqId: id, name: String(row.name ?? ''), by })
  return { ok: true, uuid: u, qqId: id, name: String(row.name ?? '') }
}

/** 管理员解绑（按游戏名）。 */
export function unbindByName({ workspace, name = '', by = '', now = Date.now() } = {}) {
  const n = key(name)
  if (!n) return { ok: false, why: 'no-target' }
  const { store } = readStore(workspace)
  // 名字可能重（改名卡），所以先看 QQ 号，再看名字
  if (store.byQq[n]) return unbind({ workspace, qqId: n, by, now })
  for (const [uuid, row] of Object.entries(store.byUuid ?? {})) {
    if (row && String(row.name) === n) return unbind({ workspace, uuid, by, now })
  }
  return { ok: false, why: 'not-found' }
}

// ── 给测试与巡检留一个"清干净"的入口 ──────────────────────────────────────

/** 删掉绑定表与留痕（**只在测试里用**；`unlinkSync` 而不是 `rmSync`）。 */
export function resetForTest(workspace) {
  for (const p of [bindingsPath(workspace), auditPath(workspace)]) {
    if (!p) continue
    try {
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* 无所谓 */
    }
  }
}
