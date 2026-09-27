import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
// ★ 0.2.3：「唤醒方式」（原「什么时候回我」）已搬到「扩展 → 唤醒策略」下面 ——
//   见 `sections/WakeRulesSection.tsx`。它本来就该跟 `wake.policy` 在一起：
//   那条策略说的是"用哪一套判据决定回不回"，而这一节就是 `rule` 那套判据的全部内容。
//   于是 `Switch` / `TagInput` / `keywordWarnings` / `getBool` / `getStrArr` /
//   `ConfirmRequest` 在本页都不再需要（tsconfig 开了 noUnusedLocals，删干净）。
import { InlineNote } from '@/components/common'
import { FancySelect } from '@/components/FancySelect'
import { personaMentionsTools } from '@/lib/config'
import { api, isNotImplemented, type PersonaItem, type PersonaShelf } from '@/lib/api'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

/**
 * 人设页（0.2.2：人设库 + 并入原「触发」页）。规格见 CONFIG-UI.md §2.2。
 *
 * 这一页回答两件事：① **目前人设**是哪一个（能当场切、能新建/改名/删除）；
 * ② 它现在的**正文**长什么样（能看、能改）。
 *
 * 形状：人设是一个**库** —— `personas/<名字>.md`，一个文件一套人设，
 * 文件名叫什么这一页里就叫什么。默认两套也是其中两个文件，不是代码里的特例。
 *
 * ★ 生效方式：人设在启动构造期算一次并缓存，切换/改了正在用的那一套都要**重启** ——
 *   后端在响应里如实回 `restartRequired`，界面照它说，不许自己猜。
 * ★ 列表、字数、当前生效、模板、上限一律由后端给（GET /api/personas）——
 *   前端硬编码就会出现第二份真值。
 * ★ 本页**不再有**：「用户怎么叫它」栏（名字块在正文里，直接改正文）、
 *   「它怎么称呼对方」（0.2.2 已移除，改为记忆页的按人昵称）、内置三选一（老路径，不伸手）、
 *   **「什么时候回我」**（0.2.3 搬到「扩展 → 唤醒策略」卡里的「唤醒方式」一节）。
 * ★ **所以这一页现在一个配置键都不碰** —— 它只跟 `personas/*.md` 与那几个接口打交道。
 *   这就是它不再需要 `cfg` / `patch` / `askConfirm` 的原因（不是漏传）。
 */
export function PersonaTab() {
  const [shelf, setShelf] = useState<PersonaShelf | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [unsupported, setUnsupported] = useState(false)

  const load = useCallback(async () => {
    try {
      setShelf(await api.personas())
      setLoadErr('')
      setUnsupported(false)
    } catch (e) {
      // 旧接口已换代（410）或旧包没有（404/501）：都算"这个版本还没有"，不白屏
      if (isNotImplemented(e) || (e instanceof Error && 'status' in e && (e as { status?: number }).status === 410)) {
        setUnsupported(true)
      } else {
        setLoadErr(e instanceof Error ? e.message : String(e))
      }
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** 动作后的统一处理：用响应里的 shelf 更新；生效方式照后端 restartRequired 说。 */
  const runAction = async (body: Parameters<typeof api.personaAction>[0]) => {
    try {
      const r = await api.personaAction(body)
      if (r.shelf) setShelf(r.shelf)
      else await load()
      if (r.restartRequired) {
        toast.warning(r.hint ?? '已完成。需要重启机器人才会生效。', { duration: 8000 })
      } else {
        toast.success(r.hint ?? '已完成。')
      }
      return true
    } catch (e) {
      // 422 的原因（非法名/重名…）原样显示后端给的，不自己编
      toast.error(e instanceof Error ? e.message : String(e))
      return false
    }
  }

  if (unsupported) {
    return (
      <InlineNote level="warn">
        人设接口已换代或这个版本还没有（旧包）。0.2.2 起人设是「人设库」（personas/&lt;名字&gt;.md），
        升级后端后这一页会列出全部人设。
      </InlineNote>
    )
  }

  return (
    <div className="space-y-4">
      {loadErr && <InlineNote level="warn">{loadErr}</InlineNote>}
      <CurrentPersonaCard shelf={shelf} runAction={runAction} />
      <PersonaTextCard shelf={shelf} runAction={runAction} />
      {/* ★ 0.2.3：这里**不再有**「唤醒方式」卡 —— 它搬到了「扩展 → 唤醒策略」下面
          （`WakeRulesSection`）。留在本页会让"用什么判据决定回不回"被劈成两处。 */}
    </div>
  )
}

// ── 卡片 1：目前人设（★ 卡片标题就叫这四个字）────────────────────────────────
// 「选择人设」在这张卡里面，不是另起一张卡 —— "现在用的是哪一套"和"换成哪一套"
// 是同一件事的两面。

function CurrentPersonaCard({
  shelf,
  runAction,
}: {
  shelf: PersonaShelf | null
  runAction: (body: Parameters<typeof api.personaAction>[0]) => Promise<boolean>
}) {
  const [openName, setOpenName] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [copyFrom, setCopyFrom] = useState('')

  const activate = (name: string) => {
    void runAction({ action: 'activate', name })
  }

  const create = async () => {
    const name = newName.trim()
    if (!name) {
      toast.error('先给人设起个名字（名字就是文件名，也是这一页里显示的名字）。')
      return
    }
    const ok = await runAction({
      action: 'create',
      name,
      copyFrom: copyFrom && copyFrom !== '__blank__' ? copyFrom : undefined,
    })
    if (ok) {
      setCreating(false)
      setNewName('')
      setCopyFrom('')
    }
  }

  const remove = (p: PersonaItem) => {
    if (!window.confirm(`删除「${p.name}」？这套人设的文件会被删掉。`)) return
    void runAction({ action: 'delete', name: p.name })
  }

  const rename = (p: PersonaItem) => {
    const to = window.prompt(`把「${p.name}」改名为：`, p.name)?.trim()
    if (!to || to === p.name) return
    void runAction({ action: 'rename', name: p.name, to })
  }

  const noneActive = shelf?.activeSource === 'none'

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">目前人设</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {shelf ? (
          <div className="text-sm">
            <span className="font-medium">
              {shelf.activeSource === 'none' ? '不使用人设' : shelf.activeName}
            </span>
            {shelf.activeSource !== 'none' && (
              <span className="text-muted-foreground">（{shelf.activeChars} 字，每轮都进提示词）</span>
            )}
            {shelf.activeSource === 'none' && (
              <span className="text-muted-foreground">（只用平台规则；排查"是不是人设的锅"时用）</span>
            )}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">正在读取人设库…</div>
        )}

        {/* ★★ 当前这套会被整文件拒载：必须红字（最容易让人以为"机器人坏了"的静默失效） */}
        {shelf?.activeBlocked && (
          <InlineNote level="danger">
            当前这一套在启动时会被<strong>整文件拒载</strong>
            {shelf.activeBlockReasons.length > 0 && <>（原因：{shelf.activeBlockReasons.join('；')}）</>}，
            实际注入的是一段占位文本。
          </InlineNote>
        )}
        {/* persona.active 指的那一套找不到（被删/改名） */}
        {shelf?.activeError && <InlineNote level="danger">{shelf.activeError}（当前按「不使用人设」在跑）</InlineNote>}
        {/* 老配置回落：配置里还是 0.2.2 之前的写法，列表里那几套都没在用 */}
        {shelf?.legacy && (
          <InlineNote level="warn">
            配置里还是 0.2.2 之前的老写法（preset：{shelf.legacy.preset}
            {shelf.legacy.customChars > 0 ? `，自定义 ${shelf.legacy.customChars} 字` : ''}
            ）——现在生效的是老路径，下面列表里那几套<strong>都没在用</strong>。
            建议：用「新建人设」把正文存成一套（或以某一套为基础新建），再切换过去。
          </InlineNote>
        )}

        {/* 选择人设（单选列表，在本卡内）。列表与顺序都照后端（默认两套固定在前）。 */}
        <div className="space-y-1.5">
          {shelf?.personas.map((p) => (
            <div
              key={p.name}
              className={cn(
                'rounded-md border px-3 py-2',
                p.active && 'border-primary bg-accent/50',
                p.blocked && 'border-red-300',
              )}
            >
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="persona-active"
                  checked={p.active}
                  onChange={() => activate(p.name)}
                  className="mt-0.5"
                />
                <span className="text-sm font-medium">{p.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{p.chars} 字</span>
                {p.isDefault && (
                  <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">出厂默认</span>
                )}
                {p.blocked && (
                  <span className="rounded bg-red-100 px-1 text-[10px] text-red-800">
                    会被整文件拒载（选着它实际注入的是 [BLOCKED]）
                  </span>
                )}
                <span className="ml-auto flex gap-1">
                  {p.chars > 0 && (
                    <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpenName(openName === p.name ? '' : p.name)}>
                      {openName === p.name ? '收起' : '看全文'}
                    </Button>
                  )}
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => rename(p)}>
                    改名
                  </Button>
                  <Button type="button" variant="ghost" size="sm" className="h-7 text-xs text-red-600" onClick={() => remove(p)}>
                    删除
                  </Button>
                </span>
              </div>
              {!p.hasNameBlock && (
                <p className="mt-1 pl-5 text-xs text-amber-700">
                  ⚠️ 这套正文里<strong>没有名字块</strong> —— 叫名字会回落到兜底名（静默失效的高发处）。
                  想修就在下面「人设正文」里把名字块加到开头。
                </p>
              )}
              {openName === p.name && p.chars > 0 && (
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted/60 p-3 text-xs leading-relaxed">
                  {p.text}
                </pre>
              )}
            </div>
          ))}

          {/* 列表里固定有的一项：不使用人设 */}
          <div className={cn('rounded-md border px-3 py-2', noneActive && 'border-primary bg-accent/50')}>
            <div className="flex items-center gap-2">
              <input
                type="radio"
                name="persona-active"
                checked={noneActive === true}
                onChange={() => activate('none')}
              />
              <span className="text-sm font-medium">不使用人设</span>
              <span className="text-xs text-muted-foreground">只用平台规则；排查"是不是人设的锅"时用</span>
            </div>
          </div>
        </div>

        {/* 空态：一套都没有时不要显示空白区块 */}
        {shelf && shelf.personas.length === 0 && (
          <InlineNote level="warn">一套人设都没有。点下面的「恢复默认两套」把出厂的请回来。</InlineNote>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setCreating(!creating)}>
            + 新建人设
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void runAction({ action: 'restore-defaults' })}
          >
            恢复默认两套
          </Button>
          <span className="text-xs text-muted-foreground">切换/改名/删除正在用的那套后，需要重启才生效。</span>
        </div>

        {creating && (
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="人设名字（必填；就是文件名）"
                className="max-w-xs"
              />
              <FancySelect
                value={copyFrom}
                onChange={setCopyFrom}
                options={[
                  { value: '__blank__', label: '从空白模板开始' },
                  ...(shelf?.personas ?? []).map((p) => ({
                    value: p.name,
                    label: `以「${p.name}」为基础`,
                    hint: `${p.chars} 字`,
                  })),
                ]}
                placeholder="从空白模板开始"
                className="min-w-56"
              />
              <Button size="sm" onClick={() => void create()}>
                新建
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              只是新建一套不需要重启；切到它才需要。非法名/重名会被后端拦下并原样显示原因。
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── 卡片 2：人设正文（新建 / 编辑）───────────────────────────────────────────
// 正文存在 personas/<名字>.md，不是 config.json。保存走 action:'save'。

function PersonaTextCard({
  shelf,
  runAction,
}: {
  shelf: PersonaShelf | null
  runAction: (body: Parameters<typeof api.personaAction>[0]) => Promise<boolean>
}) {
  const [target, setTarget] = useState('')
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // 默认选中当前生效的那一套；shelf 首次到达时同步一次
  useEffect(() => {
    if (!shelf) return
    if (!target || !shelf.personas.some((p) => p.name === target)) {
      const cur = shelf.personas.find((p) => p.active) ?? shelf.personas[0]
      if (cur) {
        setTarget(cur.name)
        setText(cur.text)
        setDirty(false)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shelf])

  const pick = (name: string) => {
    if (dirty && !window.confirm('当前编辑还没保存，切换会丢掉这些改动。继续？')) return
    const p = shelf?.personas.find((x) => x.name === name)
    if (!p) return
    setTarget(name)
    setText(p.text)
    setDirty(false)
  }

  const save = async () => {
    if (!target) return
    setSaving(true)
    try {
      const ok = await runAction({ action: 'save', name: target, text })
      if (ok) setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  const maxChars = shelf?.maxChars ?? 4000
  const isActiveTarget = shelf?.personas.find((p) => p.name === target)?.active === true

  if (shelf && shelf.personas.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">人设正文</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <FancySelect
            value={target}
            onChange={pick}
            options={(shelf?.personas ?? []).map((p) => ({
              value: p.name,
              label: p.name,
              hint: `${p.chars} 字${p.active ? ' · 正在用' : ''}`,
            }))}
            placeholder="选一套人设…"
            className="min-w-52"
          />
          <span className="text-xs text-muted-foreground">
            {isActiveTarget ? '改的是正在用的这套：保存后需要重启才生效。' : '这套没在用：保存立即落盘，不需要重启。'}
          </span>
        </div>
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setDirty(true)
          }}
          rows={14}
          className="font-mono text-sm leading-relaxed"
          placeholder={shelf?.template ? undefined : '人设正文'}
        />
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            名字块就在正文开头那段「【名字（机器可读…）】」里，想改名字直接改正文（0.2.2 起没有单独的结构化改名入口）。
          </span>
          <span className={cn('tabular-nums', text.length > maxChars && 'font-medium text-amber-600')}>
            {text.length} / {maxChars} 字
          </span>
        </div>
        {text.length > maxChars && (
          <InlineNote level="warn">超过上限：注入时会被「头 + 省略 + 尾」截断。</InlineNote>
        )}
        {personaMentionsTools(text) && (
          <InlineNote level="warn">里面疑似提到了工具名。提示词提到不存在的工具会让模型乱调工具。</InlineNote>
        )}
        <div>
          <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? '保存中…' : dirty ? '保存这套人设' : '已保存'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
