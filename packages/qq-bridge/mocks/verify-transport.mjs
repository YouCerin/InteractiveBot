/**
 * 传输契约测试（H9）：把"出错了"变成**结构化的、可判定的**东西。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套盯的三件事
 * ══════════════════════════════════════════════════════════════════════════
 * ① **分类要准、要有 `retryable` 这个一等字段** —— 以前只能靠**匹配错误字符串**
 *    判断"这个能不能重试"，脆得要命；不认识的情况**不猜成"可重试"**
 *    （猜错方向会把"其实对方已经收到了"的操作再发一遍）。
 * ② **投递去重键必须带会话** —— 现在的去重键是**裸文本**，而队列是整个桥接共用的，
 *    于是"同一句话 8 秒内发给两个不同会话"时第二个会被**误判成重复而丢掉**。
 * ③ **断线缺口要显式标注** —— "宁可标缺口，也不假装连续"：模型若把掉线前后
 *    当成连续对话，就会基于一个错误前提回答。
 *
 * 用法：node mocks/verify-transport.mjs
 */

import { classifyTransport, shouldRetry, deliveryKey, describeGap, stickerFingerprint, LAYER } from '../src/transport.mjs'
import { SendQueue } from '../src/onebot.mjs'

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
section('① 分类：层 / 可重试 / 可执行提示')
// ══════════════════════════════════════════════════════════════════════════
{
  const c426 = classifyTransport({ action: 'send_private_msg', httpStatus: 426 })
  check('★ 426 → config 层、**不可重试**、带"端口填反"的提示',
    c426.layer === LAYER.CONFIG && c426.retryable === false && c426.hint.includes('3000'),
    JSON.stringify({ layer: c426.layer, retryable: c426.retryable }))
  check('★ 人话消息里带 action 名（排查时要知道是哪个动作）', c426.message.includes('send_private_msg'), c426.message)

  const c401 = classifyTransport({ httpStatus: 401 })
  check('★★ 401 → auth 层、不可重试、提示指向"token 两处漂移"',
    c401.layer === LAYER.AUTH && c401.retryable === false && c401.hint.includes('token'),
    JSON.stringify({ layer: c401.layer, hint: c401.hint.slice(0, 30) }))
  check('403 也算 auth', classifyTransport({ httpStatus: 403 }).layer === LAYER.AUTH)
  check('★ 5xx → **可重试**（协议端内部错误，重试有意义）',
    classifyTransport({ httpStatus: 503 }).retryable === true && classifyTransport({ httpStatus: 500 }).retryable === true)
  check('404 → protocol 层、不可重试', classifyTransport({ httpStatus: 404 }).layer === LAYER.PROTOCOL)
  check('429 → 可重试（被限流）', classifyTransport({ httpStatus: 429 }).retryable === true)
  check('★ 其它 4xx → 不可重试', classifyTransport({ httpStatus: 418 }).retryable === false)

  check('超时（AbortError）→ timeout 层、**可重试**',
    classifyTransport({ errorName: 'AbortError' }).layer === LAYER.TIMEOUT &&
      classifyTransport({ errorName: 'AbortError' }).retryable === true)
  check('ECONNREFUSED → network 层、可重试、提示"没东西在听"',
    classifyTransport({ errorCode: 'ECONNREFUSED' }).hint.includes('没启动'))
  check('ENOTFOUND → 可重试、提示"地址写错"', classifyTransport({ errorCode: 'ENOTFOUND' }).hint.includes('httpUrl'))

  check('retcode 1403 → auth 层（token 不对）',
    classifyTransport({ retcode: 1403 }).layer === LAYER.AUTH &&
      classifyTransport({ retcode: 1403 }).message.includes('1403'))
  check('retcode 100 → protocol 层、不可重试', classifyTransport({ retcode: 100 }).retryable === false)
  check('★★ **不认识的 retcode 不猜**：仍给 protocol 层，但 `retryable: false`',
    (() => {
      const r = classifyTransport({ retcode: 987654 })
      return r.layer === LAYER.PROTOCOL && r.retryable === false && r.message.includes('987654')
    })())
  check('★ 完全不认识的错误 → unknown 层 + **不可重试**（见文件头纪律①）',
    (() => {
      const r = classifyTransport({ message: '天知道发生了什么' })
      return r.layer === LAYER.UNKNOWN && r.retryable === false
    })())
  check('空输入不抛，给出 unknown', classifyTransport().layer === LAYER.UNKNOWN)
  check('shouldRetry 只认 true', shouldRetry({ retryable: true }) === true && shouldRetry({}) === false && shouldRetry(null) === false)
}

// ══════════════════════════════════════════════════════════════════════════
section('② ★★ 投递去重键：带会话，跨会话不误伤')
// ══════════════════════════════════════════════════════════════════════════
{
  const a = deliveryKey({ chatKey: 'private:1', text: '好的' })
  const b = deliveryKey({ chatKey: 'private:2', text: '好的' })
  const a2 = deliveryKey({ chatKey: 'private:1', text: '好的' })
  check('★★ 同一句话在不同会话 → **键不同**（裸文本当键时这里会误判成重复）', a !== b, `${a.slice(0, 8)} vs ${b.slice(0, 8)}`)
  check('★ 同会话同文本 → 键稳定（去重仍然有效）', a === a2)
  check('键长 32（够用且不占地方）', a.length === 32, String(a.length))
  check('引用不同 → 键不同', deliveryKey({ chatKey: 'c', text: 'x', replyTo: '1' }) !== deliveryKey({ chatKey: 'c', text: 'x', replyTo: '2' }))
  check('表情不同 → 键不同', deliveryKey({ chatKey: 'c', text: 'x', faceId: '1' }) !== deliveryKey({ chatKey: 'c', text: 'x', faceId: '2' }))
  check('空参不抛', typeof deliveryKey({}) === 'string' && typeof deliveryKey() === 'string')
  check('字段之间不会串（分隔符的作用）',
    deliveryKey({ chatKey: 'a', text: 'bc' }) !== deliveryKey({ chatKey: 'ab', text: 'c' }))

  // ── ★ 0.2.4：表情包图片也要进去重键 ──────────────────────────────────
  //   不带它的话，"同一句话 + 两张不同的图"会被判成同一条，第二张静默丢掉。
  check('★ 表情包图片不同 → 键不同（否则第二张会被静默丢掉）',
    deliveryKey({ chatKey: 'c', text: '哈哈', sticker: 'aaaa' }) !==
      deliveryKey({ chatKey: 'c', text: '哈哈', sticker: 'bbbb' }))
  check('贴纸图与内置表情 id 不会互相串',
    deliveryKey({ chatKey: 'c', text: 'x', faceId: 'a1' }) !==
      deliveryKey({ chatKey: 'c', text: 'x', sticker: 'a1' }))
  check('没有图时键不受影响（老口径不变）',
    deliveryKey({ chatKey: 'c', text: 'x' }) === deliveryKey({ chatKey: 'c', text: 'x', sticker: null }))
  check('stickerFingerprint 稳定且短', stickerFingerprint('AAA') === stickerFingerprint('AAA') && stickerFingerprint('AAA').length === 16)
  check('不同的图指纹不同', stickerFingerprint('AAA') !== stickerFingerprint('AAB'))
  check('★ 空图 → 空串（调用方据此判断"没有图"）', stickerFingerprint('') === '' && stickerFingerprint(null) === '')
}

// ══════════════════════════════════════════════════════════════════════════
section('③ ★★ 端到端：SendQueue 按会话去重（这是真实缺陷的复现点）')
// ══════════════════════════════════════════════════════════════════════════
{
  const q = new SendQueue({ minGapMs: 0, maxGapMs: 0, dedupeWindowMs: 60_000, log: () => {} })
  const k1 = deliveryKey({ chatKey: 'private:1', text: '在的' })
  const k2 = deliveryKey({ chatKey: 'private:2', text: '在的' })

  check('第一条放行', q.check('在的', k1).ok === true)
  q.markSent('在的', k1)
  check('★ 同一会话里重发同一句 → 判为重复（这是**要**拦的）',
    q.check('在的', k1).ok === false && q.check('在的', k1).reason.includes('重复'))
  check('★★ 另一个会话里发同一句 → **放行**（旧行为会在这里误拦）', q.check('在的', k2).ok === true,
    JSON.stringify(q.check('在的', k2)))

  // 不传 key 时退回旧行为（裸文本）—— 向后兼容
  const q2 = new SendQueue({ minGapMs: 0, maxGapMs: 0, dedupeWindowMs: 60_000, log: () => {} })
  q2.markSent('同一句')
  check('★ 不传 key 时仍按文本去重（向后兼容，老调用方不受影响）', q2.check('同一句').ok === false)
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 断线缺口：显式标注，不假装连续')
// ══════════════════════════════════════════════════════════════════════════
{
  const long = describeGap({ ms: 42_000 })
  check('★ 长缺口给出明确标注（含时长）', long.includes('断线') && long.includes('42 秒'), long.slice(0, 60))
  check('★★ 并且**明说"这期间的消息收不到"**（不假装收到了）', long.includes('收不到'))
  check('★★ 明确指示"**不要猜**他刚才说了什么"（猜了就是编）',
    long.includes('不要猜') && long.includes('再说一遍'))
  check('分钟级也能读（不是"7200 秒"这种）', describeGap({ ms: 125_000 }).includes('分钟'), describeGap({ ms: 125_000 }).slice(0, 40))
  check('★ 短抖动（<5 秒）不提 —— 网络抖一下就说"我掉线了"会很吵', describeGap({ ms: 2_000 }) === '')
  check('★ 用 since/until 也能算（时长一致，另外多一个"从几点起"）', (() => {
    const byRange = describeGap({ since: 1000, until: 1000 + 42_000 })
    const byMs = describeGap({ ms: 42_000 })
    // ⚠️ 两者**本来就不该完全相同**：给了 since 时多一句"从 HH:MM:SS 起"。
    //   第一版断言写成 `===`，那是在期待 bug 的行为。
    return byRange.includes('42 秒') && byMs.includes('42 秒') && byRange.includes('（从 ') && !byMs.includes('（从 ')
  })(), JSON.stringify(describeGap({ since: 1000, until: 1000 + 42_000 }).slice(0, 50)))
  check('缺参/异常值不抛，返回空串',
    describeGap({}) === '' && describeGap({ ms: null }) === '' && describeGap({ ms: -100 }) === '')
}

console.log('')
if (failed === 0) {
  console.log(`🎉 传输契约测试全部通过（${passed} 项）`)
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
