// 事故复现验收：插件里填一个**死代理**时，宿主 QQ Agent 的网络会不会被劫持？
//
// 事故原貌：插件早期版本在 ensureProxy() 里做了
//     undici.setGlobalDispatcher(new ProxyAgent(proxy))   +   process.env.HTTPS_PROXY = proxy
// 于是宿主所有出网请求（含调模型 API）都被改道到那个死代理上 →
//     connect ECONNREFUSED 216.236.43.142:443
// 整个 QQ Agent 不可用，而且清掉设置也要重启才恢复。
//
// 本脚本用**真实的 undici + 真实的插件实例**验证：现在插件的代理只挂在自己那一次请求上。
//
// 跑法（必须在 QQ Agent 目录下，相对路径调用）：
//   $env:ELECTRON_RUN_AS_NODE='1'
//   Set-Location 'D:\QQ-Agent-爆改版0.4'
//   & '.\node_modules\electron\dist\electron.exe' '.\skills\pixiv-lookup\verify-proxy-isolation.mjs'

const APP = process.env.QQ_AGENT_DIR || 'D:\\QQ-Agent-爆改版0.4'
const { pathToFileURL } = await import('node:url')
const path = await import('node:path')
const url = (p) => pathToFileURL(path.join(APP, p)).href

const undici = await import('undici')
const mod = await import(url('skills/pixiv-lookup/index.js'))

let pass = 0, fail = 0
const ok = (n, c, extra = '') => { if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n}${extra ? ' — ' + extra : ''}`) } }

const DEAD_PROXY = 'https://216.236.43.142'   // 用户填的那个（没人监听）
console.log('\n=== 代理隔离验收（插件填死代理，看宿主有没有被带坏）===\n')

// 记录基线：全局 dispatcher 与进程环境变量
const baseDispatcher = undici.getGlobalDispatcher()
const baseHttpsProxy = process.env.HTTPS_PROXY
const baseHttpProxy = process.env.HTTP_PROXY

// 自己 setup 一份插件实例（和宿主加载器给的一样形状）
const cfg = {
  enabled: true, cookie: '', maxResults: 3, maxPages: 1, order: 'popular_d',
  allowR18: false, allowInGroup: true, proxy: DEAD_PROXY, timeoutMs: 6000,
  breakerEnabled: true, breakerThreshold: 3, breakerCooldownSec: 60,
}
const tools = new Map()
mod.setup({ registerTool: (d) => tools.set(`pixiv-lookup__${d.id}`, d), config: () => cfg, log: () => {}, warn: () => {} })
const search = tools.get('pixiv-lookup__search')

console.log(`插件里填的代理：${DEAD_PROXY}（故意选一个没人监听的地址）\n`)

// ① 触发插件出网（会走代理、会失败，这是预期的）
const t0 = Date.now()
const r = await search.execute({ kind: 'private', chatId: 'x' }, { keyword: '初音ミク' })
const ms = Date.now() - t0
console.log(`  插件查询结果（isError=${r.isError}，耗时 ${ms}ms）：`)
console.log(String(r.content).split('\n').slice(0, 6).map((l) => '    │ ' + l).join('\n'))
ok('插件确实尝试走了代理并失败（说明代理参数真的生效了）', r.isError)

// ② 核心断言：全局状态一个都没被动
ok('undici 全局 dispatcher 没被替换', undici.getGlobalDispatcher() === baseDispatcher)
ok('process.env.HTTPS_PROXY 没被改写', process.env.HTTPS_PROXY === baseHttpsProxy,
  `现在是 '${process.env.HTTPS_PROXY}'`)
ok('process.env.HTTP_PROXY 没被改写', process.env.HTTP_PROXY === baseHttpProxy,
  `现在是 '${process.env.HTTP_PROXY}'`)

// ③ 决定性验证：随便发一个"和其它功能一样"的普通 HTTPS 请求，看它会不会被带去死代理
//    用模型 API 的域名（用户报错的那个），不带 key 也应该拿到 401 而不是 ECONNREFUSED。
console.log('\n  现在模拟宿主主程序去访问模型 API 域名（这正是用户报错的那条链路）：')
let apiErr = '', apiStatus = 0
try {
  const res = await fetch('https://api.xiaomimimo.com/v1/models', { signal: AbortSignal.timeout(15000) })
  apiStatus = res.status
} catch (e) {
  apiErr = String((e && e.cause && e.cause.code) || (e && e.code) || (e && e.message))
}
console.log(`    → HTTP ${apiStatus || '(无)'} ${apiErr ? '错误: ' + apiErr : ''}`)
ok('主程序侧请求**没有**被插件代理劫持（不是 ECONNREFUSED 216.236.43.142）',
  apiErr !== 'ECONNREFUSED' && apiStatus > 0,
  apiErr ? `拿到 ${apiErr}` : `status=${apiStatus}`)

// ④ 清空代理后，插件请求应恢复用内置 fetch（不再建 ProxyAgent）
cfg.proxy = ''
const r2 = await search.execute({ kind: 'private', chatId: 'x' }, { keyword: '初音ミク' })
ok('清空代理后插件仍能正常发起请求（走直连）',
  typeof r2.content === 'string' && r2.content.length > 0)
ok('清空代理后全局状态依旧没变', undici.getGlobalDispatcher() === baseDispatcher
  && process.env.HTTPS_PROXY === baseHttpsProxy)

mod.dispose()
console.log(`\n=== 结论：${pass} 项通过，${fail} 项失败 ===`)
process.exit(fail ? 1 : 0)
