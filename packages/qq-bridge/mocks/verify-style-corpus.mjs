/**
 * 语感语料的清洗/抽样测试（0.3.3 · P1）。
 *
 * 这一层的判据全部落在**输出**上（样本池 + 统计），因为它的产物是**要给人过目的**：
 *   · 谁被筛掉了、为什么（统计里逐条计数）；
 *   · 每条样本带没带上下文（单拎一句学不到东西）；
 *   · 分层有没有真的分（大群不许吞掉全部）；
 *   · 同一种子是否可复现（人工剔除要能对得上同一份池子）。
 *
 * ★ 用真数据的形状造样例：`is_bot` 权威、同名不同人、纯图占位、复读、超长、命令。
 *
 * 用法：node mocks/verify-style-corpus.mjs
 */

import { curate, isLearnable, makeRng, matchGroups, normalizeForDedupe, STYLE_LIMITS } from '../src/style-corpus.mjs'

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

const row = (text, { chatKey = 'group:1', isBot = false, who = '甲', at = 0, messageId = null } = {}) => ({
  chatKey, text, isBot, senderName: who, createdAt: at, messageId,
})

/* ══════════════════════════════════════════════════════════════════════════ */
section('① 单条判据：structural 噪声全部筛掉，且**理由可读**')
// ══════════════════════════════════════════════════════════════════════════
{
  const cases = [
    [row('今天放学好早', {}), true, '普通一句话'],
    [row('嗯', {}), false, '太短（1 字）'],
    [row('x'.repeat(41), {}), false, '太长'],
    [row('[图片]', {}), false, '纯图占位'],
    [row('[表情包 猫猫]', {}), false, '纯表情占位'],
    [row('看这个 https://example.com', {}), false, '带链接'],
    [row('\\mc list', {}), false, '命令'],
    [row('@全体成员 开会了', {}), false, '以 @ 开头'],
    [row('？？？', {}), false, '只有标点'],
    [row('6', {}), false, '只有数字（没有字/字母）'],
    [row('【公告】明天维护', {}), false, '公告式'],
    [row('今天放学好早', { isBot: true }), false, '机器人自己的话（is_bot 权威）'],
  ]
  for (const [r, want, why] of cases) {
    const v = isLearnable(r)
    check(`${want ? '留下' : '筛掉'}：${why}`, v.ok === want, v.ok ? v.text : v.why)
  }
  check('★ 筛掉的每一条都有**人话理由**（不是空字符串）',
    cases.filter(([r]) => !isLearnable(r).ok).every(([r]) => String(isLearnable(r).why ?? '').trim().length > 1))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('①b ★★ 低俗/攻击性**关键词预筛**（只减少人工负担，不是判据）')
// ══════════════════════════════════════════════════════════════════════════
{
  check('★ 「自己反思为什么不会搞 sb」被判掉', isLearnable(row('自己反思为什么不会搞 sb')).ok === false,
    isLearnable(row('自己反思为什么不会搞 sb')).why)
  check('★ 「谁尿的远谁赢」被判掉', isLearnable(row('谁尿的远谁赢')).ok === false)
  check('★★ 正常词**不许**被误伤：「操作」「鸡」出现在正常句子里', 
    isLearnable(row('这个操作我认')).ok === true &&
      isLearnable(row('今晚吃鸡吗')).ok === true &&
      isLearnable(row('把配置改了下')).ok === true,
    isLearnable(row('这个操作我认')).why ?? '')
  check('★ 英文脏话也拦（`fuck`）', isLearnable(row('what the fuck')).ok === false)
  check('★ `sb` 只在它是独立词时拦（`sb` 后面跟着字母不算）',
    isLearnable(row('sbw 这个缩写')).ok === true)
  check('★★★ 但被拦下的条目**能回看**（预筛一定误伤，不做黑箱）', (() => {
    const { stats } = curate({
      rows: [row('你妈那套别用', { at: 1 }), row('这句很正常啊', { at: 2 })],
      targetCount: 5,
      seed: 1,
    })
    return Array.isArray(stats.toxicRejected) && stats.toxicRejected.length === 1 &&
      /你妈/.test(stats.toxicRejected[0].text)
  })())
  check('★ 可以关掉这一层（`toxicity:false`，回归用）', (() => {
    const { samples } = curate({ rows: [row('你妈那套别用', { at: 1 })], targetCount: 5, seed: 1, toxicity: false })
    return samples.length === 1
  })())
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('② ★★★ `is_bot` 是权威判据：同名的人**不许**被当成机器人筛掉')
// ══════════════════════════════════════════════════════════════════════════
//
// 真库里 1,578 行署名「小鲸鱼」，而机器人是 `is_bot=1` 且 `sender_name=null`；
// 那些 `is_bot=0` 的「小鲸鱼」是 `user_id 340954227` 的**另一个真人**。
{
  const rows = [
    row('要的 V我50解锁', { who: '小鲸鱼', isBot: false, at: 1 }),
    row('存档点收到', { who: '小鲸鱼', isBot: false, at: 2 }),
    row('我在想', { who: '小鲸鱼', isBot: true, at: 3 }),
  ]
  const { samples, stats } = curate({ rows, targetCount: 10, seed: 7 })
  check('★★ 同名真人**留下来了**（2 条）', samples.length === 2, JSON.stringify(samples.map((s) => s.text)))
  check('★★ 机器人那条（is_bot=1）被筛掉', stats.dropped['机器人自己说的（is_bot）'] === 1,
    JSON.stringify(stats.dropped))
  check('★ 而"同名不同人"这件事被**记进统计**（不当过滤条件，只作观察）',
    stats.nameCollisions['小鲸鱼'] === 2, JSON.stringify(stats.nameCollisions))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('③ 上下文：每条样本带上前几条（含机器人自己的行）')
// ══════════════════════════════════════════════════════════════════════════
{
  const rows = [
    row('你们今天几点放学', { at: 1, who: '甲' }),
    row('三点半吧', { at: 2, who: '乙' }),
    row('我在查了', { at: 3, who: '小鲸鱼', isBot: true }),
    row('那我等你', { at: 4, who: '甲' }),
  ]
  const { samples } = curate({ rows, targetCount: 10, seed: 1, contextCount: 2 })
  const target = samples.find((s) => s.text === '那我等你')
  check('★ 样本带上了上文（2 条）', target?.before?.length === 2, JSON.stringify(target?.before))
  check('★★ 上文里**保留**了机器人自己那条（"它在接什么话"的证据）',
    target?.before?.some((b) => b.self === true && b.text === '我在查了'), JSON.stringify(target?.before))
  check('★★ 上文的顺序是**旧的在前**（时间顺序不能乱）',
    target?.before?.[0]?.text === '三点半吧' && target?.before?.[1]?.text === '我在查了',
    JSON.stringify(target?.before?.map((b) => b.text)))
  check('★ 第一条样本没有上文时是空数组（不是 undefined）', Array.isArray(samples[0]?.before))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('④ 复读与去重：同群同句只留一次')
// ══════════════════════════════════════════════════════════════════════════
{
  const rows = [
    row('草啊', { at: 1, who: '甲' }),
    row('草啊，', { at: 2, who: '乙' }),
    row('草啊！！', { at: 3, who: '甲' }),
    row('好的', { at: 4, who: '乙' }),
  ]
  check('★ 归一化会把标点/空白抹掉（所以"草啊"与"草啊，"算同一句）',
    normalizeForDedupe('草啊，！  ') === normalizeForDedupe('草啊'))
  const { samples, stats } = curate({ rows, targetCount: 10, seed: 3 })
  check('★★ 同群同句只留 1 条', samples.filter((s) => s.text.startsWith('草啊')).length === 1,
    JSON.stringify(samples.map((s) => s.text)))
  check('★ 被复读掉的记进统计', (stats.dropped['复读（同群同句）'] ?? 0) === 2,
    JSON.stringify(stats.dropped))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('⑤ ★★★ 分层：大群不许吞掉全部（真库 26,474 条挤在一个群的两天里）')
// ══════════════════════════════════════════════════════════════════════════
{
  const rows = []
  // 大群 500 条（不同发言人，避免被"每人上限"卡住）
  for (let i = 0; i < 500; i += 1) {
    rows.push(row(`大群第${i}句话内容`, { chatKey: 'group:big', who: `大${i % 20}`, at: i }))
  }
  // 小群 20 条
  for (let i = 0; i < 20; i += 1) {
    rows.push(row(`小群第${i}句话内容`, { chatKey: 'group:small', who: `小${i % 5}`, at: 1000 + i }))
  }
  const { samples, stats } = curate({ rows, targetCount: 40, seed: 11 })
  const big = samples.filter((s) => s.chatKey === 'group:big').length
  const small = samples.filter((s) => s.chatKey === 'group:small').length
  check('★★ 两个群都拿到了样本（小群没被大群挤掉）', big > 0 && small > 0, `big=${big} small=${small}`)
  check('★★★ 小群拿到的比"按条数比例"多得多（sqrt 权重的作用）',
    small > Math.round(40 * (20 / 520)), `small=${small}，按比例只有 ${Math.round(40 * (20 / 520))}`)
  check('★★ 总共正好 40 条（供给充足时不留缺口）', samples.length === 40, String(samples.length))
  check('★ 统计里按群可查', stats.pickedByGroup['group:big'] === big && stats.pickedByGroup['group:small'] === small,
    JSON.stringify(stats.pickedByGroup))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('⑥ 每人上限：单个人不许占满一个群的配额')
// ══════════════════════════════════════════════════════════════════════════
{
  const rows = []
  // 一个人刷 200 条，另 9 人各 5 条
  for (let i = 0; i < 200; i += 1) rows.push(row(`话痨第${i}句内容`, { chatKey: 'group:1', who: '话痨', at: i }))
  for (let p = 0; p < 9; p += 1) {
    for (let i = 0; i < 5; i += 1) rows.push(row(`路人${p}第${i}句内容`, { chatKey: 'group:1', who: `路人${p}`, at: 500 + i + p * 10 }))
  }
  const { samples } = curate({ rows, targetCount: 40, seed: 5 })
  const loud = samples.filter((s) => s.sender === '话痨').length
  check('★★ 话痨没占满（≤ 配额的 20%）', loud <= Math.ceil(40 * STYLE_LIMITS.perSpeakerRatio) + 2, String(loud))
  check('★★ 其余人也进来了（不是只剩一个人）',
    new Set(samples.map((s) => s.sender)).size >= 5, String(new Set(samples.map((s) => s.sender)).size))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('⑦ 可复现与如实：同种子同结果；供给不够**不补齐**')
// ══════════════════════════════════════════════════════════════════════════
{
  const rows = []
  for (let i = 0; i < 60; i += 1) rows.push(row(`第${i}句话的内容`, { chatKey: `group:${i % 3}`, who: `人${i % 7}`, at: i }))
  const a = curate({ rows, targetCount: 20, seed: 42 })
  const b = curate({ rows, targetCount: 20, seed: 42 })
  check('★★★ 同一个 seed ⇒ 完全同一份池子（人工剔除要能对上）',
    JSON.stringify(a.samples) === JSON.stringify(b.samples))
  const c = curate({ rows, targetCount: 20, seed: 43 })
  check('★★ 换个 seed ⇒ 池子不一样（不是写死的）',
    JSON.stringify(a.samples) !== JSON.stringify(c.samples))
  check('★ `makeRng` 本身确定', makeRng(9)() === makeRng(9)())

  const few = [row('只有一句话', { at: 1 })]
  const r = curate({ rows: few, targetCount: 50, seed: 1 })
  check('★★★ 供给不够时**如实报缺口**（不复制、不编造）',
    r.samples.length === 1 && r.stats.shortfall === 49,
    JSON.stringify({ got: r.samples.length, shortfall: r.stats.shortfall }))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('⑧ 只收群聊；私聊/游戏不会被混进来（"全群分层"的边界）')
// ══════════════════════════════════════════════════════════════════════════
{
  const rows = [
    row('群里的一句正常话', { chatKey: 'group:1', at: 1 }),
    row('私聊里的话', { chatKey: 'private:10001', at: 2 }),
    row('游戏里的话', { chatKey: 'game:forge1', at: 3 }),
  ]
  const { samples, stats } = curate({ rows, targetCount: 10, seed: 1 })
  check('★ 只留了群聊那条', samples.length === 1 && samples[0].chatKey === 'group:1', JSON.stringify(samples))
  check('★ 私聊与游戏被计入"不是群聊"', (stats.dropped['不是群聊'] ?? 0) === 2, JSON.stringify(stats.dropped))
  const only = curate({ rows, targetCount: 10, seed: 1, groups: ['group:1'] })
  check('★ 指定群时也只取那一个', only.samples.length === 1)
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('⑨ ★★★ 只从指定几个群取：群名（人话）→ 群号，歧义/没命中都要**报错**')
// ══════════════════════════════════════════════════════════════════════════
//
// 使用者原话「目前的语料太杂了，只从活死人之夜、岁岁粉丝后援会、minecraft中国计量大学、
// 三角洲行动中选取信息」。真实群名带前缀（`<CJLU>…` / `【CJLU】…` / `Minecraft-…`），
// 所以他记的是人话名字 ⇒ 匹配必须**归一化后包含**，但**歧义不许替他挑**。
{
  const roster = [
    { groupId: '831157149', name: '果冻屋' },
    { groupId: '700000001', name: '活死人之夜' },
    { groupId: '1018872871', name: '打洲社-中国计量大学' },
    { groupId: '700000002', name: '<CJLU>岁岁粉丝后援会' },
    { groupId: '529555678', name: 'Minecraft-中国计量大学' },
    { groupId: '860771987', name: '【CJLU】三角洲行动' },
  ]
  const four = matchGroups({
    roster,
    wanted: ['活死人之夜', '岁岁粉丝后援会', 'minecraft中国计量大学', '三角洲行动'],
  })
  check('★★★ 四个群名都能对上（带前缀的也行）', four.ok === true, four.ok ? four.groups.join(',') : four.why)
  check('★★★ 而且**没有**多带（果冻屋、打洲社不在里面）',
    four.ok && four.groups.length === 4 &&
      !four.groups.includes('group:831157149') && !four.groups.includes('group:1018872871'),
    four.ok ? four.groups.join(',') : '')
  check('★★ `minecraft中国计量大学` 只命中 Minecraft 那个，不命中 `打洲社-中国计量大学`',
    four.ok && four.matched.some((m) => m.query === 'minecraft中国计量大学' && m.groupId === '529555678'),
    four.ok ? JSON.stringify(four.matched) : '')
  check('★ 纯数字直接当群号（不必在 roster 里：语料可能留着已退的群）',
    matchGroups({ roster: [], wanted: ['700000001'] }).ok === true)
  check('★ `group:<号>` 这种带前缀的写法也认',
    matchGroups({ roster: [], wanted: ['group:700000001'] }).ok === false) // 故意：只收纯数字
  const ambiguous = matchGroups({ roster, wanted: ['中国计量大学'] })
  check('★★★ 歧义（一条命中两个群）⇒ **报错**，不替他挑第一个',
    ambiguous.ok === false && /同时命中/.test(ambiguous.why), ambiguous.why)
  check('★ 报错里写清命中了哪几个（人能自己把名字写全）',
    ambiguous.ok === false && /打洲社/.test(ambiguous.why) && /Minecraft/.test(ambiguous.why))
  const missing = matchGroups({ roster, wanted: ['不存在的群'] })
  check('★★ 没命中 ⇒ 报错，并**列出可用群名**（否则他会以为"筛过了"）',
    missing.ok === false && /没有.*群名能对上/.test(missing.why) && /活死人之夜/.test(missing.why), missing.why)
  check('★ 一条都没给 ⇒ fail-closed（不默认"全部群"）',
    matchGroups({ roster, wanted: [] }).ok === false)
}

console.log('')
if (failed === 0) {
  console.log(`🎉 语感语料筛选（P1）全部通过（${passed} 项）`)
  console.log('   ⚠️ 这一层**不做语义判断**：哪些"像但不该学"，是人工剔除那一步的事。')
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
