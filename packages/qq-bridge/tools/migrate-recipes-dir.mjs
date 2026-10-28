/**
 * 把配方从旧位置 `memory/recipes/` 搬到新位置 `recipes/`（0.3.3）。
 *
 * ```bash
 * node tools/migrate-recipes-dir.mjs            # 先看会搬什么（默认 dry-run）
 * node tools/migrate-recipes-dir.mjs --apply    # 真的搬
 * ```
 *
 * ★ 三条纪律（与 `memory-store` 的旧布局迁移同一条）：
 *   1. **只搬不删**：目标已存在同名文件 ⇒ **跳过并报出来**（不覆盖，可能是新版本）；
 *   2. **幂等**：搬完之后再跑一次什么都不做；
 *   3. **搬空才删旧目录**：里面还有没搬走的文件（同名冲突/坏文件）就留着，并如实说。
 *
 * ⚠️ 即使不跑这个脚本，代码也会读旧目录（`LEGACY_RECIPE_DIR`）—— 搬家是为了整洁，
 *   不是为了让配方能用。这一点写在这里，免得下一个人以为"不搬就会丢"。
 */

import { existsSync, mkdirSync, readdirSync, renameSync, readFileSync, rmdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { LEGACY_RECIPE_DIR, RECIPE_DIR } from '../src/recipes.mjs'
import { PKG_ROOT } from '../src/local.mjs'
import { normalizeConfig } from '../src/config.mjs'

const apply = process.argv.includes('--apply')
// ★ 自己读 config.json：`index.mjs` 里的 `loadConfig()` 是**文件内私有**的（故意不导出），
//   工具的依赖尽量少（与其它 tools 一致）。
const cfgPath = join(PKG_ROOT, 'config.json')
if (!existsSync(cfgPath)) {
  console.error(`❌ 找不到 ${cfgPath}（配方在哪个工作区要看 dsh.workspace）`)
  process.exit(1)
}
const config = normalizeConfig(JSON.parse(readFileSync(cfgPath, 'utf8')))
const workspace = config.dsh?.workspace
if (!workspace) {
  console.error('❌ 配置里没有 dsh.workspace')
  process.exit(1)
}
// ★ `normalizeConfig` 会把 `dsh.workspace` 解析成**绝对路径**，所以这里不能再 join 包根
//   （第一版这么写，结果算出 `...\packages\qq-bridge\C:\...` 这种路径，报"没有旧目录"）。
const root = isAbsolute(String(workspace)) ? String(workspace) : join(PKG_ROOT, String(workspace))
const from = join(root, LEGACY_RECIPE_DIR)
const to = join(root, RECIPE_DIR)

if (!existsSync(from)) {
  console.log(`没有旧目录（${LEGACY_RECIPE_DIR}）—— 不需要搬家。`)
  process.exit(0)
}

const files = readdirSync(from).filter((f) => f.endsWith('.json'))
if (!files.length) {
  console.log('旧目录里没有 json 文件。')
} else if (!apply) {
  console.log(`将搬 ${files.length} 个配方：${LEGACY_RECIPE_DIR} → ${RECIPE_DIR}`)
  console.log(`  目标已存在的会被**跳过**（不覆盖）：${existsSync(to) ? '（新目录已存在，逐个比对）' : '（新目录还不存在）'}`)
} else {
  mkdirSync(to, { recursive: true })
  let moved = 0
  const skipped = []
  for (const f of files) {
    const src = join(from, f)
    const dst = join(to, f)
    if (existsSync(dst)) {
      skipped.push(`${f}（目标已存在）`)
      continue
    }
    renameSync(src, dst)
    moved += 1
  }
  console.log(`✅ 搬了 ${moved} 个配方到 ${RECIPE_DIR}/`)
  if (skipped.length) console.log(`⚠️ 跳过 ${skipped.length} 个：${skipped.join('、')}`)
  const left = readdirSync(from)
  if (left.length === 0) {
    try {
      // 只删**空目录**：里面还有东西就留着（可能是别人手工放的文件）
      rmdirSync(from)
      console.log(`旧目录已空，删除 ${LEGACY_RECIPE_DIR}/`)
    } catch {
      console.log(`旧目录已空但删不掉（无害）：${LEGACY_RECIPE_DIR}/`)
    }
  } else {
    console.log(`旧目录还剩 ${left.length} 项（未删）：${left.slice(0, 5).join('、')}`)
  }
}
