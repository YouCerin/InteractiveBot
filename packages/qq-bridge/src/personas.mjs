/**
 * 人设库：**一个文件一套人设，按需切换**（0.2.2）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它取代了什么
 * ══════════════════════════════════════════════════════════════════════════
 * 之前：`persona.preset` 三选一（完整/精简/不用）+ 一个 `persona.custom` 文本。
 * 那是"同一套人设的三个档 + 一个自定义"的形状，存不下**多套**人设，
 * 也没法给一套人设起名字。
 *
 * 现在：`personas/<名字>.md` —— 每一套人设是**一个文件**，文件名叫什么，人设栏里就叫什么。
 *   · 默认那两套（小鲸鱼·精简 / 小鲸鱼·完整）**也是其中两个文件**，一样能改、能复制、能删；
 *   · 新建时**必须给名字**（名字就是文件名，显示在人设栏里）；
 *   · 切换 = 改 `persona.active`（写配置 → **需要重启**，人设是构造期缓存的）。
 *
 * ── 为什么放包根、不放工作区（这条是硬约束）──────────────────────────────
 * 人设会被拼进系统提示词的**高优先级位置**，而工作区是 agent 有写权限的沙箱。
 * 把 `personas/` 放进工作区 = 让 agent 能改自己的"人格设定" —— 那是 H12 一直在防的事。
 * 放包根还有一个好处：包搬走它跟着走（与 `skills/`、`config.json` 一致）。
 *
 * ── 与老配置的关系（向后兼容，不许静默改变行为）──────────────────────────
 *   · `persona.active` 有值 → 用那个文件；
 *   · `persona.active` 是 `none` → 不用人设（只用平台规则）；
 *   · `persona.active` 为空（老配置）→ **回落到老逻辑**：`persona.custom` 非空就用它，
 *     否则用 `persona.preset`（内置预设，代码里的常量）。
 *   `resolveActivePersona()` 把这三条收在一处，桥接与自检共用同一个口径。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { DIRS } from './local.mjs'
import { PERSONA_PRESETS, DEFAULT_PERSONA_PRESET, PERSONA_MAX_CHARS, scanPersonaText } from './persona.mjs'

/** 不使用时设这个值（比"空"更明确：空是"没配过，走老逻辑"）。 */
export const PERSONA_NONE = 'none'

/** 一套人设的名字（= 文件名去掉扩展名）的合法形状：
 *  非空、≤24 字、不含路径分隔符与 Windows 保留字符、不以点开头/结尾。 */
const NAME_RE = /^(?!\.)[^\\/:*?"<>|\u0000-\u001F]{1,24}(?<!\.)$/

/** 默认那两套人设（**也是文件**，只是"出厂时就摆在那儿"）。顺序 = 界面上的顺序。 */
export const DEFAULT_PERSONA_FILES = [
  { name: '小鲸鱼（精简）', text: PERSONA_PRESETS['mermaid-lite'] },
  { name: '小鲸鱼（完整）', text: PERSONA_PRESETS.mermaid },
]

/** 新建人设时的起手模板（**空模板**：只给名字块和几条提示，不替用户写性格）。 */
export const PERSONA_TEMPLATE = `【名字（机器可读，改格式会让"叫名字"失效）】
正式名: 换个名字
别名: 
又称: 

【你是谁】

【怎么说话】

【别做的事】
`

/** 目录（可注入，便于测试）。 */
function dirOf(dir) {
  return dir || DIRS.personas
}

/** 校验一个名字能不能当文件名。 */
export function validatePersonaName(name) {
  const n = String(name ?? '').trim()
  if (!n) return { ok: false, error: '名字不能为空' }
  if (!NAME_RE.test(n)) {
    return {
      ok: false,
      error: `名字不合法：「${n}」—— 不能含 \\ / : * ? " < > | 这些字符，不能以点开头或结尾，最长 24 字`,
    }
  }
  if (n === PERSONA_NONE) return { ok: false, error: `「${PERSONA_NONE}」是保留名（表示"不用人设"），换一个` }
  return { ok: true, value: n }
}

/** 名字 → 绝对路径（并确认没跑出目录）。 */
function pathOf(dir, name) {
  const check = validatePersonaName(name)
  if (!check.ok) return { ok: false, error: check.error }
  const root = resolve(dirOf(dir))
  const abs = resolve(root, `${check.value}.md`)
  if (!abs.startsWith(root + sep)) return { ok: false, error: '路径跑出了人设目录' }
  return { ok: true, abs, name: check.value }
}

/**
 * 首次使用时把默认那两套**落成文件**。
 *
 * ★ 只在目录**不存在或一个文件都没有**时落 —— 使用者把某一套删掉/改名了，
 *   我们不能每次启动都把它变回来（那会让"删除"变成假的）。
 */
export function ensureDefaultPersonas({ dir } = {}) {
  const root = dirOf(dir)
  const created = []
  try {
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
    else {
      const has = readdirSync(root, { withFileTypes: true }).some((e) => e.isFile() && e.name.endsWith('.md'))
      if (has) return { ok: true, created }
    }
    for (const p of DEFAULT_PERSONA_FILES) {
      const abs = join(root, `${p.name}.md`)
      if (existsSync(abs)) continue
      writeFileSync(abs, p.text.endsWith('\n') ? p.text : `${p.text}\n`, 'utf8')
      created.push(p.name)
    }
  } catch (error) {
    return { ok: false, error: `建不了人设目录：${error?.message ?? error}`, created }
  }
  return { ok: true, created }
}

/**
 * 列出全部人设（含大小与最后修改时间；`active` 标记由调用方传入的配置决定）。
 *
 * ★ **纯读，不落文件**。默认那两套的落地由 `ensureDefaultPersonas()` 在**启动时**做一次；
 *   如果把"落默认"挂在这个函数上，那"把所有人设都删掉"就永远不成立 ——
 *   下一次打开控制台（会调它）默认两套又会自己回来。
 */
export function listPersonas({ dir, active } = {}) {
  const root = dirOf(dir)
  let names = []
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name.slice(0, -3))
  } catch {
    return { ok: true, dir: root, personas: [], active: active ?? '' }
  }
  const personas = names
    .map((name) => {
      const abs = join(root, `${name}.md`)
      let chars = 0
      let mtime = 0
      let text = ''
      try {
        text = readFileSync(abs, 'utf8')
        chars = text.trim().length
        mtime = statSync(abs).mtimeMs
      } catch {
        /* 读不到就按 0 显示，不抛 */
      }
      return {
        name,
        chars,
        mtime,
        text,
        active: active === name,
        isDefault: DEFAULT_PERSONA_FILES.some((d) => d.name === name),
        // 没有名字块的人设"叫名字"会回落到兜底名 —— 界面要提示（这是静默失效的高发处）
        hasNameBlock: text.includes('【名字（机器可读'),
        // ★★ 会在**启动时被整文件拒载**的那一类（H12 反注入扫描）。
        //   为什么列表里就要标出来：不标的话，界面显示"正在用它"、而实际注入的是 `[BLOCKED]` ——
        //   使用者只会看到"机器人说话怪怪的"，猜不到是这份人设被拒了。
        blocked: text.trim() ? !scanPersonaText(text).ok : false,
      }
    })
    // 默认那两套排前面（顺序稳定），其余按名字排
    .sort((a, b) => {
      const ia = DEFAULT_PERSONA_FILES.findIndex((d) => d.name === a.name)
      const ib = DEFAULT_PERSONA_FILES.findIndex((d) => d.name === b.name)
      if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
      return a.name.localeCompare(b.name)
    })
  return { ok: true, dir: root, personas, active: active ?? '' }
}

/** 读一套人设的正文。 */
export function readPersona({ dir, name } = {}) {
  const p = pathOf(dir, name)
  if (!p.ok) return { ok: false, error: p.error }
  if (!existsSync(p.abs)) return { ok: false, error: `没有这套人设：${p.name}` }
  try {
    return { ok: true, name: p.name, text: readFileSync(p.abs, 'utf8') }
  } catch (error) {
    return { ok: false, error: `读不了：${error?.message ?? error}` }
  }
}

/** 保存一套人设的正文（不存在就是新建）。 */
export function savePersona({ dir, name, text } = {}) {
  const p = pathOf(dir, name)
  if (!p.ok) return { ok: false, error: p.error }
  const body = String(text ?? '')
  if (!body.trim()) return { ok: false, error: '人设正文不能为空（想让它不用人设，请选「不使用人设」）' }
  if (body.trim().length > PERSONA_MAX_CHARS) {
    return { ok: false, error: `正文 ${body.trim().length} 字，超过上限 ${PERSONA_MAX_CHARS} 字（超长会被"头+省略+尾"截断）` }
  }
  try {
    mkdirSync(dirOf(dir), { recursive: true })
    writeFileSync(p.abs, body.endsWith('\n') ? body : `${body}\n`, 'utf8')
  } catch (error) {
    return { ok: false, error: `写不了：${error?.message ?? error}` }
  }
  return { ok: true, name: p.name }
}

/** 新建一套人设（**必须给名字**；正文默认给空模板）。 */
export function createPersona({ dir, name, text, copyFrom } = {}) {
  const check = validatePersonaName(name)
  if (!check.ok) return { ok: false, error: check.error }
  const p = pathOf(dir, check.value)
  if (!p.ok) return { ok: false, error: p.error }
  if (existsSync(p.abs)) return { ok: false, error: `已经有叫「${check.value}」的人设了（换一个名字，或直接改那一套）` }
  let body = text
  if (body === undefined && copyFrom) {
    const src = readPersona({ dir, name: copyFrom })
    if (!src.ok) return { ok: false, error: `复制失败：${src.error}` }
    body = src.text
  }
  if (body === undefined) body = PERSONA_TEMPLATE
  return savePersona({ dir, name: check.value, text: body })
}

/** 改名（文件重命名；`persona.active` 的跟随由调用方处理）。 */
export function renamePersona({ dir, from, to } = {}) {
  const a = pathOf(dir, from)
  const b = pathOf(dir, to)
  if (!a.ok) return { ok: false, error: a.error }
  if (!b.ok) return { ok: false, error: b.error }
  if (!existsSync(a.abs)) return { ok: false, error: `没有这套人设：${a.name}` }
  if (existsSync(b.abs)) return { ok: false, error: `已经有叫「${b.name}」的人设了` }
  try {
    renameSync(a.abs, b.abs)
  } catch (error) {
    return { ok: false, error: `改名失败：${error?.message ?? error}` }
  }
  return { ok: true, from: a.name, to: b.name }
}

/** 删除一套人设。 */
export function deletePersona({ dir, name } = {}) {
  const p = pathOf(dir, name)
  if (!p.ok) return { ok: false, error: p.error }
  if (!existsSync(p.abs)) return { ok: false, error: `没有这套人设：${p.name}` }
  try {
    // ⚠️ 用 `unlinkSync`，**不要改成 `rmSync`**（与 memory-files / tasks / recipes 同一教训）。
    // 实测（Node v24.9.0 / Windows）：`rmSync(单个文件)` 对**中文文件名**要么静默失败、
    // 要么直接把进程崩掉（退出码 -1073740791 = STATUS_STACK_BUFFER_OVERRUN，
    // 连 try/catch 都接不住）—— 而人设文件名默认就是中文（`小鲸鱼（精简）.md`），
    // 也就是说"删除人设"这条路上 `rmSync` 一定踩到。
    unlinkSync(p.abs)
  } catch (error) {
    return { ok: false, error: `删不掉：${error?.message ?? error}` }
  }
  // 复核：不信任"调用没报错"就等于"真的删掉了"（上面那个教训）。
  if (existsSync(p.abs)) return { ok: false, error: '删除后文件仍然存在（可能被占用）' }
  // ★ 删完一份都不剩时**不自动把默认补回来** —— "删了却又自己回来"会让删除变成假的。
  //   界面给一个明确的「恢复默认两套」按钮（`restoreDefaultPersonas`），由人决定。
  return { ok: true, name: p.name }
}

/**
 * 明确要求时把默认那两套补回来（**只在人点了按钮时调**，不在删除后自动调）。
 * 已存在的（含改过内容的）**不动** —— 它可能已经是使用者自己的东西了。
 */
export function restoreDefaultPersonas({ dir } = {}) {
  const root = dirOf(dir)
  const created = []
  try {
    mkdirSync(root, { recursive: true })
    for (const p of DEFAULT_PERSONA_FILES) {
      const abs = join(root, `${p.name}.md`)
      if (existsSync(abs)) continue
      writeFileSync(abs, p.text.endsWith('\n') ? p.text : `${p.text}\n`, 'utf8')
      created.push(p.name)
    }
  } catch (error) {
    return { ok: false, error: `补不了：${error?.message ?? error}`, created }
  }
  return { ok: true, created }
}

/**
 * **当前生效**的那一套人设（桥接与自检共用同一口径）。
 *
 * 优先级（写死在这里，别在别处再判一遍）：
 *   ① `persona.active` = 某个文件 → 用它；
 *   ② `persona.active` = `none` → 不用人设；
 *   ③ `persona.active` 为空 → 老逻辑：`persona.custom`（非空）→ `persona.preset`（内置常量）。
 *
 * @returns {{ source: 'file'|'none'|'legacy-custom'|'legacy-preset', name: string, text: string, error?: string }}
 */
export function resolveActivePersona({ dir, config } = {}) {
  const p = config?.persona ?? {}
  const active = String(p.active ?? '').trim()
  if (active === PERSONA_NONE) return { source: 'none', name: '不使用人设', text: '' }
  if (active) {
    const r = readPersona({ dir, name: active })
    if (!r.ok) {
      // ★ 配了但读不到：**不静默退回内置**（那会让使用者以为"我的人设在用"）。
      //   交给调用方按"空人设 + 一条 error"处理，并在日志/自检里报出来。
      return { source: 'file', name: active, text: '', error: r.error }
    }
    return { source: 'file', name: r.name, text: r.text }
  }
  const custom = String(p.custom ?? '').trim()
  if (custom) return { source: 'legacy-custom', name: '自定义人设（老配置）', text: custom }
  return {
    source: 'legacy-preset',
    name: p.preset || DEFAULT_PERSONA_PRESET,
    text: PERSONA_PRESETS[p.preset || DEFAULT_PERSONA_PRESET] ?? '',
  }
}

/**
 * 人设栏的**写动作**（界面上的新建/保存/改名/删除/切换/恢复默认都走这一个函数）。
 *
 * 为什么收在一处：这些动作有共同的**两个易错点**，分散实现必然有人漏掉 ——
 *   ① 改了正在用的那一套（或删了它）→ 运行中的桥接还在用旧文本，必须如实回 `restartRequired`；
 *   ② 删/改了 `persona.active` 指的那一套 → 配置必须跟着改（否则下次启动直接"读不到文件"）。
 *
 * 本函数**只算，不写配置**：返回的 `nextActive` 由调用方落盘（那一套校验/备份纪律在 index.mjs）。
 * 这样这个文件能离线测（`mocks/verify-personas.mjs` 就是靠这条）。
 *
 * @returns {{ok:true, action:string, nextActive?:string, restartRequired:boolean, hint:string, [k:string]:any}
 *          | {ok:false, error:string, status?:number}}
 */
export function applyPersonaAction({ dir, config, action, name, to, text, copyFrom } = {}) {
  const act = String(action ?? '').trim()
  const active = String(config?.persona?.active ?? '').trim()
  const done = (extra, hints) => ({ ok: true, action: act, ...extra, ...hints })

  switch (act) {
    case 'create': {
      const r = createPersona({ dir, name, text, copyFrom })
      if (!r.ok) return { ok: false, error: r.error, status: 422 }
      // 新建**不动**正在用的那套 → 不需要重启（它只是多了一个可选文件）
      return done({ name: r.name, restartRequired: false }, { hint: `已新建人设「${r.name}」。想用它请点「切换」（切换要重启才生效）。` })
    }

    case 'save': {
      const r = savePersona({ dir, name, text })
      if (!r.ok) return { ok: false, error: r.error, status: 422 }
      const isActive = r.name === active
      return done(
        { name: r.name, restartRequired: isActive },
        {
          hint: isActive
            ? `已保存。**这是当前正在用的人设**，需要重启机器人后生效。`
            : `已保存「${r.name}」（它现在没在用，不影响运行中的机器人）。`,
        },
      )
    }

    case 'rename': {
      const r = renamePersona({ dir, from: name, to })
      if (!r.ok) return { ok: false, error: r.error, status: 422 }
      const follow = r.from === active ? { nextActive: r.to } : {}
      return done(
        { from: r.from, to: r.to, restartRequired: r.from === active, ...follow },
        {
          hint: r.from === active
            ? `已改名为「${r.to}」，当前正在用的就是它（配置已跟着改）。需要重启机器人后生效。`
            : `已改名为「${r.to}」（它现在没在用）。`,
        },
      )
    }

    case 'delete': {
      const r = deletePersona({ dir, name })
      if (!r.ok) return { ok: false, error: r.error, status: 422 }
      const wasActive = r.name === active
      return done(
        { name: r.name, restartRequired: wasActive, ...(wasActive ? { nextActive: PERSONA_NONE } : {}) },
        {
          hint: wasActive
            ? `已删除「${r.name}」—— **它正是当前在用的那一套**，所以现在切到了「不使用人设」。需要重启机器人才真正停下来。`
            : `已删除「${r.name}」。`,
        },
      )
    }

    case 'activate': {
      const want = String(name ?? '').trim()
      if (want === PERSONA_NONE) {
        return done(
          { name: PERSONA_NONE, nextActive: PERSONA_NONE, restartRequired: true },
          { hint: '已切到「不使用人设」（只用平台规则）。需要重启机器人后生效。' },
        )
      }
      const r = readPersona({ dir, name: want })
      if (!r.ok) return { ok: false, error: `切不了：${r.error}`, status: 422 }
      return done(
        { name: r.name, nextActive: r.name, restartRequired: r.name !== active },
        {
          hint:
            r.name === active
              ? '它已经是在用的那一套了，配置没变。'
              : `已切到「${r.name}」。需要重启机器人后生效（人设在启动时只读一次）。`,
        },
      )
    }

    case 'restore-defaults': {
      const r = restoreDefaultPersonas({ dir })
      if (!r.ok) return { ok: false, error: r.error, status: 422 }
      // 只有在用的那一套**被补回来**时才算影响运行中的桥接（此前它是读不到 → 没用人设）
      const affects = r.created.includes(active)
      return done(
        { created: r.created, restartRequired: affects },
        {
          hint: r.created.length
            ? `补回了：${r.created.join('、')}。已存在的人设**没有被覆盖**。${affects ? '（其中包含正在用的那一套，需要重启才生效。）' : ''}`
            : '默认那两套都在，什么都没做。',
        },
      )
    }

    default:
      return { ok: false, error: `不认识的动作：${act || '（空）'}`, status: 400 }
  }
}

/** 给界面/CLI 的完整描述（人设栏要的那些事实）。 */
export function describePersonaShelf({ dir, config } = {}) {
  const active = String(config?.persona?.active ?? '').trim()
  const list = listPersonas({ dir, active })
  const resolved = resolveActivePersona({ dir, config })
  // 当前这一套会不会在**启动时被整文件拒载**（判据与运行时同一份实现，不另写一套）
  const scan = resolved.text ? scanPersonaText(resolved.text) : { ok: true, reasons: [] }
  return {
    dir: list.dir,
    active: active || '',
    activeSource: resolved.source,
    activeName: resolved.name,
    activeChars: resolved.text.length,
    activeError: resolved.error ?? '',
    // ★★ 被拒载：界面必须用红色说清"这一套装不上去"，否则使用者只会觉得"机器人说话怪怪的"
    activeBlocked: !scan.ok,
    activeBlockReasons: scan.reasons ?? [],
    // 老配置在用人设时，界面要给出"把它存成文件"的引导（否则它永远不会出现在人设栏里）
    legacy: active
      ? null
      : {
          preset: String(config?.persona?.preset ?? ''),
          customChars: String(config?.persona?.custom ?? '').trim().length,
        },
    personas: list.personas.map((x) => ({ name: x.name, chars: x.chars, mtime: x.mtime, active: x.active, isDefault: x.isDefault, hasNameBlock: x.hasNameBlock, blocked: x.blocked, text: x.text })),
    template: PERSONA_TEMPLATE,
    maxChars: PERSONA_MAX_CHARS,
  }
}
