/**
 * 表情包**打标签**（命令行入口；控制台「扩展 → 表情包」卡片上还有一个按钮走同一份引擎）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么"打标签"必须是离线一次性的（这是整个功能能成立的前提）
 * ══════════════════════════════════════════════════════════════════════════
 * 运行期**一次模型调用都不能加**：
 *   · `images.mjs:29` 已经说明过理由 —— QQ 里大量是表情包，每张都过一遍视觉
 *     等于每轮都花 vision token，而且图片会留在会话历史里、后续每轮重复计费。
 *   · 所以选图必须是**本地计算**（`sticker-decision.mjs`），而本地计算需要标签；
 *     标签只能在导入时算一次、**永久复用**。
 *
 * ── 本文件的存在理由（为什么不把逻辑写在这里）────────────────────────────
 * 打标签现在有**两个入口**（本 CLI 与界面按钮），所以引擎在
 * `src/sticker-tagging.mjs`：提示词、解析、熔断、跳过人工标签只有一份实现。
 * 这个文件只负责"命令行怎么收参数、怎么把进度打到终端"。
 *
 * 用法（在 packages/qq-bridge 下）：
 *   node src/sticker-tag.mjs                    # 预演：只处理待定条目，不写回
 *   node src/sticker-tag.mjs --from-filename    # **零模型调用**：先用原文件名猜一遍标签
 *   node src/sticker-tag.mjs --apply            # 真写回库
 *   node src/sticker-tag.mjs --all --apply      # **重打所有**（含已打好的；人工改过的仍跳过）
 *   node src/sticker-tag.mjs --all --force --apply   # 连人工改过的一起重打
 *   node src/sticker-tag.mjs --limit 20 --apply # 只处理前 20 张
 *   node src/sticker-tag.mjs --sample 30        # 抽检：随机 30 张单独跑，给你人工核准确率
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { normalizeConfig } from './config.mjs'
import { resolveDirectTarget } from './model-direct.mjs'
import { PKG_ROOT } from './local.mjs'
import { applyStickerLabels, labelCoverage, readStickerLibrary, stickerRoot } from './sticker-library.mjs'
// 词表是数据：命令行列出来的标签必须是**当前生效**的那份（含用户在标注台新加的）
import { activeLabelIds, activeLabelName } from './sticker-vocab.mjs'
import { buildTagPrompt, parseTagReply, preflightRetag, runTagging, selectTagTargets, tagFromFilenames } from './sticker-tagging.mjs'

// 这几个是**给测试用的再导出**（`mocks/verify-sticker-tag.mjs` 直接测它们，
// 保证"命令行看到的提示词/解析"与引擎是同一份）。
export { buildTagPrompt, parseTagReply }

/** 读配置（与 `index.mjs` 的私有 loadConfig 同一口径：缺文件时给可执行的提示）。 */
function loadConfig() {
  const path = join(PKG_ROOT, 'config.json')
  if (!existsSync(path)) {
    throw new Error(
      `找不到配置文件：${path}\n  本仓库不跟踪 config.json（含明文密钥），先复制模板：copy config.example.json config.json`,
    )
  }
  return normalizeConfig(JSON.parse(readFileSync(path, 'utf8')))
}

/** 待打标签的条目（库里 primary 为空、或置信度不够的）—— 给测试与预演用。 */
export function pendingEntries(library) {
  return selectTagTargets(library, { onlyPending: true }).todo
}

async function main() {
  const argv = process.argv
  const has = (f) => argv.includes(f)
  const argOf = (f) => {
    const i = argv.indexOf(f)
    return i >= 0 ? argv[i + 1] : undefined
  }

  const config = loadConfig()
  const workspace = config?.dsh?.workspace
  if (!workspace) {
    console.error('❌ 配置里没有 dsh.workspace，无法定位表情库')
    process.exit(2)
  }
  const dir = config?.skills?.sticker?.libraryDir ?? 'stickers'
  const apply = has('--apply')
  const all = has('--all') // --all = 重打所有（含已打好的）
  const force = has('--force') // --force = 连人工改过的也重打
  const limit = Number(argOf('--limit')) || 0
  const sample = Number(argOf('--sample')) || 0

  // ── 文件名先验（**零模型调用**）：先干这一遍，剩下的才交给模型 ─────────────
  //
  // 为什么要单独一个开关而不是默认就跑：它是一个**猜测**（置信度 0.7，
  // 靠原文件名里的词），跑完之后那些条目就已经"有标签"了 —— 于是后面的
  // "只处理待定的"那一遍就**不会再碰它们**。这是好事（省钱），但必须让使用者
  // 知道发生了这件事，所以它是一条**显式命令**，并且把结果如实打出来。
  if (has('--from-filename')) {
    const r = tagFromFilenames({ workspace, dir, force })
    const w = applyStickerLabels({ workspace, dir }, r.updates)
    const book = activeLabelIds({ workspace, dir })
    const cov = labelCoverage(w.library, book)
    console.log('')
    console.log(`文件名先验：定下 ${r.applied} 张｜认不出（留给模型）${r.skipped} 张`)
    const lines = Object.entries(cov)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}×${n}`)
    if (lines.length) console.log(`现在的标签分布：${lines.join('、')}`)
    console.log('')
    console.log('  ★ 这些标签是**猜测**（source=filename，置信度 0.7）：模型重打时会覆盖它们。')
    console.log('    下一步（可选）：node src/sticker-tag.mjs --apply   # 用模型处理认不出的那些')
    console.log('')
    process.exit(0)
  }

  // 通路：与唤醒判定同一条（`resolveDirectTarget` 决定 baseUrl/apiKey/model）
  const target = resolveDirectTarget({ config })
  if (!target?.ok) {
    console.error(
      '❌ 没有可用于打标签的模型通路。\n' +
        `   原因：${target?.why ?? '未知'}\n` +
        '   打标签要"看图"，所以需要一把能直连的 API key（`wake.judge.apiKey`）与一个**支持图片输入**的模型。\n' +
        '   ★ 也可以不用这个脚本：直接编辑库文件里的 primary 字段，手工打标签同样有效\n' +
        '     （手工改过的条目(`source:"manual"`)在重打时会**默认跳过**，不会被模型覆盖）。',
    )
    process.exit(2)
  }

  const root = stickerRoot({ workspace, dir })
  const library = readStickerLibrary({ workspace, dir })
  const pre = preflightRetag({ workspace, dir }, { force })
  const samplePool = sample > 0 ? Object.entries(library.entries).map(([rel, e]) => ({ rel, ...e })) : []
  const todoCount = sample > 0 ? Math.min(sample, samplePool.length) : pre.todo
  const rels = sample > 0 ? samplePool.sort(() => Math.random() - 0.5).slice(0, sample).map((e) => e.rel) : null

  console.log('')
  console.log(`表情库：${root}`)
  console.log(
    `共 ${pre.total} 张｜这次会处理 ${todoCount} 张` +
      `${pre.skippedManual ? `｜跳过人工改过的 ${pre.skippedManual} 张` : ''}` +
      `${sample > 0 ? '（抽检模式：随机抽，含已打好的）' : all ? '' : '（只处理待定的那些）'}`,
  )
  console.log(`模型：${target.model} @ ${target.baseUrl}`)
  console.log(`每张一次模型调用${apply ? '｜**会写回库**' : '｜**预演**（加 --apply 才写回）'}`)
  console.log('')

  if (todoCount === 0) {
    console.log('  没有需要打标签的图。')
    if (pre.skippedManual > 0) {
      console.log(`  （有 ${pre.skippedManual} 张是人工改过的标签；想连它们一起重打：加 --force）`)
    }
    console.log('')
    return
  }

  let done = 0
  const r = await runTagging({
    workspace,
    dir,
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    model: target.model,
    limit: sample > 0 ? 0 : limit,
    rels,
    onlyPending: !all && sample === 0,
    force,
    onProgress: (p) => {
      done = p.done
      if (p.ok) {
        console.log(
          `  ✅ [${p.done}/${todoCount}] ${p.rel} → ${p.labelName}（${p.label}）conf=${p.confidence}` +
            `${p.retagged ? '（重打）' : ''}`,
        )
      } else {
        console.log(`  ⚠️ [${p.done}/${todoCount}] ${p.rel} → ${p.why}`)
      }
    },
  })

  console.log('')
  if (!r.ok) {
    console.log(`❌ ${r.why}`)
    console.log(`   已完成 ${done} 张；已打上的标签${apply ? '会照常写回（下面看统计）' : '未写回（没加 --apply）'}。`)
    console.log('')
  }

  if (apply && Object.keys(r.updates ?? {}).length > 0) {
    const w = applyStickerLabels({ workspace, dir }, r.updates)
    const book = activeLabelIds({ workspace, dir })
    const cov = labelCoverage(w.library, book)
    console.log(`已写回 ${w.changed} 条标签。`)
    console.log('')
    console.log('各标签可用图数：')
    for (const id of book) {
      const n = cov[id] ?? 0
      if (n > 0) console.log(`  ${id.padEnd(14)} ${n}  ${activeLabelName(id, { workspace, dir })}`)
    }
    const pending = Object.keys(w.library.pending ?? {}).length
    if (pending > 0) console.log(`\n仍然待定：${pending} 张（认不出 / 置信度低 —— 这是预期的，不是故障）`)
  } else if (Object.keys(r.updates ?? {}).length > 0) {
    console.log(`预演结束：可写回 ${Object.keys(r.updates).length} 条（加 --apply 才真写）`)
  }

  console.log(`成功 ${r.tagged + r.retagged}（新打 ${r.tagged} / 重打 ${r.retagged}）｜失败 ${r.failed}｜跳过人工 ${r.skippedManual}`)
  console.log('')
  if (r.failed > 0) {
    console.log('  失败的那些**没有**改动库 —— 它们仍在待定区，可以重跑。')
    if (r.failedList?.length) {
      console.log('  前几条原因：')
      for (const f of r.failedList.slice(0, 5)) console.log(`    ${f.rel}：${f.why}`)
    }
    console.log('')
  }
  console.log('  ★ 手工改标签：编辑库文件里的 primary/labels，并把 source 写成 "manual"：')
  console.log('    重打时会**默认跳过**它（不会被模型覆盖）。')
  console.log('')
}

/** 直接被 `node src/sticker-tag.mjs` 跑时才执行（被 import 时不执行）。 */
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  main().catch((error) => {
    console.error(`❌ 打标签失败：${error?.message ?? error}`)
    process.exit(1)
  })
}
