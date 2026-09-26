/**
 * 从 DSH 的凭据文件里取 API key，用于**启动 DSH 子进程时注入环境变量**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个（一次真实的"机器人完全不输出内容"故障）
 * ══════════════════════════════════════════════════════════════════════════
 * 症状：QQ 里发消息，机器人回一句兜底话术（"（这次没有产生回复内容，请再试一次。）"），
 * 日志写 `回合结束但无文本输出`，事件序列里**只有 `assistant/attempt` 没有
 * `assistant/message`**，而且"思考+工具"只有 160ms。
 *
 * 探针拿到的原始错误（DSH 自己报的）：
 *
 *     llm-deepseek: no API key for provider route "deepseek-official";
 *     store DEEPSEEK_API_KEY through the credentials service
 *     (the web Models page writes it), or export DEEPSEEK_API_KEY
 *     in the launching environment
 *     code: MISSING_CREDENTIAL
 *
 * 也就是说：**模型调用因为缺 key 直接失败了**，请求在 160ms 内带着错误返回。
 * "没有输出"是必然结果，跟提示词/记忆/权限都无关。
 *
 * ── 为什么桌面版能用、桥接不能用 ────────────────────────────────────────
 * key 存在 `$DSH_HOME/.credentials.yaml` 的 `refs` 段里，而
 * `dsh-credentials-local` 的注释写明了优先级：
 *
 *   > $DSH_HOME/.credentials.yaml  (provider-managed, writable)
 *   > The inherited environment wins because `DEEPSEEK_API_KEY=… dsh`, a CI …
 *
 * **环境变量优先。** 桌面版把它跑在能读凭据的进程里，而桥接起的是普通
 * node 子进程 —— 既没有环境变量，也没有被注入凭据。所以桥接负责把它读出来、
 * 以环境变量形式交给子进程。
 *
 * ── 安全 ────────────────────────────────────────────────────────────────
 * · 只读 `DEEPSEEK_API_KEY` 这一个键，**不解析整份文件**（里面还有 OAuth secret）
 * · 读到的值**只放进子进程环境**，从不写日志、不进 HTTP 响应
 * · 环境变量里已有值时**以它为准**（与 dsh 自己的优先级一致）
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 凭据文件名（与 dsh-credentials-local 的常量一致）。 */
export const CREDENTIALS_FILENAME = '.credentials.yaml'

/**
 * 从一份 YAML 文本里取出 `refs.<name>` 的值。
 *
 * 为什么手写而不是引 YAML 库：本项目的"可搬迁性"原则要求运行期依赖尽量少
 * （当前只有 `ws`）。而这里只需要**一个扁平小段**，手写解析器足够，
 * 也不用担心库对特殊缩进的解释差异。
 *
 * 解析规则（够用就好，不追求完整 YAML）：
 *   · 维护一个"缩进 → 键名"的栈来定位路径
 *   · 只认 `key: value` 这种简单行；`key:` 结尾表示进入下一层
 *   · 值两端引号会被剥掉；`#` 后的内容视为注释
 */
export function readYamlPath(text, wantedPath) {
  const stack = [] // [{ indent, key }]
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\t/g, '  ')
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const indent = line.length - line.trimStart().length
    const m = /^([A-Za-z0-9_.\-/]+)\s*:\s*(.*)$/.exec(trimmed)
    if (!m) continue

    const key = m[1]
    let value = m[2].trim()

    // 弹出比当前更深的层级
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()

    const path = [...stack.map((s) => s.key), key]
    const isLeaf = value !== ''

    if (isLeaf) {
      // 去注释（只在没有引号时安全地做）
      if (!/^['"]/.test(value)) value = value.split(/\s+#/)[0].trim()
      value = value.replace(/^['"]/, '').replace(/['"]$/, '')
      if (path.join('.') === wantedPath.join('.')) return value
    } else {
      stack.push({ indent, key })
    }
  }
  return null
}

/**
 * 取出要注入 DSH 子进程的环境变量。
 *
 * **优先级（三者任一即可，与 dsh 自己的优先级保持一致）**：
 *   ① 环境变量 `DEEPSEEK_API_KEY`
 *   ② `config.json` 的 `dsh.apiKey`   ← 发布包的主要来源（用户自己在界面里填）
 *   ③ `$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`（DSH 桌面版「模型」页填的那份）
 *
 * 三者用的都是**同一把账号级 key**，所以谁先谁后都不会改变结果，只决定"从哪读到"。
 * ② 的存在是这次发布包改造的核心：不随包分发 DSH 的用户，手里没有 ③ 那个文件。
 *
 * @param {object} opts
 * @param {string} [opts.apiKey]  用户在 config.json / 界面里填的 key
 * @param {string} opts.dshHome   harness 根目录（`.credentials.yaml` 所在处）
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {{env: Record<string,string>, source: string|null, warning: string|null}}
 */
export function resolveModelCredentials({ dshHome, env = process.env, apiKey } = {}) {
  // ① 环境变量优先 —— 与 dsh 自己的优先级一致
  if (env?.DEEPSEEK_API_KEY) {
    return { env: { DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY }, source: '环境变量', warning: null }
  }

  // ② 用户在配置里填的（发布包的主路径）
  const fromConfig = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (fromConfig) {
    return { env: { DEEPSEEK_API_KEY: fromConfig }, source: 'config.json 的 dsh.apiKey', warning: null }
  }

  if (!dshHome) {
    return {
      env: {},
      source: null,
      warning: '拿不到 DSH_HOME，无法从凭据文件读取 API key。',
    }
  }

  const file = join(dshHome, CREDENTIALS_FILENAME)
  if (!existsSync(file)) {
    return {
      env: {},
      source: null,
      warning:
        `找不到凭据文件 ${file}，也没有配置 dsh.apiKey、没有 DEEPSEEK_API_KEY 环境变量 —— ` +
        '模型调用会因 MISSING_CREDENTIAL 失败，表现为"机器人完全不输出内容"。',
    }
  }

  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { env: {}, source: null, warning: `凭据文件读不了：${error.message}` }
  }

  const key = readYamlPath(text, ['refs', 'DEEPSEEK_API_KEY'])
  if (!key) {
    return {
      env: {},
      source: null,
      warning:
        `凭据文件里没有 refs.DEEPSEEK_API_KEY（${file}）—— ` +
        '模型调用会因 MISSING_CREDENTIAL 失败。去 DSH 的「模型」页面填一次 key 即可。',
    }
  }

  return { env: { DEEPSEEK_API_KEY: key }, source: `凭据文件 ${file}`, warning: null }
}
