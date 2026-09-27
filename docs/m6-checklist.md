# M6 部署与联调操作清单

> ★★ **0.2.5：这份清单针对的 `packages/dsh-qq-bot（废弃）` 已按用户要求删除 ——
> 下面的步骤已经无法执行，本文件仅作历史存档**（当时的部署流程与踩坑记录）。
> 现在的部署入口见 `packages/qq-bridge/README.md` 与 `packages/qq-bridge/RELEASE.md`。

> 目标：把 `dsh-qq-bot` 装进桌面版 DSH，接上真实 QQ 协议端，跑通端到端对话。（历史目标）

## 环境事实（本机）

| 项 | 值 |
|---|---|
| 插件路径 | `C:\Users\18007\Desktop\project_InteractBot\packages\dsh-qq-bot` |
| DSH 桌面版 | dsh-desktop 0.9.1，内嵌 `@deepseek-ai/dsh@0.1.5-rc.2` |
| DSH_HOME | `C:\Users\18007\AppData\Roaming\dsh-desktop\harness` |
| profile | `web`（`$DSH_HOME\profiles\web`） |
| dsh CLI | `D:\DeepSeekHarness\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js` |
| 插件服务键 | `qq-bot`（host 行 id） |

---

## 阶段 0：前置准备

- [ ] 一个 QQ 号（机器人专用，需能登录协议端）
- [ ] DeepSeek API key（补回复用）
- [ ] 确认 DSH 桌面版能正常打开 Web GUI

---

## 阶段 1：部署 QQ 协议端（NapCat，主推）

NapCat 是当前主流 OneBot 11 协议端，免编译、易部署。

1. 下载 NapCat：<https://github.com/NapNeko/NapCatQQ>（Releases 或一键安装器 NapCatInstaller）。
2. 配置 OneBot 11 正向 WebSocket：
   - 打开 NapCat 的 WebUI/配置，开启 **WebSocket 服务（正向）**，监听 `ws://127.0.0.1:3001`。
   - 设置 **access token**（记下来，阶段 3 用）。
3. 用 QQ 号登录（扫码），确认协议端状态正常。
4. 验证：NapCat 日志显示 WS 服务已监听 `3001`。

> 备选：Lagrange.Core（OneBot 实现，C#），配置项同名，见 <https://github.com/LagrangeDev/Lagrange.Core>。
> 注意：QQ 官方不开放个人机器人接口，协议端存在封号风险，建议用小号测试。

---

## 阶段 2：构建插件（已完成）

```powershell
cd "C:\Users\18007\Desktop\project_InteractBot\packages\dsh-qq-bot"
npm install --cache .\.npm-cache
npm run build
# 产物：lib/index.js + lib/client.js + lib/*.js + lib/types/*.d.ts
```

---

## 阶段 3：安装插件到 profile（三选一）

### 方式 A：dsh CLI（推荐，确定性）

```powershell
node "D:\DeepSeekHarness\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js" `
  plugin --profile web add "C:\Users\18007\Desktop\project_InteractBot\packages\dsh-qq-bot"
```

- 该命令在 profile 目录跑 pnpm，把插件装进 `node_modules`，并把带 `dsh.bundle` 声明的包 reconcile 进 `dsh.profile.bundles`。
- 若 CLI 需要 DSH_HOME，先 `$env:DSH_HOME = "C:\Users\18007\AppData\Roaming\dsh-desktop\harness"`。

### 方式 B：手动改 profile（CLI 不可用时）

编辑 `$DSH_HOME\profiles\web\package.json`：

```jsonc
{
  "dependencies": {
    // ...已有...
    "dsh-qq-bot": "link:../../../../../Users/18007/Desktop/project_InteractBot/packages/dsh-qq-bot"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...已有...，追加：
        "dsh-qq-bot"
      ]
    }
  }
}
```

然后在 profile 目录跑 `pnpm install`（注意：插件 peer 依赖 `@deepseek-ai/*` rc.2、react 需由 profile 的 node_modules 提供，已由 base/web-app bundle 满足）。

### 方式 C：桌面 GUI

设置 → 插件 → 从本地/市场安装（若桌面版提供"本地文件夹安装"入口，选插件目录）。

---

## 阶段 4：配置（profile 的 cordis.patch.yml）

编辑 `$DSH_HOME\profiles\web\cordis.patch.yml`，追加（id 定向覆盖插件行）：

```yaml
- id: qq-bot
  config:
    enabled: true
    endpoint: ws://127.0.0.1:3001      # NapCat 正向 WS 地址
    accessToken: "<阶段1的token>"        # 无 token 则留空
    selfId: ""                          # 可选，指定登录 QQ 号
    dataDir: ""                         # 空 = $DSH_HOME/storages/qq-bot
    persona: "你是 QQ 群里的智能助手，回复简洁友好。"
    modelProvider: deepseek-official      # 与 DSH 已注册的 provider 一致
    model: deepseek-flash                 # 与 DSH 已注册的 model 一致
    allowlistEnabled: false               # 开启后仅回复白名单中的好友/群
    replyTrigger:
      private: { enabled: true }
      mention: { enabled: true }
      keyword: { enabled: false, keywords: [] }
      random: { enabled: false, probability: 0 }
    sustain:                              # 唤醒窗口仅群聊生效
      enabled: true
      silentLimit: 3                      # 连续 3 条未 @/未命中关键词即结束该唤醒者窗口
      maxReplies: 20                      # 单窗口最多自动回复次数
    memory:
      halfLifeDays: 7
      boost: 0.2
      forgetThreshold: 0.1
      injectTopK: 5
      injectMaxTokens: 400
```

> 白名单在 GUI「白名单」页签里点「从 QQ 读取好友 / 群」勾选后保存；也可直接 `POST /plugins/qq-bot/allowlist`。

---

## 阶段 5：配置 DeepSeek API key

补回复通过 `ctx.llm` 调 DeepSeek，需在 DSH 配好 API key：

- 桌面 GUI：设置 → 模型/凭据 → DeepSeek → 填 API key（或编辑 `$DSH_HOME\.credentials.yaml`）。
- 确认 `provider: deepseek-official` / `model: deepseek-flash` 与实际注册的 provider/model 名一致
  （不一致会报 `NO_ADAPTER`；插件启动时会自动校验并回退，日志里会打印警告）。

---

## 阶段 6：重启 + 分层验证

1. **重启 profile**（关掉重开 DSH 桌面版，或重启对应 profile），浏览器刷新（client 侧改动需要）。
2. **看 host 日志**：无插件加载报错、无 `[qq-bot]` 错误。
3. **连接状态**：
   - GUI 面板「设置」tab → `connected: 已连接`。
   - 或 agent 调 `qq_bot_status` 工具；或 `GET /plugins/qq-bot/status`。
4. **私聊**：小号给机器人 QQ 发私聊 → **每条都应回复**（`replyTrigger.private`），不进入唤醒态。
5. **群聊 @ 触发**：群里 @机器人 → 应回复，并在日志/「诊断」页签看到「触发·唤醒 · 唤醒者 uXXX」。
6. **唤醒窗口**（仅群聊）：
   - 唤醒后再发**同话题**消息 → 持续回复；
   - 切换话题 → 「唤醒结束 · 话题已切换」，且该条不回复；
   - 连续发 3 条既没 @ 也没关键词的消息 → 「唤醒结束 · 连续 3 条未提及 bot」；
   - 唤醒期间别人 @ 机器人 → 照常回复，且不影响原唤醒者。
7. **白名单**：GUI「白名单」页签勾选一个群保存 → 未勾选的群不再回复，日志出现「白名单拦截」。
8. **记忆**：攒 20 条消息后触发抽取 → GUI「记忆」tab 出现条目；私聊用户出现 `u:<qq>` 印象。
9. **用量**：回复后 GUI「用量」tab 出现 token 记录。
10. **会话终端**：GUI「会话」tab 看到会话与消息流（含思考折叠）、「补一次回复」按钮、清空。
11. **诊断页签**：确认「实际使用」为 `deepseek-official / deepseek-flash`、「上次错误」为空；有异常时「最近事件」能直接看出是哪一步被拦下。
12. **离线验证**（可选，安装后不 boot）：`node <dsh bin> --profile web --dump-config` 确认组合树里有 `qq-bot` 行。

---

## 阶段 7：常见问题排查

| 现象 | 排查 |
|---|---|
| `connected: false` | endpoint 拼写/端口、NapCat 是否开了正向 WS、accessToken 是否匹配、防火墙 |
| 不回复 | 先看 GUI「诊断」页签的**最近事件**：`未触发`（触发开关/条件不命中）、`白名单拦截`（未勾选该会话）、`失败`（模型或发送出错）；「上次错误」会给出具体原因 |
| 报 `NO_ADAPTER` / 路由失败 | `modelProvider`/`model` 与 DSH 注册名不一致（正确值为 `deepseek-official` / `deepseek-flash`），或 API key 未配 |
| 群里该回不回 / 过度回复 | 唤醒窗口规则：话题切换、连续 `silentLimit` 条未提及、超 `maxReplies` 都会结束窗口；`sustain.enabled=false` 则只回触发那一条 |
| 记忆为空 | 消息数 < 20 未触发抽取；`parseItems` 失败（LLM 输出非 JSON）看 host 日志 |
| 用量为 0 | 同上，回复未成功或 provider 未配 |
| 面板打不开 | 浏览器强刷（client bundle 缓存）；确认 `dsh.client` + `exports["./client"]` 生效 |
| 改了插件代码但行为没变 | 该 profile 无 host 侧 HMR，必须重启 DSH 桌面端 |

---

## 已知待补（联调后按需做）

1. **群内逐成员印象**：目前群友印象仅来自私聊。
2. **成本估算**：`usage_events.cost` 目前恒空，需接模型单价表。
3. **唤醒窗口持久化**：目前仅存内存，重启即重置。
