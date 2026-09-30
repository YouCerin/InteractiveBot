/**
 * ★★ **通用模型闸门**（2026-09-30 从 `wake-judge.mjs` 里抽出来的那一层）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须抽出来（而不是给第二个判定器再抄一份）
 * ══════════════════════════════════════════════════════════════════════════
 * 一段"问模型一个是/否问题"的代码里，真正容易错、也最不该分叉的不是提示词，
 * 而是这些**政策**：通路选择（直连 / 一次性进程）、小时预算、超时、
 * 判不出来时算哪个结论、`via` 证据、token 计量、调用异常兜底。
 * 抄一份出来 = 两个判定器在这些政策上迟早会不一致，而**不一致的表现是静默的**
 * （一个超时 6 秒、另一个 30 秒；一个记账、另一个不记）。
 *
 * 所以政策收在这一处，调用方只给三样**真正不同的东西**：
 *   · `buildPrompt(input)` —— 提示词怎么写；
 *   · `parseVerdict(raw)`  —— 输出怎么解析（返回 `{ok, verdict, reason, via}`）；
 *   · `failVerdict`        —— **判不出来时算哪个结论**。它必须由调用方给，因为
 *     两个使用者的方向**正好相反**：
 *       · 唤醒判定 → `answer`（放过）：宁可多回一句，也不能因为判定器罢工而变哑巴；
 *       · 情绪闸门 → `not-to-bot`（不记）：**记错了会长期留在档案里**，宁可不记。
 *
 * ⚠️ 抽取时行为必须与抽取前逐字一致 —— `verify-wake.mjs` 那些断言是验收标准
 *   （它现在**换成经 `wake-judge.mjs` 间接**验证这一层，这正是它该有的位置）。
 */

import { runHeadless } from './extract.mjs'
import { chatOnce, DIRECT_DEFAULTS } from './model-direct.mjs'

/** 通路与预算的默认值（两个判定器共用；各自可以覆盖）。 */
export const GATE_DEFAULTS = {
  /** 单次判定的超时。★ 唤醒判定那边要求它**小于** `humanize.interim.afterMs`（8000）。 */
  timeoutMs: 6000,
  /** 每小时最多判多少次 —— **唯一**挡住"最坏情况"的东西（被刷屏的群能把机器打满）。 */
  maxPerHour: 60,
}

/**
 * 把接口返回的用量**归一化**成本项目内部的口径（`{input, cacheRead, output}`）。
 *
 * ★ 为什么要归一化而不是原样带走：报表要拿它估成本，而 `prices.mjs` 的
 *   `estimateCost()` 认的是 `{input, cacheRead, output}` —— 而直连接口给我们的是
 *   `{prompt_tokens, completion_tokens, prompt_cache_hit_tokens, prompt_cache_miss_tokens}`。
 *   两套名字对不上的后果是**成本静默算不出来**（`estimateCost` 会返回 null，
 *   报表显示 `—`，看起来像"没配价目表"）。
 * ★ 走一次性 DSH 进程那条路**拿不到用量** ⇒ 返回 null。报表必须如实标出这一点
 *   （否则"成本偏低"会被当成真实成本）。
 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const cacheRead = Number(usage.prompt_cache_hit_tokens) || 0
  const miss = Number(usage.prompt_cache_miss_tokens)
  const input = Number.isFinite(miss) ? miss : Number(usage.prompt_tokens) || 0
  const output = Number(usage.completion_tokens) || 0
  if (!input && !cacheRead && !output) return null
  return { input, cacheRead, output }
}

/**
 * 建一个"问模型一个是/否问题"的闸门。
 *
 * ⚠️ 它**故意做成有状态的对象**（只有那个小时预算计数器），因为计数必须跨消息累积。
 *   除此之外没有任何状态 —— 可以随时丢掉重建（纪律④）。
 *
 * @param {object} opts
 * @param {(input: object) => string} opts.buildPrompt
 * @param {(raw: string) => {ok: boolean, verdict?: string, reason?: string, via?: string, why?: string}} opts.parseVerdict
 * @param {string} opts.failVerdict 判不出来时的结论
 * @param {string} [opts.tag] 日志前缀（`[wake]` / `[affect-gate]`）
 * @param {'http'|'headless'} [opts.transport] 默认 `'http'`（快、便宜）；`'headless'` 是逃生舱
 * @param {string} [opts.baseUrl]       直连端点（默认与 DSH 适配器一致：https://api.deepseek.com）
 * @param {string} [opts.apiKey]        直连用的 key（由 `resolveDirectTarget()` 解析好后传进来）
 * @param {string} [opts.model]         直连用的模型 id
 * @param {number} [opts.maxTokens]     直连的 max_tokens
 * @param {number} [opts.temperature]   直连的温度
 * @param {string} [opts.cliPath]       transport='headless' 时用：dsh 的 lib/bin.js
 * @param {string} [opts.cwd]           transport='headless' 时用：工作区（子进程的 cwd）
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxPerHour]
 * @param {Function} [opts.runner]
 *   可注入的**整体调用函数**（测试用桩）。契约：
 *   `async ({prompt, signal, timeoutMs}) => {ok, text?, why?, ms?, usage?}`。
 *   ★ 它收的是**归一化后的形状**（不是 `runHeadless` 的参数），
 *     这样 HTTP 与 headless 两条通路对判定器是同一个东西，测试也不用关心走的哪条。
 * @param {Function} [opts.log]
 * @param {Function} [opts.now]         时间源（测试用；默认 Date.now）
 * @param {string} [opts.label]         报错文案
 */
export function createModelGate({
  buildPrompt,
  parseVerdict,
  failVerdict,
  tag = 'judge',
  transport = 'http',
  baseUrl = DIRECT_DEFAULTS.baseUrl,
  apiKey = '',
  model = '',
  maxTokens = DIRECT_DEFAULTS.maxTokens,
  temperature = DIRECT_DEFAULTS.temperature,
  cliPath,
  cwd,
  timeoutMs = GATE_DEFAULTS.timeoutMs,
  maxPerHour = GATE_DEFAULTS.maxPerHour,
  runner = null,
  log = () => {},
  now = () => Date.now(),
  label = '判定',
} = {}) {
  /** 最近一小时内的判定时间戳（滑动窗口；只留最近 maxPerHour 条）。 */
  let stamps = []

  /**
   * 真正去问模型那一步。
   *
   * 两条通路的差别**只在这一个函数里** —— 判定逻辑（提示词、解析、兜底、预算）
   * 完全共用，否则"直连"就会悄悄变成第二套判定行为。
   */
  const callModel =
    runner ??
    (transport === 'headless'
      ? ({ prompt, signal, timeoutMs: t }) => runHeadless({ cliPath, prompt, cwd, timeoutMs: t, label, signal })
      : ({ prompt, signal, timeoutMs: t }) =>
          chatOnce({ baseUrl, apiKey, model, prompt, timeoutMs: t, maxTokens, temperature, signal, label }))

  /** 这个通路此刻能不能用（建不起来就别浪费一次判定）。 */
  function transportReady() {
    // ★ 注入了整体调用函数（测试桩 / 上层接管）⇒ 那条通路由调用方负责。
    //   不这样写的话，桩测试还得先假装配好 key 或 cliPath，测的就不是判定逻辑了。
    if (runner) return true
    if (transport === 'headless') return Boolean(cliPath && cwd)
    return Boolean(apiKey && model)
  }

  /** 这次判定花掉一个额度了吗 —— 先看再记账，超了就不记账也不调用。 */
  function takeBudget() {
    const t = now()
    stamps = stamps.filter((s) => t - s < 3_600_000)
    if (stamps.length >= maxPerHour) return false
    stamps.push(t)
    return true
  }

  /**
   * 判一条消息。
   *
   * @param {object} input 见调用方的 `buildPrompt`
   * @param {{signal?: AbortSignal}} [opts]
   * @returns {Promise<{verdict: string, reason: string, judged: boolean,
   *                    fallback: boolean, why?: string, ms: number, usage?: object}>}
   *   · `judged:false` = **压根没问模型**（通路没配好 / 超预算 / 已取消）⇒ 按 `failVerdict`；
   *   · `fallback:true` = 问了但结论不可用 ⇒ 按 `failVerdict`。
   */
  async function judge(input, { signal } = {}) {
    const t0 = now()
    const answer = (why, extra = {}) => ({
      verdict: failVerdict,
      reason: '',
      judged: false,
      fallback: false,
      why,
      ms: now() - t0,
      ...extra,
    })

    // 纪律①：任何一条"不能判"的理由都通向 `failVerdict`。顺序是先便宜后昂贵。
    if (!transportReady()) {
      return answer(
        transport === 'headless'
          ? `headless 通路没配好（需要 dsh.cliPath 与 dsh.workspace）`
          : `直连通路没配好（需要 API key 与模型名）`,
      )
    }
    if (signal?.aborted) return answer('判定开始前已被取消')
    if (!takeBudget()) {
      log(`[${tag}] 本小时判定次数已达上限（${maxPerHour}），这一条按 ${failVerdict} 处理`)
      return answer(`本小时判定次数已达上限（${maxPerHour}）`)
    }

    const prompt = buildPrompt(input)
    let r
    try {
      r = await callModel({ prompt, signal, timeoutMs })
    } catch (error) {
      // 调用层自己抛了（桩、或 fetch/spawn 意外）—— 照样不能影响聊天
      return answer(`判定调用异常：${error?.message ?? error}`, { fallback: true })
    }
    if (!r?.ok) {
      // ★ 原文片段必须进日志（`extract.mjs` 那条血的教训：只记 why 的话，
      //   真机上就只剩一句"解析不出来"，没法写回归测试）
      const hint = r?.text ? `｜原文前 200 字：${String(r.text).slice(0, 200)}` : ''
      log(`[${tag}] 判定未成功（按 ${failVerdict} 处理）：${r?.why ?? '未知原因'}${hint}`)
      return answer(r?.why ?? '判定未成功', { fallback: true })
    }

    const parsed = parseVerdict(r.text)
    if (!parsed.ok) {
      log(`[${tag}] 判定输出认不出来（按 ${failVerdict} 处理）：${parsed.why}｜原文前 200 字：${String(r.text).slice(0, 200)}`)
      return answer(parsed.why, { fallback: true })
    }
    // ★★ 模型没照格式写时**必须留下证据**：`via !== 'json'` 说明这一段结论是从
    //    宽松 JSON / 纯文本配对 / 明确短语里救回来的。以前这件事是完全隐形的 ——
    //    救不回来就静默 fail-open，救回来了也没人说，于是"提示词没被遵守"这个
    //    信号**永远不会浮出水面**（也就永远没人去改提示词）。
    if (parsed.via && parsed.via !== 'json') {
      log(
        `[${tag}] ⚠️ 判定输出不是标准 JSON（via=${parsed.via}），已救回结论=${parsed.verdict}` +
          `｜原文前 200 字：${String(r.text).slice(0, 200)}`,
      )
    }
    return {
      verdict: parsed.verdict,
      reason: parsed.reason,
      judged: true,
      fallback: false,
      ms: now() - t0,
      // `via` 一路带出去（进 oplog 行）：它是"模型有没有照格式写"的唯一观测点
      via: parsed.via,
      // token 用量：**不进 `usage` 账本**（那是按回合的），但**要进 oplog 行** ——
      // 报表靠它回答"影子/生效这一段时间花了多少"。缺了它，成本那一栏永远是 `—`。
      tokens: normalizeUsage(r.usage),
      // 原始响应体也带出去（排查用，不进 oplog）
      usage: r.usage ?? null,
    }
  }

  /** 诊断用：本小时已用额度（只读）。 */
  function budget() {
    const t = now()
    stamps = stamps.filter((s) => t - s < 3_600_000)
    return { used: stamps.length, maxPerHour, timeoutMs, transport, model: model || null, baseUrl: baseUrl || null }
  }

  return { judge, budget }
}
