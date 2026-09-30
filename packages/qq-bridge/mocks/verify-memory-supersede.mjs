/**
 * 记忆更正（H4 / 验收 R10）测试：**纠正用 supersede，不用覆盖**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套盯的三件事
 * ══════════════════════════════════════════════════════════════════════════
 * ① **旧条目必须还在**：用户先说"服务器是 Forge 端"、后说"改成 Paper 了" ——
 *    旧条目要被标注、**不能删**（"我说错过什么"是可追溯性，删了就永远查不出）。
 * ② **被更正的条目不能再被当成事实**：不注入给模型、整理时不参与合并、不被删。
 * ③ **不许越界**：只能靠**两种无歧义信号**触发 —— 模型显式 `fix` 档，
 *    或**自指式更正措辞**（"纠正一下""我之前说错了"）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 这一套里最值钱的断言是**边界**那几条（第一版就是被它们推翻的）
 * ══════════════════════════════════════════════════════════════════════════
 * 第一版判据是"更正措辞（含 换成/改成/其实）+ 相似度 ≥0.35"。实测把这条路证伪了：
 *
 *     0.273  真更正    「他的 MC 服务器是 Forge 端」 ↔ 「他的 MC 服务器换成了 Paper 端」
 *     0.286  不是更正  「他的 MC 服务器是 Forge 端」 ↔ 「他的 MC 服务器内存改成 32G 了」
 *
 * **差 0.013** —— 阈值放哪都会错一边：往低调就把"同一主体的另一件事"当成更正
 * （**一条真事实被悄悄停用**），往高调就漏掉真更正。所以现在**只认无歧义信号**，
 * 并且下面有专门的反例断言把"换成/改成/其实"钉在门外。
 *
 * 用法：node mocks/verify-memory-supersede.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  hasSupersedeCue,
  buildSupersedeNote,
  isSuperseded,
  readSupersedeNote,
  stripSupersedeNote,
  markSupersededLine,
  pickSupersedeTarget,
} from '../src/memory-supersede.mjs'
import { similarity } from '../src/text-similarity.mjs'
import {
  applyMemoryItems,
  parseMemoryMarkers,
  readMemoryForPrompt,
  verifyAndRestoreMemory,
  saveSnapshot,
  SCOPE,
} from '../src/memory-store.mjs'
import { consolidateEntries, consolidateFile, parseEntries, renderLines } from '../src/memory-consolidate.mjs'

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

const ROOT = mkdtempSync(join(tmpdir(), 'qq-bridge-supersede-'))
const readIf = (ws, rel) => {
  const p = join(ws, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

try {
  // ══════════════════════════════════════════════════════════════════════════
  section('① 标注格式：可读、可解析、幂等')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const at = new Date('2026-09-26T10:00:00')
    const line = '- 他的 MC 服务器是 Forge 端'
    const r = markSupersededLine(line, { newEntry: '他的 MC 服务器换成了 Paper 端', at })
    check('标注追加在行尾（原条目原样保留）',
      r.changed && r.line.startsWith(line) && r.line.includes('已被更正'), r.line)
    check('★ 人能一眼看懂（全角括号 + 新事实摘要 + 日期）',
      r.line.includes('Paper 端') && r.line.includes('2026-09-26'), r.line)
    check('★ 幂等：再标一次不变（防止越标越长）',
      markSupersededLine(r.line, { newEntry: '别的', at }).changed === false)
    check('isSuperseded 认得出', isSuperseded(r.line) === true && isSuperseded(line) === false)
    check('readSupersedeNote 能取回摘要与日期', (() => {
      const n = readSupersedeNote(r.line)
      return n && n.at === '2026-09-26' && n.note.includes('Paper')
    })(), JSON.stringify(readSupersedeNote(r.line)))
    check('★★ stripSupersedeNote 取回"这条本来在说什么"（所有比较都必须用它）',
      stripSupersedeNote(r.line) === line, stripSupersedeNote(r.line))
    check('空行/空串不标（不抛）',
      markSupersededLine('', {}).changed === false && markSupersededLine('   ', {}).changed === false)
    check('摘要被截断（标注是"指向"，不是复制一份新事实）',
      buildSupersedeNote({ newEntry: '啊'.repeat(200), at }).length < 120)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('② ★★ 边界（实测数据推翻过第一版判据，这几条是护栏）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const forge = '他的 MC 服务器是 Forge 端'
    const paper = '他的 MC 服务器换成了 Paper 端'
    const mem = '他的 MC 服务器内存改成 32G 了'

    check('★★ 先把实测数字固化下来：真更正 0.273 / 另一件事 0.286 —— 差 0.013，分不开',
      Math.abs(similarity(forge, paper) - 0.273) < 0.01 && Math.abs(similarity(forge, mem) - 0.286) < 0.01,
      `${similarity(forge, paper).toFixed(3)} vs ${similarity(forge, mem).toFixed(3)}`)

    const noHit = [
      ['换成', paper],
      ['改成', mem],
      ['其实', '其实他的 MC 服务器是 Paper 端'],
      ['不再用', '他的 MC 服务器不再用 Forge 端了'],
      ['更新为', '他的 MC 服务器更新为 Paper 端'],
    ]
    for (const [word, text] of noHit) {
      check(`★★ 「${word}」类措辞**不再**被当成更正信号（实测分不开，宁可漏也不误伤）`,
        hasSupersedeCue(text) === false, text)
    }

    const hit = [
      ['纠正一下', '纠正一下，他的 MC 服务器是 Paper 端'],
      ['更正', '更正：他的 MC 服务器是 Paper 端'],
      ['我之前说错了', '我之前说错了，他的 MC 服务器是 Paper 端'],
      ['之前记的不对', '之前记的不对，服务器是 Paper 端'],
      ['记错了', '记错了，服务器是 Paper 端'],
      ['收回刚才', '收回刚才那句，服务器是 Paper 端'],
    ]
    for (const [word, text] of hit) {
      check(`★ 自指式更正「${word}」被认出来`, hasSupersedeCue(text) === true, text)
    }
    check('★ 中性陈述不是更正信号（"他的系统是 Linux"）',
      hasSupersedeCue('他的系统是 Linux') === false)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('③ 挑"该被更正的那条"：两条判据 + 不挑的情形')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const lines = ['- 他的 MC 服务器是 Forge 端', '- 他喜欢喝冰美式', '- 他的主机是 B650M']
    const pick = (entry, opts = {}) => pickSupersedeTarget({ lines, newEntry: entry, similarity, ...opts })

    check('★ 自指式更正 + 同一主语 → 挑中',
      pick('纠正一下，他的 MC 服务器是 Paper 端')?.line === lines[0],
      JSON.stringify(pick('纠正一下，他的 MC 服务器是 Paper 端')))
    check('★★ 显式 force（模型 `fix` 档）→ 不需要任何措辞就能挑中',
      pick('他的 MC 服务器是 Paper 端', { force: true })?.line === lines[0],
      JSON.stringify(pick('他的 MC 服务器是 Paper 端', { force: true })))
    check('★ force 也仍然要求"像同一条"（floor 挡住完全无关的）',
      pick('今天的天气是 30 度', { force: true }) === null,
      JSON.stringify(pick('今天的天气是 30 度', { force: true })))
    check('★★ 有自指措辞但主语完全不同 → 不挑',
      pick('纠正一下，他的显示器是 4K') === null, JSON.stringify(pick('纠正一下，他的显示器是 4K')))
    check('★★ 没有信号 → 一个字都不动（"服务器是 Paper 端"这种纯覆盖不猜）',
      pick('他的 MC 服务器是 Paper 端') === null)
    check('★ 已经被更正过的那条不会被第二条再覆盖（保留第一次的指向）', (() => {
      const marked = [markSupersededLine(lines[0], { newEntry: 'x' }).line, ...lines.slice(1)]
      return pickSupersedeTarget({ lines: marked, newEntry: '纠正一下，服务器是 Velocity 端', similarity }) === null
    })())
    check('空参数不抛（缺 similarity / 空 newEntry / 空 lines）',
      pickSupersedeTarget({}) === null &&
        pickSupersedeTarget({ lines, newEntry: '', similarity }) === null &&
        pickSupersedeTarget({ lines, newEntry: '纠正一下 x' }) === null)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('④ 写入侧：真的落盘成"旧条目标注 + 新条目"（两条通道都验）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const WS = join(ROOT, 'ws1')
    mkdirSync(join(WS, 'memory'), { recursive: true })
    const apply = (text, force = false) =>
      applyMemoryItems({
        workspace: WS,
        kind: 'private',
        peerId: '10001',
        senderId: '10001',
        tier: 'admin',
        items: [{ scope: SCOPE.FACT, text, source: 'marker', force }],
        log: () => {},
      })

    apply('他的 MC 服务器是 Forge 端')
    const viaFix = apply('他的 MC 服务器是 Paper 端', true)
    check('★ 通道一：`fix` 档（force）→ 旧条目被标注',
      Boolean(viaFix.applied[0]?.superseded), JSON.stringify(viaFix.applied[0]?.superseded ?? null))

    apply('他的主机是 B650M')
    apply('他的主机是 B650M 主板')  // 不含更正信号 → 不应标注上一条
    const file = String(readIf(WS, 'memory/people/10001.md') ?? '')
    check('★★ 不带信号 → 不标注（纯陈述式的两条共存）',
      !/B650M.*已被更正/.test(file), file.split('\n').filter((l) => l.includes('B650M')).join('｜'))

    const viaCue = apply('纠正一下，他的主机是 X870E')
    check('★ 通道二：自指式措辞 → 旧条目被标注',
      Boolean(viaCue.applied[0]?.superseded), JSON.stringify(viaCue.applied[0]?.superseded ?? null))

    const file2 = String(readIf(WS, 'memory/people/10001.md') ?? '')
    check('★★ 旧条目**还在**（没被删）', file2.includes('Forge 端'))
    check('★★ 旧条目带上了标注', /Forge 端.*已被更正.*Paper/.test(file2), file2)
    check('★ 新条目也写进去了', file2.includes('Paper 端'))
    check('★ 条目数只增不减（两条 Forge/Paper 都留着）',
      file2.split('\n').filter((l) => l.trim().startsWith('- ')).length === 5,
      String(file2.split('\n').filter((l) => l.trim().startsWith('- ')).length))

    // 标记协议：`fix` 档要能被解析出来并带上 force
    const parsed = parseMemoryMarkers('好\n<<<MEMORY fix 他的 MC 服务器是 Velocity 端>>>')
    check('★ 标记协议认 `fix` 档，并带上 force 标记',
      parsed.items.length === 1 && parsed.items[0].force === true && parsed.items[0].scope === SCOPE.FACT,
      JSON.stringify(parsed.items))
    check('★ 普通 `fact` 档不带 force（不会误触发更正）',
      parseMemoryMarkers('<<<MEMORY fact 他喜欢喝拿铁>>>').items[0].force === false)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑤ 注入侧：被更正的条目**不再作为事实**喂给模型')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const recall = readMemoryForPrompt({ workspace: join(ROOT, 'ws1'), kind: 'private', peerId: '10001' })
    const block = recall.blocks.find((b) => b.rel === 'memory/people/10001.md')
    const text = String(block?.text ?? '')
    check('★ 注入文本里**没有**被推翻的结论（Forge）', !text.includes('Forge 端'), text.slice(0, 140))
    check('★ 但**有**新结论（Paper）', text.includes('Paper 端'))
    check('★★ 而且如实告诉模型"另有 N 条已被更正"（不是悄悄少一条）',
      /另有 \d+ 条已被更正/.test(text), text.slice(-100))
    check('★ 体检里的 entries 是**有效条目**数（不含被更正的）',
      block?.entries === 3, JSON.stringify({ entries: block?.entries, shown: block?.shown }))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑥ 整理侧：被更正的条目**原样保留**、不参与合并、不被删')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const note = '〔已被更正：他的 MC 服务器是 Paper 端 · 2026-09-26〕'
    const raw = ['# 记忆', '', `- 他的 MC 服务器是 Forge 端　${note}`, '- 他喜欢喝冰美式', '- 他喜欢喝冰美式。'].join('\n')
    const r = consolidateEntries(parseEntries(raw).lines)
    const text = renderLines(r.lines)
    check('★★ 被更正的条目**原样保留**（连标注都没被动）', text.includes(note), text)
    check('★★ 它**没有**被当成"重复"删掉', text.includes('Forge 端　〔'), text)
    check('★ 有效条目里的重复**仍照常合并**（这次改动没弄坏整理）',
      r.droppedDuplicates.length === 1, JSON.stringify(r.droppedDuplicates.map((d) => d.text)))
    const once = renderLines(consolidateEntries(parseEntries(raw).lines).lines)
    const twice = renderLines(consolidateEntries(parseEntries(once).lines).lines)
    check('★ 幂等：整理过的再整理一次不变（含标注）', once === twice)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑦ 与快照/篡改检测的配合（同类坑踩过，必须验）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const WS = join(ROOT, 'ws2')
    // ★ 三层布局：个人档在子目录里，直接写文件前必须自己建目录
    //   （正常写入走 `appendEntry`，它会 mkdir；这里绕过了它）
    mkdirSync(join(WS, 'memory', 'people'), { recursive: true })
    writeFileSync(join(WS, 'memory/people/20002.md'), '# 记忆（桥接维护，勿手改）\n\n- 他的服务器是 Forge 端\n', 'utf8')
    applyMemoryItems({
      workspace: WS,
      kind: 'private',
      peerId: '20002',
      senderId: '20002',
      tier: 'admin',
      items: [{ scope: SCOPE.FACT, text: '他的服务器是 Paper 端', source: 'marker', force: true }],
      log: () => {},
    })
    check('★★ 标注之后**不会被篡改检测回滚**（appendEntry 在标注后刷新了快照）',
      verifyAndRestoreMemory({ workspace: WS }).tampered.length === 0,
      JSON.stringify(verifyAndRestoreMemory({ workspace: WS })))

    const file = String(readIf(WS, 'memory/people/20002.md') ?? '')
    check('前提：文件里确实有标注', isSuperseded(file.split('\n')[2] ?? ''), file)
    const r = consolidateFile({ workspace: WS, rel: 'memory/people/20002.md', apply: true, saveSnapshot })
    check('整理照常返回（与快照配合不报错）', r.ok === true, JSON.stringify({ ok: r.ok, why: r.why }))
    check('★★ 整理之后**仍然**不会被回滚', verifyAndRestoreMemory({ workspace: WS }).tampered.length === 0)
    check('★ 标注在整理后仍在文件里', (() => {
      const after = String(readIf(WS, 'memory/people/20002.md') ?? '')
      // ⚠️ 断言要盯**那一行**，不能对整份文件调 isSuperseded ——
      //    它要求标注在**文件末尾**，而文件末尾是那条有效的新条目。
      //    （第一版就是这么写错的，而且详情是多行，被日志筛选一过滤只看到第一行，
      //      看上去像"文件被清空了"，其实只是断言写歪了。）
      const marked = after.split('\n').find((l) => l.includes('已被更正'))
      return Boolean(marked) && isSuperseded(marked)
    })(), String(readIf(WS, 'memory/people/20002.md') ?? '').replace(/\n/g, '⏎'))
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('')
if (failed === 0) {
  console.log(`🎉 记忆更正（supersede）测试全部通过（${passed} 项）`)
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
