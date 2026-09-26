# project_InteractBot

以 **DSH 插件**形式，把**可配置的 QQ 对话机器人**接入 DeepSeek Harness（DSH）。

目标：`dsh-qq-bot` 插件负责连接 QQ 协议端（OneBot 11：NapCat / Lagrange / go-cqhttp，必要时可换 AstrBot 等框架），把 QQ 消息转发给 DSH Agent，并注册工具让 Agent 回复消息。

## 目录结构

```
project_InteractBot/
├── .dsh/
│   └── skills/                    # 已安装的 DSH 插件开发 skill（10 个）
├── reference/
│   └── dsh-agent-teams/           # 上游参考仓库（skills 源 + 开发文档 + git 历史）
├── packages/
│   └── dsh-qq-bot/                # QQ 机器人 DSH 插件（脚手架已就绪）
│       ├── package.json
│       ├── cordis.patch.yml
│       ├── tsconfig.json
│       └── src/index.ts
├── README.md
└── .gitignore
```

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
`vendor/`、`logs/`、`cache/`、`workspace-qq/`、`snowluma/` 也都不进库（理由见 `.gitignore` 的注释）。

## 下一步

1. 实现 `dsh-qq-bot` 的 OneBot 11 WebSocket 连接与鉴权（`packages/dsh-qq-bot/src/index.ts` 内的 TODO）。
2. 消息接收 → Agent 会话路由；注册 `qq_bot_send_*` 工具。
3. `pnpm install` + `pnpm build` + `pnpm typecheck`（DSH 包 pre-release，必要时按指南软链类型）。
4. `dsh plugin --profile web add ...` 安装、`--dump-config` 验证、真实 QQ 联调。
