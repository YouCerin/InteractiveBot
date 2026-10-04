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
 * ★★★ 绑定流程（2026-10-04 使用者重新定的口径 —— 与第一版**不同**）
 * ══════════════════════════════════════════════════════════════════════════
 * ```
 * 玩家进服（未绑定）        → 只给他本人一条 tellraw：怎么拿码
 * 玩家在**游戏里**说 mc bind → 生成一张 6 位码，**与那个 UUID 挂在一起**
 *                              → 只给他本人 tellraw：码 + 下一步
 * 玩家在**群里**发 @小鲸鱼 /mc bind <码>
 *                          → 桥接本地拦截（一次模型调用都没有）→ **当场绑定**
 *                          → 群里回一句 + **在游戏里给那个玩家一条成功通知**
 * ```
 *
 * ★★ 与第一版的关键差别（为什么这一版更好，记下来免得改回去）：
 *   第一版是"群里 `/绑定` 取码 → 群里提交 → **下一次游戏内发言**才写死映射"
 *   （设计文档 §5.2 的"码 = 资格"）。那一版的问题是**归属只能靠猜**：
 *   码头在 QQ 侧，谁能提交谁就拿到资格，而"那个 UUID 是谁"要等到下一次发言才知道，
 *   于是**同时有两份资格时根本无法判断**（第一版只能 fail-closed 地拒绝）。
 *   这一版让**码在游戏里生成、且与那个 UUID 挂在一起** ⇒ 提交上去就是确定的映射，
 *   没有"资格"这一步、没有歧义、也没有"哪一份资格是我的"这种问题。
 *
 * ⚠️ **仍然存在的风险（如实写，不粉饰）**：码是要经过群聊的（玩家自己粘进去），
 *   所以**同群的人有机会抢先提交** —— 提交成功就绑到了抢码者自己的 QQ 上。
 *   缓解是三样，都在这一版里：**一次性** + **5 分钟 TTL** +
 *   **绑定成立时立刻给那个 UUID 本人一条 `tellraw`** ⇒ **抢绑藏不住**
 *   （受害者会在游戏里当场看到"绑定成功"，而那不是他做的）。
 *   想真正堵死要加第二因子（需要服务端插件），按裁决留作可选硬化项，**不进 v1**。
 *
 * ⚠️ 也**不是**密码学意义的证明：如果攻击者既看见码、又能操作那个 UUID
 *   （例如共用账号），这条机制挡不住。不假装它是强认证。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomInt } from 'node:crypto'

/** 绑定表（工作区相对）。★ 属于使用者数据，永不进包。 */
export const BINDINGS_REL = 'runtime/bindings.json'
/** 绑定变更留痕（工作区相对）。**只记 UUID 前 8 位与 QQ 号，绝不记码**。 */
export const BIND_AUDIT_REL = 'runtime/bindings-audit.jsonl'

/** 绑定码有效期（设计文档 §13.1 拍板：5 分钟）。★ 码要经过群聊，TTL 越短越好。 */
export const CODE_TTL_MS = 5 * 60 * 1000

/** 码的形状：6 位数字（`/^\d{6}$/`）。 */
export const CODE_RE = /^[0-9]{6}$/

/** 群里的两条指令（**必须带 `/mc` 前缀**才命中 —— 误伤概率天然极低）。 */
export const MC_BIND_COMMAND = '/mc bind'
export const MC_UNBIND_COMMAND = '/mc unbind'

/** 游戏内那句请求（**没有斜杠** —— 见文件头与 `parseGameBindRequest` 的注释）。 */
export const GAME_BIND_WORDS = 'mc bind'

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
  return { version: 1, byUuid: {}, byQq: {}, codes: {} }
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

// ── 两条指令的形状（纯函数，零模型调用）────────────────────────────────────

/**
 * 识别**群里**那两条 `/mc` 指令。
 *
 * 认的形状：
 *   `/mc bind`                → `help`（还没码 ⇒ 告诉他先去游戏里拿）
 *   `/mc bind 123456`         → `redeem`（提交码）
 *   `/mc bind abc` / `12345`  → `bad-code`（**必须命中**：否则会掉进管理员控制台那条路，
 *                                把 `bind abc` 当成一条服务端命令发出去）
 *   `/mc unbind <玩家名或QQ号>` → `unbind`（**只有管理员**，权限在桥接那边判）
 *
 * ★★★ 为什么"带别的东西也要命中、不能落回普通聊天"：`/mc` 前缀下面还有一条
 *   **管理员控制台**通道。`/mc bind xyz` 若不在这里被拦下，管理员发它就会真的
 *   往服务端发一条 `bind xyz` 命令 —— 那不是我们想表达的语义。所以
 *   `bind` / `unbind` 这两个词在 `/mc` 下是**保留字**。
 *
 * @returns {{hit:false} | {hit:true, kind:'help'|'bad-code'|'bind-help'|'unbind-help'}
 *           | {hit:true, kind:'redeem', code:string} | {hit:true, kind:'unbind', target:string}}
 */
export function parseMcBindCommand(text) {
  const raw = String(text ?? '').trim()
  if (!raw.startsWith('/')) return { hit: false }
  // 只认 `/mc` 开头（大小写不敏感）
  const m = /^\/mc\b\s*(.*)$/i.exec(raw)
  if (!m) return { hit: false }
  const rest = String(m[1] ?? '').trim()
  if (!rest) return { hit: false } // 裸 `/mc` 是"用法提示"那条路，不归这里
  const words = rest.split(/\s+/)
  const sub = String(words[0] ?? '').toLowerCase()
  if (sub === 'unbind' || sub === '解绑') {
    const target = words.slice(1).join(' ').trim()
    return target ? { hit: true, kind: 'unbind', target } : { hit: true, kind: 'unbind-help' }
  }
  if (sub !== 'bind' && sub !== '绑定') return { hit: false }
  const arg = words.slice(1).join(' ').trim()
  if (!arg) return { hit: true, kind: 'bind-help' }
  if (CODE_RE.test(arg)) return { hit: true, kind: 'redeem', code: arg }
  return { hit: true, kind: 'bad-code' }
}

/**
 * 识别**游戏内**那句请求。
 *
 * ★★★ 为什么是 `mc bind`（**没有斜杠**）而不是 `/mc bind`（使用者原话）：
 *   Minecraft 里**以 `/` 开头的输入是"命令"**，会被客户端交给服务端去当命令执行；
 *   而我们的服务端上**没有**注册过叫 `mc` 的命令 ⇒ 服务端只会回玩家一句
 *   "Unknown command"，**而且这一句不会写进控制台日志**。我们的游戏内事件源
 *   读的正是控制台日志（`runtime/servers/<id>.console.log`）⇒ **看不到**。
 *   ∴ 在**不写服务端插件/模组**的前提下，玩家必须把 `mc bind` 当**聊天**发出来。
 *   界面上那句提醒因此要写清"不要加斜杠"，并且说明原因（否则玩家一定会加）。
 * ★ 仍然接受带斜杠的形状：将来若真装了插件、把 `/mc bind` 反馈进控制台，
 *   这一条不用改就能用。
 *
 * @returns {{hit:boolean}}
 */
export function parseGameBindRequest(text) {
  const s = String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
  if (!s) return { hit: false }
  const bare = s.startsWith('/') ? s.slice(1).trim() : s
  return { hit: /^mc\s+bind$/.test(bare) }
}

// ── 取码 / 提交码 ─────────────────────────────────────────────────────────

/** 生成一个 6 位数字码（用 CSPRNG；不用 Math.random —— 那是可预测的）。 */
export function newCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/**
 * 在**游戏内**为某个玩家生成一张绑定码（码与那个 UUID 挂在一起）。
 *
 * ★ **同一个 UUID 只保留一张有效码**：重复请求就是覆盖旧的（否则"哪一张是我的"
 *   只能靠猜，而猜错的后果是把身份算到别人头上）。
 * ★ 返回的 `code` **只用于回给那个玩家本人**，调用方**绝不能把它写进日志**。
 */
export function issueCodeFor({
  workspace,
  uuid = '',
  name = '',
  serverId = '',
  now = Date.now(),
  ttlMs = CODE_TTL_MS,
  code = null,
} = {}) {
  const u = key(uuid).toLowerCase()
  if (!u) return { ok: false, why: '没有 UUID（还不知道这个玩家是谁）' }
  const { store } = readStore(workspace)
  pruneExpired(store, now)
  // 同一个 UUID 的旧码先撤掉（"一个玩家一张码"）
  for (const [c, row] of Object.entries(store.codes ?? {})) {
    if (row && String(row.uuid ?? '').toLowerCase() === u) delete store.codes[c]
  }
  let value = code && CODE_RE.test(String(code)) ? String(code) : newCode()
  // 撞码就重摇（6 位空间很小，但同一时刻的有效码只有个位数 —— 重摇几次足够）
  for (let i = 0; i < 20 && store.codes[value]; i += 1) value = newCode()
  if (store.codes[value]) return { ok: false, why: '取不到空闲的码（有效码太多，等一下再试）' }
  const until = now + Math.max(1, Number(ttlMs) || CODE_TTL_MS)
  store.codes[value] = { uuid: u, name: String(name ?? ''), serverId: String(serverId ?? ''), at: now, until }
  const w = writeStore(workspace, store)
  if (!w.ok) return { ok: false, why: w.why }
  return { ok: true, code: value, until, uuid: u, name: String(name ?? '') }
}

/** 清掉过期的码（就地改 `store`）。 */
export function pruneExpired(store, now = Date.now()) {
  if (!store) return store
  for (const [k, v] of Object.entries(store.codes ?? {})) {
    if (!v || !Number.isFinite(Number(v.until)) || Number(v.until) <= now) delete store.codes[k]
  }
  return store
}

/** 只读：某个 UUID 手上有没有还没用的码（不返回码本身）。 */
export function codeInfoForUuid(workspace, uuid, now = Date.now()) {
  const u = key(uuid).toLowerCase()
  if (!u) return null
  const { store } = readStore(workspace)
  pruneExpired(store, now)
  for (const [c, row] of Object.entries(store.codes ?? {})) {
    if (row && String(row.uuid ?? '').toLowerCase() === u) {
      return { code: c, until: Number(row.until) || 0, name: String(row.name ?? '') }
    }
  }
  return null
}

/** 只读：当前有几张有效码（给巡检用；**不返回码本身**）。 */
export function countCodes(workspace, now = Date.now()) {
  const { store } = readStore(workspace)
  pruneExpired(store, now)
  return Object.keys(store.codes ?? {}).length
}

/**
 * 提交一张码（群里发 `/mc bind <码>`）—— **当场绑定**。
 *
 * ★ 实现上是**一次读写**：查码 → 删码 → 写映射 → 留痕，全在同一份 store 上完成。
 *   分两次写（先绑、再删码）会在中间崩掉时留下一张还能再用的码 ⇒ 可能被第二个人
 *   提交并**改绑**。所以这里把"消费码"作为 `bindUuid` 的一部分。
 *
 * @returns {{ok:boolean, why?:string, uuid?:string, name?:string, serverId?:string,
 *           replaced?:object|null, stolenFrom?:object|null}}
 */
export function bindByCode({ workspace, qqId = '', code = '', chatKey = '', now = Date.now(), by = 'group-command' } = {}) {
  const id = key(qqId)
  const c = String(code ?? '').trim()
  if (!id) return { ok: false, why: 'no-sender' }
  if (!CODE_RE.test(c)) return { ok: false, why: 'bad-shape' }
  const { store } = readStore(workspace)
  // 先清过期（否则"过期"与"存在但过期"会分叉成两种行为）
  const before = Object.keys(store.codes ?? {}).length
  pruneExpired(store, now)
  // ★ 清掉了东西就**写回**：不写回的话过期记录会永远躺在盘上（读的时候虽然不认它，
  //   但"文件里有一堆早就没用的码"本身就是另一种脏 —— 而它们正是"还能用吗"的误判来源）。
  if (Object.keys(store.codes ?? {}).length !== before) writeStore(workspace, store)
  // ★ 失败理由**只有一种**（`unknown`）：不存在 / 已过期 / 已被用过，对使用者是
  //   **同一件事**。分成三种话术只会泄露"这个码存在过" —— 那是给抢码的人送情报。
  const row = store.codes[c]
  if (!row) return { ok: false, why: 'unknown' }
  const r = bindUuid({
    workspace,
    uuid: String(row.uuid ?? ''),
    name: String(row.name ?? ''),
    qqId: id,
    chatKey,
    by,
    now,
    // ★ 同一次写盘里把这个码消费掉（见上面那段：分两次写会留下一个危险的窗口）
    consumeCode: c,
  })
  if (!r.ok) return { ok: false, why: r.why }
  return {
    ok: true,
    uuid: String(row.uuid ?? ''),
    name: String(row.name ?? ''),
    serverId: String(row.serverId ?? ''),
    replaced: r.replaced,
    stolenFrom: r.stolenFrom,
  }
}

// ── 读 ────────────────────────────────────────────────────────────────────

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

// ── 写死映射 ──────────────────────────────────────────────────────────────

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
 * @param {string} [o.consumeCode] 同一次写盘里顺手消费掉的那张码（见 `bindByCode`）
 * @returns {{ok:boolean, why?:string, replaced?:object|null, stolenFrom?:object|null}}
 */
export function bindUuid({
  workspace,
  uuid = '',
  name = '',
  qqId = '',
  chatKey = '',
  by = 'game',
  now = Date.now(),
  consumeCode = '',
} = {}) {
  const u = key(uuid).toLowerCase()
  const id = key(qqId)
  if (!u) return { ok: false, why: 'no-uuid' }
  if (!id) return { ok: false, why: 'no-qq' }
  const { store } = readStore(workspace)
  pruneExpired(store, now)
  if (consumeCode) delete store.codes[String(consumeCode)]

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

/** 管理员解绑（按游戏名或 QQ 号）。 */
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
