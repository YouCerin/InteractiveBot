#!/usr/bin/env node
/**
 * SnowLuma 控制台输出落盘 + 首次登录凭据提示（实机 BUG-3）的测试。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 事故形态（一句话）
 * ══════════════════════════════════════════════════════════════════════════
 * SnowLuma 把**首次登录的引导密码只写 stdout**；桥接用 `stdio: 'ignore'` 把它丢掉，
 * 又只读它自己的日志文件（那份里恰好没有这行）⇒ 用户打开 5099 却永远拿不到密码，
 * 于是"重新下载 / 重新注册一遍"成了唯一看得见的路。实测里用户真这么做了。
 *
 * 所以这一套的重点是**端到端**：真的 spawn 一个假 SnowLuma（往 stdout/stderr 写
 * 中文与 `initial credentials:` 行），检查它到底有没有落到文件里 ——
 * 只测纯函数会漏掉"fd 没接上"这种接线错误（这正是事故本身）。
 *
 * 用法：node mocks/verify-snowluma-console.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  bootstrapCredentialInfo,
  closeConsoleLog,
  consoleLogPath,
  openConsoleLog,
  readConsoleForBootstrap,
  readWebuiBootstrap,
  scanBootstrapCredentials,
} from '../src/snowluma-console.mjs'
import { startSnowluma } from '../src/snowluma.mjs'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TMP = mkdtempSync(join(tmpdir(), 'verify-snowluma-console-'))

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
function section(t) {
  console.log(`\n── ${t} ──`)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询等一个条件成立（端到端要等子进程真的写完）。 */
async function until(fn, { timeoutMs = 8000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return true
    if (Date.now() > deadline) return false
    await wait(intervalMs)
  }
}

const CREDENTIAL_LINE = 'initial credentials: user=admin password=0123456789abcdef'

async function main() {
  // ══════════════════════════════════════════════════════════════════════
  section('① 扫描凭据行：认得出来，而且**不把密码本身**带出来')
  // ══════════════════════════════════════════════════════════════════════
  {
    const found = scanBootstrapCredentials(`banner\nWARN [WebUI.Auth] ${CREDENTIAL_LINE}\n`)
    check('认得出 `initial credentials:` 行', found.found === true && found.user === 'admin', JSON.stringify(found))
    check('★★ 返回值里**没有**密码（少一份副本就少一个泄漏面）',
      !JSON.stringify(found).includes('0123456789abcdef'), JSON.stringify(found))
    check('别的行不会被误认', scanBootstrapCredentials('00:25:52 OK 私聊: 你好').found === false)
    check('空文本不崩', scanBootstrapCredentials('').found === false && scanBootstrapCredentials(null).found === false)
  }

  // ══════════════════════════════════════════════════════════════════════
  section('② openConsoleLog：拿到 fd，且是**追加**（重启后旧凭据还在）')
  // ══════════════════════════════════════════════════════════════════════
  {
    const root = join(TMP, 'pkg-a')
    mkdirSync(root, { recursive: true })
    const first = openConsoleLog({ pkgRoot: root })
    check('返回了 fd（mode=file）', typeof first.fd === 'number' && first.mode === 'file', JSON.stringify({ mode: first.mode }))
    check('路径在 <pkgRoot>/logs/snowluma-console.log', first.path === consoleLogPath(root), first.path)
    writeFileSync(first.path, 'old line\n', { flag: 'a' })
    closeConsoleLog(first.fd)
    const second = openConsoleLog({ pkgRoot: root })
    writeFileSync(second.path, 'new line\n', { flag: 'a' })
    closeConsoleLog(second.fd)
    const text = readFileSync(first.path, 'utf8')
    check('★ 追加而不是覆盖（旧一次的凭据不会被新一次冲掉）',
      text.includes('old line') && text.includes('new line'), JSON.stringify(text))
    check('  logs 目录不存在时会自己建出来', existsSync(join(root, 'logs')))
    check('  closeConsoleLog 对 null / 重复调用都不抛', (() => {
      try {
        closeConsoleLog(null)
        closeConsoleLog(undefined)
        closeConsoleLog(999999)
        return true
      } catch {
        return false
      }
    })())
  }

  // ══════════════════════════════════════════════════════════════════════
  section('③ ★ 端到端：真的 spawn 一个假 SnowLuma，看它的输出有没有落盘')
  // ══════════════════════════════════════════════════════════════════════
  {
    const root = join(TMP, 'pkg-b')
    const installRoot = join(TMP, 'fake-snowluma')
    mkdirSync(installRoot, { recursive: true })
    mkdirSync(join(installRoot, 'config'), { recursive: true })
    // 假 SnowLuma：先写横幅（中文），再写**凭据行**（stderr，与真实实现一致）
    const launcher = join(installRoot, 'index.mjs')
    writeFileSync(
      launcher,
      [
        "process.stdout.write('00:25:52 OK [200000001] [Event] 私聊 [无忘远霞(100000001)]: 确认一下群聊开关打开了吗\\n')",
        `process.stderr.write('WARN [WebUI.Auth] ${CREDENTIAL_LINE}\\n')`,
      ].join('\n'),
      'utf8',
    )
    // 还处于"没改过初始密码"的状态 —— 这是"看不到密码"最典型的场景
    writeFileSync(join(installRoot, 'config', 'webui.json'), JSON.stringify({ mustChangePassword: true }), 'utf8')

    const logs = []
    const r = await startSnowluma({
      config: {
        snowluma: { launchCmd: launcher, consoleUrl: 'http://127.0.0.1:9/', probeTimeoutMs: 30 },
        onebot: { httpUrl: 'http://127.0.0.1:9', wsUrl: 'ws://127.0.0.1:9' },
      },
      log: (m) => logs.push(String(m)),
      // 下面这些注入是为了**不碰真实网络、也不写真实进程登记表**
      probe: async () => ({ reachable: false }),
      detect: async () => ({ status: 'offline' }),
      locateSnowluma: () => ({ cmd: launcher, cwd: installRoot, kind: 'mjs', from: 'test' }),
      findNode: () => process.execPath,
      checkPort: async () => ({ inUse: false }),
      probeAnswered: async () => ({ answered: false }),
      register: () => ({ ok: true }),
      pkgRoot: root,
    })

    check('startSnowluma 报成功', r.ok === true && r.data?.started === true, JSON.stringify(r).slice(0, 200))
    const logFile = consoleLogPath(root)
    const wrote = await until(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('initial credentials:'))
    check('★★ 假 SnowLuma 的 stdout/stderr 真的落到了 logs/snowluma-console.log',
      wrote, existsSync(logFile) ? readFileSync(logFile, 'utf8').slice(0, 200) : '（文件都没建出来）')
    if (wrote) {
      const text = readFileSync(logFile, 'utf8')
      check('★ 中文没有乱码（实测 UTF-8 保真，旧注释里"GBK 乱码"的说法不成立于文件句柄）',
        text.includes('确认一下群聊开关打开了吗') && !text.includes('\uFFFD'))
      check('★ 凭据行也在里面（这就是用户需要的那一句）', text.includes('initial credentials:'))
    }
    check('  返回值里给出了文件位置（界面能显示）', String(r.data?.consoleLogFile ?? '').endsWith(consoleLogPath(root)) ||
      r.data?.consoleLogFile === logFile, String(r.data?.consoleLogFile))
    check('  spawn 时就说了"输出写到哪个文件"（用户不用等到界面）',
      logs.some((l) => l.includes('SnowLuma 的输出已写到')), logs.join(' | '))

    // 落盘之后：提示文案应当**指向文件**，并且仍然不含密码
    const info = bootstrapCredentialInfo({ pkgRoot: root, installDir: installRoot, consoleUrl: 'http://127.0.0.1:5099/' })
    check('★ 扫到凭据后，提示指向文件并说明搜什么',
      info.found === true && /initial credentials/.test(info.hint) && info.hint.includes(info.relFile), info.hint)
    check('★★ 提示里**没有**密码本身', !info.hint.includes('0123456789abcdef'))
    check('  提示里带上网页端地址（用户下一步就是去登录）', info.hint.includes('http://127.0.0.1:5099/'))
  }

  // ══════════════════════════════════════════════════════════════════════
  section('④ 没扫到凭据时：告诉用户"重启会轮换新密码"，掐掉"重装"这条路')
  // ══════════════════════════════════════════════════════════════════════
  {
    const root = join(TMP, 'pkg-c')
    const installRoot = join(TMP, 'fake-snowluma-2')
    mkdirSync(join(installRoot, 'config'), { recursive: true })
    mkdirSync(join(root, 'logs'), { recursive: true })
    writeFileSync(consoleLogPath(root), 'banner only, no credentials here\n', 'utf8')
    writeFileSync(join(installRoot, 'config', 'webui.json'), JSON.stringify({ mustChangePassword: true }), 'utf8')

    const info = bootstrapCredentialInfo({ pkgRoot: root, installDir: installRoot })
    check('★ 未扫到 + mustChangePassword=true → 提示"再启动一次会轮换新密码"',
      /轮换/.test(info.hint) && /再启动一次|再启动/.test(info.hint), info.hint)
    check('★★ 明确说"不需要重新下载、也不需要重新注册"（这次事故里用户真去重装了）',
      /不需要重新下载/.test(info.hint) && /重新注册/.test(info.hint), info.hint)
    check('  仍然给出文件位置（万一它其实在里面）', info.hint.includes(info.relFile))
    check('  读得到 mustChangePassword', info.mustChangePassword === true)
    check('  没有该文件时不崩、也不说谎',
      readWebuiBootstrap({ installDir: join(TMP, 'nowhere') }).mustChangePassword === null)

    // 大文件：只扫开头与结尾（凭据只在某次启动的横幅之后，扫整个文件既慢又没意义）
    const big = join(TMP, 'pkg-d')
    mkdirSync(join(big, 'logs'), { recursive: true })
    const filler = 'x'.repeat(3 * 1024 * 1024)
    writeFileSync(consoleLogPath(big), `${CREDENTIAL_LINE}\n${filler}\n`, 'utf8')
    check('★ 大文件里**开头**的凭据仍然扫得到（第一次启动就在开头）',
      scanBootstrapCredentials(readConsoleForBootstrap({ pkgRoot: big })).found === true)
  }

  // ══════════════════════════════════════════════════════════════════════
  section('⑤ ★ 接线守卫：`stdio: \'ignore\'` 不许回到 SnowLuma 的启动里')
  // ══════════════════════════════════════════════════════════════════════
  {
    const src = readFileSync(join(PKG_ROOT, 'src', 'snowluma.mjs'), 'utf8')
    check('★ 调用了 openConsoleLog（否则 stdout 又被丢掉）', /openConsoleLog\s*\(/.test(src))
    check('★ spawn 的 stdio 用的是落盘 fd', /stdio:\s*\[\s*'ignore'\s*,\s*out\.fd/.test(src))
    check('★ 父进程那份 fd 被关掉（否则每拉起一次就泄漏一个句柄）', /closeConsoleLog\s*\(/.test(src))
    // 只允许 defaultOpenBrowser 那处（打开浏览器）继续 ignore —— 那是"启动浏览器"，
    // 它的输出本来就没人要，也不含任何凭据。
    // 只统计**代码行**：注释里正当地引用了它（"原来这里是 stdio:'ignore'"），
    // 那是留给下一位的事故记录，不该被守卫误伤。
    const code = src
      .split(/\r?\n/)
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    const ignores = [...code.matchAll(/stdio:\s*'ignore'/g)].length
    check('  只剩"打开浏览器"那一处 ignore（不再是 SnowLuma 本体）', ignores === 1, `代码里 stdio:'ignore' 出现 ${ignores} 次`)
    check('★★ 已经不再写"用文件句柄会 GBK 乱码"这类不成立的结论',
      !/会变成 GBK 乱码/.test(readFileSync(join(PKG_ROOT, 'src', 'snowluma-log.mjs'), 'utf8')))
  }

  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? '🎉 SnowLuma 控制台输出与凭据提示验证通过' : `⚠️ ${failures} 项失败`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('验证脚本自身崩了：', error)
  process.exit(1)
})
