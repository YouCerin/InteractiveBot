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
import { join, relative, extname, sep } from 'node:path'

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
  'mcp/mcp-qq-server.mjs',
  'config-ui/dist/index.html',
  'vendor/node/node.exe',
  'vendor/node_modules/ws/index.js',
]
for (const f of MUST_EXIST) {
  if (!files.some((p) => rel(p) === f)) problems.push(`缺少必需文件：${f}`)
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
