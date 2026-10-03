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
 * 授权**分域**（0.3.2 收尾加的第二个域：服务器控制台）。
 *
 * ★★ 为什么必须分域，而不是共用一份：两个域的开关注解**不同** ——
 *   截图那边看 `skills.screenshot.enabled`（技能关着就不用写），
 *   服务器控制台看 `servers[].commandFromQQ`（默认关）。共用一份的话，
 *   写截图的授权会**顺带**给 MC 开权限（反过来也一样）——
 *   那正是"一个开关悄悄影响另一个能力"这类最难查的越权。
 * ★ `''` 这个值刻意从缺省值改成 `'screenshot'`：**老的调用点一个字都不用改**，
 *   而且老的文件名逐字不变（`grantFileName` 对 screenshot 域不加前缀）。
 */
export const GRANT_SCOPE = { screenshot: 'screenshot', mc: 'mc' }

/**
 * 会话键 → 授权文件名。
 *
 * ⚠️ **这个函数在技能侧有一份逐字对应的实现**（技能不能 import 宿主的 `src/`）。
 * 两份不一致的症状是"管理员明明有权限，截图却总说没有授权" —— 很安静的一种坏。
 * `mocks/verify-screenshot.mjs` 里有断言盯着两份实现给出同样的结果。
 *
 * ★ 分域之后：截图域**保持原样**（技能侧那份实现因此仍然逐字正确）；
 *   MC 域加一个 `mc-` 前缀 ⇒ 两个域的文件永不互相覆盖。
 */
export function grantFileName(peerKey, scope = GRANT_SCOPE.screenshot) {
  const h = crypto.createHash('sha1').update(String(peerKey ?? '')).digest('hex')
  const prefix = scope === GRANT_SCOPE.mc ? 'mc-' : ''
  return `${prefix}${h.slice(0, 16)}.json`
}

/** 授权目录（工作区里）。 */
/**
 * 授权目录（工作区里）—— **按域分开两个目录**。
 *
 * ★ 截图域保持 `<ws>/screenshots/.grants`（技能侧有一份逐字对应的实现，不能动）。
 * ★ MC 域放 `<ws>/.grants/mc` —— 它不该住在 `screenshots/` 里面：那样排查时
 *   会让人以为"服务器控制台的授权"是截图功能的一部分。
 */
export function grantsDir(workspace, scope = GRANT_SCOPE.screenshot) {
  const ws = String(workspace ?? '').trim()
  if (!ws) return ''
  if (scope === GRANT_SCOPE.mc) return path.join(ws, GRANTS_DIR, 'mc')
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
 * 这一轮要不要写**服务器控制台**的授权？
 *
 * ★★ 默认**不写**（`servers[].commandFromQQ` 默认 false），与截图那边的方向**相反**。
 *   为什么方向相反：截图是"看一眼"，MC 控制台是 **op 级别的服务器权限** ——
 *   按本项目"危险的能力默认关"的口径，这个必须显式打开。
 *
 * ★ 条件：**至少有一台服务器显式开了 `commandFromQQ`**，且当前说话人是管理员。
 *   一台都没开 ⇒ 不写文件（于是工具侧 fail-closed 拒绝，也不会在工作区里留垃圾）。
 */
export function shouldWriteMcGrant(config, tier) {
  // ⚠️ 枚举是 `TIER.ADMIN`（大写）—— 这里第一版写成 `TIER.admin`，恒等于 `undefined`，
  //    后果是**管理员永远拿不到 MC 授权**（而测试里同样写错，两边一起错 ⇒ 差点漏过）。
  //    教训：用枚举就别用字面量，写错了才有机会被"与字面量比对"的断言抓住。
  if (String(tier ?? '') !== TIER.ADMIN) return false
  const list = Array.isArray(config?.servers) ? config.servers : []
  return list.some((s) => s && s.commandFromQQ === true)
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
 *   scope     `'screenshot'`（默认）或 `'mc'`
 *   now       测试注入点
 * @returns {{ok:boolean, file?:string, why?:string}}
 */
export function writeGrant({ workspace, peerKey, kind, peerId, senderId, tier, config, scope = GRANT_SCOPE.screenshot, now = Date.now() } = {}) {
  try {
    if (!workspace) return { ok: false, why: '没有工作区路径' }
    if (!peerKey) return { ok: false, why: '没有会话键' }
    const want = scope === GRANT_SCOPE.mc ? shouldWriteMcGrant(config, tier) : shouldWriteGrant(config)
    if (!want) {
      return { ok: false, why: scope === GRANT_SCOPE.mc ? '没有任何服务器打开 commandFromQQ / 说话人不是管理员' : '截图技能没开 / 已明确关掉管理员限制' }
    }
    const dir = grantsDir(workspace, scope)
    if (!dir) return { ok: false, why: '工作区路径不可用' }
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, grantFileName(peerKey, scope))
    const body = JSON.stringify({
      kind: String(kind ?? ''),
      peerId: String(peerId ?? ''),
      senderId: String(senderId ?? ''),
      tier: String(tier ?? ''),
      scope: String(scope ?? GRANT_SCOPE.screenshot),
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
 * **读**这一轮的授权（工具侧用；`skills/screenshot` 里有一份对应的实现）。
 *
 * ★★ 为什么宿主要导出这个（自用）：MC 控制台的 MCP 工具跑在**子进程**里，
 *   而它需要判断"当前会话的说话人是不是管理员"。判据只能来自这里 ——
 *   桥接进程里那份 `roster.decide()` 的结论。
 *
 * ★ 状态码与技能侧一致（`ok` / `missing` / `not-admin` / `expired` / `broken`），
 *   且**一律 fail-closed**：只有 `ok` 才放行，其余全部拒绝。
 *
 * @returns {{state:'ok'|'missing'|'not-admin'|'expired'|'broken', tier?:string, senderId?:string, why?:string}}
 */
export function readGrant({ workspace, peerKey, scope = GRANT_SCOPE.screenshot, now = Date.now() } = {}) {
  try {
    if (!workspace || !peerKey) return { state: 'missing', why: '缺参数' }
    const dir = grantsDir(workspace, scope)
    if (!dir) return { state: 'missing', why: '工作区路径不可用' }
    const file = path.join(dir, grantFileName(peerKey, scope))
    if (!fs.existsSync(file)) return { state: 'missing', why: '这一轮没有授权文件' }
    let raw = fs.readFileSync(file, 'utf8')
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    const g = JSON.parse(raw)
    // ★ 域要核对：MC 的工具**不许**接受一份截图域的授权（反之亦然）——
    //   否则"截图开着的会话"会顺带给 MC 权限。
    if (String(g?.scope ?? GRANT_SCOPE.screenshot) !== scope) {
      return { state: 'missing', why: `授权文件是「${g?.scope ?? 'screenshot'}」域的，不是这个域的` }
    }
    if (!Number.isFinite(Number(g.exp)) || Number(g.exp) <= Number(now)) return { state: 'expired', why: '授权已过期' }
    if (String(g.tier ?? '') !== TIER.ADMIN) return { state: 'not-admin', tier: String(g.tier ?? ''), why: '这一轮的说话人不是管理员' }
    return { state: 'ok', tier: String(g.tier), senderId: String(g.senderId ?? '') }
  } catch (error) {
    return { state: 'broken', why: error?.message ?? String(error) }
  }
}

/**
 * 回合结束清掉这一个会话的授权。
 *
 * ⚠️ **只删自己写过的那一个文件**（按 peerKey 算出来的名字），
 * 不做"清空目录" —— 多会话并发时清空会把**别的会话正在用的授权**删掉，
 * 症状是"隔壁群的管理员截图忽然说没权限"（而且极难复现）。
 */
export function clearGrant({ workspace, peerKey, scope = GRANT_SCOPE.screenshot } = {}) {
  try {
    if (!workspace || !peerKey) return { ok: false, why: '缺参数' }
    const dir = grantsDir(workspace, scope)
    if (!dir) return { ok: false, why: '工作区路径不可用' }
    fs.rmSync(path.join(dir, grantFileName(peerKey, scope)), { force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, why: error?.message ?? String(error) }
  }
}

/**
 * 测试/排障用：清掉**某一个域**的所有授权文件（**产品代码不要调用** —— 见 clearGrant 的警告）。
 *
 * ★ 加 `scope` 是必须的：不传就按截图域（向后兼容），
 *   而 MC 域现在住另一个目录（`.grants/mc`）—— 两个域各自清各自的，互不牵连。
 */
export function clearAllGrants({ workspace, scope = GRANT_SCOPE.screenshot } = {}) {
  const dir = grantsDir(workspace, scope)
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
