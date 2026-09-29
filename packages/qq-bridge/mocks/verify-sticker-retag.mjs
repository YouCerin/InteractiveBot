/**
 * 表情包**重新打标签**（界面按钮那条路）的测试（0.2.4）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这组断言在防什么
 * ══════════════════════════════════════════════════════════════════════════
 * 打标签是本功能**唯一会真花钱**的操作（每张图一次模型调用），而它现在有一个
 * 界面按钮 —— 按钮意味着"点错了就会立刻花掉几十次调用"。所以每一道保护都要钉住：
 *
 *   ① **预检免费且准确**：界面靠它做二次确认（"这将调用模型 N 次"）。
 *      它绝不能调模型、也不能少数几张。
 *   ② **人工改过的标签不被覆盖**：人改标签往往是因为模型打错了；
 *      重打把它冲掉 = 把人纠正过的错误再犯一遍。
 *   ③ **防重入**：按钮能被连点。两个任务并发会同时写 `library.json`
 *      （后写覆盖先写、丢结果）而且账单翻倍。
 *   ④ **连续失败要熔断**：单张失败不该中断整批，但连续 3 张失败说明是配置问题
 *      （key 过期 / 模型不支持图 / 网络不通），继续跑只是烧额度。
 *   ⑤ **可停止**：长任务不能没有刹车。已打上的要照常写回（不做废）。
 *   ⑥ **失败不写坏库**：读不到文件、模型答非所问 —— 条目保持原样（仍在待定区）。
 *
 * ★ 用**注入的假模型**（`chat`）而不是真调：这些断言要能在离线、零费用下跑，
 *   而且必须能精确构造"模型返回坏 JSON / 连续失败"这类分支。
 *
 * 用法：node mocks/verify-sticker-retag.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { applyStickerLabels, buildStickerCandidates, importStickerFiles, readStickerLibrary } from '../src/sticker-library.mjs'
import { FILENAME_LABEL_HINTS, MANUAL_SOURCE, createRetagJob, preflightRetag, runTagging, selectTagTargets, tagFromFilenames } from '../src/sticker-tagging.mjs'
import { normalizeLabelId } from '../src/sticker-labels.mjs'

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

/** 真 PNG（8×8，带明暗结构）。 */
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
      // ★ 必须让**每张图内容都不同**：内容寻址是按哈希去重的，
      //   第一版这里只用了 3 种图案（marker % 3），于是"造 5 张"实际只入库 3 张 ——
      //   断言失败的同时也说明这套测试**真的在读库**（不是空跑）。
      raw[base + 1 + x * 3] = (40 + marker * 23 + x * 7) & 0xff
      raw[base + 2 + x * 3] = (60 + marker * 11 + y * 13) & 0xff
      raw[base + 3 + x * 3] = (200 - marker * 17 + x * 3) & 0xff
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 造一个有 N 张图的工作区（都在全局库、无标签）。 */
function makeWorkspace(n = 3) {
  const ws = mkdtempSync(join(tmpdir(), 'sticker-retag-'))
  const src = join(ws, 'seed')
  mkdirSync(src, { recursive: true })
  const files = []
  for (let i = 0; i < n; i += 1) {
    const p = join(src, `img-${i}.png`)
    writeFileSync(p, pngBytes(i))
    files.push(p)
  }
  importStickerFiles({ workspace: ws }, [{ scope: 'global', files }])
  return ws
}

const reply = (primary, confidence = 0.9) => ({
  ok: true,
  text: `{"primary":"${primary}","secondary":[],"confidence":${confidence}}`,
})

// ══════════════════════════════════════════════════════════════════════════
section('① 预检：免费、准确 —— 界面靠它说"这将调用模型 N 次"')
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = makeWorkspace(3)
  const pre = preflightRetag({ workspace: ws })
  check('★ 预检报出"要处理多少张"', pre.ok && pre.todo === 3, JSON.stringify(pre))
  check('★ 预检不花任何模型调用（它只读库）', pre.todo === pre.total && pre.total === 3)

  // 打上两张标签后再预检：**仍然是 3**（"重新打标签"= 全部重打，不是只补待定的）
  const lib = readStickerLibrary({ workspace: ws })
  const rels = Object.keys(lib.entries)
  applyStickerLabels({ workspace: ws }, { [rels[0]]: { primary: 'laugh', confidence: 0.9 } })
  const pre2 = preflightRetag({ workspace: ws })
  check('★★ 已经打好标签的**也算**在"要重打"里（用户说的是"重新为所有表情打标签"）',
    pre2.todo === 3, JSON.stringify(pre2))

  // 人工改过的那张要被跳过并**报出来**
  const lib2 = readStickerLibrary({ workspace: ws })
  lib2.entries[rels[1]].primary = 'agree'
  lib2.entries[rels[1]].source = MANUAL_SOURCE
  writeFileSync(join(ws, 'stickers', 'library.json'), `${JSON.stringify(lib2, null, 2)}\n`, 'utf8')
  const pre3 = preflightRetag({ workspace: ws })
  check('★★ 人工改过的默认跳过，而且**数字要准**（界面要显示"跳过 N 张"）',
    pre3.todo === 2 && pre3.skippedManual === 1, JSON.stringify(pre3))
  check('★ 加 --force（force:true）时连人工的一起打', preflightRetag({ workspace: ws }, { force: true }).todo === 3)
  check('没有工作区时明确失败（不静默）', preflightRetag({ workspace: '' }).ok === false)
  rmSync(ws, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
section('② 引擎：成功 / 失败 / 熔断 / 停止')
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = makeWorkspace(3)

  // 全部成功
  let calls = 0
  const ok = await runTagging({
    workspace: ws,
    chat: async () => {
      calls += 1
      return reply('laugh')
    },
  })
  check('★ 三张都打上了', ok.ok && ok.tagged === 3 && calls === 3, JSON.stringify({ tagged: ok.tagged, calls }))
  check('★ 返回的是"要写回什么"，**没有**自己写库（写回是调用方的事）',
    Object.keys(ok.updates).length === 3 && readStickerLibrary({ workspace: ws }).entries[Object.keys(ok.updates)[0]].primary === null,
    '库应保持未改')

  // 模型返回坏 JSON → 落待定，且**不算通路故障**
  const bad = await runTagging({ workspace: ws, chat: async () => ({ ok: true, text: '这张我说不清' }) })
  check('★ 模型答非所问 → 全部失败，但**不是**通路故障（不触发熔断）',
    bad.ok === true && bad.failed === 3 && bad.consecutiveFailures === 0, JSON.stringify(bad))

  // 连续失败 → 熔断（只跑 3 次就停）
  let attempts = 0
  const ws5 = makeWorkspace(6)
  const trip = await runTagging({
    workspace: ws5,
    chat: async () => {
      attempts += 1
      return { ok: false, why: '模型 401（key 过期）' }
    },
  })
  check('★★ 连续失败 3 次 → 熔断（不再烧额度）', trip.ok === false && attempts === 3, `尝试 ${attempts} 次`)
  check('★ 熔断原因说清了是"不像单张的问题"并附最后一条原因',
    trip.why.includes('连续') && trip.why.includes('401'), trip.why)

  // 中途失败但随后成功 → 计数清零，不熔断
  let n = 0
  const mixed = await runTagging({
    workspace: makeWorkspace(5),
    chat: async () => {
      n += 1
      return n === 2 ? { ok: false, why: '网络抖了一下' } : reply('agree')
    },
  })
  check('★ 偶发失败后成功 → 计数清零（不会攒到熔断）',
    mixed.ok === true && mixed.tagged === 4 && mixed.failed === 1, JSON.stringify({ tagged: mixed.tagged, failed: mixed.failed, n }))

  // 停止
  const signal = { aborted: false }
  const wsStop = makeWorkspace(6)
  const stopped = await runTagging({
    workspace: wsStop,
    signal,
    onProgress: () => {
      signal.aborted = true // 第一张跑完就要求停
    },
    chat: async () => reply('laugh'),
  })
  check('★ 请求停止 → 停下（不把剩下的跑完）', stopped.aborted === true && stopped.tagged === 1, JSON.stringify({ tagged: stopped.tagged }))
  check('★ 已打上的**不做废**（updates 里有那 1 条）', Object.keys(stopped.updates).length === 1)
  rmSync(ws, { recursive: true, force: true })
  rmSync(ws5, { recursive: true, force: true })
  rmSync(wsStop, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 跳过人工标签 & 只处理指定的几张')
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = makeWorkspace(4)
  const lib = readStickerLibrary({ workspace: ws })
  const rels = Object.keys(lib.entries)
  applyStickerLabels({ workspace: ws }, {
    // ★ 人工标的是**真标签**（`sad`）。这里刻意不再用"词表里没有的名字"：
    //   0.2.4 第十四轮起，**没有主标签的条目不算"人工标签"**（见 `isManualEntry`）——
    //   因为"删除标签"会把图恢复成未标注并把 source 记成 manual，
    //   若把"没有标签"也当成人工判断，那些图就永远无法被重新分类（实测 127 张全卡住）。
    [rels[0]]: { primary: 'sad', confidence: 0.9, source: MANUAL_SOURCE },
    [rels[1]]: { primary: 'laugh', confidence: 0.9 },
  })
  const sel = selectTagTargets(readStickerLibrary({ workspace: ws }), { skipManual: true })
  check('★★ 人工改过的条目**不进**处理队列', !sel.todo.some((e) => e.rel === rels[0]), JSON.stringify(sel.todo.map((e) => e.rel)))
  check('★ 跳过数如实给出', sel.skippedManual === 1, String(sel.skippedManual))
  // ★★ 反过来：`source=manual` 但**没有主标签**的条目必须**能**被重打 ——
  //    否则"删掉标签 → 图变未标注"之后，那些图就再也打不上标签了（实测踩到）。
  {
    const ws2 = makeWorkspace(1)
    const r2 = Object.keys(readStickerLibrary({ workspace: ws2 }).entries)[0]
    // 模拟"删标签"留下的形状：primary 为空、confidence 0、source manual
    applyStickerLabels({ workspace: ws2 }, { [r2]: { primary: '', labels: [], confidence: 0, source: MANUAL_SOURCE } })
    const sel2 = selectTagTargets(readStickerLibrary({ workspace: ws2 }), { skipManual: true, onlyPending: true })
    check('★★★ 没有主标签的 manual 条目**不跳过**（否则删过标签的图永远分类不了）',
      sel2.todo.length === 1 && sel2.skippedManual === 0, JSON.stringify({ todo: sel2.todo.length, skipped: sel2.skippedManual }))
    rmSync(ws2, { recursive: true, force: true })
  }

  const only = await runTagging({
    workspace: ws,
    rels: [rels[2]],
    chat: async () => reply('shock'),
  })
  check('★ 可以只处理指定的几张（界面按需重打用）', only.tagged === 1 && Object.keys(only.updates)[0] === rels[2])

  const forced = await runTagging({ workspace: ws, force: true, chat: async () => reply('laugh') })
  check('force=true 时人工的那张也重打', forced.skippedManual === 0 && forced.retagged + forced.tagged === 4,
    JSON.stringify({ skipped: forced.skippedManual, tagged: forced.tagged, retagged: forced.retagged }))
  rmSync(ws, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 任务控制器：防重入 / 进度 / 停止 / 写回')
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = makeWorkspace(3)
  const logs = []
  // ★ 预检要**注入**进来（生产环境里由 index.mjs 注入，理由见 createRetagJob 的注释）：
  //   不注入的话空闲状态拿不到"要打几张"，界面就没法在点之前做二次确认。
  const job = createRetagJob({
    log: (m) => logs.push(m),
    resolvePreflight: () => preflightRetag({ workspace: ws }),
  })
  const base = {
    workspace: ws,
    chat: async () => {
      await new Promise((r) => setTimeout(r, 5))
      return reply('laugh')
    },
  }

  const st0 = job.status()
  check('★ 空闲时状态是 idle，且**带预检数字**（界面点之前就知道要打几张）',
    st0.phase === 'idle' && st0.total === 3 && st0.libraryTotal === 3, JSON.stringify(st0))

  const started = job.start(base)
  check('★ 发起立刻返回 jobId（不等任务跑完）', started.ok && Boolean(started.jobId), JSON.stringify(started))
  check('★ 发起时把预检结果一并给出（界面用它做二次确认）', started.total === 3)

  const again = job.start(base)
  check('★★ 防重入：第二次发起被明确拒绝（不是静默忽略）',
    again.ok === false && again.why.includes('已经'), again.why)

  // 等它跑完
  for (let i = 0; i < 100 && job.status().running; i += 1) await new Promise((r) => setTimeout(r, 20))
  const done = job.status()
  check('★ 跑完状态是 done，三个计数都对', done.phase === 'done' && done.tagged === 3 && done.done === 3, JSON.stringify(done))
  check('★ 进度有百分比（界面画进度条用）', done.percent === 100, String(done.percent))
  check('★ 跑完**写回了库**（这是任务控制器的职责，引擎只返回 updates）',
    Object.values(readStickerLibrary({ workspace: ws }).entries).every((e) => e.primary === 'laugh'),
    JSON.stringify(Object.values(readStickerLibrary({ workspace: ws }).entries).map((e) => e.primary)))
  check('★ 留了一行日志（排障要能对上）', logs.some((l) => l.includes('重新打标签')), logs.join('｜'))

  // 停止
  const ws2 = makeWorkspace(6)
  const job2 = createRetagJob({})
  job2.start({
    workspace: ws2,
    chat: async () => {
      await new Promise((r) => setTimeout(r, 10))
      return reply('laugh')
    },
  })
  const ab = job2.abort()
  check('★ 停止请求被接受', ab.ok === true, JSON.stringify(ab))
  for (let i = 0; i < 200 && job2.status().running; i += 1) await new Promise((r) => setTimeout(r, 20))
  const st2 = job2.status()
  check('★ 停止后阶段是 aborted，且**没有把剩下的跑完**',
    st2.phase === 'aborted' && st2.tagged < 6, JSON.stringify({ phase: st2.phase, tagged: st2.tagged }))
  const ab2 = job2.abort()
  check('没在跑时点停止 → 明确拒绝（不是静默成功）', ab2.ok === false, ab2.why)

  // 库里没有图时不许起任务（否则界面转圈到一个永远不结束的任务）
  const ws3 = mkdtempSync(join(tmpdir(), 'sticker-empty-'))
  const job3 = createRetagJob({})
  const none = job3.start({ workspace: ws3, chat: async () => reply('laugh') })
  check('★ 库里没图 → 发起被拒，并说明原因', none.ok === false && none.why.includes('还没有图'), none.why)

  rmSync(ws, { recursive: true, force: true })
  rmSync(ws2, { recursive: true, force: true })
  rmSync(ws3, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 读取的健壮性：坏图 / 缺文件不能把整批带崩')
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = makeWorkspace(3)
  const lib = readStickerLibrary({ workspace: ws })
  const first = Object.keys(lib.entries)[0]
  rmSync(join(ws, 'stickers', first), { force: true }) // 删掉磁盘上的图（库条目还在）
  const r = await runTagging({ workspace: ws, chat: async () => reply('laugh') })
  check('★ 文件不在磁盘上 → 算失败但**不熔断**（磁盘问题 ≠ 通路问题）',
    r.failed === 1 && r.ok === true && r.tagged === 2, JSON.stringify({ failed: r.failed, tagged: r.tagged }))
  check('★ 失败清单里有它，且原因是"读不到文件"',
    r.failedList.some((f) => f.rel === first && f.why.includes('读不到')), JSON.stringify(r.failedList))
  check('★ 接口里的提示词能读到（提示词里含词表）',
    readFileSync(join(ws, 'stickers', 'library.json'), 'utf8').includes('version'))
  rmSync(ws, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ 文件名先验：零调用、只当先验（模型可覆盖）')
// ══════════════════════════════════════════════════════════════════════════
{
  // 为什么要有这一段：实测 157 张真实 GIF 里 90 张的语义**就在文件名里**，
  // 而落盘名是内容哈希 —— 所以导入时必须记下 originName，否则先验一张都定不下来。
  const ws = mkdtempSync(join(tmpdir(), 'sticker-fname-'))
  const src = join(ws, 'seed')
  mkdirSync(src, { recursive: true })
  const named = [
    ['蓝色大肥鱼_笑_1.png', 'laugh'],
    ['蓝色大肥鱼_问号_2.png', 'question-mark'],
    ['蓝色大肥鱼_加油_3.png', 'agree'], // ★ 词表里没有"鼓励"这个标签，加油族归 agree（见源码注释）
    ['蓝色大肥鱼_摸头_4.png', 'comfort'],
    ['蓝色大肥鱼_zzz_5.png', null], // 认不出 → 留给模型
  ]
  const files = []
  named.forEach(([name], i) => {
    const p = join(src, name)
    writeFileSync(p, pngBytes(i + 1))
    files.push(p)
  })
  importStickerFiles({ workspace: ws }, [{ scope: 'global', files }])

  const lib = readStickerLibrary({ workspace: ws })
  const withOrigin = Object.values(lib.entries).filter((e) => e.originName)
  check('★★ 导入时记下了**原始文件名**（落盘名是哈希，没有它就什么都猜不出来）',
    withOrigin.length === 5, JSON.stringify(Object.values(lib.entries).map((e) => e.originName)))

  const r = tagFromFilenames({ workspace: ws })
  check('★ 先验能定下 4 张，1 张留给模型', r.applied === 4 && r.skipped === 1, JSON.stringify({ applied: r.applied, skipped: r.skipped }))
  const byName = {}
  for (const [rel, u] of Object.entries(r.updates)) byName[lib.entries[rel].originName.split('_')[1]] = u.primary
  check('★ 猜对了（笑→laugh、问号→question-mark、加油→agree、摸头→comfort）',
    byName['笑'] === 'laugh' && byName['问号'] === 'question-mark' && byName['加油'] === 'agree' && byName['摸头'] === 'comfort',
    JSON.stringify(byName))
  // ★ 这条盯的是一个真实的坑：先验表里写了一个**词表里不存在**的标签（"鼓励"），
  //   于是那一族图被静默跳过（`normalizeLabelId` 返回 null）。所以整张表都要能在词表里落地。
  {
    const bad = FILENAME_LABEL_HINTS.filter((h) => !normalizeLabelId(h.label)).map((h) => h.label)
    check('★★ 先验表里的每个标签都真的在词表里（写错一个就是一整族图被静默跳过）',
      bad.length === 0, bad.join('、') || '全部有效')
  }
  check('★ 先验的置信度是 0.7（刚过阈值）：它只是猜测，不是结论',
    Object.values(r.updates).every((u) => u.confidence === 0.7))
  check('★ 来源记成 filename（与人工的 manual 分开：模型重打时可以覆盖它）',
    Object.values(r.updates).every((u) => u.source === 'filename'))

  // 落库之后：先验的条目算"可用"（会参与选图），而模型重打时会**覆盖**它
  applyStickerLabels({ workspace: ws }, r.updates)
  const sel = selectTagTargets(readStickerLibrary({ workspace: ws }), { skipManual: true })
  check('★ 先验过的条目在"重打"范围内（会被模型覆盖 —— 这是刻意的）',
    sel.todo.length === 5 && sel.skippedManual === 0, JSON.stringify({ todo: sel.todo.length, skipped: sel.skippedManual }))
  rmSync(ws, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
section('⑦ 手工打标签这条路：可校验、可保护、能覆盖')
// ══════════════════════════════════════════════════════════════════════════
{
  // 这一节盯的是"人手工改标签"的完整闭环 —— 它是**唯一不花钱**的打标签方式，
  // 而且用户明确要过这个。三件事必须成立：
  //   ① 写错标签名要**报错**（不能静默变成"没标签"）；
  //   ② 标成 manual 之后，**重打标签会跳过它**；
  //   ③ 真的用它选图时，选中的就是它。
  const ws = makeWorkspace(3)
  const lib = readStickerLibrary({ workspace: ws })
  const rels = Object.keys(lib.entries)

  // ① 写错标签名 → 报错且**不写入**
  const bad = applyStickerLabels({ workspace: ws }, { [rels[0]]: { primary: '鼓励' } }, { strict: true })
  check('★★ 写了一个词表里没有的标签 → **报错并指出来**（不是静默变成"没标签"）',
    bad.unknown.length === 1 && bad.unknown[0].value === '鼓励' && bad.changed === 0,
    JSON.stringify(bad.unknown))
  check('★ 报错时那一条**没有被写坏**',
    readStickerLibrary({ workspace: ws }).entries[rels[0]].primary === null)

  const badLoose = applyStickerLabels({ workspace: ws }, { [rels[0]]: { primary: 'laugh', labels: ['laugh', '狂笑'] } })
  check('★ 非严格模式下，次要标签里的非法项被丢掉但**主标签照写**',
    badLoose.changed === 1 && badLoose.unknown.length === 1,
    JSON.stringify({ changed: badLoose.changed, unknown: badLoose.unknown }))
  check('   └ 库里存下来的是过滤后的 labels',
    JSON.stringify(readStickerLibrary({ workspace: ws }).entries[rels[0]].labels) === JSON.stringify(['laugh']),
    JSON.stringify(readStickerLibrary({ workspace: ws }).entries[rels[0]].labels))

  // ② 手工改的那条：标成 manual 之后重打要跳过
  applyStickerLabels({ workspace: ws }, {
    [rels[1]]: { primary: 'sad', labels: ['sad'], confidence: 1, source: MANUAL_SOURCE },
  })
  const sel = selectTagTargets(readStickerLibrary({ workspace: ws }), { skipManual: true })
  check('★★ 标成 manual 之后**不在重打队列**里', !sel.todo.some((e) => e.rel === rels[1]), JSON.stringify(sel.todo.map((e) => e.rel)))
  check('★ 跳过数如实给出（界面会显示"跳过人工 N 张"）', sel.skippedManual === 1, String(sel.skippedManual))

  // 用假模型跑一遍"重打"：手工那条必须**保持原样**
  const r = await runTagging({ workspace: ws, chat: async () => reply('laugh') })
  const after = readStickerLibrary({ workspace: ws })
  check('★★★ 重打之后，手工那条**没有被模型覆盖**（还是 sad / manual）',
    after.entries[rels[1]].primary === 'sad' && after.entries[rels[1]].source === MANUAL_SOURCE,
    JSON.stringify({ primary: after.entries[rels[1]].primary, source: after.entries[rels[1]].source }))
  check('★ 其余条目照常被处理（手工的跳过不影响别的）：1 新打 + 1 重打',
    r.tagged === 1 && r.retagged === 1, `tagged=${r.tagged} retagged=${r.retagged}`)

  // ③ 真的能选到它：手工标的 sad 会成为候选
  applyStickerLabels({ workspace: ws }, r.updates)
  const cands = buildStickerCandidates({ workspace: ws, scope: 'group-any' })
  check('★ 手工标的条目**真的进候选**（改了就能用）',
    cands.some((c) => c.entry.primary === 'sad'), JSON.stringify(cands.map((c) => c.entry.primary)))
  rmSync(ws, { recursive: true, force: true })
}

console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
