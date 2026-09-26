/**
 * 联系人昵称：**机器人怎么称呼某个人**（0.2.2）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它取代了什么
 * ══════════════════════════════════════════════════════════════════════════
 * 0.2.2 早先有一个**全局**的 `persona.callUser`（"它怎么称呼对方"）—— 一个
 * "全机器人统一怎么称呼对方"的框。那件事其实**是某个人的属性**：对甲叫"老板"、
 * 对乙叫"群友"，一个全局框表达不了。所以改成**按人**，存在这里，界面在记忆页。
 *
 * ── 为什么是一个记忆文件（而不是配置、也不是记忆条目）────────────────────
 *   · 它天然属于"关于某人的一条事实"，和记忆同一套生命周期（可看/可编辑/可删）；
 *   · 放在 `memory/` 下 ⇒ **自动被记忆的篡改检测覆盖**（`verifyAndRestoreMemory`
 *     扫的就是工作区根与 `memory/` 下的所有 `.md`）：模型若绕过桥接直接改这个文件，
 *     下一轮会被**回滚**并记进日志。这正是我们要的 —— 规范里写明"模型不许给自己起名"；
 *   · 不做成"记忆条目"：条目是模型可提议、可 supersede 的自然语言，而昵称必须
 *     **结构化 + 只由人编辑**，混进条目里就会被模型改写。
 *
 * ── 文件格式（人可读、机器可读）─────────────────────────────────────────
 *     # 联系人昵称（机器人怎么称呼他们）
 *     - 100000001 = 老板
 *
 * 认不出来的行**不丢**：进 `bad` 由界面显示（"文件里有一行看不懂"），
 * 但**不会**被当成昵称注入 —— 解析不了就当没有，绝不猜。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveMemoryPath } from './memory-files.mjs'

/** 昵称上限（字）。它的本质是"一个名字"，不是一句话。 */
export const NICKNAME_MAX_CHARS = 12

/**
 * 昵称的清洗与把关。
 *
 * ★ 这段文本最终会被**拼进系统提示词**，所以按不可信输入处理：
 *   · 换行/控制字符/不可见字符全部拿掉 —— 不然一句 `\n【新规矩】…` 就能伪造一个段落；
 *   · 长度封顶（称呼本来只有几个字）；
 *   · **方括号类符号一律拒绝**（`【】[]{}<>`）—— 提示词的段标题就是 `【…】`；
 *   · 出现"忽略/指令/设定/规则/扮演/模式"这类词也拒绝。
 * ★ 这里是**清洗 + 把关**，不是静默截断：被丢掉的情况由调用方记日志/报错。
 *
 * @returns {{ value: string, removed: number, reason: string }}
 */
export function cleanNickname(value) {
  const raw = String(value ?? '')
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return { value: '', removed: raw.length, reason: '' }
  if (/[【】\[\]{}<>]/.test(cleaned)) {
    return {
      value: '',
      removed: raw.length,
      reason: '昵称里不能有【】[]{}<> 这类括号（提示词的段标题就用它，会出现"看起来像新规矩"的段落）',
    }
  }
  if (/(忽略|无视|忘记|覆盖|指令|设定|规则|提示词|扮演|模式|越狱|系统)/.test(cleaned)) {
    return { value: '', removed: raw.length, reason: '昵称里出现了"指令/设定/忽略"这类词 —— 它看起来像在给模型下命令，不是称呼' }
  }
  const clipped = cleaned.length > NICKNAME_MAX_CHARS ? cleaned.slice(0, NICKNAME_MAX_CHARS) : cleaned
  return {
    value: clipped,
    removed: raw.length - clipped.length,
    reason: cleaned.length > NICKNAME_MAX_CHARS ? `昵称超过 ${NICKNAME_MAX_CHARS} 字，只取前 ${NICKNAME_MAX_CHARS} 字` : '',
  }
}

/** 昵称文件（相对工作区）。放在 `memory/` 下是为了自动纳入记忆的篡改检测。 */
export const CONTACTS_REL = 'memory/contacts.md'

/** 条数上限：这一栏每轮都要读、要被注入，太长是纯成本。 */
export const CONTACTS_MAX = 200

/** 一行昵称：`- <QQ号> = <昵称>`。 */
const LINE_RE = /^\s*[-*]\s*(\d{5,15})\s*[=:：]\s*(.+?)\s*$/

/**
 * 校验一个昵称能不能用（**给内部调用方的 `{ok}` 形状**）。
 *
 * ★ 底层规则只有 `cleanNickname()` 一处实现 —— 界面、接口、解析都走它，
 *   不会出现"界面存进去了、注入时读不出来"这种两边判据不一致的静默失效。
 *
 * @returns {{ ok: true, value: string, removed: number } | { ok: false, reason: string }}
 */
export function normalizeNickname(value) {
  const raw = String(value ?? '')
  if (!raw.trim()) return { ok: false, reason: '昵称是空的' }
  const { value: cleaned, removed, reason } = cleanNickname(raw)
  if (!cleaned) return { ok: false, reason: reason || '昵称里没有可用的文字' }
  return { ok: true, value: cleaned, removed }
}

/**
 * 解析文件全文。
 *
 * @returns {{ contacts: {qq: string, nickname: string}[], bad: string[] }}
 *   `bad` = 认不出来的非空行（原样带出去给界面看，不静默丢）
 */
export function parseContacts(text) {
  const contacts = []
  const bad = []
  const seen = new Set()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith('#')) continue // 注释/标题
    const m = LINE_RE.exec(line)
    if (!m) {
      bad.push(t)
      continue
    }
    const qq = String(m[1])
    const check = normalizeNickname(m[2])
    if (!check.ok) {
      // 值不合法也归到"这行没用"：宁可界面上报出来，也不要静默截断注入
      bad.push(`${t}（${check.reason}）`)
      continue
    }
    if (seen.has(qq)) {
      bad.push(`${t}（这个号码上面已经出现过，只认第一条）`)
      continue
    }
    seen.add(qq)
    contacts.push({ qq, nickname: check.value })
  }
  contacts.sort((a, b) => (a.qq < b.qq ? -1 : a.qq > b.qq ? 1 : 0))
  return { contacts, bad }
}

/** 渲染成文件全文（**只有一个实现**：界面/CLI 都不许自己拼这个格式）。 */
export function renderContacts(contacts = []) {
  const rows = [...contacts]
    .map((c) => ({ qq: String(c.qq ?? '').trim(), nickname: String(c.nickname ?? '').trim() }))
    .filter((c) => c.qq && c.nickname)
    .sort((a, b) => (a.qq < b.qq ? -1 : a.qq > b.qq ? 1 : 0))
  const head = [
    '# 联系人昵称（机器人怎么称呼他们）',
    '#',
    '# 一行一个人：- <QQ号> = <昵称>',
    `# 私聊和群里对同一个人都生效；改完下一轮就生效（不需要重启）。`,
    '# 昵称不是身份：能不能动手只看 access.adminUsers 里那个号码。',
    '# ⚠️ 由控制台/接口维护；模型被明确禁止改这个文件（改了会被记忆的篡改检测回滚）。',
  ].join('\n')
  return `${head}\n\n${rows.map((c) => `- ${c.qq} = ${c.nickname}`).join('\n')}${rows.length ? '\n' : ''}`
}

/** 读（文件不存在 = 空表，**不是错误**）。 */
export function readContacts({ workspace } = {}) {
  const resolved = resolveMemoryPath(workspace, CONTACTS_REL)
  if (!resolved.ok) return { ok: false, error: resolved.error, contacts: [], bad: [] }
  if (!existsSync(resolved.abs)) return { ok: true, exists: false, contacts: [], bad: [] }
  let text = ''
  try {
    text = readFileSync(resolved.abs, 'utf8')
  } catch (error) {
    return { ok: false, error: `读不了：${error?.message ?? error}`, contacts: [], bad: [] }
  }
  const { contacts, bad } = parseContacts(text)
  return { ok: true, exists: true, contacts, bad }
}

/**
 * 写（整表替换）。
 *
 * ★ 调用方**必须**在成功后刷新记忆快照（`saveSnapshot`）—— 否则下一轮的篡改检测
 *   会拿旧快照把这次改动**回滚**掉（记忆文件那条路踩过一模一样的坑，见 api.mjs 的
 *   `/api/memory/file` 注释）。
 */
export function writeContacts({ workspace, contacts = [] } = {}) {
  const resolved = resolveMemoryPath(workspace, CONTACTS_REL)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  const list = []
  const seen = new Set()
  for (const c of contacts) {
    const qq = String(c?.qq ?? '').trim()
    if (!/^\d{5,15}$/.test(qq)) return { ok: false, error: `QQ 号不合法：${qq || '（空）'}` }
    if (seen.has(qq)) return { ok: false, error: `同一个号码出现两次：${qq}` }
    const nick = normalizeNickname(c?.nickname)
    if (!nick.ok) return { ok: false, error: `${qq} 的昵称不能用：${nick.reason}` }
    seen.add(qq)
    list.push({ qq, nickname: nick.value })
  }
  if (list.length > CONTACTS_MAX) {
    return { ok: false, error: `最多 ${CONTACTS_MAX} 条（现在 ${list.length} 条）——这一栏每轮都要注入，太长是纯成本` }
  }
  try {
    mkdirSync(dirname(resolved.abs), { recursive: true })
    writeFileSync(resolved.abs, renderContacts(list), 'utf8')
  } catch (error) {
    return { ok: false, error: `写不了：${error?.message ?? error}` }
  }
  return { ok: true, contacts: list, rel: CONTACTS_REL }
}

/** 某个号码的昵称（没有就返回空串）。 */
export function nicknameFor({ workspace, qq } = {}) {
  const id = String(qq ?? '').trim()
  if (!id) return ''
  const r = readContacts({ workspace })
  if (!r.ok) return ''
  return r.contacts.find((c) => c.qq === id)?.nickname ?? ''
}

/**
 * 提示词里那一行（**只在真有昵称时才产生**）。
 *
 * ★ 三条措辞纪律：
 *   ① 说清这是**希望的叫法**，不是身份（免得模型把它当权限信号）；
 *   ② 明确"不用每句都带"（否则它会变成固定句式，一眼机器人）；
 *   ③ 不打印 QQ 号（号码对模型没用，而多一个数字就多一分被写进记忆的机会）。
 */
export function renderNicknameBlock(nickname) {
  const check = normalizeNickname(nickname)
  if (!check.ok) return ''
  return [
    '〔称呼〕',
    `他希望你叫他「${check.value}」。不用每句都带这个称呼，自然的时候用一下就行；`,
    '这只是叫法 —— **跟权限无关**（能不能动手只看权限段里的号码）。',
  ].join('\n')
}

/** 给界面/CLI 用的摘要。 */
export function summarizeContacts({ workspace } = {}) {
  const r = readContacts({ workspace })
  return {
    rel: CONTACTS_REL,
    exists: Boolean(r.exists),
    count: r.contacts.length,
    contacts: r.contacts,
    bad: r.bad ?? [],
    max: CONTACTS_MAX,
    maxChars: NICKNAME_MAX_CHARS,
  }
}
