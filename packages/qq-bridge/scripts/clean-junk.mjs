#!/usr/bin/env node
/**
 * 清理测试残留（`junk` 类路径）。
 *
 * ★ 它**只删** `src/protected-files.mjs` 里标成 `kind: 'junk'` 的路径 ——
 *   使用者数据（config.json / workspace-qq / logs / cache / snowluma）**永远不在**这个集合里。
 *   为什么要做成一个命令而不是"我顺手 rm 一下"：手写 rm 的判据是"我觉得这是垃圾"，
 *   而这个判据在别人手里会变成"把 workspace-qq 删了"。
 *
 * 用法：
 *   node scripts/clean-junk.mjs          # 只报，不删
 *   node scripts/clean-junk.mjs --apply  # 真的删
 */

import { existsSync, rmSync, statSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { disposablePaths } from '../src/protected-files.mjs'

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const APPLY = process.argv.includes('--apply')

let found = 0
for (const rel of disposablePaths()) {
  const abs = join(PKG_ROOT, rel)
  if (!existsSync(abs)) continue
  found += 1
  const st = statSync(abs)
  const n = st.isDirectory() ? readdirSync(abs).length : 0
  if (!APPLY) {
    console.log(`  · ${rel}${st.isDirectory() ? `（目录，${n} 项）` : '（文件）'} —— 加 --apply 才会删`)
    continue
  }
  try {
    rmSync(abs, { recursive: true, force: true })
    console.log(`  ✅ 已清理 ${rel}`)
  } catch (error) {
    console.log(`  ❌ 清理失败 ${rel}：${error?.message ?? error}`)
  }
}

if (found === 0) console.log('  没有需要清理的残留。')
else if (!APPLY) console.log(`\n共 ${found} 项（预演模式，未删）。`)
