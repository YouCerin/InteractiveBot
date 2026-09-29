/**
 * 标注台**在线体检**：把浏览器打开这一页时会做的请求，按顺序全走一遍并计时。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么要有它
 * ══════════════════════════════════════════════════════════════════════════
 * 这个页面卡死过一次，而当时**既没有日志也没有可复现的脚本** ——
 * 只能靠猜（"是不是缩略图太多？是不是浮层？"），来回猜错了好几轮。
 * 所以把"浏览器会做什么"变成一条**可以随时跑、会自己报哪一步慢/错**的命令：
 *
 *   node sticker-label/doctor.mjs                     # 检查默认的 4399
 *   node sticker-label/doctor.mjs --port 4400
 *   node sticker-label/doctor.mjs --label moved       # 换个标签看图墙
 *   node sticker-label/doctor.mjs --warm              # 顺手把全库缩略图预热进缓存
 *
 * 它检查的东西（每一项都对应一个真实踩过的坑）：
 *   · 服务在不在、是**哪一版**（`/api/health` 的启动时间 + 关键参数）
 *   · 三个静态文件是否最新（用哈希与磁盘比对 —— 直接回答"我改的生效了吗"）
 *   · `/api/list`、`/api/browse` 正不正常
 *   · **整个图墙的缩略图**是否都能拿到、总体积多大、耗时多久（这一步是卡死的原现场）
 *   · 浮层点开的那张大图能不能取（以及它有多大）
 *   · 有没有拖后腿的请求（404/403）
 *   · `--warm`：把所有标签下的缩略图都拉一遍，替人预热（冷缓存第一屏要等）
 *
 * ★ 判据是"**能跑完 + 没有错**"，不是"够快" —— 慢一点只是慢，
 *   而卡死是另一回事。脚本会把每一阶段的耗时打出来，供人自己看。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PUBLIC = join(HERE, 'public')

const argv = process.argv
const argOf = (f, d) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : d
}
const PORT = Number(argOf('--port', '4399'))
const BASE = `http://127.0.0.1:${PORT}`
const LABEL = argOf('--label', null)

let problems = 0
let warnings = 0
const ok = (msg, detail = '') => console.log(`✅ ${msg}${detail ? `  —— ${detail}` : ''}`)
const bad = (msg, detail = '') => {
  problems += 1
  console.log(`❌ ${msg}${detail ? `  —— ${detail}` : ''}`)
}
const warn = (msg, detail = '') => {
  warnings += 1
  console.log(`⚠️  ${msg}${detail ? `  —— ${detail}` : ''}`)
}

const get = async (path) => {
  const t0 = Date.now()
  const res = await fetch(BASE + path)
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: res.status, buf, ms: Date.now() - t0, type: res.headers.get('content-type') ?? '' }
}

console.log(`\n标注台体检 → ${BASE}\n${'─'.repeat(60)}`)

/* ① 服务在不在、哪一版 ─────────────────────────────────────────────── */
let health = null
try {
  const r = await get('/api/health')
  if (r.status !== 200) {
    bad('服务在，但没有 /api/health（这是**旧版本**的服务端代码）', `HTTP ${r.status}`)
  } else {
    health = JSON.parse(r.buf.toString('utf8'))
    const age = Math.round((Date.now() - Date.parse(health.startedAt)) / 1000)
    ok('服务在跑', `启动于 ${health.startedAt}（${age} 秒前）｜缩略图并发 ${health.thumbConcurrency}｜缓存上限 ${health.thumbCacheMax}`)
  }
} catch (error) {
  bad('连不上服务', `${BASE} —— ${error?.message ?? error}`)
  console.log('\n先起服务：node sticker-label/server.mjs --open\n')
  process.exit(1)
}

/* ② 静态文件是不是磁盘上那一份（直接回答"我改的生效了吗"）───────────── */
// ⚠️ HTML **不能**逐字节比：服务会往里面注入 css/js 的构建版本串（`?v=…`），
//    那是**故意**的（否则没法保证浏览器不跑旧的 app.js）。
//    所以 HTML 查"关键标记在不在 + 版本串在不在"，css/js 才逐字节比。
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12)
for (const [path, file] of [
  ['/', 'index.html'],
  ['/app.js', 'app.js'],
  ['/style.css', 'style.css'],
]) {
  try {
    const served = await get(path)
    const disk = readFileSync(join(PUBLIC, file))
    if (served.status !== 200) {
      bad(`${path} 取不到`, `HTTP ${served.status}`)
      continue
    }
    if (file === 'index.html') {
      const text = served.buf.toString('utf8')
      const marks = [
        ['两个页签', /id="tab-(pass|browse)"/],
        ['构建标记', /id="build-stamp"/],
        ['浮层重载按钮', /id="ov-reload"[^>]*onclick=/],
        ['浮层关闭（内联）', /id="ov-close"[^>]*onclick=/],
        ['错误兜底条', /id="page-error"/],
      ]
      const missing = marks.filter(([, re]) => !re.test(text)).map(([n]) => n)
      if (missing.length) bad(`首页缺了这些标记：${missing.join('、')}`)
      else ok('首页关键标记齐全', `${marks.length} 项`)
      if (/\?v=\d+/.test(text)) ok('首页已注入构建版本串（浏览器不会跑旧的 css/js）', text.match(/\?v=\d+/)[0])
      else bad('首页**没有**注入构建版本串（浏览器可能还在跑旧 app.js）')
    } else if (sha(served.buf) !== sha(disk)) {
      bad(`${path} 与磁盘上的**不一致**（服务在发旧内容？）`, `${sha(served.buf)} vs ${sha(disk)}`)
    } else {
      ok(`${path} 与磁盘一致`, `${(served.buf.length / 1024).toFixed(1)}KB ${sha(disk)}`)
    }
  } catch (error) {
    bad(`${path} 读不到`, String(error?.message ?? error))
  }
}

/* ③ 页面会做的两个取数调用 ─────────────────────────────────────────── */
let list = null
try {
  const r = await get('/api/list')
  list = JSON.parse(r.buf.toString('utf8'))
  if (!list.ok) bad('/api/list 报错', JSON.stringify(list.error ?? list))
  else ok('/api/list 正常', `库 ${list.total} 张｜词表 ${list.labels?.length ?? 0} 个｜${r.ms}ms`)
} catch (error) {
  bad('/api/list 解析失败', String(error?.message ?? error))
}

/* ④ 图墙：整个标签的缩略图（**卡死的原现场**）───────────────────────── */
if (list?.rows?.length) {
  // 挑一个图最多的标签（那才是压力最大的）
  let label = LABEL
  if (!label) {
    const counts = Object.entries(list.counts ?? {}).sort((a, b) => b[1] - a[1])
    label = counts[0]?.[0] ?? null
  }
  if (!label) {
    warn('库里还没有任何标签，跳过图墙检查')
  } else {
    const br = await get(`/api/browse?label=${encodeURIComponent(label)}`)
    const browse = JSON.parse(br.buf.toString('utf8'))
    ok(`/api/browse 正常（${label}）`, `${browse.total} 张｜${br.ms}ms`)

    const rows = browse.rows ?? []
    const noThumb = rows.filter((r) => !r.thumb)
    if (noThumb.length) bad(`有 ${noThumb.length} 张没有 thumb 字段（前端会退化成拉原图 = 卡死的老路）`)
    else ok('每张都带 thumb（图墙用小图）', `${rows.length} 张`)

    if (rows.length) {
      const t0 = Date.now()
      let bytes = 0
      let failed = 0
      const results = await Promise.all(
        rows.map(async (r) => {
          try {
            const res = await fetch(BASE + r.thumb)
            const buf = Buffer.from(await res.arrayBuffer())
            if (res.status !== 200 || !buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
              failed += 1
              return 0
            }
            bytes += buf.length
            return buf.length
          } catch {
            failed += 1
            return 0
          }
        }),
      )
      const ms = Date.now() - t0
      const origMB = rows.reduce((s, r) => s + (r.sizeMB ?? 0), 0)
      const thumbMB = bytes / 1024 / 1024
      if (failed) bad(`图墙缩略图有 ${failed} 张失败`, `${results.length} 张里`)
      else ok(`整个图墙 ${rows.length} 张缩略图全部拿到`, `${thumbMB.toFixed(2)}MB，共 ${ms}ms（原图同批 ${origMB.toFixed(0)}MB）`)
      if (thumbMB > origMB * 0.5) warn('缩略图总体积接近原图 —— 压缩可能没生效', `${thumbMB.toFixed(2)}MB vs ${origMB.toFixed(1)}MB`)
    }
  }
}

/* ⑤ 浮层点开的那张大图 ────────────────────────────────────────────── */
if (list?.rows?.length) {
  const heavy = [...list.rows].sort((a, b) => (b.sizeMB ?? 0) - (a.sizeMB ?? 0))[0]
  if (heavy) {
    const r = await get(heavy.url)
    if (r.status !== 200) bad('最大的那张原图取不到（浮层会打不开）', `HTTP ${r.status} ${heavy.url}`)
    else {
      ok('最大的原图能取到', `${heavy.sizeMB}MB ${heavy.mediaType}｜${r.ms}ms`)
      if ((heavy.sizeMB ?? 0) > 3) {
        console.log(`     ↳ 它超过 3MB：前端**不会自动加载**，会先显示缩略图 + "点这里加载原图"（这是故意的）`)
      }
    }
  }
}

/* ⑥ `--warm`：把所有标签下的缩略图都请求一遍，替人预热服务端缓存 ────────
 *
 * 为什么值得做成正式开关：缩略图不是磁盘上现成的文件，而是**现场从 GIF 解帧合成**的
 * （最后一帧 + 透明合成 + 裁空边）。冷缓存时第一屏会有肉眼可见的等待；而这个工具
 * 一旦"点了标签要等好几秒才有图"，观感就和"坏了"很难区分。
 * 全库 157 张实测约 36 秒，之后点任何标签都是秒开（缓存上限 600 张，够放全库）。
 *
 * ★ 并发固定 3，和服务端的 `THUMB_CONCURRENCY` 一致 —— 开大了只会让服务端排队，
 *   反而更慢（那正是"图墙卡死"要防的东西）。
 * ★ 只是预热，失败不算体检问题（真失败在 ④ 那里已经报过了）。
 */
if (argv.includes('--warm')) {
  console.log(`${'─'.repeat(60)}`)
  console.log('🔥 预热缩略图缓存（把所有标签下的图都请求一遍）…')
  const labels = (await (await fetch(`${BASE}/api/labels`)).json()).labels ?? []
  const wanted = new Set()
  for (const l of labels) {
    const d = await (await fetch(`${BASE}/api/browse?label=${encodeURIComponent(l.id)}`)).json()
    for (const row of d.rows ?? []) if (row.thumb) wanted.add(row.thumb)
  }
  const todo = await (await fetch(`${BASE}/api/browse`)).json()
  for (const row of todo.rows ?? []) if (row.thumb) wanted.add(row.thumb)

  const list = [...wanted]
  const total = list.length
  const t0 = Date.now()
  let done = 0
  let failed = 0
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (list.length) {
        const thumb = list.pop()
        if (!thumb) break
        try {
          const res = await fetch(BASE + thumb)
          await res.arrayBuffer()
          if (res.status !== 200) failed += 1
        } catch {
          failed += 1
        }
        done += 1
        if (done % 25 === 0) console.log(`   …${done}/${total}`)
      }
    }),
  )
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  if (failed) warn(`预热完成，但有 ${failed} 张没拿到`, `${total} 张，${secs}s`)
  else ok(`预热完成：${total} 张缩略图都已进缓存`, `${secs}s —— 现在点任何标签都是秒开`)
}

/* ⑦ 收尾 ──────────────────────────────────────────────────────────── */
console.log(`${'─'.repeat(60)}`)
if (problems) {
  console.log(`❌ 体检发现 ${problems} 个问题${warnings ? `、${warnings} 个提醒` : ''}\n`)
  process.exit(1)
}
console.log(`✅ 体检通过${warnings ? `（${warnings} 个提醒）` : ''}\n`)
