// pixiv-lookup 本地自测（不需要外网）
//
// 为什么要有它：pixiv.net 在很多网络环境下根本连不上（大陆直连必超时），
// 没法靠"真查一次"来验收。于是这里用**按真实 Pixiv 响应形状**构造的假数据
// （fixtures/）注入到技能的出网层（__setTransport），把解析、过滤、
// 上限夹取、报错文案、Cookie 不回显这些逻辑全部跑一遍。
//
// 跑法有两种：
//
//   ① 直接被 Node 跑（推荐，路径自己算）：
//        $env:ELECTRON_RUN_AS_NODE='1'
//        & "...\electron.exe" test/run-tests.mjs
//
//   ② 被 selftest.ps1 跑：它为了绕开"用户目录里带单引号导致命令行参数被截断"
//      的问题，会 cd 进暂存目录后用 `electron -e "<内联源码>"` 调用，
//      内联源码 import 本文件并调用导出的 runTests(entryPath)。
//      所以本文件把逻辑包在 runTests() 里，而不是写成一堆顶层语句。
//
// 退出码 0 = 全部通过；1 = 有失败项。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures')

const fixture = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'))

/** 跑全部自测。entryPath = 技能入口 index.js 的绝对路径。返回失败项数量。 */
export async function runTests(entryPath) {
  const SKILL_DIR = path.dirname(entryPath)
  // Windows 上 import 绝对路径必须转成 file:// URL（否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME）
  const mod = await import(pathToFileURL(entryPath).href)

  let pass = 0
  const failures = []
  function ok(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  ✅ ${name}`) } else {
      failures.push(name + (extra ? ` — ${extra}` : ''))
      console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`)
    }
  }
  function eq(name, actual, expected) {
    ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }

  console.log(`\n=== pixiv-lookup 自测（Node ${process.version}）===\n`)

/* ── 1. 用假 transport 跑一遍搜索/详情/榜单 ─────────────────────────── */
const calls = []
const fakeFetch = async (url, opts = {}) => {
  calls.push({ url, headers: opts.headers || {} })
  const json = (obj, status = 200) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(obj),
  })
  if (url.includes('/ajax/search/artworks/')) return json(fixture('search-artworks.json'))
  if (/\/ajax\/illust\/(\d+)\/pages$/.test(url)) return json(fixture('illust-pages.json'))
  if (/\/ajax\/illust\/(\d+)$/.test(url)) return json(fixture('illust-detail.json'))
  if (url.includes('/ranking.php')) return json(fixture('ranking.json'))
  return json({ error: true, message: 'unknown url' }, 404)
}
mod.__setTransport(fakeFetch)

// 用 setup() 拿到注册的工具
const tools = new Map()
const apiConfig = {}
mod.setup({
  registerTool: (def) => { tools.set(`pixiv-lookup__${def.id}`, def) },
  config: () => apiConfig,
  log: () => {},
  warn: (...a) => console.log('    [warn]', ...a),
})

console.log('— 注册面 —')
eq('注册了 3 个工具', tools.size, 3)
ok('工具名带 pixiv-lookup__ 前缀', tools.has('pixiv-lookup__search') && tools.has('pixiv-lookup__artwork') && tools.has('pixiv-lookup__ranking'))
ok('search 的必填参数是 keyword', JSON.stringify(tools.get('pixiv-lookup__search').parameters.required) === '["keyword"]')

console.log('\n— available() 只判开关（同步）—')
apiConfig.enabled = false
const avOff = mod.available({})
ok('关掉时返回 ok:false 且说明去哪开', avOff.ok === false && /开关/.test(avOff.reason))
apiConfig.enabled = true
ok('打开时返回 ok:true', mod.available({}).ok === true)
// available 必须是同步的（上游在 isActive 里同步调用）
ok('available 是同步函数（不返回 Promise）', !(mod.available({}) instanceof Promise))

console.log('\n— 搜索：解析 + 条数上限 —')
apiConfig.cookie = ''
// fixture：12 条原始数据，其中 1 条 xRestrict=1，且它排在很后面（第 11 位）。
// 所以 limit=10 时，先取前 10 条（不含 R-18），过滤后仍是 10 条 —— 这才是正常体验。
const RAW_N = fixture('search-artworks.json').body.illustManga.data.length
const s1 = await tools.get('pixiv-lookup__search').execute({ kind: 'group' }, { keyword: '原神' })
const d1 = JSON.parse(s1.content)
ok('搜索成功且无 isError', !s1.isError)
eq('返回条数 = 10（R-18 那条排在第 11 位，不在本页内）', d1.结果.length, 10)
eq('命中总数透传', d1.命中总数, 4707)
ok('结果里有 id/标题/作者/链接', !!(d1.结果[0].id && d1.结果[0].标题 && d1.结果[0].作者 && /^https:\/\/www\.pixiv\.net\/artworks\/\d+$/.test(d1.结果[0].链接)))
ok('R-18 条目被过滤（allowR18=false）', d1.结果.every((x) => x.分级 !== 'R-18'))

// 上限口径：模型传大数不能顶掉管理员设的 maxResults（先夹到 10，再过滤 R-18，所以是 9 条）
const s2 = await tools.get('pixiv-lookup__search').execute({}, { keyword: '原神', limit: 999 })
const d2 = JSON.parse(s2.content)
ok('limit=999 被夹到 maxResults(10)，不是 50', d2.结果.length <= 10 && Number(d2.已过滤R18条数 ?? 0) + d2.结果.length <= 10,
  `实际 ${d2.结果.length} 条 + 过滤 ${d2.已过滤R18条数 ?? 0} 条`)
// 但模型可以主动调**小**
const s2b = await tools.get('pixiv-lookup__search').execute({}, { keyword: '原神', limit: 4 })
eq('limit=4 生效（可以调小）', JSON.parse(s2b.content).结果.length, 4)
apiConfig.maxResults = 3
const s3 = await tools.get('pixiv-lookup__search').execute({}, { keyword: '原神' })
eq('maxResults=3 生效', JSON.parse(s3.content).结果.length, 3)
apiConfig.maxResults = 10

// 构造"前 N 条里就混着 R-18"的场景，验证过滤后条数会变少、且有明确计数
apiConfig.maxResults = 12
const s6 = await tools.get('pixiv-lookup__search').execute({}, { keyword: '原神', limit: 12 })
const d6 = JSON.parse(s6.content)
eq('limit=12 时取到全部 ' + (RAW_N - 1) + ' 条非 R-18', d6.结果.length, RAW_N - 1)
ok('过滤掉的 R-18 条数有明确说明', Number(d6.已过滤R18条数) === 1)
apiConfig.maxResults = 10

console.log('\n— Cookie：不出现在任何返回/诊断里 —')
const SECRET = 'PHPSESSID=SuperSecretValue123; p_ab_id=6; p_ab_id_2=7'
apiConfig.cookie = SECRET
await tools.get('pixiv-lookup__search').execute({}, { keyword: '原神' })
const sentHeaders = calls[calls.length - 1].headers
ok('请求头里带上了完整 Cookie', String(sentHeaders.Cookie || '').includes('SuperSecretValue123'))
const dg = mod.diagnose({})
const dgText = JSON.stringify(dg)
ok('diagnose() 不回显 Cookie 原文', !dgText.includes('SuperSecretValue123'))
ok('diagnose() 报告含 PHPSESSID', /含 PHPSESSID/.test(dg.Cookie))
ok('diagnose() 报告开关/R18/代理等状态', dg.开关 === '开' && dg.R18 === '禁止' && typeof dg.代理 === 'string')

// Cookie 里塞一个换行，验证清洗 + 不会变成头注入
apiConfig.cookie = 'PHPSESSID=abc\r\nX-Evil: 1'
await tools.get('pixiv-lookup__search').execute({}, { keyword: 'x' })
const injHeaders = calls[calls.length - 1].headers
ok('Cookie 头里没有裸换行', !/[\r\n]/.test(String(injHeaders.Cookie || '')))
ok('Cookie 没有被注出新的请求头', injHeaders['X-Evil'] === undefined)
apiConfig.cookie = SECRET

console.log('\n— R-18 闸门 —')
const s4 = await tools.get('pixiv-lookup__search').execute({}, { keyword: 'x', r18: true })
ok('allowR18=false 时 r18=true 被拒绝', s4.isError === true && /allowR18/.test(s4.content))
apiConfig.allowR18 = true
apiConfig.maxResults = 12 // 让包含 R-18 的那条也进入本次结果
const s5 = await tools.get('pixiv-lookup__search').execute({}, { keyword: 'x', r18: true, limit: 12 })
ok('allowR18=true 时放行（且请求 mode=r18）', !s5.isError && calls[calls.length - 1].url.includes('mode=r18'))
ok('allowR18=true 时结果不再过滤，R-18 条目带分级标记', JSON.parse(s5.content).结果.some((x) => x.分级 === 'R-18'))
apiConfig.allowR18 = false
apiConfig.maxResults = 10

console.log('\n— 群聊开关 —')
apiConfig.allowInGroup = false
const g = await tools.get('pixiv-lookup__search').execute({ kind: 'group' }, { keyword: 'x' })
ok('allowInGroup=false 时群里被拒', g.isError === true && /私聊/.test(g.content))
const g2 = await tools.get('pixiv-lookup__search').execute({ kind: 'private' }, { keyword: 'x' })
ok('私聊仍然可用', !g2.isError)
apiConfig.allowInGroup = true

console.log('\n— 作品详情：id 提取 + 多图 + 字段 —')
const a1 = await tools.get('pixiv-lookup__artwork').execute({}, { ids: 'https://www.pixiv.net/artworks/100412238' })
ok('支持从链接里抠 id', !a1.isError)
const ad = JSON.parse(a1.content).作品[0]
eq('标题解析正确', ad.标题, 'ウタゲ＆シデロカ')
eq('作者解析正确', ad.作者, '360')
eq('收藏数解析正确', ad.收藏数, 4011)
eq('页数解析正确', ad.页数, 1)
ok('标签解析正确', ad.标签.includes('明日方舟'))
ok('简介被转成纯文本（无 HTML 标签）', !/[<>]/.test(ad.简介) || !/<br|<a href/.test(ad.简介))
ok('给出了原图地址', !!(ad.图 && /img-original/.test(ad.图.原图)))
ok('提示了 pximg 防盗链', /Referer/.test(ad.图.说明))

// 用 9 位（真实长度的）id：单数字不是合法 Pixiv 作品 id，会被正则挡掉 —— 那测不到"最多 5 个"
const sevenIds = ['111111111', '222222222', '333333333', '444444444', '555555555', '666666666', '777777777'].join(',')
const a2 = await tools.get('pixiv-lookup__artwork').execute({}, { ids: sevenIds })
ok('一次最多查 5 个（多余的丢掉）', !a2.isError && JSON.parse(a2.content).查询条数 <= 5,
  a2.isError ? a2.content.slice(0, 120) : `实际 ${JSON.parse(a2.content).查询条数}`)
const a2b = await tools.get('pixiv-lookup__artwork').execute({}, { ids: '1,2,3' })
ok('太短的"id"不算 id（不会去请求 /ajax/illust/1）', a2b.isError === true)
const a3 = await tools.get('pixiv-lookup__artwork').execute({}, { ids: '不是id' })
ok('没有合法 id 时给出中文提示', a3.isError === true && /id/.test(a3.content))

console.log('\n— 榜单 —')
const r1 = await tools.get('pixiv-lookup__ranking').execute({}, {})
const rd = JSON.parse(r1.content)
ok('榜单取到条目', !r1.isError && rd.结果.length > 0)
ok('榜单条目含名次/标题/作者/链接', rd.结果[0].名次 === 1 && !!rd.结果[0].标题 && !!rd.结果[0].链接)
ok('榜单里的 R-18 条目被过滤', rd.结果.every((x) => x.分级 !== 'R-18'))
const r2 = await tools.get('pixiv-lookup__ranking').execute({}, { mode: 'weekly_r18' })
ok('R-18 榜单在 allowR18=false 时被拒', r2.isError === true && /allowR18/.test(r2.content))

console.log('\n— 出网错误分类（真实用户最可能遇到的那几种）—')
/** 让出网固定抛"连接超时"，并把真实发出的请求数清零。 */
let netCalls = 0
function transportAlwaysTimeout() {
  netCalls = 0
  mod.__setTransport(async () => {
    netCalls++
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })
  })
}
// ⚠️ 每个用例前都要重置断路器：这几类失败（超时/DNS/连接被拒/403/风控页/业务报错）
//    现在都会被断路器计数，不重置的话跑到第 3 个用例就被拦下，后面测的就不是错误文案了。
async function transportThrows(err) {
  mod.__resetBreaker()
  mod.__setTransport(async () => { throw err })
  return tools.get('pixiv-lookup__search').execute({}, { keyword: 'x' })
}
/** 固定返回某个 HTTP 响应；**不动断路器计数**（用于需要累加失败的场景） */
function transportReturns(resp) {
  mod.__setTransport(async () => resp)
}
/** 固定返回某个响应，并先把断路器清零（用于互相独立的用例） */
function transportReturnsFresh(resp) {
  mod.__resetBreaker()
  transportReturns(resp)
}
const e1 = await transportThrows(Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }))
ok('超时 → 提示代理', e1.isError && /代理/.test(e1.content) && /proxy/.test(e1.content))
const e2 = await transportThrows(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }))
ok('DNS 失败 → 中文说明', e2.isError && /DNS/.test(e2.content))
const e3 = await transportThrows(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
ok('连接被拒 → 提示检查代理端口', e3.isError && /代理/.test(e3.content))

transportReturnsFresh({ status: 403, ok: false, headers: { get: () => 'text/html' }, text: async () => '<html>blocked</html>' })
const e403 = await tools.get('pixiv-lookup__search').execute({}, { keyword: 'x' })
ok('403 → 提示填 Cookie', e403.isError && /403/.test(e403.content) && /Cookie/.test(e403.content))

transportReturnsFresh({ status: 200, ok: true, headers: { get: () => 'text/html' }, text: async () => '<!DOCTYPE html><html>login</html>' })
const ehtml = await tools.get('pixiv-lookup__search').execute({}, { keyword: 'x' })
ok('返回 HTML（风控页）→ 明确说明', ehtml.isError && /网页/.test(ehtml.content))

transportReturnsFresh({ status: 200, ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ error: true, message: 'sensitive' }) })
const eapi = await tools.get('pixiv-lookup__search').execute({}, { keyword: 'x' })
ok('Pixiv 业务报错 error=true → 透传原因', eapi.isError && /sensitive/.test(eapi.content))

// 反向确认：上面这几类**都算**"上游不行"，会被断路器计数（404 才算用户错误）
mod.__resetBreaker()
transportAlwaysTimeout()
const trip1 = await tools.get('pixiv-lookup__search').execute({}, { keyword: 'x' })
transportReturns({ status: 403, ok: false, headers: { get: () => 'text/html' }, text: async () => '<html>b</html>' })
const trip2 = await tools.get('pixiv-lookup__search').execute({}, { keyword: 'x' })
transportReturns({ status: 500, ok: false, headers: { get: () => 'application/json' }, text: async () => '{}' })
const trip3 = await tools.get('pixiv-lookup__search').execute({}, { keyword: 'x' })
ok('超时 + 403 + 5xx 混合失败也会累加到阈值并终止',
  /强制停止/.test(trip3.content), trip3.content.split('\n').slice(0, 2).join(' '))
mod.__resetBreaker()

console.log('\n— 代理隔离（真实事故回归测试）—')
// 事故经过：插件早期版本在 ensureProxy 里做了两件**全局**的事 ——
//   undici.setGlobalDispatcher(new ProxyAgent(proxy))  +  process.env.HTTPS_PROXY = proxy
// 于是宿主 QQ Agent 的**所有**出网请求（包括调模型 API）都被改道到那个代理上。
// 用户填了个死代理，整个机器人直接不可用：connect ECONNREFUSED <代理IP>:443，
// 而且因为改的是全局状态，把插件里的代理清掉也要重启才恢复。
//
// 这几项断言就是钉住"绝不再犯"：代理必须只挂在本次请求上。
mod.__resetBreaker()

const envBefore = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY }
const undici = await import('undici')
const gdBefore = typeof undici.getGlobalDispatcher === 'function' ? undici.getGlobalDispatcher() : null

// 注入一个假的 ProxyAgent 工厂，并记录"每次请求是否带了 dispatcher"
const seen = []
const FAKE_AGENT = { __fake: 'proxy-agent' }
mod.__setNetAdapter({
  fetch: async (url, opts) => {
    seen.push({ url, dispatcher: opts && opts.dispatcher, httpsProxyEnv: process.env.HTTPS_PROXY })
    return { status: 200, ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(fixture('search-artworks.json')) }
  },
  proxyAgent: (proxyUrl) => { seen.push({ madeAgentFor: proxyUrl }); return FAKE_AGENT },
})

apiConfig.proxy = 'http://127.0.0.1:7890'
const searchTool = tools.get('pixiv-lookup__search')
const withProxy = await searchTool.execute({}, { keyword: '原神' })
ok('填了代理后：查询仍能成功', !withProxy.isError)
const reqWithProxy = seen.find((x) => x.url && x.url.startsWith('http'))
ok('请求确实带上了 dispatcher（代理只挂这一次请求）', reqWithProxy && reqWithProxy.dispatcher === FAKE_AGENT)
ok('ProxyAgent 是按代理地址创建的', seen.some((x) => x.madeAgentFor === 'http://127.0.0.1:7890'))
ok('**没有**偷偷写 process.env.HTTPS_PROXY（那会波及主程序）',
  !reqWithProxy.httpsProxyEnv && process.env.HTTPS_PROXY === envBefore.HTTPS_PROXY,
  `HTTPS_PROXY=${process.env.HTTPS_PROXY}`)
ok('**没有**改 process.env.HTTP_PROXY',
  process.env.HTTP_PROXY === envBefore.HTTP_PROXY, `HTTP_PROXY=${process.env.HTTP_PROXY}`)
const gdAfter = typeof undici.getGlobalDispatcher === 'function' ? undici.getGlobalDispatcher() : null
ok('**没有**调用 setGlobalDispatcher（全局 dispatcher 前后同一个）',
  gdBefore === gdAfter)

// 反向：不填代理时，一个 dispatcher 都不该出现（不能"残留"上一次的代理）
// ⚠️ 注意这里同时换掉 netFetch：上面对照组装的假 transport 是"永远超时"的，
//    不换的话请求根本到不了这里，seen 会是空的，断言就成了假失败。
seen.length = 0
mod.__setNetAdapter(null)
mod.__setTransport(async (url, opts) => {
  seen.push({ url, dispatcher: opts && opts.dispatcher, httpsProxyEnv: process.env.HTTPS_PROXY })
  return { status: 200, ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(fixture('search-artworks.json')) }
})
apiConfig.proxy = ''
const noProxy = await searchTool.execute({}, { keyword: '原神' })
ok('清空代理后：查询正常', !noProxy.isError)
const reqNoProxy = seen.find((x) => x.url && x.url.startsWith('http'))
ok('清空代理后：请求不带任何 dispatcher', !!reqNoProxy && !reqNoProxy.dispatcher,
  reqNoProxy ? `dispatcher=${JSON.stringify(reqNoProxy.dispatcher)}` : '没记录到请求')
ok('清空代理后也不写环境变量', process.env.HTTPS_PROXY === envBefore.HTTPS_PROXY)

// 代理建不出来（比如地址写错、或不支持的类型）→ 明确中文报错，且**不**计入断路器
// 用"工厂抛错"来模拟：dispatcherFor 里 catch 到就走 failed 分支。
seen.length = 0
mod.__setNetAdapter({
  fetch: async () => { throw new Error('不该走到这里：建不出 dispatcher 时不该发请求') },
  proxyAgent: () => { throw new Error('Invalid proxy URL') },
})
apiConfig.proxy = 'http://127.0.0.1:7890'
const badProxy = await searchTool.execute({}, { keyword: '原神' })
ok('代理工厂不可用时：给出中文说明而不是崩掉',
  badProxy.isError && badProxy.content.includes('代理地址') && badProxy.content.includes('不会影响 QQ Agent 主程序'),
  badProxy.content.split('\n').slice(0, 2).join(' / '))
ok('代理配置类错误不计入断路器（属配置问题，不该封插件）',
  !/强制停止/.test(badProxy.content))
mod.__setNetAdapter(null)
mod.__setTransport(null)
apiConfig.proxy = ''
mod.__resetBreaker()

console.log('\n— 代理地址填 auto：自动探测本机代理（给"端口每次启动都变"的人）—')
// 为什么值得测：Clash/mihomo 这类客户端常把混合端口设成每次随机，
// 用户写死一个端口过两天就失效，表现是"插件突然连不上" —— 很难联想到端口变了。
mod.__resetBreaker()
let probed = 0
mod.__setProxyProbe(async () => { probed++; return { proxy: 'http://127.0.0.1:54321', how: '测试注入' } })
const autoSeen = []
mod.__setNetAdapter({
  fetch: async (url, opts) => {
    autoSeen.push({ url, dispatcher: opts && opts.dispatcher })
    return { status: 200, ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(fixture('search-artworks.json')) }
  },
  proxyAgent: (proxyUrl) => { autoSeen.push({ madeAgentFor: proxyUrl }); return FAKE_AGENT },
})
apiConfig.proxy = 'auto'
const autoRes = await searchTool.execute({}, { keyword: '原神' })
ok('auto 模式下查询能成功', !autoRes.isError)
ok('auto 探测到的代理被真的用来建 ProxyAgent', autoSeen.some((x) => x.madeAgentFor === 'http://127.0.0.1:54321'),
  JSON.stringify(autoSeen.map((x) => x.madeAgentFor || 'request')))
ok('auto 模式下请求带上了 dispatcher', autoSeen.some((x) => x.url && x.dispatcher === FAKE_AGENT))
const probedAfterFirst = probed
await searchTool.execute({}, { keyword: '原神' })
eq('探测结果被缓存（第二次请求不再重复探测）', probed, probedAfterFirst)
ok('diagnose() 会说明当前是 auto 模式', /auto/.test(String(mod.diagnose({}).代理)))

// 注册表解析（纯函数，用真实 reg query 输出做样例）——
// 这条是为了防"照着早就关掉的系统代理去连"：ProxyEnable=0 时必须拒绝那个残留值。
const REG_ON = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  '    ProxyEnable    REG_DWORD    0x1',
  '    ProxyServer    REG_SZ    127.0.0.1:54626',
  '',
].join('\r\n')
const REG_OFF = REG_ON.replace('0x1', '0x0')
ok('注册表里系统代理开着 → 解析出 http://127.0.0.1:54626',
  (mod.proxyFromRegistryText(REG_ON) || {}).proxy === 'http://127.0.0.1:54626',
  JSON.stringify(mod.proxyFromRegistryText(REG_ON)))
ok('ProxyEnable=0（系统代理关着）→ 不用那个残留值', mod.proxyFromRegistryText(REG_OFF) === null)
ok('按协议分组写法 http=…;https=… 也能解析',
  (mod.proxyFromRegistryText(REG_ON.replace('127.0.0.1:54626', 'http=127.0.0.1:7890;https=127.0.0.1:7890')) || {}).proxy === 'http://127.0.0.1:7890')
ok('注册表输出里没有 ProxyServer → 返回 null（不瞎猜）',
  mod.proxyFromRegistryText('    ProxyEnable    REG_DWORD    0x1') === null)

// 探测不到时：退回直连（不能因为探测失败就整插件不可用）
mod.__setProxyProbe(async () => ({ proxy: '', how: '' }))
const directSeen = []
mod.__setNetAdapter(null)
mod.__setTransport(async (url, opts) => {
  directSeen.push({ url, dispatcher: opts && opts.dispatcher })
  return { status: 200, ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(fixture('search-artworks.json')) }
})
const autoFallback = await searchTool.execute({}, { keyword: '原神' })
ok('auto 探测不到代理时：退化成直连，查询照样工作', !autoFallback.isError)
ok('退化时请求不带 dispatcher', !!directSeen.find((x) => x.url) && !directSeen.find((x) => x.url).dispatcher)
mod.__setProxyProbe(null)
mod.__setTransport(null)
apiConfig.proxy = ''
mod.__resetBreaker()

console.log('\n— 连续失败强制终止（断路器，默认开）—')
const search = tools.get('pixiv-lookup__search')
const artwork = tools.get('pixiv-lookup__artwork')
const ranking = tools.get('pixiv-lookup__ranking')

mod.__resetBreaker()
transportAlwaysTimeout()
apiConfig.breakerEnabled = true; apiConfig.breakerThreshold = 3; apiConfig.breakerCooldownSec = 60
const f1 = await search.execute({}, { keyword: 'k1' })
ok('第 1 次失败：照常走网络、普通报错（还没到阈值）',
  f1.isError && netCalls === 1 && !/已完成终止|强制停止/.test(f1.content))
const f2 = await search.execute({}, { keyword: 'k2' })
ok('第 2 次失败：仍然只是普通报错（阈值 3 未到）',
  f2.isError && netCalls === 2 && !/已完成终止|强制停止/.test(f2.content))

const f3 = await search.execute({}, { keyword: 'k3' })
ok('第 3 次失败：达到阈值，返回里明确宣告"已强制停止"',
  f3.isError && netCalls === 3 && /强制停止/.test(f3.content))
ok('触发时明确要求模型别再调用工具、直接回话',
  /不要再调用任何 pixiv 工具/.test(f3.content) && /用一句自然的中文/.test(f3.content))
ok('触发时提醒不要编造作品名/链接', /不要编造作品名或链接/.test(f3.content))

// 这是本功能的核心：冷却期内**一个请求都不发**
const before4 = netCalls
const f4 = await search.execute({}, { keyword: 'k4-换个词再试' })
ok('第 4 次：冷却期内被拦下，完全没有发出网络请求', netCalls === before4)
ok('被拦下时说明「未执行」和还剩多少秒',
  f4.isError && /未执行/.test(f4.content) && /已强制停止本插件的所有查询/.test(f4.content) && /\d+ 秒内不再尝试/.test(f4.content))
ok('被拦下时同样带"别再调用工具、直接回话"的指令',
  /不要再调用任何 pixiv 工具/.test(f4.content))

const before5 = netCalls
const f5 = await artwork.execute({}, { ids: '100412238' })
ok('断路器是**跨工具**的：artwork 也被一起终止', f5.isError && netCalls === before5 && /未执行/.test(f5.content))
const f6 = await ranking.execute({}, {})
ok('断路器是**跨工具**的：ranking 也被一起终止', f6.isError && netCalls === before5 && /未执行/.test(f6.content))

// 验证"冷却结束会自动半开：放行一次试探，成功就恢复正常"。
// 直接 sleep 60 秒太慢，所以把冷却设成最小值 5 秒，然后真等 5.2 秒 —— 值得，
// 因为"半开"是断路器最容易写错、也最容易变成"永久封死"的地方。
mod.__resetBreaker()
transportAlwaysTimeout()
apiConfig.breakerCooldownSec = 5
for (let i = 0; i < 3; i++) await search.execute({}, { keyword: `cd${i}` })
const callsAtTrip = netCalls
const blockedNow = await search.execute({}, { keyword: 'still-blocked' })
ok('冷却期内仍然拦截（没有发请求）', netCalls === callsAtTrip && /未执行/.test(blockedNow.content))
await new Promise((r) => setTimeout(r, 5200))
mod.__setTransport(async () => {
  netCalls++
  return { status: 200, ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(fixture('search-artworks.json')) }
})
const halfOpenOk = await search.execute({}, { keyword: '原神' })
ok('冷却结束后自动放行一次试探，且试成功就恢复正常',
  !halfOpenOk.isError && netCalls === callsAtTrip + 1 && JSON.parse(halfOpenOk.content).结果.length > 0)
apiConfig.breakerCooldownSec = 60
mod.__resetBreaker()
transportAlwaysTimeout()
await search.execute({}, { keyword: 'a' })
await search.execute({}, { keyword: 'b' })
mod.__setTransport(async (url) => {
  netCalls++
  return { status: 200, ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(fixture('search-artworks.json')) }
})
const good = await search.execute({}, { keyword: '原神' })
ok('中途成功 → 正常返回结果', !good.isError && JSON.parse(good.content).结果.length > 0)
mod.__resetBreaker()
transportAlwaysTimeout()
const c1 = await search.execute({}, { keyword: 'c1' })
const c2 = await search.execute({}, { keyword: 'c2' })
// 阈值是 3：如果成功那次没有清零，这两次失败就会触发终止。没触发 = 计数确实清了。
ok('成功一次后计数已清零（再失败 2 次也没触发终止）',
  c1.isError && c2.isError && c1.content.includes('超时') && c2.content.includes('超时')
  && !/强制停止/.test(c2.content), `第2次内容：${String(c2.content).split('\n')[1] || ''}`)
mod.__resetBreaker()

console.log('\n— 断路器不该被这些"用户错误"引开 —')
mod.__resetBreaker()
transportAlwaysTimeout()
// 404 = 作品不存在：换个 id 就能成，不能算"上游挂了"
mod.__setTransport(async () => ({ status: 404, ok: false, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ error: true, message: 'not found' }) }))
for (let i = 0; i < 5; i++) await artwork.execute({}, { ids: `${100000000 + i}` })
const nf = await search.execute({}, { keyword: '还得能用' })
ok('连续 5 次 404 不会触发断路器（404 属于请求本身的问题）',
  nf.isError && !/强制停止|未执行/.test(nf.content))
mod.__resetBreaker()

transportAlwaysTimeout()
const rz = await search.execute({}, { keyword: 'r18test', r18: true })   // allowR18=false → 被闸门拒
ok('R-18 闸门拒绝不计入失败次数（不联网、不触发断路器）',
  rz.isError && /allowR18/.test(rz.content) && !/强制停止/.test(rz.content) && netCalls === 0)
const empty = await search.execute({}, { keyword: '   ' })
ok('空关键词不计入失败次数', empty.isError && /不能为空/.test(empty.content))
mod.__resetBreaker()

console.log('\n— 断路器开关可以关掉 —')
mod.__resetBreaker()
transportAlwaysTimeout()
apiConfig.breakerEnabled = false
for (let i = 0; i < 5; i++) await search.execute({}, { keyword: `off${i}` })
ok('breakerEnabled=false 时永远不终止（每次都真的去请求了）', netCalls === 5)
apiConfig.breakerEnabled = true
mod.__resetBreaker()

console.log('\n— diagnose 里能看到断路器状态 —')
mod.__resetBreaker()
transportAlwaysTimeout()
await search.execute({}, { keyword: 'd1' })
const dg2 = mod.diagnose({})
ok('诊断里有断路器字段', typeof dg2.断路器 === 'string')
ok('诊断里有图片桥状态与宿主开关提示',
  typeof dg2.图片桥 === 'string' && /allowPrivateImageHosts/.test(String(dg2.图片桥提示)))
ok('诊断显示连续失败计数', /连续失败 1\/3/.test(dg2.断路器))
ok('诊断不泄漏 Cookie', !JSON.stringify(dg2).includes('SuperSecretValue123'))
mod.__resetBreaker()

console.log('\n— 提示词片段跟着开关闭 —')
apiConfig.enabled = false
eq('关掉时 promptSections 为空', mod.promptSections({}).length, 0)
apiConfig.enabled = true
const ps = mod.promptSections({})
ok('打开时有片段且提到工具名', ps.length === 1 && ps[0].content.includes('pixiv-lookup__search'))
ok('priority ≤ 99（不越权覆盖核心规则）', ps[0].priority <= 99)

console.log('\n— 图片桥：缩略图→大图换算 + 只服务本进程生成的直链 —')
const bridgeMod = await import(pathToFileURL(path.join(SKILL_DIR, 'image-bridge.js')).href)
const THUMB = 'https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/09/24/05/41/55/150039929_p0_square1200.jpg'
eq('缩略图换算成 master1200 大图（长边 1200，不是 250 方图）',
  bridgeMod.masterFromThumb(THUMB),
  'https://i.pximg.net/img-master/img/2026/09/24/05/41/55/150039929_p0_master1200.jpg')
eq('已经是 master1200 的地址不再改动',
  bridgeMod.masterFromThumb('https://i.pximg.net/img-master/img/a/b/1_p0_master1200.jpg'),
  'https://i.pximg.net/img-master/img/a/b/1_p0_master1200.jpg')
ok('榜单那种 /c/240x480/ 前缀也能剥掉',
  bridgeMod.masterFromThumb('https://i.pximg.net/c/240x480/img-master/img/a/b/1_p0_master1200.jpg')
  === 'https://i.pximg.net/img-master/img/a/b/1_p0_master1200.jpg')
ok('只认 pximg 域名', bridgeMod.isPixivImageUrl('https://i.pximg.net/a.jpg') && !bridgeMod.isPixivImageUrl('https://evil.com/a.jpg'))
ok('把 pximg 当子串的伪装域名被拒',
  !bridgeMod.isPixivImageUrl('https://i.pximg.net.evil.com/a.jpg') && !bridgeMod.isPixivImageUrl('https://evil.com/i.pximg.net/a.jpg'))
ok('非 http(s) 一律拒（file:// 也拒）', !bridgeMod.isPixivImageUrl('file:///D:/a.jpg'))

let bridgeFetches = 0
const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)])
const testBridge = bridgeMod.createImageBridge({
  fetchImage: async () => { bridgeFetches++; return { buffer: FAKE_JPEG, contentType: 'image/jpeg' } },
  ttlSec: 60,
})
const tport = await testBridge.start({ preferredPort: 0 })
ok('图片桥能在本机随机端口起来', tport > 0, `port=${tport}`)
const tlink = testBridge.link(THUMB)
ok('直链形如 http://127.0.0.1:端口/i/<随机id>',
  /^http:\/\/127\.0\.0\.1:\d+\/i\/[A-Za-z0-9_-]{16,}$/.test(tlink), tlink)
const br1 = await fetch(tlink)
eq('直链能取回图片（HTTP 200）', br1.status, 200)
eq('Content-Type 原样透传', br1.headers.get('content-type'), 'image/jpeg')
eq('取回字节数一致', Buffer.from(await br1.arrayBuffer()).length, FAKE_JPEG.length)
await fetch(tlink)
eq('第二次请求命中缓存（不重复去 Pixiv 取图）', bridgeFetches, 1)
const badLink = await fetch(`http://127.0.0.1:${tport}/i/AAAAAAAAAAAAAAAAAAAAAAAA`)
eq('编造/猜出来的 id 一律 404（桥不是开放代理）', badLink.status, 404)
eq('非 pximg 地址根本不生成直链', testBridge.link('https://evil.com/a.jpg'), '')
ok('停用后不再生成直链', testBridge.stop() === true && testBridge.link(THUMB) === '')
ok('stopping 之后端口不再监听', testBridge.stats().running === false)

console.log('\n— 端到端：工具给出的「发图直链」，宿主真的能下到图片字节 —')
mod.__resetBreaker()
const IMG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 3)])
const pximgHits = []
const fakeWithImage = async (url, opts = {}) => {
  calls.push({ url, headers: opts.headers || {} })
  const asJson = (obj, status = 200) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => 'application/json' },
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => JSON.stringify(obj),
  })
  if (/pximg\.net/.test(url)) {
    pximgHits.push({ url, headers: opts.headers || {} })
    return {
      status: 200,
      ok: true,
      headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
      arrayBuffer: async () => IMG_BYTES.buffer.slice(IMG_BYTES.byteOffset, IMG_BYTES.byteOffset + IMG_BYTES.byteLength),
      text: async () => '',
    }
  }
  if (url.includes('/ajax/search/artworks/')) return asJson(fixture('search-artworks.json'))
  if (/\/ajax\/illust\/(\d+)$/.test(url)) return asJson(fixture('illust-detail.json'))
  if (url.includes('/ranking.php')) return asJson(fixture('ranking.json'))
  return asJson({ error: true, message: 'unknown url' }, 404)
}
mod.__setTransport(fakeWithImage)
apiConfig.cookie = ''
const sr = await tools.get('pixiv-lookup__search').execute({ kind: 'private' }, { keyword: '原神', limit: 3 })
const sd = JSON.parse(sr.content)
ok('搜索结果里带上了「发图直链」', String(sd.结果[0].发图直链 || '').startsWith('http://127.0.0.1:'),
  JSON.stringify(sd.结果[0].发图直链))
const hostDl = await fetch(sd.结果[0].发图直链)
eq('宿主视角：下这条直链拿到的是 HTTP 200', hostDl.status, 200)
eq('宿主拿到的字节数正确（就是插件取回来的那张图）',
  Buffer.from(await hostDl.arrayBuffer()).length, IMG_BYTES.length)
ok('插件去 Pixiv 取图时带了防盗链必需的 Referer',
  (pximgHits[0] && pximgHits[0].headers.Referer) === 'https://www.pixiv.net/', JSON.stringify(pximgHits[0] && pximgHits[0].headers))
ok('取的是换算后的 master1200 大图，不是 250×250 缩略图',
  /_p0_master1200\.jpg$/.test((pximgHits[0] && pximgHits[0].url) || ''), (pximgHits[0] && pximgHits[0].url) || '')
ok('返回里保留人看的作品页链接', /^https:\/\/www\.pixiv\.net\/artworks\/\d+$/.test(sd.结果[0].链接))
ok('用法提示明确告诉模型别发 pximg 裸链', /不要用 i\.pximg\.net|不能.*直接发给 send_image|会 403/.test(String(sd.用法提示)))

const ar = await tools.get('pixiv-lookup__artwork').execute({ kind: 'private' }, { ids: '100412238' })
const ad2 = JSON.parse(ar.content).作品[0]
ok('作品详情里有「图.发图直链」', String(ad2.图 && ad2.图.发图直链 || '').startsWith('http://127.0.0.1:'))
ok('作品详情里有「图.原图直链」', String(ad2.图 && ad2.图.原图直链 || '').startsWith('http://127.0.0.1:'))
ok('图.说明改成"别拿裸链喂 send_image"', /防盗链/.test(String(ad2.图 && ad2.图.说明)))
const adl = await fetch(ad2.图.发图直链)
eq('作品详情的直链同样能下到图', adl.status, 200)

const rr = await tools.get('pixiv-lookup__ranking').execute({ kind: 'private' }, { limit: 3 })
const rd2 = JSON.parse(rr.content)
ok('榜单条目也带「发图直链」', String(rd2.结果[0].发图直链 || '').startsWith('http://127.0.0.1:'))

// 关掉图片桥时不生成直链，但查询本身照常工作（可降级）
apiConfig.imageBridge = false
const sr2 = await tools.get('pixiv-lookup__search').execute({ kind: 'private' }, { keyword: '原神', limit: 2 })
const sd2 = JSON.parse(sr2.content)
ok('关掉图片桥后不再给直链，查询仍然正常返回', !sd2.结果[0].发图直链 && sd2.结果.length === 2)
apiConfig.imageBridge = true
mod.__setTransport(null)
mod.__resetBreaker()
// 关掉插件自己的图片桥：不然这个测试进程会一直留着一个监听端口
mod.dispose()

console.log('\n— 清单文件与代码一致性 —')
const man = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'skill.json'), 'utf8'))
eq('清单 id 与代码 SKILL_ID 一致', man.id, 'pixiv-lookup')
ok('id 合法（^[a-z0-9][a-z0-9._-]*$）', /^[a-z0-9][a-z0-9._-]*$/.test(man.id))
ok('category 合法', ['model', 'message', 'knowledge', 'media', 'utility'].includes(man.category))
ok('entry 指向存在的文件', man.entry === 'index.js' && fs.existsSync(path.join(SKILL_DIR, man.entry)))
const declared = (man.tools || []).map((t) => `pixiv-lookup__${t.id}`).sort()
eq('清单 tools[] 与代码注册的工具一一对应', JSON.stringify(declared), JSON.stringify([...tools.keys()].sort()))
ok('Cookie 在清单里标了 secret:true（界面按密码框渲染 + 接口脱敏）', man.configSchema.cookie.secret === true)
ok('清单 settings 的键都在 configSchema 里声明', Object.keys(man.settings).every((k) => k in man.configSchema))
ok('清单 configSchema 每个字段都有 label', Object.values(man.configSchema).every((f) => typeof f.label === 'string' && f.label))
// ── 断路器默认值（用户要求：默认打开）──
ok('清单里断路器默认打开（settings.breakerEnabled=true）', man.settings.breakerEnabled === true)
eq('断路器默认阈值 3', man.settings.breakerThreshold, 3)
eq('断路器默认冷却 60 秒', man.settings.breakerCooldownSec, 60)
ok('断路器三个字段都能在设置界面配',
  ['breakerEnabled', 'breakerThreshold', 'breakerCooldownSec'].every((k) => k in man.configSchema))
ok('阈值/冷却有下限（防止被填成 0 变永久封死）',
  man.configSchema.breakerThreshold.min >= 1 && man.configSchema.breakerCooldownSec.min >= 5)
ok('代码里的默认值同样是"断路器默认开"（清单与代码口径一致）', mod.__defaults().breakerEnabled === true)
eq('代码默认阈值与清单一致', mod.__defaults().breakerThreshold, man.settings.breakerThreshold)
eq('代码默认冷却与清单一致', mod.__defaults().breakerCooldownSec, man.settings.breakerCooldownSec)
ok('promptSections 里教了模型"被终止时别重试、直接回话"',
  /不要再调用任何 pixiv 工具/.test(ps[0].content) || /强制停止/.test(ps[0].content))
// ── 图片桥（本次修复的核心：从"只能发链接"到"真的能发图"）──
ok('promptSections 里教了模型"发图就用发图直链"', /发图直链/.test(ps[0].content))
ok('promptSections 里写了被内网保护挡住时该怎么办', /allowPrivateImageHosts|允许下载内网/.test(ps[0].content))
ok('工具描述里明确说了别喂 pximg 裸链',
  /防盗链/.test(tools.get('pixiv-lookup__search').description + tools.get('pixiv-lookup__artwork').description))

// ── 图片桥的清单声明（这条修复的全部可配置项都要能在界面上改）──
ok('清单里声明了图片桥的四个设置',
  ['imageBridge', 'bridgePort', 'bridgeTtlSec', 'bridgeMaxMB'].every((k) => k in man.settings && k in man.configSchema))
eq('代码默认「图片桥默认开」与清单一致', mod.__defaults().imageBridge, man.settings.imageBridge)
ok('图片桥默认端口与清单一致', mod.__defaults().bridgePort === man.settings.bridgePort)
ok('图片直链有效期有下限（不能被填成 0 变成"永不过期"）', man.configSchema.bridgeTtlSec.min >= 30)
ok('图片桥字段都有中文 label 与说明',
  ['imageBridge', 'bridgePort', 'bridgeTtlSec', 'bridgeMaxMB']
    .every((k) => man.configSchema[k].label && man.configSchema[k].description))

  console.log(`\n=== 结果：${pass} 项通过，${failures.length} 项失败 ===`)
  if (failures.length) {
    console.log('失败项：')
    for (const f of failures) console.log('  · ' + f)
  }
  // 一并导出计数：selftest.ps1 会把它写进 result.json 作为**可靠的成败判据**
  // （在那个环境里 $LASTEXITCODE 可能拿不到，光看退出码会把失败当成功）
  return { passed: pass, failed: failures.length, failures: [...failures] }
}

// ── 直接跑本文件时自执行（被 selftest.ps1 import 时只导出 runTests）──
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isDirectRun) {
  const entry = path.resolve(HERE, '..', 'index.js')
  const r = await runTests(entry)
  process.exit(r.failed ? 1 : 0)
}

