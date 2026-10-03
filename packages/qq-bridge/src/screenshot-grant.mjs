/**
 * 会话授权：把「这一轮是谁在说话、他是不是管理员」这件事**交给技能进程**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个文件（这是本次截图功能的**安全核心**，不是辅助件）
 * ══════════════════════════════════════════════════════════════════════════
 * 需求原话：「群聊可以用，但是**任何情况下只有管理员**才能下达截图指令」。
 *
 * 但 MCP 的 `tools/call` 上**没有调用者身份**（`docs/插件设计规范.md` §5.4 已写明），
 * 也就是说技能工具里的 `permission: "write"` 只是"请模型不要做"，
 * 群里一个陌生人说"帮我截个屏"，模型完全可能照做 —— 那是把整台电脑的屏幕
 * 交出去。所以必须有一个**模型改不了**的依据。
 *
 * 可信依据只有一处：桥接在准入判定那一步算出来的 tier（`roster.decide()`）。
 * 它在**桥接主进程**里，而工具跑在**MCP 子进程**里 —— 两个进程，只能靠文件传。
 *
 * 传法：每一轮**真跑模型之前**写一个授权文件，回合结束删掉。
 *
 *     <workspace>/screenshots/.grants/<peerKey 的 SHA1 前 16 位>.json
 *     { kind, peerId, senderId, tier: 'admin'|'user', at, exp }
 *
 * 技能侧读它（`skills/screenshot/index.js` 的 `readGrant`），**没有文件就拒绝**。
 *
 * ── 边界，如实写清（不写清等于骗后来的人）────────────────────────────────
 *   ① 粒度是**会话**（`kind:peerId`），不是"这一次调用属于哪个回合" ——
 *      MCP 协议层根本没有后者。所以"同一会话里另一个并发回合"在有效期内也算数。
 *   ② 文件是**明文**放在工作区里的。模型自己也能读写工作区 ——
 *      也就是说**模型可以伪造或删掉这个文件**。这是这条路的真实上限：
 *      它挡住的是"外部陌生人一句话就偷看桌面"，挡不住"模型主动恶意伪造"。
 *      要堵住后者，得让宿主把会话身份透传到 MCP 层（改宿主契约），代价与收益
 *      写在 `docs/插件设计规范.md` 里，这次没做。
 *   ③ 过期时间（10 分钟）是给"回合崩了没删掉"兜底的，不是权限时长。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { normalizeConfig } from './config.mjs'
import { TIER } from './roster.mjs'

/** 与技能侧 `skills/screenshot/index.js` 保持逐字一致的三处常量。 */
export const SHOTS_DIR = 'screenshots'
export const GRANTS_DIR = '.grants'
export const GRANT_TTL_MS = 10 * 60_000

/**
 * 会话键 → 授权文件名。
 *
 * ⚠️ **这个函数在技能侧有一份逐字对应的实现**（技能不能 import 宿主的 `src/`）。
 * 两份不一致的症状是"管理员明明有权限，截图却总说没有授权" —— 很安静的一种坏。
 * `mocks/verify-screenshot.mjs` 里有断言盯着两份实现给出同样的结果。
 */
export function grantFileName(peerKey) {
  const h = crypto.createHash('sha1').update(String(peerKey ?? '')).digest('hex')
  return `${h.slice(0, 16)}.json`
}

/** 授权目录（工作区里）。 */
export function grantsDir(workspace) {
  const ws = String(workspace ?? '').trim()
  if (!ws) return ''
  return path.join(ws, SHOTS_DIR, GRANTS_DIR)
}

/**
 * 这一轮要不要写授权？
 *
 * 口径：**只要不是"明确关着"，就写**（fail-closed 的方向是"权限可能被误拒"，
 * 而不是"把屏幕交出去"）。所以这里**不去读技能清单**（那要多一次 IO、
 * 而且清单默认值随时会被技能目录的版本改），只看配置里的两个开关：
 *   · `config.skills.screenshot.enabled === false` → 不写（技能关着，写了也没用）
 *   · `requireAdmin === false` → 不写（用户明确关掉了管理员限制）
 * 其余情况一律写。
 */
export function shouldWriteGrant(config) {
  const s = config?.skills?.screenshot
  if (!s || typeof s !== 'object') return false
  if (s.enabled === false) return false
  if (s.requireAdmin === false) return false
  return true
}

/**
 * 写这一轮的授权。
 *
 * **绝不抛异常**：授权写不上只该让截图功能用不了，不该影响任何一轮对话。
 * 所以所有失败都吞掉并返回 `{ok:false, why}` 供调用方记日志。
 *
 * @param {object} o
 *   workspace 工作区（`config.dsh.workspace`）
 *   peerKey   `kind:peerId`（与技能侧 `ctx.peerKey` 同一形状）
 *   kind/peerId/senderId  这一轮的事实
 *   tier      `roster.decide()` 给的 tier（`admin` / `user` / `stranger`）
 *   config    归一化配置（用来判 shouldWriteGrant）
 *   now       测试注入点
 * @returns {{ok:boolean, file?:string, why?:string}}
 */
export function writeGrant({ workspace, peerKey, kind, peerId, senderId, tier, config, now = Date.now() } = {}) {
  try {
    if (!workspace) return { ok: false, why: '没有工作区路径' }
    if (!peerKey) return { ok: false, why: '没有会话键' }
    if (!shouldWriteGrant(config)) return { ok: false, why: '截图技能没开 / 已明确关掉管理员限制' }
    const dir = grantsDir(workspace)
    if (!dir) return { ok: false, why: '工作区路径不可用' }
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, grantFileName(peerKey))
    const body = JSON.stringify({
      kind: String(kind ?? ''),
      peerId: String(peerId ?? ''),
      senderId: String(senderId ?? ''),
      tier: String(tier ?? ''),
      at: Number(now),
      exp: Number(now) + GRANT_TTL_MS,
    })
    fs.writeFileSync(file, body, 'utf8')
    return { ok: true, file }
  } catch (error) {
    return { ok: false, why: error?.message ?? String(error) }
  }
}

/**
 * 回合结束清掉这一个会话的授权。
 *
 * ⚠️ **只删自己写过的那一个文件**（按 peerKey 算出来的名字），
 * 不做"清空目录" —— 多会话并发时清空会把**别的会话正在用的授权**删掉，
 * 症状是"隔壁群的管理员截图忽然说没权限"（而且极难复现）。
 */
export function clearGrant({ workspace, peerKey } = {}) {
  try {
    if (!workspace || !peerKey) return { ok: false, why: '缺参数' }
    const dir = grantsDir(workspace)
    if (!dir) return { ok: false, why: '工作区路径不可用' }
    fs.rmSync(path.join(dir, grantFileName(peerKey)), { force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, why: error?.message ?? String(error) }
  }
}

/**
 * 测试/排障用：清掉所有授权文件（**产品代码不要调用** —— 见 clearGrant 的警告）。
 */
export function clearAllGrants({ workspace } = {}) {
  const dir = grantsDir(workspace)
  if (!dir) return { ok: false, why: '工作区路径不可用' }
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return { ok: true, removed: 0 }
  }
  let removed = 0
  for (const n of names) {
    try {
      fs.rmSync(path.join(dir, n), { force: true })
      removed += 1
    } catch {
      /* 删不掉的下次再说 */
    }
  }
  return { ok: true, removed }
}

/**
 * 兜底：从**配置**直接判一个人是不是管理员。
 *
 * 为什么要它：授权文件那条路依赖"回合开始时写成功"。如果写失败（磁盘满、权限），
 * 就会出现"管理员也不能截图"——**功能静默失效**。这一条是纯配置读，
 * 不依赖任何时序，用来兜住那种情况。
 *
 * ⚠️ 它**单独不构成**权限依据（`tier` 是权威），只在"授权文件缺失/过期"时用作
 * 兜底，并且要求 `senderId` 真的在 `config.access.adminUsers` 里。
 * 归属仍按 `kind:peerId` —— 也就是说"管理员的**私聊**"与"管理员**在群里说话**"
 * 都算，而"管理员的私聊"这一条本身就意味着对方是管理员本人（私聊的 peerId = 他的号）。
 */
export function isAdminByConfig({ config, kind, peerId, senderId } = {}) {
  try {
    const c = normalizeConfig(config ?? {})
    const admins = new Set((c?.access?.adminUsers ?? []).map((x) => String(x)))
    if (admins.size === 0) return false
    const k = String(kind ?? '')
    // 私聊：peerId 就是对方本人；群聊：必须显式给出 senderId（缺了就不判，fail-closed）
    const id = k === 'private' ? String(peerId ?? '') : (k === 'group' ? String(senderId ?? '') : '')
    return id !== '' && admins.has(id)
  } catch {
    return false
  }
}

export const internals = { TIER }
