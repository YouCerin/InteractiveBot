import { Switch } from '@/components/ui/switch'
import { FieldRow, InlineNote, TagInput, type ConfirmRequest } from '@/components/common'
import { getBool, getStrArr, keywordWarnings } from '@/lib/config'
import { cn } from '@/lib/utils'

/**
 * 「唤醒方式」——**什么时候回我**（0.2.3 从「人设」页搬到这里）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么搬家
 * ══════════════════════════════════════════════════════════════════════════
 * 这一段本来就该在「唤醒策略」下面：`wake.policy = rule` 时，**这一节就是那条策略的
 * 全部内容**；`semantic` 也只是在它之上加一层否决。放在「人设」页时，
 * "它用什么判据决定回不回"这个问题的答案被劈成了两处（策略在扩展页、规则在人设页），
 * 而 `唤醒规则` 那张插件卡又只显示其中一个开关 —— 三处各说一半。
 *
 * ★ 三个**必须保留**的东西（都是踩出来的，别简化掉）：
 *   ① 群聊总开关的**风控文案**与二次确认（群聊回复是账号风控敏感行为）；
 *   ② 关掉总开关时，另外三个开关**一起变灰** —— 否则会让人以为"@ 开关还开着，
 *      @ 它应该会回"；
 *   ③ 关键词的**高频词告警**与**成本提示**（关键词是包含匹配，写个单字几乎等于全响应，
 *      而且每个命中都会产生一次模型调用）。
 *
 * ★ 这个组件**不带自己的 `<Card>`**（它嵌在「唤醒策略」那张卡里），
 *   用一圈边框 + 标题跟判定器设置区分开。
 */
export function WakeRulesSection({
  cfg,
  patch,
  askConfirm,
}: {
  cfg: Record<string, unknown>
  patch: (path: string, value: unknown) => void
  askConfirm: (req: ConfirmRequest) => void
}) {
  const groupEnabled = getBool(cfg, 'trigger.groupEnabled', false)
  const keywords = getStrArr(cfg, 'trigger.keywords', [])
  const warnings = keywordWarnings(keywords)

  const toggleGroup = (next: boolean) => {
    if (next) {
      // ★ 群聊总开关：开启前必须二次确认（文案照抄 CONFIG-UI.md §2.3）
      askConfirm({
        title: '开启群聊回复？',
        description: (
          <>
            群聊回复涉及<strong className="text-red-600">账号风控风险</strong>
            。开启前请确认你了解这一点。
          </>
        ),
        confirmText: '我了解风险，开启',
        onConfirm: () => patch('trigger.groupEnabled', true),
      })
    } else {
      patch('trigger.groupEnabled', false)
    }
  }

  return (
    <div className="rounded-md border p-3">
      <div className="text-sm font-medium">唤醒方式</div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        群里只有「被 @」和「命中关键词」两种唤醒方式，没有自动搭话、随机插嘴 —— 这是刻意的。
        人设里的名字（正式名 + 别名）会自动并进唤醒词，不在这里重复列出。
      </p>

      <div className="mt-2 divide-y">
        <FieldRow
          star
          label="群聊总开关"
          hint="fail-closed：缺省关。总开关一关，即使 @ 了也不回。"
        >
          <div className="space-y-2">
            <Switch checked={groupEnabled} onCheckedChange={toggleGroup} />
            <InlineNote level="danger">
              群聊回复涉及<strong>账号风控风险</strong>，开启前请确认你了解这一点。
              开启后机器人<strong>只会在被 @ 或说到关键词时</strong>回答，
              不会自己冒出来说话。
            </InlineNote>
          </div>
        </FieldRow>
        {/* ★ 关掉总开关时，另外三个开关一起变灰 —— 否则会让人以为"@ 开关还开着，@ 它应该会回" */}
        <div className={cn(!groupEnabled && 'pointer-events-none opacity-50')}>
          <FieldRow label="私聊响应" hint="私聊消息是否响应（一对一找它说话，不看关键词）。">
            <Switch
              checked={getBool(cfg, 'trigger.private', true)}
              onCheckedChange={(v) => patch('trigger.private', v)}
            />
          </FieldRow>
          <FieldRow label="群里被 @ 响应" hint="需群聊总开关打开。">
            <Switch
              checked={getBool(cfg, 'trigger.mention', true)}
              onCheckedChange={(v) => patch('trigger.mention', v)}
            />
          </FieldRow>
          <FieldRow label="关键词响应" hint="群里命中关键词时是否响应（需群聊总开关打开）。">
            <Switch
              checked={getBool(cfg, 'trigger.keyword', true)}
              onCheckedChange={(v) => patch('trigger.keyword', v)}
            />
          </FieldRow>
        </div>
      </div>

      <FieldRow
        label="关键词列表"
        hint="包含匹配，且只在群聊里生效（私聊不受它影响）。不要填单字或群聊高频词（如「我」「哈哈」），那等于让机器人对每句话都响应。"
      >
        <TagInput
          values={keywords}
          onChange={(v) => patch('trigger.keywords', v)}
          placeholder="输入关键词，回车添加"
          warnWords={warnings.map((w) => w.word)}
        />
        {warnings.length > 0 && (
          <div className="mt-2 space-y-1">
            {warnings.map((w) => (
              <InlineNote key={w.word} level="warn">
                {w.reason}
              </InlineNote>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          成本提示：每个命中关键词的群消息都会产生一次模型调用。
        </p>
      </FieldRow>
    </div>
  )
}
