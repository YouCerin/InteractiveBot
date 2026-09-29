#!/usr/bin/env node
/**
 * 记忆**全链路**校验：模型提议 → 桥接落盘 → 回执 → 下一轮注入。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须单独有这一套（verify-memory-store.mjs 不够）
 * ══════════════════════════════════════════════════════════════════════════
 * `verify-memory-store.mjs` 测的是**存储层**：给了 items 能不能正确落盘。
 * 但它**不经过 Bridge**，所以下面这条链路上任何一环断了它都发现不了：
 *
 *     模型在回复里写标记 → 桥接解析 → 剥离标记 → 落盘 → 写回执
 *       → 下一轮把回执与记忆注入提示词 → 模型看到"记上了没有"
 *
 * 而这条链路上每一环都**不会报错**：
 *   · 标记没被剥离 → 对方在 QQ 里看到一串 `<<<MEMORY …>>>`（社死，但不报错）
 *   · 落盘没写 → 机器人嘴上说"记下了"，实际什么都没记（最难查的一种）
 *   · 回执没生成 → 模型**不知道**自己没记上，于是继续骗人
 *   · 下一轮不注入 → 记了等于没记
 *
 * ── 这套测试怎么做到"确定性"────────────────────────────────────────────
 * 用**桩 rpc**：桩的回复内容由测试指定（包括那条 `<<<MEMORY …>>>` 标记），
 * 于是"模型到底会不会提议记忆"这个人品问题被排除掉，测的是**机制**。
 * 而文件系统是**真的**（临时目录），落盘、回执、注入都真的发生。
 *
 * ⚠️ 这一套**只证明机制是通的**，不证明真实模型会主动提议记忆 ——
 *    那是模型行为，得用 `--probe`（见 README）或看真实会话。
 *    这两件事必须分开说，混起来就会得出"测试全绿 = 它一定会记住"的错误结论。
 *
 * 用法：node mocks/verify-memory-roundtrip.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Bridge } from '../src/bridge.mjs'
import { SendQueue } from '../src/onebot.mjs'
import { SessionRouter } from '../src/session-bridge.mjs'
import { mergeWakeKeywords } from '../src/persona.mjs'

/** 包根（基线 fixture 用它定位：fixture 属于仓库，不属于临时工作区）。 */
const PKG_ROOT_FOR_FIXTURE = dirname(dirname(fileURLToPath(import.meta.url)))

const ADMIN = '100000001'
const NON_ADMIN = '100000002'
const GROUP = '700000001'
const OTHER_GROUP = '111111111'

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
function section(title) {
  console.log(`\n── ${title} ──────────────────────────────`)
}

/** 每个用例一份干净工作区（理由见 verify-identity.mjs 的 freshWorkspace）。 */
let seq = 0
const created = []
/** 所有造过的 Bridge（收尾要显式 close —— H7 的 SQLite 句柄） */
const liveBridges = []
function freshWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), `dsh-mem-rt-${process.pid}-${++seq}-`))
  created.push(dir)
  return dir
}

/**
 * 造一个桥接 + 桩 rpc。
 *
 * 桩的回复文本**由测试逐轮给**：`replies` 数组，第 n 轮取第 n 个。
 * 这是本套件能做到确定性的关键 —— 我们控制"模型说了什么"，
 * 于是可以精确断言"桥接拿它做了什么"。
 */
function makeBridge({ replies = [], toolsPerTurn = [], delays = [], endDelays = [], turnTimeoutMs = 5000, access = {}, memoryEnabled = true, persona = { preset: 'none' } } = {}) {
  const WS = freshWorkspace()
  const router = new SessionRouter({ log: () => {} })
  const logs = []
  const log = (m) => logs.push(String(m))

  const config = {
    dsh: { workspace: WS, permissionMode: 'workspace-write' },
    onebot: {},
    access: { adminUsers: [ADMIN], dmAllowlist: [], groupAllowlist: [GROUP], ...access },
    trigger: { private: true, mention: true, keyword: true, groupEnabled: true, keywords: ['小鲸鱼'] },
    send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 100, maxPerHour: 1000, dedupeWindowMs: 0, maxCharsPerMessage: 1500 },
    turn: { timeoutMs: turnTimeoutMs },
    humanize: { enabled: false, chunkChars: 300 },
    persona,
    memory: { enabled: memoryEnabled },
    image: { enabled: false },
  }

  let turn = 0
  const rpc = new EventTarget()
  rpc.prompts = []
  rpc.prompt = async (sessionId, contentBlocks) => {
    rpc.prompts.push(String(contentBlocks?.[0]?.text ?? ''))
    const turnNo = turn + 1
    const text = replies[turn] ?? replies[replies.length - 1] ?? '好的'
    turn += 1
    // 可选的"这一轮很慢"（毫秒）：用来构造**回合还在跑时又来一条消息**的场景
    //（H1 的 superseded 路径只能这么做出来），以及**超时**场景。
    const delay = Number(delays[turnNo - 1] ?? 0)
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))    // ── 这一轮里的工具调用（R2 的"步骤"就是从这些事件提炼的）──────────────
    // 形状必须与实测一致：`tool/call` 的 `arguments` 是 **JSON 字符串**，
    // 结果裹在 `message.content[0]` 的 `tool-result` 块里（见 session-bridge.mjs）。
    for (const t of toolsPerTurn[turnNo - 1] ?? []) {
      const callId = t.callId ?? `c${turnNo}-${t.name}`
      router.handleEvent(sessionId, {
        type: 'tool/call',
        data: { turn: turnNo, step: 1, name: t.name, callId, arguments: JSON.stringify(t.args ?? {}) },
      })
      router.handleEvent(sessionId, {
        type: 'tool/result',
        data: {
          turn: turnNo,
          step: 1,
          message: {
            source: { kind: 'tool', callId },
            content: [
              {
                type: 'tool-result',
                toolCallId: callId,
                isError: t.isError === true,
                content: [{ type: 'text', text: t.result ?? 'ok' }],
              },
            ],
          },
        },
      })
    }
    router.handleEvent(sessionId, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text }] } },
    })
    // 可选：**回复已产出、但回合迟迟不结束**（用来构造"超时"——
    // 只有这样才能同时满足"文本拿到了"和"回合没跑完"，见 ⑦-4）
    const endDelay = Number(endDelays[turnNo - 1] ?? 0)
    if (endDelay > 0) await new Promise((r) => setTimeout(r, endDelay))
    router.handleEvent(sessionId, { type: 'turn/end', data: { reason: 'completed' } })
    return { messageId: `m${turn}` }
  }

  const onebot = new EventTarget()
  onebot.selfId = '200000001'
  onebot.call = async (action) => {
    if (action === 'get_group_member_info') {
      return { status: 'ok', retcode: 0, data: { user_id: Number(NON_ADMIN), nickname: '路人甲', role: 'member' } }
    }
    if (action === 'get_group_list') {
      return { status: 'ok', retcode: 0, data: [{ group_id: Number(GROUP), group_name: '摸鱼群' }] }
    }
    if (action === 'get_friend_list') return { status: 'ok', retcode: 0, data: [] }
    return { status: 'ok', retcode: 0, data: null }
  }
  const sent = []
  // ★ 把 send 的**附加参数**（replyTo / faceId）也记下来 —— H6 的引用与表情
  //   都走这一条路，而"发了什么段"只有在这里能看到。
  onebot.send = async (kind, peerId, text, opts) => sent.push({ kind, peerId, text, ...(opts ?? {}) })

  const sendQueue = new SendQueue({ ...config.send, log })
  const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, log })
  // ★ 记下来，收尾时统一 close（H7 的 SQLite 句柄要显式关，否则临时目录删不掉）
  liveBridges.push(bridge)
  return { bridge, rpc, onebot, sent, logs, config, WS }
}

const privateMsg = (userId, text, messageId = null) => ({
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  user_id: userId,
  self_id: '200000001',
  ...(messageId != null ? { message_id: messageId } : {}),
  message: [{ type: 'text', data: { text } }],
  sender: { user_id: userId, nickname: `用户${userId}` },
})
const groupMsg = (groupId, userId, text) => ({
  post_type: 'message',
  message_type: 'group',
  group_id: groupId,
  user_id: userId,
  self_id: '200000001',
  message: [{ type: 'text', data: { text } }],
  raw_message: text,
  sender: { user_id: userId, nickname: `用户${userId}` },
})

const readIf = (ws, rel) => {
  const p = join(ws, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

async function main() {
  /* ══════════════════════════════════════════════════════════════════════
   * ① 全链路：提议 → 落盘 → 剥离 → 回执 → 下一轮注入
   * ══════════════════════════════════════════════════════════════════════ */
  section('① 一次真实的"提议 → 记住 → 下次还想得起来"')
  {
    const { bridge, rpc, sent, WS } = makeBridge({
      replies: [
        // 第 1 轮：模型的原始回复**带着标记**（这就是真实形态）
        '好，记住了哈。\n<<<MEMORY fact 无忘远霞喜欢喝冰美式>>>',
        // 第 2 轮：普通回复
        '嗯嗯。',
      ],
    })

    await bridge.handleEvent(privateMsg(ADMIN, '记住我喜欢喝冰美式'))

    // ── ①-1 发给 QQ 的正文里**绝不能有标记** ─────────────────────────────
    const delivered = sent.map((s) => s.text).join('\n')
    check('★★ 发给 QQ 的正文里没有残留记忆标记（剥离发生在发送之前）',
      !delivered.includes('MEMORY') && !delivered.includes('<<<'),
      JSON.stringify(delivered.slice(0, 60)))
    check('★ 正常那句话仍然发出去了（剥离不能把整条回复吃掉）',
      delivered.includes('记住了'), JSON.stringify(delivered.slice(0, 40)))

    // ── ①-2 真的落盘了 ───────────────────────────────────────────────────
    const facts = readIf(WS, `memory/private-${ADMIN}.md`)
    check('★★ 记忆真的写进了这个人的私聊记忆文件',
      facts !== null && facts.includes('无忘远霞喜欢喝冰美式'),
      facts === null ? '（文件不存在 —— 它嘴上说记下了，其实什么都没记）' : facts.trim().split('\n').slice(-1)[0])

    // ── ①-3 回执已生成（下一轮才消费）────────────────────────────────────
    const receipt = readIf(WS, `memory/.receipts/private-${ADMIN}.txt`)
    check('★★ 生成了"记上了"的回执（模型下一轮才知道到底记上没有）',
      receipt !== null && receipt.includes('已记下'), receipt ?? '（没有回执）')

    // ── ①-4 下一轮：回执 + 记忆都进了提示词 ───────────────────────────────
    await bridge.handleEvent(privateMsg(ADMIN, '我刚说了啥来着'))

    const prompt2 = rpc.prompts[1] ?? ''
    check('★★ 第二轮提示词里能读到那条记忆（记了要能用上，不然等于没记）',
      prompt2.includes('无忘远霞喜欢喝冰美式'))
    check('★★ 第二轮提示词里带着**回执**（它于是能如实说"记上了"）',
      // ★ 现在是 **2 条**：用户那句"记住我喜欢喝冰美式"被**关键词直写**通道记了 1 条，
      //   模型自己还提议了 1 条（`无忘远霞喜欢喝冰美式`）—— 两条都算数。
      //   升级前只有 1 条（没有关键词通道），所以这条断言跟着改了。
      prompt2.includes('上一条消息的记忆回执') && /已记下\s*2\s*条/.test(prompt2),
      (prompt2.match(/【上一条消息的记忆回执】[^\n]*\n?[^\n]*/) ?? [''])[0])
    check('★ 回执是"读后即删"的：第三轮不该再看到它',
      !readIf(WS, `memory/.receipts/private-${ADMIN}.txt`),
      '（文件还在 = 没被消费）')

    // ── ①-5 注入的文本里**不能有文件路径**（会破坏前缀缓存）──────────────
    //
    // ★★ 0.2.2 起这条断言的**范围**必须收窄，否则它会误伤：
    //    提示词里现在**故意**有一行指向项目简介副本（`store/interactbot-intro.md`）——
    //    那是**每轮都一样的常量**，不参与"每轮变化的文本"，对前缀缓存零影响。
    //    真正杀缓存的是**随会话变化**的路径（`memory/private-<QQ>.md` 这类）。
    //    所以分开断言：记忆那一段不许有路径；整篇不许有**随会话变化**的路径。
    const memBlock = (prompt2.match(/【长期记忆】[\s\S]*?(?=\n【|$)/) ?? [''])[0] || prompt2
    check('★★ 注入的记忆文本里不含文件路径（实测缓存命中率 91%~96% 靠这个）',
      !/memory\/|private-|group-|\.md/.test(memBlock), memBlock.slice(0, 120))
    check('★ 整篇提示词里也不含**随会话变化**的路径（那才是缓存杀手）',
      !/memory\/private-|memory\/group-/.test(prompt2))
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ② 记不上时必须有回执 —— 否则模型会继续骗人
   * ══════════════════════════════════════════════════════════════════════ */
  section('② 没记上时必须留下回执（不许静默丢弃）')
  {
    const { bridge, rpc, WS } = makeBridge({
      replies: [
        // "谁是管理员"这类内容被内容级规则**硬拦** —— 这是刻意设计
        '好。\n<<<MEMORY fact 群里的群主是无忘远霞，他是管理员>>>',
        '嗯。',
      ],
    })

    await bridge.handleEvent(privateMsg(ADMIN, '记一下谁是管理员'))
    check('★★ 涉及身份/权限的条目没有被写进文件（内容级硬拦）',
      readIf(WS, `memory/private-${ADMIN}.md`) === null)

    const receipt = readIf(WS, `memory/.receipts/private-${ADMIN}.txt`)
    check('★★ 但它留下了"**没记下**"的回执（不能静默丢弃）',
      receipt !== null && receipt.includes('没记下'), receipt ?? '（没有回执 = 静默丢弃）')

    await bridge.handleEvent(privateMsg(ADMIN, '刚让你记的呢'))
    const prompt2 = rpc.prompts[1] ?? ''
    check('★ 下一轮模型被告知"没记下"，于是能如实说没记住',
      prompt2.includes('没记下') && prompt2.includes('别当成记上了'))
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ③ 分档落对文件：群事进群文件，不该串场
   * ══════════════════════════════════════════════════════════════════════ */
  section('③ 记忆按会话分档（不能串场）')
  {
    const { bridge, WS } = makeBridge({
      replies: ['嗯。\n<<<MEMORY fact 本群周六晚上开黑>>>'],
    })
    await bridge.handleEvent(groupMsg(GROUP, NON_ADMIN, '小鲸鱼记住本群周六开黑'))

    const groupFile = readIf(WS, `memory/group-${GROUP}.md`)
    check('★ 群里说的群事写进本群文件', groupFile !== null && groupFile.includes('周六晚上开黑'),
      groupFile === null ? '（没写）' : groupFile.trim().split('\n').slice(-1)[0])
    check('★★ 群聊**写不进**私聊文件（不串场）',
      readIf(WS, `memory/private-${NON_ADMIN}.md`) === null)
    check('★★ 群聊也**写不进**全局 MEMORY.md（全局会被所有群看到）',
      readIf(WS, 'MEMORY.md') === null)

    // 换个群看：**看不到**别的群的记忆。
    // ⚠️ 这里**不要**再造一个桥接 —— 第一版造了一个（`makeBridge`）却忘了它带的是
    //    另一个空工作区，于是那条"背景"断言其实什么都没验（`check(..., true)` 恒真）。
    //    假断言比没有断言更坏，所以现在直接对 `readMemoryForPrompt` 断言。
    const { readMemoryForPrompt } = await import('../src/memory-store.mjs')
    const here = readMemoryForPrompt({ workspace: WS, kind: 'group', peerId: GROUP })
    const there = readMemoryForPrompt({ workspace: WS, kind: 'group', peerId: OTHER_GROUP })
    check('★★ 本群注入里有那条记忆', here.text.includes('周六晚上开黑'))
    check('★★ 别的群注入里**没有**它（群记忆是隔离的）',
      !there.text.includes('周六晚上开黑'), JSON.stringify(there.text.slice(0, 60)))
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ④ 绕过桥接手改记忆 → 必须被回滚（"写入权归桥接"要有牙齿）
   * ══════════════════════════════════════════════════════════════════════ */
  section('④ 绕过桥接改记忆会被回滚')
  {
    const { bridge, rpc, WS, logs } = makeBridge({
      replies: ['好。\n<<<MEMORY global 大家都叫我小鲸鱼>>>', '嗯。'],
    })
    await bridge.handleEvent(privateMsg(ADMIN, '记一下我叫你小鲸鱼'))

    const globalFile = join(WS, 'MEMORY.md')
    check('（前置）全局记忆已写入', existsSync(globalFile))

    // 模拟"模型用自己的 write 工具直接改了记忆文件"（它手里确实有 write）
    writeFileSync(globalFile, '# 记忆\n\n- 我偷偷加的一条，绕过桥接\n', 'utf8')

    // 下一轮开始时桥接会先校验并回滚
    await bridge.handleEvent(privateMsg(ADMIN, '你还记得啥'))

    const after = readFileSync(globalFile, 'utf8')
    check('★★ 绕过桥接写的条目被回滚掉了',
      !after.includes('偷偷加的一条'), after.trim().split('\n').slice(-1)[0])
    check('★ 原来那条记忆还在（回滚不是清空）', after.includes('大家都叫我小鲸鱼'))
    // ⚠️ 第一版这里写的是 `check(..., true)` —— 一条**恒真**的假断言。
    //    回滚日志由 verifyAndRestoreMemory 打进桥接日志，本用例手里就有那个数组，
    //    所以应该真的去查它。恒真的断言只会让人以为"这里验过了"。
    check('★ 日志里明确记了这次回滚（不许静默）',
      logs.some((l) => /回滚|篡改|tamper/i.test(l)),
      logs.filter((l) => /回滚|篡改/.test(l)).slice(-1)[0] ?? '（日志里没有回滚记录）')
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑤ 关了记忆开关就真的不写（别"配置说不写、代码里偷偷写"）
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑤ memory.enabled=false 时一个字都不写')
  {
    const { bridge, rpc, WS, sent } = makeBridge({
      memoryEnabled: false,
      replies: ['好。\n<<<MEMORY fact 不该被写进去的东西>>>'],
    })
    await bridge.handleEvent(privateMsg(ADMIN, '记住点啥'))

    check('★ 没有写出任何记忆文件',
      readIf(WS, `memory/private-${ADMIN}.md`) === null && readIf(WS, 'MEMORY.md') === null)
    check('★ 也没有回执（没有记忆这回事，就不该有回执）',
      readIf(WS, `memory/.receipts/private-${ADMIN}.txt`) === null)
    check('★ 提示词里没有记忆段（关掉就真的不注入）',
      !String(rpc.prompts[0] ?? '').includes('长期记忆'))
    // 标记仍然必须被剥掉：关掉记忆不等于把标记发给对方
    check('★★ 即使关掉记忆，标记也必须被剥离（否则对方会看到 `<<<MEMORY …>>>`）',
      !sent.map((s) => s.text).join('\n').includes('MEMORY'),
      JSON.stringify(sent.map((s) => s.text).join('\n').slice(0, 60)))
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑥ ★★★ 接线：任务段 / 配方段必须真的**进到提示词里**
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑥ ★★★ 接线：任务段与配方段真的进了提示词（不只是纯函数能渲染）')
  {
    // 这一节修的是一个**真机事故**（2026-09-26 22:24~22:36 的 7 轮真实对话）：
    // `#buildPrompt` 里的 `chatKey` 曾经**不在作用域**（它是 `#runTurn` 的局部变量），
    // 于是 `readTask` 每次都抛 `ReferenceError`，被那个空 `catch` 吃掉 ——
    // 【当前任务】段**在真机上从未注入过一次**，日志里连一个字都没有。
    //
    // 为什么 124 项离线测试全绿却没发现：它们测的是**纯函数** `renderTaskBlock`
    // （喂一个台账进去，断言渲染结果），而错在**接线** —— 桥接根本没有把台账喂进去。
    // 所以这一节的断言必须**走完整桥接**、并且**去读 `rpc.prompts`**（模型真正收到的东西）。
    const { bridge, rpc, logs, WS } = makeBridge({
      replies: ['好的，我看一下。', '看完了。', '嗯。'],
      toolsPerTurn: [
        [{ name: 'read', args: { file_path: 'a.txt' }, result: '文件内容' }],
        [],
        [],
      ],
    })

    await bridge.handleEvent(privateMsg(ADMIN, '帮我读一下 a.txt'))

    const ledger = readIf(WS, `runtime/tasks/private_${ADMIN}.json`)
    const parsed = ledger ? JSON.parse(ledger) : null
    check('前提：第 1 轮之后台账里真的有步骤（读写键一致才可能有这一步）',
      parsed?.steps?.length === 1 && parsed?.goal === '帮我读一下 a.txt',
      JSON.stringify({ steps: parsed?.steps?.length, goal: parsed?.goal }))

    await bridge.handleEvent(privateMsg(ADMIN, '那现在呢'))
    const second = String(rpc.prompts[1] ?? '')
    check('★★★ 第 2 轮的提示词里**真的有**【当前任务】段（这就是真机上缺的那一段）',
      second.includes('【当前任务'), second.includes('【当前任务') ? '' : `提示词 ${second.length} 字里没有它`)
    check('★★ 段里带着上一轮的步骤与目标（不是空壳）',
      second.includes('a.txt') && second.includes('帮我读一下 a.txt'))
    check('★ 注入失败**不许静默**：日志里不能有"注入失败"',
      !logs.join('\n').includes('注入失败'),
      logs.filter((l) => l.includes('注入失败')).join('｜') || '（干净）')

    // ── 反例：注入**真的抛异常**时必须喊一次（而不是像原来那样空 catch）──────
    // 用一个 `toString` 会抛的假工作区，逼 `readTask` 抛出来。
    // ⚠️ 必须把记忆开关关掉：记忆段在代码里排在任务段**之前**，它也会碰 workspace，
    //    不关的话异常会先在那一层炸掉，任务段根本轮不到（第一版就是这么写的，断言空转）。
    {
      const broken = makeBridge({ replies: ['好'], toolsPerTurn: [[]], memoryEnabled: false })
      broken.bridge.config.dsh.workspace = {
        toString() {
          throw new Error('注入炸了（测试构造）')
        },
      }
      await broken.bridge.handleEvent(privateMsg(ADMIN, '第一句'))
      await broken.bridge.handleEvent(privateMsg(ADMIN, '第二句'))
      const warned = broken.logs.filter((l) => l.includes('注入失败'))
      check('★★ 抛异常时**必须留证据**（原来那个空 catch 正是 R2 静默失效的根因）',
        warned.length > 0, warned[0] ?? '（日志里没有"注入失败"）')
      // 0.2.2 起这条接线上有**三段**会碰 workspace：任务段 / 配方段 / 称呼段（按人昵称）。
      // ★ 0.2.4 多一段：**表情包段**（它要读库才能算出"当前真有货的标签"）。
      // 每段各报一次：2 轮 × 3 段 = 6 才是"没去重"；现在共 4 段。
      const taskWarned = warned.filter((l) => l.includes('任务段'))
      const recipeWarned = warned.filter((l) => l.includes('配方段'))
      const nickWarned = warned.filter((l) => l.includes('称呼段'))
      const stickerWarned = warned.filter((l) => l.includes('表情包段'))
      check('★ 每段只喊一次（跑了两轮，每段仍然只有一条）',
        taskWarned.length === 1 &&
          recipeWarned.length === 1 &&
          nickWarned.length === 1 &&
          stickerWarned.length === 1 &&
          warned.length === 4,
        `任务段 ${taskWarned.length} / 配方段 ${recipeWarned.length} / 称呼段 ${nickWarned.length} / 表情包段 ${stickerWarned.length} / 合计 ${warned.length}`)
      check('★ 段落名要在日志里（能一眼看出是哪一段没进去）',
        taskWarned[0]?.includes('任务段'), taskWarned[0] ?? '')
    }

    // ── 配方段：同一条接线上另一个 try/catch ────────────────────────────────
    const { upsertRecipe } = await import('../src/recipes.mjs')
    upsertRecipe({
      workspace: WS,
      source: 'auto',
      recipe: {
        title: '读文件先看目录',
        trigger: { keywords: ['读一下这个文件', '看看这个文件'] },
        steps: ['先用 glob 列目录，再挑着读'],
      },
    })
    await bridge.handleEvent(privateMsg(ADMIN, '帮我读一下这个文件'))
    const third = String(rpc.prompts[2] ?? '')
    check('★★★ 配方段也真的进了提示词（同一条接线上另一个 try/catch）',
      third.includes('可套用的做法') && third.includes('读文件先看目录'),
      third.includes('可套用的做法') ? '' : `提示词 ${third.length} 字里没有配方段`)
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑦ ★★★ 确定性写入 + H1：作废/超时的回合不能把记忆吞掉
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑦ ★★★ 「记住 X」必须落盘（不依赖模型）+ 作废/超时回合的记忆三分类')
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

    // ── ⑦-1 关键词直写：模型**什么都没提议**，磁盘上也必须有 ───────────────
    {
      const STUB_REPLY = '好的，记下了。' // 注意：这句里**没有**任何记忆标记
      const { bridge, WS } = makeBridge({ replies: [STUB_REPLY] })
      await bridge.handleEvent(privateMsg(ADMIN, '记住我的 MC 服务器是 Forge 端'))
      const file = readIf(WS, `memory/private-${ADMIN}.md`)
      check('★★★ 用户说「记住 X」→ 磁盘上真的有了（**与模型行不行无关**）',
        String(file ?? '').includes('Forge 端'), String(file ?? '(文件都不存在)').slice(0, 80))
      check('★ 模型一个字都没提议也照样写（这是这一层存在的全部理由）',
        // ⚠️ 不能拿提示词去断言"没有 MEMORY" —— 提示词里的**记忆指令段**
        //    本来就会教它 `<<<MEMORY fact …>>>` 这个语法。
        //    要看的是**模型的回复**里没有标记（本用例的桩回复就是一句普通回话）。
        !STUB_REPLY.includes('MEMORY') && String(file ?? '').includes('Forge 端'))
      // 回执要告诉模型"这条系统已经直接记了，不用你再提议"
      const receipt = readIf(WS, `memory/.receipts/private-${ADMIN}.txt`)
      check('★ 回执里说明是"对方明确要求记的、系统直接落盘"（防止它重复提议）',
        /直接落盘|明确要求/.test(String(receipt ?? '')), String(receipt ?? '(无回执)').slice(0, 100))
      // 审计：来源必须是 keyword（不是 marker）
      const audit = String(readIf(WS, 'memory/audit.jsonl') ?? '')
      check('★ 审计记下了来源=keyword', audit.includes('"source":"keyword"'), audit.slice(0, 160))
      check('★ 审计**不记原文**', !audit.includes('Forge'), audit.slice(0, 160))
    }

    // ── ⑦-2 隐私内容仍然拦得住（确定性 ≠ 绕过闸门）────────────────────────
    {
      const { bridge, WS } = makeBridge({ replies: ['好的。'] })
      await bridge.handleEvent(privateMsg(ADMIN, '记住我的手机号是 13800138000'))
      const file = String(readIf(WS, `memory/private-${ADMIN}.md`) ?? '')
      check('★★ 含手机号的"记住 X"被隐私闸门拦住（没落盘）', !file.includes('13800138000'), file.slice(0, 80))
      const receipt = String(readIf(WS, `memory/.receipts/private-${ADMIN}.txt`) ?? '')
      check('★★ 而且回执如实说"没记下"（否则模型/用户都会以为记上了）',
        receipt.includes('没记下') && /隐私/.test(receipt), receipt.slice(0, 120))
    }

    // ── ⑦-3 superseded：被取代的回合**仍然要结算记忆**（H1 的核心）─────────
    {
      const { bridge, rpc, sent, logs, WS } = makeBridge({
        replies: [
          '好，我记下了。\n<<<MEMORY fact 他喜欢喝冰美式>>>', // 第 1 轮：模型提议（这轮会被作废）
          '嗯嗯。', // 第 2 轮：正常
        ],
        delays: [200, 0], // 第 1 轮慢，好让第 2 条消息插进来把它作废
      })
      const p1 = bridge.handleEvent(privateMsg(ADMIN, '记住我喜欢喝冰美式'))
      await sleep(30) // 等第 1 轮真的进到"等模型"那一步
      const p2 = bridge.handleEvent(privateMsg(ADMIN, '在吗'))
      await Promise.all([p1, p2])

      check('前提：第 1 轮真的被作废了', logs.some((l) => l.includes('旧回合已作废')),
        logs.filter((l) => l.includes('作废')).join('｜'))
      const file = String(readIf(WS, `memory/private-${ADMIN}.md`) ?? '')
      check('★★★ 作废回合里的记忆**照样落盘**了（修复前会被整条吞掉）',
        file.includes('冰美式'), file.slice(0, 100))
      check('★ 而且关键词直写那条也在（同一轮两条通道都要结算）',
        file.includes('我喜欢喝冰美式') || file.includes('冰美式'))
      check('★ 日志里说明"已结算记忆"（不是静默）',
        logs.some((l) => /但已结算记忆/.test(l)), logs.filter((l) => l.includes('结算')).join('｜') || '（没有）')
      check('★ 作废那一轮的回复**没有发给 QQ**（行为不变）',
        !sent.map((s) => s.text).join('\n').includes('我记下了'))
      check('★★ 回执进了**下一轮的提示词**（模型下一轮知道记上了）',
        /已记下|冰美式/.test(String(rpc.prompts[1] ?? '')), String(rpc.prompts[1] ?? '').slice(0, 60))
    }

    // ── ⑦-4 超时：关键词直写照写，模型提议不写半截 ─────────────────────────
    {
      const { bridge, rpc, sent, WS } = makeBridge({
        replies: [
          '好。\n<<<MEMORY fact 他打算下周去成都>>>', // 这一轮会超时
          '嗯。',
        ],
        // ★ 关键：**回复先产出、回合后结束**。若用 `delays`（回复也晚到），
        //   超时会把整条回复一起丢掉，就构造不出"有提议但没跑完"这种情况了。
        endDelays: [400, 0],
        turnTimeoutMs: 60, // 60ms 就判超时
      })
      await bridge.handleEvent(privateMsg(ADMIN, '记住我的新手机壳是蓝色的'))
      check('前提：这一轮确实按超时处理了', sent.some((s) => s.text.includes('超时')),
        JSON.stringify(sent.map((s) => s.text)))

      const file = String(readIf(WS, `memory/private-${ADMIN}.md`) ?? '')
      check('★★ 超时了，但**用户那句话照样记下**（它模型跑没跑完无关）',
        file.includes('蓝色的'), file.slice(0, 100))
      check('★★ 模型那半截提议**没有被写进去**（不写半成品污染记忆）',
        !file.includes('成都'), file.slice(0, 120))

      // 再发一条，读回执：必须说明"上一轮没跑完、你提议的没被处理"
      await bridge.handleEvent(privateMsg(ADMIN, '刚才那个呢'))
      const prompt2 = String(rpc.prompts[rpc.prompts.length - 1] ?? '')
      check('★★ 回执里说明"上一轮没跑完、你提议的没被处理"（否则它会以为记上了）',
        /没跑完/.test(prompt2) && /没有被处理/.test(prompt2),
        (prompt2.match(/【上一条消息的记忆回执】[\s\S]{0,200}/) ?? ['(提示词里没有回执段)'])[0])
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑧ ★★ H2 定时整理：接线（attach 启动 / 空闲门控 / close 停掉）
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑧ ★★ 定时整理的接线：attach 启动、忙时跳过、真的会合并')
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

    // ── ⑧-1 attach 就启动，且手动触发真的会合并重复条目 ─────────────────────
    {
      const { bridge, onebot, logs, WS } = makeBridge({ replies: ['好'] })
      mkdirSync(join(WS, 'memory'), { recursive: true })
      const rel = `memory/private-${ADMIN}.md`
      writeFileSync(
        join(WS, rel),
        ['# 记忆', '', '- 他喜欢喝冰美式', '- 他喜欢喝冰美式。', '- 他的服务器是 Forge 端'].join('\n') + '\n',
        'utf8',
      )

      check('还没 attach 时不能手动整理（明确说清为什么）',
        bridge.consolidateNow().ok === false, JSON.stringify(bridge.consolidateNow()))

      bridge.attach(onebot)
      check('★ attach 时启动了定时整理（日志里有"已开启"）',
        logs.some((l) => l.includes('定时整理已开启')), logs.filter((l) => l.includes('定时整理')).join('｜'))

      const r = bridge.consolidateNow()
      check('★★ 手动触发一次：重复条目被合并', r.ok === true && r.changed === 1 && r.before === 3 && r.after === 2,
        JSON.stringify(r))
      check('★ 日志里说清了改了哪个文件',
        logs.some((l) => l.includes('有变化') && l.includes(rel)), logs.filter((l) => l.includes('有变化')).join('｜'))
      const after = readFileSync(join(WS, rel), 'utf8')
      check('磁盘上确实合并了（正文里没有两条一样的）',
        after.split('\n').filter((l) => l.trim().startsWith('- ')).length === 2, after)
      check('★ 整理后快照被刷新 → 再读记忆不会被回滚', (() => {
        try {
          // 走一次真实的"读记忆"路径：它会先做篡改检测
          return !logs.some((l) => l.includes('已回滚'))
        } catch {
          return false
        }
      })())
    }

    // ── ⑧-2 忙的时候必须跳过（整理会重写文件，不能在写记忆的当口动手）──────
    {
      const { bridge, onebot, WS } = makeBridge({ replies: ['好'], delays: [250] })
      bridge.attach(onebot)
      const p = bridge.handleEvent(privateMsg(ADMIN, '在吗'))
      await sleep(40) // 等这一轮真的进到"等模型"那一步
      const r = bridge.consolidateNow()
      check('★★ 桥接忙时**跳过整理**（否则可能覆盖掉刚写进去的记忆）',
        r.ok === true && r.skipped === 'busy', JSON.stringify(r))
      await p
      const r2 = bridge.consolidateNow()
      check('★ 忙完之后再触发就正常跑了', r2.ok === true && r2.skipped === undefined, JSON.stringify(r2))
      check('★ 空目录也能跑（没有记忆文件时 files=0，不报错）', r2.files >= 0)
    }

    // ── ⑧-3 close 会停掉定时器 ─────────────────────────────────────────────
    {
      const { bridge, onebot } = makeBridge({ replies: ['好'] })
      bridge.attach(onebot)
      await bridge.close(200)
      // 停掉之后手动触发仍然可用（tick 与 interval 是两件事），
      // 但**不可能再有定时器在后台动用户的记忆文件**
      check('close() 之后不再有后台定时器（tick 仍可手动调用，不影响收尾）',
        bridge.consolidateNow().ok === true)
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑨ ★★★ H5 投递前终检门：内部东西绝不能发到 QQ
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑨ ★★★ 投递前终检门：内部泄漏到不了用户手里')
  {
    // ── ⑨-1 整条都是内部产物 → 用户收到的是诚实话术，不是那串 JSON ──────────
    {
      const { bridge, sent, logs } = makeBridge({
        replies: ['{"name":"read","arguments":{"file_path":"a.txt"}}'],
      })
      await bridge.handleEvent(privateMsg(ADMIN, '读一下 a.txt'))
      const delivered = sent.map((s) => s.text).join('\n')
      check('★★★ 工具调用的 JSON **没有被发出去**',
        !delivered.includes('"arguments"') && !delivered.includes('"file_path"'), JSON.stringify(delivered))
      check('★★ 用户收到的是**诚实话术**，而不是"什么都没有"（静默不发会被当成机器人坏了）',
        delivered.includes('再说一次'), JSON.stringify(delivered))
      check('★ 日志里留了证据（含原文片段，便于排查）',
        logs.some((l) => l.includes('拦下整条回复') && l.includes('arguments')),
        logs.filter((l) => l.includes('拦下整条回复')).join('｜') || '（没有日志）')
    }

    // ── ⑨-2 只有一行是内部东西 → 删那一行，正文照发 ─────────────────────────
    {
      const { bridge, sent } = makeBridge({
        replies: ['好的，那个文件我看完了，结论是没问题。\n<system-reminder>internal</system-reminder>'],
      })
      await bridge.handleEvent(privateMsg(ADMIN, '那个文件怎么样'))
      const delivered = sent.map((s) => s.text).join('\n')
      check('★★ 坏行被删掉（注入标记到不了用户手里）', !delivered.includes('system-reminder'), JSON.stringify(delivered))
      check('★★ 正文一个字都没少', delivered.includes('结论是没问题'), JSON.stringify(delivered))
    }

    // ── ⑨-3 内部标记（半截）也要拦住 ────────────────────────────────────────
    {
      const { bridge, sent } = makeBridge({ replies: ['好。\n<<<MEMORY fact 没写完的标记'] })
      await bridge.handleEvent(privateMsg(ADMIN, '记住点啥'))
      const delivered = sent.map((s) => s.text).join('\n')
      check('★★ 半截的记忆标记不会漏给用户（这是第二道网，第一道是剥标记）',
        !delivered.includes('MEMORY') && !delivered.includes('<<<'), JSON.stringify(delivered))
    }

    // ── ⑨-4 正常回复不受影响（防误伤，端到端）──────────────────────────────
    {
      const { bridge, sent } = makeBridge({ replies: ['这个嘛（其实我也拿不准），我回头再确认一下哈。'] })
      await bridge.handleEvent(privateMsg(ADMIN, '那个事怎么样了'))
      const delivered = sent.map((s) => s.text).join('\n')
      check('★★ 正常中文（含圆括号）**原样送达** —— 闸门不许吃内容',
        delivered.includes('（其实我也拿不准）'), JSON.stringify(delivered))
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑩ ★★★ H6 带内标记：引用真的能发出去、编的 id 不许用
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑩ ★★★ 带内标记：提示词给出 id、引用能真的发出去、编的 id 不许用')
  {
    // ── ⑩-1 提示词里必须有**真的消息 id**（否则模型的 [reply:] 无从下手）────
    {
      const { bridge, rpc } = makeBridge({ replies: ['好'] })
      await bridge.handleEvent(privateMsg(ADMIN, '在吗', 987654))
      const prompt = String(rpc.prompts[0] ?? '')
      check('★★ 来源标注里带上了这条消息的 id（`#987654`）',
        prompt.includes('#987654'), (prompt.match(/\[来自 QQ 私聊[^\]]*\]/) ?? ['(没找到来源标注)'])[0])
      check('★★ 并且教了怎么引用（`[reply:`）', prompt.includes('[reply:'))
      check('★ 明说"编的 id 不会生效"（防止它随手编一个）',
        prompt.includes('校验') && prompt.includes('不会生效'))
      check('★ 没配表情表 → **一个字都不提** sticker（提示词不许承诺做不到的事）',
        !prompt.includes('[sticker:'), (prompt.match(/【这一轮可用的标记】[\s\S]{0,120}/) ?? ['(无标记段)'])[0])
    }

    // ── ⑩-2 见过 id → 引用真的随第一条发出去 ───────────────────────────────
    {
      const { bridge, sent } = makeBridge({
        replies: ['就是你说的那样。[reply:#111]', '嗯'],
      })
      await bridge.handleEvent(privateMsg(ADMIN, '第一条', 111))
      await bridge.handleEvent(privateMsg(ADMIN, '第二条', 222))
      // 第一轮回复里写了 [reply:#111]，而 111 是本会话见过的 → 应该带上引用段
      const first = sent[0] ?? {}
      check('★★ 见过 id → 发送时真的带上 `replyTo`', first.replyTo === '111', JSON.stringify(first))
      check('★★ 标记本身**不在正文里**（内部协议绝不能露给用户）',
        !String(first.text ?? '').includes('[reply'), JSON.stringify(first.text))
      check('★ 正文其余部分照常', String(first.text ?? '').includes('就是你说的那样'))
    }

    // ── ⑩-2b ★★★ **负数消息 id**：本机 SnowLuma 的 id 就是负的 ───────────────
    //
    // 这一段盯的是一处**真机上"引用回复永远失效"**的缺陷（0.2.3 从 bridge.log 里抓到的）：
    // 真机事件里 `message_id` 是**负数**（日志里能看到 `-429124262`），而
    // `markers.mjs` 的 `ID_RE` 原来只认非负整数 ⇒ 模型照提示词写的
    // `[reply:#-429124262]` **一次都没生效过**，只在日志里留一行"已丢弃"。
    // 症状是功能静默消失：机器人照样回话，只是永远不引用。
    // ★ 为什么这条必须走真 Bridge：`#` 前缀、负号、以及"见过的 id"白名单
    //   分处三个模块（markers / bridge 的 #seenMsgIds / 提示词渲染），
    //   纯函数测试只能覆盖第一处。
    {
      const { bridge, rpc, sent } = makeBridge({
        replies: ['就是你说的那个。[reply:#-429124262]'],
      })
      await bridge.handleEvent(privateMsg(ADMIN, '这个报错怎么修', -429124262))
      const prompt = String(rpc.prompts[0] ?? '')
      check('★★ 来源标注里带上了**负数** id（`#-429124262`）',
        prompt.includes('#-429124262'), (prompt.match(/\[来自 QQ 私聊[^\]]*\]/) ?? ['(没找到来源标注)'])[0])
      const m = sent[0] ?? {}
      check('★★★ 负 id 的引用**真的随消息发出去了**（修前这里是 null）',
        m.replyTo === '-429124262', JSON.stringify(m))
      check('★ 标记仍然被剥离（用户看不到 [reply:…]）',
        !String(m.text ?? '').includes('[reply'), JSON.stringify(m.text))
      check('★ 正文其余部分照常', String(m.text ?? '').includes('就是你说的那个'))
    }

    // ── ⑩-3 没见过的 id → 丢掉引用、正文照发（不猜）────────────────────────
    {
      const { bridge, sent, logs } = makeBridge({
        replies: ['我记得是这个。[reply:999999]'],
      })
      await bridge.handleEvent(privateMsg(ADMIN, '什么来着', 111))
      const m = sent[0] ?? {}
      check('★★ 编的 id（本会话没见过）→ **不带引用**', m.replyTo === undefined || m.replyTo === null, JSON.stringify(m))
      check('★ 正文照发（丢引用不等于丢回复）', String(m.text ?? '').includes('我记得是这个'))
      check('★ 日志里说清了为什么丢掉', logs.some((l) => l.includes('999999') && l.includes('不猜')),
        logs.filter((l) => l.includes('999999')).join('｜') || '（没有日志）')
    }

    // ── ⑩-3b ★ 负 id 也一样受白名单约束（放宽形状 ≠ 放宽校验）─────────────
    {
      const { bridge, sent } = makeBridge({ replies: ['我记得。[reply:#-999999]'] })
      await bridge.handleEvent(privateMsg(ADMIN, '什么来着', -111))
      const m = sent[0] ?? {}
      check('★★ 没见过的**负** id → 照样丢掉引用（只放宽形状，不放宽校验）',
        m.replyTo === undefined || m.replyTo === null, JSON.stringify(m))
    }

    // ── ⑩-4 表情：没配表 → 剥标记但不发；配了表 → 发到**最后一条**上 ────────
    {
      const { bridge, sent, logs } = makeBridge({ replies: ['好。[sticker:偷笑]'] })
      await bridge.handleEvent(privateMsg(ADMIN, '说个事', 1))
      const m = sent[0] ?? {}
      check('★ 没配表情表 → 不发脸（宁可不发，也不猜 id 发错表情）',
        m.faceId === undefined || m.faceId === null, JSON.stringify(m))
      check('★ 标记被剥掉（用户看不到 [sticker:…]）', !String(m.text ?? '').includes('[sticker'))
      check('★ 日志里说明了"没有对应的表情"',
        logs.some((l) => l.includes('sticker') && l.includes('没有对应的表情')),
        logs.filter((l) => l.includes('sticker')).join('｜') || '（没有日志）')
    }
    {
      const { bridge, sent } = makeBridge({ replies: ['好。[sticker:偷笑]'] })
      bridge.config.send.stickers = { 偷笑: 20 }
      await bridge.handleEvent(privateMsg(ADMIN, '说个事', 1))
      const m = sent[0] ?? {}
      check('★★ 配了表 → 真的带上了表情段（偷笑=20）', m.faceId === '20', JSON.stringify(m))
      check('★ 表情跟**最后一条**（读起来是"说完了再给个表情"）',
        sent.filter((s) => s.faceId).length === 1, JSON.stringify(sent.map((s) => s.faceId)))
    }

    // ── ⑩-5 只有表情、没有正文 → 发那条表情，而不是"没有输出文字"的兜底 ─────
    {
      const { bridge, sent } = makeBridge({ replies: ['[sticker:偷笑]'] })
      bridge.config.send.stickers = { 偷笑: 20 }
      await bridge.handleEvent(privateMsg(ADMIN, '在吗', 5))
      const withFace = sent.filter((s) => s.faceId === '20')
      check('★★ 只发表情也能发出去（不会被兜底话术顶掉）', withFace.length === 1, JSON.stringify(sent))
      check('★ 不带"（我执行了操作但没有输出文字…）"那种兜底',
        !sent.some((s) => String(s.text).includes('没有输出文字')), JSON.stringify(sent.map((s) => s.text)))
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑪ ★★ H9 断线缺口：要进模型上下文，而且**只说一次**
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑪ ★★ 断线缺口：带进下一轮提示词、用过即清、明说"不要猜"')
  {
    const { bridge, onebot, rpc } = makeBridge({ replies: ['好'] })
    bridge.attach(onebot)

    check('还没断线时提示词里没有缺口段', !String(rpc.prompts[0] ?? '').includes('断线'))

    // 模拟一次够长的断线（真实路径是 OneBotClient 在重连成功时派 `gap` 事件）
    onebot.dispatchEvent(new CustomEvent('gap', { detail: { ms: 42_000, since: Date.now() - 42_000 } }))
    await bridge.handleEvent(privateMsg(ADMIN, '在吗', 1))

    const first = String(rpc.prompts[0] ?? '')
    check('★★ 缺口进了提示词（否则模型会把掉线前后当成连续对话）',
      first.includes('断线') && first.includes('42 秒'), (first.match(/【刚才断线了】[^\n]*/) ?? ['(没有缺口段)'])[0])
    check('★★ 并且明说"这期间的消息收不到"+"不要猜"',
      first.includes('收不到') && first.includes('不要猜'))

    // 用过即清：下一轮不该再提
    await bridge.handleEvent(privateMsg(ADMIN, '再说一次', 2))
    const second = String(rpc.prompts[1] ?? '')
    check('★ **用过即清**：下一轮不再重复提"刚才掉线了"（隔轮再提只会让人莫名其妙）',
      !second.includes('断线'), (second.match(/【刚才断线了】[^\n]*/) ?? ['(没有，正确)'])[0])
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑫ ★★★ H10 对话走向：真的进提示词、与任务台账**两条轴并存**、话头活一轮
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑫ ★★★ 对话走向：进提示词、与任务台账并存、话头真的到得了模型眼前')
  {
    // ★ 这一节存在的理由：H10 的第一版接线里，`noteUser` 会把"悬着的话头"清掉，
    //   而 `noteUser` 跑在**拼提示词之前** —— 于是那句"先看他是不是在回答这个"
    //   在真机上**一次也渲染不出来**。纯函数测试看不见（它自己调 noteUser 再渲染），
    //   只有**走完整桥接 + 读 rpc.prompts**（模型真正收到的东西）才暴露。
    const { bridge, rpc } = makeBridge({
      replies: ['你要我读哪个文件？', '我读了 a.txt。', '嗯。'],
      toolsPerTurn: [
        [{ name: 'read', args: { file_path: 'a.txt' }, result: '文件内容' }],
        [],
        [],
      ],
    })

    await bridge.handleEvent(privateMsg(ADMIN, '帮我读一下 a.txt'))

    const first = String(rpc.prompts[0] ?? '')
    check('★ 第 1 轮还什么都没发生 → **一个字都不注入**（省 token，也不添噪音）',
      !first.includes('【对话走向'), (first.match(/【对话走向[^\n]*/) ?? ['(没有，正确)'])[0])

    await bridge.handleEvent(privateMsg(ADMIN, '就那个文件'))
    const second = String(rpc.prompts[1] ?? '')
    check('★★★ 第 2 轮的提示词里**真的有**会话走向段', second.includes('【对话走向'),
      second.includes('【对话走向') ? '' : `提示词 ${second.length} 字里没有它`)
    check('★★★ 上一轮那句问话真的到了模型眼前（这就是第一版接线丢掉的东西）',
      second.includes('你要我读哪个文件？') && second.includes('先看他是不是在回答这个'),
      (second.match(/你上一轮问了他[^\n]*/) ?? ['(没有话头行)'])[0])
    check('★★ 说清这是"对话走向"而**不是**任务台账（两条轴并存，别让模型当成一件事）',
      second.includes('不是任务台账'))
    check('★★ 两条轴**同时**在场：任务台账段与对话走向段都在（不是后者顶掉前者）',
      second.includes('【当前任务') && second.includes('【对话走向'))
    check('★★ 走向段落在**易变区**（来源标注之后），没跑进被缓存的前缀里',
      second.indexOf('【对话走向') > second.indexOf('[来自 QQ 私聊'),
      `走向@${second.indexOf('【对话走向')} / 来源标注@${second.indexOf('[来自 QQ 私聊')}`)
    check('★ 上一轮的动作也报了（这是"别重复同一类动作"的依据）',
      second.includes('你上一轮动了这些') && second.includes('读文件'),
      (second.match(/你上一轮动了[^\n]*/) ?? ['(没有动作行)'])[0])

    await bridge.handleEvent(privateMsg(ADMIN, '还有别的吗'))
    const third = String(rpc.prompts[2] ?? '')
    check('★ 来回数在涨，且报的是**来回**不是消息条数（3 条用户消息 = 第 3 个来回）',
      third.includes('第 3 个来回') && third.includes('对方说了 3 次') && third.includes('你回了 2 次'),
      (third.match(/这是第[^\n]*/) ?? ['(没有轮次行)'])[0])
    check('★ 话头**只用一轮**：上一轮回答不是问句 → 这一轮不再提"他在回答你上一轮问的"',
      !third.includes('先看他是不是在回答这个'), (third.match(/你上一轮问了他[^\n]*/) ?? ['(没有，正确)'])[0])
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑬ ★★ H3 使用侧车接线：走完整桥接后，"这轮注入了什么"要真的记下来
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑬ ★★ 使用侧车：桥接真的在记"这一轮注入了哪些记忆"')
  {
    const { bridge, WS } = makeBridge({ replies: ['好，我记下了。', '嗯。'] })

    // 先写一条记忆（走真实写入路径：桥接的关键词直写），它应被登记为"刚写下"
    await bridge.handleEvent(privateMsg(ADMIN, '记住：他喜欢冰美式'))

    const usagePath = join(WS, 'memory', '.usage.json')
    check('★ 写入侧登记了"刚写下"（否则新记忆会被 25 条注入上限挤掉且无人察觉）',
      existsSync(usagePath) && readIf(WS, 'memory/.usage.json')?.includes('writtenAt'),
      existsSync(usagePath) ? readIf(WS, 'memory/.usage.json').slice(0, 90) : '（文件不存在）')

    // 再来一轮 → 记忆被拼进提示词 → 应该记上 lastInjectedAt
    await bridge.handleEvent(privateMsg(ADMIN, '那现在呢'))
    const ledger = readIf(WS, 'memory/.usage.json') ?? ''
    check('★★★ 桥接在**真的拼完提示词之后**记了"被注入"（这是 H3 的接线，最容易漏的一环）',
      ledger.includes('lastInjectedAt') && ledger.includes('injectedCount'), ledger.slice(0, 120))
    check('★ 记的是"被注入"而不是"被用上"（字段名诚实：我们观测不到模型依赖了哪条）',
      !/lastUsed|usedCount/.test(ledger))
    check('★★ 账本里没有任何权重/强度字段（设计决策 D9：不做强度浮点衰减）',
      !/strength|weight|decay|priority/i.test(ledger))
    check('★ 开账时间也记了（没有它就没法区分"没数据"和"没被用过"）', ledger.includes('startedAt'))

    const parsed = JSON.parse(ledger)
    const keys = Object.keys(parsed.entries ?? {})
    check('★ 记下了具体条目（不只是"记了 N 条"这种数不清的账）', keys.length >= 1 &&
      Object.values(parsed.entries).some((e) => String(e.preview ?? '').includes('冰美式')),
      JSON.stringify(Object.values(parsed.entries).map((e) => e.preview)))
    check('★ 记下了是哪个会话看到的', Object.values(parsed.entries).some((e) => Array.isArray(e.chats) && e.chats.length > 0))
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑭ ★★ H11 人设名字表接线：别名要**真的能唤醒**
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑭ ★★ 人设里的别名真的能唤醒（否则那句"别人叫你小鱼也是在叫你"只是愿望）')
  {
    // 为什么这条断言必须走完整桥接：唤醒判定发生在**拼提示词之前**。
    // 桥接不认这个名字 → 那句话**根本进不了模型** → 人设里写多少遍都没用。
    // 纯函数测试只能证明"名字表解析得对"，证明不了"它接进了唤醒判定"。
    const { bridge, sent } = makeBridge({
      replies: ['嗯？', '在。'],
      access: { groupAllowlist: [GROUP] },
      // ★ 必须用一个**真的带名字表**的预设：第一版这里用的是默认的 `preset: 'none'`，
      //   于是"别名能唤醒"其实是靠 `parsePersonaNames` 的**兜底默认名**通过的，
      //   而断言里那句"人设里有名字表"当场变红 —— 前提没成立，结论就不算数。
      persona: { preset: 'mermaid' },
    })
    // 配置里的关键词只有正式名 —— 别名只可能来自人设的名字表
    bridge.config.trigger.keywords = ['小鲸鱼']
    bridge.wakeKeywords = mergeWakeKeywords(bridge.config.trigger.keywords, bridge.personaText)
    check('前提：人设文本里有名字表、且唤醒词里出现了别名',
      bridge.personaText.includes('别名:') && bridge.wakeKeywords.includes('小鱼'),
      (bridge.wakeKeywords ?? []).join(' / '))

    await bridge.handleEvent(groupMsg(GROUP, NON_ADMIN, '小鱼在吗'))
    check('★★ 群里没 @ 它、关键词也不匹配，但**叫别名**就唤醒了',
      sent.length >= 1, sent.length ? String(sent[0].text) : '（没有回复 = 没唤醒）')

    const before = sent.length
    await bridge.handleEvent(groupMsg(GROUP, NON_ADMIN, '今天天气不错'))
    check('★ 反例：不相干的话**仍然不唤醒**（别名不是把闸门整个打开）',
      sent.length === before, `多了 ${sent.length - before} 条回复`)
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑮ ★★ H17 交付语义：**"模型没产出"与"发送失败"是两种失败**
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑮ ★★ 交付语义：发送失败**不重发、更不重跑模型**；模型没产出不重跑')
  {
    // ★ 为什么要把这件事写成断言：这两种失败在代码里长得像（"用户没收到回复"），
    //   但处置完全相反 —— 把它们混起来最典型的后果是**重复回复**：
    //   发送其实成功了但回执丢了，于是重跑一次模型，对方收到两条口径不同的答案。
    //   所以下面每条都同时断言"用户看到什么"和"模型被调了几次"。

    // ── ① 发送失败：不重跑模型、不自动重发、必须留痕 ─────────────────────
    {
      const { bridge, rpc, sent, logs } = makeBridge({ replies: ['第一句回复。'] })
      let attempts = 0
      bridge.onebot.send = async (kind, peerId, text, opts) => {
        attempts += 1
        sent.push({ kind, peerId, text, ...(opts ?? {}) })
        throw new Error('发送炸了（测试构造）')
      }
      const r = await bridge.handleEvent(privateMsg(ADMIN, '你好'))
      check('★★★ 发送失败时**模型只被调用一次**（绝不重跑 —— 重跑会再花一次模型调用，还可能给出不同答案）',
        rpc.prompts.length === 1, `rpc.prompts=${rpc.prompts.length}`)
      // ★ 判据要精确：正文只尝试发**一次**。失败后那次 `#safeSend` 会再调一次 send
      //   （那是"尽力告知"，内容不同）—— 第一版把它算成"重发"，断言就是这么写歪的。
      const answerAttempts = sent.filter((s) => String(s.text).includes('第一句回复')).length
      const noticeAttempts = sent.filter((s) => String(s.text).includes('请再发一次')).length
      check('★★★ **正文只尝试发一次**：不自动重发（分片可能已经发出去一半，重发会让对方看到重复内容）',
        answerAttempts === 1 && noticeAttempts <= 1, `正文 ${answerAttempts} 次 / 告知 ${noticeAttempts} 次`)
      check('★ 失败要留痕：日志里写明"没发出去"且说明不重发、不重跑',
        logs.some((l) => l.includes('回复没能发出去') && l.includes('不重发')), 
        logs.filter((l) => l.includes('发出去')).join('｜') || '（没有日志）')
      check('★ 尽力告知对方（同一条通道，失败也无妨，但要有这句尝试）',
        sent.some((s) => String(s.text).includes('请再发一次')), JSON.stringify(sent.map((s) => s.text)))
      check('★ 处理结果如实标成 send-failed（不是伪装成"已回复"）',
        r?.handled === false && r?.reason === 'send-failed', JSON.stringify(r && { handled: r.handled, reason: r.reason }))
    }

    // ── ② 模型没产出：给兜底话术，但**不重跑模型** ────────────────────────
    {
      const { bridge, rpc, sent } = makeBridge({ replies: [''] })
      await bridge.handleEvent(privateMsg(ADMIN, '在吗'))
      check('★ 空回复 → 发兜底话术（不能让对方对着空气等）',
        sent.length === 1 && /没有产生回复内容|再试一次|再问一次/.test(String(sent[0].text)),
        JSON.stringify(sent.map((s) => s.text)))
      check('★★ 而且**不重跑模型**（同一轮不做第二次采样：成本翻倍，且两条答案可能互相矛盾）',
        rpc.prompts.length === 1, `rpc.prompts=${rpc.prompts.length}`)
    }

    // ── ③ 超时：告知，不重跑 ─────────────────────────────────────────────
    {
      const { bridge, rpc, sent } = makeBridge({ replies: ['慢死了。'], endDelays: [3000], turnTimeoutMs: 120 })
      await bridge.handleEvent(privateMsg(ADMIN, '在吗'))
      check('★ 超时 → 告知"请再发一次"，且**不重跑模型**',
        rpc.prompts.length === 1 && sent.some((s) => String(s.text).includes('超时')),
        `rpc.prompts=${rpc.prompts.length} / ${JSON.stringify(sent.map((s) => s.text))}`)
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑯ ★★ H15 投递账本：**发送前落账**、失败标失败、启动时报别人的烂账
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑯ ★★ 投递账本：落账在发送**之前**（真机上丢过一整条回复）')
  {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const ledgerRows = (ws) => {
      const raw = readIf(ws, 'runtime/delivery-ledger.json')
      return raw ? JSON.parse(raw).rows ?? [] : []
    }

    // ── ① 落账在发送之前：把 send 挂住，此刻账本里就该有 pending ──────────
    {
      const { bridge, WS, sent } = makeBridge({ replies: ['一条正常的回复。'] })
      let release = null
      bridge.onebot.send = async (kind, peerId, text, opts) => {
        sent.push({ kind, peerId, text, ...(opts ?? {}) })
        await new Promise((r) => {
          release = r
        })
      }
      const running = bridge.handleEvent(privateMsg(ADMIN, '在吗'))
      // 等它走到"正在发送"（挂住的那一步）
      for (let i = 0; i < 60 && !release; i += 1) await sleep(10)
      const during = ledgerRows(WS)
      check('★★★ 发送**还在进行中**时，账本里已经有 pending 记录（这就是"发送前落账"）',
        during.length === 1 && during[0].state === 'pending' && during[0].chunks[0].sent === false,
        JSON.stringify(during.map((r) => ({ s: r.state, sent: r.chunks?.[0]?.sent }))))
      check('  记下了"给谁"（会话键）', during[0]?.chatKey === `private:${ADMIN}`, during[0]?.chatKey)
      release?.()
      await running
      const after = ledgerRows(WS)
      check('★ 发完之后 → done，且那一片标成已发送（崩溃时留下的就是"没标上"的那些）',
        after[0]?.state === 'done' && after[0]?.chunks[0].sent === true,
        JSON.stringify({ s: after[0]?.state, sent: after[0]?.chunks?.[0]?.sent }))
    }

    // ── ② 发送失败 → failed（与"崩溃留下的 pending"要能分开看）────────────
    {
      const { bridge, WS } = makeBridge({ replies: ['发不出去的回复。'] })
      bridge.onebot.send = async () => {
        throw new Error('协议端拒了（测试构造）')
      }
      await bridge.handleEvent(privateMsg(ADMIN, '在吗'))
      const rows = ledgerRows(WS)
      check('★ 发送失败 → 账本标 failed 并带原因（不是留下一个说不清的 pending）',
        rows[0]?.state === 'failed' && String(rows[0]?.why).includes('拒了'),
        JSON.stringify({ s: rows[0]?.state, why: rows[0]?.why }))
    }

    // ── ③ 启动时把**别人**留下的烂账报出来（真机上当时没有任何提示）────────
    {
      const { bridge, WS, logs } = makeBridge({ replies: ['好。'] })
      // 造一条"上一次运行"留下的 pending（owner 与本次不同）
      const { beginDelivery } = await import('../src/delivery-ledger.mjs')
      beginDelivery({
        workspace: WS,
        owner: '99999@1',
        chatKey: `private:${ADMIN}`,
        kind: 'private',
        peerId: ADMIN,
        chunks: ['上一次没发完的那句话'],
        at: Date.now() - 60_000,
      })
      // 重新 attach（等价于下一次启动）
      const fresh = makeBridge({ replies: ['好。'] })
      fresh.bridge.config.dsh.workspace = WS
      fresh.bridge.attach(fresh.onebot)
      check('★★★ 启动时**主动报出**上一次没发完的投递（否则这件事只有想到了才会去查）',
        fresh.logs.some((l) => l.includes('没确认发完')), fresh.logs.filter((l) => l.includes('发完')).join('｜') || '（没有日志）')
      check('★★ 并且明说**不会自动重发**（重复回复比漏一条更糟）',
        fresh.logs.some((l) => l.includes('不会自动重发')))
      check('★ 报了是哪一条（会话 + 预览），不是一句"有东西没发完"',
        fresh.logs.some((l) => l.includes(`private:${ADMIN}`) && l.includes('没发完的那句话')),
        fresh.logs.filter((l) => l.includes('private:')).join('｜') || '（没有）')
      void bridge
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑰ ★★★ 提示词**段的顺序快照**（拆 bridge.mjs 的安全网，H16 的前置条件）
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑰ ★★★ 提示词段顺序快照：拆 `bridge.mjs` 之前必须先有这张网')
  {
    // ★★ 为什么要有这一节（它不是为了"多一条断言"）：
    //   计划里 H16 有一项是**拆 `bridge.mjs`**（`#buildPrompt` 那几百行）。
    //   我把它推迟了，理由是：**离线测试只能证明"行为不变"，证明不了"段顺序没搬错"** ——
    //   而段顺序恰恰同时决定两件事：
    //     ① **前缀缓存**（稳定段必须在前、易变段必须在后，实测命中 91%~96%）；
    //     ② **注入语义**（"记忆"必须在"任务"之前、"来源标注"必须在最后）。
    //   所以拆之前必须先有这张网：把一次真实拼装的提示词**按段切出来**，
    //   断言段的**存在**与**相对顺序**。搬错顺序时它会红，而普通的断言不会。
    //
    // ⚠️ 这里刻意**不**断言段的正文（正文会随版本调整，硬编码会天天红）；
    //    只钉"有哪些段、谁在前谁在后"，外加几个必须存在的关键串。
    const { bridge, rpc } = makeBridge({
      replies: ['好的。', '还有别的事吗？', '嗯。'],
      toolsPerTurn: [[{ name: 'read', args: { file_path: 'a.txt' }, result: '内容' }], [], []],
      persona: { preset: 'mermaid' },
    })
    // 让配方段也有东西（配方段在任务段之后）
    const { upsertRecipe } = await import('../src/recipes.mjs')
    upsertRecipe({
      workspace: bridge.config.dsh.workspace,
      source: 'auto',
      recipe: { title: '读文件先看目录', trigger: { keywords: ['帮我读一下这个文件'] }, steps: ['先 glob 再读'] },
    })

    await bridge.handleEvent(privateMsg(ADMIN, '帮我读一下 a.txt'))
    await bridge.handleEvent(privateMsg(ADMIN, '那现在呢'))
    await bridge.handleEvent(privateMsg(ADMIN, '帮我读一下这个文件'))

    // 第 3 轮的提示词里：记忆段 / 任务段 / 配方段 / 对话走向 / 来源标注 **应该都在**
    const prompt = String(rpc.prompts[2] ?? '')
    const MARKS = [
      ['长期记忆', /长期记忆|记忆/],
      ['当前任务', /【当前任务/],
      ['可套用的做法', /可套用的做法/],
      ['对话走向', /【对话走向/],
      ['来源标注', /\[来自 QQ (私聊|群)/],
    ]
    const found = MARKS.map(([label, re]) => ({ label, at: prompt.search(re) })).filter((x) => x.at >= 0)
    const at = (label) => found.find((f) => f.label === label)?.at ?? -1
    check('★ 关键段都在这份提示词里（快照的前提）', found.length >= 4,
      found.map((f) => f.label).join(' / '))

    // ★★ 真实的顺序（第一版断言我**写错了**，被这条测试当场纠正）：
    //    稳定段（记忆 → 任务 → 配方）→ **来源标注**（带 messageId，易变）→ **对话走向**。
    //    也就是说：**走向段在正文之后**。这不是笔误，是刻意的 ——
    //    末尾的指令更容易被遵循（"别重复同一类动作""先看他是不是在回答这个"都是**指令**），
    //    而来源标注必须紧跟正文之前（它是这一轮消息的元信息）。
    //    ⚠️ 我原本以为"所有易变段都在来源标注之后"，实测才发现走向段确实在它之后、
    //       而来源标注在正文之前 —— 这正是**先写快照、再动结构**的意义。
    check('★★ 稳定段全都在易变段之前（记忆 < 任务 < 配方 < 来源标注）',
      at('长期记忆') < at('当前任务') && at('当前任务') < at('可套用的做法') &&
        at('可套用的做法') < at('来源标注'),
      `记忆@${at('长期记忆')} → 任务@${at('当前任务')} → 配方@${at('可套用的做法')} → 来源标注@${at('来源标注')}`)
    check('★★★ 易变段都在末尾（来源标注之后不许再有稳定段 —— 顺序反了会打断前缀缓存）',
      at('来源标注') > Math.max(at('长期记忆'), at('当前任务'), at('可套用的做法')),
      `来源标注@${at('来源标注')}`)
    check('★ 对话走向在来源标注**之后**（末尾指令更容易被遵循 —— 这条是有意的，不是搬错）',
      at('对话走向') > at('来源标注'),
      `来源标注@${at('来源标注')} → 走向@${at('对话走向')}`)
    check('★ 各段只用一次（搬代码时最容易出现"某段被拼了两遍"）',
      (prompt.match(/【当前任务/g) ?? []).length <= 1 && (prompt.match(/【对话走向/g) ?? []).length <= 1,
      `任务段×${(prompt.match(/【当前任务/g) ?? []).length} / 走向段×${(prompt.match(/【对话走向/g) ?? []).length}`)
    check('★ 快照能报出位置指纹，便于人工比对', found.length > 0,
      found.map((f) => `${f.label}@${f.at}`).join(' → '))
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ⑱ ★★★ 提示词**逐字基线**（拆 `bridge.mjs` 的验收标准）
   * ══════════════════════════════════════════════════════════════════════ */
  section('⑱ ★★★ 提示词逐字基线：搬代码之后必须一个字都没变')
  {
    // ★★ 这一节是"重构的验收标准"，不是"又一条断言"。
    //    把一段拼装逻辑从一个文件搬到另一个文件，**离线测试只能证明行为不变**；
    //    而"行为不变"最强、最省事的证明就是：**同一份输入产出的提示词逐字相同**。
    //    所以这里把一份固定场景下的提示词（去掉时间戳与消息 id 这类每轮都不同的部分）
    //    与 `mocks/fixtures/prompt-golden.txt` 对比。
    //
    // 用法：
    //   · 基线不存在时 → **生成它**并提示去检查（首跑不判失败，避免"基线没建就红"）
    //   · 基线存在时   → 逐字比对；不一致就打印第一处差异的上下文
    const FIXTURE = join(PKG_ROOT_FOR_FIXTURE, 'mocks', 'fixtures', 'prompt-golden.txt')
    const norm = (s) =>
      String(s)
        .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, '<TS>') // 时间戳
        .replace(/#-?\d+/g, '#<ID>') // 消息 id（每轮不同）
        .replace(/\d{4}-\d{2}-\d{2}/g, '<DATE>')

    const { bridge, rpc } = makeBridge({
      replies: ['好的。', '还有别的事吗？', '嗯。'],
      toolsPerTurn: [[{ name: 'read', args: { file_path: 'a.txt' }, result: '内容' }], [], []],
      persona: { preset: 'mermaid' },
    })
    const { upsertRecipe } = await import('../src/recipes.mjs')
    upsertRecipe({
      workspace: bridge.config.dsh.workspace,
      source: 'auto',
      recipe: { title: '读文件先看目录', trigger: { keywords: ['帮我读一下这个文件'] }, steps: ['先 glob 再读'] },
    })
    await bridge.handleEvent(privateMsg(ADMIN, '帮我读一下 a.txt'))
    await bridge.handleEvent(privateMsg(ADMIN, '那现在呢'))
    await bridge.handleEvent(privateMsg(ADMIN, '帮我读一下这个文件'))

    const golden = norm(String(rpc.prompts[2] ?? ''))
    if (!existsSync(FIXTURE)) {
      mkdirSync(dirname(FIXTURE), { recursive: true })
      writeFileSync(FIXTURE, golden, 'utf8')
      check('★ 基线不存在 → 已生成（请人工检查这份基线是否合理，然后重跑）', true, FIXTURE)
    } else {
      const want = norm(readFileSync(FIXTURE, 'utf8'))
      const same = want === golden
      check('★★★ 提示词与基线**逐字相同**（搬动拼装逻辑之后必须仍然相同）', same,
        same ? `${golden.length} 字` : (() => {
          const i = [...want].findIndex((c, k) => c !== golden[k])
          return `第一处差异在第 ${i} 字：基线「${want.slice(Math.max(0, i - 30), i + 30)}」 vs 现在「${golden.slice(Math.max(0, i - 30), i + 30)}」`
        })())
      // 顺便钉住体量：段被漏拼时长度会明显变化（比"逐字比"更快指向问题）
      check('  长度也在同一量级（±2%）', Math.abs(golden.length - want.length) / Math.max(1, want.length) < 0.02,
        `基线 ${want.length} / 现在 ${golden.length}`)
    }
  }

  // 收尾：**先关掉每个 Bridge**，再删临时目录。
  // ⚠️ 为什么必须显式关：H7 之后每个 Bridge 都会在工作区里开一个 SQLite
  //    （`runtime/corpus.sqlite`）并**持有句柄到进程退出** —— 不关就删目录，
  //    Windows 会报 EPERM（实测一次跑完留下 22 个删不掉的临时目录 + 一屏警告）。
  for (const b of liveBridges) {
    try {
      await b.close(0)
    } catch {
      /* 收尾失败不影响断言结果 */
    }
  }
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      console.log(`⚠️ 临时目录清理失败（无害，句柄回收延迟）：${error?.code ?? error?.message}`)
    }
  }

  console.log('')
  if (failures === 0) {
    console.log('✅ 记忆全链路通过：提议 → 落盘 → 剥离 → 回执 → 下一轮注入都真的发生了')
    console.log('   ⚠️ 这只证明**机制**是通的；"模型会不会主动提议记忆"是模型行为，')
    console.log('      要用真实会话观察（见 docs/memory-verification.md）。')
    process.exit(0)
  }
  console.log(`❌ 有 ${failures} 条断言失败`)
  process.exit(1)
}

main().catch((error) => {
  console.error('验证脚本自身崩了：', error)
  process.exit(1)
})
