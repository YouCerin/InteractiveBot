/**
 * 技能「截图」的入口。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个技能的三段结构与各自的文件
 * ══════════════════════════════════════════════════════════════════════════
 *   `capture.js`   纯逻辑：计划、夹取、region 校验、黑屏判定、清理挑选、文案
 *                  —— 无 IO，离线全测（`mocks/verify-screenshot.mjs`）
 *   `ps-runner.js` 执行：拼 PowerShell 脚本、起进程、读结果 JSON
 *                  —— 唯一碰系统 API 的地方，"怎么跑外部命令"可注入
 *   本文件         契约：注册工具、自检、提示词片段、**权限硬闸**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 管理员硬闸：为什么不能只靠提示词（这一节是本次设计的核心）
 * ══════════════════════════════════════════════════════════════════════════
 * 需求原话是「**任何情况下只有管理员才能下达截图指令**」。
 * 而 `docs/插件设计规范.md` §5.4 已经如实写明：`permission: "write"` 只是
 * **提示词层**的约束 —— MCP 的 `tools/call` 上没有调用者身份，
 * 模型想不听就不听（群里一个普通人说"帮我截屏"，模型完全可能照做）。
 *
 * 所以这里必须另找依据。可用的**可信**事实只有一个：
 * **桥接自己**在准入判定那一步算出来的 tier（`roster.decide()`），
 * 它既知道是哪个会话、也知道发言人是不是管理员。
 * 那一步在**桥接主进程**里，而这个工具跑在**MCP 子进程**里 —— 两个进程。
 *
 * 传递方式：桥接在**每一轮真跑模型之前**把这一轮的结论写成一个文件：
 *
 *      <workspace>/screenshots/.grants/<peerKey 的 SHA1 前 16 位>.json
 *      { kind, peerId, senderId, tier: 'admin'|'user', at, exp }
 *
 * 回合结束就删掉；文件还带 10 分钟过期（回合崩了留下的残留不会长期有效）。
 * 本技能在 `execute()` 里读它 —— **没有文件 = 拒绝**（fail-closed）。
 *
 * 这条路的边界，如实写清（不写清就等于骗后来的人）：
 *   · 判定依据是**会话**（`kind:peerId`），不是"这一次工具调用是哪个模型发的" ——
 *     MCP 协议里根本没有后者。所以同一会话里的另一个模型回合，
 *     在授权有效期内（同一个回合内）也算数。这是协议边界，不是实现偷懒。
 *   · `kind` / `peerId` 由模型填（技能声明了 `session: required`，宿主会把它们
 *     加进入参）。模型**理论上**可以填一个刚被管理员用过的会话键来借权 ——
 *     真要堵死这条，得让宿主把"当前会话"透传给技能（那要改 MCP 层的契约）。
 *     当前选择是：**先堵住真实威胁**（群里陌生人一句话就偷看桌面），
 *     并把这条残留风险写在这里、写进 README 与规范。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  DEFAULT_RETENTION_HOURS,
  FORMATS,
  planCapture,
  pickExpired,
  renderCaptureText,
  shotFileName,
  shouldSweep,
} from './capture.mjs'
import { findPowerShell, runCapture } from './ps-runner.mjs'

/** 图片落地的子目录（在工作区里）。 */
export const SHOTS_DIR = 'screenshots'
/** 授权文件目录（在工作区的截图目录下）。 */
export const GRANTS_DIR = '.grants'
/**
 * 本工具**模型看到的全名**。
 *
 * `mcp__skills__` 这段前缀由 DSH 的 MCP 客户端加（本宿主的 `SKILLS_SERVER_NAME`），
 * 规则写在 `docs/插件设计规范.md` §3.3，项目里只有一处实现（`skillToolFullName`）。
 * 技能里再写一份是**刻意的兜底**：提示词片段每轮都要拼，而"拿不到工具名就整段不注入"
 * 是一种静默失效（模型永远不知道有这个能力）。宿主传 `toolName` 时优先用它的。
 */
export const CAPTURE_FULL_NAME = 'mcp__skills__screenshot__capture'
/** 授权文件的有效期：够一个回合跑完，又能让残留自然失效。 */
export const GRANT_TTL_MS = 10 * 60_000
/** 清理两次之间的最短间隔（避免每次调用都扫盘）。 */
export const SWEEP_INTERVAL_MS = 10 * 60_000

const log = (...a) => console.error('[screenshot]', ...a)

/* ── 会话授权的文件名（**必须与 src/screenshot-grant.mjs 逐字一致**）────── */

/**
 * 会话键 → 授权文件名。
 *
 * ⚠️ 这个函数在两处各有一份实现（技能不能 import 宿主的 `src/`）：
 * 这里与 `src/screenshot-grant.mjs`。改任何一边都必须同时改另一边 ——
 * 不一致的症状是"管理员授权明明写了，截图却总说没有授权"（很安静的一种坏）。
 * 有断言盯着这两份实现的一致性（`mocks/verify-screenshot.mjs` 第 ⑦ 节）。
 */
export function grantFileName(peerKey) {
  const h = crypto.createHash('sha1').update(String(peerKey ?? '')).digest('hex')
  return `${h.slice(0, 16)}.json`
}

/* ── 工作区路径 ────────────────────────────────────────────────────────── */

/**
 * 拿到本技能该往哪儿写。
 *
 * 宿主通过 `ctx.workspace` 给（0.3.0alpha 起）——它同时充当**硬边界**：
 * 技能只允许往这个目录里写东西，不读工作区外的任何文件。
 * 拿不到就直接拒绝：不猜、不退回 `process.cwd()` ——
 * 猜错会把图写到发布目录或用户家目录里，那比"这个功能用不了"糟得多。
 */
export function resolveWorkspace(ctx) {
  const ws = String(ctx?.workspace ?? '').trim()
  if (!ws) return ''
  try {
    return path.resolve(ws)
  } catch {
    return ''
  }
}

/* ── 授权读取 ──────────────────────────────────────────────────────────── */

/**
 * 读这一轮的会话授权。
 *
 * @returns {{state:'admin'|'not-admin'|'missing'|'expired'|'broken', detail:string, senderId?:string}}
 */
export function readGrant({ workspace, peerKey, now = Date.now(), ttlMs = GRANT_TTL_MS } = {}) {
  if (!workspace) return { state: 'missing', detail: '宿主没有把工作区告诉我（ctx.workspace 缺失）' }
  const file = path.join(workspace, SHOTS_DIR, GRANTS_DIR, grantFileName(peerKey))
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { state: 'missing', detail: `没有找到本会话的授权文件（${path.basename(file)}）` }
  }
  let j
  try {
    j = JSON.parse(raw)
  } catch {
    return { state: 'broken', detail: '授权文件不是合法 JSON' }
  }
  const at = Number(j?.at)
  if (!Number.isFinite(at)) return { state: 'broken', detail: '授权文件里没有时间戳' }
  if (now - at > ttlMs) return { state: 'expired', detail: `授权已过期（${Math.round((now - at) / 1000)} 秒前写的）` }
  const tier = String(j?.tier ?? '')
  if (tier === 'admin') return { state: 'admin', detail: '', senderId: String(j?.senderId ?? '') }
  return { state: 'not-admin', detail: `这一轮的发言人不是管理员（tier=${tier || '未知'}）`, senderId: String(j?.senderId ?? '') }
}

/* ── 自检 ──────────────────────────────────────────────────────────────── */

/**
 * 能力自检（**必须同步** —— 宿主在控制台点「自检」时调，做 IO 会把界面卡住）。
 *
 * 只判"有没有、开没开"，不判"现在能不能截"（那是真截一次才知道的事）。
 * 每条 `reason` 都会**原样显示在控制台的技能卡上**，所以必须指得出下一步。
 *
 * ⚠️ 这里探的是 `pwsh` / `powershell.exe` 在不在 PATH 上（同步查表，**不 spawn**）。
 * 与 `video-frames` 的 `findFfmpegOnPathSync` 同一个理由：卡片的 `available`
 * 是**装载那一刻存下来的快照**，异步探测会让卡片永远显示"✅ 可用"。
 */
export function available(context = {}) {
  const settings = context?.settings ?? context?.config?.skills?.screenshot ?? {}
  if (settings.enabled === false) {
    return {
      ok: false,
      reason: '截图技能当前是**关闭**状态（控制台 →「扩展」→ 截图 → 启用；开关即时生效，不用重启）',
    }
  }
  if (!hasPowerShellOnPath()) {
    return {
      ok: false,
      reason:
        '本机没有找到 PowerShell（`pwsh` 或 `powershell.exe`）—— 截图功能靠它干活。' +
        'Windows 自带的 Windows PowerShell 5.1 就在 %SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\，' +
        '如果 PATH 被裁剪过，把它加回去即可。',
    }
  }
  if (String(settings.format ?? 'png').toLowerCase().startsWith('j')) {
    const ff = String(settings.ffmpegPath ?? '').trim()
    if (!isFile(ff) && !hasFfmpegOnPath()) {
      return {
        ok: false,
        reason:
          '格式设成了 jpg，但本机没有可用的 ffmpeg —— **本技能刻意不用 .NET 的 JPEG 编码器**' +
          '（它和截屏同处一段脚本时会被杀毒软件当成恶意脚本拦下，实测）。' +
          '要么把格式改回 png（默认），要么在设置里填 ffmpeg 路径。',
      }
    }
  }
  return { ok: true }
}

function isFile(p) {
  const s = String(p ?? '').trim()
  if (!s) return false
  try {
    return fs.statSync(s).isFile()
  } catch {
    return false
  }
}

/** 同步扫 PATH 找 PowerShell（不 spawn）。 */
export function hasPowerShellOnPath({ env = process.env, exists = fs.existsSync, platform = process.platform, delimiter = path.delimiter } = {}) {
  const raw = String(env?.PATH ?? env?.Path ?? env?.path ?? '')
  const dirs = raw.split(delimiter).map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean)
  const names = platform === 'win32' ? ['pwsh.exe', 'powershell.exe'] : ['pwsh', 'powershell']
  for (const dir of dirs) {
    for (const name of names) {
      try {
        if (exists(path.join(dir, name))) return true
      } catch {
        /* 某个目录读不了不该影响别的目录 */
      }
    }
  }
  return false
}

/** 同步扫 PATH 找 ffmpeg（不 spawn）。 */
function hasFfmpegOnPath({ env = process.env, exists = fs.existsSync, platform = process.platform, delimiter = path.delimiter } = {}) {
  const raw = String(env?.PATH ?? env?.Path ?? env?.path ?? '')
  const dirs = raw.split(delimiter).map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean)
  const names = platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg']
  for (const dir of dirs) {
    for (const name of names) {
      try {
        if (exists(path.join(dir, name))) return true
      } catch {
        /* 同上 */
      }
    }
  }
  return false
}

/* ── 提示词片段 ────────────────────────────────────────────────────────── */

/**
 * 提示词片段（**纯函数**：每轮都调，里面不许有 IO）。
 *
 * 只写三件事：这个工具干什么、**什么时候该用**、以及**看不到就别编**。
 * 工具名一律用 `toolName()` 取（绝不写死 `mcp__skills__…`，那是刻意的纪律）。
 */
export function promptSections(context = {}) {
  // ★ 工具名的取法，按可靠性排序（**三条兜底，缺一条就会静默不注入**）：
  //   ① `context.toolName(id)` —— 宿主给的权威真名（`setup(api)` 与 `promptSections(ctx)` 同源，
  //      0.3.0alpha 起由 `collectSkillPromptSections()` 兜底提供）；
  //   ② 本文件声明的常量 —— 前缀 `mcp__skills__` 是**本宿主**的命名规则（`SKILLS_SERVER_NAME`），
  //      写在这里仍然准确，且不依赖宿主把 ctx 传对（历史上它一度没传，见 extensions.mjs 里的注释）；
  //   ③ 拿不到就返回 `[]`：**宁可不加这段提示，也不给模型一个调不到的工具名**
  //      （那会变成"模型去调一个不存在的工具、而且失败得很安静"）。
  const toolName =
    (typeof context?.toolName === 'function' ? context.toolName('capture') : '') || CAPTURE_FULL_NAME
  if (!toolName) return []
  const settings = context?.settings ?? context?.config?.skills?.screenshot ?? {}
  const inGroup = settings.allowInGroup !== false
  const needAdmin = settings.requireAdmin !== false
  // 发图工具名同理：宿主给了就用真名（`api.hostTool('send_image')`）。
  // 给不出时**不写死**，用一句人话代替 —— 写死一个可能不存在的工具名，
  // 正是"模型去调不存在的工具"那类静默失效的来源。
  const sendTool = (typeof context?.hostTool === 'function' ? context.hostTool('send_image') : '') || '发图工具'
  return [
    {
      id: 'screenshot',
      title: '截图',
      priority: 60,
      content: [
        `· 「看看我这边现在什么样」「屏幕上是什么」「截个图」这类要求，用 ${toolName} 截屏（source=screen 整屏 / primary 主屏 / window 按标题截某个窗口，被遮挡也能截）。`,
        '  截完只拿到一个**相对路径**：要看内容就 read_image 读它（读图花 token，确定用不上就别读）。',
        '  对方就是想看图，就把那个相对路径交给发图工具发进当前会话（用 ' + sendTool + '，不用另外开内网开关）。',
        '  **别猜画面内容**：没读那张图就说不出屏幕上有什么，看不到就直说。',
        needAdmin
          ? (inGroup
              ? '  权限：只有管理员能用这个工具；群里的普通人让你截屏时，用一句自然的话回掉（不用解释权限系统）。'
              : '  权限：只有管理员能用；而且当前设置**不允许在群聊里截图**，群里让你截就直说不方便。')
          : '  ⚠️ 当前设置**关闭了管理员限制**：谁让你截都能截 —— 这是管理员自己选的，但要清楚它意味着什么。',
      ].join('\n'),
    },
  ]
}

/* ── 工具 ──────────────────────────────────────────────────────────────── */

/** 上次清理的时间（模块级状态：跨会话共享，用来做"别每次都扫盘"）。 */
let lastSweepAt = 0

/**
 * 顺手清理过期的截图（**失败只记日志，绝不影响这一轮**）。
 *
 * 为什么是"顺手"而不是定时器：技能没有常驻生命周期（`setup` 被两个进程各调一次），
 * 起定时器在 MCP 子进程里会一直挂着。挂在"每次抓图之后"最省事，
 * 频次由 `shouldSweep` 按时间间隔控制。
 */
function sweep({ workspace, settings }) {
  const hours = Number(settings?.retentionHours ?? DEFAULT_RETENTION_HOURS)
  if (!hours) return { removed: 0, skipped: 'off' }
  if (!shouldSweep({ lastSweepAt, now: Date.now(), intervalMs: SWEEP_INTERVAL_MS })) return { removed: 0, skipped: 'recent' }
  lastSweepAt = Date.now()
  const dir = path.join(workspace, SHOTS_DIR)
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return { removed: 0, skipped: 'no-dir' }
  }
  const files = []
  for (const e of entries) {
    if (!e.isFile()) continue
    if (!/\.(png|jpe?g)$/i.test(e.name)) continue
    const p = path.join(dir, e.name)
    try {
      files.push({ path: p, name: e.name, mtimeMs: fs.statSync(p).mtimeMs })
    } catch {
      /* 读不到就跳过 */
    }
  }
  const expired = pickExpired(files, { now: Date.now(), retentionHours: hours })
  let removed = 0
  for (const p of expired) {
    try {
      fs.rmSync(p, { force: true })
      removed += 1
    } catch {
      /* 删不掉（被占用）下次再说 */
    }
  }
  if (removed) log(`清理了 ${removed} 张过期截图（保留 ${hours} 小时）`)
  return { removed, skipped: '' }
}

export function setup(api) {
  const cfg = () => api.config() ?? {}

  api.registerTool({
    id: 'capture',
    name: '截图',
    description:
      '把机器人所在这台电脑的屏幕截成一张图存进工作区，返回相对路径；' +
      '要用 read_image 读它才能看到内容，要发出去就用宿主的发图工具（url 填这个相对路径）',
    category: 'media',
    icon: '📸',
    permission: 'write',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['screen', 'primary', 'window'], description: 'screen=整块桌面（默认）/ primary=主显示器 / window=按窗口标题截' },
        window: { type: 'string', description: 'source=window 时必填：窗口标题的一部分（不区分大小写）' },
        region: { type: 'array', items: { type: 'number' }, description: '只截一块：[x, y, 宽, 高]（屏幕绝对坐标）' },
        maxWidth: { type: 'integer', description: '这一张的宽度上限（像素），不填用扩展设置（默认 1280）' },
        format: { type: 'string', enum: ['png', 'jpg'], description: 'png（默认）或 jpg（需要本机有 ffmpeg）' },
      },
    },

    async execute(ctx, args) {
      const settings = ctx?.settings ?? cfg() ?? {}

      /* ① 开关（宿主已经现读过一次，这里再判一次是为了"技能自己也能解释清楚"） */
      if (settings.enabled === false) {
        return { isError: true, content: '「截图」现在是**关闭**状态（管理员在控制台 →「扩展」里关掉了它）。不要重试，直接用一句自然的中文说这个功能暂时用不了。' }
      }

      /* ② 权限（三层，顺序不能换：群 → 管理员 → 干活的） */
      const kind = String(ctx?.kind ?? '')
      const peerId = String(ctx?.chatId ?? '')
      const peerKey = String(ctx?.peerKey ?? '')
      if (kind === 'group' && settings.allowInGroup === false) {
        return {
          isError: true,
          content: '当前设置**不允许在群聊里截图**（管理员可以在控制台 →「扩展」→ 截图 里打开）。请用一句自然的中文说明群里不方便，**不要**换 private 再试、也不要假装截过。',
        }
      }
      if (settings.requireAdmin !== false) {
        if (!peerKey) {
          return { isError: true, content: '这次调用没带上会话信息（kind/peerId），我无法确认你有没有权限 —— 拒绝执行。' }
        }
        const workspace0 = resolveWorkspace(ctx)
        const g = readGrant({ workspace: workspace0, peerKey })
        if (g.state !== 'admin') {
          log(`拒绝截图：${peerKey} 授权=${g.state}（${g.detail}）`)
          return {
            isError: true,
            content:
              g.state === 'missing' || g.state === 'expired'
                ? '这条截图指令**没有拿到管理员授权**，所以我不能截。请用一句自然的中文告诉对方这个他做不了（**不要**解释权限系统、不要说"授权文件"，也不要换别的说法再试）。'
                : '这个动作**只有管理员能做**。用一句自然的中文回掉就好（例如「这个我做不了哈」），不要解释权限系统、也不要偷偷做。',
          }
        }
      }

      /* ③ 工作区（硬边界：只往这里写） */
      const workspace = resolveWorkspace(ctx)
      if (!workspace) {
        return { isError: true, content: '截图功能现在不可用：宿主没有把工作区路径传进来（这是配置/版本问题，不是对方的问题）。请如实说这个功能暂时用不了。' }
      }

      /* ④ 计划（纯逻辑；这里就把所有参数收敛成一份可执行的计划） */
      const ffmpeg = String(settings.ffmpegPath ?? '').trim()
      const planned = planCapture({ settings, args, ffmpeg })
      if (!planned.ok) {
        return { isError: true, content: `截不了：${planned.reason}${planned.hint ? `\n（${planned.hint}）` : ''}` }
      }
      const plan = planned.plan
      if (plan.format === 'jpg' && !ffmpeg && !hasFfmpegOnPath()) {
        return { isError: true, content: '要 jpg 但本机没有 ffmpeg。改成 png（默认）就行 —— 本技能**刻意不用** .NET 的 JPEG 编码器，它和截屏写在同一段脚本里会被杀毒软件拦下。' }
      }

      /* ⑤ 真截 */
      const at = Date.now()
      const shotsDir = path.join(workspace, SHOTS_DIR)
      const tmpDir = path.join(workspace, 'tmp')
      const fileName = shotFileName({ source: plan.source, at, ext: plan.format === 'jpg' ? 'jpg' : 'png' })
      const ps = findPowerShell()
      if (!ps) {
        return { isError: true, content: '这台机器上跑不了 PowerShell（`pwsh` 与 `powershell.exe` 都不行），截图功能依赖它 —— 请如实说这个功能现在用不了。' }
      }

      let result
      try {
        result = await runCapture({ plan, shotsDir, tmpDir, fileName })
      } catch (error) {
        result = { ok: false, reason: `抓图时出错了：${error?.message ?? error}` }
      }

      // 审计：**只记元数据**，绝不记画面内容（也不把图写进任何记忆/语料库）
      log(
        `截图 ${result.ok ? '成功' : '失败'}｜${peerKey || kind}｜` +
          (result.ok
            ? `${result.stats.width}x${result.stats.height} ${Math.round(result.stats.bytes / 1024)}KB ` +
              `mean=${result.stats.mean?.toFixed?.(1) ?? '?'} std=${result.stats.std?.toFixed?.(1) ?? '?'} ` +
              `方法=${(result.stats.methods ?? []).join('+') || '?'}${result.warning ? '（画面可疑）' : ''}`
            : result.reason),
      )

      if (!result.ok) {
        return {
          isError: true,
          content: `没截成：${result.reason}\n（如实把原因转述给对方，别改写成"截好了"。）`,
        }
      }

      /* ⑥ 顺手清理 + 返回 */
      try {
        sweep({ workspace, settings })
      } catch (error) {
        log(`清理过期截图时出错（不影响这次截图）：${error?.message ?? error}`)
      }

      const relPath = `${SHOTS_DIR}/${path.basename(result.absPath)}`
      // ★ 工具全名一律从宿主取（`api.hostTool` 那套映射），**绝不写死** `mcp__qq__…`
      //   —— 写死的话，宿主改了服务器名/工具名就会变成"模型去调一个不存在的工具"，
      //   而且失败得很安静（这正是 pixiv 适配时踩过的那个坑）。
      const hostSendImage = typeof ctx?.hostTool === 'function' ? ctx.hostTool('send_image') : ''
      return {
        content: renderCaptureText({
          relPath,
          stats: result.stats,
          warning: result.warning,
          sendToolName: hostSendImage || '（宿主的发图工具）',
        }),
      }
    },
  })
}

/** 技能停用/退出时调用（本技能没有常驻资源，留个空实现说明"确实没有要收的"）。 */
export function dispose() {}

/**
 * 控制台「自检」走这里（比 `available()` 能多说一点，但**依然不许碰屏幕**：
 * 自检在桥接主进程里跑，真截一次会把界面卡住，而且那是"没经用户同意就看屏幕"）。
 */
export function diagnose(context = {}) {
  const settings = context?.settings ?? context?.config?.skills?.screenshot ?? {}
  const ws = String(context?.workspace ?? '').trim()
  const lines = [
    `开关：${settings.enabled === false ? '关闭' : '开启'}｜群聊：${settings.allowInGroup === false ? '不允许' : '允许（仅管理员）'}｜管理员限制：${settings.requireAdmin === false ? '⚠️ 已关闭' : '开启'}`,
    `格式：${settings.format ?? 'png'}｜宽度上限：${settings.maxWidth ?? 1280}｜保留：${settings.retentionHours ?? DEFAULT_RETENTION_HOURS} 小时`,
    `PowerShell：${hasPowerShellOnPath() ? '在 PATH 上找到了' : '⚠️ 没找到（截图会失败）'}`,
    `ffmpeg：${String(settings.ffmpegPath ?? '').trim() ? `已配置 ${String(settings.ffmpegPath).trim()}` : (hasFfmpegOnPath() ? 'PATH 上有（仅 jpg 需要）' : '没有（png 不需要它）')}`,
  ]
  if (ws) {
    const grants = path.join(ws, SHOTS_DIR, GRANTS_DIR)
    let names = []
    try {
      names = fs.readdirSync(grants)
    } catch {
      names = []
    }
    lines.push(`当前有效的会话授权：${names.length} 个（每次回合开始写、结束删；按会话键哈希命名）`)
  } else {
    lines.push('⚠️ 没拿到工作区路径 —— 真跑时工具会因为写不了图而拒绝（这是配置问题，不是屏幕的问题）')
  }
  return { ok: true, lines }
}

export { FORMATS, DEFAULT_RETENTION_HOURS }
