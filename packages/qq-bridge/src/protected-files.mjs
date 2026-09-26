/**
 * **受保护路径清单**（H16）：升级/发布时**绝不能碰**的用户数据。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要有它（不是文档问题，是**泄露**问题）
 * ══════════════════════════════════════════════════════════════════════════
 * 发布脚本是"按清单拷贝"的：`COPY_DIRS` / `COPY_FILES` 里列了什么，zip 里就有什么。
 * 于是**往清单里多写一行**（比如顺手加上 `workspace-qq` 或 `logs`）就会把
 * **某个真实使用者的聊天记忆、日志、token**打进发布包 —— 而那不会有任何报错，
 * 打包的人也不会看出来（zip 里多两个目录而已）。
 *
 * 同理，升级路径上的"删掉旧目录再铺新的"如果**没有清单约束**，一次手滑就能删掉
 * 用户的整个工作区。本项目已经为"看起来更省事的写法"付过学费（`rmSync` 在 Windows 上
 * 静默失败、中文文件名会把进程崩掉），所以这里把清单写成**可执行的数据**，
 * 并让发布脚本与测试都来消费它。
 *
 * ── 两类东西，别混 ────────────────────────────────────────────────────────
 *   · **用户数据**（本模块）：属于使用者，**永不入包、永不被覆盖**
 *   · **构建产物**（`config-ui/dist`、`vendor/node`）：属于我们，**可以重生成**
 */

/**
 * 受保护路径（相对包根）。
 *
 * ⚠️ 加这条清单时请一并写清"为什么" —— 清单的价值全在理由里：
 * 只写个路径名，下一个人不知道它为什么不能动，就会顺手删掉。
 */
/**
 * 受保护路径（相对包根）。
 *
 * ⚠️ 加这条清单时请一并写清"为什么" —— 清单的价值全在理由里：
 * 只写个路径名，下一个人不知道它为什么不能动，就会顺手删掉。
 *
 * `kind` 三分类（**别混**，混了就会出现"该删的删不掉 / 不该删的被删了"）：
 *   · `user`     —— **使用者的数据**：不许进包、不许覆盖、**任何脚本都不许删**
 *   · `artifact` —— **我们自己的产物**：不许进包（那不是源），但可以重生成/删掉
 *   · `junk`     —— **临时残留**：可以清掉，同样不许进包
 */
export const PROTECTED_USER_PATHS = [
  // ── user：使用者的数据 ────────────────────────────────────────────────
  { rel: 'config.json', kind: 'user', why: '使用者的配置：token、管理员名单、白名单、模型设置 —— 泄露等于把机器人交出去' },
  { rel: 'workspace-qq', kind: 'user', why: '工作区：**聊天记忆**（MEMORY.md 与 memory/）、inbox、runtime、store —— 这是使用者的私人数据' },
  { rel: 'logs', kind: 'user', why: '日志含有消息正文与排查细节，可能含隐私' },
  { rel: 'cache', kind: 'user', why: '运行时缓存（用量记账、图片临时件），属于本机状态' },
  { rel: 'snowluma', kind: 'user', why: '协议端本体：**许可证不允许**随包分发，且里面含使用者的账号 token' },
  // ── artifact：我们自己的产物（可删、可重生成，只是不进包）───────────────
  { rel: 'node_modules', kind: 'artifact', why: '开发期依赖目录（运行期依赖走 vendor/，由 setup.mjs 复制）' },
  { rel: '_release', kind: 'artifact', why: '发布产物目录，不是源' },
  // ── junk：测试残留 ────────────────────────────────────────────────────
  { rel: '.tmp-probe-dsh', kind: 'junk', why: '测试临时目录（DSH 探针残留），可以清掉，但不许进包' },
  { rel: '.tmp-verify-mcp', kind: 'junk', why: '测试临时目录（MCP 子进程残留），可以清掉，但不许进包' },
]

/** 可以安全清掉的"垃圾"路径（测试残留）。 */
export function disposablePaths() {
  return PROTECTED_USER_PATHS.filter((it) => it.kind === 'junk').map((it) => it.rel)
}

/**
 * 归一化成"相对包根、无前后斜杠、正斜杠"的形式，便于比较（Windows 上两种斜杠都会出现）。
 *
 * ★★ **比较时必须忽略大小写**：Windows 的文件系统不区分大小写，`LOGS` 与 `logs`
 *    是**同一个目录**。只按区分大小写的字符串比，`LOGS` 就能绕过受保护清单 ——
 *    而这种绕过**不会有任何报错**（打包照常成功，只是把日志打进去了）。
 *    所以本模块所有判定都走 `compareKey()`。
 */
export function normalizeRel(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '') // ★ 前导斜杠也要去（`\logs\` 归一化后曾经是 `/logs`，与 `logs` 比不相等）
    .replace(/\/+$/, '')
    .trim()
}

/** 用于**比较**的键：在归一化基础上再折成小写（Windows 语义）。 */
export function compareKey(p) {
  return normalizeRel(p).toLowerCase()
}

/** 命中受保护清单（**任意类别**）—— 用于"不许进包"这道门。 */
export function isProtectedPath(rel) {
  const p = compareKey(rel)
  if (!p) return null
  return (
    PROTECTED_USER_PATHS.find((it) => {
      const base = compareKey(it.rel)
      return p === base || p.startsWith(`${base}/`)
    }) ?? null
  )
}

/** 只命中**使用者数据**那一类 —— 用于"任何脚本都不许删"这道门。 */
export function isUserDataPath(rel) {
  const hit = isProtectedPath(rel)
  return hit && hit.kind === 'user' ? hit : null
}

/**
 * 发布输入端自检：把要拷进 zip 的目录/文件过一遍受保护清单。
 *
 * @param {{dirs?: string[], files?: string[]}} opts
 * @returns {{ok: boolean, problems: {rel: string, why: string}[]}}
 */
export function auditReleaseInputs({ dirs = [], files = [] } = {}) {
  const problems = []
  for (const rel of [...dirs, ...files]) {
    const hit = isProtectedPath(rel)
    if (hit) problems.push({ rel: normalizeRel(rel), why: hit.why })
  }
  return { ok: problems.length === 0, problems }
}

/**
 * 删除前的检查：**只保护使用者数据**，允许删我们自己的产物与垃圾。
 *
 * 判据是**标记文件**（我们自己写进去的），而不是"目录名长得像" —— 名字可以重名。
 *
 * @param {{dir: string, markerFiles?: string[], exists?: Function, hasFiles?: boolean}} opts
 * @returns {{ok: boolean, why: string}}
 */
export function classifyDeleteTarget({ dir, markerFiles = [], exists = () => false, hasFiles = false } = {}) {
  const p = normalizeRel(dir)
  if (!p) return { ok: false, why: '路径为空，拒绝删除' }
  const hit = isUserDataPath(p)
  if (hit) return { ok: false, why: `这是**使用者的数据**（${hit.why}），任何脚本都不许删它` }
  if (!exists()) return { ok: true, why: '目录不存在，没什么可删' }
  const markers = markerFiles.filter(Boolean)
  if (markers.some((m) => exists(m))) return { ok: true, why: '标识文件在，确认是我们自己生成的产物' }
  if (hasFiles) {
    return {
      ok: false,
      why: '目录非空、又没有我们的标识文件 → **拒绝删除**（它可能是别人放的东西）',
    }
  }
  return { ok: true, why: '空目录' }
}

/** 渲染成给人看的一段（RELEASE.md / 体检 / 发布脚本共用，避免两处文案分叉）。 */
export function renderProtectedList() {
  const label = { user: '使用者的数据（不许进包、不许覆盖、不许删）', artifact: '我们自己的产物（不进包，可重生成）', junk: '临时残留（可清掉，不进包）' }
  const lines = []
  for (const kind of ['user', 'artifact', 'junk']) {
    const items = PROTECTED_USER_PATHS.filter((it) => it.kind === kind)
    if (items.length === 0) continue
    lines.push(`${label[kind]}：`)
    for (const it of items) lines.push(`  · \`${it.rel}\` —— ${it.why}`)
  }
  return lines.join('\n')
}
