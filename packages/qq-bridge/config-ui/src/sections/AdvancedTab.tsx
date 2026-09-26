import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { FieldRow, InlineNote, type ConfirmRequest } from '@/components/common'
import { getBool, getStr, getStrArr } from '@/lib/config'
import { KeyRound, ShieldAlert, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'

const PERMISSION_MODES = [
  { value: 'read-only', label: '只读', desc: '只能看，不能改' },
  { value: 'workspace-write', label: '仅工作区（推荐）', desc: '只能动工作区内的文件；越界自动被拒' },
  { value: 'danger-full-access', label: '全权（危险）', desc: '能读写整个磁盘且免审批' },
]

export function AdvancedTab({
  cfg,
  patch,
  askConfirm,
  apiKey,
  setApiKey,
}: {
  cfg: Record<string, unknown>
  patch: (path: string, value: unknown) => void
  askConfirm: (req: ConfirmRequest) => void
  /** 模型 API key 的草稿值（**不在 cfg 里** —— 见 Home.tsx 的说明）。 */
  apiKey: string
  setApiKey: (v: string) => void
}) {
  const perm = getStr(cfg, 'dsh.permissionMode', 'workspace-write')
  const hasApiKey = getBool(cfg, 'hasApiKey', false)

  /** 清除已保存的 API key（用 null 表达"显式清除"，空串仍是"保持原样"）。 */
  const clearApiKey = () => {
    askConfirm({
      title: '清除已配置的 API Key？',
      description: (
        <>
          清除后桥接会回退到环境变量 <code>DEEPSEEK_API_KEY</code> 与 DSH 的凭据文件
          （<code>%APPDATA%\dsh-desktop\harness\.credentials.yaml</code>）。
          如果那两处也没有 key，机器人<strong className="text-red-600">能收到消息但不会有任何回复内容</strong>
          （只会回一句兜底话术）。
        </>
      ),
      confirmText: '清除',
      onConfirm: () => {
        patch('dsh.apiKey', null)
        setApiKey('')
      },
    })
  }

  const choosePerm = (v: string) => {
    if (v === 'danger-full-access') {
      // ★ 全权模式必须二次确认（文案照抄 CONFIG-UI.md 2.7）
      askConfirm({
        title: '切到「全权（危险）」？',
        description: (
          <>
            这会让机器人能读写你<strong className="text-red-600">整个磁盘</strong>
            上的任何文件，而且<strong className="text-red-600">不再需要你确认</strong>。
            当前设计是「权限只限工作区」，选它等于放弃这道防线。
          </>
        ),
        confirmText: '我了解风险，切换',
        onConfirm: () => patch('dsh.permissionMode', v),
      })
    } else {
      patch('dsh.permissionMode', v)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wrench className="h-4 w-4" />
            DSH（大模型后端）
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          <FieldRow label="DSH 安装路径" hint="留空自动查找（vendor/dsh 优先 → 环境变量 → 默认安装位置）。">
            <Input
              value={getStr(cfg, 'dsh.cliPath')}
              onChange={(e) => patch('dsh.cliPath', e.target.value)}
              className="max-w-md font-mono text-sm"
              placeholder="留空自动查找"
            />
          </FieldRow>
          <FieldRow label="Provider">
            <Select
              value={getStr(cfg, 'dsh.provider', 'deepseek-official')}
              onValueChange={(v) => patch('dsh.provider', v)}
            >
              <SelectTrigger className="max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="deepseek-official">deepseek-official</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="模型">
            <Select
              value={getStr(cfg, 'dsh.model', 'deepseek-flash')}
              onValueChange={(v) => patch('dsh.model', v)}
            >
              <SelectTrigger className="max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="deepseek-flash">deepseek-flash</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>
          <FieldRow label="推理强度" hint="留空用模型默认。">
            <Select
              value={getStr(cfg, 'dsh.reasoningEffort') || '__default__'}
              onValueChange={(v) => patch('dsh.reasoningEffort', v === '__default__' ? '' : v)}
            >
              <SelectTrigger className="max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">默认（留空）</SelectItem>
                <SelectItem value="low">low</SelectItem>
                <SelectItem value="medium">medium</SelectItem>
                <SelectItem value="high">high</SelectItem>
                <SelectItem value="max">max</SelectItem>
              </SelectContent>
            </Select>
          </FieldRow>

          {/* ★ 模型 API key：发布包的主路径（不随包分发 DSH 时，用户手里没有 DSH 的凭据文件） */}
          <FieldRow
            label="API Key"
            hint="模型调用的凭据。留空 = 保持原样不修改；回退顺序：环境变量 DEEPSEEK_API_KEY → 这里 → DSH 的凭据文件。三处用的是同一把账号级 key。"
          >
            <div className="flex max-w-md items-center gap-2">
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="new-password"
                className="font-mono text-sm"
                placeholder={hasApiKey ? '已配置（留空即不修改）' : '尚未配置'}
              />
              {hasApiKey && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 shrink-0 text-xs"
                  onClick={clearApiKey}
                >
                  <KeyRound className="mr-1 h-3.5 w-3.5" />
                  清除
                </Button>
              )}
            </div>
          </FieldRow>

          <FieldRow
            label="额外搜索路径"
            hint="一行一个。DSH 装在非标准位置时用它（相对本包根目录解析）；留空则只查 vendor/dsh、环境变量 DSH_DESKTOP_APP 和 DSH 的默认安装位置。"
          >
            <textarea
              value={getStrArr(cfg, 'dsh.searchPaths', []).join('\n')}
              onChange={(e) =>
                patch(
                  'dsh.searchPaths',
                  e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                )
              }
              rows={2}
              className="w-full max-w-md rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder={'D:\\apps\\DeepSeekHarness\\resources\\app'}
            />
          </FieldRow>
        </CardContent>
      </Card>

      {/* ★ 权限模式 */}
      <Card className={cn(perm === 'danger-full-access' && 'border-red-400')}>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-4 w-4 text-amber-500" />
            ★ 权限模式（安全边界）
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {PERMISSION_MODES.map((m) => (
            <label
              key={m.value}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors',
                perm === m.value && 'border-primary bg-accent/50',
                m.value === 'danger-full-access' && perm === m.value && 'border-red-500 bg-red-50/60',
              )}
            >
              <input
                type="radio"
                name="permissionMode"
                className="mt-1"
                checked={perm === m.value}
                onChange={() => choosePerm(m.value)}
              />
              <div>
                <div
                  className={cn(
                    'text-sm font-medium',
                    m.value === 'danger-full-access' && 'text-red-600',
                  )}
                >
                  {m.label}
                </div>
                <div className="text-xs text-muted-foreground">{m.desc}</div>
              </div>
            </label>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">会话</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          <FieldRow label="会话盐" hint="一般不要动。改了它会导致 DSH 认不出旧会话。">
            <Input
              value={getStr(cfg, 'session.salt')}
              onChange={(e) => patch('session.salt', e.target.value)}
              className="max-w-xs font-mono text-sm"
              placeholder="留空"
            />
          </FieldRow>
          {/* session.instance：排障用字段，按文档建议不直接暴露，收进折叠区 */}
          <div className="py-3">
            <details className="rounded-md border">
              <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground select-none">
                会话标识（排障专用，一般不要动）
              </summary>
              <div className="space-y-2 border-t px-3 py-3">
                <Input
                  value={getStr(cfg, 'session.instance')}
                  onChange={(e) => patch('session.instance', e.target.value)}
                  className="max-w-xs font-mono text-sm"
                  placeholder="留空（推荐）"
                />
                <InlineNote level="info">
                  <strong>一般保持留空。</strong>DSH 的会话持久化到磁盘，且不允许重启后复用同一个会话标识。
                  留空时程序会每次启动自动换一套新标识——这是必须的，否则当天第二次重启就会报
                  <code className="mx-1 rounded bg-muted px-1">session already exists</code>，机器人完全不工作。
                </InlineNote>
                {getStr(cfg, 'session.instance').trim() !== '' && (
                  <InlineNote level="danger">
                    填了固定值 = 每次重启都复用同一套标识，<strong>那只会在重启后报错</strong>。
                    除非你明确知道在排什么障，否则请清空。
                  </InlineNote>
                )}
              </div>
            </details>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">日志</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          <FieldRow label="日志文件">
            <Input
              value={getStr(cfg, 'ui.logFile', 'logs/bridge.log')}
              onChange={(e) => patch('ui.logFile', e.target.value)}
              className="max-w-md font-mono text-sm"
            />
          </FieldRow>
          <FieldRow label="详细日志" hint="排查问题时再开，平时开着会让日志很大。">
            <Switch
              checked={getBool(cfg, 'ui.verbose', false)}
              onCheckedChange={(v) => patch('ui.verbose', v)}
            />
          </FieldRow>
        </CardContent>
      </Card>
    </div>
  )
}
