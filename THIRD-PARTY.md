# 第三方组件与出处（THIRD-PARTY）

> 这份文件是**如实声明**：本项目用了哪些别人的东西、它们各自的许可证是什么、
> 以及**哪些合规缺口还没补**。开源仓库里最容易被含糊过去的就是这一类，
> 所以这里逐条写清出处与状态，不做"看起来都合规"的暗示。

---

## 一、随**发布包**（`_release/InteractiveBot-*-win-x64.zip`）分发的

| 组件 | 版本 | 许可证 | 在包里的位置 | 许可证文本 |
|---|---|---|---|---|
| **Node.js 运行时** | v24.9.0 | MIT（并含其内置库各自的许可证：V8/ICU/zlib/c-ares/simdjson 等） | `vendor/node/node.exe` | ⚠️ **缺口，见下** |
| **ws**（WebSocket） | 8.x | MIT | `vendor/node_modules/ws/` | ✅ 已随附 `vendor/node_modules/ws/LICENSE` |
| **入口图标**（黑鲸鱼） | 取自 LobeHub Icons 的 `deepseek` 品牌图标（0.2.8 起） | 文件：MIT（© 2023 LobeHub）；**商标：不属于本项目，见下** | `assets/icon.ico` + `assets/icon.png` | 见下方专节 |

### ★ 入口图标的出处与商标说明（**请读这一节，别只看"MIT"两个字**）

- **文件出处**：[LobeHub Icons](https://github.com/lobehub/lobe-icons)（包 `@lobehub/icons`，
  [MIT LICENSE](https://cdn.jsdelivr.net/npm/@lobehub/icons@5.10.0/LICENSE)，Copyright © 2023 LobeHub），
  图标页：<https://lobehub.com/zh/icons/deepseek>。本项目用的是它的 **`deepseek` 品牌图标**（黑鲸鱼）。
- ⚠️ **MIT 授的是"这份文件"，不含品牌商标权。** 它是 DeepSeek 的**品牌标志**，
  商标权归其权利人 —— 开源许可证**不可能**授予商标许可。这一点在"免费图标库"里最容易被误解：
  **文件能自由再分发 ≠ 可以把它当自己产品的 logo 用。**
- **本项目的用法与立场**：这个图标只用于**指代本项目所连接的生态**（一个跑在 DSH 上的 QQ 机器人），
  **不是**在声称官方或有背书关系。仓库里相应位置都写了"**非官方**"：
  `README.md` 的开源说明、`NOTICE`、以及 `docs/0.2.8-release-notes.md`。
- **本项目非官方**：与 DeepSeek、DeepSeek Harness（DSH）及其权利人**没有任何隶属、赞助或背书关系**；
  `DeepSeek`、`DeepSeek Harness`、该鲸鱼标志是其各自权利人的商标。
- **想彻底零风险的话**：换成一张**不含他人商标**的图标（自己画的鲸鱼，或中性符号）。
  母版是 `assets/icon.png`，重生成 7 帧只需跑
  `cache/make-icon-frames.ps1` + `cache/build-ico.mjs`（原因与踩坑写在 `PROJECT.json` 的
  `files["assets/icon.ico"]` 里）。**这是本项目当前"已知但已声明"的一项，不是未发现的问题。**

### ⚠️ 已知合规缺口：包里没有随附 Node.js 的 LICENSE

Node.js 是 MIT，**再分发时要求随附它的许可证与版权声明**。当前发布包里
`vendor/node/` 只有 `node.exe`，**没有** `LICENSE` —— 这是本仓库目前**唯一**一处
未闭合的再分发合规缺口，如实写在这里，不装作没有。

**怎么补（一步）**：Node 的官方发行包（<https://nodejs.org/dist/v24.9.0/>）解压后
根目录就有一份 `LICENSE`（约 150KB，含 Node 本体与所有内置库的许可证）。
把它放到：

```
packages/qq-bridge/vendor/node/LICENSE
```

就**自动进包**了 —— `scripts/assemble-release.mjs` 的 `COPY_DIRS` 里写的是
`join('vendor','node')`（整个目录），所以放进去不需要改任何代码。
放好之后重跑 `node scripts/assemble-release.mjs --force --zip` 即可。

> 开发机的 `D:\nodejs` 是一份**精简安装**，里面没有 `LICENSE`，所以自动化没能替我拷过来。

**为什么仓库里不内嵌这份文本**：它很长（含每个内置库的许可证）。本项目选择
**指路**而不是塞一份可能残缺的副本 —— 一份不完整的许可证比没有更误导。

---

## 二、仓库里保留、但**不随包分发**的第三方内容

| 内容 | 出处 / 署名 | 许可证 | 状态 |
|---|---|---|---|
| `.dsh/skills/`（10 个 DSH 插件开发 skill） | DSH 插件生态（**非本项目作品**） | **MIT**（`LICENSE.dsh-plugin-upgrade-skill` 已随附） | ✅ 合规（保留许可证即可） |
| `reference/pixiv-lookup-1.1.0/` | 上游 "pixiv查图插件" v1.1.0，`skill.json` 署名 `QQ Agent` | ⚠️ **未标注许可证** | ⚠️ 见下 |
| `reference/video-frames-1.0.0/` | 上游 video-frames 插件 1.0.0，`plugin.json` 署名 `QQ Agent` | ⚠️ **未标注许可证** | ⚠️ 见下 |
| `dsh-adapter-qq-技术分析报告.md` | 对 npm 包 `dsh-adapter-qq@0.1.3`（作者 JiXieShi，**MIT**）的**原创分析** | 本项目原创（Apache-2.0） | ✅ 不是源码副本，只是分析与引用 |

### ⚠️ 那两份 `reference/` 上游原件：许可证未标注

它们是**适配前后的对照留档**（本项目对它们的适配改动逐处记在
`docs/0.2.2-pixiv-skill-migration.md` 与 `docs/0.2.7-video-frames-migration.md`）。
上游文件本身**没有写许可证**，本项目也**无法替作者授权**。因此：

* 保留它们是为了让"改了什么"可复算、可审计；
* **如果你（或原作者）不希望它们出现在公开仓库里**，请提 issue ——
  我们会把对应目录移除（适配后的那份 `packages/qq-bridge/skills/...` 不受影响）。
* 使用者若要把这两份原件用于自己的项目，**请先自行联系原作者确认授权**。

---

## 三、**不包含**、需要使用者自备的

| 组件 | 为什么不随包 | 你要怎么做 |
|---|---|---|
| **DeepSeek Harness（DSH）** | 本项目只是它的"外部驱动"（`dsh --profile sdk`），不是它的分发渠道 | 自己安装 DSH 桌面版；桥接会按候选顺序找它（见 `packages/qq-bridge/README.md`） |
| **SnowLuma**（QQ 协议端） | 它的许可证**不允许**随第三方安装包分发；仓库里也在 `.gitignore` 里忽略（`/snowluma/`） | 自己去它的 Releases 下载，解压到本机任意位置，在控制台或配置里指给桥接 |
| **ffmpeg**（"视频识别"技能用） | 体积 + 许可证 + 三平台各一份；技能只查"设置里的路径"与系统 `PATH` | 自己装（或用现成的 `full_build` 包），把 `ffmpeg.exe` 的完整路径填进「控制台 → 扩展 → 视频识别 → 设置」 |

---

## 四、平台规则与免责声明（**请先读这一节再使用**）

* 本项目通过**第三方协议端**（OneBot v11 / SnowLuma）以**个人 QQ 号**登录并收发消息。
  **这种方式本身违反《QQ 用户协议》**，存在账号被限制、被冻结、被封禁的风险
  （项目里的风险记录：`docs/implementation-plan.md` §5）。
* 仓库作者**不对任何账号后果负责**，也**不提供**任何规避平台风控的承诺；
  项目内部那些"拟人延迟 / 频率上限 / 慎发标签"只是**降低**特征强度，不是保证。
* 请只用自己的小号试、别在重要群里刷、别 24 小时秒回。
* 请遵守你所在地区与平台的法律法规；不要用它发垃圾信息、骚扰他人或做任何违规用途。

---

## 五、本项目的许可证

Apache License 2.0 —— 见仓库根目录的 `LICENSE` 与 `NOTICE`。
