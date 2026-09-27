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

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

console.log('')
if (failed === 0) {
  console.log(`🎉 发布与升级卫生检查全部通过（${passed} 项）`)
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
