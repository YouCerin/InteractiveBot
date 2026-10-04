/**
 * 发布与升级卫生测试（H16）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套盯的三件事
 * ══════════════════════════════════════════════════════════════════════════
 * ① **用户数据绝不许进发布包**：发布脚本是"按清单拷贝"的，往 `COPY_DIRS` 里多写一行
 *    （例如顺手加上 `workspace-qq`）就会把某个真实使用者的**聊天记忆、日志、token**
 *    打进 zip —— 而且**不会有任何报错**（zip 里多两个目录而已）。
 * ② **大小写不能成为绕过口**：Windows 上 `LOGS` 与 `logs` 是同一个目录。
 *    只按区分大小写的字符串比对，`LOGS` 就能悄悄绕过清单。
 * ③ **纯函数测过 ≠ 接线做过**：本项目最贵的一类缺陷就是"函数写对了、没人调用"
 *    （"任务段在真机上从未注入"）。所以这里额外断言**发布脚本真的 import 了这些函数**。
 *
 * 用法：node mocks/verify-release-hygiene.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PROTECTED_USER_PATHS,
  auditReleaseInputs,
  classifyDeleteTarget,
  compareKey,
  disposablePaths,
  isProtectedPath,
  normalizeRel,
  renderProtectedList,
} from '../src/protected-files.mjs'
import { batchHazardMessage, findBatchParenHazards } from '../src/batch-safety.mjs'
import { DEFAULT_EXEMPT, auditPackageRefs, scanSourceForPackageRefs } from '../src/package-refs.mjs'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

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
section('① 受保护清单本身：每条都要有理由')
// ══════════════════════════════════════════════════════════════════════════
{
  check('清单非空', PROTECTED_USER_PATHS.length > 0, `${PROTECTED_USER_PATHS.length} 条`)
  check('★★ 每一条都写了"为什么"（只写路径名的话，下一个人不知道它为什么不能动）',
    PROTECTED_USER_PATHS.every((it) => typeof it.why === 'string' && it.why.length >= 8))
  check('清单里没有重复项', new Set(PROTECTED_USER_PATHS.map((it) => compareKey(it.rel))).size === PROTECTED_USER_PATHS.length)
  check('★ 关键的那几个都在：配置 / 工作区 / 日志 / 协议端',
    ['config.json', 'workspace-qq', 'logs', 'snowluma'].every((r) => isProtectedPath(r)))
  check('渲染出来带理由（RELEASE.md 与体检共用一份文案）', renderProtectedList().includes('聊天记忆'))
  check('★ 测试残留被标成"可清理"（它们既是垃圾、也不许进包 —— 两件事要分开说）',
    disposablePaths().includes('.tmp-probe-dsh') && isProtectedPath('.tmp-probe-dsh') !== null)
}

// ══════════════════════════════════════════════════════════════════════════
section('② 前缀与大小写：两种绕过都要堵住')
// ══════════════════════════════════════════════════════════════════════════
{
  check('★ 子路径也算（`logs/bridge.log` 不能因为"不是目录本身"就漏掉）', isProtectedPath('logs/bridge.log') !== null)
  check('★ 反斜杠写法也算（Windows 上两种斜杠都会出现）', isProtectedPath('logs\\bridge.log') !== null)
  check('★ 带 `./` 前缀也算', isProtectedPath('./logs') !== null)
  check('★★ **大小写不同也算**（Windows 上 `LOGS` 与 `logs` 是同一个目录）',
    isProtectedPath('LOGS') !== null && isProtectedPath('Workspace-QQ/memory') !== null,
    `LOGS→${isProtectedPath('LOGS') ? '拦住' : '漏了'}`)
  check('★★ 前缀不能"半个词也算"（`logs-old` 不是 `logs`）', isProtectedPath('logs-old') === null)
  check('  正常源码路径**不**被误拦（否则门禁会拦下所有打包）',
    isProtectedPath('src') === null && isProtectedPath('mcp/mcp-qq-server.mjs') === null &&
      isProtectedPath('config-ui/dist') === null)
  check('  空路径返回 null（不崩）', isProtectedPath('') === null && isProtectedPath(null) === null)
  check('  归一化：斜杠方向与前后斜杠都拉平', normalizeRel('\\logs\\') === 'logs' && compareKey('LOGS') === 'logs')
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 发布输入端审计：清单被污染必须拦下（这就是那个"不报错的泄露"）')
// ══════════════════════════════════════════════════════════════════════════
{
  const good = auditReleaseInputs({
    dirs: ['src', 'mcp', 'assets', join('config-ui', 'dist'), join('vendor', 'node')],
    files: ['package.json', 'start.bat', 'setup.mjs'],
  })
  check('★ 正常清单放行', good.ok && good.problems.length === 0)

  const poisoned = auditReleaseInputs({
    dirs: ['src', 'workspace-qq', 'logs'],
    files: ['package.json', 'config.json'],
  })
  check('★★ 混进用户数据 → **拦下**，并逐条说明为什么',
    poisoned.ok === false && poisoned.problems.length === 3,
    poisoned.problems.map((p) => p.rel).join('、'))
  check('  理由说明了后果（"记忆/隐私"这类，不是干巴巴的"受保护"）',
    poisoned.problems.some((p) => p.why.includes('聊天记忆')) && poisoned.problems.some((p) => p.why.includes('token')))
  check('★ 大小写变体也拦得住（`Workspace-QQ` 同样不许进包）',
    auditReleaseInputs({ dirs: ['Workspace-QQ'] }).ok === false)
  check('  空清单放行（不是"没东西就报错"）', auditReleaseInputs({}).ok === true)
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 删除前检查：只允许删"我们自己的产物"')
// ══════════════════════════════════════════════════════════════════════════
{
  check('★★ 受保护路径 → **拒绝删除**（哪怕调用方说它是产物）',
    classifyDeleteTarget({ dir: 'workspace-qq', exists: () => true, hasFiles: true }).ok === false)
  check('  理由说清"任何脚本都不许删"',
    classifyDeleteTarget({ dir: 'logs', exists: () => true }).why.includes('不许删'))
  check('★ 目录不存在 → 放行（没什么可删）', classifyDeleteTarget({ dir: '_release/x', exists: () => false }).ok === true)
  check('★ 空目录 → 放行', classifyDeleteTarget({ dir: '_release/x', exists: () => true, hasFiles: false }).ok === true)
  check('★★ **非空 + 没有我们的标识文件 → 拒绝**（它可能是别人放的东西）',
    classifyDeleteTarget({ dir: '_release/x', exists: () => true, hasFiles: true }).ok === false)
  check('  有标识文件 → 才是我们的产物，放行',
    classifyDeleteTarget({
      dir: '_release/x',
      exists: () => true,
      hasFiles: true,
      markerFiles: ['config.example.json'],
    }).ok === true)
  check('  空路径 → 拒绝（不猜）', classifyDeleteTarget({ dir: '' }).ok === false)
}

// ══════════════════════════════════════════════════════════════════════════
section('④-b ★★ 发布模板里**不许有真实凭据**（0.3.2：RCON 密码这一类现有正则抓不到）')
// ══════════════════════════════════════════════════════════════════════════
//
// 为什么要单独加这一条：`check-release-package.mjs` 的 `SECRETS` 只认三种形状
// （DeepSeek key 的 `sk-<32位十六进制>` 与两个历史 SnowLuma token）。
// **RCON 密码不匹配任何一条** —— 它可以是任意字符串，所以字符串匹配那条路
// 对它天然无效。∴ 判据必须是**字段级**的："模板里这个字段是不是空的"。
{
  const examplePath = join(PKG_ROOT, 'config.example.json')
  let example = null
  try {
    example = JSON.parse(readFileSync(examplePath, 'utf8'))
  } catch (error) {
    check('config.example.json 是可解析的 JSON', false, String(error?.message ?? error))
  }
  if (example) {
    const servers = Array.isArray(example.servers) ? example.servers : []
    check('★ servers 段存在（模板要教人怎么写）', Array.isArray(example.servers))
    const withPassword = servers.filter((s) => typeof s?.password === 'string' && s.password !== '')
    check(
      '★★★ 模板里每一条 RCON 密码**都是空字符串**（泄露一条 = 把别人的服务端控制台交出去）',
      withPassword.length === 0,
      withPassword.map((s) => s.id).join(' / '),
    )
    // 地址也不许填成一个真实的开发机地址（那是"机器专属信息"，与 MACHINE 那条同类）
    const withHost = servers.filter((s) => s?.host && !/^(127\.0\.0\.1|localhost|::1)$/.test(String(s.host)))
    check('★ 模板里的 host 只有回环地址（本机 IP / 域名属于机器专属信息）', withHost.length === 0, withHost.map((s) => s.host).join(' / '))
    // 默认必须是**关**的：监测是"会去连外部服务"的能力
    const enabled = servers.filter((s) => s?.enabled === true)
    check('★ 模板里默认全是停用的（监测会去连外部服务，默认不许自己跑起来）', enabled.length === 0)

    // ── ★★★ 模板里的**说明文字**也是发布物，也要跟实现对得上 ────────────────
    //
    // ★ 为什么这条归在"发布卫生"里：发布包里的 `config.json` 就是**这份模板复制出来的**
    //   （组装脚本第 ③ 步），而用户是**照着它读**的 —— 说明写错等于给所有人发一份错文档。
    // ★ 它抓的是一次真实的措辞事故：`commandFromQQ` 的说明原本写「两条路都受它控制」
    //   （群里 `\mc` + 模型工具），把**游戏内管理员**那条漏了；后来我又在别处写成
    //   「与游戏内无关」——**两个方向都错**。使用者的实际遭遇：他在游戏里让 bot 查 TPS，
    //   bot 照着那句错话把自己的活推回给使用者（真机日志有）。
    // ∴ 判据：说明里**必须**点到游戏内那条入口，且**不许**再出现"无关"这类错话。
    //   （同一个事实在界面/文档里也有断言：`verify-api.mjs` 读 `ServerForm.tsx`。）
    const cqNote = String(servers[0]?._commandFromQQ说明 ?? '')
    check(
      '★★★ `_commandFromQQ说明` 必须写明它管**三条入口**（含**游戏内**绑定了管理员 QQ 的玩家）',
      /三条入口/.test(cqNote) && /游戏内/.test(cqNote) && /管理员 QQ/.test(cqNote),
      cqNote.slice(0, 80),
    )
    check(
      '★★★ 而且**不许**再写成「与游戏内无关 / 游戏内发不出指令」（那是错话，用户照着它会一头雾水）',
      !/与游戏内无关/.test(cqNote) && !/游戏内发不出/.test(cqNote),
    )
    check(
      '★★ 两个开关的分工要写着**听不听 vs 动不动**（否则用户永远分不清该开哪个）',
      /听不听/.test(cqNote) && /动不动/.test(cqNote),
    )
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 接线：发布脚本**真的**用了这些检查（纯函数测过 ≠ 接线做了）')
// ══════════════════════════════════════════════════════════════════════════
{
  const scriptPath = join(PKG_ROOT, 'scripts', 'assemble-release.mjs')
  check('发布脚本存在', existsSync(scriptPath))
  const text = existsSync(scriptPath) ? readFileSync(scriptPath, 'utf8') : ''
  check('★★ 它 import 了受保护清单模块', /from\s+['"][^'"]*protected-files\.mjs['"]/.test(text))
  check('★★ 它在组装**之前**调用了输入端审计', /auditReleaseInputs\s*\(/.test(text))
  check('★★ 它把审计结果当**阻断**用（不是只打印一句）',
    /audit\.ok/.test(text) && /process\.exit\(1\)/.test(text.slice(text.indexOf('auditReleaseInputs'))))
  check('★ 它删目录前也做了检查', /classifyDeleteTarget\s*\(/.test(text))
  check('★ 门禁**没有 --force 后门**（否则等于没有这道门）',
    !/audit\.ok[\s\S]{0,200}FORCE/.test(text))
  check('  版本号仍是单一来源（从 package.json 读）', /pkg\.version/.test(text) && !/const\s+VERSION\s*=\s*['"]\d/.test(text))

  // ── 0.2.2：技能目录进包带来的两条新风险，各自钉一条断言 ────────────────
  //
  // ① `skills/` 现在会进发布包（里面是外部技能），而桥接启动时会在
  //    `skills/node_modules/` 里建**软链**（指向 vendor/node_modules）——
  //    链的是**开发机的绝对路径**，进包就是死链。所以组装时必须排除它。
  check('★★ 组装 release 时排除了 skills/node_modules（软链不进包）',
    /d === 'skills'[\s\S]{0,160}node_modules/.test(text))
  // ② 验收脚本对 node_modules 的放行必须**锚定到 vendor/ 前缀**。
  //    第一版写的是"包名在白名单里就放行"，于是 `skills/node_modules/undici`
  //    也会被放行 —— 那正是 ① 想防的东西。这条断言防它再被放松回去。
  const checkerPath = join(PKG_ROOT, 'scripts', 'check-release-package.mjs')
  const checker = existsSync(checkerPath) ? readFileSync(checkerPath, 'utf8') : ''
  check('★★ 验收脚本把 node_modules 限制在 vendor/ 下（锚定前缀，不是按包名放行）',
    /VENDOR_PKG_ALLOW\s*=\s*\/\^vendor\\\/node_modules/.test(checker) && /\(ws\|undici\)/.test(checker))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ 批处理启动器：`if (` 块里的裸 `)` 会让启动器在**成功路径上也**崩掉')
// ══════════════════════════════════════════════════════════════════════════
{
  // 真机事故（2026-10-03 实机测试报告 BUG-4）：
  //   `start.bat` 的成功分支里有一行 `echo [!] Could not start (exit %EXITCODE%) -- …`。
  //   cmd 在**解析期**就把 `( … )` 块读完，块内那个裸 `)` 提前闭合了它，
  //   剩下的 `-- see the message above.` 被当成新命令 ⇒ 启动器以 255 中止。
  //   实测最反直觉的一点：**即使 if 条件为假、走 else 分支，也照样崩** ——
  //   所以"机器人明明起来了，窗口却报错"和"机器人没起来，窗口什么都不说"是同一个 bug。
  //
  // 这里把当时实测过的每一种写法都钉一条断言（含"不该报"的那些）——
  // 判据错成"块内所有括号都报"就会把 `for %%i in (…）` 这类正常写法一起禁掉。
  const CR = '\r\n'
  const bat = (body) => `@echo off${CR}${body}`
  const cases = [
    ['块内 `echo A (paren) B` → 报', bat(`if 1==1 (${CR}  echo A (paren) B${CR})${CR}echo AFTER`), 1],
    ['块内 `echo A ) B` → 报', bat(`if 1==1 (${CR}  echo A ) B${CR})${CR}echo AFTER`), 1],
    ['嵌套块内的 `(paren)` → 报', bat(`if 1==1 (${CR}  if 2==2 (${CR}    echo A (x) B${CR}  )${CR})`), 1],
    ['块尾 `)` 后面接命令（`) echo Y`）→ 报', bat(`if 1==1 (${CR}  echo X${CR}) echo Y`), 1],
    ['★ 事故原文的那一行 → 报', bat(`if not "%EXITCODE%"=="0" (${CR}  echo [!] Could not start (exit %EXITCODE%) -- see the message above.${CR})`), 1],
    ['块内只有左括号 `echo A (B` → 不报（实测正常）', bat(`if 1==1 (${CR}  echo A (B${CR})`), 0],
    ['块内单行 `if 2==2 ( echo Y )` → 不报（实测正常）', bat(`if 1==1 (${CR}  if 2==2 ( echo Y )${CR})`), 0],
    ['块内 `for %%i in (a b) do` → 不报（实测正常）', bat(`if 1==1 (${CR}  for %%i in (a b) do echo %%i${CR})`), 0],
    ['一行关两层块 `))` → 不报（实测正常）', bat(`if 1==1 (${CR}  if 2==2 (${CR}    echo X${CR}))`), 0],
    ['块尾 `) & echo Y` → 不报（实测正常）', bat(`if 1==1 (${CR}  echo X${CR}) & echo Y`), 0],
    ['双引号里的括号 → 不报（实测正常）', bat(`if 1==1 (${CR}  echo A "(paren)" B${CR})`), 0],
    ['`^` 转义过的括号 → 不报（实测正常）', bat(`if 1==1 (${CR}  echo A ^(paren^) B${CR})`), 0],
    ['rem 行里的括号 → 不报（cmd 不看 rem）', bat(`if 1==1 (${CR}  rem comment (paren) here${CR}  echo OK${CR})`), 0],
    ['★ 顶层 `echo A (paren) B` → 不报（实测正常）', bat(`echo A (paren) B${CR}echo AFTER`), 0],
    ['★ 顶层单独一行 `)` → 不报（实测正常）', bat(`)${CR}echo AFTER`), 0],
  ]
  for (const [name, text, expected] of cases) {
    const hits = findBatchParenHazards(text)
    check(name, hits.length === expected, `命中 ${hits.length} 处（期望 ${expected}）`)
  }
  check('  隐患信息里给了行号与修法（否则用户不知道改哪儿）',
    (() => {
      const [h] = findBatchParenHazards(cases[4][1])
      return h?.line === 3 && /删掉括号|\^\\\)/.test(batchHazardMessage('start.bat', h))
    })())

  // ★ 行级守卫：发布包里每一个 `.bat` 都必须是干净的。
  //   为什么值得单列：这些启动器**只会在用户机器上被双击**，本地测试从来不会执行它们，
  //   所以"从没跑过"是常态 —— 静态扫一遍是唯一能在发布前发现它的办法。
  const batFiles = ['start.bat', 'sticker-label/启动标注.bat', 'sticker-label/预热缩略图.bat', 'chat-review/启动评审.bat']
  for (const rel of batFiles) {
    const full = join(PKG_ROOT, ...rel.split('/'))
    if (!existsSync(full)) {
      check(`  ${rel} 存在（没在扫空气）`, false, '文件不存在')
      continue
    }
    const hits = findBatchParenHazards(readFileSync(full, 'utf8'))
    check(`★ ${rel} 没有会让 cmd 提前闭合括号块的行`,
      hits.length === 0,
      hits.map((h) => batchHazardMessage(rel, h)).join(' | '))
  }

  // 接线：发布包验收脚本必须**真的**调用它（纯函数测过 ≠ 接线做过）
  const checkerPath2 = join(PKG_ROOT, 'scripts', 'check-release-package.mjs')
  const checker2 = existsSync(checkerPath2) ? readFileSync(checkerPath2, 'utf8') : ''
  check('★★ 发布包验收脚本调用了括号检查（否则这道门只存在于测试里）',
    /findBatchParenHazards\s*\(/.test(checker2) && /batchHazardMessage\s*\(/.test(checker2))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑦ ★ 包内路径引用：`src/**` 要用到的东西必须在包里（BUG-1 那一整类）')
// ══════════════════════════════════════════════════════════════════════════
{
  // 真机事故（2026-10-03 实机测试报告 BUG-1）：`src/ui-status.mjs` 顶层
  // `require(join(PKG_ROOT, 'scripts', 'ui-build-stamp.cjs'))`，而发布包**不含 `scripts/`**
  // ⇒ 用户机器上 `start.bat` 直接 `Cannot find module '…\scripts\ui-build-stamp.cjs'`，
  // **桥接从未启动**；更坏的是 `--check` 不 import 那个模块，所以"自检全绿、启动就崩"。
  // 报告把"加一条这样的发布前置断言"列为价值最高的一步 —— 它能一次消灭整类问题。
  const bug1 = scanSourceForPackageRefs({
    text: [
      "import { createRequire } from 'node:module'",
      "const require = createRequire(import.meta.url)",
      "const { computeUiSourceHash } = require(join(PKG_ROOT, 'scripts', 'ui-build-stamp.cjs'))",
    ].join('\n'),
    fileRel: 'src/ui-status.mjs',
  })
  check('★ 认出 `require(join(PKG_ROOT, …))` 这条引用（事故原文的形状）',
    bug1.refs.length === 1 && bug1.refs[0].rel === 'scripts/ui-build-stamp.cjs',
    JSON.stringify(bug1.refs))
  check('  行号指得准（37 行那种要能定位）', bug1.refs[0].line === 3, String(bug1.refs[0].line))

  // 目录 / 运行期产物 / 豁免项：都**不该**被断言（否则这道门天天误报，下次就没人看它）
  const mixedText = [
    "const a = join(PKG_ROOT, 'logs')",
    "const b = join(DIRS.logs, 'bridge.log')",
    "const c = join(PKG_ROOT, 'vendor', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')",
    "const d = join(PKG_ROOT, 'scripts', 'ui-build-stamp.cjs')",
  ].join('\n')
  const dirOfLogs = (k) => (k === 'logs' ? 'logs' : null)
  const mixed = scanSourceForPackageRefs({ text: mixedText, fileRel: 'src/x.mjs', dirOf: dirOfLogs })
  const audit = auditPackageRefs({
    files: ['src/x.mjs'],
    read: () => mixedText,
    exists: () => false, // 故意"包里什么都没有"，看它到底断言了哪几条
    dirOf: dirOfLogs,
  })
  check('  `DIRS.logs` 这类键会被翻译成包内目录',
    mixed.refs.some((r) => r.rel === 'logs/bridge.log' && r.kind === 'DIRS.logs'),
    JSON.stringify(mixed.refs.map((r) => r.rel)))
  check('★ 只断言"模块文件"（.mjs/.cjs/.js/.json）：目录与 .log 之类不参与',
    audit.asserted === 1 && audit.notAsserted === 2 && audit.exempted === 1,
    JSON.stringify({ asserted: audit.asserted, notAsserted: audit.notAsserted, exempted: audit.exempted }))
  check('★★ 只有真模块文件那条被断言（目录 `logs` 不算、运行期 `.log` 不算、豁免项不算）',
    audit.missing.length === 1 && audit.missing[0].endsWith('scripts/ui-build-stamp.cjs'),
    JSON.stringify(audit.missing))
  check('  豁免项（vendor/dsh/…）单独计数、不混进"断言"里',
    auditPackageRefs({
      files: ['src/y.mjs'],
      read: () => "const c = join(PKG_ROOT, 'vendor', 'dsh', 'x.mjs')",
      exists: () => false,
    }).exempted === 1)
  check('★★ 注释里的引用**不算**（事故记录/示例代码会被正当写进注释，误报会让这道门失去意义）',
    scanSourceForPackageRefs({
      text: "// 以前是 require(join(PKG_ROOT, 'scripts', 'ui-build-stamp.cjs'))\nconst real = 1",
      fileRel: 'src/x.mjs',
    }).refs.length === 0)
  check('★★ 豁免是有记录、有理由的（DSH/SnowLuma/锚点各一条，不当消音器用）',
    DEFAULT_EXEMPT.length === 3 && DEFAULT_EXEMPT.every((e) => e.why && e.why.length > 8),
    DEFAULT_EXEMPT.map((e) => e.prefix).join(' / '))

  // 相对说明符（动态 import / require）与静态 import 都要能解析成包内路径
  // ⚠️ 说明符**拼出来**再喂给被测函数：写成字面量的话，`mocks/verify-imports.mjs` 会把本文件
  //    自己的测试夹具当成真导入去核对（它已经抓到过一次，红在那里 —— 那条守卫本身没错）。
  const spec = (p) => `'${p}'`
  const rel = scanSourceForPackageRefs({
    text: [
      `const m = await import(${spec('./ui-status.mjs')})`,
      `import { x } from ${spec('./local.mjs')}`,
      `const r = require(${spec('../mcp/mcp-qq-server.mjs')})`,
    ].join('\n'),
    fileRel: 'src/index.mjs',
  })
  check('  动态 import 解析成包内路径', rel.refs.some((r) => r.rel === 'src/ui-status.mjs'))
  check('  静态 import 也算（它同样会在包里缺文件时炸）', rel.refs.some((r) => r.rel === 'src/local.mjs'))
  check('  `../` 能正确回退一层', rel.refs.some((r) => r.rel === 'mcp/mcp-qq-server.mjs'))

  // 变量拼接抽不出来 → 必须**数出来**，不能假装没问题
  const dyn = scanSourceForPackageRefs({
    text: "const p = join(PKG_ROOT, name)\nconst q = join(DIRS.logs, fileName)",
    fileRel: 'src/x.mjs',
    dirOf: () => 'logs',
  })
  check('★★ 变量拼接会被计数（"静态判不了"这件事必须可见）', dyn.skipped === 2, String(dyn.skipped))

  // ★★ 真实源码树：用**近似发布包**的存在性判据跑一遍（真包在时用真包）
  const ASSEMBLE = join(PKG_ROOT, 'scripts', 'assemble-release.mjs')
  const NOT_SHIPPED = ['config-ui/src/', 'mocks/', 'scripts/', 'docs/', 'reference/', 'tools/', 'cache/', 'runtime/', 'logs/', 'workspace-qq/', 'snowluma/']
  const releaseRoot = (() => {
    const rel = join(PKG_ROOT, '..', '..', '_release')
    if (!existsSync(rel)) return null
    // ★ 必须挑**当前版本**那个包：按字母序取最后一个会挑到上一版（0.3.0beta），
    //   于是新版才加的模块会被报成"缺失" —— 那种误报比不查还坏（会让人开始怀疑这道门）。
    const version = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version
    const want = `InteractiveBot-${version}-win-x64`
    const dir = join(rel, want)
    return existsSync(join(dir, 'src', 'index.mjs')) ? dir : null
  })()
  const srcFiles = []
  const walkMjs = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walkMjs(join(dir, e.name), `${prefix}${e.name}/`)
      else if (e.name.endsWith('.mjs')) srcFiles.push(`${prefix}${e.name}`)
    }
  }
  for (const top of ['src', 'mcp']) walkMjs(join(PKG_ROOT, top), `${top}/`)
  const realAudit = auditPackageRefs({
    files: srcFiles,
    read: (r) => readFileSync(join(PKG_ROOT, r.replace(/\//g, sep)), 'utf8'),
    exists: releaseRoot
      ? (r) => existsSync(join(releaseRoot, ...r.split('/')))
      : (r) => existsSync(join(PKG_ROOT, ...r.split('/'))) && !NOT_SHIPPED.some((p) => r.startsWith(p)),
    dirOf: (key) => {
      const dirs = {
        vendor: 'vendor',
        vendorNodeModules: 'vendor/node_modules',
        vendorNode: 'vendor/node',
        vendorDsh: 'vendor/dsh',
        vendorSnowluma: 'vendor/snowluma',
        src: 'src',
        mocks: 'mocks',
        logs: 'logs',
        skills: 'skills',
        personas: 'personas',
        defaultWorkspace: 'workspace-qq',
      }
      return dirs[key] ?? null
    },
  })
  check(
    `★★ 当前 src/ + mcp/ 里的 ${realAudit.asserted} 条模块引用都能在`
      + `${releaseRoot ? '真实发布包里' : '（近似）包形态里'}找到 —— BUG-1 那一类现在是空的`,
    realAudit.missing.length === 0,
    realAudit.missing.join(' | ') || `（判据：${releaseRoot ? `真包 ${releaseRoot.split(sep).pop()}` : '工作区近似'}）`,
  )
  check('  这一步确实在判东西（断言数不为 0，别是"扫了个寂寞"）', realAudit.asserted > 100, String(realAudit.asserted))
  check('  assemble-release 里那份"要拷什么"的清单仍然存在（判据的来源没被删）', existsSync(ASSEMBLE))

  // 接线：发布包验收必须真的调用它
  const checkerForRefs = existsSync(join(PKG_ROOT, 'scripts', 'check-release-package.mjs'))
    ? readFileSync(join(PKG_ROOT, 'scripts', 'check-release-package.mjs'), 'utf8')
    : ''
  check('★★ 发布包验收脚本调用了包内路径引用核对', /auditPackageRefs\s*\(/.test(checkerForRefs))
}

console.log('')
if (failed === 0) {
  console.log(`🎉 发布与升级卫生检查全部通过（${passed} 项）`)
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
