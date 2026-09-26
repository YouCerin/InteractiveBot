# qq-bridge — QQ ↔ DSH 桥接

把 QQ 里的消息转给一个**有完整能力的 DSH agent**，再把它的回答发回 QQ。

> **📖 先读哪一份？**
> - **你是 AI agent，或想五分钟上手** → 读 **[AGENT.md](AGENT.md)**（操作说明 + 绝对不能改的六件事）
> - **你需要机器可读的包契约**（命令 / 配置键 / 不变量 / 故障特征） → 读 **[PROJECT.json](PROJECT.json)**
> - **你要打发布包（zip）** → 读 **[RELEASE.md](RELEASE.md)**（前置条件 / 要清空的密钥 / 验收清单）
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
# ① 一次性准备：把 Node 运行时和纯 JS 依赖收进包内（幂等，可重复跑）
node setup.mjs

# ② 配置自检（不连接任何服务）
node src/index.mjs --check

# ③ 填 config.json 里的 access.adminUsers（你自己的 QQ 号，必填！）

# ④ 跑测试（不需要 QQ、不花模型费用）
node mocks/verify-manifest.mjs   # 包契约自检：文档与代码是否一致（19 项）
node mocks/verify-api.mjs        # 配置接口：脱敏、空值语义、回环限制（50 项）
node mocks/verify-config.mjs     # 配置解析与校验（39 项）
node mocks/verify-units.mjs      # 纯逻辑：文本/唤醒/会话/防自环/人味层/人设/记忆（152 项）
node mocks/verify-rpc.mjs        # 协议层：与模拟 DSH 的 JSON-RPC（19 项）
node mocks/verify-onebot.mjs     # 全链路：QQ 事件 → 回复发出（26 项）
node mocks/verify-real-dsh.mjs   # 真实 dsh 能否被启动（7 项，零费用）
node mocks/verify-doctor.mjs     # 体检工具自身的准确性（30 项）
node mocks/verify-live.mjs       # ★ 真实端到端（会调用模型，有少量费用）
node mocks/verify-live.mjs --clean   # 清理测试留下的临时目录

# ⑤ 体检（真正检查连接是否可用，强烈建议先跑）
start.bat --doctor

# ⑥ 启动
start.bat                        # 双击；或 node src/index.mjs
# 也可以双击带图标的快捷方式：启动机器人.lnk
#   （.bat 本身在 Windows 里不能带自定义图标，所以带图标的入口是快捷方式）
# start.bat 现在会先拉起 SnowLuma，再起桥接。跳过 SnowLuma：start.bat --no-snowluma
```

当前状态：**离线十二套共 608 项全部通过**；真实 QQ 端到端实测通过（含 QQ 原生工具调用）。
启动后还会同时提供**本地配置接口** `http://127.0.0.1:3410`（给配置 UI 用，规格见 `CONFIG-UI.md`）。

---

## 依赖与前置条件（打发布包前必读）

本包**自带**：Node 运行时（`vendor/node`）、`ws`、桥接代码、控制台界面（`config-ui/dist`）。
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
├── 启动机器人.lnk          ★ 带图标的启动入口（指向 start.bat）
├── start.bat              入口（双击启动，优先用包内 Node；会先拉起 SnowLuma）
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
