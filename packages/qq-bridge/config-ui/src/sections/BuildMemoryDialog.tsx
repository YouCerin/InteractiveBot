import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Hammer, Loader2 } from 'lucide-react'

import {
  api,
  isNotImplemented,
  type BuildMemoryArgs,
  type BuildMemoryResult,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { InlineNote } from '@/components/common'

export interface BuildTarget {
  kind: 'group' | 'private'
  peerId: string
  label: string
}

type Phase =
  | { name: 'loading' }
  | { name: 'preview'; data: BuildMemoryResult }
  | { name: 'running' }
  | { name: 'report'; data: BuildMemoryResult }
  | { name: 'unsupported' }
  | { name: 'error'; message: string }

/**
 * 「整理记忆」对话框（0.2.9，原名"立刻建档"，规格见 CONFIG-UI.md §2.5.2）。
 *
 * 形状必须是「先预演 → 人看过 → 再确认」——它要花一次模型调用（要钱），
 * 不允许做成"一键悄悄建档"。交互三段，别合并：
 *   ① 打开 = dryRun（不调模型、不写盘）：显示"将处理 N 条（另有 M 条留到下次）"
 *     + 可折叠的「要发给模型的内容」（prompt 原文，含对话原文）。
 *   ② 点「确认建档」才真跑（dryRun:false）。
 *   ③ 报告：applied / ignored（带 why，不许美化掉失败）/ wroteFiles / 游标位置。
 * 硬要求：不自动轮询、不后台重试（一次点击最多两次请求）；ok:false 时明说"游标没有前进，可以稍后重试"。
 */
export function BuildMemoryDialog({
  target,
  onClose,
}: {
  target: BuildTarget | null
  onClose: () => void
}) {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' })
  const [promptOpen, setPromptOpen] = useState(false)

  const runDry = useCallback(async (t: BuildTarget) => {
    setPhase({ name: 'loading' })
    setPromptOpen(false)
    try {
      const data = await api.memoryBuild({ kind: t.kind, peerId: t.peerId } satisfies BuildMemoryArgs)
      // 预演也可能 ok:false（如没有可用模型通路）——按报告渲染，让人看到原因
      setPhase(data.ok ? { name: 'preview', data } : { name: 'report', data })
    } catch (e) {
      if (isNotImplemented(e)) setPhase({ name: 'unsupported' })
      else setPhase({ name: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }, [])

  useEffect(() => {
    if (!target) return
    // setTimeout 推迟到 effect 外再拉（react-hooks/set-state-in-effect）；
    // 对话框每次打开都重新预演一次。
    const t = setTimeout(() => void runDry(target), 0)
    return () => clearTimeout(t)
  }, [target, runDry])

  const confirm = async () => {
    if (!target) return
    setPhase({ name: 'running' })
    try {
      const data = await api.memoryBuild({ kind: target.kind, peerId: target.peerId, dryRun: false })
      setPhase({ name: 'report', data })
    } catch (e) {
      if (isNotImplemented(e)) setPhase({ name: 'unsupported' })
      else setPhase({ name: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Hammer className="h-5 w-5" />
            整理记忆{target ? ` · ${target.label}` : ''}
          </DialogTitle>
          <DialogDescription>
            把还没计入记忆的消息交给模型整理成条目。<strong>会花一次模型调用</strong>，所以先看预演、你确认后才真跑。
          </DialogDescription>
        </DialogHeader>

        {phase.name === 'loading' && (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在预演（不调模型、不写盘）…
          </div>
        )}

        {phase.name === 'unsupported' && (
          <InlineNote level="warn">这个版本的后端还没有「整理记忆」。升级桥接后这里可用。</InlineNote>
        )}
        {phase.name === 'error' && <InlineNote level="danger">{phase.message}</InlineNote>}

        {phase.name === 'preview' && (
          <div className="space-y-3">
            <InlineNote level="info">
              将处理 <strong>{phase.data.considered}</strong> 条消息
              {phase.data.skipped > 0 && (
                <>
                  （另有 <strong>{phase.data.skipped}</strong> 条超过单次上限 60 条，留到下一次）
                </>
              )}
              。下面这段是<strong>会原样发给模型的内容</strong>（含对话原文，只有你自己看得见）——
              确认它没什么不该发出去的，再点「确认整理」。
            </InlineNote>
            {phase.data.prompt && (
              <div>
                <Button variant="ghost" size="sm" onClick={() => setPromptOpen(!promptOpen)}>
                  {promptOpen ? <ChevronDown className="mr-1 h-3.5 w-3.5" /> : <ChevronRight className="mr-1 h-3.5 w-3.5" />}
                  要发给模型的内容
                </Button>
                {promptOpen && (
                  <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted/60 p-2 text-[11px] leading-relaxed">
                    {phase.data.prompt}
                  </pre>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                取消
              </Button>
              <Button onClick={() => void confirm()}>
                <Hammer className="mr-1 h-3.5 w-3.5" />
                确认整理（会调模型、要写盘）
              </Button>
            </div>
          </div>
        )}

        {phase.name === 'running' && (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在整理并写入记忆…
          </div>
        )}

        {phase.name === 'report' && <Report data={phase.data} onAgain={() => target && void runDry(target)} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  )
}

/** 报告区：全部如实显示，不美化掉失败。applied 为空也是一个正常结果，不显示成失败。 */
function Report({
  data,
  onAgain,
  onClose,
}: {
  data: BuildMemoryResult
  onAgain: () => void
  onClose: () => void
}) {
  const retryable = !data.ok || data.skipped > 0
  return (
    <div className="space-y-3">
      {!data.ok ? (
        <InlineNote level="danger">
          <strong>没建成：</strong>
          {data.why ?? '未知原因'}
          <strong>游标没有前进，可以稍后重试。</strong>
          {data.raw && (
            <pre className="mt-1 whitespace-pre-wrap rounded bg-white/60 p-1.5 text-[10px]">{data.raw}</pre>
          )}
        </InlineNote>
      ) : data.applied.length === 0 && (data.ignored?.length ?? 0) === 0 ? (
        <InlineNote level="info">这段对话里没有值得长期记住的事 —— 这也是一个正常结果，不是失败。</InlineNote>
      ) : (
        <InlineNote level="info">
          已处理 {data.considered} 条，采纳 {data.applied.length} 条、被拒 {data.ignored.length} 条。
        </InlineNote>
      )}

      {data.applied.length > 0 && (
        <div className="rounded-md border">
          <div className="border-b px-3 py-1.5 text-xs font-medium">写进了这些文件</div>
          <ul className="divide-y text-xs">
            {data.applied.map((a, i) => (
              <li key={i} className="px-3 py-1.5">
                <code className="rounded bg-muted px-1">{String(a.rel ?? a.scope)}</code>
                {a.userId && <span className="ml-1 text-muted-foreground">（记在 {a.userId} 名下）</span>}
                <div className="mt-0.5 text-muted-foreground">{String(a.text ?? a.line ?? JSON.stringify(a) ?? '')}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.ignored.length > 0 && (
        <div className="rounded-md border border-amber-300">
          <div className="border-b border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800">
            被内容闸门拒掉的（如实显示，不美化）
          </div>
          <ul className="divide-y text-xs">
            {data.ignored.map((g, i) => (
              <li key={i} className="px-3 py-1.5">
                <span className="text-muted-foreground">{g.entry ?? g.who ?? ''}</span>
                <div className="mt-0.5 text-amber-800">被拒是因为：{g.why ?? '未知'}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.wroteFiles && data.wroteFiles.length > 0 && (
        <p className="text-xs text-muted-foreground">
          动过的文件：{data.wroteFiles.join('、')}
          {data.cursorAfter != null && ` · 进度已推进到第 ${data.cursorAfter} 条`}
          {data.ms != null && ` · 花了 ${(data.ms / 1000).toFixed(1)} 秒`}
        </p>
      )}
      {data.ok && data.skipped > 0 && (
        <InlineNote level="info">还有 {data.skipped} 条没处理，可以再点一次「整理记忆」。</InlineNote>
      )}

      <div className="flex justify-end gap-2">
        {retryable && (
          <Button variant="outline" onClick={onAgain}>
            再来一次
          </Button>
        )}
        <Button onClick={onClose}>关闭</Button>
      </div>
    </div>
  )
}
