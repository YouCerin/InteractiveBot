/**
 * 人员名单与权限分级：谁能私聊、哪个群能用、谁能下"动手"的指令。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 需求（用户定的，这是全部依据）
 * ══════════════════════════════════════════════════════════════════════════
 *   · 私聊：白名单制，**从机器人的好友列表里选**。
 *     白名单里的人分两级 —— 管理员（满权限）、用户（**不能触发有实际
 *     修改行为的指令**，例如创建文件夹、删除文件）。
 *   · 群聊：**不再以"用户"权限作为回复条件**，而是另建一张**群白名单**，
 *     从机器人的群列表里选。群里**管理员权限依然生效**：只有管理员
 *     能命令机器人做有实际修改的动作。
 *
 * ── 为什么"从好友/群列表里选"要单独做一次拉取 ────────────────────────────
 * 配置里存的是**号码**。而人不可能记得住每个群号，也会打错。
 * 所以支持从 `get_friend_list` / `get_group_list` 拉一次真实名单，
 * 让配置界面（和排查）能对着**昵称/群名**来选，而不是对着一串数字猜。
 *
 * ── ⚠️ 关于"非管理员不能修改"的**能力边界**（必须如实说明）─────────────
 * 这一层是**提示词层**的限制，不是操作系统的硬墙。
 *
 * 取证：DSH 的 SDK 服务器**只暴露 `initialize` / `session/prompt` / `shutdown`
 * 三个方法**，在它的实现里搜 `sandbox|permissionMode|approval` **零匹配**。
 * 也就是说桥接**无法**按会话切换沙箱模式或回答审批请求。
 * DSH 的沙箱模式（`read-only` / `workspace-write` / `danger-full-access`）
 * 是**整个 DSH 进程一份**，不是每个会话一份。
 *
 * 所以"用户"这一级靠的是**在提示词里明确禁用那几类工具**。
 * 它是"请它不要做"，不是"它做不到"。真实边界是：
 *   · 它**不会**主动去写 —— 因为提示词明确列了禁止清单
 *   · 但它**有能力**写 —— 它本来就有工作区里所有文件的读写权（那是它干活的必要条件）
 * 想变成硬墙，需要在 OS 层隔离（另起一个 read-only 的 DSH 进程）。
 * 那件事的代价写在 PROJECT.json 里，没有做。
 */

/** 三级权限。顺序即高低（用于比较）。 */
export const TIER = {
  /** 管理员：满权限，可以命令机器人做有实际修改的动作。 */
  ADMIN: 'admin',
  /** 用户：能聊天，**不能**触发有实际修改行为的指令。 */
  USER: 'user',
  /** 既不在私聊白名单也不在群白名单里 —— 不回复。 */
  STRANGER: 'stranger',
}

/**
 * 「有实际修改行为」的工具/动作 —— 非管理员一律不许用。
 *
 * ⚠️ 这份清单是**按能力类别**列的（写文件、删文件、建目录、跑命令…），
 * 而不是按工具名硬编码 —— 因为底层工具将来可能改名或合并。
 * `match` 用正则匹配工具名，宁可**多拦**也不要漏放：
 * 漏放一个写操作，使用者以为"用户不能改东西"的承诺就破了。
 */
export const MODIFY_TOOLS = [
  { match: /^write$/i, why: '写文件' },
  { match: /^edit$/i, why: '改文件内容' },
  { match: /str[-_]?replace|replace[-_]?editor/i, why: '改文件内容' },
  { match: /^bash$|^pwsh$|^shell$|^run_code$/i, why: '跑命令（可以间接改任何东西）' },
  { match: /^todo_write$/i, why: '写待办文件' },
  { match: /^present$/i, why: '产出交付物' },
]

/**
 * ══════════════════════════════════════════════════════════════════════════
 * QQ 侧「有实际后果」的动作 —— 非管理员同样不许用
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 这一组是**审查时补上的**，起因是一个真实漏洞：
 *
 *   MCP 那层的黑名单拦的是"**会伤害他人或账号**"的动作（踢人、禁言、改群名…），
 *   而 `qq_poke` / `qq_send_sticker` / `qq_recall` / `qq_api` 这些**不在黑名单里**
 *   —— 它们是正常功能。于是出现了一个绕过：
 *
 *       一个"只读"的普通用户 → 让机器人 `qq_api(send_private_msg, ...)`
 *       → **给任意 QQ 号发消息**；或者让机器人去戳任意人。
 *
 *   也就是说：**文件是只读了，但社交动作没有被限制** —— 那等于"不能用它的
 *   硬盘，却能用它的账号"。对使用者来说这是明显的漏洞（"只读"被理解成
 *   "它不能替我做事"），所以必须一起拦。
 *
 * 判定原则：**凡是会让"别人看到/收到东西"或改变 QQ 侧状态的动作，都算修改类。**
 * 只读类的 QQ 查询（查群成员、查消息详情、读群历史、查好友列表）**保留**，
 * 因为那些"只看不改"，正是使用者希望普通用户还能用的东西。
 */
export const MODIFY_QQ_TOOLS = [
  { match: /^qq_poke$/i, why: '戳一戳（对方会收到提醒）' },
  { match: /^qq_send_sticker$/i, why: '发 QQ 表情' },
  { match: /^qq_recall$/i, why: '撤回消息' },
  // ★ `qq_api` 是"万能口"：它能调任意 OneBot 动作，包括发消息。
  //   留着它就等于上面几条全白拦了，所以**必须一起禁**。
  { match: /^qq_api$/i, why: '直接调 QQ 接口（万能口，能发消息、能撤回）' },
]

/** 只读类 QQ 查询：普通用户**可以**用（只看不改）。 */
export const READONLY_QQ_TOOLS = ['qq_group_members', 'qq_message_detail', 'qq_group_history']

/**
 * 明确允许的只读类工具（给提示词用，让"能做什么"和"不能做什么"都清楚）。
 */
export const READONLY_TOOLS = [
  'read',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'read_image',
  'job_list',
  'job_output',
  'skill',
  'ask_user_question',
  ...READONLY_QQ_TOOLS,
]

/**
 * 判断某个工具是否属于"有实际修改行为"。
 * @returns {{modify: boolean, why?: string, category?: 'file'|'qq'}}
 */
export function classifyTool(name) {
  const n = String(name ?? '')
  for (const rule of MODIFY_TOOLS) {
    if (rule.match.test(n)) return { modify: true, why: rule.why, category: 'file' }
  }
  for (const rule of MODIFY_QQ_TOOLS) {
    if (rule.match.test(n)) return { modify: true, why: rule.why, category: 'qq' }
  }
  return { modify: false }
}

/**
 * 生成"你这个权限能做什么、不能做什么"那段提示词。
 *
 * 为什么**管理员的段落也要写**：明确写出"你有全部权限"能让管理员会话里
 * 的模型不必犹豫（它以前会时不时自我设限）。而普通用户段落要**列出被禁的类别**，
 * 仅说"不能修改"太抽象，模型容易理解成"尽量别改"。
 *
 * @param {'admin'|'user'} tier
 * @param {'private'|'group'} kind
 */
export function buildPermissionInstructions(tier, kind) {
  if (tier === TIER.ADMIN) {
    return [
      '【你的权限：管理员】',
      '对方是管理员，**可以**让你做有实际修改行为的操作（创建/删除文件、改文件内容、跑命令等）。',
      '工作区内的修改都可以做；越出工作区的操作会被系统拒绝，遇到时用你自己的话说一句"这个我暂时没权限"，不要贴系统报错原文。',
    ].join('\n')
  }

  // 两类要分开列：文件类与 QQ 类。合成一句会让使用者以为只有文件受限制，
  // 而"能用它的账号给任意人发消息"才是更容易被忽略、后果更外显的那一类。
  const fileForbidden = [...new Set(MODIFY_TOOLS.map((m) => m.why))]
  const qqForbidden = [...new Set(MODIFY_QQ_TOOLS.map((m) => m.why))]
  return [
    '【你的权限：普通用户（只读）】',
    '对方**不是**管理员。你**只能看、只能聊**，**不能**替 TA 做任何有实际后果的操作。',
    '',
    `**文件方面禁止**：${fileForbidden.join('、')}。`,
    `**QQ 方面禁止**：${qqForbidden.join('、')}。`,
    '（尤其注意：**不要**用任何方式替 TA 给别人发消息、戳别人、发表情 —— ' +
      '那等于用你主人的账号替陌生人做事，绝对不行。）',
    '',
    `你**可以**用这些只读能力：${READONLY_TOOLS.join('、')}。`,
    kind === 'group'
      ? '若对方要求你做这类事，就用你自己的话短说一句做不了（例如「这个我做不了哈」），**不要**解释权限机制、不要报路径、不要说"越界""被拦截"。'
      : '若对方要求你做这类事，就用你自己的话短说一句做不了（例如「这个我做不了哈」），**不要**解释权限系统、不要报路径。真有必要的操作，让 TA 找管理员。',
  ].join('\n')
}

/**
 * 人员名单：把配置里的白名单 + 从协议端拉来的真实名单合起来。
 *
 * @param {object} opts
 * @param {object} opts.config 归一化后的配置
 * @param {(msg: string) => void} [opts.log]
 */
export function createRoster({ config, log = () => {} } = {}) {
  /** 缓存：拉一次就够（好友/群不会频繁变）。`null` = 还没拉过。 */
  let friendsCache = null
  let groupsCache = null

  const groupIds = () =>
    (config?.access?.groupAllowlist ?? []).map(String).filter(Boolean)
  const adminIds = () => (config?.access?.adminUsers ?? []).map(String).filter(Boolean)
  const dmIds = () =>
    (config?.access?.dmAllowlist ?? []).map(String).filter(Boolean)

  /** 这个群在允许列表里吗？ */
  function isGroupAllowed(groupId) {
    return groupIds().includes(String(groupId))
  }

  /**
   * 私聊里这个人是什么级别。
   *
   * ★ `dmAllowlist` 为空时的行为（刻意选择）：**退回"只有管理员能私聊"**。
   *   不退回"谁都能私聊" —— 那是 fail-open，会让一个刚加你好友的陌生人
   *   直接能驱动一个有文件权限的 agent。宁可少回，也不要默默放开。
   */
  function tierOfPrivate(userId) {
    const id = String(userId)
    if (adminIds().includes(id)) return TIER.ADMIN
    const list = dmIds()
    if (list.length === 0) return TIER.STRANGER
    return list.includes(id) ? TIER.USER : TIER.STRANGER
  }

  /**
   * 群里这个人是什么级别。
   *
   * ★ 与私聊**分开**：群白名单管"这个群能不能用"，
   *   而发言人的权限只由 `adminUsers` 决定 —— 群友一律是 USER，
   *   除非他本身就在管理员表里。
   */
  function tierOfGroup(userId) {
    const id = String(userId)
    return adminIds().includes(id) ? TIER.ADMIN : TIER.USER
  }

  /**
   * 综合判定：这条消息该不该回、以什么权限回。
   *
   * @returns {{respond: boolean, tier: string, reason: string}}
   */
  function decide({ kind, peerId, senderId }) {
    if (kind === 'group') {
      if (!isGroupAllowed(peerId)) {
        return { respond: false, tier: TIER.STRANGER, reason: 'group-not-allowed' }
      }
      // 群在白名单里 → 回复；权限看发言人
      return { respond: true, tier: tierOfGroup(senderId), reason: 'group-allowed' }
    }
    const tier = tierOfPrivate(senderId || peerId)
    if (tier === TIER.STRANGER) {
      return { respond: false, tier, reason: dmIds().length === 0 ? 'dm-list-empty' : 'dm-not-allowed' }
    }
    return { respond: true, tier, reason: 'dm-allowed' }
  }

  /**
   * 拉一次真实的好友/群名单（给配置界面用）。
   *
   * 它**不影响回复判定**（判定只认配置里的号码，因为那是确定的），
   * 只用于"让你能对着昵称选人，而不是对着一串数字猜"。
   *
   * @param {(action: string, params?: object) => Promise<any>} call OneBot 调用
   * @param {{refresh?: boolean}} [opts]
   */
  async function fetchLists(call, { refresh = false } = {}) {
    if (!refresh && friendsCache && groupsCache) {
      return { friends: friendsCache, groups: groupsCache, cached: true }
    }
    const pick = (res) => (Array.isArray(res) ? res : (res?.data ?? []))

    let friends = friendsCache ?? []
    let groups = groupsCache ?? []
    const warnings = []

    try {
      const raw = pick(await call('get_friend_list'))
      friends = raw.map((f) => ({
        userId: String(f?.user_id ?? ''),
        nickname: String(f?.nickname ?? f?.remark ?? ''),
      })).filter((f) => f.userId)
      friendsCache = friends
    } catch (error) {
      warnings.push(`拉好友列表失败：${error?.message ?? error}`)
    }

    try {
      const raw = pick(await call('get_group_list'))
      groups = raw.map((g) => ({
        groupId: String(g?.group_id ?? ''),
        name: String(g?.group_name ?? ''),
      })).filter((g) => g.groupId)
      groupsCache = groups
    } catch (error) {
      warnings.push(`拉群列表失败：${error?.message ?? error}`)
    }

    if (warnings.length) log(`[roster] ${warnings.join('；')}`)

    // ⚠️ 只有在**真的拿到了好友列表**时才做"号码在不在名单里"的比对。
    //
    // 否则会出现自相矛盾的结果：拉失败 → friends 为空 → 于是所有号码都被报成
    // "找不到"，而界面会把它读成"**你号码打错了**"，实际原因是**协议端连不上**。
    // 这两种情况的处理方式完全不同，不能混。
    const friendsKnown = friends.length > 0
    const groupsKnown = groups.length > 0

    return {
      friends,
      groups,
      cached: false,
      warnings,
      friendsKnown,
      groupsKnown,
      // 顺带把"配置里的号码在不在真实名单里"标出来 —— 打错号是最常见的配置错误。
      // 名单没拿到时一律给空数组（**不猜**），由 warnings 说明原因。
      unknownAdmins: friendsKnown ? adminIds().filter((id) => !friends.some((f) => f.userId === id)) : [],
      unknownDmUsers: friendsKnown ? dmIds().filter((id) => !friends.some((f) => f.userId === id)) : [],
      unknownGroups: groupsKnown ? groupIds().filter((id) => !groups.some((g) => g.groupId === id)) : [],
    }
  }

  return {
    tierOfPrivate,
    tierOfGroup,
    isGroupAllowed,
    decide,
    fetchLists,
    /** 给测试与排查用：当前配置里都有谁 */
    snapshot: () => ({
      admins: adminIds(),
      dmAllowlist: dmIds(),
      groupAllowlist: groupIds(),
      friends: friendsCache,
      groups: groupsCache,
    }),
  }
}
