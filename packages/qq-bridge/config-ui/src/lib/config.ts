/**
 * 配置读写与领域规则的工具函数。
 * 字段路径与默认值严格对照 packages/qq-bridge/CONFIG-UI.md 第 2 节，
 * 不自己发明默认值。
 */

/** 按 "a.b.c" 路径读嵌套值。 */
export function getPath(obj: unknown, path: string): unknown {
  let cur = obj as Record<string, unknown> | undefined | null
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key] as Record<string, unknown>
  }
  return cur
}

/** 按 "a.b.c" 路径写嵌套值（返回新对象，不改原对象）。 */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const copy = JSON.parse(JSON.stringify(obj ?? {}))
  const keys = path.split('.')
  let cur = copy
  for (const key of keys.slice(0, -1)) {
    if (cur[key] === null || typeof cur[key] !== 'object' || Array.isArray(cur[key])) cur[key] = {}
    cur = cur[key]
  }
  cur[keys[keys.length - 1]] = value
  return copy
}

export function getStr(obj: unknown, path: string, fallback = ''): string {
  const v = getPath(obj, path)
  return typeof v === 'string' ? v : fallback
}

export function getNum(obj: unknown, path: string, fallback: number): number {
  const v = getPath(obj, path)
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export function getBool(obj: unknown, path: string, fallback: boolean): boolean {
  const v = getPath(obj, path)
  return typeof v === 'boolean' ? v : fallback
}

export function getStrArr(obj: unknown, path: string, fallback: string[] = []): string[] {
  const v = getPath(obj, path)
  return Array.isArray(v) ? v.map(String) : fallback
}

// ── 回应速度三档（CONFIG-UI.md 2.4 ★★ 节）────────────────────────────────

export interface SpeedPreset {
  value: 'fast' | 'balanced' | 'careful'
  label: string
  wait: string
  risk: string
  riskLevel: 'high' | 'mid' | 'low'
  params: { reactMinMs: number; reactMaxMs: number; typingMaxMs: number; maxDelayMs: number }
}

export const SPEED_PRESETS: SpeedPreset[] = [
  {
    value: 'fast',
    label: '快速',
    wait: '约 1 秒',
    risk: '接近秒回。这是行为风控最典型的特征，账号被处置的风险最高',
    riskLevel: 'high',
    params: { reactMinMs: 100, reactMaxMs: 500, typingMaxMs: 800, maxDelayMs: 1200 },
  },
  {
    value: 'balanced',
    label: '均衡（推荐）',
    wait: '约 5~9 秒',
    risk: '介于真人与机器之间',
    riskLevel: 'mid',
    params: { reactMinMs: 3500, reactMaxMs: 6500, typingMaxMs: 3000, maxDelayMs: 9000 },
  },
  {
    value: 'careful',
    label: '谨慎',
    wait: '约 10~22 秒',
    risk: '最接近真人节奏（看到消息 → 想一下 → 打字），账号风险最低',
    riskLevel: 'low',
    params: { reactMinMs: 10000, reactMaxMs: 15000, typingMaxMs: 7000, maxDelayMs: 22000 },
  },
]

/** 比对五个参数，反推当前属于哪个档位；对不上就是「自定义」。 */
export function detectSpeedPreset(cfg: unknown): 'fast' | 'balanced' | 'careful' | 'custom' {
  for (const p of SPEED_PRESETS) {
    if (
      getNum(cfg, 'humanize.reactMinMs', -1) === p.params.reactMinMs &&
      getNum(cfg, 'humanize.reactMaxMs', -1) === p.params.reactMaxMs &&
      getNum(cfg, 'humanize.typingMaxMs', -1) === p.params.typingMaxMs &&
      getNum(cfg, 'humanize.maxDelayMs', -1) === p.params.maxDelayMs
    ) {
      return p.value
    }
  }
  return 'custom'
}

/**
 * 估算一条 len 字回复的等待时间（毫秒）：
 * 反应时间取区间中点 + 打字时间（len / charsPerSecond，受 typingMaxMs 限制），
 * 整体再受 maxDelayMs 限制。与 humanize.mjs 的曲线口径一致（近似）。
 */
export function estimateDelayMs(cfg: unknown, len = 200): number {
  const reactMin = getNum(cfg, 'humanize.reactMinMs', 3500)
  const reactMax = getNum(cfg, 'humanize.reactMaxMs', 6500)
  const cps = getNum(cfg, 'humanize.charsPerSecond', 5)
  const typingMax = getNum(cfg, 'humanize.typingMaxMs', 3000)
  const maxDelay = getNum(cfg, 'humanize.maxDelayMs', 9000)
  const react = (reactMin + reactMax) / 2
  const typing = Math.min((len / Math.max(cps, 0.1)) * 1000, typingMax)
  return Math.min(react + typing, maxDelay)
}

// ── 关键词风险（CONFIG-UI.md 2.3）────────────────────────────────────────

const HIGH_FREQ_WORDS = ['哈哈', '草', '笑死', '在吗', '我', '你', '好', '嗯', '哦', '啊', '666', '233']

/** 返回每个关键词的警告；无警告的词不出现在结果里。 */
export function keywordWarnings(keywords: string[]): { word: string; reason: string }[] {
  const out: { word: string; reason: string }[] = []
  for (const raw of keywords) {
    const word = raw.trim()
    if (!word) continue
    if ([...word].length === 1) {
      out.push({ word, reason: `「${word}」只有 1 个字，几乎等于对每句话都响应` })
    } else if (HIGH_FREQ_WORDS.includes(word)) {
      out.push({ word, reason: `「${word}」是群聊高频词，会让机器人响应得过于频繁` })
    }
  }
  return out
}

// ── 其它客户端提示性校验（后端 /api/check 才是权威，这里只做即时提示）────

/** 工作区是否明显危险（盘符根 / 用户主目录）。 */
export function isDangerousWorkspace(p: string): boolean {
  const v = p.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[A-Za-z]:$/.test(v) || /^[A-Za-z]:$/.test(v.replace('/', ''))) return true
  if (/^\/(home|users)\/[^/]+$/i.test(v)) return true
  if (/^[A-Za-z]:\/Users\/[^/]+$/i.test(v)) return true
  return false
}

/** 从 ws/http URL 里提取端口，相同则说明可能填反了。 */
export function samePort(wsUrl: string, httpUrl: string): boolean {
  try {
    const a = new URL(wsUrl.replace(/^ws/, 'http'))
    const b = new URL(httpUrl)
    return a.port !== '' && a.port === b.port
  } catch {
    return false
  }
}

/** 人设文本里疑似提到工具名的粗检（提示用，权威校验在后端）。 */
export function personaMentionsTools(text: string): boolean {
  return /\b(bash|shell|exec|read_file|write_file|edit_file|web_search|browser)\b/i.test(text)
}

// ── 峰谷时段判定（CONFIG-UI.md §2.1.1，照抄 computePeriod）─────────────────

export interface PeakRuleInput {
  timezone?: string
  windows?: { start: string; end: string }[]
  days?: number[]
  holidays?: string[]
}

export interface PeriodResult {
  period: 'peak' | 'offPeak'
  reason: 'holiday' | 'weekend' | 'window' | 'outside-window'
  isPeak: boolean
  indicator: string
}

/** 判断此刻属于高峰还是低谷。now 默认取浏览器当前时间。 */
export function computePeriod(peak: PeakRuleInput | undefined, now = new Date()): PeriodResult {
  const tz = peak?.timezone || 'Asia/Shanghai'

  // ★ 必须用 Intl 取"该时区的墙上时间"，不能直接读 now.getHours()
  //   直接读拿到的是【浏览器本地时区】的小时；用户若不在北京就会判错。
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  })
  const p: Record<string, string> = {}
  for (const part of f.formatToParts(now)) p[part.type] = part.value
  const wd = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[p.weekday]
  const ymd = `${p.year}-${p.month}-${p.day}`

  const holidays = new Set(peak?.holidays ?? [])
  const days = peak?.days ?? [1, 2, 3, 4, 5]
  const windows = peak?.windows ?? []

  const toMin = (hm: string) => {
    const [h, m] = String(hm).split(':').map(Number)
    return h * 60 + m
  }
  const cur = toMin(`${p.hour}:${p.minute}`)

  // 判定顺序：节假日 → 周末 → 窗口内
  let period: 'peak' | 'offPeak'
  let reason: PeriodResult['reason']
  if (holidays.has(ymd)) {
    period = 'offPeak'
    reason = 'holiday'
  } else if (!days.includes(wd)) {
    period = 'offPeak'
    reason = 'weekend'
  } else if (windows.some((w) => cur >= toMin(w.start) && cur < toMin(w.end))) {
    // ★ 左闭右开：09:00 算高峰，12:00 算低谷。否则整点那一刻有两个答案。
    period = 'peak'
    reason = 'window'
  } else {
    period = 'offPeak'
    reason = 'outside-window'
  }

  return {
    period,
    reason,
    isPeak: period === 'peak',
    indicator: period === 'peak' ? '当前：高峰时段' : '当前：低谷时段',
  }
}

/** reason 的人话版，用于指示灯 tooltip。 */
export const PERIOD_REASON_TEXT: Record<PeriodResult['reason'], string> = {
  window: '落在高峰时段窗口内',
  weekend: '周末按低谷计价',
  holiday: '在节假日表里，按低谷计价',
  'outside-window': '工作日，但在高峰窗口外',
}

// ── 演示数据（桥接不在线时，让界面可以完整浏览）───────────────────────────

export const DEMO_CONFIG: Record<string, unknown> = {
  dsh: {
    cliPath: '',
    searchPaths: [],
    workspace: 'workspace-qq',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    reasoningEffort: '',
    apiKey: '',
    permissionMode: 'workspace-write',
  },
  onebot: {
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    selfId: '',
  },
  hasWsToken: true,
  hasHttpToken: true,
  hasApiKey: true,
  access: { adminUsers: ['100000001'] },
  trigger: {
    private: true,
    mention: true,
    keyword: true,
    groupEnabled: false,
    keywords: ['小鲸鱼', 'D指导', 'deepseek'],
  },
  send: {
    minGapMs: 1000,
    maxGapMs: 3000,
    maxPerMinute: 8,
    maxPerHour: 500,
    dedupeWindowMs: 8000,
    maxCharsPerMessage: 1500,
  },
  turn: { timeoutMs: 600000 },
  humanize: {
    enabled: true,
    speed: 'balanced',
    reactMinMs: 3500,
    reactMaxMs: 6500,
    charsPerSecond: 5,
    typingMaxMs: 3000,
    maxDelayMs: 9000,
    chunkChars: 300,
    quietHours: { enabled: true, start: '02:00', end: '07:00' },
    quietDelayMinMs: 45000,
    quietDelayMaxMs: 150000,
    interim: {
      enabled: true,
      afterMs: 8000,
      messages: {
        searching: ['等下，我搜一下', '我查查', '网上找一下，稍等'],
        tooling: ['等下，我弄一下', '稍等，我在跑', '马上，正在处理'],
        thinking: ['等下，我想想', '嗯……让我组织一下', '稍等'],
        blocked: ['这个我暂时做不了', '权限不够，换个做法试试？'],
      },
    },
  },
  session: { salt: '', instance: '' },
  persona: { callerName: '', callUser: '', preset: 'mermaid-lite', custom: '' },
  memory: { enabled: true },
  // §2.5.1 看图：机器人能不能看图片（取回后落 workspace/inbox）
  image: {
    enabled: true,
    mode: 'on-demand',
    maxCount: 4,
    maxBytes: 10485760,
    timeoutMs: 15000,
    maxRedirects: 3,
    retentionHours: 72,
    maxTotalBytes: 104857600,
  },
  mcp: { enabled: true, toolTimeoutMs: 20000 },
  snowluma: { installDir: '', searchPaths: [], launchCmd: '', launchCwd: '', probeTimeoutMs: 1500 },
  usage: { enabled: true, costEnabled: false, pricesFile: 'prices.json' },
  ui: { logFile: 'logs/bridge.log', verbose: false, apiEnabled: true, apiPort: 3410 },
}

export const DEMO_STATUS = {
  running: true,
  startedAt: new Date(Date.now() - 3600_000 * 5).toISOString(),
  uptimeMs: 3600_000 * 5,
  login: { userId: '200000001', nickname: 'DeepSeek小鲸鱼' },
  connected: true,
  dshAlive: true,
  adminUsers: ['100000001'],
  permissionMode: 'workspace-write',
  workspace: 'C:\\...\\workspace-qq',
  groupEnabled: false,
  stats: { received: 42, triggered: 31, answered: 28, skipped: 11, denied: 2, failed: 1 },
}
