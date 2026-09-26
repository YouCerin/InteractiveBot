#!/usr/bin/env node
/**
 * 扩展（技能 / 插件）离线探针（0.2.2，不是测试）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它回答的问题（为什么不能只靠测试）
 * ══════════════════════════════════════════════════════════════════════════
 * 测试断言的是"代码符合契约"；这个探针回答的是**"我装的这个技能，此刻到底行不行"**：
 *   · 清单读出来了吗？告警有哪些？
 *   · 入口能 import 吗？`setup()` 注册了几个工具？名字（模型看到的那个）是什么？
 *   · 开关打开时，提示词里**到底会多出什么字**（含工具名对不对）？
 *   · 插件那一栏现在几个开、几个关、哪些"要重启才生效"？
 *
 * 用法：
 *   node mocks/probe-extensions.mjs                  # 用包内 config.json
 *   node mocks/probe-extensions.mjs --enable pixiv-lookup   # 假装它是开着的（只看提示词，不写盘）
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PKG_ROOT, DIRS } from '../src/local.mjs'
import { normalizeConfig } from '../src/config.mjs'
import { discoverSkills, loadSkill, describeSkill, collectSkillPromptSections } from '../src/extensions.mjs'
import { listPlugins } from '../src/plugins.mjs'

const enableId = process.argv.includes('--enable') ? String(process.argv[process.argv.indexOf('--enable') + 1] ?? '') : ''

const raw = JSON.parse(readFileSync(join(PKG_ROOT, 'config.json'), 'utf8'))
const config = normalizeConfig(raw)
if (enableId) {
  config.skills = { ...(config.skills ?? {}), [enableId]: { ...(config.skills?.[enableId] ?? {}), enabled: true } }
}

console.log(`技能目录：${DIRS.skills}`)
const scan = discoverSkills({ skillsDir: DIRS.skills })
console.log(`发现 ${scan.skills.length} 个技能\n`)

let bad = 0
for (const skill of scan.skills) {
  console.log(`── ${skill.icon} ${skill.name}（${skill.id} v${skill.version}）──`)
  if (skill.errors.length) {
    bad += 1
    for (const e of skill.errors) console.log(`  ❌ ${e}`)
  }
  for (const w of skill.warnings) console.log(`  ⚠️ ${w}`)
  if (skill.ok) {
    // ★ 用一个真的收集器：探针要看的就是"setup 到底注册了哪些工具、名字对不对"。
    //   （桥接主进程那侧是用**空实现**装的 —— 它只要提示词片段，工具在 MCP 子进程里注册。）
    const collected = []
    await loadSkill(skill, { config, log: (m) => console.log(`  ${m}`), registerTool: (t) => collected.push(t) })
    skill.runtimeTools = collected
    if (!skill.loaded) {
      bad += 1
      console.log(`  ❌ 装载失败：${skill.loadError}`)
    } else {
      console.log(`  ✅ 装载成功，注册了 ${skill.runtimeTools.length} 个工具：`)
      for (const t of skill.runtimeTools) {
        console.log(`     · ${t.fullName}  [${t.permission}]  ${t.name}`)
      }
      console.log(`  available()：${skill.available?.ok ? '可用' : `不可用 —— ${skill.available?.reason}`}`)
    }
  }
  const card = describeSkill(skill, config)
  console.log(`  卡片：启用=${card.enabled} 就绪=${card.ready}${card.reasons.length ? ` 原因=${card.reasons.join('；')}` : ''}`)
  const { lines } = collectSkillPromptSections({ skills: [skill], config, log: (m) => console.log(`  ${m}`) })
  console.log(`  提示词片段：${lines.length} 条${lines.length ? `（${lines.map((l) => `${l.title} ${l.content.length} 字`).join('、')}）` : ''}`)
  for (const l of lines) {
    console.log(`  ── 片段全文（模型会看到这段）────────────────`)
    console.log(
      l.content
        .split('\n')
        .map((x) => `     ${x}`)
        .join('\n'),
    )
  }
  console.log('')
}

console.log('── 内置插件 ──')
for (const p of listPlugins({ config })) {
  const state = p.enabled === null ? '—（名单类，没有开关）' : p.enabled ? '开' : '关'
  console.log(`  ${p.icon} ${p.name}：${state}${p.switchKind === 'list' ? '' : p.hot ? '（即时生效）' : '（★ 要重启才生效）'}  ${p.enabledPath}`)
}

console.log('')
console.log(bad === 0 ? '✅ 技能都能装载' : `❌ 有 ${bad} 个技能装不上`)
process.exitCode = bad === 0 ? 0 : 1
