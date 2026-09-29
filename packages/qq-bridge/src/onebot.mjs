/**
 * OneBot v11 客户端：**WebSocket 只收事件，HTTP 只负责发送**。
 *
 * ── 为什么收和发走两条不同的路 ─────────────────────────────────────────
 * OneBot v11 的两个通道职责是分开的，这是协议规定、不是我们的选择：
 *
 *   WebSocket（正向，我们主动连协议端）→ 协议端**推事件**给我们（有人说话）
 *   HTTP（我们 POST 到协议端）        → 我们**下指令**（发消息、查列表）
 *
 * 为什么事件不也用 HTTP？因为事件是"随时可能来"的，HTTP 是"我问你才答"，
 * 没法被动接收。所以收事件必须用长连接 WebSocket。
 *
 * ── ⚠️ SnowLuma 的两个坑（已从它的实际配置读出）────────────────────────
 *   坑 1：**HTTP 和 WebSocket 用的是两个不同的 accessToken**。
 *         这与 NapCat 常见做法（两边同一个）不同。填错的表现是
 *         "连接成功但每次请求都 401"，很容易误判成网络问题。
 *   坑 2：消息格式是 `array`（消息段数组）。解析时以数组为主路径，
 *         CQ 字符串只作兜底。
 */

import { assertVendored, vendorRequire } from './vendor.mjs'
import { classifyTransport, deliveryKey, describeGap } from './transport.mjs'

// `ws` 从 vendor/node_modules 加载（不是标准 node_modules）—— 这样整个包
// 换地方也能跑。细节见 src/vendor.mjs 的注释。
assertVendored('ws')
const WebSocket = vendorRequire('ws')

/** 这些 action 会传输较大的响应体，给更宽容的超时。 */
const SLOW_ACTIONS = new Set([
  'get_group_list',
  'get_friend_list',
  'get_group_member_list',
  'get_forward_msg',
  'get_image',
  'get_record',
  // ★ 0.2.4：**发消息也算慢动作** —— 表情包是以 base64 塞进 body 的，
  //   一张几百 KB 的图就是近 MB 的请求体，而默认 15 秒对"上传 + 协议端转存 + 回执"
  //   偏紧。实测教训：155 张图里 115 张 >2MB（base64 后 >2.7MB），
  //   超时的后果不只是这一张没发出去，还会进 **5 分钟冷却**（连小的也发不了）。
  //   ★ 真正的第一道防线是"超标的图不进候选"（`sticker-library.mjs` 的
  //   `DEFAULT_MAX_SEND_BYTES`）；这里是第二道，用于"图不大但网络慢"的情况。
  'send_private_msg',
  'send_group_msg',
])

const CALL_TIMEOUT_MS = 15_000
const SLOW_TIMEOUT_MS = 90_000

/**
 * 造一个**带结构化描述符**的错误（H9）。
 *
 * 为什么挂在 error 上而不是换一种返回风格：调用方现在到处是 try/catch，
 * 改返回值就等于改所有调用点。挂一个字段则**完全向后兼容**，
 * 而需要判"能不能重试"的地方（将来）直接读 `error.transport.retryable`。
 */
function transportError(descriptor, message = null) {
  const hint = descriptor?.hint ? ` ${descriptor.hint}` : ''
  const err = new Error(message ?? `${descriptor?.message ?? 'OneBot 调用失败'}${hint}`)
  err.transport = descriptor
  return err
}

export class OneBotClient extends EventTarget {
  #ws = null
  #closed = false
  /**
   * 断线时刻（H9）：重连成功时用它算缺口时长；`null` = 当前没断。
   * 「宁可显式标出缺口，也不假装连续」—— 见 `describeGap`。
   */
  #disconnectedAt = null
  #reconnectTimer = null
  #attempt = 0
  #rpcSeq = 0

  /**
   * @param {object} opts
   * @param {string} opts.wsUrl         事件通道（正向 WebSocket）
   * @param {string} opts.httpUrl       发送通道（HTTP API）
   * @param {string} [opts.wsToken]     WebSocket 的 accessToken
   * @param {string} [opts.httpToken]   HTTP 的 accessToken（可能与上面不同！）
   * @param {string|number|null} [opts.selfId]
   */
  constructor({ wsUrl, httpUrl, wsToken = '', httpToken = '', selfId = null, log = () => {} }) {
    super()
    if (!wsUrl) throw new Error('OneBotClient: wsUrl 必填')
    if (!httpUrl) throw new Error('OneBotClient: httpUrl 必填')
    this.wsUrl = wsUrl
    this.httpUrl = httpUrl.replace(/\/+$/, '')
    this.wsToken = wsToken
    this.httpToken = httpToken || wsToken
    this.selfId = selfId == null ? null : String(selfId)
    this.log = log
  }

  get connected() {
    return this.#ws !== null && this.#ws.readyState === WebSocket.OPEN
  }

  /** 建立事件通道，并保持自动重连。 */
  connect() {
    this.#closed = false
    this.#open()
    return this
  }

  #open() {
    if (this.#closed) return
    clearTimeout(this.#reconnectTimer)

    const url = new URL(this.wsUrl)
    if (this.wsToken && !url.searchParams.has('access_token')) {
      url.searchParams.set('access_token', this.wsToken)
    }

    this.log(`[onebot] 连接事件通道 ${url.origin}${url.pathname}`)
    const ws = new WebSocket(url, {
      headers: this.wsToken ? { authorization: `Bearer ${this.wsToken}` } : {},
    })
    this.#ws = ws

    ws.on('open', () => {
      this.#attempt = 0
      this.log('[onebot] 事件通道已连接')
      // ── H9：断线缺口要**显式标出来**（"宁可标缺口，也不假装连续"）──────────
      //   `describeGap` 会滤掉太短的抖动（<5 秒）；够长的缺口派一个 `gap` 事件，
      //   由桥接把它带进**下一轮提示词** —— 否则模型会把掉线前后的两句话当成连续对话，
      //   然后基于一个错误的前提回答。
      if (this.#disconnectedAt) {
        const since = this.#disconnectedAt
        const ms = Date.now() - since
        this.#disconnectedAt = null
        if (describeGap({ ms })) {
          this.log(`[onebot] ⚠️ 断线缺口约 ${Math.round(ms / 1000)} 秒（这期间的消息收不到）`)
          this.dispatchEvent(new CustomEvent('gap', { detail: { ms, since } }))
        }
      }
      this.dispatchEvent(new CustomEvent('connected'))
    })

    ws.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8')
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        this.log(`[onebot] 收到非 JSON 帧，已忽略：${text.slice(0, 120)}`)
        return
      }
      // 事件可以是一个对象，也可以是数组（批量上报）——两种都要支持。
      if (Array.isArray(payload)) {
        for (const item of payload) this.#emitEvent(item)
      } else {
        this.#emitEvent(payload)
      }
    })

    ws.on('close', (code) => {
      this.log(`[onebot] 事件通道断开 code=${code}`)
      // ★ H9：记下断开时刻（重连成功时用它算缺口时长）。
      //   只在第一次断开时记 —— 反复断开时"缺口起点"应该是最初那一次。
      if (!this.#disconnectedAt) this.#disconnectedAt = Date.now()
      this.dispatchEvent(new CustomEvent('disconnected', { detail: { code } }))
      this.#scheduleReconnect()
    })

    ws.on('error', (error) => {
      // ws 的 error 之后紧跟 close，所以这里只记日志、不重复调度重连。
      this.log(`[onebot] 事件通道错误：${error.message}`)
    })
  }

  #emitEvent(payload) {
    if (!payload || typeof payload !== 'object') return
    this.dispatchEvent(new CustomEvent('event', { detail: payload }))
  }

  #scheduleReconnect() {
    if (this.#closed) return
    this.#attempt += 1
    // 指数退避，封顶 30 秒：断线初期快速重试，长期断开后不要疯狂重连
    // （疯狂重连本身也可能被风控盯上）。
    const delay = Math.min(1000 * 2 ** Math.min(this.#attempt, 5), 30_000)
    this.log(`[onebot] ${delay}ms 后重连（第 ${this.#attempt} 次）`)
    this.#reconnectTimer = setTimeout(() => this.#open(), delay)
  }

  /**
   * 调用一个 OneBot action（HTTP）。
   *
   * 校验逻辑按 OneBot v11 规范：成功时必须 status==='ok' **且** retcode===0。
   * 只看一个是不够的 —— 有的实现只填其中一个。
   */
  async call(action, params = {}, timeoutMs = null) {
    const limit = timeoutMs ?? (SLOW_ACTIONS.has(action) ? SLOW_TIMEOUT_MS : CALL_TIMEOUT_MS)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), limit)

    try {
      const response = await fetch(`${this.httpUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.httpToken ? { authorization: `Bearer ${this.httpToken}` } : {}),
        },
        body: JSON.stringify(params),
        signal: controller.signal,
      })

      if (response.status === 426) {
        // 426 Upgrade Required 是最经典的配置错误：把 HTTP 端口填成了 WS 端口。
        // ★ H9：措辞仍**逐字保留**（它是排查时最有用的一句话），同时把结构化描述符挂在 error 上
        //   —— 上层想做"要不要重试"的判断时**不必再去匹配错误字符串**。
        throw transportError(
          classifyTransport({ action, httpStatus: 426 }),
          `OneBot ${action} 失败：HTTP 426（Upgrade Required）。` +
            `几乎可以肯定 httpUrl 指向了 WebSocket 端口，请检查 SnowLuma 的 3000（HTTP）/3001（WS）是否填反。`,
        )
      }
      if (!response.ok) {
        throw transportError(classifyTransport({ action, httpStatus: response.status }))
      }

      const text = await response.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        throw new Error(`OneBot ${action} 返回了非 JSON 内容：${text.slice(0, 200)}`)
      }

      const ok = body.status === 'ok' || body.retcode === 0
      if (!ok) {
        throw transportError(
          classifyTransport({
            action,
            retcode: body.retcode ?? null,
            wording: body.wording ?? body.msg ?? '',
          }),
        )
      }
      return body.data ?? null
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw transportError(
          classifyTransport({ action, errorName: 'AbortError' }),
          `OneBot ${action} 超时（${Math.round(limit / 1000)} 秒未返回）`,
        )
      }
      // 连接层错误（fetch 抛的那些）：挂上分类结果再抛
      if (error?.transport) throw error
      if (error?.code) throw transportError(classifyTransport({ action, errorCode: error.code, message: error.message }))
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  // ── 常用封装 ──────────────────────────────────────────────────────────

  async getLoginInfo() {
    const info = await this.call('get_login_info')
    if (info?.user_id != null) this.selfId = String(info.user_id)
    return info
  }

  async getFriendList() {
    return (await this.call('get_friend_list')) ?? []
  }

  async getGroupList() {
    return (await this.call('get_group_list')) ?? []
  }

  /**
   * 查**某个群成员**的真实资料（昵称、群名片、群内角色）。
   *
   * ── 为什么要真的去协议端查一次 ────────────────────────────────────────
   * 事件里 SnowLuma 只推 `user_id`，昵称和群内角色都**推不过来**。
   * 于是界面上只能显示一串 QQ 号，而"这个人是谁"没法核实。
   *
   * ── ⚠️ 它**不参与权限判定**（重要）────────────────────────────────────
   * `role` 是**群里的**角色（owner/admin/member），不是"主人的管理员"。
   * 拿它发权限就等于：任何一个群的群主/群管理，只要把机器人拉进群，
   * 就自动获得 DSH 工作区的写权限。所以这里拿到的 role **只用于显示与留痕**，
   * 准入判定仍由 roster 按配置里的 `adminUsers` 决定（见 bridge.mjs 的调用处）。
   *
   * @param {string|number} groupId
   * @param {string|number} userId
   * @param {number} [timeoutMs] 显式超时 —— 这是"给人看的附加信息"，
   *        绝不允许它把一轮回复拖慢（默认 2 秒，见 CALL_TIMEOUT_MS）。
   * @returns {Promise<{ok: boolean, userId: string, nickname: string, card: string,
   *          role: string, level: string, reason?: string}>}
   *          **任何失败都走 `ok:false`，不抛异常** —— 调用方在消息路径上。
   */
  async getGroupMemberInfo(groupId, userId, timeoutMs = null) {
    const gid = String(groupId ?? '')
    const uid = String(userId ?? '')
    const miss = { ok: false, userId: uid, nickname: '', card: '', role: '', level: '' }
    if (!gid || !uid) return { ...miss, reason: '缺少群号或 QQ 号' }

    try {
      const res = await this.call(
        'get_group_member_info',
        { group_id: Number(gid), user_id: Number(uid), no_cache: true },
        timeoutMs ?? 2_000,
      )
      // 各家协议端把资料放在不同层：直接在顶层，或包在 `data` / `data.member` 里。
      // 三处都看一遍 —— 只认一种写法会在换协议端时静默变成"查不到"。
      const m = res?.data?.member ?? res?.data ?? res ?? {}
      const nickname = String(m.nickname ?? m.nick ?? '')
      const card = String(m.card ?? '')
      const role = String(m.role ?? '')
      return {
        ok: Boolean(nickname || card || role),
        userId: String(m.user_id ?? uid),
        nickname,
        card,
        role,
        level: String(m.level ?? ''),
        reason: nickname || card || role ? undefined : '协议端没有返回可用的成员资料',
      }
    } catch (error) {
      return { ...miss, reason: error?.message ?? String(error) }
    }
  }

  /**
   * 发送消息。
   *
   * ── 为什么参数是"段"而不是纯文本 ────────────────────────────────────────
   * 从 0.2.1 起机器人能**引用回复**（`[reply:id]`）和**发表情**（`[sticker:名]`），
   * 而这两件事在 OneBot 里都是**消息段**，不是文本：
   *   · 引用 → `{ type:'reply', data:{ id } }`（必须排在正文**之前**）
   *   · 表情 → `{ type:'face',  data:{ id } }`（排在正文之后）
   * ⚠️ 三段的顺序不能乱：OneBot/QQ 只认"reply 在最前"，放后面就不显示引用气泡。
   *
   * ── 0.2.4 新增 `stickerBase64`：**真的发一张表情包图片** ────────────────
   * 表情包与"QQ 内置表情"是**两种东西**：前者是一张图（`type:'image'`），
   * 后者是一个内置脸（`type:'face'` + id）。自主发表情包必须能发前者，
   * 而在此之前桥接只能发文本与 face —— 出海口是缺的。
   *
   * 为什么用 base64（而不是本机路径/URL）：
   *   · 本机路径要靠协议端能读我们的磁盘（未验证，pixiv 插件为此外挂了一个本地图片桥）；
   *   · URL 要把"取图"交给协议端（SSRF 面转移、失败原因回不来）；
   *   · base64 是 `qq_send_image` 已经在用的形态，SnowLuma 文档明确支持 `base64://`。
   * 代价是每张图多约 1/3 体积的传输 —— 对本地 ws 上几百 KB 的表情图无所谓。
   *
   * ★ `faceId` 与 `stickerBase64` **互斥**：两个都传等于发两个表情。
   *   这里只保留图片并记一行日志（猜"哪个才是想发的"是更糟的选择）。
   *
   * @param {'private'|'group'} kind
   * @param {string|number} peerId
   * @param {string} text
   * @param {{replyTo?: string|number|null, faceId?: string|number|null, stickerBase64?: string|null, stickerMime?: string|null}} [opts]
   *   `replyTo` 必须是**校验过**的消息 id（校验在 bridge 里做，见 markers.mjs）
   * @returns {Promise<object>} 协议端的返回值（含 `message_id`，但我们目前不用它）
   */
  async send(kind, peerId, text, { replyTo = null, faceId = null, stickerBase64 = null } = {}) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg'
    const key = kind === 'private' ? 'user_id' : 'group_id'
    const segments = []
    if (replyTo != null && String(replyTo) !== '') {
      segments.push({ type: 'reply', data: { id: String(replyTo) } })
    }
    const body = String(text ?? '')
    if (body !== '') segments.push({ type: 'text', data: { text: body } })

    const pic = String(stickerBase64 ?? '').trim()
    if (pic) {
      if (faceId != null && String(faceId) !== '') {
        // 互斥：图片优先，并留一行日志（调用方本该只给一个，这是兜底）
        // 措辞统一成"表情包"：全项目只有这里把它叫"贴纸图"，同一个东西两种叫法
        // 只会让排障时搜日志搜不全（0.2.7 改）。
        this.log?.('[onebot] 同时给了表情包图与内置表情 id → 只发图片（脸被丢掉）')
      }
      segments.push({ type: 'image', data: { file: `base64://${pic}` } })
    } else if (faceId != null && String(faceId) !== '') {
      segments.push({ type: 'face', data: { id: String(faceId) } })
    }
    // 全空 = 什么都不发（调用方本该拦住，这里兜一层，免得发一条空消息出去）
    if (segments.length === 0) return { status: 'ok', retcode: 0, data: null, skipped: 'empty' }
    return this.call(action, { [key]: Number(peerId), message: segments })
  }

  close() {
    this.#closed = true
    clearTimeout(this.#reconnectTimer)
    if (this.#ws) {
      try {
        this.#ws.close()
      } catch {
        /* 关闭失败无所谓 */
      }
      this.#ws = null
    }
  }
}

/**
 * 发送队列：拟人节流 + 去重。
 *
 * ── 为什么必须有这个 ───────────────────────────────────────────────────
 * 这是**账号安全的必需品**，不是优化项：
 *   · 秒回、连发、固定间隔是行为风控的教科书级特征
 *   · 模型有时会重复调用发送（超时重发、多轮里说了同样的话）
 * 所以这里做三件事：间隔拟人化（随机）、限频、短窗口内去重。
 *
 * 参数取自同类成熟项目的实测值（minGap 1s / maxGap 3s / 每分 8 条 /
 * 去重窗口 8 秒），它们是被真实风控"教育"过的数字。
 */
export class SendQueue {
  #lastSentAt = 0
  #recent = new Map() // 文本 -> 时间戳
  #window = [] // 最近发送的时间戳，用于限频

  constructor({
    minGapMs = 1000,
    maxGapMs = 3000,
    maxPerMinute = 8,
    maxPerHour = 500,
    dedupeWindowMs = 8000,
    log = () => {},
  } = {}) {
    this.minGapMs = minGapMs
    this.maxGapMs = Math.max(maxGapMs, minGapMs)
    this.maxPerMinute = maxPerMinute
    this.maxPerHour = maxPerHour
    this.dedupeWindowMs = dedupeWindowMs
    this.log = log
  }

  /**
   * 检查是否可以发送。
   * @returns {{ ok: boolean, reason?: string, waitMs?: number }}
   */
  check(text, key = null) {
    const now = Date.now()
    // ★ H9：去重键由调用方给（= `deliveryKey({chatKey, text, replyTo, faceId})`）。
    //   为什么不再用**裸文本**：队列是**整个桥接共用一个**的，于是
    //   "同一句话在 8 秒内发给两个不同的会话"时，第二个会被**误判成重复而丢弃**
    //   —— 把会话（以及引用/表情）编进键里，这种跨会话误判就不存在了。
    const dedupeKey = key ?? text

    // ── 去重 ──
    // 只在**发送成功后**才记账（见 markSent）。若在检查时就记账，
    // 一次合法重试会被误判成重复而丢失。
    const lastSame = this.#recent.get(dedupeKey)
    if (lastSame !== undefined && now - lastSame < this.dedupeWindowMs) {
      return { ok: false, reason: `内容重复（${Math.round((now - lastSame) / 1000)} 秒前刚发过）` }
    }

    // ── 限频 ──
    this.#window = this.#window.filter((t) => now - t < 3600_000)
    const lastMinute = this.#window.filter((t) => now - t < 60_000).length
    if (lastMinute >= this.maxPerMinute) {
      return { ok: false, reason: `每分钟上限 ${this.maxPerMinute} 条已达` }
    }
    if (this.#window.length >= this.maxPerHour) {
      return { ok: false, reason: `每小时上限 ${this.maxPerHour} 条已达` }
    }

    // ── 拟人间隔 ──
    const gap = this.minGapMs + Math.floor(Math.random() * (this.maxGapMs - this.minGapMs + 1))
    const elapsed = now - this.#lastSentAt
    if (elapsed < gap) return { ok: true, waitMs: gap - elapsed }
    return { ok: true, waitMs: 0 }
  }

  /** 发送成功后调用，记账。 */
  markSent(text, key = null) {
    const now = Date.now()
    this.#lastSentAt = now
    this.#window.push(now)
    this.#recent.set(key ?? text, now)
    // 清理过期的去重记录，防止无限增长
    if (this.#recent.size > 200) {
      for (const [key, at] of this.#recent) {
        if (now - at > this.dedupeWindowMs) this.#recent.delete(key)
      }
    }
  }

  get pendingCount() {
    return this.#window.filter((t) => Date.now() - t < 60_000).length
  }
}
