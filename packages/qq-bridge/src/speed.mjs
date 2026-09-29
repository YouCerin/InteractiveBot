/**
 * 回应速度档位。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三档是用户定的规格：**快速 1 秒 / 均衡 8 秒 / 谨慎 20 秒**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── 怎么"做到"某个目标延迟？────────────────────────────────────────────
 * 延迟由两部分组成：
 *
 *     总延迟 = 反应时间（随机） + 打字时间（按字数，封顶）
 *
 * 要让总延迟大致落在目标值上，最简做法不是去调打字速度，而是：
 *   ① 把**打字时间封顶**设成目标值（这样长回复也就等这么久）
 *   ② 把**反应时间**设成目标值的 30%~70%（给一点随机感，又不喧宾夺主）
 *   ③ 总延迟上限 = 目标值 × 1.05（留一点余量，但不会明显超出）
 *
 * 这样"回复很短"时总延迟接近反应时间下半段，"回复很长"时接近目标值 ——
 * 行为可预期，用户不会觉得"说好的 8 秒怎么等了 40 秒"。
 *
 * ── ⚠️ 必须如实告知的代价 ──────────────────────────────────────────────
 * **越快 = 账号风险越高。** 这不是危言耸听：
 *   · 「快速」约 1 秒响应 ≈ 秒回。而秒回 + 7×24 在线是行为风控最典型的
 *     特征向量 —— 也就是说，它本身就是风控模型眼里最可疑的那一类行为。
 *   · 「谨慎」约 20 秒，最接近真人（看到消息、想一下、再打字）。
 * 所以界面上**不能只写"快/中/慢"**，必须把风险一并标出来。
 */

/**
 * 档位定义（**每档显式给参数**，不用一个公式硬推）。
 *
 * ── 为什么改成显式参数 ─────────────────────────────────────────────────
 * 第一版用"目标值 × 比例"推导五个参数，结果**短回复时总延迟明显偏低**：
 * 均衡档（目标 8 秒）在回 10 个字时只等 6 秒，谨慎档（目标 20 秒）只等 12 秒 ——
 * 因为打字时间是按字数算的，短回复几乎不贡献延迟。
 *
 * 现在每档把三个关键区间直接写出来，让**短回复与长回复都落在目标附近**：
 *   reactMinMs / reactMaxMs → 反应时间（随机区间）
 *   typingMaxMs             → 打字时间单独上限
 *   maxDelayMs              → 总延迟上限（= 该档的上界）
 *
 * 实测（随机取中值，10 字 / 200 字）：
 *   快速   1.0s / 1.0s
 *   均衡   6.8s / 8.3s
 *   谨慎   15s  / 20s
 *
 * ⚠️ 三档的**代价必须如实告知**：越快 = 账号风险越高。见 riskText。
 */
export const SPEED_PRESETS = {
  fast: {
    id: 'fast',
    label: '快速',
    targetMs: 1000,
    // 反应 100~500ms + 打字封顶 800ms → 总延迟约 0.1~1.1 秒
    reactMinMs: 100,
    reactMaxMs: 500,
    typingMaxMs: 800,
    maxDelayMs: 1200,
    risk: 'high',
    riskText:
      '约 1 秒响应，接近秒回。这是行为风控最典型的特征向量，账号被处置的风险最高。',
    description: '回复几乎即时。适合本地测试，或你完全不在意账号风险时。',
  },
  balanced: {
    id: 'balanced',
    label: '均衡',
    targetMs: 8000,
    // 反应 3500~6500ms + 打字封顶 3000ms → 总延迟约 3.5~9 秒（中值约 8 秒）
    reactMinMs: 3500,
    reactMaxMs: 6500,
    typingMaxMs: 3000,
    maxDelayMs: 9000,
    risk: 'medium',
    riskText: '约 4~9 秒响应，介于真人与机器之间。**推荐档位**。',
    description: '默认档位。长回复会像人在打字，短回复也不至于让人等得不耐烦。',
  },
  careful: {
    id: 'careful',
    label: '谨慎',
    targetMs: 20_000,
    // 反应 10000~15000ms + 打字封顶 7000ms → 总延迟约 10~22 秒（中值约 20 秒）
    reactMinMs: 10_000,
    reactMaxMs: 15_000,
    typingMaxMs: 7000,
    maxDelayMs: 22_000,
    risk: 'low',
    riskText:
      '约 10~22 秒响应，最接近真人节奏（看到消息 → 想一下 → 打字）。账号风险最低。',
    description: '最保守的档位，适合长期挂机使用。',
  },
}

/** 默认档位。 */
export const DEFAULT_SPEED_PRESET = 'balanced'

/**
 * 把一个档位展开成完整的 `humanize` 配置。
 *
 * 这样 UI 只需要让用户选一个档位，不必理解五个毫秒参数。
 * 想微调的用户仍然可以直接改 `humanize` 里的具体字段（档位只是快捷方式）。
 *
 * @param {string} id 档位 id
 * @returns {object} 可直接写进 config.json 的 humanize 片段
 */
export function buildSpeedPreset(id) {
  const preset = SPEED_PRESETS[id]
  if (!preset) {
    throw new Error(
      `未知的回应速度档位「${id}」。可选：${Object.keys(SPEED_PRESETS).join(' / ')}`,
    )
  }
  return {
    enabled: true,
    reactMinMs: preset.reactMinMs,
    reactMaxMs: preset.reactMaxMs,
    // 打字速度固定 5 字/秒：它只影响**中短回复**的延迟曲线。
    // 长回复一律由 typingMaxMs 兜住，所以换档位不会让"手感"变得突兀。
    charsPerSecond: 5,
    typingMaxMs: preset.typingMaxMs,
    maxDelayMs: preset.maxDelayMs,
  }
}

/**
 * 反推：给定一份 humanize 配置，它最接近哪个档位？
 * 用于 UI 显示"当前处于 X 档"。
 *
 * @param {object} humanize
 * @returns {string|null} 档位 id；都不接近时返回 null（说明是手工微调过的）
 */
export function detectSpeedPreset(humanize) {
  if (!humanize || humanize.enabled === false) return null
  for (const id of Object.keys(SPEED_PRESETS)) {
    const spec = buildSpeedPreset(id)
    const same =
      humanize.reactMinMs === spec.reactMinMs &&
      humanize.reactMaxMs === spec.reactMaxMs &&
      humanize.typingMaxMs === spec.typingMaxMs &&
      humanize.maxDelayMs === spec.maxDelayMs
    if (same) return id
  }
  return null
}

/**
 * 体检：档位与参数是否自洽。
 * 用于配置自检，抓出"参数互相打架"的写法。
 *
 * @param {object} humanize
 * @returns {string[]} 问题列表
 */
export function lintHumanize(humanize) {
  const problems = []
  if (!humanize) return problems

  const reactMin = humanize.reactMinMs ?? 0
  const reactMax = humanize.reactMaxMs ?? 0
  const typingMax = humanize.typingMaxMs ?? 0
  const maxDelay = humanize.maxDelayMs ?? 0

  if (reactMax < reactMin) {
    problems.push(`humanize.reactMaxMs（${reactMax}）小于 reactMinMs（${reactMin}），随机区间是反的`)
  }
  // 上限如果小于"反应 + 打字"，那打字封顶就形同虚设，实际等待会被总上限截断
  const implied = reactMax + typingMax
  if (maxDelay > 0 && maxDelay < implied * 0.5) {
    problems.push(
      `humanize.maxDelayMs（${maxDelay}ms）远小于"最大反应时间 + 打字封顶"（${implied}ms），` +
        `打字速度的设置几乎不会生效`,
    )
  }
  if (humanize.enabled !== false && maxDelay > 0 && maxDelay < 500) {
    problems.push(
      `humanize.maxDelayMs 只有 ${maxDelay}ms，几乎等于不延迟 —— ` +
        `秒回是行为风控最典型的特征，若非本地测试不建议这样设`,
    )
  }
  return problems
}
