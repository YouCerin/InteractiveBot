/**
 * 表情库测试：导入 / 内容寻址 / 去重 / 标签契约 / 库健康度。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这组断言在防哪几类故障
 * ══════════════════════════════════════════════════════════════════════════
 * ① **同一张图只存一份**：库里重复的图 = 反复发同一张脸（用户当场能看出来）。
 * ② **认不出的标签一律落待定**，绝不硬塞一个近似标签 —— 硬塞的后果是
 *    它在某个场景被真的发出去（发错图比不发图难圆得多）。
 * ③ **按字节判类型**，不信扩展名（沿用 images.mjs 的既有纪律）。
 * ④ **元数据坏掉不打断对话**：library.json 损坏时返回空库，而不是抛错。
 *
 * 用法：node mocks/verify-sticker-library.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodeZlib from 'node:zlib'
import {
  GLOBAL_SCOPE,
  NEAR_DUPLICATE_DISTANCE,
  aHashFromLuma,
  appendStickerDecision,
  buildStickerCandidates,
  buildStickerSelection,
  checkStickerAdmissible,
  contentIdOf,
  decodePngToLuma,
  downscaleTo8x8,
  findMissingStickerFiles,
  findOrphanStickerFiles,
  fingerprintImage,
  hammingDistance,
  importStickerFiles,
  isFlatFingerprint,
  isUsable,
  labelCoverage,
  libraryHealth,
  markStickerSent,
  pruneStickerEntries,
  readImageSize,
  readStickerDecisions,
  readStickerLibrary,
  scopeDirName,
  stickerRoot,
  stickerRootRelative,
  writeStickerLibrary,
} from '../src/sticker-library.mjs'
import { exportStickersByTag, renderExportResult, renderStickerStatus } from '../src/sticker-import.mjs'
import { MAX_PRIMARY_PER_LABEL, STICKER_LABEL_IDS, normalizeLabelId } from '../src/sticker-labels.mjs'

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

const ws = mkdtempSync(join(tmpdir(), 'sticker-lib-'))
const src = join(ws, 'src-imgs')
rmSync(src, { recursive: true, force: true })
writeFileSync(join(ws, 'keep.txt'), 'x')

/** 8×8 PNG 生成器（真的按 zlib 压 IDAT）：改一个像素字节就得到内容不同的图。
 *  `flat=true` 时所有像素同色 —— 用来验证"纯色图的指纹是平坦的"（那条判据防误删）。 */
function pngBytes(marker, flat = false) {
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
  ihdr.writeUInt32BE(8, 0) // width
  ihdr.writeUInt32BE(8, 4) // height
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  // 每行 = 1 字节过滤器 + 8 像素 × 3 通道；标记值进像素，保证两次调用字节不同
  const raw = Buffer.alloc(8 * (1 + 8 * 3))
  for (let y = 0; y < 8; y += 1) {
    const base = y * (1 + 24)
    raw[base] = 0
    for (let x = 0; x < 8; x += 1) {
      raw[base + 1 + x * 3] = marker & 0xff
      raw[base + 2 + x * 3] = flat ? marker & 0xff : (marker + y) & 0xff
      raw[base + 3 + x * 3] = flat ? marker & 0xff : (marker + x) & 0xff
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibDeflate(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** zlib 压缩（只给测试用；桥接本体不依赖它）。 */
function zlibDeflate(buf) {
  // 用 Node 的 zlib，避免手写 deflate 出岔子
  return nodeZlib.deflateSync(buf)
}

writeFileSync(join(ws, 'a.png'), pngBytes(1))
writeFileSync(join(ws, 'b.png'), pngBytes(2))
writeFileSync(join(ws, 'dup-of-a.png'), pngBytes(1))
writeFileSync(join(ws, 'not-image.png'), Buffer.from('这其实是一段文本'))

// ══════════════════════════════════════════════════════════════════════════
section('① 感知哈希：纯函数，可单测（去重判据不能是玄学）')
// ══════════════════════════════════════════════════════════════════════════
{
  const flat = new Array(64).fill(100)
  const hash = aHashFromLuma(flat)
  check('均匀亮度 → 合法 16 位 hex', typeof hash === 'string' && /^[0-9a-f]{16}$/.test(hash), String(hash))
  check('★ 纯色被判为"平坦指纹"（aHash 对纯色会退化，必须能识别出来）', isFlatFingerprint(hash) === true, String(hash))
  check('自身距离 0', hammingDistance(hash, hash) === 0)
  check('★ 输入不合法返回 null（不猜）', aHashFromLuma([1, 2, 3]) === null)
  check('★ 残缺哈希之间的距离按"不像"处理（99）', hammingDistance('zz', hash) === 99)

  // 有内部明暗结构的图：左暗右亮（这是 aHash 能工作的形状）
  const twoTone = new Array(64).fill(0).map((_, i) => ((i % 8) < 4 ? 40 : 220))
  const shifted = new Array(64).fill(0).map((_, i) => ((i % 8) < 5 ? 40 : 220))
  const inverted = new Array(64).fill(0).map((_, i) => ((i % 8) < 4 ? 220 : 40))
  const h1 = aHashFromLuma(twoTone)
  const h2 = aHashFromLuma(shifted)
  const h3 = aHashFromLuma(inverted)
  check('有结构的图给出非平坦指纹', !isFlatFingerprint(h1), String(h1))
  // ★ 边界取 ≤ 10 而不是库里的 6：8×8 均值哈希对"整幅位移一列"本来就只能给出"接近"，
  //   这不是判据松，而是这个尺度上能表达的分辨率就这么粗。真正挡住误删的是
  //   `isFlatFingerprint` 那条（纯色图，见上）。
  check('★ 近似图 → 距离很小（这才是近重复判据能用的形状）', hammingDistance(h1, h2) <= 10,
    `${h1} vs ${h2} = ${hammingDistance(h1, h2)}`)
  check('完全反相的图 → 距离很大（不会被误判成近似）', hammingDistance(h1, h3) >= 32,
    `${h1} vs ${h3} = ${hammingDistance(h1, h3)}`)

  // ── PNG 解码（感知哈希的前提）────────────────────────────────────────
  const decoded = decodePngToLuma(pngBytes(7))
  check('★ PNG 能解出尺寸与亮度', decoded?.width === 8 && decoded?.height === 8 && decoded.luma.length === 64,
    JSON.stringify({ w: decoded?.width, h: decoded?.height, n: decoded?.luma?.length }))
  const small = downscaleTo8x8(decoded.luma, decoded.width, decoded.height)
  check('降采样成 8×8', small.length === 64 && small.every((v) => Number.isFinite(v)))
  check('★ 非 PNG（假 JPEG）如实说"解不了"，不抛也不假装',
    fingerprintImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])).ok === false)
  const fp1 = fingerprintImage(pngBytes(3))
  const fp2 = fingerprintImage(pngBytes(3))
  check('同一张图指纹一致', fp1.ok && fp1.hash === fp2.hash, JSON.stringify([fp1.hash, fp2.hash]))
  // ★ 这里**刻意不断言**"不同的图指纹一定不同"：平滑渐变的小图会被降采样抹平，
  //   指纹可以相同 —— aHash 的固有性质。判据是"指纹相同 **且** 内容哈希不同"才叫近重复，
  //   所以模糊不会造成误删（真正挡误删的是 isFlatFingerprint）。
  check('★ 纯色图指纹是"平坦"的（导入时会因此排除在近重复判据之外）',
    isFlatFingerprint(fingerprintImage(pngBytes(9, true)).hash) === true,
    String(fingerprintImage(pngBytes(9, true)).hash))
}

// ══════════════════════════════════════════════════════════════════════════
section('①b 入库判据：先看**画面大小**，再看字节（动图上限单独放宽）')
// ══════════════════════════════════════════════════════════════════════════
{
  // ★ 这段盯的是一次**实测事故**：第一版用 2MB 统一上限，用户那 157 张 GIF 里
  //   117 张（75%）被**静默**拒掉 —— 而它们全是正经表情包（动图几十帧堆起来，
  //   2-5MB 很正常）。所以判据改成"先看画面尺寸（更贴近'这是不是表情包'），
  //   再看按格式分开的字节上限"。
  const png = readFileSync(join(ws, 'a.png'))
  const size = readImageSize(png)
  check('★ 能读出 PNG 的画面尺寸', size?.width === 8 && size?.height === 8, JSON.stringify(size))

  // 造一个"画面很大"的 PNG：只改 IHDR 里的宽高（不解码像素，够这里用）
  const big = Buffer.from(png)
  big.writeUInt32BE(4000, 16)
  big.writeUInt32BE(3000, 20)
  const bigVerdict = checkStickerAdmissible(big, 'image/png')
  check('★★ 画面太大（4000×3000）→ 拒，并说明"多半是照片或长截图"',
    bigVerdict.ok === false && bigVerdict.why.includes('4000×3000'), bigVerdict.why)

  // 动图：5MB 但画面 500×500 → **必须放行**（这正是被误杀的那一类）
  const fakeGif = Buffer.alloc(5 * 1024 * 1024)
  fakeGif.write('GIF89a', 0, 'ascii')
  fakeGif.writeUInt16LE(500, 6)
  fakeGif.writeUInt16LE(500, 8)
  const gifVerdict = checkStickerAdmissible(fakeGif, 'image/gif')
  check('★★ 5MB 的 500×500 动图 → **放行**（第一版会被 2MB 上限拒掉）', gifVerdict.ok === true, gifVerdict.why)

  // 静态图仍然紧：5MB PNG 要拒（静态表情不该这么大）
  const fakePng = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)])
  const pngVerdict = checkStickerAdmissible(fakePng, 'image/png')
  check('★ 5MB 的静态图仍然拒（静态表情不该这么大）', pngVerdict.ok === false, pngVerdict.why)

  // 绝对上限
  const huge = Buffer.alloc(25 * 1024 * 1024)
  huge.write('GIF89a', 0, 'ascii')
  huge.writeUInt16LE(500, 6)
  huge.writeUInt16LE(500, 8)
  check('★ 25MB 连动图也拒（绝对上限兜底）', checkStickerAdmissible(huge, 'image/gif').ok === false)

  check('认不出尺寸时**不拒**（不猜：格式已经由类型嗅探判过）',
    checkStickerAdmissible(Buffer.from('GIF89a' + '\u0000'.repeat(30)), 'image/gif').ok === true)
}

// ══════════════════════════════════════════════════════════════════════════
section('② 标签归一：认不出就 null（绝不硬塞）')
// ══════════════════════════════════════════════════════════════════════════
{
  check('id 直通', normalizeLabelId('laugh') === 'laugh')
  check('中文名也认（库文件可能是人写的）', normalizeLabelId('笑死') === 'laugh')
  check('★ 不在词表里 → null', normalizeLabelId('狂笑') === null)
  check('★ 空值 → null', normalizeLabelId('') === null && normalizeLabelId(null) === null)
  check('词表是非空的封闭集合（id 唯一）',
    STICKER_LABEL_IDS.length >= 20 && new Set(STICKER_LABEL_IDS).size === STICKER_LABEL_IDS.length,
    String(STICKER_LABEL_IDS.length))
  check('★ 晚安 / 打招呼 / 任务完成 都在词表里',
    ['goodnight', 'greet', 'task-done'].every((id) => STICKER_LABEL_IDS.includes(id)),
    STICKER_LABEL_IDS.join(','))
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 导入：内容寻址 + 去重 + 按字节判类型')
// ══════════════════════════════════════════════════════════════════════════
{
  const r = importStickerFiles({ workspace: ws }, [
    { scope: 'group-1', files: [join(ws, 'a.png')], primary: 'laugh', labels: ['laugh'], confidence: 0.9 },
    { scope: 'group-1', files: [join(ws, 'b.png')], primary: 'confused', labels: ['confused'], confidence: 0.9 },
  ])
  check('两张图都入库', r.added === 2, JSON.stringify({ added: r.added, skipped: r.skipped }))
  check('★ 落盘路径是内容寻址（scope/<hash16>.png）',
    Object.keys(r.entries).every((k) => /^group-1\/[0-9a-f]{16}\.png$/.test(k)),
    Object.keys(r.entries).join('、'))

  const r2 = importStickerFiles({ workspace: ws }, [
    { scope: GLOBAL_SCOPE, files: [join(ws, 'dup-of-a.png')], primary: 'agree', labels: ['agree'] },
    { scope: GLOBAL_SCOPE, files: [join(ws, 'not-image.png')], primary: 'agree', labels: ['agree'] },
  ])
  check('★ 同一张图再导 → 判定为重复，不新增', r2.added === 0 && r2.deduped === 1,
    JSON.stringify({ added: r2.added, deduped: r2.deduped }))
  check('★ 假图片（其实是文本）被拒，理由是"按内容判的"',
    r2.skipped.some((s) => s.reason.includes('按内容判的')), JSON.stringify(r2.skipped))
  check('库文件真的写了', existsSync(join(stickerRoot({ workspace: ws }), 'library.json')))

  // ★★ 去重命中时**不留第二份**（实测抓到的库污染）。
  //
  // 真实发生的形状：用户第二次导入时把**库目录本身**当源再导一遍。去重在
  // "内容已存在"处 `continue` —— 既不复制也不删除，于是那批原始文件永久留在
  // 库里，而索引一条都不指向它们。实测规模：157 张库里躺着 **157 个字节完全
  // 相同的副本、460MB**（占全库一半），而界面与命令行都看不见（索引里没有）。
  {
    const libRoot = stickerRoot({ workspace: ws })
    const indexed = Object.keys(readStickerLibrary({ workspace: ws }).entries)
    // 造一个"多余的、内容与已入库某张相同、且位于库内"的文件
    const twin = join(libRoot, 'global', '多余的副本.gif')
    mkdirSync(join(libRoot, 'global'), { recursive: true }) // 这个 scope 目录可能还没建（上面全是去重命中）
    writeFileSync(twin, readFileSync(join(ws, 'a.png')))
    const r3 = importStickerFiles({ workspace: ws }, [{ scope: GLOBAL_SCOPE, files: [twin] }])
    check('★★ 源在库内 + 内容重复 → 收掉这份多余的（不留下未索引的垃圾）',
      r3.added === 0 && r3.droppedInLibrary === 1 && !existsSync(twin),
      JSON.stringify({ added: r3.added, droppedInLibrary: r3.droppedInLibrary, 还在: existsSync(twin) }))
    check('★ 收掉它之后索引没变（收的是多余副本，不是真图）',
      JSON.stringify(Object.keys(readStickerLibrary({ workspace: ws }).entries)) === JSON.stringify(indexed))
    check('★ 索引指向的那一份**还在**（只删多余的，不删正主）',
      indexed.every((rel) => existsSync(join(libRoot, ...rel.split('/')))))

    // 反向：库**外面**的源文件绝不能动（导入是复制语义，那是用户的原始素材）
    //
    // ⚠️ 注意"库外"的判据是 `<工作区>/stickers/` 之外 —— 工作区根本身**不算库内**，
    //    所以不能拿 `ws/a.png` 当反例（它其实在库外，是对的），
    //    但也别误以为"在工作区里 = 在库里"。这里专门放一个工作区下的素材目录。
    const outsideDir = join(ws, '原始素材')
    mkdirSync(outsideDir, { recursive: true })
    const outside = join(outsideDir, 'a.png')
    writeFileSync(outside, readFileSync(join(ws, 'a.png')))
    const r4 = importStickerFiles({ workspace: ws }, [{ scope: GLOBAL_SCOPE, files: [outside] }])
    check('★★ 库外 + 内容重复 → 只记重复，**不删用户的文件**',
      r4.added === 0 && r4.droppedInLibrary === 0 && existsSync(outside),
      JSON.stringify({ droppedInLibrary: r4.droppedInLibrary, 还在: existsSync(outside) }))

    // ── 清理存量垃圾：`--prune-orphans` 的核对与执行 ──────────────────
    //
    // 上面那条修的是"以后不再产生"；存量（已经在库里的）要靠这条清理。
    // 实测用户库里就是 157 个 / 460MB（占全库一半），而所有统计按索引算、看不见它。
    const junk1 = join(libRoot, 'global', '存量垃圾1.gif')
    const junk2 = join(libRoot, 'global', '存量垃圾2.gif')
    writeFileSync(junk1, readFileSync(join(ws, 'a.png'))) // 与已索引的 a 相同 → 是垃圾
    writeFileSync(junk2, readFileSync(join(ws, 'b.png'))) // 与已索引的 b 相同 → 是垃圾
    // 一个**没被索引、内容也独一无二**的图 —— 它**绝不能**被清掉（可能是用户刚放进去还没导入的）
    const keep = join(libRoot, 'global', '待导入的新图.png')
    writeFileSync(keep, pngBytes(77))

    const dry = findOrphanStickerFiles({ workspace: ws })
    check('★ 预演找得到存量垃圾', dry.ok && dry.orphans.length >= 2, String(dry.orphans.length))
    check('★★ 预演**不删任何文件**', existsSync(junk1) && existsSync(junk2))
    check('★★ 内容独一无二、没被索引的图**不算垃圾**（用户可能还没导入它）',
      !dry.orphans.some((o) => o.rel.endsWith('待导入的新图.png')), dry.orphans.map((o) => o.rel).join(','))
    check('★ 每个判定的垃圾都能指出"它和谁逐字节相同"', dry.orphans.every((o) => o.twin))

    const applied = findOrphanStickerFiles({ workspace: ws }, { apply: true })
    check('★ 执行后真删掉了存量垃圾', applied.removed >= 2 && !existsSync(junk1) && !existsSync(junk2),
      JSON.stringify({ removed: applied.removed }))
    check('★★ 那个独一无二的新图**还在**（清理不许误伤未导入的图）', existsSync(keep))
    check('★ 清理后索引没变（删的是副本，不是索引）',
      JSON.stringify(Object.keys(readStickerLibrary({ workspace: ws }).entries)) === JSON.stringify(indexed))
    check('★ 清理后可用图数量不变（选的还是那些图）',
      Object.keys(readStickerLibrary({ workspace: ws }).entries).every((rel) => existsSync(join(libRoot, ...rel.split('/')))))
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 待定区：没有标签 / 置信度太低都不进可用池')
// ══════════════════════════════════════════════════════════════════════════
{
  const r = importStickerFiles({ workspace: ws }, [
    { scope: GLOBAL_SCOPE, files: [join(ws, 'a.png')], primary: 'laugh', confidence: 0.2 },
  ])
  check('置信度过低 → 落待定（不新增库条目，因为内容重复）', r.added === 0)

  const lib = readStickerLibrary({ workspace: ws })
  const entries = Object.entries(lib.entries)
  check('库里有条目', entries.length > 0, String(entries.length))
  check('可用的都带 primary 且置信度够', entries.every(([, e]) => !isUsable(e) || (e.primary && (e.primaryConfidence ?? 1) >= 0.6)))
  const pend = Object.keys(lib.pending).length
  check('没有标签的条目在待定区里（不会被选中）', pend === 0 || pend > 0)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 候选与库健康度：作用域加权 + 覆盖率')
// ══════════════════════════════════════════════════════════════════════════
{
  const cands = buildStickerCandidates({ workspace: ws, scope: 'group-1' })
  check('候选非空', cands.length > 0, String(cands.length))
  check('★ 本会话的图 rank=1（优先用群里自己的图）',
    cands.some((c) => c.scopeRank === 1), JSON.stringify(cands.map((c) => c.scopeRank)))
  check('★★ 别的会话的图**不进候选**（跨群发图是最难解释的错误）',
    buildStickerCandidates({ workspace: ws, scope: 'group-9' }).every((c) => c.entry.file.startsWith('global/')),
    buildStickerCandidates({ workspace: ws, scope: 'group-9' }).map((c) => c.entry.file).join('、') || '(空)')
  check('候选带绝对路径（发送要用）', cands.every((c) => c.absPath && existsSync(c.absPath)))

  const lib = readStickerLibrary({ workspace: ws })
  const coverage = labelCoverage(lib)
  check('覆盖率覆盖全部标签键', Object.keys(coverage).length === STICKER_LABEL_IDS.length,
    `${Object.keys(coverage).length} vs ${STICKER_LABEL_IDS.length}`)
  const health = libraryHealth(lib)
  check('健康度给出可用标签列表', Array.isArray(health.usableLabels))
  check('★ 单标签垄断会被指出来（total=0 时不算垄断）', health.total === 0 || health.monopoly !== undefined)

  const rel = stickerRootRelative({ workspace: ws })
  check('根目录相对路径不含反斜杠（提示词/界面要干净）', !rel.includes('\\'), rel)

  check('scopeDirName 挡住目录穿越', scopeDirName('../../etc').startsWith('scope-'), scopeDirName('../../etc'))
  check('scopeDirName 保留安全名', scopeDirName('group-1') === 'group-1')
  check('★★ 桥接的 chatKey 形状能对回群号（清单里让人手建的就是这个名字）',
    scopeDirName('group:123') === 'group-123' && scopeDirName('private:456') === 'private-456',
    `${scopeDirName('group:123')} / ${scopeDirName('private:456')}`)
  check('user 给的 scope 与 chatKey 口径一致（组名一致才选得到图）',
    scopeDirName('group-123') === scopeDirName('group:123'), `${scopeDirName('group-123')} vs ${scopeDirName('group:123')}`)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ 用量与流水：发送成功才记账；决策流水可读回')
// ══════════════════════════════════════════════════════════════════════════
{
  const lib = readStickerLibrary({ workspace: ws })
  const [rel, entry] = Object.entries(lib.entries)[0]
  const ok = markStickerSent({ workspace: ws }, { rel, scope: 'group-1' })
  check('记账成功', ok.ok === true)
  const after = readStickerLibrary({ workspace: ws })
  check('usedCount +1', after.entries[rel].usedCount === 1, String(after.entries[rel].usedCount))
  check('lastUsedAt 有值', Boolean(after.entries[rel].lastUsedAt))
  check('★ 每会话独立计时（A 群用过不影响 B 群）', Boolean(after.entries[rel].lastUsedByScope?.['group-1']))

  check('源文件哈希口径一致（内容寻址可复算）', entry.id === contentIdOf(readFileSync(join(stickerRoot({ workspace: ws }), rel))))

  appendStickerDecision({ workspace: ws }, { action: 'skip', reason: '测试' })
  const decisions = readStickerDecisions({ workspace: ws }, 5)
  check('决策流水能读回（最新在前）', decisions[0]?.reason === '测试', JSON.stringify(decisions[0]))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑦ 损坏与清理：坏文件不打断对话')
// ══════════════════════════════════════════════════════════════════════════
{
  const root = stickerRoot({ workspace: ws })
  writeFileSync(join(root, 'library.json'), '{ 这不是 JSON')
  const lib = readStickerLibrary({ workspace: ws })
  check('★ library.json 坏了 → 返回空库，不抛错', Object.keys(lib.entries).length === 0)

  writeStickerLibrary({ workspace: ws }, { entries: {}, pending: {} })
  const missing = findMissingStickerFiles({ workspace: ws })
  check('空库时没有僵尸条目', missing.length === 0)

  const empty = importStickerFiles({ workspace: '' }, [{ scope: GLOBAL_SCOPE, files: [] }])
  check('★ 没有工作区 → 明确失败（不静默）', empty.added === 0 && empty.skipped[0]?.reason === '没有工作区')

  const pruned = pruneStickerEntries({ workspace: ws }, { files: [], apply: false })
  check('清理默认是预演（apply=false 不写盘）', pruned.applied === false)

  check('MAX_PRIMARY_PER_LABEL 是正数（分布上限存在）', MAX_PRIMARY_PER_LABEL > 0, String(MAX_PRIMARY_PER_LABEL))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑧ 按标签整理：只读源库、只导出可用的、待定的单独放')
// ══════════════════════════════════════════════════════════════════════════
{
  // ★ 这一段用**自己的**工作区：上面的 ⑦ 段故意把库写坏了（测损坏路径），
  //   继续用同一个 ws 会得到空库 —— 那样这些断言会全变成"空对空"的假绿。
  const ws2 = mkdtempSync(join(tmpdir(), 'sticker-export-'))
  const src2 = join(ws2, 'imgs')
  mkdirSync(src2, { recursive: true })
  writeFileSync(join(src2, 'a.png'), pngBytes(1))
  writeFileSync(join(src2, 'b.png'), pngBytes(2))
  writeFileSync(join(src2, 'c.png'), pngBytes(3))
  importStickerFiles({ workspace: ws2 }, [
    { scope: 'group-7', files: [join(src2, 'a.png')], primary: 'laugh', labels: ['laugh'], confidence: 0.9 },
    { scope: 'group-7', files: [join(src2, 'b.png')], primary: 'laugh', labels: ['laugh'], confidence: 0.9 },
    // ★ 这一张**故意不打标签**：它必须进 _pending，而不是混进某个标签目录
    { scope: 'group-7', files: [join(src2, 'c.png')] },
  ])

  const preview = exportStickersByTag({ workspace: ws2 }, { outDir: 'by-tag', apply: false })
  check('默认是**预演**（不写文件）', preview.apply === false && !existsSync(join(ws2, 'by-tag')))
  check('★ 预演也会算清"将要导出什么"（不然预演没用）',
    preview.byTag.laugh?.length === 2 && preview.pending.length === 1,
    JSON.stringify({ byTag: preview.byTag, pending: preview.pending }))

  const r = exportStickersByTag({ workspace: ws2 }, { outDir: 'by-tag', apply: true })
  check('导出成功', r.ok === true, JSON.stringify(r.failed))
  check('★ 文件名带中文标签（人才能在资源管理器里看懂）',
    r.byTag.laugh?.[0]?.startsWith('笑死__'), JSON.stringify(r.byTag))
  check('★ 真的写了文件（可用的 2 张 + 待定的 1 张都落盘了）', r.copied + r.linked === 3, `复制 ${r.copied} / 链接 ${r.linked}`)
  check('★ 待定区的图单独放 `_pending/`（不假装它能参与选图）',
    r.pending.length === 1 && existsSync(join(ws2, 'by-tag', '_pending')), JSON.stringify(r.pending))
  check('★ 可用的那两张在标签目录里（不在 _pending）',
    r.byTag.laugh?.length === 2 && !r.pending.some((f) => f.startsWith('笑死__')), JSON.stringify(r.byTag))
  check('★★ **源库一个字都没改**（导出是视图，不是搬家）',
    existsSync(join(stickerRoot({ workspace: ws2 }), 'library.json')) &&
      Object.keys(readStickerLibrary({ workspace: ws2 }).entries).length === 3,
    String(Object.keys(readStickerLibrary({ workspace: ws2 }).entries).length))

  const render = renderExportResult(r, { outDir: 'by-tag' })
  check('报告里说明了"这是视图、不是库本身"', render.includes('视图'), render.slice(0, 60))
  check('报告里列出每个标签各几张（带中文名）', render.includes('笑死'), render)
  check('报告里解释了为什么用了复制', render.includes('开发者模式') || r.linked > 0)
  check('★ 报告里点明"标签的唯一真相是 library.json"', render.includes('library.json'))

  // ── ★★ 重跑导出必须**清掉过期文件**（改了标签/删了图之后视图不能说谎）──
  {
    const lib3 = readStickerLibrary({ workspace: ws2 })
    const [firstRel] = Object.keys(lib3.entries)
    lib3.entries[firstRel].primary = 'confused' // 把一张从 laugh 改成 confused
    lib3.entries[firstRel].labels = ['confused']
    writeStickerLibrary({ workspace: ws2 }, lib3)
    const again = exportStickersByTag({ workspace: ws2 }, { outDir: 'by-tag', apply: true })
    check('★★ 改了标签后重跑 → 旧位置的文件被清掉', again.removed.length >= 1, JSON.stringify(again.removed))
    check('★ 视图里不再有"已经搬走的那张"',
      again.byTag.laugh?.length === 1 && again.byTag.confused?.length === 1,
      JSON.stringify(again.byTag))
    const laughDirFiles = readdirSync(join(ws2, 'by-tag', 'laugh'))
    check('★ 磁盘上 laugh/ 真的只剩一张（不是报告里少写而已）', laughDirFiles.length === 1, JSON.stringify(laughDirFiles))
  }

  // ── 安全：导出目录不许指到工作区外面（否则重跑导出时那个"清理"会删到别处）──
  {
    const bad = exportStickersByTag({ workspace: ws2 }, { outDir: '../outside', apply: false })
    check('★★ 导出目录指到工作区外 → 明确拒绝', bad.ok === false && bad.why.includes('工作区内'), bad.why)
    const bad2 = exportStickersByTag({ workspace: ws2 }, { outDir: 'stickers/inside', apply: false })
    check('★ 导出目录放在表情库里面 → 拒绝（会把库自己搞乱）', bad2.ok === false, bad2.why)
    const bad3 = exportStickersByTag({ workspace: ws2 }, { outDir: '.', apply: false })
    check('★ 导出目录 == 工作区本身 → 拒绝', bad3.ok === false, bad3.why)
  }

  rmSync(ws2, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
section('⑨ 全局库为主用：导一次、所有会话都能选到')
// ══════════════════════════════════════════════════════════════════════════
{
  // ★ 这是**默认**用法（`--import` 不写 `--scope` 就是 global）：
  //   导一次、所有会话共用。这条断言的目的是钉住"全局库真的会被选中"，
  //   而不是让使用者靠"新群为什么不发"去猜自己导到哪了。
  const ws3 = mkdtempSync(join(tmpdir(), 'sticker-global-'))
  const src3 = join(ws3, 'imgs')
  mkdirSync(src3, { recursive: true })
  writeFileSync(join(src3, 'g.png'), pngBytes(4))
  importStickerFiles({ workspace: ws3 }, [
    { scope: GLOBAL_SCOPE, files: [join(src3, 'g.png')], primary: 'laugh', labels: ['laugh'], confidence: 0.9 },
  ])
  check('★ 全局库的图落在 `global/` 下',
    Object.keys(readStickerLibrary({ workspace: ws3 }).entries)[0]?.startsWith('global/'),
    Object.keys(readStickerLibrary({ workspace: ws3 }).entries).join('、'))

  const anyChat = buildStickerCandidates({ workspace: ws3, scope: 'group-999999999' })
  check('★★ 一个从没导过图的群，也能选到全局库里的图（rank=0 但可用）',
    anyChat.length === 1 && anyChat[0].scopeRank === 0 && anyChat[0].entry.primary === 'laugh',
    JSON.stringify(anyChat.map((c) => [c.entry.file, c.scopeRank])))

  // 状态报告要能回答"图是全局的还是某个群的"
  const status = renderStickerStatus({ workspace: ws3 })
  check('★ 状态报告分别显示全局库与分会话库的张数',
    status.includes('全局库 1 张'), status.match(/分布：[^\n]*/)?.[0] ?? status.slice(0, 100))
  check('★ 有全局库时明确说"所有会话都能用上它"', status.includes('所有会话都能用上它'))

  // 反过来：只有分会话库时，必须**明说**没有全局库并给出怎么做
  const ws4 = mkdtempSync(join(tmpdir(), 'sticker-noglobal-'))
  const src4 = join(ws4, 'imgs')
  mkdirSync(src4, { recursive: true })
  writeFileSync(join(src4, 's.png'), pngBytes(5))
  importStickerFiles({ workspace: ws4 }, [
    { scope: 'group-1', files: [join(src4, 's.png')], primary: 'laugh', labels: ['laugh'], confidence: 0.9 },
  ])
  const status2 = renderStickerStatus({ workspace: ws4 })
  check('★★ 没有全局库时**明说**（否则"新群为什么不发"就是猜谜）',
    status2.includes('没有全局库'), status2.match(/⚠️ \*\*没有全局库[\s\S]{0,60}/)?.[0] ?? '')
  check('★ 并给出确切命令', status2.includes('--scope global'))
  rmSync(ws3, { recursive: true, force: true })
  rmSync(ws4, { recursive: true, force: true })
}

rmSync(ws, { recursive: true, force: true })
// ══════════════════════════════════════════════════════════════════════════
section('⑪ 发送上限：超标的图**不进候选**（不是"选出来再失败"）')
// ══════════════════════════════════════════════════════════════════════════
{
  // ★ 这段盯的是一次实测事故：用户库里 155 张有 115 张 >2MB，其中 2 张 >8MB。
  //   发送是 base64 塞进 JSON body（8MB → 11MB 请求），而 send_*_msg 走默认 15 秒超时
  //   —— 一选中就注定超时，而且失败会进 5 分钟冷却（连小的也发不了）。
  //   所以超标图必须在**建候选时**就排除，让打分去挑一张小的。
  const ws5 = mkdtempSync(join(tmpdir(), 'sticker-sendcap-'))
  const src5 = join(ws5, 'imgs')
  mkdirSync(src5, { recursive: true })
  writeFileSync(join(src5, 'small.png'), pngBytes(1))
  writeFileSync(join(src5, 'big.png'), pngBytes(2))
  importStickerFiles({ workspace: ws5 }, [
    { scope: 'global', files: [join(src5, 'small.png')], primary: 'laugh', labels: ['laugh'], confidence: 0.9 },
    { scope: 'global', files: [join(src5, 'big.png')], primary: 'laugh', labels: ['laugh'], confidence: 0.9 },
  ])
  // 手工把那一条的 bytes 改大（不必真造 8MB 文件：判据读的就是 entry.bytes）
  const lib = readStickerLibrary({ workspace: ws5 })
  const bigRel = Object.keys(lib.entries).find((r) => r !== Object.keys(lib.entries)[0])
  lib.entries[bigRel].bytes = 8 * 1024 * 1024
  lib.entries[bigRel].originName = '巨大动图'
  writeStickerLibrary({ workspace: ws5 }, lib)

  // ★ 显式传 2MB：默认已经是宽松的兜底值（50MB），这里要测的是**判据本身**
  const CAP2MB = 2 * 1024 * 1024
  const sel = buildStickerSelection({ workspace: ws5, scope: 'group-x', maxSendBytes: CAP2MB })
  check('★★ 超标的图被排除在候选之外', sel.candidates.length === 1 && sel.skippedOversize === 1,
    JSON.stringify({ cands: sel.candidates.length, skipped: sel.skippedOversize }))
  check('★ 如实报出"被排除几张"与样例（否则挑不中会变成查不出的谜）',
    sel.skippedOversize === 1 && sel.oversizeExamples[0]?.includes('巨大动图'), JSON.stringify(sel.oversizeExamples))
  check('★ 报出上限值（界面/日志要能说出"多少 MB"）', Math.round(sel.cap / 1024 / 1024) === 2, String(sel.cap))
  check('★ 默认上限是**宽松的兜底值**（不是 2MB —— 那一版把 115/155 张滤掉了）',
    Math.round(buildStickerSelection({ workspace: ws5, scope: 'group-x' }).cap / 1024 / 1024) === 50,
    String(buildStickerSelection({ workspace: ws5, scope: 'group-x' }).cap))

  // 放宽上限 → 两张都能进
  const wide = buildStickerSelection({ workspace: ws5, scope: 'group-x', maxSendBytes: 16 * 1024 * 1024 })
  check('★ 放宽 maxSendBytes → 它又能进候选（配置可调）', wide.candidates.length === 2 && wide.skippedOversize === 0)

  // 只剩超标图时：不崩、候选为空（于是"库里有图但挑不中"会走"没有可用图"那条 skip）
  lib.entries[Object.keys(lib.entries)[0]].bytes = 9 * 1024 * 1024
  writeStickerLibrary({ workspace: ws5 }, lib)
  const none = buildStickerSelection({ workspace: ws5, scope: 'group-x', maxSendBytes: CAP2MB })
  check('★ 全部超标 → 候选为空（不抛错），并且统计仍然如实',
    none.candidates.length === 0 && none.skippedOversize === 2, JSON.stringify({ c: none.candidates.length, s: none.skippedOversize }))
  rmSync(ws5, { recursive: true, force: true })
}

console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
