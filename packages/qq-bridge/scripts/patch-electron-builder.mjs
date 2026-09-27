/**
 * 给 electron-builder 打一个**最小补丁**：把它的依赖收集器"用管道读子进程输出"
 * 换成"让子进程直接写那个临时文件"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么必须打（这是本机沙箱的限制，不是 electron-builder 的 bug）
 * ══════════════════════════════════════════════════════════════════════════
 * 实测（见 cache/spawn-probe.mjs，本机）：
 *
 *     spawn('node', [...])              默认管道 ⇒ EPERM
 *     spawn('powershell.exe', [...])    默认管道 ⇒ EPERM
 *     spawn(..., { stdio: 'inherit' })            ⇒ ✅ 正常
 *
 * 也就是说：**任何**"用管道捕获子进程输出"的调用在本机都会被拒。而
 * electron-builder 收集运行期依赖时一定会那么做（app-builder-lib →
 * node-module-collector/nodeModulesCollector.js 的 `streamCollectorCommandToFile`
 * 里 `child.stdout.pipe(outStream)`），于是 `⨯ spawn EPERM`、整个构建失败。
 *
 * ★ 这一处补丁把"父进程拿管道读、再转写进文件"改成"子进程自己写那个文件"：
 *   **同一个文件、同一份字节**，只是中间不再有管道。补丁后
 *   `npm-stub.mjs`（scripts/build-tools/）给收集器一个空依赖树，
 *   收集器随即回落到它自己的**纯文件遍历**通路（PM.TRAVERSAL）——
 *   桌面壳零运行期依赖，遍历结果本来就是"没有 node_modules 要收"。
 *
 * ★★ 补丁是**打过就跳过**的（幂等），并且：
 *     · 打不上就**非零退出**（宁可构建停下，也不要一个"看起来成功"的包）；
 *     · 补丁文件本身另存一份（`.npm-pipe-patch.json`）记下改了什么，
 *       将来 `npm install` 覆盖掉它时会重新打，并重新校验。
 *
 * 用法：node scripts/patch-electron-builder.mjs [--check]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = join(HERE, '..')
const DESKTOP = join(PKG_ROOT, 'desktop')
const TARGET = join(DESKTOP, 'node_modules', 'app-builder-lib', 'out', 'node-module-collector', 'nodeModulesCollector.js')

const CHECK_ONLY = process.argv.includes('--check')

/** 原样（未打补丁）的那一段。 */
const BEFORE = `            const outStream = (0, fs_extra_1.createWriteStream)(tempOutputFile);
            const child = childProcess.spawn(spawnCommand, spawnArgs, {
                cwd,
                // Package manager invocations do not need signing/publishing credentials.
                env: { COREPACK_ENABLE_STRICT: "0", ...(0, builder_util_1.stripSensitiveEnvVars)(process.env) },
            });
            let stderr = "";
`

/**
 * 补丁后：四处改动，缺一不可。
 *
 *  ① stdout **直接写那个临时文件**（没有管道）；父进程也不再建写入流；
 *  ② stderr 同样**直接写另一个临时文件**。★ 这一处是第二次才修对的：
 *     实测 `stdio: ['ignore', fd, 'pipe']` **仍然 EPERM** —— 被拒的不是 stdout，
 *     而是 **`pipe` 本身**（见 cache/spawn-probe3.mjs：`pipe` 出现在哪一路都拒，
 *     换成 fd 或 'ignore' 就通）。所以三路**一个 pipe 都不能有**。
 *  ③ 原来"写入流 finish 才算写完"的等待没有对象了 ⇒ 直接置 `streamFinished = true`。
 *     ⚠️ 漏了这一步会让 `settle()` **永远不执行**：`settle` 要求
 *     `childClosed && streamFinished` 两个都为真，于是 Promise 永不 settle、
 *     构建**卡死**（不报错、不退出）—— 比失败更难查，所以这里显式写出来；
 *  ④ `fail()` 里那句 `outStream.destroy()` 与两处 `outStream.on(...)` 一并去掉。
 */
const AFTER = `            const _patchFs = require("node:fs");
            const _patchPath = require("node:path");
            const _patchFd = _patchFs.openSync(tempOutputFile, "w");
            // [interactbot-patch] stderr 也写文件：本机沙箱里 **任何** pipe 都被拒
            //   （连 ['ignore', fd, 'pipe'] 都 EPERM），所以三路一个 pipe 都不能有。
            const _patchErrFile = _patchPath.join(_patchPath.dirname(tempOutputFile), _patchPath.basename(tempOutputFile) + ".stderr.txt");
            const _patchErrFd = _patchFs.openSync(_patchErrFile, "w");
            const child = childProcess.spawn(spawnCommand, spawnArgs, {
                cwd,
                // Package manager invocations do not need signing/publishing credentials.
                env: { COREPACK_ENABLE_STRICT: "0", ...(0, builder_util_1.stripSensitiveEnvVars)(process.env) },
                // [interactbot-patch] 不要管道：子进程直接把 stdout/stderr 写进文件。
                //   理由见 scripts/patch-electron-builder.mjs（本机沙箱禁止管道捕获输出）。
                stdio: ["ignore", _patchFd, _patchErrFd],
            });
            let stderr = "";
`

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

if (!existsSync(TARGET)) {
  fail(
    `找不到 electron-builder 的收集器：${relative(PKG_ROOT, TARGET)}\n` +
      '   → 先在 desktop/ 里跑 `npm install --ignore-scripts`（见 desktop/.npmrc 的说明）。',
  )
}

/**
 * 补丁后的**形态检查**：不跑起来，只核对几件"必须成立"的事。
 * 这些正是踩过的四个坑，任何一个不成立都会以**难查**的方式失败：
 *   漏了 streamFinished → 卡死；留了 pipe → EPERM；留了 outStream → TypeError。
 */
function verifyPatched (text) {
  const problems = []
  if (text.includes('child.stdout.pipe(outStream)')) problems.push('仍然存在 child.stdout.pipe(outStream)')
  if (/outStream\.(on|destroy)\(/.test(text)) problems.push('仍然存在 outStream.on/destroy 调用')
  if (text.includes('child.stderr.on("data"')) problems.push('仍然从管道读 stderr（沙箱不允许任何 pipe）')
  if (!/stdio:\s*\["ignore",\s*_patchFd,\s*_patchErrFd\]/.test(text)) problems.push('stdio 不是 ["ignore", fd, fd]（只要有一个 pipe 就会被拒）')
  if (!text.includes('streamFinished = true;')) problems.push('缺少 streamFinished = true（会让构建卡死）')
  return problems
}

const src = readFileSync(TARGET, 'utf8')
const already = src.includes('[interactbot-patch]')

if (CHECK_ONLY) {
  if (!already) fail('补丁不在 —— 构建会以 `⛔ EPERM` 失败（跑 node scripts/patch-electron-builder.mjs）')
  const problems = verifyPatched(src)
  if (problems.length) fail(`补丁在，但形态不对：\n${problems.map((p) => `   · ${p}`).join('\n')}`)
  console.log('✅ 补丁已在，且形态正确（无 pipe、有 streamFinished）')
  process.exit(0)
}

if (already) {
  const problems = verifyPatched(src)
  if (problems.length) {
    fail(
      '文件里已经有补丁标记，但**形态不对**（很可能是上一版补丁留下的半成品）：\n' +
        problems.map((p) => `   · ${p}`).join('\n') +
        '\n   修法（这一步故意不自动做，避免脚本去猜怎么改回来）：\n' +
        '     cd desktop && Remove-Item node_modules\\app-builder-lib -Recurse -Force\n' +
        '     npm install --no-audit --no-fund --ignore-scripts app-builder-lib@26.15.3\n' +
        '   然后再跑一次本脚本。',
    )
  }
  console.log('✅ 补丁已在，跳过')
  process.exit(0)
}

// ⚠️ 必须**逐段**精确命中各一次。命中 0 次 = 上游改了实现（那就该停下来看，而不是猜着改）；
//    命中 >1 次 = 我们对代码结构的假设不成立。
const PATCHES = [
  {
    what: 'stdout 直接写文件（不再有管道 + 不再有 outStream）',
    before: BEFORE,
    after: AFTER,
  },
  {
    what: '把输出流的 pipe 换成"已写完"标记，并去掉 stderr 的管道读取',
    before: '            // `pipe` ends `outStream` when stdout EOFs, which triggers its "finish" once flushed.\n' +
      '            child.stdout.pipe(outStream);\n' +
      '            child.stderr.on("data", chunk => {\n' +
      '                stderr += chunk.toString();\n' +
      '            });\n',
    after: '            // [interactbot-patch] 没有 outStream 了（子进程直接写文件）⇒ 直接标记写完，\n' +
      '            //   否则 settle() 的两个条件永远凑不齐，构建会**卡死**而不报错。\n' +
      '            //   stderr 也不再挂在管道上（本机沙箱里任何 pipe 都 EPERM）——\n' +
      '            //   它现在写在同目录的 *.stderr.txt 里，需要时人工去看。\n' +
      '            streamFinished = true;\n',
  },
  {
    what: 'fail() 里去掉 outStream.destroy()',
    before: '                try {\n                    outStream.destroy();\n                }\n                catch {\n                    // ignore\n                }\n                reject(err);',
    after: '                // [interactbot-patch] 没有 outStream 可销毁了\n                reject(err);',
  },
  {
    what: '去掉 outStream 的 error/finish 监听',
    before: '            outStream.on("error", err => fail(new Error(`Node module collector failed writing output (${command}): ${err.message}`)));\n            outStream.on("finish", () => {\n                streamFinished = true;\n                settle();\n            });\n',
    after: '',
  },
]

for (const p of PATCHES) {
  const n = src.split(p.before).length - 1
  if (n !== 1) {
    fail(
      `补丁「${p.what}」在目标文件里命中 ${n} 次（期望 1 次）—— electron-builder 的实现变了（或版本不对）。\n` +
        `   目标文件：${relative(PKG_ROOT, TARGET)}\n` +
        '   请人工看一眼 streamCollectorCommandToFile 现在怎么读子进程输出，再更新本脚本。\n' +
        '   ★ 这一步**故意**宁可不打：猜着改一个依赖的内部实现，比构建失败危险得多。',
    )
  }
}

let patched = src
for (const p of PATCHES) patched = patched.replace(p.before, p.after)

writeFileSync(TARGET, patched, 'utf8')
// 再读一遍确认真的改了（写盘失败/被别的东西覆盖时要能发现），并且**形态正确**
{
  const back = readFileSync(TARGET, 'utf8')
  if (!back.includes('[interactbot-patch]')) fail('写完以后读回来没有补丁标记 —— 写盘可能没生效')
  const problems = verifyPatched(back)
  if (problems.length) fail(`写完以后自检不过：\n${problems.map((p) => `   · ${p}`).join('\n')}`)
}
console.log(`✅ 已给 electron-builder 打补丁（${PATCHES.length} 处）：${relative(PKG_ROOT, TARGET)}`)
for (const p of PATCHES) console.log(`   · ${p.what}`)
console.log('   原因见本脚本顶部：本机沙箱禁止"用管道捕获另一个程序的输出"。')
