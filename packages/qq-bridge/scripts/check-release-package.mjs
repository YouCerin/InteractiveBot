/**
 * 发布包验收：对 staging 目录做一次"能不能发出去"的静态检查。
 *
 * 只读脚本，放在工作区内（发布包不放它）。用法：
 *   node .dsh-release-check.mjs <staging 目录>
 *
 * 为什么要有它：发布包出问题的方式几乎都不是"跑不起来"，而是**把不该带的东西带出去了**。
 * 那种错误不会报错、不会崩，只会安静地泄露 —— 所以必须逐项查。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative, extname, sep, resolve } from 'node:path'
import { createRequire } from 'node:module'

const root = process.argv[2]
if (!root) {
  console.error('用法：node .dsh-release-check.mjs <staging 目录>')
  process.exit(2)
}

const problems = []
const warnings = []
const notes = []

/** 递归收集文件（跳过 .git）。 */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

const files = walk(root)
const rel = (p) => relative(root, p).replace(/\\/g, '/')

// ── ① 结构：该有的必须都在 ─────────────────────────────────────────────
// ★ 0.2.5：四个中文名引导入口（启动机器人.bat / 检查配置.bat / 体检.bat /
//   创建带图标的快捷方式.bat）与 `先读我-首次使用.txt` 已按用户要求删除，
//   发布包只剩 `start.bat` 一个入口。**不要把删掉的名字加回这个清单** ——
//   加回来等于要求发布包里存在一份源码里已经没有的文件，组装第③步会直接拒绝组装，
//   而"把它重新造出来"正是这次清理要避免的事。
const MUST_EXIST = [
  'start.bat',
  'config.json',
  'config.example.json',
  'prices.json',
  'src/index.mjs',
  'src/local.mjs',
  // ★ 0.2.5：它不是"构建脚本"，是 `src/ui-status.mjs` 在**运行期** require 的那份哈希实现。
  //   缺了它，包里的桥接**启动即死**（MODULE_NOT_FOUND）；而这条缺陷从 0.2.0 起就在包里
  //   （那时的包同样有 `src/ui-status.mjs`、同样没有 `scripts/`），只是没人从包里跑过桥接。
  'scripts/ui-build-stamp.cjs',
  'mcp/mcp-qq-server.mjs',
  'config-ui/dist/index.html',
  'vendor/node/node.exe',
  'vendor/node_modules/ws/index.js',
  // ★ 0.2.5 桌面壳：入口就是这个 exe。它**不是可选项** —— 缺了它，"UI 装进独立窗口"
  //   与"打包为 .exe"两条目标就不成立，而包**看起来仍然能跑**（start.bat 会退回浏览器
  //   那条路）⇒ 属于"静默不成立"，所以在这里当硬项查。
  'app/InteractBot.exe',
  'app/PROVENANCE.txt',
]
for (const f of MUST_EXIST) {
  if (!files.some((p) => rel(p) === f)) problems.push(`缺少必需文件：${f}`)
}

// ── ①-a ★ 桌面壳（0.2.5）：壳代码必须是**明文**，而且只有一份 ─────────────
{
  const exe = 'app/InteractBot.exe'
  if (files.some((p) => rel(p) === exe)) {
    const mb = (statSync(join(root, exe.replace(/\//g, sep))).size / 1024 / 1024).toFixed(1)
    notes.push(`桌面壳：${exe}（${mb} MB，Electron 运行时自带，免安装）`)
    // ★ 壳代码必须是**明文可读**的，而不是打进 app.asar。
    //   实测踩过：`asar: false` 写在 `win:` 下面会被 electron-builder **静默忽略** ——
    //   构建成功、exe 也出来了，只是 app 变成了 `resources/app.asar`，**只有验收能发现**。
    for (const f of [
      'app/resources/app/main.cjs',
      'app/resources/app/preload.cjs',
      'app/resources/app/lib.cjs',
      'app/resources/app/splash.html',
    ]) {
      if (!files.some((p) => rel(p) === f)) {
        problems.push(
          `桌面壳的 ${f.replace('app/resources/app/', '')} 不在（是不是被打进了 asar？）\n` +
            '      （desktop/electron-builder.yml 的 `asar: false` 必须在**顶层**，放进 win: 里会被忽略）',
        )
      }
    }
    // ★ 壳的源码**只有一份**：包根不该再平铺 main.cjs / preload.cjs / splash.html
    //   （那意味着有人手工拷过一份，两份必然分叉 —— 与"UI 只有一个真相"同一个道理）
    for (const stray of ['main.cjs', 'preload.cjs', 'splash.html']) {
      if (files.some((p) => rel(p) === stray)) {
        problems.push(`包根出现了 ${stray} —— 桌面壳的代码只该在 app/resources/app/ 里`)
      }
    }

    // ── ★★ 用**包里那份** lib.cjs，在真实发布包路径上复核包根解析 ──────────
    //
    // 为什么必须在**包上**再做一次（而不是只信源码树里的离线测试）：
    //   0.2.4 已经发出去的那份 exe 就是这个解析错了 —— 它把 `app\` 当成了包根
    //   （真机日志：`包根 …\…-0.2.4-win-x64\app` + `读不到 config.json（ENOENT）—— 用默认端口`），
    //   而当时源码树里的离线断言全绿。所以"包里那份 lib.cjs 对不对"要**在包上**回答。
    //   `lib.cjs` 是纯逻辑、不 require electron ⇒ 这里用普通 Node 就能跑（不需要起窗口）。
    try {
      const req = createRequire(import.meta.url)
      const shippedLib = req(join(root, 'app', 'resources', 'app', 'lib.cjs'))
      const appResApp = join(root, 'app', 'resources', 'app')
      const got = shippedLib.resolvePkgRoot({ dirname: appResApp, env: {}, isPackaged: false })
      if (resolve(got) !== resolve(root)) {
        problems.push(
          `★ 包里的壳把包根解析成了「${got}」，而不是「${root}」\n` +
            '      ⇒ 双击 app/InteractBot.exe 会读不到使用者的 config.json（0.2.4 就是这样发的包）',
        )
      } else {
        notes.push('★ 用包里那份 lib.cjs 复核：包根解析到发布包根（不是 app\\）')
        // 顺手验一下它真能读到配置里的端口（0.2.4 的日志里这一句是"用默认端口"）
        const port = shippedLib.readUiPort({ configPath: join(root, 'config.json') })
        if (port.source !== 'config') {
          problems.push(`壳读不出 config.json 的 ui.apiPort（${port.why}）—— 包里的配置不是空白模板？`)
        } else {
          notes.push(`壳读到的端口来自 config.json：${port.port}`)
        }
      }
    } catch (error) {
      problems.push(`用包里的 lib.cjs 复核包根解析失败：${error?.message ?? error}`)
    }
  } else {
    problems.push(`缺少桌面壳：${exe}（重新打：npm run desktop:pack，再重跑 assemble-release）`)
  }
}

// ── ①-c ★ 包根只该有 start.bat 一个 .bat；0.2.5 删掉的旧入口不许回来 ──────
//
// ★ 为什么要"双向"白名单：既要挡住"多出一个 .bat"（有人手工拷一份"方便使用"），
//   也要挡住"少了一个"（组装漏拷）。0.2.4 实测踩过单向名单的坑：把源码侧的入口写进
//   名单，于是每次组装都失败。
{
  const ROOT_BATS = ['start.bat']
  const rootBats = files.map((p) => rel(p)).filter((r) => /\.(bat|cmd)$/i.test(r) && !r.includes('/'))
  for (const b of rootBats) {
    if (!ROOT_BATS.includes(b)) {
      problems.push(
        `包根不该有这个 .bat：${b}\n` +
          `      （0.2.5 起包根只留 ${ROOT_BATS.join(' / ')}；桌面入口是 app/InteractBot.exe。\n` +
          '       诊断类入口在 0.2.5 已按用户要求删除，不要放回来）',
      )
    }
  }
  for (const b of ROOT_BATS) {
    if (!rootBats.includes(b)) problems.push(`包根缺少入口：${b}`)
  }
  // ★ 0.2.5 的旧资产清理决定：这些名字**有意删掉**了（判据在 mocks/verify-legacy-assets.mjs）。
  //   它们出现在包里意味着"删除被撤销"，而那正是那条守卫反复警告的事。
  for (const gone of [
    '启动机器人.bat',
    '检查配置.bat',
    '体检.bat',
    '创建带图标的快捷方式.bat',
    '先读我-首次使用.txt',
    'backup-commands',
  ]) {
    if (files.some((p) => rel(p) === gone || rel(p).startsWith(`${gone}/`))) {
      problems.push(`包里出现了 0.2.5 已删除的旧资产：${gone}（它是有意删掉的，不要放回来）`)
    }
  }
  notes.push(`包根 .bat：${rootBats.join('、')}（桌面入口是 app/InteractBot.exe）`)
}

// ── ①-d ★★ 包里的 .bat/.cmd 两条硬规矩（0.2.5）────────────────────────────
//
// 0.2.4 的三次真事故全出在这里，而当时那条"必须纯 ASCII"的断言**一个文件都没扫过**
// （bc7d53b 的记录）。包里的 .bat 是使用者要**双击**的东西，坏了就是"双击没反应"，
// 所以这里逐条查、并且跟着包走（不依赖仓库里那份守卫跑没跑过）。
{
  for (const p of files) {
    const r = rel(p)
    if (!/\.(bat|cmd)$/i.test(r)) continue
    const buf = readFileSync(p)
    if (buf.some((b) => b > 0x7f)) {
      problems.push(`.bat/.cmd 不是纯 ASCII：${r}（cmd 按 GBK 解析，中文注释会吞换行、断掉启动链）`)
    }
    for (const [i, line] of buf.toString('utf8').split(/\r?\n/).entries()) {
      if (!/^\s*(rem\b|::)/i.test(line)) continue
      const hit = line.match(/[<>|&]/)
      if (hit) {
        problems.push(
          `.bat/.cmd 的注释里有重定向字符 ${hit[0]}：${r}:${i + 1}（会把某个文件截断成 0 字节）`,
        )
      }
    }
  }
}

// ── ①-e ★★ 运行期用 `join(PKG_ROOT, …)` 指到的**文件**必须在包里（0.2.5 补）──
//
// 为什么需要它：`src/ui-status.mjs` 在**运行期** require `scripts/ui-build-stamp.cjs`，
// 而拷贝清单从来只拷 `src/`、不拷 `scripts/`。后果不是"某个检查失效"，而是
// **包里的桥接一启动就死**（MODULE_NOT_FOUND）；又因为 `respawnBridge` 用的是
// `stdio:'ignore'`，连 `logs/bridge.log` 都不会生成 —— 用户只看到"窗口一直等"。
// 实测：`_release/InteractBot-0.2.0` 起每一份包都有这个缺陷，而**没有任何东西在查**。
//
// 判据：扫包内 `src/`、`mcp/` 的源码，取出 `join(PKG_ROOT, 'a', 'b'…)` 里**末段像文件名**
//   的那些，断言它真的在包里。运行期才会生成的东西显式放行 —— 白名单必须写理由，
//   否则它迟早变成"没人敢动、也没人知道为什么"的挡箭牌。
{
  const RUNTIME_MADE = new Set([
    'logs/bridge.log', // 桥接启动时自己建；它不在包里是正常的（启动最早期就可能失败）
    'logs/desktop.log', // 桌面壳自己的日志，同理
  ])
  const scanned = files.map((p) => rel(p)).filter((r) => /^(src|mcp)\/.*\.mjs$/.test(r))
  const missingRefs = []
  for (const r of scanned) {
    const text = readFileSync(join(root, r.replace(/\//g, sep)), 'utf8')
    for (const m of text.matchAll(/join\(PKG_ROOT,\s*((?:'[^']+'\s*,\s*)*'[^']+')\)/g)) {
      const parts = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
      if (parts.length < 2) continue // 只关心"目录 + 文件名"那种
      const last = parts[parts.length - 1]
      if (!/\.[a-z0-9]+$/i.test(last)) continue // 末段不是文件名 ⇒ 那是目录，跳过
      const target = parts.join('/')
      if (RUNTIME_MADE.has(target)) continue
      if (!files.some((p) => rel(p) === target)) missingRefs.push(`${target}（${r} 要用它）`)
    }
  }
  if (missingRefs.length) {
    problems.push(
      '包里缺了运行期要用的文件（源码里 join(PKG_ROOT, …) 指到的）：\n        · ' +
        missingRefs.join('\n        · ') +
        '\n      ⇒ 这不是"少个可选项"，是**桥接启动即死**。把它们加进 assemble-release 的拷贝清单。',
    )
  } else {
    notes.push(
      `运行期引用自检：${scanned.length} 个 src/mcp 文件里 join(PKG_ROOT, …) 指到的文件都在包里`,
    )
  }
}

// ── ①-b ★ 界面产物的**构建溯源标记**必须在 ──────────────────────────────
//
// 为什么单列这一条而不是塞进 MUST_EXIST：没有它的时候，"`dist/index.html` 在不在"
// 就够了 —— 而**恰恰是那种检查漏掉了一次真实脱钩**（包里源码与 UI 都比工作区旧
// 约 5 小时，1100 项测试全绿）。`ui-build.json` 里是构建时的源码哈希，
// 有了它才能回答"包里这份 UI 是不是当前源码构建的"。
//
// ⚠️ 这里**只验它在不在、能不能解析**。真正的"是否同步"要重算源码哈希，
//    那需要源码树 —— 所以那道判定在 `setup.mjs --release`（跑在工作区里）。
//    两份检查分工不同：这里管"包里有没有自证材料"，那里管"自证材料对不对"。
{
  const stampPath = 'config-ui/dist/ui-build.json'
  const has = files.some((p) => rel(p) === stampPath)
  if (!has) {
    problems.push(
      `缺少界面构建溯源标记：${stampPath} —— 这份 UI 无法自证来源（重新构建 config-ui 即可生成）`,
    )
  } else {
    try {
      const stamp = JSON.parse(readFileSync(join(root, stampPath.replace(/\//g, sep)), 'utf8'))
      for (const k of ['sourceHash', 'builtAt']) {
        if (!stamp[k]) problems.push(`${stampPath} 缺少字段 ${k}`)
      }
      notes.push(
        `界面构建溯源：sourceHash=${String(stamp.sourceHash ?? '').slice(0, 12)}… 构建于 ${stamp.builtAt ?? '?'}`,
      )
      // ★ 标记里**不许**出现机器专属路径：它会被打进分发包，而"哪个开发机
      //   构建的"属于不该带出去的信息（同 MACHINE 那一组的口径）。
      if (/[A-Za-z]:[\\/]/.test(JSON.stringify(stamp))) {
        problems.push(`${stampPath} 里出现了绝对路径（不该带机器专属信息）`)
      }
    } catch (error) {
      problems.push(`${stampPath} 不是合法 JSON：${error?.message ?? error}`)
    }
  }
}

// ── ② 结构：不该有的绝不能有 ───────────────────────────────────────────
// ★ 注意 `vendor/node_modules/ws` 是**必须带**的（包内自带的纯 JS 依赖）——
//   第一版规则写成 /(^|\/)node_modules\// 把它一起判成了违规（验收脚本自己误报）。
//   ★ 0.2.2 起放行名单多了 `undici`：它是**可选**依赖，只被"要挂代理的技能"用到
//     （pixiv 插件的代理支持要 ProxyAgent），由 setup.mjs 复制到 vendor/node_modules。
//   ★★ 但放行必须**精确到 path 前缀**：第一版写的是"名字在白名单里就放行"，
//     于是 `skills/node_modules/undici`（技能目录下的软链/依赖）也会被放行 ——
//     那条路径链的是**开发机的绝对路径**，进包就是死链。现在由下面那块单独判。
const VENDOR_PKG_ALLOW = /^vendor\/node_modules\/(ws|undici)\//
const FORBIDDEN = [
  ['config-ui 源码（只发 dist）', /^config-ui\/(?!dist\/)/],
  ['DSH 本体（用户自装）', /^vendor\/dsh\//],
  ['SnowLuma（许可证不允许随包分发）', /^vendor\/snowluma\//],
  ['运行日志', /^logs\//],
  ['MCP 缓存（含 token 明文）', /^cache\//],
  ['agent 工作区（含聊天痕迹）', /^workspace-qq\//],
  ['配置备份', /config\.json\.bak/],
  ['测试替身', /^mocks\//],
  ['测试残留', /\.tmp-/],
  // ★ 0.2.5：桌面壳**只发成品**（app/ 里那份）。源码侧与构建期产物进包会同时踩三个坑：
  //   体积（desktop/node_modules 约 72 MB）、机器专属路径（.npm-cache 里有 Electron zip）、
  //   以及"两个真相"（包里的 desktop/ 与 app/ 里的壳代码各说各话）。
  ['桌面壳源码（只发 app/ 里的成品）', /^desktop\//],
  ['Electron 构建缓存与中间产物', /(^|\/)\.npm-cache\//],
  ['桌面壳构建目录', /^\.build-desktop\//],
]
for (const p of files) {
  const r = rel(p)
  // node_modules：只允许 `vendor/node_modules/{ws,undici}` 这两条**精确路径**
  if (/(^|\/)node_modules(\/|$)/.test(r)) {
    if (!VENDOR_PKG_ALLOW.test(r)) {
      problems.push(`不该包含的东西：${r}（node_modules 只允许 vendor/node_modules/{ws,undici}）`)
    }
    continue
  }
  for (const [label, re] of FORBIDDEN) {
    if (re.test(r)) problems.push(`不该包含的东西：${r}（${label}）`)
  }
}

// ── ③ 内容：明文密钥与机器专属路径 ─────────────────────────────────────
// 只扫文本类文件；二进制（node.exe）跳过。
const TEXT_EXT = new Set(['.mjs', '.js', '.json', '.md', '.bat', '.txt', '.yml', '.yaml', '.ts', '.tsx', '.html', '.css', '.cjs'])
const SECRETS = [
  ['DeepSeek API key', /sk-[0-9a-f]{32}/],
  ['上一轮的 SnowLuma wsToken', /3TV2K4H/],
  ['上一轮的 SnowLuma httpToken', /IPZyan2m/],
]
const MACHINE = [
  ['开发机 DSH 路径', /D:\\DeepSeekHarness/],
  ['参考项目 SnowLuma 路径', /D:\\QQagent_DeepSeek/],
  ['开发机用户目录', /C:\\Users\\18007/],
]
for (const p of files) {
  const r = rel(p)
  if (!TEXT_EXT.has(extname(p).toLowerCase())) continue
  let text
  try {
    text = readFileSync(p, 'utf8')
  } catch {
    continue
  }
  for (const [label, re] of SECRETS) {
    if (re.test(text)) problems.push(`明文密钥：${r} 命中「${label}」`)
  }
  for (const [label, re] of MACHINE) {
    if (re.test(text)) {
      // 注释里提到"以前写死过这条路径"是**有意保留的说明**，不算问题，但要报出来供人工确认
      notes.push(`${r} 提到「${label}」（若在注释/历史记录里说明"曾经的错误做法"则属正常）`)
    }
  }
}

// ── ④ 运行痕迹：日志/数据库/截图等 ────────────────────────────────────
const RUNTIME_EXT = new Set(['.log', '.jsonl', '.db', '.db-wal', '.db-shm', '.png', '.jpg', '.jpeg', '.gif'])
for (const p of files) {
  const r = rel(p)
  if (RUNTIME_EXT.has(extname(p).toLowerCase())) warnings.push(`运行期/媒体文件：${r}`)
}

// ── ⑤ 体积 ─────────────────────────────────────────────────────────────
let bytes = 0
for (const p of files) bytes += statSync(p).size
const biggest = files
  .map((p) => ({ r: rel(p), mb: statSync(p).size / 1024 / 1024 }))
  .sort((a, b) => b.mb - a.mb)
  .slice(0, 5)

// ── 报告 ───────────────────────────────────────────────────────────────
console.log(`\n发布包验收：${root}`)
console.log(`  文件 ${files.length} 个，合计 ${(bytes / 1024 / 1024).toFixed(1)} MB`)
console.log('  最大的几个：')
for (const b of biggest) console.log(`    ${b.mb.toFixed(1)} MB  ${b.r}`)

console.log('\n  ❌ 问题：')
if (problems.length === 0) console.log('    （无）')
for (const p of problems) console.log(`    · ${p}`)

console.log('\n  ⚠️  需确认：')
if (warnings.length === 0) console.log('    （无）')
for (const w of warnings) console.log(`    · ${w}`)

if (notes.length) {
  console.log('\n  ℹ️  提到机器路径的文件（确认是注释/历史记录即可）：')
  for (const n of notes) console.log(`    · ${n}`)
}

console.log('')
process.exit(problems.length === 0 ? 0 : 1)
