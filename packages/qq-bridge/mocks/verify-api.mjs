#!/usr/bin/env node
/**
 * 配置 HTTP 接口的测试。
 *
 * ── 为什么重点在这两个地方 ─────────────────────────────────────────────
 * 这个接口把"配置"暴露给了浏览器，风险集中在一处：
 *   · **token 会不会被读出去？**
 *   · **保存一次会不会把 token 弄丢？**（源项目踩过：置空后前端回传覆盖真值）
 *   · **会不会被绑到外部地址？**（那等于把机器人控制权公开到局域网）
 * 所以这里对这三条做了重点覆盖，每条都有多个边界用例。
 *
 * 另外它测的是**纯处理函数**（不碰 socket），所以跑得快、也不需要占用端口。
 *
 * 用法：node mocks/verify-api.mjs
 */

import { createApiHandler, redactConfig, mergeConfigPatch, assertLoopbackOnly, serveApi } from '../src/api.mjs'
import { normalizeConfig, validateConfig } from '../src/config.mjs'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

/** 一份模拟磁盘上的原始配置（含明文 token 与 API key）。 */
const RAW = {
  dsh: {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    workspace: 'workspace-qq',
    apiKey: 'REAL-API-KEY',
  },
  onebot: {
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    wsToken: 'REAL-WS-TOKEN',
    httpToken: 'REAL-HTTP-TOKEN',
  },
  access: { adminUsers: ['100000001'] },
  trigger: { private: true, groupEnabled: false, keywords: ['小鲸鱼'] },
  humanize: { enabled: true, charsPerSecond: 5 },
  memory: { enabled: true },
  ui: { logFile: 'logs/bridge.log', apiEnabled: true, apiPort: 3410 },
  _说明: '这是给人看的注释，不应该被存进配置',
}

/** 造一个处理器，写盘操作记在内存里，便于断言。 */
function makeHandler(overrides = {}) {
  const state = { raw: JSON.parse(JSON.stringify(RAW)), writes: [], saved: 0 }
  const handler = createApiHandler({
    configPath: 'C:\\fake\\config.json',
    readRawConfig: () => JSON.parse(JSON.stringify(state.raw)),
    writeRawConfig: (cfg) => {
      state.writes.push(cfg)
      state.raw = JSON.parse(JSON.stringify(cfg))
    },
    normalize: normalizeConfig,
    validate: validateConfig,
    getStatus: () => ({ running: true, stats: { received: 3 } }),
    runDoctor: async () => ({ fatal: [], warn: [], rows: [{ name: 'x', ok: true }] }),
    onConfigSaved: () => {
      state.saved += 1
    },
    ...overrides,
  })
  return { handler, state }
}

// ══════════════════════════════════════════════════════════════════════════
section('安全 ① 读配置必须脱敏（token 不能被读出去）')
// ══════════════════════════════════════════════════════════════════════════
{
  const red = redactConfig(RAW)
  const text = JSON.stringify(red)

  check('★ wsToken 的**值**不出现在返回内容里', !text.includes('REAL-WS-TOKEN'))
  check('★ httpToken 的值不出现在返回内容里', !text.includes('REAL-HTTP-TOKEN'))
  check('token 字段本身被删除（不是置空）', !('wsToken' in red.onebot) && !('httpToken' in red.onebot))
  check('用布尔标记替代：hasWsToken', red.hasWsToken === true)
  check('用布尔标记替代：hasHttpToken', red.hasHttpToken === true)
  check('未配置 token 时标记为 false',
    redactConfig({ onebot: {} }).hasWsToken === false)
  check('★ API key 的**值**不出现在返回内容里', !text.includes('REAL-API-KEY'))
  check('API key 字段本身被删除（不是置空）', !('apiKey' in red.dsh))
  check('API key 用布尔标记替代：hasApiKey', red.hasApiKey === true)
  check('未配置 API key 时标记为 false', redactConfig({ dsh: {} }).hasApiKey === false)
  check('API key 的标记与 token 的标记在同一层（根部）',
    'hasApiKey' in red && !('hasApiKey' in (red.dsh ?? {})))
  check('脱敏不改动原对象（深拷贝）', RAW.onebot.wsToken === 'REAL-WS-TOKEN')
  check('其他字段原样保留', red.onebot.wsUrl === 'ws://127.0.0.1:3001' && red.access.adminUsers[0] === '100000001')
}

// ══════════════════════════════════════════════════════════════════════════
section('安全 ② 保存时不能把 token 弄丢（源项目踩过的坑）')
// ══════════════════════════════════════════════════════════════════════════
{
  // 模拟 UI 的典型行为：拿到脱敏配置 → 改一个无关字段 → 整体回传
  const redacted = redactConfig(RAW)
  redacted.humanize.charsPerSecond = 9
  const merged = mergeConfigPatch(RAW, redacted)

  check('★ 回传的配置里没有 token 字段时，原 token 被保留',
    merged.onebot.wsToken === 'REAL-WS-TOKEN' && merged.onebot.httpToken === 'REAL-HTTP-TOKEN',
    `ws=${merged.onebot.wsToken} http=${merged.onebot.httpToken}`)
  check('同时改动的字段确实生效', merged.humanize.charsPerSecond === 9)

  // 显式传空串也应视为"不修改"
  const empty = mergeConfigPatch(RAW, { onebot: { wsToken: '', httpToken: null } })
  check('★ 显式传空串/null 也保留原 token',
    empty.onebot.wsToken === 'REAL-WS-TOKEN' && empty.onebot.httpToken === 'REAL-HTTP-TOKEN')

  // 传新值则应生效（用户确实想换 token）
  const changed = mergeConfigPatch(RAW, { onebot: { wsToken: 'NEW-TOKEN' } })
  check('传新 token 时正常替换', changed.onebot.wsToken === 'NEW-TOKEN')
  check('未提及的 httpToken 不受影响', changed.onebot.httpToken === 'REAL-HTTP-TOKEN')

  // 原本就没有 token 时，不该凭空造一个
  const none = mergeConfigPatch({ onebot: {} }, { onebot: { wsToken: '' } })
  check('原本没有 token 时不会凭空产生 key', !('wsToken' in none.onebot))

  // 下划线开头的注释键不该被当成配置存下来
  const withComment = mergeConfigPatch(RAW, { _说明: '随便写的注释', dsh: { model: 'x' } })
  check('下划线开头的注释键不会被合并进配置', !('_说明' in withComment) || withComment['_说明'] === RAW['_说明'])
  check('深层字段正常合并', withComment.dsh.model === 'x')
  check('同层其他字段保留', withComment.dsh.provider === 'deepseek-official')

  // 数组应整体替换，而不是逐项合并
  const arr = mergeConfigPatch(RAW, { trigger: { keywords: ['甲'] } })
  check('数组整体替换而不是逐项合并', JSON.stringify(arr.trigger.keywords) === '["甲"]')
}

// ══════════════════════════════════════════════════════════════════════════
section('安全 ③ API key 的三种写法：保持 / 替换 / 显式清除')
// ══════════════════════════════════════════════════════════════════════════
{
  check('前置：RAW 里确实有一把 key', RAW.dsh.apiKey === 'REAL-API-KEY')

  // ① 空串 = 保持原样（UI 没动那个框时的常态）
  const empty = mergeConfigPatch(RAW, { dsh: { apiKey: '' } })
  check('★ 空串 → 保持原 key（用户每保存一次不能把 key 弄丢）', empty.dsh.apiKey === 'REAL-API-KEY',
    String(empty.dsh.apiKey))

  // ② 完全不提这个字段 = 保持原样
  const absent = mergeConfigPatch(RAW, { dsh: { model: 'deepseek-flash' } })
  check('★ 不放该字段 → 保持原 key', absent.dsh.apiKey === 'REAL-API-KEY', String(absent.dsh.apiKey))

  // ③ 新值 = 替换
  const changed = mergeConfigPatch(RAW, { dsh: { apiKey: 'sk-NEW' } })
  check('新值 → 正常替换', changed.dsh.apiKey === 'sk-NEW', String(changed.dsh.apiKey))

  // ④ null = 显式清除（落盘为空串，而不是删掉这个键）
  //
  // ★ 这一条是真实 bug 的回归：第一版把判据写成"合并结果里是不是 null"，
  //   而合并结果里的 null 早被上一步"恢复旧值"换成了旧值 —— 于是**清除永远不生效**，
  //   而当时所有单元测试都是绿的（没有这一条）。是一次真实 HTTP 往返把它抓出来的。
  const cleared = mergeConfigPatch(RAW, { dsh: { apiKey: null } })
  check('★ null → 显式清除（null 不能被"保持原样"那条语义吃掉）', cleared.dsh.apiKey === '',
    JSON.stringify(cleared.dsh.apiKey))
  check('清除后这个键仍然存在（否则 setPath/getPath 的路径会断）', 'apiKey' in cleared.dsh)

  // ⑤ 非 clearable 的密钥不受影响：token 传 null 仍然是"保持"
  const tokenNull = mergeConfigPatch(RAW, { onebot: { wsToken: null } })
  check('★ 不可清除的字段（token）传 null 仍然是"保持原样"', tokenNull.onebot.wsToken === 'REAL-WS-TOKEN',
    String(tokenNull.onebot.wsToken))
}

// ══════════════════════════════════════════════════════════════════════════
section('安全 ③ 只允许绑定回环地址')
// ══════════════════════════════════════════════════════════════════════════
{
  for (const host of ['127.0.0.1', '::1', 'localhost']) {
    let ok = true
    try {
      assertLoopbackOnly(host)
    } catch {
      ok = false
    }
    check(`允许 ${host}`, ok)
  }
  for (const host of ['0.0.0.0', '192.168.1.5', 'example.com', '']) {
    let threw = false
    let message = ''
    try {
      assertLoopbackOnly(host)
    } catch (error) {
      threw = true
      message = error.message
    }
    check(`★ 拒绝 ${host || '(空)'}`, threw, message.slice(0, 50))
  }

  let serveThrew = false
  try {
    // 不应真的起服务器：地址不合法时必须在 listen 之前就抛错
    await serveApi({ host: '0.0.0.0', port: 0, handler: async () => ({ status: 200, body: {} }) })
  } catch {
    serveThrew = true
  }
  check('★ serveApi 在非回环地址上直接抛错（不会先监听）', serveThrew)
}

// ══════════════════════════════════════════════════════════════════════════
section('接口行为 · 状态与读配置')
// ══════════════════════════════════════════════════════════════════════════
{
  const { handler } = makeHandler()

  const status = await handler({ method: 'GET', path: '/api/status' })
  check('GET /api/status 返回 200', status.status === 200)
  check('状态里含运行信息', status.body.data.running === true && status.body.data.stats.received === 3)
  check('响应头禁止缓存（UI 轮询不能被缓存）',
    status.headers['cache-control'] === 'no-store')

  const cfg = await handler({ method: 'GET', path: '/api/config' })
  check('GET /api/config 返回 200', cfg.status === 200)
  check('★ 读到的配置里没有 token 值',
    !JSON.stringify(cfg.body.data).includes('REAL-WS-TOKEN'))

  // 带查询串也要能路由（UI 常写成 /api/config?t=123）
  const withQuery = await handler({ method: 'GET', path: '/api/config?t=123' })
  check('带查询串仍能正确路由', withQuery.status === 200)

  // 末尾斜杠也要容错
  const trailing = await handler({ method: 'GET', path: '/api/status/' })
  check('末尾斜杠容错', trailing.status === 200)
}

// ══════════════════════════════════════════════════════════════════════════
section('接口行为 · 写配置')
// ══════════════════════════════════════════════════════════════════════════
{
  const { handler, state } = makeHandler()

  const res = await handler({
    method: 'POST',
    path: '/api/config',
    body: { humanize: { charsPerSecond: 12 } },
  })
  check('POST /api/config 返回 200', res.status === 200, JSON.stringify(res.body).slice(0, 100))
  check('返回 restartRequired（配置需重启生效）', res.body.data.restartRequired === true)
  check('确实写了盘', state.writes.length === 1)
  check('改动生效', state.writes[0].humanize.charsPerSecond === 12)
  check('★ 写盘后 token 仍在', state.writes[0].onebot.wsToken === 'REAL-WS-TOKEN')
  check('触发了保存回调', state.saved === 1)

  // 提交一个会导致启动失败的配置：必须拒绝保存
  const bad = await handler({
    method: 'POST',
    path: '/api/config',
    body: { dsh: { workspace: 'D:\\' } },
  })
  check('★ 会导致启动失败的配置被拒绝保存（422）', bad.status === 422, JSON.stringify(bad.body).slice(0, 120))
  check('拒绝时返回具体原因', Array.isArray(bad.body.fatal) && bad.body.fatal.length > 0)
  check('拒绝时**没有**写盘', state.writes.length === 1)

  const notObject = await handler({ method: 'POST', path: '/api/config', body: 'abc' })
  check('提交非对象 → 400', notObject.status === 400)
}

// ══════════════════════════════════════════════════════════════════════════
section('接口行为 · 自检、体检、未知路径、异常')
// ══════════════════════════════════════════════════════════════════════════
{
  const { handler } = makeHandler()

  const checkRes = await handler({ method: 'POST', path: '/api/check' })
  check('POST /api/check 返回 fatal/warn 两个数组',
    Array.isArray(checkRes.body.data.fatal) && Array.isArray(checkRes.body.data.warn))

  // 可以对"还没保存的配置"做预检 —— UI 需要在保存前就提示问题
  const precheck = await handler({ method: 'POST', path: '/api/check', body: { access: { adminUsers: [] } } })
  check('★ /api/check 支持对提交的配置预检（不必先保存）',
    precheck.body.data.warn.some((w) => /没有人可以使用/.test(w)),
    precheck.body.data.warn.join(' | ').slice(0, 80))

  const doctor = await handler({ method: 'POST', path: '/api/doctor' })
  check('POST /api/doctor 返回逐项结果', doctor.status === 200 && Array.isArray(doctor.body.data.rows))

  const missing = await handler({ method: 'GET', path: '/api/nope' })
  check('未知路径 → 404', missing.status === 404)

  const wrongMethod = await handler({ method: 'DELETE', path: '/api/config' })
  check('不支持的方法 → 404', wrongMethod.status === 404)

  // 处理器内部抛异常时要变成结构化错误，不能挂死
  const { handler: boom } = makeHandler({
    readRawConfig: () => {
      throw new Error('磁盘炸了')
    },
  })
  const boomRes = await boom({ method: 'GET', path: '/api/config' })
  check('★ 内部异常被转成 500 结构化错误（不会挂死请求）',
    boomRes.status === 500 && /磁盘炸了/.test(boomRes.body.error), boomRes.body.error)

  // 没接体检时给出明确 501，而不是假装成功
  const { handler: noDoctor } = makeHandler({ runDoctor: undefined })
  const nd = await noDoctor({ method: 'POST', path: '/api/doctor' })
  check('未接入体检 → 501（不假装成功）', nd.status === 501)
}

// ══════════════════════════════════════════════════════════════════════════
section('停止 / 重启接口（先响应，后执行）')
// ══════════════════════════════════════════════════════════════════════════
{
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  // 未接入时 → 501，与体检同款处理
  const { handler: noPower } = makeHandler({ requestStop: undefined, requestRestart: undefined })
  const ns = await noPower({ method: 'POST', path: '/api/stop' })
  check('未接入停止 → 501', ns.status === 501)
  const nr = await noPower({ method: 'POST', path: '/api/restart' })
  check('未接入重启 → 501', nr.status === 501)

  // 接入后：先拿到 200 响应，回调延后执行（测试里把延迟压到 0）
  let stopped = 0
  let restarted = 0
  const { handler: power } = makeHandler({
    powerActionDelayMs: 0,
    requestStop: () => {
      stopped += 1
    },
    requestRestart: () => {
      restarted += 1
    },
  })
  const stopRes = await power({ method: 'POST', path: '/api/stop' })
  check('POST /api/stop 返回 200 且带提示', stopRes.status === 200 && stopRes.body.data.stopping === true)
  const restartRes = await power({ method: 'POST', path: '/api/restart' })
  check('POST /api/restart 返回 200 且带提示', restartRes.status === 200 && restartRes.body.data.restarting === true)
  check('★ 响应返回时动作尚未执行（先响应后执行）', stopped === 0 && restarted === 0)
  await wait(20)
  check('停止回调随后被执行', stopped === 1)
  check('重启回调随后被执行', restarted === 1)
}

// ══════════════════════════════════════════════════════════════════════════
section('接口行为 · 会话同步（给"同步 QQ 对话界面"用）')
// ══════════════════════════════════════════════════════════════════════════
{
  const conversations = [
    {
      chatKey: 'private:100000001',
      kind: 'private',
      peerId: '100000001',
      status: 'thinking',
      updatedAt: 1,
      messageCount: 2,
      messages: [
        { role: 'user', text: '你好', at: 1 },
        { role: 'bot', text: '在的', at: 2 },
      ],
    },
  ]

  const { handler } = makeHandler({ getConversations: () => conversations })
  const res = await handler({ method: 'GET', path: '/api/conversations' })

  check('GET /api/conversations 返回 200', res.status === 200)
  check('返回会话数组', Array.isArray(res.body.data.conversations))
  check('返回条数', res.body.data.count === 1)
  check('会话带 chatKey（界面用它区分不同聊天）',
    res.body.data.conversations[0].chatKey === 'private:100000001')
  check('会话带状态（界面据此显示"正在处理"）', res.body.data.conversations[0].status === 'thinking')
  check('消息带 role / text / at（界面据此分左右气泡）',
    res.body.data.conversations[0].messages[0].role === 'user' &&
      typeof res.body.data.conversations[0].messages[0].at === 'number')
  check('★ 明确标注这是内存镜像（免得 UI 当历史归档用）',
    typeof res.body.data.note === 'string' && /内存镜像/.test(res.body.data.note), res.body.data.note)
  check('响应禁止缓存（界面轮询不能被缓存）', res.headers['cache-control'] === 'no-store')

  // 未接入时返回空数组而不是报错（UI 不必为此写特例）
  const { handler: noConv } = makeHandler({ getConversations: undefined })
  const empty = await noConv({ method: 'GET', path: '/api/conversations' })
  check('未接入会话数据时返回空数组而不是报错',
    empty.status === 200 && Array.isArray(empty.body.data.conversations),
    JSON.stringify(empty.body.data))
}

// ── SnowLuma 进程接口：占位行为（目前只有占位）──────────────────────────
//
// 这两条用例的价值不在"功能对不对"（功能还没做），而在**契约**：
// 路径必须是被显式派发的，而不是掉进 404 兜底。因为 `CONFIG-UI.md` 的
// 接口表已经把它们写进去了，UI 生成者会照着做；如果实际是 404，
// 对方会以为**自己路径写错了**，于是去改一个本来正确的路径。
section('SnowLuma 进程接口（占位：501 而不是 404）')
{
  const { handler } = makeHandler()

  const detect = await handler({ method: 'GET', path: '/api/snowluma/detect' })
  check('GET /api/snowluma/detect 是【显式派发】，不是 404 兜底',
    detect.status === 501, `实际 ${detect.status} ${JSON.stringify(detect.body)}`)
  check('返回 pending 标记与可执行提示（界面据此禁用按钮并说明原因）',
    detect.body?.pending === true && typeof detect.body?.hint === 'string' && detect.body.hint.length > 0,
    detect.body?.hint)
  check('错误文案里不含文件路径或内部实现细节',
    !/[A-Za-z]:\\|\/src\/|node_modules/.test(String(detect.body?.error ?? '') +
      String(detect.body?.hint ?? '')), String(detect.body?.error))

  const start = await handler({ method: 'POST', path: '/api/snowluma/start' })
  check('POST /api/snowluma/start 同样是显式派发（501 而非 404）',
    start.status === 501, `实际 ${start.status} ${JSON.stringify(start.body)}`)
  check('两个占位接口的返回结构一致（界面可以用同一套容错逻辑）',
    start.body?.pending === true &&
      Object.keys(detect.body).sort().join(',') === Object.keys(start.body).sort().join(','),
    Object.keys(start.body).join(','))

  // 用量接口：路径带子路径（/api/usage/prices）与查询串，最容易被路由写错。
  const usage = await handler({ method: 'GET', path: '/api/usage?days=7' })
  check('GET /api/usage 带查询串也是显式派发（501 而非 404）',
    usage.status === 501, `实际 ${usage.status} ${JSON.stringify(usage.body)}`)

  const prices = await handler({ method: 'GET', path: '/api/usage/prices' })
  check('★ GET /api/usage/prices 不会被 /api/usage 抢走（子路径路由）',
    prices.status === 501, `实际 ${prices.status} ${JSON.stringify(prices.body)}`)
  check('★ /api/usage 与 /api/usage/prices 是两条不同的分支（文案不同）',
    usage.body?.error !== prices.body?.error,
    `${usage.body?.error} / ${prices.body?.error}`)

  // 记忆文件接口：同一个路径 GET/POST 两种方法，最容易被写成单分支。
  const memTree = await handler({ method: 'GET', path: '/api/memory/tree' })
  const memRead = await handler({ method: 'GET', path: '/api/memory/file?path=MEMORY.md' })
  const memWrite = await handler({
    method: 'POST', path: '/api/memory/file',
    body: { path: 'MEMORY.md', content: '# x', expectedSha256: 'deadbeef' },
  })
  check('GET /api/memory/tree 是显式派发（501 而非 404）',
    memTree.status === 501, `实际 ${memTree.status}`)
  check('★ GET /api/memory/file 与 POST /api/memory/file 是【两条】分支',
    memRead.status === 501 && memWrite.status === 501 &&
      memRead.body?.error !== memWrite.body?.error,
    `${memRead.body?.error} / ${memWrite.body?.error}`)
  check('★ 记忆接口的占位文案不泄露工作区绝对路径',
    ![memTree, memRead, memWrite].some((r) =>
      /[A-Za-z]:\\/.test(String(r.body?.error ?? '') + String(r.body?.hint ?? ''))),
    String(memTree.body?.error))
}

// ══════════════════════════════════════════════════════════════════════════
section('★ 控制台改记忆后必须刷新快照基准（否则下次读记忆会把它回滚掉）')
// ══════════════════════════════════════════════════════════════════════════
{
  // 这条盯的是一个**静默**缺陷：`verifyAndRestoreMemory` 的判据是
  // "文件内容 == 桥接写下的快照"，不一致就回滚。控制台保存/删除记忆走的是
  // `memoryStore.write/remove`（直接写盘、不动快照），于是：
  //   · 在界面上改一条 → 下一次读记忆 → 被当篡改 → **原样回滚**
  //   · 在界面上删一条 → 快照还在 → 那条记忆有机会"复活"
  // 两种情况的表现都是「过一会儿它自己又回来了」，而且**不报错**。
  //
  // 修法：这两个路由在成功之后注入式地调用快照钩子。这里用桩记录调用，
  // 所以断言的是"**真的调了**"，而不是"文件看起来对"。
  const calls = []
  const store = {
    write: (p) => ({ ok: true, data: { saved: true, path: p } }),
    remove: (p) => ({ ok: true, data: { deleted: true, path: p } }),
    tree: () => ({ ok: true, data: { files: [] } }),
    read: () => ({ ok: true, data: {} }),
  }
  const { handler } = makeHandler({
    memoryStore: store,
    saveMemorySnapshot: (rel) => calls.push(['save', rel]),
    dropMemorySnapshot: (rel) => calls.push(['drop', rel]),
  })

  const w = await handler({
    method: 'POST', path: '/api/memory/file',
    body: { path: 'MEMORY.md', content: '# x' },
  })
  check('POST 保存成功', w.status === 200 && w.body?.data?.saved === true, JSON.stringify(w.body))
  check('★★ 保存成功后**刷新了快照**（不刷新 = 界面上的改动下次读记忆会被回滚）',
    calls.some(([k, rel]) => k === 'save' && rel === 'MEMORY.md'), JSON.stringify(calls))

  calls.length = 0
  const d = await handler({ method: 'DELETE', path: '/api/memory/file?path=memory%2Fgroup-1.md' })
  check('DELETE 成功', d.status === 200, JSON.stringify(d.body))
  check('★★ 删除成功后**一并删掉快照**（不删 = 已删的记忆会复活）',
    calls.some(([k]) => k === 'drop'), JSON.stringify(calls))

  // 失败时**不该**动快照：改都没改成功，刷基准会把真实的篡改洗白
  calls.length = 0
  const bad = makeHandler({
    memoryStore: { ...store, write: () => ({ ok: false, status: 409, error: '冲突', conflict: true }) },
    saveMemorySnapshot: (rel) => calls.push(['save', rel]),
  }).handler
  const conflict = await bad({
    method: 'POST', path: '/api/memory/file',
    body: { path: 'MEMORY.md', content: '# x' },
  })
  check('冲突时返回 409', conflict.status === 409, `实际 ${conflict.status}`)
  check('★★ 写入**失败**时不动快照（否则会把真实篡改洗白）',
    calls.length === 0, JSON.stringify(calls))
}

console.log(`\n${failures === 0 ? '🎉 配置接口测试全部通过' : `⚠️ ${failures} 项失败`}\n`)
process.exit(failures === 0 ? 0 : 1)
