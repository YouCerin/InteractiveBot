#!/usr/bin/env node
/**
 * 模型凭据读取的测试。
 *
 * ── 为什么这个文件值得单独存在 ──────────────────────────────────────────
 * 它守的是一个**极难排查的故障**："机器人能收到消息，但完全不输出内容"。
 *
 * 缺 API key 时 DSH 的每一次模型调用都会**立刻**以 MISSING_CREDENTIAL 失败：
 * 不抛异常、不报错，回合照常结束，只是没有任何 `assistant/message`。
 * 使用者看到的是机器人回一句兜底话术，日志写"回合结束但无文本输出" ——
 * 而真正的原因（缺 key）在桥接这一侧**完全看不见**，要去问 DSH 才知道。
 *
 * 所以这里的重点不是"函数能跑"，而是：
 *   · 别把 OAuth secret 当成 API key 取出来
 *   · 环境变量优先（与 dsh 自己的优先级一致）
 *   · 任何异常路径都给**可执行的**提示，而不是静默返回空
 *
 * 用法：node mocks/verify-credentials.mjs
 */

import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readYamlPath, resolveModelCredentials, CREDENTIALS_FILENAME } from '../src/credentials.mjs'
import { PKG_ROOT } from '../src/local.mjs'

let failures = 0
// ★ 断言总数：原先只打印「全部通过」、不打印项数 ⇒ PROJECT.json 里那些「N 项断言」
//   的数字**没法用机器核对**，只能人手求和 —— 而它已经漂了（见 README 里的旧数字）。
let total = 0
function check(name, ok, detail = '') {
  total += 1
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
function section(t) {
  console.log(`\n── ${t} ──`)
}

const TMP = join(PKG_ROOT, '.tmp-credentials')
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

// ══════════════════════════════════════════════════════════════════════════
section('YAML 取值：只取想要的路径，绝不误取别的键')
// ══════════════════════════════════════════════════════════════════════════
{
  // 这份结构和真实文件一致：records 下有一个 OAuth secret，refs 下才是 API key
  const yaml = [
    'version: 1',
    'records:',
    '  client-connection/browser-session:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      secret: h62K-OAUTH-SECRET-SHOULD-NEVER-BE-READ',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-real-api-key-1234567890',
    '  OTHER_KEY: other-value   # 行尾注释',
  ].join('\n')

  check('能取到 refs.DEEPSEEK_API_KEY',
    readYamlPath(yaml, ['refs', 'DEEPSEEK_API_KEY']) === 'sk-real-api-key-1234567890',
    String(readYamlPath(yaml, ['refs', 'DEEPSEEK_API_KEY'])))
  check('★★ 不会把 OAuth secret 当成 API key（路径不同）',
    readYamlPath(yaml, ['refs', 'secret']) === null)
  check('★ 取不到时返回 null（不猜、不返回整份文件）',
    readYamlPath(yaml, ['refs', 'NOT_THERE']) === null)
  check('行尾注释被去掉', readYamlPath(yaml, ['refs', 'OTHER_KEY']) === 'other-value',
    String(readYamlPath(yaml, ['refs', 'OTHER_KEY'])))
  check('嵌套层级的键不会串到顶层（顶层 version 仍是 1）',
    readYamlPath(yaml, ['version']) === '1', String(readYamlPath(yaml, ['version'])))
  check('带引号的值会被剥掉引号',
    readYamlPath('refs:\n  K: "sk-quoted"\n', ['refs', 'K']) === 'sk-quoted',
    String(readYamlPath('refs:\n  K: "sk-quoted"\n', ['refs', 'K'])))
  check('空文本不崩', readYamlPath('', ['refs', 'K']) === null)
  check('非字符串输入不崩', readYamlPath(null, ['refs', 'K']) === null)
}

// ══════════════════════════════════════════════════════════════════════════
section('凭据解析：优先级与失败提示')
// ══════════════════════════════════════════════════════════════════════════
{
  // 造一份真的凭据文件
  const home = join(TMP, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, CREDENTIALS_FILENAME),
    ['version: 1', 'refs:', '  DEEPSEEK_API_KEY: sk-from-file'].join('\n'),
    'utf8',
  )

  const fromFile = resolveModelCredentials({ dshHome: home, env: {} })
  check('能从凭据文件读出 key',
    fromFile.env.DEEPSEEK_API_KEY === 'sk-from-file', JSON.stringify(fromFile.env))
  check('并如实标注来源（排查时要知道用的是哪一份）',
    typeof fromFile.source === 'string' && fromFile.source.includes(CREDENTIALS_FILENAME),
    String(fromFile.source))
  check('成功时没有 warning', fromFile.warning === null, String(fromFile.warning))

  // ★ 环境变量优先 —— 与 dsh-credentials-local 的注释一致
  const fromEnv = resolveModelCredentials({
    dshHome: home,
    env: { DEEPSEEK_API_KEY: 'sk-from-env' },
  })
  check('★★ 环境变量优先于凭据文件（与 dsh 自己的优先级一致）',
    fromEnv.env.DEEPSEEK_API_KEY === 'sk-from-env' && fromEnv.source === '环境变量',
    `${fromEnv.env.DEEPSEEK_API_KEY} / ${fromEnv.source}`)

  // ── 失败路径：每一条都要给出**可执行**的提示 ──
  const noHome = resolveModelCredentials({ dshHome: null, env: {} })
  check('★ 拿不到 DSH_HOME 时给 warning（不静默返回空）',
    Object.keys(noHome.env).length === 0 && typeof noHome.warning === 'string',
    String(noHome.warning))

  const noFile = resolveModelCredentials({ dshHome: join(TMP, 'nope'), env: {} })
  check('★ 凭据文件不存在时说清"会导致模型调用失败、表现为没有输出"',
    /MISSING_CREDENTIAL|不输出内容|模型调用/.test(String(noFile.warning)),
    String(noFile.warning).slice(0, 70))

  const emptyHome = join(TMP, 'empty')
  mkdirSync(emptyHome, { recursive: true })
  writeFileSync(join(emptyHome, CREDENTIALS_FILENAME), 'version: 1\nrefs: {}\n', 'utf8')
  const noKey = resolveModelCredentials({ dshHome: emptyHome, env: {} })
  check('★ 文件在但没有那个键时，提示去 DSH「模型」页面填（可执行）',
    noKey.env.DEEPSEEK_API_KEY === undefined && /模型.*页面|填一次/.test(String(noKey.warning)),
    String(noKey.warning).slice(0, 70))
}

// ══════════════════════════════════════════════════════════════════════════
section('★ 绝不把密钥写进日志或接口')
// ══════════════════════════════════════════════════════════════════════════
{
  const home = join(TMP, 'leak')
  mkdirSync(home, { recursive: true })
  const secret = 'sk-SUPER-SECRET-VALUE-abcdefg'
  writeFileSync(join(home, CREDENTIALS_FILENAME), `refs:\n  DEEPSEEK_API_KEY: ${secret}\n`, 'utf8')

  const r = resolveModelCredentials({ dshHome: home, env: {} })
  check('解析结果里**只有** env 与 source/warning 三项',
    JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['env', 'source', 'warning']),
    Object.keys(r).join(','))
  check('★★ source 与 warning 里**不含**密钥本身',
    !String(r.source).includes(secret) && !String(r.warning ?? '').includes(secret))
  check('密钥只在 env 里（那是给子进程用的，不入日志）',
    r.env.DEEPSEEK_API_KEY === secret)
}

rmSync(TMP, { recursive: true, force: true })
void existsSync

console.log(`\n${failures === 0 ? `🎉 凭据读取测试全部通过（${total} 项）` : `⚠️ ${failures} 项失败（共 ${total} 项）`}\n`)
process.exit(failures === 0 ? 0 : 1)
