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
// ★ 服务器条目的归一化**只用实现里那一份**（见下面 `normalizeServer` 那行注释：
//   手写桩曾经把 `commandFromQQ` 等字段丢掉，让一条正确的断言假红）。
import { normalizeServerEntry } from '../src/config.mjs'

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
let rawConfigStub = { servers: [{ id: 's1', name: '主服', password: 'THIS_SHOULD_NEVER_LEAK' }] }
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
  // ★★★ **用实现里那一份**归一化（`normalizeServerEntry`），不在测试里再写一遍。
  //
  // ★ 这里原来是一个手写的 7 字段桩（`{id,name,host,port,rconPort,password,enabled}`），
  //   而它**恰好把 `commandFromQQ` / `failThreshold` / `logEncoding` / `startArgs` 全丢了** ——
  //   于是"更新时按字段合并、不许重置没提交的字段"这条断言**永远是红的**，
  //   看起来像产品代码的 bug，其实是桩在说谎（"二次实现迟早分叉"，这次分叉的是测试）。
  //   真机上跑的是 `normalizeServerEntry`，测试就该用同一份 —— 它本来就是这个理由被导出的。
  normalizeServer: normalizeServerEntry,
  onServersChanged: async () => ({ ok: true, changed: true, count: 2 }),
  // 主动检测（0.3.2 收尾）：桩里**故意**回带一个必泄串，让"字段白名单"那条断言能抓漏
  // （同 `serversList` 的套路）。
  serversProbe: async ({ serverId } = {}) => {
    if (serverId !== 's1') return { ok: false, why: `没有 id 为「${serverId}」的服务器` }
    return {
      ok: true,
      serverId,
      snapshot: { reachable: true, players: 1, playerNames: ['YoCerin'], tps: 20, probed: true, __password: 'THIS_SHOULD_NEVER_LEAK' },
    }
  },
  // 控制台最新输出：桩里回一段**含中文**的内容（真机那个文件是 GBK）
  serversConsole: ({ serverId } = {}) => {
    if (serverId !== 's1') return { ok: false, why: `没有 id 为「${serverId}」的服务器` }
    return {
      ok: true,
      lines: [
        '[12:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: <YoCerin> 你好',
        '[12:00:01] [Server thread/INFO] [minecraft/MinecraftServer]: Saving players',
      ],
      total: 2,
      encoding: 'gbk',
      why: '',
      __password: 'THIS_SHOULD_NEVER_LEAK',
    }
  },
  // ── 服务端 `server.properties`（0.3.2 收尾）：读状态 / 一键配好 ──────────────
  // ★ 桩里**故意回带密码字段**（`__password` 与 settings 里的原始 `password`），
  //   用来断言路由那层的字段白名单真的把它们挡住了（与上面几处同一个套路）。
  serversProperties: async ({ serverId } = {}) => {
    if (serverId === 's2') {
      // ★ "文件里没写那两项"那一档：路由必须回 `null` 而不是 `0`/`false`
      //   （`Number(null)===0` 是这条路上最容易踩的坑，见 ④-d-5 的断言）
      return {
        ok: true,
        serverId: 's2',
        path: 'C:\\fake\\store\\mc-two\\server.properties',
        from: 'config.json 的 servers[].cwd',
        settings: { enableRcon: null, rconPort: null, passwordSet: false },
        describe: 'enable-rcon=**没有这一项/值看不懂** · rcon.port=没写（默认 25575） · rcon.password=**空**',
        eula: { path: 'C:\\fake\\store\\mc-two\\eula.txt', exists: false, agreed: null },
        configRconPort: null,
        configPasswordSet: false,
      }
    }
    if (serverId !== 's1') return { ok: false, why: `没有 id 为「${serverId}」的服务器` }
    return {
      ok: true,
      serverId: 's1',
      path: 'C:\\fake\\store\\mc-main\\server.properties',
      from: '归属档（我们拉起它时用的工作目录）',
      settings: { serverPort: 25565, enableRcon: false, rconPort: 25575, passwordSet: true, password: 'THIS_SHOULD_NEVER_LEAK' },
      describe: 'enable-rcon=**关**（这就是连不上的原因） · rcon.port=25575 · rcon.password=已设置',
      eula: { path: 'C:\\fake\\store\\mc-main\\eula.txt', exists: true, agreed: false },
      configPort: 25566, // ★ 与本桥接的 `servers[].port` **不一致** ⇒ mismatch.port 应为 true
      configRconPort: 25576,
      configPasswordSet: false,
      __password: 'THIS_SHOULD_NEVER_LEAK',
    }
  },
  serversPropertiesApply: async ({ serverId, serverPort, enableRcon, rconPort, password, agreeEula } = {}) => {
    if (serverId !== 's1') return { ok: false, why: `没有 id 为「${serverId}」的服务器` }
    const changed = [
      serverPort ? 'server-port' : null,
      enableRcon === true ? 'enable-rcon' : null,
      rconPort ? 'rcon.port' : null,
      password ? 'rcon.password' : null,
    ].filter(Boolean)
    return {
      ok: true,
      serverId: 's1',
      path: 'C:\\fake\\store\\mc-main\\server.properties',
      from: '归属档',
      backup: 'C:\\fake\\store\\mc-main\\server.properties.bak-2026-10-04T12-00-00-000Z',
      changed,
      settings: { serverPort: serverPort ?? 25565, enableRcon: enableRcon === true, rconPort: rconPort ?? 25575, passwordSet: Boolean(password) },
      describe: `server-port=${serverPort ?? 25565} · enable-rcon=${enableRcon === true ? '开' : '关'} · rcon.port=${rconPort ?? 25575} · rcon.password=${password ? '已设置' : '空'}`,
      // ★ EULA 只有在被要求时才回（它是**另一个文件**）
      eula:
        agreeEula === undefined
          ? null
          : {
              path: 'C:\\fake\\store\\mc-main\\eula.txt',
              backup: 'C:\\fake\\store\\mc-main\\eula.txt.bak-2026-10-04T12-00-00-000Z',
              changed: ['eula'],
              agreed: agreeEula === true,
            },
      note:
        agreeEula !== undefined && changed.length === 0
          ? '已写入 eula.txt（同意 EULA）。**下次启动服务端才生效**。'
          : '已写入 server.properties。**要重启服务端才生效** —— 那几项是它启动时读进内存的。',
      __password: 'THIS_SHOULD_NEVER_LEAK',
    }
  },
  // ★ 「把服务端那份抄过来」：返回值里**有密码**（它就是用来写 config 的）——
  //   所以这条路要用**另一个**必泄串，才能证明路由真的把它挡住了（用同一个串会假绿）。
  serversRconCredentials: async ({ serverId } = {}) => {
    if (serverId === 's2') return { ok: false, why: '服务端那份里的 rcon.password 是**空的** —— 没有可抄的。' }
    if (serverId !== 's1') return { ok: false, why: `没有 id 为「${serverId}」的服务器` }
    return {
      ok: true,
      serverId: 's1',
      path: 'C:\\fake\\store\\mc-main\\server.properties',
      from: '归属档',
      rconPort: 25575,
      password: 'COPIED-FROM-PROPERTIES-MUST-NOT-LEAK',
    }
  },
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
  check('★★★ 保存的响应里也没有密码（它只是回执，没有理由带上密钥）', !saved.text.includes('THIS_SHOULD_NEVER_LEAK'))

  // ── ④-d-2 ★★★ 更新一台时**不许把已经配好的 RCON 密码抹掉**（真事故的回归）──
  //
  // 使用者 2026-10-04 报的现象：控制台说「⚠️ 没配 RCON 密码」，但他明明填过。
  // 真机证据：`config.json.bak` 里是 5 个字符，14:02 那次写入（同一次里打开了
  // "游戏内对话"）之后变成空串。链路是：界面表单**从不回显密码**（后端只给
  // `passwordSet`）⇒ 保存时不带 `password` ⇒ 后端 `list[idx] = norm` **整条替换**
  // ⇒ `normalizeServerEntry` 把它填成 `''`，**而且不报任何错**。
  // 这里走**真实 HTTP 往返**（与 `dsh.apiKey` 那条清除 bug 同一个理由：
  // 纯函数断言当时的全绿并没有抓到它）。
  const s1pw = () => (rawConfigStub.servers.find((s) => s.id === 's1') ?? {}).password
  check('（前提）桩里 s1 现在有密码', s1pw() === 'THIS_SHOULD_NEVER_LEAK', String(s1pw()))
  const editedNoPw = await saveSrv({ server: { id: 's1', name: '主服改名' } })
  check('★ 改名那次保存 → 200', editedNoPw.status === 200, editedNoPw.text.slice(0, 140))
  check('★★★ 不带 password 地更新 ⇒ **密码原样保留**（这是使用者踩的那条）',
    s1pw() === 'THIS_SHOULD_NEVER_LEAK', String(s1pw()))
  check('★ 同一次里改的字段确实生效了（不是"整个保存被跳过"）',
    rawConfigStub.servers.find((s) => s.id === 's1')?.name === '主服改名')
  const editedEmpty = await saveSrv({ server: { id: 's1', password: '' } })
  check('★★ 显式空串 ⇒ 也是"不改"（界面没动那个框的常态）',
    editedEmpty.status === 200 && s1pw() === 'THIS_SHOULD_NEVER_LEAK', String(s1pw()))
  const editedNew = await saveSrv({ server: { id: 's1', password: 'NEW-RCON-PW' } })
  check('★ 填了新的 ⇒ 正常覆盖', editedNew.status === 200 && s1pw() === 'NEW-RCON-PW', String(s1pw()))
  const editedClear = await saveSrv({ server: { id: 's1', password: null } })
  check('★ `null` ⇒ **显式清除**（"我要删掉它"必须能表达）', editedClear.status === 200 && s1pw() === '', JSON.stringify(s1pw()))
  // 收尾：把它放回一个非空值，后面的用例（如果有依赖）不会因为空密码而改变行为
  await saveSrv({ server: { id: 's1', password: 'THIS_SHOULD_NEVER_LEAK' } })

  // ── ④-d-3 ★★★ 更新一台时**不许把表单没渲染的字段重置成默认值**（同一个使用者的第二件事）──
  //
  // 他原话：「bot反馈允许从QQ下指令的开关没开，但是我应该是打开的才对」。
  // 查下来是**同一个病**：界面上压根没有 `commandFromQQ` 这个勾选框，而保存是
  // `list[idx] = norm`（整条替换）⇒ 他每保存一次就被重置成 `false`，界面上还看不出来；
  // 他只能照 bot 说的去手改 config.json —— 手改完再保存又被抹掉。
  // ★ 同一次还会抹掉：`failThreshold` / `logEncoding` / `startWaitMs` / `rules` /
  //   `shell` / `startArgs`（全都是"手改能配、界面一保存就没了"）。
  // ★ 修法是"按字段合并"：**提交什么改什么，没提交的保持原样**。
  //   这一节就是那条纪律的回归锁 —— 断言故意用**界面确实不渲染**的几个字段。
  const s1 = () => rawConfigStub.servers.find((s) => s.id === 's1') ?? {}
  // 造一份"手改出来的"配置（模拟他当时的状态）
  Object.assign(rawConfigStub.servers.find((s) => s.id === 's1'), {
    commandFromQQ: true,
    failThreshold: 9,
    logEncoding: 'gbk',
    startWaitMs: 200000,
    shell: true,
    startArgs: ['@user_jvm_args.txt', 'nogui'],
    rules: { minTps: 12.5, maxPlayers: 40 },
  })
  check('（前提）桩里现在是一份"手改过的"配置', s1().commandFromQQ === true && s1().failThreshold === 9)
  const partial = await saveSrv({ server: { id: 's1', name: '只改名字' } })
  check('★ 只提交一个字段的保存 → 200', partial.status === 200, partial.text.slice(0, 140))
  check('★ 提交的那个字段确实改了', s1().name === '只改名字')
  check('★★★ `commandFromQQ` **原样保留**（使用者报的正是这条：他开过，不该被静默关掉）',
    s1().commandFromQQ === true, JSON.stringify({ cq: s1().commandFromQQ }))
  check('★★ 表单没渲染的其它字段也都没被重置（阈值/编码/等待/壳/参数/规则）',
    s1().failThreshold === 9 && s1().logEncoding === 'gbk' && s1().startWaitMs === 200000 &&
      s1().shell === true && JSON.stringify(s1().startArgs) === '["@user_jvm_args.txt","nogui"]' &&
      s1().rules?.minTps === 12.5,
    JSON.stringify({ ft: s1().failThreshold, enc: s1().logEncoding, args: s1().startArgs }))
  check('★★ 而**提交了**的字段照旧生效（合并不是"什么都不让改"）', (() => {
    // 上面那次保存只提交了 name ⇒ 名字必须真的变（不是"为了保住其它字段而整个不写"）
    return s1().name === '只改名字' && s1().host === '127.0.0.1'
  })(), JSON.stringify({ name: s1().name, cq: s1().commandFromQQ }))
  // ★ 反向：**显式**送 `false` 时必须真的关掉（那是用户在勾选框里真的取消了勾 —— 不能当成"没提交"）
  await saveSrv({ server: { id: 's1', commandFromQQ: false } })
  check('★★★ 显式送 `false` ⇒ **真的关掉**（合并只对"没提交"生效，不吞用户的显式意图）',
    s1().commandFromQQ === false, String(s1().commandFromQQ))
  await saveSrv({ server: { id: 's1', commandFromQQ: true } })

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

  // ── ④-d-5 服务端 `server.properties`（0.3.2 收尾）──────────────────────────
  //
  // 使用者问：「开服时显示 enable-rcon=false，能否在桥接的编辑栏直接修改」。
  // 这一节盯**接线**（纯函数那一套在 `verify-properties.mjs`）：
  //   · 字段白名单（桩里故意回带密码 ⇒ 响应里一个字符都不能有）；
  //   · **顺手把两边对齐**：写入之后 `config.json` 的 `rconPort`/`password` 必须跟着变
  //     —— 只改一半等于没修（这正是使用者报的那类"配置都填了却还是用不了"）；
  //   · 缺 serverId / 什么都不要求改 ⇒ 400（fail-closed）。
  const propsGet = async (serverId) => {
    const res = await fetch(url(`/api/servers/properties?serverId=${encodeURIComponent(serverId)}`), {
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
  const propsPost = async (body) => {
    const res = await fetch(url('/api/servers/properties'), {
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

  const noId = await propsGet('')
  check('★★ 读状态缺 serverId ⇒ 400（不猜是哪一台）', noId.status === 400, noId.text.slice(0, 120))
  const st = await propsGet('s1')
  check('★ 读状态 → 200', st.status === 200, st.text.slice(0, 140))
  check('★★★ 响应里**一个字符都没有密码**（桩里故意回带了 `__password`）',
    !st.text.includes('THIS_SHOULD_NEVER_LEAK'), st.text.slice(0, 140))
  check('★ 只给"配没配"（`passwordSet`），不给密码本身', st.json?.data?.settings?.passwordSet === true)
  check('★★ 如实回带"两边对不上"的三项（游戏端口 / RCON 端口 / 密码）',
    st.json?.data?.mismatch?.port === true && st.json?.data?.mismatch?.rconPort === true && st.json?.data?.mismatch?.password === true,
    JSON.stringify(st.json?.data?.mismatch))
  // ★★ 这一条是使用者报的「改了游戏端口也不生效」在**接线层**的回归锁：
  //    游戏端口（`server-port`）与 RCON 端口是**两件独立的事**，各自都要能看出不一致。
  check('★★★ 游戏端口与 RCON 端口**分开报**（不许混成一个"端口"）',
    st.json?.data?.settings?.serverPort === 25565 && st.json?.data?.settings?.rconPort === 25575,
    JSON.stringify(st.json?.data?.settings))
  check('★★ EULA 的状态也在同一屏里（它在**隔壁那个文件**；`agreed:false` = 服务端会拒绝启动）',
    st.json?.data?.eula?.exists === true && st.json?.data?.eula?.agreed === false, JSON.stringify(st.json?.data?.eula))
  check('★★ 回带那个**文件路径**与它的来源（"改错文件"是最坏的失败形状）',
    /server\.properties$/.test(String(st.json?.data?.path ?? '')) && String(st.json?.data?.from ?? '').length > 0,
    `${st.json?.data?.path} ← ${st.json?.data?.from}`)
  check('★ 端口如实回带（桩里是 25575）', st.json?.data?.settings?.rconPort === 25575, String(st.json?.data?.settings?.rconPort))
  // ★★ 这一条是**我自己写错又抓回来的**：`Number(null) === 0` 且 `Number.isFinite(0)` 为真 ⇒
  //    "文件里没写 rcon.port"会被回成 `0`（一个服务端会拒绝的端口），而界面上看不出区别。
  //    桩里 `s2` 就是"没写端口 + 没写 enable-rcon"那一档。
  const st2 = await propsGet('s2')
  check('★★★ 文件里没写端口 ⇒ 回 `null`，**不是 0**（`Number(null)===0` 那个坑）',
    st2.json?.data?.settings?.rconPort === null, JSON.stringify(st2.json?.data?.settings))
  check('★★ 文件里没写 `enable-rcon` ⇒ 回 `null`（**不猜成 false**）',
    st2.json?.data?.settings?.enableRcon === null, JSON.stringify(st2.json?.data?.settings))
  check('★★ 一边"不知道"时**不算不一致**（不能凭空宣称没核实过的差异）',
    st2.json?.data?.mismatch?.port === false, JSON.stringify(st2.json?.data?.mismatch))

  check('★★ 写入缺 serverId ⇒ 400', (await propsPost({ enableRcon: true })).status === 400)
  check('★★ 写入什么都不要求改 ⇒ 400', (await propsPost({ serverId: 's1' })).status === 400)
  check('★ 不认识的 serverId ⇒ 400（如实报错，不静默成功）', (await propsPost({ serverId: 'nope', enableRcon: true })).status === 400)

  const applied = await propsPost({ serverId: 's1', serverPort: 25599, enableRcon: true, rconPort: 25599, password: 'BRAND-NEW-PW' })
  check('★★ 一键配好 → 200', applied.status === 200, applied.text.slice(0, 160))
  check('★★★ 写入的响应里**也没有密码**（连回执都不带）', !applied.text.includes('BRAND-NEW-PW'), applied.text.slice(0, 160))
  check('★★ 如实回带"**要重启服务端才生效**"（界面照抄这句，别自己编）',
    /重启服务端才生效/.test(String(applied.json?.data?.note ?? '')), String(applied.json?.data?.note ?? ''))
  check('★ 回带备份路径（写坏了能回退）', /\.bak-/.test(String(applied.json?.data?.backup ?? '')), String(applied.json?.data?.backup ?? ''))
  check('★★★ **顺手把 config.json 也对齐了**（只改服务端那份等于没修）', (() => {
    const row = rawConfigStub.servers.find((s) => s.id === 's1') ?? {}
    return row.port === 25599 && row.rconPort === 25599 && row.password === 'BRAND-NEW-PW'
  })(), JSON.stringify({ port: s1().port, rconPort: s1().rconPort, pwLen: String(s1().password ?? '').length }))
  check('★ 同步结果也如实回带', applied.json?.data?.synced?.ok === true, JSON.stringify(applied.json?.data?.synced))
  check('★★ 字段白名单：返回里没有依赖塞进来的 `__password`',
    st.json?.data?.__password === undefined && applied.json?.data?.__password === undefined)
  check('★★ 只要求改游戏端口也行（不必每次都连 RCON 那几项一起送）', (await propsPost({ serverId: 's1', serverPort: 25600 })).status === 200)

  // ── EULA：同意条款那一条（`{serverId, agreeEula:true}` ⇒ 写隔壁的 eula.txt）──────────
  const eula = await propsPost({ serverId: 's1', agreeEula: true })
  check('★★ 同意 EULA → 200', eula.status === 200, eula.text.slice(0, 140))
  check('★★★ 回带**写的是哪个文件**、备份、以及"已同意"（这是一条**同意条款**的动作，要说清）',
    /eula\.txt$/.test(String(eula.json?.data?.eula?.path ?? '')) && eula.json?.data?.eula?.agreed === true,
    JSON.stringify(eula.json?.data?.eula))
  check('★★ 回带的那句是"**下次启动服务端才生效**"（不是"已经生效"）',
    /才生效/.test(String(eula.json?.data?.note ?? '')), String(eula.json?.data?.note ?? ''))
  check('★★ EULA 那条**不碰** RCON 密码（各自独立；不许因为顺路就把密码写一遍）',
    s1().password === 'BRAND-NEW-PW', `len=${String(s1().password ?? '').length}`)
  check('★ 与 EULA 无关的项也没被顺手改掉（`port` 还是上一步写的 25600）', s1().port === 25600, String(s1().port))

  // ── ④-d-6 「把服务端那份抄过来」（零重启对齐两边；使用者问「rcon 密码被忘记了怎么办」）──
  //
  // 这条路的价值：密码明文存在两边，而**服务端那份是权威** ⇒ 只要它还在，抄过来就行，
  // **一次重启都不用**（改服务端那份才要重启、还会踢在线玩家）。
  // ★ 它必须做到"**不用看到密码也能对齐**"：密码只在我们进程内存里走一趟（读文件 → 写 config），
  //   任何响应都不带它出门 —— 所以桩里用的是**另一个**必泄串，才能证明白名单真的挡住了它。
  check('（准备）先把这一台的密码清掉，模拟"忘了/没配"', await (async () => {
    const r = await saveSrv({ server: { id: 's1', password: null } })
    return r.status === 200 && s1().password === ''
  })())
  const adopted = await propsPost({ serverId: 's1', adoptFromFile: true })
  check('★★ 抄过来 → 200', adopted.status === 200, adopted.text.slice(0, 160))
  check('★★★ 响应里**没有那个密码**（桩里塞的是 `COPIED-FROM-PROPERTIES-MUST-NOT-LEAK`）',
    !adopted.text.includes('COPIED-FROM-PROPERTIES-MUST-NOT-LEAK'), adopted.text.slice(0, 160))
  check('★★★ 也**不说长度**（长度也是信息）', !/长度|位/.test(String(adopted.json?.data?.adopted === undefined ? '' : JSON.stringify(adopted.json.data.adopted))),
    JSON.stringify(adopted.json?.data?.adopted))
  check('★★★ 密码**真的写进了 config.json**（否则"抄过来"是假的）',
    s1().password === 'COPIED-FROM-PROPERTIES-MUST-NOT-LEAK', `len=${String(s1().password ?? '').length}`)
  check('★ 端口也一起对齐（文件里写了端口时）', s1().rconPort === 25575, String(s1().rconPort))
  check('★★ 如实说"**不必重启服务端**"（这是它与"写入"那条路的关键区别）',
    adopted.json?.data?.restartNeeded === false && /不必重启/.test(String(adopted.json?.data?.note ?? '')),
    String(adopted.json?.data?.note ?? ''))
  check('★★★ 服务端那份里**没有密码**时如实拒绝（没有可抄的 ⇒ 得设一个新的）',
    (await propsPost({ serverId: 's2', adoptFromFile: true })).status === 400)
  check('★ 抄之前那一台**啥都没动**（失败不留半个状态）', (() => {
    const row = rawConfigStub.servers.find((s) => s.id === 's2') ?? {}
    return !row.password
  })())

  // ── ④-e 主动检测（`POST /api/servers/probe`）与实时后台（`GET /api/servers/console`）──
  const probe = async (body) => {
    const res = await fetch(url('/api/servers/probe'), {
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
  check('★★ 主动检测缺 serverId ⇒ 400（不猜是哪一台）', (await probe({})).status === 400)
  const probed = await probe({ serverId: 's1' })
  check('★ 主动检测 → 200 且回带 snapshot', probed.status === 200 && probed.json?.data?.snapshot?.reachable === true, probed.text.slice(0, 120))
  check('★★★ 检测结果标了 `probed: true`（与后台采样那一份区分开 —— 它不参与 up/down 判定）',
    probed.json?.data?.snapshot?.probed === true)
  check('★★★ 主动检测响应里也**一个字符都没有密码**', !probed.text.includes('THIS_SHOULD_NEVER_LEAK'))
  check('★ 不认识的 serverId 如实报错', (await probe({ serverId: 'nope' })).status === 400)

  const consoleRes = await fetch(url('/api/servers/console?serverId=s1&limit=10'), { signal: AbortSignal.timeout(15_000) })
  const consoleText = await consoleRes.text()
  const consoleJson = JSON.parse(consoleText)
  check('★ 实时后台 → 200 且回带文本行', consoleRes.status === 200 && Array.isArray(consoleJson?.data?.lines) && consoleJson.data.lines.length === 2)
  check('★★★ **如实回带编码**（真机那个文件是 `gbk` —— 按 UTF-8 读会全是替换字符）',
    consoleJson?.data?.encoding === 'gbk', String(consoleJson?.data?.encoding))
  check('★ 中文行**没有被破坏**（桩里回的是"你好"）', consoleText.includes('你好') || JSON.stringify(consoleJson.data.lines).includes('你好'))
  check('★★★ 实时后台响应里也**一个字符都没有密码**', !consoleText.includes('THIS_SHOULD_NEVER_LEAK'))
  const consoleNoId = await fetch(url('/api/servers/console'), { signal: AbortSignal.timeout(15_000) })
  check('★★ 实时后台缺 serverId ⇒ 400（不猜）', consoleNoId.status === 400)
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

// ══════════════════════════════════════════════════════════════════════════
section('⑥ ★★★ 界面产物不在时那一页必须**可操作**（新设备真机反馈的回归锁）')
// ══════════════════════════════════════════════════════════════════════════
{
  // 真机形状：使用者换了一台新设备（多半是拷贝/解压没带上 `config-ui/dist`），
  // 打开控制台只看到一句裸 JSON `{"ok":false,"error":"控制台界面未构建（缺少 config-ui/dist）"}`
  // —— 它既没说"我看的是哪条路径"，也没说"现在该怎么办"。
  // 这里用一个**不存在的 dist 目录**起一个真服务，按浏览器的方式请求一次。
  const missingDist = join(TMP, 'no-such-config-ui-dist')
  const uiServer = await serveApi({
    port: 0,
    handler: async () => null,
    staticDir: missingDist,
    log: (m) => logs.push(String(m)),
  })
  const res = await fetch(`http://127.0.0.1:${uiServer.port}/`, { signal: AbortSignal.timeout(10_000) })
  const body = await res.text()
  const ctype = String(res.headers.get('content-type') ?? '')

  check('仍然是 404（这个资源确实不存在，不假装成功）', res.status === 404, String(res.status))
  check('★★ 回的是 HTML，而不是一句裸 JSON', ctype.includes('text/html'), ctype)
  check('★★★ 写出**它找的是哪条路径**（不写出来就只能猜是"没拷"还是"拷错地方"）',
    body.includes(missingDist), missingDist)
  check('★★ 点出最可能的原因：这次拷贝/解压没带上 config-ui/dist',
    body.includes('config-ui/dist') && body.includes('拷贝'))
  check('★★ 给出"自己构建"那条修法（cd config-ui && npm install && npm run build）',
    body.includes('npm run build') && body.includes('npm install'))
  check('★ 给出"用发布包"那条修法（Releases）', /releases/i.test(body))
  check('★ 指向两个自查入口 --check / --ui', body.includes('--check') && body.includes('--ui'))
  check('★ 如实说明它不影响回话（不吓人，也不装作没事）', body.includes('不影响机器人回话'))
  // ★ 路径要转义（目录名里可能有 & < >）—— 注入面虽小，但"回显用户输入"就该按规矩来
  check('★★ 路径经过 HTML 转义（不把目录名当标记渲染）', !/<script/i.test(body))
  await uiServer.close()
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
