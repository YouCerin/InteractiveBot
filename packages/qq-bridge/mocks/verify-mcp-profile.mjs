#!/usr/bin/env node
/**
 * profile 补丁生成器的测试（`src/mcp-profile.mjs`）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么这个文件值得单独测
 * ══════════════════════════════════════════════════════════════════════════
 * 它踩过一个后果很严重的坑：profile 的 patch 模板内容是**一个空列表 `[]`**，
 * 而第一版只是在文件末尾追加我们的条目 —— 于是变成"`[]` 后面又一个列表"，
 * YAML 解析直接失败，**整个 sdk profile 加载不了、桥接起不来**。
 *
 * 实测报错原文：
 *   Error: dsh: failed to parse overlay …cordis.patch.yml:
 *   YAMLException: end of the stream or a document separator is expected (7:1)
 *
 * 这种错误的代价是"机器人完全不可用"，所以这里把关键性质固化下来：
 *   ① 生成的内容里**不能同时出现空列表 `[]` 和一个真实列表**
 *   ② 幂等：反复调用不重复堆叠
 *   ③ 不破坏文件里原有的其他内容
 *
 * 用法：node mocks/verify-mcp-profile.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ensureSdkProfilePatch, writeMcpConfig } from '../src/mcp-profile.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TMP = join(HERE, '..', '.tmp-verify-profile')

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —— ' + detail : ''}`)
  if (!ok) failures += 1
}
const section = (t) => console.log(`\n── ${t} ──`)

/** DSH 自带的 patch 模板（本机实测就是这个内容）。 */
const TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

const ARGS = {
  nodePath: 'C:\\some node\\node.exe',
  serverPath: 'C:\\pkg\\mcp\\mcp-qq-server.mjs',
  configPath: 'C:\\pkg\\cache\\mcp-qq.config.json',
}

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
const patchPath = join(TMP, 'cordis.patch.yml')
const write = (s) => writeFileSync(patchPath, s, 'utf8')
const read = () => readFileSync(patchPath, 'utf8')

try {
  // ══════════════════════════════════════════════════════════════════════
  section('★ 核心回归：不能留下"空列表 + 真实列表"这种非法 YAML')
  // ══════════════════════════════════════════════════════════════════════
  {
    write(TEMPLATE)
    ensureSdkProfilePatch({ profilePatchPath: patchPath, ...ARGS })
    const out = read()

    check('★ 生成后不再残留独立的空列表 `[]`',
      !/^\s*\[\]\s*$/m.test(out),
      out.split('\n').find((l) => /^\s*\[\]\s*$/.test(l)) ?? '（没有空列表）')
    check('包含了我们的 insert', /id: qq-bridge-tools/.test(out))
    check('包含 MCP 客户端包名', /@deepseek-ai\/dsh-mcp-client/.test(out))
    check('包含 transport: stdio', /transport: stdio/.test(out))
    check('保留了原有的注释头（没把模板清空）', /Your patch layer/.test(out))

    // 只有顶层一个列表条目才是合法形态
    const topLevelItems = out.split('\n').filter((l) => /^-\s/.test(l))
    check('顶层恰好一个列表条目（本次只有一个 insert）', topLevelItems.length === 1,
      JSON.stringify(topLevelItems))
  }

  // ══════════════════════════════════════════════════════════════════════
  section('幂等：反复调用不应堆叠')
  // ══════════════════════════════════════════════════════════════════════
  {
    const before = read()
    const r2 = ensureSdkProfilePatch({ profilePatchPath: patchPath, ...ARGS })
    const after = read()
    check('第二次调用内容不变', before === after)
    check('第二次调用报告 changed=false', r2.changed === false, String(r2.changed))

    ensureSdkProfilePatch({ profilePatchPath: patchPath, ...ARGS })
    const third = read()
    check('第三次调用也不变', third === before)
    check('标记只出现一次', (third.match(/qq-bridge: qq tools/g) ?? []).length === 2,
      `出现 ${(third.match(/qq-bridge: qq tools/g) ?? []).length} 次（开始+结束标记各一次）`)
  }

  // ══════════════════════════════════════════════════════════════════════
  section('不破坏文件里原有的其他条目')
  // ══════════════════════════════════════════════════════════════════════
  {
    const withOther = `# 用户自己的 patch\n- id: some-plugin\n  config:\n    foo: bar\n`
    write(withOther)
    ensureSdkProfilePatch({ profilePatchPath: patchPath, ...ARGS })
    const out = read()
    check('★ 保留了用户原有的条目', /- id: some-plugin/.test(out) && /foo: bar/.test(out))
    check('我们的条目也加上了', /id: qq-bridge-tools/.test(out))
    check('★ 用户条目在前、我们的在后（顺序稳定，便于人读）',
      out.indexOf('some-plugin') < out.indexOf('qq-bridge-tools'))
  }

  // ══════════════════════════════════════════════════════════════════════
  section('文件不存在 / 为空 / 内容损坏时都要能工作')
  // ══════════════════════════════════════════════════════════════════════
  {
    rmSync(patchPath, { force: true })
    const r = ensureSdkProfilePatch({ profilePatchPath: patchPath, ...ARGS })
    check('文件不存在时能创建', existsSync(patchPath) && r.changed === true)
    check('新建内容含我们的 insert', /id: qq-bridge-tools/.test(read()))

    write('')
    ensureSdkProfilePatch({ profilePatchPath: patchPath, ...ARGS })
    check('空文件时能写入', /id: qq-bridge-tools/.test(read()))

    write('!!! 这不是合法 YAML ???\n')
    ensureSdkProfilePatch({ profilePatchPath: patchPath, ...ARGS })
    check('内容损坏时不崩（尽力恢复）', /id: qq-bridge-tools/.test(read()))
  }

  // ══════════════════════════════════════════════════════════════════════
  section('YAML 字符串转义（Windows 路径里全是反斜杠）')
  // ══════════════════════════════════════════════════════════════════════
  {
    write(TEMPLATE)
    ensureSdkProfilePatch({
      profilePatchPath: patchPath,
      nodePath: "C:\\Program Files\\O'Brien\\node.exe",
      serverPath: 'C:\\a\\b.mjs',
      configPath: 'C:\\c\\d.json',
    })
    const out = read()
    check('★ 路径里的单引号被转义（YAML 单引号规则：翻倍）',
      /O''Brien/.test(out), out.split('\n').find((l) => l.includes('O')) ?? '')
    check('反斜杠原样保留（没有被当转义符吃掉）',
      /C:\\\\?Program Files/.test(out) || out.includes('C:\\Program Files'), '')
  }

  // ══════════════════════════════════════════════════════════════════════
  section('MCP 配置文件：幂等且不外泄到 workspace')
  // ══════════════════════════════════════════════════════════════════════
  {
    const cache = join(TMP, 'cache')
    const p1 = writeMcpConfig({ cacheDir: cache, httpUrl: 'http://127.0.0.1:3000', httpToken: 'T' })
    check('配置文件生成在指定的 cache 目录', p1.startsWith(cache), p1)
    const body = JSON.parse(readFileSync(p1, 'utf8'))
    check('含 httpUrl 与 httpToken', body.httpUrl === 'http://127.0.0.1:3000' && body.httpToken === 'T')
    const r2 = writeMcpConfig({ cacheDir: cache, httpUrl: 'http://127.0.0.1:3000', httpToken: 'T' })
    check('内容相同时不重写（返回同一个路径，且不触发无谓改动）', r2 === p1)

    const p3 = writeMcpConfig({ cacheDir: cache, httpUrl: 'http://127.0.0.1:9999', httpToken: 'T' })
    check('内容变化时确实重写', JSON.parse(readFileSync(p3, 'utf8')).httpUrl.endsWith('9999'))
  }
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? '🎉 profile 补丁测试全部通过' : `⚠️ ${failures} 项失败`}\n`)
process.exit(failures === 0 ? 0 : 1)
