# InteractiveBot（「小鲸鱼」QQ 交互式机器人）

**它在 QQ-协议端-桥接-DSH 链路里干的是"桥接"那一环**：QQ 协议端（SnowLuma）把消息交给它 → 它先判断**这一条要不要回、
按谁的权限回**，决定该带上哪些记忆、能力与工具，把整轮上下文交给 DSH agent → agent 的产出再经**投递前终检**发回 QQ。
换句话说：**"想与做"在 DSH 那边；"谁能用、什么时候回、记住什么、怎么发出去"在这一环。**

**本项目的愿景**：

1. 做出一个**拥有极高权限与智能**、能理解和执行命令、可**远程智能管理本地文件**的**交互式 QQ 对话机器人**。
2. 之所以基于 QQ bot 来做，是因为这种对话形态对使用者**接纳度更高、用起来更方便**；而它同时带来一个副作用：
   **对话形态 + bot 本身的智能，会直接让人对它产生更高的情感期待**。为了回应这种期待，项目也会继续做 bot 的
   **成长性与拟真性** —— 即便这部分开发有时与"智能"这个目标背道而驰。（这些都有各自的开关，不需要时可以关掉。）

> **三个名字，各管一件事**：
> · **项目名**：中文「小鲸鱼」QQ 交互式机器人 / 英文 `InteractiveBot`
> · **机器人名**：`小鲸鱼`（提示词里的人设名，代码与配置里都用它，别改）
> · **模块名**：`packages/qq-bridge` 与 `package.json` 的 `qq-bridge`（**刻意不改** ——
>   它是"桥接"这个模块的名字，改它要动几十条路径与文档，收益只有观感）
>
> ⚠️ **曾用名 `InteractBot`**：0.2.7 及更早的代码、文档、发布包都用这个名字。
> `docs/0.2.x-*.md` 这类**历史取证文档一字未动**（改它们等于篡改证据），
> 所以你在里面会看到旧名与旧发布包名，那是**故意**的。

> **当前状态：`packages/qq-bridge` 是唯一在维护的实现（0.2.9）**。它**不是** DSH 插件，
> 而是"外部进程 + `dsh --profile sdk`"的桥接。

## 开源说明（**动手前先读这 6 条**）

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
6. ⚠️ **本项目非官方，且入口图标是别人的品牌标志**：本项目与 DeepSeek / DeepSeek Harness（DSH）
   及其权利人**没有任何隶属、赞助或背书关系**。入口图标取自
   [LobeHub Icons](https://github.com/lobehub/lobe-icons) 的 **`deepseek` 品牌图标**
   （文件是 MIT，Copyright © 2023 LobeHub），而**商标权不在开源许可证里** ——
   它只用于指代"本项目连的是哪个生态"。要不要换成不含他人商标的图标、怎么换，
   写在 `THIRD-PARTY.md` 第一节（含一条命令）。

## 目录结构

```
InteractiveBot/
├── .dsh/skills/                    # 已安装的 DSH 插件开发 skill（10 个）
├── reference/                      # 上游参考（只读留档）
│   ├── dsh-agent-teams/            # skill 源 + 开发文档 + git 历史
│   ├── pixiv-lookup-1.1.0/         # ★ 第三方技能**原件**（适配前的逐字副本）
│   └── video-frames-1.0.0/         # ★ 同上：上游插件原件（plugin.json + index.js + frames.js）
├── packages/
│   └── qq-bridge/                  # ★ 唯一在维护的实现：QQ ↔ DSH 桥接（详见它自己的 README/AGENT.md）
│       ├── src/                    # 桥接主体（含扩展内核 extensions.mjs / 插件表 plugins.mjs）
│       ├── mcp/                    # 手写 MCP 服务器：QQ 工具 + 技能工具
│       ├── skills/                 # ★ 外部技能（`<id>/skill.json` + 入口）；当前装了 pixiv-lookup、sticker、video-frames
│       ├── config-ui/              # 控制台界面（React + Vite；改了 src 必须 npm run build）
│       └── docs/、CONFIG-UI.md、AGENT.md、PROJECT.json …
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

## 本项目实现了什么（功能清单）

> 逐项的"为什么这么做 / 踩过什么坑 / 失败长什么样"在 `packages/qq-bridge/AGENT.md`（给 agent 读的工程手册）
> 与 `packages/qq-bridge/PROJECT.json`（机器可核对的清单）里。标 **(0.2.9)** 的几项在当前工作树里已实现、
> 由下一次发布带出。

**① 对话链路（QQ → 桥接 → DSH → QQ）**

- 唤醒判定：私聊必答；群里**被 @ 或命中关键词**才回；人设里的名字表（`正式名/别名`）会变成**真正的唤醒词**
- ★ 语义唤醒（**二选一**）：规则说"回"之后，再由判定器决定**要不要沉默** —— 它**只做减法**，永远不会主动插嘴
- 权限与准入：管理员表 + 私聊/群白名单，**fail-closed**（名单为空 = 谁都不能用）；群内角色只用于显示，不参与判权限
- 同一会话串行、短时间去重、被更新的消息**作废旧回合**（但那一轮的操作与记忆照常结算）
- 人味层：拟人延迟（按字数折算）+ 静默时段 + 分条发送，**都能关**
- **投递前终检门**（内部标记不会漏到 QQ）+ 投递账本（谁在发、发到哪、有没有没发完的）
- 发送失败**不重发、更不重跑模型**（重复回复比漏一条更糟，补不补由人决定）
- 引用与检索闭环：提示词里给出消息 `#id`，正文可写 `[reply:#id]` / `[mid:id]`，**编的 id 不会生效**
- 断线缺口如实告知"别假装连续"；**(0.2.9)** 起还会把"**你被叫到之前，群里刚说了什么**"补进上下文

**② 记忆**

- 三层：全局 `MEMORY.md`（所有会话）· 群聊 `memory/groups/<群号>.md` · **个人 `memory/people/<QQ>.md`（跟人走：他的私聊 + 他在任何群发言时都生效）**
- 写入权在桥接：模型只能**提议**，落盘前过**唯一内容闸门**（身份权限 / 像行为指令 / 对不在场第三方的负面定性 / 隐私七类）
- 写入通道：关键词直写（"记住 X"）· 情绪倾注**(0.2.9)** · 承诺**(0.2.9)** · 模型标记 · 管理员手段 · 定时整理 · **按需建档**
- 更正与去重：新条目会标注旧条目（`〔已被更正〕` 并**停止注入**），不删历史；重复条目自动合并
- 整理：每小时空闲时自动 + 手动 `--memory --compact`（默认预演、可回滚、覆盖前备份）
- ★「整理记忆」按钮：把"还没计入记忆的消息"立刻整理成条目（**默认先预演给人看**，确认后才花那次模型调用）
- 可观测：零写入告警 · 记忆使用账本 · 记忆体检（"它说记住了" vs "**真的**记住了"）· 审计 `memory/audit.jsonl`（**不记原文**）
- 安全：绕过桥接改记忆会被**检测并回滚**；旧布局自动迁移 + 回退读（升级不失忆）

**③ 隐私与安全**（三处硬闸：写入侧 / 输出侧 / 语料库侧）

- 七类隐私（身份证 / 手机 / 银行卡 / 密码密钥 / 住址 / 健康 / 生物特征）**不落盘、不外发、不入库**；审计只记类别与长度
- 提示词加固：人设当**不可信输入**（命中注入话术整文件拒载）、反注入规则、别的 bot 不互相 @ 不接力
- 工具两道闸：`qq_api` **只读白名单** + 危险动作黑名单（每条都有断言盯着）
- 看图 / 视频直链的 **SSRF 防护**：拒绝内网、回环、云元数据、**逐跳**校验重定向，超限时**不读 body**
- 密钥不进日志与错误信息（失败理由逐条断言不含 key）

**④ 能力**

- **看图**：QQ 图片 → 工作区 → 模型直接看（默认按需 `read_image`，省钱）
- **视频**：「视频识别」技能抽帧 → 帧落工作区 → 逐张读；缺 ffmpeg 时**如实说看不到**，不许凭"有视频"猜内容
- **表情包**：导入 → 打标签（离线）→ 按场景自主挑一张发（**运行期零模型调用**，发不发都留可回溯的理由）+ 人工标注台
- **本地语料库**：每条消息入 SQLite，支持中文全文检索（FTS5 trigram + 短词 LIKE 回退）、30 天 TTL，含隐私的消息**不入库**
- **QQ 工具（MCP，14 个动作，档位 full）**：发图 / 表情 / 戳一戳 / 撤回 / 群成员 / 消息详情 / 群历史 / 搜历史 / 表情回应 / 正在输入 / 合并转发 / `qq_api`…
- **配方库**：把"这种事一般怎么做"沉淀成可复用步骤，按当前消息相关性挑一条注入
- **任务台账**：从工具调用自动提炼"我在做什么、做到哪一步"，支持"回到第 N 步"与作废/重做

**⑤ 扩展体系**（技能 = 外部能力包，插件 = 内置能力块）

- 已装技能：`pixiv-lookup`（Pixiv 检索）· `sticker`（表情包）· `video-frames`（视频抽帧）
- 内置插件卡：记忆 · 看图 · QQ 工具 · 表情包 · 人味层 · 用量 · 唤醒策略 · 投递 · 语料库 · 人设 · 权限
- 两型都能在控制台随时开关：**提示词下一轮生效、工具调用当场 fail-closed**；只有装 / 卸技能要重启
- 契约与验收见 `docs/插件设计规范.md`

**⑥ 控制台（`config-ui/`，React + Vite）**

- 八个页签：概览 · 人设 · 节奏与成本 · 记忆 · 协议端 · 高级 · 对话 · 扩展
- 记忆树可看可改（**保存会先把上一版备份**）、「整理记忆」按钮、人设库多套切换 / 改名 / 删除
- 用量与成本（token 是**量出来的**、成本是**按价目表估的**，两者分开放）、操作日志、会话镜像、协议端探测与拉起 SnowLuma
- 改过 `config-ui/src` **必须 `npm run build`**；`--ui` 回答"手上这份 dist 是不是当前源码构建的"

**⑦ 运行与发布**

- 自检 `--check`（不连任何服务）与体检 `--doctor`（真连一次，逐条说人话）
- 进程守卫：**绝不重复起第二个实例**（两个会抢同一个 OneBot 事件流）
- 凭据发现：环境变量 → 配置 → `$DSH_HOME/.credentials.yaml`，保守读，并说明这次选了哪个
- SnowLuma：探测 / 防重复拉起 / **就绪等待**（"控制台开着" ≠ "已登录"）
- 发布：`scripts/assemble-release.mjs` 按清单组装（**用户数据绝不进发布包**，有断言盯着），成品挂 GitHub Releases
- 日志与侧车（审计 / 账本 / 统计 / 游标）都在工作区里，**不进 git**

**⑧ 工程纪律**（这个项目最花时间的部分）

- **64 套离线校验**（不需要 QQ、不需要 DSH、不花钱）：`npm test`
- 提示词有**逐字基线**与**段的顺序快照**：改措辞要显式更新基线，不能"看着像对的"
- **接线级测试**：走完整 Bridge 断言"这段真的注入了 / 这次真的一次请求都没发"—— 纯函数测试看不见接线
- **静默失败当 bug 对待**：增强路径可以失败，但不许**安静地**失败
- 文档 / 清单 / 代码三方一致性由 `mocks/verify-manifest.mjs` 核对（配置键、接口路径、UI 源码入库…）

## 0.2.9 这一版加了什么（一句话）

**记忆从"一个文件"变成三层（全局 / 群聊 / 个人），而"记住"不再依赖模型自觉**：
关键词直写之外多了**情绪倾注**与**承诺**两条**本地判定、命中即落盘**的通道；
个人档**跟人走**（对某个人的记忆在**他自己的私聊**里也生效）；未唤醒的群消息现在会把
「你被叫到之前，群里刚说了什么」补进上下文；控制台多了**「整理记忆」按钮**
（把还没计入记忆的消息立刻整理成条目，**默认先预演给人看**）。

详见 `docs/0.2.9-release-notes.md`（含"哪些只有离线证据、哪些还没上过真机"的如实分开）。

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

64 个**离线**校验套件，不需要 QQ 也不需要 DSH：

```bash
cd packages/qq-bridge
npm test
```

其中需要真实 ffmpeg 的那一套（`npm run test:video-frames-real`）在你没装 ffmpeg 时会
**提醒**（打印原因、计数归零），不会假装通过 —— 这个项目里"静默跳过"被当成 bug 对待。

