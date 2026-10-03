/**
 * 把"解析出来的 OneBot token"真正交给客户端 —— 也就是 token 发现的**最后一公里**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这个模块（2026-10-03 实机测试报告 BUG-2）
 * ══════════════════════════════════════════════════════════════════════════
 * `resolveOnebotTokens()` 早就写好了"该用哪一组 token"的判定（SnowLuma 自己的
 * `config/onebot_<QQ>.json` 是唯一真源），但在发布包里它**只有两处调用，而且两处
 * 都不参与建连**：① `--snowluma` 分支里打印一句"两边不一致"；② 启动自检里打印来源。
 * 真正建连的 `new OneBotClient({ ...config.onebot })` 用的仍是 `config.json` 里那份
 * **静态副本**（模板默认是空串）—— 于是客户端空手去连，两个通道必然 401。
 *
 * 更糟的是日志把人带偏：`differsFromConfig` 只比较"两边都非空且不同"，所以
 * "config.json 为空"会走 else 分支，打印一行看似一切正常的
 * 「来源：SnowLuma 自己的配置（…与 config.json 一致）」——
 * 那句话的真实含义是"**没有冲突**"，而不是"**用上了**"。
 *
 * 所以这里做两件事，缺一不可：
 *   ① `applyOnebotTokens()`：在建连**之前**把解析结果写进运行期配置（真正接上）；
 *   ② `persistOnebotTokens()`：按 `/api/config` 的**同一套纪律**写回 `config.json`
 *      （校验归一化形态 → 备份 `.bak` → 落盘）。不写回的话，界面与 `--doctor`
 *      会一直说"没有配置 accessToken"，与"实际能连上"自相矛盾 ——
 *      "看着没配、其实在跑"是最难排查的一种状态。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 安全底线：宁可连不上，也不接错账号
 * ══════════════════════════════════════════════════════════════════════════
 * SnowLuma 下有**多个账号**、既没写 `onebot.selfId`、`config.json` 里也没有任何
 * 能对上的 token 时，**不自动接、只警告**。接错账号等于用别人的身份收发消息，
 * 比连不上严重得多（这条底线是 `token-discovery.mjs` 立的，这里照旧遵守），
 * 只允许三种**确定性**情形自动接：
 *
 *   · `explicit-selfId`   —— 配置里写死了自己的 QQ 号，账号文件就是它
 *   · `matched-config:*`  —— 有一个账号的 token 与 `config.json` 里那份**对得上**
 *   · `auto-newest:*`     —— 那边**只有一个**账号文件（没有第二种选择）
 *
 * 其余情形（`ambiguous` / `none` / 多账号下的 `auto-newest`）一律只警告，
 * 并告诉用户怎么把它变成确定性的。
 */

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { normalizeConfig, validateConfig } from './config.mjs'
import { mergeConfigPatch } from './api.mjs'

/**
 * 这一次挑中的账号是不是"确定无疑"的（见文件头的安全底线）。
 *
 * @param {{picked?: string, accounts?: string[]}} tokens `resolveOnebotTokens()` 的结果
 */
export function isDeterministicPick({ picked, accounts = [] } = {}) {
  const p = String(picked ?? '')
  if (!p || p === 'none' || p === 'ambiguous') return false
  if (p === 'explicit-selfId') return true
  if (p.startsWith('matched-config:')) return true
  // "最新的那个账号"只有在**只有一个**账号时才是确定性的
  if (p.startsWith('auto-newest:')) return (accounts?.length ?? 0) <= 1
  return false
}

/**
 * 算出"要不要接、要不要写回"（纯函数，不改任何东西）。
 *
 * @returns {{apply: boolean, persist: boolean, wsToken: string, httpToken: string, reason: string}}
 *   `reason` 取值：`empty`（解析结果不全）/ `same`（与运行期一致，无需动作）/
 *   `ambiguous`（有多种可能，只警告）/ `differs`（确定且不同 → 接上并写回）
 */
export function planTokenSync({ config, tokens } = {}) {
  const cfg = config?.onebot ?? {}
  const wsToken = String(tokens?.wsToken ?? '')
  const httpToken = String(tokens?.httpToken ?? '')
  const plan = { apply: false, persist: false, wsToken, httpToken, reason: '' }

  // 只解析到一侧时**不能**动手：半套 token 会把原本能用的一侧也弄坏
  // （resolveOnebotTokens 已经回退到 config.json 那一侧，所以这里只可能是"两边都空"）
  if (!wsToken || !httpToken) return { ...plan, reason: 'empty' }

  if (wsToken === String(cfg.wsToken ?? '') && httpToken === String(cfg.httpToken ?? '')) {
    return { ...plan, reason: 'same' }
  }

  if (!isDeterministicPick(tokens)) return { ...plan, reason: 'ambiguous' }

  return { apply: true, persist: true, wsToken, httpToken, reason: 'differs' }
}

/**
 * ① 把解析结果接进**运行期**配置（就在 `new OneBotClient` 之前调用）。
 *
 * 只改内存里的 `config.onebot`，不动磁盘 —— 磁盘由 `persistOnebotTokens()` 按纪律写。
 *
 * @returns {{applied: boolean, reason: string, detail: string}}
 */
export function applyOnebotTokens({ config, tokens, log = () => {} } = {}) {
  const plan = planTokenSync({ config, tokens })
  if (!plan.apply) {
    if (plan.reason === 'ambiguous') {
      log(
        `⚠️ SnowLuma 那边有多个账号，无法确定哪个是**你自己的** —— 没有自动接它的 token。` +
          `账号：${(tokens?.accounts ?? []).join('、') || '（未知）'}。` +
          `请二选一：在 config.json 里填 onebot.selfId（你自己的 QQ 号），` +
          `或把该账号的 token 直接填进 config.json 的 onebot.wsToken/httpToken。`,
      )
    }
    return {
      applied: false,
      reason: plan.reason,
      detail:
        plan.reason === 'same'
          ? '运行期配置里的 token 与解析结果一致，无需改动'
          : plan.reason === 'empty'
            ? '没有解析到完整的一组 token（SnowLuma 没装/没那个账号的文件）'
            : '有多种可能，按安全底线只警告不自动接',
    }
  }

  config.onebot.wsToken = plan.wsToken
  config.onebot.httpToken = plan.httpToken
  // ★ 只报来源与账号，**绝不打印 token 本身**。
  log(
    `[凭据] 已接上 OneBot token：来源【${tokens?.source ?? '?'}】，` +
      `${tokens?.picked && tokens.picked !== 'none' ? `账号 ${tokens.picked}` : '未指明账号'}`,
  )
  return { applied: true, reason: plan.reason, detail: `来源【${tokens?.source ?? '?'}】` }
}

/**
 * ② 把同一组 token 按 `/api/config` 的纪律写回 `config.json`。
 *
 * 顺序：读盘 → `mergeConfigPatch`（与界面保存走**同一份**合并语义）→
 * 校验归一化形态（致命项就**不写**）→ 备份 `.bak` → 落盘。
 *
 * @param {object} opts
 * @param {string|null} opts.configPath  `config.json` 的绝对路径（null = 不写盘）
 * @param {{wsToken: string, httpToken: string}} opts.tokens 解析结果
 * @returns {{saved: boolean, backedUp: boolean, reason: string, fatal?: string[]}}
 */
export function persistOnebotTokens({ configPath = null, tokens, log = () => {} } = {}) {
  const wsToken = String(tokens?.wsToken ?? '')
  const httpToken = String(tokens?.httpToken ?? '')
  if (!configPath) return { saved: false, backedUp: false, reason: 'no-path' }
  if (!wsToken || !httpToken) return { saved: false, backedUp: false, reason: 'empty' }

  let raw
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    log(`⚠️ 读不出 config.json，跳过写回（不影响本次运行）：${error?.message ?? error}`)
    return { saved: false, backedUp: false, reason: 'unreadable' }
  }

  // 已经是这一组 token 就不写 —— 避免每次启动都改一次文件时间戳、也少一次 .bak 覆盖
  if (
    String(raw?.onebot?.wsToken ?? '') === wsToken &&
    String(raw?.onebot?.httpToken ?? '') === httpToken
  ) {
    return { saved: false, backedUp: false, reason: 'already' }
  }

  let merged
  try {
    merged = mergeConfigPatch(raw, { onebot: { wsToken, httpToken } })
  } catch (error) {
    log(`⚠️ 合并配置补丁失败，跳过写回：${error?.message ?? error}`)
    return { saved: false, backedUp: false, reason: 'merge-failed' }
  }

  // ★ 与界面保存同一条纪律：校验归一化形态，致命项就绝不落盘
  const { fatal } = validateConfig(normalizeConfig(merged))
  if (fatal.length > 0) {
    log(`⚠️ 写回 config.json 会让配置不合法，已跳过（本次仍按接上的 token 运行）：${fatal.join('；')}`)
    return { saved: false, backedUp: false, reason: 'invalid', fatal }
  }

  let backedUp = false
  try {
    copyFileSync(configPath, `${configPath}.bak`)
    backedUp = true
  } catch {
    /* 备份失败不阻断保存（与 /api/config 一致） */
  }

  try {
    writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  } catch (error) {
    log(`⚠️ 写 config.json 失败（本次运行不受影响）：${error?.message ?? error}`)
    return { saved: false, backedUp, reason: 'write-failed' }
  }

  log(`[凭据] 已同步写回 config.json${backedUp ? '（另存一份 config.json.bak）' : ''}`)
  return { saved: true, backedUp, reason: 'saved' }
}

/**
 * 编排上述两步（启动路径唯一的调用点）。
 *
 * @returns {{applied: boolean, saved: boolean, reason: string}}
 */
export function syncOnebotTokens({ config, tokens, configPath = null, log = () => {} } = {}) {
  const applied = applyOnebotTokens({ config, tokens, log })
  if (!applied.applied) return { applied: false, saved: false, reason: applied.reason }
  const saved = persistOnebotTokens({ configPath, tokens, log })
  return { applied: true, saved: saved.saved, reason: applied.reason }
}
