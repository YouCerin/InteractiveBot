/**
 * 扩展内核：**外部技能（skill）**的发现、清单校验、设置合并与提示词片段。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个模块在整个扩展体系里的位置
 * ══════════════════════════════════════════════════════════════════════════
 * 0.2.2 起本项目有两型扩展（详见 `docs/插件设计规范.md`）：
 *
 *   · **技能（skill）**＝外部自包含能力包：`skills/<id>/skill.json` + 一个 ESM 入口。
 *     它给模型**加工具**、给提示词**加片段**、给自己的设置**加界面**。
 *     ← **本模块负责它的全部"宿主侧"逻辑**（发现、校验、设置、命名、片段）。
 *   · **插件（plugin）**＝桥接内置能力块（记忆/看图/QQ 工具/人味层…）。
 *     ← 见 `src/plugins.mjs`（纯声明表，不改行为，只把既有开关登记出来）。
 *
 * ── 一条硬纪律：本模块**不执行**技能的 `execute()`，也**不碰** OneBot ──────────
 * 工具执行发生在 MCP 子进程（`mcp/mcp-skills-server.mjs`），提示词片段发生在桥接主进程。
 * 两处都从这里取同一份清单与同一份设置合并规则 —— 规则只有一份，
 * 否则"界面显示的默认值"与"运行时真正用的值"就会各说各话（上游踩过：见 skill.json 的 `_note_switch`）。
 *
 * ── 为什么不把技能设置写进 config.mjs 的默认值里 ─────────────────────────────
 * 技能是**装上去才有**的东西，它的键集由 `skill.json` 决定，宿主编译期不可能知道。
 * 所以 `config.skills.<id>` 在 config.mjs 里被**原样保留**（不做白名单收敛），
 * 真正的"默认值填充 + 类型收敛"在这里按清单做 —— 这样新增技能不需要改宿主的任何代码。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { join, resolve, isAbsolute, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 本宿主实现的技能清单版本。技能清单里必须写同一个数字。 */
export const SKILL_API_VERSION = 1

/**
 * 技能工具对模型可见的名字里，那个 MCP 服务器名。
 *
 * ⚠️ 为什么必须由本模块**唯一**决定：模型看到的工具名是 DSH 的 MCP 客户端
 * 按 `mcp__<serverName>__<toolName>` 拼出来的（实测：`qq_poke` → `mcp__qq__qq_poke`）。
 * 技能自己在提示词里写死 `pixiv-lookup__search` 那样的名字时，模型会去调一个**不存在**的工具
 * —— 而且失败得很安静（模型只会说"查不到"）。所以全项目只有这一个函数知道命名规则，
 * 技能通过 `api.toolName(toolId)` 拿到自己的真实工具名。
 */
export const SKILLS_SERVER_NAME = 'skills'

/** QQ 工具 MCP 服务器的名字（决定模型看到的 `mcp__qq__…` 前缀）。 */
export const QQ_SERVER_NAME = 'qq'

/**
 * 宿主**自己的**工具，供技能在提示词里引用（模型看到的全名）。
 *
 * 为什么需要这张表：技能常常要"把结果交给宿主的某个能力"（pixiv 就是"把直链交给发图工具"）。
 * 上游宿主把工具名叫 `send_image`，而本宿主叫 `qq_send_image` 且带 `mcp__qq__` 前缀 ——
 * 技能里写死名字就必然调不通。所以由宿主在这里给出**唯一**的映射，
 * 技能通过 `api.hostTool('send_image')` 取（见 `skills/pixiv-lookup/index.js` 的适配③）。
 */
export const HOST_TOOLS = {
  send_image: `mcp__${QQ_SERVER_NAME}__qq_send_image`,
}

/** 技能工具的完整可见名（模型看到的那个）。 */
export function skillToolFullName(skillId, toolId) {
  return `mcp__${SKILLS_SERVER_NAME}__${String(skillId)}__${String(toolId)}`
}

/**
 * 技能工具在 **MCP 服务器里自报的名字**（不含 `mcp__<server>__` 前缀）。
 *
 * 为什么要单独一个函数：前缀是 DSH 的 MCP 客户端加的，我们自报的是裸名。
 * 两边各拼一半，中间隔着一个我们控制不了的进程 —— 所以"哪一半由谁拼"
 * 必须写死在一处，否则改一处就会出现"模型看到的工具名"与"服务器认的工具名"对不上，
 * 表现是**调用一个存在的工具却报"没有这个工具"**。
 */
export function skillToolLocalName(skillId, toolId) {
  return `${String(skillId)}__${String(toolId)}`
}

/** 技能 id 的形状：小写字母/数字/短横线，长度 2-40。 */
const ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/

/** 工具 id 的形状（`pixiv-lookup__search` 里后半段那个）。 */
const TOOL_ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/

/** 允许的字段类型（configSchema）。`secret` 是修饰符，不是类型。 */
const FIELD_TYPES = new Set(['boolean', 'string', 'number', 'integer', 'enum'])

/* ══════════════════════════════════════════════════════════════════════════
   1. 清单校验
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 校验一份技能清单。
 *
 * 分成两级：
 *   · **errors** = 装了也不能用（缺 entry、apiVersion 不对、id 非法…）→ 宿主拒绝加载。
 *   · **warnings** = 能跑但有隐患（设置项没有界面、界面字段没有默认值、密钥明文…）→ 加载但报出来。
 *
 * ★ 为什么 warnings 也必须存在、而且必须**上界面**：技能最容易的坏法是"静默失效"——
 *   设置项在界面上根本不出现（用户以为设了）、声明了工具但没注册（模型调了报错）。
 *   这些都不会让程序崩，只会让人以为"这功能没用"。
 *
 * @param {object} manifest 解析后的 skill.json
 * @param {{ dir?: string }} [opts]
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateSkillManifest(manifest, { dir } = {}) {
  const errors = []
  const warnings = []
  const m = manifest ?? {}

  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, errors: ['skill.json 不是一个对象'], warnings }
  }

  // ── 身份 ────────────────────────────────────────────────────────────────
  if (!ID_RE.test(String(m.id ?? ''))) {
    errors.push(`id 不合法（「${m.id ?? '（缺）'}」）：只能是小写字母/数字/短横线，长度 2-40`)
  }
  if (!String(m.name ?? '').trim()) errors.push('name 不能为空（界面上显示的就是它）')
  if (!String(m.version ?? '').trim()) errors.push('version 不能为空（用于显示与排障）')
  if (Number(m.apiVersion) !== SKILL_API_VERSION) {
    errors.push(
      `apiVersion 必须是 ${SKILL_API_VERSION}（收到「${m.apiVersion ?? '（缺）'}」）——` +
        '版本不匹配说明这份技能是按别的宿主契约写的，加载它只会在运行期出错',
    )
  }

  // ── 入口 ────────────────────────────────────────────────────────────────
  const entry = String(m.entry ?? '').trim()
  if (!entry) {
    errors.push('entry 不能为空（指向技能目录里的 ESM 入口文件）')
  } else if (isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
    errors.push(`entry 必须是技能目录内的相对路径，不能是绝对路径或含 ..（收到「${entry}」）`)
  } else if (!/\.(m?js)$/i.test(entry)) {
    errors.push(`entry 必须是 .js / .mjs（收到「${entry}」）—— 本宿主用 ESM 动态 import 加载它`)
  } else if (dir) {
    const abs = resolve(dir, entry)
    if (!abs.startsWith(resolve(dir) + sep)) {
      errors.push(`entry 解析后跑到了技能目录外面（${abs}）`)
    } else if (!existsSync(abs)) {
      errors.push(`entry 指向的文件不存在：${entry}`)
    }
  }

  // ── 设置与界面 ──────────────────────────────────────────────────────────
  const settings = m.settings ?? {}
  const schema = m.configSchema ?? {}
  if (settings && (typeof settings !== 'object' || Array.isArray(settings))) {
    errors.push('settings 必须是对象（键 = 设置项，值 = 默认值）')
  }
  if (schema && (typeof schema !== 'object' || Array.isArray(schema))) {
    errors.push('configSchema 必须是对象（键 = 设置项）')
  }
  if (typeof settings === 'object' && !Array.isArray(settings) && typeof schema === 'object' && !Array.isArray(schema)) {
    for (const key of Object.keys(schema)) {
      const field = schema[key] ?? {}
      const type = String(field.type ?? '')
      if (!FIELD_TYPES.has(type)) {
        errors.push(`configSchema.${key}.type 不认识：「${type || '（缺）'}」（可用：${[...FIELD_TYPES].join(' / ')}）`)
      }
      if (type === 'enum' && (!Array.isArray(field.values) || field.values.length === 0)) {
        errors.push(`configSchema.${key} 是 enum，但 values 是空的 —— 界面上会渲染成一个没有选项的下拉框`)
      }
      if (!field.label) warnings.push(`configSchema.${key} 没有 label：界面上只能显示字段名`)
      if (!(key in settings)) {
        warnings.push(
          `configSchema.${key} 没有在 settings 里给默认值 ——` +
            '界面上它会显示为空，而运行时拿到的是 undefined（两边不一致）',
        )
      }
      if (field.secret === true && typeof settings[key] === 'string' && settings[key] !== '') {
        warnings.push(`settings.${key} 标了 secret，却在清单里带着一个非空默认值（密钥不该写在清单里）`)
      }
    }
    for (const key of Object.keys(settings)) {
      if (!(key in schema)) {
        warnings.push(
          `settings.${key} 没有对应的 configSchema 条目 ——` +
            '**界面上不会出现这一项**，用户永远改不了它（这是最典型的一类"静默失效"）',
        )
      }
    }
    if (!('enabled' in settings)) {
      warnings.push('settings 里没有 enabled 默认值 —— 界面上"启用"开关的初始状态会取 enabledByDefault')
    }
  }

  // ── 工具 ────────────────────────────────────────────────────────────────
  const tools = Array.isArray(m.tools) ? m.tools : []
  if (m.tools !== undefined && !Array.isArray(m.tools)) {
    errors.push('tools 必须是数组（可以只当说明性元数据，但形状要对）')
  }
  const seen = new Set()
  for (const [i, t] of tools.entries()) {
    const tid = String(t?.id ?? '')
    if (!TOOL_ID_RE.test(tid)) {
      errors.push(`tools[${i}].id 不合法：「${tid || '（缺）'}」`)
      continue
    }
    if (seen.has(tid)) errors.push(`tools 里有两个同名工具：${tid}`)
    seen.add(tid)
    const perm = String(t?.permission ?? 'read')
    if (perm !== 'read' && perm !== 'write') {
      errors.push(`tools[${i}].permission 只能是 read 或 write（收到「${perm}」）`)
    }
    if (t?.parameters && typeof t.parameters !== 'object') {
      errors.push(`tools[${i}].parameters 必须是 JSON Schema 对象`)
    }
  }

  // ── 权限声明（说明性，但它决定界面上要不要给红色提示）────────────────────
  const perms = m.permissions
  if (perms !== undefined && typeof perms !== 'object') {
    warnings.push('permissions 建议写成对象（如 {"net":["www.pixiv.net"],"listen":["127.0.0.1"]}），当前不是对象，界面只能原样显示')
  }
  if (perms && typeof perms === 'object' && !Array.isArray(perms)) {
    const net = Array.isArray(perms.net) ? perms.net : []
    const listen = Array.isArray(perms.listen) ? perms.listen : []
    if (listen.length > 0) {
      warnings.push(`这个技能会**在本机开端口**（${listen.join('、')}）—— 装它之前请确认你知道它在做什么`)
    }
    if (net.length === 0 && Object.keys(perms).length === 0) {
      warnings.push('permissions 是空的：如果这个技能其实要联网/落盘，请如实声明（界面上会显示出来）')
    }
  }

  // ── 会话模式（打错字会静默降级成 hint，而 hint 在群聊判定上是**弱**的）──────
  const session = m.session
  if (session !== undefined && !['required', 'hint', 'none'].includes(String(session))) {
    warnings.push(
      `session 的值不认识：「${session}」（只有 required / hint / none）——` +
        '已按 hint 处理。⚠️ 要判群聊/私聊的技能必须写 required，' +
        '否则宿主拿不到准确的当前会话（MCP 调用里没有会话标识）。',
    )
  }
  if (!String(m.description ?? '').trim()) {
    warnings.push('description 为空：界面上的技能卡会是一片空白，装的人不知道它是干什么的')
  }

  // ── 提示词片段 ──────────────────────────────────────────────────────────
  const src = String(m.prompt?.source ?? 'runtime')
  if (src !== 'runtime' && src !== 'manifest' && src !== 'none') {
    errors.push(`prompt.source 只能是 runtime / manifest / none（收到「${src}」）`)
  }
  if (Array.isArray(m.prompt?.sections)) {
    for (const [i, s] of m.prompt.sections.entries()) {
      if (!s?.id) errors.push(`prompt.sections[${i}].id 不能为空`)
      if (!String(s?.content ?? '').trim()) errors.push(`prompt.sections[${i}].content 不能为空`)
    }
    if (src === 'runtime') {
      warnings.push(
        'prompt.sections 与运行期导出 promptSections() 同时存在：本宿主**只取运行期导出的**（更准），' +
          '清单里这份会被忽略 —— 建议删掉，免得两处文案漂移',
      )
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

/* ══════════════════════════════════════════════════════════════════════════
   1.5 技能的 npm 依赖桥（0.2.2）
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 允许技能使用的宿主自带依赖（白名单）。
 *
 * ── 为什么需要这座桥 ──────────────────────────────────────────────────────
 * 第三方技能用**普通的 `import('xxx')`** 加载依赖，Node 会从技能目录逐级往上找
 * `node_modules`。而本包的运行期依赖**不在** `node_modules` 里 —— 它们由
 * `setup.mjs` 复制到 `vendor/node_modules`（这样整个包可以搬走），桥接自己是用
 * `createRequire` 显式指到 vendor 去读的（见 `src/vendor.mjs`）。
 * 技能不能这么干（那是宿主内部机制），所以它会在真机上直接 `ERR_MODULE_NOT_FOUND`。
 *
 * 修法就是这座桥：把 `vendor/node_modules/<包>` **软链**成 `skills/node_modules/<包>`，
 * 于是技能的普通 import 也能解析到——**不复制字节、不引入第二份版本**。
 *
 * ── 为什么是白名单，而不是"整个 vendor 都链过去" ──────────────────────────
 * `ws` 是桥接的内部管道。技能拿到它没有正当用途，却可以用它做任意网络连接。
 * 白名单里每一项都要有**明确的、被真实技能用到**的理由：
 *   · `undici`：pixiv 插件的代理支持要用它的 `ProxyAgent`（Node 内置 fetch 不认 dispatcher）。
 *     ⚠️ 包里没有这个依赖时，技能会自己报「代理不可用」—— 这是**如实降级**，
 *     不是我们的 bug；要修就在本目录 `npm install` 后重跑 `setup.mjs`。
 */
export const SKILL_NODE_MODULES = ['undici']

/**
 * 幂等地建好 `skills/node_modules` 里的软链。
 *
 * ★ 全程**只降级不阻断**：链不上就记一行日志，技能自己会在用的时候报"依赖不可用"。
 *   装不上一个依赖不该让机器人起不来。
 *
 * @param {{ skillsDir: string, vendorNodeModules: string, log?: Function }} opts
 * @returns {{ linked: string[], reused: string[], missing: string[] }}
 */
export function ensureSkillNodeModules({ skillsDir, vendorNodeModules, log = () => {} } = {}) {
  const out = { linked: [], reused: [], missing: [] }
  if (!skillsDir || !existsSync(skillsDir)) return out
  const target = join(skillsDir, 'node_modules')
  try {
    mkdirSync(target, { recursive: true })
  } catch (error) {
    log(`⚠️ [扩展] 建不了 skills/node_modules（技能的 npm 依赖会解析不到）：${error?.message ?? error}`)
    return out
  }
  for (const name of SKILL_NODE_MODULES) {
    const from = join(vendorNodeModules ?? '', name)
    // 依赖本身没准备好（用户没跑 setup / 没 npm install）→ 如实报"缺"，不假装
    if (!vendorNodeModules || !existsSync(from)) {
      out.missing.push(name)
      continue
    }
    const link = join(target, name)
    try {
      const st = existsSync(link)
      if (st) {
        out.reused.push(name)
        continue
      }
      // Windows 上必须用 'junction'（不需要管理员权限）；其它平台用 'dir'
      symlinkSync(from, link, process.platform === 'win32' ? 'junction' : 'dir')
      out.linked.push(name)
    } catch (error) {
      log(`⚠️ [扩展] 软链 skills/node_modules/${name} 失败：${error?.message ?? error}`)
      out.missing.push(name)
    }
  }
  return out
}

/* ══════════════════════════════════════════════════════════════════════════
   2. 发现
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 扫描技能目录。
 *
 * 目录约定：`<skillsDir>/<任意名字>/skill.json`。**目录名不必等于 id**
 * （id 以清单为准），但强烈建议相等 —— 这样排障时不用来回对照。
 *
 * 坏掉的技能**不会**让发现过程失败：它们会带着 `errors` 出现在结果里，
 * 由界面如实显示"装是装了，但用不了，原因是…"。这比"静默消失"强得多。
 *
 * @param {{ skillsDir: string }} opts
 * @returns {{ skills: object[], dir: string, exists: boolean }}
 */
export function discoverSkills({ skillsDir } = {}) {
  const dir = skillsDir ?? ''
  const out = []
  if (!dir || !existsSync(dir)) return { skills: out, dir, exists: false }

  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { skills: out, dir, exists: false }
  }

  // ★ 同一个 `id` 只能有**一个**目录。
  //   两个目录用同一个 id 时，工具裸名会撞车（`<id>__<tool>`），模型在 tools/list 里会看到
  //   两条一模一样的名字，而派发只会命中先出现的那条 —— 表现为"看起来装上了、实际调的是另一个版本"。
  //   这类"静默取第一个"正是本项目最忌讳的，所以：**撞车的两个都标红、都不装载**（fail-closed），
  //   并指名道姓说清是哪几个目录 —— 装/卸/升级/回滚时最容易留下两份（旁边放了个备份目录）。
  const idOwner = new Map()

  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.')) continue // .upstream-original 之类的留档目录不是技能
    const skillDir = join(dir, e.name)
    const manifestPath = join(skillDir, 'skill.json')
    if (!existsSync(manifestPath)) continue

    let manifest = null
    let parseError = ''
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      parseError = `skill.json 解析失败：${error?.message ?? error}`
    }

    const v = parseError
      ? { ok: false, errors: [parseError], warnings: [] }
      : validateSkillManifest(manifest, { dir: skillDir })

    // ★ 同 id 撞车：先把归属记下来，循环结束后**统一把撞车的两个都标红**（见下面的 after-loop）。
    const skillId = String(manifest?.id ?? e.name)
    if (!idOwner.has(skillId)) idOwner.set(skillId, [])
    idOwner.get(skillId).push(e.name)

    out.push({
      // id 优先取清单里的（坏清单也尽量给个能显示的 id）
      id: skillId,
      dirName: e.name,
      dir: skillDir,
      manifestPath,
      manifest: manifest ?? {},
      entry: manifest?.entry ? resolve(skillDir, String(manifest.entry)) : '',
      name: String(manifest?.name ?? e.name),
      version: String(manifest?.version ?? ''),
      apiVersion: Number(manifest?.apiVersion ?? 0),
      description: String(manifest?.description ?? ''),
      category: String(manifest?.category ?? 'other'),
      icon: String(manifest?.icon ?? '🧩'),
      author: String(manifest?.author ?? ''),
      enabledByDefault: manifest?.enabledByDefault === true,
      promptSource: String(manifest?.prompt?.source ?? 'runtime'),
      sessionMode: ['hint', 'required', 'none'].includes(String(manifest?.session ?? 'hint'))
        ? String(manifest?.session ?? 'hint')
        : 'hint',
      declaredTools: Array.isArray(manifest?.tools) ? manifest.tools : [],
      permissions: manifest?.permissions ?? {},
      ok: v.ok,
      errors: v.errors,
      warnings: v.warnings,
      // 运行期填的字段（loader 用）
      loaded: false,
      module: null,
      runtimeTools: [],
      loadError: '',
    })
  }

  // ★ 同 id 撞车 → **双方都标红**（fail-closed）：不猜哪个是对的，直接不装载并说清。
  //   为什么不做"先到先得"：readdir 的顺序取决于文件系统（NTFS 上近似按名字），
  //   一个叫 `copy-of-x` 的备份目录可能排在真正那份前面 —— 于是"静默跑的是备份"。
  for (const [id, dirNames] of idOwner) {
    if (dirNames.length < 2) continue
    const who = dirNames.join(' / ')
    for (const s of out) {
      if (s.id !== id) continue
      s.ok = false
      s.errors = [
        ...s.errors,
        `id 重复：「${id}」在 ${who} 里出现了 ${dirNames.length} 次 —— 同一个技能只能有一个目录，` +
          '**两个都不会装载**（否则工具名 `<id>__<工具>` 会撞车，模型看到两条一样的名字、' +
          '实际只会调其中一条，而那条不一定是你要的）。请删掉或改掉多余的那份。',
      ]
    }
  }

  out.sort((a, b) => a.id.localeCompare(b.id))
  return { skills: out, dir, exists: true }
}

/* ══════════════════════════════════════════════════════════════════════════
   3. 设置的合并、收敛与脱敏
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 一个技能的**有效设置**：清单默认值 ← 用户配置，并按 configSchema 收敛类型。
 *
 * ★ 收敛（coerce）为什么必须做：设置从界面来（JSON、字符串）、从 config.json 来（手改过）、
 *   从清单来（作者写的），三处的类型不保证一致。`maxResults: "10"` 传进技能里，
 *   技能做 `Math.min(limit, c.maxResults)` 会得到 NaN —— 然后表现为"上限失效"。
 *   所以在这里一次性收敛掉，并且**只认能安全转的**（转不了就退回默认值 + 记一条 warning）。
 *
 * @param {object} manifest
 * @param {object} raw `config.skills.<id>`（可能缺、可能形状不对）
 * @returns {{ settings: object, warnings: string[] }}
 */
export function mergeSkillSettings(manifest, raw) {
  const schema = manifest?.configSchema ?? {}
  const defaults = manifest?.settings ?? {}
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const settings = {}
  const warnings = []

  const keys = new Set([...Object.keys(defaults), ...Object.keys(schema), ...Object.keys(given)])
  for (const key of keys) {
    const field = schema[key] ?? {}
    const fallback = key in defaults ? defaults[key] : undefined
    const value = key in given ? given[key] : fallback
    const type = String(field.type ?? guessType(fallback))
    const r = coerceByType(type, value, field, key)
    if (!r.ok) {
      // `blank`（没填）不算错，安静地退回默认值；其它情况才是"值不合法"，必须告警。
      if (!r.blank) warnings.push(`设置 ${key} 的值「${String(value)}」不是合法的 ${type}，已退回默认值`)
      settings[key] = fallback
    } else {
      settings[key] = r.value
    }
  }
  return { settings, warnings }
}

/** 清单没写 type 时，按默认值猜一个（不强求作者写全）。 */
function guessType(v) {
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'number') return 'number'
  return 'string'
}

/** 按类型收敛一个值。转不了就 `ok:false`（调用方退回默认值，不猜）。 */
function coerceByType(type, value, field = {}, key = '') {
  // ── "空值"是一种独立情况，**不是类型错误** ──────────────────────────────
  //
  // 判据：`undefined` / `null` / 空白串。含义是"这一项没填" → 用清单里的默认值，
  // 而且**不告警**（用户清空一个输入框不该被骂）。
  //
  // ⚠️ 这条是实测抓出来的：`Number('')` 是 0、`Number('  ')` 也是 0，而 0 会被
  //   `min` 夹成 1 —— 于是"界面上把条数清空"会静默变成「上限 = 1」，
  //   比这更糟的是 `{count: 0}` 连夹取都绕过（原实现在空值分支直接 return 了 0）。
  const blank =
    value === undefined || value === null || (typeof value === 'string' && value.trim() === '')

  if (type === 'boolean') {
    if (blank) return { ok: false, blank: true }
    if (typeof value === 'boolean') return { ok: true, value }
    if (value === 'true' || value === 1) return { ok: true, value: true }
    if (value === 'false' || value === 0) return { ok: true, value: false }
    return { ok: false }
  }
  if (type === 'number' || type === 'integer') {
    if (blank) return { ok: false, blank: true }
    const n = typeof value === 'number' ? value : Number(String(value).trim())
    if (!Number.isFinite(n)) return { ok: false }
    let out = type === 'integer' ? Math.trunc(n) : n
    // 夹到 min/max：界面上本来就该夹，但配置文件可以手改，所以这里再夹一次
    if (typeof field.min === 'number' && out < field.min) out = field.min
    if (typeof field.max === 'number' && out > field.max) out = field.max
    return { ok: true, value: out }
  }
  if (type === 'enum') {
    if (blank) return { ok: false, blank: true }
    const list = Array.isArray(field.values) ? field.values : []
    const s = String(value)
    if (list.length > 0 && !list.map(String).includes(s)) return { ok: false }
    return { ok: true, value: s }
  }
  // string（含 secret）：**空串是合法值**（清空文本框 = 真的清空，例如"代理留空 = 直连"），
  // 所以这里**不**按 blank 处理 —— 这是与上面几种类型刻意不同的地方。
  if (value === undefined || value === null) return { ok: true, value: '' }
  if (typeof value === 'object') return { ok: false }
  return { ok: true, value: String(value) }
}

/**
 * 把一个技能的设置**脱敏**后交给界面。
 *
 * 规则与桥接既有配置完全一致（见 `src/api.mjs` 的 SECRET_FIELDS）：
 *   · 删掉密文字段的值，只留 `has<字段名>` 布尔 —— 界面据此显示"已配置（留空即不修改）"；
 *   · 空串 = 保持原值；显式 `null` = 清除（这条语义必须与 /api/config 一致，否则用户
 *     "改个上限"会顺手把 Cookie 弄没）。
 *
 * @returns {{ values: object, has: Record<string, boolean> }}
 */
export function redactSkillSettings(manifest, settings) {
  const schema = manifest?.configSchema ?? {}
  const values = {}
  const has = {}
  for (const [key, value] of Object.entries(settings ?? {})) {
    const secret = schema?.[key]?.secret === true
    if (secret) {
      const filled = typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null && value !== ''
      has[key] = Boolean(filled)
      // ★ 值本身**不进**返回值（不是置空、是删除）——与 redactConfig 同一纪律
      continue
    }
    values[key] = value
  }
  return { values, has }
}

/**
 * 把界面回传的补丁合进既有设置里（含"密文留空 = 不修改"的语义）。
 *
 * @param {object} current 现有设置（**含密钥明文**）
 * @param {object} patch 界面回传
 * @returns {object} 新的设置对象
 */
export function mergeSkillSettingsPatch(manifest, current, patch) {
  const out = { ...(current ?? {}) }
  const schema = manifest?.configSchema ?? {}
  const body = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith('_') || key.startsWith('has')) continue
    const secret = schema?.[key]?.secret === true
    if (secret) {
      if (value === null) {
        out[key] = '' // 显式清除
      } else if (typeof value === 'string' && value.trim() !== '') {
        out[key] = value
      }
      // 空串 / undefined = 保持原样（**不覆盖**，这是防止"保存一次就丢密钥"的那条老坑）
      continue
    }
    out[key] = value
  }
  return out
}

/* ══════════════════════════════════════════════════════════════════════════
   4. 开关状态
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 一个技能此刻开着还是关着。
 *
 * 口径（与上游 `available()` 一致，也写进了设计规范）：
 *   · 唯一开关是 `config.skills.<id>.enabled`；
 *   · 没写过这个键时取清单的 `enabledByDefault`（**默认 false**，装上去不会自动联网）；
 *   · `enabled=false` 时，技能的工具**一律拒绝执行**（fail-closed），
 *     提示词片段也**不再注入** —— 两件事必须同时发生，否则模型会去调一个不存在的工具。
 */
export function isSkillEnabled(skill, config) {
  const raw = config?.skills?.[skill.id]
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.enabled : undefined
  // 清单里的 settings.enabled 是"作者给的默认值"，enabledByDefault 是"装上去的初始状态"。
  // 两者都可能存在（上游就有这个不一致），这里以显式配置 > enabledByDefault > settings.enabled 为准。
  if (typeof given === 'boolean') return given
  if (typeof skill?.enabledByDefault === 'boolean') return skill.enabledByDefault
  const fromSettings = skill?.manifest?.settings?.enabled
  return typeof fromSettings === 'boolean' ? fromSettings : false
}

/**
 * **现调**一次技能的自检（`available()`），而不是读装载时的快照。
 *
 * ── 为什么必须现调（0.2.7 修的一处真实误伤）──────────────────────────────
 * `loadSkill` 那一刻会调一次 `available()` 并把结果存进 `skill.available`。
 * 第一版的控制台**直接读这个快照** —— 于是只要开关是在**装载之后**才打开的
 * （这是最常见的情形：装好技能 → 重启 → 再去控制台打开），卡片上就会一直写着
 * 「「视频识别」开关没打开」，配着「暂时用不了」的徽标，而且**再也不会变**。
 * 使用者看到的是"我明明开着，它说我没开"。
 * 同一个坑对"后来才装好 ffmpeg / 填好路径"完全一样（那时快照里还写着缺依赖）。
 *
 * ⇒ 卡片与 CLI 改读**现调**结果。这不违反"`available()` 必须同步"那条契约：
 *   它本来就是同步且便宜的（技能侧不许在同步函数里做 IO/网络，见规范 §3.1），
 *   所以列表每次刷新各调一次没有代价。
 *
 * 失败一律**降级不抛**：技能抛错时给出原因（而不是让整个列表接口 500）。
 *
 * @param {object} skill `discoverSkills()` / `loadSkill()` 的条目
 * @param {object} config 活配置
 * @returns {{ok: boolean, reason: string}}
 */
export function callSkillAvailable(skill, config) {
  const fallback = skill?.available ?? { ok: true, reason: '' }
  if (typeof skill?.module?.available !== 'function') return fallback
  try {
    const r = skill.module.available({ config: config ?? {} })
    if (r && typeof r === 'object') return { ok: r.ok !== false, reason: String(r.reason ?? '') }
    return fallback
  } catch (error) {
    return { ok: false, reason: `available() 抛错：${error?.message ?? error}` }
  }
}

/**
 * 某个技能此刻的"能不能真的用"。
 *
 * @param {object} skill
 * @param {object} config
 * @param {{ok:boolean,reason:string}} [available] 自检结果；**不传就现调一次**
 *        （卡片/CLI 都该现调 —— 见 `callSkillAvailable` 的注释）
 * @returns {{ enabled: boolean, ready: boolean, reasons: string[] }}
 *   `ready=false` 时 `reasons` 是**给使用者看的**原因（不是给开发者看的堆栈）。
 */
export function skillStatus(skill, config, available = callSkillAvailable(skill, config)) {
  const enabled = isSkillEnabled(skill, config)
  const reasons = []
  if (!skill?.ok) reasons.push(`清单有问题：${(skill?.errors ?? []).join('；')}`)
  if (skill?.loadError) reasons.push(`加载失败：${skill.loadError}`)
  if (enabled && !skill?.loaded && !skill?.loadError && skill?.ok) reasons.push('尚未加载（重启桥接后生效）')
  // 依赖自检不过（技能自己说的）：开着也用不了 —— 如实显示它给的原因
  if (enabled && available && available.ok === false && available.reason) {
    reasons.push(available.reason)
  }
  // ★ 0.2.2：QQ 工具总开关关着 → 技能工具**根本不会挂给模型**，指引也不会注入。
  //   这一条必须显示出来：否则使用者会以为"我明明开着这个技能，它怎么不用"。
  if (enabled && config?.mcp?.enabled === false) {
    reasons.push('QQ 工具总开关（mcp.enabled）关着 —— 技能工具不会挂给模型，它的提示词指引也不会注入')
  }
  return { enabled, ready: Boolean(skill?.ok && skill?.loaded && !skill?.loadError), reasons }
}

/* ══════════════════════════════════════════════════════════════════════════
   5. 装载（在哪个进程装载，就在那个进程执行 execute）
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 动态 import 一个技能的入口模块，并把它的工具收进 `skill.runtimeTools`。
 *
 * ★ 两个调用方，用途不同、**都在各自进程内各调一次**：
 *   · `mcp/mcp-skills-server.mjs`（工具进程）：真正执行 execute 的地方；
 *   · 桥接主进程（提示词侧）：只为拿 `promptSections()`，工具回调是**空实现**。
 *   这正是设计规范里那条"setup 必须无进程级副作用"的由来。
 *
 * @param {object} skill `discoverSkills()` 返回的条目
 * @param {{ config?: object, log?: (m: string) => void, registerTool?: (t: object) => void }} opts
 * @returns {Promise<object>} 同一个 skill 对象（就地补 loaded/module/runtimeTools/loadError）
 */
export async function loadSkill(skill, { config, log = () => {}, registerTool } = {}) {
  skill.loaded = false
  skill.module = null
  skill.runtimeTools = []
  skill.loadError = ''
  if (!skill?.ok || !skill.entry || !existsSync(skill.entry)) {
    skill.loadError = skill?.ok ? `入口文件不存在：${skill?.entry ?? '（未声明）'}` : '清单校验未通过'
    return skill
  }
  let mod
  try {
    // 加时间戳参数：技能文件被就地替换后（重装/升级）能拿到新模块，而不是命中旧缓存
    mod = await import(`${pathToFileURL(skill.entry).href}?t=${mtimeOf(skill.entry)}`)
  } catch (error) {
    skill.loadError = `import 失败：${error?.message ?? error}`
    return skill
  }
  if (typeof mod.setup !== 'function') {
    skill.loadError = '入口模块没有导出 setup(api) —— 这不是一份 InteractiveRobot 技能'
    return skill
  }

  // ★ 收集与转发分开：`skill.runtimeTools` 由本函数**保证填好**（调用方不必自己收集），
  //   `registerTool` 只是额外通知（桥接主进程那边根本不传它 —— 它只要提示词片段）。
  const sink = (tool) => {
    const normalized = normalizeRuntimeTool(skill, tool)
    skill.runtimeTools.push(normalized)
    if (typeof registerTool === 'function') registerTool(normalized)
  }
  const api = {
    // ── 与上游 QQ Agent 0.3.1/0.4 的契约保持一致（技能不用改代码就能跑）──
    registerTool: (tool) => sink(tool),
    config: () => mergeSkillSettings(skill.manifest, config?.skills?.[skill.id]).settings,
    // ★ 宿主扩展：把"模型实际看到的工具名"告诉技能。
    //   上游是宿主自己加 `pixiv-lookup__` 前缀，而本宿主的可见名由 DSH 的 MCP 客户端
    //   按 `mcp__skills__…` 拼出来 —— 技能若在提示词里写死旧名字，模型会去调不存在的工具。
    toolName: (toolId) => skillToolFullName(skill.id, toolId),
    // ★ 宿主扩展：技能要用**宿主的**工具时，从这里取它的真实名字（见 HOST_TOOLS 的说明）
    hostTool: (id) => HOST_TOOLS[String(id)] ?? '',
    log: (...a) => log(`[skill:${skill.id}] ${a.join(' ')}`),
    warn: (...a) => log(`[skill:${skill.id}] ⚠️ ${a.join(' ')}`),
    error: (...a) => log(`[skill:${skill.id}] ❌ ${a.join(' ')}`),
    skill: { id: skill.id, dir: skill.dir, version: skill.version },
  }

  try {
    await mod.setup(api)
  } catch (error) {
    skill.loadError = `setup() 抛错：${error?.message ?? error}`
    return skill
  }

  skill.module = mod
  skill.loaded = true

  // ── 依赖自检（`available(context)`，可选导出）───────────────────────────
  //
  // ★ 上游的语义是"不可用就把整个技能连同工具一起摘掉"。本宿主**不摘**，而是
  //   把原因记下来，在**调用时**拒绝并原样转述 —— 理由与 pixiv 作者写在
  //   index.js 文件头的那条完全一致：技能凭空消失，用户只会觉得"功能坏了、没有解释"。
  //   所以：`available().ok === false` 时，界面上显示原因、工具调用返回那句原因。
  //
  // ⚠️ 契约要求它**同步**（上游在同步的 isActive() 里调用它）。这里也同步调用，
  //   并且在 try/catch 里 —— 技能自己抛错不该让装载失败。
  skill.available = { ok: true, reason: '' }
  if (typeof mod.available === 'function') {
    try {
      const r = mod.available({ config: config ?? {} })
      if (r && typeof r === 'object') skill.available = { ok: r.ok !== false, reason: String(r.reason ?? '') }
    } catch (error) {
      skill.available = { ok: false, reason: `available() 抛错：${error?.message ?? error}` }
    }
  }
  return skill
}

/** 文件 mtime（毫秒）；读不到就当 0（那样至少还能加载一次）。 */
function mtimeOf(file) {
  try {
    return Math.trunc(statSync(file).mtimeMs)
  } catch {
    return 0
  }
}

/** 把技能注册的工具整理成宿主内部统一形状（并把名字定死）。 */
function normalizeRuntimeTool(skill, tool) {
  const id = String(tool?.id ?? '').trim()
  const declared = (skill.declaredTools ?? []).find((t) => String(t?.id) === id)
  const permission = String(tool?.permission ?? declared?.permission ?? 'read')
  return {
    skillId: skill.id,
    id,
    fullName: skillToolFullName(skill.id, id),
    name: String(tool?.name ?? declared?.name ?? id),
    description: String(tool?.description ?? declared?.description ?? ''),
    category: String(tool?.category ?? skill.category ?? 'other'),
    icon: String(tool?.icon ?? skill.icon ?? '🧩'),
    permission: permission === 'write' ? 'write' : 'read',
    parameters: tool?.parameters ?? declared?.parameters ?? { type: 'object', properties: {} },
    execute: typeof tool?.execute === 'function' ? tool.execute : null,
    declared: Boolean(declared),
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   6. 提示词片段
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 收集**启用中**技能的提示词片段，按 priority 升序（小的在前）。
 *
 * ★ 三条纪律（都对应一类真实故障）：
 *   ① **只收启用中的**：关掉的技能若还在提示词里留一句"用 XX 查"，模型会去调一个不存在的工具，
 *      然后对用户说"查不到" —— 关掉技能却让机器人开始胡说，比不关更糟。
 *   ② **失败只降级不阻断**：某个技能的 promptSections() 抛错，只记一行日志并跳过它，
 *      绝不能因此让整个提示词装配失败（那等于机器人彻底不说话）。
 *   ③ **顺序稳定**：priority 相同时按 id 排序，避免每次装配顺序抖动（提示词前缀缓存很在意这个）。
 *
 * @param {{ skills: object[], config: object, log?: Function, ctx?: object }} opts
 * @returns {{ lines: string[], errors: string[] }}
 */
export function collectSkillPromptSections({ skills = [], config, log = () => {}, ctx = {} } = {}) {
  const picked = []
  const errors = []

  // ★★ 0.2.2 补的一个漏：**QQ 工具总开关关着时，技能工具也不会挂上去**。
  //
  // 为什么：两个 MCP 服务器（QQ 工具 / 技能工具）都由 `mcp.enabled` 统一开关 ——
  // 关掉它意味着"模型只能用文字回复"。而技能的工具是**通过 MCP 挂上去的**，
  // 所以此刻它们**不存在**。这时若还把技能的提示词片段注入，提示词就在教模型
  // 去调一个不存在的工具 —— 而它只会说"查不到"（这正是本文件反复在防的那类静默失效）。
  //
  // 判据放在这一层（而不是桥接里）：这里就是"哪些技能的话能进提示词"的唯一规则，
  // 界面与自检也走同一个函数，三处口径自然一致。
  if (config?.mcp?.enabled === false) {
    return { lines: [], errors, skipped: 'mcp-disabled' }
  }

  for (const skill of skills) {
    if (!isSkillEnabled(skill, config)) continue
    if (skill.promptSource === 'none') continue
    let sections = []
    try {
      if (skill.promptSource === 'manifest') {
        sections = Array.isArray(skill.manifest?.prompt?.sections) ? skill.manifest.prompt.sections : []
      } else if (typeof skill.module?.promptSections === 'function') {
        const r = skill.module.promptSections({ ...ctx, config })
        sections = Array.isArray(r) ? r : []
      } else if (Array.isArray(skill.manifest?.prompt?.sections)) {
        // 运行期没导出就退回清单里的静态文案（少一层准确度，但比什么都不给强）
        sections = skill.manifest.prompt.sections
      }
    } catch (error) {
      const msg = `技能 ${skill.id} 的 promptSections() 抛错：${error?.message ?? error}`
      errors.push(msg)
      log(`[extensions] ⚠️ ${msg}（已跳过这个技能的提示词片段，其余照常）`)
      continue
    }
    for (const s of sections) {
      const content = String(s?.content ?? '').trim()
      if (!content) continue
      picked.push({
        skillId: skill.id,
        id: String(s?.id ?? `${skill.id}-hint`),
        title: String(s?.title ?? skill.name),
        priority: Number.isFinite(Number(s?.priority)) ? Number(s.priority) : 50,
        content,
        // 提示词装配要用它决定"要不要补一句 kind/peerId 的说明"（见 channel-prompt.mjs）
        sessionMode: skill.sessionMode,
      })
    }
  }
  picked.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  return { lines: picked, errors, skipped: '' }
}

/**
 * 把技能的诊断信息收上来（`diagnose()` 是可选导出，上游就有）。
 *
 * 为什么值得做：技能最容易的坏法是"静默拿不到数据"（Cookie 没填、代理没开、Pixiv 连不上）。
 * 有诊断输出，界面上就能一眼看出卡在哪一步，而不是靠猜。
 * ★ 约定：**诊断输出里不许出现密钥原文**（技能自己的责任，规范里写明）。
 */
export function callSkillDiagnose(skill, context = {}) {
  try {
    const fn = skill?.module?.diagnose
    if (typeof fn !== 'function') return null
    const r = fn(context)
    return r && typeof r === 'object' ? r : null
  } catch (error) {
    return { 诊断失败: `${error?.message ?? error}` }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   7. 给界面/CLI 用的汇总
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 一个技能的完整对外描述（界面卡片、CLI 列表、API 响应共用**同一个**函数）。
 *
 * ★ 只有一份的理由：这三处一旦各写一份，就会出现"CLI 说就绪、界面说缺依赖"
 *   这种自相矛盾，而排障时最耗时间的就是这种矛盾。
 */
export function describeSkill(skill, config) {
  const raw = config?.skills?.[skill.id]
  const { settings, warnings: setWarnings } = mergeSkillSettings(skill.manifest, raw)
  const { values, has } = redactSkillSettings(skill.manifest, settings)
  // ★ 0.2.7：自检**现调**（不再读装载时的快照）—— 否则"装载之后才打开开关 / 才装好依赖"
  //   的技能，卡片会一直写着与事实相反的原因。见 `callSkillAvailable` 的注释。
  const available = callSkillAvailable(skill, config)
  const status = skillStatus(skill, config, available)
  const tools = (skill.runtimeTools?.length ? skill.runtimeTools : skill.declaredTools.map((t) => ({
    skillId: skill.id,
    id: String(t?.id ?? ''),
    fullName: skillToolFullName(skill.id, String(t?.id ?? '')),
    name: String(t?.name ?? t?.id ?? ''),
    description: String(t?.description ?? ''),
    permission: t?.permission === 'write' ? 'write' : 'read',
    declared: true,
    registered: false,
  }))).map((t) => ({
    id: t.id,
    // 模型真正看到的名字：排障时直接复制去搜日志
    fullName: t.fullName,
    name: t.name,
    description: t.description,
    permission: t.permission,
    registered: Boolean(t.execute),
  }))
  return {
    id: skill.id,
    dirName: skill.dirName,
    name: skill.name,
    version: skill.version,
    apiVersion: skill.apiVersion,
    description: skill.description,
    // ★ 清单里**声明**了几个工具（与上面 `tools` 的"实际注册"分开）。
    //   为什么要把这个数给出去：像「表情包」这种**刻意不要工具**的技能
    //   （靠提示词约定 + 宿主判定工作，见 `docs/插件设计规范.md` §7），
    //   调用方不能拿"工具数 0"当成"忘了接线"——否则每次巡检都会打一条假告警，
    //   假告警用久了就没人看了。判据必须是"**声明了却没注册**"。
    declaredToolCount: Array.isArray(skill.declaredTools) ? skill.declaredTools.length : 0,
    category: skill.category,
    icon: skill.icon,
    author: skill.author,
    dir: skill.dir,
    enabled: status.enabled,
    enabledSource: raw && typeof raw === 'object' && typeof raw.enabled === 'boolean' ? 'config' : 'manifest',
    ready: status.ready,
    reasons: status.reasons,
    available,
    errors: skill.errors ?? [],
    warnings: [...(skill.warnings ?? []), ...setWarnings],
    settings: values,
    secretSet: has,
    secretFields: Object.entries(skill.manifest?.configSchema ?? {})
      .filter(([, f]) => f?.secret === true)
      .map(([k]) => k),
    schema: skill.manifest?.configSchema ?? {},
    tools,
    promptSections: collectSkillPromptSections({ skills: [skill], config }).lines.map((s) => ({
      id: s.id,
      title: s.title,
      priority: s.priority,
      // 给界面预览用的截断版本（全文可能上千字，界面上不需要全文）
      preview: s.content.length > 400 ? `${s.content.slice(0, 400)}…` : s.content,
      chars: s.content.length,
    })),
    permissions: skill.permissions ?? {},
    sessionMode: skill.sessionMode,
    promptSource: skill.promptSource,
  }
}
