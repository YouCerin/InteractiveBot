/**
 * 出站目标：**通道 + 目标**，而不是一个靠冒号拆的会话键。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要有这一层（0.3.3 · S5）
 * ══════════════════════════════════════════════════════════════════════════
 * 在此之前，桥接的出站签名是 `send(kind, peerId, text)`，而 `kind` 是从**会话键字符串**
 * 里推导出来的（`'group:123'` → `kind = 'group'`）。这条路上出过一次真实事故：
 * **游戏里说的话被投进了 QQ 私聊**（`docs/0.3.2` 记着，E6）。
 *
 * 事故的根因不是"某处写错了 if"，而是**结构上允许它发生**：
 *   · 会话键是一个字符串，它同时承担了"标识一段对话"和"决定往哪儿发"两件事；
 *   · 于是任何一个拿到会话键的地方，都能顺手推出一个 `kind` 发出去 ——
 *     包括那些**根本不知道这条回复来自哪个通道**的地方。
 *
 * 所以这一层把两件事拆开：
 *   · **通道**是枚举（`CHANNELS`），只允许这四个值；
 *   · **目标**是通道自己的一种标识（QQ 群号 / QQ 号 / 服务器 id / 控制台会话名），
 *     格式由通道决定，**校验不通过就抛错**（绝不静默降级到"随便找个地方发"）。
 *
 * ★ 三条纪律：
 *   1. **不发的东西也要能预演**：`resolveTarget()` 返回 `{ok, why}`，不抛；
 *      `requireTarget()` 才抛（给"这里必须是个合法目标"的调用点用）。
 *   2. **错误文案要说清该填什么**（"群号必须是纯数字"），而不是只说"不合法" ——
 *      调用点大多是配置/存储来的数据，使用者看不懂内部字段名。
 *   3. **绝不用目标字符串拼路径、拼 URL、拼命令**：`game` 的 target 会走到
 *      `tellraw`/RCON 那条路上，形如 `../` 的值必须在校验阶段就被挡住。
 *
 * 这一层是**纯函数**（无 IO、无时钟、无随机）：C1–C4 那几条验收全靠它可断言。
 */

/** 允许的通道。★ 顺序无意义，但**新加一个必须同时改 `KIND_OF` 与 `chatKeyOf`**。 */
export const CHANNELS = ['qq-group', 'qq-private', 'game', 'console']

/**
 * **只用于读老记录**的哨兵值。
 *
 * 它**不是一个可出站的通道**（`resolveTarget` 会拒掉它）：老账本/老语料里只有
 * `kind`，没写通道，我们只知道"这是 QQ 的"，不知道是群还是私聊。
 * 把 `'qq'` 当成 `'qq-private'` 去发，正是 E6 那类串味的经典写法 ——
 * 所以读的时候允许"不知道"，写/发的时候不允许。
 */
export const LEGACY_CHANNEL = 'qq'

/** 通道 → 内部 `kind`（`SendQueue` / `onebot.send` / 游戏适配用的短名）。 */
const KIND_OF = {
  'qq-group': 'group',
  'qq-private': 'private',
  game: 'game',
  console: 'console',
}

/** 内部 `kind` → 通道（**只在入口适配时用**：QQ 事件 / 老存储给的 kind）。 */
const CHANNEL_OF_KIND = {
  group: 'qq-group',
  private: 'qq-private',
  game: 'game',
  console: 'console',
}

/** 每个通道的目标格式（**判据写在这里，别在调用点各写一份**）。 */
const RULES = {
  'qq-group': {
    test: /^\d{5,12}$/,
    why: 'QQ 群号必须是 5~12 位纯数字（不要带 `group:` 前缀，通道请填 `qq-group`）',
  },
  'qq-private': {
    test: /^\d{5,12}$/,
    why: 'QQ 号必须是 5~12 位纯数字（不要带 `private:` 前缀，通道请填 `qq-private`）',
  },
  game: {
    // 服务器 id 会进 `tellraw` / RCON 命令，所以**不许**出现空白、引号、斜杠、反斜杠、分号
    test: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/,
    why: '游戏通道的目标是服务器 id，只能字母/数字/下划线/点/短横（且不能以符号开头）',
  },
  console: {
    test: /^[A-Za-z0-9_-]{1,32}$/,
    why: '控制台通道的目标是一段会话名，只能字母/数字/下划线/短横',
  },
}

/** 目标不合法。★ 用独立错误类型，调用方/测试能分辨"目标错"与"发送失败"。 */
export class DeliveryTargetError extends Error {
  constructor(message, { channel = '', target = '' } = {}) {
    super(message)
    this.name = 'DeliveryTargetError'
    this.channel = channel
    this.target = target
  }
}

/**
 * 校验并解析一个出站目标（**不抛**）。
 *
 * @param {{channel?: string, target?: string|number}} input
 * @returns {{ok: true, channel: string, target: string, kind: string,
 *            chatKey: string} | {ok: false, why: string}}
 */
export function resolveTarget({ channel, target } = {}) {
  const ch = String(channel ?? '').trim()
  if (ch === '') {
    return { ok: false, why: `通道不能为空，合法值：${CHANNELS.join(' / ')}` }
  }
  if (ch === LEGACY_CHANNEL) {
    return {
      ok: false,
      why:
        `「${LEGACY_CHANNEL}」只是**读老记录**时的占位，不能用来发消息 —— ` +
        '要发得说清发给谁：`qq-group` 或 `qq-private`',
    }
  }
  if (!CHANNELS.includes(ch)) {
    return { ok: false, why: `通道「${ch}」不认识，合法值：${CHANNELS.join(' / ')}` }
  }
  const raw = String(target ?? '').trim()
  if (raw === '') {
    return { ok: false, why: `通道「${ch}」的目标不能为空（${RULES[ch].why}）` }
  }
  // ★ 目标里带冒号 = 有人把会话键直接塞进来了（`qq:100000001`）。
  //   这正是 S5 要消灭的写法，所以**报错而不是替他拆**：拆了就等于没改。
  if (raw.includes(':')) {
    return {
      ok: false,
      why:
        `目标里不能带冒号（收到的是「${raw}」）。` +
        `通道和目标要分开填：例如 { channel: 'qq-group', target: '123456' }`,
    }
  }
  if (!RULES[ch].test.test(raw)) {
    return { ok: false, why: `通道「${ch}」的目标「${raw}」不合法：${RULES[ch].why}` }
  }
  return {
    ok: true,
    channel: ch,
    target: raw,
    kind: KIND_OF[ch],
    chatKey: keyOf(KIND_OF[ch], raw),
  }
}

/** 同 `resolveTarget`，但**非法就抛**（给"这里必须合法"的调用点用）。 */
export function requireTarget(input) {
  const r = resolveTarget(input)
  if (!r.ok) throw new DeliveryTargetError(r.why, input ?? {})
  return r
}

/** 内部：`kind` + 目标 → 会话键（**唯一**的拼法）。 */
function keyOf(kind, target) {
  return `${kind}:${target}`
}

/** 通道 + 目标 → 会话键（校验后拼；别处不许自己 `${kind}:${peerId}` 拼）。 */
export function chatKeyOf(channel, target) {
  const t = resolveTarget({ channel, target })
  if (!t.ok) throw new DeliveryTargetError(t.why, { channel, target })
  return t.chatKey
}

/**
 * 入口适配：QQ 事件 / 老存储给的 `kind` + `peerId` → 目标。
 *
 * ★ 为什么允许这个"从 kind 推通道"的入口：**入站事件本身**就是带类型的
 *   （`message_type: 'group'`），那是事实，不是猜测。事故的危险写法是在**出站深处**
 *   再从会话键字符串反推；在入口一次定下来、之后整条链路带着目标对象走，是安全的。
 */
export function targetOfKind(kind, peerId) {
  const ch = CHANNEL_OF_KIND[String(kind ?? '').trim()]
  if (!ch) {
    return { ok: false, why: `kind「${String(kind ?? '')}」不认识，无法确定通道` }
  }
  return resolveTarget({ channel: ch, target: peerId })
}

/**
 * 读**老记录**（账本行 / 语料行 / 定时任务目标）时补出通道。
 *
 * 优先级：显式 `channel` → `chatKey` 前缀 → `kind` → `LEGACY_CHANNEL`。
 * ★ **只读**：绝不把补出来的值回写（回写会让"当年到底存了什么"这件事消失，
 *   而排查老事故时它恰恰是唯一的证据）。
 *
 * @param {{channel?: string, chatKey?: string, kind?: string}} row
 * @returns {string} `CHANNELS` 之一，或 `LEGACY_CHANNEL`（读老数据时的"仅知是 QQ"）
 */
export function channelFromStored(row = {}) {
  const explicit = String(row?.channel ?? '').trim()
  if (CHANNELS.includes(explicit)) return explicit
  if (explicit === LEGACY_CHANNEL) return LEGACY_CHANNEL
  const key = String(row?.chatKey ?? '')
  const prefix = key.includes(':') ? key.slice(0, key.indexOf(':')) : ''
  if (CHANNEL_OF_KIND[prefix]) return CHANNEL_OF_KIND[prefix]
  const byKind = CHANNEL_OF_KIND[String(row?.kind ?? '').trim()]
  if (byKind) return byKind
  return LEGACY_CHANNEL
}

/**
 * 跨通道投递的三连校验：**开关 → 格式 → 白名单**（S5e）。
 *
 * ★ 为什么跨通道要单独成一条："让 A 群里的对话把消息发到 B 群"不是一个参数分支，
 *   而是一项**需要授权**的能力。默认关，且白名单只认 `channel:target` 形状的字面量。
 *
 * @param {object} opts
 * @param {string} opts.from 这条回复**原本属于**哪个通道
 * @param {string} opts.to 想发到哪个通道
 * @param {{enabled?: boolean, allow?: string[]}} opts.config
 * @returns {{ok: true} | {ok: false, why: string}}
 */
export function checkCrossChannel({ from, to, config } = {}) {
  const cfg = config ?? {}
  // ★ 顺序是有讲究的：**先判"这算不算跨通道"**，再判开关。
  //   同一个通道内投递是日常行为（本该照常发），把开关放在它前面会让
  //   "跨通道被你关了"表现成"连本通道都不发了"。
  const dest = resolveTarget({ channel: to?.channel, target: to?.target })
  if (dest.channel === from && dest.ok) return { ok: true }
  if (cfg.enabled !== true) {
    return { ok: false, why: '跨通道投递默认关闭（`delivery.crossChannel.enabled = false`）' }
  }
  if (!dest.ok) return { ok: false, why: dest.why }
  const allow = (Array.isArray(cfg.allow) ? cfg.allow : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
  const wanted = `${dest.channel}:${dest.target}`
  // ★ 白名单**精确到目标**（不是"允许发到 game 通道"）：一条白名单就等于一份授权，
  //   写成通道级的话，谁加了通道就等于对所有服务器/所有群开放。
  if (!allow.includes(wanted)) {
    return {
      ok: false,
      why: `目标「${wanted}」不在白名单里（\`delivery.crossChannel.allow\` 要精确写「通道:目标」）`,
    }
  }
  return { ok: true }
}
