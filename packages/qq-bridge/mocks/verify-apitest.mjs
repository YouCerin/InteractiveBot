#!/usr/bin/env node
/**
 * 新增接口的集成测试（注入**真实依赖**，走完整 API handler）。
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────────────
 * `verify-api.mjs` 用的是"不注入依赖"的 handler，所以它验的是
 * **`notImplemented` 兜底分支**。接口实现落地后那些断言**照样通过** ——
 * 也就是说它们变成了**假绿**：真正的实现一次都没被执行过。
 *
 * 这个文件补上那个洞：把 priceBook / usageLedger / memoryStore 真的造出来
 * 注入进去，从 HTTP 请求的形状一路验到磁盘上的结果。
 *
 * 它同时是本项目里**唯一会真的写盘**的接口测试，所以：
 *   · 全程在 `.tmp-apitest/` 里操作，结束时删掉；
 *   · 账本/工作区都是临时的，**不碰真实的 logs/ 与 workspace-qq/**。
 *
 * 用法：node mocks/verify-apitest.mjs
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createApiHandler } from '../src/api.mjs'
import { normalizeConfig, validateConfig } from '../src/config.mjs'
import { createPriceBook, computePeriod } from '../src/prices.mjs'
import { createUsageLedger } from '../src/usage.mjs'
import { createMemoryStore } from '../src/memory-files.mjs'
import { createSnowlumaLogReader } from '../src/snowluma-log.mjs'
import { createRoster as realCreateRoster } from '../src/roster.mjs'
import { startSnowluma as realStartSnowluma, probeConsole, openSnowlumaConsole as realOpenConsole, resolveOnebotTokens, readSnowlumaTokens, makeLaunchDetect } from '../src/snowluma.mjs'
import { PKG_ROOT } from '../src/local.mjs'

/** 起一个只回 HTML 的本地服务器，冒充 SnowLuma 控制台（验"已经在跑"那条分支）。 */
async function startFakeConsole(title = 'SnowLuma 控制台') {
  const { createServer } = await import('node:http')
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>${title}</title></head><body>ok</body></html>`)
  })
  let closed = false
  server.unref() // ⚠️ 不加这句会在退出时触发 libuv 断言（见下方 close 的注释）
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  // keep-alive 连接必须一起断掉，否则 server.close() 等不到回调，
  // 而进程退出时那些仍在关闭中的句柄会让 libuv 断言失败
  // （`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，
  //   同一家族的坑还有一个：rmSync 静默失败）。
  server.on('connection', (socket) => socket.unref())
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise((r) => {
        if (closed) return r()
        closed = true
        try {
          server.closeAllConnections?.()
        } catch {
          /* 旧版本没有这个方法 */
        }
        server.close(() => r())
      }),
  }
}

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

const TMP = join(PKG_ROOT, '.tmp-apitest')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const WS = join(TMP, 'ws')
mkdirSync(WS, { recursive: true })
writeFileSync(join(WS, 'MEMORY.md'), '# 记忆索引\n\n- 管理员私聊：QQ 100000001\n', 'utf8')

/** 一份最小可用配置。 */
const RAW = {
  dsh: { provider: 'deepseek-official', model: 'deepseek-flash', workspace: WS },
  onebot: { wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', wsToken: 'T', httpToken: 'T' },
  access: { adminUsers: ['100000001'] },
  ui: { apiPort: 3410 },
}

function makeHandler() {
  const priceBook = createPriceBook({ file: join(PKG_ROOT, 'prices.json') })
  const usageLedger = createUsageLedger({ file: join(TMP, 'usage.jsonl'), priceBook })
  const memoryStore = createMemoryStore({ workspace: WS })
  const state = {
    restarted: 0,
    stopped: 0,
    launchCmd: '',
    installDir: '',
    consoleUrl: 'http://127.0.0.1:1/',
    // 桥接自己的连接状态（喂给 startSnowluma 的 detect）
    detectStatus: 'offline',
    httpReachable: false,
    // 按钮（打开网页端）用
    consoleReachable: true,
    openedUrls: [],
  }
  const handler = createApiHandler({
    configPath: join(TMP, 'config.json'),
    readRawConfig: () => JSON.parse(JSON.stringify(RAW)),
    writeRawConfig: () => {},
    normalize: normalizeConfig,
    validate: validateConfig,
    getStatus: () => ({ running: true }),
    getConversations: () => [],
    priceBook,
    usageLedger,
    memoryStore,
    // 雪露马探测没法在离线测试里真连，所以只验"注入了就不会回 501"。
    // `state.detectStatus` 让用例可以切换桥接连接状态（验证"已在跑"与"令牌被拒"两条分支）。
    detectSnowluma: async () => ({
      status: state.detectStatus,
      httpReachable: state.httpReachable,
      wsConnected: state.detectStatus === 'connected',
      loggedIn: state.detectStatus === 'connected',
      login: state.detectStatus === 'connected' ? { userId: '1', nickname: 'x' } : null,
      endpoint: { httpUrl: RAW.onebot.httpUrl, wsUrl: RAW.onebot.wsUrl },
      consoleUrl: state.consoleUrl,
      launch: { configured: false, cmd: null, cwd: null },
      hint: '测试桩',
    }),
    startSnowluma: () =>
      realStartSnowluma({
        config: {
          snowluma: {
            launchCmd: state.launchCmd,
            launchCwd: '',
            installDir: state.installDir,
            consoleUrl: state.consoleUrl,
            probeTimeoutMs: 800,
          },
        },
        // ⚠️ **必须注入 locateSnowluma**，不能让测试走自动发现。
        //
        // 踩过一次：`launchCmd` 留空时实现会自动去磁盘找 SnowLuma，而本机真的有
        // 两个安装 —— 于是测试**启动了一个真实的 SnowLuma 进程**（PID 6752），
        // 还差点和正在跑的那个抢 3000 端口。
        //
        // 测试永远不该启动真实的外部程序。所以这里用一个受控的假发现：
        // 只认 state.installDir 指向的临时目录。
        locateSnowluma: ({ installDir }) =>
          installDir && existsSync(join(installDir, 'launcher.bat'))
            ? { cmd: join(installDir, 'launcher.bat'), cwd: installDir, kind: 'bat', from: '测试注入' }
            : { cmd: null, cwd: null, kind: null, from: null },
        // 同理：不要让测试用真实 node 解析逻辑
        findNode: () => process.execPath,
        // 这个 detect 是"桥接自己的连接状态"那条判据。
        // 默认给 offline，这样流程会走到路径校验那一步。
        detect: async () => ({
          status: state.detectStatus,
          httpReachable: state.httpReachable,
        }),
      }),
    // 界面按钮：**只打开 SnowLuma 的网页端**（不再启动进程）。
    // 注入一个假的 openBrowser，免得测试真的弹出一个浏览器窗口。
    openSnowlumaConsole: () =>
      realOpenConsole({
        config: { snowluma: { consoleUrl: state.consoleUrl, probeTimeoutMs: 800 } },
        // 控制台探测也注入：否则测试会去真连 5099
        probe: async (url) =>
          state.consoleReachable ? { reachable: true, title: 'SnowLuma 控制台' } : { reachable: false, error: '测试桩：不可达' },
        openBrowser: (url) => {
          state.openedUrls.push(url)
          return Promise.resolve()
        },
      }),
    // 界面"终端"面板用的日志读取器（指向一个真实的临时日志目录）
    snowlumaLog: createSnowlumaLogReader({ installDir: join(TMP, 'sl-log') }),
    requestRestart: () => {      state.restarted += 1
    },
    requestStop: () => {
      state.stopped += 1
    },
    powerActionDelayMs: 0,
  })
  return { handler, priceBook, usageLedger, memoryStore, state }
}

const { handler, usageLedger, memoryStore, state } = makeHandler()

// ══════════ 用量与价目表 ══════════
section('GET /api/usage/prices（顶部时段指示灯的数据源）')
{
  const res = await handler({ method: 'GET', path: '/api/usage/prices' })
  check('返回 200（不再是 501）', res.status === 200, `实际 ${res.status}`)
  const d = res.body.data
  check('loaded = true', d.loaded === true)
  check('★ 带 peak 规则段（界面用它按浏览器时间算时段）',
    Array.isArray(d.peak?.windows) && d.peak.windows.length === 2, JSON.stringify(d.peak?.windows))
  check('peak 带 timezone / days / holidays',
    typeof d.peak.timezone === 'string' && Array.isArray(d.peak.days) && Array.isArray(d.peak.holidays))
  check('★ now 带 indicator 与 holidaysKnown（排查时钟用）',
    typeof d.now?.indicator === 'string' && typeof d.now?.holidaysKnown === 'boolean',
    `${d.now?.indicator} / holidaysKnown=${d.now?.holidaysKnown}`)
  check('now 与 computePeriod 结果一致（同一套规则）',
    d.now.period === computePeriod(d.peak, new Date(d.now.at)).period,
    `${d.now.period} vs ${computePeriod(d.peak, new Date(d.now.at)).period}`)
  check('★ holidays 为空时有 warning（不假装精确）',
    d.peak.holidays.length > 0 || /节假日/.test(String(d.warning)), String(d.warning).slice(0, 40))
}

section('GET /api/usage（用量卡片）')
{
  const empty = await handler({ method: 'GET', path: '/api/usage?days=7' })
  check('空账本返回 200 且结构完整', empty.status === 200 && empty.body.data.byDay.length === 0)
  check('★ 空账本时 available 为 false（而不是"花了 0 元"）',
    empty.body.data.cost.available === false && empty.body.data.cost.amount === null,
    JSON.stringify(empty.body.data.cost))
  check('★ 空账本时 cacheHitRate 为 null（不是 0）', empty.body.data.totals.cacheHitRate === null)

  // 写两条真实形状的记录：一条高峰、一条周末
  usageLedger.record({
    at: new Date('2026-09-25T10:00:00+08:00'), // 周五 10:00 = 高峰
    chatKey: 'private:100000001', kind: 'private', label: '私聊 100000001',
    route: 'deepseek-official/deepseek-flash',
    tokens: { input: 25049, cacheRead: 223744, output: 3625, reasoning: 1000 },
    lastContextTokens: 34709,
  })
  usageLedger.record({
    at: new Date('2026-09-26T10:00:00+08:00'), // 周六 = 空闲
    chatKey: 'group:700000002', kind: 'group', label: '群 700000002',
    route: 'deepseek-official/deepseek-flash',
    tokens: { input: 1000, cacheRead: 2000, output: 500 },
    lastContextTokens: 4000,
  })

  const res = await handler({ method: 'GET', path: '/api/usage?days=0' })
  const d = res.body.data
  check('全部范围返回 2 回合', d.totals.turns === 2, String(d.totals.turns))
  check('按天 2 条、新的在前', d.byDay.length === 2 && d.byDay[0].date > d.byDay[1].date,
    d.byDay.map((x) => x.date).join(','))
  check('按会话 2 条且带 label/kind',
    d.bySession.length === 2 && d.bySession.every((s) => s.label && s.kind), JSON.stringify(d.bySession.map((s) => s.label)))
  check('★ 命中率 = cacheRead/(input+cacheRead)',
    Math.abs(d.totals.cacheHitRate - 225744 / (26049 + 225744)) < 1e-6, String(d.totals.cacheHitRate))
  check('★ 成本 available 且为两条之和',
    d.cost.available === true && d.cost.amount > 0, String(d.cost.amount))
  check('★ 成本带 basis（可追溯计价依据）',
    typeof d.cost.basis === 'string' && d.cost.basis.includes('prices.json'), String(d.cost.basis))
  check('★ reasoning 不在 output 里重复计（output 仍是 3625+500）',
    d.totals.tokens.output === 4125, String(d.totals.tokens.output))
  check('★ lastContextTokens 取最后一条的快照（不累加）',
    d.totals.lastContextTokens === 4000, String(d.totals.lastContextTokens))

  // days 解析：0 必须是"全部"，不能被 || 兜成 7
  const d7 = await handler({ method: 'GET', path: '/api/usage?days=7' })
  check('★ days=0 不被当成假值兜成 7', d.totals.turns >= d7.body.data.totals.turns)
  const dBad = await handler({ method: 'GET', path: '/api/usage?days=abc' })
  check('days 非法时回落到 7 而不是崩', dBad.status === 200 && dBad.body.data.range.days === 7,
    String(dBad.body.data.range.days))
  const dNone = await handler({ method: 'GET', path: '/api/usage' })
  check('不带 days 默认 7', dNone.body.data.range.days === 7, String(dNone.body.data.range.days))
}

section('GET /api/snowluma/detect')
{
  const res = await handler({ method: 'GET', path: '/api/snowluma/detect' })
  check('返回 200（不再是 501）', res.status === 200, `实际 ${res.status}`)
  check('状态是约定里的六种之一',
    ['not-configured', 'bridge-offline', 'offline', 'up-not-logged-in', 'auth-failed', 'connected']
      .includes(res.body.data.status), res.body.data.status)
  check('带 endpoint 与 launch（界面要显示地址与按钮启用条件）',
    res.body.data.endpoint?.httpUrl === RAW.onebot.httpUrl && res.body.data.launch?.configured === false)
}

section('POST /api/snowluma/start（按钮：打开 SnowLuma 网页端）')
{
  // ★ 用的是**真实的 openSnowlumaConsole**，只注入了假浏览器 ——
  //   测试绝不能真的弹出窗口。
  state.openedUrls = []
  state.consoleReachable = true
  state.consoleUrl = 'http://127.0.0.1:5099/'

  const res = await handler({ method: 'POST', path: '/api/snowluma/start' })
  check('返回 200 且 opened=true', res.status === 200 && res.body.data.opened === true,
    JSON.stringify(res.body.data ?? res.body))
  check('★ 真的调用了"打开浏览器"，且打开的是配置里的 consoleUrl',
    state.openedUrls.length === 1 && state.openedUrls[0] === 'http://127.0.0.1:5099/',
    JSON.stringify(state.openedUrls))
  check('带回 reachable（界面据此区分"打开了"和"那边其实没在跑"）',
    res.body.data.reachable === true, String(res.body.data.reachable))
  check('可达时 hint 说"已打开网页端"', /已打开/.test(String(res.body.data.hint)), String(res.body.data.hint))

  // ★ 最重要的一条：打开了浏览器 ≠ SnowLuma 在跑。必须如实说，否则使用者
  //   会以为"我点了按钮就该好了"，然后对着一个打不开的页面发呆。
  state.openedUrls = []
  state.consoleReachable = false
  const notUp = await handler({ method: 'POST', path: '/api/snowluma/start' })
  check('★ 网页端不可达时仍尝试打开（浏览器总能开），但 reachable=false',
    notUp.status === 200 && notUp.body.data.reachable === false && state.openedUrls.length === 1,
    JSON.stringify(notUp.body.data))
  check('★★ 不可达时 hint 明确说明"它没跑时网页端也不存在"（不假装成功）',
    /没在运行|不存在|先启动/.test(String(notUp.body.data.hint)), String(notUp.body.data.hint))

  state.consoleReachable = true
}

section('令牌来源：以 SnowLuma 自己的配置为准')
{
  // 为什么要这段：token 存在两处必然漂移，而漂移的症状是
  // 「令牌被拒」+ **机器人完全不说话**。这里钉住解析优先级。
  const WS2 = join(TMP, 'sl')
  mkdirSync(join(WS2, 'config'), { recursive: true })
  writeFileSync(
    join(WS2, 'config', 'onebot_123456.json'),
    JSON.stringify({
      networks: {
        httpServers: [{ accessToken: 'FROM-SNOWLUMA-HTTP' }],
        wsServers: [{ accessToken: 'FROM-SNOWLUMA-WS' }],
      },
    }),
    'utf8',
  )

  const got = readSnowlumaTokens({ installDir: WS2, selfId: '123456' })
  check('★ 能从 SnowLuma 的 config/onebot_<uin>.json 读到 token',
    got.httpToken === 'FROM-SNOWLUMA-HTTP' && got.wsToken === 'FROM-SNOWLUMA-WS',
    JSON.stringify(got))

  const resolved = resolveOnebotTokens({
    config: { onebot: { httpToken: 'STALE', wsToken: 'STALE' }, selfId: '123456' },
    installDir: WS2,
  })
  check('★★ SnowLuma 的 token 优先于 config.json（漂移时不再用它）',
    resolved.httpToken === 'FROM-SNOWLUMA-HTTP' && resolved.wsToken === 'FROM-SNOWLUMA-WS',
    JSON.stringify(resolved))
  check('★ 并且如实标注"与 config.json 不一致"（这是排查 401 的关键线索）',
    resolved.differsFromConfig === true, String(resolved.differsFromConfig))

  // 找不到 SnowLuma 配置时回退到 config.json（老配置仍能用）
  const fallback = resolveOnebotTokens({
    config: { onebot: { httpToken: 'CFG-HTTP', wsToken: 'CFG-WS' } },
    installDir: join(TMP, 'nope'),
  })
  check('找不到 SnowLuma 配置时回退到 config.json',
    fallback.httpToken === 'CFG-HTTP' && fallback.source === 'config.json',
    JSON.stringify(fallback))
}

section('startSnowluma 本体（start.bat 用它，不再是界面按钮）')
{
  // ★ 这里用的是**真实的 startSnowluma**，不是桩 —— 桩测不出真实文案与分支。
  // state.consoleUrl 默认指向 127.0.0.1:1（必然连不上），所以会走到"启动进程"那半步。

  const res = await handler({ method: 'POST', path: '/api/snowluma/start' })
  check('（按钮已改为打开网页端 → 这里只验它不再启动进程）',
    res.status === 200 && res.body.data.opened === true && !('started' in res.body.data),
    JSON.stringify(res.body.data))

  // 直接调 startSnowluma 本体（start.bat 的路径）
  const noCmd = await realStartSnowluma({
    config: { snowluma: { launchCmd: '', installDir: '', consoleUrl: 'http://127.0.0.1:1/', probeTimeoutMs: 600 } },
    locateSnowluma: () => ({ cmd: null, cwd: null, kind: null, from: null }),
    findNode: () => process.execPath,
    detect: async () => ({ status: 'offline', httpReachable: false }),
  })
  check('★ 都连不上 + 没找到安装时回 400（不假装成功）',
    noCmd.ok === false && noCmd.status === 400, JSON.stringify(noCmd))
  check('★ 错误文案同时交代「都连不上」与「该往哪放/配什么」',
    /launchCmd/.test(String(noCmd.error)) && /consoleUrl|控制台/.test(String(noCmd.error)),
    String(noCmd.error))

  const missing = await realStartSnowluma({
    config: { snowluma: { launchCmd: join(TMP, 'does-not-exist.bat'), consoleUrl: 'http://127.0.0.1:1/', probeTimeoutMs: 600 } },
    locateSnowluma: () => ({ cmd: null, cwd: null, kind: null, from: null }),
    findNode: () => process.execPath,
  })
  check('路径不存在时回 400 且说明路径', missing.ok === false && /不存在/.test(String(missing.error)),
    String(missing.error))

  const isDir = await realStartSnowluma({
    config: { snowluma: { launchCmd: TMP, consoleUrl: 'http://127.0.0.1:1/', probeTimeoutMs: 600 } },
    locateSnowluma: () => ({ cmd: null, cwd: null, kind: null, from: null }),
    findNode: () => process.execPath,
  })
  check('★ 填成文件夹时明确提示"要填文件"', isDir.ok === false && /文件夹/.test(String(isDir.error)),
    String(isDir.error))

  // ★ 真发起启动（.mjs 分支）
  //
  // 为什么用 .mjs 而不是 .bat：`.bat` 必须 `shell: true`，在测试里会真的拉起
  // cmd.exe 解析一个批处理文件 —— 那正是上一次"测试启动了真实 SnowLuma"的来源。
  // `.mjs` 只是"用 node 跑一个文件"，用一个立刻退出的脚本就完全可控。
  const fakeScript = join(TMP, 'fake-snowluma.mjs')
  writeFileSync(fakeScript, 'process.exit(0)\n', 'utf8')
  const spawned = await realStartSnowluma({
    config: { snowluma: { launchCmd: fakeScript, consoleUrl: 'http://127.0.0.1:1/', probeTimeoutMs: 600 } },
    locateSnowluma: () => ({ cmd: null, cwd: null, kind: null, from: null }),
    findNode: () => process.execPath,
    detect: async () => ({ status: 'offline', httpReachable: false }),
  })
  check('★ 真发起启动时 started=true 且给出 pid',
    spawned.ok === true && spawned.data.started === true && spawned.data.pid > 0,
    JSON.stringify(spawned.data ?? spawned))
  check('★ .mjs 入口会带上用哪个 node 跑它（.bat 则为 null）',
    typeof spawned.data.node === 'string' && spawned.data.node.length > 0, String(spawned.data.node))
  check('交代入口来源（排查时不用猜配置生效没有）',
    spawned.data.discoveredBy === 'config.snowluma.launchCmd', String(spawned.data.discoveredBy))

  // ★ 已在跑 → 不重复启动（否则开出第二个实例，抢 3000 端口和登录态）
  const fake = await startFakeConsole()
  try {
    const already = await realStartSnowluma({
      config: { snowluma: { launchCmd: '', consoleUrl: fake.url, probeTimeoutMs: 900 } },
      locateSnowluma: () => ({ cmd: null, cwd: null, kind: null, from: null }),
      findNode: () => process.execPath,
    })
    check('★ 控制台已在时返回 alreadyRunning（不重复启动）',
      already.ok === true && already.data.alreadyRunning === true && already.data.started === false,
      JSON.stringify(already.data))
    check('顺带读出控制台标题（证明那真是控制台，不是端口上别的服务）',
      already.data.consoleTitle === 'SnowLuma 控制台', String(already.data.consoleTitle))
  } finally {
    await fake.close()
  }

  // ★★ 回归：令牌被拒时必须继续往下走去启动
  //
  // 真实事故：某个**错误的** SnowLuma 实例占着 3000 端口时，`httpReachable` 是 true
  // —— 若判据用它，就会认定"已在跑"、**永远不去启动正确的那份**，
  // 界面卡在「令牌被拒」再无出路。正确判据是桥接**自己**连上了没有。
  const fakeScript2 = join(TMP, 'fake-snowluma-2.mjs')
  writeFileSync(fakeScript2, 'process.exit(0)\n', 'utf8')
  const authFailed = await realStartSnowluma({
    config: { snowluma: { launchCmd: fakeScript2, consoleUrl: 'http://127.0.0.1:1/', probeTimeoutMs: 600 } },
    locateSnowluma: () => ({ cmd: null, cwd: null, kind: null, from: null }),
    findNode: () => process.execPath,
    // httpReachable 为真（模拟错实例占端口），但桥接自己没连上
    detect: async () => ({ status: 'auth-failed', httpReachable: true }),
  })
  check('★★ 令牌被拒时【不】判定"已在跑"，而是继续去启动（否则卡死无出路）',
    authFailed.ok === true && authFailed.data.started === true,
    JSON.stringify(authFailed.data ?? authFailed))

  // ★★ "在跑但没登录"也必须短路（**不能**再去 spawn 第二个实例）
  //
  // 以前只有 CONNECTED 会短路，UP_NOT_LOGGED_IN 会掉到下面去 spawn ——
  // 那会开出第二个实例（端口冲突、抢登录态），而正确做法是让使用者去控制台扫码。
  // "一个进程没登录"和"一个进程没在跑"是两件事，不能混。
  const notLoggedIn = await realStartSnowluma({
    config: { snowluma: { launchCmd: fakeScript2, consoleUrl: 'http://127.0.0.1:1/', probeTimeoutMs: 600 } },
    locateSnowluma: () => ({ cmd: null, cwd: null, kind: null, from: null }),
    findNode: () => process.execPath,
    detect: async () => ({ status: 'up-not-logged-in', httpReachable: true }),
  })
  check('★★ "在跑但没登录"→ 不重复启动（提示去控制台登录，而不是再开一个实例）',
    notLoggedIn.ok === true && notLoggedIn.data.started === false && notLoggedIn.data.alreadyRunning === true,
    JSON.stringify(notLoggedIn.data ?? notLoggedIn))
  check('★ 那条提示要明说「不要再启动一个」',
    /不要再启动一个/.test(String(notLoggedIn.data?.hint)) && /登录/.test(String(notLoggedIn.data?.hint)),
    String(notLoggedIn.data?.hint))

  // ★★ 漏传 detect 的后果（把代价钉下来）
  //
  // 这条不是为了"证明代码对"，而是为了**记录这个 API 的危险性**：
  // 第②步完全依赖调用方传 detect，不传就静默失效。
  // 真实发生过 —— `start.bat` 走的 `--snowluma` 分支就漏传过。
  // 结构层面的"每一处调用都传了"由 verify-manifest.mjs 盯着；
  // 这里只把"漏传时确实会启动"这个事实写清楚，免得以后有人以为漏传也没事。
  const noDetect = await realStartSnowluma({
    config: { snowluma: { launchCmd: fakeScript2, consoleUrl: 'http://127.0.0.1:1/', probeTimeoutMs: 600 } },
    locateSnowluma: () => ({ cmd: null, cwd: null, kind: null, from: null }),
    findNode: () => process.execPath,
    // 故意不传 detect
  })
  check('★ 漏传 detect 时第②步确实被静默跳过（会真的去启动）—— 这就是必须传的理由',
    noDetect.ok === true && noDetect.data.started === true,
    JSON.stringify(noDetect.data ?? noDetect))

  // ★ makeLaunchDetect：两条路共用的那一份实现
  const factory = makeLaunchDetect({ config: { snowluma: {} }, log: () => {} })
  check('makeLaunchDetect 返回一个函数', typeof factory === 'function')
  const viaFactory = await factory()
  check('★ 工厂产出的探测函数真的会去探（拿得到 status 字段）',
    typeof viaFactory?.status === 'string', JSON.stringify(viaFactory?.status ?? viaFactory))
}

section('★★ 「启动了错的那份 SnowLuma」——两个真实事故的回归测试')
{
  // ── 背景（2026-09-26，症状＝机器人不在线、OneBot 全部 401）──────────────
  //
  // 桥接在 3000/3001 上拿到的一律是 401，而 config.json 里的 token 明明和
  // **项目里那份** SnowLuma 的 token 完全一致。真相是：跑起来的是
  // `D:\QQagent_DeepSeek\snowluma`（另一份安装，另一套 token）。
  //
  // 两个缺陷叠加才造成这件事，所以下面各有测试：
  //   ① `startSnowluma` 的默认 `locateSnowluma` 写成 `() => findSnowluma()`，
  //      **把 `{ installDir }` 参数丢掉了** → `snowluma.installDir` 形同虚设，
  //      `findSnowluma()` 一路走到候选表最后的 D: 兜底。
  //   ② 设了 `launchCmd` 时 `cwd` 取的是 `locate.cwd`（= 发现到的安装目录），
  //      而不是**入口自己所在的目录**。于是 `launcher.bat` 里的
  //      `node ./index.mjs`（相对路径）在错的目录里解析 → 真的跑了那份的代码。
  //      父进程命令行里那个 `launcher.bat` 路径**看起来完全正确**，
  //      这就是它极难被发现的原因。

  // 造两份"假 SnowLuma 安装"：各自有一个 index.mjs
  const fakeA = join(TMP, 'fake-snowluma-A')
  const fakeB = join(TMP, 'fake-snowluma-B')
  mkdirSync(fakeA, { recursive: true })
  mkdirSync(fakeB, { recursive: true })
  const scriptA = join(fakeA, 'index.mjs')
  const scriptB = join(fakeB, 'index.mjs')
  writeFileSync(scriptA, 'process.exit(0)\n', 'utf8')
  writeFileSync(scriptB, 'process.exit(0)\n', 'utf8')

  // ① installDir 必须被真的用上（不能因为默认实现丢参数而落到别的安装）
  const byInstallDir = await realStartSnowluma({
    config: { snowluma: { installDir: fakeA, launchCmd: '', consoleUrl: 'http://127.0.0.1:1/', probeTimeoutMs: 500 } },
    findNode: () => process.execPath,
    detect: async () => ({ status: 'offline' }),
    // ★ 这里**故意不注入** locateSnowluma —— 测的就是那个默认实现
  })
  check('★★ 自动发现真的用了 snowluma.installDir（默认实现没把参数丢掉）',
    byInstallDir.ok === true && byInstallDir.data.cmd === scriptA,
    `cmd=${byInstallDir.data?.cmd}  期望=${scriptA}`)
  check('★ 工作目录也是那一份（否则 .bat 里的相对路径会跑到别处）',
    byInstallDir.data.cwd === fakeA, String(byInstallDir.data?.cwd))
  check('交代来源是配置的 installDir，而不是兜底位置',
    byInstallDir.data.discoveredBy === 'snowluma.installDir', String(byInstallDir.data.discoveredBy))

  // ② 显式给了 launchCmd 时，工作目录必须跟着**入口**走，而不是跟着"发现到的安装"
  //
  //    这就是上面那个真实事故的形状：入口在 A、发现的安装是 B。
  //    修之前 cwd 会是 B —— 于是入口里的相对路径跑到 B 去了。
  const byLaunchCmd = await realStartSnowluma({
    config: { snowluma: { installDir: fakeB, launchCmd: scriptA, consoleUrl: 'http://127.0.0.1:1/', probeTimeoutMs: 500 } },
    findNode: () => process.execPath,
    detect: async () => ({ status: 'offline' }),
  })
  check('★★ 显式 launchCmd 时，cwd 跟着入口走（不是跟着发现到的安装）',
    byLaunchCmd.ok === true && byLaunchCmd.data.cwd === fakeA,
    `cwd=${byLaunchCmd.data?.cwd}  期望=${fakeA}（installDir 是 ${fakeB}）`)
  check('★ 并且入口仍然是 launchCmd 指定的那个',
    byLaunchCmd.data.cmd === scriptA, String(byLaunchCmd.data?.cmd))

  // ③ launchCwd 显式配置时仍然优先（不能被上面的规则顶掉）
  const explicitCwd = await realStartSnowluma({
    config: { snowluma: { installDir: fakeB, launchCmd: scriptA, launchCwd: fakeB, consoleUrl: 'http://127.0.0.1:1/', probeTimeoutMs: 500 } },
    findNode: () => process.execPath,
    detect: async () => ({ status: 'offline' }),
  })
  check('★ 显式 launchCwd 优先级最高（高级用法仍然有效）',
    explicitCwd.ok === true && explicitCwd.data.cwd === fakeB,
    `cwd=${explicitCwd.data?.cwd}  期望=${fakeB}`)
}

section('GET /api/snowluma/log（界面上的"终端"面板）')
{
  // 造一份**真实的 SnowLuma 日志**（UTF-8 + 中文 + 多级别 + 一行无法解析的）
  const SL = join(TMP, 'sl-log')
  mkdirSync(join(SL, 'logs'), { recursive: true })
  const logBody = [
    '00:25:52 OK    [200000001] [Event] 私聊 [无忘远霞(100000001)]: 确认一下群聊开关打开了吗',
    '00:26:41 DEBUG [200000001] [Bridge.Action] get_group_list params=',
    '00:35:04 WARN  [200000001] [OneBot.WS-Server] [ws-default] socket error: read ECONNRESET',
    '这一行没有时间戳，也必须原样显示',
    '',
  ].join('\n')
  writeFileSync(join(SL, 'logs', 'snowluma-2026-09-26.log'), logBody, 'utf8')
  // 再放一个更早日期的，验证"选日期最大的那个"
  writeFileSync(join(SL, 'logs', 'snowluma-2026-09-25.log'), '00:00:01 INFO 旧文件\n', 'utf8')

  const reader = createSnowlumaLogReader({ installDir: SL })
  const r = reader.read({ lines: 100 })
  check('返回 200 且 available=true', r.ok === true && r.data.available === true, JSON.stringify(r.data?.note))
  check('★ 选中日期最大的日志文件（不是随便一个）',
    r.data.file?.endsWith('snowluma-2026-09-26.log'), String(r.data.file))
  check('★★ 中文保真（这正是"读日志文件"而不是"抓 stdout"的原因）',
    r.data.lines.some((l) => l.text.includes('确认一下群聊开关打开了吗')),
    JSON.stringify(r.data.lines[0]?.text))
  check('解析出 time/level/rest', r.data.lines[0].time === '00:25:52' && r.data.lines[0].level === 'OK',
    JSON.stringify(r.data.lines[0]))
  check('★ 解析不出来的行也保留原文（不丢）',
    r.data.lines.some((l) => l.level === null && l.text.includes('没有时间戳')),
    JSON.stringify(r.data.lines.map((l) => l.level)))
  check('返回 offset 供下次增量', typeof r.data.offset === 'number' && r.data.offset > 0, String(r.data.offset))

  const noDebug = createSnowlumaLogReader({ installDir: SL }).read({ lines: 100, includeDebug: false })
  check('includeDebug=false 滤掉 DEBUG 行并如实报数',
    !noDebug.data.lines.some((l) => l.level === 'DEBUG') && noDebug.data.droppedDebug === 1,
    `dropped=${noDebug.data.droppedDebug} levels=${[...new Set(noDebug.data.lines.map((l) => l.level))].join(',')}`)

  // 增量：从 offset 继续，此时没有新内容
  const inc = reader.read({ offset: r.data.offset })
  check('增量读：无新内容时返回 0 行', inc.data.lines.length === 0, String(inc.data.lines.length))

  // ★★ 轮转：offset 超出文件大小 → 必须如实标记，否则界面会以为"没有新日志"
  const rotated = reader.read({ offset: 99_999_999 })
  check('★★ offset 超界时标记 rotated=true（跨天轮转的情况）',
    rotated.data.rotated === true, String(rotated.data.rotated))
  check('轮转时从头给内容（界面据此清空面板重画）', rotated.data.lines.length > 0,
    String(rotated.data.lines.length))

  const none = createSnowlumaLogReader({ installDir: join(TMP, 'nope') }).read({ lines: 10 })
  check('★ 没有日志时 available=false 且带解释（不是错误）',
    none.data.available === false && typeof none.data.note === 'string', String(none.data.note))

  // 通过 API handler 走一遍，确认路由真的接上了
  const viaApi = await handler({ method: 'GET', path: '/api/snowluma/log?lines=10' })
  check('接口已接上（观察 handler 里注入了 snowlumaLog）', viaApi.status !== 501,
    `实际 ${viaApi.status}`)
}

section('GET /api/roster（拉真实好友/群列表）')
{
  // 注入一个假的 OneBot 调用：只回好友与群列表
  const calls = []
  const fakeCall = async (action) => {
    calls.push(action)
    if (action === 'get_friend_list') {
      return [
        { user_id: 100000001, nickname: '无忘远霞' },
        { user_id: 111111, nickname: '朋友甲' },
      ]
    }
    if (action === 'get_group_list') {
      return [{ group_id: 700000002, group_name: '某个群' }]
    }
    throw new Error(`未预期的 action：${action}`)
  }
  const r = realCreateRoster({
    config: {
      access: {
        adminUsers: ['100000001'],
        // 故意放一个不在好友列表里的号码，验证"打错了"能被标出来
        dmAllowlist: ['111111', '9999999'],
        groupAllowlist: ['700000002', '8888888'],
      },
    },
  })
  const handler2 = createApiHandler({
    configPath: join(TMP, 'config.json'),
    readRawConfig: () => JSON.parse(JSON.stringify(RAW)),
    writeRawConfig: () => {},
    normalize: normalizeConfig,
    validate: validateConfig,
    getStatus: () => ({ running: true }),
    roster: r,
    onebotCall: fakeCall,
  })

  const res = await handler2({ method: 'GET', path: '/api/roster' })
  check('返回 200（不再是 501）', res.status === 200, `实际 ${res.status} ${JSON.stringify(res.body)}`)
  const d = res.body.data
  check('带回好友列表（含昵称，供界面按名字选）',
    d.friends?.length === 2 && d.friends[0].nickname === '无忘远霞', JSON.stringify(d.friends))
  check('带回群列表（含群名）',
    d.groups?.length === 1 && d.groups[0].name === '某个群', JSON.stringify(d.groups))
  check('★★ 标出"配置里有、但好友列表里找不到"的号码（打错号的静默故障）',
    d.unknownDmUsers?.includes('9999999') && !d.unknownDmUsers?.includes('111111'),
    JSON.stringify(d.unknownDmUsers))
  check('★★ 群同理（打错的群号会被标出来）',
    d.unknownGroups?.includes('8888888') && !d.unknownGroups?.includes('700000002'),
    JSON.stringify(d.unknownGroups))
  check('管理员都在好友列表里 → unknownAdmins 为空',
    Array.isArray(d.unknownAdmins) && d.unknownAdmins.length === 0, JSON.stringify(d.unknownAdmins))

  // ★ 缓存：第二次不该再打协议端（好友列表不会秒变，而每次都要几百毫秒）
  const before = calls.length
  await handler2({ method: 'GET', path: '/api/roster' })
  check('★ 第二次走缓存，不再连协议端', calls.length === before, `多打了 ${calls.length - before} 次`)

  const refreshed = await handler2({ method: 'GET', path: '/api/roster?refresh=1' })
  check('★ ?refresh=1 强制重拉', refreshed.body.data.cached === false, String(refreshed.body.data.cached))
  check('★ ?refresh=0 **不**被当成真（否则界面永远拿不到缓存）',
    (await handler2({ method: 'GET', path: '/api/roster?refresh=0' })).body.data.cached === true)

  // 协议端连不上时：**不整体失败**，而是如实给出 warnings + 空列表。
  //
  // 为什么不是 502：两个列表是**分别**拉的。好友拉失败时群可能拉到了，
  // 那部分数据仍有价值 —— 整体报错会让界面什么都显示不出来。
  // 但"悄悄给空列表"也不行（界面会以为你没好友），所以 warnings 是契约的一部分。
  const dead = createApiHandler({
    configPath: join(TMP, 'config.json'),
    readRawConfig: () => JSON.parse(JSON.stringify(RAW)),
    writeRawConfig: () => {},
    normalize: normalizeConfig,
    validate: validateConfig,
    getStatus: () => ({ running: true }),
    roster: realCreateRoster({ config: { access: { adminUsers: [], dmAllowlist: [], groupAllowlist: [] } } }),
    onebotCall: async () => {
      throw new Error('connect ECONNREFUSED')
    },
  })
  const bad = await dead({ method: 'GET', path: '/api/roster?refresh=1' })
  check('★ 协议端连不上 → 仍 200，但 warnings 里说清两条都失败了（不假装"你没有好友"）',
    bad.status === 200 && Array.isArray(bad.body.data.warnings) && bad.body.data.warnings.length === 2,
    JSON.stringify(bad.body.data.warnings))
  check('★ warnings 是给人看的话，不是裸的 ECONNREFUSED',
    bad.body.data.warnings.every((w) => /拉好友列表失败|拉群列表失败/.test(w)),
    JSON.stringify(bad.body.data.warnings))
  check('此时列表为空（诚实：确实什么都没拿到）',
    bad.body.data.friends.length === 0 && bad.body.data.groups.length === 0)
  check('★ 全都没拿到时，不再声称"某某号码找不到"（那会误导成打错了号）',
    bad.body.data.unknownDmUsers.length === 0 && bad.body.data.unknownGroups.length === 0,
    JSON.stringify([bad.body.data.unknownDmUsers, bad.body.data.unknownGroups]))
}

section('probeConsole 本身')
{
  const dead = await probeConsole('http://127.0.0.1:1/', 600)
  check('连不上时 reachable=false 且带 error', dead.reachable === false && typeof dead.error === 'string',
    String(dead.error))
  check('空地址不抛错', (await probeConsole('', 300)).reachable === false)

  const fake = await startFakeConsole('别的标题')
  try {
    const live = await probeConsole(fake.url, 2000)
    check('通的时候 reachable=true 且读出 title',
      live.reachable === true && live.title === '别的标题', `${live.reachable} / ${live.title}`)
  } finally {
    await fake.close()
  }
}

section('GET /api/memory/tree')
{
  const res = await handler({ method: 'GET', path: '/api/memory/tree' })
  check('返回 200（不再是 501）', res.status === 200, `实际 ${res.status}`)
  check('含 MEMORY.md', res.body.data.entries.some((e) => e.path === 'MEMORY.md'))
  check('★ 带 enabled（关掉记忆时界面仍要能看能改）',
    res.body.data.enabled === true)
  check('带 totalBytes', typeof res.body.data.totalBytes === 'number')
}

section('GET / POST / DELETE /api/memory/file')
{
  const read = await handler({ method: 'GET', path: '/api/memory/file?path=MEMORY.md' })
  check('读文件返回 200 且含 content 与 sha256',
    read.status === 200 && typeof read.body.data.sha256 === 'string',
    String(read.body.data.sha256).slice(0, 12))
  const sha = read.body.data.sha256

  const write = await handler({
    method: 'POST', path: '/api/memory/file',
    body: { path: 'MEMORY.md', content: '# 改过了\n', expectedSha256: sha },
  })
  check('写文件返回 200 且 restartRequired=false（记忆不需要重启）',
    write.status === 200 && write.body.data.restartRequired === false, JSON.stringify(write.body.data))
  check('磁盘上真的改了',
    readFileSync(join(WS, 'MEMORY.md'), 'utf8').includes('改过了'))

  const conflict = await handler({
    method: 'POST', path: '/api/memory/file',
    body: { path: 'MEMORY.md', content: '# 旧版本\n', expectedSha256: sha },
  })
  check('★ 用过期 sha256 → 409', conflict.status === 409, `实际 ${conflict.status}`)
  check('★ 409 带 conflict/currentContent（界面据此判断谁对）',
    conflict.body.conflict === true && typeof conflict.body.currentContent === 'string',
    String(conflict.body.currentContent).slice(0, 12))

  const escape = await handler({
    method: 'POST', path: '/api/memory/file',
    body: { path: '../evil.md', content: 'x' },
  })
  check('★ 越界路径被拒绝（400）', escape.status === 400, String(escape.body.error))
  check('★ 越界文件真的没被创建', !existsSync(join(TMP, 'evil.md')))

  const notMd = await handler({
    method: 'POST', path: '/api/memory/file',
    body: { path: 'config.json.md.bak', content: 'x' },
  })
  check('非 .md 扩展名被拒绝', notMd.status === 400, String(notMd.body.error))

  const del = await handler({ method: 'DELETE', path: '/api/memory/file?path=MEMORY.md' })
  check('★ DELETE 返回 200（UI 已用到这个接口）', del.status === 200, JSON.stringify(del.body))
  check('★ 删除后文件真的没了（不是谎报，见 rmSync 静默失败那条）',
    !existsSync(join(WS, 'MEMORY.md')))
  const delAgain = await handler({ method: 'DELETE', path: '/api/memory/file?path=MEMORY.md' })
  check('重复删除返回 404', delAgain.status === 404, String(delAgain.body.error))
}

section('路由不串味')
{
  const a = await handler({ method: 'GET', path: '/api/usage' })
  const b = await handler({ method: 'GET', path: '/api/usage/prices' })
  check('★ /api/usage 与 /api/usage/prices 返回不同结构',
    'totals' in a.body.data && 'routes' in b.body.data)
  const c = await handler({ method: 'GET', path: '/api/memory/tree' })
  const d = await handler({ method: 'GET', path: '/api/memory/file?path=x.md' })
  check('★ /api/memory/tree 与 /api/memory/file 不互抢',
    'entries' in c.body.data && !('entries' in (d.body.data ?? {})))
  const e = await handler({ method: 'DELETE', path: '/api/usage' })
  check('未定义的方法 + 路径 → 404', e.status === 404, String(e.body.error))
}

// ── 清理与退出 ────────────────────────────────────────────────────────────
//
// ⚠️ 这一节踩过两次坑，都值得记下来。
//
// 【坑一】测试会 spawn 一个假的 SnowLuma 子进程（.mjs），而 `spawn` 是**异步**的：
//   它返回时子进程可能还没真正启动完。于是主进程走到清理时，那个脚本文件
//   还被子进程占着 —— Windows 不允许删被占用的文件，
//   于是 `rmSync` 抛 **EPERM**。
//
// 【坑二】那个 EPERM 是**未捕获**的，它在退出路径上把进程炸成
//   `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（退出码 0xC0000409）。
//   结果：**一个 60 项全过的测试被 `npm test` 判成失败**，而报告里只有一句
//   看不懂的原生断言。
//
// 所以现在：① 先给子进程一点时间退出；② 清理失败只警告、绝不抛。
// 共同教训（本项目第三次遇到）：**异步资源的释放是竞态，"调用完"不等于"结束"**。
await new Promise((r) => setTimeout(r, 400))
void memoryStore

try {
  rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
} catch (error) {
  console.log(`⚠️ 临时目录没能删掉（不影响测试结论）：${error.code ?? ''} ${error.message}`)
  console.log(`   多半是刚 spawn 的子进程还占着文件句柄。手动删：${TMP}`)
}

console.log(`\n${failures === 0 ? '🎉 新接口集成测试全部通过' : `⚠️ ${failures} 项失败`}\n`)

// 再排空一次，然后明确退出（不要依赖"事件循环自然清空"）
await new Promise((r) => setTimeout(r, 150))
process.exit(failures === 0 ? 0 : 1)
