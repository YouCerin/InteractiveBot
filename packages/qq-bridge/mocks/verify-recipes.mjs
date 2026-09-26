/**
 * 配方库测试：沉淀"怎么做"、同类任务套用。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套盯的是三件容易做错、而且做错了会**静默变坏**的事
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **① 匹配不能太严也不能太松。**
 *    第一版打分是"命中关键词数 ÷ 关键词总数，命中 <2 个再打 0.75 折"，
 *    结果「这个牌子口碑怎么样」（只命中「口碑」）得 0.15 —— **被挡在阈值外**。
 *    可那恰恰是配方最该命中的情况：人很少一次说中好几个关键词。
 *    反过来，"不命中就给 0"必须守住，否则无关闲聊也会被塞一段做法。
 *
 * **② 置信度不能是裸成功率。**
 *    只成功 1 次就记 1.0 会误导。用拉普拉斯平滑 `(ok+1)/(used+2)`：
 *    1 次成功 = 0.67，10 成 0 败 ≈ 0.92 —— 后者才配得上"可信"。
 *
 * **③ `requiredActions` 只能当提示文本，绝不能自动执行。**
 *    那等于给了一个"配方作者可以远程命令执行"的通道。这里断言渲染结果
 *    里明确写了"要你自己判断该不该做"，防止以后有人"顺手"把它接上执行。
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  slugOf,
  confidenceOf,
  termsOf,
  matchScore,
  pickRecipes,
  normalizeRecipe,
  upsertRecipe,
  readRecipe,
  listRecipes,
  recordOutcome,
  setRecipeEnabled,
  removeRecipe,
  renderRecipeBlock,
  summarizeRecipe,
  MATCH_THRESHOLD,
  INJECT_MIN_CONFIDENCE,
  CONFIDENCE_HALF_LIFE_DAYS,
  RECIPE_DIR,
} from '../src/recipes.mjs'

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

/** 一条贴近真实的配方（就是我在真实工作区里加的那条）。 */
const RECIPE = {
  title: '调研品牌可信度',
  trigger: {
    keywords: ['查品牌', '靠不靠谱', '口碑', '评价', '是不是骗子'],
    intent: '判断一个不熟悉的品牌是否可信',
  },
  steps: [
    '先搜「品牌名 + 官网」确认主体存在',
    '搜「品牌名 + 评价/投诉」找第三方',
    '读 2~3 篇第三方，避开营销稿',
  ],
  pitfalls: ['只搜品牌名会重名，搜到无关内容', '只看官网没有判断价值'],
  verify: '结论里至少引用 1 条第三方证据',
  requiredActions: ['web_search', 'web_fetch'],
}

const ROOT = mkdtempSync(join(tmpdir(), 'qq-bridge-recipes-'))

try {
  // ══════════════════════════════════════════════════════════════════════════
  section('① slug：同一件事换句话说是同一个文件')
  // ══════════════════════════════════════════════════════════════════════════
  check('中文标题可派生 slug', slugOf('调研品牌可信度') === '调研品牌可信度', slugOf('调研品牌可信度'))
  check('标点被折成下划线', slugOf('调研 品牌/可信度！') === '调研_品牌_可信度', slugOf('调研 品牌/可信度！'))
  check('空标题 → null（不该入库）', slugOf('') === null && slugOf('  ') === null)
  check('超长标题被截断', String(slugOf('甲'.repeat(60))).length === 40, String(slugOf('甲'.repeat(60))).length)

  // ══════════════════════════════════════════════════════════════════════════
  section('② 置信度：拉普拉斯平滑 + 时间衰减')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const mk = (used, succeeded) => ({ stats: { used, succeeded, lastUsedAt: 0 } })
    check('★ 0 次使用 → 0.5（不是 0，也不是 1）',
      Math.abs(confidenceOf(mk(0, 0)) - 0.5) < 1e-9, String(confidenceOf(mk(0, 0))))
    check('★★ 只成功 1 次 ≠ 满分（裸成功率会给 1.0）',
      Math.abs(confidenceOf(mk(1, 1)) - 2 / 3) < 1e-9, confidenceOf(mk(1, 1)).toFixed(3))
    check('★★ 10 成 0 败 明显高于 1 成 0 败',
      confidenceOf(mk(10, 10)) > confidenceOf(mk(1, 1)) + 0.2,
      `${confidenceOf(mk(1, 1)).toFixed(2)} → ${confidenceOf(mk(10, 10)).toFixed(2)}`)
    check('失败多的配方置信度低', confidenceOf(mk(10, 2)) < confidenceOf(mk(10, 8)))

    // 时间衰减
    const now = new Date('2026-09-26T12:00:00Z')
    const fresh = { stats: { used: 5, succeeded: 5, lastUsedAt: now.getTime() } }
    const halfYear = {
      stats: { used: 5, succeeded: 5, lastUsedAt: now.getTime() - CONFIDENCE_HALF_LIFE_DAYS * 86400000 },
    }
    check(`★ 过一个半衰期（${CONFIDENCE_HALF_LIFE_DAYS} 天）→ 约等于腰斩`,
      Math.abs(confidenceOf(halfYear, now) / confidenceOf(fresh, now) - 0.5) < 0.02,
      `${confidenceOf(fresh, now).toFixed(3)} → ${confidenceOf(halfYear, now).toFixed(3)}`)
    check('★ 衰减**只降权不删**（配方对象本身没被改动）',
      halfYear.stats.succeeded === 5 && halfYear.stats.used === 5)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('③ 匹配打分：长尾要命中、无关要给 0')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const r = normalizeRecipe(RECIPE)
    const cases = [
      ['帮我查一下克莱德洛这个品牌靠不靠谱', true, '核心场景（命中 2 个词）'],
      ['这个牌子口碑怎么样', true, '★ 长尾：只命中「口碑」一个词'],
      ['克莱德洛 评价', true, '命中「评价」'],
      ['调查一下这个牌子是不是骗子', true, '命中「是不是骗子」'],
      ['帮我看看 memory/self-unknowns.md', false, '无关：文件操作'],
      ['今天天气不错', false, '无关：闲聊'],
      ['帮我写个贪吃蛇网页', false, '无关：另一个任务'],
      ['', false, '空文本'],
    ]
    for (const [t, want, why] of cases) {
      const s = matchScore(r, t)
      const ok = (s >= MATCH_THRESHOLD) === want
      check(`${want ? '命中' : '不命中'}：${why}`, ok, `score=${s.toFixed(2)}文本=${JSON.stringify(t)}`)
    }
    check('★ 完全无关 → 严格 0（不是"给点分"）',
      matchScore(r, '今天天气不错') === 0 && matchScore(r, '帮我写个贪吃蛇网页') === 0)
    check('没有关键词的配方 → 0（不该凭标题乱匹配）',
      matchScore({ trigger: { keywords: [] } }, '帮我查品牌') === 0)
  }

  section('④ termsOf：中文 bigram + 英文整词')
  {
    const t = termsOf('查Brand123品牌')
    check('英文/数字整词保留', t.has('brand123'), JSON.stringify([...t]))
    check('中文按 2 字滑窗', t.has('品牌'), JSON.stringify([...t].filter((x) => /[\u4e00-\u9fa5]/.test(x))))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑤ 入库：归一化、合并取并集、坏输入拒掉')
  // ══════════════════════════════════════════════════════════════════════════
  const WS = join(ROOT, 'ws')
  {
    const r = upsertRecipe({ workspace: WS, recipe: RECIPE, source: 'manual' })
    check('入库成功', r.ok === true && r.merged === false, JSON.stringify(r))
    check('文件名是 slug', r.id === '调研品牌可信度' && existsSync(join(WS, `${RECIPE_DIR}/${r.id}.json`)))
    check('落盘无 .tmp 残留', readdirSync(join(WS, RECIPE_DIR)).every((f) => !f.includes('.tmp')))

    const back = readRecipe({ workspace: WS, id: r.id })
    check('读回来字段齐全',
      back.title === RECIPE.title && back.steps.length === 3 && back.pitfalls.length === 2 &&
        back.verify === RECIPE.verify && back.source === 'manual',
      JSON.stringify({ t: back.title, s: back.steps.length }))

    section('⑥ 同 slug 再次入库 → **合并取并集**（不覆盖已验证的做法）')
    const r2 = upsertRecipe({
      workspace: WS,
      recipe: { title: RECIPE.title, trigger: { keywords: ['新品调研'] }, steps: ['先看有没有召回公告'] },
      source: 'auto',
    })
    check('识别为合并', r2.merged === true)
    const m = readRecipe({ workspace: WS, id: r2.id })
    check('★ 关键词取并集（旧的没被覆盖）',
      m.trigger.keywords.includes('口碑') && m.trigger.keywords.includes('新品调研'),
      JSON.stringify(m.trigger.keywords))
    check('★ 步骤取并集', m.steps.length === 4 && m.steps.includes('先看有没有召回公告'), String(m.steps.length))
    check('★ `stats` 被保留（积累的计数不能被一次重写清掉）', m.stats.used === 0)

    section('⑦ 坏输入：拒绝而不是写半个进去')
    check('无标题 → 拒', upsertRecipe({ workspace: WS, recipe: { steps: ['x'] } }).ok === false)
    check('既无步骤又无关键词 → 拒（空壳）',
      upsertRecipe({ workspace: WS, recipe: { title: '空壳' } }).ok === false)
    check('缺 workspace → 拒', upsertRecipe({ recipe: RECIPE }).ok === false)
    check('超长字段被截断而不是照存',
      (() => {
        const rr = upsertRecipe({
          workspace: WS,
          recipe: { title: '截断测试', trigger: { keywords: Array.from({ length: 30 }, (_, i) => `kw${i}`) }, steps: Array.from({ length: 20 }, (_, i) => `步${i}`) },
        })
        const got = readRecipe({ workspace: WS, id: rr.id })
        return got.trigger.keywords.length <= 12 && got.steps.length <= 6
      })())
    check('normalizeRecipe 对 null 返回 null', normalizeRecipe(null) === null)
    // ★ 关键词长度上限：真机抽取产出的关键词是**一整句用户说法**，
    //   16 字会把中文整句从中间截断（实测三条里截断两条，而且是静默的）。
    //   这里固化"自然长度的中文说法要完整保留"，同时确认上限仍在（防巨型条目）。
    check('★★ 自然长度的中文关键词**不被截断**（真机：16 字上限截掉了尾巴）',
      (() => {
        const phrase = '帮我查一下XX最近有什么新品或者新动态'
        const rr = upsertRecipe({ workspace: WS, recipe: { title: '关键词长度测试', trigger: { keywords: [phrase] }, steps: ['随便一步'] } })
        const got = readRecipe({ workspace: WS, id: rr.id })
        return got.trigger.keywords[0] === phrase
      })(),
      '若失败说明关键词上限又调回短值了')
    check('★ 但仍然有上限（超长关键词会被截到 30 字以内）',
      (() => {
        const long = '一'.repeat(80)
        const rr = upsertRecipe({ workspace: WS, recipe: { title: '超长关键词', trigger: { keywords: [long] }, steps: ['一步'] } })
        const got = readRecipe({ workspace: WS, id: rr.id })
        return got.trigger.keywords[0].length <= 30
      })())
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑧ 挑选与注入：阈值、条数上限、低置信提醒')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const all = listRecipes({ workspace: WS })
    const picked = pickRecipes(all, '帮我查一下这个品牌靠不靠谱')
    check('选出 1 条', picked.length === 1, String(picked.length))
    check('带 score 与 confidence（可解释）',
      typeof picked[0].score === 'number' && typeof picked[0].confidence === 'number',
      JSON.stringify({ s: picked[0].score.toFixed(2), c: picked[0].confidence.toFixed(2) }))

    const block = renderRecipeBlock(picked)
    check('渲染出做法段', block.includes('调研品牌可信度') && block.includes('先搜'))
    check('带"坑"', block.includes('坑：') && block.includes('重名'))
    check('带验收', block.includes('验收：'))
    // ⚠️ "用过 N 次"那行**只在真的用过时**才打印（`used > 0`）——
    //    0 次使用不值得占一行 token。第一版断言无条件找这行，是测试写错了。
    check('★ 从未用过时**不**打印统计行（省 token）',
      !block.includes('用过 0 次'), block.split('\n').find((l) => l.includes('用过')) ?? '(无，正确)')
    check('★ 用过之后才打印统计行（可判断值不值得信）', (() => {
      const withUse = renderRecipeBlock([{
        recipe: { ...picked[0].recipe, stats: { used: 3, succeeded: 2, failed: 1 } },
        score: 0.9,
        confidence: 0.7,
      }])
      return withUse.includes('用过 3 次') && withUse.includes('成功 2 次')
    })())
    check('★★ 说清这是经验、**不是命令**（否则模型会当权威照做）',
      block.includes('不是命令') && block.includes('不符就别照搬'), block.split('\n').slice(-1)[0])

    section('⑨ ★★ requiredActions 只能当提示，不能自动执行')
    check('★ 渲染里明确写了"要你自己判断该不该做"',
      block.includes('要你自己判断该不该做'), block.split('\n').find((l) => l.includes('通常需要')) ?? '(缺)')
    check('★ 只以文本形式出现（没有被当成工具调用）',
      /通常需要：.*web_search/.test(block))

    section('⑩ 低置信度要**显式提醒**，不是悄悄降权')
    const low = renderRecipeBlock([{ recipe: { ...picked[0].recipe, title: '过时做法' }, score: 0.9, confidence: 0.1 }])
    check('★★ 置信 < 0.3 时提醒"可能过时、先验证"',
      low.includes('过时') && low.includes('先验证'), low.split('\n')[1])

    section('⑪ 空输入与上限')
    check('空数组 → 空串（省 token）', renderRecipeBlock([]) === '' && renderRecipeBlock(null) === '')
    check('过滤掉没有 recipe 的项', renderRecipeBlock([{ score: 1 }]) === '')
    check(`最多注入 ${2} 条`, (() => {
      const many = Array.from({ length: 5 }, (_, i) => ({
        ...normalizeRecipe({ ...RECIPE, title: `配方${i}` }),
        confidence: 0.9,
      }))
      return pickRecipes(many, '帮我查一下这个品牌靠不靠谱').length <= 2
    })())
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑫ 使用反馈：计数累加、置信度随之变化')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const before = confidenceOf(readRecipe({ workspace: WS, id: '调研品牌可信度' }))
    const r1 = recordOutcome({ workspace: WS, id: '调研品牌可信度', outcome: 'ok' })
    check('记成功', r1.ok === true && r1.recipe.stats.used === 1 && r1.recipe.stats.succeeded === 1,
      JSON.stringify(r1.recipe?.stats))
    recordOutcome({ workspace: WS, id: '调研品牌可信度', outcome: 'ok' })
    recordOutcome({ workspace: WS, id: '调研品牌可信度', outcome: 'ok' })
    const after = readRecipe({ workspace: WS, id: '调研品牌可信度' })
    check('三次成功后 used/succeeded 都对', after.stats.used === 3 && after.stats.succeeded === 3,
      JSON.stringify(after.stats))
    check('★ 置信度上升（0.5 → 接近 0.8）',
      confidenceOf(after) > before + 0.2, `${before.toFixed(2)} → ${confidenceOf(after).toFixed(2)}`)
    check('记 lastOutcome', after.stats.lastOutcome === 'ok')

    recordOutcome({ workspace: WS, id: '调研品牌可信度', outcome: 'failed' })
    const afterFail = readRecipe({ workspace: WS, id: '调研品牌可信度' })
    check('失败也计数（不隐瞒）', afterFail.stats.failed === 1 && afterFail.stats.lastOutcome === 'failed')
    check('不存在的配方 → 明确失败', recordOutcome({ workspace: WS, id: '没有这条', outcome: 'ok' }).ok === false)
  }

  section('⑬ 启停与删除')
  {
    check('停用', setRecipeEnabled({ workspace: WS, id: '调研品牌可信度', enabled: false }).ok === true)
    const off = readRecipe({ workspace: WS, id: '调研品牌可信度' })
    check('落盘为 enabled:false', off.enabled === false)
    check('★★ 停用后**不再被挑选**（这是"随时开关"的落点）',
      pickRecipes(listRecipes({ workspace: WS }), '帮我查一下这个品牌靠不靠谱').length === 0)
    check('但**仍在列表里**（可检索、可再启用）', listRecipes({ workspace: WS }).length >= 1)
    check('摘要里标出"已停用"', summarizeRecipe({ ...off, confidence: 0.8 }).includes('已停用'))

    setRecipeEnabled({ workspace: WS, id: '调研品牌可信度', enabled: true })
    check('再启用后又能被挑选',
      pickRecipes(listRecipes({ workspace: WS }), '帮我查一下这个品牌靠不靠谱').length === 1)

    check('删除', removeRecipe({ workspace: WS, id: '调研品牌可信度' }) === true)
    check('再删返回 false（不抛）', removeRecipe({ workspace: WS, id: '调研品牌可信度' }) === false)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑭ 容错：坏文件、坏目录都不抛')
  // ══════════════════════════════════════════════════════════════════════════
  {
    mkdirSync(join(WS, RECIPE_DIR), { recursive: true })
    writeFileSync(join(WS, RECIPE_DIR, 'broken.json'), '{ 这不是 JSON', 'utf8')
    let threw = false
    try {
      listRecipes({ workspace: WS })
      readRecipe({ workspace: WS, id: 'broken' })
      listRecipes({ workspace: join(ROOT, 'nope') })
      readRecipe({ workspace: '', id: 'x' })
      confidenceOf(null)
      matchScore(null, 'x')
      renderRecipeBlock(undefined)
      summarizeRecipe({ title: 'x' })
    } catch {
      threw = true
    }
    check('★ 坏 JSON / 缺目录 / 空参都不抛异常', threw === false)
    check('坏文件被跳过（其余仍能列出）', Array.isArray(listRecipes({ workspace: WS })))
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('')
if (failed === 0) {
  console.log(`🎉 配方库测试全部通过（${passed} 项）`)
  process.exit(0)
} else {
  console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
  process.exit(1)
}
