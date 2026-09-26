/**
 * QQ 图片 → 工作区落盘 → 交给模型"看"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个模块（背景取证）
 * ══════════════════════════════════════════════════════════════════════════
 * 现状（改之前）：`text.mjs` 遇到图片段只写一个 `[图片]`，**把 `data.url`
 * 直接丢掉了**；`bridge.mjs` 还会补一句"当前通道未启用看图能力"。
 *
 * 但整条链路其实早就通了，取证如下：
 *
 *   · **模型会看图**：我们配的 `deepseek-flash`（DeepSeek-V41-Flash）在
 *     `dsh-llm-deepseek` 的模型表里写着 `inputModalities: ["text","image"]`。
 *   · **SDK 收图片**：`dsh-sdk-jsonrpc-server` 的 `session/prompt` 吃
 *     `params.contentBlocks`，其中 `{type:'image', data:<base64>, mimeType}`
 *     会被 `admitEncodedImages` 存进附件库再交给模型。
 *   · **附件库在**：`sdk` profile = `dsh-base` + `dsh-sdk-app`，而
 *     `dsh-base` 里挂着 `attachment-local`。
 *   · **有 read_image 工具**：`dsh-tool-fs` 在 `ctx.inject(['attachments'])`
 *     里注册它 —— 附件库在，它就存在。
 *
 * 也就是说：**缺的从来不是"能力"，是"把图片递进去"这一步。**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 两种模式（配置 `image.mode`）
 * ══════════════════════════════════════════════════════════════════════════
 *   `on-demand`（默认）：只把图片**存进工作区**，提示词里给出相对路径，
 *       模型**自己想看的时候**才调 `read_image`。
 *       为什么默认选它 —— 省钱：QQ 里大量是表情包，自动注入等于每张表情包
 *       都花 vision token，而且图片会留在会话历史里、后续每轮重复计费。
 *       路径是纯文本，留在历史里几乎不花钱。
 *
 *   `auto`：除了落盘，还把图片转成 base64 直接塞进 `contentBlocks`，
 *       模型**立刻就能看见**，不用多一次工具往返（更快、更准），
 *       代价是每张图都计费。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ 下载图片是**桥接进程**发起的网络请求，而 URL 由**发消息的人**控制
 * ══════════════════════════════════════════════════════════════════════════
 * 这是本模块最危险的地方：如果不加判断就去 fetch，别人发一条构造过的消息
 * 就能让机器人去请求 `http://127.0.0.1:3410/api/...`（配置接口！）或者
 * 内网任意地址 —— 也就是 **SSRF**。
 *
 * 所以这里有一整套硬限制，**任何一条被绕过都算严重缺陷**：
 *   ① 只允许 `http:` / `https:`（`file:` / `data:` 一律拒）
 *   ② **逐跳**校验重定向目标（不是只查第一个 URL —— 只在第一跳查
 *      等于没查：攻击者让公网域名 302 到内网即可）
 *   ③ 拒绝回环 / 内网 / 链路本地 / CGNAT / 组播 地址，**含 IPv4 映射的
 *      IPv6 写法**（`::ffff:127.0.0.1` 这类绕过很常见）
 *   ④ 域名要**先解析**，任何一个解析结果落在内网就拒（`127.0.0.1.nip.io`
 *      这种"看起来是域名、其实指向本机"的写法就靠这条挡）
 *   ⑤ 大小上限 + 超时 + 重定向次数上限
 *
 * ── 已知边界（如实写出来，不装作没有）────────────────────────────────
 * ③④ 是"解析时校验"，而 fetch 会**再解析一次**。理论上存在 DNS rebinding
 * 的窗口（两次解析拿到不同地址）。彻底堵住要把解析结果钉住再连接
 * （自建 agent + 指定 IP），代价明显更大。这里如实标注为**已知边界**，
 * 不写成"已经完全防住"。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { lookup as dnsLookup } from 'node:dns/promises'

/** 图片落在工作区里的子目录名。 */
export const IMAGE_DIR = 'inbox'

/**
 * 允许的图片类型 → 文件扩展名。
 *
 * 为什么是这四种：DSH 附件库白名单就这四种
 * （`dsh-attachment-local` 的 `mediaTypes`：png / jpeg / webp / gif）。
 * 收下别的类型没有意义 —— 存了也喂不进模型，只会白占磁盘。
 */
export const MEDIA_TYPE_EXT = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
})

/** 默认下载上限（单张）。 */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
/** 默认超时。 */
export const DEFAULT_TIMEOUT_MS = 15_000
/** 默认最多跟随几次重定向。 */
export const DEFAULT_MAX_REDIRECTS = 3
/** 默认在 inbox 里留多久。 */
export const DEFAULT_RETENTION_HOURS = 72
/** 默认 inbox 总量上限。 */
export const DEFAULT_MAX_TOTAL_BYTES = 100 * 1024 * 1024

const USER_AGENT = 'qq-bridge/1.0 (image fetcher)'

/* ────────────────────────────────────────────────────────────────────────
 * 图片段提取
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 从消息段数组里挑出图片段，取出可下载的线索。
 *
 * OneBot v11 的图片段长这样（SnowLuma 实测）：
 *   `{ type:'image', data:{ file:'<缓存 id>', url:'https://…rkey=…', … } }`
 *
 * ⚠️ **`url` 里的 rkey 会过期**。所以这里同时保留 `file` / `file_id`，
 *    下载失败时可以回头调 `get_image` 换一个新地址（见 refreshImageUrl）。
 *
 * @returns {Array<{url:string, file:string, fileId:string, summary:string}>}
 */
export function extractImageRefs(segments) {
  const out = []
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue
    if (String(seg.type ?? '') !== 'image') continue
    const data = seg.data ?? {}
    out.push({
      url: typeof data.url === 'string' ? data.url : '',
      file: typeof data.file === 'string' ? data.file : '',
      fileId: typeof data.file_id === 'string' ? data.file_id : '',
      summary: typeof data.summary === 'string' ? data.summary : '',
    })
  }
  return out
}

/* ────────────────────────────────────────────────────────────────────────
 * 格式嗅探（**看字节，不看扩展名**）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 按魔数判断图片类型；不是这四种之一就返回 null。
 *
 * 为什么必须看字节而不是信 `Content-Type` / 扩展名：两者都由**发送方**
 * 或中间服务器控制，可以随便写。DSH 那边存附件时也是按魔数校验的，
 * 这里先判一次能在下载阶段就把"其实是个 HTML/压缩包"的东西挡掉。
 */
export function sniffImageMediaType(bytes) {
  const b = bytes
  if (!b || typeof b.byteLength !== 'number' || b.byteLength < 4) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  // GIF87a / GIF89a
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  // RIFF....WEBP
  if (
    b.byteLength >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

/* ────────────────────────────────────────────────────────────────────────
 * SSRF 防护
 * ──────────────────────────────────────────────────────────────────────── */

function ipv4ToInt(ip) {
  const parts = String(ip).split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const v = Number(p)
    if (!Number.isInteger(v) || v < 0 || v > 255) return null
    n = ((n << 8) + v) >>> 0
  }
  return n >>> 0
}

function inCidr(n, base, bits) {
  const b = ipv4ToInt(base)
  if (b === null) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((n & mask) >>> 0) === ((b & mask) >>> 0)
}

/**
 * 这个 IP 是不是"不该被请求"的地址。
 *
 * 覆盖：回环、私有、链路本地、CGNAT、组播、保留段，以及 IPv6 的
 * 回环 / 唯一本地 / 链路本地 / 组播，**和 IPv4 映射进 IPv6 的写法**
 * （`::ffff:127.0.0.1` 与 `::ffff:7f00:1` 两种都要认）。
 *
 * 不是合法 IP 时返回 true（**fail-closed**：判断不了就当它不安全）。
 */
export function ipIsPrivate(ip) {
  const kind = isIP(String(ip))
  if (kind === 4) {
    const n = ipv4ToInt(ip)
    if (n === null) return true
    return (
      inCidr(n, '0.0.0.0', 8) ||        // 本网络
      inCidr(n, '10.0.0.0', 8) ||       // 私有
      inCidr(n, '100.64.0.0', 10) ||    // CGNAT
      inCidr(n, '127.0.0.0', 8) ||      // 回环
      inCidr(n, '169.254.0.0', 16) ||   // 链路本地（云元数据 169.254.169.254 在这里）
      inCidr(n, '172.16.0.0', 12) ||    // 私有
      inCidr(n, '192.0.0.0', 24) ||     // IETF 保留
      inCidr(n, '192.0.2.0', 24) ||     // TEST-NET-1
      inCidr(n, '192.88.99.0', 24) ||   // 6to4 中继
      inCidr(n, '192.168.0.0', 16) ||   // 私有
      inCidr(n, '198.18.0.0', 15) ||    // 基准测试
      inCidr(n, '198.51.100.0', 24) ||  // TEST-NET-2
      inCidr(n, '203.0.113.0', 24) ||   // TEST-NET-3
      inCidr(n, '224.0.0.0', 4) ||      // 组播
      inCidr(n, '240.0.0.0', 4)         // 保留（含 255.255.255.255）
    )
  }
  if (kind === 6) {
    const low = String(ip).toLowerCase()
    const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(low)
    if (dotted) return ipIsPrivate(dotted[1])
    const hexed = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(low)
    if (hexed) {
      const hi = parseInt(hexed[1], 16)
      const lo = parseInt(hexed[2], 16)
      return ipIsPrivate([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.'))
    }
    if (low === '::' || low === '::1') return true
    if (/^f[cd][0-9a-f]{2}:/.test(low)) return true // fc00::/7 唯一本地
    if (/^fe[89ab][0-9a-f]:/.test(low)) return true // fe80::/10 链路本地
    if (/^ff[0-9a-f]{2}:/.test(low)) return true // 组播
    return false
  }
  return true
}

/** 内网/本机专用主机名（这类名字解析出来也常指向内网，直接拒）。 */
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa']

async function defaultResolveHost(host) {
  const rows = await dnsLookup(host, { all: true })
  return rows.map((r) => r.address)
}

/**
 * 这个 URL 能不能去请求。**只做判断，不发请求。**
 *
 * @returns {Promise<{ok:true, url:URL} | {ok:false, reason:string}>}
 */
export async function assertFetchableUrl(raw, { resolveHost } = {}) {
  let url
  try {
    url = new URL(String(raw ?? ''))
  } catch {
    return { ok: false, reason: '不是合法的 URL' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `只允许 http/https（收到 ${url.protocol}）` }
  }
  // URL 里的 IPv6 主机名带方括号，去掉再判断
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const low = host.toLowerCase()
  if (!low) return { ok: false, reason: 'URL 没有主机名' }
  if (low === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => low.endsWith(s))) {
    return { ok: false, reason: `拒绝内网主机名 ${host}` }
  }
  if (isIP(host)) {
    if (ipIsPrivate(host)) return { ok: false, reason: `拒绝内网/回环地址 ${host}` }
    return { ok: true, url }
  }
  let addrs
  try {
    addrs = await (resolveHost ?? defaultResolveHost)(host)
  } catch (error) {
    return { ok: false, reason: `域名解析失败：${host}（${error?.message ?? error}）` }
  }
  if (!Array.isArray(addrs) || addrs.length === 0) {
    return { ok: false, reason: `域名解析不到地址：${host}` }
  }
  for (const a of addrs) {
    if (ipIsPrivate(a)) return { ok: false, reason: `域名 ${host} 解析到内网地址 ${a}` }
  }
  return { ok: true, url }
}

/** 把响应体读进内存，**边读边卡上限**（不能等读完再检查）。 */
async function readCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    // 没有流可用时的兜底：一次性读完再检查。
    // 这条路径**无法中途止损**，所以只在流缺失时走（正常情况不会）。
    let buf
    try {
      buf = new Uint8Array(await res.arrayBuffer())
    } catch (error) {
      return { ok: false, reason: `读取响应失败：${error?.message ?? error}` }
    }
    if (buf.byteLength > maxBytes) {
      return { ok: false, reason: `图片超过上限（${buf.byteLength} > ${maxBytes} 字节）` }
    }
    return { ok: true, value: buf }
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        try {
          await reader.cancel()
        } catch {
          /* 尽力而为 */
        }
        return { ok: false, reason: `图片超过上限（> ${maxBytes} 字节）` }
      }
      chunks.push(value)
    }
  } catch (error) {
    return { ok: false, reason: `读取响应失败：${error?.message ?? error}` }
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return { ok: true, value: out }
}

/**
 * 下载一张图片，返回原始字节（**不落盘、不信任类型**）。
 *
 * 重定向**手动**跟随：每一跳都要重新过一遍 assertFetchableUrl。
 * 用 `redirect:'follow'` 会让 fetch 自己去跳，我们就失去了逐跳校验的机会。
 */
export async function fetchImageBytes(rawUrl, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    resolveHost,
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
  } = options

  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: '当前运行时没有 fetch，无法下载图片' }
  }

  let current = String(rawUrl ?? '')
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = await assertFetchableUrl(current, { resolveHost })
    if (!check.ok) return { ok: false, reason: `地址被拒绝：${check.reason}` }

    let res
    try {
      res = await fetchImpl(check.url, {
        redirect: 'manual',
        headers: { 'user-agent': USER_AGENT, accept: 'image/*' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const name = error?.name ?? ''
      const why = name === 'TimeoutError' ? `超时（${timeoutMs}ms）` : (error?.message ?? String(error))
      return { ok: false, reason: `下载失败：${why}` }
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = typeof res.headers?.get === 'function' ? res.headers.get('location') : null
      if (!loc) return { ok: false, reason: `HTTP ${res.status} 重定向但没有 Location` }
      try {
        current = new URL(loc, check.url).toString()
      } catch {
        return { ok: false, reason: `重定向目标不是合法 URL：${loc}` }
      }
      continue
    }

    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }

    const declared = Number(
      typeof res.headers?.get === 'function' ? res.headers.get('content-length') : NaN,
    )
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, reason: `图片太大（声明 ${declared} 字节 > 上限 ${maxBytes}）` }
    }

    const read = await readCapped(res, maxBytes)
    if (!read.ok) return read
    return { ok: true, bytes: read.value, url: String(check.url) }
  }
  return { ok: false, reason: `重定向次数超过上限（${maxRedirects}）` }
}

/* ────────────────────────────────────────────────────────────────────────
 * inbox：内容寻址落盘 + 清理
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 工作区里的图片暂存目录。
 *
 * ── 为什么文件名是**内容哈希** ──────────────────────────────────────────
 * QQ 里同一个表情包会反复出现。内容寻址让"同一张图只存一份"变成
 * 天然行为，不需要额外去重表，也不会因为重复发图把磁盘吃满。
 *
 * ── 为什么不放在沙箱外 ──────────────────────────────────────────────────
 * 模型的 `read_image` 受它自己的文件沙箱约束（根 = 工作区）。
 * 放到工作区外面它就**读不到**，那这个功能就废了。
 * 代价是"发图 = 桥接往工作区写文件"，所以清理策略是**必需项**，不是可选。
 */
export function createImageInbox({ workspace, log = () => {}, now = () => Date.now() } = {}) {
  const root = String(workspace ?? '')
  const dir = root ? join(root, IMAGE_DIR) : ''

  function ensureDir() {
    if (!dir) throw new Error('没有工作区，无法存放图片')
    mkdirSync(dir, { recursive: true })
  }

  /** 目录里的现存文件（跳过子目录与打不开的项）。 */
  function entries() {
    if (!dir || !existsSync(dir)) return []
    const out = []
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      try {
        const st = statSync(abs)
        if (!st.isFile()) continue
        out.push({ name, abs, size: st.size, mtimeMs: st.mtimeMs })
      } catch {
        /* 正在被删/权限问题：跳过，不影响收消息 */
      }
    }
    return out
  }

  /**
   * 存一张图。内容相同 → 复用已有文件（`deduped: true`）。
   *
   * 用 `flag: 'wx'` 而不是先 `existsSync` 再写：并发两轮同时收到同一张图时，
   * "先查后写"会两边都判断"不存在"然后一起写 —— 用 O_EXCL 让内核来裁决。
   */
  function save(bytes, mediaType) {
    const ext = MEDIA_TYPE_EXT[mediaType]
    if (!ext) return { ok: false, reason: `不支持的类型 ${mediaType ?? '(未知)'}` }
    if (!bytes || !bytes.byteLength) return { ok: false, reason: '图片内容为空' }
    try {
      ensureDir()
    } catch (error) {
      return { ok: false, reason: error.message }
    }
    const sha = createHash('sha256').update(bytes).digest('hex')
    const name = `${sha.slice(0, 16)}.${ext}`
    const abs = join(dir, name)
    const relPath = `${IMAGE_DIR}/${name}`
    try {
      writeFileSync(abs, bytes, { flag: 'wx' })
      return { ok: true, name, relPath, absPath: abs, bytes: bytes.byteLength, deduped: false }
    } catch (error) {
      if (error?.code === 'EEXIST') {
        let size = bytes.byteLength
        try {
          size = statSync(abs).size
        } catch {
          /* 用内存里的长度兜底 */
        }
        return { ok: true, name, relPath, absPath: abs, bytes: size, deduped: true }
      }
      return { ok: false, reason: `写入失败：${error?.message ?? error}` }
    }
  }

  /**
   * 清理：先按时间删过期的，再按总量删最旧的。
   *
   * ⚠️ 删除**必须用 `unlinkSync`**。实测在 Windows 上 `rmSync` 删单个文件
   * 会静默失败（返回正常但文件还在）—— 那个坑已经在 memory-files.mjs 里
   * 踩过一次，这里不重复踩。
   */
  function prune(options = {}) {
    const retentionHours = options.retentionHours ?? DEFAULT_RETENTION_HOURS
    const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES
    const removed = []

    const cutoff = now() - retentionHours * 3600_000
    for (const e of entries()) {
      if (e.mtimeMs >= cutoff) continue
      try {
        unlinkSync(e.abs)
        removed.push(e.name)
      } catch {
        /* 删不掉就留着，下一轮再试 */
      }
    }

    let list = entries()
    let total = list.reduce((s, e) => s + e.size, 0)
    if (total > maxTotalBytes) {
      for (const e of [...list].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
        if (total <= maxTotalBytes) break
        try {
          unlinkSync(e.abs)
          total -= e.size
          removed.push(e.name)
        } catch {
          /* 同上 */
        }
      }
      list = entries()
      total = list.reduce((s, e) => s + e.size, 0)
    }
    if (removed.length > 0) {
      log(`[image] 清理 inbox：删除 ${removed.length} 个文件，剩余 ${list.length} 个 / ${total} 字节`)
    }
    return { removed, kept: list.length, totalBytes: total }
  }

  return { dir, save, prune, entries }
}

/* ────────────────────────────────────────────────────────────────────────
 * 收图主流程
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 把 OneBot 的 `get_image` 结果变成可下载地址。
 *
 * 为什么需要：事件里那个 `url` 带 **rkey**，几分钟后就失效。
 * `get_image` 会重新签一个当前有效的地址（这是 SnowLuma 自己的说明：
 * "`ctx.getImageInfo` … mints a current rkey"）。
 */
export async function refreshImageUrl(call, ref) {
  const key = String(ref?.file || ref?.fileId || '')
  if (!key || typeof call !== 'function') return ''
  try {
    const data = await call('get_image', { file: key })
    const url = data?.url ?? data?.file
    return typeof url === 'string' && /^https?:/i.test(url) ? url : ''
  } catch {
    // 刷新失败是**正常情况**（图片可能已过缓存期），不往上抛
    return ''
  }
}

/**
 * 处理一条消息里的所有图片。
 *
 * @param {object} opts
 * @param {Array} opts.refs           extractImageRefs 的结果
 * @param {object} opts.inbox         createImageInbox 的产物
 * @param {object} [opts.fetchOptions] 传给 fetchImageBytes 的注入项（测试用）
 * @param {Function} [opts.call]      OneBot call（用于刷新过期 url）
 * @param {number} [opts.maxCount]    最多处理几张
 * @param {Function} [opts.log]
 * @returns {Promise<Array<{ok:boolean, relPath?:string, absPath?:string, mediaType?:string,
 *                          bytes?:number, deduped?:boolean, reason?:string, base64?:string,
 *                          withBase64?:boolean}>>}
 */
export async function collectImages(opts) {
  const {
    refs = [],
    inbox,
    fetchOptions = {},
    call = null,
    maxCount = 4,
    withBase64 = false,
    log = () => {},
  } = opts ?? {}

  const results = []
  const limited = refs.slice(0, Math.max(0, maxCount))
  for (let i = 0; i < limited.length; i++) {
    const ref = limited[i]
    results.push(await collectOne({ ref, inbox, fetchOptions, call, withBase64, log }))
  }
  return results
}

async function collectOne({ ref, inbox, fetchOptions, call, withBase64, log }) {
  const urls = []
  if (ref?.url) urls.push(ref.url)

  let lastReason = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const target = urls[attempt]
    if (!target) break

    const got = await fetchImageBytes(target, fetchOptions)
    if (!got.ok) {
      lastReason = got.reason
      // 第一次失败 → 试着用 file/file_id 换一个新地址再试一次。
      // （rkey 过期是**最常见**的失败原因，不是异常路径。）
      if (attempt === 0 && call) {
        const fresh = await refreshImageUrl(call, ref)
        if (fresh && fresh !== target) {
          log('[image] 下载失败，已用 get_image 换新地址重试')
          urls.push(fresh)
        }
      }
      continue
    }

    const mediaType = sniffImageMediaType(got.bytes)
    if (!mediaType) {
      return { ok: false, reason: '不是支持的图片格式（只收 PNG/JPEG/WebP/GIF）' }
    }
    const saved = inbox.save(got.bytes, mediaType)
    if (!saved.ok) return { ok: false, reason: saved.reason }
    const out = {
      ok: true,
      relPath: saved.relPath,
      absPath: saved.absPath,
      mediaType,
      bytes: saved.bytes,
      deduped: saved.deduped,
    }
    if (withBase64) {
      // ⚠️ 只在 auto 模式下才转 base64：它让内存里多一份图片副本，
      //    而且 base64 会进 JSON 帧（体积 ×1.33）。
      out.base64 = Buffer.from(got.bytes).toString('base64')
      out.withBase64 = true
    }
    return out
  }

  return { ok: false, reason: lastReason || '没有可用的图片地址' }
}
