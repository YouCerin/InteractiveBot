# 聊天记录评审台 —— 前后端契约

> 这份文件是**契约**：`chat-review/public/app.js`（页面）与 `src/chat-review-server.mjs`（服务）
> 都按它来。改任何一边都必须同步改这里。
>
> ⚠️ 有一条断言盯着它：`mocks/verify-chat-review.mjs` 会把 `app.js` 里出现的每个
> `/api/...` 字符串抽出来，逐个核对服务端**真的有这条路由** —— 因为"页面调了一个
> 不存在的接口"是这类小工具最常见的坏法，而它只会在浏览器里表现为"点了没反应"。

约定与仓库其它接口一致：只监听 `127.0.0.1`；响应一律 JSON、`cache-control: no-store`；
成功 `{ok:true, ...}`，失败 `{ok:false, error:'中文的、给人看的理由'}`（400 输入不对 /
404 没有这东西 / 409 状态冲突 / 500 真炸了）；路径穿越 403。

---

## 〇、这个工具现在的形状（2026-10-02 改版，**先读这段**）

```
导入真实聊天记录  →  一条条「判档 + 写评论」  →  把评论**整理成「点」**  →  据此**整篇重写** styles/闲聊.md
```

三件事必须清楚：

1. **素材是评论，不是标签。** 第一版让人从一张手写标签表里选（太长 / 像客服 …），
   使用者判定「标签系统并不合理」—— 标签是**我预先想好的分类**，他没想到的问题就永远
   进不了统计。现在只判三档（对 / 还行 / 不对）**加一句自由评论**。
2. **「点」是长期存在、可编辑的评论词汇表。** 由模型把评论归纳成若干条点（3~8 条最好），
   使用者原话是「从我的评论中整理新的点放上去」。
3. **草稿是整篇重写**（可按需精简），不是"往文件尾追加一段"。改写必须过**锚点核对**
   （底线要点一条都不许丢），且永远是"人点确认 + 先备份"。
4. **点顶替原来的标签系统**（2026-10-02 使用者拍板）—— 位置就在打分卡片上原来那排标签按钮
   的地方，用途是**让评论更快**。与标签的根本差别：标签是**我预先想好的分类**（改不动、长不出来）；
   点是**从评论里长出来的**（整理时把说法相近的评论并进同一个点），而且**可以改标题/摘要、
   可以删、可以新建**。点表存在 `runtime/chat-review/points.json`，为空时由服务**幂等播种**
   （非空则一个字都不动 —— 使用者编辑过的点不许被覆盖）。
5. **点与评论各自留痕**（使用者选的 (a)）：点一下**只记点，不往评论框里自动写字**；
   界面上把已选点的标题**显示在评论旁边**，两者不互相覆盖。

---

## 一、数据模型

### 1. 回合（item）—— 被评的单位

```json
{
  "id": "c:group:860771987:13579",
  "batch": "corpus-2026-10-02T06-40",
  "source": "corpus",
  "chatKey": "group:860771987",
  "chatLabel": "群 860771987",
  "at": 1759384800000,
  "context": [{ "name": "店长Keeper", "text": "鱼头用的什么手机", "isBot": false }],
  "reply": "手机？我住在一台 X99 主板的机箱里面，没有手机"
}
```

`id` 稳定（重复导入不产生重复条目）；`context` 最多 3 条、按时间正序；`reply` 是纯文本。

### 2. 评分（score）

```json
{ "id": "c:…", "verdict": "bad", "comment": "问手机就答手机，别交代机箱",
  "points": ["p-1", "p-6"], "at": 1759384900000 }
```

- `verdict`：`good`（对）/ `ok`（还行）/ `bad`（不对）。
- `comment`：**自由评论**，最多 2000 字；**可以为空**（只判档也能用），但整理时只收带评论的。
- `points`：这条评了哪几个**点**（点表里的 id，见 `GET /api/points`）。可以和 `comment` 都不为空 ——
  **两者各自留痕**：点一下不会自动往评论里写字，写评论也不会自动选点。写了点表里没有的 id → **400 并点名**。
- 一条 item 只有一个 score；**每条立刻落盘**（没有保存按钮）。
- **兼容旧数据**：旧系统那个字段叫 `note`，它就是评论（读的时候当 `comment` 用）；
  旧的 `tags` 字段读得进来但**不参与任何逻辑**（标签体系已整套删除）。

### 3. 点（point）—— 顶替原标签的评论词汇表

```json
{ "id": "p-3", "kind": "bad", "title": "省略号只在无语时用",
  "summary": "省略号不是语气装饰，别每句都挂。", "count": 4,
  "source": "seed", "createdAt": 1759…, "updatedAt": 1759… }
```

- `kind`：`bad`（不该这样）/ `good`（这样很好）—— 与三档结论无关：**点是"哪类问题"，结论是"这条好不好"**。
- `count`：有多少条评论支撑它（整理并入时累加；手工新建为 0）—— 报告页的"点排行"用它。
- `source`：`seed`（内置种子，即使用者原话的归纳）/ `consolidated`（整理或本地聚类产出）/ `manual`（人新建或改过）。
- **可编辑**：改标题/摘要/分类、删、新建都走 `POST /api/points`；标题按**归一化**判重
  （`太长` / `太长了` / `太长。` / 全角写法视为同一个点），撞了就并进已有的那一个。

---

## 二、路由

### `GET /api/health`

```json
{ "ok": true, "tool": "chat-review", "startedAt": 1759384800000, "workspace": "C:\\…",
  "corpus": { "ok": true, "rows": 29030, "botMessages": 405, "chats": 9 },
  "styleFile": { "path": "…\\styles\\闲聊.md", "exists": true, "chars": 2388, "sha256": "ab12…", "source": "file", "why": null } }
```

### `GET /api/taxonomy` —— **已废弃，只回一句说明**

```json
{ "ok": true, "removed": true, "verdicts": [ { "id": "good", "label": "对", "key": "1" }, … ],
  "why": "标签体系已删除：现在评的是「对 / 还行 / 不对 + 评论」，点从评论里整理出来" }
```

保留这条路由（而不是删掉）是为了让旧页面拿到**一句人话**而不是一个 404
（404 在浏览器里只表现为"点了没反应"）。页面只需读 `verdicts`。

### `GET /api/sources`

```json
{ "ok": true,
  "corpus": { "ok": true, "why": null, "chats": [ { "chatKey": "group:860771987", "label": "群 860771987",
              "botReplies": 412, "total": 3598, "lastAt": 1759384800000 } ] },
  "batches": [ { "id": "…", "label": "…", "source": "corpus", "chatKey": "…", "chatLabel": "…",
                 "items": 120, "scored": 34, "commented": 28, "createdAt": 1759384800000 } ] }
```

### `POST /api/pull` —— 从语料库拉一个批次

请求 `{ "chatKey": "group:860771987", "limit": 120, "contextBefore": 1, "batchLabel": "第一天" }`；
响应 `{ "ok": true, "batch": {…}, "items": 118, "scanned": 620, "skippedMarkers": 0, "warnings": [] }`。
`limit` ≤ 500，`contextBefore` 0~3；只把机器人自己的发言当 `reply`。

### `POST /api/import` —— 从粘贴/文件导入

请求 `{ "format": "forward-json" | "text", "text": "…", "batchLabel": "老王发的记录" }`；
响应 `{ "ok": true, "batch": {…}, "items": 12, "entries": 40, "warnings": ["第 3 行…"] }`。
认不出来的行**原样进 warnings**，绝不静默丢；`forward-json` 坏 JSON → 400 并说明。

### `GET /api/items?batch=<id>&filter=unrated|rated|all&limit=&offset=`

```json
{ "ok": true, "batch": { "id": "…", "label": "…", "items": 120, "scored": 34, "commented": 28 },
  "filter": "unrated", "total": 86, "offset": 0,
  "items": [ { "…item…": "…", "score": { "verdict": "bad", "comment": "…", "at": 0 } } ] }
```

### `POST /api/score` —— 判档 + 评论 + 点（**每条立刻落盘**）

请求 `{ "id": "…", "verdict": "good|ok|bad", "comment": "为什么这么评", "points": ["p-1"] }`
响应 `{ "ok": true, "score": {…}, "batchId": "…", "progress": { "scored": 35, "total": 120, "commented": 29 } }`
`verdict` 不在三档里 → 400；`comment` > 2000 字 → 400；`points` 里有未知 id → 400 并点名；`id` 不属于任何批次 → 400。

### `GET /api/points` —— 取点表（**打分页的按钮就靠它**）

```json
{ "ok": true, "kinds": ["bad", "good"], "seeded": 8,
  "points": [ { "id": "p-1", "kind": "bad", "title": "不主动抖记忆细节", "summary": "…",
                "count": 3, "source": "seed", "createdAt": 1759…, "updatedAt": 1759… } ] }
```

`seeded` = 这次启动播下了几个初始点（0 = 点表本来就有东西，**没动过**）。

### `POST /api/points` —— 新建 / 编辑一个点

请求 `{ "id": "p-3"?, "kind": "bad|good", "title": "…", "summary": "…" }`

- **不带 `id`** = 新建。标题与已有的点**归一化后相同**就**并进那一个**（不新增同义条目），
  响应里 `merged:true`；
- **带 `id`** = 编辑（改标题/摘要/分类）；`updated:true`；改完的标题若与另一个点撞了，同样并入并 `merged:true`；
- 响应 `{ "ok": true, "point": {…}, "created"|"updated"|"merged": true, "points": [ …新点表… ] }`；
  `title` 为空 / `kind` 不是 bad|good / 摘要超长 → 400。

### `DELETE /api/points?id=<id>` —— 删一个点

响应 `{ "ok": true, "removed": {…}, "usedBy": 2, "points": [ …新点表… ] }`。
`usedBy` = 有多少条评分引用过它。**引用不跟着删**：那些评分的 `points` 会悬空，
报告页把它们显示成「（已删除的点 p-3）」而不是编一个标题。没有这个点 → 404。

### `POST /api/undo`

请求 `{ "batch": "…" }` → `{ "ok": true, "undone": {…}|null, "progress": {…} }`（撤销该批次最后一次评分）。

### `GET /api/stats?batch=<id|all>`

```json
{ "ok": true, "scope": "all",
  "verdicts": { "good": 20, "ok": 9, "bad": 41 },
  "rate": { "scored": 70, "total": 200, "good": 0.29, "bad": 0.59 },
  "comments": { "withText": 66, "withoutText": 4, "byVerdict": { "good": 19, "ok": 8, "bad": 39 } },
  "pointsUsed": 51,
  "pointCounts": { "p-3": 12, "p-1": 9 },
  "points": [ { "id": "p-3", "kind": "bad", "title": "省略号只在无语时用", "count": 12, "source": "seed", "…": "…" } ],
  "chats": [ { "chatKey": "group:860771987", "label": "群 860771987", "scored": 40, "bad": 22 } ],
  "list": [ { "id": "…", "verdict": "bad", "comment": "…",
              "points": [ { "id": "p-1", "kind": "bad", "title": "不主动抖记忆细节" } ],
              "at": 1759…, "reply": "…", "context": [ { "name": "…", "text": "…", "isBot": false } ], "chatLabel": "群 860771987" } ] }
```

`list` 就是**评论清单**（新→旧）：报告页显示它、整理把它喂给模型。每条的 `points` 已还原成
`{id, kind, title}`（点被删掉后显示「（已删除的点 p-3）」）—— **没有标签排行了，现在是点排行**
（`pointCounts` + `points[].count`）。

### `GET /api/consolidate?scope=<id|all>` —— 取最近一次整理（**不调模型**）

```json
{ "ok": true, "scope": "all",
  "latest": { "id": "c-2026-10-02T…", "createdAt": 1759…, "scope": "all",
              "points": [ { "kind": "bad", "title": "省略号滥用", "summary": "…", "evidence": ["3","7"], "where": "说话方式" } ],
              "rewritten": "完整的新版 styles/闲聊.md 正文",
              "dropped": [], "anchors": { "ok": true, "missing": [], "checked": 10 },
              "model": "deepseek-flash", "ms": 8421, "usage": null,
              "promptStats": { "kept": 42, "truncatedComments": 0, "chars": 5120 },
              "styleBeforeSha": "…", "styleBeforeChars": 2388, "chars": 2100,
              "diff": "--- styles/闲聊.md\n+++ …", "appliedAt": null, "applyResult": null } ,
  "history": [ { "id": "…", "createdAt": 1759…, "chars": 2100, "points": 5, "appliedAt": null } ],
  "comments": [ { "id": "…", "verdict": "bad", "comment": "…", "reply": "…", "context": [], "chatLabel": "…" } ],
  "counts": { "comments": 42, "withText": 42 },
  "model": { "ok": true, "model": "deepseek-flash", "baseUrl": "https://api.deepseek.com" },
  "limits": { "comments": 150, "chars": 14000, "styleChars": 9000 },
  "anchors": [ { "id": "not_submit", "label": "接梗不是屈服" } ] }
```

`latest` 可以是 `null`（还没整理过）。`model.ok === false` 时页面要**明说整理不可用**
（并给出 `model.why`），不要给一个点了没反应的按钮。

### `POST /api/consolidate` —— **真的调一次模型整理**

请求 `{ "scope": "all" }`（或 `{"batch": "…"}`）

成功：

```json
{ "ok": true, "ms": 8421,
  "consolidation": { "…同上面的 latest…" },
  "points": [ { "id": "p-3", "…": "…" } ],
  "pointsMerge": { "created": 2, "merged": 3, "total": 10 },
  "clusters": { "bad": [ { "text": "…", "count": 3, "ids": [] } ], "good": [] } }
```

★ `points` = **并入之后的新点表**：整理产出的点会并进点表（同类按标题归并、`count` 累加），
所以整理完**打分页的按钮就多了几条**（不必重启、不必重新整理）。
`pointsMerge` 如实说明这次"新建了几个、并进了几个"。

失败（**仍然 200**，因为这不是"请求错了"，而是"整理没成"）：

```json
{ "ok": false, "error": "模型调用失败：…", "clusters": { "bad": [], "good": [] },
  "comments": [ {…} ], "ms": 1200 }
```

失败时**必须把评论原文一起回**（`comments`）—— 整理没成，素材不能跟着"看不见"。
`clusters` 是**本地确定性聚类**（相似评论分组 + 计数），成功时也一并回，页面可折叠展示。

### `POST /api/apply` —— 应用改写（**唯一会碰风格文件与出厂常量的写操作**）

请求 `{ "consolidation": "c-…"（可省，省略=用最近一次）, "scope": "all", "confirm": true, "confirmAnchors": false }`

- `confirm !== true` → 400（**没有默认应用这件事**）。
- 没有可用的整理结果 → 400；改写内容与文件当前内容相同 → 409（不重复写）。
- **锚点没守住**（`latest.anchors.ok === false`）且 `confirmAnchors !== true` → **409**，
  并带 `anchorsMissing: [{id,label,any}]`；页面要把"丢了哪几条底线要点"逐条显示，
  并给一个明确的"我知道，仍然应用"按钮（**只有人点它才带 `confirmAnchors:true`**）。
- 成功：先备份到 `styles/.backups/闲聊.md.<时间戳>.bak`，再原子写风格文件，
  然后**同步 `src/chat-mode.mjs` 里的出厂默认常量**（否则那两份会漂）：

```json
{ "ok": true, "consolidationId": "c-…", "backup": "…bak", "sha256": "…",
  "beforeChars": 2388, "chars": 2100, "anchorsOverridden": false,
  "constantSync": { "ok": true, "changed": true } }
```

`constantSync.ok === false` 时页面要**明说**（风格文件已经改了，但出厂常量没同步成功，
`verify-chat-mode` 会红）并给出 `constantSync.why`。

### `POST /api/shutdown`

请这个实例自己退出（启动时"接管端口"用）。空 body。`{ "ok": true, "stopping": true }`；
没接 `onShutdown` 的实例回 501。只监听 127.0.0.1、只关自己。

### `DELETE /api/batch?id=<id>`

删除批次与它的全部评分（只删工作区里的评审数据，不动语料库、不动风格文件）。

---

## 三、页面要有哪些东西（`public/`，无构建、零依赖、不许引 CDN）

### 页签一：导入

- **语料库**：会话下拉（显示"机器人发言 N 条 / 共 M 条"）+ 条数 + 上下文条数 + 批次名 → 「从语料库拉取」。
- **粘贴导入**：`合并转发 JSON` / `纯文本` 二选一 + 粘贴框 + 批次名 → 「解析并建批次」；
  `warnings` **逐条原样列出**（它们是"少了几条"的唯一解释）。
- **已有批次**表：批次 / 来源 / 条数 / 已评 / **有评论** / 建立时间 + 「开始打分」「删除」。

### 页签二：打分（主战场，要能连续评几百条）

- 顶部：进度条 + `已评 X / 共 Y`（有评论 Z）+ 批次/过滤选择 + 「撤销上一条」。
- 卡片：上下文（淡色、可折叠）→ **机器人那句话**（大字）→ 三个判档按钮
  `1 对` / `2 还行` / `3 不对` → **评论框（主角，给足高度）**。
- 键盘：`1/2/3` 判档并下一条；`Enter` 保存并下一条（`Shift+Enter` 换行）；`U` 撤销；
  `S` 跳过（不写分）。判档后**立刻**换下一张（乐观推进，失败把这张插回来并报错）。
- 评论**失焦即存**；没有保存按钮。
- 已评过的条目再遇到时，要把**原来那条评论**填回框里（重评 = 改字，不是重打），
  **已选的点**也要恢复成选中态。
- **点按钮（原标签按钮的位置，就这一处）**：bad / good 两组，点一下切换选中；
  选中态要明显（边框/底色），按钮上显示 `标题`，`title=` 提示里给 `摘要` 与它的 `count`。
  ★ **(a) 语义**：点一下**只记点，不往评论框里自动写字**；评论框旁边把已选点的标题
  显示出来（例如「已选的点：省略号只在无语时用 ×」），**两者各自留痕、不互相覆盖**。
  点表为空时这块要显示一句"还没有点"而不是空白（说明可以在下面新建）。
- **点管理**（放在同一页侧栏或报告页都行，但要顺手）：改标题/摘要、改分类、删除、新建。
  - 新建一个与已有的点"同义"的标题（归一化后相同）时，服务端会**并进那一个**，
    页面要如实提示"已并入已有的点 X"，别假装新建成功；
  - 删除要点两次（或确认框），并显示 `usedBy`（有几条评分引用过它）；
    引用不跟着删 —— 报告页会把它显示成「（已删除的点 p-3）」。
  - `title`/`summary` 的编辑要即时落盘（`POST /api/points`），不要攒着。

### 页签三：报告

- 统计：三档分布 + 百分比；**点排行**（`points[].count` 降序，点一下可筛选评论清单）
  + **评论清单**（新→旧，可按判档筛选、可按文字搜索 + 按点筛选，
  每条显示判档、已选的点、评论、被评的那句话与上下文）。
- 「整理评论」按钮：
  - `model.ok === false` → 按钮禁用并显示原因（不要点了没反应）；
  - 点了 → `POST /api/consolidate` → 成功显示**点**（kind / 标题 / 摘要 / 证据条数 /
    可展开看证据原文）+ **整文件 diff**（`+` 绿 `-` 红）+ 锚点核对结果；
    失败 → 显示 `error` + **本地聚类**（相似评论分组）+ 评论原文。
- 「应用到 styles/闲聊.md」：二次确认弹窗写清"会先备份、会同步出厂常量"；
  锚点没守住时先显示丢失清单，且**只有再点一次明确的"仍然应用"**才带 `confirmAnchors:true`。
  应用后显示：备份路径、新 sha256、`2388 → 2100 字（精简 288）`、常量是否同步成功。
- 页面上常驻显示**当前风格文件**的字数与 sha256 前 8 位（`/api/health`），
  应用后要重新拉一次 —— 否则人会以为没写进去。
