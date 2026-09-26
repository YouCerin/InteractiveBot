/**
 * Rule tests for the wake-window state machine (`src/awake.ts`).
 *
 * Run after a build: `npm run test`. Kept dependency-free (node:assert) so it
 * needs no test framework in this package.
 */
import assert from 'node:assert/strict'
import { decideGroupMessage } from '../lib/awake.js'

const base = { sustainEnabled: true, silentLimit: 3, maxReplies: 20 }

let passed = 0
function check(name, input, expected) {
  const got = decideGroupMessage({ ...base, ...input })
  assert.equal(got.action, expected, `${name} → 期望 ${expected}，实际 ${got.action}`)
  passed += 1
  return got
}

// ---- 未唤醒 ----

check('未唤醒 + 明确激活 + 窗口开启 → 建立窗口', { hasWindow: false, explicit: true }, 'wake')
check('未唤醒 + 明确激活 + 窗口关闭 → 只回一条', { hasWindow: false, explicit: true, sustainEnabled: false }, 'reply-once')
check('未唤醒 + 随机命中 → 只回一条，不建立唤醒', { hasWindow: false, explicit: false, randomHit: true }, 'reply-once')
check('未唤醒 + 都没命中 → 不回', { hasWindow: false, explicit: false, randomHit: false }, 'none')
check(
  '随机命中不能盖过明确激活（仍建立窗口）',
  { hasWindow: false, explicit: true, randomHit: true },
  'wake',
)

// ---- 唤醒中 ----

check('唤醒中 + 再次明确激活 → 必然回复', { hasWindow: true, explicit: true, silent: 2, replies: 5 }, 'reactivate')

check('唤醒中 + 同话题 → 回复', { hasWindow: true, explicit: false, sameTopic: true, silent: 0, replies: 1 }, 'reply')
check('唤醒中 + 离题 → 结束且不回复', { hasWindow: true, explicit: false, sameTopic: false, silent: 0, replies: 1 }, 'silence')

check(
  '连续 silentLimit 条未提及 → 结束（第 3 条不回）',
  { hasWindow: true, explicit: false, sameTopic: true, silent: 2, replies: 2 },
  'silence',
)
check(
  '第 2 条未提及仍回复，计数 +1',
  { hasWindow: true, explicit: false, sameTopic: true, silent: 1, replies: 2 },
  'reply',
)

check(
  '回复次数达上限 → 结束',
  { hasWindow: true, explicit: false, sameTopic: true, silent: 0, replies: 20 },
  'silence',
)
check(
  '上限前一条仍回复',
  { hasWindow: true, explicit: false, sameTopic: true, silent: 0, replies: 19 },
  'reply',
)
check(
  '离题优先于次数上限判定',
  { hasWindow: true, explicit: false, sameTopic: false, silent: 0, replies: 99 },
  'silence',
)

// 计数器只增不减，且 silent/replies 各自推进
const cont = decideGroupMessage({ ...base, hasWindow: true, explicit: false, sameTopic: true, silent: 1, replies: 7 })
assert.deepEqual(
  { silent: cont.silent, replies: cont.replies },
  { silent: 2, replies: 8 },
  '继续唤醒时应写入 silent=2 replies=8',
)
passed += 1

// ---- 一段连续对话的时序（含多唤醒者互不影响）----

// 复刻 index.ts 的窗口表操作，验证「每个唤醒者单独记录」
const wakers = new Map()

/** @param {number} user @param {boolean} explicit @param {boolean} sameTopic */
function step(user, explicit, sameTopic = true) {
  const state = wakers.get(user)
  let same = sameTopic
  if (state && !explicit) same = sameTopic
  const d = decideGroupMessage({
    ...base,
    hasWindow: state !== undefined,
    explicit,
    sameTopic: same,
    silent: state?.silent,
    replies: state?.replies,
    randomHit: false,
  })
  if (d.action === 'silence') {
    wakers.delete(user)
  } else if (d.action === 'wake') {
    wakers.set(user, { wakeTopic: 't', silent: 0, replies: 1, lastAt: 0 })
  } else if (d.action === 'reactivate') {
    wakers.set(user, { ...state, wakeTopic: 't', silent: 0, replies: 1, lastAt: 0 })
  } else if (d.action === 'reply') {
    wakers.set(user, { ...state, silent: d.silent, replies: d.replies, lastAt: 0 })
  }
  return d.action
}

assert.equal(step(111, true), 'wake')            // A 唤醒
assert.equal(step(222, true), 'wake')            // B 也唤醒 → 并存
assert.equal(wakers.size, 2, '两个唤醒者应并存')
assert.equal(step(111, false, true), 'reply')    // A 同话题续聊
assert.equal(wakers.get(222).replies, 1, 'A 的续聊不应改动 B 的窗口')
passed += 1

assert.equal(step(222, false, false), 'silence') // B 换话题 → 只结束 B
assert.equal(wakers.size, 1, 'B 退出后只应剩 A')
assert.equal(step(111, false, true), 'reply')    // A 不受影响
passed += 1

// 此时 A 已连回 2 条未提及（第 108、115 行），故本条是第 3 条 → 结束
assert.equal(step(111, false, true), 'silence')  // A 第 3 条未提及 → 结束
assert.equal(wakers.size, 0, 'A 也退出后窗口表应为空')
assert.equal(step(111, false, true), 'none')     // 窗口已无：不再自动回复，需重新 @
passed += 1

console.log(`✓ awake.ts 规则测试全部通过（${passed} 项断言组）`)
