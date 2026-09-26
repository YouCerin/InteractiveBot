import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { FieldRow, InlineNote, NumInput } from '@/components/common'
import { getBool, getNum } from '@/lib/config'
import { cn } from '@/lib/utils'
import { Sparkles, CircleCheck, CircleX, EyeOff, RotateCw } from 'lucide-react'

/** 机器人能调用的 QQ 动作（与 mcp/mcp-qq-server.mjs 的 TOOLS 一致）。 */
const ALLOWED_ACTIONS = [
  '戳一戳某人',
  '发 QQ 表情',
  '撤回自己说错的消息',
  '查群成员列表',
  '读某条消息的详情',
  '读群聊历史',
  '其它 OneBot 动作（经 qq_api 调用）',
]

/** 已被黑名单拦截的危险动作（与 BLOCKED_ACTIONS 一致）。 */
const BLOCKED_ACTIONS = [
  '踢人 / 禁言 / 全员禁言',
  '设或撤管理员',
  '改别人的群名片 / 改群名 / 改头衔',
  '退群',
  '删好友 / 处理好友与入群请求',
  '改机器人自己的资料 / 头像 / 签名',
  '发群公告 / 群打卡',
]

export function McpTab({
  cfg,
  patch,
}: {
  cfg: Record<string, unknown>
  patch: (path: string, value: unknown) => void
}) {
  const enabled = getBool(cfg, 'mcp.enabled', true)

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div>
            <div className="flex items-center gap-2 font-medium">
              <Sparkles className="h-4 w-4 text-amber-500" />
              ★ QQ 工具（让机器人能「动手」而不只是「说话」）
            </div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              关掉 = 模型退回「只能发文字」：不能戳一戳、发表情、撤回说错的话、查群成员、读群历史。
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={(v) => patch('mcp.enabled', v)} />
        </CardContent>
      </Card>

      <div className={cn('space-y-4', !enabled && 'opacity-50')}>
        <Card>
          <CardContent className="pt-2">
            <FieldRow
              label="单个 QQ 动作的超时"
              hint="调一个动作最多等多久，超时算失败。"
            >
              <NumInput
                value={getNum(cfg, 'mcp.toolTimeoutMs', 20000)}
                onChange={(n) => patch('mcp.toolTimeoutMs', n)}
                unit="毫秒"
                min={1000}
              />
            </FieldRow>
          </CardContent>
        </Card>

        {/* ① 生效方式：重启 DSH 子进程 = 重启桥接 */}
        <InlineNote level="info">
          <RotateCw className="mr-1 inline h-3.5 w-3.5" />
          改本页设置后需要重启的是 DSH 子进程——它由桥接拉起，所以直接点顶部状态条的
          <strong>「重启」</strong>即可。
        </InlineNote>

        {/* ② 默认放行 + 黑名单拦截（不做每个动作的开关） */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">机器人能调哪些 QQ 动作</CardTitle>
            <p className="text-xs text-muted-foreground">
              策略是<strong className="text-foreground">默认放行、黑名单拦截</strong>：
              几乎全部动作都可用，只拦会伤害他人或账号的那些。
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <div className="mb-1.5 text-sm font-medium text-emerald-700">可以用</div>
              <ul className="grid gap-1 sm:grid-cols-2">
                {ALLOWED_ACTIONS.map((a) => (
                  <li key={a} className="flex items-center gap-1.5 text-sm">
                    <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    {a}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1.5 text-sm font-medium text-red-700">已被拦（模型调到会被直接拒绝）</div>
              <ul className="grid gap-1 sm:grid-cols-2">
                {BLOCKED_ACTIONS.map((a) => (
                  <li key={a} className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <CircleX className="h-3.5 w-3.5 shrink-0 text-red-500" />
                    {a}
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              这里没有逐个动作的开关——拦截清单在代码里
              （<code className="rounded bg-muted px-1">mcp/mcp-qq-server.mjs</code> 的
              BLOCKED_ACTIONS），改动它需要改代码而不是点界面。
            </p>
          </CardContent>
        </Card>

        {/* ③ 工具调用发生在"思考"阶段，界面上看不到过程 */}
        <InlineNote level="info">
          <EyeOff className="mr-1 inline h-3.5 w-3.5" />
          工具调用发生在「思考」阶段，「对话」页签里<strong>看不到过程</strong>。
          消息流里可能只出现结果（例如对方收到一个戳），而界面上什么都没发生——这是正常的，不是
          bug。
        </InlineNote>
      </div>
    </div>
  )
}
