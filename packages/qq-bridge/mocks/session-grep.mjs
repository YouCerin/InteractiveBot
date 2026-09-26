/**
 * 提示词取证：从 DSH 落盘的会话记录里**搜出模型实际收到了什么**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要这个工具（它是被"验证不了"逼出来的）
 * ══════════════════════════════════════════════════════════════════════════
 * 本项目的核心改动大多落在**提示词文本**上（记忆指令、任务台账段、配方段…），
 * 而"这段文本有没有真的进到生产提示词里"是**没法靠读代码回答的**：
 * 桥接拼完提示词就交给 DSH 了，中间没有任何我们能读的日志。
 *
 * 实测踩过的坑（两个都会让人得出**错误的"没生效"结论**）：
 *
 *   ① **会话目录挂在 workspace 路径下，不是包目录下**。
 *      `config.json` 的 `dsh.workspace` 是 `…\packages\qq-bridge\workspace-qq`，
 *      所以目录名是 `--C-…-packages-qq-bridge-workspace-qq--`。
 *      跑到包目录那一层去找，会读到**别的**（同样以 qq-bridge 为 cwd 的）会话，
 *      里面当然没有你的提示词。本工具按 workspace 反推目录名，避免手抄。
 *
 *   ② **它是 zstd 追加帧**。整块 `zstdDecompressSync(整个文件)` 只会解出
 *      **第一帧** —— 那通常只有 222 字节的会话头，于是"什么也搜不到"。
 *      必须按 magic（`28 B5 2F FD`）切帧**逐帧**解，未写完的尾帧丢掉即可。
 *      这是 DSH 的已知格式特性，`src/usage.mjs` 的注释里也记了一笔。
 *
 * 用法：
 *   node mocks/session-grep.mjs "直接写事实"          # 搜最近 3 个会话
 *   node mocks/session-grep.mjs "【当前任务" 5        # 搜最近 5 个会话
 *   node mocks/session-grep.mjs --list                # 只看有哪些会话、多大、什么时候写的
 *
 * 退出码：命中过 → 0；一个都没命中 → 1（这样可以直接用在 `if` 里）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'

import { PKG_ROOT, resolveInPackage } from '../src/local.mjs'

/** zstd 帧魔数。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 把工作区的绝对路径变成 DSH 的会话目录名。
 *
 * 实测映射：`C:\a\b` → `--C-a-b--`（冒号去掉、反斜杠变横线、首尾各两个横线）。
 */
export function sessionDirNameFor(workspace) {
  const norm = String(workspace ?? '').replace(/[/\\]+$/, '')
  if (!norm) return null
  return `--${norm.replace(/:/g, '').replace(/[/\\]/g, '-')}--`
}

/** 找 DSH 的会话根（桌面版与 CLI 版各一处，取实际存在的）。 */
export function sessionRoots({ env = process.env, home = null } = {}) {
  const roots = []
  if (env.APPDATA) roots.push(join(env.APPDATA, 'dsh-desktop', 'harness', 'sessions'))
  if (home) roots.push(join(home, '.dsh', 'sessions'))
  return roots
}

/**
 * 解一个会话文件：**按 magic 切帧逐帧解**，未写完的尾帧丢掉。
 *
 * @returns {{text: string, frames: number, dropped: number}}
 */
export function readSessionFile(file) {
  const buf = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      starts.push(i)
    }
  }
  const parts = []
  let frames = 0
  let dropped = 0
  for (let k = 0; k < starts.length; k++) {
    const slice = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)
    try {
      parts.push(zstdDecompressSync(slice).toString('utf8'))
      frames += 1
    } catch {
      dropped += 1 // 半截的尾帧（DSH 正在写）
    }
  }
  return { text: parts.join(''), frames, dropped }
}

/** 列出一个会话目录下的会话（按最后写入倒序）。 */
export function listSessions({ workspace, env = process.env, limit = 3 } = {}) {
  const dirName = sessionDirNameFor(workspace)
  if (!dirName) return []
  const found = []
  for (const root of sessionRoots({ env })) {
    const dir = join(root, dirName)
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue // 这个根下没有该工作区
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const file = join(dir, e.name, 'session.v3.jsonl.zstd')
      try {
        const st = statSync(file)
        found.push({ id: e.name, file, mtime: st.mtimeMs, size: st.size })
      } catch {
        /* 没有 session 文件就跳过 */
      }
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, Math.max(1, limit))
}

/** 从会话文本里搜关键词（返回命中行的上下文片段）。 */
export function grepSession({ text, pattern, limit = 3, width = 320 } = {}) {
  const re = new RegExp(pattern)
  const hits = []
  for (const line of String(text).split('\n')) {
    const i = line.search(re)
    if (i < 0) continue
    hits.push(line.slice(Math.max(0, i - width), i + width * 2))
    if (hits.length >= limit) break
  }
  return hits
}

function workspaceFromConfig() {
  try {
    const cfg = JSON.parse(readFileSync(join(PKG_ROOT, 'config.json'), 'utf8'))
    // ★ 必须是**绝对**路径：config.json 里的 `dsh.workspace` 常态是相对的
    //   （`workspace-qq`），而会话目录名是拿绝对路径反推的 ——
    //   不解析的话会推出 `--workspace-qq--` 这种永远找不到的目录名。
    return resolveInPackage(cfg?.dsh?.workspace ?? null)
  } catch {
    return null
  }
}

function main() {
  const args = process.argv.slice(2)
  const workspace = workspaceFromConfig()
  if (!workspace) {
    console.error('❌ 读不到 config.json 的 dsh.workspace —— 不知道去哪找会话记录')
    process.exit(2)
  }
  const listOnly = args.includes('--list')
  const rest = args.filter((a) => a !== '--list')
  const pattern = rest[0] ?? '直接写事实'
  const limit = Number(rest[1] ?? 3) || 3

  const sessions = listSessions({ workspace, limit })
  console.log(`工作区: ${workspace}`)
  console.log(`会话目录名: ${sessionDirNameFor(workspace)}｜找到 ${sessions.length} 个会话\n`)
  if (sessions.length === 0) {
    console.error('❌ 一个会话都没找到 —— 检查 dsh.workspace 是否写对（目录名是按它反推的）')
    process.exit(2)
  }
  if (listOnly) {
    for (const s of sessions) {
      console.log(`  ${s.id}  ${String(s.size).padStart(8)}B  ${new Date(s.mtime).toLocaleString('zh-CN')}`)
    }
    return
  }

  console.log(`关键词: ${pattern}\n`)
  let total = 0
  for (const s of sessions) {
    let out
    try {
      out = readSessionFile(s.file)
    } catch (error) {
      console.log(`=== ${s.id}：读不了（${error?.message ?? error}）`)
      continue
    }
    const hits = grepSession({ text: out.text, pattern })
    console.log(
      `=== ${s.id}（${s.size}B ｜ ${out.frames} 帧/丢 ${out.dropped} ｜ 解出 ${out.text.length} 字符 ｜ 命中 ${hits.length}+ 行）`,
    )
    for (const h of hits) console.log('  …' + h.replace(/\\n/g, '⏎') + '…')
    if (hits.length === 0) console.log('  （没有命中）')
    console.log('')
    total += hits.length
  }
  if (total === 0) {
    console.error('❌ 没有任何命中。先怀疑两件事：① 目录名/工作区写错；② 该会话确实还没跑过含这段文本的一轮。')
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) main()
