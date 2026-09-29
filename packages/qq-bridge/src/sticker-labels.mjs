/**
 * 表情包标签词表（**封闭集合**）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么按「回应动作」分轴，而不是按情绪分轴
 * ══════════════════════════════════════════════════════════════════════════
 * 按情绪分（开心/难过/生气）会立刻撞上语义重叠：`无语 / 敷衍 / 嫌弃 / 摆烂`
 * 四个词在语感上互相咬，打标签的人（不管是小模型还是人）自己都分不清，
 * 最后表现成 —— 机器人**随机发错图**。而发错图是这个功能里唯一无法解释、
 * 撤不回、且用户会当场看到的错误。
 *
 * 改成「这一轮回复在做什么**动作**」分轴之后：
 *   · 标签天然互斥（一个动作不会同时是"求解释"和"语言反应"）；
 *   · 标签能直接对应"什么场景该发"（见本文件的 cues / antiCues）；
 *   · 打标签时可以按**优先级**判（主动情感 > 认知反应 > 社交姿态 > 攻击性）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三条硬纪律
 * ══════════════════════════════════════════════════════════════════════════
 * ① **封闭**：打标签只能从这 20 个里选。产出不在表里的标签 = 打标签失败
 *    （落待定区），**绝不允许**模型自己发明标签 —— 那会让"选图"失去确定性。
 * ② **不可归类就落待定**：这里没有"其它"这个兜底标签。硬塞一个近似标签
 *    比留在待定区更糟：前者会在某个场景被真的发出去。
 * ③ **标签是内部协议**：它只用于选图，**永远不能作为文字发到聊天里**。
 *
 * ── cues / antiCues 是什么 ────────────────────────────────────────────────
 * · `cues`：这个动作在**正文里**通常长什么样（本地打的语料锚点）。
 *   既用于离线打标签时给模型看，也用于运行期"从正文抽态度"的本地匹配。
 * · `antiCues`：**绝不能配这个标签**的正文特征。它比 cues 更重要 ——
 *   打标签打错只是少一张图，运行期配错就是发错图。
 */

/**
 * 23 个标签（22 个表达/功能类 + 1 个风险类 `risky`）。顺序即"打标签时的优先级参照"。
 *
 * 每个标签：
 *   id       稳定标识（写进 library.json，**改了等于换了一套库**）
 *   name     中文短名（界面与日志用）
 *   axis     所属轴（仅用于界面分组与排障）
 *   cues     正文语料锚点（本地匹配 + 打标签提示词）
 *   antiCues 绝不能配的场景（打标签负例；**只给模型看**）
 *   exclude  ★ 正文里出现这些词时，**本条线索整条作废**（0.2.4 补，学自同类实现）
 *   exclusive 与谁容易混（**只写进提示词**提醒模型别混；代码层面的强制是 `SUPPRESS`）
 */
export const STICKER_LABELS = Object.freeze([
  {
    id: 'comfort',
    name: '抱抱',
    axis: '主动情感',
    // ── ★ 两组线索（0.2.4 第十三轮）────────────────────────────────────
    //  `cues`（= ownCues）: **bot 自己**会说出口的话 → 匹配它要发的正文
    //  `otherCues`        : **对方**会说的话     → 匹配对方那条消息
    // 为什么必须分：原来只有一组 cues 而它匹配的是 bot 自己的正文，
    // 于是"对方说我好累"这类语境永远够不着（助手不会说"我好累"）——
    // `tired` 曾因此是结构性死代码。详见 `sticker-decision.buildCueIndex`。
    cues: ['抱抱', '抱一下', '没事的', '别难过', '心疼', '有我在', '摸摸头'],
    otherCues: ['好难过', '好难受', '心里堵', '想哭', '好烦', '不开心', 'emo了', '崩溃了', '撑不住'],
    antiCues: ['对方在开玩笑', '对方只是在吐槽天气/进度这种小事'],
    // ★ 场景排除词：只在匹配**对方消息**时生效（忙、在求助时别凑过来抱）
    excludeOther: ['怎么', '帮我', '报错', '求', '请问', '教我'],
    exclusive: ['sad'],
  },
  {
    id: 'tired',
    name: '累了',
    axis: '主动情感',
    cues: ['歇会儿', '我先歇了', '困死了', '熬不动了'],
    // ★ 这一组就是本次改动的核心：`累`/`困`/`熬夜` 是**对方**的自述，
    //   挂在 bot 正文上永远命中不了（助手不会说"我好累"）。
    otherCues: ['好累', '太累', '累死', '累麻了', '好困', '熬夜', '加班到', '睡了睡了', '还没睡'],
    antiCues: ['对方在求助', '这是第一轮对话'],
    excludeOther: ['怎么', '帮我', '报错', '求', '请问'],
    exclusive: ['slack', 'deadpan'],
  },
  {
    id: 'moved',
    exclude: ['被击中', '挨打'],
    name: '被萌到',
    axis: '主动情感',
    cues: ['好可爱', 'awsl', '心都化了'],
    // ★ 对方晒出可爱的东西时，bot 回一张"被萌到" —— 这才是这个标签最常见的用法
    otherCues: ['好可爱', '太可爱', '可爱死', 'awsl', '萌化了', '戳中我了', '心都化了'],
    antiCues: ['语境是嘲讽对方', '图/话本身是攻击性的'],
    exclusive: [],
  },
  {
    id: 'laugh',
    exclude: ['被笑', '笑不出来', '苦笑'],
    name: '笑死',
    axis: '被逗乐',
    cues: ['哈哈哈', 'hhhh', '笑死', '笑不活了', '绷不住了', '乐'],
    // ★ 对方讲了个好笑的 —— bot 跟着笑。这是"被逗乐"的本义，
    //   而原来只能靠 bot 自己说"哈哈哈"才触发（它常这么说，所以这条以前勉强能用）。
    otherCues: ['哈哈哈', '笑死', '笑不活了', '绷不住了', '太逗了', '好笑', '笑喷'],
    antiCues: ['对方在认真求助', '话题是负面事件', '带攻击性地笑对方'],
    excludeOther: ['怎么', '帮我', '报错', '请问', '教我', '去世', '走了', '病了'],
    exclusive: ['spite', 'awkward-smile'],
  },
  {
    id: 'shock',
    name: '震惊',
    axis: '认知反应',
    cues: ['啊？', '真的假的', '我去', '不是吧', '卧槽', '离谱了吧'],
    otherCues: ['真的假的', '不是吧', '离谱', '惊呆了', '我去'],
    antiCues: ['这只是没听懂（那是 confused）', '这是荒诞反问（那是 question-mark）'],
    exclusive: ['confused', 'question-mark'],
  },
  {
    id: 'confused',
    name: '疑惑',
    axis: '认知反应',
    cues: ['啥。', '没看懂', '啥意思', '什么意思', '哪来的', '我怎么不知道', '说清楚点'],
    otherCues: ['啥意思', '什么意思', '没看懂', '看不懂', '这是啥', '哪来的'],
    antiCues: ['这是荒诞反问（那是 question-mark）', '这是认知冲击（那是 shock）'],
    exclusive: ['question-mark', 'shock'],
  },
  {
    id: 'question-mark',
    name: '问号',
    axis: '认知反应',
    cues: ['？？？', '???', '你有事吗', '你有病吧', '这什么鬼', '认真的吗'],
    otherCues: ['？？？', '???', '什么鬼', '认真的吗', '你有病吧'],
    antiCues: ['真的在求解释（那是 confused）'],
    excludeOther: ['怎么', '帮我', '报错', '请问'],
    exclusive: ['confused', 'shock', 'deadpan'],
  },
  {
    id: 'deadpan',
    name: '无语',
    axis: '认知反应',
    cues: ['6', '呃', '额', 'emmm', '就这', '随你', '6啊'],
    // ★ 客体类（认知反应）：**只看对方发言**（轴的规则见 `AXIS_SIDE`），
    //   所以这里才是"对方无语"的常见说法；上面的 `cues` 是出厂遗留，运行期已被轴的规则忽略。
    otherCues: ['就这', '6', '无语', '服了', '离谱', 'emmm', '呃'],
    antiCues: ['对方在认真求助', '这是明确否定立场（那是 disagree）', '对方在难过'],
    // ★ "无语"最容易被误发的场景就是对方在讲一件正经/糟糕的事 —— 必须挡住
    excludeOther: ['怎么', '帮我', '报错', '请问', '教我', '去世', '病了', '失业', '分手'],
    exclusive: ['dismiss', 'question-mark', 'tired'],
  },
  {
    id: 'agree',
    name: '赞同',
    axis: '表态',
    cues: ['确实', '对对对', '是的', '同意', '+1', '有道理', '说到点上了'],
    // ★ 客体类（表态）：只看对方发言 → 这一侧才是运行期真正用的
    otherCues: ['确实', '有道理', '说得对', '我觉得也是', '你说得没错', '赞同'],
    antiCues: ['带嘲讽的附和（那是 spite 的语境）'],
    exclusive: [],
  },
  {
    id: 'disagree',
    name: '反对',
    axis: '表态',
    cues: ['不行', '不好吧', '别吧', '算了别', '不同意', '这不行', '想得美'],
    // ★ 客体类（表态）：只看对方发言
    otherCues: ['不行吧', '这样不好', '别了吧', '算了吧别这样', '我不太同意', '想得美'],
    antiCues: ['对对方的厌恶（那是 disgust）', '放弃自己的挣扎（那是 slack）'],
    exclusive: ['disgust', 'slack'],
  },
  {
    id: 'sad',
    name: '委屈',
    axis: '状态',
    // bot 自己也会喊冤（人设里有这个脾气）
    cues: ['明明', '我好冤', '凭什么是我', '我又没做错'],
    // ★ 对方喊冤时，回一张"委屈/冤枉"的脸 —— 这是最常见的用法
    otherCues: ['好冤', '太冤', '冤枉', '凭什么', '好惨', '太惨', '委屈', '不是我的错', '怪我'],
    antiCues: ['刻意装不知道（那是 innocent）', '对别人的负面评价（那是 disgust）'],
    exclusive: ['innocent'],
  },
  {
    id: 'disgust',
    name: '嫌弃',
    axis: '表态',
    cues: ['呃', '噫', '好恶心', '好家伙', '受不了'],
    otherCues: ['好恶心', '恶心', '好怪', '辣眼睛', '受不了了', '离谱'],
    antiCues: ['自我放弃（那是 slack）', '只是不想接话（那是 dismiss）'],
    exclusive: ['slack', 'dismiss'],
  },
  {
    id: 'dismiss',
    name: '敷衍',
    axis: '社交姿态',
    cues: ['嗯', '哦', '行吧', '知道了', '随便', '都行'],
    // ★ 混合类（社交姿态）：两边都看
    otherCues: ['行吧', '随便吧', '都行', '你说了算', '哦', '知道了'],
    antiCues: ['对方在认真求助', '这是明确的鄙视（那是 deadpan）'],
    exclusive: ['deadpan', 'slack'],
  },
  {
    id: 'slack',
    name: '摆烂',
    axis: '状态',
    cues: ['算了', '不干了', '摆烂', '躺了'],
    // ★ "算了/随便吧/毁灭吧"基本只有**对方**会说（bot 摆烂的样子其实少见）——
    //   原来挂在 bot 正文上，实测命中率极低。
    otherCues: ['算了', '随便吧', '毁灭吧', '爱咋咋地', '不想干了', '摆烂', '躺平', '开摆'],
    antiCues: ['只是对对方不满（那是 disagree）', '只是疲惫（那是 tired）'],
    exclusive: ['tired', 'disagree'],
  },
  {
    id: 'gossip',
    exclude: ['吃不下', '没胃口'],
    name: '吃瓜',
    axis: '社交姿态',
    cues: ['蹲', '细说', '展开说说', '看热闹'],
    otherCues: ['细说', '展开说说', '有瓜吗', '你知道吗', '听说'],
    antiCues: ['自己已经入局表态（那就该是 agree/disagree）'],
    exclusive: ['lurk'],
  },
  {
    id: 'lurk',
    name: '暗中观察',
    axis: '社交姿态',
    cues: ['悄悄看', '路过', '我什么都没说', '不参与', '围观'],
    otherCues: ['路过', '围观', '潜水', '看热闹'],
    antiCues: ['已经明确表态（那是 agree/disagree/gossip）'],
    exclusive: ['gossip'],
  },
  {
    id: 'spite',
    exclude: ['被怼', '挨怼', '被嘲', '被骂'],
    name: '挑衅',
    axis: '攻击性',
    cues: ['来啊', '你行不行', '打一架', '敢不敢', '就这？'],
    otherCues: ['就这', '你行不行', '敢不敢', '来啊'],
    antiCues: ['只是被逗乐（那是 laugh）', '对方在难过'],
    // ★ 挑衅最容易踩的坑：对方在**认真挑战/质疑**时，配一张挑衅脸会真的惹人
    excludeOther: ['怎么', '帮我', '报错', '请问', '教我'],
    exclusive: ['laugh', 'disgust'],
  },
  {
    id: 'awkward-smile',
    name: '哭笑不得',
    axis: '混合',
    cues: ['笑不出来', '这…', '不知道该说什么', '这也太绝', '太绝了', '啊这'],
    otherCues: ['绝了', '太绝了', '无语了', '哭笑不得', '啊这', '这…'],
    antiCues: ['纯粹在笑（那是 laugh）', '纯粹无奈（那是 deadpan）'],
    exclusive: ['laugh', 'deadpan'],
  },
  {
    id: 'innocent',
    name: '装无辜',
    axis: '社交姿态',
    cues: ['啊我不知道', '不是我', '有吗', '说什么呢', '我什么都没干'],
    otherCues: ['不是我', '有吗', '我什么都没干'],
    antiCues: ['真的委屈（那是 sad）'],
    exclusive: ['sad'],
  },
  {
    id: 'greet',
    name: '打招呼',
    axis: '礼节',
    cues: ['早上好', '晚上好', '嗨', '在吗', '来了'],
    // ★ 功能类：只有 bot 主动挑。但"对方在打招呼"是一个**明确信号**，
    //   收到招呼回一张招呼脸是很自然的礼节 —— 所以这里也给 otherCues。
    otherCues: ['早上好', '晚上好', '嗨', '在吗', '来了', '你好'],
    antiCues: ['这是一轮对话的中间轮', '对方在追问上一件事'],
    exclusive: ['dismiss'],
  },
  {
    id: 'goodnight',
    name: '晚安',
    axis: '礼节',
    cues: ['晚安', '睡了睡了', '去睡了', '我先睡', '明天聊', '拜拜'],
    otherCues: ['晚安', '去睡了', '我先睡', '明天聊', '睡了', '拜拜'],
    antiCues: ['只是陈述疲惫（那是 tired）', '对方还在等答案'],
    exclusive: ['tired', 'dismiss'],
  },
  {
    id: 'task-done',
    name: '任务完成',
    axis: '交付',
    cues: ['搞定了', '弄好了', '改完了', '可以了', '弄完了', '好了', '给你放好了'],
    antiCues: [
      '对方在求助（那是 help-seeking，硬否决会拦）',
      '这是对别人立场的附和（那是 agree）',
      '这只是"我知道了"（那是 dismiss）',
    ],
    exclusive: ['agree', 'dismiss'],
  },
  {
    // ★★ 风险类标签（0.2.4 补）。它**不是情绪/动作**，而是一个**安全标记**：
    //    命中它的图**默认不发**（见 `sticker-library.buildStickerSelection` 与
    //    配置 `skills.sticker.allowRisky`）。
    //
    // 为什么值得单独占一个标签位：本项目最不能接受的一类事故是"账号被处置"，
    // 而把一张带脏话/擦边/血腥的图发给不熟的人，是这类事故里**最便宜的一个入口**。
    // 做法参考同类实现（QQ Agent 的 sticker-admin 有「慎发」这一档，命中即提醒模型"挑人发"）。
    //
    // ⚠️ 它**不参与"表达"**：`isAutoAllowedLabel()` 对它返回 false（不会自主补），
    //    也不该被当作"这一轮的反应" —— 它只是一张图的**属性**。
    id: 'risky',
    name: '慎发',
    axis: '风险',
    cues: ['脏话', '骂人', '擦边', '重口', '血腥', '惊悚', '恐怖', '不适', '恶心人'],
    antiCues: ['只是"嫌弃/无语"的表情，本身没有冒犯内容'],
    exclude: [],
    exclusive: [],
  },
])

/**
 * 哪些**轴**的标签允许被"自主补图"触发（0.2.4 第十六轮，用户要求）。
 *
 * ★★ 这个集合现在与 `AXIS_SIDE`（语境轴三分类）**对齐**：三分类里每一类都给了
 *   明确的触发源（主体类看自身发言、客体类看对方发言、混合类都看），
 *   所以**三类都可以自主**。
 *
 * ── 与旧设计的关系（如实说：这是**改掉**的一条旧决定）────────────────────
 * 原先把「礼节」「交付」排除在外，理由是"功能类只有模型主动能触发 ——
 * 自主判定只能看词的表面，判断不了这一轮到底算不算收工"。那句话本身没错，
 * 但它与**用户的轴三分类**冲突了：既然用户把礼节定为客体类（对方说"睡了/
 * 我的锅"才配图）、交付定为主体类（bot 自己说"搞定了"才配图），
 * 这两类就都有明确的词面判据，不该再被整体禁掉。
 *
 * ★ 改之前实测过风险（拿真实的 bot 回复跑）：`晚安，明天聊`→goodnight、
 *   `对不起，是我搞错了`→道歉、`搞定了，给你放好了`→task-done 都命中；
 *   而 `我看一下这个文件` / `那我先去忙了` / `早点休息吧` **一条都不误命中** ——
 *   线索要独立成词且满足密度守卫，中性回复天然命不中。
 *
 * ★ 保留的唯一闸门是 **`风险`（risky）**：它是安全闸门（默认不发那类图），
 *   不在三分类里，`activeIsAutoAllowed` 对它恒为 false（有断言钉着）。
 */
export const AUTO_ALLOWED_AXES = Object.freeze(
  new Set(['主动情感', '被逗乐', '认知反应', '表态', '状态', '社交姿态', '攻击性', '混合', '礼节', '交付']),
)

/** 这个标签能不能被"自主补"触发。 */
export function isAutoAllowedLabel(id) {
  const def = STICKER_LABEL_BY_ID[String(id ?? '').trim()]
  return Boolean(def) && AUTO_ALLOWED_AXES.has(def.axis)
}

/**
 * 这个标签是不是"功能类"（只有模型主动能触发）。
 *
 * ⚠️ 0.2.4 第十六轮起**已经没有功能类了**（礼节与交付改为可自主，见上），
 *    所以这个函数现在恒为 `false`。保留它只是为了让调用方不必同时改；
 *    真正"不能自主"的只剩**风险闸门**，判据请用 `isRiskyLabel(id)`。
 */
export function isFunctionalLabel(id) {
  const def = STICKER_LABEL_BY_ID[String(id ?? '').trim()]
  return Boolean(def) && !AUTO_ALLOWED_AXES.has(def.axis)
}

/** 风险类标签的 id（命中即默认不发）。★ **单一来源**：别的模块从这里拿，不各写一份。 */
export const RISK_LABEL = 'risky'

/** 这个 id 是不是风险类标签。 */
export function isRiskyLabel(id) {
  return String(id ?? '').trim() === RISK_LABEL
}

/** 稳定顺序的标签 id 列表（选图与日志排序都用它，避免各处口径不同）。 */
export const STICKER_LABEL_IDS = Object.freeze(STICKER_LABELS.map((l) => l.id))

/** id → 标签定义。 */
export const STICKER_LABEL_BY_ID = Object.freeze(
  Object.fromEntries(STICKER_LABELS.map((l) => [l.id, l])),
)

/** 中文短名 → id（库文件与日志里只写 id；中文名只用于界面与提示词）。 */
export const STICKER_LABEL_BY_NAME = Object.freeze(
  Object.fromEntries(STICKER_LABELS.map((l) => [l.name, l.id])),
)

/**
 * 打标签的**最大图数上限**（每个标签的"主标签"图数）。
 *
 * 为什么需要：某个标签攒了 50 张图时，它不是"更丰富"，而是**整个打分池被它吃掉**
 * —— 任何场景都从这 50 张里选，结果是反复发同一类脸。超限的图在导入时
 * 降到次要标签（或落待定区），保证库的分布是均匀的。
 */
export const MAX_PRIMARY_PER_LABEL = 3

/** 低于这个置信度 → 落待定区（**不猜**）。 */
export const MIN_TAG_CONFIDENCE = 0.6

/** 一个标签可用（主标签）图数低于这个值 → 提示词里不再出现它，并告警。 */
export const MIN_USABLE_PER_LABEL = 3

/** 单标签主图占库比例超过它 → 告警（库的分布太单一）。 */
export const MONOPOLY_RATIO = 0.3

/**
 * 允许"单字线索"的清单（**白名单**），其余单字线索一律不参与匹配。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要这条（真机实测抓到的，不是想象出来的）
 * ══════════════════════════════════════════════════════════════════════════
 * `deadpan` 原来的线索里有 `行`，于是这句**普通正文**被误判成"无语"：
 *
 *     我把配置改好了，重启一下就**行**。
 *
 * 后果不是"少发一张"，而是"在一个平铺直叙的句子上发了一张无语脸" ——
 * 正是这个功能最容易出丑的地方。而 `行` 作为线索本身没错（"行吧"确实是敷衍），
 * 错的是**单字在中文里到处都是边界**：就行、进行、一行、银行、运行…
 *
 * 所以规则是：**单字线索只有在这个白名单里才允许匹配**，其余必须 ≥2 个字。
 * 白名单里的都是"单独说就有意义、且不会被别的词包住"的：
 * `6`（梗）、`草`、`啊`、`哦`、`嗯`、`噫`、`退`、`蹲`、`嗨`、`睡`。
 * 要加新的单字线索，先问一句"它会不会出现在别的词里"。
 *
 * ★★ `早` 被**移出**白名单（0.2.4 第十三轮，实测抓到的假阳性）：
 *   它是合格的招呼语，但**同时是「早点/早晚/早已」的第一个字** ——
 *   实测 bot 回一句「**早**点休息吧」，就被判成"对方在打招呼"，
 *   于是可能配一张招呼脸给一个正在熬夜的人。而这个语境的正确表情是 `tired`。
 *   ∴ 招呼语只保留 `早上好` / `晚上好` 这类**不会被包住**的形式。
 *   教训：单字线索的判据不是"它有意义"，而是"它不会出现在别的词里"。
 */
export const SAFE_SINGLE_CHAR_CUES = Object.freeze(
  new Set(['6', '草', '啊', '哦', '嗯', '噫', '退', '蹲', '嗨', '睡']),
)

/** 一条线索是否允许参与匹配（短线索守卫）。 */
export function isUsableCue(cue) {
  const c = String(cue ?? '')
  if (c.length >= 2) return true
  return SAFE_SINGLE_CHAR_CUES.has(c)
}

/**
 * 把任何输入（id / 中文名 / 大小写变体）归一成一个**合法标签 id**；认不出返回 null。
 *
 * ★ 归一失败**不抛错、不兜底**：调用方据此把条目落待定区。
 *
 * ⚠️ **这是"内置表"的归一器**（只认出厂那 23 个）。运行期请用
 *    `sticker-vocab.resolveActiveLabelId(input, {workspace, dir})` ——
 *    那份才认用户在标注台新建的标签。本函数留在原地的用途有两个：
 *    ① 内置表的自检与词表数据本身的校验（`sticker-vocab` 用它兜底）；
 *    ② 提醒"静态表已经不是运行期真相了"。
 */
export function normalizeLabelId(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  if (STICKER_LABEL_BY_ID[raw]) return raw
  if (STICKER_LABEL_BY_NAME[raw]) return STICKER_LABEL_BY_NAME[raw]
  const lower = raw.toLowerCase()
  if (STICKER_LABEL_BY_ID[lower]) return lower
  return null
}

/** 标签的中文名（日志/界面用；认不出就原样返回）。 */
export function labelName(id) {
  return STICKER_LABEL_BY_ID[String(id ?? '').trim()]?.name ?? String(id ?? '')
}

/** 供离线打标签提示词用的紧凑词表（只给模型看 id + 中文名 + 互斥项）。 */
export function renderLabelVocabulary() {
  return STICKER_LABELS.map((l) => {
    const ex = l.exclusive.length ? `（与 ${l.exclusive.map(labelName).join('/')} 互斥）` : ''
    return `${l.id}=${l.name}${ex}`
  }).join('、')
}

/**
 * 打标签用的完整提示词片段（负例比正例更重要，所以两样都给）。
 *
 * ★ `labels` 由调用方传**当前生效的词表**（用户在标注台新建的标签要立刻能被模型选中）。
 *   ⚠️ 刻意**不在本模块 import `sticker-vocab`** —— 那会形成循环依赖（vocab 要 import
 *   本模块的默认表）。第一版我用 `createRequire` 延迟加载，结果 `nodeRequire` 没定义、
 *   被 try/catch 静默吃掉 → 新标签**不出现**在提示词里（测试才抓到）。
 *   显式传参没有这个问题，而且调用方能一眼看出"我用的是哪份表"。
 */
export function renderTaggingGuide(labels = null) {
  const table = Array.isArray(labels) && labels.length ? labels : STICKER_LABELS
  const nameOf = (id) => table.find((l) => l.id === id)?.name ?? id
  const lines = []
  lines.push('可用标签（只能从这里选，认不出就回 unknown）：')
  for (const l of table) {
    lines.push(
      `- ${l.id}（${l.name}）：${(l.cues ?? []).slice(0, 4).join('、')}` +
        (l.exclusive?.length ? `｜易混：${l.exclusive.map(nameOf).join('/')}` : ''),
    )
  }
  lines.push('判别优先级：主动情感 > 认知反应 > 社交姿态 > 攻击性。')
  lines.push('四个最容易打错的对照：')
  lines.push('  1) confused(求解释) ≠ question-mark(荒诞反问) ≠ shock(认知冲击) ≠ deadpan(鄙视/无语)')
  lines.push('  2) sad(真委屈) ≠ innocent(刻意装不知道)')
  lines.push('  3) slack(放弃挣扎) ≠ tired(疲惫) ≠ dismiss(不想接话)')
  lines.push('  4) laugh(被逗乐) ≠ spite(带攻击性) ≠ awkward-smile(又好笑又无奈)')
  return lines.join('\n')
}
