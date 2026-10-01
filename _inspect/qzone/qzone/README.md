# QQ 空间动态（qzone）

让 AI 打理自己的 QQ 空间：发说说（可带聊天里的图）、刷好友动态、给有意思的说说点赞和评论。
所有读写都走 **bot 账号自己**的 Qzone 网页登录态（SnowLuma 登录着 QQ，OneBot
的 `get_cookies` 能取到 Qzone cookie），不需要也不应该收集任何人的账号密码。

## 工具

| 工具 | 作用 | 写操作 |
|---|---|---|
| `qzone__post_mood` | 发一条说说，可选带图（`images` 传消息号） | 是 |
| `qzone__list_feeds` | 刷好友动态（只读），返回作者/时间/摘要/点赞数 | 否 |
| `qzone__like_feed` | 点赞指定说说（uin + tid 从 list_feeds 抄） | 是 |
| `qzone__comment_feed` | 评论指定说说 | 是 |

## 带图说说

模型只能**引用**它已经在聊天里看到过的图，不能指定任意图：

```
images: ["#12345"]        // 那条消息的第一张图
images: ["#12345", "#12345:2"]   // 同一条消息的第 1、2 张
```

`#12345` 就是聊天记录里的消息 id（和 `get_message_images`、`send_voice` 用的是同一个号）。
路径、网址、`data:`/`base64://`、表情 id 一律拒——这与 `send_voice` 是同一条纪律：
**模型拿不到"任意图"这个能力**，只能在已经流过这个会话的内容里挑。

拿到消息号之后的流程（`resolveChatImage` → `downloadChatImage` → `uploadQzoneImage`）：

1. `ctx.store.findByMid(chatKey, mid)` 从存档里翻出那条消息的 `media[]`，取第 N 张的
   `url` / `file`。消息不存在、没有图、第 N 张越界，都在这里给出人话错误，**不出网**。
2. 按存档里的直链下载；直链过期（QQ 图片链接会失效）就问 OneBot 重签一次
   （`onebot.freshImageUrlOfMessage(mid, file)`）。
3. 验字节：超过 `maxImageMB` 拒；魔数不是 jpg/png/gif/webp/bmp 拒（挡掉"把任意文件当图传"）。
4. `POST https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=` 上传，
   拿回 `albumid/lloc/width/height/type`，拼成
   `richval = ,albumid,lloc,lloc,type,height,width,,height,width`。
5. **所有图都传成功之后**才发说说（传一半就发，空间里会留下一条缺图的说说，收不回来）：
   发布表单加 `richtype='1'`、多图 `richval` 用 `\t` 连接。

> 隐私：发到空间的图，bot 的所有好友都看得见。别人私发的、或明说过不想公开的图不该发——
> 这条写进了提示词；要一刀切就把 `allowChatImages` 关掉。

## 登录态怎么拿

1. 先走 `ctx.onebot.call('get_cookies', {domain:'qzone.qq.com'})`（应用自己配了
   OneBot token 时一条就通）；
2. 被 SnowLuma 1401 拒（它对敏感接口强制校验 accessToken）→ 读
   `<app>/resources/app/snowluma/config/onebot_*.json` 的 `networks.httpServers[].accessToken`，
   自己拼 `POST {httpUrl}/get_cookies`。
3. cookie + g_tk 内存缓存 5 分钟。**token 只进内存**：不写日志、不进返回值。

## 自律（硬编码 + 配置双保险）

- 发说说按**天**限流（默认 3 条/天），点赞（6/小时）和评论（3/小时）按滑动一小时窗口。
- 带图另有三道闸：`allowChatImages`（总开关，默认开）、`maxImagesPerPost`（默认 3，硬上限 9）、
  `maxImageMB`（默认 8，最大 32）。
- 同一条说说（uin+tid）只互动一次，记忆落在 `data/qzone/state.json`（`acted`，
  超 300 条清最老的）。
- 刷动态有最小间隔（默认 30 分钟）：间隔内的调用直接喂上一次缓存，不重复出网。
- uin 必须 5~11 位纯数字；tid 必须 24 位小写十六进制；图片引用必须是消息号——
  脏参数一律在**出网前**就被拒。
- `allowInGroup=false` 可把整个技能限定在私聊。
- 状态写入是原子的（tmp + rename），崩在半路不会留下半个 JSON。

## 接口依据

端点常量取自持续维护的 [guohuiyuan/qzone-go](https://github.com/guohuiyuan/qzone-go)
并经本机只读实测（拉动态 code=0、10 条 item）；带图那套字段口径照 SnowLuma 桥里
已在用的实现（`cgi_upload_image` + `richtype/richval`）：

- 发说说 `POST /proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=`
- 传图 `POST https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=`
- 动态 `GET /proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?...`
- 点赞 `POST /proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app?g_tk=`
- 评论 `POST /proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=`

注意：动态接口返回的是 **JS 对象字面量**（单引号、未引号 key、`\xNN`、裸
`undefined`），不是 JSON——`index.js` 里的 `jsLiteralToJson` 是逐字符状态机，
别换成正则或 `eval`。

上传/发布这两个接口的响应**不一定带 `code` 字段**（成功时可能整个没有），所以用的是
`parseQzoneLooseJson`：`code`/`subcode` 只在是数字且非 0 时才算错，成功与否看
**有没有回 `tid`**（空间拒稿也返回 200）。别把它们换回严格的 `parseQzoneJson`。

## 测试

`tests/test-qzone.mjs`：离线回归（假 data 目录，全程不出网），钉住清单↔实现、
三态装载、群聊闸门、参数安全、限频/去重/缓存、解析器，以及带图那套：图片引用的
收/拒矩阵、魔数、`resolveChatImage` 的各种人话错误、上传与发布表单的形状（`fetch` 打桩）。
其中 [8] 把 `fetch` 换成"一调就报错"，用来**证明**脏参数拦在出网之前。
真账号的写路径（发/赞/评）首次启用时**先问用户**再实测。
