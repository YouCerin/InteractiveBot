/**
 * 任务台账：**从操作流水提炼"我正在干什么、干到哪了"**，并在每轮注入。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它解决什么（这是整个项目最容易被忽略的一类失败）
 * ══════════════════════════════════════════════════════════════════════════
 * DSH 的会话上下文（L-A）**我们够不到**：SDK 只暴露 initialize / session/prompt /
 * shutdown，没有 resume、没有压缩控制（见 `session-id.mjs`）。而会话越滚越长时，
 * 早期内容会被挤出或被压缩 —— **模型就丢了主线**：忘了已经查过什么、
 * 反复重试同一条走不通的路、说着说着换了话题还接着往下说。
 *
 * 我们改不了 L-A，但可以**在里面钉一个锚**：把"当前任务"每轮注入。
 * 于是不管 L-A 怎么滚，**主线始终在提示词里**。
 *
 * ── 关键设计决定：目标与主线**不让模型写**（v1）─────────────────────────
 * `docs/0.2.1-runtime-memory-design.md` §2.1 原本给台账设计了 `goal` 与
 * `mainline` 两个**模型写的**字段。这里**刻意先不做**，理由是已被两次实测
 * 验证过的那条教训：
 *
 *   · 记忆诊断：模型在本机 **58 次 + 我们这里几十轮**真实运行里，
 *     "顺手记一笔"这件事漏报率极高 —— 靠模型自觉的路径不可靠。
 *   · 而任务台账恰恰是**每轮都要用**的东西：它一旦空着，"不丢主线"就完全失效。
 *
 * 所以 v1 的 `goal` / `mainline` **全部由桥接从操作流水确定性推导**：
 * 目标 = 用户最近这条话（**原文，不加工**），主线 = 最近几步的事实描述。
 * 这样它**永远不会空**，也不依赖任何模型行为。
 *
 * ⚠️ 模型的补充（它对"这个任务到底是什么"的理解确实比规则准）**留到二期**，
 *    而且必须做成"叠加"而不是"依赖"：`goalSource: 'user-message' | 'model'`，
 *    模型没写就仍然用规则那条。
 *
 * ── 与 oplog 的分工 ────────────────────────────────────────────────────
 *   `oplog`（R1）：**逐条事实流水**，给排查与回溯用，带 TTL、会过期。
 *   `tasks`（R2）：**提炼后的当前状态**，给模型每轮看，只保留最近几步。
 * 同一个数据源，两个用途 —— 不要合并（一个要全、一个要短）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** 台账里最多保留几步（再多就只是 oplog 的复制品，"当前在做什么"反而糊掉）。 */
export const MAX_STEPS = 12

/** 注入提示词时最多列几步（更少 —— 注入的每一行都要付 token）。 */
export const MAX_INJECT_STEPS = 6

/**
 * 多久没有新活动就认为"上一个任务结束了"（毫秒）。
 *
 * 为什么是 30 分钟：QQ 里一次连续的任务型对话通常在这个量级内；
 * 隔了大半天再说话，硬说"你还在做那件事"只会让它莫名其妙地接着旧话题。
 */
export const TASK_IDLE_MS = 30 * 60 * 1000

/** 已完成/已放弃的台账保留多久（之后归档，不再注入）。 */
export const TASK_KEEP_DONE_MS = 24 * 60 * 60 * 1000

// ══════════════════════════════════════════════════════════════════════════
// 工具 → 人话动作
// ══════════════════════════════════════════════════════════════════════════

/**
 * 把工具名与参数翻译成一句**人话**。
 *
 * 为什么要翻译：`--ops` 里 `read {"file_path":"a.txt"}` 是给排查的人看的；
 * 而注入给模型的是"我正在干什么"，写成人话它才不用重新解析一遍自己的历史。
 *
 * ⚠️ 不做花哨推断：认不出的工具就用工具名 + 参数摘要（**不编**）。
 */
export function describeAction(name, args) {
  const a = args && typeof args === 'object' ? args : {}
  const cut = (s, n = 40) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim()
    return t.length > n ? `${t.slice(0, n)}…` : t
  }
  switch (name) {
    case 'read': return `读文件 ${cut(a.file_path, 50)}`
    case 'write': return `写文件 ${cut(a.file_path, 50)}`
    case 'edit': return `改文件 ${cut(a.file_path, 50)}`
    case 'glob': return `找文件 ${cut(a.pattern, 30)}`
    case 'grep': return `搜内容 ${cut(a.pattern, 30)}`
    case 'pwsh': return `跑命令 ${cut(a.command, 50)}`
    case 'web_search': return `搜索 ${cut(Array.isArray(a.queries) ? a.queries.join(' / ') : a.query, 50)}`
    case 'web_fetch': return `抓网页 ${cut(a.url, 50)}`
    case 'read_image': return `看图 ${cut(a.file_path ?? a.relPath, 40)}`
    case 'job_output': return `读后台任务输出`
    case 'job_list': return `列后台任务`
    case 'job_kill': return `停后台任务`
    case 'mcp__qq__qq_send_sticker': return '发 QQ 表情'
    case 'mcp__qq__qq_poke': return '戳一戳'
    case 'mcp__qq__qq_recall': return '撤回消息'
    case 'mcp__qq__qq_group_members': return `查群成员（群 ${cut(a.groupId, 20)}）`
    case 'mcp__qq__qq_group_history': return `查群历史（群 ${cut(a.groupId, 20)}）`
    case 'mcp__qq__qq_message_detail': return '查消息详情'
    case 'mcp__qq__qq_api': return `调 QQ 接口 ${cut(a.action, 30)}`
    default: {
      // 认不出的工具：用工具名 + 参数摘要（第一对键值），**不编语义**
      const first = Object.entries(a).slice(0, 2).map(([k, v]) => `${k}=${cut(v, 24)}`).join(' ')
      return first ? `${name}（${first}）` : String(name)
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 从 ops 提炼步骤
// ══════════════════════════════════════════════════════════════════════════

/**
 * 把一回合的 `ops` 提炼成台账的 `steps`。
 *
 * 配对规则：`tool/call` 与 `tool/result` 用 `callId` 配对。
 *   · 两条齐 → `outcome: ok | failed`（按 `result.ok`）
 *   · 只有 call（结果还没回来，或回合被中止）→ `outcome: 'pending'`
 *     **不能当成失败**：我们只是不知道结果，猜错会让模型以为那步白做了。
 *   · 被审批拒绝 → `outcome: 'blocked'`，并**同时进 `blocked[]`**
 *
 * `learnt` 是**机械生成的**（结果的前若干字）—— 它不是"模型学到了什么"，
 * 而是"这步返回了什么"的极简摘要。命名沿用设计文档，但语义要说清，
 * 否则以后有人会以为这里有智能。
 *
 * @param {object[]} ops
 * @param {{excerpt?: number}} [opts]
 * @returns {object[]}
 */
export function stepsFromOps(ops = [], { excerpt = 80 } = {}) {
  const out = []
  const byCallId = new Map()
  for (const op of Array.isArray(ops) ? ops : []) {
    if (op?.type === 'tool/call') {
      const step = {
        at: op.at ?? Date.now(),
        turn: op.turn ?? null,
        tool: String(op.name ?? '?'),
        action: describeAction(op.name, op.args),
        args: op.args ?? null,
        result: '',
        outcome: 'pending',
      }
      out.push(step)
      if (op.callId) byCallId.set(op.callId, step)
    } else if (op?.type === 'tool/result') {
      const step = op.callId ? byCallId.get(op.callId) : null
      if (!step) continue
      step.result = String(op.excerpt ?? '').replace(/\s+/g, ' ').slice(0, excerpt)
      // `ok` 可能是 null（没测到）—— 那就保持 pending，**不猜**
      step.outcome = op.ok === true ? 'ok' : op.ok === false ? 'failed' : 'pending'
      if (op.ok === false) step.failed = true
    } else if (op?.type === 'approval' && op.outcome === null) {
      // 审批被问到 —— 记下候选，等 decided
      out.push({ at: op.at ?? Date.now(), turn: op.turn ?? null, tool: String(op.toolName ?? '?'),
        action: `权限审批：${op.toolName ?? '?'}`, result: String(op.reason ?? '').slice(0, excerpt),
        outcome: 'pending', approval: true })
    } else if (op?.type === 'approval/decided') {
      const last = [...out].reverse().find((s) => s.approval && s.outcome === 'pending')
      if (last) {
        const denied = op.outcome === 'unavailable' || op.outcome === 'rejected'
        last.outcome = denied ? 'blocked' : 'ok'
        last.decision = op.outcome ?? 'unknown'
      }
    }
  }
  return out
}

/** 从步骤里挑出"被挡住的"（进 `blocked[]`，注入时单独成段）。 */
export function blockedFromSteps(steps = []) {
  return steps
    .filter((s) => s.outcome === 'blocked')
    .map((s) => ({
      what: s.action,
      why: s.decision === 'unavailable'
        ? '越界被自动拒绝（沙箱只允许工作区）'
        : s.decision === 'rejected'
          ? '审批被拒绝'
          : '权限被拒',
      at: s.at,
    }))
}

// ══════════════════════════════════════════════════════════════════════════
// 台账读写
// ══════════════════════════════════════════════════════════════════════════

function safeChatKey(chatKey) {
  return String(chatKey ?? 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_')
}

/** 台账文件（工作区相对路径）。 */
export function taskRel(chatKey) {
  return `runtime/tasks/${safeChatKey(chatKey)}.json`
}

function readJson(file, fallback = null) {
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : fallback
  } catch {
    return fallback
  }
}

/** 原子写（tmp + rename）。 */
function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** 读某会话的台账（不存在返回 null）。 */
export function readTask({ workspace, chatKey } = {}) {
  const root = String(workspace ?? '')
  if (!root || !chatKey) return null
  return readJson(join(root, taskRel(chatKey)), null)
}

/**
 * 记一轮任务活动：把这一回合的 ops 并进台账。
 *
 * **绝不抛异常** —— 台账是增强，坏了也不能影响回合
 *（与 memory-stats / oplog 同一条纪律）。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {string} opts.chatKey
 * @param {object[]} opts.ops
 * @param {string} [opts.userText] 本轮用户说的话 → 作为**目标**（规则来源）
 * @param {Date}   [opts.now]
 * @returns {{ok: boolean, task?: object, why?: string}}
 */
export function noteTaskTurn({ workspace, chatKey, ops = [], userText = '', now = new Date() } = {}) {
  const root = String(workspace ?? '')
  if (!root || !chatKey) return { ok: false, why: '缺少 workspace 或 chatKey' }
  const at = now.getTime()
  try {
    let task = readTask({ workspace: root, chatKey })

    // ── 任务边界：闲置太久就开新任务 ──────────────────────────────────────
    const idle = task ? at - Number(task.lastActiveAt ?? 0) : Infinity
    if (!task || idle > TASK_IDLE_MS || task.status !== 'active') {
      task = {
        chatKey: String(chatKey),
        status: 'active',
        startedAt: at,
        lastActiveAt: at,
        turns: 0,
        // ⚠️ `turns` 是**本任务内**的轮数，闲置超过 TASK_IDLE_MS 就随新任务一起归零。
        //    不要拿它和 `memory/.stats.json` 的 `turns` 对比 —— 那个是**累计**的
        //    （同一个会话从第一次活动算起，从不重置）。两者语义不同，
        //    实测在同一时刻会分别是 2 和 5，看起来像"少记了"，其实都对。
        // ★ 目标 = 用户最近这条话的**原文**（不加工）。
        //   为什么用原文而不是让模型总结：见文件头"关键设计决定"。
        goal: String(userText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
        goalSource: 'user-message',
        goalAt: at,
        steps: [],
        tried: [],
        blocked: [],
      }
    }

    const newSteps = stepsFromOps(ops)
    // ── 去重与失败留痕 ────────────────────────────────────────────────────
    for (const s of newSteps) {
      // 同一次调用可能被重复喂进来（重入保护）：按 时间+动作 去重
      if (task.steps.some((x) => x.at === s.at && x.action === s.action)) continue
      task.steps.push(s)
      // 失败的做法进 `tried`（**这是"别重复试同一个方法"的依据**）
      if (s.outcome === 'failed') {
        task.tried.push({ approach: s.action, why: `失败：${String(s.result).slice(0, 60)}`, at: s.at })
      }
    }
    // `blocked` 从**全部**步骤重算（而不是追加），这样审批结果回填后不会留下脏记录
    task.blocked = blockedFromSteps(task.steps)

    // 上限：只留最近 MAX_STEPS 步（更早的仍在 oplog 里，需要时能查）
    if (task.steps.length > MAX_STEPS) task.steps = task.steps.slice(-MAX_STEPS)
    if (task.tried.length > 8) task.tried = task.tried.slice(-8)

    // ── 回退标记的生命周期：重做过一次就不再提 ────────────────────────────
    // 判据是"**有没有新步骤落进来**"（本回合真的动了），而不是"过了几轮"：
    // 用户说"回到第 3 步"之后模型可能先回一句话、下一轮才真动手，
    // 按轮数清会让声明过早消失。
    if (task.redo && newSteps.length > 0) {
      task.redoDoneAt = at
      delete task.redo
    }

    // 目标跟随"用户最近说的话"（同一任务里他可能把要求说细了）
    //
    // ★★ 但**只有这一轮真的动手了（`newSteps` 非空）才覆盖** —— 这是真机修的第二个缺陷：
    //    原先无条件用"本轮用户原话"覆盖，于是**一句道谢会把目标冲掉**。
    //    实测（2026-09-26 22:36 私聊）：一段连着查资料的对话里，用户最后回了一句
    //    "原来如此，太棒了"，台账的 `goal` 当场变成这句 —— 注入给模型的就成
    //    「对方最近的要求：原来如此，太棒了」，而 R4 抽取向模型描述的
    //    "用户的要求"也变成这句，模型在思考里明确纠结"这只是一句夸赞，不是要求"。
    //    判据与"重做标记的生命周期"用**同一个概念**：**动手了才算这一轮推进了任务**。
    //    （任务刚建立时仍然无条件记原话 —— 那是任务的起点，见上面的创建分支。）
    const t = String(userText ?? '').replace(/\s+/g, ' ').trim()
    if (t && newSteps.length > 0) {
      task.goal = t.slice(0, 80)
      task.goalAt = at
    }
    task.turns = Number(task.turns ?? 0) + 1
    task.lastActiveAt = at
    writeJson(join(root, taskRel(chatKey)), task)
    return { ok: true, task }
  } catch (error) {
    return { ok: false, why: error?.message ?? String(error) }
  }
}

/**
 * 台账闲置了多久（毫秒）。**判不出来就返回 `null`**。
 *
 * 为什么用 `null` 而不是 `0` 或 `Infinity`：
 *   `0` 的意思会被读成"刚刚还在动"，`Infinity` 会被读成"永远算闲置" ——
 *   两者都会让"没有时间戳的台账"被**当成结论**。
 *   而没有 `lastActiveAt` 只说明"判不了"，此时应当**保守地按现状渲染**
 *   （见 {@link renderTaskBlock} 的注释），而不是凭空降级。
 *
 * @param {object} task
 * @param {Date|number} [now]
 * @returns {number|null}
 */
export function taskIdleMs(task, now = new Date()) {
  const last = Number(task?.lastActiveAt)
  if (!Number.isFinite(last) || last <= 0) return null
  const t = now instanceof Date ? now.getTime() : Number(now)
  if (!Number.isFinite(t)) return null
  return Math.max(0, t - last)
}

/**
 * 台账是否已闲置超过 {@link TASK_IDLE_MS}（判不出来 → `false`，见上）。
 *
 * @param {object} task
 * @param {Date|number} [now]
 * @returns {boolean}
 */
export function isTaskStale(task, now = new Date()) {
  const idle = taskIdleMs(task, now)
  return idle !== null && idle > TASK_IDLE_MS
}

/** 把闲置时长写成人话（给模型看的，不要"1.78 小时"这种）。 */
function humanIdle(ms) {
  const minutes = Math.max(1, Math.round(Number(ms) / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
}

/**
 * 生成注入提示词的那一段（**纯函数**，便于测试与预览）。
 *
 * ⚠️ 措辞纪律（三条都有具体理由）：
 *   ① **不叫"消息 id"** ——`replyToMessageId` 用的是**真正的消息 id**，
 *      而这里的"第 N 步"是我们自己的编号。混称会让模型拿步骤号去引用消息
 *      （`#数字` 在输入里是消息 id），那是**用户可见的错误**。
 *   ② **说清这是"你自己干过的"**，不是对方说的话 —— 否则模型会把
 *      "读文件 a.txt" 当成对方说过的内容。
 *   ③ **作废的步骤要明说不要当事实**（为 R3 的"回到第 N 步"预留；
 *      现在 `superseded` 恒为空，但格式先立住）。
 *   ④ **闲置超过 `TASK_IDLE_MS` 要降级**（见下）—— 不能一直自称"当前任务"。
 *
 * @param {object} task
 * @param {{maxSteps?: number, now?: Date|number}} [opts] `now` 用于闲置判定；
 *   默认取真实当前时间。测试要固定时间时必须显式传（别依赖真实时钟，
 *   这里踩过一次：fixture 用的是写死的过去时间，于是"当前任务"全被判成闲置）。
 * @returns {string} 空串 = 没东西可注入
 */
export function renderTaskBlock(task, { maxSteps = MAX_INJECT_STEPS, now = new Date() } = {}) {
  if (!task || task.status !== 'active') return ''
  const steps = Array.isArray(task.steps) ? task.steps : []
  const blocked = Array.isArray(task.blocked) ? task.blocked : []
  const tried = Array.isArray(task.tried) ? task.tried : []
  if (steps.length === 0 && blocked.length === 0) return ''
  // 有效步骤（回退后被作废的不算）—— 下面的回退声明与步骤列表都要用它
  const valid = steps.filter((s) => s.outcome !== 'superseded')

  // ── 闲置降级（★ 真实缺陷修复）────────────────────────────────────────
  //
  // 症状：台账超过 `TASK_IDLE_MS` 之后**仍以【当前任务】的身份注入**。
  //   而 `noteTaskTurn` 那边同样一条闲置规则却会**开一个新任务** ——
  //   于是出现自相矛盾的一轮：开头告诉模型"你正在做这件事"，
  //   结尾（`noteTaskTurn`）却把这件事判定为结束、重开了一个空台账。
  // 为什么会发生：闲置判定原先只写在 `noteTaskTurn`（**回合结束**）里，
  //   而注入发生在**回合开始**，中间没有任何人检查过时间。
  //
  // 为什么**降级**而不是**直接不注入**：
  //   对方隔一小时回来只说一句"继续"，直接不注入就等于把主线丢了 ——
  //   而那正是这一层记忆存在的理由（见文件头）。
  //   所以保留内容，只把**身份**从"当前"改成"上一件（可能已结束）"，
  //   并明确禁止"对方没提也主动接着做"。
  const idle = taskIdleMs(task, now)
  const stale = idle !== null && idle > TASK_IDLE_MS

  const lines = [
    stale
      ? '【上一件事（这是**你自己**前几轮做过的事，不是对方说的话；**可能已经结束**）】'
      : '【当前任务（这是**你自己**这几轮做过的事，不是对方说的话）】',
  ]
  if (stale) {
    lines.push(
      `⚠️ 距离上次动它已经 **${humanIdle(idle)}** —— 如果对方这句话跟它无关，就当它已经结束：` +
        '不要主动接着做，也不要主动提它。' +
        '只有对方明显是在接着这件事（"继续""刚才那个""那个弄完了吗"）时，才参考下面的步骤。',
    )
  }

  // ── 回退声明（放在最前，因为它改变"什么算已发生"）─────────────────────
  //
  // ⚠️ 这是**声明**，不是**清除**：DSH 的会话上下文我们回退不了
  //    （实测无 checkpoint/fork/resume）。模型**仍然记得**那些步骤的内容，
  //    所以我们唯一能做的是明确告诉它"那些作废了"。
  //    措辞必须说透这一层，否则以后有人会以为这里真的撤销了会话状态。
  if (task.redo && Number.isFinite(Number(task.redo.step))) {
    const r = task.redo
    const target = valid[Number(r.step) - 1] ?? steps[Number(r.step) - 1]
    lines.push('')
    lines.push(`⚠️【已回退到第 ${r.step} 步】你要做的：${ROLLBACK_MODES[r.mode] ?? ROLLBACK_MODES.replay}`)
    if (target) lines.push(`  第 ${r.step} 步原本是：${target.action}${target.result ? ` → ${String(target.result).slice(0, 50)}` : ''}`)
    if (r.note) lines.push(`  补充说明：${r.note}`)
    lines.push('  **第 ' + r.step + ' 步之后的那些步骤已作废** —— 不要把它们当成已发生的事实，')
    lines.push('  也不要重复它们做过的事。（你上下文里可能还留着那些内容，那是作废前的，忽略即可。）')
    lines.push('')
  }

  if (task.goal) {
    lines.push(stale ? `上一件事的目标：${task.goal}` : `对方最近的要求：${task.goal}`)
  }

  const superseded = steps.length - valid.length
  const shown = valid.slice(-Math.max(1, maxSteps))
  if (shown.length > 0) {
    lines.push(`已做过 ${valid.length} 步（列最近 ${shown.length} 步）：`)
    for (const s of shown) {
      const mark = s.outcome === 'ok' ? '✓' : s.outcome === 'failed' ? '✗' : s.outcome === 'blocked' ? '🔒' : '…'
      const tail = s.result ? ` → ${String(s.result).slice(0, 60)}` : ''
      lines.push(`  ${mark} ${s.action}${tail}`)
    }
  }
  if (superseded > 0) {
    lines.push(`（另有 ${superseded} 步已作废，**不要**把它们当成已发生的事实）`)
  }

  if (tried.length > 0) {
    lines.push('试过但**没成**的（别重复走）：')
    for (const t of tried.slice(-3)) lines.push(`  · ${t.approach}（${String(t.why).slice(0, 50)}）`)
  }
  if (blocked.length > 0) {
    lines.push('被挡住的（换个做法，别硬试）：')
    for (const b of blocked.slice(-3)) lines.push(`  · ${b.what} → ${b.why}`)
  }

  lines.push(
    '（这些只是你自己的操作记录，**不要**把它们当消息引用。' +
      '要引用某条消息就用 `[reply:<消息id>]` 标记 —— 消息 id 在来源标注里带 `#` 的那个位置。）',
  )
  return lines.join('\n')
}

// ══════════════════════════════════════════════════════════════════════════
// 回到第 N 步（R3）
// ══════════════════════════════════════════════════════════════════════════

/** 三种重做姿势。 */
export const ROLLBACK_MODES = {
  replay: '重做这一步（可以换参数）',
  retry: '这一步没成，换个方法再试',
  abandon: '这一步不需要了，直接往后走',
}

/**
 * 触发词：用户说"回到第 N 步"。**本地匹配，不依赖模型**。
 *
 * 为什么用本地匹配（而不是让模型听懂然后自己回退）：
 *   与记忆写入同一条教训 —— 实测靠模型自觉的路径漏报率极高。
 *   回退是**明确的状态操作**，用户说了就该发生，不该看模型心情。
 *
 * 支持的写法：
 *   回到第3步 / 回到第 3 步 / 退回第2步 / 回到上一步
 *   撤销这一步 / 撤销本步 / 重做这一步（指代"当前这一步"）
 */
const ROLLBACK_RE =
  /(?:回到|退回|返回|退到|重做|重新做|撤销|撤消)\s*第?\s*(\d{1,2})\s*步/
/** 指代"当前这一步"（没有数字）。**必须排在数字式之后**判断。 */
const ROLLBACK_THIS_RE = /(?:回到|退回|返回|退到|重做|重新做|撤销|撤消)\s*(?:这|本)\s*一?\s*步/
const ROLLBACK_LAST_RE = /(?:回到|退回|返回|退到|重做|撤销|撤消)\s*(?:上|前)\s*一?\s*步/

/**
 * 从用户的一句话里识别"回到第 N 步"。
 *
 * `step` 的三种取值，调用方要分清：
 *   · 数字      —— 明确说了第几步
 *   · `null`    —— **指代式**：可能是"上一步"也可能是"这一步"，
 *                  由调用方按当前有效步数换算（见 `mode` 之外的 `which`）
 *
 * @param {string} text
 * @returns {{hit: boolean, step: number|null, mode: string, which: 'explicit'|'last'|'this'|null}}
 */
export function parseRollback(text) {
  const t = String(text ?? '')
  if (!t) return { hit: false, step: null, mode: 'replay', which: null }
  const m = ROLLBACK_RE.exec(t)
  if (m) {
    // 措辞里带"重做/重新做"→ retry；带"撤销/撤消"→ abandon；其余 replay
    const mode = /重做|重新做/.test(m[0]) ? 'retry' : /撤销|撤消/.test(m[0]) ? 'abandon' : 'replay'
    return { hit: true, step: Number(m[1]), mode, which: 'explicit' }
  }
  if (ROLLBACK_THIS_RE.test(t)) {
    const mode = /重做|重新做/.test(t) ? 'retry' : /撤销|撤消/.test(t) ? 'abandon' : 'replay'
    return { hit: true, step: null, mode, which: 'this' }
  }
  if (ROLLBACK_LAST_RE.test(t)) return { hit: true, step: null, mode: 'replay', which: 'last' }
  return { hit: false, step: null, mode: 'replay', which: null }
}

/**
 * 回退任务台账到第 N 步。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ 先讲清**它做不到什么**（不写清楚就会变成骗人的功能）
 * ══════════════════════════════════════════════════════════════════════════
 * **DSH 的会话上下文（L-A）不会回退。** 本机实测该会话的全部 17 种事件类型里
 * **零条 `checkpoint` / `fork` / `revert` / `resume`**，而 SDK 只暴露
 * `initialize`/`session/prompt`/`shutdown`（见 `session-id.mjs`）。
 * 所以模型**仍然"记得"第 N+1..M 步的内容**。
 *
 * 我们唯一的拦截手段是**在提示词里显式声明那些步骤作废**
 *（见 `renderTaskBlock` 的"另有 N 步已作废，不要把它们当成已发生的事实"）。
 * 这是**声明**，不是**清除** —— 接口与文档都必须这么说。
 *
 * **副作用也不回退**：已经发出的 QQ 消息、已经写入工作区的文件都不会回滚。
 * 回退只针对**任务台账**。
 *
 * ── 行为 ────────────────────────────────────────────────────────────────
 *   · 步骤编号 = `steps` 数组里的**序号（从 1 开始）**，不是 DSH 的 step 字段
 *     （那个每轮从 1 重来，做不了稳定编号）
 *   · `rollbackTo = N` → 1..N 有效，N+1..M 标记 `superseded`（**保留不删**）
 *   · 记 `checkpoint` 与 `redo`（三种姿势），供下一轮注入
 *   · N 越界 → **不猜**：报错并列出可用范围（`AGENT.md` 第 6 条）
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {string} opts.chatKey
 * @param {number} opts.step
 * @param {'replay'|'retry'|'abandon'} [opts.mode]
 * @param {string} [opts.note]
 * @param {Date} [opts.now]
 * @returns {{ok: boolean, why?: string, task?: object, range?: [number, number]}}
 */
export function rollbackTask({ workspace, chatKey, step, mode = 'replay', note = '', now = new Date() } = {}) {
  const root = String(workspace ?? '')
  if (!root || !chatKey) return { ok: false, why: '缺少 workspace 或 chatKey' }
  const task = readTask({ workspace: root, chatKey })
  if (!task) return { ok: false, why: '这个会话还没有任务台账' }
  const steps = Array.isArray(task.steps) ? task.steps : []
  if (steps.length === 0) return { ok: false, why: '台账里一步都没有，没有可回退的位置' }

  const n = Math.round(Number(step))
  if (!Number.isFinite(n)) return { ok: false, why: `步数必须是数字（收到 ${JSON.stringify(step)}）` }
  const range = [1, steps.length]
  if (n < 1 || n > steps.length) {
    return {
      ok: false,
      range,
      why: `超出范围：当前任务只到第 ${steps.length} 步，没法回到第 ${n} 步。可用范围 ${range[0]}~${range[1]}`,
    }
  }
  const useMode = ROLLBACK_MODES[mode] ? mode : 'replay'

  // ★ 编号从 1 开始 → 数组下标 n-1
  const target = steps[n - 1]
  steps.forEach((s, i) => {
    // ⚠️ 同时**恢复**之前被作废的、且落在 1..N 之间的步骤 ——
    //    否则连续两次回退（先回 5、再回 3）会让第 4~5 步永久作废，
    //    而用户第二次的意思显然是"1~3 有效"。
    if (i < n) {
      if (s.outcome === 'superseded') {
        s.outcome = s.wasOutcome ?? 'pending'
        delete s.wasOutcome
      }
      return
    }
    if (s.outcome !== 'superseded') {
      s.wasOutcome = s.outcome // 记下原状态，便于"再往前回"时恢复
      s.outcome = 'superseded'
    }
  })

  task.checkpoint = { step: n, at: now.getTime(), invalidatedAfter: n }
  task.redo = { step: n, mode: useMode, note: String(note ?? '').slice(0, 120), at: now.getTime() }
  task.rollbacks = Array.isArray(task.rollbacks) ? task.rollbacks : []
  task.rollbacks.push({ to: n, mode: useMode, at: now.getTime(), note: String(note ?? '').slice(0, 120) })
  if (task.rollbacks.length > 10) task.rollbacks = task.rollbacks.slice(-10)
  task.lastActiveAt = now.getTime()

  try {
    writeJson(join(root, taskRel(chatKey)), task)
  } catch (error) {
    return { ok: false, why: `写回失败：${error?.message ?? error}` }
  }
  return { ok: true, task, target, range }
}

/** 清掉 `redo` 标记（重做过一次之后就不该再提）。 */
export function clearRedo({ workspace, chatKey } = {}) {
  try {
    const root = String(workspace ?? '')
    if (!root || !chatKey) return false
    const task = readTask({ workspace: root, chatKey })
    if (!task || !task.redo) return false
    delete task.redo
    writeJson(join(root, taskRel(chatKey)), task)
    return true
  } catch {
    return false
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 生命周期
// ══════════════════════════════════════════════════════════════════════════

/** 列出所有台账（相对路径）。 */
export function listTasks({ workspace } = {}) {
  try {
    const dir = join(String(workspace ?? ''), 'runtime', 'tasks')
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => `runtime/tasks/${f}`).sort()
  } catch {
    return []
  }
}

/**
 * 归档过期台账：已完成/已放弃超过保留期的，移进 `runtime/archive/`。
 *
 * **默认预演**。判据只看 `status` 与 `lastActiveAt`，不读内容。
 */
export function archiveStaleTasks({ workspace, apply = false, now = new Date() } = {}) {
  const root = String(workspace ?? '')
  const moved = []
  const kept = []
  const at = now.getTime()
  for (const rel of listTasks({ workspace: root })) {
    const task = readJson(join(root, rel), null)
    if (!task) {
      kept.push(rel)
      continue
    }
    const done = task.status && task.status !== 'active'
    const stale = at - Number(task.lastActiveAt ?? 0) > TASK_KEEP_DONE_MS
    if (done && stale) {
      if (apply) {
        try {
          const dst = join(root, 'runtime', 'archive', rel.replace(/^runtime\/tasks\//, ''))
          mkdirSync(join(dst, '..'), { recursive: true })
          renameSync(join(root, rel), dst)
        } catch {
          kept.push(rel)
          continue
        }
      }
      moved.push(rel)
    } else {
      kept.push(rel)
    }
  }
  return { moved, kept }
}

/** 删掉某会话的台账（管理手段；`--tasks --forget <会话>`）。 */
export function forgetTask({ workspace, chatKey } = {}) {
  try {
    const p = join(String(workspace ?? ''), taskRel(chatKey))
    if (!existsSync(p)) return false
    // ⚠️ 用 `unlinkSync`，**不要改成 `rmSync`**（与 memory-files / images / api 同一教训）。
    // 实测（Node v24.9.0 / Windows）：`rmSync(path)` 删单个文件要么**静默失败**
    // （不抛错、返回值正常、但文件仍在），要么直接把进程**崩掉**
    // （退出码 -1073740791 = STATUS_STACK_BUFFER_OVERRUN）——
    // 我在 recipes.mjs 上就崩过一次，而项目里三处早已记下这条。
    unlinkSync(p)
    // 复核：不信任"调用没报错"就等于"真的删掉了"（上面那个教训）。
    return !existsSync(p)
  } catch {
    return false
  }
}
