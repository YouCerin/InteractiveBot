import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, RefreshCw, XCircle } from 'lucide-react'

import { api, isNotImplemented, type Preflight } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * 启动前置条件门控（H13，规格见 CONFIG-UI.md §5.x）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么这一块必须有（它回答的是使用者最常问的那个问题）
 * ══════════════════════════════════════════════════════════════════════════
 * 真机上"机器人不说话"最常见的三个原因 —— 协议端没登录、用错了那份凭据、
 * 模型凭据没取到 —— 以前在界面上**一个字都没有**，只能去翻日志。
 *
 * ★★ 判据全部来自后端（`GET /api/preflight`），这个组件**不做任何自己的判断**：
 *    两处判断必然漂移，而漂移的表现是"界面说正常、实际不说话"（那是最费时间的一类分歧）。
 * ★ 每条门控都带 `action`（下一步该做什么）—— **这才是这条接口存在的理由**：
 *    "协议端不可达"谁都看得懂，**该怎么修**才是使用者要的。
 * ⚠️ 后端会真的去问一次协议端，所以会慢 1~2 秒，这里必须有 loading 态。
 */
export function PreflightBanner({ demo = false }: { demo?: boolean }) {
  const [data, setData] = useState<Preflight | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)

  const load = useCallback(async () => {
    if (demo) return
    setLoading(true)
    setErr(null)
    try {
      setData(await api.preflight())
      setUnsupported(false)
    } catch (e) {
      if (isNotImplemented(e)) {
        // 后端还没上这个接口 → 整块**不显示**（而不是显示一个红叉吓人）
        setUnsupported(true)
      } else {
        setErr(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setLoading(false)
    }
  }, [demo])

  useEffect(() => {
    void load()
  }, [load])

  if (demo || unsupported) return null

  const blockers = data?.gates.filter((g) => !g.ok && g.level === 'blocker') ?? []
  const warns = data?.gates.filter((g) => !g.ok && g.level === 'warn') ?? []

  return (
    <Card className={cn(blockers.length > 0 && 'border-red-300')}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            {blockers.length > 0 ? (
              <>
                <XCircle className="h-5 w-5 text-red-600" />
                现在这个样子，它**不会**回话（{blockers.length} 个必须修的问题）
              </>
            ) : warns.length > 0 ? (
              <>
                <AlertTriangle className="h-5 w-5 text-amber-600" />
                能跑，但有 {warns.length} 处建议看一眼
              </>
            ) : (
              <>
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                启动条件都满足
              </>
            )}
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('mr-1 h-3.5 w-3.5', loading && 'animate-spin')} />
            {loading ? '检查中…' : '重新检查'}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {err && (
          <div className="text-sm text-red-700">
            拿不到检查结果：{err}
            <div className="text-xs text-muted-foreground">
              （接口不在线通常意味着机器人没在跑；这一块本身不会影响它工作。）
            </div>
          </div>
        )}
        {loading && !data && <div className="text-sm text-muted-foreground">正在真的问一次协议端…</div>}
        {data?.gates
          .filter((g) => !g.ok)
          .map((g) => (
            <div
              key={g.id}
              className={cn(
                'flex items-start gap-2 rounded-md border p-2 text-sm',
                g.level === 'blocker' ? 'border-red-200 bg-red-50/60' : 'border-amber-200 bg-amber-50/60',
              )}
            >
              {g.level === 'blocker' ? (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              )}
              <div className="min-w-0">
                <div className="font-medium">{g.title}</div>
                {g.hint && <div className="text-xs text-muted-foreground">{g.hint}</div>}
                {/* ★ 下一步：可复制去跑 */}
                {g.action && (
                  <code className="mt-1 inline-block rounded bg-white/70 px-1 text-xs">{g.action}</code>
                )}
              </div>
            </div>
          ))}
        {data && data.gates.every((g) => g.ok) && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Info className="h-3.5 w-3.5" />
            配置、协议端、登录、DSH、模型凭据都正常。
          </div>
        )}
      </CardContent>
    </Card>
  )
}
