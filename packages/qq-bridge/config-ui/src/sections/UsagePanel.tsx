import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { InlineNote } from '@/components/common'
import { api, isNotImplemented, type UsagePrices, type UsageResult } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CircleHelp, Coins, Hash, Loader2, PiggyBank, RefreshCw, ScanSearch } from 'lucide-react'

/**
 * 用量与成本卡片（CONFIG-UI.md §2.1.1）。
 * 口径钉子（做错了账会差几十倍）：
 *  - tokens.input 是【未缓存】输入（贵的那部分），缓存命中单独在 cacheRead（约 1/50 价）
 *  - reasoning 是 output 的一部分，可显示但绝不再计入总量
 *  - cacheHitRate = cacheRead / (input + cacheRead)，null 显示 —（不是 0%）
 *  - totalTokens 不求和；只有 lastContextTokens 快照
 *  - cost.available=false 时显示 — 而不是 ¥0.00（¥0.00 会被读成"免费"）
 *  - 成本只能叫「估算」，且必须有「计价依据」入口
 */

const RANGES = [
  { days: 1, label: '今日' },
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 0, label: '全部' },
] as const

function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('zh-CN')
}

function fmtRate(r: number | null | undefined): string {
  if (r === null || r === undefined) return '—'
  return `${(r * 100).toFixed(1)}%`
}

function fmtCost(amount: number | null | undefined, available: boolean): string {
  if (!available || amount === null || amount === undefined) return '—'
  return `¥${amount.toFixed(4)}`
}

/** 演示数据：桥接离线时让这块区域可以完整浏览。 */
const DEMO_USAGE: UsageResult = {
  range: { days: 7 },
  totals: {
    turns: 128,
    tokens: { input: 25049, cacheRead: 223744, output: 3625, reasoning: 1000 },
    cacheHitRate: 0.899,
    lastContextTokens: 34709,
  },
  cost: { available: true, amount: 0.044, currency: 'CNY', basis: 'prices.json@2026-09-25' },
  byDay: [
    { date: '2026-09-24', turns: 93, tokens: { input: 17937, cacheRead: 122572, output: 2382 }, cacheHitRate: 0.872, cost: 0.0312 },
    { date: '2026-09-25', turns: 35, tokens: { input: 7112, cacheRead: 101172, output: 1243 }, cacheHitRate: 0.934, cost: 0.0128 },
  ],
  bySession: [
    { chatKey: 'private:100000001', kind: 'private', label: '私聊 100000001', turns: 51, tokens: { input: 15461, cacheRead: 0, output: 1930 }, cacheHitRate: 0.0, cost: 0.0234 },
    { chatKey: 'group:700000002', kind: 'group', label: '群 700000002', turns: 72, tokens: { input: 9588, cacheRead: 223744, output: 1695 }, cacheHitRate: 0.959, cost: 0.0206 },
  ],
}

const DEMO_PRICES: UsagePrices = {
  source: 'prices.json',
  updatedAt: '2026-09-25',
  loaded: true,
  peak: {
    timezone: 'Asia/Shanghai',
    windows: [
      { start: '09:00', end: '12:00' },
      { start: '14:00', end: '18:00' },
    ],
    days: [1, 2, 3, 4, 5],
    holidays: [],
  },
  routes: {
    'deepseek-official/deepseek-flash': {
      cacheHitPerM: { offPeak: 0.02, peak: 0.04 },
      cacheMissPerM: { offPeak: 1, peak: 2 },
      outputPerM: { offPeak: 4, peak: 8 },
    },
  },
  warning: 'holidays 为空：法定节假日会被按高峰计价（偏高）。价格会变，请定期核对官方页面。',
}

/** 「计价依据」弹窗：整张价目表 + warning 原文，不让成本变成无法追溯的黑箱。 */
function PricesDialog({
  open,
  onClose,
  demo,
}: {
  open: boolean
  onClose: () => void
  demo: boolean
}) {
  const [prices, setPrices] = useState<UsagePrices | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    if (demo) {
      setPrices(DEMO_PRICES)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    api
      .usagePrices()
      .then(setPrices)
      .catch((e) => {
        setPrices(null)
        setError(
          isNotImplemented(e)
            ? '后端还没实现这个接口，暂时拿不到价目表。'
            : e instanceof Error
              ? e.message
              : String(e),
        )
      })
      .finally(() => setLoading(false))
  }, [open, demo])

  const routes = Object.entries(prices?.routes ?? {}) as [
    string,
    { cacheHitPerM?: { offPeak: number; peak: number }; cacheMissPerM?: { offPeak: number; peak: number }; outputPerM?: { offPeak: number; peak: number } },
  ][]

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanSearch className="h-5 w-5" />
            计价依据
          </DialogTitle>
          <DialogDescription>
            成本是按这张价目表估算的，不是官方账单。单价单位：元 / 百万 tokens。
          </DialogDescription>
        </DialogHeader>
        {loading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取价目表…
          </div>
        )}
        {error && <InlineNote level="warn">{error}</InlineNote>}
        {prices && (
          <div className="space-y-4 text-sm">
            <div className="text-xs text-muted-foreground">
              来源：<code className="rounded bg-muted px-1">{prices.source ?? '—'}</code>
              {prices.updatedAt && <span className="ml-2">更新日期：{prices.updatedAt}</span>}
            </div>
            {routes.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>路由</TableHead>
                    <TableHead>项目</TableHead>
                    <TableHead className="text-right">低谷</TableHead>
                    <TableHead className="text-right">高峰</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {routes.flatMap(([route, r]) =>
                    (
                      [
                        ['缓存命中', r.cacheHitPerM],
                        ['未缓存输入', r.cacheMissPerM],
                        ['输出', r.outputPerM],
                      ] as const
                    ).map(([label, price], i) => (
                      <TableRow key={`${route}-${label}`}>
                        {i === 0 && (
                          <TableCell rowSpan={3} className="align-top font-mono text-xs">
                            {route}
                          </TableCell>
                        )}
                        <TableCell>{label}</TableCell>
                        <TableCell className="text-right tabular-nums">{price?.offPeak ?? '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{price?.peak ?? '—'}</TableCell>
                      </TableRow>
                    )),
                  )}
                </TableBody>
              </Table>
            )}
            {prices.peak && (
              <div className="text-xs text-muted-foreground">
                高峰时段：{prices.peak.timezone ?? 'Asia/Shanghai'} 时间，星期
                {(prices.peak.days ?? []).join('、')} 的
                {(prices.peak.windows ?? []).map((w) => ` ${w.start}–${w.end}`).join('、')}
                ；窗口外与周末按低谷价。
              </div>
            )}
            {prices.warning && <InlineNote level="warn">{prices.warning}</InlineNote>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function UsagePanel({ demo }: { demo: boolean }) {
  const [days, setDays] = useState<number>(7)
  const [usage, setUsage] = useState<UsageResult | null>(null)
  const [pending, setPending] = useState(false) // 501：后端还没实现
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pricesOpen, setPricesOpen] = useState(false)

  const load = useCallback(async () => {
    if (demo) {
      setUsage(DEMO_USAGE)
      setPending(false)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setUsage(await api.usage(days))
      setPending(false)
      setError(null)
    } catch (e) {
      setUsage(null)
      if (isNotImplemented(e)) {
        setPending(true)
        setError(null)
      } else {
        setPending(false)
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setLoading(false)
    }
  }, [days, demo])

  useEffect(() => {
    load()
  }, [load])

  const rangeLabel = RANGES.find((r) => r.days === days)?.label ?? ''
  const t = usage?.totals
  const hitDenom = t ? t.tokens.input + t.tokens.cacheRead : 0

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Coins className="h-4 w-4" />
            用量与成本
            <Badge variant="outline" className="text-xs font-normal">
              估算
            </Badge>
          </CardTitle>
          <div className="ml-auto flex items-center gap-1">
            {RANGES.map((r) => (
              <Button
                key={r.days}
                size="sm"
                variant={days === r.days ? 'default' : 'ghost'}
                className="h-7 px-2.5 text-xs"
                onClick={() => setDays(r.days)}
              >
                {r.label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={load} disabled={loading}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {pending ? (
          <InlineNote level="info">
            用量统计的后端接口还没实现（CONFIG-UI.md §5.2，目前返回 501）。
            接口落地后这块区域会自动出现数据，界面不用再改。
          </InlineNote>
        ) : error ? (
          <InlineNote level="warn">{error}</InlineNote>
        ) : loading && !usage ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取用量…
          </div>
        ) : usage && t ? (
          <>
            {/* 顶部 5 张数字卡 */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <div className="rounded-lg border p-3">
                <div className="text-xl font-semibold tabular-nums">
                  {fmtCost(usage.cost.amount, usage.cost.available)}
                </div>
                <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                  估算成本 · {rangeLabel}
                  <button
                    type="button"
                    className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                    onClick={() => setPricesOpen(true)}
                  >
                    计价依据
                  </button>
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="flex items-center gap-1.5 text-xl font-semibold tabular-nums">
                  <Hash className="h-4 w-4 text-muted-foreground" />
                  {fmtNum(t.turns)}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">调用次数 · {rangeLabel}</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xl font-semibold tabular-nums">{fmtNum(t.tokens.input)}</div>
                <div className="mt-0.5 text-xs text-muted-foreground" title="没吃到缓存的输入，贵的那部分">
                  未缓存输入（贵的部分）
                </div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="flex items-center gap-1.5 text-xl font-semibold tabular-nums">
                  <PiggyBank className="h-4 w-4 text-emerald-600" />
                  {fmtNum(t.tokens.cacheRead)}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground" title="缓存命中的输入，约 1/50 价">
                  缓存命中（约 1/50 价）
                </div>
              </div>
              <div className="col-span-2 rounded-lg border p-3 sm:col-span-1">
                <div className="text-xl font-semibold tabular-nums">{fmtRate(t.cacheHitRate)}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">缓存命中率</div>
                {t.cacheHitRate !== null && hitDenom > 0 ? (
                  <>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-emerald-500"
                        style={{ width: `${Math.min(100, t.cacheHitRate * 100)}%` }}
                      />
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      命中 ÷（命中 + 未缓存输入）
                    </div>
                  </>
                ) : (
                  <div className="mt-1.5 text-[10px] text-muted-foreground">没有输入，无法计算</div>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
              <span>输出 token：{fmtNum(t.tokens.output)}</span>
              {t.tokens.reasoning !== null && t.tokens.reasoning !== undefined && (
                <span title="思考 token 是输出的一部分，不重复计入总量">
                  其中思考：{fmtNum(t.tokens.reasoning)}（已含在输出里）
                </span>
              )}
              {t.tokens.cacheWrite !== null && t.tokens.cacheWrite !== undefined && (
                <span>缓存写入：{fmtNum(t.tokens.cacheWrite)}</span>
              )}
              {t.lastContextTokens !== null && t.lastContextTokens !== undefined && (
                <span title="最近一回合最后一步的上下文总量，是快照，不可累加、不可计价">
                  当前上下文占用：{fmtNum(t.lastContextTokens)}（快照）
                </span>
              )}
            </div>

            {/* 按天表 */}
            {usage.byDay.length > 0 && (
              <div>
                <div className="mb-1.5 text-sm font-medium">按天</div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>日期</TableHead>
                      <TableHead className="text-right">调用</TableHead>
                      <TableHead className="text-right">未缓存输入</TableHead>
                      <TableHead className="text-right">缓存命中</TableHead>
                      <TableHead className="text-right">输出</TableHead>
                      <TableHead className="text-right">命中率</TableHead>
                      <TableHead className="text-right">成本（估算）</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usage.byDay.map((d) => (
                      <TableRow key={d.date}>
                        <TableCell className="tabular-nums">{d.date}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(d.turns)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(d.tokens.input)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(d.tokens.cacheRead)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(d.tokens.output)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtRate(d.cacheHitRate)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {d.cost === null || d.cost === undefined ? '—' : `¥${d.cost.toFixed(4)}`}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* 按会话表：label 直接用接口给的，不自己拼 */}
            {usage.bySession.length > 0 && (
              <div>
                <div className="mb-1.5 text-sm font-medium">按会话</div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>会话</TableHead>
                      <TableHead className="text-right">调用</TableHead>
                      <TableHead className="text-right">未缓存输入</TableHead>
                      <TableHead className="text-right">缓存命中</TableHead>
                      <TableHead className="text-right">输出</TableHead>
                      <TableHead className="text-right">命中率</TableHead>
                      <TableHead className="text-right">成本（估算）</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usage.bySession.map((s) => (
                      <TableRow key={s.chatKey}>
                        <TableCell>
                          <span className="flex items-center gap-1.5">
                            <Badge
                              variant="outline"
                              className={cn(
                                'text-[10px] font-normal',
                                s.kind === 'group'
                                  ? 'border-violet-300 text-violet-600'
                                  : 'border-sky-300 text-sky-600',
                              )}
                            >
                              {s.kind === 'group' ? '群' : '私聊'}
                            </Badge>
                            {s.label}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(s.turns)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(s.tokens.input)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(s.tokens.cacheRead)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(s.tokens.output)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtRate(s.cacheHitRate)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {s.cost === null || s.cost === undefined ? '—' : `¥${s.cost.toFixed(4)}`}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        ) : null}

        {/* 两条必须写进界面的说明 */}
        <div className="space-y-1.5 border-t pt-3 text-xs leading-relaxed text-muted-foreground">
          <p className="flex gap-1.5">
            <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            用量记账落盘在 <code className="rounded bg-muted px-1">logs/usage.jsonl</code>
            （追加写），重启不丢——和「对话」页签的内存镜像完全不同（那个重启就清空）。
          </p>
          <p className="flex gap-1.5">
            <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              这里的钱是<strong className="text-foreground">估算</strong>
              ，和运营商账单不会逐分吻合：节假日表靠人工维护（默认空，节假日按高峰算，偏高）、
              价格会变、上游可能有自己的取整规则。拿它对账会失望，拿它看趋势才有用。
              另外：时段灯反映的是「现在」，历史数字按每次调用发生那一刻的时段算——
              所以「现在是低谷，但今天的账里有一半按高峰算」是正常的，不是 bug。
            </span>
          </p>
        </div>
      </CardContent>

      <PricesDialog open={pricesOpen} onClose={() => setPricesOpen(false)} demo={demo} />
    </Card>
  )
}
