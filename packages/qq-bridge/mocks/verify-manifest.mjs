#!/usr/bin/env node
/**
 * 包契约测试：`PROJECT.json` 和 `AGENT.md` 里写的东西，**是不是真的**。
 *
 * ── 为什么需要这个 ─────────────────────────────────────────────────────
 * 这个包的目标之一是"任何 DSH 打开它都能看懂怎么跑"。但**说明书会撒谎** ——
 * 不是故意的，是代码改了、文档忘了同步。等有人（或某个 agent）照着说明书
 * 跑，才发现命令早就不存在了，那时排查成本很高。
 *
 * 所以这里把"文档说了什么"变成可执行的断言：
 *   · 清单里声明的文件/目录/命令 → 必须真的存在
 *   · 清单里列出的配置键          → 必须真的在 config.json 里
 *   · 清单里的不变量              → 抽样断言它们仍成立
 *   · AGENT.md 里的命令           → 必须真的能解析到对应文件
 *
 * 用法：node mocks/verify-manifest.mjs
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
/** 仓库根（往上找到 `.git` 所在的那层）。 */
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')

let failures = 0
// ★ 断言总数：原先只打印「全部通过」、不打印项数 ⇒ PROJECT.json 里那些「N 项断言」
//   的数字**没法用机器核对**，只能人手求和 —— 而它已经漂了（见 README 里的旧数字）。
let total = 0
function check(name, ok, detail = '') {
  total += 1
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}

/**
 * 「仓库里有没有悄悄少文件」——这一类缺陷最阴：`git status` 干干净净，
 * 而 `git clone` 出来的仓库构建不出界面。
 *
 * ★ 这不是假想的：`.gitignore` 里一条无路径锚点的 `lib/`（本意防编译产物）
 *   把 `config-ui/src/lib/` 整个挡掉了，于是 `api.ts`（界面调用后端的客户端）、
 *   `config.ts`、`utils.ts` **三个文件不在仓库里**，而 `src/**` 其它 70 多个
 *   文件都在。没人会发现，直到有人真去 clone。
 *
 * 所以断言：`config-ui/src` 下**每一个**文件都必须被 git 跟踪。
 *
 * ⚠️ 环境限制：受限沙箱可能不允许 spawn。那种情况下**明确说跳过**，
 *    不伪装成通过（同 harness.mjs 的口径）。
 */
function checkUiSourceTracked() {
  const srcDir = join(PKG_ROOT, 'config-ui', 'src')
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full, out)
      else if (e.isFile()) out.push(full)
    }
    return out
  }
  if (!existsSync(srcDir)) {
    check('config-ui/src 存在（界面源码在项目里）', false, srcDir)
    return
  }
  const all = walk(srcDir)
  let tracked
  try {
    tracked = new Set(
      execFileSync('git', ['ls-files', '--', 'packages/qq-bridge/config-ui/src'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.replace(/\\/g, '/')),
    )
  } catch (error) {
    console.log(
      `\n⏭️  跳过「UI 源码是否入库」检查：本环境跑不了 git（${error?.code ?? error?.message}）。` +
        `\n   这不是"通过" —— 请在正常环境里重跑。`,
    )
    return
  }
  const repoPrefix = `${resolve(REPO_ROOT).replace(/\\/g, '/')}/`
  const missing = all
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => !tracked.has(p.replace(repoPrefix, '')))
  check(
    `★ config-ui/src 下 ${all.length} 个源码文件**全部**被 git 跟踪（clone 才构建得出来）`,
    missing.length === 0,
    missing.length
      ? `没入库：${missing.map((m) => m.replace(/^.*config-ui\//, 'config-ui/')).join('、')}` +
        '（多半是 .gitignore 里某条无锚点规则误伤；用 git check-ignore -v 看是哪条）'
      : '',
  )
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

const manifestPath = join(PKG_ROOT, 'PROJECT.json')
const agentPath = join(PKG_ROOT, 'AGENT.md')
const configPath = join(PKG_ROOT, 'config.json')

section('契约文件存在且可解析')
check('PROJECT.json 存在', existsSync(manifestPath))
check('AGENT.md 存在', existsSync(agentPath))

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  check('PROJECT.json 是合法 JSON', true)
} catch (error) {
  check('PROJECT.json 是合法 JSON', false, error.message)
  console.log('\n⚠️ 清单解析失败，后续检查跳过\n')
  process.exit(1)
}

let config
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'))
  check('config.json 是合法 JSON', true)
} catch (error) {
  check('config.json 是合法 JSON', false, error.message)
  process.exit(1)
}

const agentText = readFileSync(agentPath, 'utf8')

// ══════════════════════════════════════════════════════════════════════════
section('清单声明的文件与目录真实存在')
// ══════════════════════════════════════════════════════════════════════════
{
  const missingFiles = Object.keys(manifest.files).filter((f) => !existsSync(join(PKG_ROOT, f)))
  check(`清单声明的 ${Object.keys(manifest.files).length} 个文件都存在`, missingFiles.length === 0,
    missingFiles.join(', '))

  const missingDirs = Object.keys(manifest.directories).filter((d) => !existsSync(join(PKG_ROOT, d)))
  // vendor/ 与 workspace-qq 可能尚未生成（setup / 首次启动才创建），单独放宽
  const optional = new Set(['vendor/', 'workspace-qq/', 'logs/'])
  const realMissing = missingDirs.filter((d) => !optional.has(d))
  check(`清单声明的目录都存在（可选目录除外）`, realMissing.length === 0,
    realMissing.join(', ') || `未生成的可选项：${missingDirs.filter((d) => optional.has(d)).join(', ') || '无'}`)
}

// ══════════════════════════════════════════════════════════════════════════
section('清单里每条命令都能解析到真实文件')
// ══════════════════════════════════════════════════════════════════════════
{
  const bad = []
  for (const entry of manifest.commands) {
    // 从命令行里挑出看起来像文件路径的片段
    const tokens = entry.cmd.split(/\s+/)
    for (const token of tokens) {
      if (!/\.(mjs|js|json)$/.test(token)) continue
      if (!existsSync(join(PKG_ROOT, token))) bad.push(`${entry.cmd} → ${token}`)
    }
  }
  check(`${manifest.commands.length} 条命令引用的文件都存在`, bad.length === 0, bad.join(' | '))
}

// ══════════════════════════════════════════════════════════════════════════
section('清单列出的配置键真的在 config.json 里')
// ══════════════════════════════════════════════════════════════════════════
{
  const missing = []
  const skippedOptional = []
  for (const spec of manifest.config.keys) {
    const parts = spec.key.split('.')
    let cur = config
    let found = true
    for (const part of parts) {
      if (cur === null || typeof cur !== 'object' || !(part in cur)) {
        found = false
        break
      }
      cur = cur[part]
    }
    if (!found) {
      // ★ 标了 `optional: true` 的键**允许不在 config.json 里**。
      //   理由：这类键在代码侧有明确的缺省回退（例如 dsh.apiKey → 空串 →
      //   再回退环境变量与凭据文件），写不写都能跑。把"可选"当成"必须存在"，
      //   会把一次正常的精简配置误报成契约损坏 —— 而假红同样会训练人忽略红色。
      if (spec.optional === true) skippedOptional.push(spec.key)
      else missing.push(spec.key)
    }
  }
  check(
    `${manifest.config.keys.length} 个配置键都能在 config.json 找到（可选键 ${skippedOptional.length} 个不强制）`,
    missing.length === 0,
    missing.length ? `缺：${missing.join(', ')}` : '',
  )
}

// ══════════════════════════════════════════════════════════════════════════
section('不变量抽样复核（文档说"绝对不能改"，这里验证它确实还成立）')
// ══════════════════════════════════════════════════════════════════════════
{
  // ① 路径解析不得用 process.cwd()
  const localSrc = readFileSync(join(PKG_ROOT, 'src', 'local.mjs'), 'utf8')
  const usesCwd = /process\.cwd\(\)/.test(localSrc.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n'))
  check('★ src/local.mjs 的代码里没有 process.cwd()（注释里提到不算）', usesCwd === false)

  // ② persistMode 默认值不得是 danger-full-access
  check('★ dsh.permissionMode 的默认值不是 danger-full-access',
    config.dsh.permissionMode !== 'danger-full-access', config.dsh.permissionMode)

  // ③ session.instance 必须真的参与哈希
  const sidSrc = readFileSync(join(PKG_ROOT, 'src', 'session-id.mjs'), 'utf8')
  check('★ session-id.mjs 里 instance 参与了哈希输入', /tag/.test(sidSrc) && /update\(/.test(sidSrc))

  // ④ bridge 必须把 instance 传给 makeSessionId
  const bridgeSrc = readFileSync(join(PKG_ROOT, 'src', 'bridge.mjs'), 'utf8')
  check('★ bridge.mjs 调 makeSessionId 时传了 instance', /makeSessionId\([^)]*instance/s.test(bridgeSrc))

  // ⑤ 依赖必须走 vendor，不能直接 import 'ws'
  const onebotSrc = readFileSync(join(PKG_ROOT, 'src', 'onebot.mjs'), 'utf8')
  check("★ src/onebot.mjs 没有直接 import 'ws'（必须走 vendor）",
    !/^\s*import\s+WebSocket\s+from\s+'ws'/m.test(onebotSrc))

  // ⑤b ★ 「拉起 SnowLuma」的两条路必须都传 detect，且共用同一个工厂
  //
  // 为什么这条值得单独盯着：`startSnowluma` 的防重复启动是两步，第②步
  // （"3000 端口上应答的是不是**正确的那份**"）**只**依赖调用方传进来的
  // `detect`；不传就 `typeof detect !== 'function'` → 整段被静默跳过。
  // 真实发生过：`start.bat` 走的 `--snowluma` 分支漏传了 detect，
  // 于是 start.bat 少一道防线，而界面按钮却是好的 —— 两条路行为不同。
  //
  // 所以这里查两件事：
  //   ① index.mjs 里**每一处** startSnowluma 调用都给了 detect
  //   ② index.mjs **没有**再自己直接调 detectSnowluma（必须走 makeLaunchDetect，
  //      两边共用一份实现；各写一遍就是漏掉一边的根源）
  const indexSrc = readFileSync(join(PKG_ROOT, 'src', 'index.mjs'), 'utf8')
  const startCalls = indexSrc.match(/startSnowluma\(\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? []
  const withoutDetect = startCalls.filter((c) => !/detect\s*:/.test(c))
  check(
    `★ index.mjs 里 ${startCalls.length} 处 startSnowluma 调用都传了 detect（防重复启动第②步）`,
    startCalls.length >= 2 && withoutDetect.length === 0,
    withoutDetect.length ? `${withoutDetect.length} 处漏传：${withoutDetect.map((c) => c.slice(0, 60)).join(' | ')}` : `（${startCalls.length} 处都有）`,
  )
  // 注：这一条是**接线检查**（结构），语义正确性由 verify-apitest.mjs 里
  //     startSnowluma 的行为断言负责（connected / up-not-logged-in 不重复启动、
  //     auth-failed 要继续启动）。两条配合才完整，单独任何一条都会漏。
  const directDetect = (indexSrc.match(/detectSnowluma\s*\(/g) ?? []).length
  check(
    '★ index.mjs 不再自己直接调 detectSnowluma（两处必须都用 makeLaunchDetect 这一份实现）',
    directDetect === 0,
    directDetect ? `还有 ${directDetect} 处直接调用` : '（全部走工厂）',
  )
  const snowSrc = readFileSync(join(PKG_ROOT, 'src', 'snowluma.mjs'), 'utf8')
  check('★ snowluma.mjs 导出了 makeLaunchDetect', /export\s+function\s+makeLaunchDetect/.test(snowSrc))

  // ⑤c ★ `process.env.DSH_HOME` 必须赋值 `.home`，不能把**对象**赋进去
  //
  // 这条是被一个**真实残留物**逼出来的：包根下曾经出现一个名为
  // `[object Object]` 的目录，里面是一整套 `profiles/`（含 DSH 按 profile
  // 装好的几百个依赖）、`sessions/`、`storages/`。
  // 成因就是有人把 `process.env.DSH_HOME` 赋成了 `resolveDshHome()` 返回的
  // **对象**而不是它的 `.home` —— 环境变量只接受字符串，对象被隐式
  // `String()` 成 `"[object Object]"`，DSH 子进程就把这个相对名字当 home，
  // 在 cwd（= 包根）下现建了一整套。
  //
  // 为什么值得单独为它写一条断言：症状很隐蔽 —— 不报错、机器人照常回话，
  // 只是凭据文件与 profiles 都找不到了（下一步就是"不输出内容"），
  // 而磁盘上只多了一个名字很怪的目录，没人会联想到环境变量赋错类型。
  const badHomeAssign = /process\.env\.DSH_HOME\s*=\s*(?!.*\.home\b)[^=\n]+/m.test(indexSrc)
  check(
    '★ index.mjs 把 DSH_HOME 赋值成字符串（`.home`），不是对象 —— 否则会造出 [object Object] 目录',
    !badHomeAssign,
    badHomeAssign ? '发现可疑赋值：' + (indexSrc.match(/process\.env\.DSH_HOME\s*=[^\n]*/) ?? [])[0] : '（写法正确）',
  )
  check(
    '★ 仓库里没有残留的 [object Object] home 目录',
    !existsSync(join(PKG_ROOT, '[object Object]')),
    existsSync(join(PKG_ROOT, '[object Object]')) ? '包根下又出现了它（说明有代码把对象当 DSH_HOME 用了）' : '',
  )

  // ⑥ 管理员为空必须是 fail-closed
  //
  // ⚠️ 这一条**改写过三次**，历史本身就是教训：
  //   坑 1（太窄）：第一版死抠格式的正则，代码是对的却报 ❌。
  //   坑 2（被骗）：第二版直接在原文里找 `return false`，匹配到了**注释里**
  //                 描述这条规则的那句话 —— 用正则读代码时注释是最好的伪装。
  //   坑 3（搬了家）：第三版剥掉注释后扫 `#isAllowed` 的方法体。后来名单逻辑
  //                 **重构进了 `src/roster.mjs`**，那个方法被删了，扫描就
  //                 找不到方法体并报失败。
  //
  // 坑 3 之后彻底换了做法：**改成行为断言** —— 直接造 roster 看它怎么判。
  // 文本扫描是在"猜实现长什么样"，而行为断言只关心"它到底怎么判"：
  // 改变量名、换写法、挪文件都不会误报，也不会漏报。
  {
    const { createRoster, TIER } = await import('../src/roster.mjs')
    void bridgeSrc
    const empty = createRoster({ config: { access: { adminUsers: [], dmAllowlist: [], groupAllowlist: [] } } })
    const r1 = empty.decide({ kind: 'private', peerId: '100000001', senderId: '100000001' })
    check(
      '★ 管理员为空 → 谁都不能用（fail-closed）',
      r1.respond === false && empty.tierOfPrivate('100000001') === TIER.STRANGER,
      r1.reason,
    )
    check(
      '★ 私聊白名单为空 → 只有管理员能私聊（**不**退回「谁都能私聊」）',
      empty.tierOfPrivate('123456') === TIER.STRANGER,
      empty.tierOfPrivate('123456'),
    )
    const r2 = empty.decide({ kind: 'group', peerId: '999', senderId: '100000001' })
    check('★ 群白名单为空 → 所有群都不回', r2.respond === false, r2.reason)

    // 对照：名单填上后同样的人/群会被放行 —— 证明上面的 false 来自"空"，
    // 而不是逻辑恒假（少了这条对照，一个"永远返回 false"的实现也能通过）
    const filled = createRoster({
      config: { access: { adminUsers: ['100000001'], dmAllowlist: ['123456'], groupAllowlist: ['999'] } },
    })
    check(
      '对照：名单填上后会被放行（证明上面的 false 确实来自「空」）',
      filled.tierOfPrivate('100000001') === TIER.ADMIN &&
        filled.tierOfPrivate('123456') === TIER.USER &&
        filled.decide({ kind: 'group', peerId: '999', senderId: '123456' }).respond === true,
      `${filled.tierOfPrivate('100000001')}/${filled.tierOfPrivate('123456')}`,
    )
  }

  // ⑦ 清单声明的 fail-closed 语义与 config 注释一致
  check('★ config.json 里 adminUsers 非空（否则机器人不响应任何人）',
    Array.isArray(config.access.adminUsers) && config.access.adminUsers.length > 0,
    JSON.stringify(config.access.adminUsers))
}

// ══════════════════════════════════════════════════════════════════════════
section('AGENT.md 里的命令都能解析到真实文件')
// ══════════════════════════════════════════════════════════════════════════
{
  // 抓出形如 node xxx/yyy.mjs 或 npm test 的片段
  const cmds = [...agentText.matchAll(/(?:node|start\.bat)\s+([\w./-]+\.(?:mjs|js|json))/g)].map((m) => m[1])
  const unique = [...new Set(cmds)]
  const bad = unique.filter((f) => !existsSync(join(PKG_ROOT, f)))
  check(`AGENT.md 里引用的 ${unique.length} 个文件都存在`, bad.length === 0, bad.join(', ') || unique.join(', '))
}

// ══════════════════════════════════════════════════════════════════════════
section('README.md 也指向了新文档（三者不能各说各话）')
// ══════════════════════════════════════════════════════════════════════════
{
  const readme = readFileSync(join(PKG_ROOT, 'README.md'), 'utf8')
  check('README.md 提到了 AGENT.md', /AGENT\.md/.test(readme))
  check('README.md 提到了 PROJECT.json', /PROJECT\.json/.test(readme))
}

// ══════════════════════════════════════════════════════════════════════════
section('清单没有声明不存在的源文件（反向核对：src/ 里每个文件都被清单提到）')
// ══════════════════════════════════════════════════════════════════════════
{
  const srcFiles = readdirSync(join(PKG_ROOT, 'src')).filter((f) => f.endsWith('.mjs'))
  const undocumented = srcFiles.filter((f) => !Object.prototype.hasOwnProperty.call(manifest.files, `src/${f}`))
  check(`src/ 里 ${srcFiles.length} 个模块都在清单里有说明`, undocumented.length === 0,
    undocumented.join(', ') || '（全部已说明）')
}

// ══════════════════════════════════════════════════════════════════════════
section('仓库完整性：UI 源码不能有文件被 .gitignore 悄悄挡在库外')
// ══════════════════════════════════════════════════════════════════════════
checkUiSourceTracked()

// ══════════════════════════════════════════════════════════════════════════
section('版本号只有一个来源（四处必须一致）')
// ══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么值得一条断言：版本号散在**四个**地方（package.json / PROJECT.json /
//   MCP server info / RELEASE.md 里的包名），而升级版本时最容易"改了三个忘一个"。
//   症状是自相矛盾：包名写着 0.2.0、里面报的却是 0.1.0 —— 用户看到之后才会发现。
{
  const v = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')).version
  check('package.json 有版本号', typeof v === 'string' && v.length > 0, String(v))

  const projV = JSON.parse(readFileSync(join(PKG_ROOT, 'PROJECT.json'), 'utf8')).package?.version
  check('★ PROJECT.json 的 package.version 与 package.json 一致', projV === v, `${projV} vs ${v}`)

  const mcpSrc = readFileSync(join(PKG_ROOT, 'mcp', 'mcp-qq-server.mjs'), 'utf8')
  const mcpV = /SERVER_INFO\s*=\s*\{[^}]*version:\s*'([^']+)'/.exec(mcpSrc)?.[1]
  check('★ MCP server info 的 version 与 package.json 一致', mcpV === v, `${mcpV} vs ${v}`)

  const relMd = readFileSync(join(PKG_ROOT, 'RELEASE.md'), 'utf8')
  const names = [...new Set([...relMd.matchAll(/InteractiveRobot-([0-9][^-\s]*)-win-x64/g)].map((m) => m[1]))]
  check(
    '★ RELEASE.md 里的发布包名与 package.json 一致（且只有一种版本）',
    names.length === 1 && names[0] === v,
    names.join('、') || '（没找到 InteractiveRobot-*-win-x64）',
  )
}

// ══════════════════════════════════════════════════════════════════════════
section('★ CONFIG-UI.md 必须覆盖所有配置项（用户硬要求：涉及 UI 的改动就要更新它）')
// ══════════════════════════════════════════════════════════════════════════
{
  const uiText = readFileSync(join(PKG_ROOT, 'CONFIG-UI.md'), 'utf8')

  // 正向：PROJECT.json 声明的每个配置键，文档里都要出现。
  // 为什么要自动查而不是靠人记：UI 是照着这份文档生成的，
  // 文档落后一步 = UI 做出错误的东西，而且排查时两边各说各话。
  const declaredKeys = manifest.config.keys.map((k) => k.key)
  const declaredSet = new Set(declaredKeys)
  const missingInDoc = declaredKeys.filter((k) => !uiText.includes(k))
  check(
    `CONFIG-UI.md 覆盖了清单声明的 ${declaredKeys.length} 个配置键`,
    missingInDoc.length === 0,
    missingInDoc.length ? `缺：${missingInDoc.join(', ')}` : '（全部覆盖）',
  )

  // 更本质的一条：**归一化后真实存在的每个叶子键，都必须被清单登记**。
  //
  // 为什么需要（这不是假设，是踩过的）：`ui.apiEnabled` / `ui.apiPort` 曾经
  // 只存在于代码里、清单忘了登记，于是"清单→文档"的检查全绿，
  // 而 UI 根本不知道有这两个配置项。只查"清单声明的是否在文档里"会漏掉
  // **代码里有、清单没有** 这种情形 —— 必须有一条从代码出发的核对。
  // 归一化后的真实叶子键，用实际模块算（比正则可靠）
  const { normalizeConfig: normalizeForCheck } = await import('../src/config.mjs')
  const leafKeys = []
  const walkLeaves = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (k.startsWith('_')) continue
      const p = prefix ? `${prefix}.${k}` : k
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) walkLeaves(v, p)
      else leafKeys.push(p)
    }
  }
  walkLeaves(normalizeForCheck({}), '')
  // 有些键是刻意不暴露给 UI 的（例如测试专用开关）。
  // 它们必须在 PROJECT.json 的 config._hiddenKeys 里**显式列出** ——
  // 这样"新增配置但忘了登记"仍然会报错，而"刻意隐藏"是有记录的。
  const hiddenKeys = new Set(manifest.config._hiddenKeys ?? [])
  const notDeclared = leafKeys.filter((k) => !declaredSet.has(k) && !hiddenKeys.has(k))
  check(
    `★ 归一化后的 ${leafKeys.length} 个真实配置键都已登记或显式隐藏`,
    notDeclared.length === 0,
    notDeclared.length ? `漏登记：${notDeclared.join(', ')}` : `（已登记 ${leafKeys.length - hiddenKeys.size}，显式隐藏 ${hiddenKeys.size}）`,
  )

  // 反向：文档里提到的配置键必须真实存在（防止文档写了不存在的配置）
  const knownPrefixes = [
    'dsh', 'onebot', 'access', 'trigger', 'send', 'turn',
    'humanize', 'session', 'persona', 'memory', 'image', 'ui',
    // ★ 0.2.3 补：`wake`（唤醒策略二选一）与 `delivery`（投递账本）都是**真的配置键**，
    //   以前不在这个表里 ⇒ 反向核对（"文档提到的键必须存在"）对它们**根本没生效**。
    //   一个只在部分前缀上生效的检查比没有检查更危险：它会给出"文档已核对"的假象。
    'wake', 'delivery',
  ]
  const mentioned = [
    ...new Set(
      [...uiText.matchAll(/`([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)`/g)]
        .map((m) => m[1])
        .filter((k) => knownPrefixes.includes(k.split('.')[0])),
    ),
  ]
  const docOnly = mentioned.filter((k) => !declaredSet.has(k))
  check(
    '★ CONFIG-UI.md 没有提到不存在的配置键',
    docOnly.length === 0,
    docOnly.length ? `多余：${docOnly.join(', ')}` : `（提到 ${mentioned.length} 个，全部存在）`,
  )

  // 接口文档与实现对齐：**表格里声明**的 /api/* 路径必须真的在 api.mjs 里。
  //
  // ⚠️ 第一版这里是错的：它扫全文里的所有 `/api/xxx`，结果把
  // 「**为什么没有 `/api/start`**」这句解释也算成了"文档声称存在"，
  // 于是报了一个假的不一致。教训：用文本扫描做校验时，必须限定**语境**
  // （这里就是"只认表格行"），否则正确性取决于措辞，非常脆。
  //
  // ⚠️ 第二版又发现一个毛病：不加区分地要求"表格里的路径都存在"，等于
  // **禁止文档提前声明尚未实现的接口** —— 而那份表格是给 UI 生成者看的
  // 契约，提前声明正是它最有价值的用法。所以现在承认一个显式标记：
  // 行内含「待实现」= 只是约定，代码里允许暂时只有占位。
  //
  // ⚠️ 第三版修正：路径里**可以有斜杠**（`/api/snowluma/detect`）。
  // 原来写的是 `[a-z-]+`，只能匹配一段式路径，于是带子路径的接口虽然
  // 写进了表格却**完全没被校验到** —— 一个静默失效的检查项，比报错更危险。
  //
  // ⚠️ 第四版修正：说明列里**本来就有 `|`**（节号与说明是两列）。
  // 所以不能只取"反引号后面到第一个 | 为止"——那样说明列根本没被读到，
  // 「待实现」标记永远扫不到。改成取整行剩余部分。
  //
  // ⚠️ 第五版修正（靠"故意弄坏"自检发现的）：上面那套仍然漏检一种情况 ——
  // **文档声称某个接口已实现，但代码里其实只有占位**。因为占位路由同样让
  // `path === '/api/xxx'` 出现在代码里，"路径存在"这一条就满足了。
  // 所以把规则**统一成一句**（对称、没有缝）：
  //
  //     标了「待实现」的接口，代码里必须且只能调用 snowlumaNotImplemented()
  //
  // 由此推出：没标「待实现」的接口，代码里**不许**调用它。
  // 两种歪法就都被这一条抓住了。
  //
  // ⚠️ 第六版：接口全部落地后，占位函数从 `snowlumaNotImplemented` 改名成
  // `notImplemented`（它早就不只服务 SnowLuma 了）。这里必须跟着改 ——
  // 否则这个检查会**永远返回 false**，反向那条会假绿（又是"永远通过的检查"）。
  const apiSrc = readFileSync(join(PKG_ROOT, 'src', 'api.mjs'), 'utf8')
  const routeRows = [...uiText.matchAll(/^\|\s*(GET|POST|DELETE)\s*\|\s*`(\/api\/[a-z0-9/-]+)`(.+)$/gm)].map(
    (m) => ({ method: m[1], route: m[2], rest: m[3] }),
  )
  const tableRoutes = [...new Set(routeRows.map((r) => r.route))]
  const pendingRoutes = [
    ...new Set(routeRows.filter((r) => r.rest.includes('待实现')).map((r) => r.route)),
  ]

  const missingRoutes = tableRoutes.filter((r) => !apiSrc.includes(`'${r}'`))
  check(
    `★ CONFIG-UI.md 接口表里的 ${tableRoutes.length} 个路径都真实存在`,
    missingRoutes.length === 0,
    missingRoutes.length
      ? `缺：${missingRoutes.join(', ')}`
      : `${tableRoutes.join(', ')}${pendingRoutes.length ? `（其中 ${pendingRoutes.length} 个标了「待实现」）` : ''}`,
  )

  // 取出代码里真正派发出去的路径（`path === '/api/xxx'`），而不是"文本里出现过"。
  const dispatched = [...apiSrc.matchAll(/path === '(\/api\/[a-z0-9/-]+)'/g)].map((m) => m[1])
  void dispatched

  // ── 「待实现」标记 vs 代码真实状态 ─────────────────────────────────────
  //
  // ⚠️ 这一条改过很多版，最后**放弃了文本扫描**，理由是它从原理上做不到：
  //
  //   `api.mjs` 里"未实现"是用**两种技术**表达的：
  //     ① 早期的占位路由：分支体直接 `return notImplemented(...)`
  //     ② 现在的依赖注入：`if (!dep) return notImplemented(...)` 作为**兜底**，
  //        依赖注入进来时走真实现
  //   两者的文本长得很像（甚至一模一样），扫描分不出来 —— 实测它把 6 个
  //   **已经实现**的路由全报成了占位。
  //
  // 所以改成**行为检测**：造一个依赖齐全的 handler，把文档里声明的每条路由
  // 真的调一次；返回 501（或 body.pending）才算"还未实现"。
  // 这样验的是**行为**，不是措辞 —— 改注释、改名、换写法都不会让它误报。
  //
  // 依赖用具名桩，**不碰真实磁盘**：写操作落到临时目录，绝不碰 workspace-qq/。
  const probeDir = join(PKG_ROOT, '.tmp-manifest-probe')
  rmSync(probeDir, { recursive: true, force: true })
  mkdirSync(probeDir, { recursive: true })

  const probeRoutes = new Map()
  try {
    const { createApiHandler: mk } = await import('../src/api.mjs')
    const { createPriceBook: mkPrices } = await import('../src/prices.mjs')
    const { createUsageLedger: mkLedger } = await import('../src/usage.mjs')
    const { createMemoryStore: mkMemory } = await import('../src/memory-files.mjs')

    const prices = mkPrices({ file: join(PKG_ROOT, 'prices.json') })
    const probeHandler = mk({
      configPath: join(probeDir, 'config.json'),
      readRawConfig: () => ({}),
      writeRawConfig: () => {},
      normalize: (c) => c,
      validate: () => ({ fatal: [], warn: [] }),
      getStatus: () => ({ running: true }),
      getConversations: () => [],
      runDoctor: async () => ({ fatal: [], warn: [], rows: [] }),
      priceBook: prices,
      usageLedger: mkLedger({ file: join(probeDir, 'usage.jsonl'), priceBook: prices }),
      memoryStore: mkMemory({ workspace: probeDir }),
      // 取图路由（/api/workspace-file、/api/inbox）也要注入，
      // 否则探测里走 notImplemented → 被误报成"文档谎称已实现"
      workspaceRoot: probeDir,
      detectSnowluma: async () => ({ status: 'offline' }),
      // ⚠️ 名字必须与 api.mjs 里实际调用的一致（现在是 openSnowlumaConsole）。
      // 用错了名字 → 那条路由会走 notImplemented → 契约测试报"文档谎称已实现"。
      // （这条检查就是这么抓到这个不一致的：按钮改语义时我漏了这一处。）
      openSnowlumaConsole: async () => ({ ok: true, data: { opened: true } }),
      snowlumaLog: { read: () => ({ ok: true, data: { available: false, lines: [] } }) },
      // 名单接口也要注入，否则那条路由在探测里走 notImplemented → 被误报成"文档谎称已实现"
      roster: { fetchLists: async () => ({ friends: [], groups: [] }) },
      onebotCall: async () => [],
      // 扩展接口（0.2.2）同样要注入 —— 否则那四条路由在探测里走 notImplemented，
      // 会被报成"文档谎称已实现"（这条检查就是这么抓漏注入的）。
      listExtensions: () => ({ skills: [], plugins: [], counts: {} }),
      toggleExtension: async () => ({ hot: true, restartRequired: false }),
      saveSkillSettings: async () => ({ id: 'probe' }),
      diagnoseSkill: async () => ({ id: 'probe', report: {} }),
      // 表情包「重新打标签」（0.2.4）也要注入 —— 否则那两条路由在探测里走 notImplemented，
      // 会被报成"文档谎称已实现"（这条检查就是这么抓漏注入的，已经抓到第三次了）。
      stickerRetag: async () => ({ phase: 'idle', total: 0, done: 0 }),
      // 人设库接口（0.2.2）同样要注入，否则那两条路由在探测里走 notImplemented
      personasList: () => ({ dir: 'personas', personas: [], active: '', template: '', maxChars: 4000 }),
      personasAction: async () => ({ ok: true, action: 'create', restartRequired: false }),
      // 联系人昵称（0.2.2）
      contactsList: () => ({ rel: 'memory/contacts.md', contacts: [], bad: [], max: 200 }),
      contactsSave: () => ({ saved: true, restartRequired: false, contacts: [] }),
      requestRestart: () => {},
      requestStop: () => {},
      powerUpdateDelayMs: 0,
    })

    for (const row of routeRows) {
      const res = await probeHandler({ method: row.method, path: row.route })
      probeRoutes.set(`${row.method} ${row.route}`, res?.status === 501 || res?.body?.pending === true)
    }
  } catch (error) {
    check('（接口行为探测能跑起来）', false, `探测失败：${error.message}`)
  } finally {
    rmSync(probeDir, { recursive: true, force: true })
  }

  /** 某条路由是否还是占位。用行为判定；探测不到就当"未知"，交给"路径都存在"那条报。 */
  const isPlaceholder = (method, route) => probeRoutes.get(`${method} ${route}`) ?? false
  const routeRowsFor = (route) => routeRows.filter((r) => r.route === route)

  // 正向：标了「待实现」的，代码里必须还是占位。
  const staleMarkers = pendingRoutes.filter((route) => !routeRowsFor(route).some((r) => isPlaceholder(r.method, route)))
  check(
    '★ 标了「待实现」的接口，代码里确实还只是占位',
    staleMarkers.length === 0,
    staleMarkers.length
      ? `已实现但文档还标着待实现：${staleMarkers.join(', ')} —— 请把表格里的「待实现」删掉`
      : pendingRoutes.length
        ? `（${pendingRoutes.join(', ')}）`
        : '（当前没有待实现标记）',
  )

  // 反向：没标「待实现」的，代码里不许是占位（否则就是文档谎称已实现）。
  // 同路径多方法时，**只要有一条是真实现**就算已实现（GET 读 + POST 写很常见）。
  const falseClaims = tableRoutes.filter((route) => {
    if (pendingRoutes.includes(route)) return false
    const rowsForRoute = routeRowsFor(route)
    return rowsForRoute.length > 0 && rowsForRoute.every((r) => isPlaceholder(r.method, route))
  })
  check(
    '★ 没标「待实现」的接口，代码里不是占位（文档没谎称已实现）',
    falseClaims.length === 0,
    falseClaims.length
      ? `文档声称已实现、代码里其实还是占位：${falseClaims.join(', ')} —— 请在表格里补上「待实现」`
      : `（已实现 ${tableRoutes.length - pendingRoutes.length} 个，均无占位）`,
  )
}

console.log(`\n${failures === 0 ? `🎉 包契约与代码一致（${total} 项）` : `⚠️ ${failures} 项不一致 —— 文档需要同步（共 ${total} 项）`}\n`)
process.exit(failures === 0 ? 0 : 1)
