# 实验性插件化设计（qq-bridge：唤醒 / 工具面 / 人设 / 投递 / 记忆）

> **状态**：设计待确认（本文档不改变任何运行时行为）
> **目标来源**：本会话目标 —— 把四块能力改造成"可随时开关的实验性插件"，默认关闭、关闭即零成本与零行为变更、支持影子灰度与独立回滚；先抽接口缝，再谈打包形态。
> **取证口径**：本文档所有 `path:line` 均为本轮实测（读源码得出），非文档转述。核验命令见 §10。

---

## 1. 目标与非目标

### 1.1 要做

| # | 交付 |
|---|---|
| 1 | 五块能力（唤醒 / 工具面 / 人设 / 投递 / 记忆）各有**独立配置开关** |
| 2 | **默认全部关闭**，等价于今天的 `qq-bridge@0.2.0` 行为 |
| 3 | 关闭时**零成本**：不加载判定模型、不建表、不做多余 fs 操作 |
| 4 | 每块可**影子灰度**（跑逻辑、只记录、不改变行为） |
| 5 | 每阶段可**独立回滚**，行为变更显式记录进 CHANGELOG/RELEASE |
| 6 | P0 只抽缝，**零行为变更** |

### 1.2 不做

- ❌ 不引入 cordis 插件形态。`qq-bridge` 是**外部进程 + SDK RPC**（`package.json:6`），唤醒判定发生在"要不要送进 DSH"之前，DSH 尚未参与，**做成 DSH 插件在架构上不成立**。
- ❌ 不做跨进程拆分（IPC/HTTP 独立服务）。
- ❌ 不把安全项（隐私闸门、凭据校验、篡改检测）纳入"实验性开关"。
- ❌ 不改写 `send` 的限流语义、不改 `access` 的权限判据。

---

## 2. 现状取证：五块的接缝清单

### 2.1 唤醒模块

**唯一的接缝点**：`src/bridge.mjs:662-679`

```js
// ② 唤醒判定
const decision = decideTrigger({          // ← 同步纯函数，立即出结论
  kind, text: rendered.text, mentioned: rendered.mentioned,
  raw, selfId: this.onebot.selfId,
  keywords: this.config.trigger.keywords,
  switches: this.config.trigger,          // ← 开关已经从这里进
})
if (!decision.respond) { …; return { handled: false, reason: … } }
this.stats.triggered += 1
```

上下文（决定了缝插在哪）：

| 位置 | 语句 | 说明 |
|---|---|---|
| `:649` | `await this.#verifyIdentity(...)` | 身份核实（协议端） |
| `:654` | `this.#mirror(mirrorKey, 'user', …)` | **先镜像**，即使不回复也让界面看见 |
| `:662` | **`decideTrigger(...)`** | ← 唤醒判定 |
| `:688` | `this.roster.decide(...)` | **准入校验**（名单 + 权限分级） |
| `:698-708` | 身份审计日志 | 两个来源分开写 |
| `:710` | `if (!verdict.respond)` | 拒绝分支 |

> ★ `:684-687` 明确写着"唤醒判定"与"准入校验"**刻意分开**，理由是日志里要能区分"被无视了还是被拒了"。
> **这给语义闸门定了一条硬约束：闸门必须插在 `:688` 之后**（即只对已准入的触发做判定）。否则任何未授权用户都能烧掉判定额度——那是一个免费的拒绝服务面。

### 2.2 Agent 工具面

| 面 | 落点 | 证据 |
|---|---|---|
| 工具暴露给 DSH 的机制 | **MCP profile 里的标记块** | `src/mcp-profile.mjs:33-34`（`# >>> qq-bridge: qq tools (MCP) — 由桥接自动维护，不要手改这段 >>>`）、`:43 writeMcpConfig`、`:73 ensureSdkProfilePatch` |
| 工具→权限分类 | `roster.mjs:122 classifyTool`，规则表 `MODIFY_TOOLS`(`:54`) / `MODIFY_QQ_TOOLS`(`:84`) / `READONLY_QQ_TOOLS`(`:94`) / `READONLY_TOOLS`(`:105`) |
| 工具→提示词段落 | `roster.mjs:143 buildPermissionInstructions`，用 `:202-216` 的三张清单渲染"你可以/不可以" |
| 当前已暴露的 qq 工具 | 仅 3 个只读：`qq_group_members / qq_message_detail / qq_group_history`（`roster.mjs:94`） |

工具面因此有**三个可独立的开关轴**：暴露（写不写 MCP 块）、权限分类（哪些算 modify）、提示词段落（要不要列出）。

### 2.3 人设

提示词是**一串 `lines.push`，顺序即缓存边界**。实测顺序（`bridge.mjs`，起点是 `:1552 const lines = [PLATFORM_RULES]`）：

```
PLATFORM_RULES(常量)  ← :1552  ┐
人设                  ← :1561  │ 稳定前缀
权限段落              ← :1567  │ （相对静态）
记忆段落              ← :1587  ┘
───────────────────────────────── 易变区从这里开始
任务段                ← :1607
配方库                ← :1625
origin(含分钟级时间戳) + 正文 ← :1631
图片说明              ← :1645-1662
```

人设文本来源：`bridge.mjs:238` 调用 `buildPersona({ … })`（`src/persona.mjs`，含 `PERSONA_PRESETS` 与 `lintPersona`）。

> ⚠️ **人设目前的"关"不是靠开关，是靠预设**：`config.example.json` 的 `persona` 块只有 `_说明 / _为什么重要 / callerName / preset / custom`，**没有 `enabled` 键**。今天的关闭方式是 `persona.preset = "none"`（`PERSONA_PRESETS.none = ''`）。
> 所以 §3 表里的 `persona.enabled` 是**新增键**，不是现有键。

> ★★ **顺序是费用问题，不是风格问题**。`:1573-1577` 与 `:1592-1596` 两处注释都写明：本项目实测 **prompt 前缀缓存命中率 91%~96%**，任何"把多变内容往前挪"的改动都会把最便宜的 token 变成最贵的。
> **因此人设块的改造只能是"段落提供者"的替换，不能是提示词顺序的重排。**

### 2.4 投递可靠性

| 环节 | 落点 |
|---|---|
| 投递入口 | `bridge.mjs:1825 async #deliver(kind, peerId, answer, result)` |
| 实际发送 | `this.onebot.send(kind, peerId, chunk)` — `:1868`（分片）与 `:1892`（整段） |
| 在飞追踪 | `:1478-1483`（`#inFlight`，解决"延迟期间被打断"） |
| 发送侧节流配置 | `config.example.json` 的 `send` 块：`minGapMs / maxGapMs / maxPerMinute / maxPerHour / dedupeWindowMs / maxCharsPerMessage` |
| 轮次超时 | `turn.timeoutMs` |

**缺口（本轮新发现）**：`takeReceipt()` 是**读后即删**（`memory-store.mjs:438-449`，注释"它只该被用一次"）。但它在 `bridge.mjs:1586` 于**提示词组装阶段**就被消费，而"投递成功"要到 `:1868/:1892` 才知道。所以：

> **投递失败 ⇒ 回执永久丢失** ⇒ 模型再也不会知道"上一条没记上"，用户也等不到"我没记住"那句。
> 这与 hermes 已验证的一条契约正好相反：`test_onebot_silence_contract.py:574-613` 断言**"传输失败不是模型违约"**，因此标记/状态类提交必须等投递确认（`adapter.py:3574`）。

→ 修法：回执改成**两阶段**（读到 → 暂存 → 投递成功后确认删除；投递失败或该轮未送达则保留）。

### 2.5 记忆

> ⚠️ **本节已移交**：记忆模块**不在本次插件化范围**，改由 `docs/memory-borrow-handoff.md` 单独处理（项目主人决定在另一会话施工）。本节保留仅作接口缝记录与耦合风险参考。

**⚠️ 与更早讨论的口径更正**：记忆目前**不是一个开关控两个轴**，而是**一个开关控两个轴**——请以本节为准。

| 轴 | 位置 | 是否受 `memory.enabled` 控制 |
|---|---|---|
| **剥离标记**（内部协议不外泄） | `bridge.mjs:1375-1376` `parseMemoryMarkers` → `answer = parsed.clean` | **否，无条件执行** ✅ |
| **落盘 + 回执** | `:1384-1416`（`applyMemoryItems` / `writeReceipt` / `noteMemoryAttempt` / `#checkZeroWrite`） | 是（`:1386`） |
| **注入召回 + 指令段** | `:1578-1587`（`verifyAndRestoreMemory` / `readMemoryForPrompt` / `takeReceipt` / `buildMemoryInstructionsV2`） | 是（`:1578`）**与上一条共用同一个键** |
| 轮次计数 `noteTurn` | `:1381-1383` | **否，无条件**（理由见 `:1377-1380`：告警判据是"跑了 N 轮却 0 条落盘"，只在有提议时记则最该告警的情况永不告警） |

`:1365-1371` 记录了一个**已经修过的真实缺陷**，正好印证"剥离必须独立于开关"：

> 原来整段在 `if (memory.enabled !== false)` 里 ⇒ 关掉记忆后标记**既不落盘也不剥离** ⇒ 对方在 QQ 里看到一整行 `<<<MEMORY fact …>>>`。
> **这是"关掉记忆"这个操作自己制造出来的泄露**——模型不知道开关状态，它照旧会提议。

**剩下的真缺口**：读轴与写轴**共用 `memory.enabled`**。两种真实需求现在都做不到：
- "记忆先留着，这段时间别注入"（省钱 / 排查）→ 做不到（关了就也不写了）
- "继续注入，但这段时间先别写"（观察 / 冷冻）→ 做不到

→ 修法：拆成 `memory.read` 与 `memory.write` 两个键，`memory.enabled` 保留为**总开关**（向后兼容：`enabled:false` ⇒ 两轴皆关）。

---

## 3. 开关矩阵

约定：
- **性质**列：`现有` = 今天 `config.example.json` 里已有的键（本轮实测 23 个顶层块逐键核对）；`新增` = 本设计要加的键。
- **默认列有值的，值即"关闭态"**（＝今天的行为）。

| 块 | 开关 | 性质 | 默认 | 关闭时 | 不可关项 |
|---|---|---|---|---|---|
| **唤醒** | `wake.mode` | 新增 | `"off"` | 只用 `decideTrigger` 规则判定（今天的行为） | — |
| | `wake.gate.enabled` | 新增 | `false` | 不调判定模型 | — |
| | `wake.gate.shadow` | 新增 | `false` | 判定照跑、结论只写 oplog | — |
| | `wake.continuation.enabled` | 新增 | `false` | 无对话态延长 | — |
| | *（现有）* `trigger.private/mention/keyword/groupEnabled` | **现有** | 见 `config.example.json` | 规则判定本身 | — |
| **工具面** | `tools.expose` | 新增 | `"current"` | 只暴露今天的 3 个只读 qq 工具（`roster.mjs:94`） | — |
| | `tools.promptSection` | 新增 | `true` | 不渲染"你可以/不可以"段落（`roster.mjs:143`） | — |
| | `tools.readonlyOnly` | 新增 | `true` | 强制只读档（安全默认） | — |
| **人设** | `persona.enabled` | **新增** | `true` | 不注入人设段 | `persona.lint`（工具名幻觉检查，`persona.mjs:133`） |
| | *今天的关闭方式* | **现有** | — | `persona.preset = "none"` | — |
| **投递** | `delivery.receiptTwoPhase` | 新增 | `false` | 回执读后即删（今天的行为，`memory-store.mjs:438`） | `delivery.dedupe`（幂等键）、`delivery.throttle`（限流，`send` 块） |
| | `delivery.idempotencyKey` | 新增 | `false` | 无幂等键 | — |
| **记忆** | `memory.enabled` | **现有** | `true` | 读+写皆关 | `memory.stripMarkers`（标记剥离） |
| | `memory.read` | 新增 | `true` | 不注入、不取回执（`bridge.mjs:1578`） | `memory.privacy`（隐私双侧闸门，`privacy.mjs`） |
| | `memory.write` | 新增 | `true` | 不落盘、不回执（`bridge.mjs:1386`） | `memory.tamperGuard`（篡改回滚，`memory-store.mjs:476`） |

> **记忆相关的行（最后三行）仅供参考，实施落在 `docs/memory-borrow-handoff.md`**（见 §2.5）。本设计只负责唤醒/工具面/人设/投递四块。

### 3.1 为什么"不可关项"必须显式列出

`memory.stripMarkers` 与 `delivery.dedupe` 这类**不是功能，是边界**。`bridge.mjs:1365-1371` 那次缺陷已经证明：**把它们混进功能开关，等于让"关掉功能"这个动作制造出新缺陷。**

**全量不可关项（共 5 条，建议在 schema 上标 `readonly: true`）：**

| 项 | 落点 | 关掉会怎样 |
|---|---|---|
| `memory.stripMarkers` | `bridge.mjs:1375-1376`（已无条件执行 ✅） | `<<<MEMORY …>>>` 泄漏到 QQ —— **已发生过的真实缺陷** |
| `memory.privacy` | `privacy.mjs` `screenForStore`/`screenForOutput` | 隐私双向失守 |
| `memory.tamperGuard` | `memory-store.mjs:476 verifyAndRestoreMemory` | 模型可绕过桥接改记忆且不回滚 |
| `delivery.dedupe` | `send.dedupeWindowMs` | 重连重放＝重复回复 |
| `delivery.throttle` | `send.minGapMs / maxPerMinute / maxPerHour` | 触发平台风控 |

这五条与 `credentials.mjs` / SSRF 同级：**安全项不参与实验性开关**。建议让它们在 config-ui 的可切换列表里**根本不出现**——而不是"出现了但灰色"。

---

## 4. 配置 schema 草案

> ⚠️ **本节是"草案"，最终落地的形状与它不同**（2026-09-27 已实施，以代码为准）：
> 实际用的是 **`wake.policy: 'rule' | 'semantic'`**（二选一，**一个键**）+
> **`wake.judge.{shadow,timeoutMs,maxPerHour}`**，**不是**下面的 `wake.mode: off|gate`
> + `wake.gate.*`。两处差异与理由：
> ① `off` **不是一个策略**，只是"没开" ⇒ 放进同一个键里当取值，会出现"两个都关"这种
>    无意义状态（`mode:'off'` 与 `gate.enabled:false` 是同一个状态的两种写法）；
> ② `gate.enabled` + `gate.shadow` 是**两个开关**，会出现 `enabled:false` 但
>    `shadow:true` 这种组合 —— "影子模式"本来就该是 `semantic` 内部的子设置。
> ③ `continuation` 按 §11.2 的结论**没做**（它唯一会新增消息量）。
> 完整的落地边界、三处收窄与"成本估算不成立"的更正见
> `docs/plugin-packaging-plan.md` §5.1，与 `src/wake-judge.mjs` 顶部。

沿用你们现有的 `_说明` 内联注释 + `enabled` 约定（`config.example.json` 已全篇如此）：

```jsonc
"wake": {
  "_说明": "实验性：语义唤醒判定。默认全关，关闭时行为与 0.2.0 完全一致。判定失败一律回落到规则结论。",
  "mode": "off",                         // off | gate
  "gate": {
    "_说明": "只在 roster 准入通过之后判定；直接触发（私聊/@）永不进判定。",
    "enabled": false,
    "shadow": false,
    "model": "",                         // 留空=用 dsh.model
    "timeoutMs": 6000,
    "onError": "rule",                   // rule | silent
    "maxPerHour": 120
  },
  "continuation": {
    "_说明": "对话态内延长响应窗口。会新增消息量，风控相关。",
    "enabled": false,
    "maxTurns": 10,
    "idleDecayMs": 600000
  }
}
```

配置校验落点：`src/config.mjs` 的 `normalizeConfig`(`:50`) 与 `validateConfig`(`:285`)。
**新键必须同时进 `mocks/verify-config.mjs`** —— 该文件头写明三条原则，第二条正是本设计最大的风险：

> ② 用户给的值必须真的生效（**防止键名写错导致静默失效**）—— "不报错、不崩，只是你设的值不生效"是最难排查的一类问题。

---

## 5. 接口契约：唤醒闸门最小实现

```js
/**
 * @param {object} input  {kind, peerId, senderId, text, mentioned, tier, recent[]}
 * @param {{signal: AbortSignal}} opts
 * @returns {Promise<{verdict:'answer'|'silent', reason:string, trace?:object}>}
 */
await judgeWake(input, { signal })
```

六条纪律（前四条是安全线）：

| # | 纪律 | 违反后果 |
|---|---|---|
| 1 | **必须有同步兜底**：抛错/超时 ⇒ 返回 `{verdict:'answer', reason:'fallback'}` | 判定器故障让 bot 变哑巴 |
| 2 | **必须接受 `AbortSignal`** | 新消息到来时旧判定无法取消，产生答非所问 |
| 3 | **必须无副作用**：只出结论，绝不自己发送 | 与 `#deliver`/`#inFlight` 打架 |
| 4 | **状态必须可随时丢弃**：清空后仍正确（只是少上下文） | 与"DSH 不能 resume"的现实冲突 |
| 5 | 插在 `bridge.mjs:688` **之后**，且 `kind==='private'`／`mentioned===true` 直接跳过 | 未授权者烧判定额度；@ 延迟劣化 |
| 6 | 中间产物绝不进聊天（复用 `#deliver` 前的清洗位） | 内部文本泄漏 |

**先做减法**：`gate` 只做"否决"，不新增回复。因此**不需要** hermes 的两级窗口、epoch、退出闸门、episode 状态机 —— 那套机器存在的唯一理由是"判定器可以主动发起回复"。
估算：`gate` 最小实现 ≈ 150~250 行（含 JSON 提取与兜底），而非移植 800~1500 行。

---

## 6. 阶段表

| 阶段 | 改动面 | 行为变更 | 验收 | 回滚点 |
|---|---|---|---|---|
| **P0** 抽缝 | ① `decideTrigger` 改为 policy 列表（现只含 rule policy）② 判定结论进 `oplog` | **零** | `pnpm test` 全绿；影子关闭时 oplog 无新增事件 | git revert |
| **P1** 工具面（**已提前，见 §12.5**） | `mcp/mcp-qq-server.mjs`：`qq_api` 白名单 + 档位过滤；`src/mcp-profile.mjs` 装配；`config.mjs` 两个键 | ✅ **已实现（第 7 轮）**：默认 `full` = 升级前的行为（**零回归**）+ 白名单修掉 `get_cookies` 漏洞 | §12.4 的用例；`verify-mcp-tools.mjs` 新增 11 条断言 | 配置开关（`mcp.profile` / `mcp.genericApi`） |
| **P2** 人设段落化 | 把 8 处 `lines.push` 收进**段表**（§13.3 契约）+ `persona.enabled`；段级失败沿用 `#warnInjectOnce` | 关掉人设 ⇒ 提示词少一段（其余段逐字不变） | §13.7 的 8 条用例，尤其**第 6 条（权限词扫描，回归 `:1503-1518` 事故）**与第 8 条（段序快照） | 配置开关 |
| **P3** 唤醒 gate 影子 | 判定器 + `shadow:true` | **零** | 跑 1~2 周，产出"本会拦掉 N 条"清单（§10.5） | 配置开关 |
| **P4** 唤醒 gate 生效 | `enabled:true` | 可能少回 | 直接触发零延迟（对比 `speed.mjs`）；**漏回率**低于门槛 | 配置开关 |

> ★ **P0/P3/P4 已在 0.2.3 一次性落地**（2026-09-27），但**命名与本表不同、且 P3 是默认态**：
> `wake.policy = 'semantic'` 就是 P3+P4 的合体，`wake.judge.shadow` **默认 true** ⇒
> 选 `semantic` 之后**先进入 P3（影子）**，要真的生效必须显式把 `shadow` 改成 false。
> 为什么把"影子"做成默认而不是先跑一段再改代码：判错成"沉默"的失败方向**没有提示**
> （那个人只是永远等不到回复），所以这道门槛必须在**配置**里，而不是靠人记得先开影子。
> P0（"抽缝"）**没有单独做** —— `decideTrigger` 保持原样、没有被改成 policy 列表；
> 闸门是加在它**外面**的一层。理由：`decideTrigger` 的矩阵本身没有第二套实现，
> 为了"将来可能有别的 policy"去改它属于投机抽象；而闸门放在 `handleEvent` 里
> 反而让"这一层只做减法"这件事在阅读时一眼可见。
| **P5** 投递可靠性 | ① E1 幂等键（键并入来源消息 ID）② E2 可选账本 ③ 部分投递留下已发记录 ④ 暴露"当轮投递结果"（供记忆 D1） | 默认关 ⇒ **零行为变更、零额外写盘** | §14.7 的 8 条用例，尤其第 1（关闭即零成本）与第 8（`markSent` 时机回归） | 配置开关 |

**已移出本表**：
- **记忆增强** → 移交 `docs/memory-borrow-handoff.md`（另一会话）；
- **`continuation` 与 `episodeState`** → **本期不做**，理由见 §11.2（它唯一会新增消息量，且需要 hermes 整套机器）。

**打包形态留到 P3 之后再定。** P0 做出来的缝如果接口是干净的，拆包只是搬文件；不干净的话不拆也是乱的。
**排序依据**：P1（工具面）提前是因为它**独立、低耦合、零 `#runTurn` 影响**，且收益是安全而非体验 —— 见 §12.5。

---

## 7. 测试计划（接现有惯例）

`mocks/` 已有 28 个 `verify-*.mjs` + `harness.mjs` + `mock-sdk-server.mjs` + `mock-onebot-server.mjs`。新增文件按现有命名：

| 文件 | 测什么 |
|---|---|
| `verify-wake.mjs` | 状态机与归一化的**纯函数**测试（不碰网络）；@ 不走 gate；未准入不进 gate；超时/401/垃圾 JSON/只回思考不回正文 → 全部回落 `answer` |
| `verify-config.mjs`（扩） | 新键的**默认值安全性** + **用户值真的生效** + 危险组合被警告 |
| `verify-memory-store.mjs`（扩） | `read`/`write` 两轴独立；`stripMarkers` 不受任一开关影响（**回归 `:1365-1371` 那个缺陷**） |
| `verify-oplog.mjs`（扩） | 影子模式只写不生效 |

「默认值安全」这条在 `verify-config.mjs` 里已有先例，本设计应沿用它：**关掉一切 = 今天的行为**，这条要有一条断言。

---

## 8. 决策状态

| # | 决策 | 状态 |
|---|---|---|
| 1 | 记忆是否作为第五块进目标？ | **已决：不进。** 记忆移交 `docs/memory-borrow-handoff.md`，在另一会话单独施工（含其两轴拆分与回执两阶段修复） |
| 2 | `gate` 插在 roster 之后还是 `decideTrigger` 旁？ | **已决：`bridge.mjs:719` 与 `:721` 之间**（roster 之后、`#runTurn` 之前、锁之外）。决定性理由：DSH 无法中止已开始的回合（`:1152-1156`），**∴ 否决只有在 `#runTurn` 之前才省得下那一轮成本** —— 见 §10.1 |
| 3 | P0 是否开工（改代码）？ | **已决：暂不开工，继续只讨论。** 本文档不含任何代码改动 |
| 4 | 闸门判定用哪个模型与预算？ | **待定**（见 §10.7） |
| 5 | `continuation`（对话态内延长响应窗口）做不做？ | **已决：本期不做。** 它唯一会"新增消息量"，与 `src/trigger.mjs:51-54` 的群聊风控立场冲突；且需要 hermes 整套窗口/epoch/退出闸门 —— 见 §11.2 |
| 6 | `episodeState`（16 字段对话状态）做不做？ | **已决：本期不做。** 它只服务 `continuation`；`gate` 需要的上下文用现成的 `#mirror`（`:969`，每会话 50 条，判定前已写好）—— 见 §11.4 |
| 7 | 工具面默认档位？ | **已决（第 7 轮，实测修正）**：默认 **`mcp.profile = 'full'`**（= 升级前的行为，零回归）。⚠️ 我先前的建议 `readonly` **被推翻**：它会把 `qq_send_image` 一起藏掉，而 P站发图链路正在用它。收紧改为**显式选择** |

**"只讨论"工作进度**：
1. ✅ `wake.gate` 完整时序图 → §10.3
2. ✅ "对话状态归属"方案 → §11.4（**结论：不必新建状态，`#mirror` 已够；`episodeState` 本期不做**）
3. ✅ 影子模式 oplog schema 与报表形态 → §10.4 / §10.5
4. ✅ `verify-wake.mjs` 用例清单（12 条）→ §10.6
5. ✅ `continuation` 取舍分析 → §11.2 / §11.3
6. ✅ **Agent 工具面详细设计**（原为空白）→ §12，含 8 条用例

**各块设计完成度**：

| 块 | 详细设计 | 位置 |
|---|---|---|
| 唤醒 | ✅ 已到实施级 | §5、§10 |
| 工具面 | ✅ 已到实施级（第 3 轮） | §12 |
| 人设 | ✅ 已到实施级（第 4 轮） | §13 |
| **投递** | ✅ 已到实施级（**本轮补齐**） | §14 |

**🎯 四块的实施级设计已全部完成，施工清单也已产出** → `docs/plugin-ization-changelist.md`
（逐阶段列出：哪个文件、哪一行、改什么、用哪条验收、怎么回滚；含"开工前 5 分钟检查表"与 P1 的 5 处文档同步清单。）

**剩下的全部是代码。** 非代码工作已经做完：
- 设计（本文件 §5、§10、§12、§13、§14）
- 改动清单与回滚路径（changelist，每阶段都带回滚方式）
- 跨会话接口约定（§13.6、§14.5 已回写 `docs/memory-borrow-handoff.md`）

**下一步只能是你放行**（见 §8 决策 3）：从 **P0（零对外行为变更的抽缝，`git revert` 可回滚）** 起最稳。
若你希望收口而非开工，也可以直接说："设计交付已完成、代码不在本次范围" —— 这份目标即视为完成。

---

## 9. 块与块之间的耦合风险（做插件时必须一起考虑）

| 咬合 | 风险 | 处理 |
|---|---|---|
| 人设 ↔ 记忆 | `buildMemoryInstructionsV2` 的输出**是人设提示词的一段**；人设段落化时记忆段必须仍是"可插拔段落"，不能被搬走 | P1 一起做 |
| 唤醒 ↔ 记忆 | `episodeState`（对话态）本质是短期记忆；若两者都插件化，**别出现两套"对话状态"各自演化** | P0 就把状态归一处 |
| 投递 ↔ 记忆 | §2.4 的回执丢失 | P4 一起修 |
| 工具面 ↔ 记忆 | **诱惑**：像 hermes 那样加 `memory_*` 工具，会绕开"落盘权归桥接" | 明确禁止（见 §1.2） |
| 任何改动 ↔ 缓存 | 提示词顺序 ＝ 费用（91%~96% 命中率） | 顺序重排必须当费用变更对待 |

---

## 10. 设计增补：`wake.gate` 实施细节（第 2 轮取证）

> 本节解决 §8 决策 2（闸门插入点），并给出时序、影子 schema、用例清单。**仍然不含代码改动。**

### 10.1 插入点：已决 —— `bridge.mjs:719` 与 `:721` 之间

```js
718       return { handled: false, reason: verdict.reason, peerId, senderId }
719     }
720
   ┌──  ★ 闸门插在这里（新增）
721     // ④⑤⑥ 串行执行（带上权限等级，提示词据此决定能不能"动手"）
722     return this.#runTurn({ … })
```

**三重理由（第三条是决定性的）**：

| # | 理由 | 依据 |
|---|---|---|
| ① | 必须在 `roster.decide(:688)` **之后** | 否则未授权用户能烧掉判定额度（免费的拒绝服务面） |
| ② | 必须在 `#withLock(chatKey)`（`:1186`）**之外** | 判定是 0~6s 的网络调用；放进锁里会造成同会话请求队头阻塞 |
| ③ | **必须在 `#runTurn` 之前** | ⬇️ 见下，这是本轮最重要的发现 |

**③ 的论证（经济性，不是风格）**：
本项目已经取证过一个硬限制（`bridge.mjs:1152-1156`）：

> 「确认过 DSH 的 SDK 只暴露 `initialize` / `session/prompt` / `shutdown`，**没有 `cancel`/`abort`/`steer`**……所以：**正在执行的那一轮无法中止，它会把 token 烧完**。」

推论：**`#runTurn` 一旦进入，那一轮 agent 的成本就注定发生。**
因此 —— **只有当否决发生在 `#runTurn` 之前，"沉默"才真的省钱。** 放在之后（例如放在投递层过滤）只能省下一条消息，省不掉那一轮。

而判定本身是**一次小模型调用**，比一整轮 agent（含工具循环，实测有过 40.8 秒 / 20 次工具调用的回合，`:1204-1205`）便宜一个数量级。
→ **即使判定只拦下一小部分消息，也是净收益。** 这条把 `gate` 从"体验优化"变成了"成本优化"，也让 §6 的 P3 优先级合理。

> ✅ **0.2.3 落地补充：这句话的前提当时并不成立 —— 后来补上了。**
> 上面那句"便宜一个数量级"隐含的前提是**直连一个小模型**。而本项目当时**没有直连模型
> API 的代码**，唯一可用的"额外一次调用"通路是**起一个一次性 DSH 进程**
> （`dsh --profile headless`，2.8~4.4 秒，还带着整套系统提示词与工具表）——
> 那条路**可能比一轮简单对话还贵**，于是这条论证在落地时**站不住**。
> **正确的修法是补上那条通路，而不是把估算改小**：0.2.3 新增
> `src/model-direct.mjs`（一次 `/chat/completions`），判定器默认走它 ——
> 实测 **1092ms**、一次 454 token 的小 completion。至此本节的论证**才真的成立**。
> 它同时解锁了此前卡在同一个缺口上的回合后抽取（R4b）。
> ★ 教训：**引用"便宜一个数量级"这类结论时，要连同它的前提一起引用** ——
> 否则下一个人会在前提不成立的环境里照着它做决策。

### 10.2 与三处既有机制的交互（都不需要新造轮子）

| 既有机制 | 位置 | 与闸门的关系 |
|---|---|---|
| **"新消息作废旧回合"**（supersede） | `#runTurn:1165-1184`（`#pending` + `token.superseded`） | ✅ **闸门在它之前，所以完全不受影响**。被否决的消息根本不进 `#runTurn`；放行的消息走原逻辑不变。**∴ 闸门不需要 epoch、不需要两级窗口、不需要退出闸门** —— hermes 那套机器的存在理由是"判定器能主动发起回复"，而本设计只做减法 |
| **interim（"先应一声"）** | `#runTurn:1211-1224`，`interim.afterMs ?? 8000` | ⚠️ **闸门超时必须 < `interim.afterMs`**，否则会出现"先弹了'我在想'，然后什么都没有"——比直接不回更怪。建议 `wake.gate.timeoutMs = 6000`（留 2s 余量）。这也解释了为什么 §4 草案里默认写 6000 |
| `#inFlight` | `:1479` | 只管**投递**在飞，与闸门无关 |

#### ⚠️ 本轮发现的一个顺序问题（闸门会把它从"无害"变成"费钱"）

`#runTurn` 里的**重复内容判定**在 `:1165-1177`，即**在闸门之后**：

```js
1165  const prior = this.#pending.get(chatKey) ?? null
1168  if (prior) {
1169    const sameAsInFlight  = prior.text === normalized
1170    const sameAsLastReplied = this.#lastDelivered.get(chatKey) === normalized
1171    if (sameAsInFlight || sameAsLastReplied) { … return { handled:false, reason:'duplicate' } }
```

今天这只是省一次 `#runTurn`；**加了闸门之后，一条重复消息会先白烧一次判定调用**才被判为 duplicate。
**修法（二选一，建议 A）**：
- **A**：把"重复内容"判定**前移到闸门之前**（它是纯内存比对，零成本，`normalized` 在 `:1166` 就已算好）；
- **B**：闸门内部读 `#pending` / `#lastDelivered` 短路（把状态耦合进闸门，不如 A 干净）。

### 10.3 时序（含取消与并发）

```
QQ 消息 A ──┐
            ▼
   #verifyIdentity(:649)  ── 有超时，绝不抛
            ▼
   #mirror(:654)          ── 界面立刻可见（即使最终不回）
            ▼
   decideTrigger(:662) ── respond=false ──▶ return no-trigger
            ▼ respond=true
   roster.decide(:688) ── respond=false ──▶ return denied
            ▼ respond=true
   ┌────────────────────────────── ★ 闸门 ──────────────────────────────┐
   │  kind==='private' || mentioned===true ?  → 直接放行（零延迟）      │
   │  命中 #pending/#lastDelivered 重复？     → 直接 duplicate（修法 A） │
   │  否则：judgeWake(input, {signal})                                  │
   │        ├─ verdict='answer'（含超时/报错兜底）→ 放行                 │
   │        └─ verdict='silent'                   → return no-wake      │
   └────────────────────────────────────────────────────────────────────┘
            ▼ 放行
   #runTurn(:1126)
      ├─ supersede 判定(:1165)   ← 若 A' 更新，A 作废（仍烧 token，无法中止）
      └─ #withLock(chatKey)(:1186)
           ├─ interim 定时器(:1214, 8000ms)   ← 必须晚于闸门超时
           ├─ rpc.prompt(:1270)  ← agent 成本在这里发生，且**之后无法中止**
           └─ 记忆/投递 …(:1358+, :1478+)
```

**并发语义**：`A` 判定在飞时 `B` 到达 → 两条消息**各判各的**（闸门在锁外，不互等）。
最坏后果 = "本可沉默却回了"（多花一轮），**不会**出现"该回却没回"。这是只做减法时的可接受取舍，也是不必引入 epoch 的原因。
代价上界由 `wake.gate.maxPerHour` 兜住。

**取消语义**：闸门必须接受 `AbortSignal`。触发取消的时机有两个：① 桥接关停（`close(timeoutMs=8000)`，`:1791-1806` 已有的优雅收尾路径，由 `index.mjs` 的 `shutdown` 在关掉 QQ 通道**之前**调用）；② 同 `chatKey` 出现更高优先级信号（可选，非必需 —— 闸门在锁外且判定很便宜，可以不做）。

### 10.4 影子模式：oplog 事件 schema

贴合 `oplog.mjs` 的既有契约：`appendOp({workspace, chatKey, op})` 会把行写成 `{ts, chatKey, ...op}`（`oplog.mjs:81`），并且**只对 `excerpt`（字符串）与 `args`（对象）做隐私筛选**（`:83-96`），同时有 2MB 上限（`:42`、`:100-102`）。

**拟用 schema**（`op` 部分）：

> ⚠️ **0.2.3 落地时更正了一处**：第一版这里写的是 `kind: 'wake'`，但 oplog 的**实际约定是
> `type`** —— `session-bridge.mjs` 的 `TurnCollector` 全用 `type`（assistant / tool/call /
> tool/result / approval / approval/decided / turn/end），而读取侧（`index.mjs` 的 `--ops`）
> 也是按 `r.type` 分支渲染的。照 `kind` 写下去的后果是**写进去了、读出来是 `undefined`**：
> `--ops` 会打出一行 `t?s?   undefined`，而且**没有任何东西会报错**。
> **∴ 字段名以读取方为准，现在是 `type: 'wake'`**（`mocks/verify-wake.mjs` 有一条断言钉着
> "`type` 必须存在且 `kind` 必须是 undefined"）。这条更正本身就是本项目反复踩到的那类缺陷：
> **两边的约定不一致，而不一致是静默的**。

```js
{
  type: 'wake',              // ← 以读取方（--ops）的约定为准（原稿写的是 kind）
  policy: 'semantic',
  verdict: 'answer' | 'silent',
  shadow: true,               // ← 影子模式标志：这一条没有改变行为
  fallback: false,            // 是否走了"判定失败→放行"兜底
  judged: true,               // 是否真的问了模型（false = 超预算 / 被取消 / 没配 cliPath）
  ms: 1830,                   // 判定耗时
  reason: '群友之间闲聊，未指向我',   // 判定器给的一句话理由
  excerpt: '<当前消息前 80 字>',      // ← 唯一会被 privacy.mjs 自动筛的字段
}
```

> ✅ **0.2.3 已兑现（原稿这里写的是"影子模式只兑现了一半"）**：报表已实现为
> `src/wake-report.mjs` + `node src/index.mjs --wake`，人工复核结果用
> `--wake --ok 1,3 --miss 2,4` 记进 `runtime/wake-labels.json`。实测形态见 §10.5 末尾。
> 原稿描述的症状（结论写进了 `runtime/oplog/<会话>-<天>.jsonl` 却"没有任何汇总入口"、
> `--ops` 把 wake 行打成 `t?s?`）现在都成立了 —— `--ops` 的渲染**仍然**看不懂 wake 行，
> 这是**故意的**：它按 `{turn}/{step}` 对齐，而 wake 行天生没有这两个字段。
> 补一个专门的读取方比把两种形状硬塞进一个渲染器干净。

三条纪律：
1. **绝不把上下文原文写进 op**（放数字与布尔就够；原文只在 `excerpt`，且靠 `screenForStore` 兜隐私）。
2. `appendOp` **绝不抛异常**（`oplog.mjs:62-64`），这符合闸门"无副作用"的要求。
3. **注意体积**：2MB / 约 300 字节 ≈ 7000 条。按每天 100 条触发算可撑约 70 天；若群里更活跃，影子期需要**采样**（如只记 `silent` 与 10% 的 `answer`），并在报表里说明采样率。

### 10.5 影子期报表形态

目标是一句话回答"**开了会怎样**"：

```
唤醒判定影子报告（近 N 天）
  判定次数        1,284
  本会拦掉          317  （24.7%）
  其中 @ 触发         0  （按设计，@ 永不进闸门）
  兜底放行           12  （0.9%，判定失败——说明判定器稳定性）
  中位耗时         1.83s  （p95 4.2s）
  判定成本         ≈ ¥0.42（并入 usage.mjs 的账外来源）

  ── 抽样人工复核（本会拦掉的 20 条）──
  [群 700000002] 群友A: 今天这个新番真不错
      → silent｜群友之间闲聊，未指向我        ✅ 判对
  [群 700000002] 群友B: 小鲸鱼你觉得呢
      → silent｜未检测到明确指向              ❌ 判错（该回却没回）★
```

**★ 这个抽样复核是影子模式的全部价值所在**：它把"该沉默"与"漏回"分开统计。
**建议加一条硬指标**：`漏回率`（人工复核中 ❌ 的比例）超过 X% 就**不允许开启** `gate`。这条要写进 §6 P3 的验收。

#### 10.5.1 实现形态与**与原稿的三处偏离**（0.2.3 实测）

`--wake` 的实际输出把上面那张草图改了三处，每一处都有理由：

| 原稿 | 实现 | 为什么改 |
|---|---|---|
| 单独一行「其中 @ 触发 0」 | **没有这一栏** | @ 的消息**根本不进闸门**（在 `#wakeContext` 之前就返回了）⇒ 这一栏恒为 0，是个永远不动的数字。**一个恒为 0 的指标会让人以为它在测什么** |
| 「判定成本 ≈ ¥0.42」 | 报 **token 数 + 行数**，并按价目表给估算 | oplog 里**不是每一行都有 usage**（早期记录没有这个字段）⇒ 直接给一个金额等于假装每一行都算过。实测 6 行里 3 行有 usage，所以报表必须**同时报"统计了几行"** |
| 近 N 天 | 报**实际窗口**（首行 ts ~ 末行 ts） | oplog 有 **7 天 TTL**（`OPLOG_TTL_DAYS`）。用户以为是"近 N 天"，实际可能只剩两天 —— 而这个差别会直接把"判定器很少沉默"读成结论 |

另外两件**没做**、且报表里如实说了的事：
1. **采样没实现**（§10.4 纪律 3 提到的"影子期需要采样"）。当前是每条判定都记，实测 wake 行 222~259 字节
   （带完整中文 `reason`/`excerpt` 时约 750 字节）；2MB/文件按 300 字节算是约 7000 条。**够用，但不是因为算过，是因为还没到。**
2. **判据错在"放过"方向时，影子里看不见** —— 影子模式只能测"本会拦下的对不对"，测不出"多回一句"的代价。
   这是它作为**验收工具**的固有边界，不是实现缺陷。

### 10.6 `verify-wake.mjs` 用例清单（覆盖 §5 六条纪律）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 判定抛异常 | `verdict='answer'`，`fallback=true`，**不改行为** |
| 2 | 判定超时（`timeoutMs` 到） | 同 1；且耗时 ≤ `timeoutMs + 余量` |
| 3 | 判定返回非 JSON / 空 body | 同 1（含"只回思考不回正文"的情形） |
| 4 | `kind==='private'` | 断言**从未调用**判定器（用 mock 计数） |
| 5 | `mentioned===true`（群内 @） | 同 4 |
| 6 | 未通过 roster 准入 | 同 4（**防未授权烧额度**） |
| 7 | `shadow:true` + `verdict='silent'` | 断言 `#runTurn` **仍被调用**；oplog 有 `shadow:true` 事件 |
| 8 | `enabled:false`（默认） | 断言判定器模块**未被 import/初始化**，且 `rpc.prompt` 调用序列与 0.2.0 一致 |
| 9 | 重复内容 + 闸门开启 | 断言判定器**未被调用**（§10.2 修法 A 的回归） |
| 10 | `maxPerHour` 超出 | 断言超限后直接放行（不静默）且日志明说 |
| 11 | `AbortSignal` 触发 | 断言立即返回 `answer` 且不抛 |
| 12 | 判定耗时 vs `interim.afterMs` | 断言 `timeoutMs < interim.afterMs`（配置校验层拦下不合法组合） |

第 8 条是"**默认关闭 = 今天的行为**"这条总要求的机器化验证 —— 也是最该先写的一条。

### 10.7 至此仍需你定的事项（只剩 1 条）

| # | 事项 | 建议 |
|---|---|---|
| 1 | 判定用哪个模型与预算（`wake.gate.model`、`maxPerHour`） | 用便宜的小模型（hermes 用 `temperature 0.1` + JSON 输出 + 每群并发 5）。预算按影子期数据定，**先不设上限**只记账 |
| ~~2~~ | ~~闸门插入点~~ | **已决**：`bridge.mjs:719` 与 `:721` 之间，理由见 §10.1（**否决必须在 `#runTurn` 之前才省钱**） |

---

## 11. `continuation` 取舍与对话状态归属（第 3 轮取证）

### 11.1 `continuation` 是什么、为什么诱人

hermes 有一条 `mode="continuation"`：一轮回答完，如果期间又来了新消息且仍在"对话态"，**自动排队下一轮**，不需要新的 @ 或关键词（`group_executor.py:82-95`）。诱人之处：群聊里"刚聊起来就断了"的体验确实差。

### 11.2 四个反对理由（结论：**本期不做**）

| # | 理由 | 依据 |
|---|---|---|
| 1 | **它唯一会"新增消息量"** | 另外四项（episode/gate/工具面/投递）都是**减法或零变化**。`src/trigger.mjs:51-54` 已写明群聊总开关**默认关闭**的理由是"群聊涉及账号风控" —— 让 bot 主动多说话，与这条既有立场直接冲突 |
| 2 | **它需要 hermes 那一整套机器，而其它能力都不需要** | 窗口、epoch、退出闸门、8 小时衰减、两次观测 —— 全是为了支撑"判定器能主动发起回合"。只做 `gate` 时这些**全部不需要**（§10.2）。引入 continuation 等于把移植成本从 ~200 行抬到 ~1000+ 行 |
| 3 | **DSH 无法中止已开始的回合** | `bridge.mjs:1152-1156` 已取证。continuation 会让"作废的回合"变多 ⇒ 烧掉的 token 变多，而作废机制（`:1178-1180`）**省不掉那一轮** |
| 4 | **它改的是产品决策，不是工程细节** | `docs/contracts.md` / `src/trigger.mjs:4-20` 记录的产品立场是"触发即必答，不存在沉默"。continuation 改变的是"什么算触发"，**这种改变应该由你决定，不该由一次插件化顺手带进来** |

### 11.3 结论与"如果将来要做"

**本期不做 `continuation`。** 因此：
- ✅ 上一轮 §8 列的最后一项待办（"对话状态归属"）**可以直接关闭** —— `episodeState`（`turn_count / current_thread / open_loops / progression_guidance` 等 16 字段）**只服务 continuation**，`gate` 不需要它。
- 如果将来要做，需要的最小集是：**状态字段表 + 状态写回时机 + 退出判据 + 消息量硬上限**，并且必须**单独立项**（同记忆 M7 的处理方式）。

### 11.4 但仍有一个必须现在说清的发现：**判定器的上下文不必新建状态**

我原来担心"判定需要历史上下文 ⇒ 要引入 `GroupState`"。**实测不必**：

`bridge.mjs:969 #mirror(chatKey, role, text, who)` 已经在维护**每会话最近 50 条**消息（`MAX_MIRROR_MESSAGES = 50`，`:749`，超限丢最早 `:1021-1022`），每条带：

```js
{ role: 'user'|'bot'|'notice', text, at: Date.now(),
  senderId, senderName?, senderRole? }        // :991-998
```

而且它在 **`:654`** 写入 —— **在 `decideTrigger(:662)` 之前**。所以闸门在 `:719` 取上下文时，`#mirror` 里已经有：
- 该会话最近 50 条（含 bot 自己发的，`role='bot'`，`:1871`）
- 每条的真实发言人身份（`senderName` / `senderRole`，**只在该条消息时核实过**才写，不编名字 `:1000`）

**∴ §10.4 里 `ctx: { recent: 10, ... }` 可以直接从 `#mirror` 取，零新增状态。**
这也顺手满足了她 §5 纪律 4（"状态必须可随时丢弃"）—— `#mirror` 本来就是纯内存镜像，重启即空，且系统在空状态下必须正确。

> **给闸门实现者的三条注意**：
> 1. `#mirror` 的 `role` 只有三档，**没有 `is_at` / `at_targets`**。若要给判定器"这条 @ 了谁"的信息，得从 `rendered`（`:664` 用的那个对象，含 `mentioned`）取，或在 `#mirror` 的 entry 上加字段（后者要一并考虑 `#mirrorThinking` 的 50 条上限与 `#conversations` 的内存占用）。
> 2. `#mirror` 是**给界面看的镜像**，不是"给模型看的上下文"。复用它等于把两者耦合 —— 如果将来镜像要改（比如界面需求变了），判定器的输入会跟着变。**建议在闸门里做一次显式投影**（只取需要的子集），而不是直接把 `#mirror` 数组递进去。
> 3. `#mirror` **不含**跨会话信息（它是 per-`chatKey` 的）。判定器拿不到"这个人在别的群说过什么"——这是对的（与记忆模块的隔离设计一致）。
>
> ⚠️⚠️ **0.2.3 落地实测：第 1 条是错的，而且后果很重 —— 镜像里有四种 role，不是三档。**
> `#mirrorThinking` 往**同一个 `messages` 数组**里推 `role: 'thinking'`（**模型的内部推理**，
> 存在于镜像里的唯一目的是"只给界面看"），另有 `role: 'notice'`（桥接自己发出去的提示）。
> 第一版只做了"字段投影"、**没有按 role 过滤**，于是：
> ① 判定器把**模型的内部推理当成"群里某人说的话"**读（那段推理里经常直接写着
> "这轮不用插嘴""群里在闲聊"）⇒ 等于**让它自己给自己投票**，身份还是错的
> （`buildJudgePrompt` 只认 `role==='bot'`，其余一律标成「某人」）；
> ② 那段推理**只该给界面看**，而判定提示词是**发出去**的（0.2.3 起还是直连 HTTP）。
> **∴ 投影必须按 role 用白名单过滤**（现在是 `user` / `bot`），并且在提示词组装那一层
> 再做一次显式判断 —— 以后镜像再长出别的 role（比如工具结果）默认**不会**被喂给判定器。
> 这条断言有**负对照**（关掉过滤后确实变红，报出的正是"某人：这轮是群里闲聊，我不用插嘴"）。
> ★ 教训：**"我做了投影"不等于"我投影对了"** —— 投影的字段与**筛选的条件**是两件事。

---

## 12. Agent 工具面设计（第 3 轮取证）

### 12.1 真实的暴露面：不只在 `roster.mjs`

前几轮我只写了 `roster.mjs` 的三张清单，**那是分类与提示词，不是暴露**。本轮找到了真正的暴露点：

| 层 | 落点 | 作用 |
|---|---|---|
| **① 工具声明** | `mcp/mcp-qq-server.mjs` 的 `TOOLS` 数组 | **模型能看到的工具清单就在这里**，共 **14** 个（⚠️ 初稿写 7 个，是读漏 —— 见下方更正） |
| **② 真正执行的闸门** | 同文件 `runTool()`（`:244-273`），按 `BLOCKED_ACTIONS`（`:53-75`）拦截 | **唯一硬闸** |
| **③ 装配到 DSH** | `src/mcp-profile.mjs:76-94` 写进 `profiles/sdk/cordis.patch.yml` 的**标记块**（`# >>> qq-bridge: qq tools (MCP) >>>`），注册 `@deepseek-ai/dsh-mcp-client`，`transport: stdio`、`serverName: qq` | 开关在这里关/开 |
| ④ 桥接侧分类与提示词 | `src/roster.mjs`：`MODIFY_TOOLS`(`:54`) / `MODIFY_QQ_TOOLS`(`:84`) / `READONLY_QQ_TOOLS`(`:94`) / `READONLY_TOOLS`(`:105`) → `classifyTool`(`:122`) + `buildPermissionInstructions`(`:143`) | 决定提示词怎么写"你能/不能做什么"，**不决定工具是否可见** |

**⚠️ 更正（第 7 轮实测）**：本节初稿写"7 个工具"，**这是读漏了 —— 实际是 14 个**。
完整清单（`mcp/mcp-qq-server.mjs` 的 `TOOLS`）：

```
只读（adminOnly:false）：qq_group_members  qq_message_detail  qq_group_history
                        qq_search_history  qq_at_all_remain
写入/互动（adminOnly:true）：qq_poke  qq_send_sticker  qq_send_image  qq_recall
                            qq_emoji_like  qq_typing  qq_forward_msg  qq_forward_log
万能口：qq_api            ← 动作由**模型自选**，所以黑名单对它是唯一防线
```

**∴ 只读的是 5 个（不是 3 个）**，写入侧 8 个 + 万能口 1 个。
`roster.mjs:94` 的 `READONLY_QQ_TOOLS` 只列了 3 个 —— 它**没跟上这 7 个新工具**，
所以它**不能**当作"哪些工具只读"的唯一判据（MCP 侧自带的 `adminOnly` 才是）。

### 12.2 ⚠️ 本轮发现：现有闸门是**黑名单**，且有两个已知漏口

`runTool` 的拦截逻辑（`:255-264`）：

```js
// ★ 黑名单拦截
const blockedReason = BLOCKED_ACTIONS[built.action]   // ← 按动作名查表
if (blockedReason) { return { isError: true, text: `我这边把这个动作禁用了：…` } }
const result = await callOneBot(built.action, built.params)
```

对具名工具，`built.action` 是固定值（如 `group_poke`），黑名单基本不参与。
**但 `qq_api` 的 `built.action` 是模型自选的任意字符串**（`:187` `build: ({action, params}) => ({ action: String(action), params })`）——
**∴ 对 `qq_api` 而言，这张黑名单就是全部防线。**

而 `BLOCKED_ACTIONS`（`:53-75`，15 条，写得很好、每条都带理由）**是 deny-list**。于是：

| 动作 | 是否在 `qq_api` 描述里被广告 | 是否在黑名单 |
|---|---|---|
| `get_cookies` | ✅ 广告了（`:177`） | ❌ **没有** |
| `upload_group_file` | ✅ 广告了（`:176`） | ❌ **没有** |
| `set_qq_profile` / `set_group_kick` / `delete_friend` 等 15 条 | 部分 | ✅ 有 |

**两个漏口的性质**（证据分级）：
- 【源码确证】`get_cookies` 与 `upload_group_file` 都不在 `BLOCKED_ACTIONS`，且都在 `qq_api` 的描述文本里被列为"常见可用动作"。→ 模型**被明确提示**了这两个动作可用，而闸门不拦。
- 【推测·未实测】`get_cookies` 若被 SnowLuma 实现，返回的是账号登录凭据（skey/p_skey 一类）⇒ **一条凭据读取路径**；`upload_group_file` 允许把**本机任意文件**上传到群 ⇒ **一条外发路径**。两条都属于"模型被提示词注入后可以主动做的事"。
- 【未取证】SnowLuma 是否真的实现了这两个动作、返回什么。**建议先做只读验证**（在测试环境调一次 `qq_api(action='get_cookies')` 看返回），再决定处置级别。

> **这条发现与本目标的关系**：它恰好是"**默认关闭、最小暴露**"原则在工具面上的具体形态。不需要新机制 —— 把 deny-list 换成 allow-list 就是这件事。

### 12.3 设计：deny-list → **allow-list（fail-closed）**，并挂上开关

`src/trigger.mjs:51-54` 已有先例：群聊总开关**默认关闭**（fail-closed），理由是"要确实想开才开"。
工具面应该用同一条纪律，而且**这一条的安全收益远大于前几轮讨论的任何一项**。

```
现状：默认全部可调  −  15 条黑名单        （fail-open）
目标：默认只有 3 个只读工具  +  显式放开才增加  （fail-closed）
```

**三个开关轴**（各自独立、可分别回滚）：

> ⚠️ **第 6 轮更正**：轴 A **不需要新增键** —— **`mcp.enabled` 已经存在**（`config.example.json` 的 `mcp` 块；`config-ui/src/sections/McpTab.tsx:37,52`；生效点 `index.mjs:1128 if (config.mcp?.enabled !== false)`，整段允许失败 `:1127`）。本设计原来提议的 `tools.enabled` 是**重复造键**，作废。

| 轴 | 开关 | 性质 | 默认 | 关闭/收紧时 |
|---|---|---|---|---|
| **A. 是否装配** | `mcp.enabled` | **现有键** | `true` | 不写 MCP 标记块 ⇒ DSH 里**没有 `mcp__qq__*` 工具**。`failOnStartupError:false`（`mcp-profile.mjs:92`）已保证"QQ 工具不是启动必需" |
| **B. 暴露档位** | `mcp.profile` | **✅ 已实现** | `"full"`（**= 升级前的行为，且经实测确认必须留作默认** —— `readonly` 会把 `qq_send_image` 一起藏掉，而 P站发图链路正在用它） | `readonly`＝只声明 `adminOnly:false` 的 5 个只读工具（见 §12.1 的更正清单）；`full`＝全部 14 个 | 个（**今天的实际行为**） |
| **C. 通用口** | `mcp.genericApi` | 新增 | `false`（**建议值**） | 不声明 `qq_api`。它是**最大风险面**（任意动作透传），建议默认关 |

**档位怎么传进去（一个能省很多事的实现选择）**：
`writeMcpConfig`（`mcp-profile.mjs:43`）已经在写 `cache/mcp-qq.config.json`，而 `mcp/mcp-qq-server.mjs` 的 `loadConfig()`（`:315`）已经在读它。
**∴ 把档位写进这个 JSON 即可 —— 不需要重写 `cordis.patch.yml`，也不必重启桥接去改 patch 文件。** 代价是 DSH 子进程需要重启才重新 `tools/list`（与 `mcp.enabled` 的现有行为一致，`index.mjs:1170` 的日志已经在说"重启 DSH 子进程后生效"）。

**外加两个不可关项**（§3.1 同类）：
- `BLOCKED_ACTIONS` 保留（黑名单**留着**，作为 allow-list 之外的第二层）；
- **allow-list 化**：`qq_api` 的动作必须命中显式白名单才放行（白名单 = 现有具名工具用到的动作 + 少数只读查询）。默认白名单要**不含** `get_cookies` / `upload_group_file` / 任何 `set_*` / `delete_*`。

**实现要点（避免踩坑）**：
1. `TOOLS` 数组是按 `tools/list` 一次性广告的，**档位切换要重新生成/重载** MCP 配置。`mcp-profile.mjs` 的 `writeJsonIfChanged`（`:53-61`）只比内容，**标记块变化会触发重写**——这正是幂等更新的用意，可直接复用。
2. `mcp/mcp-qq-server.mjs:46` 的 `SERVER_INFO.version = '0.2.0'` 是**硬编码的第二份版本号**（`package.json` 也是 0.2.0）。加档位后建议把档位写进 `SERVER_INFO` 或启动日志，便于排查"为什么工具少了"。
3. `cache/mcp-qq.config.json` 含 **token**（`mcp-profile.mjs:39-42` 明确写了"只写 cache、不进 git、不写 workspace"）。加档位**不要**把新配置写进 workspace。
4. 结果截断在 `runTool:271`（8000 字符）。档位变窄不影响它，但 `qq_api` 若保留，要考虑它对大结果的截断仍然够用。

### 12.4 验收与用例

| # | 用例（新增 `mocks/verify-mcp-tools.mjs` 或扩 `verify-mcp.mjs` / `verify-mcp-profile.mjs`） | 断言 |
|---|---|---|
| 1 | `tools.enabled=false` | `tools/list` 里**没有**任何 `qq_*`；`cordis.patch.yml` 里**没有**标记块 |
| 2 | `mcp.profile="readonly"` | `tools/list` 只剩 **5 个**（`adminOnly:false` 的那些）；直接调用被隐藏的工具也要被拒 | 
| 3 | `mcp.profile="full"`（**默认**） | **14 个**（**= 升级前的行为** —— 这是"默认即回到今天"的回归锚点） |
| 4 | `tools.genericApi=false`（默认） | `qq_api` 不在列表里 |
| 5 | allow-list：`qq_api(action='get_cookies')` | **被拒**，且错误文案说明"被禁用"（沿用 `:258-263` 的措辞风格） |
| 6 | allow-list：`qq_api(action='get_group_list')` | 放行 |
| 7 | 黑名单仍生效：任何 `set_group_kick` | 被拒（第二层防线未失效） |
| 8 | 配置写盘位置 | 新档位**不**出现在 workspace；`cache/mcp-qq.config.json` 仍含 token 且权限不变 |

第 3 条尤重要：它把"默认关闭 ≠ 破坏功能"变成可验证的断言 —— 与 §10.6 第 8 条同一思路。

### 12.5 §12 的结论

- 工具面的**开关是四块里最容易做、安全收益最大的一块**：改动集中在 `mcp/mcp-qq-server.mjs`（工具清单与闸门）+ `src/mcp-profile.mjs`（装配），**完全不碰 `bridge.mjs` 的回合逻辑**。
- 建议把它从 P4 **提前到 P0 之后**（即紧接抽缝），因为：① 独立、低耦合；② 收益是安全而非体验；③ 它对 `#runTurn` 零影响，回滚成本最低。

---

## 13. 人设段落化设计（第 4 轮取证）

### 13.1 现状接缝（实测）

| 件 | 落点 | 性质 |
|---|---|---|
| `PLATFORM_RULES` | `bridge.mjs:43`（模块常量） | 提示词**第一段**，`:1552 const lines = [PLATFORM_RULES]` |
| 段装配 | `#buildPrompt`(`:1494`) 内**硬编码 `lines.push` 序列** | 8 处：`:1561` 人设 / `:1567` 权限 / `:1587` 记忆 / `:1607` 任务 / `:1625` 配方 / `:1631` origin+正文 / `:1645-1662` 图片说明 |
| 人设文本 | `this.personaText`，**构造时算一次并缓存**（`:233-245`） | 注释写明理由："每轮都要用，而且内容不变"；配置写错预设时**刻意不吞异常**，但构造期兜底为 `''`（`:242-245`） |
| 段级错误隔离 | **已存在**：`#warnInjectOnce(what, error)`（`:531-544`） | 已用于任务段 `:1609`、配方段 `:1627`；语义："这一段只是上下文、不影响这一轮，但它意味着**该功能等于没有**（只报这一次）" |

**∴ 好消息**：段化的**机制雏形已经在了**（try/catch + 一次告警 + 空值即跳过），缺的不是机制，是**统一契约**。

### 13.2 ⚠️ 本轮发现：人设/装配段是**安全面**，不只是文案

`bridge.mjs:1503-1518` 记录了一次真实事故，而**这正是 `memory-store.mjs:7-15` 引用的那次记忆污染事故的根因**：

> 「这里原来是一段写死的 `who`：只要配了 `callerName` 就标"（…，管理员）"，否则一律标"（管理员）" —— 也就是说**每个在群里说话的人都被标注成管理员**。
> 后果有两层，第二层更严重：① 模型会照着这行字把说话人当成管理员，于是把他写进记忆（实测就是这样）；
> ② 这一行是**系统侧的可信信息**，和真正的权限段自相矛盾。模型看到的两个来源打架时，它更信"贴在人身上的标签"，于是可能因此答应本该拒绝的请求 —— 也就是把**权限判定从代码层泄漏成了提示词层的猜测**。」

这条因果链把两个模块连起来了：**记忆模块的"落盘权归桥接"只修了一半；另一半是修提示词装配段。**
∴ 人设段落化**必须**带着三条不变式做，且它们**不可关**（与 §3.1 的 5 条同类）：

| # | 不变式 | 现有正确做法 |
|---|---|---|
| **I1** | 只有**系统核实过**的事实才能加标签 | `:1527-1536`：`identity?.ok` 才写昵称/角色，查不到就只留号码，**不编名字** |
| **I2** | **权限声明只能来自权限段**；其他任何段不得出现权限词 | 权限段由 `roster.mjs:143 buildPermissionInstructions` 单独产出 |
| **I3** | 身份标签旁必须显式切断与权限的关系 | `:1530-1536`：`（群管理，身份来自协议端核实；**与权限无关**，能不能动手只看下面的权限段）` |

### 13.3 段契约（Segment contract）——**本设计定义，供人设与记忆共用**

现有 `lines.push` 序列的问题：段的**顺序、可选性、缓存归属、失败语义**全是隐式的（散在 8 处调用点 + 注释里）。

```js
/**
 * @typedef {object} PromptSegment
 * @property {string}  id       稳定标识（用于配置开关、日志、用例断言）
 * @property {'stable'|'volatile'} zone  必须落在提示词的哪个区（缓存不变式）
 * @property {number}  order    区内顺序
 * @property {boolean} optional false = 不可关（边界/安全段）
 * @property {(ctx) => string|Promise<string>} render  返回 '' ⇒ 不注入
 */
```

**四条不变式**：

| # | 不变式 | 依据 |
|---|---|---|
| **S1** | **zone 不可跨**：`stable` 段永不放 volatile 区，反之亦然 | `:1592-1596` 已说明：origin 带**分钟级**时间戳，其后必然每轮不同；把多变内容往前挪会打断几千 token 的前缀缓存 |
| **S2** | `optional:false` 的段**不参与开关** | 同 §3.1 |
| **S3** | `render` 抛错 ⇒ 该段跳过 + `#warnInjectOnce`，**不影响本轮** | 沿用 `:531-544` |
| **S4** | **段顺序变更＝费用变更**，必须显式记录 | 实测命中率 91%~96%（`:1573-1577`、`:1592-1596`） |

### 13.4 段的实测分区（按 §13.3 契约标注）

| zone | order | id | 现状 | optional |
|---|---|---|---|---|
| stable | 10 | `platform-rules` | `PLATFORM_RULES` `:1552` | ❌ **不可关**（平台硬规矩） |
| stable | 20 | `persona` | `:1561` | ✅ |
| stable | 30 | `permission` | `:1567` | ❌ **不可关**（I2） |
| stable | 40 | `memory` | `:1587` | ✅（**已移交**，见 §13.5） |
| volatile | 50 | `task` | `:1607` | ✅ |
| volatile | 60 | `recipes` | `:1625` | ✅ |
| volatile | 70 | `origin+body` | `:1631` | ❌ 不可关（本轮的正文） |
| volatile | 80 | `images` | `:1645-1662` | ✅（有图片才有） |

> ⚠️ **`memory` 落在 `stable` 区是本文档的一个判断，但它有一个内在矛盾**：记忆注入内容**会变**（有新条目），严格说它是稳定前缀里**最易变**的一段。这正是 `docs/memory-borrow-handoff.md` 的 **M4（冻结前缀快照）** 要解决的 —— **段化不负责这件事，段化只负责"把它排在稳定区、可开关"**；"会话内不变"由记忆段自己保证。见 §13.5。

### 13.5 人设段的开关与 lint

| 开关 | 默认 | 说明 |
|---|---|---|
| `persona.enabled` | `true`（**新增**） | `false` ⇒ 段返回 `''`。**与今天的 `preset:"none"` 的差别**：`none` 是"选了一个空预设"，`enabled:false` 是"关掉这一段"——后者语义明确，且不会与"预设名写错"混淆 |
| `persona.lint` | `true` | ❌ **不可关**。`persona.mjs:133 lintPersona` 查的是"人设里提到不存在的工具会诱发幻觉调用"（`:144-171` 记录了两次写错这个检查被测试抓出来的过程）。这是**防 prompt 层制造幻觉**的闸门，不是风格偏好 |
| `personaText` 缓存 | 保留 | `:233-236` 的理由（每轮要用、内容不变）仍然成立。**不要改成每轮重算**；要支持运行期开关就加一个显式 `refreshPersona()`，由"配置保存后"调用 |
| 构造期兜底 | 保留 | `:242-245`：人设坏 ⇒ 记日志 + 退回 `''`，**不让人起不来** |

### 13.6 ⚠️ 必须与已移交的记忆模块对齐的接口（否则两边的设计会不兼容）

记忆模块已移交到另一会话（`docs/memory-borrow-handoff.md`）。它的提示词段落**就是人设之后的第 4 段**（`:1587`）。两边的分工必须一次说清：

| 责任 | 归属 |
|---|---|
| 段的**位置、顺序、可开关、失败语义** | **人设段化（本节）** —— 记忆段声明 `zone:'stable'`, `order:40`, `optional:true` |
| 段**内容**（`buildMemoryInstructionsV2` 的输出） | **记忆模块** |
| "注入内容在会话内不变"（保护前缀缓存） | **记忆模块的 M4（冻结前缀快照）** —— 不是段化的职责 |
| 记忆不可关的安全项（剥离标记/隐私/篡改回滚） | **记忆模块**（其 §3-D2 已列出） |

**⟹ 这条约定已回写到 `docs/memory-borrow-handoff.md` 的 §0 与 M4**，免得两个会话各做一套。

### 13.7 验收与用例（扩 `mocks/verify-units.mjs`，或新增 `verify-prompt-segments.mjs`）

| # | 用例 | 断言 |
|---|---|---|
| 1 | `persona.enabled=false` | 提示词**不含**人设文本；其余段逐字不变 |
| 2 | `persona.enabled=true`（默认） | 提示词与 0.2.0 **逐字一致**（"打开即回到今天"的回归锚点） |
| 3 | 某段 `render` 抛错 | 该段缺席、其余段完整、`#warnInjectOnce` 只报一次（第二次不再报） |
| 4 | `zone` 不变式 | 若把 volatile 段排到 stable 区 ⇒ **配置校验拦下**（不是运行时才发现） |
| 5 | `optional:false` 的段 | 用开关去关它 ⇒ 无效且告警（`platform-rules`/`permission`/`origin+body`） |
| 6 | **I2 权限词扫描** | 除 `permission` 段外，其余段文本**不得出现**"管理员/权限/admin"等词（**回归 `:1503-1518` 那次事故**）—— 这条是本轮最有价值的断言 |
| 7 | `persona.lint` | 人设里写不存在的工具名 ⇒ 启动校验报警（`persona.mjs:133`） |
| 8 | 段顺序快照 | 稳定前缀的段序与本文档 §13.4 表一致（防无意重排导致缓存失效） |

第 6 条建议**做成自动化**：它把一次真实事故固化成机器可验证的不变式 —— 与 §10.6 第 8 条、§12.4 第 3 条同一思路（"把边界写成断言"）。

### 13.8 本节结论

- 人设段落化的**改动面很小**（把 8 处 `lines.push` 收进一个段表 + 加 `persona.enabled`），但**契约价值大**：它同时固定了人设、权限、记忆三段的边界与顺序。
- ⚠️ **风险不在实现，在顺序**：任何段序变动都会碰 91%~96% 的缓存命中率，因此 S4（顺序＝费用）必须写进 review 清单。
- ⚠️ **不能只当文案改动做**：§13.2 的 I1–I3 是安全不变式，且 §13.7 第 6 条能把它变成断言。

---



## 14. 投递可靠性设计（第 5 轮取证）

### 14.1 现状链路（实测）

```
#runTurn(:1126)
  └─ #deliver(kind, peerId, answer, result)(:1825)
       ├─ ① 观感分条 splitIntoMessages(maxChars = humanize.chunkChars ?? 300)(:1827)
       │    再按 send.maxCharsPerMessage ?? 1500 硬切 splitForQQ(:1830-1831)
       ├─ ② 拟人延迟 computeReplyDelay → #sleepUnlessClosing(:1833-1850)
       │    ★ 收尾中 ⇒ **跳过剩余延迟立刻发**(:1842-1849)：回复已生成、成本已付，
       │      丢掉比少等几秒更糟
       └─ ③ 逐片投递(:1852-1876)
            sendQueue.check(chunk) → skip / wait → **复检**(:1861) → onebot.send
            → sendQueue.markSent(:1869) → 镜像(:1871)
            ※ 发送失败 ⇒ **throw**(:1872-1874) ⇒ 剩余分片不再发送
  └─ await delivering(:1481) → 成功后 #lastDelivered.set(chatKey, normalized)(:1486)
```

**`SendQueue`（`onebot.mjs:315-382`）** 三道闸：

| 闸 | 参数 | 说明 |
|---|---|---|
| 内容去重 | `dedupeWindowMs = 8000`，键＝**分片全文**，`#recent` **仅内存** | `check:343-346` |
| 每分钟 / 每小时 | `maxPerMinute = 8` / `maxPerHour = 500` | `check:349-356` |
| 拟人间隔 | `minGapMs = 1000` ~ `maxGapMs = 3000` 随机 | `check:358-362` |

**已有一条极重要的既有纪律**（`:341-342`）：

> 「只在**发送成功后**才记账（见 `markSent`）。若在检查时就记账，一次合法重试会被误判成重复而丢失。」

### 14.2 ⚠️ 更正：现有去重**已经是**幂等（本节初稿的缺口分析是错的）

**第 8 轮实测（2026-09-27）**：本节初稿说"键＝分片全文、不含来源消息 id"—— **不成立**。实际：

- `src/transport.mjs:175` 有 `deliveryKey({chatKey, text, replyTo, faceId})`；
- `src/onebot.mjs` 的 `SendQueue.check(text, key = null)` / `markSent(text, key = null)` **接受调用方给的键**（`:405`/`:439`，`this.#recent.set(key ?? text, now)`）；
- `src/bridge.mjs:2353` 每次投递都传：
  `deliveryKey({ chatKey: \`${kind}:${peerId}\`, text: chunk, replyTo: isFirst ? replyTo : null, faceId: isLast ? faceId : null })`
- 而那里的注释（`:2350-2352`）描述的 bug ——「用裸文本当键时，同一句话 8 秒内发给两个不同会话会被误判成重复而丢掉第二个」—— **正是本节初稿想提的问题，而它早已被修好**（H9）。

**∴ 本节的 E1（幂等键）与 E2（投递账本）都已存在**，且 E1 比初稿的方案更完整（多带了 `replyTo` / `faceId`）。
**仍然成立的部分**：`#recent` 是**仅内存**的（跨重启失效）——但账本（`delivery-ledger.mjs`）已经承担了"跨重启可查"的职责，两者分工正确。

**本节的实际结论**：投递块**没有需要新建的功能**，只剩"给账本一个开关 + 登记成插件"（0.2.3 已做，见 §14.6 的更正）。

### 14.2-old（初稿的缺口逐条对照，保留以便对照）

| 维度 | 现状 | 缺什么 |
|---|---|---|
| 键的构成 | 分片**全文** | 不含**来源入站消息 ID** ⇒ 无法回答"这条回复是为哪条消息发的" |
| 存储 | `#recent` **内存 Map** | **重启即失忆** ⇒ 崩溃/重启后的重放无法识别 |
| 生效窗口 | 8 秒 | 重连重放可能晚于 8 秒 |
| 记账时机 | **发送成功后** ✅ | 这条是对的，保留 |
| 有无持久记录 | ❌ 无 | 无法识别"已生成但未发出"的投递（at-least-once 所需） |

> ⚠️ **一个必须分清的概念**：hermes 的 `_is_duplicate`（`adapter.py:2614-2631`，`msg_id` **30 秒 TTL**）是**入站**去重；本节的幂等键是**出站**去重。**两者都要，但别混为一谈** —— 入站去重挡"同一条消息被处理两次"，出站幂等挡"同一条回复被投递两次"。

### 14.3 设计：两个独立开关（都默认关）

#### E1 `delivery.idempotencyKey`（默认 `false`）—— 几乎零成本，建议较早开

把**来源入站消息 ID** 并入去重键：

```
key = sha256(sessionId | sourceMsgId | chatKey | replyTo | text)[:32]
```

（key 形状参考 hermes `contract.py:335-344` 的 `DeliveryIntent.idempotency_key`。）

- 改动面：`SendQueue.check/markSent` 增加一个可选 `key` 参数；`#deliver` 传入 `sourceMsgId`（`#runTurn` 的上下文里有它 —— `rendered`/`event`）。
- 为什么**先做它**：**纯内存、零额外 I/O**，成本≈一次 hash。它补的是"键的构成"，不是"跨重启"。
- ⚠️ 它**不能**单独解决"重启后重放"——那需要 E2。

#### E2 `delivery.ledger`（默认 `false`）—— 唯一会"每次投递都写盘"的项

发送前落账、成功后标记，用于跨崩溃识别。

- **为什么默认关**：它是四块十几个开关里**唯一给每次投递增加一次写盘**的项。目标要求"关闭时零成本"，所以默认必须关；开了以后成本要能被 `usage.mjs`/`oplog` 计量。
- **参考 hermes `gateway/delivery_ledger.py` 的四个细节**（都很实用）：
  1. 状态机 `pending → attempting → delivered|failed`（`:180`、`:233-242`）；
  2. **所有权用 `(pid, 进程启动时间)`** 而不是 pid —— 避免 PID 复用被误判为"活着的持有者"（`:113-140`）；
  3. **重复生产者不能复活已 `delivered` 的行**：`WHERE obligation_id=? AND state <> 'delivered'`（`:195-203`）；
  4. 上限：`MAX_ATTEMPTS=3`、陈旧 24h、保留 7 天、`MAX_ROWS=500`（`:30-35`）。
- 落点建议：与 `oplog` 同域（`runtime/` 下），复用其"绝不抛异常 + 体积上限 + 隐私筛选"纪律（`oplog.mjs:62-64`、`:42`、`:83-96`）。

### 14.4 一个不是开关、而是设计决策的问题：失败时的部分投递

`#deliver` 在分片失败时 **throw 中止剩余分片**（`:1872-1874`）。两种语义：

| 语义 | 优点 | 缺点 |
|---|---|---|
| **fail-fast（现状）** | 半失败状态下不继续刷屏；不会加剧风控 | 长回复被截断，且**已发出的分片没有记录** ⇒ 无法诊断"发了一半" |
| 尽力发完 + 记录 | 内容完整 | 连发失败还硬发，可能触发风控 —— 与 `send.*` 节流的存在理由冲突 |

**建议：保留 fail-fast，但把"已发出的分片"记下来**（进日志，或 E2 开启时进账本）。理由：静默的部分投递正是这个项目一直在防的失败模式（对照 `memory-store.mjs:411-413` 的同一条原则）。

**★ 同时要点出一个现存的正确性（别改坏）**：`#lastDelivered.set(chatKey, normalized)` 在 `:1486`，**在 `await delivering` 之后**。
∴ **投递失败时不更新 `#lastDelivered`** ⇒ 用户重发同一内容**不会**被误判为重复（`:1170` 的 `sameAsLastReplied` 判据不成立）。这是对的，且它依赖"await 之后才写"这个顺序 —— **任何把这一行前移的重构都会破坏它**。

### 14.5 ⚠️ 跨块依赖：投递块是**记忆块 D1 的前置**

`docs/memory-borrow-handoff.md` 的 **D1** 要求"记忆回执必须绑定投递成功，而不是绑定读到了"。而回执目前在 `bridge.mjs:1586` 于**提示词组装阶段**就被 `takeReceipt` 读后即删。

**∴ 要把 D1 做对，必须先有"这一轮投递成功了吗"这个信号能传到记忆回执的消费点。**

最小形态**不需要**完整账本（E2），只需要：
```
#deliver 的最终结果（成功 / 部分 / 失败） ──▶ 一个可查询的当轮结果
                                          └─▶ 记忆回执据此决定"确认删除"还是"保留"
```

**建议的落地顺序**：`14.4` 的部分投递记录 → 暴露"当轮投递结果" → 记忆块接 D1。**已回写到 handoff 的 D1**（见其 §3-D1 的"前置"一条）。

### 14.6 开关矩阵与不可关项（补 §3 的投递部分）

| 开关 | 性质 | 默认 | 关闭时 |
|---|---|---|---|
| `delivery.idempotencyKey` | 新增 | `false` | 去重键仍是分片全文（今天的行为） |
| `delivery.ledger` | 新增 | `false` | 无账本、零额外写盘（今天的行为） |
| `send.minGapMs / maxGapMs / maxPerMinute / maxPerHour` | **现有** | 见 `config.mjs:125-128` | ❌ **不可关**（风控） |
| `send.dedupeWindowMs` | **现有** | `8000` | ❌ **不可关** |
| `markSent`-after-success 纪律 | — | — | ❌ **不可关**（`:341-342` 的既有理由） |
| `#safeSend` 的"不加重试、不加拟人延迟"边界 | — | — | ❌ **不可关**（`:1887-1888` 的既有理由：出错通知要尽快到达） |
| `humanize.enabled` / 拟人延迟 | **现有** | 见 `config.example.json` | ✅ 可关（已有开关） |

**∴ E2（账本）绝不可应用于 `#safeSend`** —— 那条路径的设计意图就是"尽力而为、失败即放弃"。把账本套上去会让"发不出去的报错通知"反复重试。

### 14.7 验收与用例（新增 `mocks/verify-delivery.mjs`，并扩 `verify-onebot.mjs`）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 两个开关都关（默认） | 与 0.2.0 **行为逐字一致**；`runtime/` 下**无新增文件**（"关闭即零成本"的机器化验证） |
| 2 | `idempotencyKey=true`：同 `sourceMsgId` 的同文本投递两次 | 第二次被拦，理由指向幂等键而非"内容重复" |
| 3 | 不同 `sourceMsgId`、同文本 | **放行**（这正是今天会被 8 秒内容去重误拦的情形 —— 回归点） |
| 4 | `ledger=true`：发送前落 `pending`、成功后 `delivered` | 状态转换可观测 |
| 5 | 模拟崩溃后重启 | `pending` 行可被识别为"未完成"，且**不会复活已 `delivered` 的行** |
| 6 | 分片中途失败 | fail-fast（剩余不发）**且已发分片有记录**；`#lastDelivered` **未更新** ⇒ 同内容重发不被判重复 |
| 7 | `#safeSend` 失败 | 不进账本、不重试（边界） |
| 8 | `markSent` 时机 | 断言记账发生在 `onebot.send` **成功之后**（回归 `:341-342` 的纪律） |

第 3 条与第 8 条是**回归锚点**：它们锁住现有正确行为，防止"加幂等"时把今天的 8 秒内容去重改坏。

### 14.8 本节结论

- 投递块是四块里**现状最健康**的一块：节流三道闸、`markSent` 时机纪律、收尾跳过延迟、只镜像真正发出的分片、`#lastDelivered` 的更新顺序 —— 都做对了且都有"为什么"的注释。
- 所以本块的改造是**加法**（幂等键 + 可选账本），**不是重构**。这也意味着**风险最低、最容易回滚**。
- 唯一需要动脑的不是代码而是**语义决策**（§14.4 的部分投递），以及一个**跨块依赖**（§14.5：投递结果是记忆 D1 的前置）。

---

## 15. 核验命令（复核本文件结论）

以下命令**本轮已实跑**，结论与本文档一致：

```powershell
cd packages\qq-bridge

# ① 唤醒接缝 + 准入顺序：decideTrigger(:662) 在 roster.decide(:688) 之前
Select-String src\bridge.mjs -Pattern 'decideTrigger|roster\.decide|#verifyIdentity'

# ② 记忆"一开关控两轴"：memory?.enabled 恰好出现 2 次（读 :1578 / 写 :1386）
Select-String src\bridge.mjs -Pattern 'memory\?\.enabled'

# ③ 提示词顺序与缓存边界：起点 :1552 const lines = [PLATFORM_RULES]
Select-String src\bridge.mjs -Pattern 'lines\.push'
Select-String src\bridge.mjs -Pattern 'const lines = \['

# ④ 工具面机制：MCP 标记块
Select-String src\mcp-profile.mjs -Pattern 'MARK_BEGIN|ensureSdkProfilePatch'

# ⑤ 配置校验惯例与三原则
Select-String src\config.mjs -Pattern 'normalizeConfig|validateConfig'
Get-Content mocks\verify-config.mjs -TotalCount 30   # ← 注意：该文件是 UTF-8，PS 默认编码会乱码，加 -Encoding utf8

# ⑥ 回执读后即删
Select-String src\memory-store.mjs -Pattern 'takeReceipt|unlinkSync'

# ⑦ 现有键盘点（确认哪些是"现有"、哪些是"新增"）
node -e "const c=require('./config.example.json');for(const k of Object.keys(c))console.log(k, JSON.stringify(Object.keys(c[k])))"

# ── 第 2 轮（§10 的取证）────────────────────────────────────────────
# ⑧ 闸门插入点：roster 拒绝分支收尾(:719) 与 #runTurn 调用(:722) 之间是空档
Select-String src\bridge.mjs -Pattern '#runTurn\(\{|verdict\.reason, peerId'

# ⑨ DSH 无中止能力（§10.1 决定性理由的来源）
Select-String src\bridge.mjs -Pattern 'cancel/abort/steer|无法中止|把 token 烧完'

# ⑩ 既有 supersede 机制 + 重复内容判定位置（§10.2）
Select-String src\bridge.mjs -Pattern '#pending|superseded|sameAsInFlight|#lastDelivered'

# ⑪ 锁与 interim 定时器（并发与超时约束）
Select-String src\bridge.mjs -Pattern '#withLock|interim\.afterMs|afterMs \?\?'

# ⑫ oplog 契约（影子 schema 必须贴合）
Select-String src\oplog.mjs -Pattern 'export function appendOp|screenForStore|OPLOG_MAX_BYTES'

# ⑬ 收尾在飞列表（AbortSignal 的取消时机之一）：方法是 close(timeoutMs=8000)
Select-String src\bridge.mjs -Pattern '#inFlight|async close'

# ── 第 3 轮（§11 / §12 的取证）──────────────────────────────────────
# ⑭ 判定器上下文来源：每会话 50 条镜像，在 :654 判定之前就写好（§11.4）
Select-String src\bridge.mjs -Pattern '#mirror\(|MAX_MIRROR_MESSAGES|#conversations'

# ⑮ 工具面的真实暴露点：TOOLS 数组（§12.1）
Select-String mcp\mcp-qq-server.mjs -Pattern "name: 'qq_|SERVER_INFO|BLOCKED_ACTIONS"

# ⑯ ★ 核心发现：闸门是黑名单；qq_api 的动作是模型自选的（§12.2）
Select-String mcp\mcp-qq-server.mjs -Pattern 'blockedReason|BLOCKED_ACTIONS\[|action: String'
#   然后人工核对：qq_api 描述里广告的动作 vs BLOCKED_ACTIONS 的键
Select-String mcp\mcp-qq-server.mjs -Pattern 'get_cookies|upload_group_file'
Select-String mcp\mcp-qq-server.mjs -Pattern "'set_|'delete_"

# ⑰ 装配点与幂等写（档位切换要复用这套）
Select-String src\mcp-profile.mjs -Pattern 'MARK_BEGIN|writeJsonIfChanged|failOnStartupError'

# ── 第 4 轮（§13 的取证）────────────────────────────────────────────
# ⑱ 段装配是硬编码 lines.push 序列 + 起点常量
Select-String src\bridge.mjs -Pattern 'const PLATFORM_RULES|lines\.push'
Select-String src\bridge.mjs -Pattern 'const lines = \['

# ⑲ 段级错误隔离已存在（段契约 S3 直接复用它）
Select-String src\bridge.mjs -Pattern '#warnInjectOnce'

# ⑳ 人设文本在构造期算一次并缓存（不要改成每轮重算）
Select-String src\bridge.mjs -Pattern 'personaText|buildPersona'

# ㉑ ★ 核心发现：人设/装配段是安全面（§13.2 的事故根因）
Select-String src\bridge.mjs -Pattern '每个在群里说话的人都被标注成管理员|与权限无关|identity\?\.ok'

# ── 第 5 轮（§14 的取证）────────────────────────────────────────────
# ㉒ 投递链：分条 → 拟人延迟 → 逐片 check/复检/send/markSent
Select-String src\bridge.mjs -Pattern '#deliver|sendQueue\.check|sendQueue\.markSent|throw error'
Select-String src\bridge.mjs -Pattern '#lastDelivered'

# ㉓ SendQueue 三道闸 + "发送成功后才记账"纪律（§14.1 / §14.2）
Select-String src\onebot.mjs -Pattern 'check\(text\)|markSent|#recent|dedupeWindowMs|maxPerMinute'

# ㉔ 装配点：SendQueue 由 index.mjs 构造
Select-String src\index.mjs -Pattern 'new SendQueue'

# ㉕ 现有 send 块默认值（确认哪些是"现有"键）
Select-String src\config.mjs -Pattern 'maxPerMinute|dedupeWindowMs|maxCharsPerMessage'
```

**第 1 轮实跑结论（三处修正了初稿的假设）：**

| 初稿假设 | 实测结果 |
|---|---|
| `persona.enabled` 可能是现有键 | ❌ 不存在。`persona` 块只有 `_说明/_为什么重要/callerName/preset/custom`；今天的关闭方式是 `preset="none"` |
| 记忆"已经是两轴" | ⚠️ 部分对：**剥离**轴确实已独立（`:1375`），但**读/写两轴共用 `memory.enabled`**（`:1578` 与 `:1386` 各一次） |
| 提示词顺序大致如此 | ✅ 确认，且起点是 `:1552 const lines = [PLATFORM_RULES]`，稳定前缀＝PLATFORM_RULES+人设+权限+记忆 |

**第 2 轮实跑结论（支撑 §10）：**

| 待证事实 | 实测结果 |
|---|---|
| 闸门插在哪 | ✅ `:719`（roster 拒绝分支收尾）与 `:722`（`return this.#runTurn({`）之间是干净空档 |
| 否决能不能省钱 | ✅ **能，但只有放在 `#runTurn` 之前**。`:1152-1156` 已取证 DSH SDK 只暴露 `initialize`/`session/prompt`/`shutdown`，**无 `cancel`/`abort`/`steer`**，故已开始的回合"会把 token 烧完" |
| 要不要新造 epoch | ❌ 不需要。`:1165-1184` 已有 `#pending` + `token.superseded` 的"新消息作废旧回合"机制，且闸门在它**之前**，互不干扰 |
| 闸门超时该多大 | ✅ 由 `interim.afterMs ?? 8000`（`:1223`）反推：必须 < 8000，建议 **6000**，否则出现"先弹'我在想'然后什么都没有" |
| 是否占锁 | ✅ `#withLock(chatKey)` 在 `:1186`（`#runTurn` 内），闸门在它之前 ⇒ **判定不占锁**，无队头阻塞 |
| 重复消息会不会白烧判定 | ⚠️ **会**。重复内容判定在 `:1165-1177`，闸门在它之前。§10.2 给修法 |

**第 3 轮实跑结论（支撑 §11 / §12）：**

| 待证事实 | 实测结果 |
|---|---|
| 判定器要不要新建状态存上下文 | ❌ 不用。`#mirror`（`:969`）已在维护**每会话最近 50 条**（`MAX_MIRROR_MESSAGES=50`，`:749`），且写在 `:654` —— **判定之前**。每条含 `role/text/at/senderId/senderName/senderRole` |
| `continuation` 值不值得做 | ❌ **本期不做**（§11.2 四条理由）。连带 `episodeState` 也关闭 —— 它只服务 continuation |
| 工具面的暴露点在哪 | ⚠️ **不在 `roster.mjs`**（那是分类与提示词），而在 `mcp/mcp-qq-server.mjs` 的 `TOOLS`（`:78-189`）+ `runTool` 的 `BLOCKED_ACTIONS` 拦截（`:244-273`） |
| 现有工具闸门是白名单还是黑名单 | ❌ **黑名单**（`:256`）。而 `qq_api` 的动作是模型自选字符串（`:187`）⇒ 对 `qq_api` 而言黑名单是**唯一**防线 |
| 黑名单有没有漏口 | ⚠️ **有两个**：`get_cookies`（`:177` 被广告，**不在**黑名单）与 `upload_group_file`（`:176` 被广告，**不在**黑名单）。详见 §12.2（含证据分级与"建议先只读验证 SnowLuma 是否实现"） |
| 工具面改动会碰 `bridge.mjs` 吗 | ❌ 不会。改动集中在 `mcp/mcp-qq-server.mjs` + `src/mcp-profile.mjs` ⇒ 这是四块里**耦合最低**的一块，故 §6 把它提前到 P1 |

**第 4 轮实跑结论（支撑 §13）：**

| 待证事实 | 实测结果 |
|---|---|
| 段化机制要不要从零建 | ❌ 不用。**雏形已在**：`#warnInjectOnce`（`:531-544`，try/catch + 只报一次 + 空值即跳过）已用于任务段(`:1609`)与配方段(`:1627`)。缺的是统一契约，不是机制 |
| 人设能否运行期开关 | ⚠️ `personaText` 在**构造时算一次并缓存**（`:233-245`，理由"每轮都要用、内容不变"）。∴ 保留缓存 + 加显式 `refreshPersona()`，**不要**改成每轮重算 |
| ★ 人设段是不是纯文案 | ❌ **不是，是安全面**。`:1503-1518` 记录了真实事故：origin 行的 `who` 写死"（管理员）"⇒ 每个群发言人都被标成管理员 ⇒ ① 模型把他写进记忆 ② 与权限段自相矛盾 ⇒ **权限判定从代码层泄漏成提示词层猜测** |
| 这条事故与记忆模块什么关系 | ✅ **就是同一次事故的两半**。`memory-store.mjs:7-15` 记录的"模型把普通群友写成管理员"其**根因在提示词装配段**；记忆模块的"落盘权归桥接"只修了另一半 |
| `memory` 段属于 stable 还是 volatile | ⚠️ **判断为 stable，但内含矛盾**：其内容会变。∴ 段化只管"排在稳定区、可开关"，"会话内不变"由记忆模块的 M4（冻结前缀快照）负责 —— 分工已回写进 handoff（§13.6） |

**第 5 轮实跑结论（支撑 §14）：**

| 待证事实 | 实测结果 |
|---|---|
| 投递链路长什么样 | ✅ `#deliver`(`:1825`)：观感分条(`:1827`) → 硬切(`:1830-1831`) → 拟人延迟(`:1833-1850`) → 逐片 `check`/复检(`:1861`)/`send`/`markSent`/镜像(`:1852-1871`)；**失败即 throw(`:1872-1874`)** |
| 现有去重算不算幂等 | ❌ **不算**。键＝分片**全文**、`#recent` **仅内存**（`onebot.mjs:343-346`）、窗口 8 秒、无持久记录 ⇒ 跨重启失效，且键不含来源消息 ID |
| 有没有需要保护的既有正确性 | ✅ **两处**：① `markSent` 只在发送**成功后**记账（`:341-342` 有明确理由）；② `#lastDelivered.set` 在 `await delivering` **之后**（`:1486`）⇒ 投递失败不更新，用户重发同内容不被误判为重复 |
| 投递块要改多少 | ✅ **几乎不用重构**，是**加法**：两个默认关的开关（`idempotencyKey` / `ledger`）+ 一处语义决策（部分投递）。∴ 四块里**风险最低** |
| 有没有跨块依赖 | ⚠️ **有**：记忆块的 D1（回执绑定投递成功）**依赖投递块先给出"当轮投递结果"信号**。最小形态不需要完整账本 —— 见 §14.5 |
