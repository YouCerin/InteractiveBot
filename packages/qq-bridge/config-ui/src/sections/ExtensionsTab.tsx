import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  KeyRound,
  Puzzle,
  RefreshCw,
  ShieldAlert,
  Stethoscope,
  Tag,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  api,
  isNotImplemented,
  type ExtensionsResult,
  type PluginInfo,
  type SkillInfo,
  type StickerRetagStatus,
} from '@/lib/api'
import { getBool, getNum, getPath } from '@/lib/config'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { FieldRow, InlineNote, NumInput, type ConfirmRequest } from '@/components/common'
// ★ 0.2.3：「唤醒方式」从人设页搬到这里（见该文件顶部的说明）——
//   `wake.policy = rule` 时它就是那条策略的全部内容，放在别的页会让同一个问题被劈成两处。
import { WakeRulesSection } from '@/sections/WakeRulesSection'
import { cn } from '@/lib/utils'

/**
 * 「扩展」页签（0.2.2，规格见 CONFIG-UI.md §2.10）。
 *
 * 这一页回答三个以前答不了的问题：
 *   ① 我这台机器人现在开了哪些能力（开关原来散在 9 个页签里）；
 *   ② 关掉会发生什么（offEffect 原文直接显示，不改写）；
 *   ③ 装了第三方技能之后，它现在什么状态、给了模型哪些工具、要不要重启。
 *
 * ★ 三种开关语义是本页的信任基础：即时生效 / 要重启（把 why 显示出来）/
 *   名单类不渲染 Switch（改「去维护」按钮）。判据全部来自后端，前端不写死。
 * ★ 本页**不跟着主轮询刷新**：/api/extensions 会做文件系统扫描，
 *   进页签拉一次 + 操作后重拉 + 手动刷新按钮（Radix Tabs 切走即卸载，进页签 = 重新挂载 = 拉一次）。
 */
export function ExtensionsTab({
  cfg,
  patch,
  demo,
  askConfirm,
  onNavigateTab,
}: {
  cfg: Record<string, unknown>
  patch: (path: string, value: unknown) => void
  demo?: boolean
  askConfirm: (req: ConfirmRequest) => void
  onNavigateTab: (tab: string) => void
}) {
  const [data, setData] = useState<ExtensionsResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [unsupported, setUnsupported] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      setData(await api.extensions())
      setUnsupported(false)
    } catch (e) {
      if (isNotImplemented(e)) setUnsupported(true)
      else setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!demo) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = async (type: 'skill' | 'plugin', id: string, enabled: boolean) => {
    try {
      const r = await api.extensionToggle({ type, id, enabled })
      // ★ 生效方式按接口返回值渲染，前端不写死「需要重启」
      if (r.restartRequired) {
        toast.warning(r.hint ?? '已切换。需要重启机器人才会生效。', { duration: 8000 })
      } else {
        toast.success(r.hint ?? '已切换，即时生效。')
      }
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  if (demo) {
    return <InlineNote level="info">演示数据里没有扩展清单。启动机器人后这一页会显示技能与插件。</InlineNote>
  }
  if (unsupported) {
    return <InlineNote level="warn">这个版本的后端还没有扩展接口（旧包）。升级后这一页会列出技能与插件。</InlineNote>
  }

  const counts = data?.counts

  return (
    <div className="space-y-4">
      {/* 摘要 + 手动刷新（不跟主轮询，理由见组件头注释） */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Puzzle className="h-4 w-4" />
        {data ? (
          <span>
            技能 {counts?.skills ?? 0} 个（{counts?.skillsEnabled ?? 0} 个在用）· 插件{' '}
            {counts?.plugins ?? 0} 个（{counts?.pluginsOn ?? 0} 个开着）
          </span>
        ) : (
          <span>{loading ? '正在扫描技能目录…' : '—'}</span>
        )}
        <Button variant="ghost" size="sm" className="ml-auto h-7 px-2" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          <span className="ml-1 text-xs">刷新</span>
        </Button>
      </div>
      {err && <InlineNote level="warn">{err}</InlineNote>}
      {data?.notes?.map((n, i) => (
        <p key={i} className="text-xs text-muted-foreground">
          {n.replace(/\*\*/g, '')}
        </p>
      ))}

      {/* ⚠️ 给扩展用的安全开关（§2.10 页面结构）；这是配置键，走底部保存条 */}
      <Card>
        <CardContent className="flex items-start justify-between gap-4 py-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              允许下载内网/本机图片地址
            </div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              技能要发本机中转的图（如 pixiv）时打开；打开后内网图片地址也会被取回来。
              这是本项目唯一一处「外部输入能指挥进程发网络请求」的放宽，默认关。
            </div>
          </div>
          <Switch
            checked={getBool(cfg, 'security.allowPrivateImageHosts', false)}
            onCheckedChange={(v) => patch('security.allowPrivateImageHosts', v)}
          />
        </CardContent>
      </Card>

      {/* ── 技能 ─────────────────────────────────────────────────────── */}
      <div className="text-sm font-medium">技能</div>
      {data && data.skills.length === 0 && (
        <Card>
          <CardContent className="py-4 text-sm text-muted-foreground">
            还没有装任何技能。把技能目录拷到{' '}
            <code className="rounded bg-muted px-1">skills/&lt;名字&gt;/</code>（里面要有{' '}
            <code className="rounded bg-muted px-1">skill.json</code>），然后<strong>重启机器人</strong>
            即可出现在这里。开关随时可改、即时生效；<strong>装/卸</strong>需要重启。
          </CardContent>
        </Card>
      )}
      {data?.skills.map((s) => (
        <SkillCard key={s.id} skill={s} onToggle={(en) => void toggle('skill', s.id, en)} onSaved={() => void load()} askConfirm={askConfirm} />
      ))}

      {/* ── 插件 ─────────────────────────────────────────────────────── */}
      <div className="text-sm font-medium">插件</div>
      {data?.plugins.map((p) => (
        <PluginCard
          key={p.id}
          plugin={p}
          cfg={cfg}
          patch={patch}
          onToggle={(en) => void toggle('plugin', p.id, en)}
          onNavigateTab={onNavigateTab}
          askConfirm={askConfirm}
        />
      ))}
    </div>
  )
}

/** 状态徽标：照抄 §2.10 的状态用词表，别自创。
 *  顺序：装不上 > 已关闭（关着就是关着，不算"依赖不满足"）> 暂时用不了 > 没工具 > 已启用。 */
function skillStatusBadge(s: SkillInfo) {
  if (s.errors.length > 0) return { text: '装不上', cls: 'border-red-300 text-red-700' }
  if (!s.enabled) return { text: '已关闭', cls: 'text-muted-foreground' }
  if (s.available.ok === false) return { text: '暂时用不了', cls: 'border-amber-300 text-amber-700' }
  if (s.enabled && s.tools.length === 0) return { text: '开着，但没给模型任何工具', cls: 'border-amber-300 text-amber-700' }
  if (s.enabled && s.ready) return { text: '已启用', cls: 'border-emerald-300 text-emerald-700' }
  return { text: '已关闭', cls: 'text-muted-foreground' }
}

function SkillCard({
  skill: s,
  onToggle,
  onSaved,
  askConfirm,
}: {
  skill: SkillInfo
  onToggle: (enabled: boolean) => void
  onSaved: () => void
  askConfirm: (req: ConfirmRequest) => void
}) {
  const [open, setOpen] = useState('')
  const badge = skillStatusBadge(s)
  const toggleSection = (id: string) => setOpen(open === id ? '' : id)

  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <div className="flex items-center gap-2">
          <span className="text-lg">{s.icon ?? '🧩'}</span>
          <span className="font-medium">{s.name}</span>
          <span className="text-xs text-muted-foreground">
            v{s.version}
            {s.author ? ` · ${s.author}` : ''}
            {s.category ? ` · ${s.category}` : ''}
          </span>
          <Badge variant="outline" className={cn('ml-2', badge.cls)}>
            {badge.text}
          </Badge>
          <Switch className="ml-auto" checked={s.enabled} onCheckedChange={onToggle} />
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">{s.description}</p>

        {/* 权限声明：会联网到什么域名、会不会开本机端口 —— 装之前就该看见 */}
        {s.permissions && (
          <p className="text-xs text-muted-foreground">
            权限：
            {s.permissions.net?.length ? `会联网（${s.permissions.net.join('、')}）` : '不联网'}
            {s.permissions.listen ? ' · ★ 会在本机开端口' : ''}
          </p>
        )}

        {/* 装不上的原因：摊开，而不是当成"没有这个技能" */}
        {s.errors.map((e, i) => (
          <InlineNote key={i} level="danger">
            {e}
          </InlineNote>
        ))}
        {s.enabled && s.available.ok === false && s.available.reason && (
          <InlineNote level="warn">{s.available.reason}</InlineNote>
        )}
        {s.reasons.length > 0 && s.enabled && (
          <InlineNote level="warn">{s.reasons.join('；')}</InlineNote>
        )}
        {/* ★ 清单告警必须显示：它们不报错，只会静默失效 */}
        {s.warnings.map((w, i) => (
          <InlineNote key={i} level="warn">
            {w.replace(/\*\*/g, '')}
          </InlineNote>
        ))}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={() => toggleSection('settings')}>
            {open === 'settings' ? <ChevronDown className="mr-1 h-3.5 w-3.5" /> : <ChevronRight className="mr-1 h-3.5 w-3.5" />}
            设置
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => toggleSection('tools')}>
            它给模型的工具（{s.tools.length}）
          </Button>
          {s.promptSections.length > 0 && (
            <Button type="button" variant="outline" size="sm" onClick={() => toggleSection('prompt')}>
              提示词片段
            </Button>
          )}
          <DiagnoseButton id={s.id} />
          {/* ★ 表情包专属动作（0.2.4）：重新打标签。它**只出现在这一个技能卡上**，
              因为它是唯一一个"要花钱的离线动作"（每张图一次模型调用）。 */}
          {s.id === 'sticker' && <StickerRetagSection askConfirm={askConfirm} />}
        </div>

        {open === 'tools' && (
          <div className="space-y-1 rounded-md border bg-muted/30 p-2">
            {s.tools.length === 0 ? (
              <p className="text-xs text-muted-foreground">（没有注册任何工具）</p>
            ) : (
              s.tools.map((t) => (
                <div key={t.id} className="text-xs">
                  {/* fullName 是模型真正看到的名字，排障时复制去搜日志 —— 不许美化掉前缀 */}
                  <code className="rounded bg-muted px-1">{t.fullName}</code>{' '}
                  <span className="text-muted-foreground">
                    {t.name}
                    {t.registered === false ? '（未注册）' : ''}
                  </span>
                </div>
              ))
            )}
          </div>
        )}

        {open === 'prompt' && (
          <div className="space-y-1 rounded-md border bg-muted/30 p-2">
            {s.promptSections.map((p, i) => (
              <div key={i} className="text-xs">
                <span className="text-muted-foreground tabular-nums">{p.chars} 字</span>{' '}
                <span className="break-all">{p.preview}</span>
              </div>
            ))}
            <p className="text-[10px] text-muted-foreground">打开它之后模型每轮会多读这些字（前缀缓存/成本相关）。</p>
          </div>
        )}

        {open === 'settings' && <SkillSettings skill={s} onSaved={onSaved} askConfirm={askConfirm} />}
      </CardContent>
    </Card>
  )
}

/** 设置表单：由 configSchema 驱动。密文三条硬要求见 §2.10。 */
function SkillSettings({
  skill: s,
  onSaved,
  askConfirm,
}: {
  skill: SkillInfo
  onSaved: () => void
  askConfirm: (req: ConfirmRequest) => void
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>({ ...s.settings })
  const [secretDraft, setSecretDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const fields = Object.entries(s.schema ?? {}).filter(([k]) => k !== 'enabled')
  if (fields.length === 0) {
    return <p className="text-xs text-muted-foreground">这个技能没有自己的设置项。</p>
  }

  const save = async () => {
    setSaving(true)
    try {
      const patchBody: Record<string, unknown> = {}
      for (const [k, f] of fields) {
        if (f.secret) {
          const v = (secretDraft[k] ?? '').trim()
          // 留空 = 不修改（不带这个键）；清除走下面的「清除」按钮（提交 null）
          if (v) patchBody[k] = v
        } else {
          patchBody[k] = draft[k]
        }
      }
      const r = await api.extensionSettings({ id: s.id, patch: patchBody })
      // ★ 技能设置是**立即生效**的 —— 与配置保存的"需要重启"完全相反，别抄错
      toast.success(r.hint ?? '已保存，立即生效（不需要重启）。')
      setSecretDraft({})
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const clearSecret = (key: string, label: string) => {
    askConfirm({
      title: `清除「${label}」？`,
      description: '清除后这个密文字段将不再配置（例如 Cookie 被清掉后，需要它的内容就查不到了）。',
      confirmText: '清除',
      onConfirm: async () => {
        try {
          await api.extensionSettings({ id: s.id, patch: { [key]: null } })
          toast.success('已清除，立即生效。')
          onSaved()
        } catch (e) {
          toast.error(e instanceof Error ? e.message : String(e))
        }
      },
    })
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      {fields.map(([key, f]) => {
        const label = f.label ?? key
        if (f.type === 'boolean') {
          return (
            <FieldRow key={key} label={label} hint={f.description}>
              <Switch checked={Boolean(draft[key])} onCheckedChange={(v) => setDraft((d) => ({ ...d, [key]: v }))} />
            </FieldRow>
          )
        }
        if (f.type === 'number' || f.type === 'integer') {
          return (
            <FieldRow key={key} label={label} hint={f.description}>
              <NumInput
                value={Number(draft[key]) || 0}
                onChange={(n) => setDraft((d) => ({ ...d, [key]: n }))}
                min={f.min}
                max={f.max}
              />
            </FieldRow>
          )
        }
        if (f.type === 'enum' && f.values?.length) {
          return (
            <FieldRow key={key} label={label} hint={f.description}>
              <select
                className="h-8 rounded-md border bg-background px-2 text-sm"
                value={String(draft[key] ?? '')}
                onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
              >
                {f.values.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </FieldRow>
          )
        }
        if (f.secret) {
          const isSet = s.secretSet?.[key] === true
          return (
            <FieldRow key={key} label={label} hint={f.description}>
              <div className="space-y-1.5">
                <Input
                  type="password"
                  value={secretDraft[key] ?? ''}
                  onChange={(e) => setSecretDraft((d) => ({ ...d, [key]: e.target.value }))}
                  placeholder={isSet ? '已配置（留空即不修改）' : (f.placeholder ?? '未配置')}
                  className="max-w-md font-mono text-sm"
                  autoComplete="off"
                />
                {isSet && (
                  <button
                    type="button"
                    className="text-xs text-red-600 underline-offset-2 hover:underline"
                    onClick={() => clearSecret(key, label)}
                  >
                    清除已配置的值
                  </button>
                )}
              </div>
            </FieldRow>
          )
        }
        return (
          <FieldRow key={key} label={label} hint={f.description}>
            <Input
              value={String(draft[key] ?? '')}
              onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
              placeholder={f.placeholder}
              className="max-w-md text-sm"
            />
          </FieldRow>
        )
      })}
      <div className="pt-1">
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? '保存中…' : '保存设置（立即生效）'}
        </Button>
      </div>
    </div>
  )
}

function DiagnoseButton({ id }: { id: string }) {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const run = async () => {
    setRunning(true)
    setResult(null)
    try {
      const r = await api.extensionDiagnose(id)
      setResult(JSON.stringify(r, null, 2))
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => void run()} disabled={running}>
        <Stethoscope className="mr-1 h-3.5 w-3.5" />
        {running ? '自检中…' : '自检'}
      </Button>
      {result && (
        <pre className="max-h-48 w-full overflow-auto rounded bg-muted/60 p-2 text-[10px] leading-relaxed">
          {result}
        </pre>
      )}
    </>
  )
}

/**
 * 表情包「重新打标签」（0.2.4）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个按钮的流程是**刻意的**，每一段都在防一类真实问题
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **先预检（免费）**：进卡片就拉一次状态，拿 `total`（会有多少张要打）。
 *      没有它，用户点一下就是几十次模型调用 —— 而他既不知道要花多少、
 *      也不知道有几张会被跳过。
 *   ② **二次确认**：把"N 张图 = N 次模型调用"和"人工改过的标签不会被覆盖"
 *      写在确认框里。这是本功能唯一会真花钱的地方，不能点一下就悄悄跑。
 *   ③ **轮询进度**：每 1.5 秒拉一次，显示"第几张 / 当前哪个文件 / 最近打上什么标签"。
 *      长任务不给进度 = 用户以为卡死了，然后连点（后端虽然有防重入，但体验是坏的）。
 *   ④ **可停止**：当前那张跑完就停（不中断正在进行的请求），已打上的会照常写回。
 *   ⑤ 跑完给**结果摘要**：新打多少、重打多少、失败多少、跳过人工多少。
 */
function StickerRetagSection({ askConfirm }: { askConfirm: (req: ConfirmRequest) => void }) {
  const [st, setSt] = useState<StickerRetagStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const timer = useRef<number | null>(null)

  const poll = async () => {
    try {
      const s = await api.stickerRetag()
      setSt(s)
      return s
    } catch {
      // 轮询失败不弹错（重启/断线时是预期行为），界面保留上一份状态
      return null
    }
  }

  useEffect(() => {
    void poll()
    return () => {
      if (timer.current) window.clearInterval(timer.current)
    }
  }, [])

  // 只在"正在跑"时轮询（空闲时轮询是白费请求）
  useEffect(() => {
    if (timer.current) {
      window.clearInterval(timer.current)
      timer.current = null
    }
    if (st?.running) {
      timer.current = window.setInterval(() => void poll(), 1500)
    }
    return () => {
      if (timer.current) window.clearInterval(timer.current)
    }
  }, [st?.running])

  const start = () => {
    setError('')
    if (st?.running) return
    if (!st || st.total === 0) {
      setError(
        st?.preflightWhy ||
          '没有可重打的图（库里可能还没有图，或者只剩人工改过的标签）',
      )
      return
    }
    askConfirm({
      title: `重新给 ${st.total} 张表情包打标签？`,
      confirmText: '开始重打',
      description: (
        <div className="space-y-2">
          <p>
            这将调用模型 <strong>{st.total} 次</strong>（每张图一次，用于"看图分类"）。
            这一步只在需要时跑，运行期发表情<strong>不会</strong>再调用模型。
          </p>
          <p>
            ★ <strong>人工改过的标签不会被覆盖</strong>
            {st.skippedManual > 0 ? `（当前有 ${st.skippedManual} 张会被跳过）` : ''}。
          </p>
          <p>跑完会自动写回库，下一轮对话就生效（不需要重启）。</p>
        </div>
      ),
      onConfirm: () => void doStart(false),
    })
  }

  const doStart = async (force: boolean) => {
    setBusy(true)
    setError('')
    try {
      const r = await api.stickerRetagAction('start', force)
      if (r?.error) setError(r.error)
      else toast.success(`已开始重新打标签：${r.total} 张`)
      await poll()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const abort = async () => {
    setBusy(true)
    try {
      await api.stickerRetagAction('abort')
      await poll()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-full space-y-2 pt-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={start} disabled={busy || !!st?.running}>
          <Tag className="mr-1 h-3.5 w-3.5" />
          {st?.running ? '重新打标签中…' : '重新打标签'}
        </Button>
        {st?.running && (
          <Button type="button" variant="ghost" size="sm" onClick={() => void abort()} disabled={busy}>
            停止
          </Button>
        )}
        {st && !st.running && st.total > 0 && (
          <span className="text-xs text-muted-foreground">
            会处理 {st.total} 张（库里共 {st.libraryTotal} 张
            {st.skippedManual > 0 ? `，跳过人工改过的 ${st.skippedManual} 张` : ''}）
          </span>
        )}
      </div>

      {error && <InlineNote level="warn">{error}</InlineNote>}

      {st?.running && (
        <div className="space-y-1 rounded-md border bg-muted/30 p-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium">
              {st.done}/{st.total}
            </span>
            <span className="text-muted-foreground">{st.percent != null ? `（${st.percent}%）` : ''}</span>
            <span className="truncate text-muted-foreground">{st.current ?? ''}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${st.percent ?? 0}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            新打 {st.tagged}｜重打 {st.retagged}｜失败 {st.failed}
            {st.lastLabel ? `｜刚打上：${st.lastLabel}` : ''}
          </p>
        </div>
      )}

      {/* 跑完的结果摘要：**不用 toast 一闪而过** —— 用户要能看到"哪几张失败了" */}
      {st && !st.running && st.phase !== 'idle' && (
        <div className="space-y-1 rounded-md border bg-muted/30 p-2 text-xs">
          <p>
            {st.phase === 'done' ? '✅ 上次重打完成' : st.phase === 'aborted' ? '⏹ 上次被停止' : '❌ 上次失败'}
            ：新打 {st.tagged}｜重打 {st.retagged}｜失败 {st.failed}
            {st.skippedManual > 0 ? `｜跳过人工 ${st.skippedManual}` : ''}
          </p>
          {st.reason && <p className="text-muted-foreground">{st.reason}</p>}
          {st.failedList?.length > 0 && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">
                失败清单（前 {st.failedList.length} 条）
              </summary>
              <ul className="mt-1 space-y-0.5">
                {st.failedList.map((f, i) => (
                  <li key={i} className="truncate text-muted-foreground">
                    {f.rel}：{f.why}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

/** uiTab → 界面上的页签名（「去细调」按钮给人看的，不是给代码看的）。 */const TAB_LABEL: Record<string, string> = {
  overview: '概览',
  conversations: '对话',
  persona: '人设',
  pace: '节奏与成本',
  memory: '记忆',
  extensions: '扩展',
  protocol: '协议端',
  advanced: '高级',
}

function PluginCard({
  plugin: p,
  cfg,
  patch,
  onToggle,
  onNavigateTab,
  askConfirm,
}: {
  plugin: PluginInfo
  cfg: Record<string, unknown>
  patch: (path: string, value: unknown) => void
  onToggle: (enabled: boolean) => void
  onNavigateTab: (tab: string) => void
  askConfirm: (req: ConfirmRequest) => void
}) {
  const [open, setOpen] = useState(false)
  const isList = p.switchKind === 'list'
  const isEnum = p.switchKind === 'enum'
  const isChoice = p.switchKind === 'choice'
  const isQqTools = p.id === 'qq-tools'
  const isWakePolicy = p.id === 'wake-policy'
  // 二选一（choice，0.2.3）：当前值从**编辑中的 cfg** 读（按钮走的是改配置通道，
  // 保存前以草稿为准）；cfg 还没回填该键时用后端给的 value。enabled 恒为 null，不能靠它判断。
  const choiceValue = String(getPath(cfg, p.enabledPath) ?? p.value ?? '')
  // uiTab 以 extensions: 开头 = 详细设置展开区就在本卡（qq-tools / wake-policy）
  const expandHere = typeof p.uiTab === 'string' && p.uiTab.startsWith('extensions:')
  // ★ 默认值必须与后端 normalizeConfig 一致：0.2.3 起 wake.judge.shadow 默认 **false**
  //   （判定真的生效）。这里写成 true 的话，配置里没这个键时界面会显示"影子模式已开"，
  //   而实际行为正好相反 —— 那是最伤信任的一种不一致。
  const shadowOn = getBool(cfg, 'wake.judge.shadow', false)
  const mcpProfile = String(getPath(cfg, 'mcp.profile') ?? 'full')
  // ★★ 0.2.3：判定通路**不再让用户选**（原来那两个按钮已去掉）。
  //   规则：**填了「判定专用 key」→ 直连用它；没填 → 用一次性 DSH 进程。**
  //   为什么不给按钮：两条路在唤醒流程里做的事是同一件（都只是让一个模型判断
  //   "这句话是不是说给我听的"），让用户选一个自己无法判断好坏的东西没有意义；
  //   而"要不要单独配一把 key"本身就是那个选择的**可观察依据**。
  //   ★ 推导必须与后端一致（`bridge.mjs#ensureWakeJudge` 用同一条件），否则界面说的
  //     和实际跑的不是一条路 —— 那正是本项目最忌讳的"说了做不到"。
  const hasJudgeKey = getBool(cfg, 'hasJudgeKey', false) || Boolean(String(getPath(cfg, 'wake.judge.apiKey') ?? '').trim())

  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <div className="flex items-center gap-2">
          <span className="text-lg">{p.icon ?? '🔌'}</span>
          <span className="font-medium">{p.name}</span>
          {/* 生效方式徽标：cold 的必须把 why 显示出来（在下面）。choice 也照常标：
              但「即时生效」只对 policy / judge.shadow 成立，展开区里那两个键另有说明。 */}
          {p.hot ? (
            <Badge variant="outline" className="border-emerald-300 text-emerald-700">
              即时生效
            </Badge>
          ) : (
            <Badge variant="outline" className="border-amber-300 text-amber-700">
              ★ 需要重启
            </Badge>
          )}
          <span className="ml-auto flex items-center gap-2">
            {isList ? (
              // 名单/列表类：不渲染 Switch，改成「去维护」
              <Button variant="outline" size="sm" onClick={() => onNavigateTab(p.uiTab ?? 'protocol')}>
                去维护
              </Button>
            ) : isChoice ? null : (
              // choice 不渲染 Switch（按钮在下面）
              <Switch checked={p.enabled === true} onCheckedChange={onToggle} />
            )}
          </span>
        </div>

        {p.what && <p className="text-xs text-muted-foreground">{p.what}</p>}
        {/* ★ 关掉会怎样：直接显示原文，不改写。
            例外：choice（二选一）**没有"关"** —— 显示这句会让人以为"两个都不选"也是一种状态，
            所以它的"选它会怎样"写在每个按钮上（CONFIG-UI.md §2.10 二选一）。 */}
        {!isChoice && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">关掉会怎样：</span>
            {p.offEffect.replace(/\*\*/g, '')}
          </p>
        )}

        {/* ── 二选一（choice）：N 个并列按钮，点另一个即切换（走改配置通道，不做二次确认） ── */}
        {isChoice && (
          <div className="flex flex-col gap-2 sm:flex-row">
            {p.options?.map((o) => {
              const active = o.value === choiceValue
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => patch(p.enabledPath, o.value)}
                  className={cn(
                    'flex-1 rounded-md border p-3 text-left transition-colors',
                    active ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/50',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {o.label}
                    {o.experimental && (
                      <Badge
                        variant="outline"
                        className="border-violet-300 text-violet-700"
                        title="从外部项目借来、尚未在本项目长期验证"
                      >
                        实验性
                      </Badge>
                    )}
                    {active && <Badge className="bg-primary hover:bg-primary">当前</Badge>}
                  </div>
                  {o.desc && <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{o.desc}</div>}
                </button>
              )
            })}
          </div>
        )}

        {/* ★★ 选中语义唤醒时必须显示当前是不是影子模式 —— 否则「判定照跑但行为不变」
            看起来就是"点了没反应"（CONFIG-UI.md §2.10 唤醒策略）。 */}
        {isWakePolicy && choiceValue === 'semantic' && shadowOn && (
          <InlineNote level="info">
            当前是<strong>影子模式</strong>：判定照跑、结论写进操作日志（runtime/oplog/），<strong>行为不变</strong>。
            要让它真的生效，把下方「判定器 · 影子模式」关掉并保存。
          </InlineNote>
        )}
        {isWakePolicy && choiceValue === 'semantic' && !shadowOn && (
          <InlineNote level="warn">
            判定已<strong>真正生效</strong>：被判「沉默」的消息<strong>不会</strong>得到回复（且没有任何提示）。
          </InlineNote>
        )}

        {isEnum && (
          <p className="text-xs text-muted-foreground">
            这是枚举开关：打开时用的是<strong>默认档</strong>，不是「你上次选的那档」。
          </p>
        )}

        {/* ── ★★ 0.2.3：「唤醒方式」搬到这里（原「人设」页的「什么时候回我」）──
            为什么搬：`wake.policy = rule` 时，**这一节就是那条策略的全部内容**；
            `semantic` 也只是在它之上加一层否决。放在人设页会让"它用什么判据决定回不回"
            被劈成两处（策略在扩展页、规则在人设页），而原来那张只显示"群聊总开关"的
            「唤醒规则」卡又只说了三分之一 —— 三处各说一半。
            ★ 它不藏在「详细设置」里：那是每天要看的东西。 */}
        {isWakePolicy && (
          <WakeRulesSection cfg={cfg} patch={patch} askConfirm={askConfirm} />
        )}
        {!p.hot && p.why && (
          <p className="text-xs text-amber-700">
            为什么要重启：{p.why}
          </p>
        )}

        <div className="flex gap-2 pt-1">
          {expandHere ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(!open)}>
              {open ? <ChevronDown className="mr-1 h-3.5 w-3.5" /> : <ChevronRight className="mr-1 h-3.5 w-3.5" />}
              详细设置
            </Button>
          ) : (
            p.uiTab &&
            p.uiTab !== 'extensions' && (
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => p.uiTab && onNavigateTab(p.uiTab)}>
                → 去「{TAB_LABEL[p.uiTab] ?? p.uiTab}」细调
              </Button>
            )
          )}
        </div>

        {/* qq-tools 的详细设置就在本卡展开区（不再有独立的「QQ 功能」页签） */}
        {isQqTools && open && (
          <div className="rounded-md border p-3">
            <FieldRow label="单个 QQ 动作的超时" hint="调一个动作最多等多久，超时算失败。">
              <NumInput
                value={getNum(cfg, 'mcp.toolTimeoutMs', 20000)}
                onChange={(n) => patch('mcp.toolTimeoutMs', n)}
                unit="毫秒"
                min={1000}
              />
            </FieldRow>

            {/* 0.2.3：工具档位（二选一）。默认值 full = 升级前的行为，不许顺手收紧。 */}
            <div className="mt-3">
              <div className="text-sm font-medium">工具档位</div>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                {[
                  { v: 'full', label: '完整（默认）', desc: '全部 14 个工具，等于升级前的行为。' },
                  { v: 'readonly', label: '只读', desc: '只给只读工具，发送/互动类一并藏掉。' },
                ].map((o) => (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => patch('mcp.profile', o.v)}
                    className={cn(
                      'flex-1 rounded-md border p-2.5 text-left transition-colors',
                      mcpProfile === o.v ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/50',
                    )}
                  >
                    <div className="text-sm font-medium">
                      {o.label}
                      {mcpProfile === o.v && (
                        <Badge className="ml-1.5 bg-primary hover:bg-primary">当前</Badge>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{o.desc}</div>
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-amber-700">
                ⚠ readonly 会把发送/互动类工具一并藏掉，<strong>包括 qq_send_image</strong>
                （P站发图链路要用它）。改档位要重启 DSH 子进程才生效（保存后按提示重启）。
              </p>
            </div>

            {/* 0.2.3：万能口 qq_api 的开关。默认开 = 升级前的行为。 */}
            <div className="mt-3">
              <FieldRow
                label="万能口 qq_api"
                hint="一个只读白名单的通用 OneBot 口（发送/删除/上传/读凭据一律不放行）。关掉只是少这一个口，上面的具名工具不受影响。"
              >
                <Switch
                  checked={getBool(cfg, 'mcp.genericApi', true)}
                  onCheckedChange={(v) => patch('mcp.genericApi', v)}
                />
              </FieldRow>
              <p className="mt-1 text-xs text-amber-700">改这一项要重启才生效（MCP 工具表是 DSH 启动时加载的）。</p>
            </div>

            <p className="mt-3 text-xs text-muted-foreground">
              策略是<strong>两层</strong>：<strong>具名工具用黑名单</strong>（动作写死在代码里，
              所以拦得住：踢人/禁言/改群名片/退群等会被直接拒绝），
              <strong>而上面那个「万能口 qq_api」用只读白名单</strong>（它的动作由模型自选，
              黑名单天然只拦得住"想得到的"—— 实测漏过读凭据与外发文件两个高危动作）。
              两处清单都在代码里（mcp/mcp-qq-server.mjs 的 BLOCKED_ACTIONS 与 ALLOWED_API_ACTIONS），
              改它需要改代码而不是点界面。
              工具调用发生在「思考」阶段，「对话」页签里看不到过程——界面上什么都没发生是正常的。
            </p>
          </div>
        )}

        {/* 唤醒策略的判定器设置（0.2.3）。★ 生效边界：shadow 即时（每轮现读）；
            apiKey / model / baseUrl / timeoutMs / maxPerHour 在判定器首次用到时装配一次
            —— 改这几个要重启，别因为卡片头上写着「即时生效」就把它们也当即时的。 */}
        {isWakePolicy && open && (
          <div className="rounded-md border p-3">
            {/* ★★ 判定通路**不给按钮**（0.2.3 用户要求去掉）。
                规则只有一条：**填了这把 key → 直连用它；没填 → 用一次性 DSH 进程。**
                为什么这样分：两条路在唤醒流程里做的是同一件事（让一个模型判断
                "这句话是不是说给我听的"），让使用者选一个自己无法判断好坏的东西没有意义；
                而"要不要单独配一把 key"本身就是那个选择的**可观察依据**。
                ★ 这条推导必须与后端 `bridge.mjs#ensureWakeJudge` **完全一致** ——
                  否则界面说的和实际跑的不是一条路。 */}
            <FieldRow
              label="判定专用 API key"
              hint={
                <>
                  <strong>留空</strong> = 走<strong>一次性 DSH 进程</strong>做判定（约 3~5 秒，
                  用主对话那套凭据，不需要在这里配任何东西）。
                  <strong>填上</strong> = 改成<strong>直连</strong>（约 1 秒），
                  <strong>并且只用这把 key</strong> —— 不会拿主对话那把去发请求。
                  ★ 想给判定单独计费 / 单独限流，或者想用更便宜的小模型，就填它。
                </>
              }
            >
              <div className="flex max-w-md items-center gap-2">
                <Input
                  type="password"
                  value={String(getPath(cfg, 'wake.judge.apiKey') ?? '')}
                  onChange={(e) => patch('wake.judge.apiKey', e.target.value)}
                  autoComplete="new-password"
                  className="font-mono text-sm"
                  placeholder={hasJudgeKey ? '已配置（留空即不修改）' : '留空 = 用一次性 DSH 进程'}
                />
                {hasJudgeKey && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 shrink-0 text-xs"
                    onClick={() => patch('wake.judge.apiKey', null)}
                  >
                    <KeyRound className="mr-1 h-3.5 w-3.5" />
                    清除
                  </Button>
                )}
              </div>
              <InlineNote level="info">
                当前实际走的是：<strong>{hasJudgeKey ? '直连（用上面这把 key）' : '一次性 DSH 进程'}</strong>
                {hasJudgeKey ? ' —— 约 1 秒，不会碰主对话那把 key。' : ' —— 约 3~5 秒，不需要额外配 key。'}
                {hasJudgeKey ? '' : ' 想让判定变快、或想单独计费，就在上面填一把专用 key。'}
              </InlineNote>
            </FieldRow>
            <p className="-mt-1 mb-2 text-xs text-amber-700">★ 改它要重启（判定器首次被用到时装配一次）。</p>

            {hasJudgeKey && (
              <>
                <FieldRow
                  label="判定模型"
                  hint={
                    <>
                      留空 = 用主对话那个（<code>dsh.model</code>）。判定只要一个小 JSON，
                      <strong>换成更便宜的小模型是省钱的主要手段</strong>。
                    </>
                  }
                >
                  <Input
                    value={String(getPath(cfg, 'wake.judge.model') ?? '')}
                    placeholder="留空 = 用 dsh.model"
                    onChange={(e) => patch('wake.judge.model', e.target.value)}
                  />
                </FieldRow>
                <FieldRow
                  label="判定端点"
                  hint={
                    <>
                      默认 <code>https://api.deepseek.com</code>（<strong>注意没有 /v1</strong>）。
                      ★ 只允许 <code>https</code>，或回环地址的 <code>http</code> ——
                      API key 是放在请求头里的，明文发出去等于裸奔。
                    </>
                  }
                >
                  <Input
                    value={String(getPath(cfg, 'wake.judge.baseUrl') ?? '')}
                    placeholder="https://api.deepseek.com"
                    onChange={(e) => patch('wake.judge.baseUrl', e.target.value)}
                  />
                </FieldRow>
                <p className="-mt-1 mb-2 text-xs text-muted-foreground">★ 改上面两项也要重启。</p>
              </>
            )}

            <FieldRow
              label="判定器 · 影子模式"
              hint={
                <>
                  <strong>关（默认）</strong>= 判定真的生效：被判「沉默」的消息不会得到回复。
                  <strong>开</strong> = 只记账不改行为（结论写进 runtime/oplog/），用来先观察它想拦什么。
                  这一项即时生效（每轮现读）。
                </>
              }
            >
              <Switch checked={shadowOn} onCheckedChange={(v) => patch('wake.judge.shadow', v)} />
            </FieldRow>
            {!shadowOn && (
              <InlineNote level="warn">
                判定<strong>已经生效</strong>：被判「沉默」的消息<strong>不会</strong>得到回复，
                而且没有任何提示。先用影子模式（打开上面这个开关）跑一段再决定，会更稳妥。
              </InlineNote>
            )}
            <FieldRow
              label="判定超时"
              hint="必须小于「先应一声」的等待（humanize.interim.afterMs，默认 8000）：判定比它还慢，用户会先看到「我在想」、然后什么都没有。超时一律按放过处理。"
            >
              <NumInput
                value={getNum(cfg, 'wake.judge.timeoutMs', 6000)}
                onChange={(n) => patch('wake.judge.timeoutMs', n)}
                unit="毫秒"
                min={1000}
              />
            </FieldRow>
            <p className="-mt-1 mb-2 text-xs text-amber-700">
              ★ 改它要重启：判定器首次被用到时装配一次（预算计数器要跨消息累积，不能每条重建）。
            </p>
            <FieldRow
              label="每小时判定上限"
              hint="每条候选消息要花一次模型调用做判定，这是唯一挡住最坏情况的上限；超了一律放过（退回规则唤醒）。"
            >
              <NumInput
                value={getNum(cfg, 'wake.judge.maxPerHour', 60)}
                onChange={(n) => patch('wake.judge.maxPerHour', n)}
                unit="次"
                min={1}
              />
            </FieldRow>
            <p className="-mt-1 text-xs text-amber-700">★ 改它要重启（同上，装配一次）。</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
