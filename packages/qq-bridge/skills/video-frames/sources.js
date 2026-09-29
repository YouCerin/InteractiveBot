// 视频来源解析：把模型给的 `source` 变成"一个 ffmpeg 能读的本地文件"。
//
// 支持两种来源：
//   · **工作区内的相对路径**（例如 `inbox/a.mp4`）→ 收束后直接用
//   · **http(s) 直链** → 自己下载到系统临时目录，抽完帧就删
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么下载这件事由技能自己做，而且必须自带一整套 SSRF 守卫
// ══════════════════════════════════════════════════════════════════════════
// 上游那份插件的文件头把这条路想清楚了，这里照抄它的结论：
// **绝不让 ffmpeg 自己去读 http URL**。理由是 SSRF —— URL 来自消息发送方，
// 而 ffmpeg 会自己解析 DNS、自己连接，我们没有任何机会插一道校验。
// 所以顺序是：我们先校验 + 下载 + 落盘，再对**本地文件**抽帧。
//
// 本宿主有一个现成的安全下载器（`src/images.mjs` 的 `fetchImageBytes`），
// 但技能**不能 import 宿主的 src/**（技能契约是"整目录拷走还能跑"，
// 见 `docs/插件设计规范.md` §11；`mocks/verify-sticker-skill.mjs` 里还有一条
// 断言专门盯这个）。所以这里**刻意复制了同一套规则**。两处规则的唯一权威
// 仍然是 `src/images.mjs`（那边改了这边要跟着改）—— 规则清单：
//   ① 只允许 http/https
//   ② **逐跳**校验重定向目标（`redirect:'manual'` 自己跟，用 `follow` 就失去校验机会）
//   ③ 拒绝回环 / 私有 / 链路本地 / CGNAT / 组播 / 保留地址，
//      含 `::ffff:127.0.0.1` 与 `::ffff:7f00:1` 两种 IPv4 映射写法
//   ④ 域名**先解析**，任何一个解析结果落在内网就拒（挡 `127.0.0.1.nip.io` 这类）
//   ⑤ 大小上限 + 超时 + 重定向次数上限（读的时候边读边卡，不能读完再查）
//
// ── 与宿主那套**刻意不一样**的一格（重要，别以为漏了）────────────────────
// `src/images.mjs` 有一个逃生口 `security.allowPrivateImageHosts`：
// 打开后允许取内网/本机地址。**本技能不提供这个口子**，理由：
//   · 宿主的 `qq_send_image` 是 **adminOnly** 的，所以那个口子只对管理员敞开；
//   · 技能工具的调用里**没有调用者身份**（MCP 的 `tools/call` 只有 name+arguments，
//     见 `mcp/mcp-skills-server.mjs` 的注释），我们无法"只对管理员放开"；
//   · 而这个工具对普通用户可用（`permission: 'read'`）。
// 三条加起来的结论是：一旦照抄那个口子，就等于给**任何群友**一个探测内网的探针。
// 代价是"内网视频"这条路走不通 —— 那种需求用**工作区相对路径**那条路（把文件放进工作区）代替。
//
// ── 如实记录的已知边界 ────────────────────────────────────────────────────
// ③④ 是"解析时校验"，而 fetch 会**再解析一次**，理论上存在 DNS rebinding 的窗口。
// 要彻底堵住得把解析结果钉住再连接（自建 agent + 指定 IP），代价明显更大。
// 这条边界与 `src/images.mjs` 顶部写的是同一句实话，不写成"已经完全防住"。

import { mkdirSync, rmSync, writeSync, closeSync, openSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { lookup as dnsLookup } from 'node:dns/promises'

import { resolveInsideWorkspace } from './workspace.js'

/** 默认上限：单个视频最多下载多少字节（可被设置项覆盖）。 */
export const DEFAULT_MAX_SOURCE_BYTES = 200 * 1024 * 1024
/** 默认下载超时。 */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000
/** 重定向最多跟几跳。 */
export const DEFAULT_MAX_REDIRECTS = 3
/** 下载时自报的身份。 */
export const USER_AGENT = 'interactbot-video-frames/1.0 (+skill)'

/* ────────────────────────────────────────────────────────────────────────
 * 地址判定（与 src/images.mjs 同一套阈值）
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
 * 不是合法 IP 时返回 true（**fail-closed**：判断不了就当它不安全）。
 */
export function ipIsPrivate(ip) {
  const kind = isIP(String(ip))
  if (kind === 4) {
    const n = ipv4ToInt(ip)
    if (n === null) return true
    return (
      inCidr(n, '0.0.0.0', 8) ||
      inCidr(n, '10.0.0.0', 8) ||
      inCidr(n, '100.64.0.0', 10) || // CGNAT
      inCidr(n, '127.0.0.0', 8) ||
      inCidr(n, '169.254.0.0', 16) || // 云元数据 169.254.169.254 在这里
      inCidr(n, '172.16.0.0', 12) ||
      inCidr(n, '192.0.0.0', 24) ||
      inCidr(n, '192.0.2.0', 24) ||
      inCidr(n, '192.88.99.0', 24) ||
      inCidr(n, '192.168.0.0', 16) ||
      inCidr(n, '198.18.0.0', 15) ||
      inCidr(n, '198.51.100.0', 24) ||
      inCidr(n, '203.0.113.0', 24) ||
      inCidr(n, '224.0.0.0', 4) ||
      inCidr(n, '240.0.0.0', 4)
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

/**
 * 这段字节看着像不像"文本/网页"（而不是视频）。
 *
 * 为什么要这一条：下载器是**模型**驱动的，而模型的输入来自群友。
 * 最典型的一种坏情况是"让机器人去取一个内网接口的返回值"——
 * 那些响应是 HTML/JSON。FFmpeg 当然也解不出来，但那时视频已经**整个下载完**了
 * （最大 200MB），而错误信息还会含糊地说"没有产出可用画面"。
 * 这里在下载完成后立刻用一个便宜的判据挡掉，错误直接说清"这不是视频"。
 *
 * 判据刻意保守（宁可放过也不误杀）：整段字节必须**没有 NUL**、
 * 且可打印/空白字符占比 ≥ 95%，才算文本。真正的视频容器开头一定有二进制字节。
 */
export function looksLikeText(bytes, sample = 512) {
  const b = bytes && typeof bytes.byteLength === 'number' ? bytes : null
  if (!b || b.byteLength === 0) return false
  const n = Math.min(sample, b.byteLength)
  let printable = 0
  for (let i = 0; i < n; i += 1) {
    const c = b[i]
    if (c === 0) return false
    if (c === 9 || c === 10 || c === 13) printable += 1
    else if (c >= 32 && c < 127) printable += 1
    else if (c >= 0x80) printable += 1 // 多字节 UTF-8 也算"文本字符"，避免误杀中文页面
  }
  return printable / n >= 0.95
}

/* ────────────────────────────────────────────────────────────────────────
 * 下载（流式写盘，边写边卡上限）
 * ──────────────────────────────────────────────────────────────────────── */

/** 从 URL 猜一个扩展名（只为让文件名好看；ffmpeg 认的是内容，不是名字）。 */
function guessExt(url) {
  const m = /\.(mp4|m4v|mov|mkv|webm|avi|flv|wmv|ts|m2ts|mpg|mpeg|3gp|gif)$/i.exec(
    String(url?.pathname ?? ''),
  )
  return m ? `.${m[1].toLowerCase()}` : '.bin'
}

/**
 * 下载到一个临时文件。
 *
 * 为什么落盘而不是留在内存里：视频动辄几十上百 MB，上游注释里写的是
 * "上限 200MB" —— 那种东西读进内存再交给 ffmpeg 是没必要的浪费，
 * 而且会让"边读边卡上限"这条失去意义（内存已经吃满了）。
 *
 * @returns {Promise<{ok:true, path:string, bytes:number} | {ok:false, reason:string}>}
 */
export async function downloadToFile(rawUrl, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    resolveHost,
    dir,
    maxBytes = DEFAULT_MAX_SOURCE_BYTES,
    timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    onProgress,
  } = options

  if (typeof fetchImpl !== 'function') {
    return { ok: false, reason: '当前运行时没有 fetch，无法下载视频' }
  }
  mkdirSync(dir, { recursive: true })

  let current = String(rawUrl ?? '')
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const check = await assertFetchableUrl(current, { resolveHost })
    if (!check.ok) return { ok: false, reason: `地址被拒绝：${check.reason}` }

    let res
    try {
      res = await fetchImpl(check.url, {
        redirect: 'manual',
        headers: { 'user-agent': USER_AGENT, accept: 'video/*,application/octet-stream,*/*' },
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
      return { ok: false, reason: `视频太大（对方声明 ${declared} 字节 > 上限 ${maxBytes}）` }
    }

    const dest = join(dir, `source_${Date.now().toString(36)}${guessExt(check.url)}`)
    let total = 0
    let fd = null
    try {
      fd = openSync(dest, 'w')
      if (!res.body || typeof res.body.getReader !== 'function') {
        // 没有流可用的兜底：一次性读完再查（这条路径无法中途止损，正常不会走到）
        const buf = new Uint8Array(await res.arrayBuffer())
        if (buf.byteLength > maxBytes) {
          rmSync(dest, { force: true })
          return { ok: false, reason: `视频太大（${buf.byteLength} > 上限 ${maxBytes}）` }
        }
        writeSync(fd, buf)
        total = buf.byteLength
      } else {
        const reader = res.body.getReader()
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
            try {
              closeSync(fd)
            } catch {
              /* 忽略 */
            }
            fd = null
            rmSync(dest, { force: true })
            return { ok: false, reason: `视频超过上限（> ${maxBytes} 字节），已中止下载` }
          }
          writeSync(fd, value)
          if (typeof onProgress === 'function') onProgress(total)
        }
      }
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          /* 忽略 */
        }
      }
      rmSync(dest, { force: true })
      return { ok: false, reason: `写入临时文件失败：${error?.message ?? error}` }
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          /* 忽略 */
        }
      }
    }

    if (total === 0) {
      rmSync(dest, { force: true })
      return { ok: false, reason: '下载到 0 字节（对方返回了空响应）' }
    }
    return { ok: true, path: dest, bytes: total }
  }
  return { ok: false, reason: `重定向次数超过上限（${maxRedirects}）` }
}

/* ────────────────────────────────────────────────────────────────────────
 * 对外那一个函数：source → 本地文件
 * ──────────────────────────────────────────────────────────────────────── */

/** 临时下载目录（抽完帧就整个删掉）。 */
export function makeTempDir(prefix = 'video-frames') {
  const dir = join(tmpdir(), `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 删掉临时目录（尽力而为；删不掉不影响抽帧结果）。 */
export function cleanupTempDir(dir) {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

/**
 * 解析 `source`。
 *
 * @param {{source:string, workspaceRoot:string, maxBytes?:number, timeoutMs?:number,
 *          fetchImpl?:Function, resolveHost?:Function, tmpBase?:string}} opts
 * @returns {Promise<{ok:true, abs:string, rel:string, kind:'workspace'|'url', note:string,
 *                    cleanup:Function} | {ok:false, why:string}>}
 */
export async function resolveSource(opts = {}) {
  const { source, workspaceRoot } = opts
  const raw = String(source ?? '').trim()
  if (!raw) return { ok: false, why: '没给 source：请给工作区内的相对路径（例如 inbox/a.mp4），或一条 http(s) 视频直链。' }

  if (/^https?:\/\//i.test(raw)) {
    const dir = makeTempDir()
    const got = await downloadToFile(raw, {
      fetchImpl: opts.fetchImpl,
      resolveHost: opts.resolveHost,
      dir,
      maxBytes: opts.maxBytes,
      timeoutMs: opts.timeoutMs,
    })
    if (!got.ok) {
      cleanupTempDir(dir)
      return { ok: false, why: got.reason }
    }
    // 落盘后再做一次"这是不是文本"的判据（只看开头 512 字节，代价可忽略）
    try {
      const head = await readHead(got.path, 512)
      if (looksLikeText(head)) {
        cleanupTempDir(dir)
        return {
          ok: false,
          why: '这个地址返回的**不是视频**（看起来是网页/文本/JSON）。如果它是某个接口或页面地址，请换成真正的视频直链，或把视频文件放进工作区再给相对路径。',
        }
      }
    } catch {
      /* 读不出来就交给 ffmpeg 去报错 */
    }
    const abs = got.path
    return {
      ok: true,
      abs,
      rel: '',
      kind: 'url',
      note: `已下载到临时文件（${(got.bytes / 1024 / 1024).toFixed(1)}MB），抽完帧会删掉`,
      cleanup: () => cleanupTempDir(dir),
    }
  }

  const local = resolveInsideWorkspace(workspaceRoot, raw)
  if (!local.ok) return { ok: false, why: local.why }
  return { ok: true, abs: local.abs, rel: local.rel, kind: 'workspace', note: '工作区里的文件', cleanup: () => {} }
}

/** 读文件开头 N 字节（不把整个文件读进来）。 */
async function readHead(file, n) {
  const { open } = await import('node:fs/promises')
  const fh = await open(file, 'r')
  try {
    const buf = new Uint8Array(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}
