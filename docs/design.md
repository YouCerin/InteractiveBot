# dsh-qq-bot 设计文档

> 状态：设计定稿（待实现）。本文件是实现的唯一依据，改动先改这里。

## 0. 已定决策

| 项 | 决定 |
|---|---|
| 回复模式 | **触发式自动回复**（关键词/被@/私聊/随机，各自可配）+ **群聊唤醒窗口**（每个唤醒者独立记录，话题切换或连续 N 条未提及即结束）+ 手动补回复覆盖。**私聊永远回复，不进入唤醒态** |
| 记忆形态 | **纯摘要**（无向量检索） |
| 群友印象 | **按 QQ 号跨群存在**（`u:<qq>`，不按群隔离） |
| 群聊记忆 | 记录「群内经常讨论什么主题」 |
| 遗忘 | **软删**（移入归档表，可追溯） |
| 记忆抽取 | **批量**（攒 N 条 / 定时触发），**LLM 抽取、复用回复所用模型** |
| 记忆参数进 Config | `half_life`、`boost`、`forget_threshold`、注入 top-K、注入 token 预算；其余写死 |
| 用量 | 从补回复的 `usage` chunk 直接捕获 `TokenUsage`（DSH 标准）；不显示搜索次数（一次性调用无工具循环） |
| 数据存放 | **SQLite** |
| 实例 | **单实例** |

## 1. 架构总览

```
                 QQ 协议端(NapCat/Lagrange, OneBot 11)
                          │  正向 WebSocket
                          ▼
                 ┌─────────────────────────────┐
                 │   OneBot11Client（已实现）    │
                 │   连接/鉴权/echo/事件/重连     │
                 └──────────────┬──────────────┘
                                │ 消息事件
                                ▼
   ┌────────────────────────────────────────────────────────────┐
   │  host 侧服务                                                │
   │   MessageBuffer ──► Store(SQLite) ──► MemoryService         │
   │        │                  ▲              │ (抽取/衰减/软删/注入)
   │        │                  │              ▼                  │
   │        │            ReplyTrigger + ReplyService              │
   │        │            (触发决策 → 生成回复)                         │
   │        │                  │ 调 dsh-llm（捕获 thinking）       │
   │        │                  │ 读 dsh telemetry ──► UsageStore │
   │        └──── 工具 / HTTP 路由（供 agent 与 UI）              │
   └────────────────────────────────────────────────────────────┘
                          ▲                    ▲
                 tools（agent 调用）    HTTP routes（client UI 轮询）
                          │                    │
                 ┌────────┴────────────────────┴────────┐
                 │  client 独立面板（shell.overlay）      │
                 │  会话终端 / 记忆 / 用量 / 设置          │
                 └───────────────────────────────────────┘
```

- **host 侧**：连接、触发决策、回复、存储、记忆、用量采集、工具、路由。
- **client 侧**：只读+操作的独立面板，数据经 HTTP 路由获取（轮询 + `no-store`）。
- **SQLite**：唯一持久化介质；白名单等运行时可变数据也放库，静态设置走 `Config`。

## 2. 端到端数据流

### 流程 A：触发式自动回复（+ 手动覆盖）

```
QQ用户 ─► 协议端 ─► OneBot11Client ─► 入缓冲 + Store.messages(role=user)
                                            │
                             ReplyTrigger 决策（每条消息）:
                               0. 白名单校验（若开启）
                               1. 私聊（private.enabled）→ 必然回复，不进入唤醒态
                               2. 群聊 → 按「唤醒者」逐一判定（wakers: conv → (QQ → 窗口)）:
                                  a. 该成员已在唤醒中:
                                     · 本条为明确激活(@/关键词) → 必然回复，刷新话题与计数
                                     · 否则先判话题:
                                        - 离题 → 结束该成员窗口，不回复
                                        - 连续 silentLimit 条未提及 bot → 结束窗口，不回复
                                        - 单窗口回复数超 maxReplies → 结束窗口，不回复
                                        - 同题且未超限 → 回复，silent+1
                                  b. 该成员未唤醒，且本条为明确激活 → 新建独立窗口 + 回复
                                  c. 随机命中 → 只回这一条，不建立窗口
                                  d. 均不满足 → 不回复（仅记录）
                                 ※ 多个唤醒者并存、互不影响；旁人触发只新建自己的窗口
                                 ※ 唤醒窗口仅群聊有效（sustain.enabled=false 时退化为只回触发句）
                                            │ 触发
                                            ▼
                             ReplyService.replyOnce(conv_id):
                               1. 取消息窗口 + 注入记忆（群画像 + topK 印象）
                               2. 人设 + 记忆组 prompt → 调 dsh-llm（捕获 thinking）
                               3. 落库(bot+thinking) → OneBot 发送 → 读 usage chunk → usage_events

[手动覆盖] 会话终端【补一次回复】按钮 ─► 直接 replyOnce（跳过触发条件）
```

### 流程 B：记忆生命周期

```
[批量抽取] 每 batchIntervalMin 或攒 batchSize 条触发:
  Store.messages 取新消息 ─► LLM 抽取 (topic, summary) 候选
    ├─ 命中已有 topic ─► 强化: strength=min(1, s·decay(Δt)+boost), mention_count+1
    └─ 新 topic      ─► 新增: strength=initial
  群级: 聚合常聊主题 ─► 更新 group_profiles.summary

[衰减] 定时触发:
  所有 memories: s ← s · exp(-Δt / half_life)
  s < forget_threshold ─► 软删: 移入 memory_archive(reason='decayed')
```

**强度模型**（一条公式覆盖全部四点）：

```
衰减：s ← s · exp(-Δt / half_life)          # 超时遗忘
强化：s ← min(1, s·exp(-Δt/half_life) + boost)  # 反复提及加强
遗忘：s < forget_threshold ─► 软删
近期：Δt 越小衰减越弱（刚提过几乎不减）
```

### 流程 C：用量

```
补回复完成 ─► 从 llm.stream 的 usage chunk 捕获 TokenUsage
           ─► Store.usage_events(input/output token, cache_hit, model, conv_id, cost)
UI 面板 ─► 按 天/周期/会话/模型 聚合展示（不含搜索次数）
```

## 3. 数据模型（SQLite）

```sql
-- 会话与消息（会话终端展示历史/思考，支持删除）
conversations(
  id         TEXT PRIMARY KEY,   -- 'g:<group_id>' | 'u:<user_id>'
  kind       TEXT NOT NULL,      -- 'group' | 'private'
  title      TEXT,               -- 群名/昵称
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

messages(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id    TEXT NOT NULL REFERENCES conversations(id),
  role       TEXT NOT NULL,      -- 'user' | 'bot'
  user_id    INTEGER,            -- user 消息的 QQ 号
  content    TEXT NOT NULL,
  thinking   TEXT,               -- 思考内容（补回复时记录）
  message_id INTEGER,            -- OneBot message_id
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_conv ON messages(conv_id, id);

-- 活跃记忆（群友印象 scope='member' key='u:<qq>'；群聊记忆 scope='group' key='g:<gid>'）
memories(
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  scope             TEXT NOT NULL,        -- 'member' | 'group'
  scope_key         TEXT NOT NULL,        -- 'u:<qq>' | 'g:<group_id>'
  topic             TEXT NOT NULL,
  summary           TEXT NOT NULL,
  strength          REAL NOT NULL,        -- [0,1]
  mention_count     INTEGER NOT NULL DEFAULT 0,
  first_seen_at     INTEGER NOT NULL,
  last_mentioned_at INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_memories_scope ON memories(scope_key, strength DESC);

-- 记忆归档（软删，可追溯）
memory_archive(
  id                INTEGER PRIMARY KEY,
  scope             TEXT NOT NULL,
  scope_key         TEXT NOT NULL,
  topic             TEXT NOT NULL,
  summary           TEXT NOT NULL,
  strength          REAL,
  mention_count     INTEGER,
  first_seen_at     INTEGER,
  last_mentioned_at INTEGER,
  archived_at       INTEGER NOT NULL,
  reason            TEXT NOT NULL         -- 'decayed' | 'manual'
);

-- 群聊画像（"群常聊什么"，聚合后快速注入）
group_profiles(
  group_id   INTEGER PRIMARY KEY,
  summary    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 聊天白名单（运行时可变）
chat_allowlist(
  key     TEXT PRIMARY KEY,    -- 'g:<group_id>' | 'u:<user_id>'
  kind    TEXT NOT NULL,       -- 'group' | 'user'
  enabled INTEGER NOT NULL DEFAULT 1,
  note    TEXT
);

-- 用量（从补回复的 usage chunk 落库，供面板聚合）
usage_events(
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  conv_id       TEXT,          -- 可空（非 bot 触发的会话）
  model         TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cache_hit     INTEGER,       -- 命中 token 数或 0/1
  cost          REAL,
  raw           TEXT           -- telemetry 原始 JSON（可追溯）
);
CREATE INDEX idx_usage_ts ON usage_events(ts);
```

## 4. Config（进 cordis.patch.yml / 设置面板）

```ts
interface Config {
  // 连接（已有）
  enabled: boolean
  endpoint: string
  accessToken: string
  selfId: string
  commandPrefix: string          // 兼容：前缀式触发（可并入 replyTrigger.keyword）
  // 回复触发（各自可独立开关）
  replyTrigger: {
    keyword: { enabled: boolean, keywords: string[] }   // 关键词
    mention: { enabled: boolean }                       // 被@（群内）
    private: { enabled: boolean }                       // 私聊（always）
    random:  { enabled: boolean, probability: number }  // 随机 0~1
  }
  // 群聊唤醒窗口（私聊不适用）
  sustain: {
    enabled: boolean
    silentLimit: number            // 连续多少条未 @/未命中关键词后结束该唤醒者窗口（默认 3）
    maxReplies: number             // 单窗口最多自动回复次数，防刷屏（默认 20）
  }
  // 人设
  persona: string
  // 回复模型
  modelProvider: string
  model: string
  // 活跃设置
  activeHours: string          // 例 "00:00-23:59"
  // 数据位置
  dataDir: string              // SQLite 文件目录（默认 workspace 下）
  // 记忆参数（遵循建议：仅这些进 Config，其余写死）
  memory: {
    halfLifeDays: number       // 半衰期
    boost: number              // 单次强化量
    forgetThreshold: number    // 遗忘阈值
    injectTopK: number         // 注入 top-K
    injectMaxTokens: number    // 注入 token 预算
  }
  allowlistEnabled: boolean
}
```

> 写死的常量：`initial_strength`、`batch_size`、`batch_interval_min`、衰减任务周期、
> `memories` 表 top-K 排序等，放在 `src/constants.ts`。
>
> 唤醒窗口（`wakers: conv_id → (QQ → { wakeTopic, silent, replies, lastAt })`）单实例先存内存 Map，重启即重置；
> 同一群可有多个唤醒者并存、各自独立结束；超过 30 分钟无活动的窗口在收到下一条群消息时清理。
> 「明确激活」= 被@ 或 命中 `replyTrigger.keyword`（复用同一判定）；**随机命中不算激活，也不建立窗口**。
> 「被@」判定依赖 `self_id`，由连接时 `get_login_info` 解析得到（已实现）。
> 每次建立/刷新窗口时对唤醒上下文生成一句 `wakeTopic`，之后唤醒者每条非激活消息额外一次轻量 LLM「同题判断」；有额外 token 成本。
> 私聊不判定唤醒，`private.enabled` 打开时每条都回。

## 5. 宿主工具（agent 调用）

| 工具 | 用途 | 状态 |
|---|---|---|
| `qq_bot_status` | 连接状态/缓冲数 | 已实现 |
| `qq_bot_send_group_message` | 发群消息 | 已实现 |
| `qq_bot_send_private_message` | 发私聊消息 | 已实现 |
| `qq_bot_get_recent_messages` | 拉取缓冲消息 | 已实现（后续改读 DB） |
| `qq_bot_reply` | **手动补一次回复**（覆盖触发条件，参数 conv_id） | 待实现 |
| `qq_bot_list_conversations` | 列会话 | 待实现 |
| `qq_bot_get_conversation` | 查会话历史（含思考） | 待实现 |
| `qq_bot_delete_message` | 删除消息 | 待实现 |
| `qq_bot_list_memories` | 查记忆（按 scope_key） | 待实现 |
| `qq_bot_forget_memory` | 手动遗忘某条记忆（软删） | 待实现 |
| `qq_bot_get_usage` | 查用量聚合 | 待实现 |

## 6. HTTP 路由（client UI 轮询/操作）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/plugins/qq-bot/status` | 连接状态 |
| GET | `/plugins/qq-bot/conversations` | 会话列表 |
| GET | `/plugins/qq-bot/conversations/:id` | 会话消息流（含思考） |
| POST | `/plugins/qq-bot/conversations/:id/reply` | **补一次回复** |
| POST | `/plugins/qq-bot/conversations/:id/clear` | 删除会话记录 |
| GET | `/plugins/qq-bot/memories?scope_key=` | 记忆列表 |
| POST | `/plugins/qq-bot/memories/:id/forget` | 手动遗忘 |
| GET | `/plugins/qq-bot/usage?group_by=` | 用量聚合 |

> 全部 `cache: no-store`，静态资源白名单，未知资源 404。

## 7. 独立 UI 面板（shell.overlay）

Tabs：
1. **会话终端**：会话列表（群/私聊）→ 消息流（user/bot 气泡，思考内容可折叠，单条删除，【补一次回复】按钮，清空会话）。
2. **记忆**：按群/群友查看印象条目，strength 可视化，手动遗忘按钮，归档查看。
3. **用量**：图表（按天/周期/会话/模型），成本/调用/token/缓存命中率（不显示搜索次数）。
4. **设置**：展示 Config（或引导到 DSH 设置 UI）+ 白名单编辑。

## 8. 待取证项（实现前需探明 DSH 接口，只读取证不改代码）

1. `dsh-llm`：如何发起一次 completion / 如何拿到 `reasoning_content`（思考）。
2. 用量：直接读补回复 `usage` chunk 的 `TokenUsage`（M1 已证，一次性调用不经过会话投影）。
3. `dsh-host-webserver`：`register({kind, path, handler})` 的精确类型（指南 §2.4 已给轮廓）。
4. client `shell.overlay` slot 注册（指南 §3.4 已给轮廓，按目标版本 slots.ts 复核）。
5. SQLite 驱动：`node:sqlite`（Node 24 内置）是否可用，否则 `better-sqlite3`（需原生编译）。

## 9. 目录结构（目标）

```
packages/dsh-qq-bot/
├── package.json
├── cordis.patch.yml
├── tsconfig.json / tsconfig.client.json
├── src/
│   ├── index.ts          # 装配：服务、工具、路由、生命周期
│   ├── onebot.ts         # 已实现：连接层
│   ├── constants.ts      # 写死常量
│   ├── store.ts          # SQLite 访问层
│   ├── memory.ts         # 记忆：批量抽取/衰减/软删/注入
│   ├── reply.ts          # 补一次回复
│   ├── usage.ts          # 用量采集
│   ├── routes.ts         # HTTP 路由
│   └── client/
│       ├── index.tsx     # 独立面板入口（shell.overlay）
│       ├── terminal.tsx
│       ├── memory.tsx
│       ├── usage.tsx
│       └── settings.tsx
└── assets/
```

## 10. 分阶段实现计划

1. **M1 取证**：探明 §8 的 5 个接口，产出契约笔记。
2. **M2 存储 + 消息流**：`store.ts` + `MessageBuffer→DB` + 会话/消息工具与路由。
3. **M3 补回复**：`reply.ts`（人设 + 记忆注入 + dsh-llm + thinking + 发送）+ 用量采集。
4. **M4 记忆**：`memory.ts`（批量抽取 + 衰减 + 软删 + 注入）。
5. **M5 独立 UI**：client 面板四 tab + 路由对接。
6. **M6 联调**：协议端部署 + `dsh plugin add` + 真实群/私聊验证。

## 11. M7 修复与对话白名单

### 11.1 「bot 不回复」根因

现场日志只有一行：

```
[qq-bot] reply failed: qq-bot: reply failed (error)
```

收到私聊消息后 **21ms** 即失败（不是网络超时），说明是**立即失败**：`ctx.llm.stream` 的终止 chunk 为
`{ type:'finish', reason:{ kind:'error', failure } }`。

根因是**模型目标非法**：

| 项 | 原配置 | 实际可用 |
| --- | --- | --- |
| provider | `deepseek` | `deepseek-official`（`dsh-llm-deepseek` 中 `const PROVIDER`） |
| model | `deepseek-chat` | `deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-pro` |

`LlmRuntime.registration(provider)` 对未知 provider 直接抛
`LlmError('no adapter registered for provider "…"', 'NO_ADAPTER')`，被转成终止 chunk，
因此表现成「连上了但从不回复」。

修复：

1. 默认值改为 `deepseek-official` / `deepseek-flash`。
2. `ensureTarget()` 在首次回复前用 `ctx.llm.listProviders()` / `listModels()` **校验并回退**，
   结果写回 `memoryOptions` / `replyOptions`（服务每次调用都读这两个对象，故即时生效），
   因此历史 `config.json` 里的非法值也能自愈。
3. `reply.ts` 不再吞掉原因：把 `reason.failure.code` / `.message` 拼进错误信息。
4. 新增内存环形缓冲**活动日志** + `/activity` 路由 + 「诊断」页签，直接回答「为什么没回复」。
5. `/config` POST 现在把校验结果**写回运行中的 `config`**（此前只落盘不生效），并返回
   `restartRequired`；`endpoint` / `accessToken` / `selfId` / `dataDir` 仍需重启。

### 11.2 对话白名单

按**会话粒度**生效：`g:<群号>` 或 `u:<QQ号>`，勾选一个群即允许该群全部成员触发。

- 数据：复用 `chat_allowlist(key, kind, enabled, note)`，`Store.replaceAllowlist()` 事务性整体替换。
- 来源：`get_friend_list` / `get_group_list`（OneBot 11），新增 `OneBot11Client.getFriendList()` /
  `getGroupList()`；登录后用 `get_login_info` 缓存自身账号并**从好友列表中剔除自己**。
- 拦截：`handleMessage` 在落库后、触发判定前执行 `isAllowed(convId)`，命中即记为「白名单拦截」。
- 接口：`GET /friends`、`GET /groups`、`GET|POST /allowlist`（POST 同时可切换 `allowlistEnabled`）。
- UI：「白名单」页签，好友 / 群两列复选 + 全选 / 清空 + 保存，并显示不在好友群列表中的历史已选项。

### 11.3 唤醒逻辑重写（唤醒仅群聊 · 多唤醒者）

旧逻辑有两个问题：唤醒态对**私聊也生效**（私聊本就每条必回，唤醒窗口纯属多余），且计数是**整会话共享**的
（群里别人刷屏会把额度烧光）。重写后：

| 规则 | 实现 |
| --- | --- |
| 唤醒仅群聊 | `handleMessage` 先判私聊：`private.enabled` → 直接回复并 `return`，不触碰 `wakers` |
| 多唤醒者并存 | `wakers: Map<convId, Map<QQ, WakerState>>`，每人一条 `{ wakeTopic, silent, replies, lastAt }` |
| 唤醒期间必然回复唤醒者 | 唤醒者消息走「话题判定」而非触发判定，同题即回复 |
| 话题切换即停止 | `judgeSameTopic(wakeTopic, text)` 为假 → 删除该窗口且**不回复** |
| 连续 3 条未提及即停止 | `silent` 计该唤醒者连续「未 @、未命中关键词」的条数，达 `silentLimit` 删除窗口且不回复 |
| 明确激活可续命 | 唤醒者再次 @/命中关键词 → 必然回复，刷新 `wakeTopic` 并清零 `silent` |
| 旁人不受影响 | 旁人触发只新建**自己**的窗口；已存在的唤醒者状态不变 |
| 随机不建立窗口 | 随机命中只回当前这一条（随机不是「激活」） |
| 防刷屏 | 单窗口回复数超 `maxReplies` 强制结束；30 分钟无活动窗口在下次群消息时清理 |
| 配置简化 | 删除 `sustain.mode` / `maxMessages`，改为 `silentLimit`（默认 3）+ `maxReplies`（默认 20）；`enabled=false` 退化为只回触发那一条 |

### 11.4 部署注意

插件是 `link:` 安装，`npm run build` 后**宿主进程仍跑旧代码**（该 profile 无 host 侧 HMR），
必须重启 DSH 桌面端；客户端 bundle 随之更新，浏览器需刷新页面。

