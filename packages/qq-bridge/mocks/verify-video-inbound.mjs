/**
 * QQ 视频入站**端到端**测试（0.2.7，方案 A）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这一层
 * ══════════════════════════════════════════════════════════════════════════
 * 这条链路上有三个各自独立的层，而**每一层单独看都可能是对的**：
 *
 *   ① `src/text.mjs`：视频段的 `data.url` 有没有被带出来？（以前是原地丢弃）
 *      → 由 `verify-units.mjs` 的「视频入站」一节钉住。
 *   ② `src/channel-prompt.mjs`：拿到直链后该怎么跟模型说、不可用时该怎么说？
 *      → 也由 `verify-units.mjs` 钉住（它是纯函数，传参就能测）。
 *   ③ **`src/bridge.mjs` 的门控**：技能开没开、QQ 工具总开关开没开、自检过没过 ——
 *      这三件事只有桥接知道，而它们决定"提示词里到底提不提那个工具名"。
 *      ← **这一层只有真的跑一遍桥接才能验**，也就是本文件。
 *
 * ③ 为什么值得单独一套：它的失败形态是**静默的**。技能没开却还在提示词里写
 * "用 mcp__skills__video-frames__frames 抽帧"，模型就会去调一个不存在的工具，
 * 然后对用户说"我抽不出来"——而这**不会有任何报错**。本项目最忌讳这类东西。
 *
 * 用法：node mocks/verify-video-inbound.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Bridge } from '../src/bridge.mjs'
import { SendQueue } from '../src/onebot.mjs'
import { SessionRouter } from '../src/session-bridge.mjs'
import { discoverSkills, loadSkill } from '../src/extensions.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const SKILLS_DIR = join(PKG_ROOT, 'skills')

const ADMIN = '100000001'
const GROUP = '700000001'
const BOT = '200000001'
const VIDEO_URL = 'https://cdn.example.com/qq/v/abc.mp4?rkey=deadbeef&t=123'

let passed = 0
let failed = 0
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

/** 造一个临时工作区（收尾只删这个，绝不删整个 tmp）。 */
const tmpDirs = []
const liveBridges = []

/**
 * 装载真实的「视频抽帧」技能对象（`--extensions` 用的就是这套加载器）。
 * 桥接的门控读的是 `skill.id` / `skill.module.available` / `skill.runtimeTools`，
 * 所以必须走**真实的装载路径**，不能手搓一个假对象。
 */
async function loadVideoFramesSkill(config) {
  const scan = discoverSkills({ skillsDir: SKILLS_DIR })
  const skill = scan.skills.find((s) => s.id === 'video-frames')
  if (!skill) throw new Error('没有找到 video-frames 技能（skills/video-frames/skill.json）')
  await loadSkill(skill, { config, log: () => {} })
  return skill
}

function makeBridge({ skills = [], configPatch = {} } = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'video-inbound-'))
  tmpDirs.push(ws)

  const config = {
    dsh: { workspace: ws, permissionMode: 'workspace-write' },
    onebot: {},
    access: { adminUsers: [ADMIN], dmAllowlist: [], groupAllowlist: [GROUP] },
    trigger: { private: true, mention: true, keyword: true, groupEnabled: true, keywords: ['小鲸鱼'] },
    send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 100, maxPerHour: 1000, dedupeWindowMs: 0, maxCharsPerMessage: 1500 },
    turn: { timeoutMs: 5000 },
    humanize: { enabled: false, chunkChars: 300 },
    persona: { preset: 'none' },
    memory: { enabled: false },
    image: { enabled: false },
    mcp: { enabled: true },
    skills: {},
    ...configPatch,
  }

  const logs = []
  const log = (m) => logs.push(String(m))
  const router = new SessionRouter({ log: () => {} })
  let turn = 0
  const rpc = new EventTarget()
  rpc.prompts = []
  rpc.prompt = async (sessionId, contentBlocks) => {
    rpc.prompts.push(String(contentBlocks?.[0]?.text ?? ''))
    const text = '好的'
    turn += 1
    router.handleEvent(sessionId, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text }] } },
    })
    router.handleEvent(sessionId, { type: 'turn/end', data: { reason: 'completed' } })
    return { messageId: `m${turn}` }
  }
  rpc.cancel = async () => {}

  const sent = []
  const onebot = {
    selfId: BOT,
    send: async (kind, peerId, text, opts) => {
      sent.push({ kind, peerId, text: String(text ?? ''), ...(opts ?? {}) })
      return { status: 'ok' }
    },
    call: async () => ({ status: 'ok', data: {} }),
  }

  const sendQueue = new SendQueue({ ...config.send, log })
  const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, log, skills })
  liveBridges.push(bridge)
  return { bridge, rpc, sent, logs, config, ws }
}

/** 一条"@ 了机器人 + 带一个视频段"的群消息（与真实 OneBot 事件同形状）。 */
const groupVideoMsg = (messageId = 90001) => ({
  post_type: 'message',
  message_type: 'group',
  message_id: messageId,
  self_id: Number(BOT),
  group_id: Number(GROUP),
  user_id: Number(ADMIN),
  raw_message: `[CQ:at,qq=${BOT}] 看看这个视频`,
  // ★ 视频段的形状照抄 SnowLuma 给的（`snowluma/index.mjs` 的 video.toSegment）：
  //   `{ type:'video', data:{ file, url } }`，url 是带 rkey 的直链。
  message: [
    { type: 'at', data: { qq: String(BOT) } },
    { type: 'text', data: { text: ' 看看这个视频' } },
    { type: 'video', data: { file: 'abc.mp4', url: VIDEO_URL } },
  ],
  time: Math.floor(Date.now() / 1000),
})

/* ══════════════════════════════════════════════════════════════════════════
   ① 技能可用：提示词要把"直链 + 真工具名"交给模型
   ══════════════════════════════════════════════════════════════════════════ */
section('① 抽帧可用时：把直链和真工具名教给模型')

{
  // 让自检**确定性地**通过：设置里填一个**真实存在**的路径。
  // （`available()` 对"填了路径"这条分支是同步判存在 —— 不依赖这台机器装没装 ffmpeg。）
  const probe = makeBridge()
  const fakeFfmpeg = join(probe.ws, 'ffmpeg.exe')
  writeFileSync(fakeFfmpeg, 'stub')
  const config = {
    ...probe.config,
    skills: { 'video-frames': { enabled: true, ffmpegPath: fakeFfmpeg } },
  }
  const skill = await loadVideoFramesSkill(config)
  const t = makeBridge({ skills: [skill], configPatch: { skills: config.skills } })
  // 上面的 probe 只是用来占一个工作区拿路径，真正跑的是 t
  t.config.dsh.workspace = probe.ws

  await t.bridge.handleEvent(groupVideoMsg())

  check('★ 桥接真的走完了一轮（拿到了给模型的提示词）', t.rpc.prompts.length === 1, `${t.rpc.prompts.length} 条`)
  const prompt = t.rpc.prompts[0] ?? ''
  check('★★ 提示词里给出了**视频直链**（模型要拿它当 source）', prompt.includes(VIDEO_URL))
  check('★★ 提示词里给出了**真工具名**（由 skillToolFullName 拼，不是写死的）',
    prompt.includes('mcp__skills__video-frames__frames'))
  check('★ 明确要求抽帧后用 read_image 读那些图', /read_image/.test(prompt))
  check('★ 如实说"视频本身喂不进模型"', /喂不进/.test(prompt))
  check('★ 正文里仍然有 `[视频]` 占位符（渲染层没被改坏）', prompt.includes('[视频]'))
  check('★ 不可用那套话术**没有**出现（可用时不许同时说"看不到画面"）', !/当前看不到画面/.test(prompt))
}

/* ══════════════════════════════════════════════════════════════════════════
   ② 技能关着：一个字都不许提工具名，但要如实说"看不到画面"
   ══════════════════════════════════════════════════════════════════════════ */
section('② 技能关着：不许提工具名，但要如实说看不到画面')

{
  const skillsCfg = { 'video-frames': { enabled: false, ffmpegPath: '' } }
  const skill = await loadVideoFramesSkill({ skills: skillsCfg })
  const t = makeBridge({ skills: [skill], configPatch: { skills: skillsCfg } })
  await t.bridge.handleEvent(groupVideoMsg(90002))
  const prompt = t.rpc.prompts[0] ?? ''
  check('★★ 关着时**绝不出现工具名**（否则模型会去调一个不存在的工具）',
    !prompt.includes('video-frames'), '')
  check('★★ 关着时如实说"有视频但当前看不到画面"', /含 1 个视频/.test(prompt) && /当前看不到画面/.test(prompt))
  check('★ 而且给出原因（是"没启用"，不是一句含糊的"不可用"）', /没有启用/.test(prompt))
  check('★ 并明确"不要凭有视频猜内容"（防幻觉）', /不要凭/.test(prompt))
  check('★ 仍然不把直链塞进提示词（省 token，也不给一条走不通的路）', !prompt.includes(VIDEO_URL))
}

/* ══════════════════════════════════════════════════════════════════════════
   ③ QQ 工具总开关关着：技能工具根本没挂给模型 —— 同样不许提
   ══════════════════════════════════════════════════════════════════════════ */
section('③ mcp.enabled=false：技能工具没挂给模型，同样不许提')

{
  const fakeWs = mkdtempSync(join(tmpdir(), 'video-inbound-'))
  tmpDirs.push(fakeWs)
  const fakeFfmpeg = join(fakeWs, 'ffmpeg.exe')
  writeFileSync(fakeFfmpeg, 'stub')
  const skillsCfg = { 'video-frames': { enabled: true, ffmpegPath: fakeFfmpeg } }
  const skill = await loadVideoFramesSkill({ skills: skillsCfg })
  const t = makeBridge({ skills: [skill], configPatch: { skills: skillsCfg, mcp: { enabled: false } } })
  await t.bridge.handleEvent(groupVideoMsg(90003))
  const prompt = t.rpc.prompts[0] ?? ''
  check('★★ 总开关关着时**绝不出现工具名**（那一刻它真的不存在）', !prompt.includes('video-frames'))
  check('★ 如实说看不到画面，并点出是总开关的原因', /当前看不到画面/.test(prompt) && /mcp\.enabled|总开关/.test(prompt))
}

/* ══════════════════════════════════════════════════════════════════════════
   ④ 技能开着但 ffmpeg 路径是错的：说清"哪里不对"，而不是笼统不可用
   ══════════════════════════════════════════════════════════════════════════ */
section('④ 技能开着但 ffmpeg 配错了：原因要具体（这一格最容易被写成含糊话）')

{
  const skillsCfg = { 'video-frames': { enabled: true, ffmpegPath: join(PKG_ROOT, 'cache', '绝对没有这个-ffmpeg.exe') } }
  const skill = await loadVideoFramesSkill({ skills: skillsCfg })
  const t = makeBridge({ skills: [skill], configPatch: { skills: skillsCfg } })
  await t.bridge.handleEvent(groupVideoMsg(90004))
  const prompt = t.rpc.prompts[0] ?? ''
  check('★★ 不出现工具名', !prompt.includes('video-frames'))
  check('★★ 原因具体到"路径不存在"（使用者照着就能改）', /不存在/.test(prompt) && prompt.includes('没有这个-ffmpeg.exe'), prompt.split('\n').find((l) => l.includes('看不到画面')) ?? '')
  check('★ 而且不许把"路径写错"说成"机器上没装"（这类误伤过一次）', !/没装/.test(prompt.replace(/不代表机器上没装/g, '')))
  check('★ 仍然提示"有视频"（不假装这条消息里什么都没有）', /含 1 个视频/.test(prompt))
}

/* ══════════════════════════════════════════════════════════════════════════
   ⑤ 没有视频段的消息：一个字都不该多
   ══════════════════════════════════════════════════════════════════════════ */
section('⑤ 普通消息不受影响（新段落是纯增量）')

{
  const t = makeBridge({ skills: [] })
  await t.bridge.handleEvent({
    ...groupVideoMsg(90005),
    message: [
      { type: 'at', data: { qq: String(BOT) } },
      { type: 'text', data: { text: ' 在吗' } },
    ],
  })
  const prompt = t.rpc.prompts[0] ?? ''
  check('★ 没有视频段 → 提示词里不提视频这件事', !/个视频/.test(prompt) && !prompt.includes('video-frames'))
  check('★ 而且这一轮照常走完（没被新代码弄挂）', t.rpc.prompts.length === 1)
}

/* ══════════════════════════════════════════════════════════════════════════ */

for (const b of liveBridges) {
  try {
    await b.close?.()
  } catch {
    /* 收尾失败不影响结论 */
  }
}
for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })

console.log('')
console.log(`QQ 视频入站（方案 A）：通过 ${passed} 项，失败 ${failed} 项`)
process.exit(failed > 0 ? 1 : 0)
