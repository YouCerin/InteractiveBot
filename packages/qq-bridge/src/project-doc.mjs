/**
 * **把项目简介放进工作区，让 agent 需要时能自己读**（0.2.2）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它解决的问题
 * ══════════════════════════════════════════════════════════════════════════
 * `docs/项目简介.md`（各模块怎么实现 / 有什么特色 / **agent 自己有多大权限**）在**包外**，
 * 而 agent 的沙箱根是工作区（`workspace-write`）—— 也就是说：**它读不到**。
 * 结果是一个很具体的坏现象：使用者问"你能不能删我电脑上的文件 / 你能做什么"，
 * 模型只能凭提示词里那一小段权限说明**猜**，而猜错的代价是随口的承诺或随口的自我否定。
 *
 * 所以桥接启动时把这份文档**复制进工作区**（`store/project-intro.md`），
 * 并在提示词里留**一行**指针（`projectDocLine()`）告诉它：被问到这类问题时先读那个文件。
 *
 * ── 四条设计取舍（改这里之前先读）────────────────────────────────────────
 * ① **按需读，不进提示词**：整份文档 20+ KB（几千 token），每轮注入等于每轮烧钱；
 *    放进工作区后模型可以用 `read` 带 offset/limit **只读它要的那一节**，最省。
 * ② **放在 `store/`，不放 `memory/`**：记忆的篡改检测扫的是**工作区根 + `memory/`**，
 *    而且 `memory/` 下的 `.md` 会被当记忆注入上下文。这份文档**不是记忆**（它是文档，
 *    且由桥接每次启动重写），放进 `memory/` 会同时踩这两个坑。
 * ③ **每次启动重写**：源文档会随代码变，副本必须是"这一次启动时的那一份"。
 *    头部写清来源与生成时间 —— 被人看到时能一眼判断它是不是旧的。
 * ④ **源文档找不到就什么都不做**（fail-closed）：发布包里**不带** `docs/`
 *    （`scripts/assemble-release.mjs` 的 COPY_DIRS 里没有它），所以这条路径必须能安静降级，
 *    且**绝不写一份空壳**去骗模型（那会让它以为"读到了，里面什么都没说"）。
 *    降级时提示词里那一行也**不会出现**（没有悬空指针）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { PKG_ROOT } from './local.mjs'

/**
 * 副本落在工作区的哪个位置（工作区相对路径）。
 *
 * ★ 0.2.8 改名时**刻意换成品牌中立的名字**（原来是 `store/interactbot-intro.md`）：
 *   这一格以后无论项目叫什么都成立，改名不用再动它。
 */
export const PROJECT_DOC_REL = 'store/project-intro.md'

/**
 * **旧名字**的副本位置（0.2.8：InteractBot → InteractiveRobot）。
 *
 * 为什么要主动删：桥接每次启动都会写新名字的副本，而**老工作区里还留着一份旧名字的**。
 * 它不会报错，只会造成两种误导 ——
 *   ① 模型可能读到**过期的**旧副本（旧版本内容 + 旧名字）；
 *   ② 使用者看到两个几乎同名的文件，不知道哪个是活的。
 * 删它是安全的：这个文件**由桥接自己生成**（见文件头 ③「每次启动重写」），不是用户内容。
 */
export const LEGACY_PROJECT_DOC_RELS = ['store/interactbot-intro.md']

/**
 * 源文档的候选位置（按顺序找，相对包根）。
 *
 * 两个候选是刻意的：开发仓库里它在 `<仓库>/docs/`（包的上两级）；
 * 而如果哪天决定把简介**也发进发布包**（`COPY_FILES` 加一行、放进 `docs/`），
 * 这里不用改代码就能找到它 —— 少一处"必须同步改的清单"。
 */
export const PROJECT_DOC_SOURCES = ['../../docs/项目简介.md', 'docs/项目简介.md']

/** 找到源文档的绝对路径（找不到返回 null）。 */
export function findProjectDocSource({ pkgRoot = PKG_ROOT } = {}) {
  for (const rel of PROJECT_DOC_SOURCES) {
    const abs = resolve(join(pkgRoot, rel))
    try {
      if (existsSync(abs) && statSync(abs).isFile()) return { abs, rel }
    } catch {
      /* 继续找下一个 */
    }
  }
  return null
}

/**
 * 给副本加头部（**纯函数**，便于离线测）。
 *
 * 头部要回答三个问题：这是什么、从哪来、能不能改。
 */
export function renderProjectDocCopy({ text, sourcePath, version = '', generatedAt = '' } = {}) {
  const head = [
    '# InteractiveRobot 项目简介（启动时自动生成的副本）',
    '',
    `> 来源：\`${sourcePath}\`${version ? `（InteractiveRobot ${version}）` : ''}`,
    `> 生成时间：${generatedAt || '（未知）'}`,
    '> ⚠️ **别改这份文件**：桥接每次启动都会用它覆盖你。要改就改源文件（上面那个路径）。',
    '> 用途：回答"你能做什么 / 你能改我的文件吗 / 这个项目是怎么实现的"这类问题时**先读它**，不要凭印象答。',
    '',
    '---',
    '',
  ].join('\n')
  return `${head}${String(text ?? '')}`
}

/**
 * 把简介写进工作区（幂等：每次启动覆盖）。
 *
 * @returns {{ok: boolean, rel?: string, chars?: number, source?: string, error?: string, skipped?: string}}
 */
export function ensureProjectDocCopy({ workspace, pkgRoot = PKG_ROOT, version = '', log = () => {}, now = null } = {}) {
  const ws = String(workspace ?? '')
  if (!ws) return { ok: false, skipped: 'no-workspace', error: '没有工作区，放不了项目简介（agent 也读不到它）' }

  const found = findProjectDocSource({ pkgRoot })
  if (!found) {
    // ★ 安静降级，但**要留一行日志**：不写空壳、不撒谎。
    log(`ℹ️  项目简介不在包里（找过 ${PROJECT_DOC_SOURCES.join(' / ')}）—— 跳过生成物；agent 将无法读到它`)
    return { ok: false, skipped: 'no-source', error: '源文档不在这个包里（发布包不带 docs/）' }
  }

  const abs = join(ws, PROJECT_DOC_REL)
  try {
    const text = readFileSync(found.abs, 'utf8')
    const body = renderProjectDocCopy({
      text,
      sourcePath: found.rel,
      version,
      generatedAt: now ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
    })
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body, 'utf8')
    // 顺手清掉**旧名字**的副本（见 LEGACY_PROJECT_DOC_RELS）。删不掉不是错误：
    // 它只是"老工作区里的遗留物"，下一次启动还会再试一次。
    const removedLegacy = []
    for (const rel of LEGACY_PROJECT_DOC_RELS) {
      const legacy = join(ws, rel)
      try {
        if (existsSync(legacy)) {
          rmSync(legacy)
          removedLegacy.push(rel)
        }
      } catch {
        /* 留着就留着，不打断启动 */
      }
    }
    if (removedLegacy.length) {
      log(`ℹ️  已清掉旧名字的项目简介副本：${removedLegacy.join('、')}（0.2.8 改名前的遗留物，桥接自己生成的）`)
    }
    return { ok: true, rel: PROJECT_DOC_REL, chars: body.length, source: found.rel, removedLegacy }
  } catch (error) {
    // 写不进去不影响收发消息（增强路径纪律），但必须说出来。
    log(`⚠️  项目简介副本写入失败（不影响收发消息）：${error?.message ?? error}`)
    return { ok: false, error: `写入失败：${error?.message ?? error}` }
  }
}

/**
 * 提示词里那一行指针（**只有一行**，且只在副本真的写成功时用）。
 *
 * 为什么值得花这几十个 token：没有它，模型**不知道有这个文件**，于是"能不能删我的文件"
 * 这类问题只能凭印象答；而答错的代价是使用者对权限的误判（可能鼓励他去做危险操作，
 * 也可能让它自我设限）。有它之后，模型可以先读文档再回答。
 */
export function projectDocLine({ rel = PROJECT_DOC_REL } = {}) {
  return (
    `（我的能力边界、以及这个项目是怎么实现的：\`${rel}\`（启动时自动生成的副本，**需要时用 read 读**）。` +
    '被问到"你能做什么 / 你能改我的文件吗 / 这项目是怎么做的"时先读它，别凭印象答。）'
  )
}

/** 只为测试导出：不改动文件系统、只算会写到哪儿。 */
export function projectDocPath({ workspace } = {}) {
  return join(String(workspace ?? ''), PROJECT_DOC_REL)
}

/** 只为测试导出：把源文件原样读回来（用于比对"正文逐字没变"）。 */
export function readProjectDocSource({ pkgRoot = PKG_ROOT } = {}) {
  const found = findProjectDocSource({ pkgRoot })
  if (!found) return null
  try {
    return { ...found, text: readFileSync(found.abs, 'utf8') }
  } catch {
    return null
  }
}

/** 供 `--check` / 体检显示用的摘要（不读文件内容，只回答"有没有"）。 */
export function projectDocStatus({ workspace, pkgRoot = PKG_ROOT } = {}) {
  const found = findProjectDocSource({ pkgRoot })
  const copy = workspace ? projectDocPath({ workspace }) : ''
  return {
    source: found?.rel ?? null,
    sourceFound: Boolean(found),
    copyRel: PROJECT_DOC_REL,
    copyExists: Boolean(copy) && existsSync(copy),
  }
}
