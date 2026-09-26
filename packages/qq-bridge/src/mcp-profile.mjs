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

/**
 * 生成 MCP 服务器需要的配置文件（含 OneBot 端点与 token）。
 *
 * ⚠️ 这个文件**含 token**，所以：
 *   · 只写到 cache 目录，不进 git（见 .gitignore）
 *   · 不写进 workspace（那里会被 agent 读到，而 agent 不该看到 token）
 */
export function writeMcpConfig({ cacheDir, httpUrl, httpToken, timeoutMs }) {
  mkdirSync(cacheDir, { recursive: true })
  const path = join(cacheDir, 'mcp-qq.config.json')
  const body =
    JSON.stringify({ httpUrl, httpToken, timeoutMs: timeoutMs ?? 20_000 }, null, 2) + '\n'
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
 * @returns {{changed: boolean, path: string}}
 */
export function ensureSdkProfilePatch({ profilePatchPath, nodePath, serverPath, configPath }) {
  mkdirSync(dirname(profilePatchPath), { recursive: true })

  const block = [
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

  let existing = ''
  try {
    if (existsSync(profilePatchPath)) existing = readFileSync(profilePatchPath, 'utf8')
  } catch {
    existing = ''
  }

  // ── 幂等：已有标记就替换标记之间的内容；否则插入 ─────────────────────
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
  let next
  const beginIdx = existing.indexOf(MARK_BEGIN)
  const endIdx = existing.indexOf(MARK_END)
  if (beginIdx >= 0 && endIdx > beginIdx) {
    next = existing.slice(0, beginIdx) + block + existing.slice(endIdx + MARK_END.length)
  } else {
    // 去掉"空的列表占位符"（`[]`，可能带注释、可能独占一行）
    const withoutEmptyList = existing.replace(/^\s*\[\]\s*$/m, '')
    const base = withoutEmptyList.replace(/\s*$/, '')
    next = (base ? base + '\n\n' : '') + block + '\n'
  }

  const changed = next !== existing
  if (changed) writeFileSync(profilePatchPath, next, 'utf8')
  return { changed, path: profilePatchPath }
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
