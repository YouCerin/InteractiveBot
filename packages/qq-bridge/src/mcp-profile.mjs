/**
 * 把「QQ 工具 MCP 服务器」挂进 `sdk` profile。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一步在解决什么（架构缺口的最后一环）
 * ══════════════════════════════════════════════════════════════════════════
 *   · 模型跑在 `dsh --profile sdk` 子进程里，**看不到**桥接手上的 OneBot 连接
 *   · SDK 只暴露 initialize / session/prompt / shutdown，**没有工具通道**
 *   · 所以桥接没法把自己的 QQ 能力直接塞给模型
 *
 * 唯一可行的接法：**让 DSH 自己的 MCP 客户端加载我们的工具服务器**。
 * MCP 工具会进模型的工具表，模型就能像调 `read`/`bash` 一样调 QQ 动作。
 *
 * 而 `dsh-base` 里**没有**挂 MCP 客户端（实测 grep 过），
 * 所以要由桥接往 sdk profile 的 patch 里**加一行 insert**。
 *
 * ── 为什么由桥接在运行时生成，而不是让用户手改 ──────────────────────────
 * insert 里需要 `command`（node 可执行文件的绝对路径）和 `--config`
 * （配置文件的绝对路径）。这两样都取决于"这个包被放在哪"，
 * 写死会让包一搬走就废（这正是本项目反复强调的可搬迁性原则）。
 * 桥接在每次启动时按自己当前的位置重算，就永远是对的。
 *
 * ── 幂等与安全 ──────────────────────────────────────────────────────────
 *   · 每次启动重写这几个文件；内容相同就不写（避免无谓触发 DSH 重载）
 *   · 只往 profile patch **追加**自己那一段，用标记定位，不动别人的内容
 *   · 任何一步失败都**只降级、不阻断**桥接启动（QQ 功能是增强，不是必需）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** patch 里用来标记"这段是我们加的"，便于幂等更新。 */
const MARK_BEGIN = '# >>> qq-bridge: qq tools (MCP) — 由桥接自动维护，不要手改这段 >>>'
const MARK_END = '# <<< qq-bridge: qq tools (MCP) <<<'

/** 第二个受管块：技能工具（0.2.2）。装/卸技能时生成或整块删除。 */
const SKILL_MARK_BEGIN = '# >>> qq-bridge: skill tools (MCP) — 由桥接自动维护，不要手改这段 >>>'
const SKILL_MARK_END = '# <<< qq-bridge: skill tools (MCP) <<<'

/**
 * 生成 MCP 服务器需要的配置文件（含 OneBot 端点与 token）。
 *
 * ⚠️ 这个文件**含 token**，所以：
 *   · 只写到 cache 目录，不进 git（见 .gitignore）
 *   · 不写进 workspace（那里会被 agent 读到，而 agent 不该看到 token）
 */
export function writeMcpConfig({
  cacheDir,
  httpUrl,
  httpToken,
  timeoutMs,
  workspace = null,
  configPath = null,
  profile = 'full',
  genericApi = true,
}) {
  mkdirSync(cacheDir, { recursive: true })
  const path = join(cacheDir, 'mcp-qq.config.json')
  // ★ `workspace` 是 H7 加的：`qq_search_history` 工具要读工作区里的语料库
  //   （`runtime/corpus.sqlite`）。它**不含密钥**，所以放进这份配置是安全的
  //   （这份配置本来就在 cache/ 里、不进工作区；见上面的注释）。
  // ★ `configPath` 是 0.2.2 加的：`qq_send_image` 要现读 `security.allowPrivateImageHosts`，
  //   而且必须**每次调用现读**（否则界面上打开开关还要重启才生效 —— 那正是这一版在消灭的毛病）。
  //   config.json 本来就含 token/apiKey，而本进程已经拿到了 httpToken，所以这不扩大暴露面。
  const body =
    JSON.stringify(
      {
        httpUrl,
        httpToken,
        timeoutMs: timeoutMs ?? 20_000,
        ...(workspace ? { workspace } : {}),
        ...(configPath ? { configPath } : {}),
        // ★ 0.2.3：暴露档位与通用口开关 —— MCP 子进程读它们决定 tools/list 放哪些工具。
        //   写在**这份 configuration**（而不是重写 cordis.patch.yml）的原因：
        //   存档位不需要动 profile 补丁，而且 `loadConfig()` 本来就在读这个文件。
        //   ⚠️ 代价是要重启 DSH 子进程才重新 `tools/list`（与 mcp.enabled 同一条语义）。
        profile,
        genericApi,
      },
      null,
      2,
    ) + '\n'
  writeJsonIfChanged(path, body)
  return path
}

/**
 * 生成**技能工具** MCP 服务器需要的配置文件（0.2.2）。
 *
 * 与上面那份的区别：这份**不含 token**，只有"技能目录在哪 / config.json 在哪"。
 * 技能工具（例如 pixiv 的查图）不需要 QQ 凭证，所以没有理由把 token 递给它 ——
 * 一份进程要什么就给什么，是这里唯一的安全设计。
 */
export function writeSkillsMcpConfig({ cacheDir, skillsDir, configPath, workspace = null }) {
  mkdirSync(cacheDir, { recursive: true })
  const path = join(cacheDir, 'mcp-skills.config.json')
  const body =
    JSON.stringify(
      { skillsDir, configPath, ...(workspace ? { workspace } : {}) },
      null,
      2,
    ) + '\n'
  writeJsonIfChanged(path, body)
  return path
}

/** 只在内容变化时写盘（避免每次启动都改文件时间）。 */
function writeJsonIfChanged(path, body) {
  try {
    if (existsSync(path) && readFileSync(path, 'utf8') === body) return false
  } catch {
    /* 读失败就照写 */
  }
  writeFileSync(path, body, 'utf8')
  return true
}

/**
 * 把 MCP 客户端 insert 写进 sdk profile 的 patch 文件。
 *
 * @param {object} opts
 * @param {string} opts.profilePatchPath `<DSH_HOME>/profiles/sdk/cordis.patch.yml`
 * @param {string} opts.nodePath         用作 command 的 node 可执行文件
 * @param {string} opts.serverPath       mcp/mcp-qq-server.mjs 的绝对路径
 * @param {string} opts.configPath       上面生成的 MCP 配置文件
 * @param {{serverPath: string, configPath: string, timeoutMs?: number}|null} [opts.skills]
 *        技能工具服务器（0.2.2）。**null 时整块删除** —— 没装任何技能就不该多起一个进程。
 * @returns {{changed: boolean, path: string, blocks: number}}
 */
export function ensureSdkProfilePatch({ profilePatchPath, nodePath, serverPath, configPath, skills = null }) {
  mkdirSync(dirname(profilePatchPath), { recursive: true })

  const qqBlock = [
    MARK_BEGIN,
    '- insert:',
    '    - id: qq-bridge-tools',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        transport: stdio',
    '        serverName: qq',
    `        command: ${yamlString(nodePath)}`,
    '        args:',
    `          - ${yamlString(serverPath)}`,
    "          - '--config'",
    `          - ${yamlString(configPath)}`,
    '        # 工具调用超时：QQ 动作偶尔会慢（发文件、查历史）',
    '        toolCallTimeoutMs: 30000',
    '        # QQ 工具不是启动必需：出问题不要让 DSH 起不来',
    '        failOnStartupError: false',
    MARK_END,
  ].join('\n')

  // ── 技能工具服务器（0.2.2）────────────────────────────────────────────────
  //
  // 为什么**单独一个 MCP 服务器**、而不是塞进上面那个 QQ 工具服务器：
  //   ① 隔离：技能是第三方代码，它崩了不该把 QQ 动作一起带走（两个进程各自 failOnStartupError:false）；
  //   ② 权限：技能工具不需要 QQ token，所以那份配置里就没有 token；
  //   ③ 零成本：没装技能时这一块**整块不写**，不多起进程、不多一次握手。
  //
  // 超时给到 60 秒：技能经常要联网（pixiv 走代理首次握手就可能十几秒），
  // 用 QQ 动作那个 30 秒会切掉正常查询。
  const skillsBlock = skills
    ? [
        SKILL_MARK_BEGIN,
        '- insert:',
        '    - id: qq-bridge-skill-tools',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        '      config:',
        '        transport: stdio',
        '        serverName: skills',
        `        command: ${yamlString(nodePath)}`,
        '        args:',
        `          - ${yamlString(skills.serverPath)}`,
        "          - '--config'",
        `          - ${yamlString(skills.configPath)}`,
        '        # 技能经常要联网，给足超时；技能坏了不要连累 DSH 启动',
        `        toolCallTimeoutMs: ${Number(skills.timeoutMs) > 0 ? Math.trunc(Number(skills.timeoutMs)) : 60000}`,
        '        failOnStartupError: false',
        SKILL_MARK_END,
      ].join('\n')
    : ''

  let existing = ''
  try {
    if (existsSync(profilePatchPath)) existing = readFileSync(profilePatchPath, 'utf8')
  } catch {
    existing = ''
  }

  // ── 幂等：先整块摘掉我们写过的两段，再按当前需要重新追加 ─────────────────
  //
  // ⚠️ 这里踩过一个坑，而且**后果是 DSH 直接起不来**：
  // profile 的 patch 模板内容是**一个空列表 `[]`**。第一版只是在文件末尾
  // 追加我们的条目，于是变成：
  //     []
  //     - insert:
  //         …
  // YAML 解析报 `end of the stream or a document separator is expected`，
  // 整个 sdk profile 加载失败 → 桥接起不来。实测错误原文很长，
  // 但根因就是这个"空列表 + 另一个列表"。
  //
  // 正确做法：**把那个空列表替换掉**，而不是追加在它后面。
  // 0.2.2 起有两段受管内容，所以改成"先摘干净、再统一追加" —— 这样
  // "装过的技能被删掉"时那一块会被真的移除（否则 profile 里会永远留着一个
  // 指向不存在目录的服务器）。
  let body = existing
  for (const [b, e] of [
    [MARK_BEGIN, MARK_END],
    [SKILL_MARK_BEGIN, SKILL_MARK_END],
  ]) {
    const i = body.indexOf(b)
    const j = body.indexOf(e)
    if (i >= 0 && j > i) {
      // 连同紧贴前后的空行一起摘掉，避免每摘一次就多一行空行（幂等性靠这个成立）
      body = body.slice(0, i).replace(/\n+$/, '') + '\n' + body.slice(j + e.length).replace(/^\n+/, '')
    }
  }
  // 去掉"空的列表占位符"（`[]`，可能带注释、可能独占一行）
  body = body.replace(/^\s*\[\]\s*$/m, '')

  const wanted = [qqBlock, skillsBlock].filter(Boolean)
  const base = body.replace(/\s*$/, '')
  const next = (base ? base + '\n\n' : '') + wanted.join('\n\n') + '\n'

  const changed = next !== existing
  if (changed) writeFileSync(profilePatchPath, next, 'utf8')
  return { changed, path: profilePatchPath, blocks: wanted.length }
}

/**
 * 把一个值渲染成 YAML 单引号字符串。
 *
 * Windows 路径里全是反斜杠，YAML 里必须转义或加引号 —— 这里统一用单引号，
 * 并把值里**本来就有**的单引号翻倍（YAML 的单引号转义规则）。
 */
function yamlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}
