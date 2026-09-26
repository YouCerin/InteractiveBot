import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { FieldRow, InlineNote, NumInput } from '@/components/common'
import { api, isNotImplemented, type ApiStatus, type SnowlumaDetect, type SnowlumaStatus } from '@/lib/api'
import { getBool, getNum, getStr, getStrArr, samePort } from '@/lib/config'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { KeyRound, Loader2, Plug, RefreshCw, Rocket, SquareArrowOutUpRight, X } from 'lucide-react'
import { SnowlumaTerminal } from '@/sections/SnowlumaTerminal'
import { AccessCard } from '@/sections/AccessCard'
import { AccountsCard } from '@/sections/AccountsCard'

export interface TokenDraft {
  wsToken: string
  httpToken: string
}

/** SnowLuma 的官方发布页（本包不分发它，见下方「没找到 SnowLuma」那块）。 */
const SNOWLUMA_DOWNLOAD_URL = 'https://github.com/SnowLuma/SnowLuma/releases'

/** 用户手动关闭「没找到 SnowLuma」提示后，本次会话内不再自动弹（仍可点按钮重开）。 */
let snowlumaHintDismissed = false

/** 状态对照表（CONFIG-UI.md §2.7.1，文案照抄）。 */
const SNOWLUMA_STATE: Record<SnowlumaStatus, { dot: string; textClass: string; label: string; text: string }> = {
  'not-configured': {
    dot: 'bg-gray-400',
    textClass: 'text-muted-foreground',
    label: '未配置',
    text: 'SnowLuma 没配启动入口。可以在下面填 snowluma.launchCmd，或自己去手动开它。',
  },
  'bridge-offline': {
    dot: 'bg-gray-400',
    textClass: 'text-muted-foreground',
    label: '桥接离线',
    text: '机器人本体没在运行，探测不了。（这种情况界面本来也打不开，属于兜底）',
  },
  offline: {
    dot: 'bg-red-500',
    textClass: 'text-red-700',
    label: '没在线',
    text: 'SnowLuma 没在运行。请用 start.bat 启动（它会先拉起 SnowLuma），或手动开它。',
  },
  'up-not-logged-in': {
    dot: 'bg-amber-400',
    textClass: 'text-amber-700',
    label: '在线但没登录',
    text: 'SnowLuma 在跑，但 QQ 还没登录。去看看它的窗口，可能要扫码。',
  },
  'auth-failed': {
    dot: 'bg-amber-400',
    textClass: 'text-amber-700',
    label: '令牌被拒',
    text: 'SnowLuma 在跑，但不认我们的 token。检查上面两个 token 有没有填反。',
  },
  connected: {
    dot: 'bg-emerald-500',
    textClass: 'text-emerald-700',
    label: '已连接',
    text: '一切正常，机器人在线。',
  },
}

const DEMO_DETECT: SnowlumaDetect = {
  status: 'connected',
  httpReachable: true,
  wsConnected: true,
  loggedIn: true,
  login: { userId: '200000001', nickname: 'DeepSeek小鲸鱼' },
  endpoint: { httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001' },
  consoleUrl: 'http://127.0.0.1:5099/',
  consoleReachable: null,
  tokenSource: 'SnowLuma 自己的配置',
  tokenDiffersFromConfig: false,
  launch: { configured: true, cmd: 'D:\\...\\snowluma\\launcher.bat', cwd: 'D:\\...\\snowluma' },
  hint: '一切正常。',
}

/** 取路径的目录部分（跨 win/posix 分隔符），用于对比 launch.cmd 与 launch.cwd。 */
function dirOf(p: string): string {
  const norm = p.replace(/\//g, '\\').replace(/\\+$/, '')
  const i = norm.lastIndexOf('\\')
  return (i >= 0 ? norm.slice(0, i) : norm).toLowerCase()
}

/** 规范化一个目录路径（cwd 本身就是目录，不能再 dirOf）。 */
function normDir(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

/**
 * SnowLuma 进程卡（CONFIG-UI.md §2.7.1，本页签的主角）。
 * 同时回答三件事：SnowLuma 活没活 → QQ 登没登 → 桥接连没连上。
 * 按钮语义（§5.1）：「打开 SnowLuma 网页端」——启动进程已移交 start.bat，
 * 按钮只做"用系统默认浏览器打开 consoleUrl"，不管也不该管启动进程。
 */
function SnowlumaCard({ demo }: { demo: boolean }) {
  const [det, setDet] = useState<SnowlumaDetect | null>(null)
  const [pending, setPending] = useState(false) // 501：后端还没实现
  const [error, setError] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const [opening, setOpening] = useState(false)
  const [hintVisible, setHintVisible] = useState(!snowlumaHintDismissed)

  const detect = useCallback(async (silent = false): Promise<SnowlumaDetect | null> => {
    if (demo) {
      setDet(DEMO_DETECT)
      setPending(false)
      setError(null)
      return DEMO_DETECT
    }
    if (!silent) setProbing(true) // 探测有几百 ms 到 probeTimeoutMs 的耗时，显示转圈
    try {
      const d = await api.snowlumaDetect()
      setDet(d)
      setPending(false)
      setError(null)
      return d
    } catch (e) {
      if (isNotImplemented(e)) {
        setPending(true)
        setDet(null)
        setError(null)
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
      return null
    } finally {
      if (!silent) setProbing(false)
    }
  }, [demo])

  useEffect(() => {
    detect()
  }, [detect])

  /** 打开 SnowLuma 网页端。「浏览器打开了」≠「SnowLuma 在跑」，reachable=false 时 hint 不能吞。 */
  const openConsole = async () => {
    if (demo) {
      toast.info('演示模式：不会真的打开浏览器。')
      return
    }
    setOpening(true)
    try {
      const r = await api.snowlumaStart()
      if (r.reachable) {
        toast.success(r.hint ?? '已打开 SnowLuma 网页端。')
      } else {
        toast.warning(r.hint ?? '已打开浏览器，但那个地址现在没有服务——SnowLuma 可能没在运行。', {
          duration: 10_000,
        })
      }
    } catch (e) {
      if (isNotImplemented(e)) {
        setPending(true)
        toast.error('后端还没实现这个功能。')
      } else {
        toast.error(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setOpening(false)
    }
  }

  const state = det ? SNOWLUMA_STATE[det.status] : null

  // 「一个候选位置都没找到」= `launch.cmd` 为空。注意这与"没在运行"是**两件事**：
  // 装好了没启动 → cmd 有值、状态是 offline；压根没装 → cmd 为空。
  // 只有后者才该提示"去下载"。
  const notFound = Boolean(det && !det.launch?.cmd)

  // ★ 是否已钩住 QQ（§2.7.0）：已钩住 = OneBot 端口在监听（httpReachable）。
  //   SnowLuma 是钩住 QQ 之后才开 3000/3001 的；控制台通但 3000 不通
  //   = 「在跑但没钩住」，排查方向是"钩"，不是"启动" —— 文案必须分清。
  const hooked = det?.httpReachable === true
  const runningButNotHooked = det?.httpReachable === false && det?.consoleReachable === true

  // launch.cmd 与 launch.cwd 指向不同目录 = 几乎一定配错了：
  // launcher.bat 里的相对路径按 cwd 解析，跑起来的会是另一份安装（真实踩过的坑）。
  const launchMismatch = Boolean(
    det?.launch?.cmd && det?.launch?.cwd && dirOf(det.launch.cmd) !== normDir(det.launch.cwd),
  )

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Rocket className="h-4 w-4" />
            SnowLuma 进程
          </CardTitle>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={openConsole}
              disabled={pending || opening}
              title="用系统默认浏览器打开 SnowLuma 网页端（不启动进程）"
            >
              {opening ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <SquareArrowOutUpRight className="mr-1 h-3.5 w-3.5" />
              )}
              {opening ? '正在打开…' : '打开 SnowLuma 网页端'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => detect()}
              disabled={probing || opening}
            >
              {probing ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1 h-3.5 w-3.5" />
              )}
              刷新
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* ★ 没找到 SnowLuma：本包**不含**它（许可证不允许随第三方安装包分发）。
            这是发布包用户第一次打开界面时最可能遇到的状态，必须主动说清楚，
            否则他会以为"打包漏了"或"程序坏了"。 */}
        {notFound && hintVisible && (
          <div className="rounded-md border border-amber-300 bg-amber-50/70 px-3 py-2.5">
            <div className="flex items-start gap-2">
              <Rocket className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="flex-1 space-y-1.5 text-sm leading-relaxed">
                <p className="font-medium text-amber-900">还没检测到 SnowLuma</p>
                <p className="text-xs text-amber-900/90">
                  <strong>本包不包含 SnowLuma</strong> —— 它的许可证不允许随第三方安装包分发。
                  请到官方发布页下载 <code className="rounded bg-white/70 px-1">win-x64</code> 版
                  （<strong>完整版自带 Node</strong>），解压到一个固定目录，然后回来点「刷新」。
                  也可以直接把入口文件路径填到下面「启动入口」里（例如
                  <code className="mx-1 rounded bg-white/70 px-1">…\snowluma\index.mjs</code>）。
                </p>
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      // 打开官方下载页。用 <a> 而不是 window.open：让浏览器按"新标签/新窗口"
                      // 的默认设置处理，也不受弹窗拦截影响。
                      window.open(SNOWLUMA_DOWNLOAD_URL, '_blank', 'noopener,noreferrer')
                    }}
                  >
                    <SquareArrowOutUpRight className="mr-1 h-3.5 w-3.5" />
                    前往下载页
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => detect()}
                    disabled={probing}
                  >
                    {probing ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    )}
                    重新检测
                  </Button>
                  <button
                    type="button"
                    className="ml-auto inline-flex items-center gap-1 text-xs text-amber-800/80 underline-offset-2 hover:underline"
                    onClick={() => {
                      snowlumaHintDismissed = true
                      setHintVisible(false)
                    }}
                  >
                    <X className="h-3 w-3" />
                    知道了
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {pending ? (
          <InlineNote level="info">
            探测 SnowLuma 的后端接口还没实现（CONFIG-UI.md §5.1，目前返回 501），按钮先禁用。
            接口落地后这张卡片自动可用，界面不用再改。
          </InlineNote>
        ) : error ? (
          <InlineNote level="warn">{error}</InlineNote>
        ) : probing && !det ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在探测 SnowLuma（最长约 1.5 秒）…
          </div>
        ) : det && state ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className={cn('inline-block h-2.5 w-2.5 rounded-full', state.dot)} />
              <span className={cn('text-sm font-semibold', state.textClass)}>{state.label}</span>
              {det.login && det.loggedIn && (
                <span className="text-xs text-muted-foreground">
                  {det.login.nickname}（{det.login.userId}）
                </span>
              )}
            </div>
            {/* hint 直接显示，不重写 */}
            <p className="text-sm text-muted-foreground">{det.hint ?? state.text}</p>
            <p className="text-xs text-muted-foreground">
              连接地址：
              <code className="mx-1 rounded bg-muted px-1">{det.endpoint?.httpUrl ?? '—'}</code>（HTTP）
              <code className="mx-1 rounded bg-muted px-1">{det.endpoint?.wsUrl ?? '—'}</code>（WS）
            </p>
            {det.consoleUrl && (
              <p className="text-xs text-muted-foreground">
                网页端：<code className="rounded bg-muted px-1">{det.consoleUrl}</code>
              </p>
            )}
            {/* ★ 是否已钩住 QQ（§2.7.0）：排查「机器人不在线」第一个看的东西 */}
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">是否已钩住 QQ：</span>
              {hooked ? (
                <span className="flex items-center gap-1 text-emerald-700">
                  <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                  已钩住（OneBot 端口在监听）
                </span>
              ) : runningButNotHooked ? (
                <span className="flex items-center gap-1 text-amber-700">
                  <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
                  没钩住——SnowLuma 在跑但没钩住 QQ
                </span>
              ) : (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <span className="inline-block h-2 w-2 rounded-full bg-gray-400" />
                  {det.consoleReachable === false ? '谈不上（SnowLuma 没在跑）' : '未知'}
                </span>
              )}
            </div>
            {runningButNotHooked && (
              <InlineNote level="warn">
                <strong>SnowLuma 在跑但没钩住 QQ</strong>——OneBot 端口（3000/3001）根本没开，
                桥接连不上是当然的。按顺序处理：
                <strong className="text-foreground">①</strong> 在 SnowLuma 控制台（网页端）里确认已加载；
                <strong className="text-foreground">②</strong> 先起 SnowLuma 再开 QQ（注入挂在「进程被发现」事件上，不是定时扫）；
                <strong className="text-foreground">③</strong> 顺序反了（QQ 已在跑）就重启一次 QQ。
                若每次都要手动加载，把 SnowLuma 自己 config/runtime.json 的 hookAutoLoad 设为 true。
              </InlineNote>
            )}
            {/* 启动入口与工作目录要放在一起看：不一致几乎一定是配错了（§2.7.0 真实故障） */}
            {det.launch?.cmd && (
              <div className="space-y-1 text-xs text-muted-foreground">
                <p>
                  启动入口：<code className="rounded bg-muted px-1">{det.launch.cmd}</code>
                  {det.launch.from && <span className="ml-1">（{det.launch.from}）</span>}
                </p>
                {det.launch.cwd && (
                  <p>
                    工作目录：<code className="rounded bg-muted px-1">{det.launch.cwd}</code>
                  </p>
                )}
              </div>
            )}
            {launchMismatch && (
              <InlineNote level="danger">
                <strong>启动入口与工作目录不在同一份安装目录</strong>——启动脚本里的相对路径按
                <strong>工作目录</strong>解析，真正跑起来的可能是另一份 SnowLuma（用另一份的 token，
                桥接会一直 401）。排查「机器人不在线」时先对这两个路径。
              </InlineNote>
            )}
            {/* token 排查信息（§5.1）：不一致时说明 config.json 里那份已过期 */}
            {det.tokenSource && (
              <p className="text-xs text-muted-foreground">
                token 来源：{det.tokenSource}
              </p>
            )}
            {det.tokenDiffersFromConfig && (
              <InlineNote level="warn">
                config.json 里的 token 与正在跑的 SnowLuma <strong>不一致</strong>——
                那份是过期的，<strong>别用它</strong>（以 SnowLuma 自己的 config/onebot_&lt;uin&gt;.json 为准）。
              </InlineNote>
            )}
          </div>
        ) : null}

        {/* 三条必须说明的 */}
        <div className="space-y-1 border-t pt-3 text-xs leading-relaxed text-muted-foreground">
          <p>① 只有 SnowLuma 和桥接在<strong className="text-foreground">同一台机器</strong>上，这里的操作才有意义（接口只监听 127.0.0.1，不能跨机器）。</p>
          <p>② 按钮只负责<strong className="text-foreground">打开网页端</strong>；启动进程已移交 <code className="rounded bg-muted px-1">start.bat</code>（启动桥接前先拉起 SnowLuma，已在跑就跳过）——在界面上重复启动会开出第二个实例，所以按钮不管启动。</p>
          <p>③「浏览器打开了」≠「SnowLuma 在跑」：网页端是 SnowLuma 的一部分，它没跑时那个页面根本不存在。</p>
        </div>
      </CardContent>
    </Card>
  )
}

export function ProtocolTab({
  cfg,
  patch,
  tokens,
  setTokens,
  demo,
  status,
}: {
  cfg: Record<string, unknown>
  patch: (path: string, value: unknown) => void
  tokens: TokenDraft
  setTokens: (t: TokenDraft) => void
  demo: boolean
  /** 运行状态（含进程登记）。用于显示"是不是还有别的桥接在跑"。 */
  status?: ApiStatus | null
}) {
  const wsUrl = getStr(cfg, 'onebot.wsUrl', 'ws://127.0.0.1:3001')
  const httpUrl = getStr(cfg, 'onebot.httpUrl', 'http://127.0.0.1:3000')
  const hasWsToken = getBool(cfg, 'hasWsToken', false)
  const hasHttpToken = getBool(cfg, 'hasHttpToken', false)
  const adminUsers = getStrArr(cfg, 'access.adminUsers', [])
  const conflicts = status?.processes?.conflicts ?? []

  return (
    <div className="space-y-4">
      {/* ★ H13：协议端账号（只给摘要、**绝不回 token**）。
          放最前面是因为"用错了哪份凭据"是"机器人完全不说话"的头号原因（踩过两次）。 */}
      <AccountsCard demo={demo} />

      {/* ★ 进程冲突（缺陷 3）：放在最前面，因为它是最容易"看不出问题"的一类故障 ——
          两个桥接同时从同一个 OneBot 收事件，每个实例自己都完全正常，
          合起来表现为"同一句话被回两次"。 */}
      {conflicts.length > 0 && (
        <InlineNote level="danger">
          <strong>检测到还有别的桥接在跑</strong>（pid {conflicts.map((c) => c.pid).join('、')}）。
          同时跑两个会抢同一个 OneBot 事件流 —— 同一句话可能被回答两次，而每个实例
          自己看上去都正常。
          <br />
          停掉多余的：
          <code className="mx-1 rounded bg-white/60 px-1">
            node src/index.mjs --processes --kill &lt;pid&gt;
          </code>
        </InlineNote>
      )}

      {/* 管理员白名单：空 = 谁都不能用，必须醒目 */}
      {adminUsers.length === 0 && (
        <InlineNote level="danger">
          <strong>白名单为空 = 没有人可以使用这个机器人</strong>
          （这是刻意的安全设计）。请在下方填入你自己的 QQ 号（
          <strong>不是机器人自己的号</strong>）。
        </InlineNote>
      )}

      {/* SnowLuma 进程卡：本页签的主角，放最顶上 */}
      <SnowlumaCard demo={demo} />

      {/* SnowLuma 终端面板（§2.7.3）：输出在界面里看，不用留着黑窗口 */}
      <SnowlumaTerminal demo={demo} />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Plug className="h-4 w-4" />
            OneBot 连接（SnowLuma）
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          <FieldRow label="WebSocket 地址" hint="收事件。SnowLuma 默认端口 3001。">
            <Input
              value={wsUrl}
              onChange={(e) => patch('onebot.wsUrl', e.target.value)}
              className="max-w-md font-mono text-sm"
              placeholder="ws://127.0.0.1:3001"
            />
          </FieldRow>
          <FieldRow label="HTTP 地址" hint="发消息。SnowLuma 默认端口 3000。">
            <div className="space-y-2">
              <Input
                value={httpUrl}
                onChange={(e) => patch('onebot.httpUrl', e.target.value)}
                className="max-w-md font-mono text-sm"
                placeholder="http://127.0.0.1:3000"
              />
              {samePort(wsUrl, httpUrl) && (
                <InlineNote level="danger">
                  两个地址指向了同一个端口；SnowLuma 默认 3001=WS、3000=HTTP，检查一下是不是填反了。
                </InlineNote>
              )}
            </div>
          </FieldRow>
          <FieldRow label="机器人 QQ 号" hint="留空自动从 get_login_info 学习，一般不用填。">
            <Input
              value={getStr(cfg, 'onebot.selfId')}
              onChange={(e) => patch('onebot.selfId', e.target.value)}
              className="max-w-xs font-mono text-sm"
              placeholder="留空自动学习"
            />
          </FieldRow>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" />
            ★ 访问令牌（两个，不是同一个值）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <InlineNote level="warn">
            SnowLuma 的 HTTP 与 WebSocket 用的是<strong>两个不同的 accessToken</strong>。
            这与 NapCat 的常见做法不同。填错的表现是「连上了但一直 401」。
          </InlineNote>
          <div className="divide-y rounded-md border">
            <FieldRow
              label="WebSocket Token"
              hint="留空 = 保持原样不修改。"
              className="px-3"
            >
              <Input
                type="password"
                value={tokens.wsToken}
                onChange={(e) => setTokens({ ...tokens, wsToken: e.target.value })}
                className="max-w-md font-mono text-sm"
                placeholder={hasWsToken ? '已配置（留空即不修改）' : '尚未配置'}
                autoComplete="new-password"
              />
            </FieldRow>
            <FieldRow
              label="HTTP Token"
              hint="留空 = 保持原样不修改。"
              className="px-3"
            >
              <Input
                type="password"
                value={tokens.httpToken}
                onChange={(e) => setTokens({ ...tokens, httpToken: e.target.value })}
                className="max-w-md font-mono text-sm"
                placeholder={hasHttpToken ? '已配置（留空即不修改）' : '尚未配置'}
                autoComplete="new-password"
              />
            </FieldRow>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">SnowLuma 启动与控制台</CardTitle>
          <p className="text-xs text-muted-foreground">
            启动进程由 <code className="rounded bg-muted px-1">start.bat</code> 负责（启动桥接前先拉起
            SnowLuma，已在跑就跳过）；这里配置它用的入口与网页端地址。
            <strong className="text-foreground">本机可能装了不止一份 SnowLuma</strong>
            ——入口认错了，启动的就不是你正在用的那个，甚至会在同一端口撞车。
          </p>
        </CardHeader>
        <CardContent className="divide-y">
          <FieldRow
            label="启动入口"
            hint="要填【文件】，不是文件夹 —— 例如 C:\SnowLuma\index.mjs。留空则由自动发现去猜（包内 vendor/snowluma → snowluma.searchPaths → 环境变量 SNOWLUMA_HOME）。"
          >
            <Input
              value={getStr(cfg, 'snowluma.launchCmd')}
              onChange={(e) => patch('snowluma.launchCmd', e.target.value)}
              className="max-w-md font-mono text-sm"
              placeholder="留空（推荐）或 …\snowluma\index.mjs"
            />
          </FieldRow>
          <FieldRow
            label="搜索路径"
            hint="一行一个。SnowLuma 装在哪不想写进上面那个字段时用它（那个字段会覆盖自动发现，这里只是补充候选）。相对路径按本包根目录解析。"
          >
            <textarea
              value={getStrArr(cfg, 'snowluma.searchPaths', []).join('\n')}
              onChange={(e) =>
                patch(
                  'snowluma.searchPaths',
                  e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                )
              }
              rows={2}
              className="w-full max-w-md rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder={'D:\\apps\\snowluma\nE:\\qq\\snowluma'}
            />
          </FieldRow>
          <FieldRow label="启动工作目录" hint="留空则用启动入口所在的目录。">
            <Input
              value={getStr(cfg, 'snowluma.launchCwd')}
              onChange={(e) => patch('snowluma.launchCwd', e.target.value)}
              className="max-w-md font-mono text-sm"
              placeholder="留空自动取入口所在目录"
            />
          </FieldRow>
          <FieldRow
            label="网页端地址"
            hint="「打开 SnowLuma 网页端」按钮打开的地址。默认 5099 端口来自 SnowLuma 自己的 config/runtime.json（webuiPort），改过那个值这里要跟着改。"
          >
            <Input
              value={getStr(cfg, 'snowluma.consoleUrl', 'http://127.0.0.1:5099/')}
              onChange={(e) => patch('snowluma.consoleUrl', e.target.value)}
              className="max-w-md font-mono text-sm"
              placeholder="http://127.0.0.1:5099/"
            />
          </FieldRow>
          <FieldRow label="探测超时" hint="探测 SnowLuma 是否在线的超时。">
            <NumInput
              value={getNum(cfg, 'snowluma.probeTimeoutMs', 1500)}
              onChange={(n) => patch('snowluma.probeTimeoutMs', n)}
              unit="毫秒"
              min={200}
              max={10000}
            />
          </FieldRow>
        </CardContent>
      </Card>

      {/* ★★ 名单与权限（三级，§2.7.4）：管理员 / 私聊白名单 / 群白名单，各管一件事 */}
      <AccessCard cfg={cfg} patch={patch} demo={demo} />
    </div>
  )
}
