#!/usr/bin/env node
/**
 * token 同步（实机 BUG-2）的测试。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套盯的是什么
 * ══════════════════════════════════════════════════════════════════════════
 * 事故形态：`resolveOnebotTokens()` 判定得完全正确，但**没有任何人把结果交给建连**，
 * 于是客户端拿着 `config.json` 里的空 token 去连，两个通道同时 401，
 * 而日志还在说"来源：SnowLuma 自己的配置（…与 config.json 一致）"。
 *
 * 所以这里除了判定的纯函数，还特意钉了三条**接线**断言（第 ⑦ 节）：
 *   ① `applyOnebotTokens(...)` 必须出现在 `new OneBotClient(...)` **之前**
 *      （顺序反了 = 判定结果又被丢掉，正是这次事故）；
 *   ② 必须调用 `persistOnebotTokens(...)`（不写回，界面与 --doctor 会一直说"没配 token"）；
 *   ③ 那句误导人的「与 config.json 一致」不许再出现在 `src/index.mjs` 里。
 *
 * 用法：node mocks/verify-token-sync.mjs
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  applyOnebotTokens,
  isDeterministicPick,
  persistOnebotTokens,
  planTokenSync,
  syncOnebotTokens,
} from '../src/token-sync.mjs'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TMP = mkdtempSync(join(tmpdir(), 'verify-token-sync-'))

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

/** 把 config.example.json 复制成一份"用户机器上的 config.json"（token 为空）。 */
function freshConfig(overrides = {}) {
  const path = join(TMP, `config-${Math.random().toString(36).slice(2, 8)}.json`)
  const base = JSON.parse(readFileSync(join(PKG_ROOT, 'config.example.json'), 'utf8'))
  const cfg = { ...base, ...overrides, onebot: { ...base.onebot, ...(overrides.onebot ?? {}) } }
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  return { path, raw: cfg }
}

/** 收集 log 输出，便于断言"说了什么、没说什么"。 */
function collector() {
  const lines = []
  const log = (m) => lines.push(String(m))
  return { lines, log, text: () => lines.join('\n') }
}

const TOKENS = {
  wsToken: 'WS-SECRET-1',
  httpToken: 'HTTP-SECRET-2',
  source: 'SnowLuma 自己的配置',
  picked: 'matched-config:onebot_10001.json',
  accounts: ['onebot_10001.json'],
  differsFromConfig: true,
}

async function main() {
  // ══════════════════════════════════════════════════════════════════════
  section('① 判定：什么算"确定无疑"（安全底线：宁可连不上，也不接错账号）')
  // ══════════════════════════════════════════════════════════════════════
  {
    check('explicit-selfId（配置里写死了自己的 QQ）→ 确定性',
      isDeterministicPick({ picked: 'explicit-selfId', accounts: ['a', 'b'] }) === true)
    check('matched-config（与 config.json 里那份对得上）→ 确定性',
      isDeterministicPick({ picked: 'matched-config:onebot_1.json', accounts: ['a', 'b'] }) === true)
    check('★ auto-newest 且**只有一个**账号 → 确定性（没有第二种选择）',
      isDeterministicPick({ picked: 'auto-newest:onebot_1.json', accounts: ['onebot_1.json'] }) === true)
    check('★★ auto-newest 但**有多个**账号 → **不**确定（只按 mtime 挑会挑到别人的号）',
      isDeterministicPick({ picked: 'auto-newest:onebot_2.json', accounts: ['onebot_1.json', 'onebot_2.json'] }) === false)
    check('ambiguous → 不确定', isDeterministicPick({ picked: 'ambiguous', accounts: ['a', 'b'] }) === false)
    check('none → 不确定', isDeterministicPick({ picked: 'none', accounts: [] }) === false)
    check('未知取值 → 不确定（宁可不动手）', isDeterministicPick({ picked: 'something-new' }) === false)
  }

  // ══════════════════════════════════════════════════════════════════════
  section('② planTokenSync：四种结论')
  // ══════════════════════════════════════════════════════════════════════
  {
    const emptyCfg = { onebot: { wsToken: '', httpToken: '' } }
    check('两侧都解析到了、且与运行期不同 → 接 + 写回',
      planTokenSync({ config: emptyCfg, tokens: TOKENS }).reason === 'differs' &&
        planTokenSync({ config: emptyCfg, tokens: TOKENS }).apply === true &&
        planTokenSync({ config: emptyCfg, tokens: TOKENS }).persist === true)
    check('与运行期一致 → 不动（reason=same）',
      planTokenSync({
        config: { onebot: { wsToken: TOKENS.wsToken, httpToken: TOKENS.httpToken } },
        tokens: TOKENS,
      }).reason === 'same')
    check('★ 只解析到一侧 → 不动（半套 token 会把原本能用的一侧也弄坏）',
      planTokenSync({ config: emptyCfg, tokens: { ...TOKENS, httpToken: '' } }).reason === 'empty')
    check('★ 多种可能（多账号）→ 不动（reason=ambiguous）',
      planTokenSync({
        config: emptyCfg,
        tokens: { ...TOKENS, picked: 'auto-newest:onebot_2.json', accounts: ['onebot_1.json', 'onebot_2.json'] },
      }).reason === 'ambiguous')
  }

  // ══════════════════════════════════════════════════════════════════════
  section('③ applyOnebotTokens：真的接到运行期配置上')
  // ══════════════════════════════════════════════════════════════════════
  {
    const { lines, log, text } = collector()
    const config = { onebot: { wsToken: '', httpToken: '', wsUrl: 'ws://x', selfId: null } }
    const r = applyOnebotTokens({ config, tokens: TOKENS, log })
    check('★ 接上了（applied=true）', r.applied === true, JSON.stringify(r))
    check('★★ 运行期配置里的两个 token 都被替换（这是事故的正面断言）',
      config.onebot.wsToken === TOKENS.wsToken && config.onebot.httpToken === TOKENS.httpToken)
    check('  其余字段没被动过（wsUrl / selfId 原样）',
      config.onebot.wsUrl === 'ws://x' && config.onebot.selfId === null)
    check('  日志说了来源与账号', /来源.*SnowLuma/.test(text()) && /matched-config/.test(text()), lines.join(' | '))
    check('★★ 日志里**不许**出现 token 本身', !text().includes(TOKENS.wsToken) && !text().includes(TOKENS.httpToken))

    const c2 = collector()
    const ambiguous = { onebot: { wsToken: '', httpToken: '' } }
    const r2 = applyOnebotTokens({
      config: ambiguous,
      tokens: { ...TOKENS, picked: 'auto-newest:onebot_2.json', accounts: ['onebot_1.json', 'onebot_2.json'] },
      log: c2.log,
    })
    check('★ 多账号时**不接**（applied=false）', r2.applied === false, JSON.stringify(r2))
    check('  配置保持原样（没有偷偷改）', ambiguous.onebot.wsToken === '' && ambiguous.onebot.httpToken === '')
    check('★ 警告里给了两条可执行出路（写 selfId / 填 token）',
      /selfId/.test(c2.text()) && /config\.json/.test(c2.text()), c2.text())
    check('★ 警告里点名了候选账号（人能对号入座）', /onebot_1\.json/.test(c2.text()))
    check('★★ 警告里**没有** token 值', !c2.text().includes(TOKENS.wsToken) && !c2.text().includes(TOKENS.httpToken))
  }

  // ══════════════════════════════════════════════════════════════════════
  section('④ persistOnebotTokens：按 /api/config 的纪律写回')
  // ══════════════════════════════════════════════════════════════════════
  {
    const { path } = freshConfig()
    const before = readFileSync(path, 'utf8')
    const { lines, log } = collector()
    const r = persistOnebotTokens({ configPath: path, tokens: TOKENS, log })
    const after = readFileSync(path, 'utf8')
    const parsed = JSON.parse(after)
    check('写成功（saved=true）', r.saved === true, JSON.stringify(r))
    check('★ config.json 里的 token 被写进去了', parsed.onebot.wsToken === TOKENS.wsToken && parsed.onebot.httpToken === TOKENS.httpToken)
    check('★ 备份出来了 config.json.bak，且内容 = 写之前的原文',
      existsSync(`${path}.bak`) && readFileSync(`${path}.bak`, 'utf8') === before)
    check('  其它字段原样保留（不是"只写 token 的新文件"）',
      parsed.ui?.apiPort === JSON.parse(before).ui?.apiPort && parsed.dsh?.permissionMode === 'workspace-write')
    check('  落盘格式与 /api/config 一致（2 空格缩进 + 结尾换行）', after.endsWith('\n') && after.includes('\n  "'))
    check('  日志里说清了已写回、且**不含** token 值',
      /已同步写回 config\.json/.test(lines.join(' | ')) && !lines.join('').includes(TOKENS.wsToken))

    // 幂等：已经一致时不再写（否则每次启动都改一次文件时间戳、还多一次 .bak 覆盖）
    const stamp = readFileSync(path, 'utf8')
    const again = persistOnebotTokens({ configPath: path, tokens: TOKENS, log: () => {} })
    check('★ 已经一致 → 不重复写（reason=already）', again.saved === false && again.reason === 'already', JSON.stringify(again))
    check('  文件内容一字未动', readFileSync(path, 'utf8') === stamp)
  }

  // ══════════════════════════════════════════════════════════════════════
  section('⑤ persistOnebotTokens：拒绝写坏配置 / 出错不崩')
  // ══════════════════════════════════════════════════════════════════════
  {
    // 致命项（工作区为空）→ **绝不落盘**：宁可这次运行用接上的 token，也不写一个起不来的配置
    const { path } = freshConfig({ dsh: { workspace: '' } })
    const before = readFileSync(path, 'utf8')
    const { lines, log } = collector()
    const r = persistOnebotTokens({ configPath: path, tokens: TOKENS, log })
    check('★ 校验有致命项 → 不写（reason=invalid）', r.saved === false && r.reason === 'invalid', JSON.stringify(r))
    check('  文件保持原样（没有半成品配置）', readFileSync(path, 'utf8') === before)
    check('  如实报出为什么不写', /不合法|已跳过/.test(lines.join(' | ')), lines.join(' | '))

    const missing = persistOnebotTokens({ configPath: join(TMP, 'nope', 'config.json'), tokens: TOKENS, log: () => {} })
    check('★ 读不到文件 → 不崩，返回 unreadable', missing.saved === false && missing.reason === 'unreadable', JSON.stringify(missing))

    const noPath = persistOnebotTokens({ configPath: null, tokens: TOKENS, log: () => {} })
    check('  没有路径 → 直接跳过（no-path）', noPath.reason === 'no-path')

    const half = persistOnebotTokens({ configPath: join(TMP, 'x.json'), tokens: { wsToken: 'a', httpToken: '' }, log: () => {} })
    check('  半套 token → 不写（empty）', half.reason === 'empty')
  }

  // ══════════════════════════════════════════════════════════════════════
  section('⑥ syncOnebotTokens：两步编排')
  // ══════════════════════════════════════════════════════════════════════
  {
    const { path } = freshConfig()
    const config = { onebot: { wsToken: '', httpToken: '' } }
    const r = syncOnebotTokens({ config, tokens: TOKENS, configPath: path, log: () => {} })
    check('接上 + 写回都做了', r.applied === true && r.saved === true, JSON.stringify(r))
    check('运行期与磁盘现在一致',
      config.onebot.wsToken === TOKENS.wsToken &&
        JSON.parse(readFileSync(path, 'utf8')).onebot.wsToken === TOKENS.wsToken)

    // ★ 端到端：写回之后再"重启"，解析结果与配置一致 ⇒ 不再改动、也不再误报"不一致"
    const reloaded = JSON.parse(readFileSync(path, 'utf8'))
    const second = resolveLike({
      wsToken: reloaded.onebot.wsToken,
      httpToken: reloaded.onebot.httpToken,
      picked: 'matched-config:onebot_10001.json',
      accounts: ['onebot_10001.json'],
    })
    check('★ 重启后 plan 变成 same（不再无谓写盘、也不再报"不一致"）',
      second.reason === 'same', JSON.stringify(second))
  }

  // ══════════════════════════════════════════════════════════════════════
  section('⑦ ★ 接线守卫：解析结果必须真的流到建连处（这次事故的本质）')
  // ══════════════════════════════════════════════════════════════════════
  {
    const src = readFileSync(join(PKG_ROOT, 'src', 'index.mjs'), 'utf8')
    const atApply = src.indexOf('applyOnebotTokens(')
    const atClient = src.indexOf('new OneBotClient(')
    check('  找得到两个关键位置（守卫本身没失效）', atApply > 0 && atClient > 0, `apply@${atApply} client@${atClient}`)
    check('★★ `applyOnebotTokens(...)` 排在 `new OneBotClient(...)` **之前**'
      + '（顺序反了 = 判定结果又被丢掉，就是 BUG-2）',
      atApply > 0 && atClient > 0 && atApply < atClient, `apply@${atApply} client@${atClient}`)
    check('★ 也调用了 `persistOnebotTokens(...)`（不写回，界面与 --doctor 会一直说"没配 token"）',
      src.includes('persistOnebotTokens('))
    // 只看**代码行**：注释里正当地引用了那句旧文案（"这句话以前写过…"），
    // 那是留给下一个人的事故记录，不该被这条守卫误伤。
    const codeLines = src
      .split(/\r?\n/)
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    check('★★ 误导人的「与 config.json 一致」已从启动日志里删掉'
      + '（它的判据是"两边都非空且不同"，"我们这边是空的"会走成"一切正常"）',
      !/与 config\.json 一致/.test(codeLines))
    check('★ 启动时会把"两个 token 都是空的"如实说出来（不再沉默地空手去连）',
      /两个 token 都是空的/.test(src))
  }

  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? '🎉 token 同步验证通过' : `⚠️ ${failures} 项失败`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

/** 小助手：模拟"重启后重新解析"的结论（复用被测的纯函数）。 */
function resolveLike(tokens) {
  return planTokenSync({ config: { onebot: { wsToken: tokens.wsToken, httpToken: tokens.httpToken } }, tokens })
}

main().catch((error) => {
  console.error('验证脚本自身崩了：', error)
  process.exit(1)
})
