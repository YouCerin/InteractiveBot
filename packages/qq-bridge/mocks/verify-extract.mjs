/**
 * 抽取（R4b）测试：`dsh --profile headless` 通路 + **裸词 JSON 解析**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套的重心是"把不可靠的输出变成可靠对象"
 * ══════════════════════════════════════════════════════════════════════════
 * 实测：即使提示词里明写「所有键名必须用双引号」并给出带引号的示例，
 * headless **稳定输出无引号的裸词 JSON**：
 *
 *   {title:品牌口碑核查,trigger:{keywords:[帮我查一下某品牌靠不靠谱],...}}
 *
 * 强化措辞**无效**（试过）。所以整条 R4b 链路的可靠性**取决于一个自制解析器**，
 * 而写它的过程中我一连踩了三个"只做一半"的 bug：
 *   ① 只给**值**补引号，没管**键**       → `{a:1}` → `{a:"1"}` 仍非法
 *   ② 裸值扫描遇到 `[` **不停**            → `{keywords:[a,b]}` 被整体加引号
 *   ③ 只在 `:` 之后处理，漏了**数组元素**  → `[帮我查一下…,这品牌可信吗]` 没补
 *   ④ 补完 ③ 又忘了**保证 `i` 前进**       → **死循环**（探针跑到超时）
 *
 * 所以下面每一条都用**真实 headless 输出当 fixture**（`mocks/fixtures/`），
 * 不是手写的理想输入。手写的输入不会暴露这些坑。
 *
 * ⚠️ 另外固化了两个实测事实（都反直觉）：
 *   · headless 把 **reasoning 写到 stderr**，stdout 只有答案 ——
 *     早期用 `2>&1` 抓输出会把思考过程混进来
 *   · 抽取**任何一步失败都不能抛**（它是每 5 轮顺带做的增强路径）
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import {
  parseLooseJson,
  quoteBareTokens,
  extractJsonObject,
  dropPrematureRootClose,
  firstBalancedSpan,
  buildExtractPrompt,
  summarizeForPrompt,
  extractRecipe,
  runHeadless,
  DEFAULT_EVERY_N,
  MAX_OPS_FOR_PROMPT,
} from '../src/extract.mjs'
import { normalizeRecipe, upsertRecipe, listRecipes, pickRecipes } from '../src/recipes.mjs'

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

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE = readFileSync(join(PKG_ROOT, 'mocks/fixtures/headless-bare-json.txt'), 'utf8').trim()

const ROOT = mkdtempSync(join(tmpdir(), 'qq-bridge-extract-'))

try {
  // ══════════════════════════════════════════════════════════════════════════
  section('① ★★ 真实 headless 输出（裸词 JSON）必须能解析')
  // ══════════════════════════════════════════════════════════════════════════
  check('前提：这份 fixture 确实**不是**合法 JSON（否则这条测试没意义）', (() => {
    try {
      JSON.parse(FIXTURE)
      return false
    } catch {
      return true
    }
  })())
  check('fixture 的关键字面量：键无引号、值无引号',
    FIXTURE.includes('{title:') && FIXTURE.includes('keywords:['))

  const o = parseLooseJson(FIXTURE)
  check('★★ 解析成功（不是 null）', o !== null && typeof o === 'object', String(o))
  if (o) {
    check('title 取到（中文没被截断）', o.title === '品牌口碑核查', JSON.stringify(o.title))
    check('嵌套数组 keywords 有 3 项（**这是 bug ③ 的复现点**）',
      Array.isArray(o.trigger?.keywords) && o.trigger.keywords.length === 3,
      JSON.stringify(o.trigger?.keywords))
    check('数组元素内容完整（没被逗号切碎）',
      o.trigger.keywords[0] === '帮我查一下某品牌靠不靠谱', JSON.stringify(o.trigger.keywords[0]))
    check('同层的 intent 取到（没被上一条吞掉）',
      o.trigger?.intent === '判断品牌是否可信', JSON.stringify(o.trigger?.intent))
    check('steps 4 项、内容完整', o.steps?.length === 4 && o.steps[0].includes('搜品牌'), JSON.stringify(o.steps))
    check('pitfalls 4 项', o.pitfalls?.length === 4, String(o.pitfalls?.length))
    check('★ 值里含 `/` 与 `+` 也没被切坏',
      o.steps.includes('搜品牌+投诉/骗局找负面'), JSON.stringify(o.steps[1]))
  }

  section('② 解析结果的**形状**能过配方的字段校验（这是 R4b 的接线前提）')
  {
    const norm = normalizeRecipe(o, { source: 'auto' })
    check('★ normalizeRecipe 接受它（标题与步骤都有）', norm !== null, String(norm))
    if (norm) {
      check('id 由中文标题派生', norm.id === '品牌口碑核查', norm.id)
      check('关键词被保留（≤12）', norm.trigger.keywords.length === 3)
      check('步骤被保留（≤6）', norm.steps.length === 4)
      check('来源标为 auto（可与人工加的区分）', norm.source === 'auto')
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('③ 解析器：合法 JSON 一律走原生解析（不被修复器碰）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const good = '{"a":"x,y","b":[1,2],"c":{"d":"e:f"}}'
    const r = parseLooseJson(good)
    check('★ 合法 JSON 原样解析（含逗号/冒号的值没被动）',
      r?.a === 'x,y' && r?.b?.[1] === 2 && r?.c?.d === 'e:f', JSON.stringify(r))
    // ★ `quoteBareTokens` 只做"补引号"，是 `parseLooseJson` 的**内部一步**（导出是为了可调试）。
    //   对合法 JSON 它应当是**无害的**（语义不变），包括数字与布尔字面量。
    check('★ 对合法 JSON 无害：补引号后语义不变（数字/布尔保持字面量）',
      JSON.stringify(parseLooseJson(quoteBareTokens(good))) === JSON.stringify(JSON.parse(good)),
      quoteBareTokens(good))
    check('★★ 布尔/数字字面量**不加引号**（`{"skip":true}` 必须还是布尔 true）',
      quoteBareTokens('{skip:true}') === '{"skip":true}' &&
        quoteBareTokens('{n:1.5,e:null}') === '{"n":1.5,"e":null}',
      `${quoteBareTokens('{skip:true}')} / ${quoteBareTokens('{n:1.5,e:null}')}`)
  }

  section('④ 解析器：各种裸词形状')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const cases = [
      // ★ 注意：裸值 `1` 解析出来是**数字 1**（不是 "1"）。
      //   第一版无脑加引号，断言也跟着写成了 `=== '1'` —— 那是**在期待 bug 的行为**。
      //   修正为字面量保真之后，这里必须断言数字/布尔类型。
      ['{a:1,b:2}', (r) => r?.a === 1 && r?.b === 2, '裸键 + 裸值（bug ① 的复现点；数字保真）'],
      ['{skip:true}', (r) => r?.skip === true, '裸词 skip（布尔保真）'],
      ['{"skip":true}', (r) => r?.skip === true, '合法 skip'],
      ['{title:甲,steps:[一,二]}', (r) => r?.steps?.length === 2 && r.steps[0] === '一', '裸数组元素（bug ③）'],
      ['{title:甲,trigger:{keywords:[k1,k2]}}', (r) => r?.trigger?.keywords?.length === 2, '嵌套对象里的数组'],
      ['解释一下。{title:甲,steps:[一]}后面还有话', (r) => r?.title === '甲', '前后有杂字'],
      ['{title:"带,逗号的值",k:[a,b]}', (r) => r?.title === '带,逗号的值' && r?.k?.[1] === 'b', '混合（部分带引号）'],
      ['[甲,乙]', (r) => Array.isArray(r) && r.length === 2, '顶层数组'],
    ]
    for (const [input, ok, why] of cases) {
      const r = parseLooseJson(input)
      check(why, ok(r), JSON.stringify(r))
    }
    check('完全不是 JSON → null（不抛）', parseLooseJson('不是 JSON') === null)
    check('空输入 → null', parseLooseJson('') === null && parseLooseJson(null) === null)
    check('未闭合 → null 而不是死循环', parseLooseJson('{a:1') === null)
  }

  section('⑤ ★★ 解析器必须**终止**（bug ④：曾死循环跑到超时）')
  {
    // 这些输入都曾让第一版卡住/输出畸形；只要**能在合理时间内返回**就算过
    const t0 = Date.now()
    const weird = [
      '{a:}', '{:1}', '{a: }', '{a:[}', '{a:{}}', '{ , }', '{a:1,,b:2}',
      '{\n  a: 1,\n  b: [ x, y ]\n}', '{a:"未闭合', '{{{{', '[]', '{}',
    ]
    const results = weird.map((s) => parseLooseJson(s))
    const ms = Date.now() - t0
    check(`★ ${weird.length} 个畸形输入全部在 2 秒内返回（实际 ${ms}ms）`, ms < 2000, `${ms}ms`)
    check('全部不抛异常（返回对象或 null）',
      results.every((r) => r === null || typeof r === 'object'))
  }

  section('⑥ extractJsonObject 与 parseLooseJson 同源')
  check('同一份 fixture 结果一致',
    JSON.stringify(extractJsonObject(FIXTURE)) === JSON.stringify(parseLooseJson(FIXTURE)))

  // ══════════════════════════════════════════════════════════════════════════
  section('⑥-b ★★★ 真机事故：模型多写了两个 `}`（根对象提前闭合）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    // 这份 fixture 是**真机**产出，不是编的：2026-09-26 22:36 第一次自动抽取，
    // 日志只留了一行 `抽取输出解析不出 JSON`，靠读 DSH 落盘的抽取会话才取回原文。
    // 形状（两个 `}` 都是多的）：
    //   {"title":…,"steps":[…]},"pitfalls":[…]},"verify":"…"}
    //                          ↑                ↑
    const bom = readFileSync(join(PKG_ROOT, 'mocks/fixtures/headless-extra-brace.txt'), 'utf8')
    check('前提：这份 fixture 确实**不是**合法 JSON', (() => {
      try {
        JSON.parse(bom)
        return false
      } catch {
        return true
      }
    })())
    check('前提：它确实是"根对象后面还有杂字"（不是别的错法）',
      /Unexpected non-whitespace character after JSON/.test((() => {
        try {
          JSON.parse(bom)
          return ''
        } catch (e) {
          return e.message
        }
      })()))

    const parsed = parseLooseJson(bom)
    check('★★ 现在能解析出来（以前返回 null → 整条抽取被丢弃）', parsed !== null, JSON.stringify(parsed)?.slice(0, 80))
    check('★★ 不是"截断着解析"：**四个字段一个不少**',
      parsed?.title === '联网查最新资讯并交叉核实' &&
        parsed?.trigger?.keywords?.length === 3 &&
        parsed?.steps?.length === 5 &&
        parsed?.pitfalls?.length === 4 &&
        typeof parsed?.verify === 'string' && parsed.verify.length > 30,
      JSON.stringify({ kw: parsed?.trigger?.keywords?.length, steps: parsed?.steps?.length, pitfalls: parsed?.pitfalls?.length, verify: parsed?.verify?.length }))
    check('★ 多出来的 `}` 恰好被删掉两个（不是顺手删了合法的那个）',
      dropPrematureRootClose(bom).length === bom.length - 2,
      `${bom.length} → ${dropPrematureRootClose(bom).length}`)
    check('★ 删掉之后配平段就是整段（没有丢掉尾部）',
      firstBalancedSpan(dropPrematureRootClose(bom)) === dropPrematureRootClose(bom))
    check('★ 解析出来的配方能过字段校验（真能入库，不是"解析了个寂寞"）',
      normalizeRecipe(parsed, { source: 'auto' })?.steps?.length === 5)

    // ── 边界：这两条是"不许误删"的护栏 ─────────────────────────────────
    check('★ 合法 JSON 原样不动（幂等）', dropPrematureRootClose('{"a":1,"b":[2,3]}') === '{"a":1,"b":[2,3]}')
    check('★ 字符串里的 `}` 不当结构符', dropPrematureRootClose('{"a":"}","b":1}') === '{"a":"}","b":1}')
    check('★ 根数组里的对象闭合不受影响（depth 2）',
      dropPrematureRootClose('[{"a":1},{"b":2}]') === '[{"a":1},{"b":2}]')
    check('★ 末尾那个合法的 `}` 保留（删了就没法解析了）',
      dropPrematureRootClose('{"a":1}}') === '{"a":1}}' || dropPrematureRootClose('{"a":1}}') === '{"a":1}')
    check('★★ 模型写一半就断了 → 仍然 null（**宁可失败也不交出截断的配方**）',
      parseLooseJson('{"title":"x","steps":["a","b"') === null)
    check('★ 括号错配 → null（不猜）', parseLooseJson('{"a":[1,2}') === null)
    check('★ 尾部多说了话 → 只取配平那一段（完整对象照样能用）',
      parseLooseJson('好的，结果如下：{"title":"甲","steps":["一"]}\n希望有帮助！')?.title === '甲')
    check('★ 围栏里的 JSON 也能取出来',
      parseLooseJson('```json\n{"title":"甲","steps":["一"]}\n```')?.title === '甲')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑦ 抽取提示词：必须带"不值得就 skip"与可复用做法的要求')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const task = {
      goal: '帮我查一下克莱德洛这个品牌靠不靠谱',
      steps: [
        { action: '搜索 克莱德洛', outcome: 'ok', result: '3 条结果' },
        { action: '跑命令 Get-Content D:\\合同.pdf', outcome: 'blocked', result: '' },
        { action: '搜索 投诉', outcome: 'failed', result: '无结果' },
      ],
    }
    const sum = summarizeForPrompt({ task, ops: [] })
    check('带上用户要求', sum.includes('克莱德洛'))
    check('★ 步骤带结果标记（成功/失败/被权限拒绝）',
      sum.includes('成功') && sum.includes('失败') && sum.includes('被权限拒绝'), sum)

    const p = buildExtractPrompt({ task, ops: [], kind: 'private' })
    check('★ 说清"不值得沉淀就输出 skip"（否则配方库会被闲聊灌满）',
      p.includes('skip') && p.includes('不值得'), p.slice(0, 200))
    check('★ 要求 steps 写**可复用的做法**而不是流水账',
      p.includes('可复用的做法') && p.includes('不是流水账'))
    check('★ 要求 keywords 写"用户会怎么说"而不是工具名', p.includes('用户会怎么说出这类需求'))
    check('说明场合（私聊/群里）', p.includes('私聊里'), p.slice(0, 60))
    check('把经过拼进去了', p.includes('克莱德洛'))
  }

  section('⑧ summarizeForPrompt：没有台账步骤时退回用 oplog 兜底')
  {
    const ops = [
      { type: 'tool/call', name: 'read', args: { file_path: 'a.txt' } },
      { type: 'tool/result', ok: true, excerpt: 'x' },
      { type: 'tool/call', name: 'write', args: { file_path: 'b.txt' } },
    ]
    const s = summarizeForPrompt({ task: null, ops })
    check('用工具名兜底', s.includes('read') && s.includes('write'), s)
    check('空输入返回空串（不编）', summarizeForPrompt({}) === '')
    check(`最多 ${MAX_OPS_FOR_PROMPT} 条`,
      summarizeForPrompt({
        task: { steps: Array.from({ length: 40 }, (_, i) => ({ action: `步${i}`, outcome: 'ok' })) },
      }).split('\n').length <= MAX_OPS_FOR_PROMPT + 1)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑨ ★★ extractRecipe：全链路用**桩 runner**，任何失败都不抛')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const stub = (text, extra = {}) => async () => ({ ok: true, text, ms: 1234, ...extra })

    const okRun = await extractRecipe({
      cliPath: 'x', task: { goal: 'g', steps: [] }, ops: [], runner: stub(FIXTURE),
    })
    check('★ 正常抽取：拿到配方对象', okRun.ok === true && okRun.recipe?.title === '品牌口碑核查',
      JSON.stringify(okRun.recipe?.title ?? okRun.why))
    check('带回耗时（可观测）', okRun.ms === 1234 && okRun.raw === FIXTURE)

    const skipRun = await extractRecipe({
      cliPath: 'x', task: {}, ops: [], runner: stub('{"skip":true}'),
    })
    check('★ 模型说"不值得沉淀"→ skipped（不是失败）',
      skipRun.ok === true && skipRun.skipped === true, JSON.stringify(skipRun))

    const bareSkip = await extractRecipe({
      cliPath: 'x', task: {}, ops: [], runner: stub('{skip:true}'),
    })
    check('裸词 skip 也认', bareSkip.ok === true && bareSkip.skipped === true)

    const badRun = await extractRecipe({
      cliPath: 'x', task: {}, ops: [], runner: stub('模型今天不想输出 JSON'),
    })
    check('★ 解析不出 → ok:false 且带原文（可排查）',
      badRun.ok === false && badRun.raw === '模型今天不想输出 JSON', JSON.stringify(badRun.why))

    const failRun = await extractRecipe({
      cliPath: 'x', task: {}, ops: [], runner: async () => ({ ok: false, why: '抽取超时（1000ms）' }),
    })
    check('★ runner 失败 → 如实传上来（不吞）', failRun.ok === false && /超时/.test(failRun.why))

    let threw = false
    try {
      await extractRecipe({ cliPath: 'x', task: {}, ops: [], runner: async () => { throw new Error('炸了') } })
    } catch {
      threw = true
    }
    check('★★ runner 抛异常也不外泄（增强路径绝不能让聊天陪葬）', threw === false)

    const noCli = await runHeadless({ cliPath: '', prompt: 'x' })
    check('★ 没有 cliPath → 明确失败，不抛', noCli.ok === false && /找不到 dsh CLI/.test(noCli.why), noCli.why)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑩ ★★ 抽到的配方能入库，且**匹配与注入**立刻可用')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const WS = join(ROOT, 'ws')
    const run = await extractRecipe({ cliPath: 'x', task: {}, ops: [], runner: async () => ({ ok: true, text: FIXTURE }) })
    const up = upsertRecipe({ workspace: WS, recipe: run.recipe, source: 'auto' })
    check('入库成功', up.ok === true, JSON.stringify(up))
    check('列表里能看到', listRecipes({ workspace: WS }).length === 1)

    const picked = pickRecipes(listRecipes({ workspace: WS }), '帮我查一下这个牌子靠不靠谱')
    check('★ 用真实用户说法能匹配上', picked.length === 1, String(picked.length))
    // ⚠️ 这里原来写的是 `Math.abs(x - 0.5) < 1e-9` —— 那是个**会随机变红**的断言：
    //    置信度是 `base × 0.5 ^ (ageDays / 60)`（半衰期 60 天），而 `upsertRecipe` 与 `pickRecipes`
    //    之间隔着几次文件 IO，年龄不是 0 ⇒ 值必然略低于 0.5。实测在整套测试串跑（机器忙）时
    //    漂到 0.4999999989303284（差 1.07e-9）就把整条链判红了。
    //    现在断言的是**意图**：① 不会被"越用越信"抬到 base 之上；② 只允许那点时间衰减
    //    （1e-3 ≈ 半衰期公式下跑两小时才会掉的量级；而"算不算经验"的闸门是 0.15，离得很远）。
    check('★ 刚抽到的配方置信度在初始 0.5 附近（不会立刻被当经验）',
      picked[0]?.confidence <= 0.5 && picked[0]?.confidence >= 0.5 - 1e-3, String(picked[0]?.confidence))

    // 同名再抽一次 → 合并取并集，不该产生第二条
    const again = await extractRecipe({ cliPath: 'x', task: {}, ops: [], runner: async () => ({ ok: true, text: FIXTURE }) })
    upsertRecipe({ workspace: WS, recipe: again.recipe, source: 'auto' })
    check('★ 同一件事再抽一次 → 合并（不产生重复配方）',
      listRecipes({ workspace: WS }).length === 1, String(listRecipes({ workspace: WS }).length))
  }

  section('⑪ 默认节奏是常量（可被调用方覆盖）')
  check(`默认每 ${DEFAULT_EVERY_N} 回合一次`, DEFAULT_EVERY_N === 5, String(DEFAULT_EVERY_N))
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('')
if (failed === 0) {
  console.log(`🎉 抽取测试全部通过（${passed} 项）`)
  process.exit(0)
} else {
  console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
  process.exit(1)
}
