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
import {
  FIRES_REL,
  MISSED_REL,
  deleteTask as deleteScheduleTask,
  dueAt,
  listTasks as listScheduleTasks,
  msUntilNext,
  readFireIndex,
  readKnownChats,
  readLedger,
  writeTask as writeScheduleTask,
} from '../src/schedule.mjs'
import { createRestarter } from '../src/servers/restart.mjs'

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
/**
 * 配置的**可变桩**（④-d 的服务器条目增删改要真的读→改→写回）。
 * 起点放一台 `s1`，与 `serversList` / `serversCommand` 的桩对齐。
 */
let rawConfigStub = { servers: [{ id: 's1', name: '主服' }] }
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
  // ★ 用**可变桩**（而不是 `() => ({})`）：④-d 的服务器条目增删改要真的
  //   "读→改→写回去"，否则 `created` 的判据测不出来（写进去的内容被丢掉，
  //   第二次保存同一台仍然报"新建"）。这是"测了空气"的典型形状。
  readRawConfig: () => rawConfigStub,
  writeRawConfig: (cfg) => {
    rawConfigStub = cfg
  },
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

  // ── 0.3.2 P5 定时任务（任务页签）────────────────────────────────────────
  //
  // ★ 依赖名必须与 `api.mjs` 里解构的名字**逐个一致**（`scheduleList` / `scheduleSave` /
  //   `scheduleDelete` / `scheduleHistory`）—— 名字写错的表现是路由回 501，
  //   而 501 在界面上是"未实现"（会被静默隐藏），很难看出是名字写错了。
  // ★ 这里**直接用真实现**（`src/schedule.mjs`）+ 真临时工作区：
  //   "写进去能不能读回来""删了还在不在"这类问题，只有真落盘才答得出来。
  scheduleList: async () => {
    const listed = listScheduleTasks({ workspace: WS })
    const idx = readFireIndex({ workspace: WS })
    const claimed = new Set(idx.map.keys())
    const now = Date.now()
    return {
      ok: true,
      enabled: false,
      tasks: listed.tasks.map((t) => {
        const due = dueAt(t, { now, isClaimed: (k) => claimed.has(k) })
        return {
          ...t,
          nextInMs: msUntilNext(t, { now, isClaimed: (k) => claimed.has(k) }),
          dueNow: Boolean(due),
          dueScheduledAt: due ? due.scheduledAt : null,
          dueLateMs: due ? due.lateByMs : 0,
        }
      }),
      problems: listed.problems,
      ledgerBad: idx.bad,
      missed: readLedger(MISSED_REL, { workspace: WS }).rows.slice(-20),
      history: readLedger('runtime/schedule-history.jsonl', { workspace: WS }).rows.slice(-20),
      knownChats: readKnownChats({ workspace: WS }).chats,
      timezone: 'Asia/Shanghai',
    }
  },
  scheduleSave: async ({ task } = {}) => {
    const r = writeScheduleTask({ workspace: WS, task })
    return r.ok ? { ok: true, task: r.task } : { ok: false, why: r.why }
  },
  scheduleDelete: async ({ id } = {}) => {
    if (!id) return { ok: false, why: '缺少 id' }
    const r = deleteScheduleTask({ workspace: WS, id })
    return r.ok ? { ok: true } : { ok: false, why: r.why }
  },
  scheduleHistory: async ({ limit = 50 } = {}) => ({
    ok: true,
    fires: readLedger(FIRES_REL, { workspace: WS, limit }).rows,
    missed: readLedger(MISSED_REL, { workspace: WS, limit }).rows,
    history: readLedger('runtime/schedule-history.jsonl', { workspace: WS, limit }).rows,
  }),

  // ── 0.3.2 P2/P4 服务器监测（服务器页签）───────────────────────────────
  //
  // ★ 故意在密码字段里放一个**必须永不外泄**的串（与 `/api/snowluma/accounts`
  //   那条断言同一个套路）：路由若漏了白名单，这条会当场变红。
  serversList: async () => ({
    ok: true,
    enabled: true,
    running: true,
    pollMs: 30000,
    servers: [
      {
        id: 's1',
        name: '主服',
        enabled: true,
        host: '127.0.0.1',
        port: 25565,
        rconPort: 25575,
        passwordSet: true,
        startCommandSet: true,
        __password: 'THIS_SHOULD_NEVER_LEAK',
        failThreshold: 2,
        rules: { minTps: null, maxPlayers: null },
        monitor: { phase: 'up', samples: 3, failures: 0, lastAt: 1000, lastReachable: true, lastPlayers: 2, lastTps: null, lastVersion: null, lastError: null },
        ownership: { owner: 'bridge', pid: 4242, startedAt: 900, portOpen: true, why: '是我起的' },
        restart: { attempts: 0, lastOutcome: null, lastAttemptAt: null, cooldownUntil: null, waitingForAdmin: false },
        lastSample: 1000,
      },
    ],
    recentEvents: [],
  }),
  // ★ 人工指令：用**真实现**改真临时工作区里的重启状态（"改完能不能从盘上读回来"只有真落盘才答得出）
  serversAction: async ({ serverId, action } = {}) => {
    if (serverId !== 's1') return { ok: false, why: `没有 id 为「${serverId}」的服务器` }
    if (action !== 'retry' && action !== 'abandon') return { ok: false, why: `不认识的动作「${action}」` }
    const r = createRestarter({ workspace: WS, serverId, log: () => {} })
    r.load()
    if (action === 'retry') r.approveRetry()
    else r.abandon()
    const st = r.state()
    return {
      ok: true,
      serverId,
      action,
      attempts: st.attempts,
      waitingForAdmin: st.waitingForAdmin === true,
      cooldownUntil: st.cooldownUntil ?? null,
      hint: action === 'retry' ? '已解除「等指令」与冷却。**真正的重启会在下一次检测到它连不上时执行。**' : '已标记放弃。',
    }
  },
  // ── 0.3.2 收尾：服务器**控制台**与**条目增删改** ──────────────────────
  //
  // ★ 控制台是**完整 RCON**（op 级别）⇒ 这一套盯两件事：
  //   ① 缺 serverId / 空命令 / 超长命令一律 **400**（fail-closed，不猜哪一台）；
  //   ② 实现带回的密码**绝不外泄**（照 serversList 那套"故意放一个必泄串"的套路）。
  serversCommand: async ({ serverId, command } = {}) => {
    if (serverId !== 's1') return { ok: false, why: `没有 id 为「${serverId}」的服务器` }
    return {
      ok: true,
      command,
      reply: '',
      output: '[Server thread/INFO]: 时间设为白天\n',
      nextByte: 12345,
      rotated: false,
      caveat: '以下是控制台的新增输出，**不保证只属于这一条命令**。',
      __password: 'THIS_SHOULD_NEVER_LEAK',
    }
  },
  normalizeServer: (entry) => {
    if (!entry || typeof entry !== 'object') return null
    const id = String(entry.id ?? '').trim()
    if (!id) return null
    return { id, name: String(entry.name ?? id), host: '127.0.0.1', port: 25565, rconPort: 25575, password: '', enabled: true }
  },
  onServersChanged: async () => ({ ok: true, changed: true, count: 2 }),
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
section('④-c /api/schedule —— 定时任务（0.3.2 P5 任务页签）')
// ══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么这一节必须"真起 HTTP 打一次"：这三类错**`node --check` 与导入审计都抓不到**
//   （AGENT.md 里写着）：① 返回自己的对象而不是 `ok()`；② 异步漏 `await`（序列化成 `{}`，
//   界面"什么都不显示"却不报错）；③ **依赖名与 api.mjs 解构的名字不一致** ⇒ 路由拿不到依赖、
//   回 501，而 501 在界面上是"未实现"（会被静默隐藏）。
{
  const post = async (p, body) => {
    const res = await fetch(url(p), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON 就按文本看 */
    }
    return { status: res.status, text, json }
  }
  const del = async (p) => {
    const res = await fetch(url(p), { method: 'DELETE', signal: AbortSignal.timeout(15_000) })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON 就按文本看 */
    }
    return { status: res.status, text, json }
  }

  // ① 列表：**不是空对象**（漏 await 就会是 `{}`）
  const l0 = await get('/api/schedule')
  check('返回 200', l0.status === 200, String(l0.status))
  check('★★ 拿到的是内容而不是 `{}`（漏 await 的典型形状）', Array.isArray(l0.json?.data?.tasks), l0.text.slice(0, 120))
  check('★ 带 `enabled`（功能总开关状态）与 `knownChats`（目标必须在这份名单里）',
    typeof l0.json.data.enabled === 'boolean' && Array.isArray(l0.json.data.knownChats))
  check('★ `problems` / `ledgerBad` 也在（界面要能说"有 N 条读不出来"）',
    Array.isArray(l0.json.data.problems) && typeof l0.json.data.ledgerBad === 'number')

  // ② 保存：**校验不过一个字都不写**
  const bad = await post('/api/schedule', { task: { id: 'x', title: '缺 prompt 与 target' } })
  check('★ 非法任务 → 400（不是 500，也不是"默默存了"）', bad.status === 400, String(bad.status))
  const before = (await get('/api/schedule')).json.data.tasks.length
  check('★★ 被拒之后磁盘上**没有多出一条**（不许写半个任务）', before === 0, String(before))
  check('★ 缺 task 对象也 400（不用空对象去"存一条空任务"）', (await post('/api/schedule', {})).status === 400)

  // ③ 存一条合法的：下一跳/触发点字段要真的算出来
  const okBody = {
    task: {
      id: 'api1',
      title: '接口用例',
      repeat: { kind: 'daily', at: '08:00', weekdays: null },
      target: { kind: 'private', peerId: '999' },
      prompt: '提醒我吃饭',
      timezone: 'Asia/Shanghai',
    },
  }
  const saved = await post('/api/schedule', okBody)
  check('★ 合法任务 → 200 且回带规范化后的任务', saved.status === 200 && saved.json?.data?.task?.id === 'api1', saved.text.slice(0, 160))
  const after = await get('/api/schedule')
  const one = after.json.data.tasks.find((t) => t.id === 'api1')
  check('★★ 列表里出现了它，且**带算出来的 `nextInMs` / `dueNow`**',
    Boolean(one) && 'nextInMs' in one && typeof one.dueNow === 'boolean',
    JSON.stringify(one)?.slice(0, 200))
  check('★ 规范化后的形状带 `effectiveFrom`（"从哪一刻起算它的账"）', typeof one.effectiveFrom === 'number')

  // ④ 历史：三份台账都要有键（**字段名对着实现取**，别按想象改名）
  const h = await get('/api/schedule/history?limit=5')
  check('历史接口 200 且三份台账齐全（fires/missed/history）',
    h.status === 200 && Array.isArray(h.json?.data?.fires) && Array.isArray(h.json?.data?.missed) && Array.isArray(h.json?.data?.history),
    h.text.slice(0, 140))

  // ⑤ 删除：**没有 id 就 400**（"删全部"是最坏的一种猜错）
  check('★★ 没带 id 的删除 → 400（绝不"删全部"）', (await del('/api/schedule')).status === 400)
  const d1 = await del('/api/schedule?id=api1')
  check('★ 带 id 的删除 → 200', d1.status === 200, String(d1.status))
  check('★ 删完之后列表里真的没了', (await get('/api/schedule')).json.data.tasks.length === 0)
  check('★ 删不存在的 id 如实报错（不装成功）', (await del('/api/schedule?id=nope')).status === 400)
}

// ══════════════════════════════════════════════════════════════════════════
section('④-d /api/servers —— 服务器监测状态（0.3.2 P2/P4 服务器页签）')
// ══════════════════════════════════════════════════════════════════════════
//
// ★ 这一条的核心是**凭据不出门**：RCON 密码是任意字符串，现有的密钥正则
//   （`sk-<32位>` 那两个 token）**天然抓不到它**，所以判据必须是
//   「响应里有没有那串密码」（逐字检查）+ 「有没有 passwordSet 这个布尔」。
{
  const r = await get('/api/servers')
  check('返回 200', r.status === 200, String(r.status))
  check('★★ 拿到的是内容而不是 `{}`（漏 await 的典型形状）', Array.isArray(r.json?.data?.servers), r.text.slice(0, 120))
  check('★ 带 `enabled` / `running`（功能开没开、监测跑没跑 —— 两个不同的问题）',
    typeof r.json.data.enabled === 'boolean' && typeof r.json.data.running === 'boolean')
  const row = r.json.data.servers[0]
  check('★ 每台带**活证据**：monitor + ownership + restart（界面据此显示"上次采样在多久前"）',
    Boolean(row) && 'monitor' in row && 'ownership' in row && 'restart' in row)
  check('★★★ 响应里**一个字符都没有密码**（依赖故意塞了 `THIS_SHOULD_NEVER_LEAK`）',
    !r.text.includes('THIS_SHOULD_NEVER_LEAK'), r.text.slice(0, 160))
  check('★ 只给"配没配"（passwordSet 布尔），不给密码本身', row?.passwordSet === true)
  check('★ startCommand 同理只给布尔（那是使用者的机器信息）', typeof row?.startCommandSet === 'boolean')
  check('★ 阈值缺失必须是 `null` 而**不是 0**（Number(null)===0 会让"没配"变成"阈值 0"⇒误报）',
    row?.rules?.minTps === null, JSON.stringify(row?.rules))

  // ── 人工指令：**只白名单两个动作**（fail-closed）──
  const act = async (body) => {
    const res = await fetch(url('/api/servers/action'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON 就按文本看 */
    }
    return { status: res.status, text, json }
  }
  check('★★★ `start` 走 HTTP **被拒**（它绕过了归属/冷却/次数三道纪律）', (await act({ serverId: 's1', action: 'start' })).status === 400)
  check('★★★ `stop` 同样被拒（同上）', (await act({ serverId: 's1', action: 'stop' })).status === 400)
  check('★ 不认识的动作 400', (await act({ serverId: 's1', action: 'nuke' })).status === 400)
  check('★★ 缺 serverId 就 400（**不猜是哪一台**）', (await act({ action: 'retry' })).status === 400)
  const okRetry = await act({ serverId: 's1', action: 'retry' })
  check('★ `retry` → 200 且回带状态', okRetry.status === 200 && typeof okRetry.json?.data?.attempts === 'number', okRetry.text.slice(0, 120))
  check('★★ 回带**如实提醒**：这条指令不会立刻重启（避免界面给人错误的期待）',
    /不会立刻重启|下一次检测到/.test(String(okRetry.json?.data?.hint ?? '')), String(okRetry.json?.data?.hint ?? ''))
  check('★ `abandon` → 200 且 waitingForAdmin=true', (await act({ serverId: 's1', action: 'abandon' })).json?.data?.waitingForAdmin === true)

  // ── ④-c 服务器**控制台**（0.3.2 收尾）：完整 RCON，只从本机网页进 ──────────
  //
  // ★★★ 这是**唯一**一个能对服务端下任意命令的 HTTP 口子（op 级别）。
  //   所以它必须：① 与"改重启状态机"那条**分开**（纪律不同）；
  //   ② 缺 serverId / 空命令一律 fail-closed；③ 密码绝不出门。
  const cmd = async (body) => {
    const res = await fetch(url('/api/servers/command'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON 按文本看 */
    }
    return { status: res.status, text, json }
  }
  check('★★★ 缺 serverId ⇒ 400（不猜是哪一台）', (await cmd({ command: 'list' })).status === 400)
  check('★★ 空命令 ⇒ 400（不发一条空命令给服务端）', (await cmd({ serverId: 's1', command: '   ' })).status === 400)
  check('★★ 超长命令 ⇒ 400（防止把巨串灌进控制台）', (await cmd({ serverId: 's1', command: 'x'.repeat(600) })).status === 400)
  const okCmd = await cmd({ serverId: 's1', command: 'time set day' })
  check('★ 正常命令 → 200', okCmd.status === 200, okCmd.text.slice(0, 120))
  check('★ 回带命令原文与控制台输出增量',
    okCmd.json?.data?.command === 'time set day' && String(okCmd.json?.data?.output ?? '').includes('时间设为白天'))
  check('★★★ 回带那句"输出不保证只属于这一条命令"（不许把它做成看起来精确的终端）',
    /不保证/.test(String(okCmd.json?.data?.caveat ?? '')), String(okCmd.json?.data?.caveat ?? ''))
  check('★★★ 控制台响应里也**一个字符都没有密码**', !okCmd.text.includes('THIS_SHOULD_NEVER_LEAK'))
  check('★ 不认识的 serverId 如实报错（不静默成功）', (await cmd({ serverId: 'nope', command: 'list' })).status === 400)

  // ── ④-d 服务器条目**增删改**（0.3.2 收尾）：改完要**即时生效** ────────────
  const saveSrv = async (body) => {
    const res = await fetch(url('/api/servers/save'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON 按文本看 */
    }
    return { status: res.status, text, json }
  }
  check('★★ 没带 server 对象 ⇒ 400', (await saveSrv({})).status === 400)
  check('★★★ 缺 id ⇒ 400（id 是状态文件的键，不能空）', (await saveSrv({ server: { name: '没有id' } })).status === 400)
  const saved = await saveSrv({ server: { id: 's2', name: '第二台' } })
  check('★ 合法条目 → 200 且如实回带 created', saved.status === 200 && saved.json?.data?.created === true, saved.text.slice(0, 140))
  check('★ 真的写回配置了（桩里现在有 s2）',
    Array.isArray(rawConfigStub.servers) && rawConfigStub.servers.some((s) => s.id === 's2'))
  const savedAgain = await saveSrv({ server: { id: 's2', name: '第二台改名' } })
  check('★★ 再存同一台 ⇒ created=false（**认得出是更新，不是又建一台**）',
    savedAgain.json?.data?.created === false, savedAgain.text.slice(0, 140))
  check('★ 更新是**替换**而不是追加（不允许出现两条同 id）',
    rawConfigStub.servers.filter((s) => s.id === 's2').length === 1)
  check('★★★ 回带"生效没有"（配置写进去 ≠ 生效了 —— 这是两件事）',
    typeof saved.json?.data?.applied === 'object' && saved.json?.data?.applied !== null,
    JSON.stringify(saved.json?.data?.applied))
  check('★ 即时生效：applied.changed 为 true（不必重启桥接）', saved.json?.data?.applied?.changed === true)

  const delSrv = async (body) => {
    const res = await fetch(url('/api/servers/delete'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 非 JSON 按文本看 */
    }
    return { status: res.status, text, json }
  }
  check('★★ 缺 serverId ⇒ 400', (await delSrv({})).status === 400)
  const delOk = await delSrv({ serverId: 's2' })
  check('★ 删掉存在的条目 → 200', delOk.status === 200, delOk.text.slice(0, 120))
  check('★★★ 明确回带"状态文件刻意保留"（那是"我起过它"的归属证据，删了就失去重启能力）',
    delOk.json?.data?.keptStateFiles === true && /归属证据/.test(String(delOk.json?.data?.note ?? '')),
    String(delOk.json?.data?.note ?? ''))
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
