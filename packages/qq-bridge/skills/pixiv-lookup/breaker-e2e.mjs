// 断路器端到端验收（不联网）
//
// 为什么单独有这个脚本：test/run-tests.mjs 里那 17 项是"分点断言"，
// 读起来碎。这个脚本走一遍**完整时间线**，把每一步返回给模型的原文也打出来 ——
// 用来肉眼确认"机器人到底会看到什么"，以及确认它在冷却期是**真的不发请求**。
//
// ⚠️ 一个必须知道的坑（第一版就栽在这里）：
//    QQ Agent 的 plugin-loader 是用 `import(entryUrl + '?t=' + Date.now())` 加载入口的，
//    那个 ?t= 让 Node 把它当成**另一个模块实例**。所以
//      · 直接 import('index.js') 拿到的是"第二份实例"
//      · __setTransport 打在第二份上，而工具跑在加载器那份上
//    结果就是"假 transport 没生效，脚本真的去连了 20 秒网络"。
//    因此这里**不走宿主加载器**，而是自己 import 一份、自己 setup，
//    这样 transport 注入一定生效。（宿主的清单校验由 verify-in-agent.mjs 负责。）
//
// 跑法（QQ Agent 目录下、用相对路径，避开用户目录里的单引号）：
//   $env:ELECTRON_RUN_AS_NODE='1'
//   Set-Location 'D:\QQ-Agent-爆改版0.4'
//   & '.\node_modules\electron\dist\electron.exe' '.\skills\pixiv-lookup\breaker-e2e.mjs'

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(path.join(HERE, 'index.js')).href)

let pass = 0, fail = 0
const ok = (n, c, extra = '') => { if (c) { pass++; console.log(`  ✅ ${n}`) } else { fail++; console.log(`  ❌ ${n}${extra ? ' — ' + extra : ''}`) } }

// 自己搭一个最小 api（和宿主给的一样形状）
const cfg = {
  enabled: true, cookie: '', maxResults: 10, maxPages: 2, order: 'popular_d',
  allowR18: false, allowInGroup: true, proxy: '', timeoutMs: 20000,
  breakerEnabled: true, breakerThreshold: 3, breakerCooldownSec: 60,
}
const tools = new Map()
mod.setup({
  registerTool: (d) => tools.set(`pixiv-lookup__${d.id}`, d),
  config: () => cfg,
  log: () => {}, warn: () => {},
})
const search = tools.get('pixiv-lookup__search')
const artwork = tools.get('pixiv-lookup__artwork')
const ranking = tools.get('pixiv-lookup__ranking')

/** 假出网：永远"连接超时"，并记下真实被调用的次数 */
let calls = 0
function alwaysTimeout() {
  calls = 0
  mod.__setTransport(async () => {
    calls++
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })
  })
}

console.log('\n=== pixiv-lookup 断路器端到端验收（不联网）===')

console.log('\n— 场景：Pixiv 连不上，模型连着试了 3 次 —')
mod.__resetBreaker()
alwaysTimeout()

const a = await search.execute({ kind: 'group', chatId: '1' }, { keyword: '初音ミク' })
ok('第 1 次：正常失败，未终止（应如实报错并提示配代理）',
  a.isError && calls === 1 && !/强制停止/.test(a.content) && /代理/.test(a.content), `calls=${calls}`)

const b = await search.execute({ kind: 'group', chatId: '1' }, { keyword: '原神' })
ok('第 2 次：仍是正常失败（阈值 3 未到）',
  b.isError && calls === 2 && !/强制停止/.test(b.content), `calls=${calls}`)

const c = await search.execute({ kind: 'group', chatId: '1' }, { keyword: 'アークナイツ' })
ok('第 3 次：达到阈值 → 返回里附带"已强制停止"+ 停止指令',
  c.isError && calls === 3 && /强制停止/.test(c.content)
  && /不要再调用任何 pixiv 工具/.test(c.content)
  && /用一句自然的中文/.test(c.content), `calls=${calls}`)
console.log('\n  ── 第 3 次失败时模型看到的全文 ──')
console.log(String(c.content).split('\n').map((l) => '  │ ' + l).join('\n'))

console.log('\n— 场景：模型不听，换个关键词继续试（第 4、5 次）—')
const before4 = calls
const d = await search.execute({ kind: 'group', chatId: '1' }, { keyword: '换个词再试' })
ok('第 4 次：冷却期内被拦下，**真实请求数没有增加**（0 毫秒返回，不再等超时）',
  calls === before4 && d.isError && /未执行/.test(d.content), `calls=${calls}`)
const e = await search.execute({ kind: 'group', chatId: '1' }, { keyword: '再换一个' })
ok('第 5 次：同样被拦下，仍然没有发请求', calls === before4 && /未执行/.test(e.content), `calls=${calls}`)
console.log('\n  ── 冷却期内模型看到的全文 ──')
console.log(String(d.content).split('\n').map((l) => '  │ ' + l).join('\n'))

console.log('\n— 场景：模型改用别的 pixiv 工具继续试 —')
const f = await artwork.execute({ kind: 'private', chatId: '9' }, { ids: '100412238' })
ok('artwork 被一起终止（跨工具生效）', calls === before4 && /未执行/.test(f.content), `calls=${calls}`)
const g = await ranking.execute({ kind: 'private', chatId: '9' }, {})
ok('ranking 被一起终止（跨工具生效）', calls === before4 && /未执行/.test(g.content), `calls=${calls}`)

console.log('\n— 场景：冷却结束后自动半开 —')
// 把冷却降到最小值 5 秒，真等 5.2 秒 —— 这是唯一能证明"会自动恢复"的办法
cfg.breakerCooldownSec = 5
mod.__resetBreaker()
alwaysTimeout()
for (let i = 0; i < 3; i++) await search.execute({}, { keyword: `t${i}` })
ok('先把断路器打开', calls === 3, `calls=${calls}`)
const blocked = await search.execute({}, { keyword: 'blocked' })
ok('冷却期内仍然拦（未发请求）', calls === 3 && /未执行/.test(blocked.content), `calls=${calls}`)
console.log('  （等 5.2 秒，验证冷却到期后会自动放行一次试探…）')
await new Promise((r) => setTimeout(r, 5200))
mod.__setTransport(async () => {
  calls++
  return {
    status: 200, ok: true, headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ error: false, body: { illustManga: { data: [], total: 0 } } }),
  }
})
const recovered = await search.execute({}, { keyword: 'recover' })
ok('冷却到期后自动放行一次试探，且这次真的发出了请求', calls === 4, `calls=${calls}`)
ok('试探成功 → 断路器完全恢复（不再是终止态）', !/未执行|强制停止/.test(recovered.content))
cfg.breakerCooldownSec = 60
mod.__resetBreaker()

console.log('\n— 场景：这些失败**不该**开断路器 —')
mod.__resetBreaker()
let n404 = 0
mod.__setTransport(async () => {
  n404++
  return {
    status: 404, ok: false, headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ error: true, message: 'not found' }),
  }
})
for (let i = 0; i < 5; i++) await artwork.execute({}, { ids: `${100000000 + i}` })
const stillOk = await search.execute({}, { keyword: '还能用吗' })
ok('连续 5 次 404（作品不存在）不会终止插件',
  !/未执行|强制停止/.test(stillOk.content) && n404 >= 6, `请求数=${n404}`)
mod.__resetBreaker()

console.log('\n— diagnose() 的状态呈现 —')
mod.__resetBreaker()
alwaysTimeout()
await search.execute({}, { keyword: 'x' })
const dg1 = mod.diagnose({ config: { skills: { 'pixiv-lookup': { ...cfg, cookie: 'PHPSESSID=SECRETZZZ' } } } })
console.log('  失败 1 次后：' + dg1.断路器)
ok('诊断显示待命 + 连续失败计数', /待命/.test(dg1.断路器) && /连续失败 1\/3/.test(dg1.断路器), dg1.断路器)
ok('诊断不泄漏 Cookie 明文', !JSON.stringify(dg1).includes('SECRETZZZ'))
await search.execute({}, { keyword: 'y' })
await search.execute({}, { keyword: 'z' })
const dg2 = mod.diagnose({ config: { skills: { 'pixiv-lookup': { ...cfg } } } })
console.log('  触发后   ：' + dg2.断路器)
ok('诊断显示已触发 + 冷却剩余秒数', /已触发/.test(dg2.断路器) && /冷却 \d+s\/60s/.test(dg2.断路器), dg2.断路器)
ok('诊断带最近失败原因', /超时|Pixiv/.test(dg2.断路器), dg2.断路器)
mod.__resetBreaker()

console.log('\n— 场景：管理员把开关关掉 —')
cfg.breakerEnabled = false
mod.__resetBreaker()
alwaysTimeout()
for (let i = 0; i < 6; i++) await search.execute({}, { keyword: `off${i}` })
ok('breakerEnabled=false：连续 6 次失败也不终止，每次都真的去请求了', calls === 6, `calls=${calls}`)
cfg.breakerEnabled = true
mod.__resetBreaker()

console.log(`\n=== 结论：${pass} 项通过，${fail} 项失败 ===`)
process.exit(fail ? 1 : 0)
