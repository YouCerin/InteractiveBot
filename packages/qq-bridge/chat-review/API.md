# 聊天记录评审台 —— 前后端契约

> 这份文件是**契约**：`chat-review/public/app.js`（页面）与 `src/chat-review-server.mjs`（服务）
> 都按它来。改任何一边都必须同步改这里。
>
> ⚠️ 有一条断言盯着它：`mocks/verify-chat-review.mjs` 会把 `app.js` 里出现的
> 每个 `/api/...` 字符串抽出来，逐个核对服务端**真的有这条路由** —— 因为
> "页面调了一个不存在的接口" 是这类小工具最常见的坏法，而它只会在浏览器里表现为
> "点了没反应"（服务端日志干干净净）。

约定与仓库其它接口一致：

- 只监听 `127.0.0.1`；
- 响应一律 JSON（`content-type: application/json; charset=utf-8`），`cache-control: no-store`；
- 成功 `{ ok: true, ... }`，失败 `{ ok: false, error: '中文、给人看的理由' }`，
  状态码用 400（输入不对）/ 404（没有这东西）/ 409（状态冲突）/ 500（真炸了）；
- 路径穿越一律 403；
- **写操作只有三件事**：写评分（`POST /api/score`）、删批次、应用草稿（`POST /api/apply`）。
  前两件只动工作区里的评审数据；第三件动 `styles/闲聊.md`，**必须先备份、必须显式确认**。

---

## 一、数据模型

### 1. 回合（item）—— 被评分的单位

一个回合 = **机器人当时那句话** + **它前面的一小段上下文**。风格是"接话"的质量，
脱离上下文没法判断（单看「没有手机」没问题，结合"你用什么手机"才知道它答得好不好）。

```json
{
  "id": "c:group:860771987:13579",
  "batch": "corpus-2026-10-02T06-40",
  "source": "corpus",
  "chatKey": "group:860771987",
  "chatLabel": "群 860771987",
  "at": 1759384800000,
  "context": [
    { "name": "店长Keeper", "text": "鱼头用的什么手机", "isBot": false }
  ],
  "reply": "手机？我住在一台 X99 主板的机箱里面，没有手机"
}
```

- `id` **稳定且可重建**：同一批数据重复导入不会产生重复条目（去重靠它）。
- `context` 最多 3 条（默认 1 条），按时间正序；`isBot: true` 表示那也是机器人说的。
- `reply` 是**纯文本**（图片/表情包等非文字段已在导入时折叠成 `[图片]` 这类标记）。

### 2. 评分（score）—— 人工打的

```json
{
  "id": "c:group:860771987:13579",
  "verdict": "bad",
  "tags": ["memory_detail", "self_intro"],
  "note": "问手机就答手机",
  "at": 1759384900000
}
```

- `verdict` 三档：`good`（就该这么说）/ `ok`（不算错，但可以更好）/ `bad`（不该这么说）。
- `tags` 是税则里的 id（见下），可以多选、可以空。
- **一条 item 只有一个 score**；重复提交 = 覆盖（评错了就是重评，不需要先删）。
- 评分**每一条立刻落盘**（没有"保存"按钮 —— 评几百条时攒着必丢）。

### 3. 标签税则（taxonomy）—— 打分时点的那些标签

每个标签都**挂在一句现有规则上**（`ruleQuote` 是 `styles/闲聊.md` 里的原文片段）。
这条链子是有意的：标签是"哪条规则没被遵守"的可数证据，而"没有证据的规则"
和"没有规则的证据"都会漂。

```json
{ "id": "memory_detail", "label": "主动抖记忆", "kind": "bad",
  "hint": "把记忆里的细节当谈资（显卡/机箱/主板这种）",
  "ruleQuote": "别主动抖记忆里的细节" }
```

`kind: "good"` 的标签是用来**表扬**的（例如"接住了对方的戏"），报告里分开统计。

---

## 二、路由

### `GET /api/health`

```json
{ "ok": true, "startedAt": 1759384800000, "tool": "chat-review",
  "workspace": "C:\\...\\workspace-qq",
  "corpus": { "ok": true, "rows": 3598 },
  "styleFile": { "path": "C:\\...\\styles\\闲聊.md", "exists": true, "chars": 1948, "sha256": "ab12…" } }
```

`startedAt` 用来分辨"页面跑的是不是新起的进程"（页面右上角显示它）。

### `GET /api/taxonomy`

```json
{ "ok": true,
  "verdicts": [ { "id": "good", "label": "就该这么说", "key": "1" },
                { "id": "ok",   "label": "还行",       "key": "2" },
                { "id": "bad",  "label": "不该这么说", "key": "3" } ],
  "tags": [ { "id": "too_long", "label": "太长", "kind": "bad", "hint": "…", "ruleQuote": "极短" } ],
  "drift": [ { "id": "xxx", "why": "这条标签挂的规则原文在 styles/闲聊.md 里找不到了" } ] }
```

`drift` 非空 = 风格文件改了、税则没跟上（页面要显眼地提示，但**不拦着用**）。

### `GET /api/sources`

```json
{ "ok": true,
  "corpus": { "ok": true, "why": null,
    "chats": [ { "chatKey": "group:860771987", "label": "群 860771987",
                 "botReplies": 412, "total": 3598, "lastAt": 1759384800000 } ] },
  "batches": [ { "id": "corpus-2026-10-02T06-40", "label": "群 860771987 · 语料库",
                 "source": "corpus", "items": 120, "scored": 34, "createdAt": 1759384800000 } ] }
```

### `POST /api/pull` —— 从语料库拉一个批次

请求：`{ "chatKey": "group:860771987", "limit": 120, "contextBefore": 1, "batchLabel": "第一天" }`

- `limit` 上限 500（默认 100）；`contextBefore` 0~3（默认 1）。
- 只取 `is_bot = 1` 的消息当 `reply`；跳过空的/纯标记的回复。
- 响应：`{ "ok": true, "batch": {...}, "items": [...], "added": 118, "skipped": 2 }`

### `POST /api/import` —— 从粘贴/文件导入

请求：`{ "format": "forward-json" | "text", "text": "…", "batchLabel": "老王发的记录" }`

- `forward-json`：QQ「合并转发」导出的 JSON（既接受 `get_forward_msg` 的
  `{messages:[{sender:{nickname},message:[{type:'text',data:{text}}]}]}` 形状，
  也接受只带 `nickname`/`content` 的扁平形状）；也接受 **OneBot 事件数组**。
- `text`：纯文本聊天记录，一行一条，`昵称: 内容`（中文冒号也行）。无法识别的行进 `warnings`。
- **只有机器人自己的发言才能当 `reply`**：机器人昵称从 `config.json` 的
  `onebot.selfId`/登录昵称拿不到时，用 `POST` 里的 `selfNames`（默认 `["小鲸鱼","小鱼","D指导"]`）判断。
- 响应：`{ "ok": true, "batch": {...}, "items": [...], "warnings": ["第 12 行认不出昵称，已跳过"] }`

### `GET /api/items?batch=<id>&filter=unrated|rated|all&limit=&offset=`

```json
{ "ok": true, "batch": { "id": "…", "label": "…", "items": 120, "scored": 34 },
  "total": 120, "offset": 0,
  "items": [ { "…item…": "…", "score": { "verdict": "bad", "tags": [], "note": "", "at": 0 } } ] }
```

`unrated` 是打分页的默认过滤（**永远先推没评的**）。`limit` 默认 20，上限 200。

### `POST /api/score`

请求：`{ "id": "…", "verdict": "good|ok|bad", "tags": ["…"], "note": "…" }`
响应：`{ "ok": true, "score": {...}, "progress": { "scored": 35, "total": 120 } }`

- `verdict` 不在三档里 / `id` 不属于任何批次 → 400；`tags` 里有未知 id → 400 并逐个点名。

### `POST /api/undo`

请求：`{ "batch": "…" }` → `{ "ok": true, "undone": {…}|null, "progress": {…} }`
（撤销该批次**最后一次**评分；没有可撤的时 `undone: null`，仍然 200。）

### `GET /api/stats?batch=<id|all>`

```json
{ "ok": true, "scope": "all",
  "verdicts": { "good": 20, "ok": 9, "bad": 41 },
  "rate": { "good": 0.29, "bad": 0.59, "scored": 70, "total": 200 },
  "tags": [ { "id": "too_long", "label": "太长", "kind": "bad", "count": 12,
              "examples": [ { "id": "…", "reply": "…", "context": "…" } ] } ],
  "chats": [ { "chatKey": "group:860771987", "label": "群 860771987", "scored": 40, "bad": 22 } ] }
```

`examples` 最多 3 条（报告页要看"到底哪几条"）。

### `GET /api/draft?batch=<id|all>`

```json
{ "ok": true,
  "draft": {
    "target": "styles/闲聊.md",
    "suggestions": [ { "tagId": "memory_detail", "label": "主动抖记忆", "count": 6,
                       "advice": "这条规则已经被真人标出 6 次，考虑把它写得更具体",
                       "ruleQuote": "别主动抖记忆里的细节" } ],
    "proposedBlock": "【评审台：真人标过"不对"的原话（别再说成这样）】\n- ❌「…」← 主动抖记忆\n…",
    "diff": "--- a/styles/闲聊.md\n+++ b/styles/闲聊.md\n@@ …",
    "evidenceCount": 14
  } }
```

- `proposedBlock` 是**确定性生成**的（无模型调用）：每个 `bad` 标签取最多 2 条真实反例，
  连同它挂的规则名，写成一段可读的清单。
- `diff` 是**统一 diff 文本**（页面用 `<pre>` 上色显示 `+`/`-` 行），不是自动改写。
- 一条 `bad` 都没有时 `proposedBlock: ""`、`diff: ""`（页面显示"还没有足够证据"）。

### `POST /api/apply`

请求：`{ "confirm": true }`

- 把 `GET /api/draft` 算出来的 `proposedBlock` **追加**到 `styles/闲聊.md` 末尾。
- 先备份到 `styles/.backups/闲聊.md.<时间戳>.bak`，再写；返回
  `{ "ok": true, "backup": "…bak", "sha256": "…", "chars": 2100, "appended": 260 }`。
- `confirm !== true` → 400（**没有默认应用这件事**）。
- 没有草稿内容 → 400。
- 重复应用同一份草稿 → 409（`proposedBlock` 已经在文件里了，不许写第二遍）。

### `POST /api/shutdown`

**请这个实例自己退出**（给"启动时先接管端口"用，2026-10-02 用户要求）。

请求：空 body。响应：`{ "ok": true, "stopping": true, "hint": "正在退出；新的实例会接管这个端口。" }`

- 用途：新实例启动时若发现端口上已经有一份评审台，**先调它**，让旧的让位 ——
  否则使用者双击 `启动评审.bat` 只会看到"窗口自己关了"（EADDRINUSE）。
  完整判定树见 `src/chat-review-server.mjs` 的 `stopRunningReviewServer`。
- **没接 `onShutdown` 的实例回 501**（测试里随手起的那些），**绝不假装退出**。
- ⚠️ 它不是远程关机后门：只监听 127.0.0.1、只关自己，而且要显式 `POST`。

### `DELETE /api/batch?id=<id>`

删除批次与它的全部评分（只删工作区里的评审数据，**不动语料库、不动风格文件**）。

---

## 三、页面要有哪些东西（`public/`，无构建）

三个页签，全部中文，零依赖（**不许引 CDN**，离线也要能用）：

1. **导入**
   - 数据源一：语料库 → 会话下拉（显示"机器人发言 N 条 / 共 M 条"）+ 条数 + 「拉取」；
   - 数据源二：粘贴框（合并转发 JSON / 纯文本二选一）+ 「解析预览」→ 显示认出了几条、
     哪些行没认出来（`warnings` 原样列出来）；
   - 已有批次列表（条数/已评/来源）+ 删除。
2. **打分**（主战场 —— 要能连续评几百条而不累）
   - 进度条 + `已评 / 总数`；
   - 卡片：上面是上下文（淡色、可折叠），下面是**机器人那句话**（大字）；
   - 三个大按钮：`1 就该这么说` / `2 还行` / `3 不该这么说`（键盘同样可用）；
   - 标签按钮（bad 一组、good 一组），数字键 `4`~`9`/`0` 绑定前几个，多选，点一下即落盘；
   - 备注框（失焦即存）；
   - `Enter` 下一条、`U` 撤销上一条、`S` 跳过这条（只跳过，不写分）；
   - 评分后**立刻**显示下一条（不等网络往返把人晾着）。
3. **报告**
   - 好/还行/不该这么说 的分布（含百分比）；
   - 标签命中排行（按次数），点一个标签能看它的**证据原文**；
   - 「生成修订草稿」→ diff 预览（`+` 绿 `-` 红）+ 「应用到 styles/闲聊.md」
     （二次确认弹窗里要写清"会先备份"）+ 应用后显示备份路径与新的 sha256。

页面顶部常驻：`[评审台] 工作区 … ｜ 语料库 N 条 ｜ 风格文件 1948 字 ｜ 启动于 …`（来自 `/api/health`），
以及一个错误横幅（任何 `ok:false` 都把 `error` 显示出来，**不许静默失败**）。
