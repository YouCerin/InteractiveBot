#!/usr/bin/env node
/**
 * **聊天记录评审台**校验（独立小工具：导入 → 人工打分 → 生成风格修订草稿）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么这一套要写这么细
 * ══════════════════════════════════════════════════════════════════════════
 * 这个工具的产物会**直接改写 `styles/闲聊.md`**（机器人的人格），所以它自己的
 * 两条底线必须被钉住：
 *   ① **不许猜**：导入认不出来的行要如实进 warnings，不许猜昵称、不许把整段
 *      塞进第一条 —— 评审者对着假数据打的分比没有数据更糟；
 *   ② **不许静默**：`ok:false` 的每一种理由都要能到页面（打不开语料库、批次不存在、
 *      没确认就想应用草稿、同一份草稿想写第二遍）。
 * 另外还有本项目最贵的一类缺陷 —— **接线断了**：页面调了一个不存在的接口，
 * 表现为"点了没反应"而服务端日志干干净净。所以第 ⑦ 节把
 * `API.md`、服务端路由、`public/app.js` 三份**互相对账**。
 *
 * 用法：node mocks/verify-chat-review.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SELF_NAMES_DEFAULT,
  batchIdFor,
  buildTurns,
  fingerprint,
  isOnlyMarkers,
  normalizeAt,
  parseForwardJson,
  parsePlainText,
  rowToEntry,
  segmentsToText,
} from '../src/chat-review-import.mjs'
import {
  REVIEW_REL,
  TAGS,
  VERDICTS,
  aggregateStats,
  appendBlock,
  createReviewStore,
  renderProposedBlock,
  sha256,
  taxonomyDrift,
  unifiedDiff,
  validateScore,
} from '../src/chat-review-store.mjs'
import { createReviewServer } from '../src/chat-review-server.mjs'
import { createCorpus } from '../src/corpus.mjs'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

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

const tmpDirs = []
function freshDir(tag) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-review-${tag}-${process.pid}-`))
  tmpDirs.push(dir)
  return dir
}

// ══════════════════════════════════════════════════════════════════════════
section('① 导入解析：三种输入形状 + 认不出来就说认不出来')
// ══════════════════════════════════════════════════════════════════════════
{
  // ① get_forward_msg 的形状（最常见）
  const forward = {
    messages: [
      { sender: { nickname: '店长Keeper' }, message: [{ type: 'text', data: { text: '鱼头用的什么手机' } }], time: 1759384800 },
      {
        sender: { nickname: '小鲸鱼' },
        message: [
          { type: 'text', data: { text: '手机？' } },
          { type: 'image', data: { file: 'x.jpg' } },
          { type: 'text', data: { text: '没有手机' } },
        ],
        time: 1759384860,
      },
    ],
  }
  const a = parseForwardJson(JSON.stringify(forward))
  check('★ 认得出 get_forward_msg 的 `{messages:[…]}`', a.ok && a.entries.length === 2, JSON.stringify(a.why ?? a.entries.length))
  check('★ 消息段里的图片折成标记（不许当成正文）', a.entries[1]?.text === '手机？[图片]没有手机', a.entries[1]?.text)
  check('★★ 秒级时间戳归一化成毫秒（OneBot 给的是秒）', a.entries[0]?.at === 1759384800000, String(a.entries[0]?.at))

  // ② OneBot action 包装 + 事件数组
  const wrapped = parseForwardJson(JSON.stringify({ status: 'ok', data: { messages: [{ nickname: '甲', content: '你好' }] } }))
  check('认得出 `data.messages`（OneBot action 包装）', wrapped.ok && wrapped.entries[0]?.name === '甲', JSON.stringify(wrapped.why ?? ''))
  const events = parseForwardJson(
    JSON.stringify([{ post_type: 'message', sender: { nickname: '乙', user_id: 1 }, message: [{ type: 'text', data: { text: '在吗' } }], time: 1759384800 }]),
  )
  check('认得出 OneBot 事件数组', events.ok && events.entries[0]?.text === '在吗')

  // ③ 认不出来时必须说清楚
  const bad = parseForwardJson('{ 这不是 json')
  check('★★ 不是 JSON → ok:false + **给人看的理由**（不是抛异常）', bad.ok === false && /JSON 解析失败/.test(bad.why), bad.why)
  const noArray = parseForwardJson(JSON.stringify({ hello: 'world' }))
  check('★ 找不到消息数组 → 说明认哪些写法', noArray.ok === false && /找不/.test(noArray.why), noArray.why)
  const onlyImage = parseForwardJson(JSON.stringify({ messages: [{ sender: { nickname: '甲' }, message: [{ type: 'image', data: {} }] }] }))
  check('★ 只有图片的一项折成 `[图片]` 保留（它是合法消息；"能不能被评"是回合组装那一层的事）',
    onlyImage.ok && onlyImage.entries[0].text === '[图片]', JSON.stringify(onlyImage.why ?? onlyImage.entries[0]?.text))
  const noBody = parseForwardJson(
    JSON.stringify({ messages: [{ sender: { nickname: '甲' }, message: [{ type: '未来才有的段', data: {} }] }] }),
  )
  check('★★ 全认不出消息段 → 没有正文 → ok:false 且**报出是第几项**',
    noBody.ok === false && noBody.warnings.some((w) => /第 1 项没有正文/.test(w)), noBody.warnings.join(' | '))
  const noName = parseForwardJson(JSON.stringify({ messages: [{ message: [{ type: 'text', data: { text: '匿名' } }] }] }))
  check('★★ 没有昵称 → 按「某人」处理**并且报 warning**（不许猜名字）',
    noName.ok && noName.entries[0].name === '某人' && noName.warnings.some((w) => /没有昵称/.test(w)),
    noName.warnings.join(' | '))

  // ④ at / reply 段的处理
  check('at 段写成 @昵称（否则看不出它有没有接住被叫的那句）',
    segmentsToText([{ type: 'at', data: { qq: '1', name: '老王' } }, { type: 'text', data: { text: ' 你好' } }]) === '@老王 你好')
  check('reply 段丢掉（只是指针，正文里出现反而干扰阅读）',
    segmentsToText([{ type: 'reply', data: { id: '9' } }, { type: 'text', data: { text: '嗯' } }]) === '嗯')
  check('时间戳：没有就 null（不许编一个 now）', normalizeAt(undefined) === null && normalizeAt(0) === null)
  check('时间戳：毫秒原样保留', normalizeAt(1759384800000) === 1759384800000)

  // ⑤ 纯文本
  const txt = parsePlainText(['[12:34] 甲: 你好', '乙：在的', '这是一句被换行折断的长句', '甲: 第三句'].join('\n'))
  check('★ 认「昵称: 内容」（中文冒号也认）', txt.ok && txt.entries.length === 3, String(txt.entries.length))
  check('★ 没有昵称的行**并进上一条**（复制出来的记录常被折断）',
    txt.entries[1].text.includes('这是一句被换行折断的长句'), txt.entries[1].text)
  check('★ 并了多少行要说明（不许悄悄改结构）', txt.warnings.some((w) => /已并入上一条/.test(w)), txt.warnings.join(' | '))
  const txtBad = parsePlainText('第一行就认不出来\n随便写点什么')
  check('★ 第一行就认不出 → ok:false + warning（没有可并入的前一条）', txtBad.ok === false, txtBad.why)

  check('★ 只有标记的消息算"没有文字可评"', isOnlyMarkers('[图片]') && isOnlyMarkers('[表情][图片]') && !isOnlyMarkers('6'))
}

// ══════════════════════════════════════════════════════════════════════════
section('② 回合组装：只有机器人的话才被评，且带上下文')
// ══════════════════════════════════════════════════════════════════════════
{
  // ⚠️ 时间戳用**真实的量级**（毫秒 13 位）：`normalizeAt` 把小于 1e12 的数当**秒**
  //    （OneBot 的 `time` 就是秒），所以拿 3000 这种小数字当毫秒测，测的其实是另一条路。
  const T = Date.UTC(2026, 9, 1, 10, 0, 0)
  const entries = [
    { name: '甲', text: '坏了就让你的主人负责', at: T, flags: {} },
    { name: '乙', text: '哈哈哈哈', at: T + 1000, flags: {} },
    { name: '小鲸鱼', text: '原主人估计也不认，他连显卡都没挑好呢', at: T + 2000, flags: {} },
    { name: '甲', text: '鱼头用的什么手机', at: T + 3000, flags: {} },
    { name: '小鲸鱼', text: '[图片]', at: T + 4000, flags: {} },
    { name: '小鲸鱼', text: '没有手机', at: T + 5000, flags: {} },
  ]
  const r = buildTurns({ entries, selfNames: SELF_NAMES_DEFAULT, chatKey: 'group:1', contextBefore: 2 })
  check('★ 只把机器人的发言当被评对象', r.items.length === 2, `${r.items.length} 条`)
  check('★★ 上下文按需带（默认带前 1~3 条）', r.items[0].context.length === 2 && r.items[0].context[1].text === '哈哈哈哈',
    JSON.stringify(r.items[0].context))
  check('★ 整条只有标记的回复被跳过，且计数如实报出', r.skippedMarkers === 1, String(r.skippedMarkers))
  check('★ 上下文里标明"哪条也是机器人说的"', r.items[0].context.every((c) => c.isBot === false))
  check('★ 时间归一化后带到条目上', r.items[0].at === T + 2000 && r.items[1].at === T + 5000)

  // 去重：同一份记录导两次不该出现两份
  const again = buildTurns({ entries, selfNames: SELF_NAMES_DEFAULT, chatKey: 'group:1', contextBefore: 2 })
  check('★★ id 稳定：同一份记录重复导入不产生新条目',
    again.items.map((i) => i.id).join() === r.items.map((i) => i.id).join(),
    again.items[0].id)

  // 显式 is_bot 优先于昵称（语料库那条路）
  const byFlag = buildTurns({
    entries: [
      { name: '随便什么昵称', text: '我说的话', at: 1, flags: { isBot: true } },
      { name: '小鲸鱼', text: '这条不是它说的', at: 2, flags: { isBot: false } },
    ],
    selfNames: SELF_NAMES_DEFAULT,
    chatKey: 'g',
  })
  check('★ 有 is_bot 字段时按字段判（昵称不可靠）', byFlag.items.length === 1 && byFlag.items[0].reply === '我说的话',
    byFlag.items.map((i) => i.reply).join(' | '))

  // 上限：只保留最近 N 个回合
  const many = Array.from({ length: 20 }, (_, i) => ({ name: '小鲸鱼', text: `第 ${i} 条`, at: i + 1, flags: {} }))
  const capped = buildTurns({ entries: many, selfNames: SELF_NAMES_DEFAULT, chatKey: 'g', limit: 5 })
  check('★ limit 只保留**最近**的 N 个回合（评审看最近表现）',
    capped.items.length === 5 && capped.items[4].reply === '第 19 条' && capped.total === 20,
    capped.items.map((i) => i.reply).join(' | '))

  check('正文指纹稳定且短', fingerprint('abc') === fingerprint('abc') && fingerprint('abc').length === 8)
  check('批次 id 不含路径分隔符（它会被当文件名）', !/[\\/:*?"<>|]/.test(batchIdFor('群 860771987 · 语料库', Date.UTC(2026, 9, 2, 6, 40))),
    batchIdFor('群 860771987 · 语料库', Date.UTC(2026, 9, 2, 6, 40)))
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 仓库：批次 / 评分 / 撤销 / 删除 / 进度')
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = freshDir('ws')
  const styleDir = freshDir('style')
  writeFileSync(join(styleDir, '闲聊.md'), '【闲聊时的说话方式】\n- 极短。\n', 'utf8')
  const store = createReviewStore({ workspace: ws, styleFile: join(styleDir, '闲聊.md') })

  const items = [
    { id: 'i:g:1:1:aa', batch: 'b1', source: 'import', chatKey: 'g', chatLabel: '群 g', at: 1, context: [], reply: '第一句' },
    { id: 'i:g:1:2:bb', batch: 'b1', source: 'import', chatKey: 'g', chatLabel: '群 g', at: 2, context: [], reply: '第二句' },
    { id: 'i:g:1:3:cc', batch: 'b1', source: 'import', chatKey: 'g', chatLabel: '群 g', at: 3, context: [], reply: '第三句' },
  ]
  const created = store.createBatch({ label: 'b1', source: 'import', chatKey: 'g', chatLabel: '群 g', items })
  check('★ 建批次成功', created.ok && created.batch.items === 3, JSON.stringify(created.why ?? created.batch))
  check('★ 空批次被拒绝（"一个可评的回合都没有"不该建成批次）', store.createBatch({ label: 'empty', items: [] }).ok === false)
  check('★ 数据落在工作区的 runtime/chat-review 下', existsSync(join(ws, REVIEW_REL, 'index.json')) && existsSync(join(ws, REVIEW_REL, 'batches', 'b1.json')),
    join(ws, REVIEW_REL))

  check('★★ 不许给不存在的条目打分（进不了任何批次的 id）',
    store.saveScore({ id: 'nope', verdict: 'good' }).ok === false)
  check('★★ 结论只能是三档', store.saveScore({ id: items[0].id, verdict: 'excellent' }).ok === false)
  check('★★ 标签必须是税则里的 id（打错的会被点名）',
    store.saveScore({ id: items[0].id, verdict: 'bad', tags: ['too_long', '不存在'] }).why.includes('不存在'))

  const s1 = store.saveScore({ id: items[0].id, verdict: 'bad', tags: ['too_long', 'memory_detail'], note: '太长' })
  check('★ 打一条分', s1.ok && s1.score.verdict === 'bad' && s1.score.tags.length === 2)
  check('★ 立刻落盘（没有"保存"按钮，进程被杀也不丢）',
    existsSync(join(ws, REVIEW_REL, 'scores.json')) && JSON.parse(readFileSync(join(ws, REVIEW_REL, 'scores.json'), 'utf8')).scores[items[0].id]?.verdict === 'bad')
  store.saveScore({ id: items[1].id, verdict: 'good', tags: ['good_brief'] })
  check('★ 进度（已评/总数）', store.progress('b1').scored === 2 && store.progress('b1').total === 3,
    JSON.stringify(store.progress('b1')))
  check('★ 找得到条目属于哪个批次（打分响应要用它回进度）', store.findBatchOf(items[1].id) === 'b1')

  check('★ 重复提交 = 覆盖（评错了就是重评，不需要先删）',
    store.saveScore({ id: items[0].id, verdict: 'ok', tags: [] }).ok && store.scores()[items[0].id].verdict === 'ok')
  check('★ 覆盖之后进度不翻倍', store.progress('b1').scored === 2, JSON.stringify(store.progress('b1')))

  const u = store.undo('b1')
  check('★ 撤销的是**这个批次里最后打的那条**', u.ok && u.undone?.id === items[0].id, JSON.stringify(u.undone))
  check('★ 撤销之后进度跟着掉', store.progress('b1').scored === 1)
  store.saveScore({ id: items[0].id, verdict: 'bad', tags: ['too_long'] })
  store.saveScore({ id: items[2].id, verdict: 'good', tags: [] })
  const u2 = store.undo('b1')
  check('★ 再撤一次撤掉刚打的那条', u2.undone?.id === items[2].id, JSON.stringify(u2.undone))

  // 批次列表与统计
  const list = store.listBatches()
  check('★ 批次列表带实时进度', list.length === 1 && list[0].id === 'b1' && list[0].scored === 2, JSON.stringify(list))
  const st = store.stats('b1')
  // 走到这里的历史：items[1]=good；items[0]=bad（中间被覆盖成 ok 又撤销，最后重打 bad）；
  // items[2]=good 之后又被撤销 —— 所以此刻是 1 good + 1 bad。
  check('★ 统计：三档计数 + 每档比例', st.verdicts.bad === 1 && st.verdicts.good === 1 && st.rate.scored === 2, JSON.stringify(st.verdicts))
  check('★ 统计：标签命中排行带证据原文', st.tags.some((t) => t.id === 'too_long' && t.count === 1 && t.examples.length === 1),
    JSON.stringify(st.tags.map((t) => [t.id, t.count])))
  check('★ 统计：按会话拆开', st.chats[0].chatKey === 'g' && st.chats[0].bad === 1, JSON.stringify(st.chats))

  // 删除
  const del = store.deleteBatch('b1')
  check('★ 删批次连带删掉它的评分', del.ok && Object.keys(store.scores()).length === 0, JSON.stringify(del))
  check('★ 删过之后打分会被拒（不再是已知条目）', store.saveScore({ id: items[0].id, verdict: 'bad' }).ok === false)
  check('★ 删不存在的批次 → 明说（不是静默成功）', store.deleteBatch('nope').why.includes('没有这个批次'))
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 税则 / 草稿 / diff / 追加（唯一会碰风格文件的那条路）')
// ══════════════════════════════════════════════════════════════════════════
{
  check('★ 每个标签都有 id/label/kind/hint', TAGS.every((t) => t.id && t.label && t.kind && t.hint))
  check('★ 标签 id 不重复', new Set(TAGS.map((t) => t.id)).size === TAGS.length)
  check('★ bad 与 good 两类都有', TAGS.some((t) => t.kind === 'bad') && TAGS.some((t) => t.kind === 'good'))
  check('★ 三档结论与键位', VERDICTS.length === 3 && VERDICTS.map((v) => v.key).join('') === '123')
  check('★ 校验函数：未知标签被点名', validateScore({ verdict: 'bad', tags: ['nope'] }).why.includes('nope'))

  // 漂移：标签挂的规则原文必须在真实的风格文件里找得到
  const styleText = readFileSync(join(PKG_ROOT, 'styles', '闲聊.md'), 'utf8')
  const drift = taxonomyDrift({ styleText })
  check('★★ 每个标签挂的规则原文**都还在** styles/闲聊.md 里（改了风格文件就会在这里红）',
    drift.ok, drift.drift.map((d) => `${d.label}→「${d.ruleQuote}」`).join(' | ') || '（全部对得上）')
  const drifted = taxonomyDrift({ styleText: '这里什么都没有' })
  check('★★ 风格文件被改空时必须报漂移（不是"看起来没事"）', drifted.ok === false && drifted.drift.length > 0,
    `${drifted.drift.length} 条漂移`)

  // 草稿文本
  const fakeItems = [
    { id: 'x1', reply: '原主人估计也不认，他连显卡都没挑好呢', context: [{ name: '甲', text: '坏了就让你的主人负责' }], chatKey: 'g', chatLabel: '群 g' },
    { id: 'x2', reply: '手机？我住在一台 X99 主板的机箱里面，没有手机', context: [{ name: '甲', text: '鱼头用的什么手机' }], chatKey: 'g', chatLabel: '群 g' },
  ]
  const scores = {
    x1: { verdict: 'bad', tags: ['memory_detail'], note: '别抖记忆' },
    x2: { verdict: 'bad', tags: ['self_intro'], note: '' },
  }
  const agg = aggregateStats({ items: fakeItems, scores })
  const { block } = renderProposedBlock({ stats: agg, now: Date.UTC(2026, 9, 2, 4, 0) })
  check('★★ 草稿把**真实反例**写进去（这是它唯一的产出）', block.includes('原主人估计也不认') && block.includes('X99'), block.slice(0, 60))
  check('★ 草稿按"哪条规则"归类', block.includes('「主动抖记忆」') && block.includes('「顺势自述」'))
  check('★ 草稿带上下文（不然看不出它错在哪）', block.includes('坏了就让你的主人负责'))
  check('★ 草稿带评审备注', block.includes('别抖记忆'))
  check('★ 草稿标题说明来源与生成时间', block.includes('人工评审') && block.includes('2026'))
  check('★ 没有证据时草稿为空（不许编）', renderProposedBlock({ stats: aggregateStats({ items: fakeItems, scores: {} }) }).block === '')
  const long = renderProposedBlock({
    stats: { tags: TAGS.filter((t) => t.kind === 'bad').map((t) => ({ ...t, count: 1, examples: [{ id: 'z', reply: 'r', context: 'c' }] })), rate: { scored: 99 } },
    maxLines: 12,
  })
  check('★ 行数上限生效并如实说明截断（草稿是要进提示词的）',
    long.truncated === true && long.block.split('\n').length <= 14, `${long.block.split('\n').length} 行`)

  // diff
  const before = 'a\nb\nc\n'
  const after = 'a\nb\nc\nd\n'
  const diff = unifiedDiff(before, after, { aName: 'x', bName: 'x' })
  check('★ diff 有文件头与 hunk 头', diff.startsWith('--- x') && diff.includes('+++ x') && /@@ -\d+,\d+ \+\d+,\d+ @@/.test(diff), diff.split('\n')[2])
  check('★ 新增行以 + 开头', diff.split('\n').some((l) => l === '+d'))
  const diff2 = unifiedDiff('a\nb\n', 'a\nB\n')
  check('★ 改一行时同时出现 - 与 +', diff2.includes('-b') && diff2.includes('+B'), diff2)

  // 追加
  const ok = appendBlock(before, 'NEW')
  check('★ 追加保留原内容并留一空行', ok.ok && ok.text === 'a\nb\nc\n\nNEW\n', JSON.stringify(ok.text))
  check('★★ 同一份草稿不许写第二遍（否则提示词里两段一样的反例，白烧 token）',
    appendBlock(ok.text, 'NEW').ok === false && appendBlock(ok.text, 'NEW').why.includes('已经在'))
  check('★ 空草稿被拒', appendBlock(before, '   ').ok === false)
  check('★ sha256 稳定', sha256('x') === sha256('x') && sha256('x').length === 64)

  // 端到端：draft → apply（**带备份**）
  const ws = freshDir('ws2')
  const styleDir = freshDir('style2')
  const stylePath = join(styleDir, '闲聊.md')
  writeFileSync(stylePath, styleText, 'utf8')
  const store = createReviewStore({ workspace: ws, styleFile: stylePath })
  const items = fakeItems.map((it) => ({ ...it, batch: 'b2', source: 'import', at: 1 }))
  store.createBatch({ label: 'b2', source: 'import', items })
  for (const [id, s] of Object.entries(scores)) store.saveScore({ id, ...s })

  const d = store.draft('b2')
  check('★ draft 给出建议清单 + 待追加文本 + diff', d.suggestions.length === 2 && d.proposedBlock && d.diff, `${d.suggestions.length} 条建议`)
  check('★ 建议里带"这条规则被违反了几次"与它挂的规则原文',
    d.suggestions[0].count === 1 && d.suggestions[0].ruleQuote === '别主动抖记忆里的细节', JSON.stringify(d.suggestions[0].ruleQuote))
  check('★ diff 指向真实文件路径', d.diff.includes(stylePath))

  check('★★ 没确认就想应用 → 拒绝（没有"默认应用"这件事）', store.applyDraft({ scope: 'b2' }).ok === false)
  const applied = store.applyDraft({ scope: 'b2', confirm: true })
  check('★★ 应用成功并返回备份路径', applied.ok && existsSync(applied.backup), String(applied.why ?? applied.backup))
  const styleAfter = readFileSync(stylePath, 'utf8')
  check('★ 文件真的变了，且原内容一字未动', styleAfter.startsWith(styleText.replace(/\s+$/, '')) && styleAfter.includes('原主人估计也不认'))
  check('★ 备份里是**改动前**的内容', readFileSync(applied.backup, 'utf8') === styleText)
  check('★ 返回新的 sha256（页面上用来确认"我看到的和写进去的是同一份"）', applied.sha256 === sha256(styleAfter))
  check('★★ 同一份草稿再应用一次 → 409（不重复写）',
    store.applyDraft({ scope: 'b2', confirm: true }).code === 409, String(store.applyDraft({ scope: 'b2', confirm: true }).why))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 语料库新增的两个只读方法（评审台的数据源）')
// ══════════════════════════════════════════════════════════════════════════
{
  const ws = freshDir('corpus')
  const c = createCorpus({ workspace: ws, log: () => {} })
  const at = new Date('2026-10-01T10:00:00Z')
  c.record({ kind: 'group', peerId: '860771987', senderName: '甲', userId: '1', text: '鱼头用的什么手机', at })
  c.record({ kind: 'group', peerId: '860771987', senderName: '小鲸鱼', text: '手机？我住在一台 X99 主板的机箱里面', isBot: true, at: new Date(at.getTime() + 1000) })
  c.record({ kind: 'private', peerId: '10001', senderName: '乙', text: '在吗', at })
  c.record({ kind: 'private', peerId: '10001', senderName: '小鲸鱼', text: '在的', isBot: true, at })
  // 一条超长的，用来验"评审要看全文"
  const longText = '很长的一句话。'.repeat(80) // 560 字
  c.record({ kind: 'group', peerId: '860771987', senderName: '小鲸鱼', text: longText, isBot: true, at })

  const t = c.transcript({ chatKey: 'group:860771987', limit: 10 })
  check('★ transcript 取整段会话（含机器人发言）', t.ok && t.rows.length === 3, String(t.rows.length))
  check('★ 顺序由旧到新', t.rows[0].text === '鱼头用的什么手机' && t.rows[0].isBot === false && t.rows[1].isBot === true)
  check('★★ 默认不截断正文（截断会把"这句多长"这个被评属性本身改掉）',
    t.rows[2].text === longText && t.rows[2].truncated === false, `${t.rows[2].text.length} 字`)
  check('★ fail-closed：不给会话就拒绝', c.transcript({}).ok === false)
  check('★ 不存在的会话 → 空数组（不是错误）', c.transcript({ chatKey: 'group:404' }).ok === true && c.transcript({ chatKey: 'group:404' }).rows.length === 0)

  const sums = c.chatSummaries()
  check('★ chatSummaries 按**机器人发言数**排序（评审一个机器人不说话的群没意义）',
    sums.ok && sums.chats[0].chatKey === 'group:860771987' && sums.chats[0].botReplies === 2,
    JSON.stringify(sums.chats))
  check('★ 总数与机器人发言数分开给', sums.chats[1].total === 2 && sums.chats[1].botReplies === 1, JSON.stringify(sums.chats[1]))
  check('★ 带最后一条的时间（页面要显示"最近活跃"）', typeof sums.chats[0].lastAt === 'number')

  // 只读句柄也要能读（评审台就是这么用的：绝不往语料库写）
  const ro = createCorpus({ workspace: ws, log: () => {}, readOnly: true })
  check('★★ readOnly 句柄能读 transcript / chatSummaries（评审台用的就是它）',
    ro.transcript({ chatKey: 'group:860771987' }).rows.length === 3 && ro.chatSummaries().chats.length === 2)
  c.close()
  ro.close()
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ 端到端 HTTP：每条路由 + 错误码')
// ══════════════════════════════════════════════════════════════════════════
const live = []
async function withServer(tag, fn, { log = () => {} } = {}) {
  const ws = freshDir(tag)
  const styleDir = freshDir(`${tag}-style`)
  writeFileSync(join(styleDir, '闲聊.md'), readFileSync(join(PKG_ROOT, 'styles', '闲聊.md'), 'utf8'), 'utf8')
  // 先造一点语料：评审台的数据源
  const c = createCorpus({ workspace: ws, log: () => {} })
  const at = new Date('2026-10-01T10:00:00Z')
  c.record({ kind: 'group', peerId: '700001', senderName: '甲', userId: '1', text: '鱼头用的什么手机', at })
  c.record({ kind: 'group', peerId: '700001', senderName: '小鲸鱼', text: '手机？我住在一台 X99 主板的机箱里面', isBot: true, at })
  c.record({ kind: 'group', peerId: '700001', senderName: '甲', userId: '1', text: '坏了就让你的主人负责', at })
  c.record({ kind: 'group', peerId: '700001', senderName: '小鲸鱼', text: '原主人估计也不认', isBot: true, at })
  c.close()

  const app = createReviewServer({ workspace: ws, styleDir, log })
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r))
  const port = app.server.address().port
  const base = `http://127.0.0.1:${port}`
  live.push(app)
  const api = async (path, init) => {
    const res = await fetch(`${base}${path}`, init)
    const text = await res.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { status: res.status, body, headers: res.headers }
  }
  const post = (path, payload) =>
    api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}) })
  try {
    await fn({ api, post, base, ws, styleDir, app })
  } finally {
    app.close()
  }
}

await withServer('http', async ({ api, post, base, styleDir, app }) => {
  const health = await api('/api/health')
  check('★ GET /api/health 报环境事实（工作区/语料库/风格文件）',
    health.status === 200 && health.body.ok && health.body.corpus.ok && health.body.styleFile.exists,
    JSON.stringify(health.body.corpus))
  check('★ health 里带 startedAt（分辨页面跑的是不是新进程）', typeof health.body.startedAt === 'number')
  check('★ health 里带风格文件 sha256（确认"看到的就是写进去的"）', /^[0-9a-f]{64}$/.test(health.body.styleFile.sha256))

  const tax = await api('/api/taxonomy')
  check('★ GET /api/taxonomy 给三档 + 标签 + 漂移（此处应为空）',
    tax.body.ok && tax.body.verdicts.length === 3 && tax.body.tags.length === TAGS.length && tax.body.drift.length === 0,
    `${tax.body.tags?.length} 标签 / ${tax.body.drift?.length} 漂移`)

  const sources = await api('/api/sources')
  check('★ GET /api/sources 列语料库会话（带机器人发言数）',
    sources.body.ok && sources.body.corpus.chats[0].botReplies === 2 && sources.body.corpus.chats[0].label === '群 700001',
    JSON.stringify(sources.body.corpus.chats?.[0]))
  check('★ 一开始没有批次', sources.body.batches.length === 0)

  const badPull = await post('/api/pull', {})
  check('★ POST /api/pull 不给会话 → 400（fail-closed）', badPull.status === 400 && /必须指定会话/.test(badPull.body.error), badPull.body.error)

  const pull = await post('/api/pull', { chatKey: 'group:700001', limit: 50, contextBefore: 1, batchLabel: '第一轮' })
  check('★ POST /api/pull 真的拉出回合（2 个）', pull.body.ok && pull.body.items === 2, JSON.stringify(pull.body.error ?? pull.body.items))
  check('★ 新建的批次出现在 /api/sources 里', (await api('/api/sources')).body.batches.length === 1)
  const batchId = pull.body.batch.id

  const items = await api(`/api/items?batch=${encodeURIComponent(batchId)}&filter=unrated`)
  check('★ GET /api/items 默认只推没评的（页面第一屏就该是待评的）',
    items.body.ok && items.body.total === 2 && items.body.items.every((i) => i.score === null), JSON.stringify(items.body.total))
  check('★ 条目带上下文（评审必须有上下文）', items.body.items[0].context.length >= 1, JSON.stringify(items.body.items[0].context))
  const firstId = items.body.items[0].id
  const secondId = items.body.items[1].id

  check('★ GET /api/items 批次不存在 → 404', (await api('/api/items?batch=nope')).status === 404)
  check('★ GET /api/items 不认识 filter 时按"未评"处理（不是 500）',
    (await api(`/api/items?batch=${encodeURIComponent(batchId)}&filter=乱写`)).body.total === 2)

  const scored = await post('/api/score', { id: firstId, verdict: 'bad', tags: ['memory_detail'], note: '别抖记忆' })
  check('★ POST /api/score 落盘并回进度', scored.body.ok && scored.body.progress.scored === 1 && scored.body.batchId === batchId,
    JSON.stringify(scored.body.progress))
  check('★ 打分后"未评"少了一条', (await api(`/api/items?batch=${encodeURIComponent(batchId)}&filter=unrated`)).body.total === 1)
  check('★ 打分后"已评"能查到它', (await api(`/api/items?batch=${encodeURIComponent(batchId)}&filter=rated`)).body.total === 1)
  const badScore = await post('/api/score', { id: firstId, verdict: '乱写' })
  check('★ 结论不合法 → 400 且说明只能是哪三档', badScore.status === 400 && /good \/ ok \/ bad/.test(badScore.body.error), badScore.body.error)
  const unknownId = await post('/api/score', { id: 'i:x:y:z', verdict: 'bad' })
  check('★ 不存在的条目 → 400（不许悄悄写进一个孤儿分数）', unknownId.status === 400, unknownId.body.error)

  const undone = await post('/api/undo', { batch: batchId })
  check('★ POST /api/undo 撤销刚打的那条', undone.body.ok && undone.body.undone?.id === firstId && undone.body.progress.scored === 0)
  await post('/api/score', { id: firstId, verdict: 'bad', tags: ['memory_detail'] })
  await post('/api/score', { id: secondId, verdict: 'bad', tags: ['self_intro'] })

  const stats = await api(`/api/stats?batch=${encodeURIComponent(batchId)}`)
  check('★ GET /api/stats 给分布 + 标签排行 + 证据', stats.body.ok && stats.body.verdicts.bad === 2 && stats.body.tags.length >= 2,
    JSON.stringify(stats.body.verdicts))
  check('★ stats 的证据里带被评原文（报告页要能点开看）', stats.body.tags[0].examples[0].reply.length > 0)

  const draft = await api(`/api/draft?batch=${encodeURIComponent(batchId)}`)
  check('★ GET /api/draft 生成草稿 + diff', draft.body.ok && draft.body.draft.proposedBlock && draft.body.draft.diff,
    `${draft.body.draft.suggestions.length} 条建议`)
  check('★ 草稿里的反例是**真实被评的那两句**',
    draft.body.draft.proposedBlock.includes('X99') && draft.body.draft.proposedBlock.includes('原主人估计也不认'))

  const noConfirm = await post('/api/apply', { batch: batchId })
  check('★★ POST /api/apply 不带 confirm → 400（唯一改人格的操作必须有确认）', noConfirm.status === 400, noConfirm.body.error)
  const styleBefore = readFileSync(join(styleDir, '闲聊.md'), 'utf8')
  const applied = await post('/api/apply', { batch: batchId, confirm: true })
  check('★★ POST /api/apply 成功并留下备份', applied.status === 200 && existsSync(applied.body.backup), String(applied.body.error ?? applied.body.backup))
  check('★★ 备份与改动前**逐字相同**', readFileSync(applied.body.backup, 'utf8') === styleBefore)
  const styleAfter = readFileSync(join(styleDir, '闲聊.md'), 'utf8')
  check('★ 风格文件被追加了草稿（且原内容一字未动）',
    styleAfter.length > styleBefore.length && styleAfter.startsWith(styleBefore.replace(/\s+$/, '')), `${styleBefore.length} → ${styleAfter.length}`)
  check('★ 应用后再取 diff 会说"已经在文件里了"（不重复写）',
    (await api(`/api/draft?batch=${encodeURIComponent(batchId)}`)).body.draft.alreadyApplied === true)
  check('★★ 再应用一次 → 409', (await post('/api/apply', { batch: batchId, confirm: true })).status === 409)

  // 导入路
  const forward = {
    messages: [
      { sender: { nickname: '甲' }, message: [{ type: 'text', data: { text: 'ciallo' } }], time: 1759384800 },
      { sender: { nickname: '小鲸鱼' }, message: [{ type: 'text', data: { text: 'ciallo~' } }], time: 1759384860 },
    ],
  }
  const imp = await post('/api/import', { format: 'forward-json', text: JSON.stringify(forward), batchLabel: '老王发的' })
  check('★ POST /api/import（合并转发）认出机器人发言', imp.body.ok && imp.body.items === 1, JSON.stringify(imp.body.error ?? imp.body.items))
  const imp2 = await post('/api/import', { format: 'text', text: '甲: 在吗\n小鲸鱼: 在的\n', batchLabel: '文本' })
  check('★ POST /api/import（纯文本）', imp2.body.ok && imp2.body.items === 1, JSON.stringify(imp2.body.error ?? imp2.body.items))
  const impBad = await post('/api/import', { format: 'forward-json', text: '{坏的' })
  check('★ 导入坏 JSON → 400 + 给人看的理由', impBad.status === 400 && /JSON 解析失败/.test(impBad.body.error), impBad.body.error)
  const impNone = await post('/api/import', { format: 'text', text: '甲: 你好\n乙: 你也好\n' })
  check('★★ 一条机器人发言都没有 → 400 + 告诉它认哪些昵称',
    impNone.status === 400 && (impNone.body.warnings ?? []).some((w) => /认这些名字/.test(w)),
    (impNone.body.warnings ?? []).join(' | '))
  check('★ 空粘贴 → 400', (await post('/api/import', { format: 'text', text: '   ' })).status === 400)

  // 静态页
  const page = await fetch(`${base}/`)
  const html = await page.text()
  check('★ GET / 返回页面', page.status === 200 && /<html/i.test(html), `${html.length} 字`)
  check('★★ HTML 里的 app.js / style.css 被挂上版本串（重启即换 URL，避免跑旧脚本）',
    /\/app\.js\?v=\d+/.test(html) && /\/style\.css\?v=\d+/.test(html))
  // ★★ 替换必须**只改标签**：页面里那段注释也提到了这两个属性名，裸替换会把注释一起改掉
  //    （实测踩到：注释里写着"必须一字不差"，可它自己已经被改了）。所以这里数出现次数。
  check('★★ 版本串各只挂一处（注释里的说明不许被顺手改掉）',
    (html.match(/\/app\.js\?v=\d+/g) ?? []).length === 1 && (html.match(/\/style\.css\?v=\d+/g) ?? []).length === 1,
    `app.js ${(html.match(/\/app\.js\?v=\d+/g) ?? []).length} 处 / style.css ${(html.match(/\/style\.css\?v=\d+/g) ?? []).length} 处`)
  const js = await fetch(`${base}/app.js`)
  check('★ GET /app.js 返回 JS（类型对）', js.status === 200 && String(js.headers.get('content-type')).includes('javascript'))
  check('★ GET /style.css 返回 CSS', (await fetch(`${base}/style.css`)).status === 200)
  check('★★ 目录穿越被拦（403/404，不许把包外文件吐出去）',
    [403, 404].includes((await fetch(`${base}/../config.json`)).status) &&
      [403, 404].includes((await fetch(`${base}/..%2f..%2fconfig.json`)).status))
  check('★ 不存在的静态资源 → 404', (await fetch(`${base}/nope.js`)).status === 404)
  check('★ favicon 给 204（省掉浏览器一条会误导人的 404）', (await fetch(`${base}/favicon.ico`)).status === 204)

  // 删批次
  const del = await api(`/api/batch?id=${encodeURIComponent(batchId)}`, { method: 'DELETE' })
  check('★ DELETE /api/batch 删掉批次', del.body.ok && del.body.removed === 2, JSON.stringify(del.body))
  check('★ 删过之后条目也查不到了（404，不是空列表）', (await api(`/api/items?batch=${encodeURIComponent(batchId)}`)).status === 404)
  check('★ 删不存在的批次 → 404', (await api('/api/batch?id=nope', { method: 'DELETE' })).status === 404)
  check('★★ 删批次**不动风格文件**（那是应用草稿的结果，批次的生死与它无关）',
    readFileSync(join(styleDir, '闲聊.md'), 'utf8') === styleAfter)
})

// 语料库不可用时：不许假装有数据
await withServer('nocorpus', async ({ api, post, ws, app }) => {
  // 把语料库换成一个打不开的东西（同名的目录会让 SQLite 直接失败）
  rmSync(join(ws, 'runtime', 'corpus.sqlite'), { force: true })
  app.corpus.close()
  mkdirSync(join(ws, 'runtime', 'corpus.sqlite'), { recursive: true })
  const health = await api('/api/health')
  check('★★ 语料库打不开 → health 如实说 ok:false + 为什么（不许报 0 条冒充"空库"）',
    health.body.corpus.ok === false && typeof health.body.corpus.why === 'string', JSON.stringify(health.body.corpus))
  const sources = await api('/api/sources')
  check('★★ sources 也如实说语料库不可用（页面据此显示"用不了"而不是"没有会话"）',
    sources.body.corpus.ok === false && sources.body.corpus.chats.length === 0, JSON.stringify(sources.body.corpus))
  const pull = await post('/api/pull', { chatKey: 'group:1' })
  check('★ 此时拉取 → 400 且说明读库失败（不是静默空批次）', pull.status === 400 && /语料库/.test(pull.body.error), pull.body.error)
  check('★ 但导入与打分照常可用（工具不该被语料库拖死）',
    (await post('/api/import', { format: 'text', text: '小鲸鱼: 在的\n', batchLabel: '无库导入' })).body.ok === true)
})

// 日志写不出去时：服务不许跟着倒
await withServer(
  'badlog',
  async ({ api, base }) => {
    // 先制造一条**会写日志**的失败请求（静态资源 404 → `say()` 被调用 → 我们的 log 抛）
    const miss = await fetch(`${base}/nope-${'x'.repeat(200)}.js`)
    const health = await api('/api/health')
    const sources = await api('/api/sources')
    check('★★ 日志写不出去（stdout 管道断了 / 父进程没了）也不许弄挂服务',
      miss.status === 404 && health.body.ok === true && sources.body.ok === true,
      `404=${miss.status} health=${health.body.ok} sources=${sources.body.ok}`)
  },
  // 模拟"父进程消失、stdout 管道断了"：任何一次 console.log 都会抛
  { log: () => { throw new Error('EPIPE: 管道断了') } },
)

// ══════════════════════════════════════════════════════════════════════════
section('⑦ 接线审计：API.md ↔ 服务端路由 ↔ 页面调用（三份互相对账）')
// ══════════════════════════════════════════════════════════════════════════
{
  const apiMd = readFileSync(join(PKG_ROOT, 'chat-review', 'API.md'), 'utf8')
  const serverSrc = readFileSync(join(PKG_ROOT, 'src', 'chat-review-server.mjs'), 'utf8')
  const appPath = join(PKG_ROOT, 'chat-review', 'public', 'app.js')

  // 标题里带查询串（`### \`GET /api/items?batch=…\``），所以只取到路径为止
  const documented = new Set([...apiMd.matchAll(/^###\s+`(?:GET|POST|DELETE)\s+(\/api\/[\w/-]+)/gm)].map((m) => m[1]))
  const routed = new Set([...serverSrc.matchAll(/['"](\/api\/[\w/-]+)['"]/g)].map((m) => m[1]))

  check('★ API.md 里每条路由服务端都真的有', [...documented].every((p) => routed.has(p)),
    [...documented].filter((p) => !routed.has(p)).join(' | ') || `（${documented.size} 条都对得上）`)
  check('★ 服务端没有"文档里没写"的路由（否则下一个人不知道它存在）',
    [...routed].every((p) => documented.has(p)), [...routed].filter((p) => !documented.has(p)).join(' | ') || '（准的）')

  check('★★ 页面文件在（public/index.html + app.js + style.css）',
    existsSync(appPath) && existsSync(join(PKG_ROOT, 'chat-review', 'public', 'index.html')) &&
      existsSync(join(PKG_ROOT, 'chat-review', 'public', 'style.css')))
  if (existsSync(appPath)) {
    const app = readFileSync(appPath, 'utf8')
    const called = new Set([...app.matchAll(/['"`](\/api\/[\w/-]+)/g)].map((m) => m[1]))
    // ★★ 这一条防的是"页面调了一个不存在的接口"—— 它在浏览器里只表现为"点了没反应"，
    //    而服务端日志干干净净，是最难查的一类。静态对账能当场抓住。
    check('★★ 页面调用的每个 /api 路由都真的存在（点了没反应的那类 bug）',
      [...called].every((p) => routed.has(p)), [...called].filter((p) => !routed.has(p)).join(' | ') || `（${called.size} 条）`)
    check('★ 页面把"没有保存按钮"这件事做对了：打分走 POST /api/score',
      called.has('/api/score'))
    check('★ 页面用了撤销接口', called.has('/api/undo'))
    check('★ 页面用了草稿与应用接口', called.has('/api/draft') && called.has('/api/apply'))

    // 反例：把一条不存在的路由塞进去必须能被抓住（否则上面那条断言是空的）
    const bogus = new Set([...`${app}\nfetch('/api/definitely-not-real')`.matchAll(/['"`](\/api\/[\w/-]+)/g)].map((m) => m[1]))
    check('★★ 反向自检：伪造一个不存在的路由，这条审计确实会红',
      [...bogus].some((p) => !routed.has(p)))
  }

  // ★★ 发布清单：这个工具整个目录必须进包
  //    （漏了它的后果是"用户拿到包以后点开没有页面"，而且**不会报错** ——
  //     与 `sticker-label` 那条同样的坑，所以同样用断言钉住）
  const assemble = readFileSync(join(PKG_ROOT, 'scripts', 'assemble-release.mjs'), 'utf8')
  const copyDirs = /const COPY_DIRS = \[([^\]]*)\]/.exec(assemble)?.[1] ?? ''
  check('★★ 发布清单 COPY_DIRS 里有 chat-review（否则发布包里没有页面）',
    /'chat-review'/.test(copyDirs), copyDirs.trim().slice(0, 120))
  check('★ 且清单里那一行写了为什么（下一个人不该把它当垃圾删掉）',
    /chat-review[\s\S]{0,200}不属于控制台|不属于控制台[\s\S]{0,200}chat-review/.test(assemble) ||
      /chat-review/.test(assemble.slice(Math.max(0, assemble.indexOf("'chat-review'") - 600), assemble.indexOf("'chat-review'"))),
    '')
  check('★ 工具的启动壳与启动 .bat 都在',
    existsSync(join(PKG_ROOT, 'chat-review', 'server.mjs')) && existsSync(join(PKG_ROOT, 'chat-review', '启动评审.bat')))
  const bat = readFileSync(join(PKG_ROOT, 'chat-review', '启动评审.bat'), 'utf8')
  // ★ .bat 必须**纯 ASCII**：cmd 用系统代码页（中文 Windows 上是 GBK）解析它，
  //   UTF-8 中文会吞掉换行、把解析搞乱（start.bat 上踩过，所以这条要一直钉住）
  check('★★ 启动 .bat 是纯 ASCII（中文会吞换行、把 cmd 解析搞乱）', /^[\x00-\x7F]*$/.test(bat),
    (bat.match(/[^\x00-\x7F]/g) ?? []).slice(0, 5).join(''))
}

// ══════════════════════════════════════════════════════════════════════════
// 收尾
// ══════════════════════════════════════════════════════════════════════════
for (const app of live) {
  try {
    app.close()
  } catch {
    /* 已经关过了 */
  }
}
for (const d of tmpDirs) {
  try {
    rmSync(d, { recursive: true, force: true })
  } catch {
    /* 临时目录删不掉无所谓 */
  }
}

console.log('')
if (failed === 0) {
  console.log(`🎉 聊天记录评审台测试全部通过（${passed} 项）`)
  process.exit(0)
}
console.log(`❌ ${failed} 项失败（${passed} 项通过）`)
process.exit(1)
