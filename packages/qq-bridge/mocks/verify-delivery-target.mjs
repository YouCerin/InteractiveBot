/**
 * 出站目标（`src/delivery-target.mjs`）的纯函数测试 —— 0.3.3 · S5a。
 *
 * 这一层存在的理由写在模块头注释里：**游戏里说的话被投进 QQ 私聊**（E6）不是
 * "某处写错了 if"，而是"会话键字符串同时决定发去哪儿"这个结构允许它发生。
 *
 * 所以这里的判据盯三件事：
 *   ① 通道是**枚举**（不认识就拒，绝不猜）；
 *   ② 目标格式由**通道**决定，且错误文案要说清该填什么；
 *   ③ 老记录**读得出来**（`channelFromStored`）但**发不出去**（`LEGACY_CHANNEL` 被拒）。
 *
 * 用法：node mocks/verify-delivery-target.mjs
 */

import {
  CHANNELS,
  LEGACY_CHANNEL,
  DeliveryTargetError,
  resolveTarget,
  requireTarget,
  chatKeyOf,
  targetOfKind,
  channelFromStored,
  checkCrossChannel,
} from '../src/delivery-target.mjs'

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

/* ══════════════════════════════════════════════════════════════════════════ */
section('① 通道是枚举：不认识就拒，绝不猜')
// ══════════════════════════════════════════════════════════════════════════
{
  check('四个合法通道就是这四个（多一个/少一个都会让下面的判据失效）',
    CHANNELS.join(',') === 'qq-group,qq-private,game,console', CHANNELS.join(','))
  for (const ch of CHANNELS) {
    const r = resolveTarget({ channel: ch, target: ch === 'game' ? 'mc-main' : ch === 'console' ? 'main' : '100000001' })
    check(`★ 合法通道 ${ch} 能解析出来`, r.ok === true, r.ok ? r.chatKey : r.why)
  }
  const unknown = resolveTarget({ channel: 'qq', target: '100000001' })
  check('★★★ `qq` 不是可出站的通道（那是读老记录的占位）', unknown.ok === false, unknown.why)
  check('★ 而且错因**说清该怎么办**（不是只说"不合法"）',
    unknown.ok === false && /读老记录|qq-group|qq-private/.test(unknown.why), unknown.why)
  check('空通道 → 拒', resolveTarget({ channel: '', target: '1' }).ok === false)
  check('乱写的通道 → 拒，并列出合法值',
    /qq-group/.test(resolveTarget({ channel: 'telegram', target: '1' }).why ?? ''))
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('② C3：非法 target 抛错（而且文案说清该填什么）')
// ══════════════════════════════════════════════════════════════════════════
{
  // ★ 执行单 C3 点名的两个反例
  const a = resolveTarget({ channel: 'qq', target: '100000001' })
  check('★★ `qq:100000001` 不合法（通道 `qq` + 目标 `100000001` 也不行：通道必须先说清群/私聊）',
    a.ok === false, a.why)
  const b = resolveTarget({ channel: 'game', target: 'mc-main' })
  check('★★★ `game:mc-main` 合法（拆分后必须是这个形状）', b.ok === true, b.ok ? b.chatKey : b.why)

  // ★ 把会话键整个塞进 target：报错，**不替他拆**
  const c = resolveTarget({ channel: 'qq-group', target: 'group:123456' })
  check('★★★ 目标里带冒号 → 拒（拒绝"帮他拆"：拆了就等于没改掉那个坏写法）',
    c.ok === false && /冒号/.test(c.why), c.why)

  const bad = [
    ['qq-group', 'abc', '群号不是数字'],
    ['qq-group', '1234', '群号太短'],
    ['qq-private', '-10001', '负号'],
    ['qq-private', '  ', '空白'],
    ['game', '', '空'],
    ['game', 'mc main', '带空格（会进 RCON 命令）'],
    ['game', '../etc', '路径穿越'],
    ['game', 'mc;shutdown', '命令注入'],
    ['console', 'a b', '带空格'],
  ]
  for (const [ch, tgt, why] of bad) {
    const r = resolveTarget({ channel: ch, target: tgt })
    check(`★ 「${why}」→ 拒（${ch} / ${JSON.stringify(tgt)}）`, r.ok === false, r.why)
  }
  check('★ 每一种拒绝都带可操作的原因（都提到"必须/只能/不能"之类）',
    bad.every(([ch, tgt]) => {
      const r = resolveTarget({ channel: ch, target: tgt })
      return r.ok === false && /必须|只能|不能|不要/.test(r.why)
    }))

  let threw = null
  try {
    requireTarget({ channel: 'game', target: '' })
  } catch (error) {
    threw = error
  }
  check('★★ `requireTarget` 对非法目标**抛** `DeliveryTargetError`',
    threw instanceof DeliveryTargetError, threw ? `${threw.name}: ${threw.message}` : '（没抛）')
  check('★ 抛出来的对象带着原始的 channel/target（便于日志与测试断言）',
    threw?.channel === 'game' && threw?.target === '',
    `${threw?.channel} / ${threw?.target}`)
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('③ 会话键只有一种拼法（别处不许自己 `${kind}:${peerId}`）')
// ══════════════════════════════════════════════════════════════════════════
{
  check('qq-group → `group:<群号>`', chatKeyOf('qq-group', '123456') === 'group:123456')
  check('qq-private → `private:<QQ>`', chatKeyOf('qq-private', '10001') === 'private:10001')
  check('game → `game:<服务器 id>`', chatKeyOf('game', 'mc-main') === 'game:mc-main')
  check('console → `console:<会话名>`', chatKeyOf('console', 'main') === 'console:main')
  let threw = false
  try {
    chatKeyOf('game', '')
  } catch {
    threw = true
  }
  check('★ 非法组合拼键时**抛**（不返回一个错键让后面去猜）', threw)
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('④ 入口适配：QQ 事件的 kind → 目标（**只在入口**做这一次推导）')
// ══════════════════════════════════════════════════════════════════════════
{
  check('`group` → `qq-group`', targetOfKind('group', '123456').channel === 'qq-group')
  check('`private` → `qq-private`', targetOfKind('private', '10001').channel === 'qq-private')
  check('★★ 不认识的 kind → `{ok:false}`（不默认为私聊 —— 那正是 E6 的形状）',
    targetOfKind('whatever', '1').ok === false, targetOfKind('whatever', '1').why)
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('⑤ 老记录：读得出来，但**发不出去**（只读兼容，不回写）')
// ══════════════════════════════════════════════════════════════════════════
{
  check('显式 channel 优先',
    channelFromStored({ channel: 'game', chatKey: 'group:1', kind: 'group' }) === 'game')
  check('★ 只有 chatKey 的老账本行 → 按前缀认出来',
    channelFromStored({ chatKey: 'private:10001' }) === 'qq-private')
  check('★ 只有 chatKey（群）→ 认出来',
    channelFromStored({ chatKey: 'group:123456' }) === 'qq-group')
  check('★★★ 三样都没有 → 只敢说"是 QQ 的"（`qq`），**不猜成私聊**',
    channelFromStored({ chatKey: '', kind: '' }) === LEGACY_CHANNEL)
  check('★★ 而 `qq` 这个占位拿去发 → 被拒（读与发是两条判据）',
    resolveTarget({ channel: channelFromStored({}), target: '10001' }).ok === false,
    resolveTarget({ channel: LEGACY_CHANNEL, target: '10001' }).why)
  check('★ 老游戏的镜像键（`game:mc-main`）也认得出',
    channelFromStored({ chatKey: 'game:mc-main' }) === 'game')
}

/* ══════════════════════════════════════════════════════════════════════════ */
section('⑥ 跨通道：开关 → 格式 → 白名单（三连，缺一个都拒）')
// ══════════════════════════════════════════════════════════════════════════
{
  const to = { channel: 'qq-group', target: '123456' }
  check('★★ 默认关（配置缺省也当关）',
    checkCrossChannel({ from: 'game', to, config: {} }).ok === false,
    checkCrossChannel({ from: 'game', to, config: {} }).why)
  check('★★ 开关关了，白名单写了也没用（顺序：开关在最前）',
    checkCrossChannel({
      from: 'game', to, config: { enabled: false, allow: ['qq-group:123456'] },
    }).ok === false)
  check('★ 开关开了但目标不合法 → 拒（格式在开关之后、白名单之前）',
    checkCrossChannel({
      from: 'game', to: { channel: 'qq-group', target: 'abc' }, config: { enabled: true, allow: ['qq-group:abc'] },
    }).ok === false)
  check('★★ 开关开、格式对、白名单没写 → 拒',
    checkCrossChannel({ from: 'game', to, config: { enabled: true, allow: [] } }).ok === false)
  check('★★★ 三样都满足才放行',
    checkCrossChannel({
      from: 'game', to, config: { enabled: true, allow: ['qq-group:123456'] },
    }).ok === true)
  check('★ 白名单**精确到目标**：只放行 A 群的配置不能发到 B 群',
    checkCrossChannel({
      from: 'game', to: { channel: 'qq-group', target: '999999' }, config: { enabled: true, allow: ['qq-group:123456'] },
    }).ok === false)
  check('★ 同通道不算"跨通道"（开关关着也放行）',
    checkCrossChannel({ from: 'qq-group', to, config: {} }).ok === true)
  check('★ 白名单里写通道级（不带目标）不算授权',
    checkCrossChannel({ from: 'game', to, config: { enabled: true, allow: ['qq-group'] } }).ok === false)
}

console.log('')
if (failed === 0) {
  console.log(`🎉 出站目标（S5a）全部通过（${passed} 项）`)
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
