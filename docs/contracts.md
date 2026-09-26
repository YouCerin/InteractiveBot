# M1 取证：DSH 接口契约笔记

> 只读取证产物，实现时以此为准。取证日期：本次会话。
> 目标 runtime：`@deepseek-ai/dsh@0.1.5-rc.2`（dsh-desktop 0.9.1 内嵌）。

## 0. 版本与来源（重要）

- **桌面 runtime = 0.1.5-rc.2**：`D:\DeepSeekHarness\DSH Desktop\resources\app\node_modules\@deepseek-ai\*`
  —— 生产构建，`.d.ts` 已剥离，只有 `.js`（带 JSDoc，可读）。
- **插件 node_modules = 0.1.5-rc.3**：`packages/dsh-qq-bot/node_modules\@deepseek-ai\*`
  —— `^0.1.5-rc.2` 范围解析到了 rc.3，带完整 `.d.ts`。
- **结论**：以桌面 rc.2 的 `.js` 为运行时准绳，rc.3 的 `.d.ts` 作类型参考；实现时如遇差异，优先对齐 rc.2。可考虑把插件 devDeps 精确锁到 `0.1.5-rc.2`（若 npm 有该 tag）。

---

## 1. LLM 补回复（`@deepseek-ai/dsh-llm`）

### 服务与调用

- `llm` 服务挂在 `ctx.llm`（`declare module '@deepseek-ai/cordis' { interface Context { llm: LlmRuntime } }`）。
- 发起一次模型调用：

```ts
const stream = ctx.llm.stream({
  provider: 'deepseek',          // 已注册的 provider 路由
  model: 'deepseek-chat',        // 精确 model id
  system: persona,               // 一次性调用：系统提示（字符串，适配器映射到 system 槽）
  messages: [ /* Message[] */ ],
  reasoningEffort,               // 可选
  signal,                        // 可选 AbortSignal
})
// stream: AsyncIterable<StreamChunk>
```

### `GenerateOptions` 关键字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `provider` | string | 选择适配器的 provider 路由（必填） |
| `model` | string | 精确 model id（必填） |
| `system` | string? | **一次性调用**的系统提示；loop 调用留空 |
| `messages` | Message[] | 有序对话消息（必填） |
| `reasoningEffort` | ReasoningEffortId? | 推理力度 |
| `temperature` / `maxTokens` / `stop` / `signal` / `sessionId` / `purpose` | — | 可选 |

### `StreamChunk`（流式协议，消费时按 type 分支）

```
block-start / text-delta / reasoning-delta / tool-call-delta /
block-end / usage / finish
```

- **可见文本** = 累积 `text-delta.text`（同一 `index` 串接）。
- **思考内容** = 累积 `reasoning-delta.text`（同一 `index` 串接）；对应 `ReasoningBlock { type:'reasoning', text }`。
- **用量** = `usage` chunk 的 `TokenUsage`。
- **结束** = `finish` chunk 的 `FinishReason`（`stop`/`tool-calls`/`max-tokens`/`aborted`/`error`）。

### `TokenUsage`（用量/缓存命中，直接来自 usage chunk）

```ts
interface TokenUsage {
  inputTokens: number          // 未命中缓存的输入
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number     // 读缓存命中
  cacheWriteTokens?: number    // 写缓存
  reasoningTokens?: number     // 思考 token
}
// 计费输入 = inputTokens + cacheReadTokens + cacheWriteTokens
// 缓存命中率 = cacheReadTokens / 计费输入
```

### 消息构造（从 `@deepseek-ai/dsh-llm` 根导出）

```ts
import { createUserMessage, createAssistantMessage, createSystemMessage } from '@deepseek-ai/dsh-llm'

createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
createAssistantMessage({ content: [...], source: { provider, model } })
createSystemMessage(persona, 'qq-bot')   // 或直接用 GenerateOptions.system
```

- `Message = { id, role: 'system'|'user'|'assistant', content: ContentBlock[], source }`。
- 文本块 `{ type:'text', text }`；思考块 `{ type:'reasoning', text }`。

### 补回复完整流程（M3 用）

1. 插件 `inject: ['llm', 'tools']`（或在 `reply` 里 `ctx.get('llm')`）。
2. `ctx.llm.stream({ provider, model, system: persona, messages: [history..., createUserMessage(newest)] })`。
3. 消费流：累积 `text-delta`→回复文本、`reasoning-delta`→思考、`usage`→TokenUsage、`finish`→结束原因。
4. 思考内容是否为 `reasoning` 取决于模型（DeepSeek reasoner 会产出）。

### ⚠️ 限制

- **一次性 `llm.stream` 无工具循环**：搜索次数、工具调用次数**无法**从这次调用拿到。若要"搜索次数"，补回复须升级为完整 agent turn（subagent），或另计。这是设计里"用量→搜索次数"的一个真实缺口，需决策。

---

## 2. 用量（token-meter / session-stats / telemetry）

| 包 | 形态 | 服务键 / 名称 | 作用 |
|---|---|---|---|
| `dsh-token-meter` | Service | `tokenMeter` | 注册**会话投影**（tokenUsage/contextPressure/contextBreakdown），从 `assistant/message` 事件读 usage 投影每会话 token |
| `dsh-session-stats` | 函数插件 | `session-stats` | 注册 `sessionStatsProjectionDefinition`，从事件读 outputTokens 等聚合 |
| `dsh-session-telemetry` | Service | `sessionTelemetry` | OTel 采集/导出协调器，**不是**读用量 API |

**关键结论**：

- token-meter / session-stats 是**会话投影**，针对"会话内 agent 循环"的事件流计算；**补回复的一次性 `llm.stream` 不产生 `assistant/message` 事件，不会被它们统计**。
- 因此插件自己的用量应**直接从补回复的 `usage` chunk 捕获**（TokenUsage 词汇表 = DSH 标准），落 SQLite。
- 调用次数 = 插件自计（补回复次数）；**搜索次数** = 一次性调用无此数据（见 §1 限制）。

---

## 3. HTTP 路由（`@deepseek-ai/dsh-host-webserver`）

- **服务键 `webServer`**（rc.2；`super(ctx, "webServer")` 已确认，无 httpServer 回退必要）。
- 路由注册（返回 disposer，重复 `(kind,path)` 抛错）：

```ts
const web = ctx.get('webServer')
ctx.effect(() => web.register({
  kind: 'exact',                 // 或 'prefix'
  path: '/plugins/qq-bot/status',
  handler: async (req, res) => { // node:http 语义
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ... }))
  },
}))
```

- 另有 `registerUpgrade(route)`（WS 升级）、`registerFallback(handler)`（SPA 兜底）。
- 静态资源路由务必白名单 + `decodeURIComponent` try 包裹；未知资源 404。

---

## 4. 客户端 slot（独立面板）

### 客户端模块系统（`dsh-client-modules`）

- `package.json` 客户端声明（rc.2）：

```jsonc
"dsh": {
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/..."],   // 预加载元数据（可选）
    "external": ["..."],              // 模块外部化（可选）
    "immediately": false              // 启动即预取（可选）
  }
}
"exports": { "./client": { "types": "...", "default": "./lib/client.js" } }
```

- 客户端 bundle 是 CJS closure 工厂：`window.__ModuleLoader__.load({ id, factory(require){...return module.exports} })`。
- 客户端包导出 = 一个 cordis 插件模块（`inject` + `apply(ctx)`）。

### ⚠️ rc.2 无 `@deepseek-ai/dsh-client-runtime`

旧指南的 `@deepseek-ai/dsh-client-runtime/client` 在 rc.2 **不存在**。客户端运行时是：

- **`@deepseek-ai/dsh-cordis-client-runner`**（exports `./client`，types `lib/types/client/index.d.ts`）。

### `shell.overlay` 全局浮层（权威契约，来自 cordis-client-runner 内置文档）

- 类型：`list`，scope `root`，frame 级浮层、位于所有列之上、**默认点击穿透**（entry 主动开 pointer-events 才拦截）。
- **`root` 单槽被 AppFrame 占用，绝不要注册**（会整体顶掉框架）。
- 注册示例（官方内嵌文档原文）：

```tsx
export const inject = ['slots']
export function apply(ctx) {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'my-entry', order: 100, label: 'My entry' },
    () => <div>hello</div>,
  ))
}
```

- `register` options：`id`（必填，string，你的 cell key，新 id 并列新增、复用官方 id 会替换）、`order`（number，升序）、`label`（string | ()=>string）。
- 面板用 `ctx.sessions`、`useSessions` 等 standard props（`useResource`/`useSessions`/`useWorkspaces`/`usePanelInfo`）。

### 待 M5 落实的类型导入

客户端 `ctx` 是 cordis `Context` + 客户端包 augmentation。实现时安装以下包的 `.d.ts` 再确认精确 import：

- `@deepseek-ai/dsh-cordis-client-runner`（`/client`）
- `@deepseek-ai/dsh-client-ui-layout`（`/client`，声明 `shell.overlay`）
- `@deepseek-ai/dsh-client-ui-slots`（`SlotCore` / SlotMap 类型）

---

## 5. SQLite 驱动

- **`node:sqlite`（Node 24 内置）可用**：`DatabaseSync, StatementSync, Session, constants, backup`。
- 有 `ExperimentalWarning: SQLite is an experimental feature`（仍在实验，但可用）。
- **结论**：用 `node:sqlite`（无原生编译，绕开沙箱 EPERM 与 better-sqlite3 的 node-gyp）。实现时可接受该 warning 或用 `--no-warnings`/进程标记抑制。

```js
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(path)
db.exec('CREATE TABLE ...')
const stmt = db.prepare('INSERT ...')
stmt.run(...)
```

---

## 6. 实现要点速查

| 事项 | 结论 |
|---|---|
| 补回复模型调用 | `ctx.llm.stream({ provider, model, system, messages })`，消费 `StreamChunk` |
| 思考内容 | 累积 `reasoning-delta`；或 `block-end` 的 `reasoning` 块 |
| 用量 | 直接读 `usage` chunk 的 `TokenUsage`（含缓存命中/思考 token） |
| 搜索次数 | 一次性调用无；需 agent turn 才有（设计缺口，待决策） |
| HTTP 路由 | `ctx.get('webServer').register({kind,path,handler})`，`ctx.effect` 包裹 |
| 全局面板 | `inject:['slots']` + `ctx.slots.inject('shell.overlay', ()=>ctx.slots.register({name,id,order,label}, Comp))` |
| 客户端运行时 | `@deepseek-ai/dsh-cordis-client-runner`（非 dsh-client-runtime） |
| SQLite | `node:sqlite`（DatabaseSync，实验性但可用） |
