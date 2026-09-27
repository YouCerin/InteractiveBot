# qq-bridge — QQ ↔ DSH 桥接

把 QQ 里的消息转给一个**有完整能力的 DSH agent**，再把它的回答发回 QQ。

> **📖 先读哪一份？**
> - **你想先知道"这项目是什么、各模块怎么实现的、agent 到底有多大权限"** →
>   读 **`docs/项目简介.md`**（一页：数据流 / 模块表 / 12 条特色 / 权限硬墙与软墙 / 文档地图）
> - **你只是想把它跑起来、不想看代码** → 在发布包里双击 **`app\InteractBot.exe`**
>   （★ 0.2.5 起的主入口：它自己找到包根 → 把桥接拉起来 → 开一个**真正的程序窗口**。
>   要自检就 `start.bat --check`，要真连一次 SnowLuma 体检就 `start.bat --doctor`）
>   ★ 0.2.5：原先那份 `先读我-首次使用.txt` 与 `检查配置.bat`、`体检.bat` 已删除；
>   ★ 本版**没有 .bat 启动器**（0.2.4 那批中文名 .bat 入口已按用户要求一并删除），
>   所以「**没有启动器也能找到包根**」是硬要求 —— 见下文「桌面壳」那一节
> - **你是 AI agent，或想五分钟上手** → 读 **[AGENT.md](AGENT.md)**（操作说明 + 绝对不能改的六件事）
> - **你需要机器可读的包契约**（命令 / 配置键 / 不变量 / 故障特征） → 读 **[PROJECT.json](PROJECT.json)**
> - **你要打发布包（zip）** → 读 **[RELEASE.md](RELEASE.md)**（前置条件 / 要清空的密钥 / 验收清单）
> - **你要改权限或身份核实** → 先读仓库根目录的 **`docs/identity-verification.md`**
>   （身份是核实出来的、权限是配置定的，两者**永不互相推导**；那里写清了为什么）
> - **你要确认"它到底记没记住"** → 读 **`docs/memory-verification.md`**，
>   并跑 `node src/index.mjs --memory`（只读，随时可跑）
> - **你要理解"为什么这么设计"** → 就是本文件（往下读）
>
> 三份文档由 `mocks/verify-manifest.mjs` 自动核对一致性 —— 代码改了但文档没同步时，
> 测试会失败。这是刻意的：**说明书撒谎比没有说明书更糟。**

> 与 `packages/dsh-qq-bot` 的关系：那个是**旧架构**（DSH 进程内插件，用一次性
> `llm.stream` 调用，没有工具循环、没有沙箱、没有权限概念）。本目录是**新架构**。
> ★ 0.2.5：旧目录已按用户要求**删除**（此前的说法是"保留仅作参考"）——
> 它是**有意删掉的**，不要重建；旧方案存档在 `docs/design.md` 与 `docs/implementation-plan.md`。

---

## 一句话原理

```
QQ ──OneBot11──> qq-bridge ──stdio JSON-RPC──> dsh --profile sdk
                    │                              （完整 agent：工具/沙箱/会话）
                    └────────── 回答 ◄──────────── session.event
```

桥接只做四件事：**收消息、判断该不该回、转给 DSH、把回答发回去**。
真正"干活"的是 DSH，我们不重复实现它。

---

## 快速开始

```bash
# ① 一次性准备：把 Node 运行时和纯 JS 依赖收进包内（幂等，可重复跑）
node setup.mjs

# ② 配置自检（不连接任何服务）
node src/index.mjs --check

# ③ 填 config.json 里的 access.adminUsers（你自己的 QQ 号，必填！）

# ④ 跑测试（不需要 QQ、不花模型费用）
npm test                         # 全部离线套件（实测：所有套件退出码 0）

# 想单独跑某几套（下面括号里是**离线环境**下的断言条数；条目声明见 PROJECT.json）
node mocks/verify-manifest.mjs   # 包契约自检：文档与代码是否一致（33 项）
node mocks/verify-imports.mjs    # ★★ 导入与登记漂移审计：坏了才炸的导入、孤儿模块、漏登记的套件（9 项）
node mocks/verify-release-hygiene.mjs # ★★ 发布卫生：用户数据不许进包、大小写绕不过、接线断言（33 项）
node mocks/verify-api.mjs        # 配置接口：脱敏、空值语义、回环限制（89 项）
node mocks/verify-api-h13.mjs    # ★★ H13 四个接口（真起 HTTP 服务）：漏 await、token 泄露、跨会话检索、**畸形返回不拖垮进程**（29 项）
node mocks/verify-config.mjs     # 配置解析与校验（42 项）
node mocks/verify-units.mjs      # 纯逻辑：文本/唤醒/会话/防自环/人味层/人设/记忆
node mocks/verify-persona.mjs    # ★★ 人设加固：反注入拦得住、正常人设不许误伤、名字表真的能唤醒（52 项）
node mocks/verify-images.mjs     # 看图：SSRF 防护 + 防 DoS（145 项）
node mocks/verify-identity.mjs   # ★ 身份核实：谁在说话、会话名、"身份不得变成权限"、权限判据自解释（57 项）
node mocks/verify-memory-store.mjs # 记忆存储层：分档、内容过滤、篡改回滚、**注入面规则**（97 项）
node mocks/verify-memory-roundtrip.mjs # ★★★ 走完整桥接：记忆全链路 + **注入接线** + **段顺序快照 / 逐字基线**（130 项）
node mocks/verify-session-state.mjs # ★★ 会话状态机：与任务台账**两条轴**、水位（旧回合作废的显式形式）、话头恰好活一轮（48 项）
node mocks/verify-memory-stats.mjs # ★★ 记忆可观测性：计数、零写入告警、体检漏报修复（29 项）
node mocks/verify-memory-supersede.mjs # ★★ 记忆更正：旧条目不删只标注、注入里不再出现、"换成/其实"不许误判（50 项）
node mocks/verify-corpus.mjs      # ★★ 本地语料库：中文 2 字走 LIKE 回退、隐私不落库、TTL 只预演（43 项）
node mocks/verify-transport.mjs    # ★★ 传输契约：失败分类带 retryable、去重键带会话、断线缺口要标注（35 项）
node mocks/verify-token-discovery.mjs # ★★ 凭据发现：显式账号找不到就绝不复用别的账号、只认回环、拒控制字符（53 项）
node mocks/verify-markers.mjs       # ★★ 带内标记：[reply:id]/[sticker:名] 的解析与剥离、没有的东西不教（35 项）
node mocks/verify-delivery-gate.mjs # ★★★ 投递前终检门：内部泄漏拦得住、正常回复一个字不动（47 项）
node mocks/verify-memory-keyword.mjs # ★★★ 关键词直写：用户说「记住 X」必落盘、问句与自己人回忆不许误认（35 项）
node mocks/verify-memory-consolidate.mjs # ★★ 记忆整理：幂等性、多行条目、前缀摘除、**定时整理接线**（74 项）
node mocks/verify-memory-usage.mjs # ★★ 记忆使用侧车：只提示不降权（D9）、"没有数据≠没被用过"、新记忆不许被上限挤掉（54 项）
node mocks/verify-delivery-ledger.mjs # ★★ 投递账本：发送前落账、pid@启动时刻、**绝不自动重发**（30 项）
node mocks/verify-mcp-tools.mjs    # ★★ QQ 工具纯逻辑：动作名真机验过、权限提示不漏、本地工具 fail-closed（55 项）
node mocks/verify-privacy.mjs     # ★★ 隐私硬闸：七类拦得住、**真实记忆 60 条零误拦**、审计不含原文（62 项）
node mocks/verify-oplog.mjs       # ★★ 操作日志：参数与结果都记下、参数先解析再截值、超时回合也留痕（49 项）
node mocks/verify-tasks.mjs       # ★★ 任务台账 + 回到第N步：零模型参与也完整、连续回退能恢复、闲置要降级（125 项）
node mocks/verify-recipes.mjs     # ★★ 配方库：长尾匹配要命中、置信度用平滑、requiredActions 不自动执行（67 项）
node mocks/verify-extract.mjs     # ★★ 抽取解析：真实 headless 输出（裸词 / 多两个 `}`）都要能解析（71 项）
node mocks/verify-memory-roundtrip.mjs # ★★★ 走完整桥接：记忆全链路 + **注入接线**（任务段/配方段真的进提示词）
node mocks/verify-mcp.mjs        # QQ 工具服务器（工具清单、黑名单拦截、参数校验、错误不外泄）
node mocks/verify-rpc.mjs        # 协议层：与模拟 DSH 的 JSON-RPC（★ 需要能起子进程）
node mocks/verify-onebot.mjs     # 全链路：QQ 事件 → 回复发出（★ 需要能起子进程）
node mocks/verify-real-dsh.mjs   # 真实 dsh 能否被启动（零费用；★ 需要能起子进程）
node mocks/verify-doctor.mjs     # 体检工具自身的准确性（30 项）
node mocks/verify-desktop.mjs    # ★★ 桌面壳（0.2.5，一百多项，**不启动 Electron**）：包根三级判据**照真实发布包布局**断言、产物形状、状态翻译
node mocks/verify-live.mjs       # ★ 真实端到端（会调用模型，有少量费用）
node mocks/verify-live.mjs --clean   # 清理测试留下的临时目录

# 提示词取证（不是测试）：从 DSH 落盘的会话记录里搜出「模型这一轮实际收到了什么」。
# 改过提示词文本之后**只有这个办法能证明它真的生效了** —— 桥接拼完就交给 DSH，中间没有日志。
node mocks/session-grep.mjs "直接写事实"   # 搜最近 3 个会话；没命中就退 1
node mocks/probe-ui-bundle.mjs       # 界面产物探针：**正在伺服的那份 UI** 有没有本轮新功能（改了 React 忘了 build 不会报错）
node mocks/probe-memory-search.mjs   # 记忆检索接口探针：501 与 200 能分开（依赖名写错会伪装成"未实现"）
node mocks/probe-h13-endpoints.mjs   # H13 四个接口探针（含 preflight / 日志流 / 账号 / 语料检索）
node mocks/probe-memory-injection.mjs # ★ 记忆**注入面**：哪些行会注入、哪些不会、为什么（加 private:<QQ号> 看某会话真实注入正文）
node mocks/probe-memory-injection.mjs private:100000001   # 某个会话**真实**会收到的记忆正文
node mocks/session-grep.mjs --list        # 只列有哪些会话、多大、什么时候写的

# ⑤ 体检（真正检查连接是否可用，强烈建议先跑）
start.bat --doctor

# 📄 更新汇总（给人看的：这次改了什么、怎么验、刻意不做什么、还差什么）
#   docs/0.2.3-release-notes.md        ← 先看这一份（插件化：二选一 / 唤醒策略 / QQ 工具档位 / 投递 / 语料库）
#   docs/0.2.3-change-record.md        ← 逐条过程记录（含踩过的坑与两次"我错了"）
#   docs/plugin-packaging-plan.md      ← 插件化怎么划分（哪些拆开、哪些合并、哪些二选一）
#   docs/0.2.1-release-notes.md        ← 上一版的对应文档
#   docs/0.2.1-hermes-borrow-plan.md   ← 逐阶段过程记录（含踩过的坑与被推翻的判断）
#   docs/0.2.1-runtime-memory-verification.md ← 真机取证（哪些有硬证据、哪些还没有）

# ⑤-b 记忆体检（只读；机器人正在跑的时候也能执行）
#   ★「它说记住了」和「它真的记住了」是两件事 —— 这条命令回答后者。
#   详见仓库根目录 docs/memory-verification.md
node src/index.mjs --memory           # 记了什么 + 下一轮按会话会注入什么
node src/index.mjs --memory --full    # 注入内容整段打印
node src/index.mjs --memory --json    # 给脚本/界面用

# ⑤-b1b 记忆使用账本（H3，**只读、只提示**）：哪条记忆已经很久没进过上下文了
#   ★ 动机：记忆只增不减，而注入有 25 条上限 —— 死条目会吃掉预算，我们却无从知道。
#   ★★ 它**不降权、不归档、不删**（设计决策 D9：不做强度浮点衰减），只把事实摆出来。
#   ★ 注意用词：我们能看到的是"**被注入**"，不是"**被用上**"（模型依赖了哪条观测不到）。
node src/index.mjs --memory --usage   # 最久没进过上下文的条目（含"从没进过"的那些）

# ⑤-b1c 投递账本（H15，**只读**）：哪些回复正在投递、有没有没发完的
#   ★ 来自真实事故：一条已经生成好的回复在拟人延迟期间因重启而永远消失，当时无人知道。
#   ★★ 我们**不自动重发**（崩溃可能发生在"已发出但没标上"那一瞬间，无法区分 →
#      自动重发会产生重复回复，而重复回复比漏一条更糟）。补不补由人决定。
node src/index.mjs --delivery         # 最近 30 条 + 上一次没发完的

# ⑤-b2 记忆写入统计（只读）：到底写了没有、什么时候写的、要不要报警
#   ★★ 为什么有这条命令：实测聊了几十轮**一条记忆都没写**，而**没有任何地方报警**
#      —— 发现它靠人工去解 DSH 的会话落盘记录。详见 docs/0.2.1-memory-diagnosis.md
node src/index.mjs --memory --stats   # 每会话 轮数/提议/接受/拒绝/去重 + 最后落盘时间
node src/index.mjs --memory --stats --reset   # 清空统计（memory/.stats.json）

# ⑤-b3 记忆整理（规则版）：把模型写的"流水账"收敛成可用的记忆
#   ★ **默认预演、不写盘**；要真改加 --apply（会先备份，再刷新快照基准 ——
#     不刷新的话下次读记忆会被 verifyAndRestoreMemory 回滚）
#   做四件事：标点归一 / 摘掉行首冗余的日期与"他说"前缀 / 合并高度相似条目 /
#   解析多行条目（保留分节结构，不拍平）
node src/index.mjs --memory --compact            # 预演：只算不写
node src/index.mjs --memory --compact --apply    # 真改（带备份 + 快照刷新）
node src/index.mjs --memory --compact --file memory/private-123.md   # 只处理一个文件

# ⑤-b4 隐私扫描（只读）：现有记忆里有没有该被拦的东西
#   ★ 隐私是**双侧硬闸**：写入侧拒绝落盘 + 输出侧拒绝发送。
#     七类：身份证 / 手机号 / 银行卡 / 密码密钥 / 住址 / 健康医疗 / 生物特征。
#     **QQ 号、群昵称、群名片、群号不是隐私**（它们是公开标识，拦了记忆系统就死了）。
#   ★ 先扫再装闸门 —— 装完才发现它把正常记忆全拦了，比不装更糟。
node src/index.mjs --memory --privacy

# ⑤-b5 记忆变更审计（只读）：这条是**谁**在**什么时候**、通过**哪条通道**写进去的
#   ★ 写入通道有四条（关键词直写 / 模型标记 / 管理员手段 / 整理合并），
#     而日志只有一行"接受 N 条" —— 不说是哪一条、也不说是哪条通道。
#   ★★ 审计**只记长度、不记原文**：它若也存一份内容，自己就成了第二个泄露面。
node src/index.mjs --memory --audit              # 最近 50 条
node src/index.mjs --memory --audit --limit 200  # 看更多

# ⑤-b6 本地语料库（H7）：**搜"过去说过什么"**（机器人也能搜，见 MCP 工具 qq_search_history）
#   ★ 在此之前回看历史只能"现拉"（qq_group_history），不能检索、协议端一重启就没了。
#   ★ 三条边界：**七类隐私不落库**（写之前拦）、**30 天 TTL**、**不存媒体本体与路径**。
node src/index.mjs --corpus                                   # 统计
node src/index.mjs --corpus --search "霸王茶" --inject group:700000001 --limit 8
node src/index.mjs --corpus --prune                           # 预演（只算不删）
node src/index.mjs --corpus --prune --apply                   # 真删
node src/index.mjs --corpus --rebuild                         # 重建 FTS 索引
#   输出里还会列出拦截审计（memory/privacy-audit.jsonl）——
#   审计**只记类别与字数，不记原文**，否则拦截本身就成了泄露通道。

# ⑤-b5 操作日志（只读）：它**自己干过什么**
#   ★ 数据是**桥接从事件流自己写的**，不问模型（诊断已证明"让模型报告自己
#     做过什么"漏报率极高）。每次工具调用的参数、每条结果的状态/字节/摘要都在。
#   ★ 只留结果摘要（300 字），全文在 DSH 的会话记录里 ——
#     操作日志是"干了什么"的索引，不是内容仓库。
node src/index.mjs --ops                       # 看最近的流水
node src/index.mjs --ops --inject group:700000001 --limit 100
node src/index.mjs --ops-prune                 # TTL 清理预演（默认不删）
node src/index.mjs --ops-prune --apply         # 真删（保留 7 天）

# ⑤-b6 任务台账（只读）：它"正在干什么、干到哪了" + **注入预览**
#   ★ 这是"**不丢主线的锚**"：DSH 的会话上下文我们够不到（SDK 没有 resume、
#     也控制不了压缩），长会话里早期内容被挤出时模型就丢主线。
#     改不了它，就在里面钉一个锚 —— 把"当前任务"每轮注入。
#   ★ 目标取**用户原话**、步骤从操作流水机械提炼 —— **零模型参与也完整**
#     （"靠模型自觉记一笔"那条路已被实测证伪两次）。
node src/index.mjs --tasks                    # 看台账 + 模型每轮看到的原文
node src/index.mjs --tasks --inject group:700000001
node src/index.mjs --tasks-archive [--apply]  # 归档过期台账（默认预演，是移走不是删除）
node src/index.mjs --tasks --forget group:700000001

# ⑤-b7 回到第 N 步
#   ★ 三件如实说明（做不到的必须说清，否则就是个骗人的功能）：
#     · **DSH 的会话上下文不会回退** —— 实测 17 种事件类型里零条
#       checkpoint/fork/revert/resume，模型仍然"记得"那些步骤。
#       我们唯一的手段是在提示词里**声明作废**（是声明，不是清除）。
#     · **副作用不回退** —— 已发出的 QQ 消息、已写入的文件都不会回滚。
#     · **越界不猜** —— 报错并给出可用范围。
#   ★ 触发词**本地匹配**（「回到第3步」「撤销这一步」「回到上一步」），
#     不让模型插手 —— 同记忆写入的教训：靠模型自觉的路漏报率极高。
#   ★ 在群里/私聊直接说「回到第3步」也会被识别并当场生效。
node src/index.mjs --tasks --rollback 3 --inject group:700000001
node src/index.mjs --tasks --rollback 3 --inject group:700000001 --mode retry --note "那步读出来是乱码"

# ⑤-b8 配方库：沉淀"怎么做"、同类任务直接套用
#   ★ 与任务台账是两个轴：台账说"我正在干什么"（当下），配方说"这种事一般怎么做"（积累）。
#   ★ 匹配是**零模型成本**的本地打分（子串命中 + 命中率），阈值内的才注入。
#   ★ 置信度用拉普拉斯平滑 (ok+1)/(used+2)，60 天半衰期**只降权不删** ——
#     过时的做法仍可检索，只是不再自动注入。
node src/index.mjs --recipes                          # 列出（按置信度）
node src/index.mjs --recipes --match "帮我查个品牌"     # ★ 预览会命中哪条 + 注入原文
node src/index.mjs --recipes --show 调研品牌可信度
node src/index.mjs --recipes --add --file 配方.json     # ★ 推荐 --file（--json 易被 shell 搅坏）
node src/index.mjs --recipes --disable 调研品牌可信度    # 停用/启用/删除
node src/index.mjs --recipes --extract --inject private:<QQ> [--dry]
                                  # ★ 手动跑一次"自动沉淀"（调试用；会调用一次模型，--dry 不入库）
                                  #   平时它自己每 5 轮在后台跑一次，不必手动执行

# ⑤-c 界面新鲜度（只读）：这份 dist 是不是当前源码构建的？
#   ★ 界面分两条路出货（开发路径与发布包路径），**脱钩过一次**且测试全绿。
#   详见 RELEASE.md §1 与 CONFIG-UI.md「构建溯源」
node src/index.mjs --ui               # fresh=0，stale/unstamped=1
node src/index.mjs --ui --dist <某个包的 config-ui/dist>   # 查别人给的那份

# ⑥ 启动
#   发布包：双击 app\InteractBot.exe   ★ 0.2.5 主入口：开程序窗口，并自己把桥接拉起来
#   源码侧：npm run desktop           ★ 跑 desktop/ 那份壳源码，数据落源码侧包根；
#                                       改完壳重启这条命令即可，**不必重新打包**
start.bat                        # "浏览器那条路"；或 node src/index.mjs
# ★ 0.2.5：带图标的快捷方式入口（旧 QQbot.lnk / 创建带图标的快捷方式.bat）已删除 ——
#   要图标就右键 app\InteractBot.exe 自己建快捷方式，图标用 assets\icon.ico
# start.bat 现在会先拉起 SnowLuma，再起桥接；一旦发现 app\InteractBot.exe 存在，
# 它就**不再打开浏览器**（否则同一台机器上会出现两个控制台）。
# 跳过 SnowLuma：start.bat --no-snowluma
```

当前状态：**离线 50 套全部退出码 0**（逐套数字见 `PROJECT.json` 的 `commands[].assertions`；另有 3 套在受限沙箱里**跳过**，见下）；真实 QQ 端到端实测通过（含 QQ 原生工具调用）。

> ⚠️ **这里刻意不写「多少项断言」**。原先写的是「2188 项断言 / 38 套」，而它是**手工维护的求和**，
> 已经漂到对不上（同一时期 `commands[].assertions` 的登记合计是另一个数）。
> 一个对不上的总数比没有总数更坏 —— 它看起来是取证过的。
> 详见 `PROJECT.json` 验证一节：那里只发布**逐套实跑核对过**的数字，并逐类点名**哪些没被核对过**。

> ⚠️ 标了「★ 需要能起子进程」的几套，在受限沙箱里会 **EPERM**。
> 那种情况下它们会**明确打印「跳过」并说明这不是通过**（跑不了就说跑不了），
> 而不是伪装成绿色 —— 请在正常 Windows 会话里重跑以得到完整结论。
> 上面那套 `verify-identity`（身份核实）**全桩、不需要 spawn**，所以在任何环境都是真跑。
启动后还会同时提供**本地配置接口** `http://127.0.0.1:3410`（给配置 UI 用，规格见 `CONFIG-UI.md`）。

---

## 桌面壳：控制台从"浏览器里的一张网页"搬进**真正的程序窗口**（0.2.5 新增）

这一版做了两件事：

1. 把控制台 UI 从"浏览器里的一张网页"搬进一个**真正的程序窗口**
   （**Electron 38.8.6**，运行时**自带** —— 免安装，目标机器**不需要装 Node**）；
2. 把启动方式**打包成 .exe**。

### 三种开法（发布包 / 源码侧 / 打 exe）

| 场景 | 怎么做 |
|---|---|
| **最省事（源码侧双击）** | 双击**仓库根**的 **`desktop.bat`** —— 它用包内 `vendor\node\node.exe` 直接调 `scripts/run-desktop.mjs`，**不需要终端、不需要 `cd`、不依赖 PATH 里的 node/npm**；失败会 `pause`，双击的窗口不会一闪就没 |
| **发布包里（普通使用者）** | 双击 `app\InteractBot.exe`。它自己找到包根 → 用 `node src/index.mjs --background` 把桥接拉起来 → 开出控制台窗口 |
| **源码侧（不必打包就能开窗口）** | 首次准备：`cd desktop && npm install --ignore-scripts`，再回包根 `npm run desktop:fetch`（取 Electron 运行时，约 **136 MB**，走 npmmirror 镜像；github 在本机连不通）。之后 `npm run desktop` 就开窗口 —— 它跑的是 `desktop/` 那份壳源码，数据落**源码侧包根**；改完壳**重启这条命令即可，不必重新打包** |
| **打 exe** | `npm run desktop:pack` → 产物在 `.build-desktop/pack-<时间戳>/win-unpacked/`，最近一次记在 `.build-desktop/latest.json`（发布组装读它，**不猜目录名**） |

★ 发布包里**只有** `start.bat` 一个 .bat，它是"**浏览器那条路**"；
它一旦发现 `app\InteractBot.exe` 存在就**不再打开浏览器**
（否则同一台机器上会出现两个控制台）。

★ 本版**没有 .bat 启动器**：0.2.4 曾用**中文名 .bat** 去设环境变量 `INTERACTBOT_PKG_ROOT`，
那一类中文名入口已被用户要求删除（见 `mocks/verify-legacy-assets.mjs`）。
所以「**没有启动器也能找到包根**」必须成立 —— 见下。

★ **第一次跑发布包**：包里的 `config.json` 是**空白模板**（不含开发机路径），所以包内桥接会如实报
`❌ 无法启动 DSH：没找到 DSH` —— DSH 是运行环境、**不随包分发**（见 `RELEASE.md` §7）。
请在 `config.json` 里填 `dsh.cliPath` / `dsh.searchPaths`，或设环境变量 `DSH_DESKTOP_APP`。
**窗口停在启动页超过 90 秒**时先看 `logs/bridge.log`，别猜（0.2.5 修掉的那个缺陷就是"桥接启动即死
却一行日志都不留"，原因见下面"包根"那节之后的说明）。

### 包根是怎么找的（`desktop/lib.cjs` 的 `resolvePkgRoot`，三级判据）

1. **环境变量 `INTERACTBOT_PKG_ROOT`** —— 若有人显式设了它（留给"我知道根在哪、我要明确告诉壳"的情形）；
2. 从 **`app.getAppPath()`**（打包后是 `app\resources\app`、开发时是 `desktop/`）
   **逐级向上找包根标记**：**同时**有 `config.example.json` 与 `src/index.mjs` 的那一层就是包根；
3. 找不到就返回链上**真实存在**的那一层，并**在日志里喊一声** —— **绝不猜**。

★★ **为什么写成"看证据"而不是"数目录层数"（真实事故，值得记住）**：
0.2.4 第一版依赖 `app.isPackaged`，而 `asar: false` 时它**是 `false`**
⇒ 打包分支根本没进，壳**静默**把 `app\` 当成了包根：
读不到使用者的 `config.json`（日志里 `ENOENT`）、把日志写进了 `app\logs\`。
修法就是上面这三级判据 —— 而判据由 `mocks/verify-desktop.mjs` **造出真实发布包布局**来断言（离线 **一百多项**）。
教训是：**只验「参数怎么用」、没验「真实布局长什么样」，等于没验。**

### 关窗口 = 收进托盘（机器人**继续在线**）

关窗口**不等于退出**：窗口收进右下角**托盘**，机器人**继续在线**。
真正退出要用**托盘菜单里的「退出并停止机器人」**（它会先 `POST /api/stop`）。
桌面壳自己的日志在 `logs/desktop.log`（与桥接的 `logs/bridge.log` **分开**）。

### 体积（代价就是 Electron 运行时）

`app/` 约 **324 MB**（其中 `InteractBot.exe` **200.5 MB**）；
发布包合计 **202 个文件 / 约 413 MB** —— 比不带桌面壳的 **88.6 MB** 大很多。
多出来的几乎全是 Electron 运行时；换来的是目标机器**不用装 Node**。

### 诚实边界（只有人在真机上点得出来的那部分）

窗口 / 托盘 / 菜单 / "关窗口不下线"这些**交互语义还没验完**。**已经实测到的**：从**发布包**里
双击 `app\InteractBot.exe` 起过两次真窗口（窗口标题「QQ 机器人控制台」、4 个 Electron 进程、
`logs/desktop.log` 第一行是正确的**发布包根**而不是 `app\`、端口来自 `config.json`），随后窗口已关闭；
**没验的**是托盘图标、关窗口是否真的收进托盘（机器人不下线）、以及「退出并停止机器人」。
已被机器验证的还有：壳的**判断逻辑**
（端口从哪来 / 什么算启动成功 / 状态怎么翻译 / 包根怎么找）、
**产物形状**（exe 在、asar 关着、PE 版本号 **0.2.5**、包里的壳代码与 `desktop/` 源码**逐字节一致**）
以及**发布包验收**。完整清单在 `PROJECT.json` 的 `verificationStatus.notVerified`。

**离线测试入口**：`npm run test:desktop`（= `node mocks/verify-desktop.mjs`，**一百多项**，不启动 Electron）。

---

## 依赖与前置条件（打发布包前必读）

本包**自带**：Node 运行时（`vendor/node`）、`ws`、桥接代码、控制台界面（`config-ui/dist`）。
★ 0.2.5 的**发布包**另外自带桌面壳 `app/`（含 Electron 运行时，见上文「桌面壳」）——
那是 `npm run desktop:fetch` 取来、`npm run desktop:pack` 打出来的，**不归 `setup.mjs` 管**。
以下四样**不在包里**，每一样都有明确理由：

| 需要 | 谁提供 | 为什么不在包里 |
|---|---|---|
| **QQ 桌面版（NTQQ）** | 用户 | 腾讯的软件，本来就得自己装；SnowLuma 靠注入它工作 |
| **DSH 本体** | 用户 | 约 274.7 MB / 15069 文件，属**运行环境**（像 Node）。用 `dsh.searchPaths` / 环境变量 `DSH_DESKTOP_APP` / 默认位置定位 |
| **SnowLuma** | 用户 | ★ **许可证不允许随第三方安装包分发**（EULA §5.4、LICENSE §5）。去 [官方 Releases](https://github.com/SnowLuma/SnowLuma/releases) 下载 `win-x64` 完整版 |
| **模型 API key** | 用户 | 账号级凭据。界面「高级」页填一次；已装 DSH 桌面版并填过的**不用重复填** |

### 模型 API key 从哪来（三个来源，同一把 key）

| 顺序 | 来源 | 适用 |
|---|---|---|
| ① | 环境变量 `DEEPSEEK_API_KEY` | 进阶用户 / CI |
| ② | `config.json` 的 `dsh.apiKey`（界面「高级」页填写） | ★ 普通用户 |
| ③ | `%APPDATA%\dsh-desktop\harness\.credentials.yaml`（DSH 桌面版「模型」页填的那份） | 已装桌面版的人 |

三处用的是**同一把账号级 key**，换 key 不需要重新申请 —— 改任意一处即可。
界面上未配置时显示"尚未配置"，已配置时显示"已配置（留空即不修改）"，并有一个「清除」按钮。

### 打发布包

见 **[RELEASE.md](RELEASE.md)**。最短路径：

```bash
cd config-ui && npm run build && cd ..   # 界面改过就必须重建
node setup.mjs --release                 # 备齐必需项 + 发布前体检（只报告，不改文件）
npm test                                 # 全量离线测试
```

---

## 设计决定（连同理由，改之前先读）

### 1. 权限：`workspace-write` + 管理员白名单

用户定的规则是「**极高权限只限工作区与指定管理员**」。落地方式是两条独立的防线：

| 防线 | 机制 | 位置 |
|---|---|---|
| **谁能触发** | 管理员 QQ 号白名单（`access.adminUsers`） | `src/bridge.mjs` 的 `#isAllowed()` |
| **能碰什么** | `DSH_PERMISSION_MODE=workspace-write` 沙箱 | 传给子进程的环境变量 |

`workspace-write` 这一档**自带 `ask` 审批策略**，而 sdk profile 里没有人能应答审批，
所以越界操作会落成 `unavailable` —— **自动被拒，且不会把对话卡死**。
这是实测过的行为，不是推断（见 `docs/implementation-plan.md` 的探针记录）。

**`setup.mjs` 里没有 `--with-dsh`**：DSH 本体约 275 MB / 15000 个文件，
复制进来会把包从 86 MB 撑到 360 MB。DSH 属于**运行环境**（像 Node 一样），
由 `src/local.mjs` 的 `findDshCli()` 按候选顺序定位，或用环境变量
`DSH_DESKTOP_APP` 指定。

### 2. 唤醒规则：被 @ / 私聊 / 关键词 → **必须回答**

用户明确要求：**不潜水**。所以没有"触发后选择沉默"这条路径。

这带来一个简化：不需要让模型自己决定说不说，也不需要桥接层二次判断。
代价是**命中关键词必然产生一次模型调用**，所以关键词表要克制 ——
`src/trigger.mjs` 的 `lintKeywords()` 会在启动时警告"单字关键词""群聊高频词"
这类会静默变成"全响应"的写法。

### 3. 第一版只开**管理员私聊**

群消息整条链路直接跳过（`trigger.groupEnabled` 默认 `false`）。
理由不是技术，是**账号安全**：群聊是行为风控最容易命中的场景。

### 4. 账号安全：节流是必需品，不是优化

`SendQueue` 的参数（间隔 1–3 秒随机、每分钟 8 条、8 秒内内容去重）
直接取自同类成熟项目的实测值。**秒回、连发、固定间隔是行为风控的教科书级特征。**

⚠️ 但必须说清楚：**这些措施不能保证账号不被处置。** 桥接不改变"个人 QQ 号 +
第三方协议端违反《QQ 用户协议》"这个事实。

### 5. 可搬迁性：所有路径相对包根

`src/local.mjs` 是唯一算路径的地方，规则是**从文件自己的位置往上推**，
绝不写死盘符、也绝不用 `process.cwd()`（双击启动时 cwd 常常不是包目录，
而且解析失败不报错，只是"什么都加载不到"）。

`config.json` 里的相对路径都相对**包根**，所以整个 `qq-bridge/` 目录可以整体拷走。

### 6. 依赖不走 npm，走 `vendor/`

运行期只需要 `ws`（纯 JS，无原生模块）。它被复制到 `vendor/node_modules/ws`，
由 `src/vendor.mjs` 用 `createRequire` 显式加载。好处是：包内有什么一眼可见，
不受 npm 缓存/软链/清理策略影响。

---

### 7. ★ 会话标识：一个实测发现的硬限制（改之前必读）

最初的设计让 sessionId **永久稳定**（同一个 QQ 会话永远映射同一个 id），目的是让上下文跨重启连续。
**第一次跑通了，第二次直接失败**：

```
RPC session/prompt 失败：session "qq-19e80e0ff1dd" already exists
```

**根因**（读 `dsh-sdk-jsonrpc-server/lib/index.js:203-231`）：

```js
async getOrCreateSession(sessionId) {
  const existing = this.sessions.get(sessionId);   // ← 只看内存 map
  if (existing) return existing;
  return this.createSession(sessionId);            // ← 内存没有就 create
}
async createSession(sessionId) {
  const rec = { handle: await this.ctx.agents.create({ sessionId: ... }) };
```

进程重启后内存 map 是空的，于是必然走 `agents.create`；而**磁盘上已存在同名持久化会话时它会抛
`already exists`**。同时 SDK 只暴露三个方法（`initialize` / `session/prompt` / `shutdown`），
**没有 `resume`** —— 没有任何干净的续接途径。

**所以最终设计是：**

| 时间范围 | 行为 |
|---|---|
| 同一个进程运行期间 | 上下文连续（这是能拿到的） |
| 进程重启后 | **自动换新 sessionId**（否则机器人完全不工作） |
| 默认换新时机 | **每次启动**（`session.instance` 留空 = 本进程启动时刻） |

**代价（已知且有意的取舍）**：重启后 DSH 侧不记得之前的对话。

> ⚠️ **这里踩过一次真实的坑，别重犯。**
> 最初的默认值是"**当天日期**"，理由是"一天内重启保持上下文连续"。
> 但**这个目标在 SDK 这条路上做不到** —— 因为 DSH 的会话持久化在磁盘上，
> 而"同一个 instance 复用同一个 sessionId"在重启后**必然撞名**：
>
> ```
> session "qq-579284c0cf47" already exists
> ```
>
> 表现是：当天**第一次**启动正常，**第二次**起每条消息都失败。
> 所以现在改成"每次启动唯一"（本进程启动时刻的毫秒时间戳）。
>
> **跨重启的记忆不靠这个** —— 它由工作区里的 `MEMORY.md` 负责
> （见 §5 记忆），重启后 agent 会自己读回来。

`session.instance` **一般保持留空**。填固定值会让每次重启复用同一会话号，
那只会在重启后报错（除非你确实想观察这个错误）。

---

## 目录

```
qq-bridge/
├── app/                   ★ 发布包里的桌面壳（`InteractBot.exe` 在这里；**含 Electron 运行时**，约 324 MB）
├── desktop/               ★ 桌面壳源码（Electron：main.cjs 窗口/托盘/启停桥接、lib.cjs 纯逻辑、splash.html 启动页）
│                          `npm run desktop` 跑的就是它；`npm run desktop:pack` 从它打出 `app/`
├── start.bat              "浏览器那条路"（★ 0.2.5 起**不再是唯一入口**；发现 app\InteractBot.exe 就不再打开浏览器）
├── setup.mjs              一次性准备（幂等）
├── config.json            全部配置
├── prices.json            ★ 价目表 + 峰谷时段规则（改它不需要重启）
├── assets/icon.ico        入口图标（蓝色小鲸鱼，7 个尺寸帧）
├── src/
│   ├── index.mjs          装配与启动顺序（含 --snowluma / --open-console 开关）
│   ├── local.mjs          ★ 路径解析（可搬迁性全靠它）+ SnowLuma 就近发现
│   ├── vendor.mjs         从 vendor 加载依赖
│   ├── bridge.mjs         ★ 核心：消息 → 回答
│   ├── sdk-rpc.mjs        JSONL JSON-RPC 客户端
│   ├── session-bridge.mjs 回合收集器（含逐步累加 token 用量）+ 会话路由
│   ├── session-id.mjs     QQ 会话键 → sessionId（哈希，不泄露 QQ 号）
│   ├── onebot.mjs         OneBot v11 客户端 + 发送队列
│   ├── trigger.mjs        唤醒判定 + 关键词体检
│   ├── text.mjs           消息段渲染 / Markdown 降级 / 分片
│   ├── prices.mjs         ★ 峰谷判定 + 成本估算（DSH 不给价格，只能自己维护）
│   ├── usage.mjs          ★ 用量记账（追加写 JSONL）+ 按天/按会话聚合
│   ├── memory-files.mjs   ★ 记忆文件读写（越界检查 + sha256 冲突检测）
│   ├── snowluma.mjs       ★ 探测/拉起 SnowLuma + token 解析（以它的配置为准）
│   ├── mcp-profile.mjs    把 QQ 工具挂进 DSH 的 sdk profile
│   ├── humanize.mjs       拟人延迟 / 静默时段 / 分条
│   ├── persona.mjs        人设提示词
│   ├── speed.mjs          回应速度三档
│   ├── memory.mjs         记忆约定（提示词那一段）
│   ├── doctor.mjs         体检
│   └── api.mjs            本地配置 HTTP 接口
├── mcp/mcp-qq-server.mjs  ★ QQ 工具服务器（戳一戳等，手写 MCP）
├── config-ui/             ★ 控制台界面（React/Vite，构建产物 dist/ 由桥接伺服）
├── scripts/               ★ 构建脚本：assemble-desktop.mjs 打 exe / fetch-electron.mjs 取运行时 / assemble-release.mjs 组装发布包
├── mocks/                 测试替身（不需要 QQ，不花钱）
├── vendor/                包内自带：node/ + node_modules/ws
├── logs/                  运行日志 + usage.jsonl
└── workspace-qq/          ★ agent 的工作区＝权限沙箱的根
```

> **搬走这个包之后，快捷方式的图标会退化成白纸** —— `.lnk` 里存的是**绝对路径**。
> 重建一下即可（或手动改图标指向新的 `assets/icon.ico`）。

---

## SnowLuma 的两个坑

已从 `snowluma/config/onebot_<QQ>.json` 实际读出：

1. **HTTP 与 WebSocket 用两个不同的 accessToken**（`httpServers[].accessToken`
   与 `wsServers[].accessToken`）。这与 NapCat 常见做法不同，填错的表现是
   "连上了但一直 401"。
2. **消息格式是 `array`**（消息段数组），解析以数组为主路径，CQ 字符串仅兜底。

默认端口：`3000` = HTTP（发消息）、`3001` = WebSocket（收事件）。

### token 现在以**它自己的配置**为准（这一条救过命）

`onebot.wsToken` / `onebot.httpToken` **优先从上面那个 `onebot_<QQ>.json` 里读**，
`config.json` 里那份只作回退。`GET /api/snowluma/detect` 会返回
`tokenSource` 与 `tokenDiffersFromConfig` 供排查。

为什么改：踩过两次真实故障，症状都是**「令牌被拒」+ 机器人完全不说话**。第二次尤其阴：

> 脚本把 token 改对了 → 之后**通过网页保存了一次配置** → 那次保存把**旧 token
> 当作非空值**提交 → 被合法写回旧值 → **修复被静默推翻**。

病根是 **token 存在两处就必然漂移**，而那份数据本来就是 SnowLuma 的
（它启动时按它校验）。所以让它当唯一真源。

> ⚠️ **`config.json` 里仍是 accessToken 明文。** 这个包按设计可以整体搬走，
> 所以**分享前先把这两个 token 在 SnowLuma 里作废重发**。

## 已验证 / 未验证（如实标注）

**已验证（离线 608 项 + 真实 QQ 端到端，离线部分不需要 QQ 也不花钱）：**
唤醒判定矩阵（**群聊只认 @ 与关键词**，其余一律零成本不回）、CQ 码注入防护、
未知段类型不展开内容、Markdown 降级、长文本按自然边界分片、
管理员白名单 fail-closed（群聊关闭时**即使被 @ 也不回**）、会话隔离、多轮上下文连续、
**记忆按人/按群分开**（不同的人拿到不同路径，群聊拿不到全局记忆）、
内容去重、每分钟限频、未知会话事件丢弃、回合超时兜底、
DSH 子进程死亡时优雅降级、体检工具的准确性（含防误报）、
真实 `dsh --profile sdk` 可被启动且不污染工作区、
**真实模型经桥接读到了工作区文件、并如实报告越界被沙箱拒绝**、
**真实 QQ 端到端**（管理员私聊 → 桥接 → DSH → 模型 → QQ 回复，全程无人工干预）、
**模型在明确指令下调用了 QQ 原生工具**（戳一戳等，见 `mcp/mcp-qq-server.mjs`）、
**用量记账**（真实回合的 token 与成本已落盘 `logs/usage.jsonl`）、
**桌面壳（0.2.5）的判断逻辑与产物形状**（包根三级判据**照真实发布包布局**断言、
端口从哪来 / 什么算启动成功 / 状态怎么翻译、exe 在 / asar 关着 / PE 版本号 0.2.5 /
包里的壳代码与 `desktop/` 源码逐字节一致，`mocks/verify-desktop.mjs` 一百多项）。

**未验证：**
跨重启的长期记忆（P4，目前重启即失忆，靠工作区的 `MEMORY.md` 兜底）、
**群聊的真实端到端**（判定与投递已在全链路测试里验证过，
但还没有在真实群里跑过一轮）、
**桌面壳的窗口 / 托盘 / 菜单 / "关窗口不下线"**（0.2.5：这些**只能人在真机上点一遍** ——
受限沙箱里 Electron 起不来；机器只验证了壳的判断逻辑与产物形状，
完整清单在 `PROJECT.json` 的 `verificationStatus.notVerified`）。

---

## 排障

| 现象 | 原因 |
|---|---|
| `HTTP 426 Upgrade Required` | `httpUrl` 填成了 WebSocket 端口 |
| 连上但从不回复 | 检查 DSH 子进程是否退出；桥接日志在 `logs/bridge.log` |
| 谁发都不回 | `access.adminUsers` 为空（这是 fail-closed，`--check` 会警告） |
| `缺少依赖「ws」` | 没跑 `node setup.mjs` |
| 机器人失忆 | 正常现象（见上文 §7）：重启后上下文会重置；`session.instance` 新的一天会自动换新 |
| 报 `session "..." already exists` | `session.instance` 机制失效了。把 `config.json` 的 `session.instance` 改成任意新值后重启 |
| 双击 `app\InteractBot.exe` 后窗口一直停在启动页 | 桌面壳自己的日志在 `logs/desktop.log`（与桥接的 `logs/bridge.log` **分开**）；启动页上也有「看日志」。0.2.5 起壳会**读桥接日志**：桥接若已写明失败原因，窗口与日志里会直接给出那一行（实测 1 秒就定，不再干等 90 秒） |
| `npm run desktop` 报 `Electron failed to install correctly…` | 跳过官方 postinstall 后**缺 `desktop/node_modules/electron/path.txt`**（它决定二进制叫什么名字），而运行时其实好好的 ⇒ `npm run desktop:fetch`（**幂等**：只补这个文件，不会重新下载 200 MB） |
| `npm run desktop` 报 `TypeError: Cannot read properties of undefined (reading 'getAppPath')` | 环境里有 **`ELECTRON_RUN_AS_NODE=1`**（DSH 的 `node` 垫片 `.desktop-bin\node.cmd` 会设它）⇒ electron 被"当 Node 用"，`require('electron')` 返回的是包路径字符串、没有 `app`。⇒ `npm run desktop` 现在由 `scripts/run-desktop.mjs` 启动并**摘掉**这个变量（不再走 `cli.js`）；双击 exe 不受影响 |
| 关了窗口但机器人还在回话 | **这是设计如此**：关窗口 = 收进**托盘**，机器人继续在线；真要停它用**托盘菜单的「退出并停止机器人」** |
| 留下 `.tmp-*` 目录 | Windows 句柄回收时机问题，无害。执行 `node mocks/verify-live.mjs --clean`，或下次运行会自动清掉 |
