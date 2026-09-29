#!/usr/bin/env node
/**
 * 扩展系统（技能 + 插件）的测试（0.2.2）。
 *
 * ── 这一套重点锁的是什么 ────────────────────────────────────────────────
 * 扩展系统的坏法**几乎全是静默的**：
 *   · 技能装上了、开关也开着，但工具名对不上 → 模型调一个不存在的工具，只会说"查不到"；
 *   · 设置项在界面上根本不出现 → 用户以为设了；
 *   · 关掉的技能还在提示词里留一句"用 XX 查" → 机器人开始胡说；
 *   · 开关按下去只改了内存 / 只改了盘 → 一边"已保存"一边照旧跑。
 * 所以这里**不测 happy path 的返回值**，测的是上面这几类**不会报错的错**：
 *   ① 清单校验的 errors/warnings 分界（错必须拦、隐患必须报）；
 *   ② 设置合并与**类型收敛**（`maxResults: "10"` 不许变成 NaN）；
 *   ③ **密文语义**（值不许出现在返回值里；空串=不改、null=清除）；
 *   ④ **命名**（工具全名只有一处拼装规则）；
 *   ⑤ 提示词片段（关掉的一个字都不出现、某个技能抛错只跳过它）；
 *   ⑥ 开关语义（技能即时生效 + 同时落盘；插件 hot/cold 如实标注）；
 *   ⑦ `qq_send_image` 的守卫（内网地址默认拒、开关打开才放行）。
 *
 * 用法：node mocks/verify-extensions.mjs
 *
 * ── 自检记录：这套断言**有牙**（靠"故意弄坏"验过，2026-09-26）────────────────
 * 一处一处把 src/extensions.mjs 弄坏，确认它真的会红：
 *   · 工具全名退回上游命名（`pixiv-lookup__search`）→ **4 项失败**；
 *   · 去掉"关掉的技能不产出片段"那道闸 → 1 项失败；
 *   · 把空值当成 0（就是下面 ③ 抓到并修掉的那个缺陷）→ 1 项失败；
 *   · 脱敏改成"置空"而不是"删除" → 1 项失败。
 * 为什么值得记这一笔：断言最容易的坏法是**永远通过**（判据本身写错、或者根本
 * 没断言到那件事），而那种坏法在"全绿"里看不出来。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  SKILL_API_VERSION,
  SKILLS_SERVER_NAME,
  HOST_TOOLS,
  skillToolFullName,
  skillToolLocalName,
  validateSkillManifest,
  discoverSkills,
  mergeSkillSettings,
  mergeSkillSettingsPatch,
  redactSkillSettings,
  isSkillEnabled,
  skillStatus,
  loadSkill,
  collectSkillPromptSections,
  describeSkill,
  callSkillDiagnose,
} from '../src/extensions.mjs'
import { BUILTIN_PLUGINS, listPlugins, pluginById, pluginSwitchKind, isPluginOn } from '../src/plugins.mjs'
import { createExtensionService } from '../src/extensions-service.mjs'
import { normalizeConfig, validateConfig } from '../src/config.mjs'
import { createApiHandler } from '../src/api.mjs'
import { runSendImage, TOOLS, described, __setConfig } from '../mcp/mcp-qq-server.mjs'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

const ROOT = mkdtempSync(join(tmpdir(), `qq-bridge-ext-${process.pid}-`))
const SKILLS_DIR = join(ROOT, 'skills')
mkdirSync(SKILLS_DIR, { recursive: true })

/** 造一个技能目录（清单 + 入口）。返回它的目录。 */
function makeSkill(id, { manifest = {}, entry = '' } = {}) {
  const dir = join(SKILLS_DIR, id)
  mkdirSync(dir, { recursive: true })
  const body = {
    id,
    name: `${id} 演示`,
    version: '1.0.0',
    apiVersion: SKILL_API_VERSION,
    description: '测试用技能',
    entry: 'index.js',
    enabledByDefault: false,
    settings: { enabled: false, count: 3, mode: 'a', token: '' },
    configSchema: {
      enabled: { type: 'boolean', label: '启用' },
      count: { type: 'number', label: '条数', min: 1, max: 10 },
      mode: { type: 'enum', label: '模式', values: ['a', 'b'] },
      token: { type: 'string', label: '令牌', secret: true },
    },
    tools: [{ id: 'ping', name: 'Ping', description: '回一个 pong' }],
    ...manifest,
  }
  writeFileSync(join(dir, 'skill.json'), `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  writeFileSync(
    join(dir, 'index.js'),
    entry ||
      `export function setup(api) {
  api.registerTool({ id: 'ping', name: 'Ping', description: 'pong', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: 'pong' }) })
}
export function available() { return { ok: true } }
export function promptSections() { return [{ id: 'x', title: '演示', priority: 30, content: '演示片段' }] }
export function diagnose() { return { 状态: 'ok' } }
`,
    'utf8',
  )
  return dir
}

/* ══════════════════════════════════════════════════════════════════════════
   section ① 清单校验：错要拦、隐患要报
   ══════════════════════════════════════════════════════════════════════════ */
section('① 清单校验：errors（装了也不能用）与 warnings（能跑但有隐患）')
{
  const good = {
    id: 'demo-skill',
    name: '演示',
    version: '1.0.0',
    apiVersion: SKILL_API_VERSION,
    description: '演示用技能（清单校验的基线）',
    entry: 'index.js',
    settings: { enabled: false },
    configSchema: { enabled: { type: 'boolean', label: '启用' } },
  }
  const r0 = validateSkillManifest(good)
  check('★ 合法清单通过且零告警', r0.ok && r0.errors.length === 0 && r0.warnings.length === 0, r0.errors.concat(r0.warnings).join('；'))

  const bad = [
    ['apiVersion 不匹配必须拦下', { ...good, apiVersion: 2 }],
    ['id 非法必须拦下', { ...good, id: 'Demo_Skill' }],
    ['name 为空必须拦下', { ...good, name: '' }],
    ['version 为空必须拦下', { ...good, version: '' }],
    ['entry 缺省必须拦下', { ...good, entry: '' }],
    ['entry 是绝对路径必须拦下', { ...good, entry: 'C:\\evil.js' }],
    ['entry 含 .. 必须拦下', { ...good, entry: '../../evil.js' }],
    ['entry 不是 js 必须拦下', { ...good, entry: 'index.exe' }],
    ['configSchema 未知 type 必须拦下', { ...good, configSchema: { enabled: { type: 'color' } } }],
    ['enum 没有 values 必须拦下', { ...good, configSchema: { enabled: { type: 'enum' } } }],
    ['tools 里 permission 非法必须拦下', { ...good, tools: [{ id: 'a', permission: 'root' }] }],
    ['tools 里 id 非法必须拦下', { ...good, tools: [{ id: 'A B' }] }],
    ['tools 里 id 重复必须拦下', { ...good, tools: [{ id: 'a' }, { id: 'a' }] }],
  ]
  for (const [label, m] of bad) {
    const r = validateSkillManifest(m)
    check(label, r.ok === false && r.errors.length > 0, r.errors.join('；') || '（没报错）')
  }

  const warnCases = [
    ['设置项没有对应界面字段 → 必须告警（用户永远改不了它）',
      { ...good, settings: { enabled: false, hidden: 1 } }],
    ['界面字段没有默认值 → 必须告警（界面空着、运行时 undefined）',
      { ...good, settings: {}, configSchema: { enabled: { type: 'boolean', label: '启用' } } }],
    ['字段没有 label → 必须告警',
      { ...good, settings: { enabled: false }, configSchema: { enabled: { type: 'boolean' } } }],
    ['secret 字段带非空默认值 → 必须告警（密钥不该写在清单里）',
      { ...good, settings: { token: 'plain' }, configSchema: { token: { type: 'string', secret: true, label: 't' } } }],
    ['声明会开本机端口 → 必须告警',
      { ...good, permissions: { listen: ['127.0.0.1'] } }],
    ['session 打错字 → 必须告警（它会静默降级成 hint，而 hint 在群聊判定上是弱的）',
      { ...good, session: 'require' }],
    ['description 为空 → 必须告警（界面上那张卡会是一片空白）',
      { ...good, description: '' }],
  ]
  for (const [label, m] of warnCases) {
    const r = validateSkillManifest(m)
    check(label, r.ok === true && r.warnings.length > 0, r.warnings.join('；') || '（没告警）')
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   section ② 发现：坏技能不阻断好技能，留档目录不算技能
   ══════════════════════════════════════════════════════════════════════════ */
section('② 发现：坏技能带着原因出现，但不影响别的技能')
{
  makeSkill('good-one')
  makeSkill('broken-one', { manifest: { apiVersion: 99 } })
  mkdirSync(join(SKILLS_DIR, '.upstream-original'), { recursive: true })
  writeFileSync(join(SKILLS_DIR, '.upstream-original', 'skill.json'), '{"id":"x"}', 'utf8')
  mkdirSync(join(SKILLS_DIR, 'not-a-skill'), { recursive: true })

  const scan = discoverSkills({ skillsDir: SKILLS_DIR })
  const ids = scan.skills.map((s) => s.id).sort()
  check('★ 好技能与坏技能都被发现，`.开头` 的留档目录被跳过', ids.join(',') === 'broken-one,good-one', ids.join(','))
  check('没有 skill.json 的目录不算技能', !ids.includes('not-a-skill'))
  check('坏技能带 errors 且 ok=false', scan.skills.find((s) => s.id === 'broken-one')?.ok === false)
  check('好技能 ok=true', scan.skills.find((s) => s.id === 'good-one')?.ok === true)

  const missing = discoverSkills({ skillsDir: join(ROOT, 'nope') })
  check('目录不存在时返回空表而不是抛错', missing.skills.length === 0 && missing.exists === false)
}

/* ══════════════════════════════════════════════════════════════════════════
   section ②-b 同一个 id 只允许一个目录（装/卸/升级/回滚时最容易踩）
   ══════════════════════════════════════════════════════════════════════════ */
section('②-b ★★ 同 id 撞车：两个都标红、都不装载（fail-closed，不猜哪个对）')
{
  // 为什么单独用一个目录：这一节要**故意**造两份同 id 的技能，
  // 放进共享的 SKILLS_DIR 会污染后面几节的"发现结果"计数。
  const DUP_DIR = join(ROOT, 'skills-dup')
  for (const [dirName, extra] of [
    ['pixiv-lookup', { version: '1.0.0' }],
    ['pixiv-lookup-backup', { version: '0.9.0' }], // ← 回滚时留下的备份目录，id 没改
  ]) {
    mkdirSync(join(DUP_DIR, dirName), { recursive: true })
    writeFileSync(
      join(DUP_DIR, dirName, 'skill.json'),
      JSON.stringify({ id: 'pixiv-lookup', name: `查图 ${extra.version}`, apiVersion: 1, entry: 'index.js', ...extra }),
      'utf8',
    )
    writeFileSync(join(DUP_DIR, dirName, 'index.js'), 'export function setup(api) {}\n', 'utf8')
  }
  const dup = discoverSkills({ skillsDir: DUP_DIR })
  check('两份都被发现（不是静默丢掉一份）', dup.skills.length === 2, dup.skills.map((s) => s.dirName).join(','))
  check('★★ 两份**都** ok=false —— 不猜"哪个才是真的"', dup.skills.every((s) => s.ok === false), JSON.stringify(dup.skills.map((s) => s.ok)))
  check('★ 原因里指名道姓列出所有撞车的目录',
    dup.skills.every((s) => /id 重复/.test(s.errors.join('；')) && /pixiv-lookup-backup/.test(s.errors.join('；')) && /pixiv-lookup/.test(s.errors.join('；'))),
    dup.skills[0].errors.join('；'))
  check('★ 并且说清了危险在哪（工具名撞车）与怎么办',
    dup.skills.every((s) => /工具名/.test(s.errors.join('；')) && /删掉或改掉/.test(s.errors.join('；'))))
  check('不同 id 时不受影响（对照组）', (() => {
    const solo = join(ROOT, 'skills-solo')
    for (const n of ['a-skill', 'b-skill']) {
      mkdirSync(join(solo, n), { recursive: true })
      writeFileSync(join(solo, n, 'skill.json'), JSON.stringify({ id: n, name: n, version: '1.0.0', apiVersion: 1, entry: 'index.js' }), 'utf8')
      writeFileSync(join(solo, n, 'index.js'), 'export function setup() {}\n', 'utf8')
    }
    return discoverSkills({ skillsDir: solo }).skills.every((s) => s.ok === true)
  })())
}

/* ══════════════════════════════════════════════════════════════════════════
   section ③ 设置合并：默认值 ← 用户值，并按清单收敛类型
   ══════════════════════════════════════════════════════════════════════════ */
section('③ 设置合并与类型收敛（这一节的错全是静默的）')
{
  const manifest = {
    settings: { enabled: false, count: 3, mode: 'a', token: '' },
    configSchema: {
      enabled: { type: 'boolean' },
      count: { type: 'number', min: 1, max: 10 },
      mode: { type: 'enum', values: ['a', 'b'] },
      token: { type: 'string', secret: true },
    },
  }
  const m1 = mergeSkillSettings(manifest, { count: 7, mode: 'b' })
  check('用户值覆盖默认值', m1.settings.count === 7 && m1.settings.mode === 'b')
  check('没写的键取默认值', m1.settings.enabled === false)

  const m2 = mergeSkillSettings(manifest, { count: '5' })
  check('★ 字符串 "5" 收敛成数字 5（否则技能里会变成 NaN → 上限失效）', m2.settings.count === 5, String(m2.settings.count))

  const m3 = mergeSkillSettings(manifest, { count: 'abc' })
  check('★ 转不了的值得退回默认，并带一条 warning（不静默）',
    m3.settings.count === 3 && m3.warnings.length > 0, m3.warnings.join('；'))

  const m4 = mergeSkillSettings(manifest, { count: 999, mode: 'zzz' })
  check('超出 min/max 被夹住', m4.settings.count === 10, String(m4.settings.count))
  check('enum 非法值退回默认并告警', m4.settings.mode === 'a' && m4.warnings.length >= 1)

  const m5 = mergeSkillSettings(manifest, { enabled: 'true' })
  check('boolean 的 "true" 字符串也认', m5.settings.enabled === true)

  const m6 = mergeSkillSettings(manifest, ['not-an-object'])
  check('形状不对的用户配置（数组）按"没配"处理', m6.settings.count === 3)

  // ── 空值：**退回默认值**，不许变成 0／false，也不许告警 ────────────────
  //
  // ⚠️ 这一组是实测抓出来的真缺陷：`Number('')` 是 0、`Number('  ')` 也是 0，
  //   而 0 在 `min: 1` 的字段上会被夹成 1 —— "界面上把条数清空"于是静默变成
  //   「上限 = 1 / 返回 0 条」。原实现在空值分支还直接 return 0，连夹取都绕过。
  for (const [label, given] of [
    ['空串', { count: '' }],
    ['null', { count: null }],
    ['纯空白', { count: '  ' }],
  ]) {
    const r = mergeSkillSettings(manifest, given)
    check(`★ count 的${label}值 → 退回默认 3（不是 0），且不告警`,
      r.settings.count === 3 && r.warnings.length === 0,
      `count=${r.settings.count} warnings=${JSON.stringify(r.warnings)}`)
  }
  // 布尔字段的默认值特意取 `true`：这样才能区分"空值退回默认"与"空值当成 false"
  const boolManifest = { settings: { flag: true }, configSchema: { flag: { type: 'boolean' } } }
  const boolBlank = mergeSkillSettings(boolManifest, { flag: '' })
  check('★ 布尔字段为空 → 退回默认值 true（**不是**当成 false）',
    boolBlank.settings.flag === true && boolBlank.warnings.length === 0, `flag=${boolBlank.settings.flag}`)
  const strBlank = mergeSkillSettings(manifest, { token: '' })
  check('★ 字符串字段为空 → **保持空串**（清空文本框就是真的清空，例如"代理留空=直连"）',
    strBlank.settings.token === '' && strBlank.warnings.length === 0)
  const enumBlank = mergeSkillSettings(manifest, { mode: '' })
  check('枚举为空 → 退回默认值（不是空串）', enumBlank.settings.mode === 'a' && enumBlank.warnings.length === 0)
  const stillWarns = mergeSkillSettings(manifest, { count: 'abc' })
  check('而"确实填错了"仍然要告警（空值不告警，别把两类混起来）', stillWarns.warnings.length === 1)
}

/* ══════════════════════════════════════════════════════════════════════════
   section ④ 密文语义：值不许出界面，空串=不改、null=清除
   ══════════════════════════════════════════════════════════════════════════ */
section('④ 密文：脱敏与"留空即不修改"')
{
  const manifest = {
    settings: { token: '', count: 3 },
    configSchema: { token: { type: 'string', secret: true }, count: { type: 'number' } },
  }
  const settings = { token: 'SECRET-VALUE-123', count: 3 }
  const red = redactSkillSettings(manifest, settings)
  check('★ 密文的**值**不出现在脱敏结果里', !JSON.stringify(red).includes('SECRET-VALUE-123'))
  check('密文字段本身被删除（不是置空）', !('token' in red.values))
  check('用 has 布尔替代', red.has.token === true)
  check('非密文字段照常返回', red.values.count === 3)
  check('空密文 → has=false', redactSkillSettings(manifest, { token: '' }).has.token === false)

  const keep = mergeSkillSettingsPatch(manifest, { token: 'OLD', count: 1 }, { count: 5 })
  check('补丁里没提的密文保持原值', keep.token === 'OLD')
  const blank = mergeSkillSettingsPatch(manifest, { token: 'OLD' }, { token: '' })
  check('★ 空串 = 保持原值（否则用户每保存一次就丢一次密钥）', blank.token === 'OLD')
  const clear = mergeSkillSettingsPatch(manifest, { token: 'OLD' }, { token: null })
  check('★ null = 显式清除', clear.token === '')
  const replace = mergeSkillSettingsPatch(manifest, { token: 'OLD' }, { token: 'NEW' })
  check('非空值覆盖', replace.token === 'NEW')
  const junk = mergeSkillSettingsPatch(manifest, { token: 'OLD' }, { hasToken: true, _note: 'x' })
  check('界面回传的 hasToken / _注释 不会被写进设置', junk.token === 'OLD' && !('hasToken' in junk))
}

/* ══════════════════════════════════════════════════════════════════════════
   section ⑤ 命名：模型看到的工具名只有一处拼装规则
   ══════════════════════════════════════════════════════════════════════════ */
section('⑤ 命名：`mcp__skills__<id>__<tool>` 与宿主工具映射')
{
  check('技能工具全名', skillToolFullName('pixiv-lookup', 'search') === 'mcp__skills__pixiv-lookup__search')
  check('MCP 服务器自报的裸名（不含 mcp__<server>__）', skillToolLocalName('pixiv-lookup', 'search') === 'pixiv-lookup__search')
  check('全名 = 前缀 + 裸名（两半拼装规则一致）',
    skillToolFullName('a', 'b') === `mcp__${SKILLS_SERVER_NAME}__${skillToolLocalName('a', 'b')}`)
  check('宿主发图工具的真名', HOST_TOOLS.send_image === 'mcp__qq__qq_send_image', HOST_TOOLS.send_image)
}

/* ══════════════════════════════════════════════════════════════════════════
   section ⑥ 装载：api 契约、工具收集、available/诊断
   ══════════════════════════════════════════════════════════════════════════ */
section('⑥ 装载：setup(api) 拿到的东西与失败处理')
{
  const seen = {}
  const scan = discoverSkills({ skillsDir: SKILLS_DIR })
  const good = scan.skills.find((s) => s.id === 'good-one')
  await loadSkill(good, {
    config: { skills: { 'good-one': { count: 9 } } },
    log: () => {},
    registerTool: (t) => {
      seen.tool = t
    },
  })
  check('装载成功', good.loaded === true, good.loadError)
  check('工具被收进 runtimeTools', good.runtimeTools.length === 1 && good.runtimeTools[0].id === 'ping')
  check('工具名按宿主规则定死', good.runtimeTools[0].fullName === 'mcp__skills__good-one__ping')
  check('没有声明 permission 的工具默认按只读处理', good.runtimeTools[0].permission === 'read')
  check('registerTool 的回调也收到了归一化后的工具', seen.tool?.fullName === 'mcp__skills__good-one__ping')
  check('available() 被同步调用并记下来', good.available.ok === true)
  check('describeSkill 把工具、设置、片段都整理出来', describeSkill(good, { skills: { 'good-one': { count: 9 } } }).settings.count === 9)

  // 关掉时：工具仍在（工具表按已安装注册），但可用性判定为关
  const cfgOff = { skills: { 'good-one': { enabled: false } } }
  check('★ 关掉后 isSkillEnabled=false（MCP 侧据此当场拒绝）', isSkillEnabled(good, cfgOff) === false)
  check('默认（没配过）取清单的 enabledByDefault=false', isSkillEnabled(good, { skills: {} }) === false)
  check('显式打开后为 true', isSkillEnabled(good, { skills: { 'good-one': { enabled: true } } }) === true)

  // 坏技能：连清单都不过 → 不能装载，但要有原因
  const broken = scan.skills.find((s) => s.id === 'broken-one')
  await loadSkill(broken, { config: {}, log: () => {} })
  check('清单坏的技能装载失败并留下原因', broken.loaded === false && broken.loadError.length > 0)
  check('skillStatus 的 reasons 是给使用者看的中文', skillStatus(broken, {}).reasons.join('；').includes('清单有问题'))

  // setup 抛错 / 没有 setup / available 抛错
  const dirBad = makeSkill('bad-setup', { entry: 'export function setup() { throw new Error("boom") }\n' })
  const d1 = discoverSkills({ skillsDir: SKILLS_DIR }).skills.find((s) => s.dir === dirBad)
  await loadSkill(d1, { config: {}, log: () => {} })
  check('★ setup 抛错被兜住（不让一个坏技能拖垮装载流程）', d1.loaded === false && /boom/.test(d1.loadError))

  const dirNoSetup = makeSkill('no-setup', { entry: 'export const x = 1\n' })
  const d2 = discoverSkills({ skillsDir: SKILLS_DIR }).skills.find((s) => s.dir === dirNoSetup)
  await loadSkill(d2, { config: {}, log: () => {} })
  check('没有导出 setup 的模块被判为"不是一份技能"', /没有导出 setup/.test(d2.loadError))

  const dirAvail = makeSkill('avail-throws', {
    entry: `export function setup() {}
export function available() { throw new Error('nope') }
`,
  })
  const d3 = discoverSkills({ skillsDir: SKILLS_DIR }).skills.find((s) => s.dir === dirAvail)
  await loadSkill(d3, { config: {}, log: () => {} })
  check('available() 抛错 → 记录为不可用（而不是崩掉装载）', d3.available.ok === false && /nope/.test(d3.available.reason))

  check('diagnose() 可选：有就调用', callSkillDiagnose(good, {})?.状态 === 'ok')
  check('diagnose() 抛错也被兜住', callSkillDiagnose({ module: { diagnose: () => { throw new Error('x') } } }, {}) !== null)

  // ── ★★ 0.2.7 回归：自检必须**现调**，不能读装载时的快照 ────────────────────
  //   真机踩过（控制台截图）：技能是**装载之后**才在控制台打开的，卡片却一直写着
  //   「开关没打开」+「暂时用不了」，而且再也不会变 —— 使用者看到的是
  //   "我明明开着，它说我没开"。同一个坑对"后来才装好 ffmpeg / 填好路径"完全一样。
  const dirLive = makeSkill('avail-live', {
    manifest: { name: '现调自检演示' },
    // 自检依赖的是**另一个配置键**（count），这样"现调 vs 快照"才验得干净：
    // 开关全程都开着，只有 count 变，而结论跟着变 ⇒ 只可能是现调出来的。
    entry: `export function setup() {}
export function available(context) {
  const n = Number(context?.config?.skills?.['avail-live']?.count ?? 0)
  return n >= 5 ? { ok: true } : { ok: false, reason: '「现调自检演示」计数太小（照真实技能那样依赖 config）' }
}
`,
  })
  const dLive = discoverSkills({ skillsDir: SKILLS_DIR }).skills.find((s) => s.dir === dirLive)
  await loadSkill(dLive, { config: { skills: { 'avail-live': { enabled: true, count: 1 } } }, log: () => {} })
  check('装载时 count=1 → 装载结果里记下"不可用"（这一份是快照，仍然留着）', dLive.available.ok === false)

  const small = { skills: { 'avail-live': { enabled: true, count: 1 } } }
  const big = { skills: { 'avail-live': { enabled: true, count: 9 } } }
  const cardSmall = describeSkill(dLive, small)
  const cardBig = describeSkill(dLive, big)
  check(
    '★★ 只改了一个配置键（count）→ 卡片的自检结论**立刻**跟着变（不是装载时的旧快照）',
    cardSmall.available.ok === false && cardBig.available.ok === true,
    `count=1 → ${JSON.stringify(cardSmall.available)}／count=9 → ${JSON.stringify(cardBig.available)}`,
  )
  check(
    '★★ 而且不可用时那句原因**跟着出现**、可用时**跟着消失**（真机上误导使用者的就是这一类陈旧文案）',
    cardSmall.reasons.length === 1 && /计数太小/.test(cardSmall.reasons[0]) && cardBig.reasons.length === 0,
    JSON.stringify({ small: cardSmall.reasons, big: cardBig.reasons }),
  )
  check(
    '★ skillStatus() 不传自检结果时也是现调（不是沿用快照）',
    skillStatus(dLive, big).reasons.length === 0 && skillStatus(dLive, small).reasons.length === 1,
  )
  check(
    '★ 自检抛错仍然被兜住（现调不会让列表接口崩）',
    describeSkill({ ...dLive, module: { available: () => { throw new Error('boom') } } }, {}).available.ok === false,
  )
}

/* ══════════════════════════════════════════════════════════════════════════
   section ⑦ 提示词片段：关掉的一个字都不许出现
   ══════════════════════════════════════════════════════════════════════════ */
section('⑦ 提示词片段：只收启用中的，且一个技能出错不影响别的')
{
  const dirThrow = makeSkill('prompt-throws', {
    entry: `export function setup() {}
export function promptSections() { throw new Error('pfail') }
`,
  })
  const skills = discoverSkills({ skillsDir: SKILLS_DIR }).skills
  for (const s of skills) if (s.ok) await loadSkill(s, { config: {}, log: () => {} })
  const good = skills.find((s) => s.id === 'good-one')
  const thrower = skills.find((s) => s.dir === dirThrow)

  const off = collectSkillPromptSections({ skills: [good], config: { skills: {} }, log: () => {} })
  check('★ 关掉的技能不产出任何片段（否则模型会去调一个不存在的工具）', off.lines.length === 0)

  const on = collectSkillPromptSections({ skills: [good], config: { skills: { 'good-one': { enabled: true } } }, log: () => {} })
  check('打开后产出片段', on.lines.length === 1 && on.lines[0].content === '演示片段')

  const mixed = collectSkillPromptSections({
    skills: [thrower, good],
    config: { skills: { 'good-one': { enabled: true }, 'prompt-throws': { enabled: true } } },
    log: () => {},
  })
  check('★ 一个技能的 promptSections 抛错只跳过它，别的照常注入',
    mixed.lines.length === 1 && mixed.errors.length === 1, JSON.stringify(mixed.errors))

  // ── ★★ 0.2.2 补的漏：QQ 工具总开关关着时，技能工具**根本不会挂给模型** ──────────
  //
  // 两个 MCP 服务器（QQ 工具 / 技能工具）由同一个开关管：关掉它 = "模型只能用文字回复"。
  // 此时若还把技能的提示词片段注入，提示词就在教模型去调一个**不存在**的工具 ——
  // 而它只会说"查不到"。这就是本项目反复在防的那类静默失效。
  const onCfg = { mcp: { enabled: true }, skills: { 'good-one': { enabled: true } } }
  const offCfg = { mcp: { enabled: false }, skills: { 'good-one': { enabled: true } } }
  check('MCP 开着 → 片段照常注入', collectSkillPromptSections({ skills: [good], config: onCfg }).lines.length === 1)
  const gated = collectSkillPromptSections({ skills: [good], config: offCfg })
  check('★ MCP 关着 → 技能片段**一条都不注入**（工具不存在，指引也不该在）',
    gated.lines.length === 0 && gated.skipped === 'mcp-disabled', JSON.stringify(gated.skipped))
  check('★ 卡片上要说明原因（否则用户以为"我开着它，怎么不用"）',
    describeSkill(good, offCfg).reasons.some((r) => r.includes('mcp.enabled')), JSON.stringify(describeSkill(good, offCfg).reasons))
  check('MCP 关着但技能也关着 → 不报这条原因（它本来就关着，别拿总开关当解释）',
    !describeSkill(good, { mcp: { enabled: false }, skills: { 'good-one': { enabled: false } } })
      .reasons.some((r) => r.includes('mcp.enabled')))
  check('没配 mcp 这一项（旧配置）→ 不受影响，照常注入',
    collectSkillPromptSections({ skills: [good], config: { skills: { 'good-one': { enabled: true } } } }).lines.length === 1)
}

/* ══════════════════════════════════════════════════════════════════════════
   section ⑧ 插件登记表：不改行为、hot/cold 有据、形状如实
   ══════════════════════════════════════════════════════════════════════════ */
section('⑧ 内置插件登记表')
{
  const cfg = normalizeConfig({})
  const plugins = listPlugins({ config: cfg })
  check('每个插件都指着一个**已登记的既有配置键**', plugins.every((p) => p.enabledPath.includes('.')))
  check('★ 每个插件都写清了 hot 或 cold 的取证理由', BUILTIN_PLUGINS.every((p) => typeof p.hot === 'boolean' && String(p.why).length > 10))
  check('★ 每个插件都写了"关掉会怎样"', BUILTIN_PLUGINS.every((p) => String(p.offEffect).length > 5))
  check('记忆默认开（!== false 的既有语义）', plugins.find((p) => p.id === 'memory').enabled === true)
  check('把记忆关掉后登记表如实反映', listPlugins({ config: { memory: { enabled: false } } }).find((p) => p.id === 'memory').enabled === false)
  // ── 投递可靠性（0.2.3）：账本开关 ────────────────────────────────────────
  check('★ 投递账本默认开（`!== false` 的既有语义 = 升级前的行为）',
    pluginById('delivery')?.enabledPath === 'delivery.ledger' && isPluginOn(pluginById('delivery'), cfg) === true)
  check('★ 把投递账本关掉后登记表如实反映',
    listPlugins({ config: { delivery: { ledger: false } } }).find((p) => p.id === 'delivery').enabled === false)
  check('★ 投递可靠性是 hot（每次投递前现读 config.delivery.ledger）', pluginById('delivery').hot === true)
  check('★ offEffect 里必须说清"另两块不受它影响"（否则使用者以为关掉它 = 关掉整条出站链路）',
    /终检门/.test(pluginById('delivery').offEffect) && /幂等键/.test(pluginById('delivery').offEffect))
  check('★ 名单类不提供开关（列表没有"关"这个动作）', pluginSwitchKind(pluginById('access')).kind === 'list')
  check('名单类的 enabled 是 null（界面据此渲染成"去维护"而不是一个点不动的开关）',
    listPlugins({ config: cfg }).find((p) => p.id === 'access').enabled === null)
  check('人设是枚举开关（关 = preset 取 none）', pluginSwitchKind(pluginById('persona')).kind === 'enum')
  check('★ 人设是 cold（构造期缓存，实测如此）', pluginById('persona').hot === false)
  check('mcp.enabled 是 cold（只在启动时决定挂不挂 MCP）', pluginById('qq-tools').hot === false)
  check('记忆是 hot（每轮重读 config.memory.enabled）', pluginById('memory').hot === true)
  check('isPluginOn 对枚举的口径：none = 关', isPluginOn(pluginById('persona'), { persona: { preset: 'none' } }) === false)

  // ── ★★ 0.2.7：`switchInSkill` —— 控件在**技能卡**上的条目（表情包）────────────
  //
  //   真机反馈："同一个开关放在 skill 和插件上不合理"。表情包既是技能（技能卡上有
  //   结构性开关）又被本表登记（因为要如实标注"开关在哪"），于是界面上出现了
  //   **两个都能点的控制点**。修法：登记照旧、**控件只留一个**。
  {
    const st = pluginById('sticker')
    const kinds = pluginSwitchKind(st)
    check('★★ 表情包在插件表里带 `switchInSkill`（登记"开关在技能卡上"）', st?.switchInSkill === 'sticker', JSON.stringify(st?.switchInSkill))
    check('★★ pluginSwitchKind 对它返回 skill（界面据此不渲染 Switch，而不是靠 id 硬编码）', kinds.kind === 'skill' && kinds.skillId === 'sticker', JSON.stringify(kinds))
    check('★ isPluginOn 对它返回 null（"在这里开关"这个动作不存在）', isPluginOn(st, cfg) === null, String(isPluginOn(st, cfg)))
    check('★ 登记仍然带出去（插件区照样能看到这一行，信息不丢）', (() => {
      const row = listPlugins({ config: cfg }).find((p) => p.id === 'sticker')
      return Boolean(row) && row.switchInSkill === 'sticker' && row.switchKind === 'skill' && String(row.what ?? '').length > 0
    })())
    // ★★ 防漂移：`switchInSkill` 指的那个技能，它的 enabled 键必须正好等于这条 enabledPath。
    //   技能改名/换键时这条会立刻红 —— 否则界面会把人送到一张**没有那个开关**的卡上。
    //
    //   ⚠️ 注意取样目录：本套件其余断言用的是**临时夹具技能目录**（`SKILLS_DIR`），
    //   里面没有 sticker；这一条要查的是"登记表 ↔ 真实技能"的一致性，
    //   所以必须读**真实**的 `skills/`（`import.meta.url` 相对定位，不写死绝对路径）。
    const realSkillsDir = fileURLToPath(new URL('../skills/', import.meta.url))
    const target = discoverSkills({ skillsDir: realSkillsDir }).skills.find((s) => s.id === st?.switchInSkill)
    check(
      '★★ `switchInSkill` 指向的技能必须存在，且它的 enabled 键正好等于这条 enabledPath（防漂移）',
      Boolean(target) && st.enabledPath === `skills.${target.id}.enabled`,
      `enabledPath=${st?.enabledPath} 目标技能=${target?.id ?? '(不存在)'}（查的是真实 skills/）`,
    )
    check('★ 目标技能确实在自己的清单里声明了 enabled（界面上的开关来自它）', 'enabled' in (target?.manifest?.settings ?? {}))
  }

  // ── choice（二选一）：**两个功能冲突时**的插槽 ────────────────────────────
  //
  // ★ 0.2.7 更正：这段注释原来写"现在还没有真插件用上它（wake.policy 要等语义唤醒落地）"，
  //   已经过期 —— `wake-policy`（`enabledPath: 'wake.policy'`）就是真的 choice 插件，
  //   见 src/plugins.mjs。下面这份**合成 spec** 仍然保留：它钉的是 choice 的**契约本身**
  //   （形状与语义），与"当前有没有真插件在用它"是两件事 —— 契约错了要在登记时就挡住，
  //   而不是等使用者发现"两个都能开"。
  const synthChoice = {
    id: 'synth-choice',
    enabledPath: 'wake.policy',
    choice: {
      options: [
        { value: 'rule', label: '规则唤醒（现状）' },
        { value: 'semantic', label: '语义唤醒（可沉默）', experimental: true },
      ],
    },
  }
  const synthKind = pluginSwitchKind(synthChoice)
  check('★ 二选一被识别为 choice，且选项（含「实验性」标注）带给了界面',
    synthKind.kind === 'choice' && synthKind.options.length === 2 && synthKind.options[1].experimental === true)
  check('★ 二选一没有"关"：isPluginOn 返回 null —— 否则界面会出现一个语义错误的开关',
    isPluginOn(synthChoice, { wake: { policy: 'rule' } }) === null)
  check('★ 互相排斥是这个键的天然语义（单值键：选了 B 就等于 A 不在）',
    isPluginOn(synthChoice, { wake: { policy: 'semantic' } }) === null &&
      pluginSwitchKind(synthChoice).options.length === 2)
  check('没有声明 choice 的插件不受影响（仍按 enabledPath 推导成布尔开关）',
    pluginSwitchKind({ enabledPath: 'x.enabled' }).kind === 'boolean')
}

/* ══════════════════════════════════════════════════════════════════════════
   section ⑨ 扩展服务：开关"即时生效"的含义
   ══════════════════════════════════════════════════════════════════════════ */
section('⑨ 扩展服务：写盘 + 改活配置（两件事都要做）')
{
  const raw = { dsh: { workspace: join(ROOT, 'ws') }, skills: {}, security: { allowPrivateImageHosts: false } }
  const configPath = join(ROOT, 'config.json')
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  const live = normalizeConfig(raw)
  const skills = discoverSkills({ skillsDir: SKILLS_DIR }).skills
  for (const s of skills) if (s.ok) await loadSkill(s, { config: live, log: () => {} })

  const svc = createExtensionService({
    config: live,
    configPath,
    skills,
    skillsDir: SKILLS_DIR,
    validate: validateConfig,
    normalize: normalizeConfig,
  })

  const list = svc.list()
  check('列表里有技能、有插件、有计数', list.skills.length > 0 && list.plugins.length > 0 && list.counts.skills === list.skills.length)
  check('★ 列表里不带密文原文', !JSON.stringify(list).includes('SECRET-VALUE-123'))

  const on = await svc.toggle({ type: 'skill', id: 'good-one', enabled: true })
  const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
  check('★ 打开技能：盘上写下了 enabled=true', onDisk.skills['good-one']?.enabled === true)
  check('★ 打开技能：活配置也变了（否则"下一轮生效"是假的）', live.skills['good-one']?.enabled === true)
  check('返回里如实说明即时生效', on.hot === true && on.restartRequired === false, JSON.stringify(on))

  const off = await svc.toggle({ type: 'skill', id: 'good-one', enabled: false })
  check('关闭技能同样即时', off.enabled === false && JSON.parse(readFileSync(configPath, 'utf8')).skills['good-one'].enabled === false)

  const missing = await svc.toggle({ type: 'skill', id: 'nope', enabled: true })
  check('未知技能 → 404（不是 500）', missing.status === 404, JSON.stringify(missing))

  const brokenToggle = await svc.toggle({ type: 'skill', id: 'broken-one', enabled: true })
  check('★ 清单坏的技能开不了，且原因说出来', brokenToggle.status === 422 && /skill\.json/.test(brokenToggle.error))

  // ★★ 0.2.7：控件在技能卡上的条目（表情包）—— **接口层不给第二条写入口**。
  //   它和上面 list/choice 那两条守卫是同一条纪律；这条断言钉住"只有一个写入口"这件事
  //   在**接口层**也成立（不只是界面不渲染 Switch 而已）。
  const stickerPlugin = await svc.toggle({ type: 'plugin', id: 'sticker', enabled: true })
  check(
    '★★ toggle(type:plugin, id:sticker) 被拒（400），并把人指向技能卡',
    stickerPlugin.status === 400 && /技能卡/.test(String(stickerPlugin.error ?? '')),
    JSON.stringify(stickerPlugin).slice(0, 160),
  )
  check(
    '★★ 而且它**没有**偷偷写盘（拒绝就必须真的什么都没改）',
    JSON.parse(readFileSync(configPath, 'utf8')).skills?.sticker?.enabled === undefined,
    JSON.stringify(JSON.parse(readFileSync(configPath, 'utf8')).skills?.sticker ?? null),
  )

  const hotPlugin = await svc.toggle({ type: 'plugin', id: 'memory', enabled: false })
  check('★ hot 插件：如实回 restartRequired=false', hotPlugin.hot === true && hotPlugin.restartRequired === false)
  check('hot 插件确实写进了盘', JSON.parse(readFileSync(configPath, 'utf8')).memory?.enabled === false)

  const coldPlugin = await svc.toggle({ type: 'plugin', id: 'usage', enabled: false })
  check('★ cold 插件：如实回 restartRequired=true（不假装生效）', coldPlugin.hot === false && coldPlugin.restartRequired === true)
  check('cold 插件带上了"为什么"', String(coldPlugin.why ?? '').length > 10)

  const listToggle = await svc.toggle({ type: 'plugin', id: 'access', enabled: false })
  check('名单类插件没有开关 → 400 并说明去别处维护', listToggle.status === 400)

  // ── 二选一插件（0.2.3 起是**真插件**，不再是合成 spec）──────────────────
  //
  // ★ 这条守卫必须存在，否则 `toggle` 会把**布尔值**写进一个只认字符串的键
  //   （`wake.policy`）—— 配置里出现 `"policy": true`，运行期按"不是 semantic"
  //   处理，于是**界面显示保存成功、实际什么都没发生**。这正是本项目最忌讳的
  //   "说了做不到"，而且它不会报错。
  {
    const card = svc.list().plugins.find((p) => p.id === 'wake-policy')
    check('★ 唤醒策略已登记为插件卡', Boolean(card), JSON.stringify(svc.list().plugins.map((p) => p.id)))
    // ★★ 用户要求（0.2.3）：「唤醒规则」那张卡删掉 —— 它和这张卡回答同一个问题
    //    （这条消息要不要回），一张只显示判据里的一个开关、另一张显示"用哪套判据"，
    //    两处各说一半。判据本身搬进本卡的「唤醒方式」一节（界面侧 WakeRulesSection）。
    check('★★ 原来那张「唤醒规则」卡（id: trigger）**已删除**（与唤醒策略回答同一个问题）',
      !svc.list().plugins.some((p) => p.id === 'trigger'),
      JSON.stringify(svc.list().plugins.map((p) => p.id)))
    check('  └ 但 `trigger.*` 那几个键仍然是真的、仍被运行期读（只是不再单独占一张卡）',
      svc.list().plugins.every((p) => p.enabledPath !== 'trigger.groupEnabled'))
    check('★ 唤醒策略的 why 里说清了它名下还有「唤醒方式」那一节（同样是每轮现读）',
      /trigger\.\*/.test(String(card?.why)), String(card?.why).slice(0, 80))
    check('  └「关掉会怎样」里说明了判定那段调用的代价与两条通路',
      /一次性 DSH 进程/.test(String(card?.offEffect)) && /直连/.test(String(card?.offEffect)))
    check('★★ 它的开关语义是 choice（第一个真正用上它的插件）', card?.switchKind === 'choice' && card?.enabled === null, `${card?.switchKind}/${card?.enabled}`)
    check('★ 两个候选：rule（现状）与 semantic（实验性）',
      card?.options?.length === 2 && card.options[0].value === 'rule' && card.options[1].value === 'semantic',
      JSON.stringify(card?.options?.map((o) => o.value)))
    check('★★ hermes 式的那一侧标了「实验性」', card?.options?.find((o) => o.value === 'semantic')?.experimental === true)
    check('现状那一侧**不标**实验性（它是本项目一直在跑的行为）', card?.options?.find((o) => o.value === 'rule')?.experimental !== true)
    check('★ 每个选项都各有一句"选它会怎样"（二选一没有"关"，不能沿用 offEffect 的写法）',
      card?.options?.every((o) => typeof o.desc === 'string' && o.desc.length > 0))
    check('enabledPath 指向真实配置键', card?.enabledPath === 'wake.policy')

    const before = JSON.parse(readFileSync(configPath, 'utf8'))
    const choiceToggle = await svc.toggle({ type: 'plugin', id: 'wake-policy', enabled: true })
    check('★ 对二选一插件调"开关" → 400（它不是开/关，是选了哪一个）', choiceToggle.status === 400, JSON.stringify(choiceToggle))
    check('★ 拒绝时把可选取值说出来（调用方知道该往哪走）', /rule/.test(choiceToggle.error) && /semantic/.test(choiceToggle.error))
    const after = JSON.parse(readFileSync(configPath, 'utf8'))
    check('★★ 拒绝时**盘上一个字节都没写**（绝不留下 `"policy": true` 这种坏配置）',
      JSON.stringify(before) === JSON.stringify(after))
  }

  // ── 本地语料库（0.2.3 加的开关）────────────────────────────────────────
  {
    const card = svc.list().plugins.find((p) => p.id === 'corpus')
    check('★ 本地语料检索已登记为插件卡', Boolean(card), JSON.stringify(svc.list().plugins.map((p) => p.id)))
    check('  它是**布尔开关**（不是二选一：语料库只有"采不采"，没有第二种策略）',
      card?.switchKind === 'boolean' && card?.enabledPath === 'corpus.enabled')
    // ★ hot 必须取证过：写入侧每条消息现读、读取侧每次调用现读 —— 见 plugins.mjs 的 why
    check('★ 标的是 hot，且 why 里给得出取证位置（不是猜的）',
      card?.hot === true && /#recordCorpus/.test(String(card?.why)) && /readLiveConfig/.test(String(card?.why)), String(card?.why).slice(0, 80))
    check('★「关掉会怎样」写清了两件最容易被误解的事：工具是**当场拒绝**（不是搜不到）、且有库文件不删',
      /当场拒绝/.test(String(card?.offEffect)) && /不会被删/.test(String(card?.offEffect)))
    check('  没有详情页（就一个开关，指过去也会是死链）', card?.uiTab === null)

    const off = await svc.toggle({ type: 'plugin', id: 'corpus', enabled: false })
    check('★ 关掉它：写盘 + 改活配置（立刻生效）', off.restartRequired === false &&
      JSON.parse(readFileSync(configPath, 'utf8')).corpus?.enabled === false && live.corpus?.enabled === false)
    check('  └ 提示语说明"立刻生效"', /立刻生效/.test(String(off.hint)))
    const on = await svc.toggle({ type: 'plugin', id: 'corpus', enabled: true })
    check('  再打开也立刻生效（这一格不需要重启）', on.restartRequired === false && live.corpus?.enabled === true)
  }

  const badType = await svc.toggle({ type: 'nope', id: 'x', enabled: true })
  check('type 非法 → 400', badType.status === 400)

  const saved = await svc.saveSettings({ id: 'good-one', patch: { count: '4', token: 'NEW-SECRET' } })
  const savedDisk = JSON.parse(readFileSync(configPath, 'utf8'))
  check('★ 技能设置保存：类型被收敛（"4" → 4）', savedDisk.skills['good-one'].count === 4, JSON.stringify(savedDisk.skills['good-one']))
  check('★ 技能设置保存：密文写进盘、但响应里只有其布尔', savedDisk.skills['good-one'].token === 'NEW-SECRET' && saved.secretSet.token === true && !JSON.stringify(saved).includes('NEW-SECRET'))
  check('技能设置保存是即时生效（不要求重启）', saved.restartRequired === false)

  const blankSave = await svc.saveSettings({ id: 'good-one', patch: { token: '' } })
  check('★ 密文留空 = 不修改（这条弄错的话，改个上限就会把 Cookie 弄丢）',
    JSON.parse(readFileSync(configPath, 'utf8')).skills['good-one'].token === 'NEW-SECRET' && blankSave.secretSet.token === true)

  const clearSave = await svc.saveSettings({ id: 'good-one', patch: { token: null } })
  check('密文传 null = 清除', JSON.parse(readFileSync(configPath, 'utf8')).skills['good-one'].token === '' && clearSave.secretSet.token === false)

  const warnSave = await svc.saveSettings({ id: 'good-one', patch: { count: 'abc' } })
  check('类型转不了时返回 warning（而不是静默取默认值）', warnSave.warnings.length > 0, JSON.stringify(warnSave.warnings))

  // ★ 校验不通过时必须拒绝写盘（否则会留下一个下次启动必失败的配置）
  const svcStrict = createExtensionService({
    config: live,
    configPath,
    skills,
    skillsDir: SKILLS_DIR,
    validate: () => ({ fatal: ['模拟的致命配置问题'], warn: [] }),
    normalize: (x) => x,
  })
  const before = readFileSync(configPath, 'utf8')
  const refused = await svcStrict.toggle({ type: 'skill', id: 'good-one', enabled: true })
  check('★ 校验 fatal 时拒绝保存（并说明原因）', refused.status === 422 && refused.extra?.fatal?.length === 1)
  check('拒绝时盘上内容一个字没变', readFileSync(configPath, 'utf8') === before)
}

/* ══════════════════════════════════════════════════════════════════════════
   section ⑩ HTTP 路由：参数校验与 501 兜底
   ══════════════════════════════════════════════════════════════════════════ */
section('⑩ HTTP 路由 /api/extensions*')
{
  const calls = []
  const handler = createApiHandler({
    configPath: join(ROOT, 'config.json'),
    readRawConfig: () => JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')),
    writeRawConfig: () => {},
    normalize: (x) => x,
    validate: () => ({ fatal: [], warn: [] }),
    getStatus: () => ({}),
    listExtensions: () => ({ skills: [], plugins: [], counts: {} }),
    toggleExtension: async ({ type, id, enabled }) => {
      calls.push({ type, id, enabled })
      if (id === 'cold') return { type, id, enabled, hot: false, restartRequired: true, why: '模拟' }
      if (id === 'bad') return { error: '开不了', status: 422 }
      return { type, id, enabled, hot: true, restartRequired: false }
    },
    saveSkillSettings: async ({ id, patch }) => ({ id, patch }),
    diagnoseSkill: async (id) => (id === 'none' ? null : { id, report: { 状态: 'ok' } }),
  })

  const call = (method, path, body) => handler({ method, path, body })
  check('GET 列表', (await call('GET', '/api/extensions')).body?.ok === true)
  check('GET 列表带查询串也能匹配', (await call('GET', '/api/extensions?x=1')).status === 200)
  check('POST 开关成功', (await call('POST', '/api/extensions/toggle', { type: 'skill', id: 'a', enabled: true })).body?.data?.hot === true)
  check('★ type 非法 → 400（参数问题与语义拒绝用不同状态码）',
    (await call('POST', '/api/extensions/toggle', { type: 'x', id: 'a', enabled: true })).status === 400)
  check('enabled 不是布尔 → 400', (await call('POST', '/api/extensions/toggle', { type: 'skill', id: 'a', enabled: 'yes' })).status === 400)
  check('缺 id → 400', (await call('POST', '/api/extensions/toggle', { type: 'skill', enabled: true })).status === 400)
  check('★ 服务层拒绝 → 422 且带原文', (await call('POST', '/api/extensions/toggle', { type: 'skill', id: 'bad', enabled: true })).status === 422)
  check('cold 插件把 restartRequired 带回给界面',
    (await call('POST', '/api/extensions/toggle', { type: 'plugin', id: 'cold', enabled: true })).body?.data?.restartRequired === true)
  check('保存技能设置', (await call('POST', '/api/extensions/settings', { id: 'a', patch: { count: 1 } })).body?.data?.id === 'a')
  check('patch 不是对象 → 400', (await call('POST', '/api/extensions/settings', { id: 'a', patch: [] })).status === 400)
  check('诊断：没有 diagnose 的技能 → 404',
    (await call('GET', '/api/extensions/diagnose?id=none')).status === 404)
  check('诊断：正常返回', (await call('GET', '/api/extensions/diagnose?id=a')).body?.data?.report?.状态 === 'ok')
  check('诊断缺 id → 400', (await call('GET', '/api/extensions/diagnose')).status === 400)

  // 依赖没注入时必须是 501（"路径对、功能还没接"，而不是 404 让人去改路径）
  const bare = createApiHandler({
    configPath: 'x',
    readRawConfig: () => ({}),
    writeRawConfig: () => {},
    normalize: (x) => x,
    validate: () => ({ fatal: [], warn: [] }),
    getStatus: () => ({}),
  })
  check('★ 依赖没注入 → 501 而不是 404', (await bare({ method: 'GET', path: '/api/extensions' })).status === 501)
  check('未知路径仍然是 404', (await bare({ method: 'GET', path: '/api/nope' })).status === 404)
}

/* ══════════════════════════════════════════════════════════════════════════
   section ⑪ 发图工具：守卫与失败说明
   ══════════════════════════════════════════════════════════════════════════ */
section('⑪ qq_send_image：内网地址默认拒、开关打开才放行、失败必须说清')
{
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
    'hex',
  )
  const originalFetch = globalThis.fetch
  const posts = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.startsWith('http://onebot.test')) {
      posts.push({ url: u, body: init?.body ?? '' })
      return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    // 图片下载
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
  }

  const sendTool = TOOLS.find((t) => t.name === 'qq_send_image')
  check('工具存在且被标为写入类（描述里带权限提示）', Boolean(sendTool) && described(sendTool).includes('只有管理员'))

  const noSession = await runSendImage({ url: 'http://onebot.test/i/1' })
  check('★ 缺 kind/peerId 时 fail-closed（不许猜会话）', noSession.isError === true && /必须指定会话/.test(noSession.text))

  const refused = await runSendImage({ url: 'http://127.0.0.1:18717/i/abc', kind: 'private', peerId: '1' })
  check('★ 内网直链在默认配置下被拒', refused.isError === true)
  check('★ 拒绝理由里写清"是哪个开关、在哪打开"（否则会被当成网络故障）',
    /允许下载内网\/本机图片地址/.test(refused.text), refused.text)

  // ── 打开开关之后：放行、取回、以 base64 段发出去 ────────────────────────
  const cfgPath = join(ROOT, 'send-image-config.json')
  writeFileSync(cfgPath, `${JSON.stringify({ security: { allowPrivateImageHosts: true }, image: { maxBytes: 1048576, timeoutMs: 5000 } })}\n`, 'utf8')
  __setConfig({ httpUrl: 'http://onebot.test', timeoutMs: 5000, configPath: cfgPath })

  const ok = await runSendImage({ url: 'http://127.0.0.1:18717/i/abc', kind: 'group', peerId: '999', caption: '给你看' })
  check('★ 开关打开后放行内网直链并发送成功', ok.isError === false, ok.text)
  const post = posts.at(-1)
  check('发给协议端的是 send_group_msg', /send_group_msg$/.test(post?.url ?? ''), post?.url)
  const sentBody = JSON.parse(post?.body ?? '{}')
  check('★ 图片以 base64 段发出（不把 URL 交给协议端去取：守卫与防盗链都在我们这边）',
    sentBody.message?.[1]?.type === 'image' && String(sentBody.message?.[1]?.data?.file ?? '').startsWith('base64://'),
    JSON.stringify(sentBody.message?.[1]?.type))
  check('caption 作为文本段排在图片前面', sentBody.message?.[0]?.type === 'text' && sentBody.message[0].data.text === '给你看')
  check('群号用的是 group_id', sentBody.group_id === 999)

  // 取回来的不是图片 → 要说清是内容问题（而不是"发送失败"）
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://onebot.test')) {
      posts.push({ url: String(url), body: init?.body ?? '' })
      return new Response(JSON.stringify({ status: 'ok', retcode: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('<html>不是图片</html>', { status: 200, headers: { 'content-type': 'text/html' } })
  }
  const notImage = await runSendImage({ url: 'http://127.0.0.1:18717/i/abc', kind: 'private', peerId: '1' })
  check('★ 内容不是图片时给的是"内容不对"的说明（不是笼统的发送失败）',
    notImage.isError === true && /不是支持的图片/.test(notImage.text), notImage.text)

  __setConfig(null)
  globalThis.fetch = originalFetch
}

/* ══════════════════════════════════════════════════════════════════════════
   收尾
   ══════════════════════════════════════════════════════════════════════════ */
try {
  rmSync(ROOT, { recursive: true, force: true })
} catch {
  /* 临时目录清理失败不影响结论 */
}

console.log('')
if (failures > 0) {
  console.log(`⚠️ ${failures} 项失败`)
  process.exitCode = 1
} else {
  console.log('✅ 扩展系统（技能 + 插件）全部通过')
}
