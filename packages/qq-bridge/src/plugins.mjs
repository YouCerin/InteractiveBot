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
  {
    id: 'trigger',
    name: '唤醒规则',
    icon: '📣',
    enabledPath: 'trigger.groupEnabled',
    hot: true,
    why: '每条消息都重读 this.config.trigger 决定回不回（bridge.mjs:1054-1055）',
    what: '群聊总开关 + 关键词 + 私聊/被 @ 的唤醒方式（这一格只显示群聊总开关）。',
    offEffect: '关掉后：群里**即使被 @ 也不回**（私聊不受影响）。',
    uiTab: 'persona',
  },
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
    //   ⚠️ 但**不是全部**都即时：`wake.judge.timeoutMs` / `maxPerHour` 在判定器
    //   首次被用到时装配一次（预算计数器必须跨消息累积，不能每条重建），
    //   所以改这两个要重启。`shadow` 是每轮现读的。
    hot: true,
    why:
      '闸门每条消息现读 this.config.wake.policy（bridge.mjs 的 handleEvent）——' +
      '判定器本身懒建、只建一次（预算计数器要跨消息累积），所以 policy 与 judge.shadow 即时生效；' +
      'judge.timeoutMs / judge.maxPerHour 只在首次装配时读一次，改这两个要重启',
    what:
      '决定"这条消息要不要回"用哪一套判据。**这两者回答的是同一个问题**，' +
      '所以它们是**二选一**（同一个键），不是两个开关 —— 两个都开会让两套判据打架，' +
      '两个都关等于机器人不知道该不该回。',
    offEffect:
      '这一格**没有"关"**：它不是开关，是二选一。选「规则唤醒」= 今天的行为' +
      '（私聊/@/关键词 → 必答，一次额外调用都不产生）；' +
      '选「语义唤醒」= 规则先唤醒、再由判定器否决（可以沉默），' +
      '代价是每条候选消息要起一个一次性 DSH 进程做判定，且**默认只记账不改行为**（影子模式）。',
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
            '★ 默认是**影子模式**：判定照跑、结论只写进 oplog，行为不变。',
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
 * @returns {{ kind: 'boolean'|'enum'|'list', value?: unknown, offValue?: unknown }}
 */
export function pluginSwitchKind(plugin) {
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
  // list（名单）与 choice（二选一）**都没有"关"这个动作**：
  //   · 名单为空是安全状态，不是"关闭"；
  //   · choice 是"选了哪一个"，没有第三个"都不选"。
  // 返回 null 让界面据此换成别的控件 —— 硬套一个开关就是"点了没反应"的控件。
  if (kind === 'list' || kind === 'choice') return null
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
