# `dsh-adapter-qq` 源码取证与技术分析报告

**报告日期**：基于取证时刻的 npm latest（0.1.3）
**取证对象**：`dsh-adapter-qq@0.1.3`，作者 JiXieShi，许可证 MIT
**取证方式**：npm registry JSON（含完整 readme）+ unpkg/jsDelivr CDN 上的**已发布源码产物**（`lib/*.js` 为可读 ESM 源码，未被混淆或压缩）+ GitHub raw（main 分支可达）
**交叉验证**：本机 DSH 运行时（`D:\DeepSeekHarness\DSH Desktop\resources\app\node_modules\@deepseek-ai\*`）中逐一核对了插件调用的 DSH/Cordis 服务与事件签名

> **取证完备性声明**：`lib/index.js`、`lib/config.js`、`lib/client.js`、`lib/qq/client.js`、`lib/qq/gateway.js`、`lib/sync/session-manager.js`、`lib/sync/approval-handler.js`、`lib/sync/message-bridge.js`、`lib/ui/keyboard.js`、`cordis.patch.yml`、`package.json`、`README.md` 均**已完整取证**。`lib/sync/message-bridge.js` 共 1650 行，本报告中的引用来自 unpkg 全文与 GitHub raw 同一文件，二者一致。推送到 npm 的文件清单只有 13 个文件（`files: ["lib","cordis.patch.yml","README.md","LICENSE"]`），**仓库中的 `test/` 与 `docs/images/` 未随包发布，未取证**。

---

## 0. 一句话结论

这是一个**只做 QQ 官方开放平台 C2C 单聊**的 DSH 适配器：通过官方 OpenAPI v2 的 `getAppAccessToken` → `/gateway` → WebSocket 长连接 + `POST /v2/users/{openid}/messages` 收发消息，把每个 QQ 用户的私聊绑定到**一个 DSH 会话 ID**，并用 Cordis 的 `approval/request`、`user-questions/request` two waterfalls 实现 QQ 与 Web UI 的双向审批竞态结算。它**不接群聊、不接频道、不接 NapCat/OneBot**。【源码确证】

---

## A. 接入协议：QQ 官方 OpenAPI v2 + WebSocket Gateway

**【源码确证】** 全部基于 QQ 官方开放平台，无任何第三方逆向协议。

`lib/qq/client.js`：

```js
this.tokenUrl = 'https://bots.qq.com/app/getAppAccessToken';
this.baseUrl = this.sandbox
  ? 'https://sandbox.api.sgroup.qq.com'
  : 'https://api.sgroup.qq.com';
```

`lib/qq/gateway.js`（opcode 表与 intents 完整实现）：

```js
export const OpCode = {
  DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6,
  RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11,
};
// (1 << 25): GROUP_AND_C2C_EVENT (Includes C2C_MESSAGE_CREATE)
// (1 << 26): INTERACTION (Includes INTERACTION_CREATE for button callbacks)
export const DEFAULT_INTENTS = (1 << 25) | (1 << 26);
```

`sendIdentify()` 使用 `token: \`QQBot ${token}\``、`shard: [0, 1]`，并支持 `RESUME`、心跳（`Math.max(10000, heartbeat_interval * 0.9)`）、失 ACK 重连、指数退避（1s→30s）。

| 问题 | 结论 | 证据等级 |
|---|---|---|
| 官方 OpenAPI v2？ | **是**。`getAppAccessToken` + `/gateway` + `/v2/users/{openid}/messages` + `PUT /v2/menu` + `PUT /interactions/{id}`，含 `sandbox.api.sgroup.qq.com` 沙箱域 | 【源码确证】 |
| WebSocket Gateway？ | **是**，完整 opcode/心跳/Resume 状态机 | 【源码确证】 |
| 群聊？ | **否**。`handleDispatch` 只处理 `C2C_MESSAGE_CREATE` 与 `INTERACTION_CREATE`，没有任何 `GROUP_AT_MESSAGE_CREATE` / `AT_MESSAGE_CREATE` / `DIRECT_MESSAGE_CREATE` 分支；发送侧只有 `POST /v2/users/{openid}/messages`，没有 `/v2/groups/{gid}/messages` 或 `/channels/...` | 【源码确证】 |
| 频道？ | **否**，同上 | 【源码确证】 |
| 仅 C2C 单聊？ | **是**。intents 用了 `1<<25`（该位在官方文档中涵盖群与 C2C 事件），但代码只消费 C2C 分支 | 【源码确证】 |
| NapCat/OneBot？ | **否**。无任何 OneBot/HTTP-上报/反向 WS 相关实现，`ws` 仅连官方 gateway | 【源码确证】 |

> **注意一处 readme 与源码的差异**：README 架构图写 `分发 C2C_MESSAGE_CREATE / INTERACTION_CREATE`，与代码一致；但 intents 注释写 "GROUP_AND_C2C_EVENT"，容易被误读为支持群聊。**实际并未处理群聊事件**。【源码确证】

---

## B. QQ 消息 → DSH 一轮 agent 会话：真实使用的服务与 API

### B1. 插件声明的注入服务（`lib/index.js`，逐字）

```js
export const inject = [
  'sessionController',
  'sessions',
  'settings',
  'sessionProjections',
  'agentDefaultModel',
  'agents',
  'agentPresets',
  'permissionPresets',
  'workspaceRegistry',
  'attachments',
];
```

我在本机 DSH 运行时中逐一核对了这些服务的存在性与方法签名：`sessionController`（`@deepseek-ai/dsh-api-session-controller`）、`sessionProjections`（`dsh-session-projection` 的 `stateOf(session, key)`）、`permissionPresets`（`dsh-permission-presets` 提供 `names` / `resolve()` / `current(session)` / `set(session, name)`）、`agentPresets`（`dsh-agent-presets` 提供 `async list()` 与 `@Remote('select') async select(agent, agentPreset)`）、`agentDefaultModel`（`currentSelection()`）、`workspaceRegistry`（`dsh-workspace`）。**插件调用的方法名全部真实存在，未发现臆造 API。**【源码确证】

### B2. 会话事件桥（`lib/sync/message-bridge.js`）

```js
// 3. DSH Session Events (ctx.on('session/event', (session, event) => ...))
const onSessionEvent = (session, event) => this.handleDshSessionEvent(session, event);
const sessionEventDisposer = this.ctx.on('session/event', onSessionEvent);
```

`handleDshSessionEvent` 的 switch 分支（真实事件名）：

```js
switch (event.type) {
  case 'user/message':        await this.onDshUserMessage(userOpenid, event); break;
  case 'assistant/chunk':     this.onDshAssistantChunk(userOpenid, session.id, event); break;
  case 'assistant/message':   await this.onDshAssistantMessage(userOpenid, session.id, event); break;
  case 'tool/call':           await this.onDshToolCall(userOpenid, event); break;
  case 'turn/end':            this.onDshTurnEnd(session.id); break;
  default: break;
}
```

**签名核对**：本机 `@deepseek-ai/dsh-session` 中 `session/event` 的回调实参确为 `[session, event]`（`const callbackArgs = [this, event];` → `invokeContainedSessionObservers(entry.emitCtx, "session/event", entry.id, callbackArgs, callbacks)`）。`user/message`、`assistant/message`、`tool/call`、`turn/end` 均在 `SessionEventMap` 中真实存在。**调用形态与签名完全吻合。**【源码确证】

> 细节差异：插件读取 `'assistant/chunk'`，而本机 `SessionEventMap` 中可持久化事件表未列出 `assistant/chunk`（流式片段走 `AssistantStreamRecord[]` / `assistant/attempt`）。因此 `assistantBuffers` 那条缓冲路径**大概率永不触发**；不过它只用于刷新"正在输入"提示，不影响最终回复投递。此项标注【推测】。

### B3. 把消息送进 agent 一轮（`handleUserPrompt`）

```js
const mode = liveAgent?.status === 'running' ? 'steer' : 'followup';
if (sessionController?.prompt) {
  const controller = new AbortController();
  await sessionController.prompt({
    sessionId: activeId,
    content: promptContent,      // [{type:'text',...}, {type:'image', data: base64, mediaType, name}]
    requestId: rpcId,
    mode,
  }, controller.signal);
} else if (liveAgent?.followup) {
  liveAgent.followup({ content: promptContent, source: { kind: 'plugin', plugin: 'dsh-adapter-qq', rpcId } });
}
```

**签名核对**：本机 `setModel`/`prompt` 远程签名确为 `@Remote('prompt') prompt(request: SessionPromptRequest, signal: AbortSignal): Promise<SessionPromptValue>`。`mode: 'steer' | 'followup'` 与 `Agent.steer/followup` 的存在性一致。**正确。**【源码确证】

### B4. 其余真实调用的 DSH API 清单

| 调用形态（源码出现） | 用途 | 核对结果 |
|---|---|---|
| `ctx.on('approval/request', async (req, next) => …)` | 审批 waterfall 应答者 | 真实，`ApprovalRequestEvent` + `next: () => Promise<ApprovalOutcome>`，签名见 `dsh-tool-cordis` | 
| `ctx.on('user-questions/request', async (req, next) => …)` | 反问（ask_user_question）waterfall 应答者 | 真实，`AskUserQuestionRequestEvent` | 
| `ctx.get('sessions') / ctx.get('sessionController') / …` | 服务获取（同时兼容 `ctx.x` 直取） | 真实 |
| `sessionController.list({})` → `{ items: [...] }` | 列出会话（含冷会话） | 真实：`async list(_request, signal) { return { items: await this.listState.list(signal) }; }`；**但插件未传 signal**，首次参数位上 `{}` 会被当作 `_request` 忽略，故功能可用 |
| `sessionController.create({ sessionId, workspaceId\|cwd, agentPreset })` | 新建会话 | 真实：`@Remote('create') create(request: SessionCreateRequest)` |
| `sessionController.selectModel({ sessionId, provider, model, reasoningEffort })` | 切模型 / 切思考等级 | 真实：`@Remote('selectModel')` |
| `sessionController.modelCatalog()` → `catalog.groups` | 模型清单 | 真实：`@Remote('modelCatalog'): Promise<ModelCatalog>` |
| `sessionController.cancel({ sessionId })` | 中止当前轮 | 真实（非 async，返回 `SessionCancelValue`） |
| `sessionProjections.stateOf(live, 'sessionStats'\|'tokenUsage'\|'modelSelection')` | /stats 数据源 | 真实：`stateOf(session, key)` |
| `permissionPresets.current(live)` / `permissionPresets.set(live, mode)` / `permissionPresets.names` / `.resolve(name)` | 权限读取与切换 | 真实，四个成员均存在 |
| `agentPresets.list()` / `agentPresets.select(liveAgent, presetName)` | 预设发现与切换 | 真实 |
| `agentDefaultModel.currentSelection()` | 模型兜底 | 真实 |
| `workspaceRegistry.list()` / `.get(id)` / `.resolveByPath(p)` / `.create(path)` / `ws.attachSession(sid)` / `.archivedSessionIds` | 工作区管理 | 类名与主要方法存在；`resolveByPath` 被 `typeof === 'function'` 包裹，属防御式调用 |
| `agents.get(sessionId)` → `{ status, cancel() }` | 判断运行态、兜底取消 | 真实：`Agent.status`、`Agent.cancel(cause, options)` |
| `settings.update(ns, patch)`、`settings.installSection(ctx, ns, Config, entry, hooks)` | 设置持久化与 UI 注入 | 真实：`dsh-settings` 导出 `installSection(owner, ns, schema, entry, hooks)` 与 `async update(ns, patch)` |
| `ctx.effect(() => () => {…}, 'dsh-adapter-qq: cleanup')` | 插件卸载清理 | Cordis 标准用法 |

**B 节结论：未发现任何臆造的 DSH API 名称。** 插件对 DSH 内部 API 的使用是"真实但有降级/兜底"的写法（大量 `?.`、`typeof === 'function'` 与 `try/catch` 静默回退），部分冷门投影键（`rows.title.val`、`rows.sessionStats.val`）是通过**直接读 `~/.dsh/storages/session_projcache/sessions/<sid>.json` 文件**拿的，属于绕过 API 的私有实现依赖。【源码确证】

---

## C. QQ 用户 ↔ DSH 会话的绑定关系

### C1. 绑定粒度：单个 QQ 用户 ↔ **一个全局"活跃会话"**

**【源码确证】** 绑定状态不是一个映射表，而是**一条全局配置项** `config.activeSessionId`：

```js
// lib/index.js
const sessionManager = new SessionManager({
  ctx,
  getActiveSessionId: () => currentConfig.activeSessionId,
  setActiveSessionId: (sid) => updateConfig({ activeSessionId: sid }),
  logger,
});
```

```js
// lib/sync/message-bridge.js
async handleInboundC2C(data) {
  const authorOpenid = data.author?.user_openid || data.author?.id;
  ...
  if (!config.userOpenid) {
    this.updateConfig({ userOpenid: authorOpenid });        // 首条消息自动绑定
  } else if (config.userOpenid !== authorOpenid) {
    const allowList = config.allowFrom || ['*'];
    if (!allowList.includes('*') && !allowList.includes(authorOpenid)) { /* 拒绝 */ }
  }
```

以及自由对话入口：

```js
async handleUserPrompt(userOpenid, content, attachments = [], msgId) {
  let activeId = await this.sessionManager.getActiveSessionId();
  if (!activeId) {
    const created = await this.sessionManager.createSession();   // 无活跃会话则自动新建
    activeId = created.sessionId;
  }
```

| 维度 | 结论 | 证据等级 |
|---|---|---|
| 一对一还是一对多？ | **架构上是一对一（单绑定用户），但实现上是"一个进程级活跃会话指针"**。任何被允许的 openid 发消息，都进入**同一个** `activeSessionId`。若把 `allowFrom` 配成 `['*']`（默认值），多个 QQ 用户会**共用同一个 DSH 会话上下文**，互相可见对话历史。 | 【源码确证】 |
| session id | 新建时 `session-${randomUUID()}`（`lib/sync/session-manager.js: const finalSessionId = sessionId || \`session-${randomUUID()}\`;`） | 【源码确证】 |
| cwd | `createSession({cwd, preset, sessionId, workspaceId})`：优先 `workspaceId` → 再 `cwd` → 再 `workspaceRegistry.list()[0].path` → 最后 `process.cwd()` | 【源码确证】 |
| preset | `createSession` 内 `const finalPreset = preset || 'standard';`；**调用方全部硬编码 `preset: 'standard'`**（`cmdNewSession` 的 4 处：直接创建、select-ws、confirm-dir、以及 `handleUserPrompt` 的自动建会话） | 【源码确证】 |
| 工作区归属 | 刻意保证"绝不落单"：若匹配到/自动创建了 workspace，会再次 `targetWorkspace.attachSession(finalSessionId)` | 【源码确证】 |

### C2. 发现的实质缺陷（readme 与源码不符）

> **`defaultPreset` 配置项在整个代码库中从未被读取。** `lib/config.js` 定义了它、`lib/client.js` 的 UI 卡片提供了下拉框（"新建会话默认 Agent 预设"），`lib/sync/message-bridge.js` 却只使用 `KeyboardBuilder` 与 `'standard'` 字面量。`/new` 向导创建出的会话**永远是 `standard` 预设**，UI 上的选择不生效。
> **`defaultCwd` 只在一个分支生效**：仅 `/new browse` 的初始目录（`let initPath = args[1] || info?.cwd || config.defaultCwd || process.cwd();`）。工作区选择、`confirm-dir`、自动建会话都不读它。
> 二者标注【源码确证】（readme 表格声称它们生效，属【readme 声称】与源码冲突，**以源码为准**）。

---

## D. 权限模型：审批竞态与权限级别切换

### D1. 审批：注册为 `approval/request` waterfall 的应答者，与 Web UI 竞速

**【源码确证】** 核心机制是 `Promise.race([QQ 决定, next(), 原始 signal abort])`：

```js
const raceResult = await Promise.race([
  qqDecisionPromise.then((decision) => ({ source: 'qq', outcome: decision })),
  next().then((outcome) => ({ source: 'web', outcome })),
  new Promise((resolve) => {
    if (originalSignal) {
      originalSignal.addEventListener('abort', () => resolve({ source: 'abort', outcome: 'cancelled' }), { once: true });
    }
  }),
]);

if (raceResult.source === 'qq') {
  if (!localAbortController.signal.aborted) {
    localAbortController.abort(new Error(`Settled by QQ user: ${raceResult.outcome}`));
  }
} else if (raceResult.source === 'web') {
  await this.apiClient.sendC2CMessage(userOpenid, {
    content: `ℹ️ 【审批同步】已在 DSH Web UI 中完成处理: ${isAllowed ? '✅ 允许执行' : '❌ 已拒绝'}`,
  });
}
return raceResult.outcome;
```

关键实现要点（均为【源码确证】）：
1. **门槛**：`if (!userOpenid || sessionId !== activeSessionId) return next();` —— 只拦截**当前活跃会话**的审批，其他会话直接放行给默认应答者。
2. **取消 Web UI 弹窗**：把 `req.signal` 替换为本地 `AbortController.signal`，QQ 先决定时 `abort()` 掉 Web UI 侧；`finally` 中恢复 `req.signal = originalSignal` 并移除监听。
3. **决定值**：`handleUserDecision(id, 'allowed-once' | 'rejected')`，与 DSH 的 `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'` 一致。
4. **QQ 端交互**：推送审批卡片 + InlineKeyboard 两个按钮（`KeyboardBuilder.buildApprovalBoard(approvalId)`）：
   ```js
   KeyboardBuilder.button({ id: 'btn_appr_allow', label: '✅ 允许执行 (单次)', data: `/approve ${approvalId}`, style: 1 }),
   KeyboardBuilder.button({ id: 'btn_appr_reject', label: '❌ 拒绝执行', data: `/reject ${approvalId}`, style: 0 }),
   ```
   也支持纯文本 `/approve [ID]` / `/reject [ID]`；ID 为空且只有一个待审批项时自动选中该项。
5. **同时接管反问**：`user-questions/request` 用同一套竞速逻辑，把 `q.options` 渲染成 A/B/C/D 按钮，回传 `{ answers: [{ id, selected: [label] }] }`。

### D2. 权限级别切换：`permissionPresets.set(live, mode)`

**【源码确证】** `lib/sync/session-manager.js` 中带中英文别名的映射：

```js
const aliasMap = {
  readonly: 'read-only', 'read-only': 'read-only', 只读: 'read-only', 只读模式: 'read-only',
  workspace: 'workspace-write', 'workspace-write': 'workspace-write', 工作区: 'workspace-write', 工作区写入: 'workspace-write',
  danger: 'danger-full-access', 'danger-full-access': 'danger-full-access', 全系统: 'danger-full-access', 全系统模式: 'danger-full-access', full: 'danger-full-access',
};
const targetMode = aliasMap[permissionMode?.toLowerCase()?.trim()] || permissionMode;
if (!this.permissionPresets?.set) throw new Error('permissionPresets service is not available in DSH context.');
this.permissionPresets.set(live, targetMode);
```

- 可用级别列表**动态来**自 `permissionPresets.names` + `permissionPresets.resolve(name)`，取不到才回落到硬编码三档（`read-only` / `workspace-write` / `danger-full-access`）。【源码确证】
- 入口：`/permission` 查看、`/permission <模式>` 切换、`buildPermissionsBoard` 按钮（`data: /permission ${p.id}`）。【源码确证】
- **两个实现瑕疵**：`switchPermission` 使用 `this.cachedActiveSessionId`（内存缓存）而非 `await this.getActiveSessionId()`，若插件刚启动、尚未有交互，缓存为空会抛 `No active session.`；`this.permissionPresets.set(live, targetMode)` **未 await**（本机签名返回 Promise）。【源码确证】

### D3. 权限模型的真实含义（重要风险）

**【源码确证】** 插件本身**不实现任何权限判定**，它只是把 DSH 的 `permissionPresets.set` 暴露到 QQ 端。因此：
- QQ 端能**一键把会话权限提升到 `danger-full-access`**（"全系统模式"），且这一步**不需要任何二次确认或审批**——`buildPermissionsBoard` 一个按钮即可。
- 结合 D1 的门槛：`approval/request` 只对 `activeSessionId` 生效；而 `activeSessionId` 是全局单指针，改动它会**改变哪个会话受 QQ 审批管控**。
- 结合 C1：若 `allowFrom` 保持默认 `['*']`，任何能给机器人发私聊的用户都能触发 `/permission danger-full-access` 与 `/approve`。

---

## E. 流式输出、工具进度、图片/文件

| 能力 | 结论 | 证据等级 | 依据 |
|---|---|---|---|
| **流式输出** | **不算真正流式**。代码监听 `assistant/chunk` 并累积到 `assistantBuffers`，但**只在刷新"正在输入"提示时用到**；真正发给 QQ 的是 `assistant/message` 到达后的**整段文本**，按 3800 字一段切片发送；每个切片尝试用 `msg_id` 做被动回复，超过 240s 或失败则**降级为主动消息**重发（`sendC2CMessage` 内部 catch 到 `msg_id` 失败会去掉 `msg_id` 重试） | 【源码确证】 | `onDshAssistantChunk` / `onDshAssistantMessage`：`const CHUNK_SIZE = 3800;` |
| **工具调用进度** | **支持，但默认关闭**。`config.syncToolCalls` 默认 `false`；开启后按 `toolCallAggregateWindowMs`（默认 30000ms）**聚合**，flush 成一条 `⚙️ **[Agent 执行进展]** 最近完成了 N 项操作: \`name (2次), ...\``。另外每次 `tool/call` 会无条件刷新"正在输入" | 【源码确证】 | `onDshToolCall` / `flushToolBuffer` |
| **图片接收（QQ→DSH）** | **支持**。附件 URL 归一化（`//` → `https:`）、`fetch` 下载、**保存到 `<sessionCwd>/uploads/<filename>`**，并作为 `{ type: 'image', data: base64, mediaType, name }` 内容块塞进 prompt，同时在文本里插入 `[用户从 QQ 发送了图片: ...]` 标注 | 【源码确证】 | `handleUserPrompt` |
| **文件接收（QQ→DSH）** | **支持**。非图片文件落盘 `uploads/`；文本类（`txt/md/json/js/ts/py/...` 或 `text/*`）且 **< 48000 字节**时**把全文内联进 prompt 的代码块**，否则只给路径提示 `📎 [用户从 QQ 发送了文件: ... 已保存至工作区 uploads/...]` | 【源码确证】 | 同上 |
| **图片/文件发送（DSH→QQ）** | **不支持**。发送侧只有 `sendC2CMessage` 的 `msg_type 0(文本)/2(markdown)/6(输入中)`；`lib/qq/client.js` **没有**任何富媒体上传接口（无 `/v2/users/{openid}/files`、无 `file_data`、无 `media`）。README 的展示图只演示了"QQ 图片同步至 Web UI"，即单向 | 【源码确证】 |
| **其他交互细节** | 支持 `DELETE /v2/users/{openid}/messages/{id}` **撤回**上一张向导/模型卡片以防刷屏；支持 `PUT /interactions/{id}` `{code:0}` **立即 ACK**（否则手机 QQ 转圈）；Markdown 发送若被 400/403 拒绝会**自动降级为纯文本** | 【源码确证】 | `recallC2CMessage` / `ackInteraction` / `sendC2CMessage` |

---

## F. 安装与依赖

**【源码确证】** 来自已发布的 `package.json`：

```json
{
  "name": "dsh-adapter-qq", "version": "0.1.3", "type": "module", "main": "lib/index.js",
  "exports": { ".": { "default": "./lib/index.js" }, "./client": "./lib/client.js", "./package.json": "./package.json" },
  "files": ["lib", "cordis.patch.yml", "README.md", "LICENSE"],
  "scripts": { "test": "node test/all.js" },
  "dependencies": { "ws": "^8.18.0" },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.0", "@deepseek-ai/schemastery": "^3.18.0" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-settings-plugins"]
    }
  },
  "engines": { "node": ">=18" }, "license": "MIT"
}
```

`cordis.patch.yml` 全文（**【源码确证】**，极简）：

```yaml
# dsh-adapter-qq bundle patch
# QQ Bot 适配器插件配置
- insert:
    - id: adapter-qq
      name: dsh-adapter-qq
```

| 问题 | 结论 | 证据等级 |
|---|---|---|
| 运行时依赖 | 仅 `ws@^8.18.0`（WebSocket 客户端），其余全用 Node 内置 `fetch`/`crypto`/`fs`/`path`/`os` | 【源码确证】 |
| peerDependencies | `@deepseek-ai/cordis@^4.0.0`、`@deepseek-ai/schemastery@^3.18.0` | 【源码确证】 |
| 需要 `dsh plugin add` 吗？ | **是（readme 推荐路径）**。README 给的是 `dsh plugin --profile web add dsh-adapter-qq`，或 `dsh plugin --profile web add github:jixishi/dsh-adapter-qq`；卸载 `dsh plugin --profile web remove dsh-adapter-qq` | 【readme 声称】（命令本身是 DSH 官方 CLI 形态，但报告未实测安装） |
| runner 侧装配 | 包声明了 `dsh.bundle.patch`，`cordis.patch.yml` 插入 `id: adapter-qq` / `name: dsh-adapter-qq`，属标准 DSH bundle 插件 | 【源码确证】 |
| 前端装配 | `dsh.client.platform = "web"`，client 侧走 `window.__ModuleLoader__.load({ id: 'dsh-adapter-qq', factory })` 并**同时注册别名 `dsh-plugin-adapter-qq`**（源码确证：`lib/client.js` 末尾两次 load 调用），UI 卡注册到 `settings.plugin.item` 槽、`order: 35`，namespace `adapter-qq` | 【源码确证】 |
| Node 版本 | `engines.node >= 18`（因为用了全局 `fetch`） | 【源码确证】 |
| 单元测试 | 脚本为 `node test/all.js`；**`test/` 目录不在发布文件清单内**，未取证。README 声称 6 套件 51 用例全通过 | 【未取证】(测试代码) / 【readme 声称】(通过数) |

---

## G. 局限与风险

| # | 风险/局限 | 说明 | 证据等级 |
|---|---|---|---|
| G1 | **必须走 QQ 官方开放平台，需要 AppID/AppSecret** | 需在 q.qq.com 注册开发者并创建机器人应用。README 明确说"**个人开发者创建的默认单聊机器人即可直接使用，无需复杂配置**"，即**不强制企业资质**；沙箱环境需把测试 QQ 号加入"测试人员管理" | 【readme 声称】（官方平台侧的政策可能变化，报告未独立核验） |
| G2 | **只能单聊** | 无群聊/频道实现（见 A 节）。因此"单人私聊使用"是唯一形态，天然限制了多人协作场景 | 【源码确证】 |
| G3 | **默认 `allowFrom: ['*']` + 首条消息自动认主** | `userOpenid` 留空时，**第一个给机器人发私聊的人会被自动绑定**为 owner；`allowFrom` 默认 `['*']` 意味着白名单形同虚设，任何能私聊机器人的人都能驱动 DSH（并可通过 `/permission` 提到全系统权限）。这是本插件最严重的配置级风险 | 【源码确证】 |
| G4 | **全局单活跃会话指针** | `activeSessionId` 是进程级配置，不是 per-user 映射。多人（或双端）使用时上下文会串（见 C 节） | 【源码确证】 |
| G5 | **`danger-full-access` 一键可达且无二次确认** | 见 D3。QQ 端一条 `/permission 全系统` 即提升到"跳过所有交互式审批" | 【源码确证】 |
| G6 | **消息频率/回复窗口限制** | 代码显式处理了被动回复窗口（`Date.now() - this.lastMsgTime < 240000` 才用 `msg_id`）与超长切片（3800 字），失败自动降级主动消息；对 `429/503` 做 3 次指数退避、对 `code 50015014`（System busy）做退避。README 提到错误码 `11255`（沙箱/正式环境不匹配）。**主动消息在官方平台有月度条数配额**，长回复切片 + 降级会产生多条主动消息，可能吃额度——**此项属官方平台配额的一般性限制，报告未从源码或官方文档直接核实具体数值** | 【源码确证】(保护逻辑) / 【推测】(配额影响面) |
| G7 | **凭证明文落盘** | `appId`/`clientSecret`/`token` 以 `settings` 机制持久化到 DSH 设置文件（`token`、`clientSecret` 用 `z.string().role('secret')` 标记，UI 层脱敏）；但**磁盘上是明文**，任何能读 `~/.dsh` 的本地进程都可获取。README 声称"安全保密字段自动脱敏"，指 UI 展示层 | 【源码确证】 |
| G8 | **读 DSH 私有文件/私有格式，版本脆弱** | `lib/sync/session-manager.js` 直接 `readFileSync` 读 `~/.dsh/storages/session_projcache/sessions/<sid>.json` 取 `record.rows.title.val`、`record.identity.origin`、`record.rows.sessionStats.val`；读 `~/.dsh/storages/workspace.json` 的 `global.workspaceIds`/`tables.workspaces`；用**正则逐行解析** `~/.dsh/settings.yaml` 里 `llm-pi-ai:` 段的四级缩进来提取 provider/model。这些**不是 DSH 公开 API**，DSH 升级改格式即静默失效 | 【源码确证】 |
| G9 | **隐私/合规** | ① QQ 侧内容会进入 DSH agent 并可能触发文件读写/Shell；② 非图片文件 <48KB 时**全文内联进 prompt**（发送给 LLM 提供商）；③ Web UI↔QQ 双向同步会把电脑端的提问原文推到手机 QQ（`syncWebQuestions` 默认 false 规避）；④ 代码尝试用正则清洗 `MNEMON RUNTIME MEMORY SNAPSHOT`、`<system-reminder>`、`Current runtime context` 等内部注入文本，但这是**启发式黑名单**，新格式会漏；⑤ 用户 OpenID 与全部对话内容会经由腾讯官方服务器中转 | 【源码确证】(①–④) / 【推测】(⑤ 为官方平台固有属性) |
| G10 | **代理/DNS 陷阱** | README 明确警告：Clash、Shadowrocket TUN（fake-ip）会拦截 `bots.qq.com` 与 `*.qq.com` 握手，导致 DNS 解析失败 | 【readme 声称】 |
| G11 | **预设不可热切换** | 会话产生第一轮后 preset 固化（DSH 原生约束），插件在 `/preset` 失败时给出提示文案 | 【readme 声称】(与 DSH `agent-preset/locked` 错误语义一致) |
| G12 | **`defaultPreset` / `defaultCwd` 配置不生效** | 见 C2，UI 提供但代码不用 | 【源码确证】 |
| G13 | **`/switch` 的 ID 与 Index 语义冲突** | `cmdSwitchSession` 先按 `parseInt` 当序号匹配，若失败再按"sessionId 包含"或"title 包含"做模糊匹配；纯数字标题或 ID 含数字时可能切错会话 | 【源码确证】 |

---

## H. 关键代码片段证据（每段 ≤ 30 行）

### H1. Gateway 协议：intents 与 dispatch（`lib/qq/gateway.js`）

```js
export const DEFAULT_INTENTS = (1 << 25) | (1 << 26);
// ...
case 'C2C_MESSAGE_CREATE':
  this.logger.info?.(`[QQGateway] Received C2C_MESSAGE_CREATE from user: ${data.author?.user_openid || data.author?.id}`);
  this.emit('c2c_message', data);
  break;

case 'INTERACTION_CREATE':
  this.logger.info?.(`[QQGateway] Received INTERACTION_CREATE: id=${data.id}`);
  this.emit('interaction', data);
  break;
```

**证明**：只有 C2C 与 INTERACTION 两个业务事件分支 → 仅单聊。

### H2. 发送消息：只有 C2C 文本/Markdown/输入中（`lib/qq/client.js`）

```js
if (message.msg_type !== undefined) {
  payload.msg_type = message.msg_type;
} else if (message.markdown) {
  payload.msg_type = 2;
} else {
  payload.msg_type = 0;
}
// ...
return await this.request(`/v2/users/${userOpenid}/messages`, {
  method: 'POST',
  body: JSON.stringify(payload),
});
```

**证明**：`msg_type` 只出现 0/2/6；无群/频道/富媒体端点。

### H3. 审批竞态（`lib/sync/approval-handler.js`）

```js
const raceResult = await Promise.race([
  qqDecisionPromise.then((decision) => ({ source: 'qq', outcome: decision })),
  next().then((outcome) => ({ source: 'web', outcome })),
  new Promise((resolve) => {
    if (originalSignal) {
      originalSignal.addEventListener('abort', () => resolve({ source: 'abort', outcome: 'cancelled' }), { once: true });
    }
  }),
]);
settled = true;
this.pendingApprovals.delete(approvalId);
if (raceResult.source === 'qq') {
  if (!localAbortController.signal.aborted) {
    localAbortController.abort(new Error(`Settled by QQ user: ${raceResult.outcome}`));
  }
}
```

### H4. 审批门槛：只拦截活跃会话（`lib/sync/approval-handler.js`）

```js
const approvalDisposer = this.ctx.on('approval/request', async (req, next) => {
  const sessionId = req.agent?.session?.id;
  const activeSessionId = await this.sessionManager.getActiveSessionId();
  const userOpenid = this.getUserOpenid();

  // If no QQ user configured or this approval is not for the active session, delegate immediately to next()
  if (!userOpenid || sessionId !== activeSessionId) {
    return next();
  }
```

### H5. 权限别名与切换（`lib/sync/session-manager.js`）

```js
const targetMode = aliasMap[permissionMode?.toLowerCase()?.trim()] || permissionMode;
if (!this.permissionPresets?.set) {
  throw new Error('permissionPresets service is not available in DSH context.');
}
this.permissionPresets.set(live, targetMode);
return targetMode;
```

### H6. 首条消息自动绑定 + 白名单（`lib/sync/message-bridge.js`）

```js
if (!config.userOpenid) {
  this.logger.info?.(`[MessageBridge] Auto-binding userOpenid to: ${authorOpenid}`);
  this.updateConfig({ userOpenid: authorOpenid });
} else if (config.userOpenid !== authorOpenid) {
  // Whitelist check for private tool
  const allowList = config.allowFrom || ['*'];
  if (!allowList.includes('*') && !allowList.includes(authorOpenid)) {
    this.logger.warn?.(`[MessageBridge] Blocked unauthorized message from: ${authorOpenid}`);
    await this.apiClient.sendC2CMessage(authorOpenid, {
      content: '⚠️ 访问受限：本机器人为私人专属工具，您的 OpenID 未在白名单中。',
      msg_id: msgId,
    });
    return;
  }
}
```

### H7. 投喂一轮 agent（`lib/sync/message-bridge.js`）

```js
const agents = this.ctx.get ? this.ctx.get('agents') : this.ctx.agents;
const sessionController = this.ctx.get ? this.ctx.get('sessionController') : this.ctx.sessionController;
const liveAgent = agents?.get(activeId);
const mode = liveAgent?.status === 'running' ? 'steer' : 'followup';

if (sessionController?.prompt) {
  const controller = new AbortController();
  await sessionController.prompt({
    sessionId: activeId,
    content: promptContent,
    requestId: rpcId,
    mode,
  }, controller.signal);
}
```

### H8. 长回复切片与被动/主动降级（`lib/sync/message-bridge.js`）

```js
const CHUNK_SIZE = 3800;
for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
  const slice = fullText.slice(i, i + CHUNK_SIZE);
  const isPassive = this.lastMsgId && Date.now() - this.lastMsgTime < 240000;
  try {
    await this.apiClient.sendC2CMessage(userOpenid, {
      markdown: slice,
      ...(isPassive ? { msg_id: this.lastMsgId } : {}),
    });
  } catch (err) {
    this.logger.error?.(`[MessageBridge] Failed to send assistant message to QQ: ${err.message}`);
  }
}
```

### H9. 读 DSH 私有投影缓存（`lib/sync/session-manager.js`）

```js
const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const cachePath = join(home, 'storages', 'session_projcache', 'sessions', `${sid}.json`);
if (existsSync(cachePath)) {
  const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
  const titleVal = cache?.record?.rows?.title?.val;
  if (titleVal && typeof titleVal === 'string' && titleVal.trim() && titleVal !== sid) {
    return titleVal.trim();
  }
}
```

### H10. 前端设置卡注册（`lib/client.js` 末尾与 `apply`）

```js
function apply(ctx) {
  ctx.inject(["settingsScope"], (settingsCtx) => {
    const settings = settingsCtx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
    settingsCtx.slots.inject("settings.plugin.item", () => {
      return settingsCtx.slots.register(
        { name: "settings.plugin.item", id: "adapter-qq", key: SETTINGS_NAMESPACE, order: 35,
          inject: () => ({ settings }) },
        QQSettingsCard
      );
    });
  });
}
exports.name = "adapter-qq";
exports.inject = ["slots"];
```

---

## 附录：版本沿革与生态对照

**版本时间线（npm registry，`time` 字段）**【源码确证】：

| 版本 | 发布时间 | unpackedSize | 说明 |
|---|---|---|---|
| 0.1.0 | 2026-09-06T12:27:09Z | 143,899 B | 首个版本 |
| 0.1.1 | 2026-09-06T13:56:00Z | 145,180 B | |
| 0.1.2 | 2026-09-07T16:31:49Z | 175,200 B | |
| 0.1.3 | 2026-09-09T18:03:06Z | 194,269 B | 当前 latest |

三次迭代体积单调增长（+35%），未发布过 breaking 的 0.2.x。`0.1.2` 起 `author` 字段从对象改为字符串。全部版本 `gitHead` 各不相同，均带 npm 签名，`maintainers: jixieshi88 <jixieshibe6@gmail.com>`，`author: JiXieShi <lydxh935227514@gmail.com>`（**维护者邮箱与作者邮箱不一致**，属常见但值得记录的现象）。【源码确证】

**同类替代实现（web_search 发现，未逐行取证）**：
- [`dsh-plugin-adapter-qq`](https://www.npmjs.com/package/dsh-plugin-adapter-qq) v1.1.0（作者 fireguo，repo `veloce-ailab/dsh-plugin-adapter-qq`）：**明确支持频道 `@机器人`、群聊 `@机器人` 与单聊**，intents 保留 `PUBLIC_GUILD_MESSAGES (1<<30)` 与 `USER_MESSAGE (1<<25)`，需要**手工写 `cordis.patch.yml` 配置**（不是一行 `plugin add`）。与 `dsh-adapter-qq` 相比：**多群聊/频道能力，少审批同步/操作板/Web UI 设置卡**。【readme 声称】
- [`wang-22-code/dsh-qqbot-bridge`](https://github.com/wang-22-code/dsh-qqbot-bridge)：基于腾讯官方 Bot API，主打私聊白名单、持久会话、模型切换、远程权限审批。【未取证】（仅搜索摘要）
- [`dsh-im-qq`](https://github.com/988hj7tczd-oss/dsh-im-qq)：另一个 QQ IM 桥接实现。【未取证】
- [`@koishijs/plugin-adapter-qq`](https://www.jsdelivr.com/package/npm/@koishijs/plugin-adapter-qq)：Koishi 生态的 QQ 适配器，与 DSH 无关。【未取证】

**对本机 DSH 构建的适配性**【源码确证】：本机 `resources/app/node_modules/@deepseek-ai/` 中存在 `dsh-api-session-controller`、`dsh-session-projection`、`dsh-permission-presets`、`dsh-agent-presets`、`dsh-agent-default-model`、`dsh-workspace`、`dsh-settings`、`dsh-user-approval`、`dsh-user-questions`，插件声明的 10 个注入服务与 2 个 waterfall 事件**全部可解析**。**未实测安装运行**，因此"能跑通"仍是推断；但 API 名称层面无臆造。

---

## 证据来源（所有成功抓取的 URL）

**npm registry**
- https://registry.npmjs.org/dsh-adapter-qq （HTTP 200，含完整 readme 与 4 个版本的 manifest）
- https://registry.npmjs.org/dsh-plugin-adapter-qq （HTTP 200，同类实现对照）

**已发布源码（unpkg）**
- https://unpkg.com/dsh-adapter-qq@0.1.3/package.json （HTTP 200）
- https://unpkg.com/dsh-adapter-qq@0.1.3/lib/index.js （HTTP 200）
- https://unpkg.com/dsh-adapter-qq@0.1.3/lib/config.js （HTTP 200）
- https://unpkg.com/dsh-adapter-qq@0.1.3/lib/client.js （HTTP 200）
- https://unpkg.com/dsh-adapter-qq@0.1.3/lib/qq/client.js （HTTP 200）
- https://unpkg.com/dsh-adapter-qq@0.1.3/lib/qq/gateway.js （HTTP 200）
- https://unpkg.com/dsh-adapter-qq@0.1.3/lib/sync/session-manager.js （HTTP 200）
- https://unpkg.com/dsh-adapter-qq@0.1.3/lib/sync/approval-handler.js （HTTP 200）
- https://unpkg.com/dsh-adapter-qq@0.1.3/lib/sync/message-bridge.js （HTTP 200，1650 行全量）
- https://unpkg.com/dsh-adapter-qq@0.1.3/lib/ui/keyboard.js （HTTP 200）
- https://unpkg.com/dsh-adapter-qq@0.1.3/cordis.patch.yml （HTTP 200）
- https://app.unpkg.com/dsh-adapter-qq@0.1.3/files/lib （HTTP 200，目录清单：3 目录 3 文件）
- https://app.unpkg.com/dsh-adapter-qq@0.1.3/files/lib/sync （HTTP 200，确认 sync/ 仅 3 文件）

**已发布源码（jsDelivr 交叉验证）**
- https://cdn.jsdelivr.net/npm/dsh-adapter-qq@0.1.3/package.json （HTTP 200，与 unpkg 一致）

**GitHub raw（main 分支可达）**
- https://raw.githubusercontent.com/jixishi/dsh-adapter-qq/main/README.md （HTTP 200）
- https://raw.githubusercontent.com/jixishi/dsh-adapter-qq/main/lib/sync/session-manager.js （HTTP 200，与 unpkg 0.1.3 逐字一致）

**GitHub 网页（抓取失败，明确记录）**
- https://github.com/jixishi/dsh-adapter-qq （`TypeError: fetch failed`，**未取证**）
- https://github.com/jixishi/dsh-adapter-qq/tree/main/lib （`TypeError: fetch failed`，**未取证**）

> 说明：GitHub 网页端在本环境不可达，但 `raw.githubusercontent.com` 的 main 分支可达，且与 npm 0.1.3 产物一致。因此"GitHub 上有更新的未发布代码"这一可能性**未能排除**（**未取证**）；本报告全部结论基于 **0.1.3 已发布产物**。

**本机 DSH 运行时交叉核对（非网络来源，用于验证 DSH API 真实性）**
- `resources/app/node_modules/@deepseek-ai/dsh-session/lib/index.js`（`session/event` 回调实参 `[session, event]`、`SessionEventMap`）
- `resources/app/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js` 与 `lib/typert.host.js`（`prompt` / `create` / `list` / `selectModel` / `modelCatalog` / `cancel` 的 `@Remote` 签名；`ApprovalOutcome` 枚举）
- `resources/app/node_modules/@deepseek-ai/dsh-permission-presets/lib/index.js`（`names` / `resolve` / `current` / `set`）
- `resources/app/node_modules/@deepseek-ai/dsh-agent-presets/lib/index.js` + `lib/typert.host.js`（`async list()` / `@Remote('select') async select(agent, agentPreset)`）
- `resources/app/node_modules/@deepseek-ai/dsh-agent-default-model/lib/index.js`（`currentSelection()`）
- `resources/app/node_modules/@deepseek-ai/dsh-session-projection/lib/index.js`（`stateOf(session, key)`）
- `resources/app/node_modules/@deepseek-ai/dsh-settings/lib/index.js`（`installSection(owner, ns, schema, entry, hooks)` / `async update(ns, patch)`）
- `resources/app/node_modules/@deepseek-ai/dsh-tool-cordis/lib/index.js`（`approval/request` 与 `user-questions/request` 的公开签名）

---

## 标注汇总（哪些是"声称"、哪些是"未取证"）

| 内容 | 标注 |
|---|---|
| A–F 节所有协议、API、绑定、权限、附件、依赖的结论 | 【源码确证】（除下表列出的项） |
| `test/all.js` 存在且 51 用例全通过；README 展示截图 `docs/images/*` | 【readme 声称】+ 【未取证】（`test/`、`docs/` 不在 npm 文件清单内，无法取得） |
| `dsh plugin --profile web add …` 安装命令可用 | 【readme 声称】（命令形态符合 DSH CLI，但本报告未实测） |
| "个人开发者默认单聊机器人即可使用，无需企业资质" | 【readme 声称】（QQ 官方平台政策，未独立核验） |
| 错误码 `11255`（沙箱/正式不匹配）、代理 fake-ip 导致 DNS 失败 | 【readme 声称】 |
| `assistant/chunk` 事件在当前 DSH 版本是否仍会触发 | 【推测】（本机 `SessionEventMap` 未列出该事件名） |
| 主动消息配额会因长回复切片而被消耗的具体影响 | 【推测】 |
| GitHub 仓库 `main` 之外的分支/未发布代码 | 【未取证】 |
| 仓库 issue、讨论、第三方评测 | 【未取证】（`github.com` 网页端不可达；web_search 只返回同类替代实现，无针对本插件的讨论） |
| 本插件能否在本机 DSH 上成功运行 | 【推测】（API 名称层面全部可解析，但未实测运行） |
