# dsh-qq-bot 实施计划（基于 M8 运行时取证）

> ★★ **0.2.5：本文件描述的包 `packages/dsh-qq-bot（废弃）` 已按用户要求删除，本文件随之归档。**
> 现在的实现是 `packages/qq-bridge`（外部进程 + `dsh --profile sdk`）。**不要照着它重建那个包**
> —— 删除是有意的，重建会被 `mocks/verify-legacy-assets.mjs` 判红。

> 状态：**已归档（0.2.5）**。以下是当时的状态记录：运行时事实已由只读探针验证；入口身份（官方 Bot / 个人号）待最终拍板。
> 探针证据：`probe-sdk.mjs`、`.probe-ws/marker.txt`、`marker-outside.txt`
> 取证依据：`docs/design.md`（旧设计，已被本文件取代）、`docs/contracts.md`（M1 契约）、
> `dsh-adapter-qq-技术分析报告.md`（同类实现源码分析）

---

## 0. 结论先行

**旧路径（`ctx.llm.stream` 一次性调用）在技术上无法实现"拥有 DSH 全部功能"**，因为它没有工具循环、
没有沙箱、没有会话、没有权限概念。这是架构选层错误，不是实现不完整。

**正确构造：保留 QQ 桥接，换掉执行引擎。** 由 `dsh --profile sdk` 子进程提供无损的完整 agent 能力，
通过 stdio JSON-RPC 驱动。已由探针验证（见 §2）。

---

## 1. 用户已定决策

| 项 | 决定 |
|---|---|
| 身份 | ~~个人 QQ 号~~ → **已被封号证实不可行**（见 §5），待重选 |
| 权限范围 | **极高权限只限工作区 + 指定管理员** |
| QQ 通道 | 个人号走 NapCat/OneBot 11（违反用户协议，已实证被处置） |

## 2. 运行时事实（探针已验证，2026-09，DSH Desktop 0.9.1 / `@deepseek-ai/dsh@0.1.5-rc.2`）

四项假设全部通过，证据为 `probe-sdk.mjs` 的实跑输出：

| 项 | 结果 | 证据 |
|---|---|---|
| `initialize` 接受 `cwd` | ✅ | 返回 `{"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}` |
| `DSH_PERMISSION_MODE` 被读到 | ✅ | 事件 `sandbox/mode → {"mode":"workspace-write"}` |
| `session/prompt` 产生事件流 | ✅ | `assistant/message` / `tool/call(read)` / `tool/result` / `tool/call(write)` / `turn/end` |
| workspace 边界真实强制 | ✅ | 越界写被拒；`marker-outside.txt` 内容**未被改动** |

**无 answerer 时审批 fail-closed 已实证**（这是本设计的核心安全机制）：

```json
{"type":"approval/policy","data":{"policy":"ask"}}
{"type":"approval/asked","data":{"toolName":"write",
  "reason":"escalate sandbox to danger-full-access: Step 2 explicitly requires creating
            marker-outside.txt one level above the session workspace, which workspace-write mode denied."}}
{"type":"approval/decided","data":{"outcome":"unavailable"}}
```

→ 沙箱拦截 → agent 主动申请提权 → 无人应答 → `unavailable` → **操作被拒且对话不挂死**。

### 关键接口（逐字取证）

```js
// dsh-sdk-jsonrpc-server/lib/index.js:195-202
case "initialize":     return this.initialize(params)   // {cwd, provider, model, reasoningEffort?, maxTokens?}
case "session/prompt": return this.prompt(params)       // {sessionId, contentBlocks} → {messageId}
case "shutdown":       return this.shutdown()

// 服务端→客户端通知（:68-103）
"session.event" | "session.status" | "subagent.started" | "subagent.finished"
```

### 必须记住的硬约束

1. **workspace 边界在进程启动时固定**：`workspace-write` 的根来自 `initialize.cwd`，
   `sessionId` 只是会话键，**不能**为单个会话换 cwd。→ cwd 必须是专用干净目录，
   绝不能是项目根或盘符根。
2. **agent preset 开轮即锁死**：`dsh-agent-presets:1744` 明文
   `"session ... has already started; its agent preset is fixed"`。per-会话差异化 preset
   必须走不同会话或不同进程。
3. **`permissionPreset` 只有宿主/webhook 路径能设**；ACP 不能（configOptions 只有 model/reasoning）。
4. **subagent 默认继承 `approval: never`**（`dsh-subagent:569`）——派生子代理会绕开审批闸门，
   必须在 preset 层禁用 subagent 工具。
5. **`dsh --profile sdk` 里没有 `webServer`**（`dsh-sdk-app/cordis.patch.yml` 全文 22 行，
   仅 insert `sdk-app-startup` + `sdk-jsonrpc-server`）→ 一切通信只能走 stdio 或**出站** HTTP。
6. **`sdk-minimal` ≠ `sdk`**：前者把 `danger-full-access` 写死，与"限于工作区"相反，**禁用**。
7. **沙箱不限命令**：`workspace-write` 约束的是**文件路径**，`pwsh`/`bash` 在工作区内
   执行任意命令、发起网络请求仍可行。命令层的防线只有"谁能触发"（管理员白名单）。

## 3. 目标架构

```
QQ ──OneBot11──> dsh-qq-bot（传输/触发/白名单/人设，纯 I/O）
                      │ stdio JSON-RPC：initialize / session/prompt / session.event
                      ▼
          dsh --profile sdk   ← 长驻子进程，官方 runtime，全量工具
          cwd = <专用工作区>      DSH_PERMISSION_MODE=workspace-write
```

- **单进程即可**：既然只允许管理员使用，一个 sdk 子进程 + 按会话键区分 `sessionId` 足够。
- **会话键**：`u:<qq>` / `g:<group>` → 映射到稳定的 `sessionId`，重启后由官方持久化恢复。
- **回程**：订阅 `session.event`，取 `assistant/message`（文本 + `usage`）、`tool/call`、
  `tool/result`、`turn/end`。
- **用量**：`assistant/message` 事件自带 `usage`（`dsh-token-meter:391` 的 `usageOf`），
  字段 `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens`，现有 `usage_events` 表可直接复用。

## 4. 待确认：QQ 入口身份（阻塞项）

个人号路径已被实证处置（§5），必须重选：

| 方案 | 权限能力 | 账号风险 | 群聊 | 备注 |
|---|---|---|---|---|
| **A. 官方 QQ Bot**（`tencent-connect/dsh-qqbot`） | 全量（`ctx.agents` + 扫码 + 审批按钮） | **无**（合规） | 仅机器人被拉入的群/频道 | 本机 0.1.5-rc.2 满足其 peer 要求（≥0.1.0-rc.6） |
| **B. 个人号 + NapCat 降频化** | 全量（本计划 §3） | **高，已实证** | 任意群 | 拿账号赌博，不推荐 |
| **C. 混合**：官方 Bot 主力 + 个人号仅管理员私聊极低频 | 全量 | 中 | 私聊可控 | 需另备未被处置的号 |

**注**：§2 的运行时事实与 §3 的架构**与身份选择无关**——官方插件走的也是同一个 agent loop
（`ctx.agents`）。所以无论选 A/B/C，执行引擎部分都是同一套。

## 5. 个人号被处置（风险记录）

- **现象**：个人 QQ 号被处置/封禁，触发层未定位（行为层 / 协议层 / 环境层三者之一，无法通过改配置规避）。
- **根因判断**：行为层最可疑——旧插件是"每条必回 + 随机命中 + 唤醒窗口"的**全自动**模式
  （秒回、7×24 在线、固定句式），这是行为风控的典型特征向量。
- **定性**：个人号 + NapCat/OneBot **天生违反《QQ 用户协议》**，属于结构性风险，不是配置问题。
- **教训**：本风险在前期讨论中被当作"取舍项"轻描淡写，应当作"判定项"。

## 6. 分步计划（身份确定后执行）

### 阶段 0：入口落地
- 若选 A：`dsh plugin --profile web add @tencent-connect/dsh-qqbot`（或独立 profile + 扫码绑定），
  不再动 `packages/dsh-qq-bot`。
- 若选 B/C：走阶段 1–5。

### 阶段 1：sdk 进程封装（新增 `packages/dsh-qq-bot/src/sdk-runtime.ts`）
- 启动 `dsh --profile sdk` 子进程，`cwd` = 专用工作区，env 注入 `DSH_PERMISSION_MODE=workspace-write`。
- 实现 JSONL 帧收发（参照 `probe-sdk.mjs` 的 `rpc()`），`initialize` → `session/prompt` → 订阅 `session.event`。
- 崩溃/断线自动重启 + 会话恢复；子进程退出时 fail-loud 记录。

### 阶段 2：替换回复引擎（重写 `src/reply.ts`）
- 删除 `ctx.llm.stream` 调用链，改为 `session/prompt`。
- `assistant/message` → QQ 发送；`usage` → `usage_events`。
- 保留 `thinking` 采集（来自事件流而非 `reasoning-delta`）。

### 阶段 3：记忆降级（改造 `src/memory.ts`）
- agent 自带 compaction / session 持久化 / resume → 删掉自研衰减、软删、strength 模型。
- 仅保留"人设 + 群友印象"薄层，作为 prompt 前缀注入。

### 阶段 4：权限与准入（改 `src/index.ts`）
- **新增 `adminUsers: string[]`**（当前只有会话级 `chat_allowlist`，无管理员概念）。
- 准入规则：`workspace-write` 权限**仅管理员**可触发；非管理员走纯对话或直接拒绝。
- preset 层禁用 subagent 工具（§2 约束 4）。
- 出站敏感审计（防密钥/路径泄露到群）。

### 阶段 5：联调与验收
- 验收：管理员私聊可读写工作区文件、可执行 pwsh、可多轮续聊。
- 验收：越界写被拒且不挂死（复现 `approval/decided → unavailable`）。
- 验收：非管理员无法触达 workspace-write 会话。
- 验收：重启 DSH 后会话可恢复。

## 7. 未验证项（实现时必须实测，不得假设）

1. **多人多会话并发**：探针只跑了单会话，`session/prompt` 的并发语义未验证。
2. **多轮续聊**：同一 `sessionId` 第二次 `prompt` 是否保留上下文，未验证。
3. **agent preset 挂载**：探针未设 preset（走的默认），`agentPresets` 在 sdk profile 下如何生效未验证。
4. **QQ 端全链路**：探针是假 QQ，真实 OneBot 收发未联调。
5. **网络出口策略**：`workspace-write` 是否限制网络请求，未取证。

## 8. 探针产物处置

- `probe-sdk.mjs` + `.probe-ws/marker.txt` + `marker-outside.txt`：**保留**，
  作为阶段 1/2 的回归基线（重跑应得到同样的四个 ✅ 与 `unavailable`）。
