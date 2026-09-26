/**
 * H13 接口的真机探针（不是测试）：把四个新接口各打一次，并把响应如实打印。
 *
 * 为什么单独有它：`node --check` 与导入审计都**抓不到 ReferenceError**
 * （"函数写好了，但里面用了一个不存在的变量"只在请求真的打进来时才炸）——
 * 本项目为这类"接线级"缺陷付过最贵的学费。所以每个新接口都要**真的打一次**。
 *
 * 用法：node mocks/probe-h13-endpoints.mjs [基址]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:3410'

const PROBES = [
  ['/api/preflight', '启动前置条件门控'],
  ['/api/snowluma/accounts', '账号发现（必须**不含 token**）'],
  ['/api/logs/stream?since=0&limit=3', '日志流（增量）'],
  ['/api/corpus/search?q=%E7%BE%A4&kind=group&peerId=700000001&limit=3', '语料检索（带会话）'],
  ['/api/corpus/search?q=%E7%BE%A4', '语料检索（**缺会话** → 必须 400）'],
  ['/api/logs/stream', '日志流（不带参数也得能答）'],
]

let bad = 0
for (const [p, label] of PROBES) {
  try {
    const res = await fetch(`${BASE}${p}`, { signal: AbortSignal.timeout(30_000) })
    const text = await res.text()
    const expect400 = label.includes('缺会话')
    const okStatus = expect400 ? res.status === 400 : res.status === 200
    if (!okStatus) bad += 1
    console.log(`=== ${label}  → HTTP ${res.status}${okStatus ? '' : '  ❌'}`)
    console.log(`    ${text.slice(0, 420)}`)
    if (/\bhttps?:\/\/[^\s"]*\?access_token=|access_token|Bearer\s+[A-Za-z0-9]{10,}/.test(text)) {
      bad += 1
      console.log('    ❌❌ 响应里出现了疑似 token —— 这是泄露')
    }
  } catch (error) {
    bad += 1
    console.log(`=== ${label}  → ❌ 请求失败：${error?.message ?? error}`)
  }
  console.log('')
}

console.log(bad === 0 ? '✅ 四个接口都按预期回答' : `❌ 有 ${bad} 项不符合预期`)
// ⚠️ 不要用 `process.exit()`：真机上它会在 fetch 句柄还没关完时被调用，
//    Node 直接 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` **崩掉**
//    —— 明明结果是全绿的，退出码却是 1（看起来像探针坏了）。设 exitCode 让它自己退。
process.exitCode = bad === 0 ? 0 : 1
