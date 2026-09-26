/**
 * OneBot 凭据发现：**保守地**从 SnowLuma 自己的配置文件里读 token。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要"保守"（借鉴 NapCat 的 config_discovery，并按我们的场景改了两处）
 * ══════════════════════════════════════════════════════════════════════════
 * 这份文件**不是我们的**：它属于 SnowLuma，而我们只读它。所以规矩是
 * "**宁可找不到、也不要猜**" —— 猜错的症状是"令牌被拒 + 机器人完全不说话"
 * （本项目踩过两次，见 `snowluma.mjs` 文件头）。
 *
 * 采用的四条（都是它给的，也确实适用于我们）：
 *   ① **只读明确的配置文件**：不写 `.env`、不调 WebUI、**不发任何网络请求**；
 *   ② **只接受常规文件**（`lstat` 拒符号链接）+ 体积上限 + token 长度上限 + 拒控制字符；
 *   ③ **只采纳 `enabled !== false` 且 host 属于 loopback 的服务器**
 *      （非 loopback 的条目在一个"本机协议端"的配置里是可疑的，宁可不用）；
 *   ④ ★★ **显式指定了账号（selfId）时，找不到它的配置文件就返回"没有"** ——
 *      **绝不复用别的账号的 token**。这一条是安全底线：复用别的账号的 token
 *      等于用一个不属于这个账号的凭据去连协议端，后果是 401 + 静默不说话。
 *      （原实现就是"找不到就退到目录里任意一个 `onebot_<数字>.json`" —— 那是**猜**。）
 *
 * ── ★ 一处**刻意不改**（与参考项目不同，理由要看完）───────────────────────
 * NapCat 那边有一条"**HTTP 与 WS 给出不同 token 就放弃猜测**"。
 * 我们**不照搬**：他们的 http/ws 是**同一个连接的两个候选**，所以不一致时无法判断；
 * 而我们的两条通道是**同时使用、各用各的凭据** ——
 * 桥接用 HTTP token 发消息、用 WS token 收事件，它们**本来就该各自取自己那份**。
 * 照搬那条会让一份完全正常的配置（两个 token 不同）直接失效。
 * 我们保留的是它的**精神**：不一致时**不静默**（`differsFromConfig` + `why` 如实报出来）。
 *
 * ⚠️ 与 `snowluma.mjs` 的分工：本模块只做"读 + 校验"，不碰配置合并、不发网络请求。
 */

import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 各种上限（值取自参考项目；对我们这种小文件也够宽松）。 */
export const DISCOVERY_LIMITS = {
  /** 配置文件体积上限：2MB（正常只有几 KB）。 */
  maxBytes: 2 * 1024 * 1024,
  /** token 长度上限：512 字符（正常 32~64）。 */
  maxTokenChars: 512,
  /** 最多看多少个账号文件（防止一个畸形目录把启动拖住）。 */
  maxAccounts: 20,
}

/** host 是不是回环（只认这几种写法，别的一律不算）。 */
export function isLoopbackHost(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return false
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/**
 * token 校验：**只接受"看起来就是 token"的字符串**。
 *
 * 拒：非字符串、空、超长、含控制字符（换行/NUL 之类 —— 它们会被塞进 HTTP 头）。
 * 为什么连控制字符都要管：这段字符串最终会进 `Authorization` 头，
 * 而带头部注入的请求在协议端只会得到一句莫名其妙的 400，排查成本极高。
 *
 * @returns {{ok: true, token: string}|{ok: false, why: string}}
 */
export function sanitizeToken(value) {
  if (value === undefined || value === null) return { ok: false, why: '缺失' }
  if (typeof value !== 'string') return { ok: false, why: '不是字符串' }
  const t = value.trim()
  if (!t) return { ok: false, why: '为空' }
  if (t.length > DISCOVERY_LIMITS.maxTokenChars) {
    return { ok: false, why: `太长（${t.length} > ${DISCOVERY_LIMITS.maxTokenChars}）` }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t)) return { ok: false, why: '含控制字符' }
  return { ok: true, token: t }
}

/**
 * 读一个账号配置文件（**保守读**）。
 *
 * @param {string} file
 * @param {{lstat?: Function}} [opts] `lstat` 可注入 —— Windows 上**建符号链接需要开发者模式**，
 *   而"拒符号链接"是安全判据、不能因为"本机建不出来"就没有测试盯着。
 * @returns {{ok: true, json: object, file: string}|{ok: false, why: string}}
 */
export function readAccountFile(file, { lstat = lstatSync } = {}) {
  let st
  try {
    st = lstat(file)
  } catch (error) {
    return { ok: false, why: `读不到：${error?.code ?? error?.message}` }
  }
  // ★ 拒符号链接：我们只读自己人写的常规文件。跟着链接走等于让**别人**决定我们读什么。
  if (st.isSymbolicLink()) return { ok: false, why: '是符号链接（拒读）' }
  if (!st.isFile()) return { ok: false, why: '不是常规文件' }
  if (st.size > DISCOVERY_LIMITS.maxBytes) {
    return { ok: false, why: `文件过大（${Math.round(st.size / 1024)}KB）` }
  }
  try {
    return { ok: true, json: JSON.parse(readFileSync(file, 'utf8')), file }
  } catch (error) {
    return { ok: false, why: `解析失败：${error?.message ?? error}` }
  }
}

/**
 * 从一组 server 条目里挑出可用的那一个（`enabled !== false` + loopback）。
 *
 * @param {any[]} servers
 * @param {{channel: 'http'|'ws'}} opts
 * @returns {{token: string|null, host: string|null, why: string|null, skipped: string[]}}
 */
export function pickServer(servers, { channel } = {}) {
  const list = Array.isArray(servers) ? servers : []
  const skipped = []
  for (const s of list) {
    const host = s?.host ?? s?.hostname ?? null
    if (s?.enabled === false) {
      skipped.push(`${channel}: enabled=false`)
      continue
    }
    // 没写 host 时**不拒绝**（有些配置把监听地址写在别处）；写了就必须是 loopback
    if (host != null && String(host).trim() !== '' && !isLoopbackHost(host)) {
      skipped.push(`${channel}: host=${host} 不是回环`)
      continue
    }
    const t = sanitizeToken(s?.accessToken)
    if (!t.ok) {
      skipped.push(`${channel}: accessToken ${t.why}`)
      continue
    }
    return { token: t.token, host: host == null ? null : String(host), why: null, skipped }
  }
  return { token: null, host: null, why: list.length === 0 ? `没有 ${channel} 服务器条目` : `${channel} 条目都不可用`, skipped }
}

/**
 * 选账号配置文件。
 *
 * ★ 安全底线（见文件头 ④）：**给了 selfId 就只认那一个文件**，
 *   不存在就返回"没有" —— 绝不去拿别的账号的 token。
 *
 * ★★ 没给 selfId 时**不能只看"最新"**（这是真机上抓到的）：本机 SnowLuma 的
 *   `config/` 下有**两个**账号文件 —— 机器人自己的 `onebot_200000001.json`
 *   与使用者的 `onebot_100000001.json`，而**最新的是使用者的那个**。
 *   只按 mtime 挑就会挑到**别人的账号**，症状是 401 + 机器人完全不说话。
 *   所以加了一条**确定性**判据：**哪个账号文件的 token 与 `config.json` 里的一致**，
 *   就用它（两边一致 = 确实就是这个账号）。只有都不一致时才退回"最新"，并且**大声警告**。
 *
 * @param {{installDir?: string, selfId?: string, knownTokens?: {httpToken?: string, wsToken?: string}}} opts
 * @returns {{file: string|null, why: string, picked: string, warn: string}}
 */
export function pickAccountFile({ installDir, selfId, knownTokens = {} } = {}) {
  const cfgDir = join(String(installDir ?? ''), 'config')
  const uin = String(selfId ?? '').trim()
  const noWarn = ''
  if (uin) {
    const file = join(cfgDir, `onebot_${uin}.json`)
    // 存在性由 readAccountFile 判定；这里只负责"只给它这一个候选"
    return { file, why: '', picked: 'explicit-selfId', warn: noWarn }
  }

  let names = []
  try {
    names = readdirSync(cfgDir).filter((n) => /^onebot_\d+\.json$/.test(n)).slice(0, DISCOVERY_LIMITS.maxAccounts)
  } catch (error) {
    return { file: null, why: `读不到 config 目录：${error?.code ?? error?.message}`, picked: 'none', warn: noWarn }
  }
  if (names.length === 0) return { file: null, why: '目录里没有 onebot_<数字>.json', picked: 'none', warn: noWarn }

  // 收集候选（拒符号链接/非文件），同时读一份 token 用于比对
  const files = []
  for (const name of names) {
    const full = join(cfgDir, name)
    try {
      const st = lstatSync(full)
      if (!st.isFile() || st.isSymbolicLink()) continue
      files.push({ file: full, name, mtimeMs: st.mtimeMs, uin: name.replace(/^onebot_|\.json$/g, '') })
    } catch {
      /* 单个文件读不到就跳过 */
    }
  }
  if (files.length === 0) return { file: null, why: '候选文件都不可读', picked: 'none', warn: noWarn }

  // ── ★★ 判据一：与 config.json 的 token 一致的那个账号 ────────────────────
  const known = {
    http: String(knownTokens.httpToken ?? '').trim(),
    ws: String(knownTokens.wsToken ?? '').trim(),
  }
  if (known.http || known.ws) {
    const matched = []
    for (const f of files) {
      const read = readAccountFile(f.file)
      if (!read.ok) continue
      const http = pickServer(read.json?.networks?.httpServers, { channel: 'http' })
      const ws = pickServer(read.json?.networks?.wsServers, { channel: 'ws' })
      const sameHttp = known.http && http.token === known.http
      const sameWs = known.ws && ws.token === known.ws
      if (sameHttp || sameWs) matched.push(f)
    }
    if (matched.length === 1) {
      return { file: matched[0].file, why: '', picked: `matched-config:${matched[0].name}`, warn: noWarn }
    }
    if (matched.length > 1) {
      // 两个账号用了同一组 token（少见，但不该猜）
      return {
        file: null,
        why: `有 ${matched.length} 个账号文件与 config.json 的 token 一致，无法确定是哪一个`,
        picked: 'ambiguous',
        warn: '⚠️ 多个账号用同一组 token，请显式指定 config.json 的 onebot.selfId',
      }
    }
  }

  // ── 判据二：退到"最新"（**必须警告**）──────────────────────────────────
  let best = files[0]
  for (const f of files) if (f.mtimeMs > best.mtimeMs) best = f
  const warn =
    files.length > 1
      ? `⚠️ SnowLuma 下有 ${files.length} 个账号（${files.map((f) => f.uin).join('、')}），` +
        `而 config.json 里没写 onebot.selfId，已按"最新修改"自动挑【${best.uin}】。` +
        '**建议在 config.json 里显式写上 onebot.selfId** —— 挑错账号的症状是令牌被拒且机器人完全不说话。'
      : ''
  return { file: best.file, why: '', picked: `auto-newest:${best.name}`, warn }
}

/**
 * 发现 OneBot 凭据（**唯一入口**）。
 *
 * @param {{installDir?: string, selfId?: string}} opts
 * @returns {{ok: boolean, httpToken: string|null, wsToken: string|null, file: string|null,
 *            source: string, why: string, picked: string, accounts: string[]}}
 *   `ok:false` 表示"这次没有采纳 SnowLuma 自己的配置"（调用方回退到 config.json）。
 */
export function discoverOnebotConfig({ installDir, selfId, knownTokens = {} } = {}) {
  const empty = { ok: false, httpToken: null, wsToken: null, file: null, source: '', why: '', picked: 'none', accounts: [], warn: '' }
  if (!installDir) return { ...empty, why: '没有 SnowLuma 安装目录' }

  const chosen = pickAccountFile({ installDir, selfId, knownTokens })
  if (!chosen.file) return { ...empty, why: chosen.why, picked: chosen.picked, warn: chosen.warn ?? '' }

  const read = readAccountFile(chosen.file)
  if (!read.ok) {
    // ★ 显式指定账号却没读到 —— 说清楚"没有回退到别的账号"，这是排查 401 的关键
    const extra = String(selfId ?? '').trim() ? `（已指定账号 ${selfId}，**不会**改用别的账号的 token）` : ''
    return { ...empty, why: `${chosen.file} ${read.why}${extra}`, picked: chosen.picked, warn: chosen.warn ?? '' }
  }

  const cfg = read.json ?? {}
  const http = pickServer(cfg?.networks?.httpServers, { channel: 'http' })
  const ws = pickServer(cfg?.networks?.wsServers, { channel: 'ws' })
  if (!http.token && !ws.token) {
    return {
      ...empty,
      file: chosen.file,
      why: `配置里没有可用的 token（${[...http.skipped, ...ws.skipped].join('；') || '两个通道都没有条目'}）`,
      picked: chosen.picked,
      warn: chosen.warn ?? '',
    }
  }
  return {
    ok: true,
    httpToken: http.token,
    wsToken: ws.token,
    file: chosen.file,
    source: 'SnowLuma 自己的配置',
    // 只在一侧缺失时才留话 —— 两侧都拿到了就没必要解释
    why: [!http.token ? `http 通道没有可用 token（${http.skipped.join('；')}）` : '', !ws.token ? `ws 通道没有可用 token（${ws.skipped.join('；')}）` : '']
      .filter(Boolean)
      .join(' / '),
    picked: chosen.picked,
    accounts: listAccountNames(installDir),
    warn: chosen.warn ?? '',
  }
}

/**
 * 列出账号文件名（**不含任何 token**）。
 *
 * 给控制台/体检用：界面要能让人选"用哪个账号"，而**只给 ID、永不给密钥**
 * —— 这是参考项目 Dashboard 的做法，也确实是对的方向。
 */
export function listAccountNames(installDir) {
  try {
    return readdirSync(join(String(installDir ?? ''), 'config'))
      .filter((n) => /^onebot_\d+\.json$/.test(n))
      .map((n) => n.replace(/^onebot_|\.json$/g, ''))
      .sort()
      .slice(0, DISCOVERY_LIMITS.maxAccounts)
  } catch {
    return []
  }
}
