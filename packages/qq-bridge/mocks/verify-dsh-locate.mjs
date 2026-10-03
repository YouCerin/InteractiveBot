#!/usr/bin/env node
/**
 * DSH 定位（实机 BUG-5）与 asar 抽取的测试。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 事故形态
 * ══════════════════════════════════════════════════════════════════════════
 * 《首次使用.txt》说"装完 DSH 桌面版不用做任何配置"，实测却不成立，两个原因叠加：
 *   ① 目录名对不上：装出来是 `DeepSeek Harness`（**带空格**），候选表写的是 `DeepSeekHarness`；
 *   ② 形态对不上：CLI 被打包在 `resources\app.asar` 里，`resources\app` 目录**不存在**，
 *      而普通 node 读不了 asar（实测 `Cannot find module '…app.asar\…'`）。
 * 抽出来之后是**完全可用**的（实测 `--version` → 0.2.0-rc.2、`✅ DSH 就绪`）。
 *
 * 所以这一套盯三件事：
 *   · 候选表：两种目录名 ×（app / app.asar / app.asar.unpacked）都要在；
 *   · **asar 候选不算"找到"**，但必须能被 `findDshAsar()` 检出来并给出抽取指引；
 *   · 抽取器：真的从一个 asar（本测试自己按 Electron 格式造一个）里把文件写出来，
 *     含 `unpacked: true` 的原生模块旁路、前缀剥离、路径逃逸拒绝。
 *
 * 用法：node mocks/verify-dsh-locate.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync, readSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DSH_APP_DIR_NAMES,
  describeDshCandidates,
  dshAsarFixHint,
  findDshAsar,
  findDshCli,
  findDshCliWithSource,
} from '../src/local.mjs'
import {
  CLI_BIN_REL,
  extractDshFromAsar,
  findAsarEntry,
  findCliRoot,
  readAsarHeader,
  walkAsarFiles,
} from '../src/dsh-extract.mjs'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TMP = mkdtempSync(join(tmpdir(), 'verify-dsh-locate-'))

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

// ══════════════════════════════════════════════════════════════════════════
// 按 Electron 的 asar 格式**造**一个归档（用来测抽取器）
//   文件头 8 字节 = pickle{ UInt32 headerPickleSize }
//   header pickle = [UInt32 payloadLen][UInt32 jsonLen][json…][padding]
//   文件体偏移基准 = 8 + headerPickleSize，各条目 offset 相对它
// ══════════════════════════════════════════════════════════════════════════
const align4 = (n) => n + ((4 - (n % 4)) % 4)

function setTree(tree, rel, entry) {
  const parts = String(rel).split('/')
  let node = tree
  for (let i = 0; i < parts.length - 1; i += 1) {
    node.files[parts[i]] ??= { files: {} }
    node = node.files[parts[i]]
  }
  node.files[parts[parts.length - 1]] = entry
}

function buildAsar(entries) {
  const tree = { files: {} }
  const bodies = []
  let offset = 0
  for (const e of entries) {
    const buf = Buffer.isBuffer(e.content) ? e.content : Buffer.from(String(e.content), 'utf8')
    if (e.unpacked) {
      setTree(tree, e.rel, { size: buf.length, unpacked: true })
      continue
    }
    setTree(tree, e.rel, { size: buf.length, offset: String(offset) })
    bodies.push(buf)
    offset += buf.length
  }
  const jsonBuf = Buffer.from(JSON.stringify(tree), 'utf8')
  const payloadLen = 4 + jsonBuf.length
  const headerBuf = Buffer.alloc(4 + align4(payloadLen))
  headerBuf.writeUInt32LE(payloadLen, 0)
  headerBuf.writeUInt32LE(jsonBuf.length, 4)
  jsonBuf.copy(headerBuf, 8)
  const head = Buffer.alloc(8)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(headerBuf.length, 4)
  return Buffer.concat([head, headerBuf, ...bodies])
}

/** 把归档写到磁盘，并（可选）写出 app.asar.unpacked 旁路文件。 */
function writeAsarFixture(name, entries, unpackedFiles = {}) {
  const dir = join(TMP, name)
  mkdirSync(dir, { recursive: true })
  const asarPath = join(dir, 'app.asar')
  writeFileSync(asarPath, buildAsar(entries))
  for (const [rel, content] of Object.entries(unpackedFiles)) {
    const p = join(`${asarPath}.unpacked`, ...rel.split('/'))
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content)
  }
  return { dir, asarPath }
}

const BIN_MARK = '// fake DSH CLI bin.js'

async function main() {
  // ══════════════════════════════════════════════════════════════════════
  section('① 候选表：两种目录名 × 三种形态都要在（BUG-5 的第一半）')
  // ══════════════════════════════════════════════════════════════════════
  {
    const cands = describeDshCandidates({ searchPaths: [] })
    const sources = cands.map((c) => c.source).join('\n')
    check('★ 带空格的目录名（DeepSeek Harness）在候选表里',
      sources.includes('DeepSeek Harness'), DSH_APP_DIR_NAMES.join(' / '))
    check('  不带空格的目录名（DeepSeekHarness）也还在（老安装/别的版本）',
      sources.includes('DeepSeekHarness'))
    check('★ Program Files 与 %LOCALAPPDATA%\\Programs 两处都覆盖',
      /Program Files/.test(sources) && /%LOCALAPPDATA%\\Programs/.test(sources))
    check('★ 三种形态都覆盖：app / app.asar / app.asar.unpacked',
      ['app', 'asar', 'unpacked'].every((k) => cands.some((c) => c.kind === k)),
      JSON.stringify(cands.map((c) => c.kind)))
    check('  asar 形态被标成 kind=asar（查找时要跳过它）',
      cands.some((c) => c.kind === 'asar') && cands.some((c) => c.kind === 'app') && cands.some((c) => c.kind === 'unpacked'))
    check('  vendor/dsh 仍是第 1 优先级（"抽到那儿就自动生效"的前提）',
      cands[0].source.includes('vendor/dsh'), cands[0].source)
    check('  asar 候选的说明里点了"普通 node 读不了、需先抽取"',
      cands.filter((c) => c.kind === 'asar').every((c) => /读不了|抽取/.test(c.source)))
  }

  // ══════════════════════════════════════════════════════════════════════
  section('② asar 存在但 CLI 不是一个"普通目录"：不许算找到，但要说清怎么修')
  // ══════════════════════════════════════════════════════════════════════
  {
    const root = join(TMP, 'app-root-asar-only')
    mkdirSync(join(root, 'resources'), { recursive: true })
    writeFileSync(join(root, 'resources', 'app.asar'), buildAsar([{ rel: `dsh/${CLI_BIN_REL}`, content: BIN_MARK }]))
    check('★ 只有 asar 时，findDshCli 返回 null（普通 node 确实读不了）',
      findDshCli({ searchPaths: [root] }) === null)
    const asar = findDshAsar({ searchPaths: [root] })
    check('★ 但 findDshAsar 能把它检出来（两种"没找到"要能区分开）',
      asar?.asarPath === join(root, 'resources', 'app.asar'), JSON.stringify(asar))
    const hint = dshAsarFixHint(asar)
    check('  指引里给了可直接照抄的命令（--extract-dsh + 路径）',
      hint.includes('--extract-dsh') && hint.includes(asar.asarPath), hint.split('\n')[1])
    check('  指引里说明抽到 vendor/dsh 后不必再配', /vendor\\\\dsh|vendor\\dsh/.test(hint))

    // 正常的"解包目录"形态仍然必须能找到（别为了修 asar 把老形态弄坏）
    const root2 = join(TMP, 'app-root-plain')
    const cli = join(root2, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    mkdirSync(dirname(cli), { recursive: true })
    writeFileSync(cli, BIN_MARK)
    writeFileSync(join(root2, 'resources-app.asar-placeholder'), 'x')
    check('★ 解包目录形态照旧能找到（含来源）',
      findDshCliWithSource({ searchPaths: [root2] })?.cliPath === cli,
      JSON.stringify(findDshCliWithSource({ searchPaths: [root2] })))
  }

  // ══════════════════════════════════════════════════════════════════════
  section('③ 造一个 asar → 抽取 → 核对内容（含 unpacked 原生文件）')
  // ══════════════════════════════════════════════════════════════════════
  {
    const entries = [
      { rel: `dsh/${CLI_BIN_REL}`, content: BIN_MARK },
      { rel: 'dsh/package.json', content: '{"name":"dsh-shell"}' },
      { rel: 'dsh/node_modules/@deepseek-ai/dsh/package.json', content: '{"name":"@deepseek-ai/dsh","version":"0.2.0-rc.2"}' },
      // 归档根下**不属于** CLI 安装根的桌面版外壳：必须被跳过
      { rel: 'main.js', content: '// electron main' },
      { rel: 'index.html', content: '<html></html>' },
      // 原生模块：标记 unpacked，内容在旁边的 app.asar.unpacked 里
      { rel: 'dsh/node_modules/pty/native.node', content: 'PTY-BYTES', unpacked: true },
    ]
    const { asarPath } = writeAsarFixture('extract-ok', entries, {
      'dsh/node_modules/pty/native.node': 'PTY-BYTES-REAL',
    })
    const target = join(TMP, 'vendor-dsh-out')
    const logs = []
    const r = extractDshFromAsar({ asarPath, targetDir: target, log: (m) => logs.push(String(m)) })
    check('抽取成功', r.ok === true, r.error ?? '')
    check('★ bin.js 落在 <target>/node_modules/@deepseek-ai/dsh/lib/bin.js（前缀 `dsh/` 被剥掉）',
      r.binPath === join(target, ...CLI_BIN_REL.split('/')) && existsSync(r.binPath), String(r.binPath))
    check('  内容与归档里一致（不是空文件/错位）',
      existsSync(r.binPath) && readFileSync(r.binPath, 'utf8') === BIN_MARK)
    check('  dsh/package.json 也出来了（说明整棵 CLI 树都抽了）',
      existsSync(join(target, 'package.json')) &&
        JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name === 'dsh-shell')
    check('★ 归档根下的桌面版外壳**没有**被抽进去（target/main.js 不存在）',
      !existsSync(join(target, 'main.js')) && !existsSync(join(target, 'index.html')))
    check('★ unpacked 条目从 app.asar.unpacked 取到了真内容',
      readFileSync(join(target, 'node_modules/pty/native.node'), 'utf8') === 'PTY-BYTES-REAL')
    check('  计数如实：files / unpacked / skipped 都不为 0', r.files >= 3 && r.unpacked === 1 && r.skipped >= 2,
      JSON.stringify({ files: r.files, unpacked: r.unpacked, skipped: r.skipped }))
    check('  日志里报出了跳过数量（不静默）', logs.some((l) => /跳过/.test(l)), logs.join(' | '))
  }

  // ══════════════════════════════════════════════════════════════════════
  section('④ unpacked 旁路缺文件：必须报出来（原生模块漏了 DSH 会在加载时才炸）')
  // ══════════════════════════════════════════════════════════════════════
  {
    const entries = [
      { rel: `dsh/${CLI_BIN_REL}`, content: BIN_MARK },
      { rel: 'dsh/node_modules/pty/native.node', content: 'X', unpacked: true },
    ]
    const { asarPath } = writeAsarFixture('extract-missing-unpacked', entries) // 故意不写旁路
    const target = join(TMP, 'vendor-dsh-missing')
    const logs = []
    const r = extractDshFromAsar({ asarPath, targetDir: target, log: (m) => logs.push(String(m)) })
    check('★ 缺的 unpacked 条目被列出来（不是静默跳过）',
      r.missingUnpacked.length === 1 && r.missingUnpacked[0].endsWith('native.node'), JSON.stringify(r.missingUnpacked))
    check('  日志里给了 ⚠️ 警告', logs.some((l) => l.includes('找不到')), logs.join(' | '))
    check('  CLI 本体仍然抽出来了（能用的部分照常用）', r.ok === true && existsSync(r.binPath))
  }

  // ══════════════════════════════════════════════════════════════════════
  section('⑤ 归档布局变化 / 坏归档 / 路径逃逸：都要挡住')
  // ══════════════════════════════════════════════════════════════════════
  {
    // 前缀为空（归档根就是 CLI 安装根）
    const flat = writeAsarFixture('extract-flat', [{ rel: CLI_BIN_REL, content: BIN_MARK }])
    const flatTarget = join(TMP, 'vendor-dsh-flat')
    const fr = extractDshFromAsar({ asarPath: flat.asarPath, targetDir: flatTarget, log: () => {} })
    check('★ 归档根就是安装根时也能抽（前缀自动判定为空）',
      fr.ok === true && fr.prefix === '' && existsSync(join(flatTarget, ...CLI_BIN_REL.split('/'))), JSON.stringify({ prefix: fr.prefix, ok: fr.ok }))

    // 不是 DSH 的 asar
    const other = writeAsarFixture('extract-not-dsh', [{ rel: 'package.json', content: '{"name":"blockbench"}' }])
    const nr = extractDshFromAsar({ asarPath: other.asarPath, targetDir: join(TMP, 'vendor-dsh-other'), log: () => {} })
    check('★ 不是 DSH 的 asar → 明确报错，不假装成功',
      nr.ok === false && /找不到/.test(nr.error ?? ''), nr.error)

    // 截断的归档
    const truncated = join(TMP, 'truncated.asar')
    writeFileSync(truncated, Buffer.from([1, 2, 3]))
    const tr = extractDshFromAsar({ asarPath: truncated, targetDir: join(TMP, 'vendor-dsh-trunc'), log: () => {} })
    check('  截断的归档 → 报错不崩', tr.ok === false && /头部/.test(tr.error ?? ''), tr.error)
    check('  不存在的路径 → 报错不崩',
      extractDshFromAsar({ asarPath: join(TMP, 'nope.asar'), targetDir: join(TMP, 'x'), log: () => {} }).ok === false)

    // 路径逃逸：条目名里带 `..`
    const evil = writeAsarFixture('extract-evil', [
      { rel: `dsh/${CLI_BIN_REL}`, content: BIN_MARK },
      { rel: 'dsh/../evil.txt', content: 'PWNED' },
    ])
    const er = extractDshFromAsar({ asarPath: evil.asarPath, targetDir: join(TMP, 'vendor-dsh-evil'), log: () => {} })
    check('★★ 归档里带 `..` 的条目被拒绝（不许写到目标目录之外）',
      er.ok === false && /不安全|逃出/.test(er.error ?? ''), er.error)
    check('  也没有真的写出那个文件', !existsSync(join(TMP, 'evil.txt')))
  }

  // ══════════════════════════════════════════════════════════════════════
  section('⑥ ★ 用**真实** asar 验一次解析器（本机有的话；报告的"决定性实验"反向验证）')
  // ══════════════════════════════════════════════════════════════════════
  {
    // 说明：这一段是"有条件"的 —— 本机没装任何 Electron 应用时无处可取。
    // 它会**明确说出**自己跳过了，不留一个"看起来通过"的假象。
    const known = [
      'D:\\blockbench\\resources\\app.asar',
      join(process.env.LOCALAPPDATA ?? '', 'Programs', 'kimi-desktop', 'resources', 'app.asar'),
    ]
    const real = known.find((p) => p && existsSync(p))
    if (!real) {
      console.log('⏭  本机没有可用的真实 app.asar —— 这一段跳过（其余断言照常）')
    } else {
      const header = readAsarHeader(real)
      const all = walkAsarFiles(header.tree)
      check(`  真实归档解析得出文件树（${all.length} 个条目）`, all.length > 0)
      const pkg = findAsarEntry(header.tree, 'package.json')
      check('  能找到根 package.json 条目', Boolean(pkg))
      if (pkg && !pkg.unpacked) {
        const fd = openSync(real, 'r')
        const buf = Buffer.alloc(Number(pkg.size))
        readSync(fd, buf, 0, buf.length, header.bodyOffset + Number(pkg.offset))
        closeSync(fd)
        const parsed = JSON.parse(buf.toString('utf8'))
        check('★★ 按 `bodyOffset + offset` 取出的内容是真的（JSON.parse 通过且字段合理）',
          typeof parsed.name === 'string' && parsed.name.length > 0, `name=${parsed.name}`)
      }
      check('★ 报告的"决定性实验"仍然成立：普通 node 读 asar 内部路径会失败',
        (() => {
          try {
            readFileSync(join(real, 'package.json'), 'utf8')
            return false
          } catch {
            return true
          }
        })())
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  section('⑦ 接线守卫：CLI 真的提供了这条出路')
  // ══════════════════════════════════════════════════════════════════════
  {
    const idx = readFileSync(join(PKG_ROOT, 'src', 'index.mjs'), 'utf8')
    check('★ index.mjs 有 --extract-dsh 入口', idx.includes("'--extract-dsh'"))
    check('★ 它调用抽取器（不是只打印一句提示）', /extractDshFromAsar\s*\(/.test(idx))
    check('★ 默认抽到 vendor/dsh（第 1 优先级候选，抽完即可用）', /DIRS\.vendorDsh/.test(idx))
    const setup = readFileSync(join(PKG_ROOT, 'setup.mjs'), 'utf8')
    check('★ setup.mjs 的 --check 在"没找到 DSH"时也会提 asar 这条路',
      /findDshAsar\s*\(/.test(setup) && /dshAsarFixHint\s*\(/.test(setup), '')
    const doc = readFileSync(join(PKG_ROOT, '首次使用.txt'), 'utf8')
    check('★★ 文档不再承诺"不用做任何配置"（实测不成立）',
      !/不用做任何配置/.test(doc))
    check('  文档里写了 --extract-dsh 这条命令', /--extract-dsh/.test(doc))
  }

  rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? '🎉 DSH 定位与 asar 抽取验证通过' : `⚠️ ${failures} 项失败`}\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('验证脚本自身崩了：', error)
  process.exit(1)
})
