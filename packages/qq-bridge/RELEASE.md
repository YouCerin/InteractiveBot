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

---

## 4. 快捷方式（可选）

`启动机器人.lnk` **不要直接发** —— `.lnk` 里存的是**绝对路径**，换机器必然失效
（图标会退化成白纸）。两种做法：

- 干脆只发 `start.bat`（最简单）；
- 或者发一个 `创建快捷方式.bat`，用 `WScript.Shell` 在解压位置现场生成 `.lnk`，
  图标指向包内 `assets/icon.ico`。

---

## 5. 出 zip

```powershell
# 用 robocopy 组装 staging（文件多、路径长，Copy-Item 容易出问题）
robocopy . ..\_release\InteractBot-0.1.0-win-x64 /E /XD node_modules logs cache workspace-qq .tmp-verify .tmp-verify-onebot .tmp-verify-doctor .tmp-live-workspace .tmp-live-outside .tmp-probe-dsh /XF config.json.bak*

# 压缩（zip 内保留一层版本化目录名，避免用户解压得到一堆散文件）
Compress-Archive -Path ..\_release\InteractBot-0.1.0-win-x64 -DestinationPath ..\_release\InteractBot-0.1.0-win-x64.zip
```

体积参考：解压后约 **88 MB**，zip 后约 **40–45 MB**。

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
