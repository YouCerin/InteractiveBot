/**
 * 直连模型通路：**一次 HTTP 调用**（Chat Completions），给"需要额外一次模型调用"的功能用。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它现在服务于谁、以及**由谁决定走它**
 * ══════════════════════════════════════════════════════════════════════════
 * 唤醒判定器（`src/wake-judge.mjs`）是当前唯一的调用方。它走哪条路由
 * **`wake.judge.apiKey` 有没有值唯一决定**（0.2.3 用户决定）：
 *   · 留空 ⇒ **不走这里**，用一次性 DSH 进程（`runHeadless`）；
 *   · 填了 ⇒ 走这里，而且**只用那把 key**。
 * ∴ 这个模块**不读** `dsh.apiKey` / 环境变量 / DSH 凭据文件 —— 那是主对话的凭据。
 *   "额外的一次调用"要花就花在一把**专门给它的** key 上（计费与限流能分开看）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么加它（本项目一直没有直连模型的代码）
 * ══════════════════════════════════════════════════════════════════════════
 * 在此之前，唯一取证过的"额外一次调用"通路是**起一个一次性 DSH 进程**
 * （`dsh --profile headless`，`src/extract.mjs`）。它有两个代价：
 *   · **慢**：起 node 进程 + 完整初始化 harness，实测 2.8~4.4 秒；
 *   · **贵**：那一次调用带着整套系统提示词与工具表。
 * 唤醒判定器本来照抄了这条路，于是设计文档里那句
 * "判定比一整轮 agent 便宜一个数量级" **不成立**（见 `wake-judge.mjs` 顶部的更正）。
 * 这个模块把那次调用压成一次普通的 HTTP 请求：实测 **1092ms**，
 * 而且是**一次小 completion**，不是一轮 agent。
 *
 * ★ 顺带解锁的：`src/extract.mjs` 的回合后抽取（R4b）此前也卡在"没有这条通路"上，
 *   现在它有了同一个可用的底座。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 与 DSH 的关系：**不求新，只对齐**（这些是按源码逐条核对的，不是猜的）
 * ══════════════════════════════════════════════════════════════════════════
 * 取证来源：`@deepseek-ai/dsh-llm-deepseek/lib/index.js`
 *   · 端点：`POST ${baseURL}/chat/completions`，默认 `baseURL = "https://api.deepseek.com"`
 *     （**没有 `/v1`** —— 我们自己拼 `/v1` 会 404）
 *   · 认证：请求头 `authorization: Bearer <apiKey>`
 *   · 模型 id：DSH 的模型表里 `id` 就是**直接发给接口的 id**
 *     （`deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-pro` …），
 *     所以 `dsh.model` 可以**原样**用作直连的 model，不需要任何别名翻译
 *   · 思考开关：线上字段是 `thinking: { type: "disabled" | "enabled" }`
 *   · ★ **不要发 `response_format`**：该适配器不认它（源码里搜不到）。
 *     要 JSON 只能靠提示词 + `parseLooseJson`（`extract.mjs` 已经踩过这个坑）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 安全：这个模块会把 **API key 放进请求头**，所以有一条硬规矩
 * ══════════════════════════════════════════════════════════════════════════
 *   **只允许 https；http 只允许回环地址。**
 * 理由不是"防 SSRF"（`baseUrl` 是使用者自己配的，不像 QQ 消息里的图片地址
 * 那样由外人控制，见 `src/images.mjs` 那套逐跳校验针对的是另一类风险），
 * 而是**别把凭据明文发出去**：`Authorization` 头在明文 HTTP 上等于裸奔。
 * 回环那个例外是留给本地模型服务（Ollama / LM Studio / vLLM 之类）的 ——
 * 那是唯一一种"明文也无所谓"的正当用法。
 *
 * ⚠️ **没有做代理发现**（如实说明）：Node 的 `fetch` 默认不认 `HTTP_PROXY`/`HTTPS_PROXY`。
 *    需要走代理才能访问模型端点的网络环境，请把 `wake.judge.transport` 设成 `headless`
 *    —— 那条路由 DSH 自己去处理网络，这是保留它的主要理由。
 */

/** 直连的默认值。每个都写清为什么是这个数。 */
export const DIRECT_DEFAULTS = {
  /** 与 DSH 的 `dsh-llm-deepseek` 默认一致（注意**没有 `/v1`**）。 */
  baseUrl: 'https://api.deepseek.com',
  /**
   * 输出上限。判定只要一个小 JSON，给 300 足够；给大了只是给"跑飞"留空间。
   * ⚠️ 上限小的前提是**思考关掉**（见下面 `thinking`），否则 reasoning 会把额度吃光、
   * 正文被截断 —— 那种失败看起来像"模型没按格式回答"。
   */
  maxTokens: 300,
  /** 判定要的是稳定复现，不是创意。0.1 与 hermes 那边一致。 */
  temperature: 0.1,
  timeoutMs: 6000,
}

/** 回环主机名（http 明文只对这些放行）。 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/**
 * 这个端点允许我们把 key 发过去吗？
 *
 * @param {string} baseUrl
 * @returns {{ok: boolean, why?: string, url?: string}}
 */
export function checkEndpoint(baseUrl) {
  const raw = String(baseUrl ?? '').trim()
  if (!raw) return { ok: false, why: '端点为空' }
  let u
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, why: `端点不是合法 URL：${raw}` }
  }
  if (u.protocol === 'https:') return { ok: true, url: u.origin + u.pathname.replace(/\/+$/, '') }
  if (u.protocol === 'http:') {
    if (LOOPBACK_HOSTS.has(u.hostname)) return { ok: true, url: u.origin + u.pathname.replace(/\/+$/, '') }
    return {
      ok: false,
      why:
        `拒绝把 API key 明文发到 ${u.hostname}（http 只允许回环地址）。` +
        '要用自建端点请给它配 https；本地模型服务用 http://127.0.0.1 是可以的。',
    }
  }
  return { ok: false, why: `不支持的协议「${u.protocol}」` }
}

/**
 * 解析本次直连要用的端点 / 模型 / key。
 *
 * ★★ **key 只认 `wake.judge.apiKey`（判定专用那一把）**，0.2.3 用户决定：
 *   **填了才走直连，而且只用这把 key** —— 不拿 `dsh.apiKey` / 环境变量 / DSH 凭据文件
 *   去替它发请求。那三处是**主对话**的凭据；判定是"额外的一次调用"，
 *   要花就花在一把**专门给它的** key 上（于是计费与限流能分开看）。
 *   ⇒ 所以"走直连却没有 key"在结构上不可能发生，`resolveDirectTarget` 返回 `ok:false`
 *   只可能是端点不合法或模型解析不出来。
 *
 * @param {object} opts
 * @param {object} opts.config        归一化后的配置
 * @returns {{ok: boolean, baseUrl?: string, model?: string, apiKey?: string,
 *            modelSource?: string, why?: string}}
 */
export function resolveDirectTarget({ config } = {}) {
  const judge = config?.wake?.judge ?? {}
  const ep = checkEndpoint(judge.baseUrl ?? DIRECT_DEFAULTS.baseUrl)
  if (!ep.ok) return { ok: false, why: ep.why }

  const apiKey = String(judge.apiKey ?? '').trim()
  if (!apiKey) {
    return { ok: false, why: '没有配置 wake.judge.apiKey（判定专用 key）—— 留空时应该走一次性 DSH 进程' }
  }

  // 模型：留空就用主对话那个（`dsh.model`，默认 deepseek-flash）。
  // ★ 这是刻意的默认：DSH 的模型 id 可以原样直连，所以"不配也能跑"；
  //   而"换一个更便宜的小模型"应当是一次**显式**选择（那是省钱，不是默认行为）。
  const explicit = String(judge.model ?? '').trim()
  const model = explicit || String(config?.dsh?.model ?? '').trim()
  if (!model) return { ok: false, why: '没有可用的模型：wake.judge.model 与 dsh.model 都是空的' }

  return {
    ok: true,
    baseUrl: ep.url,
    model,
    apiKey,
    modelSource: explicit ? 'wake.judge.model' : 'dsh.model（未单独指定）',
  }
}

/** 把响应体压成一行短摘要（**绝不回显 key**，也绝不打整段 body）。 */
function briefBody(text, max = 160) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * 抽取（回合后提炼配方）走直连时的参数。**与判定那套刻意不同**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么不能直接复用 `DIRECT_DEFAULTS`
 * ══════════════════════════════════════════════════════════════════════════
 * `DIRECT_DEFAULTS.maxTokens = 300` 是按**判定器**调的 —— 它只要一个小 JSON
 * （`{answer:true,reason:"…"}`）。而抽取要输出一整份配方
 * （`title` + `keywords` ×3 + `steps` ×3 + `pitfalls` + `verify`），**10 倍以上**。
 * 用 300 的直接后果是**正文被截断**，而截断的表现是"解析不出 JSON"——
 * 看起来像模型的格式问题，实际是我们给的额度不够。这类"我们的锅看起来像它的锅"
 * 是最费时间的一种排查，所以这里单独一组默认值，并写明数字的来源。
 *
 * ⚠️ 温度仍用 0.1：抽取要的是**稳定可复现**，不是创意（与判定同一条理由）。
 * ⚠️ 超时比判定长：判定要求 0~6 秒内给结论（它挡在回复前面），
 *    而抽取是后台跑的（`--maybeExtractRecipe` 不 await），宽松一点没有代价。
 */
export const EXTRACT_DIRECT_DEFAULTS = {
  /** 一份配方的 JSON 实测约 300~800 token；给 1600 留足余量（思考关掉时更宽裕）。 */
  maxTokens: 1600,
  temperature: 0.1,
  timeoutMs: 30_000,
}

/**
 * 抽取走直连时的目标（端点 / 模型 / key）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 与 `resolveDirectTarget`（判定用）的唯一区别：**key 从哪来**
 * ══════════════════════════════════════════════════════════════════════════
 * 判定器有一把**专用 key**（`wake.judge.apiKey`），理由写在那个函数里：
 * 「要花就花在一把专门给它的 key 上，于是计费与限流能分开看」。
 * 而抽取**不是另一件事**：它就是"用主对话那套模型再做一次小调用"，
 * 所以用**主模型那把 key**（控制台填的 `dsh.apiKey`，或 `DSH_HOME/.credentials.yaml`
 * 里那份 —— 由调用方解析后传进来）。这样账是合在主线上的，也符合直觉。
 *
 * @param {object} opts
 * @param {object} opts.config    归一化后的配置
 * @param {string} [opts.apiKey]  已解析好的主模型 key（凭据文件那条路的产物）
 * @returns {{ok: boolean, baseUrl?: string, model?: string, apiKey?: string, keySource?: string, why?: string}}
 */
export function resolveExtractTarget({ config, apiKey = '' } = {}) {
  // 端点固定用默认那个：`dsh` 段里没有 baseUrl 这个键（provider 由 DSH 自己解析），
  // 所以这里不引入新配置项 —— 新增配置键会牵动界面与文档一整套（AGENT.md 第 7 条）。
  const ep = checkEndpoint(DIRECT_DEFAULTS.baseUrl)
  if (!ep.ok) return { ok: false, why: ep.why }

  const fromConfig = String(config?.dsh?.apiKey ?? '').trim()
  const key = String(apiKey ?? '').trim() || fromConfig
  if (!key) {
    return {
      ok: false,
      why: '拿不到主模型 key（`dsh.apiKey` 与 `DSH_HOME/.credentials.yaml` 都没有）—— 抽取退回一次性 DSH 进程',
    }
  }
  const model = String(config?.dsh?.model ?? '').trim()
  if (!model) return { ok: false, why: '`dsh.model` 是空的，不知道该调哪个模型' }

  return {
    ok: true,
    baseUrl: ep.url,
    model,
    apiKey: key,
    keySource: String(apiKey ?? '').trim() ? 'DSH_HOME/.credentials.yaml' : 'config.dsh.apiKey',
  }
}

/**
 * 一次直连调用。
 *
 * 纪律（与 `runHeadless` 一致，都是"增强路径"）：
 *   · **绝不抛**：任何失败都返回 `{ok:false, why}`；
 *   · **有超时**，且**接受外部 AbortSignal**（判定器要能取消）；
 *   · 日志/错误里**不出现 key**。
 *
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {string} opts.prompt        单条 user 消息（判定器/抽取都是这个形状）
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.fetchImpl]
 *   可注入（测试用桩；默认全局 fetch）。契约：返回一个 **Response 形状**的对象
 *   —— 只需要 `ok` / `status` / `text()` 三样（不必是真的 `Response`）。
 * @param {string} [opts.label]       报错文案用
 * @returns {Promise<{ok: boolean, text?: string, why?: string, ms: number,
 *                    status?: number, usage?: object, aborted?: boolean}>}
 */
export async function chatOnce({
  baseUrl,
  apiKey,
  model,
  prompt,
  images = [],
  timeoutMs = DIRECT_DEFAULTS.timeoutMs,
  maxTokens = DIRECT_DEFAULTS.maxTokens,
  temperature = DIRECT_DEFAULTS.temperature,
  signal,
  fetchImpl,
  label = '直连调用',
} = {}) {
  const started = Date.now()
  const ms = () => Date.now() - started
  const ep = checkEndpoint(baseUrl)
  if (!ep.ok) return { ok: false, why: ep.why, ms: ms() }
  if (!apiKey) return { ok: false, why: '没有 API key', ms: ms() }
  if (!model) return { ok: false, why: '没有指定模型', ms: ms() }
  if (signal?.aborted) return { ok: false, why: `${label}在开始前已被取消`, ms: ms(), aborted: true }

  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    return { ok: false, why: '这个 Node 运行时没有 fetch（需要 >= 18，本项目要求 >= 22）', ms: ms() }
  }

  /**
   * 内容块：默认纯文本；给了图就是多模态数组。
   *
   * ★ 0.2.4 加 `images` 的**唯一**用途是表情包的**离线打标签**（`scripts/sticker-tag.mjs`）。
   *   为什么值得加：打标签必须"看图"，而在此之前直连只能发文本 —— 于是那个脚本
   *   只能起一次性 DSH 进程（带上整套系统提示词与工具表，为一次分类调用付一个
   *   agent 的价格）。这里加一条 `image_url` 通道，成本就回到"一次小 completion"。
   *
   * ⚠️ **必须用支持图片输入的模型**（`dsh.model` 默认的 `deepseek-flash` 支持）。
   *    不支持时接口会报错，脚本要把它翻成人话（不要抛原始 JSON）。
   */
  const content =
    Array.isArray(images) && images.length > 0
      ? [
          { type: 'text', text: String(prompt ?? '') },
          ...images.map((img) => ({
            type: 'image_url',
            image_url: { url: String(img?.dataUrl ?? img?.url ?? '') },
          })),
        ]
      : String(prompt ?? '')

  // 超时与外部取消合并成一个信号：两者任一触发都立刻中止请求
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const anySignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  let res
  try {
    res = await doFetch(`${ep.url}/chat/completions`, {
      method: 'POST',
      headers: {
        // ⚠️ 这一行是"明文只走回环"那条规矩存在的唯一理由
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        // 关掉思考：判定要的是**快和稳定**，而且 max_tokens 给得小，
        // 开着思考会先把额度花在 reasoning 上、正文被截断（看起来像"没按格式答"）
        thinking: { type: 'disabled' },
        temperature,
        max_tokens: maxTokens,
        // 不发 stream（要一次完整 JSON）；也**不发 response_format**（该适配器不认，见文件头）
      }),
      signal: anySignal,
    })
  } catch (error) {
    if (signal?.aborted) return { ok: false, why: `${label}被取消`, ms: ms(), aborted: true }
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return { ok: false, why: `${label}超时（${timeoutMs}ms）`, ms: ms() }
    }
    // 网络层失败（DNS / 连接被拒 / 代理不通）：如实报，按"放过"处理
    return { ok: false, why: `${label}网络失败：${error?.message ?? error}`, ms: ms() }
  }

  const raw = await res.text().catch(() => '')
  if (!res.ok) {
    // ★ 401/403 单独说清：这是**唯一**会让使用者知道"key 不对"的地方，
    //   含糊成"接口失败"会让人去查网络。
    const hint =
      res.status === 401 || res.status === 403
        ? '（API key 被拒 —— 检查 dsh.apiKey / DEEPSEEK_API_KEY / 凭据文件）'
        : res.status === 404
          ? '（端点路径不对 —— 注意默认是 https://api.deepseek.com，**没有 /v1**）'
          : ''
    return { ok: false, why: `${label}接口返回 ${res.status}${hint}：${briefBody(raw)}`, ms: ms(), status: res.status }
  }

  let json = null
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, why: `${label}响应不是 JSON：${briefBody(raw)}`, ms: ms(), status: res.status }
  }
  const text = String(json?.choices?.[0]?.message?.content ?? '').trim()
  if (!text) {
    const fin = json?.choices?.[0]?.finish_reason
    return {
      ok: false,
      why: `${label}没有输出正文${fin ? `（finish_reason=${fin}）` : ''}：${briefBody(raw, 120)}`,
      ms: ms(),
      status: res.status,
    }
  }
  return { ok: true, text, ms: ms(), status: res.status, usage: json?.usage ?? null }
}
