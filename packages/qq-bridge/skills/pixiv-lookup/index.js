// pixiv-lookup —— Pixiv 查图插件（QQ Agent 扩展底座 · skills/ LLM 型）
//
// ── 这个文件是什么 ────────────────────────────────────────────────────────
// 一个**自包含**的 Skill：把 Pixiv 的搜索 / 详情 / 榜单能力注册成模型可调用的工具。
// 不 import 宿主项目的任何 `../../src/...`，只用 Node 内置模块 —— 这样整个目录
// 可以原样拷进任何一份 QQ Agent 的 skills/ 目录里跑。
//
// ── 上游 API 契约（QQ Agent 0.3.1/0.4 扩展规范，别改形状）──────────────────
//   export function setup(api)
//     api.registerTool({ id, name, description, category, icon, parameters, execute })
//     api.config()  → 本 Skill 的配置（= config.skills['pixiv-lookup']，已合并 manifest.settings）
//     api.log / api.warn / api.error
//   export function available(context)  → 依赖自检，**必须同步**
//   export function promptSections(context) → 提示词片段（跟着开关走）
//   export function dispose() → 回收（本项目没有常驻子进程，仅清缓存）
//   工具 id 会被上游自动加 `pixiv-lookup__` 前缀 ⇒ 模型看到的是 pixiv-lookup__search
//   execute(ctx, args) 返回 { content } 成功 / { content, isError: true } 失败
//   ctx：{ kind:'group'|'private', chatId, chatKey, config?... }（QQ Agent 的 orchestrator 提供）
//
// ── 设计上刻意做的几件事（每条都对应一类"静默失效"）─────────────────────
//   1. available() 只判"开关"，不判"网络通不通"。
//      如果因为查不到 Pixiv 就在这里返回不可用，上游会把整个 Skill 连同工具一起摘掉，
//      用户看到的是"功能凭空消失、没有任何解释"。所以网络问题一律留到 execute()
//      里返回**写明原因和怎么办**的中文报错。
//   2. Cookie 只放在 configSchema.secret 字段里 —— 上游 UI 会渲染成密码框、
//      /api/skills 响应里被脱敏成 ******。任何日志/报错/诊断输出都只打
//      "PHPSESSID=已设置(长度N)"，绝不回显原文。
//   3. 所有上限（条数、页数、ids 数量、超时）都在服务端**再夹一次**，
//      不信任模型传来的参数 —— 模型很容易传 limit=999。
//   4. 出网只有一个出口 httpJson()，便于统一超时 / 代理 / 错误分类。
//      测试脚本用 __setTransport() 换成假实现，从而在没有外网的机器上也能验证解析逻辑。
//
// ── Pixiv 接口来源（公开 Web 接口，非官方文档，已按实测响应形状解析）──────
//   搜索   GET https://www.pixiv.net/ajax/search/artworks/{kw}?word=...&order=...&mode=...&s_mode=...
//   详情   GET https://www.pixiv.net/ajax/illust/{id}
//   多图   GET https://www.pixiv.net/ajax/illust/{id}/pages
//   榜单   GET https://www.pixiv.net/ranking.php?format=json&mode=...&content=...
//   返回形状：{ error:false, message:'', body:{...} }；搜索的列表在 body.illustManga.data

// ── 本文件只用 Node 内置模块，且**不 import 宿主的 src/**（自包含）──
// 注意：这里没有用到任何 node:fs —— 插件不落盘、不读本地文件，
// 也就不需要声明权限，装上即用。
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import {
  createImageBridge,
  masterFromThumb,
  isPixivImageUrl,
} from './image-bridge.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILL_ID = 'pixiv-lookup'
// ★ InteractBot 适配①：这三个名字**由宿主注入**（见 setup 里的 hostName）。
//   上游宿主把工具名拼成 `pixiv-lookup__search`；而 InteractBot 里模型看到的是
//   `mcp__skills__pixiv-lookup__search`（DSH 的 MCP 客户端会按服务器名加前缀）。
//   提示词里写死旧名字 ⇒ 模型会去调一个**不存在**的工具，而且失败得很安静（它只会说"查不到"）。
let TOOL_SEARCH = `${SKILL_ID}__search`
let TOOL_ARTWORK = `${SKILL_ID}__artwork`
let TOOL_RANKING = `${SKILL_ID}__ranking`
// 发图工具同样由宿主提供（InteractBot 那份是 `mcp__qq__qq_send_image`）。
// ★ 它**必须显式带 kind/peerId**：那个 MCP 进程不知道"当前会话"是谁（见下面各处的调用文案）。
let TOOL_SEND_IMAGE = 'send_image'

/* ══════════════════════════════════════════════════════════════════════
   0. 配置与运行时引用
   ══════════════════════════════════════════════════════════════════════ */

// setup() 里存下来的取配置函数。available / promptSections / execute 都可能在任何时候被调用。
let cfgOf = () => ({})
let apiWarn = () => {}

const DEFAULTS = {
  // ★ InteractBot 适配②：默认**关**。
  //   清单里写的是 settings.enabled=false 且 enabledByDefault=false，而这里原本是 true ——
  //   两处不一致时，"只拿到显式配置"的宿主会把技能当成已开启（上游也踩过这条）。
  enabled: false,
  cookie: '',
  maxResults: 10,
  maxPages: 2,
  order: 'popular_d',
  allowR18: false,
  allowInGroup: true,
  // 代理地址。留空 = 直连；填 `auto` = 自动探测本机代理（推荐给"代理端口每次启动都变"的人：
  // 先问宿主的 Electron 会话代理，再扫常见端口）；也可以填死地址 http://127.0.0.1:7890。
  proxy: '',
  timeoutMs: 20000,
  // ── 连续失败断路器（默认开）──
  // 为什么需要它：Pixiv 连不上时单次请求要等满 timeoutMs（默认 20 秒）。
  // 弱模型遇到"失败"的常见反应是换个关键词再试 —— 3 次就是 1 分钟，而且它
  // 往往把 12~20 轮工具预算全耗在这上面，群里最后一条回复都没有。
  // 打开这个开关后：连续失败到阈值就【直接终止】本插件的一切查询，
  // 并把"别再调工具了，直接用中文说明情况"作为结果返回给模型，
  // 逼它把话说出来，而不是继续空转。
  breakerEnabled: true,
  breakerThreshold: 3,
  breakerCooldownSec: 60,
  // ── 本地图片桥（默认开）──
  // 为什么必须有它：i.pximg.net 有防盗链（要带 Referer）且在大陆必须走代理，
  // 而宿主的图片下载通道既不带 Referer 也不走系统代理 —— 老版本的表现就是
  // "能给出链接、发不出图"。开了图片桥之后，插件把图自己取回来，
  // 交给宿主一条 127.0.0.1 的本地直链，宿主就能正常发图了。
  // ⚠️ 宿主侧还需要在**控制台 → 扩展**里打开「允许下载内网/本机图片地址」
  //    (security.allowPrivateImageHosts=true)，否则宿主的 SSRF 保护会把
  //    这条 127.0.0.1 直链挡掉。
  imageBridge: true,
  bridgePort: 18717,      // 0 = 让系统随机分配
  bridgeTtlSec: 1800,     // 直链有效期（秒）
  bridgeMaxMB: 8,         // 桥单张图上限（MB）
}

/** 读当前配置（运行时优先用上游挂在 context 上的那份，保证"改了马上生效"）。 */
function cfg(context) {
  const fromRun = context && context.config && context.config.skills && context.config.skills[SKILL_ID]
  if (fromRun && typeof fromRun === 'object') return { ...DEFAULTS, ...fromRun }
  try { return { ...DEFAULTS, ...(cfgOf(context) || {}) } } catch { return { ...DEFAULTS } }
}

/* ══════════════════════════════════════════════════════════════════════
   1. Cookie / 参数清洗
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 清洗用户粘进来的 Cookie 串。
 *
 * 用户从浏览器开发者工具复制，常带这些东西，直接塞进请求头会 400 或抛错：
 *   · 换行 / 制表符（多行复制）—— HTTP 头里出现裸换行 = 头注入
 *   · 前后引号（"PHPSESSID=..."）
 *   · "Cookie: " 前缀（有的人连名字一起复制）
 * 所以这里统一去控制字符、剥前缀、去掉成对引号。
 */
function cleanCookie(raw) {
  let s = String(raw == null ? '' : raw)
  // 去掉一切控制字符（含 \r \n \t），它们不可能出现在合法 Cookie 里
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ')
  s = s.trim()
  s = s.replace(/^cookie\s*:\s*/i, '').trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim()
  }
  s = s.replace(/\s{2,}/g, ' ').replace(/\s*;\s*/g, '; ').replace(/;\s*$/, '')
  return s.slice(0, 4096)
}

/** 从 Cookie 串里取某个键的值（取不到返回 ''）。 */
function cookieValue(cookie, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`, 'i').exec(cookie || '')
  return m ? String(m[1]).trim() : ''
}

/**
 * 给用户/日志看的 Cookie 状态描述 —— **绝不回显原文**。
 * 只说明"有没有、长什么样、关键字段在不在"。
 */
function cookieStatus(cookie) {
  const c = cleanCookie(cookie)
  if (!c) return '未填写'
  const parts = c.split(';').map((x) => x.trim()).filter(Boolean)
  const keys = parts.map((p) => p.split('=')[0])
  const bits = [`共 ${parts.length} 个字段`, `长度 ${c.length}`]
  bits.push(keys.includes('PHPSESSID') ? '含 PHPSESSID ✅' : '不含 PHPSESSID ⚠️')
  if (keys.includes('p_ab_id')) bits.push('含 p_ab_id')
  if (cookieValue(c, 'PHPSESSID')) bits.push(`PHPSESSID 长度 ${cookieValue(c, 'PHPSESSID').length}`)
  return bits.join('，')
}

/* ══════════════════════════════════════════════════════════════════════
   2. 出网层：唯一出口（超时 / 代理 / 错误分类）
   ══════════════════════════════════════════════════════════════════════ */

/**
 * ⚠️⚠️ 代理**绝对不能**动全局状态（这是踩过的真实事故，务必读完再改）⚠️⚠️
 *
 * 最初的实现是这样写的：
 *     undici.setGlobalDispatcher(new ProxyAgent(proxy))   // ← 全局！
 *     process.env.HTTPS_PROXY = proxy                     // ← 全局！
 * 后果：宿主进程（QQ Agent）**所有**出网请求都被改道到我们填的代理上 ——
 *       包括主程序去调模型 API。用户填了一个死代理之后，整个 QQ Agent 直接不可用
 *       （报 `connect ECONNREFUSED <代理IP>:443`），而且因为代理是**全局**设置过的，
 *       就算把插件里的代理地址删掉，只要进程不重启就一直坏着。
 *       一个"查图插件"把整个机器人搞挂，这是不可接受的。
 *
 * 现在的口径：**代理只作用于本插件自己的请求**。
 *   · 用 npm `undici` 的 fetch + 每次请求单独传 `dispatcher: new ProxyAgent(proxy)`
 *     —— 一个字节的全局状态都不改（已实测 getGlobalDispatcher() 前后一致）。
 *   · **不再写** process.env.HTTPS_PROXY / HTTP_PROXY（那是进程级的，改了就影响全家）。
 *   · 没填代理时一律用内置 globalThis.fetch，连 undici 都不 import。
 *   · ProxyAgent 按代理地址缓存复用（不要每次请求 new，会漏 socket）。
 */

/** 供本地测试注入：{ fetch: fn, proxyAgent: (url) => dispatcher|null } */
let testNet = null

// 用模块级变量存 fetch，而不是直接 globalThis.fetch —— 测试脚本可以换掉它
let netFetch = globalThis.fetch
/** 最近一次出网的简述（供 diagnose 显示；**不含 Cookie 内容**）。 */
let lastRequest = ''
/** 仅供本地测试注入假实现（没有外网的机器也能验证解析逻辑）。 */
export function __setTransport(fn) {
  netFetch = fn || globalThis.fetch
  testNet = null
  proxyNote = ''
  // ⚠️ 也要把"代理那一路"的缓存清掉：否则上一段测试（比如用假 ProxyAgent 的）
  //    留下的工厂/fetch 会被下一段复用 —— 假 transport 装了却被绕过，
  //    表现成"脚本真的去联网了"，极难查。
  if (!fn) {
    proxyAgentFactory = null
    proxyFetch = null
    proxyAgentCache = { url: '', agent: null }
  }
}

/** 仅供本地测试注入 ProxyAgent 工厂（避免测试真的去 import undici）。 */
export function __setNetAdapter(adapter) {
  testNet = adapter || null
  // 注入/撤销适配器时，一并把"生产那一路"的缓存清掉 ——
  // 否则上一次真实解析出来的 undici 工厂会盖过测试注入的假工厂，
  // 测试就变成"真的建了个 ProxyAgent"，断言全错且现象极具误导性。
  proxyAgentFactory = null
  proxyFetch = null
  proxyAgentCache = { url: '', agent: null }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

let proxyNote = ''
let proxyAgentCache = { url: '', agent: null }
let proxyAgentFactory = null   // 生产用：懒加载 undici.ProxyAgent
let proxyFetch = null          // 生产用：undici 自己的 fetch（与 ProxyAgent 同一个实例）

/**
 * 懒加载 npm `undici` 的 ProxyAgent 工厂。
 *
 * ⚠️ 为什么必须用 undici 自己的 fetch：`dispatcher` 是 undici 的参数，
 *    Node 内置的 globalThis.fetch 不认它 —— 传了会被忽略，于是"以为走代理、
 *    其实直连"，失败时报的错还很像网络问题，极难排查。
 *    所以有代理时换成 undici.fetch；没代理时仍旧用内置 fetch（不 import undici）。
 *
 * 找不到就返回 null —— 调用方给出**明确的中文报错**，绝不悄悄退回"直连"或改全局。
 */
async function loadProxyAgentFactory() {
  if (testNet && typeof testNet.proxyAgent === 'function') {
    proxyFetch = testNet.fetch || netFetch
    return testNet.proxyAgent
  }
  if (proxyAgentFactory) return proxyAgentFactory
  try {
    const undici = await import('undici')
    if (typeof undici.ProxyAgent === 'function' && typeof undici.fetch === 'function') {
      proxyFetch = undici.fetch
      proxyAgentFactory = (proxyUrl) => new undici.ProxyAgent(proxyUrl)
      return proxyAgentFactory
    }
    proxyNote = 'undici 里没有 ProxyAgent/fetch，无法使用代理'
    return null
  } catch (e) {
    proxyNote = `无法加载 undici：${e && e.message ? e.message : e}`
    return null
  }
}

/**
 * 按代理地址取（并缓存）dispatcher；没有代理时返回 null。
 *
 * 「代理地址」填 `auto` 时会自动探测本机代理（见 resolveProxySetting）——
 * 这是给"代理软件每次启动都换端口"的用户准备的：Clash/mihomo 这类客户端
 * 常常把混合端口设成**每次随机**，写死一个端口过两天就失效，
 * 而失效的表现是"插件突然连不上"，很难联想到端口变了。
 */
async function dispatcherFor(cfgObj) {
  const resolved = await resolveProxySetting(cfgObj?.proxy)
  const p = resolved.proxy
  if (!p) return { dispatcher: null, proxy: '' }
  if (proxyAgentCache.url === p && proxyAgentCache.agent) return { dispatcher: proxyAgentCache.agent, proxy: p }
  const make = await loadProxyAgentFactory()
  if (!make) return { dispatcher: null, proxy: p, failed: true }
  try {
    const agent = make(p)
    proxyAgentCache = { url: p, agent }
    proxyNote = `走代理（仅本插件请求）：${p}${resolved.how ? ` · ${resolved.how}` : ''}`
    return { dispatcher: agent, proxy: p }
  } catch (e) {
    proxyNote = `代理地址无法解析（${p}）：${e && e.message ? e.message : e}`
    return { dispatcher: null, proxy: p, failed: true }
  }
}

/* ── 代理自动探测（设置里把「代理地址」填 auto）────────────────────────── */

/** 常见本地代理端口：Clash/mihomo 7890/7897、v2rayN 10809/10808、sing-box 2080… */
const PROXY_PROBE_PORTS = [7890, 7897, 7891, 10809, 10808, 1080, 2080, 8889, 20171, 7899]
let proxyProbeOverride = null   // 仅供本地测试注入
let autoProxyCache = { at: 0, proxy: '', how: '' }

/** 仅供本地测试注入：替换"自动探测代理"的实现（避免测试真的去连端口）。 */
export function __setProxyProbe(fn) {
  proxyProbeOverride = typeof fn === 'function' ? fn : null
  autoProxyCache = { at: 0, proxy: '', how: '' }
}

/** 探一下 127.0.0.1:port 通不通。 */
function tcpProbe(port, timeoutMs = 250) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (done) return; done = true; try { sock.destroy() } catch { /* ignore */ } resolve(v) }
    const sock = net.connect({ host: '127.0.0.1', port })
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

/**
 * 从 `reg query "HKCU\...\Internet Settings"` 的输出里解析出系统代理。
 *
 * 单独抽成纯函数是为了能离线测：这段文本的格式一旦变了（或 ProxyEnable 被忽略），
 * 就会出现"照着一个早就关掉的系统代理去连"这种极难查的问题。
 * 真实输出长这样：
 *     HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
 *         ProxyEnable    REG_DWORD    0x1
 *         ProxyServer    REG_SZ    127.0.0.1:54626
 * ProxyServer 还可能是按协议分组的形式：`http=127.0.0.1:7890;https=127.0.0.1:7890`。
 *
 * @returns {{proxy:string, how:string}|null} 系统代理没开 / 解析不出来 → null
 */
export function proxyFromRegistryText(text) {
  const s = String(text || '')
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(s)
  // ⚠️ 必须要求 ProxyEnable=1：代理软件关掉"系统代理"后 ProxyServer 里往往还留着旧值
  if (!enabled || parseInt(enabled[1], 16) !== 1) return null
  const m = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(s)
  if (!m || !m[1]) return null
  const val = m[1].trim()
  const perProto = /(?:^|;)\s*https?=([^;]+)/i.exec(val)
  const raw = (perProto ? perProto[1] : val).trim()
  if (!raw) return null
  return { proxy: /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`, how: 'Windows 系统代理（注册表）' }
}

/**
 * 自动找本机代理。三条路，按可靠性排序：
 * ① 先问宿主（Electron）自己的会话代理解析 —— 和浏览器/system 同一套规则，
 *    代理软件换了端口它也知道（本机就是 Electron 时最可靠的一条）；
 * ② 读 Windows 注册表里的系统代理（`HKCU\...\Internet Settings`）；
 * ③ 退回到"扫常见端口"。
 * 三条都不行就返回空 → 调用方走直连（**不会**把插件搞成不可用）。
 */
async function detectSystemProxy() {
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(import.meta.url)
    const electron = req('electron')
    const sess = electron && electron.session && electron.session.defaultSession
    if (sess && typeof sess.resolveProxy === 'function') {
      const raw = await sess.resolveProxy('https://www.pixiv.net/')
      const m = /PROXY\s+([^\s;]+)/i.exec(String(raw || ''))
      if (m && m[1]) return { proxy: `http://${m[1]}`, how: 'Electron 会话代理' }
    }
  } catch { /* 不是 Electron（或用 node 直接跑测试）→ 继续往下试 */ }

  // ② 系统代理（注册表）。一次 query 把 ProxyEnable 和 ProxyServer 都读出来。
  try {
    const { execFileSync } = await import('node:child_process')
    const out = String(execFileSync('reg', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ], { encoding: 'utf8', timeout: 2000, windowsHide: true }) || '')
    const fromReg = proxyFromRegistryText(out)
    if (fromReg) return fromReg
  } catch { /* 非 Windows / 被沙箱挡住 → 继续往下试 */ }

  for (const port of PROXY_PROBE_PORTS) {
    if (await tcpProbe(port)) return { proxy: `http://127.0.0.1:${port}`, how: `本机 127.0.0.1:${port} 在监听` }
  }
  return { proxy: '', how: '' }
}

/** 把「代理地址」设置解析成真正要用的代理；`auto` = 自动探测。 */
async function resolveProxySetting(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return { proxy: '', how: '' }
  if (!/^auto$/i.test(s)) return { proxy: s, how: '' }
  const nowMs = Date.now()
  const ttl = autoProxyCache.proxy ? 10 * 60 * 1000 : 60 * 1000
  if (autoProxyCache.at && nowMs - autoProxyCache.at < ttl) {
    return { proxy: autoProxyCache.proxy, how: autoProxyCache.how || '自动探测（缓存）' }
  }
  const found = proxyProbeOverride ? await proxyProbeOverride() : await detectSystemProxy()
  autoProxyCache = { at: nowMs, proxy: found.proxy || '', how: found.how || '' }
  if (!found.proxy) {
    proxyNote = '「代理地址」填的是 auto，但没探测到本机代理（这次走直连）—— 建议改成死地址，如 http://127.0.0.1:7890'
    apiWarn(proxyNote)
  }
  return { proxy: autoProxyCache.proxy, how: autoProxyCache.how ? `自动探测：${autoProxyCache.how}` : '' }
}

/** 出网错误分类：给用户能看懂、能照做的中文说明。 */
function netErrorText(err, url, ms) {
  const code = String((err && err.cause && err.cause.code) || (err && err.code) || '')
  const raw = String((err && err.message) || err || '')
  // ⚠️ abort 的超时标记挂在我们自己构造的那个 Error 上，它会被 fetch 包成
  //    "This operation was aborted"，所以要顺着 err.cause 一路找下去 ——
  //    只看最外层 err 会把超时误判成"未知错误"，用户就看不到"该配代理"的提示。
  const timedOut = err?.__timeout === true || err?.cause?.__timeout === true
    // undici 自己的连接级超时（最常见的一类：TCP 连不上 pixiv.net，比如大陆直连）
    || /UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ETIMEDOUT/i.test(code + raw)
  const target = (() => { try { return new URL(url).host } catch { return url } })()
  if (timedOut) {
    const lines = [
      `请求 Pixiv 超时（${ms}ms）：${target}`,
      '可能原因：没开代理 / 代理不稳 / 当前网络连不上 Pixiv。',
      '在中国大陆直连 pixiv.net 通常会超时 —— 请在扩展设置里填 proxy（如 http://127.0.0.1:7890，或直接填 auto）。',
      '注意：这个代理**只对本次 Pixiv 查询生效**，不会影响 QQ Agent 主程序。',
    ]
    // 代理这层出问题时，"当前代理到底是什么状态"是最有用的一条信息：
    // 比如 auto 没探测到本机代理（走直连了），用户看这句就知道该填死地址。
    if (proxyNote) lines.splice(2, 0, `当前代理状态：${proxyNote}`)
    return lines.join('\n')
  }
  if (/aborted|AbortError/i.test(code + raw)) {
    return `请求 ${target} 被中断（${raw}）。如果是超时导致的，请把扩展设置里的 timeoutMs 调大，或检查代理。`
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(code + raw)) {
    return `连不上 ${target}：域名解析失败（DNS）。检查网络 / 代理设置。`
  }
  if (/ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(code + raw)) {
    return [
      `连不上 ${target}：连接被拒绝或中断（${code || raw}）。`,
      proxyNote
        ? `当前代理：${proxyNote} —— 若代理软件没开或端口不对，请改掉或清空扩展设置里的「代理地址」。`
        : '若填了代理地址，确认代理软件正在运行且端口正确。',
    ].join('\n')
  }
  if (/CERT|TLS|SSL/i.test(code + raw)) {
    return `与 ${target} 的 TLS 握手失败：${raw}。若是代理软件做中间人，请信任其证书或改用 HTTP 代理。`
  }
  return `请求 ${target} 失败：${raw || code || '未知错误'}`
}

/**
 * 发一个 GET，拿回解析好的 JSON。
 *
 * ⚠️ 代理**只挂在这一次请求上**（`dispatcher` 参数），不碰任何全局状态。
 *    详见本文件第 2 节开头那段事故说明。
 *
 * @param {object} opts 额外带 `cfgObj` —— 有代理时才需要它来取 dispatcher。
 * @returns {{ok:true, json:object} | {ok:false, error:string, status?:number, html?:string}}
 */
async function httpJson(url, { cookie = '', referer = 'https://www.pixiv.net/', timeoutMs = 20000, accept = 'application/json', cfgObj = null } = {}) {
  const ac = new AbortController()
  // 超时标记挂在一个独立对象上（AbortSignal.reason），fetch 会把它包进 err.cause
  const timeoutReason = { __timeout: true, message: `timeout after ${timeoutMs}ms` }
  const timer = setTimeout(() => { try { ac.abort(timeoutReason) } catch { /* 已结束 */ } }, Math.max(3000, timeoutMs))

  // ── 代理：仅本次请求 ──
  let dispatcher = null
  if (cfgObj && String(cfgObj.proxy || '').trim()) {
    const d = await dispatcherFor(cfgObj)
    if (d.failed) {
      clearTimeout(timer)
      return {
        ok: false,
        userError: true,   // 配置问题，不该把断路器引开
        error: [
          `扩展设置里的「代理地址」用不了：${String(cfgObj.proxy).trim()}`,
          `原因：${proxyNote || '无法创建代理连接'}`,
          '请改成正确的代理地址（如 http://127.0.0.1:7890），或清空它走直连。',
          '（这个代理只影响本插件，不会影响 QQ Agent 主程序。）',
        ].join('\n'),
      }
    }
    dispatcher = d.dispatcher
  }

  const headers = {
    'User-Agent': UA,
    Accept: accept,
    'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
    Referer: referer,
    Origin: 'https://www.pixiv.net',
  }
  const ck = cleanCookie(cookie)
  if (ck) headers.Cookie = ck
  // 现代 Pixiv 前端会带 x-user-id；带上能让登录态下的接口行为更接近浏览器
  const uid = cookieValue(ck, 'p_ab_id')
  if (uid) headers['x-user-id'] = uid

  const startedAt = Date.now()
  const reqInit = { headers, signal: ac.signal, redirect: 'follow' }
  // 有代理时**必须**用 undici 自己的 fetch（dispatcher 只有它认）
  const doFetch = dispatcher ? (proxyFetch || netFetch) : netFetch
  if (dispatcher) reqInit.dispatcher = dispatcher
  let res
  try {
    res = await doFetch(url, reqInit)
  } catch (err) {
    clearTimeout(timer)
    // 诊断信息只记"哪个地址、多久、什么错"，永不记 Cookie
    lastRequest = `GET ${url} → ${netErrorText(err, url, timeoutMs).split('\n')[0]}（${Date.now() - startedAt}ms）`
    return { ok: false, error: netErrorText(err, url, timeoutMs) }
  }
  clearTimeout(timer)
  lastRequest = `GET ${url} → HTTP ${res.status}（${Date.now() - startedAt}ms）`

  let text = ''
  try { text = await res.text() } catch { text = '' }

  // ── userError 标记 ──────────────────────────────────────────────────
  // 表示"这次失败是请求本身的问题（id 不存在、内容不可见），不是上游挂了"。
  // 断路器**不统计**这类失败：换个 id 就能成，不能因为它把整个插件封掉。
  // 反之 403 / 429 / 5xx / 超时 / 风控页都算"上游现在不行"，要计数。
  if (res.status === 403) {
    return {
      ok: false,
      status: 403,
      error: [
        'Pixiv 返回 403（被拒绝）。常见原因：',
        '  · 触发了 Pixiv 的防抓取校验 —— 在扩展设置里填一次完整 Cookie（含 PHPSESSID）通常就好了；',
        '  · 用了机房/公共 IP，或个人账号被限制了访问；',
        '  · 代理出口 IP 被 Pixiv 风控。',
      ].join('\n'),
    }
  }
  if (res.status === 404) return { ok: false, status: 404, userError: true, error: 'Pixiv 返回 404：这个作品/用户不存在，或已被删除、设为私密。' }
  if (res.status === 429) return { ok: false, status: 429, error: 'Pixiv 限流（429）：查得太快了，等几十秒再试，或把 maxResults 调小。' }
  if (res.status >= 500) return { ok: false, status: res.status, error: `Pixiv 服务端错误（${res.status}），稍后重试。` }

  let json = null
  try { json = JSON.parse(text) } catch { /* 下面按 HTML 处理 */ }

  if (!json) {
    if (res.status !== 200) return { ok: false, status: res.status, error: `Pixiv 返回非 JSON（HTTP ${res.status}）。` }
    // 返回了 HTML：多半是被风控页/登录页接管了
    return { ok: false, status: 200, html: text, error: 'Pixiv 返回的是网页而不是数据（多半被风控页或登录页接管了）。填好 Cookie（含 PHPSESSID）后重试。' }
  }
  if (json.error === true) {
    const msg = String(json.message || '').trim() || 'Pixiv 返回 error=true'
    // "作品不存在/不可见"这类是请求本身的问题，不该把断路器引开
    const userish = /not\s*found|不存在|非公開|private/i.test(msg)
    return { ok: false, status: res.status, userError: userish, error: `Pixiv 报错：${msg}` }
  }
  if (res.status !== 200) return { ok: false, status: res.status, error: `Pixiv 返回 HTTP ${res.status}` }
  return { ok: true, json }
}

/* ══════════════════════════════════════════════════════════════════════
   2b. 本地图片桥：让"发不出去的 P站图"变成宿主能下载的直链
   ══════════════════════════════════════════════════════════════════════ */

// 最近一次工具调用用的配置：桥在**稍后**（宿主真去下图时）才取图，
// 那时已经没有 ctx 了，所以把配置存一份给 fetchPixivImage 用。
let lastCfgObj = null
// 桥的状态说明（只给诊断看，不含任何敏感信息）
let bridgeNote = ''

/**
 * 真正去 Pixiv 图床取一张图（**带 Referer**，**走插件自己的代理**）。
 *
 * 两个必须点：
 *   · `Referer: https://www.pixiv.net/` —— 不带就是 403（防盗链，实测 548 字节的
 *     一张错误页）；带上就是正常图片（实测 1.07MB 的 jpeg）。
 *   · Accept **不要**写 image/webp / image/avif —— 图站会按 Accept 做内容协商，
 *     回了 webp 之后本机视觉接口（LM Studio）会直接 400，连预览都做不了。
 */
async function fetchPixivImage(rawUrl, cfgObj) {
  if (!isPixivImageUrl(rawUrl)) throw new Error('不是 Pixiv 图床（pximg.net）地址')
  const ac = new AbortController()
  const timeoutMs = clampInt(cfgObj && cfgObj.timeoutMs, 3000, 120000, 20000)
  const timer = setTimeout(() => { try { ac.abort(Object.assign(new Error('取图超时'), { __timeout: true })) } catch { /* 已结束 */ } }, timeoutMs)

  let dispatcher = null
  if (cfgObj && String(cfgObj.proxy || '').trim()) {
    const d = await dispatcherFor(cfgObj)
    if (d.failed) { clearTimeout(timer); throw new Error(proxyNote || '代理不可用') }
    dispatcher = d.dispatcher
  }
  const reqInit = {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/jpeg,image/png,image/gif,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,ja;q=0.8,en;q=0.7',
      Referer: 'https://www.pixiv.net/',
    },
    signal: ac.signal,
    redirect: 'follow',
  }
  const doFetch = dispatcher ? (proxyFetch || netFetch) : netFetch
  if (dispatcher) reqInit.dispatcher = dispatcher

  let res
  try {
    res = await doFetch(rawUrl, reqInit)
  } catch (err) {
    clearTimeout(timer)
    throw new Error(netErrorText(err, rawUrl, timeoutMs).split('\n')[0])
  }
  clearTimeout(timer)
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}${res.status === 403 ? '（pximg 防盗链：请求必须带 Referer: https://www.pixiv.net/）' : ''}`)
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (!buffer.length) throw new Error('取到空内容')
  return { buffer, contentType: String(res.headers.get('content-type') || 'image/jpeg') }
}

let bridge = null

/** 按当前配置确保图片桥已启动；返回端口（0 = 没起来）。 */
async function ensureBridge(cfgObj) {
  if (!cfgObj || cfgObj.imageBridge === false) { bridgeNote = '已关闭（扩展设置里的「本地图片桥」）'; return 0 }
  if (!bridge) {
    bridge = createImageBridge({
      // 延迟取配置：真正取图时用"最近一次查询"的那份设置（代理就在里面）
      fetchImage: (u) => fetchPixivImage(u, lastCfgObj || cfgObj),
      warn: (m) => apiWarn(m),
      ttlSec: clampInt(cfgObj.bridgeTtlSec, 30, 86400, 1800),
      maxBytes: Math.max(1, Number(cfgObj.bridgeMaxMB) || 8) * 1024 * 1024,
      fetchTimeoutMs: clampInt(cfgObj.timeoutMs, 3000, 120000, 20000),
    })
  }
  const port = await bridge.start({ preferredPort: clampInt(cfgObj.bridgePort, 0, 65535, 18717) })
  const st = bridge.stats()
  bridgeNote = port
    ? `运行中：http://127.0.0.1:${port}（已服务 ${st.served} 张）`
    : `未能启动：${st.lastError || '未知原因'}`
  return port
}

/** 造一个「pximg 地址 → 本地可发直链」的同步换算函数。 */
async function makeLinker(cfgObj) {
  // 记住这份配置：宿主稍后真的来下图时，桥要用它的代理出网
  if (cfgObj) lastCfgObj = cfgObj
  const port = await ensureBridge(cfgObj)
  if (!port || !bridge) return () => ''
  return (u) => (isPixivImageUrl(u) ? bridge.link(u) : '')
}

/* ══════════════════════════════════════════════════════════════════════
   3. 连续失败断路器（多次查询失败 → 强制终止，直接让模型回话）
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 为什么要有这道闸（真实故障场景）：
 *   Pixiv 连不上时，每次查询都要等满 timeoutMs（默认 20 秒）。模型拿到
 *   "请求超时，请配代理" 这种结果后，很常见的反应是**换个关键词再试一次**。
 *   试满 3 次 = 1 分钟，而且它经常把一整轮的 12~20 次工具预算全耗在重试上，
 *   结果群里一条回复都没有 —— 用户看到的是"机器人卡死后装死"。
 *
 * 这道闸的语义：
 *   · 只统计**网络/服务层面的失败**（超时、DNS、连接被拒、403、429、5xx、
 *     返回 HTML、返回不可解析的 JSON）。这些说明"上游现在不行"，
 *     再试同样是白等。
 *   · **不统计**用户/参数层面的失败（keyword 为空、id 不合法、R-18 被闸门拒、
 *     搜到 0 条、作品 404）。这些换个参数就能成，不该被断路器连带封掉。
 *   · 连续失败达到阈值 → 打开断路器 → 在冷却期内**任何**查询都不再发请求，
 *     直接返回一段"终止指令"给模型，明确要求它停止调用工具、用中文说明情况。
 *   · 任意一次成功 → 计数器清零（上游恢复了）。
 *   · 冷却期过后自动半开：放行一次试探（失败则立刻重新打开）。
 */

/** 只在这几类失败上累加计数 —— 它们代表"上游现在不行"，重试没有意义。 */
function countsAsBreakerFailure(r) {
  if (!r || r.ok) return false
  // 明确的用户/参数错误：不计数
  if (r.userError === true) return false
  return true
}

function breakerState() {
  return {
    count: breaker.count,
    open: breaker.open,
    openedAt: breaker.openedAt,
    lastReason: breaker.lastReason,
    cooldownSec: breaker.cooldownSec,
    threshold: breaker.threshold,
    cooldownLeftSec: breaker.open
      ? Math.max(0, Math.ceil((breaker.openedAt + breaker.cooldownSec * 1000 - Date.now()) / 1000))
      : 0,
  }
}

let breaker = {
  count: 0,
  open: false,
  openedAt: 0,
  lastReason: '',
  threshold: 3,
  cooldownSec: 60,
  lastAt: 0,     // 最近一次失败时间（用于"失败窗口"判定）
  windowMs: 120000,
}

function resetBreaker() {
  breaker.count = 0
  breaker.open = false
  breaker.openedAt = 0
  breaker.lastReason = ''
  breaker.lastAt = 0
}

/**
 * 记一次失败。
 * @returns {boolean} 本次是否把断路器打开了（用于给这次失败补上"别重试"的额外说明）
 */
function noteBreakerFailure(reason, cfgObj) {
  const now = Date.now()
  breaker.threshold = clampInt(cfgObj?.breakerThreshold, 1, 20, 3)
  breaker.cooldownSec = clampInt(cfgObj?.breakerCooldownSec, 5, 3600, 60)
  // 距上次失败太久 → 视为新一轮（避免"一天里零散失败 3 次"被误判成连续失败）
  if (breaker.lastAt && now - breaker.lastAt > breaker.windowMs) breaker.count = 0
  breaker.count += 1
  breaker.lastAt = now
  breaker.lastReason = String(reason || '').split('\n')[0].slice(0, 200)
  if (breaker.count >= breaker.threshold) {
    breaker.open = true
    breaker.openedAt = now
    return true
  }
  return false
}

/** 记一次成功（上游恢复正常，计数器清零）。 */
function noteBreakerSuccess() {
  resetBreaker()
}

/**
 * 查询前的统一闸门。
 * @returns {{blocked:true, content:string} | {blocked:false, probe:boolean}}
 *   probe=true 表示这是冷却期过后放行的"试探性一次"（失败会立即重新打开）。
 */
function breakerGate(cfgObj, toolLabel) {
  if (!cfgObj || cfgObj.breakerEnabled === false) return { blocked: false, probe: false }
  breaker.threshold = clampInt(cfgObj.breakerThreshold, 1, 20, 3)
  breaker.cooldownSec = clampInt(cfgObj.breakerCooldownSec, 5, 3600, 60)
  if (!breaker.open) return { blocked: false, probe: false }

  const leftMs = breaker.openedAt + breaker.cooldownSec * 1000 - Date.now()
  if (leftMs > 0) {
    const left = Math.ceil(leftMs / 1000)
    return { blocked: true, content: blockedText(cfgObj, left, toolLabel) }
  }
  // 冷却结束 → 半开：放行一次试探
  breaker.open = false
  breaker.openedAt = 0
  return { blocked: false, probe: true }
}

/**
 * 断路器打开时返回给模型的"终止指令"。
 *
 * ⚠️ 这段文案是这个功能的核心产物，必须满足三件事：
 *   ① 明确禁止继续调用工具（否则模型会接着换关键词重试，闸门就白设了）
 *   ② 明确要求它现在就用中文把情况说给群友（否则它会只回一个空结果，群里静悄悄）
 *   ③ 给出一个不用编造的、得体的说法（否则弱模型会瞎编"我找到了"或直接道歉刷屏）
 *
 * 拆成 stopText / breakerInstructionText 两块：刚触发的那次失败要把
 * 指令拼在自己的报错后面（那一刻 breaker.count 正好等于阈值），
 * 冷却期内被拦下的调用则用 blockedText。
 */
function breakerInstructionText() {
  return [
    '👉 你现在必须这样做（不要再调用任何 pixiv 工具，包括换关键词重试、换工具、翻页）：',
    '   1. 立刻用一句自然的中文把情况告诉对方 —— 例如「P站那边我这边连不上，等会儿再试」；',
    '   2. 不要说"我找到了"、不要编造作品名或链接、不要贴出上面的技术报错；',
    '   3. 如果对方同时问了别的事，正常把别的事答完。',
  ].join('\n')
}

/** 冷却期内被拦下的调用：说明"为什么没执行" + 终止指令。 */
function blockedText(cfgObj, leftSec, toolLabel) {
  return [
    `【已完成终止】${toolLabel} 未执行：pixiv 查图插件已连续 ${breaker.count} 次查询失败，`,
    `为避免继续空耗（每次要等 ${Math.round(clampInt(cfgObj?.timeoutMs, 3000, 120000, 20000) / 1000)} 秒），`,
    `已强制停止本插件的所有查询，${leftSec} 秒内不再尝试。`,
    '',
    `最近一次失败原因：${breaker.lastReason || '连不上 Pixiv'}`,
    '',
    breakerInstructionText(),
  ].join('\n')
}

/** 触发断路器的那一次失败：在报错后面接上终止指令。 */
function trippedText(cfgObj, toolLabel) {
  return [
    `⛔ 这已经是连续第 ${breaker.count} 次失败，插件已强制停止后续查询`
    + `（${breaker.cooldownSec} 秒内 ${toolLabel} 等所有查询都会被直接拒绝）。`,
    breakerInstructionText(),
  ].join('\n')
}

/* ══════════════════════════════════════════════════════════════════════
   4. 参数夹取（服务端二次夹紧，不信模型）
   ══════════════════════════════════════════════════════════════════════ */

/** 整数夹取。 */
function clampInt(v, min, max, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, Math.round(n)))
}

const ORDERS = ['date_d', 'date', 'popular_d', 'popular', 'popular_male_d', 'popular_male', 'popular_female_d', 'popular_female']
const S_MODES = ['s_tag_full', 's_tag', 's_tc']
const RANK_MODES = ['daily', 'weekly', 'monthly', 'rookie', 'original', 'male', 'female', 'daily_r18', 'weekly_r18', 'male_r18', 'female_r18']
const RANK_CONTENTS = ['illust', 'manga', 'ugoira', 'complex']

function pickEnum(v, allowed, dflt) {
  const s = String(v == null ? '' : v).trim().toLowerCase()
  return allowed.includes(s) ? s : dflt
}

/** 搜索词清洗：Pixiv 的 word 参数不能带裸换行，且太长会 400。 */
function cleanKeyword(raw) {
  return String(raw == null ? '' : raw)
    .split(/[\r\n\t]+/).join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 120)
}

/** 宽高比描述（QQ 里模型转述"竖图/横图"比报数字有用）。 */
function ratioText(w, h) {
  const W = Number(w) || 0
  const H = Number(h) || 0
  if (!W || !H) return ''
  const r = W / H
  if (r < 0.85) return '竖图'
  if (r > 1.18) return '横图'
  return '方图'
}

const TYPE_TEXT = { 0: '插画', 1: '漫画', 2: '动图' }

/* ══════════════════════════════════════════════════════════════════════
   5. 搜索
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 把 Pixiv 搜索返回的一条作品压成给模型看的紧凑对象。
 * 字段名用中文，是为了让模型直接照抄给群友（也省 token）。
 *
 * @param {object} it   Pixiv 原始条目
 * @param {(url:string)=>string} [link] 把 pximg 地址换成"本地可发直链"的换算函数
 */
function squeezeSearchItem(it, link) {
  const w = Number(it.width) || 0
  const h = Number(it.height) || 0
  const out = {
    id: String(it.id),
    标题: String(it.title ?? ''),
    作者: String(it.userName ?? ''),
    作者id: String(it.userId ?? ''),
    类型: TYPE_TEXT[it.illustType] || '插画',
    日期: String(it.createDate ?? '').slice(0, 10),
    尺寸: w && h ? `${w}×${h}（${ratioText(w, h)}）` : '',
    页数: Number(it.pageCount) || 1,
    标签: (Array.isArray(it.tags) ? it.tags : []).slice(0, 8).map(String),
    链接: `https://www.pixiv.net/artworks/${it.id}`,
  }
  if (Number(it.xRestrict) > 0) out.分级 = 'R-18'
  if (it.bookmarkCount !== undefined && it.bookmarkCount !== null) out.收藏 = Number(it.bookmarkCount) || 0
  if (it.url) {
    // 缩略图：Pixiv 图床有防盗链，这个地址**不能**直接发给宿主下载（没 Referer 会 403）
    out.缩略图 = String(it.url)
    // 发图直链：本插件把缩略图换算成长边 1200 的大图、自己取回来、再给宿主一条
    // 127.0.0.1 的本地直链 —— 这一条才是能喂给发图工具（TOOL_SEND_IMAGE）的。
    const big = masterFromThumb(String(it.url))
    const local = link ? link(big) : ''
    if (local) out.发图直链 = local
  }
  return out
}

async function doSearch(args, cfgObj) {
  const keyword = cleanKeyword(args && args.keyword)
  if (!keyword) return { content: '错误：keyword（搜索关键词）不能为空。', isError: true }

  // 上限口径：管理员在扩展设置里定的 maxResults 是**上限**，模型只能在
  // [1, maxResults] 之间调小；没传就用 maxResults。绝不允许模型传个大的把上限顶掉。
  // （这里最容易写错：把 clamp 的 dflt 写成 maxResults 之外的表达式，
  //   结果 limit=999 反而被夹到 50，绕过了管理员设的 10。）
  const maxAllowed = clampInt(cfgObj.maxResults, 1, 50, 10)
  const limit = clampInt(args && args.limit, 1, maxAllowed, maxAllowed)
  const order = pickEnum(args && args.order, ORDERS, cfgObj.order)
  const sMode = pickEnum(args && args.sMode, S_MODES, 's_tag')
  const wantR18 = args && args.r18 === true
  if (wantR18 && !cfgObj.allowR18) {
    return {
      content: '错误：扩展设置里没有打开「允许查询 R-18 内容」（allowR18），本次请求的 r18=true 被拒绝。若确实需要，让管理员在插件设置里打开。',
      isError: true,
    }
  }
  const mode = wantR18 && cfgObj.allowR18 ? 'r18' : 'safe'
  const page = clampInt(args && args.page, 1, Math.max(1, cfgObj.maxPages), 1)

  // ── 断路器闸门：连续失败到阈值后，在冷却期内**一个请求都不发** ──
  const gate = breakerGate(cfgObj, `搜索「${keyword}」`)
  if (gate.blocked) return { content: gate.content, isError: true }
  const kw = encodeURIComponent(keyword)
  const qs = new URLSearchParams({
    word: keyword,
    order,
    mode,
    p: String(page),
    s_mode: sMode,
    type: 'all',
    lang: 'zh',
  })
  const url = `https://www.pixiv.net/ajax/search/artworks/${kw}?${qs.toString()}`

  const r = await httpJson(url, {
    cookie: cfgObj.cookie,
    referer: `https://www.pixiv.net/tags/${kw}/artworks`,
    timeoutMs: cfgObj.timeoutMs,
    cfgObj,
  })
  if (!r.ok) {
    const tripped = countsAsBreakerFailure(r) ? noteBreakerFailure(r.error, cfgObj) : false
    const tail = tripped ? `\n\n${trippedText(cfgObj, `搜索「${keyword}」`)}` : ''
    return {
      content: `搜索 Pixiv 失败（关键词：${keyword}）\n${r.error}\n\n（排查：扩展设置里点「Cookie 状态」看有没有填；Pixiv 需要能访问 pixiv.net 的网络环境。）${tail}`,
      isError: true,
    }
  }
  // 上游正常 → 清零（能成功就说明恢复了，半开探针也走这条）
  noteBreakerSuccess()

  const body = r.json.body || {}
  // 搜索的插画列表在 body.illustManga.data；老版本/异常响应可能只有 body.illust
  const box = body.illustManga || body.illust || {}
  const list = Array.isArray(box.data) ? box.data : []
  const total = Number(box.total) || 0

  // 先把图片桥准备好（起不来就只是没有「发图直链」字段，查询本身照常工作）
  const link = await makeLinker(cfgObj)
  const items = list.slice(0, limit).map((it) => squeezeSearchItem(it, link))

  // R-18 过滤：即使 mode=safe，个别作品仍可能带 xRestrict（Pixiv 自己的标记）
  const filtered = cfgObj.allowR18 ? items : items.filter((x) => x.分级 !== 'R-18')
  const dropped = items.length - filtered.length

  if (!filtered.length) {
    return {
      content: JSON.stringify({
        关键词: keyword,
        来源: 'Pixiv 搜索（mode=' + mode + '）',
        命中总数: total,
        结果: [],
        说明: total > 0
          ? `Pixiv 说命中 ${total} 条，但本次拿到的都因分级被过滤掉了。若确实要找这类内容，让管理员打开「允许查询 R-18 内容」。`
          : '没搜到。换个更短/更常见的关键词，或改用 s_mode=s_tc（按标题/简介搜）再试一次。Pixiv 标签以日文、英文为主，中文命中率较低。',
      }, null, 1),
    }
  }

  const out = {
    关键词: keyword,
    来源: `Pixiv 搜索（order=${order}，mode=${mode}，s_mode=${sMode}，第 ${page} 页）`,
    命中总数: total,
    返回条数: filtered.length,
    结果: filtered,
    用法提示: `把「标题 + 作者 + 链接」直接发给群友；要发图就把 发图直链 整条照抄给 ${TOOL_SEND_IMAGE}(url, kind, peerId)`
      + '（它是本插件生成的本地直链，宿主能直接下载。kind/peerId 就是当前会话，见来源标注）。'
      + `⚠️ 缩略图 那个 i.pximg.net 地址**不能**直接发给 ${TOOL_SEND_IMAGE}：pximg 有防盗链，宿主没带 Referer，会 403 或下载失败。`
      + '要详细资料（收藏数/标签/简介/多图原图）就用 artwork 工具传 id。',
  }
  if (dropped > 0) out.已过滤R18条数 = dropped
  if (!cfgObj.cookie) out.提示 = '当前没有填 Cookie：R-18 相关内容、部分个性化排序拿不到。'
  return { content: JSON.stringify(out, null, 1) }
}

/* ══════════════════════════════════════════════════════════════════════
   6. 作品详情
   ══════════════════════════════════════════════════════════════════════ */

/** 简介是 HTML（含 <br>、<a>），转成纯文本再截断 —— 别把标签原样喂给模型。 */
function htmlToText(html, max = 400) {
  let s = String(html == null ? '' : html)
  s = s.replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (s.length > max) s = s.slice(0, max) + '…'
  return s
}

/** 从用户输入里抠出作品 id：支持纯数字、artworks/123 链接、...?illust_id=123。 */
function extractIds(raw) {
  const out = []
  const push = (v) => {
    const s = String(v == null ? '' : v).trim()
    if (/^\d{4,12}$/.test(s) && !out.includes(s)) out.push(s)
  }
  if (Array.isArray(raw)) {
    for (const x of raw) push(x)
  } else {
    const s = String(raw == null ? '' : raw)
    for (const m of s.matchAll(/(\d{4,12})/g)) push(m[1])
  }
  return out.slice(0, 5) // 一次最多 5 个，防"批量查 100 个"把 Pixiv 打爆
}

async function fetchArtworkDetail(id, cfgObj, link) {
  const url = `https://www.pixiv.net/ajax/illust/${id}`
  const r = await httpJson(url, {
    cookie: cfgObj.cookie,
    referer: `https://www.pixiv.net/artworks/${id}`,
    timeoutMs: cfgObj.timeoutMs,
    cfgObj,
  })
  if (!r.ok) return { ok: false, error: r.error, raw: r }
  const b = r.json.body || {}
  const w = Number(b.width) || 0
  const h = Number(b.height) || 0
  const item = {
    id: String(b.illustId || b.id || id),
    标题: String(b.illustTitle || b.title || ''),
    作者: String(b.userName || ''),
    作者id: String(b.userId || ''),
    类型: TYPE_TEXT[b.illustType] || '插画',
    分级: Number(b.xRestrict) > 0 ? 'R-18' : '全年龄',
    日期: String(b.createDate || '').slice(0, 10),
    尺寸: w && h ? `${w}×${h}（${ratioText(w, h)}）` : '',
    页数: Number(b.pageCount) || 1,
    收藏数: Number(b.bookmarkCount) || 0,
    点赞数: Number(b.likeCount) || 0,
    浏览数: Number(b.viewCount) || 0,
    标签: ((b.tags && b.tags.tags) || []).map((t) => String(t.tag)).filter(Boolean).slice(0, 20),
    简介: htmlToText(b.illustComment || b.description || '', 400),
    链接: `https://www.pixiv.net/artworks/${b.illustId || b.id || id}`,
  }
  if (b.urls) {
    const thumb = b.urls.thumb || b.urls.small || ''
    // 长边 1200 的大图：清晰度和体积最平衡，宿主默认单张上限（5MB）几乎总能过
    const big = b.urls.regular || b.urls.large || thumb
    const orig = b.urls.original || big
    item.图 = {
      缩略图: thumb,
      大图: big,
      原图: orig,
      说明: `pximg 图床有防盗链：直接把这些地址喂给 ${TOOL_SEND_IMAGE} 会 403（没带 Referer）。`
        + '要发图请用 发图直链（本插件已经把图取好了，宿主能直接下载）。',
    }
    const sendBig = link ? link(big) : ''
    if (sendBig) item.图.发图直链 = sendBig
    const sendOrig = link && orig !== big ? link(orig) : ''
    // 原图常常 3~10MB，可能超过宿主「单张图片上限」（默认 5MB）；发不出时宿主会明确报超限。
    if (sendOrig) item.图.原图直链 = sendOrig
  }
  // 多图：拿每一页的地址（只在确实多图时多打一次接口）
  if (item.页数 > 1) {
    const pr = await httpJson(`https://www.pixiv.net/ajax/illust/${item.id}/pages`, {
      cookie: cfgObj.cookie,
      referer: `https://www.pixiv.net/artworks/${item.id}`,
      timeoutMs: cfgObj.timeoutMs,
      cfgObj,
    })
    if (pr.ok && Array.isArray(pr.json.body)) {
      item.每页原图 = pr.json.body.slice(0, 12).map((p, i) => `p${i}: ${p.urls && p.urls.original ? p.urls.original : ''}`)
      // 每页的**可发**直链：用 master1200（不是原图），最多给 4 页 ——
      // 一次处理最多也就发得出 2 张，给太多只会刷爆上下文。
      const pageLinks = pr.json.body.slice(0, 4).map((p, i) => {
        const u = (p.urls && (p.urls.regular || p.urls.original)) || ''
        const l = link && u ? link(u) : ''
        return l ? `p${i}: ${l}` : ''
      }).filter(Boolean)
      if (pageLinks.length) item.每页发图直链 = pageLinks
    } else if (!pr.ok) {
      item.每页原图错误 = pr.error
    }
  }
  return { ok: true, item }
}

async function doArtwork(args, cfgObj) {
  const ids = extractIds((args && args.ids) !== undefined ? args.ids : (args && args.id))
  if (!ids.length) {
    return {
      content: '错误：需要传作品 id（ids）。可以直接给数字，也可以给 https://www.pixiv.net/artworks/123456 这样的链接。',
      isError: true,
    }
  }

  // ── 断路器闸门（在发给多个 id 之前先判一次）──
  const gate = breakerGate(cfgObj, `查作品 ${ids.join('/')}`)
  if (gate.blocked) return { content: gate.content, isError: true }
  // 图片桥先准备好（起不来就只是没有「发图直链」字段）
  const link = await makeLinker(cfgObj)
  const items = []
  const errors = []
  let tripped = false
  for (const id of ids) {
    // 一次失败就可能把断路器打开（阈值=1 时），后面的 id 不要再白等一轮超时
    if (breaker.open && cfgObj.breakerEnabled !== false) {
      errors.push(`#${id}：已被断路器跳过（连续失败，暂不继续查询）`)
      continue
    }
    const r = await fetchArtworkDetail(id, cfgObj, link)
    if (r.ok) { items.push(r.item); continue }
    errors.push(`#${id}：${r.error}`)
    if (countsAsBreakerFailure(r.raw)) {
      if (noteBreakerFailure(r.error, cfgObj)) tripped = true
    }
  }

  if (!items.length) {
    let content = `查询 Pixiv 作品详情失败\n${errors.join('\n')}`
    if (tripped) content += `\n\n${trippedText(cfgObj, '查作品')}`
    return { content, isError: true }
  }

  // 只要有一条成功，就说明上游是通的 → 计数器清零
  // （不区分 half-open 探针：探针成功同样说明已恢复）
  noteBreakerSuccess()

  const out = {
    查询条数: items.length,
    作品: items,
    发图提示: `要发图就把「图.发图直链」整条**照抄**给 ${TOOL_SEND_IMAGE}(url, kind, peerId)（kind/peerId 取本轮来源标注里的会话）；`
      + '它指向本插件刚取到的图，宿主能直接下载。'
      + '⚠️ 不要用 i.pximg.net 的原始地址：pximg 有防盗链，宿主没带 Referer，下载会失败（403/超时）。',
  }
  if (errors.length) out.失败 = errors
  return { content: JSON.stringify(out, null, 1) }
}

/* ══════════════════════════════════════════════════════════════════════
   7. 排行榜
   ══════════════════════════════════════════════════════════════════════ */

async function doRanking(args, cfgObj) {
  const mode = pickEnum(args && args.mode, RANK_MODES, 'daily')
  if (/_r18$/.test(mode) && !cfgObj.allowR18) {
    return {
      content: '错误：R-18 榜单需要在扩展设置里打开「允许查询 R-18 内容」（allowR18）。',
      isError: true,
    }
  }
  const content = pickEnum(args && args.content, RANK_CONTENTS, 'illust')
  // 同样按"管理员设的上限"夹取，模型不能自己放大
  const maxAllowed = clampInt(cfgObj.maxResults, 1, 50, 10)
  const limit = clampInt(args && args.limit, 1, maxAllowed, Math.min(20, maxAllowed))
  const dateRaw = String((args && args.date) || '').trim()
  const date = /^\d{8}$/.test(dateRaw) ? dateRaw : ''

  // ── 断路器闸门 ──
  const gate = breakerGate(cfgObj, `取${mode}榜`)
  if (gate.blocked) return { content: gate.content, isError: true }
  const qs = new URLSearchParams({ format: 'json', mode, content, p: '1' })
  if (date) qs.set('date', date)
  const url = `https://www.pixiv.net/ranking.php?${qs.toString()}`

  const r = await httpJson(url, { cookie: cfgObj.cookie, timeoutMs: cfgObj.timeoutMs, accept: 'application/json', cfgObj })
  if (!r.ok) {
    const tripped = countsAsBreakerFailure(r) ? noteBreakerFailure(r.error, cfgObj) : false
    const tail = tripped ? `\n\n${trippedText(cfgObj, `取${mode}榜`)}` : ''
    return {
      content: `获取 Pixiv 榜单失败（mode=${mode}，content=${content}）\n${r.error}${tail}`,
      isError: true,
    }
  }
  noteBreakerSuccess()
  const list = Array.isArray(r.json.contents) ? r.json.contents : []
  if (!list.length) {
    return { content: `Pixiv 榜单（mode=${mode}）没有返回条目${date ? `（date=${date}）` : ''}。换 mode 或去掉日期再试。`, isError: true }
  }
  const link = await makeLinker(cfgObj)
  let items = list.map((it) => {
    const w = Number(it.width) || 0
    const h = Number(it.height) || 0
    const o = {
      名次: Number(it.rank) || 0,
      id: String(it.illust_id),
      标题: String(it.title ?? ''),
      作者: String(it.user_name ?? ''),
      类型: TYPE_TEXT[it.illust_type] || '插画',
      日期: String(it.date ?? '').slice(0, 10),
      标签: String(it.tags ?? '').split(' ').filter(Boolean).slice(0, 8),
      链接: `https://www.pixiv.net/artworks/${it.illust_id}`,
    }
    if (w && h) o.尺寸 = `${w}×${h}（${ratioText(w, h)}）`
    if (it.url) {
      o.缩略图 = String(it.url)
      // 榜单接口给的是带 /c/240x480/ 前缀的缩略图，换算成 master1200 再交给图片桥
      const local = link ? link(masterFromThumb(String(it.url))) : ''
      if (local) o.发图直链 = local
    }
    if (it.illust_content_type && Number(it.illust_content_type.sexual) > 0) o.分级 = 'R-18'
    return o
  })
  const before = items.length
  if (!cfgObj.allowR18) items = items.filter((x) => x.分级 !== 'R-18')
  items = items.slice(0, limit)

  const out = {
    榜单: `Pixiv ${mode} 榜（${content}${date ? `，${date}` : ''}）`,
    返回条数: items.length,
    结果: items,
    用法提示: `报给群友时用「第N名 标题 — 作者」的形式，附上链接；要发图就把 发图直链 整条照抄给 ${TOOL_SEND_IMAGE}(url, kind, peerId)。`,
  }
  if (before !== items.length) out.已过滤R18条数 = before - items.length
  return { content: JSON.stringify(out, null, 1) }
}

/* ══════════════════════════════════════════════════════════════════════
   8. 上游要的导出：available / setup / promptSections / dispose / diagnose
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 依赖自检。**必须同步** —— 上游在 isActive() 里同步调用它。
 *
 * 口径（重要）：这里**只判开关**，不判网络、不判 Cookie。
 * 因为上游判定"不可用"会把整个 Skill 连同工具一起摘掉，模型连工具名都看不到，
 * 用户只会觉得"功能凭空消失"。所以任何运行期问题都留到 execute() 里，
 * 返回写明原因和解决办法的中文报错。
 */
export function available(context = {}) {
  const c = cfg(context)
  if (c.enabled === false) {
    return { ok: false, reason: 'pixiv 查图插件开关未打开（控制台 → 扩展 → pixiv 查图插件 → 启用）' }
  }
  return { ok: true }
}

export function setup(api) {
  cfgOf = (context) => {
    const fromRun = context && context.config && context.config.skills && context.config.skills[SKILL_ID]
    if (fromRun && typeof fromRun === 'object') return fromRun
    try { return (api.config && api.config()) || {} } catch { return {} }
  }
  apiWarn = (...a) => { try { api.warn && api.warn(...a) } catch { /* 日志失败不影响功能 */ } }

  // ★ InteractBot 适配③：把**模型实际看到的工具名**从宿主那里拿过来。
  //   `api.toolName(id)` 是本宿主对上游契约的扩展；拿不到（跑在别的宿主里）就退回上游命名 ——
  //   所以同一份代码在两个宿主里都能跑，而不是"改成只认 InteractBot"。
  const hostName = (id, fallback) => {
    try { return (api.toolName && api.toolName(id)) || fallback } catch { return fallback }
  }
  TOOL_SEARCH = hostName('search', TOOL_SEARCH)
  TOOL_ARTWORK = hostName('artwork', TOOL_ARTWORK)
  TOOL_RANKING = hostName('ranking', TOOL_RANKING)
  //   发图工具是**宿主自己的**工具（不属于本技能），所以走另一个出口 `api.hostTool(id)`。
  const hostTool = (id, fallback) => {
    try { return (api.hostTool && api.hostTool(id)) || fallback } catch { return fallback }
  }
  TOOL_SEND_IMAGE = hostTool('send_image', TOOL_SEND_IMAGE)

  /* ── 工具 1：搜索 ───────────────────────────────────────────────── */
  api.registerTool({
    id: 'search',
    name: 'Pixiv 搜图',
    category: 'media',
    icon: '🎨',
    description:
      '在 Pixiv（P站）按关键词搜插画/漫画，返回【作品id + 标题 + 作者 + 标签 + 链接 + 尺寸页数 + 发图直链】。'
      + '适合"帮我找 XX 的图""有没有 XX 的插画""P站上 XX 的图"这类请求。'
      + 'keyword 用对方说的词原样传进去即可 —— 中文、日文、英文都行，不用先翻译'
      + '（但 Pixiv 标签以日文/英文为主，中文命中率较低，中文搜不到可以换日文或英文说法再试）。'
      + `默认按热度排序（popular_d）。想看最新就传 order=date_d；想按标题/简介搜就传 sMode=s_tc。`
      + `拿到 id 后如果还要收藏数、简介、多图原图，用 ${TOOL_ARTWORK} 补查。`
      + `结果里的「发图直链」是能直接喂给 ${TOOL_SEND_IMAGE}(url, kind, peerId) 的地址（本插件已经把图取回来了）；`
      + '「缩略图」那个 i.pximg.net 地址不能直接发（防盗链会 403）。'
      + '只返回作品信息和链接，不要根据成人向作品生成露骨内容；扩展设置里没打开 R-18 时，这类结果会被自动过滤。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词（角色名/作品名/题材/画师名，中日英文都可，按对方原话传）' },
        limit: { type: 'integer', description: '最多返回几条（默认取扩展设置的每页条数，上限 50）' },
        order: {
          type: 'string',
          enum: ORDERS,
          description: '排序：popular_d=按热度（默认）；date_d=按最新；popular_male_d/popular_female_d=男性/女性向热度',
        },
        sMode: {
          type: 'string',
          enum: S_MODES,
          description: '匹配方式：s_tag=标签模糊（默认）；s_tag_full=标签精确；s_tc=标题或简介',
        },
        page: { type: 'integer', description: '页码，从 1 开始（默认 1，上限取扩展设置）' },
        r18: { type: 'boolean', description: 'true=只查 R-18（需要管理员在扩展设置里打开 allowR18，否则会被拒绝）' },
      },
      required: ['keyword'],
    },
    async execute(ctx, args) {
      const c = cfg(ctx)
      if (c.allowInGroup === false && ctx && ctx.kind === 'group') {
        return { content: '错误：pixiv 查图插件被设置为只在私聊可用（扩展设置里关掉了群聊）。', isError: true }
      }
      try { return await doSearch(args, c) } catch (e) {
        return { content: `搜索出错了：${(e && e.message) || e}`, isError: true }
      }
    },
  })

  /* ── 工具 2：作品详情 ───────────────────────────────────────────── */
  api.registerTool({
    id: 'artwork',
    name: 'Pixiv 作品详情',
    category: 'media',
    icon: '🖼️',
    description:
      '按作品 id 查 Pixiv 作品的详细信息：标题、作者、标签、收藏/点赞/浏览数、尺寸、页数、简介、'
      + `以及缩略图/大图/原图地址，还有**能直接发给 ${TOOL_SEND_IMAGE} 的「发图直链」**（多图作品还会给出前几页的直链）。`
      + 'ids 可以传单个 id、逗号分隔的多个 id，或 https://www.pixiv.net/artworks/123456 这样的链接（一次最多 5 个）。'
      + `注意：i.pximg.net 有防盗链，原始图链**不能**直接喂给 ${TOOL_SEND_IMAGE}（会 403）—— 发图一律用「发图直链」。`,
    parameters: {
      type: 'object',
      properties: {
        ids: { type: 'string', description: '一个或多个作品 id / artworks 链接（逗号或空格分隔，最多 5 个）' },
      },
      required: ['ids'],
    },
    async execute(ctx, args) {
      const c = cfg(ctx)
      if (c.allowInGroup === false && ctx && ctx.kind === 'group') {
        return { content: '错误：pixiv 查图插件被设置为只在私聊可用。', isError: true }
      }
      try { return await doArtwork(args, c) } catch (e) {
        return { content: `查询作品详情出错了：${(e && e.message) || e}`, isError: true }
      }
    },
  })

  /* ── 工具 3：排行榜 ─────────────────────────────────────────────── */
  api.registerTool({
    id: 'ranking',
    name: 'Pixiv 排行榜',
    category: 'media',
    icon: '🏆',
    description:
      '取 Pixiv 排行榜：日榜/周榜/月榜/新人榜/原创榜，以及男性向、女性向榜。'
      + '适合"今天 P站有什么好图""最近的热门插画"这类请求。'
      + `结果里的「发图直链」可以直接喂给 ${TOOL_SEND_IMAGE}(url, kind, peerId) 发出去（kind/peerId 取来源标注里的会话）。`
      + 'R-18 榜单（mode 以 _r18 结尾）需要管理员在扩展设置里打开 allowR18。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: RANK_MODES,
          description: '榜单类型：daily=日榜（默认）、weekly=周榜、monthly=月榜、rookie=新人、original=原创、male/female=男性向/女性向',
        },
        content: { type: 'string', enum: RANK_CONTENTS, description: '内容类型：illust=插画（默认）、manga=漫画、ugoira=动图、complex=不筛选' },
        limit: { type: 'integer', description: '返回前几名（默认 20，上限 50）' },
        date: { type: 'string', description: '指定日期 yyyymmdd（可省略，省略则取最新一期）' },
      },
      required: [],
    },
    async execute(ctx, args) {
      const c = cfg(ctx)
      if (c.allowInGroup === false && ctx && ctx.kind === 'group') {
        return { content: '错误：pixiv 查图插件被设置为只在私聊可用。', isError: true }
      }
      try { return await doRanking(args, c) } catch (e) {
        return { content: `获取榜单出错了：${(e && e.message) || e}`, isError: true }
      }
    },
  })
}

/**
 * 提示词片段。跟着开关走 —— 工具被上游摘掉之后，提示词里若还写着"用 XX 查"，
 * 模型会去调一个不存在的工具。
 * ⚠️ 依赖 setup 先跑过（上游加载顺序是先 setup 再读片段）。
 */
export function promptSections(context = {}) {
  const c = cfg(context)
  if (c.enabled === false) return []
  const groupNote = c.allowInGroup === false ? '（这个工具只在私聊可用，群里不要提它。）' : ''
  const cookieNote = c.cookie
    ? ''
    : '（管理员还没给这个插件填 Cookie：R-18 类内容和部分排序拿不到，属正常现象。）'
  return [{
    id: 'pixiv-lookup-hint',
    title: 'Pixiv 查图',
    priority: 35,
    content: [
      `- 群友想要 P站（Pixiv）的图、问"有没有 XX 的插画""帮我找 XX 的图""P站上 XX"时，用 ${TOOL_SEARCH} 搜：`,
      '  关键词用对方说的词**原样**传进去就行，中文/日文/英文都可以，不用先翻译。'
      + '（Pixiv 的标签以日文、英文为主，中文命中率较低；中文搜不到时**可以**换一个日文或英文说法再试一次，'
      + '但不要反复试很多次，也不要自己编造作品 id。）',
      `- 拿到 id 后想看收藏数、简介、多图原图地址，用 ${TOOL_ARTWORK} 补查；想看当下热门用 ${TOOL_RANKING}。`,
      '- 报给群友时用「标题 — 作者 + https://www.pixiv.net/artworks/<id> 链接」这个形式，别只丢一个 id。',
      '- **要发图就用结果里的「发图直链」**（形如 http://127.0.0.1:端口/i/xxxx）——那是插件已经把图取回来的本地地址，'
      + `整条照抄给 ${TOOL_SEND_IMAGE}(url, kind, peerId) 就能发出去。**kind 与 peerId 必须带上** —— 它们就是本轮来源标注里那串号码（kind 填 private/group）；不带会被直接拒绝，而且我不会去猜你在哪个会话里。`
      + `**不要**把 i.pximg.net 的缩略图/原图地址发给 ${TOOL_SEND_IMAGE}：pximg 有防盗链、还要走代理，宿主自己下必然失败`
      + '（403 或「图片下载失败」）。也**不要**把 pximg 裸链当成"群友点开就能看"的图。',
      `- 如果 ${TOOL_SEND_IMAGE} 报「拒绝内网/回环地址」或提到「被安全设置挡住了」，`
      + '那是宿主的安全开关没开（**控制台 → 扩展 → 允许下载内网/本机图片地址**）。'
      + '这时**不要再换图反复试**，用一句中文说明"图被安全设置挡住了，让管理员开一下"即可。',
      '- **查询失败时不要反复重试**：如果返回里出现「已完成终止」「插件已强制停止后续查询」，说明插件已经连续失败多次'
      + '（通常是网络到不了 Pixiv），此时**立刻停止调用任何 pixiv 工具**，直接用一句自然的中文把情况告诉对方'
      + '（例如「P站那边我这边连不上，等会儿再试」），不要编造作品名或链接，也不要把技术报错贴出来。'
      + '最多在原关键词明显不合适时换一个说法试一次，不要为了"多试几个词"连调多次。',
      '- 不要根据成人向（R-18）作品生成露骨内容；扩展设置没打开 R-18 时这类结果本来就会被过滤掉，照实说"这类没开"即可。',
      groupNote,
      cookieNote,
    ].filter(Boolean).join('\n'),
  }]
}

/** 上游若调用 dispose 就走这里（本 Skill 无常驻连接，只需清缓存 + 关掉图片桥）。 */
export function dispose() {
  // 清掉缓存的 ProxyAgent（不碰任何全局 dispatcher —— 我们从没改过它）
  try { proxyAgentCache.agent?.close?.() } catch { /* ignore */ }
  proxyAgentCache = { url: '', agent: null }
  proxyNote = ''
  // 关掉本地图片桥：插件被停用/重载后不该再留一个监听端口
  try { bridge?.stop?.() } catch { /* ignore */ }
  bridge = null
  bridgeNote = ''
  lastCfgObj = null
  resetBreaker()
}

/**
 * 仅供本地测试用：把断路器恢复初始状态。
 *
 * 为什么必须导出：断路器是**进程级**状态（就是要跨工具、跨轮次生效，
 * 否则"连续失败"根本统计不出来）。所以自测里每段用例之间要能重置它，
 * 不然前一段故意制造的失败会把后一段的正常查询全挡掉。
 */
export function __resetBreaker() {
  resetBreaker()
}

/**
 * 排障：把"开关 / Cookie 状态 / 代理 / 上限 / 最近一次请求"打出来。
 *
 * 为什么值得导出：这个插件最容易的坏法是**静默拿不到数据**（Cookie 没填、代理没开、
 * Pixiv 直连超时）。有这个函数就能一眼看出卡在哪一步，而不是靠猜。
 * ⚠️ Cookie 只输出状态摘要，绝不回显原文。
 */
export function diagnose(context = {}) {
  const c = cfg(context)
  const b = breakerState()
  const bs = bridge ? bridge.stats() : null
  return {
    开关: c.enabled === false ? '关' : '开',
    Cookie: cookieStatus(c.cookie),
    代理: c.proxy
      ? (/^auto$/i.test(String(c.proxy).trim())
        ? `auto（自动探测本机代理）${proxyNote ? ` · ${proxyNote}` : ' · 尚未发起请求，未生效判定'} · 仅作用于本插件请求，不影响 QQ Agent 主程序`
        : `${c.proxy}（${proxyNote || '尚未发起请求，未生效判定'}）· 仅作用于本插件请求，不影响 QQ Agent 主程序`)
      : '未配置（本插件走直连；不改动宿主任何全局网络设置）',
    图片桥: c.imageBridge === false
      ? '已关闭（扩展设置里的「本地图片桥」）'
      : (bs && bs.running
        ? `${bridgeNote} · 待发直链 ${bs.tickets} 条 · 已缓存 ${bs.cached} 张`
          + (bs.lastError ? ` · 最近错误：${bs.lastError}` : '')
        : `尚未启动（第一次查询时会自动在本机开一个只监听 127.0.0.1 的小服务）${bridgeNote ? ` · ${bridgeNote}` : ''}`),
    图片桥提示: '宿主侧需要打开「允许下载内网/本机图片地址」(security.allowPrivateImageHosts=true)，'
      + '否则宿主的 SSRF 保护会挡掉 127.0.0.1 直链（报「域名解析到内网/本机地址，已阻止」）。',
    每页条数: c.maxResults,
    最大翻页: c.maxPages,
    默认排序: c.order,
    R18: c.allowR18 ? '允许' : '禁止',
    群里可用: c.allowInGroup ? '是' : '否（仅私聊）',
    超时毫秒: c.timeoutMs,
    断路器: c.breakerEnabled === false
      ? '已关闭'
      : `${b.open ? '已触发（终止中）' : '待命'} · 连续失败 ${b.count}/${b.threshold}`
        + ` · 冷却 ${b.cooldownLeftSec}s/${b.cooldownSec}s`
        + (b.lastReason ? ` · 最近原因：${b.lastReason}` : ''),
    最近请求: lastRequest || '（本次进程还没发起过请求）',
  }
}

/**
 * 仅供本地测试/审计用：把内置默认值暴露出来。
 * 为什么值得导出：断路器的"默认开"同时写在两处（本文件的 DEFAULTS 与 skill.json 的 settings），
 * 两处口径不一致时，界面显示的默认值会和运行时行为不符 —— 这种静默分裂很难靠肉眼发现。
 * 自测会断言两边一致。
 */
export function __defaults() {
  return { ...DEFAULTS }
}

/** 最近一次出网的简述（诊断用；不含 Cookie 内容）。 */
