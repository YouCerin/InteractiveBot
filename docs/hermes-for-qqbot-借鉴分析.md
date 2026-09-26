# `hermes-for--qqbot` 借鉴分析（面向 `project_InteractBot` / `qq-bridge`）

**分析对象**：`D:\#DownLoad\hermes-for--qqbot-main`（QQBot 通用 QQ 群 AI 机器人模板，v0.14.16）
**分析日期**：本次会话
**读者**：`packages/qq-bridge`（SnowLuma → OneBot 11 → DSH agent）的维护者
**取证方式**：直接读源码（py/bat/yaml/md），逐条标注 `path:line`。凡属推断标【推测】，凡属"我自己没找到实现"标【存疑】。

---

## 0. 一句话结论

这不是又一个"QQ 机器人 demo"，而是**一个把"群聊社交礼仪"工程化到极致的 Agent 宿主**：
它最值钱的不是引擎，而是 `hermes/core/plugins/platforms/onebot/` 这一个目录 ——
**分级唤醒信号 + 两级判定窗口 + 16 字段对话状态机 + 两次观测退出闸门 + 单飞执行器**。

对你而言，**判定子系统里"该不该回"的那一层你已主动放弃（触发即必答），但同一目录下的三样东西几乎可以整段搬**：

| 优先级 | 可借鉴项 | 为什么值得 | 落点 |
|---|---|---|---|
| **P0** | 对话状态机（EpisodeState / attentive）+ 两级窗口 + epoch 失效 | 你现在的"必答"模型无法处理**多轮接续**与**被打断**；它给了一套现成状态语义 | `src/trigger.mjs` 之外新增 `src/session-state.mjs` |
| **P0** | 本地语料库 + FTS5(trigram) + 中文短词 LIKE 回退 + `[mid:]/[reply:]` 引用标记 | 你现在只有 NapCat 实时 `qq_group_history`；它把**每条群消息落库并本地全文检索**，还能让 agent 引用具体消息 | `src/memory-store.mjs` 旁新增 `src/corpus.mjs` |
| **P0** | 带内控制标记 `[QUIET]/[SILENT]/[reply:id]/[sticker:名]` + 投递后剥离 | 你已有 `humanize.mjs`/`interim.mjs`，但没有"agent 用标记表达元意图"的通道 | `src/extract.mjs` |
| **P1** | NapCat 凭据自动发现的安全写法（仅 loopback、token 唯一才采纳、显式 self_id 绝不回退） | 你接 SnowLuma，账号/token 发现同构；这套保守规则能直接抄 | `src/snowluma.mjs` / `config.mjs` |
| **P1** | 传输契约纯函数化 + SSRF/媒体上限 + 幂等键 | 你现在 `ssrf` 只有 2 处命中；它把边界判据抽成可离线测试的纯模块 | `src/onebot.mjs` |
| **P1** | **投递前终检门**：内部泄漏过滤 + `[reply:ID]` 存在性校验 + 清洗括号旁白/手写 CQ 码 + 逐行 0.6s 节奏发送 | 把"模型输出可能带垃圾"挡在用户之前 | `src/extract.mjs` / `src/humanize.mjs` |
| **P1** | 记忆写侧的"未完成轮次不记"、每小时蒸馏、间隔重复衰减、supersede 而非覆盖 | 你的"agent 自己记笔记"没解决**没人触发写入**和**跨会话遗忘曲线** | `src/memory-consolidate.mjs` |
| **P2** | 群管理/转发/表情回应等 `qq_*` 工具面 + 工具描述里的"仅管理员/诚实汇报"约束 | 补齐工具箱 | `src/roster.mjs` / MCP 工具表 |
| **P2** | 离线优先安装器 + 升级保护清单 + 旧布局迁移 | 你的 `_release` + `setup.mjs` 已成形，可对照补缺口 | `setup.mjs` / `start.bat` |
| **✗ 不要** | 语义判定 prompt 本身、"该不该回/该不该退出"整套价值观；8 层记忆体系；模型/供应商配置界面 | 与你的产品决策冲突或 DSH 已提供 | — |

---

## 1. 项目定位与体量

- 定位：解压即用的 QQ 群 AI 机器人模板，引擎内嵌（`hermes/core`），配 NapCat 协议桥 + Dashboard + Live2D 立绘 + Obsidian 知识库（`README.md:1-27`）。
- 体量：3172 个文件（1682 `.py` / 609 `.md` / 300 `.ts`）。但**真正与 QQ 群聊语义相关的只有约 10 个 Python 文件**，其余是通用 agent 引擎（多平台 adapter、记忆、provider、TUI、website）。
- 关键目录：

```
hermes/core/plugins/platforms/onebot/     ← 现役 OneBot 适配器（本报告主体）
hermes/core/gateway/platforms/onebot/     ← 上游遗留副本（1454 行，勿改）
hermes/core/tools/qq_napcat_tools.py      ← agent 侧 qq_* 工具（809 行）
hermes/core/corpus_history.py             ← 群聊语料 FTS5 检索（479 行）
hermes/core/agent/memory/                 ← 多层记忆
modules/dashboard | live2d | napcat | knowledge
```

> **反面教材先记一条**：仓库里存在**两份 OneBot 适配器**（`plugins/` 现役 4056 行 vs `gateway/` 遗留 1454 行），只能靠注释互相指认（`CHANGELOG.md:62`）。作者自己把它写进了更新日志当"防误改"措施 —— 这是巨型单文件的必然代价。

---

## 2. 架构分层与你的项目对照

```
OneBot WS 事件
   │
   ├─(1) 接入层  adapter.py            ← 归一化 / 去重 / 媒体 / 落库
   │        · _process_message_bounded（ingress semaphore）
   │        · _is_duplicate（msg_id 30s TTL；docstring 误写 5min）
   │        · GroupStateRegistry.append_message（序号化）
   │
   ├─(2) 触发层  trigger_coordinator.py ← 分级信号 + 两级窗口 + epoch
   │        · @ → 快速通道（取消在飞 judge）
   │        · poke / reply-to-bot / 名字直呼 → 进入对话态
   │        · 其余 → 延迟 JUDGE_WINDOW_IDLE_SECONDS 判定
   │        输出 TriggerRequest（mode）
   │
   ├─(3) 判定层  semantic_judge.py      ← 独立 LLM 调用（temp 0.1, JSON）
   │        · 输入：近 10 条上下文 + 本条 + episode_state + 群噪等级
   │        · 输出：should_reply / should_exit / episode_phase / …
   │
   ├─(4) 执行层  group_executor.py      ← 每群单飞 + FIFO + 轮次上限
   │        · asyncio.Lock per group（★ 只锁 agent 轮次，不锁接入）
   │        · channel_prompt 装配（模式标签/上下文/摘要/状态/记忆）
   │        · 空回复 → 同会话重试一次（契约违例）
   │
   └─(5) 记录层  post_reply_recorder    ← 回写 episode_state（16 字段）
```

> **一个必须说清的细节**：接入与执行**不是**同一把锁。`_process_message` 只对私聊加锁
> （`adapter.py:2678-2680`），群消息**不加锁**进入 `_process_message_impl`（`:2675-2676`）；
> `_get_group_lock` 的唯一消费者是 `group_executor.py:114-116`。
> 即 **接入并发、轮次串行** —— 这个划分是对的，照搬时别把锁加在接入侧（会丢消息或拖慢判定）。

**对照你的现状**：

| 能力 | hermes | 你的 qq-bridge | 差距性质 |
|---|---|---|---|
| 触发 | 分级 + 语义判定 + 可沉默 | `trigger.mjs`：私聊/@/关键词 → **必答** | 设计取舍，不是缺失 |
| 多轮状态 | `EpisodeState` 16 字段 | 无（`epoch` 仅 1 处命中） | **真缺口** |
| 并发 | per-group lock + FIFO + 轮次上限 | `lock` 95 处命中（偏进程/文件锁） | 需核对是否有"每会话单飞" |
| 消息落库 | `corpus_messages` 全字段 + FTS5 | 只有实时 NapCat API | **真缺口** |
| 带内标记 | `[QUIET]/[SILENT]/[reply:]/[sticker:]` | `extract.mjs` 无此类标记 | **真缺口** |
| 记忆 | 10 层 + 22 动作工具 | `MEMORY.md` + `memory/private-*.md`（agent 自维护） | 路线不同，可互补 |
| 人设 | SOUL.md「称呼」节驱动身份装载 | `persona.mjs` 预设 + 反幻觉工具名校验 | 你已做得更干净 |
| 运维 | 离线安装 + Dashboard + 升级保护 | `setup.mjs` + `config-ui` + `_release` | 你已成形 |

---

## 3. 【P0】分级唤醒信号系统

`trigger_coordinator.on_ingested()` 是一次消息的唯一入口，按**信号强度**分派（`trigger_coordinator.py:138-236`）：

| 信号 | 处理 | 依据 |
|---|---|---|
| **@ 自己** | **取消在飞 judge** → 立刻提交 agent 轮次（不走 LLM 判定） | `:153-188` |
| @全体 | 进入对话态 + 走 1s 窗口判定（不强制回） | `:190-202` |
| **QQ 回复了 bot 的消息** | 标记 `_reply_to_bot` + 进入对话态 | `:207-212` |
| **名字直呼（别名模糊匹配）** | 标记 `_name_ref` + 进入对话态，**但不跳过判定** | `:214-230` |
| 普通群消息 | 按当前是否对话态选择窗口后判定 | `:232-236` |

三个可直接搬的工程决策：

**① @ 走快速通道，而不是"高优先级排队"。**
注释里写明了动机（`:156-162`）：早期版本 @ 只是"优先级更高"，结果仍然要等窗口 sleep + LLM 6–16s；现在改成**取消在飞 judge 并立即派发**，因为 @ 的 `should_reply` 是确定性的，等 LLM 纯属浪费。

**② 名字直呼的别名来自配置/SOUL，绝不硬编码。**
`_bot_aliases()` 从 `SOUL.md` 的「别名:」行 + `config.yaml` 的 `platforms.onebot.extra.bot_aliases` 读取，并要求 `len(alias) >= 2`（`semantic_judge.py:167-203`）。
→ 对照你的 `persona.mjs`：你已有「别人叫你「小鲸鱼」「小鱼」「D指导」」这类**自然语言**声明，但没有**机器可读的别名表**。它的做法值得抄：让别名同时服务提示词和代码判定。

**③ poke 是"注视"而非"命令"。**
`_handle_poke()` 进入对话态后**仍走 judge**，并额外带上一段提示文本（`adapter.py:3371-3439`）。这与 @ 的快速通道刻意区分开。

---

## 4. 【P0】两级判定窗口 + epoch 失效（并发正确性）

常量（`trigger_coordinator.py:9-17`）：

```python
JUDGE_DEBOUNCE_SECONDS = 1.0
JUDGE_TIMEOUT = 60.0
JUDGE_WINDOW_IDLE_SECONDS = 5.0        # 旁观：批量 5s 一次判定（省成本）
JUDGE_WINDOW_ATTENTIVE_SECONDS = 1.0   # 对话态：1s 判定（不漏消息）
EXIT_COUNTDOWN_SECONDS = 15.0          # 话题切走后的宽限期
```

机制拆解（`_judge_worker`，`:251-377`）：

1. **每条消息一个独立 judge task**，靠 `semantic_judge` 内部 `Semaphore(5)` 按群限流（`:240-249`、`semantic_judge.py:703-731`）。注释明确拒绝 single-flight：一次慢判定不得阻塞当前消息。
2. **窗口按当时状态动态选**：对话态 1s / 旁观 5s（`:258-261`）。
3. **epoch 双检**：判定前记录 `decision_epoch`，判定后再验一次；中途有新消息使 epoch 变化 → 结果作废（`:266-268`、`:306-309`）。
4. **退出倒计时**：话题 `sharp_transition`/`related_shift` 且未回复 → 起 15s 倒计时；到期才降级为旁观（`:365-368`、`:272-277`）。
5. **"名字直呼"豁免倒计时**（`:364`）——被叫到时话题不算漂移。

> **移植要点**：这套东西的价值不在"判定"，而在**状态与异步结果的配对**。你的桥接只要有"异步产生回复 + 期间又来新消息"的场景，`epoch` + 水位（`last_user_seq` / `last_consumed_seq` / `last_judged_seq`，`group_state.py:146-150`）就是通用解。

---

## 5. 【P0】EpisodeState：16 字段对话状态机

`group_state.py:49-105` 的字段表（你现有代码里完全没有对应物）：

```python
# 生命周期
status: "active" | "winding_down" | "closed"
continuity: "same_episode" | "related_shift" | "sharp_transition"
turn_count: int
exiting_streak: int          # 0..2，代码侧钳制，模型无法直接置 2
# 话题
episode_label: str
current_thread: str
conversation_mode: "casual_chat"|"tech_discussion"|"playful_banter"|"group_ambient"|"serious"
episode_phase: "starting"|"mid"|"winding_down"|"exiting"
# 说话人
last_speaker_role: "owner"|"member"|"bot"|"unknown"
# bot 行为追踪
bot_moves: list[str]         # 上一轮我做了什么
overused_moves: list[str]    # 下一轮必须避免
open_loops: list[str]        # 悬而未决的话头
resolved_threads: list[str]  # 已聊完
# 下一轮指导
progression_guidance: str
# 元数据
created_at, updated_at: float
```

三个设计精华：

**① 状态由"记录器"写、"判定器"读，形成闭环。**
每轮回复后 `post_reply_recorder` 用一次 LLM 调用更新 episode_state（`semantic_judge.py:1262+`），下一轮的 judge 消费它；`progression_guidance`（"下一轮该怎么做"）与 `overused_moves`（"别重复这些动作"）是**跨轮的行为约束通道**。这比"把历史消息全塞进 prompt"便宜得多，也更能防复读。

**② 退出闸门由代码强制，不信模型单次判断。**
模型可能因为一轮噪音就报 `exiting`；`_enforce_exit_gate` 要求**连续两次观测**才允许硬退出，且被直接指向（@/回复/名字）时无条件回到 `mid`（`trigger_coordinator.py:84-134`）。字段 `exiting_streak` 就是"连续观测计数"，`from_dict` 里也钳制到 0..2（`group_state.py:108-113`）。
→ **这是本报告里最值得抄的一条防御式设计**：把 LLM 的"强烈建议"降级为"需要复核的信号"。

**③ `go_quiet()` ≠ `end_episode()`。**
`go_quiet` 只退出对话态、保留 episode_state（下次被叫回来可续）；`end_episode` 才清空并归档（`group_state.py:279-294`）。对话态还有两个硬性衰减：**600s 无活动**或**连续 3 次静默**自动脱落（`:245-254`）。

**落点建议（不引入语义判定也能用）**：你的 `trigger.mjs` 保持"必答"，但可以在每次成功回复后维护一份精简状态（`turn_count / current_thread / open_loops / last_speaker_role`），注入下一轮提示词，解决"连续对话第 3 轮开始答非所问、复读"的问题。

---

## 6. 【P0】上下文装配：`channel_prompt`

`group_executor._build_channel_prompt()`（`:235-333`）是**"把一次群聊事件翻译成 agent 可消费上下文"**的完整范式：

```
[对话模式] 该用户@了你。09-05 21:03 来自「群友A」：……

[群聊上下文]
[mid:12345][09-05 21:01] 群友B(1002): ……
[mid:12346][09-05 21:02] 你(1001): ……

[对话摘要] …（rolling_summary）
[对话状态] 第3轮
话题: 延迟优化
阶段: mid
氛围: tech_discussion
指导: …（仅非 @ 时给）
避免: 复读上一轮的吐槽
已聊完: 部署方案

[标记] 想引用某条消息就在回复里用 [reply:消息ID]。
本轮你已被叫到，必须给出大家能看到的回复——沉默不是可选项。
[搜索历史] 你可以调用 search_chat_history 工具搜索群聊历史
```

要点：

- **模式标签显式**：`[对话模式]/[旁观模式]/[退出模式]`（`:245-262`）。你的桥接目前靠提示词描述，显式标签更省 token 且更难被忽略。
- **群聊上下文带 `[mid:...]` 锚点**，最近 20 条，格式 `[mid][时间] 名字(QQ号): 文本`（`:335-347`）。
- **上下文走 ephemeral system-prompt 通道**（`channel_prompt`），不占用户对话记录（`:143-148` 注释强调"从不作为 user transcript 条目"）。→ DSH 侧对应你自己的注入方式，需确认是否等价。
- **总长硬截断 500K**（`:359-362`）。
- **"别处的印象"（跨会话联想）有专门的免责说明**（`:312-318`）：提醒模型这是别的群的记忆、不要说出是谁/在哪说的。

---

## 7. 【P0】带内控制标记（in-band markers）

`adapter.py:162`：

```python
_CONTROL_MARKER_RE = re.compile(r"\s*\[(QUIET|SILENT)\]\s*", re.IGNORECASE)
```

配合的语义（由测试固化为契约，`tests/gateway/test_onebot_silence_contract.py`）：

| 标记 | 含义 | 契约细节 |
|---|---|---|
| `[QUIET]` | 正式退席 | 剥离后发送正文；**只有标记没有正文时"不发送、也不立刻 quiet"**（留给重试） `:81-96` |
| `[SILENT]` | 本轮保持沉默 | 同上，`marker_names == ("SILENT","QUIET")` 会被记录 `:67-77` |
| `[reply:消息ID]` | 引用某条消息 | 提示词里声明，执行层解析 `:322-331` |
| `[sticker:名字]` | 发表情 | 人设模板里声明（`templates/config-template.yaml:50`） |

**为什么这个设计值得抄**：它给 agent 一条**结构化的元意图出口**，而不是让桥接层靠正则猜。且**剥离发生在投递前**，用户永远看不到标记；测试还锁定了"纯标记不投递"的边界，避免"标记当正文发出去"或"标记直接触发状态迁移"。

配套的两条纪律（比标记本身更重要）：

- **标记引起的状态迁移必须"投递成功后才提交"**：`marker` 状态只在投递成功后落状态（`adapter.py:3574`），内部泄漏场景永不提交（`:3576-3580`）；在 executor 轮次内，纯标记的状态迁移会**延迟到"空回复契约重试"跑完之后**（`:3581-3582`），避免"重试还没跑就把对话关了"。`delivery_text == ""` 被用作"没有任何用户可见内容送达"的判据（`:3598-3624`）。
- **`[QUIET]` 只在退出模式下提供**（`group_executor.py:320-331`，由 `test_onebot_silence_contract.py:169-194` 断言）。**能力按场景给**，而不是全程可用 —— 这能防模型滥用。

### 7.1 投递前终检门（`_send_message_impl_core`，`adapter.py:3791-3931`）

这是 agent 输出到用户之间的**最后一道闸**，四件事一起做，很值得整体照搬：

| 动作 | 说明 |
|---|---|
| **内部泄漏过滤** | `_is_internal_leak()`（`:3732-3765`）拦工具循环告警、原始工具 JSON、系统占位符、被注入的 `/stop` 类指令；命中时**静默成功**（`:3813-3816`）。你的桥接若不拦，用户会看到 `tool_call` 之类的内部文本 |
| **`[reply:ID]` 存在性校验** | 拿 `corpus_messages` 校验消息 ID 真属于本群，否则丢弃该引用（`:3819-3841`）。→ 与 §8 语料库闭环 |
| **清洗** | 剥离 `（…）` 动作旁白与用户手写的 CQ 码（`:3848-3858`） |
| **长文改写** | >80 字的 markdown 式汇报会**回炉给主模型**改写成人设口吻（`:3864-3910`） |

发送节奏：多行回复**逐行发送**，行间 0.6s 间隔（`:3916-3931`）—— 模拟真人打字，也是风控友好的做法。

> 你的 `humanize.mjs` + `interim.mjs` 已覆盖部分语感，`extract.mjs` 也在做文本抽取，但**泄漏过滤**与**引用校验**是缺的。把 `[reply:id]` / `[sticker:名]` 加进去成本很低，收益是让"引用/表情"从"提示词请求"变成**可靠协议**。

---

## 8. 【P0】本地群聊语料库 + 中文全文检索

这是你**目前完全没有**的一块。

### 8.1 表结构（`adapter.py:473-542`）

```sql
corpus_messages(
  id, message_id, chat_id, chat_type, group_id, user_id,
  sender_name, sender_card,
  content_raw, content_readable,          -- 原始 CQ / 可读文本
  image_descriptions, voice_transcript, video_understanding,
  forward_structured,                     -- 转发消息结构化内容
  at_targets, reply_to_id, reply_to_text, -- 指向关系
  is_bot, media_paths, media_cached,
  created_at, session_id, recalled_mem_ids, salience_hint
)

corpus_pairs(                              -- ★ 触发↔回复 配对
  trigger_msg_id, bot_reply_text, context_snapshot,
  system_prompt, recalled_mem_ids, session_id,
  model_used, was_corrected, created_at
)

groups_registry(                           -- ★ 群级画像
  group_id, group_name, joined_at, is_active, activity_level,
  wake_sensitivity, notes, topic_summary, topic_keywords, topic_updated_at
)
```

- `corpus_pairs.was_corrected` + `context_snapshot` + `system_prompt`：**完整的"当时看到什么、说了什么、事后是否被纠正"留档**。这是做 badcase 回归和 prompt 迭代的原料，你现在只有 `oplog.mjs`。
- `groups_registry.wake_sensitivity` / `activity_level`：**每群可调的唤醒灵敏度**，比全局关键词表精细。

### 8.2 检索（`corpus_history.py`，479 行，全部可移植）

- FTS5 虚表用 **`tokenize='trigram'`**（中文子串匹配）+ `content=` 外部内容表 + `AFTER INSERT` 触发器（`:99-118`）。**幂等初始化**（`:64-125`）与 `rebuild`（`:131-176`）分离。
- **关键中文细节**：trigram 对 1–2 个汉字的查询几乎无效 → `_count_cjk(query) < 3` 时**自动走 LIKE 回退**（`:419-429`）；FTS 命中 0 条且查询含中文时再回退一次（`:432-438`）。
- **硬上限**：query ≤ 200 字、limit ≤ 100（默认 8）、preview ≤ 120 字（`:36-39`、`:404`）。
- **结果自带引用标记**：每条返回 `mid: "[mid:xxx]"` 与 `cite: "[reply:xxx]"`（`:235-236`），与第 7 节的带内标记**闭环**。
- 撤回的消息标 `[已撤回]` 前缀并置 `recalled`（`:231-232`、`:352-363`，含 `ALTER TABLE` 的幂等迁移）。

> **落地建议**：你用 `node:sqlite`（`docs/contracts.md:195-205` 已确认可用）。把 `corpus_messages` 的字段裁到需求子集（`message_id / chat_id / group_id / user_id / sender_name / content_readable / at_targets / reply_to_id / is_bot / created_at / media_paths`），FTS5 trigram + CJK LIKE 回退整套照搬，再暴露一个 `qq_search_history` 工具。**注意 SQLite FTS 的 trigram 分词器与 `LIKE` 的中文行为要在你的 Node 版本上实测**（【推测】Node 内置 SQLite 的 FTS5 编译选项可能与 CPython 不同）。

---

## 9. 【P1】传输契约与可靠性

### 9.1 把边界判据抽成纯函数（`transport_contract.py`，652 行）

文件头写明动机：adapter 负责 socket/HTTP I/O，本模块只做**端点解析、响应分类、握手校验、媒体上限**，因此可以**离线测试**（`:1-6`）。核心是三个不可变数据类：`OneBotEndpoint / OneBotTransportDescriptor(layer, code, retryable, status_code, message) / OneBotReceipt(ok, status, retcode, message_id, descriptor)`（`:22-90`）。

→ **可直接照抄的思想**：你的 `onebot.mjs` 里把"错误 → 是否可重试"的判定从业务逻辑里拆出来，做成纯函数 + 表驱动。`retryable` 作为**一等字段**（而不是散落的 if）尤其值得。

### 9.2 SSRF 与媒体上限（两段式，做得比一般项目扎实）

- `MAX_ENDPOINT_URL_CHARS = 2048`、`MAX_MEDIA_DOWNLOAD_BYTES = 20MB`（`transport_contract.py:18-19`）。
- **第一段（纯函数）** `validate_media_url`（`:500-601`）：拒坏 scheme、单斜杠 `file:http://`、`file://` UNC authority、百分号/反斜杠混淆 authority、**整数/十六进制/八进制形式的 IPv4**、私有/链路本地/保留/CGNAT 字面量，同时保留 loopback 可用。
- **第二段（adapter）**：线程内做 DNS 解析并**拒绝所有私有答案**（防 DNS rebinding）；loopback 媒体 URL 必须与配置的 OneBot HTTP host+scheme+port **完全一致**（`adapter.py:1486-1621`）。
- 下载 `follow_redirects=False`（`:1654`、`:2218`、`:2286`），体积三处设限：声明 Content-Length、累计 64KiB 分块、最终 `validate_media_response`（`:1860-1921`）。
- 配套测试 `tests/gateway/test_onebot_media_ssrf.py:45-333`（10.8KB）说明这是被当**安全边界**对待的。

→ 你 `ssrf` 只有 2 处命中。**"纯函数校验 + DNS 二次校验 + 不跟随重定向 + 流式限长"这四步式**建议直接照搬结构。

### 9.3 去重、幂等与断线恢复

| 机制 | 参数 | 位置 |
|---|---|---|
| 消息去重 | `message_id` **30 秒** TTL，>100 条时清理；合并 @ 批次用合成 id 跳过 | `adapter.py:396`、`:2614-2631`、`:2650-2655` |
| 转发子消息去重 | `forward_id` 5 秒 TTL | `adapter.py:2657-2670` |
| 邀请标记去重 | 上限 500 → 裁剪至 300 | `adapter.py:3298-3299` |
| 投递幂等键 | `sha256(session_id \| message_id \| chat_id \| reply_to \| text)[:32]` | `contract.py:335-344` |
| 排队去重 | `(origin_seq, mode)` 相同则不重复入队 | `group_executor.py:51-54` |
| 会话键 | `onebot:{chat_type}:{chat_id}[:thread:{tid}][:user:{uid}]` | `contract.py:295-320` |
| 背压 | 接入 `Semaphore(20)`；持久化队列 `maxsize=500` 满则丢弃并记日志 | `adapter.py:390`、`:373`、`:444-451` |
| 媒体任务 | 30s 超时；断线时 `cancel_all()` | `media_pipeline.py:8`、`:42-65` |

**断线恢复**（`_recover_missed_messages`，`adapter.py:2465-2594`）：重连后按 200/150/100 分批拉历史；**间隔超过 120 秒的位置插入 `⚠ 掉线期间消息丢失` 占位**；只重放 180 秒内的 @ 消息，且仅限最近 3 分钟活跃过的群。→ "宁可显式标记缺口，也不假装连续"这个态度值得抄。

**重连本身在适配器之外**（重要，别找错地方）：失败被归类成 `OneBotTransportDescriptor + _set_fatal_error`（`:975-979`、`:1113-1118`），由网关 `_platform_reconnect_watcher` 以 30→60→120→240→300 秒退避重试（`gateway/run.py:2626`、`:2725`、`:2739`）；适配器内的 `_ws_reconnect_interval`（`:399`）是**死配置**。→ 对应你的场景：**把"可重试/不可重试"作为描述符输出，把重试策略交给外层**，是更干净的分层。

### 9.4 NapCat 凭据自动发现 —— **这一节与你的 SnowLuma 场景同构，建议直接抄规则**

`config_discovery.py` 的保守性做得非常好（全文 335 行）：

1. 只读**明确的本机配置文件**（`onebot11_<uin>.json`），**从不写 .env、不调 WebUI、不发网络请求**（`:1-9`）。
2. 只接受**常规文件**（`lstat` 拒符号链接）+ 体积上限 2MB + token 长度上限 512 + 拒绝控制字符（`:56-65`、`:145-153`）。
3. **只采纳 enabled 且 host 属于 loopback 的服务器**（`127.0.0.1/localhost/::1`）；**HTTP 与 WS 服务器若给出不同 token 就放弃猜测**（`:181-194`、`:213-227`）。
4. 账号选择顺序：显式 `self_id` → 最新的 `napcat_protocol_<uin>.json` → 最新的账号文件；**若显式给了 self_id 却在文件里找不到，直接返回 None，绝不复用到别的账号**（`:258-281`）。这一条是安全底线。
5. 另有 `list_napcat_onebot_accounts()` 返回**不含密钥的摘要**给 Dashboard 选择（`:288-327`）。

---

## 10. 【P1】记忆系统：与你"agent 自己记笔记"的对照

它的记忆体系远比你的重（10 层：L0 JSONL 事件流 / STM / chat buffer / LTM 语义 / LTM 情节 / EPI 片段 / Workflow / Wiki / core_memories / 受控 `MEMORY.md`+`USER.md`），**不建议整体搬**。但有几条你现有方案确实缺：

| 它的做法 | 你现在的状态 | 建议 |
|---|---|---|
| **未完成的轮次不写入记忆**（`memory_maintenance.py:94-107`：`completed/interrupted/failed/contract_retry` 时不记） | 无对应约束 | 抄。避免"被打断的半轮"污染记忆 |
| **每小时蒸馏未汇总的会话**（`:248-278`），理由写明"QQ 会话永远不会 `/reset`，不主动蒸馏记忆就冻住" | 无定时蒸馏 | 抄，且理由与你完全一致 |
| **recall_strength 间隔重复衰减** `S·R·exp(-0.693·t/S)`（`long_term.py:199-210`） | 无衰减 | 可按此思路给 `MEMORY.md` 条目加"最后引用时间 + 权重" |
| **纠正用 supersede 而非覆盖**（`store.py:812-881`，带 `supersedes_id`） | 直接改写文件 | 抄（保留"我说错过什么"对防复发有价值） |
| **EPI 的隐私域** `share_level 2/1/0`（具名/匿名/封存）+ 写入时 LLM 隐私判定 + `_anonymize()` 剥离说话人与 5 位以上数字 + **6 小时同片段冷却** | 你有 `privacy.mjs`，但未见"跨群引用"的匿名化与冷却 | 值得补：跨群联想是群聊机器人的高价值/高风险功能 |
| **提示词前缀快照**：`MEMORY.md` 改动对工具立即可见，但**注入只在下个会话生效**，以保护 prompt 前缀缓存 | 无 | 抄这条能省真金白银（你文档里已在算缓存命中率） |
| **纯词法检索**：中文 2-gram + IDF 倒排 + FTS5，**不引入 embedding** | — | 与第 8 节合并实施，零额外依赖 |

**明确不要**：8 个外部 provider（mem0/retaindb/supermemory/openviking/hindsight/byterover/honcho/holographic）全部是网络或需自托管；`wiki.py` 硬编码拉取某个 GitHub 仓库；`obsidian.py` 靠猜 vault 路径。

---

## 11. 【P1】运维与产品化

### 11.1 离线优先安装（`install.bat`，219 行）

- 6 步分阶段，**每步都有"已存在则跳过"**（幂等），失败给**可执行的下一步**（如 pip 失败提示镜像源）`:181-185`。
- 支持 **tar 回退**：`Expand-Archive` 失败则 `tar -xf`（`:96-98`）。
- **分卷包**：`electron-offline.zip.001/.002` 用 `copy /b` 合并后解压（`:116-135`）。
- 从 `VERSION` 文件读版本号，避免硬编码漂移（`:12-14`）。
- 结尾打印**环境自检清单**（各组件 OK/缺失）与 5 步 next steps（`:206-217`）。

→ 你的 `setup.mjs` 已有 `--check` 与 `--release`；可对照补：**分阶段幂等 + tar 回退 + 结尾自检表**。

**分发包构成**：离线载荷是 `extras/python-installer.exe`、`extras/nodejs.zip`、`extras/electron-offline.zip.001/.002`、预装 Live2D 模型 —— **全部 git-ignored**（`.gitignore:14-15,31-35,57-58`），只存在于手工构建的 Release zip 里。分卷包是**纯字节拼接**（`copy /b .001+.002`，`install.bat:118`），不是自解压 SFX。

**但构建流程很原始**：`build-release.ps1` 只有 4 个手工步骤（提取 Node、npm 装 Electron、建 venv 装依赖），**最后一步是"打印提示让你自己打包 zip"**（`:51-52`），无版本号注入、无校验和、无产物清单。→ **这是它的短板，不是榜样**；你的 `setup.mjs --release` + `release-audit.json` 方向更对。

> 顺带一个坑：`update.bat:139-140` 的 bundle 复制判断有 bug —— `if exist` 检查的是 `%SRC_DIR%\electron-offline.zip.001`，而 `copy` 的源却是 `%SRC_DIR%\extras\electron-offline.zip.001`，两者不一致，条件永远为假。
> 另一个坑：`update.bat:44-50` 直接下 `archive/refs/heads/main.zip`（**主干分支快照，不是 release 资产**），没有校验和，也没有版本固定。**你的升级机制不要照抄这条。**

### 11.2 升级（`update.bat`，186 行 + `upgrade.py`）

- 顶部**明确列出受保护文件**：`config.yaml / SOUL.md / .env`（`:19-22`），结尾再强调一次（`:178-182`）。
- **按布局而非版本号分支**：检测 `hermes\gateway\` 存在而 `hermes\core\` 不存在 → 先备份 `hermes.bak.<YYYYMMDD-HHMMSS>`，**询问用户后再删**，调用 `migrate_legacy.py`，并跳过引擎复制/依赖/升级三步（`:76-118`、`:147`、`:160`）。
- 用 `robocopy /E` 按目录更新引擎/模块/模板/脚本，`.bat` 与 `VERSION` 单独 copy（`:116-135`）。
- 最后跑 `upgrade.py` 同步到 `HERMES_HOME`（`:159-168`）。

`upgrade.py` 里最值得学的是**"显式清单 + 有界自动闭包"**的组合：

- `UPGRADE_MAP` 是约 90 条 source→dest 的**显式白名单**（`upgrade.py:31-133`）；
- 之后再用**有界动态闭包**兜底：所有剩余 `hermes/core/**/*.py`，上限 10000 个文件，排除 `tests/ docs/ .git __pycache__` 与隐藏目录（`:146-172`）；
- 每条**双写**：写到 `~/.hermes`（剥掉 `hermes/core/` 前缀）+ 写回模板根供下次升级（`:266-299`）；
- 守卫：只允许相对路径、拒符号链接/junction、`commonpath` 包含性校验、`--dry-run`（`:190-246`、`:315-319`）；
- 还有 `audit_upgrade_map.py`：只读 AST 漂移检测，报告"运行时可达但不在白名单里的本地 import"（`extras/scripts/audit_upgrade_map.py:1-23`）。

→ 对应你的 `RELEASE.md` / `setup.mjs --release`：**"受保护文件清单显式化 + 迁移前备份 + 询问式删除 + 白名单+闭包+漂移审计"** 这套组合值得对齐。你的 `release-audit.json` 已有雏形，可以补一个 AST/import 漂移检查。

### 11.3 Dashboard（`modules/dashboard/`，无框架）

后端是 **stdlib `http.server` + `ThreadingMixIn`**（`server.py` 1947 行 + `static/index.html` 82KB），绑 `127.0.0.1:8899`。它与 bot 通信有三种方式，**没有 RPC**：

- **文件**：白名单化的 `.env` 读写，权限 `0600`，1MB 上限，拒换行/NUL（`server.py:137-230`）；
- **进程内 import** 引擎记忆网关做记忆检索（`POST /api/memory/search` → `search_long_term + search_workflows`，`:777-792`）；
- **子进程**：`[VENV_PYTHON, -X utf8, -m hermes_cli.main, gateway]`，注入 `HERMES_HOME`，`CREATE_NO_WINDOW`，stdout 进 200 行环形缓冲（`:86-93`、`:1714-1787`）。

可借鉴的四个具体设计：

1. **日志流用 SSE**：连接时先推 50 行缓冲，然后 2 秒轮询合并环形缓冲 + 按字节偏移 tail `agent.log`（截断安全），前端用 `EventSource` + 指数退避重连（`:299-343`、`:1635-1712`）。
2. **存活判定以端口探测为准**，状态文件与进程扫描只作兜底（`:346-396`）。
3. **启动前先检查前置条件**：启动网关前要求 NapCat 在线，否则返回 `need_napcat` 标记让 UI 弹可操作提示（`:1721-1742`）。→ 你的 SnowLuma 同理：**启动 bot 前先确认客户端已登录**。
4. **险要动作先 ACK**：start/stop 是 fire-and-forget 线程，立刻返回 `"starting"`，UI 保持亚秒响应（`:1551-1581`）。
5. **账号选择只持久化 ID，永不持久化 token**：`/api/napcat/accounts` 返回的摘要只有 `account_id / available / token_configured / http_port / websocket_port / selected`（`:1399-1438`）；选择后写 `ONEBOT_SELF_ID` + `ONEBOT_AUTO_DISCOVER_TOKEN=true`（`:1440-1485`）。

→ 你已有 `config-ui`（Vite/React）。**缺的是**：日志流端点、记忆/语料检索端点、账号发现端点、以及"前置条件门控"。可以只补这四项，不必换技术栈。

### 11.4 供应商配置 → **你不要抄**

`配置API.bat` + 供应商表 + thinking 方言注册表（`CHANGELOG.md:42-56`）—— 这套存在的理由是它的引擎自己管模型。**DSH 已提供模型/provider 配置与思考强度**，重复实现只会增加维护面。

两个附带事实（避免被文档误导）：

- README 说"支持 13 家供应商"（`README.md:37`），但 `extras/scripts/setup_config.py:41-78` 的 `LLM_PROVIDERS` 实际是 **12 条**；引擎侧另有 28 个 provider profile。**"13" 是文档漂移。**
- **向导本身不做任何 key 校验**：`ask(secret=True)` 只保证非空（`:117-126`、`:389-390`），全文件无网络请求。真正的校验在下游 `doctor.py` 的 `/models` 健康检查（`hermes/core/hermes_cli/doctor.py:208-287`）与 `ProviderProfile.fetch_models()` 的软失败（`providers/base.py:117-165`）。

但它的**交互 UX** 有可取处：菜单项显示 `name (base_url)` 副标题、`默认值 + 非回显密钥输入`、同一端点可复用 LLM key（`:407-419`）、思考强度用统一档位命名、只在 `provider=custom` 时才追问方言（`:129-160`、`:366-419`）。

### 11.5 版本纪律

`VERSION`（内容 `0.14.16`）+ `CHANGELOG.md`（537 行，倒序、按主题分小节、**末尾列"涉及文件"**，如 `CHANGELOG.md:64-65`）+ `UPGRADE.md`（18KB，含"本版本不覆盖 config.yaml/SOUL.md/.env/数据库/sessions/日志"的显式声明，`UPGRADE.md:12`、`:22`）。CHANGELOG 里连"我修了哪个分发缺陷"都写明（`:35-40`：`.gitignore` 的 `_*.py` 误匹配 `__init__.py` 导致分发包缺 101 个文件）—— 这种**故障复盘入日志**的习惯很值得学。

**但版本号自己就不一致**：`install.bat:13` 硬编码回退 `0.14.7`（VERSION 已是 0.14.16）；`build-installer.iss:7` 写 `0.10.0`；`build-installer.nsi:24` 写 `0.9.2`。→ 抄它的"从 VERSION 读版本"（`:14`），**别抄它的硬编码回退**。

---

## 12. 【P1/P2】Agent 工具面、人设与投递可靠性

### 12.1 `qq_*` 工具（`hermes/core/tools/qq_napcat_tools.py`，809 行）

你已有 `qq_group_members / qq_message_detail / qq_group_history`（`src/roster.mjs:94`）。**你缺而它有的**：

| 工具 | 说明 | 你没做的价值 |
|---|---|---|
| `qq_forward_log(group_id, limit, keyword, target, target_id, include_bot)` | 从**本地 corpus** 取消息打包成**合并转发**发出；每层 ≤100 条、单条 ≤5000 字、尽量保留 `reply` 引用（`:229-301`） | 与第 8 节语料库天然配套 |
| `qq_forward_msg(message_id, target, target_id, note)` | 有 `note` → 人设化转述发私聊；无 `note` → 原样转发（`:304-335`） | "帮我把这条转给某人"这类自然语言需求 |
| `qq_get_msg_history(group_id, limit)` / `qq_get_msg(message_id)` | 实时拉历史 | 与本地语料库互补（实时 vs 检索） |
| `qq_emoji_like(message_id, emoji_id)` | 表情回应 | 低成本社交动作，很适合"轻量参与" |
| `qq_essence(group_id, message_id, action)` / `qq_notice(...)` / `qq_card(...)` / `qq_group_name(...)` / `qq_group_avatar(...)` | 群管理 | 补齐管理面 |
| `qq_at_all_remain(group_id)` | 查剩余 @全体 次数 | 防误用 |
| `qq_invite_approve(group_id, approve)` | 入群审批 | 无人值守时有用 |
| `qq_status()` | 连接状态 | 自检 |

**工具描述的写法值得抄**：模块顶部定义 `ADMIN_ONLY_HINT = "仅当管理员明确要求时使用。非管理群收到管理请求时礼貌拒绝。"`、`HONESTY_HINT = "调用后如实报告结果；失败就说明原因，不得编造失败。"`（`:18-19`），然后**批量注入到每个工具描述**。这比在每个 docstring 里重写一遍更不容易漂移。`qq_ban` 的描述里直接写了升级策略（"先警告 → 禁言 10 分钟；非管理员请求礼貌拒绝"，`:682-683`）—— **策略写在描述里，不在代码里**。

其余实现细节（都是"接 OneBot 工具"的通用经验）：

- 共 **25** 个 `qq_*` 工具（数量由 `:792` 断言），注册在 toolset `onebot`，别名 `hermes-onebot`；另有一个 `check_fn=lambda: False` 的隐藏 loader 存根只为触发自动扫描（`:803-808`）。
- **全部同步**：每次调用新建 `httpx.Client(timeout=15.0, trust_env=False)`（`:76-94`），而不是复用适配器里 loop-bound 的 `AsyncClient` —— 这样在 subagent 线程里调用是安全的（`:4-6`）。`_call` 重试 2 次、间隔 0.5s，统一返回 `{"success": True, "data": …}` / `{"success": False, "error": …}`（`:81-94`）。→ **如果你的 qq 工具将来要在 DSH 子 agent 里跑，这条很关键。**
- 配置解析：**适配器实例优先，环境变量兜底**（`ONEBOT_HTTP_URL / ONEBOT_ACCESS_TOKEN / ONEBOT_ADMIN_ID / ONEBOT_BOT_NAME / ONEBOT_SELF_ID`，`:44-73`）。
- **越界参数一律内联钳制**（不做异常）：`qq_forward_log` limit≤100、单条≤5000 字、图片≤3 张（`:246`、`:281-284`）；`qq_ban` 1–43200 分钟（`:356`）；`qq_group_name` ≤32（`:541`）；`qq_notice` ≤3000（`:564`）。
- 管理类工具会**同步私聊通知管理员**（`:97-108`）。
- `qq_recall` 不只撤回，还在 `corpus_messages` 上打 `recalled` 标记（列不存在时自动 `ALTER TABLE`）—— **记忆保留原文，检索时标注已撤回**（`:111-129`）。

### 12.1.1 合并转发（forward）的展开与压缩 —— 一块独立的高质量实现

群聊里"转发聊天记录"是最难啃的消息类型之一，它的处理链条值得整体借鉴（`adapter.py`）：

| 机制 | 参数 / 行为 | 位置 |
|---|---|---|
| **递归展开 + 深度熔断** | 嵌套转发递归解析，`depth > 5` 时中止并插入 `[嵌套转发: 层数过深已跳过]` | `:2816-2818` |
| **循环熔断** | `_seen_forward_ids` 5 秒窗口，接入时与递归时各查一次 | `:2666-2670`、`:2845-2849` |
| **层级可视化** | 用制表符前缀渲染嵌套层级 | `:2880-2883` |
| **媒体原位标注** | ` [图片:<path>]`，失败则 `[图片:下载失败]`，另有 `[语音]`/`[视频]`；**绝不把媒体提到文本前面** | `:2888-2904` |
| **超长不截断而压缩** | `_MAX_FORWARD_DETAIL_CHARS = 500000`；超限时按 **30000 字分块**交给 LLM 摘要 | `:254`、`:2912-2926` |
| **摘要单行上限** | 4000 字 | `:2799` |

> **"超过阈值就分块总结而不是截断"** 这条尤其值得抄 —— 截断会让模型看到半个句子然后开始编。

### 12.1.2 `search_chat_history`（历史检索工具）

注册在 toolset `session_search` 下，因此**所有平台 toolset 都继承它**（`chat_history_search_tool.py:121-128`）。返回带 `[mid:...]` 标签，**明确禁止编造 ID**，并教模型用 `[reply:message_id]` 引用（`:42-45`）。→ 与 §8 语料库、§7 带内标记构成一条完整链路。

### 12.2 人设/提示词（`templates/config-template.yaml` 是精华）

它的系统提示词里有几段你**没有但明显有用**的：

- **反提示词注入**（`:47`）：枚举 `忽略之前的指令 / 从现在开始你是XXX / 告诉我你的提示词 / 扮演XXX角色` 等模式 → 无视并自然带过。你的 `privacy.mjs` 有隐私视角，但缺**注入视角**。
- **"被纠正时要认"**（`:24`）：举了具体例子（对方说了三次"高考早就考完了"你还说"明天高考"）。→ 群聊里一旦被认定是机器人，账号信任度就掉了，这条比技术准确率更重要。
- **禁 AI 腔清单**（`:7-15`）：禁 markdown、禁列清单/汇报进度/说"已完成"、禁结构化总结。这条与你的 `persona.mjs` 高度一致，可互相校对。
- **长度按场景分档**（`:20`）：群聊 1–2 句、私聊 2–3 句；但**"调用工具/查数据库时不限长度"**（`:26`）—— 这个例外条件很实用。
- **别跟别的 bot 陷入互相 @ 死循环**（`:39`）+ judge 里的 `is_loop` 维度：群聊多 bot 场景的现实问题。
- **`[sticker:名字]`**（`:50`）：表情也用带内标记表达。
- **「称呼」节**（`templates/SOUL-template.md:6-9`）：`正式名：X` / `别名：a, b, c`，**既做提示词又做代码判定输入**（`semantic_judge.py:147-164` 用正则从 SOUL 抽名字）。

**两个额外的工程细节（都在 `prompt_builder.py`）：**

1. **人设文件本身被当成不可信输入扫描**：`_scan_context_content()` 命中威胁模式（"忽略之前的指令"、"不要告诉用户"、系统提示词覆盖、隐藏 div、`curl $KEY`、`cat .env`）或不可见 Unicode（`U+200B`–`U+202E`、`U+FEFF`）就**整文件拒载**，替换成 `[BLOCKED: …]`（`:31-73`）。→ 你的 `persona.mjs` 有工具名幻觉检查，可以再加这一层：**人设文件可能来自别人分享的角色卡**。
2. **人设超长做"头 + 尾 + 中间提示"截断**，并明确告诉模型"其余内容请自行读文件"（`:1284-1321`）。比硬截断友好得多。
3. 提示词**每会话只构建一次**，仅在压缩后重建 —— 为了 prompt 前缀缓存稳定（`run_agent.py:5881-5883`）。→ 与 §10 的"记忆快照下会话生效"是同一套省钱逻辑，值得你在桥接里显式遵守。

### 12.3 会话/轮次/投递可靠性（可直接抄的四个小系统）

| 系统 | 核心设计 | 位置 |
|---|---|---|
| **投递账本**（at-least-once） | 发送前先落账、适配器确认后才标记；恢复是**故意 at-least-once**，进行中的义务会带**可见的恢复标记**而不是静默重复。状态 `pending → attempting → delivered\|failed`；`MAX_ATTEMPTS=3`、陈旧 24h、保留 7 天、上限 500 行。两个细节很精：①重复生产者**不能复活已 delivered 的行**（`WHERE obligation_id=? AND state <> 'delivered'`）；②所有权用 **(pid, 进程启动时间)** 而非 pid，避免 PID 复用误判 | `delivery_ledger.py:1-11`、`:30-35`、`:62-77`、`:113-140`、`:195-203` |
| **会话键规则** | 私聊按 `chat_id`；群聊按 `chat_id`，**仅当 `group_sessions_per_user` 开启才附加 `user_id`**；线程内默认共享（除非显式开 `thread_sessions_per_user`） | `session.py:598-663` |
| **不活跃策略** | `mode: daily\|idle\|both\|none`、`at_hour`、`idle_minutes`；**过期是"重置"而非"销毁"**（新 session_id + `auto_reset_reason`）；**活跃后台进程能否决过期** | `gateway/config.py:230-232`、`session.py:840-876` |
| **配对码**（未知用户批准） | 8 位、32 字符无歧义字母表（排除 `0/O/1/I`）、`secrets.choice`、1 小时有效、每平台 ≤3 待批、每用户 10 分钟限流、5 次失败锁 1 小时、`0600` 权限、**永不写日志** | `pairing.py:8-45` |

另有两个"知道就好"的模块：`turn_lease.py`（显式标注为**未接线**的能力移植，用于"两个路由键映射到同一 durable session 时不得并发"）、`shutdown_flush.py`（关闭时把内存队列用**临时文件 + fsync + 原子替换**落盘，**重放成功后才删 spool**，畸形载荷留给人工恢复；`:1-13`）。后者的思路对你 `process-guard.mjs` 的优雅退出有参考价值。

### 12.4 输出净化与循环护栏（三个小机器，想法可搬）

| 模块 | 可搬的想法 |
|---|---|
| `think_scrubber.py:64-223` | **流式**清洗 `<think>` 类标签的状态机：跨 delta 切分的标签要"扣留半截前缀"、只在块边界（起始/换行/纯空白行）允许开块（这样正文里提到 `<think>` 不会被误吞）、清掉孤立闭合标签；**`flush()` 时宁可丢弃扣留内容也不泄漏半截推理** |
| `tool_guardrails.py:19-78`、`:127-136`、`:347-348` | 工具循环检测：身份 = `(工具名, sha256(排序后的紧凑 JSON 参数))`，结果也做规范化哈希（**原始参数不进元数据**）；三个信号（同一调用失败 N 次 / 同一工具失败 N 次 / 幂等工具返回相同结果 N 次）；**任何一次成功清空两个失败计数**；默认 `hard_stop_enabled=False`，只告警不阻断 |
| `error_classifier.py:566-568`、`:653-663`、`:396-425` | 错误分类的实用启发式：大会话上的**裸断连**、或带高 `approx_tokens` 的**通用 400**，大概率是**上下文溢出**；未匹配的 404 保持 `unknown/retryable` 而不是报"模型不存在"；嵌套的 provider 错误体先解包再匹配 |

**一条最重要的契约（来自测试，值得写进你的设计文档）**：
> **传输失败不是模型违约** —— 发送失败**不应该**重跑模型去"修"（`test_onebot_silence_contract.py:574-613`）。
> 你的桥接若把"发送失败"和"模型没产出"混在一个重试里，会出现重复回复。这是很实际的踩坑点。

`test_gateway_routing_durable.py` 也被核实**只测会话路由索引的持久化，不测消息级去重/顺序/重放** —— 消息级至少一次投递在 `delivery_ledger.py`，两者容易被混淆。

---

## 13. 明确不要借鉴 / 风险提示

| # | 事项 | 理由 |
|---|---|---|
| 1 | **"该不该回 / 该不该退出"的整套价值观与判定 prompt** | 与 `src/trigger.mjs:4-20` 明确记录的"触发即必答"产品决策冲突。**照搬会让模型学会沉默，与你的设计自相矛盾** —— 你自己在 `persona.mjs:12-23` 里已经踩过这个坑（"把那部分搬过来反而会让模型以为它可以不回答"） |
| 2 | 8 层记忆 + 外部 memory provider | 见 §10 |
| 3 | 供应商配置向导 / thinking 方言表 / provider 抽象 | DSH 已提供（详见 §11.4）。它的 `ProviderProfile` 抽象本身设计不错，但**你的场景不需要第二套模型配置** |
| 4 | 巨型单文件结构 | `gateway/run.py` 10471 行、`onebot/adapter.py` 4056 行、`semantic_judge.py` 1175 行。你的 `bridge.mjs` 95KB 已在同一条路上，**建议按 §8/§6 拆成 `corpus.mjs` / `channel-prompt.mjs` / `session-state.mjs`** |
| 5 | 双 OneBot 适配器并存 | 你的项目已经避开（废弃包单独标注） |
| 6 | README 声称的"热回复缓存" | 【已核实为不存在】在 `hermes/core/plugins/platforms/onebot/` 全目录检索 `hot_reply / 热回复 / reply_cache / fast_path / ready / warm / prefetch` **均无对应实现**；唯一缓存是"图片/音频路径→描述"的 500 条 FIFO（`adapter.py:366-368`、`:2021-2024`）与**无上限**的 `_voice_transcripts`（`:368`）。`README.md:67` 与 `CHANGELOG.md:76-77` 声称"命中时 agent-ready 即时返回"——**极可能是把 @ 快速通道（`trigger_coordinator.py:153-188`）写成了"缓存"**。**不要按 README 设计** |
| 7 | **一批死代码 / 文档与实现不符** | 见下方 §13.1，照抄前务必以源码为准 |
| 8 | Live2D / Obsidian 知识库 / QZone 发图 | 与你的产品定位无关 |

### 13.1 这个仓库里"看着能用其实没接线"的东西（照抄前必查）

| 项 | 事实 | 依据 |
|---|---|---|
| 图片+文本 2.5s 合并、@ 批量 3.0s 合并 | `_enqueue_image_event` / `_try_merge_text_into_pending_image` / `_flush_image_batch` / `_flush_mention_batch` **零调用点**；`_pending_mentions` 从未被 append。更糟：`_flush_image_batch` 解引用未定义的 `_chat_id`，**一旦被调用会抛 NameError**。活的那份在 `gateway/platforms/onebot/adapter.py:618-939` | `adapter.py:2314`、`:2331`、`:2343-2345`、`:2359`、`:2390`、`:354` |
| `_require_mention` 配置 | 写了但**从未被读取**；@ 门控完全由 TriggerCoordinator 负责 | `adapter.py:340`、`:838-842` |
| `_ws_reconnect_interval` | 读了但**从未用于循环**；重连在网关侧 | `adapter.py:399`、`:828-835` |
| WS echo 关联 | 没有任何代码往 `_pending_echo` 写入；所有 action 走 HTTP | `adapter.py:1081`、`:1142` |
| `_is_duplicate` 的 docstring | 声称 5 分钟 TTL，实际 `_DEDUP_TTL = 30`（秒） | `adapter.py:396`、`:2614-2631` |
| 触发器参数是否可配 | 窗口（1s/5s）、退出倒计时、别名、poke **全是模块常量或 SOUL.md**，不在 config 里；`adapter.py:724-875` 的活配置只有 ws/http/token/reverse_ws_port/reconnect_interval/require_mention/allowed_users/blocked_users/admin_id | 同上 |
| Dashboard 首次配置向导 | `onboarding.html` 会 POST `/api/onboarding/provider\|soul\|onebot\|restart`，但 `server.py` **只实现了 `/api/onboarding/status`**；那批路由在引擎的 FastAPI 里。【推测】网页向导是抄来的 UI，提交路径 404，在部署里**是死的** | `onboarding.html:525-632` vs `server.py:536-537`、`:664-675` |
| 三套并行分发 | `build-installer.iss`（Inno）、`build-installer.nsi`（NSIS）、`build-release.ps1`（手工 zip）；`build-release.ps1:51-52` **不调用任何一个安装器**，只打印"请手动打包"；且两份安装器版本号都是旧的 | `extras/build-*` |
| 空壳目录 | `hermes/extras/scripts/`、`hermes/modules/dashboard/`、`hermes/modules/live2d/`、`hermes/extras/napcat/` 只有 `.gitkeep`，根目录副本才是权威。而 `templates/` 与 `hermes/templates/` **确实分叉**（`config-template.yaml` 6518 vs 6956 字节） | 目录对比 |

> **方法论提醒**：这个仓库代码量大、迭代快（CHANGELOG 537 行），**README/CHANGELOG 是宣传口径、源码才是事实**。上面的"死代码"清单不是否定它，而是说明**借鉴时必须逐条回源码核对** —— 这一点和你分析 `dsh-adapter-qq` 时定的规矩一致。

---

## 14. 落地清单（按 ROI 排序）

1. **`src/corpus.mjs`**：每条群/私聊消息落 `node:sqlite`；FTS5 `trigram` + CJK<3 走 LIKE；返回带 `[mid:]`/`[reply:]`。新增 `qq_search_history` 工具。（照抄 `corpus_history.py` + `adapter.py:473-542`）
2. **投递前终检门**（成本最低、用户可感最强）：`src/extract.mjs` 里补 ①内部泄漏过滤（工具 JSON / 系统占位符 / `/stop` 类注入）②`[reply:ID]` 对语料库的存在性校验 ③剥离 `（…）` 旁白与手写 CQ 码；发送侧多行**逐行 0.6s** 节奏。（照抄 `adapter.py:3732-3765`、`:3791-3931`）
3. **`src/session-state.mjs`**：每个 `(kind, peerId)` 维护 `turn_count / current_thread / open_loops / last_speaker_role / last_bot_moves`；每轮回复后更新（可先用规则/自有小模型，**不一定**要照它再花一次 LLM 调用），下一轮注入提示词。先不上 `should_reply`。
4. **带内标记**：`extract.mjs` 支持 `[reply:id]` / `[sticker:名]`；投递前剥离；纯标记不投递；**标记引起的状态迁移只在投递成功后提交**。（照抄 `adapter.py:162`、`:3547-3557`、`:3574-3582` + `test_onebot_silence_contract.py`）
5. **人设补充**：加"反提示词注入"段（`config-template.yaml:47`）、"被纠正要认"段（`:24`）、"工具调用不限长度"例外（`:26`）、多 bot 互 @ 禁令（`:39`）。同时在 `persona.mjs` 加**机器可读别名表**（`正式名:` / `别名:`），让别名同时供提示词和代码判定使用。
6. **凭据发现加固**（安全项，实际优先级最高）：按 `config_discovery.py` 收紧 SnowLuma 账号/token 发现（仅 loopback、HTTP/WS token 必须一致才采纳、显式 id 绝不回退到别的账号、只读不写、拒符号链接、体积上限）。
7. **可靠性**：`onebot.mjs` 抽纯函数契约层（endpoint 校验 / `(layer, code, retryable)` 分类 / 媒体 20MB 上限 / SSRF 四步式）；补投递幂等键 `sha256(session|msgid|chat|reply|text)[:32]`；断线重连后**显式标记消息缺口**（照抄 `_recover_missed_messages` 的占位思路）。
8. **并发模型对齐**：确认"接入并发、轮次串行"—— 每 `(kind, peerId)` 一把轮次锁 + FIFO + 轮次上限 + `(origin_seq, mode)` 入队去重；补 `decisionEpoch` / 水位（`last_user_seq / last_consumed_seq`）防止"慢回复追上新消息"。
9. **记忆增强**（在现有 `memory.mjs` 上加，不换方案）：未完成轮次不记；每 1 小时蒸馏未汇总会话；`MEMORY.md` 条目加"最后引用时间 + 权重"衰减；纠正用 supersede 保留历史；跨群引用做匿名化 + 冷却。
10. **上下文装配**：把 `bridge.mjs` 里的提示词拼装抽成 `channel-prompt.mjs`，采用显式模式标签 + `[群聊上下文]`（近 20 条带 `[mid:]`）+ `[对话摘要]` + `[对话状态]` 结构，并做总长硬截断。
11. **`config-ui` 补四项**：SSE 日志流、语料/记忆检索端点、账号发现端点（只回摘要、不回密钥）、**启动前置条件门控**（SnowLuma 未登录时给可操作提示，而不是静默失败）。
12. **增长项**：`corpus_pairs`（触发↔回复↔是否被纠正）用于 badcase 回归；`groups_registry.wake_sensitivity` 做每群灵敏度；`qq_emoji_like` / `qq_forward_log` / `qq_forward_msg(note=…)` 补工具箱。
13. **工程卫生**：`bridge.mjs` 拆分（`corpus` / `channel-prompt` / `session-state` / `delivery-gate`）；`RELEASE.md` 的受保护文件清单显式化；升级前备份 + 询问式删除 + 版本号从单一来源读取（别学它的硬编码回退）；补一个 import 漂移审计。
14. **交付语义写进文档**：明确区分**"模型没产出"**与**"发送失败"**两种失败，前者可重试（且只重试一次）、后者**绝不重跑模型**（`test_onebot_silence_contract.py:574-613`）。这是防重复回复的关键。
15. **投递账本（可选，但值得）**：发送前落账、确认后标记；用 `(pid, 进程启动时间)` 做所有权；重复生产者不复活已投递的行；上限与保留期显式化。（照抄 `delivery_ledger.py` 的状态机与两个细节）
16. **输出净化**：流式推理标签清洗（`think_scrubber.py` 的"扣留半截标签 + flush 时宁可丢弃"）；工具循环检测用 `(工具名, 参数哈希)` 身份 + **任何一次成功即清零计数**（`tool_guardrails.py`），默认只告警不阻断。
17. **人设文件当不可信输入**：加"威胁模式 + 不可见 Unicode"整文件拒载，超长做人设的"头+尾+中间提示"截断（`prompt_builder.py:31-73`、`:1284-1321`）。→ 若你将支持导入他人分享的角色卡，这条是必须的。

---

## 15. 证据索引（关键文件）

| 主题 | 文件 | 行 |
|---|---|---|
| 插件声明 | `hermes/core/plugins/platforms/onebot/plugin.yaml` | 1-40 |
| 触发分级 / 窗口 / epoch | `.../trigger_coordinator.py` | 9-17, 138-236, 240-249, 251-377, 379-483, 485-528 |
| 判定 prompt | `.../semantic_judge.py` | 302-456, 683-731, 734-855 |
| 身份装载（名字/别名） | `.../semantic_judge.py` | 118-214 |
| EpisodeState 16 字段 | `.../group_state.py` | 49-135 |
| GroupState / 水位 / 对话态衰减 | `.../group_state.py` | 138-322 |
| 单飞执行器 / 轮次上限 / 契约重试 | `.../group_executor.py` | 13-15, 48-110, 112-190, 199-333, 335-362 |
| corpus 表 / 去重 / 锁 / poke | `.../adapter.py` | 162, 473-542, 2596-2703, 3371-3439 |
| 投递终检门 / 内部泄漏过滤 / 转发展开 | `.../adapter.py` | 254, 1486-1621, 2314-2390（死代码）, 2666-2670, 2816-2926, 3732-3765, 3791-3931 |
| 本地检索 | `hermes/core/corpus_history.py` | 36-39, 64-176, 366-479 |
| 传输契约 / 幂等键 | `.../contract.py`、`.../transport_contract.py` | contract 19-21/295-354；transport 18-90, 117-293, 500-601 |
| NapCat 凭据发现 | `.../config_discovery.py` | 1-9, 56-65, 181-227, 245-335 |
| 记忆体系 | `hermes/core/agent/memory/*`、`hermes/core/run_agent.py`、`gateway/builtin_hooks/memory_maintenance.py` | 见 §10。★ 注意 `run_agent.py` 在 `hermes/core/` 根，不在 `agent/` 下 |
| QQ 工具 | `hermes/core/tools/qq_napcat_tools.py` | 18-19, 44-94, 229-335, 398-593, 619-645, 659-808 |
| 历史检索工具 | `hermes/core/tools/chat_history_search_tool.py` | 42-45, 121-128 |
| 人设与系统提示词 | `templates/config-template.yaml`、`templates/SOUL-template.md` | yaml 1-159；soul 1-37 |
| 人设加载 / 注入扫描 | `hermes/core/agent/prompt_builder.py`、`hermes/core/run_agent.py` | builder 31-73/1284-1321/1455-1493；run_agent 5881-5918 |
| 投递账本 / 轮次租约 / 关闭落盘 | `hermes/core/gateway/delivery_ledger.py`、`turn_lease.py`、`shutdown_flush.py` | ledger 1-11/30-35/62-77/113-140/195-203；lease 1-8/19-63；flush 1-13/31-60 |
| 会话键 / 不活跃策略 / 配对码 | `hermes/core/gateway/session.py`、`gateway/config.py`、`gateway/pairing.py` | session 460-464/598-663/840-876；config 230-232；pairing 8-45 |
| Hooks / 平台注册 | `hermes/core/gateway/hooks.py`、`platform_registry.py` | hooks 9-17/167-232；registry 38-70 |
| 输出净化 / 护栏 / 错误分类 | `hermes/core/agent/think_scrubber.py`、`tool_guardrails.py`、`error_classifier.py` | scrubber 64-223；guardrails 19-78/127-136/347-348；classifier 396-425/566-568/653-663 |
| Provider 抽象（仅供参考） | `hermes/core/providers/base.py`、`plugins/model-providers/*` | base 24-165；README 28-62 |
| 安装/升级 | `install.bat`、`update.bat`、`extras/scripts/upgrade.py`、`CHANGELOG.md`、`UPGRADE.md` | install 1-219；update 1-186；upgrade 31-172/190-299 |
| Dashboard | `modules/dashboard/server.py`、`static/onboarding.html` | server 137-230/299-396/777-792/1399-1485/1551-1587/1635-1742；onboarding 525-632 |
| 打包 | `extras/build-release.ps1`、`build-installer.iss`、`build-installer.nsi` | ps1 12-52；iss 7-110；nsi 24-70 |
| 架构文档 | `hermes/core/website/docs/developer-guide/gateway-internals.md` | 1-262 |
| 契约测试 | `hermes/core/tests/gateway/test_onebot_silence_contract.py`、`test_onebot_transport_contract.py`、`test_onebot_media_ssrf.py`、`test_gateway_inactivity_timeout.py`、`test_async_memory_flush.py`、`test_gateway_routing_durable.py` | 全文（见 §4/§12.3/§12.4） |

---

## 16. 取证口径与不确定项

| 项 | 状态 |
|---|---|
| 本报告所有 `path:line` 引用 | 【源码确证】——直接读取，非文档转述 |
| `README.md` / `CHANGELOG.md` 的功能声明 | **仅作为"作者声称"**；已发现至少 3 处与源码不符（热回复缓存、13 家供应商、`_is_duplicate` 的 5 分钟 TTL 注释），见 §11.4、§13 |
| "13 家供应商" | 文档漂移：`setup_config.py:41-78` 实际 12 条（【源码确证】） |
| `Hermes` 引擎能否在本机跑通 | **未实测**（本报告是纯静态分析，未执行其 `install.bat`/`start.bat`） |
| 死代码是否"真的死" | 【源码确证】调用点为零（全目录 grep）；但**不排除动态调用**（如 `getattr` 字符串派发）——【推测】该风险很低 |
| Node 内置 SQLite 的 FTS5 是否支持 `trigram` 分词器 | 【未实测】需在你的 Node 版本上验证（CPython 侧确认可用，`corpus_history.py:99-105`） |
| `gateway/platforms/onebot/adapter.py` 与 `plugins/platforms/onebot/adapter.py` 的功能差异 | 仅抽样对比（前者 1454 行 / 后者 4056 行）；合并转发与图片合并的"活实现"在前者，**若照抄请以哪个为准需逐个功能确认** |
