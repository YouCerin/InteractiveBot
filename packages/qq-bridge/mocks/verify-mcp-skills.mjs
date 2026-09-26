#!/usr/bin/env node
/**
 * 技能工具 MCP 服务器（`mcp/mcp-skills-server.mjs`，0.2.2）的测试。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要有这一套（它补的是哪一类风险）
 * ══════════════════════════════════════════════════════════════════════════
 * `verify-extensions.mjs` 测的是**扩展内核**（清单/设置/命名/片段/开关语义），
 * 而"技能工具到底能不能被调起来"这一步发生在**另一个进程**里，它从来没被自动测过。
 * 而这一层最容易坏的恰恰是**协议与派发**：名字对不上、schema 没补上会话参数、
 * 关掉的技能没被挡住、技能抛错把异常冒到 MCP 层（模型看到的是协议错误而不是"没做成"）。
 *
 * ── 两段式，各自解决一个问题 ─────────────────────────────────────────────
 *   ① **在进程内**驱动派发逻辑（`__init` / `allTools` / `runSkillTool`）
 *      —— 这一段**永远会跑**，包括"改了 config.json 不用重启就生效"这条核心保证。
 *   ② **真的把子进程拉起来**走 stdio 的 JSON-RPC
 *      —— 这一段锁"帧格式/握手/未知方法"，但受限沙箱里带管道的 spawn 会 EPERM，
 *        那时**明确跳过并声明"这不算通过"**（见 mocks/harness.mjs 的纪律）。
 *
 * 用法：node mocks/verify-mcp-skills.mjs
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { canSpawn, sectionIf, printSkipSummary } from './harness.mjs'
import { skillToolLocalName, skillToolFullName, SKILL_API_VERSION, SKILLS_SERVER_NAME } from '../src/extensions.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const SERVER = join(PKG_ROOT, 'mcp', 'mcp-skills-server.mjs')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
const section = (t) => console.log(`\n── ${t} ──`)

const ROOT = mkdtempSync(join(tmpdir(), 'qq-bridge-mcp-skills-'))
const SKILLS = join(ROOT, 'skills')
const SKILL_ID = 'demo-skill'
mkdirSync(join(SKILLS, SKILL_ID), { recursive: true })

/** 一份能跑的技能：一个只读工具 + 一个写入类工具 + 可切换的 available()。 */
writeFileSync(
  join(SKILLS, SKILL_ID, 'skill.json'),
  `${JSON.stringify(
    {
      id: SKILL_ID,
      name: '演示技能',
      version: '1.0.0',
      apiVersion: SKILL_API_VERSION,
      description: '给 MCP 层测试用',
      entry: 'index.js',
      enabledByDefault: false,
      session: 'required',
      settings: { enabled: false },
      configSchema: { enabled: { type: 'boolean', label: '启用' } },
      tools: [
        { id: 'ping', name: 'Ping', description: '回一个 pong' },
        { id: 'boom', name: 'Boom', description: '抛错用', permission: 'write' },
      ],
    },
    null,
    2,
  )}\n`,
  'utf8',
)
writeFileSync(
  join(SKILLS, SKILL_ID, 'index.js'),
  `export function setup(api) {
  api.registerTool({
    id: 'ping',
    name: 'Ping',
    description: '回一个 pong',
    parameters: { type: 'object', properties: { text: { type: 'string' } } },
    async execute(ctx, args) {
      // 把宿主给的上下文回显出来，测试据此断言"会话参数没被塞进业务参数"
      // ★ 顺带回显 ctx.toolName('ping')：它必须与 setup 里 api.toolName() **同一个口径**
      //   （模型实际看到的全名），否则技能把它写进给模型看的话，模型会去调一个不存在的工具。
      return { content: 'pong:' + JSON.stringify({ kind: ctx.kind, chatId: ctx.chatId, args, toolName: ctx.toolName && ctx.toolName('ping') }) }
    },
  })
  api.registerTool({
    id: 'boom',
    name: 'Boom',
    description: '总是抛错（测异常翻译）',
    permission: 'write',
    parameters: { type: 'object', properties: {} },
    async execute() { throw new Error('故意炸的') },
  })
}
export function available(context) {
  const c = (context && context.config && context.config.skills && context.config.skills['${SKILL_ID}']) || {}
  if (c.unavailable === true) return { ok: false, reason: '这个技能说自己现在不可用（测试用）' }
  return { ok: true }
}
`,
  'utf8',
)

/** 服务器读的那份配置（`readLiveConfig` 每次调用都现读它 —— 这正是"随时开关"的实现）。 */
const CONFIG = join(ROOT, 'config.json')
const writeConfig = (skills) => writeFileSync(CONFIG, `${JSON.stringify({ skills }, null, 2)}\n`, 'utf8')
writeConfig({})

const mod = await import(`file://${SERVER.replace(/\\/g, '/')}`)
await mod.__init({ skillsDir: SKILLS, configPath: CONFIG })

// ══════════════════════════════════════════════════════════════════════════
section('① 工具枚举与命名（服务器自报的名字 = 裸名，前缀由 DSH 的 MCP 客户端加）')
// ══════════════════════════════════════════════════════════════════════════
{
  const tools = mod.allTools()
  check('两个工具都被枚举出来', tools.length === 2, tools.map((t) => t.name).join(','))
  check('★ 自报的名字是 `技能id__工具id`（不含 mcp__<server>__ 前缀 —— 那半截由 DSH 加）',
    tools[0].name === skillToolLocalName(SKILL_ID, 'ping'), tools[0].name)
  check('工具与技能对得上', tools.every((t) => t.skill.id === SKILL_ID))
}

// ══════════════════════════════════════════════════════════════════════════
section('② 入参 schema：`session: required` 会把当前会话参数**加进去**')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = mod.allTools().find((x) => x.name.endsWith('__ping'))
  const schema = mod.schemaOf(t.tool, t.skill)
  check('原参数保留', Boolean(schema.properties.text))
  check('★ 加上了 kind / peerId（MCP 的 tools/call 上没有会话标识，只能让模型填）',
    Boolean(schema.properties.kind) && Boolean(schema.properties.peerId))
  check('★ 而且是**必填**（不填就该被拒，而不是猜一个会话）',
    schema.required.includes('kind') && schema.required.includes('peerId'))
  check('kind 限定 private/group', String(schema.properties.kind.enum?.join(',')) === 'private,group')
  // 不去改技能自己的对象（否则第二次合并会叠起来）
  check('schemaOf 不修改技能声明的原对象', !('peerId' in (t.tool.parameters.properties ?? {})))
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 工具描述：权限 + 如实 + 来源（与 QQ 工具同一套纪律）')
// ══════════════════════════════════════════════════════════════════════════
{
  const ts = mod.allTools()
  const ping = ts.find((x) => x.name.endsWith('__ping'))
  const boom = ts.find((x) => x.name.endsWith('__boom'))
  check('只读工具带"只读"提示', mod.described(ping.tool).includes('只读动作'))
  check('★ 写入类工具带"只有管理员"提示', mod.described(boom.tool).includes('只有管理员'))
  check('都带"如实"提示（失败不许说成功）', mod.described(ping.tool).includes('没做成'))
  check('都标明来源是扩展技能（说清"设置在哪"）', mod.described(ping.tool).includes('第三方技能'))
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 派发：关掉的技能**当场拒绝**，且给模型一句能转述的话')
// ══════════════════════════════════════════════════════════════════════════
{
  writeConfig({ [SKILL_ID]: { enabled: false } })
  const r = await mod.runSkillTool(skillToolLocalName(SKILL_ID, 'ping'), { kind: 'group', peerId: '1' })
  check('★ 关着时拒绝执行', r.isError === true)
  check('★ 说明是"被管理员关掉了"（而不是"查不到"这种含糊话）', /关闭/.test(r.text) && /控制台/.test(r.text))
  check('★ 明确要求模型别重试（否则它会换个说法反复试）', /不要重试/.test(r.text))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ ★★ 改了 config.json **不用重启**就生效（"随时开关"的核心保证）')
// ══════════════════════════════════════════════════════════════════════════
{
  writeConfig({ [SKILL_ID]: { enabled: true } })
  const ok = await mod.runSkillTool(skillToolLocalName(SKILL_ID, 'ping'), { kind: 'private', peerId: '42', text: 'hi' })
  check('★ 盘上一改成 true，**同一个进程**下一次调用就放行（这是"随时开关"的全部秘密）',
    ok.isError === false, ok.text)
  check('执行结果原样带回模型', ok.text.includes('pong:'))
  check('★ 会话信息给到了技能（ctx.kind / ctx.chatId）', ok.text.includes('"kind":"private"') && ok.text.includes('"chatId":"42"'))
  check('★ 会话参数**不进业务参数**（技能只拿到自己声明的 text）',
    ok.text.includes('"args":{"text":"hi"}'), ok.text)
  // ★ ctx.toolName 必须与 setup 里 api.toolName() 同口径：模型真正能调的那个全名。
  //   第一版给的是服务器内部的注册键（`<server>::<裸名>`）—— 模型调不到它，而技能会照着写给模型，
  //   于是表现为"按提示调工具却总是查不到"（静默失败）。
  check('★★ ctx.toolName(id) = **模型实际看到的工具全名**（mcp__skills__<id>__<tool>）',
    ok.text.includes(`"toolName":"${skillToolFullName(SKILL_ID, 'ping')}"`), ok.text)
  check('★ 而且不是服务器内部的注册键（那个名字模型调不到）',
    !ok.text.includes(`"toolName":"${SKILLS_SERVER_NAME}::`), ok.text)

  writeConfig({ [SKILL_ID]: { enabled: false } })
  const off = await mod.runSkillTool(skillToolLocalName(SKILL_ID, 'ping'), { kind: 'private', peerId: '42' })
  check('★ 再改成 false，下一次调用立刻被拒（无需重启、无需重载模块）', off.isError === true)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ 会话参数缺失 / 未知工具 / 技能抛错（三条都要翻译成人话）')
// ══════════════════════════════════════════════════════════════════════════
{
  writeConfig({ [SKILL_ID]: { enabled: true } })
  const noSession = await mod.runSkillTool(skillToolLocalName(SKILL_ID, 'ping'), { text: 'x' })
  check('★ required 技能缺 kind/peerId → fail-closed（不去猜会话）', noSession.isError === true && /必须知道\*\*当前会话|kind/.test(noSession.text), noSession.text)
  const unknown = await mod.runSkillTool('nope__nope', { kind: 'private', peerId: '1' })
  check('未知工具 → 直接说没有（不把技能列表倒给模型）', unknown.isError === true && /没有这个工具/.test(unknown.text))
  const boom = await mod.runSkillTool(skillToolLocalName(SKILL_ID, 'boom'), { kind: 'private', peerId: '1' })
  check('★ 技能抛错 → 变成一句中文（不是把异常冒到 MCP 层，那会看起来像协议错误）',
    boom.isError === true && /执行出错/.test(boom.text) && /故意炸的/.test(boom.text), boom.text)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑦ 技能自报不可用 / 配置文件坏掉（都要如实、且不崩）')
// ══════════════════════════════════════════════════════════════════════════
{
  writeConfig({ [SKILL_ID]: { enabled: true, unavailable: true } })
  const av = await mod.runSkillTool(skillToolLocalName(SKILL_ID, 'ping'), { kind: 'private', peerId: '1' })
  check('★ available() 说不可用 → 原样转述它的原因（技能不"凭空消失"）',
    av.isError === true && /测试用/.test(av.text), av.text)

  // 配置被手改坏（带 BOM/非法 JSON）：按"未配置"处理 → 技能视为关闭 → fail-closed
  writeFileSync(CONFIG, '\uFEFF{ 这不是 JSON', 'utf8')
  const broken = await mod.runSkillTool(skillToolLocalName(SKILL_ID, 'ping'), { kind: 'private', peerId: '1' })
  check('★ 配置文件坏掉时按 fail-closed 处理（不崩、也不放行）', broken.isError === true)
  writeConfig({ [SKILL_ID]: { enabled: true } })

  // 带 BOM 但内容合法：必须能读（记事本改过的文件就会带 BOM）
  writeFileSync(CONFIG, `\uFEFF${JSON.stringify({ skills: { [SKILL_ID]: { enabled: true } } })}`, 'utf8')
  const bom = await mod.runSkillTool(skillToolLocalName(SKILL_ID, 'ping'), { kind: 'private', peerId: '1' })
  check('★ 带 BOM 的合法配置能读（否则"开关按了没反应"）', bom.isError === false, bom.text)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑧ 真的把子进程拉起来走 stdio（受限沙箱里会明确跳过，跳过不算通过）')
// ══════════════════════════════════════════════════════════════════════════
await sectionIf(await canSpawn(), '⑧-b stdio 帧格式 / 握手 / 未知方法', async () => {
  const cfg = join(ROOT, 'mcp-skills.config.json')
  writeConfig({ [SKILL_ID]: { enabled: true } })
  writeFileSync(cfg, `${JSON.stringify({ skillsDir: SKILLS, configPath: CONFIG }, null, 2)}\n`, 'utf8')

  const child = spawn(process.execPath, [SERVER, '--config', cfg], { stdio: ['pipe', 'pipe', 'pipe'] })
  const stderr = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => stderr.push(...String(d).split(/\r?\n/).filter(Boolean)))
  const pending = new Map()
  let nextId = 0
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (l) => {
    const t = l.trim()
    if (!t) return
    let msg
    try {
      msg = JSON.parse(t)
    } catch {
      return
    }
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      p(msg)
    }
  })
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`超时：${method}`))
        }
      }, 8000)
    })

  try {
    const init = await call('initialize', {})
    check('握手返回 protocolVersion 与 serverInfo', Boolean(init.result?.protocolVersion) && Boolean(init.result?.serverInfo?.name))
    const pkgVersion = JSON.parse(
      (await import('node:fs')).readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'),
    ).version
    check('★ serverInfo.version 与 package.json 一致（发布包里不能自相矛盾）',
      init.result?.serverInfo?.version === pkgVersion, `${init.result?.serverInfo?.version} vs ${pkgVersion}`)

    const list = await call('tools/list', {})
    const names = (list.result?.tools ?? []).map((t) => t.name)
    check('tools/list 里是自报的裸名', names.includes(skillToolLocalName(SKILL_ID, 'ping')), names.join(','))
    const pingTool = (list.result?.tools ?? []).find((t) => t.name.endsWith('__ping'))
    check('★ tools/list 的 schema 里带上了 kind/peerId（模型才知道要填）',
      Boolean(pingTool?.inputSchema?.properties?.kind) && Boolean(pingTool?.inputSchema?.properties?.peerId))
    check('描述里带权限与"如实"提示', /只读动作/.test(pingTool?.description ?? '') && /没做成/.test(pingTool?.description ?? ''))

    const res = await call('tools/call', {
      name: skillToolLocalName(SKILL_ID, 'ping'),
      arguments: { kind: 'group', peerId: '999', text: 'hi' },
    })
    check('★ tools/call 真的执行了技能并把结果包成 MCP 的 content',
      res.result?.isError !== true && /pong:/.test(res.result?.content?.[0]?.text ?? ''), JSON.stringify(res.result)?.slice(0, 120))

    const bad = await call('tools/call', { name: 'nope__nope', arguments: {} })
    check('未知工具经协议回来是 isError（不是 JSON-RPC 错误）', bad.result?.isError === true)
    check('未知方法回 -32601', (await call('nope', {})).error?.code === -32601)
    check('stderr 里有启动日志（stdout 只跑协议帧）', stderr.some((l) => l.includes('[skills]')), stderr[0] ?? '')
  } catch (error) {
    check('（stdio 段能跑完）', false, String(error?.message ?? error))
  } finally {
    try {
      child.kill()
    } catch {
      /* 已经退出 */
    }
  }
})

rmSync(ROOT, { recursive: true, force: true })
console.log('')
// ⚠️ 用 harness 的统一收尾：有跳过时**打印"这不算完整通过"**，而不是伪装成全绿
//    （本文件 ⑧ 段在受限沙箱里必跳：带管道的 spawn 会 EPERM，而那与被测代码无关）
printSkipSummary(failures, '✅ 技能工具 MCP 服务器全部通过')
