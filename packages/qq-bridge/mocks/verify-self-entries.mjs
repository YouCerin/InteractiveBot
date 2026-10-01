// 回归断言：机器人自述的识别与压缩（2026-10-01 用户要求：简化 + 降权）。
// 用法：node mocks/verify-self-entries.mjs
import { isBotSelfEntry, compactSelfEntry } from '../src/self-entries.mjs'

let failures = 0
let passed = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (ok) passed += 1
  else failures += 1
}
function section(t) {
  console.log(`\n── ${t} ──────────────────────────────`)
}

// 真机上真实落过的那条（个人档里，40+ 字）
const REAL =
  '（我许的诺）往外写、改、删，或者跑那种会落到工作区外面的操作，都会被挡下来 —— ' +
  '这种时候我会直接跟你说一句"这个我暂时没权限"，不会硬试'

section('① 该认出来的：机器人在讲自己（能力/边界）')
{
  check('★★ 真机那条（工作区边界 + 我会跟你说没权限）', isBotSelfEntry(REAL).hit === true)
  check('  给出理由（回执要能看懂）', /机器人在讲自己/.test(isBotSelfEntry(REAL).why ?? ''), String(isBotSelfEntry(REAL).why))
  check('★ 「我这边只能看，不能动手」也是自述', isBotSelfEntry('我这边只能看，不能动手').hit === true)
  check('★ 「我没有权限删文件」', isBotSelfEntry('我没有权限删文件').hit === true)
  check('★ 「往外写会被系统拒绝」+ 第一人称', isBotSelfEntry('我往外写会被系统拒绝').hit === true)
  check('★ 「我这边不主动插话」', isBotSelfEntry('我这边不主动插话').hit === true)
  check('★ 「需要审批的操作我做不了」', isBotSelfEntry('需要审批的操作我做不了').hit === true)
}

section('② 不许误杀：关于对方的条目、正常承诺、别人的话')
{
  const mustNot = [
    ['他工作很忙，而且很累，工作内容要依靠电脑（用户给的正例）', '关于对方的事实'],
    ['（我许的诺）我明天帮你查那个仓库', '机器人自己的承诺（真正的承诺）'],
    ['（对方许的诺）他周四给你看结果', '对方许的诺'],
    ['他说我上次答应的事没做', '关于对方的陈述，含"我"'],
    ['我提醒 Forge 与 Paper 的差别', '机器人做过的动作，但与边界无关'],
    ['（我许的诺）我这边会继续盯着这件事', '承诺 + 我这边，但不是边界'],
    ['他玩原神，写 Python', '爱好/技术栈'],
    ['他一般凌晨一点还在', '活跃时段'],
    ['他住学校', '生活事实'],
  ]
  for (const [text, why] of mustNot) {
    check(`不许误杀：${why}`, isBotSelfEntry(text).hit === false, text.slice(0, 34))
  }
  check('空串/undefined 不崩', isBotSelfEntry('').hit === false && isBotSelfEntry(undefined).hit === false)
  check('null 不崩', isBotSelfEntry(null).hit === false)
}

section('③ 压缩：简化 + 降权（用户要求）')
{
  const PREFIX = '（我说话时的一种说法，不必当真）'
  const out = compactSelfEntry(REAL)
  check('★ 前缀标明"不必当真"（降权：边界以平台规则为准，不拿它当权威）',
    out.startsWith(PREFIX), out.slice(0, 24))
  check('★★ 不再逐字注入（真机那条 40+ 字被截断）', out.endsWith('…'), out.slice(-8))
  check('★ 压缩后的正文不超过上限', out.length - PREFIX.length <= 41, `${out.length - PREFIX.length} 字正文`)
  check('★ 上限可配（更小的上限要更短）',
    compactSelfEntry(REAL, 10).length < compactSelfEntry(REAL, 40).length,
    `${compactSelfEntry(REAL, 10).length} vs ${compactSelfEntry(REAL, 40).length}`)
  check('★ 会剥掉原有的档位前缀（不叠加两层括号）',
    !compactSelfEntry('（我许的诺）我这边只能看').includes('我许的诺'))
  check('短文本不截断', compactSelfEntry('我这边只能看') === `${PREFIX}我这边只能看`, compactSelfEntry('我这边只能看'))
  check('空输入不崩', compactSelfEntry('') === PREFIX, compactSelfEntry(''))
}

console.log(`\n${failures === 0 ? '🎉' : '⚠️'} 机器人自述的识别与压缩测试${failures === 0 ? '全部通过' : `有 ${failures} 项失败`}（${passed} 项）`)
process.exit(failures === 0 ? 0 : 1)
