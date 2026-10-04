import { useState } from 'react'
import { Button } from '@/components/ui/button'

import { api, type ServerRow } from '@/lib/api'

/**
 * 服务器条目的**新增 / 编辑**表单（0.3.2 收尾）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么这个表单必须存在（用户的原话：「主服似乎锁死在 UI 中」）
 * ══════════════════════════════════════════════════════════════════════════
 * 在它之前，`servers` 只能手改 `config.json`，而且**改完要重启桥接**才生效 ——
 * 于是"我之后换了服务器怎么办"这件事没有答案。现在：改完**即时生效**
 * （后端重建监测循环，不必重启桥接、不断 QQ、不打断在跑的回合）。
 *
 * ★★★ `id` 是**状态文件的键**（`runtime/servers/<id>.running.json` / `events.jsonl` /
 *   `<id>.restart.json`）。所以：
 *   · 改 `id` 等于"换了一台新的"（旧的归属证据与台账留在旧 id 下，不会串味）；
 *   · 如果只是**把地址换成另一台机器**而 `id` 不变，旧归属档还在 —— 那种情况下
 *     归属判定会拿旧 pid 去比新机器。∴ 表单里明说：**换机器请换个 id**。
 *
 * ★ 密码：留空 = **不改**（编辑时）；新建时留空 = 没配（那时发不了控制台命令）。
 *   界面**永不回显**已有密码（后端只给 `passwordSet` 布尔）。
 */
export function ServerForm({
  server,
  onClose,
  onSaved,
}: {
  /** 传 null = 新建；传一台 = 编辑 */
  server: ServerRow | null
  onClose: () => void
  onSaved: () => void
}) {
  const editing = Boolean(server)
  const [form, setForm] = useState({
    id: server?.id ?? '',
    name: server?.name ?? '',
    host: server?.host ?? '127.0.0.1',
    port: String(server?.port ?? 25565),
    rconPort: String(server?.rconPort ?? 25575),
    // ★ 编辑时留空 = 不改密码（界面拿不到原密码，也**不该**拿）
    password: '',
    tpsCommand: server?.tpsCommand ?? '',
    startExe: server?.startExe ?? '',
    startArgs: '',
    cwd: '',
    manageOnStart: server?.manageOnStart ?? false,
    // ★ 0.3.2 P3：游戏内对话（默认关 —— "无人开口就动手/就听"的能力默认关）
    gameChat: server?.gameChat ?? false,
    enabled: server?.enabled !== false,
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const set = (k: keyof typeof form, v: string | boolean) => setForm((prev) => ({ ...prev, [k]: v }))

  const submit = async () => {
    setBusy(true)
    setErr(null)
    setNotice(null)
    try {
      const payload: Record<string, unknown> = {
        id: form.id.trim(),
        name: form.name.trim() || form.id.trim(),
        host: form.host.trim() || '127.0.0.1',
        port: Number(form.port) || 25565,
        rconPort: Number(form.rconPort) || 25575,
        tpsCommand: form.tpsCommand.trim(),
        enabled: form.enabled,
        manageOnStart: form.manageOnStart,
        gameChat: form.gameChat,
      }
      // ★ 密码：**只在填了的时候才送**（留空 = 不改），否则会把已有密码抹成空串
      if (form.password) payload.password = form.password
      if (form.startExe.trim()) {
        payload.startExe = form.startExe.trim()
        payload.startArgs = form.startArgs
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)
      }
      if (form.cwd.trim()) payload.cwd = form.cwd.trim()

      const r = await api.serversSave(payload)
      if (r.applied?.ok === false) {
        // ★ 配置写进去了、但**没生效** —— 如实说（不假装成功）
        setNotice(`已保存，但**没生效**：${r.applied.why ?? '未知原因'}（可能要重启桥接）`)
      } else {
        setNotice(r.created ? '已新增，并已即时生效（不必重启桥接）' : '已保存，并已即时生效（不必重启桥接）')
      }
      onSaved()
      // 留 1.2 秒让使用者看到那句"已生效"，然后关掉
      setTimeout(onClose, 1200)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const field = (label: string, key: keyof typeof form, hint?: string, type = 'text') => (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        className="border-input bg-background mt-0.5 h-8 w-full rounded-md border px-2 font-mono text-xs"
        type={type}
        value={String(form[key])}
        disabled={busy}
        onChange={(e) => set(key, e.target.value)}
      />
      {hint && <span className="text-muted-foreground mt-0.5 block text-[11px]">{hint}</span>}
    </label>
  )

  return (
    <div className="rounded-md border p-3">
      <div className="text-sm font-medium">{editing ? `编辑：${server?.name}` : '新增一台服务器'}</div>
      <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
        ★ 保存后**即时生效**（后端会让监测循环按新列表重启），**不必重启桥接**。
        <br />★ **`id` 是状态文件的键**：换了服务端（地址不同）请**同时换个 id**，
        否则旧的归属档还挂在这个 id 上，归属判定会失真。
        <br />★ 编辑时**密码留空 = 不改**（界面拿不到原密码，也不该拿）。
      </p>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {field('id（**换了服务端就换个 id**）', 'id', '文件安全字符：[a-zA-Z0-9_.-]，会成为 runtime/servers/<id>.* 的文件名')}
        {field('名字（界面上显示）', 'name')}
        {field('地址 host', 'host')}
        {field('游戏端口 port', 'port')}
        {field('RCON 端口 rconPort', 'rconPort')}
        {field('RCON 密码（留空 = 不改）', 'password', editing && server?.passwordSet ? '这台已配密码（不回显）；填了才会覆盖' : '要与服务端 server.properties 里的 rcon.password 一致', 'password')}
        {field('TPS 命令（留空 = 不问）', 'tpsCommand', '例如 Forge：forge tps；Paper：tps。留空表示**我们不问**，不是"问了没拿到"')}
        {field('启动可执行文件 startExe（推荐）', 'startExe', '不走 shell ⇒ 归属可判定；相对路径按 cwd 解析')}
        {field('启动参数（一行一个）', 'startArgs', '配合 startExe，例如 @user_jvm_args.txt / nogui')}
        {field('工作目录 cwd', 'cwd', '启动命令在哪个目录执行（通常是服务端根目录）')}
      </div>

      <label className="mt-2 flex items-center gap-2 text-xs">
        <input type="checkbox" checked={form.enabled} disabled={busy} onChange={(e) => set('enabled', e.target.checked)} />
        启用这台（停用 = 不监测、不发任何请求）
      </label>
      <label className="mt-1 flex items-center gap-2 text-xs">
        <input type="checkbox" checked={form.manageOnStart} disabled={busy} onChange={(e) => set('manageOnStart', e.target.checked)} />
        启动接管（桥接启动时接管已在跑的、或拉起没在跑的；**端口活着时绝不重复拉起**）
      </label>
      <label className="mt-1 flex items-start gap-2 text-xs">
        <input
          className="mt-0.5"
          type="checkbox"
          checked={form.gameChat}
          disabled={busy}
          onChange={(e) => set('gameChat', e.target.checked)}
        />
        <span>
          游戏内对话（读这台服的控制台，让**已绑定 UUID↔QQ** 的玩家在游戏里跟小鲸鱼说话）
          <span className="text-muted-foreground mt-0.5 block text-[11px]">
            ★ 回复走**公屏**，而且看起来就是 <code>&lt;小鲸鱼&gt; 正文</code> 一行普通发言
            （**不高亮**、默认白色，模仿正常玩家）；**未绑定的玩家一进服**就会收到一条只给他本人的
            <code>tellraw</code>，让他去游戏里说 <code>\mc bind</code>（**反斜杠** —— 斜杠会被服务端当命令、
            我们看不到）拿码，再到群里发 <code>@我 \mc bind 码</code>（**每次进服最多一次**）。
            <br />★ 未绑定的人**之后说什么都不回**（不能确定他在跟小鲸鱼说话）；
            **绑定之后**在游戏里叫它（<code>小鲸鱼</code>/<code>小鱼</code>）就会收到回复。
            <br />★ **绑定即能说话**（不必再把他加进私聊白名单）；但权限仍按管理员表 ——
            非管理员在游戏里只是**只读用户**。
            <br />★ 只有**本程序拉起**的服务端才有那个控制台日志 —— 别人手动起的服读不到东西
            （日志里会有一行说明，**不是故障**）。
            <br />★ 权限**按绑定的那个 QQ** 判：那个 QQ 不在名单里，游戏里也说不上话。
          </span>
        </span>
      </label>

      {err && <p className="text-destructive mt-2 text-xs">保存失败：{err}</p>}
      {notice && <p className="mt-2 text-xs text-emerald-600">{notice}</p>}

      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" disabled={busy || !form.id.trim()} onClick={() => void submit()}>
          {busy ? '保存中…' : '保存'}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
          取消
        </Button>
      </div>
    </div>
  )
}
