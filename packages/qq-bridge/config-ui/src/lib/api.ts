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
    request<{ saved: boolean; sha256: string; mtime?: string; restartRequired: boolean; overwroteWithoutCheck?: boolean }>(
      'POST',
      '/api/memory/file',
      args,
    ),
  snowlumaDetect: () => request<SnowlumaDetect>('GET', '/api/snowluma/detect'),
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
