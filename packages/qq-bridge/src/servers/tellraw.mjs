/**
 * 游戏内两条**回应通道**的命令构造（0.3.2 P3）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 通道选择（使用者拍板，设计文档 §5.4）
 * ══════════════════════════════════════════════════════════════════════════
 *   · 未绑定提醒 · 绑定回执 → **`tellraw` 只给本人**（那是个人信息，不该公屏广播）
 *   · 小鲸鱼的正常回复      → **`say` 公屏**（聊天氛围；全版本可用）
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
 */

/** 玩家名的合法形状（与 Minecraft 的账号名规则一致；同时用作**选择器**的安全性判据）。 */
export const PLAYER_NAME_RE = /^[A-Za-z0-9_]{1,16}$/

/** `say` 每片的最大长度。★ 原版聊天栏一条显示不下就会被折行/截断，200 是个安全的保守值。 */
export const SAY_CHUNK_CHARS = 200

/**
 * 把一段要发进游戏的话规整成**一行**。
 *
 * ★ 为什么必须压成一行：`say` 与 `tellraw` 都是**命令** —— 换行会把命令截断，
 *   而剩下的部分会被当成**下一条命令**执行（"我说的话里带个换行"变成"我下了条命令"，
 *   这是真能出事的形状）。所以换行一律压成空格。
 * ★ 同时去掉 C0 控制字符（含 `\r`、`\t` 之外的罕见控制符）—— 它们进日志/聊天栏
 *   只会变成乱码，没有正当用途。
 */
export function oneLine(text) {
  return String(text ?? '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * 造一条 `say`（公屏）。
 * @returns {{ok:true, command:string, text:string} | {ok:false, why:string}}
 */
export function buildSay({ text = '' } = {}) {
  const line = oneLine(text)
  if (!line) return { ok: false, why: 'empty' }
  return { ok: true, command: `say ${line}`, text: line }
}

/**
 * 造一条 `tellraw`（**只给本人**）。
 *
 * @param {object} o
 * @param {string} o.player 玩家名（**必须**匹配 `PLAYER_NAME_RE`）
 * @param {string} o.text   正文（会被压成一行）
 * @param {string} [o.color] 可选颜色名（`yellow` 这类原版颜色；只认字母，防注入）
 */
export function buildTellraw({ player = '', text = '', color = '' } = {}) {
  const who = String(player ?? '').trim()
  if (!PLAYER_NAME_RE.test(who)) return { ok: false, why: `玩家名不合法（${who ? `「${who}」` : '空'}）—— 拒绝拼命令` }
  const line = oneLine(text)
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
 * 把一段回复切成几片 `say`（**只在长度上切**，不改一个字）。
 *
 * ★ 与 QQ 侧的分条（`splitReplyForSend`）是**两件事**：那边管"观感"，
 *   这边管"一条聊天栏放不下"。游戏的公屏信息密度低，分太多条只会刷屏 ⇒
 *   这里**只按长度硬切**，不按段落分。
 */
export function chunkForSay(text, limit = SAY_CHUNK_CHARS) {
  const line = oneLine(text)
  if (!line) return []
  const max = Math.max(16, Number(limit) || SAY_CHUNK_CHARS)
  const out = []
  let rest = line
  while (rest.length > max) {
    out.push(rest.slice(0, max))
    rest = rest.slice(max)
  }
  if (rest) out.push(rest)
  return out
}
