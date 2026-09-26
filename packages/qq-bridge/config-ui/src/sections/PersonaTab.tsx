import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { FieldRow, InlineNote } from '@/components/common'
import { getStr, personaMentionsTools } from '@/lib/config'
import { cn } from '@/lib/utils'

const PRESETS = [
  { value: 'mermaid-lite', label: '精简版（推荐）', desc: '388 字，省 token' },
  { value: 'mermaid', label: '完整版', desc: '761 字，语气细节更足' },
  { value: 'none', label: '不使用人设', desc: '排查「是不是人设的锅」时用' },
]

export function PersonaTab({
  cfg,
  patch,
}: {
  cfg: Record<string, unknown>
  patch: (path: string, value: unknown) => void
}) {
  const preset = getStr(cfg, 'persona.preset', 'mermaid-lite')
  const custom = getStr(cfg, 'persona.custom')
  const customActive = custom.trim().length > 0

  return (
    <Card>
      <CardContent className="divide-y pt-2">
        <FieldRow
          label="内置人设"
          hint={customActive ? '⚠️ 下方自定义人设非空，当前优先生效的是自定义内容' : '三选一'}
        >
          <RadioGroup
            value={preset}
            onValueChange={(v) => patch('persona.preset', v)}
            className={cn('gap-2', customActive && 'opacity-50')}
          >
            {PRESETS.map((p) => (
              <label
                key={p.value}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors',
                  preset === p.value && 'border-primary bg-accent/50',
                )}
              >
                <RadioGroupItem value={p.value} className="mt-0.5" />
                <div>
                  <div className="text-sm font-medium">{p.label}</div>
                  <div className="text-xs text-muted-foreground">{p.desc}</div>
                </div>
                <Label className="hidden">{p.label}</Label>
              </label>
            ))}
          </RadioGroup>
        </FieldRow>

        <FieldRow
          label="自定义人设"
          hint="非空时优先于内置预设。留空则用上面选的预设。"
        >
          <Textarea
            value={custom}
            onChange={(e) => patch('persona.custom', e.target.value)}
            placeholder="想自己写人设就写在这里；留空则使用内置预设。"
            rows={6}
            className="font-mono text-sm"
          />
          <div className="mt-1.5 flex items-center justify-between text-xs">
            <span className="text-muted-foreground">自己写的人设越长，每轮成本越高</span>
            <span className={cn('tabular-nums', custom.length > 800 && 'font-medium text-amber-600')}>
              {custom.length} 字
            </span>
          </div>
          {personaMentionsTools(custom) && (
            <InlineNote level="warn" className="mt-2">
              提示词里疑似提到了工具名。提示词提到不存在的工具会让模型乱调工具。
            </InlineNote>
          )}
        </FieldRow>

        <FieldRow label="称呼" hint="只用于提示词里标注「是谁在说话」。">
          <Input
            value={getStr(cfg, 'persona.callerName')}
            onChange={(e) => patch('persona.callerName', e.target.value)}
            placeholder="例如：老板"
            className="max-w-xs"
          />
        </FieldRow>
      </CardContent>
    </Card>
  )
}
