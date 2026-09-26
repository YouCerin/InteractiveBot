/**
 * 记忆检索接口的真机探针（H13，不是测试）。
 *
 * 为什么单独一个：`node --check` 抓不到"依赖名写错导致路由回 501"——
 * 而 501 在界面上是"未实现"（会被**静默隐藏**），看起来像"这个功能还没做"。
 * 真机打一次就能区分"没实现"与"名字拼错"。
 *
 * 用法：node mocks/probe-memory-search.mjs [基址] [关键词]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:3410'
const Q = process.argv[3] ?? '小鲸鱼'

const res = await fetch(`${BASE}/api/memory/search?q=${encodeURIComponent(Q)}`, {
  signal: AbortSignal.timeout(15_000),
})
const text = await res.text()
let json = null
try {
  json = JSON.parse(text)
} catch {
  /* 非 JSON 就按文本看 */
}

console.log(`HTTP ${res.status}`)
if (res.status === 501) {
  console.log('❌ 501 = 路由存在但**依赖没注入**（多半是依赖名拼错，或 createApiHandler 少传一项）')
} else if (res.status !== 200) {
  console.log(`❌ 非预期状态：${text.slice(0, 200)}`)
} else {
  const d = json?.data ?? {}
  console.log(`扫了 ${d.files} 个记忆文件，命中 ${d.rows?.length ?? 0} 条`)
  for (const r of (d.rows ?? []).slice(0, 5)) {
    console.log(`  · ${r.rel}:${r.line}${r.superseded ? '（已被更正）' : ''}  ${r.preview}`)
  }
  console.log('✅ 记忆检索可用')
}
process.exitCode = res.status === 200 ? 0 : 1
