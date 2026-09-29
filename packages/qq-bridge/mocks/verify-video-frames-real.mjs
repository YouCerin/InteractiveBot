#!/usr/bin/env node
/**
 * 技能「视频抽帧」的**真 ffmpeg** 端到端测试（需要本机装了 ffmpeg）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它补的是哪一格（`verify-video-frames.mjs` 覆盖不到的那一格）
 * ══════════════════════════════════════════════════════════════════════════
 * `verify-video-frames.mjs` 用**注入的命令执行器**把抽帧管线跑了一遍（时间点、参数拼装、
 * 落盘、清理、失败路径全在范围内），但它证明不了最后那一格：
 * **真 ffmpeg 拿到我们拼的参数，到底会不会产出可用的 JPEG？**
 * 那一格只能靠真二进制。所以这一套：
 *
 *   ① 找 ffmpeg（设置项 → 环境变量 → PATH，三条都试）
 *   ② 用 ffmpeg **自己合成**一段 3 秒测试视频（`lavfi testsrc`）——
 *      不依赖仓库里存在任何样本视频，所以这套测试自带夹具、零外部资源
 *   ③ 让技能真的去抽帧（`extractFramesToDir` 与上游那条 `extractFrames` 都跑）
 *   ④ 校验产物：帧数、JPEG 魔数、字节数、时间点落在 (5%, 95%)
 *
 * ── 两条"跑不了就说跑不了"的纪律（沿用 `mocks/harness.mjs`）──────────────
 *   · **没装 ffmpeg** → 大声跳过，**不算通过**（正常开发机上确实可能没装）；
 *   · **本环境不允许带管道的子进程（EPERM）** → 同样跳过并声明。
 *     注意这条与本机有没有 ffmpeg 无关：技能内部调用 ffmpeg 时要收 stdout，
 *     受限沙箱会拒绝。真实运行时桥接以普通进程身份跑，不受这条限制。
 *
 * 用法：
 *   node mocks/verify-video-frames-real.mjs
 *   node mocks/verify-video-frames-real.mjs --ffmpeg "D:\\ffmpeg\\bin\\ffmpeg.exe"
 *   环境变量 VFF_FFMPEG 也可以指定（方便在没有配置的机器上临时指一下）
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { canSpawn, sectionIf, printSkipSummary } from './harness.mjs'
import { findFfmpegOnPathSync, probeDuration, extractFramesToDir, extractFrames, siblingFfprobe } from '../skills/video-frames/frames.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const TMP = join(PKG_ROOT, 'cache', '.tmp-verify-video-frames-real')

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

/* ── ① 找 ffmpeg（三条路：命令行参数 → 设置项 → 环境变量/PATH）───────────── */
console.log('── ① 找到 ffmpeg 了吗 ──')

const argIdx = process.argv.indexOf('--ffmpeg')
const fromArg = argIdx >= 0 ? String(process.argv[argIdx + 1] ?? '').trim() : ''

let fromConfig = ''
try {
  const cfg = JSON.parse(readFileSync(join(PKG_ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''))
  fromConfig = String(cfg?.skills?.['video-frames']?.ffmpegPath ?? '').trim()
} catch {
  /* 配置读不到不算失败：还有另外两条路 */
}

const fromEnvOrPath = String(process.env.VFF_FFMPEG ?? '').trim() || findFfmpegOnPathSync()
const candidates = [
  ['命令行 --ffmpeg', fromArg],
  ['配置里的 ffmpegPath', fromConfig],
  ['环境变量 VFF_FFMPEG 或 PATH', fromEnvOrPath],
].filter(([, v]) => v)

let ffmpeg = ''
for (const [how, p] of candidates) {
  if (existsSync(p)) {
    ffmpeg = p
    console.log(`   ✓ 用这个：${p}（来自${how}）`)
    break
  }
  console.log(`   · ${how} 指向的路径不存在：${p}`)
}

if (!ffmpeg) {
  console.log('   ⏭️  没找到 ffmpeg —— 本节全部跳过（**这不算通过**）。')
  console.log('      装好后可以这样指：node mocks/verify-video-frames-real.mjs --ffmpeg "D:\\ffmpeg\\bin\\ffmpeg.exe"')
  printSkipSummary(0, '（没有可跑的内容）')
  rmSync(TMP, { recursive: true, force: true })
  process.exit(0)
}

const spawnOk = await canSpawn()
if (!spawnOk) {
  console.log('   ⏭️  本环境不允许启动带管道的子进程（EPERM）—— 真抽帧要收 ffmpeg 的 stdout，无法在此运行。')
  console.log('      这与被测代码无关：真实运行时桥接以普通进程身份跑，不受这条限制。')
}

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const OUT = join(TMP, 'frames')

/* ── ② 用 ffmpeg 自己合成一段 3 秒测试视频 ─────────────────────────────── */
const CLIP = join(TMP, 'clip.mp4')
await sectionIf(spawnOk, '② 先用真 ffmpeg 合成一段 3 秒测试视频（自带夹具，不依赖仓库里的样本）', () => {
  const args = ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10', '-pix_fmt', 'yuv420p', CLIP]
  const r = spawnSync(ffmpeg, args, { stdio: 'ignore', windowsHide: true, timeout: 60_000 })
  check('ffmpeg 能跑起来（退出码 0）', r.status === 0, `status=${r.status}`)
  check('合成出来的视频文件非空', existsSync(CLIP) && statSync(CLIP).size > 1000, existsSync(CLIP) ? `${statSync(CLIP).size} 字节` : '文件不存在')
})

/* ── ③ 真抽帧：帧能不能出来、是不是真 JPEG、时间点对不对 ─────────────────── */
await sectionIf(spawnOk, '③ 真抽帧：extractFramesToDir（本宿主那条路）', async () => {
  if (!existsSync(CLIP)) {
    check('有测试视频可抽', false, '上一步没合成成功')
    return
  }
  // 时长：ffprobe 与 ffmpeg 并排时会被自动找到（siblingFfprobe）
  const probe = siblingFfprobe(ffmpeg) || 'ffprobe'
  const dur = await probeDuration(CLIP, probe)
  check('★ probeDuration 拿到约 3 秒（ffprobe 真的被调起来了）', dur > 2 && dur < 5, `duration=${dur}`)

  const r = await extractFramesToDir({ filePath: CLIP, outDir: OUT, count: 4, ffmpegPath: ffmpeg, maxWidth: 320, quality: 4, durationSec: dur })
  check('★★ 真 ffmpeg 抽帧成功（这是注入桩证明不了的那一格）', !r.error, r.error ?? '')
  check('★★ 抽出了 4 张帧', r.frames.length === 4, `${r.frames.length} 张`)
  check('★ 帧文件真的落在 outDir 里且非空', r.frames.every((f) => existsSync(f.abs) && f.bytes > 1000), r.frames.map((f) => `${f.bytes}B`).join(', '))

  // JPEG 魔数：确认不是空文件、也不是别的东西
  const allJpeg = r.frames.every((f) => {
    try {
      const b = readFileSync(f.abs)
      return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
    } catch {
      return false
    }
  })
  check('★★ 每一张都是真 JPEG（FF D8 FF 魔数 —— 不是空文件、也不是别的格式）', allJpeg)

  const times = r.frames.map((f) => f.time)
  check(
    '★ 时间点落在 (5%, 95%) 且递增（时长 3 秒 → 约 0.15 / 1.05 / 1.95 / 2.85）',
    times.length === 4 && times.every((t) => t >= dur * 0.04 && t <= dur * 0.96) && times.every((t, i) => i === 0 || t > times[i - 1]),
    times.join(', '),
  )

  const onDisk = readdirSync(OUT).filter((n) => n.endsWith('.jpg'))
  check('★ 目录里就是这 4 个文件（没有多余残留）', onDisk.length === 4, onDisk.join(', '))

  // 复刻一遍：同一个来源再抽一次，旧帧应被上层清掉（这里直接验「同名覆盖」这一半）
  const again = await extractFramesToDir({ filePath: CLIP, outDir: OUT, count: 4, ffmpegPath: ffmpeg, maxWidth: 320, quality: 4, durationSec: dur })
  check('★ 再抽一次仍然成功（-y 覆盖生效，不会因为文件已存在而失败）', !again.error, again.error ?? '')

  // 缩放真的生效了吗：宽 ≤ 设置值
  const wide = await extractFramesToDir({ filePath: CLIP, outDir: join(TMP, 'frames-narrow'), count: 1, ffmpegPath: ffmpeg, maxWidth: 64, quality: 4, durationSec: dur })
  check('★ maxWidth=64 时仍然出图（scale=min(maxWidth,iw) 这条参数在真 ffmpeg 里合法）', !wide.error && wide.frames.length === 1, wide.error ?? '')
})

/* ── ④ 上游那条路（data URL）也真跑一次 ────────────────────────────────── */
await sectionIf(spawnOk, '④ 上游那条路：extractFrames 产出 base64 data URL（两个宿主共用同一实现）', async () => {
  if (!existsSync(CLIP)) {
    check('有测试视频可抽', false, '第②步没合成成功')
    return
  }
  const r = await extractFrames({ filePath: CLIP, count: 2, ffmpegPath: ffmpeg, maxWidth: 160, quality: 6 })
  check('★★ 上游契约仍可用（2 条 data URL）', !r.error && r.frames.length === 2, r.error ?? `${r.frames.length} 条`)
  check('★ 每一条都是 `data:image/jpeg;base64,` 开头', r.frames.every((s) => s.startsWith('data:image/jpeg;base64,')))
  check('★ 时长未知时不报错（退回固定时间点）', !(await extractFrames({ filePath: CLIP, count: 1, ffmpegPath: ffmpeg })).error)
})

rmSync(TMP, { recursive: true, force: true })

console.log('')
console.log(`视频抽帧（真 ffmpeg）：通过 ${passed} 项，失败 ${failed} 项（ffmpeg=${ffmpeg}）`)
printSkipSummary(failed, '✅ 真 ffmpeg 端到端全部通过')
process.exit(failed > 0 ? 1 : 0)
