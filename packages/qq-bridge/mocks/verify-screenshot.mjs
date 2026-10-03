/**
 * 技能「截图」（`skills/screenshot`）的守卫套件。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这组断言挡的是哪几类"看着都在、其实用不了"
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **黑图被当成成功** —— 会话隔离/锁屏时抓屏**不报错**，返回一张全黑图。
 *      这是最会骗过人的失败形状，所以 `judgeFrame()` 必须认出来并附警告。
 *   ② **权限只写在提示词里** —— MCP 层没有调用者身份，光靠工具描述拦不住
 *      "群里陌生人一句话就偷看桌面"。这一条用 fake workspace 把
 *      「有授权 / 没授权 / 过期 / 别人的会话」四种情况**真的跑一遍**。
 *   ③ **模型给的字符串被拼进脚本** —— 那就是命令注入面。
 *      断言脚本源码里**没有**任何运行期拼接点，标题只走参数文件。
 *   ④ **本机文件发图 = 任意文件读取** —— `readWorkspaceImage()` 的越界写法
 *      （绝对路径 / `..` / 符号链接）必须逐条被拒。
 *   ⑤ **两份 `grantFileName` 漂移** —— 技能与宿主各有一份实现（技能不能 import
 *      宿主的 src/）。不一致的症状是"管理员有权限，截图却说没授权"，非常安静。
 *   ⑥ **清单与代码默认值漂移** —— 界面显示 1280 宽、实际截 4096。
 *   ⑦ **PNG/JPEG 那个坑被改回去** —— .NET 的 JPEG 编码器与截屏同处一段脚本
 *      会被杀毒软件当恶意脚本拦（实测）。所以断言脚本里**没有** EncoderParameter。
 *
 * 用法：node mocks/verify-screenshot.mjs
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { discoverSkills, loadSkill, collectSkillPromptSections, describeSkill, HOST_TOOLS } from '../src/extensions.mjs'
import { __init as initSkillsServer, runSkillTool, allTools } from '../mcp/mcp-skills-server.mjs'
import { readWorkspaceImage, sniffImageMediaType } from '../src/images.mjs'
import {
  grantFileName as hostGrantFileName,
  writeGrant,
  clearGrant,
  clearAllGrants,
  shouldWriteGrant,
  grantsDir,
  GRANT_TTL_MS as HOST_TTL,
} from '../src/screenshot-grant.mjs'
import { runSendImage, __setConfig as setQqConfig } from '../mcp/mcp-qq-server.mjs'
import { normalizeConfig } from '../src/config.mjs'
import * as cap from '../skills/screenshot/capture.mjs'
import * as runner from '../skills/screenshot/ps-runner.mjs'
import * as skill from '../skills/screenshot/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const SKILL_DIR = join(PKG_ROOT, 'skills', 'screenshot')
const TMP = join(PKG_ROOT, 'cache', '.tmp-verify-screenshot')

let passed = 0
let failed = 0
let skipped = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`✅ ${name}${detail ? `  —— ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`❌ ${name}  —— ${detail}`)
  }
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

/* ══════════════════════════════════════════════════════════════════════════
   §① 纯逻辑：计划、夹取、region、文件名
   ══════════════════════════════════════════════════════════════════════════ */
section('① 计划与夹取（模型给什么都不能让 GDI+ 炸，也不能悄悄超上限）')

const plan1 = cap.planCapture({ settings: { maxWidth: 1280, format: 'png' }, args: { source: 'screen' } })
check('默认计划可用', plan1.ok && plan1.plan.source === 'screen' && plan1.plan.maxWidth === 1280, JSON.stringify(plan1.plan ?? plan1))
check('默认格式是 png', plan1.plan?.format === 'png')
check('未知 source 收敛成 screen（不报错，免得白跑一轮往返）', cap.planCapture({ args: { source: '瞎写' } }).plan.source === 'screen')
check('窗口模式缺 window 时明确拒绝', (() => { const r = cap.planCapture({ args: { source: 'window' } }); return !r.ok && /window/.test(r.reason) })())
check('窗口模式给了 window 就通过', cap.planCapture({ args: { source: 'window', window: '记事本' } }).ok === true)

check('maxWidth 夹到 64~4096（上）', cap.clampWidth(99999) === 4096)
check('maxWidth 夹到 64~4096（下）', cap.clampWidth(-5) === 64)
check('maxWidth 非数字回默认 1280', cap.clampWidth('abc') === 1280)
check('quality 夹到 2~31（0 当"没填"→取默认 4）', cap.clampQuality(1) === 2 && cap.clampQuality(999) === 31 && cap.clampQuality(0) === 4)
check('scale 非法值回 1', cap.clampScale(0) === 1 && cap.clampScale('x') === 1)
check('scale 夹到 0.5~4', cap.clampScale(99) === 4 && cap.clampScale(0.01) === 0.5)
check('retention 0/负数 = 不清理', cap.clampRetentionHours(0) === 0 && cap.clampRetentionHours(-3) === 0)
check('格式别名 jpeg → jpg', cap.normalizeFormat('JPEG') === 'jpg')
check('未知格式回 png', cap.normalizeFormat('bmp') === 'png')

check('region 数组形式', (() => { const r = cap.normalizeRegion([10, 20, 300, 400]); return r.ok && r.rect.width === 300 })())
check('region 对象形式（width/height）', cap.normalizeRegion({ x: 1, y: 2, width: 3, height: 4 }).ok === true)
check('region 少一个数就拒绝', cap.normalizeRegion([1, 2, 3]).ok === false)
check('region 宽为 0 拒绝（GDI+ 会抛 ArgumentException）', (() => { const r = cap.normalizeRegion([0, 0, 0, 100]); return !r.ok && /宽高/.test(r.reason) })())
check('region 负数宽拒绝', cap.normalizeRegion([0, 0, -10, 100]).ok === false)
check('region 里的非数字拒绝', cap.normalizeRegion(['a', 0, 10, 10]).ok === false)
check('region 缺席 = 不裁剪', (() => { const r = cap.normalizeRegion(null); return r.ok && r.rect === null })())

check('jpg 且没有 ffmpeg → 明确拒绝并给下一步', (() => {
  const r = cap.planCapture({ settings: { format: 'jpg' }, args: {}, ffmpeg: '' })
  return !r.ok && /ffmpeg/.test(r.reason) && /png/.test(r.hint ?? '')
})())
check('jpg 且有 ffmpeg → 通过', cap.planCapture({ settings: { format: 'jpg' }, args: {}, ffmpeg: 'D:\\ff\\ffmpeg.exe' }).ok === true)

const fname = cap.shotFileName({ source: 'window', at: 1700000000000, rand: 'abc123' })
check('文件名可读且无中文/空格', fname === 'shot_window_1700000000000_abc123.png', fname)
check('文件名里不会出现路径分隔符', !/[\\/]/.test(cap.shotFileName({ source: '../..' })))
check('按天分桶', /^\d{8}$/.test(cap.dayBucket(1700000000000)), cap.dayBucket(1700000000000))

/* ══════════════════════════════════════════════════════════════════════════
   §② 结果判定：黑图 / 纯色 / 空图 / 坏 JSON
   ══════════════════════════════════════════════════════════════════════════ */
section('② 黑图必须被认出来（会话隔离时抓屏不报错，只给一张全黑）')

const dark = cap.judgeFrame({ mean: 0, std: 0, bytes: 4096, width: 1280, height: 800 })
check('★ 全黑图：ok 为 true（图照给）但带警告', dark.ok === true && dark.kind === 'dark' && /全黑/.test(dark.warning))
check('★ 警告里写清了可能的原因', /锁屏|会话|服务/.test(dark.warning))
const flat = cap.judgeFrame({ mean: 200, std: 0.4, bytes: 4096, width: 100, height: 100 })
check('纯色图：判定为 flat 并警告', flat.kind === 'flat' && /纯色/.test(flat.warning))
const normal = cap.judgeFrame({ mean: 180, std: 40, bytes: 4096, width: 100, height: 100 })
check('正常图：没有警告', normal.kind === 'normal' && normal.warning === '')
check('★ 空图 = 失败（不是"成功了但很小"）', cap.judgeFrame({ mean: 0, std: 0, bytes: 0, width: 0, height: 0 }).ok === false)
check('统计缺席时不猜（放行、不给黑屏结论）', cap.judgeFrame({ bytes: 100, width: 10, height: 10 }).kind === 'normal')

check('结果 JSON 正常解析', (() => {
  const r = cap.parseResult(JSON.stringify({ ok: true, width: 100, height: 50, bytes: 2048, mean: 120, std: 30 }))
  return r.ok && r.stats.width === 100
})())
check('结果 JSON 报错时把原因带出来', (() => {
  const r = cap.parseResult(JSON.stringify({ ok: false, error: '没有找到窗口' }))
  return !r.ok && r.reason === '没有找到窗口'
})())
check('结果不是 JSON → 失败并保留原文片段（排障要靠它）', (() => {
  const r = cap.parseResult('<html>错误</html>')
  return !r.ok && /不是 JSON/.test(r.reason) && /html/.test(r.reason)
})())
check('结果文件为空 → 失败并说明"脚本没跑起来"', (() => {
  const r = cap.parseResult('')
  return !r.ok && /没跑起来|中途被杀/.test(r.reason)
})())

/* ══════════════════════════════════════════════════════════════════════════
   §③ 清理：只删过期的，0 小时一个都不删
   ══════════════════════════════════════════════════════════════════════════ */
section('③ 清理（别把刚截的图删了）')

const now = Date.now()
const files = [
  { path: '/a/old.png', name: 'old.png', mtimeMs: now - 48 * 3600_000 },
  { path: '/a/fresh.png', name: 'fresh.png', mtimeMs: now - 60_000 },
]
check('24 小时保留：只删旧的', JSON.stringify(cap.pickExpired(files, { now, retentionHours: 24 })) === JSON.stringify(['/a/old.png']))
check('★ 0 小时 = 一个都不删', cap.pickExpired(files, { now, retentionHours: 0 }).length === 0)
check('mtime 缺失的条目不会被误删', cap.pickExpired([{ path: '/a/x.png', name: 'x.png' }], { now, retentionHours: 1 }).length === 0)
check('清理按时间间隔抽样（不是每次调用都扫盘）', cap.shouldSweep({ lastSweepAt: now - 1000, now }) === false && cap.shouldSweep({ lastSweepAt: 0, now }) === true)

/* ══════════════════════════════════════════════════════════════════════════
   §④ 脚本拼装：注入面、黑图兜底、JPEG 那个坑
   ══════════════════════════════════════════════════════════════════════════ */
section('④ PowerShell 脚本（模型给的字符串绝不能拼进源码）')

const ps = runner.internals.PS_SOURCE
check('★★ 脚本里没有 .NET 的 JPEG 编码器（实测会被杀毒软件拦）', !/EncoderParameter|ImageCodecInfo|GetImageEncoders/.test(ps))
check('★ 脚本通过参数文件读自由文本（`Get-Content -LiteralPath $Params`）', /Get-Content -LiteralPath \$Params/.test(ps))
check('★ 脚本里有三级抓屏兜底（BitBlt → CopyFromScreen → PrintWindow）', /BitBlt/.test(ps) && /CopyFromScreen/.test(ps) && /PrintWindow\(\[Shot\]::GetDesktopWindow/.test(ps))
check('★ 采样统计在**缩放之前**判一次（否则兜底永远不会触发）', ps.indexOf('New-Capture') < ps.indexOf('InterpolationMode'))
check('窗口用 PW_RENDERFULLCONTENT(=2)（浏览器/Electron 必需）', /PrintWindow\(\$h, \$hdc, 2\)/.test(ps))
check('结果写入用 UTF-8 无 BOM（Node 侧 JSON.parse 才稳）', /UTF8Encoding\(\$false\)/.test(ps))
check('DPI 感知在抓图之前设置（否则多屏坐标会错）', ps.indexOf('MakeDpiAware') < ps.indexOf('New-Capture'))
check('脚本里没有把 args/标题直接插值的痕迹', !/\$\{?window\}?.*GetWindowText/.test(ps))

const cs = runner.internals.CS_SOURCE
check('C# 里只导出必要的 Win32 入口（没有额外能力）', /PrintWindow/.test(cs) && !/CreateProcess|ShellExecute|WriteProcessMemory/.test(cs))

/* ══════════════════════════════════════════════════════════════════════════
   §⑤ runCapture：注入的 runner 下跑完整条路（真跑 PowerShell 的网络/权限无关）
   ══════════════════════════════════════════════════════════════════════════ */
section('⑤ runCapture（用注入的 runner 跑：参数拼装、临时文件清理、上限）')

const ws = join(TMP, 'ws')
const shots = join(ws, 'screenshots')
mkdirSync(shots, { recursive: true })

let seenArgs = []
let seenExe = ''
const fakeRun = (exe, args) => {
  seenExe = exe
  seenArgs = args
  // 参数里有 -Result <path>：照真实脚本的行为写一份结果 JSON
  const i = args.indexOf('-Result')
  const out = args[args.indexOf('-Out') + 1]
  writeFileSync(out, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
  writeFileSync(
    args[i + 1],
    JSON.stringify({ ok: true, width: 1280, height: 800, bytes: 8, mean: 150, std: 30, windowTitle: '', captureMs: 42, methods: ['BitBlt(ok=True)'] }),
    'utf8',
  )
  return Promise.resolve({ code: 0 })
}

const plan = cap.planCapture({ settings: { maxWidth: 1280 }, args: { source: 'window', window: '包含 "引号" 与 ; 分号' } }).plan
const r1 = await runner.runCapture({
  plan,
  shotsDir: shots,
  tmpDir: join(ws, 'tmp'),
  fileName: 'shot_window_1_aaa.png',
  __run: fakeRun,
})
check('runCapture 成功路径', r1.ok === true, r1.reason ?? '')
check('返回的是**绝对路径**且落在工作区里', r1.ok && resolve(r1.absPath).startsWith(resolve(shots)))
check('用了 -File + -Params/-Out/-Result（不是 -Command 传源码）', seenArgs.includes('-File') && seenArgs.includes('-Params') && seenArgs.includes('-Result'))
check('★ 窗口标题没有出现在命令行里（只走参数文件）', !seenArgs.some((a) => String(a).includes('引号')))
check('★ 临时文件跑完就删了（参数/结果/脚本都不留）', (() => {
  const tmp = join(ws, 'tmp')
  if (!existsSync(tmp)) return true
  const left = readdirSync(tmp).filter((n) => n.includes('shot') || n.includes('.ps1'))
  return left.length === 0
})(), (() => { try { return readdirSync(join(ws, 'tmp')).join(',') } catch { return '' } })())
check('假 runner 收到的可执行文件非空（findPowerShell 解出了东西）', String(seenExe).length > 0, seenExe)

const planBad = cap.planCapture({ args: {} }).plan
const r2 = await runner.runCapture({ plan: planBad, shotsDir: shots, tmpDir: join(ws, 'tmp'), fileName: '../跑出去.png', __run: fakeRun })
check('★ 文件名带上级目录 → 拒绝（不许写到截图目录外面）', r2.ok === false && /文件名/.test(r2.reason))

const r3 = await runner.runCapture({ plan: planBad, shotsDir: '', fileName: 'x.png', __run: fakeRun })
check('没有截图目录 → 明确拒绝（不退回 process.cwd()）', r3.ok === false && /目录/.test(r3.reason))

const r4 = await runner.runCapture({
  plan: planBad,
  shotsDir: shots,
  tmpDir: join(ws, 'tmp'),
  fileName: 'y.png',
  __run: () => Promise.resolve({ code: 1 }),
})
check('脚本没写出结果文件 → 失败原因里提示杀毒软件/ExecutionPolicy', r4.ok === false && /结果文件|跑起来/.test(r4.reason), r4.reason)

/* ══════════════════════════════════════════════════════════════════════════
   §⑤-b JPEG 那条路（用假 ffmpeg 跑：真 ffmpeg 不是每台机器都有）
   ══════════════════════════════════════════════════════════════════════════ */
section('⑤-b format=jpg：走 ffmpeg 转换（**不是** .NET 的 JPEG 编码器）')

{
  // 用 node 自己当"ffmpeg"：把源文件复制到最后一个参数（真 ffmpeg 的参数形状是 `-y -i src ... dst`）
  writeFileSync(
    join(TMP, 'fake-ffmpeg.mjs'),
    "import fs from 'node:fs'\nconst a = process.argv.slice(2)\nfs.copyFileSync(a[a.indexOf('-i') + 1], a[a.length - 1])\n",
    'utf8',
  )
  // 用一个 .cmd 包一层：Windows 上 spawn 能直接跑 .cmd（真 exe 由使用者自己填）
  const cmdPath = join(TMP, 'fake-ffmpeg.cmd')
  writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${join(TMP, 'fake-ffmpeg.mjs')}" %*\r\n`, 'utf8')

  const planJpg = cap.planCapture({ settings: { format: 'jpg', maxWidth: 1280 }, args: {}, ffmpeg: cmdPath }).plan
  check('jpg 计划带上了 ffmpeg 路径', planJpg?.format === 'jpg' && planJpg.ffmpeg === cmdPath)

  const rJ = await runner.runCapture({
    plan: planJpg,
    shotsDir: shots,
    tmpDir: join(ws, 'tmp'),
    fileName: 'shot_screen_1_bbb.jpg',
    __run: fakeRun,
  })
  check('★ 转换成功并产出 .jpg', rJ.ok === true, rJ.reason ?? '')
  check('★ 中间那张 PNG 被删掉了（只留最终产物）', rJ.ok && !existsSync(join(shots, 'shot_screen_1_bbb.png')))
  check('★ 返回的路径是 .jpg', rJ.ok && rJ.absPath.endsWith('.jpg'), rJ.ok ? rJ.absPath.split(/[\\/]/).pop() : '')

  const planJpgBad = cap.planCapture({ settings: { format: 'jpg' }, args: {}, ffmpeg: 'D:\\没有这个目录\\ffmpeg.exe' }).plan
  const rJBad = await runner.runCapture({ plan: planJpgBad, shotsDir: shots, tmpDir: join(ws, 'tmp'), fileName: 'shot_screen_2_ccc.jpg', __run: fakeRun })
  check('★ ffmpeg 路径不存在：给出人话（不是 ENOENT 原文）', rJBad.ok === false && /路径不存在/.test(rJBad.reason), rJBad.reason)
}

/* ══════════════════════════════════════════════════════════════════════════
   §⑥ 本机文件发图：越界写法逐条拒
   ══════════════════════════════════════════════════════════════════════════ */
section('⑥ readWorkspaceImage（这是"任意文件读取"的入口，越界必须逐条拒）')

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
const imgDir = join(ws, 'screenshots')
writeFileSync(join(imgDir, 'ok.png'), PNG_1X1)
writeFileSync(join(ws, 'note.txt'), '这不是图片')
writeFileSync(join(TMP, 'outside.png'), PNG_1X1)

const ok = readWorkspaceImage('screenshots/ok.png', { workspace: ws })
check('工作区内的相对路径：读得到', ok.ok === true && ok.bytes.byteLength > 0)
check('按内容嗅探认得出是 PNG', ok.ok && sniffImageMediaType(ok.bytes) === 'image/png')
check('★ 非图片文件：读得到但不是图片（下游会拒）', (() => {
  const r = readWorkspaceImage('note.txt', { workspace: ws })
  return r.ok && sniffImageMediaType(r.bytes) === null
})())
check('★ 绝对路径拒绝', readWorkspaceImage(join(ws, 'note.txt'), { workspace: ws }).ok === false)
check('★ 盘符路径拒绝', readWorkspaceImage('C:\\Windows\\win.ini', { workspace: ws }).ok === false)
check('★ `..` 逃逸拒绝', readWorkspaceImage('../outside.png', { workspace: ws }).ok === false)
check('★ 深层 `..` 逃逸拒绝', readWorkspaceImage('screenshots/../../outside.png', { workspace: ws }).ok === false)
check('★ 不存在的文件：给出可读原因', (() => {
  const r = readWorkspaceImage('screenshots/nope.png', { workspace: ws })
  return !r.ok && /读不到/.test(r.reason)
})())
check('没有工作区 → 拒绝', readWorkspaceImage('screenshots/ok.png', { workspace: '' }).ok === false)

// 符号链接：Windows 上建符号链接可能要开发者模式，失败就跳过（如实记，不假装通过）
try {
  const linkDir = join(TMP, 'linkws')
  mkdirSync(join(linkDir, 'screenshots'), { recursive: true })
  const linkPath = join(linkDir, 'screenshots', 'escape.png')
  rmSync(linkPath, { force: true })
  symlinkSync(join(TMP, 'outside.png'), linkPath, 'file')
  const r = readWorkspaceImage('screenshots/escape.png', { workspace: linkDir })
  check('★★ 符号链接指向工作区外 → 拒绝', r.ok === false && /符号链接/.test(r.reason), r.reason ?? '')
} catch (error) {
  skipped += 1
  console.log(`⏭️  符号链接越界：已跳过 —— 本机建不了符号链接（${error?.code ?? error?.message}），这一条**没有**被验证`)
}

check('大小上限：超了拒绝', (() => {
  const r = readWorkspaceImage('screenshots/ok.png', { workspace: ws, maxBytes: 10 })
  return !r.ok && /太大/.test(r.reason)
})())

/* ══════════════════════════════════════════════════════════════════════════
   §⑦ 管理员硬闸
   ══════════════════════════════════════════════════════════════════════════ */
section('⑦ 管理员硬闸（"任何情况下只有管理员能截"）')

check('★ 两份 grantFileName 实现给出同样的结果（技能不能 import 宿主 src/，只能各写一份）', (() => {
  const keys = ['group:700000001', 'private:100000001', '', '随便一个中文键']
  return keys.every((k) => skill.grantFileName(k) === hostGrantFileName(k))
})())
check('★ 两份 TTL 常量一致', skill.GRANT_TTL_MS === HOST_TTL, `技能=${skill.GRANT_TTL_MS} 宿主=${HOST_TTL}`)
check('★ 两份目录名一致', skill.SHOTS_DIR === 'screenshots' && skill.GRANTS_DIR === '.grants')

const cfgOn = normalizeConfig({ skills: { screenshot: { enabled: true } } })
const cfgOff = normalizeConfig({ skills: { screenshot: { enabled: false } } })
const cfgNoAdmin = normalizeConfig({ skills: { screenshot: { enabled: true, requireAdmin: false } } })
check('开关开着 → 写授权', shouldWriteGrant(cfgOn) === true)
check('开关关着 → 不写授权', shouldWriteGrant(cfgOff) === false)
check('明确关掉管理员限制 → 不写授权', shouldWriteGrant(cfgNoAdmin) === false)
check('配置里没有这个技能 → 不写授权（也不报错）', shouldWriteGrant(normalizeConfig({})) === false)

clearAllGrants({ workspace: ws })
const w1 = writeGrant({ workspace: ws, peerKey: 'group:700000001', kind: 'group', peerId: '700000001', senderId: '100000001', tier: 'admin', config: cfgOn })
check('管理员轮次：授权写成功', w1.ok === true, w1.why ?? '')
check('授权文件落在 screenshots/.grants 下', w1.ok && resolve(w1.file).startsWith(resolve(grantsDir(ws))))

const readAdmin = skill.readGrant({ workspace: ws, peerKey: 'group:700000001' })
check('★★ 技能侧读到 admin', readAdmin.state === 'admin', JSON.stringify(readAdmin))
check('★ 另一个会话读不到（授权是**按会话**的）', skill.readGrant({ workspace: ws, peerKey: 'group:999999999' }).state === 'missing')

// 非管理员轮次：会覆盖同一个会话的授权
writeGrant({ workspace: ws, peerKey: 'group:700000001', kind: 'group', peerId: '700000001', senderId: '200000001', tier: 'user', config: cfgOn })
check('★★ 同一会话里换成普通人说话 → 授权变成 not-admin（覆盖）', skill.readGrant({ workspace: ws, peerKey: 'group:700000001' }).state === 'not-admin')

check('★ 过期授权不算（10 分钟前写的）', (() => {
  writeGrant({ workspace: ws, peerKey: 'group:123', kind: 'group', peerId: '123', senderId: '1', tier: 'admin', config: cfgOn, now: Date.now() - HOST_TTL - 1000 })
  return skill.readGrant({ workspace: ws, peerKey: 'group:123' }).state === 'expired'
})())
check('★ 授权文件坏掉 → broken（不是"当成有权限"）', (() => {
  const dir = grantsDir(ws)
  writeFileSync(join(dir, hostGrantFileName('group:456')), '{ 不是 json', 'utf8')
  return skill.readGrant({ workspace: ws, peerKey: 'group:456' }).state === 'broken'
})())
check('没有工作区 → missing（fail-closed）', skill.readGrant({ workspace: '', peerKey: 'group:1' }).state === 'missing')

check('★ 只清自己那一个会话（清空目录会误伤并发的别的会话）', (() => {
  clearAllGrants({ workspace: ws })
  writeGrant({ workspace: ws, peerKey: 'group:A', kind: 'group', peerId: 'A', senderId: '1', tier: 'admin', config: cfgOn })
  writeGrant({ workspace: ws, peerKey: 'group:B', kind: 'group', peerId: 'B', senderId: '1', tier: 'admin', config: cfgOn })
  clearGrant({ workspace: ws, peerKey: 'group:A' })
  return skill.readGrant({ workspace: ws, peerKey: 'group:A' }).state === 'missing' && skill.readGrant({ workspace: ws, peerKey: 'group:B' }).state === 'admin'
})())

/* ══════════════════════════════════════════════════════════════════════════
   §⑧ 工具契约：宿主加载 + 拒绝路径真的走到
   ══════════════════════════════════════════════════════════════════════════ */
section('⑧ 走宿主装载与派发（工具名、开关拒绝、权限拒绝）')

const found = discoverSkills({ skillsDir: join(PKG_ROOT, 'skills') })
const sk = found.skills.find((s) => s.id === 'screenshot')
check('技能被发现', Boolean(sk))
check('清单零 errors', (sk?.errors ?? []).length === 0, JSON.stringify(sk?.errors ?? []))
check('清单零 warnings', (sk?.warnings ?? []).length === 0, JSON.stringify(sk?.warnings ?? []))
await loadSkill(sk, { config: {}, log: () => {} })
check('装载成功且有 capture 工具', sk?.loaded === true && (sk?.runtimeTools ?? []).some((t) => t.id === 'capture'), sk?.loadError ?? '')

const customWs = join(TMP, 'ws-mcp')
mkdirSync(join(customWs, 'screenshots'), { recursive: true })
const cfg = {
  skillsDir: join(PKG_ROOT, 'skills'),
  configPath: join(TMP, 'config.json'),
  workspace: customWs,
}
writeFileSync(cfg.configPath, JSON.stringify({ skills: { screenshot: { enabled: true } } }), 'utf8')
await initSkillsServer(cfg)
const toolName = allTools().find((x) => x.skill?.id === 'screenshot')?.name
check('MCP 服务器内部的工具名是 screenshot__capture（模型看到的全名由 DSH 加 mcp__skills__ 前缀）', toolName === 'screenshot__capture', String(toolName))
const fullName = collectSkillPromptSections({ skills: [sk], config: { skills: { screenshot: { enabled: true } } } })
  .lines[0]?.content ?? ''
check('★ 提示词片段里的全名与宿主命名规则一致（mcp__skills__screenshot__capture）', fullName.includes('mcp__skills__screenshot__capture'))

const run = (args) => runSkillTool(toolName, { kind: 'group', peerId: '700000001', ...args })

// ① 开关关着
writeFileSync(cfg.configPath, JSON.stringify({ skills: { screenshot: { enabled: false } } }), 'utf8')
const offOut = await run({})
check('★ 开关关着：拒绝，并给一句可转述的中文', offOut.isError === true && /关闭/.test(offOut.text), offOut.text.slice(0, 80))

// ② 开着但没有授权（真实威胁：群里陌生人一句话）
writeFileSync(cfg.configPath, JSON.stringify({ skills: { screenshot: { enabled: true } } }), 'utf8')
clearAllGrants({ workspace: customWs })
const noGrant = await run({})
check('★★ 群里没有管理员授权：拒绝执行', noGrant.isError === true && /授权|只有管理员/.test(noGrant.text), noGrant.text.slice(0, 100))
check('★ 拒绝时不泄露实现细节（不提"授权文件"以外的系统内部名）', !/ctx|workspace|token/.test(noGrant.text))

// ③ 管理员会话：这次会**真的去截图**（用不到真屏幕也不用跑 —— 走的是真链路，
//    所以这里只验"不因为权限被拒"，真抓图由 verify-screenshot-real 负责）
writeGrant({ workspace: customWs, peerKey: 'group:700000001', kind: 'group', peerId: '700000001', senderId: '100000001', tier: 'admin', config: cfgOn })
const adminOut = await run({ source: 'window', window: '一个几乎不可能存在的窗口标题_zzz' })
check('★ 管理员会话：权限关通过（失败原因是"没找到窗口"而不是"没权限"）', /没有找到标题里含/.test(adminOut.text), adminOut.text.slice(0, 120))

// ④ 群聊被关掉时：群里拒绝
writeFileSync(cfg.configPath, JSON.stringify({ skills: { screenshot: { enabled: true, allowInGroup: false } } }), 'utf8')
const groupOff = await run({})
check('★ allowInGroup=false：群里拒绝，且提示别改成私聊绕过', groupOff.isError === true && /群/.test(groupOff.text), groupOff.text.slice(0, 100))
writeFileSync(cfg.configPath, JSON.stringify({ skills: { screenshot: { enabled: true } } }), 'utf8')

// ⑤ 关闭管理员限制时：没授权也放行（但要在提示词里警告）
writeFileSync(cfg.configPath, JSON.stringify({ skills: { screenshot: { enabled: true, requireAdmin: false } } }), 'utf8')
clearAllGrants({ workspace: customWs })
const noAdminNeeded = await run({ source: 'window', window: '一个几乎不可能存在的窗口标题_zzz' })
check('★ requireAdmin=false 时不再要求授权（管理员自己选的）', /没有找到标题里含/.test(noAdminNeeded.text), noAdminNeeded.text.slice(0, 100))
writeFileSync(cfg.configPath, JSON.stringify({ skills: { screenshot: { enabled: true } } }), 'utf8')

/* ══════════════════════════════════════════════════════════════════════════
   §⑨ 提示词片段
   ══════════════════════════════════════════════════════════════════════════ */
section('⑨ 提示词片段（用真名、说清何时用、不许猜画面）')

const secs = collectSkillPromptSections({ skills: [sk], config: { skills: { screenshot: { enabled: true } } } })
const text = (secs.lines ?? []).map((l) => String(l?.content ?? '')).join('\n')
check('片段注入了', text.length > 0, `${(secs.lines ?? []).length} 段`)
check('★ 用的是工具**真名**（宿主兜底提供 toolName，不写死裸名）', text.includes('mcp__skills__screenshot__capture'))
check('★ 说了"别猜画面内容"', /别猜|看不到就直说/.test(text))
check('★ 说了发图要用宿主工具（宿主给了真名就用真名）', text.includes(HOST_TOOLS.send_image) || /发图工具/.test(text))
check('★ 宿主给了 hostTool 时用的是真名（不是含糊措辞）', text.includes(HOST_TOOLS.send_image), `期望含 ${HOST_TOOLS.send_image}`)
check('★ 说了权限只有管理员', /管理员/.test(text))
const secsOff = collectSkillPromptSections({ skills: [sk], config: { skills: { screenshot: { enabled: false } } } })
check('★ 关掉后提示词里一个字都没有', (secsOff.lines ?? []).length === 0)

const availOff = skill.available({ settings: { enabled: false } })
check('available()：关着时给出"去哪儿开"的原因', availOff.ok === false && /控制台|扩展/.test(availOff.reason))
check('available()：开着时 ok（本机有 PowerShell）', skill.available({ settings: { enabled: true } }).ok === (skill.hasPowerShellOnPath() ? true : false))
check('available()：jpg 且没有 ffmpeg 时明确说清为什么', (() => {
  const r = skill.available({ settings: { enabled: true, format: 'jpg' } })
  if (skill.hasPowerShellOnPath() === false) return true
  const hasFf = (() => {
    try {
      return process.env.PATH.split(';').some((d) => existsSync(join(d.trim(), 'ffmpeg.exe')))
    } catch {
      return false
    }
  })()
  return hasFf ? true : r.ok === false && /ffmpeg/.test(r.reason)
})())

const dg = skill.diagnose({ settings: { enabled: true }, workspace: ws })
check('diagnose() 不碰屏幕、只报状态', dg.ok === true && (dg.lines ?? []).length >= 4, JSON.stringify(dg.lines?.length))

/* ══════════════════════════════════════════════════════════════════════════
   §⑩ 清单与代码默认值不漂移 + 技能契约（零依赖）
   ══════════════════════════════════════════════════════════════════════════ */
section('⑩ 默认值不漂移 / 技能可以整目录搬走')

const mSettings = sk?.manifest?.settings ?? {}
const schemaKeys = Object.keys(sk?.manifest?.configSchema ?? {})
check('settings 与 configSchema 键集一致', schemaKeys.sort().join(',') === Object.keys(mSettings).sort().join(','), `schema=${schemaKeys.join(',')}`)
check('每个 configSchema 字段都有 label', Object.values(sk?.manifest?.configSchema ?? {}).every((f) => Boolean(f.label)))
check('★ 默认关闭（截屏默认开等于把桌面交出去）', mSettings.enabled === false && sk?.manifest?.enabledByDefault === false)
check('★ 默认要求管理员', mSettings.requireAdmin === true)
check('★ session=required（授权必须按会话判）', sk?.manifest?.session === 'required')
check('★ 工具声明为 write 权限（描述里会加"只有管理员"）', sk?.manifest?.tools?.[0]?.permission === 'write')

const described = describeSkill(sk, { skills: { screenshot: { enabled: true } } })
check('describeSkill 无 warning（界面卡片干净）', (described.warnings ?? []).length === 0, JSON.stringify(described.warnings ?? []))

const srcFiles = ['index.js', 'capture.mjs', 'ps-runner.mjs']
const hostImports = []
const bareImports = []
for (const f of srcFiles) {
  const s = readFileSync(join(SKILL_DIR, f), 'utf8')
  for (const m of s.matchAll(/from\s+'([^']+)'/g)) {
    const spec = m[1]
    if (spec.startsWith('node:')) continue
    if (spec.startsWith('./') || spec.startsWith('../')) {
      if (!existsSync(resolve(SKILL_DIR, spec))) hostImports.push(`${f} → ${spec}(不存在)`)
      if (spec.includes('src/')) hostImports.push(`${f} → ${spec}`)
      continue
    }
    bareImports.push(`${f} → ${spec}`)
  }
}
check('★★ 没有 import 宿主的 src/（技能契约：整目录拷走还能跑）', hostImports.length === 0, hostImports.join('; '))
check('★★ 没有第三方裸包（少一个包就 ERR_MODULE_NOT_FOUND，只在别人机器上出现）', bareImports.length === 0, bareImports.join('; '))

/* ══════════════════════════════════════════════════════════════════════════
   §⑪ 宿主侧缺口：ctx.workspace / ctx.hostTool / qq_send_image 本机文件
   ══════════════════════════════════════════════════════════════════════════ */
section('⑪ 宿主侧接线（这几处是"配了但拿不到"的经典静默缺口）')

const skillsServerSrc = readFileSync(join(PKG_ROOT, 'mcp', 'mcp-skills-server.mjs'), 'utf8')
check('★ MCP 技能子进程把 workspace 放进 ctx', /workspace:\s*String\(config\?\.workspace/.test(skillsServerSrc))
check('★ ctx 里也有 hostTool（技能要引用宿主工具时用）', /hostTool:\s*\(id\)/.test(skillsServerSrc))
check('★ HOST_TOOLS 是唯一的工具名来源（没有第二处硬编码）', /send_image:\s*`mcp__\$\{QQ_SERVER_NAME\}__qq_send_image`/.test(readFileSync(join(PKG_ROOT, 'src', 'extensions.mjs'), 'utf8')))

const qqSrc = readFileSync(join(PKG_ROOT, 'mcp', 'mcp-qq-server.mjs'), 'utf8')
check('★ qq_send_image 描述里写明了可以给工作区相对路径', /工作区里的相对路径/.test(qqSrc))

/* qq_send_image 走本机文件那条路：这几条断言**不碰网络** ——
   传的是不存在的文件 / 越界路径 / 别的协议，`runSendImage` 会在
   发起任何 OneBot 调用之前就返回。所以这里不需要 mock 协议端。 */
setQqConfig({ httpUrl: 'http://127.0.0.1:9', workspace: ws, selfId: '1', configPath: join(TMP, '不存在.json') })
const sendNoFile = await runSendImage({ url: 'screenshots/nope.png', kind: 'group', peerId: '700000001' })
check('★ 本机文件不存在：给出"图没发出去 + 原因"（不会去连协议端）', sendNoFile.isError === true && /读不到|图没发出去/.test(sendNoFile.text), sendNoFile.text.slice(0, 120))
const sendEscape = await runSendImage({ url: '../../../windows/win.ini', kind: 'group', peerId: '700000001' })
check('★ 越界路径：拒绝', sendEscape.isError === true && /工作区/.test(sendEscape.text), sendEscape.text.slice(0, 120))
const sendProtocol = await runSendImage({ url: 'file:///C:/windows/win.ini', kind: 'group', peerId: '700000001' })
check('★ file:// 协议：明确拒绝（不落进路径分支）', sendProtocol.isError === true && /http\/https/.test(sendProtocol.text), sendProtocol.text.slice(0, 140))
const sendSession = await runSendImage({ url: 'screenshots/ok.png', kind: '', peerId: '' })
check('★ 没给会话：拒绝（不许发到不确定的会话）', sendSession.isError === true && /会话/.test(sendSession.text))
const sendNotImage = await runSendImage({ url: 'note.txt', kind: 'group', peerId: '700000001' })
check('★ 工作区里的非图片文件：拒绝（按内容判，不看扩展名）', sendNotImage.isError === true && /不是支持的图片/.test(sendNotImage.text), sendNotImage.text.slice(0, 140))
setQqConfig({ httpUrl: 'http://127.0.0.1:9', selfId: '1' })

/* ══════════════════════════════════════════════════════════════════════════
   §⑫ 桥接接线：授权写在前、清在后 + 登记进 npm test
   ══════════════════════════════════════════════════════════════════════════ */
section('⑫ 桥接接线与登记')

const bridgeSrc = readFileSync(join(PKG_ROOT, 'src', 'bridge.mjs'), 'utf8')
check('★ bridge 在跑模型之前写授权', bridgeSrc.indexOf('writeGrant({') > 0 && bridgeSrc.indexOf('writeGrant({') < bridgeSrc.indexOf('await this.rpc.prompt('))
const dropCall = (bridgeSrc.match(/^\s*dropGrant\(\)/gm) ?? []).length
check('★ 授权在失败出口与正常出口都清了', dropCall >= 2, `调用点 ${dropCall} 个`)
check('★ tier 取自 roster 的判定结果（模型改不了的那个事实）', /writeGrant\(\{[\s\S]{0,400}?\btier,/.test(bridgeSrc))

const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
check('★★ 本套件已登记进 npm test 链（写好了没人跑 = 等于没写）', String(pkg.scripts?.test ?? '').includes('mocks/verify-screenshot.mjs'))
check('★★ 有独立的真机套件入口 test:screenshot-real', Boolean(pkg.scripts?.['test:screenshot-real']))

const assemble = readFileSync(join(PKG_ROOT, 'scripts', 'assemble-release.mjs'), 'utf8')
check("★ 发布组装含 'skills'（新技能自动进包）", /'skills'/.test(assemble))

/* ══════════════════════════════════════════════════════════════════════════ */

rmSync(TMP, { recursive: true, force: true })

console.log(`\n${'─'.repeat(60)}`)
console.log(`截图（screenshot）：通过 ${passed} 项，失败 ${failed} 项，跳过 ${skipped} 项`)
if (skipped > 0) console.log('（跳过项的原因已逐条打印，如实记录，不当作通过）')
process.exit(failed > 0 ? 1 : 0)
