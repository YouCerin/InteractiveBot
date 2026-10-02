/**
 * **对话风格文件**（`styles/<名字>.md`）：闲聊态说什么话由它决定。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么是**文件**而不是配置里的一段字符串
 * ══════════════════════════════════════════════════════════════════════════
 * 与 `personas/` 完全同一条理由：这是一整段提示词材料（上千字），塞进
 * `config.json` 会有三个后果 —— 界面没法舒服地编辑、版本管理里 diff 难看、
 * 而且它会和"机器人怎么运行"的配置混在一起被整份回滚。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 与 `personas/` 的两处**刻意不同**（都是"这次要按消息逐轮切换"逼出来的）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **每轮现读**（人设是构造期缓存、改了要重启）。风格只在闲聊态用得上，
 *      而"改一句、下一轮就想看到效果"是这里的主要用法 —— 重启一次代价太大。
 *      实测这是安全的：文件很小（约 1.5KB），且与 `#nicknameFor` 每轮读
 *      `memory/contacts.md` 是同一条既有做法。
 *   ② **读不到不许静默**。人设那条路的规矩是"读不到就大声报错、**不退回内置**"
 *      （怕使用者以为自己在用那套人设）。这里**正好相反**：读不到就回落到
 *      `DEFAULT_CHAT_STYLE`（内置默认），**并且留一行日志**。
 *      差别的原因：人设是使用者亲手选的东西（不生效必须说），而风格是功能的
 *      默认值（没有它整个闲聊态就没意义）。但"回落"这件事本身**必须留痕** ——
 *      否则使用者会以为"我改的文件没生效"是别的原因。
 *
 * ★ 文件缺失时**不自动创建**。要恢复出厂那份得显式调用 `ensureDefaultChatStyle`
 *   （启动时只在**目录不存在或文件不存在**时落一次）。删掉之后不会自己回来 ——
 *   与 `personas.mjs` 的 `ensureDefaultPersonas`（只在空目录才落）同一条纪律：
 *   "删除必须是真的"。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_CHAT_STYLE } from './chat-mode.mjs'

/** 默认风格的文件名（不带 `.md`）。 */
export const DEFAULT_CHAT_STYLE_NAME = '闲聊'

/** 文件长度上限（与人设同级：超长说明写歪了，截断又会让措辞残缺）。 */
export const CHAT_STYLE_MAX_CHARS = 6000

/** 风格文件名合法形状（与 `personas.mjs` 的 `validatePersonaName` 同一套判据）。 */
export function validateChatStyleName(name) {
  const value = String(name ?? '').trim()
  if (!value) return { ok: false, why: '名字不能为空' }
  if (/[\\/:*?"<>|]/.test(value)) return { ok: false, why: '名字里不能有 \\ / : * ? " < > | 这些字符' }
  if (value.startsWith('.') || value.endsWith('.')) return { ok: false, why: '名字不能以点开头或结尾' }
  if ([...value].length > 24) return { ok: false, why: '名字最多 24 个字' }
  return { ok: true, value }
}

/**
 * 空名字 → 默认那份的**名字**（`''` → `闲聊`）。
 *
 * ★★ 为什么单独抽成一个函数（2026-10-02 踩到）：`chatStylePath()` 是**纯粹拼路径**的，
 *   它不认"空名字"这回事；而"空 = 用默认那份"这条规则原先只写在 `readChatStyle()` 里。
 *   于是任何**自己拼路径**的调用方（聊天记录评审台就是这么干的）在配置留空时
 *   会拼出 `<styles>/.md` —— 一个不存在的文件。表现出来是：
 *   "读到的是内置默认那份（看起来正常）"，而**应用草稿时把内容写进了那个假文件**，
 *   使用者的 `闲聊.md` 一个字都没变（评审台自己的测试抓到了它）。
 *   ∴ 这条规则只能有一处实现，谁要拼风格文件路径都得先过这里。
 */
export function resolveChatStyleName(name) {
  return String(name ?? '').trim() || DEFAULT_CHAT_STYLE_NAME
}

/** 风格文件路径（**唯一**拼路径的地方 —— 各处手拼迟早会分叉）。 */
export function chatStylePath({ dir, name }) {
  return join(dir, `${name}.md`)
}

/**
 * 读一份风格文件。
 *
 * @param {{dir: string, name: string}} opts
 * @returns {{ok: true, name: string, text: string, source: 'file'} |
 *           {ok: false, name: string, text: string, source: 'default'|'missing', why: string}}
 *   ★ 失败时**也带 text**（要么是内置默认，要么是空串）—— 调用方不必再判一次；
 *     `source` 如实说明这份文本是哪来的，日志与界面靠它区分"用了文件"与"回落了"。
 */
export function readChatStyle({ dir, name } = {}) {
  const wanted = resolveChatStyleName(name)
  if (!dir) {
    return { ok: false, name: wanted, text: DEFAULT_CHAT_STYLE, source: 'default', why: '没有配置风格目录' }
  }
  const p = chatStylePath({ dir, name: wanted })
  let raw
  try {
    raw = readFileSync(p, 'utf8')
  } catch (error) {
    const missing = error?.code === 'ENOENT'
    return {
      ok: false,
      name: wanted,
      text: DEFAULT_CHAT_STYLE,
      source: missing ? 'missing' : 'default',
      why: missing
        ? `风格文件不存在：${p}（已用内置默认那份；要改就新建这个文件）`
        : `风格文件读不出来（${error?.message ?? error}）（已用内置默认那份）`,
    }
  }
  const text = String(raw).trim()
  if (!text) {
    return { ok: false, name: wanted, text: DEFAULT_CHAT_STYLE, source: 'default', why: `风格文件是空的：${p}（已用内置默认那份）` }
  }
  if ([...text].length > CHAT_STYLE_MAX_CHARS) {
    // ★ 超长**不截断**，也**不拒载**：风格是一段散文，截断会把句子砍半
    //   （"不要写……"被砍掉后半句，意思正好反了）。如实警告并照用 ——
    //   代价只是 token，而截断的代价是措辞错误。
    //   ★ `ok:true` 但带上 `tooLong`：调用方据此记一行日志，而不是把它当"读失败"。
    return {
      ok: true,
      name: wanted,
      text,
      source: 'file',
      tooLong: true,
      why: `风格文件超过 ${CHAT_STYLE_MAX_CHARS} 字（${[...text].length} 字），照用但会吃 token`,
    }
  }
  return { ok: true, name: wanted, text, source: 'file' }
}

/** 列出风格目录里有哪些（给日志/界面用；读不到就返回空数组，不抛）。 */
export function listChatStyles({ dir } = {}) {
  if (!dir) return []
  try {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .filter((f) => {
        try {
          return statSync(join(dir, f)).isFile()
        } catch {
          return false
        }
      })
      .map((f) => f.slice(0, -3))
      .sort()
  } catch {
    return []
  }
}

/**
 * 出厂默认那份风格文件：**只在文件不存在时**落一次。
 *
 * @returns {{created: boolean, path: string}}
 */
export function ensureDefaultChatStyle({ dir, log = () => {} } = {}) {
  const p = chatStylePath({ dir, name: DEFAULT_CHAT_STYLE_NAME })
  if (!dir) return { created: false, path: p }
  try {
    if (existsSync(p)) return { created: false, path: p }
    mkdirSync(dir, { recursive: true })
    writeFileSync(p, DEFAULT_CHAT_STYLE, 'utf8')
    return { created: true, path: p }
  } catch (error) {
    // 落不下就只记一行 —— 功能本身照常（读不到会回落内置默认），
    // 但**必须留痕**：否则使用者会以为"文件应该在的"。
    log(`⚠️ [chat-mode] 默认风格文件没落成（不影响使用，会走内置默认那份）：${error?.message ?? error}`)
    return { created: false, path: p }
  }
}
