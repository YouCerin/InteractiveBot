# 截图（screenshot）

把**机器人所在这台电脑的屏幕**截成一张图，交给模型看、或者发进当前 QQ 会话。

- **默认关闭**，在「控制台 → 扩展 → 截图」里打开（**开关即时生效，不用重启**）；
- 装卸技能需要重启桥接（工具表与 profile 是启动时定的）；
- 不需要任何外部程序：用 Windows 自带的 PowerShell + .NET 抓屏，**零 npm 依赖**。

## 怎么用（对使用者）

| 你说 | 它做什么 |
|---|---|
| 「看看我这边现在什么样」「截个图」 | 截整屏 → 把图发进当前会话 |
| 「帮我看下屏幕上报的什么错」 | 截屏 → 自己读那张图 → **直接回答你**（不甩一张大图给你） |
| 「截一下那个 Edge 窗口」 | 按窗口标题截（**被遮挡也能截到**，用 `PrintWindow`） |
| 「只要左上角那一块」 | 传 `region`（`[x, y, 宽, 高]`） |

工具名（模型看到的）：`mcp__skills__screenshot__capture`。

**权限（重要）**：默认**只有管理员**能截。桥接在每一轮真跑模型之前，按会话写一份授权
（`本轮说话人是不是管理员`），技能读它 —— 群里一个普通人说「帮我截屏」会被**当场拒绝**，
而不是靠模型自觉。详见下面「权限是怎么硬起来的」。

## 三个开洞的地方（默认值都是"关"的方向）

| 设置 | 默认 | 说明 |
|---|---|---|
| 启用截图 | **关** | 截屏会把屏幕上**一切**带走（密码框、聊天记录、别人的窗口） |
| 允许在群聊里用 | 开 | 但**只有管理员**能真的截；关掉它 = 群里谁都别想截 |
| 只有管理员能截 | **开** | ⚠️ 关掉它等于把整台电脑的屏幕开放给群里任何人 |
| 图片宽度上限 | 1280 | 缩到 1280 再给模型 —— 全屏原图直接喂进去，token 是它的好几倍 |
| 保留时长 | 24 小时 | 截图落在工作区，顺手清理过期的（约 10 分钟扫一次）；0 = 一直留着 |

## 两次实测踩出来的坑（**别改回去**，都有依据）

### ① JPEG 编码器会被杀毒软件当恶意脚本拦下

`.NET` 的 `ImageCodecInfo` + `EncoderParameter(Quality)` 与 `Graphics.CopyFromScreen`
**出现在同一段 PowerShell 里**时，会命中 AMSI 的恶意特征（大概率和"静默截屏 + JPEG 压缩"
那类恶意软件同形）：

| 脚本内容 | 结果 |
|---|---|
| 只有「截屏 → PNG 保存」 | 正常 |
| 只有「缩放 → JPEG 质量编码」 | 正常 |
| 两者合在一段脚本里 | ❌ `This script contains malicious content and has been blocked by your antivirus software` |

表现是**整段脚本第一行就报错**（连 `$ErrorActionPreference` 都"含恶意内容"），
看起来像环境坏了、其实是格式选错。

⇒ 所以本技能**只用 PNG**，`format=jpg` 走 **ffmpeg**（命令行 exe，不踩这个特征，要自己配路径）。
`mocks/verify-screenshot.mjs` 有一条断言钉着"脚本里不许出现 EncoderParameter"。

### ② 一个抓屏 API 失败可能"返回成功 + 全黑"

实测某台机器上 `BitBlt` **返回 true 但结果是全黑**，而 `CopyFromScreen` 与 `PrintWindow` 都正常。
会话隔离（服务/无人登录/锁屏）时也会得到全黑图，而且 `CopyFromScreen` **不报错**。

⇒ 所以脚本里做了两件事：
1. **三级兜底**：`BitBlt` → `CopyFromScreen` → `PrintWindow(桌面)`，每级之后采样一批像素
   （均值/标准差），"接近全黑"就换下一个 API；
2. 全黑兜底也失败时**照样给图，但附上明确警告**（"可能锁屏或不在交互会话里"）——
   绝不静默成功，也绝不假装屏幕就是黑的。

采样在**缩放之前**做（缩放会把黑图的统计抹平，那样兜底就永远不会触发）。

## 权限是怎么硬起来的（这是本技能最容易被改坏的地方）

需求口径：**群聊可以用，但任何情况下只有管理员才能下达截图指令**。

问题是 `docs/插件设计规范.md` §5.4 早就写明：MCP 的 `tools/call` 上**没有调用者身份**，
技能工具里的 `permission: "write"` 只是"请模型不要做"。所以必须有模型改不了的依据。

```
桥接主进程（唯一知道权限的地方）
   roster.decide() → tier = admin / user / stranger
        │  每一轮**真跑模型之前**
        ▼
   <workspace>/screenshots/.grants/<peerKey 的 SHA1 前 16 位>.json
   { kind, peerId, senderId, tier, at, exp }
        │  回合结束**删掉**（失败出口与正常出口都删；另有 10 分钟过期兜底）
        ▼
MCP 子进程里的本技能：readGrant() → 不是 admin 就拒绝（**没有文件也拒绝**）
```

三道判定，顺序不能换：**群聊开关 → 管理员授权 → 真抓图**。

如实写清这条路的边界（`src/screenshot-grant.mjs` 文件头也写了一遍）：

- 粒度是**会话**（`kind:peerId`），不是"这一次调用属于哪个回合" —— MCP 协议层没有后者；
- 授权文件在工作区里是明文，**模型自己也能伪造/删掉它**。这条路挡住的是
  "外部陌生人一句话就偷看桌面"（真实威胁），挡不住"模型主动恶意伪造"。要堵后者得让宿主
  把会话身份透传到 MCP 层（改宿主契约，这次没做）；
- 文件名规则在技能与宿主各有一份实现（技能不能 import 宿主的 `src/`），
  `mocks/verify-screenshot.mjs` 断言两份结果一致 —— 不一致的症状是
  "管理员有权限，截图却说没授权"，非常安静。

## 文件分工

| 文件 | 职责 |
|---|---|
| `capture.js` → `capture.mjs` | **纯逻辑**：计划、夹取、region 校验、黑屏判定、清理挑选、文案（无 IO，离线全测） |
| `ps-runner.mjs` | **执行**：拼 PowerShell 脚本、起进程、读结果 JSON。唯一碰系统 API 的地方 |
| `index.js` | **契约**：注册工具、自检、提示词片段、**管理员硬闸** |

`capture.mjs` / `ps-runner.mjs` 必须是 `.mjs`：本目录没有 `package.json`，
`.js` 会被 Node 当 CommonJS，而 `index.js` 里用的是 ESM `import`。

## 出问题了怎么查

```bash
cd packages/qq-bridge
node src/index.mjs --extensions        # 技能状态、工具全名、清单告警
node mocks/verify-screenshot.mjs       # 离线：路径/权限/黑图判定/脚本拼装（136 项）
node mocks/verify-screenshot-real.mjs  # 真机：真抓一张、真发一次、授权闭环
node mocks/probe-extensions.mjs --enable screenshot   # 看提示词里到底注入了什么
```

常见症状 → 原因：

| 症状 | 原因 |
|---|---|
| 卡片上写着"关闭" | 你自己没打开开关，或 `config.skills.screenshot.enabled === false` |
| 卡片上写着"没找到 PowerShell" | `PATH` 被裁剪过（Windows 自带的 5.1 在 `%SystemRoot%\System32\WindowsPowerShell\v1.0\`） |
| 管理员截图也被拒 | 授权没写成功 —— 桥接日志里搜「截图授权没写成功」（它**不静默**） |
| 图是黑的 | 桥接跑在服务/非交互会话里，或机器锁屏；图旁边的警告会说明 |
| jpg 报错说没 ffmpeg | 那是刻意的（见上面坑 ①）；要么用 png，要么在设置里填 ffmpeg 路径 |
| 群里普通人也能截 | 检查「只有管理员能截」是不是被关掉了（默认开） |
