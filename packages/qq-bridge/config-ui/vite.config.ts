import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'
import { createRequire } from 'node:module'

/**
 * ★ 构建溯源：把"这份 dist 由哪份源码构建"写进产物旁的 `ui-build.json`。
 *
 * 为什么必须有（一次真实的脱钩）：界面分两条路出货 —— 开发路径
 * `config-ui/dist`、发布路径 `_release/<包>/config-ui/dist`（`RELEASE.md` §5
 * 用 robocopy 拷）。而"发布包那份 dist 是不是当前源码构建的"以前**没有任何
 * 东西能判断**（验收脚本只验 `dist/index.html` 在不在）。实测后果：发布包里的
 * 桥接源码与 UI 都比工作区旧了约 5 小时，而 1100 项测试全绿。
 *
 * ⚠️ 这里用 `createRequire` 同步 require 那个 CJS 文件，而不是 `import`：
 *    Vite 会把配置打成 CJS，ESM 动态 import 在个别环境会失败；
 *    而且**哈希逻辑只能有一份**（在 `scripts/ui-build-stamp.mjs` 里），
 *    两边各写一套必然分叉 —— 分叉的表现是"校验说同步、其实是错的"。
 */
const req = createRequire(__filename)
const { bridgeVersion, computeUiSourceHash, writeBuildStamp } = req(
  path.resolve(__dirname, '../scripts/ui-build-stamp.cjs'),
)

function uiBuildStamp() {
  return {
    name: 'qq-bridge-ui-build-stamp',
    // closeBundle：资源已 emit 完、dist 是最终形态，这时写最准
    closeBundle() {
      try {
        const stamp = {
          name: 'qq-bridge 控制台界面',
          // ⚠️ 取**桥接的**版本号，不是 config-ui/package.json 那个（它恒为 0.0.0）
          pkgVersion: bridgeVersion(),
          builtAt: new Date().toISOString(),
          sourceHash: computeUiSourceHash(),
        }
        const p = writeBuildStamp(path.resolve(__dirname, 'dist'), stamp)
        console.log(`\n[ui-build-stamp] 已写入 ${path.basename(p)}  sourceHash=${stamp.sourceHash.slice(0, 12)}…`)
      } catch (error) {
        // ★ 不静默：没有标记的 dist 就失去了"能不能自证新鲜"的能力，
        //   而那正是这次要解决的问题。构建继续，但必须吼一声。
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`\n[ui-build-stamp] ⚠️ 写入失败：${msg}`)
        console.error('   → 这份 dist 无法自证与源码同步（发布验收会因此报错）')
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [inspectAttr(), react(), uiBuildStamp()],
  server: {
    // 3000/3001 是 SnowLuma 的端口，避开；CLI 传入的 --port 会覆盖这里
    port: 3411,
    proxy: {
      // 桥接的本地配置接口（只监听 127.0.0.1，见 CONFIG-UI.md 第 5 节）。
      // 走 dev server 代理，避免浏览器跨域问题。
      '/api': {
        target: 'http://127.0.0.1:3410',
        changeOrigin: false,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
