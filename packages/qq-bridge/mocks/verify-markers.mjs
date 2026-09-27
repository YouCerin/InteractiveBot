/**
 * 带内标记测试（H6）：`[reply:id]` / `[sticker:名]` 的解析、剥离、查表、提示词渲染。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 两条最要紧的断言
 * ══════════════════════════════════════════════════════════════════════════
 * ① **剥离是无条件的**：标记是我们的内部协议，哪怕这一轮不打算用引用，
 *    也绝不能让它出现在发给用户的正文里（与 `<<<MEMORY` 同一条纪律）。
 * ② **没有的东西不教**：提示词里凡是写了的能力都必须是真的 ——
 *    没有表情表就不许提 `[sticker:…]`，没有消息 id 就不许提 `[reply:…]`。
 *    这一轮修的正是"提示词承诺了引用，而引用通道根本不存在"那个毛病。
 *
 * 另外一组是**反例**：正文里正常的方括号（`[图片]`、`[1]`、`[reply]` 少了冒号）
 * 一律不许被动 —— 剥错就是把用户能看懂的内容吃掉。
 *
 * 用法：node mocks/verify-markers.mjs
 */

import {
  parseOutMarkers,
  resolveSticker,
  stickerNames,
  renderMarkerInstructions,
  MARKER_NAMES,
} from '../src/markers.mjs'

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
section('① 解析与剥离：标记一定进不了正文')
// ══════════════════════════════════════════════════════════════════════════
{
  const r1 = parseOutMarkers('好的，就是你说的那样。[reply:123456]')
  check('★ `[reply:123]` 被认出来', r1.replyTo === '123456', JSON.stringify(r1))
  check('★ 并且**从正文里剥掉了**', !r1.text.includes('[reply') && r1.text.includes('就是你说的那样'), JSON.stringify(r1.text))

  const r2 = parseOutMarkers('[reply:#123456] 这样写也行')
  check('带 `#` 前缀也认（提示词里给的就是带 # 的形式）', r2.replyTo === '123456', JSON.stringify(r2.replyTo))
  const r3 = parseOutMarkers('[reply: 123456 ] 带空格')
  check('带空格也认', r3.replyTo === '123456', JSON.stringify(r3.replyTo))
  const r4 = parseOutMarkers('[REPLY:123] 大小写不敏感')
  check('大小写不敏感', r4.replyTo === '123', JSON.stringify(r4.replyTo))

  const r5 = parseOutMarkers('[reply:abc] [reply:456]')
  check('非数字 id 被丢弃（不猜）', r5.replyTo === '456', JSON.stringify(r5))
  check('  └ 而且说明了原因（日志要看得懂）',
    r5.notes.some((n) => n.includes('不是消息 id')), JSON.stringify(r5.notes))
  check('★ 非数字那个标记同样被剥掉（不能留在正文里）', !r5.text.includes('reply'), JSON.stringify(r5.text))

  const r6 = parseOutMarkers('[reply:1] [reply:2]')
  check('多个引用 → 只取第一个，并说明', r6.replyTo === '1' && r6.notes.some((n) => n.includes('多个')), JSON.stringify(r6))

  // ── ★★★ 负数 id：本机 SnowLuma 的消息 id 就是负的 ───────────────────────
  //
  // 这一段盯的是一处**真机上"引用回复永远失效"**（0.2.3 从 bridge.log 抓到的）：
  // 真机事件里 `message_id` 是**负数**（日志里能看到 `-429124262`），而这里的
  // `ID_RE` 原来只认**非负**整数 ⇒ 模型照提示词写的 `[reply:#-429124262]`
  // **一次都没生效过**。注意 `#` 前缀本来就是会去掉的，**卡住的是那个负号** ——
  // 所以下面第一条断言用的是**真机原文**。
  {
    const real = parseOutMarkers('就是你说的那个。[reply:#-429124262]')
    check('★★★ 真机原文 `[reply:#-429124262]` 现在认得出（修前 replyTo 是 null）',
      real.replyTo === '-429124262', JSON.stringify(real))
    check('  └ 而且**不再有**"已丢弃"那条 note', real.notes.length === 0, JSON.stringify(real.notes))
    check('  └ 标记照样被剥掉', !real.text.includes('[reply'), JSON.stringify(real.text))

    check('裸负号也认', parseOutMarkers('[reply:-429124262]').replyTo === '-429124262')
    check('带空格的负数也认', parseOutMarkers('[reply:  -12  ]').replyTo === '-12')
    check('★ 包着引号/反引号也认（模型可能按 JSON 习惯写）',
      parseOutMarkers('[reply:"-429124262"]').replyTo === '-429124262' &&
        parseOutMarkers('[reply:`#-1`]').replyTo === '-1')

    // ★ 放宽的是**形状**，不是**校验**：仍然只认整数，认不出就丢弃并说明
    for (const [bad, why] of [
      ['[reply:abc]', '非数字'],
      ['[reply:#]', '只有前缀'],
      ['[reply:1.5]', '小数'],
      ['[reply:1e5]', '科学计数法'],
    ]) {
      const r = parseOutMarkers(bad)
      check(`★ ${why} 仍然被丢弃（不猜 id）`, r.replyTo === null && r.notes.some((n) => n.includes('不是消息 id')),
        `${JSON.stringify(r.replyTo)} ${JSON.stringify(r.notes)}`)
    }
    check('  └ 失败提示里说明了**可带负号与 # 前缀**（不然看日志的人会以为只能写正数）',
      parseOutMarkers('[reply:abc]').notes[0]?.includes('可带负号'))
  }

  const r7 = parseOutMarkers('[sticker:偷笑] 好')
  check('★ `[sticker:名]` 被认出来并剥掉', r7.sticker === '偷笑' && r7.text === '好', JSON.stringify(r7))

  check('两个标记同时出现都能处理',
    (() => {
      const r = parseOutMarkers('[reply:9][sticker:偷笑]哈哈')
      return r.replyTo === '9' && r.sticker === '偷笑' && r.text === '哈哈'
    })())
  check('★ 只有标记、没有正文 → 正文是空串（调用方据此决定"只发表情"）',
    parseOutMarkers('[sticker:偷笑]').text === '')
  check('空输入不抛', parseOutMarkers('').text === '' && parseOutMarkers(null).replyTo === null)
}

// ══════════════════════════════════════════════════════════════════════════
section('② 反例：正常方括号一个字都不许动')
// ══════════════════════════════════════════════════════════════════════════
{
  const keep = [
    ['方括号里的普通内容', '我看了 [图片] 和 [1] 这两个东西'],
    ['少了冒号的 reply', '这个 [reply] 是啥意思'],
    ['方括号里的代码', '写成 arr[0] 就行'],
    ['中文方括号', '【标题】这样写'],
    ['像是标记但缺右括号', '你写 [reply:123 这样就不对'],
    ['普通聊天', '行，那就这么定了。'],
  ]
  for (const [name, input] of keep) {
    const r = parseOutMarkers(input)
    check(`★ ${name} 原样不动`, r.text === input && r.replyTo === null && r.sticker === null, JSON.stringify(r.text))
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 表情查表：没有表就不发（宁可不发，也不发错）')
// ══════════════════════════════════════════════════════════════════════════
{
  check('★ 空表 → null（默认行为就是"不发表情"）', resolveSticker('偷笑', {}) === null)
  check('没有表参数 → null', resolveSticker('偷笑') === null)
  check('名字对不上 → null', resolveSticker('不存在', { 偷笑: 20 }) === null)
  check('★ 值不是数字 → null（不能把乱七八糟的东西当表情 id 发出去）',
    resolveSticker('偷笑', { 偷笑: 'abc' }) === null && resolveSticker('偷笑', { 偷笑: '1;2' }) === null)
  check('命中 → {kind:face,id}', JSON.stringify(resolveSticker('偷笑', { 偷笑: 20 })) === JSON.stringify({ kind: 'face', id: '20' }))
  check('数字值也接受（配置里写 20 和 "20" 都行）', resolveSticker('偷笑', { 偷笑: 20 })?.id === '20')
  check('空名字 → null', resolveSticker('  ', { 偷笑: 20 }) === null)
  check('stickerNames 排序稳定', JSON.stringify(stickerNames({ b: 1, a: 2 })) === JSON.stringify(['a', 'b']))
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 提示词渲染：**没东西就不教**（这一轮修的就是"承诺了做不到"）')
// ══════════════════════════════════════════════════════════════════════════
{
  check('★ 既没有消息 id、也没有表情表 → 返回空串（一个字都不写进提示词）',
    renderMarkerInstructions({}) === '' && renderMarkerInstructions() === '')

  const withId = renderMarkerInstructions({ messageId: '123456' })
  check('有消息 id 才教引用', withId.includes('123456') && withId.includes('[reply:'), withId.slice(0, 80))
  check('★ 并且明说"编的 id 不生效"（否则模型会随手编一个）',
    withId.includes('校验') && withId.includes('不会生效'), withId)
  check('★ 只说 reply，不说 sticker（没有表情表）', !withId.includes('[sticker:'), withId)

  const withSticker = renderMarkerInstructions({ stickers: { 偷笑: 20, 呲牙: 13 } })
  check('有表情表才教表情，并列出可用的名字',
    withSticker.includes('[sticker:') && withSticker.includes('偷笑') && withSticker.includes('呲牙'),
    withSticker.slice(0, 100))
  check('★ 没有消息 id 时不说 reply', !withSticker.includes('[reply:'), withSticker)

  const full = renderMarkerInstructions({ messageId: '9', stickers: { 偷笑: 20 } })
  check('两样都有 → 两样都教', full.includes('[reply:') && full.includes('[sticker:'))
  check('★ 标记名常量与实现一致（防文档漂移）',
    MARKER_NAMES.reply.includes('reply') && MARKER_NAMES.sticker.includes('sticker'))
}

console.log('')
if (failed === 0) {
  console.log(`🎉 带内标记测试全部通过（${passed} 项）`)
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
