/**
 * 桥接本地配置接口的客户端。
 * 接口约定见 packages/qq-bridge/CONFIG-UI.md 第 5 节：
 * 所有响应都是 { ok: true, data } 或 { ok: false, error, fatal? }。
 * 开发环境通过 Vite 代理 /api → http://127.0.0.1:3410。
 */

export interface ApiStatus {
  running: boolean
  startedAt?: string
  uptimeMs?: number
  login?: { userId: string; nickname: string } | null
  connected?: boolean
  dshAlive?: boolean
  adminUsers?: string[]
  permissionMode?: string
  workspace?: string
  groupEnabled?: boolean
  /** 进程登记（缺陷 3）：让界面能回答"是不是还有别的桥接在跑"。 */
  processes?: {
    selfPid?: number
    total?: number
    running?: number
    /** 与本进程**同类**且仍在运行的其它进程 —— 非空就意味着"两个桥接在抢同一个事件流"。 */
    conflicts?: { pid: number; state: string; reason?: string }[]
  }
  stats?: {
    received: number
    triggered: number
    answered: number
    skipped: number
    denied: number
    failed: number
  }
  /**
   * 界面构建溯源（CONFIG-UI.md「界面产物与源码是不是同一份」）。
   * fresh = 与当前源码一致；stale = 源码改了没重新构建；unstamped = 没有标记、无法自证来源。
   * ★ 不是 fresh 时界面必须明确提示"你看到的是旧界面"并给出 advice ——
   *   使用者拿着旧界面报 bug，排查会从完全错误的前提出发。
   */
  ui?: {
    status: 'fresh' | 'stale' | 'unstamped' | string
    distDir?: string
    stamp?: { name?: string; pkgVersion?: string; builtAt?: string; sourceHash?: string } | null
    expectedHash?: string
    why?: string
    advice?: string
  }
}

export interface DoctorRow {
  name: string
  ok: boolean
  level?: 'fatal' | 'warn' | 'ok'
  detail?: string
  [key: string]: unknown
}

export interface DoctorResult {
  fatal: string[]
  warn: string[]
  rows: DoctorRow[]
}

export interface CheckResult {
  fatal: string[]
  warn: string[]
}

// ── 会话同步（CONFIG-UI.md §2.8）─────────────────────────────────────────

export interface ConvMessage {
  role: 'user' | 'bot' | 'notice' | 'thinking'
  text: string
  at: number
  /**
   * 消息里的图片（CONFIG-UI.md §2.9）。
   * 只在 user 消息、且这条真的会触发回复时才出现（防 DoS）。
   * ok:false 也要显示占位 + reason，不能静默丢。
   */
  images?: ConvImage[]
  /**
   * 发言人身份（CONFIG-UI.md §2.8 ④）：
   * 由桥接**从协议端核实**后写在每条 user 消息上。
   *
   * ⚠️ 群聊里一个会话有多个发言人，所以身份必须**逐条消息**带，
   * 不能只记在会话上 —— 否则会出现"用最后一个人的名字标前面所有人的话"。
   *
   * ⚠️ 这里显示的是**他是谁**，不是**他能做什么**：`senderRole` 是 QQ 群内角色
   * （群主/群管理/群成员），与桥接的权限判定（配置里的 adminUsers）无关。
   * 核实失败时这几个字段**不存在**，界面只显示号码，不编名字。
   */
  senderId?: string
  senderName?: string
  senderRole?: string
}

export type ConvImage =
  | { ok: true; path: string; mediaType: string; bytes: number }
  | { ok: false; reason: string }

/** 某个发言人的身份（按 QQ 号索引，同一会话里可能有多人）。 */
export interface ConvSender {
  name: string
  roleLabel: string
  /** 是否真的从协议端核实到了（false = 只知号码，界面不该编名字）。 */
  verified: boolean
  at: number
}

export interface Conversation {
  chatKey: string
  kind: 'private' | 'group' | string
  peerId: string
  status: string
  updatedAt: number
  messageCount: number
  /**
   * 会话名：私聊是对方昵称、群聊是**群名**（CONFIG-UI.md §2.9）。
   *
   * ⚠️ 它来自协议端核实（`get_group_list` / `get_friend_list`），**不是猜的**。
   * 核实不到时它是空串且 `nameVerified` 为 false ——
   * 这时界面**必须显示号码**，不要拿 peerId 以外的东西顶替（那会显示成一个
   * 群里根本没人用的名字）。
   */
  name?: string
  /** 上面那个名字是不是协议端核实过的（false = 只知号码）。 */
  nameVerified?: boolean
  messages: ConvMessage[]
  /** 这个会话里出现过的发言人身份（QQ 号 → 身份）。 */
  senders?: Record<string, ConvSender>
}

export interface ConversationsResult {
  conversations: Conversation[]
  count: number
  note?: string
}

// ── 用量与成本（CONFIG-UI.md §5.2，待实现，按 501 容错）────────────────────

export interface UsageTokens {
  input: number
  cacheRead: number
  cacheWrite?: number | null
  output: number
  reasoning?: number | null
}

export interface UsageTotals {
  turns: number
  tokens: UsageTokens
  cacheHitRate: number | null
  lastContextTokens?: number | null
}

export interface UsageResult {
  range: { days: number; from?: string; to?: string }
  totals: UsageTotals
  cost: { available: boolean; amount: number | null; currency?: string; basis?: string }
  byDay: {
    date: string
    turns: number
    tokens: UsageTokens
    cacheHitRate: number | null
    cost: number | null
  }[]
  bySession: {
    chatKey: string
    kind: 'private' | 'group' | string
    label: string
    turns: number
    tokens: UsageTokens
    cacheHitRate: number | null
    cost: number | null
  }[]
}

export interface PeakRule {
  timezone?: string
  windows?: { start: string; end: string }[]
  days?: number[]
  holidays?: string[]
}

export interface UsagePrices {
  source?: string
  updatedAt?: string
  loaded: boolean
  peak?: PeakRule
  /** 桥接自己算的时段判定——指示灯不用它（见 §2.1.1），仅排查时钟用 */
  now?: Record<string, unknown>
  routes?: Record<string, unknown>
  warning?: string
}

// ── 记忆文件（CONFIG-UI.md §5.3，待实现，按 501 容错）──────────────────────

export interface MemoryEntry {
  path: string
  type: 'file' | 'dir'
  size?: number
  mtime?: string
  children?: MemoryEntry[]
}

export interface MemoryTree {
  workspace: string
  enabled: boolean
  entries: MemoryEntry[]
  totalBytes: number
  note?: string
}

export interface MemoryFile {
  path: string
  content: string
  size: number
  mtime: string
  sha256: string
}

export interface MemoryConflict {
  conflict: true
  currentSha256?: string
  currentContent?: string
}

// ── 0.2.9「整理记忆」（原名"立刻建档"）的类型（字段与后端一一对应，见 CONFIG-UI.md §2.5.2 / §5）──

export interface BuildMemoryArgs {
  kind: 'group' | 'private'
  peerId: string
  /** 可选：只建档某个人在某个群里的发言（独立游标） */
  userId?: string | null
  /** 默认 true = 预演（不调模型、不写盘）；显式 false 才真跑 */
  dryRun?: boolean
  limit?: number
}

export interface BuildMemoryApplied {
  scope: string
  /** 写进了哪一份（工作区相对路径） */
  rel?: string
  /** person 档：记在谁名下 */
  userId?: string
  text?: string
  [key: string]: unknown
}

export interface BuildMemoryIgnored {
  scope?: string
  who?: string
  entry?: string
  /** 被拒的原因（身份权限 / 像在下指令 / 对不在场的人的负面评价 / 隐私 / 发言人对不上号） */
  why?: string
  [key: string]: unknown
}

export interface BuildMemoryResult {
  ok: boolean
  chatKey: string
  userId?: string | null
  cursorBefore?: string | number | null
  cursorAfter?: string | number | null
  /** 这次处理几条；超过一次上限（60 条）的进 skipped */
  considered: number
  skipped: number
  /** ok:false 的原因（业务失败不是 5xx）；个人档"没有新消息"时 ok:true 也带 why */
  why?: string
  /** 预演响应带：会原样发给模型的提示词（含对话原文） */
  prompt?: string
  speakers?: { index: number; userId: string; name?: string }[]
  note?: string
  /** 采纳的条目（每条有 scope / rel / userId） */
  applied: BuildMemoryApplied[]
  /** 被内容闸门拒的（带 why）——必须显示，不许美化掉失败 */
  ignored: BuildMemoryIgnored[]
  wroteFiles?: string[]
  /** 失败时的原文片段（排查用） */
  raw?: string | null
  ms?: number | null
}

// ── SnowLuma 进程（CONFIG-UI.md §2.7.1 / §5.1，待实现，按 501 容错）────────

export type SnowlumaStatus =
  | 'not-configured'
  | 'bridge-offline'
  | 'offline'
  | 'up-not-logged-in'
  | 'auth-failed'
  | 'connected'

export interface SnowlumaDetect {
  status: SnowlumaStatus
  httpReachable?: boolean
  wsConnected?: boolean
  loggedIn?: boolean
  login?: { userId: string; nickname: string } | null
  endpoint?: { httpUrl?: string; wsUrl?: string }
  consoleUrl?: string
  /**
   * 控制台可达性（§2.7.0）：只在 3000 连不上时才探。
   * null/undefined = 没探过；true = 控制台通但 OneBot 不通 = 「在跑但没钩住 QQ」。
   */
  consoleReachable?: boolean | null
  /** token 实际来自哪里（SnowLuma 自己的配置 / config.json） */
  tokenSource?: string
  /** 两处 token 不一致时为 true：config.json 里那份是过期的，别用它 */
  tokenDiffersFromConfig?: boolean
  launch?: { configured: boolean; cmd?: string; cwd?: string; from?: string }
  hint?: string
}

/** POST /api/snowluma/start 现在的语义：用系统默认浏览器打开 SnowLuma 网页端。 */
export interface SnowlumaOpenResult {
  opened: boolean
  consoleUrl: string
  /** 「浏览器打开了」≠「SnowLuma 在跑」：false 时 hint 必须显示出来 */
  reachable: boolean
  hint?: string
}

// ── SnowLuma 终端输出（CONFIG-UI.md §2.7.3，读日志文件而非 stdout）─────────

export interface SnowlumaLogLine {
  time: string | null
  level: 'ERROR' | 'WARN' | 'OK' | 'DEBUG' | string | null
  rest: string | null
  /** 完整原文，永远有值；渲染用它最省事 */
  text: string
}

export interface SnowlumaLog {
  available: boolean
  note?: string
  file?: string
  date?: string
  dir?: string
  lines: SnowlumaLogLine[]
  /** 下次轮询回传这个值 */
  offset: number
  /** 文件换过了（按天轮转）→ 界面必须清空面板再显示 */
  rotated: boolean
  /** 本次只取了尾部一块，上面还有更早的日志 */
  truncated: boolean
  /** 因 includeDebug=0 被滤掉的行数 */
  droppedDebug?: number
  totalBytes?: number
}

// ── 名单与权限（CONFIG-UI.md §2.7.4）───────────────────────────────────────

export interface Roster {
  friends: { userId: string; nickname: string }[]
  groups: { groupId: string; name: string }[]
  /** 配置里但在真实名单里找不到的号码（多半是打错了） */
  unknownAdmins: string[]
  unknownDmUsers: string[]
  unknownGroups: string[]
  /** false = 名单压根没拉到（协议端不在），此时不要显示"找不到号码" */
  friendsKnown: boolean
  groupsKnown: boolean
  cached?: boolean
  warnings: string[]
}

export class ApiError extends Error {
  fatal?: string[]
  /** HTTP 状态码（409 冲突 / 501 待实现等分支要靠它区分） */
  status?: number
  /** 失败响应里的其余字段（如 409 的 conflict/currentContent） */
  payload?: Record<string, unknown>
  constructor(message: string, opts?: { fatal?: string[]; status?: number; payload?: Record<string, unknown> }) {
    super(message)
    this.fatal = opts?.fatal
    this.status = opts?.status
    this.payload = opts?.payload
  }
}

/** 判断错误是不是「后端还没实现这个接口」（501 pending，或未打桩的 404「没有这个接口」）。 */
export function isNotImplemented(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false
  if (e.payload?.pending === true) return true
  if (e.status === 501) return true
  if (e.status === 404 && (e.message.includes('没有这个接口') || e.message.includes('尚未实现'))) return true
  return false
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    })
  } catch {
    throw new ApiError('连不上桥接的配置接口（http://127.0.0.1:3410）。机器人没启动时接口也不在线。')
  }
  let json: { ok?: boolean; data?: T; error?: string; fatal?: string[] } & Record<string, unknown>
  try {
    json = await res.json()
  } catch {
    throw new ApiError(`接口返回的不是 JSON（HTTP ${res.status}）`, { status: res.status })
  }
  if (!json.ok) {
    const { ok: _ok, error, fatal, ...rest } = json
    throw new ApiError(error ?? `请求失败（HTTP ${res.status}）`, {
      fatal,
      status: res.status,
      payload: rest,
    })
  }
  return json.data as T
}

export const api = {
  status: () => request<ApiStatus>('GET', '/api/status'),
  getConfig: () => request<Record<string, unknown>>('GET', '/api/config'),
  saveConfig: (patch: Record<string, unknown>) =>
    request<{ saved: boolean; restartRequired: boolean; hint: string }>('POST', '/api/config', patch),
  check: (cfg?: Record<string, unknown>) => request<CheckResult>('POST', '/api/check', cfg),
  doctor: () => request<DoctorResult>('POST', '/api/doctor'),
  stop: () => request<{ stopping: boolean; hint: string }>('POST', '/api/stop'),
  restart: () => request<{ restarting: boolean; hint: string }>('POST', '/api/restart'),
  conversations: () => request<ConversationsResult>('GET', '/api/conversations'),
  usage: (days: number) => request<UsageResult>('GET', `/api/usage?days=${days}`),
  usagePrices: () => request<UsagePrices>('GET', '/api/usage/prices'),
  memoryTree: () => request<MemoryTree>('GET', '/api/memory/tree'),
  memoryRead: (path: string) => request<MemoryFile>('GET', `/api/memory/file?path=${encodeURIComponent(path)}`),
  memoryWrite: (args: { path: string; content: string; expectedSha256?: string }) =>
    request<{
      saved: boolean
      sha256: string
      mtime?: string
      restartRequired: boolean
      overwroteWithoutCheck?: boolean
      /** 0.2.9：覆盖已有文件时，被覆盖的那一版备份到哪（新建没有）；由后端给，前端不写死 */
      backup?: string
      /** 备份失败不阻断写入，但要如实说（§5.2.1） */
      backupError?: string
    }>('POST', '/api/memory/file', args),
  /**
   * 0.2.9「整理记忆」（§2.5.2）：把游标之后还没计入记忆的消息交给抽取模型整理成条目。
   * ★ dryRun 默认 true（只回"会发给模型的提示词 + 涉及几条"，不调模型、不写盘）；
   *   只有显式 false 才真跑。业务失败回 200 + ok:false + why（游标不前进）。
   */
  memoryBuild: (args: BuildMemoryArgs) => request<BuildMemoryResult>('POST', '/api/memory/build', args),
  snowlumaDetect: () => request<SnowlumaDetect>('GET', '/api/snowluma/detect'),
  // ⚠️ 0.2.2 前的旧人设接口（GET /api/persona、POST /api/persona/names）已换代：
  // 后端回 410 Gone。新人设库走下面的 api.personas / api.personaAction。
  /** 打开 SnowLuma 网页端（不是启动进程；启动已移交 start.bat）。 */
  snowlumaStart: () => request<SnowlumaOpenResult>('POST', '/api/snowluma/start'),
  snowlumaLog: (q: { lines?: number; offset?: number; includeDebug?: boolean }) => {
    const p = new URLSearchParams()
    if (q.lines !== undefined) p.set('lines', String(q.lines))
    if (q.offset !== undefined) p.set('offset', String(q.offset))
    p.set('includeDebug', q.includeDebug === false ? '0' : '1')
    return request<SnowlumaLog>('GET', `/api/snowluma/log?${p}`)
  },
  roster: (refresh = false) => request<Roster>('GET', `/api/roster${refresh ? '?refresh=1' : ''}`),
  /** 现在的 inbox（记忆页签「看图」卡片的小状态卡；目录不存在时返回 count:0）。 */
  inbox: () => request<InboxState>('GET', '/api/inbox'),
  /** 删除记忆文件（§2.5 界面要求；接口文档暂未列，按 404/501 容错）。 */
  memoryDelete: (path: string) =>
    request<{ deleted: boolean }>('DELETE', `/api/memory/file?path=${encodeURIComponent(path)}`),

  // ── H13：四项（规格见 CONFIG-UI.md §5.x）────────────────────────────────
  /** 启动前置条件门控。★ 它会**真的去问一次协议端**，所以慢 1~2 秒，要有 loading 态。 */
  preflight: () => request<Preflight>('GET', '/api/preflight'),
  /** 协议端账号**摘要**（永远没有 token —— 后端做了字段白名单，别设计"显示 token"的功能）。 */
  snowlumaAccounts: () => request<AccountsResult>('GET', '/api/snowluma/accounts'),
  /** 桥接日志增量：带上上次的 cursor 只取新增的行。 */
  logStream: (q: { since?: number; limit?: number } = {}) => {
    const p = new URLSearchParams()
    if (q.since !== undefined) p.set('since', String(q.since))
    if (q.limit !== undefined) p.set('limit', String(q.limit))
    const qs = p.toString()
    return request<LogChunk>('GET', `/api/logs/stream${qs ? `?${qs}` : ''}`)
  },
  /** 本地语料检索。★★ **必须带会话**（缺了会 400 —— 那是故意的 fail-closed，不跨会话）。 */
  corpusSearch: (q: { q: string; kind: 'private' | 'group'; peerId: string; limit?: number }) => {
    const p = new URLSearchParams({ q: q.q, kind: q.kind, peerId: q.peerId })
    if (q.limit !== undefined) p.set('limit', String(q.limit))
    return request<CorpusResult>('GET', `/api/corpus/search?${p}`)
  },
  /** 记忆条目检索（只读）。★ 与语料检索不同：记忆是"沉淀的事实"，语料是"说过的话"。 */
  memorySearch: (q: string, limit?: number) => {
    const p = new URLSearchParams({ q })
    if (limit !== undefined) p.set('limit', String(limit))
    return request<MemorySearchResult>('GET', `/api/memory/search?${p}`)
  },

  // ── 0.2.1 记忆观测面（CONFIG-UI.md §2.5，全部只读）────────────────────────
  /** 记忆写入统计 + 零写入告警。阈值是后端常量（不是配置项），界面只展示。 */
  memoryStats: () => request<MemoryStatsResult>('GET', '/api/memory/stats'),
  /** 隐私拦截审计。★ 只有时间/侧/类别/字数 —— 审计里本来就没有原文，别想办法展示。 */
  memoryPrivacy: (limit?: number) =>
    request<PrivacyAuditResult>('GET', `/api/memory/privacy${limit ? `?limit=${limit}` : ''}`),
  /** 扫描盘上记忆里的隐私条目（只读）。★ 只回位置（文件+行号+类别），不回原文。 */
  memoryPrivacyScan: () => request<PrivacyScanResult>('POST', '/api/memory/privacy/scan'),

  // ── 0.2.2 人设库（CONFIG-UI.md §2.2）────────────────────────────────────
  /** 人设栏要的全部事实（列表/当前生效/回落/模板/上限），一律由后端给 —— 前端硬编码就是第二份真值。 */
  personas: () => request<PersonaShelf>('GET', '/api/personas'),
  /** 人设库动作。响应里带 `shelf`（新状态一次往返带回，不用再 GET）。 */
  personaAction: (body: PersonaActionBody) => request<PersonaActionResult>('POST', '/api/personas', body),

  // ── 0.2.2 扩展页（CONFIG-UI.md §2.10）───────────────────────────────────
  /** 技能 + 插件 + 状态。★ 它会做文件系统扫描 —— 不要跟着主轮询拉，进页签拉一次即可。 */
  extensions: () => request<ExtensionsResult>('GET', '/api/extensions'),
  /** 扩展开关。★ 生效方式以后端回的 `restartRequired` 为准，前端不许写死。 */
  extensionToggle: (body: { type: 'skill' | 'plugin'; id: string; enabled: boolean }) =>
    request<ExtensionToggleResult>('POST', '/api/extensions/toggle', body),
  /** 技能设置（密文留空 = 不修改；清除 = 提交 null）。★ 保存后**立即生效**，别抄成"需要重启"。 */
  extensionSettings: (body: { id: string; patch: Record<string, unknown> }) =>
    request<{ saved?: boolean; restartRequired?: boolean; hint?: string }>(
      'POST',
      '/api/extensions/settings',
      body,
    ),
  /** 技能自检（最容易的坏法是"静默拿不到数据"）。 */
  extensionDiagnose: (id: string) =>
    request<Record<string, unknown>>(`GET`, `/api/extensions/diagnose?id=${encodeURIComponent(id)}`),

  // ── 0.2.4 表情包：重新打标签（CONFIG-UI.md §2.10）────────────────────────
  /**
   * 重新打标签的**进度与预检**（同一个 GET）。
   *
   * ★ 它为什么是"查询式"而不是一个把活干完的请求：打标签**每张一次模型调用**，
   *   几十张就是几分钟 —— 浏览器/代理不会挂着等那么久。
   * ★ `todo`（将要处理多少张）就是**预检结果**：界面必须先拿它做二次确认，
   *   否则用户点一下就是几十次调用，他既不知道花多少、也不知道有几张会被跳过。
   */
  stickerRetag: () => request<StickerRetagStatus>('GET', '/api/extensions/sticker-retag'),
  /** 发起 / 停止。发起立刻返回 jobId，进度靠反复 GET 上面那个。 */
  stickerRetagAction: (action: 'start' | 'abort', force?: boolean) =>
    request<StickerRetagStatus & { error?: string }>('POST', '/api/extensions/sticker-retag', { action, force }),

  // ── 0.2.2 联系人昵称（CONFIG-UI.md §2.5「昵称（按人）」）───────────────────
  /** 整表 + 上限 + 认不出来的行（bad 要显示出来，别静默丢）。 */
  contacts: () => request<ContactsResult>('GET', '/api/contacts'),
  /** 增改；★ nickname 空串 = 删除这个号码。改了下一轮就生效（restartRequired:false）。 */
  contactSave: (qq: string, nickname: string) =>
    request<ContactSaveResult>('POST', '/api/contacts', { qq, nickname }),
}

// ── 0.2.2 联系人昵称的类型（格式只有后端一处实现，界面不拼文件文本）──────────

export interface ContactEntry {
  qq: string
  nickname: string
}

export interface ContactsResult {
  rel: string
  exists: boolean
  count: number
  max: number
  maxChars: number
  contacts: ContactEntry[]
  /** 文件里认不出来的行 —— 界面要显示出来，别静默丢 */
  bad: string[]
}

export interface ContactSaveResult {
  saved: boolean
  restartRequired?: boolean
  contacts?: ContactEntry[]
  count?: number
  [key: string]: unknown
}

// ── 0.2.2 人设库的类型（字段与后端一一对应，见 CONFIG-UI.md §2.2/§5）────────

export interface PersonaItem {
  name: string
  chars: number
  mtime?: number
  active: boolean
  /** 出厂默认两套固定在前（顺序照后端，前端不重排） */
  isDefault: boolean
  /** false = 没有名字块 → 叫名字会回落到兜底名（静默失效高发处，必须警告） */
  hasNameBlock: boolean
  /** true = 启动时会被整文件拒载（反注入扫描命中）—— 必须标红 */
  blocked: boolean
  text: string
}

export interface PersonaShelf {
  dir: string
  /** 配置里 persona.active 的原值（空串 = 走老路径） */
  active: string
  /** 'file' | 'legacy-custom' | 'legacy-preset' | 'none' */
  activeSource: string
  activeName: string
  activeChars: number
  /** 非空 = persona.active 指的那一套找不到（被删/改名），当前按不使用人设在跑 —— 红色说明 */
  activeError: string
  /** ★★ true = 当前这套会被整文件拒载，实际注入的是占位文本 —— 必须红字 */
  activeBlocked: boolean
  activeBlockReasons: string[]
  /** 非 null = 配置还是 0.2.2 之前的老写法，列表里那几套都没在用 */
  legacy: { preset: string; customChars: number } | null
  maxChars: number
  /** 新建人设的默认正文（自带名字块骨架） */
  template: string
  personas: PersonaItem[]
}

export interface PersonaActionBody {
  action: 'create' | 'save' | 'rename' | 'delete' | 'activate' | 'restore-defaults'
  name?: string
  to?: string
  text?: string
  copyFrom?: string
}

export interface PersonaActionResult {
  ok?: boolean
  changed?: boolean
  /** ★ 生效方式以后端这个字段为准（人设构造期缓存，切换/改正在用的要重启） */
  restartRequired?: boolean
  hint?: string
  /** 一次往返带回的新状态 */
  shelf?: PersonaShelf
  [key: string]: unknown
}

// ── 0.2.2 扩展页的类型（字段与后端一一对应，见 CONFIG-UI.md §2.10）──────────

export interface SkillSchemaField {
  type: 'boolean' | 'string' | 'number' | 'integer' | 'enum' | string
  label?: string
  description?: string
  /** 密文：密码框、不回显、留空 = 不修改、清除要二次确认（提交 null） */
  secret?: boolean
  placeholder?: string
  values?: string[]
  min?: number
  max?: number
  step?: number
}

export interface SkillTool {
  id: string
  /** ★ 模型真正看到的名字 —— 排障时可直接复制去搜日志，不许"美化"掉前缀 */
  fullName: string
  name: string
  description?: string
  permission?: string
  registered?: boolean
}

export interface SkillInfo {
  id: string
  dirName: string
  name: string
  version: string
  apiVersion?: number
  description: string
  category?: string
  icon?: string
  author?: string
  dir?: string
  enabled: boolean
  enabledSource?: string
  ready: boolean
  reasons: string[]
  available: { ok: boolean; reason?: string }
  /** 装是装了但用不了时，原因摊开在这里 */
  errors: string[]
  /** ★ 必须显示：设置项没界面、清单里带明文密钥…… 这些都不报错，只会静默失效 */
  warnings: string[]
  settings: Record<string, unknown>
  schema: Record<string, SkillSchemaField>
  secretFields?: string[]
  /** 密文字段「已配置/未配置」（GET 不回值，只回这个） */
  secretSet: Record<string, boolean>
  tools: SkillTool[]
  /**
   * 清单 `tools[]` 里**声明**了几个工具（与 `tools` 的"实际注册"分开）。
   * ★ 别拿 `tools.length === 0` 当成"忘了接线"：像「表情包」这种技能**刻意不要工具**
   *   （靠提示词约定 + 宿主判定工作）。判据必须是"**声明了却没注册**"，
   *   否则每次巡检都会打一条假告警 —— 而假告警用久了就没人看了。
   */
  declaredToolCount?: number
  promptSections: { preview: string; chars: number }[]
  permissions?: { net?: string[]; listen?: string | string[] | boolean }
}

export interface PluginChoiceOption {
  value: string
  label: string
  /** 按钮下的小字：一句话说清选它的后果 */
  desc?: string
  /** true = 「实验性」徽标（从外部项目借来、尚未在本项目长期验证）——必须显示，不能只做 tooltip */
  experimental?: boolean
}

export interface PluginInfo {
  id: string
  name: string
  icon?: string
  what?: string
  /** ★ 界面上直接显示这句原文，不要自己改写（choice 类除外：二选一没有"关"，不显示这句） */
  offEffect: string
  enabledPath: string
  /** boolean = 普通开关；enum = 人设（开=默认档，不是"上次那档"）；list = 名单类（不渲染 Switch）；
   *  choice = 二选一（0.2.3：不渲染 Switch，渲染 N 个并列按钮，没有"关"）；
   *  skill  = **控件在技能卡上**（0.2.7：不渲染 Switch，渲染"去技能卡上开"+跳转，见 `switchInSkill`） */
  switchKind: 'boolean' | 'enum' | 'list' | 'choice' | 'skill' | string
  /** `switchKind === 'skill'` 时给出**技能 id**（界面用它跳到那张技能卡）。
   *  ⚠️ 不要用 `if (id === 'sticker')` 硬编码 —— 下一个"内置技能"出现时必然被漏掉。 */
  switchInSkill?: string | null
  enabled: boolean | null
  /** choice 的当前生效值（高亮按钮用；choice 的 enabled 恒为 null，不能靠它判断） */
  value?: unknown
  /** choice 的候选（switchKind === 'choice' 时非空，其余为 null） */
  options?: PluginChoiceOption[] | null
  /** true = 即时生效；false = 需要重启（why 里有取证位置，要显示出来） */
  hot: boolean
  why: string
  /** 详细设置仍在原页签；'extensions:xxx' = 展开区就在本页；null = 只有开关（别渲染「去详细设置」） */
  uiTab: string | null
}

export interface ExtensionsResult {
  skillsDir: string
  skills: SkillInfo[]
  plugins: PluginInfo[]
  counts: { skills: number; skillsEnabled: number; skillsBroken: number; plugins: number; pluginsOn: number }
  notes: string[]
}

/**
 * 表情包「重新打标签」的进度快照（0.2.4）。
 *
 * ★ 界面上**必须显示** `total / done / skippedManual / failed`，不能只转一个圈：
 *   这是本功能唯一会真花钱的操作（每张一次模型调用），用户要看得出跑到哪了。
 * ★ `skippedManual` 不是失败：那是**人工改过的标签，默认不动它们**（避免模型把人纠正过的错误再犯一遍）。
 */
export interface StickerRetagStatus {
  id: string | null
  /** idle | running | done | failed | aborted */
  phase: string
  running: boolean
  startedAt: number | null
  finishedAt: number | null
  /** 这次要处理多少张（**预检结果**，点之前就要拿到它做二次确认） */
  total: number
  /** 库里一共多少张（含人工改过的与待定的） */
  libraryTotal: number
  /** ★ 空闲时 = 本次**会处理**多少张（不是"待定的张数"：重新打标签含已打好的）；在跑时 = 本次任务总数 */
  willProcess: number
  /** 预检本身失败时的原因（例如没有工作区）—— 界面直接显示，别让按钮点了才报错 */
  preflightWhy?: string
  done: number
  tagged: number
  retagged: number
  failed: number
  skippedManual: number
  current: string | null
  lastLabel: string | null
  percent: number | null
  reason: string
  failedList: Array<{ rel: string; why: string }>
}

export interface ExtensionToggleResult {
  ok?: boolean
  /** ★ 三种开关语义的判据：false=即时生效；true=要重启（把 why 显示出来） */
  restartRequired?: boolean
  hint?: string
  why?: string
  [key: string]: unknown
}

// ── 0.2.1 记忆观测面的类型（字段与后端一一对应）────────────────────────────

export interface MemoryStatsRow {
  chatKey: string
  turns: number
  proposed: number
  applied: number
  ignored: number
  deduped: number
  lastWriteAt: number
  lastProposeAt: number
  /** 零写入告警：真的达到阈值才为 true（落过盘、轮数不够都不报） */
  alert: boolean
  alertWhy: string
}

export interface MemoryStatsResult {
  /** 告警阈值（后端 STATS_DEFAULTS.zeroWriteAfterTurns，**不是配置项**） */
  threshold: number
  rows: MemoryStatsRow[]
}

export interface PrivacyAuditEntry {
  ts: number
  at: string
  /** store = 写入侧（想记隐私被拦）；其它 = 输出侧（想往外说被拦，更值得报警） */
  side: string
  categories: string[]
  /** 被拦内容的字数 —— 只有字数，没有原文（刻意的） */
  length: number
  chatKey?: string
}

export interface PrivacyAuditResult {
  recent: PrivacyAuditEntry[]
  /** 两侧分开计数：写入侧多 = 老想记隐私；输出侧多 = 想往外说隐私 */
  storeCount: number
  outputCount: number
  /** 类别码 → 中文名 */
  categories: Record<string, string>
}

export interface PrivacyScanHit {
  rel: string
  line: number
  categories: string[]
}

export interface PrivacyScanResult {
  scanned: number
  hitCount: number
  /** ★ 只有位置（文件+行号+类别），没有原文 —— 去记忆编辑器里看那一行 */
  hits: PrivacyScanHit[]
  byCategory: Record<string, number>
  categories: Record<string, string>
}

export interface MemorySearchRow {
  rel: string
  line: number
  /** ★ 行**预览**（不是全文） */
  preview: string
  /** 已被更正的条目：仍在文件里，但不再作为事实使用 */
  superseded: boolean
}

export interface MemorySearchResult {
  ok: boolean
  query: string
  /** 一共扫了几个记忆文件（让人知道搜索范围） */
  files: number
  rows: MemorySearchRow[]
}

// ── H13 的类型（字段与后端一一对应，见 CONFIG-UI.md §5.x）──────────────────

export interface PreflightGate {
  id: 'config' | 'admins' | 'onebot' | 'login' | 'dsh' | 'credentials' | string
  ok: boolean
  /** blocker = 必须修（否则机器人不会说话）；warn = 建议看；info = 正常 */
  level: 'blocker' | 'warn' | 'info'
  title: string
  hint: string
  /** ★ 给使用者看的下一步（可直接复制去跑）—— 这条接口存在的理由就是它 */
  action: string
}

export interface Preflight {
  ok: boolean
  blockers: number
  gates: PreflightGate[]
}

export interface AccountSummary {
  uin: string
  file: string
  /** ★ 恰好一个为 true（凭据发现的判定结果） */
  isCurrent: boolean
}

export interface AccountsResult {
  installDir: string
  accounts: AccountSummary[]
  current: string | null
  why: string
  /** true = 「这个账号的凭据与 config.json 一致」，是最可靠的判定依据 */
  matchedByConfig: boolean
}

export interface LogChunk {
  lines: string[]
  /** 下次请求带上它，只取新增的行 */
  cursor: number
  total: number
  eof: boolean
  why?: string
}

export interface CorpusRow {
  mid: string | null
  at: number | null
  chatKey: string
  sender: string
  isBot: boolean
  /** ★ **截断预览**，不是全文 —— 别当正文显示成"完整消息" */
  preview: string
}

export interface CorpusResult {
  ok: boolean
  mode: 'fts' | 'like' | null
  why: string | null
  rows: CorpusRow[]
}

// ── 工作区图片（CONFIG-UI.md §2.9）────────────────────────────────────────

/** 现在的 inbox 状态（目录不存在不算错误，count 为 0）。 */
export interface InboxState {
  count: number
  totalBytes: number
  oldestMtime: number | null
  files: { name: string; size: number; mtime: number }[]
}

/**
 * 工作区图片的取图地址（相对路径 → /api/workspace-file）。
 * 只支持 inbox/ 前缀，后端会再校验一次。
 */
export function workspaceFileUrl(path: string): string {
  return `/api/workspace-file?path=${encodeURIComponent(path)}`
}

// ── 人设（CONFIG-UI.md §2.2，0.2.2）──────────────────────────────────────
// 0.2.2 前的 PersonaPreset / PersonaInfo 类型已随旧接口（410 Gone）一起移除；
// 人设库的类型在上方「0.2.2 人设库的类型」一节（PersonaShelf / PersonaItem）。
