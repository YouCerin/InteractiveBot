/**
 * 从 DSH 桌面版的 `app.asar` 里把 CLI 抽出来（实机 BUG-5 的受支持做法）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它（2026-10-03 实机测试报告 BUG-5）
 * ══════════════════════════════════════════════════════════════════════════
 * 《首次使用.txt》原话是"装完不用做任何配置，机器人会自己去找它"。实测不是这样：
 * DSH 0.2.0-rc.2 装出来是 `%LOCALAPPDATA%\Programs\DeepSeek Harness`（**名字带空格**），
 * 而且把 CLI 打在 **`resources\app.asar`** 里 —— `resources\app` 这个目录根本不存在。
 * 普通 Node **不认 asar**：
 *
 *     node "…\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" --version
 *     → Error: Cannot find module '…app.asar\…'
 *
 * 而抽出来之后是**完全可用**的（实测 `--version` → 0.2.0-rc.2，
 * 桥接日志 `[rpc] initialize 成功` + `✅ DSH 就绪`）。所以这不是"版本不兼容"，
 * 只是"少了一步抽取"。本模块就是那一步，且它进包、有回归测试。
 *
 * ── asar 的文件格式（踩点记录，别凭印象写）────────────────────────────
 *   · 文件头 8 字节 = 一个 pickle，其载荷是一个 UInt32 = **header pickle 的长度**
 *   · 紧接着的 header pickle 里：偏移 4 处是 JSON 字符串长度，**JSON 从该缓冲区的第 8 字节开始**
 *   · 文件体偏移基准 = `8 + headerPickleSize`（各条目的 `offset` 相对它）
 *   · 目录条目是 `{ files: {…} }`，文件条目是 `{ offset: "123", size: 456 }`
 *   · 标记 `unpacked: true` 的条目**不在 asar 里**，要去旁边的
 *     `app.asar.unpacked\<同样的相对路径>` 取 —— 原生模块（node-pty / sharp /
 *     sherpa-onnx / koffi）都在这一类里，漏了它们 DSH 会在加载时才发现缺文件。
 *
 * ── 抽到哪儿、为什么要把前缀剥掉 ────────────────────────────────────────
 * `app.asar` 里 CLI 的相对路径是 `dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`
 * （asar 根下先有一层 `dsh/`）。而 `findDshCli()` 找的是
 * `<安装根>/node_modules/@deepseek-ai/dsh/lib/bin.js` —— 所以抽取时要**把
 * "从 asar 根到 CLI 安装根"的那一段前缀剥掉**，让结果正好落在 `vendor/dsh`。
 * 这一步是自动判定的（在归档里搜 `bin.js` 反推前缀），不写死 `dsh/`。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

/** asar 旁边那个放"没打进归档的文件"的目录后缀。 */
export const ASAR_UNPACKED_SUFFIX = '.unpacked'

/** CLI 入口在归档里的相对路径（用它反推安装根前缀）。 */
export const CLI_BIN_REL = 'node_modules/@deepseek-ai/dsh/lib/bin.js'

/**
 * 读 asar 的头部并解析出文件树（**纯读**，不写任何东西）。
 *
 * @param {string} asarPath
 * @returns {{tree: object, bodyOffset: number, headerPickleSize: number, jsonSize: number}}
 */
export function readAsarHeader(asarPath) {
  const fd = openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(8)
    if (readSync(fd, head, 0, 8, 0) !== 8) throw new Error('asar 头部不足 8 字节（文件被截断？）')
    // 第一个 pickle 的载荷就是"header pickle 有多长"
    const headerPickleSize = head.readUInt32LE(4)
    if (!Number.isFinite(headerPickleSize) || headerPickleSize <= 0 || headerPickleSize > 64 * 1024 * 1024) {
      throw new Error(`header pickle 长度不合理：${headerPickleSize}`)
    }
    const headerBuf = Buffer.alloc(headerPickleSize)
    if (readSync(fd, headerBuf, 0, headerPickleSize, 8) !== headerPickleSize) {
      throw new Error('读 header pickle 时提前结束（文件被截断？）')
    }
    const jsonSize = headerBuf.readUInt32LE(4)
    if (jsonSize <= 0 || jsonSize > headerPickleSize) {
      throw new Error(`头部 JSON 长度不合理：${jsonSize}（pickle ${headerPickleSize}）`)
    }
    const json = headerBuf.toString('utf8', 8, 8 + jsonSize)
    return {
      tree: JSON.parse(json),
      bodyOffset: 8 + headerPickleSize,
      headerPickleSize,
      jsonSize,
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * 把文件树摊平成 `{ rel, entry }[]`（rel 一律用 `/`，与归档里的写法一致）。
 *
 * @param {object} tree `readAsarHeader().tree`
 * @param {string} [prefix] 只取这个前缀下的（内部递归用）
 */
export function walkAsarFiles(tree, prefix = '') {
  const out = []
  const files = tree?.files
  if (!files || typeof files !== 'object') return out
  for (const [name, entry] of Object.entries(files)) {
    const rel = prefix ? `${prefix}/${name}` : name
    if (entry && typeof entry === 'object' && entry.files) {
      out.push(...walkAsarFiles(entry, rel))
    } else if (entry && typeof entry === 'object') {
      out.push({ rel, entry })
    }
  }
  return out
}

/** 在文件树里精确找一个条目（`rel` 用 `/`）。 */
export function findAsarEntry(tree, rel) {
  let node = tree
  for (const part of String(rel).split('/').filter(Boolean)) {
    node = node?.files?.[part]
    if (!node) return null
  }
  return node?.files ? null : (node ?? null)
}

/**
 * 反推"归档里哪一层才是 CLI 的安装根"。
 *
 * 为什么要反推而不是写死：不同 DSH 版本的 asar 布局会变（根下可能是 `dsh/`，
 * 也可能直接就是 CLI 那一层）。判定依据只有一条 —— **哪里能找到 bin.js**。
 *
 * @returns {{prefix: string, binRel: string, matches: string[]}|null}
 *   `prefix` 为空串表示归档根就是安装根
 */
export function findCliRoot(tree) {
  const matches = walkAsarFiles(tree)
    .filter((f) => f.rel === CLI_BIN_REL || f.rel.endsWith(`/${CLI_BIN_REL}`))
    .map((f) => f.rel)
    .sort((a, b) => a.length - b.length) // 最短的那个 = 最外层的安装根
  if (matches.length === 0) return null
  const binRel = matches[0]
  const prefix = binRel.slice(0, binRel.length - CLI_BIN_REL.length).replace(/\/$/, '')
  return { prefix, binRel, matches }
}

/** 防止归档里的相对路径写到目标目录之外（`..` / 绝对路径）。 */
function safeJoin(targetDir, rel) {
  const cleaned = String(rel)
    .split('/')
    .filter((p) => p !== '' && p !== '.')
    .join('/')
  if (cleaned.includes('..') || /^[A-Za-z]:/.test(cleaned) || cleaned.startsWith('/')) {
    throw new Error(`归档里的路径不安全，已拒绝：${rel}`)
  }
  const full = resolve(targetDir, cleaned.replace(/\//g, sep))
  const root = resolve(targetDir)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`归档里的路径逃出了目标目录，已拒绝：${rel}`)
  }
  return full
}

/**
 * 抽取 CLI 安装根到 `targetDir`（默认 `vendor/dsh`）。
 *
 * 行为：
 *   · 只写 `prefix` 之下的条目（其余是桌面版外壳，桥接用不到），剥掉前缀
 *   · `unpacked: true` 的条目从 `<asar>.unpacked/<原相对路径>` 复制
 *   · 任何"该有却没有"的东西都**报出来**（不静默跳过）
 *
 * @param {object} opts
 * @param {string} opts.asarPath
 * @param {string} opts.targetDir
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ok: boolean, prefix: string, files: number, unpacked: number, skipped: number,
 *            missingUnpacked: string[], binPath: string|null, error?: string}}
 */
export function extractDshFromAsar({ asarPath, targetDir, log = () => {} }) {
  const result = {
    ok: false,
    prefix: '',
    files: 0,
    unpacked: 0,
    skipped: 0,
    missingUnpacked: [],
    binPath: null,
  }
  if (!existsSync(asarPath)) return { ...result, error: `asar 不存在：${asarPath}` }

  let header
  try {
    header = readAsarHeader(asarPath)
  } catch (error) {
    return { ...result, error: `解析 asar 头部失败：${error?.message ?? error}` }
  }

  const root = findCliRoot(header.tree)
  if (!root) {
    return {
      ...result,
      error:
        `归档里找不到 ${CLI_BIN_REL} —— 这可能不是 DSH 桌面版的 app.asar，`
        + '或者它的内部布局变了（请把这条报给维护者）',
    }
  }
  result.prefix = root.prefix

  const prefixWithSlash = root.prefix ? `${root.prefix}/` : ''
  const unpackedDir = `${asarPath}${ASAR_UNPACKED_SUFFIX}`
  const fd = openSync(asarPath, 'r')
  try {
    for (const { rel, entry } of walkAsarFiles(header.tree)) {
      if (prefixWithSlash && !rel.startsWith(prefixWithSlash)) {
        result.skipped += 1 // 桌面版外壳（不在 CLI 安装根下）
        continue
      }
      if (entry.link) {
        // 归档里的符号链接：Windows 上创建软链需要权限，这里如实跳过并计数
        result.skipped += 1
        continue
      }
      const inner = prefixWithSlash ? rel.slice(prefixWithSlash.length) : rel
      const dest = safeJoin(targetDir, inner)
      mkdirSync(dirname(dest), { recursive: true })

      if (entry.unpacked) {
        const sidecar = join(unpackedDir, rel.replace(/\//g, sep))
        if (!existsSync(sidecar)) {
          result.missingUnpacked.push(rel)
          continue
        }
        writeFileSync(dest, readFileSync(sidecar))
        result.unpacked += 1
        continue
      }

      const size = Number(entry.size ?? 0)
      const offset = Number(entry.offset ?? 0)
      if (!Number.isFinite(size) || !Number.isFinite(offset) || size < 0) {
        return { ...result, error: `${rel} 的 offset/size 不合法：${entry.offset}/${entry.size}` }
      }
      const buf = Buffer.alloc(size)
      if (size > 0) {
        const read = readSync(fd, buf, 0, size, header.bodyOffset + offset)
        if (read !== size) throw new Error(`${rel} 读取不完整（期望 ${size}，实得 ${read}）`)
      }
      writeFileSync(dest, buf)
      result.files += 1
    }
  } catch (error) {
    return { ...result, error: `抽取过程中失败：${error?.message ?? error}` }
  } finally {
    closeSync(fd)
  }

  result.binPath = join(targetDir, ...CLI_BIN_REL.split('/'))
  result.ok = existsSync(result.binPath)
  if (!result.ok) {
    return { ...result, error: `抽完了但没找到 ${CLI_BIN_REL}（目标目录可能不对）` }
  }
  log(
    `✅ 已抽取 ${result.files} 个文件（另有 ${result.unpacked} 个 unpacked 原生文件）→ ${targetDir}`,
  )
  if (result.skipped) log(`ℹ️  跳过 ${result.skipped} 个不属于 CLI 安装根的条目（桌面版外壳/软链）`)
  if (result.missingUnpacked.length) {
    log(
      `⚠️ 有 ${result.missingUnpacked.length} 个 unpacked 条目在 ${unpackedDir} 里找不到` +
        `（原生模块可能缺失，DSH 会在加载时才报错）：${result.missingUnpacked.slice(0, 5).join('、')}` +
        `${result.missingUnpacked.length > 5 ? ' …' : ''}`,
    )
  }
  // 落盘校验：抽出来的 bin.js 至少要是非空的，避免"看起来成功其实空文件"
  const binSize = (() => {
    try {
      return statSync(result.binPath).size
    } catch {
      return 0
    }
  })()
  if (binSize === 0) return { ...result, ok: false, error: `${result.binPath} 是空文件` }
  return result
}
