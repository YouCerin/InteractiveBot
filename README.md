# project_InteractBot

把**可配置的 QQ 对话机器人**接到 DeepSeek Harness（DSH）：QQ 消息 → DSH agent → 回答发回 QQ。

> **当前状态：`packages/qq-bridge` 是仓库里唯一的实现（0.2.5）**。它**不是** DSH 插件，
> 而是"外部进程 + `dsh --profile sdk`"的桥接。
> ★ 0.2.5 起控制台**不再是一张网页**，而是一个**真正的程序窗口**（Electron 桌面壳，
> 打包成 `app\InteractBot.exe`，双击即可）—— 见下文「0.2.5 这一版加了什么」。
> `packages/dsh-qq-bot（废弃）` 是第一版的"DSH 进程内插件"思路，**已在 0.2.5 按用户要求
> 删除**（旧方案存档在 `docs/design.md`、`docs/implementation-plan.md`、`docs/m6-checklist.md`）——
> 那是**有意删掉的**，不要再把它建回来。

## 目录结构

```
project_InteractBot/
├── .dsh/skills/                    # 已安装的 DSH 插件开发 skill（10 个）
├── reference/                      # 上游参考（只读留档）
│   ├── dsh-agent-teams/            # skill 源 + 开发文档 + git 历史
│   └── pixiv-lookup-1.1.0/         # ★ 第三方技能**原件**（适配前的逐字副本）
├── packages/
│   └── qq-bridge/                  # ★ 唯一的实现：QQ ↔ DSH 桥接（详见它自己的 README/AGENT.md）
│       ├── src/                    # 桥接主体（含扩展内核 extensions.mjs / 插件表 plugins.mjs）
│       ├── mcp/                    # 手写 MCP 服务器：QQ 工具 + 技能工具
│       ├── skills/                 # ★ 外部技能（`<id>/skill.json` + 入口）；当前装了 pixiv-lookup
│       ├── config-ui/              # 控制台界面（React + Vite；改了 src 必须 npm run build）
│       ├── desktop/                # ★ 桌面壳源码（0.2.5，Electron：独立窗口 + 托盘 + 打 exe）
│       └── docs/、CONFIG-UI.md、AGENT.md、PROJECT.json …
├── docs/                           # 版本级文档（设计 / 验收 / 适配存档）
│   ├── 插件设计规范.md              # ★ 扩展体系的契约（技能清单、生命周期、安全、UI、验收）
│   ├── 0.2.2-release-notes.md       # 这一版更新了什么
│   ├── 0.2.2-console-plan.md        # 控制台改造方案（**待指令，未实施**）
│   └── 0.2.2-pixiv-skill-migration.md + 0.2.2-pixiv-adaptation.patch
└── README.md
```

## 0.2.5 这一版加了什么（一句话）

**桌面壳**：把控制台 UI 从"浏览器里的一张网页"搬进一个**真正的程序窗口**
（**Electron 38.8.6**，运行时**自带** —— 免安装、目标机器**不需要装 Node**），
并把启动方式**打包成 .exe**：发布包的主入口 = `app\InteractBot.exe`，**双击即可**
（它自己找到包根 → 用 `node src/index.mjs --background` 把桥接拉起来 → 开出控制台窗口）。
源码侧**不必打包就能开窗口**：`npm run desktop`（跑 `desktop/` 那份壳源码，
改完壳重启这条命令即可）；打 exe 用 `npm run desktop:pack`。

★ 这一版**没有 .bat 启动器**：0.2.4 曾用中文名 .bat 去设环境变量 `INTERACTBOT_PKG_ROOT`，
那一类中文名入口已按用户要求删除（见 `packages/qq-bridge/mocks/verify-legacy-assets.mjs`）。
发布包里**只剩 `start.bat` 一个 .bat**，它是"浏览器那条路"，一旦发现 `app\InteractBot.exe`
存在就**不再打开浏览器**（避免同一台机器出现两个控制台）。
所以「**没有启动器也能找到包根**」是硬要求 —— 包根由 `packages/qq-bridge/desktop/lib.cjs`
的 `resolvePkgRoot` 按**三级判据**找：① 环境变量 `INTERACTBOT_PKG_ROOT`（若有人显式设）→
② 从 `app.getAppPath()`（打包后是 `app\resources\app`、开发时是 `desktop/`）
**逐级向上找包根标记**（**同时**有 `config.example.json` 与 `src/index.mjs` 的那一层）→
③ 找不到就返回链上**真实存在**的一层并**在日志里喊一声**，**绝不猜**。
★ 为什么是"看证据"而不是"数目录层数"：0.2.4 第一版依赖 `app.isPackaged`，而 `asar: false`
时它**是 `false`** ⇒ 打包分支根本没进，壳**静默**把 `app\` 当成了包根（读不到使用者的
`config.json`、日志写进了 `app\logs\`）。修法就是那三级判据，判据由
`packages/qq-bridge/mocks/verify-desktop.mjs` **造出真实发布包布局**来断言（离线 155 项）。

★ 关窗口 = **收进托盘**，机器人**继续在线**；真正退出要用**托盘菜单的「退出并停止机器人」**
（会先 `POST /api/stop`）。

★ 代价与边界（如实标注）：`app/` 约 **324 MB**（其中 `InteractBot.exe` **200.5 MB**），
发布包合计 **202 个文件 / 约 413 MB**（比不带桌面壳的 88.6 MB 大很多，代价就是 Electron 运行时）。
窗口 / 托盘 / 菜单 / "关窗口不下线"这些**只能人在真机上点一遍**（受限沙箱里 Electron 起不来）；
已被机器验证的只有壳的**判断逻辑**、**产物形状**（exe 在、asar 关着、PE 版本号 0.2.5、
包里的壳代码与 `desktop/` 源码逐字节一致）以及**发布包验收** ——
完整清单在 `packages/qq-bridge/PROJECT.json` 的 `verificationStatus.notVerified`。

## 0.2.2 这一版加了什么（一句话）

**扩展系统**：技能（外部能力包，`skills/<id>/`）与插件（桥接内置能力块）两型，**都能随时开关**
（提示词下一轮生效、工具调用当场 fail-closed；只有装/卸技能要重启）。
详见 `docs/0.2.2-release-notes.md` 与 `docs/插件设计规范.md`。

## 已安装的 DSH 插件/skill 开发文件

以下 10 个 skill 已安装到 `.dsh/skills/`（并已被 DSH 会话识别）：

| Skill | 用途 |
|---|---|
| `dsh-plugin-development` | 插件开发/维护/分发/验证总纲（host/client、bundle/profile、工具、slot 等） |
| `plugin-write` | 新建插件、命名规范、命名校验、包校验 |
| `plugin-upgrade` | 插件版本迁移 / 兼容性 / 升级诊断 |
| `plugin-test` | 插件测试（单测→真实组合→制品冒烟） |
| `plugin-release` | 打包、发布、分发插件 |
| `plugin-runtime-debug` | 浏览器运行时故障诊断 |
| `plugin-heavy-dep` | 重依赖浏览器插件的懒加载 |
| `plugin-workflow` | 多 skill 生命周期编排 |
| `dsh-upgrade-audit` | 两个 DSH 版本间的兼容性审计 |
| `dsh-benchmark-case` | 升级经验固化为可自动判分的 benchmark 任务 |

完整开发指南（人类可读）：`reference/dsh-agent-teams/docs/developing-dsh-plugins.md`
（从零开发 DSH 插件的权威流程，含 host/client 契约、构建、安装、踩坑清单）。

## 环境事实

- DSH 桌面版 `dsh-desktop` 0.9.1，内嵌 Harness 核心 `@deepseek-ai/dsh@0.1.5-rc.2`
- `DSH_HOME`：由 DSH 自己决定，默认 `%APPDATA%\dsh-desktop\harness`（**不要写死盘符**，
  用 `src/local.mjs` 的 `resolveDshHome()` 推导）
- DSH 安装位置：**因机器而异**。代码里不再写死任何安装路径，
  查找顺序是 `vendor/dsh` → 环境变量 `DSH_DESKTOP_APP` → `config.json` 的 `dsh.searchPaths`
  → 默认安装位置（`%LOCALAPPDATA%\Programs\DeepSeekHarness`、`C:\Program Files\DeepSeekHarness`）。
  换机器时用 `start.bat --check` 看它解析到了哪、来源是什么。
- 插件关键依赖（已验证）：`@deepseek-ai/cordis@4.0.2`、`@deepseek-ai/schemastery@3.18.2`、
  `@deepseek-ai/dsh-tools@0.1.5-rc.2`
- 桌面壳（0.2.5）：**Electron 38.8.6**（版本在 `desktop/package.json` 里**写死**），
  运行时由 `npm run desktop:fetch` 取到 `desktop/node_modules/electron/dist`
  （约 136 MB，走 npmmirror 镜像）；`desktop/node_modules/` 与 `.build-desktop/` **都不进 git**

## 仓库与配置（首次使用）

`config.json` **刻意不进 git**（含 SnowLuma accessToken 与模型 API key 明文，
而 git 历史里的密钥即使删除也仍可检出）。首次使用：

```bash
cd packages/qq-bridge
copy config.example.json config.json    # 模板：密钥与本机路径都是空的
```

`config.example.json` 是仓库里唯一受跟踪的配置模板，`setup.mjs --release` 会检查它是否干净。
`vendor/`、`logs/`、`cache/`、`workspace-qq/`、`snowluma/` 也都不进库（理由见 `.gitignore` 的注释）。

## 下一步

> ⚠️ 下面这几条是**第一版「DSH 进程内插件」路线**当时的待办；那条路线已废弃，
> 对应的包也已在 0.2.5 删除（存档：`docs/implementation-plan.md`）。保留仅为历史对照 ——
> 现在的实现与入口见 `packages/qq-bridge/README.md`。

1. ~~实现 `dsh-qq-bot` 的 OneBot 11 WebSocket 连接与鉴权（`packages/dsh-qq-bot/src/index.ts` 内的 TODO）~~ —— 该包已删除；这件事由 `packages/qq-bridge`（外部进程 + `dsh --profile sdk`）以另一条路线完成。
2. 消息接收 → Agent 会话路由；注册 `qq_bot_send_*` 工具。
3. `pnpm install` + `pnpm build` + `pnpm typecheck`（DSH 包 pre-release，必要时按指南软链类型）。
4. `dsh plugin --profile web add ...` 安装、`--dump-config` 验证、真实 QQ 联调。
