/**
 * 直连模型通路测试（0.2.3）：`src/model-direct.mjs`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套盯的四件事
 * ══════════════════════════════════════════════════════════════════════════
 * ① **线协议必须与 DSH 的适配器逐字对齐**。这些不是风格问题，每一条写错都会
 *    让判定器**静默失效**（而且失败被 fail-open 吃掉，表现成"判定器从不沉默"）：
 *      · 端点是 `${baseUrl}/chat/completions` —— **没有 `/v1`**（自己加会 404）；
 *      · 认证头是 `authorization: Bearer <key>`；
 *      · 模型 id 直接用（DSH 模型表里的 id 就是发给接口的 id，不需要别名翻译）；
 *      · 思考字段是 `thinking: { type: 'disabled' }`（判定要快、要稳定，
 *        而且 max_tokens 给得小，开着思考会把额度花在 reasoning 上、正文被截断）；
 *      · **不发 `response_format`**（该适配器不认，要 JSON 只能靠提示词 + 宽松解析）。
 * ② **key 不进日志、不进错误信息** —— 这个模块会把凭据放进请求头，一旦泄漏
 *    就会出现在日志文件与界面里。
 * ③ **明文只走回环**：https 随便用；http 只允许 localhost/127.0.0.1/::1。
 *    理由不是防 SSRF（端点由使用者自己配），而是别让 `Authorization` 头裸奔。
 * ④ **任何失败都不抛**，且 401/403/404 各有各的话术 —— 含糊成一句"接口失败"
 *    会让人去查网络，而真相是 key 或路径。
 *
 * 用法：node mocks/verify-model-direct.mjs
 */

import { checkEndpoint, chatOnce, resolveDirectTarget, DIRECT_DEFAULTS } from '../src/model-direct.mjs'

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

/** 造一个 Response 形状的桩（`chatOnce` 只用 ok / status / text()）。 */
function fakeRes(status, body, { asText = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (asText !== null ? asText : JSON.stringify(body)),
  }
}
/** 记下请求的桩。 */
function capture(responder) {
  const calls = []
  return {
    calls,
    impl: async (url, opts) => {
      calls.push({ url, opts })
      return responder(url, opts)
    },
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('① 端点白名单：https 随便用，http 只允许回环（别让 Authorization 裸奔）')
// ══════════════════════════════════════════════════════════════════════════
{
  check('默认端点就是 DSH 那个（https://api.deepseek.com，**没有 /v1**）',
    DIRECT_DEFAULTS.baseUrl === 'https://api.deepseek.com' && !DIRECT_DEFAULTS.baseUrl.includes('/v1'),
    DIRECT_DEFAULTS.baseUrl)
  check('https 放行', checkEndpoint('https://api.deepseek.com').ok === true)
  check('https 自定义端点也放行', checkEndpoint('https://llm.example.com/openai').ok === true)
  check('★ http + 回环放行（本地模型服务：Ollama / LM Studio / vLLM）',
    checkEndpoint('http://127.0.0.1:11434').ok === true && checkEndpoint('http://localhost:1234').ok === true)
  check('★★ http + 非回环**拒绝**（明文发 key = 凭据裸奔）',
    checkEndpoint('http://llm.example.com').ok === false, checkEndpoint('http://llm.example.com').why ?? '')
  check('  └ 拒绝理由说清了是"明文发 key"这件事（不是含糊的"不允许"）',
    /key/.test(checkEndpoint('http://llm.example.com').why ?? '') &&
      /回环/.test(checkEndpoint('http://llm.example.com').why ?? ''))
  check('  └ 并给出出路（要自建端点就配 https）', /https/.test(checkEndpoint('http://llm.example.com').why ?? ''))
  check('  127.0.0.1.evil.com 这种前缀伪装**不算回环**',
    checkEndpoint('http://127.0.0.1.evil.com').ok === false)
  check('别的协议一律拒（file: / ftp:）',
    checkEndpoint('file:///etc/passwd').ok === false && checkEndpoint('ftp://x/y').ok === false)
  check('空 / 非法 URL 不抛，明确失败',
    checkEndpoint('').ok === false && checkEndpoint('不是URL').ok === false)
  check('末尾斜杠被规范化掉（避免拼出 `//chat/completions`）',
    checkEndpoint('https://api.deepseek.com/').url === 'https://api.deepseek.com')
}

// ══════════════════════════════════════════════════════════════════════════
section('② resolveDirectTarget：key 复用既有三处来源，不新增配置字段')
// ══════════════════════════════════════════════════════════════════════════
{
  const base = { dsh: { model: 'deepseek-flash', apiKey: 'sk-from-config' }, wake: { judge: {} } }

  const a = resolveDirectTarget({ config: base, env: {} })
  check('★ key 取自 config.json 的 dsh.apiKey（发布包的主路径）',
    a.ok === true && a.apiKey === 'sk-from-config' && /dsh\.apiKey/.test(a.keySource ?? ''), a.keySource)
  check('★ 模型留空 ⇒ 回落到 dsh.model（不配也能跑）',
    a.model === 'deepseek-flash' && /dsh\.model/.test(a.modelSource ?? ''), a.modelSource)
  check('端点默认', a.baseUrl === 'https://api.deepseek.com', a.baseUrl)

  const b = resolveDirectTarget({
    config: { ...base, wake: { judge: { model: 'deepseek-v4-flash' } } },
    env: {},
  })
  check('★ wake.judge.model 显式给了就用它（换成更便宜的小模型是一次显式选择）',
    b.model === 'deepseek-v4-flash' && b.modelSource === 'wake.judge.model', b.model)

  const c = resolveDirectTarget({ config: base, env: { DEEPSEEK_API_KEY: 'sk-from-env' } })
  check('环境变量优先于配置文件（与 resolveModelCredentials 同口径）',
    c.apiKey === 'sk-from-env' && c.keySource === '环境变量', c.keySource)

  const d = resolveDirectTarget({ config: { dsh: { model: 'm', apiKey: '' }, wake: { judge: {} } }, env: {}, dshHome: null })
  check('★ 拿不到 key ⇒ 明确失败（而不是带着空 key 去请求）',
    d.ok === false && /key/.test(d.why ?? ''), d.why)

  const e = resolveDirectTarget({
    config: { dsh: { model: '', apiKey: 'k' }, wake: { judge: {} } },
    env: {},
  })
  check('★ 模型也拿不到 ⇒ 明确失败', e.ok === false && /模型/.test(e.why ?? ''), e.why)

  const f = resolveDirectTarget({
    config: { dsh: { model: 'm', apiKey: 'k' }, wake: { judge: { baseUrl: 'http://evil.example.com' } } },
    env: {},
  })
  check('★★ 端点不合规时**整个解析就失败**（不会带着 key 去请求）',
    f.ok === false && /key/.test(f.why ?? ''), f.why)
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 线协议：与 DSH 的 dsh-llm-deepseek 逐条对齐（写错会静默失效）')
// ══════════════════════════════════════════════════════════════════════════
{
  const cap = capture(() => fakeRes(200, { choices: [{ message: { content: '{"answer":true}' } }], usage: { total_tokens: 12 } }))
  const r = await chatOnce({
    baseUrl: 'https://api.deepseek.com', apiKey: 'sk-secret-value', model: 'deepseek-flash',
    prompt: '判一下', fetchImpl: cap.impl,
  })

  check('成功时把正文带回来', r.ok === true && r.text === '{"answer":true}', r.text)
  check('  并带上 usage（供日志用）', r.usage?.total_tokens === 12)
  check('  返回耗时 ms', Number.isFinite(r.ms))

  const { url, opts } = cap.calls[0]
  check('★★ 端点是 `${baseUrl}/chat/completions`，**没有 /v1**',
    url === 'https://api.deepseek.com/chat/completions', url)
  check('★ 认证头是 `authorization: Bearer <key>`（小写，与 DSH 一致）',
    opts.headers.authorization === 'Bearer sk-secret-value')
  check('  方法 POST + content-type json', opts.method === 'POST' && opts.headers['content-type'] === 'application/json')

  const body = JSON.parse(opts.body)
  check('★ 模型 id 原样发出去（DSH 模型表的 id 就是接口要的 id）', body.model === 'deepseek-flash', body.model)
  check('  单条 user 消息', body.messages?.length === 1 && body.messages[0].role === 'user' && body.messages[0].content === '判一下')
  check('★★ 思考显式关掉（`thinking:{type:"disabled"}`）—— 否则 reasoning 会吃掉 max_tokens、正文被截断',
    body.thinking?.type === 'disabled', JSON.stringify(body.thinking))
  check('  带 temperature 与 max_tokens', body.temperature === DIRECT_DEFAULTS.temperature && body.max_tokens === DIRECT_DEFAULTS.maxTokens)
  check('★ **不发 stream**（要一次完整 JSON）', body.stream === undefined)
  check('★★ **不发 response_format**（该适配器不认它；要 JSON 只能靠提示词 + 宽松解析）',
    body.response_format === undefined)
  check('★ 传入了 AbortSignal（能被取消）', opts.signal instanceof AbortSignal)
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 失败路径：都不抛，且 401/403/404 各有各的话术（别让人去查网络）')
// ══════════════════════════════════════════════════════════════════════════
{
  const at = (status, body, opts) => chatOnce({
    baseUrl: 'https://api.deepseek.com', apiKey: 'sk-secret-value', model: 'm', prompt: 'x',
    fetchImpl: capture(() => fakeRes(status, body, opts)).impl,
  })

  const bad401 = await at(401, { error: { message: 'Authentication Fails' } })
  check('401 → 明确说"API key 被拒"，并指出去哪查',
    bad401.ok === false && bad401.status === 401 && /API key 被拒/.test(bad401.why) && /dsh\.apiKey/.test(bad401.why),
    bad401.why)

  const bad404 = await at(404, { error: { message: 'Not Found' } })
  check('404 → 明确说"端点路径不对"，并点出**没有 /v1**',
    bad404.ok === false && /没有 \/v1/.test(bad404.why), bad404.why)

  const bad500 = await at(500, { error: { message: 'boom' } })
  check('500 → 如实报状态码 + body 片段', bad500.ok === false && /500/.test(bad500.why) && /boom/.test(bad500.why), bad500.why)

  const notJson = await at(200, null, { asText: '<html>gateway</html>' })
  check('响应不是 JSON → 明确失败（带片段）', notJson.ok === false && /不是 JSON/.test(notJson.why), notJson.why)

  const empty = await at(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }] })
  check('★ 没有正文 → 失败，并**带上 finish_reason**（length = 额度被吃光的典型症状）',
    empty.ok === false && /length/.test(empty.why), empty.why)

  // ★★ key 绝不能出现在任何对外文字里（错误信息会被写进日志、显示在界面上）
  for (const [label, r] of [['401', bad401], ['404', bad404], ['500', bad500], ['非 JSON', notJson]]) {
    check(`★★ ${label} 的失败理由里**不含 API key**`, !String(r.why).includes('sk-secret-value'), String(r.why).slice(0, 60))
  }

  const netErr = await chatOnce({
    baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'm', prompt: 'x',
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.deepseek.com') },
  })
  check('★ 网络层异常 → 不抛，如实报（DNS / 连接被拒 / 代理不通）',
    netErr.ok === false && /网络失败/.test(netErr.why) && /ENOTFOUND/.test(netErr.why), netErr.why)

  const noKey = await chatOnce({ baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'm', prompt: 'x' })
  check('没有 key → 明确失败，且**一次请求都不发**', noKey.ok === false && /没有 API key/.test(noKey.why))

  const noModel = await chatOnce({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: '', prompt: 'x' })
  check('没有模型 → 明确失败', noModel.ok === false && /没有指定模型/.test(noModel.why))

  const badEp = await chatOnce({ baseUrl: 'http://evil.example.com', apiKey: 'k', model: 'm', prompt: 'x' })
  check('★★ 端点不合规 → 明确失败，且**一次请求都不发**（key 不会出去）',
    badEp.ok === false && /key/.test(badEp.why), badEp.why)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 取消与超时：两者都要真的中断请求（判定器要能让路）')
// ══════════════════════════════════════════════════════════════════════════
{
  // 已取消：连 fetch 都不该调
  let called = 0
  const ac = new AbortController()
  ac.abort()
  const pre = await chatOnce({
    baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'm', prompt: 'x', signal: ac.signal,
    fetchImpl: async () => { called += 1; return fakeRes(200, {}) },
  })
  check('★ 开始前已取消 ⇒ 一次请求都不发，并标 aborted',
    pre.ok === false && pre.aborted === true && called === 0, pre.why)

  // 飞在半路被取消：fetch 收到 abort 信号后抛 AbortError
  const ac2 = new AbortController()
  const inflight = chatOnce({
    baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'm', prompt: 'x', signal: ac2.signal,
    fetchImpl: (u, o) =>
      new Promise((_, reject) => {
        o.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      }),
  })
  setTimeout(() => ac2.abort(), 10)
  const mid = await inflight
  check('★★ 飞行中被取消 ⇒ 明确报"被取消"（而不是含糊的超时/网络失败）',
    mid.ok === false && mid.aborted === true && /被取消/.test(mid.why), mid.why)

  // 超时：timeoutMs 很小 + 永不返回的 fetch
  //
  // ⚠️ 这里必须用一个**被引用的**定时器（setInterval）去等信号 abort：
  //    `AbortSignal.timeout()` 内部的定时器是 **unref** 的，而在这一节里除了它
  //    没有任何活动句柄 ⇒ 事件循环空转、promise 永不落地，Node 会以
  //    "unsettled top-level await"（退出码 13）收场。生产路径不受影响
  //    （桥接的事件循环一直被 socket 撑着），但这正好说明**测试自己得撑住循环**。
  let sawSignal = null
  const to = await chatOnce({
    baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'm', prompt: 'x', timeoutMs: 40,
    fetchImpl: (u, o) =>
      new Promise((_, reject) => {
        sawSignal = o.signal
        const iv = setInterval(() => {
          if (!o.signal.aborted) return
          clearInterval(iv)
          reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))
        }, 5)
      }),
  })
  check('★ 超时 ⇒ 报超时（带毫秒数），不抛', to.ok === false && /超时（40ms）/.test(to.why), to.why)
  check('  └ 超时**真的中止了请求**（传给 fetch 的 signal 被 abort）', sawSignal?.aborted === true)
}

console.log('')
if (failed === 0) {
  console.log(`🎉 直连模型通路测试全部通过（${passed} 项）`)
  console.log('   ⚠️ 这一套**不发真实网络请求**：fetch 全部是桩。')
  console.log('      "真机能不能连通 api.deepseek.com" 只能靠实际跑一次判定来验（本项目没有把它放进链条）。')
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
