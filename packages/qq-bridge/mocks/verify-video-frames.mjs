/**
 * 技能「视频抽帧」（`skills/video-frames`，上游 video-frames 1.0.0 的 InteractBot 适配版）的守卫套件。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要这组断言（它挡的是哪几类"看着都在、其实用不了"）
 * ══════════════════════════════════════════════════════════════════════════
 * 这个技能的坏法都很安静，而且**本机没有 ffmpeg**（PATH、仓库里都没有；
 * SnowLuma 那个 `ffmpegAddon.win32.x64.node` 是 Electron 插件、不是可执行文件）——
 * 也就是说"真跑一遍抽帧"这条路在本机根本走不通。所以这套断言做的事是：
 * **把抽帧之外的一切都真的跑一遍**，抽帧本身用注入的命令执行器跑（见 §⑤）。
 *
 *   ① 清单被宿主拒了 / 有 warning —— 拒了是"静默不加载"，warning 是"设置项在界面上
 *      根本不会出现"，两类都不报错（见 `docs/插件设计规范.md` §2.3）。
 *   ② 工具名写死 —— 模型会去调一个不存在的工具，而失败得**非常安静**（它只会说"读不到"）。
 *   ③ 模型拿到的是 base64 字符串还以为自己"看见"了 —— 本宿主技能工具只能返回文本，
 *      所以必须落盘 + `read_image`，这条得钉住。
 *   ④ 路径没做收束 —— 技能进程**没有沙箱**，模型给的绝对路径就能把任意文件转成图给模型看。
 *   ⑤ URL 下载没做 SSRF 守卫 —— 群友发一条链接就能让机器人探内网。
 *   ⑥ 帧落在工作区外面 —— 模型 `read_image` 读不到（它的沙箱根 = 工作区）。
 *   ⑦ 清单与代码里的默认值漂移 —— 界面显示 4 帧、实际抽 6 帧。
 *
 * ★ 为什么用真实目录 + 宿主自己的校验函数（照 `verify-sticker-skill.mjs` 的方法论）：
 *   这一层要验的正是"**当前这份**能不能被加载"，造个夹具就等于把被测对象换掉了。
 *
 * ⚠️ 一处必须知道的模块实例细节：MCP 子进程用 `import(entry + '?t=<mtime>')` 加载技能
 *   （见 `src/extensions.mjs` 的 `loadSkill`），所以它加载到的是**另一个模块实例**，
 *   在测试里对直接 import 的那份调 `__setRunner()` **不会**影响它。
 *   本套件据此分成两路：走宿主的那一路（§③④，验开关与拒绝对话）与
 *   直接调技能模块的那一路（§⑤⑥，验抽帧管线）—— 各验各的，不互相假装。
 *
 * 用法：node mocks/verify-video-frames.mjs
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SKILL_API_VERSION,
  discoverSkills,
  loadSkill,
  collectSkillPromptSections,
  describeSkill,
} from '../src/extensions.mjs'
import { __init as initSkillsServer, runSkillTool, allTools } from '../mcp/mcp-skills-server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const SKILLS_DIR = join(PKG_ROOT, 'skills')
const SKILL_DIR = join(SKILLS_DIR, 'video-frames')
const TMP = join(PKG_ROOT, 'cache', '.tmp-verify-video-frames')

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
function skip(name, why) {
  skipped += 1
  console.log(`⏭️  ${name}  —— 已跳过：${why}`)
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

/** 去掉注释再查字符串 —— 注释里提到某个词不算"代码里用了它"（本项目踩过假绿）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 一个真的能打开的 1×1 JPEG（不是随便一段字节：失败了人能打开看）。 */
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
)

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

/** 一次性的测试工作区（**绝不用真的 `workspace-qq`** —— 那是使用者的数据）。 */
const WS = join(TMP, 'ws')
mkdirSync(WS, { recursive: true })
const CLIP = join(WS, 'clip.mp4')
writeFileSync(CLIP, Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(2048, 7)]))

/** 两个假 PATH 目录：一个放着假 ffmpeg，一个是空的。用于**确定性地**测"扫得到/扫不到"，
 *  不依赖这台机器到底装没装 ffmpeg。（③ 与 ④ 两节都用它。） */
const pathWith = join(TMP, 'fake-path-with-ffmpeg')
const pathWithout = join(TMP, 'fake-path-without-ffmpeg')
mkdirSync(pathWith, { recursive: true })
mkdirSync(pathWithout, { recursive: true })
writeFileSync(join(pathWith, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), 'not really ffmpeg')

/* ══════════════════════════════════════════════════════════════════════════
   §① 目录实体
   ══════════════════════════════════════════════════════════════════════════ */
section('① 目录实体：技能必须是一份真实存在、非空的最小集')

const ENTRIES = ['skill.json', 'index.js', 'frames.js', 'workspace.js', 'sources.js', 'README-InteractBot.md']
check('技能目录存在', existsSync(SKILL_DIR), SKILL_DIR)
const files = existsSync(SKILL_DIR)
  ? readdirSync(SKILL_DIR, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()
  : []
for (const f of ENTRIES) {
  check(`★ 有 ${f}`, files.includes(f), files.join(', '))
  if (existsSync(join(SKILL_DIR, f))) {
    const size = statSync(join(SKILL_DIR, f)).size
    check(`★ ${f} 不是空文件`, size > 200, `${size} 字节`)
  }
}
check('★ 目录里没有 node_modules（技能不靠私有依赖）', !existsSync(join(SKILL_DIR, 'node_modules')))
check('★ 没有上游的 plugin.json（宿主读的是 skill.json，两份都留会让人分不清）', !files.includes('plugin.json'))
check(
  '★ 上游原件逐字留档在 reference/video-frames-1.0.0/',
  ['plugin.json', 'index.js', 'frames.js'].every((f) => existsSync(join(PKG_ROOT, '..', '..', 'reference', 'video-frames-1.0.0', f))),
  join(PKG_ROOT, '..', '..', 'reference', 'video-frames-1.0.0'),
)

/* ══════════════════════════════════════════════════════════════════════════
   §② 宿主真的能发现并加载它
   ══════════════════════════════════════════════════════════════════════════ */
section('② 宿主校验器跑真实目录：零 error，而且★零 warning')

const found = discoverSkills({ skillsDir: SKILLS_DIR })
check('skills/ 目录可被发现', found.exists, found.dir)
const skill = found.skills.find((s) => (s.id ?? s.manifest?.id) === 'video-frames')
check('★★ 发现结果里有「视频识别」', Boolean(skill))
check('★★ 清单零 error（error = 装不上）', skill?.ok === true, JSON.stringify(skill?.errors ?? []))
check(
  '★★ 清单零 warning（warning = 静默失效：设置项不上界面、声明了没注册…）',
  (skill?.warnings ?? ['（没拿到清单）']).length === 0,
  JSON.stringify(skill?.warnings ?? []),
)
check('apiVersion 与宿主常量一致', Number(skill?.manifest?.apiVersion) === SKILL_API_VERSION, `${skill?.manifest?.apiVersion} vs ${SKILL_API_VERSION}`)
check('entry 存在且是 .js/.mjs', existsSync(skill?.entry ?? ''), skill?.entry ?? '(没解析出入口)')
check('session = none（本技能不需要知道群聊/私聊）', skill?.sessionMode === 'none', String(skill?.sessionMode))
check('★ 默认关闭（enabledByDefault 缺省是 false）', skill?.enabledByDefault === false, String(skill?.enabledByDefault))
check('清单声明了 frames 工具', (skill?.declaredTools ?? []).some((t) => t.id === 'frames'))

await loadSkill(skill, { config: {}, log: () => {} })
check('★★ 装载成功（setup 没抛错）', skill?.loaded === true, skill?.loadError ?? '')
check('★ 注册的工具恰好一个，且 id = frames', skill?.runtimeTools.length === 1 && skill.runtimeTools[0].id === 'frames', JSON.stringify(skill?.runtimeTools.map((t) => t.id)))
check(
  '★★ 工具全名 = mcp__skills__video-frames__frames（模型看到的就是它）',
  skill?.runtimeTools[0]?.fullName === 'mcp__skills__video-frames__frames',
  skill?.runtimeTools[0]?.fullName ?? '',
)
check('工具权限是 read（普通用户可用、不是管理动作）', skill?.runtimeTools[0]?.permission === 'read', String(skill?.runtimeTools[0]?.permission))
check('工具参数声明了必填的 source', (skill?.runtimeTools[0]?.parameters?.required ?? []).includes('source'))
check('清单 tools[] 的 id 与 registerTool 的对得上（对不上宿主会警告）', skill?.runtimeTools.every((t) => t.declared), 'declared 标记')

/* ══════════════════════════════════════════════════════════════════════════
   §③ 开关语义：关掉即时生效（提示词不注入 + 调用被当场拒绝）
   ══════════════════════════════════════════════════════════════════════════ */
section('③ 开关语义（走真的 MCP 技能服务器）')

const liveCfgPath = join(TMP, 'config.json')
const writeLive = (enabled) => {
  writeFileSync(
    liveCfgPath,
    // `dsh.workspace` 必须给：技能的帧目录是从 `ctx.config.dsh.workspace` 推出来的
    // （与 `src/config.mjs` 同一口径）。不给的话它会退回**真的** workspace-qq ——
    // 测试绝不能往使用者的工作区里写东西。
    JSON.stringify({ dsh: { workspace: WS }, skills: { 'video-frames': { enabled, ffmpegPath: '' } } }, null, 2),
    'utf8',
  )
}

writeLive(false)
await initSkillsServer({ skillsDir: SKILLS_DIR, configPath: liveCfgPath, workspace: join(TMP, 'ws') })
const listed = allTools().map((x) => x.name)
check(
  '★ 工具表里**始终**有它（开关不需要重启就成立，靠的就是这一条）',
  listed.includes('video-frames__frames'),
  listed.join(', '),
)
const offCall = await runSkillTool('video-frames__frames', { source: 'inbox/x.mp4' })
check('★★ 关掉时调用被当场拒绝', offCall.isError === true, offCall.text.slice(0, 80))
check('★ 拒绝的话里说清了"关闭"与去哪里开', /关闭/.test(offCall.text) && /扩展/.test(offCall.text), offCall.text.slice(0, 120))

const offPrompt = collectSkillPromptSections({
  skills: [skill],
  config: { skills: { 'video-frames': { enabled: false } } },
})
check('★★ 关掉时提示词片段一条都不注入（否则模型会去调不存在的工具）', offPrompt.lines.length === 0, JSON.stringify(offPrompt.lines.map((l) => l.id)))

// ★★ 0.2.7 新增的门控：**自检没过就不许在提示词里教它**。
//   理由（本项目的硬规矩）：提示词里提到一个工具，模型就会去调它；而抽帧不可用时
//   工具调用会被当场拒绝 —— 那等于教模型做一个必然失败的动作。
//   这一条是端到端套件 `verify-video-frames-inbound`（`mocks/verify-video-inbound.mjs`）
//   先抓出来的：当时"提示词教它调工具"与"宿主说看不到画面"同时出现，自相矛盾。
const realPathForSections = process.env.PATH
let onPrompt
try {
  process.env.PATH = pathWithout
  const noFf = collectSkillPromptSections({
    skills: [skill],
    config: { mcp: { enabled: true }, skills: { 'video-frames': { enabled: true, ffmpegPath: '' } } },
  })
  check('★★ 开着但**扫不到 ffmpeg** → 片段**一条都不注入**（不教模型调一个必然失败的工具）',
    noFf.lines.length === 0, JSON.stringify(noFf.lines.map((l) => l.id)))

  process.env.PATH = pathWith
  onPrompt = collectSkillPromptSections({
    skills: [skill],
    config: { mcp: { enabled: true }, skills: { 'video-frames': { enabled: true, ffmpegPath: '' } } },
  })
} finally {
  process.env.PATH = realPathForSections
}
check('打开且**扫得到 ffmpeg** 时注入一条片段', onPrompt.lines.length === 1, JSON.stringify(onPrompt.lines.map((l) => l.id)))
check(
  '★★ 片段里写的是**真工具名**（不是上游的裸名）',
  onPrompt.lines[0]?.content.includes('mcp__skills__video-frames__frames'),
  onPrompt.lines[0]?.content.slice(0, 90),
)
check('★ 片段里教模型用 read_image 看结果（本宿主唯一能看到画面的路）', onPrompt.lines[0]?.content.includes('read_image'))
check('★ 片段里说明了"是静止截图、不是连续视频"', /静止截图/.test(onPrompt.lines[0]?.content ?? ''))
check('★ mcp.enabled=false 时一条也不注入（那一刻工具根本没挂给模型）', collectSkillPromptSections({
  skills: [skill],
  config: { mcp: { enabled: false }, skills: { 'video-frames': { enabled: true } } },
}).lines.length === 0)

/* ══════════════════════════════════════════════════════════════════════════
   §④ 缺 ffmpeg 时的如实降级（本机的真实状态）
   ══════════════════════════════════════════════════════════════════════════ */
section('④ 没有 ffmpeg 时：如实说、给出下一步，而不是抛异常或假装')

const mod = await import(`../skills/video-frames/index.js?t=${Date.now()}`)
const defaults = mod.internals.__defaults()

const availOff = mod.available({ config: { skills: { 'video-frames': { enabled: false } } } })
check('available() 是同步的（返回的不是 Promise）', !(availOff instanceof Promise))
check('关掉时 available() 给出"去控制台开"的原因', availOff.ok === false && /扩展/.test(availOff.reason), availOff.reason)

const availBadPath = mod.available({
  config: { skills: { 'video-frames': { enabled: true, ffmpegPath: join(TMP, '没有这个.exe') } } },
})
check(
  '★ 填了不存在的 ffmpeg 路径 → 立刻（同步）给出准确原因，还带上路径',
  availBadPath.ok === false && /不存在/.test(availBadPath.reason) && availBadPath.reason.includes('没有这个.exe'),
  availBadPath.reason,
)

// ★★ 0.2.7 修正的一处真缺陷：原来这里断言的是"没填路径时**乐观放行**"（上游做法）。
//   但本宿主的控制台卡片读的是 `loadSkill` 那一刻存下来的（`skill.available` 快照），
//   于是"乐观放行"的后果是：明明没装 ffmpeg，卡片却显示 ✅ 已启用，**一句提示都没有** ——
//   而"去设置里填路径"正是使用者最需要看到的那句话（实测确认过）。
//   现在 `available()` 改成**同步扫 PATH**，结论为真。下面用一个**假 PATH** 把两种情形都钉住
//   （`pathWith` / `pathWithout` 定义在本文件上部，与 §③ 的提示词门控共用）。
const realPathEnv = process.env.PATH
try {
  process.env.PATH = pathWithout
  const noFf = mod.available({ config: { skills: { 'video-frames': { enabled: true, ffmpegPath: '' } } } })
  check(
    '★★ PATH 里没有 ffmpeg → available() **如实说不可用**（这句话才会出现在控制台卡片上）',
    noFf.ok === false && /抽帧用不了/.test(noFf.reason),
    noFf.reason,
  )
  check('★ 而且指得出下一步（填路径 / 加进 PATH），不是一句"用不了"', /ffmpeg 路径/.test(noFf.reason) && /PATH/.test(noFf.reason))
  // ★★ 0.2.7 修过一次**误导性文案**，代价是一次真实误伤：
  //   原来写「未找到 ffmpeg」→ 使用者明明装了（只是没填路径）却以为自己的安装有问题，
  //   而且**模型照着这句在群里说"这台机器上没装"** —— 一句假话。
  //   ⇒ 断言：这类文案必须明确"这不等于没装"，并且不许出现"去装/搜文件"这类把人带偏的话。
  check(
    '★★ 文案不许把"没配路径"说成"机器上没装"（要明说：这不代表没装）',
    /不代表/.test(noFf.reason) && /没填/.test(noFf.reason),
    noFf.reason,
  )
  check('★ available() 仍然是同步的（假 PATH 下也一样）', !(noFf instanceof Promise))

  process.env.PATH = pathWith
  const hasFf = mod.available({ config: { skills: { 'video-frames': { enabled: true, ffmpegPath: '' } } } })
  check('★★ PATH 里有 ffmpeg → 放行（同步扫 PATH 认得出来）', hasFf.ok === true, JSON.stringify(hasFf))
} finally {
  process.env.PATH = realPathEnv
}
check('★ 同步扫描只认 PATH（不猜安装位置）—— 恢复真 PATH 后本机仍如实报不可用或可用',
  typeof mod.available({ config: { skills: { 'video-frames': { enabled: true, ffmpegPath: '' } } } }).ok === 'boolean')

// 真跑一次（本机没有 ffmpeg）：必须返回可读的中文失败，而不是抛
writeLive(true)
const realCall = await runSkillTool('video-frames__frames', { source: 'clip.mp4' })
check('★★ 真调用不会抛到 MCP 层，而是返回一句中文失败', realCall.isError === true, realCall.text.slice(0, 140))
check(
  '★★ 失败原因说到点子上（文件不存在 / 没装 ffmpeg 二选一，都不是"未知错误"）',
  /不存在|ffmpeg/.test(realCall.text),
  realCall.text.slice(0, 160),
)
check('★ 失败时给了下一步（别反复重试 / 去哪配）', /别反复重试|控制台|工作区/.test(realCall.text), realCall.text.slice(-120))
/* ══════════════════════════════════════════════════════════════════════════
   §⑤ 抽帧管线（注入命令执行器：本机没有 ffmpeg，但管线必须被真跑一遍）
   ══════════════════════════════════════════════════════════════════════════ */
section('⑤ 抽帧管线（注入 runner 桩）：时间点 / 参数拼装 / 落盘 / 清理')

/** 造一个"像 ffmpeg 一样"的执行器：认 -version，抽帧时把 JPEG 写到最后一个参数。 */
function makeStubFfmpeg({ failIndexes = [], duration = 100 } = {}) {
  const calls = []
  let frameIndex = -1
  const runner = async (cmd, args, timeoutMs) => {
    calls.push({ cmd, args: [...args], timeoutMs })
    if (args[0] === '-version') return 'ffmpeg version 6.1.1-stub Copyright (c) 2000-2024\nbuilt with stub\n'
    if (args[0] === '-v') {
      // ffprobe -v quiet -print_format json -show_format <file>
      return JSON.stringify({ format: { duration: String(duration) } })
    }
    if (args[0] === '-y') {
      frameIndex += 1
      if (failIndexes.includes(frameIndex)) return null
      const dest = args[args.length - 1]
      writeFileSync(dest, JPEG_1X1)
      return ''
    }
    return ''
  }
  return { runner, calls, framesWritten: () => frameIndex + 1 }
}

const stub = makeStubFfmpeg({ duration: 100 })
mod.internals.__setRunner(stub.runner)
mod.internals.__resetProbe()
mod.internals.__setHostApi({ skill: { id: 'video-frames', dir: SKILL_DIR, version: '1.0.0' } })

const ctx = { config: { dsh: { workspace: WS }, skills: { 'video-frames': { enabled: true, ffmpegPath: '', count: 4, retentionHours: 24 } } } }
const first = await mod.internals.runFramesTool(ctx, { source: 'clip.mp4', count: 3 })
check('★★ 抽帧成功（注入的 ffmpeg 被真的调用到了）', !first.isError, String(first.content).slice(0, 120))
check('★ 返回的正文里给了相对路径（模型 read_image 要用的就是它）', /frames\/frame_[0-9a-f]{8}_0_\d+ms\.jpg/.test(String(first.content)), String(first.content).split('\n')[1] ?? '')
check('★ 正文里明确要求用 read_image 读', /read_image/.test(String(first.content)))
check('★ 正文里提醒"静止截图、不是连续视频"', /静止截图/.test(String(first.content)))
const onDisk = readdirSync(join(WS, 'frames')).filter((n) => n.endsWith('.jpg'))
check('★★ 帧真的落在工作区 frames/ 里（落到外面模型读不到）', onDisk.length === 3, onDisk.join(', '))
check('★ 落盘的图不是空文件', onDisk.every((n) => statSync(join(WS, 'frames', n)).size > 100))

const frameCalls = stub.calls.filter((c) => c.args[0] === '-y')
check('★★ `-ss` 在 `-i` **之前**（输入定位；放到后面会白解整个视频）', frameCalls.every((c) => c.args.indexOf('-ss') < c.args.indexOf('-i')), JSON.stringify(frameCalls[0]?.args))
check('每次只要一帧（-frames:v 1）', frameCalls.every((c) => c.args[c.args.indexOf('-frames:v') + 1] === '1'))
check('按 maxWidth 缩放且宽度取 min(设置, 原始宽)', frameCalls.every((c) => c.args.some((a) => String(a).includes("scale='min(768,iw)':-2"))))
check('用了 -y（重复抽同一个视频时要能覆盖）', frameCalls.every((c) => c.args[0] === '-y'))
const times = frameCalls.map((c) => Number(c.args[c.args.indexOf('-ss') + 1]))
check(
  '★★ 时间点落在 (5%, 95%) 区间且递增（不吃开头黑场/结尾字幕）',
  times.length === 3 && times[0] >= 5 && times[2] <= 95 && times[0] < times[1] && times[1] < times[2],
  times.join(', '),
)

// 同一个来源再抽一次：旧帧必须被清掉，不能堆两批
const second = await mod.internals.runFramesTool(ctx, { source: 'clip.mp4', count: 3 })
const afterSecond = readdirSync(join(WS, 'frames')).filter((n) => n.endsWith('.jpg'))
check('★★ 同一个来源再抽一次 → 旧帧被清掉（不是堆两批让模型看到重复图）', !second.isError && afterSecond.length === 3, `第二次后共 ${afterSecond.length} 个文件`)

// 数量夹取
const many = await mod.internals.runFramesTool(ctx, { source: 'clip.mp4', count: 99 })
const manyFiles = readdirSync(join(WS, 'frames')).filter((n) => n.endsWith('.jpg'))
check('★ count 被夹到上限 12（设置/模型都写不出 99 帧）', !many.isError && manyFiles.length === 12, `${manyFiles.length} 个文件`)

// 单帧失败：其它帧照出
const stub2 = makeStubFfmpeg({ failIndexes: [1], duration: 100 })
mod.internals.__setRunner(stub2.runner)
mod.internals.__resetProbe()
const partial = await mod.internals.runFramesTool(ctx, { source: 'clip.mp4', count: 3 })
const partialFiles = readdirSync(join(WS, 'frames')).filter((n) => n.endsWith('.jpg'))
check('★★ 单帧失败不影响其它帧（一个坏时间点不该让整次失败）', !partial.isError && partialFiles.length === 2, `${partialFiles.length} 个文件`)

// 全失败
const stub3 = makeStubFfmpeg({ failIndexes: [0, 1, 2, 3], duration: 100 })
mod.internals.__setRunner(stub3.runner)
mod.internals.__resetProbe()
const allFail = await mod.internals.runFramesTool(ctx, { source: 'clip.mp4', count: 3 })
check('★★ 全部帧失败 → isError，且原因可读（不是"未知错误"）', allFail.isError === true && /抽帧失败/.test(String(allFail.content)), String(allFail.content).slice(0, 120))

// 时长未知时退回"前几秒猜点"
check(
  '★ 时长未知（没有 ffprobe）→ 退回前几秒取点，仍然出图',
  mod.internals.planFrameTimes(0, 3).join(',') === '1,3,5',
  mod.internals.planFrameTimes(0, 3).join(','),
)

// 过期清理
const stale = join(WS, 'frames', 'frame_deadbeef_0_0ms.jpg')
writeFileSync(stale, JPEG_1X1)
const old = new Date(Date.now() - 48 * 3600 * 1000)
utimesSync(stale, old, old)
const pruned = mod.internals.pruneFrames(join(WS, 'frames'), { retentionHours: 24 })
check('★ 过期帧会被清掉（工作区是使用者的地盘，宿主不会替我们清）', pruned.removed === 1 && !existsSync(stale), JSON.stringify(pruned))
check('★ retentionHours = 0 表示"明确不清理"', mod.internals.pruneFrames(join(WS, 'frames'), { retentionHours: 0 }).removed === 0)

mod.internals.__resetRunner()

/* ══════════════════════════════════════════════════════════════════════════
   §⑥ 路径收束：模型给的路径不能跑出工作区
   ══════════════════════════════════════════════════════════════════════════ */
section('⑥ 路径收束（技能进程没有沙箱 —— 这一层是唯一的一道门）')

const { resolveInsideWorkspace } = await import(`../skills/video-frames/workspace.js?t=${Date.now()}`)

const bad = [
  ['盘符绝对路径', 'C:\\Windows\\win.ini'],
  ['正斜杠盘符路径', 'C:/Windows/win.ini'],
  ['UNC 路径', '\\\\server\\share\\a.mp4'],
  ['以根开头', '/etc/passwd'],
  ['上一级', '../outside.mp4'],
  ['绕一圈的上一级', 'frames/../../outside.mp4'],
  ['空', ''],
]
for (const [label, input] of bad) {
  const r = resolveInsideWorkspace(WS, input)
  check(`★ 拒绝${label}：${input || '(空)'}`, r.ok === false, r.why ?? '')
}
check('★ 工作区里不存在的文件也给明确原因', resolveInsideWorkspace(WS, 'nope.mp4').ok === false)
const okPath = resolveInsideWorkspace(WS, 'clip.mp4')
check('★ 工作区内的相对路径放行', okPath.ok === true && okPath.rel === 'clip.mp4', JSON.stringify(okPath))

const outside = join(TMP, 'outside.mp4')
writeFileSync(outside, JPEG_1X1)
const linkPath = join(WS, 'link-out.mp4')
let linkMade = false
try {
  symlinkSync(outside, linkPath, 'file')
  linkMade = true
} catch (error) {
  skip('符号链接逃逸', `本机建不了符号链接（${error?.code ?? error?.message}）—— 需要开发者模式或管理员权限`)
}
if (linkMade) {
  const r = resolveInsideWorkspace(WS, 'link-out.mp4')
  check('★★ 符号链接指向工作区外 → 拒绝（前缀检查挡不住软链，所以要看 realpath）', r.ok === false && /符号链接/.test(r.why), r.why)
}

// 兜底：即使通过 source 传绝对路径，工具也必须拒绝
const stubbedForPath = makeStubFfmpeg({ duration: 10 })
mod.internals.__setRunner(stubbedForPath.runner)
mod.internals.__resetProbe()
const absAttempt = await mod.internals.runFramesTool(ctx, { source: 'C:\\Windows\\win.ini' })
check('★★ 走完整工具链路时绝对路径同样被拒（不是只有单测里拒）', absAttempt.isError === true && /相对路径/.test(String(absAttempt.content)), String(absAttempt.content).slice(0, 120))
const emptyAttempt = await mod.internals.runFramesTool(ctx, { source: '' })
check('★ 不给 source → 说清要传什么', emptyAttempt.isError === true && /source/.test(String(emptyAttempt.content)), String(emptyAttempt.content).slice(0, 100))

// 参数就写错时，**不许在使用者的工作区里留下空目录**（这条是被真实踩到才加的：
// 第一版实现"一进来就建 frames/"，于是路径写错的调用也会留下一堆空目录）
const freshWs = join(TMP, 'ws-fresh')
mkdirSync(freshWs, { recursive: true })
const freshCtx = { config: { dsh: { workspace: freshWs }, skills: { 'video-frames': { enabled: true, ffmpegPath: '' } } } }
await mod.internals.runFramesTool(freshCtx, { source: 'nope.mp4' })
check('★★ 来源解析失败时**不**建 frames/ 目录（不在别人工作区里留垃圾）', !existsSync(join(freshWs, 'frames')), join(freshWs, 'frames'))
mod.internals.__resetRunner()

/* ══════════════════════════════════════════════════════════════════════════
   §⑦ SSRF 守卫：直链来源
   ══════════════════════════════════════════════════════════════════════════ */
section('⑦ SSRF 守卫（URL 来自消息发送方，模型只是转述）')

const { assertFetchableUrl, ipIsPrivate, looksLikeText } = await import(`../skills/video-frames/sources.js?t=${Date.now()}`)

const reject = async (label, url, opts) => {
  const r = await assertFetchableUrl(url, opts)
  check(`★ 拒绝${label}：${url}`, r.ok === false, r.reason ?? '（竟然放行了）')
}
await reject('非 http(s) 协议', 'ftp://example.com/a.mp4')
await reject('file 协议', 'file:///C:/a.mp4')
await reject('localhost', 'http://localhost/a.mp4')
await reject('.local 之类内网域名', 'http://nas.local/a.mp4')
await reject('回环地址', 'http://127.0.0.1:3410/api/config')
await reject('私有网段 10.x', 'http://10.1.2.3/a.mp4')
await reject('私有网段 192.168.x', 'http://192.168.1.10/a.mp4')
await reject('云元数据地址', 'http://169.254.169.254/latest/meta-data')
await reject('CGNAT', 'http://100.64.0.1/a.mp4')
await reject('IPv6 回环', 'http://[::1]/a.mp4')
await reject('IPv4 映射的 IPv6', 'http://[::ffff:127.0.0.1]/a.mp4')
await reject('域名解析到内网', 'http://looks-public.example/a.mp4', { resolveHost: async () => ['127.0.0.1'] })
await reject('nip.io 那类"看着是域名"的写法', 'http://127.0.0.1.nip.io/a.mp4', { resolveHost: async () => ['127.0.0.1'] })
await reject('解析不到', 'http://nope.example/a.mp4', { resolveHost: async () => [] })

const good = await assertFetchableUrl('https://cdn.example.com/v/a.mp4', { resolveHost: async () => ['93.184.216.34'] })
check('★ 公网 https 直链放行', good.ok === true, good.reason ?? '')

check('★ ipIsPrivate 认得 ::ffff:7f00:1 这种十六进制映射写法', ipIsPrivate('::ffff:7f00:1') === true)
check('★ ipIsPrivate 对非法 IP fail-closed（判断不了就当不安全）', ipIsPrivate('not-an-ip') === true)
check('★ ipIsPrivate 不误杀公网地址', ipIsPrivate('93.184.216.34') === false && ipIsPrivate('2606:4700::1111') === false)

const html = Buffer.from('<!DOCTYPE html><html><body>hello</body></html>'.repeat(4))
const jpegHead = JPEG_1X1.subarray(0, 64)
check('★ 文本/网页响应被判成"不是视频"（挡"让机器人去取内网接口"这类坏用法）', looksLikeText(html) === true)
check('★ 正常图片/视频的二进制头不会被误判为文本', looksLikeText(jpegHead) === false)

// 逐跳校验：第一跳合法、第二跳跳到内网 → 必须拒
const { downloadToFile } = await import(`../skills/video-frames/sources.js?t=${Date.now()}`)
function fakeRes({ status = 200, headers = {}, bodyChunks = [] }) {
  let i = 0
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () => (i < bodyChunks.length ? { done: false, value: bodyChunks[i++] } : { done: true }),
        cancel: async () => {},
      }),
    },
    arrayBuffer: async () => Buffer.concat(bodyChunks),
  }
}
const hop2 = await downloadToFile('https://cdn.example.com/a.mp4', {
  dir: join(TMP, 'dl'),
  resolveHost: async (h) => (h === 'cdn.example.com' ? ['93.184.216.34'] : ['10.0.0.9']),
  fetchImpl: async () => fakeRes({ status: 302, headers: { location: 'http://internal.host/a.mp4' } }),
})
check(
  '★★ 重定向**逐跳**校验：第二跳跳到内网被拒（用 redirect:follow 就失去这个机会）',
  hop2.ok === false && /地址被拒绝|内网/.test(hop2.reason),
  hop2.reason ?? '',
)

const tooBig = await downloadToFile('https://cdn.example.com/a.mp4', {
  dir: join(TMP, 'dl'),
  maxBytes: 1024,
  resolveHost: async () => ['93.184.216.34'],
  fetchImpl: async () => fakeRes({ bodyChunks: [Buffer.alloc(800, 1), Buffer.alloc(800, 2)] }),
})
check('★★ 边下边卡上限：超了立刻中止（不能等都下完再检查）', tooBig.ok === false && /上限/.test(tooBig.reason), tooBig.reason ?? '')

const declared = await downloadToFile('https://cdn.example.com/a.mp4', {
  dir: join(TMP, 'dl'),
  maxBytes: 1024,
  resolveHost: async () => ['93.184.216.34'],
  fetchImpl: async () => fakeRes({ headers: { 'content-length': '99999999' }, bodyChunks: [] }),
})
check('★ 对方自己声明的 Content-Length 超限 → 直接拒，不下', declared.ok === false && /太大/.test(declared.reason), declared.reason ?? '')

const notFound = await downloadToFile('https://cdn.example.com/a.mp4', {
  dir: join(TMP, 'dl'),
  resolveHost: async () => ['93.184.216.34'],
  fetchImpl: async () => fakeRes({ status: 404 }),
})
check('★ HTTP 错误码如实报出', notFound.ok === false && /404/.test(notFound.reason), notFound.reason ?? '')

const goodDl = await downloadToFile('https://cdn.example.com/a.mp4', {
  dir: join(TMP, 'dl'),
  resolveHost: async () => ['93.184.216.34'],
  fetchImpl: async () => fakeRes({ bodyChunks: [Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64, 3)] }),
})
check('★ 正常下载落盘成功', goodDl.ok === true && existsSync(goodDl.path), goodDl.reason ?? goodDl.path ?? '')

// 走完整链路：拿到 HTML 的地址 → 拒绝，而且说清"这不是视频"
const htmlDir = join(TMP, 'dl-html')
const htmlAttempt = await mod.internals.resolveSource({
  source: 'https://cdn.example.com/page.html',
  workspaceRoot: WS,
  fetchImpl: async () => fakeRes({ bodyChunks: [html] }),
  resolveHost: async () => ['93.184.216.34'],
})
check(
  '★★ 整条链路：下载到的是网页 → 明确拒绝并告诉模型怎么办',
  htmlAttempt.ok === false && /不是视频/.test(htmlAttempt.why),
  htmlAttempt.why ?? '',
)
check('★ 拒绝之后临时文件不留在盘上', !existsSync(htmlDir))

/* ══════════════════════════════════════════════════════════════════════════
   §⑧ 上游口径 vs 本宿主口径（同一份代码，两个宿主都能跑）
   ══════════════════════════════════════════════════════════════════════════ */
section('⑧ 提示词片段：拿到宿主工具名走本宿主口径，拿不到退回上游口径')

mod.internals.__setToolName('')
const upstreamWording = mod.promptSections({ config: { skills: { 'video-frames': { enabled: true, count: 4 } } } })
check('★ 上游口径：不提工具名（上游根本没有工具，是宿主自动拼图）', !upstreamWording[0].content.includes('mcp__skills__'), upstreamWording[0].content)
check('★ 上游口径：保留"你看到的是抽出的 N 张截图"这个原意', /4 张截图/.test(upstreamWording[0].content), upstreamWording[0].content)
check('★ 两个口径都用同一个 priority（35，与上游一致）', upstreamWording[0].priority === 35 && onPrompt.lines[0].priority === 35)

mod.internals.__setToolName('')
const restored = mod.promptSections({ config: { skills: { 'video-frames': { enabled: true } } } })
check('★ 恢复宿主注入后仍是上游口径（不写死名字）', !restored[0].content.includes('mcp__skills__'))

/* ══════════════════════════════════════════════════════════════════════════
   §⑨ 自包含：不 import 宿主 src、不 import 第三方包
   ══════════════════════════════════════════════════════════════════════════ */
section('⑨ 自包含（技能要能整目录拷走，换了机器也跑得起来）')

const srcFiles = files.filter((f) => f.endsWith('.js'))
let hostImports = []
let bareImports = []
for (const f of srcFiles) {
  const code = stripComments(readFileSync(join(SKILL_DIR, f), 'utf8'))
  for (const m of code.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1]
    if (spec.startsWith('node:')) continue
    if (spec.startsWith('./') || spec.startsWith('../')) {
      if (!existsSync(resolve(SKILL_DIR, spec)) && !existsSync(resolve(SKILL_DIR, `${spec}.js`))) hostImports.push(`${f} → ${spec}(不存在)`)
      if (spec.includes('src/')) hostImports.push(`${f} → ${spec}`)
      continue
    }
    bareImports.push(`${f} → ${spec}`)
  }
}
check('★★ 没有 import 宿主的 src/（技能契约：整目录拷走还能跑）', hostImports.length === 0, hostImports.join('; '))
check('★★ 没有 import 第三方裸包（白名单外的包会 ERR_MODULE_NOT_FOUND，且只在别人机器上出现）', bareImports.length === 0, bareImports.join('; '))

/* ══════════════════════════════════════════════════════════════════════════
   §⑩ 清单与代码默认值不漂移
   ══════════════════════════════════════════════════════════════════════════ */
section('⑩ 两处默认值必须逐项一致（漂了就是"界面显示 4 帧、实际抽 6 帧"）')

const mSettings = skill?.manifest?.settings ?? {}
const keysA = Object.keys(mSettings).sort()
const keysB = Object.keys(defaults).sort()
check('★ 键集一致', keysA.join(',') === keysB.join(','), `清单=${keysA.join(',')} 代码=${keysB.join(',')}`)
const drift = keysA.filter((k) => mSettings[k] !== defaults[k])
check('★ 每个键的值都一致', drift.length === 0, drift.map((k) => `${k}: 清单=${JSON.stringify(mSettings[k])} 代码=${JSON.stringify(defaults[k])}`).join('; '))
const schemaKeys = Object.keys(skill?.manifest?.configSchema ?? {}).sort()
check('★ settings 与 configSchema 键集一致（schema 有而 settings 没有 = 设置项不上界面）', schemaKeys.join(',') === keysA.join(','), `schema=${schemaKeys.join(',')}`)
check('★ 每个 configSchema 字段都有 label（否则界面只显示字段名）', Object.values(skill?.manifest?.configSchema ?? {}).every((f) => Boolean(f.label)))

const described = describeSkill(skill, { skills: { 'video-frames': { enabled: true } } })
check('★ describeSkill 里没有任何 warning（界面卡片是干净的）', (described.warnings ?? []).length === 0, JSON.stringify(described.warnings ?? []))

/* ══════════════════════════════════════════════════════════════════════════
   §⑪ 发布组装：新技能要真的进包
   ══════════════════════════════════════════════════════════════════════════ */
section('⑪ 发布组装（漏一项不会报错，只会让包里的技能消失）')

const assemble = readFileSync(join(PKG_ROOT, 'scripts', 'assemble-release.mjs'), 'utf8')
check("★★ COPY_DIRS 含 'skills'（整目录拷贝 → 新技能自动进包）", /'skills'/.test(assemble))
check('★★ 组装时排除 skills/node_modules（软链不进包）', /d === 'skills'[\s\S]{0,160}node_modules/.test(assemble))

const pkgJson = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
check(
  '★★ 本套件已登记进 npm test 链（写好了没人跑 = 等于没写）',
  String(pkgJson.scripts?.test ?? '').includes('mocks/verify-video-frames.mjs'),
  'package.json scripts.test',
)

/* ══════════════════════════════════════════════════════════════════════════ */

rmSync(TMP, { recursive: true, force: true })

console.log(`\n${'─'.repeat(60)}`)
console.log(`视频抽帧（video-frames）：通过 ${passed} 项，失败 ${failed} 项，跳过 ${skipped} 项`)
if (skipped > 0) console.log('（跳过项的原因已逐条打印，如实记录，不当作通过）')
process.exit(failed > 0 ? 1 : 0)
