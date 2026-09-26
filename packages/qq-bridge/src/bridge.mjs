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
  listMemoryFiles,
  parseMemoryMarkers,
  readMemoryForPrompt,
  saveSnapshot,
  SCOPE,
  takeReceipt,
  verifyAndRestoreMemory,
  writeReceipt,
} from './memory-store.mjs'
import { parseRememberRequest } from './memory-keyword.mjs'
import { appendAuditEntry } from './memory-audit.mjs'
import { createConsolidateScheduler } from './memory-consolidate.mjs'
import { gateDelivery, LEAK_NOTICE } from './delivery-gate.mjs'
import { parseOutMarkers, resolveSticker, stickerNames, renderMarkerInstructions } from './markers.mjs'
import { createCorpus, renderSearchResults } from './corpus.mjs'
import { deliveryKey, describeGap } from './transport.mjs'
import { createSessionStateStore, renderSessionStateBlock } from './session-state.mjs'
import { recordInjection } from './memory-usage.mjs'
import { beginDelivery, orphanedDeliveries, renderOrphans, ownerId } from './delivery-ledger.mjs'

/**
 * ★ H15：本进程的启动时刻（模块加载时取一次）。
 *
 * 为什么不能只用 pid 当"所有者"：**pid 会被复用** —— 新进程拿到刚死掉那个进程的 pid 时，
 * 账本里"属于我"的行其实是**上一个人**留下的，于是它会以为发过（漏发）或重发（重复）。
 * `(pid, 启动时刻)` 能把同一个 pid 的两次运行分开。
 */
const PROCESS_STARTED_AT = Date.now()
import { noteTurn, noteMemoryAttempt, zeroWriteAlert, STATS_DEFAULTS } from './memory-stats.mjs'
import { screenForOutput, logPrivacyBlock, BLOCKED_OUTPUT_NOTICE } from './privacy.mjs'
import { appendTurnOps } from './oplog.mjs'
import { readTask, renderTaskBlock, noteTaskTurn, parseRollback, rollbackTask } from './tasks.mjs'
import { listRecipes, pickRecipes, renderRecipeBlock, upsertRecipe } from './recipes.mjs'
import { extractRecipe, DEFAULT_EVERY_N as EXTRACT_DEFAULT_EVERY_N } from './extract.mjs'
import { buildPermissionInstructions, createRoster } from './roster.mjs'
import { createInterimPicker } from './interim.mjs'
import { buildPersona, mergeWakeKeywords } from './persona.mjs'
import { buildChannelPrompt } from './channel-prompt.mjs'
import { createImageInbox, collectImages } from './images.mjs'
// ★ H16：`PLATFORM_RULES` 与整段拼装逻辑已搬到 `src/channel-prompt.mjs`。
//   搬它的**验收标准**是"同一份输入产出的提示词逐字相同"（见 verify-memory-roundtrip 第⑱节
//   与 mocks/fixtures/prompt-golden.txt）—— 不是"看着像对的"。

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
   * 已经喊过"零写入告警"的会话（只喊一次，避免刷屏把日志淹掉）。
   * @type {Set<string>}
   */
  #zeroWriteAlerted = new Set()

  /**
   * 已经报过"某段上下文注入失败"的段落名（只报一次）。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * 为什么必须有它（R2 最贵的一次教训）
   * ══════════════════════════════════════════════════════════════════════════
   * 任务段的注入原本写成 `try { … } catch { /* 少一段上下文而已 *\/ }` ——
   * 意图是好的（观测/增强路径不能弄挂主流程），但它**吞掉了一个硬错误**：
   * `#buildPrompt` 里用的 `chatKey` 其实是 `#runTurn` 的局部变量，
   * 于是 `readTask` 那行每次都抛 `ReferenceError: chatKey is not defined`，
   * 被这个空 catch 吃掉 —— 结果【当前任务】段**在真机上从未注入过一次**，
   * 而日志里连一个字都没有。
   *
   * 发现方式：真机跑了 7 轮之后，去读 DSH 落盘的会话记录，发现 7 轮的提示词里
   * 全都没有任务段（见 `mocks/session-grep.mjs`）。**离线 124 项测试全绿** ——
   * 因为它们测的是纯函数 `renderTaskBlock`，而错在**接线**。
   *
   * 所以规矩改成：**增强路径可以失败，但不许安静地失败**。
   * 只报一次是为了不刷屏（每轮都失败时日志会被淹）。
   * @type {Set<string>}
   */
  #injectWarned = new Set()

  /**
   * 配方抽取的回合计数与重入标记（见 `#maybeExtractRecipe`）。
   * 这两个字段刻意放在实例上而不是 config 里 —— 它们不是配置，是运行状态。
   */
  extractTurns = 0
  extractEveryN = EXTRACT_DEFAULT_EVERY_N
  #extractRunning = false

  /**
   * 定时整理记忆的调度器（H2，见 `memory-consolidate.mjs`）。
   * `attach()` 里启动、`close()` 里停掉；null = 没启用（记忆关着或没有工作区）。
   * @type {{start: Function, stop: Function, tick: Function}|null}
   */
  #consolidate = null

  /**
   * 每个会话"近期真的见过的消息 id"（H6 引用校验用）。
   *
   * chatKey → string[]（按见到顺序，超出 `MAX_SEEN_IDS` 就丢最旧的）。
   * ★ 只在内存里、**不持久化**：它是校验白名单，不是归档。
   * @type {Map<string, string[]>}
   */
  #seenMsgIds = new Map()

  /**
   * 本地语料库（H7）：每条消息落库 + 中文全文检索。
   *
   * ★ 为什么构造时就建：它是**同步**写入（每条消息都要写），
   *   而打不开时只会报一次日志、把这一层停用 —— 绝不影响消息收发。
   * @type {{record: Function, search: Function, stats: Function, prune: Function, close: Function}|null}
   */
  #corpus = null

  /**
   * 待告知模型的**断线缺口**（H9）：`{ms, since}`，用过即清。
   *
   * ★ 一次性：它只在**下一轮**有意义 —— 「刚才掉线了」隔三轮再提只会让人莫名其妙。
   * @type {{ms: number, since: number|null}|null}
   */
  #pendingGap = null

  /**
   * 会话状态（H10）：这段对话"聊到哪了" —— **纯规则、零模型调用、只在内存**。
   *
   * ★ 与任务台账（`tasks.mjs`）是**两条轴**：那个说"我在做什么任务、做到哪一步"
   *   （跨重启、落盘），这个说"这段对话的走向"（重启即弃 —— 对话重启后本来就是新的）。
   *   分界写在 `session-state.mjs` 文件头。
   * @type {{noteUser: Function, noteConsumed: Function, noteBot: Function, read: Function, hasPendingNewer: Function}|null}
   */
  #sessionState = null

  /** ★ H15：投递账本里的"所有者"（本进程）。惰性算一次，同一个进程内不变。 */
  #deliveryOwner = ''

  /** 已经报过"表情名字不在表里"的名字（同一个名字只报一次，防刷屏）。 */
  #stickerWarned = new Set()

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

  /**
   * 发言人身份缓存：`<kind>:<peerId>:<userId>` → `{ name, role, roleLabel, at }`。
   *
   * 为什么要缓存：群聊里同一个群可能每分钟来好几条消息，而"这个人是谁"
   * 在几十秒内不会变。每条消息都去协议端查一次 = 白花一次 HTTP 往返，
   * 还会让 SnowLuma 侧凭空多出一串查询（属于不必要的风控噪声）。
   *
   * TTL 取得短（5 分钟）是有意的：群名片、群内角色**是会变的**，
   * 缓存太久会把"他已经被撤了管理"这种事瞒着不报。
   */
  #senderCache = new Map()

  /** 身份缓存有效期：5 分钟。 */
  static SENDER_CACHE_MS = 5 * 60 * 1000
  /** 身份缓存条数上限 —— 防止长时间运行下无界增长。 */
  static SENDER_CACHE_MAX = 200

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
    // ── 本地语料库（H7）──────────────────────────────────────────────────
    // ★ 构造时就建（写入是同步的、每条消息都要走）；打不开只会报一次日志
    //   并把这一层停用 —— **绝不影响消息收发**（增强路径纪律）。
    try {
      if (config.dsh?.workspace) {
        this.#corpus = createCorpus({ workspace: config.dsh.workspace, log })
      }
    } catch (error) {
      log(`❌ [corpus] 初始化失败（这一层停用）：${error?.message ?? error}`)
    }
    // ── 会话状态（H10）：纯内存、纯规则 ──────────────────────────────────
    this.#sessionState = createSessionStateStore()
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
        // ★ H12：自定义人设被拒时**必须喊出来**（静默换成 [BLOCKED] 会让人以为
        //    "我的人设没生效"是别的原因，排查方向完全跑偏）
        log: (m) => this.log(m),
      })
    } catch (error) {
      this.log(`⚠️ 人设配置有问题，已退回不使用人设：${error.message}`)
      this.personaText = ''
    }

    // ★★ H11：把**人设里的名字表**变成真正的唤醒词。
    //
    // 为什么必须在桥接这一层做：唤醒判定发生在**拼提示词之前** —— 群里有人直呼"小鱼"
    // 时，如果唤醒判定不认这个名字，那句话**根本进不了模型**，人设里写多少遍
    // "别人叫你小鱼也是在叫你"都没用（那是一句愿望，不是一个信号）。
    //
    // ★ 只用"正式名 + 别名"，**不含 `又称`**（如 DeepSeek）—— 技术群里那个词太常见，
    //   拿它当唤醒词会让机器人在不相关讨论里插嘴。这条判断写在 persona 的数据里。
    this.wakeKeywords = mergeWakeKeywords(this.config.trigger?.keywords ?? [], this.personaText)

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
  /**
   * 写操作日志（oplog）：把这一回合收到的事件流水落盘。
   *
   * 为什么单独一个方法：`#runTurn` 已经很长，而这件事的纪律很明确 ——
   * **失败只记日志、绝不影响回合**。把它圈起来比在流程里散落 try/catch 更清楚。
   */
  #writeOps(chatKey, result) {
    try {
      const workspace = this.config.dsh?.workspace
      if (!workspace) return
      const ops = Array.isArray(result?.ops) ? result.ops : []
      if (ops.length === 0) return
      const r = appendTurnOps({ workspace, chatKey, ops })
      if (r.written !== r.total) {
        // **不静默**：写少了要说出来（可能是文件到上限、也可能是权限问题）
        this.log(
          `[oplog] ⚠️ 操作日志只写了 ${r.written}/${r.total} 条${r.why ? `：${r.why}` : ''}`,
        )
      }
    } catch (error) {
      this.log(`[oplog] 写操作日志失败（已忽略）：${error?.message ?? error}`)
    }
  }

  /**
   * 更新任务台账：把这一回合的操作并进"我正在干什么"。
   *
   * 与 `#writeOps` 同源（都用 `result.ops`）但**用途不同**：
   *   · oplog 是**逐条事实流水**，给排查用，带 TTL、会过期；
   *   · 台账是**提炼后的当前状态**，给模型每轮看，只留最近几步。
   * 所以两处都要写，不要合并成一处。
   */
  #noteTask(chatKey, result, userText) {
    try {
      const workspace = this.config.dsh?.workspace
      if (!workspace) return
      const r = noteTaskTurn({ workspace, chatKey, ops: result?.ops ?? [], userText })
      if (!r.ok) this.log(`[tasks] 台账更新失败（已忽略）：${r.why}`)
    } catch (error) {
      this.log(`[tasks] 台账更新失败（已忽略）：${error?.message ?? error}`)
    }
  }

  /**
   * 识别"回到第 N 步"并**当场回退**（在跑这一轮之前）。
   *
   * ── 两个设计选择 ────────────────────────────────────────────────────────
   * ① **本地匹配，不让模型插手**。与记忆写入同一条教训：靠模型自觉的路径
   *    漏报率极高。回退是**明确的状态操作** —— 用户说了就该发生。
   * ② **回退在"这一轮开始之前"生效**，所以本轮模型看到的注入里就已经带着
   *    【已回退到第 N 步】的声明（否则它这一轮还会照旧继续往下做）。
   *
   * ⚠️ 回退**不改变**这一轮照常执行 —— 用户可能一边说"回到第 2 步"
   *    一边给了新要求。我们只负责把状态摆正，让模型看到。
   */
  #maybeRollback(chatKey, userText) {
    try {
      const workspace = this.config.dsh?.workspace
      if (!workspace) return
      const p = parseRollback(userText)
      if (!p.hit) return
      const task = readTask({ workspace, chatKey })
      if (!task || !Array.isArray(task.steps) || task.steps.length === 0) {
        this.log('[tasks] 收到回退请求，但这个会话还没有步骤可回退')
        return
      }
      // 指代式换算（`which` 区分"上一步"与"这一步"）：
      //   · 上一步 → 回到"倒数第二步"，也就是把最后一步作废（如果还有更早的步）
      //   · 这一步 → 回到**最后一步**本身，也就是重做/撤掉刚做的那一步
      // 为什么要分开：`回到上一步` 与 `撤销这一步` 在日常汉语里是**两个意思**，
      // 合成一个会让其中一半的用户得到相反的结果。
      const validCount = task.steps.filter((s) => s.outcome !== 'superseded').length
      const target =
        p.which === 'explicit'
          ? p.step
          : p.which === 'last'
            ? Math.max(1, validCount - 1)
            : validCount // 'this' 或退化的 null
      const r = rollbackTask({ workspace, chatKey, step: target, mode: p.mode })
      if (!r.ok) {
        // **不静默**：越界要说出可用范围（AGENT.md 第 6 条）
        this.log(`[tasks] ⚠️ 回退失败：${r.why}`)
        return
      }
      this.log(
        `[tasks] ↩️ 已回退到第 ${target} 步（${p.mode}）：${r.target?.action ?? ''}` +
          '（注意：DSH 会话上下文**没有**回退，只在提示词里声明了作废）',
      )
    } catch (error) {
      this.log(`[tasks] 回退处理失败（已忽略）：${error?.message ?? error}`)
    }
  }

  /**
   * 每 N 个回合跑一次**配方抽取**（R4b）。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * 这是整个项目**唯一会产生额外模型调用**的地方
   * ══════════════════════════════════════════════════════════════════════════
   * 为什么值得：
   *   · 同一个会话里"查一个陌生品牌靠不靠谱"这类事会反复出现
   *   · 每次从零摸索 = 重复踩已经踩过的坑（包括被权限拒绝的那种）
   *   · 而配方库本身是**零模型成本**的（匹配是本地打分），
   *     只有"沉淀"这一步需要模型
   *
   * ── 三条纪律（都是"绝不能影响聊天"的落点）────────────────────────────
   *   ① **不 await**：起一个一次性 `dsh --profile headless` 子进程，让它自己跑完。
   *      若 await，这一轮回复会白等 3~5 秒，而抽出来的配方**这一轮也用不上**。
   *   ② **有超时**：子进程有 `timeoutMs`，不会积压成僵尸。
   *   ③ **失败静默**：任何异常只记一行日志。它是增强路径。
   *
   * ⚠️ 为什么必须起**新进程**而不是用桥接自己那条会话：那条 sdk 会话是
   *    用户对话的载体，拿它跑抽取会把内部 prompt 混进用户上下文，
   *    而且每 5 轮污染一次。见 `src/extract.mjs` 的说明。
   */
  #maybeExtractRecipe(chatKey, result, rendered) {
    try {
      if (this.extractEveryN <= 0) return
      const workspace = this.config.dsh?.workspace
      const cliPath = this.config.dsh?.cliPath
      if (!workspace || !cliPath) return
      this.extractTurns = (this.extractTurns ?? 0) + 1
      // 轮数字段只用于"每 N 轮"判定，换个进程无所谓
      if (this.extractTurns % this.extractEveryN !== 0) return
      if (this.#extractRunning) return // 上一次还没跑完就跳过这一轮（绝不让它们堆起来）

      const task = readTask({ workspace, chatKey })
      const ops = Array.isArray(result?.ops) ? result.ops : []
      // 没有任何操作就不值得抽（纯聊天沉淀不出"做法"）
      if (!task && ops.length === 0) return

      this.#extractRunning = true
      const t0 = Date.now()
      // ★ **不 await** —— 让它在后台跑完
      extractRecipe({
        cliPath,
        task,
        ops,
        kind: String(chatKey).startsWith('group:') ? 'group' : 'private',
        cwd: workspace,
        timeoutMs: 60_000,
      })
        .then((r) => {
          if (!r.ok) {
            // ★ 解析失败必须**带上原文片段**（这一行是血的教训）：
            //   第一版只记 `r.why`，真机上就只剩一句"抽取输出解析不出 JSON" ——
            //   既不知道模型到底写了什么形状，也没法写回归测试。当时是靠
            //   **手动去翻 DSH 落盘的抽取会话**才把原文捞回来的。
            //   这是本项目最贵的一类缺陷（"失败但没有证据"），所以原文片段直接进日志；
            //   截断到 200 字是防止一次畸形输出把日志刷爆。
            const hint = r.raw ? `｜原文前 200 字：${String(r.raw).slice(0, 200)}` : ''
            this.log(`[extract] 抽取未成功（已忽略）：${r.why}${hint}`)
            return
          }
          if (r.skipped) {
            this.log(`[extract] 这一轮不值得沉淀（模型给了 skip）· ${Date.now() - t0}ms`)
            return
          }
          // 入库：同 slug 会合并取并集
          const up = upsertRecipe({ workspace, recipe: r.recipe, source: 'auto' })
          if (up.ok) {
            this.log(`[extract] ✅ 沉淀了一条做法：${r.recipe?.title ?? '?'}（${up.merged ? '已合并' : '新增'}，${Date.now() - t0}ms）`)
          } else {
            this.log(`[extract] 配方没入库（已忽略）：${up.why}`)
          }
        })
        .catch((error) => {
          this.log(`[extract] 抽取异常（已忽略）：${error?.message ?? error}`)
        })
        .finally(() => {
          this.#extractRunning = false
        })
    } catch (error) {
      this.#extractRunning = false
      this.log(`[extract] 抽取触发失败（已忽略）：${error?.message ?? error}`)
    }
  }

  /**
   * "零写入告警"：跑了足够多轮却一条记忆都没落盘 → **喊一声**。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * 为什么要有它（这是 0.2.0 最贵的一次教训）
   * ══════════════════════════════════════════════════════════════════════════
   * 实测事故：机器人聊了两天、几十轮，**一条记忆都没写**，
   * 而**没有任何地方报过警**。发现它靠人工去解 DSH 的会话落盘记录。
   *
   * 本项目第一条约束就是"**失败必须让用户知道**"（`AGENT.md` 第 6 条）。
   * "记忆静默不工作"正是这条约束要防的典型 —— 所以这里必须主动喊。
   *
   * ⚠️ 只喊**一次**（同一个会话）：状态翻成 `alerted` 之后不再重复刷屏。
   *    反复刷同一句会把日志淹掉，那等于换个方式让人看不见。
   */
  #checkZeroWrite(chatKey) {
    try {
      const workspace = this.config.dsh?.workspace
      if (!workspace) return
      // 阈值先走代码默认值（见 memory-stats.mjs 的 STATS_DEFAULTS）。
      // ⚠️ 这里**刻意不读 config.memory.zeroWriteAfterTurns**：那个键尚未注册进
      //    `PROJECT.json` / `CONFIG-UI.md`，凭空读一个未注册的键会让"文档与代码
      //    一致"的自检失败（实测被抓到），也会让使用者以为它能配却配不了。
      //    等 0.2.1 的技能系统（M5'）把 memory 配置整体迁到 `skills.memory.*` 时，
      //    再把它作为一个**正式注册**的配置项加进来。
      const threshold = STATS_DEFAULTS.zeroWriteAfterTurns
      const r = zeroWriteAlert({ workspace, chatKey, threshold })
      if (!r.alert) return
      // 同一个会话只喊一次
      if (!this.#zeroWriteAlerted) this.#zeroWriteAlerted = new Set()
      if (this.#zeroWriteAlerted.has(chatKey)) return
      this.#zeroWriteAlerted.add(chatKey)
      this.log(
        `[memory] ⚠️ 零写入告警：${chatKey} ${r.why}。` +
          '记忆链路可能坏了 —— 用 `node src/index.mjs --memory --stats` 看四个计数，' +
          '`--memory` 看落盘与注入，再照 docs/0.2.1-memory-diagnosis.md 排查。',
      )
    } catch {
      /* 告警本身绝不能影响主流程 */
    }
  }

  /**
   * 报一次"某段上下文注入失败"（同一段只报一次）。
   *
   * 存在的理由见 `#injectWarned` 的注释：这里的上一版是**空 catch**，
   * 于是任务段的注入因为一个作用域错误**静默失效**，真机 7 轮全无任务段，
   * 而离线 124 项测试全绿（它们只测纯函数，没测接线）。
   *
   * @param {string} what 段落名（"任务段" / "配方段" …）
   * @param {unknown} error
   */
  #warnInjectOnce(what, error) {
    try {
      const label = String(what ?? '上下文')
      if (!this.#injectWarned) this.#injectWarned = new Set()
      if (this.#injectWarned.has(label)) return
      this.#injectWarned.add(label)
      this.log(
        `❌ [bridge] ${label}注入失败 —— 这一段只是上下文、不会影响这一轮，` +
          `但它意味着**该功能等于没有**（只报这一次）：${error?.message ?? error}`,
      )
    } catch {
      /* 报错本身绝不能影响主流程 */
    }
  }

  /**
   * 记忆结算：**四条通道**的处理都在这里，而且必须在任何"提前 return"之前跑完。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * H1（真机缺陷）：未完成 / 被取代的轮次原来会**静默吞掉**记忆提议
   * ══════════════════════════════════════════════════════════════════════════
   * 原先的顺序是：`superseded` → `return`、`timedOut` → `return`，
   * 而**那之后**才是 `parseMemoryMarkers` + `applyMemoryItems` + `writeReceipt`。
   * 后果：那一轮模型提议的记忆**全部消失**，连"没记上"的回执都没有 ——
   * 而用户看到的是机器人回过了话，会以为记住了。这正是本项目最防的静默失败。
   *
   * 现在按**三分类**处理（每一类都留痕）：
   *
   * | 本轮状态 | 用户的话（关键词直写） | 模型提议的标记 |
   * |---|---|---|
   * | 正常结束 | **照常落盘** | 照常处理 |
   * | `superseded`（被更新的消息取代，回复不发） | **照常落盘** | **照常处理**（内容仍然有效，只是这轮不发送） |
   * | 超时 / 中断 | **照常落盘**（那句话是完整的） | **不处理**（不写半截内容），并在回执里说明 |
   *
   * ★ 为什么"关键词直写"和"模型提议"在超时时的待遇**相反**：
   *   关键词直写的输入是**用户的话**，与模型有没有跑完无关；
   *   模型提议的输入是**它自己那半截没跑完的输出**，写进去就是半成品污染记忆。
   *
   * @param {object} opts
   * @param {boolean} [opts.complete] 本轮是否正常结束（false = 超时/中断）
   * @returns {{answer: string, applied: number, ignored: number, keyword: object}}
   *   `answer` 是**剥掉标记后**的正文
   */
  /**
   * 记下一个"本会话真的见过的消息 id"（H6 的引用校验用）。
   *
   * ⚠️ 只留内存、只留最近 `MAX_SEEN_IDS` 条：
   *   · 它只是**校验用的白名单**，不是归档（归档是 H7 的语料库）；
   *   · 无上限的 Map 就是内存泄漏 —— 这个项目在别处也踩过同类问题。
   */
  #rememberMessageId(chatKey, id) {
    try {
      const key = String(chatKey ?? '')
      const val = id == null ? '' : String(id).trim()
      if (!key || !val) return
      if (!this.#seenMsgIds.has(key)) this.#seenMsgIds.set(key, [])
      const list = this.#seenMsgIds.get(key)
      if (list.includes(val)) return
      list.push(val)
      if (list.length > Bridge.MAX_SEEN_IDS) list.splice(0, list.length - Bridge.MAX_SEEN_IDS)
    } catch {
      /* 记不下最多是"这次引用不生效"，绝不影响回合 */
    }
  }

  /** 这个 id 是不是本会话近期真的见过（引用校验的唯一判据）。 */
  #hasSeenMessageId(chatKey, id) {
    const list = this.#seenMsgIds.get(String(chatKey ?? '')) ?? []
    return list.includes(String(id ?? '').trim())
  }

  /**
   * 记一条进语料库（H7）。**任何失败只记一行日志** —— 它是增强路径。
   *
   * ★ `record()` 是同步的：sqlite 的一次 INSERT 是亚毫秒级；
   *   而"要不要落库"必须在**唤醒判定之前**决定（没被唤醒的群消息也要进库）。
   */
  #recordCorpus(opts) {
    try {
      this.#corpus?.record(opts)
    } catch (error) {
      this.log(`❌ [corpus] 入库失败（这条不入库，其它功能不受影响）：${error?.message ?? error}`)
    }
  }

  /**
   * 检索本会话历史（给 MCP 工具与排查用）。
   * @returns {{ok: boolean, text: string, rows: object[], mode?: string|null, why?: string}}
   */
  searchHistory({ chatKey = null, query = '', limit = 8 } = {}) {
    try {
      if (!this.#corpus) return { ok: false, text: '', rows: [], why: '语料库未启用' }
      const r = this.#corpus.search({ query, chatKey, limit })
      if (!r.ok) return { ok: false, text: '', rows: [], why: r.why }
      return { ok: true, rows: r.rows, mode: r.mode, text: renderSearchResults({ rows: r.rows, query, mode: r.mode }) }
    } catch (error) {
      return { ok: false, text: '', rows: [], why: error?.message ?? String(error) }
    }
  }

  /** 语料库统计（给 `--corpus` 与体检用）。 */
  corpusStats(opts) {
    return this.#corpus?.stats(opts) ?? { ok: false, why: '语料库未启用' }
  }

  #settleMemory({ chatKey, kind, peerId, senderId, tier, userText = '', answer = '', complete = true }) {
    const workspace = this.config.dsh?.workspace
    // 标记**无条件剥离**（绝不能把内部协议发给用户），与"要不要落盘"是两件事
    const parsed = parseMemoryMarkers(answer)
    const clean = parsed.clean
    // 关键词直写：只看用户那句话，**不看模型表现**
    const keyword = parseRememberRequest({ text: userText })
    if (!workspace) return { answer: clean, applied: 0, ignored: 0, keyword }

    // 记一轮：**无条件**记，不管这轮有没有提议（零写入告警的判据靠它，见 memory-stats.mjs）
    noteTurn({ workspace, chatKey })

    const enabled = this.config.memory?.enabled !== false
    const keywordItems =
      keyword.hit && keyword.entry ? [{ scope: SCOPE.FACT, text: keyword.entry, source: 'keyword' }] : []
    const markerItems = complete
      ? parsed.items.map((it) => ({ ...it, source: 'marker' }))
      : []

    if (!enabled) {
      if (keywordItems.length || parsed.items.length) {
        this.log(
          `[bridge] 记忆开关关闭，已剥离 ${parsed.items.length} 条提议、` +
            `${keywordItems.length} 条关键词直写（都不落盘、不回执）`,
        )
      }
      return { answer: clean, applied: 0, ignored: 0, keyword }
    }

    // ── 回执里的"整句说明"（两种都必须说，否则模型下一轮会以为记上了）──────
    const notes = []
    if (keyword.hit && !keyword.entry) {
      // 说了"记住"但没说内容 → 不要默默无事发生，让模型问清楚
      notes.push(
        `对方刚才说了「记住」但**没说清要记什么**（${keyword.why}）—— 用你自己的话问一句他具体要你记什么。`,
      )
    }
    if (!complete && parsed.items.length > 0) {
      notes.push(
        `⚠️ 上一轮**没跑完**（超时或中断）：你当时提议的 ${parsed.items.length} 条记忆**没有被处理**` +
          '（不写半截内容）。如果那些确实值得记，这一轮再用标记提一次。',
      )
    }

    const all = [...keywordItems, ...markerItems]
    let outcome = { applied: [], ignored: [], wroteFiles: [] }
    if (all.length > 0) {
      outcome = applyMemoryItems({
        workspace,
        kind,
        peerId,
        senderId,
        tier,
        items: all,
        log: this.log,
      })
      if (keywordItems.length > 0 && outcome.applied.some((a) => a.source === 'keyword')) {
        notes.push(
          '其中**对方明确要求记的那几条**是系统**直接落盘**的（不依赖你），你不用再提议一遍。',
        )
      }
      writeReceipt({
        workspace,
        kind,
        peerId,
        applied: outcome.applied,
        ignored: outcome.ignored,
        notes,
      })
      // 计数 + 零写入告警（0.2.0 完全缺失的那块可观测性）
      noteMemoryAttempt({
        workspace,
        chatKey,
        proposed: all.length,
        applied: outcome.applied.length,
        ignored: outcome.ignored.length,
        deduped: outcome.applied.filter((a) => a.deduped).length,
      })
      this.#checkZeroWrite(chatKey)
    } else if (notes.length > 0) {
      // 只有"整句说明"（例如说了"记住"却没内容）—— 也要落成回执，否则等于没说
      writeReceipt({ workspace, kind, peerId, applied: [], ignored: [], notes })
    }

    // ── 审计：谁、何时、哪条来源、什么档位、结果（**不记原文**）────────────
    for (const a of outcome.applied) {
      appendAuditEntry({
        workspace,
        entry: {
          chatKey,
          senderId,
          source: a.source,
          scope: a.scope,
          outcome: a.deduped ? 'deduped' : 'applied',
          chars: String(a.entry ?? '').length,
        },
        log: this.log,
      })
    }
    for (const i of outcome.ignored) {
      appendAuditEntry({
        workspace,
        entry: {
          chatKey,
          senderId,
          source: i.source,
          scope: i.scope,
          outcome: 'ignored',
          chars: String(i.entry ?? '').length,
          why: i.why,
        },
        log: this.log,
      })
    }

    return { answer: clean, applied: outcome.applied.length, ignored: outcome.ignored.length, keyword }
  }

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
    // ★★ H15：启动时**先把上一个人留下的烂账报出来**。
    //
    // 为什么这件事必须在启动阶段做（而不是等人来查）：真机上丢过一整条回复，
    // 而当时**没有任何地方**提示"上一次运行有东西没发完"。落账之后这件事是可查的，
    // 但"可查"和"会被告知"是两回事 —— 前者只有想到了才会去看。
    try {
      const workspace = this.config?.dsh?.workspace
      if (workspace) {
        const owner = ownerId({ pid: process.pid, startedAt: PROCESS_STARTED_AT })
        const orphans = orphanedDeliveries({ workspace, owner, log: this.log })
        if (orphans.length > 0) this.log(renderOrphans(orphans))
      }
    } catch (error) {
      this.log(`⚠️ [delivery-ledger] 启动时查未完成投递失败：${error?.message ?? error}`)
    }

    onebot.addEventListener('event', (e) => {
      this.handleEvent(e.detail).catch((error) => {
        this.log(`[bridge] 处理事件时未捕获错误：${error?.stack ?? error}`)
      })
    })
    // ── H9：断线缺口要留痕，并带进下一轮提示词 ─────────────────────────────
    //   ★ 为什么不是"发一条 QQ 消息告诉他掉线了"：那会平白多一条消息，
    //     而他可能根本没说活。真正的危害是**模型把掉线前后当成连续对话** ——
    //     所以缺口要进的是**模型的上下文**，由它在有必要时自己提一句
    //     （提示词里也写明了"不要猜他刚才说了什么"）。
    onebot.addEventListener('gap', (e) => {
      try {
        this.#pendingGap = { ms: Number(e?.detail?.ms) || 0, since: e?.detail?.since ?? null }
        this.log(`[bridge] 记下断线缺口 ${Math.round(this.#pendingGap.ms / 1000)} 秒（下一轮会告诉模型）`)
      } catch (error) {
        this.log(`[bridge] 记断线缺口失败（忽略）：${error?.message ?? error}`)
      }
    })
    // ── H2：定时整理记忆（每小时一次，只在空闲时动手）────────────────────
    //
    // ★ 为什么在 `attach` 里启动：它与"事件通道已接上"同一时刻发生 ——
    //   桥接真正开始工作的地方。启动得早一点没有意义（还没有记忆可整理）。
    // ★ 为什么必须 `isIdle`：整理会**重写记忆文件**，而写记忆发生在回合结束时；
    //   两者撞上就可能把刚写进去的那条覆盖掉（见 createConsolidateScheduler 的注释）。
    // ★ 失败只记日志、不抛；`unref()` 保证它不会拖住进程退出。
    try {
      if (this.config.memory?.enabled !== false && this.config.dsh?.workspace) {
        this.#consolidate = createConsolidateScheduler({
          workspace: this.config.dsh.workspace,
          // ★ 必须注入（不能靠 memory-consolidate 自己去 import memory-store ——
          //   那会形成循环依赖，见 `text-similarity.mjs` 的文件头）
          listFiles: () => listMemoryFiles(this.config.dsh.workspace),
          isIdle: () => this.#inFlight.size === 0 && this.#pending.size === 0,
          saveSnapshot: (opts) => saveSnapshot(opts),
          log: this.log,
        })
        this.#consolidate.start()
      }
    } catch (error) {
      // 定时整理起不来不该影响桥接 —— 但要留证据（AGENT.md 第 9 条）
      this.log(`❌ [memory] 定时整理启动失败（机器人照常工作）：${error?.message ?? error}`)
    }
    return this
  }

  /**
   * 手动触发一次定时整理（测试与排查用；返回本次结果）。
   * @returns {object}
   */
  consolidateNow() {
    if (!this.#consolidate) return { ok: false, why: '定时整理没有启动' }
    return this.#consolidate.tick()
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

    // ③-前 身份核实（**从协议端取真实昵称/群内角色**）
    //
    // ★ 为什么放在"记镜像"之前：镜像要带上"这句话是谁说的"，界面上才能
    //   显示昵称而不是一串 QQ 号（会话预览的同步就靠这一条）。
    //
    // ★ 它**不影响**下面的准入判定：权限永远只由 roster 按配置的
    //   `adminUsers` 决定。群内角色（群主/群管理）只用于显示与留痕 ——
    //   理由写在 `#verifyIdentity` 的注释里（拿它发权限 = 把工作区写权限
    //   交给任何一个群的群主）。
    //
    // ★ 私聊也查：你要的"私聊中验证对方 QQ 号"是代码层已经成立的
    //   （见下方 verdict），这里额外把**昵称**查出来用于显示与留痕。
    const identity = await this.#verifyIdentity({ kind, peerId, userId: senderId })

    // 记进内存镜像（给同步界面看"各个聊天在发生什么"）。
    // 放在最前面：使用者发了什么，界面上应立刻能看到 —— 即使后面判定不回复。
    const mirrorKey = `${kind}:${peerId}`
    this.#mirror(mirrorKey, 'user', rendered.text, {
      kind,
      peerId,
      senderId,
      identity,
    })

    // ── 记下这条消息的 id（H6：引用回复要用它）────────────────────────────
    //
    // ★ 为什么必须记：模型要写 `[reply:123]` 就得先**知道** 123 ——
    //   而在此之前，提示词里**根本没有消息 id**（任务段却一直在说"用带 # 的消息 id"，
    //   那两个段从来不存在）。现在把 id 记下来 → 提示词给出 → 回来时校验。
    // ★ 只记**本会话近期**的（默认 50 条，只在内存里）：引用一条很旧的消息时
    //   我们无法确认它真的属于这个会话，那就**不猜**（丢掉引用，正文照发）。
    //   等 H7 的本地语料库落地后，这个集合可以换成"按会话查库"，那时范围才是全量的。
    this.#rememberMessageId(mirrorKey, payload.message_id)
    // 用户"回复某条消息"时，那条 id 也一并记下 —— 它是平台告诉我们真实存在的，
    // 引用它是安全的，而且是很有用的一种引用（"就你刚才那条，我再解释一下"）。
    this.#rememberMessageId(mirrorKey, rendered.replyTo)

    // ── 语料库（H7）：每条消息落库，供"搜过去"用 ──────────────────────────
    //
    // ★ 位置：**在唤醒判定之前** —— 没被唤醒的群消息也要进库
    //   （"上次群里是谁说来着"这种问题，答案往往就在那些没 @ 机器人的消息里）。
    // ★ 失败只记一行日志（`createCorpus` 内部已兜住），绝不影响这一条消息的处理。
    this.#recordCorpus({
      kind,
      peerId,
      messageId: payload.message_id,
      userId: senderId,
      senderName: identity?.ok ? identity.name : null,
      text: rendered.text,
      isBot: false,
      mediaCount: rendered.imageRefs?.length ?? 0,
      atTargets: (rendered.text.match(/@[^\s@]+/g) ?? []).join(','),
      replyToId: rendered.replyTo,
    })

    // ② 唤醒判定
    const decision = decideTrigger({
      kind,
      text: rendered.text,
      mentioned: rendered.mentioned,
      raw: typeof payload.raw_message === 'string' ? payload.raw_message : '',
      selfId: this.onebot.selfId,
      keywords: this.wakeKeywords ?? this.config.trigger.keywords,
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

    // ── 身份审计：这一轮到底按"谁"、按什么级别处理 ────────────────────────
    //
    // 为什么必须留痕：权限这件事**出错是静默的** —— 判错了不会有任何报错，
    // 只会表现为"某个不该有权限的人拿到了权限"。所以每次判定都写一行，
    // 把**两个来源分开写清楚**：
    //   · 身份核实（协议端）：只说明"这个人是谁"
    //   · 权限判定（配置）：才是"他能做什么"的依据
    // 两者不一致时（例如群管理但不是你的管理员）这一行里一眼能看出来。
    {
      const idText = identity.ok
        ? `${identity.name || identity.userId}${identity.roleLabel ? `（${identity.roleLabel}）` : ''}`
        : `${senderId || '?'}（身份未核实：${identity.reason ?? '未知原因'}）`
      this.log(
        `[bridge] 身份核实 ${kind}:${peerId} 发言人 ${idText}` +
          `${identity.source ? ` 来源=${identity.source}` : ''}` +
          `｜权限判定=${verdict.respond ? verdict.tier : '拒绝'}（依据=桥接管理员表/白名单，非群内角色）` +
          `${verdict.respond ? '' : ` 原因=${verdict.reason}`}`,
      )
    }

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
      identity,
      rendered,
      // ★ 这条消息的 id 要一路传到提示词里（H6：模型得先知道 id 才谈得上引用）
      messageId: payload.message_id,
      // ★ H10：这一轮回答的是**第几条**用户消息（水位 `lastConsumedSeq`）
      seq: this.#sessionState?.noteUser({
        chatKey: mirrorKey,
        text: rendered.text,
        // 角色只用于"谁在说话"的统计；权限那套仍然只由 roster 决定
        role: verdict.tier === 'admin' ? 'admin' : 'member',
      }),
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
   * 每个会话记住多少个"近期见过的消息 id"（H6 的引用校验白名单）。
   *
   * 为什么是 50：它是"模型可能想引用的范围"与"内存占用"的折中 ——
   * 50 条足够覆盖一次连续对话里它想引用的任何一条；而一条 id 才几个字节。
   * ⚠️ **不要**为了"支持引用很久以前的消息"把它调得很大：
   *   那本质上是"要一个归档"，而归档是 H7 的本地语料库该干的事（带 TTL 与隐私闸门）。
   */
  static MAX_SEEN_IDS = 50

  /**
   * 核实发言人身份 —— **从协议端（SnowLuma）取真实昵称与群内角色**。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * 它是什么、它**不是**什么（这一段是这次改动的核心，别删）
   * ══════════════════════════════════════════════════════════════════════════
   * **是**：把"这串 QQ 号是谁"从协议端查出来，用于
   *   ① 同步到对话预览（界面上显示昵称与身份，而不是一串数字）；
   *   ② 写一行审计日志（这一轮按谁、按什么级别处理的）。
   *
   * **不是**权限依据。群内 `role`（owner/admin/member）**绝不**参与准入判定。
   * 若拿它发权限，后果是：任何一个群的群主或群管理，只要把机器人拉进群，
   * 就自动获得 DSH 工作区的写权限 —— 那是把整台机器的写权限交给陌生人。
   * 权限只由 `roster.decide()` 按配置里的 `adminUsers` 决定。
   *
   * ── 三条硬约束 ─────────────────────────────────────────────────────────
   *   ① **绝不抛异常**。调用方在消息路径上，查不到身份也必须能把消息回出去。
   *   ② **绝不长时间阻塞**。协议端不在/卡住时，这里最多花几百毫秒（有显式超时）。
   *      查身份是"给人看的附加信息"，不能让一轮回复等它。
   *   ③ **查不到就说查不到**。`ok:false` + `reason`，不猜昵称、不拿号码当昵称。
   *
   * @param {{kind: string, peerId: string, userId: string}} who
   * @returns {Promise<{ok: boolean, userId: string, name: string, role: string,
   *          roleLabel: string, source: string, reason?: string}>}
   */
  async #verifyIdentity({ kind, peerId, userId }) {
    const uid = String(userId ?? '')
    const gid = String(peerId ?? '')
    const base = { ok: false, userId: uid, name: '', role: '', roleLabel: '', source: '' }
    if (!uid) return { ...base, reason: '事件里没有 user_id，无法核实身份' }

    // 私聊里 peerId 就是对方 QQ 号，两者必然相同；群聊里 peerId 是群号。
    const groupId = kind === 'group' ? gid : ''
    // ★ 缓存键带版本号：缓存对象里现在也能带会话名，而"会话名"这个概念是后加的，
    //   没有版本号的话，升级后残留的旧缓存会让新字段**静默为空**。
    const cacheKey = `${kind}:${peerId}:${uid}:v2`

    const cached = this.#senderCache.get(cacheKey)
    if (cached && Date.now() - cached.at < Bridge.SENDER_CACHE_MS) return cached

    // 查得到的名字从哪来：群聊走群名片（群里显示的就是这个），私聊走好友昵称。
    // ★ 顺序有讲究：**群名片优先于昵称** —— 群里大家认得的是名片上的字。
    let name = ''
    let role = ''
    let source = ''
    let reason = ''

    const onebot = this.onebot ?? {}

    // ── 群聊：问协议端"这个人是谁、在群里什么角色" ─────────────────────
    //
    // ★ 两条路径都试，**顺序有讲究**：
    //   ① `onebot.getGroupMemberInfo()` —— OneBotClient 上的现成封装，
    //      它自己会把 `data` / `data.member` 各层都看一遍；
    //   ② 退回 `onebot.call('get_group_member_info')` —— 旧调用方与测试
    //      给的是裸的 OneBot 客户端（只有 `call`），没有那个封装。
    //   只认一种写法的话，另一半环境里会**静默变成"查不到"** ——
    //   而"查不到"是不报错的，只会表现成界面上一直显示号码。
    if (kind === 'group') {
      if (typeof onebot.getGroupMemberInfo === 'function') {
        const info = await onebot.getGroupMemberInfo(groupId, uid, 2_000)
        if (info?.ok) {
          name = String(info.card || info.nickname || '')
          role = String(info.role || '')
          source = 'get_group_member_info'
        } else {
          reason = info?.reason ?? '协议端没有返回成员资料'
        }
      } else if (typeof onebot.call === 'function') {
        try {
          const res = await onebot.call(
            'get_group_member_info',
            { group_id: Number(groupId), user_id: Number(uid), no_cache: true },
            2_000,
          )
          const m = res?.data?.member ?? res?.data ?? res ?? {}
          name = String(m.card || m.nickname || '')
          role = String(m.role || '')
          if (name || role) source = 'get_group_member_info'
          else reason = '协议端没有返回成员资料'
        } catch (error) {
          reason = error?.message ?? String(error)
        }
      } else {
        reason = '当前协议客户端不支持 get_group_member_info'
      }
    }

    // ── 还不知道名字时，才去好友列表里找 ────────────────────────────────
    //
    // ⚠️ 只在**私聊**走这条路。群里的人不一定是你好友，而且群名片
    //   （上面那个接口）本来就是群里该显示的名字 —— 拿好友昵称去顶替
    //   群名片，会显示成"群里根本没人在用的那个名字"。
    if (!name && kind === 'private' && typeof this.roster?.listFriends === 'function') {
      // ⚠️ 走 roster 的**缓存版**好友列表，不是每次直连协议端。
      //   理由：`get_friend_list` 是全量接口（可能几百人），为了一条消息
      //   拉一遍全量名单，代价和收益完全不成比例；而且配置界面本来就会
      //   拉一次，缓存命中时这里是零成本。
      try {
        const friends = await this.roster.listFriends(
          (action, params, timeoutMs) => this.onebot.call(action, params, timeoutMs),
          { timeoutMs: 2_000 },
        )
        const hit = friends.find((f) => String(f?.userId ?? '') === uid)
        if (hit?.nickname) {
          name = hit.nickname
          source = source ? `${source}+get_friend_list` : 'get_friend_list'
        } else if (!reason) {
          reason = '好友列表里没有这个人'
        }
      } catch (error) {
        if (!reason) reason = error?.message ?? String(error)
      }
    } else if (!name && kind === 'private' && typeof onebot.getFriendList === 'function') {
      // 兜底：测试或旧调用方给的是裸 OneBot 客户端（没有 roster）。
      try {
        const friends = await onebot.getFriendList()
        const hit = (Array.isArray(friends) ? friends : []).find(
          (f) => String(f?.user_id ?? '') === uid,
        )
        if (hit) {
          name = String(hit.nickname ?? hit.remark ?? '')
          source = source ? `${source}+get_friend_list` : 'get_friend_list'
        } else if (!reason) {
          reason = '好友列表里没有这个人'
        }
      } catch (error) {
        if (!reason) reason = error?.message ?? String(error)
      }
    }
    // 群里到头来什么都没查到 —— reason 必须**有话说**。
    // 否则界面上显示"未核实"却不给原因，排查时只能靠猜。
    if (kind === 'group' && !name && !role && !reason) {
      reason = '协议端没有返回这个群成员的资料'
    }

    // ── 会话名：私聊显示"这个人叫什么"，群聊显示"这个群叫什么" ─────────────
    //
    // ★ 这一块**必须放在最后**（发言人昵称都解析完之后）。
    //   第一版顺手写在群成员查询后面，于是私聊那条路径上 `name` 还是空的
    //   ——因为私聊的昵称来自**下面**那个好友列表查询。表现是"私聊会话名一直为空"，
    //   而且不报错。顺序错了不会报错，只会静默为空，所以这里显式说明。
    //
    // ★ 为什么要单独查群名：左边那列会话列表原来只有一个裸号码
    //   （`700000001`），使用者认不出是哪个群。而**群名桥接早就拿到过**
    //   （`get_group_list` 的 `group_name`，配置界面选群时用的就是它），
    //   只是从来没往会话这边传。这是"已经有的信息没有接通"，不是新增查询。
    // ⚠️ 查不到就**留空**，界面显示号码 —— 不编名字（和发言人昵称同一条规矩）。
    let chatName = ''
    let chatNameSource = ''
    try {
      if (kind === 'group' && typeof this.roster?.groupNameOf === 'function') {
        const n = await this.roster.groupNameOf(
          (action, params, timeoutMs) => this.onebot.call(action, params, timeoutMs),
          gid,
        )
        if (n) {
          chatName = n
          chatNameSource = 'get_group_list'
        }
      } else if (kind === 'private') {
        // 私聊：优先用**主人的自称**（人设里的 callerName），因为那是他要看到的名字；
        // 其次是刚核实到的昵称。
        if (this.config.persona?.callerName && this.roster?.tierOfPrivate?.(uid) === 'admin') {
          chatName = String(this.config.persona.callerName)
          chatNameSource = 'persona.callerName'
        } else if (name) {
          chatName = name
          chatNameSource = source
        }
      }
    } catch (error) {
      if (!reason) reason = error?.message ?? String(error)
    }

    const result = {
      ok: Boolean(name || role),
      userId: uid,
      name,
      role,
      // 角色的中文标签。**未知一律留空**，不写"群成员"这种猜出来的话 ——
      // 界面宁可只显示昵称，也不要显示一个可能是错的结论。
      roleLabel:
        role === 'owner' ? '群主' : role === 'admin' ? '群管理' : role === 'member' ? '群成员' : '',
      // 会话名（私聊=这个人叫什么，群聊=这个群叫什么）+ 它是从哪来的。
      // 与发言人昵称**分开两个字段**：一个是"谁在说话"，一个是"这是哪个会话"。
      chatName,
      chatNameSource,
      source,
      reason: reason || undefined,
    }

    // 只在**查到东西**时写缓存。查不到不缓存 —— 否则协议端刚起来那一下的失败
    // 会被记住 5 分钟，表现成"明明是好的却一直显示号码"。
    if (result.ok) {
      if (this.#senderCache.size >= Bridge.SENDER_CACHE_MAX) {
        // 简单淘汰：Map 保持插入顺序，删掉最早的一条即可。
        const oldest = this.#senderCache.keys().next().value
        this.#senderCache.delete(oldest)
      }
      this.#senderCache.set(cacheKey, { ...result, at: Date.now() })
    }
    return result
  }

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
   * @param {{ kind?: string, peerId?: string, createIfMissing?: boolean,
   *           senderId?: string, identity?: object }} [who]
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

      // ── 发言人身份（同步到对话预览）──────────────────────────────────
      // 群聊里一个会话有多个发言人，所以身份要**按人**记在会话上，
      // 并且**每条消息自己带上**当时核实的身份 —— 否则界面上会出现
      // "用最后一个人的名字去标前面所有人的话"这种明显错误。
      const entry = { role, text: String(text ?? ''), at: Date.now() }
      if (who.senderId) {
        entry.senderId = String(who.senderId)
        const id = who.identity ?? null
        if (id?.ok) {
          if (id.name) entry.senderName = id.name
          if (id.roleLabel) entry.senderRole = id.roleLabel
        }
        if (!conv.senders) conv.senders = {}
        // 谁说的这句话：界面按人显示。身份核实失败时只留号码，**不编名字**。
        conv.senders[entry.senderId] = {
          name: id?.ok && id.name ? id.name : '',
          roleLabel: id?.ok ? id.roleLabel ?? '' : '',
          verified: Boolean(id?.ok),
          at: Date.now(),
        }
      }

      // ── 会话名（左边那列要显示的东西）────────────────────────────────
      // `name` = 私聊对方叫什么 / 群聊这个群叫什么；`nameVerified` 说明它是
      // **协议端核实过的**还是我们不知道 —— 界面据此决定"显示名字"还是"只显示号码"。
      // ⚠️ 绝不编名字：不知道就 `nameVerified: false`，界面显示号码。
      if (who.identity) {
        const id = who.identity
        if (id.chatName) conv.name = id.chatName
        if (id.chatName || id.ok) conv.nameVerified = Boolean(id.chatName)
      }

      conv.messages.push(entry)
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
        // ★ 会话名（"这个群/这个人叫什么"）。UI 的会话列表用它做标题；
        //   查不到时它是空串、`nameVerified` 为 false —— 界面显示号码，**不编名字**。
        name: conv.name ?? '',
        nameVerified: Boolean(conv.nameVerified),
        messages: conv.messages.map((m) => ({ ...m })),
        // ★ 发言人身份（协议端核实过的）一并给界面。
        //   深拷贝同样必要：界面序列化时桥接可能正在往里写。
        senders: conv.senders ? Object.fromEntries(Object.entries(conv.senders).map(([k, v]) => [k, { ...v }])) : {},
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

  async #runTurn({ kind, peerId, senderId, tier, rendered, reason, identity = null, imageRefs = [], messageId = null, seq = 0 }) {
    const chatKey = `${kind}:${peerId}`
    // ★ H10：把"这一轮回答的是第几条消息"写进水位 —— 它让"旧回合作废"那套机制
    //   有了显式形式（`lastUserSeq > lastConsumedSeq` = 又来了一条更新的消息）。
    try {
      this.#sessionState?.noteConsumed({ chatKey, seq })
    } catch {
      /* 记不上只是少一条注入，不影响这一轮 */
    }
    // instance 用**构造时固定的那个**（this.sessionInstance），不是每次新生成。
    // 用 `??` 而不是 `||` 是为了兼容测试里直接构造 Bridge 时没设它的情形。
    const sessionId = makeSessionId(kind, peerId, {
      salt: this.config.session?.salt,
      instance: this.sessionInstance ?? this.config.session?.instance,
    })

    // ── "回到第 N 步"：**必须在拼提示词之前**处理 ──────────────────────────
    //
    // 放这里而不是放在回合结束后的原因是：回退要影响**这一轮**模型看到的东西。
    // 若放到回合结束，用户说"回到第 3 步"之后的那一轮模型仍然会照旧往下做，
    // 于是"回退"看起来完全没生效（下一轮才生效，而那时它已经又走了好几步）。
    this.#maybeRollback(chatKey, rendered?.text ?? '')

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
              identity,
              images: imagePlan,
              // ★★ 必须显式传：`#buildPrompt` 是**另一个方法**，拿不到 `#runTurn` 里的
              //    局部变量。这里漏传过一次，代价见 `#warnInjectOnce` 的注释 ——
              //    任务段**在真机上从未注入过**，而且一声不响。
              chatKey,
              // 消息 id（H6）：提示词里要给出它，模型才可能写 `[reply:#id]`
              messageId,
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

      // ── 运行记忆：操作日志 + 任务台账 ────────────────────────────────────
      //
      // 放在这里的三个理由：
      //   ① 在**任何提前 return 之前** —— 超时/作废的回合也真的执行了操作
      //      （写文件、发消息），它们和成功回合一样需要留痕。
      //      这一点与上面记账同理，漏记会让日志看起来"那几步没发生过"。
      //   ② 数据来自**桥接自己收到的完整事件流**（`result.ops`），
      //      不依赖模型报告 —— 诊断已证明那条路漏报率极高。
      //   ③ 两处写失败都只记一行日志，**不影响回合**（观测手段不能弄挂主流程）。
      this.#writeOps(chatKey, result)
      this.#noteTask(chatKey, result, rendered?.text ?? '')
      // 配方抽取：**不 await**（子进程后台跑），每 N 轮一次，失败静默
      this.#maybeExtractRecipe(chatKey, result, rendered)

      // ── 记忆结算（H1）：**必须在两个提前 return 之前** ────────────────────
      // 原先 `superseded` / 超时两条路径直接 return，而记忆标记的处理在它们**之后**，
      // 于是那一轮的记忆提议被静默吞掉（连"没记上"的回执都没有）。
      // 现在无论本轮怎么结束，记忆都在这里结算完 —— 分类规则见 `#settleMemory`。
      //
      // ⚠️ 这一段**必须留在 `token.superseded` 判断之前** —— 第一版改的时候
      //    顺手插在了它后面（因为原来 `const answer` 就在那里），
      //    结果行为完全没变、测试全红，是 `verify-memory-roundtrip.mjs` ⑦-3 抓出来的。
      let answer = markdownToPlain(result.text)
      const settled = this.#settleMemory({
        chatKey,
        kind,
        peerId,
        senderId,
        tier,
        userText: rendered?.text ?? '',
        answer,
        complete: !(result.timedOut || result.aborted),
      })
      answer = settled.answer

      // ── 已被更新的消息取代：不发回复，也不发超时提示 ────────────────────
      // 这一轮**已经烧掉的 token 收不回来**（SDK 无法中止），但没必要再把
      // 一个"过期问题的答案"发出去 —— 那只会让人莫名其妙，而且下一条消息
      // 正在等着处理。对使用者而言效果是"只回了最新那条"。
      if (token.superseded) {
        settle()
        this.log(
          `[bridge] 旧回合已作废，不发送回复（${result.durationMs}ms）` +
            (settled.applied > 0 ? `；但已结算记忆 ${settled.applied} 条` : ''),
        )
        return { handled: false, reason: 'superseded', result }
      }

      if (result.timedOut || result.aborted) {
        settle()
        this.stats.failed += 1
        this.log(
          `[bridge] 回合未正常结束：${result.timedOut ? '超时' : result.abortReason}` +
            (settled.applied > 0 ? `；但已结算记忆 ${settled.applied} 条` : ''),
        )
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

      // ── 记忆标记的处理已经上移到 `#settleMemory`（H1）────────────────────
      //
      // 这里曾经是一整段：剥标记 → 落盘 → 写回执 → 计数。现在它被搬到
      // `#settleMemory` 里、并在**两个提前 return 之前**执行 ——
      // 原因见那里的注释（作废/超时的回合原来会把这一轮的记忆提议整条吞掉，
      // 连"没记上"的回执都没有）。
      //
      // ⚠️ 别再把它搬回来：`answer` 已经在上面剥过标记了。

      // ★ 把思考过程记进镜像（**只给界面看，不发到 QQ**）。
      //   放在"兜底回复"之前：即使这一轮模型一个字都没说，它的思考过程
      //   对使用者仍有价值（能看出它到底干了什么、卡在哪）。
      this.#mirrorThinking(chatKey, result.thinking, { kind, peerId })

      // ── 带内标记（H6）：`[reply:id]` / `[sticker:名]` ─────────────────────
      //
      // 放在"兜底话术"**之前**：一条只写了 `[sticker:偷笑]` 的回复剥完标记就是空串，
      // 若先跑兜底，用户会收到"（我执行了操作但没有输出文字…）"而表情反而不发 —— 荒谬。
      //
      // ★ 标记**无条件剥离**（它是我们的内部协议，绝不能出现在聊天里）；
      //   而"引用/表情**能不能用**"是两件事：
      //   · 引用：id 必须**本会话真的见过**才发（否则 QQ 上是一条指向空气的引用，
      //     甚至可能引用到别的会话去 —— 那是真正的错误）。校验不过是**丢引用、正文照发**。
      //   · 表情：名字必须在 `config.send.stickers` 表里（默认空表 → 不发表情，
      //     只记一行日志）。宁可发不出去，也不猜 id 发错表情。
      const outMarkers = parseOutMarkers(answer)
      answer = outMarkers.text
      for (const n of outMarkers.notes) this.log(`[bridge] 带内标记：${n}`)

      let replyTo = null
      if (outMarkers.replyTo) {
        if (this.#hasSeenMessageId(chatKey, outMarkers.replyTo)) {
          replyTo = outMarkers.replyTo
        } else {
          this.log(
            `[bridge] [reply:${outMarkers.replyTo}] 指向的消息不在本会话近期见过的 id 里 → ` +
              '丢弃这个引用（不猜），正文照发',
          )
        }
      }

      let faceId = null
      if (outMarkers.sticker) {
        const r = resolveSticker(outMarkers.sticker, this.config.send?.stickers ?? {})
        if (r) {
          faceId = r.id
        } else if (!this.#stickerWarned.has(outMarkers.sticker)) {
          this.#stickerWarned.add(outMarkers.sticker)
          const names = stickerNames(this.config.send?.stickers ?? {})
          this.log(
            `[bridge] [sticker:${outMarkers.sticker}] 没有对应的表情（可用：${names.length ? names.join('、') : '（还没配置表情表）'}）→ ` +
              '只剥掉标记，不发表情（不许猜 id，猜错就是发错表情）',
          )
        }
      }

      if (!answer && !faceId) {
        // 规则是"必须回答"。如果模型什么都没说（比如只调了工具就结束），
        // 不能让用户对着空气等 —— 给一个明确的兜底。
        answer =
          result.toolCalls.length > 0
            ? '（我执行了操作但没有输出文字，请再问一次或换个说法。）'
            : '（这次没有产生回复内容，请再试一次。）'
        this.log(`[bridge] 回合结束但无文本输出；事件序列：${result.eventTypes.join(' → ')}`)
      }

      // ── 投递前终检门（H5）：内部东西绝不能出现在聊天里 ────────────────────
      //
      // 为什么放在**隐私闸门之前**：这一步会**改文本**（删掉内部行、剥掉 CQ 码），
      // 而隐私判定必须发生在"**最终要发出去的那串字符**"上 —— 顺序反了就等于
      // 对着一份还没定稿的文本做安全检查。
      //
      // 判为"整条都是内部产物"时**改发一句诚实话术**（hermes 那边是静默不发）：
      // 静默不发的效果是"机器人坏了/被无视了"，而事实只是它内部出了点状况 ——
      // 本项目第 6 条铁律是"失败必须让用户知道"。原文片段只进日志（给排查用）。
      const gated = gateDelivery(answer)
      if (gated.dropped) {
        this.log(
          `❌ [delivery] 拦下整条回复（内部泄漏：${gated.why}）｜` +
            `原文片段：${answer.replace(/\s+/g, ' ').slice(0, 160)}`,
        )
        // 镜像里留痕（只给控制台看）—— 否则使用者会以为模型变成哑巴了，
        // 而实际是投递闸门在工作。
        this.#mirrorThinking(chatKey, `[投递闸门] 拦下整条内部泄漏：${gated.why}`, { kind, peerId })
        answer = LEAK_NOTICE
      } else if (gated.changed) {
        this.log(`[delivery] 投递前清洗：${gated.notes.join('；')}`)
        answer = gated.text
      }

      // ── 隐私：**双侧硬闸的输出侧**（详见 src/privacy.mjs）──────────────────
      //
      // 为什么放在这里（"最后一道门"）：这一刻的 `answer` 是**真准备发出去的那串字符** ——
      // 标记已剥离、兜底话术也已补上。放在更前面会漏掉兜底路径，放在 `#deliver`
      // 里则会漏掉"分片之前还有别的加工"的可能。
      //
      // 为什么必须独立于写入侧：写入侧漏了只是"磁盘上有隐私"（还能删），
      // 输出侧漏了是**已经发给第三方、撤不回**。本项目唯一无法挽回的操作。
      //
      // 处理方式：**不发原文**，改发一句安全话术。为什么不静默丢弃 ——
      // 对方会以为机器人坏了（`AGENT.md` 第 6 条：失败必须让用户知道）。
      // ★ **刻意不做成配置开关**：隐私闸门是"不存隐私/不输出隐私"这条要求的落点，
      //   做成 `privacy.enabled` 就等于给了一个把它关掉的入口 —— 而关掉之后
      //   没有任何提示，表现成"今天开始它什么都说"（那是更难发现的失败）。
      //   要调整只能改代码，且会经过测试。
      const priv = screenForOutput(answer)
      if (!priv.ok) {
        logPrivacyBlock({
          workspace: this.config.dsh?.workspace,
          side: 'output',
          categories: priv.categories ?? [],
          length: answer.length,
          chatKey,
        })
        this.log(
          `[privacy] ⚠️ 输出侧拦下一条回复（${(priv.categories ?? []).join('、')}，${answer.length} 字）：` +
            '改为发送安全话术。原文**没有**发出去。',
        )
        // 镜像里记下"原本想说什么"（只给控制台看，不发 QQ）——
        // 否则使用者会以为模型变哑巴了，而实际是隐私闸门在工作。
        this.#mirrorThinking(chatKey, `[隐私闸门] 拦下一条含隐私的回复（${(priv.categories ?? []).join('、')}）`, {
          kind,
          peerId,
        })
        answer = BLOCKED_OUTPUT_NOTICE
      }

      // 登记进 in-flight：收尾时要等它发完，否则延迟中的回复会被掐死
      const delivering = this.#deliver(kind, peerId, answer, result, { replyTo, faceId })
      this.#inFlight.add(delivering)
      try {
        await delivering
      } catch (error) {
        // ★★ H17：**发送失败**是一条独立的失败路径，语义与"模型没产出"完全不同。
        //
        // 三条纪律（写在这里，因为这是唯一能保证它们的地方）：
        //   ① **绝不重跑模型** —— 重跑要再花一次模型调用，而且可能给出与刚才**不同**的答案
        //      （对方会收到两条互相矛盾的回复，比收不到更糟）；
        //   ② **不自动重发** —— 分片可能已经发出去一半，重发会让对方看到重复内容；
        //   ③ **必须留痕** —— 但**不再走同一条通道去解释**（通道本身就是坏的，
        //      `#safeSend` 只是尽力而为，它失败也会有日志）。这是"失败必须让用户知道"
        //      的一个**已知例外**，理由写在文档里：通道不可用时无法用它传递消息。
        this.stats.failed += 1
        this.log(
          `❌ [delivery] 回复没能发出去：${error?.message ?? error} —— ` +
            '**不重发、更不会重跑模型**（重跑会再花一次模型调用，还可能给出与刚才不同的答案）',
        )
        settle()
        await this.#safeSend(kind, peerId, '⚠️ 我这边没能把回复发出去，你刚才那条可能没收到 —— 请再发一次。')
        return { handled: false, reason: 'send-failed', error: error?.message ?? String(error) }
      } finally {
        this.#inFlight.delete(delivering)
      }
      // 记下"刚回复过的内容"，供去重判断（下一次内容完全相同时直接跳过）
      this.#lastDelivered.set(chatKey, normalized)
      // ★ H10：记一条机器人回复（轮次统计 + "上一轮动了什么" + "我问了他还没答"）
      try {
        this.#sessionState?.noteBot({ chatKey, text: answer, ops: result.ops ?? [] })
      } catch {
        /* 状态记不上不影响回复 */
      }
      settle()
      this.stats.answered += 1
      this.dispatchEvent(new CustomEvent('answered', { detail: { chatKey, result } }))
      return { handled: true, reason: 'answered', answer, result }
    })
  }

  /**
   * 拼出这一轮给模型的提示词。
   *
   * ★ H16：实现已搬到 `src/channel-prompt.mjs` —— 这里只做**状态装配**：
   *   把桥接独有的有状态东西（一次性断线缺口、会话状态、注入告警去重）
   *   通过 `ctx` 传进去。**拼装顺序与措辞在那一边**，于是它可以在不起桥接的情况下被审阅。
   *   ⚠️ 搬动的验收标准是逐字基线（同文件第⑱节），不是"看着像"。
   */
  async #buildPrompt(rendered, reason, opts = {}) {
    return buildChannelPrompt({
      rendered,
      reason,
      ...opts,
      config: this.config,
      personaText: this.personaText,
      log: (m) => this.log(m),
      warn: (what, error) => this.#warnInjectOnce(what, error),
      sessionState: this.#sessionState,
      // ★ 缺口的**所有权仍在桥接**：取用即清（一次性语义不能在搬动中丢掉）
      consumeGap: () => {
        const gap = this.#pendingGap
        this.#pendingGap = null
        return gap
      },
    })
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
    // ★ 先停掉定时整理：它会在收尾过程中重写记忆文件，而收尾本身可能正在
    //   等回复发完 —— 没必要在这个窗口里再去动用户的记忆文件。
    try {
      this.#consolidate?.stop()
    } catch {
      /* 停不掉也不影响收尾 */
    }
    // ★ 语料库：收尾时关连接（不关的话 Windows 上文件句柄会留到进程退出）
    try {
      this.#corpus?.close()
    } catch {
      /* 关不掉无所谓 */
    }
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
  /**
   * ★ H15：给这一次投递落账（**发送之前**）。
   * 失败返回 `null` —— 发送照常进行（增强路径可以失败，但不许安静地失败）。
   */
  #beginDelivery({ kind, peerId, chatKey, chunks }) {
    try {
      const workspace = this.config?.dsh?.workspace
      if (!workspace) return null
      if (!this.#deliveryOwner) {
        this.#deliveryOwner = ownerId({ pid: process.pid, startedAt: PROCESS_STARTED_AT })
      }
      return beginDelivery({
        workspace,
        owner: this.#deliveryOwner,
        kind,
        peerId,
        chatKey,
        chunks,
        log: this.log,
      })
    } catch (error) {
      this.log(`⚠️ [delivery-ledger] 落账失败（这条照常发，只是"正在投递"没留痕）：${error?.message ?? error}`)
      return null
    }
  }

  async #deliver(kind, peerId, answer, result, { replyTo = null, faceId = null } = {}) {
    // 先按"观感"分条（真人不会把 800 字糊在一条里），再按单条上限兜底切分。
    const humanChunks = splitIntoMessages(answer, {
      maxChars: this.config.humanize?.chunkChars ?? 300,
    })
    const limit = this.config.send?.maxCharsPerMessage ?? 1500
    const chunks = humanChunks.flatMap((c) => splitForQQ(c, limit))

    // ★★ H15：**发送前落账**。
    //
    // 为什么必须在**发送之前**（而不是发完再记一笔）：真机上丢过一整条回复 ——
    // 拟人延迟 116 秒期间使用者重启了桥接，通道断开，那条**已经生成好、钱已经花过**的
    // 回复永远消失，而日志里只有一行"发送失败"，没人能回答"丢的是哪条、给谁的"。
    // 落账之后，"正在投递中"这件事在任何时刻都是可查的。
    //
    // ⚠️ 落账**失败不影响发送**（它是增强路径），但会留日志（第 9 条）。
    const ticket = this.#beginDelivery({ kind, peerId, chatKey: `${kind}:${peerId}`, chunks })

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

    // ── 发送（H6：引用段只跟第一条；表情段只跟最后一条）──────────────────
    //
    // 为什么引用只跟第一条：每条都带引用气泡 = 刷屏，而且 QQ 只在你"回复某条消息"
    // 时有意义 —— 那是**一次**动作，不是每片都做一次。
    // 为什么表情跟最后一条：读起来是"说完了，再给个表情"，与真人一致。
    // 为什么"只有表情、没有正文"时也要能发：那正是表情的典型用法。
    if (chunks.length === 0 && faceId) {
      const key = deliveryKey({ chatKey: `${kind}:${peerId}`, text: '', faceId })
      const verdict = this.sendQueue.check(`[face:${faceId}]`, key)
      if (verdict.ok) {
        if (verdict.waitMs > 0) await this.#sleepUnlessClosing(verdict.waitMs)
        await this.onebot.send(kind, peerId, '', { replyTo, faceId })
        this.sendQueue.markSent(`[face:${faceId}]`, key)
        this.#mirror(`${kind}:${peerId}`, 'bot', `[表情 ${faceId}]`, { createIfMissing: false })
      } else {
        this.log(`[bridge] 跳过发送表情：${verdict.reason}`)
      }
    }

    for (const [i, chunk] of chunks.entries()) {
      const isFirst = i === 0
      const isLast = i === chunks.length - 1
      // ★ H9：去重键带上**会话**（以及引用/表情）。用裸文本当键时，
      //   「同一句话在 8 秒内发给两个不同的会话」会被误判成重复而丢掉第二个 ——
      //   而 SendQueue 是**整个桥接共用一个**的。
      const key = deliveryKey({
        chatKey: `${kind}:${peerId}`,
        text: chunk,
        replyTo: isFirst ? replyTo : null,
        faceId: isLast ? faceId : null,
      })
      const verdict = this.sendQueue.check(chunk, key)
      if (!verdict.ok) {
        this.log(`[bridge] 跳过发送：${verdict.reason}`)
        continue
      }
      if (verdict.waitMs > 0) await this.#sleepUnlessClosing(verdict.waitMs)

      // 校验之后可能又过了时间，再查一次（简单但有效）
      const recheck = this.sendQueue.check(chunk, key)
      if (!recheck.ok) {
        this.log(`[bridge] 发送前复检跳过：${recheck.reason}`)
        continue
      }

      try {
        await this.onebot.send(kind, peerId, chunk, {
          replyTo: isFirst ? replyTo : null,
          faceId: isLast ? faceId : null,
        })
        this.sendQueue.markSent(chunk, key)
        // ★ H15：这一片确认发出去了 —— 账本上标掉（崩溃时留下的 pending 就是没标上的那些）
        ticket?.markSent(i)
        // 真正发出去的才记进镜像（节流跳过的那些不算"说过的话"）
        this.#mirror(`${kind}:${peerId}`, 'bot', chunk, { createIfMissing: false })
        // ★ H7：自己说过的话也要进语料库（"我上次说的那个方案"要搜得到）。
        //   `messageId` 留 null：协议端返回的 message_id 我们目前没接，
        //   而 UNIQUE 允许 NULL 重复（SQLite 语义），所以不会互相顶掉。
        this.#recordCorpus({ kind, peerId, text: chunk, isBot: true, replyToId: replyTo })
      } catch (error) {
        this.log(`[bridge] 发送失败：${error.message}`)
        // ★ H15：这一轮明确失败了（与"崩溃留下的 pending"是两回事，要能分开看）
        ticket?.fail(error.message)
        throw error
      }
    }

    ticket?.finish()

    this.log(
      `[bridge] 已回复 ${kind}:${peerId}（${answer.length} 字，${chunks.length} 条，` +
        `思考+工具 ${result.durationMs}ms，工具 ${result.toolCalls.length} 次，拟人延迟 ${Math.round(delayMs / 1000)}s` +
        `${replyTo ? `，引用 #${replyTo}` : ''}${faceId ? `，表情 ${faceId}` : ''}）`,
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
