/**
 * 本地语料库 + 中文全文检索测试（H7）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套盯的四件事（每一条都对应一个"会静默坏掉"的点）
 * ══════════════════════════════════════════════════════════════════════════
 * ① **中文要真能搜到**：`trigram` 对 3 个字以上有效、**对 1~2 个字无效**
 *    （实测 `MATCH '茶姬'` 返回 0 条）—— 所以短查询必须走 LIKE 回退，
 *    而"回退到底有没有生效"只有测试能盯（用户看到的是"搜不到"）。
 * ② **幂等**：同一条消息被喂两次（协议端重发、重连补拉）只能有一行。
 * ③ **隐私不落库**：含手机号的消息**不能进磁盘**，而且审计里**不能有原文**
 *    （存过一次就已经在磁盘上了 —— 这是"写之前拦"与"写完再删"的区别）。
 * ④ **TTL 清理默认只预演**：一次误删的代价远大于多打一个参数。
 *
 * 用法：node mocks/verify-corpus.mjs
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createCorpus,
  renderSearchResults,
  countCjk,
  CORPUS_REL,
  CORPUS_TTL_DAYS,
  CORPUS_LIMITS,
  SEARCH_MODE,
} from '../src/corpus.mjs'

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

const ROOT = mkdtempSync(join(tmpdir(), 'qq-bridge-corpus-'))
const WS = join(ROOT, 'ws')
const readIf = (rel) => {
  const p = join(WS, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

try {
  const corpus = createCorpus({ workspace: WS, log: () => {} })
  const rec = (o) => corpus.record({ kind: 'private', peerId: '10001', ...o })

  // ══════════════════════════════════════════════════════════════════════════
  section('① 中文检索：3 字走 FTS、2 字走 LIKE 回退（实测出来的边界）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    check('countCjk 只数汉字、不数英文（霸王茶姬 + 掉了 = 6）',
      countCjk('霸王茶姬 ToDesk 掉了') === 6, String(countCjk('霸王茶姬 ToDesk 掉了')))
    check('库能打开（ready）', corpus.ready() === true)

    rec({ messageId: 'm1', userId: '10001', senderName: '无忘远霞', text: '霸王茶姬出了个新品叫桂馥兰香' })
    rec({ messageId: 'm2', userId: '10001', text: 'ToDesk 掉线大概是被挤下线了' })
    rec({ kind: 'group', peerId: '700000001', messageId: 'm3', userId: '20002', text: '群里在聊服务器迁移的事' })
    rec({ messageId: 'm4', isBot: true, text: '我查了一下，Paper 端比 Forge 端省内存' })

    const three = corpus.search({ query: '霸王茶' })
    check('★★ 三个汉字 → FTS 搜到（trigram 生效）',
      three.ok && three.mode === SEARCH_MODE.FTS && three.rows.length === 1,
      JSON.stringify({ mode: three.mode, n: three.rows.length }))

    const two = corpus.search({ query: '茶姬' })
    check('★★ 两个汉字 → **LIKE 回退**也能搜到（trigram 对这种长度无效）',
      two.ok && two.mode === SEARCH_MODE.LIKE && two.rows.length === 1,
      JSON.stringify({ mode: two.mode, n: two.rows.length }))

    const en = corpus.search({ query: 'ToDesk' })
    check('英文 → FTS', en.ok && en.rows.length === 1 && en.rows.some((r) => r.messageId === 'm2'),
      JSON.stringify({ mode: en.mode, ids: en.rows.map((r) => r.messageId) }))

    const mixed = corpus.search({ query: 'Paper Forge' })
    check('多词查询不抛（FTS 语法/短语问题由回退兜住）', mixed.ok === true, JSON.stringify({ mode: mixed.mode, n: mixed.rows.length }))

    const scoped = corpus.search({ query: '服务器', chatKey: 'group:700000001' })
    check('★ 按会话过滤只出本会话的（私聊那条不会串进来）',
      scoped.rows.length === 1 && scoped.rows[0].chatKey === 'group:700000001',
      JSON.stringify(scoped.rows.map((r) => r.chatKey)))

    check('别的会话搜不到那条群消息',
      corpus.search({ query: '服务器', chatKey: 'private:10001' }).rows.length === 0)

    const bot = corpus.search({ query: '省内存' })
    check('★ 机器人自己说过的话也在库里（isBot 标出来）',
      bot.rows.length === 1 && bot.rows[0].isBot === true, JSON.stringify(bot.rows[0]))

    check('空查询 → 空结果，不抛',
      corpus.search({ query: '' }).rows.length === 0 && corpus.search({}).rows.length === 0)
    check('搜不到的词 → 空结果而不是报错',
      corpus.search({ query: '完全不存在的东西xyz' }).rows.length === 0)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('② 幂等与上限')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const again = rec({ messageId: 'm1', userId: '10001', text: '霸王茶姬出了个新品叫桂馥兰香' })
    check('★ 同一个 message_id 再喂一次 → 判为重复、不新增行',
      again.ok === true && again.skipped === 'duplicate', JSON.stringify(again))
    check('★ 库里确实只有一行 m1',
      corpus.search({ query: '霸王茶姬出了个' }).rows.filter((r) => r.messageId === 'm1').length === 1)

    const a = rec({ messageId: 'long', text: '很长的内容'.repeat(2000) })
    check('超长内容被截断入库（不让一条撑爆库）', a.ok === true)
    const longHit = corpus.search({ query: '很长的内容' })
    check('  └ 截断后仍然可检索，并标注了已截断',
      longHit.rows.length === 1 && longHit.rows[0].preview.length <= CORPUS_LIMITS.preview + 1)

    check('空内容不入库（skipped=empty）', rec({ messageId: 'e1', text: '   ' }).skipped === 'empty')

    const big = corpus.search({ query: '的', limit: 9999 })
    check(`★ limit 被夹到上限（${CORPUS_LIMITS.limit}）`, big.rows.length <= CORPUS_LIMITS.limit, String(big.rows.length))
    const longQ = corpus.search({ query: '啊'.repeat(1000) })
    check('超长查询被截断（不抛、不吃满 CPU）', longQ.ok === true)
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('③ ★★ 隐私不落库（写之前拦，不是写完再删）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const phone = rec({ messageId: 'p1', text: '我的手机号是 13800138000，有事打我电话' })
    check('★★ 含手机号的消息**没有入库**（skipped=privacy）',
      phone.ok === false && phone.skipped === 'privacy', JSON.stringify(phone))
    check('★★ 用它搜也搜不到（真的不在库里，不是"藏起来了"）',
      corpus.search({ query: '13800138000' }).rows.length === 0 &&
        corpus.search({ query: '有事打我电话' }).rows.length === 0)

    const audit = String(readIf('memory/privacy-audit.jsonl') ?? '')
    check('★ 审计记了这一笔', audit.includes('corpus'), audit.split('\n').filter(Boolean).slice(-1)[0] ?? '(空)')
    check('★★ 而且**只记类别与长度，不记原文**（审计不能变成第二个泄露面）',
      !audit.includes('13800138000') && !audit.includes('有事打我电话'), audit.slice(-200))
    check('审计里带 side=corpus（与写入侧 store 区分开）', audit.includes('"side":"corpus"'), audit.slice(-160))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('④ TTL：默认只预演，--apply 才真删')
  // ══════════════════════════════════════════════════════════════════════════
  {
    rec({ messageId: 'old1', text: '很久以前的消息内容是甲', at: new Date(Date.now() - (CORPUS_TTL_DAYS + 5) * 86_400_000) })
    const dry = corpus.prune({})
    check('★ 预演：只说会删几条，**不动手**',
      dry.ok && dry.apply === false && dry.removed === 0 && dry.wouldRemove >= 1,
      JSON.stringify(dry))
    check('★ 预演之后那条还在', corpus.search({ query: '很久以前的消息内容是甲' }).rows.length === 1)

    const applied = corpus.prune({ apply: true })
    check('★★ --apply 才真删，并报出删了几条',
      applied.ok && applied.removed >= 1, JSON.stringify(applied))
    check('★★ 删掉之后**搜不到了**（FTS 索引跟着删，不留幽灵条目）',
      corpus.search({ query: '很久以前的消息内容是甲' }).rows.length === 0)
    check('★ 没超期的消息不受影响', corpus.search({ query: '霸王茶' }).rows.length === 1)

    const st = corpus.stats()
    check('统计能报出总数/按会话/超期数', st.ok && st.total >= 3 && st.expired === 0 && st.ttlDays === CORPUS_TTL_DAYS,
      JSON.stringify({ total: st.total, expired: st.expired, ttl: st.ttlDays, bytes: st.bytes }))
    check('统计里不含被隐私拦下的那条（它从来就没进库）',
      !st.byChat.some((c) => c.count > 3 && c.chatKey === 'private:10001') || st.total < 100,
      JSON.stringify(st.byChat))
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑤ 渲染与重建')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const rows = corpus.search({ query: '霸王茶' }).rows
    const text = renderSearchResults({ rows, query: '霸王茶', mode: 'fts' })
    check('★ 结果里带 `[mid:<id>]`（与 H6 的 [reply:] 闭环）', text.includes('[mid:m1]'), text.split('\n')[1])
    check('★ 带时间与发言人（不然模型不知道是谁什么时候说的）',
      text.includes('无忘远霞') && /\d{4}\//.test(text))
    check('★★ 明说"只能引用上面出现过的 id"（否则模型会编 id，白写一遍）',
      text.includes('只能引用上面出现过的') && text.includes('[reply:'))
    check('没有命中 → 空串（调用方据此不注入）', renderSearchResults({ rows: [] }) === '')

    check('rebuild 可用（怀疑索引不一致时的手工手段）', corpus.rebuild().ok === true)
    check('重建后仍能搜到', corpus.search({ query: '霸王茶' }).rows.length === 1)
    corpus.close()
    check('关库后文件确实在磁盘上', existsSync(join(WS, CORPUS_REL)) === true)

    // 重开（幂等建表：第二次 open 不能报错、也不能丢数据）
    const again = createCorpus({ workspace: WS, log: () => {} })
    check('★ 重开数据库：建表幂等、数据还在',
      again.ready() === true && again.search({ query: '霸王茶' }).rows.length === 1)
    again.close()
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑥ 失败路径：不许抛、不许静默（AGENT.md 第 9 条）')
  // ══════════════════════════════════════════════════════════════════════════
  {
    const logs = []
    const broken = createCorpus({ workspace: '', log: (m) => logs.push(String(m)) })
    check('没有 workspace → record 明确失败，不抛',
      broken.record({ kind: 'private', peerId: '1', text: 'x' }).ok === false)
    check('  └ search 明确失败，返回空结果而不是抛',
      broken.search({ query: 'x' }).ok === false && broken.search({ query: 'x' }).rows.length === 0)
    check('  └ prune / stats 也不抛',
      broken.prune({}).ok === false && broken.stats().ok === false)

    // 打不开的情况：把 runtime 位置做成文件（不是目录）→ mkdir 失败 → 只报一次
    const bad = join(ROOT, 'badws')
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(bad, { recursive: true })
    writeFileSync(join(bad, 'runtime'), 'not a directory', 'utf8')
    const logs2 = []
    const c2 = createCorpus({ workspace: bad, log: (m) => logs2.push(String(m)) })
    check('★★ 库打不开时**只报一次**（每条消息都会走到这条路，不能刷屏）',
      c2.record({ kind: 'private', peerId: '1', text: 'a' }).ok === false &&
        c2.record({ kind: 'private', peerId: '1', text: 'b' }).ok === false &&
        logs2.filter((l) => l.includes('语料库打不开')).length === 1,
      JSON.stringify(logs2))
    check('★ 但**必须留证据**（不许安静地失败）', logs2.some((l) => l.includes('❌')), JSON.stringify(logs2))
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

// ══════════════════════════════════════════════════════════════════════════
section('⑦ ★★ 开关（0.2.3）：关掉真的不落库，而且**能随时开关**（走完整 Bridge）')
// ══════════════════════════════════════════════════════════════════════════
//
// 为什么这一段必须走真 Bridge：`corpus.mjs` 本身没有 `enabled` 这个概念 ——
// 开关落在**接线**上（`#recordCorpus` / `searchHistory` / MCP 分派）。本项目栽过
// 同一类事故：任务段的 `chatKey` 在错的作用域、被空 catch 吞掉，那个段在真机上
// **从未注入过一次**，而纯函数断言全绿。**错在接线，纯函数测试看不见接线。**
{
  const { Bridge } = await import('../src/bridge.mjs')
  const { SendQueue } = await import('../src/onebot.mjs')
  const { SessionRouter } = await import('../src/session-bridge.mjs')

  const mkBridge = ({ enabled }) => {
    const ws = mkdtempSync(join(tmpdir(), 'qq-bridge-corpus-sw-'))
    tmpDirs.push(ws)
    const router = new SessionRouter({ log: () => {} })
    const config = {
      dsh: { workspace: ws, permissionMode: 'workspace-write' },
      onebot: {},
      access: { adminUsers: ['100000001'], dmAllowlist: [], groupAllowlist: ['700000001'] },
      // groupEnabled=false ⇒ 群消息**不被唤醒**，但 `#recordCorpus` 在唤醒判定**之前**
      // 就已经跑过 —— 这正好让我们用一条"不回"的消息来测落库，不必搭整套 rpc 回合。
      trigger: { private: true, mention: true, keyword: true, groupEnabled: false, keywords: [] },
      send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 100, maxPerHour: 1000, dedupeWindowMs: 0, maxCharsPerMessage: 1500 },
      turn: { timeoutMs: 5000 },
      humanize: { enabled: false, chunkChars: 300 },
      persona: { preset: 'none' },
      memory: { enabled: false },
      image: { enabled: false },
      ...(enabled === undefined ? {} : { corpus: { enabled } }),
    }
    const rpc = new EventTarget()
    const onebot = new EventTarget()
    onebot.selfId = '200000001'
    onebot.call = async () => ({ status: 'ok', retcode: 0, data: null })
    onebot.send = async () => {}
    const bridge = new Bridge({
      rpc,
      onebot,
      sendQueue: new SendQueue({ ...config.send, log: () => {} }),
      router,
      config,
      log: () => {},
    })
    return { bridge, config, ws }
  }
  const groupMsg = (text, id) => ({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    group_id: '700000001',
    user_id: '100000002',
    self_id: '200000001',
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    message_id: id,
    sender: { user_id: '100000002', nickname: '路人甲' },
  })
  const dbExists = (ws) => existsSync(join(ws, CORPUS_REL))

  const live = []
  const tmpDirs = []
  try {
    // ── ① 缺键 = 开（升级前的行为，零回归）──────────────────────────────
    {
      const { bridge, ws } = mkBridge({ enabled: undefined })
      live.push(bridge)
      await bridge.handleEvent(groupMsg('茶姬好喝吗', 1001))
      check('★ 缺 corpus.enabled ⇒ 照旧落库（默认 = 升级前的行为，零回归）', dbExists(ws), ws)
      const s = bridge.searchHistory({ chatKey: 'group:700000001', query: '茶姬' })
      check('  └ 落进去的能搜到（3 字走 FTS）', s.ok === true && s.rows.length === 1, `${s.ok}/${s.rows?.length} ${s.why ?? ''}`)
    }

    // ── ② 关掉 = 一条都不写，而且**库文件都不产生** ──────────────────────
    {
      const { bridge, ws } = mkBridge({ enabled: false })
      live.push(bridge)
      await bridge.handleEvent(groupMsg('茶姬好喝吗', 2001))
      check('★★ corpus.enabled=false ⇒ **一个字节都没写**（连接都不开，不是"少写一条"）',
        !dbExists(ws), ws)
      const s = bridge.searchHistory({ chatKey: 'group:700000001', query: '茶姬' })
      check('★★ 关掉时说的是"**被关掉了**"，不是"没搜到"（后者会被模型转述成谎话）',
        s.ok === false && /已关闭/.test(s.why ?? ''), s.why)
    }

    // ── ③ hot：运行中把关掉再打开，立刻生效（不是"启动时读一次"）─────────
    {
      const { bridge, config, ws } = mkBridge({ enabled: false })
      live.push(bridge)
      await bridge.handleEvent(groupMsg('第一条 茶姬', 3001))
      check('关着的时候不落库', !dbExists(ws))
      // ★ 模拟 `/api/extensions` 的 toggle：**就地把活配置对象改掉**（不重启）
      config.corpus.enabled = true
      await bridge.handleEvent(groupMsg('第二条 茶姬', 3002))
      check('★★ 运行中打开（只改活配置）⇒ **立刻**开始落库（这条是 hot 的取证）', dbExists(ws))
      const s = bridge.searchHistory({ chatKey: 'group:700000001', query: '茶姬' })
      check('  └ 只搜到打开之后那条（关着期间的没进来，如实）',
        s.ok === true && s.rows.length === 1 && String(s.rows[0].preview).includes('第二条'),
        JSON.stringify(s.rows?.map((r) => r.preview)))
      // 反向：再关掉，立刻停写
      config.corpus.enabled = false
      await bridge.handleEvent(groupMsg('第三条 茶姬', 3003))
      const s2 = bridge.searchHistory({ chatKey: 'group:700000001', query: '茶姬' })
      check('★★ 反向也立刻生效：再关掉就不再落库、查询也当场拒绝',
        s2.ok === false && /已关闭/.test(s2.why ?? ''), s2.why)
      check('  └ 已有的库文件**不在关掉时被删**（关 ≠ 清空）', dbExists(ws))
    }
  } finally {
    // 先 close（H7 的 SQLite 句柄要显式关，否则临时目录删不掉），再删临时工作区
    for (const b of live) {
      try {
        await b.close(200)
      } catch {
        /* 收尾失败不影响断言结果 */
      }
    }
    for (const ws of tmpDirs) rmSync(ws, { recursive: true, force: true })
  }
}

console.log('')
if (failed === 0) {
  console.log(`🎉 本地语料库测试全部通过（${passed} 项）`)
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
