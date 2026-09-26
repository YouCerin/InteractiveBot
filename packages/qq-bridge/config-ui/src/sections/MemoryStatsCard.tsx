import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, RefreshCw } from 'lucide-react'

import { api, isNotImplemented, type MemoryStatsResult } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * 记忆写入统计 + 零写入告警（0.2.1，规格见 CONFIG-UI.md §2.5）。
 *
 * 为什么必须有：实测事故 —— 机器人聊了两天、几十轮，一条记忆都没写，
 * 而没有任何地方报警。这张卡就是"记忆系统在不在正常工作"的观测面。
 *
 * ★ 四列都要给，不能只给"接受"：proposed=0（它从没提议）与 ignored 高
 *   （提议全被拒）是两种不同的故障，合成一个数字会把排查方向带偏。
 * ★ 告警只在真的达到阈值时出现（阈值是后端常量，不是配置项 ——
 *   所以这里不做可编辑输入框，那会让人以为改了有用）；落过盘就收起。
 * ★ 只读：不做"改计数"（伪造观测），也不做重置按钮（只会让告警重新沉默）。
 */
export function MemoryStatsCard({ demo = false }: { demo?: boolean }) {
  const [res, setRes] = useState<MemoryStatsResult | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [unsupported, setUnsupported] = useState(false)

  if (demo || unsupported) return null

  const load = async () => {
    setLoading(true)
    setErr(null)
    try {
      setRes(await api.memoryStats())
      setUnsupported(false)
    } catch (e) {
      if (isNotImplemented(e)) setUnsupported(true)
      else setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fmtTime = (ms: number) => {
    if (!ms) return '—'
    const d = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  const alerts = res?.rows.filter((r) => r.alert) ?? []

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-4 w-4" />
          记忆写入统计
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 px-2"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {err && <div className="text-xs text-red-700">{err}</div>}
        {res && res.rows.length === 0 && (
          <div className="text-xs text-muted-foreground">
            还没有任何会话的统计。机器人跑过几轮之后，这里会显示每个会话「提议了几条、落盘了几条」。
          </div>
        )}
        {res && res.rows.length > 0 && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">会话</th>
                    <th className="py-1 pr-3 text-right font-medium">轮数</th>
                    <th className="py-1 pr-3 text-right font-medium">提议</th>
                    <th className="py-1 pr-3 text-right font-medium">接受</th>
                    <th className="py-1 pr-3 text-right font-medium">拒绝</th>
                    <th className="py-1 pr-3 text-right font-medium">去重</th>
                    <th className="py-1 text-right font-medium">最后落盘</th>
                  </tr>
                </thead>
                <tbody>
                  {res.rows.map((r) => (
                    <tr key={r.chatKey} className="border-b last:border-0">
                      <td className="py-1 pr-3 font-mono">{r.chatKey}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{r.turns}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{r.proposed}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{r.applied}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{r.ignored}</td>
                      <td className="py-1 pr-3 text-right tabular-nums">{r.deduped}</td>
                      <td className="py-1 text-right tabular-nums">{fmtTime(r.lastWriteAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* 告警带轮数与提议数（可核对，不是一句"没生效"）；
                只在真的达到阈值时出现 —— 轮数不够时不显示，否则等于天天喊狼来了 */}
            {alerts.map((r) => (
              <div
                key={`alert-${r.chatKey}`}
                className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  <strong>{r.chatKey}</strong>：{r.alertWhy.replace(/\*\*/g, '')}。
                  提议为 0 说明它从没想记；提议有、接受为 0 说明提议全被拒——两种情况的排查方向不同。
                </span>
              </div>
            ))}
            <p className="text-[10px] text-muted-foreground">
              只读统计（数据在 memory/.stats.json）。会话跑满 {res.threshold} 轮仍 0 落盘才会告警；
              已落盘的会话不告警。「提议」与「接受」分开看：都是 0 = 它从没想记；提议有、接受 0 = 提议全被拒。
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
