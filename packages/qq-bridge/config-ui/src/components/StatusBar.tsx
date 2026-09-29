import { useEffect, useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { api, type ApiStatus, type DoctorResult, type PeakRule } from '@/lib/api'
import { computePeriod, PERIOD_REASON_TEXT } from '@/lib/config'
import { ConfirmDialog } from '@/components/common'
import {
  Activity,
  AlertTriangle,
  CircleCheck,
  CircleX,
  CircleHelp,
  Loader2,
  PlugZap,
  Power,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Stethoscope,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const PERMISSION_LABEL: Record<string, string> = {
  'read-only': '只读',
  'workspace-write': '仅工作区',
  'danger-full-access': '全权（危险）',
}

/** 演示模式下用的峰谷规则（与 prices.json 同形）。 */
const DEMO_PEAK: PeakRule = {
  timezone: 'Asia/Shanghai',
  windows: [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ],
  days: [1, 2, 3, 4, 5],
  holidays: [],
}

/**
 * 当前计费时段指示灯（CONFIG-UI.md §2.1.1）。
 * 用价目表的 peak 规则段 + 浏览器时间算；拉不到价目表时显示「时段未知」，
 * 绝不显示「低谷」（不知道就是不知道，显示低谷是撒谎）。
 */
function PeriodIndicator({ demo }: { demo: boolean }) {
  const [peak, setPeak] = useState<PeakRule | null | undefined>(undefined) // undefined=还没拉过
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    if (demo) {
      setPeak(DEMO_PEAK)
      return
    }
    let alive = true
    api
      .usagePrices()
      .then((p) => {
        if (alive) setPeak(p.loaded === false ? null : (p.peak ?? null))
      })
      .catch(() => {
        if (alive) setPeak(null) // 501/404/断开：时段未知
      })
    return () => {
      alive = false
    }
  }, [demo])

  // 每分钟重算一次：跨过 09:00 / 12:00 / 14:00 / 18:00 时灯会变
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  const result = useMemo(() => (peak ? computePeriod(peak, now) : null), [peak, now])
  const holidaysEmpty = !!peak && (peak.holidays?.length ?? 0) === 0

  if (peak === undefined) return null // 首次拉取中，先不占位

  const tip = result
    ? `${PERIOD_REASON_TEXT[result.reason]}（按浏览器时间、${peak?.timezone ?? 'Asia/Shanghai'} 时区判定）${
        holidaysEmpty ? '\n节假日表未维护，节假日会按高峰计价。今天的判定可能有偏差。' : ''
      }`
    : '拿不到价目表，无法判断现在是高峰还是低谷。'

  return (
    <span
      className="flex items-center gap-1.5 text-xs"
      title={tip}
    >
      <span
        className={cn(
          'inline-block h-2 w-2 rounded-full',
          result === null ? 'bg-gray-400' : result.isPeak ? 'bg-amber-500' : 'bg-emerald-500',
        )}
      />
      <span
        className={cn(
          result === null
            ? 'text-muted-foreground'
            : result.isPeak
              ? 'font-medium text-amber-600'
              : 'font-medium text-emerald-600',
        )}
      >
        {result ? result.indicator : '时段未知'}
      </span>
      {holidaysEmpty && result && (
        <CircleHelp className="h-3 w-3 text-muted-foreground" aria-label="节假日表未维护" />
      )}
    </span>
  )
}

/**
 * OneBot 断线提示（CONFIG-UI.md §2.7.2）。
 * 桥接会自己无限重连（指数退避、最长 30 秒），界面上绝对不做「重新连接」按钮。
 * 判断在线只看 connected，不用 login === null（login 只在从没连过时为 null）。
 */
function DisconnectNotice({ connected, running }: { connected: boolean | undefined; running: boolean }) {
  const [since, setSince] = useState<number | null>(null)
  const [, forceTick] = useState(0)

  useEffect(() => {
    if (running && connected === false) {
      setSince((s) => s ?? Date.now())
    } else {
      setSince(null)
    }
  }, [connected, running])

  useEffect(() => {
    if (since === null) return
    const t = setInterval(() => forceTick((n) => n + 1), 5000)
    return () => clearInterval(t)
  }, [since])

  if (since === null) return null
  const long = Date.now() - since > 30_000
  return (
    <span className="flex items-center gap-1.5 text-xs font-medium text-amber-600" title="桥接会自己指数退避重连（最长 30 秒一轮），不需要手动操作。">
      <PlugZap className="h-3.5 w-3.5" />
      {long ? '仍未连上。请确认 SnowLuma 在运行（见「协议端」页签）' : '连接断开，正在自动重连…'}
    </span>
  )
}

function formatUptime(ms?: number): string {
  if (!ms || ms < 0) return '—'
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${m % 60} 分`
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`
}

export function StatusBar({
  status,
  offline,
  demo,
  restartRequired,
  restarting,
  onRefresh,
  refreshing,
  onRestart,
  onStop,
}: {
  status: ApiStatus | null
  offline: boolean
  demo: boolean
  restartRequired: boolean
  restarting: boolean
  onRefresh: () => void
  refreshing: boolean
  onRestart: () => void
  onStop: () => void
}) {
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [doctorLoading, setDoctorLoading] = useState(false)
  const [doctor, setDoctor] = useState<DoctorResult | null>(null)
  const [doctorError, setDoctorError] = useState<string | null>(null)
  const [powerOpen, setPowerOpen] = useState(false)
  const [confirm, setConfirm] = useState<'restart' | 'stop' | null>(null)

  const running = !!status?.running && !offline
  const adminEmpty = !offline && (status?.adminUsers?.length ?? 0) === 0
  const perm = status?.permissionMode ?? 'workspace-write'

  const runDoctor = async () => {
    setDoctorOpen(true)
    setDoctorLoading(true)
    setDoctorError(null)
    setDoctor(null)
    try {
      setDoctor(await api.doctor())
    } catch (e) {
      setDoctorError(e instanceof Error ? e.message : String(e))
    } finally {
      setDoctorLoading(false)
    }
  }

  return (
    <>
      <header className="sticky top-0 z-20 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
          {/* 运行状态 */}
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-block h-2.5 w-2.5 rounded-full',
                offline ? 'bg-gray-400' : running ? 'bg-emerald-500' : 'bg-gray-400',
                running && 'animate-pulse',
              )}
            />
            <span className="text-sm font-semibold">
              {offline ? '未连接' : running ? '运行中' : '已停止'}
            </span>
            {demo && (
              <Badge variant="outline" className="border-violet-400 text-violet-600">
                演示数据
              </Badge>
            )}
          </div>

          {/* 已登录 QQ */}
          {status?.login && !offline && (
            <span className="text-sm text-muted-foreground">
              {status.login.nickname}
              <span className="ml-1 text-xs">({status.login.userId})</span>
            </span>
          )}
          {running && <span className="text-xs text-muted-foreground">已运行 {formatUptime(status?.uptimeMs)}</span>}

          {/* 当前计费时段指示灯（与"运行中"同一行） */}
          {!offline && <PeriodIndicator demo={demo} />}

          {/* OneBot 断线自动重连提示（不做"重新连接"按钮） */}
          <DisconnectNotice connected={status?.connected} running={running} />

          <div className="mx-1 hidden h-5 w-px bg-border sm:block" />

          {/* 管理员白名单（必须常驻） */}
          {adminEmpty ? (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangle className="h-3 w-3" />
              白名单为空：没有人能用
            </Badge>
          ) : (
            !offline && (
              <span className="text-xs text-muted-foreground">
                管理员 {(status?.adminUsers ?? []).join('、') || '—'}
              </span>
            )
          )}

          {/* 权限模式（必须常驻） */}
          {!offline && (
            <Badge
              variant="outline"
              className={cn(
                'gap-1',
                perm === 'danger-full-access'
                  ? 'border-red-400 text-red-600'
                  : 'border-emerald-400 text-emerald-700',
              )}
            >
              <ShieldCheck className="h-3 w-3" />
              权限：{PERMISSION_LABEL[perm] ?? perm}
            </Badge>
          )}

          {/* 未生效改动角标 */}
          {restartRequired && (
            <Badge className="gap-1 bg-amber-500 hover:bg-amber-500">
              <AlertTriangle className="h-3 w-3" />
              有改动待重启生效
            </Badge>
          )}

          <div className="ml-auto flex items-center gap-2">
            {offline && !demo ? (
              <Button size="sm" variant="outline" onClick={() => setPowerOpen(true)}>
                <Power className="mr-1 h-3.5 w-3.5" />
                如何启动
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirm('restart')}
                  disabled={restarting}
                >
                  {restarting ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCw className="mr-1 h-3.5 w-3.5" />
                  )}
                  {restarting ? '重启中…' : '重启'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-red-600 hover:bg-red-50 hover:text-red-700"
                  onClick={() => setConfirm('stop')}
                  disabled={restarting}
                >
                  <Power className="mr-1 h-3.5 w-3.5" />
                  停止
                </Button>
              </>
            )}
            <Button size="sm" variant="outline" onClick={runDoctor} disabled={offline && !demo}>
              <Stethoscope className="mr-1 h-3.5 w-3.5" />
              体检
            </Button>
            <Button size="sm" variant="ghost" onClick={onRefresh} disabled={refreshing}>
              <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
            </Button>
          </div>
        </div>
      </header>

      {/* 体检结果 */}
      <Dialog open={doctorOpen} onOpenChange={setDoctorOpen}>
        <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Stethoscope className="h-5 w-5" />
              体检结果（--doctor）
            </DialogTitle>
            <DialogDescription>逐项检查哪一项没配好。</DialogDescription>
          </DialogHeader>
          {doctorLoading && (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在体检…
            </div>
          )}
          {doctorError && (
            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
              {demo ? '演示模式下不跑真实体检。' : doctorError}
            </div>
          )}
          {doctor && (
            <div className="space-y-3">
              {doctor.fatal?.length > 0 && (
                <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2">
                  {doctor.fatal.map((f, i) => (
                    <div key={i} className="flex gap-2 py-0.5 text-sm text-red-800">
                      <CircleX className="mt-0.5 h-4 w-4 shrink-0" />
                      {f}
                    </div>
                  ))}
                </div>
              )}
              {doctor.warn?.length > 0 && (
                <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
                  {doctor.warn.map((w, i) => (
                    <div key={i} className="flex gap-2 py-0.5 text-sm text-amber-800">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      {w}
                    </div>
                  ))}
                </div>
              )}
              {doctor.fatal?.length === 0 && doctor.warn?.length === 0 && (
                <div className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                  <CircleCheck className="h-4 w-4" />
                  全部通过，没有发现问题。
                </div>
              )}
              {doctor.rows?.length > 0 && (
                <div className="divide-y rounded-md border text-sm">
                  {doctor.rows.map((row, i) => (
                    <div key={i} className="flex items-start gap-2 px-3 py-2">
                      {row.ok || row.level === 'ok' ? (
                        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                      ) : row.level === 'warn' ? (
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                      ) : (
                        <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                      )}
                      <div>
                        <div className="font-medium">{row.name}</div>
                        {row.detail && <div className="text-xs text-muted-foreground">{row.detail}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 启动说明：接口跑在桥接进程里，桥接停了接口也不在，所以"启动"只能手动 */}
      <Dialog open={powerOpen} onOpenChange={setPowerOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              如何启动机器人
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 pt-1 text-sm leading-relaxed text-foreground/80">
                <p>
                  机器人没在运行时，这个界面也连不上它，所以「启动」只能手动做一次： 在机器人目录里双击{' '}
                  <code className="rounded bg-muted px-1">start.bat</code>（后台启动，窗口会自己关，不会留黑窗口）。
                  要看实时输出、或想用 Ctrl+C 停止，用{' '}
                  <code className="rounded bg-muted px-1">start.bat --foreground</code>。
                </p>
                <p className="text-muted-foreground">
                  启动之后回到这个页面点刷新即可。运行中的「重启」和「停止」都可以直接在状态条上操作。
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <Button onClick={() => setPowerOpen(false)}>知道了</Button>
        </DialogContent>
      </Dialog>

      {/* 重启 / 停止的二次确认 */}
      <ConfirmDialog
        req={
          confirm === 'restart'
            ? {
                title: '重启机器人？',
                description: '重启期间界面会断开几秒钟，自动恢复后新配置即生效。',
                confirmText: '重启',
                onConfirm: onRestart,
              }
            : confirm === 'stop'
              ? {
                  title: '停止机器人？',
                  description: (
                    <>
                      停止后本界面会断开，而且<strong className="text-red-600">无法从这里再启动</strong>
                      ——需要到机器人目录双击 start.bat 才能重新启动（现在不会留黑窗口）。
                    </>
                  ),
                  confirmText: '停止',
                  onConfirm: onStop,
                }
              : null
        }
        onClose={() => setConfirm(null)}
      />
    </>
  )
}
