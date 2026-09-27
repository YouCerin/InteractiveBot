#!/usr/bin/env node
/**
 * 「npm」的替身，只给 **electron-builder 的依赖收集器**用（构建期，一次性）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么需要它 —— 一条本机沙箱的硬限制，与项目本身无关
 * ══════════════════════════════════════════════════════════════════════════
 * 本机沙箱**禁止"通过管道截获另一个程序的输出"**。实测（见 cache/spawn-probe.mjs）：
 *
 *     node -e "console.log(1)"            有管道 ⇒ EPERM
 *     powershell -Command "Write-Output"  有管道 ⇒ EPERM
 *     powershell -Command "Write-Output"  inherit ⇒ ✅ 正常
 *
 * 而 electron-builder 收集运行期依赖时，一定会起子进程跑包管理器并**用管道读它的输出**
 * （app-builder-lib/out/node-module-collector/nodeModulesCollector.js 的
 * `streamCollectorCommandToFile`），于是直接 `⨯ spawn EPERM` 整个构建失败。
 *
 * ★ 让 npm 真跑起来没意义（桌面壳的运行期依赖是 **0**，见 desktop/package.json），
 *   所以这里给收集器一个**确定性的答复**：空依赖树。收集器拿到空树之后，会自己
 *   回落到它的**纯文件遍历**通路（PM.TRAVERSAL，见 appFileCopier.js 的 pmApproaches）
 *   —— 而我们零依赖，遍历的结果本来就是"没有 node_modules 要收"。
 *
 * ⚠️ 这个替身**只在构建期、只对 electron-builder 生效**：
 *   assemble-desktop.mjs 把它所在目录放在**子进程 PATH 的最前面**，
 *   不改系统 PATH、不改 npm 配置、不碰任何别的东西。
 *
 * ★★ 如果哪天 electron-builder 换了命令行（多一个开关），这个替身会**答错**。
 *    所以它认不出 `list` 时**非零退出**：那样构建会停下来，而不是安静地继续
 *    （安静地继续 = 依赖收集结果可能不全 = 打出一个缺东西的包，而且不会报错）。
 */

const argv = process.argv.slice(2)
const isList = argv[0] === 'list' || argv[0] === 'ls'

if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write('11.16.0\n')
  process.exit(0)
}

if (isList) {
  // npm list 的 JSON 形状（收集器只读 dependencies，顶层还要有 name/version）
  process.stdout.write(
    `${JSON.stringify(
      {
        name: 'interactbot-desktop',
        version: '0.0.0',
        dependencies: {},
        _stub: 'assemble-desktop.mjs 提供的 npm 替身：桌面壳零运行期依赖，故依赖树为空',
      },
      null,
      2,
    )}\n`,
  )
  process.exit(0)
}

process.stderr.write(
  `[npm-stub] 被以不认识的参数调用了：${JSON.stringify(argv)}\n` +
    '  这个替身只认 `list`（和 --version）。不上报一个假结果是有意的：\n' +
    '  它变了就说明 electron-builder 的收集方式变了，构建该停下来让人看一眼（见本文件顶部）。\n',
)
process.exit(97)
