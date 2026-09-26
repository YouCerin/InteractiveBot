import { useState } from 'react'
import { Search } from 'lucide-react'

import { api, isNotImplemented, type MemorySearchResult } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * 记忆条目检索（H13，规格见 CONFIG-UI.md §5.x）。
 *
 * ★ 与「对话页的历史检索」是两件事，别合并：
 *   · 这里搜的是**沉淀下来的事实**（记忆条目，跨重启生效，按会话分档存成文件）；
 *   · 那边搜的是**说过什么**（消息流水，有 30 天 TTL）。
 *   合起来会让人以为"搜到的就是它记住的"，而两者并不等价。
 *
 * ★ 不需要会话参数：记忆文件名本身就分档了（`MEMORY.md` / `private-<QQ>.md` / `group-<群号>.md`），
 *   "这个文件属于谁"看一眼名字就知道，不存在跨会话泄露的问题。
 * ★ 已被更正的条目会**标出来**（它们仍在文件里，但不再作为事实使用）——
 *   不标会让人以为模型还在用那条错的。
 */
export function MemorySearchCard({ demo = false }: { demo?: boolean }) {
  const [q, setQ] = useState('')
  const [res, setRes] = useState<MemorySearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)

  if (demo || unsupported) return null

  const run = async () => {
    const query = q.trim()
    if (!query) return
    setLoading(true)
    setErr(null)
    try {
      setRes(await api.memorySearch(query))
      setUnsupported(false)
    } catch (e) {
      if (isNotImplemented(e)) setUnsupported(true)
      else setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Search className="h-4 w-4" />
          搜记忆条目
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void run()
            }}
            placeholder="在全部记忆文件里搜关键词（跨会话，因为记忆本来就是分档存的）"
            className="h-8 max-w-md text-sm"
          />
          <Button size="sm" onClick={() => void run()} disabled={loading}>
            {loading ? '搜…' : '搜索'}
          </Button>
        </div>
        {err && <div className="text-xs text-red-700">{err}</div>}
        {res && (
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {res.rows.length === 0 ? (
              <div className="text-xs text-muted-foreground">
                没搜到（{res.files} 个记忆文件）。注意记忆里存的是**条目**，不是聊天原文。
              </div>
            ) : (
              <>
                {res.rows.map((r, i) => (
                  <div
                    key={`${r.rel}-${r.line}-${i}`}
                    className={cn(
                      'rounded border bg-background p-1.5 text-xs',
                      r.superseded && 'opacity-70',
                    )}
                  >
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="font-mono">{r.rel}:{r.line}</span>
                      {r.superseded && (
                        <span className="rounded bg-amber-100 px-1 text-amber-800">
                          已被更正（不再作为事实使用）
                        </span>
                      )}
                    </div>
                    <div className="break-words">{r.preview}</div>
                  </div>
                ))}
                <div className="text-[10px] text-muted-foreground">
                  共 {res.rows.length} 条命中（扫了 {res.files} 个记忆文件）；显示的是**行预览**。
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
