import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { FieldRow, InlineNote, TagInput, type ConfirmRequest } from '@/components/common'
import { getBool, getStrArr, keywordWarnings } from '@/lib/config'

export function TriggerTab({
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
      // ★ 群聊总开关：开启前必须二次确认（文案照抄 CONFIG-UI.md 2.3）
      askConfirm({
        title: '开启群聊回复？',
        description: (
          <>
            群聊回复涉及<strong className="text-red-600">账号风控风险</strong>。
            上一个 QQ 号就是因此被处置的。开启前请确认你了解这一点。
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
    <div className="space-y-4">
      <Card>
        <CardContent className="divide-y pt-2">
          <FieldRow label="私聊响应" hint="私聊消息是否响应。">
            <Switch
              checked={getBool(cfg, 'trigger.private', true)}
              onCheckedChange={(v) => patch('trigger.private', v)}
            />
          </FieldRow>
          <FieldRow label="群里被 @ 响应" hint="群聊中有人 @ 机器人时是否响应（需群聊总开关打开）。">
            <Switch
              checked={getBool(cfg, 'trigger.mention', true)}
              onCheckedChange={(v) => patch('trigger.mention', v)}
            />
          </FieldRow>
          <FieldRow label="关键词响应" hint="群聊消息命中关键词时是否响应（需群聊总开关打开）。">
            <Switch
              checked={getBool(cfg, 'trigger.keyword', true)}
              onCheckedChange={(v) => patch('trigger.keyword', v)}
            />
          </FieldRow>
          <FieldRow
            star
            label="群聊总开关"
            hint="第一版刻意默认关闭。打开后机器人才会在群里说话。"
          >
            <div className="space-y-2">
              <Switch checked={groupEnabled} onCheckedChange={toggleGroup} />
              <InlineNote level="danger">
                群聊回复涉及<strong>账号风控风险</strong>。上一个 QQ 号就是因此被处置的。
                开启前请确认你了解这一点。
              </InlineNote>
            </div>
          </FieldRow>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-2">
          <FieldRow
            label="关键词列表"
            hint="包含匹配。不要填单字或群聊高频词（如「我」「哈哈」），那等于让机器人对每句话都响应。"
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
          </FieldRow>
        </CardContent>
      </Card>
    </div>
  )
}
