/**
 * QQ 工具（MCP）**纯逻辑**测试（H14）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么与 `verify-mcp.mjs` 分开
 * ══════════════════════════════════════════════════════════════════════════
 * `verify-mcp.mjs` spawn 真的服务器进程 + 走 stdio 协议 —— 那是最接近生产的验证，
 * 但它**需要能起带管道的子进程**，受限沙箱里会整份跳过（**跳过不算通过**）。
 * 于是工具定义、提示拼接、参数构造这些**纯逻辑**在那些环境里从来没有被测过。
 *
 * 这一套不需要子进程：直接 `import` 服务器模块（生产路径是脚本方式拉起，
 * 与 import 互不影响，见文件末尾那个 `invokedDirectly` 判断）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套盯的三件事
 * ══════════════════════════════════════════════════════════════════════════
 * ① **动作名必须是真的**：H14 新增的每个具名工具都对应一个真实 OneBot 动作名，
 *    而动作名各协议端不一样。这次是**用真机探针**（`mocks/probe-onebot-actions.mjs`）
 *    先确认再写的 —— 猜错的后果是"工具在模型那里存在、一调就失败"。
 * ② **权限提示不能漏**：每个工具的描述里都必须有权限提示 + "如实"提示，
 *    而且**写入类与只读类要分开**（普通用户是只读的，工具本身不区分调用者）。
 * ③ **本地工具必须 fail-closed**：`qq_search_history` / `qq_forward_log` 都要
 *    `kind` + `peerId` 才能跑 —— 缺了就拒绝，绝不"默认搜全部"
 *    （那等于把别的群/别人的私聊读进当前上下文，或打包发给第三方）。
 *
 * 用法：node mocks/verify-mcp-tools.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TOOLS, BLOCKED_ACTIONS, described, runTool, __setConfig } from '../mcp/mcp-qq-server.mjs'

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

const byName = (n) => TOOLS.find((t) => t.name === n)

// ══════════════════════════════════════════════════════════════════════════
section('① H14 新增工具：都在，且动作名是**真机探针验过的**')
// ══════════════════════════════════════════════════════════════════════════
{
  const expected = {
    qq_emoji_like: 'set_msg_emoji_like',
    qq_typing: 'set_input_status',
    qq_forward_msg: 'forward_friend_single_msg', // 私聊分支
    qq_at_all_remain: 'get_group_at_all_remain',
  }
  for (const [name, action] of Object.entries(expected)) {
    check(`包含 ${name}`, Boolean(byName(name)))
  }
  check('★ qq_emoji_like → set_msg_emoji_like（真机探针：空参时它要 message_id，说明动作存在）',
    byName('qq_emoji_like')?.build({ messageId: '123' })?.action === 'set_msg_emoji_like')
  check('  默认表情是点赞（不填 emojiId 也有确定行为）',
    byName('qq_emoji_like')?.build({ messageId: '123' })?.params?.emoji_id === '128077')
  check('  显式给了 emojiId 就用它', byName('qq_emoji_like')?.build({ messageId: '1', emojiId: '4' })?.params?.emoji_id === '4')
  check('★ qq_typing → set_input_status，event_type 默认 1（正在输入）',
    byName('qq_typing')?.build({ peerId: '999' })?.action === 'set_input_status' &&
      byName('qq_typing')?.build({ peerId: '999' })?.params?.event_type === 1)
  check('★ qq_at_all_remain → get_group_at_all_remain',
    byName('qq_at_all_remain')?.build({ groupId: '700000001' })?.action === 'get_group_at_all_remain')

  // 转发：私聊与群走**两个不同的动作**（真机探针确认两个都存在）
  check('★ qq_forward_msg 私聊分支 → forward_friend_single_msg + user_id',
    byName('qq_forward_msg')?.build({ messageId: '5', toId: '999', toKind: 'private' })?.action ===
      'forward_friend_single_msg' &&
      byName('qq_forward_msg')?.build({ messageId: '5', toId: '999', toKind: 'private' })?.params?.user_id === 999)
  check('★ qq_forward_msg 群分支 → forward_group_single_msg + group_id',
    byName('qq_forward_msg')?.build({ messageId: '5', toId: '700000001', toKind: 'group' })?.action ===
      'forward_group_single_msg' &&
      byName('qq_forward_msg')?.build({ messageId: '5', toId: '700000001', toKind: 'group' })?.params?.group_id === 700000001)

  check('★ 转发的"补充一句话"是**第二步**（转发原文 + 我自己说一句，两件事分开）',
    byName('qq_forward_msg')?.followUp({ toId: '999', toKind: 'private', note: '你看这个' })?.action ===
      'send_private_msg')
  check('  没给 note → 没有第二步（不会白发一条空消息）',
    byName('qq_forward_msg')?.followUp({ toId: '999', toKind: 'private' }) === null)
  check('  note 只有空白 → 也当没给', byName('qq_forward_msg')?.followUp({ toId: '999', toKind: 'private', note: '   ' }) === null)

  check('★ qq_forward_log 走本地语料库（不经 OneBot 那条 build 路）',
    byName('qq_forward_log')?.local === 'forwardLog')
}

// ══════════════════════════════════════════════════════════════════════════
section('② 权限提示：**每个**工具都要有，且写入类与只读类分开')
// ══════════════════════════════════════════════════════════════════════════
{
  const WRITE_HINT = '只有管理员可以让我做'
  const READ_HINT = '只读动作，普通用户也可以用'
  const HONESTY = '没做成'
  for (const t of TOOLS) {
    const d = described(t)
    const isWrite = d.includes(WRITE_HINT)
    const isRead = d.includes(READ_HINT)
    check(`${t.name}：权限提示恰好一种`, isWrite !== isRead, isWrite ? '写入类' : isRead ? '只读类' : '（没有！）')
    check(`${t.name}：带"如实"提示`, d.includes(HONESTY))
  }
  check('★ 写入类与只读类的**判据是数据**（adminOnly），不是靠名字猜',
    TOOLS.every((t) => typeof t.adminOnly === 'boolean'))
  check('★ 只读工具不被误标成写入（否则模型会拒绝普通用户的正常提问）',
    ['qq_group_members', 'qq_message_detail', 'qq_group_history', 'qq_search_history', 'qq_typing', 'qq_at_all_remain']
      .every((n) => byName(n)?.adminOnly === false))
  check('★★ 写入类都被标成 adminOnly（`qq_api` 是万能口，必须算写入侧）',
    ['qq_poke', 'qq_send_sticker', 'qq_recall', 'qq_emoji_like', 'qq_forward_msg', 'qq_forward_log', 'qq_api']
      .every((n) => byName(n)?.adminOnly === true))
  check('★ 提示是**拼上去的**（列表里也带着），不是只写在源码注释里',
    described(byName('qq_api')).split('\n').length >= 2)
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 本地工具 fail-closed：缺会话就拒绝，绝不"默认搜全部"')
// ══════════════════════════════════════════════════════════════════════════
{
  __setConfig({ httpUrl: 'http://127.0.0.1:9', workspace: '/tmp/不存在的工作区', selfId: '1' })
  const cases = [
    ['qq_search_history 缺 kind/peerId', 'qq_search_history', { query: '茶' }],
    ['qq_search_history 缺 query', 'qq_search_history', { query: '', kind: 'private', peerId: '1' }],
    ['qq_search_history kind 不合法', 'qq_search_history', { query: '茶', kind: 'all', peerId: '1' }],
    ['qq_forward_log 缺 kind/peerId', 'qq_forward_log', { query: '茶', toId: '1', toKind: 'private' }],
    ['qq_forward_log 缺目标', 'qq_forward_log', { query: '茶', kind: 'private', peerId: '1' }],
  ]
  for (const [label, tool, args] of cases) {
    const r = await runTool(tool, args)
    check(`★ 拒绝执行：${label}`, r.isError === true, String(r.text).slice(0, 60))
  }
  check('★ 拒绝的理由说清了"不能跨会话"（模型据此知道该怎么办，而不是以为工具坏了）',
    /跨会话|必须指定会话|本会话/.test((await runTool('qq_search_history', { query: '茶' })).text))
  check('  也没有把工作区缺失与参数缺失搞混（两条不同的提示）',
    (await runTool('qq_forward_log', { query: '茶', toId: '1', toKind: 'private' })).text.includes('本会话'))
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 黑名单没有因为新增工具而变松')
// ══════════════════════════════════════════════════════════════════════════
{
  check('★★ 危险动作仍然在名单里（新增工具不该动它）',
    ['set_group_kick', 'set_group_ban', 'delete_friend', 'set_group_leave', 'set_qq_profile']
      .every((a) => typeof BLOCKED_ACTIONS[a] === 'string'))
  check('★★ 新动作**不在**黑名单里，但也不是危险动作（转发/贴表情/@次数都是社交动作）',
    ['set_msg_emoji_like', 'set_input_status', 'forward_friend_single_msg', 'forward_group_single_msg',
     'send_forward_msg', 'get_group_at_all_remain'].every((a) => !BLOCKED_ACTIONS[a]))
  check('  名单项数没减少（15 项以上）', Object.keys(BLOCKED_ACTIONS).length >= 15, `${Object.keys(BLOCKED_ACTIONS).length} 项`)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ qq_api 的**白名单**（2026-09-27 修的漏洞）与暴露档位')
// ══════════════════════════════════════════════════════════════════════════
{
  // 这一节盯的是实测漏洞：`get_cookies` 与 `upload_group_file` 曾经**在描述里被广告给模型**、
  // 却**都不在黑名单里**。对具名工具黑名单够用（动作写死），但 `qq_api` 的 action 是
  // **模型自选的任意字符串** —— 黑名单天然只拦得住"想得到的"。现在改成 fail-closed 白名单。
  // 下面每条都指向一个"曾经会漏过去"的具体动作。
  __setConfig({ httpUrl: 'http://127.0.0.1:9', selfId: '1' })

  const gated = (r) => /不在允许清单/.test(String(r.text))

  for (const action of [
    'get_cookies',        // ← 实测漏网：账号网页凭据
    'upload_group_file',  // ← 实测漏网：把本机文件外发
    'send_group_msg',     // ← 发送类：会绕过桥接的分条/节奏/节流/投递前终检门
    'send_private_msg',
    'delete_msg',
    'set_group_card',
  ]) {
    const r = await runTool('qq_api', { action })
    check(`★ 白名单拒绝：${action}`, gated(r), String(r.text).split('\n')[0].slice(0, 56))
  }

  const allowed = await runTool('qq_api', { action: 'get_group_list' })
  check('★ 白名单内的只读动作**放行到网络层**（这里连不上是预期的，但不能是"被清单拒绝"）', !gated(allowed))

  check('工具总数没变（这次改动只加闸门、不增删工具）', TOOLS.length === 14, `${TOOLS.length} 个`)
  check('★ qq_api 被标记为万能口（闸门靠这个标记判断，不靠名字猜）', byName('qq_api')?.generic === true)

  // 档位：被隐藏的工具**即使被直接调用也要拒** —— 只过滤 tools/list 是不够的
  __setConfig({ httpUrl: 'http://127.0.0.1:9', selfId: '1', genericApi: false })
  check('★★ genericApi=false：直接调用 qq_api 也被拒（fail-closed，不只是从列表里藏掉）',
    /当前档位下不可用/.test(String((await runTool('qq_api', { action: 'get_group_list' })).text)))

  __setConfig({ httpUrl: 'http://127.0.0.1:9', selfId: '1', profile: 'readonly' })
  check('★★ profile=readonly：写入/互动类被拒（qq_poke 是 adminOnly）',
    /当前档位下不可用/.test(String((await runTool('qq_poke', { peerId: '1' })).text)))
  check('★ profile=readonly：只读工具**仍然放行**（不能把只读也一起挡了）',
    !/当前档位下不可用/.test(String((await runTool('qq_group_members', { groupId: '1' })).text)))

  __setConfig({ httpUrl: 'http://127.0.0.1:9', selfId: '1' }) // 还原，免得影响后续断言
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ 本地语料库开关（0.2.3）：关掉时两个入口**当场拒绝**，而且不许说"搜不到"')
// ══════════════════════════════════════════════════════════════════════════
//
// 这一节盯的是**fail-closed 的方向**：
//   · 关掉之后必须回"**被关掉了**"。回"没搜到"会被模型转述成"语料库里没有这条记录"
//     —— 那是一句**谎话**（本项目最忌讳的"说了做不到"）。
//   · `readLiveConfig()` 每调用现读 config.json ⇒ 这个开关是真正的"随时开关"。
{
  const dir = mkdtempSync(join(tmpdir(), 'qq-bridge-mcptools-'))
  const cfgPath = join(dir, 'config.json')
  const point = (body) => {
    writeFileSync(cfgPath, JSON.stringify(body), 'utf8')
    return { httpUrl: 'http://127.0.0.1:9', workspace: dir, selfId: '1', configPath: cfgPath }
  }
  try {
    __setConfig(point({ corpus: { enabled: false } }))
    const entries = [
      ['qq_search_history', { query: '茶', kind: 'private', peerId: '1' }],
      ['qq_forward_log', { query: '茶', kind: 'private', peerId: '1', toId: '1', toKind: 'private' }],
    ]
    for (const [tool, args] of entries) {
      const r = await runTool(tool, args)
      check(`★★ ${tool} 在 corpus.enabled=false 时当场拒绝`, r.isError === true && /被关掉了/.test(String(r.text)), String(r.text).slice(0, 50))
      check('  └ 并且明说"不要凭印象编 / 不要说没有这条记录"（挡住那句谎话）',
        /不要凭印象编|没有这条记录/.test(String(r.text)))
    }

    // 打开时不该再被这个开关拦（会走到真正的检索：这个临时工作区里还没有库）
    __setConfig(point({ corpus: { enabled: true } }))
    const on = await runTool('qq_search_history', { query: '茶', kind: 'private', peerId: '1' })
    check('★ 打开时不再被开关拦（放行到真正的检索那一步）', !/被关掉了/.test(String(on.text)), String(on.text).slice(0, 60))

    // 读不到配置 ⇒ 按"开着"处理。方向与发图那边的保守**相反**，理由是这里只读：
    // 误判成"关"会让模型平白说一句"我搜不了"，误判成"开"最多是照常查一次本地库。
    __setConfig({ httpUrl: 'http://127.0.0.1:9', workspace: dir, selfId: '1', configPath: join(dir, '不存在.json') })
    const unknown = await runTool('qq_search_history', { query: '茶', kind: 'private', peerId: '1' })
    check('★ 配置读不到 ⇒ 按"开着"处理（只读工具；误判成关会让模型说假话）',
      !/被关掉了/.test(String(unknown.text)), String(unknown.text).slice(0, 60))
  } finally {
    __setConfig({ httpUrl: 'http://127.0.0.1:9', selfId: '1' })
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('')
if (failed === 0) {
  console.log(`🎉 QQ 工具纯逻辑测试全部通过（${passed} 项）`)
  console.log('   ⚠️ 这一套**不 spawn 子进程**：协议帧、stdio 行为由 verify-mcp.mjs 覆盖')
  console.log('      （受限沙箱里那套会跳过，所以两套必须都在链条里）。')
  process.exit(0)
}
console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
process.exit(1)
