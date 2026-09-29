/**
 * 标签词表数据层（`src/sticker-vocab.mjs`）测试。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这组断言在防什么
 * ══════════════════════════════════════════════════════════════════════════
 * 词表从"代码常量"变成"数据文件"（`stickers/labels.json`）之后，多了一整类
 * **只在磁盘上才会发生**的故障。这里每一条都对应一个真实踩过的坑，或者是
 * "用户会做但代码没想过"的输入：
 *
 *   ① **写入端与读取端形状必须一致** —— 实测踩过：写的是 `{version, labels:[…]}`，
 *      读取端却把整个对象当数组 → 新标签**当场查不到**，而且不报错（回落默认表）。
 *   ② **缓存失效不能只看文件长度** —— 实测踩过：改完词表长度**刚好相同**时
 *      判定"没变"，于是改了不生效。现在靠"文件签名 + 写代际号"两个一起。
 *   ③ **坏文件绝不砸功能** —— 读不出来 / 不是数组 / 一条都不合法 → 回落出厂表，
 *      并在状态里**如实告警**（不是静默，也不是崩）。词表坏了不该让整个功能消失。
 *   ④ **安全闸门不可删、不可改名** —— `risky`（慎发）删掉等于把闸门一起删；
 *      库里已有的 `risky` 图会立刻变成"谁都能发"。
 *   ⑤ **改名不改 id** —— 库里引用的是 id；如果改名把 id 也改了，
 *      所有已标注的图会**集体变成"引用已删标签"**（一次静默的数据事故）。
 *   ⑥ **非法输入一律拒绝**（重名 / 轴不在白名单 / 空名 / 超长），
 *      并且**一个字都不能写进文件**（不能"改了一半"）。
 *   ⑦ **不合法就到上限** —— 标签数有上限，防止一个输入框把提示词撑坏。
 *
 * ★ 用临时工作区（不碰真实 `workspace-qq`），测完删掉。
 *   ⚠️ 词表模块**有模块级缓存**，所以每个 case 之间要 `resetLabelCache()`
 *     —— 忘了这一步会出现"上一个 case 的词表串到下一个 case"的假红/假绿。
 *
 * 用法：node mocks/verify-sticker-vocab.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STICKER_DIR as LIBRARY_STICKER_DIR } from '../src/sticker-library.mjs'
import { STICKER_LABELS, normalizeLabelId } from '../src/sticker-labels.mjs'
import {
  LABELS_FILE,
  MAX_CUES,
  MAX_LABELS,
  MAX_NAME_LEN,
  STICKER_DIR,
  activeIsAutoAllowed,
  activeLabelById,
  activeLabelIds,
  activeLabelName,
  activeLabels,
  createLabel,
  deleteLabel,
  labelAxes,
  labelTableStatus,
  labelsFile,
  makeLabelId,
  resetLabelCache,
  resetLabels,
  resolveActiveLabelId,
  updateLabel,
} from '../src/sticker-vocab.mjs'

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

/** 起一个临时工作区（返回 opts 与清理函数）。 */
function mkws() {
  const ws = mkdtempSync(join(tmpdir(), 'sticker-vocab-'))
  resetLabelCache()
  return {
    ws,
    opts: { workspace: ws, dir: 'stickers' },
    /** 直接往磁盘写词表文件（模拟用户手改 / 别的进程写）。 */
    write(raw) {
      mkdirSync(join(ws, 'stickers'), { recursive: true })
      writeFileSync(join(ws, 'stickers', 'labels.json'), typeof raw === 'string' ? raw : JSON.stringify(raw), 'utf8')
      resetLabelCache() // 模拟"另一个进程写的" → 本进程缓存必须失效
    },
    done() {
      resetLabelCache()
      rmSync(ws, { recursive: true, force: true })
    },
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('① 出厂值：没写词表文件时就是内置那 23 个')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = mkws()
  try {
    const st = labelTableStatus(t.opts)
    check('没有 labels.json → 用内置表', st.source === 'default' && st.labelsFileExists === false, JSON.stringify(st))
    check('内置表条数与 sticker-labels 一致', activeLabels(t.opts).length === STICKER_LABELS.length, `${activeLabels(t.opts).length} vs ${STICKER_LABELS.length}`)
    check('★ 两个模块的 STICKER_DIR 必须相等（词表层刻意重写了一份，防循环依赖）',
      STICKER_DIR === LIBRARY_STICKER_DIR, `${STICKER_DIR} vs ${LIBRARY_STICKER_DIR}`)
    check('LABELS_FILE 名字对', LABELS_FILE === 'labels.json', LABELS_FILE)
    check('★ 慎发（risky）在出厂表里（安全闸门不能出厂就没有）',
      activeLabels(t.opts).some((l) => l.id === 'risky'), activeLabelIds(t.opts).join(','))
    check('★ 认 id', resolveActiveLabelId('laugh', t.opts) === 'laugh')
    check('★ 认中文名', resolveActiveLabelId('笑死', t.opts) === 'laugh')
    check('★ 认大小写变体', resolveActiveLabelId('LAUGH', t.opts) === 'laugh')
    check('★ 认不出就 null（不猜、不兜底）', resolveActiveLabelId('狂笑', t.opts) === null)
    check('★ 静态 normalizeLabelId 只认内置表（它是出厂值，不是运行期真相）',
      normalizeLabelId('笑死') === 'laugh' && normalizeLabelId('狂笑') === null)
    check('中文名回读', activeLabelName('laugh', t.opts) === '笑死', activeLabelName('laugh', t.opts))
    check('★ 不知名的 id 原样返回（界面要能显示"引用已删标签"）', activeLabelName('u-gone', t.opts) === 'u-gone')
    check('轴清单是内置那一份', labelAxes().includes('主动情感') && labelAxes().includes('风险'), String(labelAxes().length))
    check('★ 表达类可以自主补', activeIsAutoAllowed('laugh', t.opts) === true)
    // ★ 0.2.4 第十六轮：礼节/交付改为可自主（与语境轴三分类对齐），不再有"功能类"
    check('★ 礼节 / 交付 也**可以**自主补了（用户要求：三分类里每类都有触发源）',
      ['greet', 'goodnight', 'task-done'].every((id) => activeIsAutoAllowed(id, t.opts) === true))
    check('★★ 唯一不能自主的是风险闸门',
      activeIsAutoAllowed('risky', t.opts) === false)
  } finally {
    t.done()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('② 新建：立刻生效，且 id 稳定可引用')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = mkws()
  try {
    const n0 = activeLabels(t.opts).length
    const r = createLabel(t.opts, { name: '点赞', axis: '表态', cues: ['干得漂亮', '牛'] })
    check('新建成功', r.ok === true && r.label?.id, JSON.stringify(r))
    const id = r.label.id
    check('★ 立刻出现在生效表里（不用重启、不用重读）',
      activeLabels(t.opts).length === n0 + 1 && activeLabelIds(t.opts).includes(id), `${activeLabels(t.opts).length}`)
    check('★ 立刻能用名字/ id 解析到它',
      resolveActiveLabelId(id, t.opts) === id && resolveActiveLabelId('点赞', t.opts) === id)
    check('★ 真的写进了 labels.json（不是只在内存）', existsSync(labelsFile(t.opts)))
    const disk = JSON.parse(readFileSync(labelsFile(t.opts), 'utf8'))
    check('★★ 写入的形状是 `{version, labels:[…]}`（读取端必须认这个形状）',
      disk.version === 1 && Array.isArray(disk.labels) && disk.labels.some((l) => l.id === id),
      JSON.stringify(Object.keys(disk)))
    check('cues 存进去了', JSON.stringify(activeLabelById(id, t.opts).cues) === JSON.stringify(['干得漂亮', '牛']))
    check('★ 中文名生成的 id 是 ASCII 短哈希（别把中文写进 id）', /^[a-z0-9][a-z0-9-]*$/.test(id), id)
    check('makeLabelId 对 ASCII 名走 kebab-case', makeLabelId('Task Done', new Set()) === 'task-done', makeLabelId('Task Done', new Set()))
    check('★ makeLabelId 撞了就加后缀（不会覆盖已有标签）',
      makeLabelId('laugh', new Set(['laugh'])) === 'laugh-2', makeLabelId('laugh', new Set(['laugh'])))
  } finally {
    t.done()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 非法输入：一律拒绝，且**一个字都不写**')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = mkws()
  try {
    createLabel(t.opts, { name: '点赞', axis: '表态' })
    const before = readFileSync(labelsFile(t.opts), 'utf8')
    const cases = [
      ['重名', { name: '点赞', axis: '表态' }],
      ['轴不在白名单', { name: '乱轴', axis: '心情' }],
      ['轴为空', { name: '没轴', axis: '' }],
      ['空名字', { name: '   ', axis: '表态' }],
      ['没有工作区', { name: '无处可写', axis: '表态' }, {}],
    ]
    for (const [why, args, optsOverride] of cases) {
      const opts = optsOverride ?? t.opts
      const r = createLabel(opts, args)
      check(`★ 拒绝：${why}`, r.ok === false && typeof r.why === 'string', r.why ?? JSON.stringify(r))
    }
    check('★★ 被拒绝的请求**没有改动文件**（不能"改了一半"）', readFileSync(labelsFile(t.opts), 'utf8') === before)
    check('★ 超长名字被截到上限（不是拒绝，也不是写进去一个巨长的）',
      createLabel(t.opts, { name: '一'.repeat(30), axis: '表态' }).label.name.length === MAX_NAME_LEN)
    check('★ cues 数量有上限（防一个输入框把提示词撑坏）',
      createLabel(t.opts, { name: '多线索', axis: '表态', cues: Array.from({ length: MAX_CUES + 20 }, (_, i) => `线索${i}`) }).label.cues.length === MAX_CUES)
  } finally {
    t.done()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 改：改名**不改 id**（库里引用的是 id）')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = mkws()
  try {
    const created = createLabel(t.opts, { name: '点赞', axis: '表态' })
    const id = created.label.id
    const renamed = updateLabel(t.opts, id, { name: '大拇指' })
    check('改名成功', renamed.ok === true && renamed.label.name === '大拇指')
    check('★★ 改名后 id **没变**（否则已标注的图会集体变成"引用已删标签"）', renamed.label.id === id, renamed.label.id)
    check('★ 改名后按 id 仍能查到', activeLabelById(id, t.opts).name === '大拇指')
    check('★ 改名后旧中文名不再解析（避免两个名字指同一个标签的混乱）',
      resolveActiveLabelId('点赞', t.opts) === null)
    check('改 cues', updateLabel(t.opts, id, { cues: ['牛'] }).label.cues.length === 1)
    check('改轴', updateLabel(t.opts, id, { axis: '被逗乐' }).label.axis === '被逗乐')
    check('★ 改成非法轴 → 拒绝', updateLabel(t.opts, id, { axis: '心情' }).ok === false)
    check('★ 改成已存在的名字 → 拒绝', updateLabel(t.opts, id, { name: '笑死' }).ok === false)
    check('★ 改不存在的标签 → 拒绝', updateLabel(t.opts, 'u-nope', { name: 'X' }).ok === false)
    check('★ 改完后标签数不变（改不是新建）', activeLabels(t.opts).length === STICKER_LABELS.length + 1)
  } finally {
    t.done()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 安全闸门：risky 不可删、不可改名（库里的图立刻受影响）')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = mkws()
  try {
    const del = deleteLabel(t.opts, 'risky')
    check('★★ 不能删 risky', del.ok === false && /安全闸门/.test(del.why ?? ''), del.why)
    const ren = updateLabel(t.opts, 'risky', { name: '随便发' })
    check('★★ 不能改 risky 的名字', ren.ok === false && /安全闸门/.test(ren.why ?? ''), ren.why)
    check('★ 但可以改它的 cues（语料锚点该能维护）', updateLabel(t.opts, 'risky', { cues: ['脏话', '擦边'] }).ok === true)
    check('★ risky 改完还在', activeLabels(t.opts).some((l) => l.id === 'risky'))
    check('★ risky 不能自主补（它是闸门不是表达）', activeIsAutoAllowed('risky', t.opts) === false)
  } finally {
    t.done()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ 手改文件生效：缓存失效不能只看长度')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = mkws()
  try {
    createLabel(t.opts, { name: '甲', axis: '表态' })
    const lenA = activeLabels(t.opts).length
    // ★ 把「甲」改名成同样长度的「乙」——文件长度几乎不变（这是实测踩过的坑）
    const disk = JSON.parse(readFileSync(labelsFile(t.opts), 'utf8'))
    const one = disk.labels.find((l) => l.name === '甲')
    one.name = '乙'
    t.write(disk)
    check('★★ 等长改写也能被发现（只按文件长度做签名会漏掉这种）',
      activeLabelByNameSafe(t.opts, '乙') && activeLabels(t.opts).length === lenA,
      activeLabels(t.opts).map((l) => l.name).join(','))
    // 另一条路：本进程自己写（写代际号）
    updateLabel(t.opts, one.id, { name: '丙' })
    check('★ 本进程写完立刻生效（写代际号，不等 mtime）', activeLabelByNameSafe(t.opts, '丙'))
  } finally {
    t.done()
  }
}

/** 避免重复 import：按名字找标签。 */
function activeLabelByNameSafe(opts, name) {
  return activeLabels(opts).some((l) => l.name === name)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑦ 坏文件绝不砸功能：回落出厂表 + 如实告警')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = mkws()
  try {
    const bad = [
      ['不是 JSON', '{ 这不是 json'],
      ['是数组但元素全非法', JSON.stringify([{ name: '' }, { axis: '表态' }, null])],
      ['顶层是字符串', JSON.stringify('hello')],
      ['空数组', JSON.stringify([])],
    ]
    for (const [why, raw] of bad) {
      t.write(raw)
      const labels = activeLabels(t.opts)
      const st = labelTableStatus(t.opts)
      check(`★ 坏文件（${why}）→ 回落出厂表`, labels.length === STICKER_LABELS.length, String(labels.length))
      check(`  · 并且**如实告警**（不是静默）`, Array.isArray(st.warnings) && st.warnings.length > 0, JSON.stringify(st.warnings))
    }
    // 裸数组形式（人可能手写成数组）
    t.write(JSON.stringify([{ id: 'laugh', name: '笑死', axis: '被逗乐', cues: ['哈哈'] }]))
    check('★ 裸数组也认（人可能手写成数组，别因为形状就整份丢掉）',
      activeLabels(t.opts).some((l) => l.id === 'laugh'), activeLabelIds(t.opts).slice(0, 3).join(','))
    check('★ 手写的词表里没有 risky 时**自动补回**（闸门不能因为手改就消失）',
      activeLabels(t.opts).some((l) => l.id === 'risky'))
    // 非法项被丢掉，合法的留下
    t.write(JSON.stringify([{ id: 'a', name: '合法', axis: '表态' }, { id: 'b', name: '坏轴', axis: '心情' }]))
    check('★ 非法项丢掉、合法项留下（不是整份作废）',
      activeLabels(t.opts).length === 2 && activeLabelById('a', t.opts) && !activeLabelById('b', t.opts),
      activeLabelIds(t.opts).join(','))
  } finally {
    t.done()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑧ 删除与复位')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = mkws()
  try {
    const id = createLabel(t.opts, { name: '临时', axis: '表态' }).label.id
    const n0 = activeLabels(t.opts).length
    const d = deleteLabel(t.opts, id)
    check('删除成功', d.ok === true)
    check('★ 删完立刻不在表里', activeLabels(t.opts).length === n0 - 1 && !activeLabelById(id, t.opts))
    check('★ 删不存在的 → 拒绝', deleteLabel(t.opts, id).ok === false)
    check('★ 删不掉最后一个（否则什么都打不了）', deleteLabel(t.opts, 'risky').ok === false)
    // 复位
    createLabel(t.opts, { name: '再建一个', axis: '表态' })
    const r = resetLabels(t.opts)
    check('复位成功', r.ok === true)
    check('★ 复位回到出厂条数', activeLabels(t.opts).length === STICKER_LABELS.length, String(activeLabels(t.opts).length))
    check('★ 复位后文件仍然合法（不是把文件删了）',
      existsSync(labelsFile(t.opts)) && Array.isArray(JSON.parse(readFileSync(labelsFile(t.opts), 'utf8')).labels))
  } finally {
    t.done()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑨ 上限与边界')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = mkws()
  try {
    let last = null
    let hitLimit = false
    for (let i = 0; i < MAX_LABELS + 5; i += 1) {
      last = createLabel(t.opts, { name: `批量${i}`, axis: '表态' })
      if (!last.ok) {
        hitLimit = true
        break
      }
    }
    check(`★ 标签数到达上限 ${MAX_LABELS} 时拒绝（不让一个输入框把提示词撑坏）`, hitLimit, last?.why ?? '')
    check('★ 上限内的条数被守住', activeLabels(t.opts).length <= MAX_LABELS, String(activeLabels(t.opts).length))
    // 没有工作区 → 明确失败，不抛错
    resetLabelCache()
    check('★ 没有工作区 → 明确失败（不抛错、不静默写别处）',
      createLabel({}, { name: '无处可写', axis: '表态' }).ok === false &&
        labelsFile({}) === '' && labelsFile({ workspace: '' }) === '')
    check('★ 没有工作区时读表回出厂值（fail-closed 到"内置表"而不是"空表"）',
      activeLabels({}).length === STICKER_LABELS.length)
  } finally {
    t.done()
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑩ 出厂升级合并：给老用户的词表**只增不减**地补新线索')
// ══════════════════════════════════════════════════════════════════════════
{
  // ★ 为什么需要这组断言（实测撞上的真问题）：
  //   `labels.json` 一旦存在就**完全取代**出厂表。于是"我在出厂表里补了更准的
  //   触发线索"这种改进，对**已经动过词表的用户一点都到不了** ——
  //   实测用户库里 `tired` 的 otherCues 是空的，那套两源匹配对他等于没做。
  //   而"用出厂表覆盖回去"会把人家的改名 / 删除 / 自定义线索一起冲掉。
  //   ∴ 只对 **0.2.4 新引入的字段**做并集，而且必须幂等。
  const t = mkws()
  try {
    // 造一份"老用户词表"：改过名字、加过自己的线索、没有新字段
    t.write({
      version: 1,
      labels: [
        { id: 'tired', name: '疲倦', axis: '主动情感', cues: ['困', '好累'], antiCues: ['对方在求助'] },
        { id: 'comfort', name: '抱抱', axis: '主动情感', cues: ['抱抱', '加油'] },
        { id: 'mine', name: '我自己加的', axis: '表态', cues: ['嘿嘿'] },
      ],
    })
    const before = activeLabels(t.opts)
    const tired = before.find((l) => l.id === 'tired')
    check('★★ 用户改的名字**保住**（不被出厂表覆盖）', tired.name === '疲倦', tired.name)
    check('★★ 用户自己加的线索**保住**', tired.cues.includes('好累'), JSON.stringify(tired.cues))
    check('★★ 用户自己加的标签**保住**', before.some((l) => l.id === 'mine'))
    check('★★ 出厂表**新增的** otherCues 被补进来了（否则新能力到不了老用户）',
      (tired.otherCues ?? []).length > 0 && tired.otherCues.includes('加班到'), JSON.stringify(tired.otherCues))
    check('★ comfort 也补了（**即使它的 cues 非空** —— 新字段与老字段无关）',
      (before.find((l) => l.id === 'comfort').otherCues ?? []).length > 0)
    check('★ 用户自己加的标签**没有**被凭空塞线索（它不在出厂表里）',
      (before.find((l) => l.id === 'mine').otherCues ?? []).length === 0)

    // 幂等：反复读不能越滚越大
    const n1 = activeLabels(t.opts).find((l) => l.id === 'tired').otherCues.length
    resetLabelCache()
    const n2 = activeLabels(t.opts).find((l) => l.id === 'tired').otherCues.length
    resetLabelCache()
    const n3 = activeLabels(t.opts).find((l) => l.id === 'tired').otherCues.length
    check('★★★ 幂等：反复读**不会越滚越大**（并集必须去重）', n1 === n2 && n2 === n3, `${n1}/${n2}/${n3}`)

    // 用户删掉的标签不复活
    t.write({ version: 1, labels: [{ id: 'comfort', name: '抱抱', axis: '主动情感', cues: ['抱抱'] }] })
    const only = activeLabels(t.opts)
    check('★★ 用户删掉的标签**不会被出厂表复活**（只按 id 匹配现有条目）',
      only.length === 2 && !only.some((l) => l.id === 'tired'),
      only.map((l) => l.id).join(','))

    // 状态里如实报出"补过哪些"
    const st = labelTableStatus(t.opts)
    check('★ 状态里报出"补过线索的标签"（不静默改用户的词表）',
      Array.isArray(st.upgraded), JSON.stringify(st.upgraded))
  } finally {
    t.done()
  }
}

console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
