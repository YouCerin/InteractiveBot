/**
 * 记忆条目的**行内标注**：目前只有"已被更正"（H4 / 验收 R10）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 要解决的问题（R10：事实冲突时**不许覆盖**）
 * ══════════════════════════════════════════════════════════════════════════
 * 用户先说"我的服务器是 Forge 端"，一周后说"换成 Paper 端了"。
 * 旧实现只有两条路，**两条都不对**：
 *   · 直接改掉旧条目 → **"我说错过什么"彻底消失**，而且模型下次可能又把旧的写回来
 *     （它没有任何线索知道"这条被更正过"）；
 *   · 两条都留着、都注入 → 模型拿到两个互相矛盾的"事实"，
 *     它大概率挑一条顺手的用 —— **对错各半**。
 *
 * 现在的第三条路：**旧条目留着、但标注"已被更正"并停止注入**。
 *   · 审计价值：能查出"这条为什么变成现在这样"；
 *   · 注入价值：模型不会再看到被推翻的结论；
 *   · 成本：一行字。不引入第二条存储、不引入新文件。
 *
 * ── 承载格式（**这就是全项目的口径**，改格式要一起改这里与测试）──────────
 *
 *     - 他的 MC 服务器是 Forge 端　〔已被更正：他的 MC 服务器换成了 Paper 端 · 2026-09-26〕
 *       └── 原条目原样保留 ──┘   └──────────── 追加的标注 ────────────┘
 *
 * 为什么用**全角方括号 + 行内追加**而不是删掉原行、另起一个小节：
 *   · 记忆文件是**给人看的 markdown**（使用者会直接打开改），行内标注一眼能看懂；
 *   · 追加是**原地、幂等**的：同一行标两次不会变成两条标注（见 `markSupersededLine`）；
 *   · 不需要新的存储层与新的 TTL（这条要求本身就是"别把简单的事搞复杂"）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 怎么判断"新条目是在更正旧的"——**这里有一组实测数字，改判据前先看完**
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版想当然地用了"更正措辞 + 相似度 ≥ 0.35"（措辞含 `改成/换成/不再/其实`）。
 * 实测（bigram Jaccard）把这条路**证伪了**：
 *
 * ```
 * 0.273  真更正        「他的 MC 服务器是 Forge 端」 ↔ 「他的 MC 服务器换成了 Paper 端」
 * 0.286  不是更正      「他的 MC 服务器是 Forge 端」 ↔ 「他的 MC 服务器内存改成 32G 了」
 * ```
 * **两个数字差 0.013** —— 阈值放在哪里都会错一边：往下调就把"同一主体的另一件事"
 * 当成更正（于是**一条真事实被悄悄停用**），往上调就漏掉真正的更正。
 * 「其实」更糟：「其实他的 MC 服务器内存是 32G」与旧条目相似度 0.33，
 * 同样会被误判。
 *
 * 所以现在的判据**只留两种**（都是明确无歧义的）：
 *
 * | 判据 | 例子 | 为什么可信 |
 * |---|---|---|
 * | **模型显式声明**（`<<<MEMORY fix …>>>`） | 提示词里教的那一行 | 它**明确说了**这是更正，不需要我们猜语义 |
 * | **自指式更正措辞** | 「纠正一下…」「我之前说错了…」「之前记的不对…」 | 这类话**指向"我刚才说错了"这件事本身**，不可能是"同一主体的另一件事" |
 *
 * 而被**刻意排除**的（因为实测分不开）：
 *   · `改成 / 换成 / 改为 / 不再…`：只说明"某个属性变了"，不说明变的是**这条**说的属性；
 *   · `其实…`：可能是更正，也可能只是补充（"其实他还喜欢拿铁"）。
 *
 * ⚠️ **如实说清这条路的边界**（不夸大）：
 *    「他的服务器是 Forge 端」→「他的服务器是 Paper 端」这种**纯陈述式覆盖**，
 *    以及**没有用 `fix` 档**的 `换成` 类更正，现在都**不会被自动标注** ——
 *    两条都保留、都注入（这就是升级前的状态，没有变坏），并在 `--memory` 里看得到。
 *    要认出它们必须做**语义判断**（"同一属性的两个不同结论"），规则做不到；
 *    硬做会吃掉真实记忆，而**吃掉真实记忆比留下两条矛盾更贵**。
 *    真正的解法是让模型在更正时用 `fix` 档（提示词里教了），或由使用者直接改文件。
 */

/**
 * **自指式**更正措辞：指向"我刚才说错了"这件事本身。
 *
 * ⚠️ 只收这一类。**不要**往里加 `改成/换成/不再/其实` ——
 *    实测它们与"同一主体的另一件事"分不开（见文件头那组数字）。
 *    每加一个词，都要先回答："「他的服务器内存改成 32G 了」会不会误命中？"
 *    会 → 不许加。
 */
export const SUPERSEDE_CUES = [
  /纠正(一下|下|个)?[，,：:]?/,
  /更正(一下|下|个)?[，,：:]?/,
  /修正(一下|下)?[，,：:]?/,
  /说错了/,
  /记错了/,
  /讲错了/,
  /写错了/,
  /之前(说|记|写|讲)的?(不对|有误|错了|不准)/,
  /前面(说|记|写|讲)的?(不对|有误|错了)/,
  /我(刚才|上面|前面)(说|讲)的?不算/,
  /收回(刚才|上面|前面)/,
]

/** 标注里用的左/右括号（全角，与正文里可能的半角括号区分开）。 */
const NOTE_OPEN = '〔已被更正：'
const NOTE_CLOSE = '〕'

/** 从一行里把标注抠出来（返回 `{note, at}`；没有标注返回 null）。 */
const NOTE_RE = /〔已被更正：([\s\S]*?)〕\s*$/

/** 这条（去掉 `- ` 之后）是否是**自指式更正**（见 {@link SUPERSEDE_CUES} 的边界说明）。 */
export function hasSupersedeCue(text) {
  const s = String(text ?? '')
  if (!s) return false
  return SUPERSEDE_CUES.some((re) => re.test(s))
}

/** 生成标注文本（日期只到天，给人看够了；不写时分秒是**刻意的**——那只会变噪音）。 */
export function buildSupersedeNote({ newEntry = '', at = new Date() } = {}) {
  const d = at instanceof Date ? at : new Date(at)
  const day = Number.isNaN(d.getTime())
    ? String(at ?? '')
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  // 新条目摘要：截断到 60 字（标注是"指向"，不是"复制一份新事实"）
  const summary = String(newEntry ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  return summary ? `${NOTE_OPEN}${summary} · ${day}${NOTE_CLOSE}` : `${NOTE_OPEN}${day}${NOTE_CLOSE}`
}

/** 这条（含 `- ` 前缀或不含都行）是否已被标注为"已被更正"。 */
export function isSuperseded(text) {
  return NOTE_RE.test(String(text ?? '').replace(/\s+$/, ''))
}

/** 读取标注内容（`{note, at}`；没有就 null）。 */
export function readSupersedeNote(text) {
  const m = NOTE_RE.exec(String(text ?? '').replace(/\s+$/, ''))
  if (!m) return null
  const body = m[1]
  const atMatch = /·\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*$/.exec(body)
  return { note: body.trim(), at: atMatch ? atMatch[1] : null }
}

/**
 * 去掉标注，得到"这条本来在说什么"。
 *
 * ★ 所有**比较**都必须先过这一步 —— 否则标注里的新事实摘要会被算进相似度，
 *   让"已经被更正的旧条目"看起来越来越像新条目（那是会自我强化的错误）。
 */
export function stripSupersedeNote(text) {
  return String(text ?? '')
    .replace(NOTE_RE, '')
    .replace(/\s+$/, '')
    .trim()
}

/**
 * 在**一行**上追加标注（幂等：已经标过就原样返回）。
 *
 * @param {string} line 原始行（**含 `- ` 前缀**，因为要写回文件）
 * @param {{newEntry?: string, at?: Date}} opts
 * @returns {{line: string, changed: boolean}}
 */
export function markSupersededLine(line, { newEntry = '', at = new Date() } = {}) {
  const src = String(line ?? '').replace(/\s+$/, '')
  if (!src.trim()) return { line: src, changed: false }
  if (isSuperseded(src)) return { line: src, changed: false } // 幂等
  return { line: `${src}　${buildSupersedeNote({ newEntry, at })}`, changed: true }
}

/**
 * 从已有条目里挑出**该被这条新记忆更正的那一条**。
 *
 * 判据（两种，任一成立即可 —— 见文件头那组实测数字，**不要再加"换成类"措辞**）：
 *   · `force`（模型显式写了 `fix` 档）→ 相似度最高的那条，只要 ≥ `floor`；
 *   · 否则必须**新条目是自指式更正**（"纠正一下…""我之前说错了…"）且相似度 ≥ `threshold`。
 *
 * @param {object} opts
 * @param {string[]} opts.lines 现有行（**含 `- ` 前缀**）
 * @param {string} opts.newEntry 新条目正文（不含 `- `）
 * @param {Function} opts.similarity 相似度函数（注入，保持本模块零依赖）
 * @param {boolean} [opts.force] 显式更正（`fix` 档）
 * @param {number} [opts.threshold] 自指式更正时的门槛（默认 0.15 ——
 *   不需要高：自指措辞本身已经把"这是更正"说死了，相似度只用来**挑哪一条**）
 * @param {number} [opts.floor] 显式更正时的门槛（默认 0.15）
 * @returns {{index: number, line: string, score: number}|null}
 */
export function pickSupersedeTarget({
  lines = [],
  newEntry = '',
  similarity,
  force = false,
  threshold = 0.15,
  floor = 0.15,
} = {}) {
  const target = String(newEntry ?? '').trim()
  if (!target || typeof similarity !== 'function') return null
  // 没有措辞、也不是显式更正 → 不动手（见文件头：这条路的边界）
  if (!force && !hasSupersedeCue(target)) return null
  const min = force ? floor : threshold

  let best = null
  lines.forEach((line, index) => {
    const text = stripSupersedeNote(String(line ?? '').replace(/^-\s*/, ''))
    if (!text) return
    if (isSuperseded(line)) return // 已经被更正过的不再被第二条覆盖（保留第一次更正的指向）
    const score = similarity(text, target)
    if (score < min) return
    if (!best || score > best.score) best = { index, line, score }
  })
  return best
}
