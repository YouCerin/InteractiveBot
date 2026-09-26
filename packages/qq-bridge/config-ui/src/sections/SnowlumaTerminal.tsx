import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { InlineNote } from '@/components/common'
import { api, isNotImplemented, type SnowlumaLogLine } from '@/lib/api'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Eraser, FolderOpen, Loader2, TerminalSquare } from 'lucide-react'

/**
 * SnowLuma 终端面板（CONFIG-UI.md §2.7.3）。
 * 数据来自 GET /api/snowluma/log —— 读的是 SnowLuma 自己的日志文件（UTF-8 保真），
 * 不是它的 stdout（终端编码会乱码）。
 * 三条必须做对：rotated=true 清空面板；truncated=true 提示"上面还有更早的日志"；
 * available=false 用平实的话，不报红。
 */

const LEVEL_CLASS: Record<string, string> = {
  ERROR: 'text-red-400',
  WARN: 'text-amber-400',
  OK: 'text-emerald-400',
  DEBUG: 'text-zinc-500',
}

const DEMO_LINES: SnowlumaLogLine[] = [
  { time: '00:25:52', level: 'OK', rest: '[200000001] [Event] 私聊 [无忘远霞(100000001)]: 确认一下群聊开关打开了吗', text: '00:25:52 OK    [200000001] [Event] 私聊 [无忘远霞(100000001)]: 确认一下群聊开关打开了吗' },
  { time: '00:28:56', level: 'DEBUG', rest: '[200000001] [Bridge.Action] get_login_info params=', text: '00:28:56 DEBUG [200000001] [Bridge.Action] get_login_info params=' },
  { time: '00:29:01', level: 'WARN', rest: '[200000001] [Notice] 群 700000002 不在白名单，静默跳过', text: '00:29:01 WARN  [200000001] [Notice] 群 700000002 不在白名单，静默跳过' },
]

export function SnowlumaTerminal({ demo }: { demo: boolean }) {
  const [lines, setLines] = useState<SnowlumaLogLine[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [available, setAvailable] = useState(true)
  const [note, setNote] = useState<string | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [dir, setDir] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [droppedDebug, setDroppedDebug] = useState(0)
  const [importantOnly, setImportantOnly] = useState(true) // 「只看重要」默认勾上
  const [autoScroll, setAutoScroll] = useState(true)
  const [loading, setLoading] = useState(true)

  const offsetRef = useRef(0)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const autoScrollRef = useRef(true)
  autoScrollRef.current = autoScroll
  const importantRef = useRef(true)
  importantRef.current = importantOnly

  /** 全量重拉（首次 / 切换"只看重要" / 手动刷新）。 */
  const fullReload = useCallback(async () => {
    if (demo) {
      setLines(DEMO_LINES)
      setAvailable(true)
      setLoading(false)
      return
    }
    try {
      const r = await api.snowlumaLog({ lines: 200, includeDebug: !importantRef.current })
      setAvailable(r.available)
      setNote(r.note ?? null)
      setFile(r.file ?? null)
      setDir(r.dir ?? null)
      setLines(r.available ? r.lines : [])
      offsetRef.current = r.offset
      setTruncated(r.truncated)
      setDroppedDebug(r.droppedDebug ?? 0)
      setPending(false)
      setError(null)
    } catch (e) {
      if (isNotImplemented(e)) {
        setPending(true)
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setLoading(false)
    }
  }, [demo])

  // 首次加载
  useEffect(() => {
    fullReload()
  }, [fullReload])

  // 2 秒增量轮询
  useEffect(() => {
    if (demo || pending) return
    const t = setInterval(async () => {
      try {
        const r = await api.snowlumaLog({ offset: offsetRef.current, includeDebug: !importantRef.current })
        if (!r.available) {
          setAvailable(false)
          setNote(r.note ?? null)
          return
        }
        setAvailable(true)
        offsetRef.current = r.offset
        setDroppedDebug(r.droppedDebug ?? 0)
        if (r.rotated) {
          // ★ 日志按天轮转：手上的 offset 已失效，接口从头再给一遍——必须清空再显示
          setLines(r.lines)
          setTruncated(r.truncated)
        } else if (r.lines.length > 0) {
          setLines((prev) => [...prev, ...r.lines].slice(-1000))
        }
      } catch {
        // 轮询失败静默——下一次再试，不打扰用户
      }
    }, 2000)
    return () => clearInterval(t)
  }, [demo, pending])

  // 自动滚动到底
  useEffect(() => {
    const el = boxRef.current
    if (el && autoScroll) el.scrollTop = el.scrollHeight
  }, [lines, autoScroll])

  // 用户手动往上滚 → 自动关掉自动滚动（否则没法看历史）
  const onScroll = () => {
    const el = boxRef.current
    if (!el) return
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
    if (!atBottom && autoScrollRef.current) setAutoScroll(false)
    if (atBottom && !autoScrollRef.current) setAutoScroll(true)
  }

  const clearView = () => {
    setLines([])
    toast.info('已清屏——只清了界面上的显示，日志文件没动。')
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <TerminalSquare className="h-4 w-4" />
            SnowLuma 终端
          </CardTitle>
          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch
                checked={importantOnly}
                onCheckedChange={(v) => {
                  setImportantOnly(v)
                  setLoading(true)
                  // 切换过滤口径后全量重拉（offset 口径变了）
                  setTimeout(fullReload, 0)
                }}
                className="scale-90"
              />
              只看重要
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Switch
                checked={autoScroll}
                onCheckedChange={setAutoScroll}
                className="scale-90"
              />
              自动滚动
            </label>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={clearView}>
              <Eraser className="mr-1 h-3.5 w-3.5" />
              清屏
            </Button>
            {dir && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs"
                title="浏览器无法直接打开文件管理器，点击复制日志目录路径"
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(dir)
                    .then(() => toast.success('日志目录路径已复制。'))
                    .catch(() => toast.info(dir))
                }}
              >
                <FolderOpen className="mr-1 h-3.5 w-3.5" />
                日志目录
              </Button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          读的是 SnowLuma 自己的日志文件（UTF-8 保真，按天轮转），不是抓它的 stdout。「清屏」只清界面显示，不删日志文件。
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {pending ? (
          <InlineNote level="info">
            SnowLuma 日志接口还没实现（CONFIG-UI.md §5.1，目前返回 501）。接口落地后这里自动可用。
          </InlineNote>
        ) : error ? (
          <InlineNote level="warn">{error}</InlineNote>
        ) : loading && lines.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取日志…
          </div>
        ) : !available ? (
          /* available:false 不是错误，用平实的话 */
          <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            {note ?? '还没有 SnowLuma 日志 —— 它还没运行过。'}
          </div>
        ) : (
          <>
            {truncated && (
              <div className="text-center text-[11px] text-muted-foreground">
                仅显示最近一段日志，上面还有更早的内容（在日志文件里）。
              </div>
            )}
            <div
              ref={boxRef}
              onScroll={onScroll}
              className="h-80 overflow-y-auto rounded-md bg-zinc-950 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-300"
            >
              {lines.length === 0 ? (
                <div className="py-6 text-center text-zinc-500">（暂无日志行）</div>
              ) : (
                lines.map((l, i) => (
                  <div key={i} className="whitespace-pre-wrap break-all">
                    {l.time && <span className="text-zinc-500">{l.time} </span>}
                    {l.level && (
                      <span className={cn('inline-block w-12', LEVEL_CLASS[l.level] ?? 'text-zinc-500')}>
                        {l.level}
                      </span>
                    )}
                    {/* 解析不出来的行 time/level 为 null，用 text 原文照显示——任何一行都可能是线索 */}
                    <span>{l.time || l.level ? (l.rest ?? l.text) : l.text}</span>
                  </div>
                ))
              )}
            </div>
            <div className="flex flex-wrap justify-between gap-2 text-[11px] text-muted-foreground">
              <span>
                {importantOnly && droppedDebug > 0 && `已隐藏 ${droppedDebug} 行调试日志（关掉「只看重要」可查看）`}
              </span>
              {file && <span className="truncate font-mono">{file}</span>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
