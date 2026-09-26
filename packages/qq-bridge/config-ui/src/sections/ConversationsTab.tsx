import { useEffect, useRef, useState } from 'react'
import { api, workspaceFileUrl, type Conversation, type ConversationsResult } from '@/lib/api'
import { InlineNote } from '@/components/common'
import { cn } from '@/lib/utils'
import { ImageOff, Loader2, MessageSquareOff, User, Users } from 'lucide-react'
import { CorpusSearch } from '@/sections/CorpusSearch'

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

/**
 * 会话显示名：**优先用协议端核实到的名字**（群聊=群名，私聊=对方昵称），
 * 没有才退回号码。
 *
 * 为什么号码也要显示：名字可以重复、可以随时改，**号码才是身份**。
 * 所以私聊显示「昵称（号码）」，群聊显示「群名（群号）」。
 *
 * ⚠️ 核实不到时**只显示号码** —— 不猜、不拿 `用户<号码>` 之类拼出来的东西顶替。
 * 那会让使用者以为核实成功了。
 */
function peerName(c: Conversation): string {
  const id = c.peerId || c.chatKey
  // `nameVerified !== true` 时 name 可能是空串或不可信，一律只用号码
  if (c.nameVerified === true && c.name) return `${c.name}（${id}）`
  return id
}

/** 列表里的短标题：名字最长，优先显示名字；只有号码时不显示"（号码）"括号。 */
function peerShort(c: Conversation): string {
  if (c.nameVerified === true && c.name) return c.name
  return c.peerId || c.chatKey
}

/**
 * 消息上的发言人标签（群聊里必须有，否则根本看不出是谁在说话）。
 *
 * 两种状态**必须视觉可分**：
 *   · 已核实（协议端给了昵称）→ 正常显示「昵称 · 群管理」
 *   · 未核实 → 只显示号码 + 一个"未核实"小标，**绝不显示编出来的名字**
 */
function SenderLabel({
  msg,
  sender,
  showName,
}: {
  msg: NonNullable<Conversation['messages'][number]>
  sender?: { name: string; roleLabel: string; verified: boolean }
  showName: boolean
}) {
  // 同一个人连着说了几句时，只在第一条上写名字 —— 否则每行都挂一遍很吵
  if (!showName && !msg.senderRole) return null
  const name = msg.senderName || sender?.name || ''
  const role = msg.senderRole || sender?.roleLabel || ''
  return (
    <div className="mb-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
      {showName && name && <span className="font-medium">{name}</span>}
      <span className="font-mono">{msg.senderId}</span>
      {role && (
        <span
          className={cn(
            'rounded px-1 py-px',
            role === '群主' || role === '群管理'
              ? 'bg-amber-500/15 text-amber-700'
              : 'bg-muted-foreground/15',
          )}
          title="这是 QQ 群内的角色，只用于显示与留痕；能不能动手由配置里的管理员名单决定"
        >
          {role}
        </span>
      )}
      {!sender?.verified && !msg.senderName && (
        <span className="rounded bg-muted-foreground/15 px-1 py-px" title="没能从协议端取到昵称">
          未核实昵称
        </span>
      )}
    </div>
  )
}

export function ConversationsTab({
  botName,
  groupEnabled,
  demo = false,
}: {
  botName?: string
  groupEnabled: boolean
  /** 演示模式：不连后端（会话检索整块不显示） */
  demo?: boolean
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
          <li>
            发言人身份（昵称、群内角色）是桥接**从协议端现查**的，查不到就只显示号码和一个
            「未核实昵称」小标——<strong className="text-foreground">不会编名字</strong>。
            群内角色只用于显示与留痕：<strong className="text-foreground">能不能动手，只由配置里的管理员名单决定</strong>。
          </li>
          <li>
            左侧列表的标题是<strong className="text-foreground">群名 / 对方昵称</strong>（同样来自协议端，
            下面小字是群号或 QQ 号）。核实不到名字时只显示号码，并标「未核实名称」——
            号码才是身份，名字只是注释。
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
                {/* 标题用**名字**（群名/昵称），号码放到下面一行小字 ——
                    两者都要，因为名字会重、号码才是身份。核实不到名字时
                    这里就只有号码，不做任何补全。 */}
                <span className="truncate text-sm font-medium" title={peerName(c)}>
                  {peerShort(c)}
                </span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {fmtTime(c.updatedAt)}
                </span>
              </div>
              <div className="flex items-center gap-1.5 pl-5 text-xs">
                <StatusText status={c.status} />
                {c.nameVerified === true && c.name && (
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/70">
                    {c.peerId}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>

        {/* 右：消息流 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {active ? (
            <>
              <div className="border-b px-4 py-2 text-sm">
                <span className="font-medium">{peerShort(active)}</span>
                <span className="ml-2 font-mono text-xs text-muted-foreground">{active.peerId}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {active.kind === 'group' ? '群聊' : '私聊'} · {active.messageCount} 条
                  {active.kind === 'group' && Object.keys(active.senders ?? {}).length > 0
                    ? ` · ${Object.keys(active.senders ?? {}).length} 位发言人`
                    : ''}
                </span>
                {active.nameVerified !== true && (
                  <span
                    className="ml-2 rounded bg-muted-foreground/15 px-1 py-px text-[10px] text-muted-foreground"
                    title="没能从协议端取到名字（不影响机器人回话）"
                  >
                    未核实名称
                  </span>
                )}
              </div>
              {/* ★ H13：在本会话里搜历史（"我上次说的那个…"）。
                  ⚠️ 它**只搜当前打开的会话** —— 语料库里存着所有会话的消息，
                  不限定会话就等于把别的群/别人的私聊显示在这个页面上。 */}
              <CorpusSearch
                kind={active.kind === 'group' ? 'group' : 'private'}
                peerId={String(active.peerId)}
                demo={demo}
              />
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
                    //
                    // ★ 发言人身份（§2.8 ④）：群聊里一个会话有多个人说话，
                    //   不标名字根本看不出谁是谁。同一人连续发言时只标第一条。
                    const prev = active.messages[i - 1]
                    const showName = !prev || prev.role !== 'user' || prev.senderId !== m.senderId
                    return (
                      <div key={i} className="flex justify-start">
                        <div className="max-w-[75%]">
                          <SenderLabel
                            msg={m}
                            sender={m.senderId ? active.senders?.[m.senderId] : undefined}
                            showName={showName}
                          />
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
