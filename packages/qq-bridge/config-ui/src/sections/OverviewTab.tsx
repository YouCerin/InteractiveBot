import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { ApiStatus } from '@/lib/api'
import { getStr } from '@/lib/config'
import { cn } from '@/lib/utils'
import { Inbox, MessageSquareReply, Zap, Ban, SkipForward, CircleX } from 'lucide-react'
import { UsagePanel } from '@/sections/UsagePanel'

const STAT_ITEMS = [
  { key: 'received', label: '收到', icon: Inbox, color: 'text-sky-600' },
  { key: 'triggered', label: '触发', icon: Zap, color: 'text-violet-600' },
  { key: 'answered', label: '回复', icon: MessageSquareReply, color: 'text-emerald-600' },
  { key: 'skipped', label: '跳过', icon: SkipForward, color: 'text-gray-500' },
  { key: 'denied', label: '拒绝', icon: Ban, color: 'text-amber-600' },
  { key: 'failed', label: '失败', icon: CircleX, color: 'text-red-600' },
] as const

export function OverviewTab({
  status,
  cfg,
  demo,
}: {
  status: ApiStatus | null
  cfg: Record<string, unknown>
  demo: boolean
}) {
  const stats = status?.stats
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {STAT_ITEMS.map(({ key, label, icon: Icon, color }) => (
          <Card key={key}>
            <CardContent className="flex items-center gap-3 p-4">
              <Icon className={cn('h-5 w-5', color)} />
              <div>
                <div className="text-2xl font-semibold tabular-nums">{stats?.[key] ?? '—'}</div>
                <div className="text-xs text-muted-foreground">{label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <UsagePanel demo={demo} />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">连接与环境</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex justify-between gap-4 border-b border-dashed pb-2">
              <dt className="text-muted-foreground">OneBot 连接</dt>
              <dd>{status?.connected ? '✅ 已连接' : '❌ 未连接'}</dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-dashed pb-2">
              <dt className="text-muted-foreground">DSH 进程</dt>
              <dd>{status?.dshAlive ? '✅ 存活' : '❌ 不在'}</dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-dashed pb-2">
              <dt className="text-muted-foreground">已登录 QQ</dt>
              <dd>
                {status?.login ? `${status.login.nickname} (${status.login.userId})` : '—'}
              </dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-dashed pb-2">
              <dt className="text-muted-foreground">群聊总开关</dt>
              <dd>{status?.groupEnabled ? '已开启' : '已关闭（默认）'}</dd>
            </div>
            <div className="flex justify-between gap-4 sm:col-span-2">
              <dt className="shrink-0 text-muted-foreground">工作区（记忆所在）</dt>
              <dd className="truncate font-mono text-xs" title={status?.workspace ?? getStr(cfg, 'dsh.workspace')}>
                {status?.workspace ?? getStr(cfg, 'dsh.workspace') ?? '—'}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </div>
  )
}
