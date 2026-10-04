/**
 * P3 方言夹具 —— **按真实字节写**，不是按"我以为的形状"写。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 为什么这个文件里的每一行都是 **Buffer**
 * ══════════════════════════════════════════════════════════════════════════
 * 真机取证（2026-10-04，Forge 1.20.1-47.3.0 + Windows 中文版 + JDK 17）：
 *
 *   `say 夹具-测试消息` 在控制台里落成的字节是
 *       ... 5b52636f6e5d20 bcd0bedf2d b2e2cad4cffbcfa2 0d0a
 *                        └─────── 这一段按 GBK 才是「夹具-测试消息」
 *
 *   按 UTF-8 解码 = 替换字符（坏）；按 **GBK** 解码 = 完全正确。
 *   ⇒ **服务端控制台输出是 GBK 编码的**（Windows 中文版 JVM 默认
 *     `file.encoding=GBK`），而 P2 把 stdout 原样重定向进
 *     `runtime/servers/<id>.console.log` ⇒ **那个文件不是 UTF-8**。
 *
 * ∴ 夹具必须是**真实字节**。第一版这里用 `Buffer.from(line, 'latin1')` 把整个字符串
 *   转 Buffer —— 那一步会把中文**截成低 8 位**（`测` → 0x4B），于是测试拿到的是坏字节，
 *   而"坏字节"恰好又让编码回退**看不出来**（等于把夹具的 bug 掩盖成通过）。
 *   现在改成：**中文字段一律走 `gbkBytes()` 再拼 Buffer**，字符串层面永不碰中文。
 *
 * ── 方言覆盖（每条都标了来源）──────────────────────────────────────────────
 *   · `forge`      —— 真机逐字（日志前缀、玩家进出）
 *   · `forge-notsecure` —— 1.19+ 的 `[Not Secure]` 前缀
 *   · `forge-cjk-gbk`   —— ★★★ 真机中文（GBK 字节）
 *   · `vanilla`    —— 原版：`/say` 与玩家聊天走同一前缀
 *   · `paper`      —— Paper 的线程名不同，但 `]: ` 之后那段形状一致
 *   · `noise`      —— 噪音不许被当成聊天（含 `[Rcon]` 自话、成就、死亡）
 *   · `partial-line` —— 服务端正在写的一行（**不许**当成完整事件）
 */

/** 一条日志行的时间戳（固定，便于断言）。 */
const T = (n) => `[11:42:${String(n).padStart(2, '0')}]`

/** Forge / 原版 / Paper 共同的形状：`[时间] [线程/级别] [记录器]: ` —— 逐字取自真机。 */
const prefix = (t, thread = 'Server thread') => `${t} [${thread}/INFO] [minecraft/MinecraftServer]: `

/** Fabric/NeoForge 的圆括号记录器形状。 */
const prefixParen = (t, thread = 'Server thread') => `${t} [${thread}/INFO] (MinecraftServer): `

/**
 * 只为本夹具需要的那几个字做 GBK 编码（查表）。
 *
 * ★★★ 这些字节不是手写的，而是**用 Node 自带的 GBK 解码器反查出来的**
 *   （暴力枚举两个字节、看解出来是不是那个字）。手写必错——我第一版凭印象把
 *   「鱼」写成 `d3 e6`（那是「渔」），症状是中文玩家名解析成「小鲸渔」。
 *   现在还有一条**往返断言**兜着（编码再解码必须回到原文），表写错会当场红。
 * ★ 为什么不用第三方编码库：项目纪律是运行期零 npm 依赖，夹具也不该为此引依赖。
 */
const GBK_TABLE = {
  夹: [0xbc, 0xd0],
  具: [0xbe, 0xdf],
  测: [0xb2, 0xe2],
  试: [0xca, 0xd4],
  消: [0xcf, 0xfb],
  息: [0xcf, 0xa2],
  你: [0xc4, 0xe3],
  好: [0xba, 0xc3],
  小: [0xd0, 0xa1],
  鲸: [0xbe, 0xa8],
  鱼: [0xd3, 0xe3],
  在: [0xd4, 0xda],
  吗: [0xc2, 0xf0],
  我: [0xce, 0xd2],
  来: [0xc0, 0xb4],
  了: [0xc1, 0xcb],
  一: [0xd2, 0xbb],
  '，': [0xa3, 0xac],
  下: [0xcf, 0xc2],
  '。': [0xa1, 0xa3],
  这: [0xd5, 0xe2],
  种: [0xd6, 0xd6],
  文: [0xce, 0xc4],
  本: [0xb1, 0xbe],
  不: [0xb2, 0xbb],
  该: [0xb8, 0xc3],
  被: [0xb1, 0xbb],
  当: [0xb5, 0xb1],
  成: [0xb3, 0xc9],
  聊: [0xc1, 0xc4],
  天: [0xcc, 0xec],
  行: [0xd0, 0xd0],
  的: [0xb5, 0xc4],
  部: [0xb2, 0xbf],
  分: [0xb7, 0xd6],
}

/** 把中文字符串按 GBK 编成 Buffer（只支持表里那些字，够夹具用）。 */
export function gbkBytes(s) {
  const out = []
  for (const ch of String(s)) {
    const code = ch.codePointAt(0)
    if (code < 0x80) {
      out.push(code)
      continue
    }
    const pair = GBK_TABLE[ch]
    if (!pair) throw new Error(`夹具的 GBK 表里没有「${ch}」—— 请补进 GBK_TABLE`)
    out.push(pair[0], pair[1])
  }
  return Buffer.from(out)
}

/**
 * 拼一行：ASCII 前缀 + ASCII 片段 + GBK 中文片段 + CRLF。
 * ★ 中文只能经这个函数的 `cjk` 参数进来（`ascii` 那段必须是纯 ASCII）。
 */
function line(prefixAscii, ascii = '', cjk = '') {
  const parts = [Buffer.from(prefixAscii + ascii, 'latin1')]
  if (cjk) parts.push(gbkBytes(cjk))
  parts.push(Buffer.from('\r\n', 'latin1'))
  return Buffer.concat(parts)
}

/** 只拼 ASCII 的一行（方便）。 */
const asciiLine = (prefixAscii, body) => line(prefixAscii, body)

/**
 * 拼一行聊天：**名字与正文都可以是中文**（各走 GBK）。
 * ★ 为什么单独一个函数：第一版把名字写进 `ascii` 参数里，于是中文名被 `latin1`
 *   截成低 8 位 —— 夹具自己就坏了，而"坏字节"还顺手把编码回退掩盖掉了。
 */
function chatLine(prefixAscii, nameAscii, nameCjk, textAscii, textCjk) {
  const parts = [Buffer.from(`${prefixAscii}<`, 'latin1')]
  if (nameAscii) parts.push(Buffer.from(nameAscii, 'latin1'))
  if (nameCjk) parts.push(gbkBytes(nameCjk))
  parts.push(Buffer.from(`> ${textAscii}`, 'latin1'))
  if (textCjk) parts.push(gbkBytes(textCjk))
  parts.push(Buffer.from('\r\n', 'latin1'))
  return Buffer.concat(parts)
}

/**
 * 各"方言"的夹具。
 * `expect` 是**我们期望解析出来的东西** —— 写夹具时就把期望写死，
 * 免得以后"照着实现改断言"（那是让测试永远绿的标准做法）。
 */
export const DIALECTS = [
  {
    id: 'forge',
    why: 'Forge 1.20.1 真机逐字（我们在跑的这台）',
    lines: [
      asciiLine(prefix(T(1)), 'Steve joined the game'),
      asciiLine(prefix(T(2)), '<Steve> hello everyone'),
      asciiLine(prefix(T(3)), 'Alex joined the game'),
      asciiLine(prefix(T(4)), '<Alex> hi Steve'),
      asciiLine(prefix(T(5)), 'Steve left the game'),
    ],
    expect: [
      { kind: 'join', name: 'Steve' },
      { kind: 'chat', name: 'Steve', text: 'hello everyone' },
      { kind: 'join', name: 'Alex' },
      { kind: 'chat', name: 'Alex', text: 'hi Steve' },
      { kind: 'leave', name: 'Steve' },
    ],
  },
  {
    id: 'forge-notsecure',
    why: '1.19+ 有"未签名聊天"时会给聊天行加 [Not Secure] 前缀 —— 必须先剥掉',
    lines: [chatLine(prefix(T(10)) + '[Not Secure] ', 'Steve', '', '', '测试一下')],
    expect: [{ kind: 'chat', name: 'Steve', text: '测试一下' }],
  },
  {
    id: 'forge-cjk-gbk',
    why: '★★★ 真机的中文是 **GBK 字节**（这条夹具是整件事的核心）',
    lines: [chatLine(prefix(T(11)), 'Steve', '', '', '你好，我在吗')],
    expect: [{ kind: 'chat', name: 'Steve', text: '你好，我在吗' }],
  },
  {
    id: 'cjk-name',
    why: '★★ 中文玩家名（GBK 名）也要能解析出来 —— 名字与正文都要正确',
    lines: [chatLine(prefix(T(12)), '', '小鲸鱼', '', '我在')],
    expect: [{ kind: 'chat', name: '小鲸鱼', text: '我在' }],
  },
  {
    id: 'vanilla',
    why: '原版：`/say` 与玩家聊天走同一个前缀，形状与 Forge 一致（交叉验证）',
    lines: [
      asciiLine(prefix(T(13)), '<Steve> vanilla style'),
      asciiLine(prefix(T(14)), 'Notch joined the game'),
      asciiLine(prefix(T(15)), 'Notch lost connection: Disconnected'),
    ],
    expect: [
      { kind: 'chat', name: 'Steve', text: 'vanilla style' },
      { kind: 'join', name: 'Notch' },
      { kind: 'leave', name: 'Notch' },
    ],
  },
  {
    id: 'paper',
    why: 'Paper 把聊天归到自己的线程名下（前缀不同，"<名> 文本"那段不变）',
    lines: [asciiLine(prefix(T(16), 'Async Chat Thread - #0'), '<Steve> paper style'), asciiLine(prefix(T(17)), 'Steve joined the game')],
    expect: [
      { kind: 'chat', name: 'Steve', text: 'paper style' },
      { kind: 'join', name: 'Steve' },
    ],
  },
  {
    id: 'fabric-paren',
    why: 'Fabric/NeoForge 的记录器是圆括号形状 —— 前缀剥离要认它',
    lines: [asciiLine(prefixParen(T(18)), '<Steve> fabric style')],
    expect: [{ kind: 'chat', name: 'Steve', text: 'fabric style' }],
  },
  {
    id: 'uuid-of-player',
    why: '★★★ 「名 → UUID」的真机形状（P3 绑定的关键来源：玩家一登录就写，不用他说话、也不用他还在线）',
    lines: [
      asciiLine('[11:56:16] [User Authenticator #1/INFO] [minecraft/ServerLoginPacketListenerImpl]: ', 'UUID of player YoCerin is 00000000-0000-4000-8000-000000000001'),
      asciiLine(prefix(T(17)), 'YoCerin joined the game'),
    ],
    expect: [
      { kind: 'uuid', name: 'YoCerin', uuid: '00000000-0000-4000-8000-000000000001' },
      { kind: 'join', name: 'YoCerin' },
    ],
  },
  {
    id: 'noise',
    why: '★★ 噪音不许被当成聊天：RCON 自话、日志、命令回显、成就、死亡、空行',
    lines: [
      asciiLine(prefix(T(20)), '[Not Secure] [Rcon] our own say output'),
      asciiLine(prefix(T(21)), 'Saving players'),
      asciiLine(prefix(T(22)), 'ThreadedAnvilChunkStorage: All dimensions are saved'),
      asciiLine(prefix(T(23)), 'Loaded 7 recipes'),
      asciiLine(prefix(T(24)), ''),
      asciiLine(prefix(T(25)), 'Steve has made the advancement [Stone Age]'),
      asciiLine(prefix(T(26)), 'Steve was slain by Zombie'),
    ],
    expect: [
      { kind: null },
      { kind: null },
      { kind: null },
      { kind: null },
      { kind: null },
      { kind: null, name: 'Steve', online: true },
      { kind: null, name: 'Steve', online: true },
    ],
  },
  {
    id: 'chat-with-angle-and-chinese',
    why: '★ 正文里含 `<` 与中文时要**逐字保留**（第一版"取最后一个 `]: `"会切成半句）',
    lines: [chatLine(prefix(T(27)), 'Steve', '', 'a < b ', '这种文本不该被当成聊天行的一部分')],
    expect: [{ kind: 'chat', name: 'Steve', text: 'a < b 这种文本不该被当成聊天行的一部分' }],
  },
  {
    // ★ 名字叫 `-last` 是刻意的：半行只在**文件末尾**才算"没写完"。
    //   中间出现"无行尾"是不可能的（日志是追加写的），所以这条边界就该这么造。
    // ★★ `byteMode` 告诉测试：这条方言要**走读文件那一层**（`readConsoleEvents`），
    //    因为"只吐完整行"这条边界在**游标/切行**那里，用逐行喂单行是测错了地方。
    id: 'partial-line-last',
    byteMode: 'readConsoleEvents',
    why: '★ 服务端正在写的一行（在文件末尾、没有行尾）⇒ **不能当成一条完整事件**',
    lines: [
      asciiLine(prefix(T(30)), '<Steve> complete line'),
      // 没有 CRLF 的最后一行
      Buffer.from(prefix(T(31)) + '<Steve> this line is not fini', 'latin1'),
    ],
    expect: [{ kind: 'chat', name: 'Steve', text: 'complete line' }],
    expectPending: '<Steve> this line is not fini',
  },
]

/** 供测试直接断言"我们的 GBK 编码与真机一致"。 */
export const REAL_MACHINE_SAY_BYTES = 'bcd0bedf2db2e2cad4cffbcfa2'
export const REAL_MACHINE_SAY_TEXT = '夹具-测试消息'
