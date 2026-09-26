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

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runDoctor } from '../src/doctor.mjs'
import { resolveInPackage, DIRS, findDshCliWithSource, readSearchPathsFromConfig } from '../src/local.mjs'
import { startMockOneBot } from './mock-onebot-server.mjs'

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
    check('开启群聊被标出（有风控风险）', rowOf(r3, '群聊开关')?.ok === false)

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

  await server.close()
  rmSync(WS_DIR, { recursive: true, force: true })

  console.log(`\n${failures === 0 ? '🎉 体检工具验证通过' : `⚠️ ${failures} 项失败`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('验证脚本自身崩了：', error)
  process.exit(1)
})
