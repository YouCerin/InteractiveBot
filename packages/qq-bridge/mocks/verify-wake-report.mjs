/**
 * 唤醒判定报表测试（影子模式的兑现路径）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么这一套必须有（统计口径是最容易悄悄错的东西）
 * ══════════════════════════════════════════════════════════════════════════
 * 分错一栏、算错一个比例，**都不会报错**，只会给出一个看起来合理的数 ——
 * 而人会**照着那个数做决定**（"本会拦掉 20%，看起来还行"→ 开启判定）。
 * 所以这里的重点不是"能不能算"，而是**口径对不对**，几处最要命的：
 *
 *   ① **"本会拦掉"只算 `judged===true` 的 silent**。兜底行（`fallback:true`）的
 *      verdict 是 `answer`（fail-open），把它算进来会**虚增**拦截率；
 *   ② **影子行与生效行必须分开**：影子的 silent 是"本会拦但放过了"，
 *      生效的 silent 是"真拦了"。混在一起这句话就无法解释；
 *   ③ **漏回率的分母只算"已复核"**。把"还没看"混进分母会让漏回率**凭空变小** ——
 *      而这是最危险的一个方向（它会让你误以为判得挺准）；
 *   ④ **算不出的地方要写 `—`，不能写 `0%`**。`0%` 与"没有数据"是两件事。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么这一套能离线跑
 * ══════════════════════════════════════════════════════════════════════════
 * `summarizeWakeOps()` 是**纯函数**（只吃数组、`now` 可注入、不碰盘）；
 * 标注的读写也**可注入** `readFile` / `write`。所以这里一行真盘都不写。
 *
 * 用法：node mocks/verify-wake-report.mjs
 */

import {
  summarizeWakeOps,
  renderWakeReport,
  readWakeLabels,
  writeWakeLabels,
  WAKE_LABELS_REL,
  MISS_RATE_ADVISORY,
  DEFAULT_SAMPLE_LIMIT,
} from '../src/wake-report.mjs'

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

/** 造一行 wake 流水。默认是一条"生效、judged、answer"。 */
function row(over = {}) {
  return {
    ts: 1_790_000_000_000,
    chatKey: 'group:100',
    type: 'wake',
    policy: 'semantic',
    verdict: 'answer',
    shadow: false,
    fallback: false,
    judged: true,
    via: 'json',
    ms: 800,
    reason: '在跟我说话',
    excerpt: '小鲸鱼 在吗',
    ...over,
  }
}
const NOW = 1_790_100_000_000

// ══════════════════════════════════════════════════════════════════════════
section('① 只认 `type:"wake"` 的行（oplog 里混着 tool/call、assistant 等）')
// ══════════════════════════════════════════════════════════════════════════
{
  const s = summarizeWakeOps({
    rows: [row(), row({ ts: 1 }), { type: 'assistant', chars: 5 }, { type: 'tool/call', name: 'read' }, null, {}],
    now: NOW,
  })
  check('★ 非 wake 行被忽略（不会把工具调用算成判定）', s.total === 2, String(s.total))
  check('  空数组 / 脏元素不抛', summarizeWakeOps({ rows: [null, 1, 'x'] }).total === 0)
  check('  rows 缺省也不抛', summarizeWakeOps({}).total === 0)
}

// ══════════════════════════════════════════════════════════════════════════
section('② 口径：本会拦掉 / 兜底放行 / 没判定 —— 三者不许混')
// ══════════════════════════════════════════════════════════════════════════
{
  const s = summarizeWakeOps({
    rows: [
      row(), // 判定过、answer
      row({ ts: 2, verdict: 'silent' }), // 判定过、silent → 算"本会拦掉"
      // ★ 兜底行：judged=false，而 verdict 仍是 answer（fail-open）。
      //   把它算进"本会拦掉"会**虚增**拦截率 —— 它压根没拦。
      row({ ts: 3, judged: false, fallback: true, verdict: 'answer', reason: '判定输出解析不出 JSON 对象' }),
      row({ ts: 4, judged: false, fallback: false, verdict: 'answer', reason: '本小时判定次数已达上限（60）' }),
    ],
    now: NOW,
  })
  check('判定次数 = 4', s.total === 4, String(s.total))
  check('已判定 = 2（兜底与没判定都不算）', s.judged === 2, String(s.judged))
  check('★ 本会拦掉 = 1，**兜底那条没被算进去**', s.silenced === 1, String(s.silenced))
  check('  放行 = 1（已判定里除 silent 之外）', s.answered === 1, String(s.answered))
  check('★ 兜底放行单列 = 1', s.fallback === 1, String(s.fallback))
  check('★ 没判定单列 = 1（"没问成"与"问了没结论"是两回事）', s.notJudged === 1, String(s.notJudged))
  check('  兜底原因被归并出来（看哪一类失败最多）',
    s.fallbackReasons.length === 1 && s.fallbackReasons[0].n === 1 && /解析不出 JSON/.test(s.fallbackReasons[0].why),
    JSON.stringify(s.fallbackReasons))
  check('  比例按**已判定**算（1/2 = 50%），不是按总数（1/4 = 25%）',
    renderWakeReport(s).includes('50.0% 的已判定'), (renderWakeReport(s).match(/本会拦掉.*/) ?? [''])[0])
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 影子行与生效行必须分开（否则"本会怎样"与"已经怎样"分不清）')
// ══════════════════════════════════════════════════════════════════════════
{
  const s = summarizeWakeOps({
    rows: [
      row({ ts: 1, shadow: true, verdict: 'silent' }), // 影子里"本会拦但放过了"
      row({ ts: 2, shadow: true, verdict: 'answer' }),
      row({ ts: 3, shadow: false, verdict: 'silent' }), // 生效时"真拦了"
      row({ ts: 4, shadow: false, verdict: 'answer' }),
    ],
    now: NOW,
  })
  check('影子行 / 生效行分开计数', s.shadowRows === 2 && s.liveRows === 2, `${s.shadowRows}/${s.liveRows}`)
  check('★ 影子里"本会拦但放过" = 1', s.wouldSilence === 1, String(s.wouldSilence))
  check('★ 生效时"真拦了" = 1', s.reallySilenced === 1, String(s.reallySilenced))
  check('  合起来仍是"本会拦掉" = 2（判定器想拦的总数）', s.silenced === 2, String(s.silenced))
  check('  `shadowOn` 标出影子是否开着（决定那句话怎么写）', s.shadowOn === true)
  check('  影子没开时 shadowOn=false', summarizeWakeOps({ rows: [row()], now: NOW }).shadowOn === false)
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 解析来源（via）：唯一能看出"模型有没有照格式写"的地方')
// ══════════════════════════════════════════════════════════════════════════
{
  const s = summarizeWakeOps({
    rows: [
      row({ ts: 1, via: 'json' }),
      row({ ts: 2, via: 'json' }),
      row({ ts: 3, via: 'scan' }),
      row({ ts: 4, via: 'loose' }),
      row({ ts: 5, via: 'phrase' }),
      row({ ts: 6, via: undefined }), // 早期记录没有这个字段
      row({ ts: 7, via: '什么鬼' }), // 认不出的值
    ],
    now: NOW,
  })
  check('via 分栏计数', s.via.json === 2 && s.via.scan === 1 && s.via.loose === 1 && s.via.phrase === 1,
    JSON.stringify(s.via))
  check('★ 缺字段 / 认不出的值进 `unknown`，**不冒充 json**', s.via.unknown === 2, String(s.via.unknown))
  const out = renderWakeReport(s)
  check('★ 报表把 unknown 说成"早期记录还没有这个字段"，而**不是**"模型没照格式写"',
    out.includes('早期记录还没有这个字段'), (out.match(/解析来源.*/) ?? [''])[0])
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 耗时 / token / 按会话')
// ══════════════════════════════════════════════════════════════════════════
{
  const s = summarizeWakeOps({
    rows: [
      row({ ts: 1, ms: 100, tokens: { input: 400, cacheRead: 0, output: 30 }, chatKey: 'group:100' }),
      row({ ts: 2, ms: 200, tokens: { input: 400, cacheRead: 100, output: 40 }, chatKey: 'group:100' }),
      row({ ts: 3, ms: 900, tokens: null, chatKey: 'private:200' }), // 走 DSH 进程：拿不到用量
      row({ ts: 4, ms: 'x', chatKey: 'group:300' }), // 脏 ms
    ],
    now: NOW,
  })
  check('耗时只吃有限数（脏值被丢掉）', s.ms.count === 3, String(s.ms.count))
  check('中位 / 最大', s.ms.median === 200 && s.ms.max === 900, JSON.stringify(s.ms))
  check('token 累加（input/cacheRead/output）',
    s.tokens.input === 800 && s.tokens.cacheRead === 100 && s.tokens.output === 70, JSON.stringify(s.tokens))
  check('★ 带用量的**行数**单独记（报表要据此说"成本偏低"）', s.tokens.rows === 2, String(s.tokens.rows))
  check('按会话计数并按总量排序',
    s.byChat[0].chatKey === 'group:100' && s.byChat[0].total === 2, JSON.stringify(s.byChat))
  check('  每个会话带"本会拦"数', s.byChat.every((c) => typeof c.silenced === 'number'))
  const out = renderWakeReport(s)
  check('★ 有用量不全时报表**明说只有几条有用量**（否则成本会被当成全量）',
    out.includes('2/4 条有用量'), (out.match(/token .*/) ?? [''])[0])
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ 抽样：按 ts 升序（编号必须跨运行稳定）、截断要明说')
// ══════════════════════════════════════════════════════════════════════════
{
  const rows = []
  for (let i = 0; i < 5; i += 1) rows.push(row({ ts: 1000 + (5 - i) * 10, verdict: 'silent', excerpt: `第${i}条` }))
  rows.push(row({ ts: 9999, verdict: 'answer' })) // answer 不进样本
  const s = summarizeWakeOps({ rows, now: NOW, sampleLimit: 3 })
  check('样本只收 silent（answer 不算"本会拦掉"）', s.sampledTotal === 5, String(s.sampledTotal))
  check('★ 样本按 ts **升序**（编号稳定，不会因为新行到来而整体错位）',
    s.samples[0].ts === 1010 && s.samples[1].ts === 1020 && s.samples[2].ts === 1030,
    JSON.stringify(s.samples.map((x) => x.ts)))
  check('  编号从 1 开始', s.samples.map((x) => x.index).join(',') === '1,2,3')
  check('★ 截断要明说还有多少条没列', s.truncated === 2, String(s.truncated))
  check('  报表里写出"还有 2 条没列"', renderWakeReport(s).includes('还有 2 条没列'))
  check('每条样本带 时间/会话/耗时/理由/原文/标注位',
    s.samples.every((x) => x.ts && x.chatKey && typeof x.ms === 'number' && 'reason' in x && 'excerpt' in x && 'label' in x))
  check('默认样本上限是一个具体的数（不是"全都要"）', DEFAULT_SAMPLE_LIMIT > 0 && DEFAULT_SAMPLE_LIMIT <= 100, String(DEFAULT_SAMPLE_LIMIT))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑦ ★★ 漏回率：分母**只算已复核**（混进"没看"会让它凭空变小）')
// ══════════════════════════════════════════════════════════════════════════
{
  const rows = [
    row({ ts: 11, verdict: 'silent' }),
    row({ ts: 12, verdict: 'silent' }),
    row({ ts: 13, verdict: 'silent' }),
    row({ ts: 14, verdict: 'silent' }),
  ]
  const none = summarizeWakeOps({ rows, now: NOW })
  check('★ 一条都没复核时，漏回率是 **null**（显示 `—`，不是 0%）', none.labels.missRate === null)
  check('  报表里写的是 `漏回率 —` 并提醒"没复核 ≠ 没问题"',
    renderWakeReport(none).includes('漏回率 —') && renderWakeReport(none).includes('没复核 ≠ 没问题'))

  const partial = summarizeWakeOps({ rows, labels: { 11: 'miss', 12: 'ok' }, now: NOW })
  check('★★ 只复核 2 条时，漏回率 = 1/2 = 50%（**不是 1/4 = 25%**）',
    partial.labels.missRate === 0.5, String(partial.labels.missRate))
  check('  已复核 / 待复核 分开报', partial.labels.reviewed === 2 && partial.labels.pending === 2,
    JSON.stringify(partial.labels))

  const clean = summarizeWakeOps({ rows, labels: { 11: 'ok', 12: 'ok' }, now: NOW })
  check('全判对 → 漏回率 0%，且不触发"超过建议上限"',
    clean.labels.missRate === 0 && !renderWakeReport(clean).includes('不建议真的开启判定'))
  check('★ 超过建议上限时明说"不建议真的开启"',
    renderWakeReport(partial).includes('不建议真的开启判定'))
  check('  建议上限是个具体数（但它只是建议，报表不替人做决定）',
    MISS_RATE_ADVISORY > 0 && MISS_RATE_ADVISORY < 1, String(MISS_RATE_ADVISORY))
  check('  报表里写明"这是本项目的建议值、不是硬规定"', renderWakeReport(clean).includes('不是硬规定'))
  check('★ 认不出的标注值被忽略（只认 ok / miss）',
    summarizeWakeOps({ rows, labels: { 11: 'maybe' }, now: NOW }).labels.reviewed === 0)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑧ 如实说明：没数据 / TTL 窗口 / 采样 —— 报表自己必须说清它的边界')
// ══════════════════════════════════════════════════════════════════════════
{
  const empty = summarizeWakeOps({ rows: [], now: NOW })
  // ★ 真正要守住的不变式是"**算不出的地方绝不编一个 0**" ——
  //   空数据时那条线干脆不出现（下面那句"没有样本就没法评估漏回率"已经说清了），
  //   但**绝不能**出现 `漏回率 0%` 或 `0.0%`（那会读成"判得很准"）。
  check('★★ 空数据时**不许编出 `漏回率 0%`**', !/漏回率\s*0/.test(renderWakeReport(empty)))
  check('★ 空数据时把"算不出"明说出来（没有样本就没法评估漏回率）',
    renderWakeReport(empty).includes('没有"本会拦掉"的样本') && renderWakeReport(empty).includes('没法评估'),
    (renderWakeReport(empty).match(/抽样人工复核.*/) ?? [''])[0])
  check('★ 其余算不出的值写 `—`（不是 0）', renderWakeReport(empty).includes('token             —'))
  check('★ 空数据时警告说清"这不等于判定器从不沉默"',
    empty.warnings.some((w) => /不等于"判定器从不沉默"/.test(w)),
    empty.warnings[0] ?? '')
  check('  空数据也给出两种可能的原因（policy=rule / 从没被触发）',
    empty.warnings.some((w) => /policy.*rule/.test(w) && /@/.test(w)))

  const old = summarizeWakeOps({ rows: [row({ ts: NOW - 8 * 86_400_000 })], now: NOW })
  check('★ 窗口接近 7 天 TTL 时警告"更早的已经被清掉，别当全量"',
    old.warnings.some((w) => /7 天 TTL/.test(w)), old.warnings.find((w) => /TTL/.test(w)) ?? '')
  const fresh = summarizeWakeOps({ rows: [row({ ts: NOW - 3600_000 })], now: NOW })
  check('  窗口很新时不报那条（不制造无谓的告警）', !fresh.warnings.some((w) => /7 天 TTL/.test(w)))

  const partialTok = summarizeWakeOps({
    rows: [row({ ts: 1, tokens: { input: 1, cacheRead: 0, output: 1 } }), row({ ts: 2, tokens: null })],
    now: NOW,
  })
  check('★ 用量不全时警告"成本偏低"（不会让人把部分当成全部）',
    partialTok.warnings.some((w) => /成本是\*\*按已报出的部分\*\*估的，偏低/.test(w)),
    partialTok.warnings.find((w) => /token/.test(w)) ?? '')
  check('★ 每张报表都说明"**没有采样**"以及日量到多少会顶到 2MB 上限',
    fresh.warnings.some((w) => /没有采样/.test(w) && /2MB/.test(w)))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑨ 标注的读写：可注入 → 离线测，且**绝不抛**')
// ══════════════════════════════════════════════════════════════════════════
{
  const mem = new Map()
  const w = writeWakeLabels({ workspace: '/ws', labels: { 111: 'ok', 222: 'miss' }, write: (abs, body) => mem.set(abs, body) })
  check('写入成功并回执条数', w.ok === true && w.written === 2, JSON.stringify(w))
  check('  落点是 runtime/wake-labels.json（不在 memory/、不在配置里）', w.rel === WAKE_LABELS_REL && WAKE_LABELS_REL.startsWith('runtime/'))
  const abs = `/ws/${WAKE_LABELS_REL}`
  check('  写出来的是**按 ts 索引**的 JSON（这样编号会变、ts 不会）',
    JSON.parse(mem.get(abs))['111'] === 'ok', mem.get(abs))

  const r = readWakeLabels({ workspace: '/ws', readFile: (a) => mem.get(a) ?? null })
  check('读回来一致', r.ok === true && r.labels['222'] === 'miss', JSON.stringify(r))
  check('★ 文件不存在时返回空表（**不是失败**）', readWakeLabels({ workspace: '/x', readFile: () => null }).ok === true)
  check('★ 文件坏了也不抛（返回 ok:false + 原因）',
    readWakeLabels({ workspace: '/x', readFile: () => '{坏' }).ok === false)
  check('★ 非 ok/miss 的值被过滤掉（坏数据不许影响统计）',
    Object.keys(readWakeLabels({ workspace: '/x', readFile: () => '{"1":"ok","2":"呵呵"}' }).labels).join(',') === '1')
  check('★ 数组 / null 也不抛', readWakeLabels({ workspace: '/x', readFile: () => '[]' }).ok === true)
  const badWrite = writeWakeLabels({ workspace: '/ws', labels: {}, write: () => { throw new Error('磁盘满') } })
  check('★ 写失败不抛，如实回 why', badWrite.ok === false && /磁盘满/.test(badWrite.why ?? ''), JSON.stringify(badWrite))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑩ JSON 模式：给界面/脚本用，字段齐全')
// ══════════════════════════════════════════════════════════════════════════
{
  const s = summarizeWakeOps({ rows: [row({ ts: 1, verdict: 'silent' }), row({ ts: 2 })], labels: { 1: 'ok' }, now: NOW })
  const parsed = JSON.parse(renderWakeReport(s, { json: true }))
  for (const k of ['total', 'judged', 'silenced', 'fallback', 'notJudged', 'via', 'ms', 'tokens', 'byChat', 'samples', 'labels', 'warnings', 'shadowOn']) {
    check(`JSON 里有 ${k}`, k in parsed, Object.keys(parsed).join(','))
  }
  check('JSON 里的样本与标注也在（界面可以直接画）', parsed.samples.length === 1 && parsed.labels.ok === 1)
  check('  纯函数不碰盘：两次同样输入结果一致（可重现）',
    JSON.stringify(summarizeWakeOps({ rows: [row()], now: NOW })) === JSON.stringify(summarizeWakeOps({ rows: [row()], now: NOW })))
}

console.log('')
if (failed === 0) {
  console.log(`🎉 唤醒判定报表测试全部通过（${passed} 项）`)
  console.log('   ⚠️ 这一套测的是**统计口径**，不测"报表好不好看"。')
  console.log('      口径错了不会报错，只会给出一个看起来合理的数 —— 而人会照着它做决定。')
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
