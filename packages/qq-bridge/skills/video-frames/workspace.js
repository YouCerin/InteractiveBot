// 工作区定位 + 帧产物目录管理（InteractiveBot 适配新增，上游没有这一层）。
//
// ══════════════════════════════════════════════════════════════════════════
// 为什么必须有这个模块（三个各自独立的理由）
// ══════════════════════════════════════════════════════════════════════════
//  ① **帧必须落在工作区里**，否则模型看不到。模型的 `read_image` 受它自己的
//     文件沙箱约束（根 = 工作区，见 `src/images.mjs` 顶部那段取证与
//     `dsh-fs-sandbox`）。抽出来的图写到工作区外面 = 白抽。
//
//  ② **技能进程没有沙箱**（见 `docs/插件设计规范.md` §5：技能是普通 node 子进程，
//     宿主不做代码级拦截）。也就是说"能写哪儿"完全靠我们自己自觉。而这个工具是
//     **模型**驱动的、模型的输入是**群友的消息** —— 一个能任意写盘的技能，
//     等于把"群友可以让机器人往任意路径写文件"这条缝打开。所以这里的铁律是：
//     **只读工作区内的相对路径；只往工作区内的 frames/ 写。**
//
//  ③ 上游把临时帧写在**视频文件所在目录**（`path.dirname(src)`）然后立刻删掉，
//     因为它只产出 base64。本宿主需要的是**留在盘上的文件**（给 read_image 读），
//     所以要有"放哪儿、怎么命名、什么时候清"的政策 —— 那就是这个模块。
//
// ⚠️ 一个如实记录的边界：本模块挡住的是**路径字符串**与**符号链接**两条路。
//    它挡不住"技能进程被别的方式指使去写别处"（技能本身没有沙箱）。
//    这里做的收束是为了让**模型**这一侧的输入无法越界，不是进程隔离。

import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 抽帧产物在工作区里的子目录名。 */
export const FRAMES_DIR = 'frames'

/** 工作区没配时的兜底目录名 —— 与 `src/local.mjs` 的 `defaultWorkspace` 同名。 */
export const DEFAULT_WORKSPACE_NAME = 'workspace-qq'

/**
 * 从技能目录反推包根：`<pkg>/skills/<id>` → `<pkg>`。
 *
 * 为什么要反推：技能只知道自己被装在哪（`api.skill.dir`），而配置里的
 * `dsh.workspace` 是**相对包根**写的（见 `src/config.mjs` 的 `resolveInPackage`）。
 * 不反推就没法把相对路径变绝对路径。这里刻意**不写死任何绝对路径** ——
 * 整个包要能搬走（上游宿主与本宿主都强调这条）。
 */
export function packageRootOf(skillDir) {
  return resolve(String(skillDir || '.'), '..', '..')
}

/**
 * 现在这个技能该用哪个工作区。
 *
 * 取值口径与宿主 `src/config.mjs` 完全一致（否则两边会指向不同目录，
 * 表现是"抽帧成功了但模型读不到"）：
 *   · `config.dsh.workspace` 是绝对路径 → 用它
 *   · 是相对路径 → 相对**包根**解析
 *   · 没写 → `<包根>/workspace-qq`
 *
 * @param {{skillDir?: string, config?: object}} opts `config` = 宿主整份配置（`ctx.config`）
 * @returns {{root: string, source: string}}
 */
export function resolveWorkspace({ skillDir, config } = {}) {
  const pkgRoot = packageRootOf(skillDir)
  const raw = String(config?.dsh?.workspace ?? '').trim()
  if (!raw) {
    return { root: join(pkgRoot, DEFAULT_WORKSPACE_NAME), source: '默认（配置里没写 dsh.workspace）' }
  }
  if (isAbsolute(raw)) return { root: raw, source: 'config.dsh.workspace（绝对值）' }
  return { root: resolve(pkgRoot, raw), source: 'config.dsh.workspace（相对包根）' }
}

/**
 * 工作区里的帧目录（不存在就建）。
 *
 * 为什么单独一个 `frames/` 而不复用宿主看图的 `inbox/`：
 * `inbox` 有**宿主自己的**保留政策（默认 72 小时 / 100MB，见 `src/images.mjs`），
 * 混进去会有两个后果 —— 我们抽的帧被宿主的配额挤掉、或者我们的帧把
 * 别人的图片挤出配额。两件事都不该发生，所以各管各的目录。
 */
export function ensureFramesDir(workspaceRoot) {
  const dir = join(String(workspaceRoot), FRAMES_DIR)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 帧文件名里那截"来源指纹"：同一个视频重复抽帧时用来覆盖旧帧。 */
export function framesTag(source) {
  return createHash('sha1').update(String(source ?? '')).digest('hex').slice(0, 8)
}

/**
 * 把模型给的 `source` 收束成工作区内的**真实**文件路径。
 *
 * 拒绝的四种写法（每一种都对应一类真实越界手法）：
 *   · 绝对路径 / 盘符 / UNC（`C:\…`、`\\host\share`、`/etc/passwd`）——
 *     模型没有理由读工作区外的文件；放行就等于给了一条"把任意文件转成图给模型看"的路
 *   · 含 `..` 的相对路径（拼起来才知道跑到哪）
 *   · 拼起来跑到工作区外的路径（前缀比较按**目录分隔符**做，避免 `/wsa` 骗过 `/ws`）
 *   · **符号链接指向工作区外**：前缀检查挡不住软链，所以解析后用 `realpathSync` 再看一遍
 *
 * @returns {{ok:true, abs:string, rel:string} | {ok:false, why:string}}
 */
export function resolveInsideWorkspace(workspaceRoot, input) {
  const raw = String(input ?? '').trim()
  if (!raw) return { ok: false, why: 'source 是空的' }
  if (/^[a-zA-Z]:/.test(raw)) {
    return { ok: false, why: `只接受**工作区内**的相对路径，不接受盘符路径（收到 ${raw}）。要抽帧的视频请先放进工作区，或给一条 http(s) 直链。` }
  }
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    return { ok: false, why: '只接受工作区内的相对路径，不接受 UNC 网络路径。' }
  }
  if (raw.startsWith('/') || raw.startsWith('\\')) {
    return { ok: false, why: '只接受工作区内的相对路径，不接受以根开头的路径。' }
  }
  if (isAbsolute(raw)) {
    return { ok: false, why: `只接受工作区内的相对路径（收到 ${raw}）。` }
  }

  const rootKey = resolve(String(workspaceRoot))
  const abs = resolve(rootKey, raw)
  // 前缀比较必须带上分隔符：`C:\ws` 与 `C:\ws2` 不能互相匹配
  if (!(abs === rootKey || abs.startsWith(rootKey + sep))) {
    return { ok: false, why: `这个相对路径拼出来跑到工作区外面去了（${abs}），拒绝。` }
  }

  let realRoot
  let realAbs
  try {
    realRoot = realpathSync(rootKey)
  } catch {
    return { ok: false, why: `工作区目录不存在：${rootKey}` }
  }
  try {
    realAbs = realpathSync(abs) // 顺带确认文件真的存在
  } catch {
    return { ok: false, why: `工作区里没有这个文件：${raw}` }
  }
  if (!(realAbs === realRoot || realAbs.startsWith(realRoot + sep))) {
    return { ok: false, why: `这个路径经符号链接指向了工作区外面（${realAbs}），拒绝。` }
  }
  let st
  try {
    st = statSync(realAbs)
  } catch {
    return { ok: false, why: `读不到这个文件：${raw}` }
  }
  if (!st.isFile()) return { ok: false, why: `这不是一个文件：${raw}` }

  return { ok: true, abs: realAbs, rel: relative(realRoot, realAbs).replace(/\\/g, '/') }
}

/**
 * 删掉同一个来源上一次抽的帧。
 *
 * 为什么按"来源指纹"删而不是按时间删：同一个视频再抽一次时，旧帧留在盘上
 * 只会让模型看到两批几乎一样的图（还可能读到过期的）。按指纹删是精确的。
 */
export function removeFramesOfTag(framesDir, tag) {
  const prefix = `frame_${String(tag)}_`
  let removed = 0
  let entries = []
  try {
    entries = readdirSync(framesDir, { withFileTypes: true })
  } catch {
    return { removed }
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.startsWith(prefix)) continue
    try {
      rmSync(join(framesDir, e.name), { force: true })
      removed += 1
    } catch {
      /* 删不掉不致命：同名文件后面会被 -y 覆盖 */
    }
  }
  return { removed }
}

/**
 * 清理过期帧（默认 24 小时）。
 *
 * 为什么这件事必须由技能自己做：帧落在**使用者的工作区**里，宿主不会替我们清
 * （宿主的清理只认自己的 `inbox/`）。没有这条，用久了工作区里会堆一堆
 * 谁也不认识、也不敢删的 jpg。
 *
 * @returns {{removed:number, bytes:number, kept:number}}
 */
export function pruneFrames(framesDir, { retentionHours = 24, now = Date.now() } = {}) {
  const out = { removed: 0, bytes: 0, kept: 0 }
  const hours = Number(retentionHours)
  if (!Number.isFinite(hours) || hours <= 0) return out // 0 或负数 = 明确表示"不清理"
  const cutoff = now - hours * 3600 * 1000
  let entries = []
  try {
    entries = readdirSync(framesDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isFile() || !/^frame_.*\.jpg$/i.test(e.name)) continue
    const p = join(framesDir, e.name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (st.mtimeMs >= cutoff) {
      out.kept += 1
      continue
    }
    try {
      rmSync(p, { force: true })
      out.removed += 1
      out.bytes += st.size
    } catch {
      /* 删不掉就留着，不该因此让整次抽帧失败 */
    }
  }
  return out
}

/** 帧目录现状（自检用）。 */
export function describeFramesDir(framesDir) {
  let files = 0
  let bytes = 0
  try {
    for (const e of readdirSync(framesDir, { withFileTypes: true })) {
      if (!e.isFile()) continue
      files += 1
      try {
        bytes += statSync(join(framesDir, e.name)).size
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    return { exists: false, files: 0, bytes: 0 }
  }
  return { exists: existsSync(framesDir), files, bytes }
}
