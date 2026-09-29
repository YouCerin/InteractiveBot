#!/usr/bin/env node
/**
 * 技能工具 MCP 服务器（stdio，零依赖）—— 0.2.2 新增。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它是什么
 * ══════════════════════════════════════════════════════════════════════════
 * 把 `skills/<id>/` 里的第三方技能**注册成模型能调的工具**。
 * 技能自己在 `setup(api)` 里 `api.registerTool({...})`，本文件负责：
 *   · 把注册到的工具变成 MCP 的 `tools/list`；
 *   · 把模型的 `tools/call` 派发回技能自己的 `execute(ctx, args)`；
 *   · 把技能的 `{content, isError}` 形状翻译成 MCP 的 `{content:[{type:'text'}], isError}`；
 *   · **每次调用现读开关**（这是"随时开关"能成立的关键，见下）。
 *
 * ── 为什么和 QQ 工具分成两个服务器 ────────────────────────────────────────
 *   ① 隔离：技能是第三方代码，它崩了不该把 QQ 动作一起带走；
 *   ② 权限：技能工具不需要 QQ token —— 那份配置里就没有 token；
 *   ③ 零成本：没装技能时桥接**根本不会写**这一段 profile（见 mcp-profile.mjs）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * "随时开关"到底是怎么做到的（这一版的核心问题，必须说清）
 * ══════════════════════════════════════════════════════════════════════════
 * 现实约束：**模型看到的工具表是 DSH 启动时加载的**，桥接进程改不了它。
 * 所以"关掉一个技能"不可能让它立刻从工具表里消失。本文件的做法是：
 *
 *   · **工具表按"已安装"注册**（装了就一直在表里）→ 开关**不需要重启**；
 *   · 每次 `tools/call` **现读 config.json** 的 `skills.<id>.enabled`，
 *     关掉就直接拒绝执行，并给模型一句可转述的中文说明；
 *   · 提示词侧的片段由桥接按同一个开关**每轮重新决定**（关掉就不注入）。
 *
 * 三者合起来的效果才是"随时开关"：关掉之后模型**不再被提示去用它**，
 * 万一真调了也会被**当场拒绝**。代价是工具表里仍留着一个名字 ——
 * 这条边界如实写在 `docs/插件设计规范.md` 与界面上（"关掉即时生效；装卸技能要重启"）。
 *
 * 反过来说：**装/卸技能要重启桥接**（要重写 profile 里的这一段）。
 *
 * 用法：由 DSH 的 MCP 客户端拉起（stdio）。
 *   node mcp-skills-server.mjs --config <mcp-skills.config.json>
 */

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import {
  discoverSkills,
  loadSkill,
  isSkillEnabled,
  mergeSkillSettings,
  skillToolFullName,
  skillToolLocalName,
} from '../src/extensions.mjs'

const PROTOCOL_VERSION = '2024-11-05'
// ⚠️ 版本号必须与 package.json 一致。★ 0.2.7 更正一句不准确的话：本文件原来写"verify-manifest
//   会核对" —— 实际上那条断言只读 `mcp-qq-server.mjs` 的 SERVER_INFO（见 verify-manifest 的
//   「版本号只有一个来源」那一节）。所以这里是**靠自觉**保持一致，不是被断言钉住的。
const SERVER_INFO = { name: 'qq-bridge-skill-tools', version: '0.2.7' }

/** 服务端配置：`{ skillsDir, configPath, workspace? }`。 */
let config = null

/** 已加载的技能（启动时一次性加载；装/卸技能要重启桥接）。 */
let skills = []

function log(msg) {
  // ⚠️ stdout 是 MCP 协议通道，**绝不能**往里写日志（会把 JSON 帧冲掉）。
  process.stderr.write(`[skills] ${msg}\n`)
}

/**
 * 现读 config.json。
 *
 * ★ 每次工具调用都读一遍，而且**不做缓存** —— 这是"界面上打开/关闭立刻生效"
 *   能成立的原因。文件只有十几 KB，读一次的代价远小于"用户以为关掉了其实还在跑"。
 *   读失败（文件被占、被手改坏）时返回 null，调用方按 **fail-closed** 处理。
 */
function readLiveConfig() {
  if (!config?.configPath) return null
  try {
    // 去掉可能的 BOM：这份文件是桥接生成的（无 BOM），但用户手工用记事本改过就会带上 ——
    // 而 `JSON.parse` 遇到 BOM 会直接抛，表现成"开关按了没反应"。
    return JSON.parse(readFileSync(config.configPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    log(`读 config.json 失败（本次调用按未配置处理）：${error?.message ?? error}`)
    return null
  }
}

/**
 * 给模型的工具说明：把"权限"和"开关"两件事写进描述。
 *
 * 与 QQ 工具同一套理由（见 mcp-qq-server.mjs 的 ADMIN_ONLY_HINT）：
 * 模型的工具表是它决定"调不调"的直接依据，而这些话离提示词很远。
 */
const ADMIN_ONLY_HINT =
  '【权限】这是**写入/互动类**动作，只有管理员可以让我做。' +
  '如果当前说话的人不是管理员，就直说"这个我做不了"，不要偷偷做、也不要假装做过。'
const READONLY_HINT = '【权限】只读动作，普通用户也可以用（但**不能**用它读取与他无关的会话内容）。'
const HONESTY_HINT =
  '【如实】这个工具返回失败就是**没做成** —— 照实说失败原因，不要回"好的已经做了"。'
const SKILL_HINT = '【来源】这是第三方技能的扩展工具（不是机器人本体功能）。它说的"设置"在控制台的「扩展」页里。'

function described(tool) {
  const perm = tool.permission === 'write' ? ADMIN_ONLY_HINT : READONLY_HINT
  return `${tool.description}\n${perm}${HONESTY_HINT}${SKILL_HINT}`
}

/**
 * 技能的会话参数（`session: required` 的技能才用）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * MCP 的 `tools/call` 上**没有会话标识**（我们实测过：线上只有 name + arguments），
 * 而技能（例如 pixiv）要判"群里能不能用"。所以对声明了 `session: 'required'`
 * 的技能，宿主**替它把 kind/peerId 加进工具入参**，并要求模型填 ——
 * 号码就是它这轮"来源标注"里那串数字（模型本来就看得到）。
 *
 * 另一条路（`session: 'hint'`）是宿主尽力猜当前会话，但同一个 MCP 进程是
 * **多会话共用**的（桥接的锁只按会话分），猜错会指向别人的会话 —— 所以只在
 * "猜错也无所谓"的技能上允许。判据写在插件设计规范里。
 */
const SESSION_PROPS = {
  kind: { type: 'string', enum: ['private', 'group'], description: '当前会话类型（必填）：私聊 private / 群聊 group' },
  peerId: { type: 'string', description: '当前会话号码（必填）：就是你这轮来源标注里那串 QQ 号/群号' },
}

/** 把一个技能的入参 schema 按会话要求补全（不改技能自己的对象 —— 复制一份）。 */
function schemaOf(tool, skill) {
  const base = tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} }
  if (skill.sessionMode !== 'required') return base
  const properties = { ...(base.properties ?? {}), ...SESSION_PROPS }
  const required = [...new Set([...(Array.isArray(base.required) ? base.required : []), 'kind', 'peerId'])]
  return { ...base, type: 'object', properties, required }
}

/** 全部已安装技能的工具（**不管开关**——这样开关才能即时生效，见文件头）。 */
function allTools() {
  const out = []
  for (const skill of skills) {
    if (!skill.ok || !skill.loaded) continue
    for (const t of skill.runtimeTools) {
      out.push({ skill, tool: t, name: skillToolLocalName(skill.id, t.id) })
    }
  }
  return out
}

/**
 * 执行一个技能工具。
 *
 * 三道关（顺序不能换）：
 *   ① 找不到工具 → 直接说没有（不要把技能列表倒给模型）；
 *   ② **现读开关**，关着就拒绝 —— 这是"随时开关"的执行侧；
 *   ③ 技能自己的 execute 抛错 → 变成一句中文，绝不让异常冒出去（那会变成 MCP 层错误，
 *      模型看到的是协议错误而不是"这件事没做成"）。
 */
async function runSkillTool(toolName, args) {
  const hit = allTools().find((x) => x.name === toolName)
  if (!hit) return { isError: true, text: `没有这个工具：${toolName}` }

  const live = readLiveConfig()
  const skill = hit.skill
  const enabled = live === null ? isSkillEnabled(skill, config) : isSkillEnabled(skill, live)
  if (!enabled) {
    return {
      isError: true,
      text:
        `「${skill.name}」现在是**关闭**状态（管理员在控制台的「扩展」页里关掉了它）。\n` +
        '不要重试、也不要换别的说法再试：直接用一句自然的中文告诉对方这个功能暂时用不了。',
    }
  }
  if (typeof hit.tool.execute !== 'function') {
    return { isError: true, text: `「${skill.name}」的这个工具没有实现（技能装得不完整）。` }
  }

  // ── 技能自己的依赖自检（可选导出 `available`）──────────────────────────
  // 上游契约是"不可用就摘掉工具"，本宿主改成"调用时如实拒绝并转述原因" ——
  // 技能凭空消失对使用者是最难排查的一种表现。所以这里现调一次（带着最新配置）。
  if (typeof skill.module?.available === 'function') {
    try {
      const av = skill.module.available({ config: live ?? config })
      if (av && av.ok === false) {
        return { isError: true, text: av.reason || `「${skill.name}」现在不可用（技能自己的依赖没满足）。` }
      }
    } catch (error) {
      return { isError: true, text: `「${skill.name}」的依赖自检抛错：${error?.message ?? error}` }
    }
  }

  // ── 会话上下文 ──────────────────────────────────────────────────────────
  // required：模型必须填（上面的 schema 已经强制）；hint：能拿到什么就给什么。
  const a = args && typeof args === 'object' ? args : {}
  const kind = String(a.kind ?? '').trim()
  const peerId = String(a.peerId ?? '').trim()
  if (skill.sessionMode === 'required' && (!kind || !peerId)) {
    return {
      isError: true,
      text:
        '这个技能必须知道**当前会话**才能执行：请带上 kind（private/group）与 peerId' +
        '（就是你这轮来源标注里那串号码）。不带我无法判断群聊/私聊，只能拒绝。',
    }
  }
  // 会话参数不进技能的业务参数（它们不是业务，是上下文）
  const business = { ...a }
  delete business.kind
  delete business.peerId

  const ctx = {
    kind: kind || 'unknown',
    chatId: peerId,
    peerKey: kind && peerId ? `${kind}:${peerId}` : '',
    config: live ?? config,
    settings: mergeSkillSettings(skill.manifest, (live ?? config)?.skills?.[skill.id]).settings,
    // 让技能自己也能算「**模型实际看到的工具全名**」（例如在报错里写清该调哪个）。
    // ⚠️ 必须与 `setup(api)` 里的 `api.toolName()` 是**同一个口径**（`mcp__skills__<id>__<tool>`）：
    //    第一版这里给的是本服务器内部的注册键（`<服务器名>::<裸名>`），
    //    而那个名字**模型根本调不到** —— 技能若把它写进给模型看的话，模型会去调一个不存在的工具，
    //    而且失败得很安静（它只会说"查不到"）。所以命名规则只有一处实现（src/extensions.mjs）。
    toolName: (id) => skillToolFullName(skill.id, id),
  }

  try {
    const r = await hit.tool.execute(ctx, business)
    const text = String(r?.content ?? r?.text ?? '')
    return { isError: r?.isError === true, text: text || '（技能没有返回任何内容）' }
  } catch (error) {
    return { isError: true, text: `「${skill.name}」执行出错：${error?.message ?? error}` }
  }
}

/* ── JSON-RPC ───────────────────────────────────────────────────────────── */

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}
function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

async function handle(frame) {
  const { id, method, params } = frame ?? {}
  if (id === undefined) return // 通知，不需要应答

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })

    case 'tools/list':
      return reply(id, {
        tools: allTools().map((x) => ({
          name: x.name,
          description: described(x.tool),
          inputSchema: schemaOf(x.tool, x.skill),
        })),
      })

    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      log(`tools/call ${name} ${JSON.stringify(args).slice(0, 200)}`)
      const out = await runSkillTool(name, args)
      return reply(id, { content: [{ type: 'text', text: out.text }], isError: out.isError === true })
    }

    case 'ping':
      return reply(id, {})

    default:
      return replyError(id, -32601, `未实现的方法：${method}`)
  }
}

/* ── 启动 ───────────────────────────────────────────────────────────────── */

function loadConfig() {
  const i = process.argv.indexOf('--config')
  const path = i >= 0 ? process.argv[i + 1] : null
  if (!path) throw new Error('需要 --config <文件> 参数（由桥接生成）')
  const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  if (!parsed.skillsDir) throw new Error('配置文件缺少 skillsDir')
  return parsed
}

/**
 * 装载所有技能（启动时一次）。
 *
 * 坏技能**不影响**好技能：每个技能各自 try，失败就记一行 stderr 并跳过。
 * 这一点很重要 —— 版本不匹配的第三方技能不该让**所有**技能一起消失。
 */
async function loadAllSkills() {
  const found = discoverSkills({ skillsDir: config.skillsDir })
  const live = readLiveConfig()
  skills = found.skills
  for (const s of skills) {
    if (!s.ok) {
      log(`跳过 ${s.id}：清单有问题 —— ${s.errors.join('；')}`)
      continue
    }
    await loadSkill(s, { config: live ?? {}, log })
    if (s.loaded) log(`已装载 ${s.id}：${s.runtimeTools.length} 个工具`)
    else log(`装载失败 ${s.id}：${s.loadError}`)
  }
}

/** 给测试用：直接塞一份配置 + 装载技能（不读文件、不启动主循环）。 */
export async function __init(cfg) {
  config = cfg
  await loadAllSkills()
}

/** 启动主循环（DSH 以脚本方式拉起时走这里）。 */
async function startServer() {
  try {
    config = loadConfig()
  } catch (error) {
    log(`配置加载失败：${error.message}`)
    process.exit(1)
  }

  await loadAllSkills()
  const count = allTools().length
  log(`已启动，技能目录 ${config.skillsDir}，技能 ${skills.length} 个、工具 ${count} 个`)

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    let frame
    try {
      frame = JSON.parse(text)
    } catch {
      log(`收到非 JSON 输入，已忽略：${text.slice(0, 120)}`)
      return
    }
    handle(frame).catch((error) => {
      log(`处理出错：${error?.message ?? error}`)
      if (frame?.id !== undefined) replyError(frame.id, -32603, String(error?.message ?? error))
    })
  })
  rl.on('close', () => {
    log('stdin 关闭，退出')
    process.exit(0)
  })
}

// ★★ 同 mcp-qq-server.mjs：只有被当作脚本直接拉起时才启动主循环，
//    这样"工具枚举 / 开关判定 / 派发"这些纯逻辑可以在不起子进程的情况下被测到。
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) startServer()

export { SERVER_INFO, allTools, runSkillTool, schemaOf, described, readLiveConfig }
