import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Activity, Plus, RefreshCw, Server, ShieldQuestion, Trash2, Wrench } from 'lucide-react'

import { api, isNotImplemented, type ServerRow, type ServersResult } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { ConsolePanel } from '@/sections/ConsolePanel'
import { ServerForm } from '@/sections/ServerForm'

/**
 * 服务器页签（0.3.2 P2/P4，规格见 CONFIG-UI.md §2.12）。
 *
 * 它回答三个问题：**配了几台** · **现在连得上吗** · **监测到底有没有在跑**。
 *
 * ★★ 为什么这一页必须存在：监测是"出问题时主动播报"的能力，所以它坏掉时
 *   **没有任何人会当场发现** —— 表现只是"服务器挂了但它没说话"。
 *   而这一页要显示的是**活证据**（上次成功采样在多久之前），不是一个"监测中"的假状态。
 *
 * ★★ 三条必须显示的边界（不说清就会误导）：
 *   ① **归属**（是不是我起的）—— 它是"能不能重启"的**唯一依据**。不是 `bridge` 时
 *      重启会被拒（那是纪律），不显示出来使用者只会看到"它没动作"而原因完全猜不到；
 *   ② **活证据**："上次采样在 X 秒前"。只显示"监测中"的界面与真的在监测的界面
 *      **在截图上一模一样**；
 *   ③ **拿不到的事实说"拿不到"**，不许显示成 0（"0 人"与"不知道几个人"是两件事）。
 *
 * ★ 界面**不做**的事：不渲染"立刻重启"按钮（`start`/`stop` 走 CLI —— 那条路上是人在做），
 *   也不回显密码（后端只给 `passwordSet` 布尔）。
 */
export function ServerTab({ demo = false }: { demo?: boolean }) {
  const [data, setData] = useState<ServersResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  /** 表单：null = 不显示；'new' = 新建；一台 = 编辑 */
  const [editing, setEditing] = useState<ServerRow | 'new' | null>(null)
  /** 每秒刷一次"多久之前"（**只重渲染，不重新请求**） */
  const [, forceTick] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      setData(await api.servers())
      setUnsupported(false)
    } catch (e) {
      if (isNotImplemented(e)) setUnsupported(true)
      else setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (demo) return
    void load()
  }, [demo, load])

  // ★ "上次采样在多久前"必须会走字，否则它永远显示"3 秒前"（一个看着在动、其实是死的数字）
  useEffect(() => {
    if (demo) return
    const t = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [demo])

  const act = async (row: ServerRow, action: 'retry' | 'abandon') => {
    setBusyId(row.id)
    setNotice(null)
    try {
      const r = await api.serversAction(row.id, action)
      // ★ 后端给的 hint 是**如实提醒**（"这条不会立刻重启"）—— 照它显示，不自己编
      setNotice(r.hint ?? (action === 'retry' ? '已解除等指令' : '已标记放弃'))
      await load()
    } catch (e) {
      setNotice(`没改成：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  /** 打开编辑表单，并把表单滚到可见（**卡片在页尾时表单会出现在看不见的地方**） */
  const openForm = (row: ServerRow | 'new') => {
    setEditing(row)
    // 下一帧再滚（要等表单渲染出来）
    setTimeout(() => {
      try {
        document.querySelector('[data-server-form]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } catch {
        /* 拿不到就算了，不影响功能 */
      }
    }, 60)
  }

  const remove = async (row: ServerRow) => {
    // ★ 二次确认：删条目是"我不再管它了"，不是"删掉那个服务端" —— 但要挡住手滑
    const yes = window.confirm(
      `删掉服务器条目「${row.name}（${row.id}）」？\n\n` +
        '· 只是从 config.json 里移除，**不会停掉那个服务端**；\n' +
        '· 状态文件（归属证据 / 事件台账）**会保留** —— 删了就失去重启能力；\n' +
        '· 保存后即时生效，不必重启桥接。',
    )
    if (!yes) return
    setBusyId(row.id)
    setNotice(null)
    try {
      const r = await api.serversDelete(row.id)
      setNotice(`已删除（还剩 ${r.remaining} 台）。${r.note ?? ''}`)
      await load()
    } catch (e) {
      setNotice(`没删成：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  /** 主动检测结果（按 serverId 存；**不写进 `data`** —— 它是"点出来的"，不是采样那一份） */
  const [probes, setProbes] = useState<Record<string, { at: number; text: string; ok: boolean }>>({})

  const probe = async (row: ServerRow) => {
    setBusyId(`probe:${row.id}`)
    try {
      const r = await api.serversProbe(row.id)
      const snap = r.snapshot ?? {}
      const text = snap.reachable === true
        ? `通（在线 ${snap.players ?? '拿不到'} 人 · TPS ${snap.tps ?? '拿不到'}）`
        : `不通：${snap.error || (snap.skipped === 'disabled' ? '这台是停用的' : '没记下原因')}`
      setProbes((prev) => ({ ...prev, [row.id]: { at: Date.now(), text, ok: snap.reachable === true } }))
    } catch (e) {
      setProbes((prev) => ({ ...prev, [row.id]: { at: Date.now(), text: e instanceof Error ? e.message : String(e), ok: false } }))
    } finally {
      setBusyId(null)
    }
  }

  const agoText = (ms?: number | null) => {
    const v = Number(ms)
    if (!Number.isFinite(v) || v <= 0) return '还没采过样'
    const s = Math.max(0, Math.round((Date.now() - v) / 1000))
    if (s < 60) return `${s} 秒前`
    if (s < 3600) return `${Math.round(s / 60)} 分钟前`
    return `${(s / 3600).toFixed(1)} 小时前`
  }

  const fmtTime = (ms?: number | null) => {
    const v = Number(ms)
    if (!Number.isFinite(v) || v <= 0) return '—'
    try {
      return new Date(v).toLocaleString()
    } catch {
      return '—'
    }
  }

  if (demo || unsupported) return null

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4" />
            服务器监测
            <span className="text-muted-foreground text-xs font-normal">（问状态 · 出事主动报）</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="flex items-center gap-2">
              <span className={cn('inline-block h-2 w-2 rounded-full', data?.running ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
              {data?.enabled ? (data?.running ? '监测已开启' : '配了服务器，但监测循环**没在跑**') : '**没配服务器**（这一层完全不工作，也不发任何网络请求）'}
            </span>
            <span className="text-muted-foreground text-xs">
              采样间隔：{data?.pollMs ? `${Math.round(data.pollMs / 1000)} 秒` : '—'}
            </span>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} className="gap-1.5">
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              刷新
            </Button>
            <Button variant="outline" size="sm" onClick={() => openForm('new')} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              新增服务器
            </Button>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            ★ 这一层**默认不工作**：配置里 `servers` 为空时它一次网络请求都不发。采样只用**只读命令**
            （`list`），不会改服务端任何状态。
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            ★ **判据**：默认只把「连不上」算故障（连续失败若干次才判定，防抖动误报）；
            `rules` 里的 TPS / 人数阈值只产出**异常报告**，**不会重启** —— 因为「TPS 低就重启」是赌博。
          </p>
        </CardContent>
      </Card>

      {err && (
        <Card className="border-destructive/50">
          <CardContent className="pt-4 text-sm text-destructive">读不到服务器监测状态：{err}</CardContent>
        </Card>
      )}
      {notice && <div className="rounded-md border px-3 py-2 text-sm">{notice}</div>}

      {(data?.servers.length ?? 0) === 0 && (
        <Card>
          <CardContent className="pt-4 text-sm text-muted-foreground">
            还没配服务器。点上面的**「新增服务器」**加一条（也可直接改 `config.json` 的 `servers` 段），
            并在服务端的 `server.properties` 里开 `enable-rcon=true` + 设 `rcon.password`。
          </CardContent>
        </Card>
      )}

      {/* ★ 新增 / 编辑表单（保存后**即时生效**，不必重启桥接）*/}
      {editing !== null && (
        <div data-server-form>
          <ServerForm
            server={editing === 'new' ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={() => void load()}
          />
        </div>
      )}

      {data?.servers.map((s) => {
        const own = s.ownership
        const canRestart = own?.owner === 'bridge' && (s.startExeSet || s.startCommandSet)
        return (
          <Card key={s.id}>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                {s.name}
                <span className="text-muted-foreground text-xs font-normal">
                  {s.host}:{s.port} · RCON {s.rconPort}
                </span>
                <span className={cn('rounded px-1.5 py-0.5 text-xs', s.enabled ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground')}>
                  {s.enabled ? '启用' : '停用'}
                </span>
                {s.monitor && (
                  <span className={cn('rounded px-1.5 py-0.5 text-xs', s.monitor.phase === 'down' ? 'bg-red-500/10 text-red-600' : 'bg-emerald-500/10 text-emerald-600')}>
                    {s.monitor.phase === 'down' ? '🔴 down' : '🟢 up'}
                  </span>
                )}
                {/* ★★★ 启动窗口：**优先显示 🟡**（它比 up/down 更准确 —— 正在加载不是故障） */}
                {s.starting?.starting && (
                  <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600">
                    🟡 正在启动{Math.round(s.starting.waitedMs / 1000) > 0 ? `（已等 ${Math.round(s.starting.waitedMs / 1000)} 秒）` : ''}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-1.5">
                  <Button variant="outline" size="sm" disabled={busyId === s.id} onClick={() => openForm(s)}>
                    编辑
                  </Button>
                  <Button variant="ghost" size="sm" className="text-destructive" disabled={busyId === s.id} onClick={() => void remove(s)}>
                    <Trash2 className="h-3.5 w-3.5" />
                    删除
                  </Button>
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {/* ── ★★ 服务器状态检测（这一页最要紧的一块）── */}
              <div className="rounded-md border px-3 py-2">
                <div className="flex items-center gap-2 text-xs font-medium">
                  服务器状态检测
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto h-6 gap-1 px-2 text-xs"
                    disabled={busyId === `probe:${s.id}`}
                    onClick={() => void probe(s)}
                  >
                    <Activity className={cn('h-3.5 w-3.5', busyId === `probe:${s.id}` && 'animate-pulse')} />
                    {busyId === `probe:${s.id}` ? '检测中…' : '主动检测'}
                  </Button>
                </div>
                <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">
                  ★ 上面那个是**后台采样的活证据**；「主动检测」是**现在真连一次**。
                  两者不同：检测**不参与 up/down 判定**（点几次都不会把服务器"点成 down"）。
                </p>
                {s.starting?.starting ? (
                  <div className="mt-1 text-xs text-amber-600">
                    {s.starting.text || `🟡 正在启动（已等 ${Math.round(s.starting.waitedMs / 1000)} 秒）`}
                    <div className="text-muted-foreground mt-0.5">
                      ★ 这期间**不是故障**，所以「主动检测」会回"正在启动"而不是"连不上"。
                    </div>
                  </div>
                ) : s.starting?.expired ? (
                  <div className="mt-1 text-xs text-amber-600">
                    ⚠️ 启动**超时**（等了 {Math.round(s.starting.waitedMs / 1000)} 秒仍连不上）—— 之后按正常判据判 down。
                  </div>
                ) : s.monitor ? (
                  <div className="text-muted-foreground mt-1 space-y-0.5 text-xs">
                    <div>
                      上次采样：<span className="text-foreground">{agoText(s.monitor.lastAt)}</span> · 累计 {s.monitor.samples} 次 · 失败{' '}
                      {s.monitor.failures} 次
                    </div>
                    <div>
                      最近一次：
                      {s.monitor.lastReachable === false
                        ? s.monitor.lastError || '连不上（没记下原因）'
                        : `在线 ${s.monitor.lastPlayers ?? '拿不到'} 人 · TPS ${s.monitor.lastTps ?? '拿不到'}`}
                    </div>
                  </div>
                ) : (
                  <div className="text-muted-foreground mt-1 text-xs">
                    ⚠️ **还没采过样**（监测循环没在跑，或刚启动）—— 这一栏空着不等于"一切正常"。
                  </div>
                )}
                {/* ★ 主动检测的结果：**单独一块**（它不是采样那一份，不参与 up/down 判定） */}
                {probes[s.id] && (
                  <div className={cn('mt-2 border-t pt-1.5 text-xs', probes[s.id].ok ? 'text-emerald-600' : 'text-amber-600')}>
                    主动检测（{agoText(probes[s.id].at)}）：{probes[s.id].text}
                  </div>
                )}
              </div>

              {/* ── ★★ 归属：能不能重启的唯一依据 ── */}
              <div className="rounded-md border px-3 py-2">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <ShieldQuestion className="h-3.5 w-3.5" />
                  归属（**「能不能重启」只认它**）
                </div>
                <div className="mt-1 text-xs">
                  <span
                    className={cn(
                      'font-medium',
                      own?.owner === 'bridge' ? 'text-emerald-600' : own?.owner === 'external' ? 'text-amber-600' : 'text-muted-foreground',
                    )}
                  >
                    {own?.owner === 'bridge' ? '✅ 由本程序拉起' : own?.owner === 'external' ? '⚠️ 不是本程序拉起的' : '⛔ 没在跑'}
                    {own?.weak ? '（弱证据：命令行比对）' : ''}
                  </span>
                  {/* ★ 用户拍板的文案：括号里说清"什么情况下会自动重启" */}
                  <span className="text-muted-foreground">（只有本程序拉起的进程可自动重启）</span>
                  <div className="text-muted-foreground mt-0.5">{own?.why ?? '（拿不到归属信息）'}</div>
                  <div className="text-muted-foreground mt-1">
                    重启能力：<span className={cn(canRestart ? 'text-emerald-600' : 'text-amber-600')}>{canRestart ? '✅ 可用' : '⛔ 不可用'}</span>
                    {!s.startExeSet && !s.startCommandSet && '（没配 `startExe`/`startCommand` —— 我不知道怎么启动它）'}
                    {canRestart === false && own?.owner === 'bridge' && (s.startExeSet || s.startCommandSet) && '（已由本程序拉起，但当前处于冷却/等指令状态）'}
                  </div>
                </div>
              </div>

              {/* ── 重启状态 + 人工指令 ── */}
              <div className="rounded-md border px-3 py-2">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <Wrench className="h-3.5 w-3.5" />
                  重启状态
                </div>
                <div className="text-muted-foreground mt-1 space-y-0.5 text-xs">
                  <div>
                    尝试 {s.restart?.attempts ?? 0} 次 · 上次结果 {s.restart?.lastOutcome ?? '—'} · 上次尝试{' '}
                    {fmtTime(s.restart?.lastAttemptAt)}
                  </div>
                  <div>
                    {s.restart?.cooldownUntil && Number(s.restart.cooldownUntil) > Date.now()
                      ? `冷却中，到 ${fmtTime(s.restart.cooldownUntil)}`
                      : '不在冷却中'}
                    {s.restart?.waitingForAdmin ? ' · ⏳ **等你的指令**' : ''}
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Button variant="outline" size="sm" disabled={busyId === s.id} onClick={() => void act(s, 'retry')}>
                    再试一次
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busyId === s.id} onClick={() => void act(s, 'abandon')}>
                    放弃
                  </Button>
                  <span className="text-muted-foreground text-xs">
                    ★ 这两条只解除/恢复「自动重启」的资格，**不会立刻重启**（下一次检测到连不上时才动）
                  </span>
                </div>
              </div>

              {/* ── 控制台（0.3.2 收尾）：手动输指令 ── */}
              <ConsolePanel server={s} />

              {/* ── 配置摘要（**只显示配没配，不回显凭据**）── */}
              <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <span>RCON 密码：{s.passwordSet ? '已配置（不回显）' : '⚠️ 没配'}</span>
                <span>启动方式：{s.startExeSet ? `${s.startExe}（不走 shell）` : s.startCommandSet ? 'startCommand（走 shell）' : '⚠️ 没配'}</span>
                <span>
                  判 down 需连续失败 {s.failThreshold ?? '—'} 次
                </span>
                <span>
                  异常阈值：{s.rules.minTps ?? '—'} TPS / {s.rules.maxPlayers ?? '—'} 人
                  {s.tpsCommand ? `（TPS 命令：${s.tpsCommand}）` : '（没配 `tpsCommand` ⇒ **不问 TPS**，不是拿不到）'}
                  {s.manageOnStart
                    ? ' · 启动接管：开（桥接启动时会接管已在跑的、或拉起没在跑的；端口活着时绝不重复拉起）'
                    : ' · 启动接管：关（要手动 `supervise-server.bat start`）'}
                </span>
              </div>
            </CardContent>
          </Card>
        )
      })}

      {/* ── 最近事件（"它到底报过什么"）── */}
      {(data?.recentEvents.length ?? 0) > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertCircle className="h-4 w-4" />
              最近事件（{data?.recentEvents.length}）
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            {data?.recentEvents.map((e, i) => (
              <div key={`${e.at ?? i}`}>
                <span className="text-muted-foreground">{fmtTime(e.at)}</span> [{e.event}] {e.serverName}：{e.text}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
