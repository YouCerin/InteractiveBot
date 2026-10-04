#!/usr/bin/env node
/**
 * 把**bot 的那些 DSH 会话**挂到一个 DSH Desktop 工作区之下（默认干跑，不写盘）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个工具（使用者 2026-10-04 问：「bot 调用的对话全部是未分类」）
 * ══════════════════════════════════════════════════════════════════════════
 * DSH Desktop 的会话侧栏是**按工作区分组**的：一个会话属于某个工作区，当且仅当
 * 它的 id 出现在那个工作区记录的 `sessionIds` 里；**不在任何工作区里的会话**落进
 * 一个叫「未分组 / Ungrouped」的桶。
 *   · 分组代码：`@deepseek-ai/dsh-client-ui-workspace/lib/client.js` 的 `groupByWorkspace()`
 *     —— 只认 `workspace.sessionIds`，**不做按路径的自动收编**；
 *   · 而桥接走的是 **SDK 那条路**：`dsh --profile sdk` 的 `agents.create()` 只传
 *     `meta: { cwd }`，**没有任何工作区参数**
 *     （`@deepseek-ai/dsh-sdk-jsonrpc-server/lib/index.js` 的 `createSession()`）。
 *   ∴ bot 的会话**必然**落进未分组 —— 这不是我们的 bug，也**不是配置能改的**
 *     （SDK 的 initialize 只收 cwd / provider / model / reasoningEffort / maxTokens）。
 *   能改的只有 DSH 那份注册表：`<DSH_HOME>/storages/workspace.json`。
 *
 * 本工具就是去改那一份。它**只做两件事**：确保存在一个以 bot 工作区为路径的工作区，
 * 然后把**header 里 cwd 与它一致**的会话挂进去 —— 判据与 DSH 自己 `attachSession()` 的
 * 校验逐条对齐（header 必须有 cwd、cwd 必须解析得到、必须是目录、必须**等于**工作区路径）。
 *
 * ⚠️ 三条必须说清的边界：
 *   ① **不是一劳永逸**：DSH 的 SDK 路线不带工作区，所以**新会话仍会落进未分组**，
 *      攒多了再跑一次这个工具即可。想彻底解决得 DSH 那边支持。
 *   ② **必须在 DSH Desktop 关着的时候写**（`--apply` 会先检查）：那份注册表在
 *      DSH 进程内存里也有一份，开着改会被它覆盖。默认就是干跑，写之前还会备份。
 *   ③ 它**不进发布包**（`tools/` 不在组装清单里），也不进生产路径 —— 它动的是**别的应用的数据**。
 *      （但它**有测试**：`mocks/verify-link-dsh-workspace.mjs`，拿假 DSH_HOME 把真写那条路跑一遍。）
 *
 * 用法：
 *   node tools/link-dsh-workspace.mjs                  # 干跑：打印计划，不写任何东西
 *   node tools/link-dsh-workspace.mjs --apply           # 真写（先备份；要求 DSH 没在跑）
 *   node tools/link-dsh-workspace.mjs --apply --force   # 明知 DSH 在跑也写（不建议）
 *   node tools/link-dsh-workspace.mjs --title "QQ 桥接"  # 工作区显示名（默认见 DEFAULT_TITLE）
 *   node tools/link-dsh-workspace.mjs --json            # 机器可读（干跑即预览）
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PKG_ROOT, resolveDshHome, resolveInPackage } from '../src/local.mjs'
import { readSessionFile, sessionDirNameFor } from '../mocks/session-grep.mjs'

export const DEFAULT_TITLE = 'QQ 桥接（小鲸鱼）'
const SESSION_FILE = 'session.v3.jsonl.zstd'

/** 路径比较：Windows 上大小写不敏感 + 走 realpath（与 DSH 的 `realpathNormalize` 同口径）。 */
function canonical(p) {
  try {
    return realpathSync.native ? realpathSync.native(p) : realpathSync(p)
  } catch {
    return null
  }
}
const samePath = (a, b) => {
  if (!a || !b) return false
  const x = canonical(a)
  const y = canonical(b)
  if (!x || !y) return false
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/** 读一份会话文件的 header（第一行就是 `{"type":"session",…,"cwd":…}`）。 */
function sessionHeader(file) {
  try {
    const { text } = readSessionFile(file)
    const first = text.split('\n').find((l) => l.trim())
    if (!first) return null
    const row = JSON.parse(first)
    return row && row.type === 'session' ? row : null
  } catch {
    return null
  }
}

/** DSH Desktop 在不在跑（**检查不出来回 null** —— 调用方据此决定敢不敢写）。 */
export function dshDesktopRunning() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq DSH Desktop.exe', '/NH'], { encoding: 'utf8' })
    return /DSH Desktop\.exe/i.test(out)
  } catch {
    return null // 问不出来（例如受限环境里 spawn 被拒）
  }
}

/**
 * 盘点：bot 工作区下有哪些会话**符合 DSH 自己的挂载判据**。
 *
 * ★ 判据与 `dsh-workspace` 的 `attachSession()` 逐条对齐，理由：注册表最终是**它**在读。
 *   口径不一致的后果是"我们挂上了、DSH 一启动就把它过滤掉"（还会在它的日志里留一句），
 *   所以宁可这里先按它的规则筛。
 */
export function collectBotSessions({ dshHome, workspace }) {
  const canonWorkspace = canonical(workspace)
  const sessionDir = join(dshHome, 'sessions', sessionDirNameFor(canonWorkspace))
  const eligible = []
  const skipped = []
  let entries = []
  try {
    entries = readdirSync(sessionDir, { withFileTypes: true })
  } catch {
    return { ok: false, why: `这个工作区的会话目录不存在：${sessionDir}`, sessionDir, eligible, skipped }
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const id = e.name
    const file = join(sessionDir, id, SESSION_FILE)
    if (!existsSync(file)) {
      skipped.push({ id, why: '没有会话文件' })
      continue
    }
    const h = sessionHeader(file)
    if (!h) {
      skipped.push({ id, why: 'header 读不出来或不是 session 记录' })
      continue
    }
    if (h.id && h.id !== id) {
      skipped.push({ id, why: `header 里的 id 是 ${h.id}` })
      continue
    }
    if (!h.cwd) {
      skipped.push({ id, why: 'header 没有 cwd（DSH 自己也会拒绝挂）' })
      continue
    }
    if (!samePath(h.cwd, canonWorkspace)) {
      skipped.push({ id, why: `header.cwd=${h.cwd} 与工作区不一致` })
      continue
    }
    eligible.push({ id, createdAt: Number(h.createdAt) || 0 })
  }
  eligible.sort((a, b) => a.createdAt - b.createdAt) // 旧→新（与既有列表的顺序一致）
  return { ok: true, sessionDir, workspace: canonWorkspace, eligible, skipped }
}

/** 只读地算出"要做什么"（干跑与真写共用这一份，避免两处判断分叉）。 */
export function planLinkDshWorkspace({ dshHome, workspace, title = DEFAULT_TITLE }) {
  const found = collectBotSessions({ dshHome, workspace })
  if (!found.ok) return { ok: false, why: found.why, sessionDir: found.sessionDir }
  const registry = join(dshHome, 'storages', 'workspace.json')
  if (!existsSync(registry)) return { ok: false, why: `找不到 DSH 的工作区注册表：${registry}`, registry }
  const doc = JSON.parse(readFileSync(registry, 'utf8'))
  const table = (doc.tables ??= {}).workspaces ?? (doc.tables.workspaces = {})
  const global = (doc.global ??= {})
  const order = Array.isArray(global.workspaceIds) ? global.workspaceIds : (global.workspaceIds = [])

  let workspaceId = null
  for (const [id, rec] of Object.entries(table)) {
    if (rec && samePath(rec.path, found.workspace)) {
      workspaceId = id
      break
    }
  }
  const attached = new Set(
    Array.isArray(workspaceId ? table[workspaceId]?.sessionIds : null)
      ? table[workspaceId].sessionIds.map(String)
      : [],
  )
  const toAttach = found.eligible.filter((s) => !attached.has(s.id))
  return {
    ok: true,
    dshHome,
    registry,
    workspace: found.workspace,
    sessionDir: found.sessionDir,
    sessionsFound: found.eligible.length,
    skipped: found.skipped.length,
    skippedDetail: found.skipped,
    workspaceId,
    workspaceTitle: workspaceId ? table[workspaceId].title : title,
    alreadyAttached: attached.size,
    toAttach: toAttach.length,
    attachIds: toAttach.map((s) => s.id),
    doc, // 内部用（真写时接着改它）
  }
}

/**
 * 真写：建/更新工作区 + 挂会话 + 备份。**`isDshRunning` 可注入**（测试里不必真去问进程）。
 *
 * @returns {{ok:boolean, why?:string, backup?:string, finalCount?:number, created?:boolean}}
 */
export function applyLinkDshWorkspace({
  dshHome,
  workspace,
  title = DEFAULT_TITLE,
  force = false,
  isDshRunning = dshDesktopRunning,
} = {}) {
  const plan = planLinkDshWorkspace({ dshHome, workspace, title })
  if (!plan.ok) return plan

  const running = isDshRunning()
  if (running === true && !force) {
    return { ok: false, why: 'DSH Desktop 正在运行 —— 注册表它内存里也有一份，现在写会被覆盖（要硬写加 --force）' }
  }
  if (running === null && !force) {
    return { ok: false, why: '查不出 DSH Desktop 在不在跑（tasklist 不可用）—— 不敢盲写（确认它关着之后加 --force）' }
  }

  const doc = plan.doc
  const table = doc.tables.workspaces
  const order = doc.global.workspaceIds
  const nowIso = new Date().toISOString()
  const created = plan.workspaceId == null
  if (created) {
    plan.workspaceId = randomUUID()
    table[plan.workspaceId] = {
      path: plan.workspace,
      title,
      sessionIds: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    }
    order.unshift(plan.workspaceId) // 与 DSH 自己 createWorkspace 的做法一致（新工作区排最前）
  }
  const rec = table[plan.workspaceId]
  rec.sessionIds = [...rec.sessionIds.map(String), ...plan.attachIds]
  rec.updatedAt = nowIso

  const registry = plan.registry
  const backup = `${registry}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(registry, backup)

  const text = JSON.stringify(doc, null, 2) + '\n'
  JSON.parse(text) // 自检：写之前先确认我们能解析回来
  writeFileSync(registry, text, 'utf8')

  const back = JSON.parse(readFileSync(registry, 'utf8'))
  const finalCount = back.tables?.workspaces?.[plan.workspaceId]?.sessionIds?.length ?? -1
  if (finalCount !== rec.sessionIds.length) {
    return { ok: false, why: `写盘后核对失败（期望 ${rec.sessionIds.length} 条，读到 ${finalCount}）—— 备份在 ${backup}`, backup }
  }
  return { ...plan, ok: true, created, backup, finalCount }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI（只有直接运行时才走这里 —— 测试要能 import 上面那些函数）
// ─────────────────────────────────────────────────────────────────────────────
function main(argv) {
  const flag = (n) => argv.includes(n)
  const value = (n) => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : null
  }
  const APPLY = flag('--apply')
  const FORCE = flag('--force')
  const AS_JSON = flag('--json')
  const TITLE = value('--title') || DEFAULT_TITLE
  const say = (...a) => {
    if (!AS_JSON) console.log(...a)
  }

  // ① 要挂的是哪个工作区（`config.json` 的 `dsh.workspace`，必须解析成绝对路径）
  let workspace = null
  try {
    const cfg = JSON.parse(readFileSync(join(PKG_ROOT, 'config.json'), 'utf8'))
    workspace = resolveInPackage(cfg?.dsh?.workspace ?? null)
  } catch {
    /* 下面统一报错 */
  }
  if (!workspace || !existsSync(workspace) || !statSync(workspace).isDirectory()) {
    console.error(`❌ 读不到 bot 的工作区（config.json 的 dsh.workspace）—— 拿到的是 ${workspace}`)
    process.exit(2)
  }

  // ② DSH_HOME（`resolveDshHome()` 回的是 `{home, source}`，顺手把来源打出来：
  //    "改错了一份 DSH_HOME"的后果是"改了但界面没变化"，很难查）
  const resolved = resolveDshHome()
  if (!resolved?.home) {
    console.error('❌ 找不到 DSH_HOME（设 DSH_HOME，或确认桌面版装过）')
    process.exit(2)
  }
  const dshHome = resolved.home

  const plan = planLinkDshWorkspace({ dshHome, workspace, title: TITLE })
  if (!plan.ok) {
    console.error(`❌ ${plan.why}`)
    process.exit(2)
  }

  if (!APPLY) {
    if (AS_JSON) {
      const { doc: _doc, ...rest } = plan
      console.log(JSON.stringify({ ...rest, apply: false }, null, 2))
      return
    }
    say('')
    say(`DSH_HOME        ${dshHome}（来源：${resolved.source}）`)
    say(`注册表          ${plan.registry}`)
    say(`bot 工作区      ${plan.workspace}`)
    say(`会话目录        ${plan.sessionDir}`)
    say(`工作区记录      ${plan.workspaceId ? `已存在：${plan.workspaceTitle}（${plan.workspaceId}）` : `将新建：${TITLE}`}`)
    say('')
    say(`符合条件会话    ${plan.sessionsFound} 个（header.cwd 与工作区一致）`)
    say(`已经在里面      ${plan.alreadyAttached} 个`)
    say(`本次将挂进去    ${plan.toAttach} 个`)
    if (plan.skipped) {
      say(`跳过            ${plan.skipped} 个`)
      for (const s of plan.skippedDetail.slice(0, 6)) say(`                · ${s.id}：${s.why}`)
      if (plan.skipped > 6) say(`                · …另有 ${plan.skipped - 6} 个`)
    }
    say('')
    say('（这是**干跑**，什么都没写。要真写：加 --apply，并先把 DSH Desktop 关掉。）')
    return
  }

  const r = applyLinkDshWorkspace({ dshHome, workspace, title: TITLE, force: FORCE })
  if (!r.ok) {
    console.error(`❌ ${r.why}`)
    process.exit(3)
  }
  if (AS_JSON) {
    const { doc: _doc, ...rest } = r
    console.log(JSON.stringify(rest, null, 2))
    return
  }
  say('')
  say(`✅ ${r.created ? '新建了工作区' : '更新了工作区'}「${r.workspaceTitle}」（${r.workspaceId}）`)
  say(`   现在挂着 ${r.finalCount} 个会话（本次新挂 ${r.toAttach} 个）`)
  say(`   备份：${r.backup}`)
  say('')
  say('下一步：重新打开 DSH Desktop，bot 的那些会话就会出现在这个工作区之下（不再是未分组）。')
  say('⚠️ 新会话仍会落进未分组（DSH 的 SDK 路线不带工作区）—— 攒多了再跑一次本工具即可。')
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main(process.argv.slice(2))
