/**
 * 桌面壳的离线验证（0.2.4）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套**不启动 Electron**，验的是"桌面壳里的判断"
 * ══════════════════════════════════════════════════════════════════════════
 * 分界线是刻意的：窗口/托盘/菜单只有在真机上点一遍才算验过（这句如实写在
 * `PROJECT.json` 的 `verificationStatus.notVerified` 里）；而**能被机器复核的
 * 那部分** —— 端口从哪来、什么算"启动成功"、状态怎么翻译成中文、
 * app 里到底装了哪些文件 —— 必须由这一套盯着，否则它们只能靠
 * "我读了一遍觉得对"，而本项目最该避免的失败模式正是"读着对、实际不成立"。
 *
 * ★★ 这一套里最值钱的三条断言（都是照着真事故/真风险写的）：
 *
 *   ① `describeStatus` 的字段名必须与 `src/index.mjs` 的 `getStatus()` 一致。
 *      第一版写的是 `connection.connected` —— **那个字段不存在**，于是托盘上
 *      永远显示"状态未知"。它不报错、不影响任何功能，所以只会一直错下去。
 *      断言直接把 `src/index.mjs` 读出来核对字段名，**不是**再抄一遍。
 *
 *   ② `describeStartResult` 必须认得 `--background` 那句"已经有一个桥接在运行"。
 *      真实场景：双击 exe 时上一个桥接**正在启动**（还没绑定端口），而
 *      `--background` 的判据是 process-guard 的登记（写得更早）⇒ 它 exit 1。
 *      把那当成"失败"就会在窗口上写一句吓人且不成立的话。
 *
 *   ③ app 里**不许**出现第二份 `src/` 或 `config-ui/`：它们是包根的东西，
 *      由发布组装平铺到包根。两边各一份 = 两个真相，改一处忘一处。
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const DESKTOP = join(PKG_ROOT, 'desktop')
const require = createRequire(import.meta.url)
const lib = require(join(DESKTOP, 'lib.cjs'))

let passed = 0
let failed = 0
function check (name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✅ ${name}`)
  } else {
    failed += 1
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}
function eq (name, actual, expected) {
  check(name, Object.is(actual, expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`)
}
function section (title) {
  console.log('')
  console.log(`── ${title} ──`)
}

async function main () {
  // ══════════════════════════════════════════════════════════════════════════
  section('文件与结构（缺一个都要说话）')
  {
    const must = [
      'main.cjs', 'preload.cjs', 'lib.cjs', 'splash.html', 'package.json', 'electron-builder.yml',
      join('assets', 'app-icon.ico'),
    ]
    for (const rel of must) check(`存在 desktop/${rel}`, existsSync(join(DESKTOP, rel)), `${rel} 不在`)
    // 构建脚本在**包根** scripts/ 下（不在 desktop/ 里）：第一版把它放在 desktop/scripts/
    // 下，`verify-manifest` 那条"AGENT.md 引用的文件都存在"直接报了红 —— 那条检查是对的。
    check('存在 scripts/fetch-electron.mjs（在包根，不在 desktop/）', existsSync(join(PKG_ROOT, 'scripts', 'fetch-electron.mjs')))
    check('desktop/ 下没有第二套构建脚本', !existsSync(join(DESKTOP, 'scripts')))

    // 语法可解析：一个打错字的 cjs 会让 exe「双击没反应」（连窗口都出不来）
    for (const rel of ['main.cjs', 'preload.cjs', 'lib.cjs']) {
      let err = null
      try {
        new Script(readFileSync(join(DESKTOP, rel), 'utf8'), { filename: rel })
      } catch (e) {
        err = e
      }
      check(`desktop/${rel} 语法可解析`, err === null, err ? err.message : '')
    }

    // 图标：Windows 要 256x256 那一档，否则任务栏/资源管理器会画成低清
    const ico = readFileSync(join(DESKTOP, 'assets', 'app-icon.ico'))
    const count = ico.readUInt16LE(4)
    const sizes = []
    for (let i = 0, off = 6; i < count; i += 1, off += 16) {
      const w = ico[off]
      sizes.push(w === 0 ? 256 : w)
    }
    check('图标含 256x256 档', sizes.includes(256), `实际档位 ${sizes.join('/')}`)
    check('图标含 16x16 档（任务栏也要）', sizes.includes(16), `实际档位 ${sizes.join('/')}`)
    check('图标与桥接那份是同一个（没被改小/换掉）',
      Buffer.compare(ico, readFileSync(join(PKG_ROOT, 'assets', 'icon.ico'))) === 0,
      'desktop/assets/app-icon.ico 与 assets/icon.ico 不一致')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('端口从哪来（每一种情形都要说得出话）')
  {
    const tmp = join(PKG_ROOT, 'cache', 'desktop-verify-tmp')
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    const write = (name, text) => {
      const p = join(tmp, name)
      writeFileSync(p, text, 'utf8')
      return p
    }

    const normal = lib.readUiPort({ configPath: write('normal.json', JSON.stringify({ ui: { apiPort: 4567 } })) })
    eq('读得出自定义端口', normal.port, 4567)
    eq('来源标成 config', normal.source, 'config')

    const missing = lib.readUiPort({ configPath: join(tmp, '不存在.json') })
    eq('文件读不到时回落默认端口', missing.port, lib.DEFAULT_UI_PORT)
    eq('来源标成 default', missing.source, 'default')
    check('并且说得出原因（不静默）', /读不到/.test(missing.why), missing.why)

    const broken = lib.readUiPort({ configPath: write('broken.json', '{ 这不是 JSON ') })
    eq('坏 JSON 时回落默认端口', broken.port, lib.DEFAULT_UI_PORT)
    eq('来源标成 invalid（与"没写"区分开）', broken.source, 'invalid')
    check('并且提示去修配置', /修好配置/.test(broken.why), broken.why)

    const absent = lib.readUiPort({ configPath: write('absent.json', JSON.stringify({ dsh: {} })) })
    eq('没写 apiPort 时回落默认端口', absent.port, lib.DEFAULT_UI_PORT)
    eq('来源标成 default', absent.source, 'default')

    const str = lib.readUiPort({ configPath: write('str.json', JSON.stringify({ ui: { apiPort: ' 5555 ' } })) })
    eq('字符串数字也认（配置是手改的）', str.port, 5555)

    const bad = lib.readUiPort({ configPath: write('bad.json', JSON.stringify({ ui: { apiPort: 99999 } })) })
    eq('越界端口不照用', bad.port, lib.DEFAULT_UI_PORT)
    eq('来源标成 invalid', bad.source, 'invalid')

    const zero = lib.readUiPort({ configPath: write('zero.json', JSON.stringify({ ui: { apiPort: 0 } })) })
    eq('0 不是合法端口', zero.source, 'invalid')

    check('默认端口是 3410', lib.DEFAULT_UI_PORT === 3410, `lib 里是 ${lib.DEFAULT_UI_PORT}`)
    // ★ 两处默认值必须一致：分叉的表现是"界面连 3410、桥接在别的端口上开"
    check('与 src/config.mjs 的默认值一致',
      /apiPort:\s*src\.ui\?\.apiPort \?\? 3410/.test(readFileSync(join(PKG_ROOT, 'src', 'config.mjs'), 'utf8')))

    rmSync(tmp, { recursive: true, force: true })
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('包根解析（打包后 app 在 resources/app，要往上找）')
  {
    eq('开发形态：desktop/ 的上一级', lib.resolvePkgRoot({ dirname: DESKTOP, isPackaged: false }), PKG_ROOT)
    // 伪造的 resources 不存在 ⇒ 必须回落到开发形态那一层，**不猜**
    const fake = lib.resolvePkgRoot({
      dirname: DESKTOP,
      resourcesPath: join(PKG_ROOT, 'resources-不存在'),
      isPackaged: true,
    })
    check('伪造资源目录时不抛错', typeof fake === 'string' && fake.length > 0, String(fake))
    eq('伪造资源目录时回落到开发层（不猜）', fake, PKG_ROOT)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('★★ 包根解析：按**真实发布包布局**验（这一节是补一次真机事故）')
  {
    // ★★★ 为什么这一节要造**真实目录形状**，而不是只喂 `dirname` 字符串：
    //   第一版就是这么漏掉一个真 bug 的 —— 那版 `resolvePkgRoot` 依赖 `app.isPackaged`
    //   进"打包形态"分支，而实测 **`asar: false` 时 `isPackaged === false`**
    //   （Electron 看的是有没有 `app.asar`，而我们故意不打 asar）⇒ 打包分支根本没进，
    //   壳静默把 `app\` 当成了包根：读不到使用者的 `config.json`（日志里写着 ENOENT）、
    //   日志写进 `app\logs\`。离线断言当时全绿，因为它只验了"参数怎么用"、
    //   没验"真实布局长什么样"。
    const tmp = join(PKG_ROOT, 'cache', 'desktop-pkgroot-fixture')
    rmSync(tmp, { recursive: true, force: true })
    const mkdir = (rel) => {
      const p = join(tmp, rel)
      mkdirSync(p, { recursive: true })
      return p
    }
    const touch = (rel, body = 'x') => {
      // ⚠️ 先建父目录：`writeFileSync` 不会替你建（第一版这里直接 ENOENT 崩了 ——
      //    造 fixture 的代码自己也得对，"测试写错了"与"被测代码写错了"要分得清）。
      mkdirSync(dirname(join(tmp, rel)), { recursive: true })
      writeFileSync(join(tmp, rel), body, 'utf8')
    }

    // 造一个"发布包根"：标记文件都在（= 真包根）
    mkdir('.')
    touch('config.example.json', '{}')
    touch(join('src', 'index.mjs'), '// bridge entry')
    // ── 形态 A：发布包的真实形状 ──────────────────────────────────────────
    //   <root>/                     ← 标记在这
    //   <root>/app/resources/app/   ← 壳代码在这（Electron 的 appPath 就指这里）
    const appResApp = mkdir(join('app', 'resources', 'app'))
    touch(join('app', 'resources', 'app', 'main.cjs'), '// shell')

    const realLayout = lib.resolvePkgRoot({ dirname: appResApp, env: {}, isPackaged: false })
    eq('★ 发布包布局：从 app\\resources\\app 向上找到**发布包根**', realLayout, tmp)
    check(
      '★ 而且不是 app\\ 那一层（第一版就是错在这里）',
      realLayout !== join(tmp, 'app'),
      `实际 ${realLayout}`,
    )
    // 用找出来的根去读配置 —— 这才是"能不能读到使用者配置"的真正判据
    check(
      '★ 用这个根能找到 config.example.json（= 能读到使用者的配置）',
      existsSync(join(realLayout, 'config.example.json')),
      realLayout,
    )

    // ── 形态 B：asar:false 让 isPackaged 为假，两种取值都必须得到同一答案 ──
    const asUnpacked = lib.resolvePkgRoot({ dirname: appResApp, env: {}, isPackaged: true })
    eq('★ isPackaged=true 时答案不变（不许依赖它）', asUnpacked, tmp)

    // ── 形态 C：启动器用环境变量显式指定（最可靠的一条路）────────────────
    const viaEnv = lib.resolvePkgRoot({ dirname: 'C:\\不存在\\随便', env: { INTERACTBOT_PKG_ROOT: tmp }, isPackaged: false })
    eq('★ 环境变量优先且被采纳', viaEnv, tmp)

    // ── 形态 D：环境变量**写错了** → 不许静默忽略，要回落到"按标记找"──────
    const warn = []
    const origWarn = console.warn
    console.warn = (m) => warn.push(String(m))
    const badEnv = lib.resolvePkgRoot({
      dirname: appResApp,
      env: { INTERACTBOT_PKG_ROOT: join(tmp, 'app') }, // app/ 不是包根（缺标记）
      isPackaged: false,
    })
    console.warn = origWarn
    eq('★ 环境变量指错时回落到按标记找到的真根', badEnv, tmp)
    check('★ 而且**喊了一声**（不静默忽略）', warn.some((w) => w.includes('看起来不是包根')), warn.join(' | ').slice(0, 160))

    // ── 形态 E：开发侧（desktop/ 的上一级才是包根）────────────────────────
    const devLayout = lib.resolvePkgRoot({ dirname: join(PKG_ROOT, 'desktop'), env: {}, isPackaged: false })
    eq('★ 开发侧：从 desktop/ 向上找到包根', devLayout, PKG_ROOT)

    // ── 形态 F：找不到标记时不猜（返回起点，并把候选喊出来）──────────────
    //
    // ⚠️ 这个场景**必须放到系统临时目录**去造：第一版我把它放在包内 `cache/` 下，
    //    而"向上找"真的会走到 `packages/qq-bridge`（那里有标记）⇒ 它**不算找不到**，
    //    断言于是假失败。造 fixture 的地方本身就是被测逻辑的一部分（"往上能找到什么"），
    //    这一点很容易忽略。
    const outside = join(tmpdir(), `interactbot-pkgroot-none-${Date.now()}`)
    const nowhere = join(outside, 'app', 'resources')
    mkdirSync(nowhere, { recursive: true })
    const warn2 = []
    const origWarn2 = console.warn
    console.warn = (m) => warn2.push(String(m))
    const fallback = lib.resolvePkgRoot({ dirname: nowhere, env: {}, isPackaged: false })
    console.warn = origWarn2
    // 判据（第一版写成"必须是 outside 那一层"，太紧 —— 它会沿链再往上走几层，
    //   走到 `AppData\Local` 之类仍然**是链上真实存在的一层**，那不算错）：
    //   ① 返回的目录**真实存在**（没编路径）；② 它是起点的**祖先**（确实是"往上找"的结果）。
    const isAncestor = (anc, child) => {
      const a = anc.replace(/[\\/]+$/, '').toLowerCase()
      const c = child.toLowerCase()
      return c === a || c.startsWith(a + '\\') || c.startsWith(a + '/')
    }
    check('★ 找不到标记时返回一个**真实存在**的目录（不编路径）', existsSync(fallback), fallback)
    check('★ 而且它是起点的**祖先**（确实是往上找出来的）', isAncestor(fallback, nowhere), `${fallback} vs ${nowhere}`)
    check(
      '★ 并且把"找过哪些"喊出来',
      warn2.some((w) => w.includes('没找到包根标记')),
      warn2.join(' | ').slice(0, 200) || '（一条告警都没有）',
    )
    rmSync(outside, { recursive: true, force: true })

    rmSync(tmp, { recursive: true, force: true })

    // ── 接线：main.cjs 必须把 env 与 appPath 传进去 ──────────────────────
    const mainSrc = readFileSync(join(DESKTOP, 'main.cjs'), 'utf8')
    check('★★ main.cjs 调用 resolvePkgRoot 时传了 env（否则启动器说的根没人听）', /resolvePkgRoot\(\{[\s\S]{0,200}env:\s*process\.env/.test(mainSrc))
    check('★★ 并且用 app.getAppPath() 当起点（不是 __dirname 猜）', /dirname:\s*app\.getAppPath\(\)/.test(mainSrc))
    check('★ 起桥接时把根显式传给子进程', /INTERACTBOT_PKG_ROOT:\s*PKG_ROOT/.test(mainSrc))
    // 启动器显式设置它 —— 否则打包形态只能靠向上找（能work，但少一层确定证据）
    const launchBat = readFileSync(join(PKG_ROOT, '启动机器人.bat'), 'utf8')
    check('★ 启动机器人.bat 显式设置 INTERACTBOT_PKG_ROOT', /set\s+"INTERACTBOT_PKG_ROOT=%~dp0"/.test(launchBat))

    // ★★ 0.2.4：**只开独立界面**的那个入口（用户要求："一份能方便打开带独立界面的后台的文件"）。
    //    它与"全能启动器"（启动机器人.bat，还会分派 --check/--doctor 并在没有 exe 时退回浏览器）
    //    并列存在 —— 目标单一，双击就开窗口。
    {
      const deskPath = join(PKG_ROOT, '桌面端bot启动.bat')
      check('★ 存在 桌面端bot启动.bat（只开桌面窗口的那个入口）', existsSync(deskPath))
      if (existsSync(deskPath)) {
        const desk = readFileSync(deskPath, 'utf8')
        check('★ 它直接 start app\\InteractBot.exe（不再二次分派）', /start "" "%~dp0app\\InteractBot\.exe"/.test(desk))
        check('★ 它也设 INTERACTBOT_PKG_ROOT（否则包根会被猜错）', /set\s+"INTERACTBOT_PKG_ROOT=%~dp0"/.test(desk))
        check('★ 缺 exe 时**明确说不存在**并指向 start.bat（不静默什么都不做）', /app\\InteractBot\.exe not found/.test(desk) && /start\.bat/.test(desk))
        // 与"全能启动器"的关键差别：它**不**转调 start.bat 去分派参数
        check('★ 它不把参数转交给 start.bat（目标单一）', !/call\s+"%~dp0start\.bat"/.test(desk))
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('地址构造（只许回环）')
  {
    eq('控制台地址', lib.consoleUrl(3410), 'http://127.0.0.1:3410/')
    eq('状态地址', lib.statusUrl(3410), 'http://127.0.0.1:3410/api/status')
    eq('换端口的控制台地址', lib.consoleUrl(4567), 'http://127.0.0.1:4567/')
    check('不出现 0.0.0.0（那会把配置接口暴露到局域网）', !/0\.0\.0\.0/.test(lib.statusUrl(1)))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('★★ 状态翻译的字段名必须与桥接真实返回一致')
  {
    const indexSrc = readFileSync(join(PKG_ROOT, 'src', 'index.mjs'), 'utf8')
    const libSrc = readFileSync(join(DESKTOP, 'lib.cjs'), 'utf8')
    check('src/index.mjs 的 getStatus 里确有顶层 connected', /connected:\s*onebot\.connected/.test(indexSrc))
    check('src/index.mjs 的 getStatus 里确有 login 对象', /login:\s*loginInfo\s*\?/.test(indexSrc))
    check('★ 桌面壳读的就是 payload.connected', /payload\.connected/.test(libSrc))
    check('★ 桌面壳不再读那个不存在的 connection 字段', !/payload\.connection/.test(libSrc))

    const connected = lib.describeStatus({ running: true, connected: true, login: { userId: '123', nickname: '小鲸鱼' } })
    eq('已连上时 level=ok', connected.level, 'ok')
    check('昵称进了文案', connected.short.includes('小鲸鱼'), connected.short)

    const noLogin = lib.describeStatus({ connected: true, login: null })
    eq('连上了但没登录 → warn', noLogin.level, 'warn')
    check('提示去扫码登录', /扫码登录/.test(noLogin.detail), noLogin.detail)

    const offline = lib.describeStatus({ connected: false, login: null })
    eq('协议端没连 → warn', offline.level, 'warn')
    check('说的是"协议端未连接"', /协议端未连接/.test(offline.short), offline.short)

    const noField = lib.describeStatus({ running: true })
    check('没有 connected 字段时另说一句（不冒充未连接）', /状态未知/.test(noField.short), noField.short)

    const down = lib.describeStatus(null)
    eq('没有响应 → down', down.level, 'down')
    eq('文案是"桥接未运行"', down.short, '桥接未运行')

    const userIdOnly = lib.describeStatus({ connected: true, login: { userId: '10001' } })
    check('只有 userId 时也认（昵称可能取不到）', userIdOnly.level === 'ok' && userIdOnly.short.includes('10001'), userIdOnly.short)

    // 严格一点：文案里不能出现 "undefined" / "null"（模板拼错时最容易出这个）
    for (const [name, p] of [['已连上', connected], ['没登录', noLogin], ['未连接', offline], ['无响应', down]]) {
      const blob = `${p.short} ${p.detail}`
      check(`${name} 的文案里没有 undefined/null`, !/undefined|null/.test(blob), blob)
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('托盘提示（Windows 会截断，得自己截）')
  {
    const t = lib.trayTooltip({ status: { short: '已连上（小鲸鱼）' }, version: '0.2.4', port: 3410 })
    check('含版本号', t.includes('v0.2.4'), t)
    check('含端口', t.includes(':3410'), t)
    check('含状态', t.includes('小鲸鱼'), t)
    const long = lib.trayTooltip({ status: { short: 'x'.repeat(300) }, version: '0.2.4', port: 3410 })
    check('超长会截断到 ≤120', long.length <= 120, `长度 ${long.length}`)
    const noArgs = lib.trayTooltip({})
    check('什么都不给也能出文案', typeof noArgs === 'string' && noArgs.length > 0, noArgs)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('★★ 什么算"启动成功"')
  {
    const okCase = lib.describeStartResult({ code: 0, stdout: '✅ 已在后台启动（pid 4242）\n   控制台：http://127.0.0.1:3410/' })
    eq('退出码 0 → ok', okCase.ok, true)
    eq('pid 抓出来了', okCase.pid, '4242')
    eq('没被误判成 alreadyRunning', okCase.alreadyRunning, false)

    const dup = lib.describeStartResult({
      code: 1,
      stderr: '❌ 已经有一个桥接在运行（pid 111、222）—— 不再起第二个。',
    })
    eq('★ 已经有一个在跑：不算失败', dup.ok, true)
    eq('★ 并且标出来是 alreadyRunning', dup.alreadyRunning, true)

    const fail = lib.describeStartResult({ code: 1, stderr: '❌ 配置加载失败：xxx' })
    eq('真失败 → ok=false', fail.ok, false)
    check('失败文案带退出码', /退出码 1/.test(fail.message), fail.message)
    check('失败文案带子进程原文（不许只说"失败"）', /配置加载失败/.test(fail.message), fail.message)

    const spawnFail = lib.describeStartResult({ code: null, spawnError: new Error('ENOENT') })
    eq('spawn 失败 → ok=false', spawnFail.ok, false)
    check('文案里有 ENOENT', /ENOENT/.test(spawnFail.message), spawnFail.message)

    const quiet = lib.describeStartResult({ code: 0, stdout: '' })
    eq('没有 pid 时 pid=null（不编）', quiet.pid, null)
    eq('仍是 ok', quiet.ok, true)

    // 负对照：把判据反过来用，确认这条断言真的在盯着东西
    const notDup = lib.describeStartResult({ code: 1, stderr: '已经有一个别的什么在跑' })
    eq('负对照：措辞不同就不算 alreadyRunning', notDup.alreadyRunning, false)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('等待期文案（别让人以为卡死、然后重复双击）')
  {
    const early = lib.describeWait({ elapsedMs: 1200, attempts: 2 })
    // ⚠️ 秒数是 `Math.round(elapsedMs/1000)` ⇒ 1200ms 报 **1** 秒（不是 2）。
    //   第一版这里期望 2，断言就永远红。所以这里**按同一个规则**算期望值，
    //   而不是再写一个手算的数字 —— 手算的那个正是这条断言原本的毛病。
    check('早期文案带秒数与探测次数', /1 秒/.test(early.text) && /第 2 次探测/.test(early.text), early.text)
    check('秒数口径 = round(ms/1000)（与实现同一个规则）',
      lib.describeWait({ elapsedMs: 2400 }).text.includes('2 秒') &&
        lib.describeWait({ elapsedMs: 2499 }).text.includes('2 秒') &&
        lib.describeWait({ elapsedMs: 2600 }).text.includes('3 秒'),
      [lib.describeWait({ elapsedMs: 2400 }).text, lib.describeWait({ elapsedMs: 2600 }).text].join(' | '))
    const mid = lib.describeWait({ elapsedMs: 12_000, attempts: 12 })
    check('中期文案解释它在忙什么', /连协议端/.test(mid.hint ?? ''), JSON.stringify(mid))
    const late = lib.describeWait({ elapsedMs: 40_000, attempts: 40 })
    check('晚期文案给排查入口', /看日志/.test(late.hint ?? ''), JSON.stringify(late))
    const sl = lib.describeWait({ elapsedMs: 8000, phase: 'snowluma' })
    check('SnowLuma 阶段有自己的话', /SnowLuma/.test(sl.text), sl.text)
    const pb = lib.describeWait({ elapsedMs: 3000, phase: 'probe' })
    check('探测阶段说清"不会起第二个"', /不会起第二个/.test(pb.hint ?? ''), JSON.stringify(pb))
    check('负的时长不产生负号', !lib.describeWait({ elapsedMs: -500 }).text.includes('-'), lib.describeWait({ elapsedMs: -500 }).text)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('与真实 /api/status 形状的往返（本机假服务器，不是猜的）')
  {
    // 逐字段照抄 src/index.mjs 的 getStatus()
    const payload = {
      running: true,
      startedAt: new Date().toISOString(),
      uptimeMs: 12345,
      login: { userId: '10001', nickname: '小鲸鱼' },
      connected: true,
      dshAlive: true,
      adminUsers: ['10001'],
      permissionMode: 'workspace-write',
      workspace: 'workspace-qq',
      groupEnabled: false,
      stats: {},
      processes: { selfPid: 1, total: 1, running: 1, conflicts: [] },
      ui: { status: 'fresh' },
    }
    const server = createServer((req, res) => {
      if (req.url === '/api/status') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, data: payload }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: '没有这个接口' }))
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port

    const res = await fetch(lib.statusUrl(port), { cache: 'no-store' })
    const json = await res.json()
    eq('假服务器回的 ok', json.ok, true)
    const described = lib.describeStatus(json.data)
    eq('→ 翻译成"已连上"', described.level, 'ok')
    check('→ 文案带昵称', described.short.includes('小鲸鱼'), described.short)
    check('→ 托盘提示也用同一份判断', lib.trayTooltip({ status: described, version: '0.2.4', port }).includes('小鲸鱼'))

    // 桥接的接口约定是 `{ok:false,error}`（不是 HTTP 错误码）—— 这条要能识别
    const notFound = await fetch(`http://127.0.0.1:${port}/api/does-not-exist`, { cache: 'no-store' })
    const nf = await notFound.json()
    eq('未知路径回 ok:false', nf.ok, false)
    check('未知路径带中文原因', typeof nf.error === 'string' && nf.error.length > 0, JSON.stringify(nf))

    await new Promise((r) => server.close(r))
    // 关掉之后必须能"失败"，而不是抛异常穿出去（那会让启动页白屏）
    let threw = null
    try {
      await fetch(lib.statusUrl(port), { signal: AbortSignal.timeout(1500), cache: 'no-store' })
    } catch (e) {
      threw = e
    }
    check('端口关掉后 fetch 会失败（桌面壳把它当"没在跑"）', threw !== null)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('main.cjs 的行为约束（读源码核对，不靠"我读过"）')
  {
    const src = readFileSync(join(DESKTOP, 'main.cjs'), 'utf8')
    check('★ 顶部 require electron（离线被误加载会炸，而不是静默做别的）', /require\('electron'\)/.test(src))
    check('启动桥接只走 --background（不自己拼 spawn 参数）', /'--background'/.test(src) && !/--instance-id/.test(src))
    check('窗口加载桥接伺服的地址（不 load 本地 dist，避免第二份界面）', /loadURL\(lib\.consoleUrl/.test(src))
    check('关闭窗口 = 收托盘（close 里 preventDefault）', /on\('close'/.test(src) && /preventDefault\(\)/.test(src))
    check('单实例锁存在（第二个实例只叫窗口，不起第二个桥接）', /requestSingleInstanceLock/.test(src))
    check('window-all-closed 不退出（托盘程序）', /window-all-closed/.test(src))
    check('有"退出并停止机器人"这条路', /stopBot:\s*true/.test(src))
    check('日志与桥接日志分开（logs/desktop.log）', /desktop\.log/.test(src))
    check('★ 起桥接前先给"它可能正在启动"留窗口（5 秒确认）', /5000/.test(src) && /正在确认桥接是否已经在跑/.test(src))
    check('只自动重连"自己起的"那个桥接', /state\.startedBy === 'launcher'/.test(src))
    check('外链走系统浏览器（窗口里没有地址栏）', /setWindowOpenHandler/.test(src) && /openExternal/.test(src))
    check('没有把配置文件内容写进日志（密钥会漏）', !/apiKey|wsToken|accessToken/.test(src))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('preload 白名单不许放行任意动作')
  {
    const src = readFileSync(join(DESKTOP, 'preload.cjs'), 'utf8')
    check('有白名单集合', /ALLOWED\s*=\s*new Set/.test(src))
    check('只暴露 act / onProgress', /exposeInMainWorld\('interactbot'/.test(src))
    const allowed = (src.match(/ALLOWED = new Set\(\[([^\]]+)\]\)/) ?? [])[1] ?? ''
    check('白名单里没有 config/shell/exec/fs 之类', !/config|shell|exec|\bfs\b/i.test(allowed), allowed)
    const main = readFileSync(join(DESKTOP, 'main.cjs'), 'utf8')
    check('★ 主进程侧也有 default 分支拒绝未知动作（白名单不只写在文档里）', /default:/.test(main) && /不认识的动作/.test(main))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('打包配置的三条硬约束')
  {
    const yml = readFileSync(join(DESKTOP, 'electron-builder.yml'), 'utf8')
    check('只出免安装目录（dir）', /target:\s*\n\s*-\s*target:\s*dir/.test(yml), yml.slice(0, 500))
    check('不吃 github 的 Electron（electronDist 指本机）', /electronDist:\s*node_modules\/electron\/dist/.test(yml))
    check('asar 关掉（代码要能直接读）', /asar:\s*false/.test(yml))
    check('图标指向 assets/app-icon.ico', /icon:\s*assets\/app-icon\.ico/.test(yml))
    check('files 里不含 scripts/', /'!scripts\/\*\*'/.test(yml))
    check('files 里不含 .npm-cache', /'!\.npm-cache\/\*\*'/.test(yml))
    check('★ app 里不含 src/（避免第二份桥接源码）', !/^\s*-\s*src\//m.test(yml))
    // ⚠️ 只看 `files:` 那一段里的条目，不扫注释：注释里**故意**提到 config-ui / vendor
    //   （说明"它们由包根平铺、不该进 app"），把说明也算成违规就会逼着人删掉说明 ——
    //   这一条第一版就是这么误报的。
    const filesBlock = (yml.match(/^files:\n((?:\s+.*\n)+)/m) ?? [])[1] ?? ''
    check('files 段落能取到（否则下面两条是空断言）', filesBlock.length > 0, filesBlock)
    check('★ app 里不含 config-ui（避免第二份界面产物）', !/config-ui/.test(filesBlock))
    check('★ app 里不含 vendor（那是包根的 Node 运行时）', !/vendor/.test(filesBlock))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('构建期依赖与 gitignore')
  {
    const pkg = JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8'))
    check('electron 版本锁死（不是 ^ 范围）', /^\d+\.\d+\.\d+$/.test(String(pkg.devDependencies?.electron ?? '')), String(pkg.devDependencies?.electron))
    check('electron-builder 在 devDependencies', typeof pkg.devDependencies?.['electron-builder'] === 'string')
    check('★ 没有运行期 dependencies（运行期一律走包根 vendor/）', !pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies))
    check('main 指向 main.cjs', pkg.main === 'main.cjs')
    check('没有 "type": "module"（Electron 主进程按 CJS 跑）', pkg.type === undefined)

    const npmrc = readFileSync(join(DESKTOP, '.npmrc'), 'utf8')
    check('npm 缓存落在包内', /cache=\.\/\.npm-cache/.test(npmrc))
    check('Electron 二进制走镜像', /electron_mirror=https:\/\/registry\.npmmirror\.com/.test(npmrc))

    const gi = readFileSync(join(PKG_ROOT, '.gitignore'), 'utf8')
    // ⚠️ `.build-desktop/` 在**包根**，不在 desktop/ 下（它是 electron-builder 的
    //   产物根，见 scripts/assemble-desktop.mjs）。第一版这里写成 desktop/.build-desktop，
    //   于是断言永远红 —— 而"永远红的断言"会被人顺手删掉，所以它值得修对。
    for (const rel of ['desktop/node_modules', 'desktop/.npm-cache', 'desktop/install.log', '.build-desktop']) {
      check(`.gitignore 排除 ${rel}`, gi.includes(rel), `缺 ${rel}`)
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('fetch-electron 脚本不做危险的事')
  {
    const src = readFileSync(join(PKG_ROOT, 'scripts', 'fetch-electron.mjs'), 'utf8')
    check('版本号从 package.json 读（不写死第二份）', /pkg\.devDependencies\?\.electron/.test(src))
    check('镜像可用环境变量覆盖', /process\.env\.ELECTRON_MIRROR/.test(src))
    check('下载失败会非零退出并且说话', /HTTP \$\{res\.status\}/.test(src) && /process\.exit\(1\)/.test(src))
    check('已就位时直接跳过（幂等）', /已就位/.test(src))
    check('★ 只删 electron/dist（不 rm 整个 node_modules）', /rmSync\(distDir/.test(src) && !/rmSync\(join\(DESKTOP, 'node_modules'\)/.test(src))
    // ⚠️ 只认**真的从 github 下**（URL 字面量），不认注释里提到它：
    //   那段注释正是在解释"为什么不用 github"。第一版扫全文，把说明也算成违规。
    check('没有把下载地址写死成 github', !/https?:\/\/[^'"\s]*github\.com/.test(src))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('没验过的事必须写在 PROJECT.json 里')
  {
    const proj = JSON.parse(readFileSync(join(PKG_ROOT, 'PROJECT.json'), 'utf8'))
    const nv = JSON.stringify(proj.verificationStatus?.notVerified ?? [])
    check('如实记着桌面壳未真机验证', /桌面|Electron|窗口/.test(nv), nv.slice(0, 240))
  }

  console.log('')
  if (failed === 0) {
    console.log(`🎉 桌面壳离线验证全部通过（${passed} 项）`)
    console.log('   ⚠️ 这一套**不启动 Electron**：窗口、托盘、菜单、双击 exe 的实际观感')
    console.log('      没有在这里覆盖 —— 它们如实记在 PROJECT.json 的 verificationStatus.notVerified。')
  } else {
    console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
  }
  // ★★ 这里**故意**用 `process.exitCode`，不调 `process.exit()`。实测：
  //   本文件结尾若调 `process.exit(0)`（哪怕所有断言都过），进程会以
  //     `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`
  //   崩掉，退出码变成 **-1073740791**（STATUS_STACK_BUFFER_OVERRUN）——
  //   于是链上看到的是"这一套崩了"，而真正的原因只是退出方式（假失败会让人去改断言）。
  //   本项目别的套件用 process.exit 没问题，差别是这一套**跑过真实 HTTP 往返**
  //   （本机假服务器 + fetch + AbortSignal.timeout），退出时还有挂着的异步句柄。
  //   换成"设 exitCode、让事件循环自己收尾"之后干净退出（退出码 0/1），代价是几十毫秒。
  process.exitCode = failed === 0 ? 0 : 1
  console.log(`（退出码 ${process.exitCode}）`)
}

await main()
