/**
 * 游戏内**回应通道**的命令构造（0.3.2 P3）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 两条通道（2026-10-04 使用者定的口径）
 * ══════════════════════════════════════════════════════════════════════════
 *   · 未绑定提醒 · 绑定码 · 绑定回执 → **`tellraw <玩家>` 只给本人**
 *   · 小鲸鱼的正常回复                → **`tellraw @a` 公屏**
 *
 * ★★★ **公屏那条原来用 `say`，已经换成 `tellraw @a`**（使用者要求：
 *   「每条发言都要在前面加上 `<小鲸鱼>`，**不要高亮**，模仿正常玩家」）。
 *   为什么 `say` 做不到：
 *     · `/say` 是**服务端公告**，游戏里渲染成 `[Server] 正文`（走 `chat.type.announcement`），
 *       带自己的配色 —— 那不是玩家发言的样子；
 *     · 而 `tellraw @a {"text":"<小鲸鱼> 正文"}` 是**默认白色**的普通文本，
 *       看起来就跟 `<某玩家> 正文` 那一行一样。
 *   ★ 代价如实记：`say` **会**在控制台日志里留一行 `[Rcon] …`（所以我们能在
 *     「实时后台」里看到它说过什么），而 `tellraw` **一声不响**（只发给玩家）。
 *     ∴ 桥接那边改为**自己把每条发言记进日志**（`#deliverToGame`），
 *     这个"可核对"的能力没有丢，只是换了个地方。
 *
 * ★ 为什么 `tellraw` 而不是 `/msg`：`tellraw` 用**选择器**定向、**纯原版可用**、
 *   不需要任何客户端模组；而 `/msg` 的命令名在各版本不一致（`msg`/`tell`）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ `tellraw` 的参数是 JSON ⇒ 它是**最容易被当成"发言类"而破防**的一条命令
 * ══════════════════════════════════════════════════════════════════════════
 * 两条硬要求（设计文档 §5.4 写明）：
 *   ① **参数只由模板生成**（点名 + 文本），**不接受模型自由填 JSON**；
 *   ② 玩家名作为选择器时必须**被严格校验过**，不接受拼字符串（防选择器注入）。
 *
 * 本模块就是这两条的落点：**唯一**的 JSON 由 `JSON.stringify` 生成（转义交给它，
 * 不自己拼引号），而名字必须匹配 `PLAYER_NAME_RE` —— 不匹配就**拒绝发送**
 * （`ok:false`），而不是"尽力拼一个"。
 *
 * ⚠️ 选择器注入的真实形状（写下来免得以后当理论）：`tellraw @a[tag=x] ...` 或
 *   `tellraw @e ...` 都是合法选择器 ⇒ 一个能塞进名字的 `@` 会让"只给本人"变成
 *   "给全服"。Minecraft 的玩家名本身只允许 `[A-Za-z0-9_]` 且 ≤16 字符，
 *   所以这条校验**不会误伤任何正常玩家**。
 * ★ 公屏那条用的是写死的 `@a`（**不接受任何外部输入**）—— 它本来就是"发给所有人"。
 */

/** 玩家名的合法形状（与 Minecraft 的账号名规则一致；同时用作**选择器**的安全性判据）。 */
export const PLAYER_NAME_RE = /^[A-Za-z0-9_]{1,16}$/

/** 机器人在游戏里的**显示名**（发出去的每一句都带这个前缀，模仿玩家发言）。 */
export const BOT_NAME = '小鲸鱼'

/**
 * 给一句话加上**只加一次**的 `<小鲸鱼> ` 前缀。
 *
 * ★ 为什么必须"只加一次"：私密通道与公屏通道都从这里过，而调用方偶尔会自己
 *   把前缀写进正文（例如提醒文案里引用"小鲸鱼会…"）—— 那时再加一遍就变成
 *   `<小鲸鱼> <小鲸鱼> …`。幂等比"相信调用方"可靠。
 */
export function botLine(text) {
  const s = String(text ?? '').trim()
  if (!s) return ''
  const prefix = `<${BOT_NAME}> `
  return s.startsWith(prefix) ? s : `${prefix}${s}`
}

/** 公屏每片的最大长度。★ 原版聊天栏一条显示不下就会被折行/截断，200 是个安全的保守值。 */
export const CHAT_CHUNK_CHARS = 200

/**
 * 把一段要发进游戏的话规整成**一行**。
 *
 * ★ 为什么必须压成一行：`say` 与 `tellraw` 都是**命令** —— 换行会把命令截断，
 *   而剩下的部分会被当成**下一条命令**执行（"我说的话里带个换行"变成"我下了条命令"，
 *   这是真能出事的形状）。所以换行一律压成空格。
 * ★ 同时去掉 C0 控制字符（含 `\r`、`\t` 之外的罕见控制符）—— 它们进日志/聊天栏
 *   只会变成乱码，没有正当用途。
 * ★★ 还**剥掉 `§`（U+00A7）格式码** —— 它是原版的**格式逃生码**：写在 `text` 组件里
 *   **客户端仍然会当格式码渲染**（`§c` 变红、`§k` 变乱码…）。留着它就等于把
 *   "给这一行上色/搞乱"的能力交给模型，而使用者明确要求「**不要高亮**，模仿正常玩家」。
 *   ⚠️ 必须**连着后面那个格式字母一起剥**（`§c` 是两个字符）：只剥 `§` 会留下一个
 *   孤零零的 `c`（实测踩到 —— 断言写的是"剩下普通文字"，结果得到 `c红`）。
 *   普通聊天里没有人会用 `§`，剥掉不误伤任何正常内容。
 */
export function oneLine(text) {
  return String(text ?? '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\u00a7[0-9a-fk-orA-FK-OR]?/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * 造一条**公屏发言**（`tellraw @a`，看起来就像普通玩家说的一句话）。
 *
 * ★ 为什么不是 `say`：`/say` 渲染成 `[Server] 正文` 且带自己的配色 —— 那是"服务端公告"，
 *   不是玩家发言（使用者要求「每条发言都要在前面加上 `<小鲸鱼>`，**不要高亮**，
 *   模仿正常玩家」）。`tellraw @a` 是**默认白色**的普通文本 ⇒ 看起来就是
 *   `<小鲸鱼> 正文` 那一行。
 * ★ `@a` 是**写死的**（不接受任何外部输入）：这条通道本来就是"发给所有人"。
 *
 * @returns {{ok:true, command:string, text:string} | {ok:false, why:string}}
 */
export function buildPublicChat({ text = '', name = BOT_NAME } = {}) {
  const line = oneLine(text)
  if (!line) return { ok: false, why: 'empty' }
  const said = botLine(name === BOT_NAME ? line : `<${String(name)}> ${line}`)
  // ★ JSON 只由 JSON.stringify 生成（不自己拼引号）
  const json = JSON.stringify({ text: said })
  if (/[\r\n]/.test(json)) return { ok: false, why: 'JSON 里出现了换行（拒绝发送）' }
  return { ok: true, command: `tellraw @a ${json}`, text: said }
}

/**
 * 造一条 `tellraw`（**只给本人**）。
 *
 * ★ 正文会自动带上 `<小鲸鱼> ` 前缀（与公屏那条同一个口径：**它说出去的每一句
 *   都署自己的名**）。前缀是幂等的，调用方重复写也不会变成两个。
 *
 * @param {object} o
 * @param {string} o.player 玩家名（**必须**匹配 `PLAYER_NAME_RE`）
 * @param {string} o.text   正文（会被压成一行，并自动加 `<小鲸鱼> ` 前缀）
 * @param {string} [o.color] 可选颜色名（`yellow` 这类原版颜色；只认字母，防注入）。
 *        ★ 默认**不传** —— 使用者要求"不要高亮"，默认白色才像正常玩家。
 */
export function buildTellraw({ player = '', text = '', color = '' } = {}) {
  const who = String(player ?? '').trim()
  if (!PLAYER_NAME_RE.test(who)) return { ok: false, why: `玩家名不合法（${who ? `「${who}」` : '空'}）—— 拒绝拼命令` }
  const line = botLine(oneLine(text))
  if (!line) return { ok: false, why: 'empty' }
  // ★ JSON 只由 JSON.stringify 生成（不自己拼引号）。
  const payload = { text: line }
  const col = String(color ?? '').trim()
  if (/^[a-zA-Z_]{1,16}$/.test(col)) payload.color = col
  const json = JSON.stringify(payload)
  // ★ 再兜一层：JSON 序列化的结果里不可能有换行（上面已压平），但**命令分隔**这条
  //   风险太大，所以宁可多断言一次 —— 一旦出现就直接拒绝，而不是发出去。
  if (/[\r\n]/.test(json)) return { ok: false, why: 'JSON 里出现了换行（拒绝发送）' }
  return { ok: true, command: `tellraw ${who} ${json}`, text: line }
}

/**
 * 把一段回复切成几片公屏发言（**只在长度上切**，不改一个字）。
 *
 * ★ 与 QQ 侧的分条（`splitReplyForSend`）是**两件事**：那边管"观感"，
 *   这边管"一条聊天栏放不下"。游戏的公屏信息密度低，分太多条只会刷屏 ⇒
 *   这里**只按长度硬切**，不按段落分。
 */
export function chunkForChat(text, limit = CHAT_CHUNK_CHARS) {
  const line = oneLine(text)
  if (!line) return []
  const max = Math.max(16, Number(limit) || CHAT_CHUNK_CHARS)
  const out = []
  let rest = line
  while (rest.length > max) {
    out.push(rest.slice(0, max))
    rest = rest.slice(max)
  }
  if (rest) out.push(rest)
  return out
}
