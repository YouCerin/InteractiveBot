/**
 * 路径解析器：让整个包**换个位置也能跑**。
 *
 * ── 为什么单独搞一个文件 ───────────────────────────────────────────────
 * "打包后直接可用"这件事，成败全在**路径怎么算**。规则只有一条：
 *
 *     所有路径都从「这个文件自己的位置」往上推，绝不写死盘符。
 *
 * 用 `import.meta.url` 而不是 `process.cwd()` 是有血泪教训的：双击
 * 快捷方式启动时，Windows 给的"起始位置"往往是另一处（比如 C:\Windows\
 * System32），用 cwd 会解析到不存在的目录 —— 而且**不报错**，只是插件
 * 一个都加载不到（同类项目的 plugin-loader 注释里专门记了这个坑）。
 *
 * ── 目录约定 ───────────────────────────────────────────────────────────
 *   packages/qq-bridge/          ← PKG_ROOT：本包根目录（可整体搬走）
 *   ├── start.bat                  入口（双击启动）
 *   ├── setup.mjs                  一次性准备：把外部工具拷进包里
 *   ├── config.json
 *   ├── logs/
 *   ├── vendor/                    本包自带的外部工具（相对路径找得到）
 *   │   ├── node/node.exe          自带 Node 运行时
 *   │   ├── dsh/                   DSH 本体（可选，体积大）
 *   │   ├── snowluma/              QQ 协议端
 *   │   └── node_modules/          纯 JS 依赖（例如 ws）
 *   ├── src/                       桥接代码
 *   ├── mocks/                     验证替身
 *   └── workspace-qq/              agent 的工作区＝权限沙箱的根
 */

import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 本包根目录（packages/qq-bridge）。 */
export const PKG_ROOT = resolve(HERE, '..')

/** 相对 PKG_ROOT 的默认子目录。 */
export const DIRS = {
  vendor: join(PKG_ROOT, 'vendor'),
  vendorNodeModules: join(PKG_ROOT, 'vendor', 'node_modules'),
  vendorNode: join(PKG_ROOT, 'vendor', 'node'),
  vendorDsh: join(PKG_ROOT, 'vendor', 'dsh'),
  vendorSnowluma: join(PKG_ROOT, 'vendor', 'snowluma'),
  src: join(PKG_ROOT, 'src'),
  mocks: join(PKG_ROOT, 'mocks'),
  logs: join(PKG_ROOT, 'logs'),
  // 外部技能目录（0.2.2）：`skills/<id>/skill.json`。放在**包根**下而不是工作区里 ——
  // 理由与其它目录一致：包搬走它跟着走；而且技能代码不该落进 agent 有写权限的沙箱。
  skills: join(PKG_ROOT, 'skills'),
  // 人设库（0.2.2）：`personas/<名字>.md`，一个文件一套人设，按需切换。
  // ★ 同样**不放工作区**：人设是会被拼进系统提示词的高优先级位置（H12 的注入面），
  //   放进工作区等于让 agent 有权限改自己的"人格设定"。
  personas: join(PKG_ROOT, 'personas'),
  /** agent 的工作区＝workspace-write 沙箱的根。 */
  defaultWorkspace: join(PKG_ROOT, 'workspace-qq'),
}

/**
 * 把配置里的一条路径解析成绝对路径。
 *
 * 规则：相对路径一律相对 **PKG_ROOT**（不是 cwd），这样无论从哪里启动
 * 结果都一样；绝对路径原样返回（留给高级用户显式指定）。
 */
export function resolveInPackage(value) {
  if (!value) return null
  return isAbsolute(value) ? resolve(value) : resolve(PKG_ROOT, value)
}

/**
 * 在若干候选位置里找第一个存在的。
 * 用于"包里带了就用包里的，没带就找系统里的"这种优雅降级。
 *
 * @param {string[]} candidates
 * @returns {string|null}
 */
export function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* 权限等异常直接跳过该候选 */
    }
  }
  return null
}

/**
 * 定位 Node 可执行文件。
 *
 * 优先级刻意如此：**包内自带的排第一**。因为"打包后直接能用"的前提是
 * 不依赖用户机器上装没装 Node。
 */
export function findNodeBinary() {
  return firstExisting([
    join(DIRS.vendorNode, 'node.exe'),
    join(DIRS.vendorNode, 'node'),
    // 兜底：用当前正在跑这个脚本的 node —— 它一定存在且可用
    process.execPath,
  ])
}

/**
 * DSH 安装根的**唯一**候选表（`findDshCli` / 带来源版 / doctor 都从这里取）。
 *
 * 为什么抽出来：这张表以前在三个地方各写一遍，于是"加一个候选位置"很容易只改
 * 其中一处，而症状是"某个入口能找到 DSH、另一个找不到"—— 这类不一致最难查。
 *
 * @param {object} [opts]
 * @param {string} [opts.envVar]        指定安装根的环境变量名
 * @param {string[]} [opts.searchPaths] 额外的安装根候选（已解析成绝对路径，来自 config.json）
 * @returns {{path: string, source: string}[]}
 */
function dshInstallRootCandidates({ envVar = 'DSH_DESKTOP_APP', searchPaths = [] } = {}) {
  const rel = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const fromEnv = process.env[envVar]
  const extras = (Array.isArray(searchPaths) ? searchPaths : [])
    .filter((p) => typeof p === 'string' && p.trim() !== '')
    .map((p) => ({ path: join(p, rel), source: 'config.json 的 dsh.searchPaths' }))

  return [
    { path: join(DIRS.vendorDsh, rel), source: 'vendor/dsh（包内自带）' },
    { path: fromEnv ? join(fromEnv, rel) : null, source: `环境变量 ${envVar}` },
    ...extras,
    {
      path: join('C:\\Program Files\\DeepSeekHarness\\resources\\app', rel),
      source: 'DSH 默认安装位置（Program Files）',
    },
    {
      path: join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeekHarness', 'resources', 'app', rel),
      source: 'DSH 默认安装位置（%LOCALAPPDATA%\\Programs）',
    },
  ].filter((c) => Boolean(c.path))
}

/**
 * 定位 DSH CLI 入口（bin.js）。
 *
 * ⚠️ 这里有一个必须说清的取舍：DSH 本体解压后约 **274.7 MB / 15069 个
 * 文件**，把它复制进包里会让包体暴涨，所以默认**不复制**，而是按候选
 * 顺序去找：
 *
 *   1. vendor/dsh/                    ← 你愿意复制时放这里（最可搬迁）
 *   2. DSH_DESKTOP_APP 环境变量        ← 显式指定安装根
 *   3. **用户配置的搜索路径**           ← config.json 的 `dsh.searchPaths`
 *   4. DSH 桌面版默认安装位置           ← 常见情况（Program Files / %LOCALAPPDATA%）
 *
 * ★ 这里**刻意不再写死任何机器专属的绝对路径**。以前有一行
 * `D:\DeepSeekHarness\DSH Desktop\resources\app` —— 那只是开发机上的位置，
 * 发布出去对任何人都无意义，还会在"没装 DSH"时把用户引到一个不存在的目录。
 * 需要指定非标准安装位置时走 ② 或 ③，别改代码。
 *
 * 想彻底自包含：把 DSH 安装根复制到 vendor/dsh/ 即可，无需改任何代码。
 *
 * @param {object} [opts] 见 {@link dshInstallRootCandidates}
 * @returns {string|null}
 */
export function findDshCli(opts = {}) {
  return firstExisting(dshInstallRootCandidates(opts).map((c) => c.path))
}

/**
 * 与 {@link findDshCli} 同一份候选表，但把**命中是哪一条**一并返回。
 *
 * 为什么要这个：`--check` / `--doctor` 要能说清"我是从哪儿找到 DSH 的"。
 * 只报一个路径、不报来源时，用户排查"为什么用的是那份旧的"只能靠猜。
 *
 * @param {object} [opts] 见 {@link dshInstallRootCandidates}
 * @returns {{cliPath: string, source: string}|null}
 */
export function findDshCliWithSource(opts = {}) {
  for (const c of dshInstallRootCandidates(opts)) {
    try {
      if (existsSync(c.path)) return { cliPath: c.path, source: c.source }
    } catch {
      /* 权限等异常直接跳过该候选 */
    }
  }
  return null
}

/**
 * DSH 的候选搜索路径（给 `--check` / `--doctor` 逐条报告用）。
 * @param {object} [opts] 见 {@link dshInstallRootCandidates}
 * @returns {{path: string, source: string}[]}
 */
export function describeDshCandidates(opts = {}) {
  return dshInstallRootCandidates(opts)
}

/**
 * 从 `config.json` 里读出一组**相对包根的路径列表**。
 *
 * 为什么需要它（一个真实的不一致）：启动路径走的是
 * `normalizeConfig()` → `findDshCli({ searchPaths })`，所以配置里的
 * `dsh.searchPaths` 是生效的；而 `setup.mjs --check` / `doctor` 这类
 * "只想报个状态"的地方如果直接调 `findDshCli()`，就会**漏掉配置里那条** ——
 * 于是体检说"没找到"、程序却跑得起来。同一个问题在两处给出不同答案，
 * 是最难查的一类不一致，所以这里提供一个统一的读取入口。
 *
 * 故意**不 import config.mjs**：那会让 local.mjs（路径层）反过来依赖配置层，
 * 而 config.mjs 已经 import 了本模块 —— 会成环。这里只做很小的原始读取，
 * 并容忍任何解析失败（配置坏了应当由 config 层报错，不是这里）。
 *
 * @param {string} key 形如 `dsh.searchPaths` / `snowluma.searchPaths`
 * @returns {string[]} 已解析成绝对路径（相对包根）的列表
 */
export function readSearchPathsFromConfig(key) {
  try {
    const raw = JSON.parse(readFileSync(join(PKG_ROOT, 'config.json'), 'utf8'))
    const value = key.split('.').reduce((cur, part) => (cur == null ? null : cur[part]), raw)
    if (!Array.isArray(value)) return []
    return value
      .filter((p) => typeof p === 'string' && p.trim() !== '')
      .map((p) => resolveInPackage(p))
  } catch {
    return []
  }
}

/**
 * 定位 SnowLuma（QQ 协议端）的**启动入口**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要"发现"，而不是写死一个绝对路径
 * ══════════════════════════════════════════════════════════════════════════
 * 实测发现的真实情况：本机有**两个不同的 SnowLuma 安装**，`index.mjs` 大小都
 * 不一样（工作区那个 7447748 字节，参考项目里那个 7165599 字节）。
 * 本项目早期把启动入口硬指到**工作区外**的 `D:\QQagent_DeepSeek\snowluma`，
 * 而**实际在跑的是工作区里那一份** —— 于是"拉起"按钮启动的不会是你正在用的
 * 那个，甚至可能在同一端口上撞车。
 *
 * 所以改为就近发现 + 可配置。候选顺序（先到先得）：
 *
 *   ① `installDir`（配置项，相对 **PKG_ROOT**，默认 `vendor/snowluma`）
 *   ② `searchPaths`（配置项 `snowluma.searchPaths`，可填多个）
 *   ③ `vendor/snowluma/`            ← 放进包里时（连包一起搬走也能用）
 *   ④ 环境变量 `SNOWLUMA_HOME`       ← 显式指定
 *
 * **刻意不做磁盘遍历**：SnowLuma 是几百 MB 的东西，递归搜盘既慢又可能
 * 翻到不该动的地方。候选表是明确写死的，找不到就如实说找不到。
 *
 * ★ 这里**不再有"参考项目位置"那条兜底**。以前候选表最后一项写死
 * `D:\QQagent_DeepSeek\snowluma`（开发机上的另一份安装），后果不是"找不到"，
 * 而是**找到了错的那一份**并真的把它启动起来 —— 那一份用的是另一套 token，
 * 症状是"桥接一直 401、机器人完全不说话"，而命令行看起来完全正常。
 * 需要额外的位置就用 ② `snowluma.searchPaths` 明确写出来。
 *
 * ── 关于用哪个 Node 去跑它 ──────────────────────────────────────────────
 * 它自己的 `check-node-version.cjs` 要求 `^22.13.0 || >=23.4.0`。实测本机：
 * 系统 `v24.18.0`、包内 `v24.9.0` —— **两者都满足**，所以优先用包内 Node
 * （换台没装 Node 的机器也能跑）。
 *
 * @param {object} [opts]
 * @param {string} [opts.installDir]   已解析成绝对路径的显式安装目录
 * @param {string[]} [opts.searchPaths] 额外的安装目录候选（已解析成绝对路径，来自 config.json）
 * @returns {{cmd: string|null, cwd: string|null, kind: string|null, from: string|null}}
 */
export function findSnowluma({ installDir, searchPaths = [] } = {}) {
  const fromEnv = process.env.SNOWLUMA_HOME
  const extras = (Array.isArray(searchPaths) ? searchPaths : []).filter(
    (p) => typeof p === 'string' && p.trim() !== '',
  )

  /** @type {{dir: string, from: string}[]} */
  const dirs = [
    installDir ? { dir: installDir, from: 'snowluma.installDir' } : null,
    ...extras.map((dir) => ({ dir, from: 'config.json 的 snowluma.searchPaths' })),
    { dir: DIRS.vendorSnowluma, from: 'vendor/snowluma' },
    fromEnv ? { dir: resolve(fromEnv), from: '环境变量 SNOWLUMA_HOME' } : null,
  ].filter(Boolean)

  for (const { dir, from } of dirs) {
    // ★ 优先 `index.mjs`，**不是** `launcher.bat`。
    //
    // 改这个顺序的理由：现在 SnowLuma 的输出是**在界面里看**（读它的日志文件，
    // 见 src/snowluma-log.mjs），所以不需要那个带 `pause` 的控制台窗口了。
    // 而 `launcher.bat` 天生会开一个 cmd 窗口（它的最后一行就是 `pause`，
    // 目的正是留住那个窗口）—— 那正是使用者不想看到的东西。
    //
    // 用 `index.mjs` 时我们直接用包内 node 启动它，`stdio: 'ignore'` +
    // `windowsHide: true`，**完全不出窗口**。
    // （SnowLuma 是自包含发行包，没有 node_modules 是正常的。）
    const mjs = join(dir, 'index.mjs')
    if (existsSync(mjs)) return { cmd: mjs, cwd: dir, kind: 'mjs', from }
    const bat = join(dir, 'launcher.bat')
    if (existsSync(bat)) return { cmd: bat, cwd: dir, kind: 'bat', from }
  }

  return { cmd: null, cwd: null, kind: null, from: null }
}

/**
 * 解析 DSH_HOME（harness 根目录，`profiles/` 就在它下面）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ 这里踩过一个坑，写下来免得重犯。
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版想"从 dsh CLI 的路径反推"，用的是
 *   `…/node_modules/@deepseek-ai/` 之前的片段。
 * 结果得到的是 **DSH 的安装目录**（`D:\…\resources\app`），
 * 而不是用户数据目录 —— 于是把 profile 补丁写进了**程序安装目录**，
 * 在那儿凭空造出一个 `profiles/sdk/cordis.patch.yml`。
 *
 * 为什么反推不成立：DSH 可能是**全局安装**的，而 profile 存在**用户数据目录**；
 * 这两者之间没有任何路径关系。所以必须按**已知候选**去找，不能算。
 *
 * 候选顺序（先到先得）：
 *   ① 环境变量 `DSH_HOME`（DSH 自己用的就是它，最权威）
 *   ② Windows 桌面版默认位置 `%APPDATA%\dsh-desktop\harness`
 *   ③ 安装目录旁的 `harness`（非桌面安装形态的兜底）
 *
 * @param {object} [opts]
 * @param {string} [opts.cliPath] 用于推导第 ③ 个候选
 * @param {(p: string) => boolean} [opts.exists] 可注入的存在性判断（便于测试）
 * @returns {{home: string, source: string}|null}
 */
export function resolveDshHome({ cliPath, exists = existsSync } = {}) {
  const candidates = []

  if (process.env.DSH_HOME) candidates.push({ home: process.env.DSH_HOME, source: 'env:DSH_HOME' })

  if (process.env.APPDATA) {
    candidates.push({
      home: join(process.env.APPDATA, 'dsh-desktop', 'harness'),
      source: 'APPDATA\\dsh-desktop\\harness',
    })
  }

  // ③ 安装目录旁：只在前面都找不到时才用。
  // 注意这里仍然**不能**直接当 DSH_HOME —— 只把它当作"可能存在的 harness"。
  if (cliPath) {
    const appRoot = String(cliPath).replace(/\\/g, '/').split('/node_modules/@deepseek-ai/')[0]
    if (appRoot) {
      candidates.push({ home: join(appRoot, 'harness'), source: 'install-adjacent harness' })
    }
  }

  for (const c of candidates) {
    try {
      if (c.home && exists(c.home)) return { home: c.home, source: c.source }
    } catch {
      /* 探测失败就试下一个 */
    }
  }
  return null
}

/** 给人看的自检报告：包里有什么、缺什么。 */
export function describeLayout() {
  const rows = [
    ['自带 Node 运行时', join(DIRS.vendorNode, 'node.exe')],
    ['纯 JS 依赖 vendor/node_modules/ws', join(DIRS.vendorNodeModules, 'ws')],
    // ★ 这两样**发布包里不该有**：DSH 属于运行环境（体积 275MB，用户自己装），
    //   SnowLuma 的许可证不允许随第三方安装包分发。列在这里是为了让"我手工放进去了"
    //   这件事可见，而不是当成"缺件"。
    ['DSH 本体（不随包分发，仅本地自用时可放）', join(DIRS.vendorDsh, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')],
    ['QQ 协议端 SnowLuma（不随包分发，仅本地自用时可放）', join(DIRS.vendorSnowluma, 'index.mjs')],
  ]
  return rows.map(([label, path]) => ({ label, path, present: existsSync(path) }))
}
