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
// 只为一件事：把选中的表情包图片读成 base64（桥接自己发图，见 `#decideSticker`）
import { readFileSync as nodeReadFileSync } from 'node:fs'
import { decideTrigger, REASON } from './trigger.mjs'
import { renderSegments, markdownToPlain, splitForQQ } from './text.mjs'
import { computeReplyDelay, isQuietNow, splitReplyForSend } from './humanize.mjs'
// 记忆：桥接托管（见 memory-store.mjs）。旧的 memory.mjs 仍被 mocks 引用，
// 但它那段"让模型自己去读写笔记"的指令已经**不再进入提示词**。
import {
  applyMemoryItems,
  buildMemoryInstructionsV2,
  listMemoryFiles,
  migrateMemoryLayout,
  parseMemoryMarkers,
  readMemoryForPrompt,
  saveSnapshot,
  SCOPE,
  takeReceipt,
  verifyAndRestoreMemory,
  writeReceipt,
} from './memory-store.mjs'
import { parseRememberRequest } from './memory-keyword.mjs'
// 情绪倾注的**确定性识别**：与关键词直写同理 —— "必须记下来"的事不能挂在模型自觉上。
import { affectEntryText, detectAffectPour } from './affect-cues.mjs'
// 承诺通道：**作出承诺必须记录**（双向；机器人那侧只在真的会发出去时才算数）。
import { detectPromise, promiseEntryText } from './promises.mjs'
// 个人层的**行为统计**（0.2.9 决定纳入）：确定性累加，只记数字不记内容。
import { notePersonTurn } from './people-stats.mjs'
// ★★ 情绪闸门（2026-09-30）：给"**未被唤醒**但有情绪信号"的消息加一道判定器。
//   默认 `off`（一个字都不问、不记）；`shadow` 只记账不写盘；`judge` 才写。
//   为什么不能直接把确定性判定前移到唤醒之前 —— 实测那批误记率 4/5，理由在模块头。
import { createAffectGate, GATE_VERDICT, isPrewakeMode, normalizePrewakeMode, PREWAKE } from './affect-gate.mjs'
import { appendAuditEntry } from './memory-audit.mjs'
import { createConsolidateScheduler } from './memory-consolidate.mjs'
import { gateDelivery, LEAK_NOTICE } from './delivery-gate.mjs'
import { parseOutMarkers, resolveSticker, stickerNames, renderMarkerInstructions } from './markers.mjs'
import { createCorpus, renderSearchResults } from './corpus.mjs'
import { deliveryKey, describeGap, stickerFingerprint } from './transport.mjs'
import {
  buildStickerCandidates,
  buildStickerSelection,
  labelCoverage,
  markStickerFailed,
  markStickerSent,
  appendStickerDecision,
  readStickerLibrary,
} from './sticker-library.mjs'
import { decideSticker, toDecisionRecord, renderStickerPromptLines, renderStickerPersonaNote } from './sticker-decision.mjs'
import { readStickerUsage, recordStickerFailure, recordStickerSent } from './sticker-quota.mjs'
import { activeLabelById, activeLabelIds } from './sticker-vocab.mjs'
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

/**
 * 「你被叫到之前，群里刚说了什么」的两条上限（2026-09-30）。
 *
 * `SCAN` 是**先取多少条**（好在里面找"机器人上一条发言"当前后分界），
 * `MAX` 是**最终塞进提示词几条**。两者分开是因为前者是查找窗口、后者是成本上限。
 */
const RECENT_CTX_SCAN = 16
const RECENT_CTX_MAX = 6
/** 单条上限（字）：够看清"刚才在说什么"，又不至于把一段长文整段搬进提示词。 */
const RECENT_CTX_CHARS = 150
/**
 * `servers[].manageOnStart` 拉起服务端后，最多等它开放端口多久（默认 3 分钟）。
 *
 * ★ 默认这么长是因为模组服**首次**启动要生成世界、加载几百个 mod，实测能到 1~2 分钟；
 *   可用 `servers[].startWaitMs` 覆盖。
 * ★ 必须有上限：等不到就**如实说它没起来**，而不是无限等下去
 *   （无限等会让 start.bat 永远不返回，使用者连界面都看不到）。
 */
const DEFAULT_START_WAIT_MS = 180_000
/**
 * **本地指令通道**（0.3.2 收尾）：管理员在群里发 `\mc <命令>`，桥接**自己执行**。
 *
 * ★★★ 这条路与"模型调工具"那条路的根本区别：**模型一次都没被叫醒**。
 *   所以它没有"伪造授权文件"那个上限（见 `src/servers/command-gate.mjs` 的边界说明），
 *   权限判据就是桥接手里那份 `roster.decide()` 的结论。
 *
 * ★★ 两条设计纪律（都写在设计文档 §11「本地指令通道」那一条里）：
 *   ① 它必须在**语义唤醒闸门之前**命中且**立即 return** —— 放在后面会静默失效：
 *      `semantic` 模式下"来下指令"可能被判成"该沉默"，命令白下；
 *   ② **只有管理员**能用（`tier === 'admin'`）。非管理员发这个形状的文本时
 *      **不是**"拒绝并解释"，而是**当作普通聊天**（否则等于告诉所有人"这里有后门"）。
 *   ③ 参数消歧**不能靠正则**：`\mc list` 里的 `list` 是命令不是 id（实测踩到）。
 *      判据是"第一个词是不是配置里真实存在的 id"。
 *   ④ 形状判据必须**纯同步**（`looksLikeMcCommand`），普通消息不产生额外 `await` ——
 *      见那个函数的注释（无条件 `await` 会扰动原有时序，代价很大）。
 * ★ 形状判据：**反斜杠（对外格式）与一到两个斜杠都认**（`\mc list` / `/mc list` / `//mc list`）——
 *   与 `bind`/`unbind` 那条通道保持同一个口径（使用者把对外写法定成了 `\`，见
 *   `parseGameBindRequest` 里那条实测）。
 *   不这么写的话，`\mc list` 会**既不走绑定通道、也不走控制台通道**，
 *   而是掉进普通聊天（模型会瞎答一句），那是最难查的一种"没反应"。
 */
const MC_COMMAND_SHAPE = /^[\\/]{1,2}mc(?:\s|$)/i
/**
 * 这条文本**看起来**是不是 `/mc` 指令（**纯同步、零副作用**）。
 *
 * ★★ 为什么单独抽一个同步判据（而不是直接 `await` 那个 async 处理器）：
 *   它让"普通聊天消息不产生任何额外 `await`"成为**结构上的保证**。
 *   实测教训：无条件 `await` 会扰动"主动回合 vs 随后到达的用户消息"那条竞争，
 *   使 `verify-schedule` 报 `unsettled top-level await`（退出码 13）——
 *   那种失败看起来与本地指令毫无关系，极难定位。
 * ★ 形状判据**只看开头**：必须以 `/mc`（或 `//mc`）作为一个词开头，
 *   所以群里聊到"那个 \mc 命令"**不会**命中。
 */
function looksLikeMcCommand(text) {
  return MC_COMMAND_SHAPE.test(String(text ?? '').trim())
}

/**
 * **绑定指令通道**（0.3.2 P3）：群里发 `\mc bind <码>`（+ `\mc unbind <目标>`），桥接自己处理。
 *
 * ⚠️ 2026-10-04 流程改动后，这条通道**寄居在 `mc` 前缀下**（原来是 `/绑定`），
 *   对外格式是**反斜杠**（使用者的口径：游戏里 `/` 开头会被当命令、进不了日志；
 *   群里两个字符本来无所谓，但两处用同一个格式对使用者更省事）。
 *   斜杠那几个形状**也认** —— 见 `parseMcBindCommand` 的注释。
 *   `bind` / `unbind` 在 `mc` 下是**保留字**。
 *
 * ★★★ 插入点是**刻意的**（与 `/mc` 那条**不一样** —— 那条在唤醒判定之后）：
 *     · 必须在**唤醒判定（`decideTrigger`）之前**：群里发 `\mc bind 123456`
 *       是**不会 @ 机器人**的（谁会为了一串码去 @ 它），而唤醒判定对"没 @ 也没命中
 *       关键词"的群消息直接 return ⇒ 放在它后面等于**这条通道根本不存在**；
 *     · 必须在**语义唤醒闸门之前**：闸门可能判"沉默"，于是"玩家来绑定却被判沉默，
 *       这一步白做了"；
 *     · 必须在**群白名单之后**：否则等于给所有群开后门（下面复用 `roster.isGroupAllowed`）。
 * ★ 命中即 `return`：这一轮**一次模型调用都不产生**（省钱，也不给模型"看到这条码"的机会）。
 * ★ 判据是**纯同步**的（同 `looksLikeMcCommand` 那条纪律：普通消息不产生额外 `await`，
 *   否则会扰动"主动回合 vs 随后到达的消息"那条竞争，`verify-schedule` 会以
 *   `unsettled top-level await` 的形式变红，而看起来与这里毫无关系）。
 */
function looksLikeBindCommand(text) {
  return /^[\\/]{1,2}mc\b/i.test(String(text ?? '').trim())
}

// ★ P3/收尾用到的几个：读服务器控制台（`readServerConsole`）。
//   为什么在这里 import 而不是动态：它们只是 `node:fs` 的普通函数，没有加载成本。
import { closeSync, copyFileSync, existsSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
// ★ 控制台日志的解码（真机是 **GBK**，不是 UTF-8 —— 见 `log-source.mjs` 文件头）
import { decodeConsoleBytes } from './servers/log-source.mjs'
// ★ 启动窗口：把"正在启动"与"挂了"分开（判据只有一处，监测与界面共用）
import { clearStarting, describeStarting, evaluateStarting, markStarting, readStarting } from './servers/starting.mjs'
import { noteTurn, noteMemoryAttempt, zeroWriteAlert, STATS_DEFAULTS } from './memory-stats.mjs'
import { screenForOutput, logPrivacyBlock, BLOCKED_OUTPUT_NOTICE } from './privacy.mjs'
import { appendTurnOps, appendOp } from './oplog.mjs'
import { readTask, renderTaskBlock, noteTaskTurn, parseRollback, rollbackTask } from './tasks.mjs'
// ★ 服务端的 `server.properties`（0.3.2 收尾）：界面上的「RCON 一键配好」走这两个模块。
//   ★★ 必须是**模块级 import**（不是块内局部别名）—— 路由对象会引用它们，
//   而"块级局部别名被路由对象引用"正是 `listScheduleTasks is not defined` 那次事故的形状
//   （见 `mocks/verify-route-scope.mjs`）。
import {
  EULA_FILE,
  PROPERTIES_FILE,
  describeServerSettings,
  patchServerSettings,
  readEula,
  readServerSettings,
  readTextFile,
  resolveEulaPath,
  resolvePropertiesPath,
} from './servers/properties.mjs'
import { listRecipes, pickRecipes, renderRecipeBlock, upsertRecipe } from './recipes.mjs'
import { extractRecipe, runDirect, DEFAULT_EVERY_N as EXTRACT_DEFAULT_EVERY_N } from './extract.mjs'
import { createWakeJudge, judgeTransport, JUDGE_DEFAULTS as WAKE_JUDGE_DEFAULTS, VERDICT as WAKE_VERDICT } from './wake-judge.mjs'
import { resolveDirectTarget, resolveExtractTarget } from './model-direct.mjs'
import { buildPermissionInstructions, createRoster } from './roster.mjs'
import { createInterimPicker } from './interim.mjs'
import { buildPersona, mergeWakeKeywords } from './persona.mjs'
import { resolveActivePersona } from './personas.mjs'
import { personaVoiceSections } from './persona-sections.mjs'
import { ensureProjectDocCopy } from './project-doc.mjs'
import { buildChannelPrompt } from './channel-prompt.mjs'
import { collectSkillPromptSections, isSkillEnabled, skillToolFullName, callSkillAvailable } from './extensions.mjs'
import { nicknameFor } from './contacts.mjs'
import { createImageInbox, collectImages } from './images.mjs'
import { createScheduleRunner } from './schedule-runner.mjs'
import {
  claimEventFire,
  listTasks,
  noteHistory,
  noteKnownChat,
  readKnownChats,
  renderScheduleTaskBlock,
  renderServerEventBlock,
  settleFire,
} from './schedule.mjs'
import { createServerLoop } from './servers/loop.mjs'
import { createRestarter } from './servers/restart.mjs'
import { runConsoleCommand } from './servers/console.mjs'
import { runMcCommand } from './servers/command-gate.mjs'
// ★ 0.3.2 P3：游戏内对话（绑定表 / 回应通道 / 读控制台的循环）
import {
  bindByCode,
  countCodes,
  issueCodeFor,
  listBindings,
  lookupByName,
  lookupByUuid,
  parseGameBindRequest,
  parseMcBindCommand,
  shortUuid,
  unbindByName,
} from './servers/bindings.mjs'
import { buildPublicChat, buildTellraw, chunkForChat, PLAYER_NAME_RE } from './servers/tellraw.mjs'
import { createGameChatLoop, decideGameChat, unboundReminder } from './servers/game-chat.mjs'
import { createSupervisor, defaultPortOpen as defaultPortProbe } from './servers/supervise.mjs'
// ★ 截图技能的管理员硬闸：把"这一轮谁在说话、是不是管理员"写成一份**按会话**的
//   授权文件，供 MCP 子进程里的技能读取（理由与边界见那个文件的文件头）。
import { writeGrant, clearGrant } from './screenshot-grant.mjs'
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
   * 唤醒判定器（0.2.3，**实验性**：`wake.policy = 'semantic'`）。
   *
   * ★ **懒建 + 只建一次**，两个理由缺一不可：
   *   · 懒建：`wake.policy` 是**活配置**（`/api/extensions` 会就地把配置文件对象
   *     改掉），构造时若写死 `null` 就再也开不了判定器 → 那样这个插件就是 cold 的。
   *     懒建之后闸门每轮现读 policy ⇒ **hot**，与 `src/plugins.mjs` 里那条 `why` 一致。
   *   · 只建一次：判定器带一个"本小时用了几次"的滑动窗口，每条消息重建
   *     等于把 `wake.judge.maxPerHour` 这个成本上限变成摆设。
   * @type {{judge: Function, budget: Function}|null}
   */
  #wakeJudge = null

  /**
   * ★★ 情绪闸门（2026-09-30）：判"未被唤醒但有情绪信号的那句话是不是在跟机器人说"。
   *
   * 与唤醒判定器同样**懒建 + 只建一次**：档位（`memory.affect.prewake`）每次现读
   * ⇒ 改完下一轮就生效；而小时预算必须跨消息累积，所以只能建一个。
   * @type {{judge: Function, budget: Function}|null}
   */
  #affectGate = null

  /**
   * 上一次记过日志的"人设形状"签名（`has:说话方式…` / `none:3`）。
   *
   * 为什么要记：说话方式现在**就在人设文件里**，"这份人设到底有没有那一节"只能靠日志回答 ——
   * 它在提示词里看不出来（散文人设与多节人设最终都是"一段人设文本"）。
   * 按签名去重：人设要重启才换，但同一个形状不必每轮刷屏。
   * @type {string}
   */
  #personaShapeLogged = ''
  #personaStrategyLogged = ''

  /**
   * 每个会话"正在飞的那次判定"的取消柄（chatKey → AbortController）。
   *
   * 为什么要有它：判定要 3~5 秒，而这期间同一会话又来了新消息时，旧判定
   * 的结论已经**指向一个过期的问题** —— 让它继续跑既浪费一次模型调用，
   * 又可能让它把新消息当成旧上下文来否决。新消息到来 = 旧的立刻让路。
   * （设计文档 §10.3 说这一步"可选、非必需"，但既然 `runHeadless` 现在
   *   能真的 `kill()` 子进程，那它就值得做 —— 它不是"少等一下"，是**少烧一次调用**。）
   * @type {Map<string, AbortController>}
   */
  #wakeAborts = new Map()

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
  /** 直连不可用的降级只喊**一次**（每 5 轮一条同样的告警会把该看的那行埋掉）。 */
  #extractFallbackLogged = false

  /**
   * 定时整理记忆的调度器（H2，见 `memory-consolidate.mjs`）。
   * `attach()` 里启动、`close()` 里停掉；null = 没启用（记忆关着或没有工作区）。
   * @type {{start: Function, stop: Function, tick: Function}|null}
   */
  #consolidate = null

  /**
   * 定时任务的执行器（0.3.2 P1，见 `schedule-runner.mjs`）。
   *
   * `attach()` 里启动、`close()` 里停掉；null = 没启用（`schedule.enabled=false` 或没有工作区）。
   * ★ 与 `#consolidate` **刻意分成两个定时器**：整理记忆是"重写文件"、定时任务是
   *   "主动说话"，两者的失败后果与空闲要求都不同（任务**不要求空闲** ——
   *   到点了就该发，最多排队等会话锁）。
   * @type {{start: Function, stop: Function, tick: Function, stats: Function}|null}
   */
  #schedule = null

  /**
   * 服务器监测循环（0.3.2 P2，见 `servers/loop.mjs`）。
   *
   * `attach()` 里启动、`close()` 里停掉；null = 没启用（没有配置服务器 / 没有工作区）。
   * ★ 默认**不建**：`config.servers` 为空时它一次网络请求都不发，也不起定时器。
   * @type {{start: Function, stop: Function, tick: Function, stateOf: Function}|null}
   */
  #serverLoop = null

  /**
   * 每一条事件型任务**上次自动播报**的时刻（内存态，只为冷却）。
   *
   * ★ 为什么可以不落盘：冷却的语义是"别刷屏"，重启后重新开始计时完全可接受
   *   （而"重启后重复播报"这件事由**事件台账**挡住 —— 那才是必须落盘的那一半）。
   * @type {Map<string, number>}
   */
  #lastServerAnnounce = new Map()

  /**
   * 服务端守护器与重启编排（0.3.2 P4）。
   *
   * **懒建**（第一次真需要时才建）：它们要读盘上的归属档、还要连端口探针，
   * 而绝大多数部署根本没配服务器 —— 懒建让"没配服务器"这条路**一行 IO 都不做**。
   */
  #supervisor = null
  #restarterFor = new Map()
  /** 最近一次重启处置的结论（给界面/巡检看；**内存态**，重启即失）。 */
  #lastRestartOutcome = null

  /**
   * **测试用**的注入口：替换"查归属"与"端口探针"。
   *
   * ★ 为什么需要它（不是为了好看）：`down → 重启` 这条链里有两处**只能靠真进程与真端口**
   *   才有结果的东西（归属证据、端口是否释放）。不给注入口的话，这条链
   *   **永远只能靠真机验** —— 而本项目最贵的缺陷恰好是接线（"任务段从未注入过"那次）。
   * ★ 它只影响**这两个探针**，重启的判据（冷却/次数/归属纪律）一个都不放宽。
   */
  setServerProbesForTest({ ownership, portOpen, launch } = {}) {
    // ★★ 判据是 `!== undefined`，**不是"传了没有"** —— 第一版把没传的写成 `null`，
    //   于是 `setServerProbesForTest({ownership, portOpen})` 会把 **launch 也清掉**，
    //   结果"归属是我的"那条链被 `no-launcher` 拦住（实测抓到的接线错）。
    //   ∴ 只覆盖**显式给了的**那几个探针。
    if (ownership !== undefined) this.#testOwnership = typeof ownership === 'function' ? ownership : null
    if (portOpen !== undefined) this.#testPortOpen = typeof portOpen === 'function' ? portOpen : null
    if (launch !== undefined) this.#testLaunch = typeof launch === 'function' ? launch : null
    this.#restarterFor.clear() // 让下一次重启编排用新的探针
  }
  #testOwnership = null
  #testPortOpen = null
  #testLaunch = null
  /** **测试用**：把"等端口/等恢复"的时长与 sleep 换掉（生产路径不设，用默认值）。 */
  #testRestartTiming = null

  setRestartTimingForTest(timing) {
    this.#testRestartTiming = timing && typeof timing === 'object' ? timing : null
  }

  /**
   * **测试用**的注入口：替换"往游戏里发一条命令"的那个执行器（0.3.2 P3）。
   *
   * ★ 为什么需要它：游戏内那条通道的**每一次发言都要真连一台 RCON**（`say` / `tellraw`），
   *   不给注入口的话，"游戏里说一句话 → 模型 → 回复发到公屏"这条链
   *   **永远只能靠真机验** —— 而本项目最贵的缺陷恰好是接线。
   * ★ 它只替换**执行器**：命令**怎么构造**（`buildPublicChat` / `buildTellraw` 的校验与模板）
   *   一个都不放宽 —— 测试里能看到的正是真机上会发出去的那串命令。
   */
  setGameConsoleForTest(runner) {
    this.#testGameConsole = typeof runner === 'function' ? runner : null
  }
  #testGameConsole = null

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

  /**
   * ★ 0.3.2 P3：读游戏内聊天的循环（`null` = 一台服务器都没开 `gameChat`）。
   * @type {{start:Function, stop:Function, tick:Function, isRunning:Function, stats:Function}|null}
   */
  #gameChat = null

  /**
   * ★ 0.3.2 P3：**这一趟进服已经提示过"怎么绑定"的人**（`serverId:玩家名`）。
   *
   * 为什么必须记：设计文档 §13.1 拍板"未绑定提醒 **每次进服最多一次**"——
   * 刷屏的提示等于没有提示。玩家 `join` 时清掉他那一项（下次进服再提示一次）。
   * ★ 只在内存：桥接重启会让所有人重新收到一次提示。这是**刻意的取舍**
   *   （落盘要多一份状态，而"重启后多提示一次"的代价只是一句话）。
   */
  #gameReminded = new Set()

  /**
   * ★ 0.3.2 P3：**游戏名 → UUID**（`serverId:玩家名` → uuid）。
   *
   * 来源有两处，都要用（缺一个就会出现"明明在玩却说不知道你是谁"）：
   *   · `UUID of player X is <uuid>` —— 玩家**一登录就写**，不用他说话、也不用还在线；
   *   · 绑定表里记着的名字（`lookupByName`）—— 跨重启仍认得出老玩家。
   * ★ 也只在内存：它只是"这一次会话内的快捷索引"，真正的映射在绑定表里。
   */
  #gameUuids = new Map()

  /** 已经报过"表情名字不在表里"的名字（同一个名字只报一次，防刷屏）。 */
  #stickerWarned = new Set()

  /**
   * 表情包：每个会话**最近发过的图**（环形，内存即可）。
   *
   * 为什么放内存就够：它唯一的用途是"打分时给刚用过的图扣分"，
   * 而"刚用过"的时间尺度就是几句话 —— 重启桥接后丢了也无所谓
   * （真正的持久状态是用量台账 `stickers/usage.json`，那个必须落盘）。
   *
   * chatKey → string[]（rel 路径，最新的在最后）
   */
  #recentStickers = new Map()

  /** 表情包：每个会话处理过多少轮（"每 N 轮最多一次"这条配额要用）。 */
  #stickerTurns = new Map()

  /** 每个会话记多少条"最近发过的图"。 */
  static STICKER_RECENT_MAX = 8

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
  constructor({ rpc, onebot, sendQueue, router, config, usageLedger = null, roster = null, interimPicker = null, imageInbox = null, skills = null, wakeJudge = null, affectGate = null, modelApiKey = '', readServers = null, log = () => {} }) {
    super()
    this.rpc = rpc
    this.onebot = onebot
    this.sendQueue = sendQueue
    this.router = router
    this.config = config
    /**
     * 现读盘上的服务器列表（0.3.2 收尾「改配置即时生效」）。
     * ★ 返回 `null` = 读不到（沿用内存那份）；返回**数组** = 这就是现在的真相（含空数组）。
     *   两者混同会在文件短暂写坏时**静默停掉监测** —— 见 `index.mjs` 的注入点注释。
     */
    this.readServers = typeof readServers === 'function' ? readServers : null
    // ── 唤醒判定器（0.2.3）：**可注入** ──────────────────────────────────
    // ★ 为什么留这个口子：判定器正常路径要**起一次性 DSH 子进程**，那在测试里
    //   既慢又不可控（受限沙箱里还会 EPERM）。注入一个桩之后，测的就不再是
    //   "模型会怎么判"（那是人品问题），而是**桥接拿判定结论做了什么** ——
    //   而这一层恰恰是最容易接错的地方（本项目已经栽过一次：任务段的 `chatKey`
    //   不在作用域、被空 catch 吞掉，124 项纯函数断言全绿，而那个段在真机上
    //   从未注入过）。同一套辩证法在这里复用：**接线必须有它自己的断言。**
    //   不传 = 按配置现造（生产路径）。
    this.wakeJudgeInjected = wakeJudge
    // ── 情绪闸门（2026-09-30）：**同样可注入**（理由与上面那段完全一样）─────
    //   它的正常路径也要问一次模型；而这里要断言的恰恰是**桥接拿这个结论做了什么**
    //   （影子模式写没写盘、判定说不通过时有没有手滑写进去、`off` 时有没有白花钱）。
    this.affectGateInjected = affectGate
    // ── 主模型 key（0.2.9）：给**回合后抽取**走直连用 ──────────────────────
    // ★ 为什么由 `index.mjs` 传进来而不是在这里解析：主对话那条路的凭据是启动时
    //   用 `resolveModelCredentials()` 一次性解析的（含 `DSH_HOME/.credentials.yaml`
    //   那条回退）。桥接自己**不知道 `DSH_HOME`**（那是 `local.mjs` 的知识），
    //   在这里重算一遍就会长出第二份"key 从哪来"的逻辑 —— 而两份迟早不一致。
    // ★ 它**不进 config 对象**：`/api/config` 会脱敏 `dsh.apiKey`，而随手挂到 config
    //   上的字段没有那层保护，等于把明文 key 交给界面。
    this.modelApiKey = String(modelApiKey ?? '')
    // ── 外部技能（0.2.2）──────────────────────────────────────────────────
    // ★ 这里只拿到**已发现的技能清单**（index.mjs 在启动时扫一次）。
    //   `promptSections()` 是每轮现调的（纯函数），所以界面上开关技能**下一轮就生效**，
    //   不需要重启桥接 —— 那正是"随时开关"在提示词侧的那一半。
    //   不传（旧调用方/测试）时退化成"没有技能"，提示词一个字都不变。
    this.skills = Array.isArray(skills) ? skills : []
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

    // ── 项目简介的副本（0.2.2）：让 agent **需要时能自己读** ────────────────
    // ★ 为什么要有它：`docs/项目简介.md` 在**包外**，而 agent 的沙箱根是工作区 —— 它读不到。
    //   于是"你能不能删我的文件 / 你能做什么"这类问题只能凭提示词里那一小段权限说明猜。
    //   这里启动时把文档复制进 `store/`（**不是** `memory/`：那会被当记忆注入、还被篡改检测扫），
    //   提示词里只留**一行**指针，模型需要时用 read 只读它要的那一节。
    // ★ 写失败/源文档不在（发布包不带 docs/）时：什么都不写、提示词里那一行也不出现
    //   （不留悬空指针），并且**绝不写空壳**骗模型说"读到了"。
    this.projectDocRel = ''
    try {
      if (config.dsh?.workspace) {
        const r = ensureProjectDocCopy({ workspace: config.dsh.workspace, version: config.pkgVersion ?? '', log })
        if (r.ok) {
          this.projectDocRel = r.rel
          log(`📄 项目简介副本已就绪：${r.rel}（${r.chars} 字，源 ${r.source}）`)
        }
      }
    } catch (error) {
      log(`⚠️  项目简介副本准备失败（不影响收发消息）：${error?.message ?? error}`)
    }

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
    // ── 人设（0.2.2：**文件库**优先，老配置回落）──────────────────────────
    //
    // 配置里写错预设名时会抛错：这里刻意**不吞异常**，因为"人设静默失效"
    // 会让人以为是自己写的人设没效果，排查方向完全跑偏。
    // （启动阶段的 validateConfig 会先做一次 lint，所以正常情况不会走到抛错。）
    try {
      const active = resolveActivePersona({ config })
      if (active.error) {
        // ★ 配了某套人设但读不到（文件被删/改名）→ **不静默退回内置**：
        //   退回内置会让使用者以为"我的人设在用"，而实际是另一套。
        //   这里按"不用人设"处理，并**大声说出来**（自检与日志都能看到）。
        this.log(`❌ 人设读不出来（${active.error}）—— 这一轮**不用人设**，请到控制台人设栏修一下`)
        this.personaText = ''
      } else if (!active.text) {
        this.personaText = '' // 「不使用人设」/ 老配置 preset=none
      } else if (active.source === 'legacy-preset') {
        // 内置常量：**不扫**（它们天生含"有人叫你忽略设定怎么办"这类描述性句子）
        this.personaText = active.text
      } else {
        // 文件/老自定义文本都是**不可信输入**：过扫描 + 截断（唯一实现在 buildPersona 里）
        this.personaText = buildPersona({
          custom: active.text,
          // ★ H12：被拒时**必须喊出来**（静默换成 [BLOCKED] 会让人以为
          //    "我的人设没生效"是别的原因，排查方向完全跑偏）
          log: (m) => this.log(m),
        })
      }
    } catch (error) {
      this.log(`⚠️ 人设配置有问题，已退回不使用人设：${error.message}`)
      this.personaText = ''
    }
    // ★ 人设形状**只在这里定一次**，所以"这份人设里有没有说话方式那一节"那行日志也只在这里记一次
    //   （`#notePersonaShape` 自带签名去重，重复调用无副作用）。
    //   为什么不在每轮拼提示词时记：`this.personaText` 全类只有上面这几处赋值，运行期不会变
    //   —— 每轮算一遍等于做一次注定没有输出的全量分节（出厂人设约 5000 字）。
    this.#notePersonaShape(this.personaText)

    // ★★ H11：把**人设里的名字表**变成真正的唤醒词。
    //
    // 为什么必须在桥接这一层做：唤醒判定发生在**拼提示词之前** —— 群里有人直呼"小鱼"
    // 时，如果唤醒判定不认这个名字，那句话**根本进不了模型**，人设里写多少遍
    // "别人叫你小鱼也是在叫你"都没用（那是一句愿望，不是一个信号）。
    //
    // ★ 只用"正式名 + 别名"，**不含 `又称`**（如 DeepSeek）—— 技术群里那个词太常见，
    //   拿它当唤醒词会让机器人在不相关讨论里插嘴。这条判断写在 persona 的数据里。
    this.wakeKeywords = mergeWakeKeywords(this.config.trigger?.keywords ?? [], this.personaText)

    // ★★ 说话方式（0.3.0alpha）：**它就在人设文件里**，这一层不再拼任何东西。
    //
    //   演进到这里经过了两步（读注释的人容易以为是同一件事，所以写清）：
    //     · 0.3.0beta：说话方式是 `styles/<名字>.md`，**每轮现读**，闲聊态才替换人设的
    //       【怎么说话】【别变成客服】两节；
    //     · 0.3.0alpha 第一步：双态拆掉，口径搬进 `src/voice.mjs` 的常量，由
    //       `composeVoice()` 每轮替换那两节；
    //     · 0.3.0alpha 第二步（**当前**）：出厂人设只剩一份，于是把那段内容**直接写进
    //       `personas/小鲸鱼（完整带情绪）.md`**，`src/voice.mjs` 与
    //       `src/voice-source.mjs` **整个删掉** —— 提示词直接用**完整人设**
    //       （`this.personaText`），再没有"替换/追加"这回事。
    //   ∴ 现在的规矩很简单：**要改说话方式就改那个人设文件**（改了要重启，人设是构造期缓存的）。
    //   ⚠️ 唯一要盯的是"这份人设里到底有没有说话方式那一节"—— 使用者完全可以把文件换成
    //      自己写的散文（那时就没有）。这属于**配置问题不是故障**，所以只记一行日志、
    //      不拦、也不回落内置（`#notePersonaShape`）。

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
      // ── 唤醒判定器（0.2.3）──────────────────────────────────────────────
      // `wakeJudged` 数的是**真的问了模型**的次数（超预算/取消不算），
      // `wakeSilenced` 数的是**真的被判为沉默**的次数。
      // 影子模式下 `wakeSilenced` 照样会涨 —— 它表达的是"判定器想拦多少"，
      // 而"实际拦了多少"看 `skipped` 有没有跟着动。分开数就是为了这个对照。
      wakeJudged: 0,
      wakeSilenced: 0,
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
      // ── 通路：**优先直连**（0.2.9 用户决定），拿不到 key 就如实退回 headless ──
      //
      // ★ 为什么不是"直连失败再降级"：那样每条抽取都要先白等一次网络失败
      //   （3 次重试 + 超时），而且失败原因会被后续成功掩盖。这里按**配置事实**
      //   一次性判定：有主模型 key 就走直连，没有就明说走 headless。
      // ★ 降级必须**说出来**（第 6/9 条）：`resolveExtractTarget` 的 `why` 直接进日志，
      //   否则"直连没生效"会表现成"抽取变慢了"，而没有任何地方解释。
      const target = resolveExtractTarget({ config: this.config, apiKey: this.modelApiKey })
      if (!target.ok && !this.#extractFallbackLogged) {
        this.#extractFallbackLogged = true
        this.log(`[extract] 直连不可用，退回一次性 DSH 进程：${target.why}`)
      }
      const runner = target.ok
        ? (opts) => runDirect({ baseUrl: target.baseUrl, apiKey: target.apiKey, model: target.model, ...opts })
        : undefined
      // ★ **不 await** —— 让它在后台跑完
      extractRecipe({
        cliPath,
        task,
        ops,
        kind: String(chatKey).startsWith('group:') ? 'group' : 'private',
        cwd: workspace,
        timeoutMs: 60_000,
        // 只有直连可用时才覆盖默认 runner（`undefined` = 用 extract.mjs 的 runHeadless）
        ...(runner ? { runner } : {}),
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
            // 通路也写进日志：`ms` 是判断"到底走的哪条路"最直接的证据
            //（直连约 1 秒、headless 约 3~5 秒），但**明写**比让人拿秒数去猜好。
            this.log(
              `[extract] ✅ 沉淀了一条做法：${r.recipe?.title ?? '?'}` +
                `（${up.merged ? '已合并' : '新增'}，${target.ok ? '直连' : 'headless'}，${Date.now() - t0}ms）`,
            )
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
   *
   * ★ 0.2.3：这里**每条消息现读** `this.config.corpus.enabled`。
   *   为什么不建对象时就定死：`corpus.enabled` 是**活配置对象**上的键
   *   （`/api/extensions` 的 toggle 会就地改），定死就变成 cold 了 ——
   *   而这个开关的全部价值就是"随时开关"。现读的代价是一次属性访问。
   *   ⚠️ 句柄本身照旧在构造时建：`createCorpus()` **不碰磁盘**
   *   （`node:sqlite` 与建表都推迟到第一次真正用，见 corpus.mjs 的 `open()`），
   *   所以"关着"的时候这里是**零 fs 成本**，不是"少一次写入"。
   */
  #recordCorpus(opts) {
    if (this.config.corpus?.enabled === false) return
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
      // 关掉时**如实说"关掉了"**，不说"没搜到" —— 后者会让模型转述成
      // "语料库里没有这条"，那是一句谎话（本项目最忌讳的"说了做不到"）。
      if (this.config.corpus?.enabled === false) {
        return { ok: false, text: '', rows: [], why: '本地语料库已关闭（corpus.enabled = false）' }
      }
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

  #settleMemory({ chatKey, kind, peerId, senderId, tier, chatName = '', speakerName = '', userText = '', answer = '', complete = true, sent = true }) {
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
    // ── 情绪倾注：**确定性通道**（第三条"不依赖模型"的写入路径）──────────────
    //
    // ★ 为什么必须有它：需求是"对面向机器人倾注情绪时**必须**记录"。
    //   而本项目已两次实测证明"靠模型自觉"的漏报率接近 100%（本机几十轮 0 次提议；
    //   参考项目 58 次运行 0 次调用）。所以这件事只能由桥接本地判定。
    // ★ 为什么**不看 `complete`**：它取自**用户那句话本身**，与模型这轮跑没跑完无关
    //   （超时了那句话也是完整的）—— 正是 H1 三分类里"用户的话照常落盘"那一类。
    // ★ 落点是 `SCOPE.PERSON`（个人层，跟人走），归属由 `applyMemoryItems` 按
    //   **本轮真实核实过的发言人**裁定 —— 模型插不上手。
    const pour = detectAffectPour({ text: userText })
    const affectText = pour.hit ? affectEntryText(pour) : ''
    const affectItems = affectText ? [{ scope: SCOPE.PERSON, text: affectText, source: 'cue' }] : []
    if (affectItems.length > 0) {
      // 记一行**为什么记**（这是"必须记下来"这件事唯一的可观测痕迹）
      this.log(`[memory] 情绪倾注 → 记入个人档（${pour.why}）：${affectText}`)
    }
    const markerItems = complete
      ? parsed.items.map((it) => ({ ...it, source: 'marker' }))
      : []

    // ── 承诺通道（0.2.9）：**作出承诺必须记录**（双向，确定性）──────────────
    //
    // ★ 为什么单独一条：承诺是长期记忆里代价最高的一类 —— 机器人自己许的诺忘了
    //   就是"说话不算数"；对方许的诺忘了就会重复追问。而"靠模型自觉"的漏报率
    //   在本项目实测接近 100%，所以和"记住 X"、情绪倾注一样，由桥接本地判定。
    // ★ 落点是**会话层**（`SCOPE.FACT`）：承诺是"在这个对话里许的" ——
    //   群聊落本群、私聊落那个人（私聊的会话层就是他的个人档）。
    // ★ 机器人的那条**只在真的会发出去时**才记（`sent`）：被更新的消息作废的那一轮，
    //   用户根本没看到那句话，记成"我答应过"就是**假记忆**。
    const promiseItems = []
    // ★★ 承诺带时间戳（2026-10-01 用户要求）：句子里那些相对时间（"明天""周四"）
    //   离开当天就没有意义，所以落盘时附上**说的日期**。
    //   ⚠️ 用 `Date.now()` 而不是模型给的时间：模型拿不到可信时钟。
    const promiseAt = Date.now()
    const botPledge = detectPromise({ text: clean, from: 'bot' })
    if (botPledge.hit) {
      if (sent) {
        promiseItems.push({ scope: SCOPE.FACT, text: promiseEntryText({ ...botPledge, at: promiseAt }), source: 'promise' })
        this.log(`[memory] 承诺 → 记入会话层（${botPledge.why}）：${promiseEntryText({ ...botPledge, at: promiseAt })}`)
      } else {
        // ★ 不作数的那一轮**也要留一行**：这一条是"我明明答应过，它怎么没记"这类
        //   追问唯一的查证痕迹（不记是**对的**，但必须是**有理由的不记**）。
        this.log(
          `[memory] 承诺 → 不记（这一轮没真的发出去，对方没看到那句话）：${promiseEntryText(botPledge)}`,
        )
      }
    }
    const userPledge = detectPromise({ text: userText, from: 'user' })
    if (userPledge.hit) {
      // 用户那句话是**完整的**，与模型这轮跑没跑完无关（H1 三分类里的第一类）
      promiseItems.push({ scope: SCOPE.FACT, text: promiseEntryText({ ...userPledge, at: promiseAt }), source: 'promise' })
      this.log(`[memory] 承诺 → 记入会话层（${userPledge.why}）：${promiseEntryText({ ...userPledge, at: promiseAt })}`)
    }

    if (!enabled) {
      if (keywordItems.length || parsed.items.length || affectItems.length || promiseItems.length) {
        this.log(
          `[bridge] 记忆开关关闭，已剥离 ${parsed.items.length} 条提议、` +
            `${keywordItems.length} 条关键词直写、${affectItems.length} 条情绪倾注、` +
            `${promiseItems.length} 条承诺（都不落盘、不回执）`,
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

    const all = [...keywordItems, ...affectItems, ...promiseItems, ...markerItems]
    let outcome = { applied: [], ignored: [], wroteFiles: [] }
    if (all.length > 0) {
      outcome = applyMemoryItems({
        workspace,
        kind,
        peerId,
        senderId,
        tier,
        // ★ 群名（这一轮协议端核实过）—— 只用于"新建群记忆时把头写成群名"
        chatName,
        // ★ 发言人昵称（0.3.0alpha）：记忆条目要带「（昵称 QQ 号码）」身份前缀。
        //   核实不到就是空串，那时条目只写号码（不编名字）。
        speakerName,
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

  /**
   * 挂到 OneBot 上：事件通道一有消息就进来。
   *
   * ★★ 0.3.2 起它是 **async**（返回 Promise）：`servers[].manageOnStart` 要在启动时
   *   接手/拉起服务端，并**等到端口真的开放**才算起来 —— 那件事必须能 `await`。
   *   ∴ **调用方要 `await` 它**（或至少 `.catch()` 接住异常），否则启动期的
   *   接管失败会变成"未处理的 Promise 拒绝"。
   *   ★ 踩过的坑如实记下：第一版在这个**同步**方法里写了 `await`，
   *     而 V8 报的错是 `Private field '#notePersonaShape' must be declared in an
   *     enclosing class`（报在了类里第一个私有字段上，离真正的位置几百行）——
   *     一个 `await` 放错地方，报错能离谱到这个程度。
   */
  async attach(onebot = this.onebot) {
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

    // ── 旧布局迁移（三层记忆：全局 / 群聊 / 个人）──────────────────────────
    //
    // ★ 为什么必须在**开始接消息之前**做：旧布局是 `memory/private-<QQ>.md`、
    //   `memory/group-<群号>.md`，新布局是 `memory/people/`、`memory/groups/`。
    //   不搬内容 = **升级即失忆**（文件还在，但再也不会被注入，而且不报错）。
    // ★ 它**不抛**、只搬不删（原件归档到 `memory/.migrated/`），而且幂等；
    //   另外注入侧还有一层"旧路径回退读"兜底，所以迁移失败也不会真的丢记忆。
    try {
      const workspace = this.config?.dsh?.workspace
      if (workspace && this.config.memory?.enabled !== false) {
        const r = migrateMemoryLayout({ workspace, log: this.log })
        const n = r.moved.length + r.merged.length
        if (n > 0) this.log(`[memory] 三层布局迁移完成：搬 ${r.moved.length} 份、合并 ${r.merged.length} 份`)
        if (r.why.length > 0) this.log(`⚠️ [memory] 有几份旧记忆没迁成（原件仍在原处，注入回退仍读得到）：${r.why.join('；')}`)
      }
    } catch (error) {
      this.log(`⚠️ [memory] 旧布局迁移整体失败（注入侧有回退读兜底，记忆不会丢）：${error?.message ?? error}`)
    }

    // ── 情绪闸门：把档位**在启动时说清楚**（2026-09-30）────────────────────
    //
    // ★ 为什么必须在这里说：它默认 `off`，而"开了没开"从行为上**看不出来** ——
    //   没唤醒时不记是本来的行为，记了也只是磁盘上多一行。使用者不该靠翻文档
    //   才知道自己现在是哪一档。★ 它**不在**这里建闸门对象（那是懒建的）：
    //   建它要读配置里的通路，而这条日志只回答"档位是什么"。
    {
      const mode = this.#prewakeMode()
      if (mode === PREWAKE.OFF) {
        this.log('[memory] 情绪闸门：prewake=off（未唤醒的消息**只**判定不记录；想先看会记什么就设 shadow）')
      } else {
        this.log(
          `[memory] 情绪闸门：prewake=${mode}` +
            (mode === PREWAKE.SHADOW
              ? '（判定照跑、**只写日志不落盘** —— 观察档）'
              : '（判定通过就落进那个人的个人档 —— 个人档跟人走，他在别的群也算上）'),
        )
      }
      if (!isPrewakeMode(this.config.memory?.affect?.prewake) && String(this.config.memory?.affect?.prewake ?? '') !== '') {
        this.log(`⚠️ [memory] memory.affect.prewake 的取值「${this.config.memory.affect.prewake}」认不出，已按 off 处理`)
      }
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

    // ── 0.3.2 P1：定时任务（到点了主动说一句）────────────────────────────
    //
    // ★ 与定时整理**同一刻启动**（都在 `attach` 里），但两条纪律不同：
    //   · 整理**只在空闲时动手**（它要重写记忆文件）；
    //   · 定时任务**不要求空闲** —— 到点了就该发，撞上在跑的回合就排队等会话锁
    //     （`#deliver` 那条路本来就是串行的）。要求空闲会让"8 点叫我"在忙的时候
    //     被跳过，而那时**使用者恰恰最需要被提醒**。
    // ★ 默认**关闭**（`schedule.enabled !== true` 即不开）：定时任务是"无人开口也说话"，
    //   按本项目"危险的能力默认关"的口径（同截图技能）。配置里显式写 true 才开。
    this.syncScheduleRunner()

    // ── 0.3.2 P2：服务器监测（采样 → 状态机 → 事件）──────────────────────
    //
    // ★ 只有**配了服务器**才建这个循环：空配置 ⇒ 一次网络请求都不发、也不起定时器。
    // ★ 它**只采只读命令**（`list`）；真正会改服务端的动作属于 P4 的重启编排。
    // ★ 事件产出来后怎么用是**另一件事**（见 `#onServerEvent`）：
    //   它写进事件台账，并按任务定义里的 `announce` 档位决定要不要**自动播报**。
    this.#startServerLoop()
    // ── 0.3.2 P3：游戏内对话（读控制台 → 绑定 → 模型 → `say`/`tellraw`）────────
    //
    // ★ 位置：紧挨着监测循环（两者都读同一台服务器的控制台，但节奏不同）。
    // ★ 它**不关心服务器活不活**：日志文件在就有的读，不在就跳过并留一行说明。
    this.#startGameChatLoop()
    // ★★★ 启动时接手服务端（`servers[].manageOnStart`，设计文档 §6.3.1）。
    //
    // 为什么排在监测之后：先让监测跑起来（"出问题主动播报"越早在线越好），
    // 而拉起服务端可能等好几分钟。
    // ★ 它自己吞掉所有异常（一台失败不拖累其它台，也绝不拖垮启动）；
    //   `await` 是刻意的 —— 如实等出结果，使用者当场就该知道服务端到底起来没有。
    try {
      await this.manageServersOnStartInternal()
    } catch (error) {
      this.log(`❌ [servers] 启动接管时抛异常（机器人照常工作）：${error?.message ?? error}`)
    }
    return this
  }

  /**
   * 这台服务器**现在是不是在启动窗口里**（纯读，给控制台/主动检测用）。
   *
   * ★ 为什么需要它：启动窗口内 RCON 连不上是**正常的**，而回一句"连不上那个 RCON 端口"
   *   会把人往"服务端有问题"上引（实测就是这个症状）。所以这两条路都要先说清
   *   "它正在启动，请稍等"，并给出「已等多久 / 最多再等多久」。
   *
   * @returns {null | {starting:boolean, expired:boolean, waitedMs:number, leftMs:number, text:string}}
   */
  #startupWindowOf(serverId) {
    try {
      const workspace = this.config?.dsh?.workspace
      const st = readStarting({ workspace, serverId })
      if (!st) return null
      const ev = evaluateStarting({ state: st, portOpen: false, now: Date.now() })
      return { ...ev, text: ev.starting ? describeStarting(ev) : '' }
    } catch {
      return null
    }
  }

  /**
   * **一次性检测一台服务器**（界面上的"主动检测"按钮）。
   *
   * ★★★ 它**不喂状态机、不产出事件、不改累计计数**（见 `loop.mjs` 的 `probeOnce`）。
   *   为什么必须这样：`pollOne` 会把结果喂进 `monitor.feed(...)`，于是"连不上"会累加
   *   `failStreak` ⇒ **使用者点几次按钮就可能把一台好好的服务器自己点成 down**，
   *   进而触发一次自动重启。一个"看一眼"的按钮绝不该有那个副作用。
   */
  async probeServerForApi({ serverId = '' } = {}) {
    try {
      const id = String(serverId ?? '').trim()
      if (!id) return { ok: false, why: '必须给 serverId' }
      const list = Array.isArray(this.config?.servers) ? this.config.servers : []
      const s = list.find((x) => x?.id === id)
      if (!s) return { ok: false, why: `配置里没有 id 为「${id}」的服务器` }
      if (!this.#serverLoop) {
        // 懒建一个循环对象**只为拿到它的采样器**（`probeOnce` 不喂状态机、不起定时器）。
        this.#serverLoop = createServerLoop({
          workspace: this.config?.dsh?.workspace,
          servers: () => (Array.isArray(this.config.servers) ? this.config.servers : []),
          pollMs: this.config.serversPollMs,
          log: () => {},
          onEvent: () => {},
        })
      }
      const r = await this.#serverLoop.probeOnce(s)
      const win = this.#startupWindowOf(id)
      // ★★★ 启动窗口内"连不上"是**正常的** ⇒ 回"正在启动，请稍等"而不是"连不上"。
      //   不这么做会把人往"服务端有问题"上引（实测症状就是这样）。
      if (r?.ok !== true && win?.starting) {
        this.log(`🔎 [servers] 主动检测 ${s.name ?? id}：正在启动（已等 ${Math.round(win.waitedMs / 1000)} 秒）`)
        return { ...r, starting: true, startingText: win.text, waitedMs: win.waitedMs, leftMs: win.leftMs }
      }
      this.log(`🔎 [servers] 主动检测 ${s.name ?? id}：${r?.ok ? '通' : '不通'}${r?.snapshot?.error ? `（${r.snapshot.error}）` : ''}`)
      return r
    } catch (error) {
      return { ok: false, why: `主动检测失败：${error?.message ?? error}` }
    }
  }

  /**
   * **读服务器控制台的最新输出**（界面上的"实时后台"折叠栏）。
   *
   * ★ 与"控制台命令"那块共用同一份解码逻辑（`decodeConsoleBytes`）——
   *   真机那个文件是 **GBK**，按 UTF-8 读出来全是替换字符（见 `log-source.mjs` 文件头）。
   * ★ 只读尾部一块、只回文本行；**不回任何凭据**（那个文件里本来也不该有密码）。
   */
  readServerConsole({ serverId = '', limit = 200 } = {}) {
    try {
      const id = String(serverId ?? '').trim()
      if (!id) return { ok: false, why: '必须给 serverId' }
      const list = Array.isArray(this.config?.servers) ? this.config.servers : []
      const s = list.find((x) => x?.id === id)
      if (!s) return { ok: false, why: `配置里没有 id 为「${id}」的服务器` }
      const workspace = this.config?.dsh?.workspace
      if (!workspace) return { ok: false, why: '没有工作区 ⇒ 定位不到控制台日志' }
      // ★ 路径直接用字符串拼：本文件本来就没 import `node:path`（它的其它落盘处
      //   也走字符串），引一个模块只为拼一次路径不值得。
      //   `id` 已过一遍字符替换，防路径穿越。
      const safeId = String(id).replace(/[^a-zA-Z0-9_.-]/g, '_')
      const file = `${workspace}/runtime/servers/${safeId}.console.log`
      if (!existsSync(file)) {
        return { ok: true, lines: [], total: 0, encoding: 'utf8', file, why: '还没有控制台输出（服务端没被本程序拉起过，或还没写过）' }
      }
      const size = statSync(file).size
      const want = Math.min(size, 256 * 1024)
      const fd = openSync(file, 'r')
      let text = ''
      let encodingUsed = 'utf8'
      try {
        const buf = Buffer.alloc(want)
        let got = 0
        while (got < want) {
          const n = readSync(fd, buf, got, want - got, size - want + got)
          if (n <= 0) break
          got += n
        }
        const dec = decodeConsoleBytes(buf.subarray(0, got), 'auto')
        text = dec.text
        encodingUsed = dec.encoding
      } finally {
        closeSync(fd)
      }
      const all = text.split(/\r?\n/).filter((l) => l.trim())
      const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 2000) : 200
      return { ok: true, lines: all.slice(-n), total: all.length, encoding: encodingUsed, file }
    } catch (error) {
      return { ok: false, why: `读控制台失败：${error?.message ?? error}` }
    }
  }

  /**
   * **手动跑一条服务器控制台命令**（0.3.2 收尾的服务器终端）。
   *
   * ★★★ 安全边界（**用户拍板**，不许在下游放宽）：
   *   它是**完整控制台**（RCON = op 级别：`op`/`ban`/`stop`/`save-off` 都能做），
   *   所以**只从本机网页进**（HTTP 服务只绑 127.0.0.1），**绝不进 QQ 工具面**
   *   —— 那条面的纪律是"只说话 + 只读"。让 LLM 拿到服务器 op 权限，
   *   被诱导一次就是不可逆的。
   *
   * ★ 它**不经过重启编排的纪律**（冷却/次数上限/归属），因为那是"自动动作"的纪律；
   *   手动敲一条命令是人在做决定，与 `--supervise stop` 同一条路（那是 CLI，这是本机网页）。
   *   但 `stop` 这类会**停掉服务端**的命令仍然建议走 `supervise-server.bat stop`，
   *   因为那条路会等端口释放。
   *
   * @param {object} o
   * @param {string} o.serverId
   * @param {string} o.command
   */
  async runServerCommand({ serverId = '', command = '' } = {}) {
    const id = String(serverId ?? '').trim()
    if (!id) return { ok: false, why: '必须给 serverId（不猜是哪一台）' }
    const list = Array.isArray(this.config?.servers) ? this.config.servers : []
    const server = list.find((s) => s?.id === id)
    if (!server) return { ok: false, why: `配置里没有 id 为「${id}」的服务器` }
    if (server.enabled === false) return { ok: false, why: `「${server.name ?? id}」是停用的（先启用再发命令）` }
    const workspace = this.config?.dsh?.workspace
    if (!workspace) return { ok: false, why: '没有工作区 ⇒ 定位不到控制台日志' }
    // ★★ 启动窗口内先别去连（连不上是正常的），如实说"正在启动，请稍等"
    const win = this.#startupWindowOf(id)
    if (win?.starting) {
      return { ok: false, starting: true, waitedMs: win.waitedMs, leftMs: win.leftMs, why: `${win.text}（命令先别发，等它 Ready 再试）` }
    }
    const r = await runConsoleCommand({ server, command, workspace })
    // 只记命令本身，**绝不记密码**（`runConsoleCommand` 也保证返回值里没有它）
    if (r.ok) {
      this.log(`🎛️ [console] ${server.name ?? id} ← ${String(command).trim().slice(0, 120)}`)
    } else {
      this.log(`❌ [console] ${server.name ?? id} 命令没跑成：${r.why}`)
    }
    return r
  }

  /**
   * **本地指令通道**：`\mc [服务器id] <命令>`（0.3.2 收尾）。
   *
   * ★★★ **反斜杠是唯一的对外格式**（使用者 2026-10-04 定的）：游戏里以 `/` 开头会被
   *   服务端当命令（那条路看不到），群里那两个字符本来无所谓，但**两处用同一个格式**
   *   对使用者更省事 —— 所以**文档、提示、示例一律写 `\mc`**。
   *   代码里 `/mc` 与 `//mc` **仍然认**（零代价的兜底，见 `MC_COMMAND_SHAPE`），
   *   但如果发现自己又在某处写了 `/mc`，那多半是漏改。
   *
   * ★★★ 判据顺序（每一步都要有理由）：
   *   ① 文本必须是这个**完整指令形状**（`\mc ` 前缀）—— 只有前缀不算命中
   *      （群里聊到"那个 \mc 命令"不该触发）。形状不对 ⇒ 返回 `notMatched`，
   *      调用方**照常走普通聊天**。
   *   ② **只有管理员**（`tier === 'admin'`）—— 非管理员发这个形状时返回 `notMatched`
   *      **而不是拒绝**：拒绝等于告诉所有人"这里有后门"，而照常聊天什么都不暴露。
   *   ③ 解析出服务器（省略 id 且只有一台时取那一台；多台且没给 ⇒ **报错不猜**）。
   *   ④ 执行（`runMcCommand` 里还有"这台开了 `commandFromQQ` 吗"这一道）。
   *
   * ★ 它**不产生模型调用**：命中就直接执行并 return。
   *
   * @returns {Promise<{matched: false} | {matched: true, text: string, ok: boolean}>}
   */
  async #handleMcLocalCommand({ text, kind, peerId, senderId, tier }) {
    const raw = String(text ?? '').trim()
    // ★ 形状判据：必须以 `\mc` / `/mc` / `//mc` **作为一个词**开头，
    //   而不是"文本里出现过 mc" —— 群里聊到"那个 mc 命令"不该触发。
    // ★ 反斜杠是**对外格式**（游戏内以 `/` 开头会被当命令，见 `parseGameBindRequest`）；
    //   斜杠那几个形状仍然收（零代价，装了服务端插件之后就能用）。
    if (!/^[\\/]{1,2}mc(?:\s|$)/i.test(raw)) return { matched: false }
    // ★★ 参数消歧（实测踩到的真 bug）：`\mc list` 里的 `list` 是**命令**，
    //   不是服务器 id。靠正则分不出来 ⇒ **按配置里真实存在的 id 来消歧**：
    //   第一个词命中某个 id 才算 id，否则整串都是命令（id 留空，交给"只有一台就自动选"）。
    const rest = raw.replace(/^[\\/]{1,2}mc\s*/i, '').trim()
    if (!rest) {
      await this.#safeSend(kind, peerId, '用法：`\\mc [服务器id] <命令>` —— 例如 `\\mc list`、`\\mc forge tps`')
      return { matched: true, ok: false, text: '没给命令' }
    }
    // ★ 只有管理员：非管理员 ⇒ **当作普通聊天**（不解释、不拒绝）
    if (String(tier ?? '') !== 'admin') {
      this.log(`🎛️ [servers] 有人发了 \\mc 形状的文本但不是管理员（${kind}:${peerId}）⇒ 按普通聊天处理，不执行也不解释`)
      return { matched: false }
    }
    const list = (Array.isArray(this.config?.servers) ? this.config.servers : []).filter((s) => s && s.enabled !== false)
    const knownIds = new Set(list.map((s) => String(s.id ?? '')))
    const first = rest.split(/\s+/)[0]
    let serverId = ''
    let command = rest
    if (knownIds.has(first)) {
      serverId = first
      command = rest.slice(first.length).trim()
    }
    if (!command) {
      await this.#safeSend(kind, peerId, `用法：\`\\mc ${serverId} <命令>\` —— 只给了服务器 id，没给命令`)
      return { matched: true, ok: false, text: '没给命令' }
    }
    if (!serverId) {
      if (list.length === 1) serverId = list[0].id
      else {
        // ★ 多台且没给 id ⇒ **报错不猜**（"随便挑一台"是这里最坏的一种猜错）
        const ids = list.map((s) => s.id).filter(Boolean)
        const msg = `配了 ${list.length} 台服务器，必须指明是哪一台：\`\\mc <id> <命令>\`（有：${ids.join('、') || '无'}）`
        await this.#safeSend(kind, peerId, msg)
        return { matched: true, ok: false, text: msg }
      }
    }
    const r = await runMcCommand({
      workspace: this.config?.dsh?.workspace,
      kind,
      peerId,
      serverId,
      command,
      config: this.config,
    })
    this.log(
      `🎛️ [servers] 本地控制台指令（${kind}:${peerId}·admin）→ ${serverId}：${command.slice(0, 120)} ⇒ ${r.ok ? '已送达' : `拒绝/失败(${r.denied ?? '?'})`}`,
    )
    // ★ 回话**必须如实**：把输出（若有）与控制台日志增量一起给，
    //   并带上那句"不保证只属于这一条命令"（见 `servers/console.mjs` 的实测事实）。
    const parts = [r.text]
    if (r.reply) parts.push(`RCON 回话：${r.reply}`)
    if (r.output) parts.push(`控制台新增输出：\n${r.output.trim().slice(0, 1500)}`)
    else if (r.ok) parts.push('（控制台这段时间没有新输出 —— 很多命令本来就不回话，**不代表没生效**）')
    if (r.caveat) parts.push(r.caveat)
    await this.#safeSend(kind, peerId, parts.filter(Boolean).join('\n'))
    return { matched: true, ok: Boolean(r.ok), text: parts.join('\n') }
  }

  /**
   * **绑定指令通道**（0.3.2 P3）：`\mc bind` 取码指路、`\mc bind <码>` 提交、`\mc unbind <目标>` 解绑。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * 这条通道的规矩（设计文档 §5.2，逐条都是硬要求）
   * ══════════════════════════════════════════════════════════════════════════
   *   · **可用范围**：`/绑定` 只在**已允许的群**里生效（复用 `roster.isGroupAllowed`，
   *     **不新造名单** —— 多一张名单就多一处不一致）；
   *   · **归属**：绑定/改绑一律绑给**发送者本人**（`senderId`）。
   *     ★★ **绝不绑给消息里写的任何人** —— 否则谁在群里看见码，就能把它绑到别人头上；
   *   · **回应**：**只回给发起人**，确定性文案，**不走模型**（群里刷屏的指令回应是噪音）；
   *   · **留痕**：`bindings-audit.jsonl` 记一行（谁、何时、哪个群、UUID 前 8 位），
   *     ★ **绝不记码本身**（审计不含秘密，与 `memory-audit.mjs` 同一条纪律）；
   *   · **失败话术**：一句极短的话，不吵、不重复、不猜（群是公共场合）。
   *
   * @returns {Promise<{matched: false} | {matched: true, ok: boolean, text: string}>}
   */
  async #handleBindLocalCommand({ text, kind, peerId, senderId }) {
    if (!looksLikeBindCommand(text)) return { matched: false }
    const parsed = parseMcBindCommand(text)
    // ★ `bind` / `unbind` 在 `/mc` 前缀下是**保留字**：形状不对也要在这里拦下
    //   （否则会掉进管理员控制台那条路，把 `bind xyz` 当成服务端命令发出去）。
    if (!parsed.hit) return { matched: false }

    const workspace = this.config?.dsh?.workspace
    const peerKey = `${kind}:${peerId}`

    // ── ① 权限与范围（**先判，再碰任何盘上状态**）──────────────────────────
    if (parsed.kind === 'unbind' || parsed.kind === 'unbind-help') {
      // 解绑：管理员专用（控制台 / 管理员私聊 / 群里 @）。
      // ★ 用 `roster.decide` 的结论，**不看群内角色**（那条安全边界见 roster.mjs）。
      const verdict = this.roster?.decide?.({ kind, peerId, senderId }) ?? { respond: false, tier: '' }
      if (String(verdict.tier ?? '') !== 'admin') {
        this.log(`🔗 [bind] 有人发了 \\mc unbind 但不是管理员（${peerKey}）⇒ 按普通聊天处理，不执行也不解释`)
        return { matched: false }
      }
      if (parsed.kind === 'unbind-help') {
        const msg = '用法：`\\mc unbind <游戏名或QQ号>`'
        await this.#safeSend(kind, peerId, msg)
        return { matched: true, ok: false, text: msg }
      }
      const r = unbindByName({ workspace, name: parsed.target, by: `admin:${senderId}` })
      const msg = r.ok
        ? `解绑了：${String(r.name || r.uuid).slice(0, 32)}（QQ ${r.qqId}）`
        : '没有这条绑定（我按游戏名和 QQ 号都找过一遍）—— 什么都没改。'
      this.log(`🔗 [bind] 解绑（${peerKey}·admin）目标「${parsed.target.slice(0, 24)}」⇒ ${r.ok ? '成功' : `失败(${r.why})`}`)
      await this.#safeSend(kind, peerId, msg)
      return { matched: true, ok: r.ok, text: msg }
    }

    // `\mc bind` 只认**群**：那是使用者定的入口（私聊是 fail-closed，
    // 为绑定去开私聊白名单等于把门开着）。
    if (kind !== 'group' || !this.roster?.isGroupAllowed?.(peerId)) {
      // ★★ 私聊里不是"当作普通聊天"就完事 —— 那会让**模型**去回答一条绑定指令，
      //   而它只会编一套流程出来（绑定这条路压根不在私聊里）。所以给一句
      //   **确定性**的指路，并且**一次模型调用都不产生**。
      // ★ 前提是这个人本来就在名单里：名单外的人**什么都不回**（fail-closed，
      //   与"群里不回、私聊只回一句统一话术"完全一致）。
      if (kind === 'private') {
        const v = this.roster?.decide?.({ kind, peerId, senderId }) ?? { respond: false }
        if (v.respond) {
          const msg =
            '绑定要在**群里**做：先让玩家在游戏里输 `\\mc bind` 拿一个 6 位码，' +
            '然后在机器人所在的群里**直接发** `\\mc bind <码>`（**不用 @ 我**）。' +
            '私聊这条路是关着的（也不打算开）。'
          this.log(`🔗 [bind] ${peerKey} 在私聊里发绑定指令 ⇒ 给了一句确定性指路（不调模型）`)
          await this.#safeSend(kind, peerId, msg)
          return { matched: true, ok: false, text: msg }
        }
      }
      this.log(`🔗 [bind] ${peerKey} 发了 \\mc bind 但这里不是"已允许的群" ⇒ 当作普通聊天`)
      return { matched: false }
    }
    if (!senderId) return { matched: false }

    // ── ② `\mc bind` 没带码 / 带了坏码 ⇒ 指路（**不在这里发码**）───────────
    //
    // ★★ 为什么**不能**在这里发码（第一版就是这么做的，已被使用者否掉）：
    //   码必须**在游戏里生成**并与那个玩家的 UUID 挂在一起 —— 否则提交码的时候
    //   我们只知道"某个 QQ 想绑定"，**不知道是哪个游戏身份**，只能等下一次发言去猜
    //   （第一版的"资格"那一套，而且同时有两份资格时根本无法判断）。
    if (parsed.kind === 'bind-help') {
      const msg =
        '绑定码要**在游戏里拿**：让玩家进服后**在聊天里输入** `\\mc bind`（**反斜杠，不是斜杠** —— ' +
        '以 `/` 开头的会被服务端当成命令，我们看不到那句），' +
        '我会单独把 6 位码发给**他本人**；他把码发到这里：`\\mc bind <码>`' +
        '（**直接发，不用 @ 我** —— 这句我一定能看到）。'
      await this.#safeSend(kind, peerId, msg)
      return { matched: true, ok: false, text: msg }
    }
    if (parsed.kind === 'bad-code') {
      const msg = '码是 **6 位数字**（例如 `\\mc bind 123456`）。让玩家在游戏里输 `\\mc bind` 重新拿一个。'
      await this.#safeSend(kind, peerId, msg)
      return { matched: true, ok: false, text: msg }
    }

    // ── ③ 提交码 ⇒ **当场绑定** ───────────────────────────────────────────
    if (parsed.kind === 'redeem') {
      const r = bindByCode({ workspace, qqId: senderId, code: parsed.code, chatKey: peerKey })
      if (!r.ok) {
        const msg = '这个码现在不能用（不存在、已过期、或者已经被用过了）。让玩家在游戏里输 `\\mc bind` 重新拿一个。'
        this.log(`🔗 [bind] ${peerKey} 提交的码不可用（${r.why}）—— 码本身不记`)
        await this.#safeSend(kind, peerId, msg)
        return { matched: true, ok: false, text: msg }
      }
      const extra = r.replaced || r.stolenFrom ? '（覆盖了原来的一条绑定，已留痕）' : ''
      const msg = `绑好了：游戏里的 **${r.name || shortUuid(r.uuid)}** ↔ 你${extra}。\n已经在他本人的游戏里通知过了。`
      this.log(
        `🔗 [bind] 绑定成立（${peerKey} → QQ ${senderId}）：游戏名「${r.name}」UUID ${shortUuid(r.uuid)}…` +
          `${r.replaced ? `｜覆盖了原来的 QQ ${r.replaced.qqId}` : ''}` +
          `${r.stolenFrom ? `｜该 QQ 原来绑的是 UUID ${shortUuid(r.stolenFrom.uuid)}…` : ''}`,
      )
      await this.#safeSend(kind, peerId, msg)

      // ★★★ **抢绑藏不住**（设计文档 §5.6 档 A 的兜底）：绑定一成立就**立刻**给
      //   那个 UUID 本人一条只给他看的 `tellraw`。这一步必须在**提交这一刻**做
      //   （而不是等他下次说话）—— 受害者要**当场**看见有人拿他的身份绑了。
      //   ⚠️ 特意**不写 QQ 号**：设计文档 §5.5 的边界是"服务端只拿到'绑定了没有'，
      //   拿不到 QQ 号"。要查是谁绑的，管理员看留痕/绑定表。
      await this.#gameTellrawToPlayer(
        r.serverId,
        r.name,
        '绑定成功 —— 现在你可以在这里跟我说话了（说「小鲸鱼」叫我）。' +
          '如果这次绑定不是你做的，请立刻找管理员，每次绑定变更都有记录。',
        'yellow',
      )
      return { matched: true, ok: true, text: msg }
    }

    return { matched: false }
  }

  /**
   * 按 `serverId` 找到那台服务器，再给那个玩家发一条 `tellraw`。
   *
   * ★ 为什么需要这一层：绑定成立发生在**群里**，而通知要发到**游戏里** ——
   *   中间隔着"哪一台服务器"。码里记了 `serverId`（取码时写进去的），
   *   但**那一台可能已经被删/停用/关了 gameChat** ⇒ 退化成"在所有开了 gameChat
   *   的服上都发一遍"，并把这件事如实记一行日志（**绝不静默**）。
   */
  async #gameTellrawToPlayer(serverId, playerName, text, color = '') {
    const list = (Array.isArray(this.config?.servers) ? this.config.servers : []).filter(
      (s) => s && s.enabled !== false && s.gameChat === true,
    )
    const byId = list.find((s) => String(s.id) === String(serverId ?? ''))
    if (!byId) {
      if (list.length === 0) {
        this.log('⚠️ [bind] 绑定成功了，但**没有一台开了 gameChat 的服务器**可以发那条通知（玩家不会收到确认）')
        return { ok: false, why: 'no-game-server' }
      }
      this.log(`⚠️ [bind] 码里记的服务器「${serverId}」现在找不到 ⇒ 改成在所有开了 gameChat 的服上通知`)
    }
    const targets = byId ? [byId] : list
    let okAny = false
    for (const s of targets) {
      const r = await this.#gameTellraw(s, playerName, text, color)
      if (r.ok) okAny = true
    }
    return { ok: okAny }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 0.3.2 P3：游戏内对话（读控制台 → 绑定 → 模型 → `tellraw`）
  // ══════════════════════════════════════════════════════════════════════════
  //
  // 三条设计纪律（设计文档 §5.3 / §5.4 / §5.5），改这里之前先读：
  //   ① **未绑定 = 不能对话**，而且它的话**不进模型**（零成本）：只给本人一条
  //      `tellraw` 说明怎么绑，且**每次进服最多一次**（刷屏的提示等于没有提示）；
  //   ② **未绑定提醒与绑定回执走 `tellraw`（只给本人）**，普通回复走公屏
  //      （`tellraw @a` + `<小鲸鱼> ` 前缀、不上色 —— 使用者要求「每条发言都带上
  //      `<小鲸鱼>`、不要高亮、模仿正常玩家」；`say` 会渲染成 `[Server] …` 带配色，故弃用）；
  //   ③ **任何进入游戏的内容都必须过隐私闸** —— 那一条不用在这里做：它在上游
  //      （`#runTurn` 里、`#deliver` 之前），游戏通道与 QQ 通道**共用同一道门**。

  /** `serverId:玩家名` —— 两张内存索引（已提示过 / 已知 UUID）共用的键。 */
  #gameKey(serverId, name) {
    return `${String(serverId ?? '')}:${String(name ?? '')}`
  }

  /**
   * **游戏内那条通道在控制台预览里的会话键**（一台服一个窗口）。
   *
   * ★ 为什么是"一台服一个"而不是"一个玩家一个"：游戏内的回复走的是**公屏** ——
   *   它本来就是**一个公共频道**，所有人都在同一个空间里说话。按人分窗口反而
   *   看不出"当时公屏上都有谁"。说话人靠每条消息上的 `senderName` 区分。
   * ★ 前缀用 `game:` 而不是复用 `group:`/`private:` —— 界面要能一眼看出来这是
   *   游戏里的对话（它是**第三种**通道，不是 QQ 群也不是 QQ 私聊）。
   */
  #gameChatKey(serverId) {
    return `game:${String(serverId ?? '')}`
  }

  /**
   * 收到一条游戏内事件（`chat` / `join` / `leave` / `uuid` / `onlineOnly`）。
   * ★ 永不抛（调用方是读日志的循环，抛了会连累后面所有人的话）。
   */
  async #onGameEvent(server, event) {
    const sid = String(server?.id ?? '')
    const name = String(event?.name ?? '')
    if (!sid || !name) return
    const key = this.#gameKey(sid, name)
    const workspace = this.config?.dsh?.workspace ?? ''

    if (event.kind === 'uuid') {
      // ★ `UUID of player X is …`：玩家**一登录就写**（比 `list uuids` 更早更可靠）
      this.#gameUuids.set(key, String(event.uuid ?? '').toLowerCase())
      return
    }
    if (event.kind === 'join') {
      // ★ 进服 = 重置"已提示过"，于是**每次进服最多提示一次**这条纪律成立
      this.#gameReminded.delete(key)
      const known = lookupByName(workspace, name)
      if (known?.uuid) this.#gameUuids.set(key, known.uuid)
      // ★★★ 使用者 2026-10-04 的明确要求：**未绑定的玩家进服就提醒**，
      //   不是等他先说话（他不上来搭话就永远不知道要绑定）。
      try {
        return await this.#remindUnboundOnJoin(server, name)
      } catch (error) {
        // 提醒发不出去**不该**影响别的（它只是一句话），但要留痕
        this.log(`⚠️ [bind] 进服提醒发不出去（已吞掉）：${error?.message ?? error}`)
        return
      }
    }
    if (event.kind === 'leave') {
      this.#gameReminded.delete(key)
      return
    }
    if (event.kind !== 'chat') return // `onlineOnly`（死亡/成就）不产生任何行为

    try {
      // ★ 把结果**返回出去**（不只是 await）：这一条链的输入是"服务端的一行日志"，
      //   离线测试唯一能观察到它的地方就是这个返回值 —— 吞掉返回值等于让
      //   "游戏内说话 → 模型 → 公屏"这条路又变回"只能靠真机验"。
      return await this.#onGameChat(server, event)
    } catch (error) {
      this.log(`❌ [game-chat] 处理「${name}」的发言时抛异常（已吞掉，其它人照常）：${error?.stack ?? error}`)
      return { handled: false, reason: 'error', error: String(error?.message ?? error) }
    }
  }

  /**
   * 这句话**命中唤醒词**了吗（纯读，不产生任何动作）。
   *
   * ★ 用的是**与已绑定玩家完全同一份**判据（`decideTrigger` + 同一份关键词表），
   *   所以"未绑定的人叫了名字"与"已绑定的人叫了名字"不会出现两套口径。
   * ★ 这里把 `groupEnabled` 显式置真：它是"群聊总开关"，与游戏内那条路无关
   *   （游戏内由 `servers[].gameChat` 自己把关）。
   */
  #gameWakeHit(text) {
    const r = decideTrigger({
      kind: 'group',
      text: String(text ?? ''),
      mentioned: false,
      raw: String(text ?? ''),
      selfId: this.onebot?.selfId ?? '',
      keywords: this.wakeKeywords ?? this.config.trigger?.keywords,
      switches: { ...(this.config.trigger ?? {}), groupEnabled: true },
    })
    return r.respond === true
  }

  /**
   * **进服那一刻**给未绑定的玩家一条提醒（使用者 2026-10-04 明确要求）。
   *
   * ★ 为什么必须在进服时发（而不是等他先说话）：他不上来搭话就永远不知道要绑定，
   *   而"不绑定就不能说话"这条规矩会让新玩家**完全不知道该干什么**；
   *   而**说话时**又不宜提醒 —— 使用者原话是「不能确定每次玩家都在跟小鲸鱼说话」。
   * ★ 三条边界：
   *   ① **已绑定的人一个字都不发**（误报"你还没绑定"比不提醒更糟）——
   *      判据是绑定表（按 UUID，退化到按名字），不是"有没有见过他"；
   *   ② 同一趟进服**只提醒一次**（`#gameReminded`），退服再进会重置；
   *   ③ 认不出身份（既没有 UUID 事件、名字也不在表里）时**仍然提醒** ——
   *      那种情况他几乎一定是新玩家，而"老玩家被误提醒一次"的代价远小于
   *      "新玩家永远不知道要绑定"。★ 有实测背书：真机日志里 `UUID of player X is …`
   *      在 `X joined the game` **之前**（`mocks/verify-log-source.mjs` 有夹具）。
   */
  async #remindUnboundOnJoin(server, name) {
    const sid = String(server?.id ?? '')
    const key = this.#gameKey(sid, name)
    const workspace = this.config?.dsh?.workspace ?? ''
    const uuid = this.#gameUuids.get(key) ?? lookupByName(workspace, name)?.uuid ?? null
    const bound = uuid ? lookupByUuid(workspace, uuid) : null
    if (bound) return { handled: false, reason: 'already-bound' }
    // ★ 不传颜色：使用者要求"不要高亮，模仿正常玩家"（默认白色）
    await this.#gameTellraw(server, name, unboundReminder(name))
    this.#gameReminded.add(key)
    this.log(`🔗 [bind] 「${name}」进服且未绑定 ⇒ 已给他本人一条提醒（每次进服最多一次）`)
    return { handled: true, reason: 'remind-on-join' }
  }

  /**
   * 一条游戏内发言该怎么处理。
   *
   * 顺序（**不能换**）：
   *   ① 解析 UUID（内存索引 → 绑定表里的名字）；
   *   ② 未绑定 ⇒ 看 QQ 侧有没有"刚绑定过的资格"⇒ 成立就**当场写死映射**；
   *   ③ 仍未绑定 ⇒ 提示（每次进服一次）或问"你是哪一个"；
   *   ④ 已绑定 ⇒ 权限判定（**按那个 QQ**）⇒ 唤醒判定（与 QQ 侧**共用关键词表**）⇒ 模型；
   *   ⑤ 回复走 `say` 公屏（`#deliverToGame`）。
   */
  async #onGameChat(server, event) {
    const sid = String(server?.id ?? '')
    const name = String(event.name ?? '')
    const text = String(event.text ?? '')
    const workspace = this.config?.dsh?.workspace ?? ''
    const key = this.#gameKey(sid, name)

    // ① UUID
    let uuid = this.#gameUuids.get(key) ?? null
    if (!uuid) {
      const known = lookupByName(workspace, name)
      if (known?.uuid) {
        uuid = known.uuid
        this.#gameUuids.set(key, uuid)
      }
    }

    // ② ★★★ 游戏内那句"我要绑定"（`\mc bind`）—— **优先于**下面的绑定状态判定
    //
    // 为什么必须排在前面：一个**已经绑定**的玩家也可能重新说一次（换绑/自检），
    // 要是被"已绑定 ⇒ 交给模型"先吃掉，那句话就变成了普通聊天（模型会瞎答一句）。
    // ★ 码**在游戏里生成、与这个 UUID 挂在一起**（2026-10-04 流程改动的核心）：
    //   这样群里提交码的时候就是**确定的映射**，不需要"资格"那一步、也没有歧义。
    if (parseGameBindRequest(text).hit) {
      if (!uuid) {
        // 认不出他是谁 ⇒ **绝不发码**（发出去也没法挂到任何人身上）
        await this.#gameTellraw(
          server,
          name,
          '我还没拿到你的身份（UUID）—— 退出去重进一次服务器，然后再试 \\mc bind。',
          'yellow',
        )
        this.log(`⚠️ [bind] 「${name}」要绑定码，但还没解析到他的 UUID（不发码）`)
        return
      }
      const issued = issueCodeFor({ workspace, uuid, name, serverId: sid })
      if (!issued.ok) {
        await this.#gameTellraw(server, name, `取码失败（${issued.why}）—— 过一会儿再试。`, 'yellow')
        this.log(`❌ [bind] 「${name}」取码失败：${issued.why}`)
        return
      }
      const mins = Math.max(1, Math.round((issued.until - Date.now()) / 60000))
      // ★ 码**只发给本人**（tellraw），**绝不进日志**、也就不进群。
      await this.#gameTellraw(
        server,
        name,
        `你的绑定码是 ${issued.code}（${mins} 分钟内有效、只能用一次）。\n` +
          '把它**直接发到我们那个群里**：`\\mc bind ' +
          issued.code +
          '`（**不用 @ 我**）。',
      )
      this.log(`🔗 [bind] 给「${name}」（UUID ${shortUuid(uuid)}…）出了一张绑定码（码**不进日志**，${mins} 分钟有效）`)
      return
    }

    // ③ 绑定状态
    let bound = uuid ? lookupByUuid(workspace, uuid) : null
    const decision = decideGameChat({
      name,
      uuid,
      bound,
      reminded: this.#gameReminded.has(key),
    })

    if (!bound) {
      // ★★★ 未绑定的人说话：**默认什么都不做**（2026-10-04 使用者的要求）——
      //   「不能确定每次玩家都在跟小鲸鱼说话」，所以不能因为他说了话就回他点什么。
      //   提醒只在**进服那一刻**发一次（`#remindUnboundOnJoin`）。
      // ⚠️ **一个窄得多的例外**：他**明确叫了名字**（命中唤醒词）时补发一次提醒 ——
      //   那种情况我们**确定**他在跟小鲸鱼说话，而沉默会让他以为机器人坏了。
      //   判定用的是**与已绑定玩家同一份**唤醒判据（不另造一套）。要严格"只有进服提醒"
      //   就把这一段删掉（一处判断）。
      if (!this.#gameReminded.has(key) && this.#gameWakeHit(text)) {
        await this.#gameTellraw(server, name, unboundReminder(name))
        this.#gameReminded.add(key)
        this.log(`🔗 [bind] 「${name}」未绑定但**明确叫了名字** ⇒ 补发一次绑定提醒（每次进服最多一次）`)
      }
      return
    }

    // ④ 权限：**按绑定的那个 QQ** 判 —— 但**只看管理员表**（`tierOfSpeaker`）。
    //
    // ★★★ 这里**不查私聊白名单**（使用者 2026-10-04 定的取舍）：他要的是
    //   「**已绑定的玩家**在游戏里叫它就回」。上一版把 QQ 的私聊白名单也当成一道门
    //   ⇒ 玩家好不容易绑上了，却因为那个 QQ 不在 `dmAllowlist` 里而**说不上话**
    //   （还要管理员再去加一次名单）—— 那不是他要的。
    //   ∴ 门是**绑定**（而绑定本身要求"人在服里 + 在某个已允许的群里"）。
    // ⚠️ 权限一分不让：绑上了的普通玩家拿到的是 `USER`（只读），
    //   要动东西仍然只有管理员。见 `roster.mjs` 的 `tierOfSpeaker`。
    const qqId = String(bound.qqId ?? '')
    const tier = this.roster?.tierOfSpeaker?.(qqId) ?? 'user'

    // 唤醒判定：与 QQ 侧**共用关键词表**（设计文档 §5.3）。
    // ★ 这里把 `groupEnabled` 显式置真：游戏内对话由 `servers[].gameChat` 这个
    //   **自己的开关**把关，不该再被"群聊总开关"连坐（那会让"我只想让它
    //   在游戏里说话"变成必须同时打开群聊）。
    const wake = decideTrigger({
      kind: 'group',
      text,
      mentioned: false,
      raw: text,
      selfId: this.onebot?.selfId ?? '',
      keywords: this.wakeKeywords ?? this.config.trigger?.keywords,
      switches: { ...(this.config.trigger ?? {}), groupEnabled: true },
    })
    if (!wake.respond) return

    this.log(`[game-chat] 唤醒（${wake.reason}${wake.hit ? `:${wake.hit}` : ''}）「${name}」→ 按 QQ ${qqId} 跑一轮`)

    // ── ★★★ 控制台预览：游戏内的话**单独一个窗口**（使用者 2026-10-04 要求）──
    //
    // 会话键（记忆/锁/去重）仍然是那个 QQ 的私聊，但**展示**走 `game:<服务器>`：
    //   ① 把玩家这句记进那个窗口（带**游戏里的名字** —— 那才是这句话的说话人）；
    //   ② 顺手进语料库（于是那个窗口里的"搜历史"是真的能搜到东西的）。
    const gKey = this.#gameChatKey(sid)
    const gWho = { kind: 'game', peerId: sid, chatName: `游戏内对话 · ${String(server?.name ?? sid)}` }
    this.#mirror(gKey, 'user', text, { ...gWho, senderId: qqId, senderName: name })
    this.#recordCorpus({
      kind: 'game',
      peerId: sid,
      messageId: null,
      userId: qqId,
      senderName: name,
      text,
      isBot: false,
      mediaCount: 0,
      atTargets: '',
      replyToId: null,
    })

    // ⑤ 跑一轮模型，回复**直接发到公屏**
    return this.#runTurn({
      // ★★ 会话与权限**都按那个 QQ 走**（`private:<QQ号>`）：游戏内的话与他在 QQ
      //   私聊里的话落进**同一段记忆、同一个会话** —— 那正是"绑定"要买到的东西。
      // ★ 而**展示**走 `displayKey`（游戏内那个窗口）—— 两件事分开，见 `#runTurn`
      //   里 `dKey` 那段长注释。
      kind: 'private',
      peerId: qqId,
      senderId: qqId,
      // ★ 绑定即能说话；权限只由管理员表决定（`tierOfSpeaker`，见上面 ④ 的长注释）
      tier,
      rendered: { text, mentioned: false, replyTo: null, imageRefs: [], videoRefs: [] },
      reason: wake.reason,
      deliverTo: { channel: 'game', server, playerName: name, qqId },
      displayKey: gKey,
      display: gWho,
      // ★ 来源标注整条替换：不这么做，模型会以为在一对一私聊里，
      //   而它说的每一句都会**当场印在全服公屏上**（见 channel-prompt.mjs）。
      //
      // ★★★ 最后那段"能不能用控制台"是 2026-10-04 两轮教训的合并结果 —— 两个方向都错过一次：
      //
      //   **第一版（错在太含糊）**：什么都不说 ⇒ 模型被要求查 TPS 时自己编，编出来的是
      //   「那个「允许从 QQ 下指令」的开关没开，得先去配置里打开」—— 对站在游戏里的玩家
      //   毫无用处（他去开那个开关也不会有用）。于是使用者来问「这个开关跟在游戏内
      //   发布指令有何关系」。
      //
      //   **第二版（错在太绝对）**：我改成一句无条件的「游戏内这条通道没有控制台权限」——
      //   而那是**假的**：这一轮的说话人绑定到了管理员 QQ，桥接**已经给这一轮写了
      //   控制台授权**（日志里就有：`🎛️ [servers] 已给这一轮写控制台授权
      //   （private:100000001·admin）`）。于是使用者让它在游戏里查 TPS 时，它照着我写的
      //   那句话回「公屏这条通道我没有控制台权限，你自己在服务端控制台敲一句 forge tps」
      //   —— **把自己的活推回给了使用者**，而同一句话在 QQ 私聊里问就老老实实去查了
      //   （同一条会话键 `private:100000001`，同一个授权文件）。
      //
      //   ∴ 现在**按 tier 分三支**（判据只用桥接自己算出来的事实，不让模型猜）：
      //     · 管理员 + 至少一台服开了 `commandFromQQ` ⇒ **它确实能用**，要查就直接查；
      //     · 管理员 + 一台都没开 ⇒ 如实说"开关没开"，并告诉他界面在哪（他能自己开）；
      //     · 非管理员 ⇒ 拿不到授权（桥接不会为 `USER` 写授权文件），别让他去开任何开关
      //       （那个开关开了也没他的份）。
      //   ★ 三种情况都要提醒：**结果会进公屏**，所以挑着说。
      channelOrigin:
        `来自 Minecraft 服务器「${String(server?.name ?? sid)}」的**公屏**，` +
        `说话的是游戏里的玩家 ${name}（已绑定到 QQ ${qqId}）。` +
        '★ 你这一轮的回复会**直接发到那个公屏上 —— 全服所有人都看得见**，' +
        '所以不要说出任何只该让一个人知道的内容（地址、号码、记忆原文、私下的约定等）。' +
        (() => {
          const list = Array.isArray(this.config?.servers) ? this.config.servers : []
          const anyMcOn = list.some((s) => s && s.commandFromQQ === true)
          if (tier === 'admin' && anyMcOn) {
            return (
              '★★★ **这一轮的说话人是管理员，而且这台服开着「允许从 QQ 下指令」⇒ ' +
              '控制台你确实能用**：要查 TPS / 人数 / 状态就**直接调 `mc_command` 工具**' +
              `（\`kind\` 用 \`private\`、\`peerId\` 用 \`${qqId}\`，就是这一轮这个会话；` +
              `\`serverId\` 用 \`${sid}\`）。**别让他自己去控制台敲** —— 那是把你能做的事推回去。` +
              '⚠️ 但结果会进**公屏**：挑着说（在线人数、TPS、有没有卡顿告警这些可以；' +
              'op 名单、白名单、封禁记录、IP 这类别念出来）。'
            )
          }
          if (tier === 'admin') {
            return (
              '★★ 这一轮的说话人是**管理员**，但这台服（以及其它服）都**没有打开**「允许从 QQ 下指令」' +
              '（config.json 的 `servers[].commandFromQQ`，**默认关**）⇒ `mc_command` 会被拒。' +
              '如实说清这一点，并告诉他可以在**本机网页控制台**的服务器页签里勾上那个开关' +
              '（或者让他自己在服务端控制台敲）—— 他是管理员，这个开关就是给他用的。'
            )
          }
          return (
            '★★★ **这一轮你拿不到控制台权限**：说话的玩家**不是管理员**（桥接只给管理员写控制台授权）' +
            '⇒ `mc_command` 会被拒。被要求做这类事时如实说一句"这条要管理员"，' +
            '并给一个他自己能做的办法（例如让他在服务端控制台敲）——' +
            '**不要**让他去打开某个开关，那个开关开了也没有他的份。'
          )
        })(),
    })
  }

  /**
   * 给**某个玩家本人**发一条 `tellraw`（只给他看）。
   *
   * ★ 名字**必须**过 `PLAYER_NAME_RE`（`buildTellraw` 里判）—— 那是防**选择器注入**的
   *   唯一一道门：能塞进 `@` 的名字会让"只给本人"变成"给全服广播"。
   * ★ 永不抛：失败只记日志（增强路径）。
   */
  async #gameTellraw(server, player, text, color = '') {
    const built = buildTellraw({ player, text, color })
    if (!built.ok) {
      this.log(`⚠️ [game-chat] 这条 tellraw 没发出去（${built.why}）—— 内容：${String(text ?? '').slice(0, 60)}`)
      return { ok: false, why: built.why }
    }
    const r = await this.#runGameCommand(server, built.command, 'tellraw')
    // ★★ 控制台预览里记一条 notice（**只给他本人**的那些话也要看得见：
    //    未绑定提醒、绑定码、绑定成功通知）。记成 `→ 玩家：正文` 而不是冒充
    //    "某个发言人说的" —— 它是**点对点**的，不是公屏发言，这个区别必须看得见。
    // ★ 它**只在内存镜像里**（控制台预览），**不进任何日志文件**：绑定码的纪律是
    //   "不进日志"（见 `bindings.mjs`），而控制台预览是使用者本机的实时视图 ——
    //   与群里那条回执同一个口径（那条也带着码进了镜像）。
    this.#mirror(this.#gameChatKey(server?.id), 'notice', `→ ${String(player ?? '')}：${built.text}`, {
      kind: 'game',
      peerId: String(server?.id ?? ''),
      chatName: `游戏内对话 · ${String(server?.name ?? server?.id ?? '')}`,
    })
    return r
  }

  /**
   * 给**这一轮的说话人**发一条**系统提示**（不是正文）—— 按通道选路。
   *
   * ★★★ 为什么必须有这个函数（2026-10-04 使用者实测报的缺陷）：
   *   游戏内那一轮用的是 `kind:'private', peerId:<绑定的 QQ 号>`（会话与记忆要
   *   与他的 QQ 私聊**共用**，见 `#onGameChat` ④）。于是 `#runTurn` 里任何
   *   `#safeSend(kind, peerId, …)` 都会**打到那个人的 QQ 私聊里** ——
   *   他在**游戏里**说的话，回执却出现在 QQ 里。使用者原话：
   *   「在服务器中给小鱼发消息时会触发先应一声，并且会发给QQ私聊」。
   *
   * ∴ 规则一句话：**这一轮从哪进来，提示就从哪回去**。
   *   游戏通道的提示走 `tellraw`（**只给那个玩家，不上公屏** —— 系统提示不是发言）。
   *
   * @param {string} kind      QQ 通道类型（`private` / `group`）
   * @param {string} peerId    QQ 会话号
   * @param {string} text      提示正文
   * @param {{channel?: string, server?: object, playerName?: string}|null} deliverTo
   */
  async #speakerNotice(kind, peerId, text, deliverTo) {
    if (deliverTo?.channel === 'game') {
      await this.#gameTellraw(deliverTo.server, deliverTo.playerName, text)
      return
    }
    await this.#safeSend(kind, peerId, text)
  }

  /**
   * 跑一条**游戏内回应通道**的命令（`say` / `tellraw`）。
   *
   * ★★ 它**不经过 `command-gate.mjs` 的管理员闸** —— 那道闸管的是"从 QQ 下任意
   *   控制台命令"（op 级别）。这里是**固定形状的两条发言通道**，参数由模板生成、
   *   命令名写死，玩家名与正文都过校验 ⇒ 不是同一种风险。
   *   （这一点必须写在明处：拿掉管理员闸不等于没有闸，闸在这里是"命令形状"。）
   * ★ 失败只记账不抛：说不上话不是致命错误，但**必须留痕**。
   */
  async #runGameCommand(server, command, what = 'say') {
    try {
      // ★ 测试注入口（见 `setGameConsoleForTest`）：只换执行器，不换命令的构造。
      const r =
        typeof this.#testGameConsole === 'function'
          ? await this.#testGameConsole({ server, command, what })
          : await runConsoleCommand({
              server,
              command,
              workspace: this.config?.dsh?.workspace ?? '',
            })
      if (!r.ok) {
        this.log(`❌ [game-chat] ${what} 没发出去（${r.why ?? '未知原因'}）—— 「${String(server?.name ?? server?.id ?? '?')}」`)
        return { ok: false, why: r.why ?? '未知原因' }
      }
      return { ok: true }
    } catch (error) {
      this.log(`❌ [game-chat] ${what} 抛异常（已吞掉，机器人照常工作）：${error?.message ?? error}`)
      return { ok: false, why: String(error?.message ?? error) }
    }
  }

  /**
   * 把一轮回复发进游戏（**公屏 `tellraw @a`**，设计文档 §5.4）。
   *
   * ── 为什么**不直接复用 `#deliver`**（这条边界是刻意划的，改之前先读）──────
   * `#deliver` 是**QQ 传输形状**的：它发**表情包**、发 QQ **内置脸**、挂
   * `[reply:#id]` **引用气泡**、按 QQ 的单条上限（1500 字）硬切，还往
   * **投递账本**里写一份"这条 QQ 回复发到哪了"。这些东西**在游戏里一样都不存在** ——
   * 把 `#deliver` 整个搬过来，只会凭空多出四件游戏里没有的东西，并且让
   * "QQ 那条路"与"游戏那条路"从此必须一起改。
   *
   * ── 共用的是**上游**（所以没有分叉出第二套行为）────────────────────────────
   * 模型那一轮、终检门（内部泄漏）、**隐私闸门**、`[reply:]`/`[sticker:]` 标记剥离、
   * 兜底话术**全部在 `#runTurn` 里、在调用本方法之前**已经跑过（见那里的位置纪律）。
   * 这里只负责"把已经审过的那串字，按游戏的方式送出去"，并**共用同一份拟人延迟**。
   *
   * ── 投递账本为什么不用 ────────────────────────────────────────────────────
   * 账本是"QQ 那一侧丢没丢"的凭据；游戏这一侧的凭据是**桥接自己的日志**
   * （见下面那句"说（公屏）："）——`tellraw` **不写服务端控制台日志**（实测），
   * 所以不能指望它。多记一份只会多一个可能与现实不符的来源。
   */
  async #deliverToGame(server, playerName, answer, { turnStartedAt = null, qqId = '' } = {}) {
    const text = String(answer ?? '')
    if (!text.trim()) return

    // ── 拟人延迟（与 QQ 侧**同一套** `computeReplyDelay`）────────────────────
    // ★ 为什么游戏里也要延迟：公屏上"秒回一长段"同样一眼是机器。
    //   而且**感知下限**这件事在两边是一回事（总时长≈档位目标）。
    const elapsedMs =
      typeof turnStartedAt === 'number' && Number.isFinite(turnStartedAt)
        ? Math.max(0, Date.now() - turnStartedAt)
        : undefined
    const { delayMs } = computeReplyDelay({
      textLength: text.length,
      humanize: this.config.humanize,
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    })
    if (delayMs > 0) {
      this.log(`[game-chat] 拟人延迟 ${Math.round(delayMs / 1000)} 秒后再发到公屏（回复 ${text.length} 字）`)
      await this.#sleepUnlessClosing(delayMs)
    }

    // ── 分片：游戏只按**长度**切（公屏信息密度低，分太多条只会刷屏）──────────
    const chunks = chunkForChat(text)
    if (chunks.length === 0) return

    let sent = 0
    for (const chunk of chunks) {
      // ★★ 公屏那条是 `tellraw @a`（原来用 `say`）：使用者要求
      //   「每条发言都要在前面加上 `<小鲸鱼>`，**不要高亮**，模仿正常玩家」——
      //   `/say` 渲染成 `[Server] 正文` 且带配色，那是"服务端公告"而不是玩家发言。
      const built = buildPublicChat({ text: chunk })
      if (!built.ok) {
        this.log(`⚠️ [game-chat] 这一片没能构造出公屏命令（${built.why}）`)
        continue
      }
      const r = await this.#runGameCommand(server, built.command, 'say')
      if (!r.ok) {
        // ★ 发不出去 = 对方以为"它没理我"。**必须留痕**，且**绝不重发、绝不重跑模型**
        //   （同 H17 那三条纪律：重跑会再花一次钱，还可能给出与刚才不同的答案）。
        this.log(
          `❌ [game-chat] 回复没能发到「${String(server?.name ?? server?.id ?? '?')}」的公屏` +
            `（已发 ${sent}/${chunks.length} 片）：${r.why} —— **不重发、更不会重跑模型**`,
        )
        return { ok: false, sent, total: chunks.length }
      }
      // ★★★ **必须自己记一条**：`tellraw` 与服务端的 `say` 不同 —— 它**不写控制台日志**
      //   （实测：`say` 会 echo 成 `[Rcon] …`，`tellraw` 一声不响）。所以它说过什么
      //   在「实时后台」里**看不到**了 ⇒ 由桥接日志补上这条记录（"失败不静默 / 可核对"
      //   这条能力不能因为换通道而丢掉）。
      this.log(`[game-chat] 说（公屏）：${built.text}`)
      // ★★ 控制台预览里也记一条（那个「游戏内对话」窗口要能看到它自己说过什么）——
      //    否则窗口里只有玩家的话、没有它的回复，看起来像"它没理人"。
      this.#mirror(this.#gameChatKey(server?.id), 'bot', built.text, {
        kind: 'game',
        peerId: String(server?.id ?? ''),
        chatName: `游戏内对话 · ${String(server?.name ?? server?.id ?? '')}`,
      })
      this.#recordCorpus({
        kind: 'game',
        peerId: String(server?.id ?? ''),
        messageId: null,
        userId: '',
        senderName: '',
        text: built.text,
        isBot: true,
        mediaCount: 0,
        atTargets: '',
        replyToId: null,
      })
      void qqId
      sent += 1
    }
    this.log(
      `[game-chat] 已回复「${String(server?.name ?? server?.id ?? '?')}」公屏` +
        `（${text.length} 字，${sent} 条；玩家 ${String(playerName ?? '')}）`,
    )
    return { ok: true, sent, total: chunks.length }
  }

  /**
   * 起（或重启）服务器监测循环。
   *
   * ★ 抽出来是为了让"改了服务器列表"能**即时生效**（`reloadServers()`）：
   *   循环的定时器是 `start()` 时建的，所以列表变了必须**停掉重建** ——
   *   只改 `this.config.servers` 的话，`servers()` getter 虽然会返回新列表，
   *   但已经排好的采样节奏与内部 `byId` 缓存（monitor/client）都还是旧的，
   *   表现是"新加的那台一直不采样"。
   * ★ 只**配了服务器**才建：空列表 ⇒ 一次网络请求都不发、也不起定时器。
   */
  #startServerLoop() {
    try {
      this.#serverLoop?.stop?.()
      this.#serverLoop = null
      const servers = Array.isArray(this.config.servers) ? this.config.servers : []
      if (servers.length === 0 || !this.config.dsh?.workspace) return
      this.#serverLoop = createServerLoop({
        workspace: this.config.dsh.workspace,
        servers: () => (Array.isArray(this.config.servers) ? this.config.servers : []),
        pollMs: this.config.serversPollMs,
        log: this.log,
        onEvent: (row) => {
          // 事件回调**不 await**（它在采样循环里）：投递是另一条时间线上的事，
          // 卡住采样会让下一台的采样一起迟到。
          this.#onServerEvent(row).catch((error) => {
            this.log(`❌ [servers] 处理事件时抛异常（监测照常，下一次仍会采）：${error?.message ?? error}`)
          })
        },
      })
      this.#serverLoop.start()
    } catch (error) {
      // 监测起不来不该影响桥接 —— 但要留证据（AGENT.md 第 9 条）
      this.log(`❌ [servers] 服务器监测启动失败（机器人照常工作）：${error?.message ?? error}`)
    }
  }

  /**
   * 起"读游戏内聊天"的循环（0.3.2 P3）。
   *
   * ★ 只有**显式打开了 `servers[].gameChat`** 才建 —— 这与"危险的能力默认关"
   *   同一条口径（它会**代表玩家对模型说话**，而且要读控制台日志）。
   *   一台都没开 ⇒ **不起定时器、不读任何文件**。
   * ★ 它与 `#startServerLoop` 是**两个循环**（节奏差一个数量级，见 `game-chat.mjs` 文件头）。
   */
  #startGameChatLoop() {
    try {
      this.#gameChat?.stop?.()
      this.#gameChat = null
      const servers = Array.isArray(this.config.servers) ? this.config.servers : []
      if (!this.config.dsh?.workspace) return
      if (!servers.some((s) => s && s.gameChat === true && s.enabled !== false)) return
      this.#gameChat = createGameChatLoop({
        workspace: this.config.dsh.workspace,
        servers: () => (Array.isArray(this.config.servers) ? this.config.servers : []),
        pollMs: this.config.gameChatPollMs,
        log: this.log,
        onEvent: (server, event) => this.#onGameEvent(server, event),
      })
      this.#gameChat.start()
    } catch (error) {
      // 游戏内对话起不来不该影响桥接 —— 但要留证据（AGENT.md 第 9 条）
      this.log(`❌ [game-chat] 游戏内对话启动失败（QQ 侧照常工作）：${error?.message ?? error}`)
    }
  }

  /**
   * **让盘上的服务器列表即时生效**（0.3.2 收尾「改配置即时生效」）。
   *
   * ★ 为什么需要它：界面加/改/删一台服务器之后，若还要**重启桥接**才生效，
   *   那"我之后换了服务器怎么办"这件事就没解决 —— 而列表是纯数据，
   *   没有任何理由为它重启整个机器人（重启会断开 QQ、也会打断在跑的回合）。
   *
   * 判据（**顺序重要**）：
   *   ① `readServers()` 返回 `null`（读不到）⇒ **什么都不动**，如实说明。
   *      空数组 ≠ 读不到：前者是"使用者就是要停掉服务器功能"，后者是"我不知道现在是什么"。
   *   ② 列表与内存那份**逐条比对**（`JSON.stringify` 足够：归一化后字段顺序稳定），
   *      相同就**不重建循环**（重建会丢掉 monitor 的连续失败计数 ⇒ 可能误报一次 down）。
   *   ③ 不同 ⇒ 换掉 `this.config.servers` 并重建循环。
   *
   * @returns {{ok: boolean, changed: boolean, count: number, why?: string}}
   */
  reloadServers() {
    if (!this.readServers) {
      return { ok: false, changed: false, count: 0, why: '这个实例没有接"现读配置"的口子（测试环境常见）' }
    }
    const next = this.readServers()
    if (next === null) {
      return { ok: false, changed: false, count: 0, why: '读不到 config.json（沿用内存里那份，不改动）' }
    }
    const before = JSON.stringify(Array.isArray(this.config.servers) ? this.config.servers : [])
    const after = JSON.stringify(next)
    if (before === after) {
      return { ok: true, changed: false, count: next.length }
    }
    this.config.servers = next
    this.#startServerLoop()
    // ★★ 0.3.2 P3：**游戏内对话的循环也要跟着重建**（`#startGameChatLoop` 从头判
    //   "有没有任何一台开了 `gameChat`"）。不重建的话界面上的那个复选框会**撒谎**：
    //   保存成功、提示"已即时生效、不必重启桥接"，而读控制台的循环其实根本没起来
    //   —— 表现是"我在界面上打开了，可游戏里说话它不理我"，且不报任何错。
    this.#startGameChatLoop()
    this.log(
      `♻️ [servers] 服务器列表已更新（${next.length} 台）—— 监测循环已按新列表重启` +
        '（不必重启桥接）',
    )
    return { ok: true, changed: true, count: next.length }
  }

  /**
   * 桥接启动时接手服务端（0.3.2 P2「启动接管」，设计文档 §6.3.1）。
   *
   * 判据顺序不能换：
   *   ① 端口活着 + 归属是我 ⇒ 接管（只挂监测，不上手）
   *   ② 端口活着 + 归属不是我/判不出 ⇒ 如实降级成只报告、不重启
   *   ③ 端口不通 ⇒ 按 startExe/startCommand 拉起来
   *
   * ★★★ 最贵的一条纪律：端口活着时绝不调用 launch()。
   *   两个 JVM 同时打开同一个世界目录 = 存档损坏（不可逆），比少一个自动重启严重得多。
   *   所以判据是「端口不通才拉」，而不是「归属不是我」。
   */
  async manageServersOnStartInternal() {
    const servers = Array.isArray(this.config?.servers) ? this.config.servers : []
    const targets = servers.filter((s) => s && s.enabled !== false && s.manageOnStart === true)
    if (targets.length === 0) return
    for (const s of targets) {
      try {
        const own = await this.#serverOwnership(s)
        if (own?.portOpen) {
          if (own.owner === 'bridge') {
            const weakNote = own.weak ? '（弱证据：命令行比对）' : ''
            this.log(`⏭️ [servers] ${s.name ?? s.id} 已在跑且确认是我起的（pid ${own.pid}）${weakNote} ⇒ 接管，不重复拉起`)
          } else {
            this.log(`⚠️ [servers] ${s.name ?? s.id} 端口有东西在听，但归属不是我（${own.why}）⇒ 只监测、不接管、不重启（绝不先杀再起去抢别人的服务端）`)
          }
          continue
        }
        this.log(`▶️ [servers] ${s.name ?? s.id} 没在跑（${own?.why ?? '端口不通'}）⇒ 按 manageOnStart 拉起来`)
        const r = await this.launchServerInternal(s)
        if (!r?.ok) {
          this.log(`❌ [servers] ${s.name ?? s.id} 没起来：${r?.why ?? '未知原因'}`)
          continue
        }
        const configured = Number(s.startWaitMs)
        const waitMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_START_WAIT_MS
        // ★★★ **记下启动窗口**（在端口开放之前）——否则监测会把它判成 down，
        //   而 `down` 是唯一允许触发重启的那一类 ⇒ 可能"再拉一个"（两个 JVM 同写世界）。
        //   窗口长度用同一个 `waitMs`（与下面等端口的那段一致，免得两处口径不同）。
        markStarting({ workspace: this.config?.dsh?.workspace, serverId: s.id, pid: r.pid, windowMs: waitMs })
        this.log(`   ✅ 已拉起（pid ${r.pid}）· 输出 → ${r.logFile}`)
        const up = await this.waitPortListeningInternal(s, waitMs)
        if (up) {
          // ★ 端口开了 ⇒ 启动窗口结束（"等 RCON 登录"是另一回事，不靠这个状态）
          clearStarting({ workspace: this.config?.dsh?.workspace, serverId: s.id })
          this.log(`   ✅ ${s.name ?? s.id} 端口 ${s.port} 已开放，服务端真的起来了`)
        } else {
          const secs = Math.round(waitMs / 1000)
          // ★ 窗口到期 ⇒ 清掉（之后按正常判据判 down，不再"一直算启动中"）
          clearStarting({ workspace: this.config?.dsh?.workspace, serverId: s.id })
          this.log(`   ❌ ${s.name ?? s.id} 等了 ${secs} 秒，端口 ${s.port} 一直没开 ⇒ 它没起来。去看控制台输出：${r.logFile}`)
          this.log('      常见原因：JVM 参数/路径不对、EULA 没同意、端口被占、内存不够。')
        }
      } catch (error) {
        this.log(`❌ [servers] 启动时处理 ${s?.name ?? s?.id} 时抛异常（机器人照常工作）：${error?.message ?? error}`)
      }
    }
  }

  /**
   * 探端口直到有东西在听或超时。
   * 用注入的 portOpen（测试）或守护器自己的探针 —— 不自己再实现一遍。
   */
  async waitPortListeningInternal(server, waitMs) {
    const host = server.host ?? '127.0.0.1'
    const port = server.port ?? 25565
    const beganAt = Date.now()
    const deadline = beganAt + waitMs
    let lastReported = 0
    for (;;) {
      const open = this.#testPortOpen
        ? Boolean(await this.#testPortOpen(host, port))
        : await defaultPortProbe(host, port)
      if (open) return true
      if (Date.now() >= deadline) return false
      const waited = Math.round((Date.now() - beganAt) / 1000)
      if (waited - lastReported >= 15) {
        lastReported = waited
        this.log(`   … ${server.name ?? server.id} 已等 ${waited} 秒，端口还没开（模组服首次启动可能要几分钟）`)
      }
      await new Promise((res) => setTimeout(res, 1500))
    }
  }

  /**
   * 拉起一台服务端（懒建守护器；测试可注入）。
   * 与 #serverOwnership 同一个懒建模式，避免在构造期就碰盘。
   */
  async launchServerInternal(server) {
    if (this.#testLaunch) return this.#testLaunch(server)
    if (!this.#supervisor) {
      this.#supervisor = createSupervisor({ workspace: this.config?.dsh?.workspace, log: this.log })
    }
    return this.#supervisor.launch(server)
  }

  /**
   * 手动触发一次定时整理（测试与排查用；返回本次结果）。
   * @returns {object}
   */
  consolidateNow() {
    if (!this.#consolidate) return { ok: false, why: '定时整理没有启动' }
    return this.#consolidate.tick()
  }

  /**
   * 手动跑一次定时任务巡检（测试与排查用；返回本次结果）。
   *
   * ★ 与 `consolidateNow` 一样是**只读排查手段**：它不会因为"巡检"而多做任何事，
   *   只是把该 tick 的那一跳立刻跑一遍（到点了就真发）。
   */
  scheduleNow() {
    if (!this.#schedule) return { ok: false, why: '定时任务没有启动（schedule.enabled !== true）' }
    return this.#schedule.tick({ reason: 'manual' })
  }

  /**
   * 定时任务的运行统计（只读，给巡检与界面用）。
   *
   * ★★ `ok` 只表示"这个查询本身成功了"，**不代表定时器挂上了** ——
   *   后者看 `running`。这两件事必须分开报：把它们合成一个 `ok:false`
   *   会让界面只能显示"没有启动"，而说不出"**开关开着、但定时器没挂上**"
   *   （那正是"我明明打开了它却不响"的形状）。
   */
  scheduleStats() {
    if (!this.#schedule) {
      return { ok: true, running: false, why: '定时器没挂上（schedule.enabled !== true，或还没同步过）' }
    }
    return { ok: true, running: true, ...this.#schedule.stats() }
  }

  /**
   * **让定时任务的开关即时生效**（0.3.2 补）—— 按活配置把定时器挂上或摘掉。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * 为什么需要它（用户报的原文）
   * ══════════════════════════════════════════════════════════════════════════
   *   「我在拓展中开启了定时任务功能，但是标签页中显示未开启且读不到定时任务」
   *
   * 定时的**判定**本来每跳现读 `config.schedule`（那是 hot 的那一半），
   * 但 `#schedule` 这个**定时器对象**原先只在 `attach()` 里建 ⇒ 用户在界面上
   * "从关到开"之后，**一条任务都不会触发**，而界面上写着"功能已开启"。
   * 这与 P3 的 `gameChat` 复选框是**同一个形状**的缺陷（保存了、提示生效了、
   * 而那条路根本没接上），所以用同一种办法修：**改了就地重建**。
   *
   * ★ 幂等：状态一致时什么都不做（重复调用不会挂出第二个定时器）。
   * ★ 失败只记日志、不抛（AGENT.md 第 9 条：增强路径不该拖垮桥接）。
   *
   * @returns {{ok: boolean, changed: boolean, running: boolean, why?: string}}
   */
  syncScheduleRunner() {
    try {
      const want = this.config?.schedule?.enabled === true && Boolean(this.config?.dsh?.workspace)
      const has = Boolean(this.#schedule)
      if (want === has) return { ok: true, changed: false, running: has }
      if (!want) {
        this.#schedule?.stop?.()
        this.#schedule = null
        this.log('🕒 [schedule] 定时任务已关闭 —— 定时器已摘掉（一条任务都不会触发）')
        return { ok: true, changed: true, running: false }
      }
      this.#schedule = createScheduleRunner({
        workspace: this.config.dsh.workspace,
        config: this.config,
        bridge: {
          resolveTarget: (opts) => this.resolveScheduleTarget(opts),
          runProactiveTurn: (opts) => this.runProactiveTurn(opts),
        },
        log: this.log,
      })
      this.#schedule.start()
      this.log('🕒 [schedule] 定时任务已开启 —— 定时器已挂上（**立刻生效**，不必重启桥接）')
      return { ok: true, changed: true, running: true }
    } catch (error) {
      // 起不来不该影响桥接 —— 但要留证据（AGENT.md 第 9 条）
      this.log(`❌ [schedule] 定时任务同步失败（机器人照常工作）：${error?.message ?? error}`)
      return { ok: false, changed: false, running: Boolean(this.#schedule), why: String(error?.message ?? error) }
    }
  }

  /**
   * **服务器页签要的全部事实**（0.3.2 P2/P4；只读，给 `GET /api/servers` 用）。
   *
   * ★ 与 `scheduleNow()` 同类：这是**给界面看的运行时快照**，不做任何动作。
   * ★ 组装放在这里而不是 `api.mjs`：活证据要运行时对象（监测循环的状态、归属探针、
   *   重启状态机），而 `api.mjs` 刻意"只做接口、不碰业务"。
   * ★ **不回密码**：这里只给 `passwordSet`（配没配），密码本身永不出这个函数。
   */
  async serversSnapshotForApi() {
    const workspace = this.config?.dsh?.workspace
    const list = Array.isArray(this.config.servers) ? this.config.servers : []
    const stats = this.#serverLoop?.stats?.() ?? null
    const rows = []
    for (const s of list) {
      // 监测状态（这台采过样才有）
      let monitor = null
      try {
        const st = this.#serverLoop?.stateOf?.(s.id) ?? null
        if (st) {
          monitor = {
            phase: st.phase === 'down' ? 'down' : 'up',
            samples: st.samples ?? 0,
            failures: st.failures ?? 0,
            lastAt: st.lastAt ?? null,
            lastReachable: st.lastReachable ?? null,
            lastPlayers: st.lastPlayers ?? null,
            lastTps: st.lastTps ?? null,
            lastVersion: st.lastVersion ?? null,
            lastError: st.lastError ?? null,
          }
        }
      } catch {
        /* 增强路径：读不到就是 null（界面显示"还没采过样"） */
      }
      // ★★★ **启动窗口**：把"正在启动"与"挂了"分开（界面据此显示 🟡 而不是 🔴）。
      //   判据只有一处（`evaluateStarting`），监测循环与界面共用同一份，
      //   避免"监测说在启动、界面说 down"那种两处措辞分叉。
      let startingInfo = null
      try {
        const st = readStarting({ workspace, serverId: s.id })
        if (st) {
          const ev = evaluateStarting({ state: st, portOpen: ownership?.portOpen === true, now: Date.now() })
          if (ev.starting) {
            startingInfo = { starting: true, waitedMs: ev.waitedMs, leftMs: ev.leftMs, text: describeStarting(ev) }
          } else if (ev.expired) {
            startingInfo = { starting: false, expired: true, waitedMs: ev.waitedMs, leftMs: 0 }
          }
        }
      } catch {
        /* 增强路径：读不到就当没有启动窗口 */
      }
      // 归属（**只报告不重启**那条纪律的依据）
      let ownership = null
      try {
        ownership = await this.#serverOwnership(s)
      } catch (error) {
        ownership = { owner: 'unknown', why: `查归属失败：${error?.message ?? error}` }
      }
      // 重启状态机（冷却 / 等指令 / 上次结果）
      let restart = null
      try {
        const r = this.#restarterFor.get(s.id)
        if (r) {
          const st = r.state()
          restart = {
            attempts: st.attempts ?? 0,
            lastOutcome: st.lastOutcome ?? null,
            lastAttemptAt: st.lastAttemptAt ?? null,
            cooldownUntil: st.cooldownUntil ?? null,
            waitingForAdmin: st.waitingForAdmin === true,
          }
        }
      } catch {
        /* 同上 */
      }
      rows.push({
        id: s.id,
        name: s.name,
        enabled: s.enabled !== false,
        host: s.host,
        port: s.port,
        rconPort: s.rconPort,
        // ★★★ 启动窗口（界面据此显示 🟡 正在启动，而不是 🔴 down）
        starting: startingInfo,
        passwordSet: Boolean(s.password),
        startCommandSet: Boolean(String(s.startCommand ?? '').trim()),
        // ★ 界面要按"能不能拉起它"来判断重启能力，而启动形状有**两条路**：
        //   `startExe`+`startArgs`（不走 shell，归属可判定 —— 推荐）
        //   `startCommand`（走 shell，`cmd.exe` 会先退出 ⇒ 归属难判）
        //   只报 `startCommandSet` 会让"只配了 startExe"的机器在界面上显示成不可重启。
        startExeSet: Boolean(String(s.startExe ?? '').trim()),
        startExe: String(s.startExe ?? '').trim(),
        // ★ TPS 是**问了才有**：留空表示"我们没问"（不是"问了没拿到"）。
        //   界面必须能区分这两件事，否则"TPS 拿不到"看起来像服务端的毛病。
        tpsCommand: String(s.tpsCommand ?? '').trim(),
        // ★ 启动接管：桥接启动时要不要管这台（界面显示用）。
        //   它与"点一下就启动"是两件事 —— 界面**不做**启动按钮（见 CONFIG-UI.md §2.12）。
        manageOnStart: s.manageOnStart === true,
        // ★ 0.3.2 P3：游戏内对话（界面上的开关 + 说明）。
        //   ★ 它决定"读不读这台服的控制台、听不听里面的人说话"，所以界面必须能看见。
        gameChat: s.gameChat === true,
        // ★★★ **允许从 QQ 下控制台指令**（0.3.2 收尾）—— 界面**必须能看见、也必须能改**。
        //
        // ★ 为什么这条注释值得写这么长（2026-10-04 使用者报的第二件事）：
        //   他明明开过这个开关，bot 却一直回「那个开关没开」。查下来是
        //   **界面上压根没有这个勾选框**，而保存又是"整条替换" ⇒ 他每点一次保存
        //   就被重置成 `false`，而**界面上没有任何地方能看出来**。
        //   （他当时只能照 bot 说的去手改 config.json —— 那就是"配置只有界面一条路"
        //     这条设计被破的一个实例。）
        // ★ 它与 `gameChat` 是**两条互不相干的路**，界面必须说清（否则就会像他那样问
        //   「这个开关跟在游戏内发布指令有何关系」）：
        //   · `commandFromQQ` ⇒ **QQ 条**下控制台指令（群里发 `\mc <命令>`、或模型调
        //     `mc_command` 工具）。**游戏内一个字都不受影响**；
        //   · `gameChat` ⇒ 读游戏内聊天、让绑定过的玩家说话（**只有对白，没有指令**）。
        //   游戏内**发不出**控制台指令：那需要服务端插件注册真命令，而 v1 不写服务端代码。
        commandFromQQ: s.commandFromQQ === true,
        failThreshold: s.failThreshold,
        rules: s.rules ?? {},
        monitor,
        ownership,
        restart,
        // 给界面显示"上次采样在多久前"用（后端给时间戳，前端自己算差值）
        lastSample: monitor?.lastAt ?? null,
        __password: s.password, // ★ 只给 api.mjs 那一层做"泄露兜底断言"，不进响应
      })
    }
    return {
      ok: true,
      enabled: list.length > 0,
      running: Boolean(stats?.running),
      pollMs: Number.isFinite(Number(this.config.serversPollMs)) ? Number(this.config.serversPollMs) : null,
      servers: rows,
      recentEvents: [],
      workspace: Boolean(workspace),
    }
  }

  /**
   * **读**这台服务端的 `server.properties` 里 RCON 那三项的当前状态（界面用；只读）。
   *
   * ★ 由 `api.mjs` 的路由调用（那边只做接口，业务在这一层 —— 与 `serversSnapshotForApi` 同一分工）。
   * ★ **永不回密码本身**：只说"配了没有"。密码长度也不回（长度也是信息）。
   */
  async serverPropertiesForApi({ serverId = '' } = {}) {
    const list = Array.isArray(this.config?.servers) ? this.config.servers : []
    const server = list.find((s) => s && String(s.id) === String(serverId)) ?? null
    if (!server) return { ok: false, why: `配置里没有 id 为「${serverId}」的服务器` }
    const workspace = this.config?.dsh?.workspace ?? ''
    const at = resolvePropertiesPath({ workspace, server })
    if (!at.ok) return { ok: false, why: at.why, serverId: server.id }
    const file = readTextFile(at.path)
    if (!file.ok) return { ok: false, why: file.why, serverId: server.id, path: at.path }
    const settings = readServerSettings(file.text)
    // ★ EULA 在**隔壁那个文件**里：`eula.txt`（服务端首次启动时才生成 ⇒ 不存在也算一种状态）
    const eulaAt = resolveEulaPath({ workspace, server })
    let eula = { path: eulaAt.path ?? '', exists: eulaAt.exists === true, agreed: null }
    if (eulaAt.ok && eulaAt.exists) {
      const ef = readTextFile(eulaAt.path)
      if (ef.ok) eula = { path: eulaAt.path, exists: true, agreed: readEula(ef.text).agreed }
    } else if (eulaAt.ok) {
      eula = { path: eulaAt.path, exists: false, agreed: null }
    }
    return {
      ok: true,
      serverId: server.id,
      path: at.path,
      from: at.from,
      settings,
      describe: describeServerSettings(settings),
      eula,
      // ★★ 与配置对不上的项：**每一对都会让"改了没用"**（端口对不上 ⇒ 监测说它挂了；
      //    密码对不上 ⇒ RCON 认证被拒）。以前只报 RCON 那一对，现在连游戏端口一起报。
      configPort: Number.isFinite(Number(server.port)) ? Number(server.port) : null,
      configRconPort: Number.isFinite(Number(server.rconPort)) ? Number(server.rconPort) : null,
      configPasswordSet: Boolean(server.password),
    }
  }

  /**
   * **写**这台的 `server.properties`（只动托管的那几行）与/或 `eula.txt`，并顺手备份。
   *
   * ★ 四条纪律（详见 `servers/properties.mjs` 文件头）：只碰托管的行、写前备份、
   *   **写前重新读一次并要求内容与刚才一致**（乐观并发：不盖掉使用者在别处的改动）、
   *   改了要**重启服务端**才生效。
   * ★ 它**不写我们的 config** —— 那件事由路由用 `readRawConfig/writeRawConfig` 做
   *   （与"保存服务器条目"走同一条路，才不会两处口径分叉）。
   */
  async applyServerProperties({ serverId = '', serverPort, enableRcon, rconPort, password, agreeEula } = {}) {
    const list = Array.isArray(this.config?.servers) ? this.config.servers : []
    const server = list.find((s) => s && String(s.id) === String(serverId)) ?? null
    if (!server) return { ok: false, why: `配置里没有 id 为「${serverId}」的服务器` }
    const workspace = this.config?.dsh?.workspace ?? ''
    const at = resolvePropertiesPath({ workspace, server })
    if (!at.ok) return { ok: false, why: at.why, serverId: server.id }
    const before = readTextFile(at.path)
    if (!before.ok) return { ok: false, why: before.why, serverId: server.id, path: at.path }

    // ── ① 乐观并发：写之前再读一次，内容和刚读到的不一样就别写（有人同时在改）──
    const again = readTextFile(at.path)
    if (!again.ok || again.text !== before.text) {
      return {
        ok: false,
        serverId: server.id,
        path: at.path,
        why: '这个文件刚刚被别的程序/人改过（内容和几毫秒前读到的不一样）—— 没有覆盖它，请刷新后重试',
      }
    }

    const wantsProps = serverPort !== undefined || enableRcon !== undefined || rconPort !== undefined || password !== undefined
    const patched = wantsProps ? patchServerSettings(before.text, { serverPort, enableRcon, rconPort, password }) : null
    if (wantsProps && !patched.ok) return { ok: false, why: patched.why, serverId: server.id, path: at.path }

    // ── ② EULA（另一个文件；`agreeEula` 缺省 = 不动它）──────────────────────
    let eulaResult = null
    if (agreeEula !== undefined) {
      const eulaAt = resolveEulaPath({ workspace, server })
      if (!eulaAt.ok) return { ok: false, why: eulaAt.why, serverId: server.id, path: at.path }
      const cur = eulaAt.exists ? readTextFile(eulaAt.path) : { ok: true, text: '' }
      if (!cur.ok) return { ok: false, why: cur.why, serverId: server.id, path: eulaAt.path }
      // 同一个乐观并发规则：存在就要求内容没变过
      if (eulaAt.exists) {
        const re = readTextFile(eulaAt.path)
        if (!re.ok || re.text !== cur.text) {
          return { ok: false, serverId: server.id, path: eulaAt.path, why: `${EULA_FILE} 刚刚被别处改过 —— 没有覆盖它，请刷新后重试` }
        }
      }
      const pe = patchEula(cur.text, agreeEula === true)
      if (!pe.ok) return { ok: false, why: pe.why, serverId: server.id, path: eulaAt.path }
      if (pe.changed.length > 0) {
        const bak = eulaAt.exists ? `${eulaAt.path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}` : null
        try {
          if (bak) copyFileSync(eulaAt.path, bak)
          writeFileSync(eulaAt.path, pe.text, 'utf8')
        } catch (error) {
          return { ok: false, why: `写 ${EULA_FILE} 失败：${error?.message ?? error}`, serverId: server.id, path: eulaAt.path, backup: bak }
        }
        eulaResult = { path: eulaAt.path, backup: bak, changed: pe.changed, agreed: agreeEula === true }
        this.log(
          `📜 [servers] 「${server.name ?? server.id}」的 ${EULA_FILE}：${pe.changed.join('、')}（已备份）` +
            ` —— **下次启动服务端才生效**`,
        )
      } else {
        eulaResult = { path: eulaAt.path, backup: null, changed: [], agreed: agreeEula === true, note: '本来就是这个值 —— 没有改任何东西' }
      }
    }

    const propsChanged = patched?.changed ?? []
    if (propsChanged.length > 0) {
      const backup = `${at.path}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
      try {
        copyFileSync(at.path, backup)
        writeFileSync(at.path, patched.text, 'utf8')
      } catch (error) {
        return { ok: false, why: `写失败：${error?.message ?? error}（备份：${backup}）`, serverId: server.id, path: at.path, backup }
      }
      this.log(
        `🎛️ [servers] 改了「${server.name ?? server.id}」的 ${PROPERTIES_FILE}：${propsChanged.join('、')}` +
          `（已备份）—— **要重启服务端才生效**`,
      )
      const settings = readServerSettings(patched.text)
      return {
        ok: true,
        serverId: server.id,
        path: at.path,
        from: at.from,
        backup,
        changed: propsChanged,
        settings,
        describe: describeServerSettings(settings),
        eula: eulaResult,
        note: `已写入 ${PROPERTIES_FILE}。**要重启服务端才生效** —— 那几项是它启动时读进内存的。`,
      }
    }

    // 只动了 eula（或什么都没动）
    const settings = readServerSettings(before.text)
    return {
      ok: true,
      serverId: server.id,
      path: at.path,
      from: at.from,
      backup: null,
      changed: [],
      settings,
      describe: describeServerSettings(settings),
      eula: eulaResult,
      note:
        eulaResult?.changed?.length > 0
          ? `已写入 ${EULA_FILE}（同意 EULA）。**下次启动服务端才生效**。`
          : '这几项本来就是你要的值 —— 没有改任何东西',
    }
  }

  /**
   * **把服务端那份 RCON 凭据读出来**（给"抄过来"那条路用；0.3.2 收尾）。
   *
   * ★ 为什么需要它（使用者 2026-10-04 问：「rcon 密码被忘记了怎么办」）：
   *   密码是**明文**存在两边（服务端 `server.properties` / 我们 `config.json`）——
   *   所以"忘了"通常只是"不知道去哪儿看"。而市面上最容易走错的一步是：
   *   为了对齐两边去**改服务端那份并重启**（那会踢掉在线玩家）。
   *   其实**服务端那份是权威**（它拿它校验每一个 RCON 连接）⇒ 只要它还在，
   *   抄过来就行，**一次重启都不用**。
   *
   * ★ 返回值里有密码本身，所以**只给路由层用来写 config**：
   *   任何接口响应都不许带它出门（路由那段是字段白名单，另有断言盯着）。
   */
  async readServerRconCredentials({ serverId = '' } = {}) {
    const list = Array.isArray(this.config?.servers) ? this.config.servers : []
    const server = list.find((s) => s && String(s.id) === String(serverId)) ?? null
    if (!server) return { ok: false, why: `配置里没有 id 为「${serverId}」的服务器` }
    const workspace = this.config?.dsh?.workspace ?? ''
    const at = resolvePropertiesPath({ workspace, server })
    if (!at.ok) return { ok: false, why: at.why, serverId: server.id }
    const file = readTextFile(at.path)
    if (!file.ok) return { ok: false, why: file.why, serverId: server.id, path: at.path }
    const s = readServerSettings(file.text)
    // ★ 空密码**没有可抄的**：如实说，并指向"设一个新的"那条路（别静默地把空串写进 config ——
    //   那会让这台服从此"看起来配了密码、其实连不上"）。
    if (s.passwordSet !== true) {
      return {
        ok: false,
        serverId: server.id,
        path: at.path,
        why: `服务端那份里的 rcon.password 是**空的** —— 没有可抄的。请用"写入"那条路设一个新的（它会同时改两边）。`,
      }
    }
    // 密码本身只在这里出现（内存里），下面立刻被路由写进 config
    const password = (() => {
      for (const line of file.text.split(/\r?\n/)) {
        const m = /^\s*rcon\.password\s*=(.*)$/.exec(line)
        if (m) return m[1]
      }
      return ''
    })()
    return {
      ok: true,
      serverId: server.id,
      path: at.path,
      from: at.from,
      rconPort: s.rconPort, // 可能是 null（文件里没写）⇒ 路由那边"有值才写"
      password,
    }
  }

  /**
   * **测试用**的薄口：把一条服务器事件直接喂进"要不要自动播报"那条链。
   *
   * ★ 为什么留一个测试入口而不是让测试自己去造 loop：那条链的输入是
   *   **采样结果**，而采样必须真连一台服务端才能产出事件 —— 那让
   *   "事件→播报"这条接线**永远只能靠真机验**。而本项目最贵的缺陷恰好是接线。
   * ★ 它**不是**给产品代码调用的（生产路径由 `#serverLoop.onEvent` 触发）；
   *   行为与那条路径**完全一致**（它就是同一个私有方法）。
   */
  onServerEventForTest(row) {
    return this.#onServerEvent(row)
  }

  /**
   * **游戏内事件**的测试入口（0.3.2 P3）。
   *
   * ★ 为什么必须有它：那条链的输入是**服务端控制台的一行**，而真造出那一行
   *   要求真的拉起一台 Minecraft 服务端 —— 那会让"游戏内对话"这条接线
   *   **永远只能靠真机验**，而本项目最贵的缺陷恰好是接线（先例：任务段那次
   *   "从未注入过"的静默事故，124 项纯函数断言一条都没抓到）。
   * ★ 它**不是**给产品代码调用的（生产路径由 `#startGameChatLoop` 的 onEvent 触发）；
   *   行为与那条路径**完全一致**（同一个私有方法）。
   */
  onGameEventForTest(server, event) {
    return this.#onGameEvent(server, event)
  }

  /** 绑定指令通道的测试入口（0.3.2 P3）—— 同上，走的是同一个私有方法。 */
  handleBindLocalCommandForTest(o) {
    return this.#handleBindLocalCommand(o)
  }

  /** 游戏内对话的循环状态（只读；给巡检与排障用）。 */
  gameChatStats() {
    return {
      running: Boolean(this.#gameChat?.isRunning?.()),
      ...(this.#gameChat?.stats?.() ?? {}),
      reminded: this.#gameReminded.size,
      knownUuids: this.#gameUuids.size,
    }
  }

  /**
   * 绑定表（只读；给巡检与界面用）。
   * ★ UUID 只给前 8 位（`uuid8`）—— 完整 UUID 是敏感数据，界面上没必要给全。
   */
  bindingsForApi() {
    const workspace = this.config?.dsh?.workspace ?? ''
    const rows = listBindings(workspace)
    return {
      ok: true,
      count: rows.length,
      bindings: rows.map((r) => ({ uuid8: r.uuid8, qqId: r.qqId, name: r.name, at: r.at })),
      // ★★★ 只回**张数**，**绝不回码本身**（码是"资格"：它一旦进了接口响应/日志，
      //   就等于把资格公开了）。要核对的只是"有没有人正卡在取码那一步"。
      codeCount: countCodes(workspace),
    }
  }

  /**
   * **启动时接管/拉起服务端**的测试入口（0.3.2 `servers[].manageOnStart`）。
   *
   * ★ 为什么必须有这个入口：这条链的判据是"端口通不通 + 归属对不对 + 要不要拉起"，
   *   而**最贵的缺陷是"端口活着时还去 launch"**（两个 JVM 同写世界 = 存档损坏，
   *   不可逆）。那条判据**纯函数断言抓不到** —— 它错在"调用顺序与条件"上。
   *   所以这里暴露的是**同一个方法**，测试打桩端口与 launch 就能断言
   *   "端口活着时一次 launch 都没发生"。
   * ★ 它**不是**给产品代码用的（生产路径由 `attach()` 调用）。
   */
  manageServersOnStartForTest() {
    return this.manageServersOnStartInternal()
  }

  /**
   * **本地指令通道**的测试入口（0.3.2 收尾：`\mc [id] <命令>`）。
   *
   * ★ 为什么必须留这个入口：那条通道的**位置**才是关键 —— 它必须在
   *   **语义唤醒闸门之前**且**命中即 return**。放错地方会**静默失效**
   *   （命令白下且不报错），而那种错纯函数断言一条都抓不到。
   * ★ 为什么不直接发一条群消息来测：**群里没 @ 机器人时根本走不到这里**
   *   （`no-trigger`，见 `trigger.mjs`）—— 那是既有设计，不是缺陷。
   *   所以接线测法只能是"直接调这个方法 + 断言它不经模型"。
   * ★ 它**不是**给产品代码用的（生产路径由 `#handleMcLocalCommand` 在 `handleEvent` 里调用）。
   */
  handleMcLocalCommandForTest(o) {
    return this.#handleMcLocalCommand(o)
  }

  /**
   * 拿到某台服务器的归属证据（懒建守护器）。
   *
   * ★★ 这是 `restart.mjs` 允许动手的**唯一依据** —— 它只认
   *   `pid@启动时刻` 对得上的那一种（`supervise.mjs` 的 `ownership()`）。
   */
  async #serverOwnership(server) {
    // ★ 测试注入口优先（它同样返回"归属证据"，判据一点没放宽）
    if (this.#testOwnership) return this.#testOwnership(server)
    if (!this.#supervisor) {
      this.#supervisor = createSupervisor({ workspace: this.config?.dsh?.workspace, log: this.log })
    }
    return this.#supervisor.ownership({
      serverId: server?.id,
      host: server?.host ?? '127.0.0.1',
      port: server?.port ?? 25565,
    })
  }

  /**
   * **尝试一次重启**（0.3.2 P4）—— `down` 事件唯一的处置动作。
   *
   * ★ 三条纪律全在 `restart.mjs` 里（等端口释放 / 冷却 / 归属），这里只负责**接线**：
   *   · `evidence` 来自守护器（**不猜**）；
   *   · `launch` 来自守护器（没配 `startCommand` ⇒ 它自己会拒绝）；
   *   · `stopGracefully` 用**这一轮的 RCON 连接**发一条 `stop`。
   * ★ 失败之后**不在这里继续做任何事**：`restart.mjs` 已经置了 `waitingForAdmin`，
   *   处置权交回给人（"向管理员求助等待指令"）。
   */
  async #tryRestart(server, { event } = {}) {
    const workspace = this.config?.dsh?.workspace
    if (!workspace) return { ok: false, why: '没有工作区' }
    if (!this.#supervisor) {
      this.#supervisor = createSupervisor({ workspace, log: this.log })
    }
    let restarter = this.#restarterFor.get(server.id)
    if (!restarter) {
      restarter = createRestarter({
        workspace,
        serverId: server.id,
        log: this.log,
        // ★ 测试注入口：端口探针（同样只影响"探针"，判据不放宽）
        ...(this.#testPortOpen ? { portOpen: this.#testPortOpen } : {}),
        // ★ 优雅停服：用这一轮采样用的那条 RCON 连接发 `stop`
        stopGracefully: async () => {
          const client = this.#serverLoop?.clientFor?.(server.id)
          if (!client) return { ok: false, why: '没有可用的 RCON 连接（它可能已经崩了）' }
          const r = await client.exec('stop')
          return { ok: Boolean(r?.ok), why: r?.why }
        },
        // ★ 测试注入口优先；否则交由守护器（真起来）
        launch: (s) => (this.#testLaunch ? this.#testLaunch(s) : this.#supervisor.launch(s)),
      })
      restarter.load()
      this.#restarterFor.set(server.id, restarter)
    }

    const evidence = await this.#serverOwnership(server)
    const rules = {
      cooldownMs: Number.isFinite(Number(server.rules?.cooldownMs)) ? Number(server.rules.cooldownMs) : undefined,
      maxAttempts: Number.isFinite(Number(server.rules?.maxAttempts)) ? Number(server.rules.maxAttempts) : 1,
    }
    const out = await restarter.restart({ server, reason: event, evidence, rules, ...(this.#testRestartTiming ? { timing: this.#testRestartTiming } : {}) })
    // ★ 成功之后把监测状态**重置成 up**：否则状态机还停在 down，
    //   下一跳会把"已经好了"的服务器当成持续 down（而重试计数也会继续累加）。
    if (out?.outcome === 'restarted') {
      try {
        this.#serverLoop?.resetMonitor?.(server.id)
      } catch (error) {
        this.log(`⚠️ [restart] ${server.id} 重启成功，但监测状态没重置（下一跳可能仍报 down）：${error?.message ?? error}`)
      }
    }
    return out
  }

  /**
   * 服务器事件 → **要不要自动喊一声**（0.3.2 P2）。
   *
   * ★★ 三条判断，缺任何一条都会出问题：
   *   ① **只有 `announce[事件类型] === 'auto'` 才喊**。默认全 `manual`
   *      —— 一台服务器 down 就自动播报到群里，等于把"服务端的一部分事实"
   *      交给了**任何能让它掉线的人**（重启一下、打崩它，群里就会响）。
   *   ② **事件级去重**（`claimEventFire`）：状态机已经保证"跃迁才产出"，
   *      这里是第二道锁 —— 同一行事件被处理两次（重入、并发回调）也不会说两遍。
   *   ③ **冷却**：`trigger.cooldownMs`（默认 5 分钟）内同一台服务器同一类事件只喊一次
   *      —— 服务端反复崩/起时，"每次都喊"会把群刷成警报器，而**刷屏的告警等于没有告警**。
   *
   * ★ 目标仍要过 `resolveScheduleTarget`（**fail-closed**：不往陌生会话发消息），
   *   与时钟那条路同一套判据 —— 不许因为"这是告警"就绕过它。
   */
  async #onServerEvent(row) {
    if (!row || !row.serverId) return { ok: false, why: '事件不完整' }
    const workspace = this.config?.dsh?.workspace
    if (!workspace) return { ok: false, why: '没有工作区' }

    let listed
    try {
      listed = listTasks({ workspace })
    } catch (error) {
      this.log(`⚠️ [servers] 读任务定义失败（这条事件不播报）：${error?.message ?? error}`)
      return { ok: false, why: '读任务失败' }
    }

    const matched = listed.tasks.filter(
      (t) =>
        t.enabled !== false &&
        t.trigger?.kind === 'server' &&
        t.trigger.serverId === row.serverId &&
        Array.isArray(t.trigger.events) &&
        t.trigger.events.includes(row.event),
    )

    // ── ★★ P4：`down` 事件要不要**尝试一次重启** ───────────────────────────
    //
    // ★ 判据不在这一层：`restart.mjs` 的 `canRestart` 会依次检查
    //   「只有 down 才允许」「归属证据」「次数上限」「在等指令」「冷却」。
    //   这里只负责**把证据准备好**（守护器的 ownership）并把结论播报出去。
    // ★ **没有任务盯着它也要尝试重启** —— "让服务器活过来"与"要不要告诉群里"
    //   是两件事：前者是处置，后者是播报。只有 `announce: auto` 才播报（下面那段）。
    if (row.event === 'down') {
      const server = (Array.isArray(this.config.servers) ? this.config.servers : []).find((s) => s.id === row.serverId)
      if (server && server.enabled !== false) {
        try {
          const out = await this.#tryRestart(server, { event: row.event })
          if (out?.outcome === 'restarted') {
            this.log(`[restart] 「${server.name}」已重启成功`)
            // 重启成功了 ⇒ 把"我准备重启"这件事的下文说清楚（**恰好一次**由冷却与次数保证）
            this.#lastRestartOutcome = { at: Date.now(), serverId: server.id, outcome: out.outcome, text: '' }
          } else if (out?.outcome === 'failed') {
            this.#lastRestartOutcome = { at: Date.now(), serverId: server.id, outcome: out.outcome, text: String(out.text ?? '') }
            this.log(`❌ [restart] 「${server.name}」重启失败：${out.why} —— 等管理员指令`)
          } else if (out?.outcome === 'skipped') {
            this.log(`[restart] 「${server.name}」没有重启：${out.text || out.why}`)
          }
        } catch (error) {
          this.log(`❌ [restart] 「${server.name}」重启编排抛异常（已吞掉，监测照常）：${error?.message ?? error}`)
        }
      }
    }

    if (matched.length === 0) return { ok: true, announced: 0, why: '没有任务盯着这个事件' }

    const seq = this.#serverLoop?.eventSeq?.() ?? 0
    let announced = 0
    for (const task of matched) {
      const mode = task.trigger?.announce?.[row.event] ?? 'manual'
      if (mode !== 'auto') continue

      // ── 冷却（同一任务 + 同一类事件）──
      const cooldownMs = Number.isFinite(Number(task.trigger?.cooldownMs)) ? Number(task.trigger.cooldownMs) : 5 * 60_000
      const last = this.#lastServerAnnounce.get(task.id) ?? 0
      const sinceLast = Date.now() - last
      if (cooldownMs > 0 && last > 0 && sinceLast < cooldownMs) {
        this.log(
          `[servers] 「${task.title}」这次不喊：距上次播报 ${Math.round(sinceLast / 1000)} 秒` +
            `（冷却 ${Math.round(cooldownMs / 60000)} 分钟）—— 刷屏的告警等于没有告警`,
        )
        continue
      }

      const key = `evt:${seq}@${row.serverId}@${row.event}@${row.at}`
      const claim = claimEventFire({ workspace, key, task, detail: `${row.event} ${row.text}`.slice(0, 200) })
      if (!claim.ok) {
        this.log(`❌ [servers] 「${task.title}」认领失败（**这次不喊**，避免重复）：${claim.why}`)
        continue
      }

      const target = this.resolveScheduleTarget({ kind: task.target.kind, peerId: task.target.peerId })
      if (!target.ok) {
        settleFire({ workspace, key, status: 'failed', detail: `目标会话不可用：${target.why ?? ''}` })
        this.log(`❌ [servers] 「${task.title}」没喊成：目标会话不可用（${target.why ?? ''}）`)
        continue
      }

      const r = await this.runEventTurn({ task, row, target })
      if (r.ok && r.text) {
        announced += 1
        this.#lastServerAnnounce.set(task.id, Date.now())
        settleFire({ workspace, key, status: 'delivered', chars: r.text.length })
        noteHistory({ workspace, task, scheduledAt: row.at, text: r.text, via: 'server-event' })
        this.log(`[servers] 「${task.title}」已播报 ${row.event}（${r.text.length} 字）`)
      } else {
        settleFire({ workspace, key, status: 'failed', detail: String(r.why ?? '未知') })
        this.log(`❌ [servers] 「${task.title}」没有产出内容（${r.why ?? '未知'}）—— 不重跑模型`)
      }
    }
    return { ok: true, announced }
  }

  /**
   * 跑一轮**服务器事件**的主动回合。
   *
   * 与 `runProactiveTurn`（时钟）的关系：**共用投递与记账**，差别只在提示词那段
   * 来由（"到点了" vs "出事了"）—— 所以这里不重复实现那一整套，
   * 而是复用同一份 `#recordUsage` / `#deliver` / 会话锁纪律。
   *
   * ★ 与时钟那条同样的三条边界：不参与 `#pending`（否则用户一句话就把告警作废）、
   *   投递前**清掉上一轮留下的截图授权**（陈旧授权 = 提权）、
   *   记账在任何提前 return 之前。
   */
  async runEventTurn({ task, row, target } = {}) {
    const kind = target?.kind
    const peerId = String(target?.peerId ?? '')
    const sessionId = String(target?.sessionId ?? '')
    if (!sessionId || !task || !row) return { ok: false, why: '缺少 sessionId / task / row（内部接线问题）' }
    const chatKey = `${kind}:${peerId}`
    const turnStartedAt = Date.now()

    const collector = this.router.beginTurn(sessionId, {
      label: `${chatKey}（服务器事件）`,
      timeoutMs: this.config.turn?.timeoutMs ?? 10 * 60_000,
    })

    // ★ 陈旧授权 = 提权（与时钟路径同一条理由，见 runProactiveTurn 的注释）
    try {
      const r = clearGrant({ workspace: this.config?.dsh?.workspace, peerKey: chatKey })
      if (!r.ok && r.why !== '缺参数') {
        this.log(`⚠️ [servers] 事件回合前没能清掉截图授权（${r.why}）—— 它会在 10 分钟后自然过期`)
      }
    } catch {
      /* 清不掉不影响这一轮 */
    }

    try {
      const lines = []
      if (this.personaText) lines.push(this.personaText)
      lines.push(
        '',
        renderServerEventBlock({
          task,
          trigger: {
            event: row.event,
            text: row.text || row.detail,
            at: row.at,
            serverId: row.serverId,
            serverName: row.serverName,
            snapshot: row.snapshot,
          },
          now: Date.now(),
        }),
      )
      const blocks = [{ type: 'text', text: lines.filter((x) => String(x).trim() !== '').join('\n') }]
      await this.rpc.prompt(sessionId, blocks)
      const result = await collector.finished()

      try {
        this.#recordUsage({ kind, peerId, result })
      } catch (error) {
        this.log(`⚠️ [servers] 用量记账失败（不影响这条播报）：${error?.message ?? error}`)
      }

      const answer = markdownToPlain(result?.text ?? '')
      if (!String(answer ?? '').trim()) {
        return { ok: false, why: result?.timedOut ? '回合超时' : '模型没有产出内容' }
      }
      const outcome = await this.#deliver(kind, peerId, answer, result, {
        replyTo: null,
        faceId: null,
        sticker: null,
        turnStartedAt,
      })
      if (outcome && outcome.ok === false) return { ok: false, why: `投递失败：${outcome.why ?? '未知原因'}` }
      return { ok: true, text: answer, via: 'server-event' }
    } catch (error) {
      this.log(`❌ [servers] 事件回合失败（「${task?.title ?? '?'}」）：${error?.message ?? error}`)
      return { ok: false, why: `事件回合失败：${error?.message ?? error}` }
    } finally {
      try {
        this.router.clear(sessionId)
      } catch {
        /* 清不掉无所谓 */
      }
    }
  }

  /**
   * 定时任务的**目标解析**：由桥接决定"这个会话的 sessionId 是谁、以什么权限跑"。
   *
   * ★ 为什么必须由桥接做：会话键 → sessionId 的映射（`makeSessionId`）只有这里知道，
   *   而它依赖构造期固定的 `session.instance` —— 定时任务那边**不许**自己算
   *   （`session-id.mjs` 顶部记着"每次调用都换 instance ⇒ 每条消息都失忆"那个坑）。
   *
   * ★★ **fail-closed（与 §4 的"号码不猜"同一条纪律）**：目标会话必须在
   *   **会话镜像里出现过**。一个从没来消息的号码被写进任务时，正确行为是
   *   **拒绝执行并如实说明**，而不是往一个陌生号码发消息 —— 那可能是打错的一位数字。
   *
   * @param {{kind: string, peerId: string}} opts
   * @returns {{ok: boolean, sessionId?: string, chatKey?: string, tier?: string, reason?: string, why?: string}}
   */
  resolveScheduleTarget({ kind, peerId } = {}) {
    const k = kind === 'group' ? 'group' : kind === 'private' ? 'private' : null
    const id = String(peerId ?? '').trim()
    if (!k || !id) return { ok: false, why: 'target 必须是 {kind: group|private, peerId: "号码"}' }
    const chatKey = `${k}:${id}`

    // ── fail-closed：这个会话**来过消息**吗（§4 的"号码不猜"）──────────────
    //
    // ★ 判据是**落盘的**已知会话名单，不是内存里的会话镜像：
    //   晚上重启过桥接、早上 8 点要发到某个群、而那个群今天还没人说话 ——
    //   用内存判据会把这条提醒判成"陌生号码"而拒发（使用者看到的就是"8 点它没响"）。
    let known = false
    try {
      const r = readKnownChats({ workspace: this.config?.dsh?.workspace })
      if (!r.ok) this.log(`⚠️ [schedule] 读已知会话名单失败（这次按"未知"处理）：${r.why}`)
      known = r.chats.includes(chatKey)
    } catch (error) {
      this.log(`⚠️ [schedule] 读已知会话名单抛异常（这次按"未知"处理）：${error?.message ?? error}`)
    }
    if (!known) {
      return {
        ok: false,
        why:
          `${chatKey} **从没有来过消息**（已知会话名单里没有它）。` +
          '照 §4 的纪律不往陌生号码发消息（可能是打错的一位数字）；' +
          '先在那个会话里说过话，或者把目标改成来过的会话。',
      }
    }

    let sessionId
    try {
      sessionId = makeSessionId(k, id, {
        salt: this.config.session?.salt,
        // ★ 必须用**构造期固定的那个**（与 `#runTurn` 同一行口径）
        instance: this.sessionInstance ?? this.config.session?.instance,
      })
    } catch (error) {
      return { ok: false, why: `算 sessionId 失败：${error?.message ?? error}` }
    }

    // 权限：与 `roster.decide` 同一口径（定时任务不该绕过任何名单）
    let tier = 'user'
    let respond = true
    let reason = ''
    try {
      const v = this.roster.decide({ kind: k, peerId: id, senderId: id })
      tier = v?.tier ?? 'user'
      respond = v?.respond !== false
      reason = v?.reason ?? ''
    } catch (error) {
      return { ok: false, why: `权限判定失败：${error?.message ?? error}` }
    }
    if (!respond) {
      return { ok: false, why: `这个会话现在不接收消息（名单判定=${reason || '拒绝'}）—— 定时任务不绕过名单` }
    }
    return { ok: true, sessionId, chatKey, tier, reason }
  }

  /**
   * 跑一轮**主动回合**：不是"有人说话"，是"到点了"。
   *
   * 与 `#runTurn` 的关系（这条边界是刻意划的，改之前先读）：
   *   · **共用**：`#recordUsage`（钱花了就要记账）、`#deliver`（分条/账本/拟人延迟/限流/
   *     终检门/隐私闸）、`router.beginTurn`（会话路由）。
   *   · **不共用**：唤醒判定、准入（已由 `resolveScheduleTarget` 判过）、
   *     `#runTurn` 的**「被更新的消息作废」那一套**（`#pending`）—— 主动回合**不进
   *     `#pending`**，否则使用者在这条提醒之后 1 秒说句话，就会把这次定时任务
   *     当成"同一发言人连发"作废掉 ⇒ 表现成"8 点的提醒偶尔不说"（`docs/0.3.2-task-manager-plan.md` §11）。
   *   · **不共用**：记忆结算（`#settleMemory`）—— 那一轮没有"用户那句话"，
   *     把主动说出的话记进别人的档案不是使用者要的。
   *
   * @param {{task: object, scheduledAt: number, lateByMs: number, target: object}} opts
   * @returns {Promise<{ok: boolean, text?: string, via?: string, why?: string}>}
   */
  async runProactiveTurn({ task, scheduledAt, lateByMs = 0, target } = {}) {
    const kind = target?.kind
    const peerId = String(target?.peerId ?? '')
    const sessionId = String(target?.sessionId ?? '')
    if (!sessionId || !task) return { ok: false, why: '缺少 sessionId 或 task（内部接线问题）' }
    const chatKey = `${kind}:${peerId}`
    const turnStartedAt = Date.now()

    const collector = this.router.beginTurn(sessionId, {
      label: `${chatKey}（定时任务）`,
      timeoutMs: this.config.turn?.timeoutMs ?? 10 * 60_000,
    })

    // ── ★★ 收掉"上一轮留下的授权"：主动回合**不许继承**任何截图权限 ──────
    //
    // 为什么必须显式收（这是一处真缺陷，被 `verify-screenshot.mjs` 的源序断言连带抓出来的）：
    //   截图那道闸的判据是**按会话写下的授权文件**（里面是"这一轮说话人是不是管理员"，
    //   10 分钟有效）。而主动回合**没有"这一轮说话人"** —— 它是时钟发起的。
    //   若不收，那个会话里**上一轮**留下的管理员授权仍然有效 ⇒ 一次定时任务
    //   可以带着"十分钟前某位管理员说过话"的凭证去截屏。**陈旧授权 = 提权**。
    //   ∴ fail-closed：先清掉，主动回合里模型拿不到截屏权限（要截屏得先有人说话）。
    try {
      const r = clearGrant({ workspace: this.config?.dsh?.workspace, peerKey: chatKey })
      if (!r.ok && r.why !== '缺参数') {
        this.log(`⚠️ [schedule] 主动回合前没能清掉截图授权（${r.why}）—— 它会在 10 分钟后自然过期`)
      }
    } catch (error) {
      this.log(`⚠️ [schedule] 清截图授权时抛异常（忽略，它会在 10 分钟后自然过期）：${error?.message ?? error}`)
    }

    try {
      // ── 提示词：**复用同一份人设与平台规则**，只把"这一轮的来由"换掉 ──
      //   为什么另起一段而不是拿 `buildChannelPrompt` 硬塞：那一段的核心假设是
      //   "origin 那条消息是对方刚说的"，而这里根本没有那条消息。硬塞会让模型
      //   以为对方刚提了这件事（于是回一句"好的我记下了"）。
      const lines = [this.personaText ? this.personaText : '']
      lines.push('', renderScheduleTaskBlock({ task, scheduledAt, now: Date.now() }))
      const lines2 = lines.filter((x) => String(x).trim() !== '')

      const blocks = [{ type: 'text', text: lines2.join('\n') }]
      await this.rpc.prompt(sessionId, blocks)
      const result = await collector.finished()

      // ★ 记账**必须在任何提前 return 之前**：超时/空回复也真的烧了 token
      try {
        this.#recordUsage({ kind, peerId, result })
      } catch (error) {
        this.log(`⚠️ [schedule] 用量记账失败（不影响这条提醒）：${error?.message ?? error}`)
      }

      let answer = markdownToPlain(result?.text ?? '')
      if (!String(answer ?? '').trim()) {
        return { ok: false, why: result?.timedOut ? '回合超时' : '模型没有产出内容' }
      }

      // ── 投递：与普通回复**同一条管线**（三道闸一个都不绕过）──
      const delivering = this.#deliver(kind, peerId, answer, result, {
        replyTo: null,
        faceId: null,
        sticker: null,
        turnStartedAt,
      })
      const outcome = await delivering
      if (outcome && outcome.ok === false) {
        return { ok: false, why: `投递失败：${outcome.why ?? '未知原因'}` }
      }
      return { ok: true, text: answer, via: 'model' }
    } catch (error) {
      this.log(`❌ [schedule] 主动回合失败（「${task?.title ?? '?'}」）：${error?.message ?? error}`)
      return { ok: false, why: `主动回合失败：${error?.message ?? error}` }
    } finally {
      try {
        this.router.clear(sessionId)
      } catch {
        /* 清不掉无所谓，收尾时还会清一遍 */
      }
    }
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

    // ── ③-0 绑定指令通道：`\mc bind` / `\mc bind <码>` / `\mc unbind <目标>`（0.3.2 P3）────
    //
    // ★★★ 位置是**刻意的，而且与 `/mc` 那条**不一样**（设计文档 §5.2 写明）：
    //   · 必须在**唤醒判定之前**：玩家在群里发 `/绑定` 是**不会 @ 机器人**的
    //     （谁会在粘贴一个 6 位码的时候去 @ 它），而 `decideTrigger` 对"没 @ 也没
    //     命中关键词"的群消息**直接 return** ⇒ 放在它后面等于**这条通道根本不存在**，
    //     而且一声不响（最坏的一种失效）；
    //   · 在**语义唤醒闸门之前**：闸门可能判"沉默"，于是"玩家来绑定却被判沉默，码白发了"；
    //   · 在**群白名单之后**：判定在 `#handleBindLocalCommand` 里面（复用
    //     `roster.isGroupAllowed`，**不新造名单**），所以这里先做一次纯同步形状判定。
    // ★ 形状判据是**纯同步**的：普通消息不产生额外 `await`
    //   （理由同 `looksLikeMcCommand`，见它的注释）。
    // ★ 命中即 `return`：这一轮**一次模型调用都不产生**。
    // ★★ 它还刻意排在**身份核实 / 记镜像 / 记语料库之前** —— 那三件事都会把
    //   **消息原文**留在盘上或界面上，而绑定码的纪律是"用过即作废、别到处留"。
    //   排在它们之后不会报错，只会让那张码多躺在两个不必要的文件里。
    if (looksLikeBindCommand(rendered.text)) {
      try {
        const local = await this.#handleBindLocalCommand({
          text: rendered.text,
          kind,
          peerId,
          senderId,
        })
        if (local.matched) {
          return { handled: true, reason: 'bind-command', peerId, senderId }
        }
      } catch (error) {
        // 绑定通道炸了**不该**让这条消息消失 —— 留痕后继续走普通聊天
        this.log(`❌ [bind] 绑定指令通道抛异常（这条按普通聊天处理）：${error?.message ?? error}`)
      }
    }

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

    // （绑定指令通道见上面「③-0」—— 它刻意排在**记镜像/记语料库之前**）

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
      // ★★ 未唤醒**不等于**与它无关：有人可能在对着它倾诉、只是没叫它。
      //   这里给那条路留一个出口（默认 `off` ⇒ 一次模型调用都不发；见 `#maybePrewakeAffect`）。
      //   ⚠️ 位置在这里（而不是更早）是**故意的**：它是唯一不会与 `#settleMemory` 重复记账的地方
      //     —— 被唤醒的那条走 `#runTurn` → `#settleMemory`，那条路本来就会记。
      try {
        await this.#maybePrewakeAffect({
          kind,
          peerId,
          senderId,
          senderName: identity?.ok ? identity.name : null,
          chatKey: mirrorKey,
          messageId: payload.message_id,
          text: rendered.text,
          // ★ 群名（协议端核实过）：只用于"新建那份群记忆时把头写成群名"
          chatName: identity?.chatName ?? '',
        })
      } catch (error) {
        // 增强路径：**任何**失败都不许影响消息处理（这里连日志都要给全）
        this.#warnInjectOnce('情绪闸门', error)
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

    // ── 记下"这个会话来过消息"（定时任务的目标判定要它，**必须落盘**）──────
    //
    // ★ 位置：**准入通过之后** —— 名单外的人不该让任何会话被记成"已知"。
    // ★ 幂等且只在**第一次**写盘（`noteKnownChat` 判过已存在就返回），
    //   所以它不是"每条消息一次 IO"。
    // ★ 失败只喊一行（增强路径），绝不影响这一轮 —— 但它必须留痕：
    //   写不上会让**下次重启后**的定时任务被误判成"陌生号码"而拒发。
    try {
      if (this.config?.dsh?.workspace) {
        // ⚠️ 这里**不能**用 `chatKey` —— 那是 `#runTurn` 里的局部变量（本项目栽过
        //    同一个名字的坑：任务段的 `chatKey` 在错的作用域里，那个段在真机上
        //    从未注入过）。本函数里只有 `kind` 与 `peerId`，会话键得自己拼。
        const r = noteKnownChat({ workspace: this.config.dsh.workspace, chatKey: `${kind}:${peerId}` })
        if (!r.ok) this.log(`⚠️ [schedule] 已知会话名单没记上（定时任务在下次重启后可能误判陌生号码）：${r.why}`)
      }
    } catch (error) {
      this.log(`⚠️ [schedule] 已知会话名单记不上（异常，忽略）：${error?.message ?? error}`)
    }

    // ── 个人层的行为统计（0.2.9 决定：纳入）──────────────────────────────
    //
    // ★ **位置是刻意的**，它定义了"常来"是什么意思：
    //   · 在**准入判定之后** ⇒ 名单外的人不计数（不给陌生人建档，也不给误报攒数据）；
    //   · 在**语义唤醒闸门之前** ⇒ 被判成"沉默"的那些**也算**（他确实是在跟机器人说话）
    //     而"群里没 @ 机器人"的消息根本走不到这里（桥接没读，见 G6 的实测数字）。
    //   所以它量的是**关系**（他多常来找我），不是群活跃度 —— 这句话写在
    //   `people-stats.mjs` 的文件头，改口径要连着那里一起改。
    // ★ 失败只记一行日志（增强路径），绝不影响这一轮。
    try {
      const workspace = this.config?.dsh?.workspace
      if (workspace && this.config.memory?.enabled !== false && senderId) {
        // ★ 只传 `userId` 做**聚合键**（跨会话按人）；`chatKey` 只作为分会话明细记下来。
        //   为什么：个人层是"跟人走"的，统计也必须是 —— 否则私聊里读不到他在群里的那份。
        notePersonTurn({
          workspace,
          userId: senderId,
          chatKey: mirrorKey,
          // ★★ 2026-10-01：多带两个**确定性**事实，用来算"稳定行为特征"
          //   （"只在被叫到时才出现" / "话很短"）——
          //   `mentioned` 只传布尔，`textLength` 只传长度：**都不含内容**
          //   （本模块的隐私边界：只记数字）。
          mentioned: rendered.mentioned === true,
          textLength: String(rendered.text ?? '').length,
          log: (m) => this.log(m),
        })
      }
    } catch (error) {
      this.log(`⚠️ [people-stats] 统计没记上（聊天不受影响）：${error?.message ?? error}`)
    }

    // ── ③-b 本地指令通道：`\mc [id] <命令>`（0.3.2 收尾）──────────────────
    //
    // ★★★ 位置是**刻意的**（设计文档 §11「本地指令通道」那一条）：
    //   · 在**语义唤醒闸门之前** ⇒ 否则 `semantic` 模式下"来下指令"可能被判成
    //     "该沉默"，于是**命令白下**（而且完全不报错，最难查的一类失效）；
    //   · 命中即 **return** ⇒ 这一轮**一次模型调用都不产生**（省钱、也不给模型
    //     任何"看到这条消息"的机会）。
    // ★ 非管理员发这个形状时 `#handleMcLocalCommand` 返回 `matched:false`
    //   ⇒ **照常走普通聊天**（不解释、不拒绝 —— 拒绝等于告诉所有人这里有后门）。
    // ★★ 形状判据做成**纯同步**的：普通聊天消息**完全不产生额外的 `await`**。
    //   为什么这条不是微优化 —— 实测：把它写成无条件 `await` 会扰动"主动回合 vs
    //   随后到达的用户消息"那条竞争，使 `verify-schedule` 出现
    //   `unsettled top-level await`（退出码 13），**极难定位**（花了很多轮才发现）。
    //   同步判据把"不影响原有时序"这件事变成结构上的保证，而不是靠运气。
    if (looksLikeMcCommand(rendered.text)) {
      try {
        const local = await this.#handleMcLocalCommand({
          text: rendered.text,
          kind,
          peerId,
          senderId,
          tier: verdict.tier,
        })
        if (local.matched) {
          return { handled: true, reason: 'local-command', peerId, senderId }
        }
      } catch (error) {
        // 本地指令炸了**不该**让这条消息消失 —— 留痕后继续走普通聊天
        this.log(`❌ [servers] 本地指令通道抛异常（这条按普通聊天处理）：${error?.message ?? error}`)
      }
    }

    // ④ 唤醒闸门（0.2.3，**实验性**：`wake.policy = 'semantic'`）
    // ══════════════════════════════════════════════════════════════════════
    // 它是什么：规则说"回"之后，再问一次**判定器**"这条该不该沉默"。
    // 它**只做减法** —— 规则说"不回"的消息根本走不到这里（上面就 return 了），
    // 所以判定器没有任何办法让机器人多说一句话。这条边界是本设计成立的前提：
    // 一旦"判定器可以主动发起回复"，就需要 hermes 那一整套状态机
    // （对话态窗口 / epoch / 退出闸门 / episode），成本从 ~200 行抬到 ~1000+ 行。
    //
    // ══════════════════════════════════════════════════════════════════════
    // 为什么插在**这里**（三条理由，第三条是决定性的）
    // ══════════════════════════════════════════════════════════════════════
    //   ① 必须在 roster 准入**之后**：否则任何一个陌生人（没进名单的）
    //      都能让桥接不停起判定子进程 —— 等于一个免费的拒绝服务面；
    //   ② 必须在 `#withLock(chatKey)` **之外**（那把锁在 `#runTurn` 里）：
    //      判定是一次 0~6 秒的网络调用，放进锁里会让同一会话的请求队头阻塞；
    //   ③ ★ 必须在 `#runTurn` **之前**：DSH 的 SDK 只暴露 initialize /
    //      session/prompt / shutdown，**没有 cancel/abort/steer**，所以进了
    //      `#runTurn` 的那一轮**注定把 token 烧完**。∴ 只有否决发生在这里，
    //      "沉默"才真的省钱 —— 放在投递层过滤只能省一条消息，省不掉那一轮。
    //
    // ★ `wake.policy` 是**每轮现读**的（活配置对象会被 /api/extensions 就地改），
    //   所以这个开关是 hot 的。见 `src/plugins.mjs` 里 wake-policy 的 `why`。
    if (this.config.wake?.policy === 'semantic') {
      const gate = await this.#wakeGate({
        kind,
        peerId,
        senderId,
        chatKey: mirrorKey,
        rendered,
        decision,
        identity,
      })
      if (!gate.pass) {
        this.stats.skipped += 1
        return { handled: false, reason: gate.reason, peerId, senderId }
      }
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

  /**
   * 取（必要时建）唤醒判定器。**不抛错**：建不起来就返回 null，
   * 调用方按"放过"处理 —— 判定器是增强路径，它坏了不能让机器人哑掉。
   */
  #ensureWakeJudge() {
    if (this.wakeJudgeInjected) return this.wakeJudgeInjected
    if (this.#wakeJudge) return this.#wakeJudge
    const cliPath = this.config.dsh?.cliPath
    const cwd = this.config.dsh?.workspace
    const j = this.config.wake?.judge ?? {}

    // ── 通路：**由"有没有判定专用 key"推导**，不让使用者选（0.2.3 用户决定）──
    //
    //   · `wake.judge.apiKey` 留空 ⇒ **一次性 DSH 进程**（约 3~5 秒，用主对话那套凭据）
    //   · 填了 ⇒ **直连**一次 `/chat/completions`（约 1 秒），**只用那把 key**
    //
    // ★ 为什么不做成一个开关：两条路在唤醒流程里做的是**同一件事**（让一个模型判断
    //   "这句话是不是说给我听的"），让使用者选一个自己无法判断好坏的东西没有意义；
    //   而"要不要单独配一把 key"本身就是那个选择的**可观察依据**。
    // ★ 这条推导必须与 `config.mjs` 的 `validateConfig` 告警、
    //   `model-direct.mjs` 的 `resolveDirectTarget`、以及界面的渲染条件**完全一致** ——
    //   否则界面说的和实际跑的不是一条路，那正是本项目最忌讳的"说了做不到"。
    const judgeKey = String(j.apiKey ?? '').trim()
    // ★ 推导只有一处实现（`wake-judge.mjs` 的 `judgeTransport`），这里与界面都调它 ——
    //   否则"界面说走直连、实际走 DSH"这种静默不一致迟早会发生。
    const transport = judgeTransport(j)
    const direct = judgeKey ? resolveDirectTarget({ config: this.config }) : null

    // 通路配不全时**仍然建**判定器：`judge()` 会立刻按"放过"返回并留下一行日志。
    // 为什么不在这里直接不建：那会让"配错了"表现成"判定器根本没启动"，
    // 而配置校验层已经会把这条明确报出来（见 validateConfig 的 wake 一节）。
    try {
      this.#wakeJudge = createWakeJudge({
        transport,
        cliPath,
        cwd,
        baseUrl: direct?.baseUrl ?? j.baseUrl,
        apiKey: direct?.apiKey ?? '',
        model: direct?.model ?? '',
        timeoutMs: j.timeoutMs,
        maxPerHour: j.maxPerHour,
        log: (m) => this.log(m),
      })
      this.log(
        `[wake] 判定器已就绪：policy=semantic · shadow=${j.shadow === true ? '开（只记账，不改行为）' : '**关**（判定已生效）'}` +
          ` · 通路=${transport}` +
          (transport === 'http'
            ? `（配了 wake.judge.apiKey ⇒ 直连 ${direct?.ok ? direct.baseUrl : '**端点不合法**'}` +
              ` · 模型 ${direct?.model ?? '?'} · **只用这把 key**）`
            : '（没配 wake.judge.apiKey ⇒ 用一次性 DSH 进程；填一把专用 key 就会自动改走直连）') +
          ` · timeout=${j.timeoutMs}ms · 上限 ${j.maxPerHour} 次/小时`,
      )
      if (transport === 'http' && direct && !direct.ok) {
        this.log(`[wake] ⚠️ 直连通路不可用（每一轮都会按放过处理）：${direct.why}`)
      }
    } catch (error) {
      this.log(`❌ [wake] 判定器建不起来（这一层停用，按规则结论放过）：${error?.message ?? error}`)
      return null
    }
    return this.#wakeJudge
  }

  /**
   * 把"这份人设长什么样"记一行（**只在形状变化时记**，不每轮刷屏）。
   *
   * ── 为什么非要有这一行 ────────────────────────────────────────────────
   * 说话方式现在**就在人设文件里**（0.3.0alpha 第二步），所以这一层不再拼任何东西 ——
   * 但"这份人设里到底有没有说话方式那一节"仍然是个**只有日志能回答**的问题：
   *   · 换成自己写的散文 ⇒ 说话方式那两节（或替换后的那一节）根本不存在，
   *     提示词里就只剩那段散文；**这属于配置问题，不是故障**，所以不拦、也不回落内置；
   *   · 而且它在**提示词里看不出来**（散文人设和多节人设，最终都是"一段人设文本"）。
   * ∴ 记一行：认得出就报"有说话方式这一节（第 N 节）"，认不出就 ⚠️ 并**给出怎么改**
   *   （把口吻那节命名为「【说话方式…】」或「【怎么说话】」或编号式「二、怎么说话」）。
   */
  #notePersonaShape(personaText) {
    const { voice, sections } = personaVoiceSections(personaText)
    const sig = voice ? `has:${voice.title}` : `none:${sections.length}`
    if (sig === this.#personaShapeLogged) return
    this.#personaShapeLogged = sig
    if (voice) {
      this.log(`[persona] 说话方式：人设里有「${voice.title}」这一节（共 ${sections.length} 节），提示词直接用整份人设`)
    } else {
      this.log(
        '⚠️ [persona] 这套人设里**没有**可识别的「说话方式」那一节 —— ' +
          '提示词里就只有你写的正文（不再有内置口吻兜底）。' +
          '要让它回到出厂那份，就把口吻那节命名为「【说话方式…】」或「【怎么说话】」或「二、怎么说话」。',
      )
    }
  }

  /**
   * 判定器的上下文：**从已有的会话镜像里投影一份**，零新增状态。
   *
   * ★ 为什么是"投影"而不是把镜像数组直接递进去：镜像的用途是**给界面看**
   *   （`listConversations` 会原样吐给 UI），它哪天因为界面需求变了形状，
   *   判定器的输入就会跟着变 —— 那是一种很隐蔽的耦合。
   * ★ 镜像里 `role` 只有三档（user / bot / notice），且**在判定之前就已经写好**
   *   （`#mirror` 在 `decideTrigger` 之前调用），所以判定器天然看得到"刚刚发生了什么"。
   * ★ 只在内存里、重启即空，且空着也必须正确 —— 满足"状态可随时丢弃"这条纪律。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * ★★ 0.2.3 修正：**必须按 role 过滤，不能只投影字段**
   * ══════════════════════════════════════════════════════════════════════════
   * 镜像里其实有**四**种 role，不是三种 —— `#mirrorThinking` 往**同一个 `messages` 数组**
   * 里推 `role: 'thinking'`（那是**模型的内部推理**，存在镜像里的唯一目的是
   * "只给界面看"），还有 `role: 'notice'`（桥接自己发出去的提示，如"先应一声"）。
   *
   * 第一版只投影了字段、没有过滤 role，后果是两个都真的会发生：
   *   ① **判定器会把模型的内部推理当成"群里某人说的话"** —— 那段推理里经常直接写着
   *      "这轮不需要插嘴""群里在闲聊"之类的判断，喂回去等于**让它自己给自己投票**，
   *      而且是**贴着一个错的身份**（见 ②）；
   *   ② `buildJudgePrompt` 只认 `role === 'bot'`，其余一律标成「某人」⇒
   *      内部推理与系统提示都会被当成**群成员的发言**。
   *   ③ 顺带一个泄漏面：那段推理**只该给界面看**（项目里对它的原话是"绝不发到 QQ"），
   *      而判定提示词是**发出去**的（0.2.3 起还是直连 HTTP）。
   *
   * ∴ 这里只放**真正在会话里发生过的一来一回**：`user` 与 `bot`。白名单，不是黑名单 ——
   * 以后镜像再长出别的 role（比如工具结果），默认**不会**被喂给判定器。
   */
  #wakeContext(chatKey) {
    const msgs = this.#conversations.get(chatKey)?.messages ?? []
    const ROLES = new Set(['user', 'bot'])
    return msgs
      .filter((m) => ROLES.has(m.role))
      .slice(-WAKE_JUDGE_DEFAULTS.contextMessages)
      .map((m) => ({
        role: m.role,
        text: m.text,
        senderName: m.senderName ?? '',
      }))
  }

  /**
   * 唤醒闸门：规则已经说"回"，再问判定器"该不该沉默"。
   *
   * @returns {Promise<{pass: boolean, reason?: string, verdict?: string}>}
   *   `pass:false` 表示**不要回**：`reason` 直接进日志与返回值，接口上要说得清。
   */
  async #wakeGate({ kind, peerId, senderId, chatKey, rendered, decision, identity }) {
    const j = this.config.wake?.judge ?? {}
    const shadow = j.shadow !== false

    // ── ① 必答的直接放行（零延迟）────────────────────────────────────────
    // 私聊 = 一对一找它说话；被 @ = 明确点名。这两类让判定器去审
    // 既浪费额度，又会让"被 @ 时它 3 秒后才动"这种劣化落到用户身上。
    if (kind === 'private' || rendered.mentioned === true || decision?.reason === REASON.MENTION) {
      return { pass: true, verdict: 'bypass' }
    }

    // ── ② 重复内容在闸门**之前**短路 ──────────────────────────────────────
    // `#runTurn` 里本来就有这个判定，但它在闸门**之后** —— 不在这里短路的话，
    // 一条重复消息会先白烧一次判定，然后才被判成 duplicate。
    // ⚠️ 条件与 `#runTurn` 里那段**逐字对齐**（都是"先有在飞的那条，再比内容"），
    //    否则同一条消息会在两处得到不同结论。
    const normalized = String(rendered.text ?? '').trim()
    const prior = this.#pending.get(chatKey) ?? null
    // ★★ 2026-10-02：**重复内容必须是同一个人发的**才算重复（原来只比内容）。
    //    理由与 `#runTurn` 里那段同源（群里两个人碰巧说同一句话时，后说的那个也该拿到回答，
    //    按内容跳过他就等于"没回答"）。条件必须与那段**逐字对齐**，否则同一条消息
    //    会在两处得到不同结论 —— 这正是上面那条注释在防的事。
    const sameSpeaker = Boolean(prior) && prior.senderId === senderId
    if (prior && sameSpeaker && (prior.text === normalized || this.#lastDelivered.get(chatKey) === normalized)) {
      this.log(`[wake] 重复内容：在判定之前就短路（${chatKey}｜同一个人又发了同一条）`)
      return { pass: false, reason: 'duplicate' }
    }

    const judge = this.#ensureWakeJudge()
    // 没有 cliPath / judge 建不起来 ⇒ 退回规则结论（也就是放过）
    if (!judge) return { pass: true, verdict: 'fallback' }

    // ── ③ 取消上一次同会话的判定（它在回答一个已经过期的问题）────────────
    this.#wakeAborts.get(chatKey)?.abort()
    const ac = new AbortController()
    this.#wakeAborts.set(chatKey, ac)
    const releaseAc = () => {
      if (this.#wakeAborts.get(chatKey) === ac) this.#wakeAborts.delete(chatKey)
    }

    let r
    try {
      r = await judge.judge(
        {
          kind,
          senderId,
          senderName: identity?.ok ? identity.name : '',
          text: rendered.text,
          hitAt: rendered.mentioned === true,
          // ★★ 0.2.3：把"机器人是谁"与"这条 @ 的是谁"一起给它。
          //   不给这两样，它只能看见文本里有个 `@`，于是把 `@张三` 读成"@ 了机器人"
          //   （真机上误判过一次，日志里留着原话）。`ats` 由 `renderSegments` 结构化带出。
          selfId: String(this.onebot?.selfId ?? ''),
          ats: rendered.ats ?? [],
          recent: this.#wakeContext(chatKey),
          selfNames: this.wakeKeywords ?? this.config.trigger?.keywords ?? [],
        },
        { signal: ac.signal },
      )
    } finally {
      releaseAc()
    }

    // ── ④ 记账（影子模式下这就是**全部**的效果）──────────────────────────
    if (r.judged) {
      this.stats.wakeJudged += 1
      if (r.verdict === WAKE_VERDICT.SILENT) this.stats.wakeSilenced += 1
    }
    const tail = r.judged ? `${r.verdict}（${r.reason || '未给理由'}）${r.ms}ms` : `未判定（${r.why ?? '未知原因'}）`
    const mark = shadow && r.verdict === WAKE_VERDICT.SILENT ? '影子：本会拦下' : ''
    this.log(
      `[wake] 群 ${peerId} 判定=${tail}${mark ? ` ★${mark}` : ''}` +
        `${r.fallback ? '（判定失败，已按规则结论放过）' : ''}`,
    )
    // 影子模式：**只记账、不改行为**。
    // ★ 为什么影子模式值得单独一条 oplog：它回答的是"判定器到底想拦什么"。
    //   没有它，用户开了 semantic 就只能凭"回复变少了"这种模糊感受去判断 ——
    //   而那正是这块功能最容易被误判成"机器人坏了"的地方。
    // ★ `excerpt` 是 oplog **唯一会被 privacy.mjs 自动筛**的字段（oplog.mjs:83），
    //   所以原消息只放这里，别的字段只放数字与结论。
    // ★★ 0.2.3 修一处**静默失败**：`appendOp` **从不抛异常**，它靠**返回值**报错
    //   （`{ok:false, why}`）—— 而第一版这里只包了 try/catch，等于把失败全吞了：
    //   磁盘满、`runtime/` 被占成文件、或**当天那个文件已达 2MB 上限**时，
    //   判定流水会**一声不响地停止写入**。那正好毁掉影子模式的全部价值
    //   （它的存在意义就是"留下可审的记录"，而记录断了没人知道）。
    //   ∴ 失败必须留一行日志。这条与整份 oplog 的"绝不抛"纪律不冲突：
    //   **不影响聊天，但要让人看得见**。
    try {
      const opResult = appendOp({
        workspace: this.config.dsh?.workspace,
        chatKey,
        op: {
          // ★★ 0.2.3 更正：字段名是 **`type`**，不是 `kind`。
          //   oplog 的既有约定全用 `type`（`session-bridge.mjs` 的 TurnCollector：
          //   assistant / tool/call / tool/result / approval / approval/decided / turn/end），
          //   而读取侧（`index.mjs` 的 `--ops`）也是按 `r.type` 分支渲染的。
          //   我第一版照设计文档 §10.4 写成了 `kind` —— 后果是**写进去了、读出来是
          //   `undefined`**：`--ops` 会打出一行 `t?s?   undefined`。这正是本项目最忌讳的
          //   那类静默不一致（"记录有了，但读的人看不见"），所以字段名以读取方为准。
          type: 'wake',
          policy: 'semantic',
          verdict: r.verdict,
          shadow,
          fallback: Boolean(r.fallback),
          judged: Boolean(r.judged),
          // ★ `via`：结论是从哪种形状里解析出来的（json / loose / scan / phrase）。
          //   不是 `json` 就说明**模型没照提示词的格式写** —— 那是这个问题唯一的观测点，
          //   放进 oplog 才能在事后回答"提示词到底被遵守了没有"。
          via: r.via ?? null,
          ms: r.ms,
          // ★ token 用量进 oplog 行 —— 报表靠它回答"这一段时间的判定花了多少"。
          //   走一次性 DSH 进程那条路拿不到 ⇒ null，报表会如实标出"成本偏低"。
          tokens: r.tokens ?? null,
          reason: r.reason || r.why || '',
          excerpt: String(rendered.text ?? '').slice(0, 80),
        },
      })
      if (!opResult?.ok) {
        this.log(`[wake] ⚠️ 判定流水没写进 oplog（这一条查不到了）：${opResult?.why ?? '未知原因'}`)
      }
    } catch (error) {
      // 防御：`appendOp` 承诺不抛，但它内部还有 import 级的隐私模块调用，兜一层
      this.log(`[wake] ⚠️ 判定流水写入异常（已忽略，不影响这一条消息）：${error?.message ?? error}`)
    }

    // ── ⑤ 结论 ───────────────────────────────────────────────────────────
    // fail-open 就落在这一行：只有"真的判完了、而且明确说沉默"才拦。
    // 超时 / 抛错 / 认不出输出 / 超预算 / 被取消 —— 全部 `judged:false`
    // 或 `fallback:true`，一律放过。
    if (r.verdict === WAKE_VERDICT.SILENT && r.judged && !shadow) {
      return { pass: false, reason: 'wake-silent', verdict: r.verdict }
    }
    return { pass: true, verdict: r.verdict }
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
        // ★★ 显式给的名字**优先于**身份核实的结果（2026-10-04 加）：
        //    游戏内那条通道的说话人是**游戏里的玩家名**，而它**没有**协议端身份
        //    （那个名字来自服务端日志，不是 QQ 昵称）。没有这一条的话，
        //    「游戏内对话」窗口里所有发言都只剩一个 QQ 号，看不出是谁说的。
        if (who.senderName) entry.senderName = String(who.senderName)
        if (who.senderRole) entry.senderRole = String(who.senderRole)
        if (!conv.senders) conv.senders = {}
        // 谁说的这句话：界面按人显示。身份核实失败时只留号码，**不编名字**。
        conv.senders[entry.senderId] = {
          name: entry.senderName ?? '',
          roleLabel: entry.senderRole ?? '',
          verified: Boolean(id?.ok) || Boolean(who.senderName),
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
      // ★★ 显式给的会话名（2026-10-04 加）：游戏内那条通道的名字来自**我们自己的
      //    配置**（「游戏内对话 · 主服（Forge 1.20.1）」），那是**确定的**，
      //    所以 `nameVerified: true` —— 它不是"猜的"，只是来源不是协议端。
      if (who.chatName) {
        conv.name = String(who.chatName)
        conv.nameVerified = true
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

  async #runTurn({ kind, peerId, senderId, tier, rendered, reason, identity = null, imageRefs = [], messageId = null, seq = 0, deliverTo = null, channelOrigin = '', displayKey = null, display = null }) {
    const chatKey = `${kind}:${peerId}`
    // ★★★ 会话键（`chatKey`）与**展示键**（`dKey`）是两件事（2026-10-04 加）：
    //   · `chatKey` 决定**会话/记忆/串行锁/去重** —— 游戏内那条通道刻意复用它绑定的
    //     那个 QQ 的私聊键，让"同一个人在游戏里说的话"与"他在 QQ 里说的话"
    //     落进**同一段记忆**（那正是"绑定"要买到的东西）；
    //   · `dKey` 只决定**控制台预览里开哪个窗口** —— 游戏内的话单独一个
    //     「游戏内对话 · <服务器>」窗口，而不是混进那个人的 QQ 私聊里
    //     （使用者 2026-10-04 的要求：「可以在预览中单独建一个游戏内对话的窗口」）。
    //   ∴ 只有**镜像**（`#mirror*`）走 `dKey`；其余一律走 `chatKey`。别顺手把
    //     别的用途也改成 `dKey` —— 那会让"同一段记忆"这条设计无声地失效。
    const dKey = displayKey ?? chatKey
    const dWho = display ?? { kind, peerId }
    // ★★ 本轮的起算点（回应速度档位用）。
    //
    // 为什么是"回合开始"而不是"消息到达"：档位承诺的是**回复的回应速度**，
    // 而使用者感知到的等待 = 模型思考/调工具的时间 + 我们额外压的时间。
    // 从回合开始量，正好是"模型花了多久"；唤醒判定那 0~6 秒是另一件事
    // （它有自己的超时与放过规则），混进来只会让档位在"开了语义唤醒"时变成另一个东西。
    // ⚠️ 这个值一路传到 `#deliver`，档位据此决定"补时"还是"不再叠加"——
    //    丢了它就等于退回老行为（说好的 8 秒等到 23 秒）。
    const turnStartedAt = Date.now()
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
      const sameSpeaker = prior.senderId === senderId
      const sameAsInFlight = prior.text === normalized
      const sameAsLastReplied = this.#lastDelivered.get(chatKey) === normalized
      // ★★ 三条边界（2026-10-02 修「偶尔不回答」，每条都有真机日志依据）──────────
      //
      // ① **重复内容必须同一个人**才算重复：原来只比内容，于是群里两个人碰巧说同一句话时
      //    后说的那个被当成"重复"直接不回 —— 那也是"没回答"。
      // ② **作废只在同一个发言人时生效**：这套机制的真实来由是"他等不及又发了一条"
      //    （见上面那段注释）。而 `chatKey` 是 `群:<群号>` —— **一个群只有一个槽位**，
      //    所以原来 A、B 两个人先后 @ 它时，B 一到就把 A 那一轮作废 ⇒
      //    **A 的问题永远不会被回答**（实测 2026-10-02 06:10:24：猫问的那条被店长KEEPER 顶掉，
      //    日志里 `旧回合已作废，不发送回复（2796ms）`，此后只答了后一条）。
      // ③ **已经发过「先应一声」就不作废**：答应了就答完。否则使用者看到的是
      //    "稍等，我想想"然后**永远没有正文** —— 比静默更伤（实测 12 次作废里 6 次如此）。
      //
      // 不满足作废条件时**什么都不做**：这一条照常排队（在 `#withLock` 里等前面那轮让出锁），
      // 代价是多人同时叫它会**依次**回答 —— 慢，但谁都答。
      if (sameSpeaker && (sameAsInFlight || sameAsLastReplied)) {
        this.log(
          `[bridge] 跳过重复内容（${chatKey}｜与${sameAsInFlight ? '正在处理的' : '刚回复过的'}那条相同）：` +
            normalized.slice(0, 30),
        )
        return { handled: false, reason: 'duplicate' }
      }
      const noSupersedeWhy = !sameSpeaker ? '不同发言人' : prior.interimSent ? '已发过「先应一声」' : ''
      if (noSupersedeWhy) {
        this.log(`[bridge] 不作废旧回合（${chatKey}｜${noSupersedeWhy}）⇒ 这一条排队，等前面那轮让出锁`)
      } else {
        // 不同内容 + 同一个人 + 还没应声 → 让旧回合"作废"：仍在跑，但不再等它、也不再发它的回复
        prior.superseded = true
        this.log(`[bridge] 收到更新的消息，旧回合作废（${chatKey}｜同一个发言人又发了一条；它仍会跑完，但不再等它）`)
      }
    }

    // ★ token 带上**发言人**与"有没有应过声"：上面那三条判据要用（2026-10-02）。
    const token = { text: normalized, superseded: false, senderId, interimSent: false }
    this.#pending.set(chatKey, token)

    // ── 0.3.0alpha：这里原来是「这一轮是闲聊态还是工作态」的判定 ──────────────
    //
    // 拆掉的东西（连同它们的理由一起删，别只删代码留下注释误导后来人）：
    //   · `#detectTurnMode` 那一档"规则拿不准就问一次模型"的调用与它的小时预算；
    //   · `#modeAborts` 那套"旧判定让路"的取消柄；
    //   · 把 `mode` / `modeSource` 写回会话镜像、供界面回答"这条为什么这么短"。
    // 现在说话方式只有一份、而且**就在人设文件里**，这一轮**没有态**可判 ——
    // 判定那一步既不产生行为差异，也不再有成本，留着只会让人以为它还在起作用。

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
      // ── ★★★ 游戏内那一轮**不发**「先应一声」（使用者 2026-10-04 明确要求）──────
      //
      // 两条理由，第一条是使用者的要求，第二条是它本来就不该发生：
      //   ① 他在游戏里说一句话，垫场白跑到**QQ 私聊**去了（因为这个 turn 的
      //      `kind/peerId` 是那个绑定的 QQ）—— 那是**错的通道**，见 `#speakerNotice`；
      //   ② 就算改对通道，它也只剩公屏这一条路 —— 而「先应一声」是一句
      //      "我在想"的**垫场白**，把它印到**全服公屏**上是纯噪音（真正的回复
      //      本来就会发出去），而且和"每条发言都像普通玩家"那条要求相冲。
      // ∴ 游戏通道**整条跳过**：不挂定时器、也不留"改天补发"的口子。
      if (interim.enabled !== false && deliverTo?.channel !== 'game') {
        interimTimer = setTimeout(() => {
          // ── ★★ 静默时段：**不发**「先应一声」（用户 2026-09-30 要求）──────────
          //
          // 判在**回调里**而不是挂定时器之前，理由有两条，第二条是决定性的：
          //   ① 终局判定要的是"发出的那一刻"—— 8 秒后可能已经跨过静默时段起点；
          //   ② 一个长回合只挂**一个**定时器，回调里不判就再没有第二次机会
          //      （回调只在 afterMs 那一刻跑一次，静默时段内更不该重挂一个补发）。
          //
          // 为什么这条要求本身是对的：静默时段的存在意义就是"夜里不发出'我在线'
          // 的信号"。而「先应一声」恰好是最强的在线信号 —— 凌晨 3 点冒出一句
          // "我在想"，把静默时段要遮的东西原样喊了出来，比不延迟更糟。
          //
          // ⚠️ 只影响这一条**提示**：正式回复照旧延后发出（"不拒答、只变慢"不变）。
          if (isQuietNow(new Date(), this.config.humanize?.quietHours)) {
            this.log('[bridge] 静默时段：不发「先应一声」（正式回复仍会延迟后发出）')
            return
          }
          // ── 0.3.0alpha：这里原来还有一条「闲聊态不发」的抑制（2026-10-01 加）──
          //
          // 它当时的理由：那条提示是**工具人**的语言，一出现就把人格打回原形
          // （「等下，我查查」把"极短/接梗/不解释"全抹掉）。
          // 双态拆掉之后这条判据**没有对象了** —— 但结论不是"随手删掉算了"：
          // 现在没有"这一轮是闲聊"这个信息，也就**没法只对一部分回合抑制它**。
          // 用户 2026-10-02 定的口径是**保留并默认开启**（与升级前的工作态一致）：
          // 静默时段那一条仍然有效（它有自己的判据），而"这一轮是不是闲聊"不再参与。
          // ⚠️ 这条抑制如果将来要回来，它需要的判据是**这一轮真的跑了很久且有工具调用**，
          //    不是"消息属于哪一类" —— 后者是这次被拆掉的那个分类器。
          const text = this.interimPicker.pick(collector)
          if (!text) return
          // ★★ 既然已经答应了，这一轮就**不许再被作废**（判据在 `#runTurn` 的作废那段）。
          //   否则使用者看到的是"稍等，我想想"然后永远没有正文 —— 比静默更伤
          //   （实测 12 次作废里 6 次是这种）。标记在**真要发之前**打，不是挂定时器时打。
          token.interimSent = true
          this.log(`[bridge] 回合仍在进行，先发一条：${text}（${chatKey}）`)
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

      // ── 截图技能的管理员硬闸：写这一轮的会话授权 ──────────────────────────
      //
      // ★ 位置是刻意的：**真跑模型之前**。理由有两条，第二条是决定性的：
      //   ① 技能工具在模型回合里被调用，所以授权必须在那一刻之前就位；
      //   ② 判定依据只能是**桥接自己算出来的 tier**（`verdict.tier`，见上面的准入校验）——
      //      它是这个进程里唯一"模型改不了"的权限事实。
      // 失败的后果只是"管理员截图会被拒"，所以这里**只记一行日志**，绝不影响对话。
      const grant = writeGrant({
        workspace: this.config?.dsh?.workspace,
        peerKey: chatKey,
        kind,
        peerId,
        senderId,
        tier,
        config: this.config,
      })
      if (!grant.ok && this.config?.skills?.screenshot?.enabled !== false) {
        // 只有"截图技能开着但授权没写成功"才值得喊一声（那正是会静默失效的组合）
        this.log(`⚠️ [bridge] 截图授权没写成功（截图会被拒，聊天不受影响）：${grant.why}`)
      }
      // ── 服务器控制台的管理员硬闸（0.3.2 收尾）：**独立一个域** ──────────────
      //
      // ★★ 为什么单独写一份、而不是复用截图那份：两个域的开关注解不同
      //   （截图看 `skills.screenshot.enabled`，MC 看 `servers[].commandFromQQ`），
      //   共用一份会让"截图开着"顺带给 MC 开权限 —— 那是最难查的一类越权。
      // ★ 默认**不写**（没有任何服务器打开 `commandFromQQ`，或说话人不是管理员）⇒
      //   工具侧 fail-closed 拒绝，且工作区里不留垃圾文件。
      // ★ 失败的后果只是"管理员下指令被拒"，所以只记一行日志，绝不影响对话。
      try {
        const mcGrant = writeGrant({
          workspace: this.config?.dsh?.workspace,
          peerKey: chatKey,
          kind,
          peerId,
          senderId,
          tier,
          config: this.config,
          scope: 'mc',
        })
        if (mcGrant.ok) {
          this.log(`🎛️ [servers] 已给这一轮写控制台授权（${chatKey}·${tier}）—— 只有管理员会在文件里`)
        }
      } catch (error) {
        this.log(`⚠️ [servers] 控制台授权没写成功（从 QQ 下指令会被拒）：${error?.message ?? error}`)
      }
      const dropGrant = () => {
        const r = clearGrant({ workspace: this.config?.dsh?.workspace, peerKey: chatKey })
        if (!r.ok && r.why !== '缺参数') {
          this.log(`⚠️ [bridge] 截图授权没清掉（${r.why}）—— 它会在 10 分钟后自然过期`)
        }
        // ★ MC 那份**必须一起清**：留着就是"上一轮管理员的授权"，
        //   而下一轮可能是普通人在说话 —— 那就是一条提权路径（同截图那条教训）。
        try {
          clearGrant({ workspace: this.config?.dsh?.workspace, peerKey: chatKey, scope: 'mc' })
        } catch {
          /* 清不掉就靠 10 分钟过期兜底；上面那条日志已经提示了这个机制 */
        }
      }

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
              // ★ 游戏内那条通道的来源标注（空串 ⇒ 逐字不变，见 channel-prompt.mjs）
              channelOrigin,
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
        // ★ 授权必须跟着回合一起收掉：留着它等于"上一轮的管理员授权还活着"。
        dropGrant()
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
        await this.#speakerNotice(kind, peerId, `⚠️ ${friendly}`, deliverTo)
        return { handled: false, reason: 'prompt-failed', error: error.message }
      }

      const result = await collector.finished()
      clearInterim()
      // ★ 回合跑完就收掉截图授权（超时/作废的回合也会走到这里 —— 正是要收的那种）。
      dropGrant()
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
        // ★ 群名：`#verifyIdentity` 每轮从协议端核实（`get_group_list`），
        //   这里只用来把**新建的**群记忆文件头写成群名而不是光秃秃的号码。
        chatName: identity?.chatName ?? '',
        // ★ 发言人昵称（0.3.0alpha）：记忆条目要带「（昵称 QQ 号码）」这个身份前缀，
        //   来源见 `#speakerLabel`。核实不到时它回空串 —— 那时条目只写号码。
        speakerName: this.#speakerLabel({ senderId, identity }),
        userText: rendered?.text ?? '',
        answer,
        complete: !(result.timedOut || result.aborted),
        // ★ 承诺通道用：这一轮**真的会把回复发出去**吗（被更新的消息作废的那一轮不发）。
        //   用户没看到的那句话，不能记成"我答应过"。
        sent: !token.superseded,
      })
      answer = settled.answer

      // ── 已被更新的消息取代：不发回复，也不发超时提示 ────────────────────
      // 这一轮**已经烧掉的 token 收不回来**（SDK 无法中止），但没必要再把
      // 一个"过期问题的答案"发出去 —— 那只会让人莫名其妙，而且下一条消息
      // 正在等着处理。对使用者而言效果是"只回了最新那条"。
      if (token.superseded) {
        settle()
        this.log(
          `[bridge] 旧回合已作废，不发送回复（${chatKey}｜${result.durationMs}ms）` +
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
        await this.#speakerNotice(kind, peerId, '⚠️ 这次处理超时了，请再发一次。', deliverTo)
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
      this.#mirrorThinking(dKey, result.thinking, dWho)

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
        } else if (activeLabelById(outMarkers.sticker, this.#stickerVocabOpts())) {
          // ★ 0.2.4：写的是**表情包标签**（`[sticker:笑死]`）—— 这不是"没有对应的表情"，
          //   它由下面的表情包判定处理（按标签从库里选一张图）。
          //   ⚠️ 这里**不能**记 warning：否则每次用标签都会留一行"没有对应的表情"的
          //   假告警，把真问题淹掉（本项目最恨的一类噪声）。
          //   ★ 认标签用**生效词表**（`activeLabelById` 同时认 id 与中文名）——
          //   静态的 `normalizeLabelId` 只认内置表，用户在标注台新加的标签会被误判成
          //   "不认识"，于是模型写的 `[sticker:点赞]` 被当成乱写而丢掉。
        } else if (!this.#stickerWarned.has(outMarkers.sticker)) {
          this.#stickerWarned.add(outMarkers.sticker)
          const names = stickerNames(this.config.send?.stickers ?? {})
          this.log(
            `[bridge] [sticker:${outMarkers.sticker}] 没有对应的表情：既不是表情表里的名字、也不是表情包标签` +
              `（可用的名字：${names.length ? names.join('、') : '（还没配置表情表）'}）→ ` +
              '只剥掉标记，不发表情（不许猜，猜错就是发错表情）',
          )
        }
      }

      if (!answer && !faceId) {
        // 规则是"必须回答"。如果模型什么都没说（比如只调了工具就结束），
        // 不能让用户对着空气等 —— 给一个明确的兜底。
        //
        // ⚠️ 但"只写了表情包标签"是一个**明确要发东西**的回合，不能兜底成一句话 ——
        //   那会让用户收到"（这次没有产生回复内容）"而表情反而不发（荒谬）。
        const wantsPackSticker = Boolean(outMarkers.sticker && activeLabelById(outMarkers.sticker, this.#stickerVocabOpts()))
        if (!wantsPackSticker) {
          answer =
            result.toolCalls.length > 0
              ? '（我执行了操作但没有输出文字，请再问一次或换个说法。）'
              : '（这次没有产生回复内容，请再试一次。）'
          this.log(`[bridge] 回合结束但无文本输出；事件序列：${result.eventTypes.join(' → ')}`)
        }
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
        this.#mirrorThinking(dKey, `[投递闸门] 拦下整条内部泄漏：${gated.why}`, dWho)
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
        this.#mirrorThinking(dKey, `[隐私闸门] 拦下一条含隐私的回复（${(priv.categories ?? []).join('、')}）`, dWho)
        answer = BLOCKED_OUTPUT_NOTICE
      }

      // ── 表情包（0.2.4）：模型没要就自主判一次 ───────────────────────────
      //
      // ★ 位置纪律：必须在**标记剥完、兜底话术与投递闸门之后**、`#deliver` 之前。
      //   · 在标记之前 → 拿着带 `[sticker:…]` 的原文去抽态度，等于把协议当语料；
      //   · 在投递闸门之前 → 可能给一条"被拦下的回复"配图（那是错的）；
      //   · 在 `#deliver` 之后 → 没有"最后一条"可以挂。
      //
      // ★ 两条触发的关系：模型主动写的标签优先（`requestedLabel` 已经过词表校验）；
      //   模型没写才让桥接自主补。**同一轮最多一张**（配额里还有 maxPerTurn 兜底）。
      let sticker = null
      // ★ `!deliverTo`：游戏内那条通道**发不了表情包**（`say` 只有文字）——
      //   不挡这一下的话，一轮游戏内回复会**白扣一次表情配额**，而图哪儿都没去。
      if (!faceId && !deliverTo && this.config?.skills?.sticker?.enabled !== false) {
        const picked = this.#decideSticker({
          chatKey,
          answer,
          requestedLabel: outMarkers.sticker,
          // ★★ 把**对方这条消息**也传进去（0.2.4 第十三轮）。
          //
          // 为什么必须传：自主那条路有两组线索，`ownCues` 匹配 bot 自己的正文，
          // `otherCues` 匹配**对方说的话**。少了这一句，"对方说累/委屈/可爱"
          // 这类语境就永远够不着 —— 因为一个助手不会在回复里说"我好累"。
          // 实测：`tired`（9 张图）在传之前是**结构性死代码**。
          userText: rendered?.text ?? '',
        })
        sticker = picked.sticker
      } else if (faceId) {
        this.log('[sticker] 这一轮用的是 QQ 内置表情（face id）→ 不再补表情包（两种表情不发两条）')
      }

      // 登记进 in-flight：收尾时要等它发完，否则延迟中的回复会被掐死
      const delivering =
        deliverTo?.channel === 'game'
          ? // ★★ 0.3.2 P3：游戏内那条通道**不走 `#deliver`**。
            //   理由写在 `#deliverToGame` 上（`#deliver` 是 QQ 传输形状的：
            //   表情包 / 内置脸 / `[reply:]` / QQ 单条上限 —— 搬进游戏只会
            //   凭空多出几件游戏里根本不存在的东西）。共用的是**上游**：
            //   模型那一轮、终检门、**隐私闸门**都在上面，一条都不会漏。
            this.#deliverToGame(deliverTo.server, deliverTo.playerName, answer, { turnStartedAt })
          : this.#deliver(kind, peerId, answer, result, {
              replyTo,
              faceId,
              sticker,
              // ★ 档位要靠它算"已经花了多久"（见 #runTurn 顶部的 turnStartedAt）
              turnStartedAt,
            })
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
        if (deliverTo?.channel === 'game') {
          // ★ 通道是游戏时，**不能**用 `#safeSend` 去 QQ 私聊里解释 —— 那会把
          //   "游戏里没收到"变成"QQ 里收到一条莫名其妙的私聊"。改走同一条游戏通道
          //   （`#gameTellraw` 本身就是尽力而为、失败只记日志）。
          await this.#gameTellraw(deliverTo.server, deliverTo.playerName, '⚠️ 我这边没能把话说到公屏上 —— 刚才那条可能没发出去。')
        } else {
          await this.#safeSend(kind, peerId, '⚠️ 我这边没能把回复发出去，你刚才那条可能没收到 —— 请再发一次。')
        }
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
   * 当前说话人的昵称（按人昵称，0.2.2）。
   *
   * ★ **每轮现读**（`memory/contacts.md` 很小）：所以控制台里改完**下一轮就生效**，
   *   不需要重启 —— 这与"人设要重启"不同，因为人设是构造期缓存的，而这是每轮的文件读取。
   * ★ 读不到/文件坏了 → 返回空串（**不注入任何东西**），并按段去重报一次日志：
   *   绝不能让"称呼读不出来"影响回话。
   */
  #nicknameFor(senderId) {
    if (!senderId) return ''
    const workspace = this.config.dsh?.workspace
    if (!workspace) return ''
    try {
      return nicknameFor({ workspace, qq: senderId })
    } catch (error) {
      this.#warnInjectOnce('称呼段', error)
      return ''
    }
  }

  /**
   * 写进记忆条目的**发言人标签**（只取名字部分；号码由 `speakerPrefix` 自己拼）。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * 两处名字源的优先级（顺序是有理由的，别调换）
   * ══════════════════════════════════════════════════════════════════════════
   *   ① `memory/contacts.md` 的**按人昵称**（`#nicknameFor`）：那是使用者**亲自设的**，
   *      比协议端的花名更可能是他想在记忆里看到的名字（"忘忧"而不是"✨忘忧✨[忙碌]"）；
   *   ② 本轮**协议端核实过的** `identity.name`：昵称表里没有这个人时的唯一来源。
   * 两者都没有就返回空串 —— 那时条目只写号码（**不编名字**，与 `memoryFileTitle`
   * 查不到群名就只写号码是同一条规矩）。
   */
  #speakerLabel({ senderId, identity = null } = {}) {
    const fromContacts = this.#nicknameFor(senderId)
    if (fromContacts) return fromContacts
    if (identity?.ok && identity.name) return String(identity.name).trim()
    return ''
  }

  /**
   * 「你被叫到之前，群里刚说了什么」（2026-09-30，用户拍板的方案①）。
   *
   * ── 它修的是什么（真机事故，不是设想）─────────────────────────────────────
   * 18:03:38 无忘远霞在群里说「其实想想，记忆这种碳基生物需要的情感依赖…」→ **未唤醒**
   * （桥接只在被 @ / 命中唤醒词时才把消息交给模型），于是这句话**谁都没看见**；
   * 18:03:41 同一个人 @ 机器人说「你说呢」→ 模型手上只有三个字，只能瞎猜
   * （它猜的是行情/三菜一汤，回复里自己都说"猜错你纠正我"）。
   *
   * ── 为什么不是"什么都塞"──────────────────────────────────────────────────
   * 只取**机器人自己上一条发言之后**的那几条（它就是"你在场外的那段时间"），
   * 再取最近 `RECENT_CTX_MAX` 条：
   *   · 机器人自己说过的话**不取**（那些已经在会话历史里，重复注入纯属浪费与噪音）；
   *   · 当前这条**不取**（它是下面【当前消息】，重复会让模型以为对方说了两次）；
   *   · 群里刷了很久没叫它时，只给最近几条 —— 它们才是"刚才在聊什么"。
   *
   * ── 代价（如实写在这里，别让它变成隐形成本）──────────────────────────────
   * 这些消息会被**送给模型 API**（此前只有被唤醒的那几条会）。所以：
   *   · 语料库关掉时（`corpus.enabled = false`）这一整段不存在（一个字都不发）；
   *   · 入库时就已过隐私闸（`corpus.mjs` 的 `screenForStore`）—— 不会因为这段路把隐私带出去；
   *   · 单条截断到 `RECENT_CTX_CHARS`，条数有硬上限 ⇒ 每轮最多约 900 字。
   *
   * @returns {Array<{name: string, text: string}>} 空数组 = 这一轮没什么可补的
   */
  #recentMissedMessages({ chatKey, messageId, text } = {}) {
    if (!chatKey || !String(chatKey).startsWith('group:')) return [] // 私聊每条都唤醒，没有"场外"
    const rows = this.#corpusRecentRows({ chatKey, messageId, text, limit: RECENT_CTX_SCAN })
    if (rows.length === 0) return []
    // 从后往前找机器人上一条：它之后的才是"机器人没参与的"
    let cut = 0
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].isBot) {
        cut = i + 1
        break
      }
    }
    return rows
      .slice(cut)
      .filter((row) => !row.isBot && String(row.text ?? '').trim())
      .slice(-RECENT_CTX_MAX)
      .map((row) => ({ name: String(row.senderName ?? row.userId ?? '某人'), text: String(row.text).trim() }))
  }

  /**
   * 从语料库取该会话最近的几行（**排除当前这条**）。两个用处共用这一处取数：
   *   · `#recentMissedMessages`（提示词里的「你被叫到之前，群里刚说了什么」）；
   *   · `#maybePrewakeAffect`（情绪闸门的上下文 —— 同一句话放在不同上下文里，
   *     "是不是在跟机器人说"的答案会变，所以闸门也必须看得到）。
   *
   * ★ 排除当前这条的**两条判据都要有**：`message_id` 认得出就按 id 排；
   *   认不出（语料库里是 null）时按正文比对。只按 id 比会踩到一个很隐蔽的坑 ——
   *   两边都是 null ⇒ `'' === ''` 把**每一行**都滤掉，整段永远为空。
   */
  #corpusRecentRows({ chatKey, messageId, text, limit = RECENT_CTX_SCAN } = {}) {
    if (!chatKey) return []
    if (this.config.corpus?.enabled === false) return []
    if (!this.#corpus) return []
    try {
      const r = this.#corpus.recent({ chatKey, limit, maxChars: RECENT_CTX_CHARS, latest: true })
      if (!r?.ok || !Array.isArray(r.rows)) return []
      const curId = messageId != null && String(messageId) !== '' ? String(messageId) : null
      const curText = String(text ?? '').trim()
      return r.rows.filter((row) => {
        if (curId && String(row.messageId ?? '') === curId) return false
        if (!curId && curText && String(row.text ?? '').trim() === curText) return false
        return true
      })
    } catch (error) {
      // ★ 增强路径可以失败，但不许安静地失败（与注入段的同一条纪律）
      this.#warnInjectOnce('最近上下文段', error)
      return []
    }
  }

  /**
   * ★★ 取（必要时建）**情绪闸门**。建不起来就返回 null，调用方按"不记"处理。
   *
   * ── 通路复用 `wake.judge` 的那把 key（不是新开一个输入框）────────────────────
   * 两者都是"**额外来一次小额模型判定**"，用户要配的东西、以及它的成本口径完全相同
   * （有没有专用 key ⇒ 直连或一次性进程）。再开一个 `memory.affect.judge.apiKey`
   * 只会多一处会漂的真值，而使用者根本无法判断该给哪个配。所以：**档位**由
   * `memory.affect.prewake` 决定，**通路**沿用 `wake.judge`。
   */
  #ensureAffectGate() {
    if (this.affectGateInjected) return this.affectGateInjected
    if (this.#affectGate) return this.#affectGate
    const j = this.config.wake?.judge ?? {}
    const judgeKey = String(j.apiKey ?? '').trim()
    const transport = judgeTransport(j)
    const direct = judgeKey ? resolveDirectTarget({ config: this.config }) : null
    try {
      this.#affectGate = createAffectGate({
        transport,
        cliPath: this.config.dsh?.cliPath,
        cwd: this.config.dsh?.workspace,
        baseUrl: direct?.baseUrl ?? j.baseUrl,
        apiKey: direct?.apiKey ?? '',
        model: direct?.model ?? '',
        log: (m) => this.log(m),
      })
      this.log(
        `[memory] 情绪闸门已就绪：prewake=${this.#prewakeMode()} · 通路=${transport}` +
          `（${judgeKey ? '复用 wake.judge.apiKey ⇒ 直连' : '没配 wake.judge.apiKey ⇒ 一次性进程'}）` +
          ' · 只在"未唤醒 + 情绪命中"时才问一次',
      )
    } catch (error) {
      this.log(`❌ [memory] 情绪闸门建不起来（这一层停用，未唤醒的情绪一律不记）：${error?.message ?? error}`)
      return null
    }
    return this.#affectGate
  }

  /** 当前档位（每次现读活配置：改完下一轮就生效，不需要重启）。 */
  #prewakeMode() {
    return normalizePrewakeMode(this.config.memory?.affect?.prewake)
  }

  /**
   * ★★ 未唤醒的情绪：**先筛、再问一次、然后才决定记不记**（2026-09-30 用户拍板）。
   *
   * ── 为什么需要它（真机语料，不是设想）──────────────────────────────────────
   * 群聊 3598 条消息里 3488 条（97%）是未唤醒的 —— 桥接在唤醒判定那一刻就丢掉了它们，
   * 所以"有人对着机器人倾诉、但没 @ 它也没写名字"这件事**从来没被记下来过**。
   * 但把确定性判定直接前移也不行：那批候选里 **5 条有 4 条是错的**（"舍不得就别走呐"
   * 是对**别人**说的挽留、"压力大肥鱼是吧"说的是别人且是玩笑）。
   *
   * ── 三个档位 ───────────────────────────────────────────────────────────────
   *   `off`（默认）→ 直接返回，**一次模型调用都不发**；
   *   `shadow`     → 判定照跑，**只写日志、不写盘**（先看一周它会记下什么）；
   *   `judge`      → 判定说"是在跟机器人说话"才写。
   *
   * ── 失败了怎么办 ───────────────────────────────────────────────────────────
   * 判定不出来/超预算/通路没配好 ⇒ **不记**（`failVerdict`），但**留一行日志说明原因**
   * （"它怎么没记住"必须查得到）。
   *
   * @returns {Promise<{mode: string, recorded: boolean, verdict?: string, why: string}>}
   *   返回值只用于测试与日志；**任何分支都不抛**（增强路径纪律）。
   */
  async #maybePrewakeAffect({ kind, peerId, senderId, senderName, chatKey, messageId, text, chatName = '' } = {}) {
    const mode = this.#prewakeMode()
    if (mode === PREWAKE.OFF) return { mode, recorded: false, why: '档位是 off' }
    if (kind !== 'group') return { mode, recorded: false, why: '私聊每条都唤醒，不走这条' }
    // 记忆关掉时**一个字节都不写**（与 #settleMemory 同一条闸门）
    if (this.config.memory?.enabled === false) return { mode, recorded: false, why: '记忆开关关着' }
    if (!senderId) return { mode, recorded: false, why: '没有发言人 id，归属无从裁定' }
    // ★ 名单准入**不可省**（与唤醒闸门同一条理由）：这条钩子挂在唤醒判定那一层，
    //   而那里**还没有过 roster 准入**。少了这一道，任何在群里发过情绪词的陌生人
    //   都能让桥接替他花一次判定调用 —— 那就是一个免费的拒绝服务面。
    const admitted = this.roster?.decide({ kind, peerId, senderId })
    if (!admitted?.respond) {
      return { mode, recorded: false, why: `名单外（${admitted?.reason ?? 'unknown'}）` }
    }

    const pour = detectAffectPour({ text })
    if (!pour.hit) return { mode, recorded: false, why: '没有情绪线索' }
    const entry = affectEntryText(pour)
    if (!entry) return { mode, recorded: false, why: '组不出条目' }

    const gate = this.#ensureAffectGate()
    if (!gate) return { mode, recorded: false, why: '闸门不可用' }

    const r = await gate.judge({
      senderName,
      text,
      recent: this.#corpusRecentRows({ chatKey, messageId, text, limit: 10 }),
    })
    const toBot = r.judged === true && r.verdict === GATE_VERDICT.TO_BOT
    const detail = `判定=${r.verdict}${r.judged ? '' : '（没问成：' + String(r.why ?? '未知') + '）'}${
      r.reason ? `｜它说：${r.reason}` : ''
    }`

    if (mode === PREWAKE.SHADOW) {
      this.log(
        `[memory] 情绪倾注（未唤醒·**影子**）：${
          toBot ? `若判定通过会记下「${entry}」` : `判定不通过、本来也不会记「${entry}」`
        } —— ${detail}（只记账，没写盘）`,
      )
      return { mode, recorded: false, verdict: r.verdict, why: detail }
    }

    if (!toBot) {
      this.log(`[memory] 情绪倾注（未唤醒）→ **不记**（${pour.why}）：${entry} —— ${detail}`)
      return { mode, recorded: false, verdict: r.verdict, why: detail }
    }

    const out = applyMemoryItems({
      workspace: this.config.dsh?.workspace,
      kind,
      peerId,
      senderId: String(senderId),
      tier: 'user',
      chatName,
      // ★ 发言人昵称（0.3.0alpha）：这条通道的 `senderName` 是调用方核实过的那个
      //   （见 `#maybePrewakeAffect` 的入参）。它可能与 `contacts.md` 里的按人昵称不同 ——
      //   这里**优先按人昵称**（使用者亲自设的那份），与 `#speakerLabel` 同一条口径。
      speakerName: this.#speakerLabel({ senderId: String(senderId), identity: senderName ? { ok: true, name: senderName } : null }),
      items: [{ scope: SCOPE.PERSON, text: entry, source: 'cue-gate' }],
      log: (m) => this.log(m),
    })
    const applied = out.applied?.[0] ?? null
    this.log(
      `[memory] 情绪倾注（未唤醒·闸门通过）→ 记入个人档：${entry} —— ${detail}` +
        (applied ? `｜落盘 ${applied.rel}${applied.deduped ? '（已有同一条）' : ''}` : '｜**没落盘**'),
    )
    // 审计与桥接自己那条通道同格式（来源 `cue-gate`，一眼看得出它走的是未唤醒闸门）
    for (const a of out.applied ?? []) {
      appendAuditEntry({
        workspace: this.config.dsh?.workspace,
        entry: {
          chatKey,
          senderId: String(senderId),
          source: a.source ?? 'cue-gate',
          scope: a.scope ?? SCOPE.PERSON,
          outcome: a.deduped ? 'deduped' : 'applied',
          chars: String(a.entry ?? '').length,
        },
        log: (m) => this.log(m),
      })
    }
    for (const i of out.ignored ?? []) {
      appendAuditEntry({
        workspace: this.config.dsh?.workspace,
        entry: {
          chatKey,
          senderId: String(senderId),
          source: i.source ?? 'cue-gate',
          scope: i.scope ?? SCOPE.PERSON,
          outcome: 'ignored',
          chars: String(i.entry ?? '').length,
          why: i.why,
        },
        log: (m) => this.log(m),
      })
    }
    return { mode, recorded: (out.applied?.length ?? 0) > 0, verdict: r.verdict, why: detail }
  }

  /**
   * 收集**启用中**技能的提示词片段（0.2.2）。
   *
   * ★ 每轮现调：`promptSections()` 按技能契约必须是**纯函数**（无 IO、无副作用），
   *   所以这里既不需要缓存、也不会因为"改了配置没重启"而注入过期内容。
   * ★ 失败只降级：一个技能的片段拼不出来，不能让整轮提示词拼不出来。
   */
  #skillSections() {
    if (!this.skills?.length) return []
    try {
      const { lines } = collectSkillPromptSections({
        skills: this.skills,
        config: this.config,
        log: (m) => this.log(m),
      })
      return lines
    } catch (error) {
      this.#warnInjectOnce('技能段', error)
      return []
    }
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
    // ── 表情包的两段（0.2.4）────────────────────────────────────────────
    //   · 标记段：教**当前真有货**的标签（库变了就变，所以每轮现算）
    //   · 人设段：说清"能表达什么、什么时候不该发"（**不列标签**，见 sticker-decision）
    // 两段都从下面这一个 `#stickerPromptBits()` 出，口径不会漂。
    // ★ 0.2.7 更正：这里原来写的是"由同一个 `stickerPromptFacts` 喂"—— 那句话是错的，
    //   那个函数全仓库**没有任何调用方**（已删）。真正算这两段的是
    //   `#stickerPromptBits()` 里的 `readStickerLibrary` + `labelCoverage`。
    //   而且这两段**不是**表情包技能贡献的（它的 `prompt.source = "none"`）。
    const sticker = this.#stickerPromptBits()
    // ── ★★ 说话方式：**就在人设文本里**（0.3.0alpha 第二步）─────────────
    //
    // 0.3.0beta 在闲聊态"用风格文件替换人设的两节"；0.3.0alpha 第一步改成
    // `composeVoice()` 每轮替换；**现在不再拼任何东西** —— 出厂人设只剩一份，
    // 说话方式已经**直接写进那个人设文件**，所以提示词用的是**完整人设**
    // （`this.personaText`，构造期缓存的那一份）；`src/voice.mjs` 与
    // `src/voice-source.mjs` 都删掉了，那一层连常量带同步工具一起不存在了。
    //
    // ★ 可观测性仍然有，但已经搬到**构造期**（构造函数里那一行）：人设文本是构造期读一次的
    //   快照，形状在运行期不可能变 —— `api.mjs` 的 `/api/config` 自己也回 `restartRequired: true`。
    //   以前在这里每轮跑一遍全量分节只为"形状变了才记一行"，而签名每轮都一样，
    //   那行日志永远不会再触发 ⇒ 每轮都在做一次注定没有输出的解析。
    return buildChannelPrompt({
      rendered,
      reason,
      ...opts,
      config: this.config,
      personaText: [this.personaText, sticker.personaNote].filter(Boolean).join('\n\n'),
      stickerLines: sticker.lines,
      // ── 视频（0.2.7，方案 A）────────────────────────────────────────────
      // ★ 只把**直链**交出去（`text.mjs` 的 `videoRefs`），核心**不下载视频**：
      //   真正取视频的是「视频识别」技能，它自带 SSRF 守卫/大小上限/临时文件即删。
      // ★ `videoTool` 是**门控事实**：抽帧不可用时，channel-prompt 那边会如实说
      //   "看不到画面"，而不是教模型去调一个不存在或必然失败的工具。
      videos: Array.isArray(rendered?.videoRefs) ? rendered.videoRefs : [],
      videoTool: this.#videoToolFacts(),
      // ── 称呼（按人昵称，0.2.2）──────────────────────────────────────────
      // ★ 每轮现读 `memory/contacts.md`：改完**下一轮就生效**（不需要重启）。
      //   只取**当前说话人**那一条（群里也只看发言人，不列全群 —— 那是隐私面）。
      nickname: this.#nicknameFor(opts.senderId),
      // ── 项目简介副本（0.2.2）────────────────────────────────────────────
      // ★ 只是一行**指针**（不是文档本体）：模型被问到"你能做什么 / 能改我的文件吗 /
      //   这项目怎么做的"时，用它去 `read` 那一节。副本在构造期写好，所以这里是常量；
      //   没写成（发布包不带 docs/）时是空串 ⇒ 提示词里一个字都不出现（不留悬空指针）。
      projectDocRel: this.projectDocRel,
      // ── 外部技能片段（0.2.2）────────────────────────────────────────────
      // ★ **每轮现收集**：开关一改，下一轮就不再有它的指引（即时生效）。
      // ★ 出错只降级：某个技能的 promptSections() 抛错，只记一行日志并跳过它，
      //   绝不能让整个提示词装配失败 —— 那等于机器人彻底不说话。
      skillSections: this.#skillSections(),
      // ★ 0.3.2 P3：游戏内那条通道把来源标注整条换掉（否则模型会以为在一对一私聊里，
      //   而它说出去的每一句都会**当场印在服务器公屏上**）。空串 ⇒ 逐字不变。
      channelOrigin: opts.channelOrigin ?? '',
      log: (m) => this.log(m),
      warn: (what, error) => this.#warnInjectOnce(what, error),
      sessionState: this.#sessionState,
      // ── 「你被叫到之前，群里刚说了什么」（2026-09-30）─────────────────────
      // ★ 只取**机器人上一条发言之后**的那几条（"你在场外的那段时间"），
      //   机器人与当前这条都排除 —— 理由与代价写在 `#recentMissedMessages` 上。
      recentMissed: this.#recentMissedMessages({
        chatKey: opts.chatKey,
        messageId: opts.messageId,
        text: rendered?.text,
      }),
      // ★ 缺口的**所有权仍在桥接**：取用即清（一次性语义不能在搬动中丢掉）
      consumeGap: () => {
        const gap = this.#pendingGap
        this.#pendingGap = null
        return gap
      },
    })
  }

  /**
   * 视频识别能力的事实（给提示词用的**门控**，0.2.7）。
   *
   * ── 为什么要单独算一份（不能直接把技能名写进提示词）──────────────────────
   * 提示词里只要写了"用 xxx 识别视频"，模型就会去调它。所以必须**先问清楚**：
   *   ① 「视频识别」技能装了没有？开了没有？（`isSkillEnabled`，唯一开关口径）
   *   ② QQ 工具总开关（`mcp.enabled`）关着吗？——关着时**技能工具根本没挂给模型**
   *      （与 `collectSkillPromptSections` 里那条总闸同一个判据，两处必须一致）；
   *   ③ 技能自己的自检过了吗？（缺 ffmpeg 就是在这一步被挡下的）
   * 三条都过，才把**真工具名**（`mcp__skills__video-frames__frames`，由 `skillToolFullName`
   * 拼，绝不写死）交给模型。
   *
   * ── 自检**现调**（与控制台同一个函数）────────────────────────────────────
   * `callSkillAvailable()` 每次现调：自检是同步扫 PATH（不 spawn），所以
   * "装好 ffmpeg / 填好路径"之后**提示词下一轮就跟着变**，不必等重启。
   * 调用失败一律当"不可用"（fail-closed：宁可少教一个工具，不可教一个调不通的）。
   *
   * @returns {{usable: boolean, name: string, why: string}}
   */
  #videoToolFacts() {
    const skill = (this.skills ?? []).find((s) => s.id === 'video-frames')
    if (!skill) return { usable: false, name: '', why: '「视频识别」技能没装' }
    if (this.config?.mcp?.enabled === false) {
      return { usable: false, name: '', why: 'QQ 工具总开关（mcp.enabled）关着，技能工具没有挂给模型' }
    }
    if (!isSkillEnabled(skill, this.config)) {
      return { usable: false, name: '', why: '视频识别技能没有启用（控制台 →「扩展」→ 视频识别）' }
    }
    const av = callSkillAvailable(skill, this.config)
    if (av?.ok === false) return { usable: false, name: '', why: String(av.reason ?? '').trim() || '视频识别自检没过' }
    const tool = (skill.runtimeTools ?? []).find((t) => t.id === 'frames')
    return { usable: true, name: tool?.fullName || skillToolFullName(skill.id, 'frames'), why: '' }
  }

  /**
   * 表情包：给提示词用的两段内容（标记段 + 人设补充段）。
   *
   * ★ 每轮现算（读一次库），所以"导入几张图 / 改了标签"**下一轮就生效**，
   *   不需要重启 —— 与技能提示词片段的"即时生效"同一条语义。
   * ★ 库读不到 / 没有可用标签 → 两段都是空（提示词里一个字都不出现），
   *   而不是给一段"你可以发表情"的空承诺（`persona.mjs` 第 28 条的硬规矩）。
   */
  #stickerPromptBits() {
    const empty = { lines: [], personaNote: '' }
    try {
      const cfg = this.config?.skills?.sticker ?? {}
      if (cfg.enabled === false) return empty
      const vocabOpts = this.#stickerVocabOpts()
      if (!vocabOpts) return empty
      const library = readStickerLibrary(vocabOpts)
      // ★ 用**生效词表**的 id 列表统计覆盖（新建的标签要立刻出现在提示词里，不能显示 0 张）
      const coverage = labelCoverage(library, activeLabelIds(vocabOpts))
      return {
        lines: renderStickerPromptLines({ coverage, vocabOpts }),
        personaNote: renderStickerPersonaNote({ coverage, vocabOpts }),
      }
    } catch (error) {
      this.#warnInjectOnce('表情包段', error)
      return empty
    }
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
    // ★ 先取消**在飞的唤醒判定**（0.2.3）。
    //   为什么它要排在最前面：判定是"起一个子进程问模型"，一次 3~5 秒。
    //   收尾时它既没有价值（机器人都要关了），又会把子进程留到进程退出之后 ——
    //   `runHeadless` 现在会真的 `kill()`，所以这里是唯一能干净收掉它们的地方。
    for (const ac of this.#wakeAborts.values()) {
      try {
        ac.abort()
      } catch {
        /* 取消失败无所谓 */
      }
    }
    this.#wakeAborts.clear()
    // ★ 再停掉定时整理：它会在收尾过程中重写记忆文件，而收尾本身可能正在
    //   等回复发完 —— 没必要在这个窗口里再去动用户的记忆文件。
    try {
      this.#consolidate?.stop()
    } catch {
      /* 停不掉也不影响收尾 */
    }
    // ★ 定时任务也要停：它的回调会去拼提示词、调模型、投递，
    //   而收尾正在做"等回复发完"这件事 —— 这个窗口里再塞新回合只会更难收干净。
    try {
      this.#schedule?.stop()
    } catch {
      /* 停不掉也不影响收尾 */
    }
    // ★ 服务器监测也要停，并且**把连接关掉**（RCON 是一条长连接，留着它就等于
    //   留一个句柄给下一次启动；同语料库那条"用完就关"的理由）。
    try {
      this.#serverLoop?.stop()
    } catch {
      /* 停不掉也不影响收尾 */
    }
    // ★ 0.3.2 P3：读游戏内聊天的那个循环也要停 —— 它虽然 `unref()` 过（不会拖住进程
    //   退出），但收尾期间它还会继续读日志文件，而那些日志/连接接下来的归属已经变了。
    try {
      this.#gameChat?.stop()
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
   * ★★ 但这段延迟是**下限**不是**附加**（2026-09-30 语义修正）：本轮已经花掉
   * 的时间算在等待里，超过档位目标就一个字都不再等。理由与口径见下面
   * 「回应速度档位：它是「下限」不是「附加」」那一段 —— 那里才是权威。
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
      // ★ 0.2.3：`delivery.ledger` 开关（**默认开 = 升级前的行为**）。
      //   关掉只是"不再落账"（于是"已生成未发出"这件事没有记录可查），**发送完全照常** ——
      //   返回 null 正是这条增强路径既有的"失败"语义（调用方照发，不阻塞）。
      if (this.config?.delivery?.ledger === false) return null
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

  /**
   * 表情包的判定与准备（0.2.4）。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * 它做四件事，顺序不能换
   * ══════════════════════════════════════════════════════════════════════════
   * ① 记轮次（"每 N 轮最多一次"这条配额要用；`#recentStickers`/`#stickerTurns` 都在内存）
   * ② 问 `decideSticker` 发不发、发哪张（**纯本地判定，零 token**）
   * ③ 无论发不发都落一行**决策流水**（这是三档频率与阈值唯一能调的依据）
   * ④ 要发就把图读成 base64（`send()` 走 `base64://` 段）
   *
   * ── 为什么"读文件"也在这里 ─────────────────────────────────────────────
   * 库与磁盘可能不同步（人工删过图）。`decideSticker` 只能验"文件在不在"，
   * 读失败（权限/占用/损坏）只有在真读的时候才知道 —— 那时**也只记失败、不发**，
   * 绝不让它影响到正文。
   *
   * @returns {{ sticker: null|{rel:string,label:string,source:string,base64:string,mime:string,fp:string}, reason: string }}
   */
  /**
   * 词表坐标（`{workspace, dir}`）—— 表情包相关的每一次"读词表/校验标签"都要它。
   *
   * ★ 为什么单独抽一个方法：词表是**数据文件**（`stickers/labels.json`），
   *   用户在标注台新建一个标签后，桥接**每轮现读**就该认它（不用重启）。
   *   散落各处手写 `{workspace, dir: cfg.libraryDir}` 很容易漏掉一处，
   *   而漏掉的表现是"某个地方不认新标签"——那种 bug 极难查。
   */
  #stickerVocabOpts() {
    const cfg = this.config?.skills?.sticker ?? {}
    const workspace = this.config?.dsh?.workspace
    return workspace ? { workspace, dir: cfg.libraryDir } : null
  }

  #decideSticker({ chatKey, answer, requestedLabel = null, userText = '' }) {
    const cfg = this.config?.skills?.sticker ?? {}
    const workspace = this.config?.dsh?.workspace
    const chatId = String(chatKey ?? '')
    const turns = (this.#stickerTurns.get(chatId) ?? 0) + 1
    this.#stickerTurns.set(chatId, turns)
    const recent = this.#recentStickers.get(chatId) ?? []
    const recentLabels = []

    const skip = (reason) => {
      // ★ 日志与流水**都要留**：日志给人看当下，流水给控制台回溯"为什么这几天没发"。
      this.log(`[sticker] 不发：${reason}`)
      try {
        appendStickerDecision(
          { workspace, dir: cfg.libraryDir },
          toDecisionRecord(
            { action: 'skip', source: null, label: null, rel: null, score: 0, reasons: [], reason },
            { scope: chatId, replyText: answer, vocabOpts: this.#stickerVocabOpts() },
          ),
        )
      } catch {
        /* 流水写不上不影响回复 */
      }
      return { sticker: null, reason }
    }

    try {
      if (cfg.enabled === false) return skip('技能已关闭')
      if (!workspace) return skip('没有工作区，表情库无处可读')

      const selection = buildStickerSelection({
        workspace,
        dir: cfg.libraryDir,
        scope: chatId,
        maxSendBytes: cfg.maxSendBytes,
        allowRisky: cfg.allowRisky === true,
      })
      const candidates = selection.candidates
      // ★ 风险图拦下多少张也要说一次（与"超标图"同一个理由：静默过滤 =
      //   "库里明明有图却挑不中"变成查不出来的谜）。
      if (selection.skippedRisky > 0 && !this.#stickerWarned.has('risky')) {
        this.#stickerWarned.add('risky')
        this.log(
          `[sticker] ${selection.skippedRisky} 张标了「慎发」（脏话/擦边/血腥之类）**不参与选图**` +
            '—— 这是默认行为（`skills.sticker.allowRisky` 打开才允许发）。' +
            '想放行就去控制台把它打开，或把那些图从库里删掉',
        )
      }
      // ★ 如实报出"有多少张因为太大而不能发" —— 否则"库里 155 张却挑不中"
      //   会变成一个查不出来的谜（实测：用户的库里 115/155 张 >2MB）。
      if (selection.skippedOversize > 0 && !this.#stickerWarned.has('oversize')) {
        this.#stickerWarned.add('oversize')
        this.log(
          `[sticker] ${selection.skippedOversize}/${selection.total} 张因超过发送上限（${Math.round(selection.cap / 1024 / 1024)}MB）而不参与选图：` +
            `${selection.oversizeExamples.join('、')}… —— 大图发出去要几十秒且会进失败冷却；` +
            '想放宽改 skills.sticker.maxSendBytes，或把它们压小（GIF 压缩/抽帧）',
        )
      }
      const decision = decideSticker({
        config: cfg,
        replyText: answer,
        // ★ 对方这条消息：`otherCues` 匹配它（见 `#decideSticker` 的签名说明）
        userText,
        requestedLabel,
        candidates,
        usage: readStickerUsage({ workspace, dir: cfg.libraryDir }),
        vocabOpts: this.#stickerVocabOpts(), // ★ 词表是数据文件（可在标注台实时加标签）
        scope: chatId,
        turnCount: turns,
        recentRels: recent,
        recentLabels,
      })

      try {
        appendStickerDecision(
          { workspace, dir: cfg.libraryDir },
          toDecisionRecord(decision, { scope: chatId, replyText: answer, vocabOpts: this.#stickerVocabOpts() }),
        )
      } catch {
        /* 同上 */
      }

      if (decision.action !== 'send') {
        // ★★ 这里必须走 `skip()` 而不是"只 append 流水就 return"。
        //
        // 这是实测抓到的一处**承诺没兑现**：本函数的注释写着"日志与流水都要留"，
        // 但第一版只有异常路径调了 `skip()`，正常判定为"不发"时**只写了流水**——
        // 于是使用者盯着 `logs/bridge.log` 只会看到"它从来不发表情"，
        // 而原因（配额？阈值？抽不出态度？）只在不那么显眼的 decisions.jsonl 里。
        // 两条通道各有用途（日志看当下、流水可回溯），所以两条都写。
        // ⚠️ `skip()` 内部也会 append 一条，这里**不要**再 append（会双写）。
        return skip(decision.reason ?? '判定为不发')
      }
      // 命中记录里的 label 供"最近发过的标签"扣分（下一轮用）
      recentLabels.push(decision.label)

      let bytes
      try {
        bytes = nodeReadFileSync(decision.absPath)
      } catch (error) {
        return skip(`选中了 ${decision.rel} 但读不出来：${error?.message ?? error}`)
      }
      const base64 = bytes.toString('base64')
      return {
        sticker: {
          rel: decision.rel,
          label: decision.label,
          source: decision.source,
          base64,
          mime: String(decision.absPath).toLowerCase().endsWith('.gif') ? 'image/gif' : 'image/png',
          fp: stickerFingerprint(base64),
        },
        reason: decision.reason,
      }
    } catch (error) {
      // ★ 表情包是**附加**能力：它出任何错都不该影响正文回复
      return skip(`判定过程出错：${error?.message ?? error}`)
    }
  }

  /** 发出去之后记账（**只有真发成功才调**；与 SendQueue.markSent 同一纪律）。 */
  #noteStickerSent({ chatKey, sticker }) {
    if (!sticker) return
    const cfg = this.config?.skills?.sticker ?? {}
    const workspace = this.config?.dsh?.workspace
    const chatId = String(chatKey ?? '')
    const list = [...(this.#recentStickers.get(chatId) ?? []), sticker.rel]
    this.#recentStickers.set(chatId, list.slice(-Bridge.STICKER_RECENT_MAX))
    try {
      markStickerSent({ workspace, dir: cfg.libraryDir }, { rel: sticker.rel, scope: chatId })
      recordStickerSent({ workspace, dir: cfg.libraryDir, scope: chatId, rel: sticker.rel })
    } catch (error) {
      this.log(`⚠️ [sticker] 记账失败（图已经发出去了，只是计数不准）：${error?.message ?? error}`)
    }
  }

  /** 发失败：进冷却，并且**照样算消耗一次配额**（宁可少发，不要因失败多试）。 */
  #noteStickerFailed({ chatKey, sticker, why }) {
    if (!sticker) return
    const cfg = this.config?.skills?.sticker ?? {}
    const workspace = this.config?.dsh?.workspace
    const chatId = String(chatKey ?? '')
    this.log(`⚠️ [sticker] 表情包没能发出去（${why}）→ 进 5 分钟冷却；**不重试**（重试会让对端看到两张一样的图）`)
    try {
      markStickerFailed({ workspace, dir: cfg.libraryDir }, { rel: sticker.rel })
      recordStickerFailure({ workspace, dir: cfg.libraryDir, scope: chatId, rel: sticker.rel })
    } catch {
      /* 记账失败不影响主流程 */
    }
  }

  async #deliver(kind, peerId, answer, result, { replyTo = null, faceId = null, sticker = null, turnStartedAt = null } = {}) {
    // ── 分条（★ 两件事，顺序不能换）──────────────────────────────────────
    //   ① **按"观感"分条**（`splitReplyForSend`）：真人长回复是分几条发的，
    //      而模型用空行/换行分段就是在表达"这几句分开说"。
    //      ⚠️ 这一步 2026-10-01 才真正生效 —— 原先用的 `splitIntoMessages` 第一行就是
    //      `if (source.length <= maxChars) return [source]`，于是**短回复永远只有一条**，
    //      实测把三段共 101 字的话糊成一个气泡发出去（投递账本 `total=1`）。
    //   ② 再按 QQ 单条上限兜底硬切（`splitForQQ`，那是尺寸约束，不是观感）。
    const humanChunks = splitReplyForSend(answer, {
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

    // ── ★★ 回应速度档位：它是「下限」不是「附加」（2026-09-30 语义修正）──────
    //
    // 老实现把档位延迟**加在**本轮已经花掉的时间之上：模型想了 15 秒、均衡档
    // 再等 8 秒 ⇒ 使用者实际等了 23 秒，而界面与 `humanize.speed` 的文案写的是
    // "约 5~9 秒"。**功能描述与真实体验对不上**，就是这个问题的根因。
    //
    // 现在的口径（与 `computeReplyDelay` 的注释逐字对应）：
    //   · 已用 < 档位目标 → 只补到档位目标（秒回观感消失，总时长≈档位）
    //   · 已用 ≥ 档位目标 → **不再叠加，立刻发**（慢是因为模型真的在干活）
    //
    // `turnStartedAt` 缺失时退回老语义（纯计算用法/测试构造的 Bridge）——
    // 生产路径不会缺：`#runTurn` 在回合一开始就取好了往下传。
    const elapsedMs =
      typeof turnStartedAt === 'number' && Number.isFinite(turnStartedAt)
        ? Math.max(0, Date.now() - turnStartedAt)
        : undefined
    const { delayMs, reason, plannedMs } = computeReplyDelay({
      textLength: answer.length,
      humanize: this.config.humanize,
      ...(elapsedMs === undefined ? {} : { elapsedMs }),
    })
    // 档位/静默时段的人话名字 —— 日志里出现 `human-like` 这种内部值等于没说
    const reasonText = reason === 'quiet-hours' ? '静默时段' : '回应速度档位'
    if (delayMs > 0) {
      const target = typeof plannedMs === 'number' ? Math.round(plannedMs / 1000) : null
      this.log(
        typeof elapsedMs === 'number' && target !== null
          ? `[bridge] ${reasonText}：本轮已用 ${Math.round(elapsedMs / 1000)} 秒，` +
              `补到档位目标 ${target} 秒 → 再等 ${Math.round(delayMs / 1000)} 秒后发` +
              `（回复 ${answer.length} 字）`
          : `[bridge] 拟人延迟 ${Math.round(delayMs / 1000)} 秒后再发` +
              `（原因：${reason}，回复 ${answer.length} 字）`,
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
    } else if (typeof elapsedMs === 'number' && typeof plannedMs === 'number' && plannedMs > 0) {
      // ── 已用时间已经达到/超过档位目标：**不再叠加，立刻发** ──────────────
      //
      // ★ 这一条必须留日志。它是"档位为什么没生效"的**唯一可查证据** ——
      //   使用者看到"我选了谨慎档怎么秒回"时，日志里要有
      //   "本轮已用 12 秒 ≥ 目标 20 秒"这样一句，否则只能靠猜。
      //   注意措辞是"本轮已用"，不是"忽略档位"：档位并没有被忽略，
      //   它只是**已经靠模型自己的耗时满足了**。
      this.log(
        `[bridge] ${reasonText}：本轮实际已用 ${Math.round(elapsedMs / 1000)} 秒 ≥ ` +
          `目标 ${Math.round(plannedMs / 1000)} 秒 → 不再叠加延迟，立即发送（回复 ${answer.length} 字）`,
      )
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

    // ── 表情包（0.2.4）：只有表情、没有正文时的独立一条 ──────────────────
    //
    // 与上面那条 face 分支同一个道理（那正是表情的典型用法），区别只是发的是
    // 一张**图**而不是内置脸。★ 它单独 try/catch：**失败只记账并发冷却，
    // 不抛出去** —— 抛出去会让整个回合被计成"发送失败"，然后对端会再收到一条
    // "我这边没能把回复发出去"，可它明明什么都没丢（这条本来就只有表情）。
    if (chunks.length === 0 && sticker) {
      const key = deliveryKey({ chatKey: `${kind}:${peerId}`, text: '', sticker: sticker.fp })
      const verdict = this.sendQueue.check(`[sticker:${sticker.fp}]`, key)
      if (verdict.ok) {
        if (verdict.waitMs > 0) await this.#sleepUnlessClosing(verdict.waitMs)
        try {
          await this.onebot.send(kind, peerId, '', { replyTo, stickerBase64: sticker.base64 })
          this.sendQueue.markSent(`[sticker:${sticker.fp}]`, key)
          this.#noteStickerSent({ chatKey: `${kind}:${peerId}`, sticker })
          this.#mirror(`${kind}:${peerId}`, 'bot', `[表情包 ${sticker.label}]`, { createIfMissing: false })
          this.log(`[sticker] 已发（只有表情、无正文）：${sticker.rel}（${sticker.source}）`)
        } catch (error) {
          this.#noteStickerFailed({ chatKey: `${kind}:${peerId}`, sticker, why: error?.message ?? error })
        }
      } else {
        this.log(`[bridge] 跳过发送表情包：${verdict.reason}`)
      }
    }

    for (const [i, chunk] of chunks.entries()) {
      const isFirst = i === 0
      const isLast = i === chunks.length - 1
      const withSticker = Boolean(isLast && sticker)
      // ★ H9：去重键带上**会话**（以及引用/表情）。用裸文本当键时，
      //   「同一句话在 8 秒内发给两个不同的会话」会被误判成重复而丢掉第二个 ——
      //   而 SendQueue 是**整个桥接共用一个**的。
      const key = deliveryKey({
        chatKey: `${kind}:${peerId}`,
        text: chunk,
        replyTo: isFirst ? replyTo : null,
        faceId: isLast ? faceId : null,
        sticker: withSticker ? sticker.fp : null,
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

      let stickerOk = false
      try {
        // ★★ 发送结果**必须接住**：`message_id` 就在 `data` 里（OneBot 11 的形状），
        //   它是"自己说过的话也能被检索、被引用"的唯一来源。
        //   ⚠️ 这里曾经是 `await this.onebot.send(...)` 直接丢弃返回值，注释还写着
        //   "协议端返回的 message_id 我们目前没接" —— 后果有两个，都是静默的：
        //     ① 语料库里自己的消息 `message_id` 全是 null ⇒ 检索到自己说的话时
        //        渲染成 `[mid:?]`，模型**引用不了**（`[reply:?]` 会被校验丢掉）；
        //     ② 无法判断"某条消息是不是在回复机器人"（这一层将来要做判断时会用到）。
        let sendResult = null
        if (withSticker) {
          // ★★ 正文与表情包**分开发**（不是把两样塞进一个请求）：
          //   为什么：表情包是附加物，它失败绝不能连累正文（见下面 catch）。
          //   代价：多一次消息 —— 正好也是 QQ 里"说完一句，再补个表情"的真实形态。
          sendResult = await this.onebot.send(kind, peerId, chunk, {
            replyTo: isFirst ? replyTo : null,
            faceId: null,
          })
          stickerOk = true
        } else {
          sendResult = await this.onebot.send(kind, peerId, chunk, {
            replyTo: isFirst ? replyTo : null,
            faceId: isLast ? faceId : null,
          })
        }
        this.sendQueue.markSent(chunk, key)
        // ★ H15：这一片确认发出去了 —— 账本上标掉（崩溃时留下的 pending 就是没标上的那些）
        ticket?.markSent(i)
        // 真正发出去的才记进镜像（节流跳过的那些不算"说过的话"）
        this.#mirror(`${kind}:${peerId}`, 'bot', chunk, { createIfMissing: false })
        // ★ H7：自己说过的话也要进语料库（"我上次说的那个方案"要搜得到）。
        //   ★ 2026-09-30 起**带上协议端返回的 message_id**（见上面那段注释）；
        //     拿不到时留 null —— UNIQUE 允许 NULL 重复（SQLite 语义），不会互相顶掉。
        this.#recordCorpus({
          kind,
          peerId,
          // ★ 只有真拿到 id 时才用：`data` 缺失（桩、被节流跳过、协议端没回）时留 null，
          //   不要编一个（编出来的 id 会让 `[reply:]` 指向一条不存在的消息）。
          messageId: sendResult?.data?.message_id ?? null,
          text: chunk,
          isBot: true,
          replyToId: replyTo,
        })
      } catch (error) {
        this.log(`[bridge] 发送失败：${error.message}`)
        // ★ H15：这一轮明确失败了（与"崩溃留下的 pending"是两回事，要能分开看）
        ticket?.fail(error.message)
        throw error
      }

      // ── 表情包：**正文已经发成功了**，现在补那张图 ──────────────────────
      //
      // ★★ 为什么放在正文的 try/catch **之外**（这是这段最容易写错的地方）：
      //   表情包是附加物。把两步放在同一个 try 里时，"正文成功 + 图失败"
      //   会走 catch → 抛出 → 整轮被计成发送失败 → 还会再给对端发一条
      //   "我这边没能把回复发出去"。可对方明明收到了正文，只有图没到。
      //   那是**假警报**，比图没到更糟（它会让使用者去查一个不存在的问题）。
      if (withSticker && stickerOk) {
        try {
          await this.onebot.send(kind, peerId, '', { stickerBase64: sticker.base64 })
          this.#noteStickerSent({ chatKey: `${kind}:${peerId}`, sticker })
          this.#mirror(`${kind}:${peerId}`, 'bot', `[表情包 ${sticker.label}]`, { createIfMissing: false })
          this.log(`[sticker] 已发：${sticker.rel}（${sticker.source}）`)
        } catch (error) {
          this.#noteStickerFailed({ chatKey: `${kind}:${peerId}`, sticker, why: error?.message ?? error })
        }
      }
    }

    ticket?.finish()

    this.log(
      `[bridge] 已回复 ${kind}:${peerId}（${answer.length} 字，${chunks.length} 条，` +
        `思考+工具 ${result.durationMs}ms，工具 ${result.toolCalls.length} 次，` +
        // ★ 措辞跟着语义改过（2026-09-30）：`delayMs` 现在是"**额外**等了多久"，
        //   不是"档位目标"。写成"拟人延迟"会让排查的人以为档位没生效
        //   （明明打印 0s，实际它只是被回合自身的耗时满足了）。
        `档位目标 ${typeof plannedMs === 'number' ? Math.round(plannedMs / 1000) : '—'}s、` +
        `额外等待 ${Math.round(delayMs / 1000)}s` +
        `${replyTo ? `，引用 #${replyTo}` : ''}${faceId ? `，表情 ${faceId}` : ''}` +
        `${sticker ? `，表情包 ${sticker.label}` : ''}）`,
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
