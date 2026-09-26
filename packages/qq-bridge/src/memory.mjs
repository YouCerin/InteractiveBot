/**
 * 跨重启记忆：**让 agent 自己记笔记**（两层：全局 + 按人/按群）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么不能指望 DSH 的会话历史
 * ══════════════════════════════════════════════════════════════════════════
 * 实测发现的硬限制（详见 session-id.mjs）：DSH 的 SDK 在进程重启后
 * **不允许复用已存在的 sessionId**，而它又没有暴露 resume。所以重启之后
 * DSH 侧一定失忆 —— 这不是 bug，是那条路径的能力边界。
 *
 * ── 关键洞察 ───────────────────────────────────────────────────────────
 * **工作区是持久的，而 agent 本来就有读写文件的工具。**
 *
 * 所以这里不做"桥接替 agent 存记忆"那套（要自己写截断、排序、限额、
 * 注入预算……），而是**给 agent 一个记笔记的约定，让它用自己的工具维护**。
 *
 *   重启后 → 新会话 → 提示词里写"先读你的笔记" → 它自己读回来 → 记忆接上了
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ 为什么必须"按人分开"（改之前务必读完）
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版是**一份全局笔记**（所有会话共用 `MEMORY.md`）。那在"只有一个管理员、
 * 群聊关闭"时恰好等于个人记忆，看不出问题。
 *
 * 但只要多一个人说话就会出事：
 *   · A 在私聊里说的偏好 → **B 在群里问同样的事，机器人按 A 的偏好回答**
 *   · 群友的信息被记进笔记 → 在**别人的私聊**里体现出来
 *   · 极端情况：把某个人的隐私答给了另一个人
 *
 * 所以现在是**两层**，并且**每一轮只把当前会话该用的路径告诉 agent**：
 *
 *   `MEMORY.md`                        ← 全局（私聊会话可见；**群聊不可见**）
 *   `memory/private-<QQ号>.md`         ← 某人的私聊记忆
 *   `memory/group-<群号>.md`           ← 某群的记忆
 *
 * ── 为什么用 QQ 号当文件名，而不是哈希 ────────────────────────────────
 * 那是**工作区里的文件名**，工作区本来就是 agent 的私有目录、不外发。
 * 用明文号码的好处很实在：**你在记忆页签里一眼就知道哪份是谁的**，
 * 而哈希会让这个功能变得不可用（一堆 `a3f9…md` 谁也认不出）。
 * （`session-id.mjs` 里对 sessionId 用了哈希 —— 那个**会进 DSH 的日志**，
 *   所以两处的取舍不同，不是前后矛盾。）
 *
 * ── 成本控制（这一节很重要，"越聊越贵"就藏在这里）─────────────────────
 * 记忆功能有两个花钱的地方，必须都压住：
 *
 *   ① **指令本身的固定开销**：这段文字每轮都进提示词。所以它必须短。
 *      （测试里有长度上限断言，就是为了防止它慢慢膨胀。）
 *
 *   ② **agent 真的去读/写文件**：每读一次都是一个工具调用 + 一轮往返，
 *      而且读进来的内容会留在会话历史里，**后续每一轮都要重复计费**。
 *      所以措辞必须明确"**只在需要时读一次、不要每轮都读**"。
 *      第一版写的是"会话开始时先读"，太容易被理解成每轮都读 —— 必须改。
 *
 * 设计目标：**读得少、写得少、但该记住的真记住，且不串人。**
 */

import { join } from 'node:path'

/** 记忆文件的相对路径约定（相对工作区）。 */
export const MEMORY_PATHS = {
  /** 全局索引：私聊会话用；**群聊不给**。 */
  index: 'MEMORY.md',
  /** 细节目录：按人/按群分文件。 */
  detailDir: 'memory',
}

/**
 * 共用规则。抽出来是为了让各个分支的措辞**必然一致**，不会各自漂移。
 */
const MEMORY_RULES = [
  '规则（都为了省时间与成本）：',
  '1. **不要每轮都读**。只在"确实需要回忆、而当前对话里没有"时读一次；细节按需再读。',
  '2. **不要每轮都写**。只在出现真正值得长期记住的事（偏好、正在做的项目、约定、纠正过你的地方）时才更新。',
  '3. 记忆文件保持**短**；发现它在变长就自己合并、删掉过时的。宁可少记，也不要写成流水账。',
]

/** 某一类会话在 `memory/` 下的文件名。 */
export function memoryFileName(kind, peerId) {
  const id = String(peerId ?? '').trim()
  if (!id) return null
  return kind === 'group' ? `group-${id}.md` : `private-${id}.md`
}

/**
 * 算出某个会话该用哪两个记忆路径。
 *
 * @param {object} opts
 * @param {string} opts.workspace   工作区（记忆的根）
 * @param {'private'|'group'} opts.kind
 * @param {string|number} opts.peerId  对方 QQ 号，或群号
 * @returns {{scopeFile: string|null, globalFile: string|null, isGroup: boolean}}
 *   `scopeFile` 是**这个人/这个群**那份；`globalFile` 只有私聊才有
 *   （群聊**不给**全局文件 —— 群里的人不该看到别处积累的笔记）。
 */
export function resolveMemoryScope({ workspace, kind, peerId }) {
  const root = String(workspace ?? '')
  const name = memoryFileName(kind, peerId)
  const isGroup = kind === 'group'
  if (!root || !name) return { scopeFile: null, globalFile: null, isGroup }
  return {
    scopeFile: join(root, MEMORY_PATHS.detailDir, name),
    // 群聊没有全局文件：群里的对话不该读到私聊积累的全局笔记
    globalFile: isGroup ? null : join(root, MEMORY_PATHS.index),
    isGroup,
  }
}

/**
 * 构造"记忆约定"那段提示词。
 *
 * @param {{ workspace: string, kind?: 'private'|'group', peerId?: string|number }} opts
 * @returns {string}
 */
export function buildMemoryInstructions({ workspace, kind, peerId }) {
  const root = String(workspace ?? '')
  const dir = join(root, MEMORY_PATHS.detailDir)
  const { scopeFile, globalFile, isGroup } = resolveMemoryScope({ workspace, kind, peerId })

  // 拿不到会话身份时（例如调用方只传了 workspace）退化成"只给全局"，
  // 并**明确说这是全局** —— 避免悄悄退化成"没有隔离"而无人察觉。
  if (!scopeFile) {
    return [
      '【长期记忆】',
      '你不记得上一次对话（每次开机都是新会话），但工作区是持久的，记忆靠你自己维护的文件：',
      `  全局记忆 ${join(root, MEMORY_PATHS.index)}；细节在 ${dir}/ 下按主题分文件。`,
      '（注意：这次没拿到会话身份，所以这里是全局记忆 —— 不要把某个人的私事写进来。）',
      ...MEMORY_RULES,
    ].join('\n')
  }

  const lines = [
    '【长期记忆】',
    '你不记得上一次对话（每次开机都是新会话），但工作区是持久的，记忆靠你自己维护的文件。',
  ]

  if (isGroup) {
    lines.push(`**这个群的记忆（只写这里）：${scopeFile}**`)
    lines.push(`（其他细碎记忆放 ${dir}/ 下，按主题分文件。）`)
    // ⚠️ 这里**刻意不写出全局记忆的文件名**。
    //    写了就自相矛盾：一边说"别读它"，一边把名字告诉了模型。
    //    不给名字，模型就没有去读的入口。
    lines.push(
      '⚠️ **这个群之外还有别处的记忆，那不是给你看的** —— ' +
        '群里的事只写在这个群的文件里，不要去翻别的地方。',
    )
  } else {
    lines.push(`**这个人的记忆（主要写这里）：${scopeFile}**`)
    lines.push(`全局记忆（跨人的约定、你自己的事）：${globalFile}`)
    lines.push(`（其他细碎记忆放 ${dir}/ 下，按主题分文件。）`)
    lines.push('⚠️ **不要把某个人的私事写进全局记忆** —— 全局是跨会话共享的，别人会看到。')
    // ★ 一次性迁移指引。
    //
    // 背景：早期版本**只有**一份全局记忆，所以那时候记下来的东西（包括某个人的
    // 偏好、某个项目）全都躺在全局文件里。改成按人分开之后，新会话只看自己那份 → 
    // 会以为"我什么都不记得"。这里让 agent **顺手**把属于本人的条目搬过去，
    // 而不是由桥接做一次批量迁移（那要解析自然语言、且有搬错的风险）。
    lines.push(
      `📌 如果 ${scopeFile} 还不存在：先看一眼全局记忆里有没有**属于这个人**的条目，` +
        '有就搬进这个文件（并从全局删掉），没有就新建一个空的。这样旧记忆不会丢。',
    )
  }

  lines.push(...MEMORY_RULES)
  return lines.join('\n')
}
