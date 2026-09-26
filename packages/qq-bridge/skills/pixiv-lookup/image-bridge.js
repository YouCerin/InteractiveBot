// pixiv-lookup 本地图片桥（image bridge）
//
// ── 这个文件解决什么问题 ──────────────────────────────────────────────────
// Pixiv 的图床 i.pximg.net 有两个硬门槛，宿主的 send_image 一个都过不去：
//   ① **防盗链**：不带 `Referer: https://www.pixiv.net/` 一律 403
//      （实测：不带 → 548 字节的错误页；带上 → 1.07MB 的正常 jpeg）；
//   ② **要代理**：中国大陆直连 i.pximg.net 连不上，而宿主的图片下载通道
//      既不认系统代理、也没有 Referer 设置。
// 结果就是老版本的真实体验：模型能查到作品、能贴出网页链接，但**发不出图**，
// 群里只能干看着一句"图我这边发不出来"。
//
// 顺带还有第三个坑：宿主的图片下载通道带 SSRF 保护（默认拒绝解析到"内网/本机"
// 的地址）。装了 Clash/mihomo 这类代理并开着 **fake-ip** 时，DNS 会把域名解析成
// 198.18.0.0/15 的虚拟 IP —— 正好落在"内网"名单里，于是**所有**图片下载
// （连百度图床、QQ 表情包都算）一起报「域名解析到内网/本机地址，已阻止」。
//
// 解决办法：本模块在 **127.0.0.1** 上开一个极小的 HTTP 服务，由插件自己
// （带 Referer、走插件自己的代理）把图取回来，再交给宿主下载。对宿主来说，
// 这只是一条普通的图片直链 —— 不需要给宿主打补丁，也不需要动任何全局设置。
//
// ── 安全设计（这块不能省）────────────────────────────────────────────────
//   · **只监听 127.0.0.1**：外网/局域网都连不上，别人扫不到；
//   · **只服务本进程刚生成的随机 id**：id 是 18 字节随机数（≈144 位），
//     只存在内存里、只在这一条直链上有效，模型/群友编不出来；
//   · **只允许 pximg 域名**：id 对应的地址在生成时就已经校验过，
//     取图时再校验一次 —— 这个服务无论如何都变不成"任意 URL 代理"；
//   · **只读、只回图片字节**：不吃参数、不落盘、不返回本地文件内容；
//   · 直链有有效期（默认 30 分钟），响应带 `Cache-Control: no-store`，
//     并限制单张大小与总缓存量。
//
// ⚠️ 宿主侧还需要一个开关：`security.allowPrivateImageHosts = true`
//    （设置 → 安全 → 允许下载内网/本机图片地址）。宿主的 SSRF 保护默认
//    拒绝 127.0.0.1，不开这个开关的话，本桥的直链会被宿主自己挡掉
//    （报的正是「图片下载失败：域名解析到内网/本机地址，已阻止」）。
//    这个开关的语义就是"我信任本机上的图源"，正是为自建图床/本地桥准备的。

import http from 'node:http'
import crypto from 'node:crypto'

/** pximg 域名白名单（i.pximg.net / s.pximg.net / 任何 *.pximg.net）。 */
const PXIMG_HOST = /(^|\.)pximg\.net$/i

/** 直链路径：/i/<随机 id> */
const LINK_PATH = /^\/i\/([A-Za-z0-9_-]{8,64})$/

export const DEFAULT_TTL_SEC = 1800        // 直链有效期：30 分钟
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
export const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024

/** 这个 URL 是不是 Pixiv 图床地址（桥只认它）。 */
export function isPixivImageUrl(raw) {
  try {
    const u = new URL(String(raw == null ? '' : raw).trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (u.username || u.password) return false
    return PXIMG_HOST.test(u.hostname)
  } catch {
    return false
  }
}

/**
 * 把 Pixiv 的**缩略图**地址换算成同一张图的 **master1200 大图**地址。
 *
 * 为什么需要：搜索/榜单接口只给缩略图（`/c/250x250_80_a2/...`），
 * 那个尺寸（250×250 方形裁切）发到群里又糊又被裁；而 Pixiv 的路径规则是公开的 ——
 *   去掉 `/c/<尺寸>_<质量>[_a2]/` 前缀，再把 `_square1200`/`_custom1200`
 *   换成 `_master1200`，就得到长边 1200 的大图，不需要额外调一次接口。
 *
 * 例：https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/09/24/05/41/55/150039929_p0_square1200.jpg
 *  →  https://i.pximg.net/img-master/img/2026/09/24/05/41/55/150039929_p0_master1200.jpg
 *
 * 换算不出来（形状不认识）就原样返回 —— 宁可用缩略图，也不要给个坏地址。
 */
export function masterFromThumb(raw) {
  const src = String(raw == null ? '' : raw).trim()
  if (!isPixivImageUrl(src)) return src
  try {
    const u = new URL(src)
    // 去掉 /c/<size>/ 这一段（它只表示"要哪种缩略尺寸"）
    let p = u.pathname.replace(/^\/c\/[^/]+\//, '/')
    // 缩略图的 `_square1200` / `_custom1200` → 大图的 `_master1200`
    p = p.replace(/_(square|custom)1200(\.[a-z0-9]+)$/i, '_master1200$2')
    u.pathname = p
    return u.toString()
  } catch {
    return src
  }
}

/**
 * 建一个图片桥。
 *
 * @param {object} opts
 * @param {(url:string)=>Promise<{buffer:Buffer, contentType:string}>} opts.fetchImage
 *        真正去取图的函数（由 index.js 注入：带 Referer、走插件自己的代理）。
 *        **必须注入** —— 本模块自己不联网，这样测试里可以换成假实现。
 * @param {(msg:string)=>void} [opts.log]  状态日志
 * @param {(msg:string)=>void} [opts.warn] 异常日志（取图失败等）
 * @param {number} [opts.ttlSec]           直链有效期（秒）
 * @param {number} [opts.maxBytes]         单张上限
 * @param {number} [opts.cacheMaxBytes]    内存缓存上限
 * @param {number} [opts.fetchTimeoutMs]   取图超时
 */
export function createImageBridge(opts = {}) {
  const fetchImage = opts.fetchImage
  if (typeof fetchImage !== 'function') throw new Error('createImageBridge 需要 fetchImage 函数')
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {}
  const ttlSec = Math.max(30, Number(opts.ttlSec) || DEFAULT_TTL_SEC)
  const maxBytes = Math.max(64 * 1024, Number(opts.maxBytes) || DEFAULT_MAX_BYTES)
  const cacheMaxBytes = Math.max(maxBytes, Number(opts.cacheMaxBytes) || DEFAULT_CACHE_BYTES)
  const fetchTimeoutMs = Math.max(3000, Number(opts.fetchTimeoutMs) || 30000)
  const listenHost = String(opts.listenHost || '127.0.0.1')

  let server = null
  let port = 0
  let starting = null
  let lastError = ''
  let served = 0
  const tickets = new Map()    // id -> { u, e }      直链 → 目标图片地址
  const cache = new Map()      // url -> { buffer, contentType, at }
  let cacheBytes = 0

  const now = () => Date.now()

  /** 过期直链清理（每次发新直链时顺手做，代价可忽略）。 */
  function pruneTickets() {
    const t = now()
    for (const [id, tk] of tickets) if (tk.e <= t) tickets.delete(id)
  }

  function cachePut(url, buffer, contentType) {
    const old = cache.get(url)
    if (old) cacheBytes -= old.buffer.length
    cache.set(url, { buffer, contentType, at: now() })
    cacheBytes += buffer.length
    // 超上限就从最旧的开始丢（Map 按插入顺序迭代）
    while (cacheBytes > cacheMaxBytes && cache.size > 1) {
      const [k, v] = cache.entries().next().value
      cache.delete(k)
      cacheBytes -= v.buffer.length
    }
  }

  function cacheGet(url) {
    const hit = cache.get(url)
    if (!hit) return null
    if (now() - hit.at > ttlSec * 1000) { cache.delete(url); cacheBytes -= hit.buffer.length; return null }
    return hit
  }

  /**
   * 生成一条宿主可以直接下载的本地直链。
   * 参数不合法 / 桥没起来 → 返回 ''（调用方只是少一个字段，不影响查询本身）。
   */
  function link(rawUrl, { ttl } = {}) {
    if (!server || !port) return ''
    const url = String(rawUrl == null ? '' : rawUrl).trim()
    if (!isPixivImageUrl(url)) return ''
    // 18 字节随机 → 24 个 base64url 字符。够长（144 位）、够短（模型抄链接不容易抄错）。
    const id = crypto.randomBytes(18).toString('base64url')
    const life = Math.max(30, Number(ttl) || ttlSec)
    if (tickets.size > 500) pruneTickets()
    tickets.set(id, { u: url, e: now() + life * 1000 })
    return `http://${listenHost}:${port}/i/${id}`
  }

  /** 直链里带的 id 现在还有效吗（诊断/测试用）。 */
  function ticketInfo(id) {
    const tk = tickets.get(String(id || ''))
    if (!tk) return null
    return { url: tk.u, expiresAt: tk.e, expired: tk.e <= now() }
  }

  function send(res, code, contentType, body) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8')
    try {
      res.writeHead(code, { 'Content-Type': contentType, 'Content-Length': buf.length, 'Cache-Control': 'no-store' })
      res.end(buf)
    } catch { /* 客户端提前断开，忽略 */ }
  }

  async function serveImage(res, id, headOnly) {
    // ① 认 id（id 本身就是不可猜的凭证：只在本进程内存里，且只对应一张 pximg 图）
    const tk = tickets.get(id)
    if (!tk) {
      lastError = '直链不存在（或插件重启过）'
      return send(res, 404, 'text/plain; charset=utf-8', '这条图片直链不存在：可能已过期，或 QQ Agent 重启过。请让插件重新查一次图。')
    }
    if (tk.e <= now()) {
      tickets.delete(id)
      lastError = '直链已过期'
      return send(res, 410, 'text/plain; charset=utf-8', '这条图片直链已过期，请让插件重新查一次。')
    }
    const target = tk.u
    // ② 域名白名单（生成时校验过，这里再挡一道：桥永远只服务 pximg）
    if (!isPixivImageUrl(target)) {
      lastError = '非 pximg 地址被拒'
      return send(res, 403, 'text/plain; charset=utf-8', '本服务只提供 Pixiv 图床（pximg.net）的图片。')
    }

    // ③ 命中缓存直接回（模型常会先 preview 再正式发，同一张图会被下载两次）
    const hit = cacheGet(target)
    if (hit) {
      served++
      return send(res, 200, hit.contentType, headOnly ? Buffer.alloc(0) : hit.buffer)
    }

    // ④ 真去取图（带 Referer + 插件自己的代理）
    let out
    try {
      out = await Promise.race([
        fetchImage(target),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`取图超时（${fetchTimeoutMs}ms）`)), fetchTimeoutMs)),
      ])
    } catch (e) {
      const msg = String((e && e.message) || e)
      lastError = msg
      warn(`图片桥取图失败：${msg}`)
      return send(res, 502, 'text/plain; charset=utf-8', `图片桥取图失败：${msg}`)
    }
    const buffer = out && out.buffer
    if (!Buffer.isBuffer(buffer) || !buffer.length) {
      lastError = '取到空内容'
      return send(res, 502, 'text/plain; charset=utf-8', '图片桥取到空内容。')
    }
    if (buffer.length > maxBytes) {
      lastError = `图片超过上限（${Math.round(buffer.length / 1024 / 1024)}MB）`
      return send(res, 413, 'text/plain; charset=utf-8', `图片 ${Math.round(buffer.length / 1024 / 1024)}MB，超过本桥上限 ${Math.round(maxBytes / 1024 / 1024)}MB。`)
    }
    const contentType = String((out && out.contentType) || 'image/jpeg').split(';')[0].trim() || 'image/jpeg'
    cachePut(target, buffer, contentType)
    served++
    lastError = ''
    return send(res, 200, contentType, headOnly ? Buffer.alloc(0) : buffer)
  }

  function onRequest(req, res) {
    let url
    try { url = new URL(req.url || '/', `http://${listenHost}`) } catch { return send(res, 400, 'text/plain; charset=utf-8', 'bad request') }
    const method = String(req.method || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', '只支持 GET')
    if (url.pathname === '/ping') return send(res, 200, 'text/plain; charset=utf-8', 'pixiv-lookup image bridge ok')
    const m = LINK_PATH.exec(url.pathname)
    if (!m) return send(res, 404, 'text/plain; charset=utf-8', '这里只有插件生成的图片直链。')
    serveImage(res, m[1], method === 'HEAD').catch((e) => {
      lastError = String((e && e.message) || e)
      send(res, 500, 'text/plain; charset=utf-8', '图片桥内部错误')
    })
  }

  /** 启动（幂等；并发调用只会 listen 一次）。成功返回端口，失败返回 0。 */
  async function start({ preferredPort = 0 } = {}) {
    if (server && port) return port
    if (starting) return starting
    starting = (async () => {
      const tryListen = (p) => new Promise((resolve, reject) => {
        const s = http.createServer(onRequest)
        const onErr = (e) => { try { s.close() } catch { /* ignore */ } reject(e) }
        s.once('error', onErr)
        s.listen(p, listenHost, () => {
          s.removeListener('error', onErr)
          s.on('error', (e) => warn(`图片桥出错：${(e && e.message) || e}`))
          server = s
          const addr = s.address()
          port = addr && addr.port ? addr.port : p
          // 不让这个监听句柄拖住宿主进程退出（它只是插件的一部分）
          try { s.unref() } catch { /* ignore */ }
          log(`图片桥已启动：http://${listenHost}:${port}`)
          resolve(port)
        })
      })
      try {
        return await tryListen(Number(preferredPort) || 0)
      } catch (e) {
        if (Number(preferredPort)) {
          warn(`图片桥端口 ${preferredPort} 用不了（${(e && e.message) || e}），改用系统随机端口`)
          try { return await tryListen(0) } catch (e2) {
            lastError = String((e2 && e2.message) || e2)
            warn(`图片桥启动失败：${lastError}`)
            return 0
          }
        }
        lastError = String((e && e.message) || e)
        warn(`图片桥启动失败：${lastError}`)
        return 0
      } finally {
        starting = null
      }
    })()
    return starting
  }

  /** 关闭并清空缓存（插件被停用/重载时调用）。 */
  function stop() {
    tickets.clear()
    cache.clear()
    cacheBytes = 0
    const s = server
    server = null
    port = 0
    if (s) { try { s.close() } catch { /* ignore */ } }
    return true
  }

  function stats() {
    return {
      running: !!(server && port),
      port,
      base: server && port ? `http://${listenHost}:${port}` : '',
      tickets: tickets.size,
      cached: cache.size,
      cachedBytes: cacheBytes,
      served,
      ttlSec,
      maxBytes,
      lastError,
    }
  }

  return { start, stop, link, stats, ticketInfo, isPixivImageUrl, masterFromThumb }
}
