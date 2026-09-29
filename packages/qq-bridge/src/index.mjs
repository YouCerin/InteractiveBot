/**
 * 桥接入口：把各个零件装配起来并跑起来。
 *
 * ── 启动顺序（顺序本身有讲究）──────────────────────────────────────────
 *   1. 读配置、做自检        ← 配置错了要在连任何东西之前就报出来
 *   2. 建工作区目录          ← 它是权限沙箱的根，必须真实存在
 *   3. 起 dsh 子进程 + initialize
 *   4. 连 QQ 事件通道
 *   5. 挂上桥接逻辑
 *   6. 等退出信号，优雅收尾
 *
 * 为什么先起 DSH 再连 QQ？因为"连上 QQ 但 DSH 没起来"是最糟的状态：
 * 用户发消息会得到一个连接超时，而且 QQ 端看起来一切正常。
 * 反过来先确保 DSH 就绪，QQ 连上就能用。
 *
 * 用法：
 *   node src/index.mjs                 # 正常启动
 *   node src/index.mjs --check         # 只做配置自检，不连任何东西
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, statSync, readdirSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { SdkRpcClient } from './sdk-rpc.mjs'
import { INSTANCE_ARG_PREFIX, createProcessGuard, runningBridges } from './process-guard.mjs'
import { OneBotClient, SendQueue } from './onebot.mjs'
import { SessionRouter } from './session-bridge.mjs'
import { Bridge } from './bridge.mjs'
import { makeSessionId } from './session-id.mjs'
import { PKG_ROOT, DIRS, resolveDshHome, resolveInPackage } from './local.mjs'
import { runDoctor, printDoctor } from './doctor.mjs'
import { normalizeConfig, validateConfig } from './config.mjs'
import { createApiHandler, serveApi } from './api.mjs'
import { writeMcpConfig, ensureSdkProfilePatch, writeSkillsMcpConfig } from './mcp-profile.mjs'
import { createPriceBook } from './prices.mjs'
import { createUsageLedger } from './usage.mjs'
import { createMemoryStore } from './memory-files.mjs'
import { saveSnapshot, dropSnapshot } from './memory-store.mjs'
import { createRoster } from './roster.mjs'
import { resolveDirectTarget } from './model-direct.mjs'
import { createRetagJob, preflightRetag } from './sticker-tagging.mjs'
import { resolveModelCredentials } from './credentials.mjs'
// ★ 不再直接 import `detectSnowluma` —— 所有探测都经 `makeLaunchDetect` 这一个工厂，
//   目的就是让"两条调用路径传的判据一致"变成结构上必然成立（见该函数的注释）。
import { startSnowluma, openSnowlumaConsole, resolveOnebotTokens, makeLaunchDetect, waitForSnowlumaReady } from './snowluma.mjs'
import { createSnowlumaLogReader } from './snowluma-log.mjs'
// ★ H13：账号发现（**只回摘要，绝不回 token**）与本地语料检索
import { discoverOnebotConfig, listAccountNames } from './token-discovery.mjs'
import { createCorpus } from './corpus.mjs'
import { sliceLogLines, splitLogText } from './log-tail.mjs'
import { searchMemoryFiles } from './memory-search.mjs'
import { readAllStats, STATS_DEFAULTS } from './memory-stats.mjs'
import { discoverSkills, loadSkill, describeSkill, callSkillDiagnose, ensureSkillNodeModules, isSkillEnabled, SKILL_API_VERSION } from './extensions.mjs'
import { createExtensionService } from './extensions-service.mjs'
import { listPlugins, BUILTIN_PLUGINS } from './plugins.mjs'
import { describePersonaShelf, applyPersonaAction, ensureDefaultPersonas } from './personas.mjs'
import { projectDocStatus } from './project-doc.mjs'
import { readContacts, writeContacts, summarizeContacts, CONTACTS_REL } from './contacts.mjs'
import { readPrivacyAudit, scanPrivacy, PRIVACY_CATEGORIES } from './privacy.mjs'
import { inspectMemory } from './memory-inspect.mjs'

// ── 日志：同时写控制台和文件 ──────────────────────────────────────────────
let logFile = null
/**
 * `logFile` 就绪之前产生的日志先攒在这里。
 *
 * ⚠️ 为什么必须有：`logFile` 是在启动流程**后段**才赋值的（见下面"日志文件"那段），
 *    而 MCP 接线、技能依赖桥这些**启动期**的告警都发生在它之前。
 *    桥接是**无窗口**运行的 —— 那些只进 console 的告警等于"写了没人看得见"，
 *    与"根本没写日志"一样糟（同一条教训见下面「模型凭据自检」的注释）。
 *
 *    实测（2026-09-27）：技能缺 undici 的告警正好落在这个窗口里，
 *    排查"P站插件为什么不动"时 logs/bridge.log 里一个字都没有。
 */
const earlyLogLines = []
/** 缓冲上限：正常启动远小于它；只防某种异常路径把内存吃掉。 */
const EARLY_LOG_MAX = 800
let logBomWritten = false

/**
 * 给日志文件写 UTF-8 BOM。
 *
 * ── 为什么需要这一步（真实踩到）────────────────────────────────────────
 * 日志内容是中文。Node 写文件默认是 **UTF-8 无 BOM**，而 Windows 的工具
 * （PowerShell 的 Get-Content、记事本、部分编辑器）在没有 BOM 时会按
 * **系统 ANSI 代码页（中文系统是 GBK）** 去解码 —— 结果就是满屏乱码：
 *
 *     2026-09-24 18:24:04 === 妗ユ帴鍚姩 === 宸ヤ綔鍖?...
 *
 * 用户是拿记事本看日志排查问题的，乱码等于没有日志。加一个 3 字节的 BOM
 * 就能让这些工具正确识别编码 —— 代价极小，收益是"日志真的能读"。
 */
function ensureLogBom(path) {
  if (logBomWritten) return
  logBomWritten = true
  try {
    if (!existsSync(path) || statSync(path).size === 0) {
      appendFileSync(path, '\uFEFF')
    }
  } catch {
    /* 写 BOM 失败不该影响主流程 */
  }
}

/**
 * 扫描并装载 `skills/` 里的外部技能（0.2.2）—— **只为提示词片段**。
 *
 * ⚠️ 工具的执行发生在**另一个进程**（`mcp/mcp-skills-server.mjs`），那边会自己
 * 再装载一次。这里装载一次的目的只有一个：拿到 `promptSections()`，好在每轮提示词里
 * 告诉模型"你还有这些本事"。所以这里传进去的 `registerTool` 是**空实现**。
 *
 * ── 为什么坏技能不阻断启动 ────────────────────────────────────────────────
 * 第三方技能写错是常态（清单少一个字段、入口路径写错、版本不匹配）。
 * 如果它能让桥接起不来，那"装个技能"就成了危险操作。所以：**坏的跳过并如实报出来**，
 * 好的照常工作；界面上也会显示"装是装了，但用不了，原因是…"。
 */
async function loadSkills({ config, log = () => {} }) {
  const scan = discoverSkills({ skillsDir: DIRS.skills })
  if (!scan.exists) return scan
  for (const skill of scan.skills) {
    if (!skill.ok) {
      log(`⚠️ 技能 ${skill.dirName} 装不上（已跳过）：${skill.errors.join('；')}`)
      continue
    }
    // 空实现的 registerTool：工具注册由 MCP 子进程负责，这里只要 promptSections
    await loadSkill(skill, { config, log: (m) => log(m), registerTool: () => {} })
    if (!skill.loaded) log(`⚠️ 技能 ${skill.id} 装载失败（已跳过）：${skill.loadError}`)
    else if (skill.warnings.length > 0) {
      for (const w of skill.warnings) log(`⚠️ [技能 ${skill.id}] ${w}`)
    }
  }
  const usable = scan.skills.filter((s) => s.ok && s.loaded).length
  if (scan.skills.length > 0) {
    log(`扩展技能：发现 ${scan.skills.length} 个，可用 ${usable} 个`)
  }
  return scan
}

/**
 * `--extensions`：把"装了哪些技能、装了哪些插件、各自什么状态"打出来。
 *
 * 为什么需要这个 CLI（而不是只在界面上看）：
 *   · 排障时机器人可能没在跑（界面也打不开）—— 这时要能一眼看出技能怎么了；
 *   · 它是"技能装对了吗"这个问题**唯一**的离线答案（含清单告警与工具清单）。
 */
async function printExtensions({ config, configPath, log = () => {} }) {
  // ★ 这里**故意用空日志**装载：本条命令的正文就是完整报告（含每一条告警），
  //   再让装载过程往上面喷一遍同样的告警，只会让同一句话说两次 ——
  //   CLI 的噪音也是成本（人会更早开始忽略输出）。
  const scan = await loadSkills({ config, log: () => {} })
  const service = createExtensionService({
    config,
    configPath,
    skills: scan.skills,
    skillsDir: scan.dir,
    log,
    validate: validateConfig,
    normalize: normalizeConfig,
  })
  const data = service.list()

  console.log(`\n技能目录：${data.skillsDir}${scan.exists ? '' : '（不存在 —— 还没有装任何技能）'}\n`)
  console.log(`── 技能（${data.counts.skills} 个，启用 ${data.counts.skillsEnabled} 个）──`)
  if (data.skills.length === 0) {
    console.log('  （空。把技能目录放到 skills/<id>/ 下即可，重启后生效。）')
  }
  for (const s of data.skills) {
    const state = !s.ready && s.errors.length > 0 ? '❌ 装不上' : s.enabled ? '✅ 已启用' : '⭕ 已关闭'
    console.log(`  ${s.icon} ${s.name}（${s.id} v${s.version}）${state}`)
    if (s.errors.length) for (const e of s.errors) console.log(`      ❌ ${e}`)
    for (const w of s.warnings) console.log(`      ⚠️ ${w}`)
    // 状态原因（为什么"开着却用不了"）：例如 MCP 总开关关着、依赖自检不过
    for (const r of s.reasons ?? []) console.log(`      ⚠️ ${r}`)
    if (s.tools.length) {
      console.log(`      工具：${s.tools.map((t) => `${t.fullName}${t.registered ? '' : '（未注册）'}`).join('、')}`)
    }
    if (s.promptSections.length) {
      console.log(`      提示词片段：${s.promptSections.map((p) => `${p.title}(${p.chars}字)`).join('、')}`)
    }
    // ★ 只有"清单里声明了工具、实际一个都没注册"才是问题。
    //   ⚠️ 0.2.4 修：原来只看 `tools.length === 0`，于是像「表情包」这种
    //   **刻意不要工具**的技能（它靠提示词约定 + 宿主判定工作，见
    //   `docs/插件设计规范.md` §7）每次巡检都会被打一条假的"检查 registerTool"。
    //   假告警的代价是真实的：用久了就没人再看这一行，真出问题时也看不见。
    //   ⚠️ 判据取的是卡片上的 `declaredToolCount`（`describeSkill` 给的），
    //   不是 `s.declaredTools` —— 卡片**没有**那个字段，写成它就会恒为 undefined，
    //   于是这条判断永远为真、假告警照旧（我第一版正是这么写的，实测才发现）。
    const declaredToolCount = Number.isFinite(Number(s.declaredToolCount)) ? Number(s.declaredToolCount) : null
    if (s.enabled && s.tools.length === 0 && declaredToolCount !== 0) {
      const hint = declaredToolCount == null ? '' : `（清单声明了 ${declaredToolCount} 个）`
      console.log(`      ⚠️ 已启用但一个工具都没有 ${hint}—— 检查 setup() 里的 registerTool`)
    }
  }

  console.log(`\n── 插件（${data.counts.plugins} 个，开启 ${data.counts.pluginsOn} 个）──`)
  for (const p of data.plugins) {
    // ★ 0.2.3：`choice`（二选一）不能被塞进"名单类"那一格 —— 它是**另一个种类**：
    //   名单是"去别处维护"，而二选一是"当前选了哪个"，后者**必须把取值打出来**，
    //   否则命令行上根本看不出它现在处于什么状态（`enabled` 恒为 null）。
    // ★ 0.2.7：`skill`（控件在技能卡上，例如表情包）同样不能被塞进"名单类" ——
    //   它不是名单，只是开关长在别处。而且**状态要照实打出来**（去找那张技能卡的
    //   当前开关值），否则命令行上会显示成"没开"，与事实相反。
    const owner =
      p.switchKind === 'skill' ? data.skills.find((s) => s.id === p.switchInSkill) : null
    const on =
      p.switchKind === 'choice'
        ? `—（二选一：${p.value ?? '未设置'}）`
        : p.switchKind === 'skill'
          ? `—（开关在技能卡上，当前 ${owner ? (owner.enabled ? '✅ 开' : '⭕ 关') : '? 找不到那张技能卡'}）`
          : p.enabled === null
            ? '—（名单类）'
            : p.enabled
              ? '✅ 开'
              : '⭕ 关'
    const hot = p.switchKind === 'list' ? '' : p.hot ? '｜即时生效' : '｜★ 需重启'
    console.log(`  ${p.icon} ${p.name}  ${on}${hot}  [${p.enabledPath}]`)
    // 候选与"实验性"标注也要打出来：命令行是排障入口，它不该比界面知道得更少
    if (p.switchKind === 'choice' && Array.isArray(p.options)) {
      for (const o of p.options) {
        const cur = o.value === p.value ? '←当前' : ''
        console.log(
          `       ${o.value === p.value ? '●' : '○'} ${o.value}（${o.label}）${o.experimental ? '【实验性】' : ''} ${cur}`.trimEnd(),
        )
      }
    }
  }
  console.log('')
  for (const n of data.notes) console.log(`  · ${n}`)
  console.log('')
  return data
}

/**
 * `--personas`：把"装了哪几套人设、现在用哪一套、各自多大"打出来（**只读**）。
 *
 * 为什么要有这个 CLI（与 `--extensions` 同样的理由）：
 *   · 人设是**构造期缓存**的，改完必须重启 —— 排障时机器人常常没在跑（界面也打不开），
 *     这时"到底哪一套在生效"只能靠命令行回答；
 *   · `persona.active` 指向一个**读不到的文件**时，桥接会大声报错但只报一行 ——
 *     这里能把"目录里现在有什么"一起摊开，一眼看出是删了还是改名了。
 */
function printPersonas({ config, configPath }) {
  // 读**盘上**那份配置（界面刚改完的口径）；读不到就回落启动时那份，别让命令整块空白。
  let raw = config
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    /* 用启动时那份 */
  }
  const shelf = describePersonaShelf({ dir: DIRS.personas, config: raw })
  console.log('')
  console.log(`人设库：${shelf.dir}`)
  console.log(
    `当前在用：${shelf.activeName}（${shelf.activeSource}${shelf.activeChars ? `，${shelf.activeChars} 字` : ''}）`,
  )
  if (shelf.activeError) console.log(`⚠️ ${shelf.activeError} —— 按"不用人设"在跑，请到控制台里选一套`)
  console.log('')
  if (shelf.personas.length === 0) {
    console.log('  （一套都没有。控制台 → 人设 里有「恢复默认两套」。）')
  }
  for (const p of shelf.personas) {
    const bar = p.active ? '▸' : ' '
    const notes = [p.isDefault ? '出厂默认' : '', p.hasNameBlock ? '' : '⚠️ 没有名字块（"叫名字"会回落到兜底名）']
      .filter(Boolean)
      .join('｜')
    console.log(`  ${bar} ${p.name}${notes ? `　[${notes}]` : ''}  —— ${p.chars} 字`)
  }
  if (shelf.legacy) {
    console.log('')
    console.log('⚠️ 配置里还是 0.2.2 之前的老写法（`persona.active` 为空），所以上面那几套都没在用：')
    const inUse = shelf.legacy.customChars
      ? `老的自定义人设（${shelf.legacy.customChars} 字）`
      : `内置预设 ${shelf.legacy.preset || 'mermaid'}`
    console.log(`   现在生效的是${inUse}。`)
    console.log('   要把它纳入人设栏管理：控制台里「新建」一套、把正文粘进去，然后「切换」过去（切换要重启）。')
  }
  console.log('')
  return shelf
}

function makeLogger(verbose) {  return (message) => {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const line = `${stamp} ${message}`
    console.log(line)
    if (logFile) {
      try {
        ensureLogBom(logFile)
        appendFileSync(logFile, line + '\n')
      } catch {
        /* 写日志失败不该影响主流程 */
      }
    } else if (earlyLogLines.length < EARLY_LOG_MAX) {
      // 日志文件还没就绪：先攒着，等 `logFile` 赋值后一次性补写（见 earlyLogLines 的说明）
      earlyLogLines.push(line)
    }
  }
}

function loadConfig() {
  const path = join(PKG_ROOT, 'config.json')
  if (!existsSync(path)) {
    // ★ config.json **刻意不进 git**：它含 SnowLuma 的 accessToken 与模型 API key 明文，
    //   而 git 历史里的密钥即使之后删掉也仍然可被检出（属于永久泄露）。
    //   所以仓库里给的是 `config.example.json`，这里在缺失时给出**可执行**的提示，
    //   而不是一句"找不到配置文件"（那种报错会让人以为包坏了）。
    const example = join(PKG_ROOT, 'config.example.json')
    throw new Error(
      `找不到配置文件：${path}\n` +
        (existsSync(example)
          ? `  本仓库不跟踪 config.json（它含明文密钥）。复制一份模板即可：\n` +
            `    copy "${example}" "${path}"\n`
          : '  仓库里连模板 config.example.json 也没有，请检查包是否完整。\n'),
    )
  }
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw)
  return { config: normalizeConfig(parsed), path }
}

/**
 * 绑定配置接口，端口忙时**重试**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么不能只 `await serveApi(...)` 一次就完（这里踩过坑）
 * ══════════════════════════════════════════════════════════════════════════
 * 重启是"先起新进程、旧进程随后退出"的，于是新进程常常**在旧进程还没放开端口时**
 * 就来绑定。原实现只试一次，然后在 catch 里把 `EADDRINUSE` 降级成一句 warning
 * 并让 `apiServer = null` —— 后果非常坏：
 *
 *   · 第二个桥接**看起来启动成功**（能连 QQ、能回话），只是控制台不可用；
 *   · 而用户打开的那张控制台界面其实是**第一个进程**的；
 *   · 两个桥接同时从同一个 OneBot 收事件 → 同一句话可能被回答两次；
 *   · 日志里只有一句 ⚠️，没有任何地方能看出"现在有两个桥接"。
 *
 * 所以：端口忙就等一小会儿再试（旧进程退出通常只要几百毫秒），
 * 并且**失败时不许静默**：打 error 级日志，并把结果回报给启动流程，
 * 让 `/api/status` 与 doctor 能如实显示"控制台端口被占用"。
 */
async function bindApiWithRetry({ port, handler, staticDir, log, attempts = 8, delayMs = 400 }) {
  let lastError = null
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await serveApi({ port, handler, staticDir, log })
    } catch (error) {
      lastError = error
      const busy = /EADDRINUSE|已被占用/.test(String(error?.message ?? ''))
      if (!busy) throw error // 不是端口冲突（例如权限问题）就别重试了，直接上报
      if (i < attempts) {
        log(
          `配置接口端口 ${port} 被占用，等待释放后重试（${i}/${attempts - 1}）——` +
            `通常是上一个桥接进程还没退完`,
        )
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
  }
  throw lastError
}

/**
 * 另起一个桥接进程（给 /api/restart 用）。
 *
 * 做法与 start.bat 保持一致：优先用包内 vendor\node\node.exe，
 * 找不到退回系统 node。新进程 detached + stdio 忽略 —— 父进程退出后
 * 它独立存活，日志照旧写 logs/bridge.log，控制台界面不受影响。
 *
 * ★ 它**不负责**"顺序"：谁先谁后由调用方（requestRestart）决定。
 *   原来的顺序是"先起新的、再关旧的"，注释里还断言"不用担心端口冲突"——
 *   那个断言只在旧进程很快退完时成立，而旧进程恰恰可能慢
 *   （在途回复最多等 8s + DSH shutdown 最多 15s）。现在改成：
 *   **先关掉自己的配置接口（释放端口）→ 再 spawn 新进程 → 再收尾退出**，
 *   于是"端口已释放"是**代码保证**的，不再依赖时序假设。
 */
function respawnBridge(log, { port } = {}) {
  const vendorNode = join(PKG_ROOT, 'vendor', 'node', 'node.exe')
  const nodeBin = existsSync(vendorNode) ? vendorNode : 'node'
  // ★ 把端口告诉新进程：它会在绑定失败时重试（bindApiWithRetry），
  //   这样即使旧进程退得比预期慢，新进程也只是慢一点起来，而不是静默丢掉控制台。
  const env = port ? { ...process.env, DSH_BRIDGE_EXPECT_PORT: String(port) } : process.env
  // ★ 预生成 instanceId 并写进**命令行**：新进程会沿用它登记，
  //   于是"这个 PID 还是不是原来那个进程"可以靠读回命令行来确认（防 PID 复用）。
  const nextInstanceId = randomBytes(6).toString('hex')
  const child = spawn(
    nodeBin,
    [join(PKG_ROOT, 'src', 'index.mjs'), `${INSTANCE_ARG_PREFIX}${nextInstanceId}`],
    {
      cwd: PKG_ROOT,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  )
  child.unref()
  // 只"发起"，日志由调用方按顺序补充（见 requestRestart：要先释放端口再报成功）
  return { pid: child.pid, target: join(PKG_ROOT, 'src', 'index.mjs') }
}

async function main() {
  const checkOnly = process.argv.includes('--check')
  const doctorOnly = process.argv.includes('--doctor')
  // 给 start.bat 用的两个小工具开关（见下方"启动前顺手做的事"）。
  const snowlumaOnly = process.argv.includes('--snowluma')
  const openConsoleOnly = process.argv.includes('--open-console')

  let config
  let configPath
  try {
    ;({ config, path: configPath } = loadConfig())
  } catch (error) {
    console.error(`❌ 配置加载失败：${error.message}`)
    process.exit(1)
  }

  const { fatal, warn } = validateConfig(config)
  const log = makeLogger(config.ui.verbose)

  // ── 进程登记（缺陷 3）：回答"现在有几个桥接在跑" ──────────────────────
  // 必须在**任何会占用端口/资源的动作之前**做，这样：
  //   · 冲突能被尽早报出来（而不是等端口绑不上才发现）；
  //   · `--processes` / `--kill` 这两个纯查询/管理入口不受启动流程影响。
  const guard = createProcessGuard({
    pkgRoot: PKG_ROOT,
    profile: 'bridge',
    port: config.ui?.apiPort ?? null,
    log,
  })

  // 两个只做进程管理的入口，做完就退出（不启动机器人）
  const listProcesses = process.argv.includes('--processes')

  // ── 界面新鲜度（只读）：这份 dist 是不是当前源码构建的？────────────────
  //
  // ★ 为什么要有这个入口：界面分两条路出货（开发路径 config-ui/dist、
  //   发布路径 _release/<包>/config-ui/dist），而"包里那份是不是当前源码
  //   构建的"以前没有任何东西能判断 —— 实测脱钩过一次，1100 项测试全绿。
  //   判定方式：构建时写入的源码哈希 vs 现在重算的哈希。
  //
  // 用法：
  //   node src/index.mjs --ui
  //   node src/index.mjs --ui --dist <某个包的 config-ui/dist>   （查别人给的那份）
  if (process.argv.includes('--ui')) {
    ;(async () => {
      const { checkUiFreshness, uiFreshnessTitle, defaultUiDist } = await import('./ui-status.mjs')
      const di = process.argv.indexOf('--dist')
      const distDir = di >= 0 && process.argv[di + 1] ? process.argv[di + 1] : defaultUiDist()
      const r = checkUiFreshness({ distDir })
      if (process.argv.includes('--json')) {
        console.log(JSON.stringify(r, null, 2))
      } else {
        console.log('')
        console.log(uiFreshnessTitle(r.status))
        console.log(`  产物：${r.distDir}`)
        console.log(`  说明：${r.why}`)
        if (r.advice) console.log(`  怎么办：${r.advice}`)
        console.log('')
      }
      // 退出码：fresh=0，其余=1。**unstamped 也算失败** —— 它同样是"无法确认同一份"。
      process.exit(r.status === 'fresh' ? 0 : 1)
    })().catch((error) => {
      console.error(`❌ 界面检查失败：${error?.message ?? error}`)
      process.exit(1)
    })
    return
  }

  // ── 后台启动（给 start.bat 用）─────────────────────────────────────────
  //
  //   node src/index.mjs --background
  //
  // ★ 为什么需要它：start.bat 原来在**前台**跑 `node src/index.mjs`，于是那个
  //   cmd 窗口成了父进程、与 node **共享同一个 console** —— 关掉窗口（或 Ctrl+C）
  //   会把整个 console 的进程组带走，机器人就下线了。而窗口**不是必需的**：
  //   `/api/restart` 一直在用 `respawnBridge()`（detached + stdio:'ignore' +
  //   unref）起进程，那条路径与任何终端无关。这里把同一条路径开放给命令行，
  //   于是 start.bat 可以"发起后立刻返回"，不再需要留一个窗口。
  //
  // ★ 拒绝重复实例：已经有一个活着的桥接就不起第二个。两个会抢同一个 OneBot
  //   事件流（同一句话可能被回两次）—— 这正是 process-guard 要防的事，
  //   判据直接用 runningBridges()（按**数量**判定，见它的注释）。
  //
  // ★ 位置纪律（见下面 --delivery 的注释，那里记着一次"只读命令却启动了服务"的事故）：
  //   顶层命令必须放在这一段**之上**，否则会落进某个 async 分支内部、
  //   分支不命中时一路走到真的启动桥接。
  if (process.argv.includes('--background')) {
    const live = runningBridges(guard.list())
    if (live.length > 0) {
      console.error(
        `❌ 已经有一个桥接在运行（pid ${live.map((e) => e.pid).join('、')}）—— 不再起第二个。\n` +
          `   同时跑两个会抢同一个 OneBot 事件流（同一句话可能被回两次）。\n` +
          `   要重启：控制台点「重启」，或 POST http://127.0.0.1:${config.ui?.apiPort ?? 3410}/api/restart\n` +
          `   要强停：node src/index.mjs --processes --kill <pid>`,
      )
      process.exit(1)
    }
    let spawned = null
    try {
      spawned = respawnBridge(log, { port: config.ui?.apiPort ?? null })
    } catch (error) {
      console.error(`❌ 后台启动失败：${error?.message ?? error}`)
      process.exit(1)
    }
    const origin = `http://127.0.0.1:${config.ui?.apiPort ?? 3410}/`
    console.log('')
    console.log(`✅ 已在后台启动（pid ${spawned.pid}）`)
    console.log(`   控制台：${origin}`)
    console.log(`   日志  ：${config.ui?.logFile ?? 'logs/bridge.log'}`)
    console.log('   这个窗口可以关掉 —— 关掉不会让机器人下线；要停请用控制台的「停止」。')
    console.log('')
    process.exit(0)
  }


  // ── 人设库（0.2.2）：首次使用时把**默认那两套**落成文件 ────────────────
  //
  // ★ 只在**空目录**时落（`ensureDefaultPersonas` 内部就是这么写的）：使用者把某一套
  //   删了/改名了，下一次启动**不许**把它变回来 —— 那会让"删除"变成假的。
  //   （所以这件事不能挂在 `listPersonas` 上：那是每次开控制台都会调的读操作。）
  {
    const seeded = ensureDefaultPersonas({ dir: DIRS.personas })
    if (!seeded.ok) log(`⚠️ 人设库初始化失败：${seeded.error}`)
    else if (seeded.created.length > 0) log(`人设库：落下了默认的 ${seeded.created.join('、')}`)
  }

  // ── 人设库离线巡检（0.2.2，只读）──────────────────────────────────────
  //
  //   node src/index.mjs --personas
  //
  // ★ 与 `--extensions` 同样放在这一段（`--memory` 之上）：顶层命令插到下面去就会
  //   落到那个块的内部，直接跑时会一路走到**真的启动桥接**（见 --delivery 的注释）。
  if (process.argv.includes('--personas')) {
    printPersonas({ config, configPath })
    return
  }

  // ── 扩展（技能 / 插件）离线巡检（0.2.2）────────────────────────────────
  //
  //   node src/index.mjs --extensions
  //
  // ★ 放在这里而不是更靠后：下面 `--memory` 那一大块里嵌着 `--audit` / `--usage`，
  //   顶层命令插错位置就会落到那个块内部 —— 直接跑时会一路走到**真的启动桥接**
  //   （`--delivery` 的注释里记着这次事故）。所以新增顶层命令一律放在这一段之上。
  if (process.argv.includes('--extensions')) {
    await printExtensions({ config, configPath, log: (m) => console.log(`  ${m}`) })
    return
  }

  // ── 投递账本（H15，**只读**）──────────────────────────────────────────
  //
  // 它回答的是一个真机上真实发生过的问题：一条**已经生成好**的回复在拟人延迟期间
  // 因为重启而永远消失，而当时没有任何地方能说清"丢的是哪条、给谁的"。
  //   node src/index.mjs --delivery                 # 看最近 30 条 + 未完成投递
  //   node src/index.mjs --delivery --resend <id>   # 看某一条的详情（人显式决定）
  //
  // ★★ 位置纪律（**踩过一次，代价是启动了一个多余的桥接进程**）：
  //    `--memory` 下面的 `--audit` / `--usage` 都**嵌在** `--memory` 分支的 async 块里，
  //    所以新增的**顶层**命令如果顺手插在那附近，它会落在那个块内部 ——
  //    直接跑 `--delivery` 时分支不命中，程序**继续往下走真的去启动桥接**
  //    （进程守护只给了一句"建议先停掉一个"的警告）。一个只读命令**不该有启动服务这种副作用**。
  //    → 新增顶层命令一律放在**这一段之上**，并且跑一次确认它不会走到启动路径。
  if (process.argv.includes('--delivery')) {
    ;(async () => {
      const { readLedger, renderLedger, orphanedDeliveries, inFlightDeliveries, renderOrphans, renderInFlight, LEDGER_REL } =
        await import('./delivery-ledger.mjs')
      const workspace = config.dsh?.workspace
      if (!workspace) {
        console.error('❌ 配置里没有 dsh.workspace，无法定位投递账本')
        process.exit(2)
      }
      const ledger = readLedger({ workspace, log: (m) => console.log(`  ${m}`) })

      const ri = process.argv.indexOf('--resend')
      const targetId = ri >= 0 ? String(process.argv[ri + 1] ?? '').trim() : ''
      if (targetId) {
        const row = (ledger.rows ?? []).find((r) => r.id === targetId)
        if (!row) {
          console.error(`❌ 账本里没有 id 为 ${targetId} 的记录。用 --delivery 看一遍 id。`)
          process.exit(2)
        }
        const body = (row.chunks ?? []).map((c) => c.preview).join('')
        console.log('')
        console.log(`这一条：【${row.chatKey}】（${row.total} 片，已发出 ${(row.chunks ?? []).filter((c) => c.sent).length} 片）`)
        console.log(`  正文预览：${body}${body.length >= 40 ? '…' : ''}`)
        console.log('')
        console.log('⚠️ 账本里**只存了每片的前 40 字**（它是排查用的，不是第二份聊天记录）——')
        console.log('   所以这里**不做自动补发**：补发需要完整正文，而正文在 DSH 的会话里；')
        console.log('   要重新发一次，就让对方再说一句（那一轮会重新生成）。')
        console.log('')
        process.exit(0)
      }

      const orphans = orphanedDeliveries({ workspace, log: () => {} })
      const inFlight = inFlightDeliveries({ workspace, log: () => {} })
      console.log('')
      console.log(`投递账本（${LEDGER_REL}）：共 ${(ledger.rows ?? []).length} 条记录`)
      console.log('')
      console.log(renderLedger({ ledger, limit: 30 }))
      if (inFlight.length) {
        console.log('')
        console.log(renderInFlight(inFlight))
      }
      if (orphans.length) {
        console.log('')
        console.log(renderOrphans(orphans))
      }
      console.log('')
      process.exit(0)
    })()
  }

  // ── 表情包：库状态 / 导入 / 清理（0.2.4，全部离线）──────────────────────
  //
  // ★ 为什么这个入口是**必需**的（不是顺手加的）：
  //   表情包的失败形状**天然是静默的** —— 库里没图、标签没打上、被配额挡住，
  //   表现都只是"它从来不发表情"。所以必须有一个地方能回答：
  //   "库里有几张能用的图 / 每类各几张 / 最近为什么不发"。
  //   `decisions.jsonl`（决策流水）也在这里读出来 —— 三档频率与阈值只能靠它调。
  //
  // 用法：
  //   node src/index.mjs --stickers                              # 库状态 + 最近决策
  //   node src/index.mjs --stickers --import <目录|文件...> [--scope group-123]
  //   node src/index.mjs --stickers --prune [--apply]            # 清理僵尸条目（默认预演）
  //   node src/sticker-tag.mjs --apply                           # 打标签（另开一个入口）
  if (process.argv.includes('--stickers')) {
    ;(async () => {
      const workspace = config.dsh?.workspace
      if (!workspace) {
        console.error('❌ 配置里没有 dsh.workspace，无法定位表情库')
        process.exit(2)
      }
      const dir = config.skills?.sticker?.libraryDir ?? 'stickers'
      const argOf = (flag) => {
        const i = process.argv.indexOf(flag)
        return i >= 0 ? process.argv[i + 1] : undefined
      }

      if (process.argv.includes('--import')) {
        const i = process.argv.indexOf('--import')
        // 取 `--import` 之后到下一个 `--` 选项之前的所有位置参数（支持一次给多个路径）
        const inputs = []
        for (let k = i + 1; k < process.argv.length; k += 1) {
          if (String(process.argv[k]).startsWith('--')) break
          inputs.push(process.argv[k])
        }
        if (!inputs.length) {
          console.error('❌ 用法：node src/index.mjs --stickers --import <目录|文件...> [--scope group-123456]')
          process.exit(2)
        }
        const { runStickerImport, renderImportResult, renderStickerStatus } = await import('./sticker-import.mjs')
        // ★ 默认导进**全局库**（所有会话共用）：不写 `--scope` 就是它。
        //   要按会话分库必须显式给 `--scope group-123456` —— 两者的后果不同
        //   （全局库新群立刻能用；分会话库只有那个会话能用）。
        const scope = argOf('--scope') ?? 'global'
        console.log(renderImportResult(runStickerImport({ workspace, dir, inputs, scope })))
        console.log(renderStickerStatus({ workspace, dir }))
        process.exit(0)
      }

      if (process.argv.includes('--show')) {
        const { renderStickerEntry } = await import('./sticker-import.mjs')
        const si = process.argv.indexOf('--show')
        const keyword = process.argv[si + 1]
        console.log(renderStickerEntry({ workspace, dir }, keyword))
        process.exit(0)
      }

      if (process.argv.includes('--list')) {
        const { renderStickerList } = await import('./sticker-import.mjs')
        const onlyPending = process.argv.includes('--pending')
        const li = process.argv.indexOf('--limit')
        const limit = li >= 0 ? Number(process.argv[li + 1]) || 200 : 200
        console.log(renderStickerList({ workspace, dir }, { onlyPending, limit }))
        process.exit(0)
      }

      if (process.argv.includes('--export-tags')) {
        const apply = process.argv.includes('--apply')
        const link = process.argv.includes('--link')
        const outDir = argOf('--out') ?? 'stickers-by-tag'
        const { exportStickersByTag, renderExportResult } = await import('./sticker-import.mjs')
        console.log(
          renderExportResult(exportStickersByTag({ workspace, dir }, { outDir, link, apply }), { outDir, workspace, dir }),
        )
        process.exit(0)
      }

      // ── 清理**多余副本**（磁盘上有、索引里没有、内容与已索引文件逐字节相同）──
      //
      // ★ 与下面 `--prune` 是**相反方向**的两件事：
      //   `--prune` 删"索引里有、磁盘上没有"的**僵尸条目**（元数据）；
      //   `--prune-orphans` 删"磁盘上有、索引里没有"的**多余副本**（真正的文件）。
      //   后者是导入去重留下的垃圾（实测 157 个 / 460MB，占全库一半），
      //   而所有界面统计都按索引算，所以**根本看不见它**。默认预演。
      if (process.argv.includes('--prune-orphans')) {
        const apply = process.argv.includes('--apply')
        const { runStickerOrphanPrune, renderOrphanResult } = await import('./sticker-import.mjs')
        console.log(renderOrphanResult(runStickerOrphanPrune({ workspace, dir, apply }), { apply }))
        process.exit(0)
      }

      if (process.argv.includes('--prune')) {
        const apply = process.argv.includes('--apply')
        const { runStickerPrune } = await import('./sticker-import.mjs')
        const r = runStickerPrune({ workspace, dir, apply })
        if (r.nothing) {
          console.log('\n✅ 没有僵尸条目（库里的每条都能找到文件）\n')
        } else {
          console.log(
            r.applied
              ? `\n已清理 ${r.removed.length} 条僵尸条目\n`
              : `\n预演：有 ${r.removed.length} 条僵尸条目会被清掉（加 --apply 才真删）\n`,
          )
        }
        process.exit(0)
      }

      const { renderStickerStatus } = await import('./sticker-import.mjs')
      // `--orphans` 让状态页顺带核对"磁盘上的多余副本"（要读遍全库算哈希，所以按需）
      console.log(renderStickerStatus({ workspace, dir }, { checkOrphans: process.argv.includes('--orphans') }))
      console.log(
        '  提示：--import <目录> 导入；--export-tags [--apply] 按标签整理成一份看得懂的目录；\n' +
          '        --prune 清理僵尸条目；--prune-orphans [--apply] 清理库里的多余副本；\n' +
          '        node src/sticker-tag.mjs --apply 打标签。',
      )
      console.log('')
      process.exit(0)
    })()
  }

  // ── 记忆体检（只读，可以在机器人正在跑的时候执行）────────────────────
  //
  // ★ 为什么要有这个入口（"它说记住了"和"它真的记住了"是两件事）：
  //   离线测试证明的是**机制**通不通；而"这台机器此刻到底记着什么、
  //   下一轮会注入什么"是运行时状态，测试答不了 —— 那恰恰是使用者最想确认的。
  //   它**绝不写盘、绝不消费回执**，所以不会干扰正在跑的桥接。
  //
  // 用法：
  //   node src/index.mjs --memory
  //   node src/index.mjs --memory --inject private:100000001 --inject group:700000001
  //   node src/index.mjs --memory --audit [--limit N]   ← 变更审计（谁/何时/来源/档位）
  if (process.argv.includes('--memory')) {
    ;(async () => {
      const { inspectMemory, formatMemoryReport } = await import('./memory-inspect.mjs')
      const workspace = config.dsh?.workspace
      if (!workspace) {
        console.error('❌ 配置里没有 dsh.workspace，无法定位记忆目录')
        process.exit(2)
      }

      // ── 变更审计（**只读**）：回答"这条是谁在什么时候、通过哪条通道写进去的"──
      //
      // 为什么单独给一个入口：记忆现在有**四条写入通道**（模型标记 / 关键词直写 /
      // 管理员手段 / 整理合并），出问题时"到底是谁写的"是第一个要回答的问题，
      // 而 `logs/bridge.log` 只有一行 `[memory] 记忆写入：接受 N 条`，不说是哪一条。
      // ⚠️ 审计里**没有原文**（只记长度）—— 它不能变成第二个泄露面。
      if (process.argv.includes('--audit')) {
        const { readAuditEntries, formatAuditRow, AUDIT_REL } = await import('./memory-audit.mjs')
        const li = process.argv.indexOf('--limit')
        const limit = li >= 0 ? Number(process.argv[li + 1]) || 50 : 50
        const rows = readAuditEntries({ workspace, limit })
        console.log('')
        console.log(`记忆变更审计（最近 ${rows.length} 条；文件 ${AUDIT_REL}）`)
        console.log(`工作区：${workspace}`)
        console.log('')
        if (rows.length === 0) {
          console.log('  （还没有任何变更记录 —— 审计从这次升级之后才开始记）')
        } else {
          for (const r of rows) console.log(`  ${formatAuditRow(r)}`)
        }
        console.log('')
        console.log('  说明：审计**只记长度、不记原文**（否则它会变成第二个泄露面）。')
        console.log('        要查内容请直接看记忆文件；`--memory` 看落盘与注入。')
        console.log('')
        process.exit(0)
      }

      // ── 使用账本（H3，**只读、只提示**）：回答"这条记忆多久没进过上下文了"──
      //
      // ★ 它的动机：记忆**只增不减**，而注入有条数上限（25 条）—— 死条目会吃掉预算，
      //   我们却无从知道哪条还在参与对话。这个入口把"最久没进过上下文"的条目列出来。
      // ⚠️ 它**只提示**：不自动降权、不自动归档、不删（设计决策 D9：不做强度浮点衰减）。
      // ⚠️ 我们观测到的是"**被注入**"而不是"**被用上**" —— 字段名与文案都按这个说。
      if (process.argv.includes('--usage')) {
        const { readUsage, staleEntries, renderUsageReport, STALE_DAYS } = await import('./memory-usage.mjs')
        const usage = readUsage({ workspace, log: (m) => console.log(`  ${m}`) })
        const stale = staleEntries({ workspace, usage })
        const total = Object.keys(usage.entries ?? {}).length
        console.log('')
        console.log(renderUsageReport({
          stale,
          total,
          neverInjected: stale.filter((s) => s.lastInjectedAt === null).length,
          days: STALE_DAYS,
          startedAt: usage.startedAt,
        }))
        console.log('')
        console.log(`  工作区：${workspace}`)
        console.log('  说明：账本只记时间与次数，**不记内容**；条目按归一化文本的 hash 认人。')
        console.log('')
        process.exit(0)
      }

      // 要预览注入的会话：显式给就用显式的；否则默认列配置里的白名单。
      const injectArgs = []
      for (let i = 0; i < process.argv.length; i += 1) {
        if (process.argv[i] === '--inject' && process.argv[i + 1]) injectArgs.push(process.argv[i + 1])
      }
      const targets =
        injectArgs.length > 0
          ? injectArgs
          : [
              ...(config.access?.adminUsers ?? []).map((id) => `private:${id}`),
              ...(config.access?.dmAllowlist ?? []).map((id) => `private:${id}`),
              ...(config.access?.groupAllowlist ?? []).map((id) => `group:${id}`),
            ]
      const conversations = [...new Set(targets)].map((key) => {
        const [kind, peerId] = String(key).split(':')
        return { kind, peerId }
      })
      const report = inspectMemory({ workspace, conversations })
      if (process.argv.includes('--privacy')) {
        // ── 隐私扫描（**只读**）：现有记忆里有没有该被拦的东西 ──────────────
        //
        // ★ 为什么先扫再装闸门：闸门装完才发现它把正常记忆全拦了，
        //   比不装更糟（表现成"记忆突然全不工作了"）。所以先看清现状，再定阈值。
        //   本命令**不改任何文件**，机器人跑着也能执行。
        const { scanPrivacy, PRIVACY_CATEGORIES, readPrivacyAudit } = await import('./privacy.mjs')
        const fs = await import('node:fs')
        const path = await import('node:path')

        console.log('')
        console.log('隐私扫描（只读；不会改动任何文件）')
        console.log(`工作区：${workspace}`)
        console.log('')

        // 要扫的文件：记忆库 + 运行态文件（都在工作区内）
        const targets = []
        for (const rel of report.files.map((f) => f.rel)) targets.push(rel)
        for (const rel of ['memory/.stats.json', 'memory/privacy-audit.jsonl']) {
          if (fs.existsSync(path.join(workspace, rel))) targets.push(rel)
        }

        let hitLines = 0
        let scanned = 0
        const byCategory = {}
        for (const rel of targets) {
          const abs = path.join(workspace, rel)
          let text = ''
          try {
            text = fs.readFileSync(abs, 'utf8')
          } catch {
            continue
          }
          const lines = text.split('\n')
          const fileHits = []
          for (let i = 0; i < lines.length; i += 1) {
            const t = lines[i].replace(/^-\s*/, '').trim()
            if (!t || t.startsWith('#')) continue
            scanned += 1
            const r = scanPrivacy(t)
            if (!r.hit) continue
            hitLines += 1
            fileHits.push({ line: i + 1, categories: r.categories, preview: t.slice(0, 50) })
            for (const c of r.categories) byCategory[c] = (byCategory[c] ?? 0) + 1
          }
          if (fileHits.length > 0) {
            console.log(`  ⚠️ ${rel}`)
            for (const h of fileHits) {
              console.log(
                `       第 ${String(h.line).padStart(3)} 行  [${h.categories.join(',')}]  ${h.preview}…`,
              )
            }
          }
        }

        console.log('')
        console.log(`  扫了 ${scanned} 条，命中 ${hitLines} 条`)
        if (hitLines === 0) {
          console.log('  ✅ 现有记忆里没有发现七类隐私')
        } else {
          console.log('  按类别：')
          for (const [c, n] of Object.entries(byCategory)) {
            console.log(`       ${PRIVACY_CATEGORIES[c] ?? c}  ${n} 条`)
          }
          console.log('')
          console.log('  ⚠️ 这些条目**不会被新写入**（写入侧已拦），但**已经在盘上了**。')
          console.log('     处理办法：在控制台「记忆」页签里手动删掉，然后跑一次')
          console.log('       node src/index.mjs --memory --compact --apply')
          console.log('     让格式归一并刷新快照基准。')
        }

        // 拦截审计：**只记类别与长度，没有原文** —— 这里也如实说清
        const audit = readPrivacyAudit({ workspace, limit: 20 })
        console.log('')
        console.log(`  隐私拦截审计（memory/privacy-audit.jsonl，最近 ${audit.length} 条）`)
        if (audit.length === 0) {
          console.log('       （还没有拦截记录）')
        } else {
          for (const a of audit) {
            const when = new Date(a.ts).toISOString().slice(0, 19).replace('T', ' ')
            console.log(
              `       ${when}  ${a.side === 'store' ? '写入侧' : '输出侧'}  ` +
                `[${(a.categories ?? []).map((c) => PRIVACY_CATEGORIES[c] ?? c).join('、')}]  ${a.length} 字`,
            )
          }
          console.log('       ★ 审计只记**类别与字数**，不记原文 —— 否则拦截本身就成了泄露通道。')
        }
        console.log('')
        process.exit(0)
      }
      if (process.argv.includes('--compact')) {
        // ── 记忆整理（规则版）─────────────────────────────────────────────
        //
        // ★ **默认预演、不写盘**：要真改必须显式加 `--apply`。
        //   理由：记忆是长期资产，一次误合并的代价远大于"多打一个参数"的不便。
        //   预演和实做的**走同一段代码**（`consolidateFile` 只差一个 apply 开关），
        //   所以"预演看到的"就是"真做出来的"，不会两套逻辑分叉。
        const { consolidateFile } = await import('./memory-consolidate.mjs')
        const { saveSnapshot } = await import('./memory-store.mjs')
        const apply = process.argv.includes('--apply')
        const only = (() => {
          const i = process.argv.indexOf('--file')
          return i >= 0 ? process.argv[i + 1] : null
        })()
        const targets = report.files.map((f) => f.rel).filter((rel) => !only || rel === only)
        if (targets.length === 0) {
          console.log(only ? `没有这个记忆文件：${only}` : '没有找到任何记忆文件')
          process.exit(0)
        }
        console.log('')
        console.log(`记忆整理（规则版）${apply ? '【实做】' : '【预演 —— 不写盘，加 --apply 才真改】'}`)
        console.log(`工作区：${workspace}`)
        let totalBefore = 0
        let totalAfter = 0
        let changedFiles = 0
        for (const rel of targets) {
          const r = consolidateFile({ workspace, rel, apply, saveSnapshot })
          if (!r.ok) {
            console.log(`\n  ❌ ${rel}：${r.why}`)
            continue
          }
          totalBefore += r.before
          totalAfter += r.after
          if (r.changed) changedFiles += 1
          const mark = r.changed ? '→' : '·'
          console.log(`\n  ${mark} ${rel}  ${r.before} 条 → ${r.after} 条`)
          if (r.plan.droppedDuplicates.length > 0) {
            console.log(`     完全重复 ${r.plan.droppedDuplicates.length} 条（只留最早那条）`)
            for (const d of r.plan.droppedDuplicates.slice(0, 5)) {
              console.log(`       - 丢：${d.text.replace(/\n/g, ' ').slice(0, 60)}`)
            }
          }
          if (r.plan.merged.length > 0) {
            console.log(`     合并相似 ${r.plan.merged.length} 组（保留信息更多的那条）`)
            for (const m of r.plan.merged.slice(0, 5)) {
              console.log(`       [相似度 ${m.score}] 留：${m.kept.replace(/\n/g, ' ').slice(0, 50)}`)
              console.log(`                      并掉：${m.mergedAway.replace(/\n/g, ' ').slice(0, 50)}`)
            }
          }
          if (r.changed) {
            console.log('     整理后：')
            for (const line of r.plan.kept) {
              for (const l of String(line).split('\n')) console.log(`       - ${l.slice(0, 70)}`)
            }
          } else {
            console.log('     （已经是干净的，无需改动）')
          }
        }
        console.log('')
        console.log(
          `  合计：${targets.length} 个文件，${totalBefore} 条 → ${totalAfter} 条` +
            `（${changedFiles} 个文件有改动）`,
        )
        if (apply && changedFiles > 0) {
          console.log('  ✅ 已写回，并刷新了快照基准（否则下次读记忆会把整理结果回滚）')
        } else if (!apply && changedFiles > 0) {
          console.log('  要真的写回：在上面那条命令末尾加 --apply')
        }
        console.log('')
        process.exit(0)
      }
      if (process.argv.includes('--stats')) {
        // ── 计数视图：回答"到底写了没有" ────────────────────────────────────
        // 为什么独立成一个开关：① 体检默认输出已经很长；② 排查"一条没记"时
        // 先看的就是这四个数（提议/接受/拒绝/去重），不用先读一堆文件明细。
        const { readAllStats, resetStats } = await import('./memory-stats.mjs')
        if (process.argv.includes('--reset')) {
          resetStats(workspace)
          console.log('已清空记忆统计（memory/.stats.json）')
          process.exit(0)
        }
        const rows = readAllStats(workspace)
        console.log('')
        console.log('记忆写入统计（只读；数据来自 memory/.stats.json）')
        console.log(`工作区：${workspace}`)
        console.log('')
        if (rows.length === 0) {
          console.log('   （还没有任何会话记录 —— 说明桥接还没跑过带记忆的回合）')
        } else {
          console.log('   会话                     轮数  提议  接受  拒绝  去重   最后落盘')
          for (const r of rows) {
            const last = r.lastWriteAt ? new Date(r.lastWriteAt).toISOString().slice(0, 19).replace('T', ' ') : '—'
            console.log(
              `   ${String(r.chatKey).padEnd(22)} ${String(r.turns).padStart(4)}  ` +
                `${String(r.proposed).padStart(4)}  ${String(r.applied).padStart(4)}  ` +
                `${String(r.ignored).padStart(4)}  ${String(r.deduped).padStart(4)}   ${last}`,
            )
          }
        }
        const alerts = rows.filter((r) => r.alert)
        console.log('')
        if (alerts.length > 0) {
          console.log('   ⚠️ **零写入告警**（跑了足够多轮却一条都没落盘）：')
          for (const a of alerts) console.log(`      ${a.chatKey}：${a.alertWhy}`)
          console.log('      排查顺序：① --memory 看落盘与注入 ② 看日志里的 [memory] 行')
          console.log('                ③ 看 docs/0.2.1-memory-diagnosis.md')
        } else {
          console.log('   ✅ 没有零写入告警')
        }
        console.log('')
        process.exit(0)
      }
      if (process.argv.includes('--json')) {
        console.log(JSON.stringify(report, null, 2))
      } else {
        console.log('')
        console.log(formatMemoryReport(report))
        console.log('')
      }
      process.exit(0)
    })().catch((error) => {
      console.error(`❌ 记忆体检失败：${error?.message ?? error}`)
      process.exit(1)
    })
    return
  }

  // ── 配方库：沉淀"怎么做" ──────────────────────────────────────────────────
  //
  //   --recipes                                   列出（按置信度）
  //   --recipes --extract --inject <会话> [--dry]   ★ **手动跑一次自动抽取**（可重复验证）
  //   --recipes --match "帮我查个品牌"              看这段文本会命中哪条（匹配预览）
  //   --recipes --show <id>                       看一条的全文
  //   --recipes --add --json '<json>'              人工加一条
  //   --recipes --enable/--disable <id>            启用/停用
  //   --recipes --forget <id>                     删掉
  // ── 本地语料库（H7）：搜"过去说过什么" ────────────────────────────────────
  //
  //   --corpus                              统计（条数/会话分布/占用/超期数）
  //   --corpus --search <关键词> [--inject <会话>] [--limit N]
  //   --corpus --prune [--apply] [--days N] 按 TTL 清理（**默认预演**）
  //   --corpus --rebuild                    重建 FTS 索引（怀疑索引不一致时）
  //
  // ★ 隐私边界（用户确认过）：七类隐私**不落库**；30 天 TTL；不存媒体本体。
  if (process.argv.includes('--corpus')) {
    ;(async () => {
      const { createCorpus, renderSearchResults } = await import('./corpus.mjs')
      const workspace = config.dsh?.workspace
      if (!workspace) {
        console.error('❌ 配置里没有 dsh.workspace，无法定位语料库')
        process.exit(2)
      }
      const argOf = (name) => {
        const i = process.argv.indexOf(name)
        return i >= 0 ? process.argv[i + 1] : null
      }
      const corpus = createCorpus({ workspace, log: (m) => console.log(m) })

      // ★ 0.2.3：`corpus.enabled = false` 时**不拒绝**这个命令，只**大声说明**。
      //   为什么不拒绝：关掉的是**采集**，而库里的旧数据还在 —— 排查/清理/统计
      //   这些只读动作正是关掉之后更需要能用的（否则"关掉"就变成了"看不见"，
      //   而看不见的东西最容易出问题）。所以这里只提醒，不拦。
      if (config.corpus?.enabled === false) {
        console.log(
          '⚠️  配置里 corpus.enabled = false：桥接**不再把新消息落库**，' +
            '`qq_search_history` / `qq_forward_log` 会当场拒绝。',
        )
        console.log('    下面看到的是**已有**的数据（关掉不会删库；清理用 --corpus --prune）。')
        console.log('')
      }

      if (process.argv.includes('--search')) {
        const query = argOf('--search')
        const chatKey = argOf('--inject')
        const limit = Number(argOf('--limit')) || 8
        if (!query) {
          console.error('❌ 用法：--corpus --search <关键词> [--inject private:<QQ>|group:<群号>] [--limit N]')
          process.exit(2)
        }
        const r = corpus.search({ query, chatKey, limit })
        if (!r.ok) {
          console.error(`❌ 检索失败：${r.why}`)
          process.exit(1)
        }
        console.log('')
        console.log(`检索「${query}」${chatKey ? `（仅 ${chatKey}）` : '（全部会话）'}：命中 ${r.rows.length} 条，方式 ${r.mode}`)
        console.log('')
        if (r.rows.length === 0) console.log('  （没有命中）')
        for (const row of r.rows) {
          const when = new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false })
          console.log(`  [mid:${row.messageId ?? '?'}] ${when} ${row.isBot ? '（机器人）' : ''}${row.chatKey} ${row.senderName ?? row.userId ?? ''}`)
          console.log(`      ${row.preview.replace(/\n/g, ' ')}`)
        }
        console.log('')
        corpus.close()
        process.exit(0)
      }

      if (process.argv.includes('--prune')) {
        const apply = process.argv.includes('--apply')
        const days = Number(argOf('--days')) || undefined
        const r = corpus.prune({ days, apply })
        if (!r.ok) {
          console.error(`❌ 清理失败：${r.why}`)
          process.exit(1)
        }
        console.log('')
        console.log(
          apply
            ? `已清理 ${r.removed} 条（保留最近 ${r.days} 天）`
            : `预演：将有 ${r.wouldRemove} 条超过 ${r.days} 天被清理（加 --apply 才真删）`,
        )
        console.log('')
        corpus.close()
        process.exit(0)
      }

      if (process.argv.includes('--rebuild')) {
        const r = corpus.rebuild()
        console.log(r.ok ? '✅ FTS 索引已重建' : `❌ 重建失败：${r.why}`)
        corpus.close()
        process.exit(r.ok ? 0 : 1)
      }

      const st = corpus.stats()
      console.log('')
      console.log('本地语料库（H7）')
      console.log(`工作区：${workspace}`)
      console.log('')
      if (!st.ok) {
        console.error(`❌ 读不到统计：${st.why}`)
        process.exit(1)
      }
      console.log(`  文件：${st.file}（${Math.round(st.bytes / 1024)} KB）`)
      console.log(`  消息：${st.total} 条（其中机器人自己说的 ${st.botMessages} 条）`)
      console.log(`  时间范围：${st.oldestAt ? new Date(st.oldestAt).toLocaleString('zh-CN') : '（空）'} ~ ${st.newestAt ? new Date(st.newestAt).toLocaleString('zh-CN') : '（空）'}`)
      console.log(`  超期（>${st.ttlDays} 天）：${st.expired} 条 → 用 --corpus --prune [--apply] 清理`)
      if (st.byChat.length) {
        console.log('  按会话：')
        for (const c of st.byChat) console.log(`    ${c.chatKey}  ${c.count} 条`)
      }
      console.log('')
      corpus.close()
      process.exit(0)
    })().catch((error) => {
      console.error(`❌ 语料库操作失败：${error?.message ?? error}`)
      process.exit(1)
    })
    return
  }

  // ── 配方库：沉淀"怎么做" ──────────────────────────────────────────────────
  if (process.argv.includes('--recipes')) {
    ;(async () => {
      const R = await import('./recipes.mjs')
      const workspace = config.dsh?.workspace
      if (!workspace) {
        console.error('❌ 配置里没有 dsh.workspace，无法定位配方库目录')
        process.exit(2)
      }
      const argOf = (name) => {
        const i = process.argv.indexOf(name)
        return i >= 0 ? process.argv[i + 1] : null
      }

      // ── 手动跑一次自动抽取（R4 的**可重复验证入口**）────────────────────
      //
      // 为什么必须有它：自动抽取是"每 5 轮在后台跑一次、失败静默"的路径 ——
      // 出问题时既等不起 5 轮，也没法只跑一次看原文。而**它第一次上真机就失败了**
      // （模型多写了两个 `}`，见 extract.mjs 的 dropPrematureRootClose）。
      // 当时是靠"临时脚本 + 手动去翻 DSH 落盘的抽取会话"才把原文捞回来的 ——
      // 这一条把那次的手工动作固化成一个命令。
      //
      // ⚠️ 会**真的调用一次模型**（有少量费用），且必须能起子进程。
      if (process.argv.includes('--extract')) {
        const E = await import('./extract.mjs')
        const T = await import('./tasks.mjs')
        const O = await import('./oplog.mjs')
        const chatKey = argOf('--inject')
        if (!chatKey) {
          console.error('❌ 用法：--recipes --extract --inject <会话> [--dry]')
          console.error('   例：--recipes --extract --inject private:100000001')
          console.error('   （--dry = 只看抽取结果，不入库；会真的调一次模型）')
          process.exit(2)
        }
        const cliPath = config.dsh?.cliPath
        if (!cliPath) {
          console.error('❌ 没找到 dsh CLI —— 检查 config.json 的 dsh.searchPaths')
          process.exit(2)
        }
        const kind = String(chatKey).startsWith('group:') ? 'group' : 'private'
        const task = T.readTask({ workspace, chatKey })
        const ops = O.readOps({ workspace, chatKey, limit: 40 })
        const prompt = E.buildExtractPrompt({ task, ops, kind })
        console.log(`会话 ${chatKey}｜台账步骤 ${task?.steps?.length ?? 0} 条｜操作流水 ${ops.length} 条`)
        console.log('正在跑 headless 抽取（会调用一次模型）…')
        const t0 = Date.now()
        const r = await E.runHeadless({ cliPath, prompt, cwd: workspace, timeoutMs: 90_000 })
        console.log(`headless：${r.ok ? 'ok' : '失败'}（${Date.now() - t0}ms）${r.why ? `｜${r.why}` : ''}`)
        if (!r.ok) process.exit(1)
        console.log(`\n原文（${r.text.length} 字）：\n${r.text.slice(0, 1500)}`)
        const parsed = E.parseLooseJson(r.text)
        if (!parsed) {
          console.error('\n❌ 解析不出 JSON（原文见上）—— 这正是最该留证据的失败')
          process.exit(1)
        }
        if (parsed.skip === true) {
          console.log('\n模型判定这件事不值得沉淀（skip）—— 正常结果，不入库')
          process.exit(0)
        }
        const norm = R.normalizeRecipe(parsed, { source: 'auto' })
        if (!norm) {
          console.error('\n❌ 解析出来了，但过不了字段校验（没有标题 / 既没步骤也没关键词）→ 不入库')
          process.exit(1)
        }
        console.log(`\n解析出的配方：\n${JSON.stringify(norm, null, 2)}`)
        if (process.argv.includes('--dry')) {
          console.log('\n（--dry：没有入库）')
          process.exit(0)
        }
        const up = R.upsertRecipe({ workspace, recipe: parsed, source: 'auto' })
        console.log(`\n入库：${JSON.stringify(up)}`)
        process.exit(up.ok ? 0 : 1)
      }

      if (argOf('--add')) {
        // ★ 优先 `--file`：`--json` 要穿过 shell 的引号解析，而配方里全是中文与引号，
        //   PowerShell 下实测很容易被搅坏（报错还很难看懂）。`--file` 把它绕开。
        const file = argOf('--file')
        const raw = file ? null : argOf('--json')
        if (!file && !raw) {
          console.error('❌ 用法：')
          console.error("     --recipes --add --file <配方.json>        ← **推荐**（避开 shell 引号问题）")
          console.error('     --recipes --add --json \'{"title":"...","trigger":{"keywords":[...]},"steps":[...]}\'')
          process.exit(2)
        }
        let parsed = null
        if (file) {
          try {
            const fs = await import('node:fs')
            let text = fs.readFileSync(file, 'utf8')
            // ⚠️ 必须剥 BOM：Windows 上 `Out-File` / 记事本写的 UTF-8 **带 BOM**，
            //    而 `JSON.parse` 遇到 BOM 直接抛 `Unexpected token ''`。
            //    项目里所有 `readJson`（memory-store / tasks / oplog / recipes）
            //    都有这一句；这个 CLI 入口是漏网的那个（实测被它咬了一次）。
            if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
            parsed = JSON.parse(text)
          } catch (e) {
            console.error(`❌ 读不了 / 解析不了 ${file}：${e.message}`)
            process.exit(2)
          }
        } else {
          try {
            parsed = JSON.parse(raw)
          } catch (e) {
            console.error(`❌ --json 不是合法 JSON：${e.message}`)
            console.error('   （中文与引号很容易被 shell 搅坏 —— 建议改用 --file）')
            process.exit(2)
          }
        }
        const r = R.upsertRecipe({ workspace, recipe: parsed, source: 'manual' })
        if (!r.ok) {
          console.error(`❌ ${r.why}`)
          process.exit(1)
        }
        console.log(`✅ ${r.merged ? '已合并进' : '已新增'} ${r.id}`)
        process.exit(0)
      }

      const one = argOf('--show') ?? argOf('--enable') ?? argOf('--disable') ?? argOf('--forget')
      if (one) {
        const id = one
        if (process.argv.includes('--enable') || process.argv.includes('--disable')) {
          const r = R.setRecipeEnabled({ workspace, id, enabled: process.argv.includes('--enable') })
          if (!r.ok) {
            console.error(`❌ ${r.why}`)
            process.exit(1)
          }
          console.log(`✅ ${id} 已${r.recipe.enabled ? '启用' : '停用'}`)
          process.exit(0)
        }
        if (process.argv.includes('--forget')) {
          const ok = R.removeRecipe({ workspace, id })
          console.log(ok ? `✅ 已删掉 ${id}` : `（没有这条配方：${id}）`)
          process.exit(ok ? 0 : 1)
        }
        const rec = R.readRecipe({ workspace, id })
        if (!rec) {
          console.error(`❌ 没有这条配方：${id}`)
          process.exit(1)
        }
        console.log('')
        console.log(`${rec.title}${rec.enabled === false ? '  **已停用**' : ''}`)
        console.log(`  来源 ${rec.source} · 置信 ${R.confidenceOf(rec).toFixed(2)} · 用过 ${rec.stats?.used ?? 0} 次（成功 ${rec.stats?.succeeded ?? 0} / 失败 ${rec.stats?.failed ?? 0}）`)
        console.log(`  触发关键词：${(rec.trigger?.keywords ?? []).join('、') || '（无）'}`)
        if (rec.trigger?.intent) console.log(`  意图：${rec.trigger.intent}`)
        console.log('  步骤：')
        for (const s of rec.steps ?? []) console.log(`    ${s}`)
        if ((rec.pitfalls ?? []).length) {
          console.log('  坑：')
          for (const p of rec.pitfalls) console.log(`    ${p}`)
        }
        if (rec.verify) console.log(`  验收：${rec.verify}`)
        if ((rec.requiredActions ?? []).length) console.log(`  通常需要：${rec.requiredActions.join('、')}（只提示，不自动执行）`)
        console.log('')
        process.exit(0)
      }

      const text = argOf('--match')
      const all = R.listRecipes({ workspace })
      console.log('')
      console.log(`配方库（${all.length} 条）`)
      console.log(`工作区：${workspace}`)
      console.log('')
      if (all.length === 0) {
        console.log('   （还没有配方）')
        console.log('   ★ 自动沉淀需要一次额外的模型调用 —— 本机走的是「起一个一次性 DSH 进程」那条路')
        console.log('     （0.2.3 起也有直连通路 src/model-direct.mjs，但抽取目前没换过去）。')
        console.log('     所以自动沉淀**尚未接通** —— 现在可以先人工加：')
        console.log('       node src/index.mjs --recipes --add --json \'{"title":"...","trigger":{"keywords":["..."]},"steps":["..."]}\'')
      } else {
        for (const r of all) console.log(`  · ${R.summarizeRecipe(r)}`)
      }
      if (text) {
        console.log('')
        console.log(`匹配预览：「${text}」`)
        const scored = all
          .map((r) => ({ r, score: R.matchScore(r, text), conf: R.confidenceOf(r) }))
          .sort((a, b) => b.score - a.score)
        for (const s of scored.slice(0, 5)) {
          console.log(`   ${s.score >= R.MATCH_THRESHOLD ? '✓' : '·'} ${s.score.toFixed(2)}  ${s.r.title}`)
        }
        const picked = R.pickRecipes(all, text)
        console.log('')
        if (picked.length === 0) {
          console.log(`   → 都不注入（阈值 ${R.MATCH_THRESHOLD}，且置信度需 ≥ ${R.INJECT_MIN_CONFIDENCE}）`)
        } else {
          console.log('   → 会注入下面这段：')
          for (const l of R.renderRecipeBlock(picked).split('\n')) console.log(`     ${l}`)
        }
      }
      console.log('')
      process.exit(0)
    })().catch((error) => {
      console.error(`❌ 配方库操作失败：${error?.message ?? error}`)
      process.exit(1)
    })
    return
  }

  // ── 任务台账：它"正在干什么、干到哪了" ──────────────────────────────────
  //
  //   --tasks [--inject <会话>]        看台账（含注入预览 —— 同一份渲染函数）
  //   --tasks --rollback <N> [--mode]  回到第 N 步
  //   --tasks-archive [--apply]        归档过期台账（**默认预演**）
  //   --tasks --forget <会话>          删掉某会话的台账
  if (process.argv.includes('--tasks') || process.argv.includes('--tasks-archive')) {
    ;(async () => {
      const {
        listTasks, readTask, renderTaskBlock, archiveStaleTasks, forgetTask,
        rollbackTask, ROLLBACK_MODES,
      } = await import('./tasks.mjs')
      const workspace = config.dsh?.workspace
      if (!workspace) {
        console.error('❌ 配置里没有 dsh.workspace，无法定位任务台账目录')
        process.exit(2)
      }
      const argOf = (name) => {
        const i = process.argv.indexOf(name)
        return i >= 0 ? process.argv[i + 1] : null
      }

      // ── 回到第 N 步 ──────────────────────────────────────────────────────
      if (argOf('--rollback') !== null) {
        const chatKey = argOf('--inject')
        if (!chatKey) {
          console.error('❌ 用法：--tasks --rollback <N> --inject <会话> [--mode replay|retry|abandon]')
          process.exit(2)
        }
        const r = rollbackTask({
          workspace,
          chatKey,
          step: argOf('--rollback'),
          mode: argOf('--mode') ?? 'replay',
          note: argOf('--note') ?? '',
        })
        if (!r.ok) {
          console.error(`❌ ${r.why}`)
          process.exit(1)
        }
        console.log('')
        console.log(`✅ 已回退到第 ${r.task.checkpoint.step} 步（${ROLLBACK_MODES[r.task.redo.mode]}）`)
        console.log(`   ${r.target?.action ?? ''}`)
        console.log('')
        console.log('   ⚠️ 两点如实说明：')
        console.log('      · **DSH 的会话上下文不会回退** —— 模型仍然"记得"那些步骤的内容，')
        console.log('        我们唯一能做的是在下一轮提示词里**声明它们作废**（不是清除）。')
        console.log('      · **副作用不回退** —— 已发出的 QQ 消息、已写入工作区的文件都不会回滚。')
        console.log('')
        console.log('   下一轮注入会变成：')
        for (const l of renderTaskBlock(r.task).split('\n')) console.log(`     ${l}`)
        console.log('')
        process.exit(0)
      }

      if (process.argv.includes('--tasks-archive')) {
        const apply = process.argv.includes('--apply')
        const r = archiveStaleTasks({ workspace, apply })
        console.log('')
        console.log(`任务台账归档${apply ? '【实做】' : '【预演 —— 不写盘，加 --apply 才真移】'}`)
        console.log(`工作区：${workspace}`)
        console.log(`  要归档 ${r.moved.length} 个，保留 ${r.kept.length} 个`)
        for (const f of r.moved) console.log(`     → ${f}`)
        console.log('  （归档 = 移到 runtime/archive/，**不是删除**）')
        console.log('')
        process.exit(0)
      }

      if (argOf('--forget')) {
        const key = argOf('--forget')
        const ok = forgetTask({ workspace, chatKey: key })
        console.log(ok ? `✅ 已删掉 ${key} 的任务台账` : `（${key} 没有台账）`)
        process.exit(0)
      }

      const chatKey = argOf('--inject') ?? null
      const files = listTasks({ workspace })
      console.log('')
      console.log('任务台账（只读）：它"正在干什么、干到哪了"')
      console.log(`工作区：${workspace}`)
      console.log('')
      if (files.length === 0) {
        console.log('   （还没有台账 —— 说明还没有回合被记下来）')
      }
      const keys = chatKey ? [chatKey] : files.map((f) => f.replace(/^runtime\/tasks\//, '').replace(/\.json$/, ''))
      for (const key of keys) {
        const task = readTask({ workspace, chatKey: key })
        if (!task) {
          console.log(`  · ${key}：没有台账`)
          continue
        }
        const age = Math.round((Date.now() - Number(task.lastActiveAt ?? 0)) / 60000)
        console.log(`  ── ${key} ──`)
        console.log(`     状态 ${task.status} · ${task.turns ?? 0} 轮 · 最后活动 ${age} 分钟前`)
        if (task.goal) console.log(`     目标（${task.goalSource ?? '?'}）：${task.goal}`)
        console.log(`     步骤 ${task.steps?.length ?? 0} 条，失败 ${task.tried?.length ?? 0} 条，被挡 ${task.blocked?.length ?? 0} 条`)
        for (const s of (task.steps ?? []).slice(-8)) {
          const mark = s.outcome === 'ok' ? '✓' : s.outcome === 'failed' ? '✗' : s.outcome === 'blocked' ? '🔒' : '…'
          console.log(`       ${mark} ${s.action}${s.result ? ` → ${String(s.result).slice(0, 50)}` : ''}`)
        }
        const block = renderTaskBlock(task)
        console.log('')
        console.log('     注入预览（模型每轮看到的就是这段）：')
        for (const l of block.split('\n')) console.log(`       ${l}`)
        console.log('')
      }
      process.exit(0)
    })().catch((error) => {
      console.error(`❌ 读任务台账失败：${error?.message ?? error}`)
      process.exit(1)
    })
    return
  }

  // ── 唤醒判定报表（影子模式的兑现路径）────────────────────────────────────
  //
  // 为什么它必须存在：`#wakeGate` 每条判定都往 oplog 写一行（无论 `shadow` 开不开），
  // 但 `--ops` 的渲染是**为回合设计的**（按 `{turn}/{step}` 对齐），wake 行没有这两个
  // 字段 ⇒ 打出来是畸形的 `t?s?   wake`。**结论有地方写、没有地方看**。
  // 这个入口补上"看"的那一半，并且把设计文档 §10.5 要求的**抽样人工复核**与
  // **漏回率**做出来 —— 那才是影子模式的全部价值所在。
  //
  //   --wake [--inject <会话>] [--limit N]      看报表（只读）
  //   --wake --ok 1,3 --miss 2,4                记下人工复核结果（只写 runtime/wake-labels.json）
  //   --wake --json                             机器可读（给界面/脚本用）
  if (process.argv.includes('--wake')) {
    ;(async () => {
      const { readOps, listOplogs } = await import('./oplog.mjs')
      const { summarizeWakeOps, renderWakeReport, readWakeLabels, writeWakeLabels, WAKE_LABELS_REL, DEFAULT_SAMPLE_LIMIT } =
        await import('./wake-report.mjs')
      const workspace = config.dsh?.workspace
      if (!workspace) {
        console.error('❌ 配置里没有 dsh.workspace，无法定位操作日志目录')
        process.exit(2)
      }
      const argOf = (name) => {
        const i = process.argv.indexOf(name)
        return i >= 0 ? process.argv[i + 1] : null
      }
      const chatKey = argOf('--inject') ?? null
      const sampleLimit = Math.max(1, Number(argOf('--limit')) || DEFAULT_SAMPLE_LIMIT)

      // ★ 读多少条：wake 行只是 oplog 里的一小部分（还有 tool/call、assistant…），
      //   所以这里要一个**足够大**的原始行数上限，不能只取 40 条然后统计出个笑话。
      const raw = readOps({ workspace, chatKey, limit: 20_000 })

      // ── 人工复核标注（可选动作）────────────────────────────────────────
      //   编号 → 这一轮样本列表里的第 n 条；**按 ts 写盘**（编号会随新增行变化，
      //   ts 不会）—— 并把写进去的是哪几条**回显出来**，标错了能一眼看到。
      const okArg = argOf('--ok')
      const missArg = argOf('--miss')
      if (okArg || missArg) {
        // 直接用文件顶部已有的 fs/path 导入，不再动态 import（少一层、也更好读）
        const readFile = (abs) => (existsSync(abs) ? readFileSync(abs, 'utf8') : null)
        const writeFile = (abs, body) => {
          mkdirSync(join(abs, '..'), { recursive: true })
          writeFileSync(abs, body, 'utf8')
        }
        const { labels } = readWakeLabels({ workspace, readFile })
        const base = summarizeWakeOps({ rows: raw, labels, sampleLimit })
        const nums = (v) => String(v ?? '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0)
        const apply = (list, mark) => {
          const done = []
          for (const n of nums(list)) {
            const s = base.samples.find((x) => x.index === n)
            if (!s) continue
            labels[String(s.ts)] = mark
            done.push(s)
          }
          return done
        }
        const oks = apply(okArg, 'ok')
        const misses = apply(missArg, 'miss')
        const w = writeWakeLabels({ workspace, labels, write: writeFile })
        console.log('')
        console.log(`${w.ok ? '✅' : '❌'} 复核结果${w.ok ? '已写入' : '写入失败'} ${WAKE_LABELS_REL}（共 ${w.written} 条${w.why ? `｜${w.why}` : ''}）`)
        for (const [mark, list] of [['✅ 判对', oks], ['❌ 漏回', misses]]) {
          for (const s of list) console.log(`   ${mark}  #${s.index} [${new Date(s.ts).toLocaleString()}] 「${String(s.excerpt).slice(0, 40)}」`)
        }
        const bad = nums(`${okArg ?? ''},${missArg ?? ''}`).filter((n) => !base.samples.some((x) => x.index === n))
        if (bad.length > 0) {
          console.log(`   ⚠️ 编号 ${bad.join('、')} 不在这一轮样本里（没记）—— 编号会随新增判定而变，` +
            `**以 ts 为准**：请重跑 --wake 看当前列表`)
        }
        console.log('')
        console.log('（下面按最新标注重出报表）')
      }

      const { labels: labels2, why: labelWhy } = readWakeLabels({
        workspace,
        readFile: (abs) => (existsSync(abs) ? readFileSync(abs, 'utf8') : null),
      })
      const summary = summarizeWakeOps({
        rows: raw,
        labels: labels2,
        sampleLimit,
        window: { from: null, to: null, files: listOplogs({ workspace, chatKey }).length },
      })
      summary.workspace = workspace
      // ── 成本估算（只在真拿到了 token 数时才算；取不到单价就如实显示 `—`）─────
      //   ⚠️ 与 `usage.mjs` 的账本**互不相干**：账本记的是"回合"，判定是"账外的一次
      //      小调用"。所以这里只给一个**参考量级**，不要把它当成账本的一部分。
      try {
        const { createPriceBook } = await import('./prices.mjs')
        const { estimateCost } = await import('./prices.mjs')
        if (summary.tokens.rows > 0) {
          const book = createPriceBook({ file: resolveInPackage(config.usage?.pricesFile ?? 'prices.json'), log: () => {} })
          const priced = book?.rateForAt?.(config.dsh?.model, new Date(summary.window.to || Date.now())) ?? null
          const cost = priced ? estimateCost(summary.tokens, priced.rate, priced.rateKey) : null
          summary.cost = cost === null ? null : { cny: cost, rateKey: priced?.rateKey ?? null, priced: true }
        } else {
          summary.cost = null
        }
      } catch {
        summary.cost = null
      }
      if (labelWhy) summary.warnings.unshift(labelWhy)
      console.log('')
      console.log(renderWakeReport(summary, { json: process.argv.includes('--json') }))
      console.log('')
      process.exit(0)
    })()
  }

  // ── 操作日志（oplog）：agent"自己干过什么" ────────────────────────────────
  //
  // 两个入口（都在工作区的 runtime/oplog/ 下）：
  //   --ops [--inject <会话>] [--limit N]   看流水
  //   --ops-prune [--apply]                 按 TTL 清理（**默认预演**）
  if (process.argv.includes('--ops') || process.argv.includes('--ops-prune')) {
    ;(async () => {
      const { readOps, pruneOplogs, listOplogs, OPLOG_TTL_DAYS } = await import('./oplog.mjs')
      const workspace = config.dsh?.workspace
      if (!workspace) {
        console.error('❌ 配置里没有 dsh.workspace，无法定位操作日志目录')
        process.exit(2)
      }
      const argOf = (name) => {
        const i = process.argv.indexOf(name)
        return i >= 0 ? process.argv[i + 1] : null
      }
      const chatKey = argOf('--inject') ?? null

      if (process.argv.includes('--ops-prune')) {
        const apply = process.argv.includes('--apply')
        const r = pruneOplogs({ workspace, apply })
        console.log('')
        console.log(`操作日志清理${apply ? '【实做】' : '【预演 —— 不写盘，加 --apply 才真删】'}`)
        console.log(`工作区：${workspace}`)
        console.log(`保留 ${OPLOG_TTL_DAYS} 天（早于 ${r.cutoff} 的删掉）`)
        console.log('')
        console.log(`  要删 ${r.removed.length} 个，保留 ${r.kept.length} 个` +
          (r.skipped.length ? `，${r.skipped.length} 个认不出日期**不动**` : ''))
        for (const f of r.removed.slice(0, 20)) console.log(`     - ${f}`)
        if (r.removed.length > 20) console.log(`     …还有 ${r.removed.length - 20} 个`)
        if (r.skipped.length) {
          console.log('  认不出日期的（保守起见不删）：')
          for (const f of r.skipped.slice(0, 10)) console.log(`     · ${f}`)
        }
        console.log('')
        process.exit(0)
      }

      const limit = Math.max(1, Number(argOf('--limit')) || 40)
      const rows = readOps({ workspace, chatKey, limit })
      console.log('')
      console.log('操作日志（只读；回答"它自己干过什么"）')
      console.log(`工作区：${workspace}`)
      if (chatKey) console.log(`会话  ：${chatKey}`)
      console.log('')
      const files = listOplogs({ workspace, chatKey })
      if (files.length === 0) {
        console.log('   （还没有操作日志 —— 说明还没有回合被记下来）')
        console.log('   （oplog 在每次回合结束后由桥接写入，不依赖模型报告）')
      } else {
        console.log(`   文件 ${files.length} 个，最近 ${rows.length} 条：`)
        console.log('')
        // ⚠️ 列对齐按 `turn/step` 后的**那一列**算，但那一列**只有工具类记录才有内容**：
        //    `assistant`（💬 说话）与 `turn/end`（⏹ 结束）都不是工具调用，
        //    没有工具名可显示。第一版照搬工具格式，结果说明列空着、看着像"数据缺失"。
        //    现在把这一列的内容各按语义填：工具名 / "我说话" / "本轮结束"。
        for (const r of rows) {
          const t = new Date(r.ts).toTimeString().slice(0, 8)
          const pos = `t${r.turn ?? '?'}s${r.step ?? '?'}`
          if (r.type === 'tool/call') {
            const a = r.args && typeof r.args === 'object' ? JSON.stringify(r.args) : String(r.args ?? '')
            console.log(`   ${t} ${pos.padEnd(8)} → ${r.name}  ${a.slice(0, 70)}`)
          } else if (r.type === 'tool/result') {
            const mark = r.ok === true ? '✓' : r.ok === false ? '✗' : '?'
            console.log(`   ${t} ${pos.padEnd(8)}   ${mark} ${`${r.bytes ?? 0} 字`}  ${String(r.excerpt ?? '').replace(/\s+/g, ' ').slice(0, 55)}`)
          } else if (r.type === 'approval' || r.type === 'approval/decided') {
            console.log(`   ${t} ${pos.padEnd(8)}   🔒 ${r.toolName ?? ''} ${r.outcome ?? ''} ${String(r.reason ?? '').slice(0, 36)}`)
          } else if (r.type === 'assistant') {
            console.log(`   ${t} ${pos.padEnd(8)}   💬 说了 ${r.chars ?? 0} 字`)
          } else if (r.type === 'turn/end') {
            const u = r.usage ?? {}
            const used = u.input || u.output
              ? `，用 ${u.input ?? 0}+${u.cacheRead ?? 0} 入 / ${u.output ?? 0} 出`
              : ''
            console.log(`   ${t} ${pos.padEnd(8)}   ⏹ 本轮结束（${r.reason?.kind ?? r.reason ?? '?'}${used}）`)
          } else {
            console.log(`   ${t} ${pos.padEnd(8)}   ${r.type}`)
          }
        }
        console.log('')
        console.log('   ★ 只留结果摘要（截断），全文在 DSH 的会话记录里 ——')
        console.log('     操作日志是"干了什么"的索引，不是内容仓库。')
      }
      console.log('')
      process.exit(0)
    })().catch((error) => {
      console.error(`❌ 读操作日志失败：${error?.message ?? error}`)
      process.exit(1)
    })
    return
  }

  const killArgIdx = process.argv.findIndex((a) => a === '--kill')
  // ══════════════════════════════════════════════════════════════════════════
  // ⚠️ `--kill` 必须**排在 `--processes` 前面**（这里修过一个死代码 bug）
  // ══════════════════════════════════════════════════════════════════════════
  // 原顺序是先判 `--processes` 再判 `--kill`，而前者结尾就 `process.exit(0)` ——
  // 于是按提示语写的 `--processes --kill <pid>` **永远只打列表、从不真杀**，
  // 而它自己打印的提示恰恰就是那句命令。使用者会以为杀掉了，
  // 实际上旧进程还在抢 OneBot 事件流（同一句话被回两次）。
  //
  // 契约：**同时给出两者时，`--kill` 优先**（带 pid 的动作用意图最明确）。
  if (killArgIdx >= 0) {
    const pid = process.argv[killArgIdx + 1]
    if (!pid) {
      console.error('❌ 用法：node src/index.mjs --kill <pid>（或先 --processes 看列表）')
      process.exit(2)
    }
    const r = guard.killEntry(pid)
    if (r.ok) console.log(`✅ 已停掉 pid ${r.pid}`)
    else {
      console.error(`❌ 未能停掉 pid ${pid}：${r.error}`)
      process.exit(1)
    }
    process.exit(0)
  }
  if (listProcesses) {
    const entries = guard.list()
    console.log('\n进程登记（cache/processes.json）：')
    if (entries.length === 0) console.log('  （空）')
    for (const e of entries) {
      console.log(
        `  pid ${String(e.pid).padEnd(7)} ${e.profile.padEnd(8)} 端口 ${String(e.port ?? '-').padEnd(6)} ` +
          `${e.state.padEnd(8)} ${e.isSelf ? '（当前进程）' : ''} ${e.reason ?? ''}`,
      )
    }
    // ── 冲突判定用"在跑的桥接**数量**"，不能用 `!isSelf` ────────────────────
    //
    // ⚠️ 这里踩过一次：原本写成 `!e.isSelf && (alive || stale)`。
    //   而 `--processes` 是**另起的一个进程**，对它来说 `isSelf` 恒为 false ——
    //   于是哪怕**只有唯一一个桥接在跑**，也会报「有 1 个其它桥接在跑」，
    //   并指引去 kill 那个唯一条目（实测：清干净后列表只剩一条 alive，警告照旧）。
    //
    //   正确口径是数量：1 条 = 正常，≥2 条 = 真冲突（两个在抢同一份事件流）。
    //   判定逻辑抽在 `runningBridges()` 里，有单测盯着（纯函数，可测）。
    const running = runningBridges(entries)
    if (running.length > 1) {
      console.log(
        `\n⚠️ 有 ${running.length} 个桥接在跑：同时跑两个会抢同一个 OneBot 事件流` +
          '（同一句话可能被回两次）。建议停掉多余的那些。',
      )
      console.log(`   要停掉某个：node src/index.mjs --processes --kill <pid>`)
    }
    console.log('')
    process.exit(0)
  }

  console.log(`\n配置文件：${configPath}`)
  console.log(`工作区  ：${config.dsh.workspace}`)
  console.log(`权限模式：${config.dsh.permissionMode}`)
  console.log(`模型    ：${config.dsh.provider} / ${config.dsh.model}`)
  console.log(`管理员  ：${config.access.adminUsers.length ? config.access.adminUsers.join(', ') : '（未配置）'}`)
  console.log('')

  for (const w of warn) console.log(`⚠️  ${w}`)
  if (fatal.length) {
    for (const f of fatal) console.error(`❌ ${f}`)
    process.exit(1)
  }

  // ── 外部技能：扫一次目录并装载（0.2.2）──────────────────────────────────
  //
  // ★ 放在 `--check` 之前：这样"我装的技能到底行不行"可以在**不连任何服务**的情况下问出来
  //   （`node src/index.mjs --check`），而不是等到机器人跑起来才发现工具没注册。
  // ★ 也放在所有只读 CLI（--ui/--memory/--delivery…）**之后**：那些入口是查询，
  //   没有理由为了看个用量就去 import 第三方技能代码。
  const skillScan = await loadSkills({ config, log })
  // ★ 0.2.2：QQ 工具总开关关着时，**技能工具也不会挂上去**（两者都走 MCP）。
  //   这时"开着某个技能"是个自欺状态：工具不存在、提示词指引也不会注入
  //   （见 extensions.mjs 的 collectSkillPromptSections）。所以起机就说一句，
  //   而不是等使用者纳闷"我明明开着它，怎么不用"。
  if (config.mcp?.enabled === false) {
    const onSkills = skillScan.skills.filter((s) => s.ok && isSkillEnabled(s, config))
    if (onSkills.length > 0) {
      log(
        `⚠️ mcp.enabled = false：QQ 工具与**技能工具**都不会挂给模型，` +
          `已启用技能（${onSkills.map((s) => s.id).join('、')}）的提示词指引也不会注入。` +
          `要用技能，请先打开「QQ 原生功能（MCP）」这个总开关。`,
      )
    }
  }
  // ── 表情包：重新打标签的**任务控制器**（0.2.4）────────────────────────────
  //
  // ★ 必须在**启动时创建一次**（不能在 HTTP 路由里 new）：任务状态与"正在跑"
  //   的判定要跨请求存活，否则每次请求都拿到一个空闲的新对象，
  //   "防重复点击"（两个任务同时写 library.json → 后写的覆盖先写的）就完全失效。
  const retagJob = createRetagJob({
    log: (m) => log(m),
    // 空闲时的预检（纯读库、零调用）：界面据此说出"这次会打多少张"
    resolvePreflight: () =>
      preflightRetag({ workspace: config.dsh?.workspace, dir: config.skills?.sticker?.libraryDir ?? 'stickers' }),
  })

  const extensionService = createExtensionService({
    config,
    configPath,
    skills: skillScan.skills,
    skillsDir: skillScan.dir,
    log,
    validate: validateConfig,
    normalize: normalizeConfig,
  })

  if (checkOnly) {
    // 技能的问题要在自检里说出来（它们是"配置没错但功能没生效"的典型来源）
    for (const s of skillScan.skills) {
      for (const e of s.errors) console.log(`⚠️ 技能 ${s.dirName}：${e}`)
      for (const w of s.warnings) console.log(`⚠️ 技能 ${s.dirName}：${w}`)
      if (s.ok && !s.loaded) console.log(`⚠️ 技能 ${s.id}：${s.loadError}`)
    }
    // 项目简介副本（agent 靠它回答"你能做什么 / 你能改我的文件吗"）。
    // ★ 这里**只报告、不写文件** —— `--check` 的契约是"不连任何服务、也不改任何东西"。
    {
      const st = projectDocStatus({ workspace: config.dsh?.workspace })
      if (!st.sourceFound) {
        console.log('ℹ️  项目简介：这个包里没有 docs/项目简介.md（发布包不带它）—— agent 读不到自己的说明书')
      } else if (!st.copyExists) {
        console.log(`ℹ️  项目简介：源在，但工作区里还没有副本 —— 启动后会自动写到 ${st.copyRel}`)
      } else {
        console.log(`📄 项目简介副本：${st.copyRel}（源 ${st.source}）`)
      }
    }
    console.log('\n✅ 配置自检通过（--check 模式，未连接任何服务）\n')
    return
  }

  // ── 配置界面要用的几个部件 ─────────────────────────────────────────────
  //
  // ⚠️ 路径一律经 `resolveInPackage`，**不要用 `process.cwd()`** ——
  // 本包要能整体搬走（`verify-manifest.mjs` 里有专门的断言查这一条）。
  const priceBook = createPriceBook({
    file: resolveInPackage(config.usage.pricesFile),
    log,
  })
  const usageLedger = createUsageLedger({
    file: join(DIRS.logs, 'usage.jsonl'),
    priceBook,
    enabled: config.usage.enabled !== false,
    log,
  })
  const memoryStore = createMemoryStore({
    workspace: config.dsh.workspace,
    enabled: config.memory?.enabled !== false,
    log,
  })

  // 界面构建溯源：启动时算一次（只读、很便宜），放进 /api/status。
  // 它回答"正在伺服的这份 UI 与源码是不是同一份" —— 见 src/ui-status.mjs 的说明。
  const { checkUiFreshness } = await import('./ui-status.mjs')
  const uiFreshness = checkUiFreshness({ distDir: join(PKG_ROOT, 'config-ui', 'dist') })
  if (uiFreshness.status !== 'fresh') {
    // ★ 不静默，但**也不阻止启动** —— 界面不同步不影响机器人回话。
    log(
      `⚠️ 控制台界面与源码不同步（${uiFreshness.status}）：${uiFreshness.why}` +
        `｜${uiFreshness.advice}`,
    )
  } else {
    log(`控制台界面与源码同步（构建于 ${uiFreshness.stamp?.builtAt ?? '?'}）`)
  }
  // 名单与权限分级。**与 Bridge 共用同一个实例** —— 缓存的好友/群列表
  // 才能被配置接口复用，而不是各拉一份。
  const roster = createRoster({ config, log })
  // SnowLuma 的终端输出（界面上的"终端"面板读它）。
  // 读它的**日志文件**而不是 stdout —— 实测文件是 UTF-8，stdout 是终端编码
  // （重定向会变 GBK 乱码）。详见 src/snowluma-log.mjs。
  const snowlumaLog = createSnowlumaLogReader({
    // 已由 normalizeConfig 解析成绝对路径，这里直接透传。
    installDir: config.snowluma?.installDir || undefined,
  })

  // ── 两个给 start.bat 用的小工具开关 ────────────────────────────────────
  //
  // 为什么不写在 start.bat 里而放这儿：**发现 SnowLuma 装在哪的逻辑只有一份**
  // （src/local.mjs 的 findSnowluma）。批处理里再实现一遍，就会有两份会漂移的
  // 规则 —— 而这种漂移正是之前"启动了错的那份 SnowLuma"的根源。
  // 所以 start.bat 只负责调用，判断全在 JS 里。

  if (openConsoleOnly) {
    // ★★ 打开网页端之前**先等 SnowLuma 真的就绪**（`--wait-snowluma[=<秒>]`）。
    //
    // 为什么必须有这一步：start.bat 的 `--snowluma` 是**立刻返回**的（spawn 完就走），
    // 紧接着打开浏览器就会看到 SnowLuma「启动中途」的那一页（未登录 / 空列表），
    // 使用者得手动刷新一下才对 —— 而"刷新一下就好了"这种症状会被当成偶发，长期留着。
    // 判据不是"控制台可达"，而是 `status === 'connected'`（OneBot 在应答**且认我们的 token**）：
    // 控制台在钩住 QQ 之前就起来了，所以 5099 能打开完全不等于登录好了。
    const waitArg = process.argv.find((a) => a === '--wait-snowluma' || a.startsWith('--wait-snowluma='))
    if (waitArg) {
      const secs = Number(String(waitArg).split('=')[1])
      const timeoutMs = (Number.isFinite(secs) && secs > 0 ? secs : 60) * 1000
      const ready = await waitForSnowlumaReady({
        config,
        log: (m) => console.log(m),
        timeoutMs,
        // ⚠️ 这里**不能**传 `wsConnected: () => onebot.connected` / `getLogin: () => loginInfo`：
        //    这一段在 `onebot` / `loginInfo` 声明**之前**执行（那些东西在下面的启动流程里才建），
        //    闭包一旦被调用就会撞上 TDZ（`Cannot access 'loginInfo' before initialization`）。
        //    对这个用途也没必要 —— `connected` 的判据是 `get_login_info` 真的回了 user_id
        //    （OneBot 在应答**且已登录**），与桥接自己那条 WS 无关。
        detect: makeLaunchDetect({ config, log }),
      })
      if (ready.ok) console.log(`✅ ${ready.hint}`)
    }
    // 打开 SnowLuma 的网页端（浏览器）
    const r = await openSnowlumaConsole({ config, log })
    console.log(r.ok ? `✅ ${r.data.hint}` : `❌ ${r.error}`)
    return
  }

  if (snowlumaOnly) {
    // 启动 SnowLuma 进程（已经在跑就不重复启动）
    const tokens = resolveOnebotTokens({
      config,
      installDir: config.snowluma?.installDir || undefined,
    })
    if (tokens.differsFromConfig) {
      console.log('⚠️  config.json 里的 token 与 SnowLuma 自己的配置不一致。')
      console.log(`   实际用的是【${tokens.source}】里的那一组（见 src/snowluma.mjs）。`)
    }
    const r = await startSnowluma({
      config,
      log,
      // ★ 必须传 `detect` —— 这条路原先**漏了它**，代价是"防重复启动"少了一道防线。
      //
      //   `startSnowluma` 的防重复是两步：① 探控制台 ② 问"OneBot 端点上应答的
      //   是不是**正确的那份**"。第②步靠 `detect` 提供判据；不传的话
      //   `typeof detect !== 'function'` 会让整段被静默跳过，只剩第①步。
      //   后果很具体：只要控制台探测失败一次（典型情况是 SnowLuma 改过 WebUI
      //   端口，而 consoleUrl 还写着 5099），哪怕它正在正常服务，这里也会
      //   **再 spawn 一个实例** —— 端口冲突、甚至抢登录态，正是第②步要防的事。
      //
      //   用 `makeLaunchDetect` 和界面按钮那条路**共用同一个实现**，
      //   而不是在这里手写一遍：两边各写一遍的下场就是其中一边漏掉（已经发生过）。
      detect: makeLaunchDetect({ config, log }),
    })
    if (r.ok) {
      console.log(r.data.started ? `✅ ${r.data.hint}` : `ℹ️  ${r.data.hint}`)
      if (r.data.cmd) console.log(`   入口：${r.data.cmd}（来源：${r.data.discoveredBy}）`)
      if (config.snowluma?.consoleUrl) console.log(`   网页端：${config.snowluma.consoleUrl}`)
    } else {
      console.log(`❌ ${r.error}`)
      process.exitCode = 1
    }
    return
  }

  // ── 体检模式：真的去连一次 OneBot，把实际结果报出来 ──────────────────
  // 与 --check 的区别：--check 只看配置本身；--doctor 会发起真实探测
  // （HTTP 请求 + WebSocket 握手），所以能查出"端口填错""token 填反"
  // 这类只有连了才知道的问题。它不发 QQ 消息、不调用大模型。
  if (doctorOnly) {
    // 把进程登记一并交给体检 —— "另一个桥接也在跑"是唯一一类
    // "每个实例自己都正常、合起来却出怪事"的故障，必须能看出来。
    const result = await runDoctor({ config, validate, processes: guard.list() })
    const allOk = printDoctor(result)
    if (result.fatal.length) process.exit(1)
    process.exit(allOk ? 0 : 2)
  }

  // 工作区必须真实存在：它是沙箱的根，不存在的话 agent 会以奇怪的状态启动
  mkdirSync(config.dsh.workspace, { recursive: true })

  // ── 认领进程：清理死条目 + **报告冲突** + 登记自己 + 开心跳 ─────────────
  // 放在这里（真正要启动机器人之前）而不是更早：`--check` / `--doctor` 是只读
  // 体检，不该在登记表里留下痕迹。
  // ★ 冲突**只报告不擅自杀**：判定依据里含"心跳过期"这种可能误判的信号，
  //   而误杀一个正在干活的机器人比多跑一个更糟。要停得用 --processes --kill。
  guard.claim()
  guard.startHeartbeat()

  // ── 把「QQ 工具」挂给模型（必须在起 DSH 之前，否则新进程读不到）────────
  //
  // 背景：模型跑在 dsh 子进程里、看不到桥接的 OneBot 连接，而 SDK 没有工具通道。
  // 唯一接法是让 DSH 的 MCP 客户端加载我们的工具服务器 —— 见 mcp/mcp-qq-server.mjs
  // 与 src/mcp-profile.mjs 里的完整说明。
  //
  // 整段**允许失败**：QQ 工具是增强能力，不该因为挂载失败就让机器人起不来。
  if (config.mcp?.enabled !== false) {
    try {
      // token 只写进 cache 目录，**不写 workspace**
      // （workspace 里的文件 agent 能读到，而 agent 不该看到 token）
      const mcpConfigPath = writeMcpConfig({
        cacheDir: join(PKG_ROOT, 'cache'),
        httpUrl: config.onebot.httpUrl,
        httpToken: config.onebot.httpToken,
        timeoutMs: config.mcp?.toolTimeoutMs ?? 20_000,
        // ★ H7：`qq_search_history` 要读工作区里的语料库（不含密钥，放进这份配置是安全的）
        workspace: config.dsh?.workspace ?? null,
        // ★ 0.2.2：`qq_send_image` 要**每次调用现读** `security.allowPrivateImageHosts`，
        //   否则界面上打开那个开关还要重启才生效。
        configPath,
        // ★ 0.2.3：暴露档位与通用口开关 —— MCP 子进程据此决定 `tools/list` 放哪些工具。
        //   两者默认值都等于"升级前的行为"（full + 通用口开），收紧是显式选择。
        profile: config.mcp?.profile ?? 'full',
        genericApi: config.mcp?.genericApi !== false,
      })

      // ── 技能工具服务器（0.2.2）────────────────────────────────────────
      //
      // ★ 只在**确实有可用技能**时才写这一段：没装技能就不该多起一个进程
      //   （这条对"零成本"很重要 —— 技能不是所有人都用）。
      // ★ 删掉技能目录后，下一次启动这里会传 null，profile 里那一段会被**整块移除**
      //   （否则会永远留着一个指向不存在目录的服务器，日志里天天报错）。
      let skillsMcp = null
      const usableSkills = skillScan.skills.filter((s) => s.ok && !s.loadError)
      if (usableSkills.length > 0) {
        // 技能的 npm 依赖桥：把它需要的、宿主自带的那几个包软链到 skills/node_modules，
        // 否则技能里的普通 `import('undici')` 会在真机上 ERR_MODULE_NOT_FOUND
        // （本包的运行期依赖在 vendor/node_modules，不在 node_modules —— 见 src/vendor.mjs）。
        const bridged = ensureSkillNodeModules({
          skillsDir: skillScan.dir,
          vendorNodeModules: DIRS.vendorNodeModules,
          log,
        })
        if (bridged.missing.length > 0) {
          log(
            `⚠️ 技能依赖 ${bridged.missing.join('、')} 不在 vendor/node_modules 里 —— ` +
              `用得到它的技能（例如 pixiv 插件的代理支持）会自己报「代理不可用」。` +
              `修法：在本目录 npm install，然后重跑 setup.mjs。`,
          )
        }
        try {
          const skillsConfigPath = writeSkillsMcpConfig({
            cacheDir: join(PKG_ROOT, 'cache'),
            skillsDir: skillScan.dir,
            configPath,
            workspace: config.dsh?.workspace ?? null,
          })
          skillsMcp = {
            serverPath: join(PKG_ROOT, 'mcp', 'mcp-skills-server.mjs'),
            configPath: skillsConfigPath,
            timeoutMs: 60_000,
          }
        } catch (error) {
          log(`⚠️ 技能工具的 MCP 配置生成失败（技能仍可在离线巡检里看到）：${error?.message ?? error}`)
        }
      }

      // 定位 DSH_HOME（profiles/ 在它下面）。
      // ⚠️ 不能"从 CLI 路径反推" —— 第一版就是这么错的：DSH 可能是全局安装，
      // 而 profile 在用户数据目录，两者无路径关系，结果把补丁写进了**安装目录**。
      // 现在按已知候选找（环境变量 → 桌面版默认位置 → 安装目录旁兜底），
      // 详见 local.mjs 的 resolveDshHome。
      const resolved = resolveDshHome({ cliPath: config.dsh.cliPath })
      if (!resolved) {
        throw new Error(
          '找不到 DSH_HOME（profiles 所在目录）。请设环境变量 DSH_HOME 指向 harness 目录。',
        )
      }

      // ★ 把解析结果**显式写回环境变量**。
      //
      // 为什么必须这么做：`sdk-rpc.mjs` 起 DSH 子进程时是从
      // `process.env.DSH_HOME` 找凭据文件的（见 credentials.mjs）。
      // 如果这个环境变量**本来没设**，我们就解析出了 home 也传不下去 ——
      // 于是子进程读不到 API key，每一次模型调用都以 MISSING_CREDENTIAL
      // 立刻失败，表现是"机器人能收到消息但没有任何输出内容"。
      process.env.DSH_HOME = resolved.home

      const profilePatchPath = join(resolved.home, 'profiles', 'sdk', 'cordis.patch.yml')

      const { changed } = ensureSdkProfilePatch({
        profilePatchPath,
        nodePath: process.execPath,
        serverPath: join(PKG_ROOT, 'mcp', 'mcp-qq-server.mjs'),
        configPath: mcpConfigPath,
        skills: skillsMcp,
      })
      log(
        changed
          ? `QQ 工具已挂到 sdk profile（重启 DSH 子进程后模型就能调）：${profilePatchPath}`
          : `QQ 工具挂载已是最新：${profilePatchPath}`,
      )
      log(
        skillsMcp
          ? `技能工具已挂到 sdk profile：${usableSkills.length} 个技能（${usableSkills.map((s) => s.id).join('、')}）`
          : '没有可用的技能，profile 里的技能工具段已清空',
      )
    } catch (error) {
      log(`⚠️ QQ 工具挂载失败（不影响机器人本体）：${error?.message ?? error}`)
    }
  } else {
    log('QQ 工具已按配置关闭（mcp.enabled = false）')
  }

  // 启动时刻：/api/status 要报 uptime
  const startedAt = new Date()

  // 日志文件
  const logPath = join(PKG_ROOT, config.ui.logFile)
  mkdirSync(dirname(logPath), { recursive: true })
  logFile = logPath

  // ★ 把 `logFile` 就绪**之前**攒下的日志补写进去（顺序不变，仍在"桥接启动"之前）。
  //   为什么必须有：启动期的告警（MCP 接线、技能依赖桥…）发生在这里之前，
  //   而无窗口运行时它们的 console 输出没人看得见 —— 等于没写。见 earlyLogLines 的说明。
  if (earlyLogLines.length > 0) {
    try {
      ensureLogBom(logFile)
      appendFileSync(logFile, earlyLogLines.join('\n') + '\n')
    } catch {
      /* 写日志失败不该影响主流程 */
    }
    earlyLogLines.length = 0
  }

  log(`=== 桥接启动 === 工作区=${config.dsh.workspace} 权限=${config.dsh.permissionMode}`)

  // ── 模型凭据自检（★ "机器人不输出内容"那个故障的护栏）────────────────
  //
  // ⚠️ 位置很关键：必须在 `logFile` 赋值**之后**。
  //    第一版放在了 MCP 接线那段（更早），而那些日志只进控制台 ——
  //    桥接是无窗口运行的，等于**写了没人看得见**。
  //    这类"日志写了但看不到"的问题和"没写日志"一样糟。
  //
  // 缺 key 时的表现**只是"没输出"**：不抛异常、不报错，排查极费时间。
  //
  // ★ H13：自检结果**留一份给启动前置条件门控**（`/api/preflight`）——
  //   界面要能回答"为什么它不说话"，而判据只能有一份。
  let credentialInfo = null
  {
    const dshHome = process.env.DSH_HOME ?? resolveDshHome({ cliPath: config.dsh.cliPath })?.home
    const cred = resolveModelCredentials({ dshHome, env: process.env, apiKey: config.dsh.apiKey })
    credentialInfo = { ok: Boolean(cred.env.DEEPSEEK_API_KEY), source: cred.source, warning: cred.warning ?? '' }
    if (cred.env.DEEPSEEK_API_KEY) {
      log(`🔑 模型凭据：已就绪（来源：${cred.source}）`)
    } else {
      log(`❌ 模型凭据缺失：${cred.warning}`)
      log('   → 这样启动的话，机器人能收到消息但**不会产生任何回复内容**（只会回一句兜底话术）。')
      log('   → 打开控制台「高级」页填一次 API Key，或设环境变量 DEEPSEEK_API_KEY。')
    }
  }

  // ── 起 DSH ──
  const rpc = new SdkRpcClient({
    cliPath: config.dsh.cliPath,
    cwd: config.dsh.workspace,
    provider: config.dsh.provider,
    model: config.dsh.model,
    reasoningEffort: config.dsh.reasoningEffort,
    apiKey: config.dsh.apiKey,
    log,
  })
  rpc.onStderr((line) => log(`[dsh] ${line}`))

  try {
    await rpc.start({ permissionMode: config.dsh.permissionMode })
    log('✅ DSH 就绪')
  } catch (error) {
    console.error(`❌ 无法启动 DSH：${error.message}`)
    log(`❌ 无法启动 DSH：${error.message}`)
    process.exit(1)
  }

  // ── 连 QQ ──
  const onebot = new OneBotClient({ ...config.onebot, log })
  const sendQueue = new SendQueue({ ...config.send, log })
  const router = new SessionRouter({ log })
  const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, usageLedger, roster, log, skills: skillScan.skills })
  bridge.attach(onebot)

  // 记下登录信息，供配置接口的 /api/status 使用
  let loginInfo = null
  onebot.addEventListener('connected', async () => {
    try {
      const info = await onebot.getLoginInfo()
      loginInfo = info
      log(`✅ 已登录 QQ：${info?.nickname ?? '?'}（${info?.user_id ?? '?'}）`)
      if (config.access.adminUsers.length === 0) {
        log('⚠️ 尚未配置管理员，机器人不会回复任何人')
      }
      // 打一行样例，证明 sessionId 生成正常（不含原始 QQ 号）
      log(`   会话键样例：私聊 <QQ号> → ${makeSessionId('private', config.access.adminUsers[0] ?? '0')}`)
    } catch (error) {
      log(`⚠️ get_login_info 失败：${error.message}`)
    }
  })
  onebot.connect()

  // ── 本地配置接口（给配置 UI 用）────────────────────────────────────────
  // 只监听回环地址：配置里含 accessToken，公开到局域网等于交出控制权。
  // 端口/开关都在 config.json 的 ui 段里 —— 关掉它不影响机器人本体工作。
  let apiServer = null
  if (config.ui.apiEnabled !== false) {
    /**
     * 读**盘上**那份配置（不是启动时缓存的那份）。
     *
     * 为什么人设栏要读盘：界面改完配置、或刚点了「切换人设」，人设栏必须马上
     * 按新配置说话（与 `GET /api/config` 同一个口径）。读不到（文件被删/写坏）就
     * 回落启动时那份 —— 界面宁可显示旧状态，也不该整块空白。
     */
    const readConfigFromDisk = () => {
      try {
        return JSON.parse(readFileSync(configPath, 'utf8'))
      } catch {
        return config
      }
    }
    const apiHandler = createApiHandler({
      configPath,
      readRawConfig: () => JSON.parse(readFileSync(configPath, 'utf8')),
      writeRawConfig: (cfg) => writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8'),
      normalize: normalizeConfig,
      validate: validateConfig,
      // 状态里**不放 token**，只给 UI 需要的运行信息
      getStatus: () => ({
        running: true,
        startedAt: startedAt.toISOString(),
        uptimeMs: Date.now() - startedAt.getTime(),
        login: loginInfo ? { userId: String(loginInfo.user_id), nickname: loginInfo.nickname } : null,
        connected: onebot.connected,
        dshAlive: rpc.alive,
        adminUsers: config.access.adminUsers,
        permissionMode: config.dsh.permissionMode,
        workspace: config.dsh.workspace,
        groupEnabled: config.trigger.groupEnabled,
        stats: bridge.stats,
        // 进程登记：让界面能显示"是不是还有别的桥接在跑"（缺陷 3）。
        // 这里只给"数量 + 冲突项"，不给完整命令行（那里面可能带路径）。
        processes: (() => {
          const entries = guard.list()
          const others = entries.filter((e) => !e.isSelf && (e.state === 'alive' || e.state === 'stale'))
          return {
            selfPid: guard.selfPid,
            total: entries.length,
            running: entries.filter((e) => e.state === 'alive' || e.state === 'stale').length,
            conflicts: others.map((e) => ({ pid: e.pid, state: e.state, reason: e.reason })),
          }
        })(),
        // ★ 正在伺服的那份界面"是哪来的"（构建溯源）。
        //   回答的是"你看到的 UI 与源码是不是同一份" —— 界面分两条路出货
        //   （开发路径与发布包路径），而它们**脱钩过一次**（实测：包里那份旧了
        //   5 小时，1100 项测试全绿）。所以这里如实报出三种状态，不混成一句
        //   "不同步"：`stale`（源码改了没构建）与 `unstamped`（无法自证来源）
        //   的处理方式完全不同，含糊会让人往错的方向修。
        ui: uiFreshness,
      }),
      // 会话同步：给"同步 QQ 对话界面"用（内存镜像，最近若干条）
      getConversations: () => bridge.listConversations(),
      runDoctor: async () => {
        const result = await runDoctor({ config, validate: validateConfig })
        return { fatal: result.fatal, warn: result.warn, rows: result.rows }
      },
      // ── 配置界面新增的几组 ──
      // 探雪露马：**用当下的真实探测**，不是缓存值 —— 界面就是要看"现在活没活"。
      detectSnowluma: makeLaunchDetect({
        config,
        log,
        wsConnected: () => onebot.connected,
        getLogin: () => loginInfo,
        bridgeRunning: true,
      }),
      // 界面按钮：只打开 SnowLuma 的网页端（**不启动进程** —— 那是 start.bat 的事）。
      // 这样按钮的职责与它的能力匹配：能确定做到"打开一个本机网页"，
      // 而"启动进程"会开出第二个实例（端口冲突、抢登录态）。
      openSnowlumaConsole: () => openSnowlumaConsole({ config, log }),
      // 界面上的"终端"面板：读 SnowLuma 自己的日志文件（UTF-8，不是 stdout）
      snowlumaLog,
      // 名单配置用：拉真实好友/群列表。复用 Bridge 那份 roster（共享缓存）。
      roster,
      onebotCall: (action, params) => onebot.call(action, params),
      // 保留给 start.bat 用（真实启动进程）
      startSnowluma: () =>
        startSnowluma({
          config,
          log,
          // 和 `--snowluma` 那条路**共用同一个工厂**（见 makeLaunchDetect 的说明：
          // 两边各写一遍就会有一边漏掉，真实发生过）。
          // 区别只在于这条路上桥接在跑，所以能提供真实的连接状态与登录缓存。
          detect: makeLaunchDetect({
            config,
            log,
            wsConnected: () => onebot.connected,
            getLogin: () => loginInfo,
            bridgeRunning: true,
          }),
        }),
      priceBook,
      usageLedger,
      memoryStore,
      // ── 扩展（技能 / 插件，0.2.2）────────────────────────────────────────
      // 这一组是**唯一**会"改配置且不要求重启"的接口 —— 语义与理由见
      // src/extensions-service.mjs 的文件头（写盘 + 改活配置对象，两件事都要做）。
      listExtensions: () => extensionService.list(),
      toggleExtension: (args) => extensionService.toggle(args),
      saveSkillSettings: (args) => extensionService.saveSettings(args),
      diagnoseSkill: (id) => extensionService.diagnose(id),
      // ── 表情包：重新打标签（0.2.4）────────────────────────────────────────
      //
      // ★ 它是一个**长任务**（每张图一次模型调用），所以实现是"发起 + 轮询"：
      //   见 `src/sticker-tagging.mjs` 的 `createRetagJob`（同一时刻只允许一个任务）。
      //
      // ★ 模型通路**在后端解析**（`resolveDirectTarget`，与唤醒判定共用
      //   `wake.judge.apiKey` 的解析规则）—— 密钥绝不下发到界面。
      //   没配 key 时返回 422 + 人话原因，而不是让按钮点了没反应。
      //
      // ★ `retagJob` 必须**在启动时创建一次**（不能在路由里 new）：
      //   任务状态与"正在跑"的判定要跨请求存活，否则每次请求都拿到一个空闲的新对象，
      //   "防重复点击"就完全失效了。
      stickerRetag: async ({ action = 'status', force = false } = {}) => {
        if (action === 'status') return retagJob.status()
        if (action === 'abort') {
          const r = retagJob.abort()
          return r.ok ? { ...r, ...retagJob.status() } : { error: r.why, status: 422 }
        }
        const target = resolveDirectTarget({ config })
        if (!target?.ok) {
          return {
            error:
              `没有可用于打标签的模型通路：${target?.why ?? '未知'}。` +
              '打标签要"看图"，需要一把能直连的 API key（设置里的 wake.judge.apiKey）与一个支持图片输入的模型。',
            status: 422,
          }
        }
        const r = retagJob.start({
          workspace: config.dsh?.workspace,
          dir: config.skills?.sticker?.libraryDir ?? 'stickers',
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          model: target.model,
          force,
        })
        return r.ok ? r : { error: r.why, status: 422 }
      },
      // ── 人设库（0.2.2）────────────────────────────────────────────────────
      // 形状：`personas/<名字>.md` 一个文件一套人设，按需切换（`persona.active`）。
      //
      // ★ 读的一侧算的是**"当前实际在用哪一套"**：`active` → 老 `custom` → 老 `preset`
      //   三条规则的合成结果（`resolveActivePersona`），界面只显示不自己判。
      // ★ 读的配置是**盘上那份**（与 GET /api/config 同源），不是启动时缓存的那份 ——
      //   否则界面上刚改完、人设栏却还按旧配置说"当前在用 X"。
      // ★ 写的一侧：`applyPersonaAction` 只**算**（能离线测），改配置由 api.mjs 的路由
      //   按与 /api/config 同一套纪律落盘（校验 + .bak）—— 那条纪律只有一份实现。
      personasList: () => describePersonaShelf({ dir: DIRS.personas, config: readConfigFromDisk() }),
      personasAction: (args = {}) => applyPersonaAction({ dir: DIRS.personas, ...args }),
      // ── 联系人昵称（按人，0.2.2）──────────────────────────────────────────
      // 读写走 src/contacts.mjs（格式只有一处实现）。
      // ★ 写完**必须刷新记忆快照**：`memory/contacts.md` 落在 `memory/` 下，会被记忆的
      //   篡改检测扫到；不刷快照的话下一轮就把这次改动**回滚**掉（记忆文件那条路踩过同样的坑）。
      contactsList: () => summarizeContacts({ workspace: config.dsh?.workspace }),
      contactsSave: ({ qq, nickname } = {}) => {
        const workspace = config.dsh?.workspace
        if (!workspace) return { error: '配置里没有工作区，没法存昵称', status: 422 }
        const id = String(qq ?? '').trim()
        if (!/^\d{5,15}$/.test(id)) return { error: `QQ 号不合法：${id || '（空）'}`, status: 400 }
        const cur = readContacts({ workspace })
        if (!cur.ok) return { error: cur.error, status: 422 }
        const rest = (cur.contacts ?? []).filter((c) => c.qq !== id)
        // 空昵称 = 删除（界面上的「删除」按钮）
        const list = String(nickname ?? '').trim() === '' ? rest : [...rest, { qq: id, nickname }]
        const w = writeContacts({ workspace, contacts: list })
        if (!w.ok) return { error: w.error, status: 422 }
        try {
          saveSnapshot({ workspace, rel: CONTACTS_REL })
        } catch {
          /* 快照失败不阻断保存（下一轮会报"文件被改过"，但不是坏事） */
        }
        return {
          ...summarizeContacts({ workspace }),
          saved: true,
          restartRequired: false,
          hint: '已保存，**下一轮就生效**（不需要重启）。',
        }
      },
      // ★ 控制台保存/删除记忆后**必须刷新快照基准**，否则下一次读记忆会
      //   把它当"绕过桥接的改动"回滚 —— 表现是「界面上删掉的条目自己又回来了」，
      //   而且不报错。取证与边界写在 api.mjs 的 `/api/memory/file` 两个路由上：
      //   篡改检测要防的是**模型绕过桥接**（它手里有 write 工具），
      //   控制台是桥接给主人的界面 —— 主人改自己的记忆被回滚是缺陷，不是安全。
      saveMemorySnapshot: (rel) =>
        rel ? saveSnapshot({ workspace: config.dsh.workspace, rel }) : false,      dropMemorySnapshot: (rel) =>
        rel ? dropSnapshot({ workspace: config.dsh.workspace, rel }) : false,
      // 取图路由用：对话里的图片只从 workspace/inbox 出。
      // config.dsh.workspace 在归一化阶段已是绝对路径（resolveInPackage）。
      workspaceRoot: config.dsh.workspace,

      // ══════════════════════════════════════════════════════════════════
      // H13：界面的四组后端能力
      // ══════════════════════════════════════════════════════════════════

      // ① 启动前置条件门控：每条都带**可操作的话**。
      //
      // ★ 为什么放在后端而不是界面里各写一遍：判据只有一份才不会漂移 ——
      //   界面自己判断"协议端活没活"时用的是**另一个**探测（通常是 /api/status 的缓存值），
      //   于是出现"界面说正常、实际没登录"这种最费时间的分歧。
      preflight: async () => {
        const gates = []
        const push = (id, ok, level, title, hint = '', action = '') =>
          gates.push({ id, ok: ok === true, level, title, hint, action })

        // 配置：有没有阻断级问题
        let problems = []
        try {
          problems = validateConfig(config)?.problems ?? []
        } catch (error) {
          problems = [`配置校验本身出错：${error?.message ?? error}`]
        }
        push('config', problems.length === 0, problems.length ? 'blocker' : 'info',
          problems.length ? `配置有 ${problems.length} 处问题` : '配置校验通过',
          problems.slice(0, 3).join('；'), 'node src/index.mjs --check')

        // 管理员名单：空 = fail-closed（谁都不能用）——这是**故意的**，但要让人知道
        const adminCount = config.access?.adminUsers?.length ?? 0
        push('admins', adminCount > 0, adminCount > 0 ? 'info' : 'blocker',
          adminCount > 0 ? `管理员 ${adminCount} 人` : '管理员名单为空（fail-closed：所有私聊都不会回）',
          adminCount > 0 ? '' : '不知道填谁就先发一条私聊，日志里的 QQ 号就是它',
          'node src/index.mjs --ui → 访问控制')

        // 协议端：真的去问一次（不看缓存）
        //
        // ⚠️ 判据是"**抛不抛**"：`onebot.call()` 成功时返回 `body.data`、失败时**抛**。
        //    第一版这里写成 `r.status === 'ok' || r.retcode === 0` —— 而 `r` 是 data
        //    （`get_status` 的 data 里没有 `status`/`retcode`），于是**明明通了也报"不可达"**。
        //    真机上就是这个现象，被 `mocks/probe-h13-endpoints.mjs` 抓到。
        let probe = { ok: false, why: '还没探' }
        try {
          const data = await onebot.call('get_status', {})
          probe = { ok: true, data }
        } catch (error) {
          const t = error?.transport
          probe = {
            ok: false,
            why: `${error?.message ?? error}${t ? `（层：${t.layer ?? '?'}${t.retryable ? '，可重试' : '，重试没用'}）` : ''}`,
          }
        }
        push('onebot', probe.ok, probe.ok ? 'info' : 'blocker',
          probe.ok ? '协议端可达' : '协议端不可达',
          probe.ok ? '' : probe.why, 'start.bat（或 start.bat --doctor）')

        const loggedIn = Boolean(probe.login || loginInfo)
        push('login', loggedIn, loggedIn ? 'info' : 'blocker',
          loggedIn ? `已登录：${(probe.login ?? loginInfo)?.nickname ?? '（无昵称）'}` : '尚未登录 QQ',
          loggedIn ? '' : '协议端在跑但没登录 —— 去它的控制台扫码', 'start.bat')

        // DSH 子进程
        push('dsh', rpc.alive === true, rpc.alive ? 'info' : 'blocker',
          rpc.alive ? 'DSH 子进程就绪' : 'DSH 子进程没起来（模型调不了）',
          rpc.alive ? '' : '看 logs/bridge.log 里的 [rpc] 行', 'node src/index.mjs --doctor')

        // 凭据：来源要能自证
        const credLine = credentialInfo?.ok ? `模型凭据就绪（来源：${credentialInfo.source}）` : ''
        push('credentials', Boolean(credLine), credLine ? 'info' : 'warn',
          credLine || '没有取到模型凭据',
          credLine ? '' : (credentialInfo?.warning || '模型调用会以 MISSING_CREDENTIAL 立刻失败（症状只有"回合结束但无文本"）'),
          'node src/index.mjs --doctor')

        return {
          ok: gates.every((g) => g.ok || g.level !== 'blocker'),
          blockers: gates.filter((g) => !g.ok && g.level === 'blocker').length,
          gates,
        }
      },

      // ② 账号发现：**只回摘要，绝不回 token**（凭据永远不出本机进程）
      listAccounts: () => {
        const dir = config.snowluma?.installDir
          ? resolveInPackage(config.snowluma.installDir)
          : join(PKG_ROOT, 'vendor', 'snowluma')
        const names = listAccountNames(dir)
        const found = discoverOnebotConfig({
          installDir: dir,
          selfId: config.onebot?.selfId ?? '',
          knownTokens: { httpToken: config.onebot?.accessToken, wsToken: config.onebot?.wsToken },
        })
        const pickedFile = String(found.picked ?? '')
        return {
          installDir: dir,
          // ★ 只给"有哪些账号 + 谁是当前在用的"，**一个字符的 token 都不给**。
          // ⚠️ 第一版这里写错了：`pickedFile.includes(String(n.file ?? n.name ?? ''))`，
          //    而 `listAccountNames()` 返回的是**账号号字符串**（不是对象）——
          //    于是 `String(undefined ?? undefined ?? '')` = `''`，而
          //    **`任何字符串.includes('')` 都是 true** → 两个账号**都**被标成"当前在用"。
          //    这种错误不报错、界面看起来还挺正常，只有对着输出数一遍才发现。
          accounts: names.map((uin) => {
            const file = `onebot_${uin}.json`
            return { uin: String(uin), file, isCurrent: file.length > 'onebot_.json'.length && pickedFile.includes(file) }
          }),
          current: pickedFile || null,
          why: found.why ?? '',
          // 判定依据里可能含文件名（账号号属于公开标识），但**不含 token**
          matchedByConfig: /matched-config/.test(pickedFile),
        }
      },

      // ③ 本地语料检索（fail-closed 已经在路由里做了；这里只负责真的去搜）
      searchCorpus: ({ query, chatKey, limit }) => {
        const c = createCorpus({ workspace: config.dsh.workspace, readOnly: true, log: () => {} })
        try {
          const r = c.search({ query, chatKey, limit })
          return {
            ok: r.ok === true,
            mode: r.mode ?? null,
            why: r.why ?? null,
            // ⚠️ 字段名按语料库**真实的**形状来（第一版按 `row.text` / `row.at` 取，
            //    结果全空 —— 真实字段是 `preview`（已截断）与 `createdAt`）。
            // ★ 这里叫 `preview` 而不是 `text`：语料库返回的**本来就是截断预览**，
            //   把预览叫成正文是一种小小的谎话（界面会以为拿到的是全文）。
            rows: (r.rows ?? []).map((row) => ({
              mid: row.messageId ?? null,
              at: row.createdAt ?? null,
              chatKey: row.chatKey ?? chatKey,
              sender: row.senderName ?? row.userId ?? (row.isBot ? '（机器人）' : ''),
              isBot: row.isBot === true,
              preview: row.preview ?? '',
            })),
          }
        } finally {
          c.close()
        }
      },

      // ③-b 记忆检索（H13）：在**记忆文件**里按关键词找条目。
      //
      // 与语料检索的分工：语料库是"**说过什么**"（消息流水，带 TTL）；
      // 记忆是"**沉淀下来的事实**"（条目、跨重启生效）。两者都要能搜 ——
      // 以前记忆只能靠界面逐个文件点开看，条目攒到几十条之后就没人翻得动了。
      //
      // ★ 实现在 `src/memory-search.mjs`（纯函数、文件系统可注入）：
      //   实现与测试用**同一份**代码，避免"测试里照着再写一遍"那种迟早分叉的二次实现。
      searchMemory: ({ query, limit }) => searchMemoryFiles({ workspace: config.dsh.workspace, query, limit }),

      // ③-c 记忆写入统计（0.2.1）：四列 + 零写入告警。
      // 阈值从 STATS_DEFAULTS 带给界面 —— 它是**后端常量不是配置项**，
      // 界面拿到后只做展示（"满 N 轮才判定"），不要做成可编辑输入框。
      memoryStats: () => ({
        threshold: STATS_DEFAULTS.zeroWriteAfterTurns,
        rows: readAllStats(config.dsh.workspace),
      }),

      // ③-d 隐私拦截审计：两侧**分开计数**（写入侧多 = 老想记隐私；
      // 输出侧多 = 想往外说隐私，后者更值得报警）。只回类别与字数 ——
      // 审计里本来就没有原文，这里也不从别处捞。
      privacyAudit: ({ limit = 20 } = {}) => {
        const recent = readPrivacyAudit({ workspace: config.dsh.workspace, limit })
        const all = readPrivacyAudit({ workspace: config.dsh.workspace, limit: 10000 })
        return {
          recent,
          storeCount: all.filter((a) => a.side === 'store').length,
          outputCount: all.filter((a) => a.side !== 'store').length,
          categories: PRIVACY_CATEGORIES,
        }
      },

      // ③-d-b 扫描盘上记忆（**只读**，与 CLI `--memory --privacy` 同一份判定逻辑）。
      // ★ 只回**位置**（文件 + 行号 + 类别），不回原文、不回预览 ——
      //   使用者在记忆页签的编辑器里自己去看那一行。
      scanMemoryPrivacy: async () => {
        const report = inspectMemory({ workspace: config.dsh.workspace, conversations: [] })
        const targets = report.files.map((f) => f.rel)
        const hits = []
        let scanned = 0
        const byCategory = {}
        for (const rel of targets) {
          let text = ''
          try {
            text = readFileSync(join(config.dsh.workspace, rel), 'utf8')
          } catch {
            continue
          }
          const lines = text.split('\n')
          for (let i = 0; i < lines.length; i += 1) {
            const t = lines[i].replace(/^-\s*/, '').trim()
            if (!t || t.startsWith('#')) continue
            scanned += 1
            const r = scanPrivacy(t)
            if (!r.hit) continue
            hits.push({ rel, line: i + 1, categories: r.categories })
            for (const c of r.categories) byCategory[c] = (byCategory[c] ?? 0) + 1
          }
        }
        return { scanned, hitCount: hits.length, hits, byCategory, categories: PRIVACY_CATEGORIES }
      },

      // ④ 日志流：按游标增量取（**轮询，不是 SSE** —— 见 CONFIG-UI.md 里的说明与理由）
      logStream: ({ since = 0, limit = 200 } = {}) => {
        const rel = join(PKG_ROOT, 'logs', 'bridge.log')
        if (!existsSync(rel)) return { lines: [], cursor: since, total: 0, eof: true, why: '还没有日志文件' }
        // ★ 切片逻辑在 `src/log-tail.mjs`（纯函数）：实现与测试用**同一份**代码，
        //   避免"测试里照着再写一遍"那种迟早分叉的二次实现。
        return sliceLogLines({ lines: splitLogText(readFileSync(rel, 'utf8')), since, limit })
      },
      onConfigSaved: () => log('配置已通过接口保存（需重启桥接才生效）'),
      // 停止/重启：动作本身由 api.mjs 延后执行（先响应 UI 再动进程）。
      // shutdown 在下方定义，这里只是闭包引用，调用时早已初始化。
      requestStop: () => {
        log('收到配置接口的停止请求')
        shutdown('api-stop', { exitDelayMs: 400 })
      },
      requestRestart: () => {
        log('收到配置接口的重启请求')
        // ★ 顺序（改动过，理由见缺陷 2）：**先释放端口，再起新进程**。
        //   原先是先 respawn 再 shutdown，于是新进程经常在旧进程还没放开端口时
        //   就来绑定 —— 只试一次就失败，然后被降级成一句 warning，结果两个桥接
        //   同时在跑、控制台指向旧的那个。现在由代码保证端口先空出来，
        //   新进程那边还有 bindApiWithRetry 兜底重试。
        ;(async () => {
          try {
            if (apiServer) {
              try {
                await apiServer.close()
              } catch {
                /* 关接口失败不影响重启 */
              }
              apiServer = null
              log('已释放配置接口端口，开始拉起新进程')
            }
            const { pid, target } = respawnBridge(log, { port: config.ui.apiPort })
            log(`已拉起新的桥接进程（pid ${pid ?? '?'}）：${target}`)
          } catch (error) {
            log(`❌ 拉起新桥接进程失败：${error.message}（本进程继续运行，请手动重启）`)
            return
          }
          await shutdown('api-restart', { exitDelayMs: 500 })
        })()
      },
    })

    try {
      // 控制台界面（config-ui 的构建产物）存在就一并伺服在同一个端口上，
      // 这样 start.bat 打开 http://127.0.0.1:3410/ 就是完整控制台，无需另起服务。
      const uiDist = join(PKG_ROOT, 'config-ui', 'dist')
      const staticDir = existsSync(join(uiDist, 'index.html')) ? uiDist : undefined
      apiServer = await bindApiWithRetry({
        port: config.ui.apiPort,
        handler: apiHandler,
        staticDir,
        log,
      })
      if (staticDir) log(`控制台界面：http://127.0.0.1:${config.ui.apiPort}/`)
    } catch (error) {
      // 接口起不来**不该让机器人起不来** —— 它只是给 UI 用的辅助能力。
      // ★ 但**不许静默**：端口被别人占着是最可能的原因，而它的后果是
      //   "控制台显示的是另一个进程" —— 必须留一条 error 级证据。
      log(`❌ 配置接口未能启动：${error.message}`)
      log(
        '   → 机器人本体照常工作，但**控制台界面不可用**。' +
          '若你打开的控制台看起来"不对劲"，八成是另一个桥接进程还占着这个端口。',
      )
      log('   → 查占用：netstat -ano | findstr :' + config.ui.apiPort + '（最后一列是 PID）')
      apiServer = null
    }
  } else {
    log('配置接口已按配置关闭（ui.apiEnabled = false）')
  }

  // ── 优雅退出 ──
  //
  // ★★ 这里有一条贯穿全局的硬规则：**退出可以慢，但绝不能退不掉。**
  //
  // 起因是一次真实事故：旧进程卡住关不掉、和新进程抢端口与 PID。
  // 所以 shutdown 有**总预算**（SHUTDOWN_BUDGET_MS），到点就强制收尾并退出 ——
  // 每一小步各自还有自己的超时（bridge.close 8s、rpc.shutdown 15s），
  // 但"每一步都不超时"并不等于"总时间可控"，所以最外层必须有截止。
  let closing = false
  let apiServerClosed = false
  const SHUTDOWN_BUDGET_MS = 20_000

  /** 关掉配置接口（幂等：requestRestart 可能已经关过，释放端口用）。 */
  const closeApiServer = async () => {
    if (!apiServer || apiServerClosed) return
    apiServerClosed = true
    try {
      await apiServer.close()
    } catch {
      /* 关接口失败不影响退出 */
    }
    apiServer = null
  }

  /** 真正的收尾动作（由 shutdown 用预算包住）。 */
  const shutdownSteps = async () => {
    // ★ 顺序很重要：**先让在途回复发完，再关 QQ 通道**。
    //
    // 原来是反过来（第一件事就是 onebot.close()），后果实测过：
    // 一条回复因"静默时段"被延迟 116 秒，而使用者在它发出前重启了桥接 ——
    // 通道当场断开，那条**已经生成好**的回复永远丢了，使用者只看到"没理我"。
    try {
      await bridge.close()
    } catch (error) {
      log(`⚠️ 等待在途回复时出错（继续退出）：${error?.message ?? error}`)
    }
    onebot.close()
    await closeApiServer()

    // DSH：先请它自己收尾；**拿不到确认就强杀，并且强杀也要拿确认**。
    // 这一段是"孤儿 DSH 继续持有工作区"的根治点 —— 见 sdk-rpc.mjs 的 kill()。
    let stopped = { stopped: true }
    try {
      const graceful = await rpc.shutdown()
      if (!graceful.graceful) stopped = await rpc.kill()
    } catch (error) {
      log(`⚠️ 关停 DSH 时出错（转强杀）：${error?.message ?? error}`)
      stopped = await rpc.kill()
    }
    if (!stopped.stopped) {
      // 不许假装成功：这条日志是"工作区可能仍被占用"的唯一线索
      log(`❌ 未能确认 DSH 子进程退出：${stopped.error ?? '原因未知'}`)
      log('   → 它可能仍持有工作区与会话库。请检查任务管理器里的 node.exe，')
      log('     否则下一次启动会出现"两个 agent 写同一份工作区"。')
    } else if (stopped.method && stopped.method !== 'kill') {
      log(`DSH 子进程已强制终止（${stopped.method}，pid ${stopped.pid}）`)
    }
  }

  const shutdown = async (signal, { exitDelayMs = 0 } = {}) => {
    if (closing) return
    closing = true
    log(`收到 ${signal}，开始收尾…`)
    const startedAt = Date.now()
    // 先摘掉自己的进程登记：之后即便收尾变慢，`--processes` 也不会把它算成"在跑"。
    // 强杀时这行不会执行 —— 那种情况由 classify() 的"PID 不存在"探活兜底。
    guard.release()
    let budgetTimer = null
    try {
      await Promise.race([
        shutdownSteps(),
        new Promise((resolve) => {
          budgetTimer = setTimeout(() => {
            log(
              `⚠️ 收尾超过 ${Math.round(SHUTDOWN_BUDGET_MS / 1000)} 秒预算，**强制退出**` +
                '（宁可少发一条在途回复，也不能留下一个退不掉的进程）',
            )
            resolve()
          }, SHUTDOWN_BUDGET_MS)
        }),
      ])
    } catch (error) {
      log(`⚠️ 收尾过程中出错（继续退出）：${error?.message ?? error}`)
    } finally {
      // 定时器必须清掉：pending 的 timer 会通过事件循环把退出拖住
      if (budgetTimer) clearTimeout(budgetTimer)
    }
    log(
      `=== 桥接退出（收到 ${bridge.stats.received} 条私聊，回复 ${bridge.stats.answered} 条，` +
        `收尾耗时 ${Date.now() - startedAt}ms）===`,
    )
    // exitDelayMs 是给"先响应 HTTP 再退出"那条路用的：立刻 process.exit 有可能
    // 抢在响应写完之前，UI 就会看到连接被重置而不是"已重启"。
    if (exitDelayMs > 0) setTimeout(() => process.exit(0), exitDelayMs)
    else process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', (error) => {
    log(`❌ 未捕获异常：${error?.stack ?? error}`)
    // ★ 记完日志就收尾退出，**不要继续带着损坏的状态跑**。
    //   原来的实现只 log 不退出 —— 那正是"卡住但没死"的典型来源：
    //   进程还在，但半边状态已经丢/错，外部也看不出它坏了。
    //   退出后由 start.bat / 用户重新拉起，比带病运行安全得多。
    log('   → 未捕获异常后进程状态不可信，主动收尾退出（请重新启动）')
    void shutdown('uncaughtException', { exitDelayMs: 200 })
  })
  process.on('unhandledRejection', (error) => {
    // Promise 拒绝的处理同 uncaughtException：记日志 + 收尾退出。
    // 这里刻意与上面保持一致的策略，避免"一半情况会退出、一半不会"这种难查的差异。
    log(`❌ 未处理的 Promise 拒绝：${error?.stack ?? error}`)
    log('   → 未处理拒绝说明有失败路径没被接住，进程状态不可信，主动收尾退出')
    void shutdown('unhandledRejection', { exitDelayMs: 200 })
  })

  // ── 启动时把**凭据来源**说清楚（H8）────────────────────────────────────
  //
  // 为什么值得多读两个小 JSON：token 是"存在两处必然漂移"的东西，
  // 而漂移的症状是**令牌被拒 + 机器人完全不说话** —— 启动时不说，
  // 等到用户抱怨"它怎么不理我"时才查，代价大得多。
  // ★ 只说来源与原因，**绝不打印 token 本身**。
  try {
    const tokens = resolveOnebotTokens({
      config,
      installDir: config.snowluma?.installDir || undefined,
    })
    if (tokens.warn) log(`⚠️ ${tokens.warn}`)
    if (tokens.why) log(`[凭据] 没有采用 SnowLuma 自己的配置：${tokens.why}`)
    if (tokens.differsFromConfig) {
      log(
        `⚠️ config.json 里的 token 与 SnowLuma 自己的配置不一致，实际用的是【${tokens.source}】那一组` +
          `（挑中的账号文件：${tokens.picked}）。`,
      )
    } else if (tokens.source === 'SnowLuma 自己的配置') {
      // ★ 一行"一切正常"的正面证据。为什么值得占一行日志：
      //   "现在到底用的是哪一组 token"过去要**两次事故**才查得出来，
      //   而启动时一行就能回答（仍然只报来源与账号，**不含 token 本身**）。
      log(
        `[凭据] 来源：SnowLuma 自己的配置（${tokens.picked}${tokens.accounts?.length > 1 ? `，共 ${tokens.accounts.length} 个账号` : ''}；与 config.json 一致）`,
      )
    } else {
      log(`[凭据] 来源：config.json（没有读到 SnowLuma 自己的配置）`)
    }
  } catch (error) {
    log(`[凭据] 启动自检失败（不影响运行）：${error?.message ?? error}`)
  }

  log('桥接已启动，等待消息…（Ctrl+C 退出）')
}

main().catch((error) => {
  console.error('启动失败：', error)
  process.exit(1)
})
