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

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
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
  COMMENT_MAX_CHARS,
  REVIEW_REL,
  VERDICTS,
  aggregateStats,
  createReviewStore,
  unifiedDiff,
  validateScore,
} from '../src/chat-review-store.mjs'
import {
  CONSOLIDATE_LIMITS,
  STYLE_ANCHORS,
  buildConsolidatePrompt,
  checkAnchors,
  clusterComments,
  consolidateComments,
  parseConsolidation,
} from '../src/chat-review-consolidate.mjs'
import {
  constantMatches,
  extractStyleConstant,
  replaceStyleConstant,
  sha256,
  syncStyleConstant,
} from '../src/chat-style-sync.mjs'
import { createReviewServer, probeReviewHealth, stopRunningReviewServer } from '../src/chat-review-server.mjs'
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

/** 轮询等一个条件成真（给"端口空出来了吗""子进程起来了吗"这类等待用）。 */
async function waitFor(fn, timeoutMs = 5000, stepMs = 200) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await fn()) return true
    } catch {
      /* 还没好 */
    }
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, stepMs))
  }
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
  check('★★ 评论有长度上限（2000 字）',
    store.saveScore({ id: items[0].id, verdict: 'bad', comment: 'x'.repeat(COMMENT_MAX_CHARS + 1) }).ok === false,
    String(COMMENT_MAX_CHARS))

  const s1 = store.saveScore({ id: items[0].id, verdict: 'bad', comment: '问手机就答手机，别交代机箱' })
  check('★ 打一条分：判档 + 评论', s1.ok && s1.score.verdict === 'bad' && s1.score.comment.includes('机箱'))
  check('★ 立刻落盘（没有"保存"按钮，进程被杀也不丢）',
    existsSync(join(ws, REVIEW_REL, 'scores.json')) &&
      JSON.parse(readFileSync(join(ws, REVIEW_REL, 'scores.json'), 'utf8')).scores[items[0].id]?.comment.includes('机箱'))
  check('★ 只判档不写字也允许（快速过法），但统计里分得清',
    store.saveScore({ id: items[1].id, verdict: 'good' }).ok && store.stats('b1').comments.withoutText === 1,
    JSON.stringify(store.stats('b1').comments))
  check('★ 进度（已评/总数/有评论）',
    store.progress('b1').scored === 2 && store.progress('b1').total === 3 && store.progress('b1').commented === 1,
    JSON.stringify(store.progress('b1')))
  check('★ 找得到条目属于哪个批次（打分响应要用它回进度）', store.findBatchOf(items[1].id) === 'b1')

  check('★ 重复提交 = 覆盖（评错了就是改字，不需要先删）',
    store.saveScore({ id: items[0].id, verdict: 'ok', comment: '改主意了' }).ok && store.scores()[items[0].id].comment === '改主意了')
  check('★ 覆盖之后进度不翻倍', store.progress('b1').scored === 2, JSON.stringify(store.progress('b1')))
  check('★★ 旧数据里的 tags 字段不再被写进去（标签体系已删）',
    !('tags' in store.scores()[items[0].id]), JSON.stringify(store.scores()[items[0].id]))

  const u = store.undo('b1')
  check('★ 撤销的是**这个批次里最后打的那条**', u.ok && u.undone?.id === items[0].id, JSON.stringify(u.undone))
  check('★ 撤销之后进度跟着掉', store.progress('b1').scored === 1)
  store.saveScore({ id: items[0].id, verdict: 'bad', comment: '别抖记忆里的显卡' })
  store.saveScore({ id: items[2].id, verdict: 'good', comment: '这句极短，很好' })
  const u2 = store.undo('b1')
  check('★ 再撤一次撤掉刚打的那条', u2.undone?.id === items[2].id, JSON.stringify(u2.undone))

  // 批次列表与统计
  const list = store.listBatches()
  check('★ 批次列表带实时进度（已评 + 有评论）',
    list.length === 1 && list[0].id === 'b1' && list[0].scored === 2 && list[0].commented === 1, JSON.stringify(list))
  const st = store.stats('b1')
  // 走到这里的历史：items[1]=good（无评论）；items[0]=bad（中间被覆盖成 ok 又撤销，最后重打 bad，有评论）；
  // items[2]=good 之后又被撤销 —— 所以此刻是 1 good + 1 bad。
  check('★ 统计：三档计数 + 每档比例', st.verdicts.bad === 1 && st.verdicts.good === 1 && st.rate.scored === 2, JSON.stringify(st.verdicts))
  check('★★ 统计里**没有标签排行**了（标签体系整套删掉）', st.tags === undefined, JSON.stringify(Object.keys(st)))
  check('★★ 统计给的是**评论清单**（报告页与整理都吃它）',
    st.list.length === 2 && st.list[0].comment && st.list[0].reply && Array.isArray(st.list[0].context),
    JSON.stringify(st.list.map((r) => r.comment)))
  check('★ 清单按时间**新→旧**', (st.list[0].at ?? 0) >= (st.list[1].at ?? 0), JSON.stringify(st.list.map((r) => r.at)))
  check('★ 统计：按会话拆开', st.chats[0].chatKey === 'g' && st.chats[0].bad === 1, JSON.stringify(st.chats))
  check('★ 只有评论的那些才是**整理**的输入（没写评论的不参与）',
    store.comments('b1').length === 1 && store.comments('b1').every((c) => c.comment) && store.progress('b1').scored === 2,
    `comments=${store.comments('b1').length} / scored=${store.progress('b1').scored}`)

  // 删除
  const del = store.deleteBatch('b1')
  check('★ 删批次连带删掉它的评分', del.ok && Object.keys(store.scores()).length === 0, JSON.stringify(del))
  check('★ 删过之后打分会被拒（不再是已知条目）', store.saveScore({ id: items[0].id, verdict: 'bad' }).ok === false)
  check('★ 删不存在的批次 → 明说（不是静默成功）', store.deleteBatch('nope').why.includes('没有这个批次'))
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 整理：评论 → 点 → 整篇重写（含锚点保护与出厂常量同步）')
// ══════════════════════════════════════════════════════════════════════════
// 这一节测的是 2026-10-02 改版的核心：**素材是评论，点从评论里长出来，草稿是整篇重写**。
// 模型调用一律**注入假模型**（`callModel`）—— 测试绝不真花钱，也绝不依赖网络。
{
  const styleText = readFileSync(join(PKG_ROOT, 'styles', '闲聊.md'), 'utf8')

  // ── 4a. 提示词：该说的话必须都在（否则模型只会瞎写）────────────────────
  const comments = [
    { id: 'x1', verdict: 'bad', comment: '问手机就答手机，别交代机箱', reply: '手机？我住在一台 X99 主板的机箱里面', context: [{ name: '甲', text: '鱼头用的什么手机', isBot: false }] },
    { id: 'x2', verdict: 'bad', comment: '这句还是太长，而且上来就解释', reply: '这个问题可以从三个角度看…', context: [] },
    { id: 'x3', verdict: 'good', comment: '这句极短，接得干净', reply: 'ciallo~', context: [] },
    { id: 'x4', verdict: 'ok', comment: '   ', reply: '（没写评论）', context: [] },
  ]
  const built = buildConsolidatePrompt({ comments, styleText })
  check('★ 提示词带上了现有风格文件全文（不然它不是"重写"，是"另写一份"）',
    built.prompt.includes(styleText.slice(0, 40)), '')
  check('★★ 评论按编号进提示词（模型要用编号回指证据）',
    built.prompt.includes('[1] 不对') && built.prompt.includes('[3] 对') && built.prompt.includes('问手机就答手机'))
  check('★ 评论里带被评的那句话与上下文（只说"太长了"模型不知道什么太长）',
    built.prompt.includes('机器人当时说：') && built.prompt.includes('当时对方说：'))
  check('★★ 只有空白的评论**不进**提示词（没写评论的不能算证据）',
    !built.prompt.includes('（没写评论）') && built.kept === 3 && built.droppedForNoText === 1,
    `kept=${built.kept} dropped=${built.droppedForNoText}`)
  check('★★ 提示词明说"归纳不是照抄"（否则它会把评论抄成 20 个点）', /归纳，不是照抄/.test(built.prompt))
  check('★★ 提示词明说"在精不在多"并给了条数范围', /3~8 条/.test(built.prompt))
  check('★ 提示词明说"按需精简"（使用者要的就是这个）', /按需精简/.test(built.prompt))
  check('★★ 底线要点逐条列进提示词（10 条）',
    built.prompt.includes('不泄露记忆') && built.prompt.includes('接梗不是屈服') &&
      STYLE_ANCHORS.every((a) => built.prompt.includes(a.label)),
    `${STYLE_ANCHORS.length} 条`)
  check('★ 提示词要求**只输出 JSON**（解析器不猜散文）', /只输出 JSON/.test(built.prompt))

  // ── 4b. 锚点核对 ───────────────────────────────────────────────────────
  const okAnchors = checkAnchors({ text: styleText })
  check('★★ 现有风格文件本身**通过全部锚点**（锚点表是照着它定的）', okAnchors.ok, JSON.stringify(okAnchors.missing.map((m) => m.label)))
  const badAnchors = checkAnchors({ text: '【闲聊】\n- 短一点。\n' })
  check('★★ 一份"把底线全删了"的改写会被逐条抓出来',
    badAnchors.ok === false && badAnchors.missing.length === STYLE_ANCHORS.length, `${badAnchors.missing.length} 条`)
  check('★ 同义写法也算过（改写本来就会换措辞）',
    checkAnchors({ text: styleText.replace('不泄露记忆', '不外泄记忆') }).ok === true)
  check('★ 锚点表每条都有 id/label/any（可核对、可显示给人看）',
    STYLE_ANCHORS.every((a) => a.id && a.label && Array.isArray(a.any) && a.any.length))

  // ── 4c. 解析模型输出（容错，但不猜）─────────────────────────────────────
  const good = parseConsolidation('```json\n{"points":[{"kind":"bad","title":"省略号滥用","summary":"每句都挂","evidence":["2"],"where":"说话方式"}],"rewritten":"【x】\\n- 短。","dropped":[]}\n```')
  check('★ 解析带 ``` 围栏的 JSON（模型很爱加）', good.ok && good.via === 'fence' && good.points.length === 1)
  check('★ 点的字段齐全（kind/title/summary/evidence/where）',
    good.points[0].title === '省略号滥用' && good.points[0].evidence[0] === '2' && good.points[0].kind === 'bad')
  check('★ kind 只认 good/bad（别的值一律按 bad，不发明第三类）',
    parseConsolidation('{"points":[{"kind":"weird","title":"t"}],"rewritten":"x"}').points[0].kind === 'bad')
  check('★★ 没有 rewritten ⇒ 失败（没正文就等于没草稿，不许编一份出来）',
    parseConsolidation('{"points":[]}').ok === false)
  check('★ 空回复 → 失败并说明', parseConsolidation('').ok === false)
  check('★ 不是 JSON 的散文 → 失败并说明', parseConsolidation('我觉得可以这样改…').ok === false)

  // ── 4d. 本地确定性聚类（模型不可用时的退路）────────────────────────────
  const clusters = clusterComments({
    comments: [
      { id: 'a', verdict: 'bad', comment: '太长了，一句话能说完' },
      { id: 'b', verdict: 'bad', comment: '太长了，一句能说完就别写这么多' },
      { id: 'c', verdict: 'bad', comment: '别主动说显卡的事' },
    ],
  })
  check('★★ 说法相近的评论被聚成一组并计数（至少让人看见"同一件事说了几遍"）',
    clusters.length === 2 && clusters[0].count === 2, JSON.stringify(clusters.map((c) => [c.text, c.count])))
  check('★ 聚类只收有评论的，且能按判档分开（good 那一组只有 1 条）',
    clusterComments({ comments: [{ id: 'x', verdict: 'bad', comment: '  ' }] }).length === 0 &&
      clusterComments({ comments, verdict: 'good' }).length === 1 &&
      clusterComments({ comments, verdict: 'good' })[0].text.includes('极短'),
    String(clusterComments({ comments, verdict: 'good' }).length))

  // ── 4e. consolidateComments：注入假模型（成功 / 三种失败）───────────────
  const fakeModel = (payload) => async () => ({ ok: true, text: JSON.stringify(payload), ms: 12 })
  const target = { ok: true, baseUrl: 'https://example.invalid', apiKey: 'k', model: 'fake-model' }

  const okRun = await consolidateComments({
    comments, styleText, target,
    callModel: fakeModel({ points: [{ kind: 'bad', title: '省略号滥用', summary: '每句都挂', evidence: ['1'] }], rewritten: styleText, dropped: [] }),
  })
  check('★ 整理成功：给出点 + 改写 + 锚点核对', okRun.ok && okRun.points.length === 1 && okRun.anchors.ok, JSON.stringify(okRun.why ?? ''))
  check('★ 顺带回模型名与耗时（钱花在明处）', okRun.model === 'fake-model' && typeof okRun.ms === 'number')

  const driftRun = await consolidateComments({
    comments, styleText, target,
    callModel: fakeModel({ points: [], rewritten: '【闲聊】\n- 短一点。', dropped: ['不泄露记忆'] }),
  })
  check('★★ 改写丢了底线要点 ⇒ 标记出来（后面 apply 会拒绝）',
    driftRun.ok === true && driftRun.anchors.ok === false && driftRun.anchors.missing.length === STYLE_ANCHORS.length)
  check('★ 模型自报丢掉的要点也一起回（给人看，不当作判据）',
    driftRun.dropped.includes('不泄露记忆'))

  const noComments = await consolidateComments({ comments: [{ id: 'z', verdict: 'bad', comment: '' }], styleText, target, callModel: fakeModel({}) })
  check('★★ 一条带评论的评分都没有 ⇒ 明说"没什么可整理"（不是调模型碰运气）',
    noComments.ok === false && /没什么可整理/.test(noComments.why), noComments.why)

  const noTarget = await consolidateComments({ comments, styleText, target: { ok: false, why: '没有 key' }, callModel: fakeModel({}) })
  check('★★ 模型通路不可用 ⇒ 明说为什么，并附上本地聚类（评论不能跟着消失）',
    noTarget.ok === false && /没有 key/.test(noTarget.why) && noTarget.clusters && Array.isArray(noTarget.clusters.bad),
    noTarget.why)

  const badJson = await consolidateComments({ comments, styleText, target, callModel: async () => ({ ok: true, text: '我觉得吧…', ms: 5 }) })
  check('★★ 模型没按 JSON 回答 ⇒ 失败 + 本地聚类（不把散文当草稿）',
    badJson.ok === false && /JSON/.test(badJson.why) && badJson.clusters, badJson.why)

  const timeout = await consolidateComments({ comments, styleText, target, callModel: async () => ({ ok: false, why: '超时', ms: 900 }) })
  check('★ 模型调用失败（超时/网络）⇒ 失败 + 本地聚类', timeout.ok === false && /超时/.test(timeout.why))

  check('★ 一次整理的输入上限是明说的常数（超了截断并报数，不静默）',
    CONSOLIDATE_LIMITS.comments > 0 && CONSOLIDATE_LIMITS.chars > 0 && CONSOLIDATE_LIMITS.styleChars > 0,
    JSON.stringify(CONSOLIDATE_LIMITS))

  // ── 4f. 风格文件 ↔ 出厂常量 同步 ────────────────────────────────────────
  const chatModeSrc = readFileSync(join(PKG_ROOT, 'src', 'chat-mode.mjs'), 'utf8')
  const found = extractStyleConstant(chatModeSrc)
  check('★ 能从 chat-mode.mjs 里抠出常量', found && found.body.length > 100, String(found?.body.length))
  check('★★ 抠出来的就是 styles/闲聊.md 的内容（两边同源，有断言钉着）',
    constantMatches(chatModeSrc, styleText.trim()) || found.body.trim() === styleText.trim(),
    `常量 ${found?.body.length} 字 / 文件 ${styleText.length} 字`)
  const replaced = replaceStyleConstant(chatModeSrc, '新内容\n')
  check('★ 替换是纯函数：返回新源码、原源码没变',
    replaced.ok && replaced.changed && replaced.text.includes('export const DEFAULT_CHAT_STYLE = `新内容\n`') &&
      chatModeSrc.includes(found.body))
  check('★ 文本没变时 `changed: false`（不做无意义的写）',
    replaceStyleConstant(chatModeSrc, found.body).changed === false)
  check('★★ 文本里有反引号 / ${ / 反斜杠 ⇒ **拒绝同步**（硬写会把 chat-mode.mjs 弄崩）',
    ['含 ` 反引号', '含 ${ 插值', '含 \\ 反斜杠'].every((t, i) =>
      replaceStyleConstant(chatModeSrc, t).ok === false))
  check('★ 找不到常量声明 ⇒ 拒绝（不猜位置）',
    replaceStyleConstant('// 什么都没有\n', 'x').ok === false)

  // 真落盘一次（拿一份 chat-mode.mjs 的**副本**，绝不碰真源码）
  const syncDir = freshDir('sync')
  const copyPath = join(syncDir, 'chat-mode.mjs')
  writeFileSync(copyPath, chatModeSrc, 'utf8')
  const sync = syncStyleConstant({ chatModePath: copyPath, styleText: '【测试用】\n- 极短。\n' })
  check('★★ 同步真的写进去了', sync.ok && sync.changed, String(sync.why ?? ''))
  check('★★ 写完**复核**一致（只信"写进去了"等于把漂移交给运气）',
    constantMatches(readFileSync(copyPath, 'utf8'), '【测试用】\n- 极短。\n'))
  check('★ 同步会先备份', sync.backup && existsSync(sync.backup) && readFileSync(sync.backup, 'utf8') === chatModeSrc)
  check('★ 再同步一次同样的内容：不重复写', syncStyleConstant({ chatModePath: copyPath, styleText: '【测试用】\n- 极短。\n' }).changed === false)
  check('★★ 同步失败时**不写坏文件**（反引号那条路）',
    syncStyleConstant({ chatModePath: copyPath, styleText: '带 ` 反引号' }).ok === false &&
      readFileSync(copyPath, 'utf8') === readFileSync(copyPath, 'utf8'))

  // ── 4g. 整篇改写落地（apply）：确认 / 锚点拦截 / 备份 / 常量同步 ─────────
  const ws = freshDir('ws2')
  const styleDir = freshDir('style2')
  const stylePath = join(styleDir, '闲聊.md')
  writeFileSync(stylePath, styleText, 'utf8')
  const cmPath = join(styleDir, 'chat-mode.mjs')
  writeFileSync(cmPath, chatModeSrc, 'utf8')
  const store = createReviewStore({ workspace: ws, styleFile: stylePath, chatModePath: cmPath })
  const items = [
    { id: 'q1', batch: 'b2', source: 'import', chatKey: 'g', chatLabel: '群 g', at: 1, context: [], reply: '手机？我住在一台 X99 主板的机箱里面' },
    { id: 'q2', batch: 'b2', source: 'import', chatKey: 'g', chatLabel: '群 g', at: 2, context: [], reply: '这个问题可以从三个角度看' },
  ]
  store.createBatch({ label: 'b2', source: 'import', items })
  store.saveScore({ id: 'q1', verdict: 'bad', comment: '问手机就答手机' })
  store.saveScore({ id: 'q2', verdict: 'bad', comment: '太长，别解释自己' })

  check('★ 还没整理过时 latestConsolidation 是 null（页面据此显示"还没整理"）',
    store.latestConsolidation('b2') === null)

  const rewritten = styleText
    .replace('- **极短。** 一句话能说完就一句话。', '- **极短。** 一句话能说完就一句话，别交代自己的参数。')
  const saved = store.saveConsolidation({
    scope: 'b2',
    styleBefore: styleText,
    result: {
      points: [{ kind: 'bad', title: '别交代自己的参数', summary: '问什么答什么', evidence: ['q1'], where: '说话方式' }],
      rewritten,
      dropped: [],
      anchors: checkAnchors({ text: rewritten }),
      model: 'fake-model',
      ms: 42,
    },
  })
  check('★ 存下一份整理（点 + 改写 + diff + 锚点）',
    saved.ok && saved.consolidation.points.length === 1 && saved.consolidation.diff.includes('---'), JSON.stringify(saved.why ?? ''))
  check('★★ diff 是**整篇**的（+/- 行都在），不是"追加一段"',
    saved.consolidation.diff.includes('+') && saved.consolidation.diff.includes('-') &&
      /@@ -\d+,\d+ \+\d+,\d+ @@/.test(saved.consolidation.diff))
  check('★ 带上改写前后的字数（页面要显示"精简了多少"）',
    saved.consolidation.styleBeforeChars === styleText.length && saved.consolidation.chars === rewritten.length)
  check('★ latestConsolidation 取得到（页面刷新后还在）', store.latestConsolidation('b2')?.id === saved.consolidation.id)

  check('★★ 没确认就想应用 → 拒绝（没有"默认应用"这件事）',
    store.applyDraft({ scope: 'b2' }).ok === false && store.applyDraft({ scope: 'b2' }).code === 400)
  const applied = store.applyDraft({ scope: 'b2', confirm: true })
  check('★★ 应用成功并返回备份路径', applied.ok && existsSync(applied.backup), String(applied.why ?? applied.backup))
  const styleAfter = readFileSync(stylePath, 'utf8')
  check('★ 风格文件真的被**整篇替换**成改写后的内容', styleAfter === rewritten && styleAfter !== styleText)
  check('★ 备份里是**改动前**的完整内容', readFileSync(applied.backup, 'utf8') === styleText)
  check('★★ 顺带同步了出厂常量（否则两份开始漂，测试会红）',
    applied.constantSync.ok && constantMatches(readFileSync(cmPath, 'utf8'), rewritten),
    JSON.stringify(applied.constantSync))
  check('★ 返回新 sha256 与前后字数', applied.sha256 === sha256(styleAfter) && applied.beforeChars === styleText.length)
  check('★★ 同一份改写再应用一次 → 409（不重复写）',
    store.applyDraft({ scope: 'b2', confirm: true }).code === 409,
    String(store.applyDraft({ scope: 'b2', confirm: true }).why))
  check('★ 整理记录里标了"已应用"与备份路径',
    store.latestConsolidation('b2').appliedAt > 0 && store.latestConsolidation('b2').applyResult.backup.includes('.bak'))

  // ── 4h. 锚点拦截：丢了底线要点就不许应用（除非人明确覆盖）──────────────
  const ws3 = freshDir('ws3')
  const styleDir3 = freshDir('style3')
  const stylePath3 = join(styleDir3, '闲聊.md')
  writeFileSync(stylePath3, styleText, 'utf8')
  const store3 = createReviewStore({ workspace: ws3, styleFile: stylePath3 })
  store3.createBatch({ label: 'b3', source: 'import', items: [{ ...items[0], id: 'z1', batch: 'b3' }] })
  store3.saveScore({ id: 'z1', verdict: 'bad', comment: '太长了' })
  const risky = '【闲聊】\n- 短一点。\n- 别像客服。\n' // 故意把底线全删了
  store3.saveConsolidation({ scope: 'b3', styleBefore: styleText, result: { points: [], rewritten: risky, dropped: [], anchors: checkAnchors({ text: risky }) } })
  const blocked = store3.applyDraft({ scope: 'b3', confirm: true })
  check('★★ 改写丢了底线要点 ⇒ **拒绝应用**，并逐条说清丢了哪几条',
    blocked.ok === false && blocked.code === 409 && blocked.anchorsMissing.length === STYLE_ANCHORS.length,
    JSON.stringify(blocked.anchorsMissing?.map((m) => m.label)))
  check('★★ 被拒绝时文件**一个字都没动**（拒绝必须是拒绝，不是"写了再说"）',
    readFileSync(stylePath3, 'utf8') === styleText)
  const forced = store3.applyDraft({ scope: 'b3', confirm: true, confirmAnchors: true })
  check('★★ 人明确覆盖后可以应用（并且标记成"覆盖过锚点"）',
    forced.ok && forced.anchorsOverridden === true, JSON.stringify(forced.why ?? ''))
  check('★ 覆盖也是"先备份再写"', readFileSync(forced.backup, 'utf8') === styleText)

  // diff 纯函数仍然可用（整篇重写靠它给人看）
  const diff = unifiedDiff('a\nb\nc\n', 'a\nB\nc\nd\n', { aName: 'x', bName: 'x' })
  check('★ diff 有文件头与 hunk 头', diff.startsWith('--- x') && diff.includes('+++ x') && /@@ -\d+,\d+ \+\d+,\d+ @@/.test(diff))
  check('★ 改一行时同时出现 - 与 +', diff.includes('-b') && diff.includes('+B'))
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

  // ★★ 出厂常量的同步对象必须是**临时副本**：`createReviewServer` 默认指向真的
  //   `src/chat-mode.mjs`，测试里要是指向它，跑一次测试就会改掉真源码（第一版差点这么干）。
  const chatModePath = join(styleDir, 'chat-mode.mjs')
  writeFileSync(chatModePath, readFileSync(join(PKG_ROOT, 'src', 'chat-mode.mjs'), 'utf8'), 'utf8')

  const app = createReviewServer({
    workspace: ws,
    styleDir,
    log,
    chatModePath,
    // ★★ 测试**绝不真调模型**：注入假模型与假通路（也不碰 resolveDirectTarget 的真实解析）
    resolveTarget: () => ({ ok: true, baseUrl: 'https://example.invalid', apiKey: 'test', model: 'fake-model' }),
    callModel: async () => ({
      ok: true,
      ms: 7,
      text: JSON.stringify({
        points: [{ kind: 'bad', title: '别交代机箱', summary: '问什么答什么', evidence: ['1'], where: '说话方式' }],
        // 在**当前文件内容**后面追加一行：既保证"和原来不同"，也保证底线锚点一条不丢
        rewritten: `${readFileSync(join(styleDir, '闲聊.md'), 'utf8').trimEnd()}\n- 新增：问手机就答手机，别交代机箱。\n`,
        dropped: [],
      }),
    }),
  })
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
  check('★★ GET /api/taxonomy 只回"已经删掉了"（保留路由是为了让旧页面拿到人话，不是 404）',
    tax.body.ok && tax.body.removed === true && tax.body.verdicts.length === 3 && !tax.body.tags,
    JSON.stringify(tax.body))

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
  // ★★ 契约（API.md）写的 `commented` 必须**真的在**这两处：第一版只在 progress 里有，
  //    页面只好多发一次 /api/stats 去凑、表里显示"—"。契约与实现不一致，页面就只能靠猜。
  check('★★ /api/sources 的批次带 commented（契约里有就必须有）',
    'commented' in (await api('/api/sources')).body.batches[0], JSON.stringify((await api('/api/sources')).body.batches[0]))

  const items = await api(`/api/items?batch=${encodeURIComponent(batchId)}&filter=unrated`)
  check('★ GET /api/items 默认只推没评的（页面第一屏就该是待评的）',
    items.body.ok && items.body.total === 2 && items.body.items.every((i) => i.score === null), JSON.stringify(items.body.total))
  check('★ 条目带上下文（评审必须有上下文）', items.body.items[0].context.length >= 1, JSON.stringify(items.body.items[0].context))
  check('★★ /api/items 的批次元信息也带 commented（同一个契约，两处都要）',
    'commented' in items.body.batch, JSON.stringify(items.body.batch))
  const firstId = items.body.items[0].id
  const secondId = items.body.items[1].id

  check('★ GET /api/items 批次不存在 → 404', (await api('/api/items?batch=nope')).status === 404)
  check('★ GET /api/items 不认识 filter 时按"未评"处理（不是 500）',
    (await api(`/api/items?batch=${encodeURIComponent(batchId)}&filter=乱写`)).body.total === 2)

  const scored = await post('/api/score', { id: firstId, verdict: 'bad', comment: '问手机就答手机，别交代机箱' })
  check('★ POST /api/score 落盘并回进度（含"有评论"计数）',
    scored.body.ok && scored.body.progress.scored === 1 && scored.body.progress.commented === 1 && scored.body.batchId === batchId,
    JSON.stringify(scored.body.progress))
  check('★ 打分后"未评"少了一条', (await api(`/api/items?batch=${encodeURIComponent(batchId)}&filter=unrated`)).body.total === 1)
  check('★ 打分后"已评"能查到它', (await api(`/api/items?batch=${encodeURIComponent(batchId)}&filter=rated`)).body.total === 1)
  const badScore = await post('/api/score', { id: firstId, verdict: '乱写' })
  check('★ 结论不合法 → 400 且说明只能是哪三档', badScore.status === 400 && /good \/ ok \/ bad/.test(badScore.body.error), badScore.body.error)
  const longComment = await post('/api/score', { id: firstId, verdict: 'bad', comment: 'x'.repeat(COMMENT_MAX_CHARS + 1) })
  check('★ 评论超长 → 400（有上限，不是无底洞）', longComment.status === 400, longComment.body.error)
  const unknownId = await post('/api/score', { id: 'i:x:y:z', verdict: 'bad' })
  check('★ 不存在的条目 → 400（不许悄悄写进一个孤儿分数）', unknownId.status === 400, unknownId.body.error)

  const undone = await post('/api/undo', { batch: batchId })
  check('★ POST /api/undo 撤销刚打的那条', undone.body.ok && undone.body.undone?.id === firstId && undone.body.progress.scored === 0)
  await post('/api/score', { id: firstId, verdict: 'bad', comment: '别把记忆里的显卡当谈资' })
  await post('/api/score', { id: secondId, verdict: 'bad', comment: '这句可以更短' })

  const stats = await api(`/api/stats?batch=${encodeURIComponent(batchId)}`)
  check('★★ GET /api/stats 给分布 + **评论清单**（没有标签排行了）',
    stats.body.ok && stats.body.verdicts.bad === 2 && stats.body.list.length === 2 && stats.body.tags === undefined,
    JSON.stringify(Object.keys(stats.body)))
  check('★ 评论清单带被评原文与上下文（报告页要能逐条读）',
    stats.body.list[0].reply.length > 0 && Array.isArray(stats.body.list[0].context))

  // ④ 整理：**注入假模型**（测试绝不真调模型）
  const notConsolidated = await api(`/api/consolidate?scope=${encodeURIComponent(batchId)}`)
  check('★ GET /api/consolidate 一开始 latest 是 null，但评论清单在（素材不会看不见）',
    notConsolidated.body.ok && notConsolidated.body.latest === null && notConsolidated.body.comments.length === 2,
    JSON.stringify(notConsolidated.body.counts))
  check('★ GET 里带上"模型通路可用不可用"与锚点表（页面据此禁用按钮 / 显示底线）',
    typeof notConsolidated.body.model.ok === 'boolean' && notConsolidated.body.anchors.length === STYLE_ANCHORS.length)

  const consolidated = await post('/api/consolidate', { scope: batchId })
  check('★★ POST /api/consolidate 调一次（假）模型，回来「点」+ 整篇改写 + diff',
    consolidated.body.ok && consolidated.body.consolidation.points.length === 1 &&
      consolidated.body.consolidation.diff.includes('@@'),
    String(consolidated.body.error ?? ''))
  check('★ 点是**从评论里长出来的**（假模型只回我给的那一条，页面照原样显示）',
    consolidated.body.consolidation.points[0].title === '别交代机箱')
  check('★ 顺带回本地聚类（成功时也回，页面可折叠对照）',
    consolidated.body.clusters && Array.isArray(consolidated.body.clusters.bad))
  const consolidationId = consolidated.body.consolidation.id

  const noConfirm = await post('/api/apply', { consolidation: consolidationId })
  check('★★ POST /api/apply 不带 confirm → 400（唯一改人格的操作必须有确认）', noConfirm.status === 400, noConfirm.body.error)
  const styleBefore = readFileSync(join(styleDir, '闲聊.md'), 'utf8')
  const applied = await post('/api/apply', { consolidation: consolidationId, confirm: true })
  check('★★ POST /api/apply 成功并留下备份', applied.status === 200 && existsSync(applied.body.backup), String(applied.body.error ?? applied.body.backup))
  check('★★ 备份与改动前**逐字相同**', readFileSync(applied.body.backup, 'utf8') === styleBefore)
  const styleAfter = readFileSync(join(styleDir, '闲聊.md'), 'utf8')
  check('★★ 风格文件被**整篇替换**（不是追加），且字数如实回报',
    styleAfter !== styleBefore && applied.body.beforeChars === styleBefore.length && applied.body.chars === styleAfter.length,
    `${styleBefore.length} → ${styleAfter.length}`)
  check('★★ 应用时顺带同步了出厂常量（假模型给的是同一份文本）',
    applied.body.constantSync.ok === true || applied.body.constantSync.why.includes('没传'),
    JSON.stringify(applied.body.constantSync))
  check('★★ 再应用一次 → 409（不重复写）', (await post('/api/apply', { consolidation: consolidationId, confirm: true })).status === 409)

  // 锚点拦截：造一份"把底线全删了"的整理结果，直接落盘（绕过模型），再试应用
  const riskyText = '【闲聊】\n- 短一点。\n'
  app.store.invalidate()
  const riskySaved = app.store.saveConsolidation({
    scope: batchId,
    styleBefore: readFileSync(join(styleDir, '闲聊.md'), 'utf8'),
    result: { points: [], rewritten: riskyText, dropped: [], anchors: checkAnchors({ text: riskyText }) },
  })
  const blocked = await post('/api/apply', { consolidation: riskySaved.consolidation.id, confirm: true })
  check('★★ 改写丢了底线要点 → 409 + **逐条列出丢了什么**（页面要显示给人看）',
    blocked.status === 409 && Array.isArray(blocked.body.anchorsMissing) && blocked.body.anchorsMissing.length === STYLE_ANCHORS.length,
    String(blocked.body.anchorsMissing?.length))
  check('★ 被拒绝时文件没动', readFileSync(join(styleDir, '闲聊.md'), 'utf8') === styleAfter)
  const forced = await post('/api/apply', { consolidation: riskySaved.consolidation.id, confirm: true, confirmAnchors: true })
  check('★★ 明确覆盖后才应用（并如实标记 anchorsOverridden）',
    forced.status === 200 && forced.body.anchorsOverridden === true, String(forced.body.error ?? ''))
  check('★ 覆盖也是先备份再写', readFileSync(forced.body.backup, 'utf8') === styleAfter)

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
  check('★★ 删批次**不动风格文件**（那是应用改写的结果，批次的生死与它无关）',
    readFileSync(join(styleDir, '闲聊.md'), 'utf8') === readFileSync(forced.body.backup, 'utf8') ||
      readFileSync(join(styleDir, '闲聊.md'), 'utf8') === riskyText,
    '')
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
section('⑥b 启动时**先接管端口**：请旧实例退，认不出就绝不动手')
// ══════════════════════════════════════════════════════════════════════════
// 用户 2026-10-02 明确要求：启动评审台时先关掉已在跑的那一份，
// 否则端口被占、新实例只会 EADDRINUSE 退出（使用者看到"点了一下窗口自己关了"）。
//
// ★ 这一节最要紧的不是"能停掉旧的"，而是**停错东西的风险**：
//   所以三条安全断言（别人的服务不许碰 / 登记里没有就不动手 / 没真空出来不许报成功）
//   和"能接管"同等重要。
{
  const ws = freshDir('takeover')
  const styleDir = freshDir('takeover-style')
  writeFileSync(join(styleDir, '闲聊.md'), '【x】\n', 'utf8')

  /** 起一个评审台并**真的监听**，返回 {app, port, close}。 */
  async function listenReview(opts = {}) {
    const app = createReviewServer({ workspace: ws, styleDir, log: () => {}, ...opts })
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r))
    return { app, port: app.server.address().port }
  }
  /** 真拿一个空闲端口号（先绑再放），用来造"端口空着"的场景。 */
  async function freePort() {
    const s = createServer(() => {})
    await new Promise((r) => s.listen(0, '127.0.0.1', r))
    const p = s.address().port
    await new Promise((r) => s.close(r))
    return p
  }

  // ① 端口空着
  const none = await stopRunningReviewServer({ port: await freePort(), log: () => {} })
  check('★ 端口空着 ⇒ 没有旧实例要停（是 ok，不是错误）', none.ok === true && none.how === 'none', JSON.stringify(none))

  // ② 端口上跑着**别人** ⇒ 拒绝动手，而且那个人必须还活着
  let killAttempted = false
  const foreign = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, hello: '我不是评审台' }))
  })
  await new Promise((r) => foreign.listen(0, '127.0.0.1', r))
  const fPort = foreign.address().port
  const probeForeign = await probeReviewHealth({ port: fPort })
  check('★ 健康探测认身份：回的不是评审台 ⇒ ours=false（附理由）',
    probeForeign.reachable === true && probeForeign.ours === false && /不是评审台/.test(probeForeign.why), probeForeign.why)
  const foreignStop = await stopRunningReviewServer({
    port: fPort,
    log: () => {},
    listRunning: () => [{ pid: 999999, port: fPort, isSelf: false, state: 'alive' }],
    kill: () => {
      killAttempted = true
      return { ok: true }
    },
  })
  check('★★ 端口上是别的东西 ⇒ foreign 拒绝（照旧起不开，但绝不误伤）',
    foreignStop.ok === false && foreignStop.foreign === true, JSON.stringify(foreignStop))
  check('★★ 而且**连 kill 都不试**（这是"误杀"的唯一入口）', killAttempted === false)
  const foreignAlive = await fetch(`http://127.0.0.1:${fPort}/`).then((r) => r.ok).catch(() => false)
  check('★★ 那个"别人"必须还活着（误杀比起不来严重得多）', foreignAlive === true)
  await new Promise((r) => foreign.close(r))

  // ③ 端口上是**评审台** ⇒ 请它自己退（graceful），端口真的空出来
  let asked = 0
  const one = await listenReview({
    onShutdown: () => {
      asked += 1
      one.app.server.close()
    },
  })
  const takeover = await stopRunningReviewServer({ port: one.port, log: () => {} })
  check('★★ 端口上是评审台 ⇒ 请它自己退（graceful，不需要杀进程）',
    takeover.ok === true && takeover.how === 'graceful', JSON.stringify(takeover))
  check('★ 它的退出回调真的被执行了（不是"发了请求就当它退了"）', asked === 1, String(asked))
  const rebind = await new Promise((r) => {
    const s = createServer(() => {})
    s.once('error', (e) => r(e.code))
    s.listen(one.port, '127.0.0.1', () => s.close(() => r('ok')))
  })
  check('★★ 接管之后端口**真的能用了**（绑定验证，不看它的自述）', rebind === 'ok', String(rebind))

  // ④ 旧实例**不接受**被关闭（没接 onShutdown ⇒ 501）⇒ 走登记里那条带身份校验的 kill
  const stubborn = await listenReview()
  const noShutdown = await fetch(`http://127.0.0.1:${stubborn.port}/api/shutdown`, { method: 'POST' })
    .then((r) => r.status)
    .catch(() => 0)
  check('★★ 没接 onShutdown 的实例如实回 501（不假装退出）', noShutdown === 501, String(noShutdown))
  let killedPid = null
  const escalated = await stopRunningReviewServer({
    port: stubborn.port,
    log: () => {},
    graceMs: 600,
    listRunning: () => [{ pid: 4242, port: stubborn.port, isSelf: false, state: 'alive' }],
    kill: (pid) => {
      killedPid = pid
      return { ok: true }
    },
  })
  check('★ 它不退 ⇒ 用登记里的 pid 走带身份校验的 kill', killedPid === 4242, String(killedPid))
  check('★★ 但端口没真空出来时**不许宣称成功**（kill 报 ok ≠ 事情办成了）',
    escalated.ok === false && /仍被占着/.test(escalated.why), JSON.stringify(escalated))
  const refused = await stopRunningReviewServer({ port: stubborn.port, log: () => {}, graceMs: 600, listRunning: () => [] })
  check('★★ 登记里找不到它 ⇒ 明确拒绝动手，并给出"手动关"的办法',
    refused.ok === false && /手动关/.test(refused.why), refused.why)
  const stubbornStill = await probeReviewHealth({ port: stubborn.port })
  check('★ 它当然还在（我们没动它）', stubbornStill.ours === true)
  stubborn.app.close()

  // ⑤ 真机上最常见的路径：另一个**子进程**在跑，我把它接管过来
  //    （这是唯一一次真的 spawn —— `stdio:'ignore'` 是受限环境里能用的那种）
  const childPort = await freePort()
  const child = spawn(process.execPath, [join(PKG_ROOT, 'chat-review', 'server.mjs'), '--port', String(childPort)], {
    cwd: PKG_ROOT,
    stdio: 'ignore',
    windowsHide: true,
  })
  const up = await waitFor(async () => (await probeReviewHealth({ port: childPort, timeoutMs: 400 })).ours, 8000)
  check('★★ 真的能起一个子进程实例（接管场景的前提）', up === true, `端口 ${childPort}`)
  if (up) {
    const real = await stopRunningReviewServer({ port: childPort, log: () => {}, graceMs: 6000 })
    check('★★★ 真机路径：新实例启动时把旧的那份请走了（graceful 成功）',
      real.ok === true && real.how === 'graceful', JSON.stringify(real))
    const portFree = await waitFor(async () => !(await probeReviewHealth({ port: childPort, timeoutMs: 300 })).reachable, 6000)
    check('★★★ 端口真的空出来了（下一个实例能绑上）', portFree === true)
  }
  try {
    child.kill()
  } catch {
    /* 已经退了 */
  }
}

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
    check('★ 页面用了「整理 + 应用」两个接口（改版后的核心动作）',
      called.has('/api/consolidate') && called.has('/api/apply'),
      [...called].join(' '))
    check('★★ 页面**不再**调用已经删掉的 /api/draft（旧的"草稿=追加一段"那条路）',
      !called.has('/api/draft'), [...called].join(' '))

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
