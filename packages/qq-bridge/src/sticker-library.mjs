/**
 * 表情包库：导入、内容寻址落盘、去重、标签读写、用量台账。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个模块存在的理由
 * ══════════════════════════════════════════════════════════════════════════
 * 现有桥接只有一条"表情"通道：`[sticker:名字]` → `config.send.stickers` 表 →
 * QQ 内置 `type:'face'`。它有两个根本限制：
 *   · 表**默认是空的**，而且它只能装 QQ 内置表情的 id；
 *   · 名字→id 必须逐个确认，猜错就是发错表情（`markers.mjs:113` 的既有纪律）。
 *
 * 真实的"发表情包"需要的是：**一批图** + **每张图的语义标签** + **能按场景选**。
 * 本模块负责前两件（库与标签），第三个在 `sticker-decision.mjs`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三条设计取舍（都是刻意的）
 * ══════════════════════════════════════════════════════════════════════════
 * ① **文件名 = 内容哈希**（沿用 `images.mjs:458` 的既有做法）。
 *    同一张图在群里会反复出现；内容寻址让"同一张只存一份"变成天然行为。
 *    另外用**感知哈希**挡近重复（重压缩/重导出的近似副本，内容哈希挡不住）。
 *
 * ② **库按会话分目录 + 全局兜底**（`global/` 与 `chat-<peerKey>/`）。
 *    每个群有自己的梗和气氛；回复时优先用本群的图（群里人认得出，才像群里的人）。
 *    全局目录是冷启动兜底 —— 没有它，新群在攒够图之前一次都发不出来。
 *
 * ③ **元数据与用量分开存**：
 *    `library.json`（会被人看、被控制台编辑）＋ `usage.json`（机器写、可丢）。
 *    混在一份里会出现"改一个标签把一个计数写坏了"这类无语故障。
 *
 * ⚠️ 本文件与 `sticker-decision.mjs` 一律**只做确定性计算**，不调模型。
 *    模型只在离线打标签脚本里出现（`scripts/sticker-tag.mjs`），运行期零 token。
 */

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { MEDIA_TYPE_EXT, sniffImageMediaType } from './images.mjs'
import {
  MAX_PRIMARY_PER_LABEL,
  MIN_TAG_CONFIDENCE,
  RISK_LABEL,
  STICKER_LABEL_IDS,
} from './sticker-labels.mjs'
// ★ 词表是**数据**（`stickers/labels.json`）：库这一层的标签校验必须认"用户新加的标签"，
//   否则在标注台新建一个标签贴上去会被判成"认不出"（实测就是这么断的）。
//   本模块与 `sticker-vocab.mjs` **不互相 import**（那边自己写了一份 `STICKER_DIR`），
//   所以这里是单向依赖，不存在求值顺序问题。
import { activeLabelIds, resolveActiveLabelId } from './sticker-vocab.mjs'

/**
 * 这条图是不是被标成「慎发」（风险类）。
 *
 * ★ 放在**本模块**而不是 `sticker-decision.mjs`：过滤发生在 `buildStickerSelection`
 *   （库这一层），而 decision 已经 import library —— 反过来放会形成循环依赖。
 *   规则只有一条（`entry.risky === true` 或 labels 里含 `risky`），所以不重复实现。
 */
export function isRiskyEntry(entry) {
  if (!entry) return false
  if (entry.risky === true) return true
  return Array.isArray(entry.labels) && entry.labels.includes(RISK_LABEL)
}

/** 同步 require（本模块是 ESM；`zlib` 只在离线导入那条路径上用）。 */
const nodeRequire = createRequire(import.meta.url)

/** 表情库在工作区里的默认相对目录（与会话图片落盘的 `inbox/` 同域）。 */
export const STICKER_DIR = 'stickers'

/** 库清单文件名。 */
export const LIBRARY_FILE = 'library.json'

/** 认得出是图片的扩展名（只用来**列目录**，真正的类型判断一律按字节 —— 见 `sniffImageMediaType`）。 */
const IMAGE_EXT_RE = /\.(gif|png|jpe?g|webp)$/i

/** 用量台账文件名（机器写，可丢；每日上限与冷却都读它）。 */
export const USAGE_FILE = 'usage.json'

/** 决策流水文件名（追加式 JSONL；"为什么不发"要从这里看）。 */
export const DECISION_LOG_FILE = 'decisions.jsonl'

/** 全局兜底目录名。 */
export const GLOBAL_SCOPE = 'global'

/** 感知哈希的汉明距离阈值：≤ 这个值算近重复。 */
export const NEAR_DUPLICATE_DISTANCE = 6

/**
 * 单张表情的大小上限（**按格式分开**）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么动图必须放宽（实测踩出来的：用户 157 张里 117 张被拒）
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版是一个 2MB 的**统一**上限，理由是"超过的多半不是表情包，是照片或长图"。
 * 那个理由对静态图成立，对**动图**完全不成立：动图是几十帧堆出来的，
 * 实测用户那批 GIF 的分布是 `<1MB 12 张 / 1-2MB 28 张 / 2-5MB 109 张 / 5-10MB 8 张`
 * —— 也就是 **75% 会被静默拒掉**，而它们全是正经表情包。
 * 更糟的是它**静默**：`--import` 只回一行"其它跳过 117 张"，用户很容易以为导完了。
 *
 * ∴ 现在分两级判：
 *   ① **画面尺寸**（更贴近"这是不是表情包"这个真问题）：表情包的画面天然小。
 *      超了就拒，并在原因里写出实际尺寸（可核对）。
 *   ② **字节上限**按格式分开：动图给足（20MB），静态图仍然紧（4MB）。
 */
export const MAX_STICKER_BYTES_STATIC = 4 * 1024 * 1024

/** 动图（`image/gif`）的字节上限：动图是几十帧堆出来的，用静态图的标准会**误杀一大半**。 */
export const MAX_STICKER_BYTES_ANIMATED = 20 * 1024 * 1024

/**
 * 画面尺寸上限：表情包的画面**天然小**（QQ 表情大多 ≤ 512）。
 * 超过这个的基本是照片 / 长截图 / 表情包素材大图 —— 那些**不适合当表情发**：
 * 发出去是一张大图，而且会占掉别人一屏。
 *
 * ⚠️ 这个判据比字节数**更贴近意图**：一张 5MB 的 240×240 动图是表情包，
 *    一张 200KB 的 4000×3000 截图不是。所以先判尺寸、再判字节。
 */
export const MAX_STICKER_DIMENSION = 2048

/** 兼容旧名（调用方与测试可能还在用）。 */
export const MAX_STICKER_BYTES = MAX_STICKER_BYTES_STATIC

/** 决策流水最多保留多少行（防无限增长）。 */
export const MAX_DECISION_LINES = 2000

/* ────────────────────────────────────────────────────────────────────────
 * 路径与读写
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 作用域目录名。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 这里必须与"清单里让人手建的目录名"**完全一致**（实测踩到的真 bug）
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版把 `:` 折成 `-` 之后又加了一层 `chat-` 前缀，于是：
 *   · 桥接运行期给 `group:700000001` 算出的目录是 `chat-group-700000001`；
 *   · 而文档/清单里让人手建的是 `chat-700000001` 或直接 `group-700000001`。
 * 两边不一致的后果是**静默失效**：图导进去了、标签也打了、运行期一张都选不到
 * （`buildStickerCandidates` 会把它们全当成"别的会话的图"滤掉）。
 *
 * 所以现在的规则是**只做字符白名单判定**，不再自作聪明地加前缀：
 *   · 空 / `global` → `global`（兜底库）
 *   · 其余只允许 `[A-Za-z0-9_-]`（**含 `:` 会被拒**，但那是安全兜底）
 *   · 不安全的一律哈希（防目录穿越），并在日志里说明"这个会话的库名是哈希"
 *
 * ∴ 使用者看到的目录名 = `peerKey`（`group:123` → `group-123`、`private:456` → `private-456`），
 *   与清单里的例子一致。
 */
export function canonicalScope(scope) {
  const raw = String(scope ?? '').trim()
  if (!raw) return GLOBAL_SCOPE
  if (raw === GLOBAL_SCOPE) return GLOBAL_SCOPE
  // 只折最常见的分隔符（`: `），其余字符交给安全判定
  return raw.replace(/[:\s]+/g, '-')
}

/** 作用域目录名：`global` 或安全的会话名。 */
export function scopeDirName(scope) {
  const canon = canonicalScope(scope)
  if (canon === GLOBAL_SCOPE) return GLOBAL_SCOPE
  if (/^[A-Za-z0-9_-]{1,60}$/.test(canon)) return canon
  const sha = createHash('sha256').update(canon).digest('hex').slice(0, 12)
  return `scope-${sha}`
}

/** 库根目录（缺工作区就返回空串，调用方据此 fail-closed）。 */
export function stickerRoot({ workspace, dir = STICKER_DIR } = {}) {
  const root = String(workspace ?? '').trim()
  if (!root) return ''
  return join(root, String(dir || STICKER_DIR))
}

function ensureDirFor(file) {
  mkdirSync(dirname(file), { recursive: true })
}

/** 原子写（tmp + rename）：中途崩溃不会留下半份 JSON。 */
export function writeJsonAtomic(file, data) {
  ensureDirFor(file)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** 空库形状。 */
export function emptyLibrary() {
  return { version: 1, updatedAt: null, entries: {}, pending: {} }
}

/** 读库。文件不存在 / 解析失败都返回**空库**（绝不抛错打断对话）。 */
export function readStickerLibrary({ workspace, dir = STICKER_DIR } = {}) {
  const root = stickerRoot({ workspace, dir })
  if (!root) return emptyLibrary()
  const file = join(root, LIBRARY_FILE)
  if (!existsSync(file)) return emptyLibrary()
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const lib = emptyLibrary()
    if (raw && typeof raw === 'object') {
      if (raw.entries && typeof raw.entries === 'object') lib.entries = raw.entries
      if (raw.pending && typeof raw.pending === 'object') lib.pending = raw.pending
      if (raw.updatedAt) lib.updatedAt = raw.updatedAt
      if (raw.version) lib.version = raw.version
    }
    return lib
  } catch {
    return emptyLibrary()
  }
}

/** 写库（自动盖 `updatedAt`）。 */
export function writeStickerLibrary({ workspace, dir = STICKER_DIR } = {}, library) {
  const root = stickerRoot({ workspace, dir })
  if (!root) return { ok: false, reason: '没有工作区，表情库无处可放' }
  const lib = {
    version: 1,
    ...library,
    entries: library?.entries ?? {},
    pending: library?.pending ?? {},
    updatedAt: new Date().toISOString(),
  }
  try {
    writeJsonAtomic(join(root, LIBRARY_FILE), lib)
    return { ok: true, file: join(root, LIBRARY_FILE) }
  } catch (error) {
    return { ok: false, reason: `写入失败：${error?.message ?? error}` }
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 哈希与去重
 * ──────────────────────────────────────────────────────────────────────── */

/** 内容哈希（sha256 前 32 位，与落盘文件名同一口径）。 */
export function contentIdOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32)
}

/**
 * 感知哈希：把 8×8 亮度矩阵按**整体均值**二值化成 64 bit（16 位 hex）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么是"与整体均值比"，而不是"自己内部求均值"（一个实测抓出来的坑）
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版是"每个像素与该图自身均值比"（经典 aHash 的字面写法）。它对**纯色图**
 * 会退化成**同一个哈希**：纯红（亮度 81）与纯蓝（亮度 27）各自与自己均值一样，
 * 64 位全是 1 ⇒ `ffffffffffffffff`。实测就是这么发现的 —— 两张完全不同的图
 * 被判成"近似重复"，然后其中一张被静默丢掉。
 *
 * 与**整体均值**比就不会：纯红虽然内部平坦，但它的均值只有 81、低于中灰 128，
 * 于是 >= 判据给出全 0（`0000000000000000`）—— 与纯蓝（均值 27，同样全 0）
 * 仍然会撞。
 *
 * ∴ 结论：**aHash 本身分不开"纯色但不同色"的图**（这是它的固有性质，不是实现 bug）。
 *   所以还有第二条判据：`hammingDistance` 之外，导入时对"指纹相同但内容哈希不同"
 *   的图**不判近重复**（见 `importStickerFiles` 的注释）—— 真正实用的场景
 *   （表情包有画面细节）里 aHash 是好用的；纯色图是它唯一会失灵的形状。
 *
 * ★ 这一步刻意做成**纯函数**（输入亮度数组，不碰图片解码）：解码需要依赖，
 *   而"两个哈希的汉明距离"这条判据必须能被离线单测钉住（否则去重逻辑就是玄学）。
 *
 * @param {ArrayLike<number>} luma 8×8 亮度（0~255），长度必须 ≥64
 * @returns {string|null} 16 位 hex；输入不合法返回 null（**不猜**）
 */
export function aHashFromLuma(luma) {
  if (!luma || luma.length < 64) return null
  let sum = 0
  for (let i = 0; i < 64; i += 1) sum += Number(luma[i]) || 0
  const avg = sum / 64
  let bits = ''
  for (let i = 0; i < 64; i += 1) bits += (Number(luma[i]) || 0) >= avg ? '1' : '0'
  let hex = ''
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

/** 两个 aHash 的汉明距离；任一个不合法返回 99（= 不算近重复）。 */
export function hammingDistance(a, b) {
  const x = String(a ?? '')
  const y = String(b ?? '')
  if (x.length !== 16 || y.length !== 16) return 99
  let d = 0
  for (let i = 0; i < 16; i += 1) {
    const v = parseInt(x[i], 16) ^ parseInt(y[i], 16)
    d += ((v >> 3) & 1) + ((v >> 2) & 1) + ((v >> 1) & 1) + (v & 1)
  }
  return d
}

/**
 * "平坦指纹"：全 1 或全 0（= 一张**没有内部明暗结构**的图，多半是纯色/渐变底）。
 *
 * 为什么必须单独识别它：aHash 对纯色图会退化成同一个值（见 `aHashFromLuma`），
 * 于是"纯红 vs 纯蓝"的汉明距离是 **0** —— 拿它当近重复判据就会**误删真图**。
 * 这是实测抓到的，不是理论担心。代价：纯色表情包之间不会互相去重（那是可接受的漏）。
 */
export function isFlatFingerprint(hash) {
  const h = String(hash ?? '')
  return h === 'ffffffffffffffff' || h === '0000000000000000'
}

/**
 * 图片的**画面尺寸**（只读文件头，不解码像素）。
 *
 * 为什么需要它：判"这张是不是表情包"更准的判据是**画面大小**而不是字节数
 * （一张 5MB 的 240×240 动图是表情包；一张 200KB 的 4000×3000 截图不是）。
 * 实现上只读头部几个字节：PNG 的 IHDR、GIF 的逻辑屏幕描述符、
 * WebP 的 VP8/VP8L/VP8X 块、JPEG 的 SOF 段。
 *
 * @returns {{width:number, height:number}|null} 认不出返回 null（**不猜**）
 */
export function readImageSize(bytes) {
  try {
    const b = bytes
    if (!b || b.length < 24) return null
    // ── PNG：8 字节魔数 + 4 长度 + 'IHDR' + 宽(4) 高(4) ──
    if (b.subarray(0, 8).equals(PNG_MAGIC)) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
    }
    // ── GIF：'GIF87a'/'GIF89a' + 宽(2, LE) 高(2, LE) ──
    if (b.toString('ascii', 0, 3) === 'GIF') {
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
    }
    // ── WebP：'RIFF' + 4 长度 + 'WEBP' + 块类型 ──
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const kind = b.toString('ascii', 12, 16)
      if (kind === 'VP8X') {
        const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16))
        const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16))
        return { width: w, height: h }
      }
      if (kind === 'VP8 ') {
        return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
      }
      if (kind === 'VP8L') {
        const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
      return null
    }
    // ── JPEG：扫 SOF0/1/2/… 段（跳过其它段）──
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i += 1
          continue
        }
        const marker = b[i + 1]
        // SOF0..SOF15（不含 DHT=0xc4 / JPG=0xc8 / DAC=0xcc）
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }
        }
        const len = b.readUInt16BE(i + 2)
        if (len < 2) return null
        i += 2 + len
      }
      return null
    }
    return null
  } catch {
    return null
  }
}

/**
 * 这张图能不能当表情包入库。**先判画面尺寸、再判字节上限**。
 *
 * @returns {{ ok:true }|{ ok:false, why:string }}
 */
export function checkStickerAdmissible(bytes, mediaType) {
  const animated = mediaType === 'image/gif'
  const cap = animated ? MAX_STICKER_BYTES_ANIMATED : MAX_STICKER_BYTES_STATIC
  if (bytes.byteLength > cap) {
    return {
      ok: false,
      why: `超过大小上限（${Math.round(bytes.byteLength / 1024)}KB > ${Math.round(cap / 1024)}KB）`,
    }
  }
  const size = readImageSize(bytes)
  if (size && (size.width > MAX_STICKER_DIMENSION || size.height > MAX_STICKER_DIMENSION)) {
    return {
      ok: false,
      why: `画面太大（${size.width}×${size.height} > ${MAX_STICKER_DIMENSION}）—— 这多半是照片或长截图，不适合当表情发`,
    }
  }
  // 认不出尺寸**不拒**（不猜）：格式支持与否已经由 `sniffImageMediaType` 判过了
  return { ok: true }
}

/* ────────────────────────────────────────────────────────────────────────
 * 图片解码（**只为感知哈希服务**，故意做得极窄）
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * ★★ 为什么这里要自己解码 PNG，而不是装一个图像库
 *
 * 感知哈希的前提是"把图缩放成小灰度图"。而本项目**没有图像依赖**：
 *   · 装 `sharp`/`jimp` 会给一个"整个包可以整体搬走、只用 Node 内置模块"的项目
 *     加一个几 MB 的原生/纯 JS 依赖，而它只服务于**离线导入**这一条路径；
 *   · 本机那个 ffmpeg 是 **SnowLuma（Electron）自带的插件**（`ffmpegAddon.win32.x64.node`），
 *     不是可执行文件，调不动。
 *
 * 所以这里只实现"够用就好"的一小块：**PNG 解码到 8×8 灰度**。
 * 代价如实写在 `fingerprintImage()` 的注释里：**JPEG / WebP / GIF 拿不到感知哈希**
 * （近重复检测对它们退化为"只按内容哈希"）。这不是"没做"，是**知道做不到就不假装**。
 *
 * 支持范围：位深 8/16、颜色类型 0（灰度）/2（真彩）/3（索引）/4（灰度+alpha）/6（真彩+alpha）。
 * 不支持的（交错 Adam7、位深 1/2/4）返回 null。
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 是不是 PNG（按魔数，不信扩展名）。 */
export function isPng(bytes) {
  const b = bytes
  return Boolean(b && b.length > 8 && b.subarray(0, 8).equals(PNG_MAGIC))
}

/**
 * 把 PNG 解成 `{ width, height, luma }`（luma = 每像素亮度 0~255）。
 * 失败返回 `null`（**不抛** —— 离线导入要能一张张跳过坏的）。
 */
export function decodePngToLuma(bytes) {
  try {
    const b = bytes
    if (!isPng(b)) return null
    let off = 8
    let width = 0
    let height = 0
    let bitDepth = 8
    let colorType = 6
    let interlace = 0
    const idat = []
    let palette = null
    let trns = null

    while (off + 8 <= b.length) {
      const len = b.readUInt32BE(off)
      const type = b.toString('ascii', off + 4, off + 8)
      const data = b.subarray(off + 8, off + 8 + len)
      off += 12 + len // + CRC
      if (type === 'IHDR') {
        width = data.readUInt32BE(0)
        height = data.readUInt32BE(4)
        bitDepth = data[8]
        colorType = data[9]
        interlace = data[12]
      } else if (type === 'PLTE') {
        palette = Buffer.from(data)
      } else if (type === 'tRNS') {
        trns = Buffer.from(data)
      } else if (type === 'IDAT') {
        idat.push(Buffer.from(data))
      } else if (type === 'IEND') {
        break
      }
    }

    if (!width || !height || interlace !== 0) return null
    if (![8, 16].includes(bitDepth)) return null
    if (!idat.length) return null

    const raw = zlibInflate(Buffer.concat(idat))
    if (!raw) return null

    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
    if (!channels) return null
    const bytesPerSample = bitDepth / 8
    const bpp = channels * bytesPerSample
    const stride = width * bpp
    const out = new Uint8Array(stride * height)

    // ── 反过滤（PNG 的五种过滤器）────────────────────────────────────────
    let pos = 0
    for (let y = 0; y < height; y += 1) {
      const filter = raw[pos]
      pos += 1
      const rowStart = y * stride
      const prevStart = rowStart - stride
      for (let x = 0; x < stride; x += 1) {
        const cur = raw[pos + x] ?? 0
        const a = x >= bpp ? out[rowStart + x - bpp] : 0
        const bb = y > 0 ? out[prevStart + x] : 0
        const c = x >= bpp && y > 0 ? out[prevStart + x - bpp] : 0
        let val
        switch (filter) {
          case 0:
            val = cur
            break
          case 1:
            val = cur + a
            break
          case 2:
            val = cur + bb
            break
          case 3:
            val = cur + ((a + bb) >> 1)
            break
          case 4: {
            const p = a + bb - c
            const pa = Math.abs(p - a)
            const pb = Math.abs(p - bb)
            const pc = Math.abs(p - c)
            val = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c)
            break
          }
          default:
            return null
        }
        out[rowStart + x] = val & 0xff
      }
      pos += stride
    }

    // ── 取亮度（16 位只取高字节）────────────────────────────────────────
    const sampleAt = (row, col, channel) => {
      const base = row * stride + col * bpp + channel * bytesPerSample
      return bytesPerSample === 2 ? out[base] : out[base]
    }
    const luma = new Uint8Array(width * height)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let r
        let g
        let bl
        if (colorType === 0 || colorType === 4) {
          r = g = bl = sampleAt(y, x, 0)
        } else if (colorType === 2 || colorType === 6) {
          r = sampleAt(y, x, 0)
          g = sampleAt(y, x, 1)
          bl = sampleAt(y, x, 2)
        } else {
          const idx = sampleAt(y, x, 0)
          if (!palette || idx * 3 + 2 >= palette.length) return null
          r = palette[idx * 3]
          g = palette[idx * 3 + 1]
          bl = palette[idx * 3 + 2]
        }
        void trns
        luma[y * width + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * bl)
      }
    }
    return { width, height, luma }
  } catch {
    return null
  }
}

/** zlib 解压（延迟 require，避免模块加载期依赖）。 */
function zlibInflate(buf) {
  try {
    const { inflateSync } = nodeRequire('node:zlib')
    return inflateSync(buf)
  } catch {
    return null
  }
}

/** 把任意尺寸的亮度图**降采样**成 8×8（分块平均）。 */
export function downscaleTo8x8(luma, width, height) {
  if (!luma || !width || !height) return null
  const out = new Array(64).fill(0)
  const counts = new Array(64).fill(0)
  for (let y = 0; y < height; y += 1) {
    const by = Math.min(7, Math.floor((y * 8) / height))
    for (let x = 0; x < width; x += 1) {
      const bx = Math.min(7, Math.floor((x * 8) / width))
      out[by * 8 + bx] += luma[y * width + x]
      counts[by * 8 + bx] += 1
    }
  }
  return out.map((sum, i) => (counts[i] ? sum / counts[i] : 0))
}

/**
 * 给一张图算**感知哈希**（近重复检测用）。
 *
 * ★ 如实降级：只有 **PNG** 能算（理由见上面那段长注释）。
 *   JPEG/WebP/GIF 返回 `{ ok:false, why:'这种格式解不了' }` —— 调用方据此
 *   只按内容哈希去重，并把"有多少张没做近重复检测"报给使用者。
 *
 * @returns {{ ok: true, hash: string }|{ ok: false, why: string }}
 */
export function fingerprintImage(bytes) {
  if (!bytes || !bytes.length) return { ok: false, why: '空文件' }
  if (!isPng(bytes)) return { ok: false, why: '只有 PNG 能算近重复指纹（JPEG/WebP/GIF 只按内容哈希去重）' }
  const decoded = decodePngToLuma(bytes)
  if (!decoded) return { ok: false, why: '这个 PNG 解不了（可能是交错/低位深）' }
  const small = downscaleTo8x8(decoded.luma, decoded.width, decoded.height)
  const hash = aHashFromLuma(small)
  if (!hash) return { ok: false, why: '降采样失败' }
  return { ok: true, hash }
}

/* ────────────────────────────────────────────────────────────────────────
 * 导入
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 导入一批图片文件（**离线**用；运行期不调它）。
 *
 * 去重三层：
 *   ① 内容哈希相同 → `deduped`（同一张图，直接复用已有条目）；
 *   ② 感知哈希距离 ≤ `NEAR_DUPLICATE_DISTANCE` → `nearDuplicate`（近似副本，丢掉，
 *      但记下来路，便于人工核对）；
 *   ③ 入参里同一次导入内部的重复 → 同一套判据（新条目也在比较集合里）。
 *
 * ⚠️ 感知哈希需要解码图片才能算。**本模块只接受调用方已经算好的 `aHash`**
 *    （`batches[].hashes[file]`）—— 解码依赖属于离线脚本，不进宿主进程。
 *
 * @param {{ workspace: string, dir?: string }} opts
 * @param {Array<{ scope: string, files: string[], labels?: string[], primary?: string, confidence?: number, hashes?: Record<string,string> }>} batches
 * @returns {{ added: number, deduped: number, nearDuplicate: number, skipped: Array<{file:string,reason:string}>, entries: object }}
 */
export function importStickerFiles({ workspace, dir = STICKER_DIR } = {}, batches = []) {
  const root = stickerRoot({ workspace, dir })
  if (!root) return { added: 0, deduped: 0, nearDuplicate: 0, skipped: [{ file: '', reason: '没有工作区' }], entries: {} }

  const library = readStickerLibrary({ workspace, dir })
  const byContent = new Map(Object.entries(library.entries).map(([rel, e]) => [e.id ?? rel, rel]))
  // 感知哈希集合（已有条目 + 本次已收下的）：近重复判据的唯一来源
  const hashes = Object.values(library.entries)
    .filter((e) => e.aHash)
    .map((e) => ({ rel: e.file, hash: e.aHash }))

  const skipped = []
  let added = 0
  let deduped = 0
  let nearDuplicate = 0
  /** 去重命中、且源文件本来就在库里 → 被收掉的多余副本数（见下面的长注释）。 */
  let droppedInLibrary = 0

  for (const batch of batches) {
    const scope = scopeDirName(batch?.scope ?? GLOBAL_SCOPE)
    const dirAbs = join(root, scope)
    const declaredHashes = batch?.hashes && typeof batch.hashes === 'object' ? batch.hashes : {}
    for (const file of batch?.files ?? []) {
      let bytes
      try {
        bytes = readFileSync(file)
      } catch (error) {
        skipped.push({ file: String(file), reason: `读不到：${error?.message ?? error}` })
        continue
      }
      if (!bytes.byteLength) {
        skipped.push({ file: String(file), reason: '空文件' })
        continue
      }
      // ★ 按**字节**判类型，不信扩展名（沿用 images.mjs 的既有纪律）
      const mediaType = sniffImageMediaType(bytes)
      if (!mediaType) {
        skipped.push({ file: String(file), reason: '不是 png/jpeg/webp/gif（按内容判的）' })
        continue
      }
      // ★ 可入库性：**先判画面尺寸、再判字节上限**（动图的上限单独放宽 —— 见常量注释）
      const adm = checkStickerAdmissible(bytes, mediaType)
      if (!adm.ok) {
        skipped.push({ file: String(file), reason: adm.why })
        continue
      }
      const id = contentIdOf(bytes)
      const known = byContent.get(id)
      if (known) {
        deduped += 1
        // ★★ 去重命中时**源文件如果本来就在库里**，必须把它收掉（0.2.4 补，实测抓到）。
        //
        // 为什么（这是一个真实发生过的库污染）：用户第二次导入时往往会把
        // **库目录本身**（或库里的某个子目录）当源再导一遍。去重在这里 `continue`，
        // 于是既不复制、也不删除 —— 那些原始文件（`蓝色大肥鱼_一切都好.gif` 这种）
        // 就**永久留在库里**，而索引里一条都不指向它们。
        // 实测规模：157 张库里躺着 **157 个字节完全相同的副本、460MB**（占全库一半），
        // 而界面/命令行都看不见（索引里没有它们）。
        //
        // ∴ 规则：**源与目标是同一个文件或内容相同时，不留下第二份**。
        //   只在"源确实在库内、且不是索引指向的那一份"时才删 —— 库外的源
        //   **绝对不动**（那是用户的原始素材，导入是复制语义）。
        const srcAbs = resolve(String(file))
        // ⚠️ 两边都要 `resolve`：`stickerRoot()` 在 workspace 是相对路径时返回**相对**路径
        //    （`config.json` 里默认就是 `workspace-qq`），而 `file` 是绝对的 ——
        //    不转换就会判不出"源在库里"，这个缺陷只在真实使用时才暴露。
        const rootAbsLocal = resolve(root)
        const knownAbs = resolve(join(rootAbsLocal, ...String(known).split('/')))
        const inLibrary = srcAbs === rootAbsLocal || srcAbs.startsWith(rootAbsLocal + sep)
        if (inLibrary && srcAbs !== knownAbs) {
          let removed = false
          try {
            unlinkSync(srcAbs)
            removed = !existsSync(srcAbs) // ★ 删完**再验一遍**（Windows 上静默失败是本项目的老坑）
          } catch {
            removed = false
          }
          if (removed) {
            droppedInLibrary += 1
            skipped.push({ file: String(file), reason: `与库里已有条目内容相同，且它本来就在库里 → 已收掉这份多余的（${known}）`, deduped: true, removed: true })
            continue
          }
        }
        skipped.push({ file: String(file), reason: `与库里已有条目内容相同（${known}）`, deduped: true })
        continue
      }

      // ② 近重复：重压缩/重导出的近似副本（内容哈希挡不住这类）
      //
      // ★★ 两个"指纹不可用"的形状必须排除，否则会**误删真图**（实测踩到过）：
      //   · **纯色图**：aHash 对纯色退化成同一个值（见 `aHashFromLuma` 的长注释），
      //     纯红与纯蓝的指纹都是 `0000000000000000`；
      //   · 指纹解不出来（JPEG/WebP 之类）→ 本来就没有 aHash。
      //   所以判据是"两边指纹都非平坦、且内容哈希不同"，才敢判近似重复。
      const aHash = declaredHashes[file] ?? declaredHashes[String(file)] ?? null
      if (aHash && !isFlatFingerprint(aHash)) {
        const twin = hashes.find((h) => !isFlatFingerprint(h.hash) && hammingDistance(h.hash, aHash) <= NEAR_DUPLICATE_DISTANCE)
        if (twin) {
          nearDuplicate += 1
          skipped.push({ file: String(file), reason: `与 ${twin.rel} 近似重复（汉明距离 ≤ ${NEAR_DUPLICATE_DISTANCE}）`, nearDuplicate: true })
          continue
        }
      }

      const ext = MEDIA_TYPE_EXT[mediaType]
      const name = `${id.slice(0, 16)}.${ext}`
      const rel = `${scope}/${name}`
      const abs = join(root, scope, name)

      try {
        mkdirSync(dirAbs, { recursive: true })
        writeFileSync(abs, bytes, { flag: 'wx' })
      } catch (error) {
        if (error?.code === 'EEXIST') {
          deduped += 1
          continue
        }
        skipped.push({ file: String(file), reason: `写入失败：${error?.message ?? error}` })
        continue
      }

      // 标签：显式给了才写；没给就落待定（离线打标签脚本随后补）
      const primary =
        labelIdOf(batch?.primary, { workspace, dir }) ?? primaryFromLabels(batch?.labels, { workspace, dir })
      const labels = normalizeLabelList(batch?.labels, primary, { workspace, dir })
      const confidence = Number(batch?.confidence)
      const entry = {
        id,
        file: rel,
        mediaType,
        bytes: bytes.byteLength,
        aHash: aHash ?? null,
        // ★★ 记下**原始文件名**（0.2.4 补）。
        //
        // 为什么必须留着：落盘名是**内容哈希**（`7405d3613e866cfa.gif`），
        // 于是"这张图是什么"这条信息在入库那一刻就丢了 —— 而表情包的原始文件名
        // **常常自带语义**（`蓝色大肥鱼_笑_….gif`、`…_问号_….gif`），那是打包者
        // 写的描述，比模型猜的准、而且不花钱。实测：157 张真实 GIF 里，
        // 没有这个字段时文件名先验**一张都定不下来**（全是哈希名）。
        //
        // ⚠️ 它只是元数据，**不参与选图**（选图靠标签），所以留着零成本。
        originName: originalNameOf(file),
        // ★★ 顺便**预判一下文件名先验会怎么打**（0.2.4 实测后补）。
        //
        // 为什么在入库时就存下这个：识图那条路对表情包**经常判错**
        // （实测 deepseek-flash：`问号`→被萌到、`一切都好`(OK 手势)→无语），
        // 而文件名先验往往更准（文件名是打包者写的）。两者不一致的那些，
        // 就是**最值得人看一眼**的样本 —— 存下 hint，打标签时才能把冲突挑出来，
        // 而不是让人把整库 157 张挨个看一遍。
        //
        // ⚠️ 这里**只记录不应用**（应用是 `sticker-tagging.tagFromFilenames` 的事）：
        //    入库阶段不该顺手写标签，那会让"图从哪来"和"谁打的标签"两件事混在一起。
        originHint: null, // 由调用方（打标签流程）填入，见 tagFromFilenames / runTagging
        labels,
        primary,
        primaryConfidence: Number.isFinite(confidence) ? confidence : null,
        addedAt: new Date().toISOString(),
        lastUsedAt: null,
        usedCount: 0,
        source: String(batch?.source ?? 'import'),
      }
      library.entries[rel] = entry
      byContent.set(id, rel)
      if (aHash) hashes.push({ rel, hash: aHash })

      if (!isUsable(entry)) {
        library.pending[rel] = { reason: primary ? '置信度过低' : '没有可用标签', at: entry.addedAt }
      }
      added += 1
    }
  }

  const written = writeStickerLibrary({ workspace, dir }, library)
  return {
    added,
    deduped,
    nearDuplicate,
    droppedInLibrary,
    skipped,
    entries: library.entries,
    written,
  }
}

/** 原始文件名（只取 basename，去掉目录与扩展名）—— 存进条目，供"文件名先验"用。 */
export function originalNameOf(file) {
  const raw = String(file ?? '')
  if (!raw) return ''
  const base = raw.split(/[\\/]/).pop() ?? ''
  return base.replace(/\.[a-z0-9]{1,5}$/i, '')
}

/**
 * 生效词表里的标签 id 归一器（与静态 `normalizeLabelId` 的区别：**认新标签**）。
 *
 * `opts` 是 `{ workspace, dir }`；**不传就按内置默认表判**（离线脚本、测试用）。
 */
function labelIdOf(input, opts) {
  return resolveActiveLabelId(input, opts)
}

/** 从标签列表里挑主标签（按词表顺序，保证稳定）。 */
export function primaryFromLabels(labels, opts = undefined) {
  const ids = opts ? activeLabelIds(opts) : STICKER_LABEL_IDS
  const key = (v) => resolveActiveLabelId(v, opts)
  const set = new Set((Array.isArray(labels) ? labels : []).map(key).filter(Boolean))
  for (const id of ids) if (set.has(id)) return id
  return null
}

/** 归一标签列表：去重、只留词表内、稳定排序。 */
export function normalizeLabelList(labels, primary = null, opts = undefined) {
  const out = []
  const push = (v) => {
    const id = labelIdOf(v, opts)
    if (id && !out.includes(id)) out.push(id)
  }
  if (primary) push(primary)
  for (const l of Array.isArray(labels) ? labels : []) push(l)
  return out
}

/** 这条目是否**可用**（有主标签且置信度够）。 */
export function isUsable(entry) {
  if (!entry || !entry.primary) return false
  const conf = entry.primaryConfidence
  if (conf != null && Number(conf) < MIN_TAG_CONFIDENCE) return false
  return true
}

/**
 * 给一批条目打标签（打标签脚本、控制台按钮与**手工编辑**共用一个入口）。
 *
 * ★★ `strict`（手工编辑时用）= **认不出就报错，不写入**。
 *
 * 为什么需要这个模式（实测踩过）：`normalizeLabelId('鼓励')` 返回 null
 * （词表里根本没有这个标签），而默认路径会把它当成"没有主标签"→ **静默落待定**。
 * 人手工写错一个词，看到的只是"这张图没生效"，根本猜不到是拼写问题。
 * 所以人手工改的那条路径必须**大声报错**。
 *
 * @param {{ workspace: string, dir?: string }} opts
 * @param {Record<string, {primary?:string, labels?:string[], confidence?:number, source?:string}>} updates
 * @param {{ strict?: boolean }} [options]
 */
export function applyStickerLabels(
  { workspace, dir = STICKER_DIR } = {},
  updates = {},
  { strict = false, vocab = true } = {},
) {
  const library = readStickerLibrary({ workspace, dir })
  // ★ 校验用的词表：默认走**生效词表**（认新标签）。需要"只认内置表"的老行为时传 `vocab: false`。
  const vocabOpts = vocab ? { workspace, dir } : undefined
  const changed = []
  const unknown = []
  const missing = []
  for (const [rel, patch] of Object.entries(updates ?? {})) {
    const entry = library.entries[rel]
    if (!entry) {
      missing.push(rel)
      continue
    }
    // ★ 校验：认不出的标签名要**指出来**（而不是静默变成"没标签"）
    const rawPrimary = String(patch?.primary ?? '').trim()
    const primary = labelIdOf(rawPrimary, vocabOpts)
    if (rawPrimary && !primary) unknown.push({ rel, field: 'primary', value: rawPrimary })
    const rawLabels = Array.isArray(patch?.labels) ? patch.labels : []
    const cleanLabels = []
    for (const raw of rawLabels) {
      const id = labelIdOf(raw, vocabOpts)
      if (!id) {
        if (String(raw ?? '').trim()) unknown.push({ rel, field: 'labels', value: String(raw) })
        continue
      }
      if (!cleanLabels.includes(id)) cleanLabels.push(id)
    }
    if (strict && unknown.some((u) => u.rel === rel)) continue // 严格模式：这一条不写

    entry.labels = normalizeLabelList(cleanLabels, primary, vocabOpts)
    entry.primary = primary
    const conf = Number(patch?.confidence)
    entry.primaryConfidence = Number.isFinite(conf) ? conf : entry.primaryConfidence
    // ★ 人工改的标成 manual（重打标签时默认跳过；见 `sticker-tagging.isManualEntry`）
    if (patch?.source) entry.source = String(patch.source)
    else if (primary && !entry.source) entry.source = 'tag'
    // ★ "与文件名先验冲突"的标记（0.2.4 补）：识图判错是常态（实测 deepseek-flash
    //   把「问号」判成被萌到、「一切都好」判成无语），而文件名先验往往更准。
    //   两者不一致的样本**最值得人看一眼** —— 这个标记就是给标注台筛出那批用的。
    if (patch?.originHint !== undefined) entry.originHint = patch.originHint ?? null
    if (patch?.disputed !== undefined) entry.disputed = patch.disputed === true
    // ★ 风险标记（`risky: true` = 慎发）：由打标签那一步写进来，
    //   选图时默认把它挡在外面（见 buildStickerSelection 与 allowRisky）。
    if (patch?.risky !== undefined) entry.risky = patch.risky === true
    entry.taggedAt = new Date().toISOString()
    if (isUsable(entry)) delete library.pending[rel]
    else library.pending[rel] = { reason: entry.primary ? '置信度过低' : '没有可用标签', at: entry.taggedAt }
    changed.push(rel)
  }
  const written = changed.length ? writeStickerLibrary({ workspace, dir }, library) : { ok: true, skipped: 'nothing-to-write' }
  return { changed: changed.length, changedRels: changed, unknown, missing, written, library }
}

/* ────────────────────────────────────────────────────────────────────────
 * 查询与选图输入
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 把一个标签从**库里所有条目**上摘掉（删除标签时用）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（用户明确要求的行为）
 * ══════════════════════════════════════════════════════════════════════════
 * 删掉一个标签之后，库里那些**引用它的图**必须落到一个明确的状态，
 * 否则会变成"引用已删标签"的孤儿：界面能列出来（我做了），但谁也说不清
 * 它们算不算有标签、该不该参与选图。用户的要求是把它们**恢复成未标注**，
 * 也就是回到"还没打标签"的状态：不会被选中，等着被重新标。
 *
 * ── 落到未标注要做三件事（少一件都会留下"看着没标签、其实还能用"的怪状态）──
 *   ① `primary` 清空  —— 没有主标签
 *   ② `labels` 里去掉它（它还可能是别人的**次要标签**）
 *   ③ `primaryConfidence` 清成 0 —— ★ 这一条最容易漏：
 *      `isUsable()` 的判据是"有 primary 且置信度够"，只清 primary 而不清置信度，
 *      条目会带着上一次打分留在库里，语义含混（而且重打标签时容易被跳过）。
 *
 * ★ **两种引用都要处理**，而且语义不同：
 *   · 它当**主标签** → 整条清成未标注；
 *   · 它只当**次要标签** → 只从 `labels` 里摘掉，主标签**不动**
 *     （否则"删掉一个次要标签"会顺手把主标签也毁了 —— 那是数据事故）。
 *
 * @returns {{ ok:boolean, why?:string, changed:number, rels:string[], primaryCleared:number, secondaryOnly:number, emptied:string[] }}
 */
export function clearLabelFromLibrary({ workspace, dir = STICKER_DIR } = {}, labelId) {
  const id = String(labelId ?? '').trim()
  if (!id) return { ok: false, why: '没有给标签 id', changed: 0, rels: [], primaryCleared: 0, secondaryOnly: 0, emptied: [] }
  const library = readStickerLibrary({ workspace, dir })
  const rels = []
  let primaryCleared = 0
  let secondaryOnly = 0
  const updates = {}

  for (const [rel, entry] of Object.entries(library.entries)) {
    const wasPrimary = entry.primary === id
    const labels = Array.isArray(entry.labels) ? entry.labels : []
    const wasSecondary = labels.includes(id)
    if (!wasPrimary && !wasSecondary) continue
    if (wasPrimary) {
      primaryCleared += 1
      updates[rel] = { primary: '', labels: labels.filter((x) => x !== id), confidence: 0, source: 'manual' }
    } else {
      secondaryOnly += 1
      updates[rel] = { primary: entry.primary ?? '', labels: labels.filter((x) => x !== id), source: 'manual' }
    }
    rels.push(rel)
  }
  if (!rels.length) {
    return { ok: true, changed: 0, rels: [], primaryCleared: 0, secondaryOnly: 0, emptied: [] }
  }
  const r = applyStickerLabels({ workspace, dir }, updates)
  // 清完之后谁真的空了（用于如实回报；`pending` 就是"没有可用标签"的那批）
  const after = readStickerLibrary({ workspace, dir })
  const emptied = rels.filter((rel) => !after.entries[rel]?.primary)
  return { ok: true, changed: r.changed, rels, primaryCleared, secondaryOnly, emptied }
}

/** 每个主标签当前有多少张**可用**图（`ids` 不传 = 内置表；传生效表才能统计到新标签）。 */
export function labelCoverage(library, ids = STICKER_LABEL_IDS) {
  const counts = Object.fromEntries(ids.map((id) => [id, 0]))
  for (const entry of Object.values(library?.entries ?? {})) {
    if (!isUsable(entry)) continue
    if (entry.primary in counts) counts[entry.primary] += 1
  }
  return counts
}

/**
 * 库的健康度（给日志、控制台与提示词用）。
 *
 * 三个数直接对应三类真实故障：
 *   · `usableLabels` 空 → 一次都发不出去（提示词也不该提这个功能）；
 *   · 单标签占比过高（`monopoly`）→ 反复发同一类脸；
 *   · `pending` 多 → 打标签没打上，图白导入了。
 */
export function libraryHealth(library, { minPerLabel = 3, monopolyRatio = 0.3, ids = STICKER_LABEL_IDS } = {}) {
  const coverage = labelCoverage(library, ids)
  const usableLabels = Object.entries(coverage)
    .filter(([, n]) => n > 0)
    .map(([id]) => id)
  const healthyLabels = Object.entries(coverage)
    .filter(([, n]) => n >= minPerLabel)
    .map(([id]) => id)
  const total = Object.values(coverage).reduce((s, n) => s + n, 0)
  const top = Object.entries(coverage).sort((a, b) => b[1] - a[1])[0] ?? null
  const monopoly = total > 0 && top && top[1] / total > monopolyRatio ? top[0] : null
  return {
    total,
    usableLabels,
    healthyLabels,
    coverage,
    pending: Object.keys(library?.pending ?? {}).length,
    monopoly,
  }
}

/**
 * **能发出去的**字节上限 —— **兜底用的宽松值**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么必须有这条，以及为什么它**必须宽松**（实测把第一版推翻了）
 * ══════════════════════════════════════════════════════════════════════════
 * 发送是 `POST /send_private_msg`，图片以 **base64** 塞在 JSON body 里，
 * base64 涨约 1/3（8MB 的 GIF → 11MB 请求）。所以留一条上限兜底是合理的 ——
 * 它防的是**误导入的超大文件**（整段视频转的 GIF、几千帧的长动画）。
 *
 * ⚠️ 但第一版设成 **2MB** 是**基于猜测**的保守值，代价很重：
 *   实测用户库里 155 张有 **115 张超标**被排除，于是 `tired / agree / slack`
 *   等标签**一张都发不出去** —— 比"发大图慢一点"糟得多。
 *   而实测协议端**根本不看体积**：5.07MB（base64 6.76MB）**453ms** 上传成功
 *   （`snowluma` 日志：`[Highway.Image] uploading 5319636 bytes … fast-upload hit`）。
 *
 * ∴ 默认给 50MB（约等于不拦）。**别再把这条收紧成"看起来合理"的小值**：
 *   它换来的不是可靠性，而是"图明明在库里却挑不中"。
 *   真要收紧，先跑 `--stickers --list` 看会不会把某个标签掏空。
 */
export const DEFAULT_MAX_SEND_BYTES = 50 * 1024 * 1024

/**
 * 选图输入：某会话可用的候选（含作用域加权信息），**不做打分**。
 *
 * ★★ 作用域规则（这里是最容易出"发错图"的地方）
 *   只收**本会话**与**全局兜底**两类，**别的会话的图一律不进候选**。
 *   理由：表情包是"群里的梗"，A 群的表情发到 B 群在少数场合会真的尴尬，
 *   而这种错误无法解释、撤不回。代价是新群在攒够自己的图之前，
 *   如果全局库也没货，就一次都发不出来 —— 那正是"低于阈值就不发"的选择。
 *
 * ★★ 送出上限（`maxSendBytes`，0.2.4 补）：**超标的图不进候选**（理由见常量注释）。
 *   被滤掉多少张会在返回里如实报出来（`skippedOversize`），调用方要把它写进日志 ——
 *   否则"库里明明有 155 张却挑不中"会变成一个查不出来的谜。
 *
 * 加权（数字越大越优先）：本会话 1 / 全局兜底 0。
 *
 * @returns {Array<{entry:object, scopeRank:number, absPath:string}>}
 *   为了让调用方拿到过滤统计，函数上挂了 `stats` 字段（数组是返回值，不能直接加属性时
 *   用 `buildStickerSelection()` 取结构化结果）。
 */
export function buildStickerCandidates({ workspace, dir = STICKER_DIR, scope = GLOBAL_SCOPE, maxSendBytes = DEFAULT_MAX_SEND_BYTES, allowRisky = false } = {}) {
  const selection = buildStickerSelection({ workspace, dir, scope, maxSendBytes, allowRisky })
  return selection.candidates
}

/**
 * 与 `buildStickerCandidates` 同一实现，但返回**候选 + 过滤统计**（给日志用）。
 *
 * @param {{ allowRisky?: boolean }} [opts] `allowRisky: true` 时才允许"慎发"类的图参与
 *   （默认 false —— 见下面那段"风险图默认不发"的说明）
 */
export function buildStickerSelection({
  workspace,
  dir = STICKER_DIR,
  scope = GLOBAL_SCOPE,
  maxSendBytes = DEFAULT_MAX_SEND_BYTES,
  allowRisky = false,
} = {}) {
  const empty = { candidates: [], total: 0, skippedOversize: 0, skippedRisky: 0, oversizeExamples: [] }
  const root = stickerRoot({ workspace, dir })
  if (!root) return empty
  const library = readStickerLibrary({ workspace, dir })
  const mine = scopeDirName(scope)
  const candidates = []
  const oversizeExamples = []
  let skippedOversize = 0
  let skippedRisky = 0
  let total = 0
  const cap = Number(maxSendBytes) > 0 ? Number(maxSendBytes) : DEFAULT_MAX_SEND_BYTES
  for (const entry of Object.values(library.entries)) {
    if (!isUsable(entry)) continue
    const scopeName = String(entry.file ?? '').split('/')[0]
    if (scopeName !== mine && scopeName !== GLOBAL_SCOPE) continue
    total += 1
    // ★★ 风险图**默认不发**（0.2.4 补）。
    //
    // 为什么放在"建候选"这一层而不是打分里：它是一条**安全闸门**，不是偏好 ——
    // 打分可能因为"本会话 +3"把一张脏话图顶到第一，而这类图的后果是
    // **账号被处置**（本项目最不能接受的一类事故）。所以它和"超标图"一样：
    // **根本不进候选**，而不是"进去了但分数低"。
    //
    // 开关是 `skills.sticker.allowRisky`（默认 false）。打开它的语义是
    // "我知道库里有这类图，且我愿意让它发" —— 那是一个显式的、有后果的选择。
    if (!allowRisky && isRiskyEntry(entry)) {
      skippedRisky += 1
      continue
    }
    // ★ 超出发送上限 → **不进候选**（不是"选出来再失败"）
    if ((entry.bytes ?? 0) > cap) {
      skippedOversize += 1
      if (oversizeExamples.length < 5) {
        oversizeExamples.push(`${entry.originName || entry.file}（${Math.round((entry.bytes ?? 0) / 1024 / 1024 * 10) / 10}MB）`)
      }
      continue
    }
    candidates.push({ entry, scopeRank: scopeName === mine ? 1 : 0, absPath: join(root, entry.file) })
  }
  return { candidates, total, skippedOversize, skippedRisky, oversizeExamples, cap }
}

/**
 * 记录一次**真正发成功**的表情（用量台账）。
 *
 * ⚠️ 只在发送成功后调用（与 `SendQueue.markSent` 同一纪律：先记账会让去重窗口
 *    把"还没发出去的"当成已发）。
 */
export function markStickerSent({ workspace, dir = STICKER_DIR } = {}, { rel, chatKey, scope, shownText = '' } = {}) {
  const library = readStickerLibrary({ workspace, dir })
  const entry = library.entries[rel]
  if (!entry) return { ok: false, reason: '库里没有这条' }
  const at = new Date().toISOString()
  entry.lastUsedAt = at
  entry.usedCount = Number(entry.usedCount ?? 0) + 1
  // 每个会话的独立计时：同一张图在 A 群刚用过，不该影响 B 群
  entry.lastUsedByScope = { ...(entry.lastUsedByScope ?? {}), [scopeDirName(scope)]: at }
  writeStickerLibrary({ workspace, dir }, library)
  return { ok: true, at, shownText }
}

/** 记录一次发送失败（进冷却；失败**也算**消耗了一次配额）。 */
export function markStickerFailed({ workspace, dir = STICKER_DIR } = {}, { rel } = {}) {
  const library = readStickerLibrary({ workspace, dir })
  const entry = library.entries[rel]
  if (!entry) return { ok: false }
  entry.failedAt = new Date().toISOString()
  entry.failedCount = Number(entry.failedCount ?? 0) + 1
  writeStickerLibrary({ workspace, dir }, library)
  return { ok: true }
}

/** 追加一行决策流水（JSONL，最多留 `MAX_DECISION_LINES` 行）。 */
export function appendStickerDecision({ workspace, dir = STICKER_DIR } = {}, record) {
  const root = stickerRoot({ workspace, dir })
  if (!root) return { ok: false }
  const file = join(root, DECISION_LOG_FILE)
  try {
    let lines = []
    if (existsSync(file)) {
      lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    }
    lines.push(JSON.stringify(record))
    if (lines.length > MAX_DECISION_LINES) lines = lines.slice(-MAX_DECISION_LINES)
    ensureDirFor(file)
    writeFileSync(file, `${lines.join('\n')}\n`, 'utf8')
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/** 读决策流水（最近 N 条，最新在前）。 */
export function readStickerDecisions({ workspace, dir = STICKER_DIR } = {}, limit = 50) {
  const root = stickerRoot({ workspace, dir })
  if (!root) return []
  const file = join(root, DECISION_LOG_FILE)
  if (!existsSync(file)) return []
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    return lines
      .slice(-Math.max(1, Number(limit) || 50))
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return { raw: l }
        }
      })
  } catch {
    return []
  }
}

/**
 * 清理：文件已经不在库里的条目（人工删图后留下的僵尸条目）。
 *
 * 为什么不自动做：删库是破坏性动作，由 `--stickers --prune` 显式触发（默认预演）。
 */
export function findMissingStickerFiles({ workspace, dir = STICKER_DIR } = {}) {
  const root = stickerRoot({ workspace, dir })
  if (!root) return []
  const library = readStickerLibrary({ workspace, dir })
  const missing = []
  for (const entry of Object.values(library.entries)) {
    const abs = join(root, entry.file)
    if (!existsSync(abs)) {
      missing.push(entry.file)
      continue
    }
    try {
      if (!statSync(abs).isFile()) missing.push(entry.file)
    } catch {
      missing.push(entry.file)
    }
  }
  return missing
}

/**
 * 找出库里**没有索引指向的多余副本**（0.2.4 补：导入去重留下的垃圾）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（这是实测抓到的一处真实库污染，不是洁癖）
 * ══════════════════════════════════════════════════════════════════════════
 * 用户第二次导入时往往会把**库目录本身**当源再导一遍。去重在"内容已存在"
 * 处 `continue`，于是既不复制也不删除 —— 那批原始文件永久留在库里，
 * 而 `library.json` 里一条都不指向它们。
 *
 * 实测规模：157 张库里躺着 **157 个字节完全相同的副本、460MB**（占全库一半），
 * 而界面与命令行**都看不见**（索引里没有它们，所有统计都按索引算）。
 *
 * ── 判据刻意收紧到"内容与某个已索引文件逐字节相同" ──────────────────────
 * 只删**能证明是多余副本**的：拿它算内容哈希，命中已索引条目才算。
 * 于是"用户自己放进库里的、还没导入的图"**不会被误删**（那种没有索引对应，
 * 但也不该在这一步消失 —— 它们该走导入流程）。
 *
 * ★ 默认**预演**（`apply: false`），和 `pruneStickerEntries` 同一纪律。
 */
export function findOrphanStickerFiles({ workspace, dir = STICKER_DIR } = {}, { apply = false } = {}) {
  const root = stickerRoot({ workspace, dir })
  if (!root) return { ok: false, why: '没有工作区，读不到表情库', orphans: [], bytes: 0, removed: 0 }
  const library = readStickerLibrary({ workspace, dir })
  // 已索引文件的内容哈希 → 它索引里的相对路径（用来证明"这份是多余的"）
  const indexedHash = new Map()
  for (const rel of Object.keys(library.entries)) {
    const abs = join(root, ...rel.split('/'))
    if (!existsSync(abs)) continue
    try {
      indexedHash.set(contentIdOf(readFileSync(abs)), rel)
    } catch {
      /* 读不了就跳过，不让一条坏文件毁掉整次核对 */
    }
  }
  const orphans = []
  let bytes = 0
  const walk = (d, depth) => {
    if (depth > 4) return
    let items = []
    try {
      items = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of items) {
      const abs = join(d, it.name)
      if (it.isDirectory()) {
        walk(abs, depth + 1)
        continue
      }
      if (!IMAGE_EXT_RE.test(it.name)) continue
      const rel = relative(root, abs).split(sep).join('/')
      if (library.entries[rel]) continue // 索引指向它 → 不是垃圾
      let buf
      try {
        buf = readFileSync(abs)
      } catch {
        continue
      }
      const twin = indexedHash.get(contentIdOf(buf))
      if (!twin) continue // 内容对不上任何索引条目 → **不动**（可能是用户还没导入的图）
      orphans.push({ rel, bytes: buf.byteLength, twin })
      bytes += buf.byteLength
    }
  }
  walk(root, 0)

  let removed = 0
  if (apply) {
    for (const o of orphans) {
      const abs = join(root, ...o.rel.split('/'))
      try {
        // ★ Windows 上 `rmSync` 删单文件会静默失败（本项目第 5 次踩），所以用 unlinkSync + 删完再验
        unlinkSync(abs)
        if (!existsSync(abs)) removed += 1
      } catch {
        /* 删不掉就留着，下一次再收 */
      }
    }
  }
  return { ok: true, orphans, bytes, removed, twinCount: indexedHash.size }
}

/** 删除条目（预演返回将被删的列表；`apply: true` 才真删）。 */
export function pruneStickerEntries({ workspace, dir = STICKER_DIR } = {}, { files = [], apply = false } = {}) {  const library = readStickerLibrary({ workspace, dir })
  const removed = []
  for (const rel of files) {
    if (!library.entries[rel]) continue
    removed.push(rel)
    if (!apply) continue
    delete library.entries[rel]
    delete library.pending[rel]
    const abs = join(stickerRoot({ workspace, dir }), rel)
    try {
      // ★ Windows 上 rmSync 删单文件会静默失败（memory-files.mjs 踩过），用 unlinkSync
      if (existsSync(abs)) unlinkSync(abs)
    } catch {
      /* 删不掉就留着，下一轮再试 */
    }
  }
  if (apply && removed.length) writeStickerLibrary({ workspace, dir }, library)
  return { removed, applied: Boolean(apply) }
}

/** 库根目录相对工作区的路径（提示词/界面展示用）。 */
export function stickerRootRelative({ workspace, dir = STICKER_DIR } = {}) {
  const root = stickerRoot({ workspace, dir })
  if (!root) return ''
  try {
    return relative(String(workspace), root).replace(/\\/g, '/')
  } catch {
    return String(dir || STICKER_DIR)
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * 缩略图（给标注台的图墙用）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须有它（实测把浏览器卡死了一次）
 * ══════════════════════════════════════════════════════════════════════════
 * 图墙的第一版直接拿**原图**当缩略图 `<img src>`。实测点开一个标签：
 * `moved` 有 54 张，全是**动图 GIF**，合计 **159MB** —— 浏览器会把 54 个动画
 * 全部解码并同时播放，标签页直接卡死（不是"慢"，是连关闭按钮都点不动）。
 *
 * ∴ 图墙必须用小图。做法是**服务端先缩**：
 *   · PNG → 用已有的 `decodePngToLuma`（本文件里，为感知哈希写的）解出亮度，
 *     丢色度、缩到 ≤256px、写成灰度 PNG。表情包是给人看"这张是什么反应"用的，
 *     灰度小图完全够判断，而代码量只有几十行、零依赖。
 *   · 静态 GIF → 自己解 LZW 第一帧（**只要第一帧** —— 那正是要看的）。
 *   · 其它（动图/WebP/JPEG）→ 返回 null，调用方回落原图（图墙另有数量上限兜底）。
 *
 * ★ 结果**不落盘、只在内存里缓存**：缩略图是纯派生数据，重建成本很低，
 *   而写进库里会给"库目录 = 用户资产"这条边界添一个可以被删坏的东西。
 */

/**
 * 解 GIF 的**第一帧**为 RGB（保留这个入口是为了兼容既有调用与测试）。
 *
 * ⚠️ 它只解第一帧，而**多数表情包 GIF 的第一帧只覆盖画布的一小块**
 *   （实测 30 张里 24 张只覆盖 11%~42%）—— 拿它当缩略图会得到"一条窄条"。
 *   要显示"这张图长什么样"，用 `decodeGifThumbFrame`。
 *
 * @returns {{ width:number, height:number, rgb:Uint8Array }|null}
 */
export function decodeGifFirstFrame(bytes) {
  const g = decodeGifFrames(bytes, 1)
  return g ? { width: g.width, height: g.height, rgb: g.rgb } : null
}

/**
 * 解 GIF 并合成成一张"看得出内容"的静帧 —— **取最后一帧**（用户要求）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么不能只要第一帧（实测：缩略图全变成一条窄条）
 * ══════════════════════════════════════════════════════════════════════════
 * 表情包 GIF 绝大多数是"先画一块区域、再逐帧补细节"。实测这个库：
 * **30 张里 24 张的第一帧只覆盖画布的 11%~42%**，其余像素是空的 ——
 * 于是缩略图看着就是一条横条（用户看到的正是这个）。
 *
 * ── 为什么取**最后一帧**而不是"第一帧铺满就停" ──────────────────────────
 * 因为表情包的**完整画面在收尾那一帧**：前面几帧是过程（先画身体、再补表情、
 * 最后上高光）。停在中间会得到一张"画了一半"的图，比窄条好、但仍然不像那张图。
 * 所以：**从第一帧一路合成到最后一帧**，透明像素不覆盖（这是"逐帧补细节"
 * 能拼起来的前提），最后把整块画布当作这一张图的代表画面。
 *
 * ── 代价与上限（如实说）──────────────────────────────────────────────
 * 取最后一帧意味着要把**整段动画解一遍**。所以有两道闸：
 *   · `maxFrames`（默认 60）：超长动图（几百帧）就停在 60 帧，
 *     拿到的是"接近收尾"的画面 —— 比不解好，也不会为了几张缩略图把 CPU 烧掉；
 *   · `maxTotalDelay`（默认 0 = 不限）：想按"动画时长"截断时给个毫秒数，给 0 表示不限。
 * 缩略图本身还会进内存缓存，所以同一张只会这样解一次。
 *
 * ★ 仍然只支持全局/局部色表 + 无交错，认不出就返回 null（宁可回落原图，也不猜错颜色）。
 *
 * @param {Buffer} bytes
 * @param {{ maxFrames?: number, maxTotalDelay?: number }} [opts]
 * @returns {{ width:number, height:number, rgb:Uint8Array, framesUsed:number, totalDelay:number, truncated:boolean }|null}
 */
export function decodeGifThumbFrame(bytes, { maxFrames = 400, maxTotalDelay = 0 } = {}) {
  const g = decodeGifFrames(bytes, maxFrames, maxTotalDelay)
  if (!g) return null
  // ★ 裁掉**四周的空边**再返回。
  //   实测：不少表情包把 500×500 的画布只用了上半部分（下半部分全是"没画过"的像素），
  //   直接缩成缩略图 → 图里一半是空黑，看着就像"没显示出来"。
  //   裁边只去掉**外围**的空白，不会切到内容（保留内部原有的留白）。
  const cropped = cropEmptyMargins(g)
  return {
    width: cropped.width,
    height: cropped.height,
    rgb: cropped.rgb,
    framesUsed: g.framesUsed,
    totalDelay: g.totalDelay,
    // 解到帧数上限就停了 → 这张不是真正的收尾帧（如实报出来，便于排查）
    truncated: g.reachedLimit,
  }
}

/**
 * 裁掉合成画面四周的空边（**没被任何一帧画过**的像素）。
 *
 * 为什么要做：实测有些表情包把 500×500 画布只用了上面一半，下半部分像素从未被绘制
 * （透明且无背景色）—— 整张缩进缩略图后有一半是黑的，看起来像没加载出来。
 * 只裁外围、保留内部留白，所以不会破坏构图。
 *
 * @returns {{ width:number, height:number, rgb:Uint8Array }}
 */
function cropEmptyMargins({ width, height, rgb, painted }) {
  if (!painted) return { width, height, rgb }
  let top = 0
  let bottom = height - 1
  let left = 0
  let right = width - 1
  const rowHas = (y) => {
    for (let x = 0; x < width; x += 1) if (painted[y * width + x]) return true
    return false
  }
  const colHas = (x) => {
    for (let y = top; y <= bottom; y += 1) if (painted[y * width + x]) return true
    return false
  }
  while (top < bottom && !rowHas(top)) top += 1
  while (bottom > top && !rowHas(bottom)) bottom -= 1
  while (left < right && !colHas(left)) left += 1
  while (right > left && !colHas(right)) right -= 1
  const w = right - left + 1
  const h = bottom - top + 1
  // 一点边界保护：裁出来太离谱（几乎全空）就原样返回，别产出 1×1 的怪图
  if (w < 8 || h < 8 || w * h > width * height) return { width, height, rgb }
  const out = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y += 1) {
    const src = ((top + y) * width + left) * 3
    out.set(rgb.subarray(src, src + w * 3), y * w * 3)
  }
  return { width: w, height: h, rgb: out }
}

/**
 * GIF 解码器本体：解出前若干帧并合成成 RGB。
 *
 * @param {Buffer} bytes
 * @param {number} maxFrames 最多解几帧
 * @param {number} maxTotalDelay 累计延时到多少毫秒就停（0 = 只看帧数上限）
 */
function decodeGifFrames(bytes, maxFrames = 1, maxTotalDelay = 0) {
  try {
    const b = bytes
    if (b.length < 14 || b.toString('ascii', 0, 3) !== 'GIF') return null
    const width = b.readUInt16LE(6)
    const height = b.readUInt16LE(8)
    if (!width || !height || width > 8192 || height > 8192) return null

    const packed = b[10]
    // ⚠️ bit 7 = **有**全局色表（1 = 有）。第一版写成 `if (packed & 0x80) return null`
    //    —— 正好把"正常有全局色表的 GIF"全部拒掉，实测 8/8 全解不出来。
    const hasGlobal = (packed & 0x80) !== 0
    const bgIndex = b[11]
    let p = 13
    let globalTable = null
    if (hasGlobal) {
      const tableSize = 2 ** ((packed & 0x07) + 1)
      globalTable = b.subarray(p, p + tableSize * 3)
      p += tableSize * 3
    }

    let framesUsed = 0
    let totalDelay = 0
    let pendingDelayMs = 0
    /** 是否因为帧数/时长上限提前收工（那样拿到的不是真正的收尾帧）。 */
    let reachedLimit = false
    // 待生效的透明色索引：由图形控制扩展设置，只作用于**紧跟着的那一帧**，
    // 用完即清（否则会把后面所有帧都误判成透明）。
    let pendingTransparent = -1
    // ★ 画布**直接存 RGB**，不存索引：每帧可以用自己的**局部色表**，
    //   同一个索引在不同帧里可能是完全不同的颜色 —— 只留索引最后统一查表会染错色。
    const canvasRgb = new Uint8Array(width * height * 3)
    const painted = new Uint8Array(width * height) // 0 = 还没画过（末尾用背景色兜底）

    // ── 逐块读 ──
    let guard = 0
    while (p < b.length && guard++ < 200000) {
      const marker = b[p]
      if (marker === 0x3b) break // trailer
      if (marker === 0x21) {
        const label = b[p + 1]
        p += 2
        // 图形控制扩展（0xF9）：延时 + 透明色索引（在图像描述符**之前**出现）
        if (label === 0xf9) {
          const blockSize = b[p]
          if (blockSize >= 4) {
            const flags = b[p + 1]
            pendingDelayMs = b.readUInt16LE(p + 2) * 10
            if (flags & 0x01) pendingTransparent = b[p + 4]
          }
        }
        // 跳过所有子块
        while (p < b.length && b[p] !== 0) p += b[p] + 1
        p += 1
        continue
      }
      if (marker !== 0x2c) return null // 不认识的结构 → 不猜

      // ── 图像描述符 ──
      if (p + 10 > b.length) break
      const ix = b.readUInt16LE(p + 1)
      const iy = b.readUInt16LE(p + 3)
      const iw = b.readUInt16LE(p + 5)
      const ih = b.readUInt16LE(p + 7)
      const ipacked = b[p + 9]
      p += 10
      if (!iw || !ih) return null
      if (ipacked & 0x40) return null // 交错：少见，放弃（宁可不显示，也不显示错位的图）
      let colorTable = globalTable
      let transparent = pendingTransparent
      pendingTransparent = -1
      if (ipacked & 0x80) {
        const localSize = 2 ** ((ipacked & 0x07) + 1)
        colorTable = b.subarray(p, p + localSize * 3)
        p += localSize * 3
      }
      if (!colorTable || colorTable.length < 3) return null

      // ── LZW 数据（最小码长 + 子块）──
      if (p >= b.length) break
      const minCodeSize = b[p]
      if (!minCodeSize || minCodeSize > 8) return null
      p += 1
      const chunks = []
      while (p < b.length && b[p] !== 0) {
        const len = b[p]
        if (p + 1 + len > b.length) break
        chunks.push(b.subarray(p + 1, p + 1 + len))
        p += len + 1
      }
      p += 1 // 块终止符
      const data = Buffer.concat(chunks)
      if (!data.length) return null
      const idx = lzwDecodeIndices(data, minCodeSize, iw * ih)
      if (!idx) return null

      // ── 合成到画布：**透明像素不覆盖**（这才是"逐帧补细节"能拼起来的原因）──
      //
      // ★ 这里**直接转成 RGB 再画**，而不是把索引记在画布上：
      //   每帧可以用自己的**局部色表**，同一个索引在不同帧里可能是完全不同的颜色 ——
      //   只留索引的话，最后统一查表会把先画的帧染成错的颜色。
      for (let y = 0; y < ih; y += 1) {
        const dy = iy + y
        if (dy < 0 || dy >= height) continue
        for (let x = 0; x < iw; x += 1) {
          const dx = ix + x
          if (dx < 0 || dx >= width) continue
          const v = idx[y * iw + x]
          if (v === transparent) continue // 透明 = 保留下面已经画好的内容
          const off = v * 3
          if (off + 2 >= colorTable.length) continue // 索引越界：不猜颜色
          const d = (dy * width + dx) * 3
          canvasRgb[d] = colorTable[off]
          canvasRgb[d + 1] = colorTable[off + 1]
          canvasRgb[d + 2] = colorTable[off + 2]
          painted[dy * width + dx] = 1
        }
      }
      framesUsed += 1
      totalDelay += pendingDelayMs
      pendingDelayMs = 0
      // ★ 达到帧数上限就停 —— 如实标记 `reachedLimit`，
      //   因为这时候拿到的**不是真正的收尾帧**（调用方可能要据此说明）。
      if (framesUsed >= maxFrames) {
        reachedLimit = true
        break
      }
      if (maxTotalDelay > 0 && totalDelay >= maxTotalDelay) {
        reachedLimit = true
        break
      }
    }

    if (!framesUsed) return null
    // 没被任何一帧画到的像素用**背景色**兜底（没全局色表就留黑）
    if (globalTable && bgIndex * 3 + 2 < globalTable.length) {
      for (let k = 0; k < width * height; k += 1) {
        if (painted[k]) continue
        canvasRgb[k * 3] = globalTable[bgIndex * 3]
        canvasRgb[k * 3 + 1] = globalTable[bgIndex * 3 + 1]
        canvasRgb[k * 3 + 2] = globalTable[bgIndex * 3 + 2]
      }
    }
    return { width, height, rgb: canvasRgb, framesUsed, totalDelay, reachedLimit, painted }
  } catch {
    return null
  }
}

/**
 * GIF 的 LZW 解码（GIF 变体：LSB-first 位序、clear/end 码、KwKwK 特例）。
 *
 * 抽成独立函数是因为**每个帧都有一段自己的 LZW 流**，而合成多帧要反复解。
 *
 * @param {Buffer} data 拼好的 LZW 数据（各子块已连接）
 * @param {number} minCodeSize 最小码长（GIF 里是 2~8）
 * @param {number} expected 期望解出多少像素（帧宽×帧高）
 * @returns {Uint8Array|null} 颜色索引；失败/异常返回 null（宁可回落原图也不猜）
 */
function lzwDecodeIndices(data, minCodeSize, expected) {
  try {
    const clearCode = 1 << minCodeSize
    const endCode = clearCode + 1
    const prefix = new Int32Array(4096).fill(-1)
    const suffix = new Uint8Array(4096)
    const first = new Uint8Array(4096)
    let codeSize = minCodeSize + 1
    let next = endCode + 1
    const resetDict = () => {
      for (let i = 0; i < clearCode; i += 1) {
        prefix[i] = -1
        suffix[i] = i
        first[i] = i
      }
      for (let i = clearCode; i < 4096; i += 1) prefix[i] = -1
      codeSize = minCodeSize + 1
      next = endCode + 1
    }
    resetDict()

    const out = new Uint8Array(expected)
    let npix = 0
    let bitPos = 0
    let prev = -1
    const totalBits = data.length * 8
    const stack = new Uint8Array(4096)

    while (bitPos + codeSize <= totalBits && npix < out.length) {
      // GIF 的 LZW 是 **LSB-first**
      let code = 0
      for (let k = 0; k < codeSize; k += 1) {
        const bit = bitPos + k
        if (data[bit >> 3] & (1 << (bit & 7))) code |= 1 << k
      }
      bitPos += codeSize
      if (code === clearCode) {
        resetDict()
        prev = -1
        continue
      }
      if (code === endCode) break

      let sp = 0
      let cur
      if (code < next && (code < clearCode || prefix[code] !== -1)) {
        cur = code
      } else if (prev >= 0 && code === next) {
        // ★ KwKwK 特例：码还没进字典，语义是"prev 的串 + prev 的首字符"。
        //   少了这一支，含重复模式的图会解错或直接失败。
        cur = prev
        while (cur >= 0 && sp < 4096) {
          stack[sp++] = suffix[cur]
          cur = prefix[cur]
        }
        for (let k = 0; k < sp; k += 1) {
          if (npix < out.length) out[npix++] = stack[sp - 1 - k]
        }
        if (npix < out.length) out[npix++] = first[prev]
        if (next < 4096) {
          prefix[next] = prev
          suffix[next] = first[prev]
          first[next] = first[prev]
          next += 1
          if (next === 1 << codeSize && codeSize < 12) codeSize += 1
        }
        continue
      } else {
        return null // 非法码 → 不猜
      }

      sp = 0
      while (cur >= 0 && sp < 4096) {
        stack[sp++] = suffix[cur]
        cur = prefix[cur]
      }
      for (let k = 0; k < sp; k += 1) {
        if (npix < out.length) out[npix++] = stack[sp - 1 - k]
      }
      if (prev >= 0 && next < 4096) {
        prefix[next] = prev
        suffix[next] = stack[sp - 1]
        first[next] = first[prev]
        next += 1
        if (next === 1 << codeSize && codeSize < 12) codeSize += 1
      }
      prev = code
    }
    return npix ? out : null
  } catch {
    return null
  }
}

/** 把 RGB 缓冲按整数倍缩小（盒式平均；`factor` 由调用方算好）。 */
function shrinkRgb(rgb, width, height, factor) {  const w = Math.max(1, Math.floor(width / factor))
  const h = Math.max(1, Math.floor(height / factor))
  const out = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r = 0
      let g = 0
      let bl = 0
      let n = 0
      for (let dy = 0; dy < factor; dy += 1) {
        const sy = y * factor + dy
        if (sy >= height) break
        for (let dx = 0; dx < factor; dx += 1) {
          const sx = x * factor + dx
          if (sx >= width) break
          const s = (sy * width + sx) * 3
          r += rgb[s]
          g += rgb[s + 1]
          bl += rgb[s + 2]
          n += 1
        }
      }
      const d = (y * w + x) * 3
      out[d] = n ? Math.round(r / n) : 0
      out[d + 1] = n ? Math.round(g / n) : 0
      out[d + 2] = n ? Math.round(bl / n) : 0
    }
  }
  return { data: out, width: w, height: h }
}

/** CRC32（PNG 用；与 `sticker-import.mjs` 里那份同算法，但这里不能 import 它——会成环）。 */
const THUMB_CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function thumbCrc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = THUMB_CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 把 RGB 缓冲编码成 8 位真彩 PNG（无压缩存储，代码最短且无依赖）。 */
function encodeRgbToPng(rgb, width, height) {
  // ⚠️ `zlib` 在本文件里走 `nodeRequire`（同 `decodePngToLuma` 那份），不要另起一个 import
  const { deflateSync } = nodeRequire('node:zlib')
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3)
    raw[rowStart] = 0 // 过滤器：None
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, rowStart + 1)
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(thumbCrc32(body), 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 2 // 真彩
  return Buffer.concat([
    // ★ 用模块里已有的 `PNG_MAGIC`（**不要**在这后面再 `const` 一个同名变量 ——
    //   那个 const 在下方声明，函数调用时会命中 TDZ 直接抛错）
    PNG_MAGIC,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 生成一张缩略图（PNG）。解不出来就返回 null（调用方回落原图）。
 *
 * @param {Buffer} bytes 原图字节
 * @param {number} maxSide 最长边上限（默认 256）
 * @returns {Buffer|null}
 */
export function makeStickerThumbnail(bytes, maxSide = 256) {
  const dbg = process.env.DSH_STICKER_THUMB_DEBUG ? (...a) => console.error('[thumb]', ...a) : () => {}
  const side = Math.max(16, Math.min(1024, Number(maxSide) || 256))
  const size = readImageSize(bytes)
  dbg('size =', JSON.stringify(size), 'side =', side)
  if (!size?.width || !size?.height) {
    dbg('→ 读不出尺寸，返回 null')
    return null
  }
  const factor = Math.max(1, Math.ceil(Math.max(size.width, size.height) / side))
  dbg('factor =', factor)

  let rgb = null
  let w = size.width
  let h = size.height
  const isPng = bytes.subarray(0, 8).equals(PNG_MAGIC)
  dbg('isPng =', isPng, '头部 =', JSON.stringify(bytes.subarray(0, 4).toString('hex')))
  if (isPng) {
    // 复用为感知哈希写的 PNG 解码（给的是亮度，正好够看"这是什么反应"）
    // ⚠️ 它返回的是 `{ width, height, luma }`，**不是** `{ data }` ——
    //    第一版写成 `luma.data` 于是永远取不到、缩略图全部回落原图（图墙照样卡死），
    //    而这条路径**不抛错**（只是返回 null），所以只能靠断言/调试逼出来。
    const luma = decodePngToLuma(bytes)
    dbg('luma =', luma ? `${luma.width}x${luma.height} luma=${luma.luma?.length}` : 'null')
    if (luma?.luma?.length) {
      rgb = new Uint8Array(luma.width * luma.height * 3)
      for (let k = 0; k < luma.width * luma.height; k += 1) {
        const v = luma.luma[k]
        rgb[k * 3] = v
        rgb[k * 3 + 1] = v
        rgb[k * 3 + 2] = v
      }
      w = luma.width
      h = luma.height
    }
  } else if (bytes.toString('ascii', 0, 3) === 'GIF') {
    // ★ 取**最后一帧**（用户要求）：表情包的完整画面在收尾那一帧，
    //   而第一帧往往只覆盖画布的一小块（实测 30 张里 24 张如此）——
    //   只解第一帧的后果就是缩略图变成"一条窄条"。
    const frame = decodeGifThumbFrame(bytes)
    dbg('gif frame =', frame ? `${frame.width}x${frame.height} 用了 ${frame.framesUsed} 帧${frame.truncated ? '（到上限，非真收尾）' : ''}` : 'null')
    if (frame) {
      rgb = frame.rgb
      w = frame.width
      h = frame.height
    }
  }
  if (!rgb) {
    dbg('→ 没有像素数据，返回 null')
    return null
  }

  const shrinkFactor = Math.max(1, Math.ceil(Math.max(w, h) / side))
  const small = shrinkRgb(rgb, w, h, shrinkFactor)
  try {
    return encodeRgbToPng(small.data, small.width, small.height)
  } catch (error) {
    // 静默返回 null 会让"图墙全是原图"变成一个查不出来的现象 —— 至少留个痕
    if (process.env.DSH_STICKER_THUMB_DEBUG) console.error('[thumb] 编码失败：', error)
    return null
  }
}
