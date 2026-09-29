/**
 * **通道提示词拼装**（H16：从 `bridge.mjs` 里拆出来的那一块）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么拆它、以及**为什么必须最后拆**
 * ══════════════════════════════════════════════════════════════════════════
 * `#buildPrompt` 是 `bridge.mjs` 里最长、也最贵的一段（"任务段从未注入"那个
 * 最难查的缺陷就出在这里）。计划里说"越早拆越便宜"，我同意前半句，但**先做了两件事**：
 *
 *   ① **段的顺序快照**（`verify-memory-roundtrip.mjs` §⑰）：钉住"有哪些段、谁在前谁在后"；
 *   ② ★★ **逐字基线**（同文件 §⑱ + `mocks/fixtures/prompt-golden.txt`）：
 *      同一份输入产出的提示词，搬代码前后必须**一个字都不差**。
 *
 * 为什么非要②：搬一段拼装逻辑时，**离线测试只能证明"行为不变"** ——
 * 而"行为不变"最强也最省事的证明就是逐字相同。没有它，我改的是
 * 前缀缓存（实测命中 91%~96%）与注入语义所依赖的东西，却只能"看着像对的"。
 *
 * ── 拆分的边界（谁负责什么）──────────────────────────────────────────────
 *   · **本模块**：拼装顺序、段落措辞、以及"哪一段该在稳定前缀里"的判断。
 *     它**不持有状态**：会话走向、一次性断线缺口、注入告警去重都由桥接通过
 *     `ctx` 传进来（`consumeGap()` 让桥接继续当缺口的唯一所有者）。
 *   · **桥接**：一切有状态的东西（`#pendingGap` / `#sessionState` / `#injectWarned`）。
 *
 *   ★ 这样拆的好处不只是"文件变短"：拼装顺序与措辞现在可以在**不起桥接**的情况下被审阅。
 *
 * @param {object} ctx 见下方 `buildChannelPrompt` 的解构（每项都有注释）
 * @returns {Promise<string>} 提示词全文
 */

import { REASON } from './trigger.mjs'
import { renderNicknameBlock } from './contacts.mjs'
import {
  buildMemoryInstructionsV2,
  readMemoryForPrompt,
  takeReceipt,
  verifyAndRestoreMemory,
} from './memory-store.mjs'
import { recordInjection } from './memory-usage.mjs'
import { renderMarkerInstructions } from './markers.mjs'
import { listRecipes, pickRecipes, renderRecipeBlock } from './recipes.mjs'
import { buildPermissionInstructions } from './roster.mjs'
import { projectDocLine } from './project-doc.mjs'
import { renderSessionStateBlock } from './session-state.mjs'
import { readTask, renderTaskBlock } from './tasks.mjs'
import { describeGap } from './transport.mjs'

/** 平台约束：告诉模型它现在在 QQ 里，而不是在 DSH 网页界面里。 */
export const PLATFORM_RULES = [
  '你现在通过 QQ 与用户对话，不是在 DSH 的网页界面里。请遵守：',
  '1. 输出纯文本。QQ 不渲染 Markdown —— 不要写标题、表格、加粗标记。',
  '2. 不要调用需要图形界面交互的工具（例如 ask_user_question、exit_plan_mode），',
  '   它们在 QQ 通道上无人可答，会让对话卡住。需要确认时直接用文字问。',
  '3. 你的工作目录被限制在一个专用工作区里（这是权限边界，不是故障）。',
  '   越界操作会被系统自动拒绝。遇到这种情况时：',
  '   · 用你自己的话说清楚"这件事我暂时没权限做"，**不要用系统报错的原文**',
  '     （类似 "file access denied under workspace-write mode" 这种话用户看不懂）。',
  '   · 不要报路径、不要描述沙箱机制、不要说"越界""被拦截"之类的实现细节。',
  '   · 如果这件事有别的做法（比如在工作区内完成、或者让用户自己动手），',
  '     顺口提一句；没有就不提。',
  '   · 不要假装成功，也不要反复重试同一个被拒的操作。',
].join('\n')

/** 两位补零（时间戳用）。 */
const p2 = (n) => String(n).padStart(2, '0')

/**
 * 拼出这一轮要给模型的完整提示词。
 *
 * @param {object} ctx
 * @param {object} ctx.rendered 解析后的入站消息（`text` / `images`）
 * @param {string} ctx.reason 唤醒原因（`REASON.*`）
 * @param {'private'|'group'} ctx.kind
 * @param {string|number} ctx.peerId
 * @param {string|number|null} ctx.senderId
 * @param {'admin'|'user'} ctx.tier 由 roster 判定的真实权限
 * @param {object|null} ctx.identity 协议端核实过的身份（昵称/群角色/会话名）
 * @param {object[]} ctx.images 已取到的图片结果（`ok` / `relPath` / `reason`）
 * @param {string|null} ctx.chatKey 会话键（**必须与写侧的键一致** —— 这里踩过最贵的坑）
 * @param {string|number|null} ctx.messageId 这条消息的 id（H6 的引用要用）
 * @param {object} ctx.config 归一化配置
 * @param {string} ctx.personaText 人设文本（构造时算好、缓存）
 * @param {(m: string) => void} ctx.log
 * @param {(what: string, error: unknown) => void} ctx.warn 注入失败告警（每段只喊一次，去重在桥接）
 * @param {{read: (k: string) => object|null}|null} ctx.sessionState 会话状态（H10）
 * @param {() => {ms: number, since: number}|null} ctx.consumeGap 取用一次性的断线缺口（H9）
 * @param {Array<{id: string, content: string, sessionMode?: string}>} ctx.skillSections
 *        已启用技能的提示词片段（0.2.2）。**由桥接预先收集**（`src/extensions.mjs`），
 *        本模块只负责按顺序拼进提示词 —— 顺序固定：权限段之后、记忆段之前。
 * @param {string} ctx.nickname 当前说话人的昵称（按人昵称，0.2.2）。空 = 不注入任何东西。
 */
export async function buildChannelPrompt({
  now = new Date(),
  rendered,
  reason,
  kind,
  peerId,
  senderId = null,
  tier,
  identity = null,
  images = [],
  chatKey = null,
  messageId = null,
  config,
  personaText = '',
  log = () => {},
  warn = () => {},
  sessionState = null,
  consumeGap = () => null,
  skillSections = [],
  /** 表情包技能贡献的"怎么写 `[sticker:标签]`"那几行（**只列库里真有货的标签**）。 */
  stickerLines = [],
  nickname = '',
  projectDocRel = '',
} = {}) {
  const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`

  // ★ 来源标注必须如实区分私聊与群聊。
  //   原先这里写死"来自 QQ 私聊" —— 群聊打开后那就是**错的上下文**，
  //   模型会以为自己在一对一对话里，于是用私聊口吻回群里。
  // ★★ 发言人身份标注**必须按真实权限等级**，绝不能写死"管理员"。
  //
  // 这里原来是一段写死的 `who`：只要配了 callerName 就标"（…，管理员）"，
  // 否则一律标"（管理员）" —— 也就是说**每个在群里说话的人都被标注成管理员**。
  // 后果有两层，第二层更严重：
  //
  //   ① 模型会照着这行字把说话人当成管理员，于是把他写进记忆
  //      （实测就是这样：群里一个普通用户被记成"管理员，会来更正记录"）；
  //   ② 这一行是**系统侧的可信信息**，和真正的权限段（roster 按 adminUsers 判定）
  //      自相矛盾。模型看到的两个来源打架时，它更信"贴在人身上的标签"，
  //      于是可能因此答应本该拒绝的请求 —— 也就是把权限判定从代码层
  //      泄漏成了提示词层的猜测。
  //
  // ★★ 补上"这个人是谁"：昵称与群内角色由桥接的 `#verifyIdentity` **从协议端核实**。
  //    查不到昵称就只写号码，**不编名字**。
  const isAdminTier = tier === 'admin'
  const namePart = identity?.ok && identity.name ? `「${identity.name}」` : ''
  // ★ 群内角色后面必须紧跟一句"与权限无关"：
  //   模型看到"群主""群管理"这种词很容易自己推出"那他有权限" —— 而那正是权限判定的旁路。
  const rolePart =
    identity?.ok && identity.roleLabel
      ? `（${identity.roleLabel}，身份来自协议端核实；**与权限无关**，能不能动手只看下面的权限段）`
      : ''
  const who = isAdminTier
    ? config.persona?.callerName && reason === REASON.PRIVATE
      ? `（${config.persona.callerName}，管理员）`
      : '（管理员）'
    : '（普通用户，只读）'
  // ── 会话名（这个群/这个人叫什么）──────────────────────────────────────
  // ★ 群名是协议端给的事实，可以直说；查不到就**只写群号**，不编名字。
  const chatPart = identity?.chatName ? `「${identity.chatName}」` : ''
  // ★★ 来源标注里带上**这条消息的 id**（H6）：在此之前提示词里根本没有 id，
  //    而任务段却一直在说"用带 # 的消息 id 引用回复" —— **承诺了一个不存在的能力**。
  //    ⚠️ 它每轮都变 → 只能待在**易变区**（origin 本来就在易变区，不破坏前缀缓存）。
  const msgIdPart = messageId != null && String(messageId) !== '' ? `  #${String(messageId)}` : ''
  const origin =
    kind === 'group'
      ? `[来自 QQ 群 ${peerId}${chatPart}，发言人 ${senderId ?? '?'}${namePart}${rolePart}${who}${msgIdPart}  ${stamp}]`
      : `[来自 QQ 私聊 ${senderId ?? '?'}${namePart}${who}${msgIdPart}  ${stamp}]`

  const lines = [PLATFORM_RULES]

  // ── 人设 ────────────────────────────────────────────────────────────
  // 放在平台规则**之后**（硬规矩先说）、记忆**之前**（先身份后记忆）。
  if (personaText) lines.push('', personaText)

  // ── 权限等级（决定它能不能"动手"）────────────────────────────────────
  lines.push('', buildPermissionInstructions(tier, kind))

  // ── 项目简介副本（0.2.2）：**一行指针**，不是文档本体 ────────────────────
  //
  // ★ 为什么需要它：文档在**包外**（agent 的工作区沙箱读不到），
  //   而"你能做什么 / 你能改我的文件吗 / 这项目怎么做的"这类问题如果只能凭印象答，
  //   答错的代价是使用者对权限的误判。桥接启动时把简介复制进 `store/`，
  //   这里只告诉模型"有这么一份、需要时去读"（几行字的成本，换来的是它可以**先查再答**）。
  // ★ 键**不存在或为空**时（发布包不带 docs/、或写失败）⇒ 一个字都不出现：
  //   宁可它老实说"我不确定"，也不要留一个指向空气的文件名。
  if (projectDocRel) {
    lines.push('', projectDocLine({ rel: projectDocRel }))
  }

  // ── 外部技能（`skills/`）给的指引（0.2.2）──────────────────────────────
  //
  // ★ 位置：权限段之后、记忆段之前 —— 与权限段同类（"你会什么、你能做什么"），
  //   而且**只在管理员开关变化时才变**，所以留在相对静态的那一段里，不吃前缀缓存。
  //
  // ★ 内容由桥接预先收集好传进来（`src/extensions.mjs` 的 collectSkillPromptSections）：
  //   本模块是**纯拼装器**，不碰文件系统、不知道"技能"这种东西怎么装 —— 这样
  //   `buildChannelPrompt` 继续是一个能被离线测试的纯函数。
  //
  // ★ 关掉的技能**一个字都不出现**：工具被关掉之后，提示词里若还留着"用 XX 查"，
  //   模型会去调一个会被拒绝的工具，然后对用户说"查不到" —— 那比不装这个技能更糟。
  if (Array.isArray(skillSections) && skillSections.length > 0) {
    const body = skillSections.map((s) => String(s.content ?? '').trim()).filter(Boolean).join('\n')
    if (body) {
      lines.push('', ['【额外本事（来自已启用的扩展技能）】', body].join('\n'))
      // 声明了"必须知道当前会话"的技能：它们的工具入参会多出 kind/peerId 两个必填项，
      // 而技能自己的文案不会提这件事（那是宿主加的参数）—— 所以由宿主在这里说清楚。
      if (skillSections.some((s) => s.sessionMode === 'required')) {
        lines.push(
          '（上面这些工具调用时会要求 kind 与 peerId 两个参数：kind 填 private/group，' +
            'peerId 填**本轮来源标注里那串号码**。这不是可选装饰 —— 缺了会被直接拒绝，' +
            '我不会拿不准的会话去执行。）',
        )
      }
    }
  }

  // ── 记忆（**写入权在桥接，不在模型**）────────────────────────────────
  //
  // ★ 这一段**不含任何文件路径**：① 写入由桥接做，模型不需要路径；
  //   ② 路径随会话变化，写进提示词就会破坏前缀缓存（实测命中 91%~96%）。
  if (config.memory?.enabled !== false && config.dsh?.workspace) {
    const workspace = config.dsh.workspace
    // ★ 先查篡改：模型手里仍有 write 工具，可以绕过标记直接改记忆文件。
    verifyAndRestoreMemory({ workspace, log })
    const recall = readMemoryForPrompt({ workspace, kind, peerId, log })
    // ★ H3：把"这一轮**真的注入了**哪些条目"记进使用侧车（只记时间与次数）。
    //   ⚠️ 只记"被注入"，不记"被用上" —— 我们观测不到模型到底依赖了哪条。
    try {
      recordInjection({ workspace, blocks: recall.blocks, chatKey, at: Date.now(), log })
    } catch (error) {
      log(`⚠️ [bridge] 记忆使用账本没记上（记忆本身不受影响，只报这一次）：${error?.message ?? error}`)
    }
    // 回执是"上一条消息里的记忆到底记上没有"——读后即删，只出现一次
    const receipt = takeReceipt({ workspace, kind, peerId })
    lines.push('', buildMemoryInstructionsV2({ kind, recall, receipt }))
  }

  // ── 称呼（按人昵称，0.2.2）────────────────────────────────────────────
  //
  // ★ 只注入**当前说话人**那一条 —— 群里也是只看发言人，**不列全群**：那是隐私面
  //   （"这个群里有谁、他们各自被叫什么"不该因为一次发言就整表进上下文）。
  // ★ 与记忆段**分开门控**：记忆关掉不等于"连怎么称呼都不知道"，而且这个文件是
  //   主人显式维护的（不是模型学来的），所以不看 `memory.enabled`。
  // ★ 没有昵称时**一个字都不产生** —— 提示词逐字基线（prompt-golden）因此不受影响。
  if (nickname) {
    const block = renderNicknameBlock(nickname)
    if (block) lines.push('', block)
  }

  // ── 当前任务（**不丢主线的锚**）───────────────────────────────────────
  //
  // 为什么放在 origin 之前、记忆之后：语义上属于"此刻"（要靠近正文），
  // 但**每轮都在变**，所以绝不能挪进稳定前缀（那会打断平台规则/人设/权限的缓存）。
  if (config.dsh?.workspace) {
    try {
      const task = readTask({ workspace: config.dsh.workspace, chatKey })
      const block = renderTaskBlock(task)
      if (block) lines.push('', block)
    } catch (error) {
      warn('任务段', error)
    }

    // ── 可套用的做法（配方库）──────────────────────────────────────────
    // 与任务段是两个轴：台账说"我正在干什么"，配方说"这种事一般怎么做"，都注入、不合并。
    // ⚠️ 恒为空是正常的；低于阈值也不注入（宁可不提，也别把提示词糊掉）。
    try {
      const picked = pickRecipes(listRecipes({ workspace: config.dsh.workspace }), rendered?.text ?? '')
      const rb = renderRecipeBlock(picked)
      if (rb) lines.push('', rb)
    } catch (error) {
      warn('配方段', error)
    }
  }

  lines.push('', origin, rendered.text)

  // ── H10：对话走向（纯规则，零模型调用）────────────────────────────────
  //   ★ 与任务台账并存但不同轴；没什么可说时返回空串。
  //   ★ 它在**来源标注之后**（末尾的指令更容易被遵循）—— 这条顺序有快照测试钉着。
  try {
    const st = sessionState?.read(chatKey)
    const block = renderSessionStateBlock(st)
    if (block) lines.push('', block)
  } catch (error) {
    warn('对话走向段', error)
  }

  // ── H9：断线缺口（**一次性**）─────────────────────────────────────────
  // ★ 为什么在易变区：它只在下一轮有意义，而且每轮都不同。
  // ★ 用掉就清：隔几轮还在提「刚才掉线了」只会让人莫名其妙。
  const gap = consumeGap?.()
  if (gap) {
    const gapText = describeGap({ ms: gap.ms, since: gap.since })
    if (gapText) lines.push('', gapText)
  }

  // ── 带内标记怎么用（H6）────────────────────────────────────────────────
  // ★ **只在真有东西可教时才教**（没有表情表时就不提 `[sticker:…]`）——
  //   提示词里凡是写了的能力都必须是真的。
  // ★ 0.2.4：`stickerLines` 是表情包技能贡献的那几行（标签由库里"真有货"的现算）。
  //   它并进**同一个段**，而不是另起一段 —— 两段都教 `[sticker:…]` 就会出现
  //   一套说"写名字"、另一套说"写标签"的两种措辞（模型的困惑源）。
  const markerHelp = renderMarkerInstructions({
    stickers: config.send?.stickers ?? {},
    messageId,
    stickerLines,
  })
  // 插在 `origin` 之前：`lines` 末尾此刻是正文/走向段/缺口，它们之后不该再插东西
  if (markerHelp) lines.splice(lines.length - 2, 0, '', markerHelp)

  // ── 图片 ────────────────────────────────────────────────────────────
  // 如实说"图在哪、怎么看"。旧版写的是"当前通道未启用看图能力"，而能力一直都在。
  const gotImages = images.filter((x) => x.ok)
  const lostImages = images.filter((x) => !x.ok)
  const skipped = Math.max(0, (rendered.images ?? 0) - images.length)

  if (gotImages.length > 0) {
    if (config.image?.mode === 'auto') {
      lines.push(`（这条消息里的 ${gotImages.length} 张图片**已直接附在这条消息上**，你可以直接看。）`)
    } else {
      lines.push(
        `（这条消息里含 ${gotImages.length} 张图片，已存到工作区：` +
          `${gotImages.map((x) => x.relPath).join('、')}。）`,
      )
      // 这条提醒是**成本控制**：读图会花 vision token，而很多图（表情包）不值得读。
      lines.push('（需要看内容时用 read_image 读对应文件；确定用不上就别读 —— 读图是要花 token 的。）')
    }
  }
  if (lostImages.length > 0) {
    lines.push(`（有 ${lostImages.length} 张图片没能取到：${lostImages.map((x) => x.reason).join('；')}。）`)
  }
  if (skipped > 0) {
    lines.push(`（另有 ${skipped} 张图片超出本条消息的处理上限，未处理。）`)
  }
  return lines.join('\n')
}
