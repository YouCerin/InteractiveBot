import { useEffect, useState } from 'react'
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
 * ★ 密码**三种意图**（缺一条都不行；2026-10-04 真事故的正中央）：
 *   · **留空 = 不改**（编辑时；界面拿不到原密码，也**不该**拿）；
 *   · **填了 = 覆盖**；
 *   · **勾"清除" = 删掉它**（送 `null` —— 后端只认这个形状，见 `api.mjs` 的
 *     `resolveServerPassword`）。
 *
 * ★★★ 为什么必须有一个**显式的清除入口**：后端把"空串"定义成**保留原值**
 *   （因为界面回传时密码框本来就是空的，把空串当清除就等于**每保存一次丢一次密码**
 *   —— 那就是真事故：用户的 RCON 密码被静默抹掉，控制台突然说"没配密码"）。
 *   于是"清除"这条语义只能由 `null` 表达，而它在界面上**必须有地方可点** ——
 *   否则想删密码的人只能去手改 `config.json`，而那正是这个表单存在的理由。
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
  /** 这台已经有密码（后端只给布尔，不给值）—— "清除"那个勾只在有东西可清时才出现 */
  const hasStoredPassword = editing && server?.passwordSet === true
  const [form, setForm] = useState({
    id: server?.id ?? '',
    name: server?.name ?? '',
    host: server?.host ?? '127.0.0.1',
    port: String(server?.port ?? 25565),
    rconPort: String(server?.rconPort ?? 25575),
    // ★ 编辑时留空 = 不改密码（界面拿不到原密码，也**不该**拿）
    password: '',
    /** ★ 勾上 = **删掉**已保存的密码（送 `null`）。默认不勾 —— 破坏性动作不许是默认值 */
    clearPassword: false,
    tpsCommand: server?.tpsCommand ?? '',
    startExe: server?.startExe ?? '',
    startArgs: '',
    cwd: '',
    manageOnStart: server?.manageOnStart ?? false,
    // ★ 0.3.2 P3：游戏内对话（默认关 —— "无人开口就动手/就听"的能力默认关）
    gameChat: server?.gameChat ?? false,
    /**
     * ★★★ 允许从 QQ 下控制台指令（默认关）。
     *
     * ★ 为什么它必须在这里（2026-10-04 使用者报的）：「我应该是打开的才对」——
     *   他确实开过，而这个表单**以前没有这一项**，后端又是"整条替换" ⇒
     *   他每点一次保存就被重置成 `false`，界面上没有任何地方能看出来，
     *   只能照 bot 说的去手改 `config.json`（改完再保存又被抹掉）。
     * ★ 它与 `gameChat` 是**两条路**，说明写在界面上（见下面那个勾选框的注解）。
     */
    commandFromQQ: server?.commandFromQQ ?? false,
    enabled: server?.enabled !== false,
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /**
   * 服务端 `server.properties` 的 RCON 状态（0.3.2 收尾）。
   * ★ `patch.enableRcon` 初值取**读到的状态**（读不到就默认勾上 —— 使用者的意图几乎总是"我要用"）。
   * ★ `patch.password` 永远从空开始：**不回显已有密码**（与 `servers[].password` 同一条纪律）。
   */
  const [rcon, setRcon] = useState({
    loading: false,
    busy: false,
    err: null as string | null,
    note: '',
    info: null as Awaited<ReturnType<typeof api.serversProperties>> | null,
    patch: { enableRcon: true, rconPort: String(server?.rconPort ?? 25575), password: '' },
  })

  const loadRcon = async () => {
    if (!server?.id) return
    setRcon((p) => ({ ...p, loading: true, err: null }))
    try {
      const info = await api.serversProperties(server.id)
      setRcon((p) => ({
        ...p,
        loading: false,
        info,
        patch: {
          // 读得到就照实回填；`enableRcon === null`（文件里没这一项）⇒ 默认勾上
          enableRcon: info.settings.enableRcon !== false,
          // ★ 端口**以本桥接这份配置为准**（那是使用者对"这台服该用哪个端口"的声明），
          //   文件里那个值显示在"当前"那一行里。理由是真机上真发生过：两台服的文件都写着
          //   25575，而本桥接给第二台配的是 25576 —— 若按文件回填，一键修好会让两台抢同一个端口。
          rconPort: String(server?.rconPort ?? info.settings.rconPort ?? 25575),
          password: '', // 永不回显
        },
      }))
    } catch (e) {
      setRcon((p) => ({ ...p, loading: false, err: e instanceof Error ? e.message : String(e), info: null }))
    }
  }

  useEffect(() => {
    void loadRcon()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server?.id])

  /**
   * 「密码忘了 ⇒ 把服务端那份抄过来」（零重启对齐两边）。
   * ★ 界面上**看不到那个密码**，也不需要看到 —— 这是这条路存在的全部意义。
   */
  const adoptRcon = async () => {
    if (!server?.id) return
    setRcon((p) => ({ ...p, busy: true, note: '', err: null }))
    try {
      const r = await api.serversRconAdopt(server.id)
      setRcon((p) => ({
        ...p,
        busy: false,
        note: `${r.note}（抄到：密码${r.adopted.password ? '✓' : '—'}${r.adopted.rconPort ? ` · 端口 ${r.adopted.rconPort}` : ''}；本桥接配置${r.applied?.ok ? '已生效' : `**没生效**：${r.applied?.why ?? '未知'}`}）`,
      }))
      await loadRcon()
    } catch (e) {
      setRcon((p) => ({ ...p, busy: false, err: e instanceof Error ? e.message : String(e) }))
    }
  }

  const applyRcon = async () => {    if (!server?.id) return
    setRcon((p) => ({ ...p, busy: true, note: '' }))
    try {
      const r = await api.serversPropertiesApply({
        serverId: server.id,
        enableRcon: rcon.patch.enableRcon,
        rconPort: Number(rcon.patch.rconPort) || undefined,
        ...(rcon.patch.password ? { password: rcon.patch.password } : {}),
        syncToConfig: true,
      })
      const syncTxt = r.synced ? (r.synced.ok ? '已同步进本桥接的配置。' : `⚠️ 同步进配置失败：${r.synced.why}`) : ''
      setRcon((p) => ({ ...p, busy: false, note: `${r.note} 改了：${r.changed.join('、') || '（无变化）'}。${syncTxt}`, patch: { ...p.patch, password: '' } }))
      await loadRcon()
    } catch (e) {
      setRcon((p) => ({ ...p, busy: false, err: e instanceof Error ? e.message : String(e) }))
    }
  }

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
        // ★★ 这个字段**必须一起送**：不送的话（旧版就是这样）后端按默认值 `false` 处理，
        //   用户每保存一次就把这个开关关掉一次，而且界面上完全看不出来。
        commandFromQQ: form.commandFromQQ,
      }
      // ★★★ 密码的三种意图 —— 三条分支缺一不可（2026-10-04 真事故的正中央）：
      //   · 勾了"清除" ⇒ 送 `null`（后端把它当**显式清除**）
      //   · 填了新的   ⇒ 送新值（覆盖）
      //   · 两者都没有 ⇒ **不带这个字段**（后端按"保留原值"处理）
      // 为什么"空串"不能代表清除：它已经被"不改"这条语义占用了 —— 界面拿不到原密码，
      // 绝大多数保存时密码框本来就是空的，把空串当清除就是**每保存一次丢一次密码**。
      if (form.clearPassword) payload.password = null
      else if (form.password) payload.password = form.password
      if (form.startExe.trim()) {
        payload.startExe = form.startExe.trim()
        // ★★ 参数**只在填了的时候才送**（留空 = 不改）。旧版无条件送 `[]`，
        //   而这个框**不回填**已有参数 ⇒ 用户打开表单直接点保存就**把真实参数清空了**
        //   （`@user_jvm_args.txt` / `nogui` 这些）。那是与密码同一类静默数据丢失。
        //   ⚠️ 代价如实说：因此**界面上清不掉**已有参数，要清得改 config.json。
        if (form.startArgs.trim()) {
          payload.startArgs = form.startArgs
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        }
      }
      if (form.cwd.trim()) payload.cwd = form.cwd.trim()

      const r = await api.serversSave(payload)
      if (r.applied?.ok === false) {
        // ★ 配置写进去了、但**没生效** —— 如实说（不假装成功）
        setNotice(`已保存，但**没生效**：${r.applied.why ?? '未知原因'}（可能要重启桥接）`)
      } else if (form.clearPassword) {
        // ★ 清除是**破坏性动作**，回执必须说清代价（否则用户下次会以为"桥接坏了"：
        //   控制台发不了命令、优雅停服也没了）
        setNotice('已保存，RCON 密码已清除。⚠️ 这台服的控制台命令与"优雅停服"都用不了了 —— 要用就去 server.properties 里拿一个填回来。')
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

  const field = (label: string, key: keyof typeof form, hint?: string, type = 'text', disabled = false) => (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        className="border-input bg-background mt-0.5 h-8 w-full rounded-md border px-2 font-mono text-xs disabled:opacity-50"
        type={type}
        value={String(form[key])}
        disabled={busy || disabled}
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
        <br />★ 编辑时**密码留空 = 不改**（界面拿不到原密码，也不该拿）；
        想**删掉**已保存的密码，勾密码框下面那个「清除已保存的密码」——
        它和后端约定的是 `null`，而不是空串（空串的语义是"不改"）。
        <br />★ **没在这个表单里出现的字段一律保持原样**（`failThreshold`、`logEncoding`、
        监测阈值…）—— 保存是**按字段改**，不是把整条覆盖掉。留空的框同理：
        **留空 = 不改**，不是"清空"。
      </p>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {field('id（**换了服务端就换个 id**）', 'id', '文件安全字符：[a-zA-Z0-9_.-]，会成为 runtime/servers/<id>.* 的文件名')}
        {field('名字（界面上显示）', 'name')}
        {field('地址 host', 'host')}
        {field('游戏端口 port', 'port')}
        {field('RCON 端口 rconPort', 'rconPort')}
        {/* ★★★ 密码这一格**不走 `field()`** —— 它下面要挂一个"清除"的勾，
            而 `<label>` 里再套一个 `<label>` 会让点击行为错乱（点勾选框会去聚焦输入框）。 */}
        <div className="block text-xs">
          <span className="text-muted-foreground">RCON 密码{editing ? '（留空 = 不改）' : ''}</span>
          <input
            className="border-input bg-background mt-0.5 h-8 w-full rounded-md border px-2 font-mono text-xs disabled:opacity-50"
            type="password"
            value={form.password}
            disabled={busy || form.clearPassword}
            onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value, clearPassword: false }))}
          />
          {hasStoredPassword && (
            <label className="mt-1 flex items-start gap-2 text-[11px]">
              <input
                className="mt-0.5"
                type="checkbox"
                checked={form.clearPassword}
                disabled={busy}
                // ★ 勾上就把输入框里可能已经敲了一半的值清掉：两种意图不许同时成立
                onChange={(e) => setForm((prev) => ({ ...prev, clearPassword: e.target.checked, password: '' }))}
              />
              <span>
                清除已保存的密码
                <span className="text-muted-foreground block">
                  ★ 清掉之后这台服的**控制台命令**（含 `\mc` 那条通道）与**优雅停服**都用不了 ——
                  只是"停用"请用上面的「启用这台」勾选框，别用这个。
                </span>
              </span>
            </label>
          )}
          <span className="text-muted-foreground mt-0.5 block text-[11px]">
            {hasStoredPassword
              ? '这台已配密码（**不回显**）；留空 = 不改，填了 = 覆盖'
              : '要与服务端 server.properties 里的 rcon.password 一致；留空 = 没配（那时发不了控制台命令）'}
          </span>
        </div>
        {field('TPS 命令（留空 = 不问）', 'tpsCommand', '例如 Forge：forge tps；Paper：tps。留空表示**我们不问**，不是"问了没拿到"')}
        {field('启动可执行文件 startExe（推荐）', 'startExe', '不走 shell ⇒ 归属可判定；相对路径按 cwd 解析')}
        {field('启动参数（一行一个；**留空 = 不改**）', 'startArgs', '配合 startExe，例如 @user_jvm_args.txt / nogui。★ 这里**不回填**已有参数，所以留空表示"别动它"（要清空得改 config.json）')}
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
            我们看不到）拿码，再到群里**直接发** <code>\mc bind 码</code>（**不用 @ 我**；**每次进服最多一次**）。
            <br />★ 未绑定的人**之后说什么都不回**（不能确定他在跟小鲸鱼说话）；
            **绑定之后**在游戏里叫它（<code>小鲸鱼</code>/<code>小鱼</code>）就会收到回复。
            <br />★ **绑定即能说话**（不必再把他加进私聊白名单）；但权限仍按管理员表 ——
            非管理员在游戏里只是**只读用户**。
            <br />★ 只有**本程序拉起**的服务端才有那个控制台日志 —— 别人手动起的服读不到东西
            （日志里会有一行说明，**不是故障**）。
            <br />★ 权限**按绑定的那个 QQ** 判：那个 QQ 不在名单里，游戏里也说不上话。
            <br />★★ **游戏内只能"说话"，发不了指令** —— 想从 QQ 下指令看下面那个开关
            （那是**另一条路**，与这里无关）。
          </span>
        </span>
      </label>
      {/* ★★★ 允许从 QQ 下指令（0.3.2 收尾）。位置刻意放在 `gameChat` **下面并紧跟**，
          因为使用者问过「这个开关跟在游戏内发布指令有何关系」—— 答案是**没关系**，
          所以界面必须把两条路的边界摆在同一个视野里，别让他再猜一次。 */}
      <label className="mt-1 flex items-start gap-2 text-xs">
        <input
          className="mt-0.5"
          type="checkbox"
          checked={form.commandFromQQ}
          disabled={busy}
          onChange={(e) => set('commandFromQQ', e.target.checked)}
        />
        <span>
          允许管理员下控制台指令（op 级别；**默认关**）
          <span className="text-muted-foreground mt-0.5 block text-[11px]">
            ★★★ 这个开关管**所有"让 bot 去动服务端"的入口**，一共三条：
            <br />· **群里**发 <code>\mc [id] &lt;命令&gt;</code>（桥接本地拦截执行，不经模型）；
            <br />· 模型调 <code>mc_command</code> 工具（QQ 群/私聊里都行，只要说话人是管理员）；
            <br />· **游戏内**：绑定到**管理员 QQ** 的玩家在服里叫它 —— 他那一轮走的就是这个 QQ 的
            会话，所以**他也能让它去查 TPS / 人数**。绑到普通 QQ 的玩家不行
            （桥接只给管理员写授权）。
            <br />★ 与上面「游戏内对话」的分工：那个开关决定「**听不听**游戏里的人说话」（只有对白）；
            这个开关决定「**动不动**服务端」（op 级别）。两个都开，游戏内的管理员才查得了 TPS。
            <br />★ 两条**已知并接受**的代价：① <code>op</code> 可提权 ⇒ 命令白名单**事实上失效**；
            ② **管理员 QQ 被盗 = 服务器 op 被劫持**。想更保守就别开它，
            只用本机网页那个控制台（服务器页签里）。
          </span>
        </span>
      </label>

      {err && <p className="text-destructive mt-2 text-xs">保存失败：{err}</p>}
      {notice && <p className="mt-2 text-xs text-emerald-600">{notice}</p>}

      {/* ── 服务端自己的 server.properties（0.3.2 收尾）──────────────────────────
          起因（使用者 2026-10-04）：「开服时显示 enable-rcon=false，能否在桥接的编辑栏
          直接修改」—— 在那之前我们只能指路（"去 server.properties 里开 enable-rcon=true"）。
          ★ 三条在这一屏里必须说清（否则使用者会以为"点了就生效"）：
            ① 改的是**哪个文件**（路径显示出来，还说明是从哪推出来的）；
            ② **只改那三行**，其余逐字保留（写前备份、写前重读做乐观并发检查）；
            ③ **要重启服务端才生效**（那三项是它**启动时**读进内存的）。
          ★ 只在"编辑一台已有服务器"时出现：新增时还没有可解析的目录（归属档/`cwd`）。 */}
      {editing && (
        <div className="mt-3 rounded-md border p-3">
          <div className="text-xs font-medium">
            服务端的 RCON（直接改它的 <code>server.properties</code>）
          </div>
          {rcon.loading && <p className="text-muted-foreground mt-1 text-[11px]">正在读…</p>}
          {rcon.err && (
            <p className="text-destructive mt-1 text-[11px] leading-relaxed">
              读不出来：{rcon.err}
              <br />
              <span className="text-muted-foreground">
                → 先在下面那个「**工作目录 cwd**」里填上这台服的**服务端根目录**
                （`server.properties` 就在那儿），保存后再回来看这一块。
              </span>
            </p>
          )}
          {rcon.info && (
            <>
              <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">
                当前：<b>{rcon.info.describe}</b>
                <br />
                文件：<code className="break-all">{rcon.info.path}</code>
                <br />
                （路径来自{rcon.info.from}）
                {(rcon.info.mismatch.port || rcon.info.mismatch.password) && (
                  <>
                    <br />
                    <span className="text-amber-600">
                      ⚠️ 它和本桥接这份配置**对不上**
                      {rcon.info.mismatch.port
                        ? `（端口：文件里 ${rcon.info.settings.rconPort ?? '—'} vs 这里 ${rcon.info.configRconPort ?? '—'}）`
                        : ''}
                      {rcon.info.mismatch.password
                        ? `（密码：文件里${rcon.info.settings.passwordSet ? '已设置' : '是空的'} vs 这里${rcon.info.configPasswordSet ? '已配置' : '没配'}）`
                        : ''}
                      —— 两边不一致时 RCON 照样连不上。
                    </span>
                  </>
                )}
              </p>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="flex items-center gap-1.5 text-[11px]">
                  <input
                    type="checkbox"
                    checked={rcon.patch.enableRcon}
                    disabled={rcon.busy}
                    onChange={(e) => setRcon((p) => ({ ...p, patch: { ...p.patch, enableRcon: e.target.checked } }))}
                  />
                  打开 <code>enable-rcon</code>
                </label>
                <label className="text-[11px]">
                  <span className="text-muted-foreground mr-1">rcon.port</span>
                  <input
                    className="border-input bg-background h-7 w-24 rounded-md border px-2 font-mono text-[11px]"
                    value={rcon.patch.rconPort}
                    disabled={rcon.busy}
                    onChange={(e) => setRcon((p) => ({ ...p, patch: { ...p.patch, rconPort: e.target.value } }))}
                  />
                </label>
                <label className="text-[11px]">
                  <span className="text-muted-foreground mr-1">rcon.password</span>
                  <input
                    className="border-input bg-background h-7 w-40 rounded-md border px-2 font-mono text-[11px]"
                    type="text"
                    placeholder={rcon.info.settings.passwordSet ? '（已设置；留空 = 不改）' : '设一个（不能留空）'}
                    value={rcon.patch.password}
                    disabled={rcon.busy}
                    onChange={(e) => setRcon((p) => ({ ...p, patch: { ...p.patch, password: e.target.value } }))}
                  />
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rcon.busy}
                  onClick={() => {
                    // 随机密码**在浏览器里生成**（不新增接口；`enable-rcon` 要密码非空）
                    const bytes = new Uint8Array(12)
                    crypto.getRandomValues(bytes)
                    const rand = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16)
                    setRcon((p) => ({ ...p, patch: { ...p.patch, password: p.patch.password || rand } }))
                  }}
                >
                  随机密码
                </Button>
                <Button size="sm" disabled={rcon.busy || !rcon.patch.password} onClick={() => void applyRcon()}>
                  {rcon.busy ? '写入中…' : '写入并同步到本桥接'}
                </Button>
                {/* ★ 「抄过来」那条路（使用者问「rcon 密码被忘记了怎么办」）：
                    密码是明文存在两边的，而**服务端那份是权威** ⇒ 只要它还在就能抄过来，
                    **一次重启都不用**（改服务端那份才要重启、还会踢在线玩家）。
                    ★ 它的意义正是"**不用看到密码也能对齐**" —— 响应里只有类别，没有值。 */}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rcon.busy}
                  title="把服务端那份里的 rcon.password 抄进本桥接的配置（不必重启服务端；也不需要你看到那个密码）"
                  onClick={() => void adoptRcon()}
                >
                  密码忘了？把服务端那份抄过来
                </Button>
              </div>
              <p className="text-muted-foreground mt-1 text-[11px] leading-relaxed">
                ★ **只改那三行**，其余逐字保留（写前备份；写前会重读一次，发现文件刚被别处改过就**不动它**）。
                <br />⚠️ **改完要重启服务端才生效** —— 那三项是它**启动时**读进内存的。
                {rcon.note && (
                  <>
                    <br />
                    <span className="text-emerald-600">{rcon.note}</span>
                  </>
                )}
              </p>
            </>
          )}
        </div>
      )}

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
