/**
 * QQ 会话键 → DSH sessionId 的映射。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ 这个文件记录了一个**实测发现的硬限制**，改之前务必读完。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 【现象】第一版设计让 sessionId 完全稳定（同一个 QQ 会话永远映射同一个 id），
 * 目的是让上下文跨重启连续。第一次跑通了，**第二次跑直接失败**：
 *
 *     RPC session/prompt 失败：session "qq-19e80e0ff1dd" already exists
 *
 * 【根因】读 dsh-sdk-jsonrpc-server/lib/index.js:203-231 得到：
 *
 *     async getOrCreateSession(sessionId) {
 *       const existing = this.sessions.get(sessionId);   // ← 只看内存
 *       if (existing) return existing;
 *       ...
 *       return this.createSession(sessionId);            // ← 内存没有就 create
 *     }
 *     async createSession(sessionId) {
 *       const rec = { handle: await this.ctx.agents.create({ sessionId: ... }) };
 *
 * 进程重启后内存 map 是空的，于是必然走 `agents.create`；而**磁盘上已经
 * 存在同名持久化会话时，`agents.create` 会抛 "already exists"**。
 * 同时 SDK 只暴露三个方法（initialize / session/prompt / shutdown）——
 * **没有 resume**，所以没有任何干净的续接途径。
 *
 * 【结论】"sessionId 永久稳定"在 SDK 这条路上**做不到**。必须接受：
 *   · 同一个进程生命周期内 → 上下文连续（这是我们能拿到的）
 *   · 进程重启后          → 必须换一个新 id（否则直接报错，机器人完全不工作）
 *
 * 【代价】重启后 DSH 侧不记得之前的对话。这是**已知且有意的取舍**，
 * 不是 bug。跨重启的长期记忆属于后续阶段（P4），做法是桥接自己存一份
 * 群友印象摘要，重启后注入，而不是指望 DSH 的会话历史。
 */

import { createHash } from 'node:crypto'

/**
 * 进程内单调递增序号。
 *
 * 为什么要它：单靠毫秒时间戳**不够唯一** —— 同一毫秒内的两次调用会得到
 * 相同的值（这个缺陷是被单元测试抓出来的，实测确实发生了）。
 * 加上序号之后，"同一次进程生命周期内每次调用都不同"成为硬保证。
 */
let instanceCounter = 0

/**
 * 计算"本次进程启动"的唯一标识，参与 sessionId 的哈希。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ 这个函数改过两次，第二次是因为**真实撞名**。改之前务必读完。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 【第一版】默认值 = **当天日期**（如 `d20260925`）。
 *   当时的想法是"一天内重启保持上下文连续，跨天自动换新"。
 *   **这个想法在 SDK 这条路上是错的**，见下。
 *
 * 【真实故障】当天第二次重启桥接，每条消息都失败：
 *
 *     ⚠️ 会话标识冲突（DSH 里已存在同名会话）
 *     RPC session/prompt 失败：session "qq-579284c0cf47" already exists
 *
 * 【为什么"按天"必然撞名】
 *   DSH 的会话是**持久化到磁盘**的，而 sessionId 由「盐 + instance + 会话键」
 *   哈希而来。当天 instance 不变 → sessionId 不变 → 而磁盘上那个会话**还在**。
 *   新进程里 `getOrCreateSession` 的内存表是空的，于是走 `agents.create`，
 *   撞上磁盘上的同名会话就抛错。
 *
 *   核心矛盾：**你无法"接着用"旧会话**（SDK 没暴露 resume），
 *   所以"同一 instance 复用同一个 id"这件事，在重启后必然失败。
 *   换句话说，"一天内重启保持上下文连续"这个目标是**做不到的** ——
 *   能连续的范围只有"同一个进程的生命周期"。
 *
 * 【现在的方案】默认值 = **本进程启动时刻 + 进程内单调序号**。
 *   于是：同一进程内所有消息共用一套 sessionId（上下文连续）；
 *   重启后自然换成新的一套（不会撞名，机器人照常工作）。
 *
 * 【代价，如实说明】重启后 DSH 侧不记得之前的对话。
 *   但**长期记忆不受影响** —— 那由工作区里的 `MEMORY.md` 负责（见 memory.mjs），
 *   重启后 agent 会自己读回来。
 *
 * 想固定住某个 instance（例如你就是想让它撞名、以便观察错误）？
 * 在 config.json 的 `session.instance` 里显式写一个值即可。
 */
export function defaultInstanceTag(now = new Date()) {
  const stamp = now.getTime()
  instanceCounter += 1
  return `run${stamp}x${instanceCounter}`
}

/**
 * @param {string} kind   'private' | 'group'
 * @param {string|number} id  对方 QQ 号，或群号
 * @param {{ salt?: string, instance?: string }} [opts]
 * @returns {string} 形如 `qq-3f9a2c1b7d4e`（不含任何原始号码）
 */
export function makeSessionId(kind, id, { salt, instance } = {}) {
  if (kind !== 'private' && kind !== 'group') {
    throw new Error(`makeSessionId: kind 必须是 private 或 group，收到 ${JSON.stringify(kind)}`)
  }
  const raw = String(id ?? '').trim()
  if (!raw) throw new Error('makeSessionId: id 不能为空')

  // 盐的来源优先级：显式配置 → DSH_HOME → 固定常量。
  const resolvedSalt = salt || process.env.DSH_HOME || 'qq-bridge:stable-salt:v1'
  const tag = instance || defaultInstanceTag()

  const digest = createHash('sha256')
    .update(`${resolvedSalt}\u0000${tag}\u0000${kind}\u0000${raw}`)
    .digest('hex')
    .slice(0, 12)

  return `qq-${digest}`
}

/**
 * 判断一个字符串是不是本模块生成的 sessionId（用于启动时自检/迁移）。
 * 注意：只能判断"形状像"，无法反推是哪个 QQ 会话 —— 这正是设计目的。
 */
export function isBridgeSessionId(value) {
  return /^qq-[0-9a-f]{12}$/.test(String(value ?? ''))
}
