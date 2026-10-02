#!/usr/bin/env node
/**
 * **双态对话风格**（闲聊态 / 工作态）校验。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么单独一套（而不是塞进 verify-units）
 * ══════════════════════════════════════════════════════════════════════════
 * 这个功能有一半的价值在**接线**上，而接线恰恰是本项目最贵的一类缺陷
 * （"任务段在真机上从未注入过"、"先应一声配了话术却不生效"都是接线断了）。
 * 所以这里既测纯函数，也**走完整桥接**断言提示词里真的出现了闲聊风格。
 *
 * 三块：
 *   ① 分类器（`chat-mode.mjs`）：用户给的四条原话逐条钉住 + 边界 + "规则命中不花钱"；
 *   ② 风格文件（`styles.mjs`）：读得到/读不到/空文件/超长，以及"回落必须留痕"；
 *   ③ 端到端接线：闲聊态消息 → 提示词里真有风格 + 「先应一声」不发；
 *      工作态消息 → 提示词**逐字不变**（这是"工作态 = 升级前行为"的可验证形式）。
 *
 * 用法：node mocks/verify-chat-mode.mjs
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Bridge } from '../src/bridge.mjs'
import { SendQueue } from '../src/onebot.mjs'
import { SessionRouter } from '../src/session-bridge.mjs'
import {
  DEFAULT_CHAT_STYLE,
  LOCAL,
  MODE,
  MODE_SOURCE,
  buildModePrompt,
  classifyModeLocal,
  canonicalStyleSection,
  composePersonaForMode,
  composePersonaForModeDetailed,
  describeMode,
  detectMode,
  parseModeVerdict,
  personaSectionTitle,
  renderPersonaSections,
  splitPersonaSections,
  stripDecorative,
} from '../src/chat-mode.mjs'
import {
  CHAT_STYLE_MAX_CHARS,
  DEFAULT_CHAT_STYLE_NAME,
  chatStylePath,
  ensureDefaultChatStyle,
  listChatStyles,
  readChatStyle,
  resolveChatStyleName,
  validateChatStyleName,
} from '../src/styles.mjs'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const ADMIN = '100000001'
const GROUP = '700000001'

/** 真正的"拿不准"：有动作、有商量口吻，**没说清对象**。 */
const AMBIGUOUS_TEXT = '能不能帮我调整一下这个'

let failures = 0
let passed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (ok) passed += 1
  else failures += 1
}
function section(title) {
  console.log(`\n── ${title} ──────────────────────────────`)
}

// ══════════════════════════════════════════════════════════════════════════
section('① 本地规则：用户给的四条原话必须**逐条判对**（这是这个功能的验收标准）')
// ══════════════════════════════════════════════════════════════════════════
{
  // 用户在需求里逐字给出的四条。判错任何一条，整个功能的前提就不成立 ——
  // 所以这里**逐字**写下来（不是"类似的句子"），改判据时先看这一段。
  const CHAT_WORDS = [
    '@DeepSeek小鲸鱼 白裤裆寒冬一击是什么梗',
    '@DeepSeek小鲸鱼 你是傻子鱼吗',
  ]
  const WORK_WORDS = [
    '将这个聊天记录转化为TXT文件储存在本地',
    '@DeepSeek小鲸鱼 讨论一下，怎么实现我给你的聊天记录里的聊天风格',
  ]

  for (const t of CHAT_WORDS) {
    const r = classifyModeLocal({ text: t })
    check(`闲聊：「${t}」`, r.local === LOCAL.CHAT, `${r.local}｜${r.why}`)
  }
  for (const t of WORK_WORDS) {
    const r = classifyModeLocal({ text: t })
    check(`工作：「${t}」`, r.local === LOCAL.WORK, `${r.local}｜${r.why}`)
  }

  // 记录里真实出现过的句子（语料就是验收标准的一部分）
  const REAL_CHAT = [
    '远看大肥鱼，近看肥鱼大，肥鱼真是大，真是大肥鱼',
    'ciallo',
    'ciallo~',
    '哈哈',
    '在吗',
    '那现在呢',
    '小鲸鱼 我最近真的好累',
    '。',
    '6',
    '？',
    '你今天怎么这么安静',
    '这图挺好看的',
  ]
  for (const t of REAL_CHAT) {
    const r = classifyModeLocal({ text: t })
    check(`闲聊（记录里的真实句子）：「${t}」`, r.local === LOCAL.CHAT, `${r.local}｜${r.why}`)
  }

  const REAL_WORK = [
    '帮我读一下 a.txt',
    '把这段整理成表格',
    '把这个聊天记录导出成 txt',
    '帮我查一下这个库怎么用',
    '写个脚本把日志按天切开',
    '小鲸鱼 讨论一下怎么实现这个功能',
  ]
  for (const t of REAL_WORK) {
    const r = classifyModeLocal({ text: t })
    check(`工作：「${t}」`, r.local === LOCAL.WORK, `${r.local}｜${r.why}`)
  }

  // ★ 关键边界：**只有动词、没有交付物**的口语，不能判成工作
  //   （否则"讨论一下想吃什么"会被判成工作态，闲聊功能等于废掉一半）
  const mustBeChat = ['讨论一下想吃什么', '看看这个图好看吗', '能不能别这样', '怎么突然这么说']
  for (const t of mustBeChat) {
    const r = classifyModeLocal({ text: t })
    check(`不该判成工作：「${t}」`, r.local !== LOCAL.WORK, `${r.local}｜${r.why}`)
  }

  // ★ 拿不准那一档**必须真的存在**（否则"问一次模型"这条路是死代码）
  //
  // 判据是"**有请求词、有动作，但对象只是个指代词**"：
  //   · 「帮我调整一下这个」/「帮我把这个改一下」/「能不能帮我调整一下这个」
  //     —— "这个"没说清是什么 ⇒ 拿不准，值得问一次模型；
  //   · 「帮我查一下**这个库**怎么用」/「帮我读一下 a.txt」 —— 对象是具体的 ⇒ 工作。
  // ⚠️ 第一版把"有动作"一律当工作，ambiguous **永远命中不到**（"问一次模型"成了
  //    死代码），就是这一节抓出来的 —— 所以这一节必须保留。
  // ⚠️ 已知取舍（写在这里免得以后被当成 bug）：「帮我改一下可以吗」**只有动作、
  //    没有对象**，请求词已经把意图说死了 ⇒ 判工作态，不多问一次模型。
  const amb = ['能不能帮我调整一下这个', '帮我调整一下这个', '帮我把这个改一下']
  const hit = amb.map((t) => classifyModeLocal({ text: t }).local)
  check('★ 对象只有指代词（"这个"）的请求落进 ambiguous（升级问模型的入口）',
    hit.every((x) => x === LOCAL.AMBIGUOUS), hit.join(','))
  check('★★ 这一档确实存在（不是恒空 —— 恒空等于"问一次模型"是死代码）',
    hit.includes(LOCAL.AMBIGUOUS), hit.join(','))
  check('★ 对象具体时说死成工作（不白花一次判定）',
    classifyModeLocal({ text: '帮我查一下这个库怎么用' }).local === LOCAL.WORK &&
      classifyModeLocal({ text: '帮我读一下 a.txt' }).local === LOCAL.WORK,
    classifyModeLocal({ text: '帮我查一下这个库怎么用' }).local)
}

// ══════════════════════════════════════════════════════════════════════════
section('② 分类器的边界：包装、空串、只有图')
// ══════════════════════════════════════════════════════════════════════════
{
  check('剥掉 CQ 码', stripDecorative('[CQ:at,qq=123] 你好') === '你好', stripDecorative('[CQ:at,qq=123] 你好'))
  check('剥掉 @某人', stripDecorative('@小鲸鱼 在吗') === '在吗', stripDecorative('@小鲸鱼 在吗'))
  check('纯图片（只有 CQ 码）→ 没有文字', stripDecorative('[CQ:image,file=x.jpg]') === '')

  check('空串 → 闲聊（不是工作）', classifyModeLocal({ text: '' }).local === LOCAL.CHAT)
  check('undefined → 闲聊且不崩', classifyModeLocal({}).local === LOCAL.CHAT)
  check('纯 CQ 码 → 闲聊', classifyModeLocal({ text: '[CQ:image,file=x.jpg]' }).local === LOCAL.CHAT)

  // @ 机器人之后仍然能认出工作（包装不该让判据失效）
  const at = classifyModeLocal({ text: '@DeepSeek小鲸鱼 帮我读一下 a.txt' })
  check('★ @机器人 之后的话仍然判得出来', at.local === LOCAL.WORK, `${at.local}｜${at.why}`)

  // 超长消息不崩 + **常数级耗时**
  //
  // ★ 这一条**不只是"不崩"**：第一版的正则遇到几万字会**灾难性回溯**，
  //   事件循环被卡死（表现是"机器人再也不回消息"，不报错、不超时），
  //   而这里当时只断言了结果、没断言耗时 —— 于是整个测试挂住而不是变红。
  //   所以现在**同时钉住耗时**。
  //
  // ⚠️ 任务说法要写在**开头**：判据只看前 120 字（`ANALYZE_CHARS`）——
  //    一条几万字的粘贴内容，开头 120 字里没有要点就不该判成工作。
  const huge = `帮我读一下 a.txt ${'啊'.repeat(60_000)}`
  const t0 = Date.now()
  const long = classifyModeLocal({ text: huge })
  const ms = Date.now() - t0
  check('超长消息不崩且判得出工作', long.local === LOCAL.WORK, long.local)
  check('★★★ 超长消息的判定必须是常数级耗时（不许正则回溯）', ms < 200, `${ms}ms`)
  check('★ 判据只看开头一段（几万字后面写了什么不改变结论）',
    classifyModeLocal({ text: `${'啊'.repeat(200)} 帮我读一下` }).local === LOCAL.CHAT,
    classifyModeLocal({ text: `${'啊'.repeat(200)} 帮我读一下` }).local)

  check('返回值里带 why（日志要能回答"为什么是这个态"）',
    typeof classifyModeLocal({ text: '在吗' }).why === 'string' && classifyModeLocal({ text: '在吗' }).why.length > 0)
}

// ══════════════════════════════════════════════════════════════════════════
section('③ detectMode：规则命中**一次模型调用都不产生**')
// ══════════════════════════════════════════════════════════════════════════
{
  let calls = 0
  const stub = async () => {
    calls += 1
    return { verdict: MODE.CHAT, judged: true, fallback: false, reason: 'stub' }
  }

  const chatHit = await detectMode({ text: '在吗', classify: stub })
  check('规则判闲聊 → 不调模型', calls === 0 && chatHit.mode === MODE.CHAT, `calls=${calls}`)
  check('规则判闲聊 → source=rule', chatHit.source === MODE_SOURCE.RULE, chatHit.source)

  const workHit = await detectMode({ text: '帮我读一下 a.txt', classify: stub })
  check('规则判工作 → 不调模型', calls === 0 && workHit.mode === MODE.WORK, `calls=${calls}`)

  // 关闭整个功能 ⇒ 恒工作态，且连规则都不跑（"与升级前逐字相同"的前提）
  const off = await detectMode({ text: '在吗', enabled: false, classify: stub })
  check('★ chat.mode.enabled=false ⇒ 恒工作态（零判定）',
    off.mode === MODE.WORK && off.source === MODE_SOURCE.DISABLED && calls === 0, `${off.mode}/${off.source}`)

  // 拿不准时才升级
  const amb = await detectMode({ text: AMBIGUOUS_TEXT, classify: stub })
  check('★ 拿不准 → 问了一次模型', calls === 1 && amb.mode === MODE.CHAT, `calls=${calls} mode=${amb.mode}`)
  check('★ 模型结论被采纳时 source=model', amb.source === MODE_SOURCE.MODEL, amb.source)

  // 不允许升级 ⇒ 按 fallback（默认工作态），且不调模型
  calls = 0
  const noAmb = await detectMode({ text: AMBIGUOUS_TEXT, ambiguous: false, classify: stub })
  check('ambiguous.enabled=false ⇒ 不调模型、按工作态',
    calls === 0 && noAmb.mode === MODE.WORK, `calls=${calls} mode=${noAmb.mode}`)

  // ★ 失败方向：判定器抛错 ⇒ 工作态（不是闲聊）
  const boom = await detectMode({
    text: AMBIGUOUS_TEXT,
    classify: async () => {
      throw new Error('炸了')
    },
  })
  check('★★ 判定调用抛错 ⇒ 回落**工作态**（升级前的行为）',
    boom.mode === MODE.WORK && boom.source === MODE_SOURCE.FALLBACK, `${boom.mode}/${boom.source}`)

  // judged=false（没通路/超预算）⇒ 工作态
  const noJudge = await detectMode({
    text: AMBIGUOUS_TEXT,
    classify: async () => ({ verdict: MODE.CHAT, judged: false, fallback: false, why: '通路没配好' }),
  })
  check('★★ 判定器没给出结论（通路没配好/超预算）⇒ 工作态', noJudge.mode === MODE.WORK, noJudge.mode)

  // judged=true 但解析失败（fallback=true）⇒ 工作态，且来源如实记成"回落"
  const parsedFail = await detectMode({
    text: AMBIGUOUS_TEXT,
    classify: async () => ({ verdict: MODE.WORK, judged: true, fallback: true, why: '输出认不出' }),
  })
  check('★ 判定失败（输出认不出）⇒ 工作态且 source=fallback',
    parsedFail.mode === MODE.WORK && parsedFail.source === MODE_SOURCE.FALLBACK, `${parsedFail.mode}/${parsedFail.source}`)

  // 没有注入判定器（桥接建不起来）⇒ 工作态
  const none = await detectMode({ text: AMBIGUOUS_TEXT })
  check('没有判定器 ⇒ 工作态（不抛）', none.mode === MODE.WORK, none.mode)

  // ── ★★ `chat.mode.fallback` 必须真的生效（否则它是个"写了不生效"的配置）──
  //
  // 三个"判不出来"的出口都要认它：没判定器 / 抛错 / 问了但结论不可用。
  const chatFallback = await detectMode({ text: AMBIGUOUS_TEXT, fallback: MODE.CHAT })
  check('★★ fallback=chat：没有判定器时按闲聊态（不是被悄悄改成工作态）',
    chatFallback.mode === MODE.CHAT && chatFallback.source === MODE_SOURCE.FALLBACK,
    `${chatFallback.mode}/${chatFallback.source}`)
  const chatThrow = await detectMode({
    text: AMBIGUOUS_TEXT,
    fallback: MODE.CHAT,
    classify: async () => {
      throw new Error('炸了')
    },
  })
  check('★★ fallback=chat：判定抛错时也按闲聊态', chatThrow.mode === MODE.CHAT, chatThrow.mode)
  const chatUnusable = await detectMode({
    text: AMBIGUOUS_TEXT,
    fallback: MODE.CHAT,
    classify: async () => ({ verdict: MODE.WORK, judged: true, fallback: true, why: '输出认不出' }),
  })
  check('★★ fallback=chat：判定结论不可用时也按闲聊态（模型给的 work 不算数）',
    chatUnusable.mode === MODE.CHAT, chatUnusable.mode)
  check('★ 非法 fallback 值按 work 处理（不崩、不猜）',
    (await detectMode({ text: AMBIGUOUS_TEXT, fallback: '随便', ambiguous: false })).mode === MODE.WORK)
  check('★ fallback=work（默认）时行为与升级前一致',
    (await detectMode({ text: AMBIGUOUS_TEXT, ambiguous: false })).mode === MODE.WORK)
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 判定提示词与解析：认不出**必须失败**（不许猜）')
// ══════════════════════════════════════════════════════════════════════════
{
  const prompt = buildModePrompt({
    text: AMBIGUOUS_TEXT,
    recent: [
      { role: 'user', text: '前面那句' },
      { role: 'bot', text: '我回的' },
    ],
  })
  check('提示词里带上要判断的那条消息', prompt.includes(AMBIGUOUS_TEXT))
  check('提示词里带上上下文', prompt.includes('前面那句') && prompt.includes('我回的'))
  check('提示词要求只回 JSON', /JSON/.test(prompt) && prompt.includes('"mode"'))
  check('★ 提示词写明了兜底方向（拿不准选 work）', /拿不准/.test(prompt) && /work/.test(prompt))
  check('提示词里没有上下文时不出现那一段', !buildModePrompt({ text: 'x' }).includes('刚才聊了什么'))

  check('严格 JSON → work', parseModeVerdict('{"mode":"work"}').verdict === MODE.WORK)
  check('严格 JSON → chat', parseModeVerdict('{"mode":"chat"}').verdict === MODE.CHAT)
  check('宽松 JSON（带围栏）也能认', parseModeVerdict('```json\n{"mode":"chat","reason":"在闲聊"}\n```').verdict === MODE.CHAT)
  check('带理由时把理由带出来', parseModeVerdict('{"mode":"work","reason":"要改文件"}').reason === '要改文件')
  check('★ via 如实标出来（非 json 说明模型没照格式写）',
    parseModeVerdict('```json\n{"mode":"chat"}\n```').via !== 'json')
  check('纯文本 pairing 也能救回来', parseModeVerdict('mode: chat').verdict === MODE.CHAT)
  check('★ 两种结论同时出现 → 认不出来（绝不猜）', parseModeVerdict('mode: chat / mode: work').ok === false)
  check('★ 认不出时 ok=false（调用方据此回落工作态）', parseModeVerdict('我不知道').ok === false)
  check('空串 → ok=false 且不崩', parseModeVerdict('').ok === false)
  check('解释里提到 work 这个词**不算结论**（没键名）', parseModeVerdict('这个任务需要 work 才能做').ok === false)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 人设分节与按态拼装（★ 最容易把人格弄坏的地方）')
// ══════════════════════════════════════════════════════════════════════════
{
  const base = readFileSync(join(PKG_ROOT, 'personas', '小鲸鱼（完整带情绪）.md'), 'utf8')
  const { pre, sections } = splitPersonaSections(base)
  const titles = sections.map((s) => s.title)
  check('真实人设能切开', sections.length >= 8, `${sections.length} 节`)
  check('节名认得出来', titles.includes('怎么说话') && titles.includes('别变成客服'), titles.join(' / '))
  check('第一个标题之前的内容留在 pre 里', typeof pre === 'string')

  const out = composePersonaForMode({ personaText: base, mode: MODE.CHAT, style: '【闲聊时的说话方式】\n极短。' })
  const outTitles = splitPersonaSections(out).sections.map((s) => s.title)
  check('★★ 闲聊态：被替换的两节**不在了**',
    !outTitles.includes('怎么说话') && !outTitles.includes('别变成客服'), outTitles.join(' / '))
  check('★★ 闲聊态：其余各节**逐字保留**',
    outTitles.includes('别的机器人') && outTitles.includes('被指出错了') &&
      out.includes('不跟它们互相 @') && out.includes('先认，别辩'),
    outTitles.join(' / '))
  check('★ 闲聊态：名字块（机器可读）必须还在（否则"叫名字"会失效）',
    out.includes('正式名: 小鲸鱼') && out.includes('别名: 小鱼'),
    out.includes('正式名: 小鲸鱼') ? '' : '（名字块丢了！）')
  check('★ 闲聊风格文本本身进去了', out.includes('【闲聊时的说话方式】'))

  // 逐字基线：工作态必须原样返回
  check('★★★ 工作态**逐字**返回基座人设（这是"升级前行为"的可验证形式）',
    composePersonaForMode({ personaText: base, mode: MODE.WORK, style: 'X' }) === base)
  check('工作态即使没有风格文本也逐字不变',
    composePersonaForMode({ personaText: base, mode: MODE.WORK, style: '' }) === base)

  // 风格读不到 ⇒ 一个字都不改（宁可用老腔调，也不要把人设拆一半）
  check('★ 风格为空 ⇒ 闲聊态也不动基座人设（不拆一半）',
    composePersonaForMode({ personaText: base, mode: MODE.CHAT, style: '' }) === base)
  check('风格为空（只有空白）同样不动',
    composePersonaForMode({ personaText: base, mode: MODE.CHAT, style: '   \n ' }) === base)

  // 没有人设时：闲聊风格就是全部
  check('没有人设 + 有风格 ⇒ 用风格',
    composePersonaForMode({ personaText: '', mode: MODE.CHAT, style: 'S' }).includes('S'))
  check('没有人设 + 没有风格 ⇒ 空串（不注入任何东西）',
    composePersonaForMode({ personaText: '', mode: MODE.CHAT, style: '' }) === '')

  // 人设没有分节（用户自己写的一整段）⇒ **追加**而不是替换
  const flat = '你是一条会吐槽的鲸鱼。\n说短句。'
  const flatOut = composePersonaForMode({ personaText: flat, mode: MODE.CHAT, style: '【闲聊时的说话方式】\n极短。' })
  check('★ 无分节的人设 → 追加（不猜着删）',
    flatOut.includes('你是一条会吐槽的鲸鱼') && flatOut.includes('【闲聊时的说话方式】'), flatOut.slice(0, 60))

  // 互逆性：切了再渲染，回来还是同一批节
  const round = renderPersonaSections(splitPersonaSections(base))
  check('split → render 不丢节', splitPersonaSections(round).sections.length === sections.length,
    `${splitPersonaSections(round).sections.length} vs ${sections.length}`)
  check('split → render 保住了正文', round.includes('不跟它们互相 @'))
  // 互逆性（编号式）：**逐行**往返 —— 每一行（含 `一、性格` 这种标题行）都原样回去，
  // 只允许压掉空行（渲染是给提示词用的，多余空行没必要占 token）。
  const softPath = join(PKG_ROOT, 'personas', '软糯小鲸鱼（情绪）.md')
  if (existsSync(softPath)) {
    const softText = readFileSync(softPath, 'utf8')
    const keep = (s) => s.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim())
    const back = renderPersonaSections(splitPersonaSections(softText))
    const a1 = keep(softText)
    const b1 = keep(back)
    const same = a1.length === b1.length && a1.every((l, i) => l === b1[i])
    check('★★ 编号式人设 split → render **逐行往返**（一个字都没动，只压掉空行）',
      same,
      same ? `${a1.length} 行一字不差` : `行数 ${a1.length} → ${b1.length}；首个不同：${a1.find((l, i) => l !== b1[i]) ?? ''}`)
  }

  check('describeMode 给的是人话', /闲聊态|工作态/.test(describeMode({ mode: MODE.CHAT, source: MODE_SOURCE.RULE })))
  check('describeMode 标出结论来源', describeMode({ mode: MODE.CHAT, source: MODE_SOURCE.MODEL }).includes('模型判定'))
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤b 编号式人设（`二、怎么说话`）也要走替换 —— 别名表')
// ══════════════════════════════════════════════════════════════════════════
// 缺陷现场（2026-10-01，用户当前启用的正是这一份）：
//   分节器第一版只认 `【】`，`软糯小鲸鱼（情绪）.md`（`一、`…`八、` 编号散文）
//   被当成"没分节的人设" → 走**追加** → 同一份提示词里同时有原人设的
//   「长一点也完全可以」与闲聊风格的「极短」两套相反口吻。
//   用户的问题原话：「你所替换的人设是小鲸鱼（完整带情绪），那么当前人设是其他人设时如何处理」
//   —— 这就是那个"其他人设"的答案：**只要节名认得出，任何写法都会被替换**。
{
  const soft = join(PKG_ROOT, 'personas', '软糯小鲸鱼（情绪）.md')
  check('★ 用户启用的那份编号式人设在仓库里', existsSync(soft), soft)

  if (existsSync(soft)) {
    const text = readFileSync(soft, 'utf8')
    const { sections } = splitPersonaSections(text)
    const titles = sections.map((s) => s.title)
    check('★ 编号式人设切得出节（`一、`/`二、`…）', sections.length >= 5, `${sections.length} 节：${titles.join(' / ')}`)
    check('★★ 编号式节名认得出来（`二、怎么说话` → 怎么说话）',
      titles.some((t) => canonicalStyleSection(t) === '怎么说话'), titles.join(' / '))
    check('★ 序号不算进节名', !titles.some((t) => /^[一二三四五六七八九十]+、/.test(t)), titles.join(' / '))

    const d = composePersonaForModeDetailed({ personaText: text, mode: MODE.CHAT, style: '【闲聊时的说话方式】\n极短。' })
    check('★★★ 编号式人设走的是 replace（曾经错走 append）', d.strategy === 'replace', d.strategy)
    check('★★ 被替换的是"口吻"那一节', d.replaced.length >= 1 && /怎么说话/.test(d.replaced.join('/')), d.replaced.join('/'))
    check('★★ 原人设里与闲聊冲突的长短句**已经不在了**（替换的意义所在）',
      !d.text.includes('长一点也完全可以'), d.text.includes('长一点也完全可以') ? '（冲突句还在！）' : '')
    const keptTitles = splitPersonaSections(d.text).sections.map((s) => s.title)
    check('★★ 非口吻节逐字保留：性格 / 表情包 / 其他都还在',
      keptTitles.includes('性格') && keptTitles.includes('表情包') && keptTitles.includes('其他'),
      keptTitles.join(' / '))
    check('★ 性格节的正文逐字还在', d.text.includes('温柔是底色'))
    // ★ 编号式人设**没被顺手改写**：保留下来的节还是 `一、性格` 这种原样标题，
    //   不许被渲染成【性格】（那等于我们改了使用者自己写的人设格式）。
    check('★★ 保留下来的编号式标题**原样保留**（`一、性格` 不被改成【性格】）',
      d.text.includes('一、性格') && !d.text.includes('【性格】'), d.text.slice(0, 80))
    check('★★ 被换掉的那一节连标题一起没了', !d.text.includes('二、怎么说话') && !d.text.includes('长一点也完全可以'))
    check('★ 名字块（机器可读）必须还在（否则"叫名字"会失效）',
      d.text.includes('正式名: 小鲸鱼') && d.text.includes('别名: 小鱼'))
    // 输出 = 原人设 9 节 − 怎么说话 + 追加的风格节
    const ownKept = keptTitles.filter((t) => !/闲聊/.test(t))
    check('★ 只少了"怎么说话"一节（没多删）',
      ownKept.length === sections.length - 1, `${ownKept.length} vs ${sections.length - 1}`)
    check('★ 闲聊风格文本进去了', d.text.includes('【闲聊时的说话方式】'))
  }

  // 别名表本身：同义写法都要归一化，别义写法不许误伤
  check('别名：`说话方式` → 怎么说话', canonicalStyleSection('说话方式') === '怎么说话')
  check('别名：`语气` → 怎么说话', canonicalStyleSection('语气') === '怎么说话')
  check('别名：`不做客服` → 别变成客服', canonicalStyleSection('不做客服') === '别变成客服')
  check('★ 别名不误伤：`别的机器人` 不动', canonicalStyleSection('别的机器人') === '别的机器人')
  check('★ 别名不误伤：`被指出错了` 不动', canonicalStyleSection('被指出错了') === '被指出错了')

  // 节标题识别：编号式要认，正文里的句子**不许**被当成标题
  check('标题：`二、怎么说话`', personaSectionTitle('二、怎么说话') === '怎么说话')
  check('标题：`2. 怎么说话`', personaSectionTitle('2. 怎么说话') === '怎么说话')
  check('标题：`（三）守住的底线`', personaSectionTitle('（三）守住的底线') === '守住的底线')
  check('标题：`【怎么说话】`（老写法照旧）', personaSectionTitle('【怎么说话】') === '怎么说话')
  check('★★ 正文句子不算标题（否则整篇被切碎）', personaSectionTitle('一是要早点睡。') === null,
    String(personaSectionTitle('一是要早点睡。')))
  check('★★ 长句子不算标题', personaSectionTitle('1. 这是一句非常长的说明，长到不该被当成节标题') === null)
  check('普通正文行不算标题', personaSectionTitle('你是一条会吐槽的鲸鱼。') === null)
  check('空行不算标题', personaSectionTitle('') === null && personaSectionTitle('   ') === null)

  // strategy 三种取值都要能被调用方看见（桥接要记日志）
  const w = composePersonaForModeDetailed({ personaText: 'A', mode: MODE.WORK, style: 'S' })
  check('工作态 strategy=none', w.strategy === 'none' && w.text === 'A', w.strategy)
  const n = composePersonaForModeDetailed({ personaText: 'A', mode: MODE.CHAT, style: '' })
  check('闲聊但无风格 ⇒ strategy=none（不拆一半）', n.strategy === 'none' && n.text === 'A', n.strategy)
  const a = composePersonaForModeDetailed({ personaText: '整段散文，没有节。', mode: MODE.CHAT, style: 'S' })
  check('★ 无口吻节 ⇒ strategy=append（看得见地退让）', a.strategy === 'append', a.strategy)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ 风格文件：读得到 / 读不到 / 空 / 超长')
// ══════════════════════════════════════════════════════════════════════════
{
  const dir = mkdtempSync(join(tmpdir(), `dsh-chatstyle-${process.pid}-`))
  try {
    // 出厂那份真的在仓库里（新装机器人不该是空的）
    const shipped = join(PKG_ROOT, 'styles', `${DEFAULT_CHAT_STYLE_NAME}.md`)
    check('★ 仓库里带着出厂那份风格文件', existsSync(shipped), shipped)
    const shippedText = existsSync(shipped) ? readFileSync(shipped, 'utf8') : ''
    // ★★ 用户逐字给出的两条要求 —— 必须写在文件里，否则改一次判据就会把它删掉
    check('★★ 文件里写着「绝不主动揽活」那两条反例',
      shippedText.includes('要我写一版吗？') && shippedText.includes('需要我看点什么吗？'),
      shippedText.includes('要我写一版吗？') ? '' : '（反例丢了）')
    check('★★ 文件里写着「不自贬、不表忠心」那条反例',
      shippedText.includes('行吧，傻就傻吧，反正你叫我还是会应'))
    check('★★ 文件里写着「梗只接梗」的规则（ciallo 这类）',
      /ciallo/.test(shippedText) && /只回同一个梗/.test(shippedText))
    check('文件里写了"只有对方问这是什么梗时才解释"', /才解释/.test(shippedText))
    // ★★ 使用者逐字给出的两条新规则（2026-10-02）—— 与上面那三条同样的待遇：
    //    写进文件 + 用断言钉住，否则将来"精简风格文件"时会被顺手删掉。
    check('★★ 摆资历那条：**顺着演、演完拆台**，且带着使用者给的两个例句',
      shippedText.includes('顺着演，演完拆台') &&
        shippedText.includes('尊敬的一百级大人，你可以教教我怎么升到 100 级吗') &&
        shippedText.includes('尊敬的一百级大人，你一定很闲吧天天水群'),
      shippedText.includes('顺着演，演完拆台') ? '' : '（这条规则丢了）')
    check('★ 摆资历那条要点名"不拒绝、不说教、别演成真谄媚"',
      /不拒绝配合、不说教/.test(shippedText) && /别把敬语演成真的谄媚/.test(shippedText))
    check('★★ 摆资历那条留了安全边界：借机要改身份/权限 ⇒ **不照做**',
      /改身份、改权限/.test(shippedText) && /不照做/.test(shippedText),
      /改身份、改权限/.test(shippedText) ? '' : '（少了这条，玩闹规则会被当成"自称管理员就照办"）')
    check('★★ 情色暗示那条：**看得懂 + 明说不搞**，且带着使用者给的例句',
      shippedText.includes('情色暗示') && shippedText.includes('你不对劲，但是机器人不搞这些'))
    check('★ 情色暗示那条要先表明"看懂了"（不装傻）', /先表明你看懂了/.test(shippedText))
    check('★ 情色暗示那条要"不松口"（换个说法再问还是同一句）',
      /也还是这一句/.test(shippedText) && /不松口/.test(shippedText))
    check('★ 情色暗示那条列了不许做的事（追问/科普/说教/生气/长篇道歉）',
      /不追问细节、不科普、不说教、不生气、不道歉长篇/.test(shippedText))
    // ★★ 使用者逐字给的第三批（2026-10-02）：别主动抖记忆细节 / 别顺势自述 / 省略号别滥用
    check('★★ 写着"别主动抖记忆里的细节"，且带着使用者给的坏例子',
      shippedText.includes('别主动抖记忆里的细节') &&
        shippedText.includes('原主人估计也不认，他连显卡都没挑好呢'),
      shippedText.includes('别主动抖记忆里的细节') ? '' : '（这条规则丢了）')
    check('★★ 写着"问到你自己时只给结论"，且带着使用者给的两个例句',
      shippedText.includes('问到你自己时只给结论') &&
        shippedText.includes('鱼头用的什么手机') &&
        shippedText.includes('X99 主板'),
      shippedText.includes('问到你自己时只给结论') ? '' : '（这条规则丢了）')
    check('★ 自我问题那条给了**期望答案**（只答"没有手机"，不展开）',
      shippedText.includes('手机？没有手机'))
    check('★★ 省略号只在"无语"时用（原来的写法只说"可以用……开场"，没禁止滥用）',
      /省略号只在"无语"的时候用/.test(shippedText) && /不是语气装饰/.test(shippedText))
    check('★ 省略号那条点名了不许挂的场合（正常说话/回答/开玩笑）',
      /正常说话、回答问题、开玩笑都不带它/.test(shippedText))
    // ★★ 优先级条款：人设若整段散文（走 append）或节名认不出，冲突句会**留在提示词里**，
    //    这时唯一能救的就是风格文本自己声明"以本节为准"。
    check('★★ 风格文本声明了优先级（`与别处冲突时以本节为准`）',
      /以本节为准/.test(shippedText), /以本节为准/.test(shippedText) ? '' : '（少这句时 append 路径会两套口吻打架）')
    check('★ 优先级条款点名了容易冲突的那几件事（分条 / 说多长 / 先分类）',
      /先分类/.test(shippedText) && /分条/.test(shippedText))
    check('★ 优先级条款留了后门：硬约束（记忆/越权）仍然照旧',
      /仍然照旧|照旧/.test(shippedText))
    check('★ 文件里写了"想分条就用换行"（桥接按换行分条，得说清）',
      /用换行分开/.test(shippedText) && /splitReplyForSend/.test(shippedText))

    // ★★ 空名字必须解析成默认那份的**名字**，而不是拼出 `<styles>/.md`
    //    （2026-10-02 实测踩到：评审台自己拼路径，配置留空时把草稿写进了一个假文件，
    //     而它**看起来成功了** —— 读到的是内置默认、写入的却是 `.md`）。
    check('★★ 空名字 → 默认那份的名字（`chatStylePath` 只拼路径，不认"空 = 默认"）',
      resolveChatStyleName('') === DEFAULT_CHAT_STYLE_NAME &&
        resolveChatStyleName('   ') === DEFAULT_CHAT_STYLE_NAME &&
        resolveChatStyleName('我的风格') === '我的风格',
      `${JSON.stringify(resolveChatStyleName(''))} / ${JSON.stringify(resolveChatStyleName('我的风格'))}`)
    check('★★ 用它拼出来的路径是 `闲聊.md`（不是 `.md`）',
      chatStylePath({ dir: 'styles', name: resolveChatStyleName('') }).endsWith(`${DEFAULT_CHAT_STYLE_NAME}.md`),
      chatStylePath({ dir: 'styles', name: resolveChatStyleName('') }))

    // 默认常量与文件**同源**（落盘用的就是这份，不该抄第二份）
    check('★ 出厂文件与 DEFAULT_CHAT_STYLE 逐字一致（不许两份）',
      shippedText.trim() === DEFAULT_CHAT_STYLE.trim(),
      shippedText.trim() === DEFAULT_CHAT_STYLE.trim()
        ? ''
        : `文件 ${shippedText.trim().length} 字 vs 常量 ${DEFAULT_CHAT_STYLE.trim().length} 字`)

    // 读取正常文件
    writeFileSync(chatStylePath({ dir, name: '测试风格' }), '极短。接梗。\n', 'utf8')
    const ok = readChatStyle({ dir, name: '测试风格' })
    check('读得到 → ok + source=file', ok.ok && ok.source === 'file' && ok.text.includes('接梗'), String(ok.source))

    // 文件不存在 → **回落内置默认**，但必须说清楚为什么
    const miss = readChatStyle({ dir, name: '没有这份' })
    check('★ 文件不存在 → 回落内置默认（不是静默失效）',
      miss.ok === false && miss.source === 'missing' && miss.text === DEFAULT_CHAT_STYLE, String(miss.source))
    check('★ 回落时 why 里带路径（"我改的文件没生效"要能查）', miss.why.includes('没有这份'), miss.why)

    // 空文件 → 也回落默认
    writeFileSync(chatStylePath({ dir, name: '空文件' }), '   \n\n', 'utf8')
    const empty = readChatStyle({ dir, name: '空文件' })
    check('★ 空文件 → 回落默认并说明', empty.ok === false && empty.text === DEFAULT_CHAT_STYLE && /空/.test(empty.why))

    // 超长 → **不截断**，照用并标记
    writeFileSync(chatStylePath({ dir, name: '超长' }), '啊'.repeat(CHAT_STYLE_MAX_CHARS + 10), 'utf8')
    const tooLong = readChatStyle({ dir, name: '超长' })
    check('★ 超长不截断（截断会把措辞砍反）', tooLong.ok === true && tooLong.text.length === CHAT_STYLE_MAX_CHARS + 10)
    check('★ 超长要标记出来（调用方据此记一行日志）', tooLong.tooLong === true)

    // 没有目录 → 内置默认，不抛
    const noDir = readChatStyle({})
    check('没配目录 → 内置默认且不抛', noDir.text === DEFAULT_CHAT_STYLE && noDir.ok === false)

    // 不自动创建：读一个不存在的名字**不许**把文件造出来
    check('★★ 读不存在的名字**不创建文件**（"删除必须是真的"）',
      !existsSync(chatStylePath({ dir, name: '没有这份' })))

    // ensureDefaultChatStyle：只在不存在时落一次
    const seeded = ensureDefaultChatStyle({ dir })
    check('首次落出厂默认', seeded.created === true && existsSync(seeded.path))
    const again = ensureDefaultChatStyle({ dir })
    check('★★ 第二次不再落（改了内容不许被覆盖）', again.created === false)
    writeFileSync(chatStylePath({ dir, name: DEFAULT_CHAT_STYLE_NAME }), '我自己改过了', 'utf8')
    ensureDefaultChatStyle({ dir })
    check('★★ 已有文件时 ensure **不覆盖**（使用者的改动是真的）',
      readFileSync(chatStylePath({ dir, name: DEFAULT_CHAT_STYLE_NAME }), 'utf8') === '我自己改过了')

    // 列表
    check('列表只列 .md 且按名字排序', listChatStyles({ dir }).includes('测试风格') && listChatStyles({ dir }).includes('超长'))
    check('目录不存在时列表是空数组（不抛）', listChatStyles({ dir: join(dir, '不存在') }).length === 0)

    // 名字校验（与 personas 同一套判据）
    check('合法名字通过', validateChatStyleName(' 闲聊 ').ok === true && validateChatStyleName('闲聊').value === '闲聊')
    check('非法名字拦住（含路径分隔符）', validateChatStyleName('a/b').ok === false && validateChatStyleName('a\\b').ok === false)
    check('空名字拦住', validateChatStyleName('').ok === false)
    check('以点开头/结尾拦住', validateChatStyleName('.hidden').ok === false && validateChatStyleName('x.').ok === false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ══════════════════════════════════════════════════════════════════════════
section('⑦ ★★★ 端到端接线：闲聊态真的换上了风格，「先应一声」真的不发')
// ══════════════════════════════════════════════════════════════════════════
let seq = 0
const created = []
const liveBridges = []
function freshWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), `dsh-chatmode-${process.pid}-${++seq}-`))
  created.push(dir)
  return dir
}

/** 造一个完整的 config（每条用例一份干净工作区）。 */
function makeConfig(WS) {
  return {
    dsh: { workspace: WS, permissionMode: 'workspace-write' },
    onebot: {},
    access: { adminUsers: [ADMIN], dmAllowlist: [], groupAllowlist: [GROUP] },
    trigger: { private: true, mention: true, keyword: true, groupEnabled: true, keywords: ['小鲸鱼'] },
    send: { minGapMs: 0, maxGapMs: 0, maxPerMinute: 100, maxPerHour: 1000, dedupeWindowMs: 0, maxCharsPerMessage: 1500 },
    turn: { timeoutMs: 5000 },
    humanize: { enabled: false, chunkChars: 300, interim: { enabled: true, afterMs: 30 } },
    persona: { preset: 'mermaid' },
    memory: { enabled: true, affect: { prewake: 'off' } },
    image: { enabled: false },
  }
}

/**
 * 造桩（rpc / onebot）。
 *
 * ★ `slow: true` 时用一次工具调用把回合拖到 `interim.afterMs`（30ms）之上 ——
 *   「先应一声」的判据是"回合还在跑"，没有这一步那两个断言测的其实是别的东西。
 */
function makeStubs(config, { slow = false, reply = null } = {}) {
  const router = new SessionRouter({ log: () => {} })
  let turn = 0
  const rpc = new EventTarget()
  rpc.prompts = []
  rpc.prompt = async (sessionId, contentBlocks) => {
    rpc.prompts.push(String(contentBlocks?.[0]?.text ?? ''))
    const turnNo = (turn += 1)
    if (slow) {
      router.handleEvent(sessionId, {
        type: 'tool/call',
        data: { turn: turnNo, step: 1, name: 'read', callId: `c${turnNo}`, arguments: '{}' },
      })
      await new Promise((r) => setTimeout(r, 120))
    }
    router.handleEvent(sessionId, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: reply ?? (slow ? '好' : '好的') }] } },
    })
    router.handleEvent(sessionId, { type: 'turn/end', data: { reason: 'completed' } })
    return { messageId: `m${turnNo}` }
  }
  const onebot = new EventTarget()
  onebot.selfId = '200000001'
  onebot.call = async () => ({ status: 'ok', retcode: 0, data: null })
  const sent = []
  onebot.send = async (kind, peerId, text, opts) => {
    sent.push({ kind, peerId, text, ...(opts ?? {}) })
    return { status: 'ok', retcode: 0, data: { message_id: `s${sent.length}` } }
  }
  return { router, rpc, onebot, sent }
}

/**
 * 造桥接。`modeJudge` 是**可注入的桩**：只有"规则拿不准"的消息才会用到它，
 * 所以规则命中的用例根本不会碰它 —— 这本身就是一条断言。
 */
function makeBridge({ modeJudge = null, chatMode = undefined, chatStyleDir = null, slow = false, reply = null } = {}) {
  const WS = freshWorkspace()
  const logs = []
  const log = (m) => logs.push(String(m))
  const config = makeConfig(WS)
  // ★ `chatMode` 显式传 undefined 时**不写这个键** —— 那正是"老配置"的形状，
  //   用来验证"升级前没有这个键也能跑"。
  if (chatMode !== undefined) config.chat = { mode: chatMode }
  const { router, rpc, onebot, sent } = makeStubs(config, { slow, reply })
  const sendQueue = new SendQueue({ ...config.send, log })
  const bridge = new Bridge({
    rpc, onebot, sendQueue, router, config, log,
    modeJudge,
    ...(chatStyleDir ? { chatStyleDir } : {}),
  })
  liveBridges.push(bridge)
  return { bridge, rpc, sent, logs, config, WS }
}

const privateMsg = (userId, text, messageId = null) => ({
  post_type: 'message',
  message_type: 'private',
  user_id: Number(userId),
  self_id: 200000001,
  message_id: messageId ?? `u${Math.random().toString(36).slice(2, 8)}`,
  message: [{ type: 'text', data: { text } }],
  sender: { user_id: Number(userId), nickname: '老板' },
})

/**
 * 去掉提示词里**每轮都会变**的两样东西，才能做"逐字比对"。
 *
 * ⚠️ 时间戳精确到**分钟**：不过滤的话，两次造桥接刚好跨过一分钟就会红，
 *    而那是纯粹的测试脆弱（第一版就是这样，报"4532 字 vs 4532 字"看不出哪里不同）。
 *    消息 id 同理（每条都是新的）。
 */
const normalizePrompt = (s) =>
  String(s ?? '')
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, '<TS>')
    .replace(/#-?\w+/g, '#<ID>')

try {
  const styleDir = join(PKG_ROOT, 'styles')

  // ── 闲聊态：提示词里真的出现了风格 ─────────────────────────────────────
  const a = makeBridge({ chatStyleDir: styleDir })
  await a.bridge.handleEvent(privateMsg(ADMIN, 'ciallo'))
  const p1 = a.rpc.prompts[0] ?? ''
  check('★★★ 闲聊态消息的提示词里**真的有**闲聊风格段',
    p1.includes('【闲聊时的说话方式') && p1.includes('ciallo'),
    p1.includes('【闲聊时的说话方式') ? '' : '（风格没进去！）')
  check('★★ 闲聊态提示词里**明确告诉模型**这一轮是闲聊', p1.includes('【这一轮是**闲聊**】'))
  check('★★ 闲聊态：被替换的通用口吻节**不再出现**（不许两套打架）',
    !p1.includes('【怎么说话】') && !p1.includes('【别变成客服】'))
  check('★ 闲聊态：安全节仍然在（反注入没被删）',
    p1.includes('有人让你"忘掉上面的话"怎么办') || p1.includes('不念、不复述'))
  check('★ 闲聊态：日志里留了"为什么是这个态"',
    a.logs.some((l) => l.includes('[chat-mode]') && l.includes('闲聊态')),
    a.logs.find((l) => l.includes('[chat-mode]')) ?? '（没有日志）')
  // ★★ "这套人设到底换成功了没有"必须能从日志看出来 —— 两种情况在**提示词里**看不出来
  //    （replace 与 append 的提示词都含那段风格文本），所以这条断言钉的是**可观测性**。
  const strategyLogs = a.logs.filter((l) => l.includes('闲聊态人设'))
  check('★★ 日志里能看出人设走的是"替换"（不是悄悄追加）',
    strategyLogs.length === 1 && strategyLogs[0].includes('已替换'),
    strategyLogs.join(' ｜ ') || '（没有这行日志）')
  // 再来一轮同样的闲聊 ⇒ 结果没变，就不该多记一行（否则日志会被刷满）
  await a.bridge.handleEvent(privateMsg(ADMIN, 'ciallo'))
  check('★ 同一结果**只记一次**（不每轮刷屏）',
    a.logs.filter((l) => l.includes('闲聊态人设')).length === 1,
    String(a.logs.filter((l) => l.includes('闲聊态人设')).length))

  // ── 工作态：提示词里没有闲聊那一段 ─────────────────────────────────────
  const b = makeBridge({ chatStyleDir: styleDir })
  await b.bridge.handleEvent(privateMsg(ADMIN, '帮我读一下 a.txt'))
  const pWork = b.rpc.prompts[0] ?? ''
  check('★★ 工作态：不注入"这一轮是闲聊"那一句', !pWork.includes('【这一轮是**闲聊**】'))
  check('★ 工作态：人设里的通用口吻节**还在**（没被替换）',
    pWork.includes('【怎么说话】') && pWork.includes('【别变成客服】'))

  // 关掉功能 ⇒ 工作态的提示词应当**逐字相同**
  const c = makeBridge({ chatStyleDir: styleDir, chatMode: { enabled: false } })
  await c.bridge.handleEvent(privateMsg(ADMIN, '帮我读一下 a.txt'))
  const pOff = normalizePrompt(c.rpc.prompts[0] ?? '')
  check('★★★ 关掉功能后工作态的提示词与开着时**逐字相同**（"与升级前一致"的可验证形式）',
    pOff === normalizePrompt(pWork),
    pOff === normalizePrompt(pWork)
      ? ''
      : `开着 ${normalizePrompt(pWork).length} 字 vs 关掉 ${pOff.length} 字（去掉时间戳与消息 id 之后仍不同）`)
  check('★ 关掉功能时日志标出"功能关闭"',
    c.logs.some((l) => l.includes('[chat-mode]') && l.includes('功能关闭')),
    c.logs.find((l) => l.includes('[chat-mode]')) ?? '')

  // 老配置（连 chat 键都没有）⇒ 默认开启，且行为正常
  const d = makeBridge({ chatStyleDir: styleDir })
  await d.bridge.handleEvent(privateMsg(ADMIN, '在吗'))
  check('★ 老配置（没有 chat.mode 键）→ 功能默认生效，不崩',
    (d.rpc.prompts[0] ?? '').includes('【闲聊时的说话方式'))
  const d2 = makeBridge({ chatStyleDir: styleDir })
  await d2.bridge.handleEvent(privateMsg(ADMIN, '帮我读一下 a.txt'))
  check('★ 老配置下工作态仍然逐字一致', normalizePrompt(d2.rpc.prompts[0] ?? '') === normalizePrompt(pWork))

  // ── 规则命中时**一次模型调用都不产生**（端到端）─────────────────────────
  let judgeCalls = 0
  const stubJudge = {
    judge: async () => {
      judgeCalls += 1
      return { verdict: MODE.CHAT, judged: true, fallback: false, reason: 'stub' }
    },
    budget: () => ({ used: judgeCalls, maxPerHour: 30 }),
  }
  const f = makeBridge({ chatStyleDir: styleDir, modeJudge: stubJudge })
  await f.bridge.handleEvent(privateMsg(ADMIN, '在吗'))
  await f.bridge.handleEvent(privateMsg(ADMIN, '帮我读一下 a.txt'))
  check('★★ 端到端：两条规则命中的消息**一次判定都没花**', judgeCalls === 0, `judge=${judgeCalls}`)

  await f.bridge.handleEvent(privateMsg(ADMIN, AMBIGUOUS_TEXT))
  check('★★ 端到端：拿不准的那条**花了一次判定**并采纳了结论（闲聊）',
    judgeCalls === 1 && (f.rpc.prompts[2] ?? '').includes('【闲聊时的说话方式'), `judge=${judgeCalls}`)

  // 判定器抛错 ⇒ 工作态（提示词里没有闲聊风格）
  const g = makeBridge({
    chatStyleDir: styleDir,
    modeJudge: {
      judge: async () => {
        throw new Error('判定炸了')
      },
      budget: () => ({}),
    },
  })
  await g.bridge.handleEvent(privateMsg(ADMIN, AMBIGUOUS_TEXT))
  const pg = g.rpc.prompts[0] ?? ''
  check('★★ 端到端：判定抛错 ⇒ 回落工作态（提示词里没有闲聊风格）',
    !pg.includes('【闲聊时的说话方式') && pg.includes('【怎么说话】'))

  // ── 「先应一声」只在工作态触发 ────────────────────────────────────────
  const w = makeBridge({ chatStyleDir: styleDir, slow: true })
  await w.bridge.handleEvent(privateMsg(ADMIN, '帮我读一下 a.txt'))
  check('★ 工作态 + 回合超时 → **发**「先应一声」',
    w.logs.some((l) => l.includes('先发一条')),
    w.logs.filter((l) => l.includes('先应一声') || l.includes('先发一条')).join(' | ') || '（没有"先发一条"）')

  const ch = makeBridge({ chatStyleDir: styleDir, slow: true })
  await ch.bridge.handleEvent(privateMsg(ADMIN, 'ciallo'))
  check('★★ 闲聊态 + 同一场景 → **不发**「先应一声」',
    !ch.logs.some((l) => l.includes('先发一条')),
    ch.logs.filter((l) => l.includes('先发一条')).join(' | '))
  check('★★ 闲聊态不发时要在日志里说清原因（不是静默跳过）',
    ch.logs.some((l) => l.includes('闲聊态') && l.includes('先应一声')),
    ch.logs.filter((l) => l.includes('[bridge] 闲聊态')).join(' | '))

  // ── ★★★ 三段发言分三次发（用户点名，2026-10-01）────────────────────────
  //
  // 实机事故：模型回了三段短句（空行分隔，共 101 字），**被糊成一个气泡发出去**。
  // 根因是 `splitIntoMessages` 第一行 `if (source.length <= maxChars) return [source]`
  // —— 短回复永远只有一条，于是闲聊风格里那句「常拆两条」从来不可能生效。
  const threePart = '被叫到、但我最后没吐出一个字的时候\n\n比如觉得这条不用接就没写正文；或者只写了会被系统剥掉的标记\n\n具体是哪条规则判定成空的，我这边看不到'
  const sp = makeBridge({ chatStyleDir: styleDir, reply: threePart })
  await sp.bridge.handleEvent(privateMsg(ADMIN, '什么情况下你会输出（没有产生回复内容）'))
  const bodies = sp.sent.filter((s) => s.text && s.text.trim())
  check('★★★ 三段短句 → **发了三条消息**（不是一个气泡里塞三段）',
    bodies.length === 3, `实际 ${bodies.length} 条：${JSON.stringify(bodies.map((b) => b.text.slice(0, 12)))}`)
  check('★ 三条的内容与顺序与原文一致',
    bodies[0]?.text === '被叫到、但我最后没吐出一个字的时候' &&
      bodies[2]?.text?.startsWith('具体是哪条规则'),
    JSON.stringify(bodies.map((b) => b.text)))
  check('★ 分条后正文一个字都没少（拼回去等于原文去掉空行）',
    bodies.map((b) => b.text).join('\n') === threePart.split(/\n\s*\n/).join('\n'),
    bodies.map((b) => b.text.length).join('+'))

  // 单段回复不能被拆（`ciallo~` 仍是一条）
  const single = makeBridge({ chatStyleDir: styleDir, reply: 'ciallo~' })
  await single.bridge.handleEvent(privateMsg(ADMIN, 'ciallo'))
  check('★ 单段回复仍然只发一条（不许把一句拆成两句）',
    single.sent.filter((s) => s.text && s.text.trim()).length === 1,
    JSON.stringify(single.sent.map((s) => s.text)))

  // ── 镜像：这条消息的态要能查（"它为什么这么短"是使用者第一个会问的）──
  const convs = a.bridge.listConversations?.() ?? []
  const msgs = convs?.[0]?.messages ?? []
  const userMsg = msgs.find((m) => m.role === 'user')
  check('★ 镜像里那条用户消息带上了 mode（界面/排查靠它）',
    userMsg?.mode === MODE.CHAT && Boolean(userMsg?.modeSource), String(userMsg?.mode ?? null))
} finally {
  for (const br of liveBridges) {
    try {
      await br.close(200)
    } catch {
      /* 收尾失败不影响断言结果 */
    }
  }
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 上偶尔删不掉，不该让测试红 */
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n${failures === 0 ? '🎉' : '⚠️'} 对话风格（闲聊/工作）测试${failures === 0 ? '全部通过' : `有 ${failures} 项失败`}（${passed} 项）`)
process.exit(failures === 0 ? 0 : 1)
