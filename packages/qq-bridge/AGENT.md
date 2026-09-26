# AGENT.md — 给 agent 的操作说明

> 如果你是一个刚打开这个目录的 AI agent：**先读这一页，再读 `PROJECT.json`，然后就可以干活了。**
> 这一页的目标是让你在五分钟内知道「这是什么、怎么跑、什么绝对不能改」。

---

## 1. 这是什么

`qq-bridge` 把 **QQ 私聊消息**转给一个**拥有完整能力的 DSH agent**，再把回答发回 QQ。

```
QQ ──OneBot v11──> SnowLuma ──WS/HTTP──> qq-bridge ──stdio JSON-RPC──> dsh --profile sdk
                                            （本目录）                   （真正干活的那个）
```

**核心设计思想**：真正干活的是 DSH 的 agent 循环（工具、沙箱、会话、模型）。
桥接**只做四件事**：收消息 → 判断该不该回 → 转给 DSH → 把回答发回去。
**不要试图在桥接里重新实现 DSH 已有的能力**（工具循环、记忆、权限）—— 那是这个项目早期走过的弯路。

---

## 2. 五分钟上手

```bash
# ① 环境准备（幂等，可重复跑）：把 Node 运行时和 ws 依赖复制进 vendor/
node setup.mjs

# ② 配置自检（不连接任何服务）
node src/index.mjs --check

# ③ 体检：真去连一次协议端（不发消息、不调模型）
node src/index.mjs --doctor

# ④ 离线测试（不需要 QQ、不花钱）
npm test

# ⑤ 启动
start.bat
# 或：node src/index.mjs
```

**跑之前先看 `--doctor` 的输出。** 它会把「哪一项没配好」直接列出来；
它全绿了再启动，可以省掉 90% 的"连不上但不知道为什么"。

---

## 3. 绝对不能改的七件事

这些不是风格偏好，是**实测得出的约束**。改之前先读 `PROJECT.json` 的 `invariants` 段。

| # | 约束 | 违反的后果 |
|---|---|---|
| 1 | **`src/local.mjs` 是唯一算路径的地方，绝不用 `process.cwd()`、绝不写死盘符** | 双击启动时解析到不存在的目录，而且**不报错**，只表现为"什么都加载不到" |
| 2 | **`dsh.permissionMode` 默认值不得改成 `danger-full-access`** | 用户明确决定"权限只限工作区"；全权模式会把整个磁盘交给 agent |
| 3 | **`session.instance` 必须参与 sessionId 哈希，且每个进程只算一次** | 用固定值 → 重启后必撞 `already exists`；每次调用都换 → 每条消息都失忆。两个坑都实测踩过（详见 `src/session-id.mjs` 顶部） |
| 4 | **`access.adminUsers` 为空时必须是"谁都不能用"** | 这是刻意的 fail-closed。改成"空=放行所有人"等于把有权限的 agent 开放给任何人 |
| 5 | **不要用 npm 装运行期依赖** | 依赖必须能被 `src/vendor.mjs` 从 `vendor/` 找到，否则包搬走就废 |
| 6 | **失败必须让用户知道** | 这个项目最该避免的失败模式是"静默什么都不发生"。任何失败路径都要给出提示 |
| 7 | ★ **涉及 UI 的改动，必须同步更新 `CONFIG-UI.md`** | 界面是照那份文档生成的。文档落后于代码 = UI 做出错误的东西，而且两边各说各话 |

**第 7 条的范围**（哪些算"涉及 UI"）：
新增/改名配置项、新增或改变 HTTP 接口与响应结构、改变界面需要反映的行为
（如连发去重、先应一声、权限墙的表现）、改变默认值/取值范围/校验规则。

**不算的**：纯内部重构、只改注释或日志文本（除非该日志被 UI 展示）。

---

## 4. 目录导航

```
qq-bridge/
├── AGENT.md          ← 你正在读的
├── PROJECT.json      ← 包契约（机器可读：命令/配置/不变量/故障特征）
├── README.md         ← 给人看的完整说明（设计决定、排障表）
├── config.json       ← 全部运行配置
├── start.bat         ← 入口（优先用包内 Node）
├── setup.mjs         ← 一次性准备
├── src/
│   ├── index.mjs          装配与启动顺序  ← 改启动流程看这里
│   ├── local.mjs          ★ 路径解析（可搬迁性全靠它）
│   ├── bridge.mjs         ★ 核心：一条消息 → 一句回答
│   ├── sdk-rpc.mjs        与 dsh 子进程的 JSON-RPC 客户端
│   ├── session-bridge.mjs 回合收集器 + 会话路由
│   ├── session-id.mjs     ★ 会话标识（含"重启不能复用 id"的硬限制）
│   ├── onebot.mjs         OneBot 客户端 + 发送队列（节流/去重）
│   ├── trigger.mjs        唤醒判定矩阵 + 关键词体检
│   ├── text.mjs           消息段渲染 / Markdown 降级 / 分片
│   ├── vendor.mjs         从 vendor/ 加载依赖
│   └── doctor.mjs         体检
├── mocks/            测试替身与验证脚本（不需要真 QQ，不花钱）
├── vendor/           包内自带：node 运行时 + ws（由 setup.mjs 生成）
├── logs/             运行日志
└── workspace-qq/     ★ agent 的工作区 = 权限沙箱的根
```

---

## 5. 关键机制速查

### 消息怎么走完一圈

1. SnowLuma 通过 WebSocket 推事件（`src/onebot.mjs`）
2. `src/bridge.mjs` 做唤醒判定（`src/trigger.mjs`）—— 不命中就**到此为止，零成本**
3. 命中则校验管理员白名单（`#isAllowed`）
4. 转成提示词（含平台约束：纯文本输出、禁调交互卡、越界会被拒），投给对应会话
5. 等回合结束（`src/session-bridge.mjs` 收集 `assistant/message` 等事件）
6. 降级成纯文本 → 节流 → 分片 → 发送

### 权限是怎么落地的

**两道独立防线**：`access.adminUsers`（谁能触发）+ `DSH_PERMISSION_MODE=workspace-write`（能碰什么）。

`workspace-write` 自带 `ask` 审批策略，而 sdk profile 里**没有人能应答审批**，
所以越界操作会落成 `unavailable`（自动拒绝）**且不把对话卡死**。
这是刻意利用的行为，不是缺陷 —— 不要"修"它。

### sessionId 为什么带 instance

见 `src/session-id.mjs` 顶部。一句话：**同一场运行内上下文连续，重启后必须换新 id**。
代价是重启后 DSH 侧不记得之前的对话 —— 这是已知取舍，跨重启记忆属 P4（桥接侧自己存摘要注入）。

---

## 6. 测试地图（按"要不要花钱"分）

| 脚本 | 花模型钱 | 需要真 QQ | 验什么 |
|---|---|---|---|
| `mocks/verify-manifest.mjs` | ❌ | ❌ | 包契约：文档说的文件/命令/配置键是否真的存在 |
| `mocks/verify-api.mjs` | ❌ | ❌ | 配置接口：token 脱敏、空值语义、回环限制 |
| `mocks/verify-config.mjs` | ❌ | ❌ | 配置解析与校验（默认值安全性、键名是否生效、危险配置拦截） |
| `mocks/verify-units.mjs` | ❌ | ❌ | 纯逻辑：文本/唤醒判定/会话标识/防自环/人味层/人设/记忆 |
| `mocks/verify-rpc.mjs` | ❌ | ❌ | 与模拟 DSH 的 JSON-RPC 协议 |
| `mocks/verify-onebot.mjs` | ❌ | ❌ | 全链路：QQ 事件 → 回复发出 |
| `mocks/verify-real-dsh.mjs` | ❌ | ❌ | 真实 dsh 能否被启动（不发 prompt） |
| `mocks/verify-doctor.mjs` | ❌ | ❌ | 体检工具自身准不准 |
| `mocks/verify-live.mjs` | **✅ 会调用** | ❌ | 真模型 + 真沙箱 + 越界验证 |

`npm test` 跑前八个（全免费，共 **342 项**）。**只有 `verify-live` 花钱，而且它连的是假协议端**，
所以不会真的往 QQ 发消息、不会打扰任何人。

---

## 7. 常见故障（完整表见 `PROJECT.json` 的 `knownFailureSignatures`）

| 现象 | 先查什么 |
|---|---|
| 谁发都不回 | `access.adminUsers` 是不是空的（fail-closed） |
| 连上但从不回复 | `logs/bridge.log`；DSH 子进程是不是退出了 |
| `HTTP 426` | `httpUrl` 填成了 WebSocket 端口（SnowLuma：3000=HTTP、3001=WS） |
| `session "..." already exists` | `session.instance` 机制失效，改成任意新值重启 |
| `Cannot convert argument to a ByteString` | token 里混进了中文/全角字符 |
| 留下 `.tmp-*` 目录 | 无害；`node mocks/verify-live.mjs --clean` |

---

## 8. 当前状态与下一步

**已完成并验证**：P0 协议端就位 · P1 桥接骨架 · P2 工作区沙箱+管理员白名单 · **真实 QQ 链路端到端（含工具使用）**

**待做**：P3 人味层（**优先** —— 目前秒回，这是行为风控最典型的特征）· P4 跨重启长期记忆 · P5 插件/技能扩展系统

**如实标注**：
- 离线 **171 项**测试 + 真实 QQ 端到端实测通过 —— 这些是真的
- 真实实测记录（2026-09-25）：管理员真实私聊 → 桥接 → DSH → 模型 → QQ 回复；
  要求它建 `smoke-test.txt`，它调用 **2 次工具**并正确写入 `hello from qq`
- **群聊未验证**（第一版刻意关闭）
- 重启即失忆（P4 未做）
- **长时间运行稳定性未测试**

**当前风险（不是 bug，但要知道）**：机器人是**秒回**的。
上一个 QQ 号被封，最可能的原因就是这种自动化特征。**P3 要解决的就是这件事。**

---

## 9. 分享这个包之前

`config.json` 里有 **SnowLuma 的 accessToken 明文**。

> **分享前必须先在 SnowLuma 里把这两个 token 作废重发。**
> 任何拿到这个字符串的人都等于拿到了你的 QQ 机器人控制权。

`vendor/` 与 `logs/`、`workspace-qq/` 已在 `.gitignore` 里排除。
