#!/usr/bin/env node
/**
 * `tools/link-dsh-workspace.mjs` 的测试 —— 0.3.2 收尾。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么这个 dev-only 工具也要有测试
 * ══════════════════════════════════════════════════════════════════════════
 * 它**动的是别的应用的数据**（DSH Desktop 的工作区注册表
 * `<DSH_HOME>/storages/workspace.json`）。写坏了的后果不是"我们这边报个错"，
 * 而是**使用者的 DSH 侧栏出问题** —— 那是最不该靠"看着像对的"来交付的一类改动。
 * ∴ 这里用一个**假的 DSH_HOME**（临时目录）把**真写那条路**跑一遍：
 *   · 会话文件是**真 zstd 帧**（header 与 DSH 实际写的形状逐字一致）；
 *   · 注册表是**真 JSON**（与真机那份同构：`unit/global/tables`）；
 *   · 断言写完之后：工作区建对了、会话挂进去了、`global.workspaceIds` 里有它、
 *     **备份生成了**、**再跑一次是幂等的**（第二次 0 个待挂）。
 *
 * ★ 两条纪律：
 *   ① 全程只碰临时目录，**绝不碰真的 `<APPDATA>\dsh-desktop\harness`**
 *      （判据：所有调用都显式传 `dshHome`，工具里没有一处自己去找 APPDATA）；
 *   ② **不 spawn 子进程**（直接 import 工具导出的函数）：受限沙箱里 spawn 带管道是 EPERM，
 *      而这条测试要能在沙箱里跑 —— 顺带也逼着工具把逻辑与 CLI 外壳分开。
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

import { applyLinkDshWorkspace, collectBotSessions, planLinkDshWorkspace } from '../tools/link-dsh-workspace.mjs'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let pass = 0
let fail = 0
const failures = []
function ok(cond, label, detail = '') {
  if (cond) {
    pass += 1
    console.log(`  ✅ ${label}${detail ? `  —— ${detail}` : ''}`)
  } else {
    fail += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? `  —— ${detail}` : ''}`)
  }
}

const TMP = mkdtempSync(join(tmpdir(), 'qqb-linkdsh-'))
const HOME = join(TMP, 'harness')
mkdirSync(join(HOME, 'storages'), { recursive: true })
mkdirSync(join(HOME, 'sessions'), { recursive: true })

/** 真机 config.json 里的 bot 工作区（绝对路径）——工具的判据就是它。 */
const cfg = JSON.parse(readFileSync(join(PKG_ROOT, 'config.json'), 'utf8'))
const wsRel = String(cfg?.dsh?.workspace ?? '')
const workspace = wsRel.match(/^[A-Za-z]:[\\/]/) ? wsRel : join(PKG_ROOT, wsRel)

/** DSH 的会话目录名编码：`C:\a\b` → `--C-a-b--`（与 mocks/session-grep.mjs 同一条）。 */
const enc = (p) => `--${String(p).replace(/[/\\]+$/, '').replace(/:/g, '').replace(/[/\\]/g, '-')}--`

const registryPath = join(HOME, 'storages', 'workspace.json')
const writeRegistry = (doc) => writeFileSync(registryPath, JSON.stringify(doc, null, 2) + '\n', 'utf8')
const readRegistry = () => JSON.parse(readFileSync(registryPath, 'utf8'))

/** 造一个**真 zstd 帧**的会话文件（header 形状与真机逐字一致）。 */
function makeSession(id, cwd) {
  const dir = join(HOME, 'sessions', enc(workspace), id)
  mkdirSync(dir, { recursive: true })
  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id,
    createdAt: 1790443994831,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  })
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(header + '\n', 'utf8')))
}

console.log('\n=== ① 干跑：什么都不写，但把计划说清楚 ===')
{
  writeRegistry({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
    tables: { workspaces: {} },
  })
  makeSession('qq-aaaa11112222', workspace)
  const plan = planLinkDshWorkspace({ dshHome: HOME, workspace })
  ok(plan.ok === true, '★ 计划算出来了')
  ok(plan.sessionsFound === 1, '★★ 认出了 1 个符合条件的会话', String(plan.sessionsFound))
  ok(plan.toAttach === 1, '★ 计划里是"要挂 1 个"')
  ok(plan.workspaceId === null, '★ 还没有对应的工作区（需要新建）')
  const doc = readRegistry()
  ok(
    Object.keys(doc.tables.workspaces).length === 0 && doc.global.workspaceIds.length === 0,
    '★★★ **干跑确实什么都没写**（注册表还是空的 —— 这是这个工具的默认承诺）',
  )
}

console.log('\n=== ② 真写：建工作区 + 挂会话 + 备份 + 幂等 ===')
{
  const r = applyLinkDshWorkspace({
    dshHome: HOME,
    workspace,
    title: 'QQ 桥接（测试）',
    isDshRunning: () => false, // 注入：测试不真去问进程
  })
  ok(r.ok === true, '★ 写成功了', r.why ?? '')
  const doc = readRegistry()
  const ids = Object.keys(doc.tables.workspaces)
  ok(ids.length === 1, '★★ 建出了 1 个工作区', ids.join(','))
  const rec = doc.tables.workspaces[ids[0]]
  ok(rec && rec.title === 'QQ 桥接（测试）', '★ 标题用的是 `title` 参数', rec?.title)
  ok(
    String(rec?.path).toLowerCase() === workspace.toLowerCase(),
    '★★★ 工作区路径就是 bot 的工作区（DSH 的挂载判据是"逐字相等"）',
    rec?.path,
  )
  ok(
    Array.isArray(rec?.sessionIds) && rec.sessionIds.length === 1 && rec.sessionIds[0] === 'qq-aaaa11112222',
    '★★★ 那个会话挂进去了',
    JSON.stringify(rec?.sessionIds),
  )
  ok(doc.global.workspaceIds.includes(ids[0]), '★★ `global.workspaceIds` 里也有它（否则侧栏不显示）')
  const baks = readdirSync(join(HOME, 'storages')).filter((n) => n.startsWith('workspace.json.bak-'))
  ok(baks.length === 1, '★★★ 写之前**备份**了一份（写坏了还能回退）', baks.join(','))
  ok(r.finalCount === 1, '★★ 写完自己又读回来核对了一遍', String(r.finalCount))

  console.log('\n=== ③ 幂等：再跑一次不该重复挂 ===')
  const again = planLinkDshWorkspace({ dshHome: HOME, workspace })
  ok(again.toAttach === 0, '★★★ 第二次是 0 个待挂（不会把同一个会话挂两遍）', String(again.toAttach))
  ok(again.alreadyAttached === 1, '★ 也认得出"已经挂过了"', String(again.alreadyAttached))
  const r2 = applyLinkDshWorkspace({ dshHome: HOME, workspace, isDshRunning: () => false })
  ok(r2.created === false, '★ 第二次是"更新"而不是又建一个', String(r2.created))
  ok(Object.keys(readRegistry().tables.workspaces).length === 1, '★★★ 仍然只有 1 个工作区（键是路径，不重复建）')
}

console.log('\n=== ④ 判据边界：header.cwd 不一致 / 没有 header / 没有会话文件 ===')
{
  makeSession('qq-bbbb33334444', join(TMP, '别的地方')) // cwd 不一致
  const noHeader = join(HOME, 'sessions', enc(workspace), 'qq-cccc55556666')
  mkdirSync(noHeader, { recursive: true })
  writeFileSync(join(noHeader, 'session.v3.jsonl.zstd'), Buffer.from('这不是 zstd 帧', 'utf8'))
  mkdirSync(join(HOME, 'sessions', enc(workspace), 'qq-dddd77778888'), { recursive: true }) // 只有目录
  const found = collectBotSessions({ dshHome: HOME, workspace })
  ok(found.eligible.length === 1, '★★★ 只认 cwd 与工作区**一致**的那个', String(found.eligible.length))
  ok(found.skipped.length === 3, '★★ 另外三个如实报"跳过"（不是静默忽略）', JSON.stringify(found.skipped.map((s) => s.id)))
  ok(
    found.skipped.every((s) => s.why && s.why.length > 0),
    '★★★ 每个跳过都**带原因**（"为什么它没被挂进去"必须查得到）',
  )
}

console.log('\n=== ⑤ 安全闸：DSH 在跑时**拒绝写**（除非 --force）===')
{
  const before = readFileSync(registryPath, 'utf8')
  const r = applyLinkDshWorkspace({ dshHome: HOME, workspace, isDshRunning: () => true })
  ok(r.ok === false && /正在运行/.test(String(r.why)), '★★★ 在跑 ⇒ 拒绝并说明原因', String(r.why))
  ok(readFileSync(registryPath, 'utf8') === before, '★★★ 而且**真的没动那个文件**')
  const unknown = applyLinkDshWorkspace({ dshHome: HOME, workspace, isDshRunning: () => null })
  ok(unknown.ok === false && /查不出/.test(String(unknown.why)), '★★★ 查不出 ⇒ **也不写**（fail-closed，不赌）')
  ok(readFileSync(registryPath, 'utf8') === before, '★★ 同样没动文件')
  const forced = applyLinkDshWorkspace({ dshHome: HOME, workspace, force: true, isDshRunning: () => true })
  ok(forced.ok === true, '★ `--force` 才允许硬写（那是使用者显式承担）', forced.why ?? '')
}

console.log('\n=== ⑥ 小工具本身：不碰真机路径、缺目录时如实报错 ===')
{
  const src = readFileSync(join(PKG_ROOT, 'tools', 'link-dsh-workspace.mjs'), 'utf8')
  ok(!/APPDATA/.test(src.replace(/^\s*\*.*$/gm, '')), '★★★ 代码里没有自己去摸 APPDATA（只认传进来的 dshHome）')
  ok(/pathToFileURL\(process\.argv\[1\]\)\.href/.test(src), '★★ 逻辑与 CLI 外壳分开（测试才能不 spawn 地 import）')
  const missing = collectBotSessions({ dshHome: join(TMP, '不存在的家'), workspace })
  ok(missing.ok === false && /会话目录不存在/.test(String(missing.why)), '★★ 会话目录不存在 ⇒ 如实说，不抛', String(missing.why))
  // 备份文件也要能被解析（它是"回退用的那一份"，坏了就白备份）
  const baks = readdirSync(join(HOME, 'storages')).filter((n) => n.startsWith('workspace.json.bak-'))
  copyFileSync(join(HOME, 'storages', baks[0]), join(TMP, 'bk.json'))
  ok(existsSync(join(TMP, 'bk.json')) && JSON.parse(readFileSync(join(TMP, 'bk.json'), 'utf8')).global, '★ 备份是一份**可解析**的旧注册表')
}

rmSync(TMP, { recursive: true, force: true })

console.log('')
if (fail === 0) {
  console.log(`🎉 把 bot 会话挂进 DSH 工作区：${pass} 项通过`)
  process.exitCode = 0
} else {
  console.log(`❌ 把 bot 会话挂进 DSH 工作区：${pass} 项通过、${fail} 项失败`)
  for (const f of failures) console.log(`  · ${f}`)
  process.exitCode = 1
}
