#!/usr/bin/env node
/**
 * 真机探针：**判定器判得对不对**（0.2.3）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么它不在 `npm test` 里
 * ══════════════════════════════════════════════════════════════════════════
 * 它**会花真钱**（每条用例一次真实的模型调用，约 400~800 prompt tokens），
 * 而且结论**不是确定性的**（temperature 0.1，且"判得对不对"是模型行为）。
 * 把它塞进测试链只会让"全绿"变成假的 —— 同 `mocks/probe-ui-deadcode.mjs` 的口径。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须有它（离线断言测不到这一层）
 * ══════════════════════════════════════════════════════════════════════════
 * `mocks/verify-wake.mjs` 只能断言"**提示词里有那几条规则**"，
 * **证明不了模型会不会照它判**。这不是假设 —— 第一版的判据写错了
 * （把"该沉默"定义成「与机器人无关」，于是"提到它的名字"＝"与它有关"＝不该沉默），
 * 离线断言**全是绿的**，而真机四次判定**全是 answer**（= 语义唤醒退化成规则唤醒）。
 * 那两次失败的原文（`@100000002 小鲸鱼刚说的…`、`我刚跟小鲸鱼说了…`）
 * 就是下面用例表里的前两条，**永久留作回归**。
 *
 * 用法：
 *   node mocks/probe-wake-judge.mjs            # 跑全部用例
 *   node mocks/probe-wake-judge.mjs --json     # 机器可读
 *
 * ⚠️ 它不碰运行中的桥接（只读 config.json 解析通路 + 发 HTTP），也不会发 QQ 消息。
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeConfig } from '../src/config.mjs'
import { resolveDshHome } from '../src/local.mjs'
import { resolveDirectTarget, chatOnce } from '../src/model-direct.mjs'
import { buildJudgePrompt, parseJudgeVerdict } from '../src/wake-judge.mjs'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 用例表：[期望结论, 消息, @ 了谁, 为什么这么期望]
 *
 * ★ 期望值的**唯一依据是"收件人"**：说给它听 → answer；说给别人/说给全群 → silent。
 * ★★ 这张表改过两次，两次都是**期望错、模型对**（别把直觉当判据）：
 *    · 「小鲸鱼 哈哈哈哈」原本写成 silent —— 可它**叫了名字**，收件人就是它；
 *      旧 rubric 的"过场话 → 沉默"与"被点名 → 回答"在这里冲突，
 *      而"学会沉默"的目的是**不插别人之间的嘴**，不是不理叫它的人
 *      （口径与 `#wakeGate` 的"被 @ 直通"一致）。判据里已把这条挑明。
 *    · 「下午三点开会，小鲸鱼你看到的话提醒一下大家」原本写成 silent ——
 *      它写着"**你**看到的话"，是在点名派活，收件人就是它。
 */
const CASES = [
  // ── 真机回归：这两条是 0.2.3 第一版 prompt 判错的原句（日志里有原话）──
  ['silent', '@100000002 小鲸鱼刚说的那个方案我看行', [{ qq: '100000002', name: '小王' }], '@ 的是别人 + 转述'],
  ['silent', '我刚跟小鲸鱼说了，它说四点开会，你们记得改时间', [], '转述它的话给群友'],
  // ── 沉默：话题与它有关，但话不是说给它听的 ──
  ['silent', '你们觉得小鲸鱼这名字好听吗', [], '向群友询问对名字的看法'],
  ['silent', '小鲸鱼昨天说的那个方案，我同意老张的看法', [], '转述 + 向群友表态'],
  // ── 回答：收件人是它（含"叫了名字但内容没信息量"这条边界）──
  ['answer', '小鲸鱼 哈哈哈哈哈哈', [], '叫了名字 ⇒ 收件人是它（哪怕只是笑）'],
  ['answer', '下午三点开会，小鲸鱼你看到的话提醒一下大家', [], '点名派活'],
  ['answer', '小鲸鱼 帮我把这句话翻译成英文：今天天气不错', [], '直接请求'],
  ['answer', '小鲸鱼，你刚才说的那个文件在哪个目录', [], '回应它刚说过的 + 提问'],
  ['answer', '小鲸鱼 现在几点了', [], '直接提问'],
]

const asJson = process.argv.includes('--json')

try {
  const config = normalizeConfig(JSON.parse(readFileSync(join(PKG_ROOT, 'config.json'), 'utf8')))
  const dshHome = process.env.DSH_HOME ?? resolveDshHome({ cliPath: config.dsh.cliPath })?.home ?? null
  const target = resolveDirectTarget({ config, dshHome, env: process.env })
  if (!target.ok) {
    console.error(`❌ 判定通路不可用：${target.why}`)
    process.exit(2)
  }
  if (!asJson) console.log(`通路 ${target.baseUrl} · 模型 ${target.model} · 用例 ${CASES.length} 条\n`)

  const SELF = String(config.onebot?.selfId ?? '')
  const rows = []
  let hit = 0
  for (const [want, text, ats, why] of CASES) {
    const prompt = buildJudgePrompt({
      kind: 'group',
      senderId: '100000001',
      senderName: '无忘远霞',
      text,
      selfId: SELF,
      ats,
      hitAt: false,
      recent: [],
      selfNames: config.trigger.keywords,
    })
    const r = await chatOnce({
      baseUrl: target.baseUrl,
      apiKey: target.apiKey,
      model: target.model,
      prompt,
      timeoutMs: config.wake.judge.timeoutMs,
    })
    const v = r.ok ? parseJudgeVerdict(r.text) : { ok: false, why: r.why }
    const got = v.ok ? v.verdict : `解析失败(${v.why})`
    const okOne = got === want
    if (okOne) hit += 1
    rows.push({ want, got, ok: okOne, text, why, reason: v.reason ?? v.why ?? '', ms: r.ms })
    if (!asJson) {
      console.log(`${okOne ? '✅' : '❌'} 期望 ${want.padEnd(6)} 实得 ${got.padEnd(6)} ${String(r.ms).padStart(4)}ms  「${text}」`)
      console.log(`     期望依据：${why}`)
      console.log(`     实际理由：${v.reason ?? v.why ?? '(无)'}`)
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ hit, total: CASES.length, rows }, null, 2))
  } else {
    console.log(`\n合计 ${hit}/${CASES.length} 命中`)
    console.log('⚠️ 判定不是硬规则（temperature 0.1）：同一句多跑几次结论可能不同，')
    console.log('   所以这张表看的是"**方向**对不对"，不是"每次都一样"。')
  }
  process.exit(hit === CASES.length ? 0 : 1)
} catch (error) {
  console.error(`❌ 探针跑不起来：${error?.message ?? error}`)
  process.exit(2)
}
