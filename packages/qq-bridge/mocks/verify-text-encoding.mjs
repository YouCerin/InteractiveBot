/**
 * **文本编码守卫**（0.2.2 补的，因为真的踩过一次；0.2.2 又补了第四条判据）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它防的是什么（一次真实事故，完整记录见 docs/0.2.2-project-json-incident.md）
 * ══════════════════════════════════════════════════════════════════════════
 * 2026-09-27：一条 PowerShell 命令 `(Get-Content x -Raw) | Set-Content x -Encoding UTF8`
 * 把 `PROJECT.json`（UTF-8，无 BOM）**按系统 ANSI（GBK）读进来**、再按 UTF-8 写回去 ——
 * 中文全变乱码（实测 3277 处），**而且不报错**。同一条路子还会：
 *   · 把输出落成 **UTF-16LE**（PowerShell 的 `>` 重定向；`docs/0.2.2-pixiv-adaptation.patch` 中过）；
 *   · 给文件加上 **UTF-8 BOM**（`Set-Content -Encoding UTF8`）。
 *
 * ★ 为什么必须有一条断言盯着，而不是只在 AGENT.md 里写一句"注意编码"：
 *   这类损坏**不会让任何现有测试变红** —— 乱码照样是合法 JSON/合法 Markdown，
 *   机器人照常跑，只有人去读那几行字时才发现"这话怎么读不通"。
 *   而"没有断言盯着的纪律"在本项目里等于不存在。
 *
 * ── 判据（四条；实现只有一处，扫描与负对照共用）──────────────────────────
 *   ① **不许有 UTF-16 BOM**（`FF FE` / `FE FF`）—— 文本文件存成 UTF-16 一律是事故；
 *   ② **不许有 U+FFFD**（替换字符）—— 它是"解码时丢了信息"的痕迹；
 *   ③ **不许有误加的 UTF-8 BOM**（`.md/.mjs/.json/.patch/.txt` 等；`.bat` 历史用法豁免但会打印）；
 *   ④ ★ **不许是"UTF-8 被当 GBK 读"的乱码**（事故的第一形态，前三条都可能不命中它！
 *      实测：`Set-Content -Encoding UTF8` 产生的乱码**既没有 U+FFFD**（GBK 能表示那些字）
 *      又**带一个 BOM**（靠③抓住）；但如果换成不加 BOM 的写法，就只剩这一条能抓了）。
 *
 *   ★★ ④ 的判据是**标定过的**，不是拍脑袋：
 *     特征字集合 = **真实现场**（`cache/PROJECT.json.damaged-20260927.json`）里最高频的
 *     40 个 CJK 字符（锛 涓 銆 鍙 鐨 殑 笉 浠 級 鏈 璇 紝 …）—— 它们正是"UTF-8 中文被按 GBK
 *     解码"必然产生的那些字。实测：
 *       · 现场文件：命中 **19712 / 67856** 个 CJK 字符 = **29.0%**
 *       · 健康仓库 351 个文件里最高的一个：**2 个（0.006%）**
 *     判据取 `命中数 ≥ 5 且占比 ≥ 0.5%` **或** `命中数 ≥ 30`：
 *       · 大文件里只坏了几行（占比低）→ 靠"命中数 ≥ 30"抓住（健康上限只有 2，15 倍余量）
 *       · 小文件整份坏掉（占比高）→ 靠第一条抓住
 *       · 正当文本里偶尔出现这几个真字（如 鏃/杩/鍚 各一两次）→ 两条都不命中
 *     ⚠️ 边界如实说：它抓的是**成片的**乱码；**单个字**级别的损坏抓不住 —— 那种情况下
 *        ①②③ 才是主力（而"整份文件被重编码"这种最常见的事故形态一定会成片）。
 *
 * ── 豁免（必须写理由；没有理由的豁免等于没有守卫）────────────────────────
 *   个别文件**故意**引用乱码样本来示教（这份事故记录就是），逐个列出并说明原因。
 *   另有一条断言盯着豁免清单本身：条目必须存在、必须写原因（与 verify-imports 的白名单同一纪律）。
 *
 * 用法：node mocks/verify-text-encoding.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 从包根往上两级 = 仓库根（文档在 `<仓库>/docs/` 下，也在守卫范围内）。 */
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = dirname(dirname(PKG_ROOT))

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`✅ ${name}${detail ? `  —— ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`❌ ${name}  —— ${detail}`)
  }
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

/** 只看文本类文件；二进制/产物/运行痕迹一律跳过（它们不是"手写的东西"）。 */
const TEXT_EXT = /\.(md|mjs|cjs|js|json|txt|patch|ya?ml|ts|tsx|css|html|ps1)$/i
const SKIP_DIR = new Set([
  'node_modules', 'vendor', 'dist', 'logs', 'cache', '_release', 'snowluma',
  'workspace-qq', '.git', '.tmp-verify', '.tmp-verify-onebot', '.tmp-verify-doctor',
  '.tmp-live-workspace', '.tmp-live-outside', '.tmp-probe-dsh', 'reference',
  // ★ 桌面壳的构建产物（0.2.4）。为什么必须跳过：它整份是 **Electron 的运行时**
  //   （复制来的 Chromium），里面有几十 MB 的第三方文件 —— 比如
  //   `LICENSES.chromium.html`。那是**别人写的**东西，既不是我们手写的、
  //   也不该由我们的编码守卫来评判（实测它含 137 处 U+FFFD —— 那是 Chromium
  //   自己在许可证文本里放的替换字符，天知道为什么，但与我们无关）。
  //   ⚠️ 本套的判据是"我们自己的文本文件有没有被重编码写坏"，把它算进来只会
  //   制造一条**永远红的假失败**，而假失败会让人去改守卫。
  '.build-desktop',
])

/**
 * 故意引用乱码样本来示教的文件（**每条都必须写清为什么**）。
 * 相对仓库根。
 */
const MOJIBAKE_ALLOW = new Map([
  [
    'docs/0.2.2-project-json-incident.md',
    '事故记录：里面**故意**贴了乱码样本、特征字清单与标定数据（实测 15/3208 = 0.47%，就压在 0.5% 阈值边上）—— 不贴就说不清"坏成什么样"',
  ],
  [
    'packages/qq-bridge/mocks/verify-text-encoding.mjs',
    '守卫自己：它**定义**特征字集合、并内嵌用于负对照的乱码样本（实测 70/1771 = 3.95%）—— 不豁免自己就永远红',
  ],
])

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.tmp')) continue
    const abs = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue
      walk(abs, out)
    } else if (TEXT_EXT.test(e.name)) {
      out.push(abs)
    }
  }
  return out
}

/**
 * 乱码特征字：**从真实现场文件里统计出来的**（不是手挑的），见文件头标定数据。
 * 这 40 个字是"UTF-8 中文被按 GBK 解码"最高频的产物。
 */
const MOJIBAKE_SIG = new Set([
  ...[...'锛涓銆鍙鐨殑笉浠級鏈璇紝鍒細鏄鍚浜嶅杩璁瀹屽屾鍏鏂鏉竴紙鈽槄屼鐢槸閲夛斺鍦鍐鈥鏃'],
])

/** 命中数 ≥ 5 且占比 ≥ 0.5%，或命中数 ≥ 30（标定见文件头）。 */
const MOJIBAKE_MIN_SIG = 5
const MOJIBAKE_MIN_RATE = 0.005
const MOJIBAKE_HARD_SIG = 30

/**
 * 四条判据的实现（**只有一处**：扫描与负对照都用它，免得"守卫通过了但判据是错的"）。
 *
 * @returns {{ utf16: boolean, bom: boolean, fffd: number,
 *            moji: { sig: number, cjk: number, rate: number, bad: boolean } }}
 */
function inspectText(buf) {
  const utf16 = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const text = utf16 ? '' : buf.toString('utf8')
  // UTF-16 的内容按 UTF-8 读必然是乱的，再数 U+FFFD / 特征字没有意义
  const fffd = utf16 ? 0 : (text.match(/\uFFFD/g) ?? []).length
  let sig = 0
  let cjk = 0
  if (!utf16) {
    for (const ch of text) {
      const c = ch.codePointAt(0)
      if (c >= 0x2e80 && c <= 0x9fff) {
        cjk += 1
        if (MOJIBAKE_SIG.has(ch)) sig += 1
      }
    }
  }
  const rate = cjk > 0 ? sig / cjk : 0
  const bad = sig >= MOJIBAKE_HARD_SIG || (sig >= MOJIBAKE_MIN_SIG && rate >= MOJIBAKE_MIN_RATE)
  return { utf16, bom, fffd, moji: { sig, cjk, rate, bad } }
}

section('① 全仓库文本文件：不许 UTF-16 / U+FFFD / 误加的 BOM / 成片乱码')
{
  const files = walk(REPO_ROOT)
  const utf16 = []
  const fffd = []
  const bom = []
  const batBom = []
  const moji = []
  const allowed = []
  const precautionary = []
  for (const abs of files) {
    // ⚠️ Windows 上 relative() 给的是反斜杠，而豁免清单与输出统一用正斜杠 ——
    //    不归一化的话豁免**永远匹配不上**（第一版就踩了：守卫把自己报成乱码且豁免无效）。
    const rel = relative(REPO_ROOT, abs).split('\\').join('/')
    const { utf16: is16, bom: isBom, fffd: n, moji: m } = inspectText(readFileSync(abs))
    if (is16) {
      utf16.push(rel)
      continue
    }
    if (isBom) {
      if (/\.bat$/i.test(rel)) batBom.push(rel)
      else bom.push(rel)
    }
    if (n > 0) fffd.push(`${rel}(${n})`)
    if (MOJIBAKE_ALLOW.has(rel)) {
      // 豁免分两种，**如实区分**：当前真的被这条判据命中（"在用"），还是只是预防性豁免。
      // 不区分的话，豁免清单会悄悄变成"没人维护的挡箭牌"。
      if (m.bad) allowed.push(rel)
      else precautionary.push(rel)
    } else if (m.bad) {
      moji.push(`${rel}(${m.sig}/${m.cjk} = ${(m.rate * 100).toFixed(1)}%)`)
    }
  }
  check(
    `★ 扫了 ${files.length} 个文本文件：没有一个是 UTF-16`,
    utf16.length === 0,
    utf16.length ? `UTF-16：${utf16.join(', ')}` : '（0 个）',
  )
  check(
    '★★ 没有文件含 U+FFFD（解码丢信息的痕迹）',
    fffd.length === 0,
    fffd.length ? `${fffd.join(', ')} —— 这就是 2026-09-27 事故的形态之一` : '（0 个）',
  )
  check(
    '★ .md/.mjs/.json/.patch/.txt 都不带 UTF-8 BOM（git/node/JSON.parse 都不吃它）',
    bom.length === 0,
    bom.length ? `带 BOM：${bom.join(', ')}` : '（0 个）',
  )
  check(
    '★★ 没有"UTF-8 被当 GBK 读"的成片乱码（≥30 个特征字，或 ≥5 个且占比 ≥0.5%）',
    moji.length === 0,
    moji.length ? moji.join('；') : '（0 个）',
  )
  if (allowed.length) console.log(`   ℹ️  豁免·**当前在用**（真被这条判据命中）：${allowed.join(', ')}`)
  if (precautionary.length) console.log(`   ℹ️  豁免·预防性（暂时没命中，但这类文件故意引用样本）：${precautionary.join(', ')}`)
  if (batBom.length) console.log(`   ℹ️  .bat 带 UTF-8 BOM（历史用法，豁免不判红）：${batBom.join(', ')}`)

  // ★★ ①-b  `.bat` / `.cmd` **必须纯 ASCII**（0.2.4 新增；这条是被真事故逼出来的）
  //
  // 为什么单独一条、而且必须是**硬**判据：
  //   cmd 用**系统代码页**（中文 Windows = GBK）解析批处理文件，而本仓库的文件是 UTF-8。
  //   一个中文字符的字节被当成 GBK 读时，**行尾会被吞掉** —— cmd 于是把下一行当成
  //   这一行的一部分，整个 if-block 从中间断开。症状不是"报错停住"，而是：
  //       'em' is not recognized as an internal or external command
  //       'his' is not recognized as an internal or external command
  //   …十几行碎片，而**真正的那条命令根本没跑**（启动器看起来"什么都没做"）。
  //
  // 这个坑本仓库踩过三次（`创建带图标的快捷方式.bat` / `scripts/build-tools/npm.cmd` /
  //   0.2.4 的 `start.bat`）。第三次的代价是：`start.bat` 的中文注释让 **0.2.4 的
  //   启动链整个坏掉**（`启动机器人.bat --check` 那条分支直接不可用），而
  //   51 套离线测试全绿 —— 因为在那之前**没有任何东西**在检查这件事，
  //   `AGENT.md` 里那句"`.bat` 必须纯 ASCII"只是文档里的一句话。
  //   ∴ 现在它是可执行的判据（`AGENT.md` 第 11 条）。
  //
  // ⚠️ 判据是"**任何**非 ASCII 字节"（不是"中文字符"）：GBK 里行尾字节 0x5C 之类的
  //   边界情况太绕，而"批处理文件纯 ASCII"本来就没有代价（要解释就写在 .md / .mjs 里）。
  const batNonAscii = []
  for (const abs of walk(REPO_ROOT)) {
    const rel = relative(REPO_ROOT, abs).split('\\').join('/')
    if (!/\.(bat|cmd)$/i.test(rel)) continue
    const buf = readFileSync(abs)
    const bad = []
    for (let i = 0; i < buf.length; i += 1) if (buf[i] > 127) bad.push(i)
    if (bad.length) {
      // 报出**第一处**所在的整行，让人一眼看到是哪句话写坏的（而不是只知道有 N 个字节）
      const text = buf.toString('utf8')
      const upto = buf.subarray(0, bad[0]).toString('utf8')
      const lineNo = upto.split(/\r?\n/).length
      const lineText = text.split(/\r?\n/)[lineNo - 1] ?? ''
      batNonAscii.push(`${rel}(第 ${lineNo} 行，${bad.length} 个字节：${lineText.trim().slice(0, 60)})`)
    }
  }
  check(
    '★★ 所有 .bat / .cmd 都是纯 ASCII（cmd 按系统代码页解析，非 ASCII 会吞掉换行）',
    batNonAscii.length === 0,
    batNonAscii.length
      ? `${batNonAscii.join('；')}\n      —— 把中文/全角符号**删掉或改写成 ASCII**（要解释就写在 .md/.mjs 里）。` +
        '\n      症状不是"报错停住"，而是十几行 `\'em\' is not recognized...` 且真正的命令没跑。'
      : '（0 个）',
  )

  // ★★★ ①-c  `.bat` / `.cmd` 的**注释里不许出现裸的重定向符**（0.2.4 新增，被真事故逼出来的）
  //
  // 为什么这条比上一条还贵：`>` 对 cmd 是**重定向**，而 `rem` 只吃掉"命令"、
  // **不吃掉重定向**。实测事故（0.2.4）：我在注释里写了
  //     rem   DesktopBot.lnk -> 桌面端bot启动.bat
  // cmd 于是去找一个叫 `DesktopBot.lnk` 的命令，并把**目标文件截断成 0 字节** ——
  // 一次弄空了 `桌面端bot启动.bat` **和** `启动机器人.bat`（后者是用户的主入口）。
  // 两个文件都变 0 字节，**而离线测试当时没红**：没有任何断言读那两个文件的**内容**。
  //
  // ∴ 判据：注释行（rem / ::）里不许有**未转义**的 `>` 或 `<`。
  //   默认拒绝，不开"看起来无害就放行"的口子 —— 真事故正是从"看起来只是注释"开始的。
  const batRedirect = []
  for (const abs of walk(REPO_ROOT)) {
    const rel = relative(REPO_ROOT, abs).split('\\').join('/')
    if (!/\.(bat|cmd)$/i.test(rel)) continue
    const text = readFileSync(abs, 'utf8')
    text.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim()
      if (!/^(rem\b|::)/i.test(t)) return
      const bare = t.replace(/\^[<>]/g, '') // 去掉已转义的 ^> ^<
      if (/[<>]/.test(bare)) batRedirect.push(`${rel}(第 ${i + 1} 行：${t.slice(0, 60)})`)
    })
  }
  check(
    '★★★ .bat/.cmd 注释里没有裸的 > 或 <（rem 不阻止重定向 —— 实测把文件截断成 0 字节）',
    batRedirect.length === 0,
    batRedirect.length
      ? `${batRedirect.join('；')}\n      —— 注释里要写箭头就写 "to"，或用 ^> 转义。` +
        '\n      0.2.4 真事故：一句 `rem  foo.lnk -> bar.bat` 把两个启动器都截成了 0 字节，而测试全绿。'
      : '（0 个）',
  )

  // ★ 顺带：那两个启动器**必须有内容**（0 字节是这次事故的形态，而"存在性"断言看不出它）
  for (const rel of ['packages/qq-bridge/启动机器人.bat', 'packages/qq-bridge/桌面端bot启动.bat']) {
    const abs = join(REPO_ROOT, rel)
    if (!existsSync(abs)) continue
    const size = statSync(abs).size
    check(`★ ${rel.replace('packages/qq-bridge/', '')} 不是空文件（>0 字节）`, size > 200, `${size} 字节`)
  }

  // 豁免清单本身也要有纪律：条目必须存在、必须写理由。
  check(
    '★ 乱码豁免清单里的文件都真实存在且写了理由',
    [...MOJIBAKE_ALLOW.entries()].every(([rel, why]) => existsSync(join(REPO_ROOT, rel)) && String(why).trim().length > 10),
    `（${MOJIBAKE_ALLOW.size} 条）`,
  )
}

section('② ★★ 负对照：这套判据真的抓得住那次事故的四种形态吗')
{
  // ★ 为什么要有这一段：没有它，上面那几条"全绿"完全可能只是**判据写错了**。
  //   本项目对每条守卫都要求"验过牙"（把修复回退掉，测试必须变红）。
  //
  // ⚠️ 乱码样本**不能直接手抄进源码**：抄的时候极容易踩到这次事故本身的现象 ——
  //    乱码里那个被吃掉的 `"` 会让字符串字面量缺一个引号（我第一版就是这么写坏的，
  //    报错是 `SyntaxError: missing ) after argument list`）。所以：
  //    ① 优先读 cache 里那份**真实现场文件**（gitignore，别人 clone 下来没有，属正常）；
  //    ② 没有就用**码点**构造等价样本（不经过手抄）。
  const MOJIBAKE_SAMPLE = (() => {
    try {
      const t = readFileSync(join(PKG_ROOT, 'cache', 'PROJECT.json.damaged-20260927.json'), 'utf8')
      const i = t.indexOf('\u6D5C\u9E3F\u6434\u64C4\u7D19') // 「浜鸿搴擄紙…」= 人设库（…）
      if (i >= 0) return t.slice(i, i + 40)
    } catch {
      /* 取证文件不在 → 用下面的码点样本 */
    }
    // 「浜鸿搴擄紙0.2.2锛夛細涓€涓枃浠朵竴濂椾汉璁」= 人设库（0.2.2）：一个文件一套人设
    return String.fromCharCode(
      0x6d5c, 0x9e3f, 0x6434, 0x64c4, 0x7d19, 0x30, 0x2e, 0x32, 0x2e, 0x32,
      0x951b, 0x591b, 0x7d30, 0x6d93, 0x20ac, 0x6d93, 0x6783, 0x6d60, 0x4e00, 0x6f66, 0x6924, 0x6c49, 0x8bc1,
    )
  })()

  const cases = [
    ['UTF-16LE BOM（PowerShell `>` 重定向的产物）', Buffer.from([0xff, 0xfe, 0x64, 0x00]), (r) => r.utf16 === true],
    ['UTF-16BE BOM', Buffer.from([0xfe, 0xff, 0x00, 0x64]), (r) => r.utf16 === true],
    ['U+FFFD（丢字节留下的替换字符）', Buffer.from('{"a":"人设\uFFFD库"}', 'utf8'), (r) => r.fffd === 1],
    ['UTF-8 BOM', Buffer.from([0xef, 0xbb, 0xbf, 0x7b]), (r) => r.bom === true],
    [
      '★ 成片乱码（真实现场原文，**没有 BOM 也没有 U+FFFD** —— 只有判据④能抓）',
      Buffer.from(MOJIBAKE_SAMPLE, 'utf8'),
      (r) => r.moji.bad === true && r.bom === false && r.fffd === 0,
    ],
    [
      '★ 小文件整份坏掉（靠"占比"那一条抓）',
      Buffer.from(MOJIBAKE_SAMPLE, 'utf8'),
      (r) => r.moji.bad === true && r.moji.sig >= MOJIBAKE_MIN_SIG && r.moji.rate >= MOJIBAKE_MIN_RATE,
    ],
  ]
  for (const [name, buf, ok] of cases) {
    const r = inspectText(buf)
    check(`★ 抓得住：${name}`, ok(r), JSON.stringify(r))
  }
  const positives = [
    ['正常 UTF-8 中文一个字都不误报', '{"note":"人设库 · 一个文件一套人设（0.2.2）—— 见 personas/"}'],
    ['正当文本里偶尔出现几个特征字也不误报', '这个字念 鏃（箭头），那个念 杩，还有一个 鍚 —— 都是真字，各出现一两次。'],
    ['英文/代码为主的文件不误报', 'export function check(name, ok) { return ok }'],
  ]
  for (const [name, s] of positives) {
    const r = inspectText(Buffer.from(s, 'utf8'))
    check(`正对照：${name}`, r.moji.bad === false && r.fffd === 0 && r.bom === false, `特征字 ${r.moji.sig}/${r.moji.cjk}`)
  }
  console.log(`   ℹ️  乱码样本长度 ${MOJIBAKE_SAMPLE.length} 字（优先取自 cache 里的真实现场）`)
}

section('③ 事故现场的文件：按最严口径单独盯一遍')
{
  // 这两个文件正是那次事故的受害者，各加一条**指名**断言：
  // 将来有人再拿 PowerShell 重写一遍，报错里会直接出现文件名。
  const proj = join(PKG_ROOT, 'PROJECT.json')
  const projText = readFileSync(proj, 'utf8')
  check('★ PROJECT.json 是合法 JSON 且不含 U+FFFD / 不成片乱码', (() => {
    const r = inspectText(readFileSync(proj))
    if (r.fffd > 0 || r.moji.bad) return false
    try {
      JSON.parse(projText)
      return true
    } catch {
      return false
    }
  })(), '（它就是被 PowerShell 重编码写坏过的那份）')

  const patch = join(REPO_ROOT, 'docs', '0.2.2-pixiv-adaptation.patch')
  const pb = readFileSync(patch)
  const pt = pb.toString('utf8')
  check('★ pixiv 迁移 patch 是 UTF-8（没有 NUL 字节 / 不是 UTF-16）',
    !(pb[0] === 0xff && pb[1] === 0xfe) && !pb.includes(0x00) && pt.startsWith('diff --git '),
    `头 16 字节：${JSON.stringify(pt.slice(0, 16))}`)
  check('★ 那份 patch 的 hunk 数没变（31 个）—— 重编码不该改内容',
    (pt.match(/^@@/gm) ?? []).length === 31,
    `实际 ${(pt.match(/^@@/gm) ?? []).length} 个`)

  const doc = join(REPO_ROOT, 'docs', '0.2.2-project-json-incident.md')
  check('★ 事故记录存在（这份守卫的"为什么"写在那里，不是只有代码）', existsSync(doc))
}

console.log('')
if (failed > 0) {
  console.log(`⚠️ ${failed} 项失败 / ${passed} 项通过`)
  console.log('   修法：不要用 PowerShell 的 Get-Content/Set-Content/`>` 改这些文件；')
  console.log('   用仓库的文件工具，或 git --output=<file> / .NET 显式编码。')
  console.log('   完整判据、标定数据与恢复步骤见 docs/0.2.2-project-json-incident.md。')
  process.exitCode = 1
} else {
  console.log(`✅ 文本编码守卫全部通过（${passed} 项）`)
}
