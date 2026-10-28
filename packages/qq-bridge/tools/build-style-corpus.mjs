/**
 * 从本地语料库生成**语感候选池**（0.3.3 · P1 的可执行入口）。
 *
 * ```bash
 * node tools/build-style-corpus.mjs                              # 默认 150 条，写进工作区
 * node tools/build-style-corpus.mjs --target 200 --seed 7
 * node tools/build-style-corpus.mjs --groups group:1,group:2
 * node tools/build-style-corpus.mjs --groups 活死人之夜,岁岁粉丝后援会   # ★ 按**群名**筛
 * node tools/build-style-corpus.mjs --dry                        # 只打统计，不写文件
 * ```
 *
 * ★ `--groups` 既收群号也收**群名**（0.3.3 加）：群名要去运行中的桥接问
 *   （`GET 127.0.0.1:3410/api/roster` 就是协议端的 `get_group_list`）。
 *   名字按"归一化后包含"匹配（`<CJLU>岁岁粉丝后援会` 用 `岁岁粉丝后援会` 能命中），
 *   一条查询命中多个群会**报错**而不是替他挑一个。
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { curate, matchGroups } from '../src/style-corpus.mjs'

const PKG_ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const WORKSPACE = join(PKG_ROOT, 'workspace-qq')
const DB = join(WORKSPACE, 'runtime', 'corpus.sqlite')
const OUT_DIR = join(WORKSPACE, 'store', 'style')
/** 桥接的控制台端口（群名只能从它那里问，语料库里不存群名）。 */
const BRIDGE_API = 'http://127.0.0.1:3410'

function argOf(flag, fallback = '') {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? String(process.argv[i + 1] ?? '') : fallback
}

const target = Number(argOf('--target', '150')) || 150
const seed = Number(argOf('--seed', '20261018')) || 20261018
const groupsArg = argOf('--groups', '')
const wanted = groupsArg ? groupsArg.split(',').map((s) => s.trim()).filter(Boolean) : null
const dry = process.argv.includes('--dry')

if (!existsSync(DB)) {
  console.error(`❌ 找不到语料库：${DB}`)
  console.error('   语料库是桥接运行时建的。先在 `config.json` 里保持 `corpus.enabled` 为开、让它跑一阵。')
  process.exit(1)
}

// ── 群名 → 群号（只有给了名字才需要问桥接）──────────────────────────────────
let groups = null
let rosterNote = ''
if (wanted) {
  const needRoster = wanted.some((q) => !/^\d{5,15}$/.test(q))
  let roster = []
  if (needRoster) {
    try {
      const res = await fetch(`${BRIDGE_API}/api/roster`, { signal: AbortSignal.timeout(15000) })
      const body = await res.json()
      roster = Array.isArray(body?.data?.groups) ? body.data.groups : []
      if (!roster.length) throw new Error('名单是空的（协议端可能没连上）')
    } catch (error) {
      console.error(`❌ 要按群名筛，但问不到群名：${error?.message ?? error}`)
      console.error(`   群名只能从运行中的桥接问（${BRIDGE_API}/api/roster = 协议端的 get_group_list）。`)
      console.error('   先启动桥接；或者直接把群号写进 --groups（逗号分隔）。')
      process.exit(1)
    }
  }
  const m = matchGroups({ roster, wanted })
  if (!m.ok) {
    console.error(`❌ ${m.why}`)
    process.exit(1)
  }
  groups = m.groups
  rosterNote = m.matched.map((x) => `${x.name || '（群号）'} → ${x.groupId}`).join(' | ')
}

// ── 读行（只读）──────────────────────────────────────────────────────────────
// ★ 按 `chat_key, created_at, id` 排序：`curate()` 用"前几条"当上下文，**顺序必须由这里给**。
const db = new DatabaseSync(DB, { readOnly: true })
let rows
try {
  rows = db
    .prepare(
      `SELECT chat_key AS chatKey,
              content   AS text,
              is_bot    AS isBotRaw,
              sender_name AS senderName,
              user_id   AS userId,
              created_at AS createdAt,
              message_id AS messageId
         FROM messages
        WHERE chat_key LIKE 'group:%'
        ORDER BY chat_key, created_at, id`,
    )
    .all()
    .map((r) => ({ ...r, isBot: Number(r.isBotRaw) === 1 }))
} finally {
  db.close()
}

const { samples, stats } = curate({ rows, targetCount: target, seed, groups })

// ── 打印统计（人要先看懂这份池子是怎么来的）─────────────────────────────────
console.log(`\n语料库：${DB}`)
if (rosterNote) console.log(`只取这 ${groups.length} 个群：${rosterNote}`)
console.log(`读入 ${stats.input} 行（只取群聊${groups ? '·按指定群筛' : ''}）→ 目标 ${stats.targetCount} 条 → 实得 ${stats.pickedTotal} 条` +
  `${stats.shortfall > 0 ? `（缺口 ${stats.shortfall}，**不补齐**）` : ''}`)

console.log('\n── 被筛掉的（按原因）──')
for (const [why, n] of Object.entries(stats.dropped).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(6)}  ${why}`)
}

console.log('\n── 每个群：可当样本 / 实际选中 ──')
for (const k of Object.keys(stats.eligibleByGroup).sort((a, b) => stats.eligibleByGroup[b] - stats.eligibleByGroup[a])) {
  const picked = stats.pickedByGroup[k] ?? 0
  console.log(`  ${k.padEnd(22)} ${String(stats.eligibleByGroup[k]).padStart(6)} / ${String(picked).padStart(4)}`)
}

const speakers = Object.entries(stats.pickedBySpeaker).sort((a, b) => b[1] - a[1])
console.log(`\n── 按人（共 ${speakers.length} 人，前 12）──`)
for (const [who, n] of speakers.slice(0, 12)) console.log(`  ${String(who).padEnd(22)} ${n}`)

if (Object.keys(stats.nameCollisions).length > 0) {
  console.log('\n⚠️ 署名和机器人同名的**真人**行（只记统计，未过滤）：' +
    JSON.stringify(stats.nameCollisions))
}

if (dry) {
  console.log('\n（--dry：不写文件）')
  process.exit(0)
}

mkdirSync(OUT_DIR, { recursive: true })
const jsonl = join(OUT_DIR, 'candidates.jsonl')
writeFileSync(
  jsonl,
  `${samples.map((s) => JSON.stringify(s)).join('\n')}${samples.length > 0 ? '\n' : ''}`,
  'utf8',
)
const manifest = join(OUT_DIR, 'manifest.json')
writeFileSync(
  manifest,
  `${JSON.stringify({ generatedAt: new Date().toISOString(), db: DB, seed, targetCount: target, groups, ...stats }, null, 2)}\n`,
  'utf8',
)

console.log(`\n✅ 候选池：${jsonl}`)
console.log(`✅ 统计：  ${manifest}`)
console.log('   下一步（人工剔除）：逐条过一遍，标成 可用 / 不可用 / 拿不准。')
console.log('   这份池子含聊天原文，**只留在工作区**，别复制到仓库或发出去。')
