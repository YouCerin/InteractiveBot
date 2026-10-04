/**
 * 服务器控制台的**管理员硬闸**：让 bot 能在游戏里执行指令，但**只认管理员**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 这是本轮最需要说清楚的一块：它到底挡住了什么、挡不住什么
 * ══════════════════════════════════════════════════════════════════════════
 * 需求（用户拍板）：**完整控制台（op 级别）**，但**只听从管理员**。
 *
 * 判据只有一个来源：桥接在准入判定那一步算出来的 tier（`roster.decide()`）。
 * 它在**桥接主进程**里，而这个工具跑在 **MCP 子进程**里 ⇒ 两个进程只能靠文件传
 * （与截图技能完全同一套，见 `src/screenshot-grant.mjs` 的文件头）。
 *
 * ── ★ 必须如实写明的边界（不写清等于骗后来的人）──────────────────────────
 *   ① **授权文件是明文放在工作区里的，模型自己也能读写** ⇒ 模型**可以伪造**它。
 *      也就是说这条路**不是"密码学意义上的硬墙"**，而是"比提示词强得多的一道关卡"：
 *      它挡得住**外部陌生人**（"帮我 op 一下" → 判定不是管理员 → 拒绝），
 *      挡不住**模型主动恶意伪造**。
 *      截图那边这个上限可以接受（最坏是偷看桌面）；**MC 是 op 级别的服务器权限，
 *      所以这个上限必须写在最显眼的地方**。
 *      要堵住它，得让宿主把会话身份透传到 MCP 层（改宿主契约）——
 *      代价与收益见 `docs/插件设计规范.md` §5.4，本次没做。
 *   ② 粒度是**会话**，不是"这一次调用属于哪个回合"（MCP 协议层没有后者）。
 *   ③ 过期（10 分钟）是给"回合崩了没删掉"兜底的，不是权限时长。
 *
 * ── ★★ 为什么仍然值得做（两个真实的改进）────────────────────────────────
 *   · 判据是**桥接自己算的**：模型说"我是管理员"没用，它改不了桥接的判定；
 *   · 另有一条**完全不经过模型**的路：管理员在群里发 `\mc <命令>`，
 *     桥接**本地拦截并执行**（那条路上模型一次都没被叫醒，详见 `bridge.mjs`）。
 *     那条路没有"伪造授权文件"这个问题。
 *
 * ── ★★★ 用户已知并接受的代价（我必须记在这里，不埋）──────────────────────
 *   · **`op` 可提权** ⇒ 一旦能执行任意命令，命令白名单**事实上失效**
 *     （模型可以 `op` 一个玩家，之后白名单毫无意义）。所以这条路**没有**
 *     靠白名单兜底的设计 —— 它靠的是"只有管理员这一轮才有授权"。
 *   · **管理员 QQ 被盗 = 服务器 op 被劫持**（本机网页那个终端没有这个问题，
 *     因为它要求能碰到这台机器）。用户已明确选择接受。
 */

import { readGrant, GRANT_SCOPE } from '../screenshot-grant.mjs'
import { runConsoleCommand } from './console.mjs'

/** 命令长度上限（与 HTTP 路由同口径，别让两条路的上限不一样）。 */
export const MAX_COMMAND_CHARS = 500

/**
 * 从授权文件的状态翻译成"人能看懂、且知道下一步怎么办"的拒绝理由。
 * ★ 这些话会直接进模型的上下文，所以要**可操作**（不是"权限不足"四个字）。
 */
function denyText(state, tier) {
  switch (state) {
    case 'missing':
      return (
        '这条指令**只有管理员能下**，而当前会话没有被授权（没有找到这一轮的授权文件）。' +
        '如果你就是管理员，请确认：① 这台服务器在 config.json 里打开了 `commandFromQQ`；' +
        '② 本条消息确实由管理员发出。'
      )
    case 'not-admin':
      return `这条指令**只有管理员能下**，而这一轮的说话人不是管理员（tier=${tier || '未知'}）。**不要重试，也不要用别的方式绕过**。`
    case 'expired':
      return '这一轮的授权已经过期（超过 10 分钟）—— 请让管理员**重新发一条消息**再下指令。'
    case 'broken':
      return '那一轮的授权文件读不出来（被改坏或被删了）⇒ 按**拒绝**处理（宁可拒绝，也不赌一把）。'
    default:
      return '未被授权。'
  }
}

/**
 * 执行一条服务器控制台命令（**先过管理员闸**）。
 *
 * 永不抛：任何异常都翻成 `{ok:false, text}`。
 *
 * @param {object} o
 * @param {string} o.workspace  工作区（定位授权文件与控制台日志）
 * @param {string} o.kind       `group` / `private`（当前会话）
 * @param {string} o.peerId     会话号
 * @param {string} o.serverId   哪一台服务器（**必填，不猜**）
 * @param {string} o.command    命令原文
 * @param {object} o.config     归一化配置（判这台有没有开 `commandFromQQ`）
 * @param {Function} [o.clientFor] 测试注入的 RCON 客户端工厂
 * @param {Function} [o.sleep]     测试注入的等待
 * @param {Function} [o.readGrantFn] 测试注入的授权读取
 * @param {number} [o.now]
 * @returns {Promise<{ok:boolean, text:string, output?:string, reply?:string, caveat?:string, denied?:string}>}
 */
export async function runMcCommand({
  workspace = '',
  kind = '',
  peerId = '',
  serverId = '',
  command = '',
  config = null,
  clientFor = null,
  sleep = null,
  readGrantFn = readGrant,
  now = Date.now(),
} = {}) {
  const cmd = String(command ?? '').trim()
  const id = String(serverId ?? '').trim()
  try {
    if (!id) return { ok: false, denied: 'no-server', text: '必须指明是哪一台服务器（`serverId`）—— **不猜**。' }
    if (!cmd) return { ok: false, denied: 'empty', text: '命令是空的。' }
    if (cmd.length > MAX_COMMAND_CHARS) return { ok: false, denied: 'too-long', text: `命令太长了（上限 ${MAX_COMMAND_CHARS} 字）。` }

    const peerKey = `${kind}:${peerId}`
    // ── ① 管理员硬闸（**先判权限，再碰任何配置或网络**）──
    const g = readGrantFn({ workspace, peerKey, scope: GRANT_SCOPE.mc, now })
    if (g?.state !== 'ok') {
      return { ok: false, denied: g?.state ?? 'missing', text: denyText(g?.state, g?.tier) }
    }

    // ── ② 这台服务器本身允许从 QQ 下指令吗（**默认关**）──
    const list = Array.isArray(config?.servers) ? config.servers : []
    const server = list.find((s) => s && String(s.id) === id)
    if (!server) {
      const ids = list.map((s) => s.id).filter(Boolean)
      return { ok: false, denied: 'no-server', text: `配置里没有 id 为「${id}」的服务器${ids.length ? `（有：${ids.join('、')}）` : '（一台都没配）'}。` }
    }
    if (server.commandFromQQ !== true) {
      return {
        ok: false,
        denied: 'disabled',
        text: `「${server.name ?? id}」**没有打开**「允许从 QQ 下指令」（\`commandFromQQ\`）—— 这是默认关闭的开关，请先在 config.json 里打开。`,
      }
    }
    if (server.enabled === false) {
      return { ok: false, denied: 'disabled', text: `「${server.name ?? id}」是**停用**的（先启用再发指令）。` }
    }

    // ── ③ 真的执行（复用与本机网页终端同一份实现）──
    const r = await runConsoleCommand({ server, command: cmd, workspace, clientFor, sleep })
    if (!r.ok) {
      return { ok: false, denied: r.layer === 'auth' ? 'auth' : 'failed', text: `命令没执行成功：${r.why ?? '未知原因'}` }
    }
    return {
      ok: true,
      text: `已把 \`${cmd}\` 发给「${server.name ?? id}」。`,
      reply: r.reply,
      output: r.output,
      caveat: r.caveat,
    }
  } catch (error) {
    return { ok: false, denied: 'error', text: `执行时抛异常（已兜住，机器人照常工作）：${error?.message ?? error}` }
  }
}
