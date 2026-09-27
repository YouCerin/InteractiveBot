# project_InteractBot

把**可配置的 QQ 对话机器人**接到 DeepSeek Harness（DSH）：QQ 消息 → DSH agent → 回答发回 QQ。

> **当前状态：`packages/qq-bridge` 是唯一在维护的实现（0.2.4）**。它**不是** DSH 插件，
> 而是"外部进程 + `dsh --profile sdk`"的桥接。
> `packages/dsh-qq-bot（废弃）` 是第一版的"DSH 进程内插件"思路，仅作参考，不再改动。
>
> ★ **0.2.4 起，用户双击的是桌面程序**（`_release/<包>/app/InteractBot.exe`）：
> 一个真正的窗口 + 右下角托盘，**不再依赖浏览器**；关窗口不会让机器人下线。
> 界面还是同一份 `config-ui/dist`（窗口加载的是桥接伺服的地址），源码一行没改。

## 目录结构

```
project_InteractBot/
├── .dsh/skills/                    # 已安装的 DSH 插件开发 skill（10 个）
├── reference/                      # 上游参考（只读留档）
│   ├── dsh-agent-teams/            # skill 源 + 开发文档 + git 历史
│   └── pixiv-lookup-1.1.0/         # ★ 第三方技能**原件**（适配前的逐字副本）
├── packages/
│   ├── qq-bridge/                  # ★ 在维护的那个：QQ ↔ DSH 桥接（详见它自己的 README/AGENT.md）
│   │   ├── src/                    # 桥接主体（含扩展内核 extensions.mjs / 插件表 plugins.mjs）
│   │   ├── desktop/                # ★ 0.2.4 桌面壳（窗口 + 启动器；main/lib/preload/splash）
│   │   ├── scripts/                # 构建脚本（打桌面壳、打发布包；**不进发布包**）
│   │   ├── mcp/                    # 手写 MCP 服务器：QQ 工具 + 技能工具
│   │   ├── skills/                 # ★ 外部技能（`<id>/skill.json` + 入口）；当前装了 pixiv-lookup
│   │   ├── config-ui/              # 控制台界面（React + Vite；改了 src 必须 npm run build）
│   │   └── CONFIG-UI.md、AGENT.md、PROJECT.json …
│   └── dsh-qq-bot（废弃）/
├── docs/                           # 版本级文档（设计 / 验收 / 适配存档）
│   ├── 插件设计规范.md              # ★ 扩展体系的契约（技能清单、生命周期、安全、UI、验收）
│   ├── 0.2.4-release-notes.md       # ★ 这一版更新了什么（桌面程序 + .exe）
│   ├── 0.2.3-release-notes.md       # 上一版（插件化：二选一 / 唤醒策略 / 投递 / 语料库）
│   ├── 0.2.2-console-plan.md        # 控制台改造方案（**待指令，未实施**）
│   └── 0.2.2-pixiv-skill-migration.md + 0.2.2-pixiv-adaptation.patch
└── README.md
```

## 0.2.4 这一版加了什么（一句话）

**桌面程序**：把控制台界面装进一个真正的窗口，并让启动方式变成一个 `.exe`
（`app\InteractBot.exe` —— 免安装目录版，自带 Electron 运行时）。
界面**一份没改**、接口**一个没加**（窗口加载的还是桥接伺服的 `config-ui/dist`）；
关窗口收到托盘、机器人继续在线。详见 `docs/0.2.4-release-notes.md`。

## 0.2.3 及以前

**扩展系统**（0.2.2）：技能（外部能力包，`skills/<id>/`）与插件（桥接内置能力块）两型，
**都能随时开关**（提示词下一轮生效、工具调用当场 fail-closed；只有装/卸技能要重启）。
**插件化**（0.2.3）：二选一机制 + 唤醒策略（可沉默）/ QQ 工具档位 / 投递账本 / 语料库。
详见 `docs/0.2.3-release-notes.md`、`docs/0.2.2-release-notes.md` 与 `docs/插件设计规范.md`。

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

## 仓库与配置（首次使用）

`config.json` **刻意不进 git**（含 SnowLuma accessToken 与模型 API key 明文，
而 git 历史里的密钥即使删除也仍可检出）。首次使用：

```bash
cd packages/qq-bridge
copy config.example.json config.json    # 模板：密钥与本机路径都是空的
```

`config.example.json` 是仓库里唯一受跟踪的配置模板，`setup.mjs --release` 会检查它是否干净。
`vendor/`、`logs/`、`cache/`、`workspace-qq/`、`snowluma/`、`desktop/node_modules/`、
`desktop/.npm-cache/`、`.build-desktop/` 也都不进库（理由见 `.gitignore` 的注释）。

## 下一步（等使用者指令）

> ⚠️ 下面这几条**不是**第一版 `dsh-qq-bot（废弃）` 的 TODO —— 那些已经作废了。
> 当前实现是 `packages/qq-bridge`，它的权威待办在 `packages/qq-bridge/AGENT.md` §8
> 与 `PROJECT.json` 的 `roadmap`。

1. ★ **在真机上点一遍 `app\InteractBot.exe`**（0.2.4 唯一没验到的一步）：
   窗口会不会开、托盘在不在、关窗口后机器人是否还在线。若起不来先看 `logs\desktop.log`。
2. 控制台按 `CONFIG-UI.md` 重新生成（§2.2 人设库 / §2.5 昵称 / §2.10 扩展页 + §1 的加减法）——
   ⚠️ 用户要求「UI 改动只写指导文件，不直接改 UI 源码」，实现侧清单在 `docs/0.2.2-console-plan.md` §0。
3. pixiv 技能的**真机取图/发图**（代理那一步需要 `vendor/node_modules/undici`）。
4. **群聊实测**（代码与配置都已放行，但至今没有一条真实群消息跑过）。
