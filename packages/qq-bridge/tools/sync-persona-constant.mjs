/**
 * 一次性工具：把 `personas/小鲸鱼（完整带情绪）.md` 的正文重新生成为
 * `src/persona.mjs` 里 `FACTORY_PERSONA` 常量的字面量。
 *
 * 为什么要有这个工具（2026-10-02 的教训，别再用 PowerShell 拼这段）：
 *   `FACTORY_PERSONA` 是一行 4900+ 字的 JS 字符串字面量，里面**含 `\"` 转义**。
 *   把它塞进 `node -e "…"` 或 PowerShell 的双引号里，转义层数会把人绕死，
 *   而且出错时可能**静默什么都不写**（实测踩过）。所以落成脚本文件跑。
 *
 * 用法：node tools/sync-persona-constant.mjs [--check]
 *   --check 只比对，不写（给"确认常量没漂"用）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SRC = join(PKG_ROOT, 'src', 'persona.mjs')
const PERSONA = join(PKG_ROOT, 'personas', '小鲸鱼（完整带情绪）.md')

const text = readFileSync(PERSONA, 'utf8').trimEnd()
const lines = readFileSync(SRC, 'utf8').split('\n')
const at = lines.findIndex((l) => l.startsWith('const FACTORY_PERSONA'))
if (at < 0) {
  console.error('❌ 没找到 `const FACTORY_PERSONA` 那一行 —— 常量改名了吗？')
  process.exit(1)
}

// ★ 字面量长度必须**规规矩矩从文件正文重算**，不许手抄。
const next = `const FACTORY_PERSONA = ${JSON.stringify(text)}`
const changed = lines[at] !== next
if (process.argv.includes('--check')) {
  console.log(changed ? '⚠️ 常量与文件**不一致**（跑一次不带 --check 的同步）' : `✅ 常量与文件逐字一致（${text.length} 字）`)
  process.exit(changed ? 1 : 0)
}
if (!changed) {
  console.log(`✅ 已经一致，什么都没改（${text.length} 字）`)
  process.exit(0)
}
lines[at] = next
writeFileSync(SRC, lines.join('\n'), 'utf8')

// ★ 复核：不信任"写没报错"就等于"写进去了"（本项目反复踩的一条）。
const back = readFileSync(SRC, 'utf8').split('\n')[at]
if (back !== next) {
  console.error('❌ 写回之后复核失败：文件里的那一行与期望不一致')
  process.exit(1)
}
console.log(`✅ 已同步 FACTORY_PERSONA（${text.length} 字 / 第 ${at + 1} 行）`)
