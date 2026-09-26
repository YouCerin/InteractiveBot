/**
 * 界面产物的真机探针（H13，不是测试）：**正在伺服的那份 UI 到底有没有新功能**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（这个项目真的踩过）
 * ══════════════════════════════════════════════════════════════════════════
 * 界面分两条路出货（开发路径 / 发布包路径），而它们**脱钩过一次** ——
 * 实测包里那份旧了 5 小时，而 1100 项测试全绿（测试跑的是源码，不是产物）。
 * 所以"我改了 src 里的 React 组件"与"使用者打开页面能看到它"是两件事：
 * 中间隔着 `npm run build`，而**忘了 build 不会有任何报错**。
 *
 * 这个探针问三个具体问题：
 *   ① `/api/status.ui.status` 是不是 `fresh`（产物与源码同步）；
 *   ② 伺服出去的 `index.html` 里的入口 JS 能不能取到；
 *   ③ **那个 JS 里有没有本轮新增的东西**（按关键串判断 —— 比"hash 变了"更贴近事实）。
 *
 * 用法：node mocks/probe-ui-bundle.mjs [基址]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:3410'

/** 新增功能在产物里的**关键串**（选了不会出现在别处的说法）。 */
const EXPECT = [
  ['/api/preflight 调用', 'api/preflight'],
  ['/api/logs/stream 调用', 'api/logs/stream'],
  ['/api/snowluma/accounts 调用', 'api/snowluma/accounts'],
  ['/api/corpus/search 调用', 'api/corpus/search'],
  ['前置门控的标题文案', '启动条件都满足'],
  ['日志面板标题', '桥接日志'],
  ['账号卡片的"当前在用"', '当前在用'],
  ['明确写出不显示 token', '不显示 token'],
  ['会话内检索的提示', '只搜这一个会话'],
  ['记忆检索卡片', '搜记忆条目'],
  // ⚠️ 探针串必须出现在**会被渲染的文案**里：第一版用了组件注释里的说法，
  //    而注释在构建时会被剥掉 —— 探针于是报"产物里没有"，看起来像忘了 build。
  ['记忆检索的占位文案', '在全部记忆文件里搜关键词'],
  ['已被更正标记', '不再作为事实使用'],
]

let bad = 0
const fail = (m) => {
  bad += 1
  console.log(`❌ ${m}`)
}

try {
  const status = await (await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(10_000) })).json()
  const ui = status?.data?.ui
  console.log(`界面状态：${ui?.status ?? '?'}（产物构建于 ${ui?.stamp?.builtAt ?? '?'}）`)
  if (ui?.status !== 'fresh') fail(`产物**不同步**：${ui?.why ?? '（没有说明）'} → 先 cd config-ui && npm run build`)

  const html = await (await fetch(`${BASE}/`, { signal: AbortSignal.timeout(15_000) })).text()
  const entry = html.match(/assets\/index-[\w-]+\.js/)
  if (!entry) fail('index.html 里找不到入口 JS（界面没被伺服？）')
  else {
    const js = await (await fetch(`${BASE}/${entry[0]}`, { signal: AbortSignal.timeout(30_000) })).text()
    console.log(`入口产物：${entry[0]}（${Math.round(js.length / 1024)} KB）`)
    for (const [label, needle] of EXPECT) {
      if (js.includes(needle)) console.log(`  ✅ ${label}`)
      else fail(`产物里**没有** ${label}（"${needle}"）—— 很可能忘了 npm run build`)
    }
  }
} catch (error) {
  fail(`探针请求失败：${error?.message ?? error}（机器人没在跑？）`)
}

console.log('')
console.log(bad === 0 ? '✅ 正在伺服的就是含本轮新功能的产物' : `❌ 有 ${bad} 项不符合预期`)
process.exitCode = bad === 0 ? 0 : 1
