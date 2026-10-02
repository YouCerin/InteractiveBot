/**
 * **说话方式的唯一来源**（`src/voice.mjs` 的 `VOICE_STYLE` 常量）：读取、校验、同步。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 0.3.0alpha 之前这里是什么（别把这次的简化读成"随便改了改"）
 * ══════════════════════════════════════════════════════════════════════════
 * 当时说话方式有**两份存在形式**：
 *   · `styles/闲聊.md` —— 使用者实际在用的那份（桥接**每轮现读**）；
 *   · `src/chat-mode.mjs` 的 `DEFAULT_CHAT_STYLE` —— 文件不存在时的出厂默认。
 * 两份必须逐字一致（有断言），于是有了 `src/chat-style-sync.mjs` 这个同步工具；
 * 而 `styles/` 目录**从来没有进过发布包**（`scripts/assemble-release.mjs` 的
 * `COPY_DIRS` 里没有它）—— 也就是说线上跑的**一直是常量**，文件只是开发期的镜像。
 *
 * 0.3.0alpha 把双态与那份镜像一起去掉了：说话方式只有 `src/voice.mjs` 里的常量
 * 这一份。所以本模块**只做三件事**：
 *   ① 给出那个文件的路径（`voiceSourcePath`）—— 谁都不许再手拼；
 *   ② 把那一段常量的**正文**读出来（`readVoiceSource`）—— 聊天记录评审台拿它
 *      当"要改哪份文案"的当前版本，并把它的 sha 记进修改意见里（这样"这份意见
 *      针对哪一版文案"永远查得到）；
 *   ③ 抠出/替换那段常量（`extractStyleConstant` / `replaceStyleConstant` /
 *      `syncStyleConstant`）—— 给"改完文案要落回源码"的那条路用，**带三条守卫**。
 *
 * ── 三条守卫（都会**拒绝写**，而不是写坏半个文件）────────────────────────
 *   ① 找不到常量字面量 ⇒ 拒绝（不能猜位置）；
 *   ② 正文里有反引号 / `${` / 反斜杠 ⇒ 拒绝（模板字面量放不进去，
 *      硬写进去会让 `src/voice.mjs` 语法崩掉 —— 那是把整个桥接弄挂）；
 *   ③ 写完**复核**：重新抠一次常量，逐字等于目标文本才算成功。
 * 另有原子写（tmp + rename）与可选备份（与评审台那条路同一套纪律）。
 *
 * ⚠️ 本模块**不 import `voice.mjs`**（那是被读的对象，两边互相 import 就成了循环）。
 *    路径按包根算，与 `local.mjs` 的 `PKG_ROOT` 同一套口径。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 说话方式常量所在的文件（包根下的 `src/voice.mjs`）。 */
export function voiceSourcePath() {
  return join(dirname(fileURLToPath(import.meta.url)), 'voice.mjs')
}

/** 常量声明的开头（`export const VOICE_STYLE = \``）。 */
export const VOICE_CONST_HEAD = 'export const VOICE_STYLE = `'

/**
 * 常量名（不带 `export const` 前缀与反引号）。
 * ★ 抽出来是因为评审台要把它**显示给使用者**（"这份意见指向哪个常量"），
 *   而字符串字面量散在两处迟早不一致。
 */
export const VOICE_CONST_NAME = 'VOICE_STYLE'

/** 模板字面量里放不了的字符（放进去会让 JS 语法崩）。 */
export const FORBIDDEN_IN_CONSTANT = ['`', '${', '\\']

/** 文本的 sha256（页面/日志里显示前 8 位就够认人）。 */
export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/**
 * 从源码里抠出说话方式常量的内容（**纯函数**，不碰文件系统）。
 *
 * @returns {{body: string, start: number, end: number}|null}
 *   `start` = 正文起点，`end` = 结尾那个反引号的下标；找不到返回 null。
 */
export function extractStyleConstant(source) {
  const src = String(source ?? '')
  const head = src.indexOf(VOICE_CONST_HEAD)
  if (head < 0) return null
  const start = head + VOICE_CONST_HEAD.length
  const end = src.indexOf('`', start)
  if (end < 0) return null
  return { body: src.slice(start, end), start, end }
}

/** 常量内容与目标文本是否一致（用于"要不要写"的判断与事后复核）。
 *  ★ 按 **trim 后**比较：模板字面量结尾那个换行属于**排版**，不属于文案 ——
 *    把它算成"内容不同"会让同步工具每次都白写一遍（而且写完复核还要再判一次）。 */
export function constantMatches(source, styleText) {
  const found = extractStyleConstant(source)
  return Boolean(found) && found.body.trim() === String(styleText ?? '').trim()
}

/**
 * 把常量替换成 `styleText`（**纯函数**，返回新源码）。
 *
 * @returns {{ok: true, text: string, changed: boolean} | {ok: false, why: string}}
 */
export function replaceStyleConstant(source, styleText) {
  const src = String(source ?? '')
  const body = String(styleText ?? '')
  const found = extractStyleConstant(src)
  if (!found) return { ok: false, why: `在源码里找不到常量声明（应以 ${VOICE_CONST_HEAD} 开头）` }
  for (const bad of FORBIDDEN_IN_CONSTANT) {
    if (body.includes(bad)) {
      return {
        ok: false,
        why:
          `文本里有不能放进模板字面量的字符 ${JSON.stringify(bad)} —— ` +
          '硬写进去会让 src/voice.mjs 语法崩掉（整个桥接起不来），所以拒绝同步',
      }
    }
  }
  // ★ 只在**文案**不同时才写（结尾换行属于排版，不算不同；理由见 `constantMatches`）。
  if (found.body.trim() === body.trim()) return { ok: true, text: src, changed: false }
  return { ok: true, text: src.slice(0, found.start) + body + src.slice(found.end), changed: true }
}

/**
 * 读**当前这份说话方式**（评审台与它的测试用）。
 *
 * @param {{path?: string}} [opts] `path` 只给测试注入临时文件用；生产不传。
 * @returns {{ok: true, path: string, text: string, sha256: string, source: 'file'}
 *          | {ok: false, path: string, text: string, sha256: string, source: 'missing'|'unreadable', why: string}}
 */
export function readVoiceSource({ path } = {}) {
  const file = String(path ?? '') || voiceSourcePath()
  let source = ''
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    const missing = error?.code === 'ENOENT'
    return {
      ok: false,
      path: file,
      text: '',
      sha256: '',
      source: missing ? 'missing' : 'unreadable',
      why: missing ? `找不到 ${file}` : `读不出 ${file}：${error?.message ?? error}`,
    }
  }
  const found = extractStyleConstant(source)
  if (!found) {
    // ★ 这里**不回落**任何内置文本：读不到就是读不到，如实说。
    //   （0.3.0beta 的风格文件那条路会回落内置默认 —— 因为那份文件是可以被删的。
    //    这一份是**源码本身**，读不出来只可能是包坏了或路径错了，回落只会掩盖它。）
    return {
      ok: false,
      path: file,
      text: '',
      sha256: sha256(source),
      source: 'unreadable',
      why: `${file} 里找不到 ${VOICE_CONST_NAME} 常量`,
    }
  }
  const text = found.body.trim()
  return { ok: true, path: file, text, sha256: sha256(text), source: 'file' }
}

/**
 * 落盘：把一段文本同步进说话方式常量。
 *
 * @param {object} opts
 * @param {string} [opts.path]        `src/voice.mjs` 的绝对路径（默认按包根算）
 * @param {string} opts.styleText     要成为常量内容的文本（**完整正文**）
 * @param {boolean} [opts.backup]     写前是否备份（默认 true，落到同目录 `.backups/`）
 * @param {(m: string) => void} [opts.log]
 * @returns {{ok: boolean, changed?: boolean, backup?: string, sha256?: string, why?: string}}
 */
export function syncStyleConstant({ path, styleText, backup = true, log = () => {} } = {}) {
  const file = String(path ?? '') || voiceSourcePath()
  if (!existsSync(file)) return { ok: false, why: `找不到 ${file}` }
  let source = ''
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, why: `读不出 ${file}：${error?.message ?? error}` }
  }
  const next = replaceStyleConstant(source, styleText)
  if (!next.ok) return { ok: false, why: next.why }
  if (!next.changed) {
    log('[voice-sync] 常量已经是最新的（没变），不用写')
    return { ok: true, changed: false, sha256: sha256(source) }
  }

  let backupPath = ''
  if (backup) {
    try {
      const dir = join(dirname(file), '.backups')
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      backupPath = join(dir, `${file.split(/[\\/]/).pop()}.${stamp}.bak`)
      writeFileSync(backupPath, source, 'utf8')
    } catch (error) {
      return { ok: false, why: `备份失败（没敢继续写）：${error?.message ?? error}` }
    }
  }

  try {
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, next.text, 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    return { ok: false, why: `写 ${file} 失败（备份在 ${backupPath || '（没做）'}）：${error?.message ?? error}` }
  }

  // ★ 写完**复核**：重新抠一次，逐字等于目标才算成功。
  //   （只信"写进去了"而不复核，等于把"两份会漂"这件事交给运气。）
  let after = ''
  try {
    after = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, why: `写完读不回来：${error?.message ?? error}` }
  }
  const found = extractStyleConstant(after)
  if (!found || found.body.trim() !== String(styleText ?? '').trim()) {
    return { ok: false, why: `写完复核不一致（常量与目标不同）—— 请检查 ${file}`, backup: backupPath }
  }
  log(`[voice-sync] 已同步常量（${next.text.length - source.length >= 0 ? '+' : ''}${next.text.length - source.length} 字）${backupPath ? `，备份 ${backupPath}` : ''}`)
  return { ok: true, changed: true, backup: backupPath, sha256: sha256(after) }
}
