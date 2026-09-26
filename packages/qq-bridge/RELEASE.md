# RELEASE.md — 打发布包（zip）

> 目标产物：一个 **zip**，解压后双击 `启动机器人.bat` 即可用。
> 用户的外置依赖只有两样：**QQ 桌面版** 和 **DSH**（外加自己的模型 API key 与 SnowLuma）。
>
> 本文只讲"怎么打",不讲设计理由 —— 设计理由见 `README.md` / `AGENT.md` / `PROJECT.json`。

---

## 0. 一句话结论

**包内自带**：Node 运行时、`ws`、桥接代码、控制台界面（`config-ui/dist`）。
**包外由用户自己准备**：QQ（NTQQ）、DSH 桌面版、SnowLuma、模型 API key。

| 依赖 | 为什么不在包里 |
|---|---|
| **DSH 本体** | 约 274.7 MB / 15069 个文件，且它是**运行环境**（像 Node）。定位方式：`vendor/dsh` → 环境变量 `DSH_DESKTOP_APP` → `dsh.searchPaths` → 默认安装位置 |
| **SnowLuma** | ★ **许可证不允许**。EULA §5.4 明确禁止"将其并入第三方安装包"，LICENSE §5 不授予原生组件（`snowluma-*.node` / `*.dll`）的再分发权利，§3(d) 要求公开发布衍生版须事先取得书面许可。让用户去 [官方 Releases](https://github.com/SnowLuma/SnowLuma/releases) 自取 |
| **模型 API key** | 属于用户的账号凭据，不能替用户分发 |

---

## 1. 发布前必做

```bash
cd packages/qq-bridge

# ① 界面改过就必须重新构建 —— 桥接只伺服 config-ui/dist（src 改了不 build 等于没改）
cd config-ui && npm run build && cd ..

# ② 备齐必需项 + 跑发布前体检（只报告，不改文件）
node setup.mjs --release

# ③ 全量离线测试（不需要 QQ、不花模型钱）
npm test
```

`setup.mjs --release` 会逐条列出来要清掉的东西。**退出码非 0 = 还有问题**，
它列出的 ❌ 必须解决、⚠️ 必须逐条判断。典型输出：

```
❌ config.json 里 onebot.wsToken（SnowLuma WebSocket token）仍有明文 —— 发布前必须清空
❌ config.json 里 dsh.apiKey（模型 API key）仍有明文 —— 发布前必须清空
⚠️  config.json 的 dsh.searchPaths 有 1 条（开发机路径）—— 发布前清空
⚠️  运行日志 还在：logs —— 发布前删掉或清空
```

---

## 2. 打包内容

**要的：**

```
启动机器人.bat            （可选，见 §4）
start.bat
config.json               ★ 已清空密钥的模板
prices.json
src/                      （全部 .mjs）
mcp/mcp-qq-server.mjs
config-ui/dist/           ★ 只有 dist，不含 src / node_modules
vendor/node/node.exe      （约 85.6 MB）
vendor/node_modules/ws/
```

**不要的：**

```
vendor/dsh/               DSH 本体（275MB，用户自己装）
vendor/snowluma/          SnowLuma（许可证不允许）
config-ui/src/            前端源码
config-ui/node_modules/   约 202 MB
logs/  cache/  workspace-qq/   运行痕迹（★ workspace-qq 里有模型读写的聊天内容）
config.json.bak*          历史备份，含旧密钥
.tmp-*                    测试残留
../dsh-qq-bot（废弃）/     旧架构
```

`.gitignore` 里已经排除了 `logs/`、`workspace-qq/`、`vendor/`、`node_modules/`；
`config-ui/.gitignore` 排除了 `dist/`（注意：**`dist` 是发布必需件**，
它被 gitignore 只是因为它是构建产物，不是因为它不该发）。

---

## 3. 清空 config.json（逐项）

| 字段 | 发布时的值 | 理由 |
|---|---|---|
| `dsh.cliPath` | `""` | 开发机路径 |
| `dsh.searchPaths` | `[]` | 开发机路径（本机现在填了 `D:\DeepSeekHarness\...`） |
| `dsh.apiKey` | `""` | ★ 模型密钥明文 |
| `onebot.wsToken` / `httpToken` | `""` | ★ SnowLuma 令牌明文；**同时去 SnowLuma 里把这两个令牌作废重发** |
| `access.adminUsers` | `[]` | 个人 QQ 号；空 = fail-closed（谁都不能用），这是有意的安全设计 |
| `access.dmAllowlist` / `groupAllowlist` | `[]` | 同上 |
| `snowluma.installDir` | `""` | 用户自己装在哪由他自己指；留空则走自动发现 |
| `snowluma.searchPaths` | `[]` | 同上 |

保留：`humanize`（话术）、`persona`、`trigger.keywords`、`prices.json` —— 这些是产品内容，不是隐私。

★ **编码**：`config.json` 必须是**无 BOM 的 UTF-8**。写入时带 BOM 会让配置解析直接失败。

★ 现在这一步是**自动的**：`config.example.json` 已经就是上面那张表的状态
（每次发版按 §5 直接 `Copy-Item config.example.json config.json` 即可），
不需要手工去改 `config.json`。`node setup.mjs --release` 会检查模板是否干净、
以及本机 `config.json` 里是否还留着明文密钥（只报告，不改文件）。

---

## 4. 入口与快捷方式

发布包给的是 `启动机器人.bat`（中文名，方便双击）+ `start.bat`（真正干活的）。

**★ 图标：`.bat` 在资源管理器里永远显示默认的"白纸+齿轮"，这是 Windows 的限制**
（它不给 `.bat` 显示自定义图标）。所以包内给了一个
`创建带图标的快捷方式.bat`：双击它就在同目录生成 `QQ机器人.lnk`，图标指向
`assets\icon.ico`。

为什么不直接发一个做好的 `.lnk`：**`.lnk` 里存的是绝对路径**，在作者机器上生成的
那份指向作者的目录，换台机器目标与图标一起失效（图标退化成白纸）。现场生成就不会错。

生成脚本里两个坑（都真实踩过，别再犯）：

1. **`.bat` 正文必须纯 ASCII**：cmd 按系统代码页（中文 Windows 是 GBK）解析 `.bat`，
   UTF-8 文件里的中文会吞掉换行、把解析搞坏。
2. **脚本里那段 PowerShell 也必须纯 ASCII（连注释也是）**：Windows PowerShell 5.1 会把
   **无 BOM 的 UTF-8** `.ps1` 当 GBK 读；一条中文注释就能"吃掉"紧随其后的代码 ——
   实际表现是报"快捷方式路径名称需以 .lnk 或 .url 结尾"。
   所以中文文件名一律用字符码拼：`[char]0x673A + [char]0x5668 + [char]0x4EBA` = 机器人。

---

## 5. 组装发布包

打包产物放在**项目之外**（桌面的 `_release\`），这样它既不会混进 git 工作树，
也不会被误当成项目文件。

```powershell
$ws  = '<...>\project_InteractBot\packages\qq-bridge'
$out = "$env:USERPROFILE\Desktop\_release\InteractBot-0.1.0-win-x64"
New-Item -ItemType Directory -Path $out -Force | Out-Null

# 只拷发布必需件（不用 /E 拷整个目录再删，避免把运行痕迹带进去）
foreach ($d in 'src','mcp','assets','config-ui\dist','vendor\node') {
  robocopy "$ws\$d" "$out\$d" /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
}
robocopy "$ws\vendor\node_modules\ws" "$out\vendor\node_modules\ws" /E /NFL /NDL /NJH /NJS /NP | Out-Null
foreach ($f in 'start.bat','setup.mjs','prices.json','config.example.json','AGENT.md','PROJECT.json','README.md','RELEASE.md') {
  Copy-Item "$ws\$f" $out -Force
}

# ★ 默认的空配置：发布包里必须有一份**空白** config.json，开箱即用
Copy-Item "$out\config.example.json" "$out\config.json" -Force
```

**发布包的最终形状**（62 个文件 / 约 87 MB）：

```
InteractBot-0.1.0-win-x64/
├── 先读我-首次使用.txt      ← ★ 给**非技术用户**的完整上手说明（含官方下载链接）
├── 启动机器人.bat           ← 中文名入口（正文纯 ASCII，转调 start.bat）
├── 创建带图标的快捷方式.bat  ← 双击生成带图标的 QQ机器人.lnk（.bat 本身无法显示图标）
├── 检查配置.bat             ← 给小白：双击 = start.bat --check
├── 体检.bat                 ← 给小白：双击 = start.bat --doctor（真连一次 SnowLuma）
├── start.bat
├── config.json             ← ★ 空白模板（密钥与本机路径全空）
├── config.example.json     ← 同一份，保留作参照（用户改坏 config.json 时可对照）
├── prices.json
├── AGENT.md  PROJECT.json  README.md  RELEASE.md  setup.mjs
├── src/                    桥接代码
├── mcp/                    QQ 工具服务器
├── assets/                 icon.ico 等
├── config-ui/dist/         ★ 只有构建产物 —— config-ui 的**源码与 node_modules 留在项目里**
└── vendor/
    ├── node/node.exe       85.6 MB
    └── node_modules/ws/
```

★ **小白文档不是装饰**：`先读我-首次使用.txt` 是包内唯一一份写给非技术使用者的文档
（其余 `AGENT.md` / `README.md` / `RELEASE.md` / `PROJECT.json` 分别面向 AI agent、
开发者和机器校验）。它必须给出四个下载链接、三步配置、五个常见故障对照，
以及"密钥非官方登录有账号风险"的提示。改动 README/配置项文案时记得同步它。

★ 两个 `*.bat` 引导入口的正文是**纯 ASCII**（.bat 由 cmd 按系统代码页解析，
含中文会吞掉换行），只转调 `start.bat` 的对应开关 —— 开关的语义只有一处实现。

不带：`vendor/dsh`（用户自装）、`vendor/snowluma`（许可证不允许）、
`config-ui/{src,node_modules}`（202 MB，属项目开发资产）、
`logs` `cache` `workspace-qq` `mocks` `config.json.bak*`。

### 打包后必须跑一次验收脚本

```powershell
node packages\qq-bridge\scripts\check-release-package.mjs "$env:USERPROFILE\Desktop\_release\InteractBot-0.1.0-win-x64"
```

它只读、不改文件，检查四件事：**必需件是否齐全**、**不该带的是否混进去**
（DSH/SnowLuma/config-ui 源码/日志/密钥缓存）、**内容里有没有明文密钥与机器专属路径**、
**体积构成**。退出码 0 才发。

### 出 zip

```powershell
Compress-Archive -Path $out -DestinationPath "$out.zip"
```

体积参考：解压后约 **87 MB**，zip 后约 **40–45 MB**（大头是已压缩过的 `node.exe`）。

★ 包必须放在**可写**位置（用户桌面、D 盘目录都行）：
`logs/`、`cache/`、`workspace-qq/` 都要写。放在 `C:\Program Files\` 下会失败。

---

## 6. 验收清单（必须在一台干净机器 / 另一个盘符上跑）

1. 解压到**另一个盘符**（例如 `D:\test`）而非原路径。
2. 双击 `启动机器人.bat` → 应能自建 `logs/`、`cache/`、`workspace-qq/`。
3. `start.bat --check` → 应显示 DSH 的解析结果与来源；**没装 DSH 时必须列出所有候选位置**，而不是一句"找不到"。
4. 故意把 `dsh.cliPath` 填错 → 报错必须说明"这个路径是配置指定的但它不存在"。
5. 不填 `apiKey`、机器上也没有 `%APPDATA%\dsh-desktop\harness\.credentials.yaml` → 启动日志必须明确报出凭据缺失
   （否则表现是"能收消息但一句话不回"，极难自查）。
6. `start.bat --doctor` → 逐项体检；SnowLuma 未安装时应如实报出，且界面「协议端」页显示"还没检测到 SnowLuma"提示与下载入口。
7. 装好 SnowLuma 并扫码登录后，真实私聊一轮 → 有回复、`logs/usage.jsonl` 有记账。
8. 界面「高级」页：填一次 API Key → 保存 → 重新加载页面，应显示"已配置（留空即不修改）"；
   点「清除」并确认 → `config.json` 里 `apiKey` 变回空串。
9. 确认 zip 里**没有**任何明文密钥、没有你的 QQ 号、没有 `vendor/dsh`、没有 `vendor/snowluma`。

---

## 7. 发布时要在说明里写清的四件事

1. **需要先装 DSH**（本包不含它），否则机器人起不来 —— 以及装完/填路径的两种办法。
2. **需要自己下载 SnowLuma**（本包不含它，原因是许可证），并附官方下载地址。
3. **需要自己的模型 API key**：界面「高级」页填一次即可；已装 DSH 桌面版并填过 key 的人**不用重复填**。
4. **`config.json` 会含明文密钥**（模型 key 与 SnowLuma token），别外发、别提交到 git。
