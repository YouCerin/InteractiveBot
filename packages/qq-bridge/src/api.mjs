/**
 * 本地配置 HTTP 接口（给配置 UI 用）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 安全上的两个硬决定（不是可选项）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **只允许绑定 127.0.0.1。**
 *      配置里含 SnowLuma 的 accessToken 明文。绑到 0.0.0.0 等于把
 *      "你的 QQ 机器人控制权"公开到局域网 —— 任何人打开浏览器就能改配置、
 *      看 token。所以本模块**拒绝**非回环地址（见 assertLoopbackOnly）。
 *
 *   ② **读配置必须把 token 删除，而不是置空。**
 *      这是源项目踩过的坑：返回空串的话，前端拿到的就是空，回传时会把
 *      真实 token 覆盖成空 —— 表现是"UI 保存一次之后就连不上了"。
 *      正确做法是返回 `hasWsToken: true` 这类布尔标记，写回时把
 *      空值解释为"保持原样"。
 *
 * ── 设计原则：核心逻辑与网络分离 ───────────────────────────────────────
 * `createApiHandler` 只做「请求对象 → 响应对象」的纯映射，不碰 socket。
 * 这样它能被单元测试直接调用（见 mocks/verify-api.mjs），
 * 而不用真的起一个 HTTP 服务器。
 *
 * 接口清单与 `CONFIG-UI.md` 第 5 节保持一致 —— 那份文档是给 UI 生成者看的，
 * 两边不一致会让照着做的 UI 对不上。
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'

/**
 * 需要脱敏的字段（配置里的路径 → 界面上的布尔标记名）。
 *
 * `clearable` 的含义：**允许界面用 `null` 显式清空**。
 *
 * 为什么要有这一档：密钥（`dsh.apiKey`）和 token 不一样 —— 用户换号、key 泄露、
 * 想改用环境变量时，都必须有一个"清除"的动作。而"空串 = 保持原样"这条语义
 * 已经占用了空串，所以清除只能用 `null` 表达。详见 `mergeConfigPatch`。
 *
 * 标记名由调用方决定：`redactConfig` 把它写在脱敏对象的**根部**（不是字段所在层）。
 */
const SECRET_FIELDS = [
  { path: ['onebot', 'wsToken'], flag: 'hasWsToken' },
  { path: ['onebot', 'httpToken'], flag: 'hasHttpToken' },
  { path: ['dsh', 'apiKey'], flag: 'hasApiKey', clearable: true },
  // ★ 0.2.3：判定专用 key。它同时是**通路开关**（填了才走直连、且只用这把），
  //   所以界面必须能知道"配没配"却看不到值 —— 正是这一档存在的理由。
  //   `clearable`（允许 `null` 清空）在这里更要紧：清空它 = 从直连退回一次性 DSH 进程。
  { path: ['wake', 'judge', 'apiKey'], flag: 'hasJudgeKey', clearable: true },
]

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // UI 轮询这些接口，绝不能被缓存 —— 否则界面显示的是旧状态
  'cache-control': 'no-store',
}

/**
 * 只允许回环地址。
 * @param {string} host
 */
export function assertLoopbackOnly(host) {
  const allowed = new Set(['127.0.0.1', '::1', 'localhost'])
  if (!allowed.has(String(host))) {
    throw new Error(
      `配置接口只允许绑定回环地址（127.0.0.1），收到的是「${host}」。` +
        `配置里含 accessToken 明文，绑到其他地址等于把机器人控制权公开。`,
    )
  }
}

/** 读取嵌套路径。 */
function getPath(obj, path) {
  let cur = obj
  for (const key of path) {
    if (cur === null || typeof cur !== 'object' || !(key in cur)) return undefined
    cur = cur[key]
  }
  return cur
}

/** 写入嵌套路径（自动创建中间层）。 */
function setPath(obj, path, value) {
  let cur = obj
  for (const key of path.slice(0, -1)) {
    if (cur[key] === null || typeof cur[key] !== 'object') cur[key] = {}
    cur = cur[key]
  }
  cur[path[path.length - 1]] = value
}

/** 删除嵌套路径（脱敏用）。 */
function delPath(obj, path) {
  let cur = obj
  for (const key of path.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object') return
    cur = cur[key]
  }
  if (cur && typeof cur === 'object') delete cur[path[path.length - 1]]
}

/**
 * 把磁盘上的原始配置转成"可以安全返回给 UI"的形状。
 * **删除**密钥字段，并补上 `hasXxx` 布尔标记。
 */
export function redactConfig(raw) {
  // 深拷贝一份，绝不改动调用方传进来的对象
  const copy = JSON.parse(JSON.stringify(raw ?? {}))
  for (const { path, flag } of SECRET_FIELDS) {
    const value = getPath(copy, path)
    delPath(copy, path)
    copy[flag] = typeof value === 'string' && value.length > 0
  }
  return copy
}

/**
 * 把 UI 提交的补丁合并进配置。
 *
 * **空值语义（关键）**：密钥字段为空串 / undefined 时**保留原值**。
 * 因为 UI 拿到的是脱敏后的配置（根本没有那些字段），回传时自然就没有它；
 * 若把它当成"清空"，用户每保存一次就会把密钥弄丢。
 *
 * **唯一的例外是 `clearable` 的字段**（目前只有 `dsh.apiKey`）：
 * 它的空串同样当"保留"，但 **`null` 表示显式清除** —— 用户换号或想改用环境变量时
 * 必须能删掉它，而空串这条语义已经被占用了。见 `SECRET_FIELDS` 的说明。
 */
export function mergeConfigPatch(current, patch) {
  if (!patch || typeof patch !== 'object') throw new Error('提交的内容不是对象')
  const merged = JSON.parse(JSON.stringify(current ?? {}))

  // 先按普通字段深合并
  const deepMerge = (target, source) => {
    for (const [key, value] of Object.entries(source)) {
      // 下划线开头的键是给人看的说明，不参与合并（避免把注释当配置存下来）
      if (key.startsWith('_')) continue
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        if (target[key] === null || typeof target[key] !== 'object' || Array.isArray(target[key])) {
          target[key] = {}
        }
        deepMerge(target[key], value)
      } else {
        target[key] = value
      }
    }
  }
  deepMerge(merged, patch)

  // 再恢复被"空值"覆盖掉的密钥
  for (const { path } of SECRET_FIELDS) {
    const incoming = getPath(merged, path)
    const existing = getPath(current, path)
    if (incoming === '' || incoming === null || incoming === undefined) {
      if (typeof existing === 'string' && existing.length > 0) setPath(merged, path, existing)
      else delPath(merged, path)
    }
  }

  // 最后处理"显式清除"：只对 clearable 的字段生效。
  //
  // ★ 判据必须是**提交的补丁**（patch）里那个值，不能看 merged ——
  //   merged 里的 null 已经被上面"恢复旧值"那一步换成了旧值，
  //   拿它当判据的话这里永远看到"不是 null"，于是**清除永远不生效**
  //   （这个 bug 真的写出来过，被一次真实 HTTP 往返验证抓出来）。
  //
  // 为什么空串不算清除：空串是"UI 没动这个框"的常态（脱敏后回传的配置里本来就没这些字段），
  // 把它当清除会让用户每保存一次配置就丢一次密钥。所以清除只能由 `null` 表达。
  for (const { path, clearable } of SECRET_FIELDS) {
    if (!clearable) continue
    if (getPath(patch, path) !== null) continue
    if (typeof getPath(current, path) === 'string') setPath(merged, path, '')
    else delPath(merged, path)
  }

  return merged
}

/** 统一构造响应。 */
const ok = (data) => ({ status: 200, headers: JSON_HEADERS, body: { ok: true, data } })
const fail = (status, message, extra = {}) => ({
  status,
  headers: JSON_HEADERS,
  body: { ok: false, error: message, ...extra },
})

/**
 * 从请求路径里取一个查询参数。
 *
 * 为什么单独写而不是用 `new URL()`：这里只需要读一个参数，
 * 而 `new URL(path, base)` 会因为"路径不合法"抛错 —— 那条错误路径
 * 对使用者毫无意义。手工解析更笨，但不会凭空失败。
 */
function queryParam(req, key) {
  const qs = String(req?.path ?? '').split('?')[1] ?? ''
  const value = new URLSearchParams(qs).get(key)
  return value === null ? '' : value
}

/**
 * "尚未实现"的占位响应。
 *
 * 用 501（Not Implemented）而不是 404，是刻意的：
 *   · 404 会让调用方以为**路径写错了**，于是去改路径 —— 白折腾；
 *   · 501 明确表达"路径对、功能还没有"，界面和人都知道该等而不是该改。
 *
 * 现在所有接口都已落地，这个函数只在**依赖没注入**时兜底
 * （例如测试里只造了半个 handler）。保留它是因为"可选依赖"这个设计
 * 比"必须全传否则崩"更好测，而"半残的 handler 应该回什么"需要一个统一答案。
 *
 * ⚠️ `verify-manifest.mjs` 会核对：文档里标了「待实现」的接口，代码里
 * 必须且只能走这个函数。接口实现落地后**必须**把文档里的标记删掉，
 * 否则契约测试会红 —— 这是刻意设计的提醒。
 */
function notImplemented(what) {
  return fail(501, `${what}的功能尚未实现`, {
    pending: true,
    hint: '接口路径已确定（见 CONFIG-UI.md §5），但桥接侧没有注入对应的依赖。',
  })
}

/**
 * 创建请求处理器（纯逻辑，不碰 socket）。
 *
 * @param {object} deps
 * @param {() => object} deps.readRawConfig      读磁盘上的原始配置
 * @param {(cfg: object) => void} deps.writeRawConfig  写回磁盘
 * @param {(raw: object) => object} deps.normalize 归一化（用于校验与展示）
 * @param {(cfg: object) => {fatal: string[], warn: string[]}} deps.validate
 * @param {() => object} deps.getStatus          运行状态（含统计）
 * @param {() => Promise<object>} [deps.runDoctor]  体检（可选）
 * @param {() => void} [deps.onConfigSaved]     保存后的回调（例如提示需要重启）
 * @param {() => void} [deps.requestStop]       停止桥接（可选；先响应再执行）
 * @param {() => void} [deps.requestRestart]    重启桥接（可选；先响应再执行）
 * @param {number} [deps.powerActionDelayMs]    停止/重启的延迟（默认 400ms，测试可传 0）
 * @returns {(req: {method: string, path: string, body?: any}) => Promise<object>}
 */
export function createApiHandler(deps) {
  const {
    readRawConfig,
    writeRawConfig,
    normalize,
    validate,
    getStatus,
    getConversations,
    runDoctor,
    onConfigSaved,
    requestStop,
    requestRestart,
    powerActionDelayMs = 400,
    // ── 后加的几组（都可选：不传就回 501，界面按"未实现"容错）──
    getNormalizedConfig,
    detectSnowluma,
    startSnowluma,
    openSnowlumaConsole,
    snowlumaLog,
    // 名单：`roster` 负责判定与缓存，`onebotCall` 是它拉真实名单用的通道
    roster,
    onebotCall,
    priceBook,
    usageLedger,
    memoryStore,
    // 记忆快照的写入/删除（**只有控制台这条路需要它**，理由见下面记忆文件那两个路由）
    saveMemorySnapshot,
    dropMemorySnapshot,
    // 工作区绝对根路径（取图用 —— 对话里的图片只从 workspace/inbox 出）
    workspaceRoot,
    // ── H13 的四组（同样是可选的：不传就回 501）──────────────────────────
    preflight, // 启动前置条件门控：返回 {gates:[{id,ok,level,title,hint,action}]}
    listAccounts, // 协议端账号**摘要**（绝不回 token）
    searchCorpus, // 本地语料检索（fail-closed：必须带会话）
    searchMemory, // 记忆条目检索（只读，不需要会话参数 —— 文件名已经分了档）
    // ── 0.2.1 记忆观测面（统计 + 隐私；全部只读，不做重置/开关）────────────
    memoryStats, // 记忆写入统计 + 零写入告警（阈值在后端 STATS_DEFAULTS，不是配置项）
    privacyAudit, // 隐私拦截审计（只回时间/侧/类别/字数 —— 审计里本来就没有原文）
    scanMemoryPrivacy, // 扫描盘上记忆里的隐私条目（只回文件+行号+类别，不回原文）
    logStream, // 日志流（SSE）
    // ── 0.2.2 扩展（技能 / 插件）：全部可选，不传就回 501 ──────────────────
    //   ★ 这四条与其余路由的**根本差别**：它们是"即时生效"的通道 ——
    //     实现里既写盘又改活配置对象（见 index.mjs 的 applyExtensionChange），
    //     所以界面按开关不需要重启。语义与边界见 docs/插件设计规范.md。
    listExtensions, // GET  /api/extensions            列表（技能 + 插件 + 状态）
    toggleExtension, // POST /api/extensions/toggle     开/关（即时生效）
    saveSkillSettings, // POST /api/extensions/settings   改某个技能的设置（密文留空=不改）
    diagnoseSkill, // GET  /api/extensions/diagnose   技能自诊断（可选导出）
    // ── 0.2.2 人设库（多文件 + 命名 + 切换）───────────────────────────────
    // personasList   GET  /api/personas：人设栏要的全部事实（列表/当前生效/回落/模板）
    // personasAction POST /api/personas：{action:'create'|'save'|'rename'|'delete'|'activate'|'restore-defaults'}
    //   ★ `personasAction` 只**算**，不写配置：它接收路由传进去的 `config`（盘上那份），
    //     需要改配置时回一个 `nextActive`，由路由按 /api/config 的纪律落盘（校验 + .bak）。
    //     这样"配置怎么写"只有一处实现 —— 这也是它能被离线测出来的原因。
    personasList,
    personasAction,
    // ── 0.2.2 联系人昵称（按人）───────────────────────────────────────────
    contactsList, // GET  /api/contacts：读 memory/contacts.md（含认不出来的行）
    contactsSave, // POST /api/contacts：{qq, nickname}（空昵称 = 删除）
  } = deps

  return async function handle(req) {
    const method = String(req?.method ?? 'GET').toUpperCase()
    // 去掉查询串，便于路由匹配
    const path = String(req?.path ?? '/').split('?')[0].replace(/\/+$/, '') || '/'
    const body = req?.body

    try {
      // ── 状态 ──────────────────────────────────────────────────────────
      if (method === 'GET' && path === '/api/status') {
        return ok(getStatus())
      }

      // ── 读配置（脱敏）────────────────────────────────────────────────
      if (method === 'GET' && path === '/api/config') {
        return ok(redactConfig(readRawConfig()))
      }

      // ── 写配置（空 token = 保持原样）─────────────────────────────────
      if (method === 'POST' && path === '/api/config') {
        const current = readRawConfig()
        let merged
        try {
          merged = mergeConfigPatch(current, body)
        } catch (error) {
          return fail(400, error.message)
        }

        // ★ 写盘前先校验：宁可拒绝保存，也不要落一个会让机器人起不来的配置。
        // 这里校验的是"归一化之后的形态"，与启动时用的是同一套规则。
        const { fatal } = validate(normalize(merged))
        if (fatal.length > 0) {
          return fail(422, '配置有问题，已拒绝保存', { fatal })
        }

        // 备份一次，出问题时能人工回滚（轻量、只留一份）
        try {
          const backup = `${deps.configPath}.bak`
          copyFileSync(deps.configPath, backup)
        } catch {
          /* 备份失败不阻断保存 */
        }

        writeRawConfig(merged)
        if (typeof onConfigSaved === 'function') onConfigSaved(merged)

        return ok({
          saved: true,
          // 当前实现里配置只在启动时读一次，所以保存后需要重启才生效。
          // 这一点必须在接口里明确返回，UI 才能给出正确提示。
          restartRequired: true,
          hint: '已保存。需要重启机器人后生效。',
        })
      }

      // ── 扩展（技能 / 插件）：0.2.2 ────────────────────────────────────
      //
      // ★ 与上面 /api/config 的**关键差别**：这一组是**即时生效**的。
      //   用户按下一个技能开关，下一轮对话就该看到效果，所以实现里
      //   既写盘（持久化）也改活配置对象（生效），而不是回一句"请重启"。
      //   代价与边界（工具表要重启才收敛）写在 docs/插件设计规范.md 里，界面上也照实说。
      if (method === 'GET' && path === '/api/extensions') {
        if (typeof listExtensions !== 'function') return notImplemented('扩展列表')
        return ok(listExtensions())
      }

      if (method === 'POST' && path === '/api/extensions/toggle') {
        if (typeof toggleExtension !== 'function') return notImplemented('扩展开关')
        const type = String(body?.type ?? '')
        const id = String(body?.id ?? '')
        const enabled = body?.enabled
        // 参数校验放在路由层：这样"参数写错"与"语义拒绝"是两种不同的错误码（400 vs 422）
        if (type !== 'skill' && type !== 'plugin') return fail(400, 'type 只能是 skill 或 plugin')
        if (!id) return fail(400, '缺少 id')
        if (typeof enabled !== 'boolean') return fail(400, 'enabled 必须是布尔值（true/false）')
        const r = await toggleExtension({ type, id, enabled })
        if (r?.error) return fail(r.status ?? 422, r.error, r.extra ?? {})
        return ok(r)
      }

      if (method === 'POST' && path === '/api/extensions/settings') {
        if (typeof saveSkillSettings !== 'function') return notImplemented('技能设置')
        const id = String(body?.id ?? '')
        if (!id) return fail(400, '缺少 id')
        const patch = body?.patch
        if (patch !== undefined && (patch === null || typeof patch !== 'object' || Array.isArray(patch))) {
          return fail(400, 'patch 必须是对象')
        }
        const r = await saveSkillSettings({ id, patch: patch ?? {} })
        if (r?.error) return fail(r.status ?? 422, r.error, r.extra ?? {})
        return ok(r)
      }

      if (method === 'GET' && path === '/api/extensions/diagnose') {
        const id = queryParam(req, 'id')
        if (!id) return fail(400, '缺少 id')
        if (typeof diagnoseSkill !== 'function') return notImplemented('技能诊断')
        const r = await diagnoseSkill(id)
        if (!r) return fail(404, `没有这个技能，或者它没有提供 diagnose：${id}`)
        return ok(r)
      }

      // ── 人设库（0.2.2）──────────────────────────────────────────────
      //
      // 形状：**一个文件一套人设**，文件名叫什么，人设栏里就叫什么（`personas/<名字>.md`）。
      //
      // ★ 为什么读和写都要经过后端，而不是界面直接读那几个文件：
      //   ① "当前在用哪一套"是**三处规则**合起来的结果（`persona.active` → 老 `custom`
      //      → 老 `preset`），界面自己判必然判错，会出现"界面说在用小鲸鱼、实际注入的是别的"；
      //   ② 改名/删除**会牵着配置走**（删掉正在用的那一套就得同时把 `active` 改掉），
      //      这种"两处同时改"的事只有一处实现才不会漏。
      if (method === 'GET' && path === '/api/personas') {
        if (typeof personasList !== 'function') return notImplemented('人设库')
        const r = personasList()
        if (r?.error) return fail(r.status ?? 500, r.error)
        return ok(r)
      }

      if (method === 'POST' && path === '/api/personas') {
        if (typeof personasAction !== 'function') return notImplemented('人设库')
        const b = body && typeof body === 'object' ? body : {}
        const action = String(b.action ?? '').trim()
        // 参数校验留在路由层：这样"参数写错"是 400，"语义拒绝"（重名/名字非法）是 422
        if (!action) return fail(400, '缺少 action')
        // 动作要看见**盘上**的配置（与 GET /api/config 同源）—— 界面上改完再改，
        // 不允许动作拿着一份启动时的旧配置去判"当前在用哪一套"。
        const raw = readRawConfig()
        const r = await personasAction({
          action,
          config: raw,
          name: b.name === undefined ? undefined : String(b.name),
          to: b.to === undefined ? undefined : String(b.to),
          text: b.text === undefined ? undefined : String(b.text),
          copyFrom: b.copyFrom === undefined ? undefined : String(b.copyFrom),
        })
        if (r?.error) return fail(r.status ?? 422, r.error)
        // 需要改配置的动作（切换/改名跟随/删了正在用的那一套）：走与 /api/config
        // **完全同一套纪律** —— 先校验、备份 .bak、再写。这条不许在别处再实现一份。
        if (r?.nextActive !== undefined) {
          const current = raw.persona && typeof raw.persona === 'object' ? raw.persona : {}
          const merged = { ...raw, persona: { ...current, active: r.nextActive } }
          const { fatal } = validate(normalize(merged))
          if (fatal.length > 0) return fail(422, '配置有问题，已拒绝保存', { fatal })
          try {
            copyFileSync(deps.configPath, `${deps.configPath}.bak`)
          } catch {
            /* 备份失败不阻断保存（与 /api/config 一致） */
          }
          writeRawConfig(merged)
          if (typeof onConfigSaved === 'function') onConfigSaved(merged)
        }
        const data = { ...r }
        // `nextActive` 是实现细节（"配置该怎么改"），界面不需要它
        delete data.nextActive
        // 一次往返就把新状态带回去（界面不用再 GET 一次，少一个不一致的窗口）
        if (typeof personasList === 'function') data.shelf = personasList()
        return ok(data)
      }

      // ── 联系人昵称（按人，0.2.2）──────────────────────────────────────
      //
      // 读写都走 `src/contacts.mjs`：**格式只有一处实现**（界面/CLI 都不许自己拼那几行，
      // 否则"界面写的格式"和"注入时读的格式"迟早对不上，而那种错是静默的）。
      // 语义：昵称**空串 = 删除这个号码**（界面上那个「删除」按钮就是这条）。
      if (method === 'GET' && path === '/api/contacts') {
        if (typeof contactsList !== 'function') return notImplemented('联系人昵称')
        return ok(contactsList())
      }
      if (method === 'POST' && path === '/api/contacts') {
        if (typeof contactsSave !== 'function') return notImplemented('联系人昵称')
        const b = body && typeof body === 'object' ? body : {}
        const r = contactsSave({ qq: String(b.qq ?? '').trim(), nickname: String(b.nickname ?? '') })
        if (r?.error) return fail(r.status ?? 400, r.error)
        return ok(r)
      }

      // ── 配置自检 ──────────────────────────────────────────────────────
      if (method === 'POST' && path === '/api/check') {
        const raw = body && typeof body === 'object' ? body : readRawConfig()
        const result = validate(normalize(raw))
        return ok(result)
      }

      // ── 体检 ──────────────────────────────────────────────────────────
      if (method === 'POST' && path === '/api/doctor') {
        if (typeof runDoctor !== 'function') return fail(501, '体检功能未接入')
        return ok(await runDoctor())
      }

      // ── 停止 / 重启 ───────────────────────────────────────────────────
      // 关键时序：必须**先把响应送回 UI，再执行动作** —— 否则进程先退出，
      // UI 拿到的就是连接重置，分不清"成功了"还是"崩了"。所以动作用
      // setTimeout 延后几百毫秒执行。
      //
      // 为什么没有 /api/start：接口本身就跑在桥接进程里，桥接停了接口
      // 也不在，"远程启动一个没在跑的东西"无处受理。启动仍走 start.bat。
      if (method === 'POST' && path === '/api/stop') {
        if (typeof requestStop !== 'function') return fail(501, '停止功能未接入')
        setTimeout(() => requestStop(), powerActionDelayMs)
        return ok({ stopping: true, hint: '正在停止。再次启动请用 start.bat。' })
      }

      if (method === 'POST' && path === '/api/restart') {
        if (typeof requestRestart !== 'function') return fail(501, '重启功能未接入')
        setTimeout(() => requestRestart(), powerActionDelayMs)
        return ok({ restarting: true, hint: '正在重启，几秒钟后自动恢复。' })
      }

      // ── 会话同步（给"同步 QQ 对话界面"用）────────────────────────────
      // 数据来自桥接的**内存镜像**：最近若干条往来消息 + 每会话当前状态。
      // 它是滚动视图，不是归档 —— 长期记忆是**两层**的（见 memory.mjs）：
      // 私聊 = MEMORY.md + memory/private-<QQ>.md，群聊 = memory/group-<群号>.md。
      // 这句 note 会原样显示给使用者，所以**不能**再写成"长期记忆就是 MEMORY.md"：
      // 群聊根本没有那份文件，这么说会让使用者以为记忆丢了一半。
      if (method === 'GET' && path === '/api/conversations') {
        if (typeof getConversations !== 'function') return ok({ conversations: [], count: 0 })
        const list = getConversations() ?? []
        return ok({
          conversations: list,
          count: list.length,
          note:
            '内存镜像，每会话只保留最近若干条；重启桥接后清空。长期记忆在工作区，分两层：' +
            '私聊 = MEMORY.md（跨人的约定）+ memory/private-<QQ号>.md（这个人的），' +
            '群聊 = memory/group-<群号>.md（群专属，读不到上面两份）。',
        })
      }

      // ── SnowLuma 进程（探测 / 拉起）────────────────────────────────────
      //
      // ★ 这两个接口目前**只有占位**，一律回 501。
      //
      // 为什么先占位而不是等实现完再写文档：`CONFIG-UI.md` 的接口表是
      // **给 UI 生成者看的契约**，而 `mocks/verify-manifest.mjs` 会核对
      // "表里声明的路径都真实存在"。如果只在文档里写、代码里没有，
      // 契约测试会红；而如果为了让测试变绿就把文档删掉，UI 就无从照着做。
      //
      // 占位的好处：路径真实存在（契约成立）、行为诚实（501 = 还没实现，
      // 不是 404 那种"你是不是写错路径了"）、实现落地后直接替换函数体即可，
      // **界面一行都不用改**。
      // ── SnowLuma 进程（探测 / 拉起）────────────────────────────────────
      // 桥接能拉起 SnowLuma、却不能拉起自己：接口跑在桥接进程里，
      // 桥接停了接口也没了（所以没有 /api/start，启动走 start.bat）。
      // SnowLuma 在桥接**外面**，是个独立进程，所以这两件事受理得了。
      if (method === 'GET' && path === '/api/snowluma/detect') {
        if (typeof detectSnowluma !== 'function') return notImplemented('探测 SnowLuma 状态')
        return ok(await detectSnowluma())
      }

      // ── 人员名单（拉真实的好友/群列表，给名单配置用）────────────────────
      //
      // 为什么需要它：名单配置要人**手打号码**，而打错是这类配置最常见的错误，
      // 症状还**静默**（那个人就是不回，你也不知道是打错了还是别的原因）。
      // 有了它就能对着昵称/群名选。
      //
      // `?refresh=1` 强制重新拉取（默认走缓存 —— 好友/群不会频繁变，
      // 而每次都要连协议端、几百毫秒）。
      if (method === 'GET' && path === '/api/roster') {
        if (!roster || typeof onebotCall !== 'function') return notImplemented('拉取好友与群列表')
        const refresh = ['1', 'true', 'yes'].includes(String(queryParam(req, 'refresh')).toLowerCase())
        try {
          const data = await roster.fetchLists(onebotCall, { refresh })
          return ok(data)
        } catch (error) {
          // 连不上协议端是最可能的原因，要说清楚而不是抛一个 fetch failed
          return fail(502, `拉取名单失败：${error?.message ?? error}。检查 SnowLuma 是否在运行。`)
        }
      }

      // ── SnowLuma 终端输出（界面上的"终端"面板）──────────────────────────
      //
      // ★ 读的是 SnowLuma **自己的日志文件**，不是抓它的 stdout。
      //   实测：它以 UTF-8 写日志文件（中文正常），而 stdout 是终端编码
      //   （重定向到文件会变 GBK 乱码）。要给人看的内容变乱码等于没显示。
      if (method === 'GET' && path === '/api/snowluma/log') {
        if (!snowlumaLog) return notImplemented('读取 SnowLuma 终端输出')
        const qs = new URLSearchParams(String(req?.path ?? '').split('?')[1] ?? '')
        const num = (key, fallback) => {
          const raw = qs.get(key)
          if (raw === null) return fallback
          const n = Number(raw)
          return Number.isFinite(n) && n >= 0 ? n : fallback
        }
        const r = snowlumaLog.read({
          offset: num('offset', 0),
          lines: num('lines', 0),
          // `includeDebug=0` 关掉 DEBUG（默认含）
          includeDebug: qs.get('includeDebug') !== '0',
        })
        return r.ok ? ok(r.data) : fail(500, r.error)
      }

      // ── SnowLuma 网页端（按钮打开它）──────────────────────────────────
      // 按钮**不再启动进程**，只打开 SnowLuma 自己的网页端。
      // 启动进程交给 start.bat —— 那是启动时该做的事，而且能避免开出
      // 第二个实例（端口冲突、抢登录态）。
      if (method === 'POST' && path === '/api/snowluma/start') {
        if (typeof openSnowlumaConsole !== 'function') return notImplemented('打开 SnowLuma 网页端')
        const r = await openSnowlumaConsole()
        return r.ok ? ok(r.data) : fail(r.status ?? 500, r.error, {
          ...(r.consoleUrl ? { consoleUrl: r.consoleUrl } : {}),
          ...(typeof r.reachable === 'boolean' ? { reachable: r.reachable } : {}),
        })
      }

      // ── 用量与成本（概览页的用量卡片 + 顶部时段指示灯）──────────────────
      if (method === 'GET' && path === '/api/usage') {
        if (!usageLedger) return notImplemented('查询用量与成本')
        const raw = new URLSearchParams(String(req?.path ?? '').split('?')[1] ?? '').get('days')
        const days = raw === null ? 7 : Number(raw)
        // `days=0` 是"全部"，所以**不能**用 `|| 7` 兜底（0 会被当成假值而变成 7）
        const safeDays = Number.isFinite(days) && days >= 0 ? days : 7
        return ok(usageLedger.summarize(safeDays))
      }

      if (method === 'GET' && path === '/api/usage/prices') {
        if (!priceBook) return notImplemented('查询价目表')
        return ok(priceBook.snapshot())
      }

      // ── 记忆文件（给"记忆"页签：看 + 改 + 删）──────────────────────────
      // 三条底线在 memory-files.mjs 里：只允许工作区内相对路径、只允许 .md、
      // 拒绝软链接。写操作支持 expectedSha256，冲突返回 409。
      if (method === 'GET' && path === '/api/memory/tree') {
        if (!memoryStore) return notImplemented('读取记忆目录树')
        return ok(memoryStore.tree())
      }

      if (method === 'GET' && path === '/api/memory/file') {
        if (!memoryStore) return notImplemented('读取记忆文件')
        const r = memoryStore.read(queryParam(req, 'path'))
        return r.ok ? ok(r.data) : fail(r.status ?? 400, r.error)
      }

      if (method === 'POST' && path === '/api/memory/file') {
        if (!memoryStore) return notImplemented('保存记忆文件')
        const r = memoryStore.write(body?.path, body?.content, body?.expectedSha256)
        // ★★ 写成功之后**必须刷新快照** —— 否则使用者在这里改的记忆，
        //    下一次读记忆时会被"篡改检测"当成绕过桥接的改动**原样回滚**。
        //
        // 为什么会这样：`verifyAndRestoreMemory` 的判据是"文件内容 == 桥接写下的快照"。
        // 控制台这条路走的是 `memoryStore.write`（直接写盘），它不动快照，
        // 于是文件与快照不一致 → 被判成篡改 → 回滚。表现是
        // 「我在界面上删掉了一条，过一会儿它自己又回来了」——
        // 而且**不会报错**，只会让使用者以为界面坏了。
        //
        // 为什么现在把这条路也算"合法写入"：篡改检测要防的是**模型绕过桥接**，
        // 而控制台是桥接自己提供给主人的界面。主人改自己的记忆被回滚，那是缺陷不是安全。
        // （这一段取证的边界仍然成立：**模型**用 write 工具改记忆照样会被回滚。）
        if (r.ok) {
          try {
            saveMemorySnapshot?.(body?.path)
          } catch {
            /* 快照失败不影响保存本身；下次读记忆时会以当时内容重建快照 */
          }
        }
        // ★ 409 是这套接口最重要的分支：模型随时可能在写记忆，
        //   "你编辑期间它写了一次"是常态而非意外。要把当前内容一起带回去，
        //   使用者才有依据判断"谁对"。
        return r.ok
          ? ok(r.data)
          : fail(
              r.status ?? 400,
              r.error,
              r.conflict
                ? { conflict: true, currentSha256: r.currentSha256, currentContent: r.currentContent }
                : {},
            )
      }

      // 删除：UI 已经用上了（`lib/api.ts` 里自己标注了"接口文档暂未列"）。
      // ⚠️ 实现用 `unlinkSync` 而不是 `rmSync` —— 实测后者在本机（Node 24 /
      //    Windows）删单个文件会**静默失败**：不抛错、返回正常，但文件还在。
      //    那会变成"回已删除、其实没删"的谎报，所以要复核 + 换 API。
      if (method === 'DELETE' && path === '/api/memory/file') {
        if (!memoryStore) return notImplemented('删除记忆文件')
        const r = memoryStore.remove(queryParam(req, 'path'))
        // 删完**连快照一起删**：留着它只会让下一次读记忆把刚删掉的文件「复活」
        // （判据是"文件内容 == 快照"，文件没了、快照还在，行为就取决于实现细节 ——
        //  现在是"没有文件就跳过"，但那是**碰巧**安全，不该依赖它）。
        if (r.ok) {
          try {
            dropMemorySnapshot?.(queryParam(req, 'path'))
          } catch {
            /* 同上：不影响删除本身 */
          }
        }
        return r.ok ? ok(r.data) : fail(r.status ?? 400, r.error)
      }

      // ── 工作区图片取图（对话页签显示 messages[].images）───────────────────
      //
      // 这是**只读**的出图口，且只给 `inbox/` 这一个前缀 —— inbox 是模型
      // 取回图片后落盘的目录。为什么不能像记忆文件那样全工作区放开：
      // 工作区里有 config 之类不该经图片通道出的内容（虽然 token 不在工作区，
      // 但"看图接口顺带能把工作区任何文件读出去"是不必要的面）。
      //
      // 返回的是**原始字节**（rawBody，serveApi 不 JSON.stringify），
      // 带正确的 content-type，前端直接 <img src> 即可。
      if (method === 'GET' && path === '/api/workspace-file') {
        if (!workspaceRoot) return notImplemented('读取工作区图片')
        const rel = queryParam(req, 'path')
        // 三层防线：只许 inbox/ 前缀、只许图片扩展名、resolve 后必须落在工作区内
        if (!/^inbox\//.test(rel) || rel.includes('..')) {
          return fail(400, '只允许读取 inbox/ 下的文件')
        }
        const ext = extname(rel).toLowerCase()
        if (!INBOX_IMAGE_MIME[ext]) {
          return fail(400, `只允许图片扩展名（png/jpg/jpeg/webp/gif），收到「${ext || '无'}」`)
        }
        const root = resolve(workspaceRoot)
        const filePath = resolve(join(root, rel))
        if (!filePath.startsWith(root + sep)) return fail(403, '路径越界')
        if (!existsSync(filePath) || !statSync(filePath).isFile()) {
          return fail(404, `文件不存在：${rel}（inbox 保留期内的图片才可能还在）`)
        }
        const size = statSync(filePath).size
        if (size > INBOX_IMAGE_MAX_BYTES) {
          return fail(413, `图片过大（${size} 字节，上限 ${INBOX_IMAGE_MAX_BYTES}）`)
        }
        return {
          status: 200,
          headers: { 'content-type': INBOX_IMAGE_MIME[ext], 'cache-control': 'no-store' },
          rawBody: readFileSync(filePath),
        }
      }

      // ── 现在的 inbox（记忆页签「看图」卡片里的小状态卡）────────────────────
      //
      // 目录不存在**不是错误**（还没收到过任何图片时的常态），回 count:0。
      // 复用 memory/tree 试过、不可行：tree 只列 MEMORY.md 与 memory/，
      // 不列 inbox —— 所以单独给了这条只读路由。
      if (method === 'GET' && path === '/api/inbox') {
        if (!workspaceRoot) return notImplemented('读取 inbox 状态')
        const dir = join(resolve(workspaceRoot), 'inbox')
        if (!existsSync(dir)) return ok({ count: 0, totalBytes: 0, oldestMtime: null, files: [] })
        const files = []
        for (const name of readdirSync(dir)) {
          const filePath = join(dir, name)
          let st
          try {
            st = statSync(filePath)
          } catch {
            continue // 读不到的跳过（极少见：目录里刚被清理掉的文件）
          }
          if (!st.isFile()) continue
          files.push({ name, size: st.size, mtime: st.mtimeMs })
        }
        files.sort((a, b) => a.mtime - b.mtime)
        const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
        return ok({
          count: files.length,
          totalBytes,
          oldestMtime: files.length > 0 ? files[0].mtime : null,
          files,
        })
      }

      // ══════════════════════════════════════════════════════════════════
      // H13：界面要的四组后端能力（**都是只读或"只回摘要"**）
      // ══════════════════════════════════════════════════════════════════

      // ── ① 启动前置条件门控：**失败要给可操作的话**，而不是静默 ────────────
      //
      // 计划里这条与我们第 6 条铁律（失败必须让用户知道）直接对应：
      // 以前"机器人不说话"的典型原因是"协议端没登录/用错了那份配置"，而界面上
      // **什么都没说**。现在把每个前置条件变成一条 `{id, ok, level, title, hint, action}`，
      // 界面只要照着渲染就行 —— 判据都在后端，界面不重复实现（避免两处判断漂移）。
      if (method === 'GET' && path === '/api/preflight') {
        if (!preflight) return notImplemented('启动前置条件检查')
        // ★ `await`：它是异步的（要真的去问一次协议端）。
        //   漏掉 await 的后果不是报错，而是返回一个 Promise → 序列化成 `{}` ——
        //   界面上"什么都没显示"而不报错，是最难查的一种。
        return ok(await preflight())
      }

      // ── ② 账号发现：**只回摘要，绝不回 token** ───────────────────────────
      //
      // 界面上要能"选一个账号"，但**绝不能**把 token 送到浏览器 ——
      // 那等于把机器人的登录凭据复制到每一个能打开这个页面的地方。
      // 所以这里只回：有哪些账号、哪个是当前在用的、以及**为什么**这么判定。
      if (method === 'GET' && path === '/api/snowluma/accounts') {
        if (!listAccounts) return notImplemented('列出协议端账号')
        try {
          const raw = listAccounts() ?? {}
          // ★★ **字段白名单**（纵深防御）：不直接把依赖的返回值转出去。
          //    为什么不能"信任依赖只回摘要"：凭据是这个项目里最敏感的东西，
          //    而"某天有人在那个函数里加一个字段"是完全可能的（比如为了排查方便带回 token）。
          //    白名单让"泄露 token"在**结构上不可能**，而不是靠每个实现者记得。
          //    测试里故意让依赖返回一个 `httpToken`，断言它到不了响应里。
          return ok({
            installDir: String(raw.installDir ?? ''),
            current: raw.current == null ? null : String(raw.current),
            why: String(raw.why ?? ''),
            matchedByConfig: raw.matchedByConfig === true,
            accounts: (Array.isArray(raw.accounts) ? raw.accounts : []).map((a) => ({
              uin: String(a?.uin ?? ''),
              file: String(a?.file ?? ''),
              isCurrent: a?.isCurrent === true,
            })),
          })
        } catch (error) {
          return fail(500, `列账号失败：${error?.message ?? error}`)
        }
      }

      // ── ③ 本地语料检索：给"我上次说的那个…"用 ───────────────────────────
      //
      // ★ **fail-closed**：必须显式给 kind 与 peerId。语料库里存着**所有会话**的消息，
      //   不带会话过滤就等于把别的群/别人的私聊读进这个页面 —— 界面上看一眼就泄露了。
      //   （与 MCP 工具 `qq_search_history` 同一条纪律，两处必须一致。）
      if (method === 'GET' && path === '/api/corpus/search') {
        if (!searchCorpus) return notImplemented('检索本地语料库')
        const q = String(queryParam(req, 'q') ?? '').trim()
        const kind = String(queryParam(req, 'kind') ?? '').trim()
        const peerId = String(queryParam(req, 'peerId') ?? '').trim()
        const limit = Number(queryParam(req, 'limit')) || 20
        if (!q) return fail(400, '要搜什么？给一个 q 参数')
        if ((kind !== 'private' && kind !== 'group') || !peerId) {
          return fail(400, '检索必须指定会话：kind=private|group 且 peerId=QQ号或群号（不跨会话检索）')
        }
        try {
          return ok(searchCorpus({ query: q, chatKey: `${kind}:${peerId}`, limit }))
        } catch (error) {
          return fail(500, `检索失败：${error?.message ?? error}`)
        }
      }

      // ── ③-b 记忆检索：在**沉淀下来的事实**里找条目 ──────────────────────
      //
      // 与语料检索（③）的分工：语料是"说过什么"（消息流水 + TTL），
      // 记忆是"记住的事实"（条目 + 跨重启生效）。这里**不需要会话参数** ——
      // 记忆文件本身就是按会话分档命名的（`MEMORY.md` / `private-*.md` / `group-*.md`），
      // 而"这一个文件属于谁"从文件名就能看出来，不存在"把别的会话内容混进来"的问题。
      if (method === 'GET' && path === '/api/memory/search') {
        if (!searchMemory) return notImplemented('检索记忆')
        const q = String(queryParam(req, 'q') ?? '').trim()
        if (!q) return fail(400, '要搜什么？给一个 q 参数')
        try {
          return ok(searchMemory({ query: q, limit: Number(queryParam(req, 'limit')) || 50 }))
        } catch (error) {
          return fail(500, `检索记忆失败：${error?.message ?? error}`)
        }
      }

      // ── ③-c 记忆写入统计 + 零写入告警（0.2.1）────────────────────────────
      //
      // 为什么必须有：实测事故 —— 聊了两天几十轮、一条记忆都没写，而没有任何
      // 地方报警。四列（轮数/提议/接受/拒绝/去重）必须都给：proposed=0 与
      // ignored 高是两种不同故障，合成一个数字会把排查方向带偏。
      // ★ 只读：不提供"改计数"（伪造观测），也不提供重置（只会让告警重新沉默）。
      if (method === 'GET' && path === '/api/memory/stats') {
        if (!memoryStats) return notImplemented('记忆写入统计')
        try {
          return ok(memoryStats())
        } catch (error) {
          return fail(500, `读取记忆统计失败：${error?.message ?? error}`)
        }
      }

      // ── ③-d 隐私拦截审计 + 盘上扫描（0.2.1）──────────────────────────────
      //
      // ★★ 两条纪律（与 CONFIG-UI.md 对齐）：
      //   1. 绝不回原文 —— 审计只记类别与字数（刻意的），扫描只回**位置**。
      //      界面也不许想办法展示原文，否则拦截本身就成了泄露通道。
      //   2. 不做"关闭隐私闸门"的开关 —— 做成开关就等于给了静默关掉的入口。
      if (method === 'GET' && path === '/api/memory/privacy') {
        if (!privacyAudit) return notImplemented('隐私拦截审计')
        try {
          return ok(privacyAudit({ limit: Number(queryParam(req, 'limit')) || 20 }))
        } catch (error) {
          return fail(500, `读取隐私审计失败：${error?.message ?? error}`)
        }
      }

      // 扫描是 POST 而不是 GET：它要遍历工作区里所有记忆文件，可能比读接口慢，
      // 且语义上是"发起一次检查动作"。仍然是**只读**的 —— 不改任何文件。
      if (method === 'POST' && path === '/api/memory/privacy/scan') {
        if (!scanMemoryPrivacy) return notImplemented('扫描记忆隐私')
        try {
          return ok(await scanMemoryPrivacy())
        } catch (error) {
          return fail(500, `扫描失败：${error?.message ?? error}`)
        }
      }

      // ── ④ 日志流（SSE）：把"正在发生什么"给界面看 ────────────────────────
      //
      // ★ 只读、只跟一个**已存在的**日志文件；不新建、不改写。
      // ★ 依赖没注入时回 501（界面按"未实现"容错），而不是挂一个空连接。
      if (method === 'GET' && path === '/api/logs/stream') {
        if (!logStream) return notImplemented('日志流')
        // ★ 别忘了 `ok()`：真机上这条路由就是漏了它，把整个进程带下线的（见上面收口校验的说明）
        return ok(logStream({ since: Number(queryParam(req, 'since')) || 0, limit: Number(queryParam(req, 'limit')) || 200 }))
      }

      // ── 已换代的旧人设接口：**大声**回答，不要用 404 ────────────────────
      //
      // 0.2.2 把"一套人设三个档 + 一个自定义文本"换成了**人设库**（`personas/<名字>.md`），
      // 接口随之从 `/api/persona`（读）+ `/api/persona/names`（改名字块）换成
      // `/api/personas`（见上面那两条）。
      //
      // ★ 为什么留着这两条而不是直接删：删掉之后它们会落到最下面的 404 ——
      //   而 404 的意思是"你路径写错了"，于是调用方（包括**旧版界面**）会去改路径，
      //   白折腾一轮。这里明确回 `410 Gone` + 新路径，谁看一眼都知道该改什么。
      //   旧版界面的人设页会因此显示一句"接口已换代"，而不是一个说不清的报错。
      if (path === '/api/persona' || path === '/api/persona/names') {
        return fail(410, `接口已换代：${path} → /api/personas`, {
          gone: true,
          use: '/api/personas',
          hint: '0.2.2 起人设改成了「一个文件一套人设」（personas/<名字>.md）。GET /api/personas 读，POST /api/personas 写（action: create/save/rename/delete/activate/restore-defaults）。见 CONFIG-UI.md §5。',
        })
      }

      return fail(404, `没有这个接口：${method} ${path}`)
    } catch (error) {
      // 任何未预料的异常都要变成结构化错误，而不是让请求挂死
      return fail(500, `接口内部错误：${error?.message ?? error}`)
    }
  }
}

/** 请求体大小上限。配置是纯文本，1 MB 绰绰有余；设上限防止被灌爆内存。 */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * inbox 取图的扩展名白名单与单张上限。
 * 上限取 20 MB：inbox 落盘前已按 image.maxBytes 限过（默认 10MB），
 * 这里留一倍余量，避免"配置调大后接口又砍一刀"。
 */
const INBOX_IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
const INBOX_IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** 静态文件的 MIME 表（控制台界面用到的就这几类）。 */
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * 创建静态文件处理器（伺服构建好的控制台界面）。
 *
 * 安全上只有两条，但都是硬性的：
 *   ① 路径必须落在 staticDir 之内（防 ../../ 穿越读到配置或 token 文件）；
 *   ② 只认 GET/HEAD。
 * 监听地址本身已被 assertLoopbackOnly 锁死在回环，静态内容不出本机。
 *
 * 找不到的文件回退到 index.html（SPA 约定，前端路由自己处理）。
 */
function makeStaticHandler(staticDir) {
  const root = resolve(staticDir)
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: '静态资源只支持 GET' }))
      return
    }
    let pathname
    try {
      pathname = decodeURIComponent(String(req.url ?? '/').split('?')[0])
    } catch {
      res.writeHead(400, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: 'URL 不合法' }))
      return
    }
    if (pathname.endsWith('/')) pathname += 'index.html'

    const filePath = resolve(join(root, pathname))
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(403, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: '路径越界' }))
      return
    }

    let file = filePath
    if (!existsSync(file) || !statSync(file).isFile()) {
      file = join(root, 'index.html') // SPA 回退
      if (!existsSync(file)) {
        res.writeHead(404, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: '控制台界面未构建（缺少 config-ui/dist）' }))
        return
      }
    }

    const ext = extname(file).toLowerCase()
    res.writeHead(200, {
      'content-type': STATIC_MIME[ext] ?? 'application/octet-stream',
      // HTML 不缓存（保证拿到最新壳）；带 hash 的静态资源可以缓存
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    })
    res.end(readFileSync(file))
  }
}

/**
 * 启动 HTTP 接口服务。
 *
 * 为什么用 `node:http` 而不是引入 Express 之类：本项目的"可搬迁性"原则要求
 * 运行期依赖越少越好（当前只有 `ws` 一个）。这几个接口用内置模块足够。
 *
 * ⚠️ 默认只绑 `127.0.0.1`，且**拒绝**其他地址（见 assertLoopbackOnly）。
 *
 * @param {object} opts
 * @param {number} [opts.port] 默认 3410（避开 SnowLuma 的 3000/3001 与 QQ 桌面版常用端口）
 * @param {string} [opts.host]
 * @param {(req) => Promise<object>} opts.handler createApiHandler 的产物
 * @param {string} [opts.staticDir] 控制台界面的构建产物目录（存在则伺服在 / 下）
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export function serveApi({ port = 3410, host = '127.0.0.1', handler, staticDir, log = () => {} }) {
  assertLoopbackOnly(host)
  const staticHandler = staticDir ? makeStaticHandler(staticDir) : null

  const server = createServer((req, res) => {
    // /api 走接口，其余路径交给静态界面（有的话）
    const urlPath = String(req.url ?? '/').split('?')[0]
    if (staticHandler && !urlPath.startsWith('/api')) {
      staticHandler(req, res)
      return
    }

    const chunks = []
    let size = 0
    let aborted = false

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        aborted = true
        res.writeHead(413, JSON_HEADERS)
        res.end(JSON.stringify({ ok: false, error: '请求体过大' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', async () => {
      if (aborted) return
      let parsed = undefined
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim()) {
        try {
          parsed = JSON.parse(text)
        } catch {
          res.writeHead(400, JSON_HEADERS)
          res.end(JSON.stringify({ ok: false, error: '请求体不是合法 JSON' }))
          return
        }
      }

      let result
      try {
        result = await handler({ method: req.method ?? 'GET', path: req.url ?? '/', body: parsed })
      } catch (error) {
        result = { status: 500, headers: JSON_HEADERS, body: { ok: false, error: String(error?.message ?? error) } }
      }

      // ★★ H13：**收口校验** —— 一条路由返回了畸形结果，绝不能拖垮整个进程。
      //
      // 真机事故（2026-09-27）：新加的一条路由忘了用 `ok()` 包结果，直接返回了自己的对象，
      // 于是 `result.status` 是 `undefined` → `res.writeHead(undefined)` 抛
      // `RangeError [ERR_HTTP_INVALID_STATUS_CODE]`，**而它发生在 `req.on('end')` 的
      // async 回调里**，所以没人接住 → 未处理的 Promise 拒绝 → 进程按既定策略收尾退出。
      // 结果：**一个新接口写错，整个机器人下线**（而且症状是"连不上 3410"，看起来像端口问题）。
      //
      // 所以这里做一次结构校验：不符合 `{status: number}` 一律变成 500 并**留下证据**，
      // 而不是把畸形值交给 `writeHead`。
      if (!result || typeof result.status !== 'number' || !Number.isInteger(result.status)) {
        const shape = result === undefined ? 'undefined' : Array.isArray(result) ? 'array' : typeof result
        log?.(`❌ [api] 路由返回了畸形结果（type=${shape}，status=${result?.status ?? '?'}）→ 当成 500。` +
          '这是**代码缺陷**：路由必须返回 ok(...) / fail(...)')
        result = {
          status: 500,
          headers: JSON_HEADERS,
          body: { ok: false, error: '接口内部错误：这条路由返回了畸形结果（已记日志，不影响其它接口）' },
        }
      }

      res.writeHead(result.status, result.headers ?? JSON_HEADERS)
      // rawBody 是原始字节（图片等二进制内容），**不能** JSON.stringify
      res.end(result.rawBody !== undefined ? result.rawBody : JSON.stringify(result.body))
    })

    req.on('error', () => {
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.on('error', (error) => {
      // 端口被占用是最常见的启动失败，给出可执行的建议而不是原始 errno
      if (error?.code === 'EADDRINUSE') {
        reject(
          new Error(
            `配置接口端口 ${port} 已被占用。请改 config.json 的 ui.apiPort，或关掉占用它的程序。`,
          ),
        )
        return
      }
      reject(error)
    })
    server.listen(port, host, () => {
      // ★ 报**实际**端口，不是传入的那个。
      //   传 0 时由系统分配随机端口（测试用），此时若回报 0，调用方就没法连上 ——
      //   而"我明明起了服务却连不上"这类问题排查起来很费时间。
      const actualPort = server.address()?.port ?? port
      log(`配置接口已监听 http://${host}:${actualPort}（仅本机可访问）`)
      resolve({
        port: actualPort,
        close: () =>
          new Promise((r) => {
            server.close(() => r())
          }),
      })
    })
  })
}
