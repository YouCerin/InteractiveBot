#!/usr/bin/env node
/**
 * 体检工具自己的测试。
 *
 * ── 为什么要测一个"诊断工具" ───────────────────────────────────────────
 * 体检的价值全在**判断准不准**：
 *   · 漏报 → 你按"全部就绪"去启动，然后在 QQ 里对着空气等
 *   · 误报 → 你花时间去修一个根本不存在的问题
 * 两种都比没有体检更糟。所以这里给体检喂**故意配错**的配置，看它是否
 * 真的报出来；也喂正确的配置，看它是否**不**乱报。
 *
 * 用法：node mocks/verify-doctor.mjs
 */

import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDoctor, printDoctor } from '../src/doctor.mjs'
import { resolveInPackage, DIRS, findDshCliWithSource, readSearchPathsFromConfig } from '../src/local.mjs'
import { startMockOneBot } from './mock-onebot-server.mjs'

/** 包根（`packages/qq-bridge`）—— CLI 接线守卫要读 `src/index.mjs`。 */
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const WS_DIR = join(DIRS.vendor, '..', '.tmp-verify-doctor')

/**
 * 基线配置里"DSH 装在哪儿"该填什么。
 *
 * 为什么不让它留空去自动发现：自动发现只认**通用**位置（vendor/dsh、
 * Program Files、%LOCALAPPDATA%），而 DSH 完全可能装在别的盘 —— 这不是缺陷，
 * 是"本包不分发 DSH"的必然结果。体检的用例想验的是"配置正确时它不乱报"，
 * 所以这里把**本机真实能找到的那个安装根**喂给它（找不到就留空，
 * 那条用例会如实变红，而不是假装通过）。
 */
function dshSearchPathsForFixture() {
  const found = findDshCliWithSource({ searchPaths: readSearchPathsFromConfig('dsh.searchPaths') })
  if (!found) return []
  // cliPath 形如 <安装根>/node_modules/@deepseek-ai/dsh/lib/bin.js
  const marker = `${join('node_modules', '@deepseek-ai', 'dsh')}`
  const idx = found.cliPath.indexOf(marker)
  return idx > 0 ? [found.cliPath.slice(0, idx)] : []
}

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

/** 造一份基线配置（全部正确），再按需破坏其中某一项。 */
function makeConfig(overrides = {}) {
  const base = {
    dsh: {
      cliPath: undefined, // 让 doctor 自己去找
      // ★ 带上本机真实的安装根候选（见 dshSearchPathsForFixture 的说明）
      searchPaths: dshSearchPathsForFixture(),
      workspace: WS_DIR,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      permissionMode: 'workspace-write',
    },
    onebot: {
      wsUrl: 'ws://127.0.0.1:3160',
      httpUrl: 'http://127.0.0.1:3160',
      wsToken: 'good-ws',
      httpToken: 'good-http',
      selfId: null,
    },
    access: { adminUsers: ['100000001'] },
    trigger: { private: true, mention: true, keyword: true, groupEnabled: false, keywords: ['小鲸鱼'] },
    send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 8, maxPerHour: 500, dedupeWindowMs: 0, maxCharsPerMessage: 1500 },
    turn: { timeoutMs: 5000 },
    session: { salt: 'doctor-salt' },
    persona: { callerName: '' },
  }
  return {
    ...base,
    ...overrides,
    dsh: { ...base.dsh, ...(overrides.dsh ?? {}) },
    onebot: { ...base.onebot, ...(overrides.onebot ?? {}) },
    access: { ...base.access, ...(overrides.access ?? {}) },
    trigger: { ...base.trigger, ...(overrides.trigger ?? {}) },
  }
}

/** doctor 需要的 validate 桩：这里用真实校验规则的最小版。 */
function makeValidate() {
  return (config) => {
    const fatal = []
    const warn = []
    if (!config.dsh.workspace) fatal.push('dsh.workspace 不能为空')
    if (config.access.adminUsers.length === 0) warn.push('ADMIN_EMPTY')
    if (config.dsh.permissionMode === 'danger-full-access') warn.push('DANGER_MODE')
    return { fatal, warn }
  }
}

const rowOf = (result, name) => result.rows.find((r) => r.name === name)

/** 模拟协议端把 HTTP 与 WS 放在同一端口，所以期望端口都是 3160。 */
const PORTS = { expectedHttpPort: 3160, expectedWsPort: 3160 }

async function main() {
  rmSync(WS_DIR, { recursive: true, force: true })
  mkdirSync(WS_DIR, { recursive: true })

  // 起一个模拟协议端，token 与基线配置一致
  const server = await startMockOneBot({ httpPort: 3160, wsToken: 'good-ws', httpToken: 'good-http' })

  // ══════════════════════════════════════════════════════════════════════
  section('用例 1：全部正确时，不应该乱报错')
  // ══════════════════════════════════════════════════════════════════════
  {
    const result = await runDoctor({ config: makeConfig(), validate: makeValidate(), ...PORTS })
    check('没有致命问题', result.fatal.length === 0, result.fatal.join(' | '))
    check('HTTP 探测成功', rowOf(result, 'HTTP API（发送通道）')?.ok === true,
      rowOf(result, 'HTTP API（发送通道）')?.detail)
    check('WebSocket 探测成功', rowOf(result, 'WebSocket（事件通道）')?.ok === true,
      rowOf(result, 'WebSocket（事件通道）')?.detail)
    check('管理员白名单被判定为已配置', rowOf(result, '管理员白名单')?.ok === true)
    check('权限模式被判定为合规', rowOf(result, '权限模式')?.ok === true)
    check('端口核对通过', rowOf(result, 'OneBot 端口')?.ok === true, rowOf(result, 'OneBot 端口')?.detail)
    check('★ 正确配置下没有任何 ❌', result.rows.filter((r) => !r.ok).length === 0,
      result.rows.filter((r) => !r.ok).map((r) => r.name).join(', '))
  }

  // ══════════════════════════════════════════════════════════════════════
  section('用例 2：HTTP token 填错 → 必须报出来（这是最常见的坑）')
  // ══════════════════════════════════════════════════════════════════════
  {
    // 用纯 ASCII 的错误 token，模拟"复制错了"（而不是"粘进了中文"）
    const result = await runDoctor({
      config: makeConfig({ onebot: { httpToken: 'wrong-but-ascii' } }),
      validate: makeValidate(),
      ...PORTS,
    })
    const row = rowOf(result, 'HTTP API（发送通道）')
    check('HTTP 探测失败被报出', row?.ok === false, row?.detail)
    check('错误信息里带 HTTP 状态码（便于判断是 401）', /HTTP \d{3}/.test(row?.detail ?? ''), row?.detail)
  }

  // ══════════════════════════════════════════════════════════════════════
  section('用例 2b：token 里混进中文 → 必须给"人话"诊断，而不是底层报错')
  // ══════════════════════════════════════════════════════════════════════
  {
    // 这是真实会发生的事：从网页复制 token 时带进了全角标点。
    // 底层会抛 "Cannot convert argument to a ByteString..."，用户完全看不懂。
    const result = await runDoctor({
      config: makeConfig({ onebot: { httpToken: '错误的token', wsToken: '错误的token' } }),
      validate: makeValidate(),
      ...PORTS,
    })
    const httpRow = rowOf(result, 'HTTP API（发送通道）')
    const wsRow = rowOf(result, 'WebSocket（事件通道）')
    check('HTTP 探测给出非 ASCII 诊断', /非 ASCII/.test(httpRow?.detail ?? ''), httpRow?.detail)
    check('WebSocket 探测给出非 ASCII 诊断', /非 ASCII/.test(wsRow?.detail ?? ''), wsRow?.detail)
    check(
      '★ 诊断里指明了是第几个字符、什么字符（可直接定位）',
      /第 \d+ 个字符/.test(httpRow?.detail ?? '') && /U\+/.test(httpRow?.detail ?? ''),
      httpRow?.detail,
    )
    check(
      '★ 不再出现看不懂的底层报错',
      !/ByteString|Invalid character in header/.test(`${httpRow?.detail}${wsRow?.detail}`),
    )
  }

  // ══════════════════════════════════════════════════════════════════════
  section('用例 3：WebSocket token 填错 → 必须报出握手被拒')
  // ══════════════════════════════════════════════════════════════════════
  {
    const result = await runDoctor({
      config: makeConfig({ onebot: { wsToken: 'wrong-but-ascii' } }),
      validate: makeValidate(),
      ...PORTS,
    })
    const row = rowOf(result, 'WebSocket（事件通道）')
    check('WebSocket 探测失败被报出', row?.ok === false, row?.detail)
    check(
      '明确指出可能是 wsToken 问题（或给出 close code）',
      /wsToken|401|403|4401|4403/.test(row?.detail ?? ''),
      row?.detail,
    )
  }

  // ══════════════════════════════════════════════════════════════════════
  section('用例 4：协议端没启动 → 报"连不上"，并给出可执行建议')
  // ══════════════════════════════════════════════════════════════════════
  {
    const result = await runDoctor({
      config: makeConfig({ onebot: { wsUrl: 'ws://127.0.0.1:3199', httpUrl: 'http://127.0.0.1:3199' } }),
      validate: makeValidate(),
    })
    check('HTTP 报连不上', rowOf(result, 'HTTP API（发送通道）')?.ok === false)
    check('WebSocket 报连不上', rowOf(result, 'WebSocket（事件通道）')?.ok === false)
    check(
      '★ 给出可执行建议（先启动 SnowLuma 并扫码）',
      result.warn.some((w) => /SnowLuma|扫码|启动/.test(w)),
      result.warn.join(' | '),
    )
  }

  // ══════════════════════════════════════════════════════════════════════
  section('用例 5：端口期望不匹配 → 精确提示')
  // ══════════════════════════════════════════════════════════════════════
  {
    // 配置指向了错误的 WS 端口（3199 而不是 3160）：端口核对应报出来
    const result = await runDoctor({
      config: makeConfig({ onebot: { wsUrl: 'ws://127.0.0.1:3199' } }),
      validate: makeValidate(),
      ...PORTS,
    })
    const portRow = rowOf(result, 'OneBot 端口')
    check('端口不匹配被报出', portRow?.ok === false, portRow?.detail)
    check('提示里写明了期望端口', /期望 3160/.test(portRow?.detail ?? ''), portRow?.detail)
    check('WebSocket 因端口错误而连不上', rowOf(result, 'WebSocket（事件通道）')?.ok === false)
  }

  // ══════════════════════════════════════════════════════════════════════
  section('用例 5b：wsUrl 协议写错（用 http:// 当事件通道）→ 明确提示')
  // ══════════════════════════════════════════════════════════════════════
  {
    const result = await runDoctor({
      config: makeConfig({ onebot: { wsUrl: 'http://127.0.0.1:3160' } }),
      validate: makeValidate(),
    })
    const row = rowOf(result, 'WebSocket（事件通道）')
    check('协议错误被报出', row?.ok === false, row?.detail)
    check('★ 明确指出应该是 ws:// 或 wss://', /ws:\/\/|wss:\/\//.test(row?.detail ?? ''), row?.detail)
  }

  // ══════════════════════════════════════════════════════════════════════
  section('用例 6：配置类问题（不依赖网络）')
  // ══════════════════════════════════════════════════════════════════════
  {
    const r1 = await runDoctor({ config: makeConfig({ access: { adminUsers: [] } }), validate: makeValidate() })
    check('管理员为空被报出', rowOf(r1, '管理员白名单')?.ok === false, rowOf(r1, '管理员白名单')?.detail)
    check('提示里说明"谁都不能用"', /谁都不能用|fail-closed/.test(rowOf(r1, '管理员白名单')?.detail ?? ''))

    const r2 = await runDoctor({
      config: makeConfig({ dsh: { permissionMode: 'danger-full-access' } }),
      validate: makeValidate(),
    })
    check('全权模式被标为不合规（与既定决策冲突）', rowOf(r2, '权限模式')?.ok === false,
      rowOf(r2, '权限模式')?.detail)

    const r3 = await runDoctor({
      config: makeConfig({ trigger: { groupEnabled: true } }),
      validate: makeValidate(),
    })
    // ⚠️ 语义在实机测试报告 BUG-7 之后改了：群聊开着是**风险提示**，不是故障。
    // 旧断言（ok === false）会让"默认配置的机器"一律在体检末尾看到 ❌ 与
    // 「能启动，但上面有 ❌ 项需要处理」—— 用户以为程序坏了。
    check('开启群聊被标为 ⚠️ 提醒（ok 仍为 true，不计入故障）',
      rowOf(r3, '群聊开关')?.ok === true && rowOf(r3, '群聊开关')?.level === 'warn',
      `ok=${rowOf(r3, '群聊开关')?.ok} level=${rowOf(r3, '群聊开关')?.level}`)
    check('提醒文字说明了风险与关闭方法',
      /风控风险/.test(rowOf(r3, '群聊开关')?.detail ?? '') && /groupEnabled/.test(rowOf(r3, '群聊开关')?.detail ?? ''),
      rowOf(r3, '群聊开关')?.detail)

    const r4 = await runDoctor({
      config: makeConfig({ onebot: { wsToken: '', httpToken: '' } }),
      validate: makeValidate(),
    })
    check('token 为空被报出', rowOf(r4, 'accessToken 是否都已配置')?.ok === false)

    const r5 = await runDoctor({ config: makeConfig({ dsh: { workspace: '' } }), validate: makeValidate() })
    check('工作区为空产生致命问题', r5.fatal.length > 0, r5.fatal.join(' | '))
  }

  // ══════════════════════════════════════════════════════════════════════
  section('用例 7：工作区可写性真的被探测（不是看权限位）')
  // ══════════════════════════════════════════════════════════════════════
  {
    const result = await runDoctor({ config: makeConfig(), validate: makeValidate(), ...PORTS })
    const row = rowOf(result, '工作区（权限沙箱的根）')
    check('工作区被判为可用', row?.ok === true, row?.detail)
  }

  // ══════════════════════════════════════════════════════════════════════
  section('用例 8：★ CLI 接线守卫（`--doctor` 曾经一跑就崩）')
  // ══════════════════════════════════════════════════════════════════════
  {
    // 真机事故（2026-10-01 排查"bot 为什么不可用"时撞上）：
    //   `src/index.mjs` 里 `runDoctor({ config, validate, processes: … })` 写的是**裸的
    //   `validate`** —— 那个名字在该作用域里根本不存在 ⇒ `--doctor` 直接
    //   `ReferenceError: validate is not defined`。而 `--doctor` 是本项目最主要的排查入口
    //   （README / RELEASE.md / start.bat 都指向它），它坏了等于"唯一的听诊器坏了"，
    //   而且**看起来像机器人自己坏了**。存在了 5 天没人发现，原因就是本节要补的那个洞：
    //   上面的用例**全部直接调 `runDoctor(...)`**，从不走 CLI 那条路径 ——
    //   又一次"纯函数测试看不见接线"。
    //
    // ⚠️ 这是**文本守卫**，不是行为断言（真正的行为验证是 `node src/index.mjs --doctor`
    //   跑一遍；它要连真协议端，不适合放进离线套件）。它的职责只有一个：
    //   盯住"这个对象字面量有没有显式把 validate 传进去"。宁可要一道窄的守卫，
    //   也不要"再也不会有人踩"的错觉 —— 所以注释里写明它的边界。
    const indexSrc = readFileSync(join(PKG_ROOT, 'src', 'index.mjs'), 'utf8')
    const calls = [...indexSrc.matchAll(/runDoctor\(\{([\s\S]{0,240}?)\}\)/g)].map((m) => m[1])
    check('★ 找到了 runDoctor 的调用点（守卫本身没失效）', calls.length >= 2, `calls=${calls.length}`)
    const missing = calls.filter((c) => !/\bvalidate\s*:/.test(c))
    check(
      '★★ index.mjs 里每处 runDoctor(...) 都**显式传了 `validate:`**'
        + '（漏了就是 `--doctor` 一跑就 ReferenceError）',
      missing.length === 0,
      missing.length ? JSON.stringify(missing) : `（${calls.length} 处都传了）`,
    )
    check(
      '★ 且没有裸的 `validate` 简写（那个标识符在这个作用域里不存在）',
      !/[{,]\s*validate\s*[,}]/.test(indexSrc),
      '',
    )
  }

  // ══════════════════════════════════════════════════════════════════════
  section('用例 9：★ 其它插件的登记不能被算成"多余的桥接"（实机 BUG-6）')
  // ══════════════════════════════════════════════════════════════════════
  {
    // 真机事故（2026-10-03 实机测试报告 BUG-6）：
    //   同一张进程登记表里还躺着 SnowLuma 与 chat-review 的条目，而旧代码写的是
    //   `running.filter(p => !p.isSelf)` —— 于是体检在一台**完全正常**的机器上报
    //   ❌「还有 2 个在跑」并叫用户去 `--kill` 它们。照做就会把协议端和审核台杀掉。
    //   判定口径必须只看 `profile === 'bridge'`（见 process-guard.runningBridges）。
    const threeProcs = [
      { profile: 'bridge', state: 'alive', pid: 100, isSelf: true, reason: null },
      { profile: 'snowluma', state: 'alive', pid: 200, reason: null },
      { profile: 'chat-review', state: 'alive', pid: 300, reason: null },
    ]
    const mixed = await runDoctor({
      config: makeConfig(),
      validate: makeValidate(),
      processes: threeProcs,
    })
    const bridgeRow = rowOf(mixed, '同时运行的桥接数量')
    check('★ 一个桥接 + 两个其它插件 → 不报警', bridgeRow?.ok === true, bridgeRow?.detail)
    check('★ 不再给出"去 kill 多余进程"的错误建议', !/--kill/.test(bridgeRow?.detail ?? ''), bridgeRow?.detail)
    const otherRow = rowOf(mixed, '其它插件的登记（不算桥接）')
    check('非桥接登记单独成行（供参考，永不算故障）', otherRow?.ok === true, otherRow?.detail)
    check('该行点名了 profile，便于人对号入座',
      /snowluma/.test(otherRow?.detail ?? '') && /chat-review/.test(otherRow?.detail ?? ''),
      otherRow?.detail)

    // 真有两个桥接在跑 = 真冲突，这时**必须**报 ❌ 并给 kill 建议
    const conflict = await runDoctor({
      config: makeConfig(),
      validate: makeValidate(),
      processes: [
        { profile: 'bridge', state: 'alive', pid: 100, isSelf: true, reason: null },
        { profile: 'bridge', state: 'alive', pid: 101, reason: null },
        { profile: 'snowluma', state: 'alive', pid: 200, reason: null },
      ],
    })
    const conflictRow = rowOf(conflict, '同时运行的桥接数量')
    check('两个桥接在跑 → 报 ❌', conflictRow?.ok === false, conflictRow?.detail)
    check('且给出可执行的处置建议', /--processes --kill/.test(conflictRow?.detail ?? ''), conflictRow?.detail)

    // ★ CLI 视角：`--processes` 是**另一个进程**，`isSelf` 恒为 false。
    //   旧写法会把唯一那条在跑的桥接算成"其它"，报「有 1 个在跑」并教你杀掉它。
    //   正确口径按**数量**：1 条 = 正常。
    const cliView = await runDoctor({
      config: makeConfig(),
      validate: makeValidate(),
      processes: [{ profile: 'bridge', state: 'alive', pid: 100, reason: null }],
    })
    const cliRow = rowOf(cliView, '同时运行的桥接数量')
    check('★ CLI 视角下唯一那条桥接不算冲突（isSelf 恒为 false 的坑）',
      cliRow?.ok === true, cliRow?.detail)
    check('并且说明了这是正常的 1 个', /1 个/.test(cliRow?.detail ?? ''), cliRow?.detail)

    const none = await runDoctor({
      config: makeConfig(),
      validate: makeValidate(),
      processes: [{ profile: 'snowluma', state: 'alive', pid: 200, reason: null }],
    })
    check('一个桥接都没有时也不报错（只是如实说明）',
      rowOf(none, '同时运行的桥接数量')?.ok === true,
      rowOf(none, '同时运行的桥接数量')?.detail)
  }

  // ══════════════════════════════════════════════════════════════════════
  section('用例 10：★ ⚠️ 提醒必须看得见，且不能污染"全部就绪"（实机 BUG-7）')
  // ══════════════════════════════════════════════════════════════════════
  {
    // 打印层与判定层是两件事：判定层（上面的 ok/level）说"不是故障"，
    // 但打印层如果只按 ok 渲染，这一行就会和"一切正常"长得一模一样 —— 提示等于没写。
    // 这里直接把 printDoctor 的 stdout 抓下来看它到底印了什么。
    const result = await runDoctor({
      config: makeConfig({ trigger: { groupEnabled: true } }),
      validate: makeValidate(),
    })
    const lines = []
    const realLog = console.log
    console.log = (...args) => lines.push(args.join(' '))
    let allOk
    try {
      allOk = printDoctor(result)
    } finally {
      console.log = realLog
    }
    const text = lines.join('\n')
    check('★ 提醒行渲染成 ⚠️ 而不是 ✅', /⚠️ 群聊开关/.test(text), text.split('\n').find((l) => l.includes('群聊开关')))
    check('★ 提醒行不会被渲染成 ❌', !/❌ 群聊开关/.test(text))
    check('ok 语义不变：没有故障 → allOk 仍为 true（退出码 0）', allOk === true)
    check('★ 结论句承认"有提醒"，不再只说"全部就绪"',
      /全部就绪（有 \d+ 项提醒/.test(text), lines[lines.length - 1])
    check('提醒行本身不出现在"必须修复"一节里', !/必须修复[\s\S]*群聊开关/.test(text))
  }

  await server.close()
  rmSync(WS_DIR, { recursive: true, force: true })

  console.log(`\n${failures === 0 ? '🎉 体检工具验证通过' : `⚠️ ${failures} 项失败`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('验证脚本自身崩了：', error)
  process.exit(1)
})
