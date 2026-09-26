import { useCallback, useEffect, useState } from 'react'
import { UserRoundPen } from 'lucide-react'
import { toast } from 'sonner'

import { api, isNotImplemented, type ContactsResult, type Roster } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { InlineNote } from '@/components/common'
import { FancySelect } from '@/components/FancySelect'

/**
 * 昵称（按人）：机器人怎么称呼某个人（0.2.2，规格见 CONFIG-UI.md §2.5「昵称」）。
 *
 * 它取代的是旧的全局「它怎么称呼对方」（callUser，已移除）—— 那是某个人的属性，
 * 不是全局设置：对甲叫"老板"、对乙叫"群友"，一个框表达不了。
 *
 * ★ 四条边界（必须写进界面）：
 *   1. 昵称不是身份：权限只看 access.adminUsers 里的号码，跟昵称毫无关系；
 *   2. 这里填的是"希望的叫法"，与协议端昵称（好友昵称/群名片）冲突时以这里为准，
 *      两个都显示出来，别让人以为"改了没生效"；
 *   3. 把关只有后端一处实现（≤12 字、不带括号、不含"忽略/指令/设定"类词）——
 *      界面不自己再写一份判据，被拒时原样显示后端原因；
 *   4. 只由人在界面里填：模型不许给自己起名写这一栏。
 * ★ 格式只有后端一处实现：界面不解析/生成 memory/contacts.md 的文本。
 */
export function ContactsCard({ demo = false }: { demo?: boolean }) {
  const [data, setData] = useState<ContactsResult | null>(null)
  const [roster, setRoster] = useState<Roster | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [newQq, setNewQq] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await api.contacts())
      setUnsupported(false)
      setErr(null)
    } catch (e) {
      if (isNotImplemented(e)) setUnsupported(true)
      else setErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    if (demo) return
    void load()
    // 协议端昵称只作参考显示（好友列表）；拿不到不碍事
    api
      .roster()
      .then(setRoster)
      .catch(() => {})
  }, [demo, load])

  if (demo || unsupported) return null

  const friendName = (qq: string) => roster?.friends.find((f) => f.userId === qq)?.nickname ?? ''

  const save = async (qq: string, nickname: string) => {
    setBusy(true)
    try {
      const r = await api.contactSave(qq, nickname)
      toast.success(nickname ? '已保存，下一轮就生效（不需要重启）。' : '已删除。')
      if (r.contacts) {
        setData((d) => (d ? { ...d, contacts: r.contacts ?? d.contacts, count: r.count ?? d.count, exists: true } : d))
      } else {
        await load()
      }
      return true
    } catch (e) {
      // 400（号码不合法）/ 422（昵称可疑）：原样显示后端原因，界面不自己写判据
      toast.error(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const addFromInput = async () => {
    const qq = newQq.trim()
    if (!qq) return
    // 新增时昵称先放空不行（空串 = 删除）；用协议端昵称作初值，让人接着改
    const initial = friendName(qq) || '（填称呼）'
    const nickname = window.prompt(`给 ${qq} 填一个称呼（≤12 字）：`, friendName(qq) || '')?.trim()
    if (!nickname) return
    const ok = await save(qq, nickname || initial)
    if (ok) setNewQq('')
  }

  const maxChars = data?.maxChars ?? 12

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <UserRoundPen className="h-4 w-4" />
          昵称（它怎么称呼某个人）
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          按 QQ 号记；私聊和群里对同一个人都生效。改完<strong>下一轮就生效</strong>（不需要重启）。
          这里填的是「你希望它怎么叫」，和协议端昵称（好友昵称/群名片）不是一回事，冲突时以这里为准。
          <strong>昵称不是身份</strong>：权限只看配置里的管理员号码，跟昵称毫无关系。
        </p>

        {err && <InlineNote level="warn">{err}</InlineNote>}

        {data && data.contacts.length === 0 && (
          <p className="text-xs text-muted-foreground">
            还没有给任何人设过称呼。它默认按协议端昵称/「你」来称呼对方；想固定某个叫法就在这里加一条。
          </p>
        )}

        {data && data.contacts.length > 0 && (
          <div className="space-y-1.5">
            {data.contacts.map((c) => (
              <ContactRow
                key={c.qq}
                qq={c.qq}
                nickname={c.nickname}
                protocolName={friendName(c.qq)}
                maxChars={maxChars}
                busy={busy}
                onSave={(nick) => void save(c.qq, nick)}
                onDelete={() => void save(c.qq, '')}
              />
            ))}
          </div>
        )}

        {/* 认不出来的行：显示出来，别静默丢 */}
        {data && data.bad.length > 0 && (
          <InlineNote level="warn">
            {data.rel} 里有 {data.bad.length} 行认不出来（不会被注入）：
            {data.bad.map((b, i) => (
              <code key={i} className="mx-1 rounded bg-white/50 px-1 text-xs">
                {b}
              </code>
            ))}
          </InlineNote>
        )}

        {/* 挑人优先于手打：号码打错的表现是"这个称呼永远不生效"，很难查 */}
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <FancySelect
            value=""
            onChange={(qq) => {
              if (!qq) return
              const nickname = window.prompt(`给 ${qq}（${friendName(qq)}）填一个称呼（≤12 字）：`, friendName(qq))?.trim()
              if (nickname) void save(qq, nickname)
            }}
            options={(roster?.friends ?? [])
              .filter((f) => !data?.contacts.some((c) => c.qq === f.userId))
              .map((f) => ({ value: f.userId, label: f.nickname, hint: f.userId }))}
            placeholder="从好友列表挑一个…"
            className="min-w-56"
          />
          <span className="text-xs text-muted-foreground">或手输 QQ 号</span>
          <Input
            value={newQq}
            onChange={(e) => setNewQq(e.target.value.replace(/\D/g, ''))}
            placeholder="QQ 号"
            className="h-9 w-36 font-mono"
          />
          <Button size="sm" variant="outline" onClick={() => void addFromInput()} disabled={busy || !newQq.trim()}>
            添加
          </Button>
          {data && (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {data.count} / {data.max} 人 · 每条 ≤ {maxChars} 字（会注入提示词，太长是纯成本）
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function ContactRow({
  qq,
  nickname,
  protocolName,
  maxChars,
  busy,
  onSave,
  onDelete,
}: {
  qq: string
  nickname: string
  protocolName: string
  maxChars: number
  busy: boolean
  onSave: (nickname: string) => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState(nickname)
  const dirty = draft.trim() !== nickname
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-2 py-1.5">
      <span className="font-mono text-xs">{qq}</span>
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        maxLength={maxChars + 8}
        className="h-8 w-36 text-sm"
      />
      {protocolName && <span className="text-xs text-muted-foreground">协议端昵称：{protocolName}</span>}
      <span className="ml-auto flex gap-1">
        {dirty && (
          <Button size="sm" className="h-7 text-xs" disabled={busy || !draft.trim()} onClick={() => onSave(draft.trim())}>
            保存
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs text-red-600"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`删掉 ${qq} 的称呼「${nickname}」？删完它下一轮就按协议端昵称/「你」来称呼。`)) onDelete()
          }}
        >
          删除
        </Button>
      </span>
    </div>
  )
}
