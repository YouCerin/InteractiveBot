# qq-bridge — QQ ↔ DSH 桥接

把 QQ 里的消息转给一个**有完整能力的 DSH agent**，再把它的回答发回 QQ。

> **📖 先读哪一份？**
> - **你想先知道"这项目是什么、各模块怎么实现的、agent 到底有多大权限"** →
>   读 **`docs/项目简介.md`**（一页：数据流 / 模块表 / 12 条特色 / 权限硬墙与软墙 / 文档地图）
> - **你只是想把它跑起来、不想看代码** → 读 **[首次使用.txt](首次使用.txt)**
>   （四个依赖的下载地址 / 三步配置 / 常见故障对照 / 账号风险提示），
>   然后双击 `start.bat`；只想自检就开命令行跑 `start.bat --check` 与 `start.bat --doctor`
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
> `llm.stream` 调用，没有工具循环、没有沙箱、没有权限概念）。本目录是**新架构**，
> 旧目录保留仅作参考。

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
# ⓪ 从**源码**跑（不是用发布包）时先装依赖：
#    vendor/ 不进 git（只有发布包里才有），setup.mjs 会从 node_modules/ 里把 ws 复制进去。
#    网络不便时 `npm install ws --no-save` 也够（undici 只有走代理的技能才需要）。
npm install

# ① 一次性准备：把 Node 运行时和纯 JS 依赖收进包内（幂等，可重复跑）
node setup.mjs

# ② 配置自检（不连接任何服务）
node src/index.mjs --check

# ③ 填 config.json 里的 access.adminUsers（你自己的 QQ 号，必填！）

# ④ 跑测试（不需要 QQ、不花模型费用）
npm test                         # 全部离线套件（实测：所有套件退出码 0）

# 想单独跑某几套（下面括号里是**离线环境**下的断言条数；条目声明见 PROJECT.json）
#
# ⚠️⚠️ 括号里的数字**不是同一时刻量的**，而且不少已经漂了。0.3.0alpha 收尾时用
#   「逐个套件实跑、读它自己的收尾行」的方式复核过一部分（写明了量到的值）：
#     · 已核过并改准：verify-manifest 37、verify-release-hygiene **72**、
#       verify-imports 9、verify-persona 106、verify-personas 103、verify-chat-review 277、
#       verify-doctor **48**、verify-ui-status 29、
#       verify-token-sync **43**、verify-snowluma-console **29**、verify-dsh-locate **39**
#       （0.3.1 打包前量的；后三个是实机报告那一轮新增的套件，它们**不打印自己的总数** ——
#        上面的数是数 `✅` 行得到的。`verify-dsh-locate` 的 39 含 4 条"本机有真实 asar 才跑"的断言，
#        没有 Electron 应用的机器上是 35）
#       （0.3.0alpha 第二步：`verify-voice-style.mjs` **已删除** —— 说话方式从"代码常量 +
#        每轮替换人设两节"改成"**就写在人设文件里**"，那个套件有一半在测已删的机制；
#        里面仍然有意义的内容断言已归位到 `verify-persona.mjs`）
#     · 实测**对不上、但本次没改**（超出版本范围，留着是**已知漂移**）：
#       verify-persona 实测 60、verify-corpus 58、verify-extract 85、
#       verify-memory-consolidate 77、verify-privacy 67、verify-oplog 49、
#       verify-tasks 125、verify-recipes 67、verify-memory-roundtrip 191、
#       verify-mcp-tools 75、verify-delivery-ledger 34、verify-token-discovery 53、
#       verify-delivery-gate 47、verify-memory-keyword 35、verify-transport 41、
#       verify-session-state 48、verify-memory-supersede 50、verify-memory-stats 29、
#       verify-memory-usage 54、verify-api-h13 29、verify-marker 46、verify-text-encoding 21
#     · 复核方式（可复现）：在 `packages/qq-bridge` 下逐个 `node mocks/verify-*.mjs`，
#       读它的收尾行（「…全部通过（N 项）」）。链上共 **72 套**（0.3.1 打包前实测；
#       `mocks/` 下共 73 个 `verify-*.mjs`，不在链上的是花钱的 `verify-live.mjs`）。
#   ∴ **不要**把这些数字当权威 —— 权威是 `node mocks/verify-*.mjs` 自己的输出。
node mocks/verify-manifest.mjs   # 包契约自检：文档与代码是否一致（37 项）
node mocks/verify-imports.mjs    # ★★ 导入与登记漂移审计：坏了才炸的导入、孤儿模块、漏登记的套件（9 项）
node mocks/verify-release-hygiene.mjs # ★★ 发布卫生：用户数据不许进包、大小写绕不过、批处理括号、**包内路径引用**、接线断言（72 项）
node mocks/verify-api.mjs        # 配置接口：脱敏、空值语义、回环限制（89 项）
node mocks/verify-api-h13.mjs    # ★★ H13 四个接口（真起 HTTP 服务）：漏 await、token 泄露、跨会话检索、**畸形返回不拖垮进程**（29 项）
node mocks/verify-config.mjs     # 配置解析与校验（42 项）
node mocks/verify-units.mjs      # 纯逻辑：文本/唤醒/会话/防自环/人味层/人设/记忆
node mocks/verify-persona.mjs    # ★★ 人设加固：反注入拦得住、正常人设不许误伤、名字表真的能唤醒、**说话方式逐字在人设文件里**、**人设文件与 `FACTORY_PERSONA` 常量逐字一致**（106 项）
node mocks/verify-images.mjs     # 看图：SSRF 防护 + 防 DoS（145 项）
node mocks/verify-identity.mjs   # ★ 身份核实：谁在说话、会话名、"身份不得变成权限"、权限判据自解释（57 项）
node mocks/verify-memory-store.mjs # 记忆存储层：分档、内容过滤、篡改回滚、**注入面规则**、**条目身份前缀**（自报全部通过、不报项数）
node mocks/verify-memory-roundtrip.mjs # ★★★ 走完整桥接：记忆全链路 + **注入接线** + **段顺序快照 / 逐字基线**（0.3.0alpha 实测 191 项）
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
node mocks/verify-schedule.mjs    # ★★★ 定时任务（0.3.2）：**「恰好一次」**的三条变异断言 + 21 项走完整桥接的接线断言（183 项）
node mocks/verify-recipes.mjs     # ★★ 配方库：长尾匹配要命中、置信度用平滑、requiredActions 不自动执行（67 项）
node mocks/verify-extract.mjs     # ★★ 抽取解析：真实 headless 输出（裸词 / 多两个 `}`）都要能解析（71 项）
node mocks/verify-mcp.mjs        # QQ 工具服务器（工具清单、黑名单拦截、参数校验、错误不外泄）
node mocks/verify-rpc.mjs        # 协议层：与模拟 DSH 的 JSON-RPC（★ 需要能起子进程）
node mocks/verify-onebot.mjs     # 全链路：QQ 事件 → 回复发出（★ 需要能起子进程）
node mocks/verify-real-dsh.mjs   # 真实 dsh 能否被启动（零费用；★ 需要能起子进程）
node mocks/verify-doctor.mjs     # 体检工具自身的准确性：只统计真桥接、⚠️ 与 ❌ 分得清（48 项）
node mocks/verify-token-sync.mjs # ★★ SnowLuma token 真的接到客户端上、并按纪律写回 config.json（43 项）
node mocks/verify-snowluma-console.mjs # ★★ SnowLuma 控制台输出落盘 + 首次登录凭据在哪（29 项，含真 spawn）
node mocks/verify-dsh-locate.mjs # ★★ DSH 定位（两种目录名 × 三种形态）与 app.asar 抽取（39 项）
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
#   docs/0.3.0alpha-release-notes.md   ← 最新（说话方式只剩一份：拆掉「闲聊/工作」双态）+ 升级须知
#   docs/0.3.0beta-release-notes.md    ← 上一版的对应文档（双态 + 聊天记录评审台）
#   docs/0.2.3-release-notes.md        ← 插件化：二选一 / 唤醒策略 / QQ 工具档位 / 投递 / 语料库
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

# ⑤-b6b 定时任务（0.3.2，只读）：**到点了主动说一句**
#   ★ 在此之前桥接是**纯镜像** —— 只回答刚收到的那条消息，所以
#     「8 点叫我一声」「提醒某某人吃饭」这类**无人开口**的需求一处都落不下去。
#   ★★ 每条提醒**只会发一次**（说两遍比漏一遍更糟）：触发点是**算出来的**，
#      再加上落盘台账在**调模型之前**认领。
#   ★ **错过不补发，但一定留证据**：迟到 ≤2 分钟照常发（并如实说"晚了"），
#      超过就记进错过台账，下次对话里提一句。
#   ★ 默认**关闭**（`schedule.enabled`）—— 它是唯一一个不用谁开口就往外发消息的能力。
#   ★ 任务的建/改：控制台「任务」页签（0.3.2 P5 已加入），或直接写
#      workspace-qq/runtime/schedule/<任务id>.json。
node src/index.mjs --schedule                 # 任务 + 下次触发 + 错过台账 + 已知会话名单
node src/index.mjs --schedule --fires         # 触发台账整份（含"可能已发出"的残局）
node src/index.mjs --schedule --history       # 最近**实际发出去的原文**（模型现写 ⇒ 唯一能核对的）

# ⑤-b6c 服务器监测（0.3.2 P2，只读）
#   ★ 目前实现的是 **RCON 那一半**：问状态（连通/人数/TPS）+ 发话。
#     它**不认识任何具体服务端**（没有版本判断）⇒ 原版/Paper/Forge/Fabric/NeoForge 通用。
#   ★★ RCON 是**自己实现**的（纯 node:net）—— 运行期依赖不走 npm（项目第 5 条纪律）。
#   ★ 默认空配置 ⇒ 这一层完全不工作，而且**一次网络请求都不发**。
#   ★ 判据：**默认只把「连不上」算 down**（连续失败 2 次才判，防抖动误报）；
#     rules 里的 TPS/人数阈值只产出**异常报告**，**不会重启**。
node src/index.mjs --servers                  # 配置 + 监测状态（**不发任何网络请求**）
node src/index.mjs --servers --probe          # 真连一次并跑只读命令 list
node mocks/verify-servers.mjs                 # ★★ 协议与状态机（255 项，含真 TCP 假服务端）

# ⑤-b6d 从 QQ 下服务器指令（0.3.2 收尾，**默认关**）
#   ★★★ 打开方式：在那台服务器的条目里写 "commandFromQQ": true。
#     打开之后**管理员**拥有这台服务器的**完整控制台（RCON = op 级别）**：
#       · 管理员在群里发 `/mc [服务器id] <命令>` ⇒ 桥接**本地拦截执行**（不经模型）
#       · 模型也可调 `mc_command` 工具（读本轮的 MC 域授权文件，**非管理员一律拒绝**）
#   ★★ 两条已知代价（拍板时已明确告知）：
#      ① `op` 可提权 ⇒ 命令白名单**事实上失效**（能 op 一个玩家，白名单就没意义了）
#      ② **管理员 QQ 被盗 = 服务器 op 被劫持**（本机网页那个控制台没这个问题）
#   ★ 判定依据是桥接写的一份**明文授权文件**，模型能伪造 ⇒ 挡得住外部陌生人，
#     **挡不住模型主动伪造**（要堵它得让宿主把会话身份透传到 MCP 层，本次没做）。
#   ★ 想更保守就别开它，只用本机网页的「服务器」页签里的控制台。

# ⑤-b6e 游戏内对话（0.3.2 P3，**默认关**）
#   ★★★ 打开方式：在那台服务器的条目里写 "gameChat": true。
#     打开之后桥接每 2 秒读一次**这台服的控制台日志**（P2 把它的 stdout 重定向到了
#     runtime/servers/<id>.console.log），把里面的玩家聊天当输入：
#       · 已绑定 UUID↔QQ 的玩家在游戏里说的话 ⇒ 走唤醒判定（与 QQ 侧共用关键词表）
#         ⇒ 模型 ⇒ 回复发到**公屏 `say`**（全服可见）
#       · 未绑定的玩家说话 ⇒ **不进模型**（零成本），只给他本人一条 `tellraw`，
#         告诉他去群里发 /绑定（**每次进服最多一次**）
#   ★ 绑定流程（2026-10-04 定的口径；码**在游戏里生成**、与那个 UUID 挂在一起）：
#       玩家进服（未绑定）          → 只给他本人一条 tellraw：怎么拿码
#       玩家在**游戏里**说 \mc bind → 生成一张 6 位码 → 只给他本人 tellraw：码 + 下一步
#       玩家在**群里**发 @我 \mc bind <码>
#                                  → 桥接本地拦截（一次模型调用都没有）→ **当场绑定**
#                                  → 群里回一句 + **在游戏里给那个玩家一条成功通知**
#     ⚠️ 游戏内那句是 `\mc bind`（**反斜杠**）—— 这是**实测**出来的：以 `/` 开头的输入会被
#        Minecraft 当成"命令"，而我们的服务端上没注册过叫 mc 的命令 ⇒ 服务端只回玩家一句
#        "Unknown command"，**而那一句不写进控制台日志** ⇒ 我们看不到。`\` 在游戏里只是
#        普通字符 ⇒ 那句话以**聊天**发出 ⇒ 进日志 ⇒ 读得到。
#        （想要真·斜杠命令 / 推送式事件 / 第二因子，需要单独的服务端插件或模组 —— **尚未构建**。）
#     ★ 斜杠那几个形状（`/mc bind`、`//mc bind`、`mc bind`）代码里**都还认**，是零代价的兜底；
#        但对外只说 `\mc bind` —— 一次只教一个形状。
#     ★ 绑定成功通知**在提交那一刻**就发回游戏里：抢绑藏不住（受害者当场会看见）。
#   ★ 三条必须知道的边界：
#       ① 只有**本程序拉起**的服务端才有那个控制台日志（别人手动起的服读不到东西，
#          日志里会有一行说明，**这不是故障**）
#       ② 权限**按绑定的那个 QQ** 判（与 QQ 侧 fail-closed 一致）
#       ③ 回复是**公屏** ⇒ 全服可见，所以进游戏的内容共享同一道隐私闸
#   ★ 管理员解绑：`\mc unbind <游戏名或QQ号>`
node src/index.mjs --servers                  # 顺带列出绑定表、还没用的码张数、游戏内对话开关
node mocks/verify-bindings.mjs                # ★★ 绑定/码/tellraw 注入（122 项，不连网）
node mocks/verify-game-wiring.mjs             # ★★★ 走完整桥接的接线（91 项：命中即零模型调用）

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
node src/index.mjs --ui               # fresh=0；packaged=0（发布包形态：包里没源码，本机无法核对）；stale/unstamped=1
node src/index.mjs --ui --dist <某个包的 config-ui/dist>   # 查别人给的那份

# ⑤-d DSH 装在 asar 里时抽出来（只读 asar，写到本包 vendor/dsh）
#   ★ 新版 DSH 桌面版把 CLI 打包进 resources\app.asar，而普通 node 读不了归档 ——
#   症状是"装好了却说找不到 DSH"。抽完不用再配任何东西（vendor/dsh 是第 1 优先级候选）。
node src/index.mjs --extract-dsh                                  # 自动寻找 app.asar
node src/index.mjs --extract-dsh --asar "<路径>\resources\app.asar"
node src/index.mjs --extract-dsh --target <别的目录> [--force]     # 默认抽到 vendor/dsh

# ⑥ 启动
start.bat                        # 双击；或 node src/index.mjs
# 也可以双击带图标的快捷方式：InteractiveBot.lnk（自己生成，见 首次使用.txt ②）
#   （.bat 本身在 Windows 里不能带自定义图标，所以带图标的入口是快捷方式）
# start.bat 现在会先拉起 SnowLuma，再起桥接。跳过 SnowLuma：start.bat --no-snowluma
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

## 依赖与前置条件（打发布包前必读）

本包**自带**：Node 运行时（`vendor/node`）、`ws`、桥接代码、控制台界面（`config-ui/dist`）。
以下四样**不在包里**，每一样都有明确理由：

| 需要 | 谁提供 | 为什么不在包里 |
|---|---|---|
| **QQ 桌面版（NTQQ）** | 用户 | 腾讯的软件，本来就得自己装；SnowLuma 靠注入它工作 |
| **DSH 本体** | 用户 | 约 274.7 MB / 15069 文件，属**运行环境**（像 Node）。用 `dsh.searchPaths` / 环境变量 `DSH_DESKTOP_APP` / 默认位置定位。★ 新版桌面版把 CLI 打包在 `resources\app.asar` 里（普通 node 读不了归档），那种情况跑一次 `node src/index.mjs --extract-dsh` 抽到 `vendor/dsh` 即可（见下方"DSH 找不到怎么办"） |
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

#### DSH 找不到怎么办（装好了却报"没找到"）

两种原因必须分开说 —— 它们的出路完全不同（2026-10-03 实机测试报告 BUG-5）：

| 你看到的 | 真实原因 | 怎么办 |
|---|---|---|
| `--check` 列出候选位置，全都不存在 | 目录名或形态没覆盖：装出来可能是 `DeepSeek Harness`（**带空格**）；也可能 CLI 在 `resources\app` 下 | 现在候选表两种目录名 × 三种形态都覆盖，先重跑 `node src/index.mjs --check` |
| 提示里出现 `resources\app.asar` 与"普通 node 读不了" | 新版桌面版把 CLI 打包在 **asar 归档**里 | `node src/index.mjs --extract-dsh`（自动找到并抽到 `vendor/dsh`，抽完不用再配）。指定路径/目录：`--asar <app.asar>` / `--target <目录>`；覆盖已有目录要 `--force` |

抽取器与格式踩点写在 `src/dsh-extract.mjs`（含 `unpacked` 原生模块从
`app.asar.unpacked` 合并、前缀自动剥离、路径逃逸拒绝），回归在
`mocks/verify-dsh-locate.mjs`（用真实归档验过解析器）。

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

### 8. ★ 两个**独立小工具**（刻意不做进控制台）

`sticker-label/`（表情包人工标注台）与 `chat-review/`（聊天记录评审台）都是
**自己的文件夹 + 自己的进程 + 零依赖 + 只监听 127.0.0.1**，各自带一份无构建的页面。

为什么不塞进控制台（`config-ui/`）：这两个都是**一次性、用完就关**的活 ——
一个要全屏刷图贴标签，一个要连续过几百条聊天记录。而控制台是"看机器人整体状态"的
地方，混在一起两边都别扭：控制台要迁就大图与长文本，工具要迁就后台的布局与加载逻辑。

代价与纪律（两者相同）：

- 各自的启动入口是一个 `.bat`（**纯 ASCII**：cmd 用系统代码页解析它，
  UTF-8 中文会吞掉换行、把解析搞乱）+ 一个薄薄的 `server.mjs`；
- 真正的实现在 `src/sticker-label-server.mjs` / `src/chat-review-server.mjs`
  （放 `src/` 是为了**测试能直接起一个**，且被 manifest 守卫登记）；
- **发布清单 `COPY_DIRS` 里必须各自有一行** —— 漏了它的后果是"用户拿到包以后
  点开没有页面"，而且**不会报错**。两处都有断言盯着。

| 工具 | 用途 | 端口 | 文档 |
|---|---|---|---|
| `sticker-label/` | 给表情包贴语义标签 | 4399 | `sticker-label/README.md` |
| `chat-review/` | 导入聊天记录 → 人工打分 + 写评论 → 整理成对 **`personas/` 里当前那份人设的说话方式**的**修改意见**（0.3.0alpha 第二步起评审目标是人设文件本身） | 4410 | `chat-review/README.md` |

---

### 9. ★ 说话方式只有**一份**，而且**就写在人设文件里**（0.3.0alpha）：改口吻改 `personas/小鲸鱼（完整带情绪）.md`，**改了要重启**

0.3.0beta 试过按**每条消息**判「闲聊 / 工作」两态：闲聊时换成 `styles/闲聊.md` 的口吻，
干活时维持老说法（"工作态 = 升级前的行为"是那一版的安全边界）。
0.3.0alpha 把那条分界线**拆掉**了 —— 说话方式**只有一份**，**所有回合都用它**，闲聊如此，干活也如此。

**为什么融合而不是留着两态**：分两态等于同一份提示词里两处对同一件事给**相反**指令 ——
基座的「但对方认真问事实、技术问题时，就认真答」对上「**极短**、别把一句回答扩成一段」，
模型只能自己挑一套听，两个方向都不稳定；而且判定本身要花一次模型调用、还会判错。
融合后的口径是「**默认极短 + 真在干活时允许说清**」，**不是**把那两句都留下 ——
留下一对相反指令正是这次要消灭的东西本身。

> **★ 这一版走了两步，第一步被第二步推翻（如实记下）**：
> 第一步把说话方式做成了**源码里的常量** `src/voice.mjs` 的 `VOICE_STYLE`，
> 每轮去**替换**人设里的【怎么说话】【别变成客服】两节（还配了 `composeVoice()` 与
> 写回用的 `src/voice-source.mjs`）。使用者最初要的其实是「**把内容真正搬进人设文件**」，
> 他问起之后按他的口径改了回来 —— **现在 `src/voice.mjs` / `src/voice-source.mjs` 都已删除**，
> 提示词**直接用整份人设**（`src/bridge.mjs` 的 `#buildPrompt` 不再拼任何东西）。

**使用者要知道的三件事**：

1. **要改口吻就改 `personas/小鲸鱼（完整带情绪）.md`**（说话方式那一节就在里面）。
   原来那份 `styles/闲聊.md` **连目录一起下线了**，不再有任何代码读它。
2. ★ **改完要重启**才生效。0.3.0beta 的风格文件是每轮现读；现在它跟整个人设一样，
   在**构造期**读一次（人设是构造期缓存的）。
3. 如果你以前改过 `styles/闲聊.md`，**那份改动升级后不再生效**（要改就改人设文件里那一节）。
   > 顺带说明为什么它以前"看起来"生效过：`styles/` 目录**从来没有进过发布包**
   > （`scripts/assemble-release.mjs` 的 `COPY_DIRS` 里没有它），线上一直跑的就是内置常量，
   > 那份文件只是开发期的一份镜像。

**这一版保留不变的东西**（别读成"顺手改了"）：

- **人设库仍然是多文件**的（能新建 / 复制 / 改名 / 删除，用来做变体对比），
  `persona.active` 的三条回落规则没变，"读不到不许静默退回内置"没变；
  ★ 但**出厂人设在本版收敛成唯一一份**（`personas/小鲸鱼（完整带情绪）.md`，见本节末尾那段）；
- 长任务超过 8 秒的「先应一声」**保留并默认开启**（只去掉了"闲聊态不发"那条抑制，
  因为它依赖已删除的分类器；**静默时段仍然不发**）；
- 分条发送（`humanize` 的 `splitReplyForSend`）**没动**；
- 唤醒判定器（`src/wake-judge.mjs`）**完全不受影响** —— 删掉的只是同一个文件里那个
  「这一轮是闲聊还是干活」的判定器；
- 聊天记录评审台（`chat-review/`）**仍在**，只是评审目标换成了**当前那份人设文件**
  （`chat-review/` 的启动选项是 `personaPath`，`/api/health` 的 `styleFile.path` 指向那个 `.md`）。

> ★ `#notePersonaShape()` 只**记一行日志**（前缀 `[persona]`）：这份人设里有没有可识别的
> 「说话方式」那一节。**不拦、也不回落内置** —— 自己写的散文人设没有那一节只是配置事实。
> 完整清单、取证方式与已知边界见 `docs/0.3.0alpha-release-notes.md`。

### 出厂人设只剩一份（本版第二件事）

`personas/小鲸鱼（完整带情绪）.md` 是**唯一默认人设**，以后要改口吻/性格**只改这一个文件**
（运行期读的就是它；人设是构造期缓存的，**改了要重启**）。它现在是 **4742 字 / 126 行**
（说话方式整节也搬进来了）。

- 另外两份（`小鲸鱼（精简）`、`软糯小鲸鱼（情绪）`）**已删除** —— "想短一点"这个诉求
  现在由**说话方式那一节**承担（就在这个人设文件里），不必再换一套人设；
- ★ **旧人设预设 id 仍然认得**（`mermaid` / `mermaid-lite` / `mermaid-soft`），
  但取值**全是这一份** —— 老配置里写着 `persona.preset: "mermaid-lite"` 的人
  不会在升级后报"预设不存在"，也不会拿到一段空白；
- 人设库本身**仍然是多文件**的：能新建 / 复制 / 改名 / 删除（用来做变体对比）。
  界面上那个按钮现在叫「**恢复默认人设**」（原来叫"恢复默认两套"）；
- 代码里那份常量（`src/persona.mjs` 的 `FACTORY_PERSONA`）只用于**首次播种**与「恢复默认」，
  与文件有断言盯着**逐字一致**（`verify-persona.mjs` 真的**读文件**来比）——
  **改了 `personas/*.md` 必须同步那个常量**，否则这条断言会红；
- ★ **字数上限 `PERSONA_MAX_CHARS` 从 4000 抬到 8000**：说话方式搬进来之后出厂那份自己就有
  4742 字，旧上限会让"以出厂那份为基础新建 / 保存"被自己的上限拒掉、界面字数计数器一直显示超标 ——
  **旧上限与出厂人设自相矛盾**。界面不用改代码（它照后端给的 `maxChars` 显示）。

### 10. ★ 记忆条目现在自带**身份前缀** `（昵称 QQ 号码）`（0.3.0alpha 第四步）

用户要求「**记录记忆时，加上所记的人的 ID**」。两个口径都当面问过，他选的是
**所有条目都加**（含个人档）+ 写法 **`（昵称 QQ 号码）`**、**查不到昵称就只写号码** `（QQ 号码）`。

```
- （忘忧 QQ 100000001）他喜欢钓鱼            # 群档 memory/groups/<群号>.md
- （忘忧 QQ 100000001）他希望我别走          # 个人档 memory/people/<QQ>.md
- （忘忧 QQ 100000001）（全局）这家店周三休息  # 全局 MEMORY.md
```

- **三层都带**，黑话档同理；身份前缀在**前**、分类前缀（`（全局）`/`（黑话）`）在**后** ——
  一个说"谁说的"，一个说"算哪一类"；
- **个人档明知文件名已有号码也照加**：要的是**条目自身可查**（从一行里读得出是谁说的），不是漏改；
- **提示词里也明说了一句**「系统会自动加这个前缀 —— **你别自己写号码**」：模型拿不到号码，
  自己乱写会写进假号码、还会与系统那份叠成两层前缀（这一行让提示词逐字基线 8693 → **8751 字**）；
- **去重与更正比较时剥掉前缀**（老条目没前缀也不会被重复记一遍），
  但**写进文件、登记进使用账本的都是带前缀那一行**；
- 完整说明（为什么这么写、昵称从哪来、那条"剥前缀不改变行为"的实测边界）见
  `AGENT.md`「记忆分三层」与 `docs/0.3.0alpha-release-notes.md` §4.7。

---

## 目录

```
qq-bridge/
├── 启动机器人.lnk          ★ 带图标的启动入口（指向 start.bat）
├── start.bat              入口（双击启动，优先用包内 Node；会先拉起 SnowLuma）
├── setup.mjs              一次性准备（幂等）
├── config.json            全部配置
├── prices.json            ★ 价目表 + 峰谷时段规则（改它不需要重启）
├── assets/icon.ico        入口图标（黑鲸鱼剪影，7 个尺寸帧；母版是 assets/icon.png）
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
│   ├── humanize.mjs       拟人延迟 / 静默时段 / 分条（★ 延迟是「等待下限」：回合跑得比它久就直接发）
│   ├── persona.mjs        人设提示词
│   ├── personas.mjs       ★ 人设库（personas/<名字>.md，一个文件一套）
│   ├── speed.mjs          回应速度三档（快速/均衡/谨慎，均为等待下限）
│   ├── persona-sections.mjs ★ 人设分节（**只用于日志与自检**：说清这份人设里有没有说话方式那一节；
│   │                          说话方式本身就在人设正文里，没有独立的常量文件了）
│   ├── memory.mjs         记忆约定（提示词那一段）
│   ├── doctor.mjs         体检
│   └── api.mjs            本地配置 HTTP 接口
├── mcp/mcp-qq-server.mjs  ★ QQ 工具服务器（戳一戳等，手写 MCP）
├── personas/              ★ 人设库（一个 .md 一套；**出厂只有 `小鲸鱼（完整带情绪）` 一份**，
│                            以后改口吻/性格只改它；控制台里能新建/复制/切换；**改了要重启**）
├── config-ui/             ★ 控制台界面（React/Vite，构建产物 dist/ 由桥接伺服）
├── sticker-label/         ★ 表情包人工标注台（独立小工具，零依赖，自带页面）
├── chat-review/           ★ 聊天记录评审台（独立小工具：导入记录 → 判档+评论 → 整理成对说话方式的**修改意见**，不写文件）
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
**用量记账**（真实回合的 token 与成本已落盘 `logs/usage.jsonl`）。

**未验证：**
跨重启的长期记忆（P4，目前重启即失忆，靠工作区的 `MEMORY.md` 兜底）、
**群聊的真实端到端**（判定与投递已在全链路测试里验证过，
但还没有在真实群里跑过一轮）。

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
| 留下 `.tmp-*` 目录 | Windows 句柄回收时机问题，无害。执行 `node mocks/verify-live.mjs --clean`，或下次运行会自动清掉 |
