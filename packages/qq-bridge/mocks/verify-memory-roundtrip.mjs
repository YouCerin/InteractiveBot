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

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Bridge } from '../src/bridge.mjs'
import { SendQueue } from '../src/onebot.mjs'
import { SessionRouter } from '../src/session-bridge.mjs'

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
function makeBridge({ replies = [], access = {}, memoryEnabled = true } = {}) {
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
    turn: { timeoutMs: 5000 },
    humanize: { enabled: false, chunkChars: 300 },
    persona: { preset: 'none' },
    memory: { enabled: memoryEnabled },
    image: { enabled: false },
  }

  let turn = 0
  const rpc = new EventTarget()
  rpc.prompts = []
  rpc.prompt = async (sessionId, contentBlocks) => {
    rpc.prompts.push(String(contentBlocks?.[0]?.text ?? ''))
    const text = replies[turn] ?? replies[replies.length - 1] ?? '好的'
    turn += 1
    router.handleEvent(sessionId, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text }] } },
    })
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
  onebot.send = async (kind, peerId, text) => sent.push({ kind, peerId, text })

  const sendQueue = new SendQueue({ ...config.send, log })
  const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, log })
  return { bridge, rpc, onebot, sent, logs, config, WS }
}

const privateMsg = (userId, text) => ({
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  user_id: userId,
  self_id: '200000001',
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
      prompt2.includes('上一条消息的记忆回执') && /已记下\s*1\s*条/.test(prompt2),
      (prompt2.match(/【上一条消息的记忆回执】[^\n]*\n?[^\n]*/) ?? [''])[0])
    check('★ 回执是"读后即删"的：第三轮不该再看到它',
      !readIf(WS, `memory/.receipts/private-${ADMIN}.txt`),
      '（文件还在 = 没被消费）')

    // ── ①-5 注入的文本里**不能有文件路径**（会破坏前缀缓存）──────────────
    check('★★ 注入的记忆文本里不含文件路径（实测缓存命中率 91%~96% 靠这个）',
      !/memory\/private-|\.md/.test(prompt2))
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

  // 收尾
  for (const dir of created) rmSync(dir, { recursive: true, force: true })

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
