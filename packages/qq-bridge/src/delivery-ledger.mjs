/**
 * 投递账本（H15）：**发送前落账，确认后标记**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它解决的那个真实事故
 * ══════════════════════════════════════════════════════════════════════════
 * 实测过一条回复因"静默时段"被延迟 **116 秒**，使用者在它发出去之前重启了桥接 ——
 * 通道当场断开，那条**已经生成好（模型调用已经花过钱）**的回复**永远丢了**，
 * 而且日志里只有一行"发送失败"，没有任何地方能回答"到底丢的是哪一条、给谁的"。
 *
 * 内容去重（`SendQueue` 的 8 秒窗口）解决的是"**同一句话短时间内重复发**"，
 * 与"**崩溃后有没有漏发**"是两件事 —— 后者需要落盘。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 我们做到哪一步、**没做到**哪一步（必须先看清楚）
 * ══════════════════════════════════════════════════════════════════════════
 * 计划里写的是"at-least-once"，但**自动重放会带来重复回复**，而重复回复在这个项目里
 * 被明确判定为**比漏一条更糟**（对方会看到两条口径不同的回复）。更关键的是：
 * 崩溃发生在"发出去之后、标记之前"那一瞬间时，我们**无法区分**这条到底发没发出去
 * （这正是分布式投递的经典难题，不是实现偷懒）。
 *
 * 所以本模块的边界写得死死的：
 *   ✅ **落账 + 标记**：任何时刻都能回答"哪些回复正在投递、发到第几片、给谁"
 *   ✅ **上一个人留下的烂账要**大声报出来**（第 9 条：可以失败，不许安静地失败）
 *   ✅ 提供 `--delivery` 给人看、`--delivery --resend <id>` 给人**显式决定**重发
 *   ❌ **绝不自动重放**：那会在"已发出但没标上"的情况下产生重复回复
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 所有者为什么是 `(pid, 进程启动时间)` 而不是 pid
 * ══════════════════════════════════════════════════════════════════════════
 * pid 会被**复用**：新进程拿到刚死掉那个进程的 pid 时，账本里"属于我"的行其实是
 * **上一个人**留下的 → 于是它会以为自己发过（漏发）或重发（重复）。
 * 加上进程启动时间之后，同一个 pid 的两次运行也能区分开。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 账本文件（相对工作区）。放 `runtime/` 下：它不是记忆、也不是给人看的日志。 */
export const LEDGER_REL = 'runtime/delivery-ledger.json'

/** 账本最多留多少条（超了丢最旧的已投递记录）。 */
export const MAX_ROWS = 500

/** 一次投递最多记多少片（正常回复切成 8 片以内；超了只记前 N 片 + 总数）。 */
const MAX_CHUNK_RECORDS = 20

/** 一条投递记录的三种状态。 */
export const STATE = {
  /** 落账了，但还没确认发完 —— **崩溃后要报出来的就是这些** */
  pending: 'pending',
  /** 全部发完并确认 */
  done: 'done',
  /** 中途失败（有 error） */
  failed: 'failed',
}

/** 所有者标识：`<pid>@<进程启动时间毫秒>`。 */
export function ownerId({ pid = process.pid, startedAt = 0 } = {}) {
  return `${pid}@${Number(startedAt) || 0}`
}

/** 读账本（坏文件不抛，但**必须留证据**）。 */
export function readLedger({ workspace, log = () => {} } = {}) {
  const abs = join(String(workspace ?? ''), LEDGER_REL)
  if (!String(workspace ?? '') || !existsSync(abs)) return { version: 1, rows: [] }
  try {
    const raw = JSON.parse(readFileSync(abs, 'utf8'))
    if (!raw || !Array.isArray(raw.rows)) {
      log(`⚠️ [delivery-ledger] 结构不对（${LEDGER_REL}）→ 当成空的；投递本身不受影响`)
      return { version: 1, rows: [] }
    }
    return { version: 1, rows: raw.rows }
  } catch (error) {
    log(`⚠️ [delivery-ledger] 读不了（${LEDGER_REL}）：${error?.message ?? error} → 当成空的；投递本身不受影响`)
    return { version: 1, rows: [] }
  }
}

/** 写账本（临时文件 + rename，与 tasks/recipes 同一套）。失败返回 false，不抛。 */
export function writeLedger({ workspace, ledger, log = () => {} } = {}) {
  const root = String(workspace ?? '')
  if (!root) return false
  const abs = join(root, LEDGER_REL)
  try {
    mkdirSync(dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
    renameSync(tmp, abs)
    return true
  } catch (error) {
    log(`⚠️ [delivery-ledger] 写不进去（${LEDGER_REL}）：${error?.message ?? error} —— 这一轮的投递**没有留痕**`)
    return false
  }
}

/** 只留最近 MAX_ROWS 条：**已投递的**先丢，pending 的永远留着（那是待处理的证据）。 */
function prune(ledger, max = MAX_ROWS) {
  const rows = Array.isArray(ledger.rows) ? ledger.rows : []
  if (rows.length <= max) return ledger
  const pending = rows.filter((r) => r.state === STATE.pending)
  const rest = rows
    .filter((r) => r.state !== STATE.pending)
    .sort((a, b) => Number(b.at) - Number(a.at))
    .slice(0, Math.max(0, max - pending.length))
  return { ...ledger, rows: [...pending, ...rest].sort((a, b) => Number(a.at) - Number(b.at)) }
}

/**
 * 造一个账本句柄（**绑定在一次投递上**）。
 *
 * 用法（桥接里）：
 *   const ticket = beginDelivery({ workspace, owner, chatKey, chunks, log })
 *   ... 每发一片：ticket.markSent(i)
 *   ticket.finish()  /  ticket.fail(why)
 */
export function beginDelivery({
  workspace,
  owner,
  chatKey,
  kind = '',
  peerId = '',
  chunks = [],
  key = '',
  at = Date.now(),
  log = () => {},
} = {}) {
  const id = `${Number(at)}-${Math.random().toString(36).slice(2, 8)}`
  const list = (Array.isArray(chunks) ? chunks : []).slice(0, MAX_CHUNK_RECORDS).map((text) => ({
    // ★ 只记**摘要**（长度 + 前 40 字）：账本是排查用的，不是第二份聊天记录。
    //   与 `memory-audit.mjs` 同一条纪律 —— 审计面越窄越好。
    chars: String(text ?? '').length,
    preview: String(text ?? '').slice(0, 40),
    sent: false,
  }))
  const row = {
    id,
    owner: String(owner ?? ''),
    at: Number(at),
    chatKey: String(chatKey ?? ''),
    kind: String(kind),
    peerId: String(peerId),
    total: Array.isArray(chunks) ? chunks.length : 0,
    key: String(key),
    state: STATE.pending,
    chunks: list,
  }

  const ledger = readLedger({ workspace, log })
  ledger.rows.push(row)
  writeLedger({ workspace, ledger: prune(ledger), log })

  return {
    id,
    /** 记下"第 i 片发出去了"。写盘失败不影响发送（但会留日志）。 */
    markSent(i) {
      try {
        const cur = readLedger({ workspace, log })
        const hit = cur.rows.find((r) => r.id === id)
        if (!hit) return false
        if (hit.chunks[i]) hit.chunks[i].sent = true
        return writeLedger({ workspace, ledger: prune(cur), log })
      } catch (error) {
        log(`⚠️ [delivery-ledger] 标记失败（第 ${i} 片）：${error?.message ?? error}`)
        return false
      }
    },
    /** 收尾：全部发完 → done；否则保持 pending（崩溃时留下的就是这种）。 */
    finish() {
      try {
        const cur = readLedger({ workspace, log })
        const hit = cur.rows.find((r) => r.id === id)
        if (!hit) return false
        const allSent = hit.chunks.every((c) => c.sent) && hit.total <= hit.chunks.length
        hit.state = allSent ? STATE.done : STATE.pending
        hit.finishedAt = Date.now()
        return writeLedger({ workspace, ledger: prune(cur), log })
      } catch (error) {
        log(`⚠️ [delivery-ledger] 收尾标记失败：${error?.message ?? error}`)
        return false
      }
    },
    /** 明确失败（发送抛异常）。 */
    fail(why) {
      try {
        const cur = readLedger({ workspace, log })
        const hit = cur.rows.find((r) => r.id === id)
        if (!hit) return false
        hit.state = STATE.failed
        hit.why = String(why ?? '').slice(0, 200)
        hit.finishedAt = Date.now()
        return writeLedger({ workspace, ledger: prune(cur), log })
      } catch (error) {
        log(`⚠️ [delivery-ledger] 失败标记写不进去：${error?.message ?? error}`)
        return false
      }
    },
  }
}

/**
 * ★ pid 还活着吗（用于区分"上一个人留下的"与"**别人正在发**"）。
 *
 * ⚠️ 这条判据有残余不确定性，如实写在这里：**pid 会被复用** —— 一个碰巧拿到同一个 pid
 * 的无关进程会让它看起来"还活着"。所以我们只用它来**降级**（宁可不报，也不要把
 * "正在投递"说成"上次没发完"），而**不是**用它来判定"这条一定发出去了"。
 */
export function isPidAlive(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    // ESRCH = 没这个进程；EPERM = 有进程但没权限（活着）
    return error?.code === 'EPERM'
  }
}

/**
 * 找出**别人**（已不在运行的进程）留下的未完成投递。
 *
 * ★★ 必须区分"上一个人留下的"与"**另一个正在跑的进程正在发**"：
 *    第一版没做这个区分，于是 CLI 在桥接**正在投递**的那一刻跑，
 *    会把那条正在发的回复报成"上一次运行没发完" —— 而它几百毫秒后就 done 了。
 *    那是**误导性证据**（比没有证据更糟：它会让人去翻一个根本不存在的问题）。
 *
 * @param {{workspace?: string, owner?: string, checkAlive?: boolean, log?: Function}} opts
 * @returns {{id: string, at: number, chatKey: string, total: number, sentCount: number, preview: string, owner: string}[]}
 */
export function orphanedDeliveries({ workspace, owner = '', checkAlive = true, isAlive = isPidAlive, log = () => {} } = {}) {
  const ledger = readLedger({ workspace, log })
  return ledger.rows
    .filter((r) => r.state === STATE.pending && r.owner !== owner)
    .filter((r) => (checkAlive ? !isAlive(String(r.owner ?? '').split('@')[0]) : true))
    .map((r) => ({
      id: r.id,
      at: Number(r.at),
      chatKey: r.chatKey,
      owner: String(r.owner ?? ''),
      total: Number(r.total) || 0,
      sentCount: (r.chunks ?? []).filter((c) => c.sent).length,
      preview: String(r.chunks?.[0]?.preview ?? ''),
    }))
    .sort((a, b) => a.at - b.at)
}

/**
 * 找出**有进程正在投递**的 pending 行（用于如实显示"正在发"，而不是误报成"没发完"）。
 * @returns {{id: string, at: number, chatKey: string, total: number, sentCount: number, preview: string, owner: string}[]}
 */
export function inFlightDeliveries({ workspace, owner = '', isAlive = isPidAlive, log = () => {} } = {}) {
  const ledger = readLedger({ workspace, log })
  return ledger.rows
    .filter((r) => r.state === STATE.pending && r.owner !== owner && isAlive(String(r.owner ?? '').split('@')[0]))
    .map((r) => ({
      id: r.id,
      at: Number(r.at),
      chatKey: r.chatKey,
      owner: String(r.owner ?? ''),
      total: Number(r.total) || 0,
      sentCount: (r.chunks ?? []).filter((c) => c.sent).length,
      preview: String(r.chunks?.[0]?.preview ?? ''),
    }))
    .sort((a, b) => a.at - b.at)
}

/** 渲染成给人看的一段（启动日志 / `--delivery` 共用）。 */
export function renderOrphans(orphans = []) {
  if (orphans.length === 0) return ''
  const lines = [
    `⚠️ 上一次运行留下了 ${orphans.length} 条**没确认发完**的回复：`,
  ]
  for (const o of orphans.slice(0, 20)) {
    const when = new Date(o.at).toISOString().replace('T', ' ').slice(0, 19)
    lines.push(
      `  · ${when} → ${o.chatKey}（已发出 ${o.sentCount}/${o.total} 片）：${o.preview ? `「${o.preview}…」` : '（无预览）'}`,
    )
  }
  if (orphans.length > 20) lines.push(`  …（另有 ${orphans.length - 20} 条）`)
  lines.push(
    '★ 我们**不会自动重发**：崩溃可能发生在"已经发出去、但还没标上"的那一瞬间，' +
      '自动重发就会让对方看到两条重复的回复。要不要补发由人决定：`--delivery --resend <id>`。',
  )
  return lines.join('\n')
}

/** 渲染"正在投递"的一段（避免把它误报成"上一次没发完"）。 */
export function renderInFlight(inFlight = []) {
  if (inFlight.length === 0) return ''
  const lines = [`ℹ️ 另外有 ${inFlight.length} 条**正在投递中**（有桥接进程还在跑，不是失败）：`]
  for (const o of inFlight.slice(0, 10)) {
    const when = new Date(o.at).toISOString().replace('T', ' ').slice(0, 19)
    lines.push(`  · ${when} → ${o.chatKey}（已发出 ${o.sentCount}/${o.total} 片）：${o.preview ? `「${o.preview}…」` : ''}`)
  }
  return lines.join('\n')
}

/** 渲染整本账（`--delivery`）。 */
export function renderLedger({ ledger, limit = 30 } = {}) {
  const rows = [...(ledger?.rows ?? [])].sort((a, b) => Number(b.at) - Number(a.at)).slice(0, limit)
  if (rows.length === 0) return '投递账本还是空的（它从这次升级之后才开始记）。'
  const icon = { [STATE.done]: '✅', [STATE.pending]: '⚠️', [STATE.failed]: '❌' }
  const lines = []
  for (const r of rows) {
    const when = new Date(Number(r.at)).toISOString().replace('T', ' ').slice(0, 19)
    const sent = (r.chunks ?? []).filter((c) => c.sent).length
    lines.push(
      `${icon[r.state] ?? '?'} ${when}  ${r.chatKey}  ${sent}/${r.total} 片  ${r.state}` +
        (r.why ? `（${r.why}）` : '') +
        `  ${r.chunks?.[0]?.preview ? `「${r.chunks[0].preview.slice(0, 30)}…」` : ''}`,
    )
  }
  return lines.join('\n')
}
