/**
 * 内置插件登记表：把桥接**本来就有**的能力块登记成"可随时开关的插件"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（它解决的问题不是"功能"，是"看不见"）
 * ══════════════════════════════════════════════════════════════════════════
 * 桥接的能力早就分块了（记忆 / 看图 / QQ 工具 / 人味层 / 用量…），但**开关散在 9 个页签里**，
 * 于是有两类毛病：
 *
 *   ① 使用者不知道"这台机器人现在到底开了哪些能力"——要点进每个页签才能拼出来；
 *   ② 更糟的是**不知道关掉会发生什么**。`mcp.enabled=false` 的后果是"模型只能用文字回复"，
 *      这句话写在代码注释里、写在文档里，唯独没写在开关旁边。
 *
 * 所以这张表**只做一件事**：把既有开关集中登记出来，并如实标注三件事 ——
 * 开关在哪、关掉会怎样、**是即时生效还是要重启**（这一点最容易被含糊过去）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三条纪律（改这张表之前先读）
 * ══════════════════════════════════════════════════════════════════════════
 * ① **不改行为**。本模块是**纯数据 + 读取**：没有一个 `if (plugins.x)` 去改运行时逻辑。
 *    开关仍然由各处既有代码读它们自己的 `config.*` 决定 —— 否则就会出现"两处开关"。
 *
 * ② `hot` 必须**取证过**，不能猜。判据只有一条：那段代码是不是**每轮/每条消息重读**
 *    `config.*`。是 → 即时生效（hot）；只在启动时读一次 → 要重启（cold）。
 *    每条都写了证据位置，方便复核。**把 cold 写成 hot 是一种恶意**：
 *    用户以为关掉了，实际还在跑。
 *
 * ③ `enabledPath` 指向**既有配置键**，不是新键。这样：
 *    · 老配置、老文档、老测试全都继续成立；
 *    · 界面上的开关走的是既有的"改配置"通道（含校验、.bak、致命项拒绝）。
 *
 * ④ **登记 ≠ 在这里开关**（0.2.7 加）。有些条目的控件**不在插件卡上**：
 *    · `switchInSkill: '<技能id>'` —— 开关属于那个**技能卡**（表情包就是这样）；
 *   界面据此渲染成"指路行"，**不渲染 Switch**；接口层 `toggle({type:'plugin'})` 也拒绝。
 *   理由与 list/choice 完全一样：**一个键只能有一条写入口**，否则同一页会出现
 *   两个都能点的控制点（真机反馈过这件事）。
 */

/**
 * @typedef {object} PluginSpec
 * @property {string} id            稳定标识（给 API/界面用，改了会断）
 * @property {string} name          界面上显示的名字
 * @property {string} icon          emoji（界面上当图标）
 * @property {string} enabledPath   开关在 config.json 里的路径
 * @property {boolean} hot          true = 改完即时生效；false = 要重启桥接
 * @property {string} why           为什么是 hot 或 cold（**必须取证**）
 * @property {string} what          这个插件是什么（一句话）
 * @property {string} offEffect     关掉之后会发生什么（界面直接显示这句）
 * @property {string} uiTab         详细设置在哪一页（界面跳转用；`null` = 只有开关）
 * @property {{options: PluginChoiceOption[]}} [choice]
 *   二选一 / N 选一：**当两个功能冲突时用**（见下面 pluginSwitchKind 的说明）。
 *   声明了它，`switchKind` 就是 `'choice'`，界面应渲染成 N 个并列按钮而不是开关。
 * @property {string} [switchInSkill]
 *   **开关的控件在技能卡上**（值是技能 id，例如 `'sticker'`）。
 *   声明了它，`switchKind` 就是 `'skill'`：本表只**登记**它在哪，
 *   界面渲染成指路行、接口层拒绝 `toggle({type:'plugin'})`（见纪律④）。
 */

/**
 * @typedef {object} PluginChoiceOption
 * @property {string} value        写进配置的值
 * @property {string} label        按钮上的字
 * @property {string} [desc]       按钮下的小字（一句话说清选它的后果）
 * @property {boolean} [experimental]
 *   true = 标注「实验性」。口径：**从外部项目借来、尚未在本项目长期验证**的那一侧
 *   （例如 hermes 式语义唤醒 vs 现有规则唤醒）。界面必须显示出来 ——
 *   使用者有权知道自己在开一个还没被时间检验的东西。
 */

/** 桥接内置插件（顺序 = 界面上显示的顺序：总开关类在前，细节类的在后）。 */
export const BUILTIN_PLUGINS = [
  {
    id: 'memory',
    name: '跨重启记忆',
    icon: '🧠',
    enabledPath: 'memory.enabled',
    hot: true,
    why: '每轮装配提示词、每次落盘前都重读 config.memory.enabled（bridge.mjs:733 / :1586 一带）',
    what: '让机器人自己记笔记（"记住 X" 会真的落进工作区），重启后仍然记得。',
    offEffect:
      '关掉后：不再注入记忆、也不再落盘 —— 它**重启后真的什么都不记得**。' +
      '（已经写在磁盘上的记忆文件不会被删，重新打开就还在。）',
    uiTab: 'memory',
  },
  {
    id: 'image',
    name: '看图',
    icon: '🖼️',
    enabledPath: 'image.enabled',
    hot: true,
    why: '每条消息处理图片前重读 this.config.image（bridge.mjs:2004-2005）',
    what: '把 QQ 消息里的图片存进工作区并告诉模型路径（或直接塞给模型）。',
    offEffect: '关掉后：图片只显示成 `[图片]`，而且**一次网络请求都不会发**（省流量也省钱）。',
    uiTab: 'advanced',
  },
  {
    id: 'qq-tools',
    name: 'QQ 原生功能（MCP）',
    icon: '🔧',
    enabledPath: 'mcp.enabled',
    hot: false,
    why:
      '只在**启动时**决定要不要把 MCP 客户端写进 sdk profile（index.mjs:1357 一带）——' +
      '而且工具表是 DSH 启动时加载的，桥接进程自己改不了',
    what: '把 QQ 动作（戳一戳/表情/撤回/查群成员/打包转发…）变成模型能调的工具。',
    offEffect:
      '关掉后：模型**只能用文字回复**，不能戳一戳、发表情、撤回说错的话。' +
      '★ 技能（`skills/`）的工具也是走 MCP 挂上去的，会**一起失效**（它们的提示词指引也不再注入）。',
    uiTab: 'extensions:qq-tools',
  },
  {
    id: 'sticker',
    name: '表情包',
    icon: '🧩',
    enabledPath: 'skills.sticker.enabled',
    // ★★ 0.2.7：`switchInSkill` = **这个开关的控件不在插件卡上，在技能卡上**。
    //
    // ── 为什么需要它（真机反馈："同一个开关放在 skill 和插件上不合理"）──────────
    // 表情包是**内置技能**：`skills/sticker/` 提供清单/设置/自检，所以技能卡上有一个
    // 结构性的开关；而本表按"如实登记开关在哪"的职责又把它登记了一遍
    // （`enabledPath: 'skills.sticker.enabled'` —— 这句话本身是对的）。
    // 问题出在**界面**：插件卡把 `enabledPath` 又渲染成了一个可点的 Switch ⇒
    // 同一个键在同一页出现两个控制点，使用者还要猜"它到底是技能还是插件"。
    //
    // ∴ 现在：**登记照旧保留**（插件区仍然告诉你它存在、开关在哪、关掉会怎样、即时生效），
    //   但**不再提供第二个开关** —— 界面据 `switchInSkill` 渲染成一行指路，
    //   接口层的 `toggle({type:'plugin'})` 也拒绝（与 list/choice 同一条纪律：
    //   **不给同一个键开第二条写入口**）。
    switchInSkill: 'sticker',
    hot: true,
    why:
      '每条待发回复前重读 this.config.skills.sticker（bridge.mjs 的 #decideSticker / ' +
      '#stickerPromptBits）—— 提示词段与判定都是**每轮现读**，所以开关下一轮就生效',
    what: '从导入的表情库里按场景挑一张发出去（判定全在本地，运行期零模型调用）。',
    offEffect:
      '关掉后：一次表情包都不会发，提示词里也不再出现 `[sticker:标签]`（模型想发也发不出来）。' +
      '★ 注意它与「QQ 原生功能（MCP）」**不是**同一件事：聊天里的 `[sticker:名字]`（QQ 内置表情，' +
      '`config.send.stickers` 那张表）仍然照旧可用。',
    // ★ `uiTab: null` 而不是 `'extensions:sticker'`：
    //   界面把 `extensions:` 前缀当成"详细设置就在本卡展开"（`ExtensionsTab.tsx:524`），
    //   但本卡**没有**展开区（那张卡上的设置表单属于**技能卡**，由技能清单的
    //   `configSchema` 渲染）。写成前缀会多出一个点了没反应的「详细设置」，
    //   那正是本项目最忌讳的一类控件。设成 null = 只有开关，如实。
    uiTab: null,
  },
  {
    id: 'humanize',
    name: '人味层（拟人节奏）',
    icon: '⏱️',
    enabledPath: 'humanize.enabled',
    hot: true,
    why: '每次计算回复延迟前重读 this.config.humanize（bridge.mjs:2209 → humanize.mjs:76）',
    what: '反应时间、打字速度、分条发送、静默时段、长任务先应一声。',
    offEffect:
      '关掉后：**秒回**。秒回 + 7×24 在线是行为风控最典型的特征 —— ' +
      '这是账号存活相关配置，不是体验优化。',
    uiTab: 'pace',
  },
  // ★★ 0.2.3：这里**删掉了原来的「唤醒规则」卡**（`id: 'trigger'`，只显示
  //   `trigger.groupEnabled` 一个开关）。用户的原话是「功能太过简单且与唤醒策略冲突」，
  //   而实际情况比"太简单"更糟：它和下面的 `wake-policy` **回答的是同一个问题**
  //   （这条消息要不要回），一张卡显示判据里的一个开关、另一张显示"用哪套判据"，
  //   两处各说一半，使用者拼不出全貌 —— 而且两张卡都叫「唤醒」开头的名字。
  //   ∴ 现在：**判据本身**（群聊总开关 / 私聊 / 被 @ / 关键词 / 关键词表）归属
  //   `wake-policy` 那张卡的「唤醒方式」一节（界面侧 `config-ui` 的 `WakeRulesSection`，
  //   从「人设」页搬了过来），这里不再单独占一张卡。
  //   ★ 证据：`wake-policy` 的 `enabledPath` 是 `wake.policy`，而那一节改的全是
  //     `trigger.*` —— 它们本来就是同一件事的两半（`trigger.groupEnabled` 还是
  //     `semantic` 的前置总开关）。
  {
    id: 'usage',
    name: '用量记账',
    icon: '📊',
    enabledPath: 'usage.enabled',
    hot: false,
    why: '账本对象在启动时按这个开关创建/不创建（index.mjs:1242）——运行期没有"事后补一个账本"的路径',
    what: '记录每轮的 token 用量（概览页那张卡片就是它）。',
    offEffect: '关掉后：概览页不再有用量数字（历史账本文件不会删）。',
    uiTab: 'overview',
  },
  {
    id: 'wake-policy',
    name: '唤醒策略',
    icon: '📣',
    enabledPath: 'wake.policy',
    // ★ hot：闸门**每条消息现读** `this.config.wake.policy`（`bridge.mjs` 的
    //   `handleEvent` 里那一行 `if (this.config.wake?.policy === 'semantic')`），
    //   而 `wake.policy` 是**活配置对象**上的键（`extensions-service.mjs:186` 就地改）。
    //   它名下那一节（`trigger.*`）同样是每条消息现读的。
    //   ⚠️ 但 `wake.judge` 里那几个（apiKey / model / baseUrl / timeoutMs / maxPerHour）
    //   在判定器首次被用到时装配一次（预算计数器必须跨消息累积，不能每条重建），
    //   所以改它们要重启。`shadow` 是每轮现读的。
    hot: true,
    why:
      '闸门每条消息现读 this.config.wake.policy（bridge.mjs 的 handleEvent），它名下那一节' +
      '（trigger.* 群聊总开关/私聊/被@/关键词）同样是每条消息现读 —— 这两块即时生效；' +
      '判定器本身懒建、只建一次（预算计数器要跨消息累积），所以 judge.shadow 也即时，' +
      '但 judge.apiKey / model / baseUrl / timeoutMs / maxPerHour 只在首次装配时读一次，改它们要重启',
    what:
      '决定"这条消息要不要回"用哪一套判据，**并且**配置那套判据本身（群聊总开关 / 私聊 / ' +
      '被 @ / 关键词 / 关键词表 —— 见卡片里的「唤醒方式」一节）。',
    offEffect:
      '这一格**没有"关"**：它不是开关，是二选一。选「规则唤醒」= 今天的行为' +
      '（私聊/@/关键词 → 必答，一次额外调用都不产生）；' +
      '选「语义唤醒」= 规则先唤醒、再由判定器否决（可以沉默），' +
      '代价是每条候选消息多一次模型调用（走一次性 DSH 进程约 3~5 秒；' +
      '填一把判定专用 key 就自动改走直连、约 1 秒），失败/超时/超预算一律放过。',
    uiTab: 'extensions:wake-policy',
    choice: {
      options: [
        {
          value: 'rule',
          label: '规则唤醒（现状）',
          desc: '私聊 / 被 @ / 命中关键词 → 必答。零额外调用、零新进程。',
        },
        {
          value: 'semantic',
          label: '语义唤醒（可沉默）',
          desc:
            '规则先唤醒，再由判定器决定说不说 —— 它可以否决（让机器人沉默）。' +
            '★ 判定**默认真的生效**（被判沉默的消息不会得到回复，且没有任何提示）；' +
            '想先观察就打开展开区里的「影子模式」。',
          experimental: true,
        },
      ],
    },
  },
  {
    id: 'delivery',
    name: '投递可靠性',
    icon: '📮',
    enabledPath: 'delivery.ledger',
    hot: true,
    why: '每次投递落账前现读 config.delivery.ledger（bridge.mjs 的 #beginDelivery 每次投递都调用它）',
    what:
      '把"已经生成好、但还没发出去"的回复先落一份账（投递账本）。' +
      '于是崩溃 / 重启之后能回答"丢的是哪一条、给谁的"—— 这件事以前没有任何地方能回答。',
    offEffect:
      '关掉后：不再落账 —— 回复**照样发**，但"已生成未发出"这件事就没有记录可查了' +
      '（历史账本文件不会删）。' +
      '★ 另外两块**不受这个开关影响**，它们是边界不是功能：投递前终检门（关掉会把内部文本发到 QQ）、' +
      '出站幂等键（关掉会误丢"不同会话里的同一句话"）。',
    uiTab: 'advanced',
  },
  {
    id: 'corpus',
    name: '本地语料检索',
    icon: '🗂️',
    enabledPath: 'corpus.enabled',
    // ★ hot：取证位置有三处，都在**每次使用**时现读 `this.config.corpus.enabled`
    //   （它是活配置对象上的键，`/api/extensions` 的 toggle 会就地改）：
    //     · 写入侧：`bridge.mjs` 的 `#recordCorpus` —— **每条消息**都过一遍；
    //     · 读取侧（桥接内）：`bridge.mjs` 的 `searchHistory`；
    //     · 读取侧（MCP 工具）：`mcp/mcp-qq-server.mjs` 的 `runTool` 分派处，
    //       用 `readLiveConfig()` **每次调用现读 config.json**。
    //   ⚠️ 句柄本身在构造时建，但 `createCorpus()` **不碰磁盘**（`node:sqlite`
    //   与建表都推迟到第一次真正用）⇒ 关着的时候是**零 fs 成本**，不是"少一次写入"。
    hot: true,
    why:
      '写入侧每条消息现读 this.config.corpus.enabled（bridge.mjs 的 #recordCorpus）；' +
      '读取侧桥接内走 searchHistory、MCP 工具走 readLiveConfig() 每次现读 config.json。' +
      '语料库句柄虽然构造时就建，但它不碰磁盘（createCorpus 是懒的），所以关着时零 fs 成本',
    what:
      '把每条消息落进本地 SQLite 并支持中文全文检索 —— 于是"我上次说的那个方案叫什么来着"' +
      '这类问题能查（在此之前只能现拉协议端历史：拉一次算一次、不能检索、对面一重启就没了）。',
    offEffect:
      '关掉后：不再把新消息落进本地库，`qq_search_history`（搜历史）与 `qq_forward_log`' +
      '（把历史打包成合并转发）会**当场拒绝** —— 注意是"被关掉了"，不是"搜不到"。' +
      '★ **已有的库文件不会被删**，重新打开就还能搜到旧消息；清理由 `--corpus --prune` 单独负责。' +
      '★ 这一层是纯词法检索（零模型调用、零网络），关掉不影响回复质量。',
    uiTab: null,
  },
  {
    id: 'persona',
    name: '人设',
    icon: '🎭',
    enabledPath: 'persona.preset',
    hot: false,
    why: '人设文本在**构造期算一次并缓存**（bridge.mjs:238 一带调 buildPersona）——刻意如此，改成每轮重算会白白多花 token',
    what: '它是谁、怎么说话（这一格的"关"= 预设切成 `none`）。',
    offEffect: '关掉后：不注入人设段，机器人不再有固定说话风格。',
    uiTab: 'persona',
  },
  {
    id: 'access',
    name: '名单与权限',
    icon: '🔐',
    enabledPath: 'access.adminUsers',
    hot: true,
    why: 'roster 每次判定都现读 config.access.*（roster.mjs:259-263，闭包读引用而不是快照）',
    what: '谁能用、谁能让它做修改类动作（管理员/私聊名单/群名单）。',
    offEffect: '这一格不提供开关（清单为空 = 谁都不能用，是需要人认真填的东西）。',
    uiTab: 'protocol',
  },
]

/**
 * 一个插件的"关"是怎么表达的。
 *
 * 大多数插件是布尔开关（`x.enabled`），但有两个例外必须如实处理：
 *   · `persona.preset` 是**枚举**，"关"= 取值 `none`；
 *   · `access.adminUsers` 是**列表**，"关"这个动作没有意义（清单为空是安全状态，不是关闭）。
 * 硬把它们说成布尔开关，界面就会出现一个"点了没反应"的开关 —— 那是最伤信任的一种控件。
 *
 * @returns {{ kind: 'boolean'|'enum'|'list'|'choice'|'skill', value?: unknown, offValue?: unknown }}
 */
export function pluginSwitchKind(plugin) {
  // ★ skill（0.2.7）：**这个开关的控件在技能卡上**（见 `switchInSkill` 的注释）。
  //   放在最前面判：它是最具体的一条 —— 带这个字段的条目，其它类型判定都不适用。
  //   界面据此渲染成"指路行"而不是 Switch；接口层的 toggle 也会拒绝。
  if (plugin.switchInSkill) return { kind: 'skill', skillId: String(plugin.switchInSkill) }
  // ★ choice（二选一 / N 选一）：**两个功能冲突时**的做法。
  //
  //   为什么不做成两个独立开关：那会出现两种无意义状态 ——
  //     · 两个都开 ⇒ 两套判据同时生效，互相打架；
  //     · 两个都关 ⇒ 功能哑掉（例如机器人不知道该不该回）。
  //
  //   做法是**两个功能放同一个插槽、用同一个单值配置键**。于是
  //   「启动一个自动关掉另一个」是这个键的**天然语义**，不需要任何额外机制 ——
  //   选了 `semantic` 就等于 `rule` 不在了。
  //
  //   ∴ choice **没有"关"**：isPluginOn() 对它返回 null（与 list 同类）。
  //     界面也不该给它渲染开关或"关掉会怎样"，而应写成「选这个会怎样」×N。
  if (plugin.choice && Array.isArray(plugin.choice.options) && plugin.choice.options.length > 0) {
    return { kind: 'choice', options: plugin.choice.options }
  }
  if (plugin.enabledPath === 'persona.preset') return { kind: 'enum', offValue: 'none', onValue: 'mermaid-lite' }
  if (plugin.enabledPath.endsWith('Users') || plugin.enabledPath.endsWith('Allowlist')) return { kind: 'list' }
  return { kind: 'boolean' }
}

/** 按点分路径读配置（缺字段返回 undefined，不抛）。 */
export function readPath(obj, path) {
  let cur = obj
  for (const part of String(path).split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) return undefined
    cur = cur[part]
  }
  return cur
}

/**
 * 这个插件此刻是开还是关。
 *
 * ⚠️ 口径与**各处既有代码**保持一致（而不是另立一套）：
 *   · `x.enabled` 类：`!== false` 即开（默认开 —— 这是它们原本的语义）；
 *   · `persona.preset`：非空且不等于 `none` 即开；
 *   · 列表类：返回 null（"开关"这个概念不适用）。
 */
export function isPluginOn(plugin, config) {
  const value = readPath(config, plugin.enabledPath)
  const kind = pluginSwitchKind(plugin).kind
  // list（名单）、choice（二选一）与 skill（控件在技能卡上）**都没有"在这里开关"这个动作**：
  //   · 名单为空是安全状态，不是"关闭"；
  //   · choice 是"选了哪一个"，没有第三个"都不选"；
  //   · skill 的开关归技能卡管，这里只登记它在哪。
  // 返回 null 让界面据此换成别的控件 —— 硬套一个开关就是"点了没反应"（或者两个都能点）的控件。
  if (kind === 'list' || kind === 'choice' || kind === 'skill') return null
  if (kind === 'enum') return Boolean(value) && String(value) !== 'none'
  return value !== false
}

/**
 * 把这张表渲染成"给界面/CLI 用"的数组。
 *
 * @param {{ config: object, workspace?: string, uiFresh?: object }} opts
 */
export function listPlugins({ config } = {}) {
  return BUILTIN_PLUGINS.map((p) => {
    const kind = pluginSwitchKind(p)
    return {
      id: p.id,
      name: p.name,
      icon: p.icon,
      what: p.what,
      offEffect: p.offEffect,
      enabledPath: p.enabledPath,
      switchKind: kind.kind,
      // choice 的选项要带给界面（渲染成 N 个并列按钮，含「实验性」标注）；其余类型为 null
      options: kind.kind === 'choice' ? kind.options : null,
      // ★ skill 类：开关在技能卡上，把技能 id 带给界面（渲染成指路行）。
      //   ⚠️ 必须带出去：界面不能靠 `if (id === 'sticker')` 硬编码 —— 那种写法
      //   在下一个"内置技能"出现时必然被漏掉，而且测试也钉不住。
      switchInSkill: kind.kind === 'skill' ? kind.skillId : null,
      enabled: isPluginOn(p, config),
      value: readPath(config, p.enabledPath),
      hot: p.hot,
      why: p.why,
      uiTab: p.uiTab,
    }
  })
}

/** 按 id 取一条（给 API 的 toggle 用）。 */
export function pluginById(id) {
  return BUILTIN_PLUGINS.find((p) => p.id === String(id)) ?? null
}
