/**
 * OneBot 凭据发现测试（H8）：**宁可找不到，也不要猜**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套盯的是"猜错的代价"：token 猜错的症状是**令牌被拒 + 机器人完全不说话**
 * （本项目踩过两次），而且它**不报错**、只是不说话 —— 最难查的一类失败。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 最要紧的三条：
 *   ① ★★ **显式指定账号却找不到它的文件 → 必须返回"没有"**，
 *      绝不去拿目录里别的账号的 token（原实现就是"退到任意一个 onebot_<数字>.json"）；
 *   ② **只采纳 enabled 且 host 回环的条目**（非回环条目在一个本机协议端的配置里可疑）；
 *   ③ **非法 token 一律不采纳**（非字符串/超长/含控制字符 —— 后者会进 HTTP 头，
 *      症状是协议端回一句莫名其妙的 400）。
 *
 * ⚠️ 另外还钉住一处**与参考项目的刻意分歧**：NapCat 那边"http 与 ws token 不一致就放弃猜测"，
 *    我们**不照搬** —— 我们的两条通道是同时使用、各用各的凭据（http 发消息、ws 收事件），
 *    照搬会让一份完全正常的配置直接失效。这一条在下面有专门的断言。
 *
 * 用法：node mocks/verify-token-discovery.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  discoverOnebotConfig,
  listAccountNames,
  pickAccountFile,
  pickServer,
  readAccountFile,
  sanitizeToken,
  isLoopbackHost,
  DISCOVERY_LIMITS,
} from '../src/token-discovery.mjs'
import { readSnowlumaTokens, resolveOnebotTokens } from '../src/snowluma.mjs'

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

const ROOT = mkdtempSync(join(tmpdir(), 'qq-bridge-tok-'))
const writeAccount = (dir, uin, body) => {
  mkdirSync(join(dir, 'config'), { recursive: true })
  writeFileSync(join(dir, 'config', `onebot_${uin}.json`), JSON.stringify(body), 'utf8')
}
const mkInstall = (name) => {
  const d = join(ROOT, name)
  mkdirSync(join(d, 'config'), { recursive: true })
  return d
}

try {
  // ══════════════════════════════════════════════════════════════════════════
  section('① 回环判定与 token 校验（判据本身要准）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      check(`回环：${h}`, isLoopbackHost(h) === true)
    }
    for (const h of ['0.0.0.0', '192.168.1.5', '10.0.0.1', 'example.com', '', null, '127.0.0.256.1']) {
      check(`★ 非回环（不许采纳）：${JSON.stringify(h)}`, isLoopbackHost(h) === false)
    }

    check('正常 token 通过', sanitizeToken('a'.repeat(32)).ok === true)
    check('前后空白被去掉', sanitizeToken('  abc  ').token === 'abc')
    check('★ 非字符串拒', sanitizeToken(12345).ok === false && sanitizeToken({}).ok === false)
    check('★ 空串/纯空白拒', sanitizeToken('   ').ok === false)
    check('★ 超长拒', sanitizeToken('a'.repeat(DISCOVERY_LIMITS.maxTokenChars + 1)).ok === false)
    check('★★ 含控制字符拒（它会进 HTTP 头，症状是莫名其妙的 400）',
      sanitizeToken('abc\ndef').ok === false && sanitizeToken('abc\u0000def').ok === false,
      JSON.stringify(sanitizeToken('abc\ndef')))
    check('缺失（undefined/null）拒', sanitizeToken(undefined).ok === false && sanitizeToken(null).ok === false)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('② 服务器挑选：enabled 与 host 两道门')
  // ══════════════════════════════════════════════════════════════════════════
  {
    check('正常条目取到 token',
      pickServer([{ host: '127.0.0.1', accessToken: 'T1' }], { channel: 'http' }).token === 'T1')
    check('没写 host 也接受（有些配置把监听地址写在别处）',
      pickServer([{ accessToken: 'T2' }], { channel: 'http' }).token === 'T2')
    check('★ enabled=false 跳过', (() => {
      const r = pickServer([{ enabled: false, accessToken: 'T3' }], { channel: 'http' })
      return r.token === null && r.skipped.some((s) => s.includes('enabled=false'))
    })())
    check('★★ host 非回环跳过（并说明原因）', (() => {
      const r = pickServer([{ host: '10.1.2.3', accessToken: 'T4' }], { channel: 'ws' })
      return r.token === null && r.skipped.some((s) => s.includes('不是回环'))
    })())
    check('★ 前一个不可用时会继续看下一个（不是一票否决整份配置）', (() => {
      const r = pickServer([{ enabled: false, accessToken: 'bad' }, { host: '127.0.0.1', accessToken: 'good' }], { channel: 'http' })
      return r.token === 'good'
    })())
    check('token 非法的那条跳过并说明原因', (() => {
      const r = pickServer([{ accessToken: 'x\ny' }], { channel: 'http' })
      return r.token === null && r.skipped.some((s) => s.includes('控制字符'))
    })())
    check('空列表 → 明确说"没有条目"', pickServer([], { channel: 'http' }).why.includes('没有 http'))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('③ ★★ 账号选择：显式指定就只认那一个（绝不复用别的账号）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const dir = mkInstall('two-accounts')
    writeAccount(dir, '111', { networks: { httpServers: [{ host: '127.0.0.1', accessToken: 'TOKEN-111' }] } })
    writeAccount(dir, '222', { networks: { httpServers: [{ host: '127.0.0.1', accessToken: 'TOKEN-222' }] } })

    const explicit = discoverOnebotConfig({ installDir: dir, selfId: '222' })
    check('★★ 指定 222 → 拿到 222 的 token', explicit.ok && explicit.httpToken === 'TOKEN-222', JSON.stringify(explicit))

    const missing = discoverOnebotConfig({ installDir: dir, selfId: '999' })
    check('★★★ 指定 999（文件不存在）→ **返回"没有"，绝不复用 111/222 的 token**',
      missing.ok === false && missing.httpToken === null && missing.wsToken === null,
      JSON.stringify({ ok: missing.ok, http: missing.httpToken, why: missing.why }))
    check('★ 而且理由里说清"不会改用别的账号"（这是排查 401 的关键线索）',
      missing.why.includes('不会') && missing.why.includes('别的账号'), missing.why)

    const auto = discoverOnebotConfig({ installDir: dir })
    check('★ 没指定账号时才自动挑，并如实标注是自动挑的',
      auto.ok === true && auto.picked.startsWith('auto-newest:'), JSON.stringify({ picked: auto.picked, token: auto.httpToken }))
    check('★ 自动挑的结果确实是目录里的某一个', ['TOKEN-111', 'TOKEN-222'].includes(auto.httpToken), String(auto.httpToken))

    // ── ★★ 真机上抓到的那条：多账号 + 没写 selfId 时，**不能只看"最新"** ──────
    //    真机取证：SnowLuma 的 config/ 下有机器人自己的 200000001 与使用者的 100000001，
    //    而**最新的是使用者的那个** —— 只按 mtime 挑就会挑到别人的账号（症状 401 + 完全不说话）。
    const matched = discoverOnebotConfig({
      installDir: dir,
      knownTokens: { httpToken: 'TOKEN-111' }, // config.json 里现有的是 111 的
    })
    check('★★★ 多账号时按"**与 config.json 一致**"挑（确定性判据，不是猜最新）',
      matched.ok === true && matched.httpToken === 'TOKEN-111' && matched.picked === 'matched-config:onebot_111.json',
      JSON.stringify({ picked: matched.picked, token: matched.httpToken }))
    check('★ 而且这时**不该有警告**（挑对了没什么好警告的）', matched.warn === '', String(matched.warn))

    const stillNewest = discoverOnebotConfig({ installDir: dir, knownTokens: { httpToken: 'TOKEN-不存在' } })
    check('★ 都不一致时才退回"最新"，并且**必须警告**（告诉使用者去写 selfId）',
      stillNewest.warn.includes('onebot.selfId') && stillNewest.warn.includes('231') === false
        ? stillNewest.warn.includes('onebot.selfId')
        : false,
      String(stillNewest.warn))
    check('★ 警告里列出了所有候选账号（让人能立刻判断该写哪个）',
      stillNewest.warn.includes('111') && stillNewest.warn.includes('222'), String(stillNewest.warn))
    check('★ 单账号时**不警告**（没什么可选的）', (() => {
      const one = mkInstall('single')
      writeAccount(one, '555', { networks: { httpServers: [{ host: '127.0.0.1', accessToken: 'ONLY' }] } })
      return discoverOnebotConfig({ installDir: one, knownTokens: { httpToken: '别的' } }).warn === ''
    })())
    check('★★ 两个账号用同一组 token → 判为**无法确定**，不猜', (() => {
      const amb = mkInstall('ambiguous')
      writeAccount(amb, '601', { networks: { httpServers: [{ host: '127.0.0.1', accessToken: 'SAME' }] } })
      writeAccount(amb, '602', { networks: { httpServers: [{ host: '127.0.0.1', accessToken: 'SAME' }] } })
      const r = discoverOnebotConfig({ installDir: amb, knownTokens: { httpToken: 'SAME' } })
      return r.ok === false && r.picked === 'ambiguous' && r.warn.includes('selfId')
    })())

    check('账号摘要**不含任何 token**（给界面用的）', (() => {
      const names = listAccountNames(dir)
      return names.includes('111') && names.includes('222') && !JSON.stringify(names).includes('TOKEN')
    })(), JSON.stringify(listAccountNames(dir)))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('④ 保守读文件：符号链接/超大/坏 JSON 都不采纳')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const dir = mkInstall('unsafe')
    // 真实文件 + 指向它的符号链接
    writeAccount(dir, '333', { networks: { httpServers: [{ host: '127.0.0.1', accessToken: 'REAL' }] } })
    let linkMade = false
    try {
      symlinkSync(join(dir, 'config', 'onebot_333.json'), join(dir, 'config', 'onebot_444.json'))
      linkMade = true
    } catch {
      /* Windows 上非开发者模式建不了符号链接 —— 跳过这条，不假装通过 */
    }
    if (linkMade) {
      const r = readAccountFile(join(dir, 'config', 'onebot_444.json'))
      check('★★ 符号链接被拒（我们只读自己人写的常规文件）',
        r.ok === false && r.why.includes('符号链接'), JSON.stringify(r))
      const d = discoverOnebotConfig({ installDir: dir, selfId: '444' })
      check('★★ 指定的是一个符号链接 → 不采纳（而不是顺着链接读走）', d.ok === false, JSON.stringify({ ok: d.ok, why: d.why }))
    } else {
      console.log('⏭️  本环境建不了符号链接（非开发者模式）→ 改用**注入的 lstat** 覆盖这条安全判据')
    }
    // ★ 不依赖"本机能不能建符号链接"：直接给 readAccountFile 注入一个"报告为符号链接"的 lstat。
    //   安全判据不能因为环境限制就没有测试盯着。
    {
      const fakeLstat = () => ({ isSymbolicLink: () => true, isFile: () => true, size: 100 })
      const r = readAccountFile(join(dir, 'config', 'onebot_333.json'), { lstat: fakeLstat })
      check('★★ 注入 lstat 验证：报道为符号链接 → 拒读', r.ok === false && r.why.includes('符号链接'), JSON.stringify(r))
    }
    {
      const fakeLstat = () => ({ isSymbolicLink: () => false, isFile: () => false, size: 100 })
      const r = readAccountFile(join(dir, 'config', 'onebot_333.json'), { lstat: fakeLstat })
      check('★ 注入 lstat 验证：不是常规文件（目录等）→ 拒读', r.ok === false && r.why.includes('常规文件'), JSON.stringify(r))
    }

    check('不存在的文件 → 明确失败', readAccountFile(join(dir, 'config', 'nope.json')).ok === false)
    check('坏 JSON → 明确失败（并说明解析失败）', (() => {
      writeFileSync(join(dir, 'config', 'onebot_555.json'), '{不是 json', 'utf8')
      const r = readAccountFile(join(dir, 'config', 'onebot_555.json'))
      return r.ok === false && r.why.includes('解析失败')
    })())
    check('超大文件 → 拒（不把内存吃满）', (() => {
      const big = join(dir, 'config', 'onebot_666.json')
      writeFileSync(big, ' '.repeat(DISCOVERY_LIMITS.maxBytes + 10), 'utf8')
      const r = readAccountFile(big)
      return r.ok === false && r.why.includes('过大')
    })())
    check('目录当成文件读 → 明确失败', readAccountFile(join(dir, 'config')).ok === false)
    check('pickAccountFile 对不存在的目录不抛', pickAccountFile({ installDir: join(ROOT, 'nope') }).file === null)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑤ ★ 刻意与参考项目不同的地方：http 与 ws token 不必相同')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const dir = mkInstall('two-tokens')
    writeAccount(dir, '777', {
      networks: {
        httpServers: [{ host: '127.0.0.1', accessToken: 'HTTP-TOKEN' }],
        wsServers: [{ host: '127.0.0.1', accessToken: 'WS-TOKEN' }],
      },
    })
    const d = discoverOnebotConfig({ installDir: dir, selfId: '777' })
    check('★★ 两条通道各取各的 token（不是"不一致就放弃"）—— 我们两条通道是同时用的',
      d.ok === true && d.httpToken === 'HTTP-TOKEN' && d.wsToken === 'WS-TOKEN', JSON.stringify(d))
    check('★ 但"与 config.json 不一致"仍要如实报出来（不静默）', (() => {
      const r = resolveOnebotTokens({
        config: { onebot: { httpToken: 'STALE', wsToken: 'STALE', selfId: '777' } },
        installDir: dir,
      })
      return r.differsFromConfig === true && r.httpToken === 'HTTP-TOKEN' && r.wsToken === 'WS-TOKEN'
    })())
    check('★ 一侧缺失时**只补那一侧**，并说明原因', (() => {
      const dir2 = mkInstall('one-sided')
      writeAccount(dir2, '888', { networks: { httpServers: [{ host: '127.0.0.1', accessToken: 'ONLY-HTTP' }] } })
      const r = resolveOnebotTokens({ config: { onebot: { httpToken: 'CFG-H', wsToken: 'CFG-W', selfId: '888' } }, installDir: dir2 })
      return r.httpToken === 'ONLY-HTTP' && r.wsToken === 'CFG-W' && r.why.includes('ws')
    })())
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑥ 与 snowluma.mjs 的接缝（形状不变 + 多带排查信息）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const dir = mkInstall('seam')
    writeAccount(dir, '123456', { networks: { httpServers: [{ host: '127.0.0.1', accessToken: 'FROM-SNOWLUMA-HTTP' }] } })
    const got = readSnowlumaTokens({ installDir: dir, selfId: '123456' })
    check('★ 原有字段一个不少（httpToken/wsToken/source/file）',
      got.httpToken === 'FROM-SNOWLUMA-HTTP' && got.source === 'SnowLuma 自己的配置' && Boolean(got.file),
      JSON.stringify({ http: got.httpToken, source: got.source }))
    check('★ 新增 picked/accounts 供排查（界面能用，且不含密钥）',
      got.picked === 'explicit-selfId' && JSON.stringify(got.accounts) === '["123456"]', JSON.stringify({ picked: got.picked, accounts: got.accounts }))

    const fb = resolveOnebotTokens({ config: { onebot: { httpToken: 'CFG', wsToken: 'CFG' } }, installDir: join(ROOT, 'nope') })
    check('★ 回退到 config.json 时**说明为什么**（过去是静默回退 —— 401 的源头）',
      fb.source === 'config.json' && fb.why.length > 0, JSON.stringify({ source: fb.source, why: fb.why }))

    check('没有 installDir 时不抛', discoverOnebotConfig({}).ok === false && readSnowlumaTokens({}).httpToken === null)
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('')
if (failed === 0) {
  console.log(`🎉 凭据发现测试全部通过（${passed} 项）`)
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
