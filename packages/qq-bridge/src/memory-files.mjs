/**
 * 记忆文件的读写（给配置 UI 的"记忆"页签用）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这个模块唯一的难点是**安全**，因为它是本项目里唯一"能从网页改磁盘文件"的入口
 * ══════════════════════════════════════════════════════════════════════════
 * 三条底线（每一条都有对应的测试）：
 *   ① **只允许工作区内的相对路径**。`..`、绝对路径、盘符、UNC 一律拒绝。
 *      并且**解析之后**还要再确认一次结果仍落在工作区内 ——
 *      只靠"字符串里没有 `..`"是不够的（软链接、编码绕过都能骗过它）。
 *   ② **只允许 `.md`**。这一条不是洁癖：它是把"能改任意文件"缩成
 *      "只能改笔记"的关键，否则这个接口等于一个远程文件编辑器。
 *   ③ **不跟随软链接**。用 `lstat` 判断，软链接直接拒绝 ——
 *      否则有人可以放一个指向 `config.json`（里面是 token）的软链接，
 *      然后通过这个接口把它读出来。
 *
 * ── 关于"跳过"而不是"报错" ───────────────────────────────────────────────
 * 目录树里遇到符号链接、超大文件、非 `.md` 文件时，本模块**跳过并在警告里列出**，
 * 而不是让整个接口失败。理由：只要工作区里有一个怪文件，界面就整块打不开，
 * 那对使用者来说比"少列一个文件"糟糕得多。但**跳过必须被说出来**，不能静默。
 *
 * ── 关于冲突检测（sha256）────────────────────────────────────────────────
 * 模型**随时可能在写记忆**（你无法预知它什么时候决定"这事值得记住"），
 * 所以"你编辑期间它写了一次"是**常态而非意外**。
 * 保存时比对读的时候记下的 sha256，不一致就返回 409，
 * 让使用者自己决定"重新载入"还是"仍然覆盖"。
 *
 * 摘要里**包含路径和修改时间**，不是只哈希内容 ——
 * 这样"内容没变但文件被替换过"也能被发现。
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 允许编辑的扩展名。收紧在这里，不在调用方。 */
const ALLOWED_EXT = '.md'

/** 单个记忆文件的大小上限（1 MB）。记忆是"笔记"，不该长成这样；撑到这么大说明出问题了。 */
const MAX_FILE_BYTES = 1024 * 1024

/** Windows 保留名，建出来会失败或行为诡异，提前挡掉。 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/**
 * 校验并解析一个"工作区内的相对路径"。
 *
 * @returns {{ok: true, abs: string, rel: string} | {ok: false, error: string}}
 */
export function resolveMemoryPath(workspace, input) {
  const raw = String(input ?? '').trim()
  if (!raw) return { ok: false, error: '路径不能为空' }
  if (raw.includes('\0')) return { ok: false, error: '路径里含空字节' }

  // 统一分隔符后再判断，否则 `a\..\b` 这类在 Windows 上会绕过检查
  const normalized = raw.replace(/\\/g, '/')

  if (isAbsolute(raw) || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('//')) {
    return { ok: false, error: '只接受工作区内的相对路径' }
  }
  const segments = normalized.split('/').filter((s) => s.length > 0 && s !== '.')
  if (segments.length === 0) return { ok: false, error: '路径不能为空' }
  if (segments.includes('..')) return { ok: false, error: '路径不能包含 ..（不允许越出工作区）' }
  if (segments.some((s) => RESERVED.test(s.replace(/\.[^.]*$/, '')))) {
    return { ok: false, error: '路径里含系统保留名' }
  }
  // 已存在的路径：拒绝软链接（防止拿它去读工作区外的文件）
  if (segments.some((s) => s.startsWith('.'))) {
    return { ok: false, error: '不允许操作隐藏文件/目录' }
  }

  const rel = segments.join('/')
  const root = resolve(workspace)
  const abs = resolve(join(root, ...segments))

  // ★ 解析之后再确认一次：这是防"字符串检查被绕过"的最后一道。
  if (abs !== root && !abs.startsWith(root + sep)) {
    return { ok: false, error: '路径越出了工作区' }
  }

  // ★ 只允许 .md。少一个字符都不行（`.mdx` / `.md.bak` 都挡掉）。
  const base = segments[segments.length - 1]
  if (!base.toLowerCase().endsWith(ALLOWED_EXT)) {
    return { ok: false, error: `只允许编辑 ${ALLOWED_EXT} 文件` }
  }

  return { ok: true, abs, rel }
}

/** 读文件内容前的一致性检查：不能是目录、不能是软链接、不能太大。 */
function inspect(abs) {
  if (!existsSync(abs)) return { exists: false }
  const lst = lstatSync(abs)
  if (lst.isSymbolicLink()) return { exists: true, blocked: '这是一个软链接，已拒绝（防止借它读工作区外的文件）' }
  if (lst.isDirectory()) return { exists: true, isDir: true }
  if (!lst.isFile()) return { exists: true, blocked: '不是普通文件' }
  if (lst.size > MAX_FILE_BYTES) {
    return { exists: true, blocked: `文件超过 ${Math.round(MAX_FILE_BYTES / 1024)} KB 上限` }
  }
  return { exists: true, isFile: true, size: lst.size, mtimeMs: lst.mtimeMs }
}

/** 版本标识：**含路径与修改时间**，不只是内容哈希。 */
function fingerprint(rel, content, mtimeMs) {
  return createHash('sha256')
    .update(`${rel}\u0000${Math.trunc(mtimeMs)}\u0000${content}`)
    .digest('hex')
}

/**
 * 记忆文件仓库。
 *
 * @param {object} opts
 * @param {string} opts.workspace  工作区（记忆的根，也是沙箱根）
 * @param {boolean} [opts.enabled] 对应 memory.enabled。**注意：为 false 时本模块照常工作** ——
 *   关掉记忆只是不再注入那段提示词，文件还在、还能看、还能改。
 * @param {(msg: string) => void} [opts.log]
 */
export function createMemoryStore({ workspace, enabled = true, log = () => {} } = {}) {
  const root = resolve(String(workspace ?? ''))

  /** 遍历目录树，收集记忆文件。跳过的东西会被记进 warnings（不静默）。 */
  function walk(dirAbs, dirRel, warnings, depth = 0) {
    if (depth > 6) {
      warnings.push(`目录层级过深，已停止展开：${dirRel || '.'}`)
      return []
    }
    let names
    try {
      names = readdirSync(dirAbs, { withFileTypes: true })
    } catch (error) {
      warnings.push(`读不到目录 ${dirRel || '.'}：${error.message}`)
      return []
    }

    const entries = []
    for (const dirent of names) {
      const rel = dirRel ? `${dirRel}/${dirent.name}` : dirent.name
      if (dirent.name.startsWith('.')) continue // 隐藏文件不入树
      const abs = join(dirAbs, dirent.name)

      let lst
      try {
        lst = lstatSync(abs)
      } catch {
        continue
      }
      if (lst.isSymbolicLink()) {
        warnings.push(`跳过软链接：${rel}`)
        continue
      }
      if (lst.isDirectory()) {
        entries.push({
          path: rel,
          type: 'dir',
          children: walk(abs, rel, warnings, depth + 1),
        })
        continue
      }
      if (!lst.isFile()) continue
      if (!dirent.name.toLowerCase().endsWith(ALLOWED_EXT)) continue
      if (lst.size > MAX_FILE_BYTES) {
        warnings.push(`跳过过大的文件：${rel}`)
        continue
      }
      entries.push({
        path: rel,
        type: 'file',
        size: lst.size,
        mtime: new Date(lst.mtimeMs).toISOString(),
      })
    }
    // 目录在前、文件在后，同级按名字排 —— 界面上的顺序才稳定
    entries.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1))
    return entries
  }

  function tree() {
    const warnings = []
    const entries = []
    if (!existsSync(root)) {
      warnings.push('工作区目录还不存在（机器人还没跑过）。')
    } else {
      // ⚠️ **只展示记忆契约内的文件**，不把整个工作区搬出来。
      //
      // 为什么：工作区是模型的工作目录，它会在里面干各种事 ——
      // 实测它自己建了一个 `store/`（放"以后要用的东西"）。
      // 那是它的杂物间，**不是记忆**：`src/memory.mjs` 里告诉它的记忆路径
      // 只有 `MEMORY.md` 和 `memory/`，模型也只会从这两处读回来。
      //
      // 如果把整个工作区都列进"记忆"页签，使用者会以为那些文件是"机器人记得的东西"，
      // 然后去编辑它们 —— 而模型根本不会读。**列了却没用，比不列更糟。**
      const indexAbs = join(root, 'MEMORY.md')
      if (existsSync(indexAbs) && !lstatSync(indexAbs).isSymbolicLink()) {
        const st = lstatSync(indexAbs)
        if (st.size > MAX_FILE_BYTES) warnings.push('MEMORY.md 过大，已跳过')
        else entries.push({ path: 'MEMORY.md', type: 'file', size: st.size, mtime: new Date(st.mtimeMs).toISOString() })
      }

      const detailAbs = join(root, 'memory')
      if (existsSync(detailAbs) && lstatSync(detailAbs).isDirectory()) {
        entries.push({
          path: 'memory',
          type: 'dir',
          children: walk(detailAbs, 'memory', warnings),
        })
      }

      if (entries.length === 0) {
        warnings.push('还没有任何记忆文件 —— 机器人还没在对话里记下什么。这是正常的。')
      }
    }

    const sumBytes = (list) =>
      list.reduce((a, e) => a + (e.type === 'dir' ? sumBytes(e.children ?? []) : e.size ?? 0), 0)

    return {
      workspace: root,
      enabled,
      entries,
      totalBytes: sumBytes(entries),
      warnings,
      note: '记忆由桥接按模型的提议落盘（模型提议、桥接校验后写入）。没有 memory/ 目录是正常的（按需创建）。',
    }
  }

  function read(path) {
    const r = resolveMemoryPath(root, path)
    if (!r.ok) return { ok: false, status: 400, error: r.error }

    const info = inspect(r.abs)
    if (!info.exists) return { ok: false, status: 404, error: '记忆文件不存在' }
    if (info.blocked) return { ok: false, status: 400, error: info.blocked }
    if (info.isDir) return { ok: false, status: 400, error: '这是一个目录，不是文件' }

    let content
    try {
      content = readFileSync(r.abs, 'utf8')
    } catch (error) {
      return { ok: false, status: 500, error: `读文件失败：${error.message}` }
    }
    return {
      ok: true,
      data: {
        path: r.rel,
        content,
        size: info.size,
        mtime: new Date(info.mtimeMs).toISOString(),
        sha256: fingerprint(r.rel, content, info.mtimeMs),
      },
    }
  }

  /**
   * 写文件。`expectedSha256` 缺席 = 放弃冲突保护（会在响应里明说）。
   */
  function write(path, content, expectedSha256) {
    const r = resolveMemoryPath(root, path)
    if (!r.ok) return { ok: false, status: 400, error: r.error }
    if (typeof content !== 'string') return { ok: false, status: 400, error: 'content 必须是字符串' }
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      return { ok: false, status: 413, error: `内容超过 ${Math.round(MAX_FILE_BYTES / 1024)} KB 上限` }
    }

    const info = inspect(r.abs)
    if (info.blocked) return { ok: false, status: 400, error: info.blocked }
    if (info.isDir) return { ok: false, status: 400, error: '这是一个目录，不能用文件方式写入' }

    const hasCheck = typeof expectedSha256 === 'string' && expectedSha256.length > 0
    let overwroteWithoutCheck = false

    if (info.exists) {
      const current = readFileSync(r.abs, 'utf8')
      const currentSha = fingerprint(r.rel, current, info.mtimeMs)
      if (hasCheck && currentSha !== expectedSha256) {
        // ★ 最重要的分支：编辑期间被改过了。
        // 把当前内容一起带回去，让使用者能判断"谁对"。
        return {
          ok: false,
          status: 409,
          error: '这份记忆在你编辑期间被改过了',
          conflict: true,
          currentSha256: currentSha,
          currentContent: current,
        }
      }
      if (!hasCheck) overwroteWithoutCheck = true
    } else if (!hasCheck) {
      // 新文件无所谓冲突，但界面对"没做版本核对"应有一致的提示
      overwroteWithoutCheck = true
    }

    try {
      mkdirSync(dirname(r.abs), { recursive: true })
      writeFileSync(r.abs, content, 'utf8')
    } catch (error) {
      return { ok: false, status: 500, error: `写文件失败：${error.message}` }
    }

    const after = statSync(r.abs)
    return {
      ok: true,
      data: {
        saved: true,
        sha256: fingerprint(r.rel, content, after.mtimeMs),
        mtime: new Date(after.mtimeMs).toISOString(),
        // ★ 恒为 false：记忆是模型运行时读的普通文件，改完下一次它读笔记时就是新的。
        //   界面**不要**弹"需要重启" —— 那是配置类改动的提示。
        restartRequired: false,
        ...(overwroteWithoutCheck ? { overwroteWithoutCheck: true } : {}),
      },
    }
  }

  function remove(path) {
    const r = resolveMemoryPath(root, path)
    if (!r.ok) return { ok: false, status: 400, error: r.error }
    const info = inspect(r.abs)
    if (!info.exists) return { ok: false, status: 404, error: '记忆文件不存在' }
    if (info.blocked) return { ok: false, status: 400, error: info.blocked }
    if (info.isDir) return { ok: false, status: 400, error: '这是目录，本接口只删文件' }
    try {
      // ⚠️ 这里刻意用 `unlinkSync`，**不要改成 `rmSync`**。
      // 实测（Node v24.9.0 / Windows）：`rmSync(path)` 删单个文件会
      // **静默失败** —— 不抛错、返回值也正常，但 `existsSync` 仍是 true。
      // 后果很严重：接口会回 `{deleted:true}`，而文件其实还在，
      // 使用者以为删掉了、机器人却还记得。`unlinkSync` 在同一环境下正常。
      unlinkSync(r.abs)
    } catch (error) {
      return { ok: false, status: 500, error: `删除失败：${error.message}` }
    }
    // 复核：不信任"调用没报错"就等于"真的删掉了"（上面那个教训）。
    if (existsSync(r.abs)) {
      return { ok: false, status: 500, error: '删除后文件仍然存在（文件可能被占用）' }
    }
    return { ok: true, data: { deleted: true } }
  }

  return { root, tree, read, write, remove }
}

/** 给测试用：把相对路径解析成绝对路径但不做存在性检查。 */
export function memoryPaths(workspace) {
  const root = resolve(workspace)
  return { root, index: join(root, 'MEMORY.md'), detailDir: join(root, 'memory'), relative }
}
