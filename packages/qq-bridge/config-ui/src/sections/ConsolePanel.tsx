import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Terminal } from 'lucide-react'

import { api, type ServerRow } from '@/lib/api'
import { Button } from '@/components/ui/button'

/**
 * 服务器**控制台**（0.3.2 收尾）：手动输一条指令，看它引起的控制台输出。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 三条必须显示出来的事实（否则界面会骗人）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **这是完整控制台（op 级别）**。RCON 就是服务端控制台：`op`/`ban`/`stop`
 *      都能做。所以要有一句明说，让使用者知道自己在动什么。
 *      ★ 安全边界（用户拍板）：只从**本机网页**进，**绝不进 QQ 工具面**。
 *   ② **RCON 的应答常常是空的**（真机实测：`list` / `forge tps` 有回显，
 *      而 `time set day` 这类不回话，结果只进日志）。⇒ "什么都没看到"**不代表没生效**。
 *   ③ **输出无法归因到具体命令**。下面是"控制台的新增片段"，并发输入、玩家聊天、
 *      服务端自身日志都会混进来。所以这块**刻意不做成看起来精确的终端**。
 *
 * ★ 它**不经过**重启编排的三道纪律（冷却/次数上限/归属）—— 那是"自动动作"的纪律，
 *   手动敲一条命令是人在做决定。
 */
export function ConsolePanel({ server }: { server: ServerRow }) {
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<{ command: string; reply: string; output: string; caveat: string; at: number }[]>([])
  const [err, setErr] = useState<string | null>(null)
  /** 「实时后台」折叠栏：默认**收起**（打开它才会每 2 秒轮询一次） */
  const [liveOpen, setLiveOpen] = useState(false)
  const [live, setLive] = useState<{ lines: string[]; encoding: string; why: string } | null>(null)
  const [liveErr, setLiveErr] = useState<string | null>(null)
  const liveBox = useRef<HTMLDivElement | null>(null)
  const stickBottom = useRef(true)

  const send = async () => {
    const cmd = command.trim()
    if (!cmd || busy) return
    setBusy(true)
    setErr(null)
    try {
      const r = await api.serversCommand(server.id, cmd)
      setLog((prev) => [
        ...prev,
        { command: r.command || cmd, reply: r.reply ?? '', output: r.output ?? '', caveat: r.caveat ?? '', at: Date.now() },
      ])
      // ★ 发完**不清空输入框**：控制台通常是连着敲好几条（`/time set day` 之后
      //   往往还要 `/weather clear`），清空反而逼人重打。
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // ── 「实时后台」：打开时每 2 秒拉一次最新输出 ──
  //
  // ★ 只在**打开时**轮询：收起状态下一次请求都不发
  //   （这一页本来就强调"进页签拉一次即可，别跟着轮询"）。
  // ★ 后端只读日志尾部、并**按真机编码解码**（那个文件是 GBK），
  //   所以中文能正常显示 —— 界面同时把编码标出来，免得以后有人怀疑是乱码。
  useEffect(() => {
    if (!liveOpen) return
    let stop = false
    const pull = async () => {
      try {
        const r = await api.serversConsole(server.id, 300)
        if (stop) return
        setLive({ lines: r.lines ?? [], encoding: r.encoding ?? 'utf8', why: r.why ?? '' })
        setLiveErr(null)
      } catch (e) {
        if (!stop) setLiveErr(e instanceof Error ? e.message : String(e))
      }
    }
    void pull()
    const t = setInterval(() => void pull(), 2000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [liveOpen, server.id])

  // 贴底：只有使用者**本来就在底部**时才自动滚（否则会把他正在看的位置拽走）
  useEffect(() => {
    const el = liveBox.current
    if (!el || !stickBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [live])

  return (
    <div className="rounded-md border px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <Terminal className="h-3.5 w-3.5" />
        控制台（手动输指令）
        <Button variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-2 text-xs" onClick={() => setLiveOpen((v) => !v)}>
          {liveOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {liveOpen ? '收起实时后台' : '展开实时后台'}
        </Button>
      </div>
      <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
        ★ 这是**完整控制台**（RCON = op 级别：`op` / `ban` / `stop` 都能做）。
        只从本机网页进，**不进 QQ 工具面**。
      </p>
      <p className="text-muted-foreground mt-0.5 text-xs leading-relaxed">
        ★ **很多命令的应答是空的**（结果只进服务端日志）⇒ 「没看到回话」不代表没生效。
        下面的输出是**控制台的新增片段**，不保证只属于这一条命令。
      </p>

      <div className="mt-2 flex items-center gap-2">
        <input
          className="border-input bg-background h-8 flex-1 rounded-md border px-2 font-mono text-xs"
          placeholder={server.passwordSet ? '例如：time set day / list / forge tps' : '⚠️ 这台没配 RCON 密码，发不了命令'}
          value={command}
          disabled={busy || !server.passwordSet}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send()
          }}
        />
        <Button size="sm" disabled={busy || !command.trim() || !server.passwordSet} onClick={() => void send()}>
          {busy ? '发送中…' : '发送'}
        </Button>
      </div>
      {!server.passwordSet && (
        <p className="text-amber-600 mt-1 text-xs">⚠️ 没配 RCON 密码：没有命令通道（去 config.json 里填 `password`）</p>
      )}
      {err && <p className="text-destructive mt-1 text-xs">命令没跑成：{err}</p>}

      {/* ── 实时后台（折叠栏）：打开才轮询 ── */}
      {liveOpen && (
        <div className="mt-2">
          <div className="text-muted-foreground mb-1 flex flex-wrap items-center gap-x-3 text-[11px]">
            <span>服务端控制台输出（每 2 秒刷新）</span>
            {live?.encoding === 'gbk' && <span>编码：GBK（中文能正常显示）</span>}
            {live?.encoding === 'utf8' && <span>编码：UTF-8</span>}
            {live?.why && <span className="text-amber-600">{live.why}</span>}
          </div>
          <div
            ref={liveBox}
            onScroll={(e) => {
              const el = e.currentTarget
              // 距底 24px 内算"还在底部" ⇒ 继续自动贴底
              stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
            }}
            className="bg-muted/30 h-64 overflow-auto rounded border p-2 font-mono text-[11px] leading-relaxed"
          >
            {liveErr ? (
              <div className="text-destructive">读控制台失败：{liveErr}</div>
            ) : (live?.lines.length ?? 0) === 0 ? (
              <div className="text-muted-foreground">还没有输出（服务端没被本程序拉起过，或还没写过日志）</div>
            ) : (
              live?.lines.map((l, i) => (
                <div key={i} className="whitespace-pre-wrap break-all">
                  {l}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {log.length > 0 && (
        <div className="mt-2 space-y-2">
          {log
            .slice()
            .reverse()
            .map((entry, i) => (
              <div key={`${entry.at}-${i}`} className="rounded border bg-muted/30 p-2">
                <div className="font-mono text-xs">
                  <span className="text-muted-foreground">$</span> {entry.command}
                </div>
                {entry.reply ? (
                  <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs">{entry.reply}</pre>
                ) : (
                  <div className="text-muted-foreground mt-0.5 text-xs">（RCON 没有回话 —— 这很正常，看下面的日志）</div>
                )}
                {entry.output ? (
                  <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{entry.output}</pre>
                ) : (
                  <div className="text-muted-foreground mt-0.5 text-xs">（控制台这段时间没有新输出）</div>
                )}
                {entry.caveat && (
                  <div className="text-muted-foreground mt-1 flex items-start gap-1 text-[11px]">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{entry.caveat}</span>
                  </div>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
