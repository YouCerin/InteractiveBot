import { useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play, RefreshCw } from 'lucide-react'

import { api, isNotImplemented } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

const POLL_MS = 2000
const MAX_LINES = 400

/**
 * 桥接日志（H13，规格见 CONFIG-UI.md §5.x）。
 *
 * ★ **轮询，不是 SSE**：后端接口是"一次请求一次响应"（`serveApi` 直接 `res.end`），
 *   改成流式要重做那一层；而"近实时"用秒级轮询已经够，实现与排查都更简单。
 *   这条如实写在代码里，免得后来者以为"这里本该是 SSE、是不是漏了"。
 * ★ 用**游标**增量取：游标是"已经给过的行数"，超出总行数时后端会自动回到 0
 *   （日志轮转后不会永远收不到新日志）。
 * ★ 只显示，不写盘、不控制进程 —— 这是"看正在发生什么"的窗口。
 */
export function BridgeLogCard({ demo = false }: { demo?: boolean }) {
  const [lines, setLines] = useState<string[]>([])
  const [cursor, setCursor] = useState(0)
  const [follow, setFollow] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)

  const pull = useCallback(async () => {
    try {
      const chunk = await api.logStream({ since: cursor, limit: 200 })
      setUnsupported(false)
      setErr(null)
      if (chunk.lines.length > 0) {
        setLines((prev) => [...prev, ...chunk.lines].slice(-MAX_LINES))
      }
      setCursor(chunk.cursor)
    } catch (e) {
      if (isNotImplemented(e)) {
        setUnsupported(true)
        return
      }
      setErr(e instanceof Error ? e.message : String(e))
    }
  }, [cursor])

  // 首次进来先把最近的一段拉出来（否则面板是空的，得等两秒才有一行）
  useEffect(() => {
    if (demo) return
    let cancelled = false
    void (async () => {
      try {
        const chunk = await api.logStream({ since: 0, limit: 200 })
        if (cancelled) return
        setLines(chunk.lines.slice(-MAX_LINES))
        setCursor(chunk.cursor)
      } catch {
        /* 首次失败由轮询那一路报错，这里不重复报 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [demo])

  useEffect(() => {
    if (demo || unsupported || !follow) return
    const timer = setInterval(() => void pull(), POLL_MS)
    return () => clearInterval(timer)
  }, [demo, unsupported, follow, pull])

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight
  }, [lines, follow])

  if (demo || unsupported) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">桥接日志</CardTitle>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setFollow((f) => !f)}>
              {follow ? <Pause className="mr-1 h-3.5 w-3.5" /> : <Play className="mr-1 h-3.5 w-3.5" />}
              {follow ? '暂停跟随' : '继续跟随'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void pull()}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              拉一次
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {err && <div className="mb-2 text-xs text-red-700">取日志失败：{err}</div>}
        <div
          ref={boxRef}
          className={cn(
            'h-56 overflow-auto rounded-md bg-slate-950 p-2 font-mono text-[11px] leading-relaxed text-slate-200',
          )}
        >
          {lines.length === 0 ? (
            <div className="text-slate-500">（还没有日志）</div>
          ) : (
            lines.map((l, i) => (
              <div key={`${i}-${l.slice(0, 24)}`} className="whitespace-pre-wrap break-all">
                {l}
              </div>
            ))
          )}
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          每 {POLL_MS / 1000} 秒拉一次增量（轮询，不是 SSE —— 见 CONFIG-UI.md §5.x 的说明）。
        </div>
      </CardContent>
    </Card>
  )
}
