import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { FieldRow, InlineNote, NumInput, type ConfirmRequest } from '@/components/common'
import {
  SPEED_PRESETS,
  detectSpeedPreset,
  estimateDelayMs,
  getBool,
  getNum,
  getStr,
  getStrArr,
} from '@/lib/config'
import { cn } from '@/lib/utils'
import { ShieldAlert, Timer, MoonStar, SendHorizonal, Hourglass, MessageCircle, Coins } from 'lucide-react'

/**
 * 话术编辑器：一行一句，失焦时提交（过滤空行）。
 * 内部持草稿，避免边打字边过滤导致光标跳动。
 */
function PhrasesEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
}) {
  const [draft, setDraft] = useState(value.join('\n'))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setDraft(value.join('\n'))
  }, [value, focused])
  return (
    <Textarea
      value={draft}
      rows={3}
      className="text-sm"
      placeholder={placeholder}
      onFocus={() => setFocused(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setFocused(false)
        onChange(
          draft
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        )
      }}
    />
  )
}

export function PaceTab({
  cfg,
  patch,
  patchMany,
  askConfirm,
}: {
  cfg: Record<string, unknown>
  patch: (path: string, value: unknown) => void
  patchMany: (entries: [string, unknown][]) => void
  askConfirm: (req: ConfirmRequest) => void
}) {
  const enabled = getBool(cfg, 'humanize.enabled', true)
  const activePreset = detectSpeedPreset(cfg)
  const estimateSec = estimateDelayMs(cfg, 200) / 1000

  const toggleHumanize = (next: boolean) => {
    if (!next) {
      // ★ 关掉人味层 = 秒回，必须醒目确认（文案照抄 CONFIG-UI.md 2.4）
      askConfirm({
        title: '关掉人味层？',
        description: (
          <>
            关掉之后机器人会<strong className="text-red-600">秒回</strong>。秒回 + 7×24
            在线是行为风控最典型的特征，上一个 QQ 号被处置的最可能原因就是这个。确定要关吗？
          </>
        ),
        confirmText: '我了解风险，关闭',
        onConfirm: () => patch('humanize.enabled', false),
      })
    } else {
      patch('humanize.enabled', true)
    }
  }

  const choosePreset = (value: 'fast' | 'balanced' | 'careful') => {
    const preset = SPEED_PRESETS.find((p) => p.value === value)!
    const apply = () =>
      patchMany([
        ['humanize.speed', value],
        ['humanize.reactMinMs', preset.params.reactMinMs],
        ['humanize.reactMaxMs', preset.params.reactMaxMs],
        ['humanize.typingMaxMs', preset.params.typingMaxMs],
        ['humanize.maxDelayMs', preset.params.maxDelayMs],
      ])
    if (value === 'fast') {
      // ★ 快速档 ≈ 秒回，二次确认（文案照抄 CONFIG-UI.md 2.4）
      askConfirm({
        title: '选「快速」档？',
        description: (
          <>
            「快速」档约 1 秒就回复，<strong className="text-red-600">这几乎等于秒回</strong>。
            上一个 QQ 号被处置的最可能原因就是这个特征。确定要选吗？
          </>
        ),
        confirmText: '我了解风险，选快速',
        onConfirm: apply,
      })
    } else {
      apply()
    }
  }

  const quietEnabled = getBool(cfg, 'humanize.quietHours.enabled', true)

  return (
    <div className="space-y-4">
      <InlineNote level="warn">
        <strong>本页是账号存活配置，不是体验优化。</strong>
        秒回 + 7×24 在线是行为风控最典型的特征。这里的默认值都是刻意偏保守的。
      </InlineNote>

      {/* 人味层总开关 */}
      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div>
            <div className="flex items-center gap-2 font-medium">
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              ★ 人味层总开关
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              关掉 = 秒回。下面所有延迟参数都不再生效。
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={toggleHumanize} />
        </CardContent>
      </Card>

      {/* 回应速度三档 */}
      <Card className={cn(!enabled && 'opacity-50')}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Timer className="h-4 w-4" />
            ★ 回应速度档位
            {activePreset === 'custom' && (
              <Badge variant="outline" className="border-amber-400 text-amber-600">
                自定义
              </Badge>
            )}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            选一个档位即可，不必理解下面的毫秒参数。手工改过参数后会变成「自定义」。
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {SPEED_PRESETS.map((p) => {
              const active = activePreset === p.value
              return (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => choosePreset(p.value)}
                  className={cn(
                    'rounded-lg border-2 p-4 text-left transition-all',
                    active
                      ? 'border-primary bg-accent/60 shadow-sm'
                      : 'border-border hover:border-primary/40',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{p.label}</span>
                    <span
                      className={cn(
                        'inline-block h-2.5 w-2.5 rounded-full',
                        p.riskLevel === 'high' && 'bg-red-500',
                        p.riskLevel === 'mid' && 'bg-amber-400',
                        p.riskLevel === 'low' && 'bg-emerald-500',
                      )}
                    />
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">{p.wait}</div>
                  <div
                    className={cn(
                      'mt-2 text-xs leading-relaxed',
                      p.riskLevel === 'high' && 'font-medium text-red-600',
                      p.riskLevel === 'mid' && 'text-amber-700',
                      p.riskLevel === 'low' && 'text-emerald-700',
                    )}
                  >
                    {p.risk}
                  </div>
                </button>
              )
            })}
          </div>

          <InlineNote level={estimateSec > 60 ? 'warn' : 'info'}>
            按当前设置，一条 200 字的回复约等 <strong>{estimateSec.toFixed(1)} 秒</strong>
            {estimateSec > 60 && '。等待超过 60 秒，对方可能以为机器人没反应'}
            。
          </InlineNote>

          {/* 具体参数（小字区） */}
          <details className="rounded-md border">
            <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground select-none">
              档位背后的具体参数（高级微调）
            </summary>
            <div className="grid gap-3 border-t px-3 py-3 sm:grid-cols-2">
              <FieldRow label="反应时间下限" className="py-0 sm:grid-cols-[110px_1fr]">
                <NumInput
                  value={getNum(cfg, 'humanize.reactMinMs', 3500)}
                  onChange={(n) => patch('humanize.reactMinMs', n)}
                  unit="毫秒"
                  min={0}
                />
              </FieldRow>
              <FieldRow label="反应时间上限" className="py-0 sm:grid-cols-[110px_1fr]">
                <NumInput
                  value={getNum(cfg, 'humanize.reactMaxMs', 6500)}
                  onChange={(n) => patch('humanize.reactMaxMs', n)}
                  unit="毫秒"
                  min={getNum(cfg, 'humanize.reactMinMs', 0)}
                />
              </FieldRow>
              <FieldRow label="打字时间上限" className="py-0 sm:grid-cols-[110px_1fr]">
                <NumInput
                  value={getNum(cfg, 'humanize.typingMaxMs', 3000)}
                  onChange={(n) => patch('humanize.typingMaxMs', n)}
                  unit="毫秒"
                  min={0}
                />
              </FieldRow>
              <FieldRow label="总延迟上限" className="py-0 sm:grid-cols-[110px_1fr]">
                <NumInput
                  value={getNum(cfg, 'humanize.maxDelayMs', 9000)}
                  onChange={(n) => patch('humanize.maxDelayMs', n)}
                  unit="毫秒"
                  min={0}
                />
              </FieldRow>
            </div>
          </details>

          <div className="grid gap-3 sm:grid-cols-2">
            <FieldRow
              label="打字速度"
              hint="只影响短回复的延迟曲线"
              className="py-0 sm:grid-cols-[110px_1fr]"
            >
              <div className="flex items-center gap-3">
                <Slider
                  value={[getNum(cfg, 'humanize.charsPerSecond', 5)]}
                  onValueChange={([v]) => patch('humanize.charsPerSecond', v)}
                  min={2}
                  max={15}
                  step={1}
                  className="w-40"
                />
                <span className="w-16 text-sm tabular-nums">
                  {getNum(cfg, 'humanize.charsPerSecond', 5)} 字/秒
                </span>
              </div>
            </FieldRow>
            <FieldRow
              label="分条发送阈值"
              hint="超过该长度就分条发送"
              className="py-0 sm:grid-cols-[110px_1fr]"
            >
              <NumInput
                value={getNum(cfg, 'humanize.chunkChars', 300)}
                onChange={(n) => patch('humanize.chunkChars', n)}
                unit="字"
                min={50}
              />
            </FieldRow>
          </div>
        </CardContent>
      </Card>

      {/* 静默时段 */}
      <Card className={cn(!enabled && 'opacity-50')}>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-base">
            <span className="flex items-center gap-2">
              <MoonStar className="h-4 w-4" />
              ★ 静默时段
            </span>
            <Switch
              checked={quietEnabled}
              onCheckedChange={(v) => patch('humanize.quietHours.enabled', v)}
            />
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            真人夜里会睡。静默时段内<strong>不拒答，只大幅延迟</strong>——这样你不会以为机器人坏了。支持跨午夜（如
            23:00–07:00）。
          </p>
        </CardHeader>
        <CardContent className={cn('grid gap-3 sm:grid-cols-2', !quietEnabled && 'opacity-50')}>
          <FieldRow label="开始时间" className="py-0 sm:grid-cols-[110px_1fr]">
            <Input
              type="time"
              value={getStr(cfg, 'humanize.quietHours.start', '02:00')}
              onChange={(e) => patch('humanize.quietHours.start', e.target.value)}
              className="w-32"
            />
          </FieldRow>
          <FieldRow label="结束时间" className="py-0 sm:grid-cols-[110px_1fr]">
            <Input
              type="time"
              value={getStr(cfg, 'humanize.quietHours.end', '07:00')}
              onChange={(e) => patch('humanize.quietHours.end', e.target.value)}
              className="w-32"
            />
          </FieldRow>
          <FieldRow label="静默延迟下限" className="py-0 sm:grid-cols-[110px_1fr]">
            <NumInput
              value={getNum(cfg, 'humanize.quietDelayMinMs', 45000)}
              onChange={(n) => patch('humanize.quietDelayMinMs', n)}
              unit="毫秒"
              min={0}
            />
          </FieldRow>
          <FieldRow label="静默延迟上限" className="py-0 sm:grid-cols-[110px_1fr]">
            <NumInput
              value={getNum(cfg, 'humanize.quietDelayMaxMs', 150000)}
              onChange={(n) => patch('humanize.quietDelayMaxMs', n)}
              unit="毫秒"
              min={getNum(cfg, 'humanize.quietDelayMinMs', 0)}
            />
          </FieldRow>
        </CardContent>
      </Card>

      {/* ★ 长任务"先应一声"（CONFIG-UI.md 2.4 humanize.interim） */}
      <Card className={cn(!enabled && 'opacity-50')}>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-base">
            <span className="flex items-center gap-2">
              <MessageCircle className="h-4 w-4" />
              ★ 长任务「先应一声」
            </span>
            <Switch
              checked={getBool(cfg, 'humanize.interim.enabled', true)}
              onCheckedChange={(v) => patch('humanize.interim.enabled', v)}
            />
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            实测有一轮花了 40 秒、20 次工具调用，期间一声不响——使用者会以为机器人坏了。
            开启后，回合超过设定时间还没结束，就先发一条短消息；结束时照常发最终回复。
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <FieldRow label="超过多久先应一声" className="py-0 sm:grid-cols-[160px_1fr]">
            <NumInput
              value={getNum(cfg, 'humanize.interim.afterMs', 8000)}
              onChange={(n) => patch('humanize.interim.afterMs', n)}
              unit="毫秒"
              min={1000}
            />
          </FieldRow>

          {/* 键名迁移提示：web/working 是旧名（仍能生效，但曾静默不生效过一次），界面按新名展示 */}
          {(getStrArr(cfg, 'humanize.interim.messages.web', []).length > 0 ||
            getStrArr(cfg, 'humanize.interim.messages.working', []).length > 0) && (
            <InlineNote level="warn">
              检测到过时的键名 <code className="rounded bg-white/50 px-1">web</code> /{' '}
              <code className="rounded bg-white/50 px-1">working</code>
              ——现在叫 <code className="rounded bg-white/50 px-1">searching</code> /{' '}
              <code className="rounded bg-white/50 px-1">tooling</code>。
              旧名仍能生效，但建议迁移（旧名曾被静默忽略过一次，配了话术却一句没生效）。
              <button
                type="button"
                className="ml-1 underline"
                onClick={() =>
                  patchMany([
                    ['humanize.interim.messages.searching',
                      getStrArr(cfg, 'humanize.interim.messages.searching', []).length
                        ? getStrArr(cfg, 'humanize.interim.messages.searching', [])
                        : getStrArr(cfg, 'humanize.interim.messages.web', [])],
                    ['humanize.interim.messages.tooling',
                      getStrArr(cfg, 'humanize.interim.messages.tooling', []).length
                        ? getStrArr(cfg, 'humanize.interim.messages.tooling', [])
                        : getStrArr(cfg, 'humanize.interim.messages.working', [])],
                    ['humanize.interim.messages.web', undefined],
                    ['humanize.interim.messages.working', undefined],
                  ])
                }
              >
                一键迁移为新名
              </button>
            </InlineNote>
          )}

          <InlineNote level="warn">
            <strong>只有「联网搜索时」那组才可以说「在搜」</strong>——其他场景说「搜」是在骗使用者。
            「权限受阻时」说「做不了」一类，<strong>不要</strong>贴系统报错原文。
            话术是<strong>随机播报</strong>的（带冷却，同一句短时间内不会重复），
            同一类多写几条会更不像模板，<strong>建议每类至少 5 条</strong>，一行一句。
          </InlineNote>

          <div className="grid gap-3 lg:grid-cols-2">
            <FieldRow
              label="联网搜索时"
              hint="真的调了 web_search / web_fetch 之类——只有这时说「搜」才是真话"
              className="py-0 sm:grid-cols-1"
            >
              <PhrasesEditor
                value={getStrArr(cfg, 'humanize.interim.messages.searching', getStrArr(cfg, 'humanize.interim.messages.web', []))}
                onChange={(v) => patch('humanize.interim.messages.searching', v)}
                placeholder={'等下，我搜一下\n我查查'}
              />
            </FieldRow>
            <FieldRow
              label="调用其他工具时"
              hint="读文件、跑命令、QQ 工具等——这时说「搜索」是在骗使用者"
              className="py-0 sm:grid-cols-1"
            >
              <PhrasesEditor
                value={getStrArr(cfg, 'humanize.interim.messages.tooling', getStrArr(cfg, 'humanize.interim.messages.working', []))}
                onChange={(v) => patch('humanize.interim.messages.tooling', v)}
                placeholder={'等下，我弄一下\n稍等，我在跑'}
              />
            </FieldRow>
            <FieldRow
              label="纯思考时"
              hint="回合超时还没结束且什么工具都没调——既没搜也没跑"
              className="py-0 sm:grid-cols-1"
            >
              <PhrasesEditor
                value={getStrArr(cfg, 'humanize.interim.messages.thinking', [])}
                onChange={(v) => patch('humanize.interim.messages.thinking', v)}
                placeholder={'等下，我想想\n稍等'}
              />
            </FieldRow>
            <FieldRow
              label="权限受阻时"
              hint="有审批被拒/越界——说「做不了」一类，别贴系统报错"
              className="py-0 sm:grid-cols-1"
            >
              <PhrasesEditor
                value={getStrArr(cfg, 'humanize.interim.messages.blocked', [])}
                onChange={(v) => patch('humanize.interim.messages.blocked', v)}
                placeholder={'这个我暂时做不了\n权限不够，换个做法试试？'}
              />
            </FieldRow>
          </div>
        </CardContent>
      </Card>

      {/* 发送节流 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <SendHorizonal className="h-4 w-4" />
            发送节流
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <FieldRow label="连发最小间隔" className="py-0 sm:grid-cols-[120px_1fr]">
            <NumInput
              value={getNum(cfg, 'send.minGapMs', 1000)}
              onChange={(n) => patch('send.minGapMs', n)}
              unit="毫秒"
              min={0}
            />
          </FieldRow>
          <FieldRow label="连发最大间隔" className="py-0 sm:grid-cols-[120px_1fr]">
            <NumInput
              value={getNum(cfg, 'send.maxGapMs', 3000)}
              onChange={(n) => patch('send.maxGapMs', n)}
              unit="毫秒"
              min={getNum(cfg, 'send.minGapMs', 0)}
            />
          </FieldRow>
          <FieldRow label="每分钟发送上限" className="py-0 sm:grid-cols-[120px_1fr]">
            <NumInput
              value={getNum(cfg, 'send.maxPerMinute', 8)}
              onChange={(n) => patch('send.maxPerMinute', n)}
              unit="条"
              min={1}
            />
          </FieldRow>
          <FieldRow label="每小时发送上限" className="py-0 sm:grid-cols-[120px_1fr]">
            <NumInput
              value={getNum(cfg, 'send.maxPerHour', 500)}
              onChange={(n) => patch('send.maxPerHour', n)}
              unit="条"
              min={1}
            />
          </FieldRow>
          <FieldRow label="相同内容去重窗口" className="py-0 sm:grid-cols-[120px_1fr]">
            <NumInput
              value={getNum(cfg, 'send.dedupeWindowMs', 8000)}
              onChange={(n) => patch('send.dedupeWindowMs', n)}
              unit="毫秒"
              min={0}
            />
          </FieldRow>
          <FieldRow label="单条消息字符上限" className="py-0 sm:grid-cols-[120px_1fr]">
            <NumInput
              value={getNum(cfg, 'send.maxCharsPerMessage', 1500)}
              onChange={(n) => patch('send.maxCharsPerMessage', n)}
              unit="字"
              min={100}
            />
          </FieldRow>
        </CardContent>
      </Card>

      {/* 成本估算的价目表（CONFIG-UI.md §2.1.1） */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Coins className="h-4 w-4" />
            成本估算（价目表）
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            DSH 不提供价格，成本是按价目表<strong>估算</strong>的。价目表是独立文件，
            改它<strong>不需要重启</strong>；没维护好价格前建议保持关闭，界面会显示「—」而不是 ¥0.00。
          </p>
        </CardHeader>
        <CardContent className="divide-y">
          <FieldRow label="启用成本估算" hint="关掉则概览页只显示 token 量，不算钱。">
            <Switch
              checked={getBool(cfg, 'usage.costEnabled', false)}
              onCheckedChange={(v) => patch('usage.costEnabled', v)}
            />
          </FieldRow>
          <FieldRow
            label="价目表文件"
            hint="相对本包根目录。单价单位：元 / 百万 tokens，峰谷时段规则也在这个文件里。"
          >
            <Input
              value={getStr(cfg, 'usage.pricesFile', 'prices.json')}
              onChange={(e) => patch('usage.pricesFile', e.target.value)}
              className="max-w-md font-mono text-sm"
              placeholder="prices.json"
            />
          </FieldRow>
        </CardContent>
      </Card>

      {/* 单轮超时 */}
      <Card>
        <CardContent className="pt-2">
          <FieldRow
            label={
              <span className="flex items-center gap-1.5">
                <Hourglass className="h-4 w-4" />
                单轮处理超时
              </span>
            }
            hint="复杂任务（读文件、跑命令）可能要几分钟。"
          >
            <NumInput
              value={getNum(cfg, 'turn.timeoutMs', 600000)}
              onChange={(n) => patch('turn.timeoutMs', n)}
              unit="毫秒"
              min={10000}
            />
          </FieldRow>
        </CardContent>
      </Card>
    </div>
  )
}
