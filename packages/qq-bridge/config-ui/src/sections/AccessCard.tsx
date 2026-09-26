import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { FieldRow, InlineNote, TagInput } from '@/components/common'
import { api, isNotImplemented, type Roster } from '@/lib/api'
import { getStrArr } from '@/lib/config'
import { cn } from '@/lib/utils'
import { ListChecks, Loader2, RefreshCw, ShieldAlert } from 'lucide-react'

/**
 * 名单与权限（三级，CONFIG-UI.md §2.7.4）。
 * 三张名单各管一件事，空的时候行为不一样，必须在界面上写清：
 *  - adminUsers：管理员（满权限）。空 = 谁都不能用
 *  - dmAllowlist：私聊白名单（普通用户，只读）。空 = 只有管理员能私聊
 *  - groupAllowlist：群白名单。空 = 所有群都不回
 * 名单能从真实好友/群列表（GET /api/roster）里勾选，不只手打号码——
 * 号码打错的症状是静默的（那个人就是不回）。
 */

const DEMO_ROSTER: Roster = {
  friends: [
    { userId: '100000001', nickname: '无忘远霞' },
    { userId: '66600000', nickname: '小Q' },
  ],
  groups: [{ groupId: '700000002', name: '某个群' }],
  unknownAdmins: [],
  unknownDmUsers: [],
  unknownGroups: [],
  friendsKnown: true,
  groupsKnown: true,
  cached: true,
  warnings: [],
}

/** 勾选/取消一个号码，返回新数组。 */
function toggleId(list: string[], id: string, on: boolean): string[] {
  return on ? [...new Set([...list, id])] : list.filter((x) => x !== id)
}

/** 一组可勾选的真实名单 + 不在名单里的手输项。 */
function RosterPicker({
  items,
  idKey,
  nameKey,
  selected,
  onChange,
  validate,
  manualPlaceholder,
}: {
  items: Record<string, string>[]
  idKey: 'userId' | 'groupId'
  nameKey: 'nickname' | 'name'
  selected: string[]
  onChange: (v: string[]) => void
  validate?: (w: string) => string | null
  manualPlaceholder: string
}) {
  const knownIds = new Set(items.map((it) => it[idKey]))
  const manual = selected.filter((id) => !knownIds.has(id))

  return (
    <div className="space-y-2">
      {items.length > 0 && (
        <div className="max-h-44 overflow-y-auto rounded-md border">
          {items.map((it) => {
            const id = it[idKey]
            const checked = selected.includes(id)
            return (
              <label
                key={id}
                className={cn(
                  'flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 text-sm last:border-b-0 hover:bg-accent/60',
                  checked && 'bg-accent/40',
                )}
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(v) => onChange(toggleId(selected, id, v === true))}
                />
                <span className="min-w-0 flex-1 truncate">{it[nameKey]}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{id}</span>
              </label>
            )
          })}
        </div>
      )}
      {/* 名单之外的号码（手输的 / 已退群的）仍然要能看能删 */}
      {(manual.length > 0 || items.length === 0) && (
        <TagInput
          values={manual}
          onChange={(v) => onChange([...selected.filter((id) => knownIds.has(id)), ...v])}
          placeholder={manualPlaceholder}
          validate={validate}
        />
      )}
    </div>
  )
}

export function AccessCard({
  cfg,
  patch,
  demo,
}: {
  cfg: Record<string, unknown>
  patch: (path: string, value: unknown) => void
  demo: boolean
}) {
  const [roster, setRoster] = useState<Roster | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(
    async (refresh = false) => {
      if (demo) {
        setRoster(DEMO_ROSTER)
        setLoading(false)
        return
      }
      if (refresh) setRefreshing(true)
      try {
        setRoster(await api.roster(refresh))
        setPending(false)
        setError(null)
      } catch (e) {
        if (isNotImplemented(e)) {
          setPending(true)
        } else {
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [demo],
  )

  useEffect(() => {
    load()
  }, [load])

  const admins = getStrArr(cfg, 'access.adminUsers', [])
  const dmAllow = getStrArr(cfg, 'access.dmAllowlist', [])
  const groupAllow = getStrArr(cfg, 'access.groupAllowlist', [])

  const qqValidate = (w: string) => (/^\d{5,11}$/.test(w) ? null : 'QQ 号一般是 5~11 位数字')

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ListChecks className="h-4 w-4" />
            ★ 名单与权限（三级）
          </CardTitle>
          {roster?.cached && (
            <span className="text-xs text-muted-foreground">名单来自缓存</span>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 text-xs"
            onClick={() => load(true)}
            disabled={refreshing || pending}
            title="好友/群列表走缓存，点这个强制重新拉取"
          >
            {refreshing ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
            )}
            重新拉取名单
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          三张名单各管一件事，<strong>空的时候行为不一样</strong>——分别写在下面每一组里。
          从真实好友/群列表里勾选即可，不用手打号码（打错了的症状是静默的：那个人就是不回）。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 后端给的告警必须显示出来，不吞 */}
        {roster?.warnings?.map((w, i) => (
          <InlineNote key={i} level="warn">
            {w}
          </InlineNote>
        ))}
        {pending && (
          <InlineNote level="info">名单接口还没实现（目前返回 501），先用手动输入。</InlineNote>
        )}
        {error && <InlineNote level="warn">{error}</InlineNote>}
        {loading && !roster && !pending && !error && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在拉取好友与群列表…
          </div>
        )}

        {/* 名单没拉到 ≠ 你没有好友。friendsKnown/groupsKnown=false 时不显示"找不到号码" */}
        {roster && (!roster.friendsKnown || !roster.groupsKnown) && (
          <InlineNote level="info">
            好友/群列表这次没拉到（多半是 SnowLuma 没在跑）——下面只显示手动输入。
            这不代表你的账号没有好友。
          </InlineNote>
        )}

        {/* 配置里的号码在真实名单里找不到 → 醒目提示（多半是打错了） */}
        {roster && roster.friendsKnown && (roster.unknownAdmins.length > 0 || roster.unknownDmUsers.length > 0) && (
          <InlineNote level="danger">
            <strong>这些号码不在好友列表里，多半是打错了：</strong>
            {[...roster.unknownAdmins.map((x) => `${x}（管理员）`), ...roster.unknownDmUsers.map((x) => `${x}（私聊）`)].join('、')}
            。症状是那个人发消息机器人不回。
          </InlineNote>
        )}
        {roster && roster.groupsKnown && roster.unknownGroups.length > 0 && (
          <InlineNote level="danger">
            <strong>这些群号不在群列表里，多半是打错了：</strong>
            {roster.unknownGroups.join('、')}。症状是那个群里机器人不回。
          </InlineNote>
        )}

        {/* ★★★「只读」的边界必须如实告诉使用者 */}
        <InlineNote level="warn">
          <ShieldAlert className="mr-1 inline h-3.5 w-3.5" />
          普通用户<strong>不能</strong>命令机器人做有实际修改的操作（建/删文件、改内容、跑命令）。
          这是靠<strong>在提示词里明确禁止</strong>实现的——机器人<strong>有能力</strong>做，只是被要求不做。
          它防的是<strong>误伤</strong>（随口一句就让它动了你的文件），<strong>不是</strong>防恶意。
          需要真正隔离的话，得给它单独跑一个只读沙箱的实例。
        </InlineNote>

        <div className="divide-y rounded-md border">
          <FieldRow
            star
            label="管理员"
            hint="满权限，可以命令机器人做有实际修改的动作。空 = 谁都不能用。填你自己的 QQ 号，不是机器人自己的号。"
            className="px-3"
          >
            <RosterPicker
              items={(roster?.friends ?? []) as unknown as Record<string, string>[]}
              idKey="userId"
              nameKey="nickname"
              selected={admins}
              onChange={(v) => patch('access.adminUsers', v)}
              validate={qqValidate}
              manualPlaceholder="手动输入 QQ 号，回车添加"
            />
          </FieldRow>
          <FieldRow
            label="私聊白名单（普通用户）"
            hint="只能看和聊（只读）。空 = 只有管理员能私聊。"
            className="px-3"
          >
            <RosterPicker
              items={(roster?.friends ?? []) as unknown as Record<string, string>[]}
              idKey="userId"
              nameKey="nickname"
              selected={dmAllow}
              onChange={(v) => patch('access.dmAllowlist', v)}
              validate={qqValidate}
              manualPlaceholder="手动输入 QQ 号，回车添加"
            />
          </FieldRow>
          <FieldRow
            label="群白名单"
            hint="哪些群能用机器人。空 = 所有群都不回（群里静默不说话，避免刷屏与暴露）。群里普通群友一律是只读用户，发言人是不是管理员由上面的名单决定。"
            className="px-3"
          >
            <RosterPicker
              items={(roster?.groups ?? []) as unknown as Record<string, string>[]}
              idKey="groupId"
              nameKey="name"
              selected={groupAllow}
              onChange={(v) => patch('access.groupAllowlist', v)}
              validate={qqValidate}
              manualPlaceholder="手动输入群号，回车添加"
            />
          </FieldRow>
        </div>
      </CardContent>
    </Card>
  )
}
