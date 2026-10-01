// QQ 空间动态 —— **自包含** Skill（QQ Agent 0.3.1 规范）
//
// 这个文件会被**原样拷进别人的 app 目录**，那份 app 的 src/ 结构与我们的不同，
// 所以这里**不 import 任何 `../../src/...`**，只用 Node 内置模块。
//
// ── 能力 ────────────────────────────────────────────────────────────────
//   qzone__post_mood      发说说（文字，可带聊天里的图）
//   qzone__list_feeds     刷好友动态（只读）
//   qzone__like_feed      点赞某条说说
//   qzone__comment_feed   评论某条说说
//
// ── 带图说说的图片只从聊天记录里来（铁律，别开口子）────────────────────
//   模型给的**不是**路径 / 网址 / base64，而是聊天记录里的消息号（#12345，
//   多张图用 #12345:2）。定位符由我们从 ctx.store 的存档里取 —— 与 src/tools.js
//   的 send_voice 一个口径：模型只给白名单键，出网的东西全由应用侧解析。
//   这样"任意本地文件被当图上传"这条路根本不存在，坏引用在碰网络之前就死。
//
// ── 登录态从哪来 ─────────────────────────────────────────────────────────
//   Qzone 网页接口只认 cookie。bot 账号在 SnowLuma 里登录着，OneBot 的 get_cookies
//   能直接把它取出来（注意：SnowLuma 对 get_cookies 这类敏感接口强制校验
//   accessToken，所以调用必须带 Bearer——先从 ctx.onebot 的常规通道走，
//   被 1401 拒了再去读 snowluma 的配置文件自己拿 token 拼请求）。
//   对本项目"API Key 不回显"的铁律：token 只存在内存变量里，绝不写日志、绝不进返回值。
//
// ── available() 的铁律：必须同步 ────────────────────────────────────────
//   只 existsSync 探测"登录态有没有可能拿到"，绝不做网络 IO。结果缓存 30 秒，
//   因为 bot 掉线/重连会改变答案。
//
// ── 为什么解析器是个状态机而不是 JSON.parse ──────────────────────────────
//   Qzone 的动态接口返回的是 **JS 对象字面量**（key 不带引号、字符串用单引号、
//   还有 \xNN / \uNNNN 转义和裸 undefined），JSON.parse 会直接抛。正则替换试过，
//   会在"双引号字符串里套单引号"的数据上把文本改坏——只有逐字符 tokenizer 才稳。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))   // …/skills/qzone
const SKILL_ID = 'qzone'
const TOOL = (n) => `${SKILL_ID}__${n}`

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'
const QZONE = 'https://user.qzone.qq.com'
const HTTP_TIMEOUT_MS = 15000
const COOKIE_CACHE_MS = 5 * 60 * 1000

// 图片上传走独立域名（不是 /proxy/domain 那套代理），字段口径照 SnowLuma 桥里
// region src/bridge/apis/qzone.ts 的实现抄——那份是真跑通的。
const QZONE_UPLOAD = 'https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image'
const IMG_PER_POST_DEFAULT = 3
const IMG_PER_POST_HARD_MAX = 9      // 空间单条说说的图上限
const IMG_MB_DEFAULT = 8
const IMG_DOWNLOAD_TIMEOUT_MS = 30000   // 下图比调接口慢，给足时间

// ── setup 里存下来的引用（available / diagnose 可能在任何时候被调用）──
let cfgOf = () => ({})
let log = () => {}
let onebotRef = null
const debugLog = []
function dbg(step, ok, detail) {
  debugLog.push({ t: Date.now(), step, ok: !!ok, detail: String(detail ?? '').slice(0, 120) })
  if (debugLog.length > 30) debugLog.splice(0, debugLog.length - 30)
  if (ok == null) return
  const msg = `[qzone] ${step}: ${detail ?? ''}`
  try { ok ? log(msg) : console.warn(msg) } catch { /* 日志失败不影响主流程 */ }
}

/* ══════════════════════════════════════════════════════════════════════
   一、布局探测：找到 app 根（resources/app）与 data 目录
   ══════════════════════════════════════════════════════════════════════ */

let cachedAppRoot = null
function findAppRoot() {
  if (cachedAppRoot !== null) return cachedAppRoot || null
  // 技能在 <app>/resources/app/skills/<id>，往上找带 src/skills.js 的那级
  let dir = path.resolve(HERE, '..', '..')
  for (let i = 0; i < 6; i++) {
    try {
      if (fs.existsSync(path.join(dir, 'src', 'skills.js'))) {
        cachedAppRoot = dir
        return dir
      }
    } catch { /* 权限等，继续往上 */ }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  cachedAppRoot = false
  return null
}

// data 目录候选：标准布局是 <app>/resources/app/data；净版 zip 多包了一层目录也照样命中。
function dataDirCandidates() {
  const appRoot = findAppRoot()
  const fromEnv = String(process.env.QQ_AGENT_DATA_DIR || '').trim()
  return [
    fromEnv || null,
    appRoot ? path.join(appRoot, 'data') : null,
    path.resolve(HERE, '..', '..', 'data'),
  ].filter(Boolean)
}

function dataDir() {
  for (const c of dataDirCandidates()) {
    try { if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c } catch { /* 继续试 */ }
  }
  return dataDirCandidates()[0]
}

// snowluma 配置目录候选（拿 accessToken 用）。同一个"陈旧副本"教训见 doujin-lookup。
function snowConfigCandidates() {
  const appRoot = findAppRoot()
  return [
    appRoot ? path.join(appRoot, 'snowluma', 'config') : null,
    path.resolve(HERE, '..', '..', 'snowluma', 'config'),
  ].filter(Boolean)
}

/* ══════════════════════════════════════════════════════════════════════
   二、纯函数工具（测试直接打这些，不打网络）
   ══════════════════════════════════════════════════════════════════════ */

/** g_tk：p_skey 的 5381 哈希，Qzone 所有接口的防伪参数。 */
export function gtk(skey) {
  let h = 5381
  const s = String(skey || '')
  for (let i = 0; i < s.length; i++) h += (h << 5) + s.charCodeAt(i)
  return (h & 0x7fffffff).toString()
}

/**
 * JS 对象字面量 → 可 JSON.parse 的字符串。逐字符扫描，同时吃得下：
 * 单/双引号字符串、\xNN、\uNNNN、\n \t \r 等控制转义、裸 true/false/null/undefined。
 */
export function jsLiteralToJson(s) {
  const str = String(s ?? '')
  let out = ''
  let i = 0
  const n = str.length
  while (i < n) {
    const ch = str[i]
    if (ch === '"' || ch === "'") {
      const quote = ch
      let inner = ''
      i++
      while (i < n) {
        const c = str[i]
        if (c === '\\') {
          const nx = str[i + 1]
          if (nx === 'x' && /^[0-9a-fA-F]{2}$/.test(str.slice(i + 2, i + 4))) {
            inner += String.fromCharCode(parseInt(str.slice(i + 2, i + 4), 16)); i += 4; continue
          }
          if (nx === 'u' && /^[0-9a-fA-F]{4}$/.test(str.slice(i + 2, i + 6))) {
            inner += String.fromCharCode(parseInt(str.slice(i + 2, i + 6), 16)); i += 6; continue
          }
          const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' }[nx]
          inner += simple !== undefined ? simple : (nx ?? ''); i += 2; continue
        }
        if (c === quote) { i++; break }
        inner += c; i++
      }
      out += JSON.stringify(inner)
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let word = ''
      while (i < n && /[A-Za-z0-9_$]/.test(str[i])) { word += str[i]; i++ }
      out += word === 'undefined' || word === 'NaN' ? 'null'
        : word === 'true' || word === 'false' ? word
        : word === 'null' ? 'null'
        : JSON.stringify(word)   // 未知标识符（比如裸枚举值）按字符串保下来，别让解析炸
      continue
    }
    out += ch
    i++
  }
  return out
}

/** 把 Qzone 返回的 `_Callback(...)` / `shine0_Callback(...)` 之类剥掉，取内部 JSON。 */
export function stripCallback(text) {
  const s = String(text ?? '').trim()
  const m = s.match(/^[A-Za-z_$][\w$]*\s*\(([\s\S]*)\)\s*;?\s*$/)
  return m ? m[1].trim() : s
}

/** 说说 HTML → 人读摘要：解 \xNN、去标签、解实体、收空白、截断。 */
export function htmlToText(html, maxLen = 300) {
  let s = String(html ?? '')
  s = s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&#[0-9]+;/g, (m2) => { try { return String.fromCharCode(parseInt(m2.slice(2, -1), 10)) } catch { return m2 } })
  s = s.replace(/\s+/g, ' ').trim()
  // Qzone 在正文后依次拼"展开全文"/"N 人觉得很赞"/"浏览 N"等尾巴（去标签后数字和汉字间会有空格），
  // 从最早出现的那一处砍掉
  const cut = s.search(/\d+\s*人觉得很赞|浏览\s*\d|展开全文/)
  if (cut > 0) s = s.slice(0, cut).trim()
  s = s.replace(/[，,、\s]*$/, '').trim()
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…'
  return s
}

export function isValidUin(u) {
  const s = String(u ?? '').trim()
  return /^\d{5,11}$/.test(s)
}

export function isValidTid(t) {
  const s = String(t ?? '').trim()
  return /^[0-9a-f]{24}$/.test(s)
}

/**
 * 图片引用 → { mid, index }。只认聊天记录里的消息号（#12345；一条消息多图时
 * #12345:2 表示第 2 张）。其余形状——路径、URL、base64://、file://、表情 id、
 * 空串——一律 null。这个函数是"模型拿不到任意图"的唯一闸门，别放宽。
 */
export function parseImageRef(v) {
  const m = String(v ?? '').trim().match(/^#?(-?\d{1,19})(?::([1-9]\d{0,2}))?$/)
  if (!m) return null
  const mid = m[1]
  if (Number(mid) === 0) return null            // 0 不是合法消息号
  return { mid, index: m[2] ? Number(m[2]) : 1 }
}

/**
 * 图片魔数校验。Qzone 只吃这几种；顺手挡掉"把任意文件当图上传"
 * （与 src/tts.js 的 isAudio 一个纪律：出网前先验明正身）。
 */
export function imageKindOf(buf) {
  if (!buf || buf.length < 12) return null
  const head = (n) => buf.subarray(0, n).toString('latin1')
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (head(8) === '\x89PNG\r\n\x1a\n') return 'png'
  if (head(6) === 'GIF87a' || head(6) === 'GIF89a') return 'gif'
  if (head(4) === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  if (head(2) === 'BM') return 'bmp'
  return null
}

/** 清理用户可见文本：去控制字符、压空白、限长。 */
export function sanitizeText(s, maxLen) {
  let t = String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  t = t.replace(/\s+/g, ' ').trim()
  if (t.length > maxLen) t = t.slice(0, maxLen)
  return t
}

/** 本地时区 'YYYY-MM-DD HH:mm'，状态文件里给人看的。 */
export function fmtLocal(ts) {
  const d = new Date(ts)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* ══════════════════════════════════════════════════════════════════════
   三、状态与限频：data/qzone/state.json
   ══════════════════════════════════════════════════════════════════════ */

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

function defaultState() {
  return { posts: [], likes: [], comments: [], lastBrowse: 0, feedCache: null, acted: {} }
}

function stateFile() {
  return path.join(dataDir(), SKILL_ID, 'state.json')
}

export function loadState() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8')
    const j = JSON.parse(raw)
    return { ...defaultState(), ...j, acted: (j && typeof j.acted === 'object' && j.acted) || {} }
  } catch {
    return defaultState()
  }
}

export function saveState(st) {
  const file = stateFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8')
  fs.renameSync(tmp, file)   // 原子替换：崩在半路不会留下半个 JSON
}

/**
 * 限频判定（纯函数，方便测试）。
 *   posts   按"今天 0 点起"计（每天发条数要严格）
 *   likes/comments 按滑动 1 小时窗口计
 * 返回 { ok, reason? }
 */
export function checkCap(st, kind, cfg, now = Date.now()) {
  const dayStart = new Date(now).setHours(0, 0, 0, 0)
  if (kind === 'post') {
    const cap = Math.max(0, Number(cfg.postsPerDay) || 0)
    const n = (st.posts || []).filter((t) => t >= dayStart).length
    return n < cap ? { ok: true } : { ok: false, reason: `今天已发 ${n} 条说说（上限 ${cap} 条/天），明天再来吧` }
  }
  const key = kind === 'like' ? 'likes' : 'comments'
  const cfgKey = kind === 'like' ? 'likesPerHour' : 'commentsPerHour'
  const cap = Math.max(0, Number(cfg[cfgKey]) || 0)
  const n = (st[key] || []).filter((t) => now - t < HOUR_MS).length
  return n < cap
    ? { ok: true }
    : { ok: false, reason: `最近一小时已${kind === 'like' ? '点赞' : '评论'} ${n} 次（上限 ${cap} 次/小时），歇一会吧` }
}

/** 记录一次成功写入并落盘。 */
export function recordAct(st, kind, feedId, now = Date.now()) {
  if (kind === 'post') st.posts = [...(st.posts || []), now]
  if (kind === 'like') st.likes = [...(st.likes || []), now]
  if (kind === 'comment') st.comments = [...(st.comments || []), now]
  if (feedId) {
    st.acted = st.acted || {}
    st.acted[feedId] = { kind, t: now }
    const ids = Object.keys(st.acted)
    if (ids.length > 300) {                    // 老的互动记忆定期清掉
      ids.sort((a, b) => (st.acted[a].t || 0) - (st.acted[b].t || 0))
      for (let i = 0; i < ids.length - 300; i++) delete st.acted[ids[i]]
    }
  }
  saveState(st)
}

/* ══════════════════════════════════════════════════════════════════════
   四、登录态：cookie / g_tk 的获取与缓存
   ══════════════════════════════════════════════════════════════════════ */

let cookieCache = null   // { cookies: Map, gtk2, selfUin, ts }

function cookieHeader(cookies) {
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/**
 * OneBot get_cookies 的 cookies 字段三种实现三种形状，都得吃：
 *   字符串 "k=v; k=v"（OneBot v11 标准 / SnowLuma 实测）
 *   对象 {k: v, ...}
 *   数组 [{name, value}, ...]
 * 值原样保留（Qzone 要求分号等特殊字符留在值里），这里不做 decodeURIComponent。
 */
export function parseCookiesField(v) {
  const map = new Map()
  if (typeof v === 'string') {
    for (const part of v.split(';')) {
      const idx = part.indexOf('=')
      if (idx <= 0) continue
      const k = part.slice(0, idx).trim()
      const val = part.slice(idx + 1).trim()
      if (k && val) map.set(k, val)
    }
    return map
  }
  if (Array.isArray(v)) {
    for (const c of v) {
      if (c && c.name != null && c.value != null && c.value !== '') map.set(String(c.name), String(c.value))
    }
    return map
  }
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      if (val != null && val !== '') map.set(String(k), String(val))
    }
  }
  return map
}

async function fetchCookiesViaOnebot(token, base) {
  base = String(base || onebotRef?.httpUrl || '').replace(/\/$/, '')
  if (!base) throw new Error('onebot httpUrl 不可用')
  const res = await fetch(`${base}/get_cookies`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ domain: 'qzone.qq.com' }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || (body.status !== 'ok' && body.retcode !== 0)) {
    throw new Error(`get_cookies 失败: HTTP ${res.status} retcode=${body.retcode ?? body.status}`)
  }
  return parseCookiesField(body.data?.cookies ?? body.data?.cookie)
}

// 从 snowluma 的 onebot_*.json 里收集 http 服务的 {token, base}。
// token 只进内存，绝不写日志——本项目对"密钥回显"有过教训。
// base 取配置里的 host/port（缺省 127.0.0.1:3000），因为这条路恰恰是在
// ctx.onebot 还没拿到手（或不存在）时用的，不能依赖 onebotRef.httpUrl。
function readSnowHttpServices() {
  const out = []
  for (const dir of snowConfigCandidates()) {
    let files = []
    try { files = fs.readdirSync(dir).filter((f) => /^onebot_.*\.json$/i.test(f)) } catch { continue }
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        const servers = j?.networks?.httpServers || j?.httpServers || []
        for (const s of Array.isArray(servers) ? servers : []) {
          if (!s) continue
          const host = s.host || '127.0.0.1'
          const port = Number(s.port) || 3000
          out.push({ token: s.accessToken ? String(s.accessToken) : '', base: `http://${host}:${port}` })
        }
      } catch { /* 单个配置文件坏了不影响别的 */ }
    }
  }
  return out
}

async function acquireCookies() {
  const now = Date.now()
  if (cookieCache && now - cookieCache.ts < COOKIE_CACHE_MS && cookieCache.cookies.get('p_skey')) {
    return cookieCache
  }
  // 第一路：走 ctx.onebot 的常规通道（应用自己配了 token 时一条就通）
  if (onebotRef && typeof onebotRef.call === 'function') {
    try {
      const data = await onebotRef.call('get_cookies', { domain: 'qzone.qq.com' }, HTTP_TIMEOUT_MS)
      const map = parseCookiesField(data?.cookies ?? data?.cookie)
      if (map.get('p_skey')) {
        cookieCache = finishCookies(map, now)
        dbg('cookies', true, '经由 ctx.onebot 拿到 p_skey')
        return cookieCache
      }
      dbg('cookies', null, 'ctx.onebot 通道没拿到 p_skey')
    } catch (e) {
      dbg('cookies', null, `ctx.onebot 通道失败：${e?.message ?? e}`)
    }
  }
  // 第二路：读 snowluma 配置拿 token/base，自己拼 get_cookies（SnowLuma 对敏感接口强制校验 token）
  for (const svc of readSnowHttpServices()) {
    try {
      const map = await fetchCookiesViaOnebot(svc.token, svc.base)
      if (map.get('p_skey')) {
        cookieCache = finishCookies(map, now)
        dbg('cookies', true, '经由 snowluma 配置 token 拿到 p_skey')
        return cookieCache
      }
    } catch { /* 换下一个 token 试 */ }
  }
  dbg('cookies', false, '两路都没拿到 p_skey')
  throw new Error('拿不到 Qzone 登录态（get_cookies 失败）。确认 bot 账号在线、SnowLuma 已登录。')
}

function finishCookies(map, now) {
  const selfUin = (map.get('pt2gguin') || map.get('uin') || '').replace(/^o0*/, '')
  return { cookies: map, gtk2: gtk(map.get('p_skey')), selfUin, ts: now }
}

/* ══════════════════════════════════════════════════════════════════════
   五、Qzone HTTP 封装
   ══════════════════════════════════════════════════════════════════════ */

async function qzoneGet(urlPath, params, cookies) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${QZONE}${urlPath}?${qs}`, {
    headers: { 'user-agent': UA, cookie: cookieHeader(cookies) },
    redirect: 'manual',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  const text = await res.text()
  if (res.status >= 300 && res.status < 400) throw new Error('Qzone 把请求重定向到了登录页（登录态失效）')
  return text
}

async function qzonePost(urlPath, form, cookies) {
  // urlPath 允许是绝对地址：图片上传在 up.qzone.qq.com，不在 user.qzone.qq.com 的代理下。
  const url = /^https?:\/\//i.test(urlPath) ? urlPath : `${QZONE}${urlPath}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      cookie: cookieHeader(cookies),
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      referer: `${QZONE}/`
    },
    redirect: 'manual',
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  })
  const text = await res.text()
  if (res.status >= 300 && res.status < 400) throw new Error('Qzone 把请求重定向到了登录页（登录态失效）')
  return text
}

/** 统一的成功判定：剥 callback 后 code===0。 */
function parseQzoneJson(text, what) {
  let j
  try {
    j = JSON.parse(jsLiteralToJson(stripCallback(text)))
  } catch (e) {
    throw new Error(`${what} 返回无法解析（${String(e?.message ?? e).slice(0, 80)}）`)
  }
  if (!j || j.code !== 0) {
    throw new Error(`${what} 失败: code=${j?.code ?? '?'} ${j?.message || j?.msg || ''}`.trim())
  }
  return j
}

/**
 * 上传 / 发布这两个接口的响应**不一定带 code 字段**（成功时可能整个没有），
 * 所以不能复用上面那个"必须 code===0"的严格判定，否则成功会被当成失败。
 * 口径照 SnowLuma 桥：code / subcode 只在是数字且非 0 时才算错。
 * 另外上传接口偶尔在 callback( 前面吐一段垃圾，先切到 callback 再剥壳。
 */
export function parseQzoneLooseJson(text, what) {
  let s = String(text ?? '').trim()
  const at = s.indexOf('callback')
  if (at > 0) s = s.slice(at)
  let j
  try {
    j = JSON.parse(jsLiteralToJson(stripCallback(s)))
  } catch (e) {
    throw new Error(`${what}返回无法解析（${String(e?.message ?? e).slice(0, 80)}）`)
  }
  for (const k of ['code', 'subcode']) {
    if (typeof j?.[k] === 'number' && j[k] !== 0) {
      throw new Error(`${what}失败: ${k}=${j[k]} ${j?.message || j?.msg || ''}`.trim())
    }
  }
  return j || {}
}

/* ══════════════════════════════════════════════════════════════════════
   五点五、带图说说：聊天里的图 → Qzone 图床 → richval
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 把模型给的消息号换成"那张图"的定位符。**纯本地读，不出网** ——
 * 坏 id / 没图的消息 / 越界的第 N 张都在这里死掉，绝不带着脏参数去打 Qzone。
 */
export function resolveChatImage(ctx, ref) {
  const store = ctx?.store
  if (!store || typeof store.findByMid !== 'function') {
    return { error: '这个会话拿不到消息存档，引用不了聊天里的图（这次只能发纯文字）' }
  }
  let entry = null
  try {
    entry = store.findByMid(ctx.chatKey, ref.mid)
  } catch (e) {
    return { error: `查消息 #${ref.mid} 时存档报错了（${String(e?.message ?? e).slice(0, 40)}）` }
  }
  if (!entry) return { error: `聊天记录里没有消息 #${ref.mid}。id 只能用聊天记录里真出现过的那个，别编` }
  const imgs = (Array.isArray(entry.media) ? entry.media : []).filter((m) => m && m.kind === 'image' && (m.url || m.file))
  if (!imgs.length) return { error: `消息 #${ref.mid} 里没有图片（[语音]/[文件]/纯文字都当不了图发）` }
  if (ref.index > imgs.length) {
    return { error: `消息 #${ref.mid} 只有 ${imgs.length} 张图，没有第 ${ref.index} 张` }
  }
  const pick = imgs[ref.index - 1]
  return { mid: ref.mid, index: ref.index, url: String(pick.url || ''), file: String(pick.file || ''), total: imgs.length }
}

/**
 * 下载那张图的字节。QQ 的图片直链会过期，所以：先用存档里的地址，
 * 失败了再让 OneBot 重签一次（onebot.freshImageUrlOfMessage），跟 send_sticker 一个思路。
 */
async function downloadChatImage(img, maxBytes) {
  const attempt = async (u) => {
    const res = await fetch(u, {
      headers: { 'user-agent': UA, referer: `${QZONE}/` },
      signal: AbortSignal.timeout(IMG_DOWNLOAD_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) throw new Error('下回来是空的')
    return buf
  }

  const urls = img.url ? [img.url] : []
  let lastErr = '存档里没有可用的图片地址'
  for (const u of urls) {
    try {
      const buf = await attempt(u)
      return finishDownload(buf, maxBytes)
    } catch (e) { lastErr = String(e?.message ?? e).slice(0, 60) }
  }
  // 直链过期兜底：问 OneBot 要这条消息的新地址
  if (typeof onebotRef?.freshImageUrlOfMessage === 'function') {
    try {
      const fresh = await onebotRef.freshImageUrlOfMessage(img.mid, img.file)
      if (fresh && !urls.includes(fresh)) {
        const buf = await attempt(fresh)
        return finishDownload(buf, maxBytes)
      }
    } catch (e) { lastErr = String(e?.message ?? e).slice(0, 60) }
  }
  return { error: `图片下载不了：${lastErr}` }
}

function finishDownload(buf, maxBytes) {
  if (buf.length > maxBytes) {
    return { error: `图片 ${(buf.length / 1048576).toFixed(1)}MB，超过上限 ${(maxBytes / 1048576).toFixed(0)}MB，发不了` }
  }
  const kind = imageKindOf(buf)
  if (!kind) return { error: '那张图不是 Qzone 认的格式（只支持 jpg/png/gif/webp/bmp）' }
  return { buf, kind }
}

/**
 * 传到 Qzone 图床，换回 richval（发说说时靠它挂图）。
 * 返回的 richval 形如 `,albumid,lloc,lloc,type,height,width,,height,width`；
 * 多图就把多个 richval 用 \t 连起来交给发布接口。
 */
async function uploadQzoneImage(auth, buf) {
  const { cookies, gtk2, selfUin } = auth
  const form = {
    filename: 'filename',
    uin: selfUin,
    skey: cookies.get('skey') || '',
    zzpaneluin: selfUin,
    p_uin: selfUin,
    p_skey: cookies.get('p_skey') || '',
    uploadtype: '1',
    albumtype: '7',
    exttype: '0',
    refer: 'shuoshuo',
    output_type: 'jsonhtml',
    charset: 'utf-8',
    output_charset: 'utf-8',
    upload_hd: '1',
    hd_width: '2048',
    hd_height: '10000',
    hd_quality: '96',
    backUrls: `http://upbak.photo.qzone.qq.com/cgi-bin/upload/cgi_upload_image,http://119.147.64.75/cgi-bin/upload/cgi_upload_image&url=${QZONE_UPLOAD}?g_tk=${gtk2}`,
    base64: '1',
    jsonhtml_callback: 'callback',
    picfile: buf.toString('base64'),
    qzreferrer: `${QZONE}/${selfUin}/main`
  }
  const j = parseQzoneLooseJson(await qzonePost(`${QZONE_UPLOAD}?g_tk=${gtk2}`, form, cookies), '上传图片')
  const d = j?.data
  if (!d?.albumid || !d?.lloc || !d?.url) throw new Error('上传图片失败：响应缺少 albumid/lloc/url')
  const h = Number(d.height) || 0
  const w = Number(d.width) || 0
  const t = Number(d.type) || 0
  return {
    richval: `,${d.albumid},${d.lloc},${d.lloc},${t},${h},${w},,${h},${w}`,
    url: String(d.url),
    width: w,
    height: h
  }
}

/* ══════════════════════════════════════════════════════════════════════
   六、四个工具的实现
   ══════════════════════════════════════════════════════════════════════ */

async function doPostMood(content, images, ctx) {
  const cfg = cfgOf()
  const text = sanitizeText(content, Math.max(1, Number(cfg.maxPostChars) || 500))
  if (!text) return { content: '说说内容不能为空', isError: true }

  // ── 图片：全部本地校验/解析完再出网（顺序别调，脏参数不许碰网络）──
  const wanted = Array.isArray(images) ? images : (images == null || images === '' ? [] : [images])
  const picked = []
  if (wanted.length) {
    if (cfg.allowChatImages === false) {
      return { content: '带图说说被关掉了（设置里"允许引用聊天里的图"是关的），这次只能发纯文字', isError: true }
    }
    const cap = Math.min(IMG_PER_POST_HARD_MAX, Math.max(1, Number(cfg.maxImagesPerPost) || IMG_PER_POST_DEFAULT))
    if (wanted.length > cap) {
      return { content: `一条说说最多带 ${cap} 张图，这次给了 ${wanted.length} 张`, isError: true }
    }
    for (const raw of wanted) {
      const ref = parseImageRef(raw)
      if (!ref) {
        return {
          content: `图片引用「${String(raw ?? '').slice(0, 40)}」不认。只能给聊天记录里的消息号（如 #12345，一条消息多图时用 #12345:2 指第 2 张）；路径、网址、base64 一律不收`,
          isError: true
        }
      }
      const got = resolveChatImage(ctx, ref)
      if (got.error) return { content: got.error, isError: true }
      picked.push(got)
    }
  }

  const st = loadState()
  const capCheck = checkCap(st, 'post', cfg)
  if (!capCheck.ok) return { content: capCheck.reason, isError: true }

  const auth = await acquireCookies()
  if (!auth.selfUin) return { content: '识别不出自己的 QQ 号（cookie 里缺 pt2gguin/uin）', isError: true }

  // 全部图传成功再发说说：传一半就发，空间里会留下一条缺图的说说，收不回来
  const maxBytes = Math.min(32, Math.max(1, Number(cfg.maxImageMB) || IMG_MB_DEFAULT)) * 1024 * 1024
  const richvals = []
  for (const img of picked) {
    const dl = await downloadChatImage(img, maxBytes)
    if (dl.error) {
      dbg('image', false, `#${img.mid} 下载失败：${dl.error}`)
      return { content: dl.error, isError: true }
    }
    try {
      const up = await uploadQzoneImage(auth, dl.buf)
      richvals.push(up.richval)
      dbg('image', true, `#${img.mid} 已上传（${dl.kind} ${up.width}x${up.height}）`)
    } catch (e) {
      dbg('image', false, `#${img.mid} 上传失败：${String(e?.message ?? e).slice(0, 100)}`)
      return { content: `图片上传失败：${String(e?.message ?? e).slice(0, 120)}`, isError: true }
    }
  }

  const withPic = richvals.length > 0
  const form = {
    syn_tweet_verson: '1',
    paramstr: '1',
    pic_template: '',
    richtype: withPic ? '1' : '',
    richval: richvals.join('\t'),
    special_url: '',
    subrichtype: '',
    who: '1',
    con: text,
    feedversion: '1',
    ver: '1',
    ugc_right: '1',
    to_sign: '0',
    hostuin: auth.selfUin,
    code_version: '1',
    format: 'json',
    qzreferrer: `${QZONE}/${auth.selfUin}`
  }
  let tid = ''
  try {
    const j = parseQzoneLooseJson(
      await qzonePost(`/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${auth.gtk2}`, form, auth.cookies),
      '发说说'
    )
    // 没有 tid 就是没发成：空间拒稿时也返回 200，只有 tid 是"服务器真收下了"的凭据
    tid = String(j?.t1_tid ?? j?.tid ?? '')
    if (!tid) throw new Error('发说说失败：响应里没有 tid（多半被空间拒了，比如内容含敏感词或发得太频繁）')
  } catch (e) {
    dbg('post_mood', false, String(e?.message ?? e).slice(0, 120))
    return { content: String(e?.message ?? e).slice(0, 200), isError: true }
  }
  recordAct(st, 'post', null)
  dbg('post_mood', true, `tid=${tid}，${text.length} 字${withPic ? `，${richvals.length} 图` : ''}`)
  return {
    content: `已发到你的 QQ 空间：「${text.slice(0, 60)}${text.length > 60 ? '…' : ''}」${withPic ? `（带 ${richvals.length} 张图）` : ''}`
  }
}

function feedToItem(f) {
  const uin = String(f?.uin ?? '')
  const tid = String(f?.key ?? '')
  if (!isValidUin(uin) || !isValidTid(tid)) return null
  const abstime = Number(f?.abstime) || 0
  const nick = String(f?.nickname ?? '').trim() || uin
  const text = htmlToText(f?.html ?? '')
  if (!text) return null
  // 从 HTML 尾巴里数"N 人觉得很赞"
  const rawHtml = String(f?.html ?? '').replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  const likeM = rawHtml.match(/(\d+)\s*人觉得很赞/)
  const likes = likeM ? Number(likeM[1]) : 0
  const cmts = Array.isArray(f?.mergeData) ? f.mergeData.length : (f?.commentcount != null ? Number(f.commentcount) : 0)
  return { uin, tid, nick, time: fmtLocal(abstime * 1000), likes, comments: cmts, text }
}

async function fetchFeeds(count) {
  const { cookies, gtk2, selfUin } = await acquireCookies()
  if (!selfUin) throw new Error('识别不出自己的 QQ 号（cookie 里缺 pt2gguin/uin）')
  const text = await qzoneGet('/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more', {
    uin: selfUin,
    scope: '0',
    view: '1',
    filter: 'all',
    flag: '1',
    applist: 'all',
    pagenum: '1',
    aisortEndTime: '0',
    aisortOffset: '0',
    aisortBeginTime: '0',
    begintime: '0',
    format: 'json',
    g_tk: gtk2,
    useutf8: '1',
    outputhtmlfeed: '1'
  }, cookies)
  const j = parseQzoneJson(text, '拉取动态')
  const rawItems = j?.data?.data
  if (!Array.isArray(rawItems)) return { items: [], hasMore: false }
  const items = []
  for (const f of rawItems) {
    if (items.length >= count) break
    if (String(f?.appid ?? '311') !== '311') continue   // 只认"说说"，过滤相册/分享等多媒体动态
    const it = feedToItem(f)
    if (it) items.push(it)
  }
  return { items, hasMore: !!j?.data?.main?.hasMoreFeeds }
}

async function doListFeeds(countArg) {
  const cfg = cfgOf()
  const count = Math.min(20, Math.max(1, Number(countArg) || Number(cfg.maxFeeds) || 10))
  const st = loadState()
  const now = Date.now()
  const interval = Math.max(0, Number(cfg.browseIntervalMinutes) || 0) * 60000

  // 刷动态是只读但带"打扰度"：太频繁的调用直接喂上一次缓存
  if (interval > 0 && now - (st.lastBrowse || 0) < interval && st.feedCache) {
    const cached = st.feedCache.items.slice(0, count)
    return { content: formatFeeds(cached, st, true) }
  }

  const { items, hasMore } = await fetchFeeds(count)
  st.lastBrowse = now
  st.feedCache = { t: now, items }
  saveState(st)
  dbg('list_feeds', true, `${items.length} 条`)
  return { content: formatFeeds(items, st, false, hasMore) }
}

function formatFeeds(items, st, fromCache, hasMore = false) {
  if (!items.length) return '好友动态里暂时没有能看懂的说说（可能有图片/转发类动态被跳过了）。'
  const acted = st.acted || {}
  const lines = items.map((f, i) => {
    const mark = acted[`${f.uin}:${f.tid}`] ? '（已互动过）' : ''
    const likePart = f.likes > 0 ? `，${f.likes} 人觉得很赞` : ''
    const cmtPart = f.comments > 0 ? `，${f.comments} 条评论` : ''
    return `${i + 1}. [${f.nick}(${f.uin}) ${f.time}${likePart}${cmtPart}] ${f.text}（tid: ${f.tid}）${mark}`
  })
  const head = fromCache ? '（距上次刷动态不久，这是缓存的上一次结果）' : ''
  const tail = hasMore ? '\n还有更早的动态，需要的话可以说"再看几条"。' : ''
  return `${head}刷到 ${items.length} 条好友说说：\n${lines.join('\n')}\n想点赞用 qzone__like_feed，想评论用 qzone__comment_feed，uin 和 tid 照抄上面。${tail}`.trim()
}

async function doLikeFeed(uin, tid) {
  const cfg = cfgOf()
  if (!isValidUin(uin)) return { content: `uin 不合法：${String(uin).slice(0, 20)}（必须是 5~11 位纯数字 QQ 号）`, isError: true }
  if (!isValidTid(tid)) return { content: `tid 不合法：${String(tid).slice(0, 30)}（必须是 24 位十六进制，从 list_feeds 原样抄回）`, isError: true }
  const feedId = `${String(uin).trim()}:${String(tid).trim()}`

  const st = loadState()
  if (st.acted?.[feedId]) return { content: '这条已经互动过了，别重复点。', isError: true }
  const cap = checkCap(st, 'like', cfg)
  if (!cap.ok) return { content: cap.reason, isError: true }

  const { cookies, gtk2, selfUin } = await acquireCookies()
  const unikey = `${QZONE}/${uin}/mood/${tid}`
  const form = {
    qzreferrer: `${QZONE}/${selfUin}`,
    opuin: selfUin,
    unikey,
    curkey: unikey,
    appid: '311',
    from: '1',
    typeid: '0',
    abstime: String(Math.floor(Date.now() / 1000)),
    fid: String(tid),
    active: '0',
    format: 'json',
    fupdate: '1'
  }
  parseQzoneJson(
    await qzonePost(`/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app?g_tk=${gtk2}`, form, cookies),
    '点赞'
  )
  recordAct(st, 'like', feedId)
  dbg('like_feed', true, feedId)
  return { content: `已给 ${uin} 的这条说说点赞。` }
}

async function doCommentFeed(uin, tid, content) {
  const cfg = cfgOf()
  if (!isValidUin(uin)) return { content: `uin 不合法：${String(uin).slice(0, 20)}（必须是 5~11 位纯数字 QQ 号）`, isError: true }
  if (!isValidTid(tid)) return { content: `tid 不合法：${String(tid).slice(0, 30)}（必须是 24 位十六进制，从 list_feeds 原样抄回）`, isError: true }
  const text = sanitizeText(content, Math.max(1, Number(cfg.maxCommentChars) || 200))
  if (!text) return { content: '评论内容不能为空', isError: true }
  const feedId = `${String(uin).trim()}:${String(tid).trim()}`

  const st = loadState()
  if (st.acted?.[feedId]) return { content: '这条已经互动过了，别重复刷评论。', isError: true }
  const cap = checkCap(st, 'comment', cfg)
  if (!cap.ok) return { content: cap.reason, isError: true }

  const { cookies, gtk2, selfUin } = await acquireCookies()
  const form = {
    topicId: `${uin}_${tid}__1`,
    uin: selfUin,
    hostUin: String(uin),
    feedsType: '100',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    plat: 'qzone',
    source: 'ic',
    platformid: '52',
    format: 'fs',
    ref: 'feeds',
    content: text
  }
  parseQzoneJson(
    await qzonePost(`/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${gtk2}`, form, cookies),
    '评论'
  )
  recordAct(st, 'comment', feedId)
  dbg('comment_feed', true, `${feedId} «${text.slice(0, 20)}»`)
  return { content: `已在 ${uin} 的说说下评论：「${text}」` }
}

/* ══════════════════════════════════════════════════════════════════════
   七、技能契约：setup / available / dispose / diagnose
   ══════════════════════════════════════════════════════════════════════ */

// orchestrator 的 ctx 里有 onebot；setup 的 api 没有。所以第一次执行工具时把它记下来，
// 之后取 cookie 都走它的常规通道（被 SnowLuma 1401 拒了再退到读配置文件那条路）。
function rememberOnebot(ctx) {
  if (!onebotRef && ctx && typeof ctx.onebot?.call === 'function') onebotRef = ctx.onebot
}

// 群聊闸门（与 doujin-lookup 同一套约定）
function gateByContext(ctx) {
  const cfg = cfgOf()
  if (cfg.allowInGroup === false && ctx?.kind === 'group') {
    return '此功能只在私聊可用'
  }
  return ''
}

let availCache = { t: 0, v: false }

// 同步：只探测"登录态有没有可能拿到"，不做网络
export function available() {
  const now = Date.now()
  if (now - availCache.t < 30000) return availCache.v
  let v = false
  if (onebotRef && typeof onebotRef.call === 'function' && onebotRef.httpUrl) v = true
  if (!v) {
    for (const dir of snowConfigCandidates()) {
      try {
        if (fs.readdirSync(dir).some((f) => /^onebot_.*\.json$/i.test(f))) { v = true; break }
      } catch { /* 目录不存在就换下一个 */ }
    }
  }
  availCache = { t: now, v }
  return v
}

export function diagnose() {
  const steps = debugLog.slice(-8).map((d) => `${fmtLocal(d.t)} ${d.ok == null ? '…' : d.ok ? '✓' : '✗'} ${d.step} ${d.detail}`)
  return [
    `可用性（30s 缓存）: ${available() ? '是' : '否'}`,
    `onebot 通道: ${onebotRef && onebotRef.httpUrl ? '有' : '无'}`,
    `data 目录: ${dataDir()}`,
    `state 文件: ${fs.existsSync(stateFile()) ? '存在' : '尚未创建'}`,
    steps.length ? `最近动态:\n  ${steps.join('\n  ')}` : '尚无调用记录'
  ].join('\n')
}

export function dispose() {
  cookieCache = null
  onebotRef = null
  availCache = { t: 0, v: false }
}

export function setup(api) {
  cfgOf = () => (api.config && typeof api.config === 'function' ? (api.config() || {}) : {})
  log = (...a) => { try { api.log(...a) } catch { /* ignore */ } }
  onebotRef = api.onebot || api.context?.onebot || null

  api.registerTool({
    id: 'post_mood',
    description: '以你自己的身份发一条 QQ 空间说说。内容要真是你想发的，一两句、你的语气。可以带图：images 里放**聊天记录里的消息号**（如 "#12345"，那条消息有多张图时用 "#12345:2" 指第 2 张），只能引用你已经看到过的图，不接受路径、网址或 base64。',
    category: 'social',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '说说正文，第一人称、你自己的语气' },
        images: {
          type: 'array',
          items: { type: 'string' },
          description: '要一起发的图，每项是聊天记录里的消息号（"#12345" 或 "#12345:2"）。不发图就别传。'
        }
      },
      required: ['content']
    },
    async execute(ctx, args) {
      const deny = gateByContext(ctx)
      if (deny) return { content: deny, isError: true }
      rememberOnebot(ctx)
      return doPostMood(args?.content, args?.images, ctx)
    }
  })

  api.registerTool({
    id: 'list_feeds',
    description: '刷好友的 QQ 空间动态（只读），返回作者/时间/摘要/点赞数，供你决定要不要点赞评论。',
    category: 'social',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'integer', description: '想看几条（默认取配置，上限 20）' }
      }
    },
    async execute(ctx, args) {
      const deny = gateByContext(ctx)
      if (deny) return { content: deny, isError: true }
      rememberOnebot(ctx)
      return doListFeeds(args?.count)
    }
  })

  api.registerTool({
    id: 'like_feed',
    description: '给指定好友的一条说说点赞。uin/tid 从 list_feeds 的返回里原样抄。',
    category: 'social',
    parameters: {
      type: 'object',
      properties: {
        uin: { type: 'string', description: '作者 QQ 号' },
        tid: { type: 'string', description: '说说的 tid' }
      },
      required: ['uin', 'tid']
    },
    async execute(ctx, args) {
      const deny = gateByContext(ctx)
      if (deny) return { content: deny, isError: true }
      rememberOnebot(ctx)
      return doLikeFeed(args?.uin, args?.tid)
    }
  })

  api.registerTool({
    id: 'comment_feed',
    description: '给指定好友的一条说说写评论。uin/tid 从 list_feeds 的返回里原样抄，评论要短、像你本人。',
    category: 'social',
    parameters: {
      type: 'object',
      properties: {
        uin: { type: 'string', description: '作者 QQ 号' },
        tid: { type: 'string', description: '说说的 tid' },
        content: { type: 'string', description: '评论内容' }
      },
      required: ['uin', 'tid', 'content']
    },
    async execute(ctx, args) {
      const deny = gateByContext(ctx)
      if (deny) return { content: deny, isError: true }
      rememberOnebot(ctx)
      return doCommentFeed(args?.uin, args?.tid, args?.content)
    }
  })
}
