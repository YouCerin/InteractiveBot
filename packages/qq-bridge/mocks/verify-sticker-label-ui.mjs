/**
 * 人工标注台（`sticker-label/`）测试：**独立工具那条路**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这组断言在防什么（它是个"手会乱点"的界面，所以每条都要有底线）
 * ══════════════════════════════════════════════════════════════════════════
 *   ① **写回就是写回**：点一下标签，`library.json` 里那一条变成 manual
 *      —— 因为"标了 manual 才不会被模型重打覆盖"是这工具存在的意义。
 *   ② **不猜**：不是词表里的标签 → 422 且**一个字都不改**（页面据此提示）。
 *   ③ **撤销要真的撤**：把"改前快照"放回去（含空标签与来源）。
 *   ④ **图片不许越界**：`/img/../../config.json` 这类请求必须 403/404，
 *      不能把库外面的文件当静态资源吐出去。
 *   ⑤ **只读列表**：`GET /api/list` 不改任何东西（页面靠它轮询/刷新）。
 *
 * ★ 用**临时工作区**起服务（不碰真实的 workspace-qq），端口用 0 让系统分配，
 *   测完 `server.close()` —— 否则这个测试进程会一直挂着不退（第一次就是这么挂的）。
 *
 * 用法：node mocks/verify-sticker-label-ui.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { importStickerFiles, readImageSize, readStickerLibrary } from '../src/sticker-library.mjs'
import { createLabelServer } from '../src/sticker-label-server.mjs'

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

/** 真 PNG（默认 8×8；`side` 可给大图，用于验缩略图压缩比）。 */
function pngBytes(marker, side = 8) {
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
  const size = Math.max(1, Number(side) || 8)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  // ★ 像素要**有噪声**：纯色/渐变图会被 deflate 压到极小，
  //   那样"缩略图比原图小"就不是缩图的功劳，断言会失去意义。
  const stride = 1 + size * 3
  const raw = Buffer.alloc(size * stride)
  for (let y = 0; y < size; y += 1) {
    const base = y * stride
    raw[base] = 0
    for (let x = 0; x < size; x += 1) {
      const o = base + 1 + x * 3
      raw[o] = (40 + marker * 19 + x * 5 + ((x * y) % 97)) & 0xff
      raw[o + 1] = (60 + marker * 13 + y * 7 + ((x * 3 + y * 5) % 89)) & 0xff
      raw[o + 2] = (200 - marker * 11 + ((x * 7 + y * 11) % 83)) & 0xff
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 起一个临时工作区 + 库，返回 `{ ws, base, close }`。 */
async function bootstrap({ relative = false } = {}) {
  const wsAbs = mkdtempSync(join(tmpdir(), 'sticker-label-'))
  // ★ `relative: true` 时**用相对路径起服务**（真实 `config.json` 里
  //   `dsh.workspace` 默认就是相对的 `workspace-qq`）—— 见下面第 ⑧ 节：
  //   这条路径曾经让**每一张图都 403**，而接口 JSON 全正常，极难一眼看出。
  //   做法：把 cwd 临时切到临时工作区的父目录，再把工作区名当相对路径传进去。
  const cwd0 = process.cwd()
  let wsForServer = wsAbs
  if (relative) {
    process.chdir(tmpdir())
    wsForServer = wsAbs.slice(tmpdir().length).replace(/^[\\/]+/, '')
  }
  const seed = join(wsAbs, 'seed')
  mkdirSync(seed, { recursive: true })
  const files = []
  for (let i = 0; i < 3; i += 1) {
    const p = join(seed, `贴纸_${i}.png`)
    writeFileSync(p, pngBytes(i + 1))
    files.push(p)
  }
  importStickerFiles({ workspace: wsAbs }, [
    { scope: 'global', files: [files[0]], primary: 'laugh', labels: ['laugh'], confidence: 0.9 },
    { scope: 'global', files: [files[1]], primary: null, labels: [] },
    { scope: 'global', files: [files[2]], primary: 'confused', labels: ['confused'], confidence: 0.55 },
  ])
  const server = createLabelServer({ workspace: wsForServer, dir: 'stickers' })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`
  return {
    ws: wsAbs,
    base,
    close: async () => {
      await new Promise((r) => server.close(r))
      process.chdir(cwd0)
      rmSync(wsAbs, { recursive: true, force: true })
    },
  }
}

const api = async (base, path, init) => {
  const res = await fetch(base + path, init)
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

// ══════════════════════════════════════════════════════════════════════════
section('① 列表：只读，且把"该干的活"排在前面')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = await bootstrap()
  try {
    const before = JSON.stringify(readStickerLibrary({ workspace: t.ws }))
    const r = await api(t.base, '/api/list')
    check('GET /api/list 通', r.status === 200 && r.body.ok === true, JSON.stringify(r.body?.error ?? ''))
    check('★ 报出库里总数 / 没标签 / 低置信度 / 人工标过',
      r.body.total === 3 && r.body.untagged === 1 && r.body.manual === 0, JSON.stringify({ ...r.body, rows: undefined }))
    check('★ 标签都给了（页面按钮来自这里，不是前端硬编码）',
      r.body.labels.length >= 23 && r.body.labels.some((l) => l.id === 'laugh' && l.name === '笑死'), String(r.body.labels.length))
    check('★ 风险类标签「慎发」也在表里（安全闸门靠它）',
      r.body.labels.some((l) => l.id === 'risky' && l.name === '慎发'), JSON.stringify(r.body.labels.filter((l) => l.axis === '风险')))
    check('★ 没标签的排在最前（那才是要干的活）', r.body.rows[0].primary === null, JSON.stringify(r.body.rows.map((x) => x.primary)))
    check('★ 每条带图片 URL 与"文件在不在"', Boolean(r.body.rows[0].url) && r.body.rows.every((x) => x.exists === true))
    check('★ 每条带 `disputed` 标记（识图与文件名先验冲突的筛选项靠它）',
      r.body.rows.every((x) => typeof x.disputed === 'boolean'), JSON.stringify(r.body.rows[0]))
    check('★ 快照里报出冲突张数', typeof r.body.disputed === 'number', String(r.body.disputed))
    check('★ 列表接口**不改任何东西**（只读）',
      JSON.stringify(readStickerLibrary({ workspace: t.ws })) === before)
  } finally {
    await t.close()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('② 写回：点一下就变成 manual（于是重打标签不会覆盖它）')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = await bootstrap()
  try {
    const list = (await api(t.base, '/api/list')).body
    const target = list.rows.find((x) => !x.primary) // 没标签的那张
    const r = await api(t.base, '/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rel: target.rel, label: 'comfort' }),
    })
    check('POST /api/save 通', r.status === 200 && r.body.ok === true, JSON.stringify(r.body?.error ?? ''))
    check('★ 返回里带上"那一条改完的样子"（页面就地更新，不整表重载）',
      r.body.row.primary === 'comfort' && r.body.row.primaryName === '抱抱', JSON.stringify(r.body.row))
    check('★★ 落库是 manual（这是这工具存在的意义：人工判断不被模型覆盖）',
      r.body.row.manual === true && r.body.row.source === 'manual', r.body.row.source)

    const disk = readStickerLibrary({ workspace: t.ws }).entries[target.rel]
    check('★ 真的写进 library.json 了（不是只回响应）',
      disk.primary === 'comfort' && disk.source === 'manual' && disk.primaryConfidence === 1,
      JSON.stringify({ primary: disk.primary, source: disk.source, conf: disk.primaryConfidence }))
    check('★ 不再出现在待定区（可用图 +1）',
      !readStickerLibrary({ workspace: t.ws }).pending[target.rel])

    // 认不出的标签：拒绝且**一个字都不改**
    const other = list.rows.find((x) => x.rel !== target.rel && x.primary === 'confused')
    const bad = await api(t.base, '/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rel: other.rel, label: '鼓励' }),
    })
    check('★★ 不是词表里的标签 → 422 且**不改库**（不猜）',
      bad.status === 422 && bad.body.ok === false, JSON.stringify(bad.body))
    check('★ 库里那一条保持原样',
      readStickerLibrary({ workspace: t.ws }).entries[other.rel].primary === 'confused')

    // 跳过：标成"无合适标签"（manual + 空）
    const skip = await api(t.base, '/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rel: other.rel, action: 'skip' }),
    })
    check('★ 跳过 = 空标签 + manual（于是自动重打也不会给它安一个猜的）',
      skip.body.ok && skip.body.row.primary === null && skip.body.row.manual === true,
      JSON.stringify({ primary: skip.body.row.primary, manual: skip.body.row.manual }))

    // 不存在的条目
    const missing = await api(t.base, '/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rel: 'global/nope.png', label: 'laugh' }),
    })
    check('★ 库里没有的条目 → 404（不静默成功）', missing.status === 404, JSON.stringify(missing.body))
  } finally {
    await t.close()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 撤销：把"改前"放回去（含空标签与来源）')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = await bootstrap()
  try {
    const list = (await api(t.base, '/api/list')).body
    const untagged = list.rows.find((x) => !x.primary)
    await api(t.base, '/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rel: untagged.rel, label: 'laugh' }),
    })
    check('改完是 laugh', readStickerLibrary({ workspace: t.ws }).entries[untagged.rel].primary === 'laugh')

    const u = await api(t.base, '/api/undo', { method: 'POST' })
    check('POST /api/undo 通', u.body.ok === true, JSON.stringify(u.body))
    const after = readStickerLibrary({ workspace: t.ws }).entries[untagged.rel]
    check('★★ 撤销后**回到改前**（空标签）', after.primary === null, JSON.stringify({ primary: after.primary }))
    check('★ 来源也回到改前（import，不是残留 manual）', after.source === 'import', String(after.source))

    // 再撤：栈里还有前面那两次改动 —— 一路撤到底，然后必须"明确说没有"
    let last = null
    for (let i = 0; i < 10; i += 1) {
      last = await api(t.base, '/api/undo', { method: 'POST' })
      if (!last.body.ok) break
    }
    check('★★ 撤到底之后**明确说没有可撤销的**（不是静默成功）',
      last.body.ok === false && String(last.body.error).includes('没有'), JSON.stringify(last.body))
  } finally {
    await t.close()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 图片服务：能给图，但**不许越出库目录**')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = await bootstrap()
  try {
    const list = (await api(t.base, '/api/list')).body
    const row = list.rows[0]
    const img = await fetch(t.base + row.url)
    const bytes = Buffer.from(await img.arrayBuffer())
    check('★ 能取到图（正确的 MIME + 非空字节）',
      img.status === 200 && img.headers.get('content-type') === 'image/png' && bytes.length > 8,
      `${img.status} ${img.headers.get('content-type')} ${bytes.length}B`)
    check('★ 返回的确实是 PNG（按魔数核对，不是按扩展名相信）',
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)

    // 穿越尝试：拿库外面的 library.json
    const evil = await fetch(`${t.base}/img/..%2F..%2Fconfig.json`)
    check('★★ 目录穿越被挡住（403/404，绝不吐库外文件）', evil.status === 403 || evil.status === 404, String(evil.status))
    const evil2 = await fetch(`${t.base}/img/${encodeURIComponent('../../library.json')}`)
    check('★★ 另一种穿越写法也挡住', evil2.status === 403 || evil2.status === 404, String(evil2.status))
    const evil3 = await fetch(`${t.base}/img/global/..%2F..%2Flibrary.json`)
    check('★ 库内的相对跳转也挡住', evil3.status === 403 || evil3.status === 404, String(evil3.status))
    const noSuch = await fetch(`${t.base}/img/global/nope.png`)
    check('★ 不存在的图 → 404', noSuch.status === 404)
    const notImage = await fetch(`${t.base}/img/library.json`)
    check('★ 库里非图片的文件（library.json）**不当作静态资源**', notImage.status === 404, String(notImage.status))
  } finally {
    await t.close()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 词表接口：实时新建 / 改 / 删（改完下一轮对话就生效）')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = await bootstrap()
  const post = (path, body) =>
    api(t.base, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const before = await api(t.base, '/api/labels')
    check('GET /api/labels 通且给全字段', before.status === 200 && before.body.ok === true, JSON.stringify(before.body?.error ?? ''))
    check('★ 给的是**全字段**（cues 全量 / auto / risk / protected，页面编辑靠它）',
      before.body.labels.every((l) => Array.isArray(l.cues) && typeof l.auto === 'boolean') &&
        before.body.labels.some((l) => l.risk === true && l.protected === true),
      JSON.stringify(before.body.labels.find((l) => l.id === 'risky')))
    check('★ 轴清单也给了（新建标签的下拉靠它，前端不硬编码）',
      Array.isArray(before.body.axes) && before.body.axes.includes('主动情感') && before.body.axes.includes('风险'),
      String(before.body.axes?.length))
    const n0 = before.body.labels.length

    // ── 新建 ──
    const created = await post('/api/labels', { action: 'create', name: '点赞', axis: '表态', cues: ['干得漂亮'] })
    check('POST /api/labels create 通', created.status === 200 && created.body.ok === true, JSON.stringify(created.body?.error ?? ''))
    const newId = created.body.label?.id
    check('★ 自动生成了 id（中文名 → 短哈希，不用人起）', Boolean(newId) && /^[a-z0-9-]+$/.test(newId), String(newId))
    check('★ 返回里带**新词表全量**（页面不用再取一次）',
      created.body.labels.length === n0 + 1 && created.body.labels.some((l) => l.id === newId), String(created.body.labels.length))
    check('★ 新建的立刻生效：写进了工作区的 labels.json', existsSync(join(t.ws, 'stickers', 'labels.json')))

    // ★★ 这条是本轮修掉的真断点：库层以前用**静态**词表校验，
    //    新标签存得进词表、却贴不到图上（报"不是词表里的标签"）。
    const list2 = await api(t.base, '/api/list')
    const target = list2.body.rows.find((x) => !x.primary)
    const tagged = await post('/api/save', { rel: target.rel, label: newId })
    check('★★ 新建的标签**能立刻贴到图上**（库层校验走生效词表）',
      tagged.status === 200 && tagged.body.row?.primary === newId,
      JSON.stringify(tagged.body?.error ?? tagged.body.row?.primary))
    check('★ 它的中文名也能用（认得名字，不只是 id）',
      (await post('/api/save', { rel: target.rel, label: '点赞' })).body.row?.primary === newId)

    // ── 校验：不合法就拒绝，且一个字都不改 ──
    const diskBefore = JSON.stringify(readStickerLibrary({ workspace: t.ws }))
    check('★ 重名 → 拒绝', (await post('/api/labels', { action: 'create', name: '点赞', axis: '表态' })).status === 422)
    check('★ 轴不在白名单 → 拒绝', (await post('/api/labels', { action: 'create', name: '乱轴', axis: '心情' })).status === 422)
    check('★ 空名字 → 拒绝', (await post('/api/labels', { action: 'create', name: '  ', axis: '表态' })).status === 422)
    check('★ 不认识的 action → 422', (await post('/api/labels', { action: '乱来' })).status === 422)
    check('★ 被拒绝的请求**没动过库**', JSON.stringify(readStickerLibrary({ workspace: t.ws })) === diskBefore)

    // ── 改 ──
    const renamed = await post('/api/labels', { action: 'update', id: newId, name: '大拇指' })
    check('POST /api/labels update 改名通', renamed.body.ok === true && renamed.body.label?.name === '大拇指')
    check('★★ 改名**不改 id**（库里引用的是 id，所以不会有图掉队）',
      renamed.body.label?.id === newId &&
        readStickerLibrary({ workspace: t.ws }).entries[target.rel]?.primary === newId,
      String(renamed.body.label?.id))
    const recued = await post('/api/labels', { action: 'update', id: newId, cues: ['干得漂亮', '牛'] })
    check('★ 改 cues 生效', JSON.stringify(recued.body.label?.cues) === JSON.stringify(['干得漂亮', '牛']), JSON.stringify(recued.body.label?.cues))

    // ── 风险标签是安全闸门：不可改名、不可删 ──
    const renameRisk = await post('/api/labels', { action: 'update', id: 'risky', name: '随便发' })
    check('★★ 「慎发」不能改名（安全闸门）', renameRisk.status === 422, JSON.stringify(renameRisk.body?.error ?? ''))
    check('★★ 「慎发」不能删', (await post('/api/labels', { action: 'delete', id: 'risky' })).status === 422)

    // ── 删：有图时先确认；确认后那些图**恢复成未标注**（用户明确要求的行为）──
    const delNoConfirm = await post('/api/labels', { action: 'delete', id: newId })
    check('★★ 标签下还有图时**拒绝直接删**（要页面确认过才行）',
      delNoConfirm.status === 409 && delNoConfirm.body.used >= 1, JSON.stringify(delNoConfirm.body?.used))
    const delOk = await post('/api/labels', { action: 'delete', id: newId, confirm: true })
    check('★ 确认后才删掉', delOk.status === 200 && delOk.body.ok === true)
    check('★ 删的是标签，**图还在**（不删图）', Boolean(readStickerLibrary({ workspace: t.ws }).entries[target.rel]))
    check('★★ 那张图**恢复成未标注**（不会被选中，等着重新标）',
      !readStickerLibrary({ workspace: t.ws }).entries[target.rel].primary &&
        readStickerLibrary({ workspace: t.ws }).entries[target.rel].primaryConfidence === 0,
      JSON.stringify({
        primary: readStickerLibrary({ workspace: t.ws }).entries[target.rel].primary,
        conf: readStickerLibrary({ workspace: t.ws }).entries[target.rel].primaryConfidence,
      }))
    const list3 = await api(t.base, '/api/list')
    check('★★ 所以**没有**"引用已删标签"的孤儿（而不是留下一批悬在半空的图）',
      !Object.keys(list3.body.unknownCounts ?? {}).includes(newId), JSON.stringify(list3.body.unknownCounts))
    check('★ 它出现在"未打标签"那一栏里（人能找到它去重标）',
      list3.body.untagged >= 1, String(list3.body.untagged))

    // ── 复位 ──
    const reset = await post('/api/labels', { action: 'reset' })
    check('★ reset 回到出厂词表', reset.body.ok === true && reset.body.labels.some((l) => l.id === 'laugh'))
  } finally {
    await t.close()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ 按标签看图：图墙数据（点标签就能看见那批图长什么样）')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = await bootstrap()
  try {
    const all = await api(t.base, '/api/list')
    const laughRow = all.body.rows.find((x) => x.primary === 'laugh')
    const pendingRow = all.body.rows.find((x) => !x.primary)

    const b1 = await api(t.base, '/api/browse?label=laugh')
    check('GET /api/browse?label= 通', b1.status === 200 && b1.body.ok === true, JSON.stringify(b1.body?.error ?? ''))
    check('★ 只回这个标签下的图（图墙要的就是这批）',
      b1.body.rows.length === 1 && b1.body.rows[0].rel === laughRow.rel, JSON.stringify(b1.body.rows.map((r) => r.primary)))
    check('★ 每条带图片 URL（图墙直接用它当 src）', b1.body.rows.every((r) => String(r.url).startsWith('/img/')))

    const b2 = await api(t.base, '/api/browse')
    check('★ 不带 label = 待打的那批（"未打标签"那一行）',
      b2.body.rows.length === 1 && b2.body.rows[0].rel === pendingRow.rel, JSON.stringify(b2.body.rows.map((r) => r.primary)))
    const b3 = await api(t.base, '/api/browse?label=not-a-real-label')
    check('★ 不存在的标签 → 空列表（不是报错，也不是回全库）', b3.body.ok === true && b3.body.rows.length === 0)
    check('★ 图墙数据**只读**（不因为看了一眼就改库）',
      readStickerLibrary({ workspace: t.ws }).entries[laughRow.rel].source !== 'manual')
  } finally {
    await t.close()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑦ 静态页：三个文件都在（它是独立工具，不吃后台 UI 的构建）')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = await bootstrap()
  try {
    for (const [path, needle] of [
      ['/', '人工标注台'],
      ['/app.js', 'function save'],
      ['/style.css', '--accent'],
    ]) {
      const r = await fetch(t.base + path)
      const text = await r.text()
      check(`★ ${path} 能取到且内容对`, r.status === 200 && text.includes(needle), `${r.status} len=${text.length}`)
    }
    // ★ 新增的两个页签必须在页面骨架里（否则用户看不到"按标签看图"）
    const html = await (await fetch(t.base + '/')).text()
    check('★ 页面上有「逐张标注」页签', html.includes('tab-pass') && html.includes('逐张标注'))
    check('★ 页面上有「按标签看图」页签', html.includes('tab-browse') && html.includes('按标签看图'))
    check('★ 页面上有「新建标签」入口（实时建标签是用户的要求）', html.includes('btn-new-label') && html.includes('新建标签'))
    check('★ 页面上有标签编辑表单（改名 / 改典型语境 / 删）', html.includes('label-form') && html.includes('lf-name'))
    const js = await (await fetch(t.base + '/app.js')).text()
    check('★ 前端**不硬编码标签清单**（一切由后端给）',
      !/PREFERRED\s*[:=][^]*?\/\/ 常用标签/.test(js) || !js.includes('risky:'), '检查是否内联了标签表')
    check('★ 前端调词表接口（新建/改/删都走它）', js.includes("'/api/labels'"))
    check('★ 前端调图墙接口', js.includes('/api/browse'))
    check('★ 前端调保存接口（贴标签）', js.includes("'/api/save'"))
    const nope = await fetch(`${t.base}/../src/config.mjs`)
    check('★ 静态目录外的路径取不到', nope.status === 404 || nope.status === 403, String(nope.status))
  } finally {
    await t.close()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑨ 缩略图：图墙必须用小图（否则几十张动图会把标签页卡死）')
// ══════════════════════════════════════════════════════════════════════════
{
  // ★★ 这条钉的是一个**真实把浏览器卡死**的缺陷：图墙第一版直接拿原图当缩略图。
  //   实测点开 `moved`：54 张**动图**、合计 **159MB**，浏览器把 54 个动画全部
  //   解码并同时播放 —— 标签页卡到连浮层的关闭按钮都点不动。
  const t = await bootstrap()
  try {
    const list = await api(t.base, '/api/list')
    check('★ 每条都带 thumb（图墙用它，不用原图）',
      list.body.rows.every((r) => String(r.thumb ?? '').startsWith('/thumb/')),
      list.body.rows[0]?.thumb)

    const row = list.body.rows[0]
    const thumb = await fetch(t.base + row.thumb)
    const tBytes = Buffer.from(await thumb.arrayBuffer())
    check('★ 缩略图能取到且是 PNG（按魔数核对）',
      thumb.status === 200 && tBytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      `${thumb.status} ${tBytes.length}B`)
    const full = await fetch(t.base + row.url)
    const fBytes = Buffer.from(await full.arrayBuffer())
    // ⚠️ 测试图是 8×8 的极小 PNG，缩了也不会更小（缩略图本身有固定开销），
    //    所以这里**不能用"文件更小"当判据**。真正的判据是"最长边被缩到上限内"，
    //    以及下面对**大图**的实测（那份才是卡死的现场）。
    const dim = readImageSize(tBytes)
    check('★★ 缩略图被缩到上限内且尺寸正确', dim && Math.max(dim.width, dim.height) <= 256, JSON.stringify(dim))
    check('★ 小图也不报错（缩完可能比原图大，这是正常的）', tBytes.length > 0, `${tBytes.length}B vs 原图 ${fBytes.length}B`)

    // ★★ 用一张**大图**验真正的压缩比 —— 这才是"图墙会不会卡死"的现场。
    //    ⚠️ 尺寸要卡在入库判据内：静态图的字节上限是 4MB，1200×1200 的噪声 PNG 有
    //    4.2MB 会被**静默拒掉**（第一版就是这么大，断言红在"入库了没"那一条）。
    const bigPng = pngBytes(9, 900)
    const bigFile = join(t.ws, 'seed', '大图_测试.png')
    writeFileSync(bigFile, bigPng)
    const before = new Set(Object.keys(readStickerLibrary({ workspace: t.ws }).entries))
    const imp = importStickerFiles({ workspace: t.ws }, [{ scope: 'global', files: [bigFile], primary: 'moved', confidence: 0.9 }])
    const bigRel = Object.keys(imp.entries).find((k) => !before.has(k))
    check('★ 大图入库了', Boolean(bigRel), bigRel ?? JSON.stringify(imp.skipped))
    const bigThumb = await fetch(`${t.base}/thumb/${encodeURIComponent(bigRel ?? 'x')}?w=256`)
    const bt = Buffer.from(await bigThumb.arrayBuffer())
    check('★★ 大图 → 缩略图**明显更小**（这才是它存在的理由）',
      Boolean(bigRel) && bigThumb.status === 200 && bt.length < bigPng.length, `${bt.length}B vs 原图 ${bigPng.length}B`)
    check('★ 大图缩略图也 ≤256', Math.max(readImageSize(bt)?.width ?? 0, readImageSize(bt)?.height ?? 0) <= 256,
      JSON.stringify(readImageSize(bt)))

    // 缓存：第二次要明显更快（第一次约 10ms）
    const t0 = Date.now()
    await fetch(t.base + row.thumb)
    const cachedMs = Date.now() - t0
    check('★ 第二次命中内存缓存', cachedMs < 8, `${cachedMs}ms`)

    // 尺寸可调、且有上限（防有人拿它当"随便缩"的接口）
    const bigRes = await fetch(`${t.base}${row.thumb.split('?')[0]}?w=99999`)
    const bigBuf = Buffer.from(await bigRes.arrayBuffer()) // ★ 只能读一次（body 读完就没了）
    const bigDim = readImageSize(bigBuf)
    check('★ w 参数有上限（不会按请求缩到任意大）', bigRes.status === 200 && (bigDim?.width ?? 0) <= 512, JSON.stringify(bigDim))

    // 穿越防护：与 /img/ 同一套，必须一样严
    for (const evil of ['/thumb/../../config.json', '/thumb/global/..%2F..%2Flibrary.json', '/thumb/global/nope.gif']) {
      const r = await fetch(t.base + evil)
      check(`★ 缩略图路径也要挡住越界：${evil}`, r.status === 403 || r.status === 404, String(r.status))
    }

    // 前端：格子必须用 thumb / 浮层才用原图 —— 这两件事反了就会重现卡死
    const js = await (await fetch(t.base + '/app.js')).text()
    check('★★ 前端图墙用 thumb（不许用原图当缩略图）', /img\.src = row\.thumb/.test(js))
    check('★★ 前端只有浮层才加载原图', /img\.src = row\.url/.test(js))
    // ★★ 0.2.4 第十七轮：**"冻结动图"那套已删除，且不许回来**。
    //   它原来靠 `.paused` + `visibility: hidden` 把图藏起来（防几十张动图同时播）；
    //   但缩略图改成**静态 PNG** 之后它没有意义，而一旦 `.paused` 残留就让
    //   **所有图都不显示** —— 用户实测报的就是"缩略图不显示"。
    //   ⚠️ 断言要查"有没有真的用它"，不能只查名字 —— 注释里提到也会命中（假绿实测踩到）。
    check('★★★ 不再用"把图藏起来"的冻结机制（它是"缩略图不显示"的真凶）',
      // ⚠️ 只查"网格冻结"这件事：`forceGifRestart` 里那句 `img.style.visibility = 'hidden'`
      //    是**浮层单张**逼动图重播的合法用法，不是这套机制，别误伤。
      !/\.classList\.(add|remove)\(\s*['"]paused['"]/.test(js) &&
        !/freezeGifsDuringScroll\s*\(/.test(js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')))
    const cssText = (await (await fetch(t.base + '/style.css')).text()).replace(/\/\*[\s\S]*?\*\//g, '')
    check('★★★ CSS 里不许再有 `visibility: hidden` 藏图（`.paused` 那套）',
      // 剥掉注释再查 —— 文件里刻意留着"这里曾经有一条…已删除"的说明，不能误伤它
      !/\.paused\s+\.cell\s+img/.test(cssText) && !/visibility\s*:\s*hidden/.test(cssText))
    check('★ 图墙的负载改由这三层解决：静态缩略图 + 格子上限 + loading=lazy',
      /img\.loading = 'lazy'/.test(js) && js.includes('MAX_CELLS'))
    const html = await (await fetch(t.base + '/')).text()
    check('★ 页面上有"显示更多"按钮', html.includes('btn-more'))
    check('★★ 浮层关闭按钮带**内联** onclick（脚本出意外也能关掉全屏遮罩）',
      /id="ov-close"[^>]*onclick=/.test(html))
    check('★ 页面上有错误兜底条（脚本出错要看得见，不是"点了没反应"）', html.includes('page-error'))

    // ★★ 0.2.4 第十八轮：「页面过期自证」。
    //   这一轮真踩到的坑是：服务端四项全绿（接口、缩略图、渲染函数、样式都验过），
    //   但用户页面上的图**仍然不显示** —— 因为那份页面是**修复之前**加载的，
    //   里面还带着旧的 `visibility: hidden` 规则。静态资源是 `max-age=604800`，
    //   只要不重载页面就会一直跑旧代码。
    //   ∴ 页面必须自己发现"服务端重启过、我还是旧的"，并把提示亮出来。
    //   ★ 比较的基准是**重听计数 `buildId`**，不是 `startedAt`：重启已经改成同进程
    //     原地重听（进程不换），`startedAt` 根本不会变，拿它当版本号等于永远发现不了。
    check('★★★ 页面会自己发现"服务端已重启、本页仍是旧代码"',
      js.includes('startStalePageWatch') && /serverBuildId/.test(js) &&
        /String\(now\)\s*!==\s*String\(state\.serverBuildId\)/.test(js) &&
        /data\.buildId\s*\?\?\s*data\.startedAt/.test(js))
    check('★★ 过期自证真的被执行（不能只定义不调用）', /^\s*startStalePageWatch\(\)\s*$/m.test(js))
    check('★ 页面记下了加载时的服务端版本号（对比的基准）',
      /state\.serverBuildId\s*=\s*String\(stamp\)/.test(js))

    // ★★ 浮层的大图也不能无限制自动加载 —— 这是修完图墙之后**剩下唯一**
    //    没被限制的地方：实测最大一张是 8.6MB 的动图，点一下就要解码全部帧再铺满全屏。
    check('★★ 浮层有"大图不自动加载"的阈值', js.includes('OVERLAY_AUTOLOAD_MB'))
    check('★★ 浮层先显示缩略图（立刻可见、布局不跳）', html.includes('ov-thumb') && /ov-thumb/.test(js))
    check('★ 大图给"点这里加载"的提示', html.includes('ov-hint') && js.includes('ov-hint'))
    check('★ 关浮层时把原图卸掉（几 MB 的动图不留解码内存）',
      /closeOverlay[\s\S]{0,500}removeAttribute\('src'\)/.test(js))

    // ★ 构建标记 + /api/health：让"浏览器到底在跑哪一版"一眼可见
    const health = await api(t.base, '/api/health')
    check('★ /api/health 通（页面右上角的构建标记靠它）',
      health.status === 200 && health.body.ok === true && Boolean(health.body.startedAt),
      JSON.stringify(health.body))
    check('★ health 报出关键参数（排查时不用猜配置）',
      health.body.hasThumb === true && health.body.thumbConcurrency > 0 && health.body.thumbCacheMax > 0,
      JSON.stringify({ c: health.body.thumbConcurrency, m: health.body.thumbCacheMax }))
    check('★ 页面上有构建标记元素', html.includes('build-stamp'))

    // ★★ 两组线索都要能**读回来**（0.2.4 第十三轮）
    //   漏掉 otherCues 的后果不是"显示不出来"，而是**编辑表单回填为空、
    //   一保存就把"对方会说什么"整组清掉** —— 静默丢数据。
    const lab = await api(t.base, '/api/labels')
    const tiredLabel = lab.body.labels.find((l) => l.id === 'tired')
    check('★★ /api/labels 回传 otherCues（否则编辑一次就把它清空）',
      Boolean(tiredLabel) && Array.isArray(tiredLabel.otherCues) && tiredLabel.otherCues.length > 0,
      JSON.stringify(tiredLabel?.otherCues))
    check('★ /api/labels 回传 cues 与 excludeOther 也是数组',
      Array.isArray(tiredLabel?.cues) && Array.isArray(tiredLabel?.excludeOther))
    check('★★ 前端会把 otherCues **回填**到表单（不然改一次就丢）',
      /lf-other'\)\.value = \(l\.otherCues/.test(js))
    check('★ 前端提交时会带上 otherCues', /otherCues/.test(js) && js.includes("lf-other"))

    // ★★ 编辑/删除的**入口必须两个页签都能找到**。
    //    实测反馈："没有看见删除、编辑等新功能的入口" —— 因为改名/删除当时只存在于
    //    「按标签看图」页签里，而用户一直在「逐张标注」页，完全看不到它们。
    //    功能藏起来等于不存在，所以逐张页也要有一个显眼的入口。
    check('★★ 逐张页有「管理标签」入口（改名/删除不再只藏在另一个页签里）',
      html.includes('btn-manage-labels') && /管理标签/.test(html))
    check('★★ 那个入口**真的能用**：跳页 + 打开编辑表单（不是只换个页签）',
      js.includes("bind('btn-manage-labels'") && js.includes("await switchPage('browse')") && js.includes('showLabelForm(target)'))
    check('★ switchPage 返回 promise（否则两次 loadBrowse 会抢着渲染）',
      /if \(page === 'browse' && !state\.browse\.rows\.length\) return loadBrowse\(\)/.test(js))
    check('★ 按标签看图页也提示了"改名/删除"在哪', /要改名 \/ 删除就点/.test(html))

    // ★★ 浮层必须是"困不住人"的：真卡住时至少能出去。
    //    （用户报的就是"浮层开着、点关闭没反应"，所以出口越多越好，且都不能依赖
    //     脚本成功绑上事件 —— 一律用内联 onclick。）
    check('★★ 浮层有「重载页面」按钮（最后出路），且是内联 onclick',
      /id="ov-reload"[^>]*onclick=/.test(html))
    check('★「关闭」按钮也是内联 onclick', /id="ov-close"[^>]*onclick=/.test(html))
    check('★★ app.js 在**捕获阶段**监听按键 → 浮层开着时按任意键都能关',
      js.includes("addEventListener(\n  'keydown'") && js.includes('true, // ← 捕获阶段') && js.includes('closeOverlay()'))
    check('★★ 缩略图取不到时**会说出来**（不是一个空白大框 + 像死了）',
      js.includes('thumb.onerror') && /取不到/.test(js))
    check('★ 缩略图迟迟不来也会显示状态（1.5 秒后提示）',
      js.includes('overlayHintTimer') && js.includes('1500'))
    check('★★ 静态资源带**构建版本串**（每次重启 URL 就变，排除"浏览器跑旧的 app.js"）',
      /\?v=\$\{v\}/.test(readFileSync(new URL('../src/sticker-label-server.mjs', import.meta.url), 'utf8')))
  } finally {
    await t.close()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑧ 相对工作区路径也能取图（真 config.json 里就是相对的）')
// ══════════════════════════════════════════════════════════════════════════
{
  // ★★ 这条钉的是一个**只在真实使用时才暴露**的缺陷：
  //   `stickerRoot()` 在 workspace 是相对路径时返回相对路径，而请求路径
  //   经 `resolve()` 是绝对的 → `startsWith` 永远 false → **每一张图都 403**。
  //   接口 JSON 全部正常，只有图是空的（页面整片空白），排查成本极高。
  //   测试里之所以没暴露，是因为测试的工作区是 `mkdtempSync` 给的绝对路径。
  const t = await bootstrap({ relative: true })
  try {
    const list = await api(t.base, '/api/list')
    check('★ 相对工作区下 /api/list 正常', list.status === 200 && list.body.total === 3, JSON.stringify(list.body?.error ?? list.body?.total))
    let okAll = true
    const detail = []
    for (const row of list.body.rows) {
      const r = await fetch(t.base + row.url)
      const bytes = r.status === 200 ? (await r.arrayBuffer()).byteLength : 0
      if (r.status !== 200 || bytes === 0) okAll = false
      detail.push(`${row.primary ?? '无'}:${r.status}/${bytes}B`)
    }
    check('★★ 相对工作区下**每一张图都能取到**（不是 403）', okAll, detail.join(' '))
    const png = await fetch(t.base + list.body.rows[0].url)
    check('★ 取到的是真图（PNG 魔数）',
      Buffer.from(await png.arrayBuffer()).subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])))
    // 修完取图之后，穿越防护必须**依然有效**（这两件事不能被一起改坏）
    const evil = await fetch(`${t.base}/img/global/..%2F..%2Flibrary.json`)
    check('★ 修完取图后，穿越写法**仍然被挡**', evil.status === 403 || evil.status === 404, String(evil.status))
    const evil2 = await fetch(`${t.base}/img/../../config.json`)
    check('★ 另一种穿越写法也仍然被挡', evil2.status === 403 || evil2.status === 404, String(evil2.status))
  } finally {
    await t.close()
  }
}

// 自检：这个工具**不写自己目录外的东西**（它只改工作区里的库与词表）
{
  // 服务实现在 src/（壳在 sticker-label/server.mjs），所以这里读 src 那份
  const here = readFileSync(new URL('../src/sticker-label-server.mjs', import.meta.url), 'utf8')
  const shell = readFileSync(new URL('../sticker-label/server.mjs', import.meta.url), 'utf8')  // ★ 绑定地址在**壳**里（`server.listen(port, '127.0.0.1')`），服务实现本身不 listen ——
  //   所以这条断言读壳。只监听回环 = 局域网看不到这个工具（图片是本地文件）。
  check('★ 工具不开端口到局域网（只监听 127.0.0.1）', shell.includes("server.listen(port, '127.0.0.1'"))
  check('★ 工具不碰桥接（不 import session/onebot/api 那些模块）',
    !/from '\.\/?\.?\.?\/?src\/(api|onebot|bridge|session-bridge)\.mjs'/.test(here) && !/from '\.\.\/src\/(api|onebot)/.test(shell))
  check('★ 壳里没有第二份服务实现（这一份才在 src/，只有一处真值）',
    !shell.includes('createServer') && shell.includes('createLabelServer'))
  void mkdirSync
}

// ══════════════════════════════════════════════════════════════════════════
section('⑩ 体检脚本：图墙慢/错能被一条命令查出来')
// ══════════════════════════════════════════════════════════════════════════
{
  // ★ 为什么要有这条：这个页面卡死过一次，当时**既没有日志也没有可复现的脚本**，
  //   只能靠猜，来回猜错了好几轮。`sticker-label/doctor.mjs` 就是那次的产物 ——
  //   它把"浏览器打开这一页会做的事"变成一条能随时跑、会自己报哪一步慢/错的命令。
  //
  // ⚠️ 这里**不 spawn 它**：本项目的沙箱不许子进程用管道取输出
  //   （`execFileSync` 会 EPERM），那是环境限制、不是脚本的问题。
  //   所以改为核对它的**判据**，并由它自己去真服务上跑（人手动运行即可）。
  const doctor = readFileSync(new URL('../sticker-label/doctor.mjs', import.meta.url), 'utf8')
  check('★ 体检脚本存在且可读', doctor.length > 1000, `${(doctor.length / 1024).toFixed(1)}KB`)
  check('★ 它会核对静态文件与磁盘一致（直接回答"我改的生效了吗"）',
    doctor.includes('与磁盘一致') && doctor.includes('createHash'))
  check('★ 它会整批拉图墙缩略图并报总量与耗时',
    /整个图墙 \$\{rows\.length\} 张缩略图/.test(doctor) || doctor.includes('整个图墙'))
  check('★ 它会检查最大的原图能不能取', doctor.includes('最大的原图'))
  check('★ 它读 /api/health（据此判断服务是**哪一版**）', doctor.includes('/api/health'))
  check('★ 连不上服务时给出下一步命令（不是只报错）', doctor.includes('先起服务'))

  // 真服务上跑一遍它依赖的判据（不经过子进程）
  const t = await bootstrap()
  try {
    const health = await api(t.base, '/api/health')
    check('★ 体检依赖的 /api/health 在真服务上可用',
      health.status === 200 && Boolean(health.body.startedAt), JSON.stringify(health.body))
    const served = Buffer.from(await (await fetch(t.base + '/app.js')).arrayBuffer())
    const disk = readFileSync(new URL('../sticker-label/public/app.js', import.meta.url))
    const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12)
    check('★ 体检的"静态文件与磁盘一致"判据成立（服务发的是磁盘那一份）',
      sha(served) === sha(disk), `${sha(served)} vs ${sha(disk)}`)
  } finally {
    await t.close()
  }

  // 服务端要有请求日志（排查"浏览器到底请求了什么"的唯一窗口）
  const src = readFileSync(new URL('../src/sticker-label-server.mjs', import.meta.url), 'utf8')
  check('★★ 服务端有请求日志（出问题时能看见浏览器请求了什么）', src.includes('logRequest'))
  check('★ 日志**不记成功的图片**（图墙 54 张会把有用信息淹掉）',
    /isAsset && status < 400/.test(src))
  check('★ favicon 给了响应（省掉控制台里那条误导人的 404）', src.includes('/favicon'))
  check('★ 缩略图名额是**按需唤醒 + 有超时**（不是轮询 sleep —— 那会无限期挂住请求）',
    src.includes('acquireThumbSlot') && src.includes('THUMB_WAIT_TIMEOUT_MS'))
  check('★ 体检脚本本身不 import 桥接模块（它只是 HTTP 客户端）',
    !/from '\.\.\/src\/(api|onebot|bridge)\.mjs'/.test(doctor))

  // ══════════════════════════════════════════════════════════════════════
  // ★★★ `[hidden]` 必须真的能藏住东西
  //
  // 这一条修的是**被当成"页面卡死"报了三次**的假故障：HTML 的 `hidden` 属性
  // 只是浏览器默认样式里的 `display: none`，任何一条 CSS 的 `display` 都能盖掉它。
  // 而这个页面里 `.overlay` / `.grid-foot` / `.label-form` 都要 `display: flex` ——
  // 于是**浮层从页面加载起就一直显示着**（里面没图，因为没人点过图），
  // 点「关闭」时 `closeOverlay()` 真的执行了、`hidden` 也真的设上了，
  // 但 CSS 让它照样显示 ⇒ 表现成"点关闭没反应"。而浮层只是遮罩，
  // 后面的内容照常能交互 ⇒ 现象是"界面死了但底层还活着"。
  // ══════════════════════════════════════════════════════════════════════
  const css = readFileSync(new URL('../sticker-label/public/style.css', import.meta.url), 'utf8')
  const htmlAll = readFileSync(new URL('../sticker-label/public/index.html', import.meta.url), 'utf8')
  check('★★★ CSS 里有 `[hidden] { display: none !important }`（hidden 属性必须真的藏住）',
    /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(css))

  // 逐条核对：凡是"一开始就带 hidden"的元素，它的组件样式不能带 display
  // （有了上面那条全局规则，这里其实是冗余检查 —— 但冗余在这里是有价值的：
  //   它会把**新加**的 display 组件指出来，提醒"这个元素以后别靠 hidden 藏"）
  const hiddenSelectors = []
  for (const m of htmlAll.matchAll(/<(\w+)([^>]*?)\shidden([^>]*)>/g)) {
    const cls = (m[0].match(/class="([^"]*)"/) || [])[1] ?? ''
    const id = (m[0].match(/id="([^"]*)"/) || [])[1] ?? ''
    hiddenSelectors.push({ cls, id, tag: m[1] })
  }
  const risky = []
  for (const e of hiddenSelectors) {
    const sel = e.cls ? `.${e.cls.split(' ')[0]}` : e.id ? `#${e.id}` : null
    if (!sel) continue
    const rules = css.match(new RegExp(`\\${sel}\\s*\\{[^}]*\\}`, 'g')) ?? []
    if (rules.some((r) => /display\s*:/.test(r))) risky.push(`${sel}（有 display 但靠 hidden 藏）`)
  }
  check('★ 靠 hidden 藏的元素都已被全局规则兜住（这里列出有 display 的那几个）',
    /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/.test(css),
    risky.length ? risky.join('、') : '无')
}

// ══════════════════════════════════════════════════════════════════════════
section('⑪ 自动分类未标注的图（只打没标签的，已标的一张都不动）')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = await bootstrap()
  const post = (path, body) =>
    api(t.base, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    // 预检：临时库里 3 张、其中 1 张没标签（bootstrap 的第三张是低置信度）
    const g = await api(t.base, '/api/retag')
    check('GET /api/retag 通且给预检', g.status === 200 && g.body.ok === true && Boolean(g.body.preflight), JSON.stringify(g.body.preflight))
    check('★ 预检说清"有几张要打"（界面据此显示，不是点了才知道）',
      typeof g.body.preflight.todo === 'number', String(g.body.preflight.todo))
    check('★ 空闲时 phase=idle', g.body.phase === 'idle', String(g.body.phase))

    // ★ 发起的两条路都要**有明确结果**（这是重点，不是"必须报错"）：
    //   · 配了模型通路 → 起任务（200，带 jobId/total）
    //   · 没配 → 422 + 人话原因（不是按钮点了没反应）
    //   测试环境用的是包里的 config.json，配没配 key 取决于环境，所以两种都接受。
    const start = await post('/api/retag', { action: 'start' })
    const started = start.status === 200 && start.body.ok === true && Boolean(start.body.id ?? start.body.total != null)
    const refused = start.status === 422 && /模型通路|apiKey/i.test(String(start.body.error ?? ''))
    check('★★ 发起总有明确结果：要么起任务、要么 422 + 人话原因（不静默失败）',
      started || refused, `${start.status} ${JSON.stringify(start.body).slice(0, 160)}`)
    if (started) {
      check('★ 起任务后立刻返回 jobId 与总数（界面据此轮询，不挂着等）',
        Boolean(start.body.id) && typeof start.body.total === 'number', JSON.stringify({ id: start.body.id, total: start.body.total }))
      // 收拾干净：别让任务在测试进程里继续跑
      const a = await post('/api/retag', { action: 'abort' })
      check('★ 能停下来（长任务必须有刹车）', a.status === 200, JSON.stringify(a.body).slice(0, 120))
    } else {
      const abort = await post('/api/retag', { action: 'abort' })
      check('★ 没在跑时点停止也给明确结果（不谎报成功）',
        abort.status === 200 && abort.body.ok === false && Boolean(abort.body.error), String(abort.body.error))
    }

    // 界面三件套
    const html = await (await fetch(t.base + '/')).text()
    const js = await (await fetch(t.base + '/app.js')).text()
    check('★ 页面上有「自动分类未标注的图」按钮', html.includes('btn-auto-tag') && /自动分类/.test(html))
    check('★★ 按钮文案说清"只打没标签的"（已标的不动，否则会覆盖人工成果）',
      /未标注/.test(html) && js.includes('一张都不会动'))
    check('★★ 发起前二次确认，并写明"每张一次模型调用（会花钱）"',
      js.includes('每张一次模型调用') && js.includes('window.confirm'))
    check('★ 有进度显示与停止（长任务不能没有刹车）', js.includes('refreshAutoTag') && js.includes("action: 'abort'"))
    check('★ 轮询节奏与桥接那边一致（1.5s）', js.includes('1500'))
  } finally {
    await t.close()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑫ 缩略图取**最后一帧**（第一帧往往只是画布的一小块）')
// ══════════════════════════════════════════════════════════════════════════
{
  // ★ 用户报的现象：图墙上"图片实际上不显示"—— 实际是缩略图只解了 GIF 的第一帧，
  //   而多数表情包的第一帧只覆盖画布的一小部分（实测 30 张里 24 张只覆盖 11%~42%），
  //   于是看着就是"一条窄条"。改为**从第一帧合成到最后一帧**。
  const src = readFileSync(new URL('../src/sticker-library.mjs', import.meta.url), 'utf8')
  check('★★ 有"合成到最后一帧"的解码器（并按透明色合成）',
    src.includes('export function decodeGifThumbFrame') && src.includes('decodeGifFrames'))
  check('★★ 缩略图走的是它，而不是只解第一帧',
    /const frame = decodeGifThumbFrame\(bytes\)/.test(src))
  check('★ 透明像素**不覆盖**已有内容（这是"逐帧补细节"能拼起来的前提）',
    src.includes('透明 = 保留下面已经画好的内容'))
  check('★★ 有帧数上限 + 如实标记"没解到真收尾帧"（防超长动图烧 CPU，也不谎报）',
    src.includes('maxFrames = 400') && src.includes('reachedLimit'))
  check('★ 裁掉四周空边（有些图只用画布一半，不裁就一半是空的）',
    src.includes('cropEmptyMargins'))
  check('★ 局部色表的帧**先转 RGB 再合成**（只留索引会把先画的帧染错色）',
    src.includes('画布**直接存 RGB**'))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑬ 在 UI 里退出 / 重启（端口堵塞的出路）')
// ══════════════════════════════════════════════════════════════════════════
{
  // ★ 用户明确要求：这个工具是**独立进程 + 固定端口**，端口被占时新进程连启动都失败
  //   （EADDRINUSE），而页面上什么提示都没有 —— 只能去任务管理器翻 node.exe，
  //   提权启动的连 taskkill 都会被拒。所以"关掉自己"必须能从 UI 做。
  const t = await bootstrap()
  try {
    const post = (body) =>
      api(t.base, '/api/server', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const bad = await post({ action: 'nope' })
    check('★ 不认识的 action → 422 且说清只支持哪两个', bad.status === 422 && /shutdown/.test(String(bad.body.error)), String(bad.body.error))

    const html = await (await fetch(t.base + '/')).text()
    const js = await (await fetch(t.base + '/app.js')).text()
    check('★ 页面上有「退出」与「重启服务」两个按钮',
      html.includes('btn-quit') && html.includes('btn-restart'))
    check('★★ 退出前二次确认，并说清"不会丢数据 / 以后怎么再开"',
      js.includes('quitServer') && /不会丢/.test(js) && /启动标注/.test(js))
    check('★ 退出/重启后给**终局提示**（此时服务已不在，页面内提示最可靠）',
      js.includes('showFinalNotice') && js.includes('已退出'))
    check('★★ 重启给**终局提示**，并且不谎报结果（真正起来了才说成功）',
      js.includes('restartServer') && /服务已重启并恢复/.test(js) && /重启后服务没有恢复/.test(js))

    // ★★★ 0.2.4 第十八轮：「重启服务」改成**同进程原地重听**，不许再 spawn 子进程。
    //   原来"拉新进程 + 退自己"踩了两次：先是端口交接（EADDRINUSE），后是更隐蔽的 ——
    //   常规用法是双击 .bat，node 在**那个 cmd 窗口里前台跑**，点重启用旧进程一退、
    //   批处理跑完、窗口关闭，刚拉起的"detached 新进程"仍随宿主进程树被收走。
    //   迷惑之处：restart 日志里能看到新进程**已经绑上端口并打出启动横幅**，
    //   可过一会儿端口又是空的；而且成败取决于宿主怎么杀进程树，代码保证不了。
    const src = readFileSync(new URL('../src/sticker-label-server.mjs', import.meta.url), 'utf8')
    check('★★★ 重启是"同进程原地重听"（关监听 → 绑回同一端口）',
      src.includes('rebindInPlace') && /server\.close\(/.test(src) && /server\.listen\(port, '127\.0\.0\.1'\)/.test(src))
    check('★★★ 不再 spawn 子进程来做重启（那条路依赖"子进程比父进程活得久"，保证不了）',
      !src.includes('spawnDetached') && !/from 'node:child_process'/.test(src))
    check('★★ 重听前清掉缩略图缓存（否则"重启"对新解码逻辑没有意义）', /thumbCache\.clear\(\)/.test(src))
    check('★★ 重启后页面**自己等结果**并如实报告（不谎报"已重启"）',
      /for \(let i = 0; i < 10; i\+\+\)/.test(js) && js.includes('/api/health'))
    // ★ 版本号必须是"重听计数"：同进程重听时 `startedAt` 根本不会变
    check('★★★ /api/health 带 buildId（同进程重听时 startedAt 不变，页面靠它发现换过版本）',
      src.includes('buildId: rebindCount') && js.includes('data.buildId'))
    check('★★ 页面不会拿 startedAt 当版本号（原地重听下它永远不变，等于永远发现不了）',
      !/startedAt !== state\.serverStartedAt/.test(js) && js.includes('state.serverBuildId'))
    const shell = readFileSync(new URL('../sticker-label/server.mjs', import.meta.url), 'utf8')
    check('★★ 启动壳支持 --wait-port 重试（新进程自己等旧进程让出端口）',
      shell.includes("argv.includes('--wait-port')") && shell.includes('EADDRINUSE'))
    check('★ 手动启动（不带 --wait-port）时端口冲突仍然立刻报错（不静默等）',
      /maxTries = waitPort \? 10 : 1/.test(shell))
  } finally {
    await t.close()
  }

  // shutdown 会真的退出进程 —— 用**子进程**验证（stdin 忽略、不捕获管道）
  {
    const { spawnSync } = await import('node:child_process')
    const t2 = await bootstrap()
    const port = new URL(t2.base).port
    await t2.close() // 关掉测试内的那个，让子进程接管同一端口
    const child = spawnSync(
      process.execPath,
      ['-e', `
        import('${new URL('../src/sticker-label-server.mjs', import.meta.url).href}').then(async (m) => {
          const srv = m.createLabelServer({ workspace: ${JSON.stringify(t2.ws)}, dir: 'stickers' })
          await new Promise((r) => srv.listen(${port}, '127.0.0.1', r))
          const res = await fetch('http://127.0.0.1:${port}/api/server', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'shutdown' }),
          })
          const body = await res.json()
          console.log('SHUTDOWN_RESULT ' + JSON.stringify({ status: res.status, ok: body.ok }))
        })
      `],
      { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    // 沙箱里"用管道取子进程输出"可能被拒（EPERM）——那就跳过这条，不算失败
    if (child.error && String(child.error.code) === 'EPERM') {
      console.log('ℹ️  跳过 shutdown 子进程验证（沙箱不允许捕获子进程输出）')
    } else {
      const m = /SHUTDOWN_RESULT (\{.*\})/.exec(String(child.stdout ?? ''))
      const parsed = m ? JSON.parse(m[1]) : null
      check('★★ shutdown 先回 200、然后进程真的退出（退出码 0）',
        parsed?.ok === true && child.status === 0, `status=${child.status} stdout=${String(child.stdout ?? '').slice(0, 80)}`)
    }
    rmSync(t2.ws, { recursive: true, force: true })
  }
}

console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
