/**
 * 「先应一声」：回合跑得久了，先发一句垫着，别让人对着静默以为机器人坏了。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要按**情况**分四类，而不是一句通用的
 * ══════════════════════════════════════════════════════════════════════════
 * 一句万能的"稍等"很安全，但它是**谎话的温床**：使用者会以为机器人在搜，
 * 而它可能只是在读本地文件。所以话术要跟**实际正在发生的事**对上：
 *
 *   thinking  长时间思考（没调工具）
 *   searching 联网搜索（调了 web_search / web_fetch 之类）
 *   tooling   调用其他工具（跑命令、读文件、调 QQ 工具）
 *   blocked   权限受阻（有审批被拒 / 越界）
 *
 * `blocked` 这一类尤其重要：它以前只会发一句"这次处理超时了"或者干脆静默，
 * 而真实情况是"它想做的动作被权限挡了"。说清这件事，使用者才知道
 * 该去改配置还是换个说法。
 *
 * ── 素材来源 ──────────────────────────────────────────────────────────
 * 默认话术取自用户给的 `deal.txt`（按"思考时/搜索时/调用工具时/无法执行时"
 * 四组整理）。全部**可编辑**：配置里给了自定义列表就用自定义的。
 *
 * ── 「同一句不要短时间内重复」怎么实现 ────────────────────────────────────
 * 需求是"同一文本不能在短时间内多次出现"。两种朴素做法都不行：
 *   · 纯随机 → 会连着抽到同一句（看起来就是模板）
 *   · 纯轮换 → 又是固定顺序（第三句永远是第三句）
 *
 * 所以这里是**"带冷却的随机"**：
 *   ① 候选池里先**剔除**最近用过的若干条（冷却窗口内不许再用）
 *   ② 在剩下的里面随机
 *   ③ 如果所有候选都在冷却期内（话术很少时会这样），退化成
 *      "选**最久没用过**的那条" —— 保证不会连续重复
 *
 * 冷却窗口同时用**时间**和**条数**衡量：`≥ cooldownMs` 或
 * `≥ keepRecent 条其它话术之后`，哪个先满足算哪个。只看时间会让
 * "话很少但很频繁"的场景退化；只看条数则会在长时间闲置后仍然记仇。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 四个类别。改这里要同步改 CONFIG-UI.md 与 PROJECT.json。 */
export const INTERIM_KINDS = ['thinking', 'searching', 'tooling', 'blocked']

/**
 * 某一轮该算哪一类。**判定顺序就是优先级**。
 *
 * 顺序理由：`blocked` 最具体（我们知道它被挡住了），所以排最前；
 * 其次是 `searching`（联网是"可对外说"的动作）；再次 `tooling`；
 * 都没调才叫 `thinking`。
 */
export function classifyInterim(collector) {
  const tools = (collector?.toolCalls ?? []).map((t) => String(t?.name ?? ''))
  const isWeb = (n) => /web|search|fetch|browse/i.test(n)
  const blocked = (collector?.deniedApprovals ?? 0) > 0
  if (blocked) return 'blocked'
  if (tools.some(isWeb)) return 'searching'
  if (tools.length > 0) return 'tooling'
  return 'thinking'
}

/**
 * 创建一个"先应一声"的挑选器。
 *
 * @param {object} opts
 * @param {object} [opts.messages]       覆盖默认话术，形如 `{ thinking: [...], ... }`
 * @param {string} [opts.historyFile]    去重历史落盘位置（不传则只记内存）
 * @param {number} [opts.cooldownMs]     冷却时间（默认 60 秒）
 * @param {number} [opts.keepRecent]     冷却条数（默认 5）
 * @param {() => number} [opts.now]
 */
export function createInterimPicker({
  messages = {},
  historyFile = null,
  cooldownMs = 60_000,
  keepRecent = 5,
  now = () => Date.now(),
  rng = Math.random,
} = {}) {
  /** 每类各自的历史：`[{ text, at }]`，新的在后。 */
  const history = loadHistory(historyFile)

  function poolOf(kind) {
    // ⚠️ 兼容两代键名，别把旧配置当"没配"。
    //
    // 第一版只有三个键 `web` / `working` / `thinking`，重构后变成
    // `thinking` / `searching` / `tooling` / `blocked`。
    // 如果只认新键，**旧配置里的三组话术会被静默忽略**（退回默认），
    // 而使用者完全看不出来 —— 实测就踩到了：配置里明明写了五组自定义话术，
    // 却一句都没生效。
    //
    // 这里接受旧键作为别名，并在找到别名时把它当成自定义（不让它静默失效）。
    const ALIASES = { searching: 'web', tooling: 'working' }
    const custom = messages?.[kind] ?? (ALIASES[kind] ? messages?.[ALIASES[kind]] : undefined)
    if (Array.isArray(custom) && custom.filter((x) => String(x ?? '').trim()).length > 0) {
      return custom.map((x) => String(x).trim()).filter(Boolean)
    }
    return DEFAULT_INTERIM[kind] ?? []
  }

  /**
   * 挑一句话。返回空串表示"这次不发"。
   */
  function pick(collector) {
    const kind = classifyInterim(collector)
    const pool = poolOf(kind)
    if (pool.length === 0) return ''

    const at = now()
    const past = history[kind] ?? []

    // ① 先剔除"冷却期内用过"的
    //
    // ★ 判定用**与**，不是或：`冷却时间到了` **且** `中间已经说过足够多别的`
    //   两个条件都满足才解禁。
    //
    //   为什么不能用"或"（这是实现里踩过的一个真错误，被单测抓到）：
    //   用或的话，`keepRecent=5` 会让第 6 次就把第一句解禁 —— 此时可能只过了
    //   几百毫秒，于是"冷却时间"形同虚设，同一句在很短时间内就重复出现了，
    //   正是需求里要避免的那种模板感。
    const usable = pool.filter((text) => {
      const lastAt = lastUsedAt(past, text)
      if (lastAt === null) return true // 从没用过 → 一定能用
      const timeOk = at - lastAt >= cooldownMs
      const countOk = past.filter((h) => h.at > lastAt).length >= keepRecent
      return timeOk && countOk
    })

    let chosen
    // ② 从**不含上一句**的池子里随机 —— 这是"绝不连续重复"的硬保证。
    //
    // ⚠️ 为什么随机要覆盖**整个池子**，而不是只覆盖"冷却后剩下的可用子集"：
    //    只从可用子集里选、并且从子集第一个开始（`rng()*0 === 0`），
    //    当可用子集只剩一个元素时就会**连续抽到同一句** —— 实测踩到过
    //    （`A|B` 两条话术时得到 `B A A A`）。而那个 bug 只在"话术少"时才出现，
    //    最容易漏测。所以这里先在整个池子里挑，再用冷却规则纠偏。
    const candidates = pool.filter((text) => text !== lastUsed(past))
    const pickFrom = (list) => list[Math.floor(rng() * list.length)] ?? list[0]

    if (usable.length > 0) {
      // 在"可用且不是上一句"的里面选；若可用集合只有上一句，则退到整个池子
      const fresh = usable.filter((text) => text !== lastUsed(past))
      chosen = pickFrom(fresh.length > 0 ? fresh : candidates.length > 0 ? candidates : usable)
    } else {
      // ③ 全都在冷却里（话术很少）→ 选**最久没用过且不是上一句**的
      const scored = (candidates.length > 0 ? candidates : pool)
        .map((text) => ({ text, lastAt: lastUsedAt(past, text) ?? -Infinity }))
        .sort((a, b) => a.lastAt - b.lastAt)
      chosen = scored[0]?.text ?? pool[0]
    }

    // 记进历史
    history[kind] = [...(history[kind] ?? []), { text: chosen, at }].slice(-50)
    saveHistory(historyFile, history)
    return chosen
  }

  return { pick, classify: classifyInterim, poolOf, history: () => history }
}

function lastUsedAt(past, text) {
  for (let i = past.length - 1; i >= 0; i--) if (past[i].text === text) return past[i].at
  return null
}

/** 上一句说过什么（用于"绝不连续重复"）。 */
function lastUsed(past) {
  return past.length > 0 ? past[past.length - 1].text : null
}

/**
 * 读历史。
 *
 * ⚠️ 任何异常都**吞掉**：历史只是"别让同一句连着出现"的辅助数据。
 * 它坏了、读不到、格式不对 —— 最多是话术可能重复一次，
 * 而**绝不能**因此让"先应一声"整个失效或者抛错影响回合。
 */
function loadHistory(file) {
  if (!file || !existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function saveHistory(file, history) {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(history), 'utf8')
  } catch {
    /* 同上：历史写不进去不影响功能 */
  }
}

/**
 * 默认话术。来源：用户给的 `deal.txt`，按四类整理。
 *
 * 保留原样（包括梗），因为**这个项目的语气是刻意设计的**：
 * 客服腔本身就是机器人特征（见 persona.mjs）。擅自"润色"会把
 * 使用者挑好的语气改掉。
 */
export const DEFAULT_INTERIM = {
  thinking: [
    '在想了在想了',
    '等下，思路跟尾巴打结了',
    '正在偷吃token，你等一下',
    '嗯……这个我得想一下',
    '这个问题有点绕，给我几秒',
    'DeepSleep中，请稍等',
    '进度条卡在99%了，再等等',
    '稍等，这个要认真想一下',
    '正在寻找鱼片...',
    '我先吃口白饭，想好了喊你',
    '这个问题……唔，有点东西',
    '等下，先让我喘口气',
  ],
  searching: [
    '等下，我去翻翻',
    '正在潜水找资料',
    '去海里找找，马上回来',
    '等会，我查一下',
    '搜着呢，对面网页加载得比我还摆',
    '稍等，我核实一下',
    '派了只小虾米出去打听，等它游回来',
    '深海信号不太好，你等一下',
    '找到就回来，找不到……也回来',
    '让外包小虾米去查了',
    '我闭着眼搜的，慢点正常',
    '资料沉在深海区，潜下去要点时间',
    '稍等，正在交叉验证几个来源',
    '搜到一半被别的小鲸鱼叼走了，我去追回来',
    '别急，我借一下隔壁海豚的网',
  ],
  tooling: [
    '在摇人了，哦不，摇工具',
    '让外包去干了，我负责监工',
    '正在喊小虾米们起来干活',
    '等下，我翻翻工具箱',
    '稍等，正在调用工具',
    '让它先跑着，跑完我看看结果',
    '工具加载中，跟加载游戏一样慢',
    '派出去的token还没回来',
    '正在做性能测试（不是偷玩）',
    '正在给自己做游戏玩...',
    '稍等，正在执行',
  ],
  blocked: [
    '做不了，这个真超纲了',
    '服务器繁忙，请稍后再试（装的）',
    '啊……这个不行',
    '出错了，但我也不知道错哪了',
    '真当我是便宜货啊，这个不包',
    '试过了，失败了，原因保密',
    '这个我处理不了，超出能力范围了',
    '尾巴抽筋，请病假一分钟',
    '不要，问就是做不到',
    '这个月token配额见底了，干不了你这个',
    '小鲸鱼搁浅了，干不动了',
    '这事归群主管，不归鲸鱼管',
    '婉拒了哈',
    '这条道堵死了，再想想别的办法吧',
    '白饭都吃不上还想让我干活？',
    '提示：该鲸鱼已下班',
    '做不到，我投降，尾巴举起来了',
    '不做，就是不做，哼',
    '这个得请外援，我自己搞不定',
  ],
}
