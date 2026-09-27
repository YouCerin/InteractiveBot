import { useCallback, useEffect, useRef, useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Toaster, toast } from 'sonner'
import { api, ApiError, type ApiStatus } from '@/lib/api'
import { DEMO_CONFIG, DEMO_STATUS, setPath } from '@/lib/config'
import { StatusBar } from '@/components/StatusBar'
import { ConfirmDialog, InlineNote, type ConfirmRequest } from '@/components/common'
import { OverviewTab } from '@/sections/OverviewTab'
import { ConversationsTab } from '@/sections/ConversationsTab'
import { PersonaTab } from '@/sections/PersonaTab'
import { PaceTab } from '@/sections/PaceTab'
import { MemoryTab } from '@/sections/MemoryTab'
import { ExtensionsTab } from '@/sections/ExtensionsTab'
import { ProtocolTab, type TokenDraft } from '@/sections/ProtocolTab'
import { AdvancedTab } from '@/sections/AdvancedTab'
import {
  Bot,
  CircleAlert,
  Eye,
  LayoutDashboard,
  Loader2,
  MemoryStick,
  MessagesSquare,
  Plug,
  Puzzle,
  Save,
  Settings2,
  Timer,
  UserRound,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 配置前缀 → 页签（0.2.2「未保存的改动要看得见」：给改动过的页签加小圆点）。
 * 触发已并入人设、QQ 功能已并入扩展 —— 映射跟着新结构走。
 */
function pathToTab(path: string): string | null {
  if (path === 'dsh.workspace') return 'memory' // 工作区目录在记忆页
  const head = path.split('.')[0]
  switch (head) {
    case 'persona':
    case 'trigger':
      return 'persona'
    case 'humanize':
    case 'send':
    case 'usage':
    case 'turn':
      return 'pace'
    case 'memory':
    case 'image':
      return 'memory'
    case 'mcp':
    case 'skills':
    case 'security':
    case 'wake':
    case 'delivery':
    case 'corpus':
      return 'extensions'
    case 'onebot':
    case 'snowluma':
    case 'access':
      return 'protocol'
    case 'dsh':
    case 'session':
    case 'ui':
      return 'advanced'
    default:
      return null
  }
}

/** 未保存改动的小圆点（0.2.2 修正②）：切走也知道哪一页改过。 */
function DirtyDot() {
  return <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="这一页有未保存的改动" />
}

/** 从编辑中的配置里构造保存补丁：剔除 has* 标记；密钥留空则不放字段（后端把空值当"不修改"）。 */
function buildPatch(
  cfg: Record<string, unknown>,
  tokens: TokenDraft,
  apiKey: string,
): Record<string, unknown> {
  const clean = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>
  // ★ 这些 has* 是**后端给界面看的标记**，不是配置。不删掉就会被当成配置
  //   永久写进 config.json（没有任何测试会拦住这种脏键）。
  delete clean.hasWsToken
  delete clean.hasHttpToken
  delete clean.hasApiKey
  // ★ 0.2.3：判定专用 key 的标记。**必须一起删** —— 它是后端给界面看的标记，
  //   留着就会被当成配置永久写进 config.json（没有任何测试会拦住这种脏键）。
  delete clean.hasJudgeKey
  if (tokens.wsToken.trim()) {
    ;(clean.onebot as Record<string, unknown>).wsToken = tokens.wsToken.trim()
  }
  if (tokens.httpToken.trim()) {
    ;(clean.onebot as Record<string, unknown>).httpToken = tokens.httpToken.trim()
  }
  if (apiKey.trim()) {
    ;(clean.dsh as Record<string, unknown>).apiKey = apiKey.trim()
  }
  return clean
}

export default function Home() {
  const [cfg, setCfg] = useState<Record<string, unknown> | null>(null)
  const [status, setStatus] = useState<ApiStatus | null>(null)
  const [offline, setOffline] = useState(false)
  const [demo, setDemo] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)
  const [fatalList, setFatalList] = useState<string[]>([])
  const [tokens, setTokens] = useState<TokenDraft>({ wsToken: '', httpToken: '' })
  // 模型 API key 的**草稿态**：和上面的 token 一样，值**不进 `cfg`**。
  // 为什么不能直接 `patch('dsh.apiKey', v)`：`cfg` 是 `GET /api/config` 回填的
  // 脱敏配置，而保存时整份 `cfg` 会被序列化提交 —— 把明文 key 放进 `cfg`，
  // 它就会长期留在浏览器状态里，且编辑框一空就会提交空串（后端当"不修改"，
  // 看起来没事，但语义会变得含糊）。草稿态是照着既有 token 的模式来的。
  const [apiKey, setApiKey] = useState('')
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null)
  const [tab, setTab] = useState('overview')
  // 未保存改动落在哪些页签（小圆点）：切走也知道哪一页改过
  const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set())
  const [restarting, setRestarting] = useState(false)
  const demoRef = useRef(demo)
  demoRef.current = demo
  const restartingRef = useRef(restarting)
  restartingRef.current = restarting

  const loadAll = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true)
    try {
      const [c, s] = await Promise.all([api.getConfig(), api.status()])
      if (demoRef.current) return // 演示模式下不回填真实数据
      setCfg(c)
      setStatus(s)
      setOffline(false)
      setDirty(false)
      setDirtyTabs(new Set())
      setFatalList([])
    } catch {
      if (!demoRef.current) setOffline(true)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    loadAll()
    const timer = setInterval(() => {
      // 状态条轮询；配置不轮询，避免覆盖用户未保存的编辑
      api
        .status()
        .then((s) => {
          if (!demoRef.current) {
            setStatus(s)
            setOffline(false)
          }
        })
        .catch(() => {
          // 重启期间接口短暂断开是预期行为，不翻成"未连接"
          if (!demoRef.current && !restartingRef.current) setOffline(true)
        })
    }, 5000)
    return () => clearInterval(timer)
  }, [loadAll])

  const enterDemo = () => {
    setDemo(true)
    setOffline(false)
    setCfg(JSON.parse(JSON.stringify(DEMO_CONFIG)))
    setStatus(DEMO_STATUS as ApiStatus)
    setLoading(false)
    setDirty(false)
  }

  const exitDemo = () => {
    setDemo(false)
    setCfg(null)
    setStatus(null)
    setLoading(true)
    loadAll()
  }

  /** 重启：请求后端 → 轮询等新进程起来 → 重新加载并清掉"待重启"角标。 */
  const doRestart = useCallback(async () => {
    if (demoRef.current) {
      toast.info('演示模式：不会真的重启。')
      return
    }
    try {
      await api.restart()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      return
    }
    setRestarting(true)
    setOffline(false)
    const deadline = Date.now() + 90_000
    const tick = async () => {
      try {
        await api.status()
        setRestarting(false)
        setRestartRequired(false)
        await loadAll()
        toast.success('重启完成，新配置已生效。')
      } catch {
        if (Date.now() < deadline) {
          setTimeout(tick, 2000)
        } else {
          setRestarting(false)
          toast.error('等了很久还没起来。请去机器人目录看 logs/bridge.log，或用 start.bat 手动启动。')
        }
      }
    }
    // 旧进程有约 400ms 的响应窗口才退出，稍等再开始探
    setTimeout(tick, 1500)
  }, [loadAll])

  const doStop = useCallback(async () => {
    if (demoRef.current) {
      toast.info('演示模式：不会真的停止。')
      return
    }
    try {
      // ★ 「停止」必须说明停掉之后要用什么再起来 —— 这句话由后端 hint 给，
      //   前端不写死（CONFIG-UI.md §2.7.5 D）。
      const result = await api.stop()
      toast.info(result.hint ?? '机器人正在停止…再次启动请双击 启动机器人.bat。')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
    // 之后的轮询会发现接口断开，界面自动进入"未连接"状态
  }, [])

  const patch = useCallback((path: string, value: unknown) => {
    setCfg((prev) => (prev ? setPath(prev, path, value) : prev))
    setDirty(true)
    const t = pathToTab(path)
    if (t) setDirtyTabs((prev) => (prev.has(t) ? prev : new Set(prev).add(t)))
  }, [])

  const patchMany = useCallback((entries: [string, unknown][]) => {
    setCfg((prev) => {
      if (!prev) return prev
      let next = prev
      for (const [p, v] of entries) next = setPath(next, p, v)
      return next
    })
    setDirty(true)
    setDirtyTabs((prev) => {
      const next = new Set(prev)
      for (const [p] of entries) {
        const t = pathToTab(p)
        if (t) next.add(t)
      }
      return next
    })
  }, [])

  const save = async () => {
    if (!cfg) return
    if (demo) {
      toast.info('演示模式：改动不会真正保存。启动机器人后再来保存。')
      return
    }
    setSaving(true)
    setFatalList([])
    try {
      const result = await api.saveConfig(buildPatch(cfg, tokens, apiKey))
      setDirty(false)
      setDirtyTabs(new Set())
      setTokens({ wsToken: '', httpToken: '' })
      setApiKey('')
      if (result.restartRequired) {
        setRestartRequired(true)
        toast.warning('已保存。需要重启机器人才会生效。', {
          duration: 10_000,
          action: { label: '立即重启', onClick: () => doRestart() },
        })
      } else {
        toast.success(result.hint ?? '已保存。')
      }
      // 重新拉一次脱敏配置，保持 has* 标记与后端一致
      loadAll()
    } catch (e) {
      if (e instanceof ApiError && e.fatal?.length) {
        // 后端校验拦下：fatal 原文展示，不自己编
        setFatalList(e.fatal)
        toast.error(e.message)
      } else {
        toast.error(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setSaving(false)
    }
  }

  const runCheck = async () => {
    if (!cfg) return
    if (demo) {
      toast.info('演示模式：检查需要桥接在线。')
      return
    }
    try {
      const result = await api.check(buildPatch(cfg, tokens, apiKey))
      setFatalList(result.fatal)
      if (result.fatal.length === 0 && result.warn.length === 0) {
        toast.success('检查通过，没有发现问题。')
      } else {
        for (const w of result.warn) toast.warning(w, { duration: 8000 })
        for (const f of result.fatal) toast.error(f, { duration: 8000 })
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  // ── 重启中：接口短暂断开是预期行为，给一个明确的等待页 ─────────────────
  if (restarting) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-muted/40 px-4">
        <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
        <h1 className="text-xl font-semibold">正在重启机器人…</h1>
        <p className="text-sm text-muted-foreground">界面会断开几秒钟，恢复后新配置即生效。</p>
        <Toaster richColors position="top-center" />
      </div>
    )
  }

  // ── 离线且未进演示：连接引导页 ──────────────────────────────────────────
  if (!loading && offline && !demo) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-muted/40 px-4">
        <Bot className="h-12 w-12 text-muted-foreground" />
        <h1 className="text-xl font-semibold">连不上机器人</h1>
        <p className="max-w-md text-center text-sm leading-relaxed text-muted-foreground">
          配置接口（http://127.0.0.1:3410）没有响应。机器人没启动时接口也不在线—— 先在机器人目录里双击
          <code className="mx-1 rounded bg-muted px-1.5 py-0.5">启动机器人.bat</code>
          启动它（0.2.3 起后台启动，不会留黑窗口），然后回到这里刷新。
        </p>
        <div className="flex gap-2">
          <Button onClick={() => loadAll(true)} disabled={refreshing}>
            {refreshing ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            重试连接
          </Button>
          <Button variant="outline" onClick={enterDemo}>
            <Eye className="mr-1 h-4 w-4" />
            先看看界面（演示数据）
          </Button>
        </div>
        <Toaster richColors position="top-center" />
      </div>
    )
  }

  if (loading || !cfg) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        正在读取配置…
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-muted/40">
      <StatusBar
        status={status}
        offline={offline}
        demo={demo}
        restartRequired={restartRequired}
        restarting={restarting}
        onRefresh={() => loadAll(true)}
        refreshing={refreshing}
        onRestart={doRestart}
        onStop={doStop}
      />

      <main className="mx-auto max-w-6xl px-4 pt-4 pb-28">
        {demo && (
          <InlineNote level="info" className="mb-4">
            正在浏览<strong>演示数据</strong>，改动不会保存。
            <button className="ml-2 underline" onClick={exitDemo}>
              退出演示，重新连接
            </button>
          </InlineNote>
        )}

        {/* ★ 构建溯源（CONFIG-UI.md「界面产物与源码是不是同一份」）：
            不是 fresh 就必须明说"你看到的是旧界面"并给出可执行的修法 ——
            使用者拿着旧界面报 bug，排查会从完全错误的前提出发。
            三种状态分开：stale = 源码改了没重新构建；unstamped = 没有标记、无法自证来源
            （重新构建也没用，要删掉重建）。 */}
        {!demo && status?.ui && status.ui.status !== 'fresh' && (
          <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
            <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-amber-900">
              <CircleAlert className="h-4 w-4" />
              你看到的是旧界面（构建溯源：{status.ui.status === 'stale' ? '源码改了没重新构建' : status.ui.status === 'unstamped' ? '没有构建标记，无法自证来源' : status.ui.status}）
            </div>
            <p className="text-sm text-amber-900">
              {status.ui.why && <>{status.ui.why}。</>}
              {status.ui.advice && (
                <>
                  修法：<code className="rounded bg-white/60 px-1.5 py-0.5 text-xs">{status.ui.advice}</code>
                </>
              )}
            </p>
          </div>
        )}

        {fatalList.length > 0 && (
          <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-3">
            <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-red-800">
              <CircleAlert className="h-4 w-4" />
              配置有问题，已拒绝保存
            </div>
            <ul className="list-disc space-y-1 pl-8 text-sm text-red-800">
              {fatalList.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </div>
        )}

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4 flex h-auto flex-wrap justify-start">
            {/* 0.2.2 加减法：触发并入人设、QQ 功能并入扩展、新增「扩展」页签。
                页签上不放生效方式徽标（按主人要求保持干净）；保存后需要重启时，
                由顶部状态条的「有改动待重启生效」角标统一提示（restartRequired 一路接过来的）。 */}
            <TabsTrigger value="overview" className="gap-1.5">
              <LayoutDashboard className="h-3.5 w-3.5" />
              概览
            </TabsTrigger>
            <TabsTrigger value="conversations" className="gap-1.5">
              <MessagesSquare className="h-3.5 w-3.5" />
              对话
            </TabsTrigger>
            <TabsTrigger value="persona" className="gap-1.5">
              <UserRound className="h-3.5 w-3.5" />
              人设
              {dirtyTabs.has('persona') && <DirtyDot />}
            </TabsTrigger>
            <TabsTrigger value="pace" className="gap-1.5">
              <Timer className="h-3.5 w-3.5" />
              节奏与成本
              <span className="text-amber-500">★</span>
              {dirtyTabs.has('pace') && <DirtyDot />}
            </TabsTrigger>
            <TabsTrigger value="memory" className="gap-1.5">
              <MemoryStick className="h-3.5 w-3.5" />
              记忆
              {dirtyTabs.has('memory') && <DirtyDot />}
            </TabsTrigger>
            <TabsTrigger value="extensions" className="gap-1.5">
              <Puzzle className="h-3.5 w-3.5" />
              扩展
              {dirtyTabs.has('extensions') && <DirtyDot />}
            </TabsTrigger>
            <TabsTrigger value="protocol" className="gap-1.5">
              <Plug className="h-3.5 w-3.5" />
              协议端
              {dirtyTabs.has('protocol') && <DirtyDot />}
            </TabsTrigger>
            <TabsTrigger value="advanced" className="gap-1.5">
              <Settings2 className="h-3.5 w-3.5" />
              高级
              {dirtyTabs.has('advanced') && <DirtyDot />}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <OverviewTab status={status} cfg={cfg} demo={demo} />
          </TabsContent>
          <TabsContent value="conversations">
            <ConversationsTab
              botName={status?.login?.nickname}
              groupEnabled={status?.groupEnabled ?? false}
              demo={demo}
            />
          </TabsContent>
          <TabsContent value="persona">
            {/* ★ 0.2.3：本页**不再需要** cfg / patch / askConfirm —— 它唯一用到它们的
                那一节（「什么时候回我」）已搬到「扩展 → 唤醒策略」卡里（`WakeRulesSection`）。 */}
            <PersonaTab />
          </TabsContent>
          <TabsContent value="pace">
            <PaceTab cfg={cfg} patch={patch} patchMany={patchMany} askConfirm={setConfirmReq} />
          </TabsContent>
          <TabsContent value="memory">
            <MemoryTab cfg={cfg} patch={patch} demo={demo} />
          </TabsContent>
          <TabsContent value="extensions">
            <ExtensionsTab
              cfg={cfg}
              patch={patch}
              demo={demo}
              askConfirm={setConfirmReq}
              onNavigateTab={setTab}
            />
          </TabsContent>
          <TabsContent value="protocol">
            <ProtocolTab
              cfg={cfg}
              patch={patch}
              tokens={tokens}
              setTokens={setTokens}
              demo={demo}
              status={status}
            />
          </TabsContent>
          <TabsContent value="advanced">
            <AdvancedTab
              cfg={cfg}
              patch={patch}
              askConfirm={setConfirmReq}
              apiKey={apiKey}
              setApiKey={setApiKey}
              demo={demo}
            />
          </TabsContent>
        </Tabs>
      </main>

      {/* 底部保存条：有改动时浮出 */}
      <div
        className={cn(
          'fixed inset-x-0 bottom-0 z-20 border-t bg-card/95 backdrop-blur transition-transform duration-200',
          dirty ? 'translate-y-0' : 'translate-y-full',
        )}
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <Badge variant="outline" className="border-amber-400 text-amber-600">
            有未保存的改动
          </Badge>
          <span className="text-xs text-muted-foreground">
            生效方式以保存后接口返回的提示为准（配置类改动需要重启；扩展页的开关是即时生效的）
          </span>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={runCheck}>
              检查配置
            </Button>
            <Button variant="ghost" size="sm" onClick={() => loadAll(true)}>
              放弃改动
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
              保存
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog req={confirmReq} onClose={() => setConfirmReq(null)} />
      <Toaster richColors position="top-center" />
    </div>
  )
}
