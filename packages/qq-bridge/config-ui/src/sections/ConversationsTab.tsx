import { useEffect, useRef, useState } from 'react'
import { api, workspaceFileUrl, type Conversation, type ConversationsResult } from '@/lib/api'
import { InlineNote } from '@/components/common'
import { cn } from '@/lib/utils'
import { ImageOff, Loader2, MessageSquareOff, User, Users } from 'lucide-react'

function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 消息里的图片（CONFIG-UI.md §2.9）：
 * 只在 user 消息上出现，且只有真的会回复的那轮才有（防 DoS）。
 * ok:true 按工作区相对路径取图显示；ok:false 显示占位块 + reason，
 * **不静默丢** —— "这里本来有张图"是用户需要知道的信息。
 * text 里的 [图片] 原样保留（对原始消息的忠实还原）。
 */
function MessageImages({ images }: { images: NonNullable<Conversation['messages'][number]['images']> }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {images.map((img, j) =>
        img.ok ? (
          <a
            key={j}
            href={workspaceFileUrl(img.path)}
            target="_blank"
            rel="noreferrer"
            title={`${img.path} · ${fmtSize(img.bytes)}（点开看原图）`}
            className="block overflow-hidden rounded-lg border bg-background"
          >
            <img
              src={workspaceFileUrl(img.path)}
              alt="对方发的图片"
              loading="lazy"
              className="max-h-40 max-w-56 object-contain"
            />
          </a>
        ) : (
          <div
            key={j}
            className="flex items-center gap-1.5 rounded-lg border border-dashed px-2.5 py-2 text-[11px] text-muted-foreground"
          >
            <ImageOff className="h-3.5 w-3.5 shrink-0" />
            <span>
              这里本来有张图，没取到：<span className="font-mono">{img.reason}</span>
            </span>
          </div>
        ),
      )}
    </div>
  )
}

function StatusText({ status }: { status: string }) {
  if (status === 'thinking') {
    return (
      <span className="flex items-center gap-1 text-sky-600">
        <Loader2 className="h-3 w-3 animate-spin" />
        正在处理…
      </span>
    )
  }
  if (status === 'idle') return <span className="text-muted-foreground">空闲</span>
  return <span className="text-muted-foreground">{status || '—'}</span>
}

/**
 * 思考过程块（CONFIG-UI.md §2.9「四种角色」）：
 * 默认折叠成一行「💭 已思考（N 字）」；淡化处理不抢视觉重心；
 * 标明"只在这个界面可见，不会发到 QQ"。它是"这一轮"的思考，
 * 与 user/bot 交替出现是正常的。
 */
function ThinkingBlock({ text, at }: { text: string; at: number }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md border border-dashed bg-muted/30 px-3 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground select-none"
      >
        <span>💭 已思考（{[...text].length} 字）</span>
        <span className="text-[10px]">{open ? '▲ 收起' : '▼ 展开'}</span>
        <span className="ml-auto shrink-0 text-[10px]">只有这里能看到，不会发到 QQ · {fmtTime(at)}</span>
      </button>
      {open && (
        <div className="mt-1.5 max-h-64 overflow-y-auto border-t border-dashed pt-1.5 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  )
}

/** 会话显示名：接口只给 peerId（CONFIG-UI.md §2.8 ③），拿不到昵称就显示号码。 */
function peerName(c: Conversation): string {
  return c.peerId || c.chatKey
}

export function ConversationsTab({
  botName,
  groupEnabled,
}: {
  botName?: string
  groupEnabled: boolean
}) {
  const [data, setData] = useState<ConversationsResult | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [unreachable, setUnreachable] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let dead = false
    const tick = async () => {
      try {
        const d = await api.conversations()
        if (!dead) {
          setData(d)
          setUnreachable(false)
        }
      } catch {
        if (!dead) setUnreachable(true)
      }
    }
    tick()
    const timer = setInterval(tick, 2500) // 文档建议 2~3 秒轮询
    return () => {
      dead = true
      clearInterval(timer)
    }
  }, [])

  const convs = data?.conversations ?? []
  const active = convs.find((c) => c.chatKey === selected) ?? convs[0] ?? null
  const msgCount = active?.messages.length ?? 0

  // 新消息到达时滚到底部
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [active?.chatKey, msgCount])

  return (
    <div className="space-y-3">
      {/* 内存镜像说明已常驻右栏底部小字（渲染分支之外），此处不再重复。
          其余说明收成一条可折叠小字，让对话区保持干净（内容仍是文档要求必须说明的） */}
      <details className="rounded-md border px-3 py-1.5 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none">关于这个对话界面的几点说明</summary>
        <ul className="mt-1.5 list-disc space-y-1 pb-1 pl-5 leading-relaxed">
          {!groupEnabled && (
            <li>群聊总开关当前是关闭的，所以列表里只会出现私聊——这是正常的，不是 bug。</li>
          )}
          <li>
            等待回复期间又发了消息时：<strong className="text-foreground">内容重复会被跳过</strong>
            （刻意的去重，不是故障）；<strong className="text-foreground">发了新内容则旧回合作废</strong>
            ——它的「先应一声」可能已经出现在消息流里，但旧问题的正式回复不会再来了。
          </li>
          <li>
            机器人说「没权限做」是普通消息不是错误（权限边界是刻意设计），所以这里不会把它标红。
          </li>
        </ul>
      </details>
      {unreachable && <InlineNote level="warn">会话数据暂时拉取不到（接口未响应）。</InlineNote>}

      <div className="flex h-[560px] overflow-hidden rounded-lg border bg-card">
        {/* 左：会话列表（后端已按最近活动倒序） */}
        <div className="w-60 shrink-0 overflow-y-auto border-r">
          {convs.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs text-muted-foreground">
              <MessageSquareOff className="h-6 w-6" />
              还没有任何会话。
              <br />
              有人给机器人发私聊后，这里就会出现。
            </div>
          )}
          {convs.map((c) => (
            <button
              key={c.chatKey}
              type="button"
              onClick={() => setSelected(c.chatKey)}
              className={cn(
                'flex w-full flex-col gap-0.5 border-b px-3 py-2.5 text-left transition-colors',
                active?.chatKey === c.chatKey ? 'bg-accent' : 'hover:bg-accent/50',
              )}
            >
              <div className="flex items-center gap-1.5">
                {c.kind === 'group' ? (
                  <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-mono text-sm font-medium">{peerName(c)}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {fmtTime(c.updatedAt)}
                </span>
              </div>
              <div className="pl-5 text-xs">
                <StatusText status={c.status} />
              </div>
            </button>
          ))}
        </div>

        {/* 右：消息流 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {active ? (
            <>
              <div className="border-b px-4 py-2 text-sm">
                <span className="font-mono font-medium">{peerName(active)}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {active.kind === 'group' ? '群聊' : '私聊'} · {active.messageCount} 条
                </span>
              </div>
              <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
                {active.messages.map((m, i) => {
                  if (m.role === 'notice') {
                    // 桥接自己插的话（"先应一声"、"连接断开"）：居中灰色小字，不做气泡
                    return (
                      <div key={i} className="text-center text-[11px] text-muted-foreground">
                        {m.text} · {fmtTime(m.at)}
                      </div>
                    )
                  }
                  if (m.role === 'thinking') {
                    // 思考过程：默认折叠的可展开块；只有这个界面能看到，不会发到 QQ
                    if (!m.text.trim()) return null // 没有就不显示，不出空折叠条
                    return <ThinkingBlock key={i} text={m.text} at={m.at} />
                  }
                  if (m.role === 'user') {
                    // 对方发的：左侧气泡；text 里的 [图片] 原样保留（忠实还原），
                    // 取到的图片显示在气泡下方（§2.9）
                    return (
                      <div key={i} className="flex justify-start">
                        <div className="max-w-[75%]">
                          <div className="rounded-2xl rounded-tl-sm bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
                            {m.text}
                          </div>
                          {m.images && m.images.length > 0 && <MessageImages images={m.images} />}
                          <div className="mt-0.5 text-[10px] text-muted-foreground">
                            {fmtTime(m.at)}
                          </div>
                        </div>
                      </div>
                    )
                  }
                  // bot：机器人实际发到 QQ 的正式回复，右侧气泡
                  return (
                    <div key={i} className="flex justify-end">
                      <div className="max-w-[75%]">
                        <div className="rounded-2xl rounded-tr-sm bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
                          {m.text}
                        </div>
                        <div className="mt-0.5 text-right text-[10px] text-muted-foreground">
                          {botName ?? '机器人'} {fmtTime(m.at)}
                        </div>
                      </div>
                    </div>
                  )
                })}
                {active.status === 'thinking' && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    正在处理…
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              选择左侧的会话查看消息
            </div>
          )}
          {/* 常驻小字：内存镜像说明。放在右栏底部、渲染分支之外，
              无论有没有会话、滚动到什么位置都始终可见 —— 防止使用者以为消息丢了 */}
          <div className="border-t px-4 py-1.5 text-center text-[11px] text-muted-foreground">
            内存镜像，不是历史归档：每会话只保留最近 50 条，重启机器人后清空。长期记忆在工作区的
            MEMORY.md。
          </div>
        </div>
      </div>
    </div>
  )
}
