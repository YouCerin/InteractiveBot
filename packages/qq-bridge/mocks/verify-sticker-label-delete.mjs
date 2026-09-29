/**
 * 删除标签 / 建标签 的**语义测试**（用户明确要求的那条规则）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这条规则是什么（用户原话：「删除后内部的图片重新变为未标注」）
 * ══════════════════════════════════════════════════════════════════════════
 * 删掉一个标签之后，库里引用它的图**必须落到一个明确的状态**：
 * **未标注** —— 不会被选中，等着被重新标。
 *
 * 为什么不能只删标签不管图：那会留下一批"引用已删标签"的孤儿 ——
 * 界面能列出来，但谁也说不清它们算不算有标签、该不该参与选图。
 *
 * ── 落到未标注要同时做三件事（少一件都会留下怪状态）────────────────────
 *   ① `primary` 清空
 *   ② `labels` 里去掉它（它还可能是别人的**次要标签**）
 *   ③ `primaryConfidence` 清成 0 —— ★ 最容易漏的一条：
 *      `isUsable()` 判的是"有 primary 且置信度够"，只清 primary 不清置信度，
 *      条目会带着上次的打分留在库里，语义含混。
 *
 * ── 还有一种必须区分的引用（这条搞错了就是数据事故）────────────────────
 *   · 它当**主标签** → 整条清成未标注；
 *   · 它只当**次要标签** → 只从 labels 里摘掉，**主标签不能动**。
 *
 * 用法：node mocks/verify-sticker-vocab-delete.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { clearLabelFromLibrary, importStickerFiles, isUsable, readStickerLibrary } from '../src/sticker-library.mjs'
import { createLabelServer } from '../src/sticker-label-server.mjs'
import { activeLabels, createLabel, deleteLabel, resetLabelCache, restoreLabel } from '../src/sticker-vocab.mjs'

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

/** 真 PNG（8×8，噪声像素，避免被压成同一个哈希）。 */
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
      raw[base + 1 + x * 3] = (x * 7 + marker * 13) & 0xff
      raw[base + 2 + x * 3] = (y * 11 + marker) & 0xff
      raw[base + 3 + x * 3] = (x + y * 13 + marker * 3) & 0xff
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 起一个临时库 + 服务。库里有三张图，覆盖三种引用形态：
 *   A：主=laugh，次=[]           → 删 laugh 后应整体变未标注
 *   B：主=laugh，次=[sad]        → 删 laugh 后应变未标注（sad 只是次要，不能顶上来）
 *   C：主=sad，  次=[laugh]      → 删 laugh 后**主标签 sad 必须保留**
 */
async function bootstrap() {
  const ws = mkdtempSync(join(tmpdir(), 'sticker-del-'))
  const seed = join(ws, 'seed')
  mkdirSync(seed, { recursive: true })
  const files = []
  for (let i = 0; i < 3; i += 1) {
    const p = join(seed, `图_${i}.png`)
    writeFileSync(p, pngBytes(i + 1))
    files.push(p)
  }
  importStickerFiles({ workspace: ws }, [
    { scope: 'global', files: [files[0]], primary: 'laugh', labels: ['laugh'], confidence: 0.9 },
    { scope: 'global', files: [files[1]], primary: 'laugh', labels: ['laugh', 'sad'], confidence: 0.9 },
    { scope: 'global', files: [files[2]], primary: 'sad', labels: ['sad', 'laugh'], confidence: 0.9 },
  ])
  resetLabelCache()
  const server = createLabelServer({ workspace: ws, dir: 'stickers' })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    ws,
    base,
    rels: Object.keys(readStickerLibrary({ workspace: ws }).entries),
    close: async () => {
      await new Promise((r) => server.close(r))
      resetLabelCache()
      rmSync(ws, { recursive: true, force: true })
    },
  }
}

const post = async (base, path, body) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

const lib = (ws) => readStickerLibrary({ workspace: ws })
const byPrimary = (ws, rel) => lib(ws).entries[rel]

// ══════════════════════════════════════════════════════════════════════════
section('① 库层：clearLabelFromLibrary 把引用清干净')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = await bootstrap()
  try {
    const [a, b, c] = t.rels
    const r = clearLabelFromLibrary({ workspace: t.ws }, 'laugh')
    check('清引用：改动条数对', r.ok && r.changed === 3, JSON.stringify({ changed: r.changed }))
    check('★ 报出"当主标签有 2 条、仅次要 1 条"', r.primaryCleared === 2 && r.secondaryOnly === 1,
      JSON.stringify({ primaryCleared: r.primaryCleared, secondaryOnly: r.secondaryOnly }))

    check('★★ 主标签是它 → primary 清空', byPrimary(t.ws, a).primary === '' || !byPrimary(t.ws, a).primary,
      JSON.stringify(byPrimary(t.ws, a).primary))
    check('★★ 主标签是它 → 置信度清 0（否则会"看着没标签、其实还能用"）',
      byPrimary(t.ws, a).primaryConfidence === 0, String(byPrimary(t.ws, a).primaryConfidence))
    check('★★ 主标签是它 → 整条**不再可用**（不会被选中）', !isUsable(byPrimary(t.ws, a)))
    check('★ 次要标签里有它 → 也从 labels 摘掉', !(byPrimary(t.ws, a).labels ?? []).includes('laugh'),
      JSON.stringify(byPrimary(t.ws, a).labels))

    check('★★ 它只是**次要**标签 → 主标签**必须保留**（这条搞错就是数据事故）',
      byPrimary(t.ws, c).primary === 'sad' && isUsable(byPrimary(t.ws, c)),
      JSON.stringify({ primary: byPrimary(t.ws, c).primary, labels: byPrimary(t.ws, c).labels }))
    check('★ 那一条的 labels 里也没了 laugh', !(byPrimary(t.ws, c).labels ?? []).includes('laugh'))

    check('★ 库里**一张图都没少**（删标签不删图）', Object.keys(lib(t.ws).entries).length === 3)
    check('★ 文件也都还在磁盘上（这里只验证索引，图片文件由库层保证不动）',
      Object.values(lib(t.ws).entries).every((e) => Boolean(e.file)))
  } finally {
    await t.close()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('② 接口：有图时先拦一次，确认后才删（并如实回报"变未标注几张"）')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = await bootstrap()
  try {
    const blocked = await post(t.base, '/api/labels', { action: 'delete', id: 'laugh' })
    check('★★ 不确认 → 409 拦住', blocked.status === 409 && blocked.body.needConfirm === true,
      `${blocked.status} ${blocked.body.error ?? ''}`)
    check('★ 拦住时**一个字都没改**（图还都带着原标签）',
      Object.values(lib(t.ws).entries).filter((e) => e.primary === 'laugh').length === 2)

    const done = await post(t.base, '/api/labels', { action: 'delete', id: 'laugh', confirm: true })
    check('★ 确认后删成功', done.status === 200 && done.body.ok === true, JSON.stringify(done.body.error ?? ''))
    check('★★ 如实回报"变成未标注"的张数', done.body.unlabeled === 2, String(done.body.unlabeled))
    check('★ 如实回报"只是被摘掉次要标签"的张数', done.body.relabeledSecondary === 1, String(done.body.relabeledSecondary))
    check('★★ 词表里已经没有它了', !activeLabels({ workspace: t.ws, dir: 'stickers' }).some((l) => l.id === 'laugh'))

    const list = await (await fetch(`${t.base}/api/list`)).json()
    check('★★ /api/list 里**没有"引用已删标签"的孤儿**了（都变成未标注）',
      Object.keys(list.unknownCounts ?? {}).length === 0, JSON.stringify(list.unknownCounts))
    check('★ 未标注张数变成了 2', list.untagged === 2, String(list.untagged))
    check('★ 图墙的"未打标签"那一栏能看到这两张',
      (await (await fetch(`${t.base}/api/browse`)).json()).rows.length === 2)
  } finally {
    await t.close()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 撤销：删标签要能**一步**整批撤回')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = await bootstrap()
  try {
    const before = JSON.stringify(
      Object.fromEntries(
        Object.entries(lib(t.ws).entries).map(([rel, e]) => [rel, { p: e.primary, l: e.labels }]),
      ),
    )
    await post(t.base, '/api/labels', { action: 'delete', id: 'laugh', confirm: true })
    check('删完确实变了', byPrimary(t.ws, t.rels[0]).primary !== 'laugh')

    const undo = await post(t.base, '/api/undo', {})
    check('★ 撤销成功且标成**整批**', undo.body.ok === true && undo.body.batch === true, JSON.stringify(undo.body))
    check('★ 撤销回报改了几条（页面要说清"撤回了什么"）', undo.body.changed === 3, String(undo.body.changed))
    check('★ 撤销回报标签名（提示用）', undo.body.label === '笑死', String(undo.body.label))
    const after = JSON.stringify(
      Object.fromEntries(
        Object.entries(lib(t.ws).entries).map(([rel, e]) => [rel, { p: e.primary, l: e.labels }]),
      ),
    )
    check('★★ 一次撤销就把 3 条全部还原（不用按 3 次）', after === before, after === before ? '' : after)
  } finally {
    await t.close()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 新建标签：立刻可用（并且能立刻贴到图上）')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = await bootstrap()
  try {
    const made = await post(t.base, '/api/labels', { action: 'create', name: '点赞', axis: '表态', cues: ['干得漂亮'] })
    check('建成功且有 id', made.body.ok === true && Boolean(made.body.label?.id), JSON.stringify(made.body.error ?? made.body.label))
    const id = made.body.label.id
    check('★ 立刻进了生效词表', activeLabels({ workspace: t.ws, dir: 'stickers' }).some((l) => l.id === id))
    const rel = t.rels[0]
    const tagged = await post(t.base, '/api/save', { rel, label: id })
    check('★★ 能立刻贴到图上（库层校验走生效词表）', tagged.body.row?.primary === id, JSON.stringify(tagged.body.error ?? tagged.body.row?.primary))
    // 再删掉它 → 那张图应回到未标注
    const del = await post(t.base, '/api/labels', { action: 'delete', id, confirm: true })
    check('★ 删掉刚建的标签 → 那张图回到未标注',
      del.body.ok === true && !byPrimary(t.ws, rel).primary && !isUsable(byPrimary(t.ws, rel)),
      JSON.stringify({ primary: byPrimary(t.ws, rel).primary, conf: byPrimary(t.ws, rel).primaryConfidence }))
  } finally {
    await t.close()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 安全闸门：risky 不能删（删了等于把闸门一起删）')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = await bootstrap()
  try {
    const r = await post(t.base, '/api/labels', { action: 'delete', id: 'risky', confirm: true })
    check('★★ 删 risky → 拒绝', r.status === 422, JSON.stringify(r.body.error ?? ''))
    check('★ 它还在词表里', activeLabels({ workspace: t.ws, dir: 'stickers' }).some((l) => l.id === 'risky'))
  } finally {
    await t.close()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ 库层直调：没有引用时是"没改"，不是报错')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = await bootstrap()
  try {
    const empty = clearLabelFromLibrary({ workspace: t.ws }, 'lurk') // 没人用这个标签
    check('★ 没引用 → ok 且 changed=0（幂等）', empty.ok === true && empty.changed === 0, JSON.stringify(empty))
    check('★ 空 id → 明确失败（不抛错）', clearLabelFromLibrary({ workspace: t.ws }, '').ok === false)
    // 库里还应该好好的
    check('★ 上面两次调用都没动库', Object.values(lib(t.ws).entries).filter((e) => e.primary === 'laugh').length === 2)
    // 词表层：建了再删，图不受影响（顺序正确性）
    const c = createLabel({ workspace: t.ws, dir: 'stickers' }, { name: '临时', axis: '表态' })
    check('★ 建标签不发散到图上（只动词表）',
      c.ok === true && Object.values(lib(t.ws).entries).every((e) => e.primary !== c.label.id))
  } finally {
    await t.close()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑦ 词表层：restoreLabel 把标签**原样**加回来（撤销的前提）')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = await bootstrap()
  try {
    const opts = { workspace: t.ws, dir: 'stickers' }
    const before = activeLabels(opts)
    const at = before.findIndex((l) => l.id === 'laugh')
    const def = { ...before[at] }
    const del = deleteLabel(opts, 'laugh')
    check('★ 删除时**回传被删掉的那份定义**（撤销要用它）',
      del.ok === true && del.label?.id === 'laugh' && del.label?.name === def.name, JSON.stringify(del.label ?? del))
    check('★ 删完不在表里', !activeLabels(opts).some((l) => l.id === 'laugh'))

    const back = restoreLabel(opts, { ...def, at })
    check('★ 恢复成功', back.ok === true && back.label?.id === 'laugh', JSON.stringify(back.why ?? back.label))
    check('★★ id / 名字 / 轴 / 线索都**原样**回来',
      JSON.stringify(activeLabels(opts).find((l) => l.id === 'laugh')) === JSON.stringify(def),
      JSON.stringify(activeLabels(opts).find((l) => l.id === 'laugh')))
    check('★★ 位置也回到原处（词表顺序决定"挑主标签"的优先级）',
      activeLabels(opts).findIndex((l) => l.id === 'laugh') === at, String(activeLabels(opts).findIndex((l) => l.id === 'laugh')))
    check('★ 幂等：再恢复一次不报错也不重复',
      restoreLabel(opts, def).ok === true && activeLabels(opts).filter((l) => l.id === 'laugh').length === 1)
    check('★ 定义不完整 → 明确拒绝（不写坏词表）',
      restoreLabel(opts, { id: 'x', name: '', axis: '表态' }).ok === false &&
        restoreLabel(opts, { id: 'x', name: '有名字', axis: '乱轴' }).ok === false)
  } finally {
    await t.close()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑧ 前端：删除/撤销的文案与整批处理必须跟上新语义')
// ══════════════════════════════════════════════════════════════════════════
{
  const js = readFileSync(new URL('../sticker-label/public/app.js', import.meta.url), 'utf8')
  check('★★ 删除确认里说清"会恢复成未标注"（不再是"引用已删标签"那套旧文案）',
    js.includes('恢复成未标注') && !js.includes('会变成「引用已删标签」'))
  check('★ 删除确认里提示可撤回', /删错了可以按 Ctrl\+Z/.test(js))
  check('★ 删除后的提示用后端回报的真实数字', js.includes('data.unlabeled') && js.includes('data.relabeledSecondary'))
  check('★★ 撤销要能处理**整批**（删标签一次撤几十条），且要把标签加回词表',
    js.includes('data.batch') && js.includes('已加回词表') && js.includes('张图的标注已还原'))
  check('★ 前端仍然把"引用已删标签"当兜底显示（历史数据 / 手改文件仍可能出现）',
    js.includes('引用已删标签'))
}

console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
