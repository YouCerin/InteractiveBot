/**
 * 表情包**判定**测试：三档配额 + 四层漏斗 + 打分。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这组断言为什么重要（不是"顺手写点测试"）
 * ══════════════════════════════════════════════════════════════════════════
 * 这个功能上线就是**真发**（用户明确不要影子模式）。而"发错图"是唯一
 * 用户当场能看到、无法解释、撤不回的后果。所以每一条否决都必须被钉住：
 *
 *   ① 硬否决不可绕过：报错/道歉/权限被拒/认真求助/正文太长 → 一定不发。
 *   ② 抽不出态度就不发：自主那条路径宁可漏发（这是它最难做对的地方）。
 *   ③ 模型要的标签库里没有 → 不发，**不拿别的图顶替**（顶替就是发错图）。
 *   ④ 低于阈值不发：绝不为"用上这个功能"而凑一张。
 *   ⑤ 配额三档都要生效：冷却、每 N 轮、每日上限、失败冷却。
 *   ⑥ 提示词只提**真有货**的标签（说了做不到是本项目最不能接受的一类问题）。
 *
 * 用法：node mocks/verify-sticker-decision.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodeZlib from 'node:zlib'
import {
  DEFAULT_SCORE_THRESHOLD,
  SINGLE_CHAR_SCORE,
  SUPPRESS_PAIRS,
  checkHardVeto,
  decideSticker,
  cueHitsInMessage,
  extractAttitude,
  pickBestSticker,
  renderStickerPersonaNote,
  renderStickerPrompt,
  renderStickerPromptLines,
  resolveStickerIntent,
  scoreStickerCandidate,
  toDecisionRecord,
} from '../src/sticker-decision.mjs'
import {
  DEFAULT_FREQUENCY,
  FAILURE_COOLDOWN_MS,
  FREQUENCY_PRESETS,
  checkStickerQuota,
  dailyCount,
  emptyUsage,
  readStickerUsage,
  recordStickerFailure,
  recordStickerSent,
  resolveFrequency,
} from '../src/sticker-quota.mjs'
import { MIN_USABLE_PER_LABEL, SAFE_SINGLE_CHAR_CUES, STICKER_LABELS, isAutoAllowedLabel, isFunctionalLabel, isRiskyLabel } from '../src/sticker-labels.mjs'
import { resetLabelCache } from '../src/sticker-vocab.mjs'
import {
  buildStickerSelection,
  importStickerFiles,
  isRiskyEntry,
  readStickerLibrary,
  writeStickerLibrary,
  applyStickerLabels,
} from '../src/sticker-library.mjs'
import { STICKER_LABEL_IDS } from '../src/sticker-labels.mjs'
import { scopeDirName } from '../src/sticker-library.mjs'
import { mkdirSync } from 'node:fs'

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

const root = mkdtempSync(join(tmpdir(), 'sticker-dec-'))

/**
 * 用**写死的出厂词表**跑一段断言，跑完恢复。
 *
 * ★★ 为什么需要它（实测踩到）：这一组断言测的是**出厂线索**的行为，
 *   但 `activeLabels()` 在**没有工作区**时会回落出厂表；一旦传入真实工作区，
 *   它读的是**用户那份词表** —— 而那份会随时变（改名、删标签、按轴清理例句）。
 *   用户按"轴三分类"清理之后，几条断言当场变红，**而代码其实是对的**：
 *   红的原因是它读了一份"业务上正确、但已与出厂表不同"的数据。
 *
 * ∴ 判据必须跟着**被测对象**走：测出厂行为，就把出厂表写成一份临时词表来跑。
 *   这样用户怎么改自己的词表都不会影响这组回归。
 *
 * @returns {{opts: object, restore: () => void}}
 */
function withFactoryVocab() {
  const ws = mkdtempSync(join(tmpdir(), 'sticker-factory-'))
  const dir = join(ws, 'stickers')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'labels.json'),
    JSON.stringify({
      version: 1,
      labels: STICKER_LABELS.map((l) => ({
        id: l.id,
        name: l.name,
        axis: l.axis,
        cues: [...(l.cues ?? [])],
        // ★ 两组线索都要带上（0.2.4 第十三轮起的 schema）——
        //   漏一个字段，客体类标签在这里就是"永不命中"，测试会给出假红。
        otherCues: [...(l.otherCues ?? [])],
        antiCues: [...(l.antiCues ?? [])],
        exclude: [...(l.exclude ?? [])],
        excludeOther: [...(l.excludeOther ?? [])],
        exclusive: [...(l.exclusive ?? [])],
      })),
    }),
    'utf8',
  )
  resetLabelCache()
  return {
    opts: { workspace: ws, dir: 'stickers' },
    restore: () => {
      resetLabelCache()
      rmSync(ws, { recursive: true, force: true })
    },
  }
}

const imgA = join(root, 'a.png')
const imgB = join(root, 'b.png')
writeFileSync(imgA, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
writeFileSync(imgB, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

/** 真 PNG（8×8，zlib 压过的）—— 导入要按**字节**判类型，所以假头不行。 */
function pngBytes(marker) {
  const crcTable = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    return t
  })()
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(8, 0)
  ihdr.writeUInt32BE(8, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(8 * 25)
  for (let y = 0; y < 8; y += 1) {
    const base = y * 25
    raw[base] = 0
    for (let x = 0; x < 8; x += 1) {
      raw[base + 1 + x * 3] = (40 + marker * 31 + x * 3) & 0xff
      raw[base + 2 + x * 3] = (60 + marker * 17 + y * 5) & 0xff
      raw[base + 3 + x * 3] = (200 - marker * 23) & 0xff
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', nodeZlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const cand = (file, primary, scopeRank, absPath, extra = {}) => ({
  scopeRank,
  absPath,
  entry: { file, primary, labels: [primary], usedCount: 0, ...extra },
})

// ══════════════════════════════════════════════════════════════════════════
section('① 三档频率：预设可被单独覆盖，非法值回落（不抛错）')
// ══════════════════════════════════════════════════════════════════════════
{
  const low = resolveFrequency({ frequency: 'low' })
  const mid = resolveFrequency({ frequency: 'medium' })
  const high = resolveFrequency({ frequency: 'high' })
  check('default 档是 medium（用户选定）', DEFAULT_FREQUENCY === 'medium')
  check('三档的间隔是递增的（保守 ≥ 中 ≥ 高）', low.minGapMs > mid.minGapMs && mid.minGapMs > high.minGapMs,
    `${low.minGapMs}/${mid.minGapMs}/${high.minGapMs}`)
  check('三档的每日上限是递增的', low.dailyLimit < mid.dailyLimit && mid.dailyLimit < high.dailyLimit)
  check('medium：每 2 轮 1 次 / 30 秒 / 1 张每轮 / 80 张每日',
    mid.everyTurns === 2 && mid.minGapMs === 30_000 && mid.maxPerTurn === 1 && mid.dailyLimit === 80,
    JSON.stringify(mid))

  const custom = resolveFrequency({ frequency: 'medium', minGapMs: 90_000 })
  check('显式数值覆盖预设（其余仍取预设）', custom.minGapMs === 90_000 && custom.everyTurns === 2, JSON.stringify(custom))

  const bogus = resolveFrequency({ frequency: '狂暴', minGapMs: 'x', everyTurns: -3 })
  check('★ 非法档位回落 medium（不抛错）', bogus.level === 'medium' && bogus.explicit === false, JSON.stringify(bogus))
  check('★ 非法数值回落预设', bogus.minGapMs === FREQUENCY_PRESETS.medium.minGapMs && bogus.everyTurns === 2)
}

// ══════════════════════════════════════════════════════════════════════════
section('② 配额：失败冷却 > 最小间隔 > 每 N 轮 > 每日上限 > 同图冷却')
// ══════════════════════════════════════════════════════════════════════════
{
  const now = Date.parse('2026-03-01T12:00:00Z')
  const quota = resolveFrequency({ frequency: 'medium' })
  const clean = emptyUsage()
  check('★ 空台账 → 放行', checkStickerQuota({ usage: clean, scope: 'group-1', now, quota, turnCount: 2, rel: 'x' }).ok)

  // ★ 夹具里的作用域键**算出来**而不是写死：写死 `chat-group-1` 时，
  //   一旦 `scopeDirName` 的换算规则变了（0.2.4 就变过一次），
  //   这些夹具会全部查不到自己的槽位 → 配额看起来"永远放行"，
  //   于是 7 条断言同时变成假绿/假红。用同一口径生成就不会再有这种漂移。
  const SLOT = scopeDirName('group-1')
  const slot = (over = {}) => ({
    scopes: { [SLOT]: { day: '2026-03-01', count: 0, sentAt: [], images: {}, failures: [], ...over } },
  })

  const fresh = slot({ count: 0, sentAt: [now - 5_000] })
  const tooSoon = checkStickerQuota({ usage: fresh, scope: 'group-1', now, quota, turnCount: 2, rel: 'x' })
  check('★ 距上次 5 秒（下限 30 秒）→ 拦住并给出剩余等待',
    !tooSoon.ok && tooSoon.reason.includes('距上次') && tooSoon.waitMs > 0, JSON.stringify(tooSoon))

  const longAgo = slot({ count: 1, sentAt: [now - 120_000] })
  const oddTurn = checkStickerQuota({ usage: longAgo, scope: 'group-1', now, quota, turnCount: 3, rel: 'x' })
  check('★ medium 要求每 2 轮最多 1 次 → 第 3 轮拦住',
    !oddTurn.ok && oddTurn.reason.includes('每 2 轮'), JSON.stringify(oddTurn))
  check('第 4 轮（偶数）放行', checkStickerQuota({ usage: longAgo, scope: 'group-1', now, quota, turnCount: 4, rel: 'x' }).ok)

  const full = slot({ count: 80, sentAt: [now - 120_000] })
  const dailyHit = checkStickerQuota({ usage: full, scope: 'group-1', now, quota, turnCount: 4, rel: 'x' })
  check('★ 每日上限 80 到了 → 拦住', !dailyHit.ok && dailyHit.reason.includes('每日上限'), JSON.stringify(dailyHit))

  const failed = slot({ count: 1, sentAt: [now - 120_000], failures: [now - 10_000] })
  const cooled = checkStickerQuota({ usage: failed, scope: 'group-1', now, quota, turnCount: 4, rel: 'x' })
  check('★ 失败冷却（5 分钟）优先于其它判据',
    !cooled.ok && cooled.reason.includes('失败'), JSON.stringify(cooled))
  check('失败冷却时长是 5 分钟', FAILURE_COOLDOWN_MS === 5 * 60 * 1000, String(FAILURE_COOLDOWN_MS))

  // 失败冷却到期后放行
  const expired = slot({ count: 1, sentAt: [now - 600_000], failures: [now - FAILURE_COOLDOWN_MS - 1000] })
  check('冷却到期 → 放行', checkStickerQuota({ usage: expired, scope: 'group-1', now, quota, turnCount: 4, rel: 'x' }).ok)

  const sameImg = slot({ count: 1, sentAt: [now - 600_000], images: { 'g/x.png': now - 60_000 } })
  const sameHit = checkStickerQuota({ usage: sameImg, scope: 'group-1', now, quota, turnCount: 4, rel: 'g/x.png' })
  check('★ 同一张图 30 分钟内不许复用', !sameHit.ok && sameHit.reason.includes('这张图'), JSON.stringify(sameHit))

  check('每日计数跨天归零（只读、不写盘）',
    dailyCount({ scopes: { [SLOT]: { day: '2026-02-28', count: 77 } } }, 'group-1', now) === 0)
  check('★ 作用域隔离：A 群的计数不影响 B 群',
    dailyCount(full, 'group-2', now) === 0 && dailyCount(full, 'group-1', now) === 80,
    `${dailyCount(full, 'group-2', now)} / ${dailyCount(full, 'group-1', now)}`)
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 落盘台账：重启不清零（否则每日上限等于没有）')
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = mkdtempSync(join(tmpdir(), 'sticker-usage-'))
  const t0 = Date.now()
  recordStickerSent({ workspace: ws, scope: 'group-1', rel: 'a.png', now: t0 })
  recordStickerSent({ workspace: ws, scope: 'group-1', rel: 'b.png', now: t0 + 1000 })
  recordStickerSent({ workspace: ws, scope: 'group-2', rel: 'a.png', now: t0 + 2000 })
  const usage = readStickerUsage({ workspace: ws })
  check('★ 计数写进了 usage.json（重启后还在）', dailyCount(usage, 'group-1', t0) === 2, String(dailyCount(usage, 'group-1', t0)))
  check('两个会话各自计数', dailyCount(usage, 'group-2', t0) === 1)

  recordStickerFailure({ workspace: ws, scope: 'group-1', rel: 'a.png', now: t0 + 3000 })
  const after = readStickerUsage({ workspace: ws })
  check('★ 失败**也算**消耗一次配额（宁可少发，不要因失败多试）',
    dailyCount(after, 'group-1', t0 + 3000) === 3, String(dailyCount(after, 'group-1', t0 + 3000)))
  check('失败后进入冷却', checkStickerQuota({
    usage: after, scope: 'group-1', now: t0 + 4000, quota: resolveFrequency({ frequency: 'high' }), turnCount: 1, rel: 'z.png',
  }).ok === false)

  // 成功一次会清掉失败冷却（说明通道已经好了）
  recordStickerSent({ workspace: ws, scope: 'group-1', rel: 'c.png', now: t0 + FAILURE_COOLDOWN_MS + 5000 })
  const healed = readStickerUsage({ workspace: ws })
  const q = checkStickerQuota({ usage: healed, scope: 'group-1', now: t0 + FAILURE_COOLDOWN_MS + 6000, quota: resolveFrequency({ frequency: 'high' }), turnCount: 1, rel: 'z.png' })
  check('成功一次后失败冷却被清掉（通道好了就该继续用）', !String(q.reason ?? '').includes('失败'), JSON.stringify(q))

  writeFileSync(join(ws, 'stickers', 'usage.json'), 'not json at all')
  check('★ usage.json 坏掉 → 重置为保守值，不抛错', dailyCount(readStickerUsage({ workspace: ws }), 'group-1', t0) === 0)
  rmSync(ws, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 态度抽取：抽不出就不发（自主路径最关键的一条）')
// ══════════════════════════════════════════════════════════════════════════
{
  // ★★ 这一节测的是**出厂词表的线索**，所以必须用**写死的出厂表**跑，不能读工作区里
  //    那份 —— 用户的词表会随时变化（改名、删标签、按轴清理例句）。
  //    实测踩到：用户按"轴三分类"清理了例句之后，这节里几条断言当场变红，
  //    而**代码其实是对的** —— 红的原因是它读了一份"业务上正确但已不同"的数据。
  //    判据要跟着**被测对象**走：测出厂行为就用出厂数据。
  const F = withFactoryVocab()
  try {
    check('★ 平铺直叙的正文 → null（不硬凑态度）', extractAttitude('我把配置改好了，重启一下就行。') === null)
    check('★★ 单字线索不会误伤普通正文（实测踩过：「就行」曾命中「行」→ deadpan）',
      extractAttitude('银行那边说的') === null && extractAttitude('同行都这么干') === null)
    check('★★ 短线索必须独立出现，不能粘在句子里（实测踩过：「运行一下就知道了」→ dismiss）',
      extractAttitude('运行一下就知道了') === null && extractAttitude('你试试看就知道了') === null)
    check('短线索独立出现仍然认（「知道了」「嗯」「哦」）',
      extractAttitude('知道了')?.id === 'dismiss' && extractAttitude('嗯')?.id === 'dismiss')
    // ★ 客体类（认知反应）的线索现在只在**对方发言**里认（轴的规则见 `AXIS_SIDE`）。
    //   ⚠️ 这里用「emmm」而不是单字「6」：对方消息那一侧的守卫是 **≥2 字**
    //   （`MIN_MESSAGE_CUE_CHARS`，防「早」误撞「早点休息」），单字线索**不参与**匹配。
    check('单字/短线索在对方那一侧的行为符合守卫（≥2 字才参与）',
      extractAttitude('行', F.opts, 'emmm')?.id === 'deadpan' &&
        cueHitsInMessage('6', '6') === false,
      JSON.stringify({ emmm: extractAttitude('行', F.opts, 'emmm')?.id, 单字6: cueHitsInMessage('6', '6') }))
    check('空正文 → null', extractAttitude('') === null && extractAttitude(null) === null)
    check('★ 线索表里没有的说法 → null（宁可漏发）', extractAttitude('这个函数的时间复杂度是 O(n log n)') === null)
    // ★ 轴的**三分类**（0.2.4 第十六轮）：客体类（认知反应/表态）只认**对方发言**，
    //   所以"bot 自己说确实/？？？"不再触发 —— 这几条要按新规则在对方那一侧验。
    check('★★ 客体类（表态）只认对方发言：「确实」是**对方说**才算 agree',
      extractAttitude('好', F.opts, '确实，你说的对')?.id === 'agree')
    check('★★ 客体类（认知反应）：对方说「？？？」才算 question-mark',
      extractAttitude('你再说一遍', F.opts, '？？？')?.id === 'question-mark')
    check('★★ 反过来：bot 自己说「确实」**不再**触发 agree（客体类不看自身发言）',
      extractAttitude('确实，你说的对', F.opts, '') === null)
    check('★ 混合类（被逗乐）两边都认：bot 自己说「哈哈哈」仍触发 laugh',
      extractAttitude('哈哈哈笑死我了', F.opts, '')?.id === 'laugh')
    check('★ 主体类（状态）只认自身发言：bot 说「算了，毁灭吧」触发 slack',
      extractAttitude('算了，毁灭吧', F.opts, '')?.id === 'slack')
    check('★★ 反过来：**对方**说「算了」不触发 slack（主体类不看对方发言）',
      extractAttitude('好', F.opts, '算了，毁灭吧')?.id !== 'slack',
      JSON.stringify(extractAttitude('好', F.opts, '算了，毁灭吧')))
  } finally {
    F.restore()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 硬否决：这几类场景永远不发表情（不可配置）')
// ══════════════════════════════════════════════════════════════════════════
{
  check('★ 认真求助（「怎么弄」）被否决', checkHardVeto('这个怎么弄啊，帮我看看')?.id === 'help-seeking')
  check('★ 道歉被否决', checkHardVeto('抱歉，是我搞错了')?.id === 'apology')
  check('★ 权限被拒被否决', checkHardVeto('这个我做不了，只有管理员才能')?.id === 'permission')
  check('★ 超时/兜底话术被否决', checkHardVeto('（这次没有产生回复内容，请再试一次。）')?.id === 'error')
  check('★ 正文太长被否决（长回复配图很假）', checkHardVeto('好的'.repeat(100))?.id === 'too-long')
  check('正常短回复不被否决', checkHardVeto('哈哈哈那你也太惨了') === null)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ 两条触发：模型主动优先；标签必须真有图')
// ══════════════════════════════════════════════════════════════════════════
{
  const model = resolveStickerIntent({ requestedLabel: 'laugh', replyText: '随便什么' })
  check('模型主动 → source=model', model.source === 'model' && model.label === 'laugh')
  const invented = resolveStickerIntent({ requestedLabel: '狂笑', replyText: '哈哈哈' })
  check('★ 模型发明标签 → 丢掉（不猜），并且**不回落到自主**',
    invented.source === null && invented.label === null, JSON.stringify(invented))
  const auto = resolveStickerIntent({ requestedLabel: null, replyText: '哈哈哈笑死我了' })
  check('没写标签 → 自主抽态度', auto.source === 'auto' && auto.label === 'laugh')
  const none = resolveStickerIntent({ requestedLabel: null, replyText: '已改好，重启即可' })
  check('★ 抽不出态度 → 两条路都不触发（不发）', none.source === null)

  const cfg = { enabled: true, scoreThreshold: DEFAULT_SCORE_THRESHOLD }
  const cands = [cand('chat-1/laugh.png', 'laugh', 1, imgA)]
  const ok = decideSticker({ config: cfg, replyText: '哈哈哈', requestedLabel: 'laugh', candidates: cands, usage: emptyUsage(), scope: 'group-1', turnCount: 2 })
  check('★ 模型要的标签有图 → 发', ok.action === 'send' && ok.rel === 'chat-1/laugh.png' && ok.source === 'model', JSON.stringify(ok))

  const noImg = decideSticker({ config: cfg, replyText: '哈哈哈', requestedLabel: 'confused', candidates: cands, usage: emptyUsage(), scope: 'group-1', turnCount: 2 })
  check('★★ 模型要的标签库里没有 → 不发，**不拿别的图顶替**',
    noImg.action === 'skip' && noImg.reason.includes('不拿别的图顶替'), noImg.reason)

  // ── ★★ 模型点名时**不看分数阈值**（实测事故：全局库的 comfort 只有 2 分被静默拒掉）──
  {
    const globalOnly = [cand('global/comfort-1.png', 'comfort', 0, imgA)]
    const strict = { enabled: true, scoreThreshold: 4 }
    const model = decideSticker({
      config: strict,
      replyText: '我今天被老板骂了',
      requestedLabel: 'comfort',
      candidates: globalOnly,
      usage: emptyUsage(),
      scope: 'group-1',
      turnCount: 2,
    })
    check('★★★ 模型点名 + 全局库低分（2 分 < 阈值 4）→ **仍然发**（模型明确要求不该被阈值挡）',
      model.action === 'send' && model.label === 'comfort', JSON.stringify(model))

    const auto = decideSticker({
      config: strict,
      replyText: '今天天气不错',
      requestedLabel: null,
      candidates: globalOnly,
      usage: emptyUsage(),
      scope: 'group-1',
      turnCount: 2,
    })
    check('★ 但**自主**那条路仍然受阈值约束（低分不发）', auto.action === 'skip', auto.reason)

    // 模型点名也不能绕过配额（那一条是账号安全相关的）
    const gated = decideSticker({
      config: strict,
      replyText: '我今天被老板骂了',
      requestedLabel: 'comfort',
      candidates: globalOnly,
      usage: { scopes: { [scopeDirName('group-1')]: { day: new Date().toISOString().slice(0, 10), count: 0, sentAt: [Date.now() - 1000], images: {}, failures: [] } } },
      scope: 'group-1',
      turnCount: 2,
    })
    check('★★ 模型点名**不能绕过配额**（冷却照样拦）', gated.action === 'skip' && gated.reason.includes('配额'), gated.reason)
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥b 礼节 / 交付：0.2.4 第十六轮起**也允许自主触发**（用户要求）')
// ══════════════════════════════════════════════════════════════════════════
{
  // ★ 这条**改掉了一条旧决定**：原先"功能性标签（打招呼/晚安/任务完成）只有模型
  //   主动能触发"，理由是"自主判定判断不了这一轮算不算收工"。但用户后来给了
  //   **语境轴三分类**：礼节=客体类（对方说"睡了/我的锅"才配图）、
  //   交付=主体类（bot 自己说"搞定了"才配图）—— 两类都有明确的词面判据，
  //   不该再被整体禁掉。所以现在只保留唯一闸门：**风险（risky）**。
  check('★ 礼节 / 交付 现在都**可以**自主补（轴三分类对齐之后）',
    ['greet', 'goodnight', 'task-done'].every((id) => isAutoAllowedLabel(id) && !isFunctionalLabel(id)))
  // ★ "功能类"这个概念已经没了 —— 只剩风险闸门不允许自主
  //   （`isFunctionalLabel` 对它仍为 true，因为它的轴不在 AUTO_ALLOWED_AXES 里；
  //    这正是我们要的：它不能被自主触发）
  check('★ 除风险闸门之外，已没有"功能类"了',
    STICKER_LABELS.filter((l) => isFunctionalLabel(l.id)).map((l) => l.id).join(',') === 'risky',
    STICKER_LABELS.filter((l) => isFunctionalLabel(l.id)).map((l) => l.id).join(','))
  check('★★ 唯一不能自主的是风险闸门', isRiskyLabel('risky') && !isAutoAllowedLabel('risky'))
  check('表达类照旧可自主', isAutoAllowedLabel('laugh'))

  // 客体类（礼节）：**对方**说"晚安"才自主配图
  check('★★ 礼节（客体类）：对方说「晚安」→ 自主补 goodnight',
    resolveStickerIntent({ requestedLabel: null, replyText: '明天聊', userText: '晚安，我先睡了' })?.label === 'goodnight',
    JSON.stringify(resolveStickerIntent({ requestedLabel: null, replyText: '明天聊', userText: '晚安，我先睡了' })))
  check('★★ 反过来：bot 自己说「晚安」**不**自主补（客体类不看自身发言）',
    resolveStickerIntent({ requestedLabel: null, replyText: '晚安' }).source === null,
    JSON.stringify(resolveStickerIntent({ requestedLabel: null, replyText: '晚安' })))
  // 主体类（交付）：**bot 自己**说"搞定了"才自主配图
  check('★★ 交付（主体类）：bot 自己说「搞定了」→ 自主补 task-done',
    resolveStickerIntent({ requestedLabel: null, replyText: '搞定了' })?.label === 'task-done')
  check('★ 模型主动要这些标签仍然允许',
    resolveStickerIntent({ requestedLabel: 'task-done', replyText: '搞定了' }).source === 'model')
  check('自主仍能抽表达类（笑死）',
    resolveStickerIntent({ requestedLabel: null, replyText: '哈哈哈笑死我了' }).source === 'auto')

  const cfg = { enabled: true, scoreThreshold: 2 }
  const done = decideSticker({
    config: cfg,
    replyText: '搞定了，你试一下',
    requestedLabel: 'task-done',
    candidates: [cand('chat-1/done.png', 'task-done', 1, imgA)],
    usage: emptyUsage(),
    scope: 'group-1',
    turnCount: 2,
  })
  check('★ 模型主动要任务完成 → 真的发出去', done.action === 'send' && done.label === 'task-done', JSON.stringify(done))

  const autoDone = decideSticker({
    config: cfg,
    replyText: '搞定了',
    requestedLabel: null,
    candidates: [cand('chat-1/done.png', 'task-done', 1, imgA)],
    usage: emptyUsage(),
    scope: 'group-1',
    turnCount: 2,
  })
  check('★★ 没写标签时**会**自主补任务完成图（交付=主体类，看自身发言）',
    autoDone.action === 'send' && autoDone.label === 'task-done', autoDone.reason)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑦ 四层漏斗：每层都能单独拦住，并且给出人话原因')
// ══════════════════════════════════════════════════════════════════════════
{
  const cands = [
    cand('chat-1/laugh.png', 'laugh', 1, imgA),
    cand('global/agree.png', 'agree', 0, imgB),
  ]
  const cfg = { enabled: true, scoreThreshold: DEFAULT_SCORE_THRESHOLD }

  const off = decideSticker({ config: { ...cfg, enabled: false }, replyText: '哈哈哈', requestedLabel: 'laugh', candidates: cands, usage: emptyUsage(), scope: 'g', turnCount: 2 })
  check('第 0 层：技能关掉 → 不发且说明是"技能已关闭"', off.action === 'skip' && off.reason.includes('已关闭'))

  const empty = decideSticker({ config: cfg, replyText: '哈哈哈', requestedLabel: 'laugh', candidates: [], usage: emptyUsage(), scope: 'g', turnCount: 2 })
  check('第 0 层：库里没图 → 不发且说明是"没有可用图"', empty.action === 'skip' && empty.reason.includes('没有可用图'))

  const vetoed = decideSticker({ config: cfg, replyText: '我帮你看看怎么弄', requestedLabel: 'laugh', candidates: cands, usage: emptyUsage(), scope: 'g', turnCount: 2 })
  check('第 1 层：硬否决即使模型主动要也不发', vetoed.action === 'skip' && vetoed.reason.includes('硬否决'), vetoed.reason)

  const lowScore = decideSticker({
    config: { ...cfg, scoreThreshold: 9 },
    replyText: '嗯',
    requestedLabel: null,
    candidates: [cand('global/laugh.png', 'laugh', 0, imgA)],
    usage: emptyUsage(),
    scope: 'g',
    turnCount: 2,
  })
  check('★ 第 3 层：低于阈值 → 不发（不为发而发）',
    lowScore.action === 'skip' && lowScore.reason.includes('低于阈值'), lowScore.reason)

  const gated = decideSticker({
    config: cfg,
    replyText: '哈哈哈',
    requestedLabel: 'laugh',
    candidates: cands,
    usage: { scopes: { [scopeDirName('g')]: { day: new Date().toISOString().slice(0, 10), count: 0, sentAt: [Date.now() - 1000], images: {}, failures: [] } } },
    scope: 'g',
    turnCount: 2,
  })
  check('★ 第 4 层：配额拦住模型主动要的那张',
    gated.action === 'skip' && gated.reason.includes('配额'), gated.reason)

  const missed = decideSticker({ config: cfg, replyText: '哈哈哈', requestedLabel: 'laugh', candidates: [cand('chat-1/laugh.png', 'laugh', 1, join(root, 'nope.png'))], usage: emptyUsage(), scope: 'g', turnCount: 2 })
  check('★ 库与磁盘不同步 → 不发并指向 prune（不能误报成"标签没有图"）',
    missed.action === 'skip' && missed.reason.includes('prune'), missed.reason)

  const record = toDecisionRecord(ok0(), { scope: 'group-1', replyText: '哈哈哈', at: Date.parse('2026-03-01T00:00:00Z') })
  check('决策流水带人话原因与标签中文名', record.labelName === '笑死' && record.reason.includes('笑死'), JSON.stringify(record))
  function ok0() {
    return decideSticker({ config: cfg, replyText: '哈哈哈', requestedLabel: 'laugh', candidates: cands, usage: emptyUsage(), scope: 'group-1', turnCount: 2 })
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑧ 打分：可解释（每个加减分都留理由）')
// ══════════════════════════════════════════════════════════════════════════
{
  const mine = scoreStickerCandidate(cand('chat-1/laugh.png', 'laugh', 1, imgA), { attitude: { id: 'laugh' }, replyText: '哈哈哈' })
  const theirs = scoreStickerCandidate(cand('global/laugh.png', 'laugh', 0, imgA), { attitude: { id: 'laugh' }, replyText: '哈哈哈' })
  check('★ 本会话的图分数更高（群里人认得出，才像群里的人）', mine.score > theirs.score, `${mine.score} vs ${theirs.score}`)
  check('理由可读', mine.reasons.join('｜').includes('主标签命中'), mine.reasons.join('｜'))

  const reused = scoreStickerCandidate(cand('chat-1/laugh.png', 'laugh', 1, imgA), {
    attitude: { id: 'laugh' }, replyText: '哈哈哈', recentRels: ['chat-1/laugh.png'], recentLabels: ['laugh'],
  })
  check('★ 最近发过的图被扣分', reused.score < mine.score, `${reused.score} vs ${mine.score}`)

  // ── ★★ 同分的多张图：都要有机会被选中（第一版是"永远选哈希最小的那张"）──
  const pool = [cand('b/x.png', 'laugh', 1, imgA), cand('a/x.png', 'laugh', 1, imgA), cand('c/x.png', 'laugh', 1, imgA)]
  const ctx = { attitude: { id: 'laugh' }, replyText: '哈哈哈' }
  const zero = pickBestSticker(pool, { ...ctx, random: () => 0 })
  const last = pickBestSticker(pool, { ...ctx, random: () => 0.99 })
  check('★ 最高分那一档内部随机（不是永远选同一张）', zero.best.rel !== last.best.rel,
    `${zero.best.rel} vs ${last.best.rel}`)
  check('★ 报出同分有几张（排障时能看出"库里有得选"）', zero.tiedCount === 3, String(zero.tiedCount))
  check('★ 随机源可注入 → 测试不会"有时过有时不过"',
    pickBestSticker(pool, { ...ctx, random: () => 0.5 }).best.rel === 'b/x.png',
    pickBestSticker(pool, { ...ctx, random: () => 0.5 }).best.rel)
  // 分数不同档时不能被随机搅乱：高分必须赢
  const mixed = pickBestSticker(
    [cand('g/low.png', 'agree', 0, imgA), cand('g/high.png', 'laugh', 1, imgA)],
    { ...ctx, random: () => 0.99 },
  )
  check('★★ 不同分档不会被随机搅乱（高分仍然赢）', mixed.best.rel === 'g/high.png', mixed.best.rel)
  check('同分只有一张时不报 tiedCount', pickBestSticker([cand('a/x.png', 'laugh', 1, imgA)], ctx).tiedCount === undefined)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑨ 提示词：只提真有货的标签（说了做不到是硬伤）')
// ══════════════════════════════════════════════════════════════════════════
{
  check('★ 一张图都没有 → 一个字都不写',
    renderStickerPrompt({ coverage: {} }) === '' && renderStickerPromptLines({ coverage: {} }).length === 0)
  const lines = renderStickerPromptLines({ coverage: { laugh: 5, confused: 1, agree: 0 } })
  const p = lines.join('\n')
  check('有货的标签进提示词（id 与中文名都在）', p.includes('laugh（笑死）') && p.includes('confused'), p)
  check('★ 没货的标签一个字都不提（agree 为 0）', !p.includes('agree'), p)
  check('★ 图少的标签如实标注（写了也可能选不中）', p.includes('图比较少'), p)
  check('教了标记写法', p.includes('[sticker:'))
  check('写了"标签不会作为文字发出去"', p.includes('永远不会作为文字发出去'))
  check('只有图少的标签时会额外提醒"没合适的就别写"',
    renderStickerPrompt({ coverage: { laugh: 1 } }).includes('没有特别合适的就别写'))
  check('★ 内容不会被长度上限静默吞掉（有标签就必须说）',
    renderStickerPrompt({ coverage: { laugh: 5, confused: 5, agree: 5, sad: 5, tired: 5, slack: 5 } }).includes('[sticker:'))
  check('词表里每个标签都有 id 与中文名', STICKER_LABELS.every((l) => l.id && l.name && l.cues.length))
  check('★ 词表里每个标签都有 antiCues（没有负例就等于没有边界）',
    STICKER_LABELS.every((l) => Array.isArray(l.antiCues) && l.antiCues.length > 0),
    STICKER_LABELS.filter((l) => !l.antiCues?.length).map((l) => l.id).join('、') || '全部都有')
}

// ══════════════════════════════════════════════════════════════════════════
section('⑩ 人设段：说清"能表达什么"，但**不重复标签清单**')
// ══════════════════════════════════════════════════════════════════════════
{
  check('★ 库里一张图都没有 → 人设一个字都不提（不许承诺做不到的事）',
    renderStickerPersonaNote({ coverage: {} }) === '')
  const note = renderStickerPersonaNote({ coverage: { laugh: 3, agree: 2, risky: 1 } })
  check('说了表情包表达的是"这一句在做什么"，不是"你现在的心情"',
    note.includes('不是"你现在的心情"'), note)
  check('按轴给范围（不是逐个列标签）', note.includes('被逗乐') && note.includes('表态'))
  check('★ 不列具体标签 id（清单只有提示词那一处来源，避免两份清单漂移）',
    !note.includes('laugh') && !note.includes('[sticker:'), note)
  // ★ 0.2.4 第十六轮：礼节/交付也能自主了，所以"系统不会替你挑"不再由它们触发；
  //   唯一还需要模型主动挑的是**风险闸门**（默认不发那类图）。
  check('有"只能模型主动挑"的标签（风险闸门）时如实说明',
    note.includes('系统不会替你挑'), note)
  check('没有这类图时就不提这句',
    !renderStickerPersonaNote({ coverage: { laugh: 3 } }).includes('系统不会替你挑'))
  check('写了"宁可整轮不发"的分寸', note.includes('宁可整轮不发'))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑫ exclude / 压制对 / 风险闸门（学自同类实现 sticker-admin）')
// ══════════════════════════════════════════════════════════════════════════
{
  // ── ① exclude：出现即**整条作废**（防语义反转）────────────────────────
  // 这几条都是真例子：「被怼得说不出话」不是"挑衅"，「被击中」不是"被萌到"，
  // 「笑不出来」不是"被逗乐" —— 方向正好相反。
  check('★ 被怼 → 不再是 spite（挑衅）',
    extractAttitude('被怼得说不出话来')?.id !== 'spite', JSON.stringify(extractAttitude('被怼得说不出话来')))
  check('★ 被击中了 → 不再是 moved（被萌到）',
    extractAttitude('被击中了')?.id !== 'moved', JSON.stringify(extractAttitude('被击中了')))
  check('★ 笑不出来 → 不再是 laugh（被逗乐）',
    extractAttitude('笑不出来')?.id !== 'laugh', JSON.stringify(extractAttitude('笑不出来')))
  check('exclude 不影响正常命中', extractAttitude('来啊，打一架')?.id === 'spite', JSON.stringify(extractAttitude('来啊，打一架')))

  // ── ② 压制对：近义标签都命中时只留更具体的那个 ────────────────────────
  check('★ 压制对表非空、形状正确（[赢家,输家] 且都在词表里）',
    SUPPRESS_PAIRS.length > 0 &&
      SUPPRESS_PAIRS.every(([w, l]) => STICKER_LABEL_IDS.includes(w) && STICKER_LABEL_IDS.includes(l)),
    JSON.stringify(SUPPRESS_PAIRS))
  const both = extractAttitude('这也太绝了')
  check('★ 命中赢家时只剩它（"绝了"→哭笑不得；同时命中的笑类线索被压掉）',
    both?.id === 'awkward-smile', JSON.stringify(both))
  check('★ 而"哭笑不得"这四个字本身**不在线索表里**（所以不该指望它命中）—— 这是如实记录，不是 bug',
    extractAttitude('哭笑不得') === null, JSON.stringify(extractAttitude('哭笑不得')))
  check('★ 但它**不会**把单说"笑死"也压掉（同类实现踩过：压制过宽会让某标签永远拿不到）',
    extractAttitude('哈哈哈笑死我了')?.id === 'laugh')

  // ── ③ 单字线索减半（避免"怼/逗/梗"压过"摆烂"）────────────────────────
  check('★ 单字权重 0.5', SINGLE_CHAR_SCORE === 0.5, String(SINGLE_CHAR_SCORE))
  check('★ 双字线索压过单字（"摆烂" 2 分 > 单字 0.5 分）',
    extractAttitude('算了算了，摆烂')?.id === 'slack', JSON.stringify(extractAttitude('算了算了，摆烂')))

  // ── ④ 风险闸门：标了「慎发」的图默认**不进候选** ─────────────────────
  const wsR = mkdtempSync(join(tmpdir(), 'sticker-risk-'))
  const dirR = join(wsR, 'seed')
  mkdirSync(dirR, { recursive: true })
  writeFileSync(join(dirR, 'safe.png'), pngBytes(1))
  writeFileSync(join(dirR, 'nasty.png'), pngBytes(2))
  importStickerFiles({ workspace: wsR }, [
    { scope: 'global', files: [join(dirR, 'safe.png')], primary: 'laugh', labels: ['laugh'], confidence: 0.9 },
    { scope: 'global', files: [join(dirR, 'nasty.png')], primary: 'laugh', labels: ['laugh'], confidence: 0.9 },
  ])
  const libR = readStickerLibrary({ workspace: wsR })
  const relsR = Object.keys(libR.entries)
  applyStickerLabels({ workspace: wsR }, {
    [relsR[1]]: { primary: 'laugh', labels: ['laugh', 'risky'], risky: true, confidence: 0.9 },
  })
  check('★ risky 标记落进了条目（打标签那一步写的）',
    readStickerLibrary({ workspace: wsR }).entries[relsR[1]].risky === true)
  check('★ isRiskyEntry 两种形状都认',
    isRiskyEntry({ labels: ['laugh', 'risky'] }) && isRiskyEntry({ risky: true }) && !isRiskyEntry({ labels: ['laugh'] }))

  const denied = buildStickerSelection({ workspace: wsR, scope: 'group-x' })
  check('★★ 默认 → 风险图**不进候选**，并如实报出拦了几张',
    denied.candidates.length === 1 && denied.skippedRisky === 1,
    JSON.stringify({ cands: denied.candidates.length, skipped: denied.skippedRisky }))
  const allowed = buildStickerSelection({ workspace: wsR, scope: 'group-x', allowRisky: true })
  check('★ 显式 allowRisky → 它才进候选（开关是两种行为）',
    allowed.candidates.length === 2 && allowed.skippedRisky === 0, String(allowed.candidates.length))
  check('★ 它在**建候选那层**就被挡（不是"分数低"）—— 就算唯一能命中的是它，也出不来',
    denied.candidates.every((c) => c.entry.risky !== true))
  rmSync(wsR, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
section('⑭ ★★ 两源匹配：ownCues 看 bot 正文，otherCues 看**对方消息**')
// ══════════════════════════════════════════════════════════════════════════
{
  // 这组断言钉的是用户提出的那个真问题：
  //   「假设 bot 根本不会说"我好累"一类的话，岂不是这个语境下的表情永远不会触发」
  // 是的 —— 而且实测确认过。原因：自主判定匹配的是 `replyText`，即 **bot 自己要说的话**，
  // 而 cue 里混着两种东西。`tired` 的 cues 全是**第一人称自述**（好累/困/熬夜），
  // 一个助手不会说"我好累、我熬夜了"，于是它**事实上是死代码**。
  // 修法：线索分两组，`otherCues` 匹配对方那条消息。
  const wsV = mkdtempSync(join(tmpdir(), 'sticker-2src-'))
  const V = { workspace: wsV, dir: 'stickers' }
  try {
    // ── ① 出厂词表里 B1「陈述自己」的线索确实搬到 otherCues 了 ──
    const t = STICKER_LABELS.find((l) => l.id === 'tired')
    check('★★ tired 的 otherCues 覆盖了"对方累了"的常见说法',
      ['好累', '累死', '熬夜', '加班到'].every((c) => (t.otherCues ?? []).includes(c)),
      JSON.stringify(t.otherCues))
    check('★★ tired 的 cues（=bot 自己的话）里**不再**放第一人称自述',
      !(t.cues ?? []).includes('好累') && !(t.cues ?? []).includes('熬夜'),
      JSON.stringify(t.cues))
    check('★ 每个标签都有 cues 或 otherCues（不能两组都空，否则永远不会命中）',
      STICKER_LABELS.every((l) => (l.cues ?? []).length || (l.otherCues ?? []).length),
      STICKER_LABELS.filter((l) => !(l.cues ?? []).length && !(l.otherCues ?? []).length).map((l) => l.id).join(','))

    // ── ② 对方说了"我好累"，bot 正文里**一个字都没有** → 现在能触发 ──
    const a1 = extractAttitude('早点休息吧', V, '我好累啊，今天加班到现在')
    check('★★ 对方说「我好累」+ bot 说「早点休息吧」→ 抽出 tired（以前抽不出）',
      a1?.id === 'tired' && a1.source === 'other', JSON.stringify(a1))
    // ── ③ 主体类（状态）只认**自身发言**：这一条按新轴规则测 bot 那一侧 ──
    //    ⚠️ 用「算了，毁灭吧」而不是「算了，随便吧，毁灭吧」：后者的「随便」会命中
    //    `dismiss`（社交姿态=混合类，自身那一侧留着 cues），把 slack 挤掉。
    const a2 = extractAttitude('算了，毁灭吧', V, '')
    check('★★ 主体类（状态）：bot 自己说「算了，毁灭吧」→ slack（不看对方发言）',
      a2?.id === 'slack' && a2.source === 'self', JSON.stringify(a2))
    check('★★ 反过来：**对方**说同样的话不触发 slack（状态类是主体类）',
      extractAttitude('好', V, '算了，毁灭吧')?.id !== 'slack',
      JSON.stringify(extractAttitude('好', V, '算了，毁灭吧')))
    // ── ④ 客体类（认知反应）只认对方发言：`emmm` 现在走对方那一侧 ──
    const a3 = extractAttitude('好', V, 'emmm 这个我得想想')
    check('★ 客体类（认知反应）：对方说「emmm」→ deadpan（bot 正文不参与）',
      a3?.id === 'deadpan' && a3.source === 'other', JSON.stringify(a3))
    // ── ⑤ ★ 优先级：对方消息有信号时，**压过** bot 自己的套话（用混合类来验）──
    //   实测形状：bot 回「确实」，其「确实」在客体类上会命中 agree（旧词表），
    //   而对方在难过（comfort 属主动情感=混合类）。真实信号必须压过套话。
    const a4 = extractAttitude('确实', V, '呜呜呜我好难过')
    check('★★★ 混合类：对方难过 vs bot 的套话「确实」→ 以**对方**为准（comfort）',
      a4?.id === 'comfort' && a4.weightOther > 0, JSON.stringify(a4))
    // ── ⑥ 场景排除词（excludeOther）只在匹配**对方消息**时生效 ──
    const a5 = extractAttitude('好的', V, '这个报错怎么解决，帮我看看')
    check('★ 对方在**认真求助** → 不自主发（场景排除词挡住）', a5 === null, JSON.stringify(a5))
    // ── ⑦ matched 带来源标注（决策流水要能解释"为什么是这张"） ──
    check('★ matched 里标出线索来自对方（`对方:` 前缀）',
      (a1?.matched ?? []).some((m) => m.startsWith('对方:')), JSON.stringify(a1?.matched))
    // ── ⑧ 单字线索不进对方消息匹配（`早` 命中「早点休息」是实测的假阳性） ──
    check('★★ 单字线索在对方消息里**不参与**匹配',
      cueHitsInMessage('早点休息吧', '早') === false && cueHitsInMessage('我好累', '累') === false)
    check('★ `早` 已移出单字白名单（它是「早点/早晚」的第一个字）',
      !SAFE_SINGLE_CHAR_CUES.has('早'))
    // ── ⑨ 兼容：旧词表只有 cues 也能跑 ──
    mkdirSync(join(wsV, 'stickers'), { recursive: true })
    writeFileSync(
      join(wsV, 'stickers', 'labels.json'),
      JSON.stringify({ version: 1, labels: [{ id: 'laugh', name: '笑死', axis: '被逗乐', cues: ['哈哈哈'] }] }),
      'utf8',
    )
    resetLabelCache()
    const legacy = extractAttitude('哈哈哈', V, '')
    check('★★ 旧词表（只有 cues、没有 otherCues）照常工作',
      legacy?.id === 'laugh' && legacy.cuesFrom === undefined ? legacy?.id === 'laugh' : legacy?.id === 'laugh',
      JSON.stringify(legacy))
    resetLabelCache()
  } finally {
    rmSync(wsV, { recursive: true, force: true })
  }
}

rmSync(root, { recursive: true, force: true })
console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
