/**
 * H13 接口测试（**真起一个 HTTP 服务**，端口由系统分配）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么这一套必须起真服务（而不是直接调 handler）
 * ══════════════════════════════════════════════════════════════════════════
 * 真机上出过一次**整机下线**：新加的一条路由忘了用 `ok()` 包结果，于是
 * `result.status` 是 `undefined` → `res.writeHead(undefined)` 抛 `RangeError`，
 * 而它发生在 `req.on('end')` 的 async 回调里、**没人接住** → 未处理的 Promise 拒绝
 * → 进程按既定策略收尾退出。症状是"连不上 3410"，看起来像端口问题。
 *
 * 而**这个崩溃点在 `serveApi` 里，不在 handler 里** —— 直接调 handler 的测试
 * 永远看不到它。所以这一套真的起服务、真的发请求。
 *
 * 四个 H13 接口 + 一个"畸形返回不许拖垮进程"的回归锁：
 *   ① `/api/preflight`   —— 前置条件门控（异步，最容易漏 await）
 *   ② `/api/snowluma/accounts` —— 账号摘要（**绝不回 token**）
 *   ③ `/api/logs/stream` —— 日志增量（游标）
 *   ④ `/api/corpus/search` —— 语料检索（**fail-closed**：必须带会话）
 *
 * 用法：node mocks/verify-api-h13.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApiHandler, serveApi } from '../src/api.mjs'
import { createCorpus } from '../src/corpus.mjs'
import { sliceLogLines } from '../src/log-tail.mjs'
import { searchMemoryFiles } from '../src/memory-search.mjs'

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`✅ ${name}${detail ? `  —— ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`❌ ${name}  —— ${detail}`)
  }
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

const TMP = mkdtempSync(join(tmpdir(), `dsh-api-h13-${process.pid}-`))
const WS = join(TMP, 'workspace')
mkdirSync(WS, { recursive: true })

// 造一条真实语料（用于 ④）
{
  const c = createCorpus({ workspace: WS, log: () => {} })
  c.record({ messageId: '1', chatKey: 'group:700000001', kind: 'group', peerId: '700000001', senderId: '2', senderName: '望仔', text: '茶姬新出的那个好喝吗', at: Date.now() })
  c.record({ messageId: '2', chatKey: 'private:999', kind: 'private', peerId: '999', senderId: '999', senderName: '别人', text: '茶姬是我私聊里说的秘密', at: Date.now() })
  c.close()
}

const logs = []
// 造两个记忆文件（④-b 的记忆检索要扫它们）
{
  const memDir = join(WS, 'memory')
  mkdirSync(memDir, { recursive: true })
  writeFileSync(join(WS, 'MEMORY.md'), ['# 全局记忆', '- 他喜欢冰美式', '- 工作区里 store/ 是堆放点'].join('\n'), 'utf8')
  writeFileSync(
    join(memDir, 'private-999.md'),
    ['# 某个人的记忆', '- 他住上海', '- 〔已被更正：其实住杭州 · 2026-01-01〕他住北京'].join('\n'),
    'utf8',
  )
}

const handler = createApiHandler({
  configPath: join(TMP, 'config.json'),
  readRawConfig: () => ({}),
  writeRawConfig: () => {},
  normalize: (c) => c,
  validate: () => ({ problems: [] }),
  getStatus: () => ({ running: true }),
  preflight: async () => ({
    ok: true,
    blockers: 0,
    gates: [{ id: 'config', ok: true, level: 'info', title: '配置校验通过', hint: '', action: 'node src/index.mjs --check' }],
  }),
  listAccounts: () => ({
    installDir: 'C:\\fake\\snowluma',
    accounts: [
      { uin: '100000001', file: 'onebot_100000001.json', isCurrent: false },
      { uin: '200000001', file: 'onebot_200000001.json', isCurrent: true },
    ],
    current: 'matched-config:onebot_200000001.json',
    tokenPresent: true, // ⚠️ 故意放一个"有 token"的布尔，用来断言**值本身**不外泄
    httpToken: 'THIS_SHOULD_NEVER_LEAK',
  }),
  searchCorpus: ({ query, chatKey, limit }) => {
    const c = createCorpus({ workspace: WS, readOnly: true, log: () => {} })
    try {
      const r = c.search({ query, chatKey, limit })
      return { ok: r.ok === true, mode: r.mode, rows: (r.rows ?? []).map((row) => ({ mid: row.messageId, at: row.createdAt, sender: row.senderName, isBot: row.isBot, preview: row.preview })) }
    } finally {
      c.close()
    }
  },
  logStream: ({ since = 0, limit = 200 } = {}) =>
    // ★ 用**实现里那一份**纯函数（不在测试里再写一遍 —— 二次实现迟早分叉）
    sliceLogLines({ lines: ['line-A', 'line-B', 'line-C', 'line-D'], since, limit }),
  // ★ 依赖名必须与 api.mjs 里解构的名字**完全一致**（`searchMemory`）——
  //   第一版写成 `memorySearch`，于是路由拿不到依赖、回 501，
  //   而 501 在界面上是"未实现"（会被静默隐藏），很难看出是名字写错。
  searchMemory: ({ query, limit = 50 } = {}) =>
    // ★ 用**实现里那一份**纯函数（`src/memory-search.mjs`）—— 不在测试里再写一遍。
    searchMemoryFiles({ workspace: WS, query, limit }),
})

const server = await serveApi({ port: 0, handler, log: (m) => logs.push(String(m)) })
const url = (p) => `http://127.0.0.1:${server.port}${p}`
const get = async (p) => {
  const res = await fetch(url(p), { signal: AbortSignal.timeout(15_000) })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 就按文本看 */
  }
  return { status: res.status, text, json }
}

// ══════════════════════════════════════════════════════════════════════════
section('① /api/preflight —— 异步接口**必须真的 await**')
// ══════════════════════════════════════════════════════════════════════════
{
  const r = await get('/api/preflight')
  check('返回 200', r.status === 200, String(r.status))
  check('★★ 拿到的是**内容**而不是一个空对象（漏 await 时 Promise 会序列化成 `{}`）',
    r.json?.data && Array.isArray(r.json.data.gates) && r.json.data.gates.length > 0,
    JSON.stringify(r.json?.data)?.slice(0, 120))
  check('★ 每条门控都带 title 与 action（失败时要给**可操作的话**）',
    r.json.data.gates.every((g) => typeof g.title === 'string' && typeof g.action === 'string'))
  check('带汇总（ok / blockers），界面不用自己数', typeof r.json.data.ok === 'boolean' && typeof r.json.data.blockers === 'number')
}

// ══════════════════════════════════════════════════════════════════════════
section('② /api/snowluma/accounts —— **绝不回 token**')
// ══════════════════════════════════════════════════════════════════════════
{
  const r = await get('/api/snowluma/accounts')
  check('返回 200', r.status === 200, String(r.status))
  check('★★★ 响应里**一个 token 都不许有**（哪怕依赖故意塞了一个）',
    !r.text.includes('THIS_SHOULD_NEVER_LEAK'), r.text.slice(0, 120))
  check('  也不含 `token` / `Bearer` 这类字样（不给人"这里可能有凭据"的错觉）',
    !/token|bearer|accessToken|httpToken/i.test(r.text), r.text.slice(0, 160))
  check('★ 给出账号列表与"谁是当前在用的"（界面要能显示）',
    Array.isArray(r.json.data.accounts) && r.json.data.accounts.filter((a) => a.isCurrent).length === 1,
    JSON.stringify(r.json.data.accounts))
}

// ══════════════════════════════════════════════════════════════════════════
section('③ /api/logs/stream —— 游标增量，不带参数也能答')
// ══════════════════════════════════════════════════════════════════════════
{
  const a = await get('/api/logs/stream?since=0&limit=2')
  check('返回 200 且给了前 2 行', a.status === 200 && a.json.data.lines.length === 2, JSON.stringify(a.json?.data))
  check('带游标与总数（界面据此接着拉）', a.json.data.cursor === 2 && a.json.data.total === 4)
  const b = await get(`/api/logs/stream?since=${a.json.data.cursor}&limit=10`)
  check('★ 按游标接着拉 → 只给**新的**那些行', JSON.stringify(b.json.data.lines) === JSON.stringify(['line-C', 'line-D']),
    JSON.stringify(b.json.data.lines))
  const c = await get('/api/logs/stream')
  check('不带参数 → 默认也能答（不 400）', c.status === 200 && Array.isArray(c.json.data.lines))
  const d = await get('/api/logs/stream?since=999')
  check('游标超出（日志被轮转过）→ 夹回开头，而不是永远空着', d.json.data.lines.length > 0)
}

// ══════════════════════════════════════════════════════════════════════════
section('④ /api/corpus/search —— **fail-closed**：不跨会话')
// ══════════════════════════════════════════════════════════════════════════
{
  const missing = await get('/api/corpus/search?q=%E8%8C%B6%E5%A7%AC')
  check('★ 缺会话 → 400（绝不"默认搜全部"）', missing.status === 400, String(missing.status))
  check('  理由说清"不跨会话检索"', String(missing.json?.error).includes('不跨会话'))

  const badKind = await get('/api/corpus/search?q=x&kind=all&peerId=1')
  check('  kind 不合法 → 400', badKind.status === 400)

  const ok1 = await get('/api/corpus/search?q=%E8%8C%B6%E5%A7%AC&kind=group&peerId=700000001')
  check('★ 带会话 → 200 且搜得到（中文 2 字走 LIKE 回退）',
    ok1.status === 200 && ok1.json.data.rows.length >= 1, JSON.stringify(ok1.json?.data)?.slice(0, 140))
  check('★★ 结果里**只有本会话**的消息（别的会话那句"私聊里的秘密"一个字都不许出现）',
    !ok1.text.includes('秘密'), ok1.text.slice(0, 160))
  check('  字段是 preview（语料库返回的就是截断预览，不叫 text）',
    ok1.json.data.rows.every((r) => typeof r.preview === 'string' && !('text' in r)))
}

// ══════════════════════════════════════════════════════════════════════════
section('④-b /api/memory/search —— 搜"沉淀的事实"（不需要会话参数）')
// ══════════════════════════════════════════════════════════════════════════
{
  const missing = await get('/api/memory/search')
  check('★ 缺 q → 400（不返回全部记忆）', missing.status === 400, String(missing.status))

  const hit = await get('/api/memory/search?q=%E5%86%B0%E7%BE%8E%E5%BC%8F')
  const hd = hit.json?.data
  check('返回 200 且搜到条目', hit.status === 200 && (hd?.rows?.length ?? 0) >= 1,
    JSON.stringify(hd)?.slice(0, 140))
  // ⚠️ 断言要用可选链：一条失败不该让整个脚本抛（第一版就是那样，输出只有半个报告）
  check('★ 每行带文件名与行号（能定位到具体哪一条）',
    (hd?.rows ?? []).every((r) => typeof r.rel === 'string' && Number.isInteger(r.line)))
  check('★ 只回**预览**（不是整份记忆）',
    (hd?.rows ?? []).every((r) => typeof r.preview === 'string' && r.preview.length <= 120))
  // ★ 另搜一个**只出现在"已被更正"那一行**的词（北京）—— 用来验证标标记真的生效。
  //   第一版搜的是"冰美式"（在正常条目上），于是断言看的是 `superseded: false`，
  //   自己把自己判红了 —— 断言用的样本必须落在它要验的那一类上。
  const sup = await get('/api/memory/search?q=%E5%8C%97%E4%BA%AC')
  check('★ 已更正的条目**被标出来**（否则会让人以为模型还在用那条错的）',
    (sup.json?.data?.rows ?? []).some((r) => r.superseded === true),
    JSON.stringify(sup.json?.data?.rows))
  check('  报了扫了几个记忆文件（让人知道搜索范围）', (hd?.files ?? 0) >= 2, String(hd?.files))
  check('★★ 搜不到时是"空结果 + 200"，不是报错（搜索无结果不是故障）',
    (await get('/api/memory/search?q=%E4%B8%8D%E5%8F%AF%E8%83%BD%E5%AD%98%E5%9C%A8%E7%9A%84%E8%AF%8D')).status === 200)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ ★★★ 畸形返回不许拖垮进程（真机事故的回归锁）')
// ══════════════════════════════════════════════════════════════════════════
{
  // 故意造一个"忘了包 ok()"的 handler —— 它就是真机上把整个桥接带下线的那个形状
  const badServer = await serveApi({
    port: 0,
    handler: async () => ({ lines: [], cursor: 0 }), // ← 没有 status
    log: (m) => logs.push(String(m)),
  })
  const badGet = async (p) => {
    const res = await fetch(`http://127.0.0.1:${badServer.port}${p}`, { signal: AbortSignal.timeout(10_000) })
    return { status: res.status, text: await res.text() }
  }
  const r1 = await badGet('/api/anything')
  check('★★★ 畸形返回 → 变成 500，而**不是** `writeHead(undefined)` 崩掉进程', r1.status === 500, String(r1.status))
  check('★★ 并且**留下证据**（日志里指明是哪条路由的代码缺陷）',
    logs.some((l) => l.includes('畸形结果')), logs.filter((l) => l.includes('畸形')).slice(-1)[0] ?? '（没有日志）')
  // ★ 最要紧的一条：服务**还活着**（真机上这里是"进程已经退出"）
  const r2 = await badGet('/api/anything')
  check('★★★ 服务仍然能应答下一个请求（真机上这一步是"进程已经没了"）', r2.status === 500, String(r2.status))
  await badServer.close()
}

await server.close()

try {
  rmSync(TMP, { recursive: true, force: true })
} catch (error) {
  console.log(`⚠️ 临时目录清理失败（无害）：${error?.code ?? error?.message}`)
}

console.log('')
if (failed === 0) {
  console.log(`🎉 H13 接口测试全部通过（${passed} 项）`)
  process.exitCode = 0
} else {
  console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
  process.exitCode = 1
}
