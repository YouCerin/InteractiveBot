# 插件化改动清单（施工用）

> ⚠️ **状态（2026-09-27 更新）：这份清单是"第一版施工方案"，命名与范围都已被后续方案取代。
> 实际落地的划分与顺序看 `docs/plugin-packaging-plan.md`（S0~S5），以那份为准。**
>
> | 本清单 | 实际落地 | 差异 |
> |---|---|---|
> | P0 抽缝 | **没做** | `decideTrigger` 保持原样，没有改成 policy 列表（投机抽象）；闸门加在它**外面** |
> | P1 工具面 | **✅ 做了** | 与清单一致（白名单 + `mcp.profile` + `mcp.genericApi`） |
> | P2 人设段落化 | **移出范围** | 属"提示词模块"，用户明确不动 |
> | P3/P4 唤醒 gate | **✅ 一次做完** | 键名从 `wake.mode` + `wake.gate.*` 改成 **`wake.policy` + `wake.judge.*`**；**影子是默认态**（`wake.judge.shadow` 默认 true），不是在代码里先跑一段再改 |
> | P5 投递可靠性 | **✅ 缩小后做完** | E1 幂等键与投递账本 **0.2.1 就存在**，所以实际只剩"给账本一个开关 + 登记插件" |
>
> ★ 下面各阶段的"改哪个文件、哪一行"**仍然有参考价值**（行号是当时的），但**不要照抄键名**。

> **用途**：把 `docs/plugin-ization-design.md` 的四块设计压成**可开工的清单** —— 每个阶段改哪个文件、哪一行、改什么、用哪条验收、怎么回滚。
> **前置**：设计依据全部在 `docs/plugin-ization-design.md`（引用写作 §N）；记忆块不在本清单范围（见 `docs/memory-borrow-handoff.md`）。

---

## 0. 全局约定（每一步都适用）

| 约定 | 要求 |
|---|---|
| **新配置键** | 必须在 `src/config.mjs` 的 `normalizeConfig`(`:50`) 给默认值 + `validateConfig`(`:285`) 给校验/告警；**并同时进 `mocks/verify-config.mjs`**（该文件头的第②条原则："用户给的值必须真的生效 —— 防止键名写错导致静默失效"） |
| **配置注释** | 沿用现有风格：每个块带 `_说明` / `_为什么…` / `_fail-closed`，中文解释取舍（`config.example.json` 全篇如此） |
| **默认值** | **默认 = 今天的行为**。唯一的例外是 `mcp.profile`（建议从"全部 7 个"收到"只读 3 个"），它必须作为**显式行为变更**记录 |
| **开关命名** | 先查 `config.example.json` 有没有现成键。**第 6 轮已发现一个反例**：本设计原提议的 `tools.enabled` 与现有的 `mcp.enabled` 重复，已作废（§12.3 更正） |
| **安全项** | 不参与开关（§3.1 的 5 条 + §14.6 的 4 条）。在 config-ui 里**不出现**，而不是"出现但灰色" |
| **日志与 observability** | 复用 `#warnInjectOnce`(`bridge.mjs:531`)、`oplog.appendOp`(`oplog.mjs:73`)、`memory-stats` 的"绝不抛异常"纪律 |
| **行为变更记录** | 每阶段完成后往 `CHANGELOG.md` 写：行为变更 + 涉及文件（沿用现有格式，参考 `hermes` 的"末尾列涉及文件"习惯） |
| **回滚** | 优先用配置开关回滚；只有 P0/P2 的结构改动需要 `git revert` |

## 0.1 开工前 5 分钟检查表

```powershell
cd packages\qq-bridge
node -v                       # 需要 >= 22（package.json engines）
pnpm test                     # 基线圈：必须全绿，记下当前通过项数
git status --short            # 确认工作区干净（否则 revert 不可靠）
```
- 记下**基线**：`pnpm test` 全绿时的用例数。每阶段结束后比对。
- `config.json`（未入库，含密钥）**不要**在改动中读取/写入。
- **不要**在 `workspace-qq/` 里试验（那是真实记忆与语料，改动可能污染）。

---

## P0 抽缝（零对外行为变更）

**目标**：把"唤醒判定"从单一函数变成一个可插入 policy 的接缝，并把判定结论的观测通道准备好。**不改任何决策结果。**

| # | 文件 | 位置 | 改什么 |
|---|---|---|---|
| 1 | `src/trigger.mjs` | `:46 decideTrigger` | **保留导出与语义不变**，内部改为遍历 policy 列表（当前仅一个 rule policy） |
| 2 | `src/trigger.mjs` | 文件顶部 | 新增 policy 列表 + 每项 `{id, zone:'trigger', order, optional, decide}`；导出 |
| 3 | `src/bridge.mjs` | `:34` | import 增加 `appendOp`（目前只 import 了 `appendTurnOps`） |
| 4 | `src/bridge.mjs` | `:662-679` | 判定结论写 trace（`op` 形状见 §10.4）。**必须由新键 `wake.trace`（默认 `false`）控制** —— 否则 P0 就不是"零成本" |
| 5 | `src/config.mjs` | `:50` / `:285` | 新增 `wake` 块的默认值与校验（`mode:'off'`、`gate.enabled:false`、`trace:false` …见 §4） |

**⛔ 不要动**：`mocks/verify-units.mjs:185-283`（11 处 `decideTrigger` + 3 处 `lintKeywords`）—— **它继续全绿就是"零行为变更"的证据**。

**验收**：
- `pnpm test` 全绿，用例数与基线一致；
- `wake.trace=false`（默认）⇒ 行为与 oplog 输出**都**与基线一致；
- `wake.trace=true` ⇒ oplog 出现 `kind:'wake'` 事件，但回复行为不变。

**回滚**：`git revert`（结构改动，无配置开关）。

---

## P1 工具面（⚠️ 含一次**显式行为变更**）

**目标**：把"默认放行所有动作"改成 **fail-closed**：默认只暴露只读工具，通用口默认关，动作闸门从 deny-list 变 **allow-list**。

| # | 文件 | 位置 | 改什么 |
|---|---|---|---|
| 1 | `mcp/mcp-qq-server.mjs` | `:53-75 BLOCKED_ACTIONS` | **保留**（第二层防线）；新增 `ALLOWED_ACTIONS` allow-list（用于 `qq_api` 的动作白名单，默认**不含** `get_cookies`/`upload_group_file`/任何 `set_*`/`delete_*`） |
| 2 | 同上 | `:78-189 TOOLS` | 按档位过滤 `tools/list`：`readonly` ⇒ 只留 `qq_group_members`/`qq_message_detail`/`qq_group_history`；`full` ⇒ 7 个。`qq_api` 另受 `genericApi` 控制 |
| 3 | 同上 | `:244-273 runTool` | 闸门顺序改为：具名工具查 `BLOCKED_ACTIONS`；`qq_api` **先查 allow-list 再查 BLOCKED_ACTIONS**（双层）。拒绝文案沿用 `:258-263` 的措辞风格 |
| 4 | 同上 | `:315 loadConfig` | 读入 `profile` / `genericApi` / `allowedActions` |
| 5 | `src/mcp-profile.mjs` | `:43 writeMcpConfig` | 把档位写进 `cache/mcp-qq.config.json`（**不必重写 `cordis.patch.yml`** —— 见 §12.3 的说明） |
| 6 | `src/config.mjs` | `:50` / `:285` | `mcp.profile`（默认 `'readonly'`）、`mcp.genericApi`（默认 `false`）+ 校验 |
| 7 | `src/index.mjs` | `:1128-1137` | 把 `config.mcp.profile/genericApi` 传给 `writeMcpConfig` |

### P1.1 文档与 UI 同步清单（**容易漏，共 5 处**）

"默认放行所有动作，只用黑名单拦…"这句话现在散布在 5 个地方，改成 fail-closed 后**每一处都要改**：

| # | 位置 | 现状 |
|---|---|---|
| 1 | `config.example.json:209-210` | `_安全说明`："默认放行所有动作，只用黑名单拦会伤害他人或账号的动作" |
| 2 | `PROJECT.json:394` | "默认放行所有 OneBot 动作，黑名单拦截…" |
| 3 | `CONFIG-UI.md:1023` | "自己能精细控制，实际清单在代码里（`BLOCKED_ACTIONS`）" |
| 4 | `config-ui/src/sections/McpTab.tsx:9-28` | `ALLOWED_ACTIONS`/`BLOCKED_ACTIONS` 是**硬编码副本**（`:8` 注释自称"与 `TOOLS` 一致"）—— 需同步并加档位控件 |
| 5 | `src/config.mjs:239` | mcp 块附近注释 |

> 这正是"文档漂移"的典型形态。建议顺手在 `mocks/verify-manifest.mjs`（已在 `:378` 读该文件）加一条**清单一致性断言**，让第 4 处不再靠人工维护。

**验收**（§12.4 的 8 条，其中 3 条是关键）：
- `mcp.enabled=false` ⇒ `tools/list` 无 `qq_*`，patch 无标记块；
- **`mcp.profile='full'` ⇒ 与 0.2.0 逐字一致**（"打开即回到今天"的锚点）；
- **`qq_api(action='get_cookies')` 被拒**（§12.2 的漏口）；`get_group_list` 放行；`set_group_kick` 仍被拒。

**回滚**：配置开关（`mcp.profile='full'` + `mcp.genericApi=true` 即回到今天）。

**行为变更声明（写进 CHANGELOG）**：
> 默认工具档位从"全部 7 个（含通用 `qq_api`）"收紧为"只读 3 个"；动作闸门由黑名单改为白名单双闸。回到旧行为的配置：`mcp.profile="full"`、`mcp.genericApi=true`。

---

## P2 人设段落化

**目标**：把 `#buildPrompt` 里 8 处硬编码 `lines.push` 收进**段表**（§13.3 契约），人设段可关；**段顺序不变**。

| # | 文件 | 位置 | 改什么 |
|---|---|---|---|
| 1 | `src/bridge.mjs` | `:1494 #buildPrompt` | 引入段表（`id/zone/order/optional/render`），把 8 处 `lines.push` 收进去 |
| 2 | `src/bridge.mjs` | `:1552` | `const lines = [PLATFORM_RULES]` ⇒ 由段表按 zone 装配 |
| 3 | `src/bridge.mjs` | `:1561` | 人设段受 `persona.enabled` 控制 |
| 4 | `src/bridge.mjs` | `:233-245` | **保留**构造期缓存；新增 `refreshPersona()`（供配置保存后调用）。**不要**改成每轮重算 |
| 5 | `src/config.mjs` | `:50` / `:285` | `persona.enabled`（默认 `true`）；`persona.lint` 标 `readonly` |

**⛔ 不变式（不可关，§13.2）**：I1 只有 `identity.ok` 才写昵称/角色；**I2 权限声明只能来自权限段**；I3 身份标签旁必须写"与权限无关"。

**验收**（§13.7 的 8 条，两条最关键）：
- **第 6 条**：除 `permission` 段外，其余段文本**不得出现**"管理员/权限/admin" ⇒ **回归 `bridge.mjs:1503-1518` 那次事故**；
- 第 8 条：稳定前缀段序与 §13.4 表一致（防无意重排导致缓存失效）；
- `persona.enabled=true`（默认）⇒ 提示词与 0.2.0 逐字一致。

**回滚**：配置开关（`persona.enabled=true` 即今天）；段表结构本身用 `git revert`。

---

## P3 唤醒 gate · 影子模式（零行为变更）

| # | 文件 | 位置 | 改什么 |
|---|---|---|---|
| 1 | `src/bridge.mjs` | **`:719` 与 `:721` 之间** | 插入闸门调用（位置已决，理由见 §10.3） |
| 2 | 新增 `src/wake-gate.mjs` | — | `judgeWake(input, {signal})`：六条纪律（§5）；默认关时不 import/不初始化 |
| 3 | `src/bridge.mjs` | `:1165-1177` | **把"重复内容"判定前移到闸门之前**（纯内存比对，零成本）—— §10.2 修法 A |
| 4 | `src/config.mjs` | `:50` / `:285` | `wake.gate.{enabled,shadow,model,timeoutMs,onError,maxPerHour}`；**校验层拦下 `timeoutMs >= humanize.interim.afterMs`**（必须 < 8000，建议 6000） |

**闸门硬约束**：必须 < `interim.afterMs`（默认 8000，`bridge.mjs:1223`）；必须接受 `AbortSignal`；必须无副作用；@ 与私聊**永不进闸门**；**必须在 roster 准入之后**（`:688` 之后）。

**验收**：§10.6 的 12 条，其中第 8 条（`enabled:false` ⇒ 判定器未被初始化、`rpc.prompt` 序列与 0.2.0 一致）是"默认关闭＝今天"的机器化验证。

**回滚**：配置开关。

---

## P4 唤醒 gate · 生效（**可能少回**）

| # | 文件 | 位置 | 改什么 |
|---|---|---|---|
| 1 | `src/config.mjs` | — | `wake.gate.enabled` 允许置 `true` |
| 2 | 影子报表 | — | 按 §10.5 的形态产出"本会拦掉 N 条 + 抽样人工复核" |

**放行门槛（建议写进验收）**：影子期**漏回率**（人工复核中"该回却没回"的比例）低于阈值才允许开启。**没有这条门槛就不许开。**

**回滚**：配置开关（`enabled:false`）。

---

## P5 投递可靠性

| # | 文件 | 位置 | 改什么 |
|---|---|---|---|
| 1 | `src/onebot.mjs` | `SendQueue.check/markSent`(`:337`/`:366`) | 增加可选 `key` 参数（E1 幂等键：`sha256(sessionId\|sourceMsgId\|chatKey\|replyTo\|text)[:32]`） |
| 2 | `src/bridge.mjs` | `:1852-1876 #deliver` | 传入 `sourceMsgId`；**把已发出的分片记下来**（部分投递可诊断，§14.4） |
| 3 | 新增（E2，可选） | `runtime/` 下 | 投递账本：`pending → attempting → delivered\|failed`；`(pid, 启动时间)` 所有权；**不复活已 `delivered` 的行**；`MAX_ATTEMPTS=3` / 陈旧 24h / 保留 7 天 / `MAX_ROWS=500`（照抄 hermes `delivery_ledger.py`） |
| 4 | `src/bridge.mjs` | `:1478-1486` | 暴露"当轮投递结果"（成功/部分/失败）—— **这是记忆块 D1 的前置**（§14.5） |
| 5 | `src/config.mjs` | `:50` / `:285` | `delivery.idempotencyKey`（默认 `false`）、`delivery.ledger`（默认 `false`） |

**⛔ 不要动（既有正确性，§14.6）**：
- `markSent` **只在发送成功后**记账（`onebot.mjs:341-342` 有明确理由）；
- `#lastDelivered.set` 必须**在 `await delivering` 之后**（`bridge.mjs:1486`）—— 前移会破坏"投递失败后同内容重发不被判重复"；
- `#safeSend`(`:1890`)**不加重试、不加拟人延迟、不进账本**（`:1887-1888` 的理由：出错通知要尽快到达）；
- `send.*` 三档节流与 `dedupeWindowMs` 全部**不可关**。

**验收**（§14.7 的 8 条，两条是回归锚点）：
- 第 1 条：两开关默认关 ⇒ 行为与 0.2.0 逐字一致，且 `runtime/` 下**无新增文件**（"关闭即零成本"的机器化验证）；
- 第 3 条：不同 `sourceMsgId`、同文本 ⇒ **放行**（今天会被 8 秒内容去重误拦）；
- 第 8 条：`markSent` 时机（回归 `:341-342`）。

**回滚**：配置开关。

---

## 打包形态的决策点

**何时决定**：**P3 之后**（P0 抽出的缝如果接口干净，拆包只是搬文件；不干净的话不拆也是乱的）。

判据（届时用这四条判断要不要拆成独立 workspace 包）：
1. `qq-bridge` 的 `setup.mjs` 是**把依赖复制进 `vendor/node_modules`**（`package.json` 的 `comment`）—— 多一个包就要多一条复制/审计路径；
2. `RELEASE.md` 与 `release-audit.json` 要覆盖两个制品；
3. `scripts/check-release-package.mjs` 的文件清单要同步；
4. **是否出现第二个消费者**。没有的话，就地模块更好。

---

## 附：本清单与设计文档的对应

| 阶段 | 设计出处 | 验收出处 |
|---|---|---|
| P0 | §2.1、§4、§6 | §6 表 + 本清单 P0 |
| P1 | §12.1–§12.3 | §12.4（8 条）+ §12.5 |
| P2 | §13.3–§13.6 | §13.7（8 条） |
| P3 | §10.1–§10.5、§5 | §10.6（12 条） |
| P4 | §10.5 | §10.5 的放行门槛 |
| P5 | §14.1–§14.6 | §14.7（8 条） |
| 记忆（另会话） | `docs/memory-borrow-handoff.md` | 该文档 §8 |

**核验命令**：`docs/plugin-ization-design.md` §15（㉒–㉕ 为投递块，㉑ 为人设块，⑯ 为工具面核心发现）。
