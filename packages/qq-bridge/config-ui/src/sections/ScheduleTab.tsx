import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, CalendarClock, Clock, History, Plus, RefreshCw, Trash2 } from 'lucide-react'

import {
  api,
  isNotImplemented,
  type ScheduleLedgerRow,
  type ScheduleListResult,
  type ScheduleTask,
  type ScheduleTaskDraft,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/**
 * 任务页签（0.3.2 P5，规格见 CONFIG-UI.md §2.11）。
 *
 * 它回答四个问题：**有哪些任务、下次什么时候响、上一次到底发出去没有、有没有错过**。
 *
 * ★★ 为什么这页必须存在（这是本版最要紧的一句）：定时任务是本项目**唯一一个
 *   "无人开口也说话"**的能力 —— 所以它坏掉时**没有任何人会当场发现**，
 *   表现只是"8 点它没响"。而机器人没在跑时界面也打不开，那时只能靠
 *   `node src/index.mjs --schedule` —— 两者查的是**同一份盘上状态**。
 *
 * ★★ 三条必须写在界面上的事实（不说清就会误导使用者）：
 *   ① **总开关不在这页**：控件是「扩展」页那张插件卡（一个键只能有一条写入口，
 *      这是 0.2.7 真机反馈定下的纪律）。这页只**显示**它当前是开还是关。
 *   ② **"从关到开"要重启**（定时器对象是启动时挂的），而"关掉"是下一跳就生效。
 *      后端把 `hot` 与理由一起给了插件卡，这页只提醒这一条。
 *   ③ **内容由模型现写** ⇒ 每次触发的**实际原文**必须能看到（唯一能事后核对的东西）。
 *
 * ★ 不渲染第二个总开关、不提供"立刻触发一次"的按钮：后者会在使用者没预期的时候
 *   真往群里发一句话 —— 那是这页最不该有的一个控件。
 */
export function ScheduleTab({ demo = false }: { demo?: boolean }) {
  const [data, setData] = useState<ScheduleListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // 表单（新建 / 编辑同一份状态 —— 编辑就是"把它填进表单"）
  const [editing, setEditing] = useState<ScheduleTaskDraft | null>(null)
  const [formErr, setFormErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      setData(await api.schedule())
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

  const emptyDraft = useCallback(
    (): ScheduleTaskDraft => ({
      // id 只允许字母数字与 _.-（后端会再清洗一次，且它是文件名）
      id: `t${Date.now().toString(36)}`,
      title: '',
      enabled: true,
      repeat: { kind: 'daily', at: '08:00', weekdays: null },
      target: { kind: 'private', peerId: '' },
      prompt: '',
      requestedBy: '',
      // ★ 默认 true：定时提醒的语义就是"到点就说"，否则凌晨的任务会被静默时段推到早上
      ignoreQuietHours: true,
      lateToleranceMs: 2 * 60 * 1000,
      timezone: 'Asia/Shanghai',
      lastFiredAt: null,
      lastScheduledAt: null,
      createdAt: Date.now(),
    }),
    [],
  )

  const save = async () => {
    if (!editing) return
    setFormErr(null)
    setNotice(null)
    const r = await api.scheduleSave(editing).catch((e) => ({ ok: false, why: e instanceof Error ? e.message : String(e) }))
    if (r && 'ok' in r && r.ok === false) {
      setFormErr(String((r as { why?: string }).why ?? '保存失败'))
      return
    }
    setNotice(`已保存「${editing.title || editing.id}」`)
    setEditing(null)
    await load()
  }

  const remove = async (t: ScheduleTask) => {
    setBusyId(t.id)
    setNotice(null)
    try {
      const r = await api.scheduleDelete(t.id)
      if (r && r.ok === false) setNotice('删除失败（后端没说明原因）')
      else setNotice(`已删掉「${t.title}」（任务定义文件已移除）`)
      await load()
    } catch (e) {
      setNotice(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  const toggle = async (t: ScheduleTask, enabled: boolean) => {
    setBusyId(t.id)
    try {
      const r = await api.scheduleSave({ ...t, enabled })
      if (r && 'ok' in r && r.ok === false) setNotice(`没改成：${String((r as { why?: string }).why ?? '')}`)
      else setNotice(enabled ? `已启用「${t.title}」` : `已暂停「${t.title}」（下次不会再触发）`)
      await load()
    } catch (e) {
      setNotice(`没改成：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusyId(null)
    }
  }

  // ★ 时间格式化只用于展示。**后端给的是毫秒差**，所以这里不重算时点、不猜时区。
  const nextText = (t: ScheduleTask) => {
    if (!t.enabled) return '已暂停'
    if (t.dueNow) {
      const late = Math.round((t.dueLateMs ?? 0) / 60000)
      return late >= 1 ? `⚠️ 现在就该发（已迟 ${late} 分钟）` : '⚠️ 现在就该发'
    }
    if (t.nextInMs === null) return '没有下一次'
    const s = Math.round(t.nextInMs / 1000)
    if (s < 60) return `${s} 秒后`
    if (s < 3600) return `${Math.round(s / 60)} 分钟后`
    return `${(s / 3600).toFixed(1)} 小时后`
  }

  const repeatText = (t: ScheduleTask) => {
    const r = t.repeat
    if (r.kind === 'daily') {
      const days = r.weekdays ? `（周 ${r.weekdays.join('/')}）` : ''
      return `每天 ${r.at}${days}`
    }
    if (r.kind === 'interval') return `每 ${Math.round(r.everyMs / 60000)} 分钟`
    return `仅一次`
  }

  const fmt = (ms?: number | null) => {
    const v = Number(ms)
    if (!Number.isFinite(v) || v <= 0) return '—'
    try {
      return new Date(v).toLocaleString()
    } catch {
      return '—'
    }
  }

  const ledgerRows = useMemo(() => (data?.history ?? []).slice().reverse(), [data])

  if (demo || unsupported) return null

  return (
    <div className="space-y-4">
      {/* ── 状态与总开关在哪 ────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <CalendarClock className="h-4 w-4" />
            定时任务
            <span className="text-muted-foreground text-xs font-normal">（到点了主动说一句）</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'inline-block h-2 w-2 rounded-full',
                  data?.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                )}
              />
              {data?.enabled ? '功能已开启' : '功能**关闭**中（一条任务都不会触发）'}
            </span>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} className="gap-1.5">
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              刷新
            </Button>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            ★ 总开关**不在这一页** —— 它在「扩展」页那张「🕒 定时任务」插件卡上（一个键只留一条写入口）。
            另外：**关掉**是下一次检查就生效，**从关到开要重启桥接**（定时器是启动时挂上的）。
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            ★ 每条提醒**只发一次**：触发点是算出来的，加上落盘的触发台账在**调模型之前**先认领。
            **错过不补发**：迟到 2 分钟内照常发并如实说"晚了"，超过就记进错过台账、下次对话里提一句。
          </p>
        </CardContent>
      </Card>

      {err && (
        <Card className="border-destructive/50">
          <CardContent className="pt-4 text-sm text-destructive">读不到定时任务：{err}</CardContent>
        </Card>
      )}
      {notice && (
        <div className="rounded-md border px-3 py-2 text-sm">{notice}</div>
      )}

      {/* ── 任务列表 ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">任务（{data?.tasks.length ?? 0}）</CardTitle>
          <Button size="sm" className="gap-1.5" onClick={() => { setEditing(emptyDraft()); setFormErr(null) }}>
            <Plus className="h-3.5 w-3.5" />
            新建任务
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {(data?.tasks.length ?? 0) === 0 && (
            <p className="text-muted-foreground text-sm">
              还没有任务。点「新建任务」加一条 —— 例如「每天 08:00，私聊提醒我起床」。
            </p>
          )}
          {data?.tasks.map((t) => (
            <div key={t.id} className="rounded-md border px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{t.title}</span>
                    <span className="text-muted-foreground text-xs font-normal">{repeatText(t)}</span>
                  </div>
                  <div className="text-muted-foreground mt-0.5 text-xs">
                    → {t.target.kind === 'group' ? '群' : '私聊'} {t.target.peerId} · 下次：
                    <span className={cn(t.dueNow && 'text-amber-600')}>{nextText(t)}</span> · 上次：
                    {fmt(t.lastFiredAt)} · 时区 {t.timezone}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={t.enabled} onCheckedChange={(v) => void toggle(t, v)} disabled={busyId === t.id} />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setEditing({ ...t })
                      setFormErr(null)
                    }}
                  >
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1 text-destructive"
                    disabled={busyId === t.id}
                    onClick={() => void remove(t)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    删
                  </Button>
                </div>
              </div>
            </div>
          ))}

          {(data?.problems.length ?? 0) > 0 && (
            <div className="rounded-md border border-amber-500/50 px-3 py-2 text-xs">
              <div className="flex items-center gap-1.5 font-medium text-amber-600">
                <AlertCircle className="h-3.5 w-3.5" />
                有 {data?.problems.length} 条任务读不出来（**跳过它、其它照常**）
              </div>
              {data?.problems.map((p) => (
                <div key={p.id} className="text-muted-foreground mt-1">
                  · {p.id}：{p.why}
                </div>
              ))}
            </div>
          )}
          {(data?.ledgerBad ?? 0) > 0 && (
            <p className="text-xs text-amber-600">
              ⚠️ 触发台账里有 {data?.ledgerBad} 行读不出来（去重只认读得出来的那些）
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── 新建 / 编辑表单 ───────────────────────────────────────────── */}
      {editing && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">新建 / 编辑任务</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="sched-title">名字（只给你自己看）</Label>
                <Input
                  id="sched-title"
                  value={editing.title}
                  placeholder="8 点叫我"
                  onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sched-id">id（文件名，字母数字与 _.-）</Label>
                <Input
                  id="sched-id"
                  value={editing.id}
                  onChange={(e) => setEditing({ ...editing, id: e.target.value })}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label>重复方式</Label>
                <select
                  className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                  value={editing.repeat.kind}
                  onChange={(e) => {
                    const kind = e.target.value as 'daily' | 'interval' | 'once'
                    if (kind === 'daily') setEditing({ ...editing, repeat: { kind, at: '08:00', weekdays: null } })
                    else if (kind === 'interval') setEditing({ ...editing, repeat: { kind, everyMs: 30 * 60 * 1000 } })
                    else setEditing({ ...editing, repeat: { kind, at: new Date(Date.now() + 3600_000).toISOString() } })
                  }}
                >
                  <option value="daily">每天某时刻</option>
                  <option value="interval">每隔一段时间</option>
                  <option value="once">只一次</option>
                </select>
              </div>
              {editing.repeat.kind === 'daily' && (
                <div className="space-y-1">
                  <Label htmlFor="sched-at">时刻（HH:MM）</Label>
                  <Input
                    id="sched-at"
                    value={editing.repeat.at}
                    onChange={(e) => setEditing({ ...editing, repeat: { kind: 'daily', at: e.target.value, weekdays: null } })}
                  />
                </div>
              )}
              {editing.repeat.kind === 'interval' && (
                <div className="space-y-1">
                  <Label htmlFor="sched-every">间隔（分钟，至少 1）</Label>
                  <Input
                    id="sched-every"
                    type="number"
                    min={1}
                    value={Math.round(editing.repeat.everyMs / 60000)}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        repeat: { kind: 'interval', everyMs: Math.max(1, Number(e.target.value) || 1) * 60000 },
                      })
                    }
                  />
                </div>
              )}
              {editing.repeat.kind === 'once' && (
                <div className="space-y-1">
                  <Label htmlFor="sched-once">时间（可被 Date 解析）</Label>
                  <Input
                    id="sched-once"
                    value={editing.repeat.at}
                    onChange={(e) => setEditing({ ...editing, repeat: { kind: 'once', at: e.target.value } })}
                  />
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="sched-tz">时区</Label>
                <Input
                  id="sched-tz"
                  value={editing.timezone}
                  onChange={(e) => setEditing({ ...editing, timezone: e.target.value })}
                />
                <p className="text-muted-foreground text-xs">
                  ★ 「8 点」按**这个时区**算，与机器人跑在哪个时区无关。
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label>发给谁</Label>
                <select
                  className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                  value={editing.target.kind}
                  onChange={(e) =>
                    setEditing({ ...editing, target: { ...editing.target, kind: e.target.value as 'group' | 'private' } })
                  }
                >
                  <option value="private">私聊某人</option>
                  <option value="group">某个群</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="sched-peer">{editing.target.kind === 'group' ? '群号' : 'QQ 号'}</Label>
                <Input
                  id="sched-peer"
                  value={editing.target.peerId}
                  onChange={(e) => setEditing({ ...editing, target: { ...editing.target, peerId: e.target.value } })}
                />
                <p className="text-muted-foreground text-xs">
                  ★ 必须**来过消息**的会话（下面列了已知的），否则后端会拒发。
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="sched-by">谁要求的（可选）</Label>
                <Input
                  id="sched-by"
                  value={editing.requestedBy}
                  placeholder="主人"
                  onChange={(e) => setEditing({ ...editing, requestedBy: e.target.value })}
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="sched-prompt">到点了让它做什么（这是给模型的交代，不是它要念的稿子）</Label>
              <textarea
                id="sched-prompt"
                className="border-input bg-background min-h-[76px] w-full rounded-md border px-3 py-2 text-sm"
                placeholder="提醒我起床，顺便说一句今天要做什么"
                value={editing.prompt}
                onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
              />
              <p className="text-muted-foreground text-xs leading-relaxed">
                ★ 具体那句话**由模型现写**（所以语气像它自己）。每次实际发出去的原文会进下面的「最近执行」，
                那是唯一能事后核对"它到底说了什么"的地方。
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={editing.ignoreQuietHours}
                  onCheckedChange={(v) => setEditing({ ...editing, ignoreQuietHours: v })}
                />
                忽略静默时段
                <span className="text-muted-foreground text-xs">（提醒类建议开：否则凌晨那条会被推到早上）</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={editing.enabled} onCheckedChange={(v) => setEditing({ ...editing, enabled: v })} />
                启用
              </label>
            </div>

            {formErr && <p className="text-sm text-destructive">没保存成：{formErr}</p>}

            <div className="flex items-center gap-2">
              <Button onClick={() => void save()}>保存</Button>
              <Button variant="outline" onClick={() => { setEditing(null); setFormErr(null) }}>
                取消
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── 已知会话（目标必须在这份名单里）────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4" />
            已知会话（{data?.knownChats.length ?? 0}）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {(data?.knownChats.length ?? 0) === 0 && (
            <p className="text-muted-foreground">
              还没有任何会话来过消息 —— 定时任务**不往陌生号码发消息**（可能是打错的一位数字）。
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {data?.knownChats.map((c) => (
              <span key={c} className="bg-muted rounded px-2 py-0.5 font-mono text-xs">
                {c}
              </span>
            ))}
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            ★ 这份名单是**落盘**的（`runtime/schedule-chats.json`）。用内存判据会让「晚上重启过桥接、
            早上 8 点要发到某个群」被误判成陌生号码而**拒发** —— 使用者只看到"8 点它没响"。
          </p>
        </CardContent>
      </Card>

      {/* ── 错过台账 ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">错过（{data?.missed.length ?? 0}）</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {(data?.missed.length ?? 0) === 0 ? (
            <p className="text-muted-foreground">没有错过 —— 或者还没发生过。</p>
          ) : (
            <div className="space-y-1">
              {data?.missed.map((m, i) => (
                <div key={`${m.key ?? i}`} className="text-xs">
                  <span className="text-muted-foreground">{fmt(m.scheduledAt)}</span> 「{m.title ?? m.taskId}」 晚了约{' '}
                  {Math.round(Number(m.lateByMs ?? 0) / 60000)} 分钟
                </div>
              ))}
              <p className="text-muted-foreground pt-1 text-xs">
                ★ **不补发**（迟到的"8 点提醒"在 10 点已没意义），但会在下一次对话里如实提一句。
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── 最近执行（模型现写的原文）────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="h-4 w-4" />
            最近执行（{ledgerRows.length}）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          {ledgerRows.length === 0 && <p className="text-muted-foreground">还没有执行过。</p>}
          {ledgerRows.map((r: ScheduleLedgerRow, i) => (
            <div key={`${r.at ?? i}`} className="text-xs">
              <span className="text-muted-foreground">{fmt(r.scheduledAt ?? r.at)}</span> 「{r.title ?? r.taskId}」→{' '}
              <span>{r.text}</span>
            </div>
          ))}
          {ledgerRows.length > 0 && (
            <p className="text-muted-foreground pt-1 text-xs">
              ★ 这些是**实际发出去的原文**（内容由模型现写 ⇒ 唯一能事后核对的东西）。
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
