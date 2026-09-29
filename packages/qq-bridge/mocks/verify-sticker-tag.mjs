/**
 * 打标签**解析**测试（0.2.4）：把模型的输出翻译成"可写回库的标签"那一步。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个解析器为什么要被单独测（它看起来只是 JSON.parse）
 * ══════════════════════════════════════════════════════════════════════════
 * 它是"打标签"这条链路上**唯一会把外部输入变成库状态**的地方。判错的后果
 * 不是"少一张图"，而是**一张带错标签的图进入可用池** —— 然后它在某个场景
 * 被真的发出去。所以三条纪律都要有断言钉住：
 *
 *   ① **认不出就落待定**：标签不在词表里 / `unknown` / 置信度低于阈值
 *      —— 一律 `ok:false`，绝不硬塞一个近似标签；
 *   ② **宽松取 JSON**：该适配器不认 `response_format`（`model-direct.mjs` 文件头
 *      记着这条取证），所以模型输出常带代码块或前后一句话 —— 必须能抠出来；
 *   ③ **次要标签要过滤**：非法的、重复的、与主标签相同的都不许进库。
 *
 * 用法：node mocks/verify-sticker-tag.mjs
 */

import { buildTagPrompt, parseTagReply, pendingEntries } from '../src/sticker-tag.mjs'
import { MIN_TAG_CONFIDENCE, STICKER_LABELS, renderTaggingGuide } from '../src/sticker-labels.mjs'

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

// ══════════════════════════════════════════════════════════════════════════
section('① 正常解析：包里代码块 / 前后带话 / 中文名 / 中文键都认')
// ══════════════════════════════════════════════════════════════════════════
{
  const a = parseTagReply('```json\n{"primary":"laugh","secondary":["agree"],"confidence":0.9,"why":"大笑"}\n```')
  check('代码块包裹能抠出 JSON', a.ok && a.primary === 'laugh' && a.secondary.includes('agree'), JSON.stringify(a))
  check('置信度带过来', a.confidence === 0.9)

  const b = parseTagReply('我觉得这张是笑死的：{"primary":"笑死","secondary":[],"confidence":0.8}')
  check('★ 中文名归一成 id（库文件是人可读的，不能只认 id）', b.ok && b.primary === 'laugh', JSON.stringify(b))
  check('前后有自然语言也能抠出来', b.ok === true && b.confidence === 0.8)

  const c = parseTagReply('{"primary":"LAUGH","secondary":[],"confidence":1}')
  check('大小写变体也认', c.ok && c.primary === 'laugh', JSON.stringify(c))

  const d = parseTagReply('{"primary":"agree","secondary":[],"confidence":0.7}')
  check('缺失 why 不影响（它是给人看的，不是判据）', d.ok && d.why === '')
}

// ══════════════════════════════════════════════════════════════════════════
section('② ★★ 认不出就落待定（这是最关键的一条）')
// ══════════════════════════════════════════════════════════════════════════
{
  const invented = parseTagReply('{"primary":"狂笑","secondary":[],"confidence":0.9}')
  check('★★ 模型发明标签 → ok:false（绝不硬塞）', invented.ok === false, JSON.stringify(invented))
  check('  └ 原因里写清了是哪个标签被拒', String(invented.why).includes('狂笑'), invented.why)

  const unknown = parseTagReply('{"primary":"unknown","secondary":[],"confidence":1}')
  check('★ unknown → 落待定，且原因不是"不在词表里"（两回事）',
    unknown.ok === false && unknown.why.includes('不适用'), unknown.why)

  const low = parseTagReply(`{"primary":"laugh","secondary":[],"confidence":0.2}`)
  check(`★ 置信度低于 ${MIN_TAG_CONFIDENCE} → 落待定`, low.ok === false && low.why.includes('置信度'), low.why)

  const noJson = parseTagReply('这张图我说不清')
  check('没有 JSON → 落待定（不猜）', noJson.ok === false && noJson.why.includes('没有 JSON'), noJson.why)

  const broken = parseTagReply('{"primary":"laugh",,}')
  check('JSON 坏了 → 落待定（不抛异常）', broken.ok === false, broken.why)

  const empty = parseTagReply('')
  check('空输出 → 落待定', empty.ok === false)
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 次要标签：过滤非法、重复、与主标签相同')
// ══════════════════════════════════════════════════════════════════════════
{
  const r = parseTagReply(
    '{"primary":"laugh","secondary":["狂笑","agree","laugh","agree","bogus"],"confidence":1}',
  )
  check('★ 次要标签里的非法项被丢掉', !r.secondary.includes('狂笑') && !r.secondary.includes('bogus'), JSON.stringify(r.secondary))
  check('★ 重复项与主标签本身被去掉', r.secondary.length === 1 && r.secondary[0] === 'agree', JSON.stringify(r.secondary))

  const many = parseTagReply('{"primary":"laugh","secondary":["agree","shock","tired","sad"],"confidence":1}')
  check('不让次要标签无限膨胀（最多 2 个）', many.secondary.length <= 2, JSON.stringify(many.secondary))

  const noSecondary = parseTagReply('{"primary":"laugh","confidence":1}')
  check('缺 secondary 不报错', noSecondary.ok && noSecondary.secondary.length === 0)
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 提示词：词表与负例都要给（打标签的准确率全靠这段）')
// ══════════════════════════════════════════════════════════════════════════
{
  const guide = renderTaggingGuide()
  check('词表里每个标签都在提示词里（含中文名）',
    STICKER_LABELS.every((l) => guide.includes(l.id) && guide.includes(l.name)))
  check('★ 给了"易混对照"（这是打标签最容易错的地方）', guide.includes('易混'), guide.slice(0, 100))
  check('★ 给了判别优先级', guide.includes('优先级'))

  const prompt = buildTagPrompt({ file: 'group-1/abc.png' })
  check('提示词要求只输出 JSON', prompt.includes('只输出一个 JSON'))
  check('★ 明确说了"一个都不合适就写 unknown"', prompt.includes('unknown'))
  check('★ 明确说了低分要老实写（打错比不用糟）', prompt.includes('比留着不用糟得多'))
  check('带上文件名（排障时能对上）', prompt.includes('group-1/abc.png'))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 待打标签的挑选：没有主标签 / 置信度不够的都算')
// ══════════════════════════════════════════════════════════════════════════
{
  const lib = {
    entries: {
      'a/1.png': { primary: 'laugh', primaryConfidence: 0.9 },
      'a/2.png': { primary: null, primaryConfidence: null },
      'a/3.png': { primary: 'agree', primaryConfidence: 0.2 },
      'a/4.png': { primary: 'shock' },
    },
  }
  const pending = pendingEntries(lib).map((e) => e.rel)
  check('★ 没有标签的算待打', pending.includes('a/2.png'))
  check('★ 置信度不够的算待打（会被重打）', pending.includes('a/3.png'))
  check('打好的不算', !pending.includes('a/1.png') && !pending.includes('a/4.png'), JSON.stringify(pending))
}

console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
