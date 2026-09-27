/**
 * 配置解析与校验。
 *
 * ── 为什么单独抽一个模块 ───────────────────────────────────────────────
 * 这两个函数原先埋在 `index.mjs` 里，只在启动时跑一次，**因此从没被测试过**。
 * 这类代码最典型的故障是：**改了一个配置键名，程序静默回落到默认值** ——
 * 不报错、不崩，只是你设的值不生效。比如把 `humanize.charsPerSecond`
 * 写成 `humanize.charsPerSec`，人味层就会用默认值，而你完全不知道。
 *
 * 抽出来之后它可以被单元测试直接覆盖（见 mocks/verify-config.mjs），
 * 也能被 `mocks/verify-manifest.mjs` 用来核对"文档声明的配置键是否真的存在"。
 *
 * ── 一条设计原则 ───────────────────────────────────────────────────────
 * **所有默认值都必须"安全"，不能"方便"。**
 * 例如 permissionMode 默认 workspace-write（而不是全权）、
 * adminUsers 默认为空（= 谁都不能用）、humanize 默认开启。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DIRS, resolveInPackage, findDshCli } from './local.mjs'
import { lintKeywords } from './trigger.mjs'
import { lintPersona } from './persona.mjs'
import { buildSpeedPreset, DEFAULT_SPEED_PRESET, lintHumanize, detectSpeedPreset, SPEED_PRESETS } from './speed.mjs'

/**
 * 把一个"路径列表"配置项解析成绝对路径数组。
 *
 * 配置里写的是**相对包根**的路径（和 `dsh.workspace`、`ui.logFile` 一致），
 * 解析规则也必须一致 —— 否则同一个包里会出现两套相对路径语义。
 *
 * 为什么要允许列表而不是单个值：这些位置是**候选**（`dsh.searchPaths` /
 * `snowluma.searchPaths`），找不到就继续往下找。写成单个值时，一条写错就彻底失效；
 * 写成列表则能"补充"而不是"覆盖"。空白项直接丢掉，免得 `resolve('')` 变成包根。
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizePathList(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((p) => typeof p === 'string' && p.trim() !== '')
    .map((p) => resolveInPackage(p))
}

/**
 * 归一化**技能设置**（`config.skills`）。
 *
 * ★ 这里刻意**不做白名单收敛**，理由只有一条：技能是装上去才有的东西，
 *   它的键集由该技能自己的 `skill.json` 决定，宿主在编译期不可能知道
 *   （`maxResults` / `cookie` / `bridgePort` …都是 pixiv 那份清单定义的）。
 *   真正的"默认值填充 + 类型收敛 + 密文脱敏"在 `src/extensions.mjs` 里按清单做。
 *
 * 但形状要挡住：值必须是对象。写成 `"skills": ["pixiv-lookup"]` 这种形状时，
 * 后面每一处 `.skills[id].enabled` 都会读出 undefined —— 表现是"开关按了没反应"。
 * 所以**非对象一律丢掉**（不报错、不猜：丢了之后 extensions.mjs 会按清单默认值处理，
 * 而 validateConfig 会给一条警告）。
 *
 * `_` 开头的键照旧跳过（那是给人看的注释，不属于配置）。
 */
function normalizeSkillSettingsMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [id, raw] of Object.entries(value)) {
    if (String(id).startsWith('_')) continue
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const one = {}
    for (const [k, v] of Object.entries(raw)) {
      if (String(k).startsWith('_')) continue
      // 值本身原样保留（类型收敛交给 extensions.mjs，它才有清单）
      if (v === undefined) continue
      one[k] = v
    }
    out[id] = one
  }
  return out
}

/**
 * 归一化表情表（`send.stickers`）：名字 → QQ 表情 id。
 *
 * **只接受值全是数字的条目**，别的形状**直接丢掉**（不报错、不猜）：
 * 这个表最终会变成发出去的表情段，值不是数字就等于发一个未定义的东西。
 * 空表是合法的默认值 —— 含义是"不发表情"（`[sticker:…]` 会被剥掉并记一行日志）。
 *
 * @param {unknown} value
 * @returns {Record<string, string>}
 */
function normalizeStickerTable(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const [name, id] of Object.entries(value)) {
    const key = String(name ?? '').trim()
    const faceId = String(id ?? '').trim()
    if (!key || key.length > 32) continue
    if (!/^\d{1,6}$/.test(faceId)) continue
    out[key] = faceId
  }
  return out
}

/**
 * 补齐默认值并解析路径。
 *
 * 为什么路径要在这里解析：`config.json` 里写的是相对包根的路径，
 * 必须转成绝对路径才能用；而这一步同时保证了"包搬走路径跟着走"。
 */
export function normalizeConfig(c) {
  const src = c ?? {}

  // DSH 的额外安装位置候选要在 `findDshCli()` 之前算好 —— 它直接吃这张表。
  // 这样"DSH 装在非标准位置"就是一个**配置**问题，而不是"去改 src/local.mjs"。
  const dshSearchPaths = normalizePathList(src.dsh?.searchPaths)

  return {
    dsh: {
      // 路径策略：包内 vendor/dsh → 环境变量 DSH_DESKTOP_APP → 配置的 searchPaths
      // → DSH 默认安装位置。这样既能在本机直接跑，也能整体搬走，且**代码里
      // 不含任何机器专属的绝对路径**。见 src/local.mjs。
      cliPath: src.dsh?.cliPath ? resolveInPackage(src.dsh.cliPath) : findDshCli({ searchPaths: dshSearchPaths }),
      // 额外的安装根候选（相对包根解析）。用途见上面 dshSearchPaths。
      searchPaths: dshSearchPaths,
      // 工作区＝权限沙箱的根。相对路径按 PKG_ROOT 解析，所以包搬走它也跟着走。
      //
      // ⚠️ 这里刻意区分两种"空"：
      //   · 字段**没写**（undefined）→ 用默认工作区（合理的便利）
      //   · 字段**显式写成空串**  → 保留空串，交给 validateConfig 报致命错误
      // 如果这里把空串也当成"没配"而填默认值，那么"工作区不能为空"这条
      // 校验就**永远不会触发** —— 用户写错了却得到一个静默的默认值。
      // 这个坑是被 mocks/verify-config.mjs 抓出来的。
      workspace:
        src.dsh?.workspace === undefined
          ? DIRS.defaultWorkspace
          : src.dsh.workspace === ''
            ? ''
            : resolveInPackage(src.dsh.workspace),
      provider: src.dsh?.provider || 'deepseek-official',
      model: src.dsh?.model || 'deepseek-flash',
      reasoningEffort: src.dsh?.reasoningEffort || undefined,
      // 模型 API key。**可以留空** —— 留空时 `resolveModelCredentials` 会依次去读
      // 环境变量 DEEPSEEK_API_KEY 与 $DSH_HOME/.credentials.yaml（DSH 桌面版填在
      // 「模型」页里的那份）。三者的优先级见 src/credentials.mjs。
      //
      // 用 `|| ''` 而不是让它保持 undefined：这个键必须在归一化结果里**存在**，
      // 否则「脱敏 → 前端表单 → 回存」这条链上它会凭空消失（mocks/verify-manifest.mjs
      // 也会因为"清单登记了代码里没有的键"而报错）。
      apiKey: src.dsh?.apiKey || '',
      // 默认 workspace-write：这是"权限只限工作区"的载体。
      // 绝不要把默认值写成 danger-full-access。
      permissionMode: src.dsh?.permissionMode || 'workspace-write',
    },
    onebot: {
      wsUrl: src.onebot?.wsUrl || 'ws://127.0.0.1:3001',
      httpUrl: src.onebot?.httpUrl || 'http://127.0.0.1:3000',
      wsToken: src.onebot?.wsToken || '',
      // 与 wsToken 是两个不同的 token（SnowLuma 特性）；没单独配则退回 wsToken
      httpToken: src.onebot?.httpToken || src.onebot?.wsToken || '',
      selfId: src.onebot?.selfId ? String(src.onebot.selfId) : null,
    },
    access: {
      adminUsers: Array.isArray(src.access?.adminUsers) ? src.access.adminUsers.map(String) : [],
      // 私聊白名单（应在机器人的**好友列表**里选）。
      // ★ 空时的语义：**只有管理员能私聊**（fail-closed）。
      //   刻意不退回"谁都能私聊" —— 那会让刚加好友的陌生人直接能驱动
      //   一个对文件有权限的 agent。
      dmAllowlist: Array.isArray(src.access?.dmAllowlist) ? src.access.dmAllowlist.map(String) : [],
      // 群白名单（应在机器人的**群列表**里选）。空 = 所有群都不回。
      groupAllowlist: Array.isArray(src.access?.groupAllowlist)
        ? src.access.groupAllowlist.map(String)
        : [],
    },
    trigger: {
      private: src.trigger?.private !== false,
      mention: src.trigger?.mention !== false,
      keyword: src.trigger?.keyword !== false,
      groupEnabled: src.trigger?.groupEnabled === true,
      keywords: Array.isArray(src.trigger?.keywords) ? src.trigger.keywords : [],
    },
    // 节流：默认值刻意保守（宁可慢，也不要像机器人）
    send: {
      minGapMs: src.send?.minGapMs ?? 1000,
      maxGapMs: src.send?.maxGapMs ?? 3000,
      maxPerMinute: src.send?.maxPerMinute ?? 8,
      maxPerHour: src.send?.maxPerHour ?? 500,
      dedupeWindowMs: src.send?.dedupeWindowMs ?? 8000,
      maxCharsPerMessage: src.send?.maxCharsPerMessage ?? 1500,
      // ── 表情表（H6）：`[sticker:名字]` → QQ 表情 id ────────────────────────
      //
      // ★ **默认空表**，而且不配就是"不发表情"（标记会被剥掉 + 记一行日志）。
      //   为什么不做一张内置的名字→id 表：那需要**逐个确认 id 到底对应哪个表情**，
      //   猜错就是**用户可见的错误**（想发"偷笑"结果发了个"菜刀"）。宁可不发，也不发错。
      //   真正的表情库属于 M5' 的技能系统（离线标签 + 本地选图），届时由它填这张表。
      // ⚠️ 只接受**值全是数字**的条目，别的形状直接丢掉（不报错、不猜）。
      stickers: normalizeStickerTable(src.send?.stickers),
    },
    // ── 投递可靠性（0.2.3）─────────────────────────────────────────────────
    //
    // ★ 这一块只有**一个**开关，而且默认开（= 升级前的行为）。
    //   另外两块**故意不给开关** —— 它们是边界，不是功能：
    //     · 投递前终检门（`delivery-gate.mjs` 的 `gateDelivery`，`bridge.mjs` 调用）：
    //       拦内部泄漏（工具 JSON / 系统占位符 / 注入指令）。关掉 = 把这些直接发到 QQ。
    //     · 出站幂等键（`transport.mjs` 的 `deliveryKey`，H9）：关掉会**退回"裸文本当键"**，
    //       于是"同一句话 8 秒内发给两个不同会话"会被误判成重复、第二个被丢掉 —— 那是已修的缺陷。
    //   给它们做开关，等于让"关掉功能"这个动作制造出新缺陷（同 src/plugins.mjs 的口径）。
    delivery: { ledger: src.delivery?.ledger !== false },
    // ── 本地语料库（0.2.3 给它一个开关）────────────────────────────────────
    //
    // 它是什么：每条消息落进 `runtime/corpus.sqlite`（FTS5 + trigram 中文检索），
    // 于是"我上次说的那个方案叫什么来着"这类问题能查（在此之前只能现拉协议端历史，
    // 拉一次算一次、不能检索、对面一重启就没了）。
    //
    // ★ 默认 `true` = **升级前的行为**（它 0.2.1 就在跑，只是当时没有开关）。
    //   所以这个键的存在**不改变任何现有部署的行为** —— 这一点必须守住：
    //   加开关的目的是"能看见、能关"，不是"顺手把默认值收紧"。
    //
    // ★ 关掉之后**已有的库文件不删**。这条要写清楚，否则使用者会以为"关掉 = 清空"，
    //   于是不敢关。反过来，清理由 `--corpus --prune` 单独负责（默认预演）。
    corpus: { enabled: src.corpus?.enabled !== false },
    // ── 唤醒策略（0.2.3）：规则唤醒 ⟷ 语义唤醒 ─────────────────────────────
    //
    // ★★ 这是一个**二选一**，不是两个开关。为什么：
    //   两者回答的是**同一个问题** ——「这条消息要不要回」。
    //   做成两个独立开关会出现两种无意义状态：
    //     · 两个都开 ⇒ 两套判据同时生效、互相打架；
    //     · 两个都关 ⇒ 机器人不知道该不该回（哑掉）。
    //   所以两个功能放**同一个插槽、同一个单值键**：选了 `semantic`
    //   就**天然**等于 `rule` 不在了 —— 后端**没有任何"互斥检查"**，也不该有。
    //   （界面上的两个按钮就是 `wake-policy` 这张卡的 `choice.options`。）
    //
    // ★ 默认 `rule` = 今天的行为，**一次判定都不跑、一个子进程都不起**。
    //   语义唤醒是**实验性**的（从 hermes 借鉴），而且它在本项目里要起一次性
    //   `dsh --profile headless` 进程才能判定 —— 见 `src/wake-judge.mjs` 顶部
    //   关于成本的如实说明。所以它必须是**显式选择**。
    //
    // ★ 未知取值**原样保留**（不偷偷改成 rule）：`validateConfig` 会把它报出来。
    //   悄悄回落是最难排查的一类问题（"我明明设了，怎么没生效"）。
    wake: {
      policy: typeof src.wake?.policy === 'string' && src.wake.policy.trim() ? src.wake.policy.trim() : 'rule',
      judge: {
        // ── 通路：**由"有没有专用 key"推导**，不让使用者选（0.2.3）──────────
        //
        //   · `wake.judge.apiKey` **留空** ⇒ 用**一次性 DSH 进程**做判定
        //     （约 3~5 秒；用主对话那套凭据，不需要在这里配任何东西）；
        //   · **填了** ⇒ 改成**直连**一次 `/chat/completions`（约 1 秒），
        //     而且**只用这把 key**（不拿主对话那把去发请求）。
        //
        // ★ 为什么不再做成一个二选一开关：两条路在唤醒流程里做的是**同一件事**
        //   （让一个模型判断"这句话是不是说给我听的"），让使用者选一个自己无法判断
        //   好坏的东西没有意义；而"要不要单独配一把 key"本身就是那个选择的
        //   **可观察依据** —— 它会带来独立计费/限流与"不动主 key"这两个真实差别。
        // ★ 这条推导必须与两处**完全一致**：`bridge.mjs` 的 `#ensureWakeJudge`
        //   （真正建判定器的地方）与 `model-direct.mjs` 的 `resolveDirectTarget`（取 key）。
        //   界面也按同一条件渲染（见 `config-ui` 的 ExtensionsTab）。
        apiKey: typeof src.wake?.judge?.apiKey === 'string' ? src.wake.judge.apiKey.trim() : '',
        // 直连端点。默认与 DSH 的 `dsh-llm-deepseek` 一致（**注意没有 `/v1`**）。
        // ⚠️ 只有 https、或回环地址的 http 会被放行 —— 理由见 model-direct.mjs 的文件头
        //    （Authorization 头在明文 HTTP 上等于把 key 裸奔）。
        baseUrl:
          typeof src.wake?.judge?.baseUrl === 'string' && src.wake.judge.baseUrl.trim()
            ? src.wake.judge.baseUrl.trim()
            : 'https://api.deepseek.com',
        // 判定用哪个模型（只在直连那条路上有意义）。**留空 = 用 `dsh.model`**。
        // ★ 为什么留空也能跑：DSH 模型表里的 id 就是直接发给接口的 id（按源码核对过），
        //   所以"不配也对"；而"换成更便宜的小模型"应当是一次**显式**选择。
        model: typeof src.wake?.judge?.model === 'string' ? src.wake.judge.model.trim() : '',
        // ★★ 默认改为 **false**（0.2.3 用户决定）：语义判定**真的生效**。
        //   原来是 true（只记账、不改行为）——那时的理由是"换个便宜的通路之前，
        //   判定又慢又贵，而且判错成沉默是静默失败"。现在有了直连（约 1 秒、一次小调用），
        //   且**失败/超时/超预算一律放过**，所以默认生效是合理的。
        //   ★ 想先观察的人把它设回 true 即可（那时结论只写 oplog、行为不变）。
        shadow: src.wake?.judge?.shadow === true,
        timeoutMs: src.wake?.judge?.timeoutMs ?? 6000,
        maxPerHour: src.wake?.judge?.maxPerHour ?? 60,
      },
    },
    turn: { timeoutMs: src.turn?.timeoutMs ?? 10 * 60_000 },
    // 人味层：默认**开启**。这不是体验优化，是账号存活相关配置 ——
    // 秒回 + 7×24 在线是行为风控最典型的特征。
    //
    // 参数来源有两层（后者覆盖前者）：
    //   ① `humanize.speed` 档位（快速/均衡/谨慎）→ 展开成五个毫秒参数
    //   ② `humanize` 里显式写的字段 → 覆盖档位
    // 这样"选个档位"和"手工微调"可以共存：选了档位之后再改某一个字段，
    // 只有那个字段被覆盖，其余仍来自档位。
    humanize: (() => {
      const src_h = src.humanize ?? {}
      let base
      try {
        // 档位未指定时用默认档位；指定了但不存在则抛错（下面 catch 里降级）
        base = buildSpeedPreset(src_h.speed || DEFAULT_SPEED_PRESET)
      } catch {
        base = buildSpeedPreset(DEFAULT_SPEED_PRESET)
      }
      return {
        speed: src_h.speed || DEFAULT_SPEED_PRESET,
        enabled: src_h.enabled !== false,
        delay: src_h.delay !== false,
        reactMinMs: src_h.reactMinMs ?? base.reactMinMs,
        reactMaxMs: src_h.reactMaxMs ?? base.reactMaxMs,
        charsPerSecond: src_h.charsPerSecond ?? base.charsPerSecond,
        // 打字时间的**单独**上限。只靠 maxDelayMs 不够：5 字/秒下 200 字要打 40 秒。
        typingMaxMs: src_h.typingMaxMs ?? base.typingMaxMs,
        // 总延迟上限 = 反应时间 + 打字时间（留一点余量）
        maxDelayMs: src_h.maxDelayMs ?? base.maxDelayMs,
        chunkChars: src_h.chunkChars ?? 300,
        quietHours: {
          enabled: src_h.quietHours?.enabled === true,
          start: src_h.quietHours?.start ?? '02:00',
          end: src_h.quietHours?.end ?? '07:00',
        },
        quietDelayMinMs: src_h.quietDelayMinMs ?? 45_000,
        quietDelayMaxMs: src_h.quietDelayMaxMs ?? 150_000,
        // 长任务期间"先应一声"（避免使用者对着静默以为机器人坏了）
        //
        // ⚠️ 这一段曾经是"配了话术却不生效"的**真正根因**（比键名不匹配更深一层）：
        //    归一化时只认旧键 `web` / `working`，于是归一化结果里**永远没有**
        //    `searching` / `tooling`，而挑选器要的正是新键 → 每次都退回默认。
        //    使用者配了五组话术，一句都没用上，且没有任何提示。
        //
        // 现在四个类别**都归一化出来**，并且新旧键名都能读入（旧名做别名）。
        interim: (() => {
          const m = src_h.interim?.messages ?? {}
          const arr = (x) => (Array.isArray(x) ? x : undefined)
          return {
            enabled: src_h.interim?.enabled !== false,
            afterMs: src_h.interim?.afterMs ?? 8000,
            messages: {
              thinking: arr(m.thinking),
              // 新名优先，旧名兜底（旧名 `web` / `working` 是重构前的写法）
              searching: arr(m.searching) ?? arr(m.web),
              tooling: arr(m.tooling) ?? arr(m.working),
              blocked: arr(m.blocked),
            },
          }
        })(),
      }
    })(),
    session: {
      salt: src.session?.salt || undefined,
      // instance 参与 sessionId 哈希。**留空 = 每次进程启动自动换新**。
      // 为什么不能用"当天日期"之类的固定值：DSH 的会话是持久化到磁盘的，
      // 重启后无法复用同一个 sessionId（SDK 没有 resume），
      // 用固定值会导致当天第二次重启起必然报 "already exists"。
      // 详见 session-id.mjs 顶部那段真实故障记录。
      instance: src.session?.instance || undefined,
    },
    persona: {
      callerName: src.persona?.callerName || '',
      // ★ 人设库（0.2.2）：当前生效的是 `personas/<名字>.md` 里的哪一个。
      //   · 有值 = 用那个文件；`none` = 不用人设；空 = 老配置（走 preset/custom 回落）。
      active: src.persona?.active || '',
      // 人设：preset 选内置，custom 完全自己写（custom 优先）。
      // ⚠️ 0.2.2 起这两项是**老路径**：新配置用 `active` 指文件；这两项只在
      //   `active` 为空时回落使用（保证老 config.json 行为不变）。
      preset: src.persona?.preset || undefined,
      custom: src.persona?.custom || '',
    },
    // 跨重启记忆：不给 agent 加存储层，而是给它一个"记笔记"的约定
    // （工作区是持久的，它本来就有读写文件的工具）。详见 src/memory.mjs。
    memory: { enabled: src.memory?.enabled !== false },
    // 看图：QQ 图片 → 工作区落盘 → 模型（详见 src/images.mjs）。
    //
    // ★ 默认 `on-demand` 而**不是** `auto`，这是刻意的成本取舍：
    //   QQ 里大量是表情包，`auto` 等于每张表情包都花 vision token，
    //   而且图片会留在会话历史里、后续每轮重复计费。
    //   `on-demand` 只给一个路径（纯文本，留在历史里几乎不花钱），
    //   模型**自己想看的时候**才调 read_image。
    //   默认值要选"省钱的那一档"，想更快更准再自己切 —— 反过来
    //   （默认烧钱、想省再关）是错的。
    image: {
      enabled: src.image?.enabled !== false,
      // ★ 这里**保留原样**而不是把非法值改写成 'on-demand'。
      //
      //   原因和 `humanize.speed` 完全一样：一旦在归一化阶段把错值改写掉，
      //   后面 validateConfig 就**再也看不到它**，"你写错了"这条警告也就
      //   永远不会出现 —— 用户会以为设置生效了，其实一直是默认值。
      //   行为上的安全由消费方保证：`mode === 'auto'` 才走自动注入，
      //   其余任何值（含拼错的）都按 on-demand（省钱、保守）处理。
      mode: src.image?.mode || 'on-demand',
      // 单条消息最多处理几张。DSH 附件库单条消息上限是 20 张，
      // 这里默认 4：够用，且不会因为有人连发 20 张就把一轮拖死。
      maxCount: src.image?.maxCount ?? 4,
      maxBytes: src.image?.maxBytes ?? 10 * 1024 * 1024,
      timeoutMs: src.image?.timeoutMs ?? 15_000,
      maxRedirects: src.image?.maxRedirects ?? 3,
      retentionHours: src.image?.retentionHours ?? 72,
      maxTotalBytes: src.image?.maxTotalBytes ?? 100 * 1024 * 1024,
    },
    // QQ 工具（MCP）：把 SnowLuma 的动作暴露给模型，让它在明确指令下能调
    // QQ 原生功能（戳一戳、表情、撤回、查群成员…）。详见 mcp/mcp-qq-server.mjs。
    mcp: {
      enabled: src.mcp?.enabled !== false,
      toolTimeoutMs: src.mcp?.toolTimeoutMs ?? 20_000,
      // ★ 0.2.3：暴露档位与通用口。
      //   两者默认值**刻意等于今天的行为**（full + 通用口开）—— 这样升级上来的人
      //   行为零变化，收紧是**显式选择**。理由见 mcp/mcp-qq-server.mjs 的 ALLOWED_API_ACTIONS
      //   与 CONFIG-UI.md §2.6：默认收紧会把 qq_send_image 一起藏掉（P站发图链路正在用它）。
      //
      //   取值**不做白名单收敛**（保留原样），这样写错值时 validateConfig 能就原值报警；
      //   MCP 侧只认严格的 'readonly'，其余一律按 full 处理（fail-open 到"与今天一致"）。
      profile: typeof src.mcp?.profile === 'string' && src.mcp.profile.trim() ? src.mcp.profile.trim() : 'full',
      genericApi: src.mcp?.genericApi !== false,
    },
    // 协议端进程（SnowLuma）：让界面能"探测它在不在线 / 把它拉起来"。
    // 桥接本身**不需要**这些值就能工作 —— 它只影响界面上的那张进程卡。
    // 所以留空是完全正常的（默认就是留空）。
    snowluma: {
      // SnowLuma 装在哪。相对路径按 **PKG_ROOT** 解析（不是 cwd），所以包搬走它跟着走。
      // 留空则完全交给 findSnowluma 的候选表（vendor/snowluma → SNOWLUMA_HOME 环境变量）。
      //
      // ★ 发布包把这里留空，用户自己解压 SnowLuma 后用界面/配置指过来；
      //   开发机上填 `../../snowluma` 是为了指向工作区里那份（实测本机有两个安装）。
      installDir: src.snowluma?.installDir ? resolveInPackage(src.snowluma.installDir) : '',
      // 额外的安装目录候选，可填多个。存在的意义：不想把路径写进 installDir（它会**覆盖**
      // 自动发现）时，用这张表"补充"候选，找不到就继续往下找，不会因为一条写错而彻底失效。
      searchPaths: normalizePathList(src.snowluma?.searchPaths),
      launchCmd: src.snowluma?.launchCmd || '',
      launchCwd: src.snowluma?.launchCwd || '',
      // 控制台地址。默认 5099 来自 SnowLuma **自己的** config/runtime.json
      // 的 `webuiPort` —— 那是它的用户设置，所以这里做成可配而不是写死。
      consoleUrl: src.snowluma?.consoleUrl || 'http://127.0.0.1:5099/',
      probeTimeoutMs: src.snowluma?.probeTimeoutMs ?? 1500,
    },
    // 用量记账（概览页的用量卡片）。默认**记账但不显示钱**：
    // token 数是量出来的，可靠；钱要靠人工维护的价目表，不可靠。
    usage: {
      enabled: src.usage?.enabled !== false,
      costEnabled: src.usage?.costEnabled === true,
      pricesFile: src.usage?.pricesFile || 'prices.json',
    },
    ui: {
      logFile: src.ui?.logFile || 'logs/bridge.log',
      verbose: src.ui?.verbose === true,
      // 本地配置接口：默认开启，只监听回环。
      apiEnabled: src.ui?.apiEnabled !== false,
      apiPort: src.ui?.apiPort ?? 3410,
    },
    // 外部技能（`skills/<id>/`）的设置。**键集由各技能自己的 skill.json 定义**，
    // 所以这里原样保留（见 normalizeSkillSettingsMap 的长注释）。
    //
    // 为什么它必须是配置的一部分、而不是一个独立的 skills.json：
    //   ① 密文字段（pixiv 的 Cookie）要复用同一套"脱敏 + 留空即不修改"语义，
    //      另起一份文件就会多出一套语义，迟早不一致；
    //   ② 保存走同一条通道（校验、.bak、致命项拒绝）才算真的安全。
    skills: normalizeSkillSettingsMap(src.skills),
    // 安全相关的开关（**默认全是保守值**）。
    security: {
      // ★ 允许把"内网/本机地址"的图片发出去（默认关）。
      //
      // 为什么会有这个键：第三方技能（例如 pixiv 插件）常常在自己机器上开一个小端口
      // 做图片中转 —— 它给模型的"发图直链"是 `http://127.0.0.1:<port>/i/xxx`。
      // 而桥接的图片守卫（src/images.mjs）**默认拒回环/私网地址**（那是防 SSRF 的），
      // 于是这类技能"查得到图、发不出去"，而且失败原因看起来像网络故障。
      //
      // 打开它 = 明确告诉桥接"我信任本机图源"。语义与 pixiv 插件文档里写的
      // `security.allowPrivateImageHosts` 一致（那是它对我们提出的要求）。
      allowPrivateImageHosts: src.security?.allowPrivateImageHosts === true,
    },
  }
}

/**
 * 配置自检。返回致命问题列表（非空则拒绝启动）。
 * 设计原则：**配置错误必须挡在启动阶段**，不能等第一条消息来了才暴露。
 */
export function validateConfig(config) {
  const fatal = []
  const warn = []

  // 工作区：不能是盘符根，也不能是用户主目录（那等于把整个磁盘交出去）。
  // 相对路径是允许的 —— 它相对包根解析，正好让包搬走时工作区跟着走。
  const ws = config.dsh.workspace
  if (!ws) {
    fatal.push('dsh.workspace 不能为空')
  } else if (/^[a-zA-Z]:\\?$/.test(ws) || ws === '/' || ws === '\\') {
    fatal.push(`dsh.workspace 不能是盘符根（${ws}）—— 那等于把整个磁盘交给 agent`)
  } else if (/^[a-zA-Z]:\\Users\\[^\\]+\\?$/i.test(ws)) {
    fatal.push(`dsh.workspace 不能是用户主目录（${ws}）—— 权限会大到无法控制`)
  }

  // 管理员：空 = 谁都不能用。这是刻意的 fail-closed，但要明确告知。
  if (config.access.adminUsers.length === 0) {
    warn.push(
      'access.adminUsers 为空：**没有人可以使用这个机器人**（fail-closed 设计）。' +
        '请在 config.json 里填入你自己的 QQ 号。',
    )
  }
  for (const id of config.access.adminUsers) {
    if (!/^\d{5,12}$/.test(id)) warn.push(`access.adminUsers 里的「${id}」不像 QQ 号，请检查`)
  }

  // 权限模式：danger-full-access 与"只限工作区"的决定矛盾，明确警告
  if (config.dsh.permissionMode === 'danger-full-access') {
    warn.push(
      'dsh.permissionMode = danger-full-access：agent 将能读写整个磁盘且免审批，' +
        '这与你"权限只限工作区"的决定相反。',
    )
  }

  // 关键词：会静默变成"全响应"的写法要抓出来
  warn.push(...lintKeywords(config.trigger.keywords).map((x) => `关键词告警：${x.message}`))

  // 人设：预设名写错、或提到不存在的工具，都要抓出来。
  // "提到不存在的工具"这条来自真实教训：源项目的人设里要求模型使用三个
  // 从未注册过的工具，结果是幻觉调用 + 浪费回合。
  warn.push(...lintPersona({ preset: config.persona?.preset, custom: config.persona?.custom }).map((x) => `人设告警：${x}`))

  // 群聊
  if (config.trigger.groupEnabled) {
    warn.push(
      'trigger.groupEnabled = true：**群聊已开启**。群聊只有在【被 @】或【命中关键词】时才回，' +
        '不会自动搭话。注意账号风控风险 —— 上一个 QQ 号就是因此被处置的。',
    )
    // 关键词是"包含匹配"，在群里直接决定成本与打扰程度，必须再提醒一次
    if (!Array.isArray(config.trigger.keywords) || config.trigger.keywords.length === 0) {
      warn.push('群聊开着但关键词表为空：那就只能靠 @ 唤醒了（这本身没问题，只是确认你知道）')
    }
  }

  // ── 本地语料库（0.2.3）──────────────────────────────────────────────────
  //
  // 只对**非默认值**告警（默认是开 = 升级前的行为，安静）。
  // 口径同 `mcp.profile = readonly`：把"你关掉了一个能力"如实说出来，
  // 免得排查时对着 `qq_search_history` 报的"搜不到"去找别的原因。
  if (config.corpus?.enabled === false) {
    warn.push(
      'corpus.enabled = false：**不再把消息落进本地语料库**，`qq_search_history` / ' +
        '`qq_forward_log` 会**当场拒绝**（不是"搜不到"）。★ 已有的 `runtime/corpus.sqlite` ' +
        '**不会被删**，重新打开就还能搜到旧消息；清理要单独用 `--corpus --prune`。',
    )
  }

  // ── 唤醒策略（0.2.3）────────────────────────────────────────────────────
  //
  // 这一节的三条告警都围绕同一件事：**语义唤醒是有代价的、而且会改变行为**。
  // 它是本轮唯一"用户选了之后成本会上升"的开关，所以宁可多说一句。
  {
    const policy = config.wake?.policy
    if (policy !== 'rule' && policy !== 'semantic') {
      warn.push(
        `wake.policy「${policy}」不是有效值（可选 rule / semantic），已按 rule（规则唤醒）处理。` +
          `注意：这个键是**二选一**，写别的值不会"两个都开"，只会退回规则唤醒。`,
      )
    }
    if (policy === 'semantic') {
      const j = config.wake.judge ?? {}
      // ★ 通路**由"有没有专用 key"推导**（唯一判据，与 bridge.mjs / model-direct.mjs 一致）
      const viaHttp = Boolean(String(j.apiKey ?? '').trim())
      warn.push(
        'wake.policy = semantic：**判定器会决定要不要沉默**。' +
          '它只做减法（规则说回、它才能说不回），且失败/超时/超预算一律**放过**。' +
          (viaHttp
            ? `★ 通路：**直连** ${j.baseUrl}（模型 ${j.model || config.dsh?.model || '?'}，约 1 秒、一次小调用）—— 因为你配了 wake.judge.apiKey。`
            : '★ 通路：起一个**一次性 DSH 进程**做判定（约 3~5 秒、用主对话那套凭据）。' +
              '★ 想让它变快、或想给判定单独计费，就填一把 `wake.judge.apiKey`：填了就自动改走直连，只用那把 key。') +
          `上限由 wake.judge.maxPerHour 兜住。`,
      )
      if (j.shadow === true) {
        warn.push(
          'wake.judge.shadow = true：判定照跑、结论只写进 oplog（runtime/oplog/），' +
            '**行为一个字都没变**（这是你自己选的观察模式）。要真正生效，把它改成 false。',
        )
      } else {
        warn.push(
          'wake.judge.shadow = false（**默认**）：语义判定**已经生效** —— 被判为"沉默"的消息不会得到回复，' +
            '而且**不会有任何提示**。想先观察就把 wake.judge.shadow 设成 true（那时结论只写 oplog、行为不变）。',
        )
      }
      // 通路配不全 ⇒ 判定器**每一轮都会白白放过**，而日志里只有一行"没配好"。
      // 这种"功能开了但其实没跑"必须尽早说出来（静默失效是本项目最忌讳的）。
      //
      // ★ 这里**只查 headless 那一条**，理由：直连那条的 key 由使用者自己填在
      //   `wake.judge.apiKey` 里 —— **填了才会走直连**，所以"走直连却没有 key"
      //   在结构上不可能发生（不需要校验）。而 DSH 的 cliPath 完全可能为空
      //   （机器上没装/没找到 DSH），那时判定器一次都跑不起来。
      //   ∴ 只报这一条。假红会训练人忽略红色，宁可少查。
      if (!viaHttp && !config.dsh?.cliPath) {
        warn.push(
          'wake.policy = semantic，但没有配 wake.judge.apiKey（所以走一次性 DSH 进程），' +
            '而 dsh.cliPath 是空的：判定器无法工作（每一轮都会按放过处理）。' +
            '要么把 dsh.cliPath 配好，要么填一把 wake.judge.apiKey（填了就自动改走直连）。',
        )
      }
      // ★ 与 interim（"回合还在跑，先应一声"）的顺序关系：判定比它慢的话，
      //   用户会先看到"我在想"、然后什么都没有 —— 比直接不回更怪。这条不是风格。
      const interimMs = config.humanize?.interim?.afterMs ?? 8000
      if (Number.isFinite(j.timeoutMs) && j.timeoutMs >= interimMs) {
        warn.push(
          `wake.judge.timeoutMs（${j.timeoutMs}ms）不小于 humanize.interim.afterMs（${interimMs}ms）：` +
            `会出现"先弹一句‘我在想’，然后什么都没有"。建议把判定超时压到 ${interimMs} 以下。`,
        )
      }
      if (!Number.isFinite(j.maxPerHour) || j.maxPerHour <= 0) {
        warn.push(
          `wake.judge.maxPerHour（${j.maxPerHour}）不是正数：判定额度永远为 0，` +
            `等于语义唤醒**完全没生效**（每条都按规则结论放过）。`,
        )
      }
    }
  }

  // ── 看图 ────────────────────────────────────────────────────────────────
  //
  // 这里的告警都围绕一件事：**图片是有成本的**（vision token + 磁盘），
  // 所以任何"会让它悄悄变贵"的写法都要说出来。
  const img = config.image ?? {}
  if (img.enabled !== false) {
    if (img.mode !== 'auto' && img.mode !== 'on-demand') {
      warn.push(
        `image.mode「${img.mode}」不是有效值（可选 on-demand / auto），已按 on-demand 处理。`,
      )
    }
    // 20 是 DSH 附件库的单条消息图片数上限；超过它的部分会被**整批拒绝**，
    // 表现是"图片莫名全都没进去"，所以提前把矛盾点出来。
    if (!Number.isInteger(img.maxCount) || img.maxCount < 1) {
      warn.push(`image.maxCount「${img.maxCount}」不是正整数，图片会全部取不到，请修正。`)
    } else if (img.maxCount > 20) {
      warn.push(
        `image.maxCount = ${img.maxCount}：DSH 附件库单条消息上限是 20 张，` +
          `超过的部分会被整批拒绝。建议 ≤ 20。`,
      )
    }
    // DSH 附件库单张上限默认 20MB（dsh-attachment-local 的 maxImageBytes）。
    // 配得比它还大没有意义 —— 我们下载完也会被它拒。
    if (!Number.isFinite(img.maxBytes) || img.maxBytes < 1) {
      warn.push(`image.maxBytes「${img.maxBytes}」不是正数，图片会全部取不到，请修正。`)
    } else if (img.maxBytes > 20 * 1024 * 1024) {
      warn.push(
        `image.maxBytes = ${img.maxBytes} 字节超过 DSH 附件库的单张上限（20MB），` +
          `超出的图片下载下来也会被拒绝，白费带宽。`,
      )
    }
    if (img.mode === 'auto') {
      warn.push(
        'image.mode = auto：**每张图片都会直接送进模型**（更快更准），' +
          '代价是每张图都计 vision token，且图片会留在会话历史里重复计费。' +
          'QQ 里表情包很多时成本会明显上升；想省就改回 on-demand。',
      )
    }
    if (!Number.isFinite(img.retentionHours) || img.retentionHours <= 0) {
      warn.push(
        `image.retentionHours「${img.retentionHours}」不是正数：inbox 里的图片不会被清理。` +
          `发图会持续占磁盘（这是唯一的清理机制，关掉它请自己负责）。`,
      )
    }
  }

  // OneBot 地址：ws 与 http 不能填成同一个端口
  try {
    const wsPort = new URL(config.onebot.wsUrl).port
    const httpPort = new URL(config.onebot.httpUrl).port
    if (wsPort === httpPort) {
      fatal.push(
        `onebot.wsUrl 与 onebot.httpUrl 指向了同一个端口（${wsPort}）。` +
          `SnowLuma 默认 3001=WebSocket、3000=HTTP，请检查。`,
      )
    }
  } catch {
    fatal.push('onebot.wsUrl / onebot.httpUrl 不是合法的 URL')
  }

  if (!config.onebot.wsToken && !config.onebot.httpToken) {
    warn.push('没有配置任何 accessToken。如果 SnowLuma 那边设了 token，连接会被拒绝。')
  }

  // 人味层被关掉要明确警告 —— 它是账号存活相关配置，不是体验开关
  if (config.humanize?.enabled === false) {
    warn.push(
      'humanize.enabled = false：机器人会秒回。**秒回 + 7×24 在线是行为风控最典型的特征**，' +
        '上一个 QQ 号被处置的最可能原因即此。除非你在做本地测试，否则建议保持开启。',
    )
  } else {
    // 档位自洽性（参数互相打架的写法要抓出来）
    warn.push(...lintHumanize(config.humanize).map((x) => `回应速度告警：${x}`))

    // ★ "快速"档位风险最高，必须明确警告 —— 它约等于秒回
    if (config.humanize?.speed === 'fast') {
      warn.push(
        `回应速度档位是「${SPEED_PRESETS.fast.label}」：${SPEED_PRESETS.fast.riskText}`,
      )
    }
  }

  // 档位名写错要报出来（否则会静默落回默认档，用户以为设置生效了）
  if (config.humanize?.speed && !Object.prototype.hasOwnProperty.call(SPEED_PRESETS, config.humanize.speed)) {
    warn.push(
      `humanize.speed「${config.humanize.speed}」不是有效档位，已按「${DEFAULT_SPEED_PRESET}」处理。` +
        `可选：${Object.keys(SPEED_PRESETS).join(' / ')}`,
    )
  }

  // ── 扩展（技能 / 插件）相关 ──────────────────────────────────────────────
  //
  // ── QQ 工具暴露档位（0.2.3）────────────────────────────────────────────
  //
  // 归一化**刻意不收敛**非法值（见 normalizeConfig）：就是为了在这里拿原值报警。
  // 否则把 'readonly' 写成 'read-only' 会被静默当成 full ——
  // 表现是"我明明收紧了，它却还是全都放行"，属于最难查的一类。
  const mcpProfile = config.mcp?.profile
  if (mcpProfile !== 'full' && mcpProfile !== 'readonly') {
    warn.push(`mcp.profile「${mcpProfile}」不是有效值（只能是 full / readonly）—— 已按 full 处理（= 与升级前一致）。`)
  } else if (mcpProfile === 'readonly') {
    warn.push('mcp.profile = readonly：模型只会拿到**只读**工具，发送/互动类工具不再给它 —— 确认这是你要的。')
  }
  if (config.mcp?.genericApi === false) {
    warn.push('mcp.genericApi = false：模型看不到 qq_api（那个万能只读口）—— 具名工具不受影响。')
  }

  // 这里只能做**与清单无关**的检查（config.mjs 刻意不 import 技能发现 —— 那会把
  // 文件系统扫描带进一处本该是纯函数的地方）。逐技能的清单校验在
  // `src/extensions.mjs` / `--extensions` 自检里做。
  const skills = config.skills ?? {}
  if (Object.keys(skills).length > 0) {
    for (const [id, settings] of Object.entries(skills)) {
      // 配置里有、磁盘上没有 = 用户删了技能目录但配置还在（或改过 id）。
      // 不报错（配置留着不影响运行），但要说出来，否则"我明明开了它"永远查不清。
      if (!existsSync(join(DIRS.skills, id))) {
        warn.push(
          `config.skills 里有「${id}」，但 skills/${id}/ 目录不存在 —— ` +
            `技能可能已被删除或 id 写错了（这份配置会被忽略）。`,
        )
      }
      if (settings?.enabled === true) {
        warn.push(`技能「${id}」是**开启**状态：它会把自己的工具给模型，并按自己的说明联网/落盘。确认是你装的。`)
      }
    }
  }

  if (config.security?.allowPrivateImageHosts === true) {
    warn.push(
      'security.allowPrivateImageHosts = true：**允许把内网/本机地址的图片发出去**。' +
        '这是给"本机图片中转"类技能（例如 pixiv 插件的本地图片桥）开的口子 ——' +
        '打开后，模型给出的 127.0.0.1/内网图片地址也会被真的取回来发出去。' +
        '只在你知道自己在做什么、且只跑自己装的技能时打开。',
    )
  }

  return { fatal, warn }
}
