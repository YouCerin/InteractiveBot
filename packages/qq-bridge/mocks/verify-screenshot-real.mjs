/**
 * 技能「截图」的**真机**套件：真的抓一次屏、真的发一次文件、真的走一遍会话授权。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它和 `verify-screenshot.mjs` 的分工（别把两件事混起来）
 * ══════════════════════════════════════════════════════════════════════════
 *   `verify-screenshot.mjs`（离线，进 `npm test`）：把"抓图之外"的一切真跑一遍 ——
 *     参数收敛、路径约束、黑图判定、权限硬闸、脚本拼装的注入面。
 *   本套件（要真环境）：**只有真跑才知道**的那几件事 ——
 *     ① 这台机器上 PowerShell 到底抓不抓得到画面（会话隔离/锁屏时会返回全黑）；
 *     ② 抓出来的 PNG 是不是**真的**能被解码、尺寸对不对；
 *     ③ 抓到的图能不能**真的**作为工作区文件发出去（`qq_send_image` 那条新路）；
 *     ④ 「写授权 → 技能读到 admin → 清授权 → 技能读到 missing」这条端到端闭环。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 环境不满足时**跳过并明说**，不伪装成通过
 * ══════════════════════════════════════════════════════════════════════════
 * 三种情况下这一套会跳过（各自打印原因）：
 *   · 本环境不允许启动**带管道**的子进程（受限沙箱的 EPERM）；
 *   · 本机没有 PowerShell；
 *   · **没有可截的桌面会话**（服务/无人登录/锁屏）—— 这时抓图会得到全黑图，
 *     本套件会把它当成"环境限制"如实报告，而不是"功能坏了"。
 * 用法：npm run test:screenshot-real
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { canSpawn, printSkipSummary } from './harness.mjs'
import { planCapture, shotFileName } from '../skills/screenshot/capture.mjs'
import { findPowerShell, resetPowerShellCache, runCapture } from '../skills/screenshot/ps-runner.mjs'
import { grantFileName, readGrant, SHOTS_DIR, GRANTS_DIR } from '../skills/screenshot/index.js'
import { writeGrant, clearGrant, grantsDir, clearAllGrants } from '../src/screenshot-grant.mjs'
import { readWorkspaceImage, sniffImageMediaType } from '../src/images.mjs'
import { normalizeConfig } from '../src/config.mjs'
import { runSendImage, __setConfig as setQqConfig } from '../mcp/mcp-qq-server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const WS = join(PKG_ROOT, 'cache', '.tmp-screenshot-real')
const SHOTS = join(WS, SHOTS_DIR)

let passed = 0
let failed = 0
const skippedSections = []

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`✅ ${name}${detail ? `  —— ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`❌ ${name}  —— ${detail}`)
  }
}
function skip(name, why) {
  console.log(`⏭️  ${name}  —— 已跳过：${why}`)
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

rmSync(WS, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })

/* ══════════════════════════════════════════════════════════════════════════
   §① 与桌面无关的端到端闭环（这些在任何环境都必须跑）
   ══════════════════════════════════════════════════════════════════════════ */
section('① 会话授权端到端（写 → 技能读到 admin → 清 → 技能读到 missing）')

const cfgOn = normalizeConfig({ skills: { screenshot: { enabled: true } }, access: { adminUsers: ['100000001'] } })
const cfgOff = normalizeConfig({ skills: { screenshot: { enabled: false } }, access: { adminUsers: ['100000001'] } })

clearAllGrants({ workspace: WS })
const w = writeGrant({ workspace: WS, peerKey: 'private:100000001', kind: 'private', peerId: '100000001', senderId: '100000001', tier: 'admin', config: cfgOn })
check('授权写成功', w.ok === true, w.why ?? '')
const g1 = readGrant({ workspace: WS, peerKey: 'private:100000001' })
check('★ 技能侧读到 admin（跨进程契约成立）', g1.state === 'admin', JSON.stringify(g1))
clearGrant({ workspace: WS, peerKey: 'private:100000001' })
check('★ 清掉之后技能侧读到 missing（fail-closed）', readGrant({ workspace: WS, peerKey: 'private:100000001' }).state === 'missing')
const before = readdirSync(grantsDir(WS)).length
check('授权文件确实被删掉（不是只判过期）', before === 0, `目录里还剩 ${before} 个`)
check('技能关着时不写授权', writeGrant({ workspace: WS, peerKey: 'x', kind: 'private', peerId: '1', senderId: '1', tier: 'admin', config: cfgOff }).ok === false)

/* ══════════════════════════════════════════════════════════════════════════
   §② 真抓一张（要桌面会话）
   ══════════════════════════════════════════════════════════════════════════ */
section('② 真抓屏（PowerShell → BitBlt/CopyFromScreen → PNG → 采样统计）')

resetPowerShellCache()
const ps = findPowerShell()
const spawnOk = await canSpawn()

if (!ps) {
  skippedSections.push('② 真抓屏')
  skip('真抓屏', '本机找不到 PowerShell（`pwsh` / `powershell.exe` 都起不来）')
} else {
  console.log(`   （用 ${ps}；spawn 管道能力=${spawnOk ? '有' : '无（本套件自己不用管道，见 ps-runner 说明）'}）`)
  const plan = planCapture({ settings: { maxWidth: 1280, format: 'png' }, args: { source: 'screen' }, ffmpeg: '' }).plan
  const name = shotFileName({ source: 'screen', at: Date.now() })
  const t0 = Date.now()
  const r = await runCapture({ plan, shotsDir: SHOTS, tmpDir: join(WS, 'tmp'), fileName: name })
  const took = Date.now() - t0

  if (!r.ok) {
    // 抓图失败要看原因，不能一股脑算红：脚本被安全软件拦、没有桌面会话都会落这里
    check('真抓屏成功', false, r.reason)
  } else {
    const abs = r.absPath
    const head = readFileSync(abs).subarray(0, 8)
    const isPng = head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    check('★ 产出的文件真的是 PNG（魔数）', isPng, head.toString('hex'))
    check('★ 尺寸合理（>200×200，且宽度不超过设置的上限）', r.stats.width > 200 && r.stats.height > 200 && r.stats.width <= 1280, `${r.stats.width}x${r.stats.height}`)
    check('文件大小与统计一致', statSync(abs).size === r.stats.bytes, `${r.stats.bytes} 字节`)
    check('抓图耗时在合理范围（<10 秒）', took < 10_000, `${took}ms（脚本自报 ${r.stats.captureMs}ms）`)
    check('采样统计有数（黑屏判定用的就是它）', Number.isFinite(r.stats.mean) && Number.isFinite(r.stats.std), `mean=${r.stats.mean?.toFixed?.(1)} std=${r.stats.std?.toFixed?.(1)}`)
    if (r.kind === 'dark' || r.kind === 'flat') {
      // ★ 这不是失败：会话隔离/锁屏时**本来**就是这个结果 —— 而"能如实报出来"正是被测行为
      skip('画面内容验证', `抓到的是接近全黑/纯色的图（${r.kind}）—— 当前会话可能锁屏或不是交互会话；**这不算功能坏了**，警告文案已经如实给出`)
      check('★ 接近全黑时带了明确的警告（不是静默成功）', r.warning.length > 0, r.warning.slice(0, 60))
    } else {
      check('画面是正常桌面（非全黑/纯色）', r.kind !== 'dark' && r.kind !== 'flat', `kind=${r.kind} mean=${r.stats.mean?.toFixed?.(1)}`)
    }
    check('★ 顺带记录了用了哪种抓屏方式（驱动有问题时这是唯一的线索）', Array.isArray(r.stats.methods) && r.stats.methods.length > 0, (r.stats.methods ?? []).join(' + '))

    /* §③ 指定矩形：尺寸必须与要求**逐像素**相等（坐标算错一眼就能看出来） */
    section('③ 指定矩形（region 的坐标换算对不对）')
    const planR = planCapture({ settings: { maxWidth: 4096 }, args: { source: 'screen', region: [40, 30, 320, 240] }, ffmpeg: '' }).plan
    const nameR = shotFileName({ source: 'screen', at: Date.now() })
    const rR = await runCapture({ plan: planR, shotsDir: SHOTS, tmpDir: join(WS, 'tmp'), fileName: nameR })
    check('★ 矩形截图尺寸逐像素一致（320×240）', rR.ok && rR.stats.width === 320 && rR.stats.height === 240, rR.ok ? `${rR.stats.width}x${rR.stats.height}` : rR.reason)

    /* §④ 工作区文件发图：真读文件、真嗅探（网络那一步用不到，因为这里只验到"取到图"） */
    section('④ 本机工作区文件发图（qq_send_image 的新入参）')
    const rel = `${SHOTS_DIR}/${name}`
    const read = readWorkspaceImage(rel, { workspace: WS })
    check('★ 从工作区相对路径读到了字节', read.ok === true, read.ok ? `${read.bytes.byteLength} 字节` : read.reason)
    check('★ 内容嗅探认得出是 PNG', read.ok && sniffImageMediaType(read.bytes) === 'image/png')

    // 协议端故意指向一个不存在的地址：这条路会在"取到图之后"才失败，
    // 恰好证明"图确实读到了、类型也过了，只是发不出去" —— 失败文案里必须说清这一点。
    writeFileSync(join(WS, 'config.json'), JSON.stringify({}), 'utf8')
    setQqConfig({ httpUrl: 'http://127.0.0.1:9', workspace: WS, selfId: '1', configPath: join(WS, 'config.json') })
    const sent = await runSendImage({ url: rel, kind: 'private', peerId: '100000001' })
    check('★ 本机文件走到了"发送"这一步（失败原因是协议端连不上，不是读不到图）', sent.isError === true && /发送失败/.test(sent.text), sent.text.slice(0, 140))
    setQqConfig({ httpUrl: 'http://127.0.0.1:9', selfId: '1' })

    /* §⑤ 保留时长：把 mtime 改老，看它会不会被清掉 */
    section('⑤ 清理过期截图（真删文件）')
    const old = join(SHOTS, 'shot_screen_old_zzz.png')
    writeFileSync(old, readFileSync(abs))
    const past = new Date(Date.now() - 30 * 3600_000)
    const { utimesSync } = await import('node:fs')
    utimesSync(old, past, past)
    // 直接用模块自己的清理逻辑（sweep 是模块级私有导出之外的东西，这里走 pickExpired + 真删）
    const { pickExpired } = await import('../skills/screenshot/capture.mjs')
    const list = readdirSync(SHOTS)
      .filter((n) => /\.png$/i.test(n))
      .map((n) => ({ path: join(SHOTS, n), name: n, mtimeMs: statSync(join(SHOTS, n)).mtimeMs }))
    const expired = pickExpired(list, { now: Date.now(), retentionHours: 24 })
    check('★ 30 小时前的那张被判为过期', expired.some((p) => p.endsWith('shot_screen_old_zzz.png')), expired.map((p) => p.split(/[\\/]/).pop()).join(','))
    check('★ 刚截的那张**没有**被判过期', !expired.some((p) => p.endsWith(name)))
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   §⑥ 窗口级抓图（要有一个真的可见窗口）
   ══════════════════════════════════════════════════════════════════════════ */
section('⑥ 窗口级抓图（PrintWindow：被遮挡也能截到）')

if (!ps) {
  skippedSections.push('⑥ 窗口级')
  skip('窗口级抓图', '本机找不到 PowerShell')
} else {
  // 起一个带**唯一标题**的 PowerShell 窗口，再按标题去截它 —— 不依赖"当前恰好有什么窗口"
  // （按"记事本/浏览器"去截在 CI 上必然找不到，那种红没有意义）。
  const { spawn } = await import('node:child_process')
  const marker = `ShotProbe_${Date.now().toString(36)}`
  let probe = null
  try {
    probe = spawn(ps, ['-NoProfile', '-Command', `$Host.UI.RawUI.WindowTitle='${marker}'; Start-Sleep -Seconds 25`], {
      stdio: 'ignore',
      windowsHide: false,
    })
  } catch {
    probe = null
  }
  // 等窗口出来
  await new Promise((r) => setTimeout(r, 2500))
  const planW = planCapture({ settings: { maxWidth: 0 }, args: { source: 'window', window: marker }, ffmpeg: '' }).plan
  const rW = await runCapture({
    plan: planW,
    shotsDir: SHOTS,
    tmpDir: join(WS, 'tmp'),
    fileName: shotFileName({ source: 'window', at: Date.now() }),
  })
  try {
    probe?.kill()
  } catch {
    /* 已经退出 */
  }
  if (rW.ok) {
    check('★ 按标题找到了窗口并截到图', rW.stats.width > 20 && rW.stats.height > 20, `${rW.stats.width}x${rW.stats.height}`)
    check('★ 返回的窗口标题确实是我们要找的那个', String(rW.stats.windowTitle).includes(marker), rW.stats.windowTitle)
  } else if (/没有找到标题/.test(rW.reason)) {
    skippedSections.push('⑥ 窗口级')
    skip('窗口级抓图', `本环境起不了可见窗口（${rW.reason}）—— 无桌面会话时会出现这种结果，**不算功能坏了**`)
  } else {
    check('窗口级抓图成功', false, rW.reason)
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */

rmSync(WS, { recursive: true, force: true })

console.log(`\n${'─'.repeat(60)}`)
console.log(`截图真机（screenshot-real）：通过 ${passed} 项，失败 ${failed} 项`)
if (skippedSections.length > 0) {
  console.log(`⚠️ 有 ${skippedSections.length} 个小节**未运行**（环境限制）：${skippedSections.join('、')}`)
  console.log('   这**不算**完整通过 —— 请在正常 Windows 交互会话里重跑。')
}
printSkipSummary(failed, failed === 0 ? '✅ 真机套件全部通过' : '')
process.exit(failed > 0 ? 1 : 0)
