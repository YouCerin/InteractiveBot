import { useCallback, useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Puzzle,
  RefreshCw,
  ShieldAlert,
  Stethoscope,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  api,
  isNotImplemented,
  type ExtensionsResult,
  type PluginInfo,
  type SkillInfo,
} from '@/lib/api'
import { getBool, getNum } from '@/lib/config'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { FieldRow, InlineNote, NumInput, type ConfirmRequest } from '@/components/common'
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

/** uiTab → 界面上的页签名（「去细调」按钮给人看的，不是给代码看的）。 */
const TAB_LABEL: Record<string, string> = {
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
}: {
  plugin: PluginInfo
  cfg: Record<string, unknown>
  patch: (path: string, value: unknown) => void
  onToggle: (enabled: boolean) => void
  onNavigateTab: (tab: string) => void
}) {
  const [open, setOpen] = useState(false)
  const isList = p.switchKind === 'list'
  const isEnum = p.switchKind === 'enum'
  const isQqTools = p.id === 'qq-tools'

  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <div className="flex items-center gap-2">
          <span className="text-lg">{p.icon ?? '🔌'}</span>
          <span className="font-medium">{p.name}</span>
          {/* 生效方式徽标：cold 的必须把 why 显示出来（在下面） */}
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
              <Button variant="outline" size="sm" onClick={() => onNavigateTab(p.uiTab)}>
                去维护
              </Button>
            ) : (
              <Switch checked={p.enabled === true} onCheckedChange={onToggle} />
            )}
          </span>
        </div>

        {p.what && <p className="text-xs text-muted-foreground">{p.what}</p>}
        {/* ★ 关掉会怎样：直接显示原文，不改写 */}
        <p className="text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">关掉会怎样：</span>
          {p.offEffect.replace(/\*\*/g, '')}
        </p>
        {isEnum && (
          <p className="text-xs text-muted-foreground">
            这是枚举开关：打开时用的是<strong>默认档</strong>，不是「你上次选的那档」。
          </p>
        )}
        {!p.hot && p.why && (
          <p className="text-xs text-amber-700">
            为什么要重启：{p.why}
          </p>
        )}

        <div className="flex gap-2 pt-1">
          {isQqTools ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(!open)}>
              {open ? <ChevronDown className="mr-1 h-3.5 w-3.5" /> : <ChevronRight className="mr-1 h-3.5 w-3.5" />}
              详细设置
            </Button>
          ) : (
            p.uiTab &&
            p.uiTab !== 'extensions' && (
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => onNavigateTab(p.uiTab)}>
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
            <p className="mt-2 text-xs text-muted-foreground">
              策略是默认放行、黑名单拦截（踢人/禁言/改群名片/退群等会被直接拒绝）；拦截清单在代码里
              （mcp/mcp-qq-server.mjs 的 BLOCKED_ACTIONS），改它需要改代码而不是点界面。
              工具调用发生在「思考」阶段，「对话」页签里看不到过程——界面上什么都没发生是正常的。
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
