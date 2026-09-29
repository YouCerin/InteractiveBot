# RELEASE.md — 打发布包（zip）

> 目标产物：一个 **zip**，解压后双击 `start.bat` 即可用。
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

# ①-b ★ 确认"产物 = 当前源码"（构建溯源；这一步同时是发布门禁）
node src/index.mjs --ui

# ② 备齐必需项 + 跑发布前体检（只报告，不改文件）
node setup.mjs --release

# ③ 全量离线测试（不需要 QQ、不花模型钱）
npm test
```

### ★★ 为什么要专门验"用户拿到的 UI 和我这边是同一份"

界面分**两条路出货**，而它们**脱钩过一次**（实测）：

| 路径 | 谁在用 | 在 git 里 |
|---|---|---|
| `config-ui/dist` | 开发机桥接直接伺服 | ✅ 已入库（`.gitignore` 里刻意开了例外） |
| `_release/<包>/config-ui/dist` | **用户拿到的** | ✅ 已入库（`!_release/**` 那段例外） |

那次脱钩的样子：发布包里的桥接源码与 UI 都比工作区旧约 5 小时，
而**1100 项离线测试全绿** —— 因为没有任何断言/检查去看那个目录。
根因是"`dist/index.html` 在不在"这种检查**答不了"这份 dist 是不是当前源码构建的"**。

现在的判定方式（`node src/index.mjs --ui`，只读）：

* 构建时把**源码树的内容哈希**写进 `config-ui/dist/ui-build.json`；
* 校验时重算一次比对。退出码 `fresh=0`，其余 `=1`。

三种结果**必须分开看**（`--ui` 会分开报，不要混成一句"不同步"）：

| 状态 | 含义 | 怎么修 |
|---|---|---|
| `fresh` | 与当前源码一致 | 无需处理 |
| `stale` | 源码改了没重新构建 | `cd config-ui && npm run build` |
| `unstamped` | 没有标记，**无法自证来源** | **重新构建也没用** —— 这份产物不是本项目构建的，删掉重建 |

★ 哈希逻辑只有一份（`scripts/ui-build-stamp.cjs`），构建侧与校验侧都调它 ——
两边各写一套必然分叉，而分叉的表现是"校验说同步、其实是错的"。
★ 哈希前把换行统一成 `\n`：否则同一份源码在 CRLF 环境下会算出不同结果，
表现是"明明没改却报不同步"，那种红会训练人忽略它。

`setup.mjs --release` 里也接了同一条判定（`stale`/`unstamped` 都算 ❌），
所以**忘记重新构建会在发布验收这一步被拦住**，而不是等用户看到旧界面。

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

> ★★ **受保护路径清单**（H16）：下面是**可执行的数据**，不是文档里的叮嘱 ——
> 由 `src/protected-files.mjs` 定义、`scripts/assemble-release.mjs` 在**组装之前**强制检查
> （不通过就退出，**没有 `--force` 后门**），并由 `mocks/verify-release-hygiene.mjs` 盯着接线。
> 为什么要这么较真：发布脚本是**按清单拷贝**的，往 `COPY_DIRS` / `COPY_FILES` 里多写一行
> （比如顺手加上 `workspace-qq` 或 `logs`）就会把某个真实使用者的**聊天记忆、日志、token**
> 打进 zip —— 而这**不会有任何报错**（zip 里多两个目录而已）。
>
> | 类别 | 路径 | 规矩 |
> |---|---|---|
> | **user**（使用者的数据） | `config.json`、`workspace-qq`、`logs`、`cache`、`snowluma` | 不许进包、不许覆盖、**任何脚本都不许删** |
> | **artifact**（我们自己的产物） | `node_modules`、`_release` | 不进包；可以重生成，所以允许删 |
> | **junk**（临时残留） | `.tmp-probe-dsh`、`.tmp-verify-mcp` | 不进包；可以清掉 |
>
> ⚠️ 判定**忽略大小写**（Windows 上 `LOGS` 与 `logs` 是同一个目录 —— 只按区分大小写比对，
> `LOGS` 就能悄悄绕过清单）。要改这份清单，请同时改 `src/protected-files.mjs` 里的**理由**：
> 只写路径名的话，下一个人不知道它为什么不能动。

**要的：**

```
首次使用.txt              ★ 给非技术用户的上手说明
start.bat                 ★ 唯一入口（双击 = 启动；带开关时当自检/工具用）
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

`.gitignore` 里已经排除了 `logs/`、`workspace-qq/`、`vendor/`、`node_modules/`。

**★ 关于 `dist`（这段以前是错的，已更正）**：`config-ui/dist` **是发布必需件，
而且现在也进仓库**。以前两处 `.gitignore`（`config-ui/.gitignore` 的 `dist`
与仓库根的 `dist/`）把它挡在库外，后果是 `git clone` 出来的仓库**没有界面**、
构建不出 UI（因为 `config-ui/src/lib/` 下的 `api.ts` 等 3 个文件也被一条
无锚点的 `lib/` 规则误伤、从未入库）。现在：

* `config-ui/src/**` **全部入库**（`verify-manifest` 有一条断言盯着：
  `config-ui/src` 下每个文件都必须被 git 跟踪 —— 这条检查就是因为那次
  "`git status` 干干净净、clone 出来的仓库却构建不出界面"加的）；
* `config-ui/dist/**` **入库**（改了界面忘构建时，`git status` 会直接显示出来）；
* 例外写在仓库根 `.gitignore` 的**最后**（git 的否定规则对"已被忽略的目录"
  无效，而且必须排在 `dist/` 那条规则之后 —— 踩过，且 git 不会给任何提示；
  验证要看 `git check-ignore -v <文件>`，不要只看 `git status`）。

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

**0.2.6 起包里只有一个入口：`start.bat`。**

原来还有四个中文名壳（`启动机器人.bat` / `检查配置.bat` / `体检.bat` /
`创建带图标的快捷方式.bat`）与一份随包的 `QQbot.lnk`，按用户要求全部删除：

* 那三个 `.bat` 都只是 `call start.bat <参数>` 的**一行转发** —— 开关直接手敲即可
  （`start.bat --check` / `--doctor` / `--setup` / `--foreground` / `--no-browser`）；
* 随包的 `QQbot.lnk` 里存的是**绝对路径**（开发机的 `…\packages\qq-bridge\启动机器人.bat`），
  在别人机器上双击必然失效；而且它与"现场生成的 `QQbot.lnk`"**同名**，会互相覆盖。

**★ 图标：`.bat` 在资源管理器里永远显示默认的"白纸+齿轮"，这是 Windows 的限制**
（它不给 `.bat` 显示自定义图标）。想要带图标的常用入口，在使用者自己的机器上生成：

```powershell
powershell -NoProfile -Command "$s=New-Object -ComObject WScript.Shell; $l=$s.CreateShortcut((Join-Path $PWD 'QQbot.lnk')); $l.TargetPath=(Join-Path $PWD 'start.bat'); $l.WorkingDirectory=$PWD; $l.IconLocation='assets\icon.ico,0'; $l.Save()"
```

为什么不直接发一个做好的 `.lnk`：**`.lnk` 里存的是绝对路径**，在作者机器上生成的
那份指向作者的目录，换台机器目标与图标一起失效（图标退化成白纸）。现场生成就不会错。
（`首次使用.txt` 里也给了这条命令，面向用户的那一份写得更白话。）

**★ 双击 `start.bat` 的行为**：它把 SnowLuma 与桥接都起成**后台**进程，然后打印
控制台/SnowLuma 地址与日志路径，停两秒就结束 —— 所以窗口会关，但机器人**不会**跟着关。
启动失败时它**不关窗口**（打印错误并 `pause`），否则"双击一下什么都没发生"没法排查。


---

## 5. 组装发布包

**用脚本，不要手敲 robocopy。**

```bash
cd packages/qq-bridge
node scripts/assemble-release.mjs --dry-run   # 先看它要做什么
node scripts/assemble-release.mjs --zip       # 组装 + 压缩
node scripts/assemble-release.mjs --force     # 覆盖已有同名目录（会先删干净再建）
```

**★ 为什么必须有脚本**：上一次组装是手敲的，结果 `start.bat` 的中文名壳
（`启动机器人.bat`）/ `检查配置.bat` / `体检.bat` / `首次使用.txt`
（当时叫「先读我-首次使用.txt」）**只存在于发布包里、仓库里没有源** ——
文档的"最终形状"列了它们，而拷贝清单一条都没有，说明当时是手工补进去的，
然后没人记得。手敲清单必然漏项，而**漏项不会报错**。

脚本做的事（顺序不能换）：

| 步 | 做什么 | 为什么 |
|---|---|---|
| ① | 跑 `setup.mjs --release --json-out <文件>`，按**类别**判断哪类 ❌ 该拦住 | **真 config.json 的明文不算阻断** —— 组装根本不拷它（包里那份是 `config.example.json` 的副本）。把"使用者本机的配置"当成发不出去的理由，等于让脚本去改他的工作配置 |
| ② | 输出目录已存在就**拒绝**（要覆盖得显式 `--force`，且先删干净再建） | 老版本要留着对照；而且 `cpSync` 往已有目录上拷会抛难懂的 EIO |
| ③ | 清点源文件，缺一个都不组装 | 漏项不报错，所以要在组装**之前**数一遍 |
| ④ | 组装 + **自校验包里的 config.json 确实是空白** | 光"从模板复制"不够，复制完要再验一次结果 |
| ⑤ | 跑 `check-release-package.mjs`，看**退出码** | 不要挑它的输出文案判通过 |
| ⑥ | 可选 `--zip` | 用 `tar -a`（bsdtar），比 `Compress-Archive` 快且条目名用正斜杠 |

版本号**只从 `package.json` 读**（脚本里不写第二遍）。升级版本要改的地方由
`mocks/verify-manifest.mjs` 的一条断言盯着：**四处必须一致** ——
`package.json` / `PROJECT.json` 的 `package.version` / MCP server info /
`RELEASE.md` 里的包名。四处里漏改一处，症状是"包名写着 0.2.0、里面报的却是 0.1.0"。

**发布包的最终形状**（73 个文件 / 解压后约 87 MB / zip 约 32.6 MB）：

```
InteractBot-<版本>-win-x64/
├── 首次使用.txt             ← ★ 给**非技术用户**的完整上手说明（含官方下载链接）
├── start.bat               ← ★ 唯一入口：双击启动；`start.bat --check/--doctor` 自检
├── config.json             ← ★ 空白模板（密钥与本机路径全空）
├── config.example.json     ← 同一份，保留作参照（用户改坏 config.json 时可对照）
├── prices.json  package.json
├── AGENT.md  PROJECT.json  README.md  RELEASE.md  setup.mjs
├── src/                    桥接代码
├── mcp/                    QQ 工具服务器
├── assets/                 icon.ico 等
├── config-ui/dist/         ★ 只有构建产物 + 溯源标记 ui-build.json
└── vendor/
    ├── node/node.exe       85.6 MB
    └── node_modules/ws/
```

**★ 老版本不要删**：`_release/` 里每个版本各留一份目录
（旧版本与新版本**并存**，文件名前缀一样、只有版本号不同），
脚本也**不许覆盖同名目录**。zip **不入库**（与同名目录逐字节相同，却要多占约 32 MB）。

> ⚠️ 这份文档里**只允许出现当前版本号**（`InteractBot-<版本>-win-x64`）——
> `mocks/verify-manifest.mjs` 有一条断言盯着"文案里的版本号与 `package.json` 一致
> **且只有一种**"。要举例说明"旧版本并存"时用文字描述，不要写出具体的旧版本号，
> 否则那条断言会红（它没法区分"举例"和"漏改"）。

★ **小白文档不是装饰**：`首次使用.txt` 是包内唯一一份写给非技术使用者的文档
（其余 `AGENT.md` / `README.md` / `RELEASE.md` / `PROJECT.json` 分别面向 AI agent、
开发者和机器校验）。它必须给出四个下载链接、三步配置、常见故障对照，
以及"密钥非官方登录有账号风险"的提示。改动 README/配置项文案时记得同步它。

★ `start.bat` 的正文是**纯 ASCII**（.bat 由 cmd 按系统代码页解析，含中文会吞掉换行）。
它现在是**唯一**入口：不带参数 = 启动；带开关 = 自检/工具。开关的语义只有一处实现
（`src/index.mjs` 的分派），启动壳不复刻任何逻辑。

不带：`vendor/dsh`（用户自装）、`vendor/snowluma`（许可证不允许）、
`config-ui/{src,node_modules}`（202 MB，属项目开发资产）、
`logs` `cache` `workspace-qq` `mocks` `config.json.bak*`。

### 打包后必须跑一次验收脚本

```powershell
node packages\qq-bridge\scripts\check-release-package.mjs "$env:USERPROFILE\Desktop\_release\InteractBot-0.2.6-win-x64"
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
2. 双击 `start.bat` → 应能自建 `logs/`、`cache/`、`workspace-qq/`，并在窗口里
   打印控制台地址后自行结束（机器人是后台进程，关窗口不等于关机器人）。
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
