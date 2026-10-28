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
import {
  ShieldAlert,
  Timer,
  MoonStar,
  SendHorizonal,
  Hourglass,
  MessageCircle,
  Coins,
} from 'lucide-react'

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
            在线是行为风控最典型的特征。确定要关吗？
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
            「快速」档约 1 秒就回复，<strong className="text-red-600">这几乎等于秒回</strong>
            。确定要选吗？
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
  // ── 0.3.0alpha：这里原来还算一个 `hasChatModeKey` ─────────────────────
  //   它是「对话风格判定」那把专用 key 的标记。双态判定整条下线之后，
  //   `chat.mode.ambiguous.apiKey` 不再被任何代码读取，那张卡片也删掉了 ——
  //   留着一个算不出来的标记只会让某处引用到一个已下线的东西。
  //   （`wake.judge` 那把 key 与本页无关，它的界面在「扩展」页里，那里仍在用
  //    `hasJudgeKey` —— 所以这里连 `hasJudgeKey` 也不必再算了。）

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
            <br />
            <strong>档位是「等待下限」</strong>：回合本身跑得比它久就直接发，不会再多等一段。
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
            按当前设置，一条 200 字的回复至少等 <strong>{estimateSec.toFixed(1)} 秒</strong>
            {estimateSec > 60 && '。等待超过 60 秒，对方可能以为机器人没反应'}。
            <br />
            <strong>这是「等待下限」不是「额外叠加」</strong>：这一轮本身跑得比它久
            （联网、调工具），就直接发，不会再压一段时间；跑得快才补到这个下限。
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
            <br />
            <strong>静默时段内不发这条</strong>：夜里冒出一句「我在想」正是静默时段要避免的
            「我在线」信号。此时只发最终回复（按静默延迟延后）。
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

          {/* ★★★ 0.3.3：这句话**由谁写**（CONFIG-UI.md 2.4 的 `humanize.interim.mode`）。
              ★ 两选一而不是一个开关：它是同一个问题的两个答案 —— 与 `wake.policy`、
                `memory.affect.prewake` 同一条理由（两个独立开关会出现"两个都开、互相打架"）。 */}
          <FieldRow
            label="这句话由谁写"
            hint="「本地话术池」零成本零延迟、行为最可预测；「AI 按上下文自己写」能接上刚才的话题，但每个长回合多一次模型调用。"
          >
            <div className="flex flex-wrap gap-2">
              {[
                {
                  v: 'pool',
                  label: '本地话术池（默认）',
                  desc: '按四类挑一句，不花钱。',
                },
                {
                  v: 'ai',
                  label: 'AI 按上下文自己写',
                  desc: '能接话，也可能自己决定不说。',
                },
              ].map((o) => {
                const active = getStr(cfg, 'humanize.interim.mode', 'pool') === o.v
                return (
                  <button
                    key={o.v}
                    type="button"
                    onClick={() => patch('humanize.interim.mode', o.v)}
                    className={cn(
                      'rounded-md border px-3 py-1.5 text-left text-xs transition-colors',
                      active ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/50',
                    )}
                  >
                    <span className="font-medium">{o.label}</span>
                    <span className="ml-1 text-muted-foreground">{o.desc}</span>
                  </button>
                )
              })}
            </div>
          </FieldRow>

          {/* ★ 选 `ai` 时**就地写明代价与兜底**（照 CONFIG-UI.md 2.4 那段）：
              不写清楚就会出现"配了却看起来没效果"这种最难查的反馈。 */}
          {getStr(cfg, 'humanize.interim.mode', 'pool') === 'ai' && (
            <InlineNote level="warn">
              它会<strong>每个长回合多花一次模型调用</strong>（要花钱），并在回合一开始就
              <strong>并行</strong>生成 —— 到「超过多久先应一声」那一刻还没生成好，就
              <strong>自动退回上面那四组话术</strong>（所以那些话术<strong>仍然有用，别删</strong>）。
              <br />
              它只看<strong>当前这句 + 最近几条</strong>，<strong>不看</strong>这一轮在做什么 ——
              所以提示词里明令它<strong>不许说「我在搜」这类具体动作</strong>（并行时我们还不知道）。
              它也可以<strong>决定这一轮不说话</strong>（对方在认真求助或情绪低落时，静默更好）。
              <br />
              通路<strong>复用「唤醒语义判定」那把 API Key</strong>：没配的话会走一次性进程（3~5 秒），
              8 秒的等待下它<strong>常常来不及</strong>，于是多数回合会退回话术池。
            </InlineNote>
          )}
          {getStr(cfg, 'humanize.interim.mode', 'pool') === 'ai' && (
            <div className="grid gap-3 lg:grid-cols-2">
              <FieldRow
                label="生成超时"
                hint="0 = 自动。必须赶在「发出那一刻」之前回来，配得比等待还大只会让这次白花钱。"
                className="py-0 sm:grid-cols-1"
              >
                <NumInput
                  value={getNum(cfg, 'humanize.interim.ai.timeoutMs', 0)}
                  onChange={(n) => patch('humanize.interim.ai.timeoutMs', Math.max(0, n))}
                  unit="毫秒"
                  min={0}
                />
                {/* ★★ 把"自动"到底是多少**显示出来**。
                    理由是一条真缺陷：归一化曾把 `0` 夹成 200ms（`Number(0)` 是有限数），
                    于是每次生成都在 200 毫秒被掐断、垫场白永远退回话术池 ——
                    而使用者从界面上完全看不出"它现在到底用多少毫秒"。
                    公式必须与 `bridge.mjs` 的 `#ensureInterimAi` 保持一致：
                      clamp(afterMs × 0.6, 1500, 2500) */}
                {(() => {
                  const afterMs = getNum(cfg, 'humanize.interim.afterMs', 8000)
                  const configured = getNum(cfg, 'humanize.interim.ai.timeoutMs', 0)
                  const auto = Math.max(1500, Math.min(2500, Math.floor(afterMs * 0.6)))
                  const effective = configured > 0 ? configured : auto
                  const tooTight = effective >= afterMs
                  const tooShort = configured > 0 && effective < 1200
                  return (
                    <div className="mt-1 text-xs text-muted-foreground">
                      实际会用 <strong>{effective} 毫秒</strong>
                      {configured > 0 ? '（你填的值）' : `（自动 = 等待 ${afterMs}ms 的 60%，夹在 1500~2500 之间）`}
                      {tooTight && (
                        <span className="ml-1 text-amber-700">
                          ⚠️ 不小于等待时间（{afterMs}ms）——生成**永远赶不上**，会每次都用话术池、还白付一次调用。
                        </span>
                      )}
                      {!tooTight && tooShort && (
                        <span className="ml-1 text-amber-700">
                          ⚠️ 太短：一次直连调用通常就要 1 秒左右，这里会几乎每次都超时（表现成"配了 AI 但没效果"）。
                        </span>
                      )}
                    </div>
                  )
                })()}
              </FieldRow>
              <FieldRow
                label="每小时最多几次"
                hint="与「唤醒语义判定」各算各的额度，不挤占它。超了就直接用话术池。"
                className="py-0 sm:grid-cols-1"
              >
                <NumInput
                  value={getNum(cfg, 'humanize.interim.ai.maxPerHour', 120)}
                  onChange={(n) => patch('humanize.interim.ai.maxPerHour', Math.max(0, n))}
                  min={0}
                />
              </FieldRow>
              <FieldRow
                label="带上说话方式"
                hint="把人设里「说话方式」那一小段（最多 600 字）交给它。不带的话垫场白语气会跟正文变成两套。"
                className="py-0 sm:grid-cols-1"
              >
                <Switch
                  checked={getBool(cfg, 'humanize.interim.ai.usePersona', true)}
                  onCheckedChange={(v) => patch('humanize.interim.ai.usePersona', v)}
                />
              </FieldRow>
            </div>
          )}

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
