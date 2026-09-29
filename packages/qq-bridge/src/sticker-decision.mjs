/**
 * 发表情包的**判定**：什么时机发、发哪一张。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个模块的全部职责就是"说不"
 * ══════════════════════════════════════════════════════════════════════════
 * 发错图是这个功能唯一**无法解释、撤不回、用户当场能看到**的错误。
 * 所以这里的每一层都是否决层，任何一层不过就 `action:'skip'` 并**给出原因**：
 *
 *   0 能力  技能开着？库里有可用图？要发的文件真的在？
 *   1 硬否决 报错/权限被拒/隐私被拦/对方认真求助/正文太长
 *   2 触发  模型写了 `[sticker:标签]` → 采纳；否则从正文抽态度（抽不出就不发）
 *   3 打分  低于阈值 → 不发（**绝不为"用上这个功能"而凑一张**）
 *   4 配额  冷却 / 每 N 轮 / 每日上限（`sticker-quota.mjs`）
 *
 * ── 一条关键顺序纪律（这是"自主"最容易做错的地方）──────────────────────
 * **自主补图必须先看正文说了什么，再去选图**，而不是"想发图然后找个理由"。
 * 顺序反了就会出现：模型回了一大段正经技术答案，末尾贴一张"无语脸"。
 * 所以 `decideSticker()` 的第 2 层是"从 `replyText` 抽态度"，
 * 抽不出态度向量 → 直接不发（宁可漏发）。
 *
 * ── 两条触发的关系 ────────────────────────────────────────────────────────
 *   · 模型主动（`[sticker:标签]`）：**最高优先**，但配额照旧要走（模型不能绕过频率）。
 *   · 桥接自主补：只在上面那条没命中时才做。
 * 两者**同一轮最多发一张**（`maxPerTurn` 兜底）。
 *
 * ★ 本模块是纯函数（时间由 `now` 注入、库由 `candidates` 注入），
 *   所以"每一层拒绝原因"都能被离线单测钉住 —— 这是它敢真发的前提。
 */

import { existsSync } from 'node:fs'
import { MIN_USABLE_PER_LABEL, RISK_LABEL, isUsableCue } from './sticker-labels.mjs'
import {
  activeIsAutoAllowed,
  activeLabelById,
  activeLabelName,
  activeLabels,
  axisSide,
  resolveActiveLabelId,
} from './sticker-vocab.mjs'
import { checkStickerQuota, resolveFrequency } from './sticker-quota.mjs'

/** 默认的打分阈值：低于它就不发。 */
export const DEFAULT_SCORE_THRESHOLD = 4

/** 默认的正文长度上限：超过就不配图（读起来是"讲完一大段再贴个表情"，很假）。 */
export const DEFAULT_MAX_REPLY_CHARS = 120

/**
 * 硬否决：这些情况**永远不发表情**（不可配置）。
 *
 * 为什么不做成配置项：与隐私闸门同一个理由（`bridge.mjs:2280`）——
 * 做成开关就等于给了一个"把道歉场景变成发表情"的入口，而关掉之后
 * 没有任何提示，表现成"它开始在严肃场合乱发图"（那是更难发现的失败）。
 */
const HARD_VETO_RULES = [
  { id: 'error', re: /（我执行了操作但没有输出文字|这次没有产生回复内容|处理超时|发送失败|没能把回复发出去）/ },
  { id: 'permission', re: /(没有权限|做不了|管理员才能|被拒绝|越界|不允许)/ },
  { id: 'privacy', re: /(隐私|敏感|不方便说|不能透露)/ },
  { id: 'apology', re: /(抱歉|对不起|不好意思|是我的错|我错了)/ },
  { id: 'help-seeking', re: /(怎么(办|弄|做|搞)|如何|帮我|求(你|助)|请问|教我|来个方案|报错|错误码|stack|traceback)/i },
]

/**
 * 每个标签的线索表（**每轮现算**：词表现在是数据文件，用户可以在标注台里实时加标签）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么线索要分两组（0.2.4 第十三轮；用户的观察直接促成的改动）
 * ══════════════════════════════════════════════════════════════════════════
 * 原来只有一组 `cues`，而它匹配的是……`replyText`，也就是**bot 自己要说的话**。
 * 于是 cue 里混进了两种根本不同的东西，其中一个方向是**结构性死路**：
 *
 *   · **ownCues（bot 自己的表达）**：`抱抱`、`没事的`、`emmm`、`确实`、`搞定了`
 *     —— bot 真的会说这些，匹配它自己的正文是对的。
 *   · **otherCues（对方/场景的信号）**：`我好累`、`困`、`熬夜`、`可爱`、`awsl`
 *     —— 这些是**对方**会说的话。挂在 bot 正文上**永远命中不了**：
 *     一个助手不会说"我好累、我熬夜了"，于是 `tired`（9 张图）事实上是死代码，
 *     除了模型主动写 `[sticker:tired]` 永远发不出去（实测确认）。
 *
 * ∴ 现在两组分开匹配（见 `extractAttitude`）：
 *   · `ownCues`（**旧字段名 `cues` 继续有效**，语义就是"bot 自己的表达"）→ 只看 bot 正文
 *   · `otherCues` → 看**对方那条消息**
 *
 * 纪律不变：**仍然是白名单**。没写进任一组线索的语境不会触发 ——
 * 这次改动只把"本来就该触发但够不着"的语境接上，不会让没教过的语境乱触发。
 *
 * ★ 必须过 `isUsableCue` 那道短线索守卫（见 `sticker-labels.mjs` 的说明）：
 *   单字线索在中文里到处都是边界（`行` 会被"就行"命中），放进匹配就是随机发错图。
 *   长的线索排前面，避免"没看懂"被"看懂"抢先命中。
 *
 * ★ 排除词也分两套（这也是必须的）：
 *   · `exclude` —— 只看 bot 正文（防语义反转：被怼 ≠ 挑衅）；
 *   · `excludeOther` —— 只看对方消息（防场景误判：对方在**认真求助**时不该配"无语脸"）。
 *   不能合成一个集合，因为它们的适用文本根本不同。
 *
 * @param {{ workspace?: string, dir?: string }} [vocabOpts] 词表位置（不给就用内置默认表）
 */
function buildCueIndex(vocabOpts = {}) {
  const clean = (list) =>
    (Array.isArray(list) ? list : []).filter(isUsableCue).sort((a, b) => b.length - a.length)
  const lower = (list) => (Array.isArray(list) ? list : []).map((x) => String(x).toLowerCase()).filter(Boolean)
  return activeLabels(vocabOpts)
    .map((l) => {
      // ★★ 轴的**三分类**决定这条标签只看哪一侧（0.2.4 第十六轮，用户定义）：
      //   主体类（状态/交付）只看自身发言、客体类（认知反应/表态）只看对方发言、
      //   混合类两边都看。这是**结构性**的判断，比逐条线索判断可靠。
      //   `unknown`（风险等不在三分类里的轴）保持原样，不替用户改。
      const side = axisSide(l.axis)
      const useOwn = side === 'self' || side === 'both' || side === 'unknown'
      const useOther = side === 'other' || side === 'both' || side === 'unknown'
      return {
        id: l.id,
        // `cues` 是旧字段名，与 `ownCues` 同义；两个都收，旧词表不改也能继续工作
        ownCues: useOwn ? [...new Set([...clean(l.cues), ...clean(l.ownCues)])] : [],
        otherCues: useOther ? clean(l.otherCues) : [],
        excludes: [...new Set([...lower(l.exclude), ...lower(l.excludeOther)])],
        excludesOther: lower(l.excludeOther),
      }
    })
    .filter((x) => x.ownCues.length > 0 || x.otherCues.length > 0)
}

/**
 * 长线索（≥ 这个字数）信息量大，两侧都被包住也认（`笑死我了` 里的 `笑死我了`）。
 * 短线索必须独立成词且占正文足够比例。
 */
const LONG_CUE_CHARS = 4

/** 命中线索至少要占正文这么高比例，才认为"这句话就是在表达这个动作"。 */
export const CUE_DENSITY_MIN = 0.4

/**
 * 正文里所有"独立成词"的线索命中位置。
 *
 * 「独立成词」= 两侧至少有一侧是边界（标点/空白/句首句尾）。
 * 这一条挡的是 `运**行**一下就…` 这类**词内部**命中；而 `哈哈哈笑死我了`
 * 仍然算（`哈哈哈` 在句首，左侧是边界）—— 后者是最典型的真实语料，不能漏。
 */
function cueOccurrences(text, cue) {
  const t = String(text ?? '')
  const c = String(cue ?? '')
  if (!c) return []
  const isWordChar = (ch) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch)
  /** 句末助词/语气词：它们**可以**紧跟在线索后面而仍然算边界。
   *
   *  这条是实测补的（第二处误判）：`太累了` 里的 `累` 右边是「了」，而「了」按
   *  `\p{L}` 算"词内字符"，于是左侧的「太」一挡，整条线索就废了 ——
   *  可"太累了"明明是最典型的疲惫表达（`好累` 能中、`太累了` 中不了，纯属偶然）。
   *
   *  ⚠️ **只放在右边**：左边是助词时仍然不算边界（`的累` 这种不该命中）。
   *     这是保守的做法 —— 中文里助词跟在**被修饰词之后**，所以只有右边界有意义。 */
  const isTailParticle = (ch) => ch !== undefined && TAIL_PARTICLES.has(ch)
  const out = []
  let from = 0
  for (;;) {
    const idx = t.indexOf(c, from)
    if (idx === -1) return out
    const leftBoundary = idx === 0 || !isWordChar(t[idx - 1])
    const afterIdx = idx + c.length
    const rightBoundary = afterIdx >= t.length || !isWordChar(t[afterIdx]) || isTailParticle(t[afterIdx])
    out.push({ idx, len: [...c].length, leftBoundary, rightBoundary })
    from = idx + 1
  }
}

/** 句末助词（用在 `cueOccurrences` 的右边界判定里；见那里的长注释）。 */
const TAIL_PARTICLES = new Set(['了', '吧', '呢', '啊', '呀', '啦', '嘛', '哦', '喔', '哈', '咯', '嘞'])

/**
 * 这条线索在正文里算不算命中。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三道守卫（前两条都是**实测抓出来的**，不是想象出来的）
 * ══════════════════════════════════════════════════════════════════════════
 * ① **裸单字线索不参与**（`SAFE_SINGLE_CHAR_CUES` 白名单除外）：
 *    `行` 会被"就**行**""银**行**"命中 —— 修之前实测到的第一个假阳性。
 * ② **左侧必须是句子边界**：
 *    `运**行一下就**知道了` 命中 dismiss 的「知道了」，可这句明明是
 *    "你去跑一下就知道" —— 实测抓到的第二个假阳性，比第一个隐蔽。
 * ③ **句首，或整条消息基本就是它**：既保住 `确实，你说的对`（句首表态），
 *    也不会被"一大段话里夹一个短词"骗到。
 *
 * 三条合起来的结果是**宁漏勿错**：漏发一张表情可以接受，
 * 在一个普通句子上发错图不行。
 */
export function cueHits(text, cue) {
  if (!isUsableCue(cue)) return false
  const src = String(text ?? '')
  const c = String(cue)
  if (!src.includes(c)) return false
  const occ = cueOccurrences(src, c)
  if (!occ.length) return false
  // 长线索（≥4 字）本身信息量大：两侧都是词内字符也认（`笑死我了` 里的 `笑死我了`）
  if ([...c].length >= LONG_CUE_CHARS) return true
  // 短线索的守卫（都是实测抓出来的）：
  //   ① **必须有左侧边界** —— 挡住 `运**行一下就**知道了`（左侧是「就」）
  //   ② 再分两种：
  //      · **2 字**：它们是"绑定短语"（绝了/就这/算了/好累/确实/知道了），
  //        位置很自由、本身歧义低 —— 只要左边是边界就算命中。
  //        ⚠️ 这里踩过一个真 bug：2 字线索原先要求"句首或占正文 ≥40%"，
  //        于是 `太绝了`（在句尾、占 40%）被判不中 —— 而 `绝了` 明明是词组结尾的常见形态。
  //      · **3 字**：歧义高得多（`哈哈哈` 也可能只是傻笑），
  //        所以额外要求"句首或整条基本就是它"（`确实，你说的对` 靠句首过）。
  const leftOk = occ.some((o) => o.leftBoundary)
  if (!leftOk) return false
  if ([...c].length <= 2) return true
  const total = [...src].length || 1
  const covered = occ.reduce((s, o) => s + o.len, 0)
  const startsSentence = occ.some((o) => o.idx === 0)
  const dominated = covered / total >= CUE_DENSITY_MIN
  return startsSentence || dominated
}

/**
 * 在**对方消息**里找线索（0.2.4 第十三轮）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么不能直接复用 `cueHits`（这是实测踩出来的，不是洁癖）
 * ══════════════════════════════════════════════════════════════════════════
 * `cueHits` 的三道守卫是**为 bot 的短回复**调的（那时正文常常只有一句、
 * 甚至就俩字）。用户消息完全不是那个形状 —— 它更长、更散、关键词埋在句子中间：
 *
 *   "我好累啊，今天加班到现在"   ← `好累` 左边是「我」、右边是「啊」
 *   "这也太可爱了吧"            ← `可爱` 左边是「太」、右边是「了」
 *   "我太冤了，明明不是我干的"    ← `好冤` 根本不在（人家说的是"太冤"）
 *
 * 用 `cueHits` 的结果是这些**最典型的表达一个都命中不了**（实测：全部 miss），
 * 于是"对方累了"这个语境照样够不着 —— 改了等于没改。
 *
 * ∴ 对对方消息改用一套**稍宽但仍然保守**的判据：
 *   ① **单字线索一律不要**（`早` 会在「早点休息」里命中 —— 实测的假阳性）；
 *   ② 2 字及以上：只要**出现在句子里**就算（不再要求句首或高占比）。
 *      这些线索都是"绑定短语"（好累/算了/可爱/加班到），歧义本来就低；
 *   ③ 宁可放过一点，因为这一侧还有 `excludeOther` + `antiCues` 兜着，
 *      而且**误发**才是要防的事 —— 而误发主要来自场景判断（对方在求助时别配无语脸），
 *      那种情况靠场景排除词挡，不靠词面严格度挡。
 */
export function cueHitsInMessage(text, cue) {
  const c = String(cue ?? '')
  // ① 单字线索在长消息里太危险（`早`→「早点休息」是实测抓到的假阳性）
  if ([...c].length < MIN_MESSAGE_CUE_CHARS) return false
  if (!isUsableCue(c)) return false
  return String(text ?? '').includes(c)
}

/**
 * 对方消息里的线索**最短字数**：2。
 *
 * 单字线索在长句里太容易假阳性（实测：`早` 命中「**早**点休息吧」，
 * 于是 bot 回一句"早点休息"就被判成"对方在打招呼"）。所以对方消息这一侧
 * 直接不接受单字线索 —— 词表里也就没必要再为它维护白名单。
 */
export const MIN_MESSAGE_CUE_CHARS = 2

/**
 * 单字线索的权重（与多字线索相对）。
 *
 * 为什么单字要减半（学自同类实现 `sticker-admin` 的 `tagsFromText`）：
 * "怼/逗/梗/尬"这种字在中文里随处可见，按长度给满分会让它压过**真正说明问题**的
 * 双字词 —— "摆烂"(2) 应当赢过 "怼"(0.5)。这里用 0.5，与那边一致。
 */
export const SINGLE_CHAR_SCORE = 0.5

/**
 * ★★ **压制对** `[赢家, 输家]`：两者都命中时，只留赢家。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（`exclusive` 字段做不到这件事）
 * ══════════════════════════════════════════════════════════════════════════
 * 词表里每个标签有个 `exclusive` 字段（"与谁容易混"），但它**只写进提示词**给模型看，
 * 代码层面不生效 —— 所以「哈哈哈笑死我了」这种正文，`laugh` 与 `awkward-smile`
 * 可能同时命中，选谁全看打分，而打出来的结果可能自相矛盾。
 *
 * 压制对解决的是**近义标签同时命中**：留语义更准的那个，丢掉更泛的那个。
 *
 * ⚠️ 这张表是**保守的起点，不是定论**。同类实现（`sticker-admin`）明确记着一条教训：
 *   它曾经有 `[mock, tease]`（嘲讽压逗乐），那是**错的** —— 提示词里只要带"怼"字，
 *    纯逗乐的图就永远拿不到「逗乐」。所以：
 *    · 只压**语义包含关系**（更具体的赢），不压"看起来更重"的；
 *    · 改这张表要有理由，并且跑 `verify-sticker-decision` 的压制断言。
 */
export const SUPPRESS_PAIRS = Object.freeze([
  ['awkward-smile', 'laugh'], // "又好笑又无奈" 比单说"被逗乐"具体
  ['question-mark', 'confused'], // 荒诞反问比"没听懂"更具体
  ['comfort', 'sad'], // 主动安慰压住"自怜"
  ['spite', 'disgust'], // 挑衅带明确攻击性，比单纯嫌弃更具体
  // ★ 0.2.4 第十三轮补（两源匹配之后实测抓到的）：
  //   对方说「我太冤了，明明不是我干的」同时命中 `sad`（太冤）与 `innocent`（不是我），
  //   而 `innocent` 的线索更长 ⇒ 权重更高 ⇒ **判成"装无辜"**。
  //   可"喊冤"与"装无辜"在语义上正是**包含关系**：装无辜是"明明有错却说自己没错"，
  //   喊冤是"本来就没做"。对方的原话里带着情绪（太冤了）时，`sad` 才是更准的那个。
  ['sad', 'innocent'],
])

// ★ `RISK_LABEL` 从 `sticker-labels.mjs` 转出（**单一来源**；`isRiskyEntry` 住在
//   `sticker-library.mjs`，因为过滤发生在那一层，而那层不能反过来 import 本模块）。
export { RISK_LABEL }

/**
 * 从正文里抽**态度向量**（两组线索、两段文本）。
 *
 * 判据（每一层都是实测/借鉴来的，不是拍的）：
 *   ① **排除词优先**：命中 `exclude` / `excludeOther` → 该标签**整条作废**
 *      （不是扣分）。实测语义反转的例子：「被怼得说不出话」不该拿 `spite`(挑衅)，
 *      「被击中」不该拿 `moved`(被萌到)。
 *   ② **线索按字长计分**：单字 0.5、多字按长度。避免"怼/逗/梗"压过"摆烂"。
 *   ③ **压制对**：近义标签都命中时只留更具体的那一个。
 *
 * ── ★★ 两组的**优先级**不是平等的（这是实测逼出来的，很重要）─────────────
 * 一开始我让两组"权重相加、谁高算谁"，结果一批典型语境全错：
 *
 *     对方说「这也太可爱了吧」 + bot 回「**确实**很可爱」
 *       → ownCues 命中 `agree` 的「确实」(权重 2)
 *       → otherCues 命中 `moved` 的「太可爱」(权重 3)
 *     最后确实选对了 moved，但**对方说「我太冤了，明明不是我干的」**时：
 *       ownCues 还是「确实」(2)，otherCues 的 `sad`「明明」(2) → 打平，
 *       按词表顺序 `agree` 更靠前 ⇒ **判成"赞同"**，而对方在喊冤。
 *
 * 根因：**bot 自己那张嘴太爱说套话**（确实/好的/明白了），而套话会盖过真正的信号。
 * ∴ 规则改成明确的**优先级**：
 *   · **对方消息里有信号 → 以它为准**（那是"发生了什么事"，是判断的真正依据）；
 *   · 只有对方消息抽不出 → 才用 bot 自己的表达（"我这样回应"）。
 * 这与"宁可漏发"的既有倾向一致：拿不准就不发，而不是拿套话硬凑一个。
 *
 * @param {string} text bot 这一轮**将要发出去的正文**（标记已剥）
 * @param {{ workspace?: string, dir?: string }} [vocabOpts] 词表位置
 * @param {string} [userText] 对方这一轮发来的消息（不给就只匹配 bot 自己的线索）
 * @returns {{ id: string, hits: number, matched: string[], weight: number, source: 'self'|'other'|'both' }|null}
 */
export function extractAttitude(text, vocabOpts = {}, userText = '') {
  const own = String(text ?? '')
  const other = String(userText ?? '')
  if (!own.trim() && !other.trim()) return null
  const ownLower = own.toLowerCase()
  const otherLower = other.toLowerCase()
  const cueIndex = buildCueIndex(vocabOpts)
  const order = activeLabels(vocabOpts).map((l) => l.id)
  const scored = []
  for (const { id, ownCues, otherCues, excludes, excludesOther } of cueIndex) {
    // ① 排除词优先于命中词：整条作废（两套各管一段文本）
    if (excludes.some((x) => ownLower.includes(x))) continue
    if (excludesOther.some((x) => otherLower.includes(x))) continue
    const hitOwn = ownCues.filter((c) => cueHits(own, c))
    // ★ 对方消息用**更宽**的判据（见 `cueHitsInMessage` 的长说明）：
    //   `cueHits` 的三道守卫是为 bot 的短回复调的，套在长消息上会让
    //   "我好累啊"这类最典型的表达一个都命中不了。
    const hitOther = otherCues.filter((c) => cueHitsInMessage(other, c))
    if (!hitOwn.length && !hitOther.length) continue
    // ② 按字长计分（单字减半）。两组分开记分 —— 因为**优先级不同**（见上）。
    const weigh = (list) => list.reduce((s, m) => s + ([...m].length <= 1 ? SINGLE_CHAR_SCORE : [...m].length), 0)
    const weightOwn = weigh(hitOwn)
    const weightOther = weigh(hitOther)
    // ★ `matched` 前缀标明来自哪一段 —— 决策流水要能解释"为什么是这张"，
    //   而"因为对方说累了"和"因为我自己在说 emmm"是完全不同的理由。
    const matched = [...hitOwn, ...hitOther.map((m) => `对方:${m}`)]
    const source = hitOwn.length && hitOther.length ? 'both' : hitOwn.length ? 'self' : 'other'
    scored.push({ id, hits: matched.length, matched, weightOwn, weightOther, weight: weightOwn + weightOther, source })
  }
  if (!scored.length) return null
  // ③ 压制：赢家也在命中集里时，丢掉输家
  const alive = new Set(scored.map((s) => s.id))
  for (const [winner, loser] of SUPPRESS_PAIRS) {
    if (alive.has(winner) && alive.has(loser)) alive.delete(loser)
  }
  const pool = scored.filter((s) => alive.has(s.id))
  // ④ **优先级**：先只在"对方消息有信号"的那批里选；一个都没有才回头看 bot 自己
  const fromOther = pool.filter((s) => s.weightOther > 0)
  const ranked = (fromOther.length ? fromOther : pool)
    .sort(
      (a, b) =>
        // 有对方信号的，先按对方信号比；这就是"以对方的话为准"
        b.weightOther - a.weightOther ||
        b.weightOwn - a.weightOwn ||
        order.indexOf(a.id) - order.indexOf(b.id),
    )
  return ranked[0] ?? null
}

/** 硬否决检查（返回 null = 没被否决）。 */
export function checkHardVeto(replyText, { maxReplyChars = DEFAULT_MAX_REPLY_CHARS } = {}) {
  const text = String(replyText ?? '')
  for (const rule of HARD_VETO_RULES) {
    const hit = text.match(rule.re)
    if (hit) return { id: rule.id, matched: hit[0] }
  }
  const len = [...text].length
  if (len > maxReplyChars) return { id: 'too-long', matched: `${len} 字 > ${maxReplyChars}` }
  return null
}

/**
 * 给候选打分。**每个加分项都要留下理由**（决策流水要能解释"为什么是这张"）。
 *
 * 权重设计（不用玄学数字，每一条都能说清）：
 *   +3 本会话的图（群里人认得出，才像群里的人）
 *   +0 全局兜底图（允许，但优先级明显更低）
 *   +2 主标签命中 / +0.5 次要标签命中
 *   +2 正文线索直接命中该标签
 *   -1.5 本会话最近发过这张
 *   -1 本会话最近发过这个标签的图
 *   -0.5 全局用过太多次（越用越不想再用同一张脸）
 *
 * ⚠️ 候选里**不会出现"别的会话的图"**（`buildStickerCandidates` 已经滤掉），
 *    所以这里不存在"+0 但可能被选中"的跨群路径。
 */
export function scoreStickerCandidate(
  candidate,
  { attitude, replyText, recentRels = [], recentLabels = [], vocabOpts = undefined } = {},
) {
  const entry = candidate?.entry ?? {}
  const reasons = []
  let score = 0

  const scopeBonus = Number(candidate?.scopeRank ?? 0)
  if (scopeBonus >= 1) {
    score += 3
    reasons.push('本会话图 +3')
  } else {
    reasons.push('全局兜底图 +0')
  }

  if (attitude?.id && entry.primary === attitude.id) {
    score += 2
    reasons.push(`主标签命中（${activeLabelName(attitude.id, vocabOpts)}）+2`)
  } else if (attitude?.id && Array.isArray(entry.labels) && entry.labels.includes(attitude.id)) {
    score += 0.5
    reasons.push(`次要标签命中（${activeLabelName(attitude.id, vocabOpts)}）+0.5`)
  } else {
    reasons.push('标签不匹配 +0')
  }

  const def = activeLabelById(entry.primary, vocabOpts)
  if (def && replyText) {
    const hit = (Array.isArray(def.cues) ? def.cues : []).find((c) => cueHits(replyText, c))
    if (hit) {
      score += 2
      reasons.push(`正文线索「${hit}」命中 +2`)
    }
  }

  const abs = String(candidate?.absPath ?? '')
  const rel = String(entry.file ?? '')
  if (rel && recentRels.includes(rel)) {
    score -= 1.5
    reasons.push('本会话最近发过这张 -1.5')
  }
  if (entry.primary && recentLabels.includes(entry.primary)) {
    score -= 1
    reasons.push(`最近发过「${activeLabelName(entry.primary, vocabOpts)}」-1`)
  }
  const used = Number(entry.usedCount ?? 0)
  if (used >= 3) {
    score -= 0.5
    reasons.push(`这张图历史用过 ${used} 次 -0.5`)
  }

  return { score: Math.round(score * 100) / 100, reasons, rel, absPath: abs }
}

/**
 * 从候选里选出最高分。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么要"在最高分那一档里随机挑"，而不是死板地取排序第一
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版是 `sort(分数, rel)` 之后取第一个。看起来"稳定"，实际有两个坏处：
 *   · **一个标签下多张图时，只有哈希最小的那张会被选中** ——
 *     同一标签的图作用域相同、标签相同、线索命中相同，分数完全一样，
 *     于是排序结果永远指向同一张。库里另外 9 张等于白导入
 *     （用户会看到"它老发同一张脸"，而库明明很丰富）。
 *   · 那个"稳定"其实没有价值：真正要稳定的是**同一轮不要抖动**，
 *     而这里是每轮独立决策一次，随机反而更像人。
 *
 * ∴ 现在的规则：先按分数排序，**只保留最高分那一档**，在其中随机取一张。
 *   ★ 随机源可注入（`random`）—— 否则测试会变成"有时过有时不过"，那是不可接受的。
 *
 * @param {Array} candidates
 * @param {{ attitude?: object, replyText?: string, recentRels?: string[], recentLabels?: string[], random?: () => number }} [context]
 */
export function pickBestSticker(candidates, context = {}) {
  const random = typeof context.random === 'function' ? context.random : Math.random
  const scored = candidates
    .map((c) => ({ candidate: c, ...scoreStickerCandidate(c, context) }))
    .sort((a, b) => b.score - a.score || String(a.rel).localeCompare(String(b.rel)))
  const best = scored[0] ?? null
  if (!best) return { best: null, scored }
  const tied = scored.filter((s) => s.score === best.score)
  if (tied.length <= 1) return { best, scored }
  const idx = Math.min(tied.length - 1, Math.max(0, Math.floor(random() * tied.length)))
  return { best: tied[idx], scored, tiedCount: tied.length }
}

/**
 * 两层触发：优先采纳模型写的标签；否则从正文抽态度。
 *
 * ★★ 自主那条路**只允许表达类标签**（见 `sticker-vocab.activeIsAutoAllowed`）：
 *    功能类（打招呼 / 晚安 / 任务完成）是"这件事的语义标记"，
 *    判断它需要上下文语义，而自主判定只看得到词面 —— 判错的后果是
 *    "任务完成"配在一句"你可以再试一次"上。所以功能类只接受模型主动。
 *
 * @returns {{ source: 'model'|'auto'|null, label: string|null, note: string }}
 */
export function resolveStickerIntent({ requestedLabel, replyText, userText = '', vocabOpts = {} } = {}) {
  const wanted = resolveActiveLabelId(requestedLabel, vocabOpts)
  if (requestedLabel && !wanted) {
    return { source: null, label: null, note: `模型写的标签「${String(requestedLabel).slice(0, 20)}」不在词表里 → 丢掉（不猜）` }
  }
  if (wanted) return { source: 'model', label: wanted, note: `模型主动要「${activeLabelName(wanted, vocabOpts)}」` }

  const attitude = extractAttitude(replyText, vocabOpts, userText)
  if (!attitude) return { source: null, label: null, note: '正文和对方的话里都抽不出态度 → 不自主发（宁可漏发）' }
  if (!activeIsAutoAllowed(attitude.id, vocabOpts)) {
    return {
      source: null,
      label: null,
      note: `正文像「${activeLabelName(attitude.id, vocabOpts)}」，但那是功能类标签（只有模型主动要才发）→ 不自主发`,
    }
  }
  // ★ 理由要说清是**谁**的信号 —— "我自己在说"和"对方说累了"是完全不同的判断，
  //   排障时这一条决定了该去改哪一组线索（ownCues / otherCues）。
  const who =
    attitude.source === 'other' ? '对方说的话像' : attitude.source === 'both' ? '正文和对方的话都像' : '正文像'
  return {
    source: 'auto',
    label: attitude.id,
    note: `自主判断：${who}「${activeLabelName(attitude.id, vocabOpts)}」（命中 ${attitude.matched.join('、')}）`,
  }
}

/**
 * ★ 主判定入口。
 *
 * @param {object} input
 * @param {object} input.config            有效配置（`skills.sticker` 那一块）
 * @param {string} input.replyText         这一轮**将要发出去的正文**（标记已剥）
 * @param {string} [input.userText]        对方这一轮发来的消息（`otherCues` 匹配它）
 * @param {string|null} input.requestedLabel 模型在回复里写的 `[sticker:…]`（已解析，未查表）
 * @param {Array} input.candidates         `buildStickerCandidates()` 的产物
 * @param {object} input.usage             台账（`sticker-quota.readStickerUsage()` 的产物）
 * @param {string} input.scope             会话键（`group:123` / `private:456`）
 * @param {number} input.turnCount         本会话的轮次（可选，0 = 不知道）
 * @param {{workspace?:string, dir?:string}} [input.vocabOpts] 生效词表位置（不给 = 用内置默认表）
 * @param {number} [input.now]
 * @returns {{ action: 'send'|'skip', source, label, rel, absPath, score, reasons, reason, waits }}
 */
export function decideSticker(input = {}) {
  const config = input.config ?? {}
  const vocabOpts = input.vocabOpts ?? {}
  const now = Number(input.now ?? Date.now())
  const scope = String(input.scope ?? 'global')
  const quotaCfg = resolveFrequency(config)
  const threshold = Number.isFinite(Number(config.scoreThreshold))
    ? Number(config.scoreThreshold)
    : DEFAULT_SCORE_THRESHOLD
  const maxReplyChars = Number.isFinite(Number(config.maxReplyChars))
    ? Number(config.maxReplyChars)
    : DEFAULT_MAX_REPLY_CHARS

  const base = { source: null, label: null, rel: null, absPath: null, score: 0, reasons: [], waits: null }

  // ── 第 0 层：能力 ────────────────────────────────────────────────────
  if (config.enabled === false) {
    return { ...base, action: 'skip', reason: '表情包技能已关闭（config.skills.sticker.enabled=false）' }
  }
  const candidates = Array.isArray(input.candidates) ? input.candidates : []
  if (!candidates.length) {
    return { ...base, action: 'skip', reason: '表情库里没有可用图（都还没打标签 / 都被排除）' }
  }

  // ── 第 1 层：硬否决 ─────────────────────────────────────────────────
  const veto = checkHardVeto(input.replyText, { maxReplyChars })
  if (veto) {
    const why = {
      error: '这一轮是报错/兜底话术',
      permission: '这一轮涉及权限被拒',
      privacy: '这一轮涉及隐私',
      apology: '这一轮在道歉',
      'help-seeking': '对方在认真求助',
      'too-long': '正文太长',
    }[veto.id] ?? veto.id
    return { ...base, action: 'skip', reason: `硬否决：${why}（命中「${String(veto.matched).slice(0, 20)}」）` }
  }

  // ── 第 2 层：触发（模型主动 > 自主补）───────────────────────────────
  const intent = resolveStickerIntent({
    requestedLabel: input.requestedLabel,
    replyText: input.replyText,
    // ★ 对方这一轮发来的消息（0.2.4 第十三轮）：`otherCues` 用它匹配。
    //   不给也能跑（退化成"只看 bot 自己的表达"），所以旧调用方不用改。
    userText: input.userText ?? '',
    vocabOpts,
  })
  if (!intent.source) return { ...base, action: 'skip', reason: intent.note }

  // ── 第 3 层：选图 + 打分 ─────────────────────────────────────────────
  // ★★ 顺序纪律：**先验"文件真的在"，再验"这个标签真的有图"**。
  //    反过来的话，库与磁盘不同步时会被误判成"标签没有图"，
  //    于是日志指向错误的方向（用户会去改标签，而真正要做的是 prune）。
  const alive = candidates.filter((c) => existsSync(c.absPath))
  if (!alive.length) {
    return {
      ...base,
      action: 'skip',
      source: intent.source,
      label: intent.label,
      reason: '候选文件都不在磁盘上（库与文件不同步，跑 --stickers --prune 核对）',
    }
  }
  // ★ 模型主动要的标签**必须真的有图**：否则就是"拿别的图顶替"，那是发错图。
  //   注意这一步必须在打分之前 —— 不能让它落到"最高分是别的标签的图"那条路上。
  if (intent.source === 'model' && !alive.some((c) => c.entry?.primary === intent.label)) {
    return {
      ...base,
      action: 'skip',
      source: intent.source,
      label: intent.label,
      reason: `模型要的「${activeLabelName(intent.label, vocabOpts)}」库里没有可用的图 → 不发（不拿别的图顶替）`,
    }
  }

  const { best, scored } = pickBestSticker(alive, {
    attitude: { id: intent.label },
    replyText: input.replyText,
    recentRels: input.recentRels ?? [],
    recentLabels: input.recentLabels ?? [],
    // ★ 打分要看"这条正文线索命中了标签的哪条 clues"，那要读**生效词表**
    vocabOpts: input.vocabOpts,
  })
  if (!best) {
    return {
      ...base,
      action: 'skip',
      source: intent.source,
      label: intent.label,
      reason: '没有可用候选（不该发生：alive 非空却挑不出最高分）',
    }
  }
  void scored

  // ★★ 例外：**模型明确要的那张，不看分数阈值**（0.2.4 实测补）
  //
  // 实测事故：模型写了 `[sticker:comfort]`、库里也有 5 张 comfort 的图，
  // 但从**全局库**来的图只有 2 分（全局兜底 +0、主标签命中 +2），
  // 低于默认阈值 4 → **被静默拒掉**。那一刻模型明确表达了"这一轮该有个抱抱"，
  // 而阈值本意是挡"**自主猜测**不够确定"的情况 —— 两者不是一回事。
  //
  // 所以：模型点名、且**真的是那个标签的图**（更早那一步已保证）时，阈值不参与；
  // **配额仍然参与**（模型不能绕过频率，那一条是账号安全相关的）。
  const modelPicked = intent.source === 'model' && best.candidate.entry.primary === intent.label
  if (best.score < threshold && !modelPicked) {
    return {
      ...base,
      action: 'skip',
      source: intent.source,
      label: intent.label,
      score: best.score,
      reasons: best.reasons,
      reason: `最高分 ${best.score} 低于阈值 ${threshold} → 不发（不为发而发）`,
    }
  }

  // ── 第 4 层：配额 ───────────────────────────────────────────────────
  const quota = checkStickerQuota({
    usage: input.usage,
    scope,
    rel: best.rel,
    now,
    quota: quotaCfg,
    turnCount: input.turnCount ?? 0,
    recentStickerRels: input.recentRels ?? [],
  })
  if (!quota.ok) {
    return {
      ...base,
      action: 'skip',
      source: intent.source,
      label: intent.label,
      score: best.score,
      reasons: best.reasons,
      reason: `配额：${quota.reason}`,
      waits: quota.waitMs ?? null,
    }
  }

  return {
    action: 'send',
    source: intent.source,
    label: intent.label,
    rel: best.rel,
    absPath: best.absPath,
    score: best.score,
    reasons: [...best.reasons, intent.note],
    reason: `${intent.note}；选中 ${best.rel}（${best.score} 分）`,
    waits: null,
  }
}

/**
 * 决策流水记录（给控制台与排障用）。
 *
 * ★ 这条不是"锦上添花"：三档频率与阈值都靠它才能调。
 *   没有它，用户看到的就是"有时发有时不发"，谁也说不清为什么。
 */
export function toDecisionRecord(decision, { scope, replyText, userText = '', at = Date.now(), vocabOpts = {} } = {}) {
  return {
    at: new Date(at).toISOString(),
    scope: String(scope ?? ''),
    action: decision.action,
    source: decision.source ?? null,
    label: decision.label ?? null,
    labelName: decision.label ? activeLabelName(decision.label, vocabOpts) : null,
    rel: decision.rel ?? null,
    score: decision.score ?? 0,
    reasons: decision.reasons ?? [],
    reason: decision.reason ?? '',
    replyPreview: String(replyText ?? '').slice(0, 60),
    // ★ 对方那句话也留一小段：自主判定现在有"看对方说了什么"这一路，
    //   排障时没有它就无法区分"我自己在说"与"对方说累了"（0.2.4 第十三轮）。
    userPreview: String(userText ?? '').slice(0, 60),
  }
}

/**
 * 提示词里"怎么要表情"的那几行（**只列真有货的标签**）。
 *
 * 为什么（这是本项目反复踩的一条）：提示词里凡写了的能力都必须是真的。
 * 库里 `无语` 一张图都没有，却告诉模型"可以写无语"，它会写一个永远选不中的标签，
 * 然后用户看到的是"它想发表情但没发" —— `markers.mjs:143` 的既有纪律。
 *
 * ⚠️ **不做长度上限**：这里的内容全部由 CUE 词表与覆盖率决定（不会无限膨胀），
 *    加一个"超了就整段丢掉"的上限只会造成静默失效（有标签却什么都不说）。
 *    真嫌长，该改的是词表本身，或者把图少的标签留到控制台里看。
 *
 * @param {{ coverage?: Record<string, number>, minPerLabel?: number, vocabOpts?: object }} opts
 *   ★ `vocabOpts` 不给就用内置默认表 —— 给了才认得用户在标注台新建的标签。
 * @returns {string[]} 行数组；空数组 = 一个字都不写
 */
export function renderStickerPromptLines({ coverage = {}, minPerLabel = MIN_USABLE_PER_LABEL, vocabOpts = {} } = {}) {
  // ★ 走**生效词表**：标注台新建的标签必须立刻能出现在提示词里（否则模型永远不知道能写它）
  const usable = activeLabels(vocabOpts).filter((l) => Number(coverage[l.id] ?? 0) > 0)
  if (!usable.length) return []
  const strong = usable.filter((l) => Number(coverage[l.id] ?? 0) >= minPerLabel)
  const weak = usable.filter((l) => Number(coverage[l.id] ?? 0) < minPerLabel)
  const list = (arr, withName) => arr.map((l) => (withName ? `${l.id}（${l.name}）` : l.id)).join('、')

  const lines = []
  lines.push('想发**表情包**就在回复里写 `[sticker:标签]`（标签只是给系统选图用的，永远不会作为文字发出去）。')
  if (strong.length) lines.push(`可用的表情包标签：${list(strong, true)}。`)
  if (weak.length) {
    lines.push(`图比较少、偶尔才选得中的标签：${list(weak, false)}（写了也可能因为没合适的图而不发，正文照发）。`)
  }
  if (!strong.length && weak.length) {
    lines.push('⚠️ 现在每种标签的图都很少，选中概率低 —— 没有特别合适的就别写。')
  }
  lines.push('不想发就别写。每轮最多一张，发得太勤会被系统按频率挡掉。')
  lines.push('⚠️ 别为了发表情而发表情：**报错、道歉、对方在认真求助**的时候，系统一定会拦下来。')
  return lines
}

/** 上面那几行的字符串形式（给不需要分行的调用方/测试用）。 */
export function renderStickerPrompt(opts = {}) {
  return renderStickerPromptLines(opts).join('\n')
}

/**
 * 人设段的补充（**给人设用，不列标签**）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（这是漏掉的一环）
 * ══════════════════════════════════════════════════════════════════════════
 * `persona.mjs` 有一条硬规矩：**人设里提到的每一个工具/能力都必须是真实存在的**。
 * 而"能表达哪些反应"这件事原先只活在标签词表里，人设一个字都没说 ——
 * 于是模型不知道发表情这件事的**范围与分寸**，只能靠标签清单自己猜。
 *
 * ── 分工（三处各管一段，不重复）──────────────────────────────────────────
 *   · 人设（本函数）：**范围与分寸** —— 能表达什么、什么时候不该发；
 *   · 提示词段（`renderStickerPromptLines`）：**当前真有货的标签清单与写法**；
 *   · 词表（`sticker-labels.mjs`）：每个标签的语料锚点与负例。
 *
 * ★ 刻意**不在这里列标签**：清单每轮现算（库变了就变），写进人设就会过期，
 *   而且两份清单迟早不一致（本项目最忌讳的那类静默漂移）。
 *
 * ⚠️ **库里一张图都没有时必须返回空串**：否则人设会承诺一个做不到的能力，
 *    正是 `persona.mjs:20` 记着的那条教训。
 */
export function renderStickerPersonaNote({ coverage = {}, vocabOpts = {} } = {}) {
  const usable = activeLabels(vocabOpts).filter((l) => Number(coverage[l.id] ?? 0) > 0)
  if (!usable.length) return ''
  const axes = [...new Set(usable.map((l) => l.axis))]
  // ★ 0.2.4 第十六轮：礼节/交付改为可自主之后，**已经没有"功能类"了**；
  //   唯一仍需要模型主动挑的是**风险闸门**（默认不发那类图）。
  //   这句只在真有这类标签时出现 —— 写了的能力必须是真的。
  const hasManualOnly = usable.some((l) => !activeIsAutoAllowed(l.id, vocabOpts))
  const lines = []
  lines.push(
    `【表情包】你可以用表情包表达**反应**，范围只限于这一轮提示词里列出的那几个标签（现在是：${axes.join('、')}）。`,
  )
  lines.push(
    '表情包表达的是**你这一句在做什么**（在笑 / 无语 / 安慰 / 收尾），不是"你现在的心情" —— ' +
      '没有那种心情就别挑那个图，挑不出来就是不发。',
  )
  if (hasManualOnly) {
    lines.push(
      '有少数标签（例如「慎发」那类）**只有你能挑** —— 系统不会替你挑：' +
        '你真觉得该配才写，别拿它们当装饰。',
    )
  }
  lines.push('宁可整轮不发，也不要为了发表情而挑一个不太对的。')
  return lines.join('\n')
}
