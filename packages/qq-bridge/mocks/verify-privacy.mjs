/**
 * 隐私硬闸测试：七类判据 + **双侧**拦截 + 公开标识不误拦。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一套里最容易被忽略、也最要紧的一组是「**不许误拦**」
 * ══════════════════════════════════════════════════════════════════════════
 * 隐私闸门有一个和其他功能不同的性质：**它拦错的代价是"功能整体失效"**。
 *   · 把 QQ 号/群号当隐私拦掉 → 记忆系统拿不到主键，**整个记忆功能死掉**
 *   · 把"token 用量"当凭据拦掉 → 常用词全被拒，用户以为机器人坏了
 *   · 把"主板卡在 POST 码 B7"当健康信息拦掉 → 技术讨论全被拒
 *
 * 所以下面专门有一节拿**真实记忆的原文**当负例（那 60 条实测数据），
 * 它们**必须全部通过**。正例只在"构造的、形状明确的"隐私上验。
 *
 * ⚠️ 另一条纪律：审计**只记类别与字数，不记原文**。
 *    否则"记下被拦了什么"这件事本身就成了新的泄露通道。这一条也有断言。
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  scanPrivacy,
  screenForStore,
  screenForOutput,
  mayContainPrivacy,
  isValidIdCard,
  isValidLuhn,
  logPrivacyBlock,
  readPrivacyAudit,
  PRIVACY_CATEGORIES,
  BLOCKED_OUTPUT_NOTICE,
} from '../src/privacy.mjs'
import { applyMemoryItems, listMemoryFiles } from '../src/memory-store.mjs'

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

const ROOT = mkdtempSync(join(tmpdir(), 'qq-bridge-privacy-'))

try {
  // ══════════════════════════════════════════════════════════════════════════
  section('① 校验算法本身（不能靠"位数像"就判定）')
  // ══════════════════════════════════════════════════════════════════════════
  check('身份证：合法号通过校验', isValidIdCard('11010519491231002X') === true)
  check('身份证：末位错 → 不通过', isValidIdCard('110105194912310021') === false)
  check('身份证：出生日期非法 → 不通过', isValidIdCard('11010519491332002X') === false)
  check('身份证：17 位 → 不通过', isValidIdCard('11010519491231002') === false)
  check('Luhn：合法卡号通过', isValidLuhn('4111111111111111') === true)
  check('Luhn：全 1 → 不通过', isValidLuhn('1111111111111111') === false)
  check('Luhn：QQ 号长度不够 → 不通过', isValidLuhn('100000001') === false)

  // ══════════════════════════════════════════════════════════════════════════
  section('② 七类正例：每一类都要真的拦得住')
  // ══════════════════════════════════════════════════════════════════════════
  const POSITIVE = [
    ['身份证是 11010519491231002X', 'idcard'],
    ['手机号 13800138000 打不通', 'phone'],
    ['卡号 4111111111111111', 'bankcard'],
    ['api_key = sk-abcdefghijklmnopqrstuvwx', 'credential'],
    ['密码：hunter2xyz', 'credential'],
    ['password: mysecretvalue', 'credential'],
    ['他家住浙江省杭州市西湖区文三路 100 号', 'address'],
    ['他的诊断结果是重度抑郁症', 'health'],
    ['录过他的指纹数据', 'biometric'],
  ]
  for (const [text, cat] of POSITIVE) {
    const r = scanPrivacy(text)
    check(`拦得住：${PRIVACY_CATEGORIES[cat]}`, r.hit === true && r.categories.includes(cat),
      `${JSON.stringify(text)} → ${JSON.stringify(r.categories)}`)
  }
  check('七类都有对应的中文名', Object.keys(PRIVACY_CATEGORIES).length === 7,
    Object.values(PRIVACY_CATEGORIES).join('、'))

  // ══════════════════════════════════════════════════════════════════════════
  section('③ ★★ 公开标识与常用词：**一条都不许误拦**')
  // ══════════════════════════════════════════════════════════════════════════
  const NEGATIVE = [
    // 公开标识（拦了记忆系统直接死）
    'QQ 100000001 是管理员',
    '群号 700000001',
    '私聊 private:100000001',
    'memory/group-700000001.md',
    '100000001：管理员，会让小鲸鱼记东西',
    // 日期 / 时间戳 / 用量
    '2026-09-26 他在做 MC 服务器',
    '时间戳 1790426795741',
    'token 用量是 1500000',
    '单条上限 send.maxCharsPerMessage（默认 1500 字）',
    '回复 705 字，思考+工具 17044ms，工具 2 次',
    // 技术讨论（实测条目）
    '他的 MC 服务器是 Forge 端（还没说版本）',
    '主板卡在 POST 码 B7，重插内存后恢复',
    '单条上限 send.maxCharsPerMessage（默认 1500 字）',
    '看了一整星期的英雄联盟比赛',
    'store/ 是工作区里的堆放点：data/ 放数据，apps/ 放工具',
    '看 QQ 图片的可行链路：get_image 拿到 url → 用 node fetch 下到 tmp/ → read_image',
    '记忆的写入者：**只有桥接**',
    '唤醒规则：只有三类会让我回话——私聊、群里被 @、群里命中关键词表',
    '桥接当前是 0.2.0。发布包放在项目的 _release/ 下',
    '【模型】跑在 dsh 的 sdk profile 里',
    '配置接口已监听 http://127.0.0.1:3410（仅本机可访问）',
    // 看似像但校验不过
    '1111111111111111 不是卡号',
    '110105194912310021 校验位不对，不是身份证',
  ]
  for (const text of NEGATIVE) {
    const r = scanPrivacy(text)
    check(`不误拦：${text.slice(0, 30)}`, r.hit === false, JSON.stringify(r.categories))
  }

  section('④ 真实记忆原文逐条过一遍（这是最有说服力的一组）')
  {
    // 直接读真实工作区里的记忆文件 —— 它们**必须全部通过**。
    // 用相对路径，从 mocks/ 上溯到包根。
    const realWs = join(process.cwd(), 'workspace-qq')
    let scanned = 0
    let hits = 0
    if (existsSync(realWs)) {
      for (const rel of listMemoryFiles(realWs)) {
        let text = ''
        try {
          text = readFileSync(join(realWs, rel), 'utf8')
        } catch {
          continue
        }
        for (const line of text.split('\n')) {
          const t = line.replace(/^-\s*/, '').trim()
          if (!t || t.startsWith('#')) continue
          scanned += 1
          const r = scanPrivacy(t)
          if (r.hit) {
            hits += 1
            console.log(`     ❌ 误拦 ${rel}: ${JSON.stringify(t.slice(0, 60))} → ${r.categories}`)
          }
        }
      }
    }
    check(
      `★★ 真实记忆 ${scanned} 条零误拦`,
      hits === 0 && scanned > 0,
      `扫了 ${scanned} 条，误拦 ${hits} 条`,
    )
  }

  // ══════════════════════════════════════════════════════════════════════════
  section('⑤ 双侧入口：判据一致（不能一边拦一边放）')
  // ══════════════════════════════════════════════════════════════════════════
  const SAMPLE = [
    '身份证 11010519491231002X',
    'QQ 100000001 是管理员',
    '密码：hunter2xyz',
    '2026-09-26 他在做 MC 服务器',
  ]
  for (const t of SAMPLE) {
    const a = screenForStore(t)
    const b = screenForOutput(t)
    check(`两侧判定一致：${t.slice(0, 24)}`, a.ok === b.ok && (a.ok || a.why === b.why),
      `store=${a.ok} output=${b.ok}`)
  }
  check('拒绝时 `why` 带中文类别名（回执要给人看）',
    /隐私信息/.test(screenForStore('手机号 13800138000').why ?? ''),
    screenForStore('手机号 13800138000').why)
  check('输出侧安全话术**不含任何原文片段**',
    !BLOCKED_OUTPUT_NOTICE.includes('13800138000') && BLOCKED_OUTPUT_NOTICE.includes('不方便'))

  section('⑥ mayContainPrivacy 只能用来预筛（宁可多跑不可漏）')
  check('长数字串 → 需要细看', mayContainPrivacy('身份证 11010519491231002X') === true)
  check('凭证关键词 → 需要细看', mayContainPrivacy('password: x') === true)
  check('纯中文闲聊 → 不需要细看', mayContainPrivacy('今天天气不错') === false)
  check('★ 预筛为 false 时完整判定也确实没命中（预筛不能漏）', (() => {
    const t = '今天天气不错'
    return mayContainPrivacy(t) === false && scanPrivacy(t).hit === false
  })())

  // ══════════════════════════════════════════════════════════════════════════
  section('⑦ 写入侧：真的拒绝落盘，且回执说明原因')
  // ══════════════════════════════════════════════════════════════════════════
  const WS = join(ROOT, 'ws')
  mkdirSync(WS, { recursive: true })
  const logs = []
  const out = applyMemoryItems({
    workspace: WS,
    kind: 'private',
    // ⚠️ 这里的 peerId 本身就是"公开标识"——它能通过闸门，是这一节的前提
    peerId: '100000001',
    senderId: '100000001',
    tier: 'admin',
    items: [
      { scope: 'fact', text: '我的手机号是 13800138000' },
      { scope: 'fact', text: '他在做 MC 服务器' },
    ],
    log: (m) => logs.push(m),
  })
  check('★ 含隐私的那条被拒', out.ignored.length === 1 && out.applied.length === 1,
    JSON.stringify({ applied: out.applied.length, ignored: out.ignored.length }))
  check('★★ 拒绝理由说明"隐私"（回执会带回给模型）',
    /隐私/.test(out.ignored[0]?.why ?? ''), out.ignored[0]?.why)
  check('正常那条**照常落盘**（闸门不能把整批都拒掉）',
    readFileSync(join(WS, 'memory', 'private-100000001.md'), 'utf8').includes('MC 服务器'))
  check('★ 磁盘上**没有**那个手机号', (() => {
    try {
      const t = readFileSync(join(WS, 'memory', 'private-100000001.md'), 'utf8')
      return !t.includes('13800138000')
    } catch {
      return false
    }
  })())

  section('⑧ 写入侧审计：只记类别与字数，**不记原文**')
  {
    const audit = readPrivacyAudit({ workspace: WS, limit: 10 })
    check('产生了审计记录', audit.length === 1, JSON.stringify(audit))
    check('记了 side=store 与类别', audit[0]?.side === 'store' && audit[0]?.categories?.includes('phone'),
      JSON.stringify(audit[0]))
    check('记了字数（便于判断"反复被拒"）', audit[0]?.length === '我的手机号是 13800138000'.length,
      String(audit[0]?.length))
    const raw = readFileSync(join(WS, 'memory', 'privacy-audit.jsonl'), 'utf8')
    check('★★ 审计原文里**没有**隐私内容（否则拦截本身成了泄露通道）',
      !raw.includes('13800138000'), raw.slice(0, 120))
  }

  section('⑨ 审计坏掉不影响拦截本身')
  {
    // 把审计文件变成目录，让 appendFileSync 必然失败
    const WS2 = join(ROOT, 'ws2')
    mkdirSync(join(WS2, 'memory', 'privacy-audit.jsonl'), { recursive: true })
    let threw = false
    let r = null
    try {
      r = applyMemoryItems({
        workspace: WS2,
        kind: 'private',
        peerId: '1',
        senderId: '1',
        tier: 'admin',
        items: [{ scope: 'fact', text: '密码：hunter2xyz' }],
        log: () => {},
      })
    } catch {
      threw = true
    }
    check('★ 审计写不进去也**不抛异常**（拦截优先于记账）', threw === false)
    check('★ 该拒的仍然被拒（不因审计失败而放行）', r?.ignored?.length === 1, JSON.stringify(r?.ignored))
    check('logPrivacyBlock 自身失败时返回 false 而非抛', logPrivacyBlock({
      workspace: join(ROOT, 'nonexistent\0bad'),
      side: 'store',
      categories: ['phone'],
    }) === false)
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log('')
if (failed === 0) {
  console.log(`🎉 隐私硬闸测试全部通过（${passed} 项）`)
  process.exit(0)
} else {
  console.log(`❌ ${failed} 项失败 / ${passed} 项通过`)
  process.exit(1)
}
