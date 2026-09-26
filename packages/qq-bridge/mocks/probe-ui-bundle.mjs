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
  // ── 0.2.2：人设页重做 → 又改成了「人设库」──────────────────────────────
  // ⚠️ 这里的两条**暂时**还在断言旧人设页的产物（见下面那段说明）：
  //    正在伺服的 dist 是"人设页 = 三选一 + 自定义文本框"那一版构建的，
  //    而 0.2.2 的**后端已经换代**（`/api/persona` → `/api/personas`，改用 `personas/<名字>.md`）。
  //    所以那一页现在会显示「接口已换代」（410），**这是刻意的、不是 bug** ——
  //    界面要按 CONFIG-UI.md §2.2 重新生成。等新界面构建出来，把这几条换成新契约：
  //      ['/api/personas 调用', 'api/personas'],
  //      ['新建人设要填名字', '新建人设'],
  //      ['「目前人设」卡片', '目前人设'],
  //      ['人设全文的展开按钮', '看全文'],
  //    并且**删掉**下面这四条旧的（它们属于已经退役的那一页）：
  //      ['改名字（结构化编辑）', '保存名字'],
  //      ['唤醒词一栏（用户怎么叫它）', '现在能叫醒它的名字'],
  //      ['它怎么称呼对方那一栏', '它怎么称呼对方'],
  ['/api/persona 调用（旧版界面；已换代 → 410，等界面重新生成）', 'api/persona'],
  ['人设全文的展开按钮', '看全文'],
  // ── 0.2.2：扩展页（技能 + 插件）—— **界面还没做** ──────────────────────
  // 用户要求"控制台加减法最后做，等指令"，所以那个页签只在规格里（CONFIG-UI.md §2.10）。
  // 第一版在这里写了一条 `['/api/extensions 调用', 'api/extensions']`，探针当场报红 ——
  // 那是对的：**探针只该断言已经存在的东西**，否则"红色"就变成了噪音。
  // 那个页签落地时，把下面这行打开：
  // ['/api/extensions 调用', 'api/extensions'],
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
