# 聊天记录评审台 —— 前后端契约

> 这份文件是**契约**：`chat-review/public/app.js`（页面）与 `src/chat-review-server.mjs`（服务）
> 都按它来。改任何一边都必须同步改这里。
>
> ⚠️ 有一条断言盯着它：`mocks/verify-chat-review.mjs` 会把 `app.js` 里出现的每个
> `/api/...` 字符串抽出来，逐个核对服务端**真的有这条路由**，并核对 **API.md 里每条路由、
> 服务端每条路由**三份互相对账 —— 因为"页面调了一个不存在的接口"只会在浏览器里表现为
> "点了没反应"，而服务端日志干干净净。

约定与仓库其它接口一致：只监听 `127.0.0.1`；响应一律 JSON、`cache-control: no-store`；
成功 `{ok:true, ...}`，失败 `{ok:false, error:'中文的、给人看的理由'}`（400 输入不对 /
404 没有这东西 / 405 方法不对 / 409 状态冲突 / 500 真炸了）；路径穿越 403。

---

## 〇、这个工具现在的形状（2026-10-02 第三版，**先读这段**）

```
导入真实聊天记录 → 一条条「判档 + 写评论 + 点标签」 → 把评论整理成**对 src/voice.mjs 里那份说话方式的修改意见**
```

**使用者三次改版的原话（每一版都是上一版在页面上被他看出问题）**：

1. 「标签系统并不合理，我的习惯是对说得对与不对的地方进行评论」→ 删掉我手写的标签税则，
   评论成为一等公民。
2. 「标签系统改为人工写标签，为好坏标签都添加『新增标签』按钮」→ 上一版让模型自动归纳"点"
   并在启动时**播种**，结果按钮名是一整句评论（「不合适打招呼逻辑，一句改成这个话有点冗杂…」），
   糊成一片没法点。**现在标签一律人工写**（新建/改名/改说明/删），标题限 **12 字**。
3. 「最终基于评价过的消息记录和评论，生成闲聊.md 的修改意见」+「只要意见，修改内容由 LLM
   另外执行」→ 产物从"整篇重写 + 应用到文件"改成**逐条修改意见**。
   ★ 这条是有实测依据的：上一版整篇重写跑出来 **2389 → 2388 字**（等于把原文件还回来），
   而"该改哪一条、改成什么"才是人能直接用的东西。

**因此：评审台不写 `src/voice.mjs`（也不写它里面的 `VOICE_STYLE`）。** 它写的东西只有三样：
评分、标签表、整理记录 —— 全在工作区 `runtime/chat-review/` 下。

> ★ 0.3.0alpha：被评的那份文案从 `styles/闲聊.md`（那份文件连目录一起下线了）
> 换成了 `src/voice.mjs` 的 `VOICE_STYLE` —— 双态拆掉之后说话方式**只有这一份**。
> 路由、数据形状、页面交互**都没变**，只有 `/api/health` 里 `styleFile.path` 指向的目标变了。

**术语**：界面上叫**标签**（label）；代码与接口里仍叫 `points`（历史名，不打算改了）。
两者是同一个东西：**打分卡片上那排按钮**。

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

`id` 稳定（重复导入不产生重复条目）；`context` 最多 3 条、按时间正序；`reply` 是纯文本；
整条只有标记（`[图片]` 这类）的机器人发言、以及空正文，都不进回合。

### 2. 评分（score）

```json
{ "id": "c:…", "verdict": "bad", "comment": "问手机就答手机，别交代机箱",
  "points": ["p-3"], "at": 1759384900000 }
```

- `verdict`：`good`（对）/ `ok`（还行）/ `bad`（不对）。
- `comment`：**自由评论**，最多 2000 字；可以留空（只判档也能用）。
- ★★ **「有评论」= `comment` 有文字 _或_ `points` 非空**（使用者 2026-10-02 原话：
  「评论清单显示未评论，不参与整理，但是实际上**选择标签已经相当于评论了**」）。
  只点了标签、没写字的评分**不是"未评论"**，它们**照样参与整理**；
  只有"判了档、既没写字也没点标签"才是真没评论。
  `/api/stats` 的 `comments.withContent`（含标签）与 `withText`（只算文字）是两个口径，都给出。
- `points`：这条上记了哪些**标签**（id 数组）。**点标签只记标签、不往评论框写字**（使用者拍板的 (a)）。
- 一条 item 只有一个 score；**每条立刻落盘**（没有保存按钮）。
- **整条替换语义**：重评时没带 `points` ⇒ 这条的标签会被清空（页面每次都会回填，所以正常用不会丢）。
- 兼容旧数据：`comment` 缺失时读旧的 `note`（旧系统的「备注」就是评论）；旧 `tags` 字段忽略。

### 3. 标签（label / 内部名 points）

```json
{ "id": "p-3", "kind": "bad", "title": "太长", "summary": "一句话能说完就别写一段",
  "count": 4, "source": "manual", "createdAt": 1759…, "updatedAt": 1759… }
```

- **只能人工写**（`POST /api/points`）：`title` **1~12 字**（它是按钮上的字；40 字那种在按钮上
  就是灾难，实测过），`summary` ≤300 字（当按钮的 `title` 悬停提示），`kind` ∈ `bad|good`。
- **判重按归一化标题**：全角/半角、空白、末尾标点会被拉平（`太长。` == `太长` ⇒ 并进已有那条）；
  **词形不同不算**（`太长` 与 `太长了` 是两条 —— 中文没有可靠的后缀词干化，硬做会把不相干的词并到一起）。
- `count` = 有多少条评论支撑它（旧版模型归纳留下的数，现在只作参考，不再增长）。
- 删标签**不删引用**：评分里的 id 会悬空，报告页显示「（已删除的标签）」；`DELETE` 会如实回 `usedBy`。
- 标签表里**不会**由模型自动新增任何东西（`seed` / 自动并入那条路已整个删除）。

### 4. 整理记录（consolidation）= 修改意见

```json
{ "version": 1, "id": "c-2026-10-02T…", "scope": "all", "createdAt": 1759…,
  "suggestions": [
    { "action": "rewrite", "target": "说话方式 · 「别主动抖记忆里的细节」",
      "advice": "补一句：问什么答什么，别交代配置参数", "reason": "对方只问手机，它讲了机箱",
      "evidence": ["2", "5"] }
  ],
  "notes": "总体说明（可选）",
  "anchorCoverage": { "covered": [{ "id": "no_leak", "label": "不泄露记忆" }], "uncovered": [], "checked": 10 },
  "model": "deepseek-flash", "ms": 8421, "usage": null,
  "promptStats": { "kept": 42, "truncatedComments": 0, "chars": 5120 },
  "styleBeforeSha": "…", "styleBeforeChars": 2388 }
```

- `action` ∈ `rewrite`（改现有某条）/ `merge`（并进另一条）/ `delete`（删掉）/ `add`（新增一条）；
  模型给了野值就按 `rewrite` 处理，没有 `advice` 的意见直接丢掉并计数（`droppedEmpty`）。
- `evidence` 是**提示词里的评论编号**（1 起，见 `commentLine`），页面用 GET 回的 `comments` 还原原文；
  还原不了就如实显示「第 N 条评论（这次没取到它的原文）」—— 不编原文。
- **没有** `rewritten` / `diff` / `appliedAt`：这一版没有"应用"这件事。
- `anchorCoverage` 是**提示**（不是门禁）：哪些底线要点这份意见提到了、哪些一条都没提。

---

## 二、路由

### `GET /api/health`

```json
{ "ok": true, "tool": "chat-review", "startedAt": 1759384800000, "workspace": "C:\\…",
  "corpus": { "ok": true, "rows": 29030, "botMessages": 405, "chats": 9 },
  "styleFile": { "path": "…\\src\\voice.mjs", "exists": true, "chars": 3153,
                 "sha256": "d259e531…", "source": "file", "why": null } }
```

`corpus.ok === false` 时回 `{ok:false, why}`，页面照 `why` 显示（不报 0 条冒充"空库"）。
`styleFile` 是**只读事实**（评审台不写它）；页面顶栏显示字数与 sha 前 8 位。

- ★ 0.3.0alpha：`styleFile.path` 指向 **`src/voice.mjs`**（说话方式常量的所在地），
  不再是 `styles/闲聊.md`。路径由 `voiceSourcePath()` 算 —— **不许手拼**，
  也**没有**"启动参数里挑一份"这件事了（旧的 `--style` 已删）。
- `styleFile.chars` / `sha256` 是**当时那一刻**的值（上例取自 0.3.0alpha 实测）：
  它们随 `src/voice.mjs` 里 `VOICE_STYLE` 的每次改动作废 —— 别把它们当常量。
- 读不到时**不回落**任何内置文本：`source` 会是 `missing` / `unreadable` 且带 `why`
  （0.3.0beta 那份是"文件可删 ⇒ 回落出厂默认"，现在是**源码本身**，读不出来只可能是包坏了或路径错了，
  回落只会掩盖它）。
- ★ **页面文案已经跟上了**（0.3.0alpha 收尾时补的）：`public/app.js` 与 `public/index.html` 里
  给使用者看的文字说的是「对说话方式的修改意见」，顶栏那一格也从「风格文件 N 字」改成
  「说话方式 N 字」；`chat-review/server.mjs` 启动那行标签同理。
  ⚠️ 但要记住：**页面文案不是断言对象**（套件的三份对账只核对路由与函数接线），
  所以这类文案一旦又漂了，**不会有门禁替你发现** —— 改 `src/voice.mjs` 的定位时要顺手 grep 一遍
  `chat-review/public/`（判据：不该再出现 `styles/闲聊.md` 或「风格文件」这个说法）。

### `GET /api/taxonomy` —— **已废弃，只回一句说明**

```json
{ "ok": true, "removed": true, "verdicts": [ { "id": "good", "label": "对", "key": "1" }, … ],
  "why": "标签体系已删除：现在评的是「对 / 还行 / 不对 + 评论」，标签由人自己写" }
```

保留这条路由（而不是删掉）是为了让旧页面拿到**一句人话**而不是 404。页面只读 `verdicts`。

### `GET /api/sources`

```json
{ "ok": true,
  "corpus": { "ok": true, "why": null, "chats": [ { "chatKey": "group:860771987", "label": "群 860771987",
              "botReplies": 412, "total": 3598, "lastAt": 1759384800000 } ] },
  "batches": [ { "id": "…", "label": "…", "source": "corpus", "chatKey": "…", "chatLabel": "…",
                 "items": 120, "scored": 34, "commented": 28, "createdAt": 1759384800000 } ] }
```

`commented` = 这一批里**写了评论**的条数（整理只吃这些）。两处（这里与 `/api/items`）都必须给。

### `POST /api/pull` —— 从语料库拉一个批次

请求 `{ "chatKey": "group:860771987", "limit": 120, "contextBefore": 1, "batchLabel": "第一天" }`；
响应 `{ "ok": true, "batch": {…}, "items": 118, "scanned": 620, "skippedMarkers": 0, "warnings": [] }`。
`limit` ≤ 500，`contextBefore` 0~3；只把机器人自己的发言当 `reply`；拉不到可评的回合 → 400 并说明。

### `POST /api/import` —— 从粘贴/文件导入

请求 `{ "format": "forward-json" | "text", "text": "…", "batchLabel": "老王发的记录" }`；
响应 `{ "ok": true, "batch": {…}, "items": 12, "entries": 40, "warnings": ["第 3 行…"] }`。
认不出来的行**原样进 warnings**，绝不静默丢；坏 JSON → 400 并说明；一条机器人发言都没认出来 → 400 +
告诉它认哪些昵称。

### `GET /api/items?batch=<id>&filter=unrated|rated|all&limit=&offset=`

```json
{ "ok": true, "batch": { "id": "…", "label": "…", "items": 120, "scored": 34, "commented": 28 },
  "filter": "unrated", "total": 86, "offset": 0,
  "items": [ { "…item…": "…", "score": { "verdict": "bad", "comment": "…", "points": ["p-3"], "at": 0 } } ] }
```

批次不存在 → 404；不认识的 `filter` 按 `unrated` 处理（不是 500）。

### `POST /api/score` —— 判档 + 评论 + 标签（**每条立刻落盘**）

请求 `{ "id": "…", "verdict": "good|ok|bad", "comment": "为什么这么评", "points": ["p-3"] }`
响应 `{ "ok": true, "score": {…}, "batchId": "…", "progress": { "scored": 35, "total": 120, "commented": 29 } }`

- `verdict` 不在三档 → 400；`comment` > 2000 字 → 400；`points` 里有不存在的标签 id → 400 并点名；
  `id` 不属于任何批次 → 400。
- ⚠️ 整条替换：不带 `points` 会清空这条的标签（页面每次都回填）。

### `POST /api/undo`

请求 `{ "batch": "…" }` → `{ "ok": true, "undone": {…}|null, "progress": {…} }`（撤销该批次最后一次评分）。

### `GET /api/stats?batch=<id|all>`

```json
{ "ok": true, "scope": "all",
  "verdicts": { "good": 20, "ok": 9, "bad": 41 },
  "rate": { "scored": 70, "total": 200, "good": 0.29, "bad": 0.59 },
  "comments": { "withText": 60, "withoutText": 10, "withContent": 66, "tagsOnly": 6,
                "byVerdict": { "good": 19, "ok": 8, "bad": 39 } },
  "chats": [ { "chatKey": "group:860771987", "label": "群 860771987", "scored": 40, "bad": 22 } ],
  "points": [ { "id": "p-3", "kind": "bad", "title": "太长", "summary": "…", "count": 4 } ],
  "pointCounts": { "p-3": 7 },
  "pointsUsed": 12,
  "list": [ { "id": "…", "verdict": "bad", "comment": "…", "at": 1759…,
              "reply": "…", "context": [ { "name": "…", "text": "…", "isBot": false } ],
              "chatLabel": "群 860771987",
              "points": [ { "id": "p-3", "title": "太长" } ] } ] }
```

- `list` = **评论清单**（新→旧）：报告页显示它、整理把它喂给模型。
- `points` = 标签表 + `count`（有多少条评论支撑它）；`pointCounts` = **这个范围里**每个标签被记了几次
  （两个数不同，页面分开显示，别混）；`pointsUsed` = 这个范围内记过标签的评分数。
- 标签被删掉后，`list[].points` 里那条会显示成「（已删除的标签 p-x）」。

### `GET /api/consolidate?scope=<id|all>` —— 取最近一次整理（**不调模型**）

```json
{ "ok": true, "scope": "all",
  "latest": { "…整理记录…": "…" },
  "history": [ { "id": "…", "createdAt": 1759…, "suggestions": 5, "uncovered": 3 } ],
  "comments": [ { "id": "…", "verdict": "bad", "comment": "…", "reply": "…", "context": [], "chatLabel": "…" } ],
  "counts": { "comments": 42, "withText": 36, "withContent": 42 },
  "model": { "ok": true, "model": "deepseek-flash", "baseUrl": "https://api.deepseek.com" },
  "limits": { "comments": 150, "chars": 14000, "styleChars": 9000 },
  "anchors": [ { "id": "not_submit", "label": "接梗不是屈服" } ] }
```

`latest` 可以是 `null`。`model.ok === false` 时页面要**禁用**整理按钮并显示 `model.why`
（绝不给点了没反应的按钮）。

### `POST /api/consolidate` —— **真的调一次模型整理**

请求 `{ "scope": "all" }`（或 `{"batch": "…"}`）

成功：`{ "ok": true, "ms": 8421, "consolidation": {…}, "clusters": { "bad": [...], "good": [...] } }`

失败（**仍然 200**，因为这不是"请求错了"，而是"整理没成"）：

```json
{ "ok": false, "error": "模型调用失败：…", "clusters": { "bad": [], "good": [] }, "comments": [ {…} ], "ms": 1200 }
```

失败时**必须把评论原文一起回**（`comments`）—— 整理没成，素材不能跟着"看不见"。
`clusters` 是**本地确定性聚类**（相似评论分组 + 计数，零调用），成功时也一并回。
`POST` **不会**改动标签表（使用者要求标签人工写）。

★ **解析层会修模型的 JSON 手滑**（2026-10-02 使用者第一次真跑就炸，见下）：模型要**引用
`src/voice.mjs` 里 `VOICE_STYLE` 的原文**来指认改哪一条，而那份文案本身就含 ASCII 双引号
（`…任何关于"说多长""要不要分条"…`）—— 它抄进 JSON 字符串时忘了转义，整份输出当场作废
（`Expected ',' or '}' … at position 99`）。所以解析器在 `JSON.parse` 失败后会**修一次再试**：
把字符串内部**未转义的 `"`** 转义（判据：一个 `"` 若合法收尾，其后跳过空白应是
`,` `}` `]` `:` 或输入结束；否则它属于正文）、把**裸换行**转成 `\n`、丢掉**尾随逗号**。
修复成功时 `via` 会标成 `fence+repaired` / `raw+repaired`（**不许**把修复当成本来就好）；
修不好则照旧 `ok:false`，并在 `error` 里带上**位置与原文片段**。
提示词同时明令：引用原句一律改用中文引号「」，值里不许有裸换行。

### `GET /api/points` —— 标签表（打分页那排按钮）

```json
{ "ok": true, "kinds": ["bad", "good"], "titleMax": 12,
  "points": [ { "id": "p-3", "kind": "bad", "title": "太长", "summary": "…", "count": 4,
                "source": "manual", "createdAt": 1759…, "updatedAt": 1759… } ] }
```

### `POST /api/points` —— 新建 / 编辑 / 一次性清理

新建或编辑：`{ "id": "p-3"（省略=新建）, "kind": "bad|good", "title": "太长", "summary": "…" }`
→ `{ "ok": true, "point": {…}, "created": true, "merged": false, "updated": false, "points": [ …整张表… ] }`

- `title` 为空/超过 `titleMax`（12）字、`kind` 不是 bad/good → **400 + 中文理由**（页面原样显示）。
- 标题归一化后与已有标签相同 ⇒ `merged: true`（并进那一条，不新增）。

一次性清理（升级到 12 字上限之前的数据）：`{ "action": "prune-auto" }`
→ `{ "ok": true, "removed": 3, "ids": ["p-1","p-2","p-4"], "points": [ … ] }`

- **只删** `source !== 'manual'` **且**标题超过 12 字的那些（上一版自动播种塞进来的长句子）；
  手写的、标题短的**一律不动**（有断言）。

### `DELETE /api/points?id=<id>`

→ `{ "ok": true, "removed": {…}, "usedBy": 2, "points": [ … ] }`；没有这个标签 → 404。
`usedBy` = 有多少条评分引用过它（引用不跟着删）。

### `POST /api/shutdown`

请这个实例自己退出（启动时"接管端口"用）。空 body。`{ "ok": true, "stopping": true }`；
没接 `onShutdown` 的实例回 501。只监听 127.0.0.1、只关自己。

### `DELETE /api/batch?id=<id>`

删除批次与它的全部评分（只删工作区里的评审数据；不动语料库、不动 `src/voice.mjs`）。

> ⚠️ **没有 `/api/apply`**（2026-10-02 删除）：评审台不再写被评的那份文案
> （0.3.0alpha 起是 `src/voice.mjs` 的 `VOICE_STYLE`；0.3.0beta 时是 `styles/闲聊.md`）。
> 有断言盯着这条（页面不调用它、路由表里没有它、store 上也没有 `applyDraft`）。

---

## 三、页面要有哪些东西（`public/`，无构建、零依赖、不许引 CDN）

### 页签一：导入

- **语料库**：会话下拉（显示"机器人发言 N 条 / 共 M 条"）+ 条数 + 上下文条数 + 批次名 → 「从语料库拉取」。
- **粘贴导入**：`合并转发 JSON` / `纯文本` 二选一 + 粘贴框 + 批次名 → 「解析并建批次」；
  `warnings` **逐条原样列出**（它们是"少了几条"的唯一解释）。
- **已有批次**表：批次 / 来源 / 条数 / 已评 / **有评论** / 建立时间 + 「开始打分」「删除」。

### 页签二：打分（主战场）

- 顶部：**文档流里的一行**（进度条 + `已评 X / 共 Y（有评论 Z）` + 批次/过滤 + 撤销）。
  ⚠️ **不许 `position: fixed/sticky`**：这一条曾经悬浮在内容之上、把消息文字压在底下
  （使用者截图反馈过），现在只是普通一行；有断言盯着 `.score-bar` 里不出现这几个值。
- 卡片：上下文（可折叠）→ **机器人那句话**（大字）→ 三个判档按钮 `1 对 / 2 还行 / 3 不对`
  → **标签排**（bad / good 两组，各自带一个 **「+ 新增标签」** 按钮，就地展开一个小表单：
  标签名（≤12 字）+ 说明 + 建/取消）→ 已选标签 chips → **评论框**（主角，给足高度）。
- 键盘：`1/2/3` 判档并下一条；`Enter` 保存并下一条（`Shift+Enter` 换行，评论框内 `Esc` 交还快捷键）；
  `U` 撤销；`S` 跳过。
- 评论与标签**各自留痕**：点标签**不往评论框写字**（(a) 语义）；已评过的条目再遇到时，
  原评论与原标签都回填。
- **没有标签时要说清楚**：显示"标签表还是空的 —— 点上面的「+ 新增标签」"，并给「↻ 刷新标签」。

### 页签三：报告

- 统计：三档分布 + 百分比；**标签排行**（点一下只看记过这个标签的评论）；
  **评论清单**（新→旧，可按判档筛选、按文字搜索，每条显示判档、评论、标签、被评的那句话与上下文）。
- 标签表管理（改名字/改说明/改分类/删/新建 + 「清理自动生成的长标签」）。
- 「整理评论」：
  - `model.ok === false` → 禁用并显示原因；`counts.withContent === 0` → 禁用并说明没素材
  （**用 `withContent`**：只点了标签也算评论，用 `withText` 会把"只点标签"的批次误判成没素材）；
  - 点了 → `POST /api/consolidate` → 成功显示**逐条修改意见**（动作标签 / 指向哪一条 / 改成什么 /
    为什么 / 依据的评论编号可展开看原文）+ 底线要点覆盖提示 + 本地聚类（可折叠对照）；
    失败 → 显示 `error` + 本地聚类 + 评论原文。
- 「**复制修改意见**」：把意见拼成纯文本复制走（带"改成什么/为什么/依据"）；剪贴板不可用时
  **不许静默**——把全文摊在一个只读框里并自动全选。
- **没有"应用"按钮**：页面明说"评审台不会改那份说话方式（`src/voice.mjs`），改动由 LLM 另外执行"。
  （页面文案与这句一致 —— 0.3.0alpha 收尾时已把旧的 `styles/闲聊.md` 说法改掉，见 §二
  `GET /api/health` 那一条里的提醒：**文案漂了没有门禁会红**。）
