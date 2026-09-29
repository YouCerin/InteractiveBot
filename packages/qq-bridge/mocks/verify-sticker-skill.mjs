/**
 * 技能「表情包」（`skills/sticker`）的**可加载性与可搬运性**测试。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要这组断言（它挡的是"看着都在、其实装不上"）
 * ══════════════════════════════════════════════════════════════════════════
 * 表情包这个特性有两层：**技能目录**（清单 + 说明）与**宿主引擎**（`src/sticker-*.mjs`）。
 * 引擎那边有 347 条断言（另外几套），但**技能这一层此前一条断言都没有** ——
 * `verify-extensions.mjs` / `verify-mcp-skills.mjs` 里根本搜不到 `sticker`。
 * 于是这一层的问题只能靠人肉发现，而它的问题形状恰好都是"不报错、但装不上/搬不走"：
 *
 *   ① **清单被宿主拒绝** —— `apiVersion` 必须是宿主常量、`entry` 必须是目录内
 *      `.js/.mjs` 且真实存在。拒了以后技能是"静默不加载"，界面上看不出所以然。
 *   ② **文档承诺 ≠ 目录实体** —— `index.js` 与 `README.md` 都写着"本目录（可整目录
 *      拷走）"包含"离线导入/打标签脚本"，而目录里实际只有三个文件，脚本在宿主 `src/`。
 *      接手的人按文档拷走这个目录，会得到一个**没有脚本的技能**。
 *   ③ **两处默认值漂移** —— `skill.json:settings` 是给扩展系统/界面用的，
 *      `config.mjs:normalizeStickerSkill` 是桥接主进程真正读的。两处不一致时，
 *      **界面上显示的默认值与运行时用的值会各说各话**（本项目踩过：见 `config.mjs`
 *      里 `_note_switch` 那条注释）。
 *   ④ **技能偷偷依赖第三方包** —— 技能契约是"能整目录搬走"，一旦 import 了
 *      `ws` 之类的东西，搬走就会 `ERR_MODULE_NOT_FOUND`，而且只在别人机器上才出现。
 *      （本技能现在**一个都没有**，这条断言就是防止以后有人顺手加。）
 *   ⑤ **发布组装漏掉它** —— `assemble-release.mjs` 的拷贝清单是**手写**的，
 *      漏一项不会报错，只会让包里的这个技能消失。
 *
 * ★ 为什么用真实目录而不是临时造一个：这一层要验的正是"**当前这份**能不能被加载"，
 *   造个夹具就等于把被测对象换掉了。所以这里读真实 `skills/sticker/`，
 *   并且**不写任何文件**（纯只读断言）。
 *
 * 用法：node mocks/verify-sticker-skill.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SKILL_API_VERSION, discoverSkills, mergeSkillSettings, validateSkillManifest } from '../src/extensions.mjs'
import { normalizeConfig } from '../src/config.mjs'
import { STICKER_LABELS } from '../src/sticker-labels.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const SKILLS_DIR = join(PKG_ROOT, 'skills')
const SKILL_DIR = join(SKILLS_DIR, 'sticker')

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

/** 去掉注释再查字符串 —— 注释里提到某个词不算"代码里用了它"（本项目踩过假绿）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// ══════════════════════════════════════════════════════════════════════════
section('① 目录实体：技能必须是一份真实存在、非空的最小集')
// ══════════════════════════════════════════════════════════════════════════
check('技能目录存在', existsSync(SKILL_DIR), SKILL_DIR)
const files = existsSync(SKILL_DIR)
  ? readdirSync(SKILL_DIR, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name).sort()
  : []
check('目录里有 skill.json 与入口文件', files.includes('skill.json') && files.includes('index.js'), files.join(', '))
check('★ 有一份给人看的说明（README.md）', files.includes('README.md'))
check('★ 目录里没有 node_modules（技能不靠私有依赖）', !existsSync(join(SKILL_DIR, 'node_modules')))
for (const f of ['skill.json', 'index.js', 'README.md']) {
  const p = join(SKILL_DIR, f)
  if (!existsSync(p)) continue
  const size = statSync(p).size
  check(`★ ${f} 不是空文件`, size > 200, `${size} 字节`)
}

// ══════════════════════════════════════════════════════════════════════════
section('② 宿主真的能发现并加载它（用宿主自己的校验函数，不是眼看）')
// ══════════════════════════════════════════════════════════════════════════
const found = discoverSkills({ skillsDir: SKILLS_DIR })
check('skills/ 目录可被发现', found.exists, found.dir)
const skill = found.skills.find((s) => (s.id ?? s.manifest?.id) === 'sticker')
check('★★ 发现结果里有「表情包」这个技能', Boolean(skill))
if (skill) {
  check('清单解析成功（没有 parseError）', !skill.parseError, String(skill.parseError ?? ''))
  const v = validateSkillManifest(skill.manifest, { dir: skill.dir })
  check('★★★ validateSkillManifest **零 error**（有 error 宿主会拒绝加载）',
    (v.errors ?? []).length === 0, JSON.stringify(v.errors ?? []))
  check('★ 声明的 apiVersion 等于宿主常量（不一致会被拒）',
    Number(skill.manifest.apiVersion) === SKILL_API_VERSION, `清单 ${skill.manifest.apiVersion} / 宿主 ${SKILL_API_VERSION}`)
  check('★ 入口文件真能读到（校验函数是按 resolve(dir, entry) 找的）',
    Boolean(skill.entry) && existsSync(skill.entry), String(skill.entry))
  check('★ entry 指向 .js/.mjs（宿主用 ESM 动态 import 加载）', /\.(m?js)$/i.test(String(skill.manifest.entry)))
  // ★ 0.2.7 修正：这里原来是 `session === 'required'`，理由是"它要知道当前会话才能发对图"。
  //   那个理由**不成立** —— session 只有两处效果：① 往**工具入参**注入并必填 kind/peerId；
  //   ② 提示词片段非空时追加一句 kind/peerId 说明。本技能既没有工具、也不贡献片段，
  //   两处都不成立。群聊/私聊的判定确实存在，但它在**宿主**侧（`#decideSticker` 拿得到 kind）。
  //   断言跟着改成 none，并留住这条注释 —— 防止有人凭"required 看起来更安全"改回去。
  check('★ session = none（没有工具也不贡献片段时，required 是一句永远无法生效的承诺）',
    String(skill.manifest.session) === 'none', String(skill.manifest.session))

  // 入口必须导出：宿主按契约调用，缺一个就是"装了但不工作"
  const entrySrc = readFileSync(skill.entry, 'utf8')
  for (const fn of ['setup', 'available']) {
    check(`★ 入口导出 ${fn}()`, new RegExp(`export\\s+function\\s+${fn}\\b`).test(entrySrc))
  }
  // ★★ 0.2.7：prompt.source 必须与入口实现**互相印证**。
  //   这里选 `none`：那几行（"可以写 [sticker:标签]"）要按当前库现算，技能侧读不到库，
  //   所以由宿主算（`bridge.mjs` 的 `#stickerPromptBits()`）。
  check('★ 清单声明 prompt.source = none（本技能不贡献提示词片段）',
    String(skill.manifest.prompt?.source ?? 'runtime') === 'none',
    String(skill.manifest.prompt?.source))
  check('★★ 入口不再导出死代码 promptSections()（宿主调用时不传 ctx，它恒返回 []）',
    !new RegExp('export\\s+function\\s+promptSections\\b').test(entrySrc),
    'promptSections 应当已删除；那几行由宿主现算')
  check('★★ 入口不再依赖 context.stickerLines（那个输入永远不会被传进来）',
    !/stickerLines/.test(stripComments(entrySrc)), '')
  check('★★ 入口 import 了它就是违反契约（技能不许 import 宿主内部模块）',
    !/from\s+['"][^'"]*src\/[^'"]*['"]/.test(stripComments(entrySrc)),
    '技能目录要能整目录搬走，不能反向依赖宿主源码')
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 零第三方依赖：搬走不会 ERR_MODULE_NOT_FOUND')
// ══════════════════════════════════════════════════════════════════════════
// 扫全部表情包运行期文件（技能目录 + 宿主引擎 + 独立标注台）。
const pkgFiles = [
  ...readdirSync(join(PKG_ROOT, 'src')).filter((f) => f.startsWith('sticker-')).map((f) => join(PKG_ROOT, 'src', f)),
  ...files.map((f) => join(SKILL_DIR, f)),
  ...(() => {
    const out = []
    const walk = (d) => {
      if (!existsSync(d)) return
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const q = join(d, e.name)
        if (e.isDirectory()) walk(q)
        else if (/\.(m?js)$/i.test(e.name)) out.push(q)
      }
    }
    walk(join(PKG_ROOT, 'sticker-label'))
    return out
  })(),
]
const imports = new Set()
for (const f of pkgFiles) {
  if (!/\.(m?js)$/i.test(f)) continue
  const src = stripComments(readFileSync(f, 'utf8'))
  for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) imports.add(m[1])
}
const nodeBuiltins = [...imports].filter((s) => s.startsWith('node:'))
const relativeImports = [...imports].filter((s) => s.startsWith('.'))
const bareImports = [...imports].filter((s) => !s.startsWith('node:') && !s.startsWith('.'))
check('★★★ 没有任何裸包名 import（第三方依赖）', bareImports.length === 0, bareImports.join(', ') || '（一个都没有）')
check('★ 只依赖 node: 内置模块与相对路径', nodeBuiltins.length > 0 && relativeImports.length > 0,
  `${nodeBuiltins.length} 个 node: / ${relativeImports.length} 个相对路径`)
// 相对路径必须真的存在（少一个文件就是"搬走以后才炸"）
const brokenRelative = []
for (const f of pkgFiles) {
  if (!/\.(m?js)$/i.test(f)) continue
  const src = stripComments(readFileSync(f, 'utf8'))
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(f), m[1])
    if (!existsSync(target)) brokenRelative.push(`${relative(PKG_ROOT, f)} → ${m[1]}`)
  }
}
check('★★ 所有相对 import 都能解析到真实文件', brokenRelative.length === 0, brokenRelative.join('; '))

// ══════════════════════════════════════════════════════════════════════════
section('④ 两处默认值不许漂移（界面显示的 = 运行时用的）')
// ══════════════════════════════════════════════════════════════════════════
const manifest = JSON.parse(readFileSync(join(SKILL_DIR, 'skill.json'), 'utf8'))
const hostDefaults = normalizeConfig({}).skills.sticker
const declared = manifest.settings ?? {}
check('★ 清单 settings 的每个键都在宿主默认值里（没有"只写在清单里"的键）',
  Object.keys(declared).every((k) => k in hostDefaults),
  Object.keys(declared).filter((k) => !(k in hostDefaults)).join(', ') || '（无多余键）')
check('★ 宿主默认值的每个键都在清单里（没有"界面看不见"的键）',
  Object.keys(hostDefaults).every((k) => k in declared),
  Object.keys(hostDefaults).filter((k) => !(k in declared)).join(', ') || '（无缺失键）')
for (const [k, v] of Object.entries(hostDefaults)) {
  check(`★★ 默认值一致：${k}`, declared[k] === v, `清单 ${JSON.stringify(declared[k])} / 宿主 ${JSON.stringify(v)}`)
}
check('★★★ 安全闸门 allowRisky 默认必须是 false（开着等于允许发脏话/擦边图）',
  hostDefaults.allowRisky === false && declared.allowRisky === false)
check('★★ 清单里的每个设置项都要有 configSchema（否则界面上没有说明/类型）',
  Object.keys(declared).every((k) => manifest.configSchema?.[k]),
  Object.keys(declared).filter((k) => !manifest.configSchema?.[k]).join(', ') || '（都有）')
check('★ 每个 configSchema 项都带 description（界面上要给人解释）',
  Object.entries(manifest.configSchema ?? {}).every(([, s]) => String(s?.description ?? '').trim().length > 0))

// 合并行为：config 覆盖清单默认值、越界值被夹住
const merged = mergeSkillSettings(manifest, { frequency: 'high', maxSendBytes: 999999999999 })
check('★★ config 的显式值覆盖清单默认值', merged.settings.frequency === 'high', merged.settings.frequency)
check('★★ 越界值被 configSchema 的 max 夹住（不静默接受超限）',
  merged.settings.maxSendBytes === manifest.configSchema.maxSendBytes.max, String(merged.settings.maxSendBytes))
const mergedBad = mergeSkillSettings(manifest, { frequency: '乱写' })
check('★★ 非法枚举值退回默认并**告警**（不静默采信）',
  mergedBad.settings.frequency === 'medium' && mergedBad.warnings.length > 0,
  `${mergedBad.settings.frequency} / ${JSON.stringify(mergedBad.warnings)}`)

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 词表口径：清单里的说法要与实际标签数一致')
// ══════════════════════════════════════════════════════════════════════════
const readmePath = join(SKILL_DIR, 'README.md')
const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : ''
check('★★ README 里写的标签数与出厂表一致',
  readme.includes(`${STICKER_LABELS.length} 个`) || readme.includes(`（${STICKER_LABELS.length} 个`),
  `出厂表 ${STICKER_LABELS.length} 个`)
// 目录名口径：代码算出来的是 group-<号> 而不是 chat-<号>（发布说明里第 4 条 bug 的残留口径）
check('★★ skill.json 的 libraryDir 描述用的是 group- 口径（不是 chat-）',
  !/chat-/.test(String(manifest.configSchema?.libraryDir?.description ?? '')),
  String(manifest.configSchema?.libraryDir?.description ?? '').slice(0, 60))

// ══════════════════════════════════════════════════════════════════════════
section('⑥ 文档承诺必须与目录实体一致（否则接手的人按文档做会缺件）')
// ══════════════════════════════════════════════════════════════════════════
// 这两处曾经写着"本目录含离线导入/打标签脚本"，而脚本其实在宿主 src/。
// 断言不许再出现那种说法：脚本名一旦出现在"本目录"语境里，必须同时指明在 src/。
const entrySrcRaw = readFileSync(join(SKILL_DIR, 'index.js'), 'utf8')
const claimRe = /本目录[^\n]{0,80}(离线|脚本)/
check('★★★ index.js 不再声称"脚本在本目录"',
  !claimRe.test(stripComments(entrySrcRaw)) || /src\//.test(entrySrcRaw),
  '要么删掉那种说法，要么写清脚本在宿主 src/')
const scriptNames = ['sticker-tag.mjs', 'sticker-import.mjs']
for (const s of scriptNames) {
  if (!entrySrcRaw.includes(s)) continue
  check(`★★ index.js 提到 ${s} 时必须同时写明它在 src/（避免"可整目录拷走"的误导）`,
    new RegExp(`src/${s.replace('.', '\\.')}`).test(entrySrcRaw))
}
// README 讲脚本时用的路径要是宿主的
check('★★ README 里打标签命令指向宿主 src/sticker-tag.mjs',
  readme.includes('node src/sticker-tag.mjs'))
check('★ README 里导入命令指向宿主 src/index.mjs --stickers --import',
  /node src\/index\.mjs --stickers --import/.test(readme))

// ══════════════════════════════════════════════════════════════════════════
section('⑦ 发布组装必须带上这个技能（手写清单最容易漏的就是它）')
// ══════════════════════════════════════════════════════════════════════════
const asmPath = join(PKG_ROOT, 'scripts', 'assemble-release.mjs')
if (existsSync(asmPath)) {
  const asm = readFileSync(asmPath, 'utf8')
  check('★★★ 组装清单里包含 skills（否则表情包技能不进发布包）',
    /COPY_DIRS\s*=\s*\[[^\]]*'skills'/.test(asm), '')
  check('★★ 组装时排除 skills/node_modules（软链不该进包）',
    /skills[\s\S]{0,200}node_modules/.test(asm))
  check('★ 组装清单里包含 sticker-label（独立标注台要随包走）',
    /COPY_DIRS\s*=\s*\[[^\]]*'sticker-label'/.test(asm))
} else {
  check('★★ 发布组装脚本存在', false, asmPath)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑧ 未入库文件守卫：这个特性的文件必须都在 git 里（否则一次 clean 就没了）')
// ══════════════════════════════════════════════════════════════════════════
// ★ 这条只在能读到 .git 时才有意义（发布包里没有 .git），所以是"跳过而不是失败"。
//   实测背景：表情包 22 个文件里曾有 21 个 `git ls-files` 查不到 —— 只在工作树里，
//   `git clean -fd` 一次就永久消失（无历史可恢复）。
const gitDir = join(PKG_ROOT, '..', '..', '.git')
if (existsSync(gitDir)) {
  const { spawnSync } = await import('node:child_process')
  const tracked = (rel) => {
    const r = spawnSync('git', ['ls-files', '--error-unmatch', rel], { cwd: PKG_ROOT, stdio: 'ignore' })
    // exit 0 = 已跟踪；非 0 = 未跟踪。⚠️ 本项目沙箱里 git 子进程可能起不来（EPERM），
    //   那种情况下 spawnSync 会带 error —— 当成"查不出来"而不是"未入库"。
    if (r.error) return null
    return r.status === 0
  }
  const probe = tracked('package.json')
  if (probe === null) {
    console.log('ℹ️  跳过未入库守卫：本沙箱里起不了 git 子进程（EPERM）')
  } else {
    const mustTrack = [
      'skills/sticker/skill.json',
      'skills/sticker/index.js',
      'skills/sticker/README.md',
      'src/sticker-labels.mjs',
      'src/sticker-library.mjs',
      'src/sticker-decision.mjs',
      'src/sticker-quota.mjs',
      'src/sticker-vocab.mjs',
      'src/sticker-tagging.mjs',
      'src/sticker-tag.mjs',
      'src/sticker-import.mjs',
      'src/sticker-label-server.mjs',
    ]
    const untracked = mustTrack.filter((r) => tracked(r) === false)
    check('★★★ 表情包的核心文件都已在 git 里（未入库 = 随时可能永久丢失）',
      untracked.length === 0, untracked.join(', ') || '（全部已跟踪）')
  }
} else {
  console.log('ℹ️  跳过未入库守卫：当前不是 git 工作树（发布包里本来就没有 .git）')
}

console.log(`\n通过 ${passed} / 失败 ${failed}`)
process.exit(failed ? 1 : 0)
