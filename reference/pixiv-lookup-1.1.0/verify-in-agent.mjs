// 在 QQ Agent **自己的 skill 加载器**里验证 pixiv-lookup（"是否运行"的硬证据）
//
// 和 test/run-tests.mjs 的区别：
//   · run-tests.mjs   —— 用假 transport 测技能自身的解析/过滤/报错逻辑，不需要外网
//   · 本文件（in-app-check）—— 把**真实的** plugin-loader 拉起来，走一遍
//       readManifest → normalizeManifest → import(entry) → setup(api) → registerTool
//     然后回答三个问题：
//       ① 清单能不能过上游校验（id/category/entry/permissions）
//       ② entry 能不能被 import 并成功注册工具（名字是不是 pixiv-lookup__xxx）
//       ③ skillManager 眼里这个技能处于哪一层状态（loaded / enabled / available / active）
//
// 用法：
//   <QQ Agent>\node_modules\electron\dist\electron.exe .\skills\pixiv-lookup\verify-in-agent.mjs
//   ... 加 --diagnose 则只打印本插件的 diagnose()（含断路器状态），不做联网试搜
//
// ⚠️ 这个脚本会真的 import QQ Agent 的 src/，所以必须用宿主项目的目录当工作目录跑，
//    而且要有 electron 提供的 Node（宿主 package.json 是 "type":"module"）。
//    另外：必须在 QQ Agent 目录下用**相对路径**调用，因为用户目录常带单引号
//    （如 C:\Users\mu'geng），绝对路径当命令行参数会被截断。

const APP = process.env.QQ_AGENT_DIR || 'D:\\QQ-Agent-爆改版0.4'
const DIAGNOSE_ONLY = process.argv.includes('--diagnose')
const { pathToFileURL } = await import('node:url')
const path = await import('node:path')

const appUrl = (p) => pathToFileURL(path.join(APP, p)).href

console.log(`\n=== 在 QQ Agent 加载器里验证 pixiv-lookup ===`)
console.log(`宿主：${APP}`)

const { skillManager } = await import(appUrl('src/skills/manager.js'))
const loader = await import(appUrl('src/plugin-loader.js'))
const { listTools } = await import(appUrl('src/tool-registry.js'))

// ── --diagnose：只看状态（含断路器），不联网、不跑断言 ──
if (DIAGNOSE_ONLY) {
  await loader.loadPlugins({ log: () => {} })
  const mod = await import(appUrl('skills/pixiv-lookup/index.js'))
  const st = skillManager.status('pixiv-lookup')
  console.log(`\n技能状态：loaded=${st.loaded} enabled=${st.enabled} available=${st.available} active=${st.active}`)
  // ⚠️ 两个容易误读的地方，这里都说清楚：
  //   1) settingsView() 对 secret 字段一律显示 ******（**即使没填也是**），
  //      那是"给前端看的"。要看"技能实际读到什么"得用 settingsOf()。
  //   2) diagnose({}) 不传 context 时，它走的是框架默认值（不是用户配置），
  //      所以下面用 settingsOf() 的值构造一份配置再喂给它，避免两个数字对不上。
  const effective = skillManager.settingsOf('pixiv-lookup')
  console.log('\n技能实际生效的设置（settingsOf；cookie 只显示有没有填）：')
  for (const [k, v] of Object.entries(effective)) {
    console.log(`  ${k}: ${k === 'cookie' ? (String(v || '').trim() ? '（已设置，长度 ' + String(v).length + '）' : '（未填写）') : v}`)
  }
  console.log('\ndiagnose()（按上面的实际配置求值）：')
  for (const [k, v] of Object.entries(mod.diagnose({ config: { skills: { 'pixiv-lookup': effective } } }))) {
    console.log(`  ${k}: ${v}`)
  }
  console.log('\n提示：在「设置 → 扩展 → pixiv查图插件」里能开关与调这些值。')
  console.log('')
  process.exit(0)
}

let pass = 0
const fails = []
const ok = (n, c, extra = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}`) } else { fails.push(n + (extra ? ` — ${extra}` : '')); console.log(`  ❌ ${n}${extra ? ` — ${extra}` : ''}`) }
}

// ① 走真实的扫描 + 加载流程
const result = await loader.loadPlugins({ log: (m) => console.log('    [loader] ' + m) })
const loaded = (result.loaded || []).map((x) => x.id)
const failed = (result.failed || []).map((x) => x.id || x.error)
console.log(`\n扫描到：loaded=[${loaded.join(', ')}]  failed=[${failed.join(', ')}]`)
ok('加载器扫描到了 pixiv-lookup', loaded.includes('pixiv-lookup') || failed.includes('pixiv-lookup'))
ok('pixiv-lookup 加载没有报错', !failed.includes('pixiv-lookup'), String(failed))

// ② 状态四层
const st = skillManager.status('pixiv-lookup')
console.log('\n状态：' + JSON.stringify({
  loaded: st.loaded, enabled: st.enabled, available: st.available, active: st.active,
  code: st.code, reason: st.reason, kind: st.kind, dir: st.dir, loadError: st.loadError,
}, null, 1))
ok('清单被上游接受（loaded）', st.loaded === true, st.loadError)
ok('注册了 3 个工具', (st.toolIds || []).length === 3, JSON.stringify(st.toolIds))
ok('工具名带 pixiv-lookup__ 前缀且合法',
  (st.toolIds || []).every((t) => /^pixiv-lookup__[a-z0-9_-]+$/.test(t)), JSON.stringify(st.toolIds))
ok('清单声明的工具与注册的一致',
  JSON.stringify([...st.toolIds].sort()) === JSON.stringify(['pixiv-lookup__artwork', 'pixiv-lookup__ranking', 'pixiv-lookup__search']))
ok('cookie 字段被标为 secret（UI 会渲染成密码框）', st.configSchema?.cookie?.secret === true)
ok('configSchema 每个字段都有 label', Object.values(st.configSchema || {}).every((f) => f.label))
ok('没有声明能力（不依赖其它插件）', (st.capabilities || []).length === 0 && (st.requires || []).length === 0)

// ③ 开关状态：用户在设置里开没开
console.log(`\n开关：enabled=${st.enabled}  active=${st.active}`)
if (!st.enabled) {
  console.log('  ⚠️ 当前是关闭状态 —— 请在「设置 → 扩展 → pixiv查图插件」里打开，或调用')
  console.log('     POST /api/skills {"id":"pixiv-lookup","enabled":true}')
} else {
  ok('打开后处于 active（工具会进模型列表）', st.active === true, `${st.code} ${st.reason}`)
}

// ④ 工具确实在 tool-registry 里，且模型能看到的名字正确
const tools = listTools().filter((t) => t.skillId === 'pixiv-lookup')
console.log('\ntool-registry 里的 pixiv 工具：')
for (const t of tools) console.log(`  · ${t.id}  「${t.name}」 category=${t.category} skillId=${t.skillId}`)
ok('tool-registry 里有 3 个 pixiv 工具', tools.length === 3)
ok('每个工具都有 description 和 parameters',
  tools.every((t) => t.description && t.parameters && t.parameters.type === 'object'))

// ⑤ 就算开了、也没有外网时，execute 必须返回**可读的中文错误**而不是抛异常
if (st.enabled) {
  const search = tools.find((t) => t.id === 'pixiv-lookup__search')
  const r = await search.execute({ kind: 'private', chatId: 'test' }, { keyword: '初音ミク', limit: 2 })
  const text = String(r.content || '')
  console.log('\n真实联网调用一次（本机大概率连不上 pixiv.net，正好验证报错文案）：')
  console.log('  isError=' + r.isError)
  console.log(text.split('\n').map((l) => '  | ' + l).join('\n'))
  ok('execute 没有抛异常（返回了 {content}）', typeof r.content === 'string' && r.content.length > 0)
  ok('连不上时给的是中文可操作提示，而不是英文堆栈',
    !/at\s+\w+\s+\(|Error:.*fetch failed$/.test(text) || /代理|超时|Cookie|DNS|Pixiv/.test(text))
  ok('报错里没有泄漏 Cookie', !text.includes('PHPSESSID='))
}

console.log(`\n=== 结论：${pass} 项通过，${fails.length} 项失败 ===`)
for (const f of fails) console.log('  · ' + f)
process.exit(fails.length ? 1 : 0)
