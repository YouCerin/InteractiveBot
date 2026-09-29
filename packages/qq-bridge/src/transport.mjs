/**
 * 传输契约：把"出错了"变成**结构化的、可判定的**东西（H9）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要把判据抽成纯函数（而不是散在 if 里）
 * ══════════════════════════════════════════════════════════════════════════
 * 以前 `onebot.mjs` 里是"遇到情况就 `throw new Error(人话)`" —— 消息写得不错，
 * 但**没有任何机器可读的字段**，于是：
 *   · 上层想说"这个可以重试、那个重试也没用"，只能去**匹配错误字符串**（脆得要命）；
 *   · 想统计"最近失败都是哪一类"，同样得正则嗅探；
 *   · 新加一种错误时，没人知道该在哪一层处理。
 *
 * 现在有一条**表驱动**的判据：`retryable` 是**一等字段**（借鉴参考项目的
 * `OneBotTransportDescriptor`），分类结果可以离线测 —— 这是"把边界判据抽出来"的全部意义。
 *
 * ⚠️ 三条纪律：
 *   ① **不认识的情况不猜成"可重试"**：不明错误给 `retryable: false` + `layer: 'unknown'`
 *      —— 猜错方向会把"其实对方已经收到了"的操作再发一遍（重复消息）。
 *   ② **认证类的错误要给出可执行提示**（本项目两次事故都是 token 漂移，
 *      而它的症状是"令牌被拒 + 机器人完全不说话"）。
 *   ③ 本模块**纯函数**：不碰网络、不碰文件、可离线测。
 */

import { createRequire } from 'node:module'

/** 同步 require（本模块是 ESM；`deliveryKey` 在**每次投递**的同步路径上）。 */
const nodeRequire = createRequire(import.meta.url)

/** 失败的层（`layer`）：决定"该去哪一层排查"，而不是笼统一个"网络错误"。 */
export const LAYER = {
  CONFIG: 'config',
  AUTH: 'auth',
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  HTTP: 'http',
  PROTOCOL: 'protocol',
  UNKNOWN: 'unknown',
}

/**
 * OneBot 的 retcode → 语义。
 *
 * 只收**确定的**几条；其余走 `layer: 'protocol'` + 不可重试。
 * 依据：OneBot v11 的 `retcode` 是"实现自定义"的，各协议端并不统一 ——
 * 所以**不认识的码一律不猜**（宁可让人来看日志）。
 */
export const RETCODE_TABLE = [
  { retcode: 1400, layer: LAYER.PROTOCOL, retryable: false, why: '请求参数不合法' },
  { retcode: 1401, layer: LAYER.PROTOCOL, retryable: false, why: '权限不足（账号在这个接口上没有权限）' },
  { retcode: 1403, layer: LAYER.AUTH, retryable: false, why: 'access token 不正确' },
  { retcode: 1404, layer: LAYER.PROTOCOL, retryable: false, why: '资源不存在（消息/群/好友找不到）' },
  { retcode: 1405, layer: LAYER.PROTOCOL, retryable: false, why: '消息被风控或已失效' },
  { retcode: 100, layer: LAYER.PROTOCOL, retryable: false, why: '参数格式不对' },
  { retcode: 102, layer: LAYER.PROTOCOL, retryable: false, why: '接口调用失败（协议端未说明原因）' },
]

/** HTTP 状态码 → 语义。 */
export const HTTP_TABLE = [
  {
    status: 426,
    layer: LAYER.CONFIG,
    retryable: false,
    why: 'HTTP 426 Upgrade Required',
    hint:
      '几乎可以肯定 httpUrl 指向了 WebSocket 端口 —— 检查 SnowLuma 的 3000（HTTP）与 3001（WS）是不是填反了。',
  },
  {
    status: 401,
    layer: LAYER.AUTH,
    retryable: false,
    why: 'HTTP 401 未授权',
    hint:
      'token 不对或过期。token 存在两处（SnowLuma 自己的 config/onebot_<uin>.json 与 config.json）必然会漂移 —— ' +
      '用 `start.bat --doctor` 看用的是哪一组，别手抄。',
  },
  { status: 403, layer: LAYER.AUTH, retryable: false, why: 'HTTP 403 被拒绝（token 或 IP 限制）' },
  { status: 404, layer: LAYER.PROTOCOL, retryable: false, why: 'HTTP 404 这个接口不存在' },
  { status: 429, layer: LAYER.HTTP, retryable: true, why: 'HTTP 429 被限流' },
]

/**
 * 把一次失败**归类**。
 *
 * @param {object} opts
 * @param {string} [opts.action] OneBot action 名（进人话消息）
 * @param {number|null} [opts.httpStatus]
 * @param {number|null} [opts.retcode]
 * @param {string} [opts.wording] 协议端给的说明
 * @param {string} [opts.errorName] `error.name`（`AbortError` 表示超时）
 * @param {string} [opts.errorCode] `error.code`（`ECONNREFUSED` / `ENOTFOUND` …）
 * @param {string} [opts.message] 原始消息（兜底进人话）
 * @returns {{ok: false, layer: string, code: string|number|null, retryable: boolean, statusCode: number|null, why: string, hint: string, message: string}}
 */
export function classifyTransport({
  action = '',
  httpStatus = null,
  retcode = null,
  wording = '',
  errorName = '',
  errorCode = '',
  message = '',
} = {}) {
  const act = action ? `OneBot ${action} 失败：` : 'OneBot 调用失败：'
  const finish = (layer, retryable, why, hint = '') => ({
    ok: false,
    layer,
    code: retcode ?? httpStatus ?? errorCode ?? null,
    retryable,
    statusCode: httpStatus,
    why,
    hint,
    message: `${act}${why}`,
  })

  // ── ① 超时（`AbortController` 触发）────────────────────────────────────
  if (errorName === 'AbortError' || errorCode === 'ETIMEDOUT') {
    // 超时**可重试**：对方可能只是慢。但注意本项目的纪律 ——
    // "发送失败绝不重跑模型"（H17），重试的是**这一次调用**，不是整轮。
    return finish(LAYER.TIMEOUT, true, '调用超时（对方未在限时内返回）')
  }

  // ── ② 连接层（根本没连上）─────────────────────────────────────────────
  if (errorCode === 'ECONNREFUSED' || errorCode === 'ENOTFOUND' || errorCode === 'EHOSTUNREACH' || errorCode === 'ENETUNREACH') {
    const hint =
      errorCode === 'ECONNREFUSED'
        ? '端口上没有东西在听 —— SnowLuma 没启动，或者端口填错了。'
        : '域名解析不了 —— 通常是 httpUrl 写错了。'
    return finish(LAYER.NETWORK, true, `连不上（${errorCode}）`, hint)
  }

  // ── ③ HTTP 状态（表驱动）──────────────────────────────────────────────
  if (httpStatus != null) {
    const hit = HTTP_TABLE.find((r) => r.status === httpStatus)
    if (hit) return finish(hit.layer, hit.retryable, hit.why, hit.hint ?? '')
    if (httpStatus >= 500) return finish(LAYER.HTTP, true, `HTTP ${httpStatus}（协议端内部错误，可重试）`)
    if (httpStatus >= 400) return finish(LAYER.HTTP, false, `HTTP ${httpStatus}`)
  }

  // ── ④ 协议体里的 retcode（表驱动）─────────────────────────────────────
  if (retcode != null) {
    const hit = RETCODE_TABLE.find((r) => r.retcode === retcode)
    const tail = wording ? ` ${wording}` : ''
    if (hit) {
      const hint =
        hit.layer === LAYER.AUTH
          ? 'token 不对。别手抄 —— 用 `start.bat --doctor` 看实际用的是哪一组。'
          : ''
      return finish(hit.layer, hit.retryable, `${hit.why}（retcode=${retcode}）${tail}`.trim(), hint)
    }
    // ★ 不认识的 retcode **不猜**（各协议端自定义，猜错方向会重发已收到的操作）
    return finish(LAYER.PROTOCOL, false, `协议端返回 retcode=${retcode}${tail}`.trim())
  }

  // ── ⑤ 其它：不认识的一律**不可重试**（见文件头纪律 ①）────────────────
  return finish(LAYER.UNKNOWN, false, message || '未知错误')
}

/** 这个描述符要不要重试（给调用方一个明确入口，避免各处自己解释字段）。 */
export function shouldRetry(descriptor) {
  return Boolean(descriptor && descriptor.retryable === true)
}

/**
 * 投递幂等键：`sha256(chatKey|replyTo|faceId|sticker|text)[:32]`。
 *
 * ── 为什么需要（现在的去重键**是裸文本**，有一个真实缺陷）────────────────
 * `SendQueue` 用**纯文本**当去重键，而队列是**整个桥接共用一个**的 ——
 * 于是"同一句话在 8 秒内发给两个不同的会话"时，第二个会被**误判成重复而丢弃**。
 * 把会话（以及引用/表情）编进键里，这种跨会话误判就不存在了。
 *
 * ⚠️ 键里**包含文本**，所以它是"同一会话 + 同一内容 + 同一引用"的指纹；
 *    不包含时间，所以"隔一会儿又说同一句话"仍会被判重复（这是刻意的：
 *    那条 8 秒窗口就是为"模型抽风重复说同一句"准备的）。
 *
 * ★ 0.2.4 加了 `sticker`（表情包图片的指纹）：不带它的话，
 *   "同一句话 + 两张不同的图"会被判成同一条 —— 第二张会被静默丢掉。
 *   注意这里只**引用**指纹，不把整张 base64 塞进哈希输入（那会白算几百 KB）。
 */
export function deliveryKey({ chatKey = '', text = '', replyTo = null, faceId = null, sticker = null } = {}) {
  const parts = [
    String(chatKey),
    replyTo == null ? '' : String(replyTo),
    faceId == null ? '' : String(faceId),
    sticker == null ? '' : String(sticker),
    String(text ?? ''),
  ]
  const { createHash } = nodeRequire('node:crypto')
  return createHash('sha256').update(parts.join('\u0001')).digest('hex').slice(0, 32)
}

/**
 * 表情包图片的**短指纹**（给投递去重键与日志用）。
 *
 * 为什么不用整段 base64 当键：那等于每次发送都哈希几百 KB，
 * 而这里只需要"是不是同一张图"。取 base64 的 sha256 前 16 位足够区分。
 * ⚠️ 输入为空返回空串（调用方据此判断"没有图"）。
 */
export function stickerFingerprint(base64) {
  const raw = String(base64 ?? '')
  if (!raw) return ''
  const { createHash } = nodeRequire('node:crypto')
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/**
 * 断线缺口的**显式标注**。
 *
 * ★ 借鉴参考项目那条态度：**"宁可显式标出缺口，也不假装连续"**
 *   （它在重连后往消息流里插一行「⚠ 掉线期间消息丢失」）。
 *   我们不去伪造那些没收到的消息，但**必须让模型知道中间缺了一段** ——
 *   否则它会把"掉线前后的两句话"当成连续的对话，然后给出一个基于错误前提的回答。
 *
 * @param {{ms?: number, since?: number, until?: number}} opts
 * @returns {string} 给提示词用的一句话；太短（<5 秒）返回空串（不值得提）
 */
export function describeGap({ ms = 0, since = null, until = null } = {}) {
  let gap = Number(ms) || 0
  if (!gap && since && until) gap = Number(until) - Number(since)
  if (!Number.isFinite(gap) || gap < 5_000) return ''
  const human = gap < 60_000 ? `${Math.round(gap / 1000)} 秒` : `${Math.round(gap / 60_000)} 分钟`
  const from = since ? new Date(since).toLocaleTimeString('zh-CN', { hour12: false }) : ''
  return (
    `【刚才断线了】事件通道断了约 ${human}${from ? `（从 ${from} 起）` : ''}，` +
    '这期间对方发的消息**我们收不到**。如果对方的下一句话像是接着某件你没看到的事，' +
    '就说一句"刚掉线了一会儿，可能有消息没收到"并请他再说一遍 —— **不要猜他刚才说了什么**。'
  )
}
