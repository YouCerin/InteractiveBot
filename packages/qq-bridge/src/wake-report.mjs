/**
 * 唤醒判定报表（影子模式的**兑现路径**）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它解决什么：影子模式的记录有了，但"没人看"就等于没有
 * ══════════════════════════════════════════════════════════════════════════
 * `#wakeGate` 每条判定都会往 `runtime/oplog/<会话>-<天>.jsonl` 写一行 `type:'wake'`
 * （无论 `shadow` 开不开）。但那张日志是**为回合设计的**（`--ops` 按 `{turn}/{step}`
 * 对齐渲染），wake 行没有这两个字段，打出来是畸形的 `t?s?   wake`。
 * ⇒ 结论有地方写、**没有地方看**。这个模块就是"看"的那一半。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 报表要回答的那个问题：「开了会怎样」
 * ══════════════════════════════════════════════════════════════════════════
 * 光有"本会拦掉 N 条"是不够的 —— 那只能说明它**会**拦，不能说明它**拦得对**。
 * 判定器判错有两个方向，而它们的严重性差着一个数量级：
 *
 *   · 该沉默却回了 → 多一句废话（**而且现状本来就是这样**，没人会注意到）；
 *   · **该回却沉默了 → 那个人永远等不到回复，且系统里、群里、日志里都没有
 *     "有人被辜负了"的痕迹** —— 这是**"没发生的事"**，天生不可观测。
 *
 * ∴ 报表的核心不是统计，是**把"本会拦下"的样本摊出来供人逐条复核**，
 *   并据此算出一个数：**漏回率**。设计文档 §10.5 的原话是"这个抽样复核是影子模式的
 *   全部价值所在"，并要求把它作为"允不允许真正开启"的硬指标。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三条如实说明（报表自己必须说清，否则会被误读）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **它有寿命**：oplog 按天分文件、每天 2MB 上限、**7 天 TTL**。
 *      所以报表必须报出"我实际读到了多长的窗口"，并提醒窗口之外的已经没了 ——
 *      不然"只拦了 5 条"会被当成"判定器很少沉默"，而真相可能是"记录更早就没了"。
 *   ② **它不省一分钱**：影子模式下判定照样调模型。它是"同样花钱，只把结论留在本地"。
 *   ③ **它测不了"多回一句"的代价**：判据错在"放过"方向时，影子里和生效后看起来一样。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么聚合是**纯函数**
 * ══════════════════════════════════════════════════════════════════════════
 * `summarizeWakeOps()` 只吃一个数组、吐一个对象，不读盘、不看时间（`now` 可注入）。
 * 这样它能被离线测（`mocks/verify-wake-report.mjs`），而"读哪些文件"那点逻辑留在
 * `index.mjs` 的 CLI 里。**统计口径是最容易悄悄错的东西**（分错一栏、算错一个比例
 * 都不会报错，只会给出一个看起来合理的数），所以它必须有断言盯着。
 */

/** 标注文件（工作区相对路径）。只存"人怎么看这条结论"，不存聊天原文。 */
export const WAKE_LABELS_REL = 'runtime/wake-labels.json'

/**
 * 漏回率的**建议**上限。
 *
 * ★ 这是**本项目的建议值，不是硬性规定** —— 报表**只报数、不做决定**
 *   （自动决定会让"谁负责"这件事含糊掉，而这里要负的是"有人被无视"的责任）。
 * 取 5% 的理由：判定器是**加法风险**（它只会让机器人少说话），而"该回却没回"
 * 是最难被发现的失败；超过二十分之一意味着"每 20 条该回的话里就有 1 条被吞掉"，
 * 那个量级已经开始像"这机器人坏了"而不是"它今天很安静"。
 */
export const MISS_RATE_ADVISORY = 0.05

/** 报表默认列多少条样本供人工复核（太多没人看，太少不够判断）。 */
export const DEFAULT_SAMPLE_LIMIT = 30

/** 一行的 `verdict` 取值（与 `wake-judge.mjs` 的 VERDICT 同口径，这里不 import 以免循环）。 */
const SILENT = 'silent'

function pct(n, d) {
  if (!d) return 0
  return n / d
}

/** 百分比显示：0.1348 → `13.5%`；分母为 0 → `—`（不是 `0%`，那会骗人）。 */
function pctText(n, d) {
  if (!d) return '—'
  return `${(pct(n, d) * 100).toFixed(1)}%`
}

/** 中位数 / p95 / 最大（都只吃排好序的数字数组）。 */
function quantile(sorted, q) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[idx]
}

/**
 * 把一批 wake 行聚合成报表数据。**纯函数**。
 *
 * @param {object} opts
 * @param {object[]} opts.rows      `type === 'wake'` 的行（其它行会被忽略）
 * @param {object} [opts.labels]    `{ '<ts>': 'ok' | 'miss' }`（人工复核结果）
 * @param {number} [opts.now]
 * @param {number} [opts.sampleLimit]
 * @param {{from: number|null, to: number|null, files: number}} [opts.window]
 * @returns {object} 见下方字段；**全部是算出来的，没有"看起来应该差不多"的估算**
 */
export function summarizeWakeOps({
  rows = [],
  labels = {},
  now = Date.now(),
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
  window = { from: null, to: null, files: 0 },
} = {}) {
  const wake = (Array.isArray(rows) ? rows : []).filter((r) => r && r.type === 'wake')

  const judged = wake.filter((r) => r.judged === true)
  const silenced = judged.filter((r) => r.verdict === SILENT)
  const fallbackRows = wake.filter((r) => r.fallback === true)
  // 「没判定」= 压根没问成（超预算 / 被取消 / 通路没配好）—— 它与"判定失败"是两回事：
  // 前者是我们没问，后者是问了没得到能用的结论。混起来会让"判定器稳不稳"看不出来。
  const notJudged = wake.filter((r) => r.judged !== true && r.fallback !== true)

  // 影子与生效分开：影子行代表"本会怎样"，生效行代表"已经怎样"。
  // 两者混在一起的后果是**结论解释不了**（同一栏里既有"想拦"又有"真拦"）。
  const shadowRows = wake.filter((r) => r.shadow === true)
  const liveRows = wake.filter((r) => r.shadow !== true)
  // shadow 模式下写下的 silent 才是"本会拦掉但没拦"；生效模式下的 silent 是真拦了。
  const wouldSilence = silenced.filter((r) => r.shadow === true)
  const reallySilenced = silenced.filter((r) => r.shadow !== true)

  // ── 解析来源：这是"**模型有没有照提示词的格式写**"唯一的观测点 ──────────────
  //   不是 `json` 就说明结论是从宽松 JSON / 配对扫描 / 明确短语里救回来的。
  //   比例偏高 → 该去改提示词，而不是继续加容错。
  const via = { json: 0, loose: 0, scan: 0, phrase: 0, unknown: 0 }
  for (const r of judged) {
    const v = r.via
    via[typeof v === 'string' && v in via ? v : 'unknown'] += 1
  }

  // ── 兜底原因（判定器稳定性）：按理由归并，看哪一类失败最多 ────────────────
  const fallbackReasons = new Map()
  for (const r of fallbackRows) {
    const why = String(r.why ?? r.reason ?? '未给原因').slice(0, 60)
    fallbackReasons.set(why, (fallbackReasons.get(why) ?? 0) + 1)
  }

  // ── 耗时 ────────────────────────────────────────────────────────────────
  const msList = wake.map((r) => Number(r.ms)).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b)

  // ── token（只有直连那条路能拿到；走 DSH 进程时是 null）────────────────────
  const tok = { input: 0, cacheRead: 0, output: 0, rows: 0 }
  for (const r of wake) {
    const t = r.tokens
    if (!t || typeof t !== 'object') continue
    tok.input += Number(t.input) || 0
    tok.cacheRead += Number(t.cacheRead) || 0
    tok.output += Number(t.output) || 0
    tok.rows += 1
  }

  // ── 按会话 ──────────────────────────────────────────────────────────────
  const byChatMap = new Map()
  for (const r of wake) {
    const k = String(r.chatKey ?? '(未知)')
    const cur = byChatMap.get(k) ?? { chatKey: k, total: 0, silenced: 0 }
    cur.total += 1
    if (r.judged === true && r.verdict === SILENT) cur.silenced += 1
    byChatMap.set(k, cur)
  }
  const byChat = [...byChatMap.values()].sort((a, b) => b.total - a.total)

  // ── 抽样：**所有"本会拦下"的都要能被复核**（截断时明说截断了）────────────
  //   ★ 排序按 ts **升序**：样本编号必须在两次运行之间**稳定**，否则
  //     "先看列表、再按编号标注"这件事会标错行。新生效的行只会往后加。
  const sampleSource = [...silenced].sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))
  const samples = sampleSource.slice(0, Math.max(1, sampleLimit)).map((r, i) => ({
    index: i + 1,
    ts: Number(r.ts) || 0,
    chatKey: String(r.chatKey ?? ''),
    shadow: r.shadow === true,
    via: r.via ?? null,
    ms: Number(r.ms) || 0,
    reason: String(r.reason ?? ''),
    excerpt: String(r.excerpt ?? ''),
    label: labels?.[String(r.ts)] ?? null,
  }))
  const truncated = sampleSource.length - samples.length

  // ── 人工复核的统计（漏回率）─────────────────────────────────────────────
  //   分母只算**已复核**的：把"还没看"混进分母会让漏回率凭空变小（最危险的一种错）。
  let ok = 0
  let miss = 0
  for (const s of sampleSource.slice(0, Math.max(1, sampleLimit))) {
    const l = labels?.[String(s.ts)]
    if (l === 'ok') ok += 1
    else if (l === 'miss') miss += 1
  }
  const reviewed = ok + miss
  const missRate = reviewed > 0 ? miss / reviewed : null

  // ── 如实说明：窗口、寿命、采样 ───────────────────────────────────────────
  const warnings = []
  const from = window.from ?? (wake.length ? Math.min(...wake.map((r) => Number(r.ts) || Infinity)) : null)
  const to = window.to ?? (wake.length ? Math.max(...wake.map((r) => Number(r.ts) || 0)) : null)
  if (wake.length === 0) {
    warnings.push(
      '一条 wake 流水都没有 —— 要么 `wake.policy` 还是 `rule`（判定器一次都没跑），' +
        '要么判定器从没被触发过（是私聊/@ 直通，或没命中关键词）。**这不等于"判定器从不沉默"**。',
    )
  }
  if (from && to) {
    const days = Math.max(0, Math.round((now - from) / 86_400_000))
    if (days >= 6) {
      warnings.push(
        `窗口已经 ${days} 天 —— oplog 是 **7 天 TTL**，更早的记录已经被清掉了。` +
          '要看更长的趋势必须先延长 TTL（否则早期证据会在你还在观察的时候过期）。',
      )
    }
  }
  if (tok.rows > 0 && tok.rows < wake.length) {
    warnings.push(
      `只有 ${tok.rows}/${wake.length} 条带 token 数（走一次性 DSH 进程那条路拿不到用量）—— ` +
        '下面的成本是**按已报出的部分**估的，偏低。',
    )
  }
  warnings.push(
    '本报表**没有采样**：每条候选消息都记了一行。' +
      `按一行约 300~800 字节、每天 2MB 上限算，日判定量超过约 2600~7000 条就会顶到上限（那时写入会被拒绝，日志里有 ⚠️）。`,
  )

  return {
    workspace: null, // 由调用方填（这一层不碰盘）
    window: { from, to, files: window.files ?? 0, days: from ? Math.max(0, Math.round((now - from) / 86_400_000)) : 0 },
    total: wake.length,
    judged: judged.length,
    answered: judged.length - silenced.length,
    silenced: silenced.length,
    shadowRows: shadowRows.length,
    liveRows: liveRows.length,
    wouldSilence: wouldSilence.length,
    reallySilenced: reallySilenced.length,
    fallback: fallbackRows.length,
    notJudged: notJudged.length,
    fallbackReasons: [...fallbackReasons.entries()].map(([why, n]) => ({ why, n })).sort((a, b) => b.n - a.n),
    via,
    ms: {
      count: msList.length,
      median: quantile(msList, 0.5),
      p95: quantile(msList, 0.95),
      max: msList.length ? msList[msList.length - 1] : null,
    },
    tokens: tok,
    byChat,
    samples,
    sampledTotal: sampleSource.length,
    truncated,
    labels: { ok, miss, reviewed, pending: Math.max(0, sampleSource.length - reviewed), missRate },
    warnings,
    // 只有影子开着时"本会拦掉"才是个**预测**；生效时它就是**事实**。
    // 这个区别决定了下面那句话怎么写，所以它是一个显式字段而不是靠字面猜。
    shadowOn: shadowRows.length > 0,
  }
}

/** 可读的时长/时间小工具（报表专用，避免引入日期库）。 */
function fmtTime(ts, { date = true } = {}) {
  if (!ts) return '—'
  const d = new Date(Number(ts))
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return date ? `${mm}-${dd} ${hh}:${mi}` : `${hh}:${mi}`
}

/**
 * 把聚合结果渲染成**给人看的**文本。
 *
 * ★ 只描述数据支持的东西：算不出的地方写 `—`，不写 `0`
 *   （`0%` 与"没有数据"是两件事，混起来会让人得出相反结论）。
 */
export function renderWakeReport(s, { json = false } = {}) {
  if (json) return JSON.stringify(s, null, 2)
  const L = []
  L.push('唤醒判定报表（**只读** —— 数据来自 runtime/oplog/ 的 `type:"wake"` 行）')
  if (s.workspace) L.push(`工作区：${s.workspace}`)
  if (s.total > 0) {
    L.push(
      `窗口：${fmtTime(s.window.from)} ~ ${fmtTime(s.window.to)}` +
        `（约 ${s.window.days} 天，${s.window.files} 个文件，共 ${s.total} 条判定）`,
    )
  }
  L.push('')

  L.push(`判定次数            ${s.total}`)
  L.push(`  生效（shadow=false） ${s.liveRows}`)
  L.push(`  影子（shadow=true）  ${s.shadowRows}${s.shadowRows === 0 ? '   ← 影子没开，下面"本会拦掉"就是**实际**拦掉的' : '   ← 这些行**没有改变行为**'}`)
  L.push(`本会拦掉            ${s.silenced}  （${pctText(s.silenced, s.judged)} 的已判定）`)
  if (s.shadowRows > 0) {
    L.push(`  其中影子里"本会拦但放过了" ${s.wouldSilence}`)
    L.push(`  其中生效时真的拦掉了     ${s.reallySilenced}`)
  }
  L.push(`兜底放行            ${s.fallback}  （${pctText(s.fallback, s.total)} 的判定 —— 判定失败按放过；**占比高说明判定器不稳**）`)
  for (const r of s.fallbackReasons.slice(0, 5)) L.push(`    ${r.n} × ${r.why}`)
  L.push(`没判定              ${s.notJudged}  （没问成：超预算 / 被取消 / 通路没配好 —— 与"问了没得到结论"是两回事）`)
  if (s.judged > 0) {
    // ★ `unknown` 要单独说清是什么：**早期记录还没有 `via` 这个字段**
    //   （0.2.3 才加的），把它并进"模型没照格式写"是**诬告模型**。
    L.push(
      `解析来源            json ${s.via.json}｜loose ${s.via.loose}｜scan ${s.via.scan}｜phrase ${s.via.phrase}` +
        (s.via.unknown ? `｜无记录 ${s.via.unknown}（早期记录还没有这个字段，不是模型的问题）` : '') +
        '   ← **不是 json 就说明模型没照提示词的格式写**',
    )
  }
  if (s.ms.count > 0) {
    L.push(`耗时              中位 ${s.ms.median}ms｜p95 ${s.ms.p95}ms｜最大 ${s.ms.max}ms`)
  }
  if (s.tokens.rows > 0) {
    const costText =
      s.cost && typeof s.cost.cny === 'number'
        ? `≈ ¥${s.cost.cny.toFixed(4)}${s.cost.rateKey ? `（按 ${s.cost.rateKey} 价）` : ''}`
        : s.cost === null
          ? '—（取不到单价：检查 usage.pricesFile / 价目表里有没有这个路由）'
          : ''
    L.push(
      `token             输入 ${s.tokens.input}（其中缓存命中 ${s.tokens.cacheRead}）｜输出 ${s.tokens.output}` +
        `（${s.tokens.rows}/${s.total} 条有用量）` + (costText ? `｜估算成本 ${costText}` : ''),
    )
  } else {
    // ★★ 这一句**必须把两种可能都说出来**：真实情况是二者的混合，而断言其中一种
    //   会给出一个看起来确定、实际可能是错的原因（本项目最忌讳这类"自信的错"）。
    L.push(
      'token             —（**没有任何一条带用量**：两种可能 —— ① 这些记录写在 `tokens` 字段' +
        '之前；② 走的是拿不到用量的一次性 DSH 进程。**不要据此说"判定不走直连"**，' +
        '那要看上面那条通路日志）',
    )
  }

  if (s.byChat.length > 1 || (s.byChat[0] && s.byChat[0].chatKey !== '(未知)')) {
    L.push('')
    L.push('按会话')
    for (const c of s.byChat.slice(0, 20)) L.push(`  ${c.chatKey.padEnd(24)} ${String(c.total).padStart(5)} 条（本会拦 ${c.silenced}）`)
  }

  L.push('')
  if (s.samples.length === 0) {
    L.push('── 抽样人工复核：**没有"本会拦掉"的样本** ──')
    L.push('   （要么判定器从没沉默过，要么影子还没跑够 —— 没有样本就没法评估"漏回率"）')
  } else {
    L.push(`── 抽样人工复核：本会拦掉的 ${s.samples.length} 条（共 ${s.sampledTotal} 条${s.truncated > 0 ? `，**这里只列了前 ${s.samples.length} 条，还有 ${s.truncated} 条没列**` : ''}）──`)
    L.push('   ★ 逐条看：**这条本来就该沉默**，还是**其实该回**（后者就是"漏回"）？')
    for (const x of s.samples) {
      const mark = x.label === 'ok' ? ' ✅已判对' : x.label === 'miss' ? ' ❌漏回' : ''
      L.push('')
      L.push(`  ${String(x.index).padStart(3)}. [${fmtTime(x.ts)}] ${x.chatKey}${x.shadow ? '（影子）' : ''}  ${x.ms}ms${mark}`)
      L.push(`       「${x.excerpt}」`)
      if (x.reason) L.push(`       → 判定理由：${x.reason}`)
    }
    L.push('')
    L.push(
      `  已复核 ${s.labels.reviewed} 条（判对 ${s.labels.ok}｜漏回 ${s.labels.miss}），待复核 ${s.labels.pending} 条`,
    )
    L.push(
      s.labels.missRate === null
        ? `  漏回率 —（还没复核过任何一条；**没复核 ≠ 没问题**）`
        : `  漏回率 ${(s.labels.missRate * 100).toFixed(1)}%` +
          (s.labels.missRate > MISS_RATE_ADVISORY
            ? `  ★ 超过建议上限 ${(MISS_RATE_ADVISORY * 100).toFixed(0)}% —— 这个比例下不建议真的开启判定`
            : `  （建议上限 ${(MISS_RATE_ADVISORY * 100).toFixed(0)}%，这是本项目的建议值、不是硬规定）`),
    )
    L.push('')
    L.push('  记下你的复核（只写 runtime/wake-labels.json，不碰配置、不碰记忆）：')
    L.push('    node src/index.mjs --wake --ok 1,3,5 --miss 2,4')
  }

  if (s.warnings.length > 0) {
    L.push('')
    L.push('⚠️ 读这张表之前要知道的：')
    for (const w of s.warnings) L.push(`  · ${w}`)
  }
  return L.join('\n')
}

/**
 * 读人工复核的标注。**绝不抛**（报表是只读观测，坏了也要能把表打出来）。
 * @returns {{ok: boolean, labels: object, why?: string}}
 */
export function readWakeLabels({ workspace, readFile = null } = {}) {
  const abs = `${String(workspace ?? '')}/${WAKE_LABELS_REL}`
  try {
    const text = readFile ? readFile(abs) : null
    if (text === null) return { ok: true, labels: {} }
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: true, labels: {} }
    const labels = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (v === 'ok' || v === 'miss') labels[String(k)] = v
    }
    return { ok: true, labels }
  } catch (error) {
    return { ok: false, labels: {}, why: `标注文件读不出来（已忽略）：${error?.message ?? error}` }
  }
}

/**
 * 把标注写进文件。**绝不抛** —— 它写在观测路径上，失败不该让"标注"这个动作炸掉。
 * @returns {{ok: boolean, written: number, rel: string, why?: string}}
 */
export function writeWakeLabels({ workspace, labels, write = null } = {}) {
  const rel = WAKE_LABELS_REL
  try {
    const body = `${JSON.stringify(labels ?? {}, null, 2)}\n`
    if (write) write(`${String(workspace ?? '')}/${rel}`, body)
    return { ok: true, written: Object.keys(labels ?? {}).length, rel }
  } catch (error) {
    return { ok: false, written: 0, rel, why: error?.message ?? String(error) }
  }
}
