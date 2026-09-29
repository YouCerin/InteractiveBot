/**
 * 表情包**导入**（离线）：把一个目录（或几个文件）收进表情库。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它做四件事，每一件都对应一类真实故障
 * ══════════════════════════════════════════════════════════════════════════
 * ① **按字节判类型**（不信扩展名）：`images.mjs` 的既有纪律 —— 把 HTML/压缩包
 *    当图存进去，后面打标签时会得到一堆"模型说这不是图"。
 * ② **内容哈希去重**：同一张图在群里会反复出现，重复入库 = 反复发同一张脸。
 * ③ **感知哈希近重复**（只对 PNG，理由见 `sticker-library.mjs`）：挡住重压缩/
 *    重导出的近似副本 —— 表情包群里这类特别多。**纯色图排除在判据之外**
 *    （aHash 对纯色退化，实测会误删真图）。
 * ④ **落待定区**：导入时**不打标签**（那是 `sticker-tag.mjs` 的事，它要花钱）。
 *    没有标签的图**不会被选中**，只会显示在库状态里 —— 这是刻意的：
 *    宁可让使用者看到"还有 40 张没打标签"，也不要让它们凭运气被发出去。
 *
 * 用法（在 packages/qq-bridge 下）：
 *   node src/index.mjs --stickers                          # 只看库的状态
 *   node src/index.mjs --stickers --import C:\my\stickers  # 导入一个目录
 *   node src/index.mjs --stickers --import a.png b.png --scope group-123456
 *   node src/index.mjs --stickers --prune [--apply]        # 清理"文件已不在"的僵尸条目
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import {
  GLOBAL_SCOPE,
  STICKER_DIR,
  fingerprintImage,
  importStickerFiles,
  labelCoverage,
  libraryHealth,
  pruneStickerEntries,
  readImageSize,
  readStickerDecisions,
  readStickerLibrary,
  stickerRoot,
  findMissingStickerFiles,
  findOrphanStickerFiles,
} from './sticker-library.mjs'
import { MIN_USABLE_PER_LABEL } from './sticker-labels.mjs'
// ★ 词表是**数据**：状态页、清单页与按标签导出都必须列**当前生效**的标签，
//   否则用户在标注台新建的标签在这些地方会凭空消失（图还在，只是看不见）。
import { activeLabelIds, activeLabelName, activeLabels } from './sticker-vocab.mjs'
import { stickerUsageSummary } from './sticker-quota.mjs'

/** 递归列出目录下的图片文件（按扩展名粗筛，真正的类型判断在导入时按字节做）。 */
export function listImageFiles(input) {
  const abs = resolve(input)
  if (!existsSync(abs)) return { files: [], missing: abs }
  const st = statSync(abs)
  if (st.isFile()) return { files: [abs], missing: null }
  const out = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      let s
      try {
        s = statSync(p)
      } catch {
        continue
      }
      if (s.isDirectory()) walk(p, depth + 1)
      else if (/\.(png|jpe?g|webp|gif)$/i.test(name)) out.push(p)
    }
  }
  walk(abs, 0)
  return { files: out, missing: null }
}

/**
 * 给一批文件算**感知哈希**（只有 PNG 算得出来）。
 *
 * 返回 `{ hashes, unfingerprinted }` —— 后者要**如实报给使用者**：
 * "这 N 张没能做近重复检测"（JPEG/WebP/GIF 或解不开的 PNG）。
 * 不报的话，使用者会以为去重是全量的。
 */
export function fingerprintBatch(files) {
  const hashes = {}
  const unfingerprinted = []
  for (const f of files) {
    let bytes
    try {
      bytes = readFileSync(f)
    } catch {
      continue
    }
    const r = fingerprintImage(bytes)
    if (r.ok) hashes[f] = r.hash
    else unfingerprinted.push({ file: f, why: r.why })
  }
  return { hashes, unfingerprinted }
}

/** 库状态报告（纯函数：给 index.mjs 的 `--stickers` 用）。 */
export function renderStickerStatus({ workspace, dir = 'stickers' } = {}, { checkOrphans = false } = {}) {
  const root = stickerRoot({ workspace, dir })
  const vocabOpts = { workspace, dir }
  const book = activeLabels(vocabOpts)
  const library = readStickerLibrary({ workspace, dir })
  const health = libraryHealth(library, { ids: book.map((l) => l.id) })
  const coverage = labelCoverage(library, book.map((l) => l.id))
  const pending = Object.keys(library.pending ?? {}).length
  const missing = findMissingStickerFiles({ workspace, dir })
  const usage = stickerUsageSummary({ workspace, dir }, Date.now()).filter((u) => u.today > 0 || u.lastSentAt)
  const decisions = readStickerDecisions({ workspace, dir }, 12)

  // ── 全局库 / 分会话库各自有多少可用图（0.2.4 补）──────────────────────
  //
  // ★ 为什么必须分开显示：**"主要用全局库"是合法且常见的用法**（导一次、所有会话都能用），
  //   而"我把图导哪去了"这个问题只能靠这两个数回答。只有一个总数时，
  //   使用者看到"可用 3 张"却不知道它们是全局的还是某个群的 ——
  //   于是"新群为什么不发"就变成了猜谜。
  const perScope = {}
  for (const entry of Object.values(library.entries)) {
    if (!entry.primary) continue
    if (entry.primaryConfidence != null && entry.primaryConfidence < 0.6) continue
    const scopeName = String(entry.file ?? '').split('/')[0] || '?'
    perScope[scopeName] = (perScope[scopeName] ?? 0) + 1
  }
  const globalCount = perScope[GLOBAL_SCOPE] ?? 0

  const lines = []
  lines.push('')
  lines.push(`表情库：${root}`)
  lines.push(
    `可用 ${health.total} 张` +
      `${pending ? `｜待定 ${pending} 张（认不出标签，**不会被选中**）` : ''}` +
      `${missing.length ? `｜僵尸条目 ${missing.length} 条（文件已不在，跑 --stickers --prune）` : ''}`,
  )
  // ★ 多余副本（磁盘上有、索引里没有、内容与已索引文件相同）：**只在这一条上按需查**
  //   —— 它要读遍全库算哈希（几百 MB 约几百毫秒），不该拖慢每次状态查询。
  //   但它是**看不见的磁盘占用**（所有统计都按索引算），所以必须有一条能看见它的路。
  if (checkOrphans) {
    const orph = findOrphanStickerFiles({ workspace, dir })
    if (orph.ok && orph.orphans.length) {
      lines.push(
        `  ⚠️ 磁盘上还有 ${orph.orphans.length} 个**多余副本**（${(orph.bytes / 1024 / 1024).toFixed(0)}MB）` +
          '：它们与库里已有的图逐字节相同，**索引里没有**所以不参与选图。',
      )
      lines.push('     清理：node src/index.mjs --stickers --prune-orphans --apply（不加 --apply 是预演）')
    }
  }
  if (health.total > 0) {
    const parts = Object.entries(perScope)
      .sort(([a], [b]) => (a === GLOBAL_SCOPE ? -1 : b === GLOBAL_SCOPE ? 1 : a.localeCompare(b)))
      .map(([s, n]) => `${s === GLOBAL_SCOPE ? '全局库' : s} ${n} 张`)
    lines.push(`  分布：${parts.join('｜')}`)
    lines.push(
      globalCount > 0
        ? '  ✓ 有全局库：所有会话都能用上它（某个会话自己也有图时，优先用它自己的 —— 群里人认得出的才像群里的人）'
        : '  ⚠️ **没有全局库**：每个会话只能用它自己那份 —— 新群在攒够自己的图之前一次都发不出来。' +
          '\n     想让所有会话共用一批图：node src/index.mjs --stickers --import <目录> --scope global',
    )
  }
  lines.push('')

  if (health.total === 0) {
    // ★ 这里必须分两种情况说 —— 第一版对"有图但都没打标签"也报"库里还没有可用的图，
    //   下一步：导入"。那会让使用者去重复导入同一批图（而它们已经在库里了），
    //   真正该做的是**打标签**。状态页的价值就在于它说的下一步是对的。
    if (pending > 0) {
      lines.push(`  ⚠️ 库里有 ${pending} 张图，但**都还没打标签** —— 所以一张都不会被选中（这是预期行为）。`)
      lines.push('     下一步：node src/sticker-tag.mjs            # 先预演，看模型给的标签对不对')
      lines.push('             node src/sticker-tag.mjs --apply    # 确认后再写回库')
    } else {
      lines.push('  ⚠️ 库里一张图都没有 —— 现在一次表情都不会发（这是预期行为，不是故障）。')
      lines.push('     下一步：node src/index.mjs --stickers --import <你的表情包目录>')
      lines.push('             然后 node src/sticker-tag.mjs --apply 给它们打标签。')
    }
  } else {
    lines.push('各标签可用图数（低于 3 张的标签不会出现在提示词里）：')
    for (const label of book) {
      const n = coverage[label.id] ?? 0
      if (n === 0) continue
      const flag = n < MIN_USABLE_PER_LABEL ? '  ⚠️ 图太少' : ''
      lines.push(`  ${label.name.padEnd(6)} ${String(n).padStart(3)}${flag}`)
    }
    const empty = book.filter((l) => (coverage[l.id] ?? 0) === 0).map((l) => l.name)
    if (empty.length) lines.push(`  没有图的标签：${empty.join('、')}（提示词里不会出现它们）`)
    if (health.monopoly) {
      lines.push(
        `  ⚠️ 「${activeLabelName(health.monopoly, { workspace, dir })}」占了全库 30% 以上 —— 容易反复发同一类脸，建议补充别的标签的图`,
      )
    }
  }

  if (usage.length) {
    lines.push('')
    lines.push('今天发过的会话：')
    for (const u of usage.slice(0, 10)) {
      lines.push(`  ${u.scope}：今天 ${u.today} 张${u.failures ? `｜失败冷却 ${u.failures} 次` : ''}`)
    }
  }

  if (decisions.length) {
    lines.push('')
    lines.push('最近的表情决策（最新在前；"不发"的原因就在这里）：')
    for (const d of decisions) {
      const when = String(d.at ?? '').replace('T', ' ').slice(5, 19)
      const who = d.action === 'send' ? `发 ${activeLabelName(d.label, { workspace, dir })}（${d.score} 分）` : '不发'
      lines.push(`  ${when} ${who}｜${String(d.reason ?? '').slice(0, 70)}`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

/** 导入（给 index.mjs 调用）：返回一句人话总结。
 *
 *  `scope` 默认 **`global`（全局库）** —— 这是刻意的默认：
 *  "导一次、所有会话都能用"是最省事也最常见的用法；要按群分库必须**显式**给 `--scope`，
 *  因为"我随手导进全局库"和"我把它塞给某个群"是两件后果不同的事（后者别的群用不到）。 */
export function runStickerImport({ workspace, dir = 'stickers', inputs = [], scope = GLOBAL_SCOPE } = {}) {
  const all = []
  for (const input of inputs) {
    const { files, missing } = listImageFiles(input)
    if (missing) return { ok: false, why: `路径不存在：${missing}` }
    all.push(...files)
  }
  if (!all.length) return { ok: false, why: '这个路径下没有找到图片（只看 png/jpg/jpeg/webp/gif）' }

  const { hashes, unfingerprinted } = fingerprintBatch(all)
  const r = importStickerFiles({ workspace, dir }, [{ scope, files: all, hashes, source: 'import' }])
  return { ok: true, result: r, unfingerprinted, scope, total: all.length }
}

/** 把导入结果渲染成人话。 */
export function renderImportResult(out) {
  if (!out.ok) return `❌ 导入失败：${out.why}`
  const r = out.result
  const lines = []
  lines.push('')
  lines.push(`导入范围：${out.scope}｜扫描到 ${out.total} 个文件`)
  lines.push(
    `新增 ${r.added} 张｜内容重复跳过 ${r.deduped} 张｜近似重复跳过 ${r.nearDuplicate} 张｜其它跳过 ${r.skipped.length - r.deduped - r.nearDuplicate} 张`,
  )
  if (out.unfingerprinted.length) {
    lines.push(
      `★ 其中 ${out.unfingerprinted.length} 张**没能做近重复检测**（${out.unfingerprinted[0].why}）—— ` +
        '它们只按内容哈希去重，近似副本可能重复入库。',
    )
  }
  const bad = r.skipped.filter((s) => !s.deduped && !s.nearDuplicate)
  if (bad.length) {
    lines.push('')
    lines.push('被跳过的（前 10 条）：')
    for (const s of bad.slice(0, 10)) lines.push(`  ${s.file}：${s.reason}`)
  }
  lines.push('')
  lines.push(`下一步：node src/sticker-tag.mjs --apply   # 给新导入的图打标签（要一次模型调用）`)
  lines.push('')
  return lines.join('\n')
}

/**
 * 列出库里的条目（**给人手工打标签用**）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须有这个列表（而不是让人直接翻 library.json）
 * ══════════════════════════════════════════════════════════════════════════
 * 库里的键是**内容哈希**（`global/7405d3613e866cfa.gif`），而人要改的是
 * "那一张笑的表情" —— 中间缺一个"能对上号"的东西。条目里的 `originName`
 * （原始文件名）就是那个东西，但它埋在几十条 JSON 里，靠人肉搜索不可行。
 *
 * 所以这个列表把"哪一条 == 哪张图"摆出来：短 id、原始文件名、当前标签、
 * 来源（模型/文件名/人工）、尺寸。**待定/没标签的排在前面**（那些才是要处理的）。
 *
 * @param {{ onlyPending?: boolean, limit?: number, workspace: string, dir?: string }} opts
 */
export function renderStickerList({ workspace, dir = STICKER_DIR } = {}, { onlyPending = false, limit = 200 } = {}) {
  const root = stickerRoot({ workspace, dir })
  const library = readStickerLibrary({ workspace, dir })
  let rows = Object.entries(library.entries).map(([rel, e]) => ({ rel, ...e }))
  if (onlyPending) rows = rows.filter((e) => !e.primary)
  // 待定的排前面（那些是要人动手的），其余按原文件名排（好找）
  rows.sort((a, b) => {
    const pa = a.primary ? 1 : 0
    const pb = b.primary ? 1 : 0
    if (pa !== pb) return pa - pb
    return String(a.originName ?? a.rel).localeCompare(String(b.originName ?? b.rel), 'zh')
  })
  const total = rows.length
  const shown = rows.slice(0, limit)

  const lines = []
  lines.push('')
  lines.push(`库里的条目（${total} 条${shown.length < total ? `，只显示前 ${shown.length} 条（--limit N 调整）` : ''}）`)
  lines.push('')
  lines.push('  短 id        标签（来源）           尺寸      原始文件名')
  lines.push('  ' + '─'.repeat(88))
  for (const e of shown) {
    const shortId = String(e.id ?? '').slice(0, 12)
    const label = e.primary ? `${activeLabelName(e.primary, { workspace, dir })}(${e.primary})` : '（没标签）'
    const src = e.primary ? `[${e.source ?? 'tag'}]` : ''
    let dim = ''
    try {
      dim = String(describeSize(join(root, e.rel)))
    } catch {
      dim = ''
    }
    lines.push(`  ${shortId.padEnd(13)} ${(label + ' ' + src).padEnd(24)} ${dim.padEnd(9)} ${e.originName ?? ''}`)
  }
  lines.push('')
  lines.push('  怎么改：编辑 library.json 里对应那条，把 primary 写成标签 id、')
  lines.push('          labels 写成 [主标签, ...次要]，并把 source 写成 "manual"。')
  lines.push('          ★ 写成 "manual" 之后**重打标签会跳过它**（不会被模型覆盖）。')
  lines.push('  可用标签：' + activeLabels({ workspace, dir }).map((l) => `${l.id}(${l.name})`).join('、'))
  lines.push('')
  return lines.join('\n')
}

/**
 * 看某一个（或几个）条目的**完整记录**（给人手工改标签用）。
 *
 * 与 `renderStickerList` 的分工：列表是"浏览与找 id"，这个是"把要改的那条
 * **原样印出来**"—— 手改 JSON 最容易错在形状（`labels` 忘了改、`source` 写错位置），
 * 所以直接给出可复制的完整对象。
 *
 * @param {string} keyword 原始文件名 / 短 id / 库内路径 的一部分（大小写不敏感）
 */
export function renderStickerEntry({ workspace, dir = STICKER_DIR } = {}, keyword) {
  const lib = readStickerLibrary({ workspace, dir })
  const needle = String(keyword ?? '').trim().toLowerCase()
  if (!needle) return '❌ 用法：node src/index.mjs --stickers --show <原始文件名的一部分|短id>\n'
  const hits = Object.entries(lib.entries).filter(([rel, e]) =>
    [rel, e.id, e.originName].some((v) => String(v ?? '').toLowerCase().includes(needle)),
  )
  const lines = ['']
  if (!hits.length) {
    lines.push(`没有匹配「${keyword}」的条目。先用 --stickers --list 看有哪些（原始文件名里带关键字）。`)
    lines.push('')
    return lines.join('\n')
  }
  lines.push(`匹配 ${hits.length} 条（关键词「${keyword}」）`)
  for (const [rel, e] of hits) {
    lines.push('')
    lines.push(`—— ${e.originName ?? rel} ｜ 短 id ${String(e.id ?? '').slice(0, 12)}`)
    lines.push('   把下面这段按你的判断改好，替换 library.json 里**同名键**的那一条：')
    lines.push('')
    lines.push(`  "${rel}": {`)
    lines.push(`    "id": "${e.id}",`)
    lines.push(`    "file": "${e.file}",`)
    lines.push(`    "mediaType": "${e.mediaType}",`)
    lines.push(`    "originName": ${JSON.stringify(e.originName ?? '')},`)
    lines.push(`    "primary": "${e.primary ?? '<标签 id>'}",            ← 主标签（必须是词表里的 id）`)
    lines.push(`    "labels": ${JSON.stringify(e.labels ?? [])},   ← 次要标签可以留空数组`)
    lines.push(`    "primaryConfidence": ${e.primaryConfidence ?? 1},`)
    lines.push(`    "source": "manual"                        ← ★ 写成 manual：重打标签时会跳过它`)
    lines.push('  }')
  }
  lines.push('')
  lines.push('  可用标签：' + activeLabels({ workspace, dir }).map((l) => `${l.id}(${l.name})`).join('、'))
  lines.push('  改完**不用重启**，下一轮对话就生效（判定与提示词都是每轮现读库文件）。')
  lines.push('')
  return lines.join('\n')
}

/** 一行尺寸（读文件头；读不到就空着，**不猜**）。 */
function describeSize(abs) {
  try {
    const size = readImageSize(readFileSync(abs))
    return size ? `${size.width}×${size.height}` : ''
  } catch {
    return ''
  }
}

/** 清理僵尸条目（默认预演）。 */
export function runStickerPrune({ workspace, dir = 'stickers', apply = false } = {}) {
  const missing = findMissingStickerFiles({ workspace, dir })
  if (!missing.length) return { ok: true, removed: [], applied: apply, nothing: true }
  const r = pruneStickerEntries({ workspace, dir }, { files: missing, apply })
  return { ok: true, removed: r.removed, applied: r.applied, nothing: false }
}

/**
 * 清理库里**没有索引指向的多余副本**（默认预演）。
 *
 * 与 `runStickerPrune` 是**相反方向**的两件事，别混：
 *   · `runStickerPrune`：索引里有、磁盘上没有 → 删**索引条目**（僵尸条目）；
 *   · 本函数：磁盘上有、索引里没有、**且内容与某个已索引文件逐字节相同**
 *     → 删**文件**（多余副本）。
 *
 * 为什么要单列一条：这是导入去重留下的垃圾（详见 `findOrphanStickerFiles`），
 * 实测能占掉全库一半磁盘，而所有界面统计都按索引算，**根本看不见它**。
 * 默认预演 —— 看着那串数字再决定 `--apply`。
 */
export function runStickerOrphanPrune({ workspace, dir = 'stickers', apply = false } = {}) {
  return findOrphanStickerFiles({ workspace, dir }, { apply })
}

/** 把"多余副本"的核对结果渲染成人话。 */
export function renderOrphanResult(r, { apply = false } = {}) {
  if (!r.ok) return `❌ 核对失败：${r.why}`
  const mb = (r.bytes / 1024 / 1024).toFixed(1)
  const lines = []
  lines.push('')
  if (!r.orphans.length) {
    lines.push('✓ 库里没有多余副本（磁盘上的图片都被索引指向着）')
    lines.push('')
    return lines.join('\n')
  }
  lines.push(`发现 ${r.orphans.length} 个**没有索引指向的多余副本**，共 ${mb}MB：`)
  for (const o of r.orphans.slice(0, 12)) {
    lines.push(`  ${o.rel}  → 与 ${o.twin} 逐字节相同`)
  }
  if (r.orphans.length > 12) lines.push(`  …… 还有 ${r.orphans.length - 12} 个`)
  lines.push('')
  if (apply) {
    lines.push(`已收掉 ${r.removed} 个（腾出约 ${mb}MB）${r.removed < r.orphans.length ? `；${r.orphans.length - r.removed} 个删不掉，下次再收` : ''}`)
  } else {
    lines.push('这是**预演**，没有删任何文件。')
    lines.push('★ 它们与库里已有的图**逐字节相同**（内容哈希判的），删掉不影响选图。')
    lines.push('真清理：node src/index.mjs --stickers --prune-orphans --apply')
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * 把库**按标签**整理成一份"看得懂"的目录（离线、只读源库）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（库的存储布局不是给人看的）
 * ══════════════════════════════════════════════════════════════════════════
 * 库里的图是**内容寻址 + 按会话分目录**的，文件名是哈希：
 *
 *     stickers/group-700000001/4ce14e480d205f52.png
 *
 * 这套布局是给机器用的（同一张图只存一份、跨会话不串、去重天然成立），
 * 但人想"看看我这库里都是些什么表情"时完全读不出来。所以给一个导出：
 *
 *     stickers-by-tag/laugh/笑死__4ce14e480d205f52.png
 *     stickers-by-tag/confused/疑惑__8f60130fb0216b98.png
 *
 * ★ 三条纪律：
 *   ① **只读源库**：不删、不改、不移动原文件 —— 整理是"另存一份视图"；
 *   ② **只导出可用的**（有主标签、置信度够）：待定区的图单独放 `_pending/`，
 *      免得人以为它们已经在参与选图了；
 *   ③ **文件名带主标签中文名**：`笑死__<哈希>.png` 而不是裸哈希 ——
 *      要让人在资源管理器里一眼看出这张图是干什么用的。
 *
 * ⚠️ 默认**复制**（不依赖任何系统权限）。`link: true` 改用符号链接（省磁盘），
 *    但 Windows 上建符号链接需要"开发者模式"或管理员权限 ——
 *    失败时**如实回落成复制**并说明，不静默。
 *
 * @returns {{ ok: boolean, why?: string, dir?: string, byTag?: Record<string,string[]>, pending?: string[], copied?: number, linked?: number, failed?: Array<{file:string,why:string}> }}
 */
export function exportStickersByTag(
  { workspace, dir = 'stickers' } = {},
  { outDir = 'stickers-by-tag', link = false, apply = false } = {},
) {
  const root = stickerRoot({ workspace, dir })
  if (!root) return { ok: false, why: '没有工作区，读不到表情库' }
  const target = resolve(workspace, outDir)
  // ★ 导出目录必须在工作区**里面**，而且不能就是工作区本身 ——
  //   因为它下一次导出会被"清掉自己生成的内容"，让一个能指到工作区根或外面的
  //   参数走这条路等于给了人一个 `--out ..` 就删库的机会。所以先挡住。
  const wsAbs = resolve(workspace)
  if (target === wsAbs || !target.startsWith(wsAbs + sep)) {
    return { ok: false, why: `导出目录必须在工作区内、且不能是工作区本身（收到的是 ${target}）` }
  }
  if (target === root || target.startsWith(root + sep)) {
    return { ok: false, why: '导出目录不能放在表情库里面（会把库自己搞乱）' }
  }
  const library = readStickerLibrary({ workspace, dir })
  const byTag = {}
  const pending = []
  const failed = []
  let copied = 0
  let linked = 0

  for (const [rel, entry] of Object.entries(library.entries)) {
    const src = join(root, rel)
    if (!existsSync(src)) {
      failed.push({ file: rel, why: '文件不在磁盘上（跑 --stickers --prune 核对）' })
      continue
    }
    const usable = Boolean(entry.primary) && !(entry.primaryConfidence != null && entry.primaryConfidence < 0.6)
    const tagDir = usable ? entry.primary : '_pending'
    const ext = String(rel).split('.').pop()
    const safeName = usable
      ? `${activeLabelName(entry.primary, { workspace, dir })}__${String(entry.id ?? rel).slice(0, 16)}.${ext}`
      : `${String(entry.id ?? rel).slice(0, 16)}.${ext}`
    if (usable) byTag[tagDir] = [...(byTag[tagDir] ?? []), safeName]
    else pending.push(safeName)
  }

  // ── 先清掉**上一次导出留下的内容**（这是修的一个真缺陷，不是洁癖）──────
  //
  // 第一版只会往里写、从不清理。后果是改过标签或删过图之后，视图里会留着
  // 过期的文件（比如某张图从 `laugh` 改成了 `confused`，旧位置那张还在）——
  // 而这份目录是**给人看的**，看到假数据比看不到更糟：人会据此以为库里还有那张图。
  //
  // ★ 只删"我们自己生成的"：文件名含 `__`（`笑死__<哈希>.png`）或者整目录、
  //   图片类型的文件；`_pending` 整个清掉；**文档与非图片文件一律不动**。
  //
  // ★★ 必须用 `unlinkSync` + **删完再验一遍**（这是本项目第三次踩同一个坑）：
  //   `rmSync(p, { force: true })` 在 Windows 上**会静默不删也不抛**——
  //   实测：`rmSync` 之后 `existsSync` 仍然是 true，而我的 `removed` 已经记了一笔，
  //   于是报告里说"已清掉 3 个过期文件"、磁盘上一个都没少（**假报告**）。
  //   `images.mjs:491` 的注释早写着这条（"实测在 Windows 上 rmSync 删单个文件会静默失败"），
  //   `memory-files.mjs` 也踩过。所以这里：unlink → existsSync 复查 → 只有真没了才算数。
  const removed = []
  const staleFailed = []
  if (apply && existsSync(target)) {
    let names = []
    try {
      names = readdirSync(target, { withFileTypes: true })
    } catch {
      names = []
    }
    for (const e of names) {
      if (!e.isDirectory()) continue
      const sub = join(target, e.name)
      let files = []
      try {
        files = readdirSync(sub).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
      } catch {
        continue
      }
      for (const f of files) {
        // ★ 兜一层：只删"看起来是我们生成的"或"待定目录里的图"。
        //   手工放进去的图（名字里没有 `__`）在普通标签目录里**不删** ——
        //   宁可留一个过期文件，也不删别人手动放的东西。
        const ours = f.includes('__') || e.name === '_pending'
        if (!ours) continue
        const abs = join(sub, f)
        try {
          unlinkSync(abs) // ★ 不用 rmSync（见上面那段：Windows 上会静默失败）
        } catch {
          /* 下面统一复查 */
        }
        if (existsSync(abs)) staleFailed.push(`${e.name}/${f}`)
        else removed.push(`${e.name}/${f}`)
      }
      // 目录空了就删掉（改过标签之后旧目录会空着，留着会让人以为"这个标签还有货"）
      try {
        if (readdirSync(sub).length === 0) rmdirSync(sub)
      } catch {
        /* 目录非空或删不掉：留着不影响正确性 */
      }
    }
  }

  for (const [rel, entry] of Object.entries(library.entries)) {
    const src = join(root, rel)
    if (!existsSync(src)) continue
    const usable = Boolean(entry.primary) && !(entry.primaryConfidence != null && entry.primaryConfidence < 0.6)
    const tagDir = usable ? entry.primary : '_pending'
    const ext = String(rel).split('.').pop()
    const safeName = usable
      ? `${activeLabelName(entry.primary, { workspace, dir })}__${String(entry.id ?? rel).slice(0, 16)}.${ext}`
      : `${String(entry.id ?? rel).slice(0, 16)}.${ext}`
    const destDir = join(target, tagDir)
    if (!apply) continue
    try {
      mkdirSync(destDir, { recursive: true })
      const dest = join(destDir, safeName)
      let usedLink = false
      if (link) {
        try {
          symlinkSync(src, dest)
          usedLink = true
          linked += 1
        } catch {
          // ★ 不静默：Windows 上没开开发者模式时就是这么失败的 —— 回落成复制
          usedLink = false
        }
      }
      if (!usedLink) {
        copyFileSync(src, dest)
        copied += 1
      }
    } catch (error) {
      failed.push({ file: rel, why: `导出失败：${error?.message ?? error}` })
    }
  }

  return { ok: true, dir: target, byTag, pending, copied, linked, removed, staleFailed, failed, apply: Boolean(apply) }
}

/**
 * 把导出结果渲染成人话。
 *
 * @param {{ workspace?: string, dir?: string, outDir?: string }} [opts]
 *   ★ 需要 `workspace`/`dir` 才能把标签 id 翻成**当前生效词表**里的中文名
 *     （用户可能已经把某个标签改名了）。
 */
export function renderExportResult(out, { outDir = 'stickers-by-tag', workspace, dir = STICKER_DIR } = {}) {
  if (!out.ok) return `❌ 导出失败：${out.why}`
  const vocabOpts = workspace ? { workspace, dir } : {}
  const lines = []
  const tags = Object.keys(out.byTag).sort()
  lines.push('')
  lines.push(`按标签整理：${out.dir}`)
  lines.push(`将导出 ${tags.reduce((s, t) => s + out.byTag[t].length, 0)} 张可用图，分在 ${tags.length} 个标签目录里：`)
  for (const t of tags) lines.push(`  ${t}/  ${out.byTag[t].length} 张（${activeLabelName(t, vocabOpts)}）`)
  if (out.pending.length) {
    lines.push(`  _pending/  ${out.pending.length} 张（还没打标签 / 置信度低 —— **不参与选图**）`)
  }
  if (out.apply) {
    lines.push('')
    lines.push(
      out.linked > 0
        ? `已写入：符号链接 ${out.linked} 个${out.copied ? `、复制 ${out.copied} 个` : ''}（源库未被改动）`
        : `已复制 ${out.copied} 个文件（源库未被改动）`,
    )
    if (out.linked === 0 && out.copied > 0) {
      lines.push('  ⚠️ 用了复制（没建成符号链接）—— Windows 上建符号链接需要"开发者模式"或管理员权限。')
    }
  } else {
    lines.push('')
    lines.push(`预演（没有写任何文件）。真导出：node src/index.mjs --stickers --export-tags --apply`)
    lines.push(`想省磁盘可以加 --link（符号链接），但那需要系统权限。`)
  }
  if (out.removed?.length) {
    lines.push('')
    lines.push(`清掉了上一次导出的 ${out.removed.length} 个过期文件（改了标签或删了图之后，旧文件留着会让人以为库里还有）`)
  }
  if (out.staleFailed?.length) {
    lines.push('')
    lines.push(`⚠️ 有 ${out.staleFailed.length} 个过期文件**没能删掉**（多半是被资源管理器/看图软件占用）：`)
    for (const f of out.staleFailed.slice(0, 5)) lines.push(`  ${f}`)
    lines.push('  这些文件已经不属于任何标签了，但还留在视图里 —— 关掉占用它的程序后重跑一次即可。')
  }
  if (out.failed.length) {
    lines.push('')
    lines.push(`有 ${out.failed.length} 张没能导出（前 5 条）：`)
    for (const f of out.failed.slice(0, 5)) lines.push(`  ${f.file}：${f.why}`)
  }
  lines.push('')
  lines.push('  ★ 这份目录是**视图**，不是库本身：删掉它不影响发表情；改标签请改库（贴标签 → 重跑导出）。')
  lines.push('  ★ 标签的**唯一真相**是库里的 library.json：在这里改名/挪目录不会影响它，重跑导出就会被覆盖。')
  lines.push('')
  return lines.join('\n')
}
