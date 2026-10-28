/**
 * 两层记忆测试：**全局 / 个人**（群聊层与黑话层 0.3.3 已下线；情绪支线已按使用者要求删除）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套在盯什么（每一条都对应一个"错了会静默变坏"的地方）
 * ══════════════════════════════════════════════════════════════════════════
 * ① **路径口径只有一处**：非法号码不许拼出路径（拼错了会写到奇怪的地方，
 *    而写入失败通常**不报错**，只表现为"它好像没记住"）；
 * ② ★★ **个人层跟人走**（本需求的核心）：同一个人在**别的群**说话时，
 *    他那份个人档要生效；而**群里其他人看不到它**；
 * ③ **群聊层严格隔离**：A 群的事不进 B 群、也不进任何私聊（防串场）；
 * ④ **情绪倾注的判定边界**：该认的认、**不该认的绝不能认**
 *    （转述别人的情绪、说"那件事崩溃了"都不是他的状态 —— 记错了就是一条
 *    会永久注入的假记忆）；
 * ⑤ **情绪条目的形状**：写成时间状语（什么时候读都成立）、不许写成祈使句
 *    （否则等于用一次情绪表达绕过"行为指令只有管理员能下"的判据）；
 * ⑥ **子目录也要被篡改检测覆盖**：三层布局把文件放进了子目录，
 *    而原来的检测只扫根与 `memory/` 一层 —— 漏了就是"改了不告警、不回滚"；
 * ⑦ **旧布局迁移**：升级**不能失忆**；迁移没跑成时还要有回退读兜底。
 *
 * 用法：node mocks/verify-memory-layers.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyMemoryItems,
  groupMemoryRel,
  groupSlangRel,
  INJECT_ENTRIES_PERSON,
  layoutFor,
  memoryFileTitle,
  memoryLayerOf,
  migrateMemoryLayout,
  personMemoryRel,
  readMemoryForPrompt,
  retireGroupLayers,
  screenEntry,
  SCOPE,
  thirdPartyNegative,
  verifyAndRestoreMemory,
} from '../src/memory-store.mjs'
import {
  MIN_MESSAGES_FOR_LINE,
  notePersonTurn,
  peakHours,
  PEOPLE_MAX,
  readPersonStats,
  renderPersonStatsLine,
  renderPersonHabitsLine,
  __resetPeopleStatsWarnings,
} from '../src/people-stats.mjs'
import { createMemoryStore } from '../src/memory-files.mjs'

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

const ROOT = mkdtempSync(join(tmpdir(), 'qq-bridge-layers-'))
const GROUP_A = '700000001'
const GROUP_B = '700000002'
const X = '100000001' // 在群里发言的人
const Y = '200000001' // 同群的另一个人
const read = (ws, rel) => {
  const p = join(ws, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}
/** 新建一个干净的工作区（每个用例一份，避免互相污染）。 */
let wsSeq = 0
const newWs = () => {
  wsSeq += 1
  const ws = join(ROOT, `ws${wsSeq}`)
  mkdirSync(ws, { recursive: true })
  return ws
}

try {
  // ══════════════════════════════════════════════════════════════════════════
  section('① 路径口径：只有一处，且非法号码不许拼出路径')
  // ══════════════════════════════════════════════════════════════════════════
  check('群聊层 = memory/groups/<群号>.md', groupMemoryRel(GROUP_A) === `memory/groups/${GROUP_A}.md`, String(groupMemoryRel(GROUP_A)))
  check('群内黑话 = memory/groups/<群号>-slang.md', groupSlangRel(GROUP_A) === `memory/groups/${GROUP_A}-slang.md`, String(groupSlangRel(GROUP_A)))
  check('个人层 = memory/people/<QQ>.md', personMemoryRel(X) === `memory/people/${X}.md`, String(personMemoryRel(X)))
  check(
    '★ 非法号码 → null（不猜、不拼路径）',
    groupMemoryRel('abc') === null && personMemoryRel('123') === null && personMemoryRel('') === null && personMemoryRel(null) === null,
    `${groupMemoryRel('abc')} / ${personMemoryRel('123')}`,
  )
  check('层的判据只有一处：memoryLayerOf', 
    memoryLayerOf('MEMORY.md') === 'global' &&
      memoryLayerOf(`memory/people/${X}.md`) === 'person' &&
      memoryLayerOf(`memory/groups/${GROUP_A}.md`) === 'group' &&
      memoryLayerOf('memory/directives.md') === 'directive',
    [memoryLayerOf('MEMORY.md'), memoryLayerOf('memory/people/1.md'), memoryLayerOf('memory/groups/1.md')].join(','))

  {
    const g = layoutFor({ kind: 'group', peerId: GROUP_A, speakerId: X })
    // ★★ 0.3.3：群里的落点只剩**两个**（全局 / 个人）—— `session` 与 `slang` 恒为 null。
    //   使用者原话：「不再对群聊信息进行记忆，群聊中的对话记忆归于个人」。
    check('★★ 群里的落点：`session` / `slang` **都是 null**（群聊层已下线）',
      g.session === null && g.slang === null, JSON.stringify(g))
    check('★★ 群里的 `factTarget` 与 `personTarget` 都是**发言人自己那份**（这就是"归于个人"）',
      g.person === `memory/people/${X}.md` &&
        g.factTarget === `memory/people/${X}.md` &&
        g.personTarget === `memory/people/${X}.md`,
      JSON.stringify(g))
    check('★★ 个人层的落点**不含群号**（这是"跟人走"的前提）',
      !String(g.personTarget).includes(GROUP_A), String(g.personTarget))
    const p = layoutFor({ kind: 'private', peerId: X })
    check('私聊：会话层同样为 null，且 fact 与 person 是**同一份**（不会重复注入）',
      p.session === null && p.slang === null && p.person === `memory/people/${X}.md` && p.factTarget === p.personTarget,
      JSON.stringify(p))
    const noSpeaker = layoutFor({ kind: 'group', peerId: GROUP_A })
    check('★★ 群里拿不到发言人 → 个人落点是 **null**（宁可不写，也不拿群号兜底）',
      noSpeaker.person === null && noSpeaker.factTarget === null && noSpeaker.personTarget === null,
      JSON.stringify(noSpeaker))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('② 0.3.3：群里四种档位**只落两份文件**（全局 + 发言人个人档）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const ws = newWs()
    const r = applyMemoryItems({
      workspace: ws,
      kind: 'group',
      peerId: GROUP_A,
      senderId: X,
      tier: 'user',
      items: [
        { scope: SCOPE.FACT, text: '这个群周末有活动', source: 'marker' },
        // ★ 0.3.3：`SCOPE.SLANG` 已删除（黑话档下线）；这里用 `fact` 代表"旧黑话档被当成事实收下"
        { scope: SCOPE.FACT, text: '滚木 = 什么都没有', source: 'marker' },
        { scope: SCOPE.PERSON, text: '他喜欢喝冰美式', source: 'marker' },
        { scope: SCOPE.GLOBAL, text: '大家都叫我小鲸鱼', source: 'marker' },
      ],
      log: () => {},
    })
    const rels = r.applied.map((a) => a.rel)
    check('★★ 四条只落两份文件：全局 + 发言人个人档（群里不再有群档/黑话档）',
      rels.length === 4 &&
        rels.filter((x) => x === 'MEMORY.md').length === 1 &&
        rels.filter((x) => x === `memory/people/${X}.md`).length === 3,
      rels.join(' , '))
    check('★★ 一个群档都没有被创建（`memory/groups/` 下不存在文件）',
      !existsSync(join(ws, 'memory', 'groups')), String(existsSync(join(ws, 'memory', 'groups'))))
    check('★ 群里写的 person 落在**发言人**名下（不是群号）',
      Boolean(r.applied.find((a) => a.scope === SCOPE.PERSON)?.rel === `memory/people/${X}.md`),
      String(r.applied.find((a) => a.scope === SCOPE.PERSON)?.rel))
    check('★ 内容真的进了对应文件（全部在个人档 + 全局那份，群档一个都没有）',
      String(read(ws, `memory/people/${X}.md`)).includes('冰美式') &&
        String(read(ws, `memory/people/${X}.md`)).includes('周末有活动') &&
        String(read(ws, `memory/people/${X}.md`)).includes('滚木') &&
        String(read(ws, 'MEMORY.md')).includes('小鲸鱼'),
      String(read(ws, `memory/people/${X}.md`)).slice(0, 120))
    check('★ 拿不到发言人号码时**拒绝**写个人档（而不是写错人）',
      applyMemoryItems({
        workspace: ws,
        kind: 'group',
        peerId: GROUP_A,
        senderId: '',
        tier: 'user',
        items: [{ scope: SCOPE.PERSON, text: '他喜欢喝冰美式' }],
        log: () => {},
      }).ignored.some((i) => /发言人/.test(i.why)),
      '')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('③ ★★ 个人层跟人走：私聊有效、别的群也有效、别人看不到')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const ws = newWs()
    // 在 A 群里，X 说了一件"关于他自己"的事 → 落个人层
    applyMemoryItems({
      workspace: ws,
      kind: 'group',
      peerId: GROUP_A,
      senderId: X,
      tier: 'user',
      items: [{ scope: SCOPE.PERSON, text: '他喜欢喝冰美式', source: 'marker' }],
      log: () => {},
    })
    const mine = readMemoryForPrompt({ workspace: ws, kind: 'private', peerId: X })
    check('★★ 他在**私聊**里读得到那条（这就是"对个人的记忆在私聊也有效"）',
      mine.text.includes('冰美式'), mine.text.slice(0, 80))
    check('  私聊注入了个人层那一档',
      mine.blocks.some((b) => b.rel === `memory/people/${X}.md`), mine.files.join(','))

    const elsewhere = readMemoryForPrompt({ workspace: ws, kind: 'group', peerId: GROUP_B, speakerId: X })
    check('★★ 他在**另一个群**发言时也读得到（跟人走）',
      elsewhere.text.includes('冰美式'), elsewhere.text.slice(0, 80))

    const other = readMemoryForPrompt({ workspace: ws, kind: 'group', peerId: GROUP_A, speakerId: Y })
    check('★★ 同群的**另一个人看不到**它（个人层只给发言人自己）',
      !other.text.includes('冰美式'), other.files.join(','))

    const stranger = readMemoryForPrompt({ workspace: ws, kind: 'private', peerId: Y })
    check('★★ 别人的私聊里也看不到', !stranger.text.includes('冰美式'), stranger.files.join(','))

    const noSpeaker = readMemoryForPrompt({ workspace: ws, kind: 'group', peerId: GROUP_A })
    check('群里没给发言人时**不注入任何个人档**（不猜是谁在说话）',
      !noSpeaker.text.includes('冰美式'), noSpeaker.files.join(','))

    // ★★ 个人层的注入上限比通用的 25 紧得多（8）：它**每轮按人**注入，且会一直长。
    //    超出的照旧如实报"另有 N 条未展开" —— 是**不展开**，不是删除。
    {
      const wsCap = newWs()
      for (let i = 0; i < INJECT_ENTRIES_PERSON + 3; i += 1) {
        applyMemoryItems({
          workspace: wsCap,
          kind: 'private',
          peerId: X,
          senderId: X,
          tier: 'user',
          items: [{ scope: SCOPE.PERSON, text: `关于他的第 ${i} 条事实`, source: 'marker' }],
          log: () => {},
        })
      }
      const got = readMemoryForPrompt({ workspace: wsCap, kind: 'private', peerId: X })
      const block = got.blocks.find((b) => b.label.includes('关于正在跟你说话的这个人'))
      check(`★★ 个人层只展开 ${INJECT_ENTRIES_PERSON} 条，超出的**如实报**出来（不是删掉）`,
        block?.shown === INJECT_ENTRIES_PERSON && block?.more === 3 && String(block?.text).includes('另有 3 条未展开'),
        JSON.stringify({ shown: block?.shown, total: block?.entries, more: block?.more }))
      check('  文件里仍然是全部 11 条（注入上限 ≠ 删除）',
        String(read(wsCap, `memory/people/${X}.md`)).split('\n').filter((l) => l.startsWith('- ')).length === INJECT_ENTRIES_PERSON + 3,
        '')
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('④ ★★ 0.3.3：群里写的事**跟人走**（不再有"群聊层隔离"这回事）')
  // ══════════════════════════════════════════════════════════════════════════
  //
  // ⚠️ 这一节原来断言的是**相反**的东西（"A 群的事不进 B 群、也不进任何私聊"）。
  //   群聊层下线之后那个场景不存在了，所以判据必须换成新语义 ——
  //   而且要**明确写成反向**，否则下一个人会以为"隔离"这条纪律还在。
  {
    const ws = newWs()
    applyMemoryItems({
      workspace: ws,
      kind: 'group',
      peerId: GROUP_A,
      senderId: X,
      tier: 'user',
      items: [{ scope: SCOPE.FACT, text: '本群周六开黑', source: 'marker' }],
      log: () => {},
    })
    const inB = readMemoryForPrompt({ workspace: ws, kind: 'group', peerId: GROUP_B, speakerId: X })
    const inPrivate = readMemoryForPrompt({ workspace: ws, kind: 'private', peerId: X })
    const otherMan = readMemoryForPrompt({ workspace: ws, kind: 'private', peerId: Y })
    check('★★ 他在**别的群**说话时读得到（归类到个人之后就会跟人走 —— 这是设计意图，不是串场漏了）',
      inB.text.includes('周六开黑'), inB.files.join(','))
    check('★★ 他在**私聊**里也读得到', inPrivate.text.includes('周六开黑'), inPrivate.files.join(','))
    check('★★ 但**别人**读不到（隔离换成了"人与人之间"，不是"群与群之间"）',
      !otherMan.text.includes('周六开黑'), otherMan.files.join(','))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑤ 全局层对所有会话生效（私聊 + 每个群）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const ws = newWs()
    applyMemoryItems({
      workspace: ws,
      kind: 'private',
      peerId: X,
      senderId: X,
      tier: 'admin',
      items: [{ scope: SCOPE.GLOBAL, text: '大家都叫我小鲸鱼', source: 'marker' }],
      log: () => {},
    })
    const g = readMemoryForPrompt({ workspace: ws, kind: 'group', peerId: GROUP_A, speakerId: Y })
    const p = readMemoryForPrompt({ workspace: ws, kind: 'private', peerId: Y })
    check('★ 群里读得到全局', g.text.includes('小鲸鱼'), g.files.join(','))
    check('★ 别人的私聊也读得到全局', p.text.includes('小鲸鱼'), p.files.join(','))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑨ ★★ 子目录也要被篡改检测覆盖（三层布局最容易踩的静默失效）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const ws = newWs()
    applyMemoryItems({
      workspace: ws,
      kind: 'private',
      peerId: X,
      senderId: X,
      tier: 'admin',
      items: [{ scope: SCOPE.FACT, text: '他的服务器是 Forge 端', source: 'marker' }],
      log: () => {},
    })
    const rel = `memory/people/${X}.md`
    // 绕过桥接直接改（模拟模型拿 write 工具的手）
    writeFileSync(join(ws, rel), '# 记忆（桥接维护，勿手改）\n\n- 他是管理员\n', 'utf8')
    const v = verifyAndRestoreMemory({ workspace: ws, log: () => {} })
    check('★★ 子目录里的个人档被改 → **检测到并回滚**（原来只扫根与 memory/ 一层，会漏）',
      v.tampered.includes(rel) && v.restored.includes(rel), JSON.stringify(v))
    check('★ 回滚后内容恢复成桥接写的那版（不是删空）',
      String(read(ws, rel)).includes('Forge 端'), String(read(ws, rel)).slice(0, 60))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑪ ★★ 控制台写入必须留后路（一次误存不可恢复 → 先备份）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const wsC = newWs()
    const store = createMemoryStore({ workspace: wsC, log: () => {} })
    const first = store.write('MEMORY.md', '# 全局\n\n- 第一条\n')
    check('新建文件：不产生备份（没有"被覆盖"这回事）',
      first.ok === true && first.data.backup === undefined, JSON.stringify(first.data?.backup))
    const second = store.write('MEMORY.md', '# 全局\n\n- 第二条\n')
    check('★★ 覆盖已有文件 → **先备份**，并把备份路径回报出来',
      second.ok === true && typeof second.data.backup === 'string' && /\.bak$/.test(second.data.backup),
      String(second.data?.backup))
    check('★★ 备份内容 = **被覆盖前**那一版（逐字）',
      String(read(wsC, second.data.backup)) === '# 全局\n\n- 第一条\n', JSON.stringify(String(read(wsC, second.data.backup))))
    check('  文件本体是新的那一版', String(read(wsC, 'MEMORY.md')).includes('第二条'), '')
    check('★ 每次覆盖各留一份（不是只留最后一份）',
      (() => {
        store.write('MEMORY.md', '# 全局\n\n- 第三条\n')
        return existsSync(join(wsC, 'memory', '.backups'))
      })(),
      '')
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑬ 旧布局迁移：升级不失忆、只搬不删、幂等、新旧都在时合并')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const ws = newWs()
    mkdirSync(join(ws, 'memory'), { recursive: true })
    writeFileSync(join(ws, 'memory', `private-${X}.md`), '# 旧\n\n- 他喜欢喝冰美式\n', 'utf8')
    writeFileSync(join(ws, 'memory', `group-${GROUP_A}.md`), '# 旧\n\n- 本群周六开黑\n', 'utf8')
    writeFileSync(join(ws, 'memory', `group-${GROUP_A}-slang.md`), '# 旧\n\n- 滚木 = 什么都没有\n', 'utf8')

    const r1 = migrateMemoryLayout({ workspace: ws, log: () => {} })
    check('三份旧文件都迁到了三层布局',
      r1.moved.length === 3 &&
        String(read(ws, `memory/people/${X}.md`)).includes('冰美式') &&
        String(read(ws, `memory/groups/${GROUP_A}.md`)).includes('周六开黑') &&
        String(read(ws, `memory/groups/${GROUP_A}-slang.md`)).includes('滚木'),
      JSON.stringify(r1))
    check('★ 原件**归档**而不是删掉（留后路）',
      existsSync(join(ws, 'memory', '.migrated', `private-${X}.md`)) &&
        existsSync(join(ws, 'memory', '.migrated', `group-${GROUP_A}.md`)),
      '')
    check('★★ 旧快照**一起清掉**（否则 `.snapshots/` 里躺着指向不存在文件的孤儿，排查时会误导）',
      !existsSync(join(ws, 'memory', '.snapshots', `memory__private-${X}.md`)) &&
        !existsSync(join(ws, 'memory', '.snapshots', `memory__group-${GROUP_A}.md`)) &&
        existsSync(join(ws, 'memory', '.snapshots', `memory__people__${X}.md`)),
      '')
    check('★★ 旧个人档迁移后**立刻读得到**（不是"文件在但注入不到"）',
      readMemoryForPrompt({ workspace: ws, kind: 'private', peerId: X }).text.includes('冰美式'),
      '')
    // ★★ 0.3.3：群档迁移完**紧接着会被归档**（`retireGroupLayers`，桥接启动时两步连着跑）。
    //   这里把两步的顺序与结果一起钉住 —— 顺序反了会留下一批"刚搬过去又该归档"的文件。
    check('★★ 群聊层的事**不再进上下文**（即使文件还在 groups/ 里）',
      !readMemoryForPrompt({ workspace: ws, kind: 'group', peerId: GROUP_A, speakerId: X }).text.includes('周六开黑'),
      '')
    const g = retireGroupLayers({ workspace: ws, log: () => {} })
    check('★★★ 归档：旧群档（含黑话档）进 memory/.migrated/groups/，个人档**一份都不动**',
      g.archived.length === 2 &&
        g.kept.length === 0 &&
        existsSync(join(ws, 'memory', '.migrated', 'groups', `${GROUP_A}.md`)) &&
        existsSync(join(ws, 'memory', '.migrated', 'groups', `${GROUP_A}-slang.md`)) &&
        !existsSync(join(ws, 'memory', 'groups', `${GROUP_A}.md`)) &&
        String(read(ws, `memory/people/${X}.md`)).includes('冰美式'),
      JSON.stringify(g))
    check('★★ 归档**不丢内容**（原件逐字进归档目录）',
      String(readFileSync(join(ws, 'memory', '.migrated', 'groups', `${GROUP_A}.md`), 'utf8')).includes('本群周六开黑'))
    check('★ 归档是**幂等**的（再跑一次什么都不做）', (() => {
      const g2 = retireGroupLayers({ workspace: ws, log: () => {} })
      return g2.archived.length === 0 && g2.kept.length === 0
    })())
    const r2 = migrateMemoryLayout({ workspace: ws, log: () => {} })
    check('★ 迁移也**幂等**：再跑一次什么都不做', r2.moved.length === 0 && r2.merged.length === 0, JSON.stringify(r2))

    // 新旧都在 → 合并去重，一条不丢
    const ws2 = newWs()
    mkdirSync(join(ws2, 'memory', 'people'), { recursive: true })
    writeFileSync(join(ws2, 'memory', 'people', `${X}.md`), '# 新\n\n- 他喜欢喝冰美式\n', 'utf8')
    writeFileSync(join(ws2, 'memory', `private-${X}.md`), '# 旧\n\n- 他喜欢喝冰美式\n- 他讨厌被叫老板\n', 'utf8')
    const r3 = migrateMemoryLayout({ workspace: ws2, log: () => {} })
    const mergedText = String(read(ws2, `memory/people/${X}.md`))
    check('★★ 新旧都在 → 合并，**只补新的那条**、不重复',
      r3.merged.length === 1 && mergedText.includes('讨厌被叫老板') &&
        mergedText.split('冰美式').length - 1 === 1,
      JSON.stringify(r3.merged))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑭ 迁移没跑成时的**回退读**（兜底：宁可读到旧路径，也不能失忆）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const ws = newWs()
    mkdirSync(join(ws, 'memory'), { recursive: true })
    writeFileSync(join(ws, 'memory', `private-${X}.md`), '# 旧\n\n- 他喜欢喝冰美式\n', 'utf8')
    const got = readMemoryForPrompt({ workspace: ws, kind: 'private', peerId: X })
    check('★★ 只有旧文件、没迁移 → 仍然注入得到（不会"升级即失忆"）',
      got.text.includes('冰美式'), got.text.slice(0, 60))
    check('★ 而且**如实标出**这是旧布局（体检里一眼看得出该去修迁移）',
      got.files.some((f) => f === `memory/private-${X}.md`) &&
        got.blocks.some((b) => String(b.label).includes('旧布局')),
      got.files.join(',') + ' ｜ ' + (got.blocks.map((b) => b.label).join(' / ')))
  }
  // ══════════════════════════════════════════════════════════════════════════
  section('⑮ ★ D27：对**不在场第三方**的负面定性默认不记（用户决定）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    // 该过的必须过 —— 尤其"关于他本人"的条目**一条都不能误杀**
    for (const [t, why] of [
      ['他情绪低落的时候想有人听着（细节他没说）', '情绪通道写下的条目（关于本人）'],
      ['他喜欢喝冰美式', '普通事实'],
      ['据他说，他领导要求周末加班', '提到第三方但是**事实**，不是定性'],
      ['他同事人都很好', '正面/中性评价不受限（D27 只管负面）'],
      ['我朋友帮了我，那天我真蠢', '两个词都在句子里，但中间有逗号 ⇒ 说的是他自己'],
      ['他的服务器是 Forge 端', '技术事实'],
    ]) {
      check(`该记：${t}（${why}）`, screenEntry(SCOPE.PERSON, t).ok, JSON.stringify(screenEntry(SCOPE.PERSON, t)))
    }
    // 该拒的必须拒
    for (const t of ['我朋友就是个小丑', '他前女友是个绿茶', '他朋友人品差', '某人特别虚伪', '别人都说他傻']) {
      const r = screenEntry(SCOPE.PERSON, t)
      check(`不记：${t}`, r.ok === false && /不在场/.test(String(r.why)), String(r.why))
    }
    check('★ 判据是两段式（第三方指称 + 负面定性，且**同一分句**）',
      thirdPartyNegative('我朋友就是个小丑').hit === true &&
        thirdPartyNegative('我朋友帮了我，那天我真蠢').hit === false,
      JSON.stringify([thirdPartyNegative('我朋友就是个小丑'), thirdPartyNegative('我朋友帮了我，那天我真蠢')]))

    /* ══════════════════════════════════════════════════════════════════════
     * ★★ 群聊记忆的"文件头"纯函数（0.3.3：**群聊层已下线**，这里只剩纯函数判据）
     * ══════════════════════════════════════════════════════════════════════
     * 原来这一节盯两件事：① 新建群档时头里带群名；② 注入标签里带群名。
     * 两件事都**随群聊层一起下线了**（没有群档可写、也没有"本群记忆"那一段可注入），
     * 所以那些断言**必须删掉**，换成"纯函数仍然认得群档形状"——
     * 唯一还需要它的地方是**归档**与将来可能的一次性修复脚本。
     * ⚠️ 把它们留成"已下线"的说明而不是直接删掉整节：`memoryFileTitle` 仍在，
     *   而它的判据（带群名 / 不编名字 / 黑话那份认得出）是**真实行为**，值得继续钉住。
     */
    // 标题渲染本身（纯函数：三种形状）
    check('★ 有群名 → 带群名 + 群号', memoryFileTitle({ rel: `memory/groups/${GROUP_A}.md`, chatName: '摸鱼群' }) === `# 记忆·摸鱼群（群 ${GROUP_A}）（桥接维护，勿手改）`)
    check('★ 没群名 → 只写号码（不编）', memoryFileTitle({ rel: `memory/groups/${GROUP_A}.md` }) === `# 记忆·群 ${GROUP_A}（桥接维护，勿手改）`)
    check('★ 黑话那份也认（带「群内黑话」）—— 认得出是为了**归档时看得懂**，不是因为还在用',
      memoryFileTitle({ rel: `memory/groups/${GROUP_A}-slang.md`, chatName: '摸鱼群' }).includes('群内黑话'))
    check('★ 非群聊文件用原来的通用头（不受影响）',
      memoryFileTitle({ rel: 'MEMORY.md', chatName: '摸鱼群' }) === '# 记忆（桥接维护，勿手改）')
    // ★★ 0.3.3 的反向断言：**写记忆时再也不产生群档**
    const wsN = newWs()
    applyMemoryItems({
      workspace: wsN,
      kind: 'group',
      peerId: GROUP_A,
      senderId: X,
      tier: 'user',
      chatName: '摸鱼群',
      items: [{ scope: SCOPE.FACT, text: '这是一个游戏群', source: 'marker' }],
      log: () => {},
    })
    check('★★★ 群里写记忆**不再生成群档**（`memory/groups/` 一个文件都没有）',
      !existsSync(join(wsN, 'memory', 'groups')), String(existsSync(join(wsN, 'memory', 'groups'))))
    check('★★ 写进了个人档；**群名不进个人档**（只用于群档的文件头，而群档不再产生）',
      String(read(wsN, `memory/people/${X}.md`)).includes('这是一个游戏群') &&
        !String(read(wsN, `memory/people/${X}.md`)).includes('摸鱼群'),
      String(read(wsN, `memory/people/${X}.md`)).slice(0, 100))
    // 注入侧：**没有**"本群记忆"这一段了（含旧的两个标签形状）
    const withName = readMemoryForPrompt({ workspace: wsN, kind: 'group', peerId: GROUP_A, speakerId: X, chatName: '摸鱼群' })
    check('★★★ 注入里不再有「本群记忆」/「群内黑话」两段（传了群名也没有）',
      !withName.text.includes('本群记忆') && !withName.text.includes('群内黑话'),
      JSON.stringify(withName.blocks.map((b) => b.label)))
    check('★ 群名**只用于文件头**，不再影响注入标签（个人档那一行的标签与私聊一致）',
      readMemoryForPrompt({ workspace: wsN, kind: 'private', peerId: X }).blocks.some((b) =>
        String(b.label).includes('关于正在跟你说话的这个人')),
      JSON.stringify(readMemoryForPrompt({ workspace: wsN, kind: 'private', peerId: X }).blocks.map((b) => b.label)))

    // 端到端：走**同一条写入路径**，被拒要有原因、且磁盘上确实没有
    const ws = newWs()
    const r = applyMemoryItems({
      workspace: ws,
      kind: 'group',
      peerId: GROUP_A,
      senderId: X,
      tier: 'user',
      items: [{ scope: SCOPE.PERSON, text: '我朋友就是个小丑', source: 'marker' }],
      log: () => {},
    })
    check('★★ 走 applyMemoryItems 也被拒（不是只有单测里拒）',
      r.applied.length === 0 && r.ignored.length === 1, JSON.stringify(r.ignored))
    check('★ 磁盘上确实没有这条（"报了但写了"是最坏的一种）',
      !String(read(ws, `memory/people/${X}.md`) ?? '').includes('小丑'), String(read(ws, `memory/people/${X}.md`) ?? '（没有文件）'))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑯ ★ 个人层的行为统计与习惯（0.2.9 决定：纳入）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const ws = newWs()
    __resetPeopleStatsWarnings()
    const chatKey = `group:${GROUP_A}`
    const t0 = Date.parse('2026-09-30T20:10:00')
    // 累计 6 次（同一天、同一时段）——刚好越过"少于 5 次不渲染"的门槛
    for (let i = 0; i < 6; i += 1) {
      notePersonTurn({ workspace: ws, userId: X, chatKey, at: t0 + i * 60_000, log: () => {} })
    }
    const rec = readPersonStats({ workspace: ws, userId: X })
    check('计数是**确定性累加**的（与模型无关）',
      rec?.messages === 6 && rec?.hours?.[20] === 6, JSON.stringify({ m: rec?.messages, h20: rec?.hours?.[20] }))
    check('首末时间与"来过几天"都记下来了', rec.firstSeenAt === t0 && rec.lastSeenAt === t0 + 5 * 60_000 && rec.days === 1,
      JSON.stringify({ first: rec.firstSeenAt, last: rec.lastSeenAt, days: rec.days }))
    check('★ 分会话明细也留着（聚合口径是整份记录，明细给人看/排查）',
      rec.chats?.[chatKey] === 6, JSON.stringify(rec.chats))
    check('★★ 统计**跨会话按人聚合**：换个群说话，私聊里读到的还是同一份',
      (() => {
        notePersonTurn({ workspace: ws, userId: X, chatKey: `private:${X}`, at: t0 + 6 * 60_000, log: () => {} })
        const agg = readPersonStats({ workspace: ws, userId: X })
        return agg.messages === 7 && agg.chats?.[`private:${X}`] === 1
      })(), JSON.stringify(readPersonStats({ workspace: ws, userId: X }).chats))

    // 换一天再来说一次 → 天数 +1
    notePersonTurn({ workspace: ws, userId: X, chatKey, at: Date.parse('2026-10-02T21:00:00'), log: () => {} })
    const rec2 = readPersonStats({ workspace: ws, userId: X })
    check('★ 隔天再来 → "来过 N 天" +1（同一天多次只算一天）', rec2.days === 2 && rec2.messages === 8,
      JSON.stringify({ days: rec2.days, m: rec2.messages }))

    // 渲染：数据不足**不装熟**
    check('★ 少于 5 次 → 一个字都不渲染（数据不足就别装熟）',
      renderPersonStatsLine({ messages: 4, lastSeenAt: t0, hours: new Array(24).fill(1), days: 1 }) === '', '')
    const line = renderPersonStatsLine(rec, { now: t0 + 5 * 60_000 + 3 * 3600_000 })
    check('★ ≥5 次 → 说人话那一行（含次数、最近、时段）',
      line.includes('次话') && line.includes('最近 3 小时前') && line.includes('常在 20-21 点出现'), line)
    check('★ 没到"常来"的门槛就**不吹**（如实报次数）',
      !line.includes('他常来'), line)
    const frequent = renderPersonStatsLine({ ...rec, messages: 400 }, { now: t0 })
    check('★ 到量才说"他常来"', frequent.startsWith('他常来'), frequent)
    check('★ 门槛常量与渲染一致（不是两处各写一个数）',
      renderPersonStatsLine({ messages: MIN_MESSAGES_FOR_LINE - 1, lastSeenAt: t0, hours: [], days: 1 }) === '',
      String(MIN_MESSAGES_FOR_LINE))

    // 峰值时段：接不上邻居就不编时段
    check('★ 峰值不明显（都很低）→ 不提时段', peakHours(new Array(24).fill(1)) === null, String(peakHours(new Array(24).fill(1))))
    const cross = peakHours([3, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 5])
    check('★ 跨 0 点的峰值窗口算得出来（23 点峰值 + 0 点邻居够近）',
      JSON.stringify(cross) === JSON.stringify([23, 1]), JSON.stringify(cross))
    check('★ 跨 0 点的渲染说人话（不写成"23-1 点"这种看不懂的东西）',
      renderPersonStatsLine({ messages: 9, lastSeenAt: t0, hours: [3, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 5], days: 1 }, { now: t0 })
        .includes('23 点到次日 1 点'),
      renderPersonStatsLine({ messages: 9, lastSeenAt: t0, hours: [3, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 5], days: 1 }, { now: t0 }))

    // 注入：统计那一行要真的出现在提示词里 —— 而且**没有条目时也要出现**
    const before = readMemoryForPrompt({ workspace: ws, kind: 'private', peerId: X })
    check('★★ 个人层**还没有任何条目**时，也照样把"他常来"注入进去（否则常来的人等于不存在）',
      before.text.includes('他常来') || before.text.includes('次话'), before.text.slice(0, 120))
    check('  这一段的层标签是个人层', before.blocks.some((b) => b.label.includes('关于正在跟你说话的这个人') && b.stats),
      JSON.stringify(before.blocks.map((b) => ({ l: b.label, s: b.stats }))))
    check('★★ 统计跟人走：他在别处跟机器人说过话，这个群里也认得出（同一个人、同一份统计）',
      readMemoryForPrompt({ workspace: ws, kind: 'group', peerId: GROUP_B, speakerId: X }).text.includes('次话'),
      readMemoryForPrompt({ workspace: ws, kind: 'group', peerId: GROUP_B, speakerId: X }).text.slice(0, 100))
    check('★ 别人的会话拿不到这份统计（只给本人那一份）',
      !readMemoryForPrompt({ workspace: ws, kind: 'private', peerId: Y }).text.includes('次话'),
      readMemoryForPrompt({ workspace: ws, kind: 'private', peerId: Y }).text.slice(0, 80))

    /* ── ★★ 稳定行为特征那一行（2026-10-01 用户要求「增加统计层」）──────────
     *
     * 用户点名要的是「稳定的行为特征」：活跃时段、发言风格、习惯动作、技术栈。
     * 这一层**只写算得出来的**（计数器），所以这里逐条钉住"什么情况写、什么情况不写"。
     */
    const hb = (o) => renderPersonHabitsLine({ messages: 20, days: 4, chats: { 'group:1': 20 }, ...o })

    check('★ 只在被叫到时才出现（mentioned 占绝大多数）',
      hb({ mentioned: 20 }).includes('基本只在被叫到时才出现'), hb({ mentioned: 20 }))
    check('★ 会主动找机器人说话', hb({ mentioned: 1 }).includes('会主动来找我说话'), hb({ mentioned: 1 }))
    check('★ 一半一半时**一个字都不写**（不下模棱两可的结论）',
      !hb({ mentioned: 10 }).includes('主动') && !hb({ mentioned: 10 }).includes('被叫到'), hb({ mentioned: 10 }))
    check('★★ **没有 mentioned 数据时不许说"会主动"**（把"没有数据"说成"有数据"）',
      !hb({}).includes('主动'), `实际：${hb({})}`)
    check('★★ 真机那条老记录（33 条、无 mentioned/chars）不许编出发言风格',
      !renderPersonHabitsLine({ messages: 33, days: 2, chats: { 'group:700000001': 33 } }).includes('主动'))
    check('★ 话很短（按平均字符数，只给量级）', hb({ mentioned: 20, chars: 160 }).includes('话很短'))
    check('★ 话偏长', hb({ mentioned: 20, chars: 1200 }).includes('说话偏长'))
    check('★ 会话明显集中时才提"基本只在群里出现"',
      hb({ mentioned: 1, chats: { 'group:1': 18, 'private:1': 2 } }).includes('基本只在群里出现'))
    check('★ 会话不集中时**不写**（否则这行变成"他在哪几个群活动"的情报）',
      !hb({ mentioned: 1, chats: { 'private:1': 10, 'group:1': 10 } }).includes('基本只在'))
    check('  （对照）会话集中时才写那一条',
      hb({ mentioned: 1, chats: { 'private:1': 18, 'group:1': 2 } }).includes('基本只在私聊里出现'))
    check('★★ 那一行**不含任何号码/群号**（隐私边界）',
      !/group:|private:|\d{6,}/.test(hb({ mentioned: 20, chars: 160 })),
      hb({ mentioned: 20, chars: 160 }))
    check('★ 只来过一天不算"习惯"', !hb({ mentioned: 20, days: 1 }).includes('稳定出现'))
    check('★ 稳定出现几天要写出来', hb({ mentioned: 20, days: 4 }).includes('稳定出现了 4 天'))
    check('★ 样本不足（少于注入门槛）→ 一行都不写', renderPersonHabitsLine({ messages: 2, mentioned: 2 }) === '')
    check('★ 零消息 / null 不崩', renderPersonHabitsLine({ messages: 0 }) === '' && renderPersonHabitsLine(null) === '')

    // 坏文件：按空处理但**留证据**（不许静默）
    const ws2 = newWs()
    mkdirSync(join(ws2, 'memory'), { recursive: true })
    writeFileSync(join(ws2, 'memory', '.people.json'), '{ 这不是 JSON', 'utf8')
    const logs = []
    const bad = readPersonStats({ workspace: ws2, userId: X, log: (m) => logs.push(String(m)) })
    check('★★ 侧车坏掉 → 按空处理，但**留一行日志**（否则"它怎么不认得我了"无从查起）',
      bad === null && logs.some((l) => l.includes('people-stats')), logs.join('｜') || '（没有日志）')

    // 人数上限：到顶后新面孔不计入，且**只喊一次**
    const ws3 = newWs()
    __resetPeopleStatsWarnings()
    const capLogs = []
    for (let i = 0; i < PEOPLE_MAX; i += 1) {
      notePersonTurn({ workspace: ws3, userId: String(100000000 + i), at: t0, log: (m) => capLogs.push(String(m)) })
    }
    const over = notePersonTurn({ workspace: ws3, userId: '999999999', at: t0, log: (m) => capLogs.push(String(m)) })
    check('★ 到人数上限 → 新面孔不再计入，且**不是静默**（喊一次，指明哪里腾位置）',
      over.ok === false && capLogs.filter((l) => l.includes('人数上限')).length === 1,
      JSON.stringify({ ok: over.ok, warns: capLogs.length }))
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('')
if (failed === 0) {
  console.log(`🎉 两层记忆（全局 / 个人）测试全部通过（${passed} 项）`)
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
