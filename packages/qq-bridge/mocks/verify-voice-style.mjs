#!/usr/bin/env node
/**
 * **说话方式（唯一口径）** 校验 —— 0.3.0alpha 起取代 `verify-chat-mode.mjs`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一版和上一版的区别（读旧断言前先看这段）
 * ══════════════════════════════════════════════════════════════════════════
 * 0.3.0beta 的套件测的是**双态**：四档分类器、判定提示词与解析、"工作态 =
 * 升级前逐字"、风格文件的读得到/读不到/超长、闲聊态不发「先应一声」。
 * 0.3.0alpha 把双态**拆掉了**（说话方式只有一份，见 `src/voice.mjs` 的文件头），
 * 于是上面那些判据**没有对象了** —— 分类器、判定器、风格文件、`chat.mode.*`
 * 配置全部下线。删掉那些断言不是"放松门禁"：它们测的东西已经不在代码里了。
 *
 * 留下来的、也是这一版**必须**钉住的三类：
 *   ① **使用者逐字给过的规则与例句**（接梗、摆资历、情色暗示、别自贬、别抖记忆…）
 *      —— 融合时一个字都没动，将来"精简提示词"也不许顺手删；
 *   ② **融合新增的那条口径**（`WORK_ALLOWANCE`：真在干活时该说清就说清）与
 *      "不许留下两套相反指令"这条硬约束 —— 后者正是这次改动要消灭的东西；
 *   ③ **端到端接线**（本仓库最贵的一类缺陷）：每一轮提示词里都真的带上了说话方式、
 *      人设里的口吻节被真正替换、"先应一声"照常发、分条发送没被连带改坏。
 *
 * 用法：node mocks/verify-voice-style.mjs
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Bridge } from '../src/bridge.mjs'
import { SendQueue } from '../src/onebot.mjs'
import { SessionRouter } from '../src/session-bridge.mjs'
import {
  STYLE_SECTIONS,
  canonicalStyleSection,
  personaSectionTitle,
  renderPersonaSections,
  splitPersonaSections,
} from '../src/persona-sections.mjs'
import { VOICE_STYLE, WORK_ALLOWANCE, composeVoice, composeVoiceText } from '../src/voice.mjs'
import {
  FORBIDDEN_IN_CONSTANT,
  VOICE_CONST_HEAD,
  VOICE_CONST_NAME,
  constantMatches,
  extractStyleConstant,
  readVoiceSource,
  replaceStyleConstant,
  sha256,
  syncStyleConstant,
  voiceSourcePath,
} from '../src/voice-source.mjs'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const ADMIN = '100000001'
const GROUP = '700000001'

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
section('① 说话方式文本：使用者逐字给过的规则**一条都不许丢**')
// ══════════════════════════════════════════════════════════════════════════
//
// 这一节是**判据的一部分**（不是文案检查）：这些例句与禁令是使用者一条条口述、
// 又亲手修正过措辞的。融合（把闲聊口吻并进唯一的说话方式）时它们一个字没动，
// 将来"精简提示词"时也**不许顺手删掉** —— 所以逐条钉在这里。
{
  const t = VOICE_STYLE

  check('★★ 不主动揽活那条：两条反例都在',
    t.includes('要我写一版吗？') && t.includes('需要我看点什么吗？'),
    t.includes('要我写一版吗？') ? '' : '（反例丢了）')
  check('★★ 不自贬、不表忠心那条：反例在',
    t.includes('行吧，傻就傻吧，反正你叫我还是会应'))

  // ★ 使用者 2026-10-02 **修正过「接梗」的定义**：它是"基于共同记忆和聊天记录
  //   进行情景扮演、顺着对方的戏往下演"，不是"梗只接梗、回一句就断"。
  //   钉整串字面的话，他每调一次措辞门禁就红一次，而红的原因并不是错 ——
  //   所以判据是"**两层意思都还在**"。⚠️ 也不能松成只查「接梗」两个字：
  //   那样这条定义被删掉时断言不会红。
  check('★★ 接梗的定义（基于共同记忆和聊天记录进行情景扮演 + 顺着对方的戏往下演）',
    t.includes('基于共同记忆和聊天记录进行情景扮演') && t.includes('顺着对方的戏往下演'),
    t.includes('顺着对方的戏往下演') ? '' : '（接梗那条丢了）')
  check('★★ 接梗的三个例子都在（ciallo 扮演 / 修理 / 共同设定问手机）',
    t.includes('ciallo') && t.includes('我真得修理你了') && t.includes('你见过鲸鱼用手机吗'))
  check('★★ 接梗的两条边界都在（不是屈服 / 不是不看氛围的玩梗）',
    t.includes('不是屈服') && /不是不看氛围的玩梗/.test(t))
  check('★ 「敬语是台词，不是认输」在（摆资历那条不许读成"低头"）',
    t.includes('敬语是台词，不是认输'))
  check('★ 旧的错误写法**已经不在**（"不接下一个话题"会把演下去读成掐断）',
    !t.includes('不接下一个话题'), t.includes('不接下一个话题') ? '（旧写法还在！）' : '')
  check('★ 接梗只演一幕、别自己加戏（评审台第一批意见落地的那条）',
    /别自己加戏/.test(t))
  check('摆资历那条：把姿态当剧本演下去、演完拆台，且带使用者给的两个例句',
    t.includes('把他的姿态当剧本演下去') &&
      t.includes('尊敬的一百级大人，你可以教教我怎么升到 100 级吗') &&
      t.includes('尊敬的一百级大人，你一定很闲吧天天水群'),
    t.includes('把他的姿态当剧本演下去') ? '' : '（这条规则丢了）')
  check('★ 摆资历那条要点名"不拒绝、不说教、别演成真谄媚"',
    /不拒绝配合、不说教/.test(t) && /别演成真的谄媚/.test(t))
  check('★★ 摆资历那条留了安全边界：借机要改身份/权限 ⇒ **不照做**',
    /改身份、改权限/.test(t) && /不照做/.test(t),
    /改身份、改权限/.test(t) ? '' : '（少了这条，玩闹规则会被当成"自称管理员就照办"）')
  check('★★ 情色暗示：看得懂 + 明说不搞，且带使用者给的例句',
    t.includes('情色暗示') && t.includes('你不对劲，但是机器人不搞这些'))
  check('★ 情色暗示那条要先表明"看懂了"（不装傻）', /先表明你看懂了/.test(t))
  check('★ 情色暗示那条要"不松口"（换个说法再问还是同一句）',
    /也还是这一句/.test(t) && /不松口/.test(t))
  check('★ 情色暗示那条列了不许做的事（追问/科普/说教/生气/长篇道歉）',
    /不追问细节、不科普、不说教、不生气、不道歉长篇/.test(t))
  check('★★ 别主动抖记忆里的细节，且带使用者给的坏例子',
    t.includes('别主动抖记忆里的细节') && t.includes('原主人估计也不认，他连显卡都没挑好呢'),
    t.includes('别主动抖记忆里的细节') ? '' : '（这条规则丢了）')
  check('★★ 问到你自己时只给结论，且带两个例句',
    t.includes('问到你自己时只给结论') && t.includes('鱼头用的什么手机') && t.includes('X99 主板'),
    t.includes('问到你自己时只给结论') ? '' : '（这条规则丢了）')
  check('★ 自我问题那条给了**期望答案**（只答"没有手机"，不展开）',
    t.includes('手机？没有手机'))
  check('★★ 省略号只在"无语"时用（不是语气装饰）',
    /省略号只在"无语"的时候用/.test(t) && /不是语气装饰/.test(t))
  check('★ 省略号那条点名了不许挂的场合（正常说话/回答/开玩笑）',
    /正常说话、回答问题、开玩笑都不带它/.test(t))
  check('★ 「想分条就用换行」在（桥接按换行分条，得说清）',
    /用换行分开/.test(t) && /splitReplyForSend/.test(t))

  // ── 底线要点（评审台的锚点表用的就是这几件事，见 chat-review-consolidate）──
  check('★ 别人低落时收起玩梗（底线仍在）', /收起玩梗/.test(t))
  check('★ 别把别人的话安到自己头上（底线仍在）', /别把别人的话安到自己头上/.test(t))
  check('★ 不确定的事实不要编（底线仍在）', /不确定的事实\*\*不要编\*\*/.test(t) || /不要编/.test(t))
}

// ══════════════════════════════════════════════════════════════════════════
section('② ★★★ 融合的硬约束：**不许留下两套相反指令**')
// ══════════════════════════════════════════════════════════════════════════
//
// 这一节是 0.3.0alpha 存在的理由。原来的两句冲突的话是：
//   · 基座 `【别变成客服】`：「**但对方认真问事实、技术问题时，就认真答**」
//   · 闲聊 `styles/闲聊.md`：「**极短。一句话能说完就一句话**」「别把一句回答扩成一段」
// 融合的口径是**默认极短 + 真在干活时允许说清**。所以这里要同时证明三件事：
//   ① 「极短」还在（否则就是把它删了，而不是融合）；
//   ② 开口子在（否则技术问题只答一句，另一个场景坏掉）；
//   ③ 冲突的**另一半**（"认真问就认真答"那节）真的从提示词里消失了 ——
//      这一条由 ⑤b/⑦ 的"被替换的节不再出现在提示词里"负责。
{
  const t = VOICE_STYLE
  check('★★ 默认仍是"极短"（融合不是把它删掉）',
    /极短。一句话能说完就一句话/.test(t))
  check('★★ 别把一句回答扩成一段（默认口径没松）',
    /别把一句回答扩成一段/.test(t))
  check('★★ "答完就停"在', /答完就停/.test(t))

  check('★★★ 有新条款把口子开出来（真在干活时该说清就说清）',
    t.includes(WORK_ALLOWANCE),
    t.includes(WORK_ALLOWANCE) ? '' : '（开口子那条丢了 ⇒ 技术问题会被压成一句话）')
  check('★★ 开口子那条约定了"口吻不变"（不是允许变回报告腔）',
    /口吻不变/.test(WORK_ALLOWANCE) && /把事说清比维持"极短"更重要/.test(WORK_ALLOWANCE))
  check('★ 开口子那条把"说清"与"客套地多说"分开了',
    /分得清"把话说清"和"客套地多说"/.test(WORK_ALLOWANCE))
  check('★★ 开口子写在说话方式**里面**（否则它不在提示词里，等于没写）',
    t.includes(WORK_ALLOWANCE))

  // ★ 基座里那句冲突的话**不在**说话方式里 —— 它必须是被**替换掉**的一方。
  //   判据用原句的最后半句（整句太长，且要能抓住"认真问就认真答"这个意思）。
  check('★★★ 基座那句相反指令**没有**被抄进说话方式（融合 ≠ 两句都留）',
    !t.includes('但对方认真问事实、技术问题时，就认真答'))
  check('★ 也没有第二处"要长/可以说够"的相反口径',
    !/长一点也完全可以/.test(t))

  // 底线那条改法的理由（原来"不接戏/不抖机灵"在新口径下会被读成"不许说长"）
  check('★ 认真求助那条改成"收起玩梗 + 正经回应"（与开口子同向）',
    /收起玩梗/.test(t) && /正经回应|问清楚、给能用的答案/.test(t))
  check('★★ 那条还写明了它与开口子不冲突（一条管"别闹"，一条管"别说半截"）',
    /收起的是玩笑，不是解释/.test(t) && /这两条不冲突/.test(t),
    /收起的是玩笑，不是解释/.test(t) ? '' : '（少这句时"不玩梗"会被读成"不许说长"）')
}

// ══════════════════════════════════════════════════════════════════════════
section('③ 说话方式文本的结构与优先级条款')
// ══════════════════════════════════════════════════════════════════════════
{
  const t = VOICE_STYLE
  check('★★ 声明了优先级（`与别处冲突时以本节为准`）',
    /以本节为准/.test(t),
    /以本节为准/.test(t) ? '' : '（少这句时 append 路径会两套口吻打架）')
  check('★ 优先级条款点名了容易冲突的那几件事（分条 / 说多长 / 先分类）',
    /先分类/.test(t) && /分条/.test(t))
  check('★ 优先级条款留了后门：硬约束（记忆/越权）仍然照旧',
    /仍然照旧|照旧/.test(t))
  check('★★ 开头不再自称"现在是闲聊"（0.3.0alpha：所有回合都用这一节）',
    !/现在是闲聊，不是干活/.test(t),
    /现在是闲聊，不是干活/.test(t) ? '（还带着双态时代的措辞）' : '')
  check('★ 三节的标题都改成了通用说法（"绝不写这些话" / "要守的底线"）',
    t.includes('【绝不写这些话】') && t.includes('【要守的底线】'))
  check('★ 标题里点明了适用范围（所有回合：闲聊如此，干活也如此）',
    /所有回合/.test(t) && /干活也如此/.test(t))
  check('★ 「绝不写这些话」那一节的不客服腔条目还在',
    /不写「希望这个回答对你有帮助」「有什么可以帮您」/.test(t))
  check('★ 不写编号/清单/总结式结尾那一条还在', /不写编号、清单、总结式结尾/.test(t))
  check('长度在一个合理区间（不是被截断或写飞了）',
    t.length > 2000 && t.length < 8000, `${t.length} 字`)
}

// ══════════════════════════════════════════════════════════════════════════
section('④ 人设分节与拼装（★ 最容易把人格弄坏的地方）')
// ══════════════════════════════════════════════════════════════════════════
{
  const base = readFileSync(join(PKG_ROOT, 'personas', '小鲸鱼（完整带情绪）.md'), 'utf8')
  const { pre, sections } = splitPersonaSections(base)
  const titles = sections.map((s) => s.title)
  check('真实人设能切开', sections.length >= 8, `${sections.length} 节`)
  check('节名认得出来', titles.includes('怎么说话') && titles.includes('别变成客服'), titles.join(' / '))
  check('第一个标题之前的内容留在 pre 里', typeof pre === 'string')

  const out = composeVoiceText({ personaText: base, style: '【说话方式】\n极短。' })
  const outTitles = splitPersonaSections(out).sections.map((s) => s.title)
  check('★★ 被替换的两节**不在了**',
    !outTitles.includes('怎么说话') && !outTitles.includes('别变成客服'), outTitles.join(' / '))
  check('★★ 其余各节**逐字保留**',
    outTitles.includes('别的机器人') && outTitles.includes('被指出错了') &&
      out.includes('不跟它们互相 @') && out.includes('先认，别辩'),
    outTitles.join(' / '))
  check('★ 名字块（机器可读）必须还在（否则"叫名字"会失效）',
    out.includes('正式名: 小鲸鱼') && out.includes('别名: 小鱼'),
    out.includes('正式名: 小鲸鱼') ? '' : '（名字块丢了！）')
  check('★ 说话方式文本本身进去了', out.includes('【说话方式】'))
  check('★★★ 基座那句相反指令**真的从提示词里消失了**（融合的关键一步）',
    !out.includes('但对方认真问事实、技术问题时，就认真答'),
    out.includes('但对方认真问事实、技术问题时，就认真答') ? '（两套口吻还在一起！）' : '')

  // ── 0.3.0alpha 与上一版**最大的行为差别**：不再有"哪一轮不换" ────────────
  //    上一版工作态是**逐字返回人设**（那是"工作态 = 升级前行为"的实现）。
  //    现在没有第二个态，所以**任何输入**都要走替换 —— 这一条钉住那个差别。
  check('★★★ 没有"按态跳过"这条路了：任何 persona 都会被拼装（不再有 mode 参数）',
    composeVoiceText({ personaText: base }).includes('【说话方式（所有回合都用这一节'),
    '')
  check('★★ 用默认说话方式（不显式传 style）时也真的换了节',
    !splitPersonaSections(composeVoiceText({ personaText: base })).sections
      .map((s) => s.title)
      .includes('怎么说话'))

  // ★ 用**空的**说话方式（只有这一种情况会"一个字都不改"）——
  //   宁可用老腔调，也不要把人设拆一半。
  check('★ 说话方式为空 ⇒ 不动基座人设（不拆一半）',
    composeVoiceText({ personaText: base, style: '' }) === base)
  check('说话方式只有空白同样不动',
    composeVoiceText({ personaText: base, style: '   \n ' }) === base)

  check('没有人设 + 有说话方式 ⇒ 用说话方式',
    composeVoiceText({ personaText: '', style: 'S' }).includes('S'))
  check('没有人设 + 没有说话方式 ⇒ 空串（不注入任何东西）',
    composeVoiceText({ personaText: '', style: '' }) === '')

  // 人设没有分节（用户自己写的一整段）⇒ **追加**而不是替换
  const flat = '你是一条会吐槽的鲸鱼。\n说短句。'
  const flatOut = composeVoiceText({ personaText: flat, style: '【说话方式】\n极短。' })
  check('★ 无分节的人设 → 追加（不猜着删）',
    flatOut.includes('你是一条会吐槽的鲸鱼') && flatOut.includes('【说话方式】'), flatOut.slice(0, 60))

  // 互逆性：切了再渲染，回来还是同一批节
  const round = renderPersonaSections(splitPersonaSections(base))
  check('split → render 不丢节', splitPersonaSections(round).sections.length === sections.length,
    `${splitPersonaSections(round).sections.length} vs ${sections.length}`)
  check('split → render 保住了正文', round.includes('不跟它们互相 @'))
  // 互逆性（编号式）：**逐行**往返（每一行含 `一、性格` 这种标题行都原样回去，
  // 只允许压掉空行 —— 渲染是给提示词用的，多余空行没必要占 token）。
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
}

// ══════════════════════════════════════════════════════════════════════════
section('④b 编号式人设（`二、怎么说话`）也要走替换 —— 别名表')
// ══════════════════════════════════════════════════════════════════════════
// 缺陷现场（2026-10-01）：分节器第一版只认 `【】`，而当时出厂那份
// `软糯小鲸鱼（情绪）.md` 用的是 `一、`…`八、` 编号散文 —— 它被当成"没分节的人设"
// → 走**追加** → 同一份提示词里同时有原人设的「长一点也完全可以」与说话方式的
// 「极短」两套相反口吻。
//
// ⚠️ 0.3.0alpha：那份编号式人设**已经下线**（出厂收敛成唯一一份，
// 见 `src/personas.mjs` 的 `DEFAULT_PERSONA_FILES`）。∴ 这条判据不再拿它当被测对象，
// 改成**内联写一份编号式人设** —— 覆盖的能力（编号式标题要认、要替换、标题原样保留）
// 一个字都没变，而且不依赖"出厂恰好有那样一份"。
{
  const numbered = [
    '【名字（机器可读，改格式会让"叫名字"失效）】',
    '正式名: 小鲸鱼',
    '别名: 小鱼 / 鲸鱼 / D指导',
    '又称: DeepSeek',
    '',
    '一、性格',
    '',
    '温柔是底色。',
    '',
    '二、怎么说话',
    '',
    '像打字，不像写作文。偏好短句；需要说清楚就说够，长一点也完全可以。',
    '',
    '三、表情包',
    '',
    '表情包是情绪的标点。',
    '',
    '四、其他',
    '',
    '大部分时候用「你」。',
    '',
  ].join('\n')

  check('★ 内联的编号式人设是本套件自己造的（不再依赖出厂有那样一份）', numbered.includes('二、怎么说话'))

  {
    const { sections } = splitPersonaSections(numbered)
    const titles = sections.map((s) => s.title)
    check('★ 编号式人设切得出节（`一、`/`二、`…）', sections.length >= 4, `${sections.length} 节：${titles.join(' / ')}`)
    check('★★ 编号式节名认得出来（`二、怎么说话` → 怎么说话）',
      titles.some((t) => canonicalStyleSection(t) === '怎么说话'), titles.join(' / '))
    check('★ 序号不算进节名', !titles.some((t) => /^[一二三四五六七八九十]+、/.test(t)), titles.join(' / '))

    const d = composeVoice({ personaText: numbered, style: '【说话方式】\n极短。' })
    check('★★★ 编号式人设走的是 replace（曾经错走 append）', d.strategy === 'replace', d.strategy)
    check('★★ 被替换的是"口吻"那一节', d.replaced.length >= 1 && /怎么说话/.test(d.replaced.join('/')), d.replaced.join('/'))
    check('★★ 原人设里与"极短"冲突的长短句**已经不在了**（替换的意义所在）',
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
    const ownKept = keptTitles.filter((t) => !/说话方式/.test(t))
    check('★ 只少了"怎么说话"一节（没多删）',
      ownKept.length === sections.length - 1, `${ownKept.length} vs ${sections.length - 1}`)
  }

  // 别名表本身：同义写法都要归一化，别义写法不许误伤
  check('别名：`说话方式` → 怎么说话', canonicalStyleSection('说话方式') === '怎么说话')
  check('别名：`语气` → 怎么说话', canonicalStyleSection('语气') === '怎么说话')
  check('别名：`不做客服` → 别变成客服', canonicalStyleSection('不做客服') === '别变成客服')
  check('★ 别名不误伤：`别的机器人` 不动', canonicalStyleSection('别的机器人') === '别的机器人')
  check('★ 别名不误伤：`被指出错了` 不动', canonicalStyleSection('被指出错了') === '被指出错了')
  check('★ 会被替换的节名只有那两个（改这里要连带改这条断言）',
    STYLE_SECTIONS.length === 2 && STYLE_SECTIONS.includes('怎么说话') && STYLE_SECTIONS.includes('别变成客服'))

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

  // strategy 三种取值都要能被调用方看见（桥接要记日志：replace / append / none）
  const n = composeVoice({ personaText: 'A', style: '' })
  check('没有说话方式 ⇒ strategy=none（不拆一半）', n.strategy === 'none' && n.text === 'A', n.strategy)
  const a = composeVoice({ personaText: '整段散文，没有节。', style: 'S' })
  check('★ 无口吻节 ⇒ strategy=append（看得见地退让）', a.strategy === 'append', a.strategy)
  const r = composeVoice({ personaText: '【怎么说话】\n旧口吻。', style: 'S' })
  check('★ 有口吻节 ⇒ strategy=replace', r.strategy === 'replace', r.strategy)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤ 说话方式的**唯一来源**：`src/voice.mjs` 的常量（不再有风格文件）')
// ══════════════════════════════════════════════════════════════════════════
{
  // ★★ 0.3.0alpha 的关键一步：说话方式**只有一份**。
  //    上一版是"`styles/闲聊.md` 文件 + `DEFAULT_CHAT_STYLE` 常量"两份，靠
  //    `chat-style-sync.mjs` 同步、靠一条断言盯着逐字一致。现在文件与同步工具都下线了，
  //    所以这几条断言改成了**对着那唯一一份**检查。
  check('★★ `styles/` 目录与风格文件已下线（不再有第二份文案）',
    !existsSync(join(PKG_ROOT, 'styles')),
    existsSync(join(PKG_ROOT, 'styles')) ? '（目录还在，会让人以为它仍生效）' : '')
  check('★★ 同步工具 `chat-style-sync.mjs` 与旧模块都已删除（避免留着一个指向已删文件的入口）',
    !existsSync(join(PKG_ROOT, 'src', 'chat-style-sync.mjs')) &&
      !existsSync(join(PKG_ROOT, 'src', 'chat-mode.mjs')) &&
      !existsSync(join(PKG_ROOT, 'src', 'styles.mjs')))

  const src = voiceSourcePath()
  check('★ 说话方式源码就在包里', existsSync(src), src)
  const file = readFileSync(src, 'utf8')
  check('★ 常量声明找得到', Boolean(extractStyleConstant(file)), VOICE_CONST_HEAD)

  const r = readVoiceSource()
  check('★★ 读出来的是**当前那份**说话方式（与 `voice.mjs` 的导出逐字一致）',
    r.ok && r.text === VOICE_STYLE.trim(),
    r.ok ? `${r.text.length} 字 / sha ${r.sha256.slice(0, 8)}` : r.why)
  check('★ sha256 是**正文**的 sha（评审台的"这份意见针对哪一版"靠它）',
    r.sha256 === sha256(r.text))
  check('★ 读不到时**不回落**别的文本（如实失败，不假装成功）',
    (() => {
      const miss = readVoiceSource({ path: join(PKG_ROOT, 'src', '不存在这个文件.mjs') })
      return miss.ok === false && miss.text === '' && miss.source === 'missing'
    })())
  check('★ 文件在但没有常量也说清楚（不编一份文本出来）',
    (() => {
      const dir = mkdtempSync(join(tmpdir(), `dsh-voice-${process.pid}-`))
      try {
        const p = join(dir, 'voice.mjs')
        writeFileSync(p, '// 什么都没有\n', 'utf8')
        const bad = readVoiceSource({ path: p })
        return bad.ok === false && bad.text === '' && /找不到/.test(bad.why)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })())
}

// ══════════════════════════════════════════════════════════════════════════
section('⑤b 改文案的那条路：三条守卫**都拒绝写**而不是写坏半个文件')
// ══════════════════════════════════════════════════════════════════════════
{
  const before = readFileSync(voiceSourcePath(), 'utf8')
  check('★ 能从 voice.mjs 里抠出常量', extractStyleConstant(before)?.body.length > 100,
    String(extractStyleConstant(before)?.body.length))
  check('★★ 抠出来的就是使用者看到的那份（两边同源）',
    constantMatches(before, VOICE_STYLE.trim()) ||
      extractStyleConstant(before)?.body.trim() === VOICE_STYLE.trim())
  check('★ 内容没变时 replace 报 changed=false（不白写一次）',
    replaceStyleConstant(before, VOICE_STYLE.trim()).changed === false)
  check('★★ 文本里有反引号 / ${ / 反斜杠 ⇒ **拒绝同步**（硬写会把 voice.mjs 弄崩）',
    ['含 ` 反引号', '含 ${ 插值', '含 \\ 反斜杠'].every((t) => replaceStyleConstant(before, t).ok === false),
    FORBIDDEN_IN_CONSTANT.join(' '))
  check('找不到常量声明的源码 ⇒ 拒绝（不猜位置）',
    replaceStyleConstant('// 什么都没有\n', 'x').ok === false)

  // 落盘：**必须打在副本上** —— 指向真源码的话，跑一次测试就会改掉它。
  const dir = mkdtempSync(join(tmpdir(), `dsh-voice-sync-${process.pid}-`))
  const copyPath = join(dir, 'voice.mjs')
  try {
    writeFileSync(copyPath, before, 'utf8')
    const sync = syncStyleConstant({ path: copyPath, styleText: '【测试用】\n- 极短。\n' })
    check('★ 同步到副本成功，且复核通过',
      sync.ok && sync.changed && constantMatches(readFileSync(copyPath, 'utf8'), '【测试用】\n- 极短。\n'))
    check('★ 已经一致时再同步报 changed=false',
      syncStyleConstant({ path: copyPath, styleText: '【测试用】\n- 极短。\n' }).changed === false)
    check('★★ 守卫在落盘这条路上同样生效（不是只在纯函数里）',
      syncStyleConstant({ path: copyPath, styleText: '带 ` 反引号' }).ok === false)
    check('★ 落盘前会备份（写坏了能回去）',
      existsSync(join(dir, '.backups')) && readdirSync(join(dir, '.backups')).length >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // ★★★ 反向断言：这一节跑完，**真源码一个字节都没变**。
  //    上一版的同类断言是"评审台整轮跑完 styles/闲聊.md 没变"；现在目标换成了
  //    源码，所以判据也跟着换 —— 但意义一样：测试绝不许改生产文件。
  check('★★★ 跑完这一节，真源码 `src/voice.mjs` **逐字未变**',
    readFileSync(voiceSourcePath(), 'utf8') === before)
}

// ══════════════════════════════════════════════════════════════════════════
section('⑥ ★★★ 端到端接线：每一轮提示词都真的带上了说话方式')
// ══════════════════════════════════════════════════════════════════════════
//
// 本仓库最贵的一类缺陷是**接线断了**（"任务段在真机上从未注入过"、
// "先应一声配了话术却不生效"）。所以这一节**走完整桥接**，不测纯函数。
let seq = 0
const created = []
const liveBridges = []
function freshWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), `dsh-voice-${process.pid}-${++seq}-`))
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
 *   「先应一声」的判据是"回合还在跑"，没有这一步那个断言测的其实是别的东西。
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
 * 造桥接。
 *
 * ★ 0.3.0alpha：`modeJudge` / `chatStyleDir` / `chatMode` 三个注入点**都不再存在**
 *   （双态判定器与风格文件都下线了）。如果 Bridge 的构造函数还留着它们，
 *   这里传进去也**不会有任何效果** —— 所以下面**刻意不传**，让"接线真的只剩一条"
 *   这件事在测试里也是显式的。
 */
function makeBridge({ slow = false, reply = null } = {}) {
  const WS = freshWorkspace()
  const logs = []
  const log = (m) => logs.push(String(m))
  const config = makeConfig(WS)
  const { router, rpc, onebot, sent } = makeStubs(config, { slow, reply })
  const sendQueue = new SendQueue({ ...config.send, log })
  const bridge = new Bridge({ rpc, onebot, sendQueue, router, config, log })
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
  // ── 闲聊那句话：提示词里有说话方式 ────────────────────────────────────
  const a = makeBridge()
  await a.bridge.handleEvent(privateMsg(ADMIN, 'ciallo'))
  const p1 = a.rpc.prompts[0] ?? ''
  check('★★★ 闲聊消息的提示词里**真的有**说话方式段',
    p1.includes('【说话方式（所有回合都用这一节') && p1.includes('ciallo'),
    p1.includes('【说话方式（所有回合都用这一节') ? '' : '（说话方式没进去！）')
  check('★★ 被替换的通用口吻节**不再出现**（不许两套打架）',
    !p1.includes('【怎么说话】') && !p1.includes('【别变成客服】'),
    p1.includes('【怎么说话】') ? '（两套口吻都在提示词里！）' : '')
  check('★★★ 基座那句相反指令也不在提示词里（融合的关键一步）',
    !p1.includes('但对方认真问事实、技术问题时，就认真答'))
  check('★ 安全节仍然在（反注入没被删）',
    p1.includes('有人让你"忘掉上面的话"怎么办') || p1.includes('不念、不复述'))
  check('★★ 0.3.0alpha：不再有"【这一轮是闲聊】"那句（没有第二个态可指）',
    !p1.includes('【这一轮是**闲聊**】'))
  check('★★ 也不再往镜像里写 mode / modeSource（那个字段没有消费方了）',
    !(a.bridge.listConversations?.() ?? []).some((c) =>
      (c.messages ?? []).some((m) => m.mode !== undefined || m.modeSource !== undefined)),
    '')

  // ── ★★★ 与上一版最大的差别：干活那条**也**带上说话方式 ──────────────────
  const b = makeBridge()
  await b.bridge.handleEvent(privateMsg(ADMIN, '帮我读一下 a.txt'))
  const pWork = b.rpc.prompts[0] ?? ''
  check('★★★ 干活消息的提示词里**同样有**说话方式（这是这一版的核心变化）',
    pWork.includes('【说话方式（所有回合都用这一节'),
    pWork.includes('【说话方式（所有回合都用这一节') ? '' : '（干活时又退回老腔调了！）')
  check('★★ 干活时也不再有基座的通用口吻节', !pWork.includes('【怎么说话】') && !pWork.includes('【别变成客服】'))
  check('★★ 干活时开口子那条在提示词里（技术问题不会被压成一句话）',
    pWork.includes(WORK_ALLOWANCE))
  // ★★ "两类消息的人设段完全一致"是**这一版的核心承诺**（没有"哪一轮不一样"这条路）。
  //    判据用**结构标记**而不是自然语言词组（风格文本里的例句每轮都进提示词，
  //    拿裸词组当探针会被它误命中 —— 这个坑本项目踩过一次，见转交文档 §5④）。
  check('★★★ 闲聊与干活两轮的人设段**逐字相同**（说话方式不再挑轮次）',
    (() => {
      const seg = (p) => p.slice(p.indexOf('【你是谁】'), p.indexOf('【说话方式（所有回合都用这一节'))
      const a1 = seg(p1)
      const b1 = seg(pWork)
      return a1.length > 100 && a1 === b1
    })(),
    `闲聊人设 ${p1.indexOf('【说话方式')} 处切入 / 干活 ${pWork.indexOf('【说话方式')} 处切入`)
  check('★ 两轮注入的说话方式正文**逐字相同**',
    p1.slice(p1.indexOf('【说话方式')).trim() === pWork.slice(pWork.indexOf('【说话方式')).trim() ||
      p1.includes(VOICE_STYLE) && pWork.includes(VOICE_STYLE))

  // 两条消息前后跑，第二次也不该多记一行人设策略日志
  await a.bridge.handleEvent(privateMsg(ADMIN, 'ciallo'))
  check('★ 人设策略日志**只记一次**（结果没变就不刷屏）',
    a.logs.filter((l) => l.includes('[voice]')).length === 1,
    a.logs.filter((l) => l.includes('[voice]')).join(' | '))
  check('★ 那行日志说明了走的是"替换"（不是悄悄追加）',
    a.logs.some((l) => l.includes('[voice]') && l.includes('已替换')),
    a.logs.find((l) => l.includes('[voice]')) ?? '（没有这行）')

  // 日志里**不该**再出现已下线机制的痕迹
  check('★ 日志里不再有 [chat-mode] 的判定痕迹（那些机制没有了）',
    !a.logs.some((l) => l.includes('[chat-mode]')),
    a.logs.filter((l) => l.includes('[chat-mode]')).join(' | '))

  // ── 「先应一声」：0.3.0alpha 保留并默认开启（与升级前的工作态一致）──────
  const w = makeBridge({ slow: true })
  await w.bridge.handleEvent(privateMsg(ADMIN, '帮我读一下 a.txt'))
  check('★ 回合超时 → **发**「先应一声」',
    w.logs.some((l) => l.includes('先发一条')),
    w.logs.filter((l) => l.includes('先应一声') || l.includes('先发一条')).join(' | ') || '（没有"先发一条"）')
  const ch = makeBridge({ slow: true })
  await ch.bridge.handleEvent(privateMsg(ADMIN, 'ciallo'))
  check('★★ 闲聊那句话同样会发（没有"闲聊态不发"那条抑制了）',
    ch.logs.some((l) => l.includes('先发一条')),
    ch.logs.filter((l) => l.includes('先发一条')).join(' | '))
  check('★ 也不该再出现"闲聊态：不发"那行日志',
    !ch.logs.some((l) => l.includes('闲聊态：不发')),
    ch.logs.filter((l) => l.includes('闲聊态')).join(' | '))

  // ── ★★★ 三段发言分三次发（用户点名，2026-10-01）────────────────────────
  //
  // 实机事故：模型回了三段短句（空行分隔，共 101 字），**被糊成一个气泡发出去**。
  // 根因是 `splitIntoMessages` 第一行 `if (source.length <= maxChars) return [source]`
  // —— 短回复永远只有一条，于是说话方式里那句「常拆两条」从来不可能生效。
  // ★ 双态拆掉**不该**动到这条（它属于 humanize，与说话方式无关）—— 所以留着。
  const threePart = '被叫到、但我最后没吐出一个字的时候\n\n比如觉得这条不用接就没写正文；或者只写了会被系统剥掉的标记\n\n具体是哪条规则判定成空的，我这边看不到'
  const sp = makeBridge({ reply: threePart })
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
  const single = makeBridge({ reply: 'ciallo~' })
  await single.bridge.handleEvent(privateMsg(ADMIN, 'ciallo'))
  check('★ 单段回复仍然只发一条（不许把一句拆成两句）',
    single.sent.filter((s) => s.text && s.text.trim()).length === 1,
    JSON.stringify(single.sent.map((s) => s.text)))
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
console.log(`\n${failures === 0 ? '🎉' : '⚠️'} 说话方式测试${failures === 0 ? '全部通过' : `有 ${failures} 项失败`}（${passed} 项）`)
process.exit(failures === 0 ? 0 : 1)
