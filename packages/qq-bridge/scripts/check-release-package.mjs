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
import { join, relative, extname } from 'node:path'

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
const MUST_EXIST = [
  '启动机器人.bat',
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

// ── ② 结构：不该有的绝不能有 ───────────────────────────────────────────
// ★ 注意 `vendor/node_modules/ws` 是**必须带**的（包内自带的纯 JS 依赖）——
//   第一版规则写成 /(^|\/)node_modules\// 把它一起判成了违规（验收脚本自己误报）。
//   这里用负向断言精确放行那一个包，其余 node_modules 一律禁止。
const FORBIDDEN = [
  ['node_modules（只允许 vendor/node_modules/ws）', /(^|\/)node_modules\/(?!ws\/)/],
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
