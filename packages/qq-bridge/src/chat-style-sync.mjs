/**
 * **对话风格文件 ↔ 内置默认常量** 的同步（`styles/闲聊.md` ↔ `src/chat-mode.mjs` 的 `DEFAULT_CHAT_STYLE`）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（以及为什么它不该是"临时脚本"）
 * ══════════════════════════════════════════════════════════════════════════
 * 这两份是**同一个东西的两种存在形式**：
 *   · `styles/闲聊.md` —— 使用者实际在用的那份（桥接**每轮现读**）；
 *   · `src/chat-mode.mjs` 里的 `DEFAULT_CHAT_STYLE` —— 文件**不存在时**的出厂默认。
 * 第一版是手工同步的，而 `mocks/verify-chat-mode.mjs` 有一条断言盯着两边逐字一致
 * （理由：不能有两份会漂的文案）。于是每次改风格文件都要跑一段临时脚本 ——
 * 一共写过三次，每次都是"改完发现测试红了才想起来"。
 *
 * 聊天记录评审台要**按需精简整份闲聊.md**（用户 2026-10-02 的要求），这条同步就从
 * "偶尔手工"变成"每次应用草稿都要做"。∴ 把它抽成模块：一处实现、有守卫、有测试，
 * 工具与人都用同一份。
 *
 * ── 三条守卫（都会**拒绝写**，而不是写坏半个文件）────────────────────────
 *   ① 找不到常量字面量 ⇒ 拒绝（不能猜位置）；
 *   ② 正文里有反引号 / `${` / 反斜杠 ⇒ 拒绝（模板字面量放不进去，
 *      硬写进去会让 `src/chat-mode.mjs` 语法崩掉 —— 那是把整个桥接弄挂）；
 *   ③ 写完**复核**：重新抠一次常量，逐字等于目标文本才算成功。
 * 另有原子写（tmp + rename）与可选备份（与评审台那条路同一套纪律）。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 常量声明的开头（`export const DEFAULT_CHAT_STYLE = \``）。 */
export const STYLE_CONST_HEAD = 'export const DEFAULT_CHAT_STYLE = `'

/** 模板字面量里放不了的字符（放进去会让 JS 语法崩）。 */
export const FORBIDDEN_IN_CONSTANT = ['`', '${', '\\']

/** 文本的 sha256（页面/日志里显示前 8 位就够认人）。 */
export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/**
 * 从 `chat-mode.mjs` 的源码里抠出常量的内容（**纯函数**，不碰文件系统）。
 *
 * @returns {{body: string, start: number, end: number}|null}
 *   `start` = 正文起点，`end` = 结尾那个反引号的下标；找不到返回 null。
 */
export function extractStyleConstant(source) {
  const src = String(source ?? '')
  const head = src.indexOf(STYLE_CONST_HEAD)
  if (head < 0) return null
  const start = head + STYLE_CONST_HEAD.length
  const end = src.indexOf('`', start)
  if (end < 0) return null
  return { body: src.slice(start, end), start, end }
}

/** 常量内容与目标文本是否一致（用于"要不要写"的判断与事后复核）。 */
export function constantMatches(source, styleText) {
  const found = extractStyleConstant(source)
  return Boolean(found) && found.body === String(styleText ?? '')
}

/**
 * 把 `src/chat-mode.mjs` 里的常量替换成 `styleText`（**纯函数**，返回新源码）。
 *
 * @returns {{ok: true, text: string, changed: boolean} | {ok: false, why: string}}
 */
export function replaceStyleConstant(source, styleText) {
  const src = String(source ?? '')
  const body = String(styleText ?? '')
  const found = extractStyleConstant(src)
  if (!found) return { ok: false, why: `在源码里找不到常量声明（应以 ${STYLE_CONST_HEAD} 开头）` }
  for (const bad of FORBIDDEN_IN_CONSTANT) {
    if (body.includes(bad)) {
      return {
        ok: false,
        why:
          `风格文本里有不能放进模板字面量的字符 ${JSON.stringify(bad)} —— ` +
          '硬写进去会让 src/chat-mode.mjs 语法崩掉（整个桥接起不来），所以拒绝同步',
      }
    }
  }
  if (found.body === body) return { ok: true, text: src, changed: false }
  return { ok: true, text: src.slice(0, found.start) + body + src.slice(found.end), changed: true }
}

/**
 * 落盘：把风格文件的内容同步进常量。
 *
 * @param {object} opts
 * @param {string} opts.chatModePath  `src/chat-mode.mjs` 的绝对路径
 * @param {string} opts.styleText     风格文件的**完整正文**（要成为常量内容的那份）
 * @param {boolean} [opts.backup]     写前是否备份（默认 true，落到同目录 `.backups/`）
 * @param {(m: string) => void} [opts.log]
 * @returns {{ok: boolean, changed?: boolean, backup?: string, sha256?: string, why?: string}}
 */
export function syncStyleConstant({ chatModePath, styleText, backup = true, log = () => {} } = {}) {
  const path = String(chatModePath ?? '')
  if (!path) return { ok: false, why: '没有给 chat-mode.mjs 的路径' }
  if (!existsSync(path)) return { ok: false, why: `找不到 ${path}` }
  let source = ''
  try {
    source = readFileSync(path, 'utf8')
  } catch (error) {
    return { ok: false, why: `读不出 ${path}：${error?.message ?? error}` }
  }
  const next = replaceStyleConstant(source, styleText)
  if (!next.ok) return { ok: false, why: next.why }
  if (!next.changed) {
    log('[style-sync] 常量已经是最新的（没变），不用写')
    return { ok: true, changed: false, sha256: sha256(source) }
  }

  let backupPath = ''
  if (backup) {
    try {
      const dir = join(dirname(path), '.backups')
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      backupPath = join(dir, `${path.split(/[\\/]/).pop()}.${stamp}.bak`)
      writeFileSync(backupPath, source, 'utf8')
    } catch (error) {
      return { ok: false, why: `备份失败（没敢继续写）：${error?.message ?? error}` }
    }
  }

  try {
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, next.text, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    return { ok: false, why: `写 ${path} 失败（备份在 ${backupPath || '（没做）'}）：${error?.message ?? error}` }
  }

  // ★ 写完**复核**：重新抠一次，逐字等于目标才算成功。
  //   （只信"写进去了"而不复核，等于把"两份会漂"这件事交给运气。）
  let after = ''
  try {
    after = readFileSync(path, 'utf8')
  } catch (error) {
    return { ok: false, why: `写完读不回来：${error?.message ?? error}` }
  }
  if (!constantMatches(after, styleText)) {
    return { ok: false, why: '写完复核不一致（常量与风格文件内容不同）—— 请检查 src/chat-mode.mjs', backup: backupPath }
  }
  log(`[style-sync] 已同步常量（${next.text.length - source.length >= 0 ? '+' : ''}${next.text.length - source.length} 字）${backupPath ? `，备份 ${backupPath}` : ''}`)
  return { ok: true, changed: true, backup: backupPath, sha256: sha256(after) }
}
