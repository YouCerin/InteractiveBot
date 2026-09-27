# dsh-qq-bot

可配置的 QQ 对话机器人桥接插件，把 QQ 接入 DeepSeek Harness（DSH）。

## 目标架构

```
QQ 用户 ──► QQ 协议端(NapCat/Lagrange/go-cqhttp, OneBot 11)
                │  WebSocket(正向 WS) / HTTP
                ▼
        dsh-qq-bot (本插件, host 侧)
                │  tools: qq_bot_send_group_message / qq_bot_send_private_message
                ▼
          DSH Agent（模型会话）
```

- **host-only**：无 `dsh.client`、无 client bundle，只有 `lib/index.js` 挂在 host 组合树。
- 连接层优先走 **OneBot 11 正向 WebSocket**（`ws://`），必要时可换 AstrBot 等框架的 HTTP API。
- 插件把收到的 QQ 消息转成 agent 可见事件，并注册工具让 agent 回消息。

## 目录

```
packages/dsh-qq-bot/
├── package.json          # dsh.bundle + dsh.client + exports
├── cordis.patch.yml      # 向 host 组合树插入插件行
├── tsconfig.json         # host 编译
├── tsconfig.client.json  # client 编译（CommonJS → 闭包工厂）
├── scripts/
│   └── build-client.mjs  # 包裹 client bundle 为 __ModuleLoader__ 闭包
└── src/
    ├── index.ts          # host 入口：触发决策 + 工具 + 路由
    ├── onebot.ts         # OneBot11Client 连接层
    ├── store.ts          # SQLite 持久化
    ├── reply.ts          # ReplyService：llm 补回复 + 思考 + 用量
    ├── memory.ts         # MemoryService：抽取 + 衰减软删 + 注入
    ├── config-store.ts   # 配置持久化（config.json + deepMerge）
    └── client/
        └── index.tsx     # 侧边栏入口 + main 面板：会话/记忆/用量/设置(可编辑)
```

## 注册的工具

| 工具 | 用途 |
|---|---|
| `qq_bot_status` | 连接状态 + 会话/消息计数 |
| `qq_bot_send_group_message` | 向 QQ 群发文本消息 |
| `qq_bot_send_private_message` | 向 QQ 用户（私聊）发文本消息 |
| `qq_bot_list_conversations` | 列出会话（群/私聊，含消息数） |
| `qq_bot_get_conversation` | 读某会话历史（含思考） |
| `qq_bot_delete_message` | 删除一条消息 |
| `qq_bot_get_recent_messages` | 拉取最近消息（跨会话） |

## 开发

```sh
pnpm install    # 装 @deepseek-ai/* 类型 + typescript + ws
pnpm build      # tsc → lib/
pnpm typecheck  # tsc --noEmit
```

> 说明：`@deepseek-ai/*` 已锁定到 `0.1.5-rc.2`（与桌面 runtime 一致）；`cordis@4.0.2`、`schemastery@3.18.2`。
> SQLite 用 Node 24 内置 `node:sqlite`（实验性，无原生编译）。
> 沙箱下 npm 缓存目录在 workspace 外会被拒，用 `npm install --cache ./.npm-cache` 重定向。

## 安装到 DSH profile

```sh
dsh plugin --profile web add /absolute/path/to/packages/dsh-qq-bot
# 重启该 profile 后生效
```

## 配置（cordis.patch.yml 覆盖示例）

```yaml
- id: qq-bot
  config:
    enabled: true
    endpoint: ws://127.0.0.1:3001
    accessToken: ""
    selfId: ""
    commandPrefix: "/"
    dataDir: ""        # 空 = $DSH_HOME/storages/qq-bot；支持 ~/ 前缀
    persona: "你是 QQ 群里的智能助手"
    modelProvider: "deepseek"
    model: "deepseek-chat"
    replyTrigger:
      private: { enabled: true }
      mention: { enabled: true }
      keyword: { enabled: false, keywords: [] }
      random: { enabled: false, probability: 0 }
    sustain: { enabled: true, mode: mention, maxMessages: 10, topicMaxTurns: 20 }
    memory: { halfLifeDays: 7, boost: 0.2, forgetThreshold: 0.1, injectTopK: 5, injectMaxTokens: 400 }
```

## 当前状态

- [x] 插件骨架：package.json / cordis.patch.yml / tsconfig / src
- [x] OneBot 11 正向 WebSocket 连接 + `Authorization: Bearer` 鉴权
- [x] echo 请求/响应配对 + 超时 + `get_login_info` self-id 校验
- [x] 断线重连（指数退避）+ `ctx.effect` 生命周期清理
- [x] 消息接收 → SQLite 持久化（`node:sqlite`，冒烟测试通过）
- [x] 会话/消息工具（`qq_bot_list_conversations` / `get_conversation` / `delete_message` / `get_recent_messages`）
- [x] HTTP 路由（webServer 可用时注册 conversations 读/清空）
- [x] 依赖锁定 `0.1.5-rc.2` + `npm run typecheck` / `build` 通过
- [x] M3：触发决策（关键词/被@/私聊/随机 + 唤醒态双模式）+ 补回复（`llm` + thinking + 用量落库）
- [x] M4：记忆系统（强度 + 衰减软删归档 + 批量抽取 + 回复注入 + 查看/遗忘工具）
- [x] M5：独立 UI 面板（`shell.overlay` + 会话/记忆/用量/设置四 tab + status/memories/usage/reply 路由）
- [ ] M6：协议端部署 + 真实联调
