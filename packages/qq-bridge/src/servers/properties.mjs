/**
 * 服务端的 `server.properties`：**读它、只改 RCON 那三行**（0.3.2 收尾）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要有这个模块（使用者 2026-10-04 问：「开服时显示 enable-rcon=false，
 * 能否在桥接的编辑栏直接修改」）
 * ══════════════════════════════════════════════════════════════════════════
 * 在那之前，RCON 开不起来时我们只能**指路**（"去 server.properties 里开 enable-rcon=true"），
 * 而使用者要的是**在这儿改**。于是新增这条路：界面读一次那个文件 → 显示当前状态 →
 * 一键把 RCON 配好（并可顺便把 `password`/`rconPort` 同步进我们自己的 `servers[]`，
 * 否则两边对不上，RCON 照样连不上）。
 *
 * ── 三条纪律（这个文件写的是**别人的**配置文件，所以比平常更保守）─────────────
 *   ① **只碰 RCON 那三行**（`enable-rcon` / `rcon.port` / `rcon.password`）：
 *      其余行**逐字不动**（注释、顺序、空行、我们看不懂的键全部原样保留）。
 *      理由：那是服务端的配置，我们只是"帮它改三个开关"，不是它的编辑器。
 *   ② **写之前必须备份**，并且**只在文件与刚读到的内容仍然一致时才写**（乐观并发）：
 *      否则可能把使用者同时在别处做的改动**静默覆盖**掉。
 *   ③ **改完必须重启服务端才生效** —— 那三个值是**启动时**读进内存的。
 *      ⚠️ 实测（2026-10-04 真机）：停机**没有**重写 `server.properties`
 *      （文件 mtime 17:48，而停机日志在 17:57）⇒ 跑着改**不会**被它覆盖；
 *      但"跑着改"仍然没用，因为它不会重读。这一点必须如实告诉使用者，
 *      而不是含糊成"改完就好了"。
 *
 * ── 为什么是**行级**改而不是 parse→改→stringify ─────────────────────────────
 * `Properties.store()` 一类做法会**丢掉注释与顺序**（真机上那份就是被服务端自己
 * 重写过的、已经没注释了；但使用者手上的可能还带着注释）。行级替换只动命中的行，
 * 其余字节一个都不变 —— 这条有断言盯着（见 `mocks/verify-properties.mjs`）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { createSupervisor } from './supervise.mjs'

/** 我们要改的三个键（别的一项都不碰）。 */
export const RCON_KEYS = ['enable-rcon', 'rcon.port', 'rcon.password']

/** `server.properties` 的默认文件名。 */
export const PROPERTIES_FILE = 'server.properties'

/** `enable-rcon` 的解析：只有 `true`（大小写不敏感）算开。 */
function parseBool(v) {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === 'true') return true
  if (s === 'false') return false
  return null // 值不认识 ⇒ 不猜
}

/**
 * 找这台服务端的 `server.properties`。
 *
 * ★ 判据只有两处，**都不猜**：
 *   ① 归属档里的 `cwd`（那是"我们自己拉起它时用的工作目录"——最可靠，
 *      因为服务端就是在那儿读的配置）；
 *   ② 配置里 `servers[].cwd`（使用者手填的）。
 * 两个都没有（或那个文件不存在）⇒ 返回 `null` + 原因，**不去盘上乱找**：
 * 找错文件的后果是"改了别的服务器的配置"，比"改不了"严重得多。
 *
 * @returns {{ok: boolean, path: string|null, from: string, why?: string}}
 */
export function resolvePropertiesPath({ workspace = '', server = null } = {}) {
  if (!server || !server.id) return { ok: false, path: null, from: '', why: '缺 server（不知道是哪一台）' }
  const candidates = []
  try {
    const st = createSupervisor({ workspace, log: () => {} }).readState(server.id)
    if (st?.cwd) candidates.push({ cwd: String(st.cwd), from: '归属档（我们拉起它时用的工作目录）' })
  } catch {
    /* 读不到归属档就试下一个来源 */
  }
  if (server.cwd) candidates.push({ cwd: String(server.cwd), from: 'config.json 的 servers[].cwd' })

  if (candidates.length === 0) {
    return {
      ok: false,
      path: null,
      from: '',
      why: '不知道这台服务端的目录（归属档里没有 cwd，配置里也没填 servers[].cwd）—— 不猜，先补一个',
    }
  }
  for (const c of candidates) {
    const p = join(c.cwd, PROPERTIES_FILE)
    try {
      if (existsSync(p) && statSync(p).isFile()) return { ok: true, path: p, from: c.from }
    } catch {
      /* 换下一个候选 */
    }
  }
  return {
    ok: false,
    path: null,
    from: candidates[0].from,
    why: `按 ${candidates.map((c) => c.cwd).join(' / ')} 都找不到 ${PROPERTIES_FILE}`,
  }
}

/**
 * 读 RCON 那三项的**当前状态**（**不回密码本身** —— 与 `passwordSet` 同一条纪律）。
 *
 * @returns {{ok:boolean, enableRcon:boolean|null, rconPort:number|null, passwordSet:boolean, passwordLength:number, why?:string}}
 */
export function readRconSettings(text) {
  const rows = String(text ?? '').split(/\r?\n/)
  let enableRcon = null
  let rconPort = null
  let password = null
  for (const line of rows) {
    const m = /^\s*([^#=\s][^=]*?)\s*=(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].trim()
    const value = m[2]
    if (key === 'enable-rcon') enableRcon = parseBool(value)
    else if (key === 'rcon.port') {
      const n = Number(value.trim())
      rconPort = Number.isFinite(n) && n > 0 && n < 65536 ? n : null
    } else if (key === 'rcon.password') password = value
  }
  return {
    ok: true,
    enableRcon, // null = 文件里没这一项 / 值看不懂（**不猜成 false**）
    rconPort,
    passwordSet: typeof password === 'string' && password.length > 0,
    passwordLength: typeof password === 'string' ? password.length : 0,
  }
}

/**
 * 只改 RCON 那三行，**其余逐字保留**。
 *
 * @param {string} text 原文
 * @param {{enableRcon?: boolean, rconPort?: number, password?: string}} patch 要写的值（缺省 = 不动那一项）
 * @returns {{ok:boolean, text:string, changed:string[], why?:string}}
 */
export function patchRconSettings(text, patch = {}) {
  const src = String(text ?? '')
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const hadTrailing = src.endsWith('\n')
  const lines = src.split(/\r?\n/)
  if (hadTrailing) lines.pop() // 末尾那个空串是结尾换行，别当成一行

  const want = new Map()
  if (patch.enableRcon !== undefined) {
    if (typeof patch.enableRcon !== 'boolean') return { ok: false, text: src, changed: [], why: 'enableRcon 必须是布尔值' }
    want.set('enable-rcon', patch.enableRcon ? 'true' : 'false')
  }
  if (patch.rconPort !== undefined) {
    const n = Number(patch.rconPort)
    if (!Number.isFinite(n) || !(n > 0 && n < 65536)) return { ok: false, text: src, changed: [], why: 'rconPort 不是合法端口（1..65535）' }
    want.set('rcon.port', String(Math.trunc(n)))
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
    if (!want.has(key)) return line // 不是我们要动的键：**原样**
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

  const text2 = out.join(eol) + (hadTrailing ? eol : '')
  return { ok: true, text: text2, changed }
}

/**
 * 给人看的当前状态（界面与 CLI 共用一份措辞，避免两处各说各话）。
 * ★ 密码只说"配了没有"，**不说长度**（长度也是信息）。
 */
export function describeRconSettings(s) {
  if (!s || s.ok !== true) return '读不出来'
  const on = s.enableRcon === true ? '开' : s.enableRcon === false ? '**关**（这就是连不上的原因）' : '**没有这一项/值看不懂**'
  return `enable-rcon=${on} · rcon.port=${s.rconPort ?? '没写（默认 25575）'} · rcon.password=${s.passwordSet ? '已设置' : '**空**'}`
}

/** 读文件（失败不抛，翻成人话）。**只给路由用**，纯函数测试不需要它。 */
export function readPropertiesFile(path) {
  try {
    return { ok: true, text: readFileSync(path, 'utf8') }
  } catch (error) {
    return { ok: false, why: `读不到 ${path}：${error?.message ?? error}` }
  }
}
