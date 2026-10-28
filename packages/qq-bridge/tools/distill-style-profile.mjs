/**
 * 把**人工判成"可用"**的样本蒸馏成画像 + 样本块（0.3.3 · P3 的可执行入口）。
 *
 * ```bash
 * node tools/distill-style-profile.mjs                 # 读评审结果，写 profile.md / profile.json
 * node tools/distill-style-profile.mjs --max-samples 40
 * node tools/distill-style-profile.mjs --dry           # 只打统计
 * ```
 *
 * ── 数据从哪来 ──────────────────────────────────────────────────────────────
 *   · `workspace-qq/store/style/candidates.jsonl` —— P1 的候选池（含上下文）
 *   · `workspace-qq/runtime/chat-review/`        —— P2 的人工判定（`good` 才算可用）
 * 两者按条目 id（内容哈希）对齐 —— 所以**池子重新生成过也不会把判定挂错句子**。
 *
 * ── 产物（都在工作区，含聊天原文）──────────────────────────────────────────
 *   · `store/style/profile.md`   给人看的画像（每行都带 n=）
 *   · `store/style/profile.json` 给程序读的（统计 + 样本块的行）
 *
 * ⚠️ **判定不全就不产出**：有人没判（`unjudged > 0`）时直接退出并说清剩几条 ——
 *    拿"判了一半"的数据蒸馏出来的画像，比没有画像更糟（它会让人以为语感已经学过了）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { analyzeStyle, pickSamples, renderProfileMarkdown, STYLE_PROFILE_VERSION, styleSampleId } from '../src/style-profile.mjs'

const PKG_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const WORKSPACE = join(PKG_ROOT, 'workspace-qq')
const STYLE_DIR = join(WORKSPACE, 'store', 'style')
const CANDIDATES = join(STYLE_DIR, 'candidates.jsonl')
const REVIEW_DIR = join(WORKSPACE, 'runtime', 'chat-review')
const BATCH_ID = '语感样本'

function argOf(flag, fallback = '') {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? String(process.argv[i + 1] ?? '') : fallback
}
const maxSamples = Math.max(0, Math.min(200, Number(argOf('--max-samples', '60')) || 60))
const dry = process.argv.includes('--dry')

const readJson = (p, fallback = null) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

if (!existsSync(CANDIDATES)) {
  console.error(`❌ 没有候选池：${CANDIDATES}\n   先跑 node tools/build-style-corpus.mjs`)
  process.exit(1)
}

// ── 读候选池与判定 ───────────────────────────────────────────────────────────
const samples = readFileSync(CANDIDATES, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  })
  .filter((x) => x && String(x.text ?? '').trim())

const batch = readJson(join(REVIEW_DIR, 'batches', `${BATCH_ID}.json`))
const scores = readJson(join(REVIEW_DIR, 'scores.json'), { scores: {} })
if (!batch?.items?.length) {
  console.error(`❌ 评审台里没有「${BATCH_ID}」这一批。先在评审台导入候选池并逐条判。`)
  process.exit(1)
}
const verdictById = new Map()
for (const it of batch.items) {
  const s = scores?.scores?.[it.id]
  if (s?.verdict) verdictById.set(it.id, s.verdict)
}

// ★ 候选池与批次按 id 对齐（评审台的条目 id 就是 `styleSampleId`），池子里没有的判定自然会掉
const idOf = (s) => styleSampleId({ chatKey: s.chatKey, sender: s.sender, text: s.text })
const judged = samples.filter((s) => verdictById.has(idOf(s)))
const unjudged = samples.filter((s) => !verdictById.has(idOf(s)))
const good = judged.filter((s) => verdictById.get(idOf(s)) === 'good')

console.log(`候选池 ${samples.length} 条 · 已判 ${judged.length} · 未判 ${unjudged.length} · 判成"可用" ${good.length}`)
if (unjudged.length > 0) {
  console.error(`\n❌ 还有 ${unjudged.length} 条没判 —— 不拿"判了一半"的数据蒸馏（先判完再跑）。`)
  console.error('   在评审台 → 打分页 → 批次「语感样本」→ 过滤「未评」。')
  process.exit(1)
}
if (good.length === 0) {
  console.error('\n❌ 一条"可用"都没有，画像没有素材（不许凭空写）。')
  process.exit(1)
}

// ── 算统计 + 渲染 ────────────────────────────────────────────────────────────
const analyzed = analyzeStyle(good)
if (!analyzed.ok) {
  console.error(`❌ ${analyzed.why}`)
  process.exit(1)
}
const sampleLines = pickSamples(good, { max: maxSamples })
const groupsNote = `样本来自 ${Object.keys(analyzed.stats.byGroup).length} 个群`
const markdown = renderProfileMarkdown({
  stats: analyzed.stats,
  generatedAt: new Date().toISOString(),
  groupsNote,
})

console.log('\n── 画像要点 ──')
console.log(markdown.split('\n').filter((l) => /^- /.test(l)).slice(0, 14).join('\n'))
console.log(`\n── 样本块：${sampleLines.length} 条（上限 ${maxSamples}）──`)
for (const t of sampleLines.slice(0, 8)) console.log(`  · ${t}`)

if (dry) {
  console.log('\n（--dry：不写文件）')
  process.exit(0)
}

mkdirSync(STYLE_DIR, { recursive: true })
const mdPath = join(STYLE_DIR, 'profile.md')
const jsonPath = join(STYLE_DIR, 'profile.json')
writeFileSync(mdPath, markdown, 'utf8')
writeFileSync(
  jsonPath,
  `${JSON.stringify({
    version: STYLE_PROFILE_VERSION,
    generatedAt: new Date().toISOString(),
    batch: BATCH_ID,
    judged: judged.length,
    good: good.length,
    rejected: judged.length - good.length,
    stats: analyzed.stats,
    /** ★ 进提示词的那几条（已过注入筛 + `@QQ` 已脱敏） */
    sampleLines,
  }, null, 2)}\n`,
  'utf8',
)
console.log(`\n✅ 画像：${mdPath}`)
console.log(`✅ 机器可读：${jsonPath}`)
console.log('   注意：这两个文件含聊天原文，**只留在工作区**。')
