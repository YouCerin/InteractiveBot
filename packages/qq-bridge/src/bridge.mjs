/**
 * 桥接核心：把「QQ 里来的一条消息」变成「QQ 里出去的一句回答」。
 *
 * ── 全程只有六步（这是整个项目的心脏）──────────────────────────────────
 *
 *   ① QQ 来消息        →  OneBot 事件通道推给我们
 *   ② 唤醒判定          →  被@ / 私聊 / 命中关键词？不是就到此为止（零成本）
 *   ③ 准入校验          →  是管理员吗？（第一版只服务管理员）
 *   ④ 转成提示词        →  加身份信息、时间、平台约束
 *   ⑤ 投给 DSH          →  session/prompt 进对应会话，等 turn/end
 *   ⑥ 取回回答发出去    →  降级成纯文本 → 节流 → 发送
 *
 * 中间任何一步失败，都必须**让用户知道**（发一条错误提示），而不是静默
 * 什么都不发生 —— 历史教训是"连上了但从不回复"最难排查。
 */

import { makeSessionId, defaultInstanceTag } from './session-id.mjs'
import { decideTrigger, REASON } from './trigger.mjs'
import { renderSegments, markdownToPlain, splitForQQ } from './text.mjs'
import { computeReplyDelay, splitIntoMessages } from './humanize.mjs'
// 记忆：桥接托管（见 memory-store.mjs）。旧的 memory.mjs 仍被 mocks 引用，
// 但它那段"让模型自己去读写笔记"的指令已经**不再进入提示词**。
import {
  applyMemoryItems,
  buildMemoryInstructionsV2,
  parseMemoryMarkers,
  readMemoryForPrompt,
  takeReceipt,
  verifyAndRestoreMemory,
  writeReceipt,
} from './memory-store.mjs'
import { buildPermissionInstructions, createRoster } from './roster.mjs'
import { createInterimPicker } from './interim.mjs'
import { buildPersona } from './persona.mjs'
import { createImageInbox, collectImages } from './images.mjs'
/** 平台约束：告诉模型它现在在 QQ 里，而不是在 DSH 网页界面里。 */
const PLATFORM_RULES = [
  '你现在通过 QQ 与用户对话，不是在 DSH 的网页界面里。请遵守：',
  '1. 输出纯文本。QQ 不渲染 Markdown —— 不要写标题、表格、加粗标记。',
  '2. 不要调用需要图形界面交互的工具（例如 ask_user_question、exit_plan_mode），',
  '   它们在 QQ 通道上无人可答，会让对话卡住。需要确认时直接用文字问。',
  '3. 你的工作目录被限制在一个专用工作区里（这是权限边界，不是故障）。',
  '   越界操作会被系统自动拒绝。遇到这种情况时：',
  '   · 用你自己的话说清楚"这件事我暂时没权限做"，**不要用系统报错的原文**',
  '     （类似 "file access denied under workspace-write mode" 这种话用户看不懂）。',
  '   · 不要报路径、不要描述沙箱机制、不要说"越界""被拦截"之类的实现细节。',
  '   · 如果这件事有别的做法（比如在工作区内完成、或者让用户自己动手），',
  '     顺口提一句；没有就不提。',
  '   · 不要假装成功，也不要反复重试同一个被拒的操作。',
].join('\n')

/**
 * 判断一条 OneBot 消息事件是否由机器人自己发出。
 *
 * 抽成导出函数（而不是留在类里当私有方法）是为了**能被单元测试直接覆盖** ——
 * 这个逻辑写错的后果是静默的：过滤失效不会报错，只会表现为机器人开始
 * 跟自己无限对话，既烧钱又极难排查。
 *
 * 两个必须做对的地方：
 *   ① **类型归一化**：selfId 来自配置时是字符串，来自 get_login_info 时
 *      可能是数字；事件里的 user_id 同理。直接 `a === b` 会因类型不同
 *      恒为 false，过滤就静默失效了。
 *   ② **检查所有位置**：发送者 id 可能在 payload.user_id，也可能在
 *      payload.sender.user_id。只查一处会漏。
 *
 * @param {object} payload OneBot 事件
 * @param {string|number|null} selfId 机器人自己的 QQ 号
 */
export function isSelfAuthored(payload, selfId) {
  if (selfId == null || selfId === '') return false
  const self = String(selfId)
  const candidates = [payload?.user_id, payload?.sender?.user_id]
  return candidates.some((id) => id != null && String(id) === self)
}

export class Bridge extends EventTarget {
  /**
   * ⚠️ 私有字段必须声明在构造函数**之前**。
   * JS 的类字段按书写顺序初始化：若写在构造函数后面，构造函数的赋值会
   * 先执行、随后被字段初始化覆盖成 undefined —— 表现是"对象建好了，
   * 但内部状态是空的"，而且不一定立刻报错。这个坑我这次真踩了。
   */
  #locks = new Map()

  /**
   * 每个 QQ 会话"正在处理的那条消息"，用于实现"最新一条优先"与去重。
   * chatKey → { text, superseded }
   */
  #pending = new Map()

  /**
   * 每个 QQ 会话"最近一次真正回复出去的内容"。
   * 用于判断新消息是否与刚回复过的完全相同（那种情况直接跳过）。
   * chatKey → string
   */
  #lastDelivered = new Map()

  /**
   * 每个 QQ 会话的内存镜像：最近若干条往来消息 + 当前状态。
   *
   * ── 为什么桥接要另存一份（而不是去读 DSH 的会话）──────────────────────
   * 两个理由：
   *   ① DSH 的会话是**内部格式**（追加式事件日志），去解析它等于耦合私有实现。
   *      源项目 `dsh-adapter-qq` 就是因为 `readFileSync` 直接读 DSH 的
   *      投影缓存、用正则解析 settings.yaml，结果 DSH 一升级就静默失效。
   *   ② 这个镜像的用途很窄 —— **给同步界面看"现在各个聊天在发生什么"**，
   *      不是长期归档。所以刻意只留内存、只留最近若干条。
   *
   * 长期记忆不在这里，那是工作区里 MEMORY.md 的事（见 memory.mjs）。
   *
   * chatKey → { kind, peerId, status, updatedAt, messages: [{role,text,at}] }
   */
  #conversations = new Map()

  /** 正在收尾中（收尾期间要跳过剩余拟人延迟，尽快把在途回复发出去）。 */
  #closing = false
  /** 所有正在睡的 `#sleepUnlessClosing`，收尾时叫醒它们。 */
  #sleepers = new Set()
  /** 在途的发送流程（收尾时要等它们结束）。 */
  #inFlight = new Set()
  /**
   * 上次清理 inbox 的时间。
   *
   * 为什么需要它：清理要 `readdirSync` + 逐个 `statSync`，每条带图的
   * 消息都跑一遍是浪费。收图本来就是低频事件，加个时间闸就够了 ——
   * 这比开一个定时器好：桥接可能长时间空闲，定时器只是白耗电。
   */
  #lastImagePrune = 0

  /**
   * @param {object} opts
   * @param {import('./sdk-rpc.mjs').SdkRpcClient} opts.rpc
   * @param {import('./onebot.mjs').OneBotClient} opts.onebot
   * @param {import('./onebot.mjs').SendQueue} opts.sendQueue
   * @param {import('./session-bridge.mjs').SessionRouter} opts.router
   * @param {object} opts.config
   */
  constructor({ rpc, onebot, sendQueue, router, config, usageLedger = null, roster = null, interimPicker = null, imageInbox = null, log = () => {} }) {
    super()
    this.rpc = rpc
    this.onebot = onebot
    this.sendQueue = sendQueue
    this.router = router
    this.config = config
    // 用量账本（可选）。不传就是"不记账"，机器人照常工作 ——
    // 记账是附加功能，不能成为回话的前置条件。
    this.usageLedger = usageLedger
    // 名单与权限分级（谁能私聊、哪个群能用、谁能"动手"）。
    // 不传时退化成"只认管理员"的最小实现，保证旧调用方与测试仍能用。
    this.roster = roster ?? createRoster({ config, log })
    // 「先应一声」的挑选器（带冷却去重）。不传就按配置现造一个。
    this.interimPicker =
      interimPicker ??
      createInterimPicker({
        messages: config?.humanize?.interim?.messages,
        historyFile: config?.humanize?.interim?.historyFile ?? null,
        cooldownMs: config?.humanize?.interim?.cooldownMs,
        keepRecent: config?.humanize?.interim?.keepRecent,
      })
    this.log = log

    // 图片暂存区（`<工作区>/inbox/`）。
    //
    // 不传时按工作区现造一个；**没有工作区就为 null**，此时看图功能
    // 自动降级成"只写 [图片]"（等于改之前的行为），绝不会因此崩溃。
    // 这样旧调用方和测试不传它也能照常工作。
    this.imageInbox =
      imageInbox ??
      (config?.dsh?.workspace && config?.image?.enabled !== false
        ? createImageInbox({ workspace: config.dsh.workspace, log: (m) => this.log(m) })
        : null)

    // 人设文本在构造时算一次并缓存 —— 它每轮都要用，而且内容不变。
    // 配置里写错预设名时会抛错：这里刻意**不吞异常**，因为"人设静默失效"
    // 会让人以为是自己写的人设没效果，排查方向完全跑偏。
    // （启动阶段的 validateConfig 会先做一次 lint，所以正常情况不会走到抛错。）
    try {
      this.personaText = buildPersona({
        preset: config.persona?.preset,
        custom: config.persona?.custom,
      })
    } catch (error) {
      this.log(`⚠️ 人设配置有问题，已退回不使用人设：${error.message}`)
      this.personaText = ''
    }

    // ★ 会话 instance **在构造时算一次**，本次进程生命周期内固定不变。
    //
    // ⚠️ 这里必须"一次"，不能每次生成 sessionId 时再算 —— 否则同一次运行内
    // **每条消息都会换一个新 sessionId**，机器人会**每条消息都失忆**。
    // 这个错误是被单元测试抓出来的（全链路测试发现"第二轮认不出第 2 轮"）。
    //
    // 语义回顾（详见 session-id.mjs）：
    //   · 本次进程内 → 同一个 QQ 会话始终映射同一个 sessionId（上下文连续）
    //   · 重启之后    → 换一整套新 id（避免撞上磁盘上的旧会话）
    this.sessionInstance =
      config.session?.instance || defaultInstanceTag()
    this.log(`   本次运行的会话标识前缀：${this.sessionInstance}`)

    // ── 把 DSH 的事件流接到会话路由器上 ──────────────────────────────────
    // 这一行是整个桥接的"血管"：没有它，回合永远等不到 turn/end，
    // 每条消息都会以超时告终（历史上就是漏了这一步，表现成"连上了但
    // 从不回复"，而且日志里只有一行超时，极难定位）。
    //
    // 只接 session.event：session.status / subagent.* 对回复没影响，
    // 接了反而要多写一堆分支。
    rpc.addEventListener('notification', (e) => {
      const { method, params } = e.detail
      if (method !== 'session.event') return
      const sessionId = params?.sessionId
      if (!sessionId || !params?.event) return
      this.router.handleEvent(sessionId, params.event)
    })

    // 子进程意外退出时，明确告诉用户"它挂了"，不要让消息石沉大海
    rpc.addEventListener('exit', () => {
      this.log('⚠️ DSH 子进程已退出，后续消息将无法处理')
    })

    this.stats = {
      received: 0,
      triggered: 0,
      answered: 0,
      skipped: 0,
      denied: 0,
      failed: 0,
    }
  }

  /**
   * 把一个回合的真实用量写进账本。
   *
   * ★ 这个方法**绝不抛错**。
   *   记账是附加功能，而"回话"是主要职能 —— 账本写不进去（磁盘满、
   *   权限问题、文件被占用）**不能**导致机器人不回消息。
   *
   * ★ 口径：`result.usage` 里的 `input`/`cacheRead`/`output` 已经是
   *   **逐步累加**过的（见 session-bridge.mjs 的 `#accumulateUsage`），
   *   而 `lastContextTokens` 是最后一步的上下文快照（**不可累加**）。
   */
  #recordUsage({ kind, peerId, result }) {
    if (!this.usageLedger) return
    try {
      const u = result?.usage
      // `steps` 存在且 ≥1 才说明真的收到了用量
      //（TurnCollector 初始化为 `{}`，所以不能只看 `u` 是否为真）
      if (!u || !u.steps) return
      this.usageLedger.record({
        at: new Date(result.endedAt ?? Date.now()),
        chatKey: `${kind}:${peerId}`,
        kind,
        label: kind === 'group' ? `群 ${peerId}` : `私聊 ${peerId}`,
        route: u.route ?? null,
        tokens: {
          input: u.input,
          cacheRead: u.cacheRead,
          cacheWrite: u.cacheWrite,
          output: u.output,
          reasoning: u.reasoning,
        },
        lastContextTokens: u.lastContextTokens,
      })
    } catch (error) {
      this.log(`⚠️ 用量记账失败（不影响回复）：${error?.message ?? error}`)
    }
  }

  /** 挂到 OneBot 上：事件通道一有消息就进来。 */
  attach(onebot = this.onebot) {
    onebot.addEventListener('event', (e) => {
      this.handleEvent(e.detail).catch((error) => {
        this.log(`[bridge] 处理事件时未捕获错误：${error?.stack ?? error}`)
      })
    })
    return this
  }

  /** 处理一条 OneBot 事件。返回结果对象（便于测试断言）。 */
  async handleEvent(payload) {
    if (!payload || payload.post_type !== 'message') {
      return { handled: false, reason: 'not-a-message' }
    }

    // ── 忽略自己发的消息（防自环）────────────────────────────────────────
    // 如果协议端上报了机器人自己的消息而我们没滤掉，就会形成
    // "它回一句 → 收到自己那句 → 再回一句" 的无限对话，既烧钱又极其异常。
    //
    // ⚠️ 两个必须做对的地方（都踩过）：
    //   ① **类型**：selfId 来自配置是字符串，而事件里的 user_id 可能是数字。
    //      直接 `a === b` 会因类型不同而恒为 false —— 过滤静默失效。
    //      所以两边都 String() 归一化。
    //   ② **位置**：发送者 id 可能出现在 payload.user_id，也可能在
    //      payload.sender.user_id。只查一处会漏。
    if (this.#isSelfAuthored(payload)) {
      this.log(`[bridge] 忽略自己发的消息（user_id=${payload.user_id}）`)
      return { handled: false, reason: 'self' }
    }

    const kind = payload.message_type === 'private' ? 'private' : 'group'

    // ⚠️ 这里**曾经**有一条硬编码的早退：`if (kind !== 'private') return`
    //    （第一版只服务管理员私聊）。现在改由 `decideTrigger` 里的
    //    `groupEnabled` 开关统一决定 —— 好处是"关掉群聊"和"开着但没被唤醒"
    //    走同一条判定路径，**不会再出现"配置说开着、代码里其实关着"**那种
    //    自相矛盾（那个矛盾确实存在过一阵子，配置自检里现在也有一条警告盯着它）。
    //
    //    群聊只有两种唤醒方式：**被 @** 或 **命中关键词**（见 trigger.mjs）。

    this.stats.received += 1

    // ★ 两个 id 不能混为一谈（群聊里它们是不同的东西）：
    //   · `senderId` = **发消息的人**（来自 `user_id`）→ 只用于**准入判定**
    //   · `peerId`   = **消息发往哪里**（私聊=对方 QQ 号；群聊=**群号**）
    //                  → 用于会话键、记忆文件、回复目标
    //
    // 这一条写错过的后果很隐蔽：群聊里按 `user_id` 建会话，等于**给每个群成员
    // 各开一份记忆**、而且回复会发给"发消息的那个人"而不是发到群里
    // （那个人会收到一条莫名其妙的私聊）。实测修的就是这个。
    const senderId = String(payload.user_id ?? payload.sender?.user_id ?? '')
    const peerId =
      kind === 'group' ? String(payload.group_id ?? '') : String(payload.user_id ?? '')

    if (!peerId) {
      // 群聊事件却没有 group_id —— 协议端行为异常。不猜、不处理，但要记下来。
      this.log(`[bridge] ⚠️ 收到了没有 group_id 的群消息，已忽略：${JSON.stringify(payload).slice(0, 200)}`)
      this.stats.skipped += 1
      return { handled: false, reason: 'no-peer-id' }
    }

    const rendered = renderSegments(payload.message, { selfId: this.onebot.selfId })

    // 记进内存镜像（给同步界面看"各个聊天在发生什么"）。
    // 放在最前面：使用者发了什么，界面上应立刻能看到 —— 即使后面判定不回复。
    const mirrorKey = `${kind}:${peerId}`
    this.#mirror(mirrorKey, 'user', rendered.text, { kind, peerId })

    // ② 唤醒判定
    const decision = decideTrigger({
      kind,
      text: rendered.text,
      mentioned: rendered.mentioned,
      raw: typeof payload.raw_message === 'string' ? payload.raw_message : '',
      selfId: this.onebot.selfId,
      keywords: this.config.trigger.keywords,
      switches: this.config.trigger,
    })
    if (!decision.respond) {
      this.stats.skipped += 1
      // 记下"为什么没回" —— 群聊开了以后，这一条是排查"它怎么不理我"的关键。
      // 只在群聊里记，免得私聊那种"关了开关"的情况把日志刷满。
      if (kind === 'group') {
        this.log(`[bridge] 群 ${peerId} 未唤醒（${decision.reason}）：未 @ 且未命中关键词`)
      }
      return { handled: false, reason: decision.reason === 'group-disabled' ? 'group-disabled' : 'no-trigger' }
    }
    this.stats.triggered += 1

    // ③ 准入校验（名单 + 权限分级）
    //
    // 与"唤醒判定"是**两件事**，刻意分开：
    //   · 唤醒判定回答"这条消息在叫它吗"（@ / 关键词 / 私聊）
    //   · 准入校验回答"这个人/这个群有资格吗，以什么权限"
    // 分开的好处：日志里能一眼看出"是被无视了还是被拒了"。
    const verdict = this.roster.decide({ kind, peerId, senderId })
    if (!verdict.respond) {
      this.stats.denied += 1
      this.log(`[bridge] 拒绝 ${kind}:${peerId}（来自 ${senderId}）：${verdict.reason}`)
      // 私聊里明确告知"只对名单内的人开放"；群里**不回** ——
      // 在群里喊一句"你不是管理员"既刷屏又暴露了机器人有权限这回事。
      if (kind === 'private') {
        await this.#safeSend(kind, peerId, '抱歉，这个机器人只对名单内的人开放。')
      }
      return { handled: false, reason: verdict.reason, peerId, senderId }
    }

    // ④⑤⑥ 串行执行（带上权限等级，提示词据此决定能不能"动手"）
    return this.#runTurn({
      kind,
      peerId,
      senderId,
      tier: verdict.tier,
      rendered,
      // ★ 只把**纯数据**的图片引用传下去，**不在这里下载**。
      //   提取是零成本的（纯解析）；下载必须等 `#runTurn` 里确认要回复之后
      //   才做 —— 否则"群里没被 @ 的消息"也会去发网络请求（见 #collectImages）。
      imageRefs: rendered.imageRefs ?? [],
      reason: decision.reason,
    })
  }

  /**
   * 判断一条消息是不是机器人自己发的。
   *
   * 为什么要单独一个方法：这段逻辑有两个容易写错的地方（见 handleEvent 的注释），
   * 而且**写错的后果是静默的** —— 过滤失效不会有任何报错，只会表现为
   * 机器人开始跟自己聊天。所以这里显式归一化类型、并检查所有可能的位置。
   */
  #isSelfAuthored(payload) {
    return isSelfAuthored(payload, this.onebot.selfId)
  }

  /** 每个 QQ 会话保留的最近消息条数上限（内存镜像，不是归档）。 */
  static MAX_MIRROR_MESSAGES = 50

  /**
   * 往内存镜像里追加一条消息。
   *
   * ⚠️ **任何情况下都不允许抛出**。理由：镜像只是给 UI 看的辅助数据，
   * 而它被调用的位置全都在真实的消息发送路径上 —— 如果这里抛了，
   * 会连带把"给用户回消息"这件事搞失败。辅助功能绝不能拖垮主功能。
   *
   * @param {string} chatKey
   * @param {'user'|'bot'|'notice'} role
   * @param {string} text
   * @param {{ kind?: string, peerId?: string, createIfMissing?: boolean }} [who]
   */
  #mirror(chatKey, role, text, who = {}) {
    try {
      let conv = this.#conversations.get(chatKey)
      if (!conv) {
        // 默认只在"用户主动发来消息"时创建会话条目；
        // 免得自动回复之类的被动内容凭空造出一个不存在的会话。
        if (who.createIfMissing === false) return
        const [k, id] = String(chatKey).split(':')
        conv = {
          kind: who.kind ?? k,
          peerId: who.peerId ?? id,
          status: 'idle',
          updatedAt: Date.now(),
          messages: [],
        }
        this.#conversations.set(chatKey, conv)
      }
      conv.messages.push({ role, text: String(text ?? ''), at: Date.now() })
      // 只留最近 N 条：这是镜像不是归档，无上限会变成内存泄漏
      if (conv.messages.length > Bridge.MAX_MIRROR_MESSAGES) {
        conv.messages.splice(0, conv.messages.length - Bridge.MAX_MIRROR_MESSAGES)
      }
      conv.updatedAt = Date.now()
    } catch (error) {
      this.log(`[bridge] ⚠️ 会话镜像写入失败（不影响消息收发）：${error?.message ?? error}`)
    }
  }

  /**
   * 把这一轮的**思考过程**记进镜像。
   *
   * 为什么单独记而不是混进 `bot` 消息里：界面上要把它显示成**独立的可折叠块**
   * （像网页版那样"思考中…"），而不是和回复正文搅在一起。
   * 它也**不会**被发到 QQ —— QQ 通道发出去的只有正文。
   *
   * 写入失败一律吞掉：这是辅助数据，不能拖垮发消息。
   */
  #mirrorThinking(chatKey, thinking, who = {}) {
    try {
      const text = String(thinking ?? '').trim()
      if (!text) return
      let conv = this.#conversations.get(chatKey)
      if (!conv) {
        const [k, id] = String(chatKey).split(':')
        conv = {
          kind: who.kind ?? k,
          peerId: who.peerId ?? id,
          status: 'idle',
          updatedAt: Date.now(),
          messages: [],
        }
        this.#conversations.set(chatKey, conv)
      }
      conv.messages.push({ role: 'thinking', text, at: Date.now() })
      if (conv.messages.length > Bridge.MAX_MIRROR_MESSAGES) {
        conv.messages.splice(0, conv.messages.length - Bridge.MAX_MIRROR_MESSAGES)
      }
      conv.updatedAt = Date.now()
    } catch (error) {
      this.log(`[bridge] ⚠️ 思考过程写入镜像失败（不影响消息收发）：${error?.message ?? error}`)
    }
  }

  /** 更新某个会话的状态（供界面显示"正在处理/已作废"等）。同样不允许抛出。 */
  #setStatus(chatKey, status) {
    try {
      const conv = this.#conversations.get(chatKey)
      if (conv) {
        conv.status = status
        conv.updatedAt = Date.now()
      }
    } catch {
      /* 辅助数据，静默忽略 */
    }
  }

  /**
   * 给 UI 用的会话快照。
   *
   * 返回的是**深拷贝** —— 否则调用方（HTTP 接口）在序列化过程中，
   * 桥接还在往里追加消息，会读到半截状态或出现结构不一致。
   *
   * @returns {Array<object>} 按最近活动时间倒序
   */
  listConversations() {
    return [...this.#conversations.entries()]
      .map(([chatKey, conv]) => ({
        chatKey,
        kind: conv.kind,
        peerId: conv.peerId,
        status: conv.status,
        updatedAt: conv.updatedAt,
        messageCount: conv.messages.length,
        messages: conv.messages.map((m) => ({ ...m })),
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 串行锁：同一会话的回合一个接一个，避免上下文互相踩。 */
  async #withLock(key, fn) {
    const previous = this.#locks.get(key) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => (release = resolve))
    this.#locks.set(
      key,
      previous.then(() => gate),
    )
    await previous
    try {
      return await fn()
    } finally {
      release()
      // 若后面没有排队者，清掉这张表的条目，避免无限增长
      if (this.#locks.get(key) === gate) this.#locks.delete(key)
    }
  }

  async #runTurn({ kind, peerId, senderId, tier, rendered, reason, imageRefs = [] }) {
    const chatKey = `${kind}:${peerId}`
    // instance 用**构造时固定的那个**（this.sessionInstance），不是每次新生成。
    // 用 `??` 而不是 `||` 是为了兼容测试里直接构造 Bridge 时没设它的情形。
    const sessionId = makeSessionId(kind, peerId, {
      salt: this.config.session?.salt,
      instance: this.sessionInstance ?? this.config.session?.instance,
    })

    // ══════════════════════════════════════════════════════════════════════
    // 「最新一条优先」+「内容相同只回第一条」
    // ══════════════════════════════════════════════════════════════════════
    //
    // ── 为什么需要（真实反馈）────────────────────────────────────────────
    // 用户问一句要联网搜索的问题，回合跑了 40 秒；他等不及又发了一条。
    // 旧行为：第二条排队等第一条跑完 —— 而第一条其实是"过期问题"，
    // 回答它纯属浪费，回复发出去还会让人莫名其妙。
    //
    // ── 能做什么、做不到什么（必须如实说明）──────────────────────────────
    // 确认过 DSH 的 SDK 只暴露 initialize / session/prompt / shutdown，
    // **没有 cancel/abort/steer**；而 `session/prompt` 内部是
    // `agent.followup(message)`（追加到推进队列，不打断当前回合）。
    //
    // 所以：**正在执行的那一轮无法中止，它会把 token 烧完**。
    // 我们能做的是"**不再等它、也不再为它发回复**" —— 收到更新的消息后，
    // 立刻停止等待旧回合，转去处理新消息。对使用者而言效果是对的
    // （他只关心最新那条的答复），但**成本上省不掉那一轮**。这个边界
    // 不能含糊过去。
    //
    // ── 内容相同的情况 ───────────────────────────────────────────────────
    // 如果新消息与"正在处理的那条"或"刚回复过的那条"**完全相同**，
    // 就当作重复发送，直接不回（正在跑的那条本身就会给出答案）。
    const prior = this.#pending.get(chatKey) ?? null
    const normalized = String(rendered.text ?? '').trim()

    if (prior) {
      const sameAsInFlight = prior.text === normalized
      const sameAsLastReplied = this.#lastDelivered.get(chatKey) === normalized
      if (sameAsInFlight || sameAsLastReplied) {
        this.log(
          `[bridge] 跳过重复内容（与${sameAsInFlight ? '正在处理的' : '刚回复过的'}那条相同）：` +
            normalized.slice(0, 30),
        )
        return { handled: false, reason: 'duplicate' }
      }
      // 不同内容 → 让旧回合"作废"：仍在跑，但不再等它、也不再发它的回复
      prior.superseded = true
      this.log(`[bridge] 收到更新的消息，旧回合作废（它仍会跑完，但不再等它）`)
    }

    const token = { text: normalized, superseded: false }
    this.#pending.set(chatKey, token)

    return this.#withLock(chatKey, async () => {
      // 无论从哪条路径返回，都要清掉"正在处理的那条"标记 ——
      // 否则下一次消息会被误判成"重复"而永远不回。
      const settle = () => {
        if (this.#pending.get(chatKey) === token) this.#pending.delete(chatKey)
      }

      // 登记这个 sessionId 属于哪个 QQ 会话（用于事件路由 + 未知会话丢弃）
      this.router.bind(sessionId, { kind, peerId, chatKey })

      const collector = this.router.beginTurn(sessionId, {
        label: chatKey,
        timeoutMs: this.config.turn?.timeoutMs ?? 10 * 60_000,
      })

      // ── 长任务期间的"先应一声" ───────────────────────────────────────────
      //
      // ── 为什么要这个（真实反馈）────────────────────────────────────────
      // 实测有一轮花了 **40.8 秒、20 次工具调用**（联网搜索）。这期间桥接
      // 一声不响 —— 因为原实现是「投递 → 等回合完全结束 → 才发第一条消息」。
      // 使用者看不到任何动静，会以为机器人坏了，甚至重复发消息。
      //
      // ── 措辞上的一条硬规矩：必须诚实 ────────────────────────────────────
      // 不能写死"我在网上搜一下" —— 它那时也可能在读文件、跑命令。
      // 说"搜索"而实际没搜，就是在骗使用者。所以按**这一轮实际发生的事**
      // 分成四类挑措辞：思考 / 搜索 / 调用工具 / 权限受阻（见 src/interim.mjs）。
      const interim = this.config.humanize?.interim ?? {}
      let interimTimer = null
      if (interim.enabled !== false) {
        interimTimer = setTimeout(() => {
          const text = this.interimPicker.pick(collector)
          if (!text) return
          this.log(`[bridge] 回合仍在进行，先发一条：${text}`)
          // 用 safeSend：这条只是"应一声"，发失败不该影响主流程。
          // 也**不走拟人延迟** —— 它的价值就在于"立刻让使用者知道没坏"。
          // （safeSend 内部会把它记进会话镜像，并标成 notice 类。）
          this.#safeSend(kind, peerId, text).catch(() => {})
        }, interim.afterMs ?? 8000)
        if (typeof interimTimer.unref === 'function') interimTimer.unref()
      }
      const clearInterim = () => {
        if (interimTimer) clearTimeout(interimTimer)
        interimTimer = null
      }

      // ── 看图：把这条消息里的图片取进工作区 ───────────────────────────────
      //
      // ★ 位置很讲究：放在**准入之后**。
      //
      //   如果放在消息一进来（renderSegments 那里）就下载，那么"群里没被 @
      //   的消息"也会去下载图片 —— 那等于开了一个白送的入口：任何人在群里
      //   连发图片就能让机器人不停发网络请求、不停往磁盘写。而我们一开始
      //   就定下"不唤醒 = 零成本"，所以取图必须发生在**确认要回复之后**。
      const imagePlan = await this.#collectImages(imageRefs, { kind, peerId })

      try {
        const blocks = [
          {
            type: 'text',
            text: await this.#buildPrompt(rendered, reason, {
              kind,
              peerId,
              senderId,
              tier,
              images: imagePlan,
            }),
          },
        ]
        // auto 模式：把图片本身也附上，模型不用再调 read_image 就能看见。
        //
        // 只加 `{type:'image', data:<canonical base64>, mimeType}` —— 这正是
        // `dsh-sdk-jsonrpc-server` 的 durablePromptContent 认的形状
        // （它会用 admitEncodedImages 存进附件库，再换成 durable 引用）。
        // base64 用 Buffer.toString 生成，天然是规范形式（无换行、有填充）。
        for (const img of imagePlan) {
          if (img.ok && img.base64) {
            blocks.push({ type: 'image', data: img.base64, mimeType: img.mediaType })
          }
        }
        await this.rpc.prompt(sessionId, blocks)
      } catch (error) {
        clearInterim()
        settle()
        this.router.clear(sessionId)
        collector.abort('prompt-failed')
        this.stats.failed += 1
        this.log(`[bridge] 投递失败：${error.message}`)
        // 把"会话已存在"翻译成人话。
        //
        // ── 这条提示改过一版，原因值得记下来 ──────────────────────────────
        // 第一版说"这通常意味着 session.instance 机制失效了，请把它改成
        // 任意新值后重启"。**这个建议是误导的**：真正的原因往往是
        // 「instance 默认值不够唯一」（例如曾经用"当天日期"，当天重启必撞），
        // 而不是"机制失效"。照那句话改 config 是治不好的 ——
        // 用户改了值、重启、又撞，只会更困惑。
        //
        // 正确做法分两种情况：
        //   · session.instance 留空 → 应该每次启动都唯一，**不该出现这个错误**。
        //     出现了就是 bug，应当如实告知并指向代码，而不是让用户去改配置。
        //   · session.instance 显式写了 → 那是用户自己选的固定值，
        //     重启必然撞名；此时"改一个值"确实是正确解法。
        const explicitInstance = Boolean(this.config.session?.instance)
        const friendly = /already exists/i.test(error.message)
          ? explicitInstance
            ? '会话标识冲突：你在 config.json 里显式写死了 session.instance，' +
              '所以每次重启都会用同一个会话号，而 DSH 不允许复用已存在的会话。' +
              '把它清空（留空 = 每次启动自动换新）或改成新值，然后重启。'
            : '会话标识冲突：这不该发生（session.instance 留空时本应每次启动都唯一）。' +
              '请把这条日志连同时间反馈给维护者 —— 这是程序缺陷，不是配置问题。'
          : `没能把消息交给 DSH：${error.message}`
        await this.#safeSend(kind, peerId, `⚠️ ${friendly}`)
        return { handled: false, reason: 'prompt-failed', error: error.message }
      }

      const result = await collector.finished()
      clearInterim()
      this.router.clear(sessionId)

      // ── 记账：**必须在任何提前 return 之前**做 ──────────────────────────
      // 作废的回合、超时的回合同样烧掉了 token（SDK 无法中止，钱收不回来），
      // 所以不能只在"成功回复"那条路径上记。少记一笔不会报错，
      // 但账会偏小 —— 而账偏小会让人以为很省，那是更坏的方向。
      this.#recordUsage({ kind, peerId, result })

      // ── 已被更新的消息取代：不发回复，也不发超时提示 ────────────────────
      // 这一轮**已经烧掉的 token 收不回来**（SDK 无法中止），但没必要再把
      // 一个"过期问题的答案"发出去 —— 那只会让人莫名其妙，而且下一条消息
      // 正在等着处理。对使用者而言效果是"只回了最新那条"。
      if (token.superseded) {
        settle()
        this.log(`[bridge] 旧回合已作废，不发送回复（${result.durationMs}ms）`)
        return { handled: false, reason: 'superseded', result }
      }

      if (result.timedOut || result.aborted) {
        settle()
        this.stats.failed += 1
        this.log(`[bridge] 回合未正常结束：${result.timedOut ? '超时' : result.abortReason}`)
        await this.#safeSend(kind, peerId, '⚠️ 这次处理超时了，请再发一次。')
        return { handled: false, reason: result.timedOut ? 'timeout' : 'aborted', result }
      }

      // 越界被拒的痕迹要主动告诉用户（这是"权限只限工作区"的可见证据）
      const denied = result.approvals.filter((a) => a.outcome === 'unavailable')
      if (denied.length > 0) {
        this.log(
          `[bridge] 本轮有 ${denied.length} 个操作因越界被自动拒绝：` +
            denied.map((d) => d.toolName).join(', '),
        )
      }

      let answer = markdownToPlain(result.text)

      // ── 记忆标记：剥离 + 落盘（★ 这一步是"写入权归桥接"的落点）────────
      //
      // 模型在回复里写的 `<<<MEMORY …>>>` 行：
      //   ① 从发给 QQ 的正文里**剥掉**（绝不能把标记发给对方）；
      //   ② 交桥接按发起人身份与来源校验后落盘；
      //   ③ 结果写成"回执"，下一轮作为提示词的一部分告诉模型到底记上没有。
      // 注意顺序：先剥离再判断"回复是否为空" —— 否则一条"只说了要记东西"
      // 的回复会被判成空，然后发出兜底话术，看起来像机器人抽风。
      if (this.config.memory?.enabled !== false && this.config.dsh?.workspace) {
        const parsed = parseMemoryMarkers(answer)
        answer = parsed.clean
        if (parsed.items.length > 0) {
          const outcome = applyMemoryItems({
            workspace: this.config.dsh.workspace,
            kind,
            peerId,
            senderId,
            tier,
            items: parsed.items,
            log: this.log,
          })
          writeReceipt({
            workspace: this.config.dsh.workspace,
            kind,
            peerId,
            applied: outcome.applied,
            ignored: outcome.ignored,
          })
        }
      }

      // ★ 把思考过程记进镜像（**只给界面看，不发到 QQ**）。
      //   放在"兜底回复"之前：即使这一轮模型一个字都没说，它的思考过程
      //   对使用者仍有价值（能看出它到底干了什么、卡在哪）。
      this.#mirrorThinking(chatKey, result.thinking, { kind, peerId })

      if (!answer) {
        // 规则是"必须回答"。如果模型什么都没说（比如只调了工具就结束），
        // 不能让用户对着空气等 —— 给一个明确的兜底。
        answer =
          result.toolCalls.length > 0
            ? '（我执行了操作但没有输出文字，请再问一次或换个说法。）'
            : '（这次没有产生回复内容，请再试一次。）'
        this.log(`[bridge] 回合结束但无文本输出；事件序列：${result.eventTypes.join(' → ')}`)
      }

      // 登记进 in-flight：收尾时要等它发完，否则延迟中的回复会被掐死
      const delivering = this.#deliver(kind, peerId, answer, result)
      this.#inFlight.add(delivering)
      try {
        await delivering
      } finally {
        this.#inFlight.delete(delivering)
      }
      // 记下"刚回复过的内容"，供去重判断（下一次内容完全相同时直接跳过）
      this.#lastDelivered.set(chatKey, normalized)
      settle()
      this.stats.answered += 1
      this.dispatchEvent(new CustomEvent('answered', { detail: { chatKey, result } }))
      return { handled: true, reason: 'answered', answer, result }
    })
  }

  async #buildPrompt(rendered, reason, { kind, peerId, senderId, tier, images = [] } = {}) {
    const now = new Date()
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`

    // ★ 来源标注必须如实区分私聊与群聊。
    //   原先这里写死"来自 QQ 私聊" —— 群聊打开后那就是**错的上下文**，
    //   模型会以为自己在一对一对话里，于是用私聊口吻回群里。
    // ★★ 发言人身份标注**必须按真实权限等级**，绝不能写死"管理员"。
    //
    // 这里原来是一段写死的 `who`：只要配了 callerName 就标"（…，管理员）"，
    // 否则一律标"（管理员）" —— 也就是说**每个在群里说话的人都被标注成管理员**。
    // 后果有两层，第二层更严重：
    //
    //   ① 模型会照着这行字把说话人当成管理员，于是把他写进记忆
    //      （实测就是这样：群里一个普通用户被记成"管理员，会来更正记录"，
    //        见 workspace-qq/memory/group-*.md）；
    //   ② 这一行是**系统侧的可信信息**，和真正的权限段（roster 按 adminUsers 判定）
    //      自相矛盾。模型看到的两个来源打架时，它更信"贴在人身上的标签"，
    //      于是可能因此答应本该拒绝的请求 —— 也就是把权限判定从代码层
    //      泄漏成了提示词层的猜测。
    //
    // 所以：管理员才标"管理员"，普通用户标"普通用户"。措辞与
    // buildPermissionInstructions 保持一致（那里用的是「普通用户（只读）」）。
    const isAdminTier = tier === 'admin'
    const who = isAdminTier
      ? this.config.persona?.callerName && reason === REASON.PRIVATE
        ? `（${this.config.persona.callerName}，管理员）`
        : '（管理员）'
      : '（普通用户，只读）'
    const origin =
      kind === 'group'
        ? `[来自 QQ 群 ${peerId}，发言人 ${senderId ?? '?'}${who}  ${stamp}]`
        : `[来自 QQ 私聊 ${who}  ${stamp}]`

    const lines = [PLATFORM_RULES]

    // ── 人设 ────────────────────────────────────────────────────────────
    // 为什么放在平台规则**之后**：平台约束（纯文本输出、别调交互卡、
    // 越界会被拒）是硬规矩，必须先说，不能被几千字的语气描述淹没。
    //
    // 为什么放在记忆约定**之前**：人设是"你是谁"，记忆是"你记得什么"，
    // 顺序上先身份后记忆更自然。
    const persona = this.personaText
    if (persona) lines.push('', persona)

    // ── 权限等级（决定它能不能"动手"）────────────────────────────────────
    // 放在人设**之后**：先说明"你是谁"，再说"你能做什么"。
    // 管理员与普通用户拿到的是**不同**的段落 —— 普通用户那一段会明确
    // 列出被禁的动作类别（只写"不能修改"太抽象，模型会理解成"尽量别改"）。
    lines.push('', buildPermissionInstructions(tier, kind))

    // ── 记忆（**写入权在桥接，不在模型**）────────────────────────────────
    // 关掉它只是少一段指令与一段召回，不会破坏任何机制 —— 但如果关掉，
    // 机器人重启后就真的什么都不记得了。
    //
    // ★ 这一段**不含任何文件路径**（旧版把路径写进来了）。两个理由：
    //   ① 写入由桥接做，模型不需要路径；
    //   ② 路径随会话变化，写进提示词就会破坏 DeepSeek 的前缀缓存 ——
    //      实测本项目缓存命中率 91%~96%，往固定前缀里塞多变内容等于
    //      把最便宜的那部分 token 变成最贵的。
    if (this.config.memory?.enabled !== false && this.config.dsh?.workspace) {
      const workspace = this.config.dsh.workspace
      // ★ 先查篡改：模型手里仍有 write 工具，可以绕过标记直接改记忆文件。
      //   提示词里那句"不要用文件工具写记忆"只是请求；这里才是保证 ——
      //   发现与快照不一致就回滚（详见 memory-store.mjs 的说明）。
      verifyAndRestoreMemory({ workspace, log: this.log })
      const recall = readMemoryForPrompt({ workspace, kind, peerId })
      // 回执是"上一条消息里的记忆到底记上没有"——读后即删，只出现一次
      const receipt = takeReceipt({ workspace, kind, peerId })
      lines.push('', buildMemoryInstructionsV2({ kind, recall, receipt }))
    }

    lines.push('', origin, rendered.text)

    // ── 图片 ────────────────────────────────────────────────────────────
    //
    // 改之前这里写的是「这条消息里含 N 张图片，当前通道未启用看图能力」——
    // 而事实上**能力一直都在**（模型支持图片输入、SDK 收图片块、附件库已挂载、
    // read_image 工具存在），只是桥接把图片地址丢了（见 text.mjs 与 images.mjs）。
    // 所以这段现在要如实说"图在哪、怎么看"。
    const gotImages = images.filter((x) => x.ok)
    const lostImages = images.filter((x) => !x.ok)
    const skipped = Math.max(0, (rendered.images ?? 0) - images.length)

    if (gotImages.length > 0) {
      if (this.config.image?.mode === 'auto') {
        lines.push(`（这条消息里的 ${gotImages.length} 张图片**已直接附在这条消息上**，你可以直接看。）`)
      } else {
        lines.push(
          `（这条消息里含 ${gotImages.length} 张图片，已存到工作区：` +
            `${gotImages.map((x) => x.relPath).join('、')}。）`,
        )
        // 这条提醒是**成本控制**，不是客套：读图会花 vision token，
        // 而 QQ 里很多图（表情包）根本不值得读。
        lines.push('（需要看内容时用 read_image 读对应文件；确定用不上就别读 —— 读图是要花 token 的。）')
      }
    }
    if (lostImages.length > 0) {
      lines.push(
        `（有 ${lostImages.length} 张图片没能取到：${lostImages.map((x) => x.reason).join('；')}。）`,
      )
    }
    if (skipped > 0) {
      lines.push(`（另有 ${skipped} 张图片超出本条消息的处理上限，未处理。）`)
    }
    return lines.join('\n')
  }

  /**
   * 把这条消息里的图片取进工作区。
   *
   * ── 两条硬要求 ─────────────────────────────────────────────────────────
   *   ① **绝不抛异常**。收图是"锦上添花"，一张图下载失败不能导致整轮不回复
   *      —— 那会变成"发张图机器人就不理我了"这种最难查的故障。
   *   ② **绝不阻塞太久**。每张图都有独立超时，且张数有上限（`image.maxCount`）。
   *
   * @returns {Promise<Array>} 每张图的结果（ok / relPath / mediaType / bytes /
   *          base64（仅 auto）/ reason）
   */
  async #collectImages(refs, { kind, peerId }) {
    const cfg = this.config.image ?? {}
    if (cfg.enabled === false || !this.imageInbox) return []
    if (!Array.isArray(refs) || refs.length === 0) return []

    try {
      const plan = await collectImages({
        refs,
        inbox: this.imageInbox,
        // 传的是"函数"而不是 onebot 实例：images.mjs 只需要能发一个
        // get_image 动作，这样单测可以直接注入假的 call，不必造一个客户端。
        call: (action, params) => this.onebot.call(action, params),
        maxCount: cfg.maxCount,
        withBase64: cfg.mode === 'auto',
        fetchOptions: {
          maxBytes: cfg.maxBytes,
          timeoutMs: cfg.timeoutMs,
          maxRedirects: cfg.maxRedirects,
        },
        log: this.log,
      })
      const okCount = plan.filter((x) => x.ok).length
      this.log(
        `[bridge] 图片：收到 ${refs.length} 张，取到 ${okCount} 张（模式 ${cfg.mode ?? 'on-demand'}）`,
      )
      for (const bad of plan) if (!bad.ok) this.log(`[bridge] ⚠️ 取图失败：${bad.reason}`)

      // 顺手清理（带时间闸，见 #lastImagePrune 的注释）
      const nowMs = Date.now()
      if (nowMs - this.#lastImagePrune > 5 * 60_000) {
        this.#lastImagePrune = nowMs
        this.imageInbox.prune({
          retentionHours: cfg.retentionHours,
          maxTotalBytes: cfg.maxTotalBytes,
        })
      }

      // 把图挂到会话镜像的那条"用户消息"上，界面才显示得出图片
      this.#attachImagesToMirror(`${kind}:${peerId}`, plan)
      return plan
    } catch (error) {
      this.log(`[bridge] ⚠️ 取图过程出错（不影响回复）：${error?.message ?? error}`)
      return []
    }
  }

  /**
   * 给会话镜像里**最后一条用户消息**挂上图片信息。
   *
   * 为什么要回填而不是在收图前写：镜像那一条是在 `renderSegments` 之后立刻
   * 写的（为了"使用者发了什么，界面马上能看到"，即使后面判定不回复）。
   * 而收图在准入之后，晚于它。所以只能回填。
   *
   * 失败一律吞掉：这是纯展示数据。
   */
  #attachImagesToMirror(chatKey, plan) {
    try {
      const conv = this.#conversations.get(chatKey)
      if (!conv || !Array.isArray(conv.messages)) return
      for (let i = conv.messages.length - 1; i >= 0; i--) {
        if (conv.messages[i]?.role !== 'user') continue
        conv.messages[i].images = plan.map((x) =>
          x.ok
            ? { ok: true, path: x.relPath, mediaType: x.mediaType, bytes: x.bytes }
            : { ok: false, reason: x.reason },
        )
        break
      }
    } catch (error) {
      this.log(`[bridge] ⚠️ 图片信息写入镜像失败（不影响消息收发）：${error?.message ?? error}`)
    }
  }

  /**
   * 可被收尾打断的 sleep。
   *
   * ★ 这个方法是修一个**真实丢消息**的缺陷时加的：
   *
   *   实测有一次回复因为"静默时段"被延迟了 **116 秒**，而使用者在它发出去
   *   之前重启了桥接 —— `shutdown` 里第一件事就是 `onebot.close()`，
   *   发送通道当场断掉，那条**已经生成好**的回复就永远丢了。
   *   日志里的表现是：`拟人延迟 116 秒后再发` 之后紧接着
   *   `=== 桥接退出（收到 1 条私聊，回复 0 条）===`。
   *
   * 所以延迟期间要能被打断，并且**打断后立刻把回复发出去**（见 #deliver）。
   * 少等几秒（拟人节奏打折）远好于丢失整条回复。
   *
   * @returns {Promise<boolean>} true = 被收尾打断（剩余延迟被跳过）
   */
  #sleepUnlessClosing(ms) {
    if (ms <= 0) return Promise.resolve(false)
    if (this.#closing) return Promise.resolve(true)
    return new Promise((resolve) => {
      const done = (interrupted) => {
        clearTimeout(timer)
        this.#sleepers.delete(done)
        resolve(interrupted)
      }
      const timer = setTimeout(() => done(false), ms)
      if (typeof timer.unref === 'function') timer.unref()
      this.#sleepers.add(done)
    })
  }

  /**
   * 优雅收尾：跳过剩余延迟把在途回复发完，并等它们结束。
   *
   * `index.mjs` 的 `shutdown` 在关掉 QQ 通道**之前**调用它，否则
   * 那些已经生成好、正在延迟里排队的回复会被直接掐死。
   *
   * @param {number} [timeoutMs] 最多等多久（不能把退出无限拖住）
   * @returns {Promise<{waited: number, timedOut: boolean}>}
   */
  async close(timeoutMs = 8000) {
    this.#closing = true
    const pending = this.#inFlight.size
    if (pending > 0) {
      this.log(`[bridge] 收尾：有 ${pending} 条回复还在发送流程里，先让它们发完（最多等 ${Math.round(timeoutMs / 1000)} 秒）`)
    }
    // 叫醒所有在睡的人（它们会立刻把回复发出去）
    for (const wake of [...this.#sleepers]) wake(true)

    const deadline = Date.now() + timeoutMs
    while (this.#inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    const timedOut = this.#inFlight.size > 0
    if (timedOut) {
      this.log(`[bridge] ⚠️ 收尾超时，还有 ${this.#inFlight.size} 条回复没发完（已放弃等待）`)
    } else if (pending > 0) {
      this.log('[bridge] 收尾：在途回复已全部处理完')
    }
    return { waited: pending, timedOut }
  }

  /**
   * 降级 + 拟人延迟 + 节流 + 发送（分片）。
   *
   * ── 为什么延迟放在这里，而不是放在"收到消息"那一刻 ──────────────────
   * 拟人的关键是：**反应时间 + 打字时间**。
   *   · 反应时间：看到消息到开始打字
   *   · 打字时间：由**回复有多长**决定 —— 所以必须等模型给出答案之后才可能算准
   * 如果一收到消息就固定 sleep 几秒再调模型，那就是"固定延迟"，本身也是机器特征。
   *
   * ── 为什么用分条而不是一条长的 ───────────────────────────────────────
   * 真人长回复是分几条发的。分条还天然带上了 SendQueue 的间隔。
   */
  async #deliver(kind, peerId, answer, result) {
    // 先按"观感"分条（真人不会把 800 字糊在一条里），再按单条上限兜底切分。
    const humanChunks = splitIntoMessages(answer, {
      maxChars: this.config.humanize?.chunkChars ?? 300,
    })
    const limit = this.config.send?.maxCharsPerMessage ?? 1500
    const chunks = humanChunks.flatMap((c) => splitForQQ(c, limit))

    const { delayMs, reason } = computeReplyDelay({
      textLength: answer.length,
      humanize: this.config.humanize,
    })
    if (delayMs > 0) {
      this.log(
        `[bridge] 拟人延迟 ${Math.round(delayMs / 1000)} 秒后再发（原因：${reason}，回复 ${answer.length} 字）`,
      )
      const interrupted = await this.#sleepUnlessClosing(delayMs)
      if (interrupted) {
        // ★ 正在收尾：**跳过剩余延迟，立刻发**。
        //
        // 为什么不是"直接放弃这条回复"：它在延迟期间已经被完整生成好了，
        // 丢掉它使用者只会看到"机器人没理我"，而成本已经付过了。
        // 少等几秒（拟人节奏打了折）比丢失整条回复好得多。
        this.log('[bridge] 收尾中：跳过剩余拟人延迟，立即发送')
      }
    }

    for (const chunk of chunks) {
      const verdict = this.sendQueue.check(chunk)
      if (!verdict.ok) {
        this.log(`[bridge] 跳过发送：${verdict.reason}`)
        continue
      }
      if (verdict.waitMs > 0) await this.#sleepUnlessClosing(verdict.waitMs)

      // 校验之后可能又过了时间，再查一次（简单但有效）
      const recheck = this.sendQueue.check(chunk)
      if (!recheck.ok) {
        this.log(`[bridge] 发送前复检跳过：${recheck.reason}`)
        continue
      }

      try {
        await this.onebot.send(kind, peerId, chunk)
        this.sendQueue.markSent(chunk)
        // 真正发出去的才记进镜像（节流跳过的那些不算"说过的话"）
        this.#mirror(`${kind}:${peerId}`, 'bot', chunk, { createIfMissing: false })
      } catch (error) {
        this.log(`[bridge] 发送失败：${error.message}`)
        throw error
      }
    }

    this.log(
      `[bridge] 已回复 ${kind}:${peerId}（${answer.length} 字，${chunks.length} 条，` +
        `思考+工具 ${result.durationMs}ms，工具 ${result.toolCalls.length} 次，拟人延迟 ${Math.round(delayMs / 1000)}s）`,
    )
  }

  /**
   * 发送但不因失败而抛出（用于错误提示这类"尽力而为"的消息）。
   *
   * ⚠️ 刻意**不加拟人延迟**：这类消息是"出问题了"的信号，
   * 让它尽快到达比让它"像人"重要得多。加延迟只会让人以为机器人死了。
   */
  async #safeSend(kind, peerId, text) {
    try {
      await this.onebot.send(kind, peerId, text)
      this.sendQueue.markSent(text)
      // 提示类消息在镜像里标成 notice，与正常回复区分开
      this.#mirror(`${kind}:${peerId}`, 'notice', text, { createIfMissing: false })
    } catch (error) {
      this.log(`[bridge] 提示消息发送失败：${error.message}`)
    }
  }
}
