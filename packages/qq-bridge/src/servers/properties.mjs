/**
 * 服务端**自己的**配置文件：`server.properties` 与 `eula.txt`（0.3.2 收尾）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要有这个模块
 * ══════════════════════════════════════════════════════════════════════════
 * 起因是使用者连着问的两件事：
 *   · 「开服时显示 enable-rcon=false，能否在桥接的编辑栏直接修改」；
 *   · 「目前在编辑页面改了**游戏端口**也不能实际生效，并且不能自动同意 EULA」。
 * 两件事是**同一个形状**：编辑栏以前只改我们自己的 `config.json`，而服务端读的是
 * **它自己那两个文件** —— 于是"两边不一致"就表现为"改了没用"：
 *   · 我们探的端口（`servers[].port`）≠ 它监听的端口（`server-port`）⇒ 监测说它挂了；
 *   · 我们配的 RCON 密码 ≠ `rcon.password` ⇒ 认证被拒；
 *   · `eula.txt` 里不是 `true` ⇒ **服务端直接拒绝启动**
 *     （真机日志原文：`You need to agree to the EULA in order to run the server.`）。
 *
 * ── 四条纪律（这个文件写的是**别人的**配置文件，所以比平常更保守）─────────────
 *   ① **只碰托管的那几行**：`server-port` / `enable-rcon` / `rcon.port` / `rcon.password`
 *      （以及 `eula.txt` 的 `eula` 那一行）。其余行 —— 注释、顺序、空行、我们看不懂的键 ——
 *      **逐字不动**。做法是**行级替换**而不是 `parse → 改 → stringify`（后者会丢注释）。
 *   ② **写不出错值**：端口越界 / 空密码 / 密码带换行 / 布尔不是布尔 ⇒ 一律拒绝，
 *      而且**原文一个字都不变**（不是"改了一半再报错"）；值本来就对 ⇒ `changed` 为空。
 *   ③ **找文件不猜**：只认①归属档的 `cwd`（我们自己拉起它时用的工作目录）②`servers[].cwd`。
 *      两个都没有 ⇒ 如实说"不知道目录" —— 找错文件的后果是改了**别的服务器**的配置。
 *   ④ **改了要重启服务端才生效**（这几项都是它**启动时**读进内存的）。
 *      ⚠️ 实测（2026-10-04 真机）：停机**没有**重写 `server.properties`
 *      （文件 mtime 17:48，而停机日志在 17:57）⇒ 跑着改**不会**被它覆盖；
 *      但"跑着改"仍然没用，因为它不会重读。这一点必须如实告诉使用者。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { createSupervisor } from './supervise.mjs'

/** 我们托管的键（别的一项都不碰）。 */
export const MANAGED_KEYS = ['server-port', 'enable-rcon', 'rcon.port', 'rcon.password']

/** 文件名。 */
export const PROPERTIES_FILE = 'server.properties'
export const EULA_FILE = 'eula.txt'
/** 同意 EULA 时把这一条也写给使用者看（这不是我们发明的条款，是 Mojang 的）。 */
export const EULA_URL = 'https://aka.ms/MinecraftEULA'

/** 兼容旧名（0.3.2 早期只有 RCON 三项时叫这个）。 */
export const RCON_KEYS = ['enable-rcon', 'rcon.port', 'rcon.password']

/** `true`/`false` 解析；别的值一律 `null`（**不猜**）。 */
function parseBool(v) {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === 'true') return true
  if (s === 'false') return false
  return null
}

/** 端口解析：1..65535 之外一律 `null`。⚠️ `Number('') === 0`、`Number(null) === 0` ⇒ 必须先挡空。 */
function parsePort(v) {
  const s = String(v ?? '').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}

/**
 * 找这台服务端的**目录**（`server.properties` / `eula.txt` 就在那儿）。
 *
 * ★ 判据只有两处，**都不猜**：
 *   ① 归属档里的 `cwd`（"我们自己拉起它时用的工作目录" —— 最可靠，服务端就是在那儿读的配置）；
 *   ② 配置里 `servers[].cwd`（使用者手填的）。
 * 两个都没有 ⇒ `{ok:false}` + 原因，**不去盘上乱找**。
 *
 * @returns {{ok:boolean, dir:string|null, from:string, why?:string}}
 */
export function resolveServerDir({ workspace = '', server = null } = {}) {
  if (!server || !server.id) return { ok: false, dir: null, from: '', why: '缺 server（不知道是哪一台）' }
  const candidates = []
  try {
    const st = createSupervisor({ workspace, log: () => {} }).readState(server.id)
    if (st?.cwd) candidates.push({ dir: String(st.cwd), from: '归属档（我们拉起它时用的工作目录）' })
  } catch {
    /* 读不到归属档就试下一个来源 */
  }
  if (server.cwd) candidates.push({ dir: String(server.cwd), from: 'config.json 的 servers[].cwd' })

  if (candidates.length === 0) {
    return {
      ok: false,
      dir: null,
      from: '',
      why: '不知道这台服务端的目录（归属档里没有 cwd，配置里也没填 servers[].cwd）—— 不猜，先补一个',
    }
  }
  for (const c of candidates) {
    try {
      if (existsSync(c.dir) && statSync(c.dir).isDirectory()) return { ok: true, dir: c.dir, from: c.from }
    } catch {
      /* 换下一个候选 */
    }
  }
  return { ok: false, dir: null, from: candidates[0].from, why: `这些目录都不存在：${candidates.map((c) => c.dir).join(' / ')}` }
}

/** 找 `server.properties`。 */
export function resolvePropertiesPath({ workspace = '', server = null } = {}) {
  const at = resolveServerDir({ workspace, server })
  if (!at.ok) return { ok: false, path: null, from: '', why: at.why }
  const p = join(at.dir, PROPERTIES_FILE)
  try {
    if (existsSync(p) && statSync(p).isFile()) return { ok: true, path: p, from: at.from }
  } catch {
    /* 落到下面那句 */
  }
  return { ok: false, path: null, from: at.from, why: `${at.dir} 里没有 ${PROPERTIES_FILE}` }
}

/** 找 `eula.txt`。★ 它**可能还不存在**（服务端首次启动时才生成）⇒ 返回 `exists:false` 而不是失败。 */
export function resolveEulaPath({ workspace = '', server = null } = {}) {
  const at = resolveServerDir({ workspace, server })
  if (!at.ok) return { ok: false, path: null, exists: false, from: '', why: at.why }
  const p = join(at.dir, EULA_FILE)
  return { ok: true, path: p, exists: existsSync(p), from: at.from }
}

/**
 * 读托管项的**当前状态**（**永不回密码本身** —— 只有"配了没有"，连长度都不在接口层出现）。
 *
 * @returns {{ok:boolean, serverPort:number|null, enableRcon:boolean|null, rconPort:number|null, passwordSet:boolean, passwordLength:number}}
 */
export function readServerSettings(text) {
  const rows = String(text ?? '').split(/\r?\n/)
  let serverPort = null
  let enableRcon = null
  let rconPort = null
  let password = null
  for (const line of rows) {
    const m = /^\s*([^#=\s][^=]*?)\s*=(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].trim()
    const value = m[2]
    if (key === 'server-port') serverPort = parsePort(value)
    else if (key === 'enable-rcon') enableRcon = parseBool(value)
    else if (key === 'rcon.port') rconPort = parsePort(value)
    else if (key === 'rcon.password') password = value
  }
  return {
    ok: true,
    serverPort, // null = 没这一项 / 值看不懂（**不猜成 25565**）
    enableRcon,
    rconPort,
    passwordSet: typeof password === 'string' && password.length > 0,
    passwordLength: typeof password === 'string' ? password.length : 0,
  }
}

/**
 * 只改托管的那些行，**其余逐字保留**。
 *
 * @param {string} text 原文
 * @param {{serverPort?:number, enableRcon?:boolean, rconPort?:number, password?:string}} patch
 * @returns {{ok:boolean, text:string, changed:string[], why?:string}}
 */
export function patchServerSettings(text, patch = {}) {
  const src = String(text ?? '')
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const hadTrailing = src.endsWith('\n')
  const lines = src.split(/\r?\n/)
  if (hadTrailing) lines.pop() // 末尾那个空串是结尾换行，别当成一行

  const want = new Map()
  if (patch.serverPort !== undefined) {
    const p = parsePort(patch.serverPort)
    if (p === null) return { ok: false, text: src, changed: [], why: 'serverPort 不是合法端口（1..65535）' }
    want.set('server-port', String(p))
  }
  if (patch.enableRcon !== undefined) {
    if (typeof patch.enableRcon !== 'boolean') return { ok: false, text: src, changed: [], why: 'enableRcon 必须是布尔值' }
    want.set('enable-rcon', patch.enableRcon ? 'true' : 'false')
  }
  if (patch.rconPort !== undefined) {
    const p = parsePort(patch.rconPort)
    if (p === null) return { ok: false, text: src, changed: [], why: 'rconPort 不是合法端口（1..65535）' }
    want.set('rcon.port', String(p))
  }
  if (patch.password !== undefined) {
    const pw = String(patch.password)
    if (!pw) return { ok: false, text: src, changed: [], why: '密码不能是空串（空密码服务端会拒绝开 RCON）' }
    if (/[\r\n]/.test(pw)) return { ok: false, text: src, changed: [], why: '密码里不能有换行' }
    want.set('rcon.password', pw)
  }
  if (want.size === 0) return { ok: false, text: src, changed: [], why: '什么都没要求改' }

  const changed = []
  const seen = new Set()
  const out = lines.map((line) => {
    const m = /^(\s*)([^#=\s][^=]*?)(\s*)=(.*)$/.exec(line)
    if (!m) return line // 注释 / 空行 / 看不懂的格式：**原样**
    const key = m[2].trim()
    if (!want.has(key)) return line // 不是托管的键：**原样**
    seen.add(key)
    const next = want.get(key)
    if (m[4] === next) return line // 值本来就一样 ⇒ 连这一行都不用改
    changed.push(key)
    // ★ 保留原有的缩进与 `=` 两侧的写法（只换值），这样 diff 只有值那一截
    return `${m[1]}${m[2]}${m[3]}=${next}`
  })

  // 文件里原本没有的键 ⇒ 追加在末尾（服务端认这个位置）
  for (const [key, value] of want) {
    if (seen.has(key)) continue
    out.push(`${key}=${value}`)
    changed.push(`${key}（新增）`)
  }

  return { ok: true, text: out.join(eol) + (hadTrailing ? eol : ''), changed }
}

/**
 * 读 `eula.txt` 的状态。`agreed` 三态：`true` / `false` / `null`（文件不在或没有那一行 ⇒ 没同意）。
 */
export function readEula(text) {
  let agreed = null
  let hasLine = false
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*eula\s*=(.*)$/i.exec(line)
    if (!m) continue
    hasLine = true
    agreed = parseBool(m[1])
  }
  return { ok: true, agreed, hasLine }
}

/**
 * 写 `eula.txt`：只改 `eula` 那一行（没有就追加，并附一条说明 + 官方链接）。
 *
 * ★★ 这是一条**同意条款**的动作，不是普通配置：调用方（界面）必须让使用者**显式**点，
 *    并把 `EULA_URL` 摆在他眼前。我们只负责把那一行写对，不替他做这个决定。
 * ★ 服务端首次启动时自己会生成一份 `eula=false`；文件不存在时我们也能创建（正文是标准的那个注释块）。
 */
export function patchEula(text, agree = true) {
  if (typeof agree !== 'boolean') return { ok: false, text: String(text ?? ''), changed: [], why: 'agree 必须是布尔值' }
  const src = String(text ?? '')
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const want = agree ? 'true' : 'false'

  if (!src.trim()) {
    // 文件不存在/是空的：按官方那份的形状写一份（注释里说清这是什么、链接在哪）
    const fresh =
      [
        '#By changing the setting below to TRUE you are indicating your agreement to our EULA (' + EULA_URL + ').',
        `#${new Date().toISOString()}`,
        `eula=${want}`,
        '',
      ].join(eol)
    return { ok: true, text: fresh, changed: ['eula（新增）'] }
  }

  const hadTrailing = src.endsWith('\n')
  const lines = src.split(/\r?\n/)
  if (hadTrailing) lines.pop()
  let hit = false
  const changed = []
  const out = lines.map((line) => {
    const m = /^(\s*)(eula)(\s*)=(.*)$/i.exec(line)
    if (!m) return line // 注释与别的行：**原样**
    hit = true
    if (m[4].trim().toLowerCase() === want) return line // 已经是这个值 ⇒ 不改
    changed.push('eula')
    return `${m[1]}${m[2]}${m[3]}=${want}`
  })
  if (!hit) {
    out.push(`eula=${want}`)
    changed.push('eula（新增）')
  }
  return { ok: true, text: out.join(eol) + (hadTrailing ? eol : ''), changed }
}

/**
 * 给人看的当前状态（界面与 CLI 共用一份措辞，避免两处各说各话）。
 * ★ 密码只说"配了没有"，**不说长度**（长度也是信息）。
 */
export function describeServerSettings(s) {
  if (!s || s.ok !== true) return '读不出来'
  const on = s.enableRcon === true ? '开' : s.enableRcon === false ? '**关**（这就是连不上的原因）' : '**没有这一项/值看不懂**'
  return (
    `server-port=${s.serverPort ?? '没写（默认 25565）'} · ` +
    `enable-rcon=${on} · rcon.port=${s.rconPort ?? '没写（默认 25575）'} · ` +
    `rcon.password=${s.passwordSet ? '已设置' : '**空**'}`
  )
}

/** 兼容旧名（0.3.2 早期只读 RCON 三项时叫这个）。 */
export const readRconSettings = readServerSettings
/** 兼容旧名。 */
export const patchRconSettings = patchServerSettings

/** 读文本文件（失败不抛，翻成人话）。**只给路由用**，纯函数测试不需要它。 */
export function readTextFile(path) {
  try {
    return { ok: true, text: readFileSync(path, 'utf8') }
  } catch (error) {
    return { ok: false, why: `读不到 ${path}：${error?.message ?? error}` }
  }
}

/** 兼容旧名。 */
export const readPropertiesFile = readTextFile
