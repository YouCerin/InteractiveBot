/**
 * 表情包**打标签引擎**（离线；CLI 与控制台按钮**共用这一份实现**）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么把引擎抽出来（而不是让按钮去调 CLI）
 * ══════════════════════════════════════════════════════════════════════════
 * 打标签这件事现在有**两个入口**：
 *   · 命令行 `node src/sticker-tag.mjs`（离线/无界面时的备用入口）；
 *   · 控制台「扩展 → 表情包」卡片上的**重新打标签**按钮（主入口）。
 *
 * 两个入口各写一遍必然漂移（本项目已经因为"同一件事两处实现"栽过几次：
 * 提示词措辞、插件开关、图片守卫）。所以判定与写回**只有这一份**：
 * 入口只负责"怎么收集参数、怎么展示进度"。
 *
 * ── 三条纪律（都是硬的）────────────────────────────────────────────────
 * ① **认不出就落待定**：模型给不出词表内的标签、或置信度不够、或压根没返回 JSON
 *    —— 一律 `ok:false`，**绝不硬塞一个近似标签**（硬塞的会在某个场景被真的发出去）。
 * ② **人工改过的标签不动**：`source === 'manual'` 的条目默认**跳过**。
 *    模型重打一遍会把人的判断冲掉，而人改标签往往是因为模型打错了 ——
 *    覆盖它等于"把人纠正过的错误再犯一遍"。
 * ③ **失败只跳过这一张，但连续失败要熔断**：单张失败不该中断整批（一张坏图
 *    不该让另外 200 张打不上），可是**连续失败 3 次**必须停下 ——
 *    那说明是配置问题（key 过期 / 模型不支持图片 / 网络不通），
 *    继续跑只会把额度烧在一件注定失败的事上。
 *
 * ★ 运行期成本说明：**每张图一次模型调用**。这是刻意的一次性离线成本 ——
 *   运行期（选图那一刻）一次调用都不加，理由见 `images.mjs:29`。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatOnce } from './model-direct.mjs'
import { readStickerLibrary, stickerRoot } from './sticker-library.mjs'
import { MIN_TAG_CONFIDENCE, renderTaggingGuide } from './sticker-labels.mjs'
import { activeLabelName, activeLabels, resolveActiveLabelId } from './sticker-vocab.mjs'

/** 连续失败到几次就熔断（够判"这不是单张的问题"）。 */
export const CONSECUTIVE_FAILURE_LIMIT = 3

/** 人工标签的标记值：`source === MANUAL_SOURCE` 的条目默认不重打。 */
export const MANUAL_SOURCE = 'manual'

/**
 * 打标签的提示词（**词表 + 负例 + 输出形状**，三样都要给）。
 *
 * ★ 这段文案与 `renderTaggingGuide()` 是同一来源 —— 提示词改了，
 * CLI 与按钮**同时**改（这正是抽引擎的目的）。
 */
export function buildTagPrompt({ file = '', vocabOpts = {} } = {}) {
  return [
    '你在给一批 QQ 表情包打**场景标签**，标签会用于"聊天时挑一张合适的发出去"。',
    '',
    renderTaggingGuide(activeLabels(vocabOpts)),
    '',
    '看图，然后**只输出一个 JSON**（不要解释、不要 markdown 代码块）：',
    '{"primary":"<标签 id>","secondary":["<标签 id>",...最多2个],"confidence":0~1,"risky":true|false,"why":"<10字以内>"}',
    '',
    '规则（很重要）：',
    '1. primary 必须**严格**从上面的 id 里选；一个都不合适就写 "unknown"。',
    '2. secondary 只能写**次要**含义（图里同时表达的意思），最多 2 个，没有就给空数组。',
    `3. confidence 是"primary 有多确定"。低于 ${MIN_TAG_CONFIDENCE} 等于没打上标签（会进待定区）。`,
    '4. 分不清就老实写低分 —— 打错标签会让它在错误的场合发出去，比留着不用糟得多。',
    '5. **risky**：这张图含脏话/骂人/擦边/重口/血腥/惊悚/恐怖这类内容时写 true。',
    '   标成 true 的图**默认不会被发出去**（这是安全闸门，不是审美判断）—— 拿不准就写 true。',
    '6. 常见的错法请对照：求解释(confused) ≠ 荒诞反问(question-mark) ≠ 认知冲击(shock) ≠ 鄙视(deadpan)；',
    '   真委屈(sad) ≠ 装不知道(innocent)；放弃挣扎(slack) ≠ 疲惫(tired) ≠ 不想接话(dismiss)；',
    '   被逗乐(laugh) ≠ 带攻击性(spite) ≠ 又好笑又无奈(awkward-smile)。',
    file ? `\n这个文件是：${file}` : '',
  ]
    .filter((s) => s !== undefined)
    .join('\n')
}

/**
 * 从模型输出里解析标签结论（**宽松取 JSON、严格校验**）。
 *
 * 为什么宽松取 JSON：该适配器**不认 `response_format`**（`model-direct.mjs` 文件头
 * 记着这条取证），所以只能从文本里抠 JSON —— 常见形态是包了代码块、或前后带一句话。
 *
 * @returns {{ ok: true, primary: string, secondary: string[], confidence: number, why: string }
 *          |{ ok: false, why: string, secondary?: string[], confidence?: number }}
 */
export function parseTagReply(text, vocabOpts = {}) {
  const raw = String(text ?? '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return { ok: false, why: `输出里没有 JSON：${raw.slice(0, 80)}` }
  let obj
  try {
    obj = JSON.parse(raw.slice(start, end + 1))
  } catch (error) {
    return { ok: false, why: `JSON 解析失败：${error?.message ?? error}` }
  }
  const primary = resolveActiveLabelId(obj?.primary, vocabOpts)
  const secondary = []
  for (const s of Array.isArray(obj?.secondary) ? obj.secondary : []) {
    const id = resolveActiveLabelId(s, vocabOpts)
    if (id && id !== primary && !secondary.includes(id)) secondary.push(id)
    // ★ 硬性截到 2 个（提示词里要求 ≤2，但模型可能多给）：次要标签越多，
    //   这张图在**更多场景**里都能被选中 —— 那正是"发错图"的来源。
    if (secondary.length >= 2) break
  }
  const conf = Number(obj?.confidence)
  const why = String(obj?.why ?? '').slice(0, 40)

  // ★ unknown / 认不出的标签 / 低置信度：**一律落待定**，绝不硬塞
  if (!primary) {
    const said = String(obj?.primary ?? '').trim()
    return {
      ok: false,
      why: said && said !== 'unknown' ? `模型给的标签「${said}」不在词表里 → 落待定` : '模型说这张图不适用任何标签',
      secondary,
      confidence: Number.isFinite(conf) ? conf : 0,
    }
  }
  if (Number.isFinite(conf) && conf < MIN_TAG_CONFIDENCE) {
    return { ok: false, why: `置信度 ${conf} 低于 ${MIN_TAG_CONFIDENCE} → 落待定`, secondary, confidence: conf }
  }
  // ★ risk 也一起解析：它是**安全标记**（默认不发），与情绪标签分开走。
  //   模型没给就是 false（**不猜成 true**，否则一次故障会把整库都禁掉）。
  const risky = obj?.risky === true
  return { ok: true, primary, secondary, confidence: Number.isFinite(conf) ? conf : 1, risky, why }
}

/** 图片 → data URL（模型接口要的形状）。 */
export function toDataUrl(absPath, mediaType) {
  const bytes = readFileSync(absPath)
  return `data:${mediaType || 'image/png'};base64,${bytes.toString('base64')}`
}

/**
 * 这条目是不是**人工**打的标签（重打时要跳过）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 0.2.4 第十四轮修正：**没有主标签的条目不算"人工标签"**
 * ══════════════════════════════════════════════════════════════════════════
 * 原来只看 `source === 'manual'`。而"删除标签"会把那些图恢复成未标注，
 * 并把 `source` 标成 `manual`（那是为了**把置信度清成 0** —— 见
 * `clearLabelFromLibrary`）。两件事撞在一起就出了一个死结：
 *
 *   · 127 张未标注的图 → `source: 'manual'` → 「重新打标签」**全部跳过**
 *   · 于是"自动分类未标注的图"这个功能**一张都打不了**
 *     （实测：预检说 todo=0、skippedManual=145）
 *
 * 而 `manual` 的本意是"**人工已经做过的判断，别覆盖**"。一张 `primary` 为空的图
 * **没有任何判断可保护** —— 把"没有标签"当成"人工决定不要标签"是错的，
 * 那是删除标签的**副产品**，不是人的判断。
 *
 * ∴ 判据改成"人工**且**确实有标签"：既保住了人工成果，又让空标签的图能被重新分类。
 *   （`source` 字段本身不动，所以 history/report 里仍然看得出它曾被人工处理过。）
 */
export function isManualEntry(entry) {
  if (String(entry?.source ?? '') !== MANUAL_SOURCE) return false
  return Boolean(String(entry?.primary ?? '').trim())
}

/* ────────────────────────────────────────────────────────────────────────
 * 文件名先验：**零成本**的第一遍标签
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 文件名里的词 → 标签。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要这一步（以及为什么不满足于它）
 * ══════════════════════════════════════════════════════════════════════════
 * 表情包文件名**常常自带语义** —— 尤其是从成套素材/聊天记录导出的：
 * `蓝色大肥鱼_笑_2026-08-18.gif`、`…_问号_….gif`、`…_加油_….gif`。
 * 那是打包者对画面的描述，比任何模型猜测都准，而且**一次模型调用都不花**。
 *
 * 实测意义（一次真实事故）：用户导了 157 张 GIF，如果只能靠视觉模型打标签，
 * 那就是 157 次调用；而其中大半能从文件名直接定下来。
 *
 * ⚠️ **它只是先验，不是终局**：
 *   · 命中的条目 `source` 记成 `filename`，**下次重打标签时会被模型覆盖**
 *     （与 `manual` 不同 —— 那是人的判断，不许覆盖）；
 *   · 没命中的仍然落待定，等模型（或人）来定。
 */
export const FILENAME_LABEL_HINTS = Object.freeze([
  // ★ 顺序有意义：**命中即返回**，所以具体的要排在泛化的前面。
  //   实测踩过：`加油` 被 `笑|乐` 先命中（"加油"里有"乐"吗？没有 —— 但
  //   `蓝色大肥鱼_加油_3.png` 里的 `鱼` 不影响；真正的原因是我把 `乐` 写进了
  //   第一条，而 `…_加油_…` 不含"乐"… 总之**具体优先**是这条表的基本纪律，
  //   靠测试（`verify-sticker-retag` 第⑥节）钉住）。
  // ⚠️ 「赞赏/鼓励」这一族**词表里没有专门的标签**（词表是 22 个固定标签，见
  //    `sticker-labels.mjs`）。所以"加油/庆祝/干杯"这类先归到 `agree`（认可、给正面回应）。
  //    这是一个**已知的取舍**：如果这类图很多，更好的做法是往词表里加一个标签
  //    （那需要同时改词表、人设段与提示词 —— 属于契约变更，要人点头）。
  { re: /(加油|鼓劲|庆祝|干杯|蛋糕|礼物|荧光棒|赢了)/, label: 'agree' },
  // ⚠️ 顺序陷阱（实测踩到）：`被击中(爱心)` / `被击中(拖鞋)` 里含"爱心"，
  //    会被下面的 moved 先命中 —— 但那是"被东西砸中"的哭笑不得，不是"被萌到"。
  //    所以"被击中"要排在"爱心/拖鞋"这类零件词**前面**。
  { re: /(被击中|击中|砸|挨打)/, label: 'awkward-smile' },
  { re: /(摸头|抱|安慰|没事|一切都好|自我安慰)/, label: 'comfort' },
  { re: /(问号|疑惑|\?|疑问)/, label: 'question-mark' },
  { re: /(哭|泪|委屈|难过|伤心)/, label: 'sad' },
  { re: /(睡觉|睡吧|睡眠|困|累|疲倦|小睡|休息|催眠)/, label: 'tired' },
  { re: /(爱心|喜欢|情书|玫瑰|舔|害羞|可爱|萌|星星)/, label: 'moved' },
  { re: /(打招呼|挥手|你好|嗨)/, label: 'greet' },
  { re: /(晚安|再见|拜拜)/, label: 'goodnight' },
  { re: /(生气|恼怒|发火)/, label: 'disagree' },
  { re: /(摇头|拒绝|不行|反对)/, label: 'disagree' },
  { re: /(点头|赞|赞许|比心|ok|OK)/, label: 'agree' },
  { re: /(害怕|惊吓|惊|吓|紧张|冷汗|抖)/, label: 'shock' },
  { re: /(无语|静音|闭嘴|扶额)/, label: 'deadpan' },
  { re: /(刀|枪|打|击|拖鞋|敲|拍|杀|拍蝇)/, label: 'spite' },
  { re: /(吃|馋|爆米花|西瓜|甜甜圈)/, label: 'gossip' },
  { re: /(工作|加班|打字|坐牢|带薪|钱|要米|搬砖)/, label: 'slack' },
  { re: /(思考|主意|记录|画板)/, label: 'confused' },
  { re: /(呆|懵|愣|傻)/, label: 'confused' },
  { re: /(停止|不要|走开|拿走|静音)/, label: 'dismiss' },
  { re: /(笑|乐|哈哈|hhh)/, label: 'laugh' },
])

/** 从文件名猜一个标签（认不出返回 null）。
 *
 * ★ 优先看条目里存的 `originName`（原始文件名），再退回库里的相对路径 ——
 *   因为落盘名是**内容哈希**，里面没有任何语义（这一条是实测踩出来的：
 *   157 张真实 GIF 全是哈希名，先验一张都定不下来）。 */
export function guessLabelFromFilename(fileOrEntry) {
  const name = typeof fileOrEntry === 'string'
    ? fileOrEntry
    : String(fileOrEntry?.originName || fileOrEntry?.file || '')
  for (const h of FILENAME_LABEL_HINTS) {
    if (h.re.test(name)) {
      const id = resolveActiveLabelId(h.label)
      if (id) return id
    }
  }
  return null
}

/**
 * 用文件名先验给**待定**条目打一遍标签（零模型调用）。
 *
 * @returns {{ applied: number, skipped: number, updates: object }}
 */
export function tagFromFilenames({ workspace, dir = 'stickers', force = false, now = () => Date.now() } = {}) {
  const library = readStickerLibrary({ workspace, dir })
  const targets = selectTagTargets(library, { skipManual: !force, onlyPending: !force })
  const updates = {}
  let skipped = 0
  for (const item of targets.todo) {
    const guess = guessLabelFromFilename(item)
    if (!guess) {
      skipped += 1
      continue
    }
    updates[item.rel] = {
      primary: guess,
      labels: [guess],
      confidence: 0.7, // ★ 刻意给 0.7（刚过阈值的"先验"分），不是 0.9：它只是猜测
      source: 'filename',
      at: now(),
    }
  }
  return { applied: Object.keys(updates).length, skipped, updates }
}

/**
 * 挑出"该重打标签"的条目。
 *
 * @param {object} library `readStickerLibrary()` 的产物
 * @param {{ rels?: string[], skipManual?: boolean, onlyPending?: boolean }} [opts]
 *   · `rels`：只处理这几条（界面按需重打用）
 *   · `skipManual`（默认 true）：跳过 `source === 'manual'` 的条目
 *   · `onlyPending`：只处理"没有主标签 / 置信度不够"的（CLI 的默认语义）
 * @returns {{ todo: Array<object>, skippedManual: number, total: number }}
 */
export function selectTagTargets(library, { rels = null, skipManual = true, onlyPending = false } = {}) {
  const entries = Object.entries(library?.entries ?? {}).map(([rel, e]) => ({ rel, ...e }))
  const wanted = Array.isArray(rels) && rels.length ? new Set(rels) : null
  let skippedManual = 0
  const todo = []
  for (const e of entries) {
    if (wanted && !wanted.has(e.rel)) continue
    if (skipManual && isManualEntry(e)) {
      skippedManual += 1
      continue
    }
    if (onlyPending && e.primary && !(e.primaryConfidence != null && e.primaryConfidence < MIN_TAG_CONFIDENCE)) {
      continue
    }
    todo.push(e)
  }
  return { todo, skippedManual, total: entries.length }
}

/**
 * ★ 跑一批打标签。**入口无关**（CLI / 按钮 / 测试都走这里）。
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {string} [opts.dir]                库目录（默认 stickers）
 * @param {string} opts.baseUrl / apiKey / model   模型通路（由调用方解析）
 * @param {number} [opts.limit]              最多处理多少张
 * @param {Array}  [opts.rels]               只处理这几条
 * @param {boolean} [opts.onlyPending]       只处理待定条目
 * @param {boolean} [opts.force]             连人工标签也重打（默认 false）
 * @param {Function} [opts.chat]             注入的模型调用（测试用；默认走 chatOnce）
 * @param {Function} [opts.onProgress]       每张之后回调（进度展示）
 * @param {{aborted: boolean}} [opts.signal] 取消开关（按钮的"停止"用）
 * @returns {Promise<{ ok:boolean, why?:string, tagged:number, retagged:number, failed:number,
 *                     skippedManual:number, aborted:boolean, consecutiveFailures:number,
 *                     updates:object, failedList:Array }>}
 */
export async function runTagging({
  workspace,
  dir = 'stickers',
  baseUrl,
  apiKey,
  model,
  limit = 0,
  rels = null,
  onlyPending = false,
  force = false,
  chat = null,
  onProgress = () => {},
  signal = null,
  timeoutMs = 30_000,
  now = () => Date.now(),
} = {}) {
  if (!workspace) return { ok: false, why: '没有工作区，读不到表情库', tagged: 0, retagged: 0, failed: 0, skippedManual: 0, aborted: false, consecutiveFailures: 0, updates: {}, failedList: [] }
  const call = typeof chat === 'function' ? chat : (args) => chatOnce(args)
  if (typeof chat !== 'function' && (!apiKey || !model)) {
    return {
      ok: false,
      why: '没有可用于打标签的模型通路（要一把能直连的 key 与一个支持图片输入的模型）',
      tagged: 0,
      retagged: 0,
      failed: 0,
      skippedManual: 0,
      aborted: false,
      consecutiveFailures: 0,
      updates: {},
      failedList: [],
    }
  }

  const library = readStickerLibrary({ workspace, dir })
  let { todo, skippedManual } = selectTagTargets(library, { rels, skipManual: !force, onlyPending })
  if (limit > 0) todo = todo.slice(0, limit)

  const updates = {}
  const failedList = []
  let tagged = 0
  let retagged = 0
  let failed = 0
  let disputedCount = 0
  let consecutiveFailures = 0
  let aborted = false
  let done = 0

  for (const item of todo) {
    if (signal?.aborted) {
      aborted = true
      break
    }
    const abs = stickerAbsPath({ workspace, dir }, item.rel)
    let dataUrl
    try {
      dataUrl = toDataUrl(abs, item.mediaType)
    } catch (error) {
      // ★ 读不到文件**不算"连续性失败"**：它多半是磁盘/权限问题，
      //   跟"模型通路坏了"是两回事，不该把整批熔断掉。
      failed += 1
      failedList.push({ rel: item.rel, why: `读不到文件：${error?.message ?? error}` })
      done += 1
      onProgress({ done, total: todo.length, rel: item.rel, ok: false, why: '读不到文件' })
      continue
    }

    let res
    try {
      res = await call({
        baseUrl,
        apiKey,
        model,
        prompt: buildTagPrompt({ file: item.rel, vocabOpts: { workspace, dir } }),
        images: [{ dataUrl }],
        maxTokens: 300,
        temperature: 0.1,
        timeoutMs,
        label: '表情包打标签',
      })
    } catch (error) {
      res = { ok: false, why: `调用异常：${error?.message ?? error}` }
    }

    done += 1
    if (!res?.ok) {
      failed += 1
      consecutiveFailures += 1
      failedList.push({ rel: item.rel, why: String(res?.why ?? '未知失败') })
      onProgress({ done, total: todo.length, rel: item.rel, ok: false, why: res?.why })
      // ★ 熔断：连续失败说明是配置问题（key 过期 / 模型不支持图 / 网络不通），
      //   再跑下去只是把额度烧在注定失败的事上。
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
        return {
          ok: false,
          why: `连续 ${consecutiveFailures} 张都失败 —— 这不像单张的问题（多半是 key / 模型 / 网络），已停下。最后一条原因：${res?.why ?? '未知'}`,
          tagged,
          retagged,
          failed,
          skippedManual,
          aborted,
          consecutiveFailures,
          disputedCount,
          updates,
          failedList,
        }
      }
      continue
    }

    const parsed = parseTagReply(res.text, { workspace, dir })
    if (!parsed.ok) {
      // ★ "模型答了但结论不可用"**不算通路故障**（所以不累加连续失败计数）：
      //   这是单张图打不上标签，属预期（认不出就落待定）。
      failed += 1
      failedList.push({ rel: item.rel, why: parsed.why })
      onProgress({ done, total: todo.length, rel: item.rel, ok: false, why: parsed.why })
      continue
    }

    consecutiveFailures = 0
    const hadLabel = Boolean(item.primary)
    if (hadLabel) retagged += 1
    else tagged += 1
    // ★★ 与文件名先验对照（0.2.4 实测后补）：不一致的标出来给人复核。
    //
    // 为什么必须做这一步：识图对表情包**经常判错**（实测 deepseek-flash：
    // `问号`→moved、`一切都好`→deadpan、`加油`→deadpan），而文件名先验往往更准。
    // 两者不一致的那批就是"最该人看一眼"的样本 —— 不标出来，人只能把整库挨个过。
    const hint = guessLabelFromFilename(item)
    const disputed = Boolean(hint && hint !== parsed.primary)
    if (disputed) disputedCount += 1
    updates[item.rel] = {
      primary: parsed.primary,
      labels: [parsed.primary, ...parsed.secondary],
      confidence: parsed.confidence,
      source: 'tag',
      risky: parsed.risky === true,
      originHint: hint ?? null,
      disputed,
      at: now(),
    }
    onProgress({
      done,
      total: todo.length,
      rel: item.rel,
      ok: true,
      label: parsed.primary,
      labelName: activeLabelName(parsed.primary, { workspace, dir }),
      confidence: parsed.confidence,
      retagged: hadLabel,
      disputed,
      hint,
    })
  }

  return {
    ok: true,
    tagged,
    retagged,
    failed,
    skippedManual,
    aborted,
    consecutiveFailures,
    disputedCount,
    updates,
    failedList,
  }
}

/** 库内某条目的绝对路径（`stickerRoot` + 相对路径；段分隔统一走 `join`）。 */
export function stickerAbsPath({ workspace, dir = 'stickers' } = {}, rel) {
  const root = stickerRoot({ workspace, dir })
  if (!root) return ''
  return join(root, ...String(rel ?? '').split('/'))
}

/* ══════════════════════════════════════════════════════════════════════════
 * 可查询进度的**一次性任务**（控制台按钮用）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 预检：**不花任何模型调用**地算清"这次要打多少张、哪些会被跳过"。
 *
 * 为什么必须有它：打标签是**唯一会真花钱**的操作（每张一次模型调用）。
 * 界面若不做预检，用户点一下就是几十次调用，而他既不知道要花多少、
 * 也不知道有几张会被跳过。所以按钮的流程固定是：
 *  预检（免费）→ 二次确认（把张数说清）→ 才真跑。
 *
 * @returns {{ ok:boolean, why?:string, total:number, todo:number,
 *             skippedManual:number, needsKey:boolean, model:string|null }}
 */
export function preflightRetag(
  { workspace, dir = 'stickers' } = {},
  { force = false, rels = null, onlyPending = false } = {},
) {
  if (!workspace) return { ok: false, why: '没有工作区，读不到表情库', total: 0, todo: 0, skippedManual: 0, needsKey: true, model: null }
  const library = readStickerLibrary({ workspace, dir })
  const { todo, skippedManual, total } = selectTagTargets(library, { rels, skipManual: !force, onlyPending })
  return { ok: true, total, todo: todo.length, skippedManual, needsKey: true, model: null }
}

/**
 * 造一个"重新打标签"的任务控制器（**同一时刻只允许一个**）。
 *
 * ── 为什么需要"只允许一个" ────────────────────────────────────────────────
 * 按钮可以被连点；两个并发任务会同时调模型、同时写 `library.json`，
 * 后写的覆盖先写的（丢结果），而且账单是双份。所以这里用状态机挡住：
 * 已有 running 的任务时，第二次 start() **明确返回已在跑**（不是静默忽略）。
 *
 * ── 为什么写成"查询式"而不是让 HTTP 请求挂着 ──────────────────────────────
 * 打 200 张要几分钟到十几分钟，而浏览器/代理不会等那么久。
 * 所以接口是"发起 → 立刻返回 jobId → 界面轮询 status"。
 */
export function createRetagJob({ log = () => {}, now = () => Date.now(), resolvePreflight = null } = {}) {
  let state = idle()

  function idle() {
    return {
      id: null,
      phase: 'idle', // idle | running | done | failed | aborted
      startedAt: null,
      finishedAt: null,
      /** 空闲时它是**预检结果**（会有多少张要打）；在跑时是这次任务的总数。 */
      total: 0,
      /** 空闲时的预检：库里一共多少张 / 会有多少张被跳过（人工标签）。 */
      libraryTotal: 0,
      pendingPreview: 0,
      done: 0,
      tagged: 0,
      retagged: 0,
      failed: 0,
      skippedManual: 0,
      current: null,
      lastLabel: null,
      reason: '',
      failedList: [],
      limit: 0,
    }
  }

  const signal = { aborted: false }

  /** 起一次任务（**不 await** —— 立刻返回 jobId，进度靠 status() 查）。 */
  function start(options = {}) {
    if (state.phase === 'running') {
      return { ok: false, why: '已经有一次重新打标签在跑了（等它结束，或先点停止）', jobId: state.id }
    }
    const pre = preflightRetag(
      { workspace: options.workspace, dir: options.dir },
      { force: options.force, rels: options.rels, onlyPending: options.onlyPending === true },
    )
    if (!pre.ok) return { ok: false, why: pre.why }
    if (pre.todo === 0) {
      return {
        ok: false,
        why: pre.skippedManual > 0
          ? `没有可重打的图：${pre.skippedManual} 张是人工改过的标签（默认不动它们）`
          : '库里还没有图（先导入）',
      }
    }

    state = {
      ...idle(),
      id: `retag-${now()}`,
      phase: 'running',
      startedAt: now(),
      total: pre.todo,
      skippedManual: pre.skippedManual,
    }
    signal.aborted = false

    // ★ 刻意**不 await**：调用方（HTTP 路由）要立刻回响应，否则界面会转圈等到超时。
    void (async () => {
      try {
        const r = await runTagging({
          ...options,
          signal,
          onProgress: (p) => {
            state.done = p.done
            state.current = p.rel
            if (p.ok) {
              state.lastLabel = `${p.labelName}（${p.label}）conf=${p.confidence}`
              if (p.retagged) state.retagged += 1
              else state.tagged += 1
            } else {
              state.failed += 1
              if (state.failedList.length < 20) state.failedList.push({ rel: p.rel, why: String(p.why ?? '') })
            }
          },
        })
        // 写回：**只有成功的那些**（失败的条目保持原样 —— 它们仍在待定区，下次再打）
        if (Object.keys(r.updates ?? {}).length > 0) {
          const { applyStickerLabels } = await import('./sticker-library.mjs')
          applyStickerLabels({ workspace: options.workspace, dir: options.dir }, r.updates)
        }
        state.finishedAt = now()
        state.aborted = Boolean(r.aborted)
        state.phase = r.ok ? (r.aborted ? 'aborted' : 'done') : 'failed'
        state.reason = r.why ?? ''
        state.failedList = [...state.failedList, ...(r.failedList ?? []).slice(0, 20)]
        log(
          `[sticker] 重新打标签${r.aborted ? '（被停止）' : ''}：打上 ${r.tagged}、重打 ${r.retagged}、` +
            `失败 ${r.failed}、跳过人工 ${r.skippedManual}${r.why ? `｜${r.why}` : ''}`,
        )
      } catch (error) {
        state.finishedAt = now()
        state.phase = 'failed'
        state.reason = `任务异常：${error?.message ?? error}`
        log(`❌ [sticker] 重新打标签异常：${state.reason}`)
      }
    })()

    return { ok: true, jobId: state.id, total: state.total, skippedManual: state.skippedManual }
  }

  /** 请求停止（当前那张跑完就停；**不中断正在进行的请求**）。 */
  function abort() {
    if (state.phase !== 'running') return { ok: false, why: '当前没有在跑的任务' }
    signal.aborted = true
    state.reason = '已请求停止（当前这张跑完就停）'
    return { ok: true }
  }

  function status() {
    // ★ 空闲时**现算一次预检**（纯读库，零模型调用）：界面才能在做二次确认时
    //   说出"这次会打 N 张、跳过 M 张人工标签"。不这么做的话，用户点下按钮之前
    //   看到的是一个没有信息量的 0。
    let preview = null
    if (state.phase !== 'running' && typeof resolvePreflight === 'function') {
      try {
        preview = resolvePreflight()
      } catch {
        preview = null
      }
    }
    const total = state.phase === 'running' ? state.total : (preview?.todo ?? state.total)
    return {
      ...state,
      total,
      libraryTotal: preview?.total ?? state.libraryTotal,
      // ★ 名字要说准：它**不是**"待打标签的张数"，而是"这次会处理多少张"。
      //   "重新打标签"的语义是**全部重打**（含已经打好的），所以空闲时它通常
      //   等于库里的总数 —— 叫 pending 会让人以为"只有待定的那些会被处理"。
      willProcess: preview?.todo ?? state.pendingPreview,
      pendingPreview: preview?.todo ?? state.pendingPreview, // 旧名保留（界面可能还没更新）
      // ★ 预检发现"没有可打的了"时，把原因直接给界面（否则按钮点了才报错，多一次往返）
      preflightWhy: preview && !preview.ok ? preview.why : '',
      percent: total > 0 ? Math.round((state.done / total) * 100) : null,
      running: state.phase === 'running',
    }
  }

  return { start, abort, status }
}
