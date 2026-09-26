import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog, FieldRow, InlineNote, NumInput, type ConfirmRequest } from '@/components/common'
import { api, ApiError, isNotImplemented, type InboxState, type MemoryEntry, type MemoryTree } from '@/lib/api'
import { getBool, getNum, getStr, isDangerousWorkspace } from '@/lib/config'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import {
  Brain,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  Images,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
  Users,
} from 'lucide-react'

/**
 * 记忆页签（CONFIG-UI.md §2.5）：记忆要能看、能改。
 * 三条必须做对的：
 *  ① 冲突检测：读文件记下 sha256，保存时原样回传；409 = 编辑期间被机器人改过了，
 *     给 [重新载入（丢弃我的修改）] / [仍然覆盖] 两个选择，能拿到 currentContent 就展示差异
 *  ② 保存后不需要重启（restartRequired 恒 false），不显示"需要重启"
 *  ③ 关掉 memory.enabled 时编辑器仍然能用，不灰掉
 */

function fmtBytes(n?: number): string {
  if (n === undefined) return ''
  if (n < 1024) return `${n} B`
  // 去掉多余的小数位：10 MB 而不是 10.0 MB
  const tidy = (v: number, unit: string) => `${Number(v.toFixed(1))} ${unit}`
  if (n < 1024 * 1024) return tidy(n / 1024, 'KB')
  return tidy(n / 1024 / 1024, 'MB')
}

function fmtMtime(iso?: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86400_000)} 天前`
}

/** 把树拍平成文件列表（目录递归一层层展开显示）。 */
function flatten(entries: MemoryEntry[], depth = 0): { entry: MemoryEntry; depth: number }[] {
  const out: { entry: MemoryEntry; depth: number }[] = []
  for (const e of entries) {
    out.push({ entry: e, depth })
    if (e.type === 'dir' && e.children) out.push(...flatten(e.children, depth + 1))
  }
  return out
}

// ── 演示数据 ────────────────────────────────────────────────────────────────

const DEMO_TREE: MemoryTree = {
  workspace: 'C:\\...\\workspace-qq',
  enabled: true,
  entries: [
    { path: 'MEMORY.md', type: 'file', size: 168, mtime: new Date(Date.now() - 120_000).toISOString() },
    {
      path: 'memory',
      type: 'dir',
      children: [
        { path: 'memory/private-100000001.md', type: 'file', size: 420, mtime: new Date(Date.now() - 3600_000).toISOString() },
        { path: 'memory/group-700000002.md', type: 'file', size: 96, mtime: new Date(Date.now() - 86400_000).toISOString() },
      ],
    },
  ],
  totalBytes: 684,
  note: '记忆由桥接按模型的提议落盘（模型提议、桥接校验后写入）。没有 memory/ 目录是正常的（按需创建）。',
}

const DEMO_CONTENT = '# 记忆索引\n\n- 管理员私聊：QQ 100000001（昵称"无忘远霞"）\n- 约定：戳一戳这类指令执行完不用再回一句"已收到"，直接做完就行\n'

const DEMO_INBOX: InboxState = {
  count: 3,
  totalBytes: 1_240_000,
  oldestMtime: Date.now() - 86400_000 * 2,
  files: [],
}

/** §2.5.1 的两种看图模式（界面形态照 §2.4 速度三档的大按钮）。 */
const IMAGE_MODES = [
  {
    value: 'on-demand' as const,
    label: '按需看（默认）',
    desc: '只把工作区路径交给模型，它自己决定要不要读。路径是纯文本，留在历史里几乎不花钱。',
    tone: 'text-emerald-700',
    dot: 'bg-emerald-500',
  },
  {
    value: 'auto' as const,
    label: '直接看图',
    desc: '更快更准，但每张图片都会计费——QQ 里大量是表情包，成本会明显上升。',
    tone: 'text-amber-700',
    dot: 'bg-amber-400',
  },
]

export function MemoryTab({
  cfg,
  patch,
  demo,
}: {
  cfg: Record<string, unknown>
  patch: (path: string, value: unknown) => void
  demo: boolean
}) {
  const workspace = getStr(cfg, 'dsh.workspace', 'workspace-qq')
  const memoryEnabled = getBool(cfg, 'memory.enabled', true)

  // ── 看图（§2.5.1）──
  const imageEnabled = getBool(cfg, 'image.enabled', true)
  const imageMode = getStr(cfg, 'image.mode', 'on-demand') === 'auto' ? 'auto' : 'on-demand'
  const imgMaxCount = getNum(cfg, 'image.maxCount', 4)
  const imgMaxBytes = getNum(cfg, 'image.maxBytes', 10485760)
  const imgRetentionHours = getNum(cfg, 'image.retentionHours', 72)
  const imgMaxTotalBytes = getNum(cfg, 'image.maxTotalBytes', 104857600)

  /** 切「直接看图」前必须确认一次（§2.5.1：表情包很多时成本会明显上升）。 */
  const chooseImageMode = (mode: 'on-demand' | 'auto') => {
    if (mode === 'auto' && imageMode !== 'auto') {
      setModeConfirm({
        title: '切到「直接看图」？',
        description: (
          <>
            这个模式<strong className="text-foreground">更快更准，但每张图片都会计费</strong>。
            QQ 里大量是表情包，表情包很多时成本会明显上升；而且图片会留在会话历史里，
            后面每一轮都重复计费。确定要切吗？
          </>
        ),
        confirmText: '我了解，切换',
        onConfirm: () => patch('image.mode', 'auto'),
      })
    } else {
      patch('image.mode', mode)
    }
  }

  const [tree, setTree] = useState<MemoryTree | null>(null)
  const [treePending, setTreePending] = useState(false) // 501：后端还没实现
  const [treeError, setTreeError] = useState<string | null>(null)
  const [treeLoading, setTreeLoading] = useState(true)

  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [sha, setSha] = useState<string | undefined>(undefined)
  const [fileMeta, setFileMeta] = useState<{ size: number; mtime?: string } | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const [newFileOpen, setNewFileOpen] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [deleteReq, setDeleteReq] = useState<ConfirmRequest | null>(null)
  const [conflict, setConflict] = useState<{
    currentSha256?: string
    currentContent?: string
  } | null>(null)

  // ── 看图（§2.5.1）──
  const [modeConfirm, setModeConfirm] = useState<ConfirmRequest | null>(null)
  const [inbox, setInbox] = useState<InboxState | null>(null)
  const [inboxLoading, setInboxLoading] = useState(false)

  const loadTree = useCallback(async () => {
    if (demo) {
      setTree(DEMO_TREE)
      setTreePending(false)
      setTreeError(null)
      setTreeLoading(false)
      setInbox(DEMO_INBOX)
      setInboxLoading(false)
      return
    }
    setTreeLoading(true)
    setInboxLoading(true)
    // inbox 状态与记忆树一起刷新；目录不存在不算错误（后端回 count:0）
    api
      .inbox()
      .then(setInbox)
      .catch(() => setInbox(null))
      .finally(() => setInboxLoading(false))
    try {
      setTree(await api.memoryTree())
      setTreePending(false)
      setTreeError(null)
    } catch (e) {
      setTree(null)
      if (isNotImplemented(e)) {
        setTreePending(true)
        setTreeError(null)
      } else {
        setTreePending(false)
        setTreeError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setTreeLoading(false)
    }
  }, [demo])

  useEffect(() => {
    loadTree()
  }, [loadTree])

  const openFile = useCallback(
    async (path: string) => {
      setSelected(path)
      setConflict(null)
      if (demo) {
        setContent(path === 'MEMORY.md' ? DEMO_CONTENT : '')
        setSha('demo-sha')
        setFileMeta({ size: 168, mtime: new Date().toISOString() })
        setDirty(false)
        return
      }
      setFileLoading(true)
      try {
        const f = await api.memoryRead(path)
        setContent(f.content)
        setSha(f.sha256) // 版本标识：保存时原样回传，不自己算
        setFileMeta({ size: f.size, mtime: f.mtime })
        setDirty(false)
      } catch (e) {
        if (isNotImplemented(e)) {
          toast.error('后端还没实现记忆文件接口。')
        } else {
          toast.error(e instanceof Error ? e.message : String(e))
        }
        setSelected(null)
      } finally {
        setFileLoading(false)
      }
    },
    [demo],
  )

  const doSave = useCallback(
    async (expectedSha256?: string) => {
      if (!selected) return
      if (demo) {
        toast.info('演示模式：不会真的保存。')
        setDirty(false)
        setConflict(null)
        return
      }
      setSaving(true)
      try {
        const r = await api.memoryWrite({ path: selected, content, expectedSha256 })
        setSha(r.sha256)
        setDirty(false)
        setConflict(null)
        // restartRequired 恒 false：记忆是模型运行时读的普通文件，改完立刻生效
        toast.success('已保存，立即生效（不需要重启）。')
        if (r.overwroteWithoutCheck) {
          toast.warning('这次保存没有做版本核对（缺少版本标识），请留意是否覆盖了机器人的写入。')
        }
        loadTree()
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          // ★ 最重要的分支：编辑期间被机器人改过了。不自动覆盖、也不自动丢弃。
          setConflict({
            currentSha256: e.payload?.currentSha256 as string | undefined,
            currentContent: e.payload?.currentContent as string | undefined,
          })
        } else if (isNotImplemented(e)) {
          toast.error('后端还没实现记忆文件接口。')
        } else {
          toast.error(e instanceof Error ? e.message : String(e))
        }
      } finally {
        setSaving(false)
      }
    },
    [selected, content, demo, loadTree],
  )

  // Ctrl+S 保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's' && selected && dirty) {
        e.preventDefault()
        doSave(sha)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, dirty, sha, doSave])

  const flatFiles = useMemo(() => (tree ? flatten(tree.entries) : []), [tree])

  const createFile = () => {
    // 只允许相对路径的 .md，越界判断交给后端（它不拼绝对路径）
    let name = newFileName.trim().replace(/\\/g, '/').replace(/^\/+/, '')
    if (!name) return
    if (!name.endsWith('.md')) name += '.md'
    if (name.includes('..') || /^[A-Za-z]:/.test(name)) {
      toast.error('路径不合法：只能是工作区内的相对路径。')
      return
    }
    setNewFileOpen(false)
    setNewFileName('')
    setSelected(name)
    setContent('')
    setSha(undefined) // 新文件没有版本标识
    setFileMeta(null)
    setDirty(true)
    setConflict(null)
  }

  const requestDelete = (path: string) => {
    setDeleteReq({
      title: `删除 ${path}？`,
      description: (
        <>
          这是机器人的<strong className="text-red-600">长期记忆</strong>
          ，删了它就真的不记得了。此操作不可撤销。
        </>
      ),
      confirmText: '删除',
      onConfirm: async () => {
        if (demo) {
          toast.info('演示模式：不会真的删除。')
          return
        }
        try {
          await api.memoryDelete(path)
          toast.success('已删除。')
          if (selected === path) {
            setSelected(null)
            setContent('')
            setSha(undefined)
            setDirty(false)
          }
          loadTree()
        } catch (e) {
          if (isNotImplemented(e)) {
            toast.error('后端还没实现删除接口。')
          } else {
            toast.error(e instanceof Error ? e.message : String(e))
          }
        }
      },
    })
  }

  return (
    <div className="space-y-4">
      {/* 记忆按人分开（§2.5）：归属说明 + 如实说明隔离强度 */}
      <InlineNote level="info">
        <Users className="mr-1 inline h-3.5 w-3.5" />
        记忆分<strong>两层</strong>：
        <strong>全局记忆</strong>（<code className="rounded bg-white/50 px-1">MEMORY.md</code>）
        —— <strong>对所有聊天生效</strong>（每个人的私聊 + 每个群）；
        以及<strong>本会话专属记忆</strong>（
        <code className="rounded bg-white/50 px-1">memory/private-QQ号.md</code>、
        <code className="rounded bg-white/50 px-1">memory/group-群号.md</code>）。
        全局是共享的，所以<strong>别把某人的私事写进去</strong>。
      </InlineNote>
      <InlineNote level="warn">
        隔离是靠<strong>提示词告诉模型只读自己那份</strong>实现的，不是文件系统层面的强制——
        模型有工作区里所有文件的读写权限（那是它干活的必要条件）。
        所以这是<strong>防误伤</strong>（避免它顺手混用），不是防恶意，别把它当成安全边界。
      </InlineNote>
      <InlineNote level="info">
        <strong>写入权已经收回到桥接</strong>：模型只能在回复里"提议"记什么
        （<code className="rounded bg-white/50 px-1">{'<<<MEMORY global|fact|slang|directive 内容>>>'}</code>），
        由桥接校验后落盘。三个后果你需要知道：
        <ul className="mt-1 list-disc pl-5">
          <li>
            <strong>这里手动改完会被回滚</strong>：桥接每次写入都留快照，读记忆前比对，
            不一致（说明有人绕过了桥接）就恢复成桥接那版。想在界面上改，需要先
            <strong>关掉记忆功能</strong>（<code className="rounded bg-white/50 px-1">memory.enabled</code>）再改。
          </li>
          <li>
            <strong>要跨会话共享就写 global</strong>：模型用{' '}
            <code className="rounded bg-white/50 px-1">global</code> 档写进{' '}
            <code className="rounded bg-white/50 px-1">MEMORY.md</code>（所有聊天可见）；
            只跟某个人/某个群有关的事走 <code className="rounded bg-white/50 px-1">fact</code>。
          </li>
          <li>
            <strong>行为指令另有单独一份</strong>：管理员在<strong>私聊</strong>里说的"以后遇到 X 就这样做"
            写进 <code className="rounded bg-white/50 px-1">memory/.directives.md</code>，跨群生效，
            且只有管理员能写。
          </li>
          <li>
            涉及「谁是管理员/有什么权限」的内容<strong>一律会被拒</strong>并在下一轮回执给模型 ——
            身份只由配置里的 <code className="rounded bg-white/50 px-1">access.adminUsers</code> 决定。
          </li>
        </ul>
      </InlineNote>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Brain className="h-4 w-4" />
            跨重启记忆
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          <FieldRow
            label="启用记忆"
            hint="关掉 = 不再提示机器人去读写笔记，但文件还在，下面照样能看能改。"
          >
            <Switch checked={memoryEnabled} onCheckedChange={(v) => patch('memory.enabled', v)} />
          </FieldRow>
          <FieldRow label="工作区目录" hint="记忆文件就存在这里。写相对路径则相对桥接包根目录。">
            <div className="space-y-2">
              <Input
                value={workspace}
                onChange={(e) => patch('dsh.workspace', e.target.value)}
                className="max-w-md font-mono text-sm"
                placeholder="workspace-qq"
              />
              {isDangerousWorkspace(workspace) && (
                <InlineNote level="danger">这等于把整个磁盘交给机器人，请换一个专用目录。</InlineNote>
              )}
            </div>
          </FieldRow>
        </CardContent>
      </Card>

      {/* ★ 看图（§2.5.1）：让机器人真的"看见"图片。
          能力一直都在（模型吃 image），桥接负责把图片下载到 <工作区>/inbox/ 再递进去。 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Images className="h-4 w-4" />
            看图
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            QQ 图片会被下载到工作区的 <code className="rounded bg-muted px-1">inbox/</code>，再交给模型。
            关掉 = 图片只显示成 <code className="rounded bg-muted px-1">[图片]</code>，且一次网络请求都不会发。
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm">
              <div className="font-medium">启用看图</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                关掉后下面的细项仍然能看能改，只是不会生效。
              </div>
            </div>
            <Switch checked={imageEnabled} onCheckedChange={(v) => patch('image.enabled', v)} />
          </div>

          {/* 模式大按钮（形态照 §2.4 速度三档） */}
          <div className="grid gap-3 sm:grid-cols-2">
            {IMAGE_MODES.map((m) => {
              const active = imageMode === m.value
              return (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => chooseImageMode(m.value)}
                  className={cn(
                    'rounded-lg border-2 p-4 text-left transition-all',
                    active ? 'border-primary bg-accent/60 shadow-sm' : 'border-border hover:border-primary/40',
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{m.label}</span>
                    <span className={cn('inline-block h-2.5 w-2.5 rounded-full', m.dot)} />
                  </div>
                  <div className={cn('mt-2 text-xs leading-relaxed', m.tone)}>{m.desc}</div>
                </button>
              )
            })}
          </div>
          {imageMode === 'on-demand' && (
            <p className="text-xs text-muted-foreground">
              为什么默认是「按需看」：QQ 里大量是表情包，「直接看图」等于每个表情包都花一次
              vision token，而且图片会留在会话历史里、后面每一轮都重复计费；「按需看」给的
              是纯文本路径，留在历史里几乎不花钱。
            </p>
          )}

          {/* 当前配置效果（实时） */}
          <InlineNote level="info">
            当前效果：单条最多 <strong>{imgMaxCount}</strong> 张 · 单张 ≤{fmtBytes(imgMaxBytes)} ·
            inbox {imgRetentionHours === 0 ? '不清理' : <>保留 <strong>{imgRetentionHours}</strong> 小时</>} / ≤{fmtBytes(imgMaxTotalBytes)}
          </InlineNote>

          {/* 现在的 inbox（小卡片） */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">现在的 inbox</span>
            {inboxLoading && !inbox ? (
              <span className="flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin" />
                正在读取…
              </span>
            ) : inbox ? (
              <>
                <span>{inbox.count} 个文件</span>
                <span>共 {fmtBytes(inbox.totalBytes)}</span>
                <span>
                  最旧：{inbox.oldestMtime ? fmtMtime(new Date(inbox.oldestMtime).toISOString()) : '—'}
                </span>
              </>
            ) : (
              <span>还没收到过图片（inbox 目录不存在）。</span>
            )}
          </div>

          {/* 具体参数 */}
          <details className="rounded-md border">
            <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground select-none">
              看图的具体参数（高级微调）
            </summary>
            <div className="grid gap-3 border-t px-3 py-3 sm:grid-cols-2">
              <FieldRow
                label="单条最多几张"
                hint="DSH 附件库单条上限 20，超过会被整批拒绝。"
                className="py-0 sm:grid-cols-[110px_1fr]"
              >
                <NumInput value={imgMaxCount} onChange={(n) => patch('image.maxCount', n)} unit="张" min={1} max={20} />
              </FieldRow>
              <FieldRow
                label="单张大小上限"
                hint="DSH 附件库单张上限 20MB，配更大没有意义。"
                className="py-0 sm:grid-cols-[110px_1fr]"
              >
                <NumInput value={imgMaxBytes} onChange={(n) => patch('image.maxBytes', n)} unit="字节" min={1024} max={20971520} />
              </FieldRow>
              <FieldRow label="下载超时" className="py-0 sm:grid-cols-[110px_1fr]">
                <NumInput
                  value={getNum(cfg, 'image.timeoutMs', 15000)}
                  onChange={(n) => patch('image.timeoutMs', n)}
                  unit="毫秒"
                  min={1000}
                />
              </FieldRow>
              <FieldRow
                label="重定向上限"
                hint="每一跳都会重新校验目标地址。"
                className="py-0 sm:grid-cols-[110px_1fr]"
              >
                <NumInput
                  value={getNum(cfg, 'image.maxRedirects', 3)}
                  onChange={(n) => patch('image.maxRedirects', n)}
                  unit="次"
                  min={0}
                  max={10}
                />
              </FieldRow>
              <FieldRow
                label="inbox 保留时长"
                hint="★ 这是唯一的清理机制；图片必须落在工作区内才能被读到，所以清理只能由桥接负责。填 0 = 不清理。"
                className="py-0 sm:grid-cols-[110px_1fr]"
              >
                <NumInput value={imgRetentionHours} onChange={(n) => patch('image.retentionHours', n)} unit="小时" min={0} />
              </FieldRow>
              <FieldRow
                label="inbox 总量上限"
                hint="超过就按最旧的开始删。"
                className="py-0 sm:grid-cols-[110px_1fr]"
              >
                <NumInput value={imgMaxTotalBytes} onChange={(n) => patch('image.maxTotalBytes', n)} unit="字节" min={0} />
              </FieldRow>
            </div>
          </details>

          <InlineNote level="warn">
            <strong>安全边界：</strong>这是本项目唯一一处「外部输入能指挥进程发网络请求」——
            图片地址来自消息发送者。后端已做硬限制：只许 http/https、逐跳校验重定向、
            拒绝内网与回环地址（含域名解析结果）、大小与超时上限。所以这里
            <strong>不提供</strong>任何自定义地址 / 放行内网 / 关闭校验的开关。
            已知边界：DNS 校验与真正连接之间存在一个极短的 rebinding 窗口，
            <strong>未完全防住</strong>。
          </InlineNote>
        </CardContent>
      </Card>

      {/* 文件树 + 编辑器 */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <FolderOpen className="h-4 w-4" />
              记忆文件{tree?.workspace ? `（${tree.workspace}）` : ''}
            </CardTitle>
            <div className="ml-auto flex items-center gap-1.5">
              {tree && (
                <span className="text-xs text-muted-foreground">共 {fmtBytes(tree.totalBytes)}</span>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => setNewFileOpen(true)}
                disabled={treePending}
              >
                <FilePlus2 className="mr-1 h-3.5 w-3.5" />
                新建 .md
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                title="浏览器无法直接打开文件管理器，点击复制目录路径"
                onClick={() => {
                  const p = tree?.workspace ?? workspace
                  navigator.clipboard
                    ?.writeText(p)
                    .then(() => toast.success('目录路径已复制，粘贴到文件管理器地址栏打开。'))
                    .catch(() => toast.info(p))
                }}
              >
                <FolderOpen className="mr-1 h-3.5 w-3.5" />
                打开记忆目录
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={loadTree}
                disabled={treeLoading}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', treeLoading && 'animate-spin')} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {treePending ? (
            <InlineNote level="info">
              记忆文件的后端接口还没实现（CONFIG-UI.md §5.3，目前返回 501）。
              接口落地后这里会出现文件树和编辑器，界面不用再改。现在想改记忆，
              直接用记事本打开工作区里的 <code className="rounded bg-muted px-1">MEMORY.md</code>。
            </InlineNote>
          ) : treeError ? (
            <InlineNote level="warn">{treeError}</InlineNote>
          ) : treeLoading && !tree ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在读取记忆目录…
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
              {/* 左：文件树 */}
              <div className="rounded-md border">
                {flatFiles.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-muted-foreground">
                    还没有记忆文件。机器人会在聊天中自己创建 MEMORY.md（按需）。
                  </div>
                ) : (
                  <ul className="py-1">
                    {flatFiles.map(({ entry, depth }) =>
                      entry.type === 'dir' ? (
                        <li key={entry.path} className="px-3 py-1.5" style={{ paddingLeft: 12 + depth * 16 }}>
                          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                            <Folder className="h-3.5 w-3.5" />
                            {entry.path.split('/').pop()}/
                            {(!entry.children || entry.children.length === 0) && (
                              <span className="text-xs">（空）</span>
                            )}
                          </span>
                        </li>
                      ) : (
                        <li key={entry.path}>
                          <button
                            type="button"
                            onClick={() => openFile(entry.path)}
                            className={cn(
                              'flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm hover:bg-accent',
                              selected === entry.path && 'bg-accent font-medium',
                            )}
                            style={{ paddingLeft: 12 + depth * 16 }}
                          >
                            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 flex-1 truncate font-mono text-xs">
                              {entry.path.split('/').pop()}
                            </span>
                            {/* 归属徽标：一眼看出这份记忆是谁的（§2.5 按人分开） */}
                            {(() => {
                              const name = entry.path.split('/').pop() ?? ''
                              const kind = name === 'MEMORY.md' ? '全局' : name.startsWith('private-') ? '私聊' : name.startsWith('group-') ? '群' : null
                              if (!kind) return null
                              return (
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    'shrink-0 px-1 py-0 text-[10px] font-normal',
                                    kind === '全局' && 'border-amber-300 text-amber-700',
                                    kind === '私聊' && 'border-sky-300 text-sky-600',
                                    kind === '群' && 'border-violet-300 text-violet-600',
                                  )}
                                >
                                  {kind}
                                </Badge>
                              )
                            })()}
                            <span className="shrink-0 text-[10px] text-muted-foreground">
                              {fmtBytes(entry.size)} {fmtMtime(entry.mtime)}
                            </span>
                          </button>
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </div>

              {/* 右：编辑器 */}
              <div className="min-w-0">
                {fileLoading ? (
                  <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在读取 {selected}…
                  </div>
                ) : selected ? (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{selected}</code>
                      {fileMeta?.mtime && (
                        <span className="text-xs text-muted-foreground">
                          最后修改 {fmtMtime(fileMeta.mtime)}
                        </span>
                      )}
                      {dirty && (
                        <Badge variant="outline" className="border-amber-400 text-amber-600">
                          未保存
                        </Badge>
                      )}
                      <div className="ml-auto flex gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
                          onClick={() => requestDelete(selected)}
                        >
                          <Trash2 className="mr-1 h-3.5 w-3.5" />
                          删除
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => doSave(sha)}
                          disabled={saving || !dirty}
                        >
                          {saving ? (
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Save className="mr-1 h-3.5 w-3.5" />
                          )}
                          保存
                        </Button>
                      </div>
                    </div>
                    <Textarea
                      value={content}
                      onChange={(e) => {
                        setContent(e.target.value)
                        setDirty(true)
                      }}
                      rows={14}
                      className="font-mono text-sm leading-relaxed"
                      placeholder="# 记在这里的内容，机器人下次读笔记时就会看到"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>保存后立即生效，不需要重启。</span>
                      <span className="tabular-nums">{[...content].length} 字 · Ctrl+S 保存</span>
                    </div>
                    {memoryEnabled && (
                      <InlineNote level="warn">
                        记忆功能现在是<strong>开着</strong>的：桥接管着写入权，
                        你在这里保存的内容<strong>可能在下一轮被回滚</strong>成桥接那版。
                        想手工改，先关掉上面的「启用记忆」再改；
                        或者直接在私聊里跟机器人说「这条记错了」，让桥接落成新条目。
                      </InlineNote>
                    )}
                  </div>
                ) : (
                  <div className="flex h-full min-h-32 items-center justify-center rounded-md border border-dashed px-4 text-center text-xs text-muted-foreground">
                    从左边选一个文件查看或编辑；也可以新建一个 .md。
                  </div>
                )}
              </div>
            </div>
          )}
          {tree?.note && <p className="mt-3 text-xs text-muted-foreground">{tree.note}</p>}
        </CardContent>
      </Card>

      {/* 必须解释清楚的四件事（§2.5；第 3 条是"桥接托管记忆"改造后新增的必须告知项） */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">关于记忆，四件事</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm leading-relaxed text-muted-foreground">
          <p>
            <strong className="text-foreground">1. 记忆存在哪：</strong>
            不是数据库，是普通文件——
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">&lt;工作区&gt;/MEMORY.md</code>
            （指令档，跨群）和
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">&lt;工作区&gt;/memory/</code>
            （按人/按群的细节，按需创建）。现在<strong className="text-foreground">由桥接按模型的提议落盘</strong>
            ，不再由模型直接写。重启不丢。
          </p>
          <p>
            <strong className="text-foreground">2. 换工作区 = 换记忆：</strong>
            旧记忆留在旧目录里，不会跟过来。
          </p>
          <p>
            <strong className="text-foreground">3. 手动改会被回滚：</strong>
            桥接每次写入都留快照（
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5 text-xs">memory/.snapshots/</code>
            ），读记忆前比对；不一致——无论是模型绕过协议改的、还是
            <strong className="text-foreground">你在这个界面里改的</strong>——都会恢复成桥接那一版。
            想手工编辑，<strong className="text-foreground">先关掉上面的「启用记忆」再改</strong>。
          </p>
          <p>
            <strong className="text-foreground">4. 改这里等于直接改机器人的长期记忆：</strong>
            它是修正错误记忆的入口；但因为第 3 条，<strong className="text-foreground">推荐做法是
            管理员在私聊里用自然语言纠正</strong>（「别记那个了」「这条记错了」）——
            桥接会落成新条目，而不是手工覆盖文件。
          </p>
        </CardContent>
      </Card>

      {/* 新建文件 */}
      <Dialog open={newFileOpen} onOpenChange={setNewFileOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建记忆文件</DialogTitle>
            <DialogDescription>
              相对工作区的路径，只允许 .md。模型将来可能按人分文件（如 memory/private-QQ号.md），你也可以自己加。
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            placeholder="memory/我的笔记.md"
            className="font-mono text-sm"
            onKeyDown={(e) => e.key === 'Enter' && createFile()}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFileOpen(false)}>
              取消
            </Button>
            <Button onClick={createFile} disabled={!newFileName.trim()}>
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 409 冲突：编辑期间被机器人改过了 */}
      <Dialog open={!!conflict} onOpenChange={(o) => !o && setConflict(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-amber-600">这份记忆在你编辑期间被机器人改过了</DialogTitle>
            <DialogDescription>
              机器人随时可能在写记忆。直接保存会把它刚写的内容覆盖掉——那份记忆就此消失，没有任何提示。
            </DialogDescription>
          </DialogHeader>
          {conflict?.currentContent !== undefined && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">磁盘上的当前内容（机器人写的）</div>
                <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 text-xs whitespace-pre-wrap">
                  {conflict.currentContent}
                </pre>
              </div>
              <div>
                <div className="mb-1 text-xs font-medium text-muted-foreground">你的修改（还没保存）</div>
                <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 text-xs whitespace-pre-wrap">
                  {content}
                </pre>
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setConflict(null)}>
              先不处理
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                // 重新载入：丢弃我的修改，采用磁盘上的内容与新版本标识
                if (conflict?.currentContent !== undefined) {
                  setContent(conflict.currentContent)
                  setSha(conflict.currentSha256)
                  setDirty(false)
                  setConflict(null)
                } else if (selected) {
                  setConflict(null)
                  openFile(selected)
                }
              }}
            >
              重新载入（丢弃我的修改）
            </Button>
            <Button
              variant="destructive"
              onClick={() => doSave(conflict?.currentSha256 ?? sha)}
              disabled={saving}
            >
              仍然覆盖
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog req={deleteReq} onClose={() => setDeleteReq(null)} />
      <ConfirmDialog req={modeConfirm} onClose={() => setModeConfirm(null)} />
    </div>
  )
}
