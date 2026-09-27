#!/usr/bin/env node
/**
 * 配置模块测试：`normalizeConfig` 与 `validateConfig`。
 *
 * ── 为什么这两个函数值得单独测 ─────────────────────────────────────────
 * 它们原先埋在 `index.mjs` 里，只在启动时跑一次，**因此从没被测试过**。
 * 这类代码最典型的故障是：**改了一个配置键名，程序静默回落到默认值**。
 * 不报错、不崩，只是你设的值不生效 —— 最难排查的一类问题。
 *
 * 这里覆盖三件事：
 *   ① 默认值必须是"安全"的（不是"方便"的）
 *   ② 用户给的值必须真的生效（防止键名写错导致静默失效）
 *   ③ 危险配置必须被拦下或明确警告
 *
 * 用法：node mocks/verify-config.mjs
 */

import { normalizeConfig, validateConfig } from '../src/config.mjs'
import { DIRS } from '../src/local.mjs'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

/** 一份最小的原始配置（模拟 config.json 的内容）。 */
const raw = {
  dsh: { provider: 'deepseek-official', model: 'deepseek-flash' },
  onebot: {
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    wsToken: 'ws-t',
    httpToken: 'http-t',
  },
  access: { adminUsers: ['100000001'] },
  trigger: { keywords: ['小鲸鱼'] },
}

// ══════════════════════════════════════════════════════════════════════════
section('默认值必须是"安全"的（不是"方便"的）')
// ══════════════════════════════════════════════════════════════════════════
{
  const c = normalizeConfig({})

  check('★ permissionMode 默认 workspace-write（绝不是全权）',
    c.dsh.permissionMode === 'workspace-write', c.dsh.permissionMode)
  check('★ adminUsers 默认空数组 = 谁都不能用（fail-closed）',
    Array.isArray(c.access.adminUsers) && c.access.adminUsers.length === 0,
    JSON.stringify(c.access.adminUsers))
  check('★ humanize 默认开启（账号存活相关，不能默认关）',
    c.humanize.enabled === true, String(c.humanize.enabled))
  check('★ 群聊默认关闭', c.trigger.groupEnabled === false)
  check('私聊/被@/关键词三个触发默认开启',
    c.trigger.private === true && c.trigger.mention === true && c.trigger.keyword === true)
  check('工作区有默认值（相对包根，可随包搬迁）',
    c.dsh.workspace === DIRS.defaultWorkspace, c.dsh.workspace)

  check('空输入不崩且结构完整',
    c.dsh && c.onebot && c.access && c.trigger && c.send && c.turn && c.humanize && c.session && c.ui)
  check('input 为 undefined 也不崩', Boolean(normalizeConfig(undefined).dsh))
}

// ══════════════════════════════════════════════════════════════════════════
section('用户设的值必须真的生效（防止键名写错导致静默失效）')
// ══════════════════════════════════════════════════════════════════════════
{
  const c = normalizeConfig({
    ...raw,
    dsh: { ...raw.dsh, permissionMode: 'read-only', model: 'deepseek-v4-pro' },
    access: { adminUsers: ['111', 222] },
    trigger: { keyword: false, groupEnabled: true, keywords: ['甲', '乙'] },
    send: { maxPerMinute: 3, dedupeWindowMs: 100 },
    turn: { timeoutMs: 5_000 },
    humanize: {
      charsPerSecond: 12,
      maxDelayMs: 1_000,
      quietHours: { enabled: true, start: '01:00', end: '06:00' },
    },
    session: { salt: 'my-salt', instance: 'run-7' },
  })

  check('permissionMode 生效', c.dsh.permissionMode === 'read-only', c.dsh.permissionMode)
  check('model 生效', c.dsh.model === 'deepseek-v4-pro', c.dsh.model)
  check('★ adminUsers 里的数字被归一化成字符串（否则白名单比对会失败）',
    c.access.adminUsers.every((x) => typeof x === 'string'), JSON.stringify(c.access.adminUsers))
  check('trigger.keyword=false 生效', c.trigger.keyword === false)
  check('trigger.groupEnabled=true 生效', c.trigger.groupEnabled === true)
  check('send.maxPerMinute 生效（不是回落默认 8）', c.send.maxPerMinute === 3, String(c.send.maxPerMinute))
  check('send.dedupeWindowMs 生效（不是回落默认 8000）', c.send.dedupeWindowMs === 100, String(c.send.dedupeWindowMs))
  check('turn.timeoutMs 生效（不是回落默认 600000）', c.turn.timeoutMs === 5_000, String(c.turn.timeoutMs))
  check('★ humanize.charsPerSecond 生效（写明这点是因为它最容易因键名写错而静默失效）',
    c.humanize.charsPerSecond === 12, String(c.humanize.charsPerSecond))
  check('humanize.maxDelayMs 生效', c.humanize.maxDelayMs === 1_000, String(c.humanize.maxDelayMs))
  check('humanize.quietHours 三项都生效',
    c.humanize.quietHours.enabled === true &&
      c.humanize.quietHours.start === '01:00' &&
      c.humanize.quietHours.end === '06:00',
    JSON.stringify(c.humanize.quietHours))
  check('session.salt / instance 生效',
    c.session.salt === 'my-salt' && c.session.instance === 'run-7')

  // ★ 未显式设置的项应来自档位（而不是某个写死的默认值）。
  // 这里改过一次：以前断言 reactMinMs === 1500（写死的默认），
  // 引入速度档位后该值由档位提供。断言也跟着改成"档位被正确展开"，
  // 否则测试就成了在守护一个已经不存在的实现。
  check('未设的项来自速度档位（例：reactMinMs = 均衡档的 3500）',
    c.humanize.reactMinMs === 3500, String(c.humanize.reactMinMs))
  check('档位被记录进配置（便于 UI 显示当前处于哪档）',
    c.humanize.speed === 'balanced', String(c.humanize.speed))
}

// ══════════════════════════════════════════════════════════════════════════
section('token 与 URL 的边界')
// ══════════════════════════════════════════════════════════════════════════
{
  const c1 = normalizeConfig({ onebot: { wsToken: 'only-ws' } })
  check('只配 wsToken 时 httpToken 退回同一个值', c1.onebot.httpToken === 'only-ws', c1.onebot.httpToken)

  const c2 = normalizeConfig({ onebot: { wsToken: 'a', httpToken: 'b' } })
  check('两个 token 分别配置时互不覆盖',
    c2.onebot.wsToken === 'a' && c2.onebot.httpToken === 'b')

  const c3 = normalizeConfig({ onebot: { selfId: 200000001 } })
  check('★ selfId 数字被转成字符串（防自环比对依赖类型一致）',
    c3.onebot.selfId === '200000001' && typeof c3.onebot.selfId === 'string', String(c3.onebot.selfId))

  const c4 = normalizeConfig({ onebot: {} })
  check('selfId 未配置时为 null', c4.onebot.selfId === null)
}

// ══════════════════════════════════════════════════════════════════════════
section('validateConfig · 致命问题（必须拒绝启动）')
// ══════════════════════════════════════════════════════════════════════════
{
  const mk = (over) => normalizeConfig({ ...raw, ...over })

  const driveRoot = validateConfig(mk({ dsh: { ...raw.dsh, workspace: 'D:\\' } }))
  check('★ 工作区是盘符根 → 致命', driveRoot.fatal.some((f) => /盘符根/.test(f)), driveRoot.fatal.join(' | '))

  const homeDir = validateConfig(mk({ dsh: { ...raw.dsh, workspace: 'C:\\Users\\someone' } }))
  check('★ 工作区是用户主目录 → 致命', homeDir.fatal.some((f) => /用户主目录/.test(f)), homeDir.fatal.join(' | '))

  // ★ 工作区显式设为空串必须报致命 —— 而"没写"应该走默认值。
  // 这个区分很重要：如果两者混为一谈，"工作区不能为空"这条校验永远不会触发。
  const emptyWs = validateConfig(
    normalizeConfig({ ...raw, dsh: { ...raw.dsh, workspace: '' } }),
  )
  check('★ 工作区显式设为空串 → 致命（不能被默认值悄悄覆盖）',
    emptyWs.fatal.some((f) => /不能为空/.test(f)), emptyWs.fatal.join(' | ') || '（没有 fatal）')

  const unsetWs = validateConfig(normalizeConfig({ ...raw, dsh: { provider: 'x' } }))
  check('工作区没写 → 走默认值，不报致命',
    unsetWs.fatal.length === 0, unsetWs.fatal.join(' | '))

  const samePort = validateConfig(
    mk({ onebot: { ...raw.onebot, wsUrl: 'ws://127.0.0.1:3000', httpUrl: 'http://127.0.0.1:3000' } }),
  )
  check('★ ws 与 http 同端口 → 致命（这是最常见的配置错误）',
    samePort.fatal.some((f) => /同一个端口/.test(f)), samePort.fatal.join(' | '))

  const badUrl = validateConfig(mk({ onebot: { ...raw.onebot, wsUrl: 'not-a-url' } }))
  check('URL 非法 → 致命', badUrl.fatal.some((f) => /不是合法的 URL/.test(f)))

  const good = validateConfig(mk({ dsh: { ...raw.dsh, workspace: 'workspace-qq' } }))
  check('正确配置 → 没有致命问题', good.fatal.length === 0, good.fatal.join(' | '))
}

// ══════════════════════════════════════════════════════════════════════════
section('validateConfig · 必须给出的警告')
// ══════════════════════════════════════════════════════════════════════════
{
  const mk = (over) => normalizeConfig({ ...raw, ...over })

  const noAdmin = validateConfig(mk({ access: { adminUsers: [] } }))
  check('★ 管理员为空 → 警告（说明谁都不能用）',
    noAdmin.warn.some((w) => /没有人可以使用/.test(w)), noAdmin.warn.join(' | '))

  const oddAdmin = validateConfig(mk({ access: { adminUsers: ['abc'] } }))
  check('管理员号不像 QQ 号 → 警告', oddAdmin.warn.some((w) => /不像 QQ 号/.test(w)))

  const danger = validateConfig(mk({ dsh: { ...raw.dsh, permissionMode: 'danger-full-access' } }))
  check('★ 全权模式 → 警告（与"只限工作区"的决定冲突）',
    danger.warn.some((w) => /danger-full-access/.test(w)), danger.warn.join(' | '))

  const groupOn = validateConfig(mk({ trigger: { ...raw.trigger, groupEnabled: true } }))
  check('开启群聊 → 风险警告', groupOn.warn.some((w) => /群聊已开启/.test(w)), groupOn.warn.join(' | '))
  check('★ 警告里说明唤醒方式（只有 @ 与关键词，不会自动搭话）',
    groupOn.warn.some((w) => /被 @/.test(w) && /关键词/.test(w)), groupOn.warn.join(' | '))
  check('★ 关键词表为空时额外提醒（群聊就只剩 @ 一条路）',
    validateConfig(mk({ trigger: { ...raw.trigger, groupEnabled: true, keywords: [] } })).warn.some((w) =>
      /关键词表为空/.test(w),
    ))

  const humanizeOff = validateConfig(mk({ humanize: { enabled: false } }))
  check('★ 关掉人味层 → 警告（秒回是风控特征）',
    humanizeOff.warn.some((w) => /秒回/.test(w)), humanizeOff.warn.join(' | '))

  const badKeywords = validateConfig(mk({ trigger: { keywords: ['我', '哈哈'] } }))
  check('关键词体检结果被并入警告（单字/高频词）',
    badKeywords.warn.some((w) => /关键词告警/.test(w)), badKeywords.warn.filter((w) => /关键词/.test(w)).join(' | '))

  const noToken = validateConfig(mk({ onebot: { ...raw.onebot, wsToken: '', httpToken: '' } }))
  check('没有任何 accessToken → 警告', noToken.warn.some((w) => /accessToken/.test(w)))
}

// ══════════════════════════════════════════════════════════════════════════
section('唤醒策略（0.2.3）：二选一的默认值与"不许静默回落"')
// ══════════════════════════════════════════════════════════════════════════
{
  const mk = (over) => normalizeConfig({ ...raw, ...over })

  // ── 默认值：必须等于升级前的行为（零回归）─────────────────────────────
  const d = normalizeConfig({})
  check('★ wake.policy 默认 rule（= 升级前的行为：一次判定都不跑）', d.wake.policy === 'rule', d.wake.policy)
  check('★★ wake.judge.shadow 默认 **false**（判定真的生效 —— 0.2.3 用户决定）',
    d.wake.judge.shadow === false, String(d.wake.judge.shadow))
  check('★ wake.judge.transport 默认 http（直连：约 1 秒、一次小调用）',
    d.wake.judge.transport === 'http', d.wake.judge.transport)
  check('★ wake.judge.baseUrl 默认与 DSH 适配器一致，且**没有 /v1**',
    d.wake.judge.baseUrl === 'https://api.deepseek.com' && !d.wake.judge.baseUrl.includes('/v1'), d.wake.judge.baseUrl)
  check('★ wake.judge.model 默认空串（= 用 dsh.model，不配也能跑）', d.wake.judge.model === '', `「${d.wake.judge.model}」`)
  check('wake.judge.timeoutMs 默认 6000', d.wake.judge.timeoutMs === 6000, String(d.wake.judge.timeoutMs))
  check('wake.judge.maxPerHour 默认 60', d.wake.judge.maxPerHour === 60, String(d.wake.judge.maxPerHour))

  // ── 用户设的值必须真的生效 ────────────────────────────────────────────
  const c = mk({
    wake: {
      policy: 'semantic',
      judge: { shadow: true, timeoutMs: 2500, maxPerHour: 7, transport: 'headless', model: 'deepseek-v4-flash', baseUrl: 'https://llm.example.com' },
    },
  })
  check('wake.policy 生效', c.wake.policy === 'semantic', c.wake.policy)
  check('wake.judge.shadow=true 生效（想先观察的人设得回去）', c.wake.judge.shadow === true, String(c.wake.judge.shadow))
  check('wake.judge.timeoutMs 生效', c.wake.judge.timeoutMs === 2500, String(c.wake.judge.timeoutMs))
  check('wake.judge.maxPerHour 生效', c.wake.judge.maxPerHour === 7, String(c.wake.judge.maxPerHour))
  check('wake.judge.transport 生效', c.wake.judge.transport === 'headless', c.wake.judge.transport)
  check('wake.judge.model 生效', c.wake.judge.model === 'deepseek-v4-flash', c.wake.judge.model)
  check('wake.judge.baseUrl 生效', c.wake.judge.baseUrl === 'https://llm.example.com', c.wake.judge.baseUrl)

  // ★★ 未知取值**原样保留**：静默改成 rule 会让"我明明设了"变成最难查的一类问题
  const weird = mk({ wake: { policy: 'smart' } })
  check('★ 未知 wake.policy **不被静默改写**（保留原值交给校验报出来）', weird.wake.policy === 'smart', weird.wake.policy)
  check(
    '★ 未知 wake.policy → 明确警告（并说明它会退回规则唤醒）',
    validateConfig(weird).warn.some((w) => /wake\.policy/.test(w) && /不是有效值/.test(w)),
    validateConfig(weird).warn.join(' | '),
  )

  // ── semantic 的告警（都是"选了之后会变贵/会变哑"的如实告知）─────────────
  const sem = validateConfig(mk({ wake: { policy: 'semantic' } }))
  check(
    '★ semantic → 说清走哪条通路（默认直连，约 1 秒）',
    sem.warn.some((w) => /直连/.test(w) && /api\.deepseek\.com/.test(w)),
    sem.warn.filter((w) => /通路/.test(w)).join(' | '),
  )
  check(
    '★ semantic + shadow 默认(false) → 警告里明说"已经被判沉默的消息不会有任何提示"',
    sem.warn.some((w) => /已经生效/.test(w) && /不会有任何提示/.test(w)),
    sem.warn.filter((w) => /wake/.test(w)).join(' | '),
  )
  check(
    '★ 并给出稳妥路径（想先观察就把 shadow 设 true）',
    sem.warn.some((w) => /shadow/.test(w) && /只写 oplog|行为不变/.test(w)),
  )
  const semShadow = validateConfig(mk({ wake: { policy: 'semantic', judge: { shadow: true } } }))
  check(
    '★ semantic + shadow=true → 说清"行为一个字都没变"（这是观察模式）',
    semShadow.warn.some((w) => /行为一个字都没变/.test(w)),
    semShadow.warn.filter((w) => /shadow/.test(w)).join(' | '),
  )
  // ★ 通路写错一个字就会静默走另一条 —— 必须报（与"不静默回落"同一条纪律）
  const badTransport = validateConfig(mk({ wake: { policy: 'semantic', judge: { transport: 'http2' } } }))
  check('★ wake.judge.transport 写错 → 明确警告（并说明已按 http 处理）',
    badTransport.warn.some((w) => /transport/.test(w) && /不是有效值/.test(w)), badTransport.warn.join(' | '))
  check('  └ 这个检查在 policy=rule 时也照跑（配置错误与开不开语义模式无关）',
    validateConfig(mk({ wake: { judge: { transport: 'nope' } } })).warn.some((w) => /transport/.test(w)))
  check('  合法值 http / headless 不报',
    validateConfig(mk({ wake: { judge: { transport: 'http' } } })).warn.every((w) => !/transport/.test(w)) &&
      validateConfig(mk({ wake: { judge: { transport: 'headless' } } })).warn.every((w) => !/transport/.test(w)))
  // ★ "开了但其实没跑"要说出来 —— 但**只在配置层查得到的那一条**上查
  const headNoCli = validateConfig(
    normalizeConfig({ dsh: { cliPath: '' }, wake: { policy: 'semantic', judge: { transport: 'headless' } } }),
  )
  check('★★ headless 通路下 cliPath 为空 → 警告（否则判定器每一轮都白白放过）',
    headNoCli.warn.some((w) => /transport = headless/.test(w) && /cliPath/.test(w)), headNoCli.warn.join(' | '))
  check('  └ 并给出两条出路（配 cliPath / 改回 http）',
    headNoCli.warn.some((w) => /配好/.test(w) && /http/.test(w)))
  // ★★ 反面：**不查直连缺 key** —— key 可能只在 $DSH_HOME/.credentials.yaml 里
  //    （DSH 桌面版最常用的那种），校验层看不到那份文件，硬判就会对着一个
  //    完全正常的部署报假警告。那条由判定器自己的启动日志报（bridge.mjs）。
  //    这里断言"校验层不会因为缺 key 而误报"。
  const noKeyButHealthy = validateConfig(
    normalizeConfig({ dsh: { apiKey: '' }, wake: { policy: 'semantic' } }),
  )
  check('★★ 直连 + 没配 dsh.apiKey ⇒ 校验层**不报** key 的警告（key 可能在凭据文件里，硬判会误报）',
    noKeyButHealthy.warn.every((w) => !/API key/.test(w)), noKeyButHealthy.warn.join(' | '))
  check('  直连且 dsh.model 留空 ⇒ 归一化后仍有默认模型（所以这里也无需警告）',
    normalizeConfig({ dsh: { model: '' } }).dsh.model === 'deepseek-flash')
  // ★ 判定超时必须小于 interim（否则"先弹一句我在想，然后什么都没有"）
  const slowJudge = validateConfig(mk({ wake: { policy: 'semantic', judge: { timeoutMs: 9000 } } }))
  check(
    '★ 判定超时 ≥ interim.afterMs → 警告（否则会出现"我在想"然后什么都没有）',
    slowJudge.warn.some((w) => /timeoutMs/.test(w) && /interim/.test(w)),
    slowJudge.warn.filter((w) => /timeoutMs/.test(w)).join(' | '),
  )
  const zeroBudget = validateConfig(mk({ wake: { policy: 'semantic', judge: { maxPerHour: 0 } } }))
  check(
    '★ maxPerHour ≤ 0 → 警告（那等于语义唤醒完全没生效）',
    zeroBudget.warn.some((w) => /maxPerHour/.test(w) && /没生效/.test(w)),
    '',
  )
  check(
    'policy=rule 时不产生任何 wake 相关告警（默认路径必须安静）',
    validateConfig(mk({ wake: { policy: 'rule' } })).warn.every((w) => !/wake\./.test(w)),
    validateConfig(mk({ wake: { policy: 'rule' } })).warn.filter((w) => /wake\./.test(w)).join(' | '),
  )
}

// ══════════════════════════════════════════════════════════════════════════
section('本地语料库开关（0.2.3）：默认开（= 升级前的行为），关掉要说得清')
// ══════════════════════════════════════════════════════════════════════════
{
  const mk = (over) => normalizeConfig({ ...raw, ...over })

  check('★ corpus.enabled 默认 true（它 0.2.1 就在跑，加开关不许顺手收紧默认值）',
    normalizeConfig({}).corpus.enabled === true, String(normalizeConfig({}).corpus.enabled))
  check('  显式 false 生效（不是回落成 true —— 那会让"关了但还在写"）',
    mk({ corpus: { enabled: false } }).corpus.enabled === false)
  check('  显式 true 生效', mk({ corpus: { enabled: true } }).corpus.enabled === true)
  // 口径与 delivery.ledger / mcp.genericApi 一致：非布尔垃圾值按"开"处理（`!== false`）
  check('  写成别的值也按"开"处理（与 delivery.ledger 同一口径）',
    mk({ corpus: { enabled: 'no' } }).corpus.enabled === true, String(mk({ corpus: { enabled: 'no' } }).corpus.enabled))

  const off = validateConfig(mk({ corpus: { enabled: false } }))
  check('★ 关掉时给警告（否则使用者会对着工具报的"搜不了"去找别的原因）',
    off.warn.some((w) => /corpus\.enabled/.test(w)), off.warn.filter((w) => /corpus/.test(w)).join(' | '))
  check('  └ 警告里说清"当场拒绝"而不是"搜不到"（后者会被模型转述成谎话）',
    off.warn.some((w) => /当场拒绝/.test(w)))
  check('  └ 并说清**已有的库不会被删**（否则使用者不敢关）',
    off.warn.some((w) => /不会被删/.test(w)))
  check('  默认（开着）时**没有**语料库相关警告 —— 默认路径必须安静',
    validateConfig(normalizeConfig({})).warn.every((w) => !/corpus\./.test(w)))
}

console.log(`\n${failures === 0 ? '🎉 配置模块测试全部通过' : `⚠️ ${failures} 项失败`}\n`)
process.exit(failures === 0 ? 0 : 1)
