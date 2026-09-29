# InteractiveBot（「小鲸鱼」QQ 交互式机器人）

把**可配置的 QQ 对话机器人**接到 DeepSeek Harness（DSH）：QQ 消息 → DSH agent → 回答发回 QQ。

> **三个名字，各管一件事**（0.2.8 改名时定的）：
> · **项目名**：中文「小鲸鱼」QQ 交互式机器人 / 英文 `InteractiveBot`
> · **机器人名**：`小鲸鱼`（提示词里的人设名，代码与配置里都用它，别改）
> · **模块名**：`packages/qq-bridge` 与 `package.json` 的 `qq-bridge`（**刻意不改** ——
>   它是"桥接"这个模块的名字，改它要动几十条路径与文档，收益只有观感）
>
> ⚠️ **曾用名 `InteractBot`**：0.2.7 及更早的代码、文档、发布包都用这个名字。
> `docs/0.2.x-*.md` 这类**历史取证文档一字未动**（改它们等于篡改证据），
> 所以你在里面会看到旧名与旧发布包名，那是**故意**的。

> **当前状态：`packages/qq-bridge` 是唯一在维护的实现（0.2.8）**。它**不是** DSH 插件，
> 而是"外部进程 + `dsh --profile sdk`"的桥接。
> `packages/dsh-qq-bot（废弃）` 是第一版的"DSH 进程内插件"思路，仅作参考，不再改动。

## 开源说明（**动手前先读这 5 条**）

1. **许可证**：Apache-2.0（见 `LICENSE`、`NOTICE`）。第三方组件与出处见 `THIRD-PARTY.md`
   —— 里面**如实写了**一处未闭合的再分发合规缺口（发布包内没随附 Node.js 的 `LICENSE`）与补法。
2. **你要自备什么**：本仓库**不含** DSH 本体（自己去装桌面版）、**不含** QQ 协议端
   SnowLuma（它的许可证不允许随第三方分发包走）、**不含** ffmpeg（"视频识别"技能用）。
   详见 `THIRD-PARTY.md` 第三节。
3. **风险与免责**：本项目的做法（第三方协议端登录**个人 QQ**）**违反《QQ 用户协议》**，
   账号可能被限制或封禁。请只用自己的小号试、别在重要群刷。作者不承担任何账号后果，
   项目里那些"拟人延迟 / 频率上限"只是**降低**特征强度，**不是**保证。
4. **真机标识已换成占位号码**：仓库里所有 QQ 号 / 群号 / 账号 uin 都替换为
   `100000001`、`200000001`、`700000001` 这类占位号码（映射表不公开）。所以文档里的
   "真机日志"与你的实际号码**必然不同**，那是**故意**的，不是文档写错。
5. **发布包不进仓库**：`_release/` 已被 `.gitignore` 忽略，历史里也已清除
   （它曾把 `.git` 撑到 354.8 MB，其中 85.6 MB 是走 Git LFS 的 `node.exe`，
   而 clone 到手的只是 133 字节指针 —— 详见两份配置文件的注释）。
   成品包挂在 GitHub 的 **Releases** 里。

## 目录结构

```
InteractiveBot/
├── .dsh/skills/                    # 已安装的 DSH 插件开发 skill（10 个）
├── reference/                      # 上游参考（只读留档）
│   ├── dsh-agent-teams/            # skill 源 + 开发文档 + git 历史
│   ├── pixiv-lookup-1.1.0/         # ★ 第三方技能**原件**（适配前的逐字副本）
│   └── video-frames-1.0.0/         # ★ 同上：上游插件原件（plugin.json + index.js + frames.js）
├── packages/
│   ├── qq-bridge/                  # ★ 在维护的那个：QQ ↔ DSH 桥接（详见它自己的 README/AGENT.md）
│   │   ├── src/                    # 桥接主体（含扩展内核 extensions.mjs / 插件表 plugins.mjs）
│   │   ├── mcp/                    # 手写 MCP 服务器：QQ 工具 + 技能工具
│   │   ├── skills/                 # ★ 外部技能（`<id>/skill.json` + 入口）；当前装了 pixiv-lookup、sticker、video-frames
│   │   ├── config-ui/              # 控制台界面（React + Vite；改了 src 必须 npm run build）
│   │   └── docs/、CONFIG-UI.md、AGENT.md、PROJECT.json …
│   └── dsh-qq-bot（废弃）/
├── docs/                           # 版本级文档（设计 / 验收 / 适配存档）
│   ├── 插件设计规范.md              # ★ 扩展体系的契约（技能清单、生命周期、安全、UI、验收）
│   ├── 0.2.7-release-notes.md       # ★ 这一版：视频识别接线 + 三处静默失效清理
│   ├── 0.2.7-video-frames-migration.md   # 技能侧适配记录（上游 video-frames 1.0.0）
│   ├── 0.2.7-qq-video-inbound.md         # 核心侧接线记录（含第一次真机尝试的时间线）
│   ├── 0.2.7-sticker-cleanup.md          # 表情包链路上的五处修正
│   ├── 0.2.4-release-notes.md       # 自主发表情包
│   ├── 0.2.2-release-notes.md       # 这一版更新了什么
│   ├── 0.2.2-console-plan.md        # 控制台改造方案（**待指令，未实施**）
│   └── 0.2.2-pixiv-skill-migration.md + 0.2.2-pixiv-adaptation.patch
├── LICENSE / NOTICE / THIRD-PARTY.md   # 许可证、版权声明、第三方出处（开源后才加的）
├── probe-sdk.mjs + marker-outside.txt  # 阶段 1 的**沙箱边界探针**产物，故意留在根目录
│                                       # （回归基线，见 docs/implementation-plan.md §8）
└── README.md
```

## 0.2.8 这一版加了什么（一句话）

**改名 + 发布前把两处真问题修掉**：项目名从 `InteractBot` 换成 **`InteractiveBot`（「小鲸鱼」QQ 交互式机器人）**
（英文名 `qq-bridge` 在同一生态里已被另一个项目占用）；发布包前缀随之改为 `InteractiveBot-<版本>-win-x64`，
工作区里那份自动生成的简介副本改成品牌中立的 `store/project-intro.md`（老副本会自动清掉）。
同时修掉：**隐私闸把"提到指纹"当成"泄露隐私"、整条回复被吞**（真机上"指纹锁坏了"这类正常回答也会被吞），
以及两套**在受限沙箱里一直静默跳过**的全链路套件（第一次真跑抓到 16 项陈旧断言）。

详见 `docs/0.2.8-release-notes.md`；那 17 项红的完整交代在 `docs/0.2.7-release-notes.md` §5。

## 0.2.7 这一版加了什么（一句话）

**机器人现在能"看"群里发的视频**：视频直链由桥接交给模型，模型调「**视频识别**」技能抽帧，
帧落进工作区再用 `read_image` 逐张读。顺带清掉三处"不报错但会误导"的地方
（缺 ffmpeg 的文案、控制台的自检快照、技能提示词与能力不一致），
并把表情包那个"技能卡 + 插件卡各一个开关"收敛成**只剩一个**。

详见 `docs/0.2.7-release-notes.md` 与三份改动记录。

## 0.2.4 这一版加了什么（一句话）

**自主发表情包**：从你导入的表情库里按场景挑一张发出去，判定全在本地
（运行期**零模型调用**），发不发/发哪张都留了可回溯的理由。
三步用起来：

```bash
cd packages/qq-bridge
node src/index.mjs --stickers --import "C:\我的表情包"   # ① 导入（离线、零成本）
node src/sticker-tag.mjs --apply                        # ② 打标签（离线、一次性）
node src/index.mjs --stickers                           # ③ 看状态：几张能用、为什么没发
```

详见 `docs/0.2.4-release-notes.md`、技能自己的 `packages/qq-bridge/skills/sticker/README.md`。

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

## 仓库与配置（首次使用）

`config.json` **刻意不进 git**（含 SnowLuma accessToken 与模型 API key 明文，
而 git 历史里的密钥即使删除也仍可检出）。首次使用：

```bash
cd packages/qq-bridge
copy config.example.json config.json    # 模板：密钥与本机路径都是空的
```

`config.example.json` 是仓库里唯一受跟踪的配置模板，`setup.mjs --release` 会检查它是否干净。
`vendor/`、`logs/`、`cache/`、`workspace-qq/`、`snowluma/` 也都不进库（理由见 `.gitignore` 的注释）。

## 怎么跑起来（最短路径，Windows）

```bash
git clone <仓库地址> && cd InteractiveBot/packages/qq-bridge
npm install                               # 装 ws + undici（纯 JS，无需编译）
node setup.mjs                            # 把纯 JS 依赖收进 vendor/（幂等，可重复跑）
copy config.example.json config.json      # 然后填 SnowLuma 的 token 与模型 API key
node src/index.mjs --check                # 自检：DSH 在哪、协议端在不在、配置缺什么
node src/index.mjs                        # 正式跑
```

> ⚠️ **从源码跑必须先 `npm install`**：`vendor/`（包内自带的依赖副本）**不进 git**
> —— 只有发布包里才有。少了这一步，症状是启动时报 `缺少依赖「ws」`，
> `node setup.mjs` 会告诉你去哪儿找（它按 `vendor/` → 本包 `node_modules/` → 工作区 `node_modules/` 的顺序找源）。
> 网络不便时用 `npm install ws --no-save` 也够（`undici` 只有走代理的技能需要）。

带界面的方式是 `packages/qq-bridge/start.bat`。完整步骤（装 SnowLuma、首次联调、
控制台各页签的含义）见 `packages/qq-bridge/README.md` 与 `packages/qq-bridge/首次使用.txt`。

## 测试

62 个**离线**校验套件，不需要 QQ 也不需要 DSH：

```bash
cd packages/qq-bridge
npm test
```

其中需要真实 ffmpeg 的那一套（`npm run test:video-frames-real`）在你没装 ffmpeg 时会
**大声跳过**（打印原因、计数归零），不会假装通过 —— 这个项目里"静默跳过"被当成 bug 对待。

## 遗留：`packages/dsh-qq-bot`（已废弃，不要从这里接着做）

它是最初"DSH 进程内插件"的思路，`packages/dsh-qq-bot/src/index.ts` 里的 TODO 与
`pnpm install / build / typecheck` 那套流程**都停在半路**。保留它只为对照两种形态的差异；
当前唯一的维护方向是 `packages/qq-bridge`。
