import { useState } from 'react'
import { Search } from 'lucide-react'

import { api, isNotImplemented, type CorpusResult } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * 会话内历史检索（H13，规格见 CONFIG-UI.md §5.x）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它解决什么
 * ══════════════════════════════════════════════════════════════════════════
 * 在此之前"回看历史"只有一条路：现拉最近 N 条（不能检索、协议端一重启就没了）。
 * 所以"我上次说的那个方案叫什么来着"这类问题，机器人**真的答不了**。
 * 现在本地语料库能按关键词搜（中文 2 字走 LIKE 回退，见 corpus.mjs）。
 *
 * ★★ 为什么**必须**带 `kind` + `peerId`：语料库里存着**所有会话**的消息 ——
 *    不带会话过滤就等于把别的群/别人的私聊显示在这个页面上（那是看一眼就发生的泄露）。
 *    后端缺参数会直接 **400**，而这里**只允许搜当前打开的那个会话**。
 * ★ 字段叫 `preview`（**截断预览**，不是全文）：别把它当完整消息展示，
 *    所以这里对预览加一句说明，而不是假装它是全文。
 */
export function CorpusSearch({
  kind,
  peerId,
  demo = false,
}: {
  kind: 'private' | 'group'
  peerId: string
  demo?: boolean
}) {
  const [q, setQ] = useState('')
  const [res, setRes] = useState<CorpusResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)

  if (demo || unsupported) return null

  const run = async () => {
    const query = q.trim()
    if (!query || !peerId) return
    setLoading(true)
    setErr(null)
    try {
      setRes(await api.corpusSearch({ q: query, kind, peerId, limit: 20 }))
      setUnsupported(false)
    } catch (e) {
      if (isNotImplemented(e)) setUnsupported(true)
      else setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="border-b bg-muted/30 px-4 py-2">
      <div className="flex items-center gap-2">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void run()
          }}
          placeholder="在本会话的历史里搜关键词（只搜这一个会话）"
          className="h-7 max-w-sm text-xs"
        />
        <Button size="sm" variant="secondary" className="h-7" onClick={() => void run()} disabled={loading}>
          {loading ? '搜…' : '搜索'}
        </Button>
        {res && (
          <button
            type="button"
            className="text-xs text-muted-foreground underline"
            onClick={() => {
              setRes(null)
              setQ('')
            }}
          >
            清空
          </button>
        )}
      </div>
      {err && <div className="mt-1 text-xs text-red-700">{err}</div>}
      {res && (
        <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
          {res.rows.length === 0 ? (
            <div className="text-xs text-muted-foreground">
              没搜到。（也可能这条消息早于语料库启用，或者已经被 30 天 TTL 清掉了。）
            </div>
          ) : (
            <>
              {res.rows.map((r, i) => (
                <div key={`${r.mid ?? i}`} className="rounded border bg-background p-1.5 text-xs">
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className={cn('font-medium', r.isBot && 'text-sky-700')}>{r.sender || '某人'}</span>
                    {r.at && <span>{new Date(r.at).toLocaleString('zh-CN')}</span>}
                    {r.mid && <span className="font-mono">#{r.mid}</span>}
                  </div>
                  <div className="whitespace-pre-wrap break-words">{r.preview}</div>
                </div>
              ))}
              <div className="text-[10px] text-muted-foreground">
                共 {res.rows.length} 条；内容是**截断预览**（语料库按上限截断），不是全文。
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
